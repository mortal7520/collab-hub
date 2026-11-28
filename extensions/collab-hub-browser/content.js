// CollabHub v3.0 — Shadow DOM Chat-Box Companion (Claude, ChatGPT, Gemini, Muse, DeepSeek, Grok, Perplexity)
// Reads ONLY local CollabHub loopback telemetry via background.js. Reads composer draft ONLY on explicit button click.
'use strict';

(() => {
  if (document.getElementById('collabhub-shadow-host')) return;

  const esc = (v) => String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
  const fmtTok = (n) => {
    const x = Number(n) || 0;
    if (x >= 1e6) return `${(x / 1e6).toFixed(2)}M`;
    if (x >= 1e3) return `${(x / 1e3).toFixed(1)}k`;
    return String(x);
  };

  const host = document.createElement('div');
  host.id = 'collabhub-shadow-host';
  host.style.cssText = 'position:fixed;right:18px;bottom:22px;z-index:2147483640;font-family:system-ui,-apple-system,sans-serif;';
  const shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #e2e8f0; }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      .pill-btn {
        display: inline-flex; align-items: center; gap: 7px;
        padding: 7px 12px; border-radius: 999px;
        border: 1px solid rgba(129, 140, 248, 0.45);
        background: rgba(15, 23, 42, 0.92); color: #f8fafc;
        font-size: 12px; font-weight: 600; cursor: pointer;
        box-shadow: 0 10px 28px -10px rgba(0, 0, 0, 0.75);
        backdrop-filter: blur(12px);
      }
      .dot { width: 8px; height: 8px; border-radius: 50%; background: #64748b; }
      .dot.ok { background: #34d399; box-shadow: 0 0 8px #34d399; }
      .drawer {
        width: 340px; max-height: 76vh; overflow-y: auto;
        border-radius: 13px; border: 1px solid rgba(129, 140, 248, 0.36);
        background: rgba(11, 16, 32, 0.96); color: #e2e8f0;
        padding: 12px; margin-bottom: 8px;
        box-shadow: 0 18px 42px -12px rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(16px); font-size: 12px;
      }
      .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 10px; }
      .kpis { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; margin-bottom: 10px; }
      .kpi { border: 1px solid rgba(148, 163, 184, 0.2); border-radius: 8px; padding: 6px; background: rgba(15, 23, 42, 0.8); }
      .lbl { font-size: 9.5px; text-transform: uppercase; color: #94a3b8; display: block; }
      .val { font-size: 13px; font-weight: 700; font-family: ui-monospace, monospace; }
      .agents { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; max-height: 150px; overflow-y: auto; }
      .ag { display: flex; justify-content: space-between; align-items: center; padding: 5px 8px; border-radius: 7px; background: rgba(30, 41, 59, 0.55); border: 1px solid rgba(148, 163, 184, 0.14); }
      .row { display: flex; gap: 6px; margin-bottom: 6px; }
      input, select {
        min-width: 0; padding: 5px 8px; border-radius: 7px;
        border: 1px solid rgba(148, 163, 184, 0.28); background: #0f172a; color: #f8fafc; font-size: 11.5px;
      }
      input { flex: 1; }
      button.act {
        border: 1px solid rgba(148, 163, 184, 0.28); background: #1e293b; color: #f8fafc;
        border-radius: 7px; padding: 5px 9px; font-size: 11px; font-weight: 600; cursor: pointer; white-space: nowrap;
      }
      button.act.pri { background: #6366f1; border-color: #6366f1; }
      .route-card { border: 1px solid rgba(99, 102, 241, 0.45); border-radius: 8px; padding: 7px 9px; background: rgba(99, 102, 241, 0.12); margin-bottom: 8px; }
      .muted { color: #94a3b8; font-size: 11px; }
    </style>
    <div id="drawer" class="drawer" hidden>
      <div class="head">
        <strong>⚡ CollabHub Chat-Box HUD</strong>
        <div style="display:flex;gap:5px">
          <button type="button" class="act" id="btnOpen">Workbench ↗</button>
          <button type="button" class="act" id="btnClose" aria-label="Collapse">×</button>
        </div>
      </div>
      <div class="kpis">
        <div class="kpi"><span class="lbl">Today Tok</span><span class="val" id="kTok">0</span></div>
        <div class="kpi"><span class="lbl">Cost</span><span class="val" id="kCost">$0.00</span></div>
        <div class="kpi"><span class="lbl">Health</span><span class="val" id="kHealth">—</span></div>
      </div>
      <div class="agents" id="agentsBox"></div>
      <div class="row">
        <input id="promptIn" placeholder="Task prompt or click Route Draft…" />
        <select id="stratSel">
          <option value="balanced">balanced</option>
          <option value="quality">quality</option>
          <option value="cost">cost</option>
          <option value="speed">speed</option>
        </select>
      </div>
      <div class="row">
        <button type="button" class="act pri" id="btnRoute">Route Prompt</button>
        <button type="button" class="act" id="btnRouteDraft">Route Draft</button>
        <button type="button" class="act" id="btnInsert">Insert into Chat</button>
      </div>
      <div id="routeOut" class="route-card" hidden></div>
      <div id="note" class="muted">Loopback-only metadata · Zero cookies accessed</div>
    </div>
    <button type="button" class="pill-btn" id="togglePill">
      <span class="dot" id="dot"></span>
      <span id="pillText">CollabHub HUD</span>
    </button>
  `;

  (document.body || document.documentElement).appendChild(host);

  const $ = (sel) => shadow.querySelector(sel);
  let latestOverview = null;
  let latestRoute = null;

  function findChatComposer() {
    const candidates = Array.from(document.querySelectorAll('textarea, [contenteditable="true"][role="textbox"], div[contenteditable="true"].ProseMirror, div[contenteditable="true"]'));
    return candidates.find((el) => {
      if (host.contains(el)) return false;
      const r = el.getBoundingClientRect();
      return r.width > 120 && r.height > 20;
    }) || null;
  }

  function readComposerText() {
    const el = findChatComposer();
    if (!el) return '';
    return ('value' in el && typeof el.value === 'string' ? el.value : el.textContent || '').trim();
  }

  function insertIntoComposer(text) {
    const el = findChatComposer();
    if (!el) return false;
    el.focus();
    if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
      const cur = el.value || '';
      const next = cur ? `${cur}\n\n${text}` : text;
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(el, next);
      else el.value = next;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('insertText', false, (el.textContent ? '\n\n' : '') + text);
    el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return true;
  }

  function renderSnapshot(ov) {
    latestOverview = ov;
    const dot = $('#dot');
    const pill = $('#pillText');
    if (!ov) {
      dot.className = 'dot';
      pill.textContent = 'CollabHub offline';
      return;
    }
    const tot = ov.live_usage?.totals || {};
    const health = ov.self_improve?.health_score ?? 100;
    const agents = ov.live_usage?.agents || [];
    dot.className = 'dot ok';
    pill.textContent = `CollabHub ♥${health} · ${agents.length} agents · ${fmtTok(tot.today_tokens || 0)}`;
    $('#kTok').textContent = fmtTok(tot.today_tokens || 0);
    $('#kCost').textContent = `$${Number(tot.est_cost_usd_today || 0).toFixed(2)}`;
    $('#kHealth').textContent = `${health}/100`;
    $('#agentsBox').innerHTML = agents.slice(0, 6).map((a) => `
      <div class="ag">
        <span><strong>${esc(a.name)}</strong> <span class="muted">${esc(a.status)}</span></span>
        <span class="muted">${esc(fmtTok(a.today_tokens || 0))} · $${esc(Number(a.est_cost_usd_7d || 0).toFixed(2))}</span>
      </div>
    `).join('') || '<div class="muted">No live agent telemetry yet.</div>';
  }

  function poll() {
    chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.ok) renderSnapshot(null);
      else renderSnapshot(resp.data);
    });
  }

  function runRoute(promptText) {
    const prompt = String(promptText || '').trim();
    const strategy = $('#stratSel').value || 'balanced';
    chrome.runtime.sendMessage({ type: 'ROUTE_PROMPT', prompt, strategy }, (resp) => {
      const box = $('#routeOut');
      if (chrome.runtime.lastError || !resp?.ok || !resp.data?.recommended) {
        box.hidden = false;
        box.innerHTML = `<span class="muted">${esc(resp?.error || 'Daemon offline (`collab-hub start`)')}</span>`;
        return;
      }
      latestRoute = resp.data;
      const r = resp.data.recommended;
      box.hidden = false;
      box.innerHTML = `<strong>Best: ${esc(r.name)} (${esc(r.model_tier)}) · ${esc(r.score)}</strong><div class="muted">${esc(resp.data.task_classification?.category || '')} · ${(r.routing_reasons || []).map(esc).join(' · ')}</div>`;
    });
  }

  $('#togglePill').addEventListener('click', () => { $('#drawer').hidden = !$('#drawer').hidden; });
  $('#btnClose').addEventListener('click', () => { $('#drawer').hidden = true; });
  $('#btnOpen').addEventListener('click', () => { window.open('http://127.0.0.1:5290/', '_blank', 'noopener'); });
  $('#btnRoute').addEventListener('click', () => runRoute($('#promptIn').value));
  $('#btnRouteDraft').addEventListener('click', () => {
    const draft = readComposerText();
    if (draft) $('#promptIn').value = draft;
    runRoute(draft || $('#promptIn').value);
  });
  $('#btnInsert').addEventListener('click', () => {
    const rec = latestRoute?.recommended;
    const tot = latestOverview?.live_usage?.totals || {};
    const snippet = rec
      ? `[CollabHub Route] Best=${rec.name} (${rec.model_tier}, score=${rec.score}) :: ${(rec.routing_reasons || []).join('; ')}`
      : `[CollabHub HUD] Today=${fmtTok(tot.today_tokens || 0)} tok ($${Number(tot.est_cost_usd_today || 0).toFixed(2)}), Health=${latestOverview?.self_improve?.health_score ?? 100}/100`;
    $('#note').textContent = insertIntoComposer(snippet)
      ? 'Inserted live context into chat composer!'
      : 'No active chat input found on this page.';
  });

  poll();
  setInterval(() => { if (!document.hidden) poll(); }, 8000);
})();
