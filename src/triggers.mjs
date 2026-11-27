/**
 * CollabHub v2.2 — Lightweight Local Inspection & Self-Heal Trigger Engine (`automation_triggers`)
 *
 * Security invariant: ONLY strictly allowlisted built-in safe operations can run — never arbitrary shell!
 * Enforces a per-trigger cooldown floor (min 60s on scheduled runs) to prevent event/disk storms.
 */
import { randomUUID } from 'node:crypto';
import { pruneExpiredArtifacts } from './artifacts.mjs';
import { WORKSPACE_ROOT, WORKTREE_DIR } from './config.mjs';
import { logEvent } from './db.mjs';
import { createHotBackup } from './doctor.mjs';
import { applySelfHeal, diagnoseSystem } from './self-improve.mjs';
import { buildSkillsRulesSnapshot } from './skills-hub.mjs';
import { reconcileStaleClaimsInAllRooms } from './workspace-room.mjs';

export const ALLOWED_TRIGGER_ACTIONS = new Set([
  'self_check',
  'self_heal_preview',
  'hot_backup',
  'skills_drift_check',
  'prune_artifacts',
  'reconcile_stale_claims',
]);

function parseTriggerRow(r) {
  if (!r) return null;
  let config = {};
  try { config = JSON.parse(r.config_json || '{}'); } catch { config = {}; }
  return {
    trigger_id: r.trigger_id,
    name: r.name,
    kind: r.kind,
    action: r.action,
    interval_sec: r.interval_sec ?? null,
    event_match: r.event_match || null,
    config,
    enabled: Boolean(r.enabled),
    last_run_at: r.last_run_at || null,
    last_status: r.last_status || null,
    last_summary: r.last_summary || null,
    run_count: Number(r.run_count || 0),
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function saveTrigger(db, {
  triggerId = null,
  name,
  kind = 'interval',
  action,
  intervalSec = 900,
  eventMatch = null,
  config = {},
  enabled = true,
} = {}) {
  const safeName = String(name || '').trim().slice(0, 80);
  if (!safeName) throw new Error('Trigger name is required');
  const safeAction = String(action || '').trim();
  if (!ALLOWED_TRIGGER_ACTIONS.has(safeAction)) {
    throw new Error(`Disallowed trigger action "${safeAction}". Allowed: ${[...ALLOWED_TRIGGER_ACTIONS].join(', ')}`);
  }
  const safeKind = kind === 'manual' ? 'manual' : 'interval';
  const safeInterval = safeKind === 'interval' ? Math.max(60, Math.min(86400, Math.round(Number(intervalSec) || 900))) : null;
  const id = triggerId
    ? String(triggerId).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48)
    : `trg_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO automation_triggers (trigger_id, name, kind, action, interval_sec, event_match, config_json, enabled, run_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(trigger_id) DO UPDATE SET
      name = excluded.name,
      kind = excluded.kind,
      action = excluded.action,
      interval_sec = excluded.interval_sec,
      event_match = excluded.event_match,
      config_json = excluded.config_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(id, safeName, safeKind, safeAction, safeInterval, eventMatch ? String(eventMatch).slice(0, 64) : null, JSON.stringify(config || {}), enabled ? 1 : 0, now, now);

  logEvent(db, { eventType: 'trigger.saved', actor: 'collab-hub', payload: { trigger_id: id, action: safeAction, kind: safeKind } });
  return parseTriggerRow(db.prepare('SELECT * FROM automation_triggers WHERE trigger_id = ?').get(id));
}

export function listTriggers(db) {
  try {
    return db.prepare('SELECT * FROM automation_triggers ORDER BY updated_at DESC, trigger_id ASC').all().map(parseTriggerRow);
  } catch {
    return [];
  }
}

export function deleteTrigger(db, triggerId) {
  const res = db.prepare('DELETE FROM automation_triggers WHERE trigger_id = ?').run(String(triggerId || ''));
  if (!res.changes) throw new Error(`Trigger not found: ${triggerId}`);
  return { deleted: true, trigger_id: String(triggerId) };
}

export function runTriggerNow(db, triggerId, deps = {}) {
  const row = db.prepare('SELECT * FROM automation_triggers WHERE trigger_id = ?').get(String(triggerId || ''));
  if (!row) throw new Error(`Trigger not found: ${triggerId}`);
  if (!ALLOWED_TRIGGER_ACTIONS.has(row.action)) {
    throw new Error(`Refused unsafe trigger action: ${row.action}`);
  }
  const worktreeDir = deps.worktreeDir || WORKTREE_DIR;
  const workspaceRoot = deps.workspaceRoot || WORKSPACE_ROOT;
  const now = new Date().toISOString();
  let status = 'ok';
  let summary = '';
  let detail = {};

  try {
    if (row.action === 'self_check') {
      const res = diagnoseSystem(db, { worktreeDir });
      summary = `Health ${res.health_score}/100 (${res.findings.length} findings)`;
      detail = { health_score: res.health_score, findings: res.findings.length };
    } else if (row.action === 'self_heal_preview') {
      const res = applySelfHeal(db, { apply: false, worktreeDir });
      summary = res.summary;
      detail = { before_score: res.before_score, actions: res.actions_taken.length };
    } else if (row.action === 'hot_backup') {
      const res = createHotBackup(db, deps.backupDir ? { backupDir: deps.backupDir } : {});
      summary = `Backup OK (${res.size_bytes} bytes)`;
      detail = { backup_path: res.backup_path, size_bytes: res.size_bytes };
    } else if (row.action === 'skills_drift_check') {
      const snap = buildSkillsRulesSnapshot({ projectDir: workspaceRoot, workspaceRoot });
      summary = `${snap.summary.skills_total} skills · ${snap.summary.skill_drift_count} skill drift · ${snap.summary.rules_drifted} rule drift`;
      detail = snap.summary;
    } else if (row.action === 'prune_artifacts') {
      const res = pruneExpiredArtifacts(db);
      summary = `Pruned ${res.pruned} expired artifact(s)`;
      detail = res;
    } else if (row.action === 'reconcile_stale_claims') {
      const res = reconcileStaleClaimsInAllRooms(db);
      summary = `Expired ${res.expired} stale room claim(s) across ${res.rooms_updated} room(s)`;
      detail = res;
    }
  } catch (err) {
    status = 'error';
    summary = String(err.message || err).slice(0, 200);
  }

  db.prepare(`
    UPDATE automation_triggers
    SET last_run_at = ?, last_status = ?, last_summary = ?, run_count = run_count + 1, updated_at = ?
    WHERE trigger_id = ?
  `).run(now, status, summary, now, row.trigger_id);

  logEvent(db, { eventType: 'trigger.executed', actor: 'collab-hub', payload: { trigger_id: row.trigger_id, action: row.action, status, summary } });
  return { trigger: parseTriggerRow(db.prepare('SELECT * FROM automation_triggers WHERE trigger_id = ?').get(row.trigger_id)), status, summary, detail };
}

export function startTriggerScheduler(db, deps = {}) {
  const tickMs = Math.max(15000, Number(deps.tickMs) || 30000);
  const timer = setInterval(() => {
    const nowMs = Date.now();
    for (const trg of listTriggers(db)) {
      if (!trg.enabled || trg.kind !== 'interval' || !trg.interval_sec) continue;
      const lastMs = trg.last_run_at ? Date.parse(trg.last_run_at) : 0;
      const cooldownMs = Math.max(60000, trg.interval_sec * 1000);
      if (nowMs - lastMs >= cooldownMs) {
        try { runTriggerNow(db, trg.trigger_id, deps); } catch {}
      }
    }
  }, tickMs);
  timer.unref();
  return { stop() { clearInterval(timer); } };
}
