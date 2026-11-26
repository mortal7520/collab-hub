/**
 * Real telemetry, token usage, per-channel Bayesian-damped recency reliability, & soft circuit-breaker
 * analytics computed directly from SQLite `tasks` ledger.
 *
 * v1.4.0 invariants (verified with Codex Desktop):
 * - Isolates reliability scoring by `(member, channel)` so `claude-cli` 429/errors NEVER penalize
 *   `claude` `desktop-native` sessions!
 * - `stalled` / `uncertain` / `needs_input` count in `effective_attempts` (`0.25w` failure weight
 *   for stalls, `1.0w` for confirmed failures) so chronically stalling agents cannot report 100% success.
 * - Operator `cancelled` tasks and upstream `429` rate-limit errors are excluded from reliability delta
 *   (429 is handled by per-channel cooldown, not permanent reliability starvation).
 * - Bayesian-damped 7-day exponential decay: `Δ = round(8 * ((4 + S) / (8 + S + F) - 0.5))`,
 *   naturally bounded in `[-4..+4]` (preserving the 10-point `online` vs `idle` routing margin)
 *   and zero on cold-start!
 */
const HALF_LIFE_MS = 7 * 86400 * 1000;
const CIRCUIT_WINDOW_MS = 6 * 3600 * 1000;
const MAX_SAMPLES_PER_BUCKET = 100;

function makeBucket(member, channel = null) {
  return {
    member,
    channel,
    total: 0,
    completed: 0,
    failed: 0,
    stalled: 0,
    cancelled: 0,
    active: 0,
    rate_limited: 0,
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    latencies_ms: [],
    weighted_ok: 0,
    weighted_fail: 0,
    recent_streak_bad: 0,
    streak_broken: false,
    samples_counted: 0,
  };
}

function accumulateRow(bucket, r, nowMs) {
  bucket.total += 1;
  const createdMs = Date.parse(r.created_at);
  const ageMs = Number.isFinite(createdMs) ? Math.max(0, nowMs - createdMs) : 0;
  const decayWeight = Math.pow(0.5, ageMs / HALF_LIFE_MS);

  if (r.evidence_json) {
    try {
      const ev = JSON.parse(r.evidence_json);
      const u = ev?.usage;
      if (u && typeof u === 'object') {
        const pt = Number(u.prompt_tokens || u.input_tokens || 0);
        const ct = Number(u.completion_tokens || u.output_tokens || 0);
        const tt = Number(u.total_tokens || (pt + ct));
        if (Number.isFinite(pt) && pt > 0) bucket.prompt_tokens += pt;
        if (Number.isFinite(ct) && ct > 0) bucket.completion_tokens += ct;
        if (Number.isFinite(tt) && tt > 0) bucket.total_tokens += tt;
      }
    } catch { /* ignore malformed evidence */ }
  }

  const is429 = Boolean(r.error_code && /429|RATE_LIMIT|QUOTA/i.test(r.error_code));
  if (is429) bucket.rate_limited += 1;

  const withinCap = bucket.samples_counted < MAX_SAMPLES_PER_BUCKET;

  if (r.state === 'completed') {
    bucket.completed += 1;
    if (withinCap) {
      bucket.weighted_ok += decayWeight;
      bucket.samples_counted += 1;
    }
    bucket.streak_broken = true;
    const end = Date.parse(r.completed_at || r.updated_at);
    if (Number.isFinite(createdMs) && Number.isFinite(end) && end >= createdMs) {
      bucket.latencies_ms.push(end - createdMs);
    }
  } else if (r.state === 'failed') {
    bucket.failed += 1;
    // Exclude 429 quota failures from reliability_delta (already governed by per-channel cooldown)
    if (!is429 && withinCap) {
      bucket.weighted_fail += decayWeight;
      bucket.samples_counted += 1;
    }
    if (!is429 && !bucket.streak_broken && ageMs <= CIRCUIT_WINDOW_MS) {
      bucket.recent_streak_bad += 1;
    }
  } else if (['stalled', 'uncertain', 'needs_input'].includes(r.state)) {
    bucket.stalled += 1;
    if (withinCap) {
      bucket.weighted_fail += decayWeight * 0.25;
      bucket.samples_counted += 1;
    }
    if (!bucket.streak_broken && ageMs <= CIRCUIT_WINDOW_MS) {
      bucket.recent_streak_bad += 1;
    }
  } else if (r.state === 'cancelled') {
    bucket.cancelled += 1;
  } else if (['running', 'dispatching', 'dispatched'].includes(r.state)) {
    bucket.active += 1;
  }
}

