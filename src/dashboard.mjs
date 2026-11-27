import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs/promises';
import {
  APP_VERSION, DASHBOARD_HOST, DASHBOARD_PORT, DB_PATH,
  assertValidAgentId, assertValidTaskId, ensureRuntimeDirs,
} from './config.mjs';
import { clearMemberCooldown, getMemberStatuses, isRegisteredAgent, openHubDb, parseTaskRow, pruneRetentionTables, upsertMemberStatus } from './db.mjs';
import { discoverLocalAgents } from './discovery.mjs';
import { createHotBackup, listWorkspaceProjects, runSystemDoctor } from './doctor.mjs';
import { hubBus } from './event-bus.mjs';
import { awaitActiveRuns, cancelTask, dispatchBackgroundTask, getTaskLogs, pollBackgroundTask, reconcileTask, sweepOrphanTasks } from './executors.mjs';
import { releaseMailPaths } from './mail-sync.mjs';
import { buildCockpitAppHtml } from './mcp-app-ui.mjs';
import {
  buildMcpHubSnapshot, callMcpServerTool, findMcpTools, generateClientSnippet,
  getMcpHubSummary, importDiscoveredMcpServers, probeMcpServer,
  registerMcpServer, removeMcpServer, syncMcpToClient,
} from './mcp-hub.mjs';
import { listMemoryNotes, searchMemoryNotes, writeMemoryNote } from './memory.mjs';
import {
  addWorktreeComment, dispatchWorktreeRework, enqueueMergeQueue, listMergeQueue,
  listWorktreeComments, processMergeQueue, removeMergeQueueItem,
  resolveWorktreeComment, validateMergeQueue,
} from './merge-queue.mjs';
import { runPlaybook } from './playbooks.mjs';
import { probeAllMembers, probeMailHub } from './prober.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from './recipes.mjs';
import { getAgent, probeCustomAgent, registerAgent, removeAgent } from './registry.mjs';
import {
  applySelfHeal, diagnoseSystem, getSelfImproveSummary, listIncidentLessons, saveIncidentLesson, toggleIncidentLesson,
} from './self-improve.mjs';
import { buildSkillsRulesSnapshot, syncRuleAcrossTargets, syncSkillAcrossClients } from './skills-hub.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';
import {
  convertDocToMd, getCassStats, getToolkitStatus, packRepoRepomix,
  reindexSessionsCass, runBeads, searchAstGrep, searchSessionsCass,
} from './toolkit.mjs';
import { buildBatchMarkdownReport, resumeDagWorkflow, runDagWorkflow } from './workflows.mjs';
import { cleanupWorktree, listWorktrees, mergeWorktree, reviewWorktree, verifyWorktree } from './worktree.mjs';

const MAX_BODY_BYTES = 64 * 1024;
const PROBE_MIN_INTERVAL_MS = 15000;
const CASS_STATS_TTL_MS = 60000;
const AUTO_POLL_INTERVAL_MS = 30000;
const CASS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
const MAX_SSE_CLIENTS = 20;
const TERMINAL_STATES = new Set(['completed', 'failed', 'rerouted', 'cancelled']);

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

// Flat allowlist: the only files the dashboard will ever serve from PUBLIC_DIR.
const STATIC_ASSETS = new Map([
  ['index.html', 'text/html; charset=utf-8'],
  ['styles.css', 'text/css; charset=utf-8'],
  ['app.js', 'text/javascript; charset=utf-8'],
  ['studios.js', 'text/javascript; charset=utf-8'],
]);

const CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'";

/**
 * Resolve a raw request path segment to a served asset.
 * Returns null for anything that is not one of the three allowlisted flat files.
 * Defense in depth: allowlist first, then character gate, then path.resolve + dirname check.
 */
