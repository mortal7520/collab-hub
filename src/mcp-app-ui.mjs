/**
 * CollabHub v2.0.0 — SEP-1865 Interactive 60fps Animated MCP App Cockpit
 *
 * Self-contained single-document HTML UI (`ui://collab-hub/cockpit.html`, MIME `text/html;profile=mcp-app`)
 * natively supported across:
 *   - Antigravity (AGY): inline chat frame, auxiliary side pane (`aux_pane`), and full-page sidebar (`global`)
 *   - Claude Desktop: inline & fullscreen interactive MCP App sandbox
 *   - Codex Desktop: inline interactive MCP App sandbox
 *   - Web Workbench standalone preview: `http://127.0.0.1:5290/cockpit`
 *
 * Zero external runtime dependencies, zero CDN calls, CSP-safe (`default-src 'none'` + inline script/style),
 * bidirectional JSON-RPC 2.0 `postMessage` bridge implementing SEP-1865 (`2026-01-26` / `modelcontextprotocol/ext-apps`).
 */
import { APP_VERSION } from './config.mjs';

export const COCKPIT_RESOURCE_URI = 'ui://collab-hub/cockpit.html';
export const CHAT_STRIP_RESOURCE_URI = 'ui://collab-hub/chat-strip.html';
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Compact Cyber-HUD Unicode summary card for text-only chat hosts (graceful fallback ladder).
 */
export function formatCyberHudCard(snap = {}) {
  const members = Array.isArray(snap.members) ? snap.members : [];
  const tasks = Array.isArray(snap.tasks) ? snap.tasks : [];
  const mq = Array.isArray(snap.merge_queue) ? snap.merge_queue : [];
  const mcpSum = snap.mcp_hub_summary || {};
  const health = snap.self_improve?.health_score ?? 100;
  const online = members.filter((m) => ['online', 'idle'].includes(m.state)).length;
  const running = tasks.filter((t) => ['running', 'dispatched', 'dispatching'].includes(t.state)).length;
  const stalled = tasks.filter((t) => ['stalled', 'uncertain', 'needs_input'].includes(t.state)).length;
  const readyQ = mq.filter((q) => q.status === 'ready').length;
  const conflictQ = mq.filter((q) => q.status === 'conflict').length;
  const filled = Math.max(0, Math.min(10, Math.round(health / 10)));
  const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
  const fleet = members.slice(0, 6).map((m) => {
    const icon = m.state === 'online' ? '●' : (m.state === 'idle' ? '◐' : (m.state === 'cooldown' ? '▲' : '○'));
    return `${String(m.member || '').toUpperCase().slice(0, 5)} ${icon}`;
  }).join('  ');

  return [
    `╔══════════════════════════════════════════════════════════════╗`,
    `║ ⚡ CollabHub v${APP_VERSION} · Mission Control HUD     Health [${bar}] ${String(health).padStart(3)} ║`,
    `╠══════════════════════════════════════════════════════════════╣`,
    `║ Fleet (${online}/${members.length}) : ${fleet || 'no agents'}`.slice(0, 63).padEnd(63) + '║',
    `║ Tasks : ${running} running · ${stalled} attention · ${tasks.length} total`.slice(0, 63).padEnd(63) + '║',
    `║ MCP   : ${mcpSum.servers_count ?? 0} servers · ${mcpSum.clients_detected ?? 0} clients · ${mcpSum.drift_count ?? 0} drift`.slice(0, 63).padEnd(63) + '║',
    `║ Queue : ${mq.length} queued (${readyQ} ready · ${conflictQ} conflict)`.slice(0, 63).padEnd(63) + '║',
    `╚══════════════════════════════════════════════════════════════╝`,
  ].join('\n');
}

/**
 * Render the complete self-contained SEP-1865 MCP App HTML document.
 * All dynamic data is delivered securely over the JSON-RPC 2.0 `postMessage` bridge (`ui/notifications/tool-result`
 * and `tools/call` -> `collab_cockpit_state`), or fetched from `/api/overview` when previewed standalone at `/cockpit`.
 */
