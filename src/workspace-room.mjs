/**
 * CollabHub v2.1 — Shared Collaboration Workspace ("Collab Room") & Safe Auto-Launcher
 *
 * Creates a clean, Git-ready shared workspace folder with non-duplicating multi-agent
 * coordination files (`COLLAB-ROOM.md`, `AGENTS.md`, `CLAUDE.md` -> `@AGENTS.md`,
 * `CLAIMS.md` lease ledger, `ROOM-LOG.md` append-only feed, and `inbox/` staging dir)
 * so Antigravity, Codex, Claude, WSL DSH, and discovered CLI agents can collaborate
 * in one unified project folder without silent write collisions.
 *
 * Security invariants:
 * - Room name is strictly slug-validated; root & target directories are canonicalized via
 *   `fs.realpathSync` and symlinks/junctions are rejected.
 * - Never copies credentials, tokens, or bypasses native Desktop access controls.
 * - Auto-registering CLI agents and launching discovered Desktop apps default to dry-run
 *   preview unless `confirmed === true` (strict boolean).
 * - Launching uses `spawn(bin, args, { shell: false, detached: true })` (or `/usr/bin/open -a`
 *   on macOS for `.app` bundles), awaits `'spawn'` or `'error'` so async launch errors never crash.
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
  const members = agents.length ? agents : ['agy', 'codex', 'claude', 'dsh', 'muse'];
  const memberRows = members
    .map((m) => `| \`${m}\` | TBD | \`inbox/${m}/\` or isolated worktree | Ready |`)
    .join('\n');
  return [
    `# CollabHub Shared Room — ${name}`,
    '',
    `- **Created**: ${createdAt}`,
    `- **Workspace**: \`${roomDir}\``,
    `- **Goal**: ${goal || 'Multi-agent collaborative engineering workspace'}`,
    '',
    '## Shared-Room Safety Protocol (No Silent Collisions)',
    '',
    '1. **Claim Before Write**: Add your active lease row to `CLAIMS.md` with an ISO expiry before editing shared files; respect other agents\' active leases.',
    '2. **Append-Only Decisions**: Record major decisions, blockers, and handoffs in `ROOM-LOG.md` (append-only, never overwrite history).',
    '3. **Staged Deliverables (`inbox/<agent>/`) & Worktrees**: Write isolated drafts in `inbox/<agent>/` or use `collab_worktree_create` + `collab_merge_queue` before merging into shared files.',
    '4. **Cross-Host Cockpit**: Run `collab_cockpit` in AGY/Claude/Codex Desktop, or `node <collab-hub>/bin/collab-hub.mjs tui` in Codex CLI / Claude Code / WSL DSH.',
    '',
    '## Participants & Ownership Zones',
    '',
    '| Agent | Role | Owned Zone / Staging Dir | Status |',
    '|---|---|---|---|',
    memberRows,
    '',
  ].join('\n');
}

function buildClaimsMarkdown({ name, createdAt }) {
  return [
    `# Active File & Zone Claims — ${name}`,
    '',
    '> Acquire a claim with a short TTL before modifying shared files outside your `inbox/<agent>/` directory. Expired leases may be reclaimed.',
    '',
    '| Path / Zone | Owner Agent | Lease Expires (ISO) | Status | Notes |',
    '|---|---|---|---|---|',
    `| \`ROOM-LOG.md\` | \`collab-hub\` | ${createdAt} | append-only | Room bootstrap initialized |`,
    '',
  ].join('\n');
}

function buildRoomLogMarkdown({ name, goal, createdAt }) {
  return [
    `# Room Activity Log (Append-Only) — ${name}`,
    '',
    `- \`${createdAt}\` [collab-hub] **Room Initialized**: ${goal || 'Multi-agent collaborative engineering workspace'}`,
    '',
  ].join('\n');
}

function buildAgentsPointerMarkdown({ name }) {
  return [
    `# Shared Collaboration Room Rules (${name})`,
    '',
    '1. Read `COLLAB-ROOM.md` for goals and agent ownership zones.',
    '2. Check & update `CLAIMS.md` before editing any shared file.',
    '3. Append completed handoffs and decisions to `ROOM-LOG.md`.',
    '',
  ].join('\n');
}

function buildClaudePointerMarkdown() {
  return '@AGENTS.md\n\nBefore editing shared files, review `COLLAB-ROOM.md`, `CLAIMS.md`, and `ROOM-LOG.md`.\n';
}

function launchDetachedApp(executable, args, cwd) {
  return new Promise((resolve) => {
    let bin = executable;
    let finalArgs = args;
    if (process.platform === 'darwin' && executable.endsWith('.app')) {
      bin = '/usr/bin/open';
      finalArgs = ['-a', executable, ...args];
    }
    let settled = false;
    let child;
    const done = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      done({ launched: Boolean(child?.pid), pid: child?.pid || null });
    }, 1500);
    try {
      child = spawn(bin, finalArgs, {
        cwd,
        detached: true,
        stdio: 'ignore',
        shell: false,
        windowsHide: false,
      });
      child.once('error', (err) => {
        done({ launched: false, error: String(err.code || err.message || err) });
      });
      child.once('spawn', () => {
        try { child.unref(); } catch {}
        done({ launched: true, pid: child.pid || null });
      });
    } catch (err) {
      done({ launched: false, error: String(err.message || err) });
    }
  });
}

/**
 * Create (or preview) a shared multi-agent collaboration room folder, optionally initialize Git,
 * register discovered CLI agents, and safely launch discovered local Desktop apps / terminal pointed at it.
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
  const resolvedRoot = path.resolve(workspaceRoot);
  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(`Workspace root does not exist: ${resolvedRoot}`);
  }
  const rootAbs = fs.realpathSync(resolvedRoot);
  const roomDir = path.resolve(rootAbs, cleanName);
  assertWithinRoot(roomDir, rootAbs);

  // Guard against pre-existing symlink or junction escapes before creating or inspecting anything inside
  if (fs.existsSync(roomDir)) {
    const lst = fs.lstatSync(roomDir);
    if (lst.isSymbolicLink() || !lst.isDirectory()) {
      throw new Error('Security rule: room path must be a regular directory (symlinks/junctions are forbidden).');
    }
    assertWithinRoot(fs.realpathSync(roomDir), rootAbs);
  }

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
    if (!found) return { id, found: false, reason: 'Desktop app not detected on this host' };
    const args = typeof found.launch_args === 'function'
      ? found.launch_args(roomDir)
      : (id === 'windows-terminal' ? ['-d', roomDir] : (id === 'claude-desktop' ? [] : [roomDir]));
    return { id, name: found.name, found: true, executable: found.path, args };
  });

  const targetFiles = ['COLLAB-ROOM.md', 'AGENTS.md', 'CLAUDE.md', 'CLAIMS.md', 'ROOM-LOG.md'];
  const filesPlan = targetFiles.map((file) => ({
    file,
    action: fs.existsSync(path.join(roomDir, file)) ? 'skip_exists' : 'write',
  }));

  if (confirmed !== true) {
    return {
      ok: true,
      dry_run: true,
      room_name: cleanName,
      room_dir: roomDir,
      already_exists: fs.existsSync(roomDir),
      create_git_repo: Boolean(createGitRepo),
      files_plan: filesPlan,
      files_to_write: filesPlan.filter((f) => f.action === 'write').map((f) => f.file),
      cli_registration_plan: cliPlan,
      app_launch_plan: launchPlan,
      available_clis: [...cliById.keys()],
      available_apps: [...appById.keys()],
      hint: 'Pass confirmed=true to create the room directory, register selected CLIs, and launch selected apps.',
    };
  }

  fs.mkdirSync(roomDir, { recursive: true });
  const realRoomDir = fs.realpathSync(roomDir);
  assertWithinRoot(realRoomDir, rootAbs);

  const createdAt = new Date().toISOString();
  const charter = buildCharterMarkdown({ name: cleanName, goal, roomDir: realRoomDir, agents, createdAt });
  const fileContents = new Map([
    ['COLLAB-ROOM.md', charter],
    ['AGENTS.md', buildAgentsPointerMarkdown({ name: cleanName })],
    ['CLAUDE.md', buildClaudePointerMarkdown()],
    ['CLAIMS.md', buildClaimsMarkdown({ name: cleanName, createdAt })],
    ['ROOM-LOG.md', buildRoomLogMarkdown({ name: cleanName, goal, createdAt })],
  ]);

  const filesWritten = [];
  for (const [fname, body] of fileContents.entries()) {
    const target = path.join(realRoomDir, fname);
    try {
      fs.writeFileSync(target, body, { encoding: 'utf8', flag: 'wx' });
      filesWritten.push(fname);
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
    }
  }

  // Create staged per-agent inbox directory so agents avoid colliding on shared root files
  const inboxDir = path.join(realRoomDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  const gitkeep = path.join(inboxDir, '.gitkeep');
  try { fs.writeFileSync(gitkeep, '', { flag: 'wx' }); } catch {}

  let gitInitialized = false;
  if (createGitRepo && !fs.existsSync(path.join(realRoomDir, '.git'))) {
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: realRoomDir, encoding: 'utf8', windowsHide: true });
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
    const res = await launchDetachedApp(item.executable, item.args, realRoomDir);
    launchedApps.push({ id: item.id, ...res });
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
    payload: {
      room_name: cleanName,
      room_dir: realRoomDir,
      git_initialized: gitInitialized,
      registered_clis: registeredClis,
      launched_apps: launchedApps,
    },
  });

  return {
    ok: true,
    dry_run: false,
    room_name: cleanName,
    room_dir: realRoomDir,
    files_written: filesWritten,
    files_plan: filesPlan,
    git_initialized: gitInitialized,
    registered_clis: registeredClis,
    launched_apps: launchedApps,
    available_clis: [...cliById.keys()],
    available_apps: [...appById.keys()],
  };
}
