import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { APP_VERSION, ensureRuntimeDirs, MAIL_BASE_URL, DASHBOARD_HOST, DASHBOARD_PORT, WORKSPACE_ROOT } from './config.mjs';
import {
  clearMemberCooldown, getMemberStatuses, openHubDb, parseTaskRow, setMemberCooldown, touchPassiveDesktopHeartbeat,
} from './db.mjs';
import { deleteArtifact, getArtifact, listArtifacts, pruneExpiredArtifacts, putArtifact } from './artifacts.mjs';
import { deleteBudgetPolicy, evaluateBudget, listBudgetPolicies, setBudgetPolicy } from './budget.mjs';
import { createConsensusRound, listConsensusRounds, recordConsensusVote, synthesizeConsensus } from './consensus.mjs';
import { buildHandoffPack } from './handoff-pack.mjs';
import {
  cancelTask, dispatchBackgroundTask, getTaskLogs, pollBackgroundTask, pollBatchTasks, reconcileTask, recordNativeHandoff,
} from './executors.mjs';
import { discoverLocalAgents } from './discovery.mjs';
import { createHotBackup, listWorkspaceProjects, runSystemDoctor } from './doctor.mjs';
import { postMailUpdate, releaseMailPaths, reserveMailPaths } from './mail-sync.mjs';
import { COCKPIT_RESOURCE_URI, MCP_APP_MIME_TYPE, buildCockpitAppHtml, formatCyberHudCard } from './mcp-app-ui.mjs';
import {
  buildMcpHubSnapshot, callMcpServerTool, findMcpTools, generateClientSnippet,
  getMcpHubSummary, importDiscoveredMcpServers, probeMcpServer, registerMcpServer, removeMcpServer, syncMcpToClient,
} from './mcp-hub.mjs';
import { listMemoryNotes, searchMemoryNotes, writeMemoryNote } from './memory.mjs';
import {
  addWorktreeComment, dispatchWorktreeRework, enqueueMergeQueue, listMergeQueue,
  listWorktreeComments, processMergeQueue, removeMergeQueueItem, resolveWorktreeComment, validateMergeQueue,
} from './merge-queue.mjs';
import { runPlaybook } from './playbooks.mjs';
import { planDispatch, probeAllMembers } from './prober.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from './recipes.mjs';
import { listAgents, registerAgent, removeAgent } from './registry.mjs';
import {
  applySelfHeal, diagnoseSystem, getSelfImproveSummary, listIncidentLessons, reconcileStaleTasks, saveIncidentLesson, toggleIncidentLesson,
} from './self-improve.mjs';
import { buildSkillsRulesSnapshot, syncRuleAcrossTargets, syncSkillAcrossClients } from './skills-hub.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';
import {
  convertDocToMd, getToolkitStatus, packRepoRepomix, runBeads, searchAstGrep, searchSessionsCass,
} from './toolkit.mjs';
import { deleteTrigger, listTriggers, runTriggerNow, saveTrigger } from './triggers.mjs';
import {
  appendRoomLog, claimRoomPath, createCollabRoom, getRoomStatus, listCollabRooms,
  promoteInboxFile, reconcileStaleClaimsInAllRooms, releaseRoomClaim, renewRoomClaim,
} from './workspace-room.mjs';
import { buildBatchMarkdownReport, resumeDagWorkflow, runDagWorkflow } from './workflows.mjs';
import { cleanupWorktree, createWorktree, listWorktrees, mergeWorktree, reviewWorktree, verifyWorktree } from './worktree.mjs';

const COCKPIT_TOOL_META = Object.freeze({
  ui: { resourceUri: COCKPIT_RESOURCE_URI },
  'ui/resourceUri': COCKPIT_RESOURCE_URI,
  'com.google.antigravity/ui': {
    entrypoints: [
      { type: 'aux_pane', title: 'CollabHub Cockpit' },
      { type: 'global', title: 'CollabHub' },
    ],
  },
});

const INLINE_COCKPIT_META = Object.freeze({
  ui: { resourceUri: COCKPIT_RESOURCE_URI },
  'ui/resourceUri': COCKPIT_RESOURCE_URI,
});

export const MCP_APP_RESOURCES = Object.freeze([
  {
    uri: COCKPIT_RESOURCE_URI,
    name: 'CollabHub Neural Mission Cockpit',
    description: 'Interactive 60fps animated multi-agent Mission Control UI (Fleet Radar, Kanban & Logs, MCP Hub, Skills & Rules, Merge Queue) for Antigravity, Claude Desktop, and Codex Desktop.',
    mimeType: MCP_APP_MIME_TYPE,
    _meta: { ui: { prefersBorder: false } },
  },
]);

