/**
 * CollabHub v1.5.0 — Precision Mission Control Studios Controller (Zero Dependencies)
 *
 * Powers the 3 brand-new multi-agent studios + Overview Bento strip + collapsible icon rail:
 *   1. All-Agent MCP Hub & Meta-MCP Lazy Tool Router
 *   2. Cross-Agent Skills & Rules Sync Center (Dry-Run Diff + .bak Confirm)
 *   3. Worktree Inline Diff Comments, Targeted Rework & Serialized Merge Queue
 */
'use strict';

const RAIL_KEY = 'collabhub.railCollapsed';

const STUDIO_I18N = {
  en: {
    'nav.studios': 'Multi-Agent Studios',
    'nav.mcphub': 'MCP Hub',
    'nav.mcphubAlt': 'MCP 中心',
    'nav.skills': 'Skills & Rules',
    'nav.skillsAlt': '技能与规范',
    'nav.worktrees': 'Worktrees & Queue',
    'nav.worktreesAlt': '分支与合并队列',
    'quick.mcphub': 'MCP Hub',
    'quick.skills': 'Skills & Rules',
    'quick.queue': 'Merge Queue',
    'view.mcphub.title': 'MCP Hub & Meta-MCP Gateway',
    'view.mcphub.sub': 'Multi-client config matrix, zero-secret probe, lazy tool router & Dry-Run .bak sync',
    'view.skills.title': 'Skills & Rules Sync Center',
    'view.skills.sub': 'Unify SKILL.md and AGENTS.md / CLAUDE.md / GEMINI.md / .cursor/rules across agents',
    'view.worktrees.sub': 'Inline diff comments · targeted rework · speculative merge queue',
    'bento.mcpTitle': 'All-Agent MCP Hub',
    'bento.mcpSub': '{servers} servers · {clients} clients · {tools} cached tools',
    'bento.mcpDrift': '{n} drifted',
    'bento.mcpClean': 'All aligned',
    'bento.skillsTitle': 'Skills & Rules Sync',
    'bento.skillsSub': 'Unify SKILL.md & AGENTS.md / CLAUDE.md across clients',
    'bento.skillsTag': 'Dry-Run + .bak',
    'bento.mqTitle': 'Agent Merge Queue',
    'bento.mqSub': '{ready} ready · {conflict} conflict · {comments} open diff comments',
    'bento.open': 'Open Studio →',
    'radar.title': 'Neural Fleet Constellation & 4-Host Native Cockpits',
    'radar.sub': '60fps live agent topology — also embedded natively inside Antigravity, Claude Desktop, Codex Desktop (MCP App) and CLI/WSL DSH (24-bit TUI + StatusLine HUD).',
    'radar.openCockpit': 'Preview MCP App →',
    'radar.hint': 'Click any orbiting agent node · pauses automatically when tab is hidden',
    'mcp.title': 'All-Agent MCP Hub & Meta-MCP Gateway',
    'mcp.sub': 'Unified zero-secret registry, drift matrix across Antigravity / Codex / Claude / Cursor / VS Code, lazy tool router, and Dry-Run .bak safe sync.',
    'mcp.refresh': 'Scan clients',
    'mcp.import': 'Import discovered',
    'mcp.register': '+ Register MCP',
    'mcp.matrixTitle': 'Cross-Client MCP Drift Matrix',
    'mcp.matrixSub': 'Compare canonical server definitions against local client configs. Raw env/header values are never stored or echoed.',
    'mcp.tabRouter': 'Meta-MCP Lazy Tool Router',
    'mcp.tabSync': 'Safe Client Sync (Dry-Run + .bak)',
    'mcp.tabSnippet': 'Zero-Secret Snippets',
    'mcp.toolSearchPh': 'Search tools across all probed MCP servers (e.g. search, worktree, git)…',
    'mcp.findTools': 'Discover tools',
    'mcp.proxyArgs': 'JSON Arguments',
    'mcp.proxyRun': 'Invoke via Meta-MCP Gateway',
    'mcp.syncClient': 'Target local AI client',
    'mcp.syncDry': '1. Preview Dry-Run Diff',
    'mcp.syncApply': '2. Confirm & Write (.bak)',
    'mcp.snippetClient': 'Client format',
    'mcp.genSnippet': 'Generate',
    'mcp.modalTitle': 'Register canonical MCP server',
    'mcp.modalSub': 'Zero-secret registry: pass env var names only, never literal API keys.',
    'mcp.fId': 'Server ID',
    'mcp.fName': 'Display Name',
    'mcp.fTransport': 'Transport',
    'mcp.fGroup': 'Logical Group',
    'mcp.fCommand': 'Command',
    'mcp.fArgs': 'Args (JSON array or space-separated)',
    'mcp.fUrl': 'Endpoint URL (https:// or loopback http://)',
    'mcp.fEnvKeys': 'Env var names (comma-separated, NO values)',
    'mcp.fTags': 'Tags',
    'mcp.save': 'Save MCP Server',
    'mcp.kpiServers': 'MCP Servers',
    'mcp.kpiClients': 'Clients Detected',
    'mcp.kpiDrift': 'Config Drifts',
    'mcp.kpiTools': 'Meta-MCP Tools',
    'mcp.probe': 'Probe',
    'mcp.probing': 'Probing…',
    'mcp.remove': 'Remove',
    'mcp.empty': 'No MCP servers discovered or registered yet. Click “Scan clients” or “+ Register MCP”.',
    'mcp.toolsMeta': '{matched} matched across {servers} probed server(s) ({total} indexed tools)',
    'mcp.toolsEmpty': 'No cached tools match your query yet. Probe an MCP server above to index its tools for lazy routing.',
    'mcp.callBtn': 'Call lazily →',
    'skills.title': 'Cross-Agent Skills & Rules Sync Center',
    'skills.sub': 'Keep SKILL.md capabilities and AGENTS.md / CLAUDE.md / GEMINI.md / .cursor/rules aligned across every coding agent with Dry-Run diffs and .bak backups.',
    'skills.refresh': 'Rescan assets',
    'skills.tabSkills': 'Skills (SKILL.md Matrix)',
    'skills.tabRules': 'Project Rules & Instructions',
    'skills.confirmSync': 'Confirm & Apply (.bak)',
    'skills.kpiSkills': 'Skills Found',
    'skills.kpiClients': 'Skill Clients',
    'skills.kpiDrift': 'Skill Drifts',
    'skills.kpiRules': 'Project Rules',
    'skills.syncBtn': 'Dry-Run Sync',
    'skills.empty': 'No SKILL.md directories discovered yet across Antigravity / Claude / Codex / Cursor.',
    'skills.ruleSyncFrom': 'Sync to other rules',
    'mq.title': 'Serialized Agent Merge Queue',
    'mq.sub': 'Side-effect-free speculative `git merge-tree` pre-flight check catches cross-worktree collisions before touching `main`.',
    'mq.validate': 'Speculative Check',
    'mq.process': 'Confirm & Merge Ready',
    'mq.enqueue': '+ Merge Queue',
    'mq.empty': 'Merge Queue is empty. Enqueue verified active worktrees below to run speculative conflict checks.',
    'mq.remove': 'Remove',
    'wt.step1.title': 'Inline Diff Comments',
    'wt.step1.desc': 'Click any diff line to attach feedback and dispatch targeted rework directly to the agent worktree.',
    'wt.step2.title': 'Verify Gate & Speculative Queue',
    'wt.step2.desc': 'Run isolated tests and speculative git merge-tree across queued branches to prevent semantic collisions.',
    'wt.step3.title': 'Serialized Merge / Cleanup',
    'wt.step3.desc': 'Merge SHA-pinned verified branches in order into main, then release Mail leases cleanly.',
    'cmt.title': 'Inline Diff Comments ({n} open)',
    'cmt.hint': 'Click any code line in the diff below to pin a file:line comment.',
    'cmt.sendRework': 'Send {n} Open Comments to Agent (Rework)',
    'cmt.empty': 'No inline review comments yet — click a diff line below to add one.',
    'cmt.addTitle': 'Add comment at {file}:{line}',
    'cmt.placeholder': 'Describe the exact fix needed on this line…',
    'cmt.submit': 'Pin Comment',
    'cmt.resolve': 'Resolve',
    'cmt.reopen': 'Reopen',
  },
  zh: {
    'nav.studios': '多 Agent 协作工作台',
    'nav.mcphub': 'MCP 中心',
    'nav.mcphubAlt': 'MCP Hub',
    'nav.skills': 'Skills & Rules 同步',
    'nav.skillsAlt': 'Skills & Rules',
    'nav.worktrees': 'Worktrees & 合并队列',
    'nav.worktreesAlt': 'Worktrees & Queue',
    'quick.mcphub': 'MCP 中心',
    'quick.skills': 'Skills 同步',
    'quick.queue': '合并队列',
    'view.mcphub.title': '全 Agent MCP 中心与 Meta-MCP 网关',
    'view.mcphub.sub': '跨端配置矩阵、零密钥探活、Meta-MCP 懒加载工具路由与 Dry-Run .bak 安全同步',
    'view.skills.title': '跨 Agent Skills / Rules 同步中心',
    'view.skills.sub': '统一管理并安全同步 SKILL.md、AGENTS.md、CLAUDE.md、GEMINI.md 与 .cursor/rules',
    'view.worktrees.sub': '行级 Diff 批注返工 · 隔离测试闸门 · 串行预演合并队列',
    'bento.mcpTitle': '全 Agent MCP 中心',
    'bento.mcpSub': '{servers} 个服务 · {clients} 个本机端 · {tools} 个缓存工具',
    'bento.mcpDrift': '{n} 处漂移',
    'bento.mcpClean': '全部一致',
    'bento.skillsTitle': 'Skills & Rules 同步中心',
    'bento.skillsSub': '跨 Antigravity / Claude / Codex / Cursor 统一技能与规范',
    'bento.skillsTag': '预演 + .bak 备份',
    'bento.mqTitle': '串行合并队列',
    'bento.mqSub': '{ready} 个就绪 · {conflict} 个冲突 · {comments} 条待处理批注',
    'bento.open': '进入工作台 →',
    'radar.title': '神经舰队拓扑雷达与四端宿主原生驾驶舱',
    'radar.sub': '60fps 实时多 Agent 轨道拓扑 —— 已同步内嵌至 Antigravity、Claude Desktop、Codex Desktop（MCP App）与终端/WSL DSH（24-bit 真彩 TUI + StatusLine HUD）。',
    'radar.openCockpit': '预览 MCP App →',
    'radar.hint': '点击任意轨道节点查看 Agent · 后台标签自动休眠零耗电',
    'mcp.title': '全 Agent MCP 中心与 Meta-MCP 懒加载网关',
    'mcp.sub': '跨 Antigravity / Codex / Claude / Cursor / VS Code 扫描漂移、零明文密钥、Meta-MCP 按需搜调工具、Dry-Run 差异预演 + .bak 备份安全写回。',
    'mcp.refresh': '扫描客户端',
    'mcp.import': '导入已发现服务',
    'mcp.register': '+ 注册 MCP',
    'mcp.matrixTitle': '跨端 MCP 配置与漂移矩阵',
    'mcp.matrixSub': '对比规范注册表与各客户端配置；绝不落盘或回显明文环境变量与请求头密钥。',
    'mcp.tabRouter': 'Meta-MCP 懒加载路由',
    'mcp.tabSync': '安全写回客户端（预演 + .bak）',
    'mcp.tabSnippet': '零密钥配置片段',
    'mcp.toolSearchPh': '按关键词检索所有已探活 MCP 的工具（如 search、worktree、git）…',
    'mcp.findTools': '按需发现工具',
    'mcp.proxyArgs': '调用参数 JSON',
    'mcp.proxyRun': '通过 Meta-MCP 网关调用',
    'mcp.syncClient': '目标本机 AI 客户端',
    'mcp.syncDry': '1. 预演差异 (Dry-Run)',
    'mcp.syncApply': '2. 确认写回 (.bak 备份)',
    'mcp.snippetClient': '客户端格式',
    'mcp.genSnippet': '生成片段',
    'mcp.modalTitle': '注册规范 MCP 服务',
    'mcp.modalSub': '零明文安全策略：仅填写环境变量名，绝不存储真实 API Key。',
    'mcp.fId': '服务 ID',
    'mcp.fName': '展示名称',
    'mcp.fTransport': '传输协议',
    'mcp.fGroup': '逻辑分组',
    'mcp.fCommand': '启动命令',
    'mcp.fArgs': '参数（JSON 数组或空格分隔）',
    'mcp.fUrl': '服务地址（远程须 https://，本机允许 loopback http://）',
    'mcp.fEnvKeys': '环境变量名（逗号分隔，仅填键名）',
    'mcp.fTags': '标签',
    'mcp.save': '保存 MCP 服务',
    'mcp.kpiServers': 'MCP 服务总数',
    'mcp.kpiClients': '检测到客户端',
    'mcp.kpiDrift': '配置漂移项',
    'mcp.kpiTools': 'Meta-MCP 工具库',
    'mcp.probe': '探活',
    'mcp.probing': '探活中…',
    'mcp.remove': '移除',
    'mcp.empty': '尚未发现或注册任何 MCP 服务。点击「扫描客户端」或「+ 注册 MCP」。',
    'mcp.toolsMeta': '匹配 {matched} 个工具（共 {servers} 个已探活服务 / {total} 个已索引工具）',
    'mcp.toolsEmpty': '暂无匹配的工具缓存。先对上方任意 MCP 点击「探活」即可按需检索。',
    'mcp.callBtn': '按需调用 →',
    'skills.title': '跨 Agent Skills / Rules 同步中心',
    'skills.sub': '统一发现并安全同步 SKILL.md 技能包与 AGENTS.md / CLAUDE.md / GEMINI.md / .cursor/rules，支持 Dry-Run 差异对比与 .bak 自动备份。',
    'skills.refresh': '重新扫描资产',
    'skills.tabSkills': 'Skills 跨端矩阵 (SKILL.md)',
    'skills.tabRules': '项目规范文件 (Rules)',
    'skills.confirmSync': '确认同步并写入 (.bak)',
    'skills.kpiSkills': '发现 Skills',
    'skills.kpiClients': '技能目录端',
    'skills.kpiDrift': '技能漂移项',
    'skills.kpiRules': '项目规范数',
    'skills.syncBtn': '预演同步',
    'skills.empty': '暂未在 Antigravity / Claude / Codex / Cursor 目录中发现 SKILL.md。',
    'skills.ruleSyncFrom': '同步至其他规范',
    'mq.title': '串行 Agent 合并队列 (Merge Queue)',
    'mq.sub': '使用零副作用 `git merge-tree` 累计预演合并，在真正改动 `main` 前揪出多 Worktree 交叉冲突。',
    'mq.validate': '累计冲突预演',
    'mq.process': '确认串行合并就绪项',
    'mq.enqueue': '+ 加入合并队列',
    'mq.empty': '合并队列为空。在下方已验证的 Worktree 点击「+ 加入合并队列」即可启动预演。',
    'mq.remove': '移出队列',
    'wt.step1.title': '行级 Diff 批注返工',
    'wt.step1.desc': '点击任意代码行添加批注，一键打回原 Agent 在该隔离 Worktree 内精准修改。',
    'wt.step2.title': '测试闸门 + 累计冲突预演',
    'wt.step2.desc': '隔离单测通过后入队，通过 git merge-tree 提前发现并发分支间的隐性冲突。',
    'wt.step3.title': '串行安全合并与清理',
    'wt.step3.desc': '按优先级与 SHA 锚定顺序依次合入主干，并自动释放文件租约。',
    'cmt.title': '行级 Diff 批注（{n} 条待处理）',
    'cmt.hint': '点击下方任意 Diff 代码行，即可按「文件:行号」精准添加批注。',
    'cmt.sendRework': '将 {n} 条批注打回 Agent 返工',
    'cmt.empty': '暂无行级批注 —— 点击下方 Diff 代码行即可添加。',
    'cmt.addTitle': '批注位置：{file}:{line}',
    'cmt.placeholder': '写明这一行需要修改的具体问题或期望实现…',
    'cmt.submit': '保存批注',
    'cmt.resolve': '标记已解决',
    'cmt.reopen': '重新打开',
  },
};

