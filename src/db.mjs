import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, DESKTOP_FRESHNESS_TTL_MS, MEMBERS, assertValidAgentId } from './config.mjs';
import { hubBus } from './event-bus.mjs';
import { ensureRecipesTable } from './recipes.mjs';
import { ensureAgentsTable, listAgents } from './registry.mjs';

export function openHubDb(dbPath = DB_PATH) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA temp_store = MEMORY;');
  db.exec('PRAGMA cache_size = -16000;');
  db.exec('PRAGMA busy_timeout = 8000;');
  db.exec('PRAGMA foreign_keys = ON;');
  initSchema(db);
  return db;
}

/**
 * Cross-platform PID liveness probe (treats EPERM as alive, ESRCH as dead).
 */
export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return err?.code === 'EPERM';
  }
}

function ensureColumn(db, table, column, definition) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  }
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      task_id TEXT PRIMARY KEY,
      batch_id TEXT,
      parent_task_id TEXT,
      project_dir TEXT NOT NULL,
      member TEXT NOT NULL,
      role TEXT NOT NULL,
      channel TEXT NOT NULL,
      title TEXT NOT NULL,
      prompt TEXT NOT NULL,
      state TEXT NOT NULL,
      external_id TEXT,
      session_id TEXT,
      reply_generation INTEGER,
      payload_sha256 TEXT,
      worktree_path TEXT,
      branch_name TEXT,
      result_text TEXT,
      evidence_json TEXT,
      error_code TEXT,
      error_message TEXT,
      meta_json TEXT,
      mail_message_id TEXT,
      dispatch_token TEXT,
      attempted_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_state ON tasks(state);
    CREATE INDEX IF NOT EXISTS idx_tasks_member ON tasks(member);
    CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batch_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_updated ON tasks(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_tasks_poll ON tasks(state, channel, updated_at ASC);
    CREATE INDEX IF NOT EXISTS idx_tasks_batch_created ON tasks(batch_id, created_at ASC);

    CREATE TABLE IF NOT EXISTS member_status (
      member TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      state TEXT NOT NULL,
      cooldown_until TEXT,
      cooldown_reason TEXT,
      cooldown_channel TEXT,
      sessions_json TEXT,
      detail TEXT,
      checked_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS worktrees (
      task_id TEXT PRIMARY KEY,
      repo_dir TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      wsl_path TEXT NOT NULL,
      branch_name TEXT NOT NULL,
      member TEXT NOT NULL,
      base_ref TEXT NOT NULL,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memory_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project TEXT NOT NULL,
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      tags TEXT NOT NULL DEFAULT '',
      author TEXT NOT NULL DEFAULT 'coordinator',
      file_path TEXT NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(project, slug)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT,
      event_type TEXT NOT NULL,
      actor TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_events_task ON events(task_id);
    CREATE INDEX IF NOT EXISTS idx_events_type_id ON events(event_type, id DESC);

    CREATE TABLE IF NOT EXISTS task_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      stream TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_logs_task_id ON task_logs(task_id, id ASC);

    CREATE TABLE IF NOT EXISTS workflow_plans (
      batch_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_dir TEXT NOT NULL,
      plan_json TEXT NOT NULL,
      plan_sha256 TEXT,
      created_at TEXT NOT NULL
    );
  `);

  // Safe forward-compatible migrations for existing hub.db
  ensureColumn(db, 'tasks', 'mail_message_id', 'TEXT');
  ensureColumn(db, 'tasks', 'dispatch_token', 'TEXT');
  ensureColumn(db, 'tasks', 'attempted_at', 'TEXT');
  ensureColumn(db, 'tasks', 'depends_on_json', 'TEXT');
  ensureColumn(db, 'tasks', 'owner_pid', 'INTEGER');
  ensureColumn(db, 'tasks', 'owner_token', 'TEXT');
  ensureColumn(db, 'tasks', 'cancel_requested_at', 'TEXT');
  ensureColumn(db, 'tasks', 'cancel_reason', 'TEXT');
  ensureColumn(db, 'member_status', 'cooldown_channel', 'TEXT');
  ensureColumn(db, 'worktrees', 'reviewed_head_sha', 'TEXT');
  ensureColumn(db, 'worktrees', 'verified_head_sha', 'TEXT');
  ensureColumn(db, 'worktrees', 'verify_status', 'TEXT');
  ensureColumn(db, 'worktrees', 'verify_summary', 'TEXT');
  ensureColumn(db, 'workflow_plans', 'plan_sha256', 'TEXT');

  // Enable FTS5 virtual table for memory_notes
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
        project, slug, title, tags, content,
        content='memory_notes',
        content_rowid='id'
      );
      CREATE TRIGGER IF NOT EXISTS memory_notes_ai AFTER INSERT ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(rowid, project, slug, title, tags, content)
        VALUES (new.id, new.project, new.slug, new.title, new.tags, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_notes_ad AFTER DELETE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, project, slug, title, tags, content)
        VALUES ('delete', old.id, old.project, old.slug, old.title, old.tags, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS memory_notes_au AFTER UPDATE ON memory_notes BEGIN
        INSERT INTO memory_notes_fts(memory_notes_fts, rowid, project, slug, title, tags, content)
        VALUES ('delete', old.id, old.project, old.slug, old.title, old.tags, old.content);
        INSERT INTO memory_notes_fts(rowid, project, slug, title, tags, content)
        VALUES (new.id, new.project, new.slug, new.title, new.tags, new.content);
      END;
    `);
  } catch {
    // Graceful fallback if FTS5 unavailable
  }

  // Seed dynamic agents table + built-in prompt recipes
  ensureAgentsTable(db);
  ensureRecipesTable(db);
}

