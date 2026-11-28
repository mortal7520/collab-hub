/**
 * CollabHub v3.0 — Real-Time Cross-Agent Usage & Cost Engine (Zero Dependencies)
 *
 * Strictly metadata-only:
 * - Tracks live MCP stdio & Streamable HTTP `/mcp` activity for EVERY connected market client
 *   (Antigravity, Claude Code/Desktop, Codex, Cursor, Windsurf, VS Code, Cline, Roo Code,
 *   OpenCode, Zed, Continue, Kiro, Gemini CLI, custom MCP clients) in `client_usage_telemetry`.
 * - Optionally aggregates read-only numeric token counters & model names from recent local CLI
 *   session logs (`~/.claude/projects/<project>/*.jsonl`, `~/.codex/sessions/<date>/*.jsonl`, `~/.gemini/tmp/<hash>/chats/*.json`)
 *   using bounded reads & a 15s cache. NEVER extracts prompts, code, or environment secrets.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { computeAgentTelemetry } from './telemetry.mjs';

const DEFAULT_CACHE_TTL_MS = 15000;
const SEVEN_DAYS_MS = 7 * 86400 * 1000;
const ONE_DAY_MS = 86400 * 1000;
const scanCacheByHome = new Map();

// API-equivalent pricing estimates (USD per 1M tokens) for transparency; local models cost $0.
const MODEL_RATES_PER_M = [
  { re: /opus/i, input: 15, output: 75, cached: 1.5 },
  { re: /sonnet|claude/i, input: 3, output: 15, cached: 0.3 },
  { re: /haiku/i, input: 0.8, output: 4, cached: 0.08 },
  { re: /gpt-5|o3|o4|codex/i, input: 2.5, output: 10, cached: 0.625 },
  { re: /gpt-4\.1|gpt-4o/i, input: 2, output: 8, cached: 0.5 },
  { re: /gemini.*pro/i, input: 1.25, output: 10, cached: 0.31 },
  { re: /gemini/i, input: 0.35, output: 1.5, cached: 0.09 },
  { re: /deepseek/i, input: 0.55, output: 2.19, cached: 0.14 },
  { re: /qwen|llama|mistral|ollama|gemma|local/i, input: 0, output: 0, cached: 0 },
];

export function estimateCostUsd(model, { inputTokens = 0, outputTokens = 0, cachedTokens = 0 } = {}) {
  const m = String(model || '');
  const rate = MODEL_RATES_PER_M.find((r) => r.re.test(m)) || { input: 2, output: 8, cached: 0.5 };
  const billableIn = Math.max(0, Number(inputTokens) || 0);
  const out = Math.max(0, Number(outputTokens) || 0);
  const cached = Math.max(0, Number(cachedTokens) || 0);
  const usd = ((billableIn * rate.input) + (out * rate.output) + (cached * rate.cached)) / 1_000_000;
  return Number(usd.toFixed(4));
}

function normalizeClientId(clientName, fallback = 'mcp-client') {
  const raw = String(clientName || fallback).trim().toLowerCase();
  const mapped = raw
    .replace(/claude[-_\s]?code.*/, 'claude-code')
    .replace(/claude[-_\s]?desktop.*/, 'claude-desktop')
    .replace(/codex.*/, 'codex')
    .replace(/antigravity|agy.*/, 'antigravity')
    .replace(/cursor.*/, 'cursor')
    .replace(/windsurf.*/, 'windsurf')
    .replace(/vscode|visual studio code|copilot.*/, 'vscode')
    .replace(/cline.*/, 'cline')
    .replace(/roo.*/, 'roo-code')
    .replace(/opencode.*/, 'opencode')
    .replace(/zed.*/, 'zed')
    .replace(/continue.*/, 'continue')
    .replace(/kiro.*/, 'kiro')
    .replace(/gemini.*/, 'gemini-cli')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (mapped || 'mcp-client').slice(0, 64);
}

function sanitizeLabel(value, maxLen = 80, fallback = '') {
  const cleaned = String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || fallback).slice(0, maxLen);
}

function sanitizeModelName(value, fallback = null) {
  const s = String(value ?? '').trim().slice(0, 64);
  if (!s || !/^[A-Za-z0-9._:/@-]{1,64}$/.test(s)) return fallback;
  return s;
}

/**
 * Persist live MCP client activity (initialize / tools/call) so every connected market agent
 * appears immediately in real-time usage telemetry across HTTP, Cockpit, TUI, and HUD.
 */
