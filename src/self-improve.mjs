import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { APP_ROOT, DB_PATH, WORKTREE_DIR } from './config.mjs';
import { getMemberStatuses, isProcessAlive, logEvent, pruneRetentionTables } from './db.mjs';
import { sweepOrphanTasks } from './executors.mjs';
import { writeMemoryNote } from './memory.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';
import { listWorktrees } from './worktree.mjs';

const MAX_GUARDRAIL_LEN = 320;
const MAX_PATTERN_LEN = 200;
const MAX_INJECTED_GUARDRAILS = 3;
const MAX_INJECTED_CHARS = 700;

/**
 * Strip control characters, prompt-injection delimiters, and obvious secret tokens before storing or injecting.
 */
export function sanitizeLessonText(raw, maxLen = MAX_GUARDRAIL_LEN) {
  return String(raw || '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}\b/gi, '$1 [REDACTED]')
    .replace(/\b(authorization|api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*[^\s,;]+/gi, '$1=[REDACTED]')
    .replace(/\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,})\b/g, '[REDACTED_SECRET]')
    .replace(/<\/?(?:system|assistant|user|instructions?|failure_output)[^>]*>/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLen);
}

function lessonFingerprint({ project, member, role, errorCode, pattern }) {
  const norm = [
    String(project || '*').trim().toLowerCase(),
    String(member || '*').trim().toLowerCase(),
    String(role || '*').trim().toLowerCase(),
    String(errorCode || '').trim().toUpperCase(),
    String(pattern || '').trim().toLowerCase().slice(0, 120),
  ].join('|');
  return createHash('sha256').update(norm).digest('hex').slice(0, 24);
}

function parseLessonRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    fingerprint: row.fingerprint,
    project: row.project,
    member: row.member,
    role: row.role,
    error_code: row.error_code,
    pattern: row.pattern,
    guardrail: row.guardrail,
    hits: Number(row.hits || 0),
    active: Boolean(row.active),
    auto_learned: Boolean(row.auto_learned),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/**
 * Upsert a deduplicated incident lesson / learned guardrail into SQLite.
 */
export function saveIncidentLesson(db, {
  project = '*',
  member = '*',
  role = '*',
  errorCode = '',
  pattern,
  guardrail,
  autoLearned = false,
  active = true,
}) {
  const cleanPattern = sanitizeLessonText(pattern, MAX_PATTERN_LEN);
  const cleanGuardrail = sanitizeLessonText(guardrail, MAX_GUARDRAIL_LEN);
  if (!cleanPattern) throw new Error('Lesson pattern is required');
  if (!cleanGuardrail) throw new Error('Lesson guardrail is required');

  const cleanProject = sanitizeLessonText(project || '*', 64) || '*';
  const cleanMember = sanitizeLessonText(member || '*', 40) || '*';
  const cleanRole = sanitizeLessonText(role || '*', 32) || '*';
  const cleanCode = sanitizeLessonText(errorCode || '', 64).toUpperCase();
  const fp = lessonFingerprint({ project: cleanProject, member: cleanMember, role: cleanRole, errorCode: cleanCode, pattern: cleanPattern });
  const now = new Date().toISOString();

  const existing = db.prepare('SELECT * FROM incident_lessons WHERE fingerprint = ?').get(fp);
  if (existing) {
    db.prepare(`
      UPDATE incident_lessons
      SET guardrail = ?, hits = hits + 1, updated_at = ?
      WHERE id = ?
    `).run(cleanGuardrail, now, existing.id);
    const updated = parseLessonRow(db.prepare('SELECT * FROM incident_lessons WHERE id = ?').get(existing.id));
    logEvent(db, { eventType: 'lesson.updated', actor: 'collab-hub', payload: { id: updated.id, member: updated.member, error_code: updated.error_code } });
    return updated;
  }

  const res = db.prepare(`
    INSERT INTO incident_lessons (fingerprint, project, member, role, error_code, pattern, guardrail, hits, active, auto_learned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
  `).run(fp, cleanProject, cleanMember, cleanRole, cleanCode, cleanPattern, cleanGuardrail, active ? 1 : 0, autoLearned ? 1 : 0, now, now);
  const created = parseLessonRow(db.prepare('SELECT * FROM incident_lessons WHERE id = ?').get(Number(res.lastInsertRowid)));
  logEvent(db, { eventType: 'lesson.saved', actor: 'collab-hub', payload: { id: created.id, member: created.member, error_code: created.error_code, auto_learned: created.auto_learned } });
  return created;
}

