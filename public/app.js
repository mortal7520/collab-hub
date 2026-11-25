/* CollabHub v1.1 — app shell controller (zero dependencies). */
'use strict';

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const DEMO_QUERY = new URLSearchParams(location.search).get('demo') === '1';
const THEME_KEY = 'collabhub.theme';
const DEMO_DIR = '/workspace/collab-demo';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

const stateLabel = {
  online: '在线', idle: '就绪', dormant: '休眠', stale: '快照过期', cooldown: '429 冷却', offline: '离线', unknown: '待探测',
  created: '已登记', dispatching: '派发中', dispatched: '已派发', running: '执行中', stalled: '疑似卡住',
  needs_input: '待确认', uncertain: '待核验', completed: '已完成', failed: '失败', rerouted: '已重路由',
  pass: '通过', warn: '警告', fail: '异常',
};

const state = {
  demo: DEMO_QUERY,
  view: 'overview',
  taskView: 'table',
  members: [],
  tasks: [],
  telemetry: {},
  metrics: {},
  batches: [],
  worktrees: [],
  notes: [],
  recipes: [],
  mail: null,
  dagSteps: [],
  selectedDag: null,
  discovered: [],
  lastToolkitCopy: '',
  lastBatchMd: '',
  events: [],
  health: null,
  doctor: null,
  palette: { items: [], index: 0 },
  flags: { eventsLoaded: false, doctorLoaded: false, healthLoaded: false },
  timers: { reload: null, dag: null, poll: null, sse: null },
};

const VIEWS = {
  overview: { zh: '总览', en: 'Overview', sub: 'Agents, throughput, and live workbench health' },
  tasks: { zh: '任务与看板', en: 'Tasks & Kanban', sub: '回执账本、Kanban 泳道与批量筛选' },
  dag: { zh: '编排与流水线', en: 'DAG & Playbooks', sub: '可视化依赖图与四套实战流水线' },
  worktrees: { zh: '分支隔离', en: 'Worktrees', sub: 'Review · Verify · Merge · Cleanup' },
  toolkit: { zh: '工具箱与记忆', en: 'Toolkit & Memory', sub: 'ast-grep · repomix · markitdown · beads · cass · FTS5' },
  ops: { zh: '审计与体检', en: 'Ops & Doctor', sub: 'Live audit events, 8-point doctor, hot backup' },
};

const KANBAN_COLUMNS = [
  { key: 'queued', title: '排队 / 派发中', dot: 'queued', match: (s) => ['created', 'dispatching', 'dispatched'].includes(s) },
  { key: 'running', title: '执行中', dot: 'running', match: (s) => s === 'running' },
  { key: 'attention', title: '需关注 / 阻塞', dot: 'attention', match: (s) => ['stalled', 'uncertain', 'needs_input'].includes(s) },
  { key: 'done', title: '已结束', dot: 'done', match: (s) => ['completed', 'failed', 'rerouted'].includes(s) },
];

