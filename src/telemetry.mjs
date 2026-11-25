/**
 * Real telemetry, token usage, & reliability analytics computed directly from SQLite `tasks` ledger.
 */
export function computeAgentTelemetry(db, { days = 30 } = {}) {
  const sinceIso = new Date(Date.now() - Math.max(1, Math.min(365, Number(days) || 30)) * 86400 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT member, state, error_code, evidence_json, created_at, completed_at, updated_at
    FROM tasks
    WHERE created_at >= ?
  `).all(sinceIso);

  const byMember = new Map();
  let totalTokensAll = 0;

  for (const r of rows) {
    if (!byMember.has(r.member)) {
      byMember.set(r.member, {
        member: r.member,
        total: 0,
        completed: 0,
        failed: 0,
        stalled: 0,
        active: 0,
        rate_limited: 0,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        latencies_ms: [],
      });
    }
    const m = byMember.get(r.member);
    m.total += 1;
    if (r.evidence_json) {
      try {
        const ev = JSON.parse(r.evidence_json);
        const u = ev?.usage;
        if (u && typeof u === 'object') {
          const pt = Number(u.prompt_tokens || u.input_tokens || 0);
          const ct = Number(u.completion_tokens || u.output_tokens || 0);
          const tt = Number(u.total_tokens || (pt + ct));
          if (Number.isFinite(pt) && pt > 0) m.prompt_tokens += pt;
          if (Number.isFinite(ct) && ct > 0) m.completion_tokens += ct;
          if (Number.isFinite(tt) && tt > 0) {
            m.total_tokens += tt;
            totalTokensAll += tt;
          }
        }
      } catch { /* ignore malformed evidence */ }
    }
    if (r.state === 'completed') {
      m.completed += 1;
      const start = Date.parse(r.created_at);
      const end = Date.parse(r.completed_at || r.updated_at);
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        m.latencies_ms.push(end - start);
      }
    } else if (r.state === 'failed') {
      m.failed += 1;
    } else if (['stalled', 'uncertain', 'needs_input'].includes(r.state)) {
      m.stalled += 1;
    } else if (['running', 'dispatching', 'dispatched'].includes(r.state)) {
      m.active += 1;
    }
    if (r.error_code && /429|RATE_LIMIT|QUOTA/i.test(r.error_code)) {
      m.rate_limited += 1;
    }
  }

  const agents = {};
  let totalAll = 0;
  let completedAll = 0;
  for (const [member, m] of byMember.entries()) {
    totalAll += m.total;
    completedAll += m.completed;
    const terminal = m.completed + m.failed;
    const successRate = terminal > 0 ? Number((m.completed / terminal).toFixed(3)) : null;
    const avgLatencyMs = m.latencies_ms.length > 0
      ? Math.round(m.latencies_ms.reduce((a, b) => a + b, 0) / m.latencies_ms.length)
      : null;
    let reliabilityDelta = 0;
    if (terminal >= 2 && successRate !== null) {
      reliabilityDelta = Math.round((successRate - 0.5) * 16);
    }
    agents[member] = {
      member,
      total: m.total,
      completed: m.completed,
      failed: m.failed,
      stalled: m.stalled,
      active: m.active,
      rate_limited: m.rate_limited,
      prompt_tokens: m.prompt_tokens,
      completion_tokens: m.completion_tokens,
      total_tokens: m.total_tokens,
      success_rate: successRate,
      avg_latency_ms: avgLatencyMs,
      reliability_delta: reliabilityDelta,
    };
  }

  return {
    window_days: Math.max(1, Math.min(365, Number(days) || 30)),
    total_tasks: totalAll,
    completed_tasks: completedAll,
    total_tokens: totalTokensAll,
    overall_success_rate: totalAll > 0 ? Number((completedAll / totalAll).toFixed(3)) : null,
    agents,
  };
}