export function recordMcpClientActivity(db, {
  clientId = null,
  clientName = 'MCP Client',
  clientVersion = '',
  transport = 'stdio',
  profile = 'full',
  toolName = null,
  bytesIn = 0,
  bytesOut = 0,
  isError = false,
} = {}) {
  if (!db) return null;
  const now = new Date().toISOString();
  const safeId = normalizeClientId(clientId || clientName);
  const safeName = sanitizeLabel(clientName, 80, safeId);
  const safeVersion = sanitizeLabel(clientVersion, 40, '');
  const safeTransport = transport === 'http' ? 'http' : 'stdio';
  const safeProfile = sanitizeLabel(profile, 24, 'full');
  const safeTool = toolName ? sanitizeLabel(toolName, 64, '') : null;
  const bIn = Math.max(0, Math.round(Number(bytesIn) || 0));
  const bOut = Math.max(0, Math.round(Number(bytesOut) || 0));
  const estTok = toolName ? Math.max(1, Math.round((bIn + bOut) / 4)) : 0;
  const callDelta = toolName ? 1 : 0;
  const errDelta = toolName && isError ? 1 : 0;

  try {
    db.prepare(`
      INSERT INTO client_usage_telemetry (
        client_id, client_name, client_version, transport, profile,
        mcp_calls, mcp_errors, mcp_bytes_in, mcp_bytes_out, est_mcp_tokens,
        last_tool, last_seen_at, first_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(client_id) DO UPDATE SET
        client_name = CASE WHEN excluded.client_name != '' THEN excluded.client_name ELSE client_usage_telemetry.client_name END,
        client_version = CASE WHEN excluded.client_version != '' THEN excluded.client_version ELSE client_usage_telemetry.client_version END,
        transport = excluded.transport,
        profile = excluded.profile,
        mcp_calls = client_usage_telemetry.mcp_calls + excluded.mcp_calls,
        mcp_errors = client_usage_telemetry.mcp_errors + excluded.mcp_errors,
        mcp_bytes_in = client_usage_telemetry.mcp_bytes_in + excluded.mcp_bytes_in,
        mcp_bytes_out = client_usage_telemetry.mcp_bytes_out + excluded.mcp_bytes_out,
        est_mcp_tokens = client_usage_telemetry.est_mcp_tokens + excluded.est_mcp_tokens,
        last_tool = COALESCE(excluded.last_tool, client_usage_telemetry.last_tool),
        last_seen_at = excluded.last_seen_at
    `).run(
      safeId, safeName, safeVersion, safeTransport, safeProfile,
      callDelta, errDelta, bIn, bOut, estTok,
      toolName ? (safeTool || null) : null, now, now,
    );
    return safeId;
  } catch {
    return null;
  }
}

function isInsideCanonicalRoot(canonicalRoot, targetPath) {
  try {
    const resolved = fs.realpathSync(targetPath);
    const rel = path.relative(canonicalRoot, resolved);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  } catch {
    return false;
  }
}

function collectRecentFiles(rootDir, { ext = '.jsonl', cutoffMs = 0, maxDepth = 4, maxFiles = 24, maxEntries = 600 } = {}) {
  const out = [];
  if (!rootDir || !fs.existsSync(rootDir)) return out;
  let canonicalRoot;
  try { canonicalRoot = fs.realpathSync(rootDir); } catch { return out; }
  let visited = 0;
  const walk = (dir, depth) => {
    if (depth > maxDepth || out.length >= maxFiles * 3 || visited >= maxEntries) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      if (visited >= maxEntries) break;
      visited += 1;
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith(ext)) {
        try {
          const st = fs.lstatSync(full);
          if (!st.isFile() || st.isSymbolicLink()) continue;
          if (st.mtimeMs >= cutoffMs && st.size > 0 && isInsideCanonicalRoot(canonicalRoot, full)) {
            out.push({ path: full, root: canonicalRoot, mtimeMs: st.mtimeMs, size: st.size });
          }
        } catch { /* ignore unreadable */ }
      }
    }
  };
  walk(canonicalRoot, 0);
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out.slice(0, maxFiles);
}

