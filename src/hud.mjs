/**
 * CollabHub v2.0 — Ultra-fast read-only HUD & StatusLine renderer.
 *
 * Designed for:
 *   - Claude Code `statusLine` (`~/.claude/settings.json`) — one line, ANSI coloured.
 *   - Codex CLI / Windows Terminal / tmux — `--format card` for a boxed Cyber-HUD.
 *   - WSL DSH terminals — `--watch` single-line live updater at 4 fps.
 *
 * Hard constraints:
 *   - ZERO npm dependencies. Node >= 22.13 built-ins only.
 *   - `collectHudSnapshot()` reads SQLite ONLY. It never spawns a subprocess and never
 *     touches the network, so a full snapshot normally completes in well under 30 ms.
 *   - Every renderer is a pure function of its arguments — deterministic and unit-testable
 *     without a real TTY.
 */

import { getMemberStatuses } from './db.mjs';
import { getSelfImproveSummary } from './self-improve.mjs';

/* -------------------------------------------------------------------------- */
/* Palette                                                                    */
/* -------------------------------------------------------------------------- */

export const HUD_PALETTE = Object.freeze({
  obsidian: '#0b0e14',
  indigo: '#818cf8',
  cyan: '#38bdf8',
  emerald: '#34d399',
  amber: '#fbbf24',
  rose: '#fb7185',
  slate: '#64748b',
  white: '#e2e8f0',
  violet: '#a78bfa',
});

const P = HUD_PALETTE;
const PULSE_FRAMES = Object.freeze(['◉', '◎', '●']);
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const ANSI_TOKEN_RE = /^\x1b\[[0-9;]*m/;
const ESC_STRING_RE = /\x1b[\]PX^_][\s\S]*?(?:\x07|\x1b\\|$)/g;
const NON_SGR_CSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CTRL_CHAR_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g;

/**
 * Strip untrusted terminal control sequences (OSC 52/title/DCS/non-SGR CSI + C0/C1 controls)
 * from DB/agent-supplied text before terminal rendering.
 */
export function sanitizeTerminalText(value) {
  return String(value ?? '')
    .replace(ESC_STRING_RE, '')
    .replace(NON_SGR_CSI_RE, '')
    .replace(CTRL_CHAR_RE, ' ');
}

const AGENT_GLYPHS = Object.freeze({
  agy: 'AGY',
  codex: 'COD',
  claude: 'CLD',
  dsh: 'DSH',
  muse: 'MUS',
});

const STATE_SYMBOLS = Object.freeze({
  online: '●',
  busy: '◉',
  running: '◉',
  idle: '◐',
  cooldown: '◐',
  stale: '◌',
  offline: '○',
  unknown: '○',
  error: '✕',
});

const ONLINE_STATES = new Set(['online', 'busy', 'running', 'idle', 'cooldown']);
const AGENT_ORDER = Object.freeze({ agy: 0, codex: 1, claude: 2, dsh: 3, muse: 4 });
const ACTIVE_TASK_STATES = new Set(['running', 'dispatching', 'dispatched']);
const ATTENTION_TASK_STATES = new Set(['stalled', 'uncertain', 'needs_input']);

/* -------------------------------------------------------------------------- */
/* Small utilities (also reused by src/tui.mjs)                               */
/* -------------------------------------------------------------------------- */

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

/** Strip SGR colour sequences. */
export function stripAnsi(value) {
  return String(value ?? '').replace(ANSI_RE, '');
}

/** Approximate terminal cell width of one code point (ANSI already stripped). */
function codePointWidth(cp) {
  if (cp === 0) return 0;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (
    (cp >= 0x0300 && cp <= 0x036f) ||
    (cp >= 0x1ab0 && cp <= 0x1aff) ||
    (cp >= 0x1dc0 && cp <= 0x1dff) ||
    (cp >= 0x20d0 && cp <= 0x20ff) ||
    (cp >= 0xfe20 && cp <= 0xfe2f)
  ) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0x303e) ||
    (cp >= 0x3041 && cp <= 0x33ff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0xa000 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe6f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) ||
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  ) return 2;
  return 1;
}

/** Visible terminal width, ANSI-aware. */
export function displayWidth(value) {
  const str = stripAnsi(value);
  let width = 0;
  for (const ch of str) width += codePointWidth(ch.codePointAt(0));
  return width;
}

/** ANSI-aware truncation that always strips non-SGR control sequences and closes open SGR. */
export function truncateAnsi(value, maxWidth, ellipsis = '') {
  const str = String(value ?? '')
    .replace(ESC_STRING_RE, '')
    .replace(CTRL_CHAR_RE, ' ');
  const limit = Math.max(0, Math.floor(maxWidth));
  if (displayWidth(str) <= limit) return str;
  const ellipsisWidth = Math.min(limit, displayWidth(ellipsis));
  const budget = Math.max(0, limit - ellipsisWidth);
  let out = '';
  let width = 0;
  let i = 0;
  let sawAnsi = false;
  while (i < str.length) {
    if (str[i] === '\x1b') {
      const m = ANSI_TOKEN_RE.exec(str.slice(i));
      if (m) {
        out += m[0];
        sawAnsi = true;
        i += m[0].length;
        continue;
      }
    }
    const cp = str.codePointAt(i);
    const ch = String.fromCodePoint(cp);
    const cw = codePointWidth(cp);
    if (width + cw > budget) break;
    out += ch;
    width += cw;
    i += ch.length;
  }
  if (ellipsis) out += ellipsis;
  if (sawAnsi && !/\x1b\[0m$/.test(out)) out += '\x1b[0m';
  return out;
}

/** Right-pad to a visible width (input should already be truncated). */
export function padAnsi(value, width) {
  const str = String(value ?? '');
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)));
}