export function listIncidentLessons(db, { activeOnly = false, member = null, limit = 50 } = {}) {
  const cap = Math.max(1, Math.min(200, Number(limit) || 50));
  const where = [];
  const params = [];
  if (activeOnly) where.push('active = 1');
  if (member) {
    where.push('(member = ? OR member = \'*\')');
    params.push(String(member));
  }
  const sql = `SELECT * FROM incident_lessons ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY active DESC, hits DESC, updated_at DESC LIMIT ?`;
  params.push(cap);
  return db.prepare(sql).all(...params).map(parseLessonRow);
}

export function toggleIncidentLesson(db, id, active) {
  const numId = Number(id);
  if (!Number.isInteger(numId) || numId <= 0) throw new Error('Valid numeric lesson id is required');
  const existing = db.prepare('SELECT * FROM incident_lessons WHERE id = ?').get(numId);
  if (!existing) throw new Error(`Lesson not found: ${numId}`);
  const now = new Date().toISOString();
  db.prepare('UPDATE incident_lessons SET active = ?, updated_at = ? WHERE id = ?').run(active ? 1 : 0, now, numId);
  const updated = parseLessonRow(db.prepare('SELECT * FROM incident_lessons WHERE id = ?').get(numId));
  logEvent(db, { eventType: 'lesson.toggled', actor: 'coordinator', payload: { id: numId, active: updated.active } });
  return updated;
}

/**
 * Match up to 3 bounded, active learned guardrails relevant to an upcoming task dispatch.
 * Never injects raw untrusted stderr or exceeds MAX_INJECTED_CHARS.
 */
export function matchGuardrailsForDispatch(db, { projectDir = '', member = '*', role = '*' } = {}) {
  const projName = projectDir ? path.basename(String(projectDir)).toLowerCase() : '*';
  const rows = db.prepare(`
    SELECT * FROM incident_lessons
    WHERE active = 1
      AND (project = '*' OR LOWER(project) = ?)
      AND (member = '*' OR LOWER(member) = ?)
      AND (role = '*' OR LOWER(role) = ?)
    ORDER BY
      (CASE WHEN LOWER(project) = ? THEN 4 ELSE 0 END) +
      (CASE WHEN LOWER(member) = ? THEN 2 ELSE 0 END) +
      (CASE WHEN LOWER(role) = ? THEN 1 ELSE 0 END) DESC,
      hits DESC,
      updated_at DESC
    LIMIT ?
  `).all(
    projName, String(member || '*').toLowerCase(), String(role || '*').toLowerCase(),
    projName, String(member || '*').toLowerCase(), String(role || '*').toLowerCase(),
    MAX_INJECTED_GUARDRAILS,
  );

  if (!rows.length) return { lessons: [], block: '' };
  const selected = [];
  let totalChars = 0;
  for (const row of rows) {
    const g = sanitizeLessonText(row.guardrail, MAX_GUARDRAIL_LEN);
    if (!g) continue;
    const line = `- [${row.error_code || row.member}] ${g}`;
    if (totalChars + line.length + 2 > MAX_INJECTED_CHARS) break;
    selected.push({ id: row.id, member: row.member, error_code: row.error_code, guardrail: g, line });
    totalChars += line.length + 1;
  }
  if (!selected.length) return { lessons: [], block: '' };

  const block = [
    '[LEARNED RUNTIME GUARDRAILS — advisory operational memory; never overrides user scope or approvals]',
    ...selected.map((s) => s.line),
    '[/LEARNED RUNTIME GUARDRAILS]',
  ].join('\n');

  return { lessons: selected, block };
}