function finalizeBucket(m) {
  const effectiveAttempts = m.completed + m.failed + m.stalled;
  const successRate = effectiveAttempts > 0 ? Number((m.completed / effectiveAttempts).toFixed(3)) : null;
  const weightedDenom = m.weighted_ok + m.weighted_fail;
  const weightedSuccess = weightedDenom > 0 ? Number((m.weighted_ok / weightedDenom).toFixed(3)) : null;
  const avgLatencyMs = m.latencies_ms.length > 0
    ? Math.round(m.latencies_ms.reduce((a, b) => a + b, 0) / m.latencies_ms.length)
    : null;

  // Bayesian-damped recency delta: Δ = round(8 * ((4 + S) / (8 + S + F) - 0.5))
  // Cold-start => 0; preserves the 10-point online vs idle routing margin.
  let reliabilityDelta = 0;
  if (weightedDenom > 0) {
    const posterior = (4 + m.weighted_ok) / (8 + m.weighted_ok + m.weighted_fail);
    reliabilityDelta = Math.round((posterior - 0.5) * 8);
    // Ensure small clean streaks of >=2 successes still get at least +1 (and >=2 failures get <= -1)
    if (reliabilityDelta === 0 && m.completed >= 2 && m.failed === 0 && m.stalled === 0) reliabilityDelta = 1;
    if (reliabilityDelta === 0 && (m.failed + m.stalled) >= 2 && m.completed === 0) reliabilityDelta = -1;
  }

  const circuitState = m.recent_streak_bad >= 3
    ? 'open'
    : (m.recent_streak_bad === 2 ? 'half_open' : 'closed');

  return {
    member: m.member,
    ...(m.channel ? { channel: m.channel } : {}),
    total: m.total,
    completed: m.completed,
    failed: m.failed,
    stalled: m.stalled,
    cancelled: m.cancelled,
    active: m.active,
    effective_attempts: effectiveAttempts,
    rate_limited: m.rate_limited,
    prompt_tokens: m.prompt_tokens,
    completion_tokens: m.completion_tokens,
    total_tokens: m.total_tokens,
    success_rate: successRate,
    weighted_success_rate: weightedSuccess,
    avg_latency_ms: avgLatencyMs,
    reliability_delta: reliabilityDelta,
    circuit_state: circuitState,
    recent_streak_bad: m.recent_streak_bad,
  };
}

export function computeAgentTelemetry(db, { days = 30 } = {}) {
  const nowMs = Date.now();
  const windowDays = Math.max(1, Math.min(365, Number(days) || 30));
  const sinceIso = new Date(nowMs - windowDays * 86400 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT member, channel, state, error_code, evidence_json, created_at, completed_at, updated_at
    FROM tasks
    WHERE created_at >= ?
    ORDER BY created_at DESC
  `).all(sinceIso);

  const byMember = new Map();
  const byChannel = new Map();
  let totalTokensAll = 0;

  for (const r of rows) {
    if (!byMember.has(r.member)) byMember.set(r.member, makeBucket(r.member));
    const mb = byMember.get(r.member);
    const prevTok = mb.total_tokens;
    accumulateRow(mb, r, nowMs);
    totalTokensAll += (mb.total_tokens - prevTok);

    const chanKey = `${r.member}::${r.channel || 'default'}`;
    if (!byChannel.has(chanKey)) byChannel.set(chanKey, makeBucket(r.member, r.channel || 'default'));
    accumulateRow(byChannel.get(chanKey), r, nowMs);
  }

  const agents = {};
  let totalAll = 0;
  let completedAll = 0;
  for (const [member, m] of byMember.entries()) {
    totalAll += m.total;
    completedAll += m.completed;
    agents[member] = finalizeBucket(m);
  }

  const channels = {};
  for (const [chanKey, b] of byChannel.entries()) {
    channels[chanKey] = finalizeBucket(b);
  }

  return {
    window_days: windowDays,
    total_tasks: totalAll,
    completed_tasks: completedAll,
    total_tokens: totalTokensAll,
    overall_success_rate: totalAll > 0 ? Number((completedAll / totalAll).toFixed(3)) : null,
    agents,
    channels,
  };
}