function hexToRgb(hex) {
  let h = String(hex || '').trim().replace(/^#/, '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  if (!/^[0-9a-fA-F]{6}$/.test(h)) h = '64748b';
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  };
}

const ANSI16 = Object.freeze([
  [0, 0, 0], [128, 0, 0], [0, 128, 0], [128, 128, 0],
  [0, 0, 128], [128, 0, 128], [0, 128, 128], [192, 192, 192],
  [128, 128, 128], [255, 0, 0], [0, 255, 0], [255, 255, 0],
  [0, 0, 255], [255, 0, 255], [0, 255, 255], [255, 255, 255],
]);

function rgbTo256({ r, g, b }) {
  if (Math.abs(r - g) < 10 && Math.abs(g - b) < 10) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return 232 + Math.round(((r - 8) / 247) * 24);
  }
  const q = (v) => (v < 48 ? 0 : (v < 115 ? 1 : Math.round((v - 35) / 40)));
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

function rgbTo16({ r, g, b }) {
  let best = 7;
  let bestDist = Infinity;
  for (let i = 0; i < ANSI16.length; i += 1) {
    const [rr, gg, bb] = ANSI16[i];
    const d = (r - rr) ** 2 + (g - gg) ** 2 + (b - bb) ** 2;
    if (d < bestDist) { bestDist = d; best = i; }
  }
  return best < 8 ? 30 + best : 90 + (best - 8);
}

const FG_CACHE = new Map();
const BG_CACHE = new Map();

function fgAnsi(hex, level) {
  const key = `${level}:${hex}`;
  const hit = FG_CACHE.get(key);
  if (hit) return hit;
  const rgb = hexToRgb(hex);
  let seq;
  if (level >= 3) seq = `\x1b[38;2;${rgb.r};${rgb.g};${rgb.b}m`;
  else if (level === 2) seq = `\x1b[38;5;${rgbTo256(rgb)}m`;
  else seq = `\x1b[${rgbTo16(rgb)}m`;
  FG_CACHE.set(key, seq);
  return seq;
}

function bgAnsi(hex, level) {
  const key = `${level}:${hex}`;
  const hit = BG_CACHE.get(key);
  if (hit) return hit;
  const rgb = hexToRgb(hex);
  let seq;
  if (level >= 3) seq = `\x1b[48;2;${rgb.r};${rgb.g};${rgb.b}m`;
  else if (level === 2) seq = `\x1b[48;5;${rgbTo256(rgb)}m`;
  else seq = `\x1b[${rgbTo16(rgb) + 10}m`;
  BG_CACHE.set(key, seq);
  return seq;
}

/**
 * Build a colour painter for a colour level. At level 0 it returns the text
 * untouched (zero escape bytes), which is what NO_COLOR / TERM=dumb require.
 */
export function makePainter(colorLevel = 0) {
  const level = clampInt(colorLevel, 0, 3, 0);
  return function paint(text, hex, opts = {}) {
    const str = String(text ?? '');
    if (level <= 0 || str.length === 0) return str;
    let prefix = '';
    if (opts.bold) prefix += '\x1b[1m';
    if (opts.dim) prefix += '\x1b[2m';
    prefix += opts.bg ? bgAnsi(hex || P.slate, level) : fgAnsi(hex || P.slate, level);
    return `${prefix}${str}\x1b[0m`;
  };
}

function lerpChannel(a, b, t) {
  return Math.round(a + (b - a) * t);
}

/** Per-character horizontal gradient (24-bit at level 3, nearest palette below). */
export function gradientText(text, fromHex, toHex, colorLevel = 0, opts = {}) {
  const str = String(text ?? '');
  const paint = makePainter(colorLevel);
  if (colorLevel <= 0 || str.length === 0) return str;
  const from = hexToRgb(fromHex);
  const to = hexToRgb(toHex);
  const chars = [...str];
  return chars.map((ch, i) => {
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
    const hex = `#${lerpChannel(from.r, to.r, t).toString(16).padStart(2, '0')}${lerpChannel(from.g, to.g, t).toString(16).padStart(2, '0')}${lerpChannel(from.b, to.b, t).toString(16).padStart(2, '0')}`;
    return paint(ch, hex, opts);
  }).join('');
}

/* -------------------------------------------------------------------------- */
/* Colour support detection                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Detect terminal colour capability.
 * Strictly honours NO_COLOR, TERM=dumb, FORCE_COLOR, COLORTERM=truecolor and
 * `stream.isTTY`. Returns exactly `{ level: 0 | 1 | 2 | 3 }`.
 */
