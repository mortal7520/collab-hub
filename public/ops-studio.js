/**
 * CollabHub v3.0 — Always-On Live Usage HUD, Real-Time Connected Agent Usage Panel & Rooms & Ops Studio
 * Zero runtime dependencies; bilingual EN/中文; full interactive GitHub Pages static demo parity.
 */
'use strict';

const OPS_I18N = {
  en: {
    'nav.rooms': 'Rooms & Ops',
    'nav.roomsAlt': '协作室与运维',
    'quick.rooms': 'Rooms & Ops',
    'view.rooms.sub': 'Living Shared Rooms, Consensus, Artifacts, Budgets, Triggers, Webhooks & 60s Setup',
    'bento.roomsTitle': 'Rooms, Webhooks & Setup',
    'bento.roomsSub': '{rooms} rooms · {hooks} webhooks · {clients} AI clients supported',
    'bento.roomsBadge': 'Always-On v3.0',
    'dock.live': 'LIVE',
    'dock.connected': 'Connected AI Agents',
    'dock.todayTok': 'Today',
    'dock.rate': 'Burn Rate',
    'dock.cost': 'Est. Cost',
    'dock.calls': 'MCP Calls',
    'dock.popout': 'Pop-out Resident HUD',
    'dock.setupBtn': 'Setup & Always-On',
    'usage.title': 'Real-Time Cross-Agent Usage & Cost Ledger',
    'usage.sub': 'Metadata-only telemetry across ALL connected MCP clients & local CLI streams (Claude Code, Codex, Antigravity, Cursor, Windsurf, Cline, OpenCode, Zed…). Zero prompts ever read or stored.',
    'usage.clients': 'clients active/seen',
    'usage.colAgent': 'Agent / Client',
    'usage.colStatus': 'Status',
    'usage.colTransport': 'Transport / Profile',
    'usage.colModel': 'Model',
    'usage.colToday': 'Today',
    'usage.col7d': '7d Tokens',
    'usage.colRate': 'Rate',
    'usage.colCost': 'Est. Cost (7d)',
    'usage.colTool': 'Last Tool',
    'ops.title': 'Rooms, Governance, Webhooks & Guided Setup',
    'ops.sub': 'Shared multi-agent file leases, voting consensus, Artifact Vault, budget guardrails, SSRF-safe webhooks, and 1-command onboarding for 14 AI coding clients.',
    'ops.tabRooms': 'Shared Rooms & Leases',
    'ops.tabConsensus': 'Consensus',
    'ops.tabArtifacts': 'Artifacts & Handoff',
    'ops.tabBudgets': 'Budgets & Triggers',
    'ops.tabWebhooks': 'Outbound Webhooks',
    'ops.tabSetup': 'Setup, Always-On & Profiles',
    'ops.tabRouter': 'Smart Router & Host Plugins',
  },
  zh: {
    'nav.rooms': '协作室与运维',
    'nav.roomsAlt': 'Rooms & Ops',
    'quick.rooms': '协作室与运维',
    'view.rooms.sub': '共享协作室租约、多端共识、产物库、预算护栏、Webhook 通知与 60 秒向导',
    'bento.roomsTitle': '协作室 · Webhook · 接入向导',
    'bento.roomsSub': '{rooms} 协作室 · {hooks} Webhooks · 原生支持 {clients} 款主流客户端',
    'bento.roomsBadge': '常驻 v3.0',
    'dock.live': '实时常驻',
    'dock.connected': '已接入 Agent',
    'dock.todayTok': '今日用量',
    'dock.rate': '燃烧速率',
    'dock.cost': '估算成本',
    'dock.calls': 'MCP 调用',
    'dock.popout': '弹出悬浮小窗',
    'dock.setupBtn': '接入与常驻配置',
    'usage.title': '跨 Agent 实时用量、速率与成本统计',
    'usage.sub': '实时汇总所有接入的 MCP 客户端（Claude Code / Codex / Antigravity / Cursor / Windsurf / Cline / OpenCode / Zed 等）与本地会话元数据的 Token 与估算费用——严格只读数值，绝不采集提示词。',
    'usage.clients': '个活跃/已接入客户端',
    'usage.colAgent': 'Agent / 客户端',
    'usage.colStatus': '状态',
    'usage.colTransport': '通道 / Profile',
    'usage.colModel': '模型',
    'usage.colToday': '今日 Tokens',
    'usage.col7d': '7 日总计',
    'usage.colRate': '速率',
    'usage.colCost': '7 日估算费用',
    'usage.colTool': '最近调用',
    'ops.title': '协作室 · 共识治理 · Webhook · 一键接入',
    'ops.sub': '共享租约防冲突编辑、多 Agent 仲裁共识、脱敏产物库与交接包、预算与定时触发器、SSRF 防护 Webhook，以及 14 款主流客户端 60 秒一键安装。',
    'ops.tabRooms': '共享协作室与租约',
    'ops.tabConsensus': '多端共识决策',
    'ops.tabArtifacts': '产物库与交接包',
    'ops.tabBudgets': '预算与安全触发器',
    'ops.tabWebhooks': '外部通知 Webhook',
    'ops.tabSetup': '一键接入 · 常驻模式 · Profile',
    'ops.tabRouter': '智能能力路由与宿主原生插件',
  },
};

export function registerOpsStudioI18n(I18N) {
  Object.assign(I18N.en, OPS_I18N.en);
  Object.assign(I18N.zh, OPS_I18N.zh);
}

function fmtTok(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 1_000) return `${(num / 1_000).toFixed(1)}k`;
  return String(num);
}

function fmtUsd(n) {
  const num = Number(n) || 0;
  if (num <= 0) return '$0.00';
  if (num < 0.01) return `$${num.toFixed(4)}`;
  return `$${num.toFixed(2)}`;
}