/**
 * Bounded retention budget for append-only `events` and `task_logs` tables so long-running hubs
 * never bloat SQLite unboundedly.
 */
export function pruneRetentionTables(db, { maxEvents = 10000, maxLogs = 20000 } = {}) {
  let prunedEvents = 0;
  let prunedLogs = 0;
  try {
    const evCut = db.prepare('SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET ?').get(maxEvents);
    if (evCut?.id) {
      prunedEvents = db.prepare('DELETE FROM events WHERE id <= ?').run(evCut.id).changes || 0;
    }
  } catch { /* best-effort */ }
  try {
    const logCut = db.prepare('SELECT id FROM task_logs ORDER BY id DESC LIMIT 1 OFFSET ?').get(maxLogs);
    if (logCut?.id) {
      prunedLogs = db.prepare('DELETE FROM task_logs WHERE id <= ?').run(logCut.id).changes || 0;
    }
  } catch { /* best-effort */ }
  return { pruned_events: prunedEvents, pruned_logs: prunedLogs };
}

/**
 * Best-effort audit logging: never throws into a caller after an external dispatch succeeded.
 * Publishes real-time event onto hubBus for SSE subscribers (carrying event_id for cross-process dedupe).
 */
export function logEvent(db, { taskId = null, eventType, actor = 'collab-hub', payload = null }) {
  try {
    const now = new Date().toISOString();
    const res = db.prepare(`
      INSERT INTO events (task_id, event_type, actor, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(taskId, eventType, actor, payload ? JSON.stringify(payload) : null, now);
    const eventId = Number(res.lastInsertRowid || 0);
    hubBus.publish(eventType, { id: eventId, task_id: taskId, actor, payload, created_at: now, source_pid: process.pid });
    return eventId;
  } catch (err) {
    console.error(`[collab-hub] best-effort logEvent failed (${eventType}): ${err.message}`);
    return 0;
  }
}

export function getMemberStatuses(db, { desktopTtlMs = DESKTOP_FRESHNESS_TTL_MS } = {}) {
  const agents = listAgents(db);
  const statusRows = new Map(db.prepare('SELECT * FROM member_status').all().map((r) => [r.member, r]));
  const nowMs = Date.now();

  return agents.map((agent) => {
    const r = statusRows.get(agent.id) || {
      member: agent.id,
      channel: agent.defaultChannel,
      state: 'unknown',
      cooldown_until: null,
      cooldown_reason: null,
      cooldown_channel: null,
      sessions_json: '[]',
      detail: 'Not probed yet',
      checked_at: agent.updated_at,
    };
    const cooldownUntilMs = r.cooldown_until ? Date.parse(r.cooldown_until) : 0;
    const cooldownActive = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > nowMs;
    const cooldownChannel = cooldownActive ? (r.cooldown_channel || null) : null;
    const cooldownAppliesToCurrent = cooldownActive && (!cooldownChannel || cooldownChannel === r.channel);

    const checkedMs = Date.parse(r.checked_at || '');
    const ageMs = Number.isFinite(checkedMs) ? Math.max(0, nowMs - checkedMs) : Infinity;
    const isDesktopSnap = r.channel === 'desktop-native';
    const isStale = isDesktopSnap && ['online', 'idle'].includes(r.state) && ageMs > desktopTtlMs;

    let effectiveState = r.state;
    if (cooldownAppliesToCurrent) effectiveState = 'cooldown';
    else if (isStale) effectiveState = 'stale';

    let sessions = [];
    try { sessions = JSON.parse(r.sessions_json || '[]'); } catch { sessions = []; }
    return {
      member: agent.id,
      name: agent.name,
      driver: agent.driver,
      builtin: agent.builtin,
      channel: r.channel,
      state: effectiveState,
      raw_state: r.state,
      is_stale: isStale,
      age_s: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
      in_cooldown: cooldownAppliesToCurrent,
      cli_in_cooldown: cooldownActive && cooldownChannel === 'claude-cli',
      cooldown_channel: cooldownChannel,
      cooldown_until: cooldownActive ? r.cooldown_until : null,
      cooldown_remaining_s: cooldownActive ? Math.ceil((cooldownUntilMs - nowMs) / 1000) : 0,
      cooldown_reason: cooldownActive ? r.cooldown_reason : null,
      sessions,
      detail: isStale ? `${r.detail || ''} (快照已过期 ${Math.round(ageMs / 60000)}m，需协调器刷新)`.trim() : r.detail,
      checked_at: r.checked_at,
      roles: agent.roles,
      capabilities: agent.capabilities,
      config: agent.config,
    };
  });
}

export function isRegisteredAgent(db, member) {
  if (typeof member !== 'string') return false;
  return Boolean(db.prepare('SELECT 1 FROM agents WHERE agent_id = ? AND enabled = 1').get(member));
}

export function upsertMemberStatus(db, {
  member, channel, state, sessions, detail,
  cooldownUntil = undefined, cooldownReason = undefined, cooldownChannel = undefined,
}) {
  assertValidAgentId(member);
  if (!isRegisteredAgent(db, member)) throw new Error(`Unknown or disabled agent: ${member}`);
  const existing = db.prepare('SELECT * FROM member_status WHERE member = ?').get(member);
  const now = new Date().toISOString();
  const nextCooldownUntil = cooldownUntil === undefined ? (existing?.cooldown_until ?? null) : cooldownUntil;
  const nextCooldownReason = cooldownReason === undefined ? (existing?.cooldown_reason ?? null) : cooldownReason;
  const nextCooldownChannel = cooldownChannel === undefined ? (existing?.cooldown_channel ?? null) : cooldownChannel;
  const nextSessions = sessions === undefined ? (existing?.sessions_json ?? '[]') : JSON.stringify(sessions);
  db.prepare(`
    INSERT INTO member_status (member, channel, state, cooldown_until, cooldown_reason, cooldown_channel, sessions_json, detail, checked_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(member) DO UPDATE SET
      channel = excluded.channel,
      state = excluded.state,
      cooldown_until = excluded.cooldown_until,
      cooldown_reason = excluded.cooldown_reason,
      cooldown_channel = excluded.cooldown_channel,
      sessions_json = excluded.sessions_json,
      detail = excluded.detail,
      checked_at = excluded.checked_at
  `).run(member, channel, state, nextCooldownUntil, nextCooldownReason, nextCooldownChannel, nextSessions, detail ?? '', now);
}

export function setMemberCooldown(db, member, seconds, reason, channel = null) {
  assertValidAgentId(member);
  if (!isRegisteredAgent(db, member)) throw new Error(`Unknown or disabled agent: ${member}`);
  const boundedSec = Math.max(10, Math.min(86400, Number(seconds) || 1800));
  const until = new Date(Date.now() + boundedSec * 1000).toISOString();
  const existing = db.prepare('SELECT * FROM member_status WHERE member = ?').get(member);
  const scopedChannel = channel || (member === 'claude' ? 'claude-cli' : (existing?.channel || MEMBERS[member]?.defaultChannel || 'unknown'));
  const preserveDesktopOnline = member === 'claude' && existing?.channel === 'desktop-native' && existing?.state === 'online' && scopedChannel === 'claude-cli';
  upsertMemberStatus(db, {
    member,
    channel: preserveDesktopOnline ? 'desktop-native' : scopedChannel,
    state: preserveDesktopOnline ? 'online' : 'cooldown',
    cooldownUntil: until,
    cooldownReason: String(reason || 'Manual cooldown').slice(0, 300),
    cooldownChannel: scopedChannel,
    detail: preserveDesktopOnline
      ? `${existing.detail} (CLI in cooldown until ${until})`
      : `Cooldown [${scopedChannel}] until ${until}: ${reason}`,
  });
  logEvent(db, { eventType: 'member.cooldown_set', actor: member, payload: { seconds: boundedSec, until, channel: scopedChannel, reason } });
  return { member, channel: scopedChannel, cooldown_until: until, seconds: boundedSec, reason };
}

export function clearMemberCooldown(db, member) {
  assertValidAgentId(member);
  if (!isRegisteredAgent(db, member)) throw new Error(`Unknown or disabled agent: ${member}`);
  const existing = db.prepare('SELECT * FROM member_status WHERE member = ?').get(member);
  upsertMemberStatus(db, {
    member,
    channel: existing?.channel || MEMBERS[member]?.defaultChannel || 'unknown',
    state: existing?.state === 'cooldown' ? 'unknown' : (existing?.state || 'unknown'),
    cooldownUntil: null,
    cooldownReason: null,
    cooldownChannel: null,
    detail: 'Cooldown cleared; ready for re-probe',
  });
  logEvent(db, { eventType: 'member.cooldown_cleared', actor: member });
  return { member, cleared: true };
}

export function parseTaskRow(row) {
  if (!row) return null;
  let evidence = null;
  let meta = null;
  let dependsOn = [];
  try { evidence = row.evidence_json ? JSON.parse(row.evidence_json) : null; } catch { evidence = null; }
  try { meta = row.meta_json ? JSON.parse(row.meta_json) : null; } catch { meta = null; }
  try { dependsOn = row.depends_on_json ? JSON.parse(row.depends_on_json) : []; } catch { dependsOn = []; }
  return {
    task_id: row.task_id,
    batch_id: row.batch_id,
    parent_task_id: row.parent_task_id,
    depends_on: Array.isArray(dependsOn) ? dependsOn : [],
    project_dir: row.project_dir,
    member: row.member,
    role: row.role,
    channel: row.channel,
    title: row.title,
    prompt: row.prompt,
    state: row.state,
    external_id: row.external_id,
    session_id: row.session_id,
    reply_generation: row.reply_generation,
    payload_sha256: row.payload_sha256,
    worktree_path: row.worktree_path,
    branch_name: row.branch_name,
    mail_message_id: row.mail_message_id ?? null,
    dispatch_token: row.dispatch_token ?? null,
    attempted_at: row.attempted_at ?? null,
    owner_pid: row.owner_pid ?? null,
    owner_token: row.owner_token ?? null,
    cancel_requested_at: row.cancel_requested_at ?? null,
    cancel_reason: row.cancel_reason ?? null,
    result_text: row.result_text,
    evidence,
    error_code: row.error_code,
    error_message: row.error_message,
    meta,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}