export function detectColorSupport({ stream = process.stdout, env = process.env, allowPipedAnsi = false } = {}) {
  const e = env || {};
  const has = (key) => Object.prototype.hasOwnProperty.call(e, key) && e[key] !== undefined;

  // NO_COLOR: https://no-color.org — non-empty presence disables colour entirely.
  if (has('NO_COLOR') && String(e.NO_COLOR) !== '') return { level: 0 };

  if (has('FORCE_COLOR')) {
    const force = String(e.FORCE_COLOR).toLowerCase();
    if (force === '0' || force === 'false' || force === 'none') return { level: 0 };
    if (force === '3' || force === 'truecolor' || force === '24bit') return { level: 3 };
    if (force === '2') return { level: 2 };
    return { level: 1 };
  }

  if (String(e.TERM || '').toLowerCase() === 'dumb') return { level: 0 };
  if (!allowPipedAnsi && (!stream || !stream.isTTY)) return { level: 0 };

  const colorTerm = String(e.COLORTERM || '').toLowerCase();
  if (colorTerm === 'truecolor' || colorTerm === '24bit') return { level: 3 };
  if (String(e.TERM || '').toLowerCase().includes('256color')) return { level: 2 };
  return { level: allowPipedAnsi ? 3 : 1 };
}

/* -------------------------------------------------------------------------- */
/* Snapshot (SQLite only, no spawn / no network)                              */
/* -------------------------------------------------------------------------- */

function safeGet(db, sql, ...params) {
  try {
    return db.prepare(sql).get(...params) || null;
  } catch {
    return null;
  }
}

function safeAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

/** Human friendly age: `4s`, `12m`, `3h`, `2d`. */
export function formatAge(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return '0s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function symbolForAgent(state) {
  return STATE_SYMBOLS[String(state || 'unknown').toLowerCase()] || '○';
}

function glyphForAgent(id) {
  const key = String(id || '').toLowerCase();
  if (AGENT_GLYPHS[key]) return AGENT_GLYPHS[key];
  const cleaned = key.replace(/[^a-z0-9]/g, '').slice(0, 3).toUpperCase();
  return cleaned || 'AGT';
}

/**
 * Collect a compact, render-ready HUD snapshot from SQLite ONLY.
 *
 * @param {import('node:sqlite').DatabaseSync} db open CollabHub database
 * @param {{ worktreeDir?: string, now?: number }} [options]
 * @returns {object} snapshot
 */