function readBoundedTail(filePath, size, maxBytes, canonicalRoot = null) {
  if (canonicalRoot && !isInsideCanonicalRoot(canonicalRoot, filePath)) return '';
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return '';
    const actualSize = Math.min(size || st.size, st.size);
    const readBytes = Math.min(actualSize, maxBytes);
    if (readBytes <= 0) return '';
    const offset = Math.max(0, actualSize - readBytes);
    const buf = Buffer.allocUnsafe(readBytes);
    const n = fs.readSync(fd, buf, 0, readBytes, offset);
    let text = buf.subarray(0, n).toString('utf8');
    if (offset > 0) {
      const nl = text.indexOf('\n');
      if (nl !== -1) text = text.slice(nl + 1);
    }
    return text;
  } finally {
    fs.closeSync(fd);
  }
}

function parseClaudeUsageFiles(files, { nowMs, todayStartMs, maxBytesPerFile, hourly }) {
  const bucket = {
    agent_id: 'claude-code',
    name: 'Claude Code',
    source: 'local-jsonl',
    sessions_7d: files.length,
    today_tokens: 0,
    total_7d_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    est_cost_usd_7d: 0,
    est_cost_usd_today: 0,
    last_model: null,
    last_seen_at: null,
    recent_5m_tokens: 0,
  };
  const fiveMinAgo = nowMs - 5 * 60 * 1000;
  for (const f of files) {
    let text = '';
    try { text = readBoundedTail(f.path, f.size, maxBytesPerFile, f.root); } catch { continue; }
    for (const line of text.split(/\r?\n/)) {
      if (!line || !line.includes('"usage"')) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const usage = obj?.message?.usage || obj?.usage;
      if (!usage || typeof usage !== 'object') continue;
      const inTok = Number(usage.input_tokens || 0);
      const outTok = Number(usage.output_tokens || 0);
      const cacheTok = Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0);
      const tot = inTok + outTok + cacheTok;
      if (!Number.isFinite(tot) || tot <= 0) continue;
      const model = sanitizeModelName(obj?.message?.model || obj?.model, 'claude-sonnet-4');
      const tsMs = Date.parse(obj.timestamp) || f.mtimeMs;
      const cost = estimateCostUsd(model, { inputTokens: inTok, outputTokens: outTok, cachedTokens: cacheTok });
      bucket.input_tokens += inTok;
      bucket.output_tokens += outTok;
      bucket.cached_tokens += cacheTok;
      bucket.total_7d_tokens += tot;
      bucket.est_cost_usd_7d += cost;
      if (tsMs >= todayStartMs) {
        bucket.today_tokens += tot;
        bucket.est_cost_usd_today += cost;
      }
      if (tsMs >= fiveMinAgo) bucket.recent_5m_tokens += tot;
      bucket.last_model = model;
      const iso = new Date(tsMs).toISOString();
      if (!bucket.last_seen_at || iso > bucket.last_seen_at) bucket.last_seen_at = iso;
      const hr = Math.floor((nowMs - tsMs) / 3600000);
      if (hr >= 0 && hr < 24) hourly[23 - hr] += tot;
    }
  }
  return bucket;
}