export function registerStudioI18n(I18N) {
  Object.assign(I18N.en, STUDIO_I18N.en);
  Object.assign(I18N.zh, STUDIO_I18N.zh);
}

/* ------------------------------------------------------------------ */
/* Rich Demo Fixtures for Static / ?demo=1 Preview                     */
/* ------------------------------------------------------------------ */

function buildDemoMcpHub() {
  return {
    scanned_at: new Date().toISOString(),
    clients: [
      { id: 'antigravity', name: 'Antigravity', format: 'json', exists: true, servers_count: 4, secret_inline_count: 0 },
      { id: 'codex', name: 'Codex', format: 'toml', exists: true, servers_count: 3, secret_inline_count: 0 },
      { id: 'claude-code', name: 'Claude Code', format: 'json', exists: true, servers_count: 3, secret_inline_count: 0 },
      { id: 'cursor', name: 'Cursor', format: 'json', exists: false, servers_count: 0, secret_inline_count: 0 },
    ],
    servers: [
      {
        id: 'collab-hub', name: 'CollabHub', transport: 'stdio', command: 'node', args: ['src/mcp-server.mjs'],
        url: null, env_keys: [], header_keys: [], group_name: 'core', tags: ['orchestration'], registered: true, enabled: true,
        secret_inline: false, last_probe_ok: true, last_probe_tools_count: 43,
        last_probe_tools: [
          { name: 'collab_dispatch', description: 'Dispatch bounded background task to any registered agent' },
          { name: 'collab_mcp_find_tools', description: 'Meta-MCP lazy tool discovery across all probed servers' },
          { name: 'collab_merge_queue', description: 'Speculative git merge-tree conflict check & serialized merge queue' },
          { name: 'collab_skills_hub', description: 'Cross-agent SKILL.md and AGENTS.md/CLAUDE.md sync' },
        ],
        client_presence: { antigravity: 'present', codex: 'present', 'claude-code': 'present' },
      },
      {
        id: 'mcp-agent-mail', name: 'Agent Mail', transport: 'http', command: null, args: [],
        url: 'http://127.0.0.1:5291/mcp', env_keys: [], header_keys: [], group_name: 'core', tags: ['mail', 'leases'], registered: true, enabled: true,
        secret_inline: false, last_probe_ok: true, last_probe_tools_count: 18,
        last_probe_tools: [
          { name: 'file_reservation_paths', description: 'Acquire advisory file lease before concurrent edits' },
          { name: 'send_message', description: 'Send threaded update to peer agents' },
        ],
        client_presence: { antigravity: 'present', codex: 'present', 'claude-code': 'present' },
      },
      {
        id: 'github-mcp', name: 'GitHub MCP', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'],
        url: null, env_keys: ['GITHUB_PERSONAL_ACCESS_TOKEN'], header_keys: [], group_name: 'vcs', tags: ['git'], registered: true, enabled: true,
        secret_inline: false, last_probe_ok: true, last_probe_tools_count: 8,
        last_probe_tools: [
          { name: 'search_repositories', description: 'Search GitHub repositories by topic or query' },
          { name: 'create_pull_request', description: 'Create a pull request from a verified branch' },
        ],
        client_presence: { antigravity: 'present', codex: 'drifted', 'claude-code': 'missing' },
      },
      {
        id: 'filesystem', name: 'Filesystem', transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/workspace'],
        url: null, env_keys: [], header_keys: [], group_name: 'local', tags: ['fs'], registered: false, enabled: true,
        secret_inline: false, last_probe_ok: null, last_probe_tools_count: null, last_probe_tools: [],
        client_presence: { antigravity: 'present', codex: 'missing', 'claude-code': 'present' },
      },
    ],
    summary: { total_servers: 4, registered_count: 3, clients_detected: 3, synced_pairs: 9, drift_count: 1, cached_tools_total: 8 },
  };
}