export function collectHudSnapshot(db, { worktreeDir, now } = {}) {
  const startedNs = process.hrtime.bigint();
  const nowMs = Number.isFinite(now) ? Number(now) : Date.now();
  if (!db || typeof db.prepare !== 'function') {
    const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;
    return {
      generated_at: new Date(nowMs).toISOString(),
      snapshot_ro: false,
      empty_db: true,
      agents: { total: 0, online: 0, busy: 0, cooldown: 0, offline: 0, items: [] },
      tasks: { total: 0, active: 0, running: 0, queued: 0, stalled: 0, failed: 0, completed: 0, latest_age_ms: null, latest_age_human: '—', latest: null },
      worktrees: { active: 0, total: 0 },
      merge_queue: { queued: 0, ready: 0, validating: 0, conflict: 0, failed: 0, merged: 0 },
      rooms: { active_claims: 0 },
      mcp: { registered: 0, healthy: 0, tools: 0 },
      lessons: { active: 0, total: 0 },
      health: { score: null, overall: 'no-db', findings: 0, healable: 0 },
      duration_ms: Math.round(durationMs * 100) / 100,
    };
  }

  /* ------------------------------ agents ------------------------------- */
  let statuses = [];
  try {
    statuses = getMemberStatuses(db);
  } catch {
    statuses = [];
  }
  if (!Array.isArray(statuses) || statuses.length === 0) {
    statuses = safeAll(db, 'SELECT * FROM member_status ORDER BY member ASC').map((r) => ({
      member: r.member,
      name: r.member,
      state: r.state || 'unknown',
      channel: r.channel || '',
      age_s: Number.isFinite(Date.parse(r.checked_at)) ? Math.max(0, Math.round((nowMs - Date.parse(r.checked_at)) / 1000)) : null,
      in_cooldown: false,
    }));
  }

  const agentItems = statuses.map((a) => {
    const state = String(a.state || 'unknown').toLowerCase();
    return {
      id: a.member,
      name: a.name || a.member,
      glyph: glyphForAgent(a.member),
      symbol: symbolForAgent(state),
      state,
      online: ONLINE_STATES.has(state),
      cooldown: Boolean(a.in_cooldown) || state === 'cooldown',
      channel: a.channel || '',
      age_s: Number.isFinite(a.age_s) ? a.age_s : null,
    };
  });
  agentItems.sort((a, b) => (AGENT_ORDER[a.id] ?? 99) - (AGENT_ORDER[b.id] ?? 99) || String(a.id).localeCompare(String(b.id)));
  agentItems.splice(12);

  const agentCounts = {
    total: agentItems.length,
    online: agentItems.filter((a) => a.online).length,
    busy: agentItems.filter((a) => a.state === 'busy' || a.state === 'running').length,
    cooldown: agentItems.filter((a) => a.state === 'cooldown' || a.cooldown).length,
    offline: agentItems.filter((a) => !a.online).length,
    items: agentItems,
  };

  /* ------------------------------- tasks ------------------------------- */
  const taskAgg = safeGet(db, `
    SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN state IN ('running','dispatching','dispatched') THEN 1 ELSE 0 END), 0) AS active,
      COALESCE(SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END), 0) AS running,
      COALESCE(SUM(CASE WHEN state = 'queued' THEN 1 ELSE 0 END), 0) AS queued,
      COALESCE(SUM(CASE WHEN state IN ('stalled','uncertain','needs_input') THEN 1 ELSE 0 END), 0) AS stalled,
      COALESCE(SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
      COALESCE(SUM(CASE WHEN state = 'completed' THEN 1 ELSE 0 END), 0) AS completed
    FROM tasks
  `) || {};

  const latest = safeGet(db, `
    SELECT task_id, title, member, state, updated_at
    FROM tasks
    ORDER BY updated_at DESC
    LIMIT 1
  `);
  const latestMs = latest && Number.isFinite(Date.parse(latest.updated_at))
    ? Math.max(0, nowMs - Date.parse(latest.updated_at))
    : null;

  const tasks = {
    total: toInt(taskAgg.total),
    active: toInt(taskAgg.active),
    running: toInt(taskAgg.running),
    queued: toInt(taskAgg.queued),
    stalled: toInt(taskAgg.stalled),
    failed: toInt(taskAgg.failed),
    completed: toInt(taskAgg.completed),
    latest_age_ms: latestMs,
    latest_age_human: formatAge(latestMs),
    latest: latest ? {
      task_id: latest.task_id,
      title: latest.title,
      member: latest.member,
      state: latest.state,
      updated_at: latest.updated_at,
    } : null,
  };

  /* ----------------------------- worktrees ----------------------------- */
  const wtAgg = safeGet(db, `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN state = 'active' THEN 1 ELSE 0 END), 0) AS active
    FROM worktrees
  `) || {};
  const worktrees = { total: toInt(wtAgg.total), active: toInt(wtAgg.active) };

  /* ---------------------------- merge queue ---------------------------- */
  const queueRows = safeAll(db, 'SELECT status, COUNT(*) AS c FROM merge_queue GROUP BY status');
  const queue = { total: 0, queued: 0, ready: 0, conflict: 0, failed: 0, validating: 0, merged: 0, mergeable: 0 };
  for (const row of queueRows) {
    const count = toInt(row.c);
    queue.total += count;
    const key = String(row.status || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(queue, key)) queue[key] = count;
  }
  queue.mergeable = queue.ready;

  /* ------------------------------ rooms -------------------------------- */
  const claimAgg = safeGet(db, `SELECT COUNT(*) AS c FROM room_claims WHERE status = 'active' AND lease_expires_at > ?`, new Date(nowMs).toISOString()) || {};
  const rooms = { active_claims: toInt(claimAgg.c) };

  /* ------------------------------- MCP --------------------------------- */
  const mcpAgg = safeGet(db, `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0) AS enabled,
           COALESCE(SUM(CASE WHEN last_probe_ok = 1 THEN 1 ELSE 0 END), 0) AS probed,
           COALESCE(SUM(CASE WHEN last_probe_ok = 1 THEN last_probe_tools_count ELSE 0 END), 0) AS tools
    FROM mcp_servers
  `) || {};
  const mcp = {
    registered: toInt(mcpAgg.total),
    enabled: toInt(mcpAgg.enabled),
    probed: toInt(mcpAgg.probed),
    tools: toInt(mcpAgg.tools),
  };

  /* ----------------------------- lessons ------------------------------- */
  const lessonAgg = safeGet(db, `
    SELECT COUNT(*) AS total,
           COALESCE(SUM(CASE WHEN active = 1 THEN 1 ELSE 0 END), 0) AS active
    FROM incident_lessons
  `) || {};
  const lessons = { total: toInt(lessonAgg.total), active: toInt(lessonAgg.active) };

  /* ------------------------------ health ------------------------------- */
  let health;
  try {
    const summary = getSelfImproveSummary(db, worktreeDir ? { worktreeDir } : undefined);
    health = {
      score: Number.isFinite(summary?.health_score) ? summary.health_score : null,
      overall: summary?.overall || 'unknown',
      findings: toInt(summary?.findings_count),
      healable: toInt(summary?.healable_count),
      active_lessons: toInt(summary?.active_lessons),
      last_heal_at: summary?.last_heal_at || null,
    };
  } catch {
    health = { score: null, overall: 'unknown', findings: 0, healable: 0, active_lessons: lessons.active, last_heal_at: null };
  }

  /* ------------------------ client usage telemetry --------------------- */
  const usageAgg = safeGet(db, `
    SELECT COUNT(*) AS clients,
           COALESCE(SUM(mcp_calls), 0) AS calls,
           COALESCE(SUM(est_mcp_tokens), 0) AS mcp_tokens
    FROM client_usage_telemetry
  `) || {};
  const usage = {
    connected_clients: toInt(usageAgg.clients),
    mcp_calls: toInt(usageAgg.calls),
    est_mcp_tokens: toInt(usageAgg.mcp_tokens),
  };

  const durationMs = Number(process.hrtime.bigint() - startedNs) / 1e6;

  return {
    generated_at: new Date(nowMs).toISOString(),
    worktree_dir: worktreeDir || null,
    agents: agentCounts,
    tasks,
    worktrees,
    merge_queue: queue,
    rooms,
    mcp,
    lessons,
    usage,
    health,
    duration_ms: Math.round(durationMs * 100) / 100,
  };
}

