/**
 * CollabHub v2.0 — Shared Collaboration Workspace ("Collab Room") & Safe Auto-Launcher
 *
 * Creates a clean, Git-ready shared workspace folder with synchronized multi-agent
 * charter files (AGENTS.md, CLAUDE.md, COLLAB-ROOM.md) so Antigravity, Codex, Claude,
 * WSL DSH, and any discovered local CLI agents can collaborate in one unified project
 * folder without fighting over Desktop bridge permissions or overwriting each other.
 *
 * Security invariants:
 * - Room name is strictly slug-validated; target directory is path-jailed inside workspaceRoot.
 * - Never copies credentials, tokens, or bypasses native Desktop access controls.
 * - Auto-registering CLI agents and launching discovered Desktop apps default to dry-run
 *   preview unless `confirmed === true` (strict boolean) is explicitly passed.
 * - Launching uses `spawn(bin, args, { shell: false, detached: true })` strictly against
 *   executables returned by `discoverLocalAgents()` — never arbitrary shell strings.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { WORKSPACE_ROOT } from './config.mjs';
import { discoverLocalAgents } from './discovery.mjs';
import { writeMemoryNote } from './memory.mjs';
import { registerAgent } from './registry.mjs';
import { logEvent } from './db.mjs';

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/i;

function assertWithinRoot(targetPath, rootDir) {
  const rel = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Room directory must stay strictly inside workspace root (${rootDir})`);
  }
}

function buildCharterMarkdown({ name, goal, roomDir, agents, createdAt }) {
  const memberRows = (agents.length ? agents : ['agy', 'codex', 'claude', 'dsh', 'muse'])
    .map((m) => `| \`${m}\` | TBD | \`src/${m}/\` or isolated worktree | Ready |`)
    .join('\n');
  return [
    `# CollabHub Shared Room — ${name}`,
    '',
    `- **Created**: ${createdAt}`,
    `- **Workspace**: \`${roomDir}\``,
    `- **Goal**: ${goal || 'Multi-agent collaborative engineering workspace'}`,
    '',
    '## Coordination Protocol',
    '',
    '1. Use `collab_roster` / `collab_cockpit` to inspect live fleet telemetry.',
    '2. Isolate concurrent code edits via `collab_worktree_create` and merge via `collab_merge_queue`.',
    '3. Share durable decisions and review findings via `collab_memory_write` / `collab_memory_search`.',
    '4. Terminal Cockpit (Codex CLI / Claude Code / WSL DSH): `node <collab-hub>/bin/collab-hub.mjs tui`',
    '',
    '## Participants & File Ownership',
    '',
    '| Agent | Role | Owned Path / Worktree | Status |',
    '|---|---|---|---|',
    memberRows,
    '',
  ].join('\n');
}

/**
 * Create (or preview) a shared multi-agent collaboration room folder, optionally initialize Git,
 * register discovered CLI agents, and launch discovered local Desktop apps / terminal pointed at it.
 */
