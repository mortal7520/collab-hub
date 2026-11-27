/**
 * CollabHub v2.0 — Cyber-precision Animated Terminal Mission Control Cockpit.
 *
 * `collab-hub tui` (see startInteractiveTui) renders a full-width 24-bit TrueColor
 * dashboard for Windows Terminal (Codex CLI / Claude Code) and WSL DSH.
 *
 * Two very different consumers are supported:
 *   - `renderTuiFrame(data, uiState)` is a PURE deterministic string renderer.
 *     Given the same data + uiState it always returns the same frame, so the whole
 *     visual layer is unit-testable without a TTY.
 *   - `startInteractiveTui(db, { demo, fps })` owns the terminal: alt-screen,
 *     raw key handling, dirty-frame diffing, 4 s data refresh, clean restore.
 *
 * Rendering never touches SQLite, the network or subprocesses. Data collection
 * happens on refresh only (start + `r` + every 4 s), always outside the 8–10 fps
 * paint timer.
 */

import path from 'node:path';

import {
  collectHudSnapshot,
  detectColorSupport,
  displayWidth,
  formatAge,
  gradientText,
  makePainter,
  padAnsi,
  truncateAnsi,
} from './hud.mjs';
import { buildMcpHubSnapshot } from './mcp-hub.mjs';
import { buildSkillsRulesSnapshot } from './skills-hub.mjs';

/* -------------------------------------------------------------------------- */
/* Palette & constants                                                        */
/* -------------------------------------------------------------------------- */

const P = Object.freeze({
  obsidian: '#0b0e14',
  panel: '#1e293b',
  indigo: '#818cf8',
  cyan: '#38bdf8',
  emerald: '#34d399',
  amber: '#fbbf24',
  rose: '#fb7185',
  slate: '#64748b',
  white: '#e2e8f0',
  violet: '#a78bfa',
});

export const TUI_TABS = Object.freeze(['Radar', 'Kanban & Logs', 'MCP Hub', 'Skills & Rules', 'Merge Queue']);

const PULSE_FRAMES = Object.freeze(['◉', '◎', '●']);

const STATE_PRIORITY = Object.freeze({
  running: 0,
  dispatching: 0,
  dispatched: 1,
  queued: 2,
  needs_input: 3,
  stalled: 4,
  uncertain: 4,
  failed: 5,
  completed: 6,
  cancelled: 7,
  rerouted: 7,
});

const TASK_STATE_COLORS = Object.freeze({
  running: P.cyan,
  dispatching: P.cyan,
  dispatched: P.cyan,
  queued: P.indigo,
  stalled: P.amber,
  uncertain: P.amber,
  needs_input: P.amber,
  failed: P.rose,
  completed: P.emerald,
  cancelled: P.slate,
  rerouted: P.slate,
});

const CLIENT_ABBREV = Object.freeze({
  antigravity: 'AGY',
  agy: 'AGY',
  claude: 'CLD',
  codex: 'CDX',
  cursor: 'CUR',
  windsurf: 'WND',
  vscode: 'VSC',
  zed: 'ZED',
  claudecli: 'CLI',
});

const MERGE_STATUS = Object.freeze({
  validating: { label: 'VALIDATE', color: P.amber },
  ready: { label: 'READY', color: P.emerald },
  queued: { label: 'QUEUED', color: P.cyan },
  conflict: { label: 'CONFLICT', color: P.rose },
  failed: { label: 'FAILED', color: P.rose },
  merged: { label: 'MERGED', color: P.emerald },
});

/* -------------------------------------------------------------------------- */
/* Tiny helpers                                                               */
/* -------------------------------------------------------------------------- */

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function mod(n, m) {
  return ((n % m) + m) % m;
}

function plainPad(text, width) {
  const str = String(text ?? '');
  return str + ' '.repeat(Math.max(0, width - displayWidth(str)));
}

function plainFit(text, width) {
  return plainPad(truncateAnsi(String(text ?? ''), width), width);
}

function safeAll(db, sql, ...params) {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    return [];
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function timeOf(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '--:--:--';
  return new Date(ms).toISOString().slice(11, 19);
}

function ageOf(iso, baseIso) {
  const ms = Date.parse(iso);
  const base = Date.parse(baseIso);
  if (!Number.isFinite(ms) || !Number.isFinite(base)) return '—';
  return formatAge(Math.max(0, base - ms));
}

function stateColor(state) {
  return TASK_STATE_COLORS[String(state || '').toLowerCase()] || P.slate;
}

function agentColor(state) {
  switch (String(state || '').toLowerCase()) {
    case 'online': return P.emerald;
    case 'busy':
    case 'running':
    case 'idle': return P.cyan;
    case 'cooldown':
    case 'stale': return P.amber;
    case 'error': return P.rose;
    default: return P.slate;
  }
}

function healthColor(score) {
  if (!Number.isFinite(score)) return P.slate;
  if (score >= 85) return P.emerald;
  if (score >= 60) return P.amber;
  return P.rose;
}

function healthMeter(score, width, s) {
  const bounded = Number.isFinite(score) ? Math.min(100, Math.max(0, score)) : 0;
  const color = healthColor(Number.isFinite(score) ? score : null);
  const filled = Math.round((bounded / 100) * width);
  return s('█'.repeat(filled), color) + s('░'.repeat(Math.max(0, width - filled)), P.slate);
}

function taskStatsFrom(tasks) {
  const stats = { total: tasks.length, active: 0, queued: 0, failed: 0, stalled: 0, completed: 0 };
  for (const task of tasks) {
    const state = String(task.state || '').toLowerCase();
    if (['running', 'dispatching', 'dispatched'].includes(state)) stats.active += 1;
    else if (state === 'queued') stats.queued += 1;
    else if (state === 'failed') stats.failed += 1;
    else if (['stalled', 'uncertain', 'needs_input'].includes(state)) stats.stalled += 1;
    else if (state === 'completed') stats.completed += 1;
  }
  return stats;
}

function orderedTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const pa = STATE_PRIORITY[String(a.state || '').toLowerCase()] ?? 9;
    const pb = STATE_PRIORITY[String(b.state || '').toLowerCase()] ?? 9;
    if (pa !== pb) return pa - pb;
    const ta = Date.parse(a.updated_at);
    const tb = Date.parse(b.updated_at);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return String(a.task_id || '').localeCompare(String(b.task_id || ''));
  });
}

