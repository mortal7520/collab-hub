import { execFile, execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { promisify } from 'node:util';
import {
  APP_VERSION, INTEGRATIONS, MAX_PROMPT_BYTES, NATIVE_MEMBERS, PAYLOAD_DIR,
  VALID_ROLES, WORKTREE_DIR, assertValidAgentId, assertValidMember, assertValidTaskId, loadPolicy, resolveProjectDir, toWslPath,
} from './config.mjs';
import { isProcessAlive, logEvent, parseTaskRow, setMemberCooldown } from './db.mjs';
import { hubBus } from './event-bus.mjs';
import { postMailUpdate, releaseMailPaths, reserveMailPaths } from './mail-sync.mjs';
import { planDispatch } from './prober.mjs';
import { getAgent, validateDriverConfig } from './registry.mjs';

const execFileAsync = promisify(execFile);

const QUOTA_429_PATTERN = /\b429\b|quota|rate.?limit|cool(?:ing)?\s*down|too many requests|capacity|resource\s+has\s+been\s+exhausted|exhausted/i;
const TERMINAL_STATES = new Set(['completed', 'failed', 'rerouted', 'cancelled']);
const ALLOWED_TASK_COLUMNS = new Set([
  'state', 'external_id', 'session_id', 'reply_generation', 'payload_sha256',
  'worktree_path', 'branch_name', 'result_text', 'evidence_json', 'error_code',
  'error_message', 'meta_json', 'mail_message_id', 'completed_at', 'attempted_at',
  'owner_pid', 'owner_token', 'cancel_requested_at', 'cancel_reason',
]);

const MAX_LOG_TASKS = 100;
const MAX_LOG_ENTRIES_PER_TASK = 200;
const MAX_LOG_BYTES_PER_TASK = 64 * 1024;
const ACTIVE_DISPATCHES = new Set();

function trackBackgroundPromise(promise) {
  ACTIVE_DISPATCHES.add(promise);
  promise.finally(() => { ACTIVE_DISPATCHES.delete(promise); }).catch(() => {});
  return promise;
}

/**
 * Bounded shutdown drain: waits up to `timeoutMs` for in-flight background dispatches/runs,
 * and marks any still-active local runs as `uncertain` (`HUB_SHUTDOWN`) so no task is silently abandoned.
 */
export async function awaitActiveRuns(db = null, { timeoutMs = 3000 } = {}) {
  const pending = [...ACTIVE_DISPATCHES];
  if (pending.length > 0) {
    await Promise.race([
      Promise.allSettled(pending),
      new Promise((r) => setTimeout(r, Math.max(200, Number(timeoutMs) || 3000))),
    ]);
  }
  if (db && ACTIVE_RUNS.size > 0) {
    for (const [taskId] of ACTIVE_RUNS.entries()) {
      try {
        updateTaskCas(db, taskId, {
          state: 'uncertain',
          error_code: 'HUB_SHUTDOWN',
          error_message: 'Hub process exited while local run was still active; inspect before retrying.',
        });
      } catch {}
    }
  }
  return { remaining_dispatches: ACTIVE_DISPATCHES.size, remaining_runs: ACTIVE_RUNS.size };
}
const ACTIVE_RUNS = new Map();
const TASK_LOGS = new Map();
let cancelWatcherTimer = null;
let cancelWatcherDb = null;

function ensureCancelWatcher(db) {
  if (!db) return;
  cancelWatcherDb = db;
  if (cancelWatcherTimer) return;
  cancelWatcherTimer = setInterval(() => {
    if (ACTIVE_RUNS.size === 0) {
      clearInterval(cancelWatcherTimer);
      cancelWatcherTimer = null;
      return;
    }
    try {
      for (const [tid, handle] of ACTIVE_RUNS.entries()) {
        const row = cancelWatcherDb.prepare('SELECT cancel_requested_at, cancel_reason, state FROM tasks WHERE task_id = ?').get(tid);
        if (row && (row.cancel_requested_at || row.state === 'cancelled')) {
          Promise.resolve(handle.cancel(row.cancel_reason || 'Cancelled via cross-process signal')).catch(() => {});
        }
      }
    } catch { /* best-effort */ }
  }, 250);
  cancelWatcherTimer.unref();
}

export function appendTaskLog(taskId, stream, text, db = null) {
  if (!taskId || !text) return;
  const chunk = String(text).slice(0, 4096);
  if (!chunk) return;
  let bucket = TASK_LOGS.get(taskId);
  if (!bucket) {
    if (TASK_LOGS.size >= MAX_LOG_TASKS) {
      const oldestKey = TASK_LOGS.keys().next().value;
      if (oldestKey) TASK_LOGS.delete(oldestKey);
    }
    bucket = { bytes: 0, entries: [] };
    TASK_LOGS.set(taskId, bucket);
  }
  const now = new Date().toISOString();
  const entry = { ts: now, stream: stream || 'stdout', text: chunk };
  bucket.entries.push(entry);
  bucket.bytes += Buffer.byteLength(chunk, 'utf8');
  while (bucket.entries.length > MAX_LOG_ENTRIES_PER_TASK || bucket.bytes > MAX_LOG_BYTES_PER_TASK) {
    const dropped = bucket.entries.shift();
    if (!dropped) break;
    bucket.bytes -= Buffer.byteLength(dropped.text, 'utf8');
  }
  let logId = 0;
  if (db) {
    try {
      const res = db.prepare(`
        INSERT INTO task_logs (task_id, stream, text, created_at)
        VALUES (?, ?, ?, ?)
      `).run(taskId, entry.stream, entry.text, now);
      logId = Number(res.lastInsertRowid || 0);
    } catch { /* best-effort durable persistence */ }
  }
  hubBus.publish('task.log', { log_id: logId, task_id: taskId, stream: entry.stream, text: entry.text, source_pid: process.pid });
}

export function getTaskLogs(taskId, db = null) {
  const safeId = assertValidTaskId(taskId, 'task_id');
  const localActive = ACTIVE_RUNS.has(safeId);
  let logs = [];
  let ownerPid = localActive ? process.pid : null;
  let ownerAlive = localActive;
  let cancelRequested = false;

  if (db) {
    try {
      const rows = db.prepare(`
        SELECT id, stream, text, created_at
        FROM task_logs
        WHERE task_id = ?
        ORDER BY id DESC
        LIMIT ?
      `).all(safeId, MAX_LOG_ENTRIES_PER_TASK).reverse();
      if (rows.length > 0) {
        logs = rows.map((r) => ({ id: r.id, ts: r.created_at, stream: r.stream, text: r.text }));
      }
      const taskRow = db.prepare('SELECT state, owner_pid, cancel_requested_at FROM tasks WHERE task_id = ?').get(safeId);
      if (taskRow) {
        ownerPid = taskRow.owner_pid ?? ownerPid;
        ownerAlive = localActive || Boolean(taskRow.owner_pid && !TERMINAL_STATES.has(taskRow.state) && isProcessAlive(taskRow.owner_pid));
        cancelRequested = Boolean(taskRow.cancel_requested_at);
      }
    } catch { /* fallback to RAM bucket */ }
  }
  if (logs.length === 0) {
    const bucket = TASK_LOGS.get(safeId);
    logs = bucket ? bucket.entries.slice() : [];
  }
  return {
    task_id: safeId,
    active: localActive || ownerAlive,
    owner_pid: ownerPid,
    owner_alive: ownerAlive,
    cancel_requested: cancelRequested,
    logs,
  };
}

function isAckOnlyText(text) {
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

function killProcessTree(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    // Non-blocking tree kill on Windows to avoid stalling the HTTP/SSE event loop
    try {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true,
      });
      killer.unref();
    } catch { /* fallback below */ }
    try { child.kill(); } catch {}
    return;
  }
  // On POSIX, kill the entire detached process group so grandchild processes never leak
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