/* -------------------------------------------------------------------------- */
/* Renderers                                                                  */
/* -------------------------------------------------------------------------- */

function healthColor(score, palette = P) {
  if (!Number.isFinite(score)) return palette.slate;
  if (score >= 85) return palette.emerald;
  if (score >= 60) return palette.amber;
  return palette.rose;
}

function agentColor(state, palette = P) {
  switch (String(state || '').toLowerCase()) {
    case 'online': return palette.emerald;
    case 'busy':
    case 'running': return palette.cyan;
    case 'idle': return palette.cyan;
    case 'cooldown':
    case 'stale': return palette.amber;
    case 'error': return palette.rose;
    default: return palette.slate;
  }
}

function healthGlyphValue(health) {
  const score = Number.isFinite(health?.score) ? health.score : null;
  return score === null ? '—' : String(score);
}

/* -------------------------- one-line statusline --------------------------- */

function renderOneLine(snap, { width, level, frame }) {
  const s = makePainter(level);
  const agents = snap.agents || {};
  const tasks = snap.tasks || {};
  const queue = snap.merge_queue || {};
  const mcp = snap.mcp || {};
  const wt = snap.worktrees || {};
  const health = snap.health || {};
  const score = Number.isFinite(health.score) ? health.score : null;
  const hcolor = healthColor(score);
  const pulse = PULSE_FRAMES[mod(frame, PULSE_FRAMES.length)];
  const sep = ` ${s('│', P.slate)} `;

  const brand = `${s(pulse, P.emerald, { bold: true })} ${gradientText('COLLAB HUB', P.indigo, P.cyan, level, { bold: true })}${snap.snapshot_ro ? ` ${s('SNAP', P.amber)}` : ''}`;
  const shortBrand = `${s(pulse, P.emerald, { bold: true })} ${s('HUB', P.indigo, { bold: true })}${snap.snapshot_ro ? ` ${s('SNAP', P.amber)}` : ''}`;
  const healthSeg = `${s('♥', hcolor)}${s(healthGlyphValue(health), hcolor, { bold: true })}`;

  const agentSeg = (agents.items || []).slice(0, 5)
    .map((a) => s(`${a.glyph}${a.symbol}`, agentColor(a.state)))
    .join(' ') || s('NO AGENTS', P.slate);

  const taskSeg = [
    s(`⚡${toInt(tasks.active)}`, P.cyan, { bold: true }),
    s(`⛔${toInt(tasks.failed)}`, tasks.failed ? P.rose : P.slate),
    s(`⏸${toInt(tasks.stalled)}`, tasks.stalled ? P.amber : P.slate),
  ].join(' ');

  const wtSeg = s(`WT${toInt(wt.active)}`, P.slate);
  const mqSeg = [
    s('MQ', P.slate),
    s(`${toInt(queue.ready)}✓`, queue.ready ? P.emerald : P.slate),
    s(`${toInt(queue.conflict)}⚠`, queue.conflict ? P.rose : P.slate),
  ].join(' ');
  const mcpSeg = `${s('MCP', P.slate)}${s(String(toInt(mcp.registered)), P.indigo)}`;
  const usage = snap.usage || {};
  const usageSeg = (usage.connected_clients > 0 || usage.mcp_calls > 0)
    ? `${s('CLI', P.slate)}${s(String(toInt(usage.connected_clients)), P.emerald)}/${s(`${toInt(usage.mcp_calls)}c`, P.cyan)}`
    : null;
  const ageSeg = s(tasks.latest_age_human || '—', P.slate);

  const wideSegs = [brand, healthSeg, agentSeg, taskSeg, wtSeg, mqSeg, mcpSeg, ...(usageSeg ? [usageSeg] : []), ageSeg];
  const tiers = [
    { min: 108, segs: wideSegs },
    { min: 88, segs: [brand, healthSeg, agentSeg, taskSeg, wtSeg, mqSeg, mcpSeg] },
    { min: 70, segs: [shortBrand, healthSeg, agentSeg, taskSeg, mqSeg, mcpSeg] },
    { min: 54, segs: [shortBrand, healthSeg, agentSeg, taskSeg, mqSeg] },
    { min: 40, segs: [shortBrand, healthSeg, taskSeg, mqSeg] },
    { min: 24, segs: [healthSeg, taskSeg] },
    { min: 0, segs: [healthSeg] },
  ];
  const tier = tiers.find((t) => width >= t.min) || tiers[tiers.length - 1];
  const out = tier.segs.join(sep);
  return truncateAnsi(out, width, displayWidth(out) > width ? '…' : '');
}