function buildDemoSkillsHub() {
  return {
    scanned_at: new Date().toISOString(),
    project_name: 'collab-demo',
    clients: [
      { id: 'antigravity', name: 'Antigravity', exists: true, skills_count: 3 },
      { id: 'claude', name: 'Claude Code', exists: true, skills_count: 2 },
      { id: 'codex', name: 'Codex', exists: true, skills_count: 2 },
      { id: 'cursor', name: 'Cursor', exists: false, skills_count: 0 },
    ],
    skills: [
      {
        name: 'worktree-review', title: 'worktree-review',
        description: 'Structured inline diff review and merge-queue pre-flight checklist for coding agents.',
        canonical_client: 'antigravity', canonical_hash: '7f41c8a9e2b1034d', bytes: 2480, files_count: 2,
        client_presence: { antigravity: 'present', claude: 'present', codex: 'drifted', cursor: 'missing' },
      },
      {
        name: 'multi-agent-handoff', title: 'multi-agent-handoff',
        description: 'Zero-ambiguity cross-model handoff contract with receipt IDs and file leases.',
        canonical_client: 'antigravity', canonical_hash: '3a90e5c1f4028b19', bytes: 3120, files_count: 3,
        client_presence: { antigravity: 'present', claude: 'present', codex: 'present', cursor: 'missing' },
      },
      {
        name: 'release-hygiene', title: 'release-hygiene',
        description: 'Privacy scan, zero-dep test suite verification, and changelog drafting before tagging.',
        canonical_client: 'antigravity', canonical_hash: '9c114d72ab84e01c', bytes: 1840, files_count: 1,
        client_presence: { antigravity: 'present', claude: 'missing', codex: 'missing', cursor: 'missing' },
      },
    ],
    rules: [
      { id: 'agents-md', name: 'AGENTS.md (Universal / AGY / Codex)', rel_path: 'AGENTS.md', dialect: 'markdown', exists: true, status: 'present', hash: 'b82c41e09a7f3120', bytes: 3840, preview: '# Workspace Collaboration Preferences\n\n- Prefer zero-dep adaptations of maintained MIT/Apache-2.0 repos.\n- Always isolate parallel edits in Git worktrees.' },
      { id: 'claude-md', name: 'CLAUDE.md (Claude Code)', rel_path: 'CLAUDE.md', dialect: 'markdown', exists: true, status: 'drifted', hash: '5190fe124a8c7711', bytes: 2910, preview: '# Claude Code Guidelines\n\n- Run `node --test` before finishing.\n- Missing latest Merge Queue rules.' },
      { id: 'gemini-md', name: 'GEMINI.md (Gemini CLI / AGY)', rel_path: 'GEMINI.md', dialect: 'markdown', exists: false, status: 'missing', hash: null, bytes: 0, preview: '' },
      { id: 'cursor-rules', name: '.cursor/rules/project.mdc (Cursor)', rel_path: '.cursor/rules/project.mdc', dialect: 'mdc', exists: false, status: 'missing', hash: null, bytes: 0, preview: '' },
    ],
    canonical_rule_id: 'agents-md',
    summary: { skills_total: 3, clients_detected: 3, skill_synced_pairs: 6, skill_drift_count: 1, rules_detected: 2, rules_drifted: 1 },
  };
}

function buildDemoComments() {
  return [
    {
      id: 101, task_id: 'demo-wt-01', file_path: 'src/example.mjs', line_no: 15, side: 'new',
      author: 'reviewer', body: 'Guard against empty strings after trim() and add a unit test for whitespace-only input.',
      status: 'open', rework_task_id: null, created_at: new Date(Date.now() - 420_000).toISOString(),
    },
    {
      id: 102, task_id: 'demo-wt-01', file_path: 'src/example.mjs', line_no: 11, side: 'new',
      author: 'reviewer', body: 'Nice template literal cleanup — matches repo style.',
      status: 'resolved', rework_task_id: null, created_at: new Date(Date.now() - 900_000).toISOString(),
    },
  ];
}

/* ------------------------------------------------------------------ */
/* Main Studio Controller Factory                                      */
/* ------------------------------------------------------------------ */