async function runMuseOperator(method, route, payloadWinPath = null) {
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

async function callClaudeWorkerClient(method, params) {
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

function classifyDshWait(result) {
  if (!result || typeof result !== 'object') return 'running';
  if (result.needs_input || ['needs_input', 'needs_resume', 'goal_stalled'].includes(result.state)) return 'needs_input';
  if (['failed', 'cancelled', 'interrupted'].includes(result.state)) return 'failed';
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

function extractDshText(result) {
  if (typeof result?.final_text === 'string' && result.final_text.trim()) return result.final_text.trim();
  if (Array.isArray(result?.rounds)) {
    return result.rounds.map((r) => r.final_text || r.summary || '').filter((s) => typeof s === 'string' && s.trim()).join('\n\n').trim();
  }
  return '';
}

function detectClaude429(receipt, err = null) {
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

/**
 * Column-whitelisted, terminal-guarded CAS task update.
 * Returns `{ task, changed }` so callers never emit bogus audit events when a concurrent
 * terminal transition already won the race.
 */
function updateTaskCas(db, taskId, fields, { allowTerminalOverwrite = false } = {}) {
  const keys = Object.keys(fields);
  for (const k of keys) {
    if (!ALLOWED_TASK_COLUMNS.has(k)) throw new Error(`Disallowed task column update: ${k}`);
  }
  const now = new Date().toISOString();
  const sets = [...keys.map((k) => `${k} = ?`), 'updated_at = ?'].join(', ');
  const vals = [...keys.map((k) => fields[k]), now, taskId];
  const guard = allowTerminalOverwrite ? '' : ` AND state NOT IN ('completed', 'failed', 'rerouted', 'cancelled')`;
  const res = db.prepare(`UPDATE tasks SET ${sets} WHERE task_id = ?${guard}`).run(...vals);
  return {
    changed: (res.changes || 0) > 0,
    task: parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId)),
  };
}

function updateTask(db, taskId, fields, opts = {}) {
  return updateTaskCas(db, taskId, fields, opts).task;
}

/**
 * Dispatch a new bounded background task to dsh, muse, or claude (CLI).
 * Strictly validates task_id, enforces policy roots (including WORKTREE_DIR), persists dispatching intent first,
 * and never resends an existing task.
 */
async function runGenericCliDriver(agent, { cwd, prompt, taskId = null, db = null }) {
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
        if (taskId) ACTIVE_RUNS.delete(taskId);
        fn(v);
      }
    };
    if (taskId) {
      appendTaskLog(taskId, 'system', `[start] ${command} (${agent.id}, pid=${child.pid || 'n/a'})`, db);
      ACTIVE_RUNS.set(taskId, {
        kind: 'generic-cli',
        pid: child.pid || null,
        async cancel(reason) {
          if (cancelled) return exitedPromise.then(() => childClosed);
          cancelled = true;
          cancelReason = reason || 'Cancelled by operator';
          killProcessTree(child);
          // Wait up to 2.5s for actual OS process exit/close so cancellation is truly confirmed!
          await Promise.race([exitedPromise, new Promise((r) => setTimeout(r, 2500))]);
          const exited = childClosed || child.exitCode !== null || child.signalCode !== null;
          if (exited) {
            finish(reject, Object.assign(new Error(cancelReason), { code: 'TASK_CANCELLED' }));
          }
          return exited;
        },
      });
      ensureCancelWatcher(db);
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
      if (taskId) appendTaskLog(taskId, 'stdout', s, db);
    });
    child.stderr.on('data', (c) => {
      const s = c.toString('utf8');
      if (stderr.length < 256 * 1024) stderr += s;
      if (taskId) appendTaskLog(taskId, 'stderr', s, db);
    });
    child.on('close', (code) => {
      childClosed = true;
      resolveExited?.();
      if (cancelled) {
        finish(reject, Object.assign(new Error(cancelReason || 'Cancelled by operator'), { code: 'TASK_CANCELLED' }));
      } else if (code === 0) {
        if (taskId) appendTaskLog(taskId, 'system', '[exit 0]', db);
        finish(resolve, { stdout: stdout.trim(), stderr: stderr.trim(), exitCode: 0 });
      } else {
        if (taskId) appendTaskLog(taskId, 'system', `[exit ${code}]`, db);
        finish(reject, Object.assign(new Error(`generic-cli exited ${code}: ${(stderr || stdout).slice(0, 400)}`), { code: `GENERIC_CLI_EXIT_${code}` }));
      }
    });
    try {
      if (useStdin) child.stdin.write(prompt);
      child.stdin.end();
    } catch {}
  });
}

async function runOpenAiHttpDriver(agent, { prompt, taskId = null, db = null }) {
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
    appendTaskLog(taskId, 'system', `[http] POST ${cfg.base_url}/chat/completions (model=${cfg.model})`, db);
    ACTIVE_RUNS.set(taskId, {
      kind: 'openai-http',
      async cancel(reason) {
        cancelled = true;
        controller.abort(new Error(reason || 'Cancelled by operator'));
        await Promise.race([settledPromise, new Promise((r) => setTimeout(r, 1500))]);
        return httpSettled;
      },
    });
    ensureCancelWatcher(db);
  }
  try {
    const signal = AbortSignal.any ? AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]) : controller.signal;
    const res = await fetch(`${cfg.base_url}/chat/completions`, {
      method: 'POST',
      headers,
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
    if (taskId) appendTaskLog(taskId, 'stdout', content.trim().slice(0, 2000), db);
    return { content: content.trim(), usage: data.usage || null, model: data.model || cfg.model, id: data.id || null };
  } catch (err) {
    if (cancelled) throw Object.assign(new Error('Cancelled by operator'), { code: 'TASK_CANCELLED' });
    throw err;
  } finally {
    httpSettled = true;
    resolveSettled?.();
    if (taskId) ACTIVE_RUNS.delete(taskId);
  }
}