/* -------------------------------- card ---------------------------------- */

function cardTopBorder(width, score, s) {
  const hcolor = healthColor(score);
  const title = ' COLLAB HUB · MISSION CONTROL ';
  const right = ` ♥${score === null ? '—' : score} `;
  const fixed = 4; // ╭─ ... ─╮
  let titleText = title;
  let rightText = right;
  let pad = width - fixed - displayWidth(titleText) - displayWidth(rightText);
  if (pad < 1) {
    titleText = ' COLLAB HUB ';
    pad = width - fixed - displayWidth(titleText) - displayWidth(rightText);
  }
  if (pad < 1) {
    rightText = '';
    pad = Math.max(0, width - fixed - displayWidth(titleText));
  }
  return `${s('╭─', P.indigo)}${s(titleText, P.white, { bold: true })}${s('─'.repeat(Math.max(0, pad)), P.slate)}${s(rightText, hcolor, { bold: true })}${s(`─╮`, P.indigo)}`;
}

function cardRow(innerWidth, left, right, s) {
  const lw = displayWidth(left);
  const rw = displayWidth(right);
  let leftText = left;
  if (lw + rw + 1 > innerWidth) {
    leftText = truncateAnsi(left, Math.max(1, innerWidth - rw - 1));
  }
  const gap = Math.max(0, innerWidth - displayWidth(leftText) - rw);
  return `${s('│', P.slate)}${leftText}${' '.repeat(gap)}${right}${s('│', P.slate)}`;
}

function healthBar(score, width, s) {
  const bounded = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;
  const color = healthColor(Number.isFinite(score) ? score : null);
  const filled = Math.round((bounded / 100) * width);
  return s('█'.repeat(filled), color) + s('░'.repeat(Math.max(0, width - filled)), P.slate);
}

function renderCard(snap, { width, level, frame }) {
  const s = makePainter(level);
  const W = clampInt(width, 16, 78, 68);
  const inner = W - 2;
  const agents = snap.agents || {};
  const tasks = snap.tasks || {};
  const queue = snap.merge_queue || {};
  const mcp = snap.mcp || {};
  const wt = snap.worktrees || {};
  const lessons = snap.lessons || {};
  const health = snap.health || {};
  const score = Number.isFinite(health.score) ? health.score : null;
  const hcolor = healthColor(score);
  const pulse = PULSE_FRAMES[mod(frame, PULSE_FRAMES.length)];

  const glyphs = (agents.items || []).slice(0, 5)
    .map((a) => s(`${a.glyph}${a.symbol}`, agentColor(a.state)))
    .join(' ') || s('—', P.slate);

  const rows = [];
  rows.push(cardRow(inner,
    ` ${s(pulse, P.emerald)} ${s('FLEET', P.slate)}  ${glyphs}`,
    `${s(`${toInt(agents.online)}/${toInt(agents.total)}`, P.emerald, { bold: true })} `, s));
  rows.push(cardRow(inner,
    ` ${s('⚡', P.cyan)} ${s('TASKS', P.slate)}  ${s(`active ${toInt(tasks.active)}`, P.cyan)} · ${s(`failed ${toInt(tasks.failed)}`, tasks.failed ? P.rose : P.slate)} · ${s(`stalled ${toInt(tasks.stalled)}`, tasks.stalled ? P.amber : P.slate)} · ${s(`done ${toInt(tasks.completed)}`, P.emerald)}`,
    `${s('⏱', P.slate)} ${s(tasks.latest_age_human || '—', P.slate)} `, s));
  rows.push(cardRow(inner,
    ` ${s('▦', P.indigo)} ${s('WORKTREES', P.slate)} ${s(String(toInt(wt.active)), P.indigo)}   ${s('⧉', P.indigo)} ${s('MERGE', P.slate)} ${s(`${toInt(queue.ready)} ready`, queue.ready ? P.emerald : P.slate)} · ${s(`${toInt(queue.conflict)} conflict`, queue.conflict ? P.rose : P.slate)}`,
    '', s));
  rows.push(cardRow(inner,
    ` ${s('⚙', P.indigo)} ${s('MCP', P.slate)} ${s(String(toInt(mcp.registered)), P.indigo)} registered · ${s(`${toInt(mcp.tools)} tools`, P.cyan)}   ${s('▤', P.indigo)} ${s(`${toInt(lessons.active)} lessons`, P.slate)}`,
    '', s));

  const barW = Math.min(24, Math.max(6, inner - 34));
  const overall = String(health.overall || 'unknown').toUpperCase();
  rows.push(cardRow(inner,
    ` ${s('♥', hcolor)} ${s('HEALTH', P.slate)} ${healthBar(score, barW, s)} ${s(score === null ? '—' : String(score), hcolor, { bold: true })} ${s(overall, hcolor)}`,
    '', s));

  if (tasks.latest) {
    rows.push(cardRow(inner,
      ` ${s('◆', P.indigo)} ${s('LATEST', P.slate)} ${s(sanitizeTerminalText(String(tasks.latest.state || '')).toUpperCase(), P.cyan)} ${truncateAnsi(sanitizeTerminalText(tasks.latest.title || tasks.latest.task_id || ''), Math.max(4, inner - 24), '…')}`,
      '', s));
  }

  const top = cardTopBorder(W, score, s);
  const bottom = `${s('╰', P.indigo)}${s('─'.repeat(Math.max(0, W - 2)), P.slate)}${s('╯', P.indigo)}`;
  return [top, ...rows, bottom].join('\n');
}

