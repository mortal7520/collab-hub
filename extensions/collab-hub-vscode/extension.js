'use strict';

const vscode = require('vscode');
const http = require('node:http');
const crypto = require('node:crypto');

function getLoopbackPort() {
  const cfg = vscode.workspace.getConfiguration('collabHub');
  const raw = Number(cfg.get('port', 5290));
  return Number.isInteger(raw) && raw >= 1024 && raw <= 65535 ? raw : 5290;
}

function getPollMs() {
  const cfg = vscode.workspace.getConfiguration('collabHub');
  const raw = Number(cfg.get('pollIntervalSec', 6));
  return Math.max(3, Math.min(60, Number.isFinite(raw) ? raw : 6)) * 1000;
}

function requestLocalJson(method, pathName, bodyObj = null) {
  const port = getLoopbackPort();
  const MAX_RESP_BYTES = 512 * 1024;
  return new Promise((resolve, reject) => {
    const payload = bodyObj ? JSON.stringify(bodyObj) : null;
    const headers = payload
      ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload, 'utf8'),
          'X-CollabHub-CSRF': '1',
        }
      : {};
    let settled = false;
    let totalBytes = 0;
    const finish = (err, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (err) reject(err);
      else resolve(val);
    };
    const req = http.request(
      { hostname: '127.0.0.1', port, path: pathName, method, headers, timeout: 1500 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => {
          totalBytes += c.length;
          if (totalBytes > MAX_RESP_BYTES) {
            req.destroy(new Error('Response exceeded 512KB limit'));
            return;
          }
          chunks.push(c);
        });
        res.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            finish(null, { status: res.statusCode, data });
          } catch (err) {
            finish(err);
          }
        });
      },
    );
    const deadline = setTimeout(() => {
      req.destroy(new Error('request deadline exceeded'));
    }, 2500);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (err) => finish(err));
    if (payload) req.write(payload);
    req.end();
  });
}