export async function dispatchBackgroundTask(db, {
  taskId = null,
  batchId = null,
  parentTaskId = null,
  dependsOn = [],
  autoInjectContext = false,
  autoFallback = false,
  asyncRun = false,
  reservePaths = [],
  allowLeaseConflict = false,
  member,
  role = 'researcher',
  projectDir,
  title,
  prompt,
  worktreePath = null,
  branchName = null,
  mailMessageId = null,
  waitSec = 0,
}, deps = {}) {
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
  if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('prompt is required');

  // Pre-dispatch smart routing: supports member="auto" or autoFallback=true when target is offline/in-cooldown
  // Strictly pre-send only — never retries or resends an already-sent task!
  let routedFrom = null;
  if (member === 'auto') {
    const plan = planDispatch(db, { role, requireBackgroundAuto: true });
    if (!plan.recommended) {
      throw new Error(`Auto-routing found no online background agent for role="${role}" (skipped: ${plan.skipped.map((s) => `${s.member}:${s.reason}`).join(', ')})`);
    }
    routedFrom = 'auto';
    member = plan.recommended.member;
  } else {
    assertValidAgentId(member);
    if (autoFallback) {
      const candidate = getAgent(db, member);
      const stRow = db.prepare('SELECT * FROM member_status WHERE member = ?').get(member);
      const ch = candidate?.driver === 'claude-dual' ? 'claude-cli' : candidate?.driver;
      const cdActive = stRow?.cooldown_until && Date.parse(stRow.cooldown_until) > Date.now()
        && (!stRow.cooldown_channel || stRow.cooldown_channel === ch);
      const unavailable = !candidate || !candidate.enabled || cdActive || ['offline', 'dormant'].includes(stRow?.state);
      if (unavailable) {
        const plan = planDispatch(db, { role, exclude: [member], requireBackgroundAuto: true });
        if (plan.recommended) {
          routedFrom = `${member}(${cdActive ? 'cooldown' : (stRow?.state || 'unavailable')})`;
          member = plan.recommended.member;
        }
      }
    }
  }

  assertValidAgentId(member);
  const agent = getAgent(db, member);
  if (!agent || !agent.enabled) {
    throw new Error(`Agent "${member}" is not registered or is disabled. Register it via collab_agent_register first.`);
  }
  const bgDrivers = new Set(['dsh-baton', 'muse-tailnet', 'claude-dual', 'generic-cli', 'openai-http']);
  if (!bgDrivers.has(agent.driver)) {
    throw new Error(`Agent "${member}" uses driver "${agent.driver}". Send via native desktop bridge and call collab_record_handoff.`);
  }

  const safeTaskId = taskId
    ? assertValidTaskId(taskId, 'task_id')
    : `ch_${member}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  if (batchId) assertValidTaskId(batchId, 'batch_id');
  if (parentTaskId) assertValidTaskId(parentTaskId, 'parent_task_id');

  // DAG dependency gate: verify all dependsOn tasks exist and are completed!
  const depList = Array.isArray(dependsOn) ? dependsOn.map((d) => assertValidTaskId(d, 'depends_on')) : [];
  let effectivePrompt = prompt;
  if (depList.length > 0) {
    const depRows = depList.map((id) => ({ id, row: parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(id)) }));
    const blockers = depRows.filter((d) => !d.row || d.row.state !== 'completed');
    if (blockers.length > 0) {
      const desc = blockers.map((b) => `${b.id}(${b.row ? b.row.state : 'missing'})`).join(', ');
      throw new Error(`Dependency gate blocked dispatch for ${safeTaskId}: incomplete upstream tasks: ${desc}`);
    }
    if (autoInjectContext) {
      let injected = '';
      for (const { row: up } of depRows) {
        const snippet = String(up.result_text || '').slice(0, 2000);
        const block = `### Upstream [${up.task_id}] (${up.member}/${up.role}): ${up.title}\n${snippet}\n\n`;
        if (injected.length + block.length <= 12000) injected += block;
      }
      if (injected) {
        effectivePrompt = `[Upstream Verified Context]\n${injected}---\n[Current Task]\n${prompt}`;
      }
    }
  }

  if (Buffer.byteLength(effectivePrompt, 'utf8') > MAX_PROMPT_BYTES) {
    throw new Error(`prompt exceeds ${MAX_PROMPT_BYTES} byte limit`);
  }

  const policy = loadPolicy();
  const effectiveDir = worktreePath || projectDir;
  const extraRoots = deps.extraRoots ?? (member === 'claude' ? policy.claudeCliAllowedRoots : [policy.allowedWorktreeRoot || WORKTREE_DIR]);
  const resolvedDir = resolveProjectDir(effectiveDir, {
    requireSubdir: member === 'dsh',
    workspaceRoot: deps.workspaceRoot || policy.allowedWorkspaceRoot,
    extraRoots,
  });

  const channel = agent.driver === 'claude-dual' ? 'claude-cli' : agent.driver;
  const now = new Date().toISOString();

  // Check channel-scoped cooldown BEFORE inserting/sending (covers claude-cli and any rate-limited openai-http agent!)
  const st = db.prepare('SELECT * FROM member_status WHERE member = ?').get(member);
  const cdActive = st?.cooldown_until && Date.parse(st.cooldown_until) > Date.now();
  const cdApplies = cdActive && (!st.cooldown_channel || st.cooldown_channel === channel);
  if (cdApplies) {
    const rem = Math.ceil((Date.parse(st.cooldown_until) - Date.now()) / 1000);
    throw new Error(`${member} [${channel}] is in 429 cooldown (${rem}s remaining: ${st.cooldown_reason || 'quota'}). Reroute to another online member or clear cooldown explicitly.`);
  }

  const payloadHash = sha256Hex(JSON.stringify({ member, role, cwd: resolvedDir.windows, prompt: effectivePrompt }));
  const dispatchToken = randomUUID();
  const metaObj = {};
  if (routedFrom) metaObj.routed_from = routedFrom;
  const initialMeta = Object.keys(metaObj).length ? JSON.stringify(metaObj) : null;

  // Atomic task-id claim FIRST (PRIMARY KEY enforces single winner BEFORE any external Mail/bridge side effect!)
  try {
    db.prepare(`
      INSERT INTO tasks (task_id, batch_id, parent_task_id, depends_on_json, project_dir, member, role, channel, title, prompt, state, payload_sha256, worktree_path, branch_name, mail_message_id, meta_json, dispatch_token, attempted_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'dispatching', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      safeTaskId, batchId, parentTaskId, depList.length ? JSON.stringify(depList) : null, resolvedDir.windows, member, role, channel,
      title || `${member}:${role}`, effectivePrompt, payloadHash, worktreePath, branchName,
      mailMessageId, initialMeta, dispatchToken, now, now, now,
    );
  } catch (err) {
    const existing = db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(safeTaskId);
    if (existing) {
      throw new Error(`Task ${safeTaskId} already exists in state=${existing.state}. Never blindly resend; use collab_poll or collab_task_reconcile.`);
    }
    throw err;
  }

  // Optional advisory file reservation via mcp-agent-mail AFTER atomic claim so duplicate requests cannot double-reserve
  let leaseInfo = null;
  if (Array.isArray(reservePaths) && reservePaths.length > 0) {
    try {
      const reserveFn = deps.reserveMailPaths || reserveMailPaths;
      leaseInfo = await reserveFn({
        projectDir: resolvedDir.windows,
        member,
        paths: reservePaths,
        reason: `CollabHub task ${safeTaskId}`,
      });
      if (leaseInfo?.has_conflicts && !allowLeaseConflict) {
        db.prepare('DELETE FROM tasks WHERE task_id = ? AND dispatch_token = ?').run(safeTaskId, dispatchToken);
        throw new Error(`File reservation conflict in mcp-agent-mail for ${safeTaskId}: ${JSON.stringify(leaseInfo.conflicts)}`);
      }
      metaObj.mail_lease = leaseInfo;
      db.prepare('UPDATE tasks SET meta_json = ?, updated_at = ? WHERE task_id = ? AND dispatch_token = ? AND state = ?')
        .run(JSON.stringify(metaObj), new Date().toISOString(), safeTaskId, dispatchToken, 'dispatching');
    } catch (leaseErr) {
      try { db.prepare('DELETE FROM tasks WHERE task_id = ? AND dispatch_token = ?').run(safeTaskId, dispatchToken); } catch {}
      throw leaseErr;
    }
  }

  // Atomic dispatch-ownership verification right before calling ANY external bridge/agent:
  // if the task was cancelled, failed, or reconciled while awaiting a Mail reservation, release lease & abort send!
  const stillOwned = db.prepare(`
    SELECT task_id FROM tasks
    WHERE task_id = ? AND dispatch_token = ? AND state = 'dispatching'
  `).get(safeTaskId, dispatchToken);
  if (!stillOwned) {
    if (leaseInfo?.synced && Array.isArray(reservePaths) && reservePaths.length > 0) {
      try { await (deps.releaseMailPaths || releaseMailPaths)({ projectDir: resolvedDir.windows, member, paths: reservePaths }); } catch {}
    }
    return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
  }

  logEvent(db, { taskId: safeTaskId, eventType: 'task.dispatching', actor: member, payload: { role, channel, projectDir: resolvedDir.windows, dispatchToken, dependsOn: depList } });

  const executeRemoteOrLocal = async () => {
  try {
    if (member === 'dsh') {
      const baton = deps.callBaton || callBatonTool;
      const sendRes = await baton('dsh_send', {
        cwd: resolvedDir.windows,
        message: effectivePrompt,
      }, { timeoutMs: 75000 });
      const runId = sendRes?.run_id || sendRes?.data?.run_id;
      const sessionId = sendRes?.session_id || sendRes?.data?.session_id || null;
      if (!runId) {
        updateTask(db, safeTaskId, { state: 'uncertain', error_code: 'DSH_NO_RUN_ID', error_message: 'dsh_send returned without run_id; inspect DSH sessions and call collab_task_reconcile' });
        return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
      }
      updateTask(db, safeTaskId, { state: 'running', external_id: runId, session_id: sessionId, error_code: null, error_message: null });
      logEvent(db, { taskId: safeTaskId, eventType: 'task.dispatched', actor: 'dsh', payload: { runId, sessionId } });
      if (waitSec > 0) return await pollBackgroundTask(db, safeTaskId, { waitSec }, deps);
      return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
    }

    if (member === 'muse') {
      const museOp = deps.runMuseOperator || runMuseOperator;
      const mapRoute = `/mappings/${encodeURIComponent(safeTaskId)}`;
      const mapCheck = await museOp('GET', mapRoute);
      if (!(mapCheck.ok === false && mapCheck.http_status === 404 && mapCheck.result?.error === 'mapping_not_found')) {
        updateTask(db, safeTaskId, {
          state: 'uncertain',
          external_id: mapCheck.result?.request_id || null,
          error_code: 'MUSE_MAPPING_EXISTS',
          error_message: 'Mapping already exists or inspection failed; never duplicate publish',
        });
        return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
      }

      const envelope = {
        task_id: safeTaskId,
        actor_id: 'muse',
        role,
        sender: 'workswarm',
        goal: title || 'Bounded Muse collaboration task',
        scope: effectivePrompt,
        deliverable: 'Task-scoped final result with source evidence; no approvals or account operations',
        acceptance: 'Return exact task_id, actor_id, role, status=completed, result, evidence, blockers; ACK is not completion',
        workflow_run_id: batchId || safeTaskId,
        call_key: safeTaskId,
        workbench_node_id: safeTaskId,
        depends_on: depList.length ? depList : (parentTaskId ? [parentTaskId] : []),
      };
      const envDigest = sha256Hex(canonicalGoJson(envelope));
      const payloadDir = path.resolve(deps.payloadDir || PAYLOAD_DIR);
      fs.mkdirSync(payloadDir, { recursive: true });
      const payloadFile = path.resolve(payloadDir, `muse-${safeTaskId}.json`);
      if (!payloadFile.startsWith(payloadDir + path.sep)) {
        throw new Error('Muse payload path escaped payload directory');
      }
      fs.writeFileSync(payloadFile, canonicalGoJson({ task_id: safeTaskId, envelope }), { flag: 'wx', encoding: 'utf8' });

      let pubRes;
      try {
        pubRes = await museOp('POST', '/publish', payloadFile);
      } finally {
        // Clean up temporary plaintext payload after publish attempt
        try { fs.unlinkSync(payloadFile); } catch {}
      }

      const reqId = pubRes?.result?.request_id || null;
      if (pubRes?.ok !== true || !reqId) {
        updateTask(db, safeTaskId, {
          state: 'uncertain',
          external_id: reqId,
          payload_sha256: envDigest,
          meta_json: JSON.stringify({ envelope }),
          error_code: 'MUSE_PUBLISH_UNCERTAIN',
          error_message: `Publish returned http_status=${pubRes?.http_status}; call collab_poll to reconcile mapping`,
        });
        return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
      }

      updateTask(db, safeTaskId, {
        state: 'running',
        external_id: reqId,
        payload_sha256: envDigest,
        meta_json: JSON.stringify({ envelope }),
        error_code: null,
        error_message: null,
      });
      logEvent(db, { taskId: safeTaskId, eventType: 'task.dispatched', actor: 'muse', payload: { requestId: reqId } });
      if (waitSec > 0) return await pollBackgroundTask(db, safeTaskId, { waitSec }, deps);
      return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
    }

    if (member === 'claude') {
      const claudeClient = deps.callClaudeWorker || callClaudeWorkerClient;
      const workerReqId = uuidv5Url(`collab-hub-claude-cli:${safeTaskId}`);

      let canSend = false;
      try {
        const existingReceipt = await claudeClient('read', { requestId: workerReqId, waitSec: 0 });
        updateTask(db, safeTaskId, {
          state: existingReceipt.status === 'completed' ? 'completed' : 'uncertain',
          external_id: workerReqId,
          session_id: existingReceipt.sessionId || null,
          error_code: 'WORKER_RECEIPT_ALREADY_EXISTS',
          error_message: 'Worker receipt already existed; did not duplicate send',
        });
        return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
      } catch (err) {
        if (err.code === 'WORKER_RECEIPT_NOT_FOUND') canSend = true;
        else throw err;
      }

      if (!canSend) throw new Error('Unexpected Claude worker preflight state');
      const receipt = await claudeClient('send', {
        agent: 'claude',
        cwd: resolvedDir.windows,
        requestId: workerReqId,
        prompt: effectivePrompt,
      });

      const q429 = detectClaude429(receipt);
      if (q429.is429) {
        setMemberCooldown(db, 'claude', policy.claudeCooldownSeconds, `Upstream 429/quota on ${safeTaskId}: ${q429.detail}`, 'claude-cli');
        updateTask(db, safeTaskId, {
          state: 'failed',
          external_id: workerReqId,
          session_id: receipt?.sessionId || null,
          error_code: 'CLAUDE_UPSTREAM_429',
          error_message: q429.detail,
        });
        return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
      }

      updateTask(db, safeTaskId, {
        state: 'running',
        external_id: workerReqId,
        session_id: receipt?.sessionId || null,
        error_code: null,
        error_message: null,
      });
      logEvent(db, { taskId: safeTaskId, eventType: 'task.dispatched', actor: 'claude', payload: { workerReqId } });
      if (waitSec > 0) return await pollBackgroundTask(db, safeTaskId, { waitSec }, deps);
      return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
    }

    if (agent.driver === 'generic-cli') {
      const cliRunner = deps.runGenericCli || runGenericCliDriver;
      const ownerToken = randomUUID();
      updateTask(db, safeTaskId, {
        state: 'running',
        external_id: `cli-${dispatchToken.slice(0, 12)}`,
        owner_pid: process.pid,
        owner_token: ownerToken,
      });
      const executeCli = async () => {
        try {
          const out = await cliRunner(agent, { cwd: resolvedDir.windows, prompt: effectivePrompt, taskId: safeTaskId, db });
          const { task: updated, changed } = updateTaskCas(db, safeTaskId, {
            state: 'completed',
            external_id: `cli-${dispatchToken.slice(0, 12)}`,
            result_text: out.stdout || '(completed with empty stdout)',
            evidence_json: JSON.stringify({ command: agent.config.command, exitCode: out.exitCode }),
            error_code: null,
            error_message: null,
            completed_at: new Date().toISOString(),
          });
          if (changed && updated?.state === 'completed') {
            logEvent(db, { taskId: safeTaskId, eventType: 'task.completed', actor: member, payload: { driver: 'generic-cli' } });
          }
          return updated;
        } catch (err) {
          const msg = String(err.message || err);
          const code = err.code || 'DISPATCH_ERROR';
          if (code === 'TASK_CANCELLED') {
            const { task: cTask, changed } = updateTaskCas(db, safeTaskId, {
              state: 'cancelled',
              error_code: 'TASK_CANCELLED',
              error_message: msg,
              completed_at: new Date().toISOString(),
            });
            if (changed) {
              appendTaskLog(safeTaskId, 'system', `[cancelled] ${msg}`, db);
              logEvent(db, { taskId: safeTaskId, eventType: 'task.cancelled', actor: member, payload: { reason: msg, aborted_live_process: true } });
            }
            return cTask;
          }
          const { task: fTask, changed } = updateTaskCas(db, safeTaskId, {
            state: 'failed',
            error_code: code,
            error_message: msg,
            completed_at: new Date().toISOString(),
          });
          if (changed) logEvent(db, { taskId: safeTaskId, eventType: 'task.error', actor: member, payload: { code, message: msg } });
          return fTask;
        } finally {
          if (leaseInfo?.synced) {
            await (deps.releaseMailPaths || releaseMailPaths)({ projectDir: resolvedDir.windows, member, paths: reservePaths }).catch(() => {});
          }
        }
      };
      if (asyncRun) {
        trackBackgroundPromise(executeCli());
        return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
      }
      return await executeCli();
    }

    if (agent.driver === 'openai-http') {
      const httpRunner = deps.runOpenAiHttp || runOpenAiHttpDriver;
      const ownerToken = randomUUID();
      updateTask(db, safeTaskId, {
        state: 'running',
        external_id: `http-${dispatchToken.slice(0, 12)}`,
        owner_pid: process.pid,
        owner_token: ownerToken,
      });
      const executeHttp = async () => {
        try {
          const out = await httpRunner(agent, { prompt: effectivePrompt, taskId: safeTaskId, db });
          const { task: updated, changed } = updateTaskCas(db, safeTaskId, {
            state: 'completed',
            external_id: out.id || `http-${dispatchToken.slice(0, 12)}`,
            result_text: out.content,
            evidence_json: JSON.stringify({ model: out.model, usage: out.usage }),
            error_code: null,
            error_message: null,
            completed_at: new Date().toISOString(),
          });
          if (changed && updated?.state === 'completed') {
            logEvent(db, { taskId: safeTaskId, eventType: 'task.completed', actor: member, payload: { driver: 'openai-http', model: out.model } });
          }
          return updated;
        } catch (err) {
          const msg = String(err.message || err);
          const code = err.code || 'DISPATCH_ERROR';
          if (code === 'TASK_CANCELLED') {
            const { task: cTask, changed } = updateTaskCas(db, safeTaskId, {
              state: 'cancelled',
              error_code: 'TASK_CANCELLED',
              error_message: msg,
              completed_at: new Date().toISOString(),
            });
            if (changed) {
              appendTaskLog(safeTaskId, 'system', `[cancelled] ${msg}`, db);
              logEvent(db, { taskId: safeTaskId, eventType: 'task.cancelled', actor: member, payload: { reason: msg, aborted_live_process: true } });
            }
            return cTask;
          }
          const q429 = detectClaude429(null, err);
          if (q429.is429) {
            setMemberCooldown(db, member, policy.claudeCooldownSeconds, `Upstream 429/quota on ${safeTaskId}: ${q429.detail}`, channel);
          }
          const { task: fTask, changed } = updateTaskCas(db, safeTaskId, {
            state: 'failed',
            error_code: code,
            error_message: msg,
            completed_at: new Date().toISOString(),
          });
          if (changed) logEvent(db, { taskId: safeTaskId, eventType: 'task.error', actor: member, payload: { code, message: msg } });
          return fTask;
        } finally {
          if (leaseInfo?.synced) {
            await (deps.releaseMailPaths || releaseMailPaths)({ projectDir: resolvedDir.windows, member, paths: reservePaths }).catch(() => {});
          }
        }
      };
      if (asyncRun) {
        trackBackgroundPromise(executeHttp());
        return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
      }
      return await executeHttp();
    }
  } catch (err) {
    const msg = String(err.message || err);
    const code = err.code || 'DISPATCH_ERROR';
    const current = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
    if (code === 'TASK_CANCELLED' || current?.state === 'cancelled') {
      return current?.state === 'cancelled'
        ? current
        : updateTask(db, safeTaskId, { state: 'cancelled', error_code: 'TASK_CANCELLED', error_message: msg, completed_at: new Date().toISOString() });
    }
    if (member === 'claude' || agent.driver === 'openai-http') {
      const q429 = detectClaude429(null, err);
      if (q429.is429) {
        setMemberCooldown(db, member, policy.claudeCooldownSeconds, `Upstream 429/quota on ${safeTaskId}: ${q429.detail}`, channel);
      }
    }
    const uncertainCodes = new Set(['BATON_TIMEOUT_UNCERTAIN', 'BATON_WRITE_UNCERTAIN', 'MUSE_OPERATOR_UNCERTAIN', 'WORKER_CLIENT_TIMEOUT_UNKNOWN', 'EPIPE']);
    const isUncertain = uncertainCodes.has(code) || /timeout|uncertain|unknown|epipe/i.test(`${code} ${msg}`);
    updateTask(db, safeTaskId, {
      state: isUncertain ? 'uncertain' : 'failed',
      error_code: code,
      error_message: msg,
    });
    logEvent(db, { taskId: safeTaskId, eventType: 'task.error', actor: member, payload: { code, message: msg } });
    return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
  }
  };

  // True non-blocking HTTP 202 asyncRun for remote bridges (dsh/muse/claude) too!
  if (asyncRun && !['generic-cli', 'openai-http'].includes(agent.driver)) {
    trackBackgroundPromise(executeRemoteOrLocal());
    return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
  }
  return await executeRemoteOrLocal();
}

/**
 * Cancel an active background task with cross-process signal coordination and strict stop confirmation:
 * 1) Local owner (`ACTIVE_RUNS`): kills process group / aborts HTTP and awaits process exit.
 * 2) Cross-process live owner (`owner_pid` alive): writes SQLite `cancel_requested_at` and waits up to 3.5s
 *    for the owning process watcher to stop the child and confirm terminal `cancelled`.
 * 3) Dead owner (`owner_pid` dead): confirms runner crashed (`orphan_confirmed: true`) and marks cancelled.
 * 4) DSH upstream: calls `dsh_cancel(run_id)` and refuses to mark cancelled when `still_busy: true` unless `force: true`.
 */
export async function cancelTask(db, taskId, { reason = 'Cancelled by operator', force = false } = {}, deps = {}) {
  const safeTaskId = assertValidTaskId(taskId, 'task_id');
  const existing = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
  if (!existing) throw new Error(`Task not found: ${safeTaskId}`);
  if (TERMINAL_STATES.has(existing.state)) {
    throw new Error(`Task ${safeTaskId} is already in terminal state=${existing.state}; cannot cancel.`);
  }

  let abortedLiveProcess = false;
  let crossProcess = false;
  let orphanConfirmed = false;
  let upstreamCancel = null;
  let stopConfirmed = false;

  const active = ACTIVE_RUNS.get(safeTaskId);
  if (active && typeof active.cancel === 'function') {
    abortedLiveProcess = true;
    try {
      const stopped = await active.cancel(reason);
      stopConfirmed = stopped === true;
    } catch {
      stopConfirmed = false;
    }
    if (stopConfirmed) {
      ACTIVE_RUNS.delete(safeTaskId);
    } else if (!force) {
      const { task: uncTask } = updateTaskCas(db, safeTaskId, {
        state: 'uncertain',
        cancel_requested_at: new Date().toISOString(),
        cancel_reason: String(reason || 'Cancel signal unconfirmed').slice(0, 500),
        error_code: 'CANCEL_UNCONFIRMED',
        error_message: 'Termination signal sent, but runner/process exit was not confirmed within timeout; inspect before retrying.',
      });
      return {
        task: uncTask,
        cancelled: false,
        cancel_requested: true,
        uncertain: true,
        aborted_live_process: true,
        message: 'Termination signal sent, but process exit was not confirmed; task marked uncertain to block blind retry.',
      };
    }
  } else if (existing.owner_pid && existing.owner_pid !== process.pid && ['generic-cli', 'openai-http'].includes(existing.channel)) {
    if (!isProcessAlive(existing.owner_pid)) {
      orphanConfirmed = true;
      if (!force) {
        const { task: uncTask } = updateTaskCas(db, safeTaskId, {
          state: 'uncertain',
          cancel_requested_at: new Date().toISOString(),
          cancel_reason: String(reason || 'Owner process dead').slice(0, 500),
          error_code: 'OWNER_PROCESS_DEAD',
          error_message: `Owning process pid=${existing.owner_pid} exited unexpectedly; marked uncertain to prevent blind retry without inspection.`,
        });
        return {
          task: uncTask,
          cancelled: false,
          uncertain: true,
          orphan_confirmed: true,
          message: `Owner pid=${existing.owner_pid} is dead; marked uncertain (inspect or pass force=true to mark cancelled).`,
        };
      }
      stopConfirmed = true;
    } else {
      crossProcess = true;
      updateTaskCas(db, safeTaskId, {
        cancel_requested_at: new Date().toISOString(),
        cancel_reason: String(reason || 'Cancelled via cross-process signal').slice(0, 500),
      });
      const deadline = Date.now() + 3500;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 150));
        const cur = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
        if (cur?.state === 'cancelled') {
          return {
            task: cur,
            cancelled: true,
            cross_process: true,
            aborted_live_process: true,
            forced: false,
          };
        }
        if (cur && TERMINAL_STATES.has(cur.state)) {
          return { task: cur, cancelled: false, already_terminal: true, cross_process: true };
        }
      }
      if (!force) {
        const cur = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
        return {
          task: cur,
          cancelled: false,
          cancel_requested: true,
          cross_process: true,
          aborted_live_process: false,
          message: `Cross-process cancel signal recorded for owner pid=${existing.owner_pid}; waiting for runner confirmation.`,
        };
      }
    }
  } else if (existing.member === 'dsh' && existing.external_id) {
    const baton = deps.callBaton || callBatonTool;
    try {
      upstreamCancel = await baton('dsh_cancel', { run_id: existing.external_id }, { timeoutMs: 10000 });
      stopConfirmed = Boolean(upstreamCancel && upstreamCancel.ok !== false && !upstreamCancel.error && upstreamCancel.still_busy !== true);
      if (upstreamCancel?.still_busy === true || upstreamCancel?.ok === false) {
        updateTaskCas(db, safeTaskId, {
          cancel_requested_at: new Date().toISOString(),
          cancel_reason: String(reason || 'DSH cancel requested').slice(0, 500),
        });
      }
    } catch (e) {
      upstreamCancel = { error: String(e?.message || e) };
      stopConfirmed = false;
    }
  }

  if (!stopConfirmed && !force) {
    const why = upstreamCancel?.still_busy === true
      ? 'DSH session reported still_busy=true (cancel_requested recorded; poll until stopped)'
      : (upstreamCancel?.ok === false
        ? `DSH cancel returned ok=false (${upstreamCancel.reason || upstreamCancel.message || 'unconfirmed'})`
        : (upstreamCancel?.error
          ? `upstream cancel failed (${upstreamCancel.error})`
          : `no live abort handle in this process for channel=${existing.channel}`));
    throw new Error(`Cannot confirm cancellation of ${safeTaskId}: ${why}. Cancel from the owning process or pass force=true after verifying the run stopped.`);
  }

  const { task: updated, changed } = updateTaskCas(db, safeTaskId, {
    state: 'cancelled',
    error_code: 'TASK_CANCELLED',
    error_message: String(reason || 'Cancelled by operator').slice(0, 500),
    completed_at: new Date().toISOString(),
  });
  if (!changed && updated?.state !== 'cancelled') {
    return {
      task: updated,
      cancelled: false,
      already_terminal: true,
      aborted_live_process: abortedLiveProcess,
      upstream_cancel: upstreamCancel,
    };
  }

  if (changed) {
    appendTaskLog(safeTaskId, 'system', `[cancelled] ${reason}`, db);
    logEvent(db, {
      taskId: safeTaskId,
      eventType: 'task.cancelled',
      actor: 'coordinator',
      payload: {
        member: existing.member,
        reason,
        aborted_live_process: abortedLiveProcess,
        orphan_confirmed: orphanConfirmed,
        forced: Boolean(force && !stopConfirmed),
      },
    });
  }
  return {
    task: updated,
    cancelled: true,
    aborted_live_process: abortedLiveProcess,
    orphan_confirmed: orphanConfirmed,
    cross_process: crossProcess,
    forced: Boolean(force && !stopConfirmed),
    upstream_cancel: upstreamCancel,
  };
}

/**
 * Self-healing orphan sweeper: detects local CLI/HTTP tasks stuck in `dispatching`/`running`
 * whose recorded `owner_pid` is dead and transitions them cleanly to `failed` (`OWNER_PROCESS_DEAD`).
 */
export function sweepOrphanTasks(db) {
  const candidates = db.prepare(`
    SELECT task_id, member, channel, owner_pid
    FROM tasks
    WHERE state IN ('dispatching', 'running')
      AND owner_pid IS NOT NULL
      AND channel IN ('generic-cli', 'openai-http')
  `).all();
  const recovered = [];
  for (const row of candidates) {
    if (row.owner_pid === process.pid && ACTIVE_RUNS.has(row.task_id)) continue;
    if (isProcessAlive(row.owner_pid)) continue;
    const { task, changed } = updateTaskCas(db, row.task_id, {
      state: 'uncertain',
      error_code: 'OWNER_PROCESS_DEAD',
      error_message: `Owning runner process (pid=${row.owner_pid}) exited unexpectedly; marked uncertain so workflow resume will not blindly resend.`,
    });
    if (changed && task) {
      appendTaskLog(row.task_id, 'system', `[orphan-recovery] owner pid=${row.owner_pid} is dead; marked uncertain (inspect before retry)`, db);
      logEvent(db, { taskId: row.task_id, eventType: 'task.orphan_recovered', actor: row.member, payload: { owner_pid: row.owner_pid, state: 'uncertain' } });
      recovered.push(row.task_id);
    }
  }
  return { checked: candidates.length, recovered };
}

/**
 * Poll/wait for an existing background task without EVER re-sending.
 * Includes crash self-healing for Muse (/mappings/<taskId>) and Claude CLI (deterministic uuidv5).
 */
export async function pollBackgroundTask(db, taskId, { waitSec = 15 } = {}, deps = {}) {
  const safeTaskId = assertValidTaskId(taskId, 'task_id');
  let row = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
  if (!row) throw new Error(`Task not found: ${safeTaskId}`);
  if (TERMINAL_STATES.has(row.state)) return row;
  if (row.channel === 'desktop-native') return row;

  const clampedWait = Math.max(0, Math.min(60, Number(waitSec) || 0));

  if (row.member === 'dsh') {
    if (!row.external_id) {
      return updateTask(db, safeTaskId, {
        state: 'uncertain',
        error_code: 'DSH_RECONCILE_REQUIRED',
        error_message: 'Missing DSH run_id (possible crash during dispatch). Inspect dsh_list_sessions and attach via collab_task_reconcile.',
      });
    }
    const baton = deps.callBaton || callBatonTool;
    const res = clampedWait > 0
      ? await baton('dsh_wait', { run_id: row.external_id, timeout_s: clampedWait }, { timeoutMs: (clampedWait + 20) * 1000 })
      : await baton('dsh_status', { run_id: row.external_id }, { timeoutMs: 25000 });
    const nextState = classifyDshWait(res);
    const text = extractDshText(res);
    const prevMeta = row.meta || {};
    const downCount = res?.harness_down ? Number(prevMeta.harness_down_count || 0) + 1 : 0;
    const patch = {
      state: downCount >= 3 ? 'stalled' : nextState,
      session_id: res?.session_id || row.session_id,
      meta_json: JSON.stringify({ ...prevMeta, harness_down_count: downCount }),
    };
    if (downCount >= 3) {
      patch.error_code = 'DSH_HARNESS_DOWN';
      patch.error_message = `DSH harness reported down ${downCount} consecutive times; inspect dsh-web.service before retrying`;
    } else if (nextState === 'completed') {
      patch.result_text = text || JSON.stringify(res);
      patch.completed_at = new Date().toISOString();
      patch.error_code = null;
      patch.error_message = null;
      patch.evidence_json = JSON.stringify({ run_id: row.external_id, session_id: patch.session_id, state: res?.state });
    } else if (nextState === 'failed') {
      patch.error_code = 'DSH_RUN_FAILED';
      patch.error_message = res?.error || res?.summary || 'DSH run failed';
    } else if (nextState === 'needs_input') {
      patch.error_code = 'DSH_NEEDS_INPUT';
      patch.error_message = res?.needs_input_reason || res?.summary || 'DSH requires input';
    }
    const { task: updated, changed } = updateTaskCas(db, safeTaskId, patch);
    if (changed && updated.state !== row.state) {
      logEvent(db, { taskId: safeTaskId, eventType: `task.${updated.state}`, actor: 'dsh', payload: { runId: row.external_id } });
    }
    return updated;
  }

  if (row.member === 'muse') {
    const museOp = deps.runMuseOperator || runMuseOperator;

    // Self-healing crash recovery: if external_id wasn't saved before crash, inspect /mappings/<taskId>
    if (!row.external_id) {
      const mapRes = await museOp('GET', `/mappings/${encodeURIComponent(safeTaskId)}`);
      if (mapRes?.ok === true && mapRes.result?.request_id) {
        row = updateTask(db, safeTaskId, { state: 'running', external_id: mapRes.result.request_id, error_code: null, error_message: null });
      } else {
        return updateTask(db, safeTaskId, {
          state: 'uncertain',
          error_code: 'MUSE_MAPPING_UNRECOVERED',
          error_message: 'No mapped request_id found yet; inspect publisher mapping before retrying',
        });
      }
    }

    const deadline = Date.now() + clampedWait * 1000;
    while (true) {
      const resp = await museOp('GET', `/tasks/${encodeURIComponent(safeTaskId)}`);
      if (resp?.ok === true && resp.http_status === 200) {
        const data = resp.result || {};
        const upstream = data.upstream || {};
        const reqObj = upstream.request || {};

        // Strict outer request/task identity binding
        const expectedReqId = row.external_id;
        if (data.task_id !== safeTaskId || data.request_id !== expectedReqId
            || (reqObj.id && reqObj.id !== expectedReqId)
            || (reqObj.from && reqObj.from !== 'workswarm')
            || (reqObj.to && reqObj.to !== 'muse')) {
          return updateTask(db, safeTaskId, {
            state: 'uncertain',
            error_code: 'MUSE_IDENTITY_MISMATCH',
            error_message: `Muse upstream task/request identity mismatch (expected ${safeTaskId}/${expectedReqId})`,
          });
        }

        const status = upstream.status || data.state || 'running';
        if (status === 'answered' && upstream.reply) {
          const reply = upstream.reply;
          const gen = Number(reply.generation || 0);
          const prevGen = Number(row.reply_generation || 0);
          if (reply.request_id !== expectedReqId || reply.from !== 'muse') {
            return updateTask(db, safeTaskId, {
              state: 'uncertain',
              error_code: 'MUSE_REPLY_IDENTITY_MISMATCH',
              error_message: 'Muse reply from/request_id did not match original request',
            });
          }
          if (gen > prevGen && reply.status === 'answered' && !reply.kept_open) {
            let inner = null;
            try { inner = JSON.parse(reply.body || ''); } catch { inner = null; }
            if (!inner || typeof inner !== 'object') {
              return updateTask(db, safeTaskId, {
                state: 'uncertain',
                reply_generation: gen,
                error_code: 'MUSE_REPLY_NON_JSON',
                error_message: 'Muse answered reply body was not valid JSON',
              });
            }
            if (inner.task_id !== safeTaskId || inner.actor_id !== 'muse' || (inner.role && inner.role !== row.role)) {
              return updateTask(db, safeTaskId, {
                state: 'uncertain',
                reply_generation: gen,
                error_code: 'MUSE_INNER_IDENTITY_MISMATCH',
                error_message: 'Muse inner task_id/actor_id/role mismatch',
              });
            }
            const blockers = Array.isArray(inner.blockers) ? inner.blockers : [];
            const pendingCount = Number(inner.pending_request_count || 0);
            if (blockers.length > 0 || pendingCount > 0 || inner.status === 'needs_input') {
              return updateTask(db, safeTaskId, {
                state: 'needs_input',
                reply_generation: gen,
                error_code: 'MUSE_NEEDS_INPUT',
                error_message: blockers.join('; ') || `Muse pending_request_count=${pendingCount}`,
              });
            }
            if (inner.status === 'failed') {
              return updateTask(db, safeTaskId, {
                state: 'failed',
                reply_generation: gen,
                error_code: 'MUSE_INNER_FAILED',
                error_message: String(inner.result || 'Muse reported failed'),
              });
            }
            if (inner.status === 'completed' && typeof inner.result === 'string' && !isAckOnlyText(inner.result)) {
              const updated = updateTask(db, safeTaskId, {
                state: 'completed',
                reply_generation: gen,
                result_text: inner.result.trim(),
                evidence_json: JSON.stringify(Array.isArray(inner.evidence) ? inner.evidence : []),
                error_code: null,
                error_message: null,
                completed_at: new Date().toISOString(),
              });
              logEvent(db, { taskId: safeTaskId, eventType: 'task.completed', actor: 'muse', payload: { requestId: expectedReqId, generation: gen } });
              return updated;
            }
          }
        } else if (status === 'needs_input') {
          return updateTask(db, safeTaskId, {
            state: 'needs_input',
            error_code: 'MUSE_NEEDS_INPUT',
            error_message: 'Muse task is awaiting bounded input (use muse-tools review flow)',
          });
        } else if (['failed', 'declined', 'cancelled', 'expired'].includes(status)) {
          return updateTask(db, safeTaskId, {
            state: 'failed',
            error_code: `MUSE_${status.toUpperCase()}`,
            error_message: `Muse task ended with status=${status}`,
          });
        } else if (upstream.relay_note && typeof upstream.relay_note.note === 'string' && upstream.relay_note.note.trim()) {
          // Surface claim-lease expiry / requeue stall explicitly instead of silently reporting 'running' forever!
          const prevMeta = row.meta || {};
          const updated = updateTask(db, safeTaskId, {
            state: 'stalled',
            error_code: 'MUSE_LEASE_EXPIRED_REQUEUED',
            error_message: upstream.relay_note.note.trim(),
            meta_json: JSON.stringify({ ...prevMeta, relay_note: upstream.relay_note }),
          });
          if (row.state !== 'stalled') {
            logEvent(db, { taskId: safeTaskId, eventType: 'task.stalled', actor: 'muse', payload: upstream.relay_note });
          }
          return updated;
        }
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
  }

  if (row.member === 'claude') {
    const claudeClient = deps.callClaudeWorker || callClaudeWorkerClient;
    // Crash self-healing: deterministic UUIDv5 allows receipt lookup even if external_id wasn't persisted yet!
    const workerReqId = row.external_id || uuidv5Url(`collab-hub-claude-cli:${safeTaskId}`);
    if (!row.external_id) {
      row = updateTask(db, safeTaskId, { external_id: workerReqId });
    }

    try {
      const receipt = await claudeClient('read', { requestId: workerReqId, waitSec: clampedWait });
      if (receipt?.requestId && receipt.requestId !== workerReqId) {
        return updateTask(db, safeTaskId, {
          state: 'uncertain',
          error_code: 'WORKER_RECEIPT_IDENTITY_MISMATCH',
          error_message: `Expected worker requestId ${workerReqId}, got ${receipt.requestId}`,
        });
      }
      if ((receipt?.agent && receipt.agent !== 'claude') || (receipt?.surface && receipt.surface !== 'background-cli')) {
        return updateTask(db, safeTaskId, {
          state: 'uncertain',
          error_code: 'WORKER_RECEIPT_SURFACE_MISMATCH',
          error_message: 'Claude worker receipt agent/surface mismatch',
        });
      }

      const status = receipt?.status || 'running';
      const q429 = detectClaude429(receipt);
      if (status === 'failed' || q429.is429) {
        if (q429.is429) {
          const policy = loadPolicy();
          setMemberCooldown(db, 'claude', policy.claudeCooldownSeconds, `Upstream 429/quota on ${safeTaskId}: ${q429.detail}`, 'claude-cli');
        }
        return updateTask(db, safeTaskId, {
          state: 'failed',
          session_id: receipt?.sessionId || row.session_id,
          error_code: q429.is429 ? 'CLAUDE_UPSTREAM_429' : (receipt?.diagnostic?.code || receipt?.error?.code || 'CLAUDE_WORKER_FAILED'),
          error_message: q429.detail || 'Claude background worker failed',
        });
      }
      if (status === 'completed') {
        if (receipt.deliveryState !== 'sent' || !receipt.sessionId || !String(receipt.output || '').trim() || receipt.outputTruncated !== false) {
          return updateTask(db, safeTaskId, {
            state: 'uncertain',
            session_id: receipt?.sessionId || row.session_id,
            error_code: 'WORKER_COMPLETION_UNPROVED',
            error_message: 'Completed status lacked verified non-empty non-truncated output',
          });
        }
        const updated = updateTask(db, safeTaskId, {
          state: 'completed',
          session_id: receipt.sessionId,
          result_text: receipt.output.trim(),
          evidence_json: JSON.stringify({ workerId: receipt.workerId, sessionId: receipt.sessionId, surface: receipt.surface }),
          error_code: null,
          error_message: null,
          completed_at: new Date().toISOString(),
        });
        logEvent(db, { taskId: safeTaskId, eventType: 'task.completed', actor: 'claude', payload: { sessionId: receipt.sessionId } });
        return updated;
      }
      return updateTask(db, safeTaskId, { state: 'running', session_id: receipt?.sessionId || row.session_id });
    } catch (err) {
      const q429 = detectClaude429(null, err);
      if (q429.is429) {
        const policy = loadPolicy();
        setMemberCooldown(db, 'claude', policy.claudeCooldownSeconds, `Claude 429 during poll of ${safeTaskId}: ${q429.detail}`, 'claude-cli');
      }
      throw err;
    }
  }
  return row;
}

/**
 * Poll all active background tasks in a batch concurrently and return a unified synthesis snapshot.
 */
export async function pollBatchTasks(db, { batchId, waitSec = 15 }, deps = {}) {
  const safeBatch = assertValidTaskId(batchId, 'batch_id');
  const rows = db.prepare('SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at ASC').all(safeBatch).map(parseTaskRow);
  const activeBg = rows.filter((r) => !TERMINAL_STATES.has(r.state) && r.channel !== 'desktop-native');

  await Promise.all(activeBg.map((t) => pollBackgroundTask(db, t.task_id, { waitSec }, deps).catch(() => null)));

  const fresh = db.prepare('SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at ASC').all(safeBatch).map(parseTaskRow);
  const counts = {};
  for (const t of fresh) counts[t.state] = (counts[t.state] || 0) + 1;
  return {
    batch_id: safeBatch,
    total: fresh.length,
    all_terminal: fresh.length > 0 && fresh.every((t) => TERMINAL_STATES.has(t.state)),
    all_succeeded: fresh.length > 0 && fresh.every((t) => t.state === 'completed'),
    has_failures: fresh.some((t) => ['failed', 'uncertain', 'needs_input', 'stalled'].includes(t.state)),
    counts,
    tasks: fresh,
  };
}

/**
 * Safe operator/coordinator reconciliation for stuck tasks (e.g. crash during dispatch or closing needs_input/uncertain).
 * Never allows overwriting an already-completed task.
 */
export function reconcileTask(db, {
  taskId, externalId = null, sessionId = null, state = null, resultText = null, note = null,
}) {
  const safeTaskId = assertValidTaskId(taskId, 'task_id');
  const existing = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
  if (!existing) throw new Error(`Task not found: ${safeTaskId}`);
  if (TERMINAL_STATES.has(existing.state)) {
    throw new Error(`Task ${safeTaskId} is already in terminal state=${existing.state}; refusing to overwrite.`);
  }
  const allowedReconcileStates = new Set(['running', 'stalled', 'uncertain', 'failed', 'rerouted', 'completed']);
  if (state && !allowedReconcileStates.has(state)) {
    throw new Error(`Invalid reconcile target state: ${state}`);
  }
  if (state === 'completed' && (!resultText || !String(resultText).trim())) {
    throw new Error('Reconciling a task to completed requires verified non-empty resultText.');
  }

  const patch = {};
  if (externalId) patch.external_id = externalId;
  if (sessionId) patch.session_id = sessionId;
  if (state) patch.state = state;
  if (resultText) patch.result_text = resultText;
  if (state === 'completed') {
    patch.completed_at = new Date().toISOString();
    patch.error_code = null;
    patch.error_message = null;
  } else if (note) {
    patch.error_message = note;
  }
  if (Object.keys(patch).length === 0) return existing;

  const updated = updateTask(db, safeTaskId, patch);
  logEvent(db, { taskId: safeTaskId, eventType: 'task.reconciled', actor: 'coordinator', payload: { patch, note } });
  return updated;
}

/**
 * Single-call ledger recording strictly for genuine native Desktop bridge handoffs (codex | agy | claude).
 * Enforces member/channel immutability and monotonic terminal state protection.
 */
export function recordNativeHandoff(db, {
  taskId = null,
  batchId = null,
  parentTaskId = null,
  member,
  role = 'implementer',
  projectDir,
  title = null,
  prompt = '',
  requestId = null,
  sessionId = null,
  mailMessageId = null,
  state = 'dispatched',
  worktreePath = null,
  branchName = null,
  resultText = null,
  evidence = null,
  errorCode = null,
  errorMessage = null,
}, deps = {}) {
  assertValidAgentId(member);
  const agent = getAgent(db, member);
  const allowedNative = NATIVE_MEMBERS.has(member) || (agent && agent.enabled && agent.driver === 'desktop-native');
  if (!allowedNative) {
    throw new Error(`Invalid member "${member}" for desktop-native handoff. Only desktop-native agents are permitted.`);
  }
  if (!VALID_ROLES.has(role)) throw new Error(`Invalid role: ${role}`);
  const allowedStates = new Set(['created', 'dispatched', 'running', 'needs_input', 'uncertain', 'completed', 'failed', 'rerouted']);
  if (!allowedStates.has(state)) throw new Error(`Invalid state: ${state}`);
  if (state === 'completed' && (!resultText || !String(resultText).trim())) {
    throw new Error('Completing a native handoff requires non-empty verified resultText (delivery receipt alone is not completion).');
  }

  const safeTaskId = taskId
    ? assertValidTaskId(taskId, 'task_id')
    : `ch_${member}_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  if (batchId) assertValidTaskId(batchId, 'batch_id');
  if (parentTaskId) assertValidTaskId(parentTaskId, 'parent_task_id');

  const existing = db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId);
  const now = new Date().toISOString();

  if (!existing) {
    if (!projectDir) throw new Error('projectDir is required when creating a new native handoff record');
    const resolved = resolveProjectDir(projectDir, { requireSubdir: false, workspaceRoot: deps.workspaceRoot, extraRoots: deps.extraRoots });
    db.prepare(`
      INSERT INTO tasks (task_id, batch_id, parent_task_id, project_dir, member, role, channel, title, prompt, state, external_id, session_id, worktree_path, branch_name, mail_message_id, result_text, evidence_json, error_code, error_message, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'desktop-native', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      safeTaskId, batchId, parentTaskId, resolved.windows, member, role,
      title || `${member}:${role}`, prompt || '(native desktop handoff)',
      state, requestId, sessionId, worktreePath, branchName, mailMessageId,
      resultText, evidence ? JSON.stringify(evidence) : null,
      errorCode, errorMessage, now, now, state === 'completed' ? now : null,
    );
    logEvent(db, { taskId: safeTaskId, eventType: `native.${state}`, actor: member, payload: { requestId, sessionId } });
  } else {
    // Prevent hijacking background tasks (dsh/muse/claude-cli) or cross-member mutation
    if (existing.channel !== 'desktop-native' || existing.member !== member) {
      throw new Error(`Refusing cross-member/cross-channel handoff update on ${safeTaskId} (owned by ${existing.member}/${existing.channel})`);
    }
    if (TERMINAL_STATES.has(existing.state)) {
      throw new Error(`Task ${safeTaskId} is already in terminal state=${existing.state}; refusing regression to ${state}.`);
    }
    const patch = { state };
    if (requestId) patch.external_id = requestId;
    if (sessionId) patch.session_id = sessionId;
    if (mailMessageId) patch.mail_message_id = mailMessageId;
    if (resultText !== null) patch.result_text = resultText;
    if (evidence !== null) patch.evidence_json = JSON.stringify(evidence);
    if (state === 'completed') {
      patch.completed_at = now;
      patch.error_code = null;
      patch.error_message = null;
    } else {
      if (errorCode !== null) patch.error_code = errorCode;
      if (errorMessage !== null) patch.error_message = errorMessage;
    }
    updateTask(db, safeTaskId, patch);
    logEvent(db, { taskId: safeTaskId, eventType: `native.${state}`, actor: member, payload: { requestId: requestId || existing.external_id } });
  }

  return parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeTaskId));
}