export const TOOLS = Object.freeze([
  {
    name: 'collab_cockpit',
    title: 'CollabHub Cockpit',
    description: 'Open the interactive animated CollabHub Neural Mission Control Cockpit natively inside Antigravity (inline / side pane / global sidebar), Claude Desktop, or Codex Desktop — with graceful Cyber-HUD text card fallback for terminal hosts.',
    _meta: COCKPIT_TOOL_META,
    inputSchema: {
      type: 'object',
      properties: {
        tab: { type: 'string', enum: ['radar', 'tasks', 'mcp', 'skills', 'queue'], description: 'Optional initial cockpit tab (default radar).' },
        project_dir: { type: 'string', description: 'Optional workspace/project directory for Skills & Rules scan.' },
      },
    },
  },
  {
    name: 'collab_cockpit_state',
    title: 'CollabHub Cockpit Live State',
    description: 'App-only fast state refresh for the embedded CollabHub MCP App Cockpit (hidden from LLM tool list).',
    _meta: { ui: { visibility: ['app'] } },
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_roster',
    _meta: INLINE_COCKPIT_META,
    description: 'Live-probe ALL registered agents (built-in Codex/AGY/Claude/DSH/Muse + any custom generic-cli/openai-http/desktop-native agents), verified Mail Hub, and installed GitHub toolkit status.',
    inputSchema: {
      type: 'object',
      properties: {
        desktop_observations: { type: 'object', description: 'Optional live Desktop session snapshots keyed by agent id.' },
      },
    },
  },
  {
    name: 'collab_plan',
    description: 'Recommend the best currently fresh & online agent for a role across ALL registered agents, skipping offline, dormant, stale, unknown, or channel-cooldown agents.',
    inputSchema: {
      type: 'object',
      required: ['role'],
      properties: {
        role: { type: 'string', enum: ['planner', 'researcher', 'implementer', 'tester', 'reviewer', 'synthesizer'] },
        prefer: { type: 'array', items: { type: 'string' } },
        exclude: { type: 'array', items: { type: 'string' } },
        require_local_files: { type: 'boolean' },
        require_linux: { type: 'boolean' },
        require_background_auto: { type: 'boolean' },
      },
    },
  },
  {
    name: 'collab_agent_register',
    description: 'Dynamically register or update ANY new agent (generic-cli like gemini/aider/opencode, openai-http like Ollama/LM Studio/gateway reading key from api_key_env, or desktop-native like Cursor/Windsurf). Never stores plaintext API keys.',
    inputSchema: {
      type: 'object',
      required: ['agent_id', 'name', 'driver'],
      properties: {
        agent_id: { type: 'string', description: 'Lowercase id, e.g. "gemini-cli", "ollama-qwen", "aider", "cursor".' },
        name: { type: 'string' },
        driver: { type: 'string', enum: ['generic-cli', 'openai-http', 'desktop-native'] },
        roles: { type: 'array', items: { type: 'string' } },
        capabilities: { type: 'array', items: { type: 'string' } },
        config: { type: 'object', description: 'Driver config: generic-cli {command, args, prompt_mode, timeout_s}; openai-http {base_url, model, api_key_env, system_prompt, max_tokens}.' },
        enabled: { type: 'boolean' },
      },
    },
  },
  {
    name: 'collab_agent_list',
    description: 'Fast local query listing all registered built-in and custom agents (with drivers, roles, capabilities, enabled state) without running slow external probes.',
    inputSchema: {
      type: 'object',
      properties: {
        include_disabled: { type: 'boolean' },
      },
    },
  },
  {
    name: 'collab_agent_remove',
    description: 'Remove a custom registered agent (or disable a built-in agent without deleting history).',
    inputSchema: {
      type: 'object',
      required: ['agent_id'],
      properties: {
        agent_id: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_dispatch',
    description: 'Idempotently dispatch a bounded background task to ANY background-capable registered agent (dsh, muse, claude CLI, generic-cli, or openai-http). Supports depends_on DAG gate, auto_inject_context, reserve_paths file leases, and isolated worktrees.',
    inputSchema: {
      type: 'object',
      required: ['member', 'project_dir', 'prompt'],
      properties: {
        task_id: { type: 'string' },
        batch_id: { type: 'string' },
        parent_task_id: { type: 'string' },
        depends_on: { type: 'array', items: { type: 'string' } },
        auto_inject_context: { type: 'boolean' },
        auto_fallback: { type: 'boolean', description: 'Pre-dispatch fallback to next online background agent if requested member is offline or in 429 cooldown (never resends already-sent tasks).' },
        reserve_paths: { type: 'array', items: { type: 'string' } },
        allow_lease_conflict: { type: 'boolean' },
        member: { type: 'string', description: 'Any registered background-capable agent_id (or "auto" to auto-route via telemetry-aware collab_plan).' },
        role: { type: 'string', enum: ['planner', 'researcher', 'implementer', 'tester', 'reviewer', 'synthesizer'] },
        project_dir: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        worktree_path: { type: 'string' },
        branch_name: { type: 'string' },
        mail_message_id: { type: 'string' },
        wait_sec: { type: 'integer', minimum: 0, maximum: 60 },
      },
    },
  },
  {
    name: 'collab_poll',
    description: 'Inspect or wait for an existing background task receipt without ever re-sending. Surfaces Muse relay_note / DSH harness_down as stalled and self-heals crash-interrupted Muse/Claude tasks.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        wait_sec: { type: 'integer', minimum: 0, maximum: 60 },
      },
    },
  },
  {
    name: 'collab_poll_batch',
    description: 'Concurrently poll all active background tasks in a batch_id, explicitly separating all_terminal vs all_succeeded.',
    inputSchema: {
      type: 'object',
      required: ['batch_id'],
      properties: {
        batch_id: { type: 'string' },
        wait_sec: { type: 'integer', minimum: 0, maximum: 60 },
      },
    },
  },
  {
    name: 'collab_task_reconcile',
    description: 'Attach a recovered external_id/session_id to a crash-interrupted task or close a stuck stalled/needs_input/uncertain task without ever resending.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        external_id: { type: 'string' },
        session_id: { type: 'string' },
        state: { type: 'string', enum: ['running', 'stalled', 'uncertain', 'failed', 'rerouted', 'completed'] },
        result_text: { type: 'string' },
        note: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_record_handoff',
    description: 'Single-call ledger recording strictly for genuine native Desktop bridge handoffs (codex/agy/claude or custom desktop-native agents).',
    inputSchema: {
      type: 'object',
      required: ['member', 'state'],
      properties: {
        task_id: { type: 'string' },
        batch_id: { type: 'string' },
        parent_task_id: { type: 'string' },
        member: { type: 'string' },
        role: { type: 'string', enum: ['planner', 'researcher', 'implementer', 'tester', 'reviewer', 'synthesizer'] },
        project_dir: { type: 'string' },
        title: { type: 'string' },
        prompt: { type: 'string' },
        request_id: { type: 'string' },
        session_id: { type: 'string' },
        mail_message_id: { type: 'string' },
        state: { type: 'string', enum: ['created', 'dispatched', 'running', 'needs_input', 'uncertain', 'completed', 'failed', 'rerouted'] },
        worktree_path: { type: 'string' },
        branch_name: { type: 'string' },
        result_text: { type: 'string' },
        evidence: { description: 'Verified evidence object or array' },
        error_code: { type: 'string' },
        error_message: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_tasks',
    description: 'Query tasks in the unified collaboration ledger by batch_id, member, state, or task_id.',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        batch_id: { type: 'string' },
        member: { type: 'string' },
        state: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'collab_cooldown',
    description: 'View, set (channel-scoped), or clear cooldown status for any registered agent.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['status', 'set', 'clear'] },
        member: { type: 'string' },
        channel: { type: 'string' },
        seconds: { type: 'integer', minimum: 10, maximum: 86400 },
        reason: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_worktree_create',
    description: 'Create an isolated Git worktree and branch (auto-syncing `.worktreeinclude` files) and auto-reserve advisory lease in mcp-agent-mail.',
    inputSchema: {
      type: 'object',
      required: ['repo_dir', 'task_id', 'member'],
      properties: {
        repo_dir: { type: 'string' },
        task_id: { type: 'string' },
        member: { type: 'string' },
        base_ref: { type: 'string' },
        reserve_paths: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'collab_worktree_review',
    description: 'Summarize commits, stats, and diff preview for an isolated worktree and bind its reviewed HEAD SHA.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        max_diff_chars: { type: 'integer', minimum: 500, maximum: 50000 },
      },
    },
  },
  {
    name: 'collab_worktree_verify',
    description: 'Closed-loop test verification gate inside an isolated worktree using safe allowlisted presets (auto, node-test, npm-test, pytest, cargo-test, go-test; shell: false). Records verified_head_sha and pass/fail status.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        preset: { type: 'string', enum: ['auto', 'node-test', 'npm-test', 'pytest', 'cargo-test', 'go-test'] },
        timeout_sec: { type: 'integer', minimum: 5, maximum: 300 },
      },
    },
  },
  {
    name: 'collab_worktree_merge',
    description: 'Merge a clean, reviewed worktree branch into its exact base_ref (verifying reviewed HEAD SHA) and release Mail leases. Requires confirmed=true.',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'confirmed'],
      properties: {
        task_id: { type: 'string' },
        confirmed: { type: 'boolean' },
        cleanup: { type: 'boolean' },
      },
    },
  },
  {
    name: 'collab_worktree_cleanup',
    description: 'Remove an isolated worktree directory and release Mail leases.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        force: { type: 'boolean' },
        delete_branch: { type: 'boolean' },
      },
    },
  },
  {
    name: 'collab_memory_write',
    description: 'Atomically write or update a shared project memory note (Markdown + SQLite FTS5) and broadcast summary to mcp-agent-mail.',
    inputSchema: {
      type: 'object',
      required: ['project', 'title', 'content'],
      properties: {
        project: { type: 'string' },
        slug: { type: 'string' },
        title: { type: 'string' },
        content: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        author: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_memory_search',
    description: 'Search shared project memory notes in Chinese or English.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        project: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
    },
  },
  {
    name: 'collab_memory_list',
    description: 'List recent shared project memory notes.',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'collab_session_search',
    description: 'Read-only cross-client coding session history search via cass.exe (Codex / Claude Code / Gemini / etc.). Never modifies client accounts or sessions.',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 30 },
        agent: { type: 'string', description: 'Optional agent filter (e.g. codex, claude_code).' },
      },
    },
  },
  {
    name: 'collab_repo_pack',
    description: 'Safely pack a project directory into a compressed Markdown/XML context bundle via repomix (ideal for feeding remote Cloud Muse or HTTP reviewers).',
    inputSchema: {
      type: 'object',
      required: ['project_dir'],
      properties: {
        project_dir: { type: 'string' },
        include: { type: 'string', description: 'Optional glob pattern, e.g. "src/**/*.mjs".' },
        ignore: { type: 'string' },
        style: { type: 'string', enum: ['markdown', 'xml', 'plain'] },
        compress: { type: 'boolean' },
        max_chars: { type: 'integer', minimum: 2000, maximum: 120000 },
      },
    },
  },
  {
    name: 'collab_ast_search',
    description: 'Run fast read-only AST structural code search via ast-grep (sg/ast-grep.exe) jailed to an allowed project directory.',
    inputSchema: {
      type: 'object',
      required: ['project_dir', 'pattern'],
      properties: {
        project_dir: { type: 'string' },
        pattern: { type: 'string', description: 'AST pattern, e.g. "export async function $NAME($$$) { $$$ }".' },
        lang: { type: 'string', description: 'Optional language hint (js, ts, py, rs, go).' },
        max_matches: { type: 'integer', minimum: 1, maximum: 200 },
      },
    },
  },
  {
    name: 'collab_beads',
    description: 'Manage Git-native long-horizon issues & dependency graphs via steveyegge/beads (bd.exe) inside a project directory.',
    inputSchema: {
      type: 'object',
      required: ['project_dir', 'action'],
      properties: {
        project_dir: { type: 'string' },
        action: { type: 'string', enum: ['init', 'list', 'ready', 'show', 'create', 'close'] },
        title: { type: 'string' },
        description: { type: 'string' },
        issue_id: { type: 'string' },
        status: { type: 'string' },
        priority: { type: 'integer', minimum: 0, maximum: 4 },
      },
    },
  },
  {
    name: 'collab_doc_to_md',
    description: 'Convert a local PDF, DOCX, XLSX, PPTX, or HTML file inside an allowed project directory to bounded Markdown via microsoft/markitdown.',
    inputSchema: {
      type: 'object',
      required: ['file_path'],
      properties: {
        file_path: { type: 'string' },
        max_chars: { type: 'integer', minimum: 1000, maximum: 120000 },
      },
    },
  },
  {
    name: 'collab_playbook_run',
    description: 'Run a practical one-click multi-agent workflow playbook: "code-review-squad", "research-and-pack", "adversarial-debate" (2-agent advocate vs red-team + synthesizer), or "multi-agent-build" (isolated worktree + lease + implementer).',
    inputSchema: {
      type: 'object',
      required: ['playbook', 'project_dir'],
      properties: {
        playbook: { type: 'string', enum: ['code-review-squad', 'research-and-pack', 'adversarial-debate', 'multi-agent-build'] },
        project_dir: { type: 'string' },
        goal: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
        include: { type: 'string' },
        ast_pattern: { type: 'string' },
        ast_lang: { type: 'string' },
        doc_path: { type: 'string' },
        session_query: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_agent_discover',
    description: 'Safely auto-discover locally running OpenAI-compatible servers (Ollama, LM Studio, vLLM), installed external Agent CLIs (gemini, aider, opencode, qwen), and boolean API-key env readiness without ever exposing secrets.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'collab_workflow_run',
    description: 'Run a custom multi-stage DAG workflow across any registered background agents with automatic topological wave execution, upstream context injection, and optional batch report saved to shared memory.',
    inputSchema: {
      type: 'object',
      required: ['project_dir', 'steps'],
      properties: {
        name: { type: 'string' },
        batch_id: { type: 'string' },
        project_dir: { type: 'string' },
        wait_sec: { type: 'integer', minimum: 0, maximum: 45 },
        save_report_to_memory: { type: 'boolean' },
        steps: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'member', 'prompt'],
            properties: {
              id: { type: 'string' },
              member: { type: 'string' },
              role: { type: 'string' },
              title: { type: 'string' },
              prompt: { type: 'string' },
              depends_on: { type: 'array', items: { type: 'string' } },
              auto_inject_context: { type: 'boolean' },
              reserve_paths: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
  {
    name: 'collab_batch_report',
    description: 'Generate a clean, shareable Markdown synthesis report for any batch_id combining all agent outputs, receipts, and states.',
    inputSchema: {
      type: 'object',
      required: ['batch_id'],
      properties: {
        batch_id: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_metrics',
    description: 'Compute real per-agent reliability telemetry (success rate, average latency, 429 cooldowns, active/stalled counts) from the SQLite task ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 365 },
      },
    },
  },
  {
    name: 'collab_recipes',
    description: 'Manage reusable prompt recipes/templates (built-in security redteam, PR review, perf audit, test coverage, architecture refactor, Chinese docs + custom user recipes).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'delete'] },
        recipe_id: { type: 'string' },
        title: { type: 'string' },
        role: { type: 'string' },
        tags: { type: 'string' },
        prompt: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_doctor',
    description: 'Run an 8-point CollabHub system health & integrity check (SQLite integrity, Mail Hub, 5 GitHub binaries, cass archive, roster, stuck tasks, worktrees, provenance) and optionally take a safe hot SQLite backup snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        backup: { type: 'boolean', description: 'When true, also creates a safe VACUUM INTO hot backup in <APP_ROOT>/backups.' },
      },
    },
  },
  {
    name: 'collab_cancel',
    description: 'Cancel an active background task: terminates running local CLI process trees, aborts in-flight HTTP requests, sends upstream DSH cancel, and records cancelled state + audit log.',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        reason: { type: 'string', description: 'Optional cancellation reason recorded in the receipt ledger.' },
        force: { type: 'boolean', description: 'Only set true after verifying an out-of-process/remote task has already stopped.' },
      },
    },
  },
  {
    name: 'collab_workflow_resume',
    description: 'Resume a partially failed, cancelled, or stalled DAG workflow batch from checkpoint — preserves completed steps and retries only failed/downstream steps with append-only retry task IDs.',
    inputSchema: {
      type: 'object',
      required: ['batch_id'],
      properties: {
        batch_id: { type: 'string' },
        wait_sec: { type: 'number', description: 'Optional wait window per wave (0-45s, default 15).' },
        save_report_to_memory: { type: 'boolean', description: 'Save Markdown synthesis report to shared memory when all steps complete (default true).' },
      },
    },
  },
  {
    name: 'collab_self_check',
    description: 'Run CollabHub runtime self-diagnosis (0-100 health score, dead-owner orphans, stuck tasks, expired cooldowns, missing worktrees, repeating error clusters, circuit-breaker alerts, WAL size, learned guardrails, and recent self-heal runs).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'collab_self_heal',
    description: 'Preview (apply=false, default) or execute (apply=true) safe operational self-healing: sweep dead-owner orphans, clear expired cooldowns, reconcile missing worktrees, extract incident lessons, WAL checkpoint, or batch-reconcile stale tasks (action="reconcile_stale").',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['heal', 'reconcile_stale'], description: 'Default "heal". Use "reconcile_stale" to preview/archive aged non-terminal tasks.' },
        apply: { type: 'boolean', description: 'Default false (dry-run preview). Set true to execute safe operational heals.' },
        confirmed: { type: 'boolean', description: 'Required true when action="reconcile_stale" to persist state changes.' },
        task_ids: { type: 'array', items: { type: 'string' }, description: 'Optional specific stale task IDs to reconcile.' },
        resolution: { type: 'string', enum: ['cancelled', 'completed'], description: 'Target state for reconciled stale tasks (default "cancelled").' },
        note: { type: 'string', description: 'Optional reconciliation note recorded on each task.' },
        record_lessons: { type: 'boolean', description: 'Extract repeating failure clusters into incident_lessons and shared memory (default true).' },
      },
    },
  },
  {
    name: 'collab_lessons',
    description: 'Manage learned runtime incident guardrails injected as bounded advisory context into future agent prompts (list, save, or toggle active/paused).',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'save', 'toggle'] },
        id: { type: 'integer', description: 'Lesson id (required for toggle).' },
        active: { type: 'boolean', description: 'Active flag (for toggle or save).' },
        project: { type: 'string', description: 'Project basename or * (default *).' },
        member: { type: 'string', description: 'Agent id or * (default *).' },
        role: { type: 'string', description: 'Role or * (default *).' },
        error_code: { type: 'string' },
        pattern: { type: 'string' },
        guardrail: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_mcp_hub',
    description: 'All-Agent MCP Hub: scan/compare Antigravity, Codex, Claude Code, Cursor, Windsurf, VS Code MCP configs (zero-secret), register/import/probe servers, generate copyable JSON/TOML snippets, or run Dry-Run / confirmed `.bak`-backed safe client config sync.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['snapshot', 'register', 'remove', 'import', 'probe', 'snippet', 'sync'] },
        id: { type: 'string' },
        name: { type: 'string' },
        transport: { type: 'string', enum: ['stdio', 'http', 'sse'] },
        command: { type: 'string' },
        args: { type: 'array', items: { type: 'string' } },
        url: { type: 'string' },
        env_keys: { type: 'array', items: { type: 'string' } },
        header_keys: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        group_name: { type: 'string' },
        client_id: { type: 'string' },
        server_ids: { type: 'array', items: { type: 'string' } },
        confirmed: { type: 'boolean', description: 'Must be true to write synced client config (default false = read-only dry-run diff preview).' },
      },
    },
  },
  {
    name: 'collab_mcp_find_tools',
    description: 'Meta-MCP lazy tool discovery (adapted from warpdev/mcp-hub-mcp): search cached tool catalogs across all probed MCP servers by keyword without polluting agent context windows.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword or substring to match against tool names, descriptions, or server IDs.' },
        server_id: { type: 'string' },
        search_in: { type: 'string', enum: ['both', 'name', 'description'] },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'collab_mcp_call_tool',
    description: 'Meta-MCP on-demand tool proxy (adapted from warpdev/mcp-hub-mcp): invoke a specific tool on any registered/probed MCP server lazily with scrubbed env and SSRF protection.',
    inputSchema: {
      type: 'object',
      required: ['server_id', 'tool_name'],
      properties: {
        server_id: { type: 'string' },
        tool_name: { type: 'string' },
        arguments: { type: 'object' },
        timeout_ms: { type: 'integer', minimum: 2000, maximum: 30000 },
      },
    },
  },
  {
    name: 'collab_skills_hub',
    description: 'Cross-Agent Skills & Rules Sync Hub (adapted from lbb00/ai-rules-sync & fALECX/shareskills): inspect SKILL.md and AGENTS.md/CLAUDE.md/GEMINI.md/.cursor/rules drift across clients, preview Dry-Run diffs, and apply `.bak`-backed sync when confirmed=true.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['snapshot', 'sync_skill', 'sync_rule'] },
        project_dir: { type: 'string' },
        skill_name: { type: 'string' },
        source_client: { type: 'string' },
        target_clients: { type: 'array', items: { type: 'string' } },
        source_rule_id: { type: 'string' },
        target_rule_ids: { type: 'array', items: { type: 'string' } },
        confirmed: { type: 'boolean', description: 'Must be true to write synced files (default false = dry-run preview).' },
      },
    },
  },
  {
    name: 'collab_worktree_comments',
    description: 'Worktree inline diff review comments & targeted rework dispatch (inspired by BloopAI/vibe-kanban): list, add, resolve line comments, or dispatch open comments directly back to the owning agent for rework.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'add', 'resolve', 'dispatch_rework'] },
        task_id: { type: 'string' },
        file_path: { type: 'string' },
        line_no: { type: 'integer' },
        side: { type: 'string', enum: ['new', 'old', 'file'] },
        author: { type: 'string' },
        body: { type: 'string' },
        comment_id: { type: 'integer' },
        status: { type: 'string', enum: ['open', 'sent', 'resolved'] },
        member: { type: 'string' },
        extra_note: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_merge_queue',
    description: 'Serialized Agent Merge Queue: enqueue isolated worktrees, run side-effect-free speculative `git merge-tree` conflict detection across queued branches, and serially merge ready worktrees into base_ref when confirmed=true.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['list', 'enqueue', 'remove', 'validate', 'process'] },
        task_id: { type: 'string' },
        priority: { type: 'integer', minimum: 1, maximum: 999 },
        verify_preset: { type: 'string' },
        confirmed: { type: 'boolean' },
        require_verified: { type: 'boolean' },
        cleanup: { type: 'boolean' },
        stop_on_failure: { type: 'boolean' },
      },
    },
  },
  {
    name: 'collab_room',
    description: 'Living Shared Collaboration Room engine: create shared dual-layer rooms (SQLite + CLAIMS.md/ROOM-LOG.md), acquire/renew/release atomic path leases with TTL & overlap detection, append logs, promote inbox/<agent>/ drafts safely, and list/inspect rooms.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'list', 'status', 'log', 'claim', 'renew', 'release', 'reconcile_stale', 'promote'] },
        room_id: { type: 'string' },
        name: { type: 'string' },
        goal: { type: 'string' },
        agents: { type: 'array', items: { type: 'string' } },
        create_git_repo: { type: 'boolean' },
        auto_register_clis: { type: 'array', items: { type: 'string' } },
        launch_apps: { type: 'array', items: { type: 'string' } },
        confirmed: { type: 'boolean' },
        path_glob: { type: 'string' },
        owner_agent: { type: 'string' },
        ttl_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
        claim_id: { type: 'string' },
        notes: { type: 'string' },
        actor: { type: 'string' },
        kind: { type: 'string' },
        message: { type: 'string' },
        agent: { type: 'string' },
        rel_path: { type: 'string' },
        dest_rel_path: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_handoff_pack',
    description: 'Generate a single sanitized Markdown Handoff Pack (Git branch/status/diffstat, recent tasks, open diff comments, active room claims/log tail, guardrails, key memory notes) for instant cross-agent context handoff, optionally saving to the Artifact Vault.',
    inputSchema: {
      type: 'object',
      properties: {
        project_dir: { type: 'string' },
        room_id: { type: 'string' },
        target_member: { type: 'string' },
        save_artifact: { type: 'boolean' },
        max_bytes: { type: 'integer', minimum: 2048, maximum: 128000 },
      },
    },
  },
  {
    name: 'collab_consensus',
    description: 'Multi-Agent Consensus & Arbitration engine: open voting rounds across heterogeneous agents (optionally auto-dispatching DSH/Muse), submit stance/confidence/hard-blocker votes, synthesize final weighted verdict into SQLite + Memory + Room Log, and list rounds.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['create', 'vote', 'synthesize', 'list'] },
        round_id: { type: 'string' },
        room_id: { type: 'string' },
        topic: { type: 'string' },
        members: { type: 'array', items: { type: 'string' } },
        project_dir: { type: 'string' },
        auto_dispatch: { type: 'boolean' },
        member: { type: 'string' },
        stance: { type: 'string', enum: ['approve', 'reject', 'modify', 'abstain'] },
        confidence: { type: 'number', minimum: 0.1, maximum: 1 },
        rationale: { type: 'string' },
        blockers: { type: 'array', items: { type: 'string' } },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'collab_artifacts',
    description: 'Shared Artifact Vault (256 KB cap, automatic secret redaction, SHA-256 verification, TTL expiration): put, get, list, delete, or prune cross-agent deliverable artifacts.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['put', 'get', 'list', 'delete', 'prune'] },
        artifact_id: { type: 'string' },
        room_id: { type: 'string' },
        project: { type: 'string' },
        name: { type: 'string' },
        content: { type: 'string' },
        mime_type: { type: 'string' },
        author: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        ttl_hours: { type: 'number', minimum: 0, maximum: 2160 },
        limit: { type: 'integer', minimum: 1, maximum: 100 },
      },
    },
  },
  {
    name: 'collab_budget',
    description: 'Token & Call Budget Guardrail engine: configure daily_call_limit / daily_token_limit policies per global/agent/project scope (warn | downgrade | block), inspect policies, delete policies, or evaluate current 24h utilization.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['set', 'list', 'delete', 'evaluate'] },
        policy_id: { type: 'string' },
        scope_type: { type: 'string', enum: ['global', 'agent', 'project'] },
        scope_id: { type: 'string' },
        daily_token_limit: { type: 'integer', minimum: 100 },
        daily_call_limit: { type: 'integer', minimum: 1 },
        soft_warn_pct: { type: 'integer', minimum: 10, maximum: 99 },
        on_exceed: { type: 'string', enum: ['warn', 'downgrade', 'block'] },
        enabled: { type: 'boolean' },
        member: { type: 'string' },
        project_dir: { type: 'string' },
      },
    },
  },
  {
    name: 'collab_triggers',
    description: 'Safe local automation triggers (strict allowlist: self_check | self_heal_preview | hot_backup | skills_drift_check | prune_artifacts | reconcile_stale_claims; 60s min cooldown): save, list, delete, or run immediately.',
    inputSchema: {
      type: 'object',
      required: ['action'],
      properties: {
        action: { type: 'string', enum: ['save', 'list', 'delete', 'run'] },
        trigger_id: { type: 'string' },
        name: { type: 'string' },
        kind: { type: 'string', enum: ['interval', 'manual'] },
        trigger_action: { type: 'string', enum: ['self_check', 'self_heal_preview', 'hot_backup', 'skills_drift_check', 'prune_artifacts', 'reconcile_stale_claims'] },
        interval_sec: { type: 'integer', minimum: 60, maximum: 86400 },
        enabled: { type: 'boolean' },
      },
    },
  },
]);

