/**
 * CollabHub v2.2 — Extracted Low-Level Execution Drivers & Protocol Helpers
 * Decouples transport mechanics (Baton stdio, Muse operator, Claude relay, Generic CLI, OpenAI HTTP)
 * from high-level task orchestration in `src/executors.mjs`.
 */
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import readline from 'node:readline';
import { promisify } from 'node:util';
import { APP_VERSION, INTEGRATIONS, toWslPath } from './config.mjs';
import { validateDriverConfig } from './registry.mjs';

const execFileAsync = promisify(execFile);

export const QUOTA_429_PATTERN = /\b429\b|quota|rate.?limit|cool(?:ing)?\s*down|too many requests|capacity|resource\s+has\s+been\s+exhausted|exhausted/i;

export function isAckOnlyText(text) {
  const s = String(text || '').trim();
  if (!s) return true;
  return /^(ack|acknowledged|ok|received|queued|accepted|working|in progress|收到|已收到)[\s.!！。-]*$/i.test(s);
}

export function uuidv5Url(name) {
  const nsBytes = Buffer.from('6ba7b8119dad11d180b400c04fd430c8', 'hex');
  const hash = createHash('sha1').update(nsBytes).update(Buffer.from(name, 'utf8')).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export function canonicalGoJson(value) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
    }
    return v;
  };
  return JSON.stringify(sortDeep(value))
    .replaceAll('&', '\\u0026')
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('\u2028', '\\u2028')
    .replaceAll('\u2029', '\\u2029');
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.unref();
    } catch { /* fallback below */ }
    try { child.kill(); } catch {}
    return;
  }
  if (child.pid) {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    setTimeout(() => {
      if (child.exitCode === null) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }, 800).unref();
  }
  try { child.kill('SIGKILL'); } catch {}
}

/**
 * Hardened zero-dependency MCP stdio client for an optional baton MCP launcher.
 * Handles spawn errors, unexpected child exit, stdin EPIPE, and Windows process-tree cleanup.
 */
export async function callBatonTool(toolName, args, { timeoutMs = 75000, nodeExe = INTEGRATIONS.nodeExe, launcher = INTEGRATIONS.batonLauncher } = {}) {
  if (process.env.DSH_PEER_WORKER === '1') {
    throw new Error('Recursive DSH dispatch is forbidden from inside a DSH peer worker.');
  }
  const child = spawn(nodeExe, [launcher], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pending = new Map();
  let nextId = 1;
  let stderrBuf = '';
  let closed = false;

  const rejectAll = (err) => {
    if (closed) return;
    closed = true;
    for (const [, waiter] of pending) waiter.reject(err);
    pending.clear();
  };

  child.on('error', (err) => rejectAll(Object.assign(new Error(`Baton spawn error: ${err.message}`), { code: err.code || 'BATON_SPAWN_ERROR' })));
  child.on('exit', (code, signal) => {
    if (pending.size > 0) {
      rejectAll(Object.assign(new Error(`Baton exited prematurely (code=${code}, signal=${signal}): ${stderrBuf.slice(-300)}`), { code: 'BATON_EXIT_PREMATURE' }));
    }
  });
  child.stdin.on('error', (err) => rejectAll(Object.assign(new Error(`Baton stdin error: ${err.message}`), { code: err.code || 'BATON_STDIN_ERROR' })));
  child.stderr.on('data', (chunk) => { stderrBuf = (stderrBuf + chunk.toString('utf8')).slice(-4000); });

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const msg = JSON.parse(trimmed);
      if (msg.id !== undefined && pending.has(msg.id)) {
        const waiter = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        else waiter.resolve(msg.result);
      }
    } catch { /* ignore non-JSON stderr/log noise */ }
  });

  const rpc = (method, params, ms) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('Baton transport already closed')); return; }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(Object.assign(new Error(`Baton RPC ${method} timed out after ${ms}ms`), { code: 'BATON_TIMEOUT_UNCERTAIN' }));
    }, ms);
    pending.set(id, {
      resolve: (v) => { clearTimeout(timer); resolve(v); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    } catch (err) {
      clearTimeout(timer);
      pending.delete(id);
      reject(Object.assign(new Error(`Baton write failed: ${err.message}`), { code: 'BATON_WRITE_UNCERTAIN' }));
    }
  });

  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'collab-hub', version: APP_VERSION },
    }, 20000);
    try {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
    } catch {}
    const raw = await rpc('tools/call', { name: toolName, arguments: args }, timeoutMs);
    if (raw?.isError) {
      const txt = (raw.content || []).map((c) => c.text || '').join('\n');
      throw new Error(`Baton tool ${toolName} returned error: ${txt || 'unknown'}`);
    }
    let structured = raw?.structuredContent;
    if (!structured || typeof structured !== 'object') {
      for (const item of raw?.content || []) {
        if (item.type === 'text' && typeof item.text === 'string') {
          try {
            const parsed = JSON.parse(item.text);
            if (parsed && typeof parsed === 'object') { structured = parsed; break; }
          } catch { /* plain text */ }
        }
      }
    }
    return structured || { raw_text: (raw?.content || []).map((c) => c.text || '').join('\n') };
  } finally {
    closed = true;
    rl.close();
    try { child.stdin.end(); } catch {}
    setTimeout(() => killProcessTree(child), 300).unref();
  }
}

