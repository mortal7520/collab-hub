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
  overflow-x: hidden;
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

/* Header HUD */
.hud-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: 12px;
  border: 1px solid var(--bd);
  background: var(--glass);
  backdrop-filter: blur(12px);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
  flex-wrap: wrap;
}
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
      <button type="button" class="btn primary" id="btnAskHost" hidden>↗ Send to Chat</button>
    </div>
  </header>

  <nav class="tabs" role="tablist">
    <button type="button" class="tab active" data-tab="radar"><span data-i18n="tRadar">Fleet Radar</span> <span class="badge ok" id="bAgents">0</span></button>
    <button type="button" class="tab" data-tab="tasks"><span data-i18n="tTasks">Kanban &amp; Logs</span> <span class="badge" id="bTasks">0</span></button>
    <button type="button" class="tab" data-tab="mcp"><span data-i18n="tMcp">MCP Hub</span> <span class="badge cyan" id="bMcp">0</span></button>
    <button type="button" class="tab" data-tab="skills"><span data-i18n="tSkills">Skills &amp; Rules</span> <span class="badge" id="bSkills">0</span></button>
    <button type="button" class="tab" data-tab="queue"><span data-i18n="tQueue">Merge Queue</span> <span class="badge" id="bQueue">0</span></button>
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
        <select class="input" id="qdMember" style="max-width:130px"><option value="auto">auto</option></select>
        <select class="input" id="qdRole" style="max-width:120px">
          <option value="researcher">researcher</option>
          <option value="reviewer">reviewer</option>
          <option value="implementer">implementer</option>
          <option value="tester">tester</option>
        </select>
        <select class="input" id="qdProject" style="max-width:165px"><option value="">Select project…</option></select>
        <input class="input" id="qdPrompt" placeholder="Enter bounded goal & deliverable…" />
        <button type="button" class="btn primary" id="btnQdSend" data-i18n="qdSend">Dispatch</button>
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
          <button type="button" class="btn warn" id="btnTdCancel">Cancel</button>
          <button type="button" class="btn" id="btnTdClose">×</button>
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
        <button type="button" class="btn cyan" id="btnMcpScan">Scan Clients</button>
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
        </div>
      </div>
      <div class="list" id="mqList"></div>
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
      tRadar: 'Fleet Radar', tTasks: 'Kanban & Logs', tMcp: 'MCP Hub', tSkills: 'Skills & Rules', tQueue: 'Merge Queue',
      fleetTitle: 'Live Agent Constellation', qdTitle: 'In-Host Quick Dispatch',
      qdSub: 'Dispatch directly to background agents without leaving your IDE.', qdSend: 'Dispatch',
      mcpTitle: 'All-Agent MCP Hub & Meta-MCP Router', mcpSub: 'Zero-secret drift matrix & lazy tool discovery across AGY / Codex / Claude.',
      skTitle: 'Cross-Agent Skills & Rules Sync', skSub: 'SKILL.md & AGENTS.md / CLAUDE.md alignment with Dry-Run + .bak backups.',
      mqTitle: 'Serialized Agent Merge Queue', mqSub: 'Side-effect-free speculative git merge-tree pre-flight validation.',
      kAgents: 'Online Agents', kTasks: 'Active / Total', kMcp: 'MCP Servers', kQueue: 'Merge Queue',
    },
    zh: {
      tRadar: '舰队雷达', tTasks: '看板与日志', tMcp: 'MCP 中心', tSkills: '技能与规范', tQueue: '合并队列',
      fleetTitle: '实时 Agent 神经拓扑', qdTitle: '宿主内一键派发',
      qdSub: '无需切去网页，在当前聊天窗口/侧栏直接派发后台任务。', qdSend: '立即派发',
      mcpTitle: '全 Agent MCP 中心与 Meta-MCP 路由', mcpSub: '跨 AGY / Codex / Claude 零密钥漂移矩阵与按需工具发现。',
      skTitle: '跨 Agent Skills / Rules 同步中心', skSub: '统一管理 SKILL.md 与 AGENTS.md / CLAUDE.md（预演 + .bak 备份）。',
      mqTitle: '串行 Agent 合并队列', mqSub: '零副作用 git merge-tree 累计冲突预演，防止并发分支互撞。',
      kAgents: '在线 Agent', kTasks: '运行中 / 总任务', kMcp: 'MCP 服务', kQueue: '合并队列',
    },
  };
  const tr = (k) => STR[lang]?.[k] || STR.en[k] || k;

  const appState = {
    mode: 'standalone', // 'mcp-app' | 'standalone'
    hostCaps: {},
    selectedAgent: null,
    selectedTask: null,
    data: { members: [], tasks: [], worktrees: [], merge_queue: [], mcp_hub: null, skills_hub: null, self_improve: { health_score: 100 }, workspaces: [] },
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
    // Standalone HTTP fallback when previewed at /cockpit
    if (name === 'collab_cockpit_state' || name === 'collab_roster') {
      const [ov, mcp, sk, ws] = await Promise.all([
        fetch('/api/overview').then((r) => r.json()),
        fetch('/api/mcp-hub').then((r) => r.json()).catch(() => null),
        fetch('/api/skills-hub').then((r) => r.json()).catch(() => null),
        fetch('/api/workspaces').then((r) => r.json()).catch(() => null),
      ]);
      return { ...ov, mcp_hub: mcp, skills_hub: sk, workspaces: ws?.projects || [] };
    }
    if (name === 'collab_self_heal') {
      return fetch('/api/system/self-heal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify(args) }).then((r) => r.json());
    }
    if (name === 'collab_mcp_find_tools') {
      return fetch('/api/mcp-hub/tools?q=' + encodeURIComponent(args.query || '')).then((r) => r.json());
    }
    if (name === 'collab_mcp_hub' && args.action === 'probe') {
      return fetch('/api/mcp-hub/probe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: JSON.stringify({ id: args.id }) }).then((r) => r.json());
    }
    if (name === 'collab_merge_queue' && args.action === 'validate') {
      return fetch('/api/merge-queue/validate', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' }, body: '{}' }).then((r) => r.json());
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
    const valid = ['radar', 'tasks', 'mcp', 'skills', 'queue'].includes(id) ? id : 'radar';
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

    $('#kpiRow').innerHTML = [
      { l: tr('kAgents'), v: online + ' / ' + members.length, c: 'var(--emerald)' },
      { l: tr('kTasks'), v: running + ' / ' + tasks.length, c: running ? 'var(--cyan)' : 'var(--fg)' },
      { l: tr('kMcp'), v: String(mcpCount), c: 'var(--accent)' },
      { l: tr('kQueue'), v: String(mq.length), c: mq.some((q) => q.status === 'conflict') ? 'var(--rose)' : 'var(--fg)' },
    ].map((k) => '<div class="kpi"><span class="kpi-l">' + esc(k.l) + '</span><span class="kpi-v" style="color:' + k.c + '">' + esc(k.v) + '</span></div>').join('');

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
        opts.unshift('<option value="' + esc(appState.projectDir) + '">' + esc(appState.projectDir.split(/[\\/]/).filter(Boolean).pop() || appState.projectDir) + '</option>');
      }
      qdProj.innerHTML = opts.length ? opts.join('') : '<option value="">No workspace project detected</option>';
      if (curProj && qdProj.querySelector('option[value="' + curProj.replace(/"/g, '\\"') + '"]')) {
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
  $('#btnHeal').addEventListener('click', async () => {
    try {
      const res = await callServer('collab_self_heal', { apply: false });
      showToast('Self-Heal Preview: ' + (res.before_score ?? '?') + ' → ' + (res.after_score ?? '?') + ' (' + ((res.actions || []).length) + ' healable)');
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

  $('#btnTdClose').addEventListener('click', () => { $('#taskDetailCard').hidden = true; });
  $('#btnTdPoll').addEventListener('click', async () => {
    if (!appState.selectedTask) return;
    try {
      const res = await callServer('collab_poll', { task_id: appState.selectedTask, wait_sec: 0 });
      $('#tdBody').textContent = res.result_text || res.error_message || JSON.stringify(res, null, 2);
      await refreshState();
    } catch (err) { showToast(err.message); }
  });
  let cancelArmedId = null;
  let cancelArmTimer = null;
  $('#btnTdCancel').addEventListener('click', async () => {
    if (!appState.selectedTask) return;
    if (cancelArmedId !== appState.selectedTask) {
      cancelArmedId = appState.selectedTask;
      clearTimeout(cancelArmTimer);
      $('#btnTdCancel').textContent = 'Confirm Cancel?';
      cancelArmTimer = setTimeout(() => { cancelArmedId = null; $('#btnTdCancel').textContent = 'Cancel'; }, 4000);
      showToast('Click "Confirm Cancel?" within 4s to abort this task');
      return;
    }
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
  async function boot() {
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
        $('#hostBadge').textContent = 'MCP App · ' + (initRes?.hostInfo?.name || 'Native Host');
        sendRpcNotification('ui/notifications/initialized', {});
        // Debounced + thresholded ResizeObserver prevents inline iframe resize jitter loops
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
        // Pull fresh state if initial tool result wasn't pushed yet
        setTimeout(() => { if (!appState.data.members.length) refreshState(); }, 350);
        return;
      } catch {
        // Fall through to standalone mode if not hosted by an MCP Apps host
      }
    }
    appState.mode = 'standalone';
    $('#hostBadge').textContent = 'Standalone Cockpit Preview';
    refreshState();
  }

  boot();
})();
</script>
</body>
</html>`;
}