const AGENT_COLORS = ['#6366f1', '#34d399', '#38bdf8', '#fbbf24', '#a78bfa', '#fb7185', '#22d3ee', '#818cf8'];

function buildStaticOpsDemo() {
  const now = new Date().toISOString();
  return {
    rooms: [
      {
        room_id: 'room-v3-launch',
        name: 'v3-launch',
        goal: 'Ship Streamable HTTP /mcp, live usage telemetry & 14-client setup',
        active_claims: 2,
        log_entries: 9,
        claims: [
          { claim_id: 'clm_demo_1', path_glob: 'src/routes-v3.mjs', owner_agent: 'codex', status: 'active' },
          { claim_id: 'clm_demo_2', path_glob: 'public/ops-studio.js', owner_agent: 'antigravity', status: 'active' },
        ],
      },
    ],
    consensus: [
      {
        round_id: 'con_demo_1',
        topic: 'Default MCP profile for external onboarding (`cockpit` 23 tools vs `full` 53)',
        status: 'synthesized',
        verdict: { decision: 'approve', confidence: 0.94 },
        votes: [
          { member: 'claude', stance: 'approve', rationale: '23 tools keep prompt context lean while exposing Cockpit + Rooms.' },
          { member: 'codex', stance: 'approve', rationale: 'Opt-in `--profile full` remains one flag away for power users.' },
        ],
      },
    ],
    artifacts: [
      { artifact_id: 'art_demo_1', name: 'security-audit-report.md', author: 'codex', mime_type: 'text/markdown', bytes: 3840, created_at: now },
      { artifact_id: 'art_demo_2', name: 'handoff-pack-v3.json', author: 'antigravity', mime_type: 'application/json', bytes: 6120, created_at: now },
    ],
    budgets: {
      policies: [
        { policy_id: 'bud_demo_1', scope_type: 'global', scope_id: '*', daily_token_limit: 2000000, daily_call_limit: 400, soft_warn_pct: 80, on_exceed: 'warn', enabled: true },
      ],
      evaluation: { action: 'allow', usage: { global_calls_24h: 186, global_tokens_24h: 412800 } },
    },
    triggers: [
      { trigger_id: 'trg_demo_1', name: 'Stale Lease Sweep', kind: 'interval', action: 'reconcile_stale_claims', interval_sec: 900, enabled: true, last_summary: '0 expired leases' },
      { trigger_id: 'trg_demo_2', name: 'Daily Hot Backup', kind: 'interval', action: 'hot_backup', interval_sec: 43200, enabled: true, last_summary: 'VACUUM INTO ok (0ms lock)' },
    ],
    webhooks: [
      { webhook_id: 'whk_demo_1', name: 'Engineering Slack', format: 'slack', url: 'https://hooks.slack.com/services/T000/B000/DEMO', secret_env: 'SLACK_WEBHOOK_SECRET', events: ['task.failed', 'merge_queue.merged'], enabled: true, delivery_count: 14, last_status: 200 },
      { webhook_id: 'whk_demo_2', name: 'Feishu Alert Bot', format: 'feishu', url: 'https://open.feishu.cn/open-apis/bot/v2/hook/demo', secret_env: 'FEISHU_WEBHOOK_SECRET', events: ['consensus.*'], enabled: true, delivery_count: 6, last_status: 200 },
    ],
    setupPlan: {
      profile: 'cockpit',
      detected_clients: [
        'antigravity', 'codex', 'claude-code', 'claude-desktop', 'cursor', 'windsurf',
        'vscode', 'gemini-cli', 'cline', 'roo-code', 'opencode', 'zed', 'continue', 'kiro',
      ].map((id, i) => ({
        id,
        name: id.replace(/(^|-)([a-z])/g, (_, p, c) => (p ? ' ' : '') + c.toUpperCase()),
        exists: i < 6,
        server_count: i < 6 ? 3 : 0,
        will_sync: i < 6,
      })),
    },
    autostart: { platform: 'win32', manager: 'launchd / systemd / schtasks', installed: true, active: true },
    routeMatrix: [
      { member: 'codex', name: 'Codex', state: 'online', model_hint: 'gpt-5-codex', tier: 'flagship', cost_tier: 'high', top_strengths: [{ category: 'coding', score: 97 }, { category: 'security_audit', score: 96 }, { category: 'debugging', score: 96 }] },
      { member: 'claude', name: 'Claude', state: 'online', model_hint: 'claude-sonnet-4', tier: 'flagship', cost_tier: 'high', top_strengths: [{ category: 'architecture', score: 96 }, { category: 'frontend_ui', score: 95 }, { category: 'coding', score: 94 }] },
      { member: 'agy', name: 'Antigravity', state: 'online', model_hint: 'gemini-2.5-pro', tier: 'flagship', cost_tier: 'medium', top_strengths: [{ category: 'long_context', score: 98 }, { category: 'copywriting', score: 96 }, { category: 'frontend_ui', score: 94 }] },
      { member: 'dsh', name: 'WSL DSH', state: 'online', model_hint: 'wsl-dsh-runtime', tier: 'balanced', cost_tier: 'medium', top_strengths: [{ category: 'linux_ops', score: 99 }, { category: 'debugging', score: 92 }, { category: 'coding', score: 90 }] },
      { member: 'ollama-qwen', name: 'Ollama Qwen2.5', state: 'idle', model_hint: 'qwen2.5-coder:14b', tier: 'local', cost_tier: 'free', top_strengths: [{ category: 'fast_cheap', score: 99 }, { category: 'research', score: 78 }, { category: 'coding', score: 76 }] },
    ],
    routeResult: null,
    pluginPlan: {
      ides: [
        { id: 'antigravity', name: 'Antigravity IDE', detected: true, already_installed: true },
        { id: 'cursor', name: 'Cursor', detected: true, already_installed: true },
        { id: 'windsurf', name: 'Windsurf', detected: true, already_installed: false },
        { id: 'vscode', name: 'VS Code', detected: true, already_installed: true },
        { id: 'kiro', name: 'Kiro', detected: false, already_installed: false },
      ],
    },
  };
}