export async function runMuseOperator(method, route, payloadWinPath = null) {
  const args = [
    '-d', INTEGRATIONS.wslDistro, '-u', INTEGRATIONS.wslUser, '--exec',
    'python3', INTEGRATIONS.museOperatorClient,
    '--socket', INTEGRATIONS.musePublisherSocket,
    method, route,
  ];
  if (payloadWinPath) {
    args.push('--body-file', toWslPath(payloadWinPath));
  }
  try {
    const { stdout } = await execFileAsync('wsl.exe', args, {
      encoding: 'utf8',
      timeout: 50000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return JSON.parse(stdout.trim());
  } catch (err) {
    if (err.stdout) {
      try { return JSON.parse(String(err.stdout).trim()); } catch {}
    }
    throw Object.assign(
      new Error(`Muse operator ${method} ${route} failed; inspect original mapping before retrying (${err.message})`),
      { code: 'MUSE_OPERATOR_UNCERTAIN' },
    );
  }
}

export async function callClaudeWorkerClient(method, params) {
  return new Promise((resolve, reject) => {
    const child = spawn(INTEGRATIONS.nodeExe, [INTEGRATIONS.claudeWorkerClient], {
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
    let out = '';
    let settled = false;
    const done = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(val);
    };
    const timer = setTimeout(() => {
      killProcessTree(child);
      done(reject, Object.assign(new Error('Claude worker client timed out; inspect original receipt'), { code: 'WORKER_CLIENT_TIMEOUT_UNKNOWN' }));
    }, 80000);

    child.on('error', (e) => done(reject, Object.assign(new Error(`Claude worker spawn error: ${e.message}`), { code: 'WORKER_CLIENT_UNAVAILABLE' })));
    child.stdin.on('error', () => {});
    child.stdout.on('data', (c) => {
      out += c.toString('utf8');
      if (out.length > 2 * 1024 * 1024) {
        killProcessTree(child);
        done(reject, Object.assign(new Error('Claude worker response exceeded 2MB cap'), { code: 'WORKER_RESPONSE_TOO_LARGE' }));
      }
    });
    child.on('close', () => {
      try {
        const parsed = JSON.parse(out.trim());
        if (parsed.ok === true) done(resolve, parsed.result);
        else done(reject, Object.assign(new Error(`Claude worker error: ${parsed.error?.code || 'UNKNOWN'}`), { code: parsed.error?.code || 'WORKER_CLIENT_UNKNOWN' }));
      } catch {
        done(reject, Object.assign(new Error('Claude worker returned non-JSON response'), { code: 'WORKER_CLIENT_UNKNOWN' }));
      }
    });

    try {
      child.stdin.write(JSON.stringify({
        method,
        params,
        relay_directory: INTEGRATIONS.claudeWorkerRelayDir,
      }));
      child.stdin.end();
    } catch (err) {
      done(reject, Object.assign(new Error(`Claude worker write error: ${err.message}`), { code: 'WORKER_CLIENT_UNKNOWN' }));
    }
  });
}

export function classifyDshWait(result) {
  if (!result || typeof result !== 'object') return 'running';
  if (result.needs_input || ['needs_input', 'needs_resume', 'goal_stalled'].includes(result.state)) return 'needs_input';
  if (result.state === 'cancelled') return 'cancelled';
  if (['failed', 'interrupted'].includes(result.state)) return 'failed';
  if (result.timed_out || result.harness_down) return 'running';
  if (result.state === 'completed') {
    if (['blocked', 'paused'].includes(result.goal?.phase)) return 'needs_input';
    if (result.goal?.phase === 'active') return result.goal.activation === 'disarmed' ? 'needs_input' : 'running';
    if (result.goal?.ended_since_run) return 'running';
    return 'completed';
  }
  if (result.state === 'goal_ended') return ['complete', 'completed'].includes(result.ended_because) ? 'completed' : 'needs_input';
  return 'running';
}

export function extractDshText(result) {
  if (typeof result?.final_text === 'string' && result.final_text.trim()) return result.final_text.trim();
  if (Array.isArray(result?.rounds)) {
    return result.rounds.map((r) => r.final_text || r.summary || '').filter((s) => typeof s === 'string' && s.trim()).join('\n\n').trim();
  }
  return '';
}

export function detectClaude429(receipt, err = null) {
  const haystack = [
    err?.code,
    err?.message,
    receipt?.error?.code,
    receipt?.error?.message,
    receipt?.failureReason,
    receipt?.stderr,
    receipt?.output,
    receipt?.diagnostic?.code,
    receipt?.diagnostic?.reason,
    receipt?.diagnostic?.message,
  ].filter(Boolean).join(' | ');
  return { is429: QUOTA_429_PATTERN.test(haystack), detail: haystack.slice(0, 300) };
}

export async function runGenericCliDriver(agent, { cwd, prompt, taskId = null, db = null, activeRuns = null, appendTaskLog = null, ensureCancelWatcher = null }) {
  const cfg = agent.config || {};
  const command = cfg.command;
  if (!command) throw new Error(`generic-cli agent "${agent.id}" has no command configured`);
  const timeoutMs = Math.max(10, Math.min(600, Number(cfg.timeout_s) || 120)) * 1000;
  const rawArgs = Array.isArray(cfg.args) ? cfg.args : [];
  const argv = rawArgs.map((a) => a.replaceAll('{{prompt}}', prompt).replaceAll('{{cwd}}', cwd));
  const useStdin = cfg.prompt_mode === 'stdin' || !rawArgs.some((a) => a.includes('{{prompt}}'));

  const childEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
  for (const key of (cfg.env_allow || [])) {
    if (process.env[key] !== undefined) childEnv[key] = process.env[key];
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      cwd,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let cancelled = false;
    let childClosed = false;
    let cancelReason = null;
    let resolveExited = null;
    const exitedPromise = new Promise((r) => { resolveExited = r; });

    const finish = (fn, v) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        if (taskId && activeRuns) activeRuns.delete(taskId);
        fn(v);
      }
    };
    if (taskId) {
      appendTaskLog?.(taskId, 'system', `[start] ${command} (${agent.id}, pid=${child.pid || 'n/a'})`, db);
      activeRuns?.set(taskId, {
        kind: 'generic-cli',
        pid: child.pid || null,
        async cancel(reason) {
          if (cancelled) return exitedPromise.then(() => childClosed);
          cancelled = true;
          cancelReason = reason || 'Cancelled by operator';
          killProcessTree(child);
          await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 2500))]);
          const exited = childClosed || child.exitCode !== null || child.signalCode !== null;
          if (exited) {
            finish(reject, Object.assign(new Error(cancelReason), { code: 'TASK_CANCELLED' }));
          }
          return exited;
        },
      });
      ensureCancelWatcher?.(db);
    }
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish(reject, Object.assign(new Error(`generic-cli "${agent.id}" timed out after ${timeoutMs}ms`), { code: 'GENERIC_CLI_TIMEOUT' }));
    }, timeoutMs);

    child.on('error', (err) => {
      childClosed = true;
      resolveExited?.();
      finish(reject, Object.assign(new Error(`generic-cli spawn error: ${err.message}`), { code: err.code || 'GENERIC_CLI_SPAWN' }));
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (c) => {
      const s = c.toString('utf8');
      if (stdout.length < 2 * 1024 * 1024) stdout += s;
      if (taskId) appendTaskLog?.(taskId, 'stdout', s, db);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      if (stderr.length < 256 * 1024) stderr += s;
      if (taskId) appendTaskLog?.(taskId, 'stderr', s, db);
    });
    child.on('close', (code) => {
      childClosed = true;
      resolveExited?.();
      if (cancelled) {
        finish(reject, Object.assign(new Error(cancelReason || 'Cancelled by operator'), { code: 'TASK_CANCELLED' }));
      } else if (code === 0) {
        if (taskId) appendTaskLog?.(taskId, 'system', '[exit 0]', db);
        finish(resolve, { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
      } else {
        if (taskId) appendTaskLog?.(taskId, 'system', `[exit ${code}]`, db);
        finish(reject, Object.assign(new Error(`generic-cli exited ${code}: ${(stderr || stdout).slice(0, 400)}`), { code: `GENERIC_CLI_EXIT_${code}` }));
      }
    });
    try {
      if (useStdin) child.stdin.write(prompt);
      child.stdin.end();
    } catch {}
  });
}