export function createStudiosController(ctx) {
  const { $, $$, esc, t, state, apiGet, apiPost, toast, setView, openModal, closeModal, loadOverview } = ctx;

  const sState = {
    mcp: null,
    mcpSyncPlan: null,
    mcpTools: [],
    mcpActiveTool: null,
    skills: null,
    skillsSyncPending: null,
    mergeQueue: [],
    commentsByTask: new Map(),
    demoComments: buildDemoComments(),
    activeDiffTaskId: null,
    activeDiffPin: null,
  };

  /* ---------- Collapsible Navigation Rail ---------- */
  function applyRailCollapsed(collapsed) {
    const shell = $('#appShell');
    if (shell) shell.classList.toggle('rail-collapsed', Boolean(collapsed));
    try { localStorage.setItem(RAIL_KEY, collapsed ? '1' : '0'); } catch {}
  }

  function initRail() {
    let saved = false;
    try { saved = localStorage.getItem(RAIL_KEY) === '1'; } catch {}
    applyRailCollapsed(saved);
    $('#btnCollapseRail')?.addEventListener('click', () => {
      const next = !$('#appShell')?.classList.contains('rail-collapsed');
      applyRailCollapsed(next);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
      const next = !$('#appShell')?.classList.contains('rail-collapsed');
      applyRailCollapsed(next);
    });
  }

  /* ---------- Overview 60fps Neural Fleet Constellation Canvas ---------- */
  let ovRadarPhase = 0;
  let ovRadarRaf = null;
  const ovRadarNodes = [];
  const reducedMotion = typeof window !== 'undefined' && window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function drawOverviewConstellation() {
    const canvas = $('#ovFleetCanvas');
    if (!canvas) return;
    if (state.view !== 'overview') return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = canvas.clientWidth || 560;
    const h = canvas.clientHeight || 228;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, w, h);

    const cx = w * 0.5;
    const cy = h * 0.5;
    const rx = Math.min(w * 0.37, 210);
    const ry = Math.min(h * 0.36, 82);
    const isLight = document.documentElement.dataset.theme === 'light';

    // Concentric orbital guides
    ctx2d.strokeStyle = isLight ? 'rgba(79, 70, 229, 0.14)' : 'rgba(129, 140, 248, 0.16)';
    ctx2d.lineWidth = 1;
    for (const s of [0.52, 1.0]) {
      ctx2d.beginPath();
      ctx2d.ellipse(cx, cy, rx * s, ry * s, 0, 0, Math.PI * 2);
      ctx2d.stroke();
    }

    const members = state.members || [];
    const activeSet = new Set((state.tasks || []).filter((tk) => ['running', 'dispatched', 'dispatching'].includes(tk.state)).map((tk) => tk.member));
    ovRadarNodes.length = 0;

    const stateColor = (st) => (st === 'online' ? '#34d399' : (st === 'idle' ? '#38bdf8' : (st === 'cooldown' || st === 'stale' ? '#fbbf24' : '#64748b')));

    members.forEach((m, i) => {
      const angle = (Math.PI * 2 * i) / Math.max(1, members.length) - Math.PI / 2 + (reducedMotion ? 0 : Math.sin(ovRadarPhase * 0.3 + i) * 0.04);
      const nx = cx + Math.cos(angle) * rx;
      const ny = cy + Math.sin(angle) * ry;
      const busy = activeSet.has(m.member);
      ovRadarNodes.push({ m, x: nx, y: ny, r: 17 });

      ctx2d.strokeStyle = busy ? 'rgba(56, 189, 248, 0.65)' : (['online', 'idle'].includes(m.state) ? 'rgba(129, 140, 248, 0.34)' : 'rgba(100, 116, 139, 0.2)');
      ctx2d.lineWidth = busy ? 1.8 : 1;
      ctx2d.beginPath();
      ctx2d.moveTo(cx, cy);
      ctx2d.lineTo(nx, ny);
      ctx2d.stroke();

      if (!reducedMotion && (busy || m.state === 'online')) {
        const p = (ovRadarPhase * (busy ? 0.55 : 0.22) + i * 0.23) % 1;
        ctx2d.fillStyle = busy ? '#38bdf8' : '#34d399';
        ctx2d.beginPath();
        ctx2d.arc(cx + (nx - cx) * p, cy + (ny - cy) * p, busy ? 3.2 : 2.1, 0, Math.PI * 2);
        ctx2d.fill();
      }
    });

    // Core Orb
    const pulse = reducedMotion ? 1 : 1 + Math.sin(ovRadarPhase * 1.4) * 0.08;
    const grad = ctx2d.createRadialGradient(cx, cy, 4, cx, cy, 30 * pulse);
    grad.addColorStop(0, 'rgba(129, 140, 248, 0.92)');
    grad.addColorStop(0.55, 'rgba(99, 102, 241, 0.3)');
    grad.addColorStop(1, 'rgba(99, 102, 241, 0)');
    ctx2d.fillStyle = grad;
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, 30 * pulse, 0, Math.PI * 2);
    ctx2d.fill();

    ctx2d.fillStyle = '#6366f1';
    ctx2d.beginPath();
    ctx2d.arc(cx, cy, 16, 0, Math.PI * 2);
    ctx2d.fill();
    ctx2d.fillStyle = '#ffffff';
    ctx2d.font = '700 9.5px ui-monospace, Consolas, monospace';
    ctx2d.textAlign = 'center';
    ctx2d.textBaseline = 'middle';
    ctx2d.fillText('HUB', cx, cy + 0.5);

    for (const np of ovRadarNodes) {
      const col = stateColor(np.m.state);
      const busy = activeSet.has(np.m.member);
      if (busy) {
        const halo = np.r + (reducedMotion ? 5 : 4 + Math.sin(ovRadarPhase * 2.5) * 3);
        ctx2d.strokeStyle = 'rgba(56, 189, 248, 0.52)';
        ctx2d.lineWidth = 1.6;
        ctx2d.beginPath();
        ctx2d.arc(np.x, np.y, halo, 0, Math.PI * 2);
        ctx2d.stroke();
      }
      ctx2d.fillStyle = isLight ? '#ffffff' : '#0f1424';
      ctx2d.strokeStyle = col;
      ctx2d.lineWidth = 2;
      ctx2d.beginPath();
      ctx2d.arc(np.x, np.y, np.r, 0, Math.PI * 2);
      ctx2d.fill();
      ctx2d.stroke();

      ctx2d.fillStyle = isLight ? '#0f172a' : '#eef2ff';
      ctx2d.font = '700 9.5px ui-monospace, Consolas, monospace';
      ctx2d.fillText(String(np.m.member || '').toUpperCase().slice(0, 5), np.x, np.y + 0.5);
    }

    if (!reducedMotion && !document.hidden && state.view === 'overview') {
      ovRadarPhase += 0.024;
      ovRadarRaf = requestAnimationFrame(drawOverviewConstellation);
    } else {
      ovRadarRaf = null;
    }
  }

  function startOverviewConstellation() {
    if (ovRadarRaf !== null) return;
    if (state.view === 'overview' && !document.hidden) drawOverviewConstellation();
  }

  /* ---------- Overview Bento Studio Cards ---------- */
  function renderOverviewBento(overviewData) {
    startOverviewConstellation();
    const standaloneLink = $('#btnOpenStandaloneCockpit');
    if (standaloneLink) standaloneLink.hidden = Boolean(state.static);
    const host = $('#studioBento');
    if (!host) return;
    const mcpSum = overviewData?.mcp_hub_summary || sState.mcp?.summary || { servers_count: 0, clients_detected: 0, drift_count: 0, cached_tools_total: 0 };
    const mq = Array.isArray(overviewData?.merge_queue) ? overviewData.merge_queue : sState.mergeQueue;
    sState.mergeQueue = mq;
    const readyCnt = mq.filter((q) => q.status === 'ready').length;
    const conflictCnt = mq.filter((q) => q.status === 'conflict').length;
    const openComments = Number(overviewData?.worktree_comments_open ?? 0);

    const mcpBadge = $('#navMcpCount');
    if (mcpBadge) mcpBadge.textContent = String(mcpSum.servers_count ?? mcpSum.total_servers ?? 0);
    const skBadge = $('#navSkillsCount');
    if (skBadge && sState.skills?.summary) skBadge.textContent = String(sState.skills.summary.skills_total || 0);

    const driftPill = (mcpSum.drift_count || 0) > 0
      ? `<span class="pill warn">${esc(t('bento.mcpDrift', { n: mcpSum.drift_count }))}</span>`
      : `<span class="pill ok">${esc(t('bento.mcpClean'))}</span>`;

    host.innerHTML = `
      <button type="button" class="bento-card" data-goto-view="mcphub">
        <div class="bento-top">
          <span class="bento-ico mcp">⌘</span>
          <span class="bento-title">${esc(t('bento.mcpTitle'))}</span>
          ${driftPill}
        </div>
        <div class="bento-sub">${esc(t('bento.mcpSub', {
          servers: mcpSum.servers_count ?? mcpSum.total_servers ?? 0,
          clients: mcpSum.clients_detected ?? 0,
          tools: mcpSum.cached_tools_total ?? 0,
        }))}</div>
        <span class="bento-cta">${esc(t('bento.open'))}</span>
      </button>
      <button type="button" class="bento-card" data-goto-view="skills">
        <div class="bento-top">
          <span class="bento-ico skills">❖</span>
          <span class="bento-title">${esc(t('bento.skillsTitle'))}</span>
          <span class="pill demo">${esc(t('bento.skillsTag'))}</span>
        </div>
        <div class="bento-sub">${esc(t('bento.skillsSub'))}</div>
        <span class="bento-cta">${esc(t('bento.open'))}</span>
      </button>
      <button type="button" class="bento-card" data-goto-view="worktrees">
        <div class="bento-top">
          <span class="bento-ico queue">⑂</span>
          <span class="bento-title">${esc(t('bento.mqTitle'))}</span>
          <span class="pill ${conflictCnt > 0 ? 'off' : (readyCnt > 0 ? 'ok' : '')}">${mq.length} queued</span>
        </div>
        <div class="bento-sub">${esc(t('bento.mqSub', { ready: readyCnt, conflict: conflictCnt, comments: openComments }))}</div>
        <span class="bento-cta">${esc(t('bento.open'))}</span>
      </button>`;
  }

  /* ================================================================== */
  /* PILLAR 1: ALL-AGENT MCP HUB & META-MCP LAZY TOOL ROUTER             */
  /* ================================================================== */

  async function loadMcpHub({ quiet = false } = {}) {
    try {
      if (state.demo) {
        sState.mcp = sState.mcp || buildDemoMcpHub();
      } else {
        sState.mcp = await apiGet('/api/mcp-hub');
      }
      renderMcpHub();
      await searchMcpTools($('#mcpToolQuery')?.value || '');
      await loadMcpSnippet();
    } catch (err) {
      if (!quiet) toast(String(err.message || err), 'error');
    }
  }

  function renderMcpHub() {
    const snap = sState.mcp;
    if (!snap) return;
    const sum = snap.summary || {};
    const navCnt = $('#navMcpCount');
    if (navCnt) navCnt.textContent = String(sum.total_servers || 0);
    const matCnt = $('#mcpMatrixCount');
    if (matCnt) matCnt.textContent = `${sum.total_servers || 0}`;

    const kpiRow = $('#mcpKpiRow');
    if (kpiRow) {
      kpiRow.innerHTML = `
        <div class="studio-kpi"><span class="studio-kpi-label">${esc(t('mcp.kpiServers'))}</span><span class="studio-kpi-val">${sum.total_servers || 0}</span></div>
        <div class="studio-kpi"><span class="studio-kpi-label">${esc(t('mcp.kpiClients'))}</span><span class="studio-kpi-val">${sum.clients_detected || 0} / ${(snap.clients || []).length}</span></div>
        <div class="studio-kpi ${sum.drift_count ? 'warn' : 'ok'}"><span class="studio-kpi-label">${esc(t('mcp.kpiDrift'))}</span><span class="studio-kpi-val">${sum.drift_count || 0}</span></div>
        <div class="studio-kpi accent"><span class="studio-kpi-label">${esc(t('mcp.kpiTools'))}</span><span class="studio-kpi-val">${sum.cached_tools_total || 0}</span></div>`;
    }

    const chipBar = $('#mcpClientChips');
    if (chipBar) {
      chipBar.innerHTML = (snap.clients || []).map((c) => `
        <span class="client-chip ${c.exists ? 'detected' : 'missing'}">
          <i class="dot"></i>
          <strong>${esc(c.name)}</strong>
          <span class="chip-meta">${c.exists ? `${c.servers_count} · ${c.format.toUpperCase()}` : 'not found'}</span>
          ${c.secret_inline_count ? `<span class="pill warn">⚠ ${c.secret_inline_count} inline secret</span>` : ''}
        </span>`).join('');
    }

    const wrap = $('#mcpMatrixWrap');
    if (!wrap) return;
    const servers = snap.servers || [];
    const activeClients = (snap.clients || []).filter((c) => c.exists);
    if (!servers.length) {
      wrap.innerHTML = `<div class="mini-empty">${esc(t('mcp.empty'))}</div>`;
      return;
    }
    const headers = activeClients.map((c) => `<th>${esc(c.name)}</th>`).join('');
    const rows = servers.map((s) => {
      const cells = activeClients.map((c) => {
        const st = s.client_presence?.[c.id] || 'missing';
        const cls = st === 'present' ? 'ok' : (st === 'drifted' ? 'warn' : 'subtle');
        const label = st === 'present' ? '● synced' : (st === 'drifted' ? '▲ drifted' : '○ missing');
        return `<td><span class="pill ${cls}">${label}</span></td>`;
      }).join('');
      const probePill = s.last_probe_ok === true
        ? `<span class="pill ok">✓ ${s.last_probe_tools_count ?? 0} tools</span>`
        : (s.last_probe_ok === false ? `<span class="pill off" title="${esc(s.last_probe_detail || '')}">✕ error</span>` : `<span class="pill subtle">unprobed</span>`);
      const secWarn = s.secret_inline ? `<span class="pill warn" title="Inline secret detected in local client config; sync blocked">⚠ secret_inline</span>` : '';
      const envTags = (s.env_keys || []).map((k) => `<code class="env-tag">${esc(k)}</code>`).join(' ');
      const targetTxt = s.transport === 'stdio' ? `${s.command || ''} ${(s.args || []).slice(0, 2).join(' ')}` : (s.url || '');
      return `<tr>
        <td>
          <div class="cell-primary"><strong>${esc(s.id)}</strong> <span class="pill subtle">${esc(s.transport)}</span> <span class="pill subtle">${esc(s.group_name || 'default')}</span> ${secWarn}</div>
          <div class="cell-sub mono-trunc" title="${esc(targetTxt)}">${esc(targetTxt)}</div>
          ${envTags ? `<div class="cell-env">${envTags}</div>` : ''}
        </td>
        ${cells}
        <td>${probePill}</td>
        <td class="cell-actions">
          <button type="button" class="btn ghost sm" data-mcp-probe="${esc(s.id)}">${esc(t('mcp.probe'))}</button>
          ${s.registered && !state.demo ? `<button type="button" class="btn danger sm" data-mcp-remove="${esc(s.id)}">${esc(t('mcp.remove'))}</button>` : ''}
        </td>
      </tr>`;
    }).join('');
    wrap.innerHTML = `<table><thead><tr><th>MCP Server</th>${headers}<th>Probe / Tools</th><th>Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  async function searchMcpTools(query = '') {
    try {
      let data;
      if (state.demo) {
        const snap = sState.mcp || buildDemoMcpHub();
        const needle = String(query || '').trim().toLowerCase();
        const matches = [];
        let total = 0;
        for (const s of snap.servers) {
          for (const tool of (s.last_probe_tools || [])) {
            total += 1;
            if (!needle || tool.name.toLowerCase().includes(needle) || tool.description.toLowerCase().includes(needle) || s.id.toLowerCase().includes(needle)) {
              matches.push({ server_id: s.id, server_name: s.name, transport: s.transport, tool_name: tool.name, description: tool.description });
            }
          }
        }
        data = { servers_indexed: 3, total_indexed_tools: total, matched_count: matches.length, matches };
      } else {
        data = await apiGet(`/api/mcp-hub/tools?q=${encodeURIComponent(query)}`);
      }
      sState.mcpTools = data.matches || [];
      const meta = $('#mcpToolsMeta');
      if (meta) meta.textContent = t('mcp.toolsMeta', { matched: data.matched_count || 0, servers: data.servers_indexed || 0, total: data.total_indexed_tools || 0 });
      const box = $('#mcpToolCatalog');
      if (!box) return;
      if (!sState.mcpTools.length) {
        box.innerHTML = `<div class="mini-empty">${esc(t('mcp.toolsEmpty'))}</div>`;
        return;
      }
      box.innerHTML = sState.mcpTools.map((m) => `
        <div class="tool-card">
          <div class="tool-card-top">
            <code class="tool-name">${esc(m.tool_name)}</code>
            <span class="pill subtle">${esc(m.server_id)}</span>
          </div>
          <p class="tool-desc">${esc(m.description || '—')}</p>
          <div class="tool-foot">
            <span class="meta">${esc(m.transport || 'stdio')}</span>
            <button type="button" class="btn ghost sm" data-mcp-open-proxy="${esc(m.server_id)}::${esc(m.tool_name)}">${esc(t('mcp.callBtn'))}</button>
          </div>
        </div>`).join('');
    } catch (err) {
      toast(String(err.message || err), 'error');
    }
  }

  async function runMcpSync(confirmed) {
    const clientId = $('#mcpSyncClient')?.value || 'antigravity';
    const summaryEl = $('#mcpSyncSummary');
    const diffEl = $('#mcpSyncDiff');
    const applyBtn = $('#btnMcpSyncApply');
    try {
      let res;
      if (state.demo) {
        res = {
          mode: confirmed ? 'applied' : 'dry_run',
          applied: Boolean(confirmed),
          client_id: clientId,
          target_basename: clientId === 'codex' ? 'config.toml' : 'mcp_config.json',
          backup_basename: `${clientId === 'codex' ? 'config.toml' : 'mcp_config.json'}.bak.2026-11-27T06-30-00Z`,
          added: ['github-mcp'],
          updated: [],
          unchanged: ['collab-hub', 'mcp-agent-mail'],
          blocked_secrets: [],
          diff_preview: `--- ${clientId} (current)\n+++ ${clientId} (proposed)\n+ [mcp_servers.github-mcp]\n+ command = "npx"\n+ args = ["-y", "@modelcontextprotocol/server-github"]\n+ GITHUB_PERSONAL_ACCESS_TOKEN = "\${GITHUB_PERSONAL_ACCESS_TOKEN}"`,
        };
      } else {
        res = await apiPost('/api/mcp-hub/sync', { client_id: clientId, confirmed: Boolean(confirmed) });
      }
      sState.mcpSyncPlan = res;
      if (summaryEl) {
        summaryEl.hidden = false;
        summaryEl.innerHTML = `
          <span class="pill ${res.applied ? 'ok' : 'demo'}">${res.applied ? 'APPLIED' : 'DRY-RUN PREVIEW'}</span>
          <span>Target: <code>${esc(res.target_basename)}</code></span>
          <span>Backup: <code>${esc(res.backup_basename || 'new file')}</code></span>
          <span class="pill ok">+${(res.added || []).length} added</span>
          <span class="pill warn">~${(res.updated || []).length} updated</span>
          <span class="pill subtle">=${(res.unchanged || []).length} unchanged</span>
          ${(res.blocked_secrets || []).length ? `<span class="pill off">⛔ ${res.blocked_secrets.length} blocked (secret_inline)</span>` : ''}`;
      }
      if (diffEl) {
        diffEl.hidden = false;
        renderPlainDiff(diffEl, res.diff_preview);
      }
      if (applyBtn) applyBtn.disabled = state.demo ? false : Boolean(res.applied);
      if (confirmed) {
        toast(state.demo ? 'Demo preview: simulated .bak-backed sync (no host files modified).' : `Synced ${res.client_id} with backup ${res.backup_basename || ''}`, 'success');
        if (!state.demo) await loadMcpHub({ quiet: true });
      }
    } catch (err) {
      toast(String(err.message || err), 'error');
    }
  }

  async function loadMcpSnippet() {
    const clientId = $('#mcpSnippetClient')?.value || 'antigravity';
    const out = $('#mcpSnippetOut');
    if (!out) return;
    try {
      if (state.demo) {
        out.textContent = clientId === 'codex'
          ? '[mcp_servers.collab-hub]\ncommand = "node"\nargs = ["src/mcp-server.mjs"]\n\n[mcp_servers.github-mcp]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-github"]\n[mcp_servers.github-mcp.env]\nGITHUB_PERSONAL_ACCESS_TOKEN = "${GITHUB_PERSONAL_ACCESS_TOKEN}"'
          : JSON.stringify({ mcpServers: { 'collab-hub': { command: 'node', args: ['src/mcp-server.mjs'] }, 'github-mcp': { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' } } } }, null, 2);
      } else {
        const res = await apiGet(`/api/mcp-hub/snippet?client_id=${encodeURIComponent(clientId)}`);
        out.textContent = res.snippet || '';
      }
    } catch (err) {
      out.textContent = String(err.message || err);
    }
  }

  async function submitRegisterMcp() {
    const errEl = $('#mcpErr');
    if (errEl) errEl.textContent = '';
    const transport = $('#mcpTransport')?.value || 'stdio';
    const rawArgs = ($('#mcpArgs')?.value || '').trim();
    let args = [];
    if (rawArgs) {
      if (rawArgs.startsWith('[')) {
        try { args = JSON.parse(rawArgs); } catch { if (errEl) errEl.textContent = 'Invalid JSON array for args'; return; }
      } else {
        args = rawArgs.split(/\s+/).filter(Boolean);
      }
    }
    const payload = {
      id: ($('#mcpId')?.value || '').trim(),
      name: ($('#mcpName')?.value || '').trim(),
      transport,
      group_name: ($('#mcpGroup')?.value || 'core').trim(),
      command: transport === 'stdio' ? ($('#mcpCommand')?.value || '').trim() : null,
      args: transport === 'stdio' ? args : [],
      url: transport !== 'stdio' ? ($('#mcpUrl')?.value || '').trim() : null,
      env_keys: ($('#mcpEnvKeys')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
      tags: ($('#mcpTags')?.value || '').split(',').map((s) => s.trim()).filter(Boolean),
    };
    try {
      await apiPost('/api/mcp-hub/register', payload);
      closeModal('modalMcpBg');
      toast(`Registered MCP server "${payload.id}"`, 'success');
      await loadMcpHub({ quiet: true });
    } catch (err) {
      if (errEl) errEl.textContent = String(err.message || err);
    }
  }

  /* ================================================================== */
  /* PILLAR 2: CROSS-AGENT SKILLS & RULES SYNC CENTER                    */
  /* ================================================================== */

  async function loadSkillsHub({ quiet = false } = {}) {
    try {
      if (state.demo) {
        sState.skills = sState.skills || buildDemoSkillsHub();
      } else {
        const dir = ($('#skProjectDir')?.value || '').trim();
        const q = dir ? `?project_dir=${encodeURIComponent(dir)}` : '';
        sState.skills = await apiGet(`/api/skills-hub${q}`);
      }
      renderSkillsHub();
    } catch (err) {
      if (!quiet) toast(String(err.message || err), 'error');
    }
  }

  function renderSkillsHub() {
    const snap = sState.skills;
    if (!snap) return;
    const sum = snap.summary || {};
    const navBadge = $('#navSkillsCount');
    if (navBadge) navBadge.textContent = String(sum.skills_total || 0);

    const kpiRow = $('#skillsKpiRow');
    if (kpiRow) {
      kpiRow.innerHTML = `
        <div class="studio-kpi"><span class="studio-kpi-label">${esc(t('skills.kpiSkills'))}</span><span class="studio-kpi-val">${sum.skills_total || 0}</span></div>
        <div class="studio-kpi"><span class="studio-kpi-label">${esc(t('skills.kpiClients'))}</span><span class="studio-kpi-val">${sum.clients_detected || 0} / ${(snap.clients || []).length}</span></div>
        <div class="studio-kpi ${sum.skill_drift_count ? 'warn' : 'ok'}"><span class="studio-kpi-label">${esc(t('skills.kpiDrift'))}</span><span class="studio-kpi-val">${sum.skill_drift_count || 0}</span></div>
        <div class="studio-kpi accent"><span class="studio-kpi-label">${esc(t('skills.kpiRules'))}</span><span class="studio-kpi-val">${sum.rules_detected || 0} / ${(snap.rules || []).length}</span></div>`;
    }

    const wrap = $('#skillsMatrixWrap');
    if (wrap) {
      const skills = snap.skills || [];
      const clients = snap.clients || [];
      if (!skills.length) {
        wrap.innerHTML = `<div class="mini-empty">${esc(t('skills.empty'))}</div>`;
      } else {
        const hdrs = clients.map((c) => `<th>${esc(c.name)}</th>`).join('');
        const rows = skills.map((sk) => {
          const cells = clients.map((c) => {
            const st = sk.client_presence?.[c.id] || 'missing';
            const cls = st === 'present' ? 'ok' : (st === 'drifted' ? 'warn' : 'subtle');
            const lbl = st === 'present' ? '● synced' : (st === 'drifted' ? '▲ drifted' : '○ missing');
            return `<td><span class="pill ${cls}">${lbl}</span></td>`;
          }).join('');
          return `<tr>
            <td>
              <div class="cell-primary"><strong>${esc(sk.name)}</strong> <span class="pill subtle">${sk.files_count} file(s)</span></div>
              <div class="cell-sub">${esc(sk.description || '—')}</div>
            </td>
            ${cells}
            <td class="cell-actions">
              <button type="button" class="btn ghost sm" data-skill-sync="${esc(sk.name)}::${esc(sk.canonical_client)}">${esc(t('skills.syncBtn'))}</button>
            </td>
          </tr>`;
        }).join('');
        wrap.innerHTML = `<table><thead><tr><th>Skill (SKILL.md)</th>${hdrs}<th>Sync</th></tr></thead><tbody>${rows}</tbody></table>`;
      }
    }

    const rulesBox = $('#rulesGrid');
    if (rulesBox) {
      rulesBox.innerHTML = (snap.rules || []).map((r) => {
        const cls = r.status === 'present' ? 'ok' : (r.status === 'drifted' ? 'warn' : 'subtle');
        return `<article class="rule-card">
          <div class="rule-top">
            <div>
              <strong>${esc(r.rel_path)}</strong>
              <span class="pill subtle">${esc(r.dialect)}</span>
            </div>
            <span class="pill ${cls}">${esc(r.status)}</span>
          </div>
          <div class="meta">${esc(r.name)} ${r.exists ? `· ${Math.max(1, Math.round(r.bytes / 1024))} KB` : ''}</div>
          <pre class="rule-preview">${esc(r.preview || '(not present in this project)')}</pre>
          <div class="rule-foot">
            ${r.exists ? `<button type="button" class="btn ghost sm" data-rule-sync="${esc(r.id)}">${esc(t('skills.ruleSyncFrom'))}</button>` : `<span class="meta">Sync from an existing canonical rule</span>`}
          </div>
        </article>`;
      }).join('');
    }
  }

  async function previewSkillOrRuleSync(kind, params) {
    const panel = $('#skillsSyncPanel');
    const titleEl = $('#skillsSyncTitle');
    const subEl = $('#skillsSyncSub');
    const metaEl = $('#skillsSyncMeta');
    const diffEl = $('#skillsSyncDiff');
    try {
      let res;
      if (state.demo) {
        const label = kind === 'skill' ? `skill/${params.skill_name}` : params.source_rule_id;
        res = {
          mode: 'dry_run',
          applied: false,
          plans: [
            {
              target_name: kind === 'skill' ? 'Codex + Claude Code' : 'CLAUDE.md + GEMINI.md',
              backup_basename: `${label}.bak.2026-11-27T06-30-00Z`,
              changed_lines: 6,
              diff_preview: `--- target (current)\n+++ target (proposed from ${label})\n- # Old instructions\n+ # Canonical instructions synced by CollabHub v1.5\n+ - Always run isolated worktree verification gates.`,
            },
          ],
        };
      } else if (kind === 'skill') {
        res = await apiPost('/api/skills-hub/sync-skill', { ...params, confirmed: false });
      } else {
        res = await apiPost('/api/skills-hub/sync-rule', { ...params, confirmed: false });
      }
      sState.skillsSyncPending = { kind, params };
      if (panel) panel.hidden = false;
      if (titleEl) titleEl.textContent = kind === 'skill' ? `Dry-Run Skill Sync · ${params.skill_name}` : `Dry-Run Rule Sync · ${params.source_rule_id}`;
      if (subEl) subEl.textContent = `${(res.plans || []).length} target(s) prepared · automatic .bak backup before overwrite`;
      if (metaEl) {
        metaEl.innerHTML = (res.plans || []).map((p) =>
          `<span class="pill demo">${esc(p.target_name || p.rel_path || p.target_client)} (${p.changed_lines} Δ lines${p.backup_basename ? ` · ${p.backup_basename}` : ''})</span>`,
        ).join(' ');
      }
      if (diffEl) {
        renderPlainDiff(diffEl, (res.plans || []).map((p) => p.diff_preview).join('\n\n'));
      }
      panel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      toast(String(err.message || err), 'error');
    }
  }

  async function confirmSkillOrRuleSync() {
    const pending = sState.skillsSyncPending;
    if (!pending) return;
    try {
      if (state.demo) {
        toast('Demo preview: simulated .bak-backed sync (no host files modified).', 'success');
        if ($('#skillsSyncPanel')) $('#skillsSyncPanel').hidden = true;
        return;
      }
      if (pending.kind === 'skill') {
        await apiPost('/api/skills-hub/sync-skill', { ...pending.params, confirmed: true });
      } else {
        await apiPost('/api/skills-hub/sync-rule', { ...pending.params, confirmed: true });
      }
      toast('Synced successfully with automatic .bak backups.', 'success');
      if ($('#skillsSyncPanel')) $('#skillsSyncPanel').hidden = true;
      await loadSkillsHub({ quiet: true });
    } catch (err) {
      toast(String(err.message || err), 'error');
    }
  }

  /* ================================================================== */
  /* PILLAR 3: WORKTREE INLINE DIFF COMMENTS & SERIALIZED MERGE QUEUE    */
  /* ================================================================== */

  async function loadMergeQueue({ quiet = false } = {}) {
    try {
      if (!state.demo) {
        const res = await apiGet('/api/merge-queue');
        sState.mergeQueue = res.queue || [];
      }
      renderMergeQueue();
    } catch (err) {
      if (!quiet) toast(String(err.message || err), 'error');
    }
  }

  function renderMergeQueue() {
    const box = $('#mqList');
    if (!box) return;
    const queue = sState.mergeQueue || [];
    if (!queue.length) {
      box.innerHTML = `<div class="mini-empty">${esc(t('mq.empty'))}</div>`;
      return;
    }
    box.innerHTML = queue.map((q, idx) => {
      const cls = q.status === 'ready' || q.status === 'merged' ? 'ok' : (q.status === 'conflict' || q.status === 'failed' ? 'off' : 'warn');
      const conflicts = (q.conflict_files || []).map((f) => `<code class="conflict-chip">${esc(f)}</code>`).join(' ');
      return `<article class="mq-item ${esc(q.status)}">
        <div class="mq-rank">#${idx + 1}</div>
        <div class="mq-body">
          <div class="mq-top">
            <strong class="mono">${esc(q.branch_name)}</strong>
            <span class="pill ${cls}">${esc(q.status)}</span>
            <span class="pill subtle">prio ${q.priority}</span>
            <span class="pill subtle">${esc(q.member || 'agent')} → ${esc(q.base_ref || 'main')}</span>
          </div>
          <div class="meta">${esc(q.check_summary || `HEAD ${String(q.head_sha || '').slice(0, 10)}`)}</div>
          ${conflicts ? `<div class="mq-conflicts">⚠ Conflicts: ${conflicts}</div>` : ''}
        </div>
        <div class="mq-actions">
          <button type="button" class="btn ghost sm" data-wt-review="${esc(q.task_id)}">Diff</button>
          ${!state.demo ? `<button type="button" class="btn danger sm" data-mq-remove="${esc(q.task_id)}">${esc(t('mq.remove'))}</button>` : ''}
        </div>
      </article>`;
    }).join('');
  }

  function renderPlainDiff(container, text) {
    container.textContent = '';
    const lines = String(text || '').split('\n');
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      const row = document.createElement('div');
      const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') ? 'diff-file'
        : (line.startsWith('@@') ? 'diff-hunk' : (line.startsWith('+') ? 'diff-add' : (line.startsWith('-') ? 'diff-del' : 'diff-ctx')));
      row.className = `diff-line ${cls}`;
      row.textContent = line || ' ';
      frag.append(row);
    }
    container.append(frag);
  }

  /**
   * Enhance the Worktree Review Drawer with interactive line-clickable Diff Comments + Rework Dispatch!
   */
  async function enhanceWorktreeDiffDrawer(taskId, diffText) {
    sState.activeDiffTaskId = taskId;
    sState.activeDiffPin = null;
    const diffEl = $('#wtDiff');
    if (!diffEl) return;

    // Load comments for this worktree
    let comments = [];
    if (state.demo) {
      comments = sState.demoComments.filter((c) => c.task_id === taskId);
    } else {
      try {
        const res = await apiGet(`/api/worktrees/comments?task_id=${encodeURIComponent(taskId)}`);
        comments = res.comments || [];
      } catch { comments = []; }
    }
    sState.commentsByTask.set(taskId, comments);

    // Inject Comments & Rework section right above the Diff
    let host = $('#wtCommentsSection');
    if (!host) {
      host = document.createElement('div');
      host.id = 'wtCommentsSection';
      host.className = 'drawer-section wt-comments-section';
      diffEl.parentElement?.before(host);
    }
    renderCommentsPanel(taskId, host);

    // Upgrade diff rows into clickable line-numbered rows!
    diffEl.textContent = '';
    const lines = String(diffText || '').split('\n');
    let curFile = 'worktree';
    let newLine = 0;
    let oldLine = 0;
    const frag = document.createDocumentFragment();
    for (const line of lines) {
      if (line.startsWith('+++ b/')) curFile = line.slice(6).trim();
      else if (line.startsWith('@@')) {
        const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) { oldLine = Number(m[1]); newLine = Number(m[2]); }
      }
      const isCode = !line.startsWith('diff ') && !line.startsWith('index ') && !line.startsWith('---') && !line.startsWith('+++') && !line.startsWith('@@');
      let side = 'new';
      let lineNo = null;
      if (isCode) {
        if (line.startsWith('+')) { side = 'new'; lineNo = newLine; newLine += 1; }
        else if (line.startsWith('-')) { side = 'old'; lineNo = oldLine; oldLine += 1; }
        else { side = 'new'; lineNo = newLine; newLine += 1; oldLine += 1; }
      }
      const cls = line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ') ? 'diff-file'
        : (line.startsWith('@@') ? 'diff-hunk' : (line.startsWith('+') ? 'diff-add' : (line.startsWith('-') ? 'diff-del' : 'diff-ctx')));

      const row = document.createElement('div');
      row.className = `diff-line ${cls}${isCode ? ' diff-clickable' : ''}`;
      if (isCode && lineNo) {
        row.dataset.diffFile = curFile;
        row.dataset.diffLine = String(lineNo);
        row.dataset.diffSide = side;
        row.title = `Click to comment on ${curFile}:${lineNo}`;
        const gutter = document.createElement('span');
        gutter.className = 'diff-gutter';
        gutter.textContent = `${lineNo}`;
        const plus = document.createElement('span');
        plus.className = 'diff-pin-ico';
        plus.textContent = '+';
        const code = document.createElement('span');
        code.className = 'diff-code';
        code.textContent = line || ' ';
        row.append(gutter, plus, code);
      } else {
        row.textContent = line || ' ';
      }
      frag.append(row);
    }
    diffEl.append(frag);
  }

  function renderCommentsPanel(taskId, host = $('#wtCommentsSection')) {
    if (!host) return;
    const comments = sState.commentsByTask.get(taskId) || [];
    const openCnt = comments.filter((c) => c.status === 'open').length;
    const pin = sState.activeDiffPin;

    const composer = pin ? `
      <div class="cmt-composer">
        <div class="cmt-composer-head">
          <strong>${esc(t('cmt.addTitle', { file: pin.file, line: pin.line }))}</strong>
          <button type="button" class="btn ghost sm" data-cmt-cancel-pin="1">×</button>
        </div>
        <textarea id="cmtBodyInput" rows="2" placeholder="${esc(t('cmt.placeholder'))}"></textarea>
        <div class="form-actions">
          <button type="button" class="btn primary sm" id="btnSubmitCmt">${esc(t('cmt.submit'))}</button>
        </div>
      </div>` : '';

    const listHtml = comments.length ? comments.map((c) => `
      <div class="cmt-item ${esc(c.status)}">
        <div class="cmt-item-top">
          <code>${esc(c.file_path)}${c.line_no ? `:${c.line_no}` : ''}</code>
          <span class="pill ${c.status === 'open' ? 'warn' : (c.status === 'sent' ? 'demo' : 'ok')}">${esc(c.status)}</span>
          ${c.rework_task_id ? `<span class="meta">→ ${esc(c.rework_task_id)}</span>` : ''}
          <button type="button" class="btn ghost sm cmt-toggle-btn" data-cmt-toggle="${c.id}::${c.status === 'resolved' ? 'open' : 'resolved'}">${esc(c.status === 'resolved' ? t('cmt.reopen') : t('cmt.resolve'))}</button>
        </div>
        <div class="cmt-body">${esc(c.body)}</div>
      </div>`).join('') : `<div class="meta">${esc(t('cmt.empty'))}</div>`;

    host.innerHTML = `
      <div class="panel-head cmt-head">
        <div>
          <h3>${esc(t('cmt.title', { n: openCnt }))}</h3>
          <p class="meta">${esc(t('cmt.hint'))}</p>
        </div>
        ${openCnt > 0 ? `<button type="button" class="btn primary sm" data-wt-rework="${esc(taskId)}">${esc(t('cmt.sendRework', { n: openCnt }))}</button>` : ''}
      </div>
      ${composer}
      <div class="cmt-list">${listHtml}</div>`;
  }

  /* ---------- Event Wiring ---------- */
  function bindEvents() {
    initRail();
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && state.view === 'overview') startOverviewConstellation();
    });
    $('#ovFleetCanvas')?.addEventListener('click', (e) => {
      const rect = e.target.getBoundingClientRect();
      const hit = ovRadarNodes.find((np) => Math.hypot(np.x - (e.clientX - rect.left), np.y - (e.clientY - rect.top)) <= np.r + 6);
      if (hit) toast(`${hit.m.name || hit.m.member}: ${hit.m.state} · ${hit.m.detail || hit.m.channel}`, 'info', 3000);
    });

    // MCP Hub studio buttons & tabs
    $('#btnMcpRefresh')?.addEventListener('click', () => loadMcpHub());
    $('#btnMcpImport')?.addEventListener('click', async () => {
      if (state.demo) { toast('Demo mode: discovered servers already loaded.', 'info'); return; }
      try {
        const res = await apiPost('/api/mcp-hub/import', {});
        toast(`Imported ${res.imported_count} MCP server(s) into canonical registry.`, 'success');
        await loadMcpHub({ quiet: true });
      } catch (err) { toast(String(err.message || err), 'error'); }
    });
    $('#btnOpenMcpModal')?.addEventListener('click', () => openModal('modalMcpBg'));
    $('#mcpTransport')?.addEventListener('change', (e) => {
      const isStdio = e.target.value === 'stdio';
      const sf = $('#mcpStdioFields');
      const hf = $('#mcpHttpFields');
      if (sf) sf.hidden = !isStdio;
      if (hf) hf.hidden = isStdio;
    });
    $('#btnSaveMcp')?.addEventListener('click', submitRegisterMcp);

    $$('#mcpStudioTabs .tab-btn').forEach((btn) => btn.addEventListener('click', () => {
      const tab = btn.dataset.mcpTab;
      $$('#mcpStudioTabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      ['router', 'sync', 'snippet'].forEach((k) => {
        const p = $(`#mcp-pane-${k}`);
        if (p) p.classList.toggle('active', k === tab);
      });
    }));
    $('#btnMcpFindTools')?.addEventListener('click', () => searchMcpTools($('#mcpToolQuery')?.value || ''));
    $('#mcpToolQuery')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') searchMcpTools(e.target.value); });
    $('#btnCloseMcpProxy')?.addEventListener('click', () => { if ($('#mcpProxyBox')) $('#mcpProxyBox').hidden = true; });
    $('#btnRunMcpProxy')?.addEventListener('click', async () => {
      const active = sState.mcpActiveTool;
      if (!active) return;
      const out = $('#mcpProxyOut');
      if (out) { out.hidden = false; out.textContent = 'Calling tool via Meta-MCP gateway…'; }
      let parsedArgs = {};
      try { parsedArgs = JSON.parse($('#mcpProxyArgs')?.value || '{}'); } catch {
        if (out) out.textContent = 'Error: Arguments must be valid JSON.';
        return;
      }
      try {
        if (state.demo) {
          if (out) out.textContent = JSON.stringify({ demo: true, server_id: active.serverId, tool_name: active.toolName, duration_ms: 42, result: { ok: true, note: 'Simulated Meta-MCP lazy tool response' } }, null, 2);
          return;
        }
        const res = await apiPost('/api/mcp-hub/call', { server_id: active.serverId, tool_name: active.toolName, arguments: parsedArgs });
        if (out) out.textContent = JSON.stringify(res, null, 2);
      } catch (err) {
        if (out) out.textContent = `Error: ${err.message || err}`;
      }
    });

    $('#btnMcpSyncDry')?.addEventListener('click', () => runMcpSync(false));
    $('#btnMcpSyncApply')?.addEventListener('click', () => runMcpSync(true));
    $('#mcpSyncClient')?.addEventListener('change', () => { if ($('#btnMcpSyncApply')) $('#btnMcpSyncApply').disabled = true; });
    $('#btnMcpGenSnippet')?.addEventListener('click', loadMcpSnippet);
    $('#mcpSnippetClient')?.addEventListener('change', loadMcpSnippet);
    $('#btnMcpCopySnippet')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText($('#mcpSnippetOut')?.textContent || ''); toast(t('common.copied'), 'success', 2000); }
      catch { toast(t('common.copyFail'), 'warn'); }
    });

    // Skills & Rules studio
    $('#btnSkillsRefresh')?.addEventListener('click', () => loadSkillsHub());
    $$('#skillsStudioTabs .tab-btn').forEach((btn) => btn.addEventListener('click', () => {
      const tab = btn.dataset.skTab;
      $$('#skillsStudioTabs .tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
      ['skills', 'rules'].forEach((k) => {
        const p = $(`#sk-pane-${k}`);
        if (p) p.classList.toggle('active', k === tab);
      });
    }));
    $('#btnCloseSkillsSync')?.addEventListener('click', () => { if ($('#skillsSyncPanel')) $('#skillsSyncPanel').hidden = true; });
    $('#btnConfirmSkillsSync')?.addEventListener('click', confirmSkillOrRuleSync);

    // Merge Queue studio buttons
    $('#btnMqValidate')?.addEventListener('click', async () => {
      if (state.demo) { toast('Demo preview: speculative git merge-tree verified 1 ready, 1 collision on src/router.mjs.', 'info'); return; }
      try {
        const res = await apiPost('/api/merge-queue/validate', {});
        sState.mergeQueue = res.queue || [];
        renderMergeQueue();
        toast(`Speculative check complete (${(res.results || []).length} branch(es) evaluated).`, 'success');
      } catch (err) { toast(String(err.message || err), 'error'); }
    });
    $('#btnMqProcess')?.addEventListener('click', async () => {
      if (state.demo) { toast('Demo mode is read-only: serialized merge disabled.', 'warn'); return; }
      try {
        const res = await apiPost('/api/merge-queue/process', { confirmed: true, cleanup: true });
        sState.mergeQueue = res.queue || [];
        renderMergeQueue();
        toast(`Merged ${(res.merged || []).length} worktree(s); ${(res.failed || []).length} failed.`, (res.failed || []).length ? 'warn' : 'success');
        await loadOverview({ quiet: true });
      } catch (err) { toast(String(err.message || err), 'error'); }
    });

    // Delegated clicks for dynamic studio actions
    document.addEventListener('click', async (e) => {
      const el = e.target instanceof Element ? e.target : null;
      if (!el) return;

      const probeBtn = el.closest('[data-mcp-probe]');
      if (probeBtn) {
        const id = probeBtn.getAttribute('data-mcp-probe');
        if (state.demo) { toast(`Demo probe: ${id} healthy · tools indexed.`, 'success'); return; }
        probeBtn.disabled = true;
        probeBtn.textContent = t('mcp.probing');
        try {
          const res = await apiPost('/api/mcp-hub/probe', { id });
          toast(res.detail || `Probed ${id}`, res.ok ? 'success' : 'error');
          await loadMcpHub({ quiet: true });
        } catch (err) { toast(String(err.message || err), 'error'); }
        finally { probeBtn.disabled = false; probeBtn.textContent = t('mcp.probe'); }
        return;
      }

      const remMcp = el.closest('[data-mcp-remove]');
      if (remMcp) {
        try {
          await apiPost('/api/mcp-hub/remove', { id: remMcp.getAttribute('data-mcp-remove') });
          toast('Removed MCP server from registry.', 'success');
          await loadMcpHub({ quiet: true });
        } catch (err) { toast(String(err.message || err), 'error'); }
        return;
      }

      const openProxy = el.closest('[data-mcp-open-proxy]');
      if (openProxy) {
        const [serverId, toolName] = openProxy.getAttribute('data-mcp-open-proxy').split('::');
        sState.mcpActiveTool = { serverId, toolName };
        const box = $('#mcpProxyBox');
        if (box) box.hidden = false;
        if ($('#mcpProxyTarget')) $('#mcpProxyTarget').textContent = `${serverId} → ${toolName}`;
        if ($('#mcpProxyOut')) $('#mcpProxyOut').hidden = true;
        box?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
      }

      const skSync = el.closest('[data-skill-sync]');
      if (skSync) {
        const [skillName, sourceClient] = skSync.getAttribute('data-skill-sync').split('::');
        await previewSkillOrRuleSync('skill', { skill_name: skillName, source_client: sourceClient });
        return;
      }

      const ruleSync = el.closest('[data-rule-sync]');
      if (ruleSync) {
        const sourceRuleId = ruleSync.getAttribute('data-rule-sync');
        const projectDir = ($('#skProjectDir')?.value || '').trim() || undefined;
        await previewSkillOrRuleSync('rule', { source_rule_id: sourceRuleId, project_dir: projectDir });
        return;
      }

      const mqEnq = el.closest('[data-mq-enqueue]');
      if (mqEnq) {
        const taskId = mqEnq.getAttribute('data-mq-enqueue');
        if (state.demo) { toast(`Demo preview: ${taskId} is already in Merge Queue.`, 'info'); return; }
        try {
          await apiPost('/api/merge-queue/enqueue', { task_id: taskId });
          toast(`Enqueued ${taskId} into Merge Queue.`, 'success');
          await loadMergeQueue({ quiet: true });
        } catch (err) { toast(String(err.message || err), 'error'); }
        return;
      }

      const mqRem = el.closest('[data-mq-remove]');
      if (mqRem) {
        try {
          await apiPost('/api/merge-queue/remove', { task_id: mqRem.getAttribute('data-mq-remove') });
          toast('Removed item from Merge Queue.', 'success');
          await loadMergeQueue({ quiet: true });
        } catch (err) { toast(String(err.message || err), 'error'); }
        return;
      }

      // Clickable Diff Line -> open inline comment composer
      const diffLine = el.closest('.diff-clickable');
      if (diffLine && sState.activeDiffTaskId) {
        sState.activeDiffPin = {
          file: diffLine.dataset.diffFile,
          line: Number(diffLine.dataset.diffLine),
          side: diffLine.dataset.diffSide || 'new',
        };
        renderCommentsPanel(sState.activeDiffTaskId);
        $('#cmtBodyInput')?.focus();
        return;
      }

      if (el.closest('[data-cmt-cancel-pin]') && sState.activeDiffTaskId) {
        sState.activeDiffPin = null;
        renderCommentsPanel(sState.activeDiffTaskId);
        return;
      }

      if (el.closest('#btnSubmitCmt') && sState.activeDiffTaskId && sState.activeDiffPin) {
        const body = ($('#cmtBodyInput')?.value || '').trim();
        if (!body) { toast('Write a comment first.', 'warn'); return; }
        const taskId = sState.activeDiffTaskId;
        const pin = sState.activeDiffPin;
        if (state.demo) {
          const next = { id: Date.now(), task_id: taskId, file_path: pin.file, line_no: pin.line, side: pin.side, author: 'reviewer', body, status: 'open', rework_task_id: null };
          sState.demoComments.push(next);
          sState.commentsByTask.set(taskId, sState.demoComments.filter((c) => c.task_id === taskId));
          sState.activeDiffPin = null;
          renderCommentsPanel(taskId);
          toast('Comment pinned in demo preview.', 'success');
          return;
        }
        try {
          const res = await apiPost('/api/worktrees/comments/add', { task_id: taskId, file_path: pin.file, line_no: pin.line, side: pin.side, body });
          const cur = sState.commentsByTask.get(taskId) || [];
          cur.push(res.comment);
          sState.commentsByTask.set(taskId, cur);
          sState.activeDiffPin = null;
          renderCommentsPanel(taskId);
          toast('Inline diff comment pinned.', 'success');
        } catch (err) { toast(String(err.message || err), 'error'); }
        return;
      }

      const toggleBtn = el.closest('[data-cmt-toggle]');
      if (toggleBtn && sState.activeDiffTaskId) {
        const [cidStr, nextStatus] = toggleBtn.getAttribute('data-cmt-toggle').split('::');
        const cid = Number(cidStr);
        const taskId = sState.activeDiffTaskId;
        if (state.demo) {
          const found = sState.demoComments.find((c) => c.id === cid);
          if (found) found.status = nextStatus;
          sState.commentsByTask.set(taskId, sState.demoComments.filter((c) => c.task_id === taskId));
          renderCommentsPanel(taskId);
          return;
        }
        try {
          const res = await apiPost('/api/worktrees/comments/resolve', { comment_id: cid, status: nextStatus });
          const list = (sState.commentsByTask.get(taskId) || []).map((c) => (c.id === cid ? res.comment : c));
          sState.commentsByTask.set(taskId, list);
          renderCommentsPanel(taskId);
        } catch (err) { toast(String(err.message || err), 'error'); }
        return;
      }

      const reworkBtn = el.closest('[data-wt-rework]');
      if (reworkBtn) {
        const taskId = reworkBtn.getAttribute('data-wt-rework');
        if (state.demo) {
          toast('Demo preview: would dispatch open comments as a targeted rework task in this worktree.', 'info');
          return;
        }
        reworkBtn.disabled = true;
        try {
          const res = await apiPost('/api/worktrees/rework', { task_id: taskId });
          toast(`Dispatched rework task ${res.rework_task?.task_id || ''} (${res.comments_sent} comment(s))`, 'success');
          const refreshed = await apiGet(`/api/worktrees/comments?task_id=${encodeURIComponent(taskId)}`);
          sState.commentsByTask.set(taskId, refreshed.comments || []);
          renderCommentsPanel(taskId);
          await loadOverview({ quiet: true });
        } catch (err) { toast(String(err.message || err), 'error'); }
        finally { reworkBtn.disabled = false; }
      }
    });
  }

  function onViewEnter(viewId) {
    if (viewId === 'overview') startOverviewConstellation();
    if (viewId === 'mcphub') loadMcpHub({ quiet: true });
    if (viewId === 'skills') loadSkillsHub({ quiet: true });
    if (viewId === 'worktrees') loadMergeQueue({ quiet: true });
  }

  function onLanguageChanged() {
    if (sState.mcp) renderMcpHub();
    if (sState.skills) renderSkillsHub();
    renderMergeQueue();
    if (sState.activeDiffTaskId && $('#wtCommentsSection')) renderCommentsPanel(sState.activeDiffTaskId);
  }

  return {
    bindEvents,
    onViewEnter,
    onLanguageChanged,
    renderOverviewBento,
    renderMergeQueue,
    enhanceWorktreeDiffDrawer,
  };
}