function parseCodexUsageFiles(files, { nowMs, todayStartMs, maxBytesPerFile, hourly }) {
  const bucket = {
    agent_id: 'codex',
    name: 'Codex',
    source: 'local-jsonl',
    sessions_7d: files.length,
    today_tokens: 0,
    total_7d_tokens: 0,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    est_cost_usd_7d: 0,
    est_cost_usd_today: 0,
    last_model: null,
    last_seen_at: null,
    recent_5m_tokens: 0,
  };
  const fiveMinAgo = nowMs - 5 * 60 * 1000;
  for (const f of files) {
    let text = '';
    try { text = readBoundedTail(f.path, f.size, maxBytesPerFile, f.root); } catch { continue; }
    let fileModel = 'gpt-5-codex';
    let lastSessTotal = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line) continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const maybeModel = sanitizeModelName(obj?.payload?.model || obj?.model, null);
      if (maybeModel) fileModel = maybeModel;

      const info = obj?.payload?.info || obj?.info || null;
      const lastU = info?.last_token_usage || obj?.payload?.usage || obj?.usage || null;
      const totalU = info?.total_token_usage || null;
      let inTok = 0;
      let outTok = 0;
      let cacheTok = 0;
      let tot = 0;
      if (lastU && typeof lastU === 'object') {
        inTok = Number(lastU.input_tokens || lastU.prompt_tokens || 0);
        outTok = Number(lastU.output_tokens || lastU.completion_tokens || 0);
        cacheTok = Number(lastU.cached_input_tokens || lastU.reasoning_output_tokens || 0);
        tot = Number(lastU.total_tokens || (inTok + outTok));
      } else if (totalU && typeof totalU === 'object') {
        const curTot = Number(totalU.total_tokens || 0);
        if (curTot > lastSessTotal) {
          tot = curTot - lastSessTotal;
          lastSessTotal = curTot;
          inTok = Math.round(tot * 0.7);
          outTok = tot - inTok;
        }
      }
      if (!Number.isFinite(tot) || tot <= 0) continue;
      const tsMs = Date.parse(obj.timestamp) || f.mtimeMs;
      const cost = estimateCostUsd(fileModel, { inputTokens: Math.max(0, inTok - cacheTok), outputTokens: outTok, cachedTokens: cacheTok });
      bucket.input_tokens += inTok;
      bucket.output_tokens += outTok;
      bucket.cached_tokens += cacheTok;
      bucket.total_7d_tokens += tot;
      bucket.est_cost_usd_7d += cost;
      if (tsMs >= todayStartMs) {
        bucket.today_tokens += tot;
        bucket.est_cost_usd_today += cost;
      }
      if (tsMs >= fiveMinAgo) bucket.recent_5m_tokens += tot;
      bucket.last_model = fileModel;
      const iso = new Date(tsMs).toISOString();
      if (!bucket.last_seen_at || iso > bucket.last_seen_at) bucket.last_seen_at = iso;
      const hr = Math.floor((nowMs - tsMs) / 3600000);
      if (hr >= 0 && hr < 24) hourly[23 - hr] += tot;
    }
  }
  return bucket;
}

/**
 * Scan local CLI session telemetry metadata ONLY (tokens, model names, timestamps).
 * Never extracts user prompt text, code diffs, or secrets.
 */
export function scanLocalAgentUsage({
  homedir = os.homedir(),
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  maxFilesPerAgent = 24,
  maxBytesPerFile = 512 * 1024,
} = {}) {
  const nowMs = Date.now();
  const cached = scanCacheByHome.get(homedir);
  if (cached && cacheTtlMs > 0 && (nowMs - cached.at) < cacheTtlMs) {
    return cached.data;
  }

  const cutoffMs = nowMs - SEVEN_DAYS_MS;
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const hourly = new Array(24).fill(0);

  const claudeFiles = collectRecentFiles(path.join(homedir, '.claude', 'projects'), { ext: '.jsonl', cutoffMs, maxFiles: maxFilesPerAgent });
  const codexFiles = collectRecentFiles(path.join(homedir, '.codex', 'sessions'), { ext: '.jsonl', cutoffMs, maxFiles: maxFilesPerAgent });
  const geminiFiles = collectRecentFiles(path.join(homedir, '.gemini', 'tmp'), { ext: '.json', cutoffMs, maxFiles: maxFilesPerAgent });

  const localBuckets = [];
  if (claudeFiles.length > 0) {
    localBuckets.push(parseClaudeUsageFiles(claudeFiles, { nowMs, todayStartMs, maxBytesPerFile, hourly }));
  }
  if (codexFiles.length > 0) {
    localBuckets.push(parseCodexUsageFiles(codexFiles, { nowMs, todayStartMs, maxBytesPerFile, hourly }));
  }
  if (geminiFiles.length > 0) {
    let newestMs = 0;
    for (const f of geminiFiles) newestMs = Math.max(newestMs, f.mtimeMs);
    localBuckets.push({
      agent_id: 'gemini-cli',
      name: 'Gemini CLI',
      source: 'local-sessions',
      sessions_7d: geminiFiles.length,
      today_tokens: 0,
      total_7d_tokens: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      est_cost_usd_7d: 0,
      est_cost_usd_today: 0,
      last_model: 'gemini-2.5-pro',
      last_seen_at: newestMs ? new Date(newestMs).toISOString() : null,
      recent_5m_tokens: 0,
    });
  }

  const data = {
    scanned_at: new Date(nowMs).toISOString(),
    buckets: localBuckets,
    hourly_buckets: hourly,
  };
  scanCacheByHome.set(homedir, { at: nowMs, data });
  return data;
}