function buildCockpitSnapshot(db, { tab = 'radar', projectDir = WORKSPACE_ROOT } = {}) {
  const members = getMemberStatuses(db);
  const tasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 60').all().map(parseTaskRow);
  const worktrees = listWorktrees(db);
  const merge_queue = listMergeQueue(db);
  const mcp_hub = buildMcpHubSnapshot(db);
  const skills_hub = buildSkillsRulesSnapshot({ projectDir: projectDir || WORKSPACE_ROOT });
  const self_improve = getSelfImproveSummary(db);
  const workspaces = listWorkspaceProjects(WORKSPACE_ROOT).slice(0, 30);
  const rooms = listCollabRooms(db);
  const artifacts = listArtifacts(db, { limit: 20 });
  const budget_summary = evaluateBudget(db, { projectDir: projectDir || WORKSPACE_ROOT });
  const triggers = listTriggers(db);
  const consensus = listConsensusRounds(db, { limit: 12 });
  return {
    version: APP_VERSION,
    initial_tab: tab || 'radar',
    project_dir: projectDir || WORKSPACE_ROOT,
    workspaces,
    generated_at: new Date().toISOString(),
    members,
    tasks,
    worktrees,
    merge_queue,
    mcp_hub,
    mcp_hub_summary: getMcpHubSummary(db),
    skills_hub,
    self_improve,
    rooms,
    artifacts,
    budget_summary,
    triggers,
    consensus,
  };
}

