import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  DASHBOARD_HOST, DASHBOARD_PORT, DB_PATH, MAIL_BASE_URL,
  assertValidAgentId, assertValidTaskId, ensureRuntimeDirs,
} from './config.mjs';
import { clearMemberCooldown, getMemberStatuses, isRegisteredAgent, openHubDb, parseTaskRow, upsertMemberStatus } from './db.mjs';
import { discoverLocalAgents } from './discovery.mjs';
import { createHotBackup, listWorkspaceProjects, runSystemDoctor } from './doctor.mjs';
import { hubBus } from './event-bus.mjs';
import { dispatchBackgroundTask, pollBackgroundTask, reconcileTask } from './executors.mjs';
import { releaseMailPaths } from './mail-sync.mjs';
import { listMemoryNotes, searchMemoryNotes, writeMemoryNote } from './memory.mjs';
import { runPlaybook } from './playbooks.mjs';
import { probeAllMembers, probeMailHub } from './prober.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from './recipes.mjs';
import { getAgent, probeCustomAgent, registerAgent, removeAgent } from './registry.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';
import {
  convertDocToMd, getCassStats, getToolkitStatus, packRepoRepomix,
  reindexSessionsCass, runBeads, searchAstGrep, searchSessionsCass,
} from './toolkit.mjs';
import { buildBatchMarkdownReport, runDagWorkflow } from './workflows.mjs';
import { cleanupWorktree, listWorktrees, mergeWorktree, reviewWorktree, verifyWorktree } from './worktree.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const PROBE_MIN_INTERVAL_MS = 15000;
const CASS_STATS_TTL_MS = 60000;
const AUTO_POLL_INTERVAL_MS = 30000;
const CASS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const MAX_SSE_CLIENTS = 20;
const TERMINAL_STATES = new Set(['completed', 'failed', 'rerouted']);

function buildBatchSummaries(tasks) {
  const byBatch = new Map();
  for (const t of tasks) {
    if (!t.batch_id) continue;
    if (!byBatch.has(t.batch_id)) byBatch.set(t.batch_id, []);
    byBatch.get(t.batch_id).push(t);
  }
  const out = [];
  for (const [batch_id, list] of byBatch.entries()) {
    const counts = {};
    for (const t of list) counts[t.state] = (counts[t.state] || 0) + 1;
    out.push({
      batch_id,
      total: list.length,
      counts,
      all_terminal: list.every((t) => TERMINAL_STATES.has(t.state)),
      all_succeeded: list.every((t) => t.state === 'completed'),
      has_stalled: list.some((t) => t.state === 'stalled' || t.state === 'uncertain'),
      has_failures: list.some((t) => ['failed', 'stalled', 'uncertain', 'needs_input'].includes(t.state)),
      latest_at: list[0]?.updated_at || null,
    });
  }
  return out.slice(0, 10);
}

function buildMetrics(members, tasks, worktrees, notesCount, cassStats) {
  const readyAgents = members.filter((m) => ['online', 'idle'].includes(m.state)).length;
  const completed = tasks.filter((t) => t.state === 'completed').length;
  const failed = tasks.filter((t) => t.state === 'failed').length;
  const active = tasks.filter((t) => ['running', 'dispatching', 'dispatched'].includes(t.state)).length;
  const stalled = tasks.filter((t) => ['stalled', 'uncertain', 'needs_input'].includes(t.state)).length;
  const activeWorktrees = worktrees.filter((w) => w.state === 'active').length;
  return {
    agents_ready: readyAgents,
    agents_total: members.length,
    tasks_total: tasks.length,
    tasks_completed: completed,
    tasks_active: active,
    tasks_stalled: stalled,
    tasks_failed: failed,
    active_worktrees: activeWorktrees,
    memory_notes: notesCount,
    cass_conversations: cassStats?.stats?.conversations ?? null,
    cass_messages: cassStats?.stats?.messages ?? null,
  };
}