const AGENT_DRIVERS = ['dsh-baton', 'muse-tailnet', 'claude-dual', 'generic-cli', 'openai-http'];
const TOOLKIT_ITEMS = [
  { key: 'cass', label: 'cass', focus: 'cass' },
  { key: 'ast_grep', label: 'ast-grep', tab: 'ast' },
  { key: 'beads', label: 'beads', tab: 'beads' },
  { key: 'repomix', label: 'repomix', tab: 'pack' },
  { key: 'markitdown', label: 'markitdown', tab: 'doc' },
];
const AGENT_PRESETS = {
  ollama: { id: 'ollama-qwen', name: 'Ollama Qwen2.5 Coder', driver: 'openai-http', roles: 'researcher,reviewer,synthesizer', config: { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b', api_key_env: '' } },
  deepseek: { id: 'deepseek-r1', name: 'DeepSeek Reasoner', driver: 'openai-http', roles: 'planner,reviewer,synthesizer', config: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', api_key_env: 'DEEPSEEK_API_KEY' } },
  lmstudio: { id: 'lmstudio-local', name: 'LM Studio Local', driver: 'openai-http', roles: 'researcher,reviewer', config: { base_url: 'http://127.0.0.1:1234/v1', model: 'local-model', api_key_env: '' } },
  gemini: { id: 'gemini-cli', name: 'Gemini CLI', driver: 'generic-cli', roles: 'researcher,reviewer,synthesizer', config: { command: 'gemini', args: ['-p', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 120 } },
  aider: { id: 'aider-cli', name: 'Aider CLI', driver: 'generic-cli', roles: 'implementer,reviewer', config: { command: 'aider', args: ['--yes', '--message', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 180 } },
  cursor: { id: 'cursor-desktop', name: 'Cursor Desktop', driver: 'desktop-native', roles: 'planner,implementer,reviewer', config: {} },
};
const DEMO_RECIPES = [
  { recipe_id: 'demo-code-review', title: 'Independent code review', role: 'reviewer', prompt: 'Review the staged diff independently. List concrete defects with file/line references and severity. Do not restate the diff.' },
  { recipe_id: 'demo-research', title: 'Research & summarize', role: 'researcher', prompt: 'Research the requested topic. Return a concise brief with sources, trade-offs, and a recommended next action.' },
];

function fmtDate(value, withTime = true) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return withTime ? d.toLocaleString() : d.toLocaleDateString();
}

function fmtTimeShort(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function relTime(value) {
  if (!value) return '—';
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return '—';
  const diff = Date.now() - t;
  if (diff < 45_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

function fmtTokens(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(v >= 10_000 ? 0 : 1)}k`;
  return String(Math.round(v));
}

function fmtUptime(seconds) {
  const s = Math.max(0, Number(seconds) || 0);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return `${m}m`;
}

function badge(stateValue) {
  const key = String(stateValue || 'unknown');
  return `<span class="badge st-${esc(key)}">${esc(stateLabel[key] || key)}</span>`;
}

function initials(name) {
  const raw = String(name || '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!raw) return '?';
  const parts = raw.split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return raw.slice(0, 2).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Theme                                                               */
/* ------------------------------------------------------------------ */

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* private mode */ }
  const btn = $('#btnTheme');
  if (btn) {
    btn.textContent = next === 'dark' ? '☀' : '☾';
    btn.title = next === 'dark' ? '切换到浅色主题' : '切换到深色主题';
    btn.setAttribute('aria-label', btn.title);
  }
}

function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem(THEME_KEY); } catch { /* ignore */ }
  applyTheme(saved === 'light' ? 'light' : 'dark');
}

function toggleTheme() {
  const now = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(now);
  toast(now === 'dark' ? '已切换到 Obsidian 深色主题' : '已切换到 Alabaster 浅色主题', 'info', 2400);
}

/* ------------------------------------------------------------------ */
/* Toasts                                                              */
/* ------------------------------------------------------------------ */

function toast(message, type = 'info', ttl = 4200) {
  const host = $('#toastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const dot = document.createElement('span');
  dot.className = 'toast-dot';
  const msg = document.createElement('div');
  msg.className = 'toast-msg';
  msg.textContent = String(message ?? '');
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'toast-x';
  close.setAttribute('aria-label', 'Dismiss');
  close.textContent = '×';
  let dismissed = false;
  const dismiss = () => {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  close.addEventListener('click', dismiss);
  el.append(dot, msg, close);
  host.append(el);
  const timer = setTimeout(dismiss, Math.max(1200, ttl));
}

/* ------------------------------------------------------------------ */
/* API                                                                 */
/* ------------------------------------------------------------------ */

async function apiGet(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiPost(url, payload) {
  if (state.demo) {
    toast('Demo Preview 为只读模式，写操作已禁用。', 'warn');
    throw new Error('Demo mode is read-only');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

function viewFromHash() {
  const id = location.hash.replace(/^#\/?/, '');
  return Object.prototype.hasOwnProperty.call(VIEWS, id) ? id : 'overview';
}

function setView(id, { silent = false, focus = false } = {}) {
  const key = Object.prototype.hasOwnProperty.call(VIEWS, id) ? id : 'overview';
  state.view = key;
  $$('.nav-item').forEach((btn) => {
    const active = btn.dataset.view === key;
    btn.classList.toggle('active', active);
    if (active) btn.setAttribute('aria-current', 'page');
    else btn.removeAttribute('aria-current');
  });
  $$('.view').forEach((panel) => panel.classList.toggle('active', panel.dataset.viewPanel === key));
  const meta = VIEWS[key];
  const title = $('#viewTitle');
  const sub = $('#viewSubtitle');
  if (title) title.textContent = meta.zh;
  if (sub) sub.textContent = meta.sub;
  if (!silent) history.replaceState(null, '', `#${key}`);
  if (key === 'dag') { refreshDagAgentOptions(); renderDagCanvas(); }
  if (key === 'ops') {
    if (!state.flags.eventsLoaded) loadEvents();
    if (!state.flags.doctorLoaded) loadDoctor();
    if (!state.flags.healthLoaded) loadHealth();
  }
  if (key === 'toolkit') {
    renderNotes(state.notes);
    renderToolkitMeta();
  }
  closeMobileNav();
  if (!silent) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (focus) {
    const active = $(`.view[data-view-panel="${key}"]`);
    active?.scrollIntoView({ block: 'start' });
  }
}

function openMobileNav() { $('#sidebar')?.classList.add('open'); }
function closeMobileNav() { $('#sidebar')?.classList.remove('open'); }

/* ------------------------------------------------------------------ */
/* Command palette                                                     */
/* ------------------------------------------------------------------ */

function paletteSources() {
  const actions = [
    { group: 'Actions', icon: '＋', label: '派发新任务', sub: 'Dispatch a background task', kind: 'action', run: openDispatchModal },
    { group: 'Actions', icon: '◎', label: '探活所有 Agent', sub: 'Probe members and mail hub', kind: 'action', run: probeAll },
    { group: 'Actions', icon: '✎', label: '写共享记忆', sub: 'Write FTS5 memory note', kind: 'action', run: openMemoryModal },
    { group: 'Actions', icon: '＋', label: '扩展新 Agent', sub: 'Register an agent', kind: 'action', run: openAgentModal },
    { group: 'Actions', icon: '◐', label: '切换深色 / 浅色主题', sub: 'Toggle obsidian / alabaster', kind: 'action', run: toggleTheme },
    { group: 'Actions', icon: '↻', label: '更新 cass 索引', sub: 'Reindex cross-agent sessions', kind: 'action', run: () => reindexCass() },
    { group: 'Actions', icon: '✚', label: '系统体检', sub: 'Run the 8-point doctor', kind: 'action', run: () => { setView('ops'); loadDoctor(true); } },
  ];
  const views = Object.entries(VIEWS).map(([id, meta]) => ({
    group: 'Views',
    icon: '→',
    label: `${meta.zh} · ${meta.en}`,
    sub: meta.sub,
    kind: 'view',
    run: () => setView(id),
  }));
  const tasks = state.tasks.map((t) => ({
    group: 'Tasks',
    icon: '▣',
    label: t.title,
    sub: `${t.task_id} · ${t.member} · ${stateLabel[t.state] || t.state}`,
    kind: 'task',
    run: () => openTask(t.task_id),
  }));
  return { actions, views, tasks };
}

function buildPalette(query) {
  const q = String(query || '').trim().toLowerCase();
  const { actions, views, tasks } = paletteSources();
  const match = (item) => !q || `${item.label} ${item.sub} ${item.kind}`.toLowerCase().includes(q);
  const groups = [
    ['Actions', actions.filter(match).slice(0, 8)],
    ['Views', views.filter(match).slice(0, 8)],
    ['Tasks', tasks.filter(match).slice(0, 12)],
  ];
  const flat = groups.flatMap(([group, list]) => list.map((item) => ({ group, item })));
  state.palette.items = flat.map((entry) => entry.item);
  if (!flat.length) state.palette.index = 0;
  else if (state.palette.index >= flat.length) state.palette.index = 0;

  let index = 0;
  let html = '';
  for (const [group, list] of groups) {
    if (!list.length) continue;
    html += `<div class="palette-group">${esc(group)}</div>`;
    for (const item of list) {
      const i = index++;
      html += `
        <button type="button" class="palette-item${i === state.palette.index ? ' active' : ''}" data-palette-index="${i}">
          <span class="palette-icon">${esc(item.icon)}</span>
          <span class="palette-copy">
            <span class="palette-label">${esc(item.label)}</span>
            <span class="palette-sub">${esc(item.sub)}</span>
          </span>
          <span class="palette-kind">${esc(item.kind)}</span>
        </button>`;
    }
  }
  if (!flat.length) html = '<div class="palette-empty">没有匹配的命令或任务。试试 “dispatch” 或任务关键字。</div>';
  const list = $('#paletteList');
  if (list) list.innerHTML = html;
  const active = $('#paletteList .palette-item.active');
  active?.scrollIntoView({ block: 'nearest' });
}

function movePalette(delta) {
  const count = state.palette.items.length;
  if (!count) return;
  state.palette.index = (state.palette.index + delta + count) % count;
  $$('#paletteList .palette-item').forEach((el, i) => el.classList.toggle('active', i === state.palette.index));
  $('#paletteList .palette-item.active')?.scrollIntoView({ block: 'nearest' });
}

function openPalette() {
  const bg = $('#paletteBg');
  if (!bg) return;
  bg.classList.add('open');
  bg.setAttribute('aria-hidden', 'false');
  state.palette.index = 0;
  const input = $('#paletteInput');
  if (input) { input.value = ''; input.focus(); }
  buildPalette('');
}

function closePalette() {
  const bg = $('#paletteBg');
  if (!bg) return;
  bg.classList.remove('open');
  bg.setAttribute('aria-hidden', 'true');
}

function runPaletteIndex(i) {
  const item = state.palette.items[i];
  if (!item) return;
  closePalette();
  try { item.run(); } catch (err) { toast(String(err?.message || err), 'error'); }
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function setLastUpdated(iso) {
  const el = $('#updatedAt');
  if (!el) return;
  el.textContent = iso ? `同步 ${fmtTimeShort(iso)}` : '同步中';
}

function renderMail(mail) {
  state.mail = mail || null;
  const pill = $('#mailPill');
  if (!pill) return;
  const ok = Boolean(mail?.ok);
  pill.textContent = ok ? `Mail v${mail.version || ''} · :5291` : 'Mail 离线';
  pill.classList.toggle('ok', ok);
  pill.classList.toggle('off', !ok);
  pill.title = ok ? 'Mail hub 在线，点击打开' : (mail?.error || 'Mail hub 未连接');
}

function renderKpis(metrics) {
  const box = $('#kpiBar');
  if (!box) return;
  const m = metrics || {};
  const cards = [
    { label: '在线 / 注册 Agent', value: `${m.agents_ready ?? 0} / ${m.agents_total ?? 0}`, sub: 'online + idle 实时探活' },
    { label: '已完成 / 总任务', value: `${m.tasks_completed ?? 0} / ${m.tasks_total ?? 0}`, sub: '真实回执账本' },
    { label: '执行中 / 需关注', value: `${m.tasks_active ?? 0} / ${m.tasks_stalled ?? 0}`, sub: 'running / stalled' },
    { label: '活跃 Worktree', value: String(m.active_worktrees ?? 0), sub: '分支隔离租约' },
    { label: '共享记忆笔记', value: String(m.memory_notes ?? 0), sub: 'SQLite FTS5' },
    { label: 'cass 历史索引', value: m.cass_conversations != null ? `${m.cass_conversations} 会话` : '未索引', sub: m.cass_messages != null ? `${fmtTokens(m.cass_messages)} 消息` : '点击更新索引' },
  ];
  box.innerHTML = cards.map((c) => `
    <div class="kpi-card">
      <div class="kpi-label">${esc(c.label)}</div>
      <div class="kpi-value">${esc(c.value)}</div>
      <div class="kpi-sub">${esc(c.sub)}</div>
    </div>`).join('');
}

function renderToolkitStrip(toolkit) {
  const box = $('#toolkitStrip');
  if (!box) return;
  const tk = toolkit || {};
  const installed = TOOLKIT_ITEMS.filter((it) => tk[it.key]?.installed).length;
  const installedEl = $('#tkInstalledCount');
  if (installedEl) installedEl.textContent = `${installed} / 4`;
  box.innerHTML = `<span class="meta">工具链</span>` + TOOLKIT_ITEMS.map((it) => {
    const info = tk[it.key] || {};
    const attrs = it.tab ? `data-open-tk-tab="${esc(it.tab)}"` : 'data-focus-cass="1"';
    return `<button type="button" class="tk-pill" ${attrs} title="${esc(info.purpose || '')}">
      <i class="tk-dot${info.installed ? ' on' : ''}"></i>${esc(it.label)}
    </button>`;
  }).join('');
}

function renderBanner(tasks) {
  const banner = $('#alertBanner');
  if (!banner) return;
  const stalled = tasks.filter((t) => t.state === 'stalled' || t.state === 'uncertain');
  if (!stalled.length) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <div><strong>⚠️ 发现 ${stalled.length} 项疑似卡住 / 待核验任务：</strong>
      ${stalled.map((t) => `<code>${esc(t.task_id)}</code> <span class="meta">(${esc(t.member)} · ${esc(t.error_code || t.state)})</span>`).join('、')}
    </div>
    <button type="button" class="btn warn sm" data-open-task="${esc(stalled[0].task_id)}">查看诊断与处理</button>`;
}

function renderAgentFilter() {
  const sel = $('#filterAgent');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">全部 Agent</option>' + state.members.map((m) => (
    `<option value="${esc(m.member)}">${esc(m.name || m.member)}</option>`
  )).join('');
  sel.value = prev;
}

function renderRoster() {
  const box = $('#roster');
  if (!box) return;
  const count = $('#rosterCount');
  if (count) count.textContent = `${state.members.length} agents`;
  if (!state.members.length) {
    box.innerHTML = '<div class="mini-empty">暂无已注册 Agent。点击「扩展 Agent」接入本地模型或 CLI。</div>';
    return;
  }
  box.innerHTML = state.members.map((m) => {
    const st = m.state || 'unknown';
    const tel = state.telemetry?.[m.member];
    const telHtml = tel && Number(tel.total) > 0 ? `
      <div class="agent-tel">
        <span>${esc(tel.completed ?? 0)}/${esc(tel.total ?? 0)} 回执</span>
        ${tel.success_rate != null ? `<span>成功率 ${Math.round(Number(tel.success_rate) * 100)}%</span>` : ''}
        ${tel.avg_latency_ms != null ? `<span>${(Number(tel.avg_latency_ms) / 1000).toFixed(1)}s</span>` : ''}
        ${tel.total_tokens ? `<span>${fmtTokens(tel.total_tokens)} tok</span>` : ''}
      </div>` : '';
    const actions = [];
    if (!state.demo) {
      if (['generic-cli', 'openai-http'].includes(m.driver)) actions.push(`<button type="button" class="btn ghost sm" data-test-agent="${esc(m.member)}">测试连通</button>`);
      if (m.in_cooldown || m.cli_in_cooldown) actions.push(`<button type="button" class="btn warn sm" data-clear-cooldown="${esc(m.member)}">解除冷却 ${Number(m.cooldown_remaining_s || 0)}s</button>`);
      if (!m.builtin) actions.push(`<button type="button" class="btn danger sm" data-remove-agent="${esc(m.member)}">移除</button>`);
    }
    return `
      <article class="agent-card">
        <span class="agent-avatar">${esc(initials(m.name || m.member))}</span>
        <div class="agent-body">
          <div class="agent-top">
            <span class="agent-name">${esc(m.name || m.member)}${m.builtin ? '' : ' <span class="pill">扩展</span>'}</span>
            ${badge(st)}
          </div>
          <div class="agent-meta"><code>${esc(m.channel || m.driver || '—')}</code><span>${esc(m.checked_at ? fmtTimeShort(m.checked_at) : '—')}</span></div>
          ${m.detail ? `<div class="agent-detail">${esc(m.detail)}</div>` : ''}
          ${telHtml}
          ${actions.length ? `<div class="agent-actions">${actions.join('')}</div>` : ''}
        </div>
      </article>`;
  }).join('');
}

function renderBatches() {
  const html = state.batches.length
    ? '<span class="meta">协作批次（点击导出报告）：</span>' + state.batches.map((b) => {
      const badgeCls = b.all_succeeded ? 'st-completed' : (b.has_stalled ? 'st-stalled' : (b.all_terminal ? 'st-failed' : 'st-running'));
      const badgeText = b.all_succeeded ? '全部成功' : (b.has_stalled ? '含卡住' : (b.all_terminal ? '已结束' : '进行中'));
      const stats = Object.entries(b.counts || {}).map(([k, v]) => `${stateLabel[k] || k}:${v}`).join(' · ');
      return `<button type="button" class="batch-chip" data-open-batch="${esc(b.batch_id)}">
        <strong>${esc(b.batch_id)}</strong><span class="badge ${badgeCls}">${esc(badgeText)}</span><span class="batch-stats">${esc(stats)}</span>
      </button>`;
    }).join('')
    : '';
  for (const id of ['batchStrip', 'taskBatchStrip']) {
    const box = document.getElementById(id);
    if (box) box.innerHTML = html;
  }
}

function renderOverviewRecent() {
  const box = $('#ovRecentTasks');
  if (!box) return;
  const rows = state.tasks.slice(0, 5);
  if (!rows.length) { box.innerHTML = '<div class="mini-empty">暂无任务。点击「+ 派发」启动新协作。</div>'; return; }
  box.innerHTML = rows.map((t) => `
    <div class="mini-row" data-open-task="${esc(t.task_id)}">
      <div class="mini-main">
        <div class="mini-title">${esc(t.title)}</div>
        <div class="mini-sub">${esc(t.task_id)} · ${esc(t.member)} · ${esc(t.role)}</div>
      </div>
      <div class="mini-right">${badge(t.state)}<span class="mini-time">${esc(relTime(t.updated_at))}</span></div>
    </div>`).join('');
}

function renderOverviewWorktrees() {
  const box = $('#ovWorktrees');
  if (!box) return;
  if (!state.worktrees.length) { box.innerHTML = '<div class="mini-empty">当前无活跃并行 Worktree。</div>'; return; }
  box.innerHTML = state.worktrees.slice(0, 4).map((w) => `
    <div class="mini-row" data-wt-review="${esc(w.task_id)}">
      <div class="mini-main">
        <div class="mini-title">${esc(w.branch_name)}</div>
        <div class="mini-sub">${esc(w.member)} · ${esc(w.worktree_path)}</div>
      </div>
      <div class="mini-right">
        <span class="badge st-${esc(w.verify_status === 'passed' ? 'pass' : (w.state === 'active' ? 'running' : 'completed'))}">${esc(w.verify_status || w.state)}</span>
        <span class="mini-time">${esc(relTime(w.updated_at || w.created_at))}</span>
      </div>
    </div>`).join('');
}

function renderAll() {
  renderKpis(state.metrics);
  renderToolkitStrip(state.toolkit);
  renderBanner(state.tasks);
  renderAgentFilter();
  renderRoster();
  renderBatches();
  renderTasks();
  renderWorktrees();
  renderOverviewRecent();
  renderOverviewWorktrees();
  const navTask = $('#navTaskCount');
  if (navTask) navTask.textContent = String(state.tasks.length);
  const navWt = $('#navWtCount');
  if (navWt) navWt.textContent = String(state.worktrees.filter((w) => w.state === 'active').length);
  const memInput = $('#memQuery');
  if (!memInput || !memInput.value.trim()) renderNotes(state.notes);
  if (state.flags.healthLoaded) renderHealth();
  refreshDagAgentOptions();
}

async function loadOverview({ quiet = false } = {}) {
  try {
    const data = await apiGet(state.demo ? '/api/overview?demo=1' : '/api/overview');
    state.members = data.members || [];
    state.tasks = data.tasks || [];
    state.telemetry = data.telemetry?.agents || {};
    state.metrics = data.metrics || {};
    state.batches = data.batches || [];
    state.worktrees = data.worktrees || [];
    state.notes = data.notes || [];
    state.toolkit = data.toolkit || {};
    renderMail(data.mail_hub);
    setLastUpdated(data.generated_at);
    renderAll();
    if (state.view === 'ops' && state.flags.eventsLoaded) loadEvents({ quiet: true });
  } catch (err) {
    if (!quiet) toast(`加载总览失败：${err.message}`, 'error');
    const el = $('#updatedAt');
    if (el) el.textContent = '同步失败';
  }
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

function filteredTasks() {
  const q = ($('#filterText')?.value || '').trim().toLowerCase();
  const agent = $('#filterAgent')?.value || '';
  const st = $('#filterState')?.value || '';
  return state.tasks.filter((t) => {
    if (agent && t.member !== agent) return false;
    if (st && t.state !== st) return false;
    if (q) {
      const hay = `${t.title} ${t.task_id} ${t.batch_id || ''} ${t.result_text || ''} ${t.error_message || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTasks() {
  const rows = filteredTasks();
  const count = $('#taskCount');
  if (count) count.textContent = `${rows.length} / ${state.tasks.length} 条`;
  const body = $('#tasksBody');
  if (body) {
    body.innerHTML = rows.length ? rows.map((t) => {
      const receipt = [t.external_id ? `id:${String(t.external_id).slice(0, 16)}` : '', t.reply_generation ? `gen:${t.reply_generation}` : ''].filter(Boolean).join(' ');
      const snippet = t.result_text ? t.result_text.slice(0, 140) : (t.error_message || t.project_dir);
      return `<tr class="clickable" data-open-task="${esc(t.task_id)}">
        <td>
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-sub"><code class="task-id-code" title="${esc(t.task_id)}">${esc(t.task_id)}</code><span>${esc(t.role)}</span>${t.batch_id ? `<span>${esc(t.batch_id)}</span>` : ''}</div>
        </td>
        <td><div>${esc(t.member)}</div><div class="task-sub"><code>${esc(t.channel)}</code></div></td>
        <td>${badge(t.state)}</td>
        <td><code>${esc(receipt || '—')}</code></td>
        <td><div class="meta">${esc(snippet || '—')}</div><div class="meta">${esc(fmtDate(t.updated_at))}</div></td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="table-empty">无匹配任务。调整筛选条件或点击「+ 派发」启动新协作。</td></tr>';
  }

  const kanban = $('#tasksKanbanWrap');
  if (kanban) {
    kanban.innerHTML = KANBAN_COLUMNS.map((col) => {
      const items = rows.filter((t) => col.match(t.state));
      return `<section class="kb-col">
        <div class="kb-head">
          <span class="kb-title"><i class="dot dot-${col.dot}"></i>${esc(col.title)}</span>
          <span class="kb-count">${items.length}</span>
        </div>
        <div class="kb-cards">
          ${items.length ? items.map((t) => `
            <article class="kb-card" data-open-task="${esc(t.task_id)}">
              <div class="kb-card-top">
                <span class="kb-card-title">${esc(t.title)}</span>
                ${badge(t.state)}
              </div>
              <div class="kb-card-meta">
                <span>${esc(t.member)}</span><span>·</span><span>${esc(t.role)}</span>
                <code>${esc(String(t.task_id).slice(0, 24))}</code>
              </div>
              <div class="kb-card-meta"><span>${esc(relTime(t.updated_at))}</span>${t.batch_id ? `<span>${esc(t.batch_id)}</span>` : ''}</div>
            </article>`).join('') : '<div class="kb-empty">空</div>'}
        </div>
      </section>`;
    }).join('');
  }
}

function setTaskView(mode) {
  state.taskView = mode === 'kanban' ? 'kanban' : 'table';
  const table = $('#tasksTableWrap');
  const kanban = $('#tasksKanbanWrap');
  if (table) table.hidden = state.taskView !== 'table';
  if (kanban) kanban.hidden = state.taskView !== 'kanban';
  $('#btnViewTable')?.classList.toggle('active', state.taskView === 'table');
  $('#btnViewKanban')?.classList.toggle('active', state.taskView === 'kanban');
}

/* ------------------------------------------------------------------ */
/* Markdown renderer (escape-first, XSS-safe)                          */
/* ------------------------------------------------------------------ */

function renderSafeMarkdown(markdown) {
  const lines = esc(markdown || '').split(/\r?\n/);
  const out = [];
  let inList = false;
  let inTable = false;
  let inCode = false;
  let codeLines = [];
  const inline = (s) => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');

  const closeBlocks = () => {
    if (inList) { out.push('</ul>'); inList = false; }
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (inCode) {
      if (trimmed.startsWith('```')) {
        out.push(`<pre class="md-code"><code>${codeLines.join('\n')}</code></pre>`);
        inCode = false;
        codeLines = [];
      } else {
        codeLines.push(line);
      }
      continue;
    }
    if (trimmed.startsWith('```')) {
      closeBlocks();
      inCode = true;
      codeLines = [];
      continue;
    }
    if (!trimmed) { closeBlocks(); continue; }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;
      if (!inTable) {
        out.push(`<table><thead><tr>${cells.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>`);
        inTable = true;
      } else {
        out.push(`<tr>${cells.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`);
      }
      continue;
    }
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
    if (trimmed.startsWith('### ')) { closeBlocks(); out.push(`<h3>${inline(trimmed.slice(4))}</h3>`); continue; }
    if (trimmed.startsWith('## ')) { closeBlocks(); out.push(`<h2>${inline(trimmed.slice(3))}</h2>`); continue; }
    if (trimmed.startsWith('# ')) { closeBlocks(); out.push(`<h1>${inline(trimmed.slice(2))}</h1>`); continue; }
    if (trimmed.startsWith('&gt; ')) { closeBlocks(); out.push(`<blockquote>${inline(trimmed.slice(5))}</blockquote>`); continue; }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push(`<li>${inline(trimmed.slice(2))}</li>`);
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p>${inline(line)}</p>`);
  }
  if (inCode) out.push(`<pre class="md-code"><code>${codeLines.join('\n')}</code></pre>`);
  if (inList) out.push('</ul>');
  if (inTable) out.push('</tbody></table>');
  return out.join('');
}

/* ------------------------------------------------------------------ */
/* Markdown viewer / notes                                             */
/* ------------------------------------------------------------------ */

function renderNotes(notes) {
  const box = $('#memList');
  if (!box) return;
  const list = Array.isArray(notes) ? notes : [];
  if (!list.length) { box.innerHTML = '<div class="note-empty">暂无共享记忆笔记。点击「+ 记笔记」写入第一条。</div>'; return; }
  box.innerHTML = list.map((n) => `
    <article class="note-item" data-open-note-project="${esc(n.project)}" data-open-note-slug="${esc(n.slug)}">
      <div class="note-title">${esc(n.title)} <span class="pill">${esc(n.project)}</span></div>
      <div class="note-preview">${esc(n.preview || String(n.content || '').slice(0, 180))}</div>
      <div class="note-meta"><span>${esc(n.author || '—')}</span><span>${esc(fmtDate(n.updated_at))}</span></div>
    </article>`).join('');
}

async function openNote(project, slug) {
  try {
    let note = null;
    if (state.demo) {
      note = state.notes.find((n) => n.project === project && n.slug === slug);
    } else {
      const data = await apiGet(`/api/memory/note?project=${encodeURIComponent(project)}&slug=${encodeURIComponent(slug)}`);
      note = data.note;
    }
    if (!note) { toast('笔记不存在或已被删除。', 'warn'); return; }
    openDrawer(`
      <div class="drawer-head">
        <div>
          <div class="drawer-title">${esc(note.title)}</div>
          <div class="drawer-meta"><span>项目 <span class="pill">${esc(note.project)}</span></span><span>Slug <code>${esc(note.slug)}</code></span><span>作者 ${esc(note.author || '—')}</span></div>
        </div>
        <div class="panel-tools">
          <button type="button" class="btn ghost sm" data-toggle-raw="note">原始 MD</button>
          <button type="button" class="icon-btn" data-close-drawer="1" aria-label="Close">×</button>
        </div>
      </div>
      <div id="noteRich" class="md-view">${renderSafeMarkdown(note.content)}</div>
      <pre id="noteRaw" class="mono-pre" hidden>${esc(note.content)}</pre>`);
  } catch (err) {
    toast(`打开笔记失败：${err.message}`, 'error');
  }
}

async function searchMemory() {
  const input = $('#memQuery');
  const q = (input?.value || '').trim();
  try {
    if (state.demo) {
      const hits = q ? state.notes.filter((n) => `${n.title} ${n.content || ''} ${n.project}`.toLowerCase().includes(q.toLowerCase())) : state.notes;
      renderNotes(hits);
      return;
    }
    const data = await apiGet(`/api/memory?q=${encodeURIComponent(q)}`);
    renderNotes(data.results || []);
  } catch (err) {
    toast(`记忆检索失败：${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* DAG + canvas                                                        */
/* ------------------------------------------------------------------ */

function defaultDagSteps() {
  return [
    { id: 'plan', member: 'auto', role: 'planner', depends_on: [], prompt: '提出核心架构方案与最小实施路径。' },
    { id: 'redteam', member: 'auto', role: 'reviewer', depends_on: [], prompt: '从第一性原理红队审查潜在安全与并发风险。' },
    { id: 'verdict', member: 'auto', role: 'synthesizer', depends_on: ['plan', 'redteam'], prompt: '综合正反观点输出最终落地清单。' },
  ];
}

function dagTemplates(name) {
  if (name === 'debate') {
    return [
      { id: 'advocate', member: 'auto', role: 'planner', depends_on: [], prompt: '作为正方提出最优工程架构方案。' },
      { id: 'redteam', member: 'auto', role: 'reviewer', depends_on: [], prompt: '作为红队审查所有安全、竞态与维护陷阱。' },
      { id: 'verdict', member: 'auto', role: 'synthesizer', depends_on: ['advocate', 'redteam'], prompt: '综合正反观点给出最终决策与行动清单。' },
    ];
  }
  return [
    { id: 'research', member: 'auto', role: 'researcher', depends_on: [], prompt: '调研当前模块代码结构与边界条件。' },
    { id: 'review', member: 'auto', role: 'reviewer', depends_on: ['research'], prompt: '基于调研结果指出核心缺陷与重构点。' },
    { id: 'summary', member: 'auto', role: 'synthesizer', depends_on: ['review'], prompt: '输出简洁中文总结与优先级建议。' },
  ];
}

function dagMemberOptions(current) {
  const eligible = state.members.filter((m) => AGENT_DRIVERS.includes(m.driver));
  const ids = new Set(eligible.map((m) => m.member));
  const options = [`<option value="auto"${current === 'auto' || !current ? ' selected' : ''}>auto（智能路由）</option>`];
  for (const m of eligible) {
    options.push(`<option value="${esc(m.member)}"${current === m.member ? ' selected' : ''}>${esc(m.name || m.member)}</option>`);
  }
  if (current && current !== 'auto' && !ids.has(current)) {
    options.push(`<option value="${esc(current)}" selected>${esc(current)}</option>`);
  }
  return options.join('');
}

function renderDagSteps() {
  const box = $('#dagStepsList');
  if (!box) return;
  if (!state.dagSteps.length) { box.innerHTML = '<div class="mini-empty">还没有步骤。点击「+ 添加步骤」或套用上方模板。</div>'; return; }
  box.innerHTML = state.dagSteps.map((step, i) => `
    <div class="dag-step-card" data-dag-idx="${i}">
      <div class="dag-step-head">
        <span class="dag-step-no">Step ${String(i + 1).padStart(2, '0')} · ${esc(step.id)}</span>
        <button type="button" class="btn ghost sm" data-del-dag="${i}">删除</button>
      </div>
      <div class="dag-step-grid">
        <label class="dag-field"><span>Step ID</span><input type="text" data-dag-f="id" value="${esc(step.id)}" /></label>
        <label class="dag-field"><span>Agent</span><select data-dag-f="member">${dagMemberOptions(step.member)}</select></label>
        <label class="dag-field"><span>依赖前置（逗号分隔）</span><input type="text" data-dag-f="deps" value="${esc((step.depends_on || []).join(','))}" placeholder="留空即首波并行" /></label>
      </div>
      <label class="dag-field" style="margin-top:8px"><span>Prompt（上游输出自动注入）</span><textarea data-dag-f="prompt">${esc(step.prompt)}</textarea></label>
    </div>`).join('');
  const count = $('#dagNodeCount');
  if (count) count.textContent = `${state.dagSteps.length} nodes`;
}

function refreshDagAgentOptions() {
  $$('#dagStepsList .dag-step-card').forEach((card, i) => {
    const select = card.querySelector('[data-dag-f="member"]');
    if (!select) return;
    const current = select.value || state.dagSteps[i]?.member || 'auto';
    select.innerHTML = dagMemberOptions(current);
  });
}

function syncDagFromDom() {
  $$('#dagStepsList .dag-step-card').forEach((card, i) => {
    const step = state.dagSteps[i];
    if (!step) return;
    step.id = card.querySelector('[data-dag-f="id"]')?.value.trim() || `step_${i + 1}`;
    step.member = card.querySelector('[data-dag-f="member"]')?.value || 'auto';
    step.depends_on = (card.querySelector('[data-dag-f="deps"]')?.value || '').split(',').map((v) => v.trim()).filter(Boolean);
    step.prompt = card.querySelector('[data-dag-f="prompt"]')?.value || '';
  });
}

function computeDagGraph(steps) {
  const byId = new Map();
  steps.forEach((s, i) => {
    const id = s.id || `step_${i + 1}`;
    byId.set(id, { ...s, id, index: i });
  });
  const depthMap = new Map();
  const inCycle = new Set();
  const visit = (id, stack) => {
    if (depthMap.has(id)) return depthMap.get(id);
    if (stack.has(id)) {
      inCycle.add(id);
      return 0;
    }
    const node = byId.get(id);
    if (!node) return 0;
    stack.add(id);
    let depth = 0;
    for (const dep of node.depends_on || []) {
      if (!byId.has(dep) || dep === id) { if (dep === id) inCycle.add(id); continue; }
      const d = visit(dep, stack);
      if (inCycle.has(dep)) inCycle.add(id);
      depth = Math.max(depth, d + 1);
    }
    stack.delete(id);
    depthMap.set(id, depth);
    return depth;
  };
  for (const node of byId.values()) visit(node.id, new Set());
  const columns = [];
  for (const node of byId.values()) {
    const depth = depthMap.get(node.id) || 0;
    if (!columns[depth]) columns[depth] = [];
    columns[depth].push(node);
  }
  const edges = [];
  for (const node of byId.values()) {
    for (const dep of node.depends_on || []) {
      if (!byId.has(dep) || dep === node.id) continue;
      edges.push({ from: dep, to: node.id, cycle: inCycle.has(dep) || inCycle.has(node.id) || (depthMap.get(dep) || 0) >= (depthMap.get(node.id) || 0) });
    }
  }
  return { nodes: [...byId.values()], columns, depthMap, edges, inCycle };
}

function svgEl(tag, attrs = {}, text) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value != null) el.setAttribute(key, String(value));
  }
  if (text != null) el.textContent = text;
  return el;
}

function renderDagCanvas() {
  const svg = $('#dagCanvas');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const steps = state.dagSteps || [];
  const cycleHint = $('#dagCycleHint');

  if (!steps.length) {
    svg.setAttribute('width', '560');
    svg.setAttribute('height', '240');
    svg.setAttribute('viewBox', '0 0 560 240');
    const text = svgEl('text', { x: 280, y: 122, 'text-anchor': 'middle', fill: 'var(--faint)', 'font-size': '11' }, '添加步骤后自动绘制依赖图');
    svg.append(text);
    if (cycleHint) cycleHint.hidden = true;
    return;
  }

  const graph = computeDagGraph(steps);
  const NODE_W = 176;
  const NODE_H = 62;
  const COL_GAP = 232;
  const ROW_GAP = 96;
  const PAD_X = 30;
  const PAD_Y = 30;
  const maxDepth = Math.max(0, ...graph.nodes.map((n) => graph.depthMap.get(n.id) || 0));
  const maxRows = Math.max(1, ...graph.columns.map((c) => (c ? c.length : 0)));
  const width = Math.max(420, PAD_X * 2 + maxDepth * COL_GAP + NODE_W);
  const contentHeight = PAD_Y * 2 + (maxRows - 1) * ROW_GAP + NODE_H;
  const height = Math.max(300, contentHeight + 20);
  const offsetY = Math.max(0, (height - contentHeight) / 2);
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

  const defs = svgEl('defs');
  const marker = svgEl('marker', { id: 'dagArrow', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
  marker.append(svgEl('path', { d: 'M0,0 L8,4 L0,8 z', class: 'dag-arrow' }));
  const markerCycle = svgEl('marker', { id: 'dagArrowCycle', viewBox: '0 0 8 8', refX: '7', refY: '4', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' });
  markerCycle.append(svgEl('path', { d: 'M0,0 L8,4 L0,8 z', class: 'dag-arrow-cycle' }));
  defs.append(marker, markerCycle);
  svg.append(defs);

  const positions = new Map();
  for (let depth = 0; depth < graph.columns.length; depth++) {
    const column = graph.columns[depth] || [];
    column.forEach((node, row) => {
      positions.set(node.id, {
        x: PAD_X + depth * COL_GAP,
        y: PAD_Y + offsetY + row * ROW_GAP,
        node,
      });
    });
  }

  const edgeLayer = svgEl('g');
  for (const edge of graph.edges) {
    const a = positions.get(edge.from);
    const b = positions.get(edge.to);
    if (!a || !b) continue;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    const bend = Math.max(42, Math.abs(x2 - x1) * 0.42);
    const path = svgEl('path', {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      class: `dag-edge${edge.cycle ? ' dag-edge-cycle' : ''}`,
      'marker-end': `url(#${edge.cycle ? 'dagArrowCycle' : 'dagArrow'})`,
    });
    const title = svgEl('title', {}, `${edge.from} → ${edge.to}`);
    path.append(title);
    edgeLayer.append(path);
  }
  svg.append(edgeLayer);

  const nodeLayer = svgEl('g');
  for (const node of graph.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const group = svgEl('g', {
      class: `dag-node-group${graph.inCycle.has(node.id) ? ' dag-node-cycle' : ''}`,
      transform: `translate(${pos.x}, ${pos.y})`,
      'data-dag-node': node.id,
      tabindex: '0',
      role: 'button',
      'aria-label': `Step ${node.id}`,
    });
    group.append(svgEl('title', {}, `${node.id} · ${node.member || 'auto'} · ${node.role || 'researcher'}`));
    group.append(svgEl('rect', { class: 'dag-node-box', width: NODE_W, height: NODE_H, rx: 9 }));
    const roleClass = ['planner', 'reviewer', 'synthesizer'].includes(node.role) ? node.role : 'default';
    group.append(svgEl('circle', { cx: 14, cy: 19, r: 4, class: `dag-role-dot ${roleClass}` }));
    const label = String(node.id).length > 19 ? `${String(node.id).slice(0, 18)}…` : String(node.id);
    group.append(svgEl('text', { x: 25, y: 23, class: 'dag-node-label' }, label));
    const sub = `${node.member || 'auto'} · ${node.role || 'researcher'}`;
    group.append(svgEl('text', { x: 14, y: 45, class: 'dag-node-sub' }, sub.length > 27 ? `${sub.slice(0, 26)}…` : sub));
    const deps = (node.depends_on || []).length ? `deps: ${node.depends_on.join(', ')}` : 'root';
    group.append(svgEl('text', { x: 14, y: 57, class: 'dag-node-role' }, deps.length > 28 ? `${deps.slice(0, 27)}…` : deps));
    nodeLayer.append(group);
  }
  svg.append(nodeLayer);

  if (cycleHint) {
    const hasCycle = graph.inCycle.size > 0;
    cycleHint.hidden = !hasCycle;
    cycleHint.textContent = hasCycle ? `⚠ 检测到循环依赖：${[...graph.inCycle].join(', ')}` : '';
  }
  const count = $('#dagNodeCount');
  if (count) count.textContent = `${graph.nodes.length} nodes · ${graph.edges.length} edges`;
}

function addDagStep() {
  syncDagFromDom();
  state.dagSteps.push({ id: `step_${state.dagSteps.length + 1}`, member: 'auto', role: 'researcher', depends_on: [], prompt: '' });
  renderDagSteps();
  renderDagCanvas();
}

function removeDagStep(index) {
  syncDagFromDom();
  state.dagSteps.splice(Number(index), 1);
  renderDagSteps();
  renderDagCanvas();
}

function focusDagStep(index) {
  const card = $(`#dagStepsList .dag-step-card[data-dag-idx="${Number(index)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1400);
  const input = card.querySelector('[data-dag-f="id"]');
  input?.focus({ preventScroll: true });
}

async function runDag() {
  syncDagFromDom();
  const err = $('#dagErr');
  const out = $('#dagOut');
  if (err) err.textContent = '';
  if (state.demo) { toast('Demo Preview 为只读模式，DAG 不会真正派发。', 'warn'); return; }
  if (out) { out.hidden = false; out.textContent = '执行工作流中…'; }
  try {
    const result = await apiPost('/api/workflows/run', {
      name: $('#dagName')?.value.trim() || 'visual-dag',
      project_dir: $('#dagDir')?.value.trim(),
      steps: state.dagSteps,
      wait_sec: 0,
    });
    if (out) out.textContent = JSON.stringify(result, null, 2);
    toast('DAG 工作流已提交。', 'success');
    await loadOverview({ quiet: true });
  } catch (e) {
    if (out) out.hidden = true;
    if (err) err.textContent = e.message;
  }
}

/* ------------------------------------------------------------------ */
/* Playbooks                                                           */
/* ------------------------------------------------------------------ */

function selectPlaybook(type) {
  const select = $('#pbType');
  if (select) select.value = type;
  const form = $('#playbookForm');
  if (form) { form.open = true; form.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
  const goal = $('#pbGoal');
  setTimeout(() => goal?.focus(), 260);
}

async function runPlaybook() {
  const err = $('#pbErr');
  const out = $('#pbOut');
  if (err) err.textContent = '';
  if (state.demo) { toast('Demo Preview 为只读模式，Playbook 不会真正执行。', 'warn'); return; }
  if (out) { out.hidden = false; out.textContent = '执行中…'; }
  try {
    const type = $('#pbType')?.value || 'research-and-pack';
    const extra = $('#pbExtra')?.value.trim() || '';
    const membersRaw = $('#pbMembers')?.value.trim() || '';
    const result = await apiPost('/api/playbooks/run', {
      playbook: type,
      project_dir: $('#pbDir')?.value.trim(),
      goal: $('#pbGoal')?.value.trim(),
      include: $('#pbInclude')?.value.trim() || null,
      members: membersRaw ? membersRaw.split(',').map((s) => s.trim()).filter(Boolean) : null,
      session_query: type === 'research-and-pack' ? (extra || null) : null,
      ast_pattern: type === 'code-review-squad' ? (extra || null) : null,
    });
    if (out) out.textContent = JSON.stringify(result, null, 2);
    toast('Playbook 已执行。', 'success');
    await loadOverview({ quiet: true });
  } catch (e) {
    if (out) out.hidden = true;
    if (err) err.textContent = e.message;
  }
}

/* ------------------------------------------------------------------ */
/* Toolkit + cass                                                      */
/* ------------------------------------------------------------------ */

function openToolkitTab(tab) {
  setView('toolkit');
  $$('.tab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.tkTab === tab));
  $$('.tab-pane').forEach((pane) => pane.classList.toggle('active', pane.id === `pane-${tab}`));
  const err = $('#tkErr');
  if (err) err.textContent = '';
}

function showToolkitOutput(meta, text) {
  state.lastToolkitCopy = String(text ?? '');
  const metaEl = $('#tkMeta');
  const out = $('#tkOut');
  const copy = $('#btnCopyTk');
  if (metaEl) metaEl.textContent = meta;
  if (out) { out.textContent = state.lastToolkitCopy; out.hidden = false; }
  if (copy) copy.hidden = false;
}

async function runToolkit(kind) {
  const err = $('#tkErr');
  if (err) err.textContent = '';
  try {
    if (kind === 'ast') {
      const res = await apiPost('/api/toolkit/ast', {
        project_dir: $('#tkAstDir')?.value.trim(),
        pattern: $('#tkAstPat')?.value.trim(),
        lang: $('#tkAstLang')?.value.trim() || null,
      });
      showToolkitOutput(`AST 命中 ${res.total_matches} 处`, (res.matches || []).map((m) => `${m.file}:${m.line}  ${m.text}`).join('\n') || '(0 matches)');
    } else if (kind === 'pack') {
      const res = await apiPost('/api/toolkit/pack', {
        project_dir: $('#tkPackDir')?.value.trim(),
        include: $('#tkPackInc')?.value.trim() || null,
      });
      showToolkitOutput(`打包完成 · 约 ${res.approx_tokens} tokens`, res.content || '');
    } else if (kind === 'doc') {
      const res = await apiPost('/api/toolkit/doc2md', { file_path: $('#tkDocPath')?.value.trim() });
      showToolkitOutput(`转换完成 · ${res.total_chars} 字符`, res.markdown || '');
    } else if (kind === 'beads') {
      const res = await apiPost('/api/toolkit/beads', {
        project_dir: $('#tkBdDir')?.value.trim(),
        action: $('#tkBdAction')?.value,
        title: $('#tkBdTitle')?.value.trim() || null,
      });
      showToolkitOutput(`Beads ${res.action} 完成`, JSON.stringify(res.data || res.output || res, null, 2));
    }
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

function renderToolkitMeta() {
  const installed = TOOLKIT_ITEMS.filter((it) => state.toolkit?.[it.key]?.installed).length;
  const el = $('#tkInstalledCount');
  if (el) el.textContent = `${installed} / 4`;
}

async function searchSessions() {
  const q = $('#sessQuery')?.value.trim();
  const box = $('#sessList');
  if (!box || !q) return;
  if (state.demo) {
    box.innerHTML = '<div class="note-empty">Demo Preview 不访问本机跨端索引；在真实工作台输入关键词即可检索。</div>';
    return;
  }
  box.innerHTML = '<div class="meta">检索中…</div>';
  try {
    const data = await apiGet(`/api/sessions?q=${encodeURIComponent(q)}`);
    if (!data.ok) {
      box.innerHTML = `<div class="meta">${esc(data.hint || data.error || '未返回结果')}</div>`;
      return;
    }
    const hits = data.result?.hits || data.result?.results || (Array.isArray(data.result) ? data.result : []);
    if (hits.length) {
      box.innerHTML = hits.slice(0, 6).map((h) => `
        <article class="note-item">
          <div class="note-title">${esc(h.title || h.agent || h.source || 'Session')}</div>
          <div class="note-preview">${esc(String(h.snippet || h.content || JSON.stringify(h)).replace(/\*\*/g, '').slice(0, 220))}</div>
        </article>`).join('');
    } else {
      box.innerHTML = `<pre class="mono-pre">${esc(JSON.stringify(data.result || data.raw || '无匹配', null, 2).slice(0, 1200))}</pre>`;
    }
  } catch (err) {
    box.innerHTML = `<div class="form-error">检索失败：${esc(err.message)}</div>`;
  }
}

async function reindexCass() {
  if (state.demo) { toast('Demo Preview 为只读模式，索引不会更新。', 'warn'); return; }
  const btn = $('#btnReindexCass');
  const box = $('#sessList');
  if (btn) { btn.disabled = true; btn.textContent = '索引中…'; }
  try {
    const res = await apiPost('/api/sessions/reindex', {});
    const c = res.stats?.conversations;
    const m = res.stats?.messages;
    if (box) box.innerHTML = `<div class="meta">索引已更新${c ? `（${c} 会话 / ${m} 消息）` : ''}${res.partial ? ' · 已跳过写入中日志' : ''}</div>`;
    toast('cass 索引已更新。', 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    if (box) box.textContent = `索引失败：${err.message}`;
    toast(`索引失败：${err.message}`, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '更新索引'; }
  }
}

/* ------------------------------------------------------------------ */
/* Worktrees                                                           */
/* ------------------------------------------------------------------ */

function renderWorktrees() {
  const box = $('#wtList');
  if (!box) return;
  const count = $('#wtCount');
  if (count) count.textContent = `${state.worktrees.length}`;
  if (!state.worktrees.length) {
    box.innerHTML = '<div class="wt-empty">当前无活跃并行 Worktree。实现类任务派发后会自动创建隔离分支。</div>';
    return;
  }
  box.innerHTML = state.worktrees.map((w) => {
    const active = w.state === 'active';
    const verify = w.verify_status
      ? `<span class="badge st-${w.verify_status === 'passed' ? 'pass' : 'fail'}">verify: ${esc(w.verify_status)}</span>`
      : '<span class="pill">未验收</span>';
    const actions = active ? `<div class="wt-actions">
      <button type="button" class="btn ghost sm" data-wt-review="${esc(w.task_id)}">审查 Diff</button>
      ${state.demo ? '' : `<button type="button" class="btn danger sm" data-wt-cleanup="${esc(w.task_id)}">清理</button>`}
    </div>` : '';
    return `<article class="wt-card">
      <div class="wt-top"><span class="wt-branch" title="${esc(w.branch_name)}">${esc(w.branch_name)}</span>${badge(w.state)}</div>
      <div class="wt-meta">
        <span>成员 ${esc(w.member)} · 基线 <code>${esc(w.base_ref || 'main')}</code></span>
        <span>路径 <code title="${esc(w.worktree_path)}">${esc(w.worktree_path)}</code></span>
        <span>更新 ${esc(fmtDate(w.updated_at || w.created_at))}</span>
      </div>
      <div class="wt-verify">${verify}</div>
      ${actions}
    </article>`;
  }).join('');
}

function demoWorktreeReview(w) {
  const commits = [
    'a1b2c3d feat: add worktree verify gate',
    'e4f5a6b test: cover asset allowlist traversal',
    'c7d8e9f docs: annotate demo fixture',
  ];
  const diff = `diff --git a/src/example.mjs b/src/example.mjs
index 1111111..2222222 100644
--- a/src/example.mjs
+++ b/src/example.mjs
@@ -1,3 +1,9 @@
 export function greet(name) {
-  return 'hello ' + name;
+  return \`hello \${name}\`;
 }
+
+export function verifyFixture(input) {
+  if (typeof input !== 'string') throw new TypeError('input must be a string');
+  return input.trim().length > 0;
+}`;
  return { ...w, commits, diff_preview: diff, dirty: false, reviewed_head_sha: w.verified_head_sha || 'a1b2c3d4e5f6' };
}

async function openWorktreeReview(taskId) {
  try {
    let rev;
    if (state.demo) {
      const wt = state.worktrees.find((w) => w.task_id === taskId);
      if (!wt) { toast('Worktree 不存在。', 'warn'); return; }
      rev = demoWorktreeReview(wt);
    } else {
      rev = await apiPost('/api/worktrees/review', { task_id: taskId });
    }
    const demoNote = state.demo ? '<div class="meta" style="margin-bottom:10px">Demo Preview · 以下为示例审查数据，按钮已禁用。</div>' : '';
    const actions = state.demo ? '' : `<div class="drawer-actions">
      <button type="button" class="btn primary sm" data-wt-verify="${esc(rev.task_id)}">运行测试验收</button>
      <button type="button" class="btn success sm" data-wt-merge="${esc(rev.task_id)}">确认无误，合并入 ${esc(rev.base_ref || 'main')}</button>
      <button type="button" class="btn danger sm" data-wt-cleanup="${esc(rev.task_id)}">放弃并清理 Worktree</button>
    </div>`;
    openDrawer(`
      <div class="drawer-head">
        <div>
          <div class="drawer-title">Worktree 审查 · ${esc(rev.branch_name)}</div>
          <div class="drawer-meta"><span>Task <code>${esc(rev.task_id)}</code></span><span>Base <code>${esc(rev.base_ref || 'main')}</code></span><span>HEAD <code>${esc(String(rev.reviewed_head_sha || '').slice(0, 12) || '—')}</code></span><span>Dirty ${rev.dirty ? '是' : '否'}</span>${rev.verify_status ? `<span>${badge(rev.verify_status === 'passed' ? 'pass' : 'fail')}</span>` : ''}</div>
        </div>
        <button type="button" class="icon-btn" data-close-drawer="1" aria-label="Close">×</button>
      </div>
      ${demoNote}
      ${actions}
      <div class="form-error" id="wtMergeMsg"></div>
      <pre class="mono-pre" id="wtVerifyOut" hidden></pre>
      <div class="drawer-section"><h3>Commits (${(rev.commits || []).length})</h3><pre class="mono-pre">${esc((rev.commits || []).join('\n') || '(无新提交)')}</pre></div>
      <div class="drawer-section"><h3>Diff Preview</h3><pre class="mono-pre" style="max-height:52vh">${esc(rev.diff_preview || '(无改动)')}</pre></div>`);
  } catch (err) {
    toast(`Worktree 审查失败：${err.message}`, 'error');
  }
}

async function verifyWorktree(taskId, button) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  const out = $('#wtVerifyOut');
  const original = button?.textContent || '运行测试验收';
  if (button) { button.disabled = true; button.textContent = '测试运行中…'; }
  if (out) { out.hidden = false; out.textContent = 'Running allowlisted test suite inside worktree…'; }
  try {
    const res = await apiPost('/api/worktrees/verify', { task_id: taskId, preset: 'auto' });
    if (out) out.textContent = `[${res.preset} | ${String(res.status).toUpperCase()} | ${res.duration_ms}ms]\n${res.output || '(no output)'}`;
    toast(res.status === 'passed' ? '测试验收通过。' : `测试验收未通过（exit ${res.exit_code}）。`, res.status === 'passed' ? 'success' : 'error');
    await loadOverview({ quiet: true });
  } catch (err) {
    if (out) out.textContent = `验证失败：${err.message}`;
    toast(`验证失败：${err.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function mergeWorktree(taskId) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  try {
    await apiPost('/api/worktrees/merge', { task_id: taskId, confirmed: true, cleanup: true });
    closeDrawer();
    toast('Worktree 已合并并清理。', 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    const msg = $('#wtMergeMsg');
    if (msg) msg.textContent = err.message;
    toast(`合并失败：${err.message}`, 'error');
  }
}

async function cleanupWorktree(taskId) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  try {
    await apiPost('/api/worktrees/cleanup', { task_id: taskId, force: false, delete_branch: false });
    closeDrawer();
    toast('Worktree 已清理。', 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(`清理失败：${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Events / doctor / health                                            */
/* ------------------------------------------------------------------ */

function demoEvents() {
  const now = Date.now();
  const base = [
    { event_type: 'worktree.verify_passed', actor: 'cipher', task_id: 'demo-run-01', payload_json: '{"preset":"node-test","durationMs":4200}', minutes: 3 },
    { event_type: 'task.dispatched', actor: 'beacon', task_id: 'demo-queue-01', payload_json: '{"member":"beacon","role":"implementer"}', minutes: 12 },
    { event_type: 'task.reconciled', actor: 'atlas', task_id: 'demo-review-01', payload_json: '{"state":"uncertain"}', minutes: 27 },
    { event_type: 'memory.note_written', actor: 'atlas', task_id: null, payload_json: '{"project":"collab-demo","slug":"release-checklist"}', minutes: 44 },
    { event_type: 'agent.cooldown', actor: 'delta', task_id: 'demo-stall-01', payload_json: '{"reason":"429","retry_after_s":42}', minutes: 58 },
    { event_type: 'batch.report_exported', actor: 'system', task_id: null, payload_json: '{"batch_id":"demo-batch-01"}', minutes: 75 },
  ];
  return base.map((e) => ({ ...e, created_at: new Date(now - e.minutes * 60_000).toISOString() }));
}

function renderEvents() {
  const box = $('#eventsList');
  if (!box) return;
  if (!state.events.length) { box.innerHTML = '<div class="mini-empty">暂无审计事件。</div>'; return; }
  box.innerHTML = state.events.slice(0, 80).map((e) => `
    <div class="event-row">
      <i class="event-dot"></i>
      <div class="event-main">
        <div class="event-type">${esc(e.event_type)} <span class="meta">· ${esc(e.actor || 'system')}</span>${e.task_id ? ` <code>${esc(e.task_id)}</code>` : ''}</div>
        ${e.payload_json ? `<div class="event-json" title="${esc(e.payload_json)}">${esc(String(e.payload_json).slice(0, 260))}</div>` : ''}
      </div>
      <time class="event-time">${esc(fmtTimeShort(e.created_at))}</time>
    </div>`).join('');
}

async function loadEvents({ quiet = false } = {}) {
  if (state.demo) {
    state.events = demoEvents();
    renderEvents();
    state.flags.eventsLoaded = true;
    return;
  }
  try {
    const data = await apiGet('/api/events?limit=80');
    state.events = data.events || [];
    renderEvents();
    state.flags.eventsLoaded = true;
  } catch (err) {
    if (!quiet) toast(`加载审计事件失败：${err.message}`, 'error');
  }
}

const DEMO_DOCTOR = {
  overall: 'warn',
  pass_count: 7,
  total_checks: 8,
  checks: [
    { id: 'runtime.node', status: 'pass', detail: 'Node.js runtime satisfies >=22.13.0' },
    { id: 'db.fts5', status: 'pass', detail: 'SQLite FTS5 available; memory index healthy' },
    { id: 'dirs.runtime', status: 'pass', detail: 'Runtime directories writable' },
    { id: 'mail.hub', status: 'pass', detail: 'Mail hub reachable at the local MCP endpoint' },
    { id: 'toolkit.ast_grep', status: 'pass', detail: 'ast-grep available on PATH' },
    { id: 'toolkit.repomix', status: 'warn', detail: 'repomix not found; pack tool will fall back' },
    { id: 'workspace.sandbox', status: 'pass', detail: 'Workspace sandbox roots configured' },
    { id: 'backup.recent', status: 'pass', detail: 'Hot backup created within the last 24h' },
  ],
};

function renderDoctor(doc, demo = false) {
  const box = $('#doctorBox');
  if (!box) return;
  const checks = doc?.checks || [];
  const passCount = doc?.pass_count ?? checks.filter((c) => c.status === 'pass').length;
  const total = doc?.total_checks ?? checks.length;
  const overall = doc?.overall || 'unknown';
  box.innerHTML = `
    <div class="doctor-check" style="grid-column:1/-1">
      <div class="doctor-head"><span class="doctor-id">system.overall</span>${badge(overall === 'pass' ? 'pass' : (overall === 'fail' ? 'fail' : 'warn'))}</div>
      <div class="doctor-detail">${passCount}/${total} 项通过${demo ? ' · Demo Preview 示例数据' : ''}</div>
    </div>
    ${checks.map((c) => `
      <div class="doctor-check">
        <div class="doctor-head"><span class="doctor-id">${esc(c.id)}</span>${badge(c.status)}</div>
        <div class="doctor-detail">${esc(c.detail || '')}</div>
      </div>`).join('')}`;
}

async function loadDoctor(force = false) {
  if (state.demo) {
    state.doctor = DEMO_DOCTOR;
    renderDoctor(DEMO_DOCTOR, true);
    state.flags.doctorLoaded = true;
    return;
  }
  if (state.flags.doctorLoaded && !force) return;
  const btn = $('#btnRefreshDoctor');
  const box = $('#doctorBox');
  if (box) box.innerHTML = '<div class="doctor-empty">正在执行 8 项系统体检…</div>';
  if (btn) { btn.disabled = true; btn.textContent = '体检中…'; }
  try {
    const doc = await apiGet('/api/doctor');
    state.doctor = doc;
    renderDoctor(doc);
    state.flags.doctorLoaded = true;
  } catch (err) {
    if (box) box.innerHTML = `<div class="form-error">体检失败：${esc(err.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新体检'; }
  }
}

async function loadHealth() {
  if (state.demo) {
    state.health = { ok: true, version: '1.1.0', pid: 'demo', uptime_s: 3 * 86400 + 4 * 3600, mail_hub: { ok: true, version: '1.4.2' }, toolkit: state.toolkit || {} };
    renderHealth();
    state.flags.healthLoaded = true;
    return;
  }
  try {
    state.health = await apiGet('/api/health');
    renderHealth();
    state.flags.healthLoaded = true;
  } catch { /* non-critical */ }
}

function renderHealth() {
  const box = $('#healthBox');
  if (!box) return;
  const h = state.health || {};
  const toolkit = (state.toolkit && Object.keys(state.toolkit).length) ? state.toolkit : (h.toolkit || {});
  const installed = Object.values(toolkit).filter((v) => v && v.installed).length;
  const items = [
    { label: 'Version', value: h.version || '—' },
    { label: 'Uptime', value: fmtUptime(h.uptime_s) },
    { label: 'PID', value: h.pid ?? '—' },
    { label: 'Mail hub', value: h.mail_hub?.ok ? `v${h.mail_hub.version || '?'}` : 'offline' },
    { label: 'Toolkit', value: `${installed} installed` },
    { label: 'Mode', value: state.demo ? 'read-only demo' : 'live' },
  ];
  box.innerHTML = items.map((it) => `<div class="health-item"><div class="health-label">${esc(it.label)}</div><div class="health-value" title="${esc(it.value)}">${esc(it.value)}</div></div>`).join('');
}

async function hotBackup() {
  if (state.demo) { toast('Demo Preview 为只读模式，热备份已禁用。', 'warn'); return; }
  const msg = $('#backupMsg');
  if (msg) { msg.className = 'backup-msg meta'; msg.textContent = '正在执行安全热备份 (VACUUM INTO)…'; }
  try {
    const res = await apiPost('/api/system/backup', {});
    if (msg) { msg.className = 'backup-msg meta ok'; msg.textContent = `热备份已生成：${res.backup_path}（${Math.round((res.size_bytes || 0) / 1024)}KB，保留最近 ${res.retained} 份）`; }
    toast('热备份完成。', 'success');
  } catch (err) {
    if (msg) { msg.className = 'backup-msg meta err'; msg.textContent = `备份失败：${err.message}`; }
    toast(`备份失败：${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Drawer                                                              */
/* ------------------------------------------------------------------ */

function openDrawer(html) {
  const content = $('#drawerContent');
  const bg = $('#drawerBg');
  if (!content || !bg) return;
  content.innerHTML = html;
  bg.classList.add('open');
  bg.setAttribute('aria-hidden', 'false');
  content.scrollTop = 0;
}

function closeDrawer() {
  const bg = $('#drawerBg');
  if (!bg) return;
  bg.classList.remove('open');
  bg.setAttribute('aria-hidden', 'true');
}

/* ------------------------------------------------------------------ */
/* Task detail                                                         */
/* ------------------------------------------------------------------ */

function demoTaskDetail(task) {
  const now = Date.now();
  return {
    task,
    events: [
      { event_type: 'task.dispatched', actor: task.member, created_at: new Date(now - 20 * 60_000).toISOString(), payload_json: JSON.stringify({ role: task.role, channel: task.channel }) },
      { event_type: `task.${task.state}`, actor: task.member, created_at: new Date(now - 6 * 60_000).toISOString(), payload_json: JSON.stringify({ state: task.state }) },
      { event_type: 'receipt.polled', actor: 'cockpit', created_at: new Date(now - 2 * 60_000).toISOString(), payload_json: '{"result":"no-new-receipt"}' },
    ],
  };
}

async function openTask(taskId) {
  try {
    let data;
    if (state.demo) {
      const task = state.tasks.find((t) => t.task_id === taskId);
      if (!task) { toast('任务不存在。', 'warn'); return; }
      data = demoTaskDetail(task);
    } else {
      data = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}`);
    }
    const t = data.task;
    if (!t) return;
    const terminal = ['completed', 'failed', 'rerouted'].includes(t.state);
    const canPoll = !terminal && t.channel !== 'desktop-native';
    const actions = (!state.demo && !terminal) ? `<div class="drawer-actions">
      ${canPoll ? `<button type="button" class="btn primary sm" data-poll-task="${esc(t.task_id)}">立即轮询回执</button>` : ''}
      <button type="button" class="btn warn sm" data-reconcile-task="${esc(t.task_id)}" data-reconcile-state="rerouted">标记已重路由</button>
      <button type="button" class="btn danger sm" data-reconcile-task="${esc(t.task_id)}" data-reconcile-state="failed">标记失败关闭</button>
    </div>` : '';
    const events = data.events || [];
    openDrawer(`
      <div class="drawer-head">
        <div>
          <div class="drawer-title">${esc(t.title)}</div>
          <div class="drawer-meta"><span>Task <code>${esc(t.task_id)}</code></span><span>Agent <code>${esc(t.member)}</code> (${esc(t.channel)})</span><span>${badge(t.state)}</span></div>
        </div>
        <button type="button" class="icon-btn" data-close-drawer="1" aria-label="Close">×</button>
      </div>
      <dl class="drawer-kv">
        <dt>项目目录</dt><dd><code>${esc(t.project_dir || '—')}</code></dd>
        <dt>角色</dt><dd>${esc(t.role || '—')}${t.meta?.routed_from ? ` · 自动路由自 <code>${esc(t.meta.routed_from)}</code>` : ''}</dd>
        <dt>回执 ID</dt><dd><code>${esc(t.external_id || '—')}</code></dd>
        <dt>Session</dt><dd><code>${esc(t.session_id || '—')}</code>${t.reply_generation ? ` · gen ${esc(t.reply_generation)}` : ''}</dd>
        <dt>批次</dt><dd>${t.batch_id ? `<code>${esc(t.batch_id)}</code>` : '—'}</dd>
        <dt>依赖</dt><dd>${(t.depends_on || []).length ? t.depends_on.map((d) => `<code>${esc(d)}</code>`).join(' ') : '—'}</dd>
        <dt>更新时间</dt><dd>${esc(fmtDate(t.updated_at))}</dd>
      </dl>
      ${actions}
      <div class="drawer-section"><h3>Prompt</h3><pre class="mono-pre">${esc(t.prompt || '—')}</pre></div>
      ${t.result_text ? `<div class="drawer-section"><h3>完整结果</h3><pre class="mono-pre">${esc(t.result_text)}</pre></div>` : ''}
      ${t.error_message ? `<div class="drawer-section"><h3>诊断 / 阻塞</h3><pre class="mono-pre">${esc((t.error_code ? `[${t.error_code}] ` : '') + t.error_message)}</pre></div>` : ''}
      <div class="drawer-section"><h3>审计事件流 (${events.length})</h3><pre class="mono-pre">${esc(events.map((e) => `${e.created_at} | ${e.event_type} | ${e.actor}${e.payload_json ? ` | ${e.payload_json}` : ''}`).join('\n') || '无事件')}</pre></div>`);
  } catch (err) {
    toast(`打开任务失败：${err.message}`, 'error');
  }
}

async function pollTask(taskId, button) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  if (button) { button.disabled = true; button.textContent = '轮询中…'; }
  try {
    await apiPost('/api/tasks/poll', { task_id: taskId, wait_sec: 0 });
    await loadOverview({ quiet: true });
    await openTask(taskId);
  } catch (err) {
    toast(`轮询失败：${err.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = '立即轮询回执'; }
  }
}

async function reconcileTask(taskId, nextState) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  try {
    await apiPost('/api/tasks/reconcile', { task_id: taskId, state: nextState, note: 'Updated from CollabHub v1.1 Workbench' });
    await loadOverview({ quiet: true });
    await openTask(taskId);
    toast('任务状态已对账更新。', 'success');
  } catch (err) {
    toast(`对账失败：${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Batch report                                                        */
/* ------------------------------------------------------------------ */

function demoBatchMarkdown(batchId) {
  const tasks = state.tasks.filter((t) => t.batch_id === batchId);
  const batch = state.batches.find((b) => b.batch_id === batchId);
  const rows = tasks.map((t) => `| \`${t.task_id}\` | ${t.state} | ${t.member} | ${t.title} |`).join('\n');
  return `# Batch report · ${batchId}

> Read-only demo fixture. No live task state was queried.

## Summary

- Total tasks: **${batch?.total ?? tasks.length}**
- Terminal: **${batch?.all_terminal ? 'yes' : 'no'}**
- Failures: **${batch?.has_failures ? 'yes' : 'no'}**

## Tasks

| Task ID | State | Agent | Title |
| --- | --- | --- | --- |
${rows}

## Notes

- All identifiers and paths in this report are synthetic.
- The production report includes full receipts, latency, and token usage.
`;
}

async function openBatchReport(batchId) {
  try {
    let markdown;
    if (state.demo) {
      markdown = demoBatchMarkdown(batchId);
    } else {
      const data = await apiGet(`/api/batches/${encodeURIComponent(batchId)}/report`);
      markdown = data.markdown || '';
    }
    state.lastBatchMd = markdown;
    openDrawer(`
      <div class="drawer-head">
        <div>
          <div class="drawer-title">批次报告 · ${esc(batchId)}</div>
          <div class="drawer-meta"><span>Markdown 导出</span>${state.demo ? '<span>Demo Preview</span>' : ''}</div>
        </div>
        <div class="panel-tools">
          <button type="button" class="btn ghost sm" data-toggle-raw="batch">原始 MD</button>
          <button type="button" class="btn primary sm" data-copy-batch="1">复制 MD</button>
          <button type="button" class="icon-btn" data-close-drawer="1" aria-label="Close">×</button>
        </div>
      </div>
      <div id="batchRich" class="md-view">${renderSafeMarkdown(markdown)}</div>
      <pre id="batchRaw" class="mono-pre" hidden style="max-height:76vh">${esc(markdown)}</pre>`);
  } catch (err) {
    toast(`导出批次报告失败：${err.message}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Agents                                                              */
/* ------------------------------------------------------------------ */

function openAgentModal() {
  const err = $('#agErr');
  if (err) err.textContent = '';
  const box = $('#discoverBox');
  if (box) box.hidden = true;
  openModal('modalAgentBg');
}

function applyAgentPreset(key) {
  const preset = AGENT_PRESETS[key];
  if (!preset) return;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set('agId', preset.id);
  set('agName', preset.name);
  set('agDriver', preset.driver);
  set('agRoles', preset.roles);
  set('agConfig', JSON.stringify(preset.config, null, 2));
  const err = $('#agErr');
  if (err) err.textContent = '';
}

async function discoverAgents() {
  const box = $('#discoverBox');
  if (!box) return;
  box.hidden = false;
  if (state.demo) {
    box.innerHTML = '<div class="meta">Demo Preview · 本机扫描已禁用（避免泄露主机信息）。真实工作台会只读扫描 Ollama / LM Studio / CLI / 环境变量。</div>';
    return;
  }
  box.innerHTML = '<div class="meta">正在只读扫描本机 Ollama / LM Studio / vLLM / CLI / 环境变量…</div>';
  try {
    const data = await apiGet('/api/agents/discover');
    state.discovered = [];
    const rows = [];
    for (const m of data.local_models || []) {
      const i = state.discovered.push(m.suggested_registration) - 1;
      rows.push(`<div class="discover-row"><span><strong>${esc(`${m.endpoint} · ${m.model}`)}</strong></span><button type="button" class="btn primary sm" data-fill-discovered="${i}">填入表单</button></div>`);
    }
    for (const c of (data.cli_agents || []).filter((x) => x.found)) {
      const i = state.discovered.push(c.suggested_registration) - 1;
      rows.push(`<div class="discover-row"><span><strong>${esc(c.name)}</strong> <span class="meta">(${esc(c.path)})</span></span><button type="button" class="btn primary sm" data-fill-discovered="${i}">填入表单</button></div>`);
    }
    for (const p of (data.cloud_env_ready || []).filter((x) => x.env_present)) {
      const i = state.discovered.push(p.suggested_registration) - 1;
      rows.push(`<div class="discover-row"><span><strong>${esc(p.name)}</strong> <span class="pill">${esc(p.env_var)} 已就绪</span></span><button type="button" class="btn primary sm" data-fill-discovered="${i}">填入表单</button></div>`);
    }
    const endpointSummary = (data.local_endpoints || []).map((e) => `${e.label}:${e.reachable ? `${e.model_count} 模型` : '未启动'}`).join(' · ');
    box.innerHTML = `<div class="meta" style="margin-bottom:6px">端点扫描：${esc(endpointSummary || '无')}</div>` +
      (rows.length ? rows.join('') : '<div class="meta">暂未检测到运行中的本地模型或外部 CLI；可直接使用上方快捷模板。</div>');
  } catch (err) {
    box.innerHTML = `<div class="form-error">扫描失败：${esc(err.message)}</div>`;
  }
}

async function saveAgent() {
  const err = $('#agErr');
  if (err) err.textContent = '';
  let config;
  try {
    config = JSON.parse($('#agConfig')?.value || '{}');
  } catch {
    if (err) err.textContent = '驱动配置不是合法 JSON。';
    return;
  }
  try {
    await apiPost('/api/agents/register', {
      agent_id: $('#agId')?.value.trim(),
      name: $('#agName')?.value.trim(),
      driver: $('#agDriver')?.value,
      roles: ($('#agRoles')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
      config,
    });
    closeModal('modalAgentBg');
    toast('Agent 已注册。', 'success');
    await loadOverview({ quiet: true });
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

async function testAgent(agentId, button) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  const original = button?.textContent || '测试连通';
  if (button) { button.disabled = true; button.textContent = '测试中…'; }
  try {
    const res = await apiPost('/api/agents/test', { agent_id: agentId });
    const st = res.result?.state || 'unknown';
    toast(`Agent ${agentId} 连通性：${stateLabel[st] || st}`, st === 'offline' ? 'error' : 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(`测试失败：${err.message}`, 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function removeAgent(agentId) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  try {
    await apiPost('/api/agents/remove', { agent_id: agentId });
    toast('Agent 已移除。', 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(`移除失败：${err.message}`, 'error');
  }
}

async function clearCooldown(member) {
  if (state.demo) { toast('Demo Preview 为只读模式。', 'warn'); return; }
  try {
    await apiPost('/api/cooldown/clear', { member });
    toast('冷却已解除。', 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(`解除冷却失败：${err.message}`, 'error');
  }
}

async function probeAll() {
  if (state.demo) { toast('Demo Preview · 探活已禁用（不会访问本机端点）。', 'warn'); return; }
  const dot = $('#sideProbeDot');
  if (dot) dot.className = 'side-action-dot busy';
  const updated = $('#updatedAt');
  if (updated) updated.textContent = '探活中…';
  try {
    const res = await apiPost('/api/probe', {});
    if (res.throttled) toast(`探活已节流，${res.retry_after_s}s 后可重试。`, 'warn');
    else toast('Agent 探活完成。', 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(`探活失败：${err.message}`, 'error');
  } finally {
    if (dot) dot.className = 'side-action-dot ok';
  }
}

/* ------------------------------------------------------------------ */
/* Dispatch + recipes + workspaces                                     */
/* ------------------------------------------------------------------ */

function renderRecipeSelect() {
  const sel = $('#dpRecipe');
  if (!sel) return;
  sel.innerHTML = '<option value="">-- 手动编写 Prompt --</option>' + state.recipes.map((r) => (
    `<option value="${esc(r.recipe_id)}">${esc(`${r.title} [${r.role}]`)}</option>`
  )).join('');
}

function renderDispatchMembers() {
  const sel = $('#dpMember');
  if (!sel) return;
  const eligible = state.members.filter((m) => AGENT_DRIVERS.includes(m.driver));
  sel.innerHTML = '<option value="auto">✨ auto（按在线状态 + 历史成功率自动路由）</option>' + eligible.map((m) => (
    `<option value="${esc(m.member)}">${esc(m.name || m.member)} (${esc(m.channel)} · ${esc(stateLabel[m.state] || m.state)})</option>`
  )).join('');
}

function openDispatchModal() {
  const err = $('#dpErr');
  if (err) err.textContent = '';
  renderRecipeSelect();
  renderDispatchMembers();
  openModal('modalDispatchBg');
}

function applyRecipe(recipeId) {
  const recipe = state.recipes.find((r) => r.recipe_id === recipeId);
  if (!recipe) return;
  const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
  set('dpRole', recipe.role || 'researcher');
  set('dpTitle', recipe.title || '');
  set('dpPrompt', recipe.prompt || '');
}

async function submitDispatch() {
  const err = $('#dpErr');
  if (err) err.textContent = '';
  try {
    const res = await apiPost('/api/tasks/dispatch', {
      member: $('#dpMember')?.value,
      role: $('#dpRole')?.value,
      project_dir: $('#dpDir')?.value.trim(),
      title: $('#dpTitle')?.value.trim(),
      prompt: $('#dpPrompt')?.value.trim(),
      auto_fallback: $('#dpFallback')?.checked,
    });
    closeModal('modalDispatchBg');
    toast('任务已派发。', 'success');
    await loadOverview({ quiet: true });
    if (res.task?.task_id) await openTask(res.task.task_id);
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

async function loadWorkspacesAndRecipes() {
  if (state.demo) {
    state.recipes = DEMO_RECIPES;
    renderRecipeSelect();
    const defaults = {
      dagDir: DEMO_DIR, pbDir: DEMO_DIR, tkAstDir: DEMO_DIR, tkPackDir: DEMO_DIR, tkBdDir: DEMO_DIR, dpDir: DEMO_DIR, tkDocPath: `${DEMO_DIR}/README.md`,
    };
    for (const [id, value] of Object.entries(defaults)) {
      const el = document.getElementById(id);
      if (el && !el.value) el.value = value;
    }
    return;
  }
  try {
    const [ws, recipes] = await Promise.all([
      apiGet('/api/workspaces').catch(() => ({ projects: [] })),
      apiGet('/api/recipes').catch(() => ({ recipes: [] })),
    ]);
    const datalist = $('#wsProjects');
    const projects = ws.projects || [];
    if (datalist) {
      datalist.innerHTML = projects.map((p) => `<option value="${esc(p.path)}">${esc(p.name + (p.is_git ? ' (git)' : ''))}</option>`).join('');
    }
    const defaultProject = projects[0]?.path || '';
    if (defaultProject) {
      for (const id of ['dpDir', 'dagDir', 'pbDir', 'tkAstDir', 'tkPackDir', 'tkBdDir']) {
        const el = document.getElementById(id);
        if (el && !el.value) el.value = defaultProject;
      }
      const docEl = $('#tkDocPath');
      if (docEl && !docEl.value) docEl.value = `${defaultProject.replace(/[\\/]+$/, '')}${defaultProject.includes('\\') ? '\\' : '/'}README.md`;
    }
    state.recipes = recipes.recipes || [];
    renderRecipeSelect();
  } catch (err) {
    toast(`加载工作区 / 配方失败：${err.message}`, 'warn');
  }
}

/* ------------------------------------------------------------------ */
/* Memory modal                                                        */
/* ------------------------------------------------------------------ */

function openMemoryModal() {
  const err = $('#mmErr');
  if (err) err.textContent = '';
  openModal('modalMemoryBg');
}

async function saveMemoryNote() {
  const err = $('#mmErr');
  if (err) err.textContent = '';
  try {
    await apiPost('/api/memory/write', {
      project: $('#mmProject')?.value.trim(),
      title: $('#mmTitle')?.value.trim(),
      tags: ($('#mmTags')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
      content: $('#mmContent')?.value.trim(),
      author: 'cockpit',
    });
    const title = $('#mmTitle');
    const content = $('#mmContent');
    if (title) title.value = '';
    if (content) content.value = '';
    closeModal('modalMemoryBg');
    toast('共享记忆已写入。', 'success');
    await loadOverview({ quiet: true });
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

/* ------------------------------------------------------------------ */
/* Modals                                                              */
/* ------------------------------------------------------------------ */

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');
  const focusable = el.querySelector('input, select, textarea, button');
  setTimeout(() => focusable?.focus({ preventScroll: true }), 60);
}

function closeModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

/* ------------------------------------------------------------------ */
/* SSE                                                                 */
/* ------------------------------------------------------------------ */

function setSsePill(text, cls) {
  const pill = $('#ssePill');
  if (!pill) return;
  pill.textContent = text;
  pill.classList.remove('ok', 'warn', 'off');
  if (cls) pill.classList.add(cls);
}

function scheduleOverviewReload() {
  clearTimeout(state.timers.reload);
  state.timers.reload = setTimeout(() => {
    loadOverview({ quiet: true });
    if (state.view === 'ops') loadEvents({ quiet: true });
  }, 450);
}

function connectSse() {
  if (state.demo) { setSsePill('Demo · static', 'demo'); return; }
  try {
    const es = new EventSource('/api/events/stream');
    state.timers.sse = es;
    es.onopen = () => setSsePill('● 实时 SSE', 'ok');
    es.onmessage = () => scheduleOverviewReload();
    es.onerror = () => setSsePill('○ 轮询模式', 'warn');
  } catch {
    setSsePill('○ 轮询模式', 'warn');
  }
}

/* ------------------------------------------------------------------ */
/* Global interactions                                                 */
/* ------------------------------------------------------------------ */

function handleOverlayClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (target.classList.contains('drawer-backdrop')) { closeDrawer(); return; }
  const closeDrawerBtn = target.closest('[data-close-drawer]');
  if (closeDrawerBtn) { closeDrawer(); return; }
  if (target.classList.contains('palette-backdrop')) { closePalette(); return; }
  if (target.classList.contains('modal-backdrop')) {
    target.classList.remove('open');
    target.setAttribute('aria-hidden', 'true');
    return;
  }
  const closeModalBtn = target.closest('[data-close-modal]');
  if (closeModalBtn) { closeModal(closeModalBtn.getAttribute('data-close-modal')); return; }
  if (target.closest('[data-palette-index]')) {
    runPaletteIndex(Number(target.closest('[data-palette-index]').getAttribute('data-palette-index')));
    return;
  }
}

async function handleActionClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const closest = (sel) => target.closest(sel);

  const goto = closest('[data-goto-view]');
  if (goto) { setView(goto.getAttribute('data-goto-view')); return; }

  const action = closest('[data-action]');
  if (action) {
    const name = action.getAttribute('data-action');
    if (name === 'probe') return probeAll();
    if (name === 'agent') return openAgentModal();
    if (name === 'memory') return openMemoryModal();
    if (name === 'events') { setView('ops'); return loadEvents(true); }
    if (name === 'theme') return toggleTheme();
    return;
  }

  const preset = closest('[data-agent-preset]');
  if (preset) { applyAgentPreset(preset.getAttribute('data-agent-preset')); return; }

  const fill = closest('[data-fill-discovered]');
  if (fill) {
    const p = state.discovered[Number(fill.getAttribute('data-fill-discovered'))];
    if (p) {
      const set = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
      set('agId', p.agent_id);
      set('agName', p.name);
      set('agDriver', p.driver);
      set('agRoles', (p.roles || []).join(','));
      set('agConfig', JSON.stringify(p.config || {}, null, 2));
    }
    return;
  }

  const tkTab = closest('[data-tk-tab]');
  if (tkTab) { openToolkitTab(tkTab.getAttribute('data-tk-tab')); return; }
  const openTk = closest('[data-open-tk-tab]');
  if (openTk) { openToolkitTab(openTk.getAttribute('data-open-tk-tab')); return; }
  if (closest('[data-focus-cass]')) { setView('toolkit'); setTimeout(() => $('#sessQuery')?.focus(), 80); return; }

  const playbook = closest('[data-playbook]');
  if (playbook) { selectPlaybook(playbook.getAttribute('data-playbook')); return; }

  const dagTpl = closest('[data-dag-tpl]');
  if (dagTpl) {
    state.dagSteps = dagTemplates(dagTpl.getAttribute('data-dag-tpl'));
    state.selectedDag = null;
    renderDagSteps();
    renderDagCanvas();
    return;
  }
  const delDag = closest('[data-del-dag]');
  if (delDag) { removeDagStep(delDag.getAttribute('data-del-dag')); return; }
  const dagNode = closest('[data-dag-node]');
  if (dagNode) { focusDagStep(Number(dagNode.getAttribute('data-dag-node'))); return; }

  const openTaskEl = closest('[data-open-task]');
  if (openTaskEl) { openTask(openTaskEl.getAttribute('data-open-task')); return; }
  const pollEl = closest('[data-poll-task]');
  if (pollEl) { pollTask(pollEl.getAttribute('data-poll-task'), pollEl); return; }
  const reconcileEl = closest('[data-reconcile-task]');
  if (reconcileEl) { reconcileTask(reconcileEl.getAttribute('data-reconcile-task'), reconcileEl.getAttribute('data-reconcile-state')); return; }

  const batchEl = closest('[data-open-batch]');
  if (batchEl) { openBatchReport(batchEl.getAttribute('data-open-batch')); return; }
  const copyBatch = closest('[data-copy-batch]');
  if (copyBatch) {
    try { await navigator.clipboard.writeText(state.lastBatchMd); copyBatch.textContent = '已复制'; setTimeout(() => { copyBatch.textContent = '复制 MD'; }, 1600); } catch { toast('复制失败：浏览器未授予剪贴板权限。', 'warn'); }
    return;
  }
  const noteEl = closest('[data-open-note-slug]');
  if (noteEl) { openNote(noteEl.getAttribute('data-open-note-project'), noteEl.getAttribute('data-open-note-slug')); return; }

  const wtReview = closest('[data-wt-review]');
  if (wtReview) { openWorktreeReview(wtReview.getAttribute('data-wt-review')); return; }
  const wtVerify = closest('[data-wt-verify]');
  if (wtVerify) { verifyWorktree(wtVerify.getAttribute('data-wt-verify'), wtVerify); return; }
  const wtMerge = closest('[data-wt-merge]');
  if (wtMerge) { mergeWorktree(wtMerge.getAttribute('data-wt-merge')); return; }
  const wtCleanup = closest('[data-wt-cleanup]');
  if (wtCleanup) { cleanupWorktree(wtCleanup.getAttribute('data-wt-cleanup')); return; }

  const testBtn = closest('[data-test-agent]');
  if (testBtn) { testAgent(testBtn.getAttribute('data-test-agent'), testBtn); return; }
  const removeBtn = closest('[data-remove-agent]');
  if (removeBtn) { removeAgent(removeBtn.getAttribute('data-remove-agent')); return; }
  const cooldownBtn = closest('[data-clear-cooldown]');
  if (cooldownBtn) { clearCooldown(cooldownBtn.getAttribute('data-clear-cooldown')); return; }

  const rawToggle = closest('[data-toggle-raw]');
  if (rawToggle) {
    const prefix = rawToggle.getAttribute('data-toggle-raw');
    const rich = document.getElementById(`${prefix}Rich`);
    const raw = document.getElementById(`${prefix}Raw`);
    if (!rich || !raw) return;
    const showingRaw = !raw.hidden;
    raw.hidden = showingRaw;
    rich.hidden = !showingRaw;
    rawToggle.textContent = showingRaw ? '原始 MD' : '富文本预览';
    return;
  }
}

function bindStaticEvents() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));

  $('#btnMobileNav')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));
  $('#btnTheme')?.addEventListener('click', toggleTheme);
  $('#btnPalette')?.addEventListener('click', openPalette);
  $('#btnOpenDispatch')?.addEventListener('click', openDispatchModal);
  $('#btnOpenAgent')?.addEventListener('click', openAgentModal);
  $('#btnOpenMemory')?.addEventListener('click', openMemoryModal);
  $('#btnProbe')?.addEventListener('click', probeAll);
  $('#mailPill')?.addEventListener('click', () => {
    if (!state.mail?.ok) { toast('Mail hub 未连接。', 'warn'); return; }
    if (state.demo) { toast('Demo Preview · Mail hub 未接入。', 'info'); return; }
    if (state.mail.url) window.open(state.mail.url, '_blank', 'noopener');
  });

  $('#filterText')?.addEventListener('input', renderTasks);
  $('#filterAgent')?.addEventListener('change', renderTasks);
  $('#filterState')?.addEventListener('change', renderTasks);
  $('#btnResetFilters')?.addEventListener('click', () => {
    const f = $('#filterText'); if (f) f.value = '';
    const a = $('#filterAgent'); if (a) a.value = '';
    const s = $('#filterState'); if (s) s.value = '';
    renderTasks();
  });
  $('#btnViewTable')?.addEventListener('click', () => setTaskView('table'));
  $('#btnViewKanban')?.addEventListener('click', () => setTaskView('kanban'));

  $('#btnAddDagStep')?.addEventListener('click', addDagStep);
  $('#btnRunDag')?.addEventListener('click', runDag);
  $('#dagStepsList')?.addEventListener('input', () => {
    syncDagFromDom();
    clearTimeout(state.timers.dag);
    state.timers.dag = setTimeout(renderDagCanvas, 90);
  });
  $('#dagStepsList')?.addEventListener('change', () => {
    syncDagFromDom();
    clearTimeout(state.timers.dag);
    state.timers.dag = setTimeout(renderDagCanvas, 90);
  });
  $('#dagCanvas')?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const node = event.target.closest?.('[data-dag-node]');
    if (node) { event.preventDefault(); focusDagStep(Number(node.getAttribute('data-dag-node'))); }
  });

  $('#btnRunPlaybook')?.addEventListener('click', runPlaybook);

  $('#btnRunAst')?.addEventListener('click', () => runToolkit('ast'));
  $('#btnRunPack')?.addEventListener('click', () => runToolkit('pack'));
  $('#btnRunDoc')?.addEventListener('click', () => runToolkit('doc'));
  $('#btnRunBeads')?.addEventListener('click', () => runToolkit('beads'));
  $('#btnCopyTk')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.lastToolkitCopy); toast('输出已复制。', 'success', 2000); }
    catch { toast('复制失败：浏览器未授予剪贴板权限。', 'warn'); }
  });

  $('#btnMemSearch')?.addEventListener('click', searchMemory);
  $('#memQuery')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchMemory(); });
  $('#btnSessSearch')?.addEventListener('click', searchSessions);
  $('#sessQuery')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') searchSessions(); });
  $('#btnReindexCass')?.addEventListener('click', reindexCass);

  $('#btnRefreshDoctor')?.addEventListener('click', () => loadDoctor(true));
  $('#btnRefreshEvents')?.addEventListener('click', () => loadEvents(true));
  $('#btnHotBackup')?.addEventListener('click', hotBackup);

  $('#btnDiscoverAgents')?.addEventListener('click', discoverAgents);
  $('#btnSaveAgent')?.addEventListener('click', saveAgent);
  $('#agDriver')?.addEventListener('change', (event) => {
    const presets = {
      'openai-http': '{"base_url":"http://127.0.0.1:11434/v1","model":"qwen2.5-coder:14b","api_key_env":""}',
      'generic-cli': '{"command":"gemini","args":["-p","{{prompt}}"],"prompt_mode":"arg","timeout_s":120}',
      'desktop-native': '{}',
    };
    const el = $('#agConfig');
    if (el) el.value = presets[event.target.value] || '{}';
  });

  $('#dpRecipe')?.addEventListener('change', (event) => applyRecipe(event.target.value));
  $('#btnSubmitDispatch')?.addEventListener('click', submitDispatch);
  $('#btnSaveMemory')?.addEventListener('click', saveMemoryNote);

  $('#btnPalette')?.addEventListener('keydown', (event) => { if (event.key === 'Enter') openPalette(); });
  $('#paletteInput')?.addEventListener('input', (event) => { state.palette.index = 0; buildPalette(event.target.value); });
  $('#paletteList')?.addEventListener('mousemove', (event) => {
    const item = event.target.closest?.('[data-palette-index]');
    if (!item) return;
    const i = Number(item.getAttribute('data-palette-index'));
    if (i === state.palette.index) return;
    state.palette.index = i;
    $$('#paletteList .palette-item').forEach((el, idx) => el.classList.toggle('active', idx === i));
  });

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (window.innerWidth <= 840
      && $('#sidebar')?.classList.contains('open')
      && target instanceof Element
      && !target.closest('#sidebar')
      && !target.closest('#btnMobileNav')) {
      closeMobileNav();
    }
    handleOverlayClick(event);
    if (event.defaultPrevented) return;
    handleActionClick(event).catch((err) => toast(String(err?.message || err), 'error'));
  });

  document.addEventListener('keydown', (event) => {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if ($('#paletteBg')?.classList.contains('open')) closePalette();
      else openPalette();
      return;
    }
    const paletteOpen = $('#paletteBg')?.classList.contains('open');
    if (paletteOpen) {
      if (event.key === 'Escape') { event.preventDefault(); closePalette(); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); movePalette(1); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); movePalette(-1); return; }
      if (event.key === 'Enter') { event.preventDefault(); runPaletteIndex(state.palette.index); return; }
    }
    if (event.key === 'Escape') {
      if (paletteOpen) return;
      if ($('#drawerBg')?.classList.contains('open')) { closeDrawer(); return; }
      const modal = $('.modal-backdrop.open');
      if (modal) { closeModal(modal.id); return; }
      closeMobileNav();
    }
  });

  window.addEventListener('hashchange', () => setView(viewFromHash(), { silent: true }));
  window.addEventListener('resize', () => { if (window.innerWidth > 840) closeMobileNav(); });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function boot() {
  initTheme();
  state.dagSteps = defaultDagSteps();
  renderDagSteps();
  renderDagCanvas();
  bindStaticEvents();
  setView(viewFromHash(), { silent: true });
  if (/Mac|iPhone|iPad/.test(navigator.platform || '')) {
    const kbd = $('#paletteKbd');
    if (kbd) kbd.textContent = '⌘K';
  }
  if (state.demo) {
    const pill = $('#demoPill');
    if (pill) pill.hidden = false;
    document.title = 'CollabHub v1.1 · Demo Preview';
    $('#btnHotBackup')?.setAttribute('disabled', 'disabled');
  }
  loadWorkspacesAndRecipes();
  loadOverview();
  connectSse();
  if (!state.demo) {
    state.timers.poll = setInterval(() => {
      loadOverview({ quiet: true });
      if (state.view === 'ops') loadEvents({ quiet: true });
    }, 15000);
  } else {
    setSsePill('Demo · static', 'demo');
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();