export async function runOpenAiHttpDriver(agent, { prompt, taskId = null, db = null, activeRuns = null, appendTaskLog = null, ensureCancelWatcher = null }) {
  const cfg = validateDriverConfig('openai-http', agent.config || {});
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.api_key_env) {
    const key = process.env[cfg.api_key_env];
    if (!key) throw Object.assign(new Error(`Environment variable ${cfg.api_key_env} is not set for agent "${agent.id}"`), { code: 'HTTP_AGENT_MISSING_ENV_KEY' });
    headers.Authorization = `Bearer ${key}`;
  }
  const messages = [];
  if (cfg.system_prompt) messages.push({ role: 'system', content: cfg.system_prompt });
  messages.push({ role: 'user', content: prompt });

  const timeoutMs = Math.max(10, Math.min(300, Number(cfg.timeout_s) || 90)) * 1000;
  const controller = new AbortController();
  let cancelled = false;
  let httpSettled = false;
  let resolveSettled = null;
  const settledPromise = new Promise((r) => { resolveSettled = r; });
  if (taskId) {
    appendTaskLog?.(taskId, 'system', `[http] POST ${cfg.base_url}/chat/completions (model=${cfg.model})`, db);
    activeRuns?.set(taskId, {
      kind: 'openai-http',
      async cancel(reason) {
        cancelled = true;
        controller.abort(new Error(reason || 'Cancelled by operator'));
        await Promise.race([settledPromise, new Promise((r) => setTimeout(r, 1500))]);
        return httpSettled;
      },
    });
    ensureCancelWatcher?.(db);
  }
  try {
    const signal = AbortSignal.any ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) : controller.signal;
    const res = await fetch(`${cfg.base_url}/chat/completions`, {
      method: 'POST',
      headers,
      redirect: 'error',
      body: JSON.stringify({
        model: cfg.model,
        messages,
        max_tokens: cfg.max_tokens || 4096,
      }),
      signal,
    });
    const MAX_HTTP_RESPONSE_BYTES = 2 * 1024 * 1024;
    let text = '';
    if (res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader();
      const dec = new TextDecoder('utf-8');
      let totalBytes = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > MAX_HTTP_RESPONSE_BYTES) {
          try { await reader.cancel(); } catch {}
          throw Object.assign(new Error(`HTTP response from ${agent.id} exceeded ${MAX_HTTP_RESPONSE_BYTES} byte cap`), { code: 'HTTP_AGENT_RESPONSE_TOO_LARGE' });
        }
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
    } else {
      text = await res.text();
      if (Buffer.byteLength(text, 'utf8') > MAX_HTTP_RESPONSE_BYTES) {
        throw Object.assign(new Error(`HTTP response from ${agent.id} exceeded ${MAX_HTTP_RESPONSE_BYTES} byte cap`), { code: 'HTTP_AGENT_RESPONSE_TOO_LARGE' });
      }
    }
    if (res.status === 429) {
      throw Object.assign(new Error(`HTTP 429 rate limit on ${agent.id}: ${text.slice(0, 240)}`), { code: 'HTTP_AGENT_429' });
    }
    if (!res.ok) {
      throw Object.assign(new Error(`HTTP ${res.status} from ${agent.id}: ${text.slice(0, 240)}`), { code: `HTTP_AGENT_${res.status}` });
    }
    const data = JSON.parse(text);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw Object.assign(new Error(`Empty completion from ${agent.id}`), { code: 'HTTP_AGENT_EMPTY' });
    }
    if (taskId) appendTaskLog?.(taskId, 'stdout', content.trim().slice(0, 2000), db);
    return { content: content.trim(), usage: data.usage || null, model: data.model || cfg.model, id: data.id || null };
  } catch (err) {
    if (cancelled) throw Object.assign(new Error('Cancelled by operator'), { code: 'TASK_CANCELLED' });
    throw err;
  } finally {
    httpSettled = true;
    resolveSettled?.();
    if (taskId) activeRuns?.delete(taskId);
  }
}
