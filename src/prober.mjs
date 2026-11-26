import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { INTEGRATIONS, MAIL_BASE_URL, VALID_ROLES } from './config.mjs';
import { getMemberStatuses, logEvent, upsertMemberStatus } from './db.mjs';
import { listAgents, probeCustomAgent } from './registry.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';

const execFileAsync = promisify(execFile);

let cachedMailHealth = null;
let cachedMailAt = 0;
const MAIL_CACHE_TTL_MS = 15000;

async function runQuiet(file, args, timeout = 10000) {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    return {
      ok: false,
      code: err.code,
      stdout: String(err.stdout || '').trim(),
      stderr: String(err.stderr || err.message || '').trim(),
    };
  }
}

export async function probeDsh(runner = runQuiet) {
  if (process.platform !== 'win32' || !INTEGRATIONS.wslDistro || !INTEGRATIONS.wslUser || !INTEGRATIONS.dshSocket) {
    return { member: 'dsh', channel: 'dsh-baton', state: 'dormant', detail: 'WSL DSH adapter not configured (optional integrations.json)' };
  }
  const py = [
    'import json, os, stat, subprocess, sys',
    'r = subprocess.run(["systemctl", "is-active", sys.argv[1]], capture_output=True, text=True)',
    'p = sys.argv[2]',
    'sock = os.path.exists(p) and stat.S_ISSOCK(os.stat(p).st_mode)',
    'print(json.dumps({"service": (r.stdout or "").strip() or "unknown", "sock": sock}))',
  ].join('; ');
  const res = await runner('wsl.exe', [
    '-d', INTEGRATIONS.wslDistro, '-u', INTEGRATIONS.wslUser, '--exec', 'python3', '-c', py,
    INTEGRATIONS.dshService, INTEGRATIONS.dshSocket,
  ], 10000);
  if (!res.ok) {
    return { member: 'dsh', channel: 'dsh-baton', state: 'offline', detail: `WSL probe failed: ${res.stderr || res.code}` };
  }
  try {
    const info = JSON.parse(res.stdout.split(/\r?\n/).pop() || '{}');
    if (info.service === 'active' && info.sock === true) {
      return { member: 'dsh', channel: 'dsh-baton', state: 'online', detail: 'WSL dsh-web.service active & host.sock ready' };
    }
    return { member: 'dsh', channel: 'dsh-baton', state: 'offline', detail: `service=${info.service}, host.sock=${info.sock ? 'ok' : 'missing'}` };
  } catch {
    return { member: 'dsh', channel: 'dsh-baton', state: 'offline', detail: `Invalid WSL probe output: ${res.stdout}` };
  }
}

export async function probeMuse(runner = runQuiet) {
  if (!INTEGRATIONS.museOperatorClient || !INTEGRATIONS.musePublisherSocket || !INTEGRATIONS.musePeerIp) {
    return { member: 'muse', channel: 'muse-tailnet', state: 'dormant', detail: 'Muse Tailnet adapter not configured (optional integrations.json)' };
  }
  const [opRes, tsRes] = await Promise.all([
    runner('wsl.exe', [
      '-d', INTEGRATIONS.wslDistro, '-u', INTEGRATIONS.wslUser, '--exec',
      'python3', INTEGRATIONS.museOperatorClient, '--socket', INTEGRATIONS.musePublisherSocket, 'GET', '/whoami',
    ], 12000),
    runner(INTEGRATIONS.tailscaleExe, ['status'], 8000),
  ]);

  let relayOk = false;
  let relayDetail = 'publisher.sock unreachable';
  if (opRes.ok && opRes.stdout) {
    try {
      const parsed = JSON.parse(opRes.stdout);
      relayOk = parsed.ok === true;
      relayDetail = relayOk ? 'Tailnet relay online' : `relay status=${parsed.http_status}`;
    } catch {
      relayDetail = 'invalid operator response';
    }
  }

  let musePeerOnline = false;
  if (tsRes.ok && tsRes.stdout) {
    const line = tsRes.stdout.split(/\r?\n/).find((l) => l.includes(INTEGRATIONS.musePeerIp));
    if (line && !/\boffline\b/i.test(line)) musePeerOnline = true;
  }

  if (relayOk && musePeerOnline) {
    return { member: 'muse', channel: 'muse-tailnet', state: 'online', detail: 'Tailnet relay & Muse peer online' };
  }
  if (relayOk) {
    return { member: 'muse', channel: 'muse-tailnet', state: 'dormant', detail: `${relayDetail}; Muse peer offline or unconfirmed` };
  }
  return { member: 'muse', channel: 'muse-tailnet', state: 'offline', detail: relayDetail };
}

export async function probeClaudeCliProcess(runner = runQuiet) {
  if (process.platform !== 'win32' || !INTEGRATIONS.claudeWorkerClient) {
    return { running: false, detail: 'Claude background relay not configured' };
  }
  const ps = await runner('powershell.exe', [
    '-NoProfile', '-Command',
    "if (Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'claude-worker-runtime\\\\src\\\\background-relay-service\\.mjs' }) { 'RUNNING' } else { 'STOPPED' }",
  ], 8000);
  const running = ps.ok && /\bRUNNING\b/.test(ps.stdout);
  return { running, detail: running ? 'Background Claude CLI relay running' : 'Claude background relay stopped' };
}