function escHtml(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtTok(n) {
  const num = Number(n) || 0;
  if (num >= 1000000) return `${(num / 1000000).toFixed(2)}M`;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k`;
  return String(num);
}

function renderShellHtml() {
  const nonce = crypto.randomBytes(16).toString('hex');
  return `<!doctype html>
<html><head>
<meta charset="utf-8" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 10px 14px; font-family: var(--vscode-font-family); color: var(--vscode-foreground); font-size: 12px; }
  .card { margin-top: 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 12px; background: var(--vscode-sideBar-background); }
  code { background: var(--vscode-textCodeBlock-background); padding: 2px 5px; border-radius: 4px; }
  .sticky-hud {
    position: sticky; top: 0; z-index: 20;
    padding: 8px 0 8px;
    background: var(--vscode-sideBar-background, var(--vscode-editor-background));
    border-bottom: 1px solid var(--vscode-panel-border);
    backdrop-filter: blur(8px);
  }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
  .title { font-weight: 700; font-size: 12px; }
  .pill { font-size: 10px; padding: 2px 6px; border-radius: 999px; border: 1px solid var(--vscode-panel-border); }
  .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-top: 7px; }
  .kpi { padding: 5px 6px; border-radius: 6px; border: 1px solid var(--vscode-panel-border); background: var(--vscode-editor-background); }
  .kpi-l { font-size: 9.5px; opacity: 0.72; display: block; }
  .kpi-v { font-size: 12.5px; font-weight: 700; }
  .section { margin-top: 10px; }
  .sec-title { font-size: 10.5px; text-transform: uppercase; letter-spacing: 0.06em; opacity: 0.75; margin-bottom: 6px; font-weight: 700; }
  .agent-card { padding: 7px 8px; border-radius: 7px; border: 1px solid var(--vscode-panel-border); margin-bottom: 6px; background: var(--vscode-editor-background); }
  .bar { height: 4px; border-radius: 99px; background: var(--vscode-panel-border); margin: 5px 0 4px; overflow: hidden; }
  .bar-fill { height: 100%; background: linear-gradient(90deg, #6366f1, #38bdf8); }
  .dot { display: inline-block; width: 7px; height: 7px; border-radius: 50%; margin-right: 5px; background: #64748b; }
  .dot.active { background: #34d399; }
  .dot.recent { background: #38bdf8; }
  .mono { font-family: var(--vscode-editor-font-family, monospace); font-size: 10.5px; }
  .sub { opacity: 0.75; margin-top: 2px; }
  .input-row { display: flex; gap: 5px; }
  input { flex: 1; min-width: 0; padding: 5px 7px; border-radius: 5px; border: 1px solid var(--vscode-input-border, var(--vscode-panel-border)); background: var(--vscode-input-background); color: var(--vscode-input-foreground); font-size: 11px; }
  button { background: var(--vscode-button-background); color: var(--vscode-button-foreground); border: 0; border-radius: 5px; padding: 4px 8px; cursor: pointer; font-size: 11px; }
  button.sec { background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); }
  .route-out { margin-top: 6px; padding: 7px 8px; border-radius: 6px; border: 1px solid #6366f1; }
</style>
</head>
<body>
  <div id="offlineBox" class="card" hidden>
    <strong>CollabHub Daemon Offline</strong>
    <p>Start your local always-on Mission Control:</p>
    <p><code>collab-hub start</code> or <code>collab-hub cockpit --dock</code></p>
    <button id="btnRetry" type="button">Retry Connection</button>
  </div>

  <div id="liveContent">
    <div class="sticky-hud">
      <div class="row">
        <span class="title">⚡ CollabHub Live HUD</span>
        <span class="pill" id="hudHealthPill">Connecting…</span>
      </div>
      <div class="kpis">
        <div class="kpi"><span class="kpi-l">Today Tok</span><span class="kpi-v mono" id="kpiTodayTok">0</span></div>
        <div class="kpi"><span class="kpi-l">Cost Today</span><span class="kpi-v mono" id="kpiCostToday">$0.00</span></div>
        <div class="kpi"><span class="kpi-l">MCP Calls</span><span class="kpi-v mono" id="kpiMcpCalls">0</span></div>
      </div>
      <div class="row" style="margin-top:6px">
        <button id="btnPanel" type="button" class="sec">Pin Split</button>
        <button id="btnCopyCtx" type="button" class="sec" title="Copy compact fleet context for chat">Copy Ctx</button>
        <button id="btnWeb" type="button" class="sec">Web</button>
        <button id="btnSync" type="button" aria-label="Refresh telemetry" title="Refresh telemetry">↻</button>
      </div>
    </div>

    <div class="section">
      <div class="sec-title">Connected Agents &amp; Usage</div>
      <div id="agentList"><div class="sub">No agent telemetry yet.</div></div>
    </div>

    <div class="section">
      <div class="sec-title">Model-Strength Smart Router</div>
      <div class="input-row">
        <input id="routePrompt" aria-label="Task prompt for smart router" placeholder="Task e.g. Audit SSRF / Write README" />
        <button id="btnRoute" type="button">Route</button>
      </div>
      <div id="routeOutWrap"></div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const esc = (v) => String(v ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
    const fmtTok = (n) => { const x = Number(n) || 0; return x >= 1e6 ? (x / 1e6).toFixed(2) + 'M' : (x >= 1e3 ? (x / 1e3).toFixed(1) + 'k' : String(x)); };
    document.getElementById('btnRetry').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('btnSync').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
    document.getElementById('btnPanel').addEventListener('click', () => vscode.postMessage({ type: 'openCockpit' }));
    document.getElementById('btnCopyCtx').addEventListener('click', () => vscode.postMessage({ type: 'copyContext' }));
    document.getElementById('btnWeb').addEventListener('click', () => vscode.postMessage({ type: 'openWorkbench' }));
    document.getElementById('btnRoute').addEventListener('click', () => {
      vscode.postMessage({ type: 'routeCheck', prompt: document.getElementById('routePrompt').value || '' });
    });
    window.addEventListener('message', (ev) => {
      const msg = ev.data;
      if (!msg || msg.type !== 'snapshot') return;
      const snap = msg.snapshot || {};
      const ov = snap.overview;
      const online = Boolean(snap.online && ov);
      document.getElementById('offlineBox').hidden = online;
      document.getElementById('liveContent').hidden = !online;
      if (!online) return;
      const usage = ov.live_usage || {};
      const tot = usage.totals || {};
      const agents = usage.agents || [];
      const members = ov.members || [];
      const health = ov.self_improve?.health_score ?? 100;
      const readyCount = members.filter((m) => ['online', 'idle'].includes(m.state)).length;
      document.getElementById('hudHealthPill').textContent = '♥' + health + ' · ' + readyCount + '/' + members.length;
      document.getElementById('kpiTodayTok').textContent = fmtTok(tot.today_tokens);
      document.getElementById('kpiCostToday').textContent = '$' + Number(tot.est_cost_usd_today || 0).toFixed(2);
      document.getElementById('kpiMcpCalls').textContent = String(tot.mcp_calls_total || 0);
      const maxTok = Math.max(1, ...agents.map((a) => a.total_7d_tokens || a.today_tokens || 1));
      document.getElementById('agentList').innerHTML = agents.slice(0, 8).map((a) => {
        const pct = Math.max(4, Math.round(((a.total_7d_tokens || a.today_tokens || 0) / maxTok) * 100));
        return '<div class="agent-card">' +
          '<div class="row"><span><span class="dot ' + esc(a.status) + '"></span><strong>' + esc(a.name) + '</strong></span>' +
          '<span class="mono">' + esc(fmtTok(a.today_tokens)) + ' · $' + esc(Number(a.est_cost_usd_7d || 0).toFixed(2)) + '</span></div>' +
          '<div class="bar"><div class="bar-fill" style="width:' + pct + '%"></div></div>' +
          '<div class="sub mono">' + esc(a.last_model || a.transport || 'local') + ' · ' + esc(a.mcp_calls || 0) + ' calls · ' + esc(a.last_tool || '—') + '</div></div>';
      }).join('') || '<div class="sub">No agent telemetry yet.</div>';
      const r = snap.route?.recommended;
      document.getElementById('routeOutWrap').innerHTML = r
        ? '<div class="route-out"><strong>Best Match: ' + esc(r.name) + '</strong><div class="sub mono">' +
          esc(snap.route?.task_classification?.category || '') + ' (' + esc(snap.route?.task_classification?.complexity || '') + ') · score ' + esc(r.score) +
          '</div><div class="sub">' + (r.routing_reasons || []).map(esc).join(' · ') + '</div></div>'
        : '';
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body></html>`;
}

function activate(context) {
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBar.command = 'collabHub.openCockpit';
  statusBar.text = '$(pulse) CollabHub: connecting…';
  statusBar.show();
  context.subscriptions.push(statusBar);

  let sidebarView = null;
  let panelView = null;
  let cockpitPanel = null;
  let latestSnapshot = { online: false, overview: null, route: null };

  const pushSnapshot = () => {
    const payload = { type: 'snapshot', snapshot: latestSnapshot };
    if (sidebarView) sidebarView.webview.postMessage(payload);
    if (panelView) panelView.webview.postMessage(payload);
    if (cockpitPanel) cockpitPanel.webview.postMessage(payload);
  };

  const formatContextSnippet = () => {
    const ov = latestSnapshot.overview;
    const tot = ov?.live_usage?.totals || {};
    const rec = latestSnapshot.route?.recommended;
    const base = `[CollabHub Live HUD] Health=${ov?.self_improve?.health_score ?? 100}/100 | Agents=${tot.connected_agents || 0} | Today=${fmtTok(tot.today_tokens)} ($${Number(tot.est_cost_usd_today || 0).toFixed(2)})`;
    return rec ? `${base} | Recommended=${rec.name} (${rec.model_tier}, score=${rec.score})` : base;
  };

  const handleMessage = async (msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready') pushSnapshot();
    else if (msg.type === 'refresh') await refreshTelemetry();
    else if (msg.type === 'openCockpit') vscode.commands.executeCommand('collabHub.pinBesideChat');
    else if (msg.type === 'openWorkbench') vscode.commands.executeCommand('collabHub.openWorkbench');
    else if (msg.type === 'copyContext') {
      await vscode.env.clipboard.writeText(formatContextSnippet());
      vscode.window.showInformationMessage('Copied CollabHub context pill to clipboard.');
    } else if (msg.type === 'routeCheck') {
      try {
        const res = await requestLocalJson('POST', '/api/route/recommend', {
          prompt: String(msg.prompt || ''),
          role: 'researcher',
          strategy: 'balanced',
        });
        latestSnapshot.route = res.data;
        pushSnapshot();
      } catch { /* ignore */ }
    }
  };

  const refreshTelemetry = async () => {
    try {
      const res = await requestLocalJson('GET', '/api/overview');
      const ov = res.data;
      latestSnapshot.online = res.status === 200;
      latestSnapshot.overview = ov;
      const tot = ov.live_usage?.totals || {};
      const health = ov.self_improve?.health_score ?? 100;
      const active = ov.metrics?.tasks_active ?? 0;
      statusBar.text = `$(pulse) CollabHub ♥${health} · ${tot.connected_agents || 0} agents · ${fmtTok(tot.today_tokens)} ($${Number(tot.est_cost_usd_today || 0).toFixed(2)}) · ${active}⚡`;
      const md = new vscode.MarkdownString(
        `**CollabHub v${ov.version || '3.0.0'}** — Click to pin beside chat\n\n` +
        (ov.live_usage?.agents || []).slice(0, 6).map((a) => `- **${a.name}** (\`${a.status}\`): ${fmtTok(a.today_tokens)} today · ${a.mcp_calls || 0} MCP calls`).join('\n'),
      );
      statusBar.tooltip = md;
      pushSnapshot();
    } catch {
      latestSnapshot.online = false;
      statusBar.text = '$(circle-slash) CollabHub offline (click for setup)';
      statusBar.tooltip = 'Start local CollabHub: collab-hub start';
      pushSnapshot();
    }
  };

  const makeViewProvider = (assign) => ({
    resolveWebviewView(webviewView) {
      assign(webviewView);
      webviewView.webview.options = { enableScripts: true };
      webviewView.webview.onDidReceiveMessage(handleMessage);
      webviewView.webview.html = renderShellHtml();
      refreshTelemetry();
    },
  });
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('collabHub.sidebar', makeViewProvider((v) => { sidebarView = v; }), { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider('collabHub.panel', makeViewProvider((v) => { panelView = v; }), { webviewOptions: { retainContextWhenHidden: true } }),
  );

  const openOrRevealCockpit = () => {
    if (cockpitPanel) {
      cockpitPanel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    cockpitPanel = vscode.window.createWebviewPanel(
      'collabHubCockpit',
      'CollabHub Beside-Chat HUD',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    cockpitPanel.webview.onDidReceiveMessage(handleMessage);
    cockpitPanel.onDidDispose(() => { cockpitPanel = null; });
    cockpitPanel.webview.html = renderShellHtml();
    refreshTelemetry();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('collabHub.refresh', refreshTelemetry),
    vscode.commands.registerCommand('collabHub.openWorkbench', () => {
      vscode.env.openExternal(vscode.Uri.parse(`http://127.0.0.1:${getLoopbackPort()}/`));
    }),
    vscode.commands.registerCommand('collabHub.openCockpit', openOrRevealCockpit),
    vscode.commands.registerCommand('collabHub.pinBesideChat', openOrRevealCockpit),
  );

  if (vscode.chat && typeof vscode.chat.createChatParticipant === 'function') {
    const participant = vscode.chat.createChatParticipant('collabhub.assistant', async (request, _ctx, stream) => {
      const cmd = request.command || 'usage';
      try {
        if (cmd === 'route' || (request.prompt && cmd !== 'usage' && cmd !== 'roster')) {
          const q = new URLSearchParams({ prompt: String(request.prompt || ''), role: 'researcher', strategy: 'balanced' });
          const res = await requestLocalJson('GET', `/api/route/recommend?${q.toString()}`);
          const rec = res.data?.recommended;
          stream.markdown(rec
            ? `**Recommended Agent:** \`${rec.name}\` (${rec.model_tier}, score **${rec.score}**)\n\nCategory: \`${res.data.task_classification?.category}\` · Reasons: ${(rec.routing_reasons || []).join(', ')}`
            : 'No online agent matched the request.');
        } else if (cmd === 'roster') {
          const res = await requestLocalJson('GET', '/api/overview');
          const rows = (res.data?.members || []).map((m) => `- **${m.name || m.member}**: \`${m.state}\` (${m.channel || 'native'})`).join('\n');
          stream.markdown(`### CollabHub Fleet Roster\n${rows || 'No agents registered.'}`);
        } else {
          const res = await requestLocalJson('GET', '/api/usage/live');
          const t = res.data?.totals || {};
          const top = (res.data?.agents || []).slice(0, 6).map((a) => `- **${a.name}** (\`${a.status}\`): ${fmtTok(a.today_tokens)} today · $${Number(a.est_cost_usd_7d || 0).toFixed(2)} (7d)`).join('\n');
          stream.markdown(`### CollabHub Live Usage\n- Today: **${fmtTok(t.today_tokens)}** · Cost: **$${Number(t.est_cost_usd_today || 0).toFixed(2)}** · Burn: **${fmtTok(t.tokens_per_min)}/m**\n\n${top}`);
        }
      } catch (err) {
        stream.markdown(`CollabHub daemon offline (\`127.0.0.1:${getLoopbackPort()}\`). Run \`collab-hub start\`. (${err.message})`);
      }
      return { metadata: { command: cmd } };
    });
    context.subscriptions.push(participant);
  }

  const timer = setInterval(refreshTelemetry, getPollMs());
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  refreshTelemetry();
}

function deactivate() {}

module.exports = { activate, deactivate };