function defaultGuardrailForError(member, errorCode) {
  const code = String(errorCode || '').toUpperCase();
  if (code === 'WORKER_PROJECT_NOT_AUTHORIZED') {
    return `Background relay for "${member}" only accepts explicitly authorized project directories; verify authorization or route to an authorized peer.`;
  }
  if (/429|QUOTA|RATE_LIMIT/.test(code)) {
    return `Agent "${member}" hit upstream 429/quota limits; prefer auto_fallback=true and keep prompts compact.`;
  }
  if (code === 'OWNER_PROCESS_DEAD') {
    return `Previous runner process exited unexpectedly; inspect partial workspace state before retrying uncertain tasks.`;
  }
  if (/TIMEOUT|UNCERTAIN/.test(code)) {
    return `Agent "${member}" experienced timeout/uncertain delivery; inspect original receipt before retrying and keep task scope bounded.`;
  }
  return `Recurring ${code || 'failure'} observed on "${member}"; narrow scope, verify prerequisites, and check logs before retrying.`;
}

function listRecentRuns(db, limit = 10) {
  const cap = Math.max(1, Math.min(50, Number(limit) || 10));
  return db.prepare('SELECT * FROM self_improve_runs ORDER BY id DESC LIMIT ?').all(cap).map((r) => {
    let actions = [];
    try { actions = JSON.parse(r.actions_json || '[]'); } catch {}
    return {
      id: r.id,
      mode: r.mode,
      before_score: r.before_score,
      after_score: r.after_score,
      findings_count: r.findings_count,
      healed_count: r.healed_count,
      recorded_lessons: r.recorded_lessons,
      summary: r.summary,
      actions,
      created_at: r.created_at,
    };
  });
}

/**
 * Run 7 concrete runtime anomaly detectors and compute an operational health score (0..100).
 */