/* -------------------------------- json ---------------------------------- */

function renderJson(snap) {
  const agents = snap.agents || {};
  const tasks = snap.tasks || {};
  const queue = snap.merge_queue || {};
  const mcp = snap.mcp || {};
  const wt = snap.worktrees || {};
  const health = snap.health || {};
  return JSON.stringify({
    ts: snap.generated_at || null,
    health: Number.isFinite(health.score) ? health.score : null,
    overall: health.overall || 'unknown',
    agents: { online: toInt(agents.online), total: toInt(agents.total) },
    tasks: {
      active: toInt(tasks.active),
      failed: toInt(tasks.failed),
      stalled: toInt(tasks.stalled),
      completed: toInt(tasks.completed),
      latest_age: tasks.latest_age_human || null,
    },
    worktrees: { active: toInt(wt.active) },
    merge_queue: { ready: toInt(queue.ready), conflict: toInt(queue.conflict), queued: toInt(queue.queued) },
    mcp: { registered: toInt(mcp.registered), tools: toInt(mcp.tools) },
    usage: snap.usage || { connected_clients: 0, mcp_calls: 0, est_mcp_tokens: 0 },
  });
}

/**
 * Render a HUD snapshot.
 *
 * @param {object} snap snapshot from collectHudSnapshot()
 * @param {{ width?: number, colorLevel?: number, frame?: number, format?: 'statusline'|'card'|'json' }} [options]
 * @returns {string}
 */
export function renderStatusLine(snap, { width, colorLevel = 0, frame = 0, format = 'statusline' } = {}) {
  const safeSnap = snap || {};
  const level = clampInt(colorLevel, 0, 3, 0);
  const cols = clampInt(width, 20, 400, 100);
  const tick = Number.isFinite(frame) ? Math.floor(frame) : 0;
  if (format === 'json') return renderJson(safeSnap);
  if (format === 'card') return renderCard(safeSnap, { width: cols, level, frame: tick });
  return renderOneLine(safeSnap, { width: cols, level, frame: tick });
}

/* -------------------------------------------------------------------------- */
/* CLI driver                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Read an optional JSON document from stdin without ever hanging a TTY.
 * Returns null on TTY, empty input, timeout or malformed JSON.
 */
export function readStdinJson({ timeoutMs = 250, stream = process.stdin } = {}) {
  return new Promise((resolve) => {
    if (!stream || stream.isTTY || stream.readableEnded) {
      resolve(null);
      return;
    }
    let buffer = '';
    let settled = false;
    let timer = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      try { stream.off('data', onData); } catch {}
      try { stream.off('end', finish); } catch {}
      try { stream.off('error', finish); } catch {}
      try { stream.pause(); } catch {}
      const text = buffer.trim();
      if (!text) { resolve(null); return; }
      try { resolve(JSON.parse(text)); } catch { resolve(null); }
    };

    const onData = (chunk) => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) { finish(); return; }
      // Compact statusLine JSON ends with a newline: parse eagerly and stop.
      // Pretty-printed / multi-line JSON simply needs another chunk or the timeout.
      if (buffer.includes('\n')) {
        const text = buffer.trim();
        if (!text) return;
        try { JSON.parse(text); finish(); } catch { /* wait for the rest */ }
      }
    };

    timer = setTimeout(finish, Math.max(20, Math.min(5000, timeoutMs)));
    try {
      stream.setEncoding('utf8');
      stream.on('data', onData);
      stream.once('end', finish);
      stream.once('error', finish);
      if (typeof stream.resume === 'function') stream.resume();
    } catch {
      finish();
    }
  });
}

/**
 * Print (or live-update) the HUD.
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   format?: 'statusline'|'card'|'json',
 *   watch?: boolean,
 *   intervalMs?: number,
 *   width?: number,
 *   stdinJson?: object|string|null,
 *   worktreeDir?: string,
 *   reopenDb?: (() => import('node:sqlite').DatabaseSync|null)|null,
 *   stream?: NodeJS.WriteStream,
 *   env?: Record<string, string|undefined>,
 * }} [options]
 * @returns {Promise<{ snapshot: object, rendered: string, stop: () => void }>}
 */