function clientAbbrev(id) {
  const key = String(id || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return CLIENT_ABBREV[key] || key.slice(0, 3).toUpperCase() || 'CLI';
}

function mergeBadge(status, s) {
  const meta = MERGE_STATUS[String(status || '').toLowerCase()] || { label: String(status || '?').toUpperCase(), color: P.slate };
  return s(plainPad(meta.label, 10), meta.color, { bold: true });
}

/* -------------------------------------------------------------------------- */
/* Frame primitives                                                           */
/* -------------------------------------------------------------------------- */

function boxRow(innerWidth, left, right, s) {
  let l = truncateAnsi(left, innerWidth);
  const lw = displayWidth(l);
  if (lw >= innerWidth) return `${s('│', P.slate)}${l}${s('│', P.slate)}`;
  let r = truncateAnsi(right, Math.max(0, innerWidth - lw - 1));
  const gap = Math.max(1, innerWidth - lw - displayWidth(r));
  return `${s('│', P.slate)}${l}${' '.repeat(gap)}${r}${s('│', P.slate)}`;
}

function sectionBar(ctx, label) {
  const { s, inner } = ctx;
  const plain = `── ${label} `;
  const fill = Math.max(0, inner - displayWidth(plain));
  return `${s('── ', P.slate)}${s(label, P.indigo, { bold: true })} ${s('─'.repeat(fill), P.slate)}`;
}

function alignRow(ctx, left, right = '') {
  const { inner } = ctx;
  const l = truncateAnsi(left, inner);
  const lw = displayWidth(l);
  if (lw >= inner) return l;
  const r = truncateAnsi(right, Math.max(0, inner - lw - 1));
  return l + ' '.repeat(Math.max(1, inner - lw - displayWidth(r))) + r;
}

function fillLine(ctx, text) {
  return plainPad(truncateAnsi(text, ctx.inner), ctx.inner);
}

/* -------------------------------------------------------------------------- */
/* Tab 1 — Radar                                                              */
/* -------------------------------------------------------------------------- */

function drawLine(x0, y0, x1, y1, visit) {
  let x = x0;
  let y = y0;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  const total = Math.max(dx, -dy);
  let step = 0;
  for (;;) {
    visit(x, y, step, total);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
    step += 1;
    if (step > 4096) break;
  }
}

function renderOrbit(agents, { width, height, frame, s, animate = true }) {
  const grid = Array.from({ length: height }, () => Array.from({ length: width }, () => ({ ch: ' ', color: null, bold: false })));
  const put = (x, y, ch, color, bold = false) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    grid[y][x] = { ch, color, bold };
  };

  const cx = Math.floor(width / 2);
  const cy = Math.floor((height - 1) / 2);
  const rx = Math.max(6, Math.min(30, Math.floor(width / 2) - 9));
  const ry = Math.max(1, Math.min(cy, 2));

  // Spokes first so labels / hub overwrite their endpoints.
  const nodes = agents.slice(0, 8).map((agent, index) => {
    const angle = -Math.PI / 2 + (2 * Math.PI * index) / Math.max(1, Math.min(agents.length, 8)) + (animate ? frame * 0.035 : 0);
    return {
      agent,
      x: Math.round(cx + Math.cos(angle) * rx),
      y: Math.round(cy + Math.sin(angle) * ry),
    };
  });

  for (const node of nodes) {
    drawLine(cx, cy, node.x, node.y, (x, y, step, total) => {
      if (x === cx && y === cy) return;
      if (step < 3 || step > total - 5) return;
      put(x, y, '·', P.slate);
    });
  }

  // Moving data pulses.
  nodes.forEach((node, index) => {
    const phase = animate ? frame * 0.5 : 0;
    const t1 = mod(phase + index * 1.9, 11) / 11;
    const t2 = mod(phase + index * 1.9 + 5.5, 11) / 11;
    const trails = animate ? [[t1, '•'], [t2, '◦']] : [[t1, '•']];
    for (const [t, ch] of trails) {
      const px = Math.round(cx + (node.x - cx) * t);
      const py = Math.round(cy + (node.y - cy) * t);
      if (Math.abs(px - cx) <= 2 && Math.abs(py - cy) <= 1) continue;
      put(px, py, ch, node.agent.online ? P.cyan : P.slate, ch === '•');
    }
  });

  // Central hub.
  const hub = '[HUB]';
  const hubX = cx - Math.floor(hub.length / 2);
  for (let i = 0; i < hub.length; i += 1) {
    put(hubX + i, cy, hub[i], i === 0 || i === hub.length - 1 ? P.indigo : P.cyan, true);
  }

  // Agent labels.
  nodes.forEach((node) => {
    const label = `${node.agent.glyph || 'AGT'}${node.agent.symbol || '○'}`;
    let lx = node.x >= cx ? node.x - label.length + 1 : node.x;
    lx = Math.min(width - label.length - 1, Math.max(1, lx));
    for (let i = 0; i < label.length; i += 1) {
      put(lx + i, node.y, label[i], agentColor(node.agent.state), true);
    }
  });

  return grid.map((row) => row.map((cell) => (cell.color ? s(cell.ch, cell.color, { bold: cell.bold }) : cell.ch)).join(''));
}

