import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { APP_ROOT, DB_PATH, INTEGRATIONS, WORKSPACE_ROOT, WORKTREE_DIR } from './config.mjs';
import { getMemberStatuses, logEvent } from './db.mjs';
import { probeMailHub } from './prober.mjs';
import { getCassStats, getToolkitStatus } from './toolkit.mjs';
import { listWorktrees } from './worktree.mjs';

const execFileAsync = promisify(execFile);

/**
 * List 1-level project subdirectories under WORKSPACE_ROOT (identifying Git repos) for UI/CLI convenience.
 */
export function listWorkspaceProjects(workspaceRoot = WORKSPACE_ROOT) {
  if (!fs.existsSync(workspaceRoot)) return [];
  const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  const projects = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.')) continue;
    const full = path.join(workspaceRoot, e.name);
    let isGit = false;
    try { isGit = fs.existsSync(path.join(full, '.git')); } catch {}
    projects.push({ name: e.name, path: full, is_git: isGit });
  }
  return projects.sort((a, b) => Number(b.is_git) - Number(a.is_git) || a.name.localeCompare(b.name));
}

/**
 * Hot SQLite backup via `VACUUM INTO` (safe while WAL writers are active) into D:\Apps\CollabHub\backups\.
 * Automatically prunes older hub-snapshot-*.db backups keeping the most recent `keepLast`.
 */
export function createHotBackup(db, { backupDir = path.join(APP_ROOT, 'backups'), keepLast = 10 } = {}) {
  fs.mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `hub-snapshot-${stamp}.db`;
  const target = path.join(backupDir, fileName);
  const escaped = target.replaceAll("'", "''");
  db.exec(`VACUUM INTO '${escaped}';`);
  const stat = fs.statSync(target);

  // Prune old snapshots beyond keepLast
  const snaps = fs.readdirSync(backupDir)
    .filter((f) => /^hub-snapshot-.+\.db$/.test(f))
    .sort()
    .reverse();
  const pruned = [];
  for (const old of snaps.slice(Math.max(1, keepLast))) {
    try {
      fs.unlinkSync(path.join(backupDir, old));
      pruned.push(old);
    } catch {}
  }

  logEvent(db, { eventType: 'system.backup', actor: 'collab-hub', payload: { path: target, bytes: stat.size, pruned: pruned.length } });
  return { ok: true, backup_path: target, size_bytes: stat.size, retained: Math.min(snaps.length, keepLast), pruned };
}

/**
 * Comprehensive 8-point CollabHub system health & integrity diagnostic (`collab_doctor` / `GET /api/doctor`).
 */
