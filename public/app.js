/* CollabHub v1.4 — app shell controller (zero dependencies, bilingual EN / ZH).
 *
 * Scaffolding contract:
 *   - No inline <script>/<style> is ever generated; CSP stays `script-src 'self'`.
 *   - Every user-visible string comes from the I18N table below (the only place
 *     CJK literals live) so a language switch never leaves a half-translated view.
 *   - Static hosting (GitHub Pages) is detected and enters a read-only demo mode
 *     that performs zero `/api/*` requests.
 */
'use strict';

/* ------------------------------------------------------------------ */
/* Utilities                                                           */
/* ------------------------------------------------------------------ */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const THEME_KEY = 'collabhub.theme';
const LANG_KEY = 'collabhub_lang';
const DAG_TPL_KEY = 'collabhub_dag_templates';
const DEMO_DIR = '/workspace/collab-demo';

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[ch]));

function fmtDate(value, withTime = true) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const locale = LANG === 'zh' ? 'zh-CN' : 'en-US';
  return withTime ? d.toLocaleString(locale) : d.toLocaleDateString(locale);
}

function fmtTimeShort(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const locale = LANG === 'zh' ? 'zh-CN' : 'en-US';
  return d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
}

function relTime(value) {
  if (!value) return '—';
  const t0 = new Date(value).getTime();
  if (Number.isNaN(t0)) return '—';
  const diff = Date.now() - t0;
  if (diff < 45_000) return t('time.justNow');
  if (diff < 3_600_000) return t('time.m', { n: Math.round(diff / 60_000) });
  if (diff < 86_400_000) return t('time.h', { n: Math.round(diff / 3_600_000) });
  return t('time.d', { n: Math.round(diff / 86_400_000) });
}

