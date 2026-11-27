/**
 * CollabHub v2.2 — Living Shared Collaboration Rooms (`collab_rooms`, `room_claims`, `room_log`)
 *
 * Dual-layer safety engine:
 * 1. Atomic SQLite (`BEGIN IMMEDIATE`) lease table (`room_claims`) + append-only `room_log`
 *    with automatic TTL expiration & overlap detection (`CLAIM_CONFLICT`).
 * 2. Human- and agent-readable workspace synchronization: atomically re-renders `CLAIMS.md`
 *    (tmp+rename inside realpath jail) and appends `ROOM-LOG.md` so any CLI/Desktop AI or
 *    human sees the exact live ownership ledger in the folder itself.
 * 3. Safe `inbox/<agent>/` staged promotion (`promoteInboxFile`) checking secret-scan,
 *    path-jail, and active lease conflicts before copying into shared tree.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { WORKSPACE_ROOT } from './config.mjs';
import { logEvent } from './db.mjs';
import { discoverLocalAgents } from './discovery.mjs';
import { writeMemoryNote } from './memory.mjs';
import { registerAgent } from './registry.mjs';
import { bufferHasInlineSecret } from './skills-hub.mjs';

const ROOM_NAME_RE = /^[a-z0-9][a-z0-9._-]{1,48}$/i;
const SAFE_AGENT_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/i;

function assertWithinRoot(targetPath, rootDir) {
  const rel = path.relative(path.resolve(rootDir), path.resolve(targetPath));
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Path must stay strictly inside allowed root (${rootDir})`);
  }
}

function normalizeClaimPath(raw) {
  let s = String(raw || '').trim().replaceAll('\\', '/');
  s = s.replace(/^\.\//, '').replace(/\/+$/, '');
  if (!s || s.includes('\0') || s.startsWith('/') || /^[a-zA-Z]:/.test(s) || s.split('/').includes('..')) {
    throw new Error(`Invalid room claim path "${raw}"`);
  }
  return s;
}

function claimsOverlap(aRaw, bRaw) {
  const a = normalizeClaimPath(aRaw).replace(/\/\*+$/, '');
  const b = normalizeClaimPath(bRaw).replace(/\/\*+$/, '');
  if (!a || !b) return true;
  if (a === '*' || b === '*') return true;
  if (a === b) return true;
  return a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function safeRoomRealDir(roomDir) {
  if (!roomDir || !fs.existsSync(roomDir)) return null;
  const lst = fs.lstatSync(roomDir);
  if (lst.isSymbolicLink() || !lst.isDirectory()) return null;
  return fs.realpathSync(roomDir);
}

function expireStaleClaimsTx(db, roomId = null, now = new Date().toISOString()) {
  if (roomId) {
    return db.prepare(`
      UPDATE room_claims
      SET status = 'expired', updated_at = ?
      WHERE room_id = ? AND status = 'active' AND lease_expires_at <= ?
    `).run(now, roomId, now).changes || 0;
  }
  return db.prepare(`
    UPDATE room_claims
    SET status = 'expired', updated_at = ?
    WHERE status = 'active' AND lease_expires_at <= ?
  `).run(now, now).changes || 0;
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
    '1. **Claim Before Write**: Acquire an active lease (`collab_room claim`) recorded in both SQLite and `CLAIMS.md` before editing shared files.',
    '2. **Append-Only Decisions**: Record decisions, blockers, and handoffs via `collab_room log` -> `ROOM-LOG.md`.',
    '3. **Staged Deliverables (`inbox/<agent>/`) & Worktrees**: Write isolated drafts in `inbox/<agent>/` and promote safely (`collab_room promote`), or use `collab_worktree_create` + `collab_merge_queue`.',
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

function renderClaimsMarkdown(db, room) {
  const claims = db.prepare(`
    SELECT * FROM room_claims
    WHERE room_id = ?
    ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'expired' THEN 1 ELSE 2 END, updated_at DESC
    LIMIT 60
  `).all(room.room_id);
  const rows = claims.length > 0
    ? claims.map((c) => `| \`${c.path_glob.replaceAll('|', '\\|')}\` | \`${c.owner_agent}\` | ${c.lease_expires_at} | ${c.status} | ${(c.notes || '').replace(/[\r\n|]+/g, ' ').slice(0, 80)} |`)
    : [`| \`ROOM-LOG.md\` | \`collab-hub\` | — | append-only | No active exclusive path claims |`];
  return [
    `# Active File & Zone Claims — ${room.name}`,
    '',
    '> Synced automatically from CollabHub SQLite `room_claims`. Expired leases are reclaimed automatically.',
    '',
    '| Path / Zone | Owner Agent | Lease Expires (ISO) | Status | Notes |',
    '|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

function syncClaimsMarkdownFile(db, room) {
  const realDir = safeRoomRealDir(room.room_dir);
  if (!realDir) return false;
  const target = path.join(realDir, 'CLAIMS.md');
  if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) {
    throw new Error('Security rule: CLAIMS.md must not be a symlink');
  }
  const content = renderClaimsMarkdown(db, room);
  const tmp = path.join(realDir, `.CLAIMS.md.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, target);
  return true;
}

function buildAgentsPointerMarkdown({ name }) {
  return [
    `# Shared Collaboration Room Rules (${name})`,
    '',
    '1. Read `COLLAB-ROOM.md` for goals and agent ownership zones.',
    '2. Acquire/check `CLAIMS.md` (`collab_room claim`) before editing any shared file.',
    '3. Stage drafts in `inbox/<agent>/` and promote via `collab_room promote`.',
    '4. Append completed handoffs and decisions via `collab_room log` (`ROOM-LOG.md`).',
    '',
  ].join('\n');
}

function buildClaudePointerMarkdown() {
  return '@AGENTS.md\n\nBefore editing shared files, review `COLLAB-ROOM.md`, `CLAIMS.md`, and `ROOM-LOG.md`.\n';
}

function buildInitialRoomLogMarkdown({ name, goal, createdAt }) {
  return [
    `# Room Activity Log (Append-Only) — ${name}`,
    '',
    `- \`${createdAt}\` [collab-hub] (init) **Room Initialized**: ${goal || 'Multi-agent collaborative engineering workspace'}`,
    '',
  ].join('\n');
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

function resolveRoomRow(db, roomIdOrName) {
  const key = String(roomIdOrName || '').trim();
  if (!key) throw new Error('room_id or room name is required');
  const row = db.prepare('SELECT * FROM collab_rooms WHERE room_id = ? OR name = ?').get(key, key);
  if (!row) throw new Error(`Collab room not found: ${key}`);
  return row;
}

/**
 * Create (or preview) a shared multi-agent collaboration room folder, register it in SQLite
 * `collab_rooms`, initialize dual-layer `CLAIMS.md`/`ROOM-LOG.md`/`inbox/`, and optionally
 * register CLI agents & launch discovered apps.
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
  const roomId = `room_${cleanName.toLowerCase().replace(/[^a-z0-9._-]+/g, '-')}`;
  const charter = buildCharterMarkdown({ name: cleanName, goal, roomDir: realRoomDir, agents, createdAt });
  const fileContents = new Map([
    ['COLLAB-ROOM.md', charter],
    ['AGENTS.md', buildAgentsPointerMarkdown({ name: cleanName })],
    ['CLAUDE.md', buildClaudePointerMarkdown()],
    ['CLAIMS.md', renderClaimsMarkdown(db, { room_id: roomId, name: cleanName })],
    ['ROOM-LOG.md', buildInitialRoomLogMarkdown({ name: cleanName, goal, createdAt })],
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

  const inboxDir = path.join(realRoomDir, 'inbox');
  fs.mkdirSync(inboxDir, { recursive: true });
  try { fs.writeFileSync(path.join(inboxDir, '.gitkeep'), '', { flag: 'wx' }); } catch {}

  let gitInitialized = false;
  if (createGitRepo && !fs.existsSync(path.join(realRoomDir, '.git'))) {
    try {
      execFileSync('git', ['init', '-b', 'main'], { cwd: realRoomDir, encoding: 'utf8', windowsHide: true });
      gitInitialized = true;
    } catch { /* git optional */ }
  }

  // Register room + initial log entry inside SQLite
  db.prepare(`
    INSERT INTO collab_rooms (room_id, name, room_dir, goal, agents_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      room_dir = excluded.room_dir,
      goal = CASE WHEN excluded.goal != '' THEN excluded.goal ELSE collab_rooms.goal END,
      agents_json = excluded.agents_json,
      updated_at = excluded.updated_at
  `).run(roomId, cleanName, realRoomDir, String(goal || ''), JSON.stringify(agents), createdAt, createdAt);
  db.prepare(`
    INSERT INTO room_log (room_id, actor, kind, message, created_at)
    VALUES (?, 'collab-hub', 'init', ?, ?)
  `).run(roomId, `Room initialized: ${goal || cleanName}`, createdAt);

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
      room_id: roomId,
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
    room_id: roomId,
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