/**
 * Verify genuine mcp-agent-mail MCP endpoint via JSON-RPC initialize (cached 15s to prevent overview polling stalls).
 */
export async function probeMailHub({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedMailHealth && (now - cachedMailAt) < MAIL_CACHE_TTL_MS) {
    return cachedMailHealth;
  }
  try {
    const res = await fetch(`${MAIL_BASE_URL}/mcp/`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 'probe',
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'collab-hub-probe', version: '1.0.0' } },
      }),
      signal: AbortSignal.timeout(2500),
    });
    const text = await res.text();
    let serverName = null;
    let version = null;
    try {
      const parsed = JSON.parse(text);
      serverName = parsed?.result?.serverInfo?.name || null;
      version = parsed?.result?.serverInfo?.version || null;
    } catch { /* non-JSON */ }
    const ok = res.ok && serverName === 'mcp-agent-mail';
    cachedMailHealth = { ok, status: res.status, server: serverName, version, url: `${MAIL_BASE_URL}/mail` };
  } catch (err) {
    cachedMailHealth = { ok: false, status: 0, server: null, version: null, url: `${MAIL_BASE_URL}/mail`, error: err.message };
  }
  cachedMailAt = now;
  return cachedMailHealth;
}

export async function probeAllMembers(db, { desktopObservations = null, runner = runQuiet } = {}) {
  const [dshRes, museRes, claudeCli, mailHealth] = await Promise.all([
    probeDsh(runner),
    probeMuse(runner),
    probeClaudeCliProcess(runner),
    probeMailHub(),
  ]);

  upsertMemberStatus(db, dshRes);
  upsertMemberStatus(db, museRes);

  if (desktopObservations && typeof desktopObservations === 'object') {
    const desktopIds = listAgents(db)
      .filter((a) => a.driver === 'desktop-native' || a.driver === 'claude-dual')
      .map((a) => a.id);
    for (const member of desktopIds) {
      const obs = desktopObservations[member];
      if (!obs) continue;
      const sessions = Array.isArray(obs.sessions) ? obs.sessions : [];
      const activeSessions = sessions.filter((s) => ['idle', 'ready', 'online', 'running', 'active'].includes(String(s.status || '').toLowerCase()));
      if (member === 'claude') {
        if (activeSessions.length > 0) {
          upsertMemberStatus(db, {
            member: 'claude',
            channel: 'desktop-native',
            state: 'online',
            sessions,
            detail: `Desktop priority: ${activeSessions.length} active Claude Desktop session(s)`,
          });
        } else {
          upsertMemberStatus(db, {
            member: 'claude',
            channel: claudeCli.running ? 'claude-cli' : 'desktop-native',
            state: claudeCli.running ? 'idle' : 'dormant',
            sessions,
            detail: claudeCli.running
              ? `Desktop dormant (${sessions.length} session(s)); background CLI fallback ready`
              : `Desktop dormant (${sessions.length} session(s)); background CLI stopped`,
          });
        }
      } else {
        const state = obs.state || (activeSessions.length > 0 ? 'online' : (sessions.length > 0 ? 'dormant' : 'unknown'));
        upsertMemberStatus(db, {
          member,
          channel: 'desktop-native',
          state,
          sessions,
          detail: obs.detail || `${activeSessions.length} active / ${sessions.length} total Desktop session(s)`,
        });
      }
    }
  }

  // Refresh Claude dual-mode when Desktop is not actively verified online
  const currentClaude = getMemberStatuses(db).find((m) => m.member === 'claude');
  const claudeHasFreshDesktop = currentClaude?.channel === 'desktop-native'
    && currentClaude?.state === 'online'
    && !currentClaude?.is_stale
    && (currentClaude.sessions || []).some((s) => ['idle', 'ready', 'online', 'running', 'active'].includes(String(s.status || '').toLowerCase()));

  if (!claudeHasFreshDesktop) {
    if (currentClaude?.cli_in_cooldown) {
      upsertMemberStatus(db, {
        member: 'claude',
        channel: 'claude-cli',
        state: 'cooldown',
        detail: `Desktop dormant; CLI in 429 cooldown (${currentClaude.cooldown_remaining_s}s left). ${claudeCli.detail}`,
      });
    } else if (claudeCli.running) {
      upsertMemberStatus(db, {
        member: 'claude',
        channel: 'claude-cli',
        state: 'idle',
        detail: `Desktop dormant; CLI fallback ready (${claudeCli.detail})`,
      });
    } else {
      upsertMemberStatus(db, {
        member: 'claude',
        channel: 'desktop-native',
        state: 'dormant',
        detail: 'Desktop dormant & CLI background relay stopped',
      });
    }
  }

  // Also live-probe any custom registered agents (bounded concurrency=4 + Promise.allSettled + batched WAL transaction)
  const customAgents = listAgents(db).filter((a) => ['generic-cli', 'openai-http'].includes(a.driver));
  if (customAgents.length > 0) {
    const customResults = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < customAgents.length; i += CONCURRENCY) {
      const slice = customAgents.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(slice.map((a) => probeCustomAgent(a)));
      for (const r of settled) {
        if (r.status === 'fulfilled' && r.value) customResults.push(r.value);
      }
    }
    if (customResults.length > 0) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        for (const r of customResults) {
          try { upsertMemberStatus(db, r); } catch {}
        }
        db.exec('COMMIT;');
      } catch {
        try { db.exec('ROLLBACK;'); } catch {}
      }
    }
  }

  logEvent(db, { eventType: 'roster.probed', actor: 'collab-hub', payload: { dsh: dshRes.state, muse: museRes.state, custom: customAgents.length, mail: mailHealth.ok } });

  return {
    checked_at: new Date().toISOString(),
    members: getMemberStatuses(db),
    mail_hub: mailHealth,
  };
}