export async function probeOllamaActiveModels({ baseUrl = 'http://127.0.0.1:11434/api/ps', timeoutMs = 450 } = {}) {
  try {
    const res = await fetch(baseUrl, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return [];
    const data = await res.json().catch(() => ({}));
    return (Array.isArray(data?.models) ? data.models : []).map((m) => ({
      name: String(m.name || m.model || 'ollama'),
      size_vram: Number(m.size_vram || 0),
      expires_at: m.expires_at || null,
    }));
  } catch {
    return [];
  }
}

/**
 * Unified synchronous Live Cross-Agent Usage snapshot merging:
 * 1) Live MCP client telemetry (every connected Cursor/Claude/Codex/AGY/Windsurf/Cline/OpenCode/Zed client)
 * 2) Local CLI session metadata scan (7d/today tokens & API-equivalent USD estimates)
 * 3) CollabHub SQLite `tasks` dispatch telemetry (runs, active tasks, latencies)
 */
export function getLiveAgentUsage(db, {
  homedir = os.homedir(),
  includeLocalScan = true,
  cacheTtlMs = DEFAULT_CACHE_TTL_MS,
  extraOllamaModels = [],
} = {}) {
  const nowMs = Date.now();
  const activeCutoffMs = nowMs - 5 * 60 * 1000;
  const recentCutoffMs = nowMs - ONE_DAY_MS;
  const map = new Map();

  const ensureRow = (id, name) => {
    const safeId = normalizeClientId(id, id);
    if (!map.has(safeId)) {
      map.set(safeId, {
        agent_id: safeId,
        name: name || safeId,
        status: 'idle',
        sources: [],
        transport: null,
        profile: null,
        last_tool: null,
        last_model: null,
        mcp_calls: 0,
        mcp_errors: 0,
        est_mcp_tokens: 0,
        task_runs: 0,
        task_active: 0,
        task_tokens: 0,
        today_tokens: 0,
        total_7d_tokens: 0,
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        est_cost_usd_today: 0,
        est_cost_usd_7d: 0,
        tokens_per_min: 0,
        sessions_7d: 0,
        last_seen_at: null,
      });
    }
    return map.get(safeId);
  };

  // 1. Live connected MCP clients (`client_usage_telemetry`)
  let mcpRows = [];
  try {
    mcpRows = db.prepare('SELECT * FROM client_usage_telemetry ORDER BY last_seen_at DESC').all();
  } catch { mcpRows = []; }

  const todayStart = new Date(nowMs);
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();
  const todayIsoCutoff = todayStart.toISOString();

  for (const r of mcpRows) {
    const row = ensureRow(r.client_id, sanitizeLabel(r.client_name, 80, r.client_id));
    if (!row.sources.includes('mcp')) row.sources.push('mcp');
    row.name = sanitizeLabel(r.client_name, 80, row.name);
    row.transport = r.transport || row.transport;
    row.profile = r.profile || row.profile;
    row.last_tool = r.last_tool || row.last_tool;
    row.mcp_calls += Number(r.mcp_calls || 0);
    row.mcp_errors += Number(r.mcp_errors || 0);
    row.est_mcp_tokens += Number(r.est_mcp_tokens || 0);
    row.total_7d_tokens += Number(r.est_mcp_tokens || 0);
    if (Date.parse(r.last_seen_at) >= todayStartMs) {
      row.today_tokens += Number(r.est_mcp_tokens || 0);
    }
    if (r.last_seen_at && (!row.last_seen_at || r.last_seen_at > row.last_seen_at)) {
      row.last_seen_at = r.last_seen_at;
    }
  }

  // 2. Local CLI session token scan (strictly metadata-only)
  const local = includeLocalScan
    ? scanLocalAgentUsage({ homedir, cacheTtlMs })
    : { scanned_at: null, buckets: [], hourly_buckets: new Array(24).fill(0) };

  for (const b of local.buckets) {
    const row = ensureRow(b.agent_id, b.name);
    if (!row.sources.includes(b.source)) row.sources.push(b.source);
    row.sessions_7d += b.sessions_7d;
    row.input_tokens += b.input_tokens;
    row.output_tokens += b.output_tokens;
    row.cached_tokens += b.cached_tokens;
    row.today_tokens += b.today_tokens;
    row.total_7d_tokens += b.total_7d_tokens;
    row.est_cost_usd_today = Number((row.est_cost_usd_today + b.est_cost_usd_today).toFixed(4));
    row.est_cost_usd_7d = Number((row.est_cost_usd_7d + b.est_cost_usd_7d).toFixed(4));
    row.tokens_per_min += Math.round((b.recent_5m_tokens || 0) / 5);
    if (b.last_model) row.last_model = b.last_model;
    if (b.last_seen_at && (!row.last_seen_at || b.last_seen_at > row.last_seen_at)) {
      row.last_seen_at = b.last_seen_at;
    }
  }

  // 3. Task ledger telemetry (`tasks` table — computeAgentTelemetry returns `{ agents: { [member]: bucket } }`)
  const taskTel = computeAgentTelemetry(db, { days: 7 });
  const taskTelToday = computeAgentTelemetry(db, { days: 1 });
  const todayAgents = taskTelToday?.agents || {};
  for (const m of Object.values(taskTel?.agents || {})) {
    const row = ensureRow(m.member, m.member);
    if (!row.sources.includes('tasks')) row.sources.push('tasks');
    row.task_runs += Number(m.total || 0);
    row.task_active += Number(m.active || 0);
    row.task_tokens += Number(m.total_tokens || 0);
    row.input_tokens += Number(m.prompt_tokens || 0);
    row.output_tokens += Number(m.completion_tokens || 0);
    row.total_7d_tokens += Number(m.total_tokens || 0);
    const estCost7d = estimateCostUsd(m.member, {
      inputTokens: m.prompt_tokens || 0,
      outputTokens: m.completion_tokens || 0,
    });
    row.est_cost_usd_7d = Number((row.est_cost_usd_7d + estCost7d).toFixed(4));
    const td = todayAgents[m.member];
    if (td) {
      row.today_tokens += Number(td.total_tokens || 0);
      const estCostToday = estimateCostUsd(m.member, {
        inputTokens: td.prompt_tokens || 0,
        outputTokens: td.completion_tokens || 0,
      });
      row.est_cost_usd_today = Number((row.est_cost_usd_today + estCostToday).toFixed(4));
    }
  }

  // 4. Optional active Ollama local models
  for (const om of (extraOllamaModels || [])) {
    const safeModel = sanitizeModelName(om.name, 'ollama');
    const row = ensureRow(`ollama-${safeModel}`, `Ollama (${safeModel})`);
    if (!row.sources.includes('ollama-ps')) row.sources.push('ollama-ps');
    row.last_model = safeModel;
    row.status = 'active';
    row.last_seen_at = new Date(nowMs).toISOString();
  }

  const agents = [];
  let todayTokens = 0;
  let total7dTokens = 0;
  let costToday = 0;
  let cost7d = 0;
  let tokPerMin = 0;
  let mcpCallsTotal = 0;
  let activeCount = 0;

  for (const row of map.values()) {
    const seenMs = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;
    if (row.task_active > 0 || row.status === 'active' || (seenMs && seenMs >= activeCutoffMs)) {
      row.status = 'active';
      activeCount += 1;
    } else if (seenMs && seenMs >= recentCutoffMs) {
      row.status = 'recent';
    } else {
      row.status = 'idle';
    }
    todayTokens += row.today_tokens;
    total7dTokens += row.total_7d_tokens;
    costToday += row.est_cost_usd_today;
    cost7d += row.est_cost_usd_7d;
    tokPerMin += row.tokens_per_min;
    mcpCallsTotal += row.mcp_calls;
    agents.push(row);
  }

  agents.sort((a, b) => {
    const rank = { active: 0, recent: 1, idle: 2 };
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    if (b.total_7d_tokens !== a.total_7d_tokens) return b.total_7d_tokens - a.total_7d_tokens;
    return (b.mcp_calls || 0) - (a.mcp_calls || 0);
  });

  return {
    scanned_at: local.scanned_at || new Date(nowMs).toISOString(),
    privacy_note: 'metadata_only_no_prompts',
    totals: {
      connected_agents: agents.length,
      active_agents: activeCount,
      today_tokens: todayTokens,
      total_7d_tokens: total7dTokens,
      est_cost_usd_today: Number(costToday.toFixed(4)),
      est_cost_usd_7d: Number(cost7d.toFixed(4)),
      tokens_per_min: tokPerMin,
      mcp_calls_total: mcpCallsTotal,
    },
    hourly_buckets: local.hourly_buckets,
    agents,
  };
}

export async function getLiveAgentUsageAsync(db, opts = {}) {
  const extraOllamaModels = opts.includeOllama
    ? await probeOllamaActiveModels().catch(() => [])
    : [];
  return getLiveAgentUsage(db, { ...opts, extraOllamaModels });
}