const DASHBOARD_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>CollabHub v1.0 · Local-First Multi-Agent Workbench</title>
<style>
  :root {
    --bg: #0b1020; --panel: #131a2e; --panel-2: #19223a; --border: #263354;
    --text: #e6edf7; --muted: #94a3b8; --accent: #38bdf8;
    --green: #22c55e; --amber: #f59e0b; --red: #ef4444; --slate: #64748b;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif; background: var(--bg); color: var(--text); }
  header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; padding: 10px 20px; border-bottom: 1px solid var(--border); background: #0f1629; position: sticky; top: 0; z-index: 10; }
  header h1 { margin: 0; font-size: 16px; font-weight: 600; display: flex; align-items: center; gap: 7px; white-space: nowrap; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--border); background: var(--panel-2); color: var(--muted); white-space: nowrap; }
  .pill-btn { cursor: pointer; transition: border-color .15s, color .15s; }
  .pill-btn:hover { border-color: var(--accent) !important; color: #fff; }
  .actions { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  button, a.btn { background: var(--panel-2); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 5px 10px; font-size: 12.5px; cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; flex-shrink: 0; }
  button:hover, a.btn:hover { border-color: var(--accent); color: #fff; }
  button.primary { background: #0284c7; border-color: #0ea5e9; }
  button.success { background: #15803d; border-color: #22c55e; }
  button.warn { background: rgba(245,158,11,.15); border-color: rgba(245,158,11,.5); color: #fcd34d; }
  button.danger { background: rgba(239,68,68,.15); border-color: rgba(239,68,68,.5); color: #fca5a5; }
  button.sm { padding: 4px 8px; font-size: 12px; }
  main { max-width: 1440px; margin: 0 auto; padding: 14px 20px 48px; display: grid; gap: 13px; }
  .alert-banner { display: none; background: rgba(245,158,11,.12); border: 1px solid rgba(245,158,11,.45); border-radius: 12px; padding: 10px 15px; color: #fde68a; font-size: 13px; }
  .alert-banner.show { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; }
  .kpi-bar { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
  .kpi { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 9px 13px; }
  .kpi-label { font-size: 11px; color: var(--muted); }
  .kpi-val { font-size: 18px; font-weight: 700; margin-top: 2px; color: #f8fafc; }
  .roster { display: grid; grid-template-columns: repeat(auto-fit, minmax(195px, 1fr)); gap: 11px; }
  .strip { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; }
  .batch-chip { background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 6px 10px; font-size: 12px; display: flex; align-items: center; gap: 7px; cursor: pointer; }
  .batch-chip:hover { border-color: var(--accent); }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 13px 15px; }
  .card-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px; gap: 6px; }
  .member-name { font-weight: 600; font-size: 14.5px; }
  .badge { font-size: 11px; padding: 2px 7px; border-radius: 999px; font-weight: 600; white-space: nowrap; display: inline-block; }
  .st-online, .st-completed, .st-pass { background: rgba(34,197,94,.16); color: #4ade80; border: 1px solid rgba(34,197,94,.35); }
  .st-idle, .st-running, .st-dispatched, .st-dispatching { background: rgba(56,189,248,.16); color: #38bdf8; border: 1px solid rgba(56,189,248,.35); }
  .st-cooldown, .st-needs_input, .st-uncertain, .st-stale, .st-stalled, .st-warn { background: rgba(245,158,11,.16); color: #fbbf24; border: 1px solid rgba(245,158,11,.35); }
  .st-offline, .st-failed, .st-fail { background: rgba(239,68,68,.16); color: #f87171; border: 1px solid rgba(239,68,68,.35); }
  .st-dormant, .st-unknown, .st-created, .st-rerouted { background: rgba(148,163,184,.16); color: #cbd5e1; border: 1px solid rgba(148,163,184,.35); }
  .meta { font-size: 12px; color: var(--muted); line-height: 1.5; word-break: break-word; }
  .tele-row { font-size: 11px; color: #7dd3fc; margin-top: 4px; }
  .section-title { display: flex; justify-content: space-between; align-items: center; margin: 0 0 10px; font-size: 14.5px; font-weight: 600; gap: 8px; }
  .grid-2 { display: grid; grid-template-columns: 1.68fr 1fr; gap: 14px; }
  @media (max-width: 980px) { .grid-2 { grid-template-columns: 1fr; } }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th, td { text-align: left; padding: 8px 9px; border-bottom: 1px solid var(--border); vertical-align: top; }
  th { color: var(--muted); font-weight: 500; font-size: 12px; }
  tr.clickable { cursor: pointer; }
  tr.clickable:hover td { background: rgba(56,189,248,.06); }
  code { font-family: Consolas, ui-monospace, monospace; font-size: 11.5px; background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 4px; }
  .task-id-code { display: inline-block; max-width: 240px; overflow: hidden; text-overflow: ellipsis; vertical-align: bottom; white-space: nowrap; }
  .search-row { display: flex; gap: 7px; margin-bottom: 10px; align-items: center; }
  .filter-bar { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 10px; }
  .filter-bar input, .filter-bar select { width: auto; flex: 1; min-width: 115px; }
  input[type=text], select, textarea { width: 100%; background: var(--panel-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 6px 9px; font-size: 13px; font-family: inherit; }
  textarea { min-height: 82px; resize: vertical; }
  label { display: block; font-size: 12px; color: var(--muted); margin: 7px 0 3px; }
  .note-item { padding: 9px 10px; border: 1px solid var(--border); border-radius: 8px; margin-bottom: 8px; background: var(--panel-2); }
  .dag-step-card { padding: 10px; border: 1px solid var(--border); border-radius: 9px; margin-bottom: 8px; background: #11192e; }
  .dag-row { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 7px; }
  .kanban { display: grid; grid-template-columns: repeat(4, minmax(175px, 1fr)); gap: 10px; }
  @media (max-width: 900px) { .kanban { grid-template-columns: repeat(2, 1fr); } }
  .kb-col { background: #0e1528; border: 1px solid var(--border); border-radius: 10px; padding: 9px; min-height: 220px; }
  .kb-head { display: flex; justify-content: space-between; align-items: center; font-size: 12px; font-weight: 600; color: var(--muted); margin-bottom: 8px; padding-bottom: 6px; border-bottom: 1px solid var(--border); }
  .kb-card { background: var(--panel-2); border: 1px solid var(--border); border-radius: 8px; padding: 8px 9px; margin-bottom: 7px; cursor: pointer; }
  .kb-card:hover { border-color: var(--accent); }
  .empty { color: var(--muted); font-size: 13px; padding: 12px 0; text-align: center; }
  .drawer-backdrop { display: none; position: fixed; inset: 0; background: rgba(2,6,23,.72); z-index: 40; justify-content: flex-end; }
  .drawer-backdrop.open { display: flex; }
  .drawer { width: min(760px, 95vw); height: 100%; background: #0f172a; border-left: 1px solid var(--border); padding: 18px 22px; overflow-y: auto; }
  .modal-backdrop { display: none; position: fixed; inset: 0; background: rgba(2,6,23,.74); z-index: 50; align-items: center; justify-content: center; padding: 16px; }
  .modal-backdrop.open { display: flex; }
  .modal { width: min(650px, 96vw); background: #0f172a; border: 1px solid var(--border); border-radius: 14px; padding: 18px 20px; max-height: 92vh; overflow-y: auto; }
  .tabs { display: flex; gap: 6px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab-btn.active { background: #0284c7; border-color: #38bdf8; color: #fff; }
  .tab-pane { display: none; }
  .tab-pane.active { display: block; }
  .mono-pre { white-space: pre-wrap; word-break: break-word; font-family: Consolas, monospace; font-size: 12px; background: #070b16; padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border); max-height: 320px; overflow: auto; margin-top: 6px; }
  .md-view { font-size: 13.5px; line-height: 1.65; background: #091022; padding: 14px 16px; border-radius: 10px; border: 1px solid var(--border); margin-top: 8px; }
  .md-view h1 { font-size: 18px; margin: 8px 0; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .md-view h2 { font-size: 15.5px; margin: 14px 0 6px; color: #7dd3fc; }
  .md-view h3 { font-size: 14px; margin: 12px 0 4px; color: #e2e8f0; }
  .md-view ul { margin: 6px 0; padding-left: 20px; }
  .md-view blockquote { margin: 8px 0; padding: 6px 12px; border-left: 3px solid var(--amber); background: rgba(245,158,11,.08); border-radius: 4px; }
  .md-view table { margin: 8px 0; font-size: 12px; }
  .err-msg { color: #f87171; font-size: 12px; margin-top: 8px; }
</style>
</head>
<body>
<datalist id="wsProjects"></datalist>
<header>
  <h1>CollabHub v1.0 <span id="mailPill" class="pill">Mail 检测中</span> <span id="ssePill" class="pill">SSE 连接中</span></h1>
  <div class="actions">
    <button class="success" id="btnOpenDispatch">+ 派发</button>
    <button id="btnOpenDag">🔀 DAG 编排</button>
    <button id="btnOpenPlaybook">▶ Playbook</button>
    <button id="btnOpenToolkit">🧰 工具箱</button>
    <button id="btnOpenAgent">+ 扩展 Agent</button>
    <button id="btnOpenEvents">📡 事件流</button>
    <button id="btnOpenDoctor">🩺 体检</button>
    <button class="primary" id="btnProbe">探活</button>
    <a class="btn" href="${MAIL_BASE_URL}/mail" target="_blank" rel="noopener">Mail ↗</a>
    <span id="updatedAt" class="pill">同步中</span>
  </div>
</header>
<main>
  <section id="alertBanner" class="alert-banner"></section>
  <section id="kpiBar" class="kpi-bar"></section>
  <section class="strip" id="toolkitStrip"></section>
  <section class="roster" id="roster"></section>
  <section id="batchStrip" class="strip"></section>

  <section class="grid-2">
    <div class="card">
      <div class="section-title">
        <span>协作任务与真实回执账本（点击查看详情 / 轮询 / 对账）</span>
        <div style="display:flex;gap:6px;align-items:center">
          <button class="sm primary" id="btnViewTable">📋 账本</button>
          <button class="sm" id="btnViewKanban">🗂️ 看板</button>
          <span class="pill" id="taskCount">0 条</span>
        </div>
      </div>
      <div class="filter-bar">
        <input type="text" id="filterText" placeholder="筛选任务标题 / ID / 内容..." />
        <select id="filterAgent"><option value="">全部 Agent</option></select>
        <select id="filterState">
          <option value="">全部状态</option>
          <option value="running">执行中</option>
          <option value="stalled">疑似卡住</option>
          <option value="uncertain">待核验</option>
          <option value="completed">已完成</option>
          <option value="failed">失败</option>
          <option value="rerouted">已重路由</option>
        </select>
      </div>
      <div id="tasksTableWrap" style="overflow-x:auto">
        <table>
          <thead><tr><th>任务 / 角色</th><th>Agent · 通道</th><th>状态</th><th>回执 ID</th><th>摘要 / 更新时间</th></tr></thead>
          <tbody id="tasksBody"></tbody>
        </table>
      </div>
      <div id="tasksKanbanWrap" class="kanban" style="display:none"></div>
    </div>

    <div style="display:grid; gap:13px; align-content:start;">
      <div class="card">
        <div class="section-title">
          <span>跨端历史会话秒搜 (cass)</span>
          <button id="btnReindexCass" class="sm">更新索引</button>
        </div>
        <div class="search-row">
          <input type="text" id="sessQuery" placeholder="搜 Codex / Claude / AGY 历史踩坑..." />
          <button id="btnSessSearch">检索</button>
        </div>
        <div id="sessList" class="meta">输入关键词检索本机跨 Agent 历史会话（只读落盘 D 盘）</div>
      </div>

      <div class="card">
        <div class="section-title">
          <span>并发 Git Worktree 隔离</span>
          <span class="pill" id="wtCount">0</span>
        </div>
        <div id="wtList"></div>
      </div>

      <div class="card">
        <div class="section-title">
          <span>跨成员共享项目记忆 (FTS5)</span>
          <button id="btnOpenMemory" class="sm">+ 记笔记</button>
        </div>
        <div class="search-row">
          <input type="text" id="memQuery" placeholder="支持中文/英文关键词检索..." />
          <button id="btnMemSearch">检索</button>
        </div>
        <div id="memList"></div>
      </div>
    </div>
  </section>
</main>

<div id="drawerBg" class="drawer-backdrop"><div class="drawer" id="drawerContent"></div></div>

<div id="modalAgentBg" class="modal-backdrop">
  <div class="modal">
    <div class="section-title"><span>动态扩展新 Agent（支持自动扫描本机模型 / CLI / Desktop）</span><button data-close-modal="modalAgentBg">关闭</button></div>
    <div class="strip" style="margin-bottom:8px">
      <button type="button" class="primary sm" id="btnDiscoverAgents">🔍 扫描本机 Ollama / CLI / 环境变量</button>
      <button type="button" class="sm" data-agent-preset="ollama">Ollama</button>
      <button type="button" class="sm" data-agent-preset="deepseek">DeepSeek</button>
      <button type="button" class="sm" data-agent-preset="lmstudio">LM Studio</button>
      <button type="button" class="sm" data-agent-preset="gemini">Gemini CLI</button>
      <button type="button" class="sm" data-agent-preset="aider">Aider</button>
      <button type="button" class="sm" data-agent-preset="cursor">Cursor</button>
    </div>
    <div id="discoverBox" style="display:none;margin-bottom:10px"></div>
    <label>Agent ID（小写字母/数字/短横线）</label>
    <input type="text" id="agId" placeholder="ollama-qwen" />
    <label>展示名称</label>
    <input type="text" id="agName" placeholder="Ollama Qwen2.5 Coder" />
    <label>驱动类型</label>
    <select id="agDriver">
      <option value="openai-http">openai-http（本地 Ollama / LM Studio / vLLM / 任意网关模型）</option>
      <option value="generic-cli">generic-cli（gemini / aider / opencode / qwen / 本地脚本）</option>
      <option value="desktop-native">desktop-native（Cursor / Windsurf 等桌面原生会话）</option>
    </select>
    <label>支持角色（逗号分隔）</label>
    <input type="text" id="agRoles" value="researcher,reviewer,synthesizer" />
    <label>驱动配置 JSON（openai-http 密钥只填 api_key_env 环境变量名，绝不存明文）</label>
    <textarea id="agConfig">{"base_url":"http://127.0.0.1:11434/v1","model":"qwen2.5-coder:14b","api_key_env":""}</textarea>
    <div id="agErr" class="err-msg"></div>
    <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
      <button data-close-modal="modalAgentBg">取消</button>
      <button class="primary" id="btnSaveAgent">注册并接入</button>
    </div>
  </div>
</div>

<div id="modalDispatchBg" class="modal-backdrop">
  <div class="modal">
    <div class="section-title"><span>一键派发后台任务（支持智能路由 & Prompt 配方）</span><button data-close-modal="modalDispatchBg">关闭</button></div>
    <label>套用内置 Prompt 配方（可选）</label>
    <select id="dpRecipe"><option value="">-- 手动编写 Prompt --</option></select>
    <label>执行 Agent（选 auto 将结合实时探活与历史成功率自动挑选）</label>
    <select id="dpMember"></select>
    <label>角色</label>
    <select id="dpRole">
      <option value="researcher">researcher（调研）</option>
      <option value="reviewer">reviewer（审查）</option>
      <option value="implementer">implementer（实现）</option>
      <option value="tester">tester（测试）</option>
      <option value="planner">planner（规划）</option>
      <option value="synthesizer">synthesizer（汇总）</option>
    </select>
    <label>项目目录（支持下拉选择工作区项目）</label>
    <input type="text" id="dpDir" list="wsProjects" placeholder="选择或输入项目绝对路径..." />
    <label>任务标题</label>
    <input type="text" id="dpTitle" placeholder="例如：独立审查认证模块边界条件" />
    <label>Prompt</label>
    <textarea id="dpPrompt" placeholder="明确目标、范围、产出与验收条件..."></textarea>
    <label style="display:flex;align-items:center;gap:6px;margin-top:8px;cursor:pointer">
      <input type="checkbox" id="dpFallback" checked /> 目标离线或 429 冷却时，派发前自动降级路由至其他在线后台 Agent（绝不重复发已发送任务）
    </label>
    <div id="dpErr" class="err-msg"></div>
    <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
      <button data-close-modal="modalDispatchBg">取消</button>
      <button class="success" id="btnSubmitDispatch">立即派发</button>
    </div>
  </div>
</div>

<div id="modalDagBg" class="modal-backdrop">
  <div class="modal" style="width:min(760px,96vw)">
    <div class="section-title"><span>🔀 可视化多阶段 DAG 工作流编排</span><button data-close-modal="modalDagBg">关闭</button></div>
    <div class="strip" style="margin-bottom:8px">
      <span class="meta">快速模板：</span>
      <button type="button" class="sm" data-dag-tpl="debate">正反红队 → 仲裁</button>
      <button type="button" class="sm" data-dag-tpl="pipeline">调研 → 审查 → 总结</button>
      <button type="button" class="sm primary" id="btnAddDagStep">+ 添加步骤</button>
    </div>
    <div class="dag-row">
      <div><label>工作流名称</label><input type="text" id="dagName" value="multi-stage-review" /></div>
      <div style="grid-column:span 2"><label>项目目录</label><input type="text" id="dagDir" list="wsProjects" placeholder="选择或输入项目目录..." /></div>
    </div>
    <div id="dagStepsList" style="margin-top:10px"></div>
    <div id="dagErr" class="err-msg"></div>
    <div id="dagOut" class="mono-pre" style="display:none"></div>
    <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
      <button data-close-modal="modalDagBg">关闭</button>
      <button class="success" id="btnRunDag">执行 DAG 工作流</button>
    </div>
  </div>
</div>

<div id="modalPlaybookBg" class="modal-backdrop">
  <div class="modal">
    <div class="section-title"><span>一键运行多 Agent 实用 Playbook</span><button data-close-modal="modalPlaybookBg">关闭</button></div>
    <label>选择 Playbook 流水线（4 套实战模板）</label>
    <select id="pbType">
      <option value="research-and-pack">research-and-pack（跨端历史 + 文档转MD + 仓库打包 → 自动写入共享记忆）</option>
      <option value="code-review-squad">code-review-squad（repomix + AST 打包 → 并行多 Agent 独立代码审查）</option>
      <option value="adversarial-debate">adversarial-debate（正方方案 vs 反方红队对抗审查 → 自动仲裁 DAG）</option>
      <option value="multi-agent-build">multi-agent-build（自动建隔离 Worktree + 租约 → 派发实现任务）</option>
    </select>
    <label>项目目录</label>
    <input type="text" id="pbDir" list="wsProjects" placeholder="选择或输入项目目录..." />
    <label>目标 / 关注点</label>
    <input type="text" id="pbGoal" placeholder="例如：梳理认证边界条件与并发风险" />
    <label>可选过滤 Glob（如 src/*.mjs）</label>
    <input type="text" id="pbInclude" placeholder="src/*.mjs" />
    <label>可选指定成员（逗号分隔，留空自动按在线状态挑选）</label>
    <input type="text" id="pbMembers" placeholder="留空自动挑选在线 Agent" />
    <label>可选历史检索词（research-and-pack）或 AST 模式（code-review-squad）</label>
    <input type="text" id="pbExtra" placeholder="CollabHub 或 export function $NAME($$$) { $$$ }" />
    <div id="pbErr" class="err-msg"></div>
    <div id="pbOut" class="mono-pre" style="display:none"></div>
    <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
      <button data-close-modal="modalPlaybookBg">关闭</button>
      <button class="primary" id="btnRunPlaybook">立即执行</button>
    </div>
  </div>
</div>

<div id="modalToolkitBg" class="modal-backdrop">
  <div class="modal" style="width:min(740px,96vw)">
    <div class="section-title"><span>🧰 开源工程工具箱（ast-grep · repomix · markitdown · beads）</span><button data-close-modal="modalToolkitBg">关闭</button></div>
    <div class="tabs">
      <button type="button" class="tab-btn active sm" data-tk-tab="ast">AST 语法树搜索</button>
      <button type="button" class="tab-btn sm" data-tk-tab="pack">Repomix 仓库打包</button>
      <button type="button" class="tab-btn sm" data-tk-tab="doc">MarkItDown 文档转 MD</button>
      <button type="button" class="tab-btn sm" data-tk-tab="beads">Beads 任务依赖图</button>
    </div>

    <div class="tab-pane active" id="pane-ast">
      <label>项目目录</label><input type="text" id="tkAstDir" list="wsProjects" placeholder="项目目录..." />
      <label>AST 匹配模式</label><input type="text" id="tkAstPat" value="export function $NAME($$$) { $$$ }" />
      <label>语言（js / ts / py / rs / go）</label><input type="text" id="tkAstLang" value="js" />
      <div style="margin-top:10px"><button class="primary sm" id="btnRunAst">执行 AST 搜索</button></div>
    </div>

    <div class="tab-pane" id="pane-pack">
      <label>项目目录</label><input type="text" id="tkPackDir" list="wsProjects" placeholder="项目目录..." />
      <label>Include Glob（可选）</label><input type="text" id="tkPackInc" value="src/config.mjs" />
      <div style="margin-top:10px"><button class="primary sm" id="btnRunPack">打包上下文 (repomix)</button></div>
    </div>

    <div class="tab-pane" id="pane-doc">
      <label>工作区内文档路径（PDF / DOCX / XLSX / PPTX / HTML / MD）</label><input type="text" id="tkDocPath" placeholder="选择或输入文档绝对路径..." />
      <div style="margin-top:10px"><button class="primary sm" id="btnRunDoc">转换为 Markdown</button></div>
    </div>

    <div class="tab-pane" id="pane-beads">
      <label>项目目录</label><input type="text" id="tkBdDir" list="wsProjects" placeholder="项目目录..." />
      <label>操作</label>
      <select id="tkBdAction">
        <option value="list">list（列出任务）</option>
        <option value="ready">ready（可执行任务）</option>
        <option value="init">init（初始化 beads 仓库）</option>
        <option value="create">create（新建任务）</option>
      </select>
      <label>标题（仅 create 需要）</label><input type="text" id="tkBdTitle" placeholder="新任务标题..." />
      <div style="margin-top:10px"><button class="primary sm" id="btnRunBeads">执行 Beads</button></div>
    </div>

    <div id="tkErr" class="err-msg"></div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-top:10px">
      <span class="meta" id="tkMeta">选择上方工具执行（严格目录沙箱保护）</span>
      <button class="sm" id="btnCopyTk" style="display:none">复制输出</button>
    </div>
    <div id="tkOut" class="mono-pre" style="display:none;max-height:320px"></div>
  </div>
</div>

<div id="modalMemoryBg" class="modal-backdrop">
  <div class="modal">
    <div class="section-title"><span>写入跨 Agent 共享项目记忆（Markdown + FTS5）</span><button data-close-modal="modalMemoryBg">关闭</button></div>
    <label>项目标识</label><input type="text" id="mmProject" value="collab-hub" />
    <label>标题</label><input type="text" id="mmTitle" placeholder="例如：部署与排障备忘" />
    <label>标签（逗号分隔）</label><input type="text" id="mmTags" placeholder="architecture, ops" />
    <label>内容（支持 Markdown）</label><textarea id="mmContent" placeholder="记录跨 Agent 需要共享的约定、边界、踩坑与决策..."></textarea>
    <div id="mmErr" class="err-msg"></div>
    <div style="margin-top:12px;display:flex;justify-content:flex-end;gap:8px">
      <button data-close-modal="modalMemoryBg">取消</button>
      <button class="primary" id="btnSaveMemory">保存记忆</button>
    </div>
  </div>
</div>

<script>
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const stateLabel = {
  online:'在线', idle:'就绪', dormant:'休眠', stale:'快照过期', cooldown:'429冷却', offline:'离线', unknown:'待探测',
  created:'已登记', dispatching:'派发中', dispatched:'已派发', running:'执行中', stalled:'疑似卡住',
  needs_input:'待确认', uncertain:'待核验', completed:'已完成', failed:'失败', rerouted:'已重路由',
  pass:'通过', warn:'警告', fail:'异常'
};
let latestMembers = [];
let latestTasks = [];
let latestTelemetry = {};
let latestRecipes = [];
let discoveredCache = [];
let lastToolkitCopyText = '';
let dagSteps = [];
let taskViewMode = 'table';

// Strictly XSS-safe lightweight Markdown -> HTML renderer (escapes HTML first!)
function renderSafeMarkdown(md) {
  const lines = esc(md || '').split(/\\r?\\n/);
  const out = [];
  let inList = false;
  let inTable = false;
  const inline = (s) => s
    .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
    .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      if (inList) { out.push('</ul>'); inList = false; }
      if (inTable) { out.push('</tbody></table>'); inTable = false; }
      continue;
    }
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const cells = trimmed.slice(1, -1).split('|').map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) continue;
      if (!inTable) {
        out.push('<table><thead><tr>' + cells.map(c => '<th>' + inline(c) + '</th>').join('') + '</tr></thead><tbody>');
        inTable = true;
      } else {
        out.push('<tr>' + cells.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>');
      }
      continue;
    }
    if (inTable) { out.push('</tbody></table>'); inTable = false; }
    if (trimmed.startsWith('### ')) { if (inList) { out.push('</ul>'); inList = false; } out.push('<h3>' + inline(trimmed.slice(4)) + '</h3>'); continue; }
    if (trimmed.startsWith('## ')) { if (inList) { out.push('</ul>'); inList = false; } out.push('<h2>' + inline(trimmed.slice(3)) + '</h2>'); continue; }
    if (trimmed.startsWith('# ')) { if (inList) { out.push('</ul>'); inList = false; } out.push('<h1>' + inline(trimmed.slice(2)) + '</h1>'); continue; }
    if (trimmed.startsWith('&gt; ')) { if (inList) { out.push('</ul>'); inList = false; } out.push('<blockquote>' + inline(trimmed.slice(5)) + '</blockquote>'); continue; }
    if (trimmed.startsWith('- ') || trimmed.startsWith('* ')) {
      if (!inList) { out.push('<ul>'); inList = true; }
      out.push('<li>' + inline(trimmed.slice(2)) + '</li>');
      continue;
    }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push('<p style="margin:6px 0">' + inline(line) + '</p>');
  }
  if (inList) out.push('</ul>');
  if (inTable) out.push('</tbody></table>');
  return out.join('');
}

async function apiPost(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
  return data;
}

function renderFilteredTasks() {
  const q = (document.getElementById('filterText').value || '').trim().toLowerCase();
  const ag = document.getElementById('filterAgent').value;
  const st = document.getElementById('filterState').value;
  const rows = latestTasks.filter(t => {
    if (ag && t.member !== ag) return false;
    if (st && t.state !== st) return false;
    if (q) {
      const hay = (t.title + ' ' + t.task_id + ' ' + (t.batch_id || '') + ' ' + (t.result_text || '') + ' ' + (t.error_message || '')).toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  document.getElementById('taskCount').textContent = rows.length + ' / ' + latestTasks.length + ' 条';
  document.getElementById('tasksBody').innerHTML = rows.length ? rows.map(t => {
    const receipt = [t.external_id ? 'id:' + t.external_id.slice(0,16) : '', t.reply_generation ? 'gen:' + t.reply_generation : ''].filter(Boolean).join(' ');
    const snippet = t.result_text ? t.result_text.slice(0, 140) : (t.error_message || t.project_dir);
    return '<tr class="clickable" data-open-task="' + esc(t.task_id) + '">' +
      '<td><strong>' + esc(t.title) + '</strong><div class="meta"><code class="task-id-code" title="' + esc(t.task_id) + '">' + esc(t.task_id) + '</code> · ' + esc(t.role) + (t.batch_id ? ' · ' + esc(t.batch_id) : '') + '</div></td>' +
      '<td>' + esc(t.member) + '<div class="meta"><code style="white-space:nowrap">' + esc(t.channel) + '</code></div></td>' +
      '<td><span class="badge st-' + esc(t.state) + '">' + esc(stateLabel[t.state] || t.state) + '</span></td>' +
      '<td><code>' + esc(receipt || '-') + '</code></td>' +
      '<td><div class="meta">' + esc(snippet) + '</div><div class="meta">' + new Date(t.updated_at).toLocaleString() + '</div></td>' +
      '</tr>';
  }).join('') : '<tr><td colspan="5" class="empty">无匹配任务。调整筛选条件或点击“+ 派发”启动新协作。</td></tr>';

  const cols = [
    { key: 'queued', title: '排队 / 派发中', match: s => ['created', 'dispatching', 'dispatched'].includes(s) },
    { key: 'running', title: '执行中', match: s => s === 'running' },
    { key: 'attention', title: '需关注 / 阻塞', match: s => ['stalled', 'uncertain', 'needs_input'].includes(s) },
    { key: 'done', title: '已结束', match: s => ['completed', 'failed', 'rerouted'].includes(s) },
  ];
  document.getElementById('tasksKanbanWrap').innerHTML = cols.map(c => {
    const items = rows.filter(t => c.match(t.state));
    return '<div class="kb-col"><div class="kb-head"><span>' + esc(c.title) + '</span><span class="pill">' + items.length + '</span></div>' +
      (items.length ? items.map(t =>
        '<div class="kb-card" data-open-task="' + esc(t.task_id) + '">' +
          '<div style="display:flex;justify-content:space-between;gap:6px;align-items:center"><strong style="font-size:12.5px">' + esc(t.title.slice(0, 34)) + '</strong><span class="badge st-' + esc(t.state) + '">' + esc(stateLabel[t.state] || t.state) + '</span></div>' +
          '<div class="meta" style="margin-top:4px">' + esc(t.member) + ' · ' + esc(t.role) + '</div>' +
          '<div class="meta" style="margin-top:2px"><code>' + esc(t.task_id.slice(0, 22)) + '</code></div>' +
        '</div>'
      ).join('') : '<div class="meta" style="text-align:center;padding:12px 0">空</div>') +
    '</div>';
  }).join('');
}

async function loadWorkspacesAndRecipes() {
  try {
    const [wsRes, rcRes] = await Promise.all([fetch('/api/workspaces'), fetch('/api/recipes')]);
    if (wsRes.ok) {
      const ws = await wsRes.json();
      const projects = ws.projects || [];
      document.getElementById('wsProjects').innerHTML = projects.map(p =>
        '<option value="' + esc(p.path) + '">' + esc(p.name + (p.is_git ? ' (git)' : '')) + '</option>'
      ).join('');
      const defProj = projects[0]?.path || '';
      if (defProj) {
        for (const id of ['dpDir', 'dagDir', 'pbDir', 'tkAstDir', 'tkPackDir', 'tkBdDir']) {
          const el = document.getElementById(id);
          if (el && !el.value) el.value = defProj;
        }
        const docEl = document.getElementById('tkDocPath');
        if (docEl && !docEl.value) docEl.value = defProj + (defProj.includes('\\\\') ? '\\\\README.md' : '/README.md');
      }
    }
    if (rcRes.ok) {
      const rc = await rcRes.json();
      latestRecipes = rc.recipes || [];
      document.getElementById('dpRecipe').innerHTML = '<option value="">-- 手动编写 Prompt --</option>' + latestRecipes.map(r =>
        '<option value="' + esc(r.recipe_id) + '">' + esc(r.title + ' [' + r.role + ']') + '</option>'
      ).join('');
    }
  } catch {}
}

async function loadOverview() {
  try {
    const res = await fetch('/api/overview');
    const data = await res.json();
    latestMembers = data.members || [];
    latestTasks = data.tasks || [];
    latestTelemetry = data.telemetry?.agents || {};

    const mp = document.getElementById('mailPill');
    mp.textContent = data.mail_hub.ok ? ('Mail v' + (data.mail_hub.version || '') + ' :5291') : 'Mail 离线';
    mp.style.borderColor = data.mail_hub.ok ? 'rgba(34,197,94,.5)' : 'rgba(239,68,68,.5)';
    document.getElementById('updatedAt').textContent = new Date(data.generated_at).toLocaleTimeString();

    const m = data.metrics || {};
    document.getElementById('kpiBar').innerHTML = [
      { l: '在线 / 已注册 Agent', v: (m.agents_ready ?? 0) + ' / ' + (m.agents_total ?? 0) },
      { l: '已完成 / 总任务', v: (m.tasks_completed ?? 0) + ' / ' + (m.tasks_total ?? 0) },
      { l: '执行中 / 需关注', v: (m.tasks_active ?? 0) + ' / ' + (m.tasks_stalled ?? 0) },
      { l: '活跃 Worktree', v: String(m.active_worktrees ?? 0) },
      { l: '共享记忆笔记', v: String(m.memory_notes ?? 0) },
      { l: 'cass 跨端历史索引', v: m.cass_conversations != null ? (m.cass_conversations + ' 会话') : '未索引' },
    ].map(x => '<div class="kpi"><div class="kpi-label">' + esc(x.l) + '</div><div class="kpi-val">' + esc(x.v) + '</div></div>').join('');

    const tk = data.toolkit || {};
    const tabMap = { cass: null, ast_grep: 'ast', repomix: 'pack', markitdown: 'doc', beads: 'beads' };
    document.getElementById('toolkitStrip').innerHTML = '<span class="meta">已装开源工具链（点击直达）：</span>' +
      ['cass', 'ast_grep', 'beads', 'repomix', 'markitdown'].map(k => {
        const item = tk[k] || {};
        const tab = tabMap[k];
        const attr = tab ? (' data-open-tk-tab="' + tab + '"') : ' data-focus-cass="1"';
        return '<span class="pill pill-btn"' + attr + ' title="' + esc(item.purpose || '') + '" style="border-color:' + (item.installed ? 'rgba(34,197,94,.45)' : 'rgba(239,68,68,.4)') + '">' +
          (item.installed ? '● ' : '○ ') + esc(k) + '</span>';
      }).join('');

    const stalledTasks = latestTasks.filter(t => t.state === 'stalled' || t.state === 'uncertain');
    const banner = document.getElementById('alertBanner');
    if (stalledTasks.length) {
      banner.classList.add('show');
      banner.innerHTML = '<div><strong>⚠️ 发现 ' + stalledTasks.length + ' 项疑似卡住/待核验任务：</strong>' +
        stalledTasks.map(t => '<code>' + esc(t.task_id) + '</code> (' + esc(t.member) + ' · ' + esc(t.error_code || t.state) + ')').join('、') +
        '</div><button class="warn sm" data-open-task="' + esc(stalledTasks[0].task_id) + '">查看诊断与处理</button>';
    } else {
      banner.classList.remove('show');
    }

    const agSel = document.getElementById('filterAgent');
    const prevAg = agSel.value;
    agSel.innerHTML = '<option value="">全部 Agent</option>' + latestMembers.map(mm =>
      '<option value="' + esc(mm.member) + '">' + esc(mm.name) + '</option>'
    ).join('');
    agSel.value = prevAg;

    document.getElementById('roster').innerHTML = latestMembers.map(mm => {
      const st = mm.state || 'unknown';
      const tel = latestTelemetry[mm.member];
      const telHtml = tel && tel.total > 0
        ? '<div class="tele-row">历史 ' + tel.completed + '/' + tel.total + (tel.success_rate != null ? (' · 成功率 ' + Math.round(tel.success_rate * 100) + '%') : '') + (tel.avg_latency_ms != null ? (' · ' + (tel.avg_latency_ms / 1000).toFixed(1) + 's') : '') + (tel.total_tokens ? (' · ' + tel.total_tokens + ' tok') : '') + '</div>'
        : '';
      const cdBtn = (mm.in_cooldown || mm.cli_in_cooldown)
        ? '<button class="sm" data-clear-cooldown="' + esc(mm.member) + '">解除冷却 (' + mm.cooldown_remaining_s + 's)</button>' : '';
      const testBtn = ['generic-cli', 'openai-http'].includes(mm.driver)
        ? '<button class="sm" data-test-agent="' + esc(mm.member) + '">测试连通</button>' : '';
      const rmBtn = !mm.builtin
        ? '<button class="danger sm" data-remove-agent="' + esc(mm.member) + '">移除</button>' : '';
      const foot = (cdBtn || testBtn || rmBtn) ? '<div style="margin-top:8px;display:flex;gap:6px;flex-wrap:wrap">' + testBtn + cdBtn + rmBtn + '</div>' : '';
      return '<div class="card">' +
        '<div class="card-head"><span class="member-name">' + esc(mm.name) + (mm.builtin ? '' : ' <span class="pill">扩展</span>') + '</span><span class="badge st-' + esc(st) + '">' + esc(stateLabel[st] || st) + '</span></div>' +
        '<div class="meta"><code>' + esc(mm.channel) + '</code> · ' + (mm.checked_at ? new Date(mm.checked_at).toLocaleTimeString() : '-') + '</div>' +
        '<div class="meta" style="margin-top:3px">' + esc(mm.detail || '') + '</div>' +
        telHtml + foot + '</div>';
    }).join('');

    const batches = data.batches || [];
    document.getElementById('batchStrip').innerHTML = batches.length ? ('<span class="meta">协作批次（点击导出报告）：</span>' + batches.map(b => {
      const badgeCls = b.all_succeeded ? 'st-completed' : (b.has_stalled ? 'st-stalled' : (b.all_terminal ? 'st-failed' : 'st-running'));
      const badgeTxt = b.all_succeeded ? '全部成功' : (b.has_stalled ? '含卡住' : (b.all_terminal ? '已结束' : '进行中'));
      const stats = Object.entries(b.counts).map(([k, v]) => (stateLabel[k] || k) + ':' + v).join(' · ');
      return '<div class="batch-chip" data-open-batch="' + esc(b.batch_id) + '"><strong>' + esc(b.batch_id) + '</strong><span class="badge ' + badgeCls + '">' + badgeTxt + '</span><span class="meta">' + esc(stats) + '</span></div>';
    }).join('')) : '';

    renderFilteredTasks();

    document.getElementById('wtCount').textContent = data.worktrees.length;
    document.getElementById('wtList').innerHTML = data.worktrees.length ? data.worktrees.map(w => {
      const btns = w.state === 'active'
        ? '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' +
            '<button class="sm primary" data-wt-review="' + esc(w.task_id) + '">审查 Diff</button>' +
            '<button class="sm danger" data-wt-cleanup="' + esc(w.task_id) + '">清理</button>' +
          '</div>'
        : '';
      return '<div class="note-item"><div><strong>' + esc(w.branch_name) + '</strong> <span class="badge st-' + (w.state==='active'?'running':'completed') + '">' + esc(w.state) + '</span></div>' +
        '<div class="meta">成员：' + esc(w.member) + ' · 路径：<code>' + esc(w.worktree_path) + '</code></div>' + btns + '</div>';
    }).join('') : '<div class="empty">当前无活跃并行 Worktree</div>';

    if (!document.getElementById('memQuery').value.trim()) renderNotes(data.notes);
  } catch (e) { console.error(e); }
}

function connectSse() {
  const pill = document.getElementById('ssePill');
  try {
    const es = new EventSource('/api/events/stream');
    es.onopen = () => { pill.textContent = '● 实时 SSE'; pill.style.borderColor = 'rgba(34,197,94,.5)'; pill.style.color = '#4ade80'; };
    es.onmessage = () => { loadOverview(); };
    es.onerror = () => { pill.textContent = '○ 轮询模式'; pill.style.borderColor = 'rgba(245,158,11,.4)'; pill.style.color = '#fbbf24'; };
  } catch {
    pill.textContent = '○ 轮询模式';
  }
}

async function openTask(taskId) {
  const res = await fetch('/api/tasks/' + encodeURIComponent(taskId));
  if (!res.ok) return;
  const data = await res.json();
  const t = data.task;
  if (!t) return;
  const isTerminal = ['completed','failed','rerouted'].includes(t.state);
  const canPoll = !isTerminal && t.channel !== 'desktop-native';
  const actionBar = !isTerminal ? (
    '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:12px">' +
      (canPoll ? '<button class="primary sm" data-poll-task="' + esc(t.task_id) + '">立即轮询回执</button>' : '') +
      '<button class="warn sm" data-reconcile-task="' + esc(t.task_id) + '" data-reconcile-state="rerouted">标记已重路由</button>' +
      '<button class="danger sm" data-reconcile-task="' + esc(t.task_id) + '" data-reconcile-state="failed">标记失败关闭</button>' +
    '</div>'
  ) : '';
  document.getElementById('drawerContent').innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
      '<h2 style="margin:0;font-size:16px">' + esc(t.title) + '</h2>' +
      '<button data-close-drawer="1">关闭</button>' +
    '</div>' +
    '<div class="meta">Task ID: <code>' + esc(t.task_id) + '</code> · Agent: <code>' + esc(t.member) + '</code> (' + esc(t.channel) + ') · 状态: <span class="badge st-' + esc(t.state) + '">' + esc(stateLabel[t.state] || t.state) + '</span></div>' +
    '<div class="meta" style="margin-top:5px">目录: <code>' + esc(t.project_dir) + '</code>' + (t.meta?.routed_from ? ' · 自动路由自: <code>' + esc(t.meta.routed_from) + '</code>' : '') + '</div>' +
    '<div class="meta" style="margin-top:4px">回执 ID: <code>' + esc(t.external_id || '-') + '</code> · Session: <code>' + esc(t.session_id || '-') + '</code>' + (t.reply_generation ? ' · Gen: ' + t.reply_generation : '') + '</div>' +
    ((t.depends_on && t.depends_on.length) ? '<div class="meta" style="margin-top:4px">上游依赖: ' + t.depends_on.map(d => '<code>' + esc(d) + '</code>').join(' ') + '</div>' : '') +
    actionBar +
    '<h3 style="font-size:13px;margin:14px 0 4px">Prompt</h3><div class="mono-pre">' + esc(t.prompt) + '</div>' +
    (t.result_text ? '<h3 style="font-size:13px;margin:14px 0 4px">完整结果</h3><div class="mono-pre">' + esc(t.result_text) + '</div>' : '') +
    (t.error_message ? '<h3 style="font-size:13px;margin:14px 0 4px;color:#fbbf24">诊断 / 阻塞</h3><div class="mono-pre">' + esc((t.error_code ? '[' + t.error_code + '] ' : '') + t.error_message) + '</div>' : '') +
    '<h3 style="font-size:13px;margin:14px 0 4px">审计事件流 (' + (data.events || []).length + ')</h3>' +
    '<div class="mono-pre">' + esc((data.events || []).map(e => e.created_at + ' | ' + e.event_type + ' | ' + e.actor + (e.payload_json ? ' | ' + e.payload_json : '')).join('\\n') || '无事件') + '</div>';
  document.getElementById('drawerBg').classList.add('open');
}

async function openBatchReport(batchId) {
  const res = await fetch('/api/batches/' + encodeURIComponent(batchId) + '/report');
  if (!res.ok) return;
  const data = await res.json();
  window._lastBatchMd = data.markdown || '';
  document.getElementById('drawerContent').innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;gap:8px">' +
      '<h2 style="margin:0;font-size:16px">批次报告 · ' + esc(batchId) + '</h2>' +
      '<div style="display:flex;gap:6px"><button class="sm" data-toggle-raw="batch">原始 MD</button><button class="primary sm" data-copy-batch="1">复制 MD</button><button data-close-drawer="1">关闭</button></div>' +
    '</div>' +
    '<div id="batchRich" class="md-view">' + renderSafeMarkdown(data.markdown) + '</div>' +
    '<div id="batchRaw" class="mono-pre" style="display:none;max-height:76vh">' + esc(data.markdown) + '</div>';
  document.getElementById('drawerBg').classList.add('open');
}

async function openEventsDrawer() {
  const res = await fetch('/api/events?limit=80');
  if (!res.ok) return;
  const data = await res.json();
  const list = data.events || [];
  document.getElementById('drawerContent').innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<h2 style="margin:0;font-size:16px">📡 全站实时审计事件流（最近 ' + list.length + ' 条）</h2>' +
      '<button data-close-drawer="1">关闭</button>' +
    '</div>' +
    list.map(e =>
      '<div class="note-item"><div style="display:flex;justify-content:space-between;gap:8px"><strong><code>' + esc(e.event_type) + '</code> · ' + esc(e.actor) + '</strong><span class="meta">' + new Date(e.created_at).toLocaleString() + '</span></div>' +
      (e.task_id ? '<div class="meta">Task: <code>' + esc(e.task_id) + '</code></div>' : '') +
      (e.payload_json ? '<div class="meta">' + esc(e.payload_json.slice(0, 260)) + '</div>' : '') + '</div>'
    ).join('');
  document.getElementById('drawerBg').classList.add('open');
}

async function openDoctorDrawer() {
  document.getElementById('drawerContent').innerHTML = '<div class="meta">正在执行 8 项系统健康体检...</div>';
  document.getElementById('drawerBg').classList.add('open');
  const res = await fetch('/api/doctor');
  const doc = await res.json();
  document.getElementById('drawerContent').innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<h2 style="margin:0;font-size:16px">🩺 系统体检 (' + doc.pass_count + '/' + doc.total_checks + ' 通过 · ' + esc(doc.overall) + ')</h2>' +
      '<div style="display:flex;gap:6px"><button class="primary sm" id="btnHotBackup">一键热备份 hub.db</button><button data-close-drawer="1">关闭</button></div>' +
    '</div>' +
    '<div id="backupMsg" class="meta" style="margin-bottom:10px"></div>' +
    (doc.checks || []).map(c =>
      '<div class="note-item"><div style="display:flex;justify-content:space-between;align-items:center"><strong>' + esc(c.id) + '</strong><span class="badge st-' + esc(c.status) + '">' + esc(stateLabel[c.status] || c.status) + '</span></div><div class="meta" style="margin-top:4px">' + esc(c.detail) + '</div></div>'
    ).join('');
}

async function openWorktreeReview(taskId) {
  try {
    const rev = await apiPost('/api/worktrees/review', { task_id: taskId });
    document.getElementById('drawerContent').innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">' +
        '<h2 style="margin:0;font-size:16px">Worktree 审查 · ' + esc(rev.branch_name) + '</h2>' +
        '<button data-close-drawer="1">关闭</button>' +
      '</div>' +
      '<div class="meta">Task: <code>' + esc(rev.task_id) + '</code> · Base: <code>' + esc(rev.base_ref) + '</code> · HEAD: <code>' + esc((rev.reviewed_head_sha || '').slice(0, 12)) + '</code> · Dirty: ' + (rev.dirty ? '是' : '否') + (rev.verify_status ? (' · 测试: <span class="badge st-' + (rev.verify_status === 'passed' ? 'pass' : 'fail') + '">' + esc(rev.verify_status) + '</span>') : '') + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:10px;flex-wrap:wrap">' +
        '<button class="primary sm" data-wt-verify="' + esc(rev.task_id) + '">🧪 运行测试验收</button>' +
        '<button class="success sm" data-wt-merge="' + esc(rev.task_id) + '">确认无误，合并入 ' + esc(rev.base_ref) + '</button>' +
        '<button class="danger sm" data-wt-cleanup="' + esc(rev.task_id) + '">放弃并清理 Worktree</button>' +
      '</div>' +
      '<div id="wtMergeMsg" class="err-msg"></div>' +
      '<div id="wtVerifyOut" class="mono-pre" style="display:none"></div>' +
      '<h3 style="font-size:13px;margin:14px 0 4px">Commits (' + (rev.commits || []).length + ')</h3><div class="mono-pre">' + esc((rev.commits || []).join('\\n') || '(无新提交)') + '</div>' +
      '<h3 style="font-size:13px;margin:14px 0 4px">Diff Preview</h3><div class="mono-pre" style="max-height:52vh">' + esc(rev.diff_preview || '(无改动)') + '</div>';
    document.getElementById('drawerBg').classList.add('open');
  } catch (err) { alert('Worktree 审查失败: ' + err.message); }
}

function renderNotes(notes) {
  document.getElementById('memList').innerHTML = notes.length ? notes.map(n =>
    '<div class="note-item" style="cursor:pointer" data-open-note-project="' + esc(n.project) + '" data-open-note-slug="' + esc(n.slug) + '">' +
    '<div><strong>' + esc(n.title) + '</strong> <span class="pill">' + esc(n.project) + '</span></div>' +
    '<div class="meta" style="margin-top:4px">' + esc(n.preview || (n.content || '').slice(0, 180)) + '</div>' +
    '<div class="meta" style="margin-top:4px">' + esc(n.author) + ' · ' + new Date(n.updated_at).toLocaleString() + '</div></div>'
  ).join('') : '<div class="empty">暂无共享记忆笔记</div>';
}

async function openNote(project, slug) {
  const res = await fetch('/api/memory/note?project=' + encodeURIComponent(project) + '&slug=' + encodeURIComponent(slug));
  if (!res.ok) return;
  const data = await res.json();
  const n = data.note;
  if (!n) return;
  document.getElementById('drawerContent').innerHTML =
    '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">' +
      '<h2 style="margin:0;font-size:16px">' + esc(n.title) + '</h2>' +
      '<div style="display:flex;gap:6px"><button class="sm" data-toggle-raw="note">原始 MD</button><button data-close-drawer="1">关闭</button></div>' +
    '</div>' +
    '<div class="meta">项目: <span class="pill">' + esc(n.project) + '</span> · Slug: <code>' + esc(n.slug) + '</code> · 作者: ' + esc(n.author) + '</div>' +
    '<div id="noteRich" class="md-view">' + renderSafeMarkdown(n.content) + '</div>' +
    '<div id="noteRaw" class="mono-pre" style="display:none;max-height:70vh">' + esc(n.content) + '</div>';
  document.getElementById('drawerBg').classList.add('open');
}

async function searchMem() {
  const q = document.getElementById('memQuery').value.trim();
  const res = await fetch('/api/memory?q=' + encodeURIComponent(q));
  const data = await res.json();
  renderNotes(data.results || []);
}

async function searchSessions() {
  const q = document.getElementById('sessQuery').value.trim();
  if (!q) return;
  const box = document.getElementById('sessList');
  box.textContent = '检索中...';
  try {
    const res = await fetch('/api/sessions?q=' + encodeURIComponent(q));
    const data = await res.json();
    if (!data.ok) { box.innerHTML = '<div class="meta">' + esc(data.hint || data.error || '未返回结果') + '</div>'; return; }
    const hits = data.result?.hits || data.result?.results || (Array.isArray(data.result) ? data.result : []);
    if (hits.length) {
      box.innerHTML = hits.slice(0, 6).map(h =>
        '<div class="note-item"><div><strong>' + esc(h.title || h.agent || h.source || 'Session') + '</strong></div>' +
        '<div class="meta">' + esc(String(h.snippet || h.content || JSON.stringify(h)).replace(/\\*\\*/g, '').slice(0, 200)) + '</div></div>'
      ).join('');
    } else {
      box.innerHTML = '<div class="mono-pre">' + esc(JSON.stringify(data.result || data.raw || '无匹配', null, 2).slice(0, 1000)) + '</div>';
    }
  } catch (err) { box.textContent = '检索失败: ' + err.message; }
}

function openToolkitTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.getAttribute('data-tk-tab') === tab));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + tab));
  document.getElementById('tkErr').textContent = '';
  document.getElementById('modalToolkitBg').classList.add('open');
}

function showToolkitOutput(meta, text) {
  lastToolkitCopyText = text;
  document.getElementById('tkMeta').textContent = meta;
  document.getElementById('tkOut').textContent = text;
  document.getElementById('tkOut').style.display = 'block';
  document.getElementById('btnCopyTk').style.display = 'inline-flex';
}

function renderDagSteps() {
  const bgOpts = ['<option value="auto">auto (智能路由)</option>'].concat(
    latestMembers.filter(m => ['dsh-baton','muse-tailnet','claude-dual','generic-cli','openai-http'].includes(m.driver))
      .map(m => '<option value="' + esc(m.member) + '">' + esc(m.name) + '</option>')
  ).join('');
  document.getElementById('dagStepsList').innerHTML = dagSteps.map((s, idx) =>
    '<div class="dag-step-card" data-dag-idx="' + idx + '">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><strong>步骤 #' + (idx + 1) + '</strong><button type="button" class="danger sm" data-del-dag="' + idx + '">删除</button></div>' +
      '<div class="dag-row">' +
        '<div><label>Step ID</label><input type="text" data-dag-f="id" value="' + esc(s.id) + '" /></div>' +
        '<div><label>Agent</label><select data-dag-f="member">' + bgOpts.replace('value="' + esc(s.member) + '"', 'value="' + esc(s.member) + '" selected') + '</select></div>' +
        '<div><label>依赖前置 Step ID (逗号分隔)</label><input type="text" data-dag-f="deps" value="' + esc((s.depends_on || []).join(',')) + '" placeholder="留空即首波并行" /></div>' +
      '</div>' +
      '<label>Prompt（上游输出会自动注入）</label><textarea data-dag-f="prompt" style="min-height:56px">' + esc(s.prompt) + '</textarea>' +
    '</div>'
  ).join('');
}

function syncDagFromDom() {
  document.querySelectorAll('.dag-step-card').forEach((card, i) => {
    if (!dagSteps[i]) return;
    dagSteps[i].id = card.querySelector('[data-dag-f="id"]').value.trim() || ('step_' + (i + 1));
    dagSteps[i].member = card.querySelector('[data-dag-f="member"]').value;
    dagSteps[i].depends_on = card.querySelector('[data-dag-f="deps"]').value.split(',').map(x => x.trim()).filter(Boolean);
    dagSteps[i].prompt = card.querySelector('[data-dag-f="prompt"]').value;
  });
}

document.getElementById('filterText').addEventListener('input', renderFilteredTasks);
document.getElementById('filterAgent').addEventListener('change', renderFilteredTasks);
document.getElementById('filterState').addEventListener('change', renderFilteredTasks);
document.getElementById('btnViewTable').addEventListener('click', () => {
  taskViewMode = 'table';
  document.getElementById('tasksTableWrap').style.display = 'block';
  document.getElementById('tasksKanbanWrap').style.display = 'none';
  document.getElementById('btnViewTable').classList.add('primary');
  document.getElementById('btnViewKanban').classList.remove('primary');
});
document.getElementById('btnViewKanban').addEventListener('click', () => {
  taskViewMode = 'kanban';
  document.getElementById('tasksTableWrap').style.display = 'none';
  document.getElementById('tasksKanbanWrap').style.display = 'grid';
  document.getElementById('btnViewKanban').classList.add('primary');
  document.getElementById('btnViewTable').classList.remove('primary');
});
document.getElementById('btnOpenEvents').addEventListener('click', openEventsDrawer);
document.getElementById('btnOpenDoctor').addEventListener('click', openDoctorDrawer);

document.getElementById('btnProbe').addEventListener('click', async () => {
  document.getElementById('updatedAt').textContent = '探活中';
  await apiPost('/api/probe', {}).catch(() => {});
  await loadOverview();
});
document.getElementById('btnMemSearch').addEventListener('click', searchMem);
document.getElementById('memQuery').addEventListener('keydown', e => { if (e.key === 'Enter') searchMem(); });
document.getElementById('btnSessSearch').addEventListener('click', searchSessions);
document.getElementById('sessQuery').addEventListener('keydown', e => { if (e.key === 'Enter') searchSessions(); });

document.getElementById('btnOpenToolkit').addEventListener('click', () => openToolkitTab('ast'));
document.getElementById('btnCopyTk').addEventListener('click', () => { navigator.clipboard?.writeText(lastToolkitCopyText).catch(() => {}); });

document.getElementById('btnRunAst').addEventListener('click', async () => {
  document.getElementById('tkErr').textContent = '';
  try {
    const res = await apiPost('/api/toolkit/ast', { project_dir: document.getElementById('tkAstDir').value.trim(), pattern: document.getElementById('tkAstPat').value.trim(), lang: document.getElementById('tkAstLang').value.trim() || null });
    showToolkitOutput('AST 命中 ' + res.total_matches + ' 处', (res.matches || []).map(x => x.file + ':' + x.line + '  ' + x.text).join('\\n') || '(0 matches)');
  } catch (err) { document.getElementById('tkErr').textContent = err.message; }
});
document.getElementById('btnRunPack').addEventListener('click', async () => {
  document.getElementById('tkErr').textContent = '';
  try {
    const res = await apiPost('/api/toolkit/pack', { project_dir: document.getElementById('tkPackDir').value.trim(), include: document.getElementById('tkPackInc').value.trim() || null });
    showToolkitOutput('打包完成 · 约 ' + res.approx_tokens + ' tokens', res.content || '');
  } catch (err) { document.getElementById('tkErr').textContent = err.message; }
});
document.getElementById('btnRunDoc').addEventListener('click', async () => {
  document.getElementById('tkErr').textContent = '';
  try {
    const res = await apiPost('/api/toolkit/doc2md', { file_path: document.getElementById('tkDocPath').value.trim() });
    showToolkitOutput('转换完成 · ' + res.total_chars + ' 字符', res.markdown || '');
  } catch (err) { document.getElementById('tkErr').textContent = err.message; }
});
document.getElementById('btnRunBeads').addEventListener('click', async () => {
  document.getElementById('tkErr').textContent = '';
  try {
    const res = await apiPost('/api/toolkit/beads', { project_dir: document.getElementById('tkBdDir').value.trim(), action: document.getElementById('tkBdAction').value, title: document.getElementById('tkBdTitle').value.trim() || null });
    showToolkitOutput('Beads ' + res.action + ' 完成', JSON.stringify(res.data || res.output || res, null, 2));
  } catch (err) { document.getElementById('tkErr').textContent = err.message; }
});

document.getElementById('btnOpenDag').addEventListener('click', () => {
  document.getElementById('dagErr').textContent = '';
  document.getElementById('dagOut').style.display = 'none';
  if (!dagSteps.length) {
    dagSteps = [
      { id: 'plan', member: 'auto', role: 'planner', depends_on: [], prompt: '提出核心架构方案与最小实施路径。' },
      { id: 'redteam', member: 'auto', role: 'reviewer', depends_on: [], prompt: '从第一性原理红队审查潜在安全与并发风险。' },
      { id: 'verdict', member: 'auto', role: 'synthesizer', depends_on: ['plan', 'redteam'], prompt: '综合正反观点输出最终落地清单。' },
    ];
  }
  renderDagSteps();
  document.getElementById('modalDagBg').classList.add('open');
});
document.getElementById('btnAddDagStep').addEventListener('click', () => {
  syncDagFromDom();
  dagSteps.push({ id: 'step_' + (dagSteps.length + 1), member: 'auto', role: 'researcher', depends_on: [], prompt: '' });
  renderDagSteps();
});
document.getElementById('btnRunDag').addEventListener('click', async () => {
  syncDagFromDom();
  const errEl = document.getElementById('dagErr');
  const outEl = document.getElementById('dagOut');
  errEl.textContent = '';
  outEl.style.display = 'block';
  outEl.textContent = '执行工作流中...';
  try {
    const res = await apiPost('/api/workflows/run', {
      name: document.getElementById('dagName').value.trim() || 'visual-dag',
      project_dir: document.getElementById('dagDir').value.trim(),
      steps: dagSteps,
      wait_sec: 0,
    });
    outEl.textContent = JSON.stringify(res, null, 2);
    await loadOverview();
  } catch (err) { outEl.style.display = 'none'; errEl.textContent = err.message; }
});

document.getElementById('btnOpenAgent').addEventListener('click', () => {
  document.getElementById('agErr').textContent = '';
  document.getElementById('discoverBox').style.display = 'none';
  document.getElementById('modalAgentBg').classList.add('open');
});
document.getElementById('btnDiscoverAgents').addEventListener('click', async () => {
  const box = document.getElementById('discoverBox');
  box.style.display = 'block';
  box.innerHTML = '<div class="meta">正在只读扫描本机 Ollama / LM Studio / vLLM / CLI / 环境变量...</div>';
  try {
    const res = await fetch('/api/agents/discover');
    const data = await res.json();
    discoveredCache = [];
    const items = [];
    for (const m of (data.local_models || [])) {
      const idx = discoveredCache.push(m.suggested_registration) - 1;
      items.push('<div class="note-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><strong>' + esc(m.endpoint + ' · ' + m.model) + '</strong></div><button type="button" class="sm primary" data-fill-discovered="' + idx + '">填入表单</button></div>');
    }
    for (const c of (data.cli_agents || []).filter(x => x.found)) {
      const idx = discoveredCache.push(c.suggested_registration) - 1;
      items.push('<div class="note-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><strong>' + esc(c.name) + '</strong> <span class="meta">(' + esc(c.path) + ')</span></div><button type="button" class="sm primary" data-fill-discovered="' + idx + '">填入表单</button></div>');
    }
    for (const p of (data.cloud_env_ready || []).filter(x => x.env_present)) {
      const idx = discoveredCache.push(p.suggested_registration) - 1;
      items.push('<div class="note-item" style="display:flex;justify-content:space-between;align-items:center;gap:8px"><div><strong>' + esc(p.name) + '</strong> <span class="pill">' + esc(p.env_var) + ' 已就绪</span></div><button type="button" class="sm primary" data-fill-discovered="' + idx + '">填入表单</button></div>');
    }
    const epSummary = (data.local_endpoints || []).map(e => e.label + ':' + (e.reachable ? (e.model_count + '模型') : '未启动')).join(' · ');
    box.innerHTML = '<div class="meta" style="margin-bottom:6px">端点扫描：' + esc(epSummary) + '</div>' +
      (items.length ? items.join('') : '<div class="meta">暂未检测到运行中的本地模型或外部 CLI；可直接点击上方快捷模板配置。</div>');
  } catch (err) { box.innerHTML = '<div class="err-msg">扫描失败: ' + esc(err.message) + '</div>'; }
});

document.getElementById('agDriver').addEventListener('change', (e) => {
  const presets = {
    'openai-http': '{"base_url":"http://127.0.0.1:11434/v1","model":"qwen2.5-coder:14b","api_key_env":""}',
    'generic-cli': '{"command":"gemini","args":["-p","{{prompt}}"],"prompt_mode":"arg","timeout_s":120}',
    'desktop-native': '{}',
  };
  document.getElementById('agConfig').value = presets[e.target.value] || '{}';
});
document.getElementById('btnSaveAgent').addEventListener('click', async () => {
  const errEl = document.getElementById('agErr');
  errEl.textContent = '';
  try {
    const cfg = JSON.parse(document.getElementById('agConfig').value || '{}');
    await apiPost('/api/agents/register', {
      agent_id: document.getElementById('agId').value.trim(),
      name: document.getElementById('agName').value.trim(),
      driver: document.getElementById('agDriver').value,
      roles: document.getElementById('agRoles').value.split(',').map(s => s.trim()).filter(Boolean),
      config: cfg,
    });
    document.getElementById('modalAgentBg').classList.remove('open');
    await loadOverview();
  } catch (err) { errEl.textContent = err.message; }
});

document.getElementById('dpRecipe').addEventListener('change', (e) => {
  const rec = latestRecipes.find(r => r.recipe_id === e.target.value);
  if (!rec) return;
  document.getElementById('dpRole').value = rec.role;
  document.getElementById('dpTitle').value = rec.title;
  document.getElementById('dpPrompt').value = rec.prompt;
});
document.getElementById('btnOpenDispatch').addEventListener('click', () => {
  document.getElementById('dpErr').textContent = '';
  const sel = document.getElementById('dpMember');
  const bg = latestMembers.filter(m => ['dsh-baton','muse-tailnet','claude-dual','generic-cli','openai-http'].includes(m.driver));
  sel.innerHTML = '<option value="auto">✨ auto（按在线状态 + 历史成功率自动路由）</option>' +
    bg.map(m => '<option value="' + esc(m.member) + '">' + esc(m.name) + ' (' + esc(m.channel) + ' · ' + esc(stateLabel[m.state] || m.state) + ')</option>').join('');
  document.getElementById('modalDispatchBg').classList.add('open');
});
document.getElementById('btnSubmitDispatch').addEventListener('click', async () => {
  const errEl = document.getElementById('dpErr');
  errEl.textContent = '';
  try {
    const res = await apiPost('/api/tasks/dispatch', {
      member: document.getElementById('dpMember').value,
      role: document.getElementById('dpRole').value,
      project_dir: document.getElementById('dpDir').value.trim(),
      title: document.getElementById('dpTitle').value.trim(),
      prompt: document.getElementById('dpPrompt').value.trim(),
      auto_fallback: document.getElementById('dpFallback').checked,
    });
    document.getElementById('modalDispatchBg').classList.remove('open');
    await loadOverview();
    if (res.task?.task_id) await openTask(res.task.task_id);
  } catch (err) { errEl.textContent = err.message; }
});

document.getElementById('btnOpenPlaybook').addEventListener('click', () => {
  document.getElementById('pbErr').textContent = '';
  document.getElementById('pbOut').style.display = 'none';
  document.getElementById('modalPlaybookBg').classList.add('open');
});
document.getElementById('btnRunPlaybook').addEventListener('click', async () => {
  const errEl = document.getElementById('pbErr');
  const outEl = document.getElementById('pbOut');
  errEl.textContent = '';
  outEl.style.display = 'block';
  outEl.textContent = '执行中...';
  try {
    const type = document.getElementById('pbType').value;
    const extra = document.getElementById('pbExtra').value.trim();
    const mRaw = document.getElementById('pbMembers').value.trim();
    const res = await apiPost('/api/playbooks/run', {
      playbook: type,
      project_dir: document.getElementById('pbDir').value.trim(),
      goal: document.getElementById('pbGoal').value.trim(),
      include: document.getElementById('pbInclude').value.trim() || null,
      members: mRaw ? mRaw.split(',').map(s => s.trim()).filter(Boolean) : null,
      session_query: type === 'research-and-pack' ? (extra || null) : null,
      ast_pattern: type === 'code-review-squad' ? (extra || null) : null,
    });
    outEl.textContent = JSON.stringify(res, null, 2);
    await loadOverview();
  } catch (err) { outEl.style.display = 'none'; errEl.textContent = err.message; }
});

document.getElementById('btnOpenMemory').addEventListener('click', () => {
  document.getElementById('mmErr').textContent = '';
  document.getElementById('modalMemoryBg').classList.add('open');
});
document.getElementById('btnSaveMemory').addEventListener('click', async () => {
  const errEl = document.getElementById('mmErr');
  errEl.textContent = '';
  try {
    await apiPost('/api/memory/write', {
      project: document.getElementById('mmProject').value.trim(),
      title: document.getElementById('mmTitle').value.trim(),
      tags: document.getElementById('mmTags').value.split(',').map(s => s.trim()).filter(Boolean),
      content: document.getElementById('mmContent').value.trim(),
      author: 'cockpit',
    });
    document.getElementById('mmTitle').value = '';
    document.getElementById('mmContent').value = '';
    document.getElementById('modalMemoryBg').classList.remove('open');
    await loadOverview();
  } catch (err) { errEl.textContent = err.message; }
});

document.getElementById('btnReindexCass').addEventListener('click', async () => {
  const btn = document.getElementById('btnReindexCass');
  const box = document.getElementById('sessList');
  btn.textContent = '索引中...';
  try {
    const res = await apiPost('/api/sessions/reindex', {});
    const c = res.stats?.conversations;
    const m = res.stats?.messages;
    box.innerHTML = '<div class="meta">✅ 索引已更新（' + (c ? (c + ' 会话 / ' + m + ' 消息') : '完成') + '）' + (res.partial ? ' · 已跳过写入中日志' : '') + '</div>';
    await loadOverview();
  } catch (err) { box.textContent = '索引失败: ' + err.message; }
  finally { btn.textContent = '更新索引'; }
});

const AGENT_PRESETS = {
  ollama: { id: 'ollama-qwen', name: 'Ollama Qwen2.5 Coder', driver: 'openai-http', roles: 'researcher,reviewer,synthesizer', config: { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5-coder:14b', api_key_env: '' } },
  deepseek: { id: 'deepseek-r1', name: 'DeepSeek Reasoner', driver: 'openai-http', roles: 'planner,reviewer,synthesizer', config: { base_url: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', api_key_env: 'DEEPSEEK_API_KEY' } },
  lmstudio: { id: 'lmstudio-local', name: 'LM Studio Local', driver: 'openai-http', roles: 'researcher,reviewer', config: { base_url: 'http://127.0.0.1:1234/v1', model: 'local-model', api_key_env: '' } },
  gemini: { id: 'gemini-cli', name: 'Gemini CLI', driver: 'generic-cli', roles: 'researcher,reviewer,synthesizer', config: { command: 'gemini', args: ['-p', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 120 } },
  aider: { id: 'aider-cli', name: 'Aider CLI', driver: 'generic-cli', roles: 'implementer,reviewer', config: { command: 'aider', args: ['--yes', '--message', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 180 } },
  cursor: { id: 'cursor-desktop', name: 'Cursor Desktop', driver: 'desktop-native', roles: 'planner,implementer,reviewer', config: {} },
};

document.addEventListener('click', async (ev) => {
  if (ev.target.id === 'drawerBg' || ev.target.closest('[data-close-drawer]')) {
    document.getElementById('drawerBg').classList.remove('open'); return;
  }
  if (ev.target.id === 'btnHotBackup') {
    const msg = document.getElementById('backupMsg');
    msg.textContent = '正在执行安全热备份 (VACUUM INTO)...';
    try {
      const b = await apiPost('/api/system/backup', {});
      msg.textContent = '✅ 热备份已生成: ' + b.backup_path + ' (' + Math.round(b.size_bytes / 1024) + 'KB，保留最近 ' + b.retained + ' 份)';
    } catch (err) { msg.textContent = '备份失败: ' + err.message; }
    return;
  }
  const togRaw = ev.target.closest('[data-toggle-raw]');
  if (togRaw) {
    const prefix = togRaw.getAttribute('data-toggle-raw');
    const rich = document.getElementById(prefix + 'Rich');
    const raw = document.getElementById(prefix + 'Raw');
    const showingRaw = raw.style.display !== 'none';
    raw.style.display = showingRaw ? 'none' : 'block';
    rich.style.display = showingRaw ? 'block' : 'none';
    togRaw.textContent = showingRaw ? '原始 MD' : '富文本预览';
    return;
  }
  const closeMod = ev.target.closest('[data-close-modal]');
  if (closeMod) { document.getElementById(closeMod.getAttribute('data-close-modal')).classList.remove('open'); return; }
  const delDag = ev.target.closest('[data-del-dag]');
  if (delDag) { syncDagFromDom(); dagSteps.splice(Number(delDag.getAttribute('data-del-dag')), 1); renderDagSteps(); return; }
  const dagTpl = ev.target.closest('[data-dag-tpl]');
  if (dagTpl) {
    const t = dagTpl.getAttribute('data-dag-tpl');
    dagSteps = t === 'debate'
      ? [
          { id: 'advocate', member: 'auto', role: 'planner', depends_on: [], prompt: '作为正方提出最优工程架构方案。' },
          { id: 'redteam', member: 'auto', role: 'reviewer', depends_on: [], prompt: '作为红队审查所有安全、竞态与维护陷阱。' },
          { id: 'verdict', member: 'auto', role: 'synthesizer', depends_on: ['advocate', 'redteam'], prompt: '综合正反观点给出最终决策与行动清单。' },
        ]
      : [
          { id: 'research', member: 'auto', role: 'researcher', depends_on: [], prompt: '调研当前模块代码结构与边界条件。' },
          { id: 'review', member: 'auto', role: 'reviewer', depends_on: ['research'], prompt: '基于调研结果指出核心缺陷与重构点。' },
          { id: 'summary', member: 'auto', role: 'synthesizer', depends_on: ['review'], prompt: '输出简洁中文总结与优先级建议。' },
        ];
    renderDagSteps();
    return;
  }
  const tkTab = ev.target.closest('[data-tk-tab]');
  if (tkTab) { openToolkitTab(tkTab.getAttribute('data-tk-tab')); return; }
  const openTk = ev.target.closest('[data-open-tk-tab]');
  if (openTk) { openToolkitTab(openTk.getAttribute('data-open-tk-tab')); return; }
  if (ev.target.closest('[data-focus-cass]')) { document.getElementById('sessQuery').focus(); return; }
  const fillEl = ev.target.closest('[data-fill-discovered]');
  if (fillEl) {
    const p = discoveredCache[Number(fillEl.getAttribute('data-fill-discovered'))];
    if (p) {
      document.getElementById('agId').value = p.agent_id;
      document.getElementById('agName').value = p.name;
      document.getElementById('agDriver').value = p.driver;
      document.getElementById('agRoles').value = (p.roles || []).join(',');
      document.getElementById('agConfig').value = JSON.stringify(p.config || {}, null, 2);
    }
    return;
  }
  const presetEl = ev.target.closest('[data-agent-preset]');
  if (presetEl) {
    const p = AGENT_PRESETS[presetEl.getAttribute('data-agent-preset')];
    if (p) {
      document.getElementById('agId').value = p.id;
      document.getElementById('agName').value = p.name;
      document.getElementById('agDriver').value = p.driver;
      document.getElementById('agRoles').value = p.roles;
      document.getElementById('agConfig').value = JSON.stringify(p.config, null, 2);
    }
    return;
  }
  const copyBatch = ev.target.closest('[data-copy-batch]');
  if (copyBatch) { navigator.clipboard?.writeText(window._lastBatchMd || '').catch(() => {}); copyBatch.textContent = '已复制'; return; }
  const openBatch = ev.target.closest('[data-open-batch]');
  if (openBatch) { openBatchReport(openBatch.getAttribute('data-open-batch')); return; }
  const noteEl = ev.target.closest('[data-open-note-slug]');
  if (noteEl) { openNote(noteEl.getAttribute('data-open-note-project'), noteEl.getAttribute('data-open-note-slug')); return; }
  const openEl = ev.target.closest('[data-open-task]');
  if (openEl) { openTask(openEl.getAttribute('data-open-task')); return; }
  const pollEl = ev.target.closest('[data-poll-task]');
  if (pollEl) {
    const tid = pollEl.getAttribute('data-poll-task');
    pollEl.textContent = '轮询中...';
    await apiPost('/api/tasks/poll', { task_id: tid, wait_sec: 0 }).catch(() => {});
    await loadOverview();
    await openTask(tid);
    return;
  }
  const testAg = ev.target.closest('[data-test-agent]');
  if (testAg) {
    const id = testAg.getAttribute('data-test-agent');
    testAg.textContent = '测试中...';
    await apiPost('/api/agents/test', { agent_id: id }).catch(() => {});
    await loadOverview();
    return;
  }
  const wtRev = ev.target.closest('[data-wt-review]');
  if (wtRev) { openWorktreeReview(wtRev.getAttribute('data-wt-review')); return; }
  const wtVer = ev.target.closest('[data-wt-verify]');
  if (wtVer) {
    const tid = wtVer.getAttribute('data-wt-verify');
    const out = document.getElementById('wtVerifyOut');
    wtVer.textContent = '测试运行中...';
    if (out) { out.style.display = 'block'; out.textContent = 'Running allowlisted test suite inside worktree...'; }
    try {
      const r = await apiPost('/api/worktrees/verify', { task_id: tid, preset: 'auto' });
      if (out) out.textContent = '[' + r.preset + ' | ' + r.status.toUpperCase() + ' | ' + r.duration_ms + 'ms]\\n' + (r.output || '(no output)');
      await loadOverview();
    } catch (err) {
      if (out) out.textContent = '验证失败: ' + err.message;
    } finally { wtVer.textContent = '🧪 运行测试验收'; }
    return;
  }
  const wtMerge = ev.target.closest('[data-wt-merge]');
  if (wtMerge) {
    const tid = wtMerge.getAttribute('data-wt-merge');
    const msgEl = document.getElementById('wtMergeMsg');
    try {
      await apiPost('/api/worktrees/merge', { task_id: tid, confirmed: true, cleanup: true });
      document.getElementById('drawerBg').classList.remove('open');
      await loadOverview();
    } catch (err) { if (msgEl) msgEl.textContent = err.message; }
    return;
  }
  const wtClean = ev.target.closest('[data-wt-cleanup]');
  if (wtClean) {
    await apiPost('/api/worktrees/cleanup', { task_id: wtClean.getAttribute('data-wt-cleanup'), force: false, delete_branch: false }).catch(e => alert(e.message));
    document.getElementById('drawerBg').classList.remove('open');
    await loadOverview();
    return;
  }
  const cdEl = ev.target.closest('[data-clear-cooldown]');
  if (cdEl) { await apiPost('/api/cooldown/clear', { member: cdEl.getAttribute('data-clear-cooldown') }).catch(() => {}); await loadOverview(); return; }
  const rmEl = ev.target.closest('[data-remove-agent]');
  if (rmEl) { await apiPost('/api/agents/remove', { agent_id: rmEl.getAttribute('data-remove-agent') }).catch(() => {}); await loadOverview(); return; }
  const recEl = ev.target.closest('[data-reconcile-task]');
  if (recEl) {
    const tid = recEl.getAttribute('data-reconcile-task');
    await apiPost('/api/tasks/reconcile', { task_id: tid, state: recEl.getAttribute('data-reconcile-state'), note: 'Updated from CollabHub v6 Workbench' });
    await loadOverview();
    await openTask(tid);
  }
});

loadWorkspacesAndRecipes();
loadOverview();
connectSse();
setInterval(loadOverview, 15000);
</script>
</body>
</html>`;

async function readBoundedJson(req, limitBytes = MAX_BODY_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) {
      throw Object.assign(new Error(`Request body exceeded ${limitBytes} bytes`), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch {
    throw Object.assign(new Error('Invalid JSON request body'), { statusCode: 400 });
  }
}

export function createDashboardServer(db, { host = DASHBOARD_HOST, port = DASHBOARD_PORT, dispatchDeps = {} } = {}) {
  let lastProbeAt = 0;
  let cachedCassStats = null;
  let cachedCassAt = 0;
  const sseClients = new Set();

  const onHubEvent = (evt) => {
    const frame = `data: ${JSON.stringify(evt)}\n\n`;
    for (const res of sseClients) {
      try { res.write(frame); } catch { sseClients.delete(res); }
    }
  };
  hubBus.on('hub-event', onHubEvent);

  const getCachedCass = async (force = false) => {
    const now = Date.now();
    if (!force && cachedCassStats && (now - cachedCassAt) < CASS_STATS_TTL_MS) return cachedCassStats;
    cachedCassStats = await getCassStats().catch(() => null);
    cachedCassAt = now;
    return cachedCassStats;
  };

  const baseHeaders = {
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
  };

  const sendJson = (res, status, obj) => {
    const body = JSON.stringify(obj, null, 2);
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const isAllowedHost = (hostHeader, actualPort) => {
    if (!hostHeader) return false;
    const h = String(hostHeader).toLowerCase();
    return h === `127.0.0.1:${actualPort}` || h === `localhost:${actualPort}` || h === `[::1]:${actualPort}`;
  };

  const isAllowedPostOrigin = (req, actualPort) => {
    const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
    if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false;
    const origin = req.headers.origin;
    if (origin) {
      const okOrigins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, `http://[::1]:${actualPort}`]);
      if (!okOrigins.has(String(origin).toLowerCase())) return false;
    }
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (!ct.includes('application/json')) return false;
    if (req.headers['x-collabhub-csrf'] !== '1') return false;
    return true;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const addr = server.address();
      const actualPort = (addr && typeof addr === 'object') ? addr.port : port;

      if (!isAllowedHost(req.headers.host, actualPort)) {
        sendJson(res, 421, { error: 'Misdirected Request: invalid Host header' });
        return;
      }

      const url = new URL(req.url || '/', `http://${host}:${actualPort}`);

      if (req.method === 'POST' && !isAllowedPostOrigin(req, actualPort)) {
        sendJson(res, 403, { error: 'Forbidden: cross-origin or missing CSRF/JSON headers' });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { ...baseHeaders, 'Content-Type': 'text/html; charset=utf-8' });
        res.end(DASHBOARD_HTML);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events/stream') {
        if (sseClients.size >= MAX_SSE_CLIENTS) {
          sendJson(res, 503, { error: 'Too many SSE subscribers' });
          return;
        }
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
        });
        res.write(`data: ${JSON.stringify({ type: 'connected', at: new Date().toISOString() })}\n\n`);
        sseClients.add(res);
        const hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 25000);
        hb.unref();
        req.on('close', () => { clearInterval(hb); sseClients.delete(res); });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        const lim = Math.max(1, Math.min(200, Number(url.searchParams.get('limit')) || 60));
        const events = db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?').all(lim);
        sendJson(res, 200, { count: events.length, events });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/workspaces') {
        sendJson(res, 200, { projects: listWorkspaceProjects(dispatchDeps.workspaceRoot) });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/recipes') {
        sendJson(res, 200, { recipes: listRecipes(db) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/recipes/save') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, { recipe: saveRecipe(db, { recipeId: parsed.recipe_id, title: parsed.title, role: parsed.role, tags: parsed.tags, prompt: parsed.prompt }) });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/recipes/delete') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, deleteRecipe(db, parsed.recipe_id));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/doctor') {
        sendJson(res, 200, await runSystemDoctor(db));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/system/backup') {
        await readBoundedJson(req);
        try {
          sendJson(res, 200, createHotBackup(db, dispatchDeps.backupDir ? { backupDir: dispatchDeps.backupDir } : {}));
        } catch (err) { sendJson(res, 500, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const mail = await probeMailHub();
        sendJson(res, 200, { ok: true, version: '1.0.0', pid: process.pid, uptime_s: Math.round(process.uptime()), db_path: DB_PATH, mail_hub: mail, toolkit: getToolkitStatus() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const [mail, cassStats] = await Promise.all([probeMailHub(), getCachedCass()]);
        const members = getMemberStatuses(db);
        const tasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 100').all().map(parseTaskRow);
        const batches = buildBatchSummaries(tasks);
        const worktrees = listWorktrees(db);
        const notes = listMemoryNotes(db, { limit: 12 });
        const notesCount = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_notes').get()?.c || notes.length);
        const metrics = buildMetrics(members, tasks, worktrees, notesCount, cassStats);
        const telemetry = computeAgentTelemetry(db, { days: 30 });
        sendJson(res, 200, { generated_at: new Date().toISOString(), mail_hub: mail, toolkit: getToolkitStatus(), metrics, telemetry, members, batches, tasks, worktrees, notes });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/agents/discover') {
        sendJson(res, 200, await discoverLocalAgents(db, dispatchDeps));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agents/test') {
        const parsed = await readBoundedJson(req);
        try {
          const ag = getAgent(db, parsed.agent_id);
          if (!ag) { sendJson(res, 404, { error: 'Agent not found' }); return; }
          const resProbe = await probeCustomAgent(ag);
          if (resProbe) upsertMemberStatus(db, resProbe);
          sendJson(res, 200, { result: resProbe });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/batches/') && url.pathname.endsWith('/report')) {
        const rawBatch = decodeURIComponent(url.pathname.slice('/api/batches/'.length, -'/report'.length));
        try { sendJson(res, 200, buildBatchMarkdownReport(db, rawBatch)); }
        catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
        const rawId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length));
        const safeId = assertValidTaskId(rawId, 'task_id');
        const task = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeId));
        if (!task) { sendJson(res, 404, { error: 'Task not found' }); return; }
        const events = db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 40').all(safeId);
        sendJson(res, 200, { task, events });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/dispatch') {
        const parsed = await readBoundedJson(req);
        try {
          const task = await dispatchBackgroundTask(db, {
            member: parsed.member,
            role: parsed.role || 'researcher',
            projectDir: parsed.project_dir,
            title: parsed.title,
            prompt: parsed.prompt,
            batchId: parsed.batch_id || null,
            autoFallback: Boolean(parsed.auto_fallback),
            waitSec: 0,
          }, dispatchDeps);
          sendJson(res, 200, { task });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/poll') {
        const parsed = await readBoundedJson(req);
        if (!parsed.task_id) { sendJson(res, 400, { error: 'task_id is required' }); return; }
        try {
          const waitSec = Math.max(0, Math.min(15, Number(parsed.wait_sec) || 0));
          const task = await pollBackgroundTask(db, parsed.task_id, { waitSec }, dispatchDeps);
          sendJson(res, 200, { task });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/playbooks/run') {
        const parsed = await readBoundedJson(req);
        try {
          const result = await runPlaybook(db, {
            playbook: parsed.playbook, projectDir: parsed.project_dir, goal: parsed.goal || '',
            members: parsed.members || null, include: parsed.include || null,
            astPattern: parsed.ast_pattern || null, astLang: parsed.ast_lang || null,
            docPath: parsed.doc_path || null, sessionQuery: parsed.session_query || null,
          }, dispatchDeps);
          sendJson(res, 200, result);
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/workflows/run') {
        const parsed = await readBoundedJson(req);
        try {
          const result = await runDagWorkflow(db, {
            name: parsed.name || 'ui-dag',
            batchId: parsed.batch_id || null,
            projectDir: parsed.project_dir,
            steps: parsed.steps || [],
            waitSec: Math.max(0, Math.min(30, Number(parsed.wait_sec) || 0)),
            saveReportToMemory: parsed.save_report_to_memory !== false,
          }, dispatchDeps);
          sendJson(res, 200, result);
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/toolkit/ast') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, await searchAstGrep({ projectDir: parsed.project_dir, pattern: parsed.pattern, lang: parsed.lang || null, maxMatches: 60, workspaceRoot: dispatchDeps.workspaceRoot, extraRoots: dispatchDeps.extraRoots }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/toolkit/pack') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, await packRepoRepomix({ projectDir: parsed.project_dir, include: parsed.include || null, compress: true, maxChars: 48000, workspaceRoot: dispatchDeps.workspaceRoot, extraRoots: dispatchDeps.extraRoots }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/toolkit/doc2md') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, await convertDocToMd({ filePath: parsed.file_path, maxChars: 32000, workspaceRoot: dispatchDeps.workspaceRoot, extraRoots: dispatchDeps.extraRoots }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/toolkit/beads') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, await runBeads({ projectDir: parsed.project_dir, action: parsed.action, title: parsed.title || null, issueId: parsed.issue_id || null, workspaceRoot: dispatchDeps.workspaceRoot, extraRoots: dispatchDeps.extraRoots }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/worktrees/review') {
        const parsed = await readBoundedJson(req);
        try { sendJson(res, 200, reviewWorktree(db, { taskId: parsed.task_id, maxDiffChars: 16000 })); }
        catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/worktrees/verify') {
        const parsed = await readBoundedJson(req);
        try { sendJson(res, 200, await verifyWorktree(db, { taskId: parsed.task_id, preset: parsed.preset || 'auto', timeoutSec: parsed.timeout_sec || 90 })); }
        catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/worktrees/merge') {
        const parsed = await readBoundedJson(req);
        try {
          const wtBefore = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(parsed.task_id);
          const merged = mergeWorktree(db, { taskId: parsed.task_id, confirmed: parsed.confirmed === true, cleanup: parsed.cleanup !== false });
          if (wtBefore) await releaseMailPaths({ projectDir: wtBefore.repo_dir, member: wtBefore.member }).catch(() => {});
          sendJson(res, 200, merged);
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/worktrees/cleanup') {
        const parsed = await readBoundedJson(req);
        try {
          const wtBefore = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(parsed.task_id);
          const cleaned = cleanupWorktree(db, { taskId: parsed.task_id, force: Boolean(parsed.force), deleteBranch: Boolean(parsed.delete_branch) });
          if (wtBefore) await releaseMailPaths({ projectDir: wtBefore.repo_dir, member: wtBefore.member }).catch(() => {});
          sendJson(res, 200, cleaned);
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/reconcile') {
        const parsed = await readBoundedJson(req);
        if (!parsed.task_id) { sendJson(res, 400, { error: 'task_id is required' }); return; }
        if (!['rerouted', 'failed', 'uncertain', 'stalled'].includes(parsed.state)) {
          sendJson(res, 400, { error: 'UI reconcile supports state in [rerouted, failed, uncertain, stalled]' });
          return;
        }
        try {
          sendJson(res, 200, { task: reconcileTask(db, { taskId: parsed.task_id, state: parsed.state, note: parsed.note || 'Updated from dashboard' }) });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agents/register') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, {
            agent: registerAgent(db, {
              agentId: parsed.agent_id, name: parsed.name, driver: parsed.driver,
              roles: parsed.roles || ['researcher', 'reviewer'], capabilities: parsed.capabilities || [], config: parsed.config || {},
            }),
          });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/agents/remove') {
        const parsed = await readBoundedJson(req);
        try { sendJson(res, 200, removeAgent(db, parsed.agent_id)); }
        catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/probe') {
        await readBoundedJson(req);
        const now = Date.now();
        if (now - lastProbeAt < PROBE_MIN_INTERVAL_MS) {
          sendJson(res, 200, {
            throttled: true,
            retry_after_s: Math.ceil((PROBE_MIN_INTERVAL_MS - (now - lastProbeAt)) / 1000),
            members: getMemberStatuses(db),
            mail_hub: await probeMailHub(),
          });
          return;
        }
        lastProbeAt = now;
        sendJson(res, 200, await probeAllMembers(db));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/cooldown/clear') {
        const parsed = await readBoundedJson(req);
        try { assertValidAgentId(parsed.member); } catch { sendJson(res, 400, { error: 'Invalid member id' }); return; }
        if (!isRegisteredAgent(db, parsed.member)) { sendJson(res, 400, { error: `Unknown agent: ${parsed.member}` }); return; }
        sendJson(res, 200, clearMemberCooldown(db, parsed.member));
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/memory') {
        const q = url.searchParams.get('q') || '';
        const project = url.searchParams.get('project') || null;
        const results = q ? searchMemoryNotes(db, { query: q, project }) : listMemoryNotes(db, { project, limit: 20 });
        sendJson(res, 200, { query: q, results });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/memory/note') {
        const project = url.searchParams.get('project') || '';
        const slug = url.searchParams.get('slug') || '';
        if (!project || !slug) { sendJson(res, 400, { error: 'project and slug are required' }); return; }
        const note = db.prepare('SELECT * FROM memory_notes WHERE project = ? AND slug = ?').get(project, slug);
        if (!note) { sendJson(res, 404, { error: 'Note not found' }); return; }
        sendJson(res, 200, { note });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/memory/write') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, {
            note: writeMemoryNote(db, {
              project: parsed.project, slug: parsed.slug, title: parsed.title, content: parsed.content,
              tags: parsed.tags || [], author: parsed.author || 'cockpit', memoryDir: dispatchDeps.memoryDir,
            }),
          });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const q = url.searchParams.get('q') || '';
        if (!q.trim()) { sendJson(res, 400, { ok: false, error: 'q is required' }); return; }
        sendJson(res, 200, await searchSessionsCass({ query: q, limit: 8 }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/sessions/reindex') {
        await readBoundedJson(req);
        const data = await reindexSessionsCass({ full: false });
        await getCachedCass(true);
        sendJson(res, 200, data);
        return;
      }
      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      sendJson(res, err.statusCode || 500, { error: String(err.message || err) });
    }
  });

  server.on('close', () => {
    hubBus.off('hub-event', onHubEvent);
    for (const res of sseClients) { try { res.end(); } catch {} }
    sseClients.clear();
  });

  return server;
}

function startReadOnlyAutoPoller(db) {
  let busy = false;
  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      const running = db.prepare(`
        SELECT task_id FROM tasks
        WHERE state = 'running' AND channel IN ('dsh-baton', 'muse-tailnet', 'claude-cli')
        ORDER BY updated_at ASC LIMIT 6
      `).all();
      for (const r of running) {
        await pollBackgroundTask(db, r.task_id, { waitSec: 0 }).catch(() => {});
      }
    } catch { /* best-effort */ }
    finally { busy = false; }
  };
  return setInterval(tick, AUTO_POLL_INTERVAL_MS).unref();
}

function startPeriodicCassRefresh() {
  let busy = false;
  return setInterval(async () => {
    if (busy) return;
    busy = true;
    try { await reindexSessionsCass({ full: false }); } catch {}
    finally { busy = false; }
  }, CASS_REFRESH_INTERVAL_MS).unref();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  ensureRuntimeDirs();
  const db = openHubDb();
  const server = createDashboardServer(db);
  server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    console.log(JSON.stringify({ event: 'dashboard.listening', version: '1.0.0', url: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`, pid: process.pid }));
    probeAllMembers(db).catch(() => {});
    startReadOnlyAutoPoller(db);
    startPeriodicCassRefresh();
  });
}