export async function handleToolCall(db, name, args = {}, opts = {}) {
  const signal = opts?.signal || null;
  signal?.throwIfAborted?.();
  switch (name) {
    case 'collab_cockpit':
    case 'collab_cockpit_state':
      return buildCockpitSnapshot(db, { tab: args.tab || 'radar', projectDir: args.project_dir || WORKSPACE_ROOT });
    case 'collab_roster': {
      const probed = await probeAllMembers(db, { desktopObservations: args.desktop_observations, signal });
      signal?.throwIfAborted?.();
      return {
        ...probed,
        agents: listAgents(db, { includeDisabled: true }),
        toolkit: getToolkitStatus(),
        dashboard_url: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`,
        mail_ui_url: `${MAIL_BASE_URL}/mail`,
      };
    }
    case 'collab_plan':
      return planDispatch(db, {
        role: args.role,
        prefer: args.prefer,
        exclude: args.exclude,
        requireLocalFiles: Boolean(args.require_local_files),
        requireLinux: Boolean(args.require_linux),
        requireBackgroundAuto: Boolean(args.require_background_auto),
      });
    case 'collab_agent_register':
      return registerAgent(db, {
        agentId: args.agent_id,
        name: args.name,
        driver: args.driver,
        roles: args.roles || ['researcher', 'reviewer'],
        capabilities: args.capabilities || [],
        config: args.config || {},
        enabled: args.enabled ?? true,
      });
    case 'collab_agent_list':
      return { agents: listAgents(db, { includeDisabled: Boolean(args.include_disabled) }) };
    case 'collab_agent_remove':
      return removeAgent(db, args.agent_id);
    case 'collab_dispatch':
      return dispatchBackgroundTask(db, {
        taskId: args.task_id,
        batchId: args.batch_id,
        parentTaskId: args.parent_task_id,
        dependsOn: args.depends_on || [],
        autoInjectContext: Boolean(args.auto_inject_context),
        autoFallback: Boolean(args.auto_fallback),
        injectGuardrails: args.inject_guardrails !== false,
        reservePaths: args.reserve_paths || [],
        allowLeaseConflict: Boolean(args.allow_lease_conflict),
        member: args.member,
        role: args.role || 'researcher',
        projectDir: args.project_dir,
        title: args.title,
        prompt: args.prompt,
        worktreePath: args.worktree_path,
        branchName: args.branch_name,
        mailMessageId: args.mail_message_id || null,
        waitSec: args.wait_sec || 0,
      });
    case 'collab_poll':
      return pollBackgroundTask(db, args.task_id, { waitSec: args.wait_sec ?? 15 });
    case 'collab_poll_batch':
      return pollBatchTasks(db, { batchId: args.batch_id, waitSec: args.wait_sec ?? 15 });
    case 'collab_task_reconcile':
      return reconcileTask(db, {
        taskId: args.task_id,
        externalId: args.external_id || null,
        sessionId: args.session_id || null,
        state: args.state || null,
        resultText: args.result_text || null,
        note: args.note || null,
      });
    case 'collab_record_handoff':
      return recordNativeHandoff(db, {
        taskId: args.task_id,
        batchId: args.batch_id,
        parentTaskId: args.parent_task_id,
        member: args.member,
        role: args.role || 'implementer',
        projectDir: args.project_dir,
        title: args.title,
        prompt: args.prompt || '',
        requestId: args.request_id,
        sessionId: args.session_id,
        mailMessageId: args.mail_message_id || null,
        state: args.state,
        worktreePath: args.worktree_path,
        branchName: args.branch_name,
        resultText: args.result_text ?? null,
        evidence: args.evidence ?? null,
        errorCode: args.error_code ?? null,
        errorMessage: args.error_message ?? null,
      });
    case 'collab_tasks': {
      if (args.task_id) {
        const row = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(args.task_id));
        const events = row ? db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 30').all(args.task_id) : [];
        return { task: row, events, live_logs: row ? getTaskLogs(args.task_id, db) : null };
      }
      const clauses = [];
      const params = [];
      if (args.batch_id) { clauses.push('batch_id = ?'); params.push(args.batch_id); }
      if (args.member) { clauses.push('member = ?'); params.push(args.member); }
      if (args.state) { clauses.push('state = ?'); params.push(args.state); }
      const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
      const lim = Math.max(1, Math.min(100, Number(args.limit) || 30));
      const rows = db.prepare(`SELECT * FROM tasks ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, lim).map(parseTaskRow);
      return { count: rows.length, tasks: rows, worktrees: listWorktrees(db, { state: 'active' }) };
    }
    case 'collab_cooldown': {
      if (args.action === 'status') return { members: getMemberStatuses(db) };
      if (!args.member) throw new Error('member is required for set/clear');
      if (args.action === 'set') return setMemberCooldown(db, args.member, args.seconds || 1800, args.reason || 'Manual cooldown', args.channel || null);
      return clearMemberCooldown(db, args.member);
    }
    case 'collab_worktree_create': {
      const wt = createWorktree(db, { repoDir: args.repo_dir, taskId: args.task_id, member: args.member, baseRef: args.base_ref });
      const paths = Array.isArray(args.reserve_paths) && args.reserve_paths.length ? args.reserve_paths : [`worktree:${wt.branch_name}`];
      const mail_lease = await reserveMailPaths({ projectDir: wt.repo_dir, member: wt.member, paths, reason: `Worktree ${wt.branch_name}` });
      return { ...wt, mail_lease };
    }
    case 'collab_worktree_review':
      return reviewWorktree(db, { taskId: args.task_id, maxDiffChars: args.max_diff_chars || 12000 });
    case 'collab_worktree_verify':
      return verifyWorktree(db, { taskId: args.task_id, preset: args.preset || 'auto', timeoutSec: args.timeout_sec || 90 });
    case 'collab_worktree_merge': {
      const wtBefore = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(args.task_id);
      const merged = mergeWorktree(db, { taskId: args.task_id, confirmed: args.confirmed, cleanup: args.cleanup ?? true });
      const mail_release = wtBefore ? await releaseMailPaths({ projectDir: wtBefore.repo_dir, member: wtBefore.member }) : { synced: false };
      return { ...merged, mail_release };
    }
    case 'collab_worktree_cleanup': {
      const wtBefore = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(args.task_id);
      const cleaned = cleanupWorktree(db, { taskId: args.task_id, force: Boolean(args.force), deleteBranch: Boolean(args.delete_branch) });
      const mail_release = wtBefore ? await releaseMailPaths({ projectDir: wtBefore.repo_dir, member: wtBefore.member }) : { synced: false };
      return { ...cleaned, mail_release };
    }
    case 'collab_memory_write': {
      const note = writeMemoryNote(db, {
        project: args.project, slug: args.slug, title: args.title, content: args.content,
        tags: args.tags || [], author: args.author || 'coordinator',
      });
      const mail_notice = await postMailUpdate({
        projectDir: WORKSPACE_ROOT,
        fromMember: args.author || 'agy',
        threadId: `memory-${note.project}`,
        subject: `[Memory] ${note.title}`,
        bodyMd: `Shared memory updated (${note.project}/${note.slug}):\n\n${String(args.content).slice(0, 1200)}`,
      });
      return { ...note, mail_notice };
    }
    case 'collab_memory_search':
      return { results: searchMemoryNotes(db, { query: args.query, project: args.project, limit: args.limit || 15 }) };
    case 'collab_memory_list':
      return { notes: listMemoryNotes(db, { project: args.project, limit: args.limit || 30 }) };
    case 'collab_session_search':
      return searchSessionsCass({ query: args.query, limit: args.limit || 10, agent: args.agent || null });
    case 'collab_repo_pack':
      return packRepoRepomix({
        projectDir: args.project_dir, include: args.include || null, ignore: args.ignore || null,
        style: args.style || 'markdown', compress: args.compress ?? true, maxChars: args.max_chars || 48000,
      });
    case 'collab_ast_search':
      return searchAstGrep({
        projectDir: args.project_dir, pattern: args.pattern, lang: args.lang || null, maxMatches: args.max_matches || 40,
      });
    case 'collab_beads':
      return runBeads({
        projectDir: args.project_dir, action: args.action, title: args.title || null,
        description: args.description || null, issueId: args.issue_id || null,
        status: args.status || null, priority: args.priority ?? null,
      });
    case 'collab_doc_to_md':
      return convertDocToMd({ filePath: args.file_path, maxChars: args.max_chars || 32000 });
    case 'collab_playbook_run':
      return runPlaybook(db, {
        playbook: args.playbook, projectDir: args.project_dir, goal: args.goal || '',
        members: args.members || null, include: args.include || null,
        astPattern: args.ast_pattern || null, astLang: args.ast_lang || null,
        docPath: args.doc_path || null, sessionQuery: args.session_query || null,
      });
    case 'collab_agent_discover':
      return discoverLocalAgents(db);
    case 'collab_workflow_run':
      return runDagWorkflow(db, {
        name: args.name || 'custom-dag',
        batchId: args.batch_id || null,
        projectDir: args.project_dir,
        steps: args.steps || [],
        waitSec: args.wait_sec ?? 15,
        saveReportToMemory: args.save_report_to_memory !== false,
      });
    case 'collab_batch_report':
      return buildBatchMarkdownReport(db, args.batch_id);
    case 'collab_metrics':
      return computeAgentTelemetry(db, { days: args.days || 30 });
    case 'collab_recipes':
      if (args.action === 'list') return { recipes: listRecipes(db) };
      if (args.action === 'save') return saveRecipe(db, { recipeId: args.recipe_id, title: args.title, role: args.role || 'researcher', tags: args.tags || '', prompt: args.prompt });
      if (args.action === 'delete') return deleteRecipe(db, args.recipe_id);
      throw new Error(`Invalid recipes action: ${args.action}`);
    case 'collab_doctor': {
      const report = await runSystemDoctor(db);
      if (args.backup) report.backup = createHotBackup(db);
      return report;
    }
    case 'collab_cancel':
      return cancelTask(db, args.task_id, { reason: args.reason || 'Cancelled via MCP', force: Boolean(args.force) });
    case 'collab_workflow_resume':
      return resumeDagWorkflow(db, {
        batchId: args.batch_id,
        waitSec: args.wait_sec ?? 15,
        saveReportToMemory: args.save_report_to_memory !== false,
      });
    case 'collab_self_check':
      return diagnoseSystem(db);
    case 'collab_self_heal': {
      if (args.action === 'reconcile_stale') {
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') {
          throw new Error('confirmed must be a strict boolean (true or false)');
        }
        return reconcileStaleTasks(db, {
          taskIds: Array.isArray(args.task_ids) ? args.task_ids : null,
          resolution: args.resolution || 'cancelled',
          note: args.note || '',
          confirmed: args.confirmed === true,
        });
      }
      if (args.apply !== undefined && typeof args.apply !== 'boolean') {
        throw new Error('apply must be a strict boolean (true or false)');
      }
      return applySelfHeal(db, {
        apply: args.apply === true,
        recordLessons: args.record_lessons !== false,
      });
    }
    case 'collab_lessons': {
      if (args.action === 'list') {
        return { lessons: listIncidentLessons(db, { member: args.member || null }) };
      }
      if (args.action === 'save') {
        return {
          lesson: saveIncidentLesson(db, {
            project: args.project || '*',
            member: args.member || '*',
            role: args.role || '*',
            errorCode: args.error_code || '',
            pattern: args.pattern,
            guardrail: args.guardrail,
            active: args.active !== false,
            autoLearned: false,
          }),
        };
      }
      if (args.action === 'toggle') {
        return { lesson: toggleIncidentLesson(db, args.id, Boolean(args.active)) };
      }
      throw new Error(`Unsupported collab_lessons action: ${args.action}`);
    }
    case 'collab_mcp_hub': {
      if (args.action === 'snapshot') return buildMcpHubSnapshot(db);
      if (args.action === 'register') return { server: registerMcpServer(db, args) };
      if (args.action === 'remove') return removeMcpServer(db, args.id);
      if (args.action === 'import') return importDiscoveredMcpServers(db, { clientId: args.client_id || null });
      if (args.action === 'probe') return probeMcpServer(db, args.id);
      if (args.action === 'snippet') return generateClientSnippet(db, { clientId: args.client_id || 'antigravity', serverIds: args.server_ids || null });
      if (args.action === 'sync') {
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') {
          throw new Error('confirmed must be a strict boolean');
        }
        return syncMcpToClient(db, { clientId: args.client_id, serverIds: args.server_ids || null, confirmed: args.confirmed === true });
      }
      throw new Error(`Unsupported collab_mcp_hub action: ${args.action}`);
    }
    case 'collab_mcp_find_tools':
      return findMcpTools(db, { query: args.query || '', serverId: args.server_id || null, searchIn: args.search_in || 'both', limit: args.limit || 30 });
    case 'collab_mcp_call_tool':
      return callMcpServerTool(db, { serverId: args.server_id, toolName: args.tool_name, toolArgs: args.arguments || {}, timeoutMs: args.timeout_ms || 15000 });
    case 'collab_skills_hub': {
      if (args.action === 'snapshot') return buildSkillsRulesSnapshot({ projectDir: args.project_dir || WORKSPACE_ROOT });
      if (args.action === 'sync_skill') {
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be a strict boolean');
        return syncSkillAcrossClients(db, { skillName: args.skill_name, sourceClient: args.source_client, targetClients: args.target_clients || [], confirmed: args.confirmed === true });
      }
      if (args.action === 'sync_rule') {
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be a strict boolean');
        return syncRuleAcrossTargets(db, { projectDir: args.project_dir || WORKSPACE_ROOT, sourceRuleId: args.source_rule_id || 'agents-md', targetRuleIds: args.target_rule_ids || [], confirmed: args.confirmed === true });
      }
      throw new Error(`Unsupported collab_skills_hub action: ${args.action}`);
    }
    case 'collab_worktree_comments': {
      if (args.action === 'list') return { comments: listWorktreeComments(db, args.task_id || null) };
      if (args.action === 'add') return { comment: addWorktreeComment(db, { taskId: args.task_id, filePath: args.file_path, lineNo: args.line_no ?? null, side: args.side || 'new', author: args.author || 'reviewer', body: args.body }) };
      if (args.action === 'resolve') return { comment: resolveWorktreeComment(db, { commentId: args.comment_id, status: args.status || 'resolved' }) };
      if (args.action === 'dispatch_rework') return dispatchWorktreeRework(db, { taskId: args.task_id, member: args.member || null, extraNote: args.extra_note || '' });
      throw new Error(`Unsupported collab_worktree_comments action: ${args.action}`);
    }
    case 'collab_merge_queue': {
      if (args.action === 'list') return { queue: listMergeQueue(db) };
      if (args.action === 'enqueue') return { item: enqueueMergeQueue(db, { taskId: args.task_id, priority: args.priority ?? 100, verifyPreset: args.verify_preset || 'auto' }) };
      if (args.action === 'remove') return removeMergeQueueItem(db, { taskId: args.task_id });
      if (args.action === 'validate') return validateMergeQueue(db);
      if (args.action === 'process') {
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be a strict boolean');
        return processMergeQueue(db, { confirmed: args.confirmed === true, requireVerified: Boolean(args.require_verified), cleanup: args.cleanup !== false, stopOnFailure: args.stop_on_failure !== false });
      }
      throw new Error(`Unsupported collab_merge_queue action: ${args.action}`);
    }
    case 'collab_room': {
      const act = args.action;
      if (act === 'list') return { rooms: listCollabRooms(db) };
      if (act === 'status') return { room: getRoomStatus(db, args.room_id || args.name) };
      if (act === 'reconcile_stale') return reconcileStaleClaimsInAllRooms(db);
      if (act === 'create') {
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be a strict boolean');
        return createCollabRoom(db, {
          name: args.name,
          goal: args.goal || '',
          agents: args.agents,
          createGitRepo: args.create_git_repo !== false,
          autoRegisterClis: args.auto_register_clis || [],
          launchApps: args.launch_apps || [],
          confirmed: args.confirmed === true,
        });
      }
      if (act === 'log') {
        return { entry: appendRoomLog(db, { roomId: args.room_id || args.name, actor: args.actor || 'collab-hub', kind: args.kind || 'note', message: args.message }) };
      }
      if (act === 'claim') {
        return { claim: claimRoomPath(db, { roomId: args.room_id || args.name, pathGlob: args.path_glob, ownerAgent: args.owner_agent, ttlMinutes: args.ttl_minutes ?? 30, notes: args.notes || '' }) };
      }
      if (act === 'renew') {
        return { claim: renewRoomClaim(db, { claimId: args.claim_id, ownerAgent: args.owner_agent || null, ttlMinutes: args.ttl_minutes ?? 30 }) };
      }
      if (act === 'release') {
        return { claim: releaseRoomClaim(db, { claimId: args.claim_id || null, roomId: args.room_id || args.name || null, pathGlob: args.path_glob || null, ownerAgent: args.owner_agent || null }) };
      }
      if (act === 'promote') {
        if (args.confirmed !== undefined && typeof args.confirmed !== 'boolean') throw new Error('confirmed must be a strict boolean');
        return promoteInboxFile(db, {
          roomId: args.room_id || args.name,
          agent: args.agent || args.owner_agent,
          relPath: args.rel_path,
          destRelPath: args.dest_rel_path || null,
          confirmed: args.confirmed === true,
        });
      }
      throw new Error(`Unsupported collab_room action: ${act}`);
    }
    case 'collab_handoff_pack':
      return buildHandoffPack(db, {
        projectDir: args.project_dir || WORKSPACE_ROOT,
        roomId: args.room_id || null,
        targetMember: args.target_member || null,
        saveArtifact: Boolean(args.save_artifact),
        maxBytes: args.max_bytes ?? 24000,
      });
    case 'collab_consensus': {
      const act = args.action;
      if (act === 'list') return { rounds: listConsensusRounds(db, { roomId: args.room_id || null, limit: args.limit ?? 20 }) };
      if (act === 'create') {
        if (args.auto_dispatch !== undefined && typeof args.auto_dispatch !== 'boolean') {
          throw new Error('auto_dispatch must be a strict boolean');
        }
        return createConsensusRound(db, {
          roundId: args.round_id || null,
          roomId: args.room_id || null,
          topic: args.topic,
          members: args.members,
          projectDir: args.project_dir || WORKSPACE_ROOT,
          autoDispatch: args.auto_dispatch === true,
        });
      }
      if (act === 'vote') {
        return {
          round: recordConsensusVote(db, {
            roundId: args.round_id,
            member: args.member,
            stance: args.stance,
            confidence: args.confidence ?? 0.85,
            rationale: args.rationale || '',
            blockers: args.blockers || [],
          }),
        };
      }
      if (act === 'synthesize') return { round: synthesizeConsensus(db, args.round_id) };
      throw new Error(`Unsupported collab_consensus action: ${act}`);
    }
    case 'collab_artifacts': {
      const act = args.action;
      if (act === 'list') return { artifacts: listArtifacts(db, { roomId: args.room_id || null, project: args.project || null, limit: args.limit ?? 30 }) };
      if (act === 'get') {
        const artifact = getArtifact(db, args.artifact_id);
        if (!artifact) throw new Error(`Artifact not found or expired: ${args.artifact_id}`);
        return { artifact };
      }
      if (act === 'put') {
        return {
          artifact: putArtifact(db, {
            artifactId: args.artifact_id || null,
            roomId: args.room_id || null,
            project: args.project || null,
            name: args.name,
            content: args.content,
            mimeType: args.mime_type || 'text/markdown',
            author: args.author || 'collab-hub',
            tags: args.tags || [],
            ttlHours: args.ttl_hours ?? 72,
          }),
        };
      }
      if (act === 'delete') return deleteArtifact(db, args.artifact_id);
      if (act === 'prune') return pruneExpiredArtifacts(db);
      throw new Error(`Unsupported collab_artifacts action: ${act}`);
    }
    case 'collab_budget': {
      const act = args.action;
      if (act === 'list') return { policies: listBudgetPolicies(db) };
      if (act === 'evaluate') return evaluateBudget(db, { member: args.member || null, projectDir: args.project_dir || null });
      if (act === 'set') {
        return {
          policy: setBudgetPolicy(db, {
            policyId: args.policy_id || null,
            scopeType: args.scope_type || 'agent',
            scopeId: args.scope_id || '*',
            dailyTokenLimit: args.daily_token_limit ?? null,
            dailyCallLimit: args.daily_call_limit ?? null,
            softWarnPct: args.soft_warn_pct ?? 80,
            onExceed: args.on_exceed || 'warn',
            enabled: args.enabled !== false,
          }),
        };
      }
      if (act === 'delete') return deleteBudgetPolicy(db, args.policy_id);
      throw new Error(`Unsupported collab_budget action: ${act}`);
    }
    case 'collab_triggers': {
      const act = args.action;
      if (act === 'list') return { triggers: listTriggers(db) };
      if (act === 'save') {
        return {
          trigger: saveTrigger(db, {
            triggerId: args.trigger_id || null,
            name: args.name,
            kind: args.kind || 'interval',
            action: args.trigger_action || args.operation,
            intervalSec: args.interval_sec ?? 900,
            enabled: args.enabled !== false,
          }),
        };
      }
      if (act === 'delete') return deleteTrigger(db, args.trigger_id);
      if (act === 'run') return runTriggerNow(db, args.trigger_id);
      throw new Error(`Unsupported collab_triggers action: ${act}`);
    }
    default:
      throw new Error(`Unknown collab-hub tool: ${name}`);
  }
}