export function buildCockpitAppHtml() {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CollabHub v${APP_VERSION} · Neural Mission Cockpit</title>
<style>
:root, :root[data-theme="dark"] {
  --bg: var(--color-background-primary, #070910);
  --bg2: var(--color-background-secondary, #0d111c);
  --bg3: var(--color-background-tertiary, #141a2b);
  --fg: var(--color-text-primary, #eef2ff);
  --fg2: var(--color-text-secondary, #94a3b8);
  --fg3: var(--color-text-tertiary, #64748b);
  --bd: var(--color-border-primary, rgba(148, 163, 184, 0.16));
  --bd2: var(--color-border-secondary, rgba(129, 140, 248, 0.34));
  --accent: #818cf8;
  --accent2: #6366f1;
  --cyan: #38bdf8;
  --emerald: #34d399;
  --amber: #fbbf24;
  --rose: #fb7185;
  --glass: rgba(13, 17, 28, 0.78);
  --font: var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", "Inter", "PingFang SC", "Microsoft YaHei", sans-serif);
  --mono: ui-monospace, "Cascadia Code", Consolas, "SF Mono", monospace;
}
:root[data-theme="light"] {
  --bg: var(--color-background-primary, #f8fafc);
  --bg2: var(--color-background-secondary, #ffffff);
  --bg3: var(--color-background-tertiary, #f1f5f9);
  --fg: var(--color-text-primary, #0f172a);
  --fg2: var(--color-text-secondary, #475569);
  --fg3: var(--color-text-tertiary, #64748b);
  --bd: var(--color-border-primary, rgba(15, 23, 42, 0.12));
  --bd2: var(--color-border-secondary, rgba(79, 70, 229, 0.32));
  --accent: #4f46e5;
  --accent2: #4338ca;
  --cyan: #0284c7;
  --emerald: #059669;
  --amber: #d97706;
  --rose: #e11d48;
  --glass: rgba(255, 255, 255, 0.84);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
[hidden] { display: none !important; }
html, body {
  min-height: 100%;
  background:
    radial-gradient(620px 260px at 85% -10%, rgba(99, 102, 241, 0.16), transparent 65%),
    radial-gradient(480px 220px at 12% 0%, rgba(56, 189, 248, 0.10), transparent 60%),
    var(--bg);
  color: var(--fg);
  font-family: var(--font);
  font-size: 12.5px;
  line-height: 1.45;
  -webkit-font-smoothing: antialiased;
  overflow-x: clip;
}
button, input, select, textarea { font: inherit; color: inherit; }

.shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px;
  max-width: 1120px;
  margin: 0 auto;
}

/* Always-On Sticky Header HUD (follows scroll inside every IDE/Desktop host) */
.cockpit-sticky {
  position: sticky;
  top: 0;
  z-index: 45;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding-top: 2px;
  background: linear-gradient(180deg, var(--bg) 72%, rgba(7, 9, 16, 0));
}
.hud-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 12px;
  border: 1px solid var(--bd);
  background: var(--glass);
  backdrop-filter: blur(14px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 8px 24px -14px rgba(0,0,0,0.6);
  flex-wrap: wrap;
}
.usage-strip {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 10px;
  border-radius: 10px;
  border: 1px solid var(--bd);
  background: var(--glass);
  backdrop-filter: blur(12px);
  font-size: 11px;
  flex-wrap: wrap;
}
.usage-chips { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.u-chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 2px 7px; border-radius: 999px;
  border: 1px solid var(--bd); background: var(--bg3);
  font-size: 10.5px; font-variant-numeric: tabular-nums;
}
.u-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--fg3); }
.u-dot.active { background: var(--emerald); box-shadow: 0 0 8px var(--emerald); }
.u-dot.recent { background: var(--cyan); }
body.dock-mode .shell { max-width: 460px; padding: 8px; gap: 8px; }
body.dock-mode .radar-grid { grid-template-columns: 1fr; }
body.dock-mode .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
body.dock-mode .kanban { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.brand { display: flex; align-items: center; gap: 9px; }
.brand-orb {
  width: 28px; height: 28px; border-radius: 8px;
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--accent2), var(--cyan));
  color: #fff; font-weight: 800; font-size: 13px;
  box-shadow: 0 0 18px -4px rgba(99, 102, 241, 0.85);
}
.brand-title { font-weight: 700; font-size: 13.5px; letter-spacing: -0.01em; }
.brand-sub { font-size: 10.5px; color: var(--fg2); display: flex; align-items: center; gap: 6px; }
.live-dot {
  width: 7px; height: 7px; border-radius: 50%; background: var(--emerald);
  box-shadow: 0 0 0 3px rgba(52, 211, 153, 0.22);
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.48; transform: scale(0.86); }
}

.hud-right { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.ring-chip {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 3px 9px 3px 5px;
  border-radius: 999px; border: 1px solid var(--bd); background: var(--bg3);
  font-size: 11px; font-weight: 600; font-variant-numeric: tabular-nums;
}
.ring-svg { width: 20px; height: 20px; transform: rotate(-90deg); }
.ring-track { fill: none; stroke: var(--bd); stroke-width: 2.6; }
.ring-fill { fill: none; stroke: var(--emerald); stroke-width: 2.6; stroke-linecap: round; stroke-dasharray: 50.26; stroke-dashoffset: 50.26; transition: stroke-dashoffset 0.55s cubic-bezier(0.22, 1, 0.36, 1), stroke 0.25s; }

.btn {
  display: inline-flex; align-items: center; gap: 5px;
  height: 27px; padding: 0 10px;
  border-radius: 7px; border: 1px solid var(--bd);
  background: var(--bg3); color: var(--fg);
  font-size: 11.5px; font-weight: 550; cursor: pointer;
  transition: transform 0.12s ease, border-color 0.14s ease, background 0.14s ease, opacity 0.14s;
}
.btn:hover { border-color: var(--bd2); transform: translateY(-1px); }
.btn:active { transform: translateY(0); }
.btn:disabled { opacity: 0.48; cursor: not-allowed; transform: none; }
.btn.primary { background: linear-gradient(135deg, var(--accent2), #4f46e5); border-color: transparent; color: #fff; box-shadow: 0 6px 16px -8px rgba(99, 102, 241, 0.9); }
.btn.cyan { background: rgba(56, 189, 248, 0.14); border-color: rgba(56, 189, 248, 0.38); color: var(--cyan); }
.btn.ok { background: rgba(52, 211, 153, 0.14); border-color: rgba(52, 211, 153, 0.36); color: var(--emerald); }
.btn.warn { background: rgba(251, 191, 36, 0.14); border-color: rgba(251, 191, 36, 0.36); color: var(--amber); }

/* Tabs */
.tabs {
  display: flex; align-items: center; gap: 5px;
  padding: 4px; border-radius: 10px;
  border: 1px solid var(--bd); background: var(--bg2);
  overflow-x: auto;
}
.tab {
  display: inline-flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 11px; border-radius: 7px;
  border: 1px solid transparent; background: transparent;
  color: var(--fg2); font-size: 11.5px; font-weight: 600; cursor: pointer; white-space: nowrap;
  transition: background 0.14s, color 0.14s, border-color 0.14s;
}
.tab:hover { color: var(--fg); background: var(--bg3); }
.tab.active { color: var(--fg); background: rgba(99, 102, 241, 0.18); border-color: var(--bd2); }
.badge {
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 17px; height: 17px; padding: 0 5px; border-radius: 999px;
  font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums;
  background: var(--bg3); border: 1px solid var(--bd); color: var(--fg2);
}
.badge.ok { color: var(--emerald); border-color: rgba(52, 211, 153, 0.36); background: rgba(52, 211, 153, 0.12); }
.badge.warn { color: var(--amber); border-color: rgba(251, 191, 36, 0.38); background: rgba(251, 191, 36, 0.12); }
.badge.err { color: var(--rose); border-color: rgba(251, 113, 133, 0.38); background: rgba(251, 113, 133, 0.12); }
.badge.cyan { color: var(--cyan); border-color: rgba(56, 189, 248, 0.38); background: rgba(56, 189, 248, 0.12); }

/* Panels & Animations */
.pane { display: none; animation: paneIn 0.18s cubic-bezier(0.22, 1, 0.36, 1) both; }
.pane.active { display: flex; flex-direction: column; gap: 10px; }
@keyframes paneIn {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: translateY(0); }
}

.card {
  border-radius: 12px; border: 1px solid var(--bd);
  background: var(--bg2); padding: 11px 12px;
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
}
.card-head {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  margin-bottom: 9px; flex-wrap: wrap;
}
.card-title { font-size: 12.5px; font-weight: 700; letter-spacing: -0.01em; }
.card-sub { font-size: 11px; color: var(--fg2); }

/* Neural Constellation Radar */
.radar-grid {
  display: grid;
  grid-template-columns: minmax(260px, 1.15fr) minmax(240px, 1fr);
  gap: 10px;
}
.canvas-box {
  position: relative;
  border-radius: 11px;
  border: 1px solid var(--bd2);
  background:
    radial-gradient(circle at 50% 50%, rgba(99, 102, 241, 0.16), transparent 64%),
    var(--bg);
  overflow: hidden;
  min-height: 235px;
}
#fleetCanvas { width: 100%; height: 235px; display: block; cursor: pointer; }
.canvas-overlay {
  position: absolute; left: 10px; bottom: 8px; right: 10px;
  display: flex; align-items: center; justify-content: space-between;
  font-size: 10.5px; color: var(--fg2); pointer-events: none;
}

.agent-stack { display: flex; flex-direction: column; gap: 7px; max-height: 235px; overflow-y: auto; padding-right: 2px; }
.agent-row {
  display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 7px 9px; border-radius: 9px;
  border: 1px solid var(--bd); background: var(--bg3);
  cursor: pointer; transition: border-color 0.14s, transform 0.12s;
}
.agent-row:hover, .agent-row.selected { border-color: var(--bd2); transform: translateX(2px); }
.agent-left { display: flex; align-items: center; gap: 8px; min-width: 0; }
.status-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--fg3); }
.status-dot.online { background: var(--emerald); box-shadow: 0 0 10px var(--emerald); }
.status-dot.idle { background: var(--cyan); box-shadow: 0 0 8px var(--cyan); }
.status-dot.cooldown, .status-dot.stale { background: var(--amber); }
.status-dot.offline, .status-dot.dormant { background: var(--fg3); }
.agent-name { font-weight: 650; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-detail { font-size: 10.5px; color: var(--fg2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 210px; }

/* KPI Strip */
.kpi-row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.kpi {
  padding: 8px 10px; border-radius: 10px; border: 1px solid var(--bd); background: var(--bg3);
  display: flex; flex-direction: column; gap: 2px;
}
.kpi-l { font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--fg2); font-weight: 600; }
.kpi-v { font-size: 18px; font-weight: 750; font-variant-numeric: tabular-nums; line-height: 1.15; }

/* Mini Kanban */
.kanban { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px; }
.lane { border-radius: 10px; border: 1px solid var(--bd); background: var(--bg3); padding: 8px; display: flex; flex-direction: column; gap: 6px; min-height: 140px; }
.lane-head { display: flex; align-items: center; justify-content: space-between; font-size: 11px; font-weight: 700; color: var(--fg2); }
.t-card {
  padding: 7px 8px; border-radius: 8px; border: 1px solid var(--bd); background: var(--bg2);
  cursor: pointer; transition: border-color 0.14s, transform 0.12s;
}
.t-card:hover { border-color: var(--bd2); transform: translateY(-1px); }
.t-title { font-weight: 600; font-size: 11.5px; margin-bottom: 3px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.t-meta { font-size: 10px; color: var(--fg2); display: flex; align-items: center; justify-content: space-between; gap: 4px; font-family: var(--mono); }

/* Tables & Lists */
.list { display: flex; flex-direction: column; gap: 6px; }
.row-item {
  display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap;
  padding: 8px 10px; border-radius: 9px; border: 1px solid var(--bd); background: var(--bg3);
}
.mono { font-family: var(--mono); font-size: 11px; }
.search-bar { display: flex; gap: 6px; margin-bottom: 8px; }
.input {
  flex: 1; height: 29px; padding: 0 9px; border-radius: 7px;
  border: 1px solid var(--bd); background: var(--bg); color: var(--fg); font-size: 12px;
}
.input:focus { outline: none; border-color: var(--accent); }
.pre {
  margin-top: 8px; padding: 8px 10px; border-radius: 8px;
  border: 1px solid var(--bd); background: var(--bg);
  font-family: var(--mono); font-size: 11px; color: var(--fg2);
  max-height: 180px; overflow: auto; white-space: pre-wrap; word-break: break-word;
}
.toast {
  position: fixed; right: 12px; bottom: 12px; z-index: 99;
  padding: 7px 12px; border-radius: 9px;
  border: 1px solid var(--bd2); background: var(--bg2); color: var(--fg);
  font-size: 11.5px; font-weight: 550; box-shadow: 0 12px 28px -10px rgba(0,0,0,0.65);
  animation: paneIn 0.16s ease both;
}

@media (max-width: 720px) {
  .radar-grid, .kanban { grid-template-columns: 1fr; }
  .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) {
  .live-dot, .pane, .toast { animation: none !important; }
  .btn, .agent-row, .t-card, .ring-fill { transition: none !important; }
}
</style>
</head>
<body>
<div class="shell">
  <div class="cockpit-sticky">
    <header class="hud-bar">
      <div class="brand">
        <div class="brand-orb">⚡</div>
        <div>
          <div class="brand-title">CollabHub <span style="color:var(--accent)">v${APP_VERSION}</span></div>
          <div class="brand-sub"><span class="live-dot"></span><span id="hostBadge">MCP App · Neural Mission Control</span></div>
        </div>
      </div>
      <div class="hud-right">
        <div class="ring-chip" title="Runtime Health Score">
          <svg class="ring-svg" viewBox="0 0 20 20"><circle class="ring-track" cx="10" cy="10" r="8"/><circle class="ring-fill" id="healthRing" cx="10" cy="10" r="8"/></svg>
          <span id="healthVal">—</span>
        </div>
        <button type="button" class="btn cyan" id="btnRefresh">↻ Sync</button>
        <button type="button" class="btn ok" id="btnProbe">◎ Probe</button>
        <button type="button" class="btn warn" id="btnHeal">✚ Heal</button>
        <button type="button" class="btn" id="btnLang">EN/中</button>
        <button type="button" class="btn cyan" id="btnAttachCtx" title="Attach fleet state pill into chat box" hidden>📌 Attach</button>
        <button type="button" class="btn primary" id="btnAskHost" hidden>↗ Send to Chat</button>
      </div>
    </header>
    <div class="usage-strip" id="cockpitUsageStrip">
      <div class="usage-chips" id="cockpitUsageChips"><span class="card-sub">Live usage initializing…</span></div>
      <div class="mono" id="cockpitUsageTotals" style="font-size:10.5px;color:var(--cyan)">0 tok · $0.00</div>
    </div>
  </div>

  <nav class="tabs" role="tablist">
    <button type="button" class="tab active" data-tab="radar"><span data-i18n="tRadar">Fleet Radar</span> <span class="badge ok" id="bAgents">0</span></button>
    <button type="button" class="tab" data-tab="tasks"><span data-i18n="tTasks">Kanban &amp; Logs</span> <span class="badge" id="bTasks">0</span></button>
    <button type="button" class="tab" data-tab="mcp"><span data-i18n="tMcp">MCP Hub</span> <span class="badge cyan" id="bMcp">0</span></button>
    <button type="button" class="tab" data-tab="skills"><span data-i18n="tSkills">Skills &amp; Rules</span> <span class="badge" id="bSkills">0</span></button>
    <button type="button" class="tab" data-tab="queue"><span data-i18n="tQueue">Merge Queue</span> <span class="badge" id="bQueue">0</span></button>
    <button type="button" class="tab" data-tab="rooms"><span data-i18n="tRooms">Rooms &amp; Ops</span> <span class="badge cyan" id="bRooms">0</span></button>
  </nav>

  <!-- TAB 1: FLEET RADAR -->
  <section class="pane active" id="pane-radar">
    <div class="kpi-row" id="kpiRow"></div>
    <div class="radar-grid">
      <div class="canvas-box">
        <canvas id="fleetCanvas"></canvas>
        <div class="canvas-overlay">
          <span id="canvasCaption">Click any orbiting agent node to inspect or dispatch</span>
          <span class="mono" id="canvasFps">60fps · live</span>
        </div>
      </div>
      <div class="card" style="padding:9px">
        <div class="card-head" style="margin-bottom:6px">
          <div class="card-title" data-i18n="fleetTitle">Live Agent Constellation</div>
          <span class="badge cyan" id="selectedNodePill">all</span>
        </div>
        <div class="agent-stack" id="agentList"></div>
      </div>
    </div>
    <div class="card" id="quickDispatchCard">
      <div class="card-head">
        <div>
          <div class="card-title" data-i18n="qdTitle">In-Host Quick Dispatch</div>
          <div class="card-sub" data-i18n="qdSub">Dispatch directly to background agents (DSH / Muse / Claude CLI / Custom) without leaving your IDE.</div>
        </div>
      </div>
      <div class="search-bar">
        <select class="input" id="qdMember" aria-label="Target agent" style="max-width:130px"><option value="auto">auto</option></select>
        <select class="input" id="qdRole" aria-label="Dispatch role" style="max-width:120px">
          <option value="researcher">researcher</option>
          <option value="reviewer">reviewer</option>
          <option value="implementer">implementer</option>
          <option value="tester">tester</option>
        </select>
        <select class="input" id="qdProject" aria-label="Target workspace project" style="max-width:165px"><option value="">Select project…</option></select>
        <input class="input" id="qdPrompt" aria-label="Dispatch goal" placeholder="Enter bounded goal & deliverable…" />
        <button type="button" class="btn primary" id="btnQdSend" style="white-space:nowrap;flex:none" data-i18n="qdSend">Dispatch</button>
      </div>
    </div>
  </section>

  <!-- TAB 2: KANBAN & LOGS -->
  <section class="pane" id="pane-tasks">
    <div class="kanban" id="kanbanGrid"></div>
    <div class="card" id="taskDetailCard" hidden>
      <div class="card-head">
        <div>
          <div class="card-title" id="tdTitle">Task</div>
          <div class="card-sub mono" id="tdMeta"></div>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn cyan" id="btnTdPoll">Poll</button>
          <button type="button" class="btn" id="btnTdLogs">Live Logs</button>
          <button type="button" class="btn warn" id="btnTdCancel">Cancel</button>
          <button type="button" class="btn" id="btnTdClose" aria-label="Close task details">×</button>
        </div>
      </div>
      <pre class="pre" id="tdBody"></pre>
    </div>
  </section>

  <!-- TAB 3: MCP HUB & META-MCP -->
  <section class="pane" id="pane-mcp">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title" data-i18n="mcpTitle">All-Agent MCP Hub &amp; Meta-MCP Lazy Router</div>
          <div class="card-sub" data-i18n="mcpSub">Zero-secret cross-client drift matrix &amp; on-demand tool discovery across AGY / Codex / Claude.</div>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn ok" id="btnMcpImportAll">Import All Local MCPs</button>
          <button type="button" class="btn cyan" id="btnMcpScan">Scan Clients</button>
        </div>
      </div>
      <div class="search-bar">
        <input class="input" id="mcpSearchInput" placeholder="Meta-MCP find tools (e.g. git, search, worktree)…" />
        <button type="button" class="btn primary" id="btnMcpSearch">Find Tools</button>
      </div>
      <div class="list" id="mcpToolHits" style="margin-bottom:8px"></div>
      <div class="list" id="mcpServerList"></div>
    </div>
  </section>

  <!-- TAB 4: SKILLS & RULES -->
  <section class="pane" id="pane-skills">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title" data-i18n="skTitle">Cross-Agent Skills &amp; Rules Sync</div>
          <div class="card-sub" data-i18n="skSub">SKILL.md directories &amp; AGENTS.md / CLAUDE.md / GEMINI.md drift inspection with Dry-Run + .bak sync.</div>
        </div>
        <button type="button" class="btn cyan" id="btnSkScan">Rescan</button>
      </div>
      <div class="list" id="skillsList"></div>
      <pre class="pre" id="skillsDiffOut" hidden></pre>
    </div>
  </section>

  <!-- TAB 5: MERGE QUEUE -->
  <section class="pane" id="pane-queue">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title" data-i18n="mqTitle">Serialized Agent Merge Queue</div>
          <div class="card-sub" data-i18n="mqSub">Zero-mutation speculative git merge-tree conflict detection across parallel worktrees.</div>
        </div>
        <div style="display:flex;gap:6px">
          <button type="button" class="btn cyan" id="btnMqValidate">Speculative Check</button>
          <button type="button" class="btn warn" id="btnMqProcess">Process Queue</button>
        </div>
      </div>
      <div class="list" id="mqList"></div>
    </div>
  </section>

  <!-- TAB 6: ROOMS & OPS (v2.2.0 FULL LOOP) -->
  <section class="pane" id="pane-rooms">
    <div class="card">
      <div class="card-head">
        <div>
          <div class="card-title" data-i18n="rmTitle">Living Shared Rooms &amp; Multi-Agent Ops</div>
          <div class="card-sub" data-i18n="rmSub">SQLite + CLAIMS.md/ROOM-LOG.md dual-layer rooms, Artifact Vault, Handoff Pack, Budgets, Consensus &amp; Triggers.</div>
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          <button type="button" class="btn cyan" id="btnGenHandoff">Handoff Pack</button>
          <button type="button" class="btn warn" id="btnReconcileStale">Clean Stale</button>
        </div>
      </div>
      <div class="search-bar">
        <input class="input" id="rmNameInput" placeholder="New room name (e.g. sprint-v22)…" style="max-width:190px" />
        <input class="input" id="rmGoalInput" placeholder="Room goal…" />
        <button type="button" class="btn primary" id="btnRmCreate">Create Room</button>
      </div>
      <div class="list" id="roomsList" style="margin-bottom:8px"></div>
      <div class="list" id="opsSummaryList"></div>
      <pre class="pre" id="opsOut" hidden></pre>
    </div>
  </section>
</div>
<div class="toast" id="toast" hidden></div>

<script>
(() => {
  'use strict';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

  let lang = 'zh';
  const STR = {
    en: {
      tRadar: 'Fleet Radar', tTasks: 'Kanban & Logs', tMcp: 'MCP Hub', tSkills: 'Skills & Rules', tQueue: 'Merge Queue', tRooms: 'Rooms & Ops',
      fleetTitle: 'Live Agent Constellation', qdTitle: 'In-Host Quick Dispatch',
      qdSub: 'Dispatch directly to background agents without leaving your IDE.', qdSend: 'Dispatch',
      mcpTitle: 'All-Agent MCP Hub & Meta-MCP Router', mcpSub: 'Zero-secret drift matrix & lazy tool discovery across AGY / Codex / Claude.',
      skTitle: 'Cross-Agent Skills & Rules Sync', skSub: 'SKILL.md & AGENTS.md / CLAUDE.md alignment with Dry-Run + .bak backups.',
      mqTitle: 'Serialized Agent Merge Queue', mqSub: 'Side-effect-free speculative git merge-tree pre-flight validation.',
      rmTitle: 'Living Shared Rooms & Multi-Agent Ops', rmSub: 'SQLite + CLAIMS.md/ROOM-LOG.md dual-layer rooms, Artifact Vault, Handoff Pack, Budgets & Triggers.',
      kAgents: 'Online Agents', kTasks: 'Active / Total', kMcp: 'MCP Servers', kQueue: 'Merge Queue',
    },
    zh: {
      tRadar: '舰队雷达', tTasks: '看板与日志', tMcp: 'MCP 中心', tSkills: '技能与规范', tQueue: '合并队列', tRooms: '协作房间',
      fleetTitle: '实时 Agent 神经拓扑', qdTitle: '宿主内一键派发',
      qdSub: '无需切去网页，在当前聊天窗口/侧栏直接派发后台任务。', qdSend: '立即派发',
      mcpTitle: '全 Agent MCP 中心与 Meta-MCP 路由', mcpSub: '跨 AGY / Codex / Claude 零密钥漂移矩阵与按需工具发现。',
      skTitle: '跨 Agent Skills / Rules 同步中心', skSub: '统一管理 SKILL.md 与 AGENTS.md / CLAUDE.md（预演 + .bak 备份）。',
      mqTitle: '串行 Agent 合并队列', mqSub: '零副作用 git merge-tree 累计冲突预演，防止并发分支互撞。',
      rmTitle: '共享协作房间与闭环运维', rmSub: 'SQLite + CLAIMS.md 双层协作房、产物保险库、交接包、预算熔断与触发器。',
      kAgents: '在线 Agent', kTasks: '运行中 / 总任务', kMcp: 'MCP 服务', kQueue: '合并队列',
    },
  };
  const tr = (k) => STR[lang]?.[k] || STR.en[k] || k;

  const appState = {
    mode: 'standalone', // 'mcp-app' | 'standalone'
    hostCaps: {},
    selectedAgent: null,
    selectedTask: null,
    data: { members: [], tasks: [], worktrees: [], merge_queue: [], mcp_hub: null, skills_hub: null, self_improve: { health_score: 100 }, workspaces: [], rooms: [], artifacts: [], budget_summary: null, triggers: [], consensus: [] },
    projectDir: '',
    workspaces: [],
  };

  let toastTimer = null;
  function showToast(msg) {
    const el = $('#toast');
    if (!el) return;
    el.textContent = String(msg || '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  /* ------------------------------------------------------------------ */
  /* SEP-1865 Bidirectional JSON-RPC 2.0 postMessage Bridge             */
  /* ------------------------------------------------------------------ */
  let rpcSeq = 1;
  const pending = new Map();
  const inIframe = window.parent && window.parent !== window;

  function sendRpcNotification(method, params = {}) {
    if (!inIframe) return;
    window.parent.postMessage({ jsonrpc: '2.0', method, params }, '*');
  }

  function sendRpcRequest(method, params = {}, timeoutMs = 15000) {
    if (!inIframe) return Promise.reject(new Error('Not running inside an MCP App host'));
    const id = rpcSeq++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Host RPC timeout: ' + method)); }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }

  function applyHostContext(ctx) {
    if (!ctx || typeof ctx !== 'object') return;
    if (ctx.theme === 'light' || ctx.theme === 'dark') {
      document.documentElement.dataset.theme = ctx.theme;
    }
    const vars = ctx.styles?.variables;
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
      }
    }
    if (typeof ctx.locale === 'string' && ctx.locale.toLowerCase().startsWith('en')) {
      lang = 'en';
      applyI18n();
    }
  }

  function ingestPayload(sc) {
    if (!sc || typeof sc !== 'object') return;
    if (Array.isArray(sc.members)) appState.data.members = sc.members;
    if (Array.isArray(sc.tasks)) appState.data.tasks = sc.tasks;
    if (Array.isArray(sc.worktrees)) appState.data.worktrees = sc.worktrees;
    if (Array.isArray(sc.merge_queue)) appState.data.merge_queue = sc.merge_queue;
    if (sc.mcp_hub) appState.data.mcp_hub = sc.mcp_hub;
    if (sc.mcp_hub_summary && !appState.data.mcp_hub) appState.data.mcp_hub_summary = sc.mcp_hub_summary;
    if (sc.skills_hub) appState.data.skills_hub = sc.skills_hub;
    if (sc.self_improve) appState.data.self_improve = sc.self_improve;
    if (sc.live_usage) appState.data.live_usage = sc.live_usage;
    if (Array.isArray(sc.rooms)) appState.data.rooms = sc.rooms;
    if (Array.isArray(sc.artifacts)) appState.data.artifacts = sc.artifacts;
    if (sc.budget_summary) appState.data.budget_summary = sc.budget_summary;
    if (Array.isArray(sc.triggers)) appState.data.triggers = sc.triggers;
    if (Array.isArray(sc.consensus)) appState.data.consensus = sc.consensus;
    if (Array.isArray(sc.workspaces)) appState.workspaces = sc.workspaces;
    if (sc.project_dir) appState.projectDir = sc.project_dir;
    if (!appState.projectDir && appState.workspaces.length) appState.projectDir = appState.workspaces[0].path || '';
    if (sc.initial_tab) switchTab(sc.initial_tab);
    renderAll();
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return;
    const msg = ev.data;
    if (!msg || msg.jsonrpc !== '2.0') return;
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const slot = pending.get(msg.id);
      if (!slot) return;
      pending.delete(msg.id);
      clearTimeout(slot.timer);
      if (msg.error) slot.reject(new Error(msg.error.message || 'RPC error'));
      else slot.resolve(msg.result);
      return;
    }
    if (msg.method === 'ui/notifications/tool-result') {
      const sc = msg.params?.structuredContent || null;
      if (sc) ingestPayload(sc);
      else if (msg.params?.content?.[0]?.text) {
        try { ingestPayload(JSON.parse(msg.params.content[0].text)); } catch {}
      }
    } else if (msg.method === 'ui/notifications/host-context-changed') {
      applyHostContext(msg.params);
    } else if (msg.method === 'ui/notifications/tool-input') {
      if (msg.params?.arguments?.tab) switchTab(msg.params.arguments.tab);
    } else if (msg.method === 'ping' && msg.id !== undefined) {
      window.parent.postMessage({ jsonrpc: '2.0', id: msg.id, result: {} }, '*');
    }
  });

  async function callServer(name, args = {}) {
    if (appState.mode === 'mcp-app') {
      const res = await sendRpcRequest('tools/call', { name, arguments: args });
      if (res?.isError) throw new Error(res.content?.[0]?.text || 'Tool call failed');
      if (res?.structuredContent) return res.structuredContent;
      try { return JSON.parse(res?.content?.[0]?.text || '{}'); } catch { return res; }
    }
    if (appState.isStaticDemo) {
      if (name === 'collab_cockpit_state' || name === 'collab_roster') {
        return appState.data;
      }
      if (name === 'collab_mcp_find_tools') {
        const q = String(args.query || '').toLowerCase();
        const demoTools = [
          { server: 'collab-hub', name: 'collab_plan', description: 'Model-strength smart dispatch planner' },
          { server: 'collab-hub', name: 'collab_usage', description: 'Live cross-agent token & cost telemetry' },
          { server: 'github', name: 'create_pull_request', description: 'Open PR from verified worktree branch' },
        ];
        return { matches: q ? demoTools.filter((t) => (t.name + ' ' + t.description).toLowerCase().includes(q)) : demoTools };
      }
      if (name === 'collab_handoff_pack') {
        return { markdown: '# CollabHub Demo Handoff Pack\\n- Active Room: v3-launch\\n- Health: 96/100\\n- Next: Run locally via npx -y collab-hub start' };
      }
      return {
        ok: true,
        demo_preview: true,
        action: name,
        note: 'Interactive static demo preview: mutations run against your local daemon (collab-hub start).',
      };
    }
    // Standalone HTTP fallback when previewed at /cockpit
    if (name === 'collab_cockpit_state' || name === 'collab_roster') {
      const [ov, mcp, sk, ws, rm, art, bud, trg, con] = await Promise.all([
        fetch('/api/overview').then((r) => r.json()),
        fetch('/api/mcp-hub').then((r) => r.json()).catch(() => null),
        fetch('/api/skills-hub').then((r) => r.json()).catch(() => null),
        fetch('/api/workspaces').then((r) => r.json()).catch(() => null),
        fetch('/api/rooms').then((r) => r.json()).catch(() => ({ rooms: [] })),
        fetch('/api/artifacts?limit=20').then((r) => r.json()).catch(() => ({ artifacts: [] })),
        fetch('/api/budget').then((r) => r.json()).catch(() => ({ evaluation: null })),
        fetch('/api/triggers').then((r) => r.json()).catch(() => ({ triggers: [] })),
        fetch('/api/consensus?limit=12').then((r) => r.json()).catch(() => ({ rounds: [] })),
      ]);
      return {
        ...ov,
        mcp_hub: mcp,
        skills_hub: sk,
        workspaces: ws?.projects || [],
        rooms: rm?.rooms || [],
        artifacts: art?.artifacts || [],
        budget_summary: bud?.evaluation || null,
        triggers: trg?.triggers || [],
        consensus: con?.rounds || [],
      };
    }
    if (name === 'collab_self_heal') {
      if (args.action === 'reconcile_stale') {
        return fetch('/api/tasks/reconcile-stale', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify(args) }).then((r) => r.json());
      }
      return fetch('/api/system/self-heal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify(args) }).then((r) => r.json());
    }
    if (name === 'collab_mcp_find_tools') {
      return fetch('/api/mcp-hub/tools?q=' + encodeURIComponent(args.query || '')).then((r) => r.json());
    }
    if (name === 'collab_mcp_hub' && args.action === 'probe') {
      return fetch('/api/mcp-hub/probe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify({ id: args.id }) }).then((r) => r.json());
    }
    if (name === 'collab_mcp_hub' && args.action === 'import') {
      return fetch('/api/mcp-hub/import', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify({ id: args.id }) }).then((r) => r.json());
    }
    if (name === 'collab_merge_queue' && args.action === 'validate') {
      return fetch('/api/merge-queue/validate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: '{}' }).then((r) => r.json());
    }
    if (name === 'collab_merge_queue' && args.action === 'process') {
      return fetch('/api/merge-queue/process', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify(args) }).then((r) => r.json());
    }
    if (name === 'collab_room' && args.action === 'create') {
      return fetch('/api/rooms/create', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify(args) }).then((r) => r.json());
    }
    if (name === 'collab_handoff_pack') {
      return fetch('/api/handoff-pack', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify(args) }).then((r) => r.json());
    }
    if (name === 'collab_triggers' && args.action === 'run') {
      return fetch('/api/triggers/run', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify(args) }).then((r) => r.json());
    }
    if (name === 'collab_dispatch') {
      const r = await fetch('/api/tasks/dispatch', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify({ ...args, async: true }) });
      const data = await r.json();
      if (!r.ok || data.error) throw new Error(data.error || ('HTTP ' + r.status));
      return data;
    }
    if (name === 'collab_poll') {
      return fetch('/api/tasks/poll', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify({ task_id: args.task_id, wait_sec: args.wait_sec ?? 0 }) }).then((r) => r.json());
    }
    if (name === 'collab_cancel') {
      return fetch('/api/tasks/cancel', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify({ task_id: args.task_id, reason: args.reason }) }).then((r) => r.json());
    }
    if (name === 'collab_skills_hub' && args.action === 'sync_skill') {
      return fetch('/api/skills-hub/sync-skill', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify({ skill_name: args.skill_name, source_client: args.source_client, confirmed: false }) }).then((r) => r.json());
    }
    throw new Error('Action requires live MCP App host');
  }

  /* ------------------------------------------------------------------ */
  /* 60fps HTML5 Canvas Neural Fleet Constellation                      */
  /* ------------------------------------------------------------------ */
  const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const nodePositions = [];
  let animPhase = 0;
  let rafId = null;
  let activeTab = 'radar';

  function shouldAnimate() {
    return !reducedMotion && !document.hidden && activeTab === 'radar';
  }

  function scheduleCanvas() {
    if (rafId !== null) return;
    if (!shouldAnimate()) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      drawFleetCanvas();
    });
  }

  function syncCanvasBadge() {
    const badge = $('#canvasFps');
    if (badge) badge.textContent = shouldAnimate() ? '60fps · live' : (reducedMotion ? 'reduced-motion' : 'static · paused');
  }

  document.addEventListener('visibilitychange', () => {
    syncCanvasBadge();
    if (shouldAnimate()) scheduleCanvas();
  });

  function colorForState(st) {
    if (st === 'online') return '#34d399';
    if (st === 'idle') return '#38bdf8';
    if (st === 'cooldown' || st === 'stale') return '#fbbf24';
    return '#64748b';
  }

  function drawFleetCanvas() {
    const canvas = $('#fleetCanvas');
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 420;
    const h = canvas.clientHeight || 235;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const rx = Math.min(w * 0.36, 165);
    const ry = Math.min(h * 0.34, 78);

    // Subtle concentric orbital radar rings
    ctx.strokeStyle = 'rgba(129, 140, 248, 0.14)';
    ctx.lineWidth = 1;
    for (const s of [0.55, 1.0]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx * s, ry * s, 0, 0, Math.PI * 2);
      ctx.stroke();
    }

    const members = appState.data.members || [];
    const activeByMember = new Set((appState.data.tasks || []).filter((t) => ['running', 'dispatched', 'dispatching'].includes(t.state)).map((t) => t.member));
    nodePositions.length = 0;

    // Draw neural links + travelling energy packets
    members.forEach((m, i) => {
      const baseAngle = (Math.PI * 2 * i) / Math.max(1, members.length) - Math.PI / 2;
      const angle = baseAngle + (reducedMotion ? 0 : Math.sin(animPhase * 0.35 + i) * 0.04);
      const nx = cx + Math.cos(angle) * rx;
      const ny = cy + Math.sin(angle) * ry;
      const col = colorForState(m.state);
      const isBusy = activeByMember.has(m.member);
      const isSel = appState.selectedAgent === m.member;
      nodePositions.push({ m, x: nx, y: ny, r: isSel ? 20 : 16 });

      ctx.strokeStyle = isBusy ? 'rgba(56, 189, 248, 0.65)' : (m.state === 'online' || m.state === 'idle' ? 'rgba(129, 140, 248, 0.32)' : 'rgba(100, 116, 139, 0.18)');
      ctx.lineWidth = isBusy ? 1.8 : 1;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(nx, ny);
      ctx.stroke();

      // Animated signal pulse travelling along link for active/online agents
      if (!reducedMotion && (isBusy || m.state === 'online')) {
        const p = (animPhase * (isBusy ? 0.55 : 0.22) + i * 0.27) % 1;
        const px = cx + (nx - cx) * p;
        const py = cy + (ny - cy) * p;
        ctx.fillStyle = isBusy ? '#38bdf8' : '#34d399';
        ctx.beginPath();
        ctx.arc(px, py, isBusy ? 3.2 : 2.1, 0, Math.PI * 2);
        ctx.fill();
      }
    });

    // Central CollabHub Core Orb
    const corePulse = reducedMotion ? 1 : 1 + Math.sin(animPhase * 1.4) * 0.08;
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, 28 * corePulse);
    grad.addColorStop(0, 'rgba(129, 140, 248, 0.92)');
    grad.addColorStop(0.55, 'rgba(99, 102, 241, 0.34)');
    grad.addColorStop(1, 'rgba(99, 102, 241, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, 28 * corePulse, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = '#6366f1';
    ctx.beginPath();
    ctx.arc(cx, cy, 15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 9.5px ui-monospace, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('HUB', cx, cy + 0.5);

    // Draw orbiting agent nodes
    for (const np of nodePositions) {
      const col = colorForState(np.m.state);
      const isBusy = activeByMember.has(np.m.member);
      const isSel = appState.selectedAgent === np.m.member;
      if (isBusy || isSel) {
        const haloR = np.r + (reducedMotion ? 5 : 4 + Math.sin(animPhase * 2.6) * 3);
        ctx.strokeStyle = isBusy ? 'rgba(56, 189, 248, 0.55)' : 'rgba(129, 140, 248, 0.65)';
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        ctx.arc(np.x, np.y, haloR, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#ffffff' : '#0f1424';
      ctx.strokeStyle = col;
      ctx.lineWidth = isSel ? 2.4 : 1.8;
      ctx.beginPath();
      ctx.arc(np.x, np.y, np.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();

      ctx.fillStyle = document.documentElement.dataset.theme === 'light' ? '#0f172a' : '#eef2ff';
      ctx.font = '700 9.5px ui-monospace, Consolas, monospace';
      ctx.fillText(String(np.m.member || '').toUpperCase().slice(0, 5), np.x, np.y + 0.5);
    }

    syncCanvasBadge();
    if (shouldAnimate()) {
      animPhase += 0.025;
      scheduleCanvas();
    }
  }

  /* ------------------------------------------------------------------ */
  /* Render Views                                                       */
  /* ------------------------------------------------------------------ */
  function applyI18n() {
    $$('[data-i18n]').forEach((el) => { el.textContent = tr(el.getAttribute('data-i18n')); });
    renderAll();
  }

  function switchTab(id) {
    const valid = ['radar', 'tasks', 'mcp', 'skills', 'queue', 'rooms'].includes(id) ? id : 'radar';
    activeTab = valid;
    $$('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === valid));
    $$('.pane').forEach((p) => p.classList.toggle('active', p.id === 'pane-' + valid));
    syncCanvasBadge();
    if (valid === 'radar') drawFleetCanvas();
  }

  function renderAll() {
    const d = appState.data;
    const members = d.members || [];
    const tasks = d.tasks || [];
    const mq = d.merge_queue || [];
    const mcpServers = d.mcp_hub?.servers || [];
    const mcpCount = d.mcp_hub?.summary?.total_servers ?? d.mcp_hub_summary?.servers_count ?? mcpServers.length;
    const skillsCount = d.skills_hub?.summary?.skills_total ?? 0;

    const online = members.filter((m) => ['online', 'idle'].includes(m.state)).length;
    const running = tasks.filter((t) => ['running', 'dispatched', 'dispatching'].includes(t.state)).length;
    const health = Number(d.self_improve?.health_score ?? 100);

    // Health Ring
    const ring = $('#healthRing');
    const hVal = $('#healthVal');
    if (ring) {
      ring.style.strokeDashoffset = String(50.26 * (1 - Math.max(0, Math.min(100, health)) / 100));
      ring.style.stroke = health >= 85 ? 'var(--emerald)' : (health >= 65 ? 'var(--amber)' : 'var(--rose)');
    }
    if (hVal) hVal.textContent = String(health);

    $('#bAgents').textContent = online + '/' + members.length;
    $('#bTasks').textContent = String(tasks.length);
    $('#bMcp').textContent = String(mcpCount);
    $('#bSkills').textContent = String(skillsCount);
    $('#bQueue').textContent = String(mq.length);
    if ($('#bRooms')) $('#bRooms').textContent = String((d.rooms || []).length);

    $('#kpiRow').innerHTML = [
      { l: tr('kAgents'), v: online + ' / ' + members.length, c: 'var(--emerald)' },
      { l: tr('kTasks'), v: running + ' / ' + tasks.length, c: running ? 'var(--cyan)' : 'var(--fg)' },
      { l: tr('kMcp'), v: String(mcpCount), c: 'var(--accent)' },
      { l: tr('kQueue'), v: String(mq.length), c: mq.some((q) => q.status === 'conflict') ? 'var(--rose)' : 'var(--fg)' },
    ].map((k) => '<div class="kpi"><span class="kpi-l">' + esc(k.l) + '</span><span class="kpi-v" style="color:' + k.c + '">' + esc(k.v) + '</span></div>').join('');

    // Sticky Live Cross-Agent Usage Strip
    const lu = d.live_usage || {};
    const luTot = lu.totals || {};
    const luAgents = lu.agents || [];
    const fmtU = (n) => n >= 1000000 ? (n / 1000000).toFixed(2) + 'M' : (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n || 0));
    if ($('#cockpitUsageChips')) {
      $('#cockpitUsageChips').innerHTML = luAgents.slice(0, 6).map((a) =>
        '<span class="u-chip"><span class="u-dot ' + esc(a.status) + '"></span><strong>' + esc(a.name) + '</strong><span class="mono">' + esc(fmtU(a.today_tokens || a.total_7d_tokens)) + '</span></span>'
      ).join('') || '<span class="card-sub">Connect any AI client to stream live usage</span>';
    }
    if ($('#cockpitUsageTotals')) {
      $('#cockpitUsageTotals').textContent = fmtU(luTot.today_tokens || 0) + ' today · ' + fmtU(luTot.tokens_per_min || 0) + '/m · $' + Number(luTot.est_cost_usd_today || 0).toFixed(2) + ' · ' + (luTot.mcp_calls_total || 0) + ' calls';
    }

    // Agent list + Quick Dispatch dropdown
    const sel = appState.selectedAgent;
    $('#selectedNodePill').textContent = sel || 'all';
    $('#agentList').innerHTML = members.map((m) =>
      '<div class="agent-row' + (sel === m.member ? ' selected' : '') + '" data-sel-agent="' + esc(m.member) + '">' +
        '<div class="agent-left"><span class="status-dot ' + esc(m.state) + '"></span><div style="min-width:0"><div class="agent-name">' + esc(m.name || m.member) + '</div><div class="agent-detail">' + esc(m.detail || m.channel) + '</div></div></div>' +
        '<span class="badge ' + (m.state === 'online' || m.state === 'idle' ? 'ok' : (m.state === 'cooldown' ? 'warn' : '')) + '">' + esc(m.state) + '</span>' +
      '</div>'
    ).join('') || '<div class="card-sub">No agents probed yet.</div>';

    const qdSel = $('#qdMember');
    if (qdSel) {
      const cur = qdSel.value || 'auto';
      qdSel.innerHTML = '<option value="auto">auto (smart)</option>' +
        members.filter((m) => m.driver !== 'desktop-native').map((m) => '<option value="' + esc(m.member) + '">' + esc(m.member) + ' (' + esc(m.state) + ')</option>').join('');
      qdSel.value = cur;
    }
    const qdProj = $('#qdProject');
    if (qdProj) {
      const curProj = qdProj.value || appState.projectDir || '';
      const list = Array.isArray(appState.workspaces) ? appState.workspaces : [];
      const opts = list.map((w) => '<option value="' + esc(w.path) + '">' + esc(w.name || w.path) + '</option>');
      if (appState.projectDir && !list.some((w) => w.path === appState.projectDir)) {
        opts.unshift('<option value="' + esc(appState.projectDir) + '">' + esc(appState.projectDir.split(/[\\\\/]/).filter(Boolean).pop() || appState.projectDir) + '</option>');
      }
      qdProj.innerHTML = opts.length ? opts.join('') : '<option value="">No workspace project detected</option>';
      if (curProj && Array.from(qdProj.options).some((o) => o.value === curProj)) {
        qdProj.value = curProj;
      } else if (qdProj.options[0]?.value) {
        qdProj.value = qdProj.options[0].value;
      }
    }
    const sendBtn = $('#btnQdSend');
    if (sendBtn && !dispatchInFlight) {
      sendBtn.disabled = !($('#qdProject')?.value || appState.projectDir);
    }

    // Mini Kanban
    const lanes = [
      { id: 'queued', label: 'Queued', fn: (s) => ['created', 'dispatching', 'dispatched'].includes(s) },
      { id: 'running', label: 'Running', fn: (s) => s === 'running' },
      { id: 'attn', label: 'Attention', fn: (s) => ['stalled', 'uncertain', 'needs_input'].includes(s) },
      { id: 'done', label: 'Done', fn: (s) => ['completed', 'failed', 'cancelled', 'rerouted'].includes(s) },
    ];
    $('#kanbanGrid').innerHTML = lanes.map((ln) => {
      const list = tasks.filter((t) => ln.fn(t.state)).slice(0, 8);
      return '<div class="lane"><div class="lane-head"><span>' + ln.label + '</span><span class="badge">' + list.length + '</span></div>' +
        list.map((t) => '<div class="t-card" data-open-task="' + esc(t.task_id) + '"><div class="t-title">' + esc(t.title || t.task_id) + '</div><div class="t-meta"><span>' + esc(t.member) + '</span><span>' + esc(t.state) + '</span></div></div>').join('') +
      '</div>';
    }).join('');

    // MCP Hub list
    const mcpBox = $('#mcpServerList');
    if (mcpBox) {
      mcpBox.innerHTML = mcpServers.map((s) => {
        const pres = Object.entries(s.client_presence || {}).map(([cid, st]) =>
          '<span class="badge ' + (st === 'present' ? 'ok' : (st === 'drifted' ? 'warn' : '')) + '">' + esc(cid) + ':' + esc(st) + '</span>'
        ).join(' ');
        return '<div class="row-item"><div><strong>' + esc(s.id) + '</strong> <span class="badge">' + esc(s.transport) + '</span> ' + pres + '</div>' +
          '<button type="button" class="btn cyan" data-probe-mcp="' + esc(s.id) + '">Probe</button></div>';
      }).join('') || '<div class="card-sub">Click "Scan Clients" to inspect local MCP servers.</div>';
    }

    // Skills & Rules list
    const skBox = $('#skillsList');
    if (skBox) {
      const sks = d.skills_hub?.skills || [];
      const rules = d.skills_hub?.rules || [];
      skBox.innerHTML = [
        ...sks.map((sk) => '<div class="row-item"><div><strong>SKILL: ' + esc(sk.name) + '</strong> <span class="card-sub">' + esc(sk.description || '') + '</span></div><button type="button" class="btn cyan" data-sync-skill="' + esc(sk.name) + '::' + esc(sk.canonical_client) + '">Dry-Run Sync</button></div>'),
        ...rules.map((r) => '<div class="row-item"><div><strong class="mono">' + esc(r.rel_path) + '</strong> <span class="badge ' + (r.status === 'present' ? 'ok' : (r.status === 'drifted' ? 'warn' : '')) + '">' + esc(r.status) + '</span></div>' + (r.exists ? '<button type="button" class="btn" data-open-file="' + esc(r.rel_path) + '">Open in Pane</button>' : '') + '</div>'),
      ].join('') || '<div class="card-sub">Click "Rescan" to inspect cross-agent Skills &amp; Rules.</div>';
    }

    // Merge Queue list
    const mqBox = $('#mqList');
    if (mqBox) {
      mqBox.innerHTML = mq.map((q, idx) =>
        '<div class="row-item"><div><span class="badge">#' + (idx + 1) + '</span> <strong class="mono">' + esc(q.branch_name) + '</strong> <span class="badge ' + (q.status === 'ready' || q.status === 'merged' ? 'ok' : (q.status === 'conflict' ? 'err' : 'warn')) + '">' + esc(q.status) + '</span><div class="card-sub">' + esc(q.check_summary || q.head_sha?.slice(0, 10) || '') + '</div></div></div>'
      ).join('') || '<div class="card-sub">Merge Queue is empty.</div>';
    }

    // Tab 6: Rooms & Ops
    const rmBox = $('#roomsList');
    if (rmBox) {
      const rooms = d.rooms || [];
      rmBox.innerHTML = rooms.map((rm) =>
        '<div class="row-item"><div><strong class="mono">' + esc(rm.name) + '</strong> <span class="badge ok">' + esc(rm.active_claims || 0) + ' claims</span> <span class="badge">' + esc(rm.log_entries || 0) + ' logs</span><div class="card-sub">' + esc(rm.goal || rm.room_dir || '') + '</div></div></div>'
      ).join('') || '<div class="card-sub">No Shared Rooms yet. Create one above.</div>';
    }
    const opsBox = $('#opsSummaryList');
    if (opsBox) {
      const arts = d.artifacts || [];
      const bud = d.budget_summary;
      const trgs = d.triggers || [];
      const cons = d.consensus || [];
      opsBox.innerHTML = [
        '<div class="row-item"><div><strong>Budget 24h</strong> <span class="badge ' + (bud?.action === 'block' ? 'err' : (bud?.action === 'warn' ? 'warn' : 'ok')) + '">' + esc(bud?.action || 'allow') + '</span></div><span class="mono">calls=' + esc(bud?.usage?.global_calls_24h ?? 0) + ' · tokens=' + esc(bud?.usage?.global_tokens_24h ?? 0) + '</span></div>',
        '<div class="row-item"><div><strong>Artifact Vault</strong> <span class="badge cyan">' + arts.length + '</span></div><span class="card-sub">' + esc(arts.slice(0, 3).map((a) => a.name).join(', ') || 'empty') + '</span></div>',
        '<div class="row-item"><div><strong>Consensus Rounds</strong> <span class="badge">' + cons.length + '</span></div><span class="card-sub">' + esc(cons[0] ? (cons[0].topic + ' → ' + (cons[0].verdict?.decision || cons[0].status)) : 'none') + '</span></div>',
        ...trgs.map((t) => '<div class="row-item"><div><strong>Trigger: ' + esc(t.name) + '</strong> <span class="badge">' + esc(t.action) + '</span><div class="card-sub">' + esc(t.last_summary || ('every ' + (t.interval_sec || '-') + 's')) + '</div></div><button type="button" class="btn cyan" data-run-trigger="' + esc(t.trigger_id) + '">Run Now</button></div>'),
      ].join('');
    }

    if (reducedMotion) drawFleetCanvas();
  }

  /* ------------------------------------------------------------------ */
  /* Interactions                                                       */
  /* ------------------------------------------------------------------ */
  $$('.tab').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));
  $('#btnLang').addEventListener('click', () => { lang = lang === 'zh' ? 'en' : 'zh'; applyI18n(); });

  $('#fleetCanvas').addEventListener('click', (e) => {
    const rect = e.target.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = nodePositions.find((np) => Math.hypot(np.x - x, np.y - y) <= np.r + 6);
    if (hit) {
      appState.selectedAgent = appState.selectedAgent === hit.m.member ? null : hit.m.member;
      if (appState.selectedAgent && $('#qdMember') && hit.m.driver !== 'desktop-native') $('#qdMember').value = appState.selectedAgent;
      renderAll();
      showToast('Focused agent: ' + (appState.selectedAgent || 'all'));
    }
  });

  async function refreshState() {
    try {
      const fresh = await callServer('collab_cockpit_state', {});
      ingestPayload(fresh);
      showToast(lang === 'zh' ? '驾驶舱数据已同步' : 'Cockpit synced');
    } catch (err) { showToast(err.message); }
  }

  $('#btnRefresh').addEventListener('click', refreshState);
  $('#btnProbe').addEventListener('click', async () => {
    showToast(lang === 'zh' ? '正在探活全舰队…' : 'Probing fleet…');
    try {
      await callServer('collab_roster', {});
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  let healArmed = false;
  let healArmedAt = 0;
  let healArmTimer = null;
  $('#btnHeal').addEventListener('click', async () => {
    try {
      if (!healArmed) {
        const res = await callServer('collab_self_heal', { apply: false });
        const count = (res.actions_taken || res.actions || []).length;
        if (count === 0) {
          showToast('Health ' + (res.before_score ?? '?') + '/100 · No healable issues');
          return;
        }
        healArmed = true;
        healArmedAt = Date.now();
        $('#btnHeal').textContent = 'Confirm Heal?';
        clearTimeout(healArmTimer);
        healArmTimer = setTimeout(() => { healArmed = false; $('#btnHeal').textContent = '✚ Heal'; }, 5000);
        showToast('Preview: ' + (res.before_score ?? '?') + ' → ' + (res.after_score ?? '?') + ' (' + count + ' healable) · Click again within 5s to apply');
        return;
      }
      if (Date.now() - healArmedAt < 400) return;
      healArmed = false;
      clearTimeout(healArmTimer);
      $('#btnHeal').textContent = '✚ Heal';
      const applied = await callServer('collab_self_heal', { apply: true });
      showToast('Healed: ' + (applied.before_score ?? '?') + ' → ' + (applied.after_score ?? '?'));
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  $('#btnAskHost').addEventListener('click', async () => {
    const d = appState.data;
    const online = (d.members || []).filter((m) => ['online', 'idle'].includes(m.state)).map((m) => m.member).join(', ');
    try {
      await sendRpcRequest('ui/message', {
        role: 'user',
        content: [{ type: 'text', text: '[CollabHub Cockpit] Online agents: ' + (online || 'none') + ' | Health: ' + (d.self_improve?.health_score ?? 100) + '/100 | Active tasks: ' + (d.tasks || []).filter((t) => t.state === 'running').length }],
      });
      showToast('Sent fleet telemetry to host chat');
    } catch (err) { showToast(err.message); }
  });

  let dispatchInFlight = false;
  $('#btnQdSend').addEventListener('click', async () => {
    if (dispatchInFlight) return;
    const prompt = ($('#qdPrompt')?.value || '').trim();
    const projectDir = ($('#qdProject')?.value || appState.projectDir || '').trim();
    if (!projectDir) { showToast('Select a target project directory first'); return; }
    if (!prompt) { showToast('Enter a prompt first'); return; }
    dispatchInFlight = true;
    const btn = $('#btnQdSend');
    if (btn) btn.disabled = true;
    const clientTaskId = 'ck_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    try {
      const res = await callServer('collab_dispatch', {
        task_id: clientTaskId,
        member: $('#qdMember')?.value || 'auto',
        role: $('#qdRole')?.value || 'researcher',
        project_dir: projectDir,
        title: prompt.slice(0, 60),
        prompt,
        auto_fallback: true,
      });
      $('#qdPrompt').value = '';
      showToast('Dispatched: ' + (res.task_id || res.task?.task_id || clientTaskId));
      await refreshState();
    } catch (err) {
      showToast(err.message);
    } finally {
      dispatchInFlight = false;
      if (btn) btn.disabled = !($('#qdProject')?.value || appState.projectDir);
    }
  });

  $('#btnMcpScan').addEventListener('click', refreshState);
  $('#btnMcpImportAll')?.addEventListener('click', async () => {
    showToast('Importing local MCP servers…');
    try {
      const res = await callServer('collab_mcp_hub', { action: 'import' });
      showToast('Imported ' + (res.imported?.length ?? res.imported_count ?? 0) + ' MCP server(s)');
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  $('#btnSkScan').addEventListener('click', refreshState);
  $('#btnMcpSearch').addEventListener('click', async () => {
    const q = ($('#mcpSearchInput')?.value || '').trim();
    try {
      const res = await callServer('collab_mcp_find_tools', { query: q, limit: 15 });
      $('#mcpToolHits').innerHTML = (res.matches || []).map((m) =>
        '<div class="row-item"><div><code class="mono" style="color:var(--cyan)">' + esc(m.tool_name) + '</code> <span class="badge">' + esc(m.server_id) + '</span><div class="card-sub">' + esc(m.description || '') + '</div></div></div>'
      ).join('') || '<div class="card-sub">No cached tools matched. Probe a server below first.</div>';
    } catch (err) { showToast(err.message); }
  });

  $('#btnMqValidate').addEventListener('click', async () => {
    try {
      const res = await callServer('collab_merge_queue', { action: 'validate' });
      if (res.queue) appState.data.merge_queue = res.queue;
      renderAll();
      showToast('Speculative merge-tree check complete');
    } catch (err) { showToast(err.message); }
  });
  let mqArmed = false;
  let mqArmedAt = 0;
  let mqArmTimer = null;
  $('#btnMqProcess')?.addEventListener('click', async () => {
    if (!mqArmed) {
      mqArmed = true;
      mqArmedAt = Date.now();
      $('#btnMqProcess').textContent = 'Confirm Merge?';
      clearTimeout(mqArmTimer);
      mqArmTimer = setTimeout(() => { mqArmed = false; $('#btnMqProcess').textContent = 'Process Queue'; }, 5000);
      showToast('Click "Confirm Merge?" within 5s to serially merge ready queue items');
      return;
    }
    if (Date.now() - mqArmedAt < 400) return;
    mqArmed = false;
    clearTimeout(mqArmTimer);
    $('#btnMqProcess').textContent = 'Process Queue';
    try {
      const res = await callServer('collab_merge_queue', { action: 'process', confirmed: true });
      showToast('Merge queue processed (' + ((res.merged || []).length) + ' merged)');
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  let roomArmedKey = null;
  let roomArmedAt = 0;
  let roomArmTimer = null;
  $('#btnRmCreate')?.addEventListener('click', async () => {
    const name = ($('#rmNameInput')?.value || '').trim();
    const goal = ($('#rmGoalInput')?.value || '').trim();
    if (!name) { showToast('Enter room name first'); return; }
    const key = name + '::' + goal;
    try {
      if (roomArmedKey !== key) {
        const dry = await callServer('collab_room', { action: 'create', name, goal, confirmed: false });
        roomArmedKey = key;
        roomArmedAt = Date.now();
        $('#btnRmCreate').textContent = 'Confirm Room?';
        clearTimeout(roomArmTimer);
        roomArmTimer = setTimeout(() => { roomArmedKey = null; $('#btnRmCreate').textContent = 'Create Room'; }, 6000);
        const out = $('#opsOut');
        if (out) { out.hidden = false; out.textContent = JSON.stringify(dry, null, 2); }
        showToast((dry.already_exists ? 'Existing dir detected! ' : 'Dry-run ready: ') + (dry.files_to_write?.length ?? 0) + ' file(s) · Click "Confirm Room?"');
        return;
      }
      if (Date.now() - roomArmedAt < 400) return;
      roomArmedKey = null;
      clearTimeout(roomArmTimer);
      $('#btnRmCreate').textContent = 'Create Room';
      const res = await callServer('collab_room', { action: 'create', name, goal, confirmed: true });
      $('#rmNameInput').value = '';
      $('#rmGoalInput').value = '';
      showToast('Room ready: ' + (res.room_name || name));
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  $('#btnGenHandoff')?.addEventListener('click', async () => {
    try {
      const res = await callServer('collab_handoff_pack', { project_dir: appState.projectDir, save_artifact: true });
      const out = $('#opsOut');
      if (out) { out.hidden = false; out.textContent = res.markdown || JSON.stringify(res, null, 2); }
      showToast('Handoff Pack generated (' + (res.bytes || 0) + 'B)');
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  let staleCandidateIds = null;
  let staleArmedAt = 0;
  let staleTimer = null;
  $('#btnReconcileStale')?.addEventListener('click', async () => {
    if (!staleCandidateIds) {
      const dry = await callServer('collab_self_heal', { action: 'reconcile_stale', confirmed: false });
      const ids = Array.isArray(dry.candidates) ? dry.candidates.map((c) => c.task_id).filter(Boolean) : [];
      if (ids.length === 0) {
        showToast('Dry-run: 0 aged stale tasks found');
        return;
      }
      staleCandidateIds = ids;
      staleArmedAt = Date.now();
      $('#btnReconcileStale').textContent = 'Confirm Clean?';
      clearTimeout(staleTimer);
      staleTimer = setTimeout(() => { staleCandidateIds = null; $('#btnReconcileStale').textContent = 'Clean Stale'; }, 5000);
      showToast('Dry-run: ' + ids.length + ' aged stale task(s) · Click again within 5s');
      return;
    }
    if (Date.now() - staleArmedAt < 400) return;
    const idsToClean = staleCandidateIds;
    staleCandidateIds = null;
    clearTimeout(staleTimer);
    $('#btnReconcileStale').textContent = 'Clean Stale';
    try {
      const res = await callServer('collab_self_heal', { action: 'reconcile_stale', task_ids: idsToClean, confirmed: true });
      showToast('Reconciled ' + (res.reconciled_count ?? 0) + ' stale tasks');
      await refreshState();
    } catch (err) { showToast(err.message); }
  });

  $('#btnTdClose').addEventListener('click', () => { $('#taskDetailCard').hidden = true; });
  $('#btnTdLogs')?.addEventListener('click', async () => {
    if (!appState.selectedTask) return;
    try {
      const res = appState.mode === 'standalone'
        ? await fetch('/api/tasks/logs?task_id=' + encodeURIComponent(appState.selectedTask)).then((r) => r.json())
        : await callServer('collab_poll', { task_id: appState.selectedTask, wait_sec: 0 });
      const lines = Array.isArray(res.logs) ? res.logs.map((l) => '[' + (l.ts || '') + '] ' + (l.line || '')).join('\\n') : '';
      $('#tdBody').textContent = lines || res.result_text || res.error_message || JSON.stringify(res, null, 2);
    } catch (err) { showToast(err.message); }
  });
  $('#btnTdPoll').addEventListener('click', async () => {
    if (!appState.selectedTask) return;
    try {
      const res = await callServer('collab_poll', { task_id: appState.selectedTask, wait_sec: 0 });
      $('#tdBody').textContent = res.result_text || res.error_message || JSON.stringify(res, null, 2);
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  let cancelArmedId = null;
  let cancelArmedAt = 0;
  let cancelArmTimer = null;
  $('#btnTdCancel').addEventListener('click', async () => {
    if (!appState.selectedTask) return;
    if (cancelArmedId !== appState.selectedTask) {
      cancelArmedId = appState.selectedTask;
      cancelArmedAt = Date.now();
      clearTimeout(cancelArmTimer);
      $('#btnTdCancel').textContent = 'Confirm Cancel?';
      cancelArmTimer = setTimeout(() => { cancelArmedId = null; $('#btnTdCancel').textContent = 'Cancel'; }, 4000);
      showToast('Click "Confirm Cancel?" within 4s to abort this task');
      return;
    }
    if (Date.now() - cancelArmedAt < 400) return;
    cancelArmedId = null;
    clearTimeout(cancelArmTimer);
    $('#btnTdCancel').textContent = 'Cancel';
    try {
      await callServer('collab_cancel', { task_id: appState.selectedTask, reason: 'Cancelled from MCP App Cockpit' });
      showToast('Cancel requested');
      await refreshState();
    } catch (err) { showToast(err.message); }
  });

  document.addEventListener('click', async (e) => {
    const el = e.target instanceof Element ? e.target : null;
    if (!el) return;
    const ag = el.closest('[data-sel-agent]');
    if (ag) {
      appState.selectedAgent = ag.getAttribute('data-sel-agent');
      renderAll();
      return;
    }
    const tk = el.closest('[data-open-task]');
    if (tk) {
      const id = tk.getAttribute('data-open-task');
      appState.selectedTask = id;
      const row = (appState.data.tasks || []).find((t) => t.task_id === id);
      $('#taskDetailCard').hidden = false;
      $('#tdTitle').textContent = row?.title || id;
      $('#tdMeta').textContent = id + ' · ' + (row?.member || '') + ' · ' + (row?.state || '');
      $('#tdBody').textContent = row?.result_text || row?.error_message || row?.prompt || '(no output yet)';
      return;
    }
    const pr = el.closest('[data-probe-mcp]');
    if (pr) {
      const id = pr.getAttribute('data-probe-mcp');
      showToast('Probing MCP ' + id + '…');
      try {
        const res = await callServer('collab_mcp_hub', { action: 'probe', id });
        showToast(res.detail || ('Probed ' + id));
        await refreshState();
      } catch (err) { showToast(err.message); }
      return;
    }
    const trEl = el.closest('[data-run-trigger]');
    if (trEl) {
      const trigger_id = trEl.getAttribute('data-run-trigger');
      showToast('Running trigger ' + trigger_id + '…');
      try {
        const res = await callServer('collab_triggers', { action: 'run', trigger_id });
        showToast(res.summary || 'Trigger finished');
        await refreshState();
      } catch (err) { showToast(err.message); }
      return;
    }
    const sk = el.closest('[data-sync-skill]');
    if (sk) {
      const [skill_name, source_client] = sk.getAttribute('data-sync-skill').split('::');
      try {
        const res = await callServer('collab_skills_hub', { action: 'sync_skill', skill_name, source_client, confirmed: false });
        const box = $('#skillsDiffOut');
        box.hidden = false;
        box.textContent = (res.plans || []).map((p) => p.diff_preview).join('\\n\\n') || 'Already in sync';
      } catch (err) { showToast(err.message); }
      return;
    }
    const of = el.closest('[data-open-file]');
    if (of && inIframe && appState.projectDir) {
      const rel = of.getAttribute('data-open-file');
      const uri = 'file:///' + appState.projectDir.replaceAll('\\\\', '/').replace(/^\\/+/, '') + '/' + rel;
      try {
        await sendRpcRequest('com.google.antigravity/toggle-aux-pane', { tabType: 'fileView', uri });
      } catch { showToast('Host does not support aux-pane file viewer'); }
    }
  });

  /* ------------------------------------------------------------------ */
  /* Boot: SEP-1865 Handshake OR Standalone HTTP Preview                */
  /* ------------------------------------------------------------------ */
  function loadStaticDemoCockpit() {
    appState.isStaticDemo = true;
    ingestPayload({
      members: [
        { member: 'codex', name: 'Codex', driver: 'desktop-native', channel: 'desktop-native', state: 'online', detail: 'Active · security & coding flagship' },
        { member: 'claude', name: 'Claude Code', driver: 'claude-dual', channel: 'desktop-native', state: 'online', detail: 'Active · architecture & UX' },
        { member: 'agy', name: 'Antigravity', driver: 'desktop-native', channel: 'desktop-native', state: 'online', detail: 'Active · long-context & copywriting' },
        { member: 'cursor', name: 'Cursor IDE', driver: 'generic-cli', channel: 'http', state: 'idle', detail: 'Connected via Streamable /mcp' },
      ],
      tasks: [
        { task_id: 'demo-1', member: 'codex', state: 'running', title: 'Audit SSRF & /mcp origin checks' },
        { task_id: 'demo-2', member: 'claude', state: 'completed', title: 'Verify sticky sidebar Webview UX' },
      ],
      workspaces: [{ name: 'collab-hub', path: '/workspace/collab-hub' }],
      project_dir: '/workspace/collab-hub',
      self_improve: { health_score: 96 },
      mcp_hub: {
        summary: { total_servers: 6 },
        servers: [
          { id: 'collab-hub', transport: 'http', cached_tools_count: 23, status: 'healthy' },
          { id: 'github', transport: 'stdio', cached_tools_count: 18, status: 'healthy' },
        ],
      },
      skills_hub: {
        summary: { skills_total: 12 },
        skills: [{ name: 'workers-best-practices', clients: ['claude-code', 'codex', 'cursor'] }],
        rules: [{ target_id: 'claude-md', status: 'in_sync' }],
      },
      merge_queue: [{ branch_name: 'collab/v3/smart-router', status: 'ready', check_summary: 'Clean merge onto main' }],
      rooms: [{ name: 'v3-launch', active_claims: 2, log_entries: 9, goal: 'Always-on multi-agent cockpit' }],
      artifacts: [{ name: 'security-audit.md', author: 'codex', bytes: 2480 }],
      budget_summary: { action: 'allow', global_calls_24h: 186, global_tokens_24h: 412800 },
      triggers: [{ name: 'nightly-health-check', action: 'doctor', interval_sec: 1800, enabled: true }],
      consensus: [{ topic: 'Enable cockpit MCP profile by default', status: 'approved', votes: [{ member: 'agy', stance: 'approve' }, { member: 'codex', stance: 'approve' }] }],
      live_usage: {
        totals: { today_tokens: 412800, tokens_per_min: 1420, est_cost_usd_today: 2.18, mcp_calls_total: 186 },
        agents: [
          { name: 'Claude Code', status: 'active', today_tokens: 168400 },
          { name: 'Codex', status: 'active', today_tokens: 124600 },
          { name: 'Antigravity', status: 'active', today_tokens: 68200 },
          { name: 'Cursor', status: 'recent', today_tokens: 29400 },
        ],
      },
    });
  }

  async function boot() {
    const qp = new URLSearchParams(location.search);
    if (qp.get('mode') === 'dock') document.body.classList.add('dock-mode');
    applyI18n();
    drawFleetCanvas();
    if (inIframe) {
      try {
        const initRes = await sendRpcRequest('ui/initialize', {
          protocolVersion: '2026-01-26',
          appInfo: { name: 'CollabHub Cockpit', version: '${APP_VERSION}' },
          appCapabilities: {},
        }, 4000);
        appState.mode = 'mcp-app';
        appState.hostCaps = initRes?.hostCapabilities || {};
        if (initRes?.hostContext) applyHostContext(initRes.hostContext);
        if (appState.hostCaps?.message) $('#btnAskHost').hidden = false;
        if (appState.hostCaps?.updateModelContext) $('#btnAttachCtx').hidden = false;
        $('#btnAttachCtx')?.addEventListener('click', async () => {
          const members = appState.data.members || [];
          const online = members.filter((m) => ['online', 'idle'].includes(m.state)).map((m) => m.member).join(', ') || 'none';
          const tot = appState.data.live_usage?.totals || {};
          const health = appState.data.self_improve?.health_score ?? 100;
          const summary = '[CollabHub Live Context] Health=' + health + '/100 | Online=' + online + ' | Today=' + fmtTok(tot.today_tokens || 0) + ' tok ($' + Number(tot.est_cost_usd_today || 0).toFixed(2) + ') | Active Tasks=' + (appState.data.tasks || []).filter((t) => t.state === 'running').length;
          try {
            await sendRpcRequest('ui/update-model-context', { content: [{ type: 'text', text: summary }] });
            showToast('Attached live CollabHub pill to chat box');
          } catch (err) {
            showToast(err.message);
          }
        });
        $('#hostBadge').textContent = 'MCP App · ' + (initRes?.hostInfo?.name || 'Native Host');
        sendRpcNotification('ui/notifications/initialized', {});
        if (typeof ResizeObserver !== 'undefined') {
          let lastSentH = 0;
          let resizeTimer = null;
          const ro = new ResizeObserver(() => {
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => {
              const h = Math.max(240, Math.min(780, Math.ceil(document.body.scrollHeight)));
              if (Math.abs(h - lastSentH) >= 8) {
                lastSentH = h;
                sendRpcNotification('ui/notifications/size-changed', { height: h });
              }
            }, 90);
          });
          ro.observe(document.body);
        }
        setTimeout(() => { if (!appState.data.members.length) refreshState(); }, 350);
        return;
      } catch {
        // Fall through to standalone mode
      }
    }
    appState.mode = 'standalone';
    $('#hostBadge').textContent = qp.get('mode') === 'dock' ? 'Resident Dock HUD · Live' : 'Standalone Cockpit Preview';
    const isStaticMeta = document.querySelector('meta[name="collabhub-static-demo"]')?.content === '1';
    if (isStaticMeta) {
      $('#hostBadge').textContent = 'Interactive Static Demo · GitHub Pages';
      loadStaticDemoCockpit();
      return;
    }
    try {
      const fresh = await callServer('collab_cockpit_state', {});
      ingestPayload(fresh);
    } catch {
      loadStaticDemoCockpit();
    }
    setInterval(() => {
      if (!document.hidden && appState.mode === 'standalone') {
        callServer('collab_cockpit_state', {}).then(ingestPayload).catch(() => {});
      }
    }, 5000);
  }

  boot();
})();
</script>
</body>
</html>`;
}

/**
 * Compact SEP-1865 In-Conversation HUD Strip (`ui://collab-hub/chat-strip.html`).
 * Renders inline inside agent conversations beside/after `collab_plan` or `collab_usage`
 * calls, auto-resizes cleanly (~190px), and exposes 1-click `ui/update-model-context`
 * so users can attach live routing/usage state as a pill right in their chat box.
 */
export function buildChatStripAppHtml() {
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>CollabHub Chat Strip</title>
<style>
  :root {
    --bg: var(--color-background-primary, #0b1020);
    --bg2: var(--color-background-secondary, #12182d);
    --fg: var(--color-text-primary, #e2e8f0);
    --fg2: var(--color-text-secondary, #94a3b8);
    --bd: var(--color-border-primary, rgba(148, 163, 184, 0.18));
    --accent: #818cf8;
    --cyan: #38bdf8;
    --green: #34d399;
    --font: var(--font-sans, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif);
    --mono: ui-monospace, "Cascadia Code", Consolas, monospace;
  }
  :root[data-theme="light"] {
    --bg: var(--color-background-primary, #f8fafc);
    --bg2: var(--color-background-secondary, #ffffff);
    --fg: var(--color-text-primary, #0f172a);
    --fg2: var(--color-text-secondary, #475569);
    --bd: var(--color-border-primary, rgba(15, 23, 42, 0.12));
    --accent: #4f46e5;
    --cyan: #0284c7;
    --green: #059669;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  [hidden] { display: none !important; }
  body { background: transparent; color: var(--fg); font-family: var(--font); font-size: 12px; padding: 4px; overflow-x: clip; }
  .strip {
    border: 1px solid var(--bd);
    border-radius: 11px;
    background: var(--bg2);
    padding: 10px 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .top { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .brand { display: flex; align-items: center; gap: 7px; font-weight: 700; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--green); box-shadow: 0 0 8px var(--green); }
  .pill { font-size: 10.5px; padding: 2px 7px; border-radius: 999px; border: 1px solid var(--bd); color: var(--fg2); }
  .pill.hi { color: var(--green); border-color: rgba(52, 211, 153, 0.35); }
  .grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
  .cell { border: 1px solid var(--bd); border-radius: 8px; background: var(--bg); padding: 6px 8px; }
  .lbl { font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--fg2); display: block; }
  .val { font-size: 13px; font-weight: 700; font-family: var(--mono); }
  .route-box {
    border: 1px solid rgba(129, 140, 248, 0.36);
    border-radius: 8px;
    padding: 7px 9px;
    background: rgba(99, 102, 241, 0.08);
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .chips { display: flex; gap: 5px; flex-wrap: wrap; }
  .actions { display: flex; align-items: center; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
  .btn-row { display: flex; gap: 6px; flex-wrap: wrap; }
  .btn {
    border: 1px solid var(--bd); background: var(--bg); color: var(--fg);
    border-radius: 7px; padding: 4px 9px; font-size: 11px; font-weight: 600; cursor: pointer;
  }
  .btn.pri { background: var(--accent); border-color: var(--accent); color: #fff; }
  .btn.cy { color: var(--cyan); border-color: rgba(56, 189, 248, 0.35); }
  .status { font-size: 11px; color: var(--fg2); }
</style>
</head>
<body>
  <div class="strip">
    <div class="top">
      <div class="brand"><span class="dot"></span><span>CollabHub In-Chat HUD</span><span class="pill" id="stripMode">v${APP_VERSION}</span></div>
      <div class="chips" id="agentChips"></div>
    </div>
    <div class="grid">
      <div class="cell"><span class="lbl">Today Tokens</span><span class="val" id="kTok">0</span></div>
      <div class="cell"><span class="lbl">Est. Cost</span><span class="val" id="kCost">$0.00</span></div>
      <div class="cell"><span class="lbl">Burn / Calls</span><span class="val" id="kCalls">0/m · 0</span></div>
    </div>
    <div class="route-box" id="routeBox" hidden>
      <div style="display:flex;justify-content:space-between;gap:6px;align-items:center">
        <strong id="routePick">Recommended: —</strong>
        <span class="pill hi" id="routeScore">score —</span>
      </div>
      <div class="status" id="routeReasons"></div>
    </div>
    <div class="actions">
      <span class="status" id="stripNote">Metadata-only live strip</span>
      <div class="btn-row">
        <button type="button" class="btn cy" id="btnAttachPill" hidden>📌 Attach to Chat</button>
        <button type="button" class="btn pri" id="btnOpenCockpit">◧ Open Side Cockpit</button>
      </div>
    </div>
  </div>
<script>
(() => {
  const $ = (s) => document.querySelector(s);
  const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const fmtTok = (n) => { const x = Number(n) || 0; return x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : (x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(x)); };
  const inIframe = window.parent && window.parent !== window;
  let seq = 1;
  const pending = new Map();
  let lastPayload = null;
  let hostCaps = {};

  function sendReq(method, params) {
    return new Promise((resolve, reject) => {
      const id = 'cs_' + (++seq);
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('timeout')); }, 5000);
      pending.set(id, { resolve, reject, timer });
      window.parent.postMessage({ jsonrpc: '2.0', id, method, params }, '*');
    });
  }

  function applyCtx(ctx) {
    if (!ctx) return;
    if (ctx.theme === 'light' || ctx.theme === 'dark') document.documentElement.setAttribute('data-theme', ctx.theme);
    const vars = ctx.styles && ctx.styles.variables;
    if (vars && typeof vars === 'object') {
      for (const [k, v] of Object.entries(vars)) {
        if (k.startsWith('--') && typeof v === 'string') document.documentElement.style.setProperty(k, v);
      }
    }
  }

  function renderData(sc) {
    if (!sc || typeof sc !== 'object') return;
    lastPayload = sc;
    const tot = sc.totals || sc.live_usage?.totals || {};
    const agents = sc.agents || sc.live_usage?.agents || sc.eligible || [];
    $('#kTok').textContent = fmtTok(tot.today_tokens || tot.total_7d_tokens || 0);
    $('#kCost').textContent = '$' + Number(tot.est_cost_usd_today || 0).toFixed(2);
    $('#kCalls').textContent = fmtTok(tot.tokens_per_min || 0) + '/m · ' + String(tot.mcp_calls_total || 0);
    $('#agentChips').innerHTML = (Array.isArray(agents) ? agents : []).slice(0, 4).map((a) => {
      const lbl = a.name || a.member || a.agent_id || 'agent';
      return '<span class="pill">' + esc(lbl) + (a.today_tokens ? ' ' + esc(fmtTok(a.today_tokens)) : '') + '</span>';
    }).join('');
    if (sc.recommended) {
      $('#routeBox').hidden = false;
      $('#routePick').textContent = 'Recommended: ' + (sc.recommended.name || sc.recommended.member) + ' (' + (sc.recommended.model_tier || 'flagship') + ')';
      $('#routeScore').textContent = (sc.task_classification?.category || 'route') + ' · ' + String(sc.recommended.score ?? '');
      $('#routeReasons').textContent = (sc.recommended.routing_reasons || []).join(' · ');
    }
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window.parent) return;
    const m = ev.data;
    if (!m || m.jsonrpc !== '2.0') return;
    if (m.id !== undefined && (m.result !== undefined || m.error !== undefined)) {
      const slot = pending.get(m.id);
      if (!slot) return;
      pending.delete(m.id);
      clearTimeout(slot.timer);
      if (m.error) slot.reject(new Error(m.error.message || 'RPC error'));
      else slot.resolve(m.result);
      return;
    }
    if (m.method === 'ui/notifications/tool-result') {
      const sc = m.params?.structuredContent || null;
      if (sc) renderData(sc);
    } else if (m.method === 'ui/notifications/host-context-changed') {
      applyCtx(m.params);
    } else if (m.method === 'ping' && m.id !== undefined) {
      window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
    }
  });

  $('#btnAttachPill').addEventListener('click', async () => {
    const rec = lastPayload?.recommended;
    const summary = rec
      ? '[CollabHub Smart Route] ' + (rec.name || rec.member) + ' (score=' + rec.score + ', ' + (lastPayload?.task_classification?.category || '') + ') :: ' + (rec.routing_reasons || []).join('; ')
      : '[CollabHub Live HUD] Today=' + $('#kTok').textContent + ' tok (' + $('#kCost').textContent + ')';
    try {
      await sendReq('ui/update-model-context', { content: [{ type: 'text', text: summary }] });
      $('#stripNote').textContent = 'Attached pill to next chat message!';
    } catch (err) {
      $('#stripNote').textContent = err.message;
    }
  });

  $('#btnOpenCockpit').addEventListener('click', async () => {
    if (inIframe) {
      try {
        await sendReq('tools/call', { name: 'collab_cockpit', arguments: {} });
        $('#stripNote').textContent = 'Opened CollabHub Side Cockpit';
      } catch (err) { $('#stripNote').textContent = err.message; }
    } else {
      window.open('/cockpit?mode=dock', '_blank', 'width=460,height=840');
    }
  });

  async function init() {
    if (inIframe) {
      try {
        const res = await sendReq('ui/initialize', {
          protocolVersion: '2026-01-26',
          appInfo: { name: 'CollabHub Chat Strip', version: '${APP_VERSION}' },
          appCapabilities: {},
        });
        hostCaps = res?.hostCapabilities || {};
        if (res?.hostContext) applyCtx(res.hostContext);
        if (hostCaps.updateModelContext) $('#btnAttachPill').hidden = false;
        window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/initialized', params: {} }, '*');
        if (typeof ResizeObserver !== 'undefined') {
          new ResizeObserver(() => {
            const h = Math.max(150, Math.min(340, Math.ceil(document.body.scrollHeight)));
            window.parent.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/size-changed', params: { height: h } }, '*');
          }).observe(document.body);
        }
        return;
      } catch {}
    }
    try {
      const live = await fetch('/api/usage/live?local=1').then((r) => r.json());
      renderData(live);
    } catch {
      renderData({ totals: { today_tokens: 412800, tokens_per_min: 1420, est_cost_usd_today: 2.18, mcp_calls_total: 186 }, agents: [{ name: 'Claude', today_tokens: 168400 }, { name: 'Codex', today_tokens: 124600 }] });
    }
  }
  init();
})();
</script>
</body>
</html>`;
}
