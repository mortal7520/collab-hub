import path from 'node:path';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { APP_VERSION, ensureRuntimeDirs, MAIL_BASE_URL, DASHBOARD_HOST, DASHBOARD_PORT, WORKSPACE_ROOT } from './config.mjs';
import {
  clearMemberCooldown, getMemberStatuses, openHubDb, parseTaskRow, setMemberCooldown,
} from './db.mjs';
import {
  cancelTask, dispatchBackgroundTask, getTaskLogs, pollBackgroundTask, pollBatchTasks, reconcileTask, recordNativeHandoff,
} from './executors.mjs';
import { discoverLocalAgents } from './discovery.mjs';
import { createHotBackup, runSystemDoctor } from './doctor.mjs';
import { postMailUpdate, releaseMailPaths, reserveMailPaths } from './mail-sync.mjs';
import { listMemoryNotes, searchMemoryNotes, writeMemoryNote } from './memory.mjs';
import { runPlaybook } from './playbooks.mjs';
import { planDispatch, probeAllMembers } from './prober.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from './recipes.mjs';
import { listAgents, registerAgent, removeAgent } from './registry.mjs';
import { computeAgentTelemetry } from './telemetry.mjs';
import {
  convertDocToMd, getToolkitStatus, packRepoRepomix, runBeads, searchAstGrep, searchSessionsCass,
} from './toolkit.mjs';
import { buildBatchMarkdownReport, resumeDagWorkflow, runDagWorkflow } from './workflows.mjs';
import { cleanupWorktree, createWorktree, listWorktrees, mergeWorktree, reviewWorktree, verifyWorktree } from './worktree.mjs';

export const TOOLS = Object.freeze([
  {
    name: 'collab_roster',
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
]);

export async function handleToolCall(db, name, args = {}) {
  switch (name) {
    case 'collab_roster':
      return {
        ...(await probeAllMembers(db, { desktopObservations: args.desktop_observations })),
        agents: listAgents(db, { includeDisabled: true }),
        toolkit: getToolkitStatus(),
        dashboard_url: `http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`,
        mail_ui_url: `${MAIL_BASE_URL}/mail`,
      };
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
    default:
      throw new Error(`Unknown collab-hub tool: ${name}`);
  }
}

export function startMcpStdioServer() {
  ensureRuntimeDirs();
  const db = openHubDb();
  const send = (obj) => process.stdout.write(JSON.stringify(obj) + '\n');
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

  const shutdown = () => { try { db.close(); } catch {} };
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
    if (!hasId) return;

    try {
      if (method === 'initialize') {
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: params?.protocolVersion || '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'collab-hub', version: APP_VERSION },
          },
        });
      } else if (method === 'ping') {
        send({ jsonrpc: '2.0', id, result: {} });
      } else if (method === 'tools/list') {
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      } else if (method === 'tools/call') {
        try {
          const result = await handleToolCall(db, params?.name, params?.arguments || {});
          send({
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              structuredContent: result,
            },
          });
        } catch (toolErr) {
          send({
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: String(toolErr.message || toolErr) }],
            },
          });
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