export async function runHudCli(db, {
  format = 'statusline',
  watch = false,
  intervalMs = 250,
  width,
  stdinJson = null,
  worktreeDir,
  reopenDb = null,
  stream = process.stdout,
  env = process.env,
} = {}) {
  // `db` is a parameter, so all reads go through a mutable handle. In watch mode
  // `reopenDb` can hand us a fresh handle every ~4s (SQLite WAL rollover, a new
  // snapshot file, …); `ownedDb` tracks the handle we opened and must close.
  let activeDb = db;
  let ownedDb = null;
  let context = stdinJson;
  if (typeof context === 'string') {
    try { context = JSON.parse(context); } catch { context = null; }
  }
  if (context === null || context === undefined) {
    context = await readStdinJson();
  }

  let snapshot = collectHudSnapshot(activeDb, { worktreeDir });
  if (context && typeof context === 'object') snapshot.context = context;

  const colorLevel = detectColorSupport({ stream, env, allowPipedAnsi: Boolean(context) }).level;
  let frame = 0;
  let stopped = false;
  let timer = null;
  let cursorHidden = false;
  let altScreen = false;

  const columns = () => clampInt(width || stream?.columns || 100, 10, 400, 100);
  const paint = () => renderStatusLine(snapshot, {
    width: columns(),
    colorLevel,
    frame,
    format: format === 'card' ? 'card' : (format === 'json' ? 'json' : 'statusline'),
  });

  // Swap in a fresh handle without ever dropping the one we still hold: any
  // failure (throw, unusable handle, self-return) leaves `activeDb` untouched.
  const tryReopen = () => {
    if (!watch) return false;
    if (typeof reopenDb !== 'function') return false;
    // Gate on the CALLER's handle: that is the one that proved WSL could not open the
    // live WAL. A later replacement may well come back without the flag (the plain
    // read-only open succeeds once the lock clears) and must not kill the refresh loop.
    if (db?.__collabHubSnapshot !== true) return false;
    let next = null;
    try {
      next = reopenDb();
    } catch {
      return false;
    }
    if (!next || typeof next.prepare !== 'function') {
      if (next) { try { if (typeof next.close === 'function') next.close(); } catch {} }
      return false;
    }
    if (next === activeDb) return false;
    const prev = activeDb;
    activeDb = next;
    ownedDb = next;
    if (prev !== db && prev !== next) {
      try { if (typeof prev.close === 'function') prev.close(); } catch {}
    }
    try {
      const fresh = collectHudSnapshot(activeDb, { worktreeDir });
      if (snapshot.context) fresh.context = snapshot.context;
      snapshot = fresh;
    } catch { /* keep the last good snapshot */ }
    return true;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (timer) clearInterval(timer);
    if (cursorHidden || altScreen) {
      try {
        stream.write(`\x1b[0m${cursorHidden ? '\x1b[?25h' : ''}${altScreen ? '\x1b[?1049l' : ''}`);
      } catch {}
    }
    try {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      process.off('SIGHUP', onSignal);
      process.off('exit', stop);
    } catch {}
    if (ownedDb && ownedDb !== db && ownedDb === activeDb) {
      try { if (typeof ownedDb.close === 'function') ownedDb.close(); } catch {}
      ownedDb = null;
    }
  };

  const onSignal = () => {
    stop();
    try { stream.write('\n'); } catch {}
    process.exitCode = 0;
  };

  let rendered = paint();

  if (!watch || !stream?.isTTY) {
    try { stream.write(`${rendered}\n`); } catch {}
    stop();
    return { snapshot, rendered, stop };
  }

  const tick = Math.max(100, Math.min(1000, Math.round(Number(intervalMs) || 250)));
  let tickCount = 0;
  if (format === 'card') {
    try { stream.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H'); altScreen = true; cursorHidden = true; } catch {}
  } else {
    try { stream.write('\x1b[?25l'); cursorHidden = true; } catch {}
  }
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('SIGHUP', onSignal);
  process.once('exit', stop);

  const draw = () => {
    if (stopped) return;
    frame += 1;
    tickCount += 1;
    // Re-open the SQLite handle about once per 4s (16 ticks at the default
    // 250 ms cadence) so a rotating/rollover DB stays visible.
    if (tickCount % 16 === 0) { tryReopen(); }
    // Refresh the SQLite snapshot about once per second (4 ticks at the default
    // 250 ms cadence) while keeping the animation at a full 4 fps.
    if (tickCount % 4 === 0) {
      try {
        const fresh = collectHudSnapshot(activeDb, { worktreeDir });
        if (snapshot.context) fresh.context = snapshot.context;
        snapshot = fresh;
      } catch { /* keep the last good snapshot */ }
    }
    rendered = paint();
    try {
      if (format === 'card') stream.write(`\x1b[H\x1b[J${rendered}`);
      else stream.write(`\r\x1b[2K${rendered}`);
    } catch {}
  };

  if (format === 'card') {
    try { stream.write('\x1b[2J\x1b[H'); } catch {}
    try { stream.write(rendered); } catch {}
  } else {
    try { stream.write(rendered); } catch {}
  }

  // Deliberately keep the process alive while watch mode is active.
  timer = setInterval(draw, tick);

  return { snapshot, rendered, stop };
}

export default {
  collectHudSnapshot,
  detectColorSupport,
  renderStatusLine,
  runHudCli,
};