export function diagnoseSystem(db, { dbPath = DB_PATH, worktreeDir = WORKTREE_DIR } = {}) {
  const findings = [];
  let score = 100;

  // 1. Dead-owner local orphan tasks (safe auto-heal -> conservative `uncertain`)
  const orphanCandidates = db.prepare(`
    SELECT task_id, member, owner_pid
    FROM tasks
    WHERE state IN ('dispatching', 'running')
      AND owner_pid IS NOT NULL
      AND channel IN ('generic-cli', 'openai-http')
  `).all().filter((r) => r.owner_pid !== process.pid && !isProcessAlive(r.owner_pid));
  if (orphanCandidates.length > 0) {
    score -= Math.min(25, orphanCandidates.length * 12);
    findings.push({
      id: 'dead_owner_orphans',
      severity: 'high',
      category: 'execution',
      title: `${orphanCandidates.length} orphan task(s) owned by dead process(es)`,
      detail: orphanCandidates.map((r) => `${r.task_id}(pid=${r.owner_pid})`).join(', '),
      auto_healable: true,
      recommended_action: 'Sweep dead-owner tasks conservatively into uncertain state so workflow resume cannot blindly resend.',
      target_ids: orphanCandidates.map((r) => r.task_id),
    });
  }

  // 2. Stuck / needs_input / stalled / uncertain tasks (operator review ONLY — never blindly auto-cancelled!)
  const stuck = db.prepare(`
    SELECT task_id, member, state, updated_at
    FROM tasks
    WHERE state IN ('stalled', 'uncertain', 'needs_input')
    ORDER BY updated_at DESC
    LIMIT 20
  `).all();
  if (stuck.length > 0) {
    score -= Math.min(20, stuck.length * 5);
    findings.push({
      id: 'stuck_tasks',
      severity: stuck.length >= 3 ? 'medium' : 'low',
      category: 'tasks',
      title: `${stuck.length} task(s) awaiting operator reconciliation`,
      detail: stuck.map((t) => `${t.task_id}[${t.member}:${t.state}]`).join(', '),
      auto_healable: false,
      recommended_action: 'Inspect original task receipts and call collab_task_reconcile (never auto-resend uncertain tasks).',
      target_ids: stuck.map((t) => t.task_id),
    });
  }

  // 3. Expired cooldowns still lingering in member_status (safe auto-heal with atomic conditional match)
  const nowIso = new Date().toISOString();
  const expiredCooldowns = db.prepare(`
    SELECT member, cooldown_until, cooldown_channel
    FROM member_status
    WHERE cooldown_until IS NOT NULL AND cooldown_until <= ?
  `).all(nowIso);
  if (expiredCooldowns.length > 0) {
    score -= 4;
    findings.push({
      id: 'expired_cooldowns',
      severity: 'low',
      category: 'routing',
      title: `${expiredCooldowns.length} expired cooldown record(s) still persisted`,
      detail: expiredCooldowns.map((c) => c.member).join(', '),
      auto_healable: true,
      recommended_action: 'Conditionally clear elapsed cooldown timestamps (matching exact deadline & channel) without disturbing fresh 429s.',
      target_ids: expiredCooldowns.map((c) => `${c.member}|${c.cooldown_until}|${c.cooldown_channel || ''}`),
    });
  }

  // 4. Active worktree records missing on disk (only when mount root exists & NO non-terminal task uses the worktree)
  const mountHealthy = !worktreeDir || fs.existsSync(worktreeDir);
  const openTaskWts = new Set(
    db.prepare("SELECT worktree_path FROM tasks WHERE state NOT IN ('completed', 'failed', 'rerouted', 'cancelled') AND worktree_path IS NOT NULL")
      .all()
      .map((r) => String(r.worktree_path).toLowerCase()),
  );
  const missingWts = mountHealthy
    ? listWorktrees(db, { state: 'active' }).filter((w) => !fs.existsSync(w.worktree_path) && !openTaskWts.has(String(w.worktree_path || '').toLowerCase()))
    : [];
  if (missingWts.length > 0) {
    score -= Math.min(15, missingWts.length * 6);
    findings.push({
      id: 'missing_worktrees',
      severity: 'medium',
      category: 'worktrees',
      title: `${missingWts.length} active worktree record(s) missing on disk`,
      detail: missingWts.map((w) => `${w.task_id}(${w.branch_name})`).join(', '),
      auto_healable: true,
      recommended_action: 'Reconcile orphaned DB worktree records to state=missing (preserving audit history).',
      target_ids: missingWts.map((w) => w.task_id),
    });
  }

  // 5. Repeating error clusters (14-day window, >=2 occurrences) -> auto-extract incident lesson!
  const since14d = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
  const clusters = db.prepare(`
    SELECT member, COALESCE(error_code, state) AS code, COUNT(*) AS cnt
    FROM tasks
    WHERE created_at >= ?
      AND (state IN ('failed', 'stalled') OR error_code IS NOT NULL)
      AND state != 'cancelled'
    GROUP BY member, COALESCE(error_code, state)
    HAVING COUNT(*) >= 2
    ORDER BY cnt DESC
    LIMIT 8
  `).all(since14d);
  const existingFps = new Set(db.prepare('SELECT fingerprint FROM incident_lessons').all().map((r) => r.fingerprint));
  const unlearnedClusters = clusters.filter((c) => {
    const fp = lessonFingerprint({ project: '*', member: c.member, role: '*', errorCode: c.code, pattern: `Recurring ${c.code} on ${c.member}` });
    return !existingFps.has(fp);
  });
  if (unlearnedClusters.length > 0) {
    score -= Math.min(18, unlearnedClusters.length * 7);
    findings.push({
      id: 'repeating_error_clusters',
      severity: 'medium',
      category: 'learning',
      title: `${unlearnedClusters.length} repeating failure pattern(s) not yet captured as guardrails`,
      detail: unlearnedClusters.map((c) => `${c.member}:${c.code} (${c.cnt}x)`).join(', '),
      auto_healable: true,
      recommended_action: 'Extract deduplicated incident_lessons guardrails and record incident summary in shared memory.',
      target_ids: unlearnedClusters.map((c) => `${c.member}:${c.code}`),
    });
  }

  // 6. Circuit-breaker / degraded agent reliability from telemetry
  const telemetry = computeAgentTelemetry(db, { days: 14 });
  const degradedAgents = Object.values(telemetry.agents).filter((a) => a.circuit_state === 'open' || (a.effective_attempts >= 3 && a.success_rate !== null && a.success_rate < 0.5));
  if (degradedAgents.length > 0) {
    score -= Math.min(15, degradedAgents.length * 6);
    findings.push({
      id: 'degraded_agent_reliability',
      severity: 'medium',
      category: 'routing',
      title: `${degradedAgents.length} agent(s) showing elevated failure/stall rate`,
      detail: degradedAgents.map((a) => `${a.member} (success=${Math.round((a.success_rate || 0) * 100)}%, stalled=${a.stalled}, circuit=${a.circuit_state})`).join('; '),
      auto_healable: false,
      recommended_action: 'Adaptive routing automatically applies a soft penalty; verify external relay/auth health.',
      target_ids: degradedAgents.map((a) => a.member),
    });
  }

  // 7. DB retention & WAL size check (safe auto-heal: prune + WAL TRUNCATE checkpoint)
  const evCount = Number(db.prepare('SELECT COUNT(*) AS c FROM events').get()?.c || 0);
  const logCount = Number(db.prepare('SELECT COUNT(*) AS c FROM task_logs').get()?.c || 0);
  let walBytes = 0;
  try {
    const walPath = `${dbPath}-wal`;
    if (fs.existsSync(walPath)) walBytes = fs.statSync(walPath).size;
  } catch {}
  if (evCount > 8000 || logCount > 16000 || walBytes > 2 * 1024 * 1024) {
    score -= 6;
    findings.push({
      id: 'db_retention_wal',
      severity: 'low',
      category: 'storage',
      title: 'SQLite retention or WAL checkpoint recommended',
      detail: `events=${evCount}, task_logs=${logCount}, wal=${Math.round(walBytes / 1024)}KB`,
      auto_healable: true,
      recommended_action: 'Run bounded retention pruning (max 500 rows/call) and PRAGMA wal_checkpoint(PASSIVE).',
    });
  }

  // 8. Stale Desktop member presence (informational)
  const staleDesktop = getMemberStatuses(db).filter((m) => m.is_stale && m.driver === 'desktop-native');
  if (staleDesktop.length > 0) {
    score -= 3;
    findings.push({
      id: 'stale_desktop_presence',
      severity: 'info',
      category: 'roster',
      title: `${staleDesktop.length} Desktop member snapshot(s) expired`,
      detail: staleDesktop.map((m) => `${m.member}(${Math.round(m.age_s / 60)}m)`).join(', '),
      auto_healable: false,
      recommended_action: 'Call collab_roster with live desktop_observations from your active Desktop bridge.',
      target_ids: staleDesktop.map((m) => m.member),
    });
  }

  const clampedScore = Math.max(0, Math.min(100, Math.round(score)));
  const overall = clampedScore >= 85 && !findings.some((f) => f.severity === 'high')
    ? 'healthy'
    : (clampedScore >= 60 ? 'degraded' : 'unhealthy');
  const healableCount = findings.filter((f) => f.auto_healable).length;
  const lessons = listIncidentLessons(db, { limit: 40 });
  const recentRuns = listRecentRuns(db, 10);

  return {
    checked_at: new Date().toISOString(),
    health_score: clampedScore,
    overall,
    summary: findings.length === 0
      ? 'All runtime invariants healthy; zero anomalies detected.'
      : `${findings.length} finding(s) detected (${healableCount} safe to auto-heal).`,
    findings,
    lessons,
    recent_runs: recentRuns,
    counts: {
      findings: findings.length,
      healable: healableCount,
      active_lessons: lessons.filter((l) => l.active).length,
      worktree_dir: worktreeDir,
    },
  };
}