export async function createCollabRoom(db, {
  name,
  goal = '',
  agents = ['agy', 'codex', 'claude', 'dsh', 'muse'],
  createGitRepo = true,
  autoRegisterClis = [],
  launchApps = [],
  confirmed = false,
  workspaceRoot = WORKSPACE_ROOT,
  discoverDeps = {},
} = {}) {
  const cleanName = String(name || '').trim();
  if (!ROOM_NAME_RE.test(cleanName)) {
    throw new Error('Invalid room name: use 2-49 alphanumeric, dot, dash, or underscore characters');
  }
  const rootAbs = path.resolve(workspaceRoot);
  const roomDir = path.resolve(rootAbs, cleanName);
  assertWithinRoot(roomDir, rootAbs);

  const discovery = await discoverLocalAgents(db, discoverDeps);
  const cliById = new Map((discovery.cli_agents || []).filter((c) => c.found).map((c) => [c.id, c]));
  const appById = new Map((discovery.desktop_apps || []).filter((a) => a.found).map((a) => [a.id, a]));

  const requestedClis = Array.isArray(autoRegisterClis) ? autoRegisterClis.map(String) : [];
  const requestedApps = Array.isArray(launchApps) ? launchApps.map(String) : [];

  const cliPlan = requestedClis.map((id) => {
    const found = cliById.get(id);
    return found
      ? { id, found: true, already_registered: found.already_registered, path: found.path, registration: found.suggested_registration }
      : { id, found: false, reason: 'CLI not detected on this host' };
  });

  const launchPlan = requestedApps.map((id) => {
    const found = appById.get(id);
    return found
      ? { id, name: found.name, found: true, executable: found.path, args: id === 'windows-terminal' ? ['-d', roomDir] : (id === 'claude-desktop' ? [] : [roomDir]) }
      : { id, found: false, reason: 'Desktop app not detected on this host' };
  });

  if (confirmed !== true) {
    return {
      ok: true,
      dry_run: true,
      room_name: cleanName,
      room_dir: roomDir,
      already_exists: fs.existsSync(roomDir),
      create_git_repo: Boolean(createGitRepo),
      files_to_write: ['COLLAB-ROOM.md', 'AGENTS.md', 'CLAUDE.md'],
      cli_registration_plan: cliPlan,
      app_launch_plan: launchPlan,
      available_clis: [...cliById.keys()],
      available_apps: [...appById.keys()],
      hint: 'Pass confirmed=true to create the room directory, register selected CLIs, and launch selected apps.',
    };
  }

  fs.mkdirSync(roomDir, { recursive: true });
  const createdAt = new Date().toISOString();
  const charter = buildCharterMarkdown({ name: cleanName, goal, roomDir, agents, createdAt });
  const filesWritten = [];
  for (const fname of ['COLLAB-ROOM.md', 'AGENTS.md', 'CLAUDE.md']) {
    const target = path.join(roomDir, fname);
    if (!fs.existsSync(target)) {
      fs.writeFileSync(target, charter, 'utf8');
      filesWritten.push(fname);
    }
  }

  let gitInitialized = false;
  if (createGitRepo && !fs.existsSync(path.join(roomDir, '.git'))) {
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: roomDir, encoding: 'utf8', windowsHide: true });
      gitInitialized = true;
    } catch { /* git optional */ }
  }

  const registeredClis = [];
  for (const item of cliPlan) {
    if (!item.found || item.already_registered || !item.registration) continue;
    const reg = item.registration;
    registerAgent(db, {
      agentId: reg.agent_id,
      name: reg.name,
      driver: reg.driver,
      roles: reg.roles,
      config: reg.config,
    });
    registeredClis.push(reg.agent_id);
  }

  const launchedApps = [];
  for (const item of launchPlan) {
    if (!item.found || !item.executable) continue;
    try {
      const child = spawn(item.executable, item.args, {
        cwd: roomDir,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      });
      child.unref();
      launchedApps.push({ id: item.id, pid: child.pid || null, launched: true });
    } catch (err) {
      launchedApps.push({ id: item.id, launched: false, error: String(err.message || err) });
    }
  }

  writeMemoryNote(db, {
    project: cleanName,
    slug: 'collab-room-charter',
    title: `Shared Collab Room: ${cleanName}`,
    author: 'collab-hub',
    tags: ['room', 'workspace', ...agents.slice(0, 6)],
    content: charter,
  });
  logEvent(db, {
    eventType: 'room.created',
    actor: 'collab-hub',
    payload: { room_name: cleanName, room_dir: roomDir, git_initialized: gitInitialized, registered_clis: registeredClis, launched_apps: launchedApps },
  });

  return {
    ok: true,
    dry_run: false,
    room_name: cleanName,
    room_dir: roomDir,
    files_written: filesWritten,
    git_initialized: gitInitialized,
    registered_clis: registeredClis,
    launched_apps: launchedApps,
    available_clis: [...cliById.keys()],
    available_apps: [...appById.keys()],
  };
}