export function createOpsStudioController(ctx) {
  const { $, $$, esc, t, state, apiGet, apiPost, toast, setView } = ctx;
  let activeOpsTab = 'rooms';
  let loadedOps = false;
  let demoCache = null;

  const opsState = {
    rooms: [],
    consensus: [],
    artifacts: [],
    handoffText: '',
    budgets: { policies: [], evaluation: null },
    triggers: [],
    webhooks: [],
    setupPlan: null,
    autostart: null,
    routeMatrix: [],
    routeResult: null,
    pluginPlan: null,
  };

  function ensureShellInjected() {
    const views = $('.views');
    const ov = $('#view-overview');
    if (views && !$('#liveResidentDock')) {
      const dock = document.createElement('section');
      dock.id = 'liveResidentDock';
      dock.className = 'resident-dock';
      dock.setAttribute('aria-label', 'Always-on live usage and cockpit dock');
      views.prepend(dock);
    }
    if (ov && !$('#liveUsageOverviewPanel')) {
      const panel = document.createElement('section');
      panel.id = 'liveUsageOverviewPanel';
      panel.className = 'panel live-usage-panel';
      const selfStrip = $('#selfStrip');
      if (selfStrip) ov.insertBefore(panel, selfStrip);
      else ov.appendChild(panel);
    }
    if (views && !$('#view-rooms')) {
      const sec = document.createElement('section');
      sec.className = 'view';
      sec.id = 'view-rooms';
      sec.dataset.viewPanel = 'rooms';
      sec.setAttribute('aria-labelledby', 'viewTitle');
      sec.innerHTML = '<div id="roomsOpsRoot"></div>';
      const sys = $('#view-system');
      if (sys) views.insertBefore(sec, sys);
      else views.appendChild(sec);
    }
  }

  function popOutCockpit() {
    const base = state.static ? './cockpit.html?mode=dock' : '/cockpit?mode=dock';
    const w = window.open(base, 'collabhub_resident_dock', 'width=440,height=860,menubar=no,toolbar=no,location=no,status=no,resizable=yes');
    if (!w) {
      window.open(base, '_blank', 'noopener');
    }
  }

  function renderResidentDock(data) {
    ensureShellInjected();
    const dock = $('#liveResidentDock');
    if (!dock) return;
    const usage = (data && data.live_usage) || state.overviewRaw?.live_usage || {};
    const tot = usage.totals || {};
    const agents = usage.agents || [];
    const pills = agents.slice(0, 8).map((a) =>
      `<span class="dock-agent ${a.status === 'active' ? 'active' : ''}" title="${esc(`${a.name} · ${fmtTok(a.today_tokens)} today · ${a.mcp_calls || 0} MCP calls`)}">` +
        `<span class="dock-dot ${esc(a.status)}"></span>` +
        `<span>${esc(a.name)}</span>` +
        `<span class="mono muted">${esc(fmtTok(a.today_tokens || a.total_7d_tokens || 0))}</span>` +
      `</span>`
    ).join('');

    dock.innerHTML =
      `<div class="dock-left">` +
        `<span class="dock-live-pill"><span class="dock-pulse"></span><span>${esc(t('dock.live'))}</span></span>` +
        `<div class="dock-kpis">` +
          `<div class="dock-kpi"><span class="dock-kpi-l">${esc(t('dock.todayTok'))}</span><strong class="mono">${esc(fmtTok(tot.today_tokens))}</strong></div>` +
          `<div class="dock-kpi"><span class="dock-kpi-l">${esc(t('dock.rate'))}</span><strong class="mono cyan">${esc(fmtTok(tot.tokens_per_min || 0))}/m</strong></div>` +
          `<div class="dock-kpi"><span class="dock-kpi-l">${esc(t('dock.cost'))}</span><strong class="mono">${esc(fmtUsd(tot.est_cost_usd_today))}</strong></div>` +
          `<div class="dock-kpi"><span class="dock-kpi-l">${esc(t('dock.calls'))}</span><strong class="mono">${esc(String(tot.mcp_calls_total || 0))}</strong></div>` +
        `</div>` +
      `</div>` +
      `<div class="dock-agents" title="${esc(t('dock.connected'))}">${pills || `<span class="meta">${esc(t('dock.connected'))}: 0</span>`}</div>` +
      `<div class="dock-actions">` +
        `<button type="button" class="btn sm cyan" id="btnDockPopout">⧉ ${esc(t('dock.popout'))}</button>` +
        `<button type="button" class="btn ghost sm" id="btnDockSetup">✦ ${esc(t('dock.setupBtn'))}</button>` +
      `</div>`;
  }

  function renderLiveUsagePanel(data) {
    ensureShellInjected();
    const panel = $('#liveUsageOverviewPanel');
    if (!panel) return;
    const usage = (data && data.live_usage) || state.overviewRaw?.live_usage || { totals: {}, hourly_buckets: [], agents: [] };
    const tot = usage.totals || {};
    const agents = usage.agents || [];
    const hourly = Array.isArray(usage.hourly_buckets) ? usage.hourly_buckets : [];
    const maxTok = Math.max(1, agents.reduce((s, a) => s + (a.total_7d_tokens || 0), 0));
    const maxHour = Math.max(1, ...hourly);

    const shareSegments = agents.filter((a) => (a.total_7d_tokens || 0) > 0).slice(0, 8).map((a, i) => {
      const pct = Math.max(2, Math.round(((a.total_7d_tokens || 0) / maxTok) * 100));
      return `<div class="usage-share-seg" style="width:${pct}%;background:${AGENT_COLORS[i % AGENT_COLORS.length]}" title="${esc(`${a.name}: ${fmtTok(a.total_7d_tokens)} (${fmtUsd(a.est_cost_usd_7d)})`)}"></div>`;
    }).join('');

    const sparkBars = hourly.slice(-24).map((v, i) => {
      const hPct = Math.max(8, Math.round((v / maxHour) * 100));
      return `<span class="usage-spark-bar" style="height:${hPct}%" title="-${23 - i}h: ${fmtTok(v)} tokens"></span>`;
    }).join('');

    const rows = agents.map((a, i) => `
      <tr>
        <td>
          <span class="usage-color-dot" style="background:${AGENT_COLORS[i % AGENT_COLORS.length]}"></span>
          <strong>${esc(a.name)}</strong>
          <div class="meta mono">${esc(a.agent_id)}</div>
        </td>
        <td><span class="pill ${a.status === 'active' ? 'ok' : (a.status === 'recent' ? 'demo' : 'subtle')}">${esc(a.status)}</span></td>
        <td class="mono">${esc(a.transport || 'local')}${a.profile ? ` · ${esc(a.profile)}` : ''}</td>
        <td class="mono">${esc(a.last_model || '—')}</td>
        <td class="mono"><strong>${esc(fmtTok(a.today_tokens))}</strong></td>
        <td class="mono">${esc(fmtTok(a.total_7d_tokens))}</td>
        <td class="mono">${a.tokens_per_min ? `${esc(fmtTok(a.tokens_per_min))}/m` : '—'}</td>
        <td class="mono">${esc(fmtUsd(a.est_cost_usd_7d))}</td>
        <td class="mono">${esc(a.last_tool || '—')}</td>
      </tr>
    `).join('');

    panel.innerHTML =
      `<div class="panel-head">` +
        `<div>` +
          `<h2>${esc(t('usage.title'))}</h2>` +
          `<p>${esc(t('usage.sub'))}</p>` +
        `</div>` +
        `<div class="panel-tools">` +
          `<span class="pill ok">${esc(String(tot.connected_agents || agents.length))} ${esc(t('usage.clients'))}</span>` +
          `<span class="pill mono">${esc(fmtTok(tot.total_7d_tokens || 0))} tok · ${esc(fmtUsd(tot.est_cost_usd_7d))} (7d)</span>` +
        `</div>` +
      `</div>` +
      `<div class="usage-visual-strip">` +
        `<div class="usage-share-wrap"><div class="usage-share-bar">${shareSegments || '<div class="usage-share-empty"></div>'}</div></div>` +
        `<div class="usage-spark" aria-label="24h token throughput">${sparkBars}</div>` +
      `</div>` +
      `<div class="table-wrap">` +
        `<table class="data-table">` +
          `<thead><tr>` +
            `<th>${esc(t('usage.colAgent'))}</th><th>${esc(t('usage.colStatus'))}</th><th>${esc(t('usage.colTransport'))}</th>` +
            `<th>${esc(t('usage.colModel'))}</th><th>${esc(t('usage.colToday'))}</th><th>${esc(t('usage.col7d'))}</th>` +
            `<th>${esc(t('usage.colRate'))}</th><th>${esc(t('usage.colCost'))}</th><th>${esc(t('usage.colTool'))}</th>` +
          `</tr></thead>` +
          `<tbody>${rows || '<tr><td colspan="9" class="meta">Connect any MCP client or run `collab-hub setup` to stream live usage.</td></tr>'}</tbody>` +
        `</table>` +
      `</div>`;
  }

  function renderRoomsBentoCard(data) {
    const grid = $('#studioBento');
    if (!grid) return;
    if (state.demo && opsState.rooms.length === 0) {
      Object.assign(opsState, demoCache || buildStaticOpsDemo());
    }
    const hooksCount = (opsState.webhooks || []).length;
    const roomsCount = (opsState.rooms || []).length;
    const clientsCount = opsState.setupPlan?.detected_clients?.length || 14;
    let card = $('#bentoRoomsCard');
    if (!card) {
      card = document.createElement('article');
      card.id = 'bentoRoomsCard';
      card.className = 'bento-card';
      grid.appendChild(card);
    }
    card.innerHTML =
      `<div class="bento-top">` +
        `<h3>${esc(t('bento.roomsTitle'))}</h3>` +
        `<span class="pill ok">${esc(t('bento.roomsBadge'))}</span>` +
      `</div>` +
      `<p class="bento-sub">${esc(t('bento.roomsSub', { rooms: roomsCount, hooks: hooksCount, clients: clientsCount }))}</p>` +
      `<button type="button" class="btn ghost sm" data-goto-view="rooms">${esc(t('bento.open'))}</button>`;
    void data;
  }

  async function loadOpsData() {
    if (state.demo) {
      if (!demoCache) demoCache = buildStaticOpsDemo();
      Object.assign(opsState, demoCache);
      loadedOps = true;
      renderOpsView();
      return;
    }
    const [rm, con, art, bud, trg, whk, setup, auto, mat, plg] = await Promise.all([
      apiGet('/api/rooms').catch(() => ({ rooms: [] })),
      apiGet('/api/consensus?limit=20').catch(() => ({ rounds: [] })),
      apiGet('/api/artifacts?limit=30').catch(() => ({ artifacts: [] })),
      apiGet('/api/budget').catch(() => ({ policies: [], evaluation: null })),
      apiGet('/api/triggers').catch(() => ({ triggers: [] })),
      apiGet('/api/webhooks').catch(() => ({ webhooks: [] })),
      apiGet('/api/setup/plan?profile=cockpit').catch(() => null),
      apiGet('/api/autostart/status').catch(() => null),
      apiGet('/api/route/matrix').catch(() => ({ matrix: [] })),
      apiGet('/api/plugins/plan').catch(() => null),
    ]);
    opsState.rooms = rm.rooms || [];
    opsState.consensus = con.rounds || [];
    opsState.artifacts = art.artifacts || [];
    opsState.budgets = { policies: bud.policies || [], evaluation: bud.evaluation || null };
    opsState.triggers = trg.triggers || [];
    opsState.webhooks = whk.webhooks || [];
    opsState.setupPlan = setup;
    opsState.autostart = auto;
    opsState.routeMatrix = mat.matrix || [];
    opsState.pluginPlan = plg;
    loadedOps = true;
    renderRoomsBentoCard();
    renderOpsView();
  }

  function renderOpsView() {
    ensureShellInjected();
    const root = $('#roomsOpsRoot');
    if (!root) return;
    const tabs = [
      { id: 'rooms', label: t('ops.tabRooms'), count: opsState.rooms.length },
      { id: 'consensus', label: t('ops.tabConsensus'), count: opsState.consensus.length },
      { id: 'artifacts', label: t('ops.tabArtifacts'), count: opsState.artifacts.length },
      { id: 'budgets', label: t('ops.tabBudgets'), count: (opsState.budgets.policies?.length || 0) + opsState.triggers.length },
      { id: 'webhooks', label: t('ops.tabWebhooks'), count: opsState.webhooks.length },
      { id: 'setup', label: t('ops.tabSetup'), count: opsState.setupPlan?.detected_clients?.length || 14 },
      { id: 'router', label: t('ops.tabRouter'), count: opsState.routeMatrix.length || 5 },
    ];

    let body = '';
    if (activeOpsTab === 'rooms') {
      body = `
        <div class="field-row" style="margin-bottom:10px">
          <input class="input" id="opsRoomName" placeholder="Room name (e.g. auth-refactor)" />
          <input class="input grow" id="opsRoomGoal" placeholder="Shared goal across agents…" />
          <button type="button" class="btn primary sm" id="btnOpsCreateRoom">+ Create Room</button>
          <button type="button" class="btn ghost sm" id="btnOpsSweepLeases">Sweep Expired Leases</button>
        </div>
        <div class="list">${opsState.rooms.map((r) => `
          <div class="wt-card">
            <div class="panel-head" style="margin-bottom:6px">
              <div><strong class="mono">${esc(r.name)}</strong> <span class="pill ok">${esc(String(r.active_claims || 0))} claims</span></div>
              <span class="meta">${esc(r.goal || '')}</span>
            </div>
            <div class="field-row">
              <input class="input" data-claim-glob="${esc(r.room_id || r.name)}" placeholder="Path glob (e.g. src/auth/**)" />
              <input class="input" data-claim-agent="${esc(r.room_id || r.name)}" placeholder="Owner agent (e.g. codex)" />
              <button type="button" class="btn sm" data-claim-room="${esc(r.room_id || r.name)}">Claim Lease</button>
            </div>
          </div>
        `).join('') || '<div class="meta">No Shared Rooms yet. Create one to isolate concurrent multi-agent edits via file leases + agent inboxes.</div>'}</div>`;
    } else if (activeOpsTab === 'consensus') {
      body = `
        <div class="field-row" style="margin-bottom:10px">
          <input class="input grow" id="opsConTopic" placeholder="Decision topic (e.g. Ship v3.0 HTTP /mcp default profile?)" />
          <input class="input" id="opsConMembers" value="agy,codex,claude" />
          <button type="button" class="btn primary sm" id="btnOpsConCreate">+ Start Consensus Round</button>
        </div>
        <div class="list">${opsState.consensus.map((c) => `
          <div class="wt-card">
            <div class="panel-head" style="margin-bottom:6px">
              <strong>${esc(c.topic)}</strong>
              <div>
                <span class="pill ${c.verdict?.decision === 'approve' ? 'ok' : 'demo'}">${esc(c.verdict?.decision || c.status)}</span>
                <button type="button" class="btn ghost sm" data-con-synth="${esc(c.round_id)}">Synthesize</button>
              </div>
            </div>
            <div class="meta">${(c.votes || []).map((v) => `${esc(v.member)}:${esc(v.stance)}`).join(' · ') || 'No votes cast yet.'}</div>
          </div>
        `).join('') || '<div class="meta">No consensus rounds yet.</div>'}</div>`;
    } else if (activeOpsTab === 'artifacts') {
      body = `
        <div class="field-row" style="margin-bottom:10px">
          <input class="input grow" id="opsArtName" placeholder="Artifact filename (e.g. audit-summary.md)" />
          <input class="input grow" id="opsArtBody" placeholder="Content (auto-redacts inline secrets)…" />
          <button type="button" class="btn primary sm" id="btnOpsArtPut">Save Artifact</button>
          <button type="button" class="btn cyan sm" id="btnOpsHandoff">Build Handoff Pack</button>
        </div>
        ${opsState.handoffText ? `<pre class="code-box" style="margin-bottom:10px">${esc(opsState.handoffText)}</pre>` : ''}
        <div class="list">${opsState.artifacts.map((a) => `
          <div class="wt-card"><strong class="mono">${esc(a.name)}</strong> <span class="pill">${esc(a.author || 'hub')}</span> <span class="meta">${esc(String(a.bytes || a.content?.length || 0))} B</span></div>
        `).join('') || '<div class="meta">Artifact Vault is empty.</div>'}</div>`;
    } else if (activeOpsTab === 'budgets') {
      const ev = opsState.budgets.evaluation;
      body = `
        <div class="field-row" style="margin-bottom:10px">
          <span class="pill ${ev?.action === 'block' ? 'err' : 'ok'}">24h Guardrail: ${esc(ev?.action || 'allow')}</span>
          <span class="meta mono">calls=${esc(String(ev?.usage?.global_calls_24h ?? 0))} · tokens=${esc(fmtTok(ev?.usage?.global_tokens_24h ?? 0))}</span>
        </div>
        <div class="grid-2">
          <div>
            <h3 style="margin-bottom:6px">Budget Policies</h3>
            <div class="list">${(opsState.budgets.policies || []).map((p) => `
              <div class="wt-card"><strong class="mono">${esc(p.scope_type)}:${esc(p.scope_id)}</strong> <span class="pill warn">${esc(p.on_exceed)}</span> <span class="meta">${esc(fmtTok(p.daily_token_limit || 0))} tok / ${esc(String(p.daily_call_limit || '∞'))} calls</span></div>
            `).join('') || '<div class="meta">No budget policies configured.</div>'}</div>
          </div>
          <div>
            <h3 style="margin-bottom:6px">Safe Triggers</h3>
            <div class="list">${opsState.triggers.map((tr) => `
              <div class="wt-card">
                <div class="panel-head" style="margin-bottom:4px">
                  <strong>${esc(tr.name)}</strong>
                  <button type="button" class="btn sm cyan" data-run-trg="${esc(tr.trigger_id)}">Run</button>
                </div>
                <div class="meta mono">${esc(tr.action)} · every ${esc(String(tr.interval_sec || '-'))}s</div>
              </div>
            `).join('') || '<div class="meta">No periodic triggers configured.</div>'}</div>
          </div>
        </div>`;
    } else if (activeOpsTab === 'webhooks') {
      body = `
        <div class="field-row" style="margin-bottom:10px">
          <input class="input" id="opsWhkName" placeholder="Webhook name (e.g. Slack Ops)" />
          <select class="input" id="opsWhkFormat">
            <option value="slack">Slack</option>
            <option value="discord">Discord</option>
            <option value="feishu">Feishu / Lark</option>
            <option value="dingtalk">DingTalk</option>
            <option value="telegram">Telegram</option>
            <option value="generic">Generic HMAC JSON</option>
          </select>
          <input class="input grow" id="opsWhkUrl" placeholder="https://hooks.slack.com/services/... (SSRF-guarded)" />
          <input class="input" id="opsWhkSecretEnv" placeholder="Optional *_SECRET env var" />
          <button type="button" class="btn primary sm" id="btnOpsWhkSave">+ Save Webhook</button>
        </div>
        <div class="list">${opsState.webhooks.map((w) => `
          <div class="wt-card">
            <div class="panel-head" style="margin-bottom:4px">
              <div><strong>${esc(w.name)}</strong> <span class="pill ok">${esc(w.format)}</span> <span class="meta mono">${esc((w.events || []).join(','))}</span></div>
              <div class="panel-tools">
                <button type="button" class="btn sm cyan" data-test-whk="${esc(w.webhook_id)}">Send Test</button>
                <button type="button" class="btn ghost sm" data-del-whk="${esc(w.webhook_id)}">Delete</button>
              </div>
            </div>
            <div class="meta mono">${esc(w.url)} · deliveries=${esc(String(w.delivery_count || 0))} ${w.last_status ? `· HTTP ${w.last_status}` : ''}</div>
          </div>
        `).join('') || '<div class="meta">No outbound webhooks registered yet.</div>'}</div>`;
    } else if (activeOpsTab === 'setup') {
      const detected = opsState.setupPlan?.detected_clients || [];
      const auto = opsState.autostart;
      const httpCfg = JSON.stringify({ mcpServers: { 'collab-hub': { url: 'http://127.0.0.1:5290/mcp?profile=cockpit' } } }, null, 2);
      body = `
        <div class="grid-2" style="margin-bottom:12px">
          <div class="wt-card">
            <h3 style="margin-bottom:6px">1-Command Onboarding &amp; Always-On Resident Mode</h3>
            <p class="meta" style="margin-bottom:8px">Auto-detects 14 mainstream clients, installs zero-secret MCP entry (with <code>.bak</code> backup), Claude Code <code>statusLine</code> HUD, OS autostart, and floating dock.</p>
            <pre class="code-box">collab-hub setup --profile cockpit --confirm
collab-hub cockpit --dock
collab-hub autostart install --confirm</pre>
            <div class="panel-tools" style="margin-top:8px">
              <button type="button" class="btn primary sm" id="btnOpsApplySetup">Run Guided Setup Now (.bak)</button>
              <button type="button" class="btn cyan sm" id="btnOpsDockNow">Pop-out Floating HUD</button>
              <span class="pill ${auto?.installed ? 'ok' : 'demo'}">Autostart: ${auto?.installed ? `${esc(auto.manager)} active` : 'ready'}</span>
            </div>
          </div>
          <div class="wt-card">
            <h3 style="margin-bottom:6px">Streamable HTTP <code>/mcp</code> &amp; Context Profiles</h3>
            <p class="meta" style="margin-bottom:8px">Choose <code>core</code> (13 tools), <code>cockpit</code> (23 tools), or <code>full</code> (53 tools) to match any context budget.</p>
            <pre class="code-box">${esc(httpCfg)}</pre>
          </div>
        </div>
        <div class="roster-grid">${detected.map((c) => `
          <div class="wt-card" style="padding:8px 10px">
            <div style="display:flex;justify-content:space-between;align-items:center;gap:6px">
              <strong>${esc(c.name || c.id)}</strong>
              <span class="pill ${c.exists ? 'ok' : 'subtle'}">${c.exists ? `detected (${c.server_count ?? 0})` : 'ready'}</span>
            </div>
          </div>
        `).join('')}</div>`;
    } else {
      const ides = opsState.pluginPlan?.ides || [];
      const rr = opsState.routeResult;
      const savedPrompt = opsState.routePrompt ?? 'Security audit of SSRF and /mcp origin checks';
      const savedStrategy = opsState.routeStrategy || 'balanced';
      body = `
        <div class="grid-2" style="margin-bottom:12px">
          <div class="wt-card">
            <h3 style="margin-bottom:6px">Model-Strength Smart Router Simulator</h3>
            <p class="meta" style="margin-bottom:8px">Routes each task to the strongest available agent &amp; model (inspired by RouteLLM + LiteLLM Router).</p>
            <div class="field-row" style="margin-bottom:8px">
              <input type="text" class="input grow" id="opsRoutePrompt" aria-label="Smart router task prompt" placeholder="e.g. Security audit of SSRF / 写双语推广文案 / Fix Docker Linux CI" value="${esc(savedPrompt)}" />
              <select class="input" id="opsRouteStrategy" aria-label="Routing strategy" style="max-width:120px">
                <option value="balanced" ${savedStrategy === 'balanced' ? 'selected' : ''}>balanced</option>
                <option value="quality" ${savedStrategy === 'quality' ? 'selected' : ''}>quality</option>
                <option value="cost" ${savedStrategy === 'cost' ? 'selected' : ''}>cost</option>
                <option value="speed" ${savedStrategy === 'speed' ? 'selected' : ''}>speed</option>
              </select>
              <button type="button" class="btn primary sm" id="btnOpsRouteTest">Recommend Agent</button>
            </div>
            ${rr?.recommended ? `
              <div class="wt-card" style="border-color:var(--accent-border)">
                <div class="panel-head" style="margin-bottom:4px">
                  <strong>Recommended: ${esc(rr.recommended.name)} <span class="pill ok">${esc(rr.recommended.model_tier || 'flagship')}</span></strong>
                  <span class="mono">score ${esc(String(rr.recommended.score))}</span>
                </div>
                <div class="meta mono">${esc(rr.task_classification?.category || '')} (${esc(rr.task_classification?.complexity || '')}) · ${(rr.recommended.routing_reasons || []).map(esc).join(' · ')}</div>
              </div>` : '<div class="meta">Enter any English or Chinese task above to inspect why CollabHub routes it to a specific agent/model.</div>'}
          </div>
          <div class="wt-card">
            <div class="panel-head" style="margin-bottom:6px">
              <div><h3>Sticky Native Host Plugins (VS Code / Cursor / Windsurf / AGY / Kiro)</h3><p class="meta">Zero-dep Activity Bar Webview + bottom StatusBar HUD + tmux / Zsh / PowerShell scripts.</p></div>
              <button type="button" class="btn cyan sm" id="btnOpsInstallPlugins">Install IDE Plugins</button>
            </div>
            <div class="list" style="margin-bottom:8px">${ides.map((ide) => `
              <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--border)">
                <strong>${esc(ide.name)}</strong>
                <span class="pill ${ide.already_installed ? 'ok' : (ide.detected ? 'demo' : 'subtle')}">${ide.already_installed ? 'installed' : (ide.detected ? 'detected' : 'not found')}</span>
              </div>
            `).join('')}</div>
            <pre class="code-box">collab-hub install-plugins --confirm
collab-hub cockpit --dock --pin
collab-hub cockpit --split
# Chrome/Edge Shadow DOM Companion: load unpacked extensions/collab-hub-browser/</pre>
          </div>
        </div>
        <div class="roster-grid">${opsState.routeMatrix.map((m) => `
          <div class="wt-card" style="padding:9px 11px">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">
              <strong>${esc(m.name)}</strong>
              <span class="pill ok">${esc(m.tier)} · ${esc(m.cost_tier)}</span>
            </div>
            <div class="meta mono" style="margin-bottom:6px">${esc(m.model_hint || m.model_family)}</div>
            <div class="meta">${(m.top_strengths || []).map((s) => `<span class="pill subtle">${esc(s.category)}:${s.score}</span>`).join(' ')}</div>
          </div>
        `).join('')}</div>`;
    }

    root.innerHTML =
      `<section class="panel">` +
        `<div class="panel-head">` +
          `<div><h2>${esc(t('ops.title'))}</h2><p>${esc(t('ops.sub'))}</p></div>` +
        `</div>` +
        `<div class="tabs" role="tablist" aria-label="Rooms and operations sections" style="margin-bottom:12px">` +
          tabs.map((tb) => `<button type="button" role="tab" aria-selected="${activeOpsTab === tb.id ? 'true' : 'false'}" class="tab-btn ${activeOpsTab === tb.id ? 'active' : ''}" data-ops-tab="${tb.id}">${esc(tb.label)} <span class="pill">${tb.count}</span></button>`).join('') +
        `</div>` +
        `<div id="opsTabBody" role="tabpanel">${body}</div>` +
      `</section>`;
  }

  function bindEvents() {
    document.addEventListener('click', async (ev) => {
      const target = ev.target;
      if (!(target instanceof Element)) return;

      if (target.closest('#btnDockPopout') || target.closest('#btnOpsDockNow')) {
        popOutCockpit();
        return;
      }
      if (target.closest('#btnDockSetup')) {
        activeOpsTab = 'setup';
        setView('rooms', { focus: true });
        if (!loadedOps) loadOpsData();
        else renderOpsView();
        return;
      }
      const tabBtn = target.closest('[data-ops-tab]');
      if (tabBtn) {
        activeOpsTab = tabBtn.getAttribute('data-ops-tab') || 'rooms';
        renderOpsView();
        return;
      }
      if (state.demo && target.closest('#roomsOpsRoot button')) {
        const btn = target.closest('button');
        const id = btn?.id || '';
        if (id !== 'btnOpsDockNow' && id !== 'btnOpsRouteTest') {
          toast('Interactive static demo preview: mutations run against your local CollabHub daemon (`collab-hub start`).');
          return;
        }
      }
      if (target.closest('#btnOpsCreateRoom')) {
        const name = ($('#opsRoomName')?.value || '').trim();
        const goal = ($('#opsRoomGoal')?.value || '').trim();
        if (!name) return toast('Room name is required');
        try {
          await apiPost('/api/rooms/create', { name, goal, confirmed: true });
          toast(`Created room ${name}`);
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsSweepLeases')) {
        try {
          await apiPost('/api/rooms/reconcile-stale', {});
          toast('Swept expired room leases');
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      const clmBtn = target.closest('[data-claim-room]');
      if (clmBtn) {
        const roomId = clmBtn.getAttribute('data-claim-room');
        const pathGlob = ($(`[data-claim-glob="${roomId}"]`)?.value || '').trim();
        const ownerAgent = ($(`[data-claim-agent="${roomId}"]`)?.value || '').trim() || 'codex';
        if (!pathGlob) return toast('Path glob is required');
        try {
          await apiPost('/api/rooms/claim', { room_id: roomId, path_glob: pathGlob, owner_agent: ownerAgent });
          toast(`Claimed ${pathGlob} for ${ownerAgent}`);
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsConCreate')) {
        const topic = ($('#opsConTopic')?.value || '').trim();
        const members = ($('#opsConMembers')?.value || 'agy,codex,claude').split(',').map((s) => s.trim()).filter(Boolean);
        if (!topic) return toast('Topic is required');
        try {
          await apiPost('/api/consensus/create', { topic, members });
          toast('Consensus round started');
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      const synBtn = target.closest('[data-con-synth]');
      if (synBtn) {
        try {
          await apiPost('/api/consensus/synthesize', { round_id: synBtn.getAttribute('data-con-synth') });
          toast('Consensus synthesized');
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsArtPut')) {
        const name = ($('#opsArtName')?.value || '').trim();
        const content = ($('#opsArtBody')?.value || '').trim();
        if (!name || !content) return toast('Name & content required');
        try {
          await apiPost('/api/artifacts/put', { name, content });
          toast(`Saved artifact ${name}`);
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsHandoff')) {
        try {
          const res = await apiPost('/api/handoff-pack', {});
          opsState.handoffText = res.markdown || JSON.stringify(res, null, 2);
          renderOpsView();
        } catch (err) { toast(err.message); }
        return;
      }
      const runTrg = target.closest('[data-run-trg]');
      if (runTrg) {
        try {
          await apiPost('/api/triggers/run', { trigger_id: runTrg.getAttribute('data-run-trg') });
          toast('Trigger executed');
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsWhkSave')) {
        const name = ($('#opsWhkName')?.value || '').trim();
        const format = $('#opsWhkFormat')?.value || 'generic';
        const url = ($('#opsWhkUrl')?.value || '').trim();
        const secret_env = ($('#opsWhkSecretEnv')?.value || '').trim() || null;
        if (!name || !url) return toast('Name & https:// URL required');
        try {
          await apiPost('/api/webhooks/save', { name, format, url, secret_env });
          toast(`Saved webhook ${name}`);
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      const testWhk = target.closest('[data-test-whk]');
      if (testWhk) {
        try {
          const r = await apiPost('/api/webhooks/test', { webhook_id: testWhk.getAttribute('data-test-whk') });
          toast(r.ok ? `Delivered HTTP ${r.status}` : `Delivery failed: ${r.error}`);
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      const delWhk = target.closest('[data-del-whk]');
      if (delWhk) {
        try {
          await apiPost('/api/webhooks/delete', { webhook_id: delWhk.getAttribute('data-del-whk') });
          toast('Webhook deleted');
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsRouteTest')) {
        const prompt = ($('#opsRoutePrompt')?.value || '').trim();
        const strategy = $('#opsRouteStrategy')?.value || 'balanced';
        opsState.routePrompt = prompt;
        opsState.routeStrategy = strategy;
        if (state.demo) {
          const isSec = /audit|ssrf|csrf|安全|审计/i.test(prompt);
          const isCopy = /readme|copy|文案|推广/i.test(prompt);
          const isLin = /linux|docker|bash|wsl/i.test(prompt);
          const pick = strategy === 'cost' ? 'Ollama Qwen2.5' : (isSec ? 'Codex' : (isCopy ? 'Antigravity' : (isLin ? 'WSL DSH' : 'Claude')));
          opsState.routeResult = {
            task_classification: { category: isSec ? 'security_audit' : (isCopy ? 'copywriting' : (isLin ? 'linux_ops' : 'architecture')), complexity: strategy === 'cost' ? 'low' : 'high' },
            recommended: { name: pick, model_tier: strategy === 'cost' ? 'local' : 'flagship', score: 88, routing_reasons: ['demo_capability_match', `strategy=${strategy}`] },
          };
          renderOpsView();
          return;
        }
        try {
          opsState.routeResult = await apiPost('/api/route/recommend', { prompt, role: 'researcher', strategy });
          renderOpsView();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsInstallPlugins')) {
        try {
          const res = await apiPost('/api/plugins/install', { confirmed: true });
          toast(`Installed native CollabHub extension into ${res.installed_count} IDE(s)`);
          await loadOpsData();
        } catch (err) { toast(err.message); }
        return;
      }
      if (target.closest('#btnOpsApplySetup')) {
        try {
          const res = await apiPost('/api/setup/apply', { profile: 'cockpit', confirmed: true });
          const count = (res.client_syncs || []).filter((c) => c.ok).length;
          toast(`Setup applied to ${count} clients (with .bak backups)`);
          await loadOpsData();
        } catch (err) { toast(err.message); }
      }
    });
  }

  return {
    bindEvents,
    onViewEnter(key) {
      renderResidentDock(state.overviewRaw);
      if (key === 'overview') renderLiveUsagePanel(state.overviewRaw);
      if (key === 'rooms') loadOpsData();
    },
    renderOverviewData(data) {
      renderResidentDock(data);
      renderLiveUsagePanel(data);
      renderRoomsBentoCard(data);
    },
    onLanguageChanged() {
      renderResidentDock(state.overviewRaw);
      renderLiveUsagePanel(state.overviewRaw);
      renderRoomsBentoCard(state.overviewRaw);
      if (state.view === 'rooms') renderOpsView();
    },
  };
}