function resolveStaticAsset(rawPathname) {
  if (typeof rawPathname !== 'string' || !rawPathname.startsWith('/assets/')) return null;
  const encodedName = rawPathname.slice('/assets/'.length);
  if (!encodedName) return null;
  let name;
  try { name = decodeURIComponent(encodedName); } catch { return null; }
  if (!STATIC_ASSETS.has(name)) return null;
  if (name.includes('\0') || name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  const filePath = path.resolve(PUBLIC_DIR, name);
  if (path.dirname(filePath) !== PUBLIC_DIR) return null;
  return { name, filePath, contentType: STATIC_ASSETS.get(name) };
}

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

// ---------------------------------------------------------------------------
// Read-only demo overview
// ---------------------------------------------------------------------------
// Pure in-memory fixture: no DB handle, no probe, no cass, no filesystem.
// Every string is fictional and path-neutral (/workspace/...) — no personal
// paths, no RFC1918/loopback addresses, no hostnames, no os.homedir().
function buildDemoOverview() {
  const nowMs = Date.now();
  const at = (minutesAgo) => new Date(nowMs - minutesAgo * 60000).toISOString();
  const DEMO_PROJECT = '/workspace/collab-demo';

  const demoTasks = [
    {
      task_id: 'demo-queue-01',
      batch_id: 'demo-batch-01',
      parent_task_id: null,
      depends_on: [],
      project_dir: DEMO_PROJECT,
      member: 'beacon',
      role: 'implementer',
      channel: 'generic-cli',
      title: 'Scaffold release notes generator',
      prompt: 'Generate release notes from the CHANGELOG sections and write them to docs/release-notes.md.',
      state: 'dispatched',
      external_id: null,
      session_id: 'demo-session-01',
      reply_generation: 0,
      payload_sha256: null,
      worktree_path: null,
      branch_name: null,
      mail_message_id: null,
      dispatch_token: null,
      attempted_at: at(9),
      result_text: null,
      evidence: null,
      error_code: null,
      error_message: null,
      meta: {},
      created_at: at(11),
      updated_at: at(9),
      completed_at: null,
    },
    {
      task_id: 'demo-run-01',
      batch_id: 'demo-batch-01',
      parent_task_id: null,
      depends_on: [],
      project_dir: DEMO_PROJECT,
      member: 'cipher',
      role: 'reviewer',
      channel: 'dsh-baton',
      title: 'Audit worktree merge gate',
      prompt: 'Review the merge gate path for missing branch checks and report findings.',
      state: 'running',
      external_id: null,
      session_id: 'demo-session-02',
      reply_generation: 0,
      payload_sha256: null,
      worktree_path: '/workspace/worktrees/demo-verify-gate',
      branch_name: 'collab/demo/verify-gate',
      mail_message_id: null,
      dispatch_token: null,
      attempted_at: at(7),
      result_text: null,
      evidence: null,
      error_code: null,
      error_message: null,
      meta: {},
      created_at: at(8),
      updated_at: at(3),
      completed_at: null,
    },
    {
      task_id: 'demo-stall-01',
      batch_id: 'demo-batch-02',
      parent_task_id: null,
      depends_on: [],
      project_dir: DEMO_PROJECT,
      member: 'delta',
      role: 'tester',
      channel: 'muse-tailnet',
      title: 'Reconcile flaky SSE reconnect test',
      prompt: 'Reproduce the flaky reconnect test and reconcile the failing assertions.',
      state: 'stalled',
      external_id: null,
      session_id: 'demo-session-03',
      reply_generation: 0,
      payload_sha256: null,
      worktree_path: null,
      branch_name: null,
      mail_message_id: null,
      dispatch_token: null,
      attempted_at: at(26),
      result_text: null,
      evidence: null,
      error_code: 'harness_down',
      error_message: 'No heartbeat for 180s',
      meta: {},
      created_at: at(30),
      updated_at: at(24),
      completed_at: null,
    },
    {
      task_id: 'demo-review-01',
      batch_id: 'demo-batch-02',
      parent_task_id: null,
      depends_on: [],
      project_dir: DEMO_PROJECT,
      member: 'atlas',
      role: 'reviewer',
      channel: 'openai-http',
      title: 'Verify Kanban drag affordances',
      prompt: 'Verify keyboard and pointer affordances for moving cards between Kanban columns.',
      state: 'uncertain',
      external_id: null,
      session_id: 'demo-session-04',
      reply_generation: 0,
      payload_sha256: null,
      worktree_path: null,
      branch_name: null,
      mail_message_id: null,
      dispatch_token: null,
      attempted_at: at(21),
      result_text: null,
      evidence: null,
      error_code: 'receipt_missing',
      error_message: null,
      meta: {},
      created_at: at(23),
      updated_at: at(19),
      completed_at: null,
    },
    {
      task_id: 'demo-done-01',
      batch_id: null,
      parent_task_id: null,
      depends_on: [],
      project_dir: DEMO_PROJECT,
      member: 'atlas',
      role: 'reviewer',
      channel: 'openai-http',
      title: 'Ship FTS5 memory search',
      prompt: 'Implement ranked full-text search over memory notes with highlight snippets.',
      state: 'completed',
      external_id: 'msg_demo_01',
      session_id: 'demo-session-05',
      reply_generation: 1,
      payload_sha256: null,
      worktree_path: null,
      branch_name: null,
      mail_message_id: null,
      dispatch_token: null,
      attempted_at: at(95),
      result_text: 'Implemented ranked FTS5 search with highlight snippets.',
      evidence: null,
      error_code: null,
      error_message: null,
      meta: {},
      created_at: at(120),
      updated_at: at(88),
      completed_at: at(88),
    },
    {
      task_id: 'demo-done-02',
      batch_id: null,
      parent_task_id: null,
      depends_on: [],
      project_dir: DEMO_PROJECT,
      member: 'beacon',
      role: 'implementer',
      channel: 'generic-cli',
      title: 'Prototype zero-dependency chart renderer',
      prompt: 'Prototype a canvas chart renderer with no third-party dependencies.',
      state: 'failed',
      external_id: null,
      session_id: 'demo-session-06',
      reply_generation: 0,
      payload_sha256: null,
      worktree_path: null,
      branch_name: null,
      mail_message_id: null,
      dispatch_token: null,
      attempted_at: at(150),
      result_text: null,
      evidence: null,
      error_code: 'scope_rejected',
      error_message: 'Scope exceeded: chart engine out of v1.1 range',
      meta: {},
      created_at: at(160),
      updated_at: at(144),
      completed_at: at(144),
    },
  ];

  const demoMembers = [
    {
      member: 'atlas',
      name: 'Atlas',
      driver: 'openai-http',
      builtin: false,
      channel: 'openai-http',
      state: 'online',
      raw_state: 'online',
      is_stale: false,
      age_s: 12,
      in_cooldown: false,
      cli_in_cooldown: false,
      cooldown_channel: null,
      cooldown_until: null,
      cooldown_remaining_s: 0,
      cooldown_reason: null,
      sessions: [],
      detail: 'Responding (demo fixture)',
      checked_at: at(1),
      roles: ['reviewer', 'coordinator'],
      capabilities: ['review', 'summarize'],
      config: {},
    },
    {
      member: 'beacon',
      name: 'Beacon',
      driver: 'generic-cli',
      builtin: false,
      channel: 'generic-cli',
      state: 'idle',
      raw_state: 'idle',
      is_stale: false,
      age_s: 45,
      in_cooldown: false,
      cli_in_cooldown: false,
      cooldown_channel: null,
      cooldown_until: null,
      cooldown_remaining_s: 0,
      cooldown_reason: null,
      sessions: [],
      detail: 'Idle (demo fixture)',
      checked_at: at(2),
      roles: ['implementer'],
      capabilities: ['implement'],
      config: {},
    },
    {
      member: 'cipher',
      name: 'Cipher',
      driver: 'dsh-baton',
      builtin: true,
      channel: 'dsh-baton',
      state: 'online',
      raw_state: 'online',
      is_stale: false,
      age_s: 8,
      in_cooldown: false,
      cli_in_cooldown: false,
      cooldown_channel: null,
      cooldown_until: null,
      cooldown_remaining_s: 0,
      cooldown_reason: null,
      sessions: [],
      detail: 'Baton attached (demo fixture)',
      checked_at: at(1),
      roles: ['reviewer', 'implementer'],
      capabilities: ['review', 'verify'],
      config: {},
    },
    {
      member: 'delta',
      name: 'Delta',
      driver: 'muse-tailnet',
      builtin: true,
      channel: 'muse-tailnet',
      state: 'cooldown',
      raw_state: 'idle',
      is_stale: false,
      age_s: 300,
      in_cooldown: true,
      cli_in_cooldown: false,
      cooldown_channel: 'muse-tailnet',
      cooldown_until: at(-0.7),
      cooldown_remaining_s: 42,
      cooldown_reason: 'Repeated harness timeouts (demo fixture)',
      sessions: [],
      detail: 'Cooling down after harness timeouts (demo fixture)',
      checked_at: at(5),
      roles: ['tester'],
      capabilities: ['test'],
      config: {},
    },
  ];

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
      agents_ready: 3,
      agents_total: 4,
      tasks_total: 6,
      tasks_completed: 1,
      tasks_active: 1,
      tasks_stalled: 2,
      tasks_failed: 1,
      active_worktrees: 1,
      memory_notes: 2,
      cass_conversations: 128,
      cass_messages: 4310,
    },
    telemetry: {
      agents: {
        atlas: { total: 24, completed: 22, success_rate: 0.917, avg_latency_ms: 5200, total_tokens: 214000, prompt_tokens: 151000, completion_tokens: 63000 },
        beacon: { total: 18, completed: 14, success_rate: 0.778, avg_latency_ms: 7400, total_tokens: 156000, prompt_tokens: 110000, completion_tokens: 46000 },
        cipher: { total: 31, completed: 29, success_rate: 0.935, avg_latency_ms: 3900, total_tokens: 268000, prompt_tokens: 190000, completion_tokens: 78000 },
        delta: { total: 9, completed: 6, success_rate: 0.667, avg_latency_ms: 8100, total_tokens: 88000, prompt_tokens: 61000, completion_tokens: 27000 },
      },
      total_tokens: 726000,
    },
    members: demoMembers,
    batches: [
      {
        batch_id: 'demo-batch-01',
        total: 3,
        counts: { dispatched: 1, running: 1, completed: 1 },
        all_terminal: false,
        all_succeeded: false,
        has_stalled: false,
        has_failures: false,
        latest_at: at(3),
      },
      {
        batch_id: 'demo-batch-02',
        total: 2,
        counts: { stalled: 1, uncertain: 1 },
        all_terminal: false,
        all_succeeded: false,
        has_stalled: true,
        has_failures: true,
        latest_at: at(19),
      },
    ],
    tasks: demoTasks,
    worktrees: [
      {
        task_id: 'demo-run-01',
        branch_name: 'collab/demo/verify-gate',
        member: 'cipher',
        worktree_path: '/workspace/worktrees/demo-verify-gate',
        wsl_path: '/workspace/worktrees/demo-verify-gate',
        repo_dir: DEMO_PROJECT,
        base_ref: 'main',
        state: 'active',
        verify_status: 'passed',
        verified_head_sha: 'a1b2c3d4e5f6',
        verify_summary: 'node-test: passed (4200ms)',
        created_at: at(8),
        updated_at: at(3),
      },
    ],
    notes: [
      {
        project: 'collab-demo',
        slug: 'release-checklist',
        title: 'v1.1 release checklist',
        preview: '- Verify asset allowlist\n- Confirm CSP has no unsafe-inline scripts',
        tags: 'release,checklist',
        author: 'atlas',
        file_path: '/workspace/.collabhub/memory/demo/release-checklist.md',
        updated_at: at(40),
        content: [
          '# v1.1 release checklist',
          '',
          '## Static assets',
          '',
          '- Verify asset allowlist',
          '- Confirm CSP has no unsafe-inline scripts',
          '- Check that every file under `public/` ships with an explicit content type',
          '',
          '## Smoke test',
          '',
          '```bash',
          'node --test test/collab-hub.test.mjs',
          '```',
          '',
          'Finish the checklist before tagging the release.',
        ].join('\n'),
      },
      {
        project: 'collab-demo',
        slug: 'dag-conventions',
        title: 'DAG authoring conventions',
        preview: 'Keep steps idempotent; declare depends_on explicitly.',
        tags: 'dag,conventions',
        author: 'cipher',
        file_path: '/workspace/.collabhub/memory/demo/dag-conventions.md',
        updated_at: at(75),
        content: [
          '# DAG authoring conventions',
          '',
          'Keep steps idempotent; declare depends_on explicitly.',
          '',
          '## Rules',
          '',
          '- One step, one observable outcome.',
          '- Declare `depends_on` explicitly — never rely on declaration order.',
          '- A failed step stops its descendants, not its siblings.',
          '',
          '## Example',
          '',
          '```json',
          '{ "id": "verify", "depends_on": ["build"] }',
          '```',
        ].join('\n'),
      },
    ],
    self_improve: {
      health_score: 84,
      overall: 'degraded',
      findings_count: 2,
      healable_count: 2,
      active_lessons: 2,
      last_heal_at: at(30),
    },
    mcp_hub_summary: {
      servers_count: 4,
      registered_count: 3,
      clients_detected: 3,
      synced_pairs: 9,
      drift_count: 1,
      cached_tools_total: 14,
    },
    merge_queue: [
      {
        id: 1,
        task_id: 'demo-wt-01',
        repo_dir: DEMO_PROJECT,
        branch_name: 'collab/demo/verify-gate',
        head_sha: 'a1b2c3d4e5f6',
        base_ref: 'main',
        priority: 10,
        status: 'ready',
        member: 'cipher',
        verify_status: 'passed',
        check_summary: 'Clean speculative merge onto main (HEAD a1b2c3d4e5)',
        conflict_files: [],
        updated_at: at(2),
      },
      {
        id: 2,
        task_id: 'demo-wt-02',
        repo_dir: DEMO_PROJECT,
        branch_name: 'collab/demo/stream-router',
        head_sha: 'f9e8d7c6b5a4',
        base_ref: 'main',
        priority: 20,
        status: 'conflict',
        member: 'beacon',
        verify_status: 'passed',
        check_summary: 'Collides with preceding queued branch on src/router.mjs',
        conflict_files: ['src/router.mjs'],
        updated_at: at(1),
      },
    ],
    worktree_comments_open: 2,
  };
}

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
  let cachedDiscover = null;
  let cachedDiscoverAt = 0;
  let discoverInFlight = null;
  const DISCOVER_TTL_MS = 30000;
  const sseClients = new Map(); // res -> { hb }
  const MAX_SSE_BACKPRESSURE_BYTES = 512 * 1024;

  // Cross-process durable SSE cursor: tails SQLite `events` and `task_logs` written by MCP/CLI processes.
  // Tracks locally emitted IDs separately so a local publish never advances past an uncommitted remote row!
  let lastEventId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get()?.m || 0);
  let lastLogId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM task_logs').get()?.m || 0);
  const localEventIds = new Set();
  const localLogIds = new Set();
  let dbTailTimer = null;

  const rememberLocalId = (set, id) => {
    if (!id) return;
    set.add(id);
    if (set.size > 400) {
      const oldest = set.values().next().value;
      if (oldest !== undefined) set.delete(oldest);
    }
  };

  const broadcastSse = (evt, sseId = null) => {
    const idLine = sseId ? `id: ${sseId}\n` : '';
    const frame = `${idLine}data: ${JSON.stringify(evt)}\n\n`;
    for (const [res, meta] of sseClients.entries()) {
      if (res.destroyed || res.writableEnded || res.writableLength > MAX_SSE_BACKPRESSURE_BYTES) {
        clearInterval(meta.hb);
        sseClients.delete(res);
        try { res.destroy(); } catch {}
        continue;
      }
      try { res.write(frame); } catch {
        clearInterval(meta.hb);
        sseClients.delete(res);
      }
    }
  };

  const startDbSseTail = () => {
    if (dbTailTimer) return;
    dbTailTimer = setInterval(() => {
      if (sseClients.size === 0) {
        clearInterval(dbTailTimer);
        dbTailTimer = null;
        return;
      }
      try {
        const newEvents = db.prepare('SELECT * FROM events WHERE id > ? ORDER BY id ASC LIMIT 200').all(lastEventId);
        for (const ev of newEvents) {
          lastEventId = Math.max(lastEventId, ev.id);
          if (localEventIds.delete(ev.id)) continue;
          let payload = null;
          try { payload = ev.payload_json ? JSON.parse(ev.payload_json) : null; } catch {}
          broadcastSse({
            id: ev.id,
            type: ev.event_type,
            task_id: ev.task_id,
            actor: ev.actor,
            payload,
            created_at: ev.created_at,
            at: ev.created_at,
          }, `e${lastEventId}-l${lastLogId}`);
        }
        const newLogs = db.prepare('SELECT * FROM task_logs WHERE id > ? ORDER BY id ASC LIMIT 200').all(lastLogId);
        for (const lg of newLogs) {
          lastLogId = Math.max(lastLogId, lg.id);
          if (localLogIds.delete(lg.id)) continue;
          broadcastSse({
            log_id: lg.id,
            type: 'task.log',
            task_id: lg.task_id,
            stream: lg.stream,
            text: lg.text,
            at: lg.created_at,
          }, `e${lastEventId}-l${lastLogId}`);
        }
      } catch { /* best-effort */ }
    }, 400);
    dbTailTimer.unref();
  };

  const onHubEvent = (evt) => {
    if (evt.id) {
      rememberLocalId(localEventIds, evt.id);
    }
    if (evt.log_id) {
      rememberLocalId(localLogIds, evt.log_id);
    }
    const curEv = Math.max(lastEventId, Number(evt.id || 0));
    const curLog = Math.max(lastLogId, Number(evt.log_id || 0));
    const sseId = (evt.id || evt.log_id) ? `e${curEv}-l${curLog}` : null;
    broadcastSse(evt, sseId);
  };
  hubBus.on('hub-event', onHubEvent);

  let cachedMail = null;
  let cachedMailAt = 0;
  let cachedMcpSum = null;
  let cachedMcpSumAt = 0;

  const getCachedMail = async (force = false) => {
    const now = Date.now();
    if (!force && cachedMail && (now - cachedMailAt) < PROBE_MIN_INTERVAL_MS) return cachedMail;
    cachedMail = await probeMailHub().catch(() => ({ ok: false }));
    cachedMailAt = now;
    return cachedMail;
  };

  const getCachedMcpSummary = (force = false) => {
    const now = Date.now();
    if (!force && cachedMcpSum && (now - cachedMcpSumAt) < PROBE_MIN_INTERVAL_MS) return cachedMcpSum;
    cachedMcpSum = getMcpHubSummary(db, { clientSpecs: dispatchDeps.mcpClientSpecs });
    cachedMcpSumAt = now;
    return cachedMcpSum;
  };

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
    'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  };

  const sendJson = (res, status, obj, { compact = false } = {}) => {
    const body = compact ? JSON.stringify(obj) : JSON.stringify(obj, null, 2);
    res.writeHead(status, { ...baseHeaders, 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  };

  const sendStaticAsset = async (res, assetRef, isHead = false) => {
    const asset = typeof assetRef === 'string'
      ? { name: assetRef, filePath: path.resolve(PUBLIC_DIR, assetRef), contentType: STATIC_ASSETS.get(assetRef) }
      : assetRef;
    if (!asset || !asset.contentType) {
      sendJson(res, 404, { error: 'Not found' });
      return;
    }
    let body;
    try {
      body = await fs.readFile(asset.filePath);
    } catch (err) {
      sendJson(res, 500, { error: `Failed to read static asset ${asset.name}: ${err.code || err.message}` });
      return;
    }
    res.writeHead(200, {
      ...baseHeaders,
      'Content-Type': asset.contentType,
      'Content-Length': body.length,
    });
    res.end(isHead ? undefined : body);
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

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/') {
        await sendStaticAsset(res, 'index.html', req.method === 'HEAD');
        return;
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/assets/')) {
        await sendStaticAsset(res, resolveStaticAsset(url.pathname), req.method === 'HEAD');
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
        // Snapshot current DB tip synchronously so paginated catch-up & live handoff are 100% lossless!
        const tipEventId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM events').get()?.m || 0);
        const tipLogId = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM task_logs').get()?.m || 0);
        const lastHdr = String(req.headers['last-event-id'] || '').trim();
        let sinceEv = null;
        let sinceLog = null;
        const dualMatch = /^e(\d+)-l(\d+)$/.exec(lastHdr);
        const singleMatch = /^(ev|log)-(\d+)$/.exec(lastHdr);
        if (dualMatch) {
          sinceEv = Number(dualMatch[1]);
          sinceLog = Number(dualMatch[2]);
        } else if (singleMatch) {
          if (singleMatch[1] === 'ev') {
            sinceEv = Number(singleMatch[2]);
            // Also replay logs created at/after the last seen event's timestamp so reconnect never drops logs
            const evAnchor = db.prepare('SELECT created_at FROM events WHERE id = ?').get(sinceEv);
            if (evAnchor?.created_at) {
              sinceLog = Number(db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM task_logs WHERE created_at < ?').get(evAnchor.created_at)?.m || 0);
            } else {
              sinceLog = tipLogId;
            }
          } else {
            sinceLog = Number(singleMatch[2]);
            sinceEv = tipEventId;
          }
        }
        if (sinceEv !== null || sinceLog !== null) {
          const MAX_REPLAY_ROWS = 2000;
          let replayed = 0;
          let curEv = sinceEv ?? tipEventId;
          let curLog = sinceLog ?? tipLogId;
          try {
            while (curEv < tipEventId && replayed < MAX_REPLAY_ROWS) {
              const chunk = db.prepare('SELECT * FROM events WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT 100').all(curEv, tipEventId);
              if (!chunk.length) break;
              for (const ev of chunk) {
                curEv = ev.id;
                replayed += 1;
                let payload = null;
                try { payload = ev.payload_json ? JSON.parse(ev.payload_json) : null; } catch {}
                res.write(`id: e${curEv}-l${curLog}\ndata: ${JSON.stringify({ id: ev.id, type: ev.event_type, task_id: ev.task_id, actor: ev.actor, payload, created_at: ev.created_at, at: ev.created_at })}\n\n`);
              }
            }
            while (curLog < tipLogId && replayed < MAX_REPLAY_ROWS) {
              const chunk = db.prepare('SELECT * FROM task_logs WHERE id > ? AND id <= ? ORDER BY id ASC LIMIT 100').all(curLog, tipLogId);
              if (!chunk.length) break;
              for (const lg of chunk) {
                curLog = lg.id;
                replayed += 1;
                res.write(`id: e${curEv}-l${curLog}\ndata: ${JSON.stringify({ log_id: lg.id, type: 'task.log', task_id: lg.task_id, stream: lg.stream, text: lg.text, at: lg.created_at })}\n\n`);
              }
            }
            if (curEv < tipEventId || curLog < tipLogId) {
              res.write(`id: e${tipEventId}-l${tipLogId}\ndata: ${JSON.stringify({ type: 'sync.reset', reason: 'replay_cap_exceeded', at: new Date().toISOString() })}\n\n`);
            }
          } catch { /* best-effort replay */ }
        }
        // Align tail cursor to exact tip snapshot when first subscriber connects after idle
        if (sseClients.size === 0) {
          lastEventId = Math.max(lastEventId, tipEventId);
          lastLogId = Math.max(lastLogId, tipLogId);
        }
        const hb = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 10000);
        hb.unref();
        try { res.write('retry: 3000\n\n'); } catch {}
        sseClients.set(res, { hb });
        startDbSseTail();
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
      if (req.method === 'GET' && url.pathname === '/api/system/self-check') {
        sendJson(res, 200, diagnoseSystem(db, { worktreeDir: dispatchDeps.worktreeRoot }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/system/self-heal') {
        const parsed = await readBoundedJson(req);
        try {
          if (parsed.apply !== undefined && typeof parsed.apply !== 'boolean') {
            sendJson(res, 400, { error: 'apply must be a strict boolean (true or false)' });
            return;
          }
          sendJson(res, 200, applySelfHeal(db, {
            apply: parsed.apply === true,
            recordLessons: parsed.record_lessons !== false,
            worktreeDir: dispatchDeps.worktreeRoot,
            memoryDir: dispatchDeps.memoryDir,
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/lessons') {
        const member = url.searchParams.get('member') || null;
        const activeOnly = url.searchParams.get('active') === '1';
        sendJson(res, 200, { lessons: listIncidentLessons(db, { member, activeOnly }) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/lessons/save') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, {
            lesson: saveIncidentLesson(db, {
              project: parsed.project || '*',
              member: parsed.member || '*',
              role: parsed.role || '*',
              errorCode: parsed.error_code || '',
              pattern: parsed.pattern,
              guardrail: parsed.guardrail,
              active: parsed.active !== false,
              autoLearned: false,
            }),
          });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/lessons/toggle') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, { lesson: toggleIncidentLesson(db, parsed.id, Boolean(parsed.active)) });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
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
        const mail = await getCachedMail(true);
        sendJson(res, 200, { ok: true, version: APP_VERSION, pid: process.pid, uptime_s: Math.round(process.uptime()), db_path: DB_PATH, mail_hub: mail, toolkit: getToolkitStatus() });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/overview' && url.searchParams.get('demo') === '1') {
        // Read-only demo: answered before (and without) the real overview pipeline.
        // No DB query, no mail probe, no cass, no filesystem access.
        sendJson(res, 200, buildDemoOverview());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/cockpit') {
        const html = buildCockpitAppHtml();
        res.writeHead(200, {
          ...baseHeaders,
          'Content-Security-Policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; object-src 'none'; frame-ancestors 'none'",
          'Content-Type': 'text/html; charset=utf-8',
        });
        res.end(html);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/statusline') {
        const members = getMemberStatuses(db);
        const tasks = db.prepare('SELECT state FROM tasks ORDER BY updated_at DESC LIMIT 200').all();
        const mq = listMergeQueue(db);
        const si = getSelfImproveSummary(db, { worktreeDir: dispatchDeps.worktreeRoot });
        const mcpCount = Number(db.prepare('SELECT COUNT(*) AS c FROM mcp_servers WHERE enabled = 1').get()?.c || 0);
        const mailAge = Date.now() - cachedMailAt;
        const mailFresh = Boolean(cachedMail && mailAge < PROBE_MIN_INTERVAL_MS * 4);
        if (!mailFresh) getCachedMail().catch(() => {});
        sendJson(res, 200, {
          v: APP_VERSION,
          at: new Date().toISOString(),
          agents_ready: members.filter((m) => ['online', 'idle'].includes(m.state)).length,
          agents_total: members.length,
          fleet: members.map((m) => ({ id: m.member, s: m.state })),
          tasks_active: tasks.filter((t) => ['running', 'dispatching', 'dispatched'].includes(t.state)).length,
          tasks_failed: tasks.filter((t) => ['failed', 'stalled', 'uncertain'].includes(t.state)).length,
          merge_ready: mq.filter((q) => q.status === 'ready').length,
          merge_conflict: mq.filter((q) => q.status === 'conflict').length,
          mcp_registered: mcpCount,
          health: si.health_score,
          mail_ok: mailFresh ? Boolean(cachedMail.ok) : null,
        }, { compact: true });
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/overview') {
        const [mail, cassStats] = await Promise.all([getCachedMail(), getCachedCass()]);
        const members = getMemberStatuses(db);
        const tasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 100').all().map(parseTaskRow);
        const batches = buildBatchSummaries(tasks);
        const worktrees = listWorktrees(db);
        const notes = listMemoryNotes(db, { limit: 12 });
        const notesCount = Number(db.prepare('SELECT COUNT(*) AS c FROM memory_notes').get()?.c || notes.length);
        const metrics = buildMetrics(members, tasks, worktrees, notesCount, cassStats);
        const telemetry = computeAgentTelemetry(db, { days: 30 });
        const selfImprove = getSelfImproveSummary(db, { worktreeDir: dispatchDeps.worktreeRoot });
        const mcpHubSummary = getCachedMcpSummary();
        const mergeQueue = listMergeQueue(db);
        const openComments = Number(db.prepare("SELECT COUNT(*) AS c FROM worktree_comments WHERE status = 'open'").get()?.c || 0);
        sendJson(res, 200, {
          generated_at: new Date().toISOString(),
          mail_hub: mail,
          toolkit: getToolkitStatus(),
          metrics,
          telemetry,
          self_improve: selfImprove,
          mcp_hub_summary: mcpHubSummary,
          merge_queue: mergeQueue,
          worktree_comments_open: openComments,
          members,
          batches,
          tasks,
          worktrees,
          notes,
        });
        return;
      }
      // ---- Pillar 1: All-Agent MCP Hub & Meta-MCP Lazy Tool Proxy ----
      if (req.method === 'GET' && url.pathname === '/api/mcp-hub') {
        sendJson(res, 200, buildMcpHubSnapshot(db, { clientSpecs: dispatchDeps.mcpClientSpecs }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp-hub/register') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, { server: registerMcpServer(db, parsed, { source: 'registered' }) });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp-hub/remove') {
        const parsed = await readBoundedJson(req);
        try { sendJson(res, 200, removeMcpServer(db, parsed.id || parsed.server_id)); }
        catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp-hub/import') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, importDiscoveredMcpServers(db, {
            clientId: parsed.client_id || null,
            clientSpecs: dispatchDeps.mcpClientSpecs,
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp-hub/probe') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, await probeMcpServer(db, parsed.id || parsed.server_id, {
            clientSpecs: dispatchDeps.mcpClientSpecs,
            timeoutMs: Math.max(2000, Math.min(20000, Number(parsed.timeout_ms) || 8000)),
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/mcp-hub/snippet') {
        const clientId = url.searchParams.get('client_id') || 'antigravity';
        const rawIds = url.searchParams.get('server_ids') || '';
        const serverIds = rawIds ? rawIds.split(',').map((s) => s.trim()).filter(Boolean) : null;
        sendJson(res, 200, generateClientSnippet(db, { clientId, serverIds, clientSpecs: dispatchDeps.mcpClientSpecs }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp-hub/sync') {
        const parsed = await readBoundedJson(req);
        try {
          if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
            sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
            return;
          }
          sendJson(res, 200, syncMcpToClient(db, {
            clientId: parsed.client_id,
            serverIds: Array.isArray(parsed.server_ids) ? parsed.server_ids : null,
            confirmed: parsed.confirmed === true,
            clientSpecs: dispatchDeps.mcpClientSpecs,
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/mcp-hub/tools') {
        const query = url.searchParams.get('q') || '';
        const serverId = url.searchParams.get('server_id') || null;
        const searchIn = url.searchParams.get('search_in') || 'both';
        const limit = Number(url.searchParams.get('limit')) || 40;
        sendJson(res, 200, findMcpTools(db, { query, serverId, searchIn, limit }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/mcp-hub/call') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, await callMcpServerTool(db, {
            serverId: parsed.server_id,
            toolName: parsed.tool_name,
            toolArgs: parsed.arguments || parsed.tool_args || {},
            clientSpecs: dispatchDeps.mcpClientSpecs,
            timeoutMs: Number(parsed.timeout_ms) || 15000,
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      // ---- Pillar 2: Cross-Agent Skills & Rules Sync Hub ----
      if (req.method === 'GET' && url.pathname === '/api/skills-hub') {
        const projectDir = url.searchParams.get('project_dir') || dispatchDeps.workspaceRoot;
        sendJson(res, 200, buildSkillsRulesSnapshot({
          projectDir,
          skillAdapters: dispatchDeps.skillAdapters,
          workspaceRoot: dispatchDeps.workspaceRoot,
        }));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/skills-hub/sync-skill') {
        const parsed = await readBoundedJson(req);
        try {
          if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
            sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
            return;
          }
          sendJson(res, 200, syncSkillAcrossClients(db, {
            skillName: parsed.skill_name,
            sourceClient: parsed.source_client,
            targetClients: Array.isArray(parsed.target_clients) ? parsed.target_clients : [],
            confirmed: parsed.confirmed === true,
            skillAdapters: dispatchDeps.skillAdapters,
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/skills-hub/sync-rule') {
        const parsed = await readBoundedJson(req);
        try {
          if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
            sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
            return;
          }
          sendJson(res, 200, syncRuleAcrossTargets(db, {
            projectDir: parsed.project_dir || dispatchDeps.workspaceRoot,
            sourceRuleId: parsed.source_rule_id || 'agents-md',
            targetRuleIds: Array.isArray(parsed.target_rule_ids) ? parsed.target_rule_ids : [],
            confirmed: parsed.confirmed === true,
            workspaceRoot: dispatchDeps.workspaceRoot,
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      // ---- Pillar 3: Worktree Inline Diff Comments + Serialized Merge Queue ----
      if (req.method === 'GET' && url.pathname === '/api/worktrees/comments') {
        const taskId = url.searchParams.get('task_id') || null;
        try { sendJson(res, 200, { comments: listWorktreeComments(db, taskId) }); }
        catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/worktrees/comments/add') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, {
            comment: addWorktreeComment(db, {
              taskId: parsed.task_id,
              filePath: parsed.file_path,
              lineNo: parsed.line_no ?? null,
              side: parsed.side || 'new',
              author: parsed.author || 'reviewer',
              body: parsed.body,
            }),
          });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/worktrees/comments/resolve') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, {
            comment: resolveWorktreeComment(db, { commentId: parsed.comment_id, status: parsed.status || 'resolved' }),
          });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/worktrees/rework') {
        const parsed = await readBoundedJson(req);
        try {
          const result = await dispatchWorktreeRework(db, {
            taskId: parsed.task_id,
            member: parsed.member || null,
            extraNote: parsed.extra_note || '',
            asyncRun: parsed.async !== false,
          }, dispatchDeps);
          sendJson(res, 202, result);
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/merge-queue') {
        sendJson(res, 200, { queue: listMergeQueue(db) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/merge-queue/enqueue') {
        const parsed = await readBoundedJson(req);
        try {
          sendJson(res, 200, {
            item: enqueueMergeQueue(db, {
              taskId: parsed.task_id,
              priority: parsed.priority ?? 100,
              verifyPreset: parsed.verify_preset || 'auto',
            }),
          });
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/merge-queue/remove') {
        const parsed = await readBoundedJson(req);
        try { sendJson(res, 200, removeMergeQueueItem(db, { taskId: parsed.task_id })); }
        catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/merge-queue/validate') {
        await readBoundedJson(req);
        try { sendJson(res, 200, validateMergeQueue(db)); }
        catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/merge-queue/process') {
        const parsed = await readBoundedJson(req);
        try {
          if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
            sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
            return;
          }
          sendJson(res, 200, processMergeQueue(db, {
            confirmed: parsed.confirmed === true,
            requireVerified: Boolean(parsed.require_verified),
            cleanup: parsed.cleanup !== false,
            stopOnFailure: parsed.stop_on_failure !== false,
          }));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/agents/discover') {
        const now = Date.now();
        const force = url.searchParams.get('force') === '1';
        if (!force && cachedDiscover && (now - cachedDiscoverAt) < DISCOVER_TTL_MS) {
          sendJson(res, 200, { ...cachedDiscover, cached: true });
          return;
        }
        if (!discoverInFlight) {
          discoverInFlight = discoverLocalAgents(db, dispatchDeps)
            .then((data) => { cachedDiscover = data; cachedDiscoverAt = Date.now(); return data; })
            .finally(() => { discoverInFlight = null; });
        }
        sendJson(res, 200, await discoverInFlight);
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
      if (req.method === 'GET' && url.pathname === '/api/tasks/logs') {
        const rawId = url.searchParams.get('task_id') || '';
        if (!rawId) { sendJson(res, 400, { error: 'task_id is required' }); return; }
        try {
          sendJson(res, 200, getTaskLogs(rawId, db));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/api/tasks/')) {
        const rawId = decodeURIComponent(url.pathname.slice('/api/tasks/'.length));
        const safeId = assertValidTaskId(rawId, 'task_id');
        const task = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(safeId));
        if (!task) { sendJson(res, 404, { error: 'Task not found' }); return; }
        const events = db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 40').all(safeId);
        sendJson(res, 200, { task, events, live_logs: getTaskLogs(safeId, db) });
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/cancel') {
        const parsed = await readBoundedJson(req);
        if (!parsed.task_id) { sendJson(res, 400, { error: 'task_id is required' }); return; }
        try {
          sendJson(res, 200, await cancelTask(db, parsed.task_id, {
            reason: parsed.reason || 'Cancelled from workbench',
            force: Boolean(parsed.force),
          }, dispatchDeps));
        } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/tasks/dispatch') {
        const parsed = await readBoundedJson(req);
        try {
          const isAsync = parsed.async === true;
          const task = await dispatchBackgroundTask(db, {
            taskId: parsed.task_id || null,
            member: parsed.member,
            role: parsed.role || 'researcher',
            projectDir: parsed.project_dir,
            title: parsed.title,
            prompt: parsed.prompt,
            batchId: parsed.batch_id || null,
            autoFallback: Boolean(parsed.auto_fallback),
            injectGuardrails: parsed.inject_guardrails !== false,
            asyncRun: isAsync,
            waitSec: 0,
          }, dispatchDeps);
          sendJson(res, isAsync ? 202 : 200, { task });
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
      if (req.method === 'POST' && url.pathname === '/api/workflows/resume') {
        const parsed = await readBoundedJson(req);
        if (!parsed.batch_id) { sendJson(res, 400, { error: 'batch_id is required' }); return; }
        try {
          const result = await resumeDagWorkflow(db, {
            batchId: parsed.batch_id,
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
          const merged = mergeWorktree(db, {
            taskId: parsed.task_id,
            confirmed: parsed.confirmed === true,
            cleanup: parsed.cleanup !== false,
            requireVerified: Boolean(parsed.require_verified),
          });
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

  const cleanupSse = () => {
    hubBus.off('hub-event', onHubEvent);
    if (dbTailTimer) { clearInterval(dbTailTimer); dbTailTimer = null; }
    for (const [res, meta] of sseClients.entries()) {
      clearInterval(meta.hb);
      try { res.end(); } catch {}
    }
    sseClients.clear();
  };

  server.shutdown = async ({ drainMs = 3000 } = {}) => {
    cleanupSse();
    await new Promise((resolve) => server.close(() => resolve()));
    await awaitActiveRuns(db, { timeoutMs: drainMs });
  };
  server.on('close', cleanupSse);

  return server;
}

export function startReadOnlyAutoPoller(db) {
  let busy = false;
  let timer = null;
  let stopped = false;
  const tick = async () => {
    if (stopped || busy) return;
    busy = true;
    let activeCount = 0;
    try {
      sweepOrphanTasks(db);
      const running = db.prepare(`
        SELECT task_id FROM tasks
        WHERE state = 'running' AND channel IN ('dsh-baton', 'muse-tailnet', 'claude-cli')
        ORDER BY updated_at ASC LIMIT 6
      `).all();
      activeCount = running.length;
      for (const r of running) {
        await pollBackgroundTask(db, r.task_id, { waitSec: 0 }).catch(() => {});
      }
    } catch { /* best-effort */ }
    finally {
      busy = false;
      if (!stopped) {
        const delayMs = activeCount > 0 ? 6000 : AUTO_POLL_INTERVAL_MS;
        timer = setTimeout(tick, delayMs);
        timer.unref();
      }
    }
  };
  timer = setTimeout(tick, 6000);
  timer.unref();
  return { stop() { stopped = true; if (timer) clearTimeout(timer); } };
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
  pruneRetentionTables(db);
  sweepOrphanTasks(db);
  const server = createDashboardServer(db);
  let poller = null;
  let cassTimer = null;
  const gracefulExit = async () => {
    poller?.stop();
    if (cassTimer) clearInterval(cassTimer);
    await server.shutdown();
    try { db.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', gracefulExit);
  process.on('SIGTERM', gracefulExit);
  server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
    console.log(JSON.stringify({ event: 'dashboard.listening', version: APP_VERSION, url: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`, pid: process.pid }));
    probeAllMembers(db).catch(() => {});
    poller = startReadOnlyAutoPoller(db);
    cassTimer = startPeriodicCassRefresh();
  });
}