const SUPPORTED_MCP_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function inferDesktopMemberFromClientName(clientName) {
  const s = String(clientName || '').toLowerCase();
  if (/antigravity|agy|gemini/.test(s)) return 'agy';
  if (/codex/.test(s)) return 'codex';
  if (/claude/.test(s)) return 'claude';
  return null;
}

export function startMcpStdioServer() {
  ensureRuntimeDirs();
  const db = openHubDb();
  let detectedHostMember = null;
  let detectedClientName = '';
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const cancelledIds = new Set();
  const activeControllers = new Map();

  const shutdown = () => {
    for (const ac of activeControllers.values()) {
      try { ac.abort('server_shutdown'); } catch {}
    }
    activeControllers.clear();
    try { db.close(); } catch {}
  };
  rl.on('close', shutdown);
  process.on('SIGINT', () => { shutdown(); process.exit(0); });
  process.on('SIGTERM', () => { shutdown(); process.exit(0); });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try { msg = JSON.parse(trimmed); } catch {
      send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
      send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } });
      return;
    }
    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
    const { id, method, params } = msg;
    if (!hasId) {
      if (method === 'notifications/cancelled' && params?.requestId !== undefined) {
        const key = String(params.requestId);
        cancelledIds.add(key);
        const ctrl = activeControllers.get(key);
        if (ctrl) {
          try { ctrl.abort(params.reason || 'client_cancelled'); } catch {}
        }
        if (cancelledIds.size > 200) {
          const oldest = cancelledIds.values().next().value;
          if (oldest !== undefined) cancelledIds.delete(oldest);
        }
      }
      return;
    }

    try {
      if (method === 'initialize') {
        const reqVer = params?.protocolVersion;
        const negotiated = SUPPORTED_MCP_VERSIONS.includes(reqVer) ? reqVer : '2025-06-18';
        detectedClientName = String(params?.clientInfo?.name || '');
        detectedHostMember = inferDesktopMemberFromClientName(detectedClientName);
        if (detectedHostMember) {
          try { touchPassiveDesktopHeartbeat(db, detectedHostMember, detectedClientName); } catch {}
        }
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: negotiated,
            capabilities: {
              tools: {},
              resources: { subscribe: false, listChanged: false },
            },
            serverInfo: { name: 'collab-hub', version: APP_VERSION },
          },
        });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'resources/list') {
        send({ jsonrpc: '2.0', id, result: { resources: MCP_APP_RESOURCES } });
      } else if (method === 'resources/read') {
        const uri = params?.uri;
        if (uri !== COCKPIT_RESOURCE_URI) {
          send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown resource URI: ${uri}` } });
        } else {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              contents: [{
                uri: COCKPIT_RESOURCE_URI,
                mimeType: MCP_APP_MIME_TYPE,
                text: buildCockpitAppHtml(),
                _meta: { ui: { prefersBorder: false } },
              }],
            },
          });
        }
      } else if (method === 'tools/call') {
        const reqKey = String(id);
        const ac = new AbortController();
        activeControllers.set(reqKey, ac);
        try {
          if (cancelledIds.delete(reqKey)) return;
          if (detectedHostMember) {
            try { touchPassiveDesktopHeartbeat(db, detectedHostMember, detectedClientName); } catch {}
          }
          const result = await handleToolCall(db, params?.name, params?.arguments || {}, { signal: ac.signal });
          if (ac.signal.aborted || cancelledIds.delete(reqKey)) return;
          const textContent = params?.name === 'collab_cockpit'
            ? `${formatCyberHudCard(result)}\n\nTip: Interactive 60fps MCP App Cockpit attached (${COCKPIT_RESOURCE_URI}).`
            : JSON.stringify(result, null, 2);
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: textContent }],
              structuredContent: result,
            },
          });
        } catch (toolErr) {
          if (ac.signal.aborted || cancelledIds.delete(reqKey)) return;
          send({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: String(toolErr.message || toolErr) }],
            },
          });
        } finally {
          activeControllers.delete(reqKey);
        }
      } else {
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
    } catch (err) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(err.message || err) } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startMcpStdioServer();
}