/**
 * Choose best currently fresh & online agent(s) for a role across ALL registered agents (built-in + custom).
 */
export function planDispatch(db, {
  role, prefer = [], exclude = [], requireLocalFiles = false, requireLinux = false, requireBackgroundAuto = false, desktopTtlMs,
}) {
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
  const statuses = getMemberStatuses(db, desktopTtlMs !== undefined ? { desktopTtlMs } : {});
  const teleReport = computeAgentTelemetry(db, { days: 30 });
  const telemetry = teleReport.agents;
  const channelTelemetry = teleReport.channels || {};
  const excludeSet = new Set(exclude || []);
  const preferList = Array.isArray(prefer) ? prefer : [];

  const eligible = [];
  const skipped = [];

  for (const m of statuses) {
    if (excludeSet.has(m.member)) {
      skipped.push({ member: m.member, reason: 'excluded_by_caller' });
      continue;
    }
    if (!(m.roles || []).includes(role)) {
      skipped.push({ member: m.member, reason: `role_${role}_unsupported` });
      continue;
    }
    if (requireLocalFiles && (m.driver === 'muse-tailnet' || m.driver === 'openai-http')) {
      skipped.push({ member: m.member, reason: `${m.driver}_has_no_direct_local_fs_write` });
      continue;
    }
    if (requireLinux && m.driver !== 'dsh-baton') {
      skipped.push({ member: m.member, reason: 'requires_wsl_linux' });
      continue;
    }
    const supportsBgAuto = ['dsh-baton', 'muse-tailnet', 'claude-dual', 'generic-cli', 'openai-http'].includes(m.driver);
    if (requireBackgroundAuto && !supportsBgAuto) {
      skipped.push({ member: m.member, reason: 'desktop_requires_native_bridge_handoff' });
      continue;
    }
    if (requireBackgroundAuto && m.member === 'claude' && (m.channel !== 'claude-cli' || m.cli_in_cooldown)) {
      skipped.push({ member: m.member, reason: m.cli_in_cooldown ? `claude_cli_in_cooldown_${m.cooldown_remaining_s}s` : 'claude_not_in_cli_mode' });
      continue;
    }
    if (m.in_cooldown || m.state === 'cooldown') {
      skipped.push({ member: m.member, reason: `in_cooldown_${m.cooldown_remaining_s}s`, detail: m.cooldown_reason });
      continue;
    }
    if (['offline', 'dormant', 'unknown', 'stale'].includes(m.state)) {
      skipped.push({ member: m.member, reason: `state_${m.state}`, detail: m.detail });
      continue;
    }

    let score = 0;
    const prefIdx = preferList.indexOf(m.member);
    if (prefIdx >= 0) score += 100 - prefIdx * 10;
    if (m.state === 'online') score += 40;
    else if (m.state === 'idle') score += 30;
    if (m.member === 'claude' && m.channel === 'desktop-native' && m.state === 'online') score += 15;
    const chanKey = `${m.member}::${m.channel || 'default'}`;
    const tStats = channelTelemetry[chanKey] || telemetry[m.member] || null;
    if (tStats?.reliability_delta) score += tStats.reliability_delta;
    // Soft circuit-breaker penalty on >=3 consecutive recent non-429 failures/stalls
    if (tStats?.circuit_state === 'open') score -= 8;

    const executionMode = (m.channel === 'desktop-native') ? 'desktop_native_bridge' : 'background_auto';
    eligible.push({
      member: m.member,
      name: m.name,
      driver: m.driver,
      channel: m.channel,
      execution_mode: executionMode,
      state: m.state,
      score,
      success_rate: tStats?.success_rate ?? null,
      circuit_state: tStats?.circuit_state ?? 'closed',
      avg_latency_ms: tStats?.avg_latency_ms ?? null,
      detail: m.detail,
    });
  }

  eligible.sort((a, b) => b.score - a.score);
  return {
    role,
    recommended: eligible[0] || null,
    candidates: eligible,
    skipped,
    degraded: skipped.some((s) => s.reason.startsWith('in_cooldown') || s.reason.startsWith('state_') || s.reason.includes('cooldown')),
  };
}