export async function runSystemDoctor(db, { dbPath = DB_PATH, worktreeDir = WORKTREE_DIR } = {}) {
  const checks = [];

  // 1. SQLite integrity
  try {
    const res = db.prepare('PRAGMA integrity_check;').get();
    const ok = res?.integrity_check === 'ok';
    const sizeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    checks.push({ id: 'sqlite_integrity', status: ok ? 'pass' : 'fail', detail: `integrity=${res?.integrity_check}, size=${Math.round(sizeBytes / 1024)}KB` });
  } catch (err) {
    checks.push({ id: 'sqlite_integrity', status: 'fail', detail: err.message });
  }

  // 2. Agent Mail Hub (:5291)
  const mail = await probeMailHub({ force: true });
  checks.push({
    id: 'agent_mail_hub',
    status: mail.ok ? 'pass' : 'fail',
    detail: mail.ok ? `mcp-agent-mail v${mail.version} online (${mail.url})` : `unreachable (${mail.error || mail.status})`,
  });

  // 3. Installed GitHub Toolkit binaries (5/5)
  const tk = getToolkitStatus();
  const missingTk = ['cass', 'ast_grep', 'beads', 'repomix', 'markitdown'].filter((k) => !tk[k]?.installed);
  checks.push({
    id: 'github_toolkit',
    status: missingTk.length === 0 ? 'pass' : 'warn',
    detail: missingTk.length === 0 ? 'All 5 GitHub tools installed & verified' : `Missing: ${missingTk.join(', ')}`,
  });

  // 4. cass session archive on D:
  const cass = await getCassStats().catch(() => ({ ok: false }));
  checks.push({
    id: 'cass_archive',
    status: cass.ok ? 'pass' : 'warn',
    detail: cass.ok ? `${cass.stats?.conversations ?? 0} conversations / ${cass.stats?.messages ?? 0} messages on D:` : 'Index not initialized yet',
  });

  // 5. Agent roster readiness
  const members = getMemberStatuses(db);
  const ready = members.filter((m) => ['online', 'idle'].includes(m.state));
  const cooled = members.filter((m) => m.in_cooldown || m.cli_in_cooldown);
  checks.push({
    id: 'agent_roster',
    status: ready.length >= 2 ? 'pass' : (ready.length >= 1 ? 'warn' : 'fail'),
    detail: `${ready.length}/${members.length} ready (${ready.map((m) => m.member).join(', ') || 'none'})${cooled.length ? `; cooldown: ${cooled.map((m) => m.member).join(',')}` : ''}`,
  });

  // 6. Stalled / uncertain tasks
  const stuck = db.prepare(`SELECT task_id, member, state FROM tasks WHERE state IN ('stalled', 'uncertain', 'needs_input')`).all();
  checks.push({
    id: 'stuck_tasks',
    status: stuck.length === 0 ? 'pass' : 'warn',
    detail: stuck.length === 0 ? 'No stalled or uncertain tasks' : `${stuck.length} task(s) need attention: ${stuck.map((t) => `${t.task_id}(${t.state})`).join(', ')}`,
  });

  // 7. Orphan worktrees check
  const activeWts = listWorktrees(db, { state: 'active' });
  const missingWts = activeWts.filter((w) => !fs.existsSync(w.worktree_path));
  checks.push({
    id: 'worktrees',
    status: missingWts.length === 0 ? 'pass' : 'warn',
    detail: missingWts.length === 0
      ? `${activeWts.length} active worktree(s), all paths valid (${worktreeDir})`
      : `${missingWts.length} active worktree record(s) missing on disk`,
  });

  // 8. Provenance ledger present
  const hasProv = Boolean(tk.provenance?.components && Object.keys(tk.provenance.components).length >= 5);
  checks.push({
    id: 'provenance',
    status: hasProv ? 'pass' : 'warn',
    detail: hasProv ? `${Object.keys(tk.provenance.components).length} upstream components tracked with SHA-256` : 'provenance.json incomplete',
  });

  // 9. Optional host-local custom health probes configured in integrations.json
  for (const probe of INTEGRATIONS.customHealthProbes || []) {
    if (!probe || typeof probe.id !== 'string' || typeof probe.file !== 'string') continue;
    const timeoutMs = Math.min(Math.max(Number(probe.timeoutMs) || 8000, 1000), 15000);
    try {
      const { stdout } = await execFileAsync(
        probe.file,
        Array.isArray(probe.args) ? probe.args.map(String) : [],
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 256 * 1024 },
      );
      const parsed = JSON.parse(String(stdout || '').trim() || '{}');
      const status = ['pass', 'warn', 'fail'].includes(parsed.status)
        ? parsed.status
        : (parsed.ok === false ? 'fail' : 'pass');
      const detail = typeof parsed.detail === 'string' && parsed.detail
        ? parsed.detail
        : JSON.stringify(parsed).slice(0, 200);
      checks.push({ id: probe.id, status, detail });
    } catch (err) {
      checks.push({
        id: probe.id,
        status: probe.required ? 'fail' : 'warn',
        detail: `${probe.label || probe.id} unavailable: ${err.message}`,
      });
    }
  }

  const overall = checks.some((c) => c.status === 'fail')
    ? 'unhealthy'
    : (checks.some((c) => c.status === 'warn') ? 'degraded' : 'healthy');

  return {
    checked_at: new Date().toISOString(),
    overall,
    pass_count: checks.filter((c) => c.status === 'pass').length,
    total_checks: checks.length,
    checks,
  };
}