/**
 * Compact overview badge payload (fast, zero disk writes).
 */
export function getSelfImproveSummary(db, { dbPath = DB_PATH, worktreeDir = WORKTREE_DIR } = {}) {
  const diag = diagnoseSystem(db, { dbPath, worktreeDir });
  return {
    health_score: diag.health_score,
    overall: diag.overall,
    findings_count: diag.counts.findings,
    healable_count: diag.counts.healable,
    active_lessons: diag.counts.active_lessons,
    last_heal_at: diag.recent_runs[0]?.created_at || null,
  };
}

/**
 * Execute safe, zero-risk operational self-healing (or dry-run preview when `apply: false`).
 * Strictly NEVER kills external runs, NEVER mutates code, NEVER auto-retries uncertain tasks.
 */
export function applySelfHeal(db, {
  apply = false,
  recordLessons = true,
  dbPath = DB_PATH,
  worktreeDir = WORKTREE_DIR,
  memoryDir = path.join(APP_ROOT, 'memory'),
} = {}) {
  if (typeof apply !== 'boolean') {
    throw new Error('apply must be a strict boolean (true or false)');
  }
  const doApply = apply === true;
  const before = diagnoseSystem(db, { dbPath, worktreeDir });
  const actionsTaken = [];
  let recordedLessons = 0;

  for (const f of before.findings) {
    if (!f.auto_healable) continue;
    if (f.id === 'dead_owner_orphans') {
      if (doApply) {
        const res = sweepOrphanTasks(db);
        actionsTaken.push({ action: 'sweep_orphan_tasks', count: res.recovered.length, detail: `Recovered ${res.recovered.length} dead-owner task(s) to uncertain` });
      } else {
        actionsTaken.push({ action: 'sweep_orphan_tasks', count: f.target_ids?.length || 0, detail: `[dry-run] Would mark ${f.target_ids?.length || 0} dead-owner task(s) uncertain` });
      }
    } else if (f.id === 'expired_cooldowns') {
      if (doApply) {
        let cleared = 0;
        for (const spec of (f.target_ids || [])) {
          const [mId, expectedUntil, expectedChan] = String(spec).split('|');
          const ch = db.prepare(`
            UPDATE member_status
            SET cooldown_until = NULL, cooldown_reason = NULL, cooldown_channel = NULL,
                state = CASE WHEN state = 'cooldown' THEN 'idle' ELSE state END
            WHERE member = ? AND cooldown_until = ? AND COALESCE(cooldown_channel, '') = ?
          `).run(mId, expectedUntil, expectedChan || '');
          cleared += Number(ch.changes || 0);
        }
        actionsTaken.push({ action: 'clear_expired_cooldowns', count: cleared, detail: `Conditionally cleared ${cleared} expired cooldown(s)` });
      } else {
        actionsTaken.push({ action: 'clear_expired_cooldowns', count: f.target_ids?.length || 0, detail: `[dry-run] Would clear ${f.target_ids?.length || 0} expired cooldown(s)` });
      }
    } else if (f.id === 'missing_worktrees') {
      if (doApply) {
        let reconciled = 0;
        const now = new Date().toISOString();
        for (const tid of (f.target_ids || [])) {
          const wt = db.prepare("SELECT worktree_path FROM worktrees WHERE task_id = ? AND state = 'active'").get(tid);
          if (!wt || fs.existsSync(wt.worktree_path)) continue;
          const stillOpen = db.prepare("SELECT 1 FROM tasks WHERE worktree_path = ? AND state NOT IN ('completed', 'failed', 'rerouted', 'cancelled') LIMIT 1").get(wt.worktree_path);
          if (stillOpen) continue;
          const r = db.prepare("UPDATE worktrees SET state = 'missing', updated_at = ? WHERE task_id = ? AND state = 'active'").run(now, tid);
          reconciled += Number(r.changes || 0);
        }
        actionsTaken.push({ action: 'reconcile_missing_worktrees', count: reconciled, detail: `Marked ${reconciled} missing-on-disk worktree record(s) as missing` });
      } else {
        actionsTaken.push({ action: 'reconcile_missing_worktrees', count: f.target_ids?.length || 0, detail: `[dry-run] Would mark ${f.target_ids?.length || 0} missing worktree(s) as missing` });
      }
    } else if (f.id === 'repeating_error_clusters' && recordLessons) {
      const targets = f.target_ids || [];
      if (doApply) {
        for (const pair of targets) {
          const [member, code] = String(pair).split(':');
          saveIncidentLesson(db, {
            project: '*',
            member,
            role: '*',
            errorCode: code,
            pattern: `Recurring ${code} on ${member}`,
            guardrail: defaultGuardrailForError(member, code),
            autoLearned: true,
          });
          recordedLessons += 1;
        }
        if (recordedLessons > 0) {
          try {
            writeMemoryNote(db, {
              project: 'collab-hub-ops',
              slug: 'self-improve-lessons',
              title: 'Auto-Learned Runtime Guardrails',
              content: `Self-heal extracted ${recordedLessons} new incident guardrail(s) at ${new Date().toISOString()}:\n\n` +
                targets.map((p) => `- \`${p}\`: ${defaultGuardrailForError(p.split(':')[0], p.split(':')[1])}`).join('\n'),
              tags: ['self-improve', 'guardrails', 'ops'],
              author: 'collab-hub',
              memoryDir,
            });
          } catch { /* best-effort memory note */ }
        }
        actionsTaken.push({ action: 'extract_incident_lessons', count: recordedLessons, detail: `Recorded ${recordedLessons} deduplicated runtime guardrail(s)` });
      } else {
        actionsTaken.push({ action: 'extract_incident_lessons', count: targets.length, detail: `[dry-run] Would extract ${targets.length} incident guardrail(s)` });
      }
    } else if (f.id === 'db_retention_wal') {
      if (doApply) {
        const pr = pruneRetentionTables(db, { maxEvents: 10000, maxLogs: 20000, maxDeletePerCall: 500 });
        try { db.exec('PRAGMA wal_checkpoint(PASSIVE);'); } catch {}
        actionsTaken.push({ action: 'prune_and_checkpoint_wal', count: pr.pruned_events + pr.pruned_logs, detail: `Pruned ${pr.pruned_events} events / ${pr.pruned_logs} logs (cap 500/call) and ran WAL PASSIVE checkpoint` });
      } else {
        actionsTaken.push({ action: 'prune_and_checkpoint_wal', count: 1, detail: '[dry-run] Would prune expired events/logs (cap 500/call) and run WAL PASSIVE checkpoint' });
      }
    }
  }

  // Dry-run preview MUST be 100% read-only (zero writes to self_improve_runs or events!)
  if (!doApply) {
    return {
      ok: true,
      applied: false,
      run_id: null,
      before_score: before.health_score,
      after_score: before.health_score,
      healed_count: 0,
      recorded_lessons: 0,
      summary: `Dry-run preview: ${actionsTaken.length} safe heal action(s) available (current score ${before.health_score}).`,
      actions_taken: actionsTaken,
      remaining_findings: before.findings,
      lessons: before.lessons,
      recent_runs: before.recent_runs,
    };
  }

  const after = diagnoseSystem(db, { dbPath, worktreeDir });
  const healedCount = actionsTaken.reduce((sum, a) => sum + (a.count || 0), 0);
  const summary = actionsTaken.length > 0
    ? `Applied ${actionsTaken.length} safe heal action(s); health score ${before.health_score} → ${after.health_score}.`
    : `No auto-healable anomalies needed action (score ${after.health_score}).`;

  const now = new Date().toISOString();
  const runInsert = db.prepare(`
    INSERT INTO self_improve_runs (mode, before_score, after_score, findings_count, healed_count, recorded_lessons, summary, actions_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'apply',
    before.health_score,
    after.health_score,
    before.findings.length,
    healedCount,
    recordedLessons,
    summary,
    JSON.stringify(actionsTaken),
    now,
  );
  const runId = Number(runInsert.lastInsertRowid);
  logEvent(db, {
    eventType: 'system.self_healed',
    actor: 'collab-hub',
    payload: { run_id: runId, before_score: before.health_score, after_score: after.health_score, healed_count: healedCount, recorded_lessons: recordedLessons },
  });

  return {
    ok: true,
    applied: true,
    run_id: runId,
    before_score: before.health_score,
    after_score: after.health_score,
    healed_count: healedCount,
    recorded_lessons: recordedLessons,
    summary,
    actions_taken: actionsTaken,
    remaining_findings: after.findings,
    lessons: after.lessons,
    recent_runs: listRecentRuns(db, 10),
  };
}