function renderRadarTab(ctx) {
  const { d, s, inner, contentH, frame } = ctx;
  const agents = Array.isArray(d.agents) ? d.agents : [];
  const lines = [];
  const baseIso = d.generated_at;

  const orbitHeight = inner >= 46 && contentH >= 14 ? Math.min(7, Math.max(5, contentH - 12)) : 0;
  const animate = (Number(d.stats?.active) || 0) > 0 || agents.some((agent) => agent.state === 'busy' || agent.state === 'running');
  if (orbitHeight > 0 && agents.length > 0) {
    lines.push(...renderOrbit(agents, { width: inner, height: orbitHeight, frame, s, animate }));
  } else {
    lines.push(sectionBar(ctx, 'AGENT CONSTELLATION'));
  }

  lines.push(sectionBar(ctx, 'FLEET'));

  const agentW = 7;
  const stateW = 11;
  const seenW = 6;
  const chanW = Math.max(8, inner - agentW - stateW - seenW - 3);
  lines.push(
    `${plainFit(s('AGENT', P.slate), agentW)} `
    + `${plainFit(s('STATE', P.slate), stateW)} `
    + `${plainFit(s('CHANNEL', P.slate), chanW)} `
    + `${plainFit(s('SEEN', P.slate), seenW)}`,
  );

  const agentLimit = Math.max(1, Math.min(agents.length, contentH - lines.length - 4));
  for (const agent of agents.slice(0, agentLimit)) {
    const color = agentColor(agent.state);
    const seen = Number.isFinite(agent.age_s) ? formatAge(agent.age_s * 1000) : '—';
    lines.push(
      `${plainFit(s(`${agent.glyph || 'AGT'}${agent.symbol || '○'}`, color, { bold: true }), agentW)} `
      + `${plainFit(s(String(agent.state || 'unknown').toUpperCase(), color), stateW)} `
      + `${plainFit(s(agent.channel || '—', P.slate), chanW)} `
      + `${plainFit(s(seen, P.slate), seenW)}`,
    );
  }

  const events = Array.isArray(d.events) ? d.events : [];
  const remaining = contentH - lines.length - 2;
  if (remaining >= 2) {
    lines.push(sectionBar(ctx, 'RECENT EVENTS'));
    if (events.length === 0) {
      lines.push(fillLine(ctx, `  ${s('(no events recorded yet)', P.slate)}`));
    } else {
      for (const event of events.slice(0, Math.max(1, remaining - 1))) {
        const type = s(truncateAnsi(String(event.event_type || 'event'), 22), P.cyan);
        const actor = s(String(event.actor || 'system'), P.indigo);
        const task = s(String(event.task_id || ''), P.slate);
        lines.push(fillLine(ctx, `  ${s(timeOf(event.created_at), P.slate)}  ${plainFit(type, 22)} ${plainFit(actor, 9)} ${task}`));
      }
    }
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Tab 2 — Kanban & Logs                                                      */
/* -------------------------------------------------------------------------- */

function laneCounts(tasks) {
  const counts = { active: 0, queued: 0, attention: 0, done: 0 };
  for (const task of tasks) {
    const state = String(task.state || '').toLowerCase();
    if (['running', 'dispatching', 'dispatched'].includes(state)) counts.active += 1;
    else if (state === 'queued') counts.queued += 1;
    else if (['stalled', 'uncertain', 'needs_input', 'failed'].includes(state)) counts.attention += 1;
    else if (state === 'completed') counts.done += 1;
  }
  return counts;
}

function renderKanbanTab(ctx) {
  const { d, s, inner, contentH, selected } = ctx;
  const tasks = orderedTasks(Array.isArray(d.tasks) ? d.tasks : []);
  const counts = laneCounts(tasks);
  const lines = [];

  const lanes = [
    { label: 'ACTIVE', value: counts.active, color: P.cyan },
    { label: 'QUEUED', value: counts.queued, color: P.indigo },
    { label: 'ATTENTION', value: counts.attention, color: P.amber },
    { label: 'DONE', value: counts.done, color: P.emerald },
  ];
  lines.push(fillLine(ctx, ` ${lanes.map((lane) => `${s('▌', lane.color)} ${s(lane.label, P.slate)} ${s(String(lane.value), lane.color, { bold: true })}`).join('   ')}`));
  lines.push('');

  if (tasks.length === 0) {
    lines.push(fillLine(ctx, `  ${s('(no tasks in the hub yet)', P.slate)}`));
    return lines;
  }

  const sel = Math.min(selected, tasks.length - 1);
  const listH = Math.max(3, Math.min(9, contentH - 12));
  const start = Math.max(0, Math.min(sel - Math.floor(listH / 2), Math.max(0, tasks.length - listH)));
  const slice = tasks.slice(start, start + listH);

  const markerW = 2;
  const stateW = 10;
  const memberW = 7;
  const ageW = 5;
  const titleW = Math.max(8, inner - markerW - stateW - memberW - ageW - 4);

  lines.push(
    `${' '.repeat(markerW)}${plainFit(s('STATE', P.slate), stateW)} `
    + `${plainFit(s('MEMBER', P.slate), memberW)} `
    + `${plainFit(s('TITLE', P.slate), titleW)} `
    + `${plainFit(s('AGE', P.slate), ageW)}`,
  );

  slice.forEach((task, offset) => {
    const index = start + offset;
    const isSel = index === sel;
    const color = stateColor(task.state);
    const marker = isSel ? s('▶', P.amber, { bold: true }) : ' ';
    const stateCell = s(plainFit(String(task.state || '?').toUpperCase(), stateW), color, { bold: isSel });
    const memberCell = plainFit(s(String(task.member || '—'), P.indigo), memberW);
    const titleCell = plainFit(s(truncateAnsi(String(task.title || task.task_id || ''), titleW), isSel ? P.white : P.slate, { bold: isSel }), titleW);
    const ageCell = plainFit(s(ageOf(task.updated_at, d.generated_at), P.slate), ageW);
    lines.push(`${marker} ${stateCell} ${memberCell} ${titleCell} ${ageCell}`);
  });

  const below = tasks.length - (start + slice.length);
  if (start > 0 || below > 0) {
    const hint = [start > 0 ? `▲ ${start} above` : '', below > 0 ? `▼ ${below} below` : ''].filter(Boolean).join(' · ');
    lines.push(fillLine(ctx, `  ${s(hint, P.slate)}`));
  }

  const selectedTask = tasks[sel];
  const logH = Math.max(3, Math.min(8, contentH - lines.length - 3));
  lines.push(sectionBar(ctx, `LOG TAIL · ${selectedTask.task_id} · ${String(selectedTask.state || '').toUpperCase()}`));

  const logs = (d.logs && d.logs[selectedTask.task_id]) || [];
  if (logs.length === 0) {
    lines.push(fillLine(ctx, `  ${s('(no log lines yet — output streams here)', P.slate)}`));
  } else {
    for (const log of logs.slice(-logH)) {
      const stream = String(log.stream || 'stdout').toLowerCase();
      const streamColor = stream === 'stderr' ? P.rose : (stream === 'system' ? P.amber : P.cyan);
      const text = String(log.text || '').replace(/\s+/g, ' ').trim();
      lines.push(fillLine(ctx, `  ${s(timeOf(log.created_at), P.slate)} ${plainFit(s(stream, streamColor), 7)} ${truncateAnsi(text, Math.max(4, inner - 20))}`));
    }
  }

  lines.push(fillLine(ctx, alignRow(ctx, ` ${s('↑↓', P.cyan)} select · ${s(`${sel + 1}/${tasks.length}`, P.indigo)}`, `${s('r', P.cyan)} ${s('refresh logs', P.slate)}`)));
  return lines;
}

/* -------------------------------------------------------------------------- */
/* Tab 3 — MCP Hub                                                            */
/* -------------------------------------------------------------------------- */

function resolveMcpClients(mcp) {
  const detected = Array.isArray(mcp?.clients) ? mcp.clients.filter((c) => c.exists !== false) : [];
  if (detected.length > 0) return detected.slice(0, 5);
  const keys = new Set();
  for (const server of (Array.isArray(mcp?.servers) ? mcp.servers : [])) {
    for (const key of Object.keys(server.client_presence || {})) keys.add(key);
  }
  if (keys.size > 0) return [...keys].slice(0, 5).map((id) => ({ id, name: id, exists: true }));
  return [];
}

function renderMcpTab(ctx) {
  const { d, s, inner, contentH } = ctx;
  const mcp = d.mcp || {};
  const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
  const summary = mcp.summary || {};
  const clients = resolveMcpClients(mcp);
  const lines = [];

  lines.push(fillLine(ctx, ` ${s('REGISTERED', P.slate)} ${s(String(summary.registered_count ?? servers.length), P.indigo, { bold: true })}`
    + `   ${s('CLIENTS', P.slate)} ${s(String(summary.clients_detected ?? clients.length), P.emerald)}`
    + `   ${s('SYNCED', P.slate)} ${s(String(summary.synced_pairs ?? 0), P.emerald)}`
    + `   ${s('DRIFT', P.slate)} ${s(String(summary.drift_count ?? 0), (summary.drift_count || 0) > 0 ? P.amber : P.slate)}`
    + `   ${s('TOOLS', P.slate)} ${s(String(summary.cached_tools_total ?? 0), P.cyan)}`));
  lines.push('');

  if (servers.length === 0) {
    lines.push(fillLine(ctx, `  ${s('(no MCP servers registered — run collab-hub MCP import)', P.slate)}`));
    return lines;
  }

  const serverW = Math.max(10, Math.min(24, inner - 12 - clients.length * 5 - 6));
  const transportW = 9;
  const toolsW = 5;
  const clientW = 4;

  let header = `${plainFit(s('SERVER', P.slate), serverW)} ${plainFit(s('TRANSPORT', P.slate), transportW)} `;
  for (const client of clients) header += `${plainFit(s(clientAbbrev(client.id), P.slate), clientW)}`;
  header += ` ${plainFit(s('TOOLS', P.slate), toolsW)}`;
  lines.push(header);

  const limit = Math.max(1, Math.min(servers.length, contentH - lines.length - 4));
  for (const server of servers.slice(0, limit)) {
    const enabled = server.enabled !== false;
    const nameColor = enabled ? P.white : P.slate;
    let row = `${plainFit(s(truncateAnsi(String(server.id || server.name || '?'), serverW), nameColor), serverW)} `;
    row += `${plainFit(s(String(server.transport || '—'), P.slate), transportW)} `;
    for (const client of clients) {
      const presence = (server.client_presence || {})[client.id];
      const sym = presence === 'present' ? '●' : (presence === 'drifted' ? '◐' : (presence === 'missing' ? '○' : '·'));
      const color = presence === 'present' ? P.emerald : (presence === 'drifted' ? P.amber : P.slate);
      row += `${plainFit(s(sym, color, { bold: presence === 'present' }), clientW)}`;
    }
    const tools = Number.isFinite(server.last_probe_tools_count)
      ? server.last_probe_tools_count
      : (Number.isFinite(server.tools) ? server.tools : null);
    row += ` ${plainFit(s(tools === null ? '—' : String(tools), P.cyan), toolsW)}`;
    lines.push(row);
  }

  const driftRows = [];
  for (const server of servers) {
    for (const client of clients) {
      if ((server.client_presence || {})[client.id] === 'drifted') {
        driftRows.push(`  ${s('◐', P.amber)} ${s(String(server.id || '?'), P.white)} ${s('→', P.slate)} ${s(client.name || client.id, P.indigo)} ${s('drifted', P.amber)}`);
      }
    }
  }
  if (driftRows.length > 0 && lines.length < contentH - 1) {
    lines.push(sectionBar(ctx, 'DRIFT MATRIX'));
    for (const row of driftRows.slice(0, Math.max(1, contentH - lines.length - 1))) lines.push(fillLine(ctx, row));
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Tab 4 — Skills & Rules                                                     */
/* -------------------------------------------------------------------------- */

function renderSkillsTab(ctx) {
  const { d, s, inner, contentH } = ctx;
  const skills = d.skills || {};
  const summary = skills.summary || {};
  const clients = Array.isArray(skills.clients) ? skills.clients.filter((c) => c.exists !== false) : [];
  const skillRows = Array.isArray(skills.skills) ? skills.skills : [];
  const rules = Array.isArray(skills.rules) ? skills.rules : [];
  const lines = [];

  lines.push(fillLine(ctx, ` ${s('SKILLS', P.slate)} ${s(String(summary.skills_total ?? skillRows.length), P.indigo, { bold: true })}`
    + `   ${s('CLIENTS', P.slate)} ${s(String(summary.clients_detected ?? clients.length), P.emerald)}`
    + `   ${s('SYNCED', P.slate)} ${s(String(summary.skill_synced_pairs ?? 0), P.emerald)}`
    + `   ${s('DRIFT', P.slate)} ${s(String(summary.skill_drift_count ?? 0), (summary.skill_drift_count || 0) > 0 ? P.amber : P.slate)}`
    + `   ${s('RULES', P.slate)} ${s(String(summary.rules_detected ?? 0), P.cyan)}`
    + `   ${s('DRIFTED', P.slate)} ${s(String(summary.rules_drifted ?? 0), (summary.rules_drifted || 0) > 0 ? P.amber : P.slate)}`));
  lines.push('');

  if (clients.length > 0) {
    lines.push(fillLine(ctx, ` ${clients.map((client) => `${s('●', P.emerald)} ${s(client.name || client.id, P.white)} ${s(String(client.skills_count ?? 0), P.cyan)}`).join('   ')}`));
    lines.push('');
  }

  if (skillRows.length === 0) {
    lines.push(fillLine(ctx, `  ${s('(no skills discovered for this project)', P.slate)}`));
  } else {
    lines.push(sectionBar(ctx, 'SKILLS'));
    const limit = Math.max(1, Math.min(skillRows.length, contentH - lines.length - rules.length - 3));
    for (const skill of skillRows.slice(0, limit)) {
      const name = plainFit(s(truncateAnsi(String(skill.name || '?'), 24), P.white), 24);
      let presence = '';
      for (const client of clients) {
        const status = (skill.client_presence || {})[client.id];
        const sym = status === 'present' ? '●' : (status === 'drifted' ? '◐' : '○');
        presence += s(sym, status === 'present' ? P.emerald : (status === 'drifted' ? P.amber : P.slate));
      }
      const title = truncateAnsi(String(skill.description || skill.title || ''), Math.max(4, inner - 30 - clients.length));
      lines.push(fillLine(ctx, `  ${presence} ${name} ${s(title, P.slate)}`));
    }
  }

  if (rules.length > 0 && lines.length < contentH - 1) {
    lines.push(sectionBar(ctx, 'PROJECT RULES'));
    for (const rule of rules.slice(0, Math.max(1, contentH - lines.length - 1))) {
      const ok = rule.status === 'present';
      const sym = ok ? '●' : (rule.status === 'drifted' ? '◐' : '○');
      const color = ok ? P.emerald : (rule.status === 'drifted' ? P.amber : P.slate);
      lines.push(fillLine(ctx, `  ${s(sym, color)} ${plainFit(s(String(rule.name || rule.id || '?'), P.white), 16)} ${s(plainPad(String(rule.status || 'missing').toUpperCase(), 8), color)} ${s(String(rule.rel_path || ''), P.slate)}`));
    }
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Tab 5 — Merge Queue                                                        */
/* -------------------------------------------------------------------------- */

function renderMergeTab(ctx) {
  const { d, s, inner, contentH } = ctx;
  const queue = Array.isArray(d.merge_queue) ? d.merge_queue : [];
  const lines = [];

  const counts = { ready: 0, conflict: 0, queued: 0, failed: 0 };
  for (const item of queue) {
    const status = String(item.status || '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(counts, status)) counts[status] += 1;
  }
  lines.push(fillLine(ctx, ` ${s('READY', P.slate)} ${s(String(counts.ready), P.emerald, { bold: true })}`
    + `   ${s('CONFLICT', P.slate)} ${s(String(counts.conflict), counts.conflict ? P.rose : P.slate, { bold: true })}`
    + `   ${s('QUEUED', P.slate)} ${s(String(counts.queued), P.cyan)}`
    + `   ${s('FAILED', P.slate)} ${s(String(counts.failed), counts.failed ? P.rose : P.slate)}`));
  lines.push('');

  if (queue.length === 0) {
    lines.push(fillLine(ctx, `  ${s('(merge queue empty — nothing waiting to land)', P.slate)}`));
    return lines;
  }

  const statusW = 10;
  const taskW = 20;
  const memberW = 7;
  const prioW = 5;
  const branchW = Math.max(8, inner - statusW - taskW - memberW - prioW - 5);
  lines.push(
    `${plainFit(s('STATUS', P.slate), statusW)} ${plainFit(s('TASK', P.slate), taskW)} `
    + `${plainFit(s('BRANCH', P.slate), branchW)} ${plainFit(s('MEMBER', P.slate), memberW)} ${plainFit(s('PRIO', P.slate), prioW)}`,
  );

  let used = lines.length;
  for (const item of queue.slice(0, Math.max(1, contentH - used - 1))) {
    if (used >= contentH) break;
    lines.push(
      `${mergeBadge(item.status, s)} ${plainFit(s(truncateAnsi(String(item.task_id || '?'), taskW), P.white), taskW)} `
      + `${plainFit(s(truncateAnsi(String(item.branch_name || '—'), branchW), P.indigo), branchW)} `
      + `${plainFit(s(String(item.member || '—'), P.slate), memberW)} ${plainFit(s(String(item.priority ?? 100), P.slate), prioW)}`,
    );
    used += 1;

    const conflicts = Array.isArray(item.conflict_files) ? item.conflict_files : [];
    if (conflicts.length > 0 && used < contentH) {
      lines.push(fillLine(ctx, `  ${s('⚠', P.rose)} ${s(conflicts.join(', '), P.rose)}`));
      used += 1;
    } else if (item.check_summary && used < contentH - 1) {
      lines.push(fillLine(ctx, `  ${s('·', P.slate)} ${s(truncateAnsi(String(item.check_summary), Math.max(8, inner - 4)), P.slate)}`));
      used += 1;
    }
  }

  return lines;
}

/* -------------------------------------------------------------------------- */
/* Frame renderer                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Render one complete cockpit frame. Pure & deterministic.
 *
 * @param {object} data output of collectTuiData() (or any object with the same shape)
 * @param {{ width?: number, height?: number, colorLevel?: number, frame?: number,
 *           tab?: number, selected?: number, fps?: number }} [uiState]
 * @returns {string} frame without trailing newline
 */
export function renderTuiFrame(data, uiState = {}) {
  const d = data || {};
  const level = clampInt(uiState.colorLevel ?? d.color_level ?? d.colorLevel ?? 0, 0, 3, 0);
  const s = makePainter(level);
  const W = Math.max(24, Math.min(220, clampInt(uiState.width ?? d.width, 20, 221, 100) - 1));
  const H = Math.max(20, Math.min(80, clampInt(uiState.height ?? d.height, 20, 80, 32)));
  const inner = W - 2;
  const frame = Math.max(0, Math.floor(Number(uiState.frame) || 0));
  const tab = clampInt(uiState.tab, 0, TUI_TABS.length - 1, 0);
  const selected = Math.max(0, Math.floor(Number(uiState.selected) || 0));
  const fps = clampInt(uiState.fps ?? d.fps, 1, 10, 8);
  const stats = d.stats || taskStatsFrom(Array.isArray(d.tasks) ? d.tasks : []);
  const health = d.health || {};
  const score = Number.isFinite(health.score) ? health.score : null;
  const hcolor = healthColor(score);
  const pulse = PULSE_FRAMES[mod(frame, PULSE_FRAMES.length)];
  const ctx = { d, s, inner, contentH: Math.max(6, H - 9), frame, tab, selected, level };

  const lines = [];
  lines.push(`${s('╭', P.indigo)}${s('─'.repeat(W - 2), P.slate)}${s('╮', P.indigo)}`);

  const titleLeft = ` ${s(pulse, P.emerald, { bold: true })} ${gradientText('COLLAB HUB', P.indigo, P.cyan, level, { bold: true })} ${s('·', P.slate)} ${s('MISSION CONTROL', P.white, { bold: true })}`;
  const live = `${s('●', P.emerald, { bold: true })} ${s('LIVE', P.emerald, { bold: true })}`;
  const scoreLabel = score === null ? '—' : String(score);
  const gauge = `${s('♥', hcolor)}${s(scoreLabel, hcolor, { bold: true })} ${healthMeter(score, 10, s)}`;
  lines.push(boxRow(inner, titleLeft, `${live}  ${gauge} `, s));

  const statLeft = ` ${s('⚡', P.cyan)} ${s(String(stats.active || 0), P.cyan, { bold: true })} ${s('active', P.slate)}`
    + `   ${s('⛔', P.rose)} ${s(String(stats.failed || 0), stats.failed ? P.rose : P.slate)}`
    + `   ${s('⏸', P.amber)} ${s(String(stats.stalled || 0), stats.stalled ? P.amber : P.slate)}`
    + `   ${s('▦', P.indigo)} ${s(String(stats.worktrees || 0), P.indigo)} ${s('wt', P.slate)}`
    + `   ${s('⧉', P.indigo)} ${s(String(stats.mq_ready || 0), stats.mq_ready ? P.emerald : P.slate)} ${s('ready', P.slate)}`;
  const statRight = `${s('MCP', P.slate)} ${s(String(stats.mcp_registered || 0), P.indigo)}`
    + `   ${s('SKILLS', P.slate)} ${s(String(stats.skills_total || 0), P.indigo)}`
    + `   ${s(timeOf(d.generated_at), P.slate)} `;
  lines.push(boxRow(inner, statLeft, statRight, s));

  lines.push(`${s('├', P.slate)}${s('─'.repeat(W - 2), P.slate)}${s('┤', P.slate)}`);

  const tabTokens = TUI_TABS.map((name, index) => {
    if (index === tab) {
      return `${s(`[${index + 1}]`, P.obsidian, { bg: P.indigo, bold: true })} ${s(name, P.white, { bold: true })}`;
    }
    return `${s(`[${index + 1}]`, P.slate, { bg: P.panel })} ${s(name, P.slate)}`;
  });
  lines.push(boxRow(inner, ` ${tabTokens.join('  ')} `, '', s));
  lines.push(`${s('├', P.slate)}${s('─'.repeat(W - 2), P.slate)}${s('┤', P.slate)}`);

  let content;
  if (tab === 0) content = renderRadarTab(ctx);
  else if (tab === 1) content = renderKanbanTab(ctx);
  else if (tab === 2) content = renderMcpTab(ctx);
  else if (tab === 3) content = renderSkillsTab(ctx);
  else content = renderMergeTab(ctx);

  const contentH = ctx.contentH;
  const fitted = [];
  for (let i = 0; i < contentH; i += 1) {
    const line = i < content.length ? content[i] : '';
    fitted.push(fillLine(ctx, line));
  }
  for (const line of fitted) lines.push(`${s('│', P.slate)}${line}${s('│', P.slate)}`);

  lines.push(`${s('├', P.slate)}${s('─'.repeat(W - 2), P.slate)}${s('┤', P.slate)}`);
  const keyLeft = ` ${s('1-5', P.cyan)}/${s('Tab', P.cyan)} switch   ${s('↑↓', P.cyan)}/${s('jk', P.cyan)} navigate   ${s('r', P.cyan)} refresh   ${s('q', P.cyan)} quit`;
  const keyRight = `${s(`frame ${String(frame).padStart(4, '0')}`, P.slate)} · ${s(`${fps}fps`, P.slate)} `;
  lines.push(boxRow(inner, keyLeft, keyRight, s));
  lines.push(`${s('╰', P.indigo)}${s('─'.repeat(W - 2), P.slate)}${s('╯', P.indigo)}`);

  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* Data collection                                                            */
/* -------------------------------------------------------------------------- */

const HEAVY_CACHE = new WeakMap();
const SKILLS_CACHE = new Map();

function heavyCacheFor(db) {
  let cache = HEAVY_CACHE.get(db);
  if (!cache) {
    cache = { mcp: { at: 0, data: null }, skills: { at: 0, data: null } };
    HEAVY_CACHE.set(db, cache);
  }
  return cache;
}

function emptyMcpSummary() {
  return {
    total_servers: 0,
    registered_count: 0,
    clients_detected: 0,
    synced_pairs: 0,
    drift_count: 0,
    cached_tools_total: 0,
  };
}

function fallbackMcpSnapshot(db) {
  const rows = safeAll(db, 'SELECT * FROM mcp_servers ORDER BY server_id ASC');
  const servers = rows.map((row) => ({
    id: row.server_id,
    name: row.name,
    transport: row.transport,
    enabled: Boolean(row.enabled),
    registered: true,
    client_presence: {},
    tools: Number.isFinite(row.last_probe_tools_count) ? row.last_probe_tools_count : 0,
    last_probe_ok: row.last_probe_ok,
    last_probe_tools_count: row.last_probe_tools_count,
  }));
  return {
    summary: {
      ...emptyMcpSummary(),
      total_servers: servers.length,
      registered_count: servers.length,
      cached_tools_total: servers.reduce((sum, server) => sum + server.tools, 0),
    },
    clients: [],
    servers,
  };
}

function emptySkillsSnapshot() {
  return {
    summary: {
      skills_total: 0,
      clients_detected: 0,
      skill_synced_pairs: 0,
      skill_drift_count: 0,
      rules_detected: 0,
      rules_drifted: 0,
    },
    clients: [],
    skills: [],
    rules: [],
  };
}

function getMcpSnapshot(db) {
  const cache = heavyCacheFor(db);
  const now = Date.now();
  if (cache.mcp.data && now - cache.mcp.at < 15000) return cache.mcp.data;
  try {
    const snap = buildMcpHubSnapshot(db);
    cache.mcp = { at: now, data: snap };
    return snap;
  } catch {
    const snap = fallbackMcpSnapshot(db);
    cache.mcp = { at: now, data: snap };
    return snap;
  }
}

function getSkillsSnapshot(projectDir) {
  if (!projectDir) return emptySkillsSnapshot();
  const now = Date.now();
  const cached = SKILLS_CACHE.get(projectDir);
  if (cached && now - cached.at < 30000) return cached.data;
  try {
    const snap = buildSkillsRulesSnapshot({ projectDir });
    SKILLS_CACHE.set(projectDir, { at: now, data: snap });
    return snap;
  } catch {
    const snap = emptySkillsSnapshot();
    SKILLS_CACHE.set(projectDir, { at: now, data: snap });
    return snap;
  }
}

/**
 * Collect everything the cockpit needs. Called on refresh boundaries only.
 */
export function collectTuiData(db, { demo = false, colorLevel = 0, width = 100, height = 32, projectDir = process.cwd() } = {}) {
  const generatedAt = new Date().toISOString();
  if (demo || !db || typeof db.prepare !== 'function') {
    if (demo) return buildDemoData({ colorLevel, width, height });
    return {
      generated_at: generatedAt,
      project_name: path.basename(projectDir || 'workspace'),
      color_level: colorLevel,
      agents: [],
      tasks: [],
      stats: { total: 0, active: 0, queued: 0, failed: 0, stalled: 0, completed: 0 },
      events: [],
      logs: {},
      worktrees: [],
      merge_queue: [],
      mcp: { summary: emptyMcpSummary(), clients: [], servers: [] },
      skills: emptySkillsSnapshot(),
      health: { score: null, overall: 'unknown', findings: 0, healable: 0 },
      fps: 8,
    };
  }

  let hud;
  try {
    hud = collectHudSnapshot(db);
  } catch {
    hud = { agents: { items: [], online: 0, total: 0 }, tasks: {}, worktrees: {}, merge_queue: {}, mcp: {}, health: {} };
  }

  const tasks = safeAll(db, `
    SELECT task_id, title, member, role, channel, state, updated_at, created_at, error_code
    FROM tasks
    ORDER BY updated_at DESC
    LIMIT 80
  `);
  const events = safeAll(db, `
    SELECT id, task_id, event_type, actor, payload_json, created_at
    FROM events
    ORDER BY id DESC
    LIMIT 16
  `);
  const logRows = safeAll(db, `
    SELECT id, task_id, stream, text, created_at
    FROM task_logs
    ORDER BY id DESC
    LIMIT 240
  `);
  const worktrees = safeAll(db, `
    SELECT task_id, repo_dir, worktree_path, branch_name, member, state, updated_at
    FROM worktrees
    ORDER BY updated_at DESC
    LIMIT 20
  `);
  const queueRows = safeAll(db, `
    SELECT *
    FROM merge_queue
    ORDER BY
      CASE status WHEN 'validating' THEN 0 WHEN 'ready' THEN 1 WHEN 'queued' THEN 2 WHEN 'conflict' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
      priority ASC,
      id ASC
    LIMIT 20
  `);

  const logs = {};
  for (const row of logRows) {
    const bucket = logs[row.task_id] || (logs[row.task_id] = []);
    if (bucket.length < 8) bucket.push({ stream: row.stream, text: row.text, created_at: row.created_at });
  }
  for (const key of Object.keys(logs)) logs[key].reverse();

  const mergeQueue = queueRows.map((row) => ({
    id: row.id,
    task_id: row.task_id,
    branch_name: row.branch_name,
    member: '—',
    priority: row.priority,
    status: row.status,
    check_summary: row.check_summary || null,
    conflict_files: parseJsonArray(row.conflict_files_json),
    updated_at: row.updated_at,
  }));
  const wtById = new Map(worktrees.map((wt) => [wt.task_id, wt]));
  for (const item of mergeQueue) {
    item.member = wtById.get(item.task_id)?.member || '—';
  }

  const mcp = getMcpSnapshot(db);
  const skills = getSkillsSnapshot(projectDir);
  const derivedStats = taskStatsFrom(tasks);
  const stats = {
    ...derivedStats,
    total: Number(hud.tasks?.total) || derivedStats.total,
    active: Number.isFinite(hud.tasks?.active) ? hud.tasks.active : derivedStats.active,
    failed: Number.isFinite(hud.tasks?.failed) ? hud.tasks.failed : derivedStats.failed,
    stalled: Number.isFinite(hud.tasks?.stalled) ? hud.tasks.stalled : derivedStats.stalled,
    completed: Number.isFinite(hud.tasks?.completed) ? hud.tasks.completed : derivedStats.completed,
    online: Number(hud.agents?.online) || 0,
    agents_total: Number(hud.agents?.total) || 0,
    worktrees: Number(hud.worktrees?.active) || 0,
    mq_ready: Number(hud.merge_queue?.ready) || 0,
    mq_conflict: Number(hud.merge_queue?.conflict) || 0,
    mcp_registered: Number(mcp.summary?.registered_count) || 0,
    skills_total: Number(skills.summary?.skills_total) || 0,
  };

  return {
    generated_at: generatedAt,
    project_name: path.basename(projectDir || 'workspace'),
    color_level: colorLevel,
    hud,
    agents: Array.isArray(hud.agents?.items) ? hud.agents.items : [],
    tasks,
    stats,
    events,
    logs,
    worktrees,
    merge_queue: mergeQueue,
    mcp,
    skills,
    health: hud.health || { score: null, overall: 'unknown', findings: 0, healable: 0 },
    fps: 8,
  };
}

/* -------------------------------------------------------------------------- */
/* Demo fixture                                                               */
/* -------------------------------------------------------------------------- */

function buildDemoData({ colorLevel = 0, width = 100, height = 32 } = {}) {
  const now = Date.now();
  const iso = (deltaMs) => new Date(now - deltaMs).toISOString();
  const generatedAt = new Date(now).toISOString();

  const agents = [
    { id: 'agy', name: 'AGY (Antigravity)', glyph: 'AGY', symbol: '●', state: 'online', online: true, cooldown: false, channel: 'desktop-native', age_s: 12 },
    { id: 'codex', name: 'Codex', glyph: 'COD', symbol: '●', state: 'online', online: true, cooldown: false, channel: 'desktop-native', age_s: 31 },
    { id: 'claude', name: 'Claude', glyph: 'CLD', symbol: '◐', state: 'cooldown', online: true, cooldown: true, channel: 'dual-mode', age_s: 180 },
    { id: 'dsh', name: 'WSL DSH', glyph: 'DSH', symbol: '●', state: 'online', online: true, cooldown: false, channel: 'dsh-baton', age_s: 8 },
    { id: 'muse', name: 'Muse (Cloud)', glyph: 'MUS', symbol: '○', state: 'offline', online: false, cooldown: false, channel: 'muse-tailnet', age_s: 940 },
  ];

  const taskSeed = [
    ['T-1042', 'Design 24-bit TUI cockpit layout', 'agy', 'implementer', 'running', 42_000],
    ['T-1041', 'HUD StatusLine sub-30ms SQLite snapshot', 'dsh', 'implementer', 'running', 96_000],
    ['T-1040', 'Merge queue conflict pre-flight', 'codex', 'reviewer', 'queued', 210_000],
    ['T-1039', 'MCP drift matrix cross-client probe', 'codex', 'researcher', 'queued', 420_000],
    ['T-1038', 'Skills sync backup retention', 'claude', 'reviewer', 'stalled', 900_000],
    ['T-1037', 'Worktree inline diff comments', 'agy', 'tester', 'completed', 1_500_000],
    ['T-1036', 'DAG resume after relay timeout', 'dsh', 'implementer', 'failed', 2_100_000],
    ['T-1035', 'Landing page typography pass', 'muse', 'researcher', 'completed', 3_600_000],
    ['T-1034', 'Adaptive routing soft penalty', 'codex', 'planner', 'completed', 7_200_000],
    ['T-1033', 'Mission Control sparkline polish', 'claude', 'implementer', 'uncertain', 10_800_000],
  ];
  const tasks = taskSeed.map(([task_id, title, member, role, state, age]) => ({
    task_id,
    title,
    member,
    role,
    channel: 'desktop-native',
    state,
    created_at: iso(age + 60_000),
    updated_at: iso(age),
  }));

  const logs = {
    'T-1042': [
      { stream: 'stdout', text: 'renderTuiFrame(data, uiState) -> 1 frame @ 8fps', created_at: iso(30_000) },
      { stream: 'stdout', text: 'orbit constellation: 5 agents, 2 pulses travelling', created_at: iso(22_000) },
      { stream: 'system', text: 'dirty-frame diff: only writing changed stdout', created_at: iso(16_000) },
      { stream: 'stdout', text: 'tab 2 kanban lane counts: active 2 / queued 2 / attention 1', created_at: iso(9_000) },
    ],
    'T-1041': [
      { stream: 'stdout', text: 'collectHudSnapshot -> 2.4ms (sqlite only, no spawn)', created_at: iso(60_000) },
      { stream: 'stdout', text: 'health score 92, 2 findings, 1 healable', created_at: iso(44_000) },
      { stream: 'stderr', text: 'slow frame 34ms: warm sqlite page cache', created_at: iso(21_000) },
    ],
    'T-1038': [
      { stream: 'system', text: 'awaiting operator reconciliation (stalled 15m)', created_at: iso(900_000) },
      { stream: 'stdout', text: 'last checkpoint: 4 skills synced, 2 drifted', created_at: iso(880_000) },
    ],
  };

  const events = [
    ['task.running', 'agy', 'T-1042', 42_000],
    ['task.running', 'dsh', 'T-1041', 96_000],
    ['task.queued', 'codex', 'T-1040', 210_000],
    ['merge.ready', 'codex', 'T-1037', 320_000],
    ['mcp.probe', 'system', null, 400_000],
    ['task.stalled', 'claude', 'T-1038', 900_000],
    ['task.failed', 'dsh', 'T-1036', 2_100_000],
  ].map(([event_type, actor, task_id, age], index) => ({
    id: index + 1,
    event_type,
    actor,
    task_id,
    payload_json: '{}',
    created_at: iso(age),
  }));

  const worktrees = [
    { task_id: 'T-1042', branch_name: 'collab/agy/tui-cockpit', member: 'agy', state: 'active', updated_at: iso(42_000) },
    { task_id: 'T-1041', branch_name: 'collab/dsh/statusline-hud', member: 'dsh', state: 'active', updated_at: iso(96_000) },
    { task_id: 'T-1037', branch_name: 'collab/agy/inline-diff', member: 'agy', state: 'active', updated_at: iso(1_500_000) },
  ];

  const merge_queue = [
    { id: 3, task_id: 'T-1037', branch_name: 'collab/agy/inline-diff', member: 'agy', priority: 100, status: 'ready', check_summary: 'verify:node-test passed (2431ms)', conflict_files: [] },
    { id: 4, task_id: 'T-1040', branch_name: 'collab/codex/merge-preflight', member: 'codex', priority: 100, status: 'conflict', check_summary: 'merge-tree detected 2 conflicts', conflict_files: ['src/dashboard.mjs', 'src/db.mjs'] },
    { id: 5, task_id: 'T-1041', branch_name: 'collab/dsh/statusline-hud', member: 'dsh', priority: 120, status: 'queued', check_summary: null, conflict_files: [] },
  ];

  const mcpClients = [
    { id: 'antigravity', name: 'Antigravity', exists: true, skills_count: 6 },
    { id: 'claude', name: 'Claude Code', exists: true, skills_count: 5 },
    { id: 'codex', name: 'Codex', exists: true, skills_count: 4 },
  ];
  const mcpServers = [
    { id: 'collab-hub', name: 'collab-hub', transport: 'stdio', enabled: true, registered: true, tools: 43, client_presence: { antigravity: 'present', claude: 'present', codex: 'present' }, last_probe_tools_count: 43 },
    { id: 'github', name: 'github', transport: 'stdio', enabled: true, registered: true, tools: 26, client_presence: { antigravity: 'present', claude: 'drifted', codex: 'present' }, last_probe_tools_count: 26 },
    { id: 'filesystem', name: 'filesystem', transport: 'stdio', enabled: true, registered: true, tools: 12, client_presence: { antigravity: 'present', claude: 'present', codex: 'missing' }, last_probe_tools_count: 12 },
    { id: 'playwright', name: 'playwright', transport: 'stdio', enabled: false, registered: true, tools: 21, client_presence: { antigravity: 'missing', claude: 'missing', codex: 'missing' }, last_probe_tools_count: 21 },
  ];

  const skills = {
    summary: {
      skills_total: 9,
      clients_detected: 3,
      skill_synced_pairs: 7,
      skill_drift_count: 2,
      rules_detected: 4,
      rules_drifted: 1,
    },
    clients: mcpClients,
    skills: [
      { name: 'reverse-engineering', title: 'static + dynamic binary analysis', client_presence: { antigravity: 'present', claude: 'present', codex: 'present' } },
      { name: 'code-review', title: 'standards + spec review in parallel', client_presence: { antigravity: 'present', claude: 'drifted', codex: 'present' } },
      { name: 'tdd', title: 'red-green-refactor discipline', client_presence: { antigravity: 'present', claude: 'present', codex: 'missing' } },
      { name: 'webapp-testing', title: 'Playwright verification loop', client_presence: { antigravity: 'present', claude: 'present', codex: 'present' } },
      { name: 'skill-creator', title: 'author + evaluate new skills', client_presence: { antigravity: 'missing', claude: 'present', codex: 'present' } },
      { name: 'systematic-debugging', title: 'root-cause before patches', client_presence: { antigravity: 'present', claude: 'present', codex: 'present' } },
    ],
    rules: [
      { id: 'agents', name: 'AGENTS.md', rel_path: 'AGENTS.md', status: 'present' },
      { id: 'claude', name: 'CLAUDE.md', rel_path: 'CLAUDE.md', status: 'present' },
      { id: 'gemini', name: 'GEMINI.md', rel_path: 'GEMINI.md', status: 'drifted' },
      { id: 'cursor', name: '.cursor/rules/collab.mdc', rel_path: '.cursor/rules/collab.mdc', status: 'missing' },
    ],
  };

  const stats = {
    ...taskStatsFrom(tasks),
    online: 3,
    agents_total: 5,
    worktrees: 3,
    mq_ready: 1,
    mq_conflict: 1,
    mcp_registered: 4,
    skills_total: 9,
  };

  return {
    generated_at: generatedAt,
    project_name: 'collab-hub',
    color_level: colorLevel,
    width,
    height,
    agents,
    tasks,
    stats,
    events,
    logs,
    worktrees,
    merge_queue,
    mcp: {
      summary: {
        total_servers: 4,
        registered_count: 4,
        clients_detected: 3,
        synced_pairs: 8,
        drift_count: 1,
        cached_tools_total: 102,
      },
      clients: mcpClients,
      servers: mcpServers,
    },
    skills,
    health: { score: 92, overall: 'healthy', findings: 2, healable: 1, active_lessons: 3 },
    fps: 8,
  };
}

/* -------------------------------------------------------------------------- */
/* Interactive cockpit                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Launch the animated cockpit. Falls back to a single clean snapshot when
 * stdin/stdout are not TTYs, and always restores alt-screen + cursor on exit.
 *
 * @param {import('node:sqlite').DatabaseSync|null} db
 * @param {{ demo?: boolean, fps?: number, width?: number, height?: number, projectDir?: string }} [options]
 */
export async function startInteractiveTui(db, { demo = false, fps = 8, width, height, projectDir = process.cwd() } = {}) {
  const colorLevel = detectColorSupport({ stream: process.stdout, env: process.env }).level;
  let cols = Math.max(24, clampInt(width, 24, 400, process.stdout.columns || 100));
  let rows = Math.max(20, clampInt(height, 20, 100, process.stdout.rows || 32));
  const rate = clampInt(fps, 1, 10, 8);
  const interval = Math.max(100, Math.round(1000 / rate));
  const state = { tab: 0, selected: 0, frame: 0 };
  const collect = () => collectTuiData(db, { demo, colorLevel, width: cols, height: rows, projectDir });

  let data = collect();

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const rendered = renderTuiFrame(data, { ...state, width: cols, height: rows, colorLevel, fps: rate });
    process.stdout.write(`${rendered}\n`);
    return { mode: 'snapshot', rendered };
  }

  const out = process.stdout;
  const input = process.stdin;
  let closed = false;
  let timer = null;
  let lastFrame = '';
  let lastRefresh = Date.now();

  await new Promise((resolve) => {
    const draw = (force = false) => {
      if (closed) return;
      const rendered = renderTuiFrame(data, { ...state, width: cols, height: rows, colorLevel, fps: rate });
      if (force || rendered !== lastFrame) {
        out.write(`\x1b[H${rendered}\x1b[J`);
        lastFrame = rendered;
      }
    };

    const refresh = (force = false) => {
      if (closed) return;
      try {
        data = collect();
      } catch { /* keep the last good frame */ }
      const max = Math.max(0, (Array.isArray(data.tasks) ? data.tasks.length : 0) - 1);
      if (state.selected > max) state.selected = max;
      lastRefresh = Date.now();
      if (force) draw(true);
    };

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      try { input.off('data', onKey); } catch {}
      try { input.off('end', finish); } catch {}
      try { out.off('resize', onResize); } catch {}
      try { process.off('SIGINT', finish); } catch {}
      try { process.off('SIGTERM', finish); } catch {}
      try { input.setRawMode(false); } catch {}
      try { input.pause(); } catch {}
      try { out.write('\x1b[0m\x1b[?25h\x1b[?1049l'); } catch {}
    };

    const finish = () => {
      if (closed) return;
      cleanup();
      resolve({ mode: 'interactive', frames: state.frame });
    };

    const move = (delta) => {
      const total = Array.isArray(data.tasks) ? data.tasks.length : 0;
      if (total <= 0) { state.selected = 0; return; }
      state.selected = Math.min(total - 1, Math.max(0, state.selected + delta));
    };

    const setTab = (next) => {
      state.tab = mod(next, TUI_TABS.length);
    };

    const handle = (key) => {
      if (key === 'q' || key === '\x03') { finish(); return; }
      if (key >= '1' && key <= '5') { setTab(Number(key) - 1); return; }
      if (key === '\t') { setTab(state.tab + 1); return; }
      if (key === 'up' || key === 'k') { move(-1); return; }
      if (key === 'down' || key === 'j') { move(1); return; }
      if (key === 'home' || key === 'g') { state.selected = 0; return; }
      if (key === 'end' || key === 'G') { state.selected = Math.max(0, (data.tasks?.length || 0) - 1); return; }
      if (key === 'r') { refresh(true); return; }
    };

    const onKey = (chunk) => {
      if (closed) return;
      const str = String(chunk);
      let i = 0;
      while (i < str.length && !closed) {
        if (str[i] === '\x1b') {
          // Generic CSI parser: consume the whole escape sequence so modified arrows
          // (e.g. \x1b[1;5A) can never leak digits into the tab shortcuts.
          let j = i + 1;
          if (str[j] === '[' || str[j] === 'O') {
            j += 1;
            while (j < str.length && !/[@-~]/.test(str[j])) j += 1;
            const seq = str.slice(i, Math.min(str.length, j + 1));
            if (seq.endsWith('A')) handle('up');
            else if (seq.endsWith('B')) handle('down');
            else if (seq.endsWith('Z')) setTab(state.tab - 1);
            else if (seq.endsWith('H')) handle('home');
            else if (seq.endsWith('F')) handle('end');
            i = Math.min(str.length, j + 1);
            continue;
          }
          i += 1;
          continue;
        }
        const ch = str[i];
        i += 1;
        handle(ch);
      }
      if (!closed) draw();
    };

    const onResize = () => {
      cols = Math.max(24, clampInt(out.columns, 24, 400, cols));
      rows = Math.max(20, clampInt(out.rows, 20, 100, rows));
      draw(true);
    };

    try {
      input.setRawMode(true);
      input.resume();
      input.setEncoding('utf8');
    } catch { /* non-raw terminals still work in fallback mode */ }

    const onFatal = (err) => {
      finish();
      throw err;
    };

    out.write('\x1b[?1049h\x1b[?25l\x1b[2J\x1b[H');
    input.on('data', onKey);
    input.once('end', finish);
    out.on('resize', onResize);
    process.on('SIGINT', finish);
    process.on('SIGTERM', finish);
    process.once('exit', finish);
    process.once('uncaughtException', onFatal);

    draw(true);
    timer = setInterval(() => {
      if (closed) return;
      state.frame += 1;
      if (Date.now() - lastRefresh >= 4000) refresh(false);
      draw();
    }, interval);
  });

  return { mode: 'interactive', frames: state.frame };
}

export default {
  renderTuiFrame,
  startInteractiveTui,
  collectTuiData,
  TUI_TABS,
};
