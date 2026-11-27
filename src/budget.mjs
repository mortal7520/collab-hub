/**
 * CollabHub v2.2 — Token & Call Budget Quota Guardrail Engine (`budget_policies`)
 *
 * Tracks trailing-24h call volume & token consumption per agent / project / global scope,
 * surfaces soft warnings (`soft_warn_pct`), applies adaptive dispatch downgrade penalties,
 * and blocks hard over-limit background dispatches when `on_exceed === 'block'`.
 */
import { logEvent } from './db.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';

const VALID_SCOPES = new Set(['global', 'agent', 'project']);
const VALID_ACTIONS = new Set(['warn', 'downgrade', 'block']);

function parsePolicyRow(r) {
  if (!r) return null;
  return {
    policy_id: r.policy_id,
    scope_type: r.scope_type,
    scope_id: r.scope_id,
    daily_token_limit: r.daily_token_limit ?? null,
    daily_call_limit: r.daily_call_limit ?? null,
    soft_warn_pct: Number(r.soft_warn_pct ?? 80),
    on_exceed: r.on_exceed || 'warn',
    enabled: Boolean(r.enabled),
    updated_at: r.updated_at,
  };
}

export function setBudgetPolicy(db, {
  policyId = null,
  scopeType = 'agent',
  scopeId = '*',
  dailyTokenLimit = null,
  dailyCallLimit = null,
  softWarnPct = 80,
  onExceed = 'warn',
  enabled = true,
} = {}) {
  const safeScope = String(scopeType || 'agent').trim();
  if (!VALID_SCOPES.has(safeScope)) throw new Error(`Invalid scope_type "${safeScope}". Use: global | agent | project`);
  const safeAction = String(onExceed || 'warn').trim();
  if (!VALID_ACTIONS.has(safeAction)) throw new Error(`Invalid on_exceed "${safeAction}". Use: warn | downgrade | block`);
  const cleanScopeId = safeScope === 'global' ? '*' : String(scopeId || '*').trim().slice(0, 160);
  if (!cleanScopeId) throw new Error('scope_id is required');
  const tokLim = dailyTokenLimit === null || dailyTokenLimit === undefined ? null : Math.max(100, Math.round(Number(dailyTokenLimit)));
  const callLim = dailyCallLimit === null || dailyCallLimit === undefined ? null : Math.max(1, Math.round(Number(dailyCallLimit)));
  if (tokLim === null && callLim === null) {
    throw new Error('At least one of daily_token_limit or daily_call_limit must be set');
  }
  const warnPct = Math.max(10, Math.min(99, Math.round(Number(softWarnPct) || 80)));
  const id = policyId
    ? String(policyId).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64)
    : `bud_${safeScope}_${cleanScopeId.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 32)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO budget_policies (policy_id, scope_type, scope_id, daily_token_limit, daily_call_limit, soft_warn_pct, on_exceed, enabled, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(policy_id) DO UPDATE SET
      scope_type = excluded.scope_type,
      scope_id = excluded.scope_id,
      daily_token_limit = excluded.daily_token_limit,
      daily_call_limit = excluded.daily_call_limit,
      soft_warn_pct = excluded.soft_warn_pct,
      on_exceed = excluded.on_exceed,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(id, safeScope, cleanScopeId, tokLim, callLim, warnPct, safeAction, enabled ? 1 : 0, now);

  logEvent(db, { eventType: 'budget.policy_saved', actor: 'collab-hub', payload: { policy_id: id, scope_type: safeScope, scope_id: cleanScopeId, on_exceed: safeAction } });
  return parsePolicyRow(db.prepare('SELECT * FROM budget_policies WHERE policy_id = ?').get(id));
}

export function listBudgetPolicies(db) {
  try {
    return db.prepare('SELECT * FROM budget_policies ORDER BY scope_type ASC, policy_id ASC').all().map(parsePolicyRow);
  } catch {
    return [];
  }
}

export function deleteBudgetPolicy(db, policyId) {
  const res = db.prepare('DELETE FROM budget_policies WHERE policy_id = ?').run(String(policyId || ''));
  if (!res.changes) throw new Error(`Budget policy not found: ${policyId}`);
  return { deleted: true, policy_id: String(policyId) };
}

function normalizeCmp(v) {
  return String(v || '').replaceAll('\\', '/').toLowerCase();
}

export function evaluateBudget(db, { member = null, projectDir = null } = {}) {
  const policies = listBudgetPolicies(db).filter((p) => p.enabled);
  const cutoffIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const tele = computeAgentTelemetry(db, { days: 1 });
  const globalCalls = Number(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE created_at >= ?').get(cutoffIso)?.c || 0);
  const globalTokens = Object.values(tele.agents || {}).reduce((s, a) => s + Number(a.total_tokens ?? a.tokens_total ?? 0), 0);
  const agentCalls = member ? Number(db.prepare('SELECT COUNT(*) AS c FROM tasks WHERE member = ? AND created_at >= ?').get(member, cutoffIso)?.c || 0) : 0;
  const agentTokens = member ? Number(tele.agents?.[member]?.total_tokens ?? tele.agents?.[member]?.tokens_total ?? 0) : 0;
  const normProj = projectDir ? normalizeCmp(projectDir) : null;
  const projRows = normProj ? db.prepare('SELECT project_dir, evidence_json FROM tasks WHERE created_at >= ?').all(cutoffIso) : [];
  let projCalls = 0;
  let projTokens = 0;
  if (normProj) {
    for (const r of projRows) {
      if (normalizeCmp(r.project_dir) !== normProj) continue;
      projCalls += 1;
      if (r.evidence_json) {
        try {
          const ev = JSON.parse(r.evidence_json);
          const u = ev?.usage || ev?.token_usage || ev;
          const pt = Number(u?.prompt_tokens || u?.input_tokens || 0);
          const ct = Number(u?.completion_tokens || u?.output_tokens || 0);
          const tt = Number(u?.total_tokens || (pt + ct) || 0);
          if (Number.isFinite(tt) && tt > 0) projTokens += tt;
        } catch {}
      }
    }
  }

  const matched = [];
  let status = 'ok';
  let action = 'allow';
  const severityRank = { allow: 0, warn: 1, downgrade: 2, block: 3 };

  for (const p of policies) {
    let calls = globalCalls;
    let tokens = globalTokens;
    let applies = false;
    if (p.scope_type === 'global') applies = true;
    else if (p.scope_type === 'agent' && member && p.scope_id === member) {
      applies = true;
      calls = agentCalls;
      tokens = agentTokens;
    } else if (p.scope_type === 'project' && normProj && normalizeCmp(p.scope_id) === normProj) {
      applies = true;
      calls = projCalls;
      tokens = projTokens;
    }
    if (!applies) continue;

    const callRatio = p.daily_call_limit ? (calls / p.daily_call_limit) * 100 : 0;
    const tokenRatio = p.daily_token_limit ? (tokens / p.daily_token_limit) * 100 : 0;
    const peakPct = Math.round(Math.max(callRatio, tokenRatio));
    const exceeded = (p.daily_call_limit && calls >= p.daily_call_limit) || (p.daily_token_limit && tokens >= p.daily_token_limit);
    const softWarn = !exceeded && peakPct >= p.soft_warn_pct;

    if (exceeded) {
      status = 'exceeded';
      if (severityRank[p.on_exceed] > severityRank[action]) action = p.on_exceed;
    } else if (softWarn && status === 'ok') {
      status = 'warn';
      if (severityRank.warn > severityRank[action]) action = 'warn';
    }
    matched.push({
      policy_id: p.policy_id,
      scope_type: p.scope_type,
      scope_id: p.scope_id,
      calls_24h: calls,
      tokens_24h: tokens,
      daily_call_limit: p.daily_call_limit,
      daily_token_limit: p.daily_token_limit,
      peak_pct: peakPct,
      exceeded,
      soft_warn: softWarn,
      on_exceed: p.on_exceed,
    });
  }

  return {
    checked_at: new Date().toISOString(),
    member: member || null,
    project_dir: projectDir || null,
    status,
    action,
    usage: { global_calls_24h: globalCalls, global_tokens_24h: globalTokens, agent_calls_24h: agentCalls, agent_tokens_24h: agentTokens },
    matched_policies: matched,
  };
}