function fmtDuration(seconds) {
  const v = Number(seconds);
  if (!Number.isFinite(v) || v <= 0) return '';
  if (v < 10) return `${v.toFixed(1)}s`;
  if (v < 60) return `${Math.round(v)}s`;
  return `${Math.floor(v / 60)}m${String(Math.round(v % 60)).padStart(2, '0')}s`;
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

function initials(name) {
  const raw = String(name || '?').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  if (!raw) return '?';
  const parts = raw.split(/\s+/);
  if (parts.length > 1) return (parts[0][0] + parts[1][0]).toUpperCase();
  return raw.slice(0, 2).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* i18n                                                                */
/* ------------------------------------------------------------------ */

/* I18N-TABLE-BEGIN — every CJK literal in this file lives inside this block. */
const I18N = {
  en: {
    'app.title': 'CollabHub v1.3 · Local-First Multi-Agent Workbench',
    'app.titleDemo': 'CollabHub v1.3 · Demo Preview',
    'app.titleStatic': 'CollabHub v1.3 · Static Demo · GitHub Pages',

    'lang.glyphZh': '中',
    'lang.switch': 'Switch language / 切换语言',
    'lang.current': 'Current language: English',
    'lang.switched': 'Language switched to English.',
    'lang.switchedZh': '已切换为简体中文',

    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.none': '—',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.copyFail': 'Copy failed: the browser denied clipboard access.',
    'common.dismiss': 'Dismiss',

    'brand.foot': 'CollabHub v1.3',
    'brand.deps': '0 npm deps',
    'brand.upgrade': 'Upgraded from CollabHub v1.1 · Static demo ready',

    'nav.workspace': 'Workspace',
    'nav.system': 'System',
    'nav.overview': 'Overview',
    'nav.overviewAlt': '总览',
    'nav.tasks': 'Tasks & Kanban',
    'nav.tasksAlt': '任务与看板',
    'nav.dag': 'DAG & Playbooks',
    'nav.dagAlt': '编排与流水线',
    'nav.worktrees': 'Worktrees',
    'nav.worktreesAlt': '分支隔离',
    'nav.toolkit': 'Toolkit & Memory',
    'nav.toolkitAlt': '工具箱与记忆',
    'nav.ops': 'System & Doctor',
    'nav.opsAlt': '系统与体检',
    'side.probe': 'Probe all agents',

    'topbar.nav': 'Toggle navigation',
    'topbar.demo': '● Demo Preview',
    'topbar.static': '● Static Demo',
    'topbar.syncPending': 'Syncing',
    'topbar.syncing': 'Syncing…',
    'topbar.syncAt': 'Synced {time}',
    'topbar.syncFailed': 'Sync failed',
    'topbar.mailTitle': 'Mail hub status',
    'topbar.mailChecking': 'Mail: checking',
    'topbar.mailOnline': 'Mail v{version} · :5291',
    'topbar.mailOffline': 'Mail offline',
    'topbar.sseConnecting': 'SSE: connecting',
    'topbar.sseLive': '● Live SSE',
    'topbar.ssePolling': '○ Polling',
    'topbar.sseDemo': 'Demo · read-only',
    'topbar.sseStatic': 'Static · no stream',
    'topbar.search': 'Search',
    'topbar.palette': 'Open command palette',
    'topbar.theme': 'Toggle theme',
    'topbar.dispatch': '+ Dispatch',

    'theme.toDark': 'Switch to light theme',
    'theme.toLight': 'Switch to dark theme',
    'theme.switchedDark': 'Switched to the Obsidian dark theme.',
    'theme.switchedLight': 'Switched to the Alabaster light theme.',

    'quick.probe': 'Probe agents',
    'quick.agent': 'Add agent',
    'quick.memory': 'Write memory',
    'quick.dag': 'Run DAG',
    'quick.ops': 'Run doctor',
    'quick.events': 'Event stream',

    'view.overview.title': 'Overview',
    'view.overview.sub': 'Agents, throughput, and live workbench health',
    'view.tasks.title': 'Tasks & Kanban',
    'view.tasks.sub': 'Receipt ledger, Kanban lanes and batch filters',
    'view.dag.title': 'DAG & Playbooks',
    'view.dag.sub': 'Visual dependency graph and four battle-tested pipelines',
    'view.worktrees.title': 'Worktrees',
    'view.worktrees.sub': 'Review · Verify · Merge · Cleanup',
    'view.toolkit.title': 'Toolkit & Memory',
    'view.toolkit.sub': 'ast-grep · repomix · markitdown · beads · cass · FTS5',
    'view.ops.title': 'Ops & Doctor',
    'view.ops.sub': 'Self-improve & auto-heal, live audit events, 8-point doctor, hot backup',

    'kpi.agents': 'Agents online / registered',
    'kpi.agentsSub': 'online + idle, live probe',
    'kpi.tasks': 'Completed / total tasks',
    'kpi.tasksSub': 'real receipt ledger',
    'kpi.active': 'Running / needs attention',
    'kpi.activeSub': 'running / stalled',
    'kpi.worktrees': 'Active worktrees',
    'kpi.worktreesSub': 'branch isolation leases',
    'kpi.notes': 'Shared memory notes',
    'kpi.notesSub': 'SQLite FTS5',
    'kpi.cass': 'cass history index',
    'kpi.cassSub0': 'click to reindex',
    'kpi.cassSessions': '{n} sessions',
    'kpi.cassMessages': '{n} messages',
    'kpi.cassNotIndexed': 'Not indexed',
    'kpi.toolkit': 'Toolchain',

    'roster.title': 'Agent roster',
    'roster.sub': 'Live state, historical success rate and token usage for built-in and dynamically registered agents.',
    'roster.count': '{n} agents',
    'roster.empty': 'No agents registered yet. Use “Add agent” to connect a local model or CLI.',
    'roster.ext': 'custom',
    'roster.receipts': '{done}/{total} receipts',
    'roster.success': 'success {pct}%',
    'roster.cooldown': 'Clear cooldown {s}s',
    'roster.testConn': 'Test connection',
    'roster.testing': 'Testing…',
    'roster.remove': 'Remove',
    'roster.demoScan': 'Demo mode · local scanning is disabled.',

    'ov.recent.title': 'Recent tasks',
    'ov.recent.sub': 'Latest movement in the real receipt ledger.',
    'ov.recent.open': 'Open board →',
    'ov.recent.empty': 'No tasks yet. Use “+ Dispatch” to start a collaboration.',
    'ov.wt.title': 'Active worktrees',
    'ov.wt.sub': 'Concurrent Git branch isolation and test gates.',
    'ov.wt.all': 'All →',
    'ov.wt.empty': 'No active parallel worktree right now.',

    'banner.stalled': '{n} task(s) look stalled or need verification:',
    'banner.action': 'Inspect & resolve',

    'tasks.title': 'Tasks & Kanban',
    'tasks.sub': 'Ledger table and Kanban board. Open a task for receipts, live output and cancellation.',
    'tasks.tableTab': 'Ledger',
    'tasks.kanbanTab': 'Kanban',
    'tasks.count': '{shown} / {total}',
    'tasks.filterPh': 'Filter by title / ID / content…',
    'tasks.filterAgentAll': 'All agents',
    'tasks.filterStateAll': 'All states',
    'tasks.reset': 'Reset',
    'tasks.empty': 'No matching tasks. Adjust the filters or use “+ Dispatch” to start a collaboration.',

    'th.task': 'Task / role',
    'th.agent': 'Agent · channel',
    'th.state': 'State',
    'th.receipt': 'Receipt ID',
    'th.summary': 'Summary / updated',

    'kb.queued': 'Queued / dispatching',
    'kb.running': 'Running',
    'kb.attention': 'Needs attention / blocked',
    'kb.done': 'Done / ended',
    'kb.empty': 'Empty',

    'state.online': 'Online',
    'state.idle': 'Idle',
    'state.dormant': 'Dormant',
    'state.stale': 'Snapshot stale',
    'state.cooldown': '429 cooldown',
    'state.offline': 'Offline',
    'state.unknown': 'Unprobed',
    'state.created': 'Registered',
    'state.dispatching': 'Dispatching',
    'state.dispatched': 'Dispatched',
    'state.running': 'Running',
    'state.stalled': 'Stalled',
    'state.needs_input': 'Needs input',
    'state.uncertain': 'Uncertain',
    'state.completed': 'Completed',
    'state.failed': 'Failed',
    'state.cancelled': 'Cancelled',
    'state.rerouted': 'Rerouted',
    'state.pass': 'Pass',
    'state.warn': 'Warning',
    'state.fail': 'Failing',

    'time.justNow': 'just now',
    'time.m': '{n}m ago',
    'time.h': '{n}h ago',
    'time.d': '{n}d ago',

    'dag.planPrompt': 'Propose the core architecture and the minimal implementation path.',
    'dag.redteamPrompt': 'Red-team the plan from first principles: security, concurrency and maintenance traps.',
    'dag.verdictPrompt': 'Synthesize both sides into a final decision and an actionable checklist.',
    'dag.debate.advocate': 'Argue as the advocate for the strongest engineering architecture.',
    'dag.debate.redteam': 'Argue as the red team against every security, race and maintenance trap.',
    'dag.debate.verdict': 'Synthesize both sides into a final decision and an action list.',
    'dag.pipe.research': 'Research the module structure and its boundary conditions.',
    'dag.pipe.review': 'Given the research, list the core defects and refactoring targets.',
    'dag.pipe.summary': 'Produce a concise summary and a prioritized recommendation.',
    'dag.title': 'Visual DAG orchestration',
    'dag.sub': 'Edit steps and dependencies; the canvas redraws nodes and dependency curves live.',
    'dag.tplDebate': 'Adversarial debate',
    'dag.tplPipeline': 'Research pipeline',
    'dag.tplLabel': 'Saved templates',
    'dag.tplNameLabel': 'Template name',
    'dag.tplNamePh': 'review-squad',
    'dag.tplSave': 'Save',
    'dag.tplDelete': 'Delete',
    'dag.tplNone': '— built-in presets only —',
    'dag.tplSaved': 'DAG template “{name}” saved to this browser.',
    'dag.tplLoaded': 'Loaded DAG template “{name}”.',
    'dag.tplDeleted': 'DAG template “{name}” deleted.',
    'dag.tplNeedName': 'Type a template name first.',
    'dag.tplNeedSteps': 'There is nothing to save yet — add at least one step.',
    'dag.tplPickFirst': 'Pick a saved template to delete.',
    'dag.name': 'Workflow name',
    'dag.dir': 'Project directory',
    'dag.dirPh': 'Pick or type a project directory…',
    'dag.addStep': '+ Add step',
    'dag.run': 'Run DAG workflow',
    'dag.stepNo': 'Step {n} · {id}',
    'dag.stepId': 'Step ID',
    'dag.agent': 'Agent',
    'dag.depends': 'Depends on (comma separated)',
    'dag.dependsPh': 'Empty = first parallel wave',
    'dag.prompt': 'Prompt (upstream output is injected automatically)',
    'dag.delete': 'Delete',
    'dag.autoRoute': 'auto (smart routing)',
    'dag.emptySteps': 'No steps yet. Use “+ Add step” or apply a template above.',
    'dag.canvas.title': 'Flow Canvas',
    'dag.canvas.sub': 'Live dependency graph · click a live node to open its task',
    'dag.nodes': '{n} nodes',
    'dag.nodesEdges': '{n} nodes · {e} edges',
    'dag.emptyCanvas': 'Add a step to draw the dependency graph',
    'dag.cycle': 'Circular dependency detected: {ids}',
    'dag.batchLabel': 'Live execution batch',
    'dag.batchNone': '— design only (no batch) —',
    'dag.batchOption': '{id} · {summary}',
    'dag.batchRunning': 'live',
    'dag.recommendBatch': 'auto-bound to the newest batch',
    'dag.resume': 'Resume Failed',
    'dag.resumePending': 'Resuming…',
    'dag.simulate': '▶ Simulate Live DAG',
    'dag.simulateAgain': '▶ Simulate again',
    'dag.simRunning': 'Simulating…',
    'dag.simStop': '■ Stop simulation',
    'dag.stepLimit': 'A DAG can hold at most {max} steps.',
    'dag.legend.deps': 'depends_on',
    'dag.edgesHint': 'root',
    'dag.liveDuration': '{d}',
    'dag.liveQueued': 'queued',

    'legend.running': 'running',
    'legend.completed': 'completed',
    'legend.failed': 'failed',
    'legend.stalled': 'stalled',

    'pb.title': 'Playbooks',
    'pb.sub': 'Four battle-tested pipelines: chain tooling, memory, parallel agents and worktree leases.',
    'pb.research.desc': 'Cross-agent history + doc → MD + repo packing → automatically written into shared memory.',
    'pb.review.desc': 'repomix + AST packing → parallel independent multi-agent code review.',
    'pb.debate.desc': 'Advocate vs red-team adversarial review → automatic arbitration DAG.',
    'pb.build.desc': 'Auto-create isolated worktrees + leases → dispatch implementation tasks.',
    'pb.configure': 'Configure & run →',
    'pb.summary': 'Playbook parameters',
    'pb.playbook': 'Playbook',
    'pb.dir': 'Project directory',
    'pb.goal': 'Goal / focus',
    'pb.goalPh': 'e.g. map authentication boundaries and concurrency risks',
    'pb.include': 'Include glob (optional)',
    'pb.members': 'Members (comma separated, empty = auto)',
    'pb.membersPh': 'Leave empty to auto-pick online agents',
    'pb.extra': 'Search term / AST pattern (optional)',
    'pb.extraPh': 'CollabHub or export function $NAME($$$) { $$$ }',
    'pb.execute': 'Execute now',
    'pb.running': 'Running…',
    'pb.done': 'Playbook finished.',
    'pb.demo': 'Demo preview is read-only: the playbook will not run.',

    'wt.title': 'Concurrent Git worktree isolation',
    'wt.sub': 'Each implementation task owns a branch; merge or cleanup only after the test gate passes.',
    'wt.empty': 'No active parallel worktree. Dispatching an implementation task creates an isolated branch automatically.',
    'wt.member': 'Member {member} · base {base}',
    'wt.path': 'Path {path}',
    'wt.updated': 'Updated {time}',
    'wt.review': 'Review diff',
    'wt.cleanup': 'Cleanup',
    'wt.verify': 'verify: {status}',
    'wt.notVerified': 'Not verified',
    'wt.step1.title': 'Review Diff',
    'wt.step1.desc': 'Inspect commits, dirty state and the colorized diff preview to confirm scope.',
    'wt.step2.title': 'Verify Gate',
    'wt.step2.desc': 'Run the allowlisted test suite inside the isolated directory; failure blocks the merge.',
    'wt.step3.title': 'Merge / Cleanup',
    'wt.step3.desc': 'Merge into the base branch once verified; abandon by cleaning the lease and branch.',
    'wt.reviewTitle': 'Worktree review · {branch}',
    'wt.metaTask': 'Task',
    'wt.metaBase': 'Base',
    'wt.metaHead': 'HEAD',
    'wt.metaDirty': 'Dirty',
    'wt.dirtyYes': 'yes',
    'wt.dirtyNo': 'no',
    'wt.commits': 'Commits ({n})',
    'wt.noCommits': '(no new commits)',
    'wt.diff': 'Diff Preview',
    'wt.noDiff': '(no changes)',
    'wt.demoNote': 'Demo preview · the review below is sample data and the actions are disabled.',
    'wt.runVerify': 'Run test gate',
    'wt.verifying': 'Running tests…',
    'wt.merge': 'Verified — merge into {base}',
    'wt.abandon': 'Abandon and clean up',
    'wt.merged': 'Worktree merged and cleaned up.',
    'wt.cleaned': 'Worktree cleaned up.',
    'wt.verifyPass': 'Test gate passed.',
    'wt.verifyFail': 'Test gate failed (exit {code}).',
    'wt.verifyFailShort': 'Verification failed: {error}',
    'wt.mergeFail': 'Merge failed: {error}',
    'wt.cleanupFail': 'Cleanup failed: {error}',
    'wt.reviewFail': 'Worktree review failed: {error}',
    'wt.missing': 'Worktree not found.',
    'wt.verifyHeader': '[{preset} | {status} | {ms}ms]',
    'wt.noOutput': '(no output)',
    'wt.demoReadonly': 'Demo preview is read-only.',
    'wt.missingDiff': '(no diff)',

    'tk.title': 'Open-source engineering toolkit',
    'tk.sub': 'ast-grep · repomix · markitdown · beads, every call strictly directory-jailed.',
    'tk.tabAst': 'AST search',
    'tk.tabPack': 'Repomix packing',
    'tk.tabDoc': 'MarkItDown → MD',
    'tk.tabBeads': 'Beads dependency graph',
    'tk.dir': 'Project directory',
    'tk.dirPh': 'Project directory…',
    'tk.pattern': 'AST pattern',
    'tk.lang': 'Language',
    'tk.include': 'Include glob (optional)',
    'tk.docPath': 'Workspace document path (PDF / DOCX / XLSX / PPTX / HTML / MD)',
    'tk.docPathPh': 'Pick or type an absolute document path…',
    'tk.action': 'Action',
    'tk.bd.list': 'list (list tasks)',
    'tk.bd.ready': 'ready (runnable tasks)',
    'tk.bd.init': 'init (init beads repo)',
    'tk.bd.create': 'create (new task)',
    'tk.bdTitle': 'Title (create only)',
    'tk.bdTitlePh': 'New task title…',
    'tk.runAst': 'Run AST search',
    'tk.runPack': 'Pack context (repomix)',
    'tk.runDoc': 'Convert to Markdown',
    'tk.runBeads': 'Run Beads',
    'tk.metaIdle': 'Pick a tool above to run it (strict directory jail enforced)',
    'tk.copy': 'Copy output',
    'tk.astHits': 'AST hits: {n}',
    'tk.packDone': 'Packed · about {n} tokens',
    'tk.docDone': 'Converted · {n} chars',
    'tk.beadsDone': 'Beads {action} finished',
    'tk.outCopied': 'Output copied.',

    'sess.title': 'Cross-agent session search',
    'sess.sub': 'Search Codex / Claude / AGY history indexed by cass.',
    'sess.reindex': 'Update index',
    'sess.reindexing': 'Indexing…',
    'sess.placeholder': 'Search historical session keywords…',
    'sess.idle': "Type keywords to search this machine's cross-agent history (read-only).",
    'sess.search': 'Search',
    'sess.searching': 'Searching…',
    'sess.demo': 'Static demo mode does not read the local cross-agent index. Use keywords in the real workbench.',
    'sess.fail': 'Search failed: {error}',
    'sess.noMatch': 'No match',
    'sess.reindexed': 'cass index updated.',
    'sess.reindexedDetail': 'Index updated{c}{p}',
    'sess.reindexedCounts': ' ({c} sessions / {m} messages)',
    'sess.reindexedPartial': ' · skipped logs still being written',
    'sess.reindexFail': 'Indexing failed: {error}',

    'mem.title': 'Shared project memory',
    'mem.sub': 'SQLite FTS5 full-text search + Markdown rich text.',
    'mem.write': '+ New note',
    'mem.placeholder': 'Search with Chinese / English keywords…',
    'mem.search': 'Search',
    'mem.empty': 'No shared memory notes yet. Use “+ New note” to write the first one.',
    'mem.none': 'Note not found or already deleted.',
    'mem.openFail': 'Failed to open the note: {error}',
    'mem.searchFail': 'Memory search failed: {error}',
    'mem.project': 'Project',
    'mem.slug': 'Slug',
    'mem.author': 'Author',
    'mem.markdown': 'Raw MD',
    'mem.preview': 'Preview',

    'ops.doctor.title': '8-Point Doctor',
    'ops.doctor.sub': 'Health checks for runtime, database, toolchain, directories and security policy.',
    'ops.doctor.refresh': 'Re-run',
    'ops.doctor.backingUp': 'Checking…',
    'ops.doctor.backup': 'Hot backup hub.db',
    'ops.doctor.running': 'Running 8 system checks…',
    'ops.doctor.fail': 'Doctor failed: {error}',
    'ops.doctor.overall': '{pass}/{total} checks passed',
    'ops.doctor.demo': ' · demo fixture data',
    'ops.doctor.empty': 'No audit events yet.',
    'ops.events.title': 'Live audit events',
    'ops.events.sub': 'SSE audit stream; every event traces back to a task / actor.',
    'ops.events.refresh': 'Refresh',
    'ops.events.fail': 'Failed to load audit events: {error}',
    'ops.health.title': 'Runtime info',
    'ops.health.sub': 'Local dashboard, version and toolchain state.',
    'ops.backup.running': 'Running a safe hot backup (VACUUM INTO)…',
    'ops.backup.ok': 'Hot backup written: {path} ({kb}KB, keeping the newest {retained})',
    'ops.backup.fail': 'Backup failed: {error}',
    'ops.backup.done': 'Hot backup finished.',
    'ops.backup.demo': 'Demo preview is read-only: hot backup is disabled.',

    /* v1.4 — self-improvement & auto-heal */
    'self.title': 'Self-Improvement & Auto-Heal',
    'self.sub': 'Diagnose runtime findings, preview a safe heal, then apply it — every run lands in the audit trail.',
    'self.btnCheck': 'Run self-diagnosis',
    'self.btnDry': 'Preview auto-heal',
    'self.btnApply': 'Apply safe auto-heal',
    'self.of100': '/ 100',
    'self.statusIdle': 'Awaiting diagnosis',
    'self.statusHealthy': 'Healthy',
    'self.statusDegraded': 'Degraded',
    'self.statusUnhealthy': 'Unhealthy',
    'self.summaryIdle': 'No diagnosis yet — run a self-check to inspect findings and learned guardrails.',
    'self.summaryNone': 'All checks passed — nothing to heal.',
    'self.statFindings': 'Findings',
    'self.statHealable': 'Auto-healable',
    'self.statLessons': 'Active guardrails',
    'self.statLastHeal': 'Last heal',
    'self.lastHealNever': 'never',
    'self.findingsTitle': 'Findings',
    'self.lessonsTitle': 'Learned guardrails',
    'self.runsTitle': 'Recent self-heal audit trail',
    'self.findingsEmpty': 'No findings loaded yet.',
    'self.lessonsEmpty': 'No learned guardrails yet.',
    'self.runsEmpty': 'No self-heal runs recorded yet.',
    'self.lProject': 'Project',
    'self.lMember': 'Member',
    'self.lRole': 'Role',
    'self.lError': 'Error code',
    'self.lPattern': 'Pattern',
    'self.lGuardrail': 'Guardrail',
    'self.lProjectPh': 'collab-hub',
    'self.lMemberPh': 'codex',
    'self.lRolePh': 'reviewer',
    'self.lErrorPh': 'harness_down',
    'self.lPatternPh': 'timeout|ECONNRESET',
    'self.lGuardrailPh': 'Retry once with a 30s backoff before escalating.',
    'self.btnAddGuardrail': '+ Add guardrail',
    'self.lessonHint': 'Injected into future agent prompts.',
    'self.healAuto': 'Auto-healable',
    'self.healManual': 'Operator review',
    'self.actionLabel': 'Recommended',
    'self.checkedAt': 'Checked {time}',
    'self.lessonActive': 'Active',
    'self.lessonPaused': 'Paused',
    'self.hits': '{n} hits',
    'self.autoLearned': 'auto',
    'self.modeApply': 'apply',
    'self.modeDry': 'dry-run',
    'self.runHealed': '{n} healed',
    'self.runFindings': '{n} findings',
    'self.previewTitle': 'Dry-run preview',
    'self.previewApplied': 'Applied',
    'self.previewDelta': '{before} → {after}',
    'self.previewCount': '×{n}',
    'self.previewEmpty': 'Nothing to heal right now.',
    'self.sev.high': 'high',
    'self.sev.medium': 'medium',
    'self.sev.low': 'low',
    'self.sev.info': 'info',
    'self.toastCheckDemo': 'Self-diagnosis refreshed from the demo fixture.',
    'self.toastCheckOk': 'Self-diagnosis complete · health {score}/100.',
    'self.toastCheckFail': 'Self-diagnosis failed: {error}',
    'self.toastDryDemo': 'Dry-run preview: {n} findings could be healed (demo, nothing applied).',
    'self.toastDryOk': 'Dry-run preview: {n} findings could be healed.',
    'self.toastDryFail': 'Dry-run failed: {error}',
    'self.toastNoHealable': 'Nothing is auto-healable right now — operator review required.',
    'self.toastApplyDemo': 'Demo auto-heal applied: {before} → {after} (in-memory only).',
    'self.toastApplyOk': 'Auto-heal applied: {healed} healed, health {before} → {after}.',
    'self.toastApplyFail': 'Auto-heal failed: {error}',
    'self.toastToggleDemo': 'Guardrail toggled in demo memory: {state}.',
    'self.toastToggleOk': 'Guardrail {state}.',
    'self.toastToggleFail': 'Could not toggle the guardrail: {error}',
    'self.toastLessonDemo': 'Guardrail added to the demo memory only.',
    'self.toastLessonSaved': 'Guardrail saved · it will be injected into future prompts.',
    'self.toastLessonFail': 'Could not save the guardrail: {error}',
    'self.toastLessonRequired': 'Guardrail text is required.',
    'self.active': 'Active',
    'self.paused': 'Paused',
    'self.pillLabel': 'Self-improve',
    'self.pillMeta': '{findings} findings · {lessons} guardrails',
    'self.pillAria': 'Self-improvement health {score} of 100, {overall}. Open the System self-heal console.',
    'self.demo.summary': '{healable} of {findings} findings are auto-healable; the rest need an operator decision.',
    'self.demo.summaryHealed': 'Auto-heal applied: {before} → {after}. {remaining} findings still need an operator.',
    'self.demo.f1.title': 'Stalled task demo-stall-01 holds a dead harness pid 4512',
    'self.demo.f1.detail': 'Heartbeat missing for 26 minutes; the child process is gone but the task row is still dispatched.',
    'self.demo.f1.action': 'kill_orphan_process',
    'self.demo.f2.title': 'Orphaned worktree branch collab/demo/verify-gate left by a failed verify',
    'self.demo.f2.detail': 'The worktree directory is gone while the branch still reserves the merge gate.',
    'self.demo.f2.action': 'release_worktree',
    'self.demo.f3.title': 'FTS5 memory index drifted from 128 to 116 rows',
    'self.demo.f3.detail': 'Twelve notes exist in the ledger but not in the index; a rebuild is required before search trusts it.',
    'self.demo.f3.action': 'rebuild_fts_index',
    'self.demo.f4.title': 'toolkit.repomix missing on PATH (falls back to git squash)',
    'self.demo.f4.detail': 'Pack reports lose per-file provenance until repomix is installed on the host.',
    'self.demo.f4.action': 'install_repomix',
    'self.demo.l1.guardrail': 'Retry once with a 30s backoff, then reroute to a healthy member instead of waiting on the harness.',
    'self.demo.l2.guardrail': 'Always attach the receipt id to the completion message; never close a review without one.',
    'self.demo.l3.guardrail': 'Declare the touched paths before editing; stop and ask when the diff grows past them.',
    'self.demo.run1.summary': 'Restarted delta and released one orphan worktree.',
    'self.demo.run2.summary': 'Preview only — no changes applied.',
    'self.demo.runNew': 'Auto-heal: restarted the stalled member and released the orphan worktree.',
    'self.demo.action1': 'restart_member',
    'self.demo.action2': 'release_worktree',
    'self.demo.lessonNew.pattern': 'stalled task with a dead child process',
    'self.demo.lessonNew.guardrail': 'When a task stalls with no child process, kill the orphan row and reroute instead of retrying blindly.',

    'health.version': 'Version',
    'health.uptime': 'Uptime',
    'health.pid': 'PID',
    'health.mail': 'Mail hub',
    'health.toolkit': 'Toolkit',
    'health.mode': 'Mode',
    'health.offline': 'offline',
    'health.installed': '{n} installed',
    'health.modeDemo': 'read-only demo',
    'health.modeStatic': 'static demo',
    'health.modeLive': 'live',

    'agent.title': 'Register a new agent',
    'agent.sub': 'Scan this machine for models / CLIs / desktop apps, or start from a preset.',
    'agent.scan': 'Scan local Ollama / CLI / env',
    'agent.scanning': 'Read-only scanning of local Ollama / LM Studio / vLLM / CLI / env…',
    'agent.demoScan': 'Demo mode · local scanning is disabled (avoids leaking host details). The real workbench only scans Ollama / LM Studio / CLI / env read-only.',
    'agent.endpoints': 'Endpoint scan: {summary}',
    'agent.endpointOff': '{label}: down',
    'agent.endpointOn': '{label}: {n} models',
    'agent.noEndpoint': 'none',
    'agent.nothing': 'No local model or CLI detected yet; you can still use the presets above.',
    'agent.discoverFail': 'Scan failed: {error}',
    'agent.fill': 'Fill the form',
    'agent.id': 'Agent ID (lowercase letters / digits / dashes)',
    'agent.name': 'Display name',
    'agent.driver': 'Driver',
    'agent.driverHttp': 'openai-http (local Ollama / LM Studio / vLLM / any gateway model)',
    'agent.driverCli': 'generic-cli (gemini / aider / opencode / qwen / local scripts)',
    'agent.driverDesktop': 'desktop-native (Cursor / Windsurf desktop sessions)',
    'agent.roles': 'Supported roles (comma separated)',
    'agent.config': 'Driver config JSON (api_key holds an env var name only, never plaintext)',
    'agent.save': 'Register & connect',
    'agent.saved': 'Agent registered.',
    'agent.badJson': 'The driver config is not valid JSON.',
    'agent.saveFail': 'Registration failed: {error}',
    'agent.testResult': 'Agent {id} connectivity: {state}',
    'agent.testFail': 'Test failed: {error}',
    'agent.remove': 'Agent removed.',
    'agent.removeFail': 'Remove failed: {error}',
    'agent.cleared': 'Cooldown cleared.',
    'agent.cooldownFail': 'Clearing the cooldown failed: {error}',
    'agent.probed': 'Agent probe finished.',
    'agent.probeThrottled': 'Probe throttled; retry in {s}s.',
    'agent.probeFail': 'Probe failed: {error}',
    'agent.probeDemo': 'Demo mode · probing disabled (no local endpoints are contacted).',

    'dispatch.title': 'Dispatch a background task',
    'dispatch.sub': 'Smart routing + prompt recipes + workspace autocomplete.',
    'dispatch.recipe': 'Use a built-in prompt recipe (optional)',
    'dispatch.recipeManual': '-- write the prompt manually --',
    'dispatch.member': 'Executing agent (auto picks from live probe + historical success)',
    'dispatch.role': 'Role',
    'dispatch.dir': 'Project directory (workspace autocomplete)',
    'dispatch.dirPh': 'Pick or type an absolute project path…',
    'dispatch.taskTitle': 'Task title',
    'dispatch.taskTitlePh': 'e.g. Independently review auth module boundaries',
    'dispatch.prompt': 'Prompt',
    'dispatch.promptPh': 'State the goal, scope, deliverable and acceptance criteria…',
    'dispatch.fallback': 'Auto-fall back to another online background agent when the target is offline or in 429 cooldown (never re-sends an already-sent task)',
    'dispatch.submit': 'Dispatch now',
    'dispatch.auto': '✨ auto (route by live state + historical success)',
    'dispatch.done': 'Task dispatched.',
    'dispatch.asyncQueued': 'Dispatched async (HTTP 202) · streaming live logs…',
    'dispatch.demo': 'Demo preview is read-only: dispatch is disabled.',

    'role.researcher': 'researcher (research)',
    'role.reviewer': 'reviewer (review)',
    'role.implementer': 'implementer (implementation)',
    'role.tester': 'tester (testing)',
    'role.planner': 'planner (planning)',
    'role.synthesizer': 'synthesizer (synthesis)',

    'memory.title': 'Write shared project memory',
    'memory.sub': 'Markdown + SQLite FTS5, searchable across agents.',
    'memory.project': 'Project key',
    'memory.noteTitle': 'Title',
    'memory.noteTitlePh': 'e.g. Deployment and troubleshooting notes',
    'memory.tags': 'Tags (comma separated)',
    'memory.content': 'Content (Markdown supported)',
    'memory.contentPh': 'Record the conventions, boundaries, traps and decisions agents must share…',
    'memory.save': 'Save note',
    'memory.saved': 'Shared memory written.',

    'palette.placeholder': 'Search tasks, views and commands…',
    'palette.groupActions': 'Actions',
    'palette.groupViews': 'Views',
    'palette.groupTasks': 'Tasks',
    'palette.empty': 'No matching command or task. Try “dispatch” or a task keyword.',
    'palette.select': 'select',
    'palette.open': 'open',
    'palette.close': 'close',
    'palette.kindAction': 'action',
    'palette.kindView': 'view',
    'palette.kindTask': 'task',
    'palette.dispatch': 'Dispatch a new task',
    'palette.dispatchSub': 'Dispatch a background task',
    'palette.probe': 'Probe all agents',
    'palette.probeSub': 'Probe members and the mail hub',
    'palette.memory': 'Write shared memory',
    'palette.memorySub': 'Write an FTS5 memory note',
    'palette.agent': 'Add a new agent',
    'palette.agentSub': 'Register an agent',
    'palette.theme': 'Toggle dark / light theme',
    'palette.themeSub': 'Toggle obsidian / alabaster',
    'palette.lang': 'Switch language (EN / ZH)',
    'palette.langSub': 'Toggle English / Chinese',
    'palette.reindex': 'Update the cass index',
    'palette.reindexSub': 'Reindex cross-agent sessions',
    'palette.doctor': 'Run the doctor',
    'palette.doctorSub': 'Run the 8-point doctor',
    'palette.viewCmd': '{zh} · {en}',

    'drawer.task': 'Task',
    'drawer.agent': 'Agent',
    'drawer.project': 'Project directory',
    'drawer.role': 'Role',
    'drawer.routedFrom': ' · auto-routed from {from}',
    'drawer.receipt': 'Receipt ID',
    'drawer.session': 'Session',
    'drawer.generation': ' · gen {n}',
    'drawer.batch': 'Batch',
    'drawer.depends': 'Depends on',
    'drawer.updated': 'Updated',
    'drawer.prompt': 'Prompt',
    'drawer.result': 'Full result',
    'drawer.error': 'Diagnostics / blockers',
    'drawer.events': 'Audit events ({n})',
    'drawer.noEvents': 'No events',
    'drawer.poll': 'Poll receipt now',
    'drawer.polling': 'Polling…',
    'drawer.reroute': 'Mark rerouted',
    'drawer.failed': 'Mark failed',
    'drawer.reconciled': 'Task state reconciled.',
    'drawer.reconcileFail': 'Reconcile failed: {error}',
    'drawer.pollFail': 'Poll failed: {error}',
    'drawer.openFail': 'Failed to open the task: {error}',
    'drawer.missing': 'Task not found.',
    'drawer.reconcileNote': 'Updated from the CollabHub v1.3 workbench',

    'log.title': 'Live Output',
    'log.live': 'streaming',
    'log.done': 'finished',
    'log.empty': 'No output captured yet.',
    'log.copy': 'Copy',
    'log.copied': 'Log copied.',
    'log.followOn': 'Auto-scroll: on',
    'log.followOff': 'Auto-scroll: paused',
    'log.demo': 'demo fixture',
    'log.fetchFail': 'Live output unavailable: {error}',
    'log.truncated': '… earlier lines trimmed …',
    'log.follow': '⤓ Follow',
    'log.followTitle': 'Auto-scroll follows the newest output',

    'cancel.label': 'Cancel',
    'cancel.confirm': 'Cancel task {id}?',
    'cancel.pending': 'Cancelling…',
    'cancel.done': 'Task cancelled.',
    'cancel.doneAbort': 'Task cancelled and the live process was aborted.',
    'cancel.demo': 'Demo preview is read-only: no task was cancelled.',
    'cancel.fail': 'Cancel failed: {error}',
    'cancel.alreadyTerminal': 'This task already reached a terminal state.',
    'cancel.requested': 'Cancel requested · waiting for owner pid {pid} to confirm.',
    'cancel.requestedPill': 'cancel requested · owner pid {pid}',
    'cancel.notConfirmed': 'Cancellation was not confirmed.',
    'cancel.force': 'Force Cancel',
    'cancel.forceConfirm': 'Confirm Force Cancel',
    'cancel.forceHint': 'Click Force Cancel again within 5s to force-mark this task as cancelled.',
    'cancel.forceDone': 'Task force-marked as cancelled.',
    'drawer.demoNote': 'Demo preview · read-only fixture data, no live backend is attached.',
    'cancel.event': 'Task {id} was cancelled by {member}.',

    'resume.label': 'Resume Failed',
    'resume.pending': 'Resuming…',
    'resume.done': 'Batch {batch} resumed · skipped {skipped} completed, retried {retried}.',
    'resume.none': 'Nothing to resume in batch {batch}.',
    'resume.blocked': 'Resume blocked · {n} uncertain steps need review before retrying.',
    'resume.demo': 'Demo preview is read-only: the batch was not resumed.',
    'resume.fail': 'Resume failed: {error}',
    'resume.noBatch': 'Select a live batch first.',

    'batch.title': 'Batch report · {id}',
    'batch.md': 'Markdown export',
    'batch.raw': 'Raw MD',
    'batch.copy': 'Copy MD',
    'batch.copied': 'Report copied.',
    'batch.fail': 'Batch report export failed: {error}',
    'batch.open': 'Collaboration batches (click to export):',
    'batch.allOk': 'all succeeded',
    'batch.stalled': 'has stalled',
    'batch.ended': 'ended',
    'batch.active': 'in progress',
    'batch.demoNote': 'Read-only demo fixture. No live task state was queried.',
    'batch.summary': 'Summary',
    'batch.total': 'Total tasks',
    'batch.terminal': 'Terminal',
    'batch.failures': 'Failures',
    'batch.tasks': 'Tasks',
    'batch.notes': 'Notes',
    'batch.yes': 'yes',
    'batch.no': 'no',
    'batch.note1': 'All identifiers and paths in this report are synthetic.',
    'batch.note2': 'The production report includes full receipts, latency, and token usage.',

    'diff.added': 'added',
    'diff.removed': 'removed',
    'diff.hunk': 'hunk',

    'toast.loadFail': 'Failed to load the overview: {error}',
    'toast.demoReadonly': 'Demo preview is read-only: write operations are disabled.',
    'toast.dagSubmitted': 'DAG workflow submitted.',
    'toast.dagDemo': 'Demo preview is read-only: the DAG was not dispatched.',
    'toast.mailOffline': 'Mail hub is not connected.',
    'toast.mailDemo': 'Demo preview · the mail hub is not connected here.',
    'toast.copied': 'Copied.',
    'toast.copyFail': 'Copy failed: the browser denied clipboard access.',
    'toast.somethingWentWrong': '{error}',

    'doctor.runtime': 'Node.js runtime satisfies the minimum version',
    'doctor.db': 'SQLite FTS5 available; memory index healthy',
    'doctor.dirs': 'Runtime directories writable',
    'doctor.mail': 'Mail hub reachable at the local MCP endpoint',
    'doctor.ast': 'ast-grep available on PATH',
    'doctor.repomix': 'repomix not found; the pack tool falls back',
    'doctor.sandbox': 'Workspace sandbox roots configured',
    'doctor.backup': 'Hot backup created within the last 24h',

    'sim.title': 'Simulated · {id}',
    'sim.started': 'Simulated DAG run started (2 root steps in parallel).',
    'sim.done': 'Simulated DAG run finished: all steps completed.',
    'sim.batch': 'sim-{n}',
    'sim.prompt': 'Simulated {role} step for the static demo.',
    'sim.toastNode': 'Step {id} → {state}',
    'sim.logBoot': 'dispatching step "{id}" to the router…',
    'sim.logAgent': 'agent selected · role={role} · channel=sim',
    'sim.logPlan': 'planning: reading upstream context and constraints…',
    'sim.logWork': 'executing: {n} intermediate artifacts produced',
    'sim.logTool': 'tool call ok · 128ms · exit 0',
    'sim.logStream': 'streaming chunk {n}/6 · 512 bytes',
    'sim.logWarn': 'warning: retrying one transient step boundary',
    'sim.logDone': 'step completed in {d} · exit 0',
    'sim.logVerdict': 'synthesizing final verdict from {n} upstream steps…',

    'demo.task.queue01': 'Scaffold release notes generator',
    'demo.task.run01': 'Audit worktree merge gate',
    'demo.task.stall01': 'Reconcile flaky SSE reconnect test',
    'demo.task.review01': 'Verify Kanban drag affordances',
    'demo.task.done01': 'Ship FTS5 memory search',
    'demo.task.done02': 'Prototype zero-dependency chart renderer',
    'demo.prompt.queue01': 'Generate release notes from the CHANGELOG sections and write them to docs/release-notes.md.',
    'demo.prompt.run01': 'Review the merge gate path for missing branch checks and report findings.',
    'demo.prompt.stall01': 'Reproduce the flaky reconnect test and reconcile the failing assertions.',
    'demo.prompt.review01': 'Verify keyboard and pointer affordances for moving cards between Kanban columns.',
    'demo.prompt.done01': 'Implement ranked full-text search over memory notes with highlight snippets.',
    'demo.prompt.done02': 'Prototype a canvas chart renderer with no third-party dependencies.',
    'demo.result.done01': 'Implemented ranked FTS5 search with highlight snippets.',
    'demo.err.harness': 'No heartbeat for 180s',
    'demo.err.receipt': '',
    'demo.err.scope': 'Scope exceeded: the chart engine is outside the v1.2 range',
    'demo.member.atlas': 'Responding (demo fixture)',
    'demo.member.beacon': 'Idle (demo fixture)',
    'demo.member.cipher': 'Baton attached (demo fixture)',
    'demo.member.delta': 'Cooling down after harness timeouts (demo fixture)',
    'demo.member.deltaReason': 'Repeated harness timeouts (demo fixture)',
    'demo.note1.title': 'v1.2 release checklist',
    'demo.note1.preview': '- Verify the asset allowlist · Confirm CSP has no unsafe-inline scripts',
    'demo.note2.title': 'DAG authoring conventions',
    'demo.note2.preview': 'Keep steps idempotent; declare depends_on explicitly.',
    'demo.evt.verify': 'worktree.verify_passed',
    'demo.evt.dispatched': 'task.dispatched',
    'demo.evt.reconciled': 'task.reconciled',
    'demo.evt.memory': 'memory.note_written',
    'demo.evt.cooldown': 'agent.cooldown',
    'demo.evt.batch': 'batch.report_exported',
    'demo.log.attach': 'attached to task {id} · sandbox /workspace/collab-demo',
    'demo.log.spawn': 'spawned worker pid=demo · channel attached',
    'demo.log.read1': 'reading project manifest and upstream context…',
    'demo.log.read2': 'loading 3 memory notes for grounding',
    'demo.log.tool': 'tool call ok · ast-grep · 2 matches',
    'demo.log.write': 'writing artifacts to the isolated worktree',
    'demo.log.exit': 'process exited 0 · 4.2s wall clock',
    'demo.log.stream': 'streaming chunk {n}/6 · 512 bytes',
    'demo.log.stderr': 'warning: transient retry on the receipt poll (retrying once)',
    'demo.log.killed': 'received SIGTERM · live process aborted',
    'demo.recipe.review': 'Independent code review',
    'demo.recipe.research': 'Research & summarize',
    'demo.recipe.reviewPrompt': 'Review the staged diff independently. List concrete defects with file/line references and severity. Do not restate the diff.',
    'demo.recipe.researchPrompt': 'Research the requested topic. Return a concise brief with sources, trade-offs, and a recommended next action.',
    'demo.commit1': 'feat: add worktree verify gate',
    'demo.commit2': 'test: cover asset allowlist traversal',
    'demo.commit3': 'docs: annotate the demo fixture',
    'demo.worktreeMissing': 'Worktree not found.',
  },

  zh: {
    'app.title': 'CollabHub v1.3 · 本地优先多 Agent 工作台',
    'app.titleDemo': 'CollabHub v1.3 · 演示预览',
    'app.titleStatic': 'CollabHub v1.3 · 静态演示 · GitHub Pages',

    'lang.glyphZh': '中',
    'lang.switch': '切换语言 / Switch language',
    'lang.current': '当前语言：简体中文',
    'lang.switched': 'Language switched to English.',
    'lang.switchedZh': '已切换为简体中文',

    'common.cancel': '取消',
    'common.close': '关闭',
    'common.none': '—',
    'common.copy': '复制',
    'common.copied': '已复制',
    'common.copyFail': '复制失败：浏览器未授予剪贴板权限。',
    'common.dismiss': '关闭提示',

    'brand.foot': 'CollabHub v1.3',
    'brand.deps': '0 个 npm 依赖',
    'brand.upgrade': '自 CollabHub v1.1 升级 · 支持纯静态 Demo',

    'nav.workspace': '工作区',
    'nav.system': '系统',
    'nav.overview': '总览',
    'nav.overviewAlt': 'Overview',
    'nav.tasks': '任务与看板',
    'nav.tasksAlt': 'Tasks & Kanban',
    'nav.dag': '编排与流水线',
    'nav.dagAlt': 'DAG & Playbooks',
    'nav.worktrees': '分支隔离',
    'nav.worktreesAlt': 'Worktrees',
    'nav.toolkit': '工具箱与记忆',
    'nav.toolkitAlt': 'Toolkit & Memory',
    'nav.ops': '系统与体检',
    'nav.opsAlt': 'System & Doctor',
    'side.probe': '探活所有 Agent',

    'topbar.nav': '切换导航',
    'topbar.demo': '● 演示预览',
    'topbar.static': '● 静态演示',
    'topbar.syncPending': '同步中',
    'topbar.syncing': '同步中…',
    'topbar.syncAt': '同步 {time}',
    'topbar.syncFailed': '同步失败',
    'topbar.mailTitle': 'Mail hub 状态',
    'topbar.mailChecking': 'Mail 检测中',
    'topbar.mailOnline': 'Mail v{version} · :5291',
    'topbar.mailOffline': 'Mail 离线',
    'topbar.sseConnecting': 'SSE 连接中',
    'topbar.sseLive': '● 实时 SSE',
    'topbar.ssePolling': '○ 轮询模式',
    'topbar.sseDemo': '演示 · 只读',
    'topbar.sseStatic': '静态 · 无事件流',
    'topbar.search': '搜索',
    'topbar.palette': '打开命令面板',
    'topbar.theme': '切换主题',
    'topbar.dispatch': '+ 派发',

    'theme.toDark': '切换到浅色主题',
    'theme.toLight': '切换到深色主题',
    'theme.switchedDark': '已切换到 Obsidian 深色主题。',
    'theme.switchedLight': '已切换到 Alabaster 浅色主题。',

    'quick.probe': '探活 Agent',
    'quick.agent': '扩展 Agent',
    'quick.memory': '写共享记忆',
    'quick.dag': '运行 DAG',
    'quick.ops': '系统体检',
    'quick.events': '事件流',

    'view.overview.title': '总览',
    'view.overview.sub': 'Agent 状态、吞吐与工作台实时健康度',
    'view.tasks.title': '任务与看板',
    'view.tasks.sub': '回执账本、Kanban 泳道与批量筛选',
    'view.dag.title': '编排与流水线',
    'view.dag.sub': '可视化依赖图与四套实战流水线',
    'view.worktrees.title': '分支隔离',
    'view.worktrees.sub': '审查 · 验收 · 合并 · 清理',
    'view.toolkit.title': '工具箱与记忆',
    'view.toolkit.sub': 'ast-grep · repomix · markitdown · beads · cass · FTS5',
    'view.ops.title': '审计与体检',
    'view.ops.sub': '自我改进与自愈、实时审计事件、8 项体检、热备份',

    'kpi.agents': '在线 / 注册 Agent',
    'kpi.agentsSub': 'online + idle 实时探活',
    'kpi.tasks': '已完成 / 总任务',
    'kpi.tasksSub': '真实回执账本',
    'kpi.active': '执行中 / 需关注',
    'kpi.activeSub': '执行中 / 已卡住',
    'kpi.worktrees': '活跃 Worktree',
    'kpi.worktreesSub': '分支隔离租约',
    'kpi.notes': '共享记忆笔记',
    'kpi.notesSub': 'SQLite FTS5',
    'kpi.cass': 'cass 历史索引',
    'kpi.cassSub0': '点击更新索引',
    'kpi.cassSessions': '{n} 会话',
    'kpi.cassMessages': '{n} 消息',
    'kpi.cassNotIndexed': '未索引',
    'kpi.toolkit': '工具链',

    'roster.title': 'Agent 名册',
    'roster.sub': '内置成员与动态扩展 Agent 的实时状态、历史成功率与令牌用量。',
    'roster.count': '{n} 个 Agent',
    'roster.empty': '暂无已注册 Agent。点击「扩展 Agent」接入本地模型或 CLI。',
    'roster.ext': '扩展',
    'roster.receipts': '{done}/{total} 回执',
    'roster.success': '成功率 {pct}%',
    'roster.cooldown': '解除冷却 {s}s',
    'roster.testConn': '测试连通',
    'roster.testing': '测试中…',
    'roster.remove': '移除',
    'roster.demoScan': '演示模式 · 本机扫描已禁用。',

    'ov.recent.title': '最近任务',
    'ov.recent.sub': '真实回执账本的最近动态。',
    'ov.recent.open': '打开看板 →',
    'ov.recent.empty': '暂无任务。点击「+ 派发」启动新协作。',
    'ov.wt.title': '活跃 Worktree',
    'ov.wt.sub': '并发 Git 分支隔离与测试闸门。',
    'ov.wt.all': '全部 →',
    'ov.wt.empty': '当前无活跃并行 Worktree。',

    'banner.stalled': '发现 {n} 项疑似卡住 / 待核验任务：',
    'banner.action': '查看诊断与处理',

    'tasks.title': '任务与看板',
    'tasks.sub': '表格账本与 Kanban 双视图；点开任务可查看回执、实时日志并中止执行。',
    'tasks.tableTab': '账本',
    'tasks.kanbanTab': '看板',
    'tasks.count': '{shown} / {total}',
    'tasks.filterPh': '筛选任务标题 / ID / 内容…',
    'tasks.filterAgentAll': '全部 Agent',
    'tasks.filterStateAll': '全部状态',
    'tasks.reset': '重置',
    'tasks.empty': '无匹配任务。调整筛选条件或点击「+ 派发」启动新协作。',

    'th.task': '任务 / 角色',
    'th.agent': 'Agent · 通道',
    'th.state': '状态',
    'th.receipt': '回执 ID',
    'th.summary': '摘要 / 更新时间',

    'kb.queued': '排队 / 派发中',
    'kb.running': '执行中',
    'kb.attention': '需关注 / 阻塞',
    'kb.done': '已结束',
    'kb.empty': '空',

    'state.online': '在线',
    'state.idle': '就绪',
    'state.dormant': '休眠',
    'state.stale': '快照过期',
    'state.cooldown': '429 冷却',
    'state.offline': '离线',
    'state.unknown': '待探测',
    'state.created': '已登记',
    'state.dispatching': '派发中',
    'state.dispatched': '已派发',
    'state.running': '执行中',
    'state.stalled': '疑似卡住',
    'state.needs_input': '待确认',
    'state.uncertain': '待核验',
    'state.completed': '已完成',
    'state.failed': '失败',
    'state.cancelled': '已中止',
    'state.rerouted': '已重路由',
    'state.pass': '通过',
    'state.warn': '警告',
    'state.fail': '异常',

    'time.justNow': '刚刚',
    'time.m': '{n} 分钟前',
    'time.h': '{n} 小时前',
    'time.d': '{n} 天前',

    'dag.planPrompt': '提出核心架构方案与最小实施路径。',
    'dag.redteamPrompt': '从第一性原理红队审查潜在安全、并发与维护风险。',
    'dag.verdictPrompt': '综合正反观点输出最终决策与落地清单。',
    'dag.debate.advocate': '作为正方提出最优工程架构方案。',
    'dag.debate.redteam': '作为红队审查所有安全、竞态与维护陷阱。',
    'dag.debate.verdict': '综合正反观点给出最终决策与行动清单。',
    'dag.pipe.research': '调研当前模块代码结构与边界条件。',
    'dag.pipe.review': '基于调研结果指出核心缺陷与重构点。',
    'dag.pipe.summary': '输出简洁总结与优先级建议。',
    'dag.title': '可视化 DAG 编排',
    'dag.sub': '编辑步骤与依赖，右侧画布实时重绘节点与依赖曲线。',
    'dag.tplDebate': '正反红队',
    'dag.tplPipeline': '调研流水线',
    'dag.tplLabel': '自定义模板',
    'dag.tplNameLabel': '模板名称',
    'dag.tplNamePh': 'review-squad',
    'dag.tplSave': '保存',
    'dag.tplDelete': '删除',
    'dag.tplNone': '— 仅内置预设 —',
    'dag.tplSaved': 'DAG 模板「{name}」已保存到本浏览器。',
    'dag.tplLoaded': '已载入 DAG 模板「{name}」。',
    'dag.tplDeleted': '已删除 DAG 模板「{name}」。',
    'dag.tplNeedName': '请先填写模板名称。',
    'dag.tplNeedSteps': '还没有可保存的步骤，至少添加一步。',
    'dag.tplPickFirst': '请选择要删除的已保存模板。',
    'dag.name': '工作流名称',
    'dag.dir': '项目目录',
    'dag.dirPh': '选择或输入项目目录…',
    'dag.addStep': '+ 添加步骤',
    'dag.run': '执行 DAG 工作流',
    'dag.stepNo': '第 {n} 步 · {id}',
    'dag.stepId': '步骤 ID',
    'dag.agent': '执行 Agent',
    'dag.depends': '依赖前置（逗号分隔）',
    'dag.dependsPh': '留空即首波并行',
    'dag.prompt': 'Prompt（上游输出自动注入）',
    'dag.delete': '删除',
    'dag.autoRoute': 'auto（智能路由）',
    'dag.emptySteps': '还没有步骤。点击「+ 添加步骤」或套用上方模板。',
    'dag.canvas.title': '流程画布',
    'dag.canvas.sub': '实时依赖图 · 点击运行中的节点直接打开任务',
    'dag.nodes': '{n} 个节点',
    'dag.nodesEdges': '{n} 个节点 · {e} 条依赖',
    'dag.emptyCanvas': '添加步骤后自动绘制依赖图',
    'dag.cycle': '检测到循环依赖：{ids}',
    'dag.batchLabel': '实时执行批次',
    'dag.batchNone': '— 仅设计模式（不绑定批次）—',
    'dag.batchOption': '{id} · {summary}',
    'dag.batchRunning': '实时',
    'dag.recommendBatch': '已自动绑定最新批次',
    'dag.resume': '断点续跑',
    'dag.resumePending': '续跑中…',
    'dag.simulate': '▶ 模拟 DAG 实时运行',
    'dag.simulateAgain': '▶ 再次模拟',
    'dag.simRunning': '模拟运行中…',
    'dag.simStop': '■ 停止模拟',
    'dag.stepLimit': '单个 DAG 最多支持 {max} 个步骤。',
    'dag.legend.deps': 'depends_on',
    'dag.edgesHint': '起始',
    'dag.liveDuration': '{d}',
    'dag.liveQueued': '排队中',

    'legend.running': '运行中',
    'legend.completed': '已完成',
    'legend.failed': '失败',
    'legend.stalled': '卡住',

    'pb.title': '流水线剧本',
    'pb.sub': '四套实战流水线：一键串联工具链、记忆、并行 Agent 与 Worktree 租约。',
    'pb.research.desc': '跨端历史 + 文档转 MD + 仓库打包 → 自动写入共享记忆。',
    'pb.review.desc': 'repomix + AST 打包 → 并行多 Agent 独立代码审查。',
    'pb.debate.desc': '正方方案 vs 反方红队对抗审查 → 自动仲裁 DAG。',
    'pb.build.desc': '自动建隔离 Worktree + 租约 → 派发实现任务。',
    'pb.configure': '配置并运行 →',
    'pb.summary': 'Playbook 运行参数',
    'pb.playbook': '剧本',
    'pb.dir': '项目目录',
    'pb.goal': '目标 / 关注点',
    'pb.goalPh': '例如：梳理认证边界条件与并发风险',
    'pb.include': '过滤 Glob（可选）',
    'pb.members': '指定成员（逗号分隔，留空自动）',
    'pb.membersPh': '留空自动挑选在线 Agent',
    'pb.extra': '检索词 / AST 模式（可选）',
    'pb.extraPh': 'CollabHub 或 export function $NAME($$$) { $$$ }',
    'pb.execute': '立即执行',
    'pb.running': '执行中…',
    'pb.done': 'Playbook 已执行。',
    'pb.demo': '演示预览为只读模式，Playbook 不会真正执行。',

    'wt.title': '并发 Git Worktree 隔离',
    'wt.sub': '每个实现任务独占一个分支；测试闸门通过后才能合并或清理。',
    'wt.empty': '当前无活跃并行 Worktree。实现类任务派发后会自动创建隔离分支。',
    'wt.member': '成员 {member} · 基线 {base}',
    'wt.path': '路径 {path}',
    'wt.updated': '更新 {time}',
    'wt.review': '审查 Diff',
    'wt.cleanup': '清理',
    'wt.verify': '验收：{status}',
    'wt.notVerified': '未验收',
    'wt.step1.title': '审查 Diff',
    'wt.step1.desc': '审查 commit 列表、脏状态与着色 diff 预览，确认改动范围。',
    'wt.step2.title': '运行验收',
    'wt.step2.desc': '在隔离目录内运行允许清单里的测试；失败即阻断合并。',
    'wt.step3.title': '合并 / 清理',
    'wt.step3.desc': '确认无误后合入基线分支；放弃时清理租约与分支。',
    'wt.reviewTitle': 'Worktree 审查 · {branch}',
    'wt.metaTask': '任务',
    'wt.metaBase': '基线',
    'wt.metaHead': 'HEAD',
    'wt.metaDirty': '脏状态',
    'wt.dirtyYes': '是',
    'wt.dirtyNo': '否',
    'wt.commits': '提交（{n}）',
    'wt.noCommits': '（无新提交）',
    'wt.diff': 'Diff 预览',
    'wt.noDiff': '（无改动）',
    'wt.demoNote': '演示预览 · 以下为示例审查数据，操作按钮已禁用。',
    'wt.runVerify': '运行测试验收',
    'wt.verifying': '测试运行中…',
    'wt.merge': '确认无误，合并入 {base}',
    'wt.abandon': '放弃并清理 Worktree',
    'wt.merged': 'Worktree 已合并并清理。',
    'wt.cleaned': 'Worktree 已清理。',
    'wt.verifyPass': '测试验收通过。',
    'wt.verifyFail': '测试验收未通过（exit {code}）。',
    'wt.verifyFailShort': '验证失败：{error}',
    'wt.mergeFail': '合并失败：{error}',
    'wt.cleanupFail': '清理失败：{error}',
    'wt.reviewFail': 'Worktree 审查失败：{error}',
    'wt.missing': 'Worktree 不存在。',
    'wt.verifyHeader': '[{preset} | {status} | {ms}ms]',
    'wt.noOutput': '（无输出）',
    'wt.demoReadonly': '演示预览为只读模式。',
    'wt.missingDiff': '（无 diff）',

    'tk.title': '开源工程工具箱',
    'tk.sub': 'ast-grep · repomix · markitdown · beads，全部严格目录沙箱。',
    'tk.tabAst': 'AST 语法树搜索',
    'tk.tabPack': 'Repomix 仓库打包',
    'tk.tabDoc': 'MarkItDown 文档转 MD',
    'tk.tabBeads': 'Beads 任务依赖图',
    'tk.dir': '项目目录',
    'tk.dirPh': '项目目录…',
    'tk.pattern': 'AST 匹配模式',
    'tk.lang': '语言',
    'tk.include': 'Include Glob（可选）',
    'tk.docPath': '工作区内文档路径（PDF / DOCX / XLSX / PPTX / HTML / MD）',
    'tk.docPathPh': '选择或输入文档绝对路径…',
    'tk.action': '操作',
    'tk.bd.list': 'list（列出任务）',
    'tk.bd.ready': 'ready（可执行任务）',
    'tk.bd.init': 'init（初始化 beads 仓库）',
    'tk.bd.create': 'create（新建任务）',
    'tk.bdTitle': '标题（仅 create 需要）',
    'tk.bdTitlePh': '新任务标题…',
    'tk.runAst': '执行 AST 搜索',
    'tk.runPack': '打包上下文 (repomix)',
    'tk.runDoc': '转换为 Markdown',
    'tk.runBeads': '执行 Beads',
    'tk.metaIdle': '选择上方工具执行（严格目录沙箱保护）',
    'tk.copy': '复制输出',
    'tk.astHits': 'AST 命中 {n} 处',
    'tk.packDone': '打包完成 · 约 {n} tokens',
    'tk.docDone': '转换完成 · {n} 字符',
    'tk.beadsDone': 'Beads {action} 完成',
    'tk.outCopied': '输出已复制。',

    'sess.title': '跨端历史会话秒搜',
    'sess.sub': 'cass 索引 Codex / Claude / AGY 的历史踩坑。',
    'sess.reindex': '更新索引',
    'sess.reindexing': '索引中…',
    'sess.placeholder': '搜历史会话关键词…',
    'sess.idle': '输入关键词检索本机跨 Agent 历史会话（只读落盘）。',
    'sess.search': '检索',
    'sess.searching': '检索中…',
    'sess.demo': '静态演示模式不读取本机跨端索引；在真实工作台输入关键词即可检索。',
    'sess.fail': '检索失败：{error}',
    'sess.noMatch': '无匹配',
    'sess.reindexed': 'cass 索引已更新。',
    'sess.reindexedDetail': '索引已更新{c}{p}',
    'sess.reindexedCounts': '（{c} 会话 / {m} 消息）',
    'sess.reindexedPartial': ' · 已跳过写入中日志',
    'sess.reindexFail': '索引失败：{error}',

    'mem.title': '跨成员共享项目记忆',
    'mem.sub': 'SQLite FTS5 全文检索 + Markdown 富文本。',
    'mem.write': '+ 记笔记',
    'mem.placeholder': '支持中文 / 英文关键词检索…',
    'mem.search': '检索',
    'mem.empty': '暂无共享记忆笔记。点击「+ 记笔记」写入第一条。',
    'mem.none': '笔记不存在或已被删除。',
    'mem.openFail': '打开笔记失败：{error}',
    'mem.searchFail': '记忆检索失败：{error}',
    'mem.project': '项目',
    'mem.slug': 'Slug',
    'mem.author': '作者',
    'mem.markdown': '原始 MD',
    'mem.preview': '富文本预览',

    'ops.doctor.title': '8 项系统体检',
    'ops.doctor.sub': '运行时、数据库、工具链、目录与安全策略的体检。',
    'ops.doctor.refresh': '重新体检',
    'ops.doctor.backingUp': '体检中…',
    'ops.doctor.backup': '热备份 hub.db',
    'ops.doctor.running': '正在执行 8 项系统体检…',
    'ops.doctor.fail': '体检失败：{error}',
    'ops.doctor.overall': '{pass}/{total} 项通过',
    'ops.doctor.demo': ' · 演示示例数据',
    'ops.doctor.empty': '暂无审计事件。',
    'ops.events.title': '实时审计事件',
    'ops.events.sub': 'SSE 实时审计流；每条事件都可追溯到 task / actor。',
    'ops.events.refresh': '刷新',
    'ops.events.fail': '加载审计事件失败：{error}',
    'ops.health.title': '运行信息',
    'ops.health.sub': '本机仪表盘、版本与工具链状态。',
    'ops.backup.running': '正在执行安全热备份 (VACUUM INTO)…',
    'ops.backup.ok': '热备份已生成：{path}（{kb}KB，保留最近 {retained} 份）',
    'ops.backup.fail': '备份失败：{error}',
    'ops.backup.done': '热备份完成。',
    'ops.backup.demo': '演示预览为只读模式，热备份已禁用。',

    /* v1.4 — 自我改进与自动自愈 */
    'self.title': '自我改进与自动自愈',
    'self.sub': '诊断运行时问题、预览安全自愈方案，再一键应用；每次执行都会写入审计轨迹。',
    'self.btnCheck': '运行自诊断',
    'self.btnDry': '预览自愈方案',
    'self.btnApply': '一键安全自愈',
    'self.of100': '/ 100',
    'self.statusIdle': '等待诊断',
    'self.statusHealthy': '健康',
    'self.statusDegraded': '降级',
    'self.statusUnhealthy': '不健康',
    'self.summaryIdle': '尚未诊断 —— 运行一次自诊断，查看问题清单与已学习的护栏。',
    'self.summaryNone': '全部检查通过 —— 当前没有需要自愈的问题。',
    'self.statFindings': '问题数',
    'self.statHealable': '可自动修复',
    'self.statLessons': '生效护栏',
    'self.statLastHeal': '上次自愈',
    'self.lastHealNever': '从未',
    'self.findingsTitle': '问题清单',
    'self.lessonsTitle': '经验护栏库',
    'self.runsTitle': '最近自愈审计轨迹',
    'self.findingsEmpty': '尚未载入问题清单。',
    'self.lessonsEmpty': '尚未记录任何经验护栏。',
    'self.runsEmpty': '尚未记录任何自愈执行。',
    'self.lProject': '项目',
    'self.lMember': '成员',
    'self.lRole': '角色',
    'self.lError': '错误码',
    'self.lPattern': '触发模式',
    'self.lGuardrail': '护栏内容',
    'self.lProjectPh': 'collab-hub',
    'self.lMemberPh': 'codex',
    'self.lRolePh': 'reviewer',
    'self.lErrorPh': 'harness_down',
    'self.lPatternPh': 'timeout|ECONNRESET',
    'self.lGuardrailPh': '升级前先退避 30 秒重试一次。',
    'self.btnAddGuardrail': '+ 新增护栏',
    'self.lessonHint': '会自动注入后续 Agent 的提示词。',
    'self.healAuto': '可自动修复',
    'self.healManual': '需人工确认',
    'self.actionLabel': '建议动作',
    'self.checkedAt': '检查于 {time}',
    'self.lessonActive': '启用',
    'self.lessonPaused': '已暂停',
    'self.hits': '命中 {n} 次',
    'self.autoLearned': '自动学习',
    'self.modeApply': '已应用',
    'self.modeDry': '预演',
    'self.runHealed': '修复 {n} 项',
    'self.runFindings': '{n} 个问题',
    'self.previewTitle': '预演结果',
    'self.previewApplied': '已应用',
    'self.previewDelta': '{before} → {after}',
    'self.previewCount': '×{n}',
    'self.previewEmpty': '当前没有可自愈的问题。',
    'self.sev.high': '高',
    'self.sev.medium': '中',
    'self.sev.low': '低',
    'self.sev.info': '提示',
    'self.toastCheckDemo': '已从演示样本刷新自诊断结果。',
    'self.toastCheckOk': '自诊断完成 · 健康度 {score}/100。',
    'self.toastCheckFail': '自诊断失败：{error}',
    'self.toastDryDemo': '预演结果：可自愈 {n} 个问题（演示模式，未实际执行）。',
    'self.toastDryOk': '预演结果：可自愈 {n} 个问题。',
    'self.toastDryFail': '预演失败：{error}',
    'self.toastNoHealable': '当前没有可自动修复的问题 —— 需要人工确认。',
    'self.toastApplyDemo': '演示自愈已应用：{before} → {after}（仅内存）。',
    'self.toastApplyOk': '自愈已应用：修复 {healed} 项，健康度 {before} → {after}。',
    'self.toastApplyFail': '自愈失败：{error}',
    'self.toastToggleDemo': '演示内存中已切换护栏：{state}。',
    'self.toastToggleOk': '护栏已{state}。',
    'self.toastToggleFail': '切换护栏失败：{error}',
    'self.toastLessonDemo': '护栏已加入演示内存。',
    'self.toastLessonSaved': '护栏已保存 · 后续提示词会自动注入。',
    'self.toastLessonFail': '保存护栏失败：{error}',
    'self.toastLessonRequired': '请填写护栏内容。',
    'self.active': '启用',
    'self.paused': '暂停',
    'self.pillLabel': '自我改进',
    'self.pillMeta': '{findings} 个问题 · {lessons} 条护栏',
    'self.pillAria': '自我改进健康度 {score} / 100，{overall}。打开系统自愈控制台。',
    'self.demo.summary': '{findings} 个问题中有 {healable} 个可自动修复，其余需要人工确认。',
    'self.demo.summaryHealed': '自愈已应用：{before} → {after}。仍有 {remaining} 个问题需要人工处理。',
    'self.demo.f1.title': '任务 demo-stall-01 卡在已退出的 harness 进程 pid 4512 上',
    'self.demo.f1.detail': '心跳缺失 26 分钟；子进程已不存在，但任务行仍停留在 dispatched。',
    'self.demo.f1.action': 'kill_orphan_process',
    'self.demo.f2.title': '验收失败遗留的孤立 worktree 分支 collab/demo/verify-gate',
    'self.demo.f2.detail': 'worktree 目录已不存在，分支却仍占着合并闸门。',
    'self.demo.f2.action': 'release_worktree',
    'self.demo.f3.title': 'FTS5 记忆索引从 128 行漂移到 116 行',
    'self.demo.f3.detail': '账本里有 12 条笔记不在索引中；重建之前搜索结果不可信。',
    'self.demo.f3.action': 'rebuild_fts_index',
    'self.demo.f4.title': 'PATH 上缺少 toolkit.repomix（回退到 git squash）',
    'self.demo.f4.detail': '在主机安装 repomix 之前，打包报告会丢失逐文件溯源信息。',
    'self.demo.f4.action': 'install_repomix',
    'self.demo.l1.guardrail': '先退避 30 秒重试一次，仍失败就改派健康成员，不要一直等 harness。',
    'self.demo.l2.guardrail': '完成消息必须带上回执 id；没有回执不要关闭审查。',
    'self.demo.l3.guardrail': '编辑前先声明要改的路径；diff 超出范围就停下来问。',
    'self.demo.run1.summary': '重启了 delta，并释放了一个孤立 worktree。',
    'self.demo.run2.summary': '仅预演 —— 未做任何改动。',
    'self.demo.runNew': '自愈：重启了卡住的成员，并释放了孤立 worktree。',
    'self.demo.action1': 'restart_member',
    'self.demo.action2': 'release_worktree',
    'self.demo.lessonNew.pattern': '任务卡住且子进程已消失',
    'self.demo.lessonNew.guardrail': '任务卡住且没有子进程时，清理孤立任务行并改派，不要盲目重试。',

    'health.version': '版本',
    'health.uptime': '运行时长',
    'health.pid': 'PID',
    'health.mail': 'Mail hub',
    'health.toolkit': '工具链',
    'health.mode': '模式',
    'health.offline': '离线',
    'health.installed': '已装 {n} 项',
    'health.modeDemo': '只读演示',
    'health.modeStatic': '静态演示',
    'health.modeLive': '实时',

    'agent.title': '动态扩展新 Agent',
    'agent.sub': '自动扫描本机模型 / CLI / Desktop，或使用预设模板。',
    'agent.scan': '扫描本机 Ollama / CLI / 环境变量',
    'agent.scanning': '正在只读扫描本机 Ollama / LM Studio / vLLM / CLI / 环境变量…',
    'agent.demoScan': '演示模式 · 本机扫描已禁用（避免泄露主机信息）。真实工作台会只读扫描 Ollama / LM Studio / CLI / 环境变量。',
    'agent.endpoints': '端点扫描：{summary}',
    'agent.endpointOff': '{label}：未启动',
    'agent.endpointOn': '{label}：{n} 个模型',
    'agent.noEndpoint': '无',
    'agent.nothing': '暂未检测到运行中的本地模型或外部 CLI；可直接使用上方快捷模板。',
    'agent.discoverFail': '扫描失败：{error}',
    'agent.fill': '填入表单',
    'agent.id': 'Agent ID（小写字母 / 数字 / 短横线）',
    'agent.name': '展示名称',
    'agent.driver': '驱动类型',
    'agent.driverHttp': 'openai-http（本地 Ollama / LM Studio / vLLM / 任意网关模型）',
    'agent.driverCli': 'generic-cli（gemini / aider / opencode / qwen / 本地脚本）',
    'agent.driverDesktop': 'desktop-native（Cursor / Windsurf 等桌面原生会话）',
    'agent.roles': '支持角色（逗号分隔）',
    'agent.config': '驱动配置 JSON（api_key 只填环境变量名，绝不存明文）',
    'agent.save': '注册并接入',
    'agent.saved': 'Agent 已注册。',
    'agent.badJson': '驱动配置不是合法 JSON。',
    'agent.saveFail': '注册失败：{error}',
    'agent.testResult': 'Agent {id} 连通性：{state}',
    'agent.testFail': '测试失败：{error}',
    'agent.remove': 'Agent 已移除。',
    'agent.removeFail': '移除失败：{error}',
    'agent.cleared': '冷却已解除。',
    'agent.cooldownFail': '解除冷却失败：{error}',
    'agent.probed': 'Agent 探活完成。',
    'agent.probeThrottled': '探活已节流，{s}s 后可重试。',
    'agent.probeFail': '探活失败：{error}',
    'agent.probeDemo': '演示模式 · 探活已禁用（不会访问本机端点）。',

    'dispatch.title': '一键派发后台任务',
    'dispatch.sub': '智能路由 + Prompt 配方 + 工作区项目自动补全。',
    'dispatch.recipe': '套用内置 Prompt 配方（可选）',
    'dispatch.recipeManual': '-- 手动编写 Prompt --',
    'dispatch.member': '执行 Agent（auto 结合实时探活与历史成功率自动挑选）',
    'dispatch.role': '角色',
    'dispatch.dir': '项目目录（支持工作区项目补全）',
    'dispatch.dirPh': '选择或输入项目绝对路径…',
    'dispatch.taskTitle': '任务标题',
    'dispatch.taskTitlePh': '例如：独立审查认证模块边界条件',
    'dispatch.prompt': '提示词（Prompt）',
    'dispatch.promptPh': '明确目标、范围、产出与验收条件…',
    'dispatch.fallback': '目标离线或 429 冷却时，派发前自动降级路由至其他在线后台 Agent（绝不重复发已发送任务）',
    'dispatch.submit': '立即派发',
    'dispatch.auto': '✨ auto（按在线状态 + 历史成功率自动路由）',
    'dispatch.done': '任务已派发。',
    'dispatch.asyncQueued': '已异步派发（HTTP 202）· 正在流式接收日志…',
    'dispatch.demo': '演示预览为只读模式，派发已禁用。',

    'role.researcher': 'researcher（调研）',
    'role.reviewer': 'reviewer（审查）',
    'role.implementer': 'implementer（实现）',
    'role.tester': 'tester（测试）',
    'role.planner': 'planner（规划）',
    'role.synthesizer': 'synthesizer（汇总）',

    'memory.title': '写入共享项目记忆',
    'memory.sub': 'Markdown + SQLite FTS5，跨 Agent 可检索。',
    'memory.project': '项目标识',
    'memory.noteTitle': '标题',
    'memory.noteTitlePh': '例如：部署与排障备忘',
    'memory.tags': '标签（逗号分隔）',
    'memory.content': '内容（支持 Markdown）',
    'memory.contentPh': '记录跨 Agent 需要共享的约定、边界、踩坑与决策…',
    'memory.save': '保存记忆',
    'memory.saved': '共享记忆已写入。',

    'palette.placeholder': '搜索任务、视图与命令…',
    'palette.groupActions': '操作',
    'palette.groupViews': '视图',
    'palette.groupTasks': '任务',
    'palette.empty': '没有匹配的命令或任务。试试 “dispatch” 或任务关键字。',
    'palette.select': '选择',
    'palette.open': '打开',
    'palette.close': '关闭',
    'palette.kindAction': '操作',
    'palette.kindView': '视图',
    'palette.kindTask': '任务',
    'palette.dispatch': '派发新任务',
    'palette.dispatchSub': '派发一个后台任务',
    'palette.probe': '探活所有 Agent',
    'palette.probeSub': '探活成员与 Mail hub',
    'palette.memory': '写共享记忆',
    'palette.memorySub': '写入一条 FTS5 记忆',
    'palette.agent': '扩展新 Agent',
    'palette.agentSub': '注册一个 Agent',
    'palette.theme': '切换深色 / 浅色主题',
    'palette.themeSub': 'Obsidian / Alabaster 互切',
    'palette.lang': '切换语言（EN / 中文）',
    'palette.langSub': '英文 / 中文互切',
    'palette.reindex': '更新 cass 索引',
    'palette.reindexSub': '重建跨 Agent 会话索引',
    'palette.doctor': '系统体检',
    'palette.doctorSub': '运行 8 项体检',
    'palette.viewCmd': '{zh} · {en}',

    'drawer.task': '任务',
    'drawer.agent': 'Agent',
    'drawer.project': '项目目录',
    'drawer.role': '角色',
    'drawer.routedFrom': ' · 自动路由自 {from}',
    'drawer.receipt': '回执 ID',
    'drawer.session': '会话',
    'drawer.generation': ' · 第 {n} 版',
    'drawer.batch': '批次',
    'drawer.depends': '依赖',
    'drawer.updated': '更新时间',
    'drawer.prompt': '提示词',
    'drawer.result': '完整结果',
    'drawer.error': '诊断 / 阻塞',
    'drawer.events': '审计事件流（{n}）',
    'drawer.noEvents': '无事件',
    'drawer.poll': '立即轮询回执',
    'drawer.polling': '轮询中…',
    'drawer.reroute': '标记已重路由',
    'drawer.failed': '标记失败关闭',
    'drawer.reconciled': '任务状态已对账更新。',
    'drawer.reconcileFail': '对账失败：{error}',
    'drawer.pollFail': '轮询失败：{error}',
    'drawer.openFail': '打开任务失败：{error}',
    'drawer.missing': '任务不存在。',
    'drawer.reconcileNote': '由 CollabHub v1.3 工作台更新',

    'log.title': '实时日志',
    'log.live': '流式输出',
    'log.done': '已结束',
    'log.empty': '暂无输出。',
    'log.copy': '复制',
    'log.copied': '日志已复制。',
    'log.followOn': '自动滚动：开',
    'log.followOff': '自动滚动：暂停',
    'log.demo': '演示数据',
    'log.fetchFail': '实时日志不可用：{error}',
    'log.truncated': '… 较早的行已裁剪 …',
    'log.follow': '⤓ 跟随',
    'log.followTitle': '自动滚动跟随最新输出',

    'cancel.label': '中止',
    'cancel.confirm': '确认中止任务 {id}？',
    'cancel.pending': '中止中…',
    'cancel.done': '任务已中止。',
    'cancel.doneAbort': '任务已中止，并已杀掉仍在运行的进程。',
    'cancel.demo': '演示预览为只读模式，未真正中止任何任务。',
    'cancel.fail': '中止失败：{error}',
    'cancel.alreadyTerminal': '该任务已进入终态，无需中止。',
    'cancel.requested': '已请求中止 · 等待 owner pid {pid} 确认。',
    'cancel.requestedPill': '已请求中止 · pid {pid}',
    'cancel.notConfirmed': '中止未被确认。',
    'cancel.force': '强制标记中止',
    'cancel.forceConfirm': '确认强制中止',
    'cancel.forceHint': '5 秒内再次点击「强制标记中止」即强制将该任务标记为已中止。',
    'cancel.forceDone': '任务已强制标记为已中止。',
    'drawer.demoNote': '演示预览 · 只读样本数据，未连接真实后台。',
    'cancel.event': '任务 {id} 已被 {member} 中止。',

    'resume.label': '断点续跑',
    'resume.pending': '续跑中…',
    'resume.done': '批次 {batch} 已续跑 · 跳过 {skipped} 个已完成，重试 {retried} 个。',
    'resume.none': '批次 {batch} 没有可续跑的步骤。',
    'resume.blocked': '续跑被阻塞 · {n} 个不确定步骤需先复核。',
    'resume.demo': '演示预览为只读模式，未真正续跑批次。',
    'resume.fail': '续跑失败：{error}',
    'resume.noBatch': '请先选择一个实时批次。',

    'batch.title': '批次报告 · {id}',
    'batch.md': 'Markdown 导出',
    'batch.raw': '原始 MD',
    'batch.copy': '复制 MD',
    'batch.copied': '报告已复制。',
    'batch.fail': '导出批次报告失败：{error}',
    'batch.open': '协作批次（点击导出报告）：',
    'batch.allOk': '全部成功',
    'batch.stalled': '含卡住',
    'batch.ended': '已结束',
    'batch.active': '进行中',
    'batch.demoNote': '只读演示样本，未查询任何真实任务状态。',
    'batch.summary': '概要',
    'batch.total': '任务总数',
    'batch.terminal': '全部终态',
    'batch.failures': '存在失败',
    'batch.tasks': '任务',
    'batch.notes': '说明',
    'batch.yes': '是',
    'batch.no': '否',
    'batch.note1': '本报告中的所有标识与路径均为合成数据。',
    'batch.note2': '生产报告会包含完整回执、时延与令牌用量。',

    'diff.added': '新增',
    'diff.removed': '删除',
    'diff.hunk': '区块',

    'toast.loadFail': '加载总览失败：{error}',
    'toast.demoReadonly': '演示预览为只读模式，写操作已禁用。',
    'toast.dagSubmitted': 'DAG 工作流已提交。',
    'toast.dagDemo': '演示预览为只读模式，DAG 不会真正派发。',
    'toast.mailOffline': 'Mail hub 未连接。',
    'toast.mailDemo': '演示预览 · Mail hub 未接入。',
    'toast.copied': '已复制。',
    'toast.copyFail': '复制失败：浏览器未授予剪贴板权限。',
    'toast.somethingWentWrong': '{error}',

    'doctor.runtime': 'Node.js 运行时满足最低版本',
    'doctor.db': 'SQLite FTS5 可用；记忆索引健康',
    'doctor.dirs': '运行时目录可写',
    'doctor.mail': 'Mail hub 在本地 MCP 端点可达',
    'doctor.ast': 'ast-grep 已在 PATH 中',
    'doctor.repomix': '未找到 repomix；打包工具将降级',
    'doctor.sandbox': '工作区沙箱根目录已配置',
    'doctor.backup': '最近 24 小时内已生成热备份',

    'sim.title': '模拟 · {id}',
    'sim.started': '模拟 DAG 已启动（两个根步骤并行）。',
    'sim.done': '模拟 DAG 运行结束：全部步骤已完成。',
    'sim.batch': 'sim-{n}',
    'sim.prompt': '静态演示中的模拟 {role} 步骤。',
    'sim.toastNode': '步骤 {id} → {state}',
    'sim.logBoot': '正在把步骤「{id}」派发给路由器…',
    'sim.logAgent': '已选 Agent · role={role} · channel=sim',
    'sim.logPlan': '规划中：读取上游上下文与约束…',
    'sim.logWork': '执行中：已产出 {n} 个中间工件',
    'sim.logTool': '工具调用成功 · 128ms · exit 0',
    'sim.logStream': '流式分片 {n}/6 · 512 字节',
    'sim.logWarn': '警告：某个瞬态步骤边界正在重试',
    'sim.logDone': '步骤完成，耗时 {d} · exit 0',
    'sim.logVerdict': '正在综合 {n} 个上游步骤的最终结论…',

    'demo.task.queue01': '搭建发版说明生成器',
    'demo.task.run01': '审计 Worktree 合并闸门',
    'demo.task.stall01': '复现并核对 SSE 重连偶发失败',
    'demo.task.review01': '核对 Kanban 拖拽可用性',
    'demo.task.done01': '交付 FTS5 记忆检索',
    'demo.task.done02': '零依赖图表渲染原型',
    'demo.prompt.queue01': '从 CHANGELOG 各章节生成发版说明并写入 docs/release-notes.md。',
    'demo.prompt.run01': '审查合并闸门路径，检查缺失的分支校验并汇报结论。',
    'demo.prompt.stall01': '复现偶发的重连测试并核对失败断言。',
    'demo.prompt.review01': '核对在 Kanban 列之间移动卡片的键盘与指针交互。',
    'demo.prompt.done01': '为记忆笔记实现带高亮片段的排序全文检索。',
    'demo.prompt.done02': '原型一个不依赖任何第三方库的 canvas 图表渲染器。',
    'demo.result.done01': '已实现带高亮片段的 FTS5 排序检索。',
    'demo.err.harness': '180 秒内未收到心跳',
    'demo.err.receipt': '',
    'demo.err.scope': '范围超限：图表引擎超出 v1.2 边界',
    'demo.member.atlas': '响应正常（演示样本）',
    'demo.member.beacon': '空闲（演示样本）',
    'demo.member.cipher': 'Baton 已挂载（演示样本）',
    'demo.member.delta': '因 harness 超时冷却中（演示样本）',
    'demo.member.deltaReason': 'harness 反复超时（演示样本）',
    'demo.note1.title': 'v1.2 发版检查清单',
    'demo.note1.preview': '- 核对静态资源白名单 · 确认 CSP 无 unsafe-inline 脚本',
    'demo.note2.title': 'DAG 编写约定',
    'demo.note2.preview': '步骤保持幂等；显式声明 depends_on。',
    'demo.evt.verify': 'worktree.verify_passed',
    'demo.evt.dispatched': 'task.dispatched',
    'demo.evt.reconciled': 'task.reconciled',
    'demo.evt.memory': 'memory.note_written',
    'demo.evt.cooldown': 'agent.cooldown',
    'demo.evt.batch': 'batch.report_exported',
    'demo.log.attach': '已挂载任务 {id} · 沙箱 /workspace/collab-demo',
    'demo.log.spawn': '已启动 worker pid=demo · 通道已连接',
    'demo.log.read1': '正在读取项目清单与上游上下文…',
    'demo.log.read2': '载入 3 条记忆笔记作为依据',
    'demo.log.tool': '工具调用成功 · ast-grep · 命中 2 处',
    'demo.log.write': '正在把工件写入隔离 worktree',
    'demo.log.exit': '进程退出 0 · 墙钟 4.2s',
    'demo.log.stream': '流式分片 {n}/6 · 512 字节',
    'demo.log.stderr': '警告：回执轮询出现瞬态错误（重试一次）',
    'demo.log.killed': '收到 SIGTERM · 运行中的进程已中止',
    'demo.recipe.review': '独立代码审查',
    'demo.recipe.research': '调研并总结',
    'demo.recipe.reviewPrompt': '独立审查暂存区 diff，列出具体缺陷（文件/行号/严重度），不要复述 diff。',
    'demo.recipe.researchPrompt': '调研指定主题，输出带来源、权衡与下一步建议的简明结论。',
    'demo.commit1': 'feat: 增加 worktree 验收闸门',
    'demo.commit2': 'test: 覆盖静态资源白名单穿越',
    'demo.commit3': 'docs: 为演示样本补充注释',
    'demo.worktreeMissing': 'Worktree 不存在。',
  },
};
/* I18N-TABLE-END */

let LANG = 'en';

function initialLang() {
  let query = '';
  try { query = String(new URLSearchParams(location.search).get('lang') || '').toLowerCase(); } catch { query = ''; }
  if (query === 'zh' || query === 'zh-cn' || query === 'cn' || query === 'zh-hans') return 'zh';
  if (query === 'en' || query === 'en-us') return 'en';
  let saved = null;
  try { saved = localStorage.getItem(LANG_KEY); } catch { /* private mode */ }
  if (saved === 'zh' || saved === 'en') return saved;
  const nav = String(navigator.language || navigator.userLanguage || '').toLowerCase();
  return nav.startsWith('zh') ? 'zh' : 'en';
}

function t(key, vars) {
  const dict = I18N[LANG] || I18N.en;
  let out = dict[key];
  if (out == null) out = I18N.en[key];
  if (out == null) return key;
  if (vars) out = String(out).replace(/\{(\w+)\}/g, (m, k) => (vars[k] != null ? String(vars[k]) : m));
  return out;
}

function stateLabelOf(value) {
  const key = String(value || 'unknown');
  const hit = t(`state.${key}`);
  return hit === `state.${key}` ? key : hit;
}

function badge(stateValue) {
  const key = String(stateValue || 'unknown');
  return `<span class="badge st-${esc(key)}">${esc(stateLabelOf(key))}</span>`;
}

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  demo: false,
  static: false,
  lang: 'en',
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
  toolkit: {},
  dagSteps: [],
  dagBatch: null,
  dagBatchTouched: false,
  dagTemplates: [],
  overviewProbe: null,
  overviewSig: null,
  overviewLoading: false,
  overviewQueued: false,
  overviewSeq: 0,
  agentFilterSig: null,
  forceArmed: null,
  pollEvery: 0,
  drawer: { kind: null, key: null },
  taskLog: emptyTaskLog(),
  sim: { running: false, batchId: null, steps: new Map(), plan: new Map(), logs: new Map(), timer: null, startedAt: 0, tasks: [], seq: 0 },
  discovered: [],
  lastToolkitCopy: '',
  lastBatchMd: '',
  events: [],
  health: null,
  doctor: null,
  /* v1.4 self-improvement console: overview KPI mirror + full self-check payload. */
  selfImprove: null,
  selfCheck: null,
  selfFindings: [],
  selfLessons: [],
  selfRuns: [],
  selfScore: null,
  selfOverall: null,
  selfCheckedAt: null,
  selfPreview: null,
  selfBusy: '',
  selfAnim: null,
  selfDemo: null,
  palette: { items: [], index: 0 },
  flags: { eventsLoaded: false, doctorLoaded: false, healthLoaded: false, selfLoaded: false, sseConnected: false },
  timers: { reload: null, dag: null, poll: null, sse: null, filter: null },
};

/* Single factory so every drawer mount starts from a clean, dedupe-ready log state. */
function emptyTaskLog(overrides = {}) {
  return {
    taskId: null, entries: [], seen: new Set(), active: false, follow: true,
    live: false, terminal: false, ownerPid: null, cancelRequested: false,
    truncated: false, ...overrides,
  };
}

const VIEWS = {
  overview: { titleKey: 'nav.overview', subKey: 'view.overview.sub' },
  tasks: { titleKey: 'nav.tasks', subKey: 'view.tasks.sub' },
  dag: { titleKey: 'nav.dag', subKey: 'view.dag.sub' },
  worktrees: { titleKey: 'nav.worktrees', subKey: 'view.worktrees.sub' },
  toolkit: { titleKey: 'nav.toolkit', subKey: 'view.toolkit.sub' },
  system: { titleKey: 'nav.ops', subKey: 'view.ops.sub' },
};

const KANBAN_COLUMNS = [
  { key: 'queued', titleKey: 'kb.queued', dot: 'queued', match: (s) => ['created', 'dispatching', 'dispatched'].includes(s) },
  { key: 'running', titleKey: 'kb.running', dot: 'running', match: (s) => s === 'running' },
  { key: 'attention', titleKey: 'kb.attention', dot: 'attention', match: (s) => ['stalled', 'uncertain', 'needs_input'].includes(s) },
  { key: 'done', titleKey: 'kb.done', dot: 'done', match: (s) => ['completed', 'failed', 'rerouted', 'cancelled'].includes(s) },
];

const ACTIVE_STATES = ['running', 'dispatched', 'dispatching'];
const TERMINAL_STATES = ['completed', 'failed', 'rerouted', 'cancelled'];
const MAX_DAG_STEPS = 16; /* mirrors the backend workflow step limit */

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

function demoRecipes() {
  return [
    { recipe_id: 'demo-code-review', title: t('demo.recipe.review'), role: 'reviewer', prompt: t('demo.recipe.reviewPrompt') },
    { recipe_id: 'demo-research', title: t('demo.recipe.research'), role: 'researcher', prompt: t('demo.recipe.researchPrompt') },
  ];
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
    const key = next === 'dark' ? 'theme.toDark' : 'theme.toLight';
    btn.title = t(key);
    btn.setAttribute('aria-label', t(key));
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
  toast(t(now === 'dark' ? 'theme.switchedDark' : 'theme.switchedLight'), 'info', 2400);
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
  close.setAttribute('aria-label', t('common.dismiss'));
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

async function apiPostRaw(url, payload) {
  if (state.demo) {
    toast(t('toast.demoReadonly'), 'warn');
    throw new Error('Demo mode is read-only');
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
    body: JSON.stringify(payload || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return { status: res.status, data };
}

async function apiPost(url, payload) {
  return (await apiPostRaw(url, payload)).data;
}

/* ------------------------------------------------------------------ */
/* Language plumbing                                                   */
/* ------------------------------------------------------------------ */

function applyStaticI18n() {
  document.documentElement.lang = LANG === 'zh' ? 'zh-CN' : 'en';
  document.documentElement.dataset.lang = LANG;
  for (const el of $$('[data-i18n]')) el.textContent = t(el.getAttribute('data-i18n'));
  for (const el of $$('[data-i18n-ph]')) el.placeholder = t(el.getAttribute('data-i18n-ph'));
  for (const el of $$('[data-i18n-title]')) el.title = t(el.getAttribute('data-i18n-title'));
  for (const el of $$('[data-i18n-aria]')) el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
  const langBtn = $('#btnLang');
  if (langBtn) {
    langBtn.title = t('lang.switch');
    langBtn.setAttribute('aria-label', t('lang.current'));
    for (const opt of $$('.lang-opt', langBtn)) {
      opt.classList.toggle('active', opt.getAttribute('data-lang-opt') === LANG);
    }
  }
  const kbd = $('#paletteKbd');
  if (kbd) kbd.textContent = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl K';
  document.title = state.static ? t('app.titleStatic') : (state.demo ? t('app.titleDemo') : t('app.title'));
}

function setLang(next, { announce = false } = {}) {
  LANG = next === 'zh' ? 'zh' : 'en';
  state.lang = LANG;
  try { localStorage.setItem(LANG_KEY, LANG); } catch { /* ignore */ }
  try {
    const url = new URL(location.href);
    url.searchParams.set('lang', LANG);
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch { /* ignore */ }
  applyTheme(document.documentElement.dataset.theme || 'dark');
  applyStaticI18n();
  refreshDynamicI18n();
  if (announce) toast(LANG === 'zh' ? t('lang.switchedZh') : t('lang.switched'), 'info', 2000);
}

function refreshDynamicI18n() {
  if (state.static) {
    state.dagTemplates = [];
    applyDemoFixture(buildDemoFixture());
    renderDagTemplates();
    renderDagBatchSelect();
    renderDagCanvas();
  } else {
    state.dagTemplates = state.demo ? [] : loadDagTemplates();
    renderAllQuiet();
  }
  setView(state.view, { silent: true });
  markDemoPill();
  if (state.demo) {
    const sse = $('#ssePill');
    if (sse) sse.textContent = state.static ? t('topbar.sseStatic') : t('topbar.sseDemo');
  }
  if (state.flags.eventsLoaded) renderEvents();
  if (state.flags.doctorLoaded) renderDoctor(state.doctor, Boolean(state.demo));
  if (state.flags.healthLoaded) renderHealth();
  if (state.flags.selfLoaded && state.demo && state.selfDemo) applySelfCheck(state.selfDemo);
  else renderSelfPanel();
  if (state.sim.running || state.sim.batchId) renderDagBatchSelect();
  refreshDrawer();
}

function refreshDrawer() {
  if (!state.drawer.kind) return;
  if (state.drawer.kind === 'task' && state.drawer.key) openTask(state.drawer.key);
  else closeDrawer();
}

/* ------------------------------------------------------------------ */
/* Views                                                               */
/* ------------------------------------------------------------------ */

/* v1.3 shipped this panel as `#ops`; v1.4 renames it to `#system` (System &
 * Doctor) and keeps the old hash resolving, so bookmarks and the v1.3 quick-links
 * do not silently fall back to the overview. */
const VIEW_ALIASES = { ops: 'system' };

function normalizeViewId(id) {
  const raw = String(id || '').replace(/^#\/?/, '');
  const hit = VIEW_ALIASES[raw] || raw;
  return Object.prototype.hasOwnProperty.call(VIEWS, hit) ? hit : 'overview';
}

function viewFromHash() {
  return normalizeViewId(location.hash);
}

function setView(id, { silent = false, focus = false } = {}) {
  const key = normalizeViewId(id);
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
  if (title) title.textContent = t(meta.titleKey);
  if (sub) sub.textContent = t(meta.subKey);
  if (!silent) history.replaceState(null, '', `#${key}`);
  if (key === 'dag') { refreshDagAgentOptions(); renderDagBatchSelect(); renderDagCanvas(); }
  if (key === 'system') {
    if (!state.flags.eventsLoaded) loadEvents();
    if (!state.flags.doctorLoaded) loadDoctor();
    if (!state.flags.healthLoaded) loadHealth();
    if (!state.flags.selfLoaded) loadSelfCheck({ quiet: true });
    else renderSelfPanel();
  }
  if (key === 'toolkit') {
    renderNotes(state.notes);
    renderToolkitMeta();
  }
  closeMobileNav();
  if (!silent && typeof window.scrollTo === 'function') window.scrollTo({ top: 0, behavior: 'smooth' });
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
    { group: t('palette.groupActions'), icon: '＋', label: t('palette.dispatch'), sub: t('palette.dispatchSub'), kind: t('palette.kindAction'), run: openDispatchModal },
    { group: t('palette.groupActions'), icon: '◎', label: t('palette.probe'), sub: t('palette.probeSub'), kind: t('palette.kindAction'), run: probeAll },
    { group: t('palette.groupActions'), icon: '✎', label: t('palette.memory'), sub: t('palette.memorySub'), kind: t('palette.kindAction'), run: openMemoryModal },
    { group: t('palette.groupActions'), icon: '＋', label: t('palette.agent'), sub: t('palette.agentSub'), kind: t('palette.kindAction'), run: openAgentModal },
    { group: t('palette.groupActions'), icon: '◐', label: t('palette.theme'), sub: t('palette.themeSub'), kind: t('palette.kindAction'), run: toggleTheme },
    { group: t('palette.groupActions'), icon: '⌘', label: t('palette.lang'), sub: t('palette.langSub'), kind: t('palette.kindAction'), run: () => setLang(LANG === 'zh' ? 'en' : 'zh', { announce: true }) },
    { group: t('palette.groupActions'), icon: '↻', label: t('palette.reindex'), sub: t('palette.reindexSub'), kind: t('palette.kindAction'), run: () => reindexCass() },
    { group: t('palette.groupActions'), icon: '✚', label: t('palette.doctor'), sub: t('palette.doctorSub'), kind: t('palette.kindAction'), run: () => { setView('system'); loadDoctor(true); } },
  ];
  const views = Object.entries(VIEWS).map(([id, meta]) => ({
    group: t('palette.groupViews'),
    icon: '→',
    label: t('palette.viewCmd', { zh: t(meta.titleKey), en: t(meta.titleKey === 'nav.overview' ? 'nav.overviewAlt' : `${meta.titleKey}Alt`) }),
    sub: t(meta.subKey),
    kind: t('palette.kindView'),
    run: () => setView(id),
  }));
  const tasks = state.tasks.map((task) => ({
    group: t('palette.groupTasks'),
    icon: '▣',
    label: task.title,
    sub: `${task.task_id} · ${task.member} · ${stateLabelOf(task.state)}`,
    kind: t('palette.kindTask'),
    run: () => openTask(task.task_id),
  }));
  return { actions, views, tasks };
}

function buildPalette(query) {
  const q = String(query || '').trim().toLowerCase();
  const { actions, views, tasks } = paletteSources();
  const match = (item) => !q || `${item.label} ${item.sub} ${item.kind}`.toLowerCase().includes(q);
  const groups = [
    [t('palette.groupActions'), actions.filter(match).slice(0, 8)],
    [t('palette.groupViews'), views.filter(match).slice(0, 8)],
    [t('palette.groupTasks'), tasks.filter(match).slice(0, 12)],
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
  if (!flat.length) html = `<div class="palette-empty">${esc(t('palette.empty'))}</div>`;
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
/* Embedded demo fixture (privacy-safe, no real paths / hosts / keys)  */
/* ------------------------------------------------------------------ */

function buildDemoFixture() {
  const nowMs = Date.now();
  const at = (minutesAgo) => new Date(nowMs - minutesAgo * 60000).toISOString();
  const PROJECT = DEMO_DIR;

  const demoTasks = [
    {
      task_id: 'demo-queue-01', batch_id: 'demo-batch-01', parent_task_id: null, depends_on: [],
      project_dir: PROJECT, member: 'beacon', role: 'implementer', channel: 'generic-cli',
      title: t('demo.task.queue01'), prompt: t('demo.prompt.queue01'),
      state: 'dispatched', external_id: null, session_id: 'demo-session-01', reply_generation: 0,
      payload_sha256: null, worktree_path: null, branch_name: null, mail_message_id: null, dispatch_token: null,
      attempted_at: at(9), result_text: null, evidence: null, error_code: null, error_message: null, meta: {},
      created_at: at(11), updated_at: at(9), completed_at: null,
    },
    {
      task_id: 'demo-run-01', batch_id: 'demo-batch-01', parent_task_id: null, depends_on: [],
      project_dir: PROJECT, member: 'cipher', role: 'reviewer', channel: 'dsh-baton',
      title: t('demo.task.run01'), prompt: t('demo.prompt.run01'),
      state: 'running', external_id: null, session_id: 'demo-session-02', reply_generation: 0,
      payload_sha256: null, worktree_path: '/workspace/worktrees/demo-verify-gate', branch_name: 'collab/demo/verify-gate',
      mail_message_id: null, dispatch_token: null, attempted_at: at(7), result_text: null, evidence: null,
      error_code: null, error_message: null, meta: {}, created_at: at(8), updated_at: at(3), completed_at: null,
    },
    {
      task_id: 'demo-stall-01', batch_id: 'demo-batch-02', parent_task_id: null, depends_on: [],
      project_dir: PROJECT, member: 'delta', role: 'tester', channel: 'muse-tailnet',
      title: t('demo.task.stall01'), prompt: t('demo.prompt.stall01'),
      state: 'stalled', external_id: null, session_id: 'demo-session-03', reply_generation: 0,
      payload_sha256: null, worktree_path: null, branch_name: null, mail_message_id: null, dispatch_token: null,
      attempted_at: at(26), result_text: null, evidence: null, error_code: 'harness_down',
      error_message: t('demo.err.harness'), meta: {}, created_at: at(30), updated_at: at(24), completed_at: null,
    },
    {
      task_id: 'demo-review-01', batch_id: 'demo-batch-02', parent_task_id: null, depends_on: [],
      project_dir: PROJECT, member: 'atlas', role: 'reviewer', channel: 'openai-http',
      title: t('demo.task.review01'), prompt: t('demo.prompt.review01'),
      state: 'uncertain', external_id: null, session_id: 'demo-session-04', reply_generation: 0,
      payload_sha256: null, worktree_path: null, branch_name: null, mail_message_id: null, dispatch_token: null,
      attempted_at: at(21), result_text: null, evidence: null, error_code: 'receipt_missing',
      error_message: null, meta: {}, created_at: at(23), updated_at: at(19), completed_at: null,
    },
    {
      task_id: 'demo-done-01', batch_id: null, parent_task_id: null, depends_on: [],
      project_dir: PROJECT, member: 'atlas', role: 'reviewer', channel: 'openai-http',
      title: t('demo.task.done01'), prompt: t('demo.prompt.done01'),
      state: 'completed', external_id: 'msg_demo_01', session_id: 'demo-session-05', reply_generation: 1,
      payload_sha256: null, worktree_path: null, branch_name: null, mail_message_id: null, dispatch_token: null,
      attempted_at: at(95), result_text: t('demo.result.done01'), evidence: null, error_code: null,
      error_message: null, meta: {}, created_at: at(120), updated_at: at(88), completed_at: at(88),
    },
    {
      task_id: 'demo-done-02', batch_id: null, parent_task_id: null, depends_on: [],
      project_dir: PROJECT, member: 'beacon', role: 'implementer', channel: 'generic-cli',
      title: t('demo.task.done02'), prompt: t('demo.prompt.done02'),
      state: 'failed', external_id: null, session_id: 'demo-session-06', reply_generation: 0,
      payload_sha256: null, worktree_path: null, branch_name: null, mail_message_id: null, dispatch_token: null,
      attempted_at: at(150), result_text: null, evidence: null, error_code: 'scope_rejected',
      error_message: t('demo.err.scope'), meta: {}, created_at: at(160), updated_at: at(144), completed_at: at(144),
    },
  ];

  const member = (spec) => ({
    member: spec.member, name: spec.name, driver: spec.driver, builtin: spec.builtin,
    channel: spec.channel, state: spec.state, raw_state: spec.raw, is_stale: false, age_s: spec.age,
    in_cooldown: Boolean(spec.cooldown), cli_in_cooldown: false,
    cooldown_channel: spec.cooldown ? spec.channel : null, cooldown_until: spec.cooldown ? at(-0.7) : null,
    cooldown_remaining_s: spec.cooldown || 0, cooldown_reason: spec.cooldown ? t('demo.member.deltaReason') : null,
    sessions: [], detail: t(spec.detailKey), checked_at: at(spec.checked), roles: spec.roles,
    capabilities: spec.capabilities, config: {},
  });

  const demoMembers = [
    member({ member: 'atlas', name: 'Atlas', driver: 'openai-http', builtin: false, channel: 'openai-http', state: 'online', raw: 'online', age: 12, checked: 1, detailKey: 'demo.member.atlas', roles: ['reviewer', 'coordinator'], capabilities: ['review', 'summarize'] }),
    member({ member: 'beacon', name: 'Beacon', driver: 'generic-cli', builtin: false, channel: 'generic-cli', state: 'idle', raw: 'idle', age: 45, checked: 2, detailKey: 'demo.member.beacon', roles: ['implementer'], capabilities: ['implement'] }),
    member({ member: 'cipher', name: 'Cipher', driver: 'dsh-baton', builtin: true, channel: 'dsh-baton', state: 'online', raw: 'online', age: 8, checked: 1, detailKey: 'demo.member.cipher', roles: ['reviewer', 'implementer'], capabilities: ['review', 'verify'] }),
    member({ member: 'delta', name: 'Delta', driver: 'muse-tailnet', builtin: true, channel: 'muse-tailnet', state: 'cooldown', raw: 'idle', age: 300, checked: 5, detailKey: 'demo.member.delta', cooldown: 42, roles: ['tester'], capabilities: ['test'] }),
  ];

  const note1 = [
    `# ${t('demo.note1.title')}`, '',
    '## Static assets', '',
    '- Verify asset allowlist',
    '- Confirm CSP has no `unsafe-inline` scripts',
    '- Check that every file under `public/` ships with an explicit content type', '',
    '## Smoke test', '', '```bash', 'node --test test/collab-hub.test.mjs', '```', '',
    'Finish the checklist before tagging the release.',
  ].join('\n');
  const note2 = [
    `# ${t('demo.note2.title')}`, '',
    t('demo.note2.preview'), '',
    '## Rules', '',
    '- One step, one observable outcome.',
    '- Declare `depends_on` explicitly — never rely on declaration order.',
    '- A failed step stops its descendants, not its siblings.', '',
    '## Example', '', '```json', '{ "id": "verify", "depends_on": ["build"] }', '```',
  ].join('\n');

  return {
    demo: true,
    generated_at: new Date(nowMs).toISOString(),
    mail_hub: { ok: true, status: 200, server: 'mcp-agent-mail', version: '1.4.2', url: '/mail' },
    toolkit: {
      cass: { installed: true, purpose: 'Cross-agent session search' },
      ast_grep: { installed: true, purpose: 'Structural code search' },
      repomix: { installed: true, purpose: 'Repository context packing' },
      markitdown: { installed: true, purpose: 'Document to Markdown conversion' },
      beads: { installed: false, purpose: 'Task dependency graph (optional)' },
    },
    metrics: {
      agents_ready: 3, agents_total: 4, tasks_total: 6, tasks_completed: 1, tasks_active: 1,
      tasks_stalled: 2, tasks_failed: 1, active_worktrees: 1, memory_notes: 2,
      cass_conversations: 128, cass_messages: 4310,
    },
    /* v1.4 demo KPI mirror: 84/100 with two healable findings — Apply jumps it to 98. */
    self_improve: {
      health_score: 84, overall: 'degraded', findings_count: 4, healable_count: 2,
      active_lessons: 2, last_heal_at: at(26 * 60),
    },
    telemetry: {
      agents: {
        atlas: { total: 24, completed: 22, success_rate: 0.917, avg_latency_ms: 5200, total_tokens: 214000 },
        beacon: { total: 18, completed: 14, success_rate: 0.778, avg_latency_ms: 7400, total_tokens: 156000 },
        cipher: { total: 31, completed: 29, success_rate: 0.935, avg_latency_ms: 3900, total_tokens: 268000 },
        delta: { total: 9, completed: 6, success_rate: 0.667, avg_latency_ms: 8100, total_tokens: 88000 },
      },
    },
    members: demoMembers,
    batches: [
      { batch_id: 'demo-batch-01', total: 3, counts: { dispatched: 1, running: 1, completed: 1 }, all_terminal: false, all_succeeded: false, has_stalled: false, has_failures: false, latest_at: at(3) },
      { batch_id: 'demo-batch-02', total: 2, counts: { stalled: 1, uncertain: 1 }, all_terminal: false, all_succeeded: false, has_stalled: true, has_failures: true, latest_at: at(19) },
    ],
    tasks: demoTasks,
    worktrees: [{
      task_id: 'demo-run-01', branch_name: 'collab/demo/verify-gate', member: 'cipher',
      worktree_path: '/workspace/worktrees/demo-verify-gate', wsl_path: '/workspace/worktrees/demo-verify-gate',
      repo_dir: PROJECT, base_ref: 'main', state: 'active', verify_status: 'passed',
      verified_head_sha: 'a1b2c3d4e5f6', verify_summary: 'node-test: passed (4200ms)',
      created_at: at(8), updated_at: at(3),
    }],
    notes: [
      { project: 'collab-demo', slug: 'release-checklist', title: t('demo.note1.title'), preview: t('demo.note1.preview'), tags: 'release,checklist', author: 'atlas', file_path: '/workspace/.collabhub/memory/demo/release-checklist.md', updated_at: at(40), content: note1 },
      { project: 'collab-demo', slug: 'dag-conventions', title: t('demo.note2.title'), preview: t('demo.note2.preview'), tags: 'dag,conventions', author: 'cipher', file_path: '/workspace/.collabhub/memory/demo/dag-conventions.md', updated_at: at(75), content: note2 },
    ],
  };
}

function demoDoctor() {
  return {
    overall: 'warn',
    pass_count: 7,
    total_checks: 8,
    checks: [
      { id: 'runtime.node', status: 'pass', detail: t('doctor.runtime') },
      { id: 'db.fts5', status: 'pass', detail: t('doctor.db') },
      { id: 'dirs.runtime', status: 'pass', detail: t('doctor.dirs') },
      { id: 'mail.hub', status: 'pass', detail: t('doctor.mail') },
      { id: 'toolkit.ast_grep', status: 'pass', detail: t('doctor.ast') },
      { id: 'toolkit.repomix', status: 'warn', detail: t('doctor.repomix') },
      { id: 'workspace.sandbox', status: 'pass', detail: t('doctor.sandbox') },
      { id: 'backup.recent', status: 'pass', detail: t('doctor.backup') },
    ],
  };
}

function demoEvents() {
  const now = Date.now();
  const base = [
    { event_type: t('demo.evt.verify'), actor: 'cipher', task_id: 'demo-run-01', payload_json: '{"preset":"node-test","durationMs":4200}', minutes: 3 },
    { event_type: t('demo.evt.dispatched'), actor: 'beacon', task_id: 'demo-queue-01', payload_json: '{"member":"beacon","role":"implementer"}', minutes: 12 },
    { event_type: t('demo.evt.reconciled'), actor: 'atlas', task_id: 'demo-review-01', payload_json: '{"state":"uncertain"}', minutes: 27 },
    { event_type: t('demo.evt.memory'), actor: 'atlas', task_id: null, payload_json: '{"project":"collab-demo","slug":"release-checklist"}', minutes: 44 },
    { event_type: t('demo.evt.cooldown'), actor: 'delta', task_id: 'demo-stall-01', payload_json: '{"reason":"429","retry_after_s":42}', minutes: 58 },
    { event_type: t('demo.evt.batch'), actor: 'system', task_id: null, payload_json: '{"batch_id":"demo-batch-01"}', minutes: 75 },
  ];
  return base.map((e) => ({ ...e, created_at: new Date(now - e.minutes * 60_000).toISOString() }));
}

function demoTaskLogs(task) {
  if (!task) return [];
  const simLogs = state.sim.logs.get(task.task_id);
  if (simLogs && simLogs.length) return simLogs.slice();
  const base = Date.now() - 42_000;
  const line = (offset, stream, text) => ({ ts: new Date(base + offset * 1000).toISOString(), stream, text });
  const lines = [
    line(0, 'system', t('demo.log.attach', { id: task.task_id })),
    line(1, 'system', t('demo.log.spawn')),
    line(2, 'stdout', t('demo.log.read1')),
    line(3, 'stdout', t('demo.log.read2')),
    line(5, 'stdout', t('demo.log.tool')),
    line(7, 'stdout', t('demo.log.write')),
  ];
  if (task.state === 'failed' || task.state === 'cancelled') {
    lines.push({ ts: new Date(base + 9000).toISOString(), stream: 'stderr', text: task.state === 'cancelled' ? t('demo.log.killed') : (task.error_message || t('demo.log.stderr')) });
  } else if (task.state === 'completed') {
    lines.push(line(9, 'stdout', t('demo.log.exit')));
  } else if (task.state === 'stalled') {
    lines.push({ ts: new Date(base + 9000).toISOString(), stream: 'stderr', text: task.error_message || t('demo.log.stderr') });
  } else {
    lines.push({ ts: new Date(base + 9000).toISOString(), stream: 'stdout', text: t('demo.log.stream', { n: 1 }) });
    lines.push({ ts: new Date(base + 11_000).toISOString(), stream: 'stdout', text: t('demo.log.stream', { n: 2 }) });
  }
  return lines;
}

/* ------------------------------------------------------------------ */
/* Static / demo mode detection                                        */
/* ------------------------------------------------------------------ */

const DEMO_QUERY = (() => {
  try { return new URLSearchParams(location.search).get('demo') === '1'; } catch { return false; }
})();

const META_STATIC_HINT = (() => {
  try {
    const meta = document.querySelector('meta[name="collabhub-static-demo"]');
    return Boolean(meta) && meta.getAttribute('content') === '1';
  } catch { return false; }
})();

const STATIC_HOSTS = ['github.io', 'gitlab.io', 'gitee.io', 'pages.dev', 'netlify.app', 'vercel.app', 'surge.sh'];

function isStaticHost() {
  if (location.protocol === 'file:' || location.protocol === 'blob:') return true;
  const host = String(location.hostname || '').toLowerCase();
  return STATIC_HOSTS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/* Decide the runtime mode before anything else runs.
 *  - static host      → static demo, zero network traffic
 *  - ?demo=1          → probe the demo endpoint once; a non-JSON / error reply means static
 *  - meta hint only   → stay live, but fall back to static demo if the API is unreachable
 */
async function detectMode() {
  // The Pages pipeline injects <meta name="collabhub-static-demo" content="1">,
  // so a meta hit means "this document has no backend" — go static with zero traffic.
  if (META_STATIC_HINT || isStaticHost()) {
    state.demo = true;
    state.static = true;
    return;
  }
  if (DEMO_QUERY) {
    state.demo = true;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2500);
      const res = await fetch('/api/overview?demo=1', { headers: { Accept: 'application/json' }, signal: controller.signal });
      clearTimeout(timer);
      const contentType = String(res.headers.get('content-type') || '');
      if (!res.ok || !contentType.includes('application/json')) throw new Error('not-json');
      state.overviewProbe = await res.json();
      state.static = false;
    } catch {
      state.static = true;
    }
    return;
  }
  state.demo = false;
  state.static = false;
}

function enterStaticDemo() {
  if (state.static) return;
  state.static = true;
  state.demo = true;
  const pill = $('#demoPill');
  if (pill) { pill.hidden = false; pill.textContent = t('topbar.static'); }
  document.title = t('app.titleStatic');
  setSsePill(t('topbar.sseStatic'), 'demo');
  clearInterval(state.timers.poll);
  state.timers.poll = null;
  stopSse();
  applyDemoFixture(buildDemoFixture());
  renderAll();
  state.selfDemo = null;
  state.selfPreview = null;
  if (state.view === 'system') loadSelfCheck({ quiet: true });
  setLastUpdated(new Date().toISOString());
}

/* ------------------------------------------------------------------ */
/* Overview                                                            */
/* ------------------------------------------------------------------ */

function setLastUpdated(iso) {
  const el = $('#updatedAt');
  if (!el) return;
  el.textContent = iso ? t('topbar.syncAt', { time: fmtTimeShort(iso) }) : t('topbar.syncPending');
}

function renderMail(mail) {
  state.mail = mail || null;
  const pill = $('#mailPill');
  if (!pill) return;
  const ok = Boolean(mail?.ok);
  pill.textContent = ok ? t('topbar.mailOnline', { version: mail.version || '' }) : t('topbar.mailOffline');
  pill.classList.toggle('ok', ok);
  pill.classList.toggle('off', !ok);
  pill.title = ok ? t('topbar.mailTitle') : (mail?.error || t('topbar.mailOffline'));
}

function renderKpis(metrics) {
  const box = $('#kpiBar');
  if (!box) return;
  const m = metrics || {};
  const cassValue = m.cass_conversations != null ? t('kpi.cassSessions', { n: m.cass_conversations }) : t('kpi.cassNotIndexed');
  const cassSub = m.cass_messages != null ? t('kpi.cassMessages', { n: fmtTokens(m.cass_messages) }) : t('kpi.cassSub0');
  const cards = [
    { label: t('kpi.agents'), value: `${m.agents_ready ?? 0} / ${m.agents_total ?? 0}`, sub: t('kpi.agentsSub') },
    { label: t('kpi.tasks'), value: `${m.tasks_completed ?? 0} / ${m.tasks_total ?? 0}`, sub: t('kpi.tasksSub') },
    { label: t('kpi.active'), value: `${m.tasks_active ?? 0} / ${m.tasks_stalled ?? 0}`, sub: t('kpi.activeSub') },
    { label: t('kpi.worktrees'), value: String(m.active_worktrees ?? 0), sub: t('kpi.worktreesSub') },
    { label: t('kpi.notes'), value: String(m.memory_notes ?? 0), sub: t('kpi.notesSub') },
    { label: t('kpi.cass'), value: cassValue, sub: cassSub },
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
  box.innerHTML = `<span class="meta">${esc(t('kpi.toolkit'))}</span>` + TOOLKIT_ITEMS.map((it) => {
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
  const stalled = tasks.filter((task) => task.state === 'stalled' || task.state === 'uncertain');
  if (!stalled.length) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.innerHTML = `
    <div><strong>⚠️ ${esc(t('banner.stalled', { n: stalled.length }))}</strong>
      ${stalled.map((task) => `<code>${esc(task.task_id)}</code> <span class="meta">(${esc(task.member)} · ${esc(task.error_code || task.state)})</span>`).join(' · ')}
    </div>
    <button type="button" class="btn warn sm" data-open-task="${esc(stalled[0].task_id)}">${esc(t('banner.action'))}</button>`;
}

function renderAgentFilter() {
  const sel = $('#filterAgent');
  if (!sel) return;
  /* Rebuilding the <select> collapses an open dropdown; only touch it when the
   * agent identities (or the active language) actually changed. */
  const sig = `${LANG}|${state.members.map((m) => `${m.member}:${m.name || ''}`).join('|')}`;
  if (state.agentFilterSig === sig) return;
  state.agentFilterSig = sig;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${esc(t('tasks.filterAgentAll'))}</option>` + state.members.map((m) => (
    `<option value="${esc(m.member)}">${esc(m.name || m.member)}</option>`
  )).join('');
  if (prev && state.members.some((m) => m.member === prev)) sel.value = prev;
}

function renderRoster() {
  const box = $('#roster');
  if (!box) return;
  const count = $('#rosterCount');
  if (count) count.textContent = t('roster.count', { n: state.members.length });
  if (!state.members.length) {
    box.innerHTML = `<div class="mini-empty">${esc(t('roster.empty'))}</div>`;
    return;
  }
  box.innerHTML = state.members.map((m) => {
    const st = m.state || 'unknown';
    const tel = state.telemetry?.[m.member];
    const telHtml = tel && Number(tel.total) > 0 ? `
      <div class="agent-tel">
        <span>${esc(t('roster.receipts', { done: tel.completed ?? 0, total: tel.total ?? 0 }))}</span>
        ${tel.success_rate != null ? `<span>${esc(t('roster.success', { pct: Math.round(Number(tel.success_rate) * 100) }))}</span>` : ''}
        ${tel.avg_latency_ms != null ? `<span>${(Number(tel.avg_latency_ms) / 1000).toFixed(1)}s</span>` : ''}
        ${tel.total_tokens ? `<span>${fmtTokens(tel.total_tokens)} tok</span>` : ''}
      </div>` : '';
    const actions = [];
    if (!state.demo) {
      if (['generic-cli', 'openai-http'].includes(m.driver)) actions.push(`<button type="button" class="btn ghost sm" data-test-agent="${esc(m.member)}">${esc(t('roster.testConn'))}</button>`);
      if (m.in_cooldown || m.cli_in_cooldown) actions.push(`<button type="button" class="btn warn sm" data-clear-cooldown="${esc(m.member)}">${esc(t('roster.cooldown', { s: Number(m.cooldown_remaining_s || 0) }))}</button>`);
      if (!m.builtin) actions.push(`<button type="button" class="btn danger sm" data-remove-agent="${esc(m.member)}">${esc(t('roster.remove'))}</button>`);
    }
    return `
      <article class="agent-card">
        <span class="agent-avatar">${esc(initials(m.name || m.member))}</span>
        <div class="agent-body">
          <div class="agent-top">
            <span class="agent-name">${esc(m.name || m.member)}${m.builtin ? '' : ` <span class="pill">${esc(t('roster.ext'))}</span>`}</span>
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
    ? `<span class="meta">${esc(t('batch.open'))}</span>` + state.batches.map((b) => {
      const badgeCls = b.all_succeeded ? 'st-completed' : (b.has_stalled ? 'st-stalled' : (b.all_terminal ? 'st-failed' : 'st-running'));
      const badgeText = b.all_succeeded ? t('batch.allOk') : (b.has_stalled ? t('batch.stalled') : (b.all_terminal ? t('batch.ended') : t('batch.active')));
      const stats = Object.entries(b.counts || {}).map(([k, v]) => `${stateLabelOf(k)}:${v}`).join(' · ');
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
  if (!rows.length) { box.innerHTML = `<div class="mini-empty">${esc(t('ov.recent.empty'))}</div>`; return; }
  box.innerHTML = rows.map((task) => `
    <div class="mini-row" data-open-task="${esc(task.task_id)}">
      <div class="mini-main">
        <div class="mini-title">${esc(task.title)}</div>
        <div class="mini-sub">${esc(task.task_id)} · ${esc(task.member)} · ${esc(task.role)}</div>
      </div>
      <div class="mini-right">${badge(task.state)}<span class="mini-time">${esc(relTime(task.updated_at))}</span></div>
    </div>`).join('');
}

function renderOverviewWorktrees() {
  const box = $('#ovWorktrees');
  if (!box) return;
  if (!state.worktrees.length) { box.innerHTML = `<div class="mini-empty">${esc(t('ov.wt.empty'))}</div>`; return; }
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

function renderAllQuiet() {
  renderKpis(state.metrics);
  renderSelfStrip();
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
}

function renderAll() {
  renderAllQuiet();
  if (state.flags.healthLoaded) renderHealth();
  refreshDagAgentOptions();
  renderDagBatchSelect();
  renderDagCanvas();
}

function applyOverviewData(data) {
  state.members = data.members || [];
  state.tasks = data.tasks || [];
  state.telemetry = data.telemetry?.agents || {};
  state.metrics = data.metrics || {};
  state.batches = data.batches || [];
  state.worktrees = data.worktrees || [];
  state.notes = data.notes || [];
  state.toolkit = data.toolkit || {};
  state.selfImprove = data.self_improve || null;
  renderMail(data.mail_hub);
  setLastUpdated(data.generated_at);
}

function applyDemoFixture(fixture) {
  state.members = fixture.members || [];
  const simTasks = state.sim.tasks || [];
  state.tasks = [...simTasks, ...(fixture.tasks || [])];
  state.telemetry = fixture.telemetry?.agents || {};
  state.metrics = fixture.metrics || {};
  const simBatch = state.sim.batchId ? simBatchSummary() : null;
  state.batches = simBatch ? [simBatch, ...(fixture.batches || [])] : (fixture.batches || []);
  state.worktrees = fixture.worktrees || [];
  state.notes = fixture.notes || [];
  state.toolkit = fixture.toolkit || {};
  state.selfImprove = fixture.self_improve || null;
  renderMail(fixture.mail_hub);
}

/* Content signature of every panel renderAll() paints. `generated_at` is
 * deliberately excluded: the server stamps a fresh ISO string on each poll, so
 * hashing it would force a full DOM rebuild every 15s for unchanged data. */
function overviewSignature() {
  const tasks = state.tasks.map((task) => `${task.task_id}:${task.state}:${task.updated_at || ''}`).join(',');
  const members = state.members.map((m) => `${m.member}:${m.state || ''}:${m.in_cooldown || m.cli_in_cooldown ? 1 : 0}:${m.builtin ? 1 : 0}`).join(',');
  const worktrees = state.worktrees.map((w) => `${w.task_id}:${w.state || ''}:${w.verify_status || ''}:${w.updated_at || ''}`).join(',');
  const batches = state.batches.map((b) => `${b.batch_id}:${b.total ?? ''}:${JSON.stringify(b.counts || {})}:${b.all_terminal ? 1 : 0}`).join(',');
  return [
    LANG,
    tasks,
    members,
    worktrees,
    batches,
    String(state.notes.length),
    state.mail?.ok ? '1' : '0',
    JSON.stringify(state.metrics || {}),
    JSON.stringify(state.telemetry || {}),
    JSON.stringify(state.toolkit || {}),
    /* v1.4: the health pill is part of the overview paint, so its signature
     * fields gate the rebuild too — unchanged polls must mutate nothing. */
    JSON.stringify(state.selfImprove || null),
  ].join('|');
}

/* Returns true only when a rebuild actually happened. */
function renderOverviewIfDirty() {
  const sig = overviewSignature();
  if (sig === state.overviewSig) return false;
  state.overviewSig = sig;
  renderAll();
  return true;
}

async function loadOverview({ quiet = false } = {}) {
  /* In-flight guard: a slow poll must never race a user-triggered refresh. */
  if (state.overviewLoading) { state.overviewQueued = true; return; }
  state.overviewLoading = true;
  const seq = ++state.overviewSeq;
  try {
    if (state.static) {
      applyDemoFixture(buildDemoFixture());
      setLastUpdated(new Date().toISOString());
      if (seq === state.overviewSeq) renderOverviewIfDirty();
      return;
    }
    let data;
    if (state.demo && state.overviewProbe) {
      data = state.overviewProbe;
      state.overviewProbe = null;
    } else {
      data = await apiGet(state.demo ? '/api/overview?demo=1' : '/api/overview');
    }
    /* Monotonic sequence: never let an out-of-order response overwrite newer state. */
    if (seq !== state.overviewSeq) return;
    applyOverviewData(data);
    renderOverviewIfDirty();
    if (state.view === 'system' && state.flags.eventsLoaded) loadEvents({ quiet: true });
  } catch (err) {
    if (state.demo) {
      enterStaticDemo();
      return;
    }
    if (!quiet) toast(t('toast.loadFail', { error: err.message }), 'error');
    const el = $('#updatedAt');
    if (el) el.textContent = t('topbar.syncFailed');
  } finally {
    state.overviewLoading = false;
    if (state.overviewQueued) {
      state.overviewQueued = false;
      loadOverview({ quiet: true });
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tasks                                                               */
/* ------------------------------------------------------------------ */

function filteredTasks() {
  const q = ($('#filterText')?.value || '').trim().toLowerCase();
  const agent = $('#filterAgent')?.value || '';
  const st = $('#filterState')?.value || '';
  return state.tasks.filter((task) => {
    if (agent && task.member !== agent) return false;
    if (st && task.state !== st) return false;
    if (q) {
      const hay = `${task.title} ${task.task_id} ${task.batch_id || ''} ${task.result_text || ''} ${task.error_message || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderTasks() {
  const rows = filteredTasks();
  const count = $('#taskCount');
  if (count) count.textContent = t('tasks.count', { shown: rows.length, total: state.tasks.length });
  /* Render ONLY the active view: the hidden pane used to be rebuilt on every
   * poll, doubling DOM work for content nobody could see. */
  const body = state.taskView === 'table' ? $('#tasksBody') : null;
  if (body) {
    body.innerHTML = rows.length ? rows.map((task) => {
      const receipt = [task.external_id ? `id:${String(task.external_id).slice(0, 16)}` : '', task.reply_generation ? `gen:${task.reply_generation}` : ''].filter(Boolean).join(' ');
      const snippet = task.result_text ? task.result_text.slice(0, 140) : (task.error_message || task.project_dir);
      return `<tr class="clickable" data-open-task="${esc(task.task_id)}">
        <td>
          <div class="task-title">${esc(task.title)}</div>
          <div class="task-sub"><code class="task-id-code" title="${esc(task.task_id)}">${esc(task.task_id)}</code><span>${esc(task.role)}</span>${task.batch_id ? `<span>${esc(task.batch_id)}</span>` : ''}</div>
        </td>
        <td><div>${esc(task.member)}</div><div class="task-sub"><code>${esc(task.channel)}</code></div></td>
        <td>${badge(task.state)}</td>
        <td><code>${esc(receipt || '—')}</code></td>
        <td><div class="meta">${esc(snippet || '—')}</div><div class="meta">${esc(fmtDate(task.updated_at))}</div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="5" class="table-empty">${esc(t('tasks.empty'))}</td></tr>`;
  }

  const kanban = state.taskView === 'kanban' ? $('#tasksKanbanWrap') : null;
  if (kanban) {
    kanban.innerHTML = KANBAN_COLUMNS.map((col) => {
      const items = rows.filter((task) => col.match(task.state));
      return `<section class="kb-col">
        <div class="kb-head">
          <span class="kb-title"><i class="dot dot-${col.dot}"></i>${esc(t(col.titleKey))}</span>
          <span class="kb-count">${items.length}</span>
        </div>
        <div class="kb-cards">
          ${items.length ? items.map((task) => `
            <article class="kb-card" data-open-task="${esc(task.task_id)}">
              <div class="kb-card-top">
                <span class="kb-card-title">${esc(task.title)}</span>
                ${badge(task.state)}
              </div>
              <div class="kb-card-meta">
                <span>${esc(task.member)}</span><span>·</span><span>${esc(task.role)}</span>
                <code>${esc(String(task.task_id).slice(0, 24))}</code>
              </div>
              <div class="kb-card-meta"><span>${esc(relTime(task.updated_at))}</span>${task.batch_id ? `<span>${esc(task.batch_id)}</span>` : ''}</div>
            </article>`).join('') : `<div class="kb-empty">${esc(t('kb.empty'))}</div>`}
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
  /* Paint the newly selected view immediately instead of waiting for a poll. */
  renderTasks();
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
  if (!list.length) { box.innerHTML = `<div class="note-empty">${esc(t('mem.empty'))}</div>`; return; }
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
    if (!note) { toast(t('mem.none'), 'warn'); return; }
    openDrawer(`
      <div class="drawer-head">
        <div>
          <div class="drawer-title">${esc(note.title)}</div>
          <div class="drawer-meta"><span>${esc(t('mem.project'))} <span class="pill">${esc(note.project)}</span></span><span>${esc(t('mem.slug'))} <code>${esc(note.slug)}</code></span><span>${esc(t('mem.author'))} ${esc(note.author || '—')}</span></div>
        </div>
        <div class="panel-tools">
          <button type="button" class="btn ghost sm" data-toggle-raw="note" data-raw-label="${esc(t('mem.markdown'))}" data-rich-label="${esc(t('mem.preview'))}">${esc(t('mem.markdown'))}</button>
          <button type="button" class="icon-btn" data-close-drawer="1" aria-label="${esc(t('common.close'))}">×</button>
        </div>
      </div>
      <div id="noteRich" class="md-view">${renderSafeMarkdown(note.content)}</div>
      <pre id="noteRaw" class="mono-pre" hidden>${esc(note.content)}</pre>`, { kind: null });
  } catch (err) {
    toast(t('mem.openFail', { error: err.message }), 'error');
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
    toast(t('mem.searchFail', { error: err.message }), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* DAG + canvas + live execution overlay                               */
/* ------------------------------------------------------------------ */

function defaultDagSteps() {
  return [
    { id: 'plan', member: 'auto', role: 'planner', depends_on: [], prompt: t('dag.planPrompt') },
    { id: 'redteam', member: 'auto', role: 'reviewer', depends_on: [], prompt: t('dag.redteamPrompt') },
    { id: 'verdict', member: 'auto', role: 'synthesizer', depends_on: ['plan', 'redteam'], prompt: t('dag.verdictPrompt') },
  ];
}

function dagTemplates(name) {
  if (name === 'debate') {
    return [
      { id: 'advocate', member: 'auto', role: 'planner', depends_on: [], prompt: t('dag.debate.advocate') },
      { id: 'redteam', member: 'auto', role: 'reviewer', depends_on: [], prompt: t('dag.debate.redteam') },
      { id: 'verdict', member: 'auto', role: 'synthesizer', depends_on: ['advocate', 'redteam'], prompt: t('dag.debate.verdict') },
    ];
  }
  return [
    { id: 'research', member: 'auto', role: 'researcher', depends_on: [], prompt: t('dag.pipe.research') },
    { id: 'review', member: 'auto', role: 'reviewer', depends_on: ['research'], prompt: t('dag.pipe.review') },
    { id: 'summary', member: 'auto', role: 'synthesizer', depends_on: ['review'], prompt: t('dag.pipe.summary') },
  ];
}

function dagMemberOptions(current) {
  const eligible = state.members.filter((m) => AGENT_DRIVERS.includes(m.driver));
  const ids = new Set(eligible.map((m) => m.member));
  const options = [`<option value="auto"${current === 'auto' || !current ? ' selected' : ''}>${esc(t('dag.autoRoute'))}</option>`];
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
  if (!state.dagSteps.length) { box.innerHTML = `<div class="mini-empty">${esc(t('dag.emptySteps'))}</div>`; return; }
  box.innerHTML = state.dagSteps.map((step, i) => `
    <div class="dag-step-card" data-dag-idx="${i}">
      <div class="dag-step-head">
        <span class="dag-step-no">${esc(t('dag.stepNo', { n: String(i + 1).padStart(2, '0'), id: step.id }))}</span>
        <button type="button" class="btn ghost sm" data-del-dag="${i}">${esc(t('dag.delete'))}</button>
      </div>
      <div class="dag-step-grid">
        <label class="dag-field"><span>${esc(t('dag.stepId'))}</span><input type="text" data-dag-f="id" value="${esc(step.id)}" /></label>
        <label class="dag-field"><span>${esc(t('dag.agent'))}</span><select data-dag-f="member">${dagMemberOptions(step.member)}</select></label>
        <label class="dag-field"><span>${esc(t('dag.depends'))}</span><input type="text" data-dag-f="deps" value="${esc((step.depends_on || []).join(','))}" placeholder="${esc(t('dag.dependsPh'))}" /></label>
      </div>
      <label class="dag-field dag-field-prompt"><span>${esc(t('dag.prompt'))}</span><textarea data-dag-f="prompt">${esc(step.prompt)}</textarea></label>
    </div>`).join('');
  const count = $('#dagNodeCount');
  if (count) count.textContent = t('dag.nodes', { n: state.dagSteps.length });
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

function liveInfo(task) {
  const start = new Date(task.attempted_at || task.created_at || task.updated_at || Date.now()).getTime();
  const end = task.completed_at ? new Date(task.completed_at).getTime() : Date.now();
  const duration = Number.isFinite(start) && Number.isFinite(end) && end > start ? (end - start) / 1000 : 0;
  return { state: task.state, task_id: task.task_id, duration };
}

/* Exact batch task_id → DAG step id. Task ids are `${batchId}_${stepId}` and a
 * resume retry appends `_r<n>`, so `_r2` retries must still bind to the step
 * node they retry (title substring matching used to bind the wrong node). */
function stepOf(task, batchId = state.dagBatch) {
  return String(task?.task_id ?? '')
    .replace(`${batchId}_`, '')
    .replace(/_r\d+$/, '');
}

function attemptOf(task) {
  const match = /_r(\d+)$/.exec(String(task?.task_id ?? ''));
  return match ? Number(match[1]) : 0;
}

/* Newest attempt wins: higher retry ordinal first, then the freshest timestamp. */
function isNewerAttempt(candidate, current) {
  if (!current) return true;
  const a = attemptOf(candidate);
  const b = attemptOf(current);
  if (a !== b) return a > b;
  const at = new Date(candidate.updated_at || candidate.attempted_at || candidate.created_at || 0).getTime() || 0;
  const bt = new Date(current.updated_at || current.attempted_at || current.created_at || 0).getTime() || 0;
  return at >= bt;
}

/* Bind the selected batch's tasks onto DAG step ids.
 * Preferred signals: task.step_id / task.meta.step_id, then the exact
 * `${batchId}_${stepId}` (retry-aware) task_id contract, then positional order
 * when the batch has exactly one task per step. */
function liveStepMap() {
  const map = new Map();
  const batchId = state.dagBatch;
  if (!batchId) return map;
  if (state.sim.batchId === batchId) {
    for (const [id, info] of state.sim.steps) map.set(id, info);
    return map;
  }
  const tasks = state.tasks.filter((task) => task.batch_id === batchId);
  if (!tasks.length) return map;
  const steps = state.dagSteps || [];

  const byStep = new Map();
  for (const task of tasks) {
    const explicit = task.step_id || task.meta?.step_id || task.meta?.dag_step || null;
    const nodeId = explicit || stepOf(task, batchId);
    if (!nodeId) continue;
    if (isNewerAttempt(task, byStep.get(nodeId))) byStep.set(nodeId, task);
  }

  for (const node of steps) {
    const hit = byStep.get(node.id);
    if (hit) map.set(node.id, liveInfo(hit));
  }
  if (!map.size && tasks.length === steps.length && steps.length > 0) {
    const ordered = tasks.slice().sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    steps.forEach((node, i) => { if (ordered[i]) map.set(node.id, liveInfo(ordered[i])); });
  }
  return map;
}

function renderDagCanvas() {
  const svg = $('#dagCanvas');
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const steps = state.dagSteps || [];
  const cycleHint = $('#dagCycleHint');
  const live = liveStepMap();

  if (!steps.length) {
    svg.setAttribute('width', '560');
    svg.setAttribute('height', '240');
    svg.setAttribute('viewBox', '0 0 560 240');
    const text = svgEl('text', { x: 280, y: 122, 'text-anchor': 'middle', fill: 'var(--faint)', 'font-size': '11' }, t('dag.emptyCanvas'));
    svg.append(text);
    if (cycleHint) cycleHint.hidden = true;
    return;
  }

  const graph = computeDagGraph(steps);
  const NODE_W = 166;
  const NODE_H = 64;
  const COL_GAP = 214;
  const ROW_GAP = 96;
  const PAD_X = 22;
  const PAD_Y = 26;
  const maxDepth = Math.max(0, ...graph.nodes.map((n) => graph.depthMap.get(n.id) || 0));
  const maxRows = Math.max(1, ...graph.columns.map((c) => (c ? c.length : 0)));
  const width = Math.max(412, PAD_X * 2 + maxDepth * COL_GAP + NODE_W);
  const contentHeight = PAD_Y * 2 + (maxRows - 1) * ROW_GAP + NODE_H;
  const height = Math.max(300, contentHeight + 20);
  const offsetY = Math.max(0, (height - contentHeight) / 2);
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.style.minWidth = maxDepth > 2 ? `${width}px` : '100%';

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

  const isLiveActive = (nodeState) => ['running', 'dispatched', 'dispatching'].includes(nodeState);

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
    const upstream = live.get(edge.from);
    const downstream = live.get(edge.to);
    let edgeClass = `dag-edge${edge.cycle ? ' dag-edge-cycle' : ''}`;
    if (!edge.cycle) {
      if (isLiveActive(downstream?.state) && upstream?.state === 'completed') edgeClass += ' dag-edge-flow';
      else if (upstream?.state === 'completed') edgeClass += ' dag-edge-done';
    }
    const path = svgEl('path', {
      d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
      class: edgeClass,
      'marker-end': `url(#${edge.cycle ? 'dagArrowCycle' : 'dagArrow'})`,
    });
    path.append(svgEl('title', {}, `${edge.from} → ${edge.to}`));
    edgeLayer.append(path);
  }
  svg.append(edgeLayer);

  const nodeLayer = svgEl('g');
  for (const node of graph.nodes) {
    const pos = positions.get(node.id);
    if (!pos) continue;
    const liveState = live.get(node.id);
    const liveCls = liveState ? ` live-${liveState.state}` : '';
    const group = svgEl('g', {
      class: `dag-node-group${graph.inCycle.has(node.id) ? ' dag-node-cycle' : ''}${liveCls}`,
      transform: `translate(${pos.x}, ${pos.y})`,
      'data-dag-node': node.id,
      tabindex: '0',
      role: 'button',
      'aria-label': liveState ? `Step ${node.id} · ${stateLabelOf(liveState.state)}` : `Step ${node.id}`,
    });
    if (liveState) group.setAttribute('data-dag-task', liveState.task_id);
    group.append(svgEl('title', {}, `${node.id} · ${node.member || 'auto'} · ${node.role || 'researcher'}${liveState ? ` · ${stateLabelOf(liveState.state)}` : ''}`));

    if (liveState && isLiveActive(liveState.state)) {
      group.append(svgEl('rect', { class: 'dag-live-ring', x: -5, y: -5, width: NODE_W + 10, height: NODE_H + 10, rx: 13 }));
    }
    group.append(svgEl('rect', { class: `dag-node-box${liveState ? ` dag-node-box-${liveState.state}` : ''}`, width: NODE_W, height: NODE_H, rx: 9 }));
    const roleClass = ['planner', 'reviewer', 'synthesizer'].includes(node.role) ? node.role : 'default';
    group.append(svgEl('circle', { cx: 14, cy: 19, r: 4, class: `dag-role-dot ${roleClass}` }));
    const label = String(node.id).length > 19 ? `${String(node.id).slice(0, 18)}…` : String(node.id);
    group.append(svgEl('text', { x: 25, y: 23, class: 'dag-node-label' }, label));
    const sub = `${node.member || 'auto'} · ${node.role || 'researcher'}`;
    group.append(svgEl('text', { x: 14, y: 45, class: 'dag-node-sub' }, sub.length > 26 ? `${sub.slice(0, 25)}…` : sub));
    const deps = (node.depends_on || []).length ? `${t('dag.legend.deps')}: ${node.depends_on.join(', ')}` : t('dag.edgesHint');
    group.append(svgEl('text', { x: 14, y: 57, class: 'dag-node-role' }, deps.length > 28 ? `${deps.slice(0, 27)}…` : deps));

    if (liveState) {
      const badgeLabel = liveState.state === 'completed' && liveState.duration
        ? `${stateLabelOf(liveState.state)} · ${fmtDuration(liveState.duration)}`
        : stateLabelOf(liveState.state);
      const badgeText = svgEl('text', {
        x: NODE_W - 10, y: 20, 'text-anchor': 'end', class: `dag-live-badge live-${liveState.state}`,
      }, badgeLabel.length > 20 ? `${badgeLabel.slice(0, 19)}…` : badgeLabel);
      group.append(badgeText);
      if (liveState.state === 'completed') {
        group.append(svgEl('text', { x: NODE_W - 10, y: 46, 'text-anchor': 'end', class: 'dag-live-check' }, '✓'));
      } else if (!isLiveActive(liveState.state)) {
        group.append(svgEl('circle', { cx: NODE_W - 14, cy: 42, r: 3.4, class: `dag-live-dot live-${liveState.state}` }));
      }
    }
    nodeLayer.append(group);
  }
  svg.append(nodeLayer);

  if (cycleHint) {
    const hasCycle = graph.inCycle.size > 0;
    cycleHint.hidden = !hasCycle;
    cycleHint.textContent = hasCycle ? `⚠ ${t('dag.cycle', { ids: [...graph.inCycle].join(', ') })}` : '';
  }
  const count = $('#dagNodeCount');
  if (count) count.textContent = t('dag.nodesEdges', { n: graph.nodes.length, e: graph.edges.length });
}

function addDagStep() {
  syncDagFromDom();
  if (state.dagSteps.length >= MAX_DAG_STEPS) {
    toast(t('dag.stepLimit', { max: MAX_DAG_STEPS }), 'warn');
    return;
  }
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
  if (!Number.isFinite(index) || index < 0) return;
  const card = $(`#dagStepsList .dag-step-card[data-dag-idx="${Number(index)}"]`);
  if (!card) return;
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  card.classList.add('flash');
  setTimeout(() => card.classList.remove('flash'), 1400);
  const input = card.querySelector('[data-dag-f="id"]');
  input?.focus({ preventScroll: true });
}

/* ---- custom DAG templates (localStorage) ---- */

function loadDagTemplates() {
  try {
    const raw = localStorage.getItem(DAG_TPL_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((tpl) => tpl && typeof tpl.name === 'string' && Array.isArray(tpl.steps))
      .map((tpl) => ({ name: tpl.name, steps: tpl.steps, saved_at: tpl.saved_at || null }))
      .slice(0, 40);
  } catch {
    return [];
  }
}

function persistDagTemplates(list) {
  state.dagTemplates = list;
  try {
    localStorage.setItem(DAG_TPL_KEY, JSON.stringify(list));
    return true;
  } catch (err) {
    toast(String(err?.message || err), 'warn');
    return false;
  }
}

function renderDagTemplates() {
  const sel = $('#dagTplSelect');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = `<option value="">${esc(t('dag.tplNone'))}</option>` + state.dagTemplates.map((tpl) => (
    `<option value="${esc(tpl.name)}">${esc(tpl.name)}${tpl.steps?.length ? ` (${tpl.steps.length})` : ''}</option>`
  )).join('');
  if (prev && state.dagTemplates.some((tpl) => tpl.name === prev)) sel.value = prev;
  else sel.value = '';
}

function saveDagTemplate() {
  syncDagFromDom();
  const name = ($('#dagTplName')?.value || '').trim() || ($('#dagName')?.value || '').trim();
  if (!name) { toast(t('dag.tplNeedName'), 'warn'); return; }
  if (!state.dagSteps.length) { toast(t('dag.tplNeedSteps'), 'warn'); return; }
  const steps = cloneSteps(state.dagSteps);
  const list = state.dagTemplates.filter((tpl) => tpl.name !== name);
  list.unshift({ name, steps, saved_at: new Date().toISOString() });
  if (persistDagTemplates(list.slice(0, 40))) {
    renderDagTemplates();
    const sel = $('#dagTplSelect');
    if (sel) sel.value = name;
    toast(t('dag.tplSaved', { name }), 'success');
  }
}

function cloneSteps(steps) {
  return (steps || []).map((step) => ({
    id: String(step.id || ''),
    member: step.member || 'auto',
    role: step.role || 'researcher',
    depends_on: Array.isArray(step.depends_on) ? step.depends_on.slice() : [],
    prompt: step.prompt || '',
  }));
}

function loadDagTemplate(name) {
  const tpl = state.dagTemplates.find((item) => item.name === name);
  if (!tpl) return;
  state.dagSteps = cloneSteps(tpl.steps);
  state.dagBatch = null;
  state.dagBatchTouched = false;
  const nameInput = $('#dagName');
  if (nameInput) nameInput.value = name;
  renderDagSteps();
  renderDagBatchSelect();
  renderDagCanvas();
  toast(t('dag.tplLoaded', { name }), 'success');
}

function deleteDagTemplate() {
  const sel = $('#dagTplSelect');
  const name = sel?.value || '';
  if (!name) { toast(t('dag.tplPickFirst'), 'warn'); return; }
  const list = state.dagTemplates.filter((tpl) => tpl.name !== name);
  if (persistDagTemplates(list)) {
    renderDagTemplates();
    toast(t('dag.tplDeleted', { name }), 'success');
  }
}

/* ---- batch selector + resume + simulation ---- */

function batchHasIssues(batchId) {
  if (!batchId) return false;
  const tasks = state.tasks.filter((task) => task.batch_id === batchId);
  return tasks.some((task) => ['failed', 'cancelled', 'stalled', 'uncertain', 'needs_input'].includes(task.state));
}

function batchSummaryText(batchId) {
  const tasks = state.tasks.filter((task) => task.batch_id === batchId);
  if (!tasks.length) return '';
  const counts = {};
  for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
  return Object.entries(counts).map(([key, value]) => `${stateLabelOf(key)} ${value}`).join(' · ');
}

function renderDagBatchSelect() {
  const sel = $('#dagBatchSelect');
  if (!sel) return;
  if (!state.dagBatchTouched && !state.dagBatch) {
    const activeBatch = state.batches.find((b) => state.tasks.some((task) => task.batch_id === b.batch_id && ACTIVE_STATES.includes(task.state)));
    if (activeBatch) state.dagBatch = activeBatch.batch_id;
  }
  const batches = state.batches || [];
  sel.innerHTML = `<option value="">${esc(t('dag.batchNone'))}</option>` + batches.map((b) => {
    const summary = batchSummaryText(b.batch_id) || `${b.total ?? 0}`;
    return `<option value="${esc(b.batch_id)}">${esc(t('dag.batchOption', { id: b.batch_id, summary }))}</option>`;
  }).join('');
  if (state.dagBatch && batches.some((b) => b.batch_id === state.dagBatch)) sel.value = state.dagBatch;
  else { sel.value = ''; state.dagBatch = null; }

  const resumeBtn = $('#btnResumeBatch');
  if (resumeBtn) {
    resumeBtn.hidden = !(state.dagBatch && batchHasIssues(state.dagBatch));
    resumeBtn.textContent = t('dag.resume');
    resumeBtn.disabled = false;
  }
  const simBtn = $('#btnSimDag');
  if (simBtn) {
    simBtn.hidden = !state.demo;
    simBtn.textContent = state.sim.running
      ? t('dag.simStop')
      : (state.sim.batchId ? t('dag.simulateAgain') : t('dag.simulate'));
    simBtn.disabled = false; /* running is a Stop toggle, not a disabled state */
    simBtn.classList.toggle('danger', state.sim.running);
  }
}

async function runDag() {
  syncDagFromDom();
  const err = $('#dagErr');
  const out = $('#dagOut');
  if (err) err.textContent = '';
  if (state.demo) { toast(t('toast.dagDemo'), 'warn'); return; }
  if (out) { out.hidden = false; out.textContent = '…'; }
  try {
    const result = await apiPost('/api/workflows/run', {
      name: $('#dagName')?.value.trim() || 'visual-dag',
      project_dir: $('#dagDir')?.value.trim(),
      steps: state.dagSteps,
      wait_sec: 0,
    });
    if (out) out.textContent = JSON.stringify(result, null, 2);
    toast(t('toast.dagSubmitted'), 'success');
    const batchId = result?.batch_id || result?.batch?.batch_id || result?.workflow?.batch_id || null;
    if (batchId) {
      state.dagBatch = batchId;
      state.dagBatchTouched = false;
    }
    await loadOverview({ quiet: true });
    renderDagBatchSelect();
    renderDagCanvas();
  } catch (e) {
    if (out) out.hidden = true;
    if (err) err.textContent = e.message;
  }
}

async function resumeBatch() {
  const batchId = state.dagBatch;
  if (!batchId) { toast(t('resume.noBatch'), 'warn'); return; }
  if (state.demo) { toast(t('resume.demo'), 'warn'); return; }
  const btn = $('#btnResumeBatch');
  const original = btn?.textContent || t('dag.resume');
  if (btn) { btn.disabled = true; btn.textContent = t('dag.resumePending'); }
  try {
    const res = await apiPost('/api/workflows/resume', { batch_id: batchId, wait_sec: 0 });
    const skipped = Array.isArray(res.skipped_completed) ? res.skipped_completed.length : 0;
    const retried = Array.isArray(res.retried_steps) ? res.retried_steps.length : 0;
    const blocked = Array.isArray(res.blocked_uncertain) ? res.blocked_uncertain.length : 0;
    if (blocked) {
      /* Uncertain/stalled steps block a clean resume: surface the backend reason. */
      toast(res.message || t('resume.blocked', { n: blocked }), 'warn', 7000);
    } else {
      toast(skipped || retried
        ? t('resume.done', { batch: batchId, skipped, retried })
        : t('resume.none', { batch: batchId }), 'success');
    }
    await loadOverview({ quiet: true });
    renderDagBatchSelect();
    renderDagCanvas();
  } catch (err) {
    toast(t('resume.fail', { error: err.message }), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

function pickSimMember(step) {
  if (step.member && step.member !== 'auto') return step.member;
  const byRole = state.members.find((m) => (m.roles || []).includes(step.role));
  if (byRole) return byRole.member;
  return state.members[2]?.member || state.members[0]?.member || 'atlas';
}

function buildSimPlan(steps) {
  const graph = computeDagGraph(steps);
  const order = graph.nodes.slice().sort((a, b) => (graph.depthMap.get(a.id) || 0) - (graph.depthMap.get(b.id) || 0));
  const plan = new Map();
  for (const node of order) {
    const deps = (node.depends_on || []).filter((dep) => plan.has(dep));
    const start = deps.length ? Math.max(...deps.map((dep) => plan.get(dep).end)) + 150 : 0;
    const base = 2200 + (plan.size % 3) * 700;
    const end = start + base;
    const taskId = `${state.sim.batchId}-${node.id}`;
    plan.set(node.id, {
      id: node.id, role: node.role || 'researcher', start, end,
      taskId, deps, logs: simLogsFor(node, taskId, base, deps.length),
      state: 'queued', duration: 0,
      emitted: 0,
    });
  }
  return plan;
}

function simLogsFor(node, taskId, durationMs, depCount) {
  const dur = (durationMs / 1000).toFixed(1);
  const at = (ms) => ms;
  const lines = [
    { offset: 0, stream: 'system', text: t('sim.logBoot', { id: node.id }) },
    { offset: 140, stream: 'system', text: t('sim.logAgent', { role: node.role || 'researcher' }) },
    { offset: 420, stream: 'stdout', text: node.role === 'synthesizer' ? t('sim.logVerdict', { n: depCount }) : t('sim.logPlan') },
    { offset: Math.round(durationMs * 0.32), stream: 'stdout', text: t('sim.logWork', { n: 2 + (depCount % 2) }) },
    { offset: Math.round(durationMs * 0.48), stream: 'stdout', text: t('sim.logTool') },
    { offset: Math.round(durationMs * 0.62), stream: 'stdout', text: t('sim.logStream', { n: 1 }) },
    { offset: Math.round(durationMs * 0.74), stream: 'stdout', text: t('sim.logStream', { n: 2 }) },
    { offset: Math.round(durationMs * 0.88), stream: 'stdout', text: t('sim.logDone', { d: dur }) },
  ];
  return lines.map((line) => ({ at: at(line.offset), stream: line.stream, text: line.text, taskId }));
}

function startSimulation() {
  if (state.sim.running) return;
  syncDagFromDom();
  const steps = state.dagSteps.length ? cloneSteps(state.dagSteps) : defaultDagSteps();
  if (!steps.length) { toast(t('dag.tplNeedSteps'), 'warn'); return; }
  if (!state.dagSteps.length) { state.dagSteps = cloneSteps(steps); renderDagSteps(); }

  stopSimulation({ keep: true });
  state.sim.seq += 1;
  state.sim.batchId = t('sim.batch', { n: state.sim.seq });
  state.sim.startedAt = Date.now();
  state.sim.running = true;
  state.sim.steps = new Map();
  state.sim.logs = new Map();
  state.sim.plan = buildSimPlan(steps);

  const nowIso = new Date().toISOString();
  state.sim.tasks = [...state.sim.plan.values()].map((step) => ({
    task_id: step.taskId,
    batch_id: state.sim.batchId,
    parent_task_id: null,
    depends_on: step.deps.map((dep) => `${state.sim.batchId}-${dep}`),
    step_id: step.id,
    project_dir: DEMO_DIR,
    member: pickSimMember(steps.find((s) => s.id === step.id) || {}),
    role: step.role,
    channel: 'sim',
    title: `${step.id} · ${step.role}`,
    prompt: t('sim.prompt', { role: step.role }),
    state: 'dispatched',
    external_id: null,
    session_id: `sim-session-${step.id}`,
    reply_generation: 0,
    attempted_at: nowIso,
    result_text: null,
    error_code: null,
    error_message: null,
    meta: { step_id: step.id, simulated: true },
    created_at: nowIso,
    updated_at: nowIso,
    completed_at: null,
  }));

  state.dagBatch = state.sim.batchId;
  state.dagBatchTouched = true;
  const demoFixture = buildDemoFixture();
  state.tasks = [...state.sim.tasks, ...(demoFixture.tasks || [])];
  state.batches = [simBatchSummary(), ...(demoFixture.batches || [])];
  state.metrics = { ...(state.metrics || {}), tasks_total: state.tasks.length };

  renderDagBatchSelect();
  renderTasks();
  renderBatches();
  renderDagCanvas();
  toast(t('sim.started'), 'info', 2600);

  state.sim.timer = setInterval(simTick, 140);
}

function simTick() {
  if (!state.sim.running) return;
  const elapsed = Date.now() - state.sim.startedAt;
  let allDone = true;
  /* The tick fires at ~7 Hz. Rebuilding the SVG/task DOM on a tick that changed
   * nothing burned ~1 MB/s of layout work for a static picture; only a real
   * state transition is allowed to touch the DOM now. */
  let stateChanged = false;
  let logsAdded = false;
  for (const step of state.sim.plan.values()) {
    const nextState = elapsed < step.start ? 'dispatched' : (elapsed < step.end ? 'running' : 'completed');
    if (elapsed < step.end) allDone = false;
    if (nextState !== step.state) {
      step.state = nextState;
      stateChanged = true;
      const task = state.sim.tasks.find((item) => item.task_id === step.taskId);
      if (task) {
        task.state = nextState === 'dispatched' ? 'dispatched' : nextState;
        task.attempted_at = new Date(state.sim.startedAt + step.start).toISOString();
        task.updated_at = new Date().toISOString();
        if (nextState === 'completed') {
          task.completed_at = new Date(state.sim.startedAt + step.end).toISOString();
          task.result_text = t('sim.logDone', { d: ((step.end - step.start) / 1000).toFixed(1) });
        }
      }
    }
    const logs = state.sim.logs.get(step.taskId) || [];
    while (step.emitted < step.logs.length && step.logs[step.emitted].at <= elapsed) {
      const entry = step.logs[step.emitted];
      logs.push({ ts: new Date(state.sim.startedAt + entry.at).toISOString(), stream: entry.stream, text: entry.text });
      step.emitted += 1;
      logsAdded = true;
    }
    state.sim.logs.set(step.taskId, logs);
    state.sim.steps.set(step.id, {
      state: step.state,
      task_id: step.taskId,
      duration: step.state === 'completed' ? (step.end - step.start) / 1000 : 0,
    });
  }

  if (stateChanged) {
    renderDagCanvas();
    renderTasks();
    const batch = simBatchSummary();
    state.batches = [batch, ...state.batches.filter((b) => b.batch_id !== batch.batch_id)];
    renderBatches();
    renderDagBatchSelect();
  }
  if (logsAdded && state.taskLog.taskId) {
    const simLogs = state.sim.logs.get(state.taskLog.taskId);
    if (simLogs && simLogs.length > state.taskLog.entries.length) {
      appendTaskLog(state.taskLog.taskId, simLogs.slice(state.taskLog.entries.length));
    }
  }

  if (allDone) finishSimulation();
}

function finishSimulation() {
  clearInterval(state.sim.timer);
  state.sim.timer = null;
  state.sim.running = false;
  const nowIso = new Date().toISOString();
  for (const step of state.sim.steps.values()) {
    if (step.state !== 'completed') step.state = 'completed';
  }
  for (const task of state.sim.tasks) {
    if (task.state !== 'completed') {
      task.state = 'completed';
      task.completed_at = task.completed_at || nowIso;
      task.updated_at = nowIso;
    }
  }
  renderTasks();
  renderBatches();
  renderDagCanvas();
  renderDagBatchSelect();
  toast(t('sim.done'), 'success', 3200);
}

function stopSimulation({ keep = false } = {}) {
  clearInterval(state.sim.timer);
  state.sim.timer = null;
  const hadRun = state.sim.running || Boolean(state.sim.batchId);
  state.sim.running = false;
  if (keep || !hadRun) return;
  const batchId = state.sim.batchId;
  const simIds = new Set((state.sim.tasks || []).map((task) => task.task_id));
  state.sim.steps = new Map();
  state.sim.plan = new Map();
  state.sim.logs = new Map();
  state.sim.tasks = [];
  state.sim.batchId = null;
  state.tasks = state.tasks.filter((task) => !simIds.has(task.task_id));
  state.batches = state.batches.filter((batch) => batch.batch_id !== batchId);
  if (state.dagBatch === batchId) {
    state.dagBatch = null;
    state.dagBatchTouched = false;
  }
  renderTasks();
  renderBatches();
  renderOverviewRecent();
  renderDagBatchSelect();
  renderDagCanvas();
  if (state.drawer.kind === 'task' && simIds.has(state.drawer.key)) closeDrawer();
}

function simBatchSummary() {
  if (!state.sim.batchId) return null;
  const tasks = state.sim.tasks || [];
  const counts = {};
  for (const task of tasks) counts[task.state] = (counts[task.state] || 0) + 1;
  return {
    batch_id: state.sim.batchId,
    total: tasks.length,
    counts,
    all_terminal: tasks.every((task) => TERMINAL_STATES.includes(task.state)),
    all_succeeded: tasks.length > 0 && tasks.every((task) => task.state === 'completed'),
    has_stalled: false,
    has_failures: tasks.some((task) => ['failed', 'stalled', 'uncertain', 'cancelled'].includes(task.state)),
    latest_at: new Date().toISOString(),
  };
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
  if (state.demo) { toast(t('pb.demo'), 'warn'); return; }
  if (out) { out.hidden = false; out.textContent = t('pb.running'); }
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
    toast(t('pb.done'), 'success');
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
      showToolkitOutput(t('tk.astHits', { n: res.total_matches }), (res.matches || []).map((m) => `${m.file}:${m.line}  ${m.text}`).join('\n') || '(0 matches)');
    } else if (kind === 'pack') {
      const res = await apiPost('/api/toolkit/pack', {
        project_dir: $('#tkPackDir')?.value.trim(),
        include: $('#tkPackInc')?.value.trim() || null,
      });
      showToolkitOutput(t('tk.packDone', { n: res.approx_tokens }), res.content || '');
    } else if (kind === 'doc') {
      const res = await apiPost('/api/toolkit/doc2md', { file_path: $('#tkDocPath')?.value.trim() });
      showToolkitOutput(t('tk.docDone', { n: res.total_chars }), res.markdown || '');
    } else if (kind === 'beads') {
      const res = await apiPost('/api/toolkit/beads', {
        project_dir: $('#tkBdDir')?.value.trim(),
        action: $('#tkBdAction')?.value,
        title: $('#tkBdTitle')?.value.trim() || null,
      });
      showToolkitOutput(t('tk.beadsDone', { action: res.action }), JSON.stringify(res.data || res.output || res, null, 2));
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
    box.innerHTML = `<div class="note-empty">${esc(t('sess.demo'))}</div>`;
    return;
  }
  box.innerHTML = `<div class="meta">${esc(t('sess.searching'))}</div>`;
  try {
    const data = await apiGet(`/api/sessions?q=${encodeURIComponent(q)}`);
    if (!data.ok) {
      box.innerHTML = `<div class="meta">${esc(data.hint || data.error || t('sess.noMatch'))}</div>`;
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
      box.innerHTML = `<pre class="mono-pre">${esc(JSON.stringify(data.result || data.raw || t('sess.noMatch'), null, 2).slice(0, 1200))}</pre>`;
    }
  } catch (err) {
    box.innerHTML = `<div class="form-error">${esc(t('sess.fail', { error: err.message }))}</div>`;
  }
}

async function reindexCass() {
  if (state.demo) { toast(t('toast.demoReadonly'), 'warn'); return; }
  const btn = $('#btnReindexCass');
  const box = $('#sessList');
  if (btn) { btn.disabled = true; btn.textContent = t('sess.reindexing'); }
  try {
    const res = await apiPost('/api/sessions/reindex', {});
    const c = res.stats?.conversations;
    const m = res.stats?.messages;
    if (box) {
      const counts = c ? t('sess.reindexedCounts', { c, m }) : '';
      const partial = res.partial ? t('sess.reindexedPartial') : '';
      box.innerHTML = `<div class="meta">${esc(t('sess.reindexedDetail', { c: counts, p: partial }))}</div>`;
    }
    toast(t('sess.reindexed'), 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    if (box) box.textContent = t('sess.reindexFail', { error: err.message });
    toast(t('sess.reindexFail', { error: err.message }), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('sess.reindex'); }
  }
}

/* ------------------------------------------------------------------ */
/* Worktrees + colorized diff                                          */
/* ------------------------------------------------------------------ */

function renderWorktrees() {
  const box = $('#wtList');
  if (!box) return;
  const count = $('#wtCount');
  if (count) count.textContent = `${state.worktrees.length}`;
  if (!state.worktrees.length) {
    box.innerHTML = `<div class="wt-empty">${esc(t('wt.empty'))}</div>`;
    return;
  }
  box.innerHTML = state.worktrees.map((w) => {
    const active = w.state === 'active';
    const verify = w.verify_status
      ? `<span class="badge st-${w.verify_status === 'passed' ? 'pass' : 'fail'}">${esc(t('wt.verify', { status: w.verify_status }))}</span>`
      : `<span class="pill">${esc(t('wt.notVerified'))}</span>`;
    const actions = active ? `<div class="wt-actions">
      <button type="button" class="btn ghost sm" data-wt-review="${esc(w.task_id)}">${esc(t('wt.review'))}</button>
      ${state.demo ? '' : `<button type="button" class="btn danger sm" data-wt-cleanup="${esc(w.task_id)}">${esc(t('wt.cleanup'))}</button>`}
    </div>` : '';
    return `<article class="wt-card">
      <div class="wt-top"><span class="wt-branch" title="${esc(w.branch_name)}">${esc(w.branch_name)}</span>${badge(w.state)}</div>
      <div class="wt-meta">
        <span>${esc(t('wt.member', { member: w.member, base: w.base_ref || 'main' }))}</span>
        <span>${esc(t('wt.path', { path: w.worktree_path }))}<code title="${esc(w.worktree_path)}">${esc(w.worktree_path)}</code></span>
        <span>${esc(t('wt.updated', { time: fmtDate(w.updated_at || w.created_at) }))}</span>
      </div>
      <div class="wt-verify">${verify}</div>
      ${actions}
    </article>`;
  }).join('');
}

function diffLineClass(line) {
  if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file') || line.startsWith('deleted file') || line.startsWith('similarity')) return 'diff-file';
  if (line.startsWith('@@')) return 'diff-hunk';
  if (line.startsWith('+++') || line.startsWith('---')) return 'diff-file';
  if (line.startsWith('+')) return 'diff-add';
  if (line.startsWith('-')) return 'diff-del';
  return 'diff-ctx';
}

/* Build the diff out of DOM nodes only — untrusted text never reaches innerHTML. */
function mountDiff(container, text) {
  if (!container) return;
  container.textContent = '';
  const raw = String(text || '');
  const lines = raw.split('\n');
  if (!raw.trim()) {
    const empty = document.createElement('div');
    empty.className = 'diff-line diff-ctx';
    empty.textContent = t('wt.noDiff');
    container.append(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const row = document.createElement('div');
    row.className = `diff-line ${diffLineClass(line)}`;
    row.textContent = line === '' ? ' ' : line;
    frag.append(row);
  }
  container.append(frag);
}

function demoWorktreeReview(w) {
  const commits = [
    `a1b2c3d ${t('demo.commit1')}`,
    `e4f5a6b ${t('demo.commit2')}`,
    `c7d8e9f ${t('demo.commit3')}`,
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
      if (!wt) { toast(t('wt.missing'), 'warn'); return; }
      rev = demoWorktreeReview(wt);
    } else {
      rev = await apiPost('/api/worktrees/review', { task_id: taskId });
    }
    const demoNote = state.demo ? `<div class="meta demo-note">${esc(t('wt.demoNote'))}</div>` : '';
    const actions = state.demo ? '' : `<div class="drawer-actions">
      <button type="button" class="btn primary sm" data-wt-verify="${esc(rev.task_id)}">${esc(t('wt.runVerify'))}</button>
      <button type="button" class="btn success sm" data-wt-merge="${esc(rev.task_id)}">${esc(t('wt.merge', { base: rev.base_ref || 'main' }))}</button>
      <button type="button" class="btn danger sm" data-wt-cleanup="${esc(rev.task_id)}">${esc(t('wt.abandon'))}</button>
    </div>`;
    openDrawer(`
      <div class="drawer-head">
        <div>
          <div class="drawer-title">${esc(t('wt.reviewTitle', { branch: rev.branch_name }))}</div>
          <div class="drawer-meta"><span>${esc(t('wt.metaTask'))} <code>${esc(rev.task_id)}</code></span><span>${esc(t('wt.metaBase'))} <code>${esc(rev.base_ref || 'main')}</code></span><span>${esc(t('wt.metaHead'))} <code>${esc(String(rev.reviewed_head_sha || '').slice(0, 12) || '—')}</code></span><span>${esc(t('wt.metaDirty'))} ${esc(rev.dirty ? t('wt.dirtyYes') : t('wt.dirtyNo'))}</span>${rev.verify_status ? `<span>${badge(rev.verify_status === 'passed' ? 'pass' : 'fail')}</span>` : ''}</div>
        </div>
        <button type="button" class="icon-btn" data-close-drawer="1" aria-label="${esc(t('common.close'))}">×</button>
      </div>
      ${demoNote}
      ${actions}
      <div class="form-error" id="wtMergeMsg"></div>
      <pre class="mono-pre" id="wtVerifyOut" hidden></pre>
      <div class="drawer-section"><h3>${esc(t('wt.commits', { n: (rev.commits || []).length }))}</h3><pre class="mono-pre">${esc((rev.commits || []).join('\n') || t('wt.noCommits'))}</pre></div>
      <div class="drawer-section"><h3>${esc(t('wt.diff'))}</h3><div class="diff-view" id="wtDiff" role="region" aria-label="${esc(t('wt.diff'))}"></div></div>`, { kind: 'worktree', key: taskId });
    mountDiff($('#wtDiff'), rev.diff_preview);
  } catch (err) {
    toast(t('wt.reviewFail', { error: err.message }), 'error');
  }
}

async function verifyWorktree(taskId, button) {
  if (state.demo) { toast(t('wt.demoReadonly'), 'warn'); return; }
  const out = $('#wtVerifyOut');
  const original = button?.textContent || t('wt.runVerify');
  if (button) { button.disabled = true; button.textContent = t('wt.verifying'); }
  if (out) { out.hidden = false; out.textContent = '…'; }
  try {
    const res = await apiPost('/api/worktrees/verify', { task_id: taskId, preset: 'auto' });
    if (out) out.textContent = `${t('wt.verifyHeader', { preset: res.preset, status: String(res.status).toUpperCase(), ms: res.duration_ms })}\n${res.output || t('wt.noOutput')}`;
    toast(res.status === 'passed' ? t('wt.verifyPass') : t('wt.verifyFail', { code: res.exit_code }), res.status === 'passed' ? 'success' : 'error');
    await loadOverview({ quiet: true });
  } catch (err) {
    if (out) out.textContent = t('wt.verifyFailShort', { error: err.message });
    toast(t('wt.verifyFailShort', { error: err.message }), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function mergeWorktree(taskId) {
  if (state.demo) { toast(t('wt.demoReadonly'), 'warn'); return; }
  try {
    await apiPost('/api/worktrees/merge', { task_id: taskId, confirmed: true, cleanup: true });
    closeDrawer();
    toast(t('wt.merged'), 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    const msg = $('#wtMergeMsg');
    if (msg) msg.textContent = t('wt.mergeFail', { error: err.message });
    toast(t('wt.mergeFail', { error: err.message }), 'error');
  }
}

async function cleanupWorktree(taskId) {
  if (state.demo) { toast(t('wt.demoReadonly'), 'warn'); return; }
  try {
    await apiPost('/api/worktrees/cleanup', { task_id: taskId, force: false, delete_branch: false });
    closeDrawer();
    toast(t('wt.cleaned'), 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(t('wt.cleanupFail', { error: err.message }), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Events / doctor / health                                            */
/* ------------------------------------------------------------------ */

function renderEvents() {
  const box = $('#eventsList');
  if (!box) return;
  if (!state.events.length) { box.innerHTML = `<div class="mini-empty">${esc(t('ops.doctor.empty'))}</div>`; return; }
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
    if (!quiet) toast(t('ops.events.fail', { error: err.message }), 'error');
  }
}

function renderDoctor(doc, demo = false) {
  const box = $('#doctorBox');
  if (!box) return;
  const checks = doc?.checks || [];
  const passCount = doc?.pass_count ?? checks.filter((c) => c.status === 'pass').length;
  const total = doc?.total_checks ?? checks.length;
  const overall = doc?.overall || 'unknown';
  box.innerHTML = `
    <div class="doctor-check doctor-overall">
      <div class="doctor-head"><span class="doctor-id">system.overall</span>${badge(overall === 'pass' ? 'pass' : (overall === 'fail' ? 'fail' : 'warn'))}</div>
      <div class="doctor-detail">${esc(t('ops.doctor.overall', { pass: passCount, total }))}${demo ? esc(t('ops.doctor.demo')) : ''}</div>
    </div>
    ${checks.map((c) => `
      <div class="doctor-check">
        <div class="doctor-head"><span class="doctor-id">${esc(c.id)}</span>${badge(c.status)}</div>
        <div class="doctor-detail">${esc(c.detail || '')}</div>
      </div>`).join('')}`;
}

async function loadDoctor(force = false) {
  if (state.demo) {
    state.doctor = demoDoctor();
    renderDoctor(state.doctor, true);
    state.flags.doctorLoaded = true;
    return;
  }
  if (state.flags.doctorLoaded && !force) return;
  const btn = $('#btnRefreshDoctor');
  const box = $('#doctorBox');
  if (box) box.innerHTML = `<div class="doctor-empty">${esc(t('ops.doctor.running'))}</div>`;
  if (btn) { btn.disabled = true; btn.textContent = t('ops.doctor.backingUp'); }
  try {
    const doc = await apiGet('/api/doctor');
    state.doctor = doc;
    renderDoctor(doc);
    state.flags.doctorLoaded = true;
  } catch (err) {
    if (box) box.innerHTML = `<div class="form-error">${esc(t('ops.doctor.fail', { error: err.message }))}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('ops.doctor.refresh'); }
  }
}

async function loadHealth() {
  if (state.demo) {
    state.health = { ok: true, version: '1.2.0', pid: 'demo', uptime_s: 3 * 86400 + 4 * 3600, mail_hub: { ok: true, version: '1.4.2' }, toolkit: state.toolkit || {} };
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
  const mode = state.static ? t('health.modeStatic') : (state.demo ? t('health.modeDemo') : t('health.modeLive'));
  const items = [
    { label: t('health.version'), value: h.version || '—' },
    { label: t('health.uptime'), value: fmtUptime(h.uptime_s) },
    { label: t('health.pid'), value: h.pid ?? '—' },
    { label: t('health.mail'), value: h.mail_hub?.ok ? `v${h.mail_hub.version || '?'}` : t('health.offline') },
    { label: t('health.toolkit'), value: t('health.installed', { n: installed }) },
    { label: t('health.mode'), value: mode },
  ];
  box.innerHTML = items.map((it) => `<div class="health-item"><div class="health-label">${esc(it.label)}</div><div class="health-value" title="${esc(it.value)}">${esc(it.value)}</div></div>`).join('');
}

async function hotBackup() {
  if (state.demo) { toast(t('ops.backup.demo'), 'warn'); return; }
  const msg = $('#backupMsg');
  if (msg) { msg.className = 'backup-msg meta'; msg.textContent = t('ops.backup.running'); }
  try {
    const res = await apiPost('/api/system/backup', {});
    if (msg) {
      msg.className = 'backup-msg meta ok';
      msg.textContent = t('ops.backup.ok', { path: res.backup_path, kb: Math.round((res.size_bytes || 0) / 1024), retained: res.retained });
    }
    toast(t('ops.backup.done'), 'success');
  } catch (err) {
    if (msg) { msg.className = 'backup-msg meta err'; msg.textContent = t('ops.backup.fail', { error: err.message }); }
    toast(t('ops.backup.fail', { error: err.message }), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Self-improvement & auto-heal (v1.4)                                 */
/* ------------------------------------------------------------------ */

/* The gauge is one SVG circle: circumference drives both the empty track and
 * the animated offset, so a score change is a single style write, not a reflow. */
const SELF_RING_C = 2 * Math.PI * 52;
const SELF_SEV_ORDER = { high: 0, medium: 1, low: 2, info: 3 };
let selfRefreshTimer = null;

function clampSelfScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function selfToneOf(overall, score) {
  if (overall === 'healthy' || overall === 'degraded' || overall === 'unhealthy') return overall;
  const s = clampSelfScore(score);
  if (s == null) return 'degraded';
  if (s >= 90) return 'healthy';
  return s >= 70 ? 'degraded' : 'unhealthy';
}

function selfOverallLabel(tone) {
  if (tone === 'healthy') return t('self.statusHealthy');
  if (tone === 'unhealthy') return t('self.statusUnhealthy');
  return t('self.statusDegraded');
}

function setSelfText(selector, value) {
  const el = $(selector);
  if (el) el.textContent = value;
}

function setSelfGauge(score) {
  const s = clampSelfScore(score);
  setSelfText('#selfScore', s == null ? '—' : String(s));
  const fill = $('#selfGaugeFill');
  if (!fill) return;
  fill.style.strokeDasharray = String(SELF_RING_C);
  fill.style.strokeDashoffset = String(SELF_RING_C * (1 - (s == null ? 0 : s) / 100));
}

function animateSelfScore(from, to) {
  const target = clampSelfScore(to);
  if (target == null) return;
  const start = clampSelfScore(from);
  if (state.selfAnim) { cancelAnimationFrame(state.selfAnim); state.selfAnim = null; }
  if (start == null || start === target) { setSelfGauge(target); return; }
  let reduced = false;
  try { reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { reduced = false; }
  if (reduced || typeof requestAnimationFrame !== 'function') { setSelfGauge(target); return; }
  const startedAt = performance.now();
  const duration = 900;
  const step = (now) => {
    const p = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - Math.pow(1 - p, 3);
    setSelfGauge(start + (target - start) * eased);
    if (p < 1) state.selfAnim = requestAnimationFrame(step);
    else state.selfAnim = null;
  };
  state.selfAnim = requestAnimationFrame(step);
}

function lastSelfHealAt() {
  if (state.selfImprove && state.selfImprove.last_heal_at) return state.selfImprove.last_heal_at;
  const applied = state.selfRuns
    .filter((run) => run && run.mode === 'apply' && run.created_at)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return applied.length ? applied[0].created_at : null;
}

/* Overview chip: score + guardrail count, one click into #system. */
function renderSelfStrip() {
  const box = $('#selfStrip');
  if (!box) return;
  const si = state.selfImprove;
  const score = si ? clampSelfScore(si.health_score) : null;
  if (score == null) {
    box.hidden = true;
    if (box.innerHTML) box.innerHTML = '';
    return;
  }
  const tone = selfToneOf(si.overall, score);
  const findings = Number(si.findings_count || 0);
  const lessons = Number(si.active_lessons || 0);
  const aria = t('self.pillAria', { score, overall: selfOverallLabel(tone) });
  box.hidden = false;
  box.innerHTML = `
    <button type="button" class="self-pill ${esc(tone)}" data-goto-view="system" aria-label="${esc(aria)}" title="${esc(aria)}">
      <span class="self-pill-dot" aria-hidden="true"></span>
      <span class="self-pill-score">${esc(String(score))}</span><span class="self-pill-den">${esc(t('self.of100'))}</span>
      <span class="self-pill-label">${esc(t('self.pillLabel'))}</span>
      <span class="self-pill-meta">${esc(t('self.pillMeta', { findings, lessons }))}</span>
      <span class="self-pill-arrow" aria-hidden="true">→</span>
    </button>`;
}

/* Full console: gauge, findings, learned guardrails, audit trail. */
function renderSelfPanel() {
  const panel = $('#selfPanel');
  if (!panel) return;
  const hasData = Boolean(state.selfCheck || state.selfImprove);
  const score = state.selfScore != null ? state.selfScore : (state.selfImprove ? state.selfImprove.health_score : null);
  const overall = state.selfOverall || (state.selfImprove ? state.selfImprove.overall : null);
  const tone = selfToneOf(overall, score);

  const gauge = $('#selfGauge');
  if (gauge) gauge.className = `self-gauge ${hasData ? tone : ''}`.trim();
  setSelfGauge(hasData ? score : null);

  const status = $('#selfOverall');
  if (status) {
    status.className = hasData ? `self-status ${tone}` : 'self-status';
    status.textContent = hasData ? selfOverallLabel(tone) : t('self.statusIdle');
  }
  setSelfText('#selfCheckedAt', state.selfCheckedAt ? t('self.checkedAt', { time: fmtTimeShort(state.selfCheckedAt) }) : '');

  const summary = $('#selfSummary');
  if (summary) {
    const c = state.selfCheck || {};
    const text = c.summaryKey ? t(c.summaryKey, c.summaryVars || {}) : (c.summary || '');
    summary.textContent = text || (state.selfFindings.length ? t('self.summaryIdle') : t('self.summaryNone'));
  }

  const findings = Array.isArray(state.selfFindings) ? state.selfFindings : [];
  const lessons = Array.isArray(state.selfLessons) ? state.selfLessons : [];
  const healable = findings.filter((f) => f && f.auto_healable).length;
  const activeLessons = lessons.filter((l) => l && l.active).length;
  const lastHeal = lastSelfHealAt();
  setSelfText('#selfStatFindings', String(findings.length));
  setSelfText('#selfStatHealable', String(healable));
  setSelfText('#selfStatLessons', String(activeLessons));
  setSelfText('#selfStatLastHeal', lastHeal ? fmtTimeShort(lastHeal) : t('self.lastHealNever'));

  renderSelfFindings();
  renderSelfLessons();
  renderSelfRuns();
  renderSelfPreview();
}

function renderSelfPreview() {
  const box = $('#selfPreview');
  if (!box) return;
  const p = state.selfPreview;
  if (!p) {
    box.hidden = true;
    if (box.innerHTML) box.innerHTML = '';
    return;
  }
  const actions = Array.isArray(p.actions_taken) ? p.actions_taken : [];
  const head = p.applied ? t('self.previewApplied') : t('self.previewTitle');
  const delta = t('self.previewDelta', { before: p.before_score ?? '—', after: p.after_score ?? '—' });
  const rows = actions.map((a) => `
    <div class="self-preview-row">
      <code>${esc(a.actionKey ? t(a.actionKey) : (a.action || ''))}</code>
      <span class="meta">${esc(t('self.previewCount', { n: a.count ?? 0 }))}</span>
      <span>${esc(a.detail || '')}</span>
    </div>`).join('');
  box.hidden = false;
  box.innerHTML = `<div class="self-preview-head">${esc(head)} · ${esc(delta)}</div>${rows || `<div class="self-preview-row"><span class="meta">${esc(t('self.previewEmpty'))}</span></div>`}`;
}

function selfFindingCard(finding) {
  const f = finding || {};
  const sev = Object.prototype.hasOwnProperty.call(SELF_SEV_ORDER, f.severity) ? f.severity : 'info';
  /* Demo fixtures carry i18n keys so a language switch re-localizes them
   * in place; live API payloads carry plain strings. */
  const title = f.titleKey ? t(f.titleKey) : (f.title || '');
  const detail = f.detailKey ? t(f.detailKey) : (f.detail || '');
  const action = f.actionKey ? t(f.actionKey) : (f.recommended_action || '');
  return `
    <article class="find-card ${esc(sev)}" data-finding-id="${esc(f.id || '')}">
      <div class="find-top">
        <span class="sev-pill">${esc(t(`self.sev.${sev}`))}</span>
        <span class="find-cat">${esc(f.category || '')}</span>
        <span class="find-title">${esc(title)}</span>
      </div>
      ${detail ? `<p class="find-detail">${esc(detail)}</p>` : ''}
      <div class="find-foot">
        <span class="heal-badge ${f.auto_healable ? 'auto' : 'manual'}">${esc(t(f.auto_healable ? 'self.healAuto' : 'self.healManual'))}</span>
        ${action ? `<span class="find-action">${esc(t('self.actionLabel'))}: <strong>${esc(action)}</strong></span>` : ''}
      </div>
    </article>`;
}

function renderSelfFindings() {
  const box = $('#selfFindings');
  if (!box) return;
  const findings = (Array.isArray(state.selfFindings) ? state.selfFindings : [])
    .slice()
    .sort((a, b) => (SELF_SEV_ORDER[a && a.severity] ?? 9) - (SELF_SEV_ORDER[b && b.severity] ?? 9));
  setSelfText('#selfFindingCount', String(findings.length));
  box.innerHTML = findings.length
    ? findings.map(selfFindingCard).join('')
    : `<div class="self-empty">${esc(t('self.findingsEmpty'))}</div>`;
}

function selfLessonRow(lesson) {
  const l = lesson || {};
  const active = Boolean(l.active);
  const id = esc(l.id || '');
  const guardrail = l.guardrailKey ? t(l.guardrailKey) : (l.guardrail || '');
  return `
    <article class="lesson-row${active ? '' : ' paused'}" data-lesson-id="${id}">
      <div class="lesson-top">
        <div class="lesson-key">
          <code>${esc(l.member || '—')}</code>
          <span>${esc(l.role || '—')}</span>
          <code>${esc(l.error_code || '—')}</code>
          ${l.auto_learned ? `<span class="lesson-src">${esc(t('self.autoLearned'))}</span>` : ''}
        </div>
        <button type="button" class="lesson-toggle ${active ? 'on' : 'off'}" data-lesson-toggle="${id}" data-lesson-active="${active ? '1' : '0'}" aria-pressed="${active ? 'true' : 'false'}" title="${esc(t('self.lessonHint'))}">${esc(active ? t('self.lessonActive') : t('self.lessonPaused'))}</button>
      </div>
      <p class="lesson-guardrail">${esc(guardrail)}</p>
      <div class="lesson-meta">
        <span>${esc(l.project || '—')}</span>
        <span class="lesson-hit">${esc(t('self.hits', { n: Number(l.hits || 0) }))}</span>
        ${l.pattern ? `<span>${esc(l.pattern)}</span>` : ''}
        <span>${esc(fmtTimeShort(l.updated_at))}</span>
      </div>
    </article>`;
}

function renderSelfLessons() {
  const box = $('#lessonList');
  if (!box) return;
  const lessons = (Array.isArray(state.selfLessons) ? state.selfLessons : []).slice()
    .sort((a, b) => Number(Boolean(b && b.active)) - Number(Boolean(a && a.active))
      || Number((b && b.hits) || 0) - Number((a && a.hits) || 0));
  setSelfText('#selfLessonCount', String(lessons.length));
  box.innerHTML = lessons.length
    ? lessons.map(selfLessonRow).join('')
    : `<div class="self-empty">${esc(t('self.lessonsEmpty'))}</div>`;
}

function selfRunRow(run) {
  const r = run || {};
  const isApply = r.mode === 'apply';
  const actions = Array.isArray(r.actions) ? r.actions : [];
  const actionText = actions.map((a) => `${a.actionKey ? t(a.actionKey) : (a.action || '')} ×${a.count ?? 0}`).join(' · ');
  const summary = r.summaryKey ? t(r.summaryKey) : (r.summary || '');
  return `
    <article class="self-run">
      <div class="self-run-top">
        <span class="self-run-mode ${isApply ? 'apply' : 'dry'}">${esc(isApply ? t('self.modeApply') : t('self.modeDry'))}</span>
        <span class="self-run-score">${esc(String(r.before_score ?? '—'))}</span>
        <span class="self-run-arrow" aria-hidden="true">→</span>
        <span class="self-run-score">${esc(String(r.after_score ?? '—'))}</span>
        <span class="self-run-meta">${esc(t('self.runHealed', { n: Number(r.healed_count || 0) }))} · ${esc(t('self.runFindings', { n: Number(r.findings_count || 0) }))}</span>
        <span class="self-run-time">${esc(fmtTimeShort(r.created_at))}</span>
      </div>
      ${actionText || summary ? `<div class="self-run-actions">${esc(actionText || summary)}</div>` : ''}
    </article>`;
}

function renderSelfRuns() {
  const box = $('#selfRuns');
  if (!box) return;
  const runs = (Array.isArray(state.selfRuns) ? state.selfRuns : []).slice()
    .sort((a, b) => String((b && b.created_at) || '').localeCompare(String((a && a.created_at) || '')));
  box.innerHTML = runs.length
    ? runs.map(selfRunRow).join('')
    : `<div class="self-empty">${esc(t('self.runsEmpty'))}</div>`;
}

/* ------------------------------- demo world ------------------------- */

/* One mutable in-memory world so toggles and heals survive re-renders without
 * a single /api call. Reset on language switch so the fixture is bilingual. */
function demoSelfWorld() {
  if (state.selfDemo) return state.selfDemo;
  const at = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString();
  /* Fixture copy is stored as i18n keys (not rendered strings) so flipping the
   * language re-localizes the demo in place instead of resetting a healed world. */
  state.selfDemo = {
    checked_at: new Date().toISOString(),
    health_score: 84,
    overall: 'degraded',
    summaryKey: 'self.demo.summary',
    summaryVars: { findings: 4, healable: 2 },
    findings: [
      { id: 'find-401', severity: 'high', category: 'runtime', titleKey: 'self.demo.f1.title', detailKey: 'self.demo.f1.detail', actionKey: 'self.demo.f1.action', auto_healable: true, target_ids: ['demo-stall-01'] },
      { id: 'find-402', severity: 'medium', category: 'worktree', titleKey: 'self.demo.f2.title', detailKey: 'self.demo.f2.detail', actionKey: 'self.demo.f2.action', auto_healable: true, target_ids: ['demo-run-01'] },
      { id: 'find-403', severity: 'medium', category: 'database', titleKey: 'self.demo.f3.title', detailKey: 'self.demo.f3.detail', actionKey: 'self.demo.f3.action', auto_healable: false },
      { id: 'find-404', severity: 'low', category: 'config', titleKey: 'self.demo.f4.title', detailKey: 'self.demo.f4.detail', actionKey: 'self.demo.f4.action', auto_healable: false },
    ],
    lessons: [
      { id: 'lesson-201', project: 'collab-hub', member: 'delta', role: 'tester', error_code: 'harness_down', pattern: 'heartbeat timeout > 180s', guardrailKey: 'self.demo.l1.guardrail', hits: 7, active: true, auto_learned: true, updated_at: at(6 * 60) },
      { id: 'lesson-202', project: 'collab-hub', member: 'cipher', role: 'reviewer', error_code: 'receipt_missing', pattern: 'no receipt within 2 polls', guardrailKey: 'self.demo.l2.guardrail', hits: 3, active: true, auto_learned: true, updated_at: at(20 * 60) },
      { id: 'lesson-203', project: 'collab-hub', member: 'beacon', role: 'implementer', error_code: 'scope_rejected', pattern: 'diff outside declared scope', guardrailKey: 'self.demo.l3.guardrail', hits: 1, active: false, auto_learned: false, updated_at: at(44 * 60) },
    ],
    recent_runs: [
      { id: 12, mode: 'apply', before_score: 79, after_score: 88, healed_count: 2, findings_count: 5, summaryKey: 'self.demo.run1.summary', actions: [{ actionKey: 'self.demo.action1', count: 1, detail: 'delta' }, { actionKey: 'self.demo.action2', count: 1, detail: 'collab/demo/verify-gate' }], created_at: at(26 * 60) },
      { id: 11, mode: 'dry_run', before_score: 88, after_score: 88, healed_count: 0, findings_count: 4, summaryKey: 'self.demo.run2.summary', actions: [{ actionKey: 'self.demo.action1', count: 1, detail: 'delta' }], created_at: at(31 * 60) },
    ],
    seq: 12,
  };
  return state.selfDemo;
}

function demoToggleLesson(id, active) {
  const world = demoSelfWorld();
  const lesson = world.lessons.find((l) => String(l.id) === String(id));
  if (!lesson) throw new Error('lesson not found');
  lesson.active = Boolean(active);
  lesson.updated_at = new Date().toISOString();
  return { lesson };
}

function demoAddLesson(payload) {
  const world = demoSelfWorld();
  world.seq += 1;
  const lesson = {
    id: `demo-lesson-${world.seq}`, project: payload.project, member: payload.member,
    role: payload.role, error_code: payload.error_code, pattern: payload.pattern,
    guardrail: payload.guardrail, hits: 0, active: true, auto_learned: false,
    updated_at: new Date().toISOString(),
  };
  world.lessons = [lesson, ...world.lessons];
  return { lesson };
}

function demoSelfHeal(apply) {
  const world = demoSelfWorld();
  const before = clampSelfScore(world.health_score) ?? 0;
  const healable = world.findings.filter((f) => f && f.auto_healable);
  const actions = healable.map((f) => ({
    action: f.recommended_action || (f.actionKey ? t(f.actionKey) : 'auto_heal'),
    actionKey: f.actionKey || null,
    count: 1,
    detail: f.titleKey ? t(f.titleKey) : (f.title || ''),
  }));
  const projected = healable.length ? Math.min(100, before + 14 * (healable.length / 2)) : before;
  if (!apply) {
    return {
      ok: true, applied: false, before_score: before, after_score: projected,
      actions_taken: actions, remaining_findings: world.findings.slice(),
      recorded_lessons: 0, run_id: world.seq + 1,
    };
  }
  world.seq += 1;
  const run = {
    id: world.seq, mode: 'apply', before_score: before, after_score: projected,
    healed_count: healable.length, findings_count: world.findings.length - healable.length,
    summaryKey: 'self.demo.runNew', actions, created_at: new Date().toISOString(),
  };
  world.findings = world.findings.filter((f) => !(f && f.auto_healable));
  world.health_score = projected;
  world.overall = projected >= 90 ? 'healthy' : (projected >= 70 ? 'degraded' : 'unhealthy');
  world.summaryKey = 'self.demo.summaryHealed';
  world.summaryVars = { before, after: projected, remaining: world.findings.length };
  delete world.summary;
  world.recent_runs = [run, ...world.recent_runs].slice(0, 8);
  world.lessons = [{
    id: `demo-lesson-${world.seq}`, project: 'collab-hub', member: 'delta', role: 'tester',
    error_code: 'orphan_task', pattern: t('self.demo.lessonNew.pattern'),
    guardrailKey: 'self.demo.lessonNew.guardrail', hits: 1, active: true,
    auto_learned: true, updated_at: new Date().toISOString(),
  }, ...world.lessons];
  return {
    ok: true, applied: true, before_score: before, after_score: projected,
    actions_taken: actions, remaining_findings: world.findings.slice(),
    recorded_lessons: 1, run_id: run.id,
  };
}

/* ------------------------------- loading ---------------------------- */

function applySelfCheck(data) {
  const d = data || {};
  state.selfCheck = d;
  state.selfFindings = Array.isArray(d.findings) ? d.findings : [];
  state.selfLessons = Array.isArray(d.lessons) ? d.lessons : [];
  state.selfRuns = Array.isArray(d.recent_runs) ? d.recent_runs : [];
  state.selfScore = clampSelfScore(d.health_score);
  state.selfOverall = d.overall || null;
  state.selfCheckedAt = d.checked_at || null;
  const applied = state.selfRuns.filter((r) => r && r.mode === 'apply' && r.created_at)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  state.selfImprove = {
    health_score: state.selfScore == null ? 0 : state.selfScore,
    overall: state.selfOverall || 'degraded',
    findings_count: state.selfFindings.length,
    healable_count: state.selfFindings.filter((f) => f && f.auto_healable).length,
    active_lessons: state.selfLessons.filter((l) => l && l.active).length,
    last_heal_at: applied.length ? applied[0].created_at : (state.selfImprove ? state.selfImprove.last_heal_at : null),
  };
  state.flags.selfLoaded = true;
  renderSelfPanel();
  renderSelfStrip();
}

async function loadSelfCheck({ quiet = false } = {}) {
  if (state.selfBusy) return;
  if (state.demo) { applySelfCheck(demoSelfWorld()); return; }
  try {
    const data = await apiGet('/api/system/self-check');
    applySelfCheck(data);
  } catch (err) {
    if (!quiet) toast(t('self.toastCheckFail', { error: err.message }), 'error');
    else renderSelfPanel();
  }
}

function setSelfBusy(mode) {
  state.selfBusy = mode || '';
  const busy = Boolean(state.selfBusy);
  for (const id of ['#btnSelfCheck', '#btnSelfDry', '#btnSelfApply']) {
    const btn = $(id);
    if (btn) btn.disabled = busy;
  }
  const panel = $('#selfPanel');
  if (panel) panel.setAttribute('aria-busy', busy ? 'true' : 'false');
}

function scheduleSelfRefresh(delay = 1100) {
  if (state.demo) return;
  clearTimeout(selfRefreshTimer);
  selfRefreshTimer = setTimeout(() => {
    selfRefreshTimer = null;
    loadSelfCheck({ quiet: true });
  }, delay);
}

/* ------------------------------- actions ---------------------------- */

async function runSelfCheck({ quiet = false } = {}) {
  if (state.selfBusy) return;
  setSelfBusy('check');
  state.selfPreview = null;
  try {
    if (state.demo) {
      /* Re-diagnosis must not undo a demo heal that is already in memory. */
      applySelfCheck(demoSelfWorld());
      if (!quiet) toast(t('self.toastCheckDemo'), 'info', 3000);
    } else {
      const data = await apiGet('/api/system/self-check');
      applySelfCheck(data);
      if (!quiet) toast(t('self.toastCheckOk', { score: data.health_score ?? '—' }), 'success');
    }
  } catch (err) {
    toast(t('self.toastCheckFail', { error: err.message }), 'error');
  } finally {
    setSelfBusy('');
  }
}

async function previewSelfHeal() {
  if (state.selfBusy) return;
  setSelfBusy('dry');
  try {
    const res = state.demo
      ? demoSelfHeal(false)
      : await apiPost('/api/system/self-heal', { apply: false });
    state.selfPreview = res;
    renderSelfPreview();
    const n = Array.isArray(res.actions_taken) ? res.actions_taken.length : 0;
    if (!n) toast(t('self.toastNoHealable'), 'warn');
    else toast(t(state.demo ? 'self.toastDryDemo' : 'self.toastDryOk', { n }), 'info', 4200);
    if (!state.demo) scheduleSelfRefresh(700);
  } catch (err) {
    toast(t('self.toastDryFail', { error: err.message }), 'error');
  } finally {
    setSelfBusy('');
  }
}

async function applySelfHeal() {
  if (state.selfBusy) return;
  if (state.demo && !demoSelfWorld().findings.some((f) => f && f.auto_healable)) {
    toast(t('self.toastNoHealable'), 'warn');
    return;
  }
  setSelfBusy('apply');
  try {
    const res = state.demo
      ? demoSelfHeal(true)
      : await apiPost('/api/system/self-heal', { apply: true, record_lessons: true });
    const before = clampSelfScore(res.before_score);
    const after = clampSelfScore(res.after_score);
    const healed = Number(res.healed_count ?? (Array.isArray(res.actions_taken) ? res.actions_taken.length : 0));
    state.selfPreview = null;
    renderSelfPreview();
    if (after != null) {
      state.selfScore = after;
      state.selfOverall = after >= 90 ? 'healthy' : (after >= 70 ? 'degraded' : 'unhealthy');
      animateSelfScore(before == null ? after : before, after);
      setSelfText('#selfStatFindings', String(Array.isArray(res.remaining_findings) ? res.remaining_findings.length : state.selfFindings.length));
    }
    if (state.demo) {
      applySelfCheck(demoSelfWorld());
      toast(t('self.toastApplyDemo', { before: res.before_score ?? before, after: res.after_score ?? after }), 'success', 5200);
    } else {
      toast(t('self.toastApplyOk', { healed, before: res.before_score ?? before, after: res.after_score ?? after }), 'success', 5200);
      scheduleSelfRefresh(1300);
    }
  } catch (err) {
    toast(t('self.toastApplyFail', { error: err.message }), 'error');
  } finally {
    setSelfBusy('');
  }
}

async function toggleSelfLesson(id, nextActive) {
  if (!id || state.selfBusy) return;
  const active = Boolean(nextActive);
  try {
    const res = state.demo
      ? demoToggleLesson(id, active)
      : await apiPost('/api/lessons/toggle', { id, active });
    const lesson = res && res.lesson ? res.lesson : null;
    if (lesson) {
      const idx = state.selfLessons.findIndex((l) => String(l.id) === String(lesson.id));
      if (idx >= 0) state.selfLessons.splice(idx, 1, lesson);
      else state.selfLessons.unshift(lesson);
    } else {
      const local = state.selfLessons.find((l) => String(l.id) === String(id));
      if (local) local.active = active;
    }
    const stateLabel = active ? t('self.active') : t('self.paused');
    toast(t(state.demo ? 'self.toastToggleDemo' : 'self.toastToggleOk', { state: stateLabel }), 'success', 3200);
    renderSelfLessons();
    renderSelfPanel();
  } catch (err) {
    toast(t('self.toastToggleFail', { error: err.message }), 'error');
  }
}

function lessonFormPayload() {
  const read = (id) => String(document.getElementById(id)?.value || '').trim();
  return {
    project: read('lsProject'),
    member: read('lsMember'),
    role: read('lsRole'),
    error_code: read('lsErrorCode'),
    pattern: read('lsPattern'),
    guardrail: read('lsGuardrail'),
  };
}

function resetLessonForm() {
  const form = $('#lessonForm');
  if (form && typeof form.reset === 'function') form.reset();
}

async function saveSelfLesson(event) {
  if (event && typeof event.preventDefault === 'function') event.preventDefault();
  const payload = lessonFormPayload();
  if (!payload.guardrail) { toast(t('self.toastLessonRequired'), 'warn'); return; }
  try {
    const res = state.demo
      ? demoAddLesson(payload)
      : await apiPost('/api/lessons/save', payload);
    const lesson = res && res.lesson ? res.lesson : null;
    if (lesson) {
      const idx = state.selfLessons.findIndex((l) => String(l.id) === String(lesson.id));
      if (idx >= 0) state.selfLessons.splice(idx, 1, lesson);
      else state.selfLessons.unshift(lesson);
    }
    resetLessonForm();
    toast(t(state.demo ? 'self.toastLessonDemo' : 'self.toastLessonSaved'), 'success', 4000);
    renderSelfLessons();
    renderSelfPanel();
  } catch (err) {
    toast(t('self.toastLessonFail', { error: err.message }), 'error');
  }
}

/* ------------------------------------------------------------------ */
/* Drawer                                                              */
/* ------------------------------------------------------------------ */

function openDrawer(html, { kind = null, key = null } = {}) {
  const content = $('#drawerContent');
  const bg = $('#drawerBg');
  if (!content || !bg) return;
  content.innerHTML = html;
  bg.classList.add('open');
  bg.setAttribute('aria-hidden', 'false');
  content.scrollTop = 0;
  state.drawer = { kind, key };
}

function closeDrawer() {
  const bg = $('#drawerBg');
  if (!bg) return;
  resetForceArm();
  bg.classList.remove('open');
  bg.setAttribute('aria-hidden', 'true');
  state.drawer = { kind: null, key: null };
  state.taskLog = emptyTaskLog();
}

/* ------------------------------------------------------------------ */
/* Task detail + live output + cancel                                  */
/* ------------------------------------------------------------------ */

function demoTaskDetail(task) {
  const now = Date.now();
  return {
    task,
    events: [
      { event_type: t('demo.evt.dispatched'), actor: task.member, created_at: new Date(now - 20 * 60_000).toISOString(), payload_json: JSON.stringify({ role: task.role, channel: task.channel }) },
      { event_type: `task.${task.state}`, actor: task.member, created_at: new Date(now - 6 * 60_000).toISOString(), payload_json: JSON.stringify({ state: task.state }) },
      { event_type: 'receipt.polled', actor: 'cockpit', created_at: new Date(now - 2 * 60_000).toISOString(), payload_json: '{"result":"no-new-receipt"}' },
    ],
  };
}

const LOG_LIMIT = 200; /* client render cap — mirrors the backend MAX_LOG_ENTRIES_PER_TASK */

function normalizeLogEntry(entry) {
  const raw = entry || {};
  return {
    id: raw.id ?? null,
    ts: raw.ts || raw.at || new Date().toISOString(),
    stream: ['stdout', 'stderr', 'system'].includes(raw.stream) ? raw.stream : 'stdout',
    text: String(raw.text ?? ''),
  };
}

/* Backend log rows carry a durable `id`; SSE chunks do not, so those are keyed
 * by timestamp+text. Either way a concurrent chunk is never lost or doubled. */
function logEntryKey(entry) {
  return entry.id != null ? `id:${entry.id}` : `${entry.ts}\u0000${entry.text}`;
}

function updateLogPill() {
  const pill = $('#logPill');
  if (!pill) return;
  pill.classList.add('log-pill');
  const active = !state.taskLog.terminal && (state.taskLog.active || state.taskLog.live);
  pill.textContent = active ? t('log.live') : t('log.done');
  pill.classList.toggle('ok', active);
  pill.classList.toggle('subtle', !active);
  pill.classList.toggle('warn', false);
}

function updateFollowButton() {
  const btn = $('#logFollow');
  if (!btn) return;
  btn.classList.toggle('active', state.taskLog.follow);
  btn.setAttribute('aria-pressed', state.taskLog.follow ? 'true' : 'false');
  btn.title = state.taskLog.follow ? t('log.followOn') : t('log.followOff');
}

function toggleFollow() {
  state.taskLog.follow = !state.taskLog.follow;
  updateFollowButton();
  const box = $('#liveLog');
  if (state.taskLog.follow && box) box.scrollTop = box.scrollHeight;
  toast(state.taskLog.follow ? t('log.followOn') : t('log.followOff'), 'info', 1600);
}

function ensureLogEmpty(box) {
  if (!box) return;
  if (box.querySelector('.log-line')) { box.querySelector('.log-empty')?.remove(); return; }
  if (!box.querySelector('.log-empty')) {
    const empty = document.createElement('div');
    empty.className = 'log-empty';
    empty.textContent = t('log.empty');
    box.append(empty);
  }
}

function renderLogTruncated() {
  const box = $('#liveLog');
  if (!box) return;
  const existing = box.querySelector('#logTruncated');
  if (!state.taskLog.truncated) { existing?.remove(); return; }
  if (existing) return;
  const note = document.createElement('div');
  note.className = 'log-truncated';
  note.id = 'logTruncated';
  note.textContent = t('log.truncated');
  box.prepend(note);
}

/* Append-only, dedupe-first log sink. Never clears the console on mount. */
function appendTaskLog(taskId, entries) {
  if (!taskId || !Array.isArray(entries) || !entries.length) return;
  if (state.taskLog.taskId !== taskId) return;
  const box = $('#liveLog');
  if (!box) return;
  const follow = state.taskLog.follow;
  const prevTop = box.scrollTop;
  const frag = document.createDocumentFragment();
  let added = 0;
  for (const raw of entries) {
    const entry = normalizeLogEntry(raw);
    const key = logEntryKey(entry);
    if (state.taskLog.seen.has(key)) continue;
    state.taskLog.seen.add(key);
    state.taskLog.entries.push(entry);
    const row = document.createElement('div');
    row.className = `log-line log-${entry.stream}`;
    if (entry.id != null) row.dataset.logId = String(entry.id);
    const time = document.createElement('span');
    time.className = 'log-ts';
    time.textContent = fmtTimeShort(entry.ts);
    const text = document.createElement('span');
    text.className = 'log-text';
    text.textContent = entry.text;
    row.append(time, text);
    frag.append(row);
    added += 1;
  }
  if (!added) {
    renderLogTruncated();
    if (follow) box.scrollTop = box.scrollHeight;
    return;
  }
  box.append(frag);
  ensureLogEmpty(box);

  /* Cap both the state array and the DOM at 200 rows, and remember that the
   * head of the stream is gone so the truncated banner can be shown. */
  let removedHeight = 0;
  while (state.taskLog.entries.length > LOG_LIMIT) {
    const gone = state.taskLog.entries.shift();
    state.taskLog.seen.delete(logEntryKey(gone));
    const row = box.querySelector('.log-line');
    if (row) {
      removedHeight += row.offsetHeight || 0;
      row.remove();
    }
    state.taskLog.truncated = true;
  }
  renderLogTruncated();
  ensureLogEmpty(box);
  if (follow) {
    box.scrollTop = box.scrollHeight;
  } else if (removedHeight > 0) {
    /* !follow: keep the reader anchored on the same content even though rows
     * were trimmed above the viewport. */
    box.scrollTop = Math.max(0, prevTop - removedHeight);
  }
  updateLogPill();
}

async function mountTaskLogs(taskId, liveLogs = null, { terminal = false } = {}) {
  state.taskLog = emptyTaskLog({ taskId, live: Boolean(state.demo), follow: true, terminal });
  const box = $('#liveLog');
  if (!box) return;
  updateLogPill();
  updateFollowButton();

  if (state.demo) {
    const task = state.tasks.find((item) => item.task_id === taskId);
    state.taskLog.terminal = TERMINAL_STATES.includes(task?.state);
    state.taskLog.active = ACTIVE_STATES.includes(task?.state);
    appendTaskLog(taskId, demoTaskLogs(task));
    ensureLogEmpty(box);
    updateLogPill();
    return;
  }
  try {
    /* GET /api/tasks/:id already ships `live_logs`; reuse it instead of firing a
     * second /api/tasks/logs round-trip on every drawer open. */
    const data = (liveLogs && Array.isArray(liveLogs.logs))
      ? liveLogs
      : await apiGet(`/api/tasks/logs?task_id=${encodeURIComponent(taskId)}`);
    if (state.taskLog.taskId !== taskId) return;
    state.taskLog.active = Boolean(data.active);
    state.taskLog.ownerPid = data.owner_pid ?? null;
    state.taskLog.cancelRequested = Boolean(data.cancel_requested);
    const entries = Array.isArray(data.logs) ? data.logs : [];
    if (entries.length > LOG_LIMIT) state.taskLog.truncated = true;
    const initial = entries.slice(-LOG_LIMIT);
    if (initial.length) appendTaskLog(taskId, initial);
    ensureLogEmpty(box);
    renderLogTruncated();
    updateLogPill();
    updateFollowButton();
  } catch (err) {
    if (state.taskLog.taskId !== taskId) return;
    const logsBox = $('#liveLog');
    if (logsBox && !logsBox.querySelector('.log-line')) {
      const warn = document.createElement('div');
      warn.className = 'log-empty';
      warn.textContent = t('log.fetchFail', { error: err.message });
      logsBox.append(warn);
    }
  }
}

async function copyTaskLogs(button) {
  const text = state.taskLog.entries
    .map((entry) => `${entry.ts} [${entry.stream}] ${entry.text}`)
    .join('\n');
  if (!text.trim()) return;
  const original = button?.textContent || t('log.copy');
  try {
    await navigator.clipboard.writeText(text);
    if (button) { button.textContent = t('common.copied'); setTimeout(() => { button.textContent = original; }, 1500); }
    toast(t('log.copied'), 'success', 1800);
  } catch {
    toast(t('toast.copyFail'), 'warn');
  }
}

function renderTaskDrawer(task, data) {
  const live = ACTIVE_STATES.includes(task.state);
  const terminal = TERMINAL_STATES.includes(task.state);
  const canPoll = !terminal && task.channel !== 'desktop-native';
  const liveLogs = data.live_logs || null;
  /* A terminal task keeps its historical cancel_requested_at; only surface the amber
   * "cancel requested" state while the task is still live. */
  const cancelRequested = !terminal && (Boolean(task.cancel_requested_at) || Boolean(liveLogs?.cancel_requested));
  const ownerPid = liveLogs?.owner_pid ?? task.owner_pid ?? '—';
  const demoNote = state.demo ? `<div class="meta demo-note">${esc(t('drawer.demoNote'))}</div>` : '';
  const actions = [];
  if (live) {
    actions.push(`<button type="button" class="btn danger" data-cancel-task="${esc(task.task_id)}">${esc(t('cancel.label'))}</button>`);
    if (cancelRequested) {
      actions.push(`<button type="button" class="btn warn sm" data-force-cancel-task="${esc(task.task_id)}">${esc(t('cancel.force'))}</button>`);
    }
  }
  if (!state.demo && !terminal) {
    if (canPoll) actions.push(`<button type="button" class="btn primary sm" data-poll-task="${esc(task.task_id)}">${esc(t('drawer.poll'))}</button>`);
    actions.push(`<button type="button" class="btn warn sm" data-reconcile-task="${esc(task.task_id)}" data-reconcile-state="rerouted">${esc(t('drawer.reroute'))}</button>`);
    actions.push(`<button type="button" class="btn danger sm" data-reconcile-task="${esc(task.task_id)}" data-reconcile-state="failed">${esc(t('drawer.failed'))}</button>`);
  }
  const events = data.events || [];
  openDrawer(`
    <div class="drawer-head">
      <div>
        <div class="drawer-title">${esc(task.title)}</div>
        <div class="drawer-meta"><span>${esc(t('drawer.task'))} <code>${esc(task.task_id)}</code></span><span>${esc(t('drawer.agent'))} <code>${esc(task.member)}</code> (${esc(task.channel)})</span><span>${badge(task.state)}</span>${cancelRequested ? `<span class="pill warn cancel-req" id="cancelReqPill">${esc(t('cancel.requestedPill', { pid: ownerPid }))}</span>` : ''}</div>
      </div>
      <button type="button" class="icon-btn" data-close-drawer="1" aria-label="${esc(t('common.close'))}">×</button>
    </div>
    ${demoNote}
    ${actions.length ? `<div class="drawer-actions">${actions.join('')}</div>` : ''}
    <dl class="drawer-kv">
      <dt>${esc(t('drawer.project'))}</dt><dd><code>${esc(task.project_dir || '—')}</code></dd>
      <dt>${esc(t('drawer.role'))}</dt><dd>${esc(task.role || '—')}${task.meta?.routed_from ? esc(t('drawer.routedFrom', { from: task.meta.routed_from })) : ''}</dd>
      <dt>${esc(t('drawer.receipt'))}</dt><dd><code>${esc(task.external_id || '—')}</code></dd>
      <dt>${esc(t('drawer.session'))}</dt><dd><code>${esc(task.session_id || '—')}</code>${task.reply_generation ? esc(t('drawer.generation', { n: task.reply_generation })) : ''}</dd>
      <dt>${esc(t('drawer.batch'))}</dt><dd>${task.batch_id ? `<code>${esc(task.batch_id)}</code>` : '—'}</dd>
      <dt>${esc(t('drawer.depends'))}</dt><dd>${(task.depends_on || []).length ? task.depends_on.map((dep) => `<code>${esc(dep)}</code>`).join(' ') : '—'}</dd>
      <dt>${esc(t('drawer.updated'))}</dt><dd>${esc(fmtDate(task.updated_at))}</dd>
    </dl>
    <section class="drawer-section log-section">
      <div class="log-head">
        <h3>${esc(t('log.title'))}</h3>
        <span class="pill subtle log-pill" id="logPill">${esc(t(live ? 'log.live' : 'log.done'))}</span>
        <span class="log-spacer"></span>
        <button type="button" class="btn ghost sm${state.taskLog.follow ? ' active' : ''}" id="logFollow" data-toggle-follow="1" aria-pressed="${state.taskLog.follow ? 'true' : 'false'}" title="${esc(t('log.followTitle'))}">${esc(t('log.follow'))}</button>
        <button type="button" class="btn ghost sm" data-copy-logs="1">${esc(t('log.copy'))}</button>
      </div>
      <div class="live-log" id="liveLog" role="log" tabindex="0" aria-label="${esc(t('log.title'))}"></div>
    </section>
    <div class="drawer-section"><h3>${esc(t('drawer.prompt'))}</h3><pre class="mono-pre">${esc(task.prompt || '—')}</pre></div>
    ${task.result_text ? `<div class="drawer-section"><h3>${esc(t('drawer.result'))}</h3><pre class="mono-pre">${esc(task.result_text)}</pre></div>` : ''}
    ${task.error_message ? `<div class="drawer-section"><h3>${esc(t('drawer.error'))}</h3><pre class="mono-pre">${esc((task.error_code ? `[${task.error_code}] ` : '') + task.error_message)}</pre></div>` : ''}
    <div class="drawer-section"><h3>${esc(t('drawer.events', { n: events.length }))}</h3><pre class="mono-pre">${esc(events.map((e) => `${e.created_at} | ${e.event_type} | ${e.actor}${e.payload_json ? ` | ${e.payload_json}` : ''}`).join('\n') || t('drawer.noEvents'))}</pre></div>`,
  { kind: 'task', key: task.task_id });
  mountTaskLogs(task.task_id, liveLogs, { terminal });
}

async function openTask(taskId) {
  try {
    let data;
    if (state.demo) {
      const task = state.tasks.find((item) => item.task_id === taskId);
      if (!task) { toast(t('drawer.missing'), 'warn'); return; }
      data = demoTaskDetail(task);
    } else {
      data = await apiGet(`/api/tasks/${encodeURIComponent(taskId)}`);
    }
    const task = data.task;
    if (!task) return;
    renderTaskDrawer(task, data);
  } catch (err) {
    toast(t('drawer.openFail', { error: err.message }), 'error');
  }
}

async function pollTask(taskId, button) {
  if (state.demo) { toast(t('toast.demoReadonly'), 'warn'); return; }
  if (button) { button.disabled = true; button.textContent = t('drawer.polling'); }
  try {
    await apiPost('/api/tasks/poll', { task_id: taskId, wait_sec: 0 });
    await loadOverview({ quiet: true });
    await openTask(taskId);
  } catch (err) {
    toast(t('drawer.pollFail', { error: err.message }), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = t('drawer.poll'); }
  }
}

async function reconcileTask(taskId, nextState) {
  if (state.demo) { toast(t('toast.demoReadonly'), 'warn'); return; }
  try {
    await apiPost('/api/tasks/reconcile', { task_id: taskId, state: nextState, note: t('drawer.reconcileNote') });
    await loadOverview({ quiet: true });
    await openTask(taskId);
    toast(t('drawer.reconciled'), 'success');
  } catch (err) {
    toast(t('drawer.reconcileFail', { error: err.message }), 'error');
  }
}

function resetForceArm() {
  const armed = state.forceArmed;
  if (!armed) return;
  clearTimeout(armed.timer);
  if (armed.button?.isConnected) {
    armed.button.textContent = t('cancel.force');
    armed.button.classList.remove('armed');
  }
  state.forceArmed = null;
}

/* Two-step force cancel: the first click only arms the action for 5s; the
 * second click inside that window is what sends force: true. */
function requestForceCancel(taskId, button) {
  const armed = state.forceArmed;
  if (armed && armed.taskId === taskId && Date.now() < armed.until) {
    clearTimeout(armed.timer);
    state.forceArmed = null;
    cancelTask(taskId, button, { force: true });
    return;
  }
  resetForceArm();
  if (!button) return;
  const timer = setTimeout(() => {
    if (state.forceArmed?.taskId === taskId) resetForceArm();
  }, 5000);
  state.forceArmed = { taskId, until: Date.now() + 5000, timer, button };
  button.textContent = t('cancel.forceConfirm');
  button.classList.add('armed');
  toast(t('cancel.forceHint'), 'warn', 5200);
}

async function cancelTask(taskId, button, { force = false } = {}) {
  if (state.demo) { toast(t('cancel.demo'), 'warn'); return; }
  const task = state.tasks.find((item) => item.task_id === taskId);
  if (!force && task && TERMINAL_STATES.includes(task.state)) { toast(t('cancel.alreadyTerminal'), 'warn'); return; }
  const original = button?.textContent || t(force ? 'cancel.force' : 'cancel.label');
  if (button) { button.disabled = true; button.textContent = t('cancel.pending'); }
  try {
    const res = await apiPost('/api/tasks/cancel', {
      task_id: taskId,
      reason: t('drawer.reconcileNote'),
      ...(force ? { force: true } : {}),
    });
    const requested = Boolean(res?.cancel_requested);
    const cancelled = res?.cancelled !== false;
    if (!cancelled) {
      /* already_terminal / unconfirmed cross-process abort: never paint green. */
      toast(res?.message || (res?.already_terminal ? t('cancel.alreadyTerminal') : t('cancel.notConfirmed')), 'warn', 7000);
    } else if (requested) {
      toast(res?.message || t('cancel.requested', { pid: res?.task?.owner_pid ?? task?.owner_pid ?? '—' }), 'warn', 7000);
    } else if (force || res?.forced) {
      toast(t('cancel.forceDone'), 'success');
    } else {
      toast(res?.aborted_live_process ? t('cancel.doneAbort') : t('cancel.done'), 'success');
    }
    await loadOverview({ quiet: true });
    if (state.drawer.kind === 'task' && state.drawer.key === taskId) await openTask(taskId);
    else renderAll();
  } catch (err) {
    toast(t('cancel.fail', { error: err.message }), 'error');
  } finally {
    if (button?.isConnected) { button.disabled = false; button.textContent = original; }
  }
}

/* ------------------------------------------------------------------ */
/* Batch report                                                        */
/* ------------------------------------------------------------------ */

function demoBatchMarkdown(batchId) {
  const tasks = state.tasks.filter((task) => task.batch_id === batchId);
  const batch = state.batches.find((b) => b.batch_id === batchId);
  const rows = tasks.map((task) => `| \`${task.task_id}\` | ${task.state} | ${task.member} | ${task.title} |`).join('\n');
  return `# ${t('batch.title', { id: batchId })}

> ${t('batch.demoNote')}

## ${t('batch.summary')}

- ${t('batch.total')}: **${batch?.total ?? tasks.length}**
- ${t('batch.terminal')}: **${batch?.all_terminal ? t('batch.yes') : t('batch.no')}**
- ${t('batch.failures')}: **${batch?.has_failures ? t('batch.yes') : t('batch.no')}**

## ${t('batch.tasks')}

| Task ID | State | Agent | Title |
| --- | --- | --- | --- |
${rows}

## ${t('batch.notes')}

- ${t('batch.note1')}
- ${t('batch.note2')}
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
          <div class="drawer-title">${esc(t('batch.title', { id: batchId }))}</div>
          <div class="drawer-meta"><span>${esc(t('batch.md'))}</span>${state.demo ? `<span>${esc(t('topbar.demo'))}</span>` : ''}</div>
        </div>
        <div class="panel-tools">
          <button type="button" class="btn ghost sm" data-toggle-raw="batch" data-raw-label="${esc(t('batch.raw'))}" data-rich-label="${esc(t('mem.preview'))}">${esc(t('batch.raw'))}</button>
          <button type="button" class="btn primary sm" data-copy-batch="1">${esc(t('batch.copy'))}</button>
          <button type="button" class="icon-btn" data-close-drawer="1" aria-label="${esc(t('common.close'))}">×</button>
        </div>
      </div>
      <div id="batchRich" class="md-view">${renderSafeMarkdown(markdown)}</div>
      <pre id="batchRaw" class="mono-pre mono-pre-tall" hidden>${esc(markdown)}</pre>`, { kind: 'batch', key: batchId });
  } catch (err) {
    toast(t('batch.fail', { error: err.message }), 'error');
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
    box.innerHTML = `<div class="meta">${esc(t('agent.demoScan'))}</div>`;
    return;
  }
  box.innerHTML = `<div class="meta">${esc(t('agent.scanning'))}</div>`;
  try {
    const data = await apiGet('/api/agents/discover');
    state.discovered = [];
    const rows = [];
    for (const m of data.local_models || []) {
      const i = state.discovered.push(m.suggested_registration) - 1;
      rows.push(`<div class="discover-row"><span><strong>${esc(`${m.endpoint} · ${m.model}`)}</strong></span><button type="button" class="btn primary sm" data-fill-discovered="${i}">${esc(t('agent.fill'))}</button></div>`);
    }
    for (const c of (data.cli_agents || []).filter((x) => x.found)) {
      const i = state.discovered.push(c.suggested_registration) - 1;
      rows.push(`<div class="discover-row"><span><strong>${esc(c.name)}</strong> <span class="meta">(${esc(c.path)})</span></span><button type="button" class="btn primary sm" data-fill-discovered="${i}">${esc(t('agent.fill'))}</button></div>`);
    }
    for (const p of (data.cloud_env_ready || []).filter((x) => x.env_present)) {
      const i = state.discovered.push(p.suggested_registration) - 1;
      rows.push(`<div class="discover-row"><span><strong>${esc(p.name)}</strong> <span class="pill">${esc(p.env_var)}</span></span><button type="button" class="btn primary sm" data-fill-discovered="${i}">${esc(t('agent.fill'))}</button></div>`);
    }
    const endpointSummary = (data.local_endpoints || []).map((e) => (e.reachable
      ? t('agent.endpointOn', { label: e.label, n: e.model_count })
      : t('agent.endpointOff', { label: e.label }))).join(' · ');
    box.innerHTML = `<div class="meta discover-summary">${esc(t('agent.endpoints', { summary: endpointSummary || t('agent.noEndpoint') }))}</div>` +
      (rows.length ? rows.join('') : `<div class="meta">${esc(t('agent.nothing'))}</div>`);
  } catch (err) {
    box.innerHTML = `<div class="form-error">${esc(t('agent.discoverFail', { error: err.message }))}</div>`;
  }
}

async function saveAgent() {
  const err = $('#agErr');
  if (err) err.textContent = '';
  let config;
  try {
    config = JSON.parse($('#agConfig')?.value || '{}');
  } catch {
    if (err) err.textContent = t('agent.badJson');
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
    toast(t('agent.saved'), 'success');
    await loadOverview({ quiet: true });
  } catch (e) {
    if (err) err.textContent = t('agent.saveFail', { error: e.message });
  }
}

async function testAgent(agentId, button) {
  if (state.demo) { toast(t('toast.demoReadonly'), 'warn'); return; }
  const original = button?.textContent || t('roster.testConn');
  if (button) { button.disabled = true; button.textContent = t('roster.testing'); }
  try {
    const res = await apiPost('/api/agents/test', { agent_id: agentId });
    const st = res.result?.state || 'unknown';
    toast(t('agent.testResult', { id: agentId, state: stateLabelOf(st) }), st === 'offline' ? 'error' : 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(t('agent.testFail', { error: err.message }), 'error');
  } finally {
    if (button) { button.disabled = false; button.textContent = original; }
  }
}

async function removeAgent(agentId) {
  if (state.demo) { toast(t('toast.demoReadonly'), 'warn'); return; }
  try {
    await apiPost('/api/agents/remove', { agent_id: agentId });
    toast(t('agent.remove'), 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(t('agent.removeFail', { error: err.message }), 'error');
  }
}

async function clearCooldown(member) {
  if (state.demo) { toast(t('toast.demoReadonly'), 'warn'); return; }
  try {
    await apiPost('/api/cooldown/clear', { member });
    toast(t('agent.cleared'), 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(t('agent.cooldownFail', { error: err.message }), 'error');
  }
}

async function probeAll() {
  if (state.demo) { toast(t('agent.probeDemo'), 'warn'); return; }
  const dot = $('#sideProbeDot');
  if (dot) dot.className = 'side-action-dot busy';
  const updated = $('#updatedAt');
  if (updated) updated.textContent = t('topbar.syncing');
  try {
    const res = await apiPost('/api/probe', {});
    if (res.throttled) toast(t('agent.probeThrottled', { s: res.retry_after_s }), 'warn');
    else toast(t('agent.probed'), 'success');
    await loadOverview({ quiet: true });
  } catch (err) {
    toast(t('agent.probeFail', { error: err.message }), 'error');
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
  sel.innerHTML = `<option value="">${esc(t('dispatch.recipeManual'))}</option>` + state.recipes.map((r) => (
    `<option value="${esc(r.recipe_id)}">${esc(`${r.title} [${r.role}]`)}</option>`
  )).join('');
}

function renderDispatchMembers() {
  const sel = $('#dpMember');
  if (!sel) return;
  const eligible = state.members.filter((m) => AGENT_DRIVERS.includes(m.driver));
  sel.innerHTML = `<option value="auto">${esc(t('dispatch.auto'))}</option>` + eligible.map((m) => (
    `<option value="${esc(m.member)}">${esc(m.name || m.member)} (${esc(m.channel)} · ${esc(stateLabelOf(m.state))})</option>`
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
    const { status, data: res } = await apiPostRaw('/api/tasks/dispatch', {
      member: $('#dpMember')?.value,
      role: $('#dpRole')?.value,
      project_dir: $('#dpDir')?.value.trim(),
      title: $('#dpTitle')?.value.trim(),
      prompt: $('#dpPrompt')?.value.trim(),
      auto_fallback: $('#dpFallback')?.checked,
      /* async: the backend answers 202 immediately and streams output over SSE,
       * so local CLI/HTTP runs return at once instead of blocking the UI. */
      async: true,
    });
    closeModal('modalDispatchBg');
    toast(status === 202 ? t('dispatch.asyncQueued') : t('dispatch.done'), 'success');
    await loadOverview({ quiet: true });
    if (res.task?.task_id) await openTask(res.task.task_id);
  } catch (e) {
    if (err) err.textContent = e.message;
  }
}

async function loadWorkspacesAndRecipes() {
  if (state.demo) {
    state.recipes = demoRecipes();
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
    toast(String(err?.message || err), 'warn');
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
    toast(t('memory.saved'), 'success');
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
  pill.classList.remove('ok', 'warn', 'off', 'demo');
  if (cls) pill.classList.add(cls);
}

function scheduleOverviewReload() {
  clearTimeout(state.timers.reload);
  state.timers.reload = setTimeout(() => {
    /* loadOverview() already refreshes /api/events on the ops view; fetching it
     * here as well doubled the audit-stream traffic on every SSE burst. */
    loadOverview({ quiet: true });
  }, 450);
}

function stopSse() {
  try { state.timers.sse?.close?.(); } catch { /* ignore */ }
  state.timers.sse = null;
  state.flags.sseConnected = false;
}

const TASK_EVENT_STATES = ['created', 'dispatching', 'dispatched', 'running', 'completed', 'failed', 'cancelled', 'stalled', 'uncertain', 'needs_input', 'rerouted'];

/* SSE task events encode their state in the event type (`task.completed`). */
function stateFromEventType(type) {
  const match = /^task\.([a-z_]+)$/.exec(String(type || ''));
  return match && TASK_EVENT_STATES.includes(match[1]) ? match[1] : null;
}

function handleSseMessage(event) {
  let payload = null;
  try { payload = JSON.parse(event.data); } catch { scheduleOverviewReload(); return; }
  const type = payload?.type;
  const eventState = stateFromEventType(type) || payload?.payload?.state || payload?.state || null;
  if (eventState && payload.task_id && payload.task_id === state.taskLog.taskId) {
    /* Flip the drawer pill the moment the task reaches a terminal state. */
    state.taskLog.terminal = TERMINAL_STATES.includes(eventState);
    state.taskLog.active = ACTIVE_STATES.includes(eventState);
    updateLogPill();
  }
  if (type === 'task.log') {
    if (payload.task_id && payload.task_id === state.taskLog.taskId) {
      appendTaskLog(payload.task_id, [{ ts: payload.at, stream: payload.stream, text: payload.text }]);
    }
    return;
  }
  if (type === 'task.cancelled') {
    toast(t('cancel.event', { id: payload.task_id || '—', member: payload.member || 'system' }), 'info');
    if (state.drawer.kind === 'task' && state.drawer.key === payload.task_id) openTask(payload.task_id);
    scheduleOverviewReload();
    return;
  }
  scheduleOverviewReload();
}

function connectSse() {
  if (state.demo) {
    setSsePill(state.static ? t('topbar.sseStatic') : t('topbar.sseDemo'), 'demo');
    return;
  }
  if (state.timers.sse) return; /* already connected or reconnecting */
  try {
    const es = new EventSource('/api/events/stream');
    state.timers.sse = es;
    es.onopen = () => {
      state.flags.sseConnected = true;
      setSsePill(t('topbar.sseLive'), 'ok');
      restartPolling();
    };
    es.onmessage = (event) => handleSseMessage(event);
    es.onerror = () => {
      setSsePill(t('topbar.ssePolling'), 'warn');
      if (state.flags.sseConnected) {
        state.flags.sseConnected = false;
        restartPolling();
      }
      /* EventSource.CLOSED means the browser gave up reconnecting: drop the
       * dead handle so visibilitychange/pageshow can open a fresh stream. */
      if (es.readyState === 2) stopSse();
    };
  } catch {
    state.flags.sseConnected = false;
    setSsePill(t('topbar.ssePolling'), 'warn');
    restartPolling();
  }
}

const POLL_MS = { fast: 15000, sse: 30000 };

function startPolling() {
  if (state.demo || state.static) return;
  /* With a live SSE stream the poll is only a safety net, so halve its rate. */
  const every = state.flags.sseConnected ? POLL_MS.sse : POLL_MS.fast;
  if (state.timers.poll && state.pollEvery === every) return;
  stopPolling();
  state.pollEvery = every;
  state.timers.poll = setInterval(() => loadOverview({ quiet: true }), every);
}

function stopPolling() {
  if (state.timers.poll) clearInterval(state.timers.poll);
  state.timers.poll = null;
  state.pollEvery = 0;
}

function restartPolling() {
  if (state.demo || state.static) return;
  startPolling();
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
  }
}

async function handleActionClick(event) {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const closest = (sel) => target.closest(sel);

  const goto = closest('[data-goto-view]');
  if (goto) { setView(goto.getAttribute('data-goto-view')); return; }

  const lessonToggle = closest('[data-lesson-toggle]');
  if (lessonToggle) {
    const next = lessonToggle.getAttribute('data-lesson-active') !== '1';
    return toggleSelfLesson(lessonToggle.getAttribute('data-lesson-toggle'), next);
  }

  const action = closest('[data-action]');
  if (action) {
    const name = action.getAttribute('data-action');
    if (name === 'probe') return probeAll();
    if (name === 'agent') return openAgentModal();
    if (name === 'memory') return openMemoryModal();
    if (name === 'events') { setView('system'); return loadEvents(true); }
    if (name === 'theme') return toggleTheme();
    if (name === 'lang') return setLang(LANG === 'zh' ? 'en' : 'zh', { announce: true });
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
    if (state.sim.running) stopSimulation();
    state.dagSteps = dagTemplates(dagTpl.getAttribute('data-dag-tpl'));
    state.dagBatch = null;
    state.dagBatchTouched = false;
    renderDagSteps();
    renderDagBatchSelect();
    renderDagCanvas();
    return;
  }
  const delDag = closest('[data-del-dag]');
  if (delDag) { removeDagStep(delDag.getAttribute('data-del-dag')); return; }
  const dagNode = closest('[data-dag-node]');
  if (dagNode) {
    const taskId = dagNode.getAttribute('data-dag-task');
    if (taskId) { openTask(taskId); return; }
    const nodeId = dagNode.getAttribute('data-dag-node');
    focusDagStep(state.dagSteps.findIndex((step) => step.id === nodeId));
    return;
  }
  if (closest('[data-sim-dag]')) { if (state.sim.running) stopSimulation(); else startSimulation(); return; }
  if (closest('[data-resume-batch]')) { resumeBatch(); return; }

  const openTaskEl = closest('[data-open-task]');
  if (openTaskEl) { openTask(openTaskEl.getAttribute('data-open-task')); return; }
  const pollEl = closest('[data-poll-task]');
  if (pollEl) { pollTask(pollEl.getAttribute('data-poll-task'), pollEl); return; }
  const forceEl = closest('[data-force-cancel-task]');
  if (forceEl) { requestForceCancel(forceEl.getAttribute('data-force-cancel-task'), forceEl); return; }
  const cancelEl = closest('[data-cancel-task]');
  if (cancelEl) { cancelTask(cancelEl.getAttribute('data-cancel-task'), cancelEl); return; }
  const reconcileEl = closest('[data-reconcile-task]');
  if (reconcileEl) { reconcileTask(reconcileEl.getAttribute('data-reconcile-task'), reconcileEl.getAttribute('data-reconcile-state')); return; }
  if (closest('[data-toggle-follow]')) { toggleFollow(); return; }
  if (closest('[data-copy-logs]')) { await copyTaskLogs(closest('[data-copy-logs]')); return; }

  const batchEl = closest('[data-open-batch]');
  if (batchEl) { openBatchReport(batchEl.getAttribute('data-open-batch')); return; }
  const copyBatch = closest('[data-copy-batch]');
  if (copyBatch) {
    try {
      await navigator.clipboard.writeText(state.lastBatchMd);
      copyBatch.textContent = t('common.copied');
      setTimeout(() => { copyBatch.textContent = t('batch.copy'); }, 1600);
    } catch { toast(t('toast.copyFail'), 'warn'); }
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
    rawToggle.textContent = showingRaw
      ? (rawToggle.getAttribute('data-raw-label') || t('mem.markdown'))
      : (rawToggle.getAttribute('data-rich-label') || t('mem.preview'));
  }
}

function bindStaticEvents() {
  $$('.nav-item').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));

  $('#btnMobileNav')?.addEventListener('click', () => $('#sidebar')?.classList.toggle('open'));
  $('#btnTheme')?.addEventListener('click', toggleTheme);
  $('#btnLang')?.addEventListener('click', () => setLang(LANG === 'zh' ? 'en' : 'zh', { announce: true }));
  $('#btnPalette')?.addEventListener('click', openPalette);
  $('#btnOpenDispatch')?.addEventListener('click', openDispatchModal);
  $('#btnOpenMemory')?.addEventListener('click', openMemoryModal);
  $('#mailPill')?.addEventListener('click', () => {
    if (!state.mail?.ok) { toast(t('toast.mailOffline'), 'warn'); return; }
    if (state.demo) { toast(t('toast.mailDemo'), 'info'); return; }
    if (state.mail.url) window.open(state.mail.url, '_blank', 'noopener');
  });

  $('#filterText')?.addEventListener('input', () => {
    clearTimeout(state.timers.filter);
    state.timers.filter = setTimeout(renderTasks, 150);
  });
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

  /* v1.4 self-improve console */
  $('#btnSelfCheck')?.addEventListener('click', () => runSelfCheck());
  $('#btnSelfDry')?.addEventListener('click', () => previewSelfHeal());
  $('#btnSelfApply')?.addEventListener('click', () => applySelfHeal());
  $('#lessonForm')?.addEventListener('submit', (event) => saveSelfLesson(event));

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
    if (!node) return;
    event.preventDefault();
    const taskId = node.getAttribute('data-dag-task');
    if (taskId) openTask(taskId);
    else focusDagStep(state.dagSteps.findIndex((step) => step.id === node.getAttribute('data-dag-node')));
  });
  $('#dagBatchSelect')?.addEventListener('change', (event) => {
    state.dagBatch = event.target.value || null;
    state.dagBatchTouched = true;
    renderDagCanvas();
    const resumeBtn = $('#btnResumeBatch');
    if (resumeBtn) resumeBtn.hidden = !(state.dagBatch && batchHasIssues(state.dagBatch));
  });
  $('#btnSaveDagTpl')?.addEventListener('click', saveDagTemplate);
  $('#btnDelDagTpl')?.addEventListener('click', deleteDagTemplate);
  $('#dagTplSelect')?.addEventListener('change', (event) => {
    if (event.target.value) loadDagTemplate(event.target.value);
  });

  $('#btnRunPlaybook')?.addEventListener('click', runPlaybook);

  $('#btnRunAst')?.addEventListener('click', () => runToolkit('ast'));
  $('#btnRunPack')?.addEventListener('click', () => runToolkit('pack'));
  $('#btnRunDoc')?.addEventListener('click', () => runToolkit('doc'));
  $('#btnRunBeads')?.addEventListener('click', () => runToolkit('beads'));
  $('#btnCopyTk')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(state.lastToolkitCopy); toast(t('tk.outCopied'), 'success', 2000); }
    catch { toast(t('toast.copyFail'), 'warn'); }
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

  document.addEventListener('scroll', (event) => {
    const box = event.target;
    if (!(box instanceof HTMLElement) || box.id !== 'liveLog') return;
    state.taskLog.follow = box.scrollTop + box.clientHeight >= box.scrollHeight - 28;
  }, true);

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

  /* bfcache hygiene: a tab parked in the back/forward cache must not keep a dead
   * SSE slot open, and must reconnect cleanly when it comes back. */
  window.addEventListener('pagehide', () => { stopSse(); stopPolling(); });
  window.addEventListener('pageshow', (event) => {
    if (!event.persisted || state.demo || state.static) return;
    connectSse();
    startPolling();
    loadOverview({ quiet: true });
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || state.demo || state.static) return;
    if (!state.timers.sse) connectSse();
    startPolling();
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function markDemoPill() {
  const pill = $('#demoPill');
  if (!pill) return;
  if (state.demo) {
    pill.hidden = false;
    pill.textContent = state.static ? t('topbar.static') : t('topbar.demo');
  } else {
    pill.hidden = true;
  }
}

async function boot() {
  LANG = initialLang();
  state.lang = LANG;
  initTheme();
  await detectMode();

  applyStaticI18n();
  state.dagTemplates = state.demo ? [] : loadDagTemplates();
  state.dagSteps = defaultDagSteps();
  renderDagSteps();
  renderDagTemplates();
  renderDagBatchSelect();
  renderDagCanvas();
  bindStaticEvents();
  setView(viewFromHash(), { silent: true });
  markDemoPill();
  applyStaticI18n();

  if (state.demo) {
    document.title = state.static ? t('app.titleStatic') : t('app.titleDemo');
    $('#btnHotBackup')?.setAttribute('disabled', 'disabled');
  }

  loadWorkspacesAndRecipes();
  loadOverview();
  connectSse();
  startPolling();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
else boot();