export function listCollabRooms(db) {
  try {
    expireStaleClaimsTx(db);
    const rooms = db.prepare('SELECT * FROM collab_rooms ORDER BY updated_at DESC').all();
    return rooms.map((r) => {
      let agents = [];
      try { agents = JSON.parse(r.agents_json || '[]'); } catch { agents = []; }
      const activeClaims = Number(db.prepare("SELECT COUNT(*) AS c FROM room_claims WHERE room_id = ? AND status = 'active'").get(r.room_id)?.c || 0);
      const logCount = Number(db.prepare('SELECT COUNT(*) AS c FROM room_log WHERE room_id = ?').get(r.room_id)?.c || 0);
      return {
        room_id: r.room_id,
        name: r.name,
        room_dir: r.room_dir,
        goal: r.goal || '',
        agents,
        active_claims: activeClaims,
        log_entries: logCount,
        dir_exists: fs.existsSync(r.room_dir),
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
    });
  } catch {
    return [];
  }
}

export function getRoomStatus(db, roomIdOrName) {
  const room = resolveRoomRow(db, roomIdOrName);
  const expiredCount = expireStaleClaimsTx(db, room.room_id);
  if (expiredCount > 0) syncClaimsMarkdownFile(db, room);
  const claims = db.prepare('SELECT * FROM room_claims WHERE room_id = ? ORDER BY updated_at DESC LIMIT 60').all(room.room_id);
  const logs = db.prepare('SELECT * FROM room_log WHERE room_id = ? ORDER BY id DESC LIMIT 30').all(room.room_id);
  const inboxFiles = [];
  const realDir = safeRoomRealDir(room.room_dir);
  if (realDir) {
    const inboxRoot = path.join(realDir, 'inbox');
    if (fs.existsSync(inboxRoot)) {
      for (const agentEnt of fs.readdirSync(inboxRoot, { withFileTypes: true })) {
        if (!agentEnt.isDirectory() || agentEnt.isSymbolicLink()) continue;
        const aDir = path.join(inboxRoot, agentEnt.name);
        for (const fEnt of fs.readdirSync(aDir, { withFileTypes: true })) {
          if (fEnt.isFile() && !fEnt.isSymbolicLink()) {
            inboxFiles.push({ agent: agentEnt.name, rel_path: fEnt.name });
          }
        }
      }
    }
  }
  let agents = [];
  try { agents = JSON.parse(room.agents_json || '[]'); } catch { agents = []; }
  return {
    room_id: room.room_id,
    name: room.name,
    room_dir: room.room_dir,
    goal: room.goal || '',
    agents,
    claims,
    active_claims: claims.filter((c) => c.status === 'active'),
    logs,
    inbox_files: inboxFiles,
    expired_reclaimed: expiredCount,
  };
}

export function appendRoomLog(db, { roomId, actor = 'collab-hub', kind = 'note', message }) {
  const room = resolveRoomRow(db, roomId);
  const msg = String(message || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 600);
  if (!msg) throw new Error('Room log message is required');
  const safeActor = String(actor || 'collab-hub').replace(/[^a-z0-9._-]/gi, '').slice(0, 32) || 'collab-hub';
  const safeKind = String(kind || 'note').replace(/[^a-z0-9._-]/gi, '').slice(0, 24) || 'note';
  const now = new Date().toISOString();

  const ins = db.prepare('INSERT INTO room_log (room_id, actor, kind, message, created_at) VALUES (?, ?, ?, ?, ?)').run(
    room.room_id, safeActor, safeKind, msg, now,
  );
  db.prepare('UPDATE collab_rooms SET updated_at = ? WHERE room_id = ?').run(now, room.room_id);

  const realDir = safeRoomRealDir(room.room_dir);
  if (realDir) {
    const logPath = path.join(realDir, 'ROOM-LOG.md');
    if (!fs.existsSync(logPath) || !fs.lstatSync(logPath).isSymbolicLink()) {
      fs.appendFileSync(logPath, `- \`${now}\` [${safeActor}] (${safeKind}) ${msg}\n`, 'utf8');
    }
  }
  logEvent(db, { eventType: 'room.logged', actor: safeActor, payload: { room_id: room.room_id, kind: safeKind, message: msg.slice(0, 120) } });
  return { id: Number(ins.lastInsertRowid), room_id: room.room_id, actor: safeActor, kind: safeKind, message: msg, created_at: now };
}

export function claimRoomPath(db, {
  roomId, pathGlob, ownerAgent, ttlMinutes = 30, notes = '',
} = {}) {
  const room = resolveRoomRow(db, roomId);
  const cleanPath = normalizeClaimPath(pathGlob);
  const cleanOwner = String(ownerAgent || '').trim();
  if (!SAFE_AGENT_RE.test(cleanOwner)) throw new Error(`Invalid owner_agent "${ownerAgent}"`);
  const ttl = Math.max(1, Math.min(24 * 60, Number(ttlMinutes) || 30));
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttl * 60000).toISOString();
  let claimId = null;

  db.exec('BEGIN IMMEDIATE;');
  try {
    expireStaleClaimsTx(db, room.room_id, now);
    const actives = db.prepare("SELECT * FROM room_claims WHERE room_id = ? AND status = 'active'").all(room.room_id);
    for (const c of actives) {
      if (c.owner_agent !== cleanOwner && claimsOverlap(c.path_glob, cleanPath)) {
        throw new Error(`CLAIM_CONFLICT: "${cleanPath}" overlaps active lease on "${c.path_glob}" held by "${c.owner_agent}" until ${c.lease_expires_at}.`);
      }
    }
    const mine = actives.find((c) => c.owner_agent === cleanOwner && normalizeClaimPath(c.path_glob) === cleanPath);
    if (mine) {
      claimId = mine.claim_id;
      db.prepare('UPDATE room_claims SET lease_expires_at = ?, notes = ?, updated_at = ? WHERE claim_id = ?')
        .run(expiresAt, String(notes || mine.notes || '').slice(0, 200), now, claimId);
    } else {
      claimId = `clm_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
      db.prepare(`
        INSERT INTO room_claims (claim_id, room_id, path_glob, owner_agent, lease_expires_at, status, notes, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
      `).run(claimId, room.room_id, cleanPath, cleanOwner, expiresAt, String(notes || '').slice(0, 200), now, now);
    }
    db.prepare('UPDATE collab_rooms SET updated_at = ? WHERE room_id = ?').run(now, room.room_id);
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }

  syncClaimsMarkdownFile(db, room);
  appendRoomLog(db, { roomId: room.room_id, actor: cleanOwner, kind: 'claim', message: `Claimed \`${cleanPath}\` for ${ttl}m (until ${expiresAt})` });
  return db.prepare('SELECT * FROM room_claims WHERE claim_id = ?').get(claimId);
}

export function renewRoomClaim(db, { claimId, ownerAgent, ttlMinutes = 30 } = {}) {
  const cleanOwner = String(ownerAgent || '').trim();
  if (!SAFE_AGENT_RE.test(cleanOwner)) {
    throw new Error('owner_agent is required to renew a room claim');
  }
  const now = new Date().toISOString();
  const row = db.prepare('SELECT * FROM room_claims WHERE claim_id = ?').get(String(claimId || ''));
  if (!row) throw new Error(`Claim not found: ${claimId}`);
  if (row.status !== 'active') throw new Error(`Cannot renew non-active claim (${row.status})`);
  if (row.owner_agent !== cleanOwner) throw new Error(`CLAIM_CONFLICT: Only owner "${row.owner_agent}" may renew claim ${claimId}`);
  const room = resolveRoomRow(db, row.room_id);
  const ttl = Math.max(1, Math.min(24 * 60, Number(ttlMinutes) || 30));
  const expiresAt = new Date(Date.now() + ttl * 60000).toISOString();
  db.prepare('UPDATE room_claims SET lease_expires_at = ?, updated_at = ? WHERE claim_id = ?').run(expiresAt, now, row.claim_id);
  syncClaimsMarkdownFile(db, room);
  return db.prepare('SELECT * FROM room_claims WHERE claim_id = ?').get(row.claim_id);
}

export function releaseRoomClaim(db, { claimId = null, roomId = null, pathGlob = null, ownerAgent } = {}) {
  const cleanOwner = String(ownerAgent || '').trim();
  if (!SAFE_AGENT_RE.test(cleanOwner)) {
    throw new Error('owner_agent is required to release a room claim');
  }
  const now = new Date().toISOString();
  let row = null;
  if (claimId) {
    row = db.prepare('SELECT * FROM room_claims WHERE claim_id = ?').get(String(claimId));
  } else if (roomId && pathGlob) {
    const room = resolveRoomRow(db, roomId);
    const cleanPath = normalizeClaimPath(pathGlob);
    row = db.prepare("SELECT * FROM room_claims WHERE room_id = ? AND path_glob = ? AND status = 'active'").get(room.room_id, cleanPath);
  }
  if (!row) throw new Error('Matching active room claim not found');
  if (row.owner_agent !== cleanOwner) {
    throw new Error(`CLAIM_CONFLICT: claim ${row.claim_id} is owned by "${row.owner_agent}", not "${cleanOwner}"`);
  }
  const room = resolveRoomRow(db, row.room_id);
  db.prepare("UPDATE room_claims SET status = 'released', updated_at = ? WHERE claim_id = ?").run(now, row.claim_id);
  syncClaimsMarkdownFile(db, room);
  appendRoomLog(db, { roomId: room.room_id, actor: row.owner_agent, kind: 'release', message: `Released \`${row.path_glob}\`` });
  return db.prepare('SELECT * FROM room_claims WHERE claim_id = ?').get(row.claim_id);
}

export function reconcileStaleClaimsInAllRooms(db) {
  const now = new Date().toISOString();
  const expired = expireStaleClaimsTx(db, null, now);
  let roomsUpdated = 0;
  if (expired > 0) {
    for (const room of db.prepare('SELECT * FROM collab_rooms').all()) {
      try { if (syncClaimsMarkdownFile(db, room)) roomsUpdated += 1; } catch {}
    }
  }
  return { expired, rooms_updated: roomsUpdated, checked_at: now };
}

function assertNoSymlinkSegments(relPath, baseRealDir) {
  const parts = String(relPath || '').split('/').filter(Boolean);
  let cur = baseRealDir;
  for (const seg of parts) {
    cur = path.join(cur, seg);
    if (fs.existsSync(cur)) {
      if (fs.lstatSync(cur).isSymbolicLink()) {
        throw new Error(`Security rule: symlink segment forbidden inside room (${seg})`);
      }
      assertWithinRoot(fs.realpathSync(cur), baseRealDir);
    }
  }
  return cur;
}

/**
 * Safely promote a staged file from `inbox/<agent>/<relPath>` into the shared room root.
 * Checks canonical path jails & intermediate symlink segments, scans bytes for inline secrets,
 * holds `BEGIN IMMEDIATE` across active lease check + atomic write/rename, and requires `confirmed === true`.
 */
export function promoteInboxFile(db, {
  roomId, agent, relPath, destRelPath = null, confirmed = false,
} = {}) {
  const room = resolveRoomRow(db, roomId);
  const cleanAgent = String(agent || '').trim();
  if (!SAFE_AGENT_RE.test(cleanAgent)) throw new Error(`Invalid agent "${agent}"`);
  const realDir = safeRoomRealDir(room.room_dir);
  if (!realDir) throw new Error(`Room directory missing on disk: ${room.room_dir}`);

  const srcRel = normalizeClaimPath(relPath);
  const dstRel = normalizeClaimPath(destRelPath || srcRel);
  const inboxRoot = path.join(realDir, 'inbox');
  if (!fs.existsSync(inboxRoot) || fs.lstatSync(inboxRoot).isSymbolicLink()) {
    throw new Error('Security rule: room inbox root missing or symlinked');
  }
  const inboxAgentRoot = path.join(inboxRoot, cleanAgent);
  if (!fs.existsSync(inboxAgentRoot) || fs.lstatSync(inboxAgentRoot).isSymbolicLink()) {
    throw new Error(`Staged agent inbox directory missing or symlinked: inbox/${cleanAgent}`);
  }
  const realInboxAgentRoot = fs.realpathSync(inboxAgentRoot);
  assertWithinRoot(realInboxAgentRoot, realDir);

  const srcAbs = assertNoSymlinkSegments(srcRel, realInboxAgentRoot);
  assertWithinRoot(srcAbs, realInboxAgentRoot);
  if (!fs.existsSync(srcAbs)) throw new Error(`Staged inbox file not found: inbox/${cleanAgent}/${srcRel}`);
  const srcLstat = fs.lstatSync(srcAbs);
  if (srcLstat.isSymbolicLink() || !srcLstat.isFile()) {
    throw new Error('Security rule: inbox promote source must be a regular non-symlink file');
  }

  const buf = fs.readFileSync(srcAbs);
  if (bufferHasInlineSecret(buf)) {
    throw new Error(`Security rule: inline secret detected in inbox/${cleanAgent}/${srcRel}; refusing promotion.`);
  }

  if (dstRel === '.git' || dstRel.startsWith('.git/') || dstRel === 'inbox' || dstRel.startsWith('inbox/')) {
    throw new Error(`Security rule: disallowed promote destination "${dstRel}"`);
  }
  const dstAbs = assertNoSymlinkSegments(dstRel, realDir);
  assertWithinRoot(dstAbs, realDir);
  if (fs.existsSync(dstAbs) && fs.lstatSync(dstAbs).isSymbolicLink()) {
    throw new Error(`Security rule: destination "${dstRel}" is a symlink`);
  }

  if (confirmed !== true) {
    expireStaleClaimsTx(db, room.room_id);
    const actives = db.prepare("SELECT * FROM room_claims WHERE room_id = ? AND status = 'active'").all(room.room_id);
    for (const c of actives) {
      if (c.owner_agent !== cleanAgent && claimsOverlap(c.path_glob, dstRel)) {
        throw new Error(`CLAIM_CONFLICT: "${dstRel}" is claimed by "${c.owner_agent}" until ${c.lease_expires_at}.`);
      }
    }
    return {
      ok: true,
      dry_run: true,
      room_id: room.room_id,
      source: `inbox/${cleanAgent}/${srcRel}`,
      destination: dstRel,
      bytes: buf.length,
      destination_exists: fs.existsSync(dstAbs),
      hint: 'Pass confirmed=true to promote this staged file into the shared room directory.',
    };
  }

  db.exec('BEGIN IMMEDIATE;');
  let tmpDst = null;
  try {
    expireStaleClaimsTx(db, room.room_id);
    const actives = db.prepare("SELECT * FROM room_claims WHERE room_id = ? AND status = 'active'").all(room.room_id);
    for (const c of actives) {
      if (c.owner_agent !== cleanAgent && claimsOverlap(c.path_glob, dstRel)) {
        throw new Error(`CLAIM_CONFLICT: "${dstRel}" is claimed by "${c.owner_agent}" until ${c.lease_expires_at}.`);
      }
    }
    assertNoSymlinkSegments(dstRel, realDir);
    fs.mkdirSync(path.dirname(dstAbs), { recursive: true });
    assertWithinRoot(fs.realpathSync(path.dirname(dstAbs)), realDir);
    tmpDst = path.join(path.dirname(dstAbs), `.promote.tmp.${process.pid}.${Date.now()}`);
    fs.writeFileSync(tmpDst, buf);
    fs.renameSync(tmpDst, dstAbs);
    tmpDst = null;
    db.exec('COMMIT;');
  } catch (err) {
    if (tmpDst) { try { fs.unlinkSync(tmpDst); } catch {} }
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }

  appendRoomLog(db, {
    roomId: room.room_id,
    actor: cleanAgent,
    kind: 'promote',
    message: `Promoted \`inbox/${cleanAgent}/${srcRel}\` → \`${dstRel}\` (${buf.length} bytes)`,
  });

  return {
    ok: true,
    dry_run: false,
    room_id: room.room_id,
    source: `inbox/${cleanAgent}/${srcRel}`,
    destination: dstRel,
    bytes: buf.length,
  };
}
