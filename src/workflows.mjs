import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { assertValidTaskId, resolveProjectDir } from './config.mjs';
import { logEvent, parseTaskRow } from './db.mjs';
import { canonicalGoJson, dispatchBackgroundTask, pollBatchTasks, sha256Hex } from './executors.mjs';
import { writeMemoryNote } from './memory.mjs';
import { sanitizeLessonText, saveIncidentLesson } from './self-improve.mjs';

const NON_REPAIRABLE_CODES = /429|QUOTA|RATE_LIMIT|TIMEOUT|UNCERTAIN|NOT_AUTHORIZED|LEASE_CONFLICT|CANCELLED/i;
const MAX_REPAIRS_PER_BATCH = 4;

function normalizeAutoRepair(raw) {
  if (!raw) return { enabled: false, max_repairs: 0 };
  if (raw === true) return { enabled: true, max_repairs: 1 };
  if (typeof raw === 'object') {
    const enabled = Boolean(raw.enabled ?? (Number(raw.max_repairs) > 0));
    const maxRepairs = enabled ? Math.max(1, Math.min(2, Number(raw.max_repairs) || 1)) : 0;
    return { enabled, max_repairs: maxRepairs };
  }
  return { enabled: false, max_repairs: 0 };
}

function isRepairEligible(task) {
  if (!task || task.state !== 'failed') return false;
  if (NON_REPAIRABLE_CODES.test(String(task.error_code || ''))) return false;
  if (NON_REPAIRABLE_CODES.test(String(task.error_message || '').slice(0, 200))) return false;
  return true;
}

function buildStructuredRepairPrompt(originalPrompt, failedTask, attemptNo) {
  const code = sanitizeLessonText(failedTask.error_code || 'EXECUTION_FAILED', 64);
  const exitMatch = /_EXIT_(\d+)$/.exec(code);
  const exitCode = exitMatch ? Number(exitMatch[1]) : (failedTask.evidence?.exitCode ?? null);
  // Strict allowlisted diagnostic fields ONLY: raw stderr/error_message text is never copied into persisted prompts!
  const diag = {
    failure_class: 'confirmed_execution_failure',
    previous_task_id: failedTask.task_id,
    attempt: attemptNo,
    error_code: code,
    ...(exitCode !== null ? { exit_code: exitCode } : {}),
  };
  const diagJson = JSON.stringify(diag, null, 2).slice(0, 1800);
  return `${originalPrompt}\n\n[CLOSED-LOOP REPAIR DIAGNOSTIC (allowlisted metadata only)]\n${diagJson}\n[/CLOSED-LOOP REPAIR DIAGNOSTIC]\nInspect workspace/test status, fix the root cause of the confirmed failure above, and verify cleanly.`;
}

function canonicalPlanProjectDir(projectDir, deps = {}) {
  try {
    return resolveProjectDir(projectDir, {
      requireSubdir: false,
      workspaceRoot: deps.workspaceRoot,
      extraRoots: deps.extraRoots,
    }).windows;
  } catch {
    return path.resolve(String(projectDir || '')).replace(/[\\/]+$/, '');
  }
}

function computeWorkflowPlanDigest(canonicalDir, steps) {
  return sha256Hex(canonicalGoJson({ project_dir: canonicalDir, steps }));
}

const TERMINAL_STATES = new Set(['completed', 'failed', 'rerouted', 'cancelled']);

/**
 * Execute a declarative multi-stage DAG workflow across ANY registered background agents.
 *
 * Each step: {
 *   id: "plan" | "review_a" | "synth",
 *   member: "<agent_id>",
 *   role: "planner" | "researcher" | "implementer" | "tester" | "reviewer" | "synthesizer",
 *   title?: "...",
 *   prompt: "...",
 *   depends_on?: ["plan"],
 *   auto_inject_context?: true,
 *   reserve_paths?: [...],
 * }
 *
 * Dispatches ready steps in parallel waves, optionally waits up to `waitSec` per wave for async
 * agents (DSH / Muse / Claude CLI), and advances automatically when upstream steps complete!
 */
export async function runDagWorkflow(db, {
  name = 'custom-dag',
  batchId = null,
  projectDir,
  steps = [],
  waitSec = 15,
  saveReportToMemory = true,
}, deps = {}) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new Error('Workflow requires a non-empty steps array');
  }
  if (steps.length > 16) {
    throw new Error('Workflow supports at most 16 steps per run');
  }

  const safeBatchId = batchId
    ? assertValidTaskId(batchId, 'batch_id')
    : `wf_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;

  const seenStepIds = new Set();
  const seenTaskIds = new Set();
  const normalized = steps.map((s, idx) => {
    const rawId = s.id || `step_${idx + 1}`;
    const safeStepId = assertValidTaskId(rawId, 'step.id');
    if (seenStepIds.has(safeStepId)) throw new Error(`Duplicate step id: ${safeStepId}`);
    seenStepIds.add(safeStepId);
    const fullTaskId = `${safeBatchId}_${safeStepId}`;
    if (fullTaskId.length > 60) {
      throw new Error(`Combined batch_id + step.id "${fullTaskId}" exceeds 60-character task_id limit; shorten batch_id or step.id`);
    }
    const taskId = assertValidTaskId(fullTaskId, 'task_id');
    if (seenTaskIds.has(taskId)) throw new Error(`Duplicate generated task_id: ${taskId}`);
    seenTaskIds.add(taskId);
    return {
      stepId: safeStepId,
      taskId,
      member: s.member,
      role: s.role || 'researcher',
      title: s.title || `[${name}] ${safeStepId}`,
      prompt: s.prompt,
      dependsOnSteps: Array.isArray(s.depends_on) ? s.depends_on : [],
      autoInjectContext: s.auto_inject_context !== false,
      reservePaths: Array.isArray(s.reserve_paths) ? s.reserve_paths : [],
      worktreePath: s.worktree_path || null,
      branchName: s.branch_name || null,
      injectGuardrails: s.inject_guardrails !== false,
      autoRepair: normalizeAutoRepair(s.auto_repair),
    };
  });

  // Validate dependency references & detect cycles via Kahn topological sort
  const byStepId = new Map(normalized.map((s) => [s.stepId, s]));
  const indeg = new Map(normalized.map((s) => [s.stepId, 0]));
  const adj = new Map(normalized.map((s) => [s.stepId, []]));
  for (const s of normalized) {
    for (const dep of s.dependsOnSteps) {
      if (!byStepId.has(dep)) throw new Error(`Step "${s.stepId}" depends on unknown step "${dep}"`);
      indeg.set(s.stepId, indeg.get(s.stepId) + 1);
      adj.get(dep).push(s.stepId);
    }
  }
  const queue = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id);
  let visited = 0;
  while (queue.length) {
    const cur = queue.shift();
    visited += 1;
    for (const nxt of adj.get(cur)) {
      indeg.set(nxt, indeg.get(nxt) - 1);
      if (indeg.get(nxt) === 0) queue.push(nxt);
    }
  }
  if (visited !== normalized.length) {
    throw new Error('Workflow steps contain a dependency cycle');
  }

  const planSteps = normalized.map((s) => ({
    stepId: s.stepId,
    taskId: s.taskId,
    member: s.member,
    role: s.role,
    title: s.title,
    prompt: s.prompt,
    dependsOnTaskIds: s.dependsOnSteps.map((d) => byStepId.get(d).taskId),
    autoInjectContext: s.autoInjectContext,
    reservePaths: s.reservePaths,
    worktreePath: s.worktreePath,
    branchName: s.branchName,
    ...(s.injectGuardrails === false ? { injectGuardrails: false } : {}),
    ...(s.autoRepair?.enabled ? { autoRepair: s.autoRepair } : {}),
  }));

  const canonicalProjectDir = canonicalPlanProjectDir(projectDir, deps);
  const planDigest = computeWorkflowPlanDigest(canonicalProjectDir, planSteps);
  const existingPlan = db.prepare('SELECT project_dir, plan_json, plan_sha256 FROM workflow_plans WHERE batch_id = ?').get(safeBatchId);
  let effectiveProjectDir = canonicalProjectDir;
  if (existingPlan) {
    let existingDigest = existingPlan.plan_sha256;
    if (!existingDigest && existingPlan.plan_json) {
      try {
        const parsedOld = JSON.parse(existingPlan.plan_json);
        const oldDir = canonicalPlanProjectDir(parsedOld.project_dir || existingPlan.project_dir, deps);
        existingDigest = computeWorkflowPlanDigest(oldDir, parsedOld.steps || []);
        db.prepare('UPDATE workflow_plans SET plan_sha256 = ? WHERE batch_id = ? AND plan_sha256 IS NULL').run(existingDigest, safeBatchId);
      } catch { /* fall through */ }
    }
    if (!existingDigest || existingDigest !== planDigest) {
      throw new Error(`Workflow batch_id "${safeBatchId}" already exists with a different immutable plan digest; choose a new batch_id.`);
    }
    effectiveProjectDir = existingPlan.project_dir || canonicalProjectDir;
  } else {
    db.prepare(`
      INSERT INTO workflow_plans (batch_id, name, project_dir, plan_json, plan_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(safeBatchId, name, canonicalProjectDir, JSON.stringify({ batch_id: safeBatchId, name, project_dir: canonicalProjectDir, steps: planSteps }), planDigest, new Date().toISOString());
  }

  logEvent(db, {
    taskId: null,
    eventType: 'workflow.plan',
    actor: 'collab-hub',
    payload: { batch_id: safeBatchId, name, project_dir: effectiveProjectDir, step_count: planSteps.length, plan_sha256: planDigest },
  });

  const dispatchedIds = new Set();
  const stepResults = new Map();
  const repairHistory = [];
  const repairCountsByStep = new Map();
  const lastFailFpByStep = new Map();
  let totalBatchRepairs = 0;
  const errors = [];
  const maxWaves = normalized.length + 4;
  const clampedWait = Math.max(0, Math.min(45, Number(waitSec) || 0));

  for (let wave = 0; wave < maxWaves; wave++) {
    const ready = normalized.filter((s) => {
      if (dispatchedIds.has(s.stepId)) return false;
      return s.dependsOnSteps.every((depId) => stepResults.get(depId)?.state === 'completed');
    });

    if (ready.length > 0) {
      const settled = await Promise.allSettled(ready.map((s) => {
        dispatchedIds.add(s.stepId);
        // Bind downstream depends_on to the latest completed attempt ID (supports repaired _r2/_r3 steps!)
        const depTaskIds = s.dependsOnSteps.map((d) => stepResults.get(d)?.task_id || byStepId.get(d).taskId);
        return dispatchBackgroundTask(db, {
          taskId: s.taskId,
          batchId: safeBatchId,
          dependsOn: depTaskIds,
          autoInjectContext: s.autoInjectContext && depTaskIds.length > 0,
          reservePaths: s.reservePaths,
          member: s.member,
          role: s.role,
          projectDir: effectiveProjectDir,
          title: s.title,
          prompt: s.prompt,
          worktreePath: s.worktreePath,
          branchName: s.branchName,
          injectGuardrails: s.injectGuardrails,
          waitSec: 0,
        }, deps);
      }));

      settled.forEach((res, i) => {
        const s = ready[i];
        if (res.status === 'fulfilled') {
          stepResults.set(s.stepId, res.value);
        } else {
          errors.push({ step: s.stepId, member: s.member, error: String(res.reason?.message || res.reason) });
          // Preserve real persisted row state (e.g. if original task is still running!) — NEVER synthesize a fake repair-eligible failure!
          const persisted = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(s.taskId));
          stepResults.set(s.stepId, persisted || { task_id: s.taskId, state: 'failed', error_code: 'DISPATCH_REJECTED', _non_repairable: true, error_message: String(res.reason?.message || res.reason) });
        }
      });
    }

    // If any dispatched tasks are still running and waitSec > 0, poll the batch once
    const hasActive = [...stepResults.values()].some((r) => r && !TERMINAL_STATES.has(r.state));
    if (hasActive && clampedWait > 0) {
      const polled = await pollBatchTasks(db, { batchId: safeBatchId, waitSec: clampedWait }, deps);
      for (const t of polled.tasks) {
        const match = normalized.find((s) => stepResults.get(s.stepId)?.task_id === t.task_id || s.taskId === t.task_id);
        if (match) stepResults.set(match.stepId, t);
      }
    }

    // Opt-in closed-loop auto-repair for confirmed failed steps (strictly bounded by persisted DB counts!)
    let triggeredRepair = false;
    for (const s of normalized) {
      if (!s.autoRepair?.enabled) continue;
      const cur = stepResults.get(s.stepId);
      if (!cur || cur._non_repairable || !isRepairEligible(cur)) continue;
      // Verify against real persisted SQLite row & persisted batch/step repair counts so re-submission never breaches caps!
      const persistedBatchRepairs = Number(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE batch_id = ? AND task_id GLOB '*_r[0-9]*'").get(safeBatchId)?.c || 0);
      const persistedStepRepairs = Number(db.prepare("SELECT COUNT(*) AS c FROM tasks WHERE batch_id = ? AND task_id GLOB ?").get(safeBatchId, `${s.taskId}_r[0-9]*`)?.c || 0);
      if (persistedStepRepairs >= s.autoRepair.max_repairs || persistedBatchRepairs >= MAX_REPAIRS_PER_BATCH) continue;
      const persistedRow = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(cur.task_id));
      if (!persistedRow || !isRepairEligible(persistedRow)) continue;
      const fp = sha256Hex(`${persistedRow.error_code || ''}|${sanitizeLessonText(persistedRow.error_message || '', 240)}`);
      if (lastFailFpByStep.get(s.stepId) === fp) {
        continue;
      }
      lastFailFpByStep.set(s.stepId, fp);
      const attemptNo = persistedStepRepairs + 2;
      const retryTaskId = `${s.taskId}_r${attemptNo}`;
      if (retryTaskId.length > 64) continue;
      repairCountsByStep.set(s.stepId, persistedStepRepairs + 1);
      totalBatchRepairs = persistedBatchRepairs + 1;
      triggeredRepair = true;
      const depTaskIds = s.dependsOnSteps.map((d) => stepResults.get(d)?.task_id || byStepId.get(d).taskId);
      try {
        const repaired = await dispatchBackgroundTask(db, {
          taskId: retryTaskId,
          batchId: safeBatchId,
          parentTaskId: persistedRow.task_id,
          dependsOn: depTaskIds,
          autoInjectContext: s.autoInjectContext && depTaskIds.length > 0,
          reservePaths: s.reservePaths,
          member: s.member,
          role: s.role,
          projectDir: effectiveProjectDir,
          title: `${s.title} [auto-repair #${persistedStepRepairs + 1}]`,
          prompt: buildStructuredRepairPrompt(s.prompt, persistedRow, attemptNo),
          worktreePath: s.worktreePath,
          branchName: s.branchName,
          injectGuardrails: s.injectGuardrails,
          waitSec: 0,
        }, deps);
        stepResults.set(s.stepId, repaired);
        repairHistory.push({
          step: s.stepId,
          previous_task_id: persistedRow.task_id,
          repair_task_id: repaired.task_id,
          attempt: attemptNo,
          state: repaired.state,
        });
        if (repaired.state === 'completed') {
          try {
            saveIncidentLesson(db, {
              project: path.basename(effectiveProjectDir) || '*',
              member: s.member,
              role: s.role,
              errorCode: persistedRow.error_code || 'AUTO_REPAIRED',
              pattern: `Auto-repaired ${persistedRow.error_code || 'failure'} in ${s.stepId}`,
              guardrail: `Previous failure (${sanitizeLessonText(persistedRow.error_code || 'EXECUTION_FAILED', 64)}) was resolved on retry; verify prerequisites upfront.`,
              autoLearned: true,
            });
          } catch {}
        }
      } catch (repErr) {
        errors.push({ step: s.stepId, member: s.member, repair: true, error: String(repErr?.message || repErr) });
      }
    }

    // Check if any more steps can become ready
    const moreReady = normalized.some((s) => !dispatchedIds.has(s.stepId) && s.dependsOnSteps.every((d) => stepResults.get(d)?.state === 'completed'));
    if (!moreReady && !triggeredRepair) break;
  }

  const pendingSteps = normalized
    .filter((s) => !dispatchedIds.has(s.stepId))
    .map((s) => ({
      step: s.stepId,
      member: s.member,
      waiting_for: s.dependsOnSteps.filter((d) => stepResults.get(d)?.state !== 'completed'),
    }));

  const tasks = db.prepare('SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at ASC').all(safeBatchId).map(parseTaskRow);
  const allCompleted = normalized.every((s) => stepResults.get(s.stepId)?.state === 'completed');

  let memoryNote = null;
  if (saveReportToMemory && allCompleted && tasks.length > 0) {
    const md = buildBatchMarkdownReport(db, safeBatchId).markdown;
    const projSlug = String(projectDir || 'workspace').split(/[\\/]/).filter(Boolean).pop() || 'workspace';
    memoryNote = writeMemoryNote(db, {
      project: projSlug,
      slug: `workflow-${safeBatchId}`,
      title: `Workflow 完成报告：${name} (${safeBatchId})`,
      tags: ['workflow', name, safeBatchId],
      author: 'collab-hub',
      content: md,
      memoryDir: deps.memoryDir,
    });
  }

  return {
    workflow: name,
    batch_id: safeBatchId,
    total_steps: normalized.length,
    dispatched_count: dispatchedIds.size,
    all_completed: allCompleted,
    pending_steps: pendingSteps,
    repairs: repairHistory,
    errors,
    memory_note: memoryNote,
    tasks: tasks.map((t) => ({
      task_id: t.task_id,
      member: t.member,
      role: t.role,
      state: t.state,
      external_id: t.external_id,
      result_preview: t.result_text ? t.result_text.slice(0, 300) : null,
      error_code: t.error_code,
    })),
  };
}

/**
 * Resume a partially failed, cancelled, or partially dispatched DAG batch from checkpoint.
 * Persists unique plans in `workflow_plans`, never blindly retries `uncertain` or `stalled` tasks,
 * restores original prompt / reservePaths / autoInjectContext, and advances undispatched downstream steps.
 */
export async function resumeDagWorkflow(db, {
  batchId,
  waitSec = 15,
  saveReportToMemory = true,
}, deps = {}) {
  const safeBatch = assertValidTaskId(batchId, 'batch_id');
  const allRows = db.prepare('SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at ASC').all(safeBatch).map(parseTaskRow);

  // Load persisted plan keyed by batch_id (fallback to legacy workflow.plan event if upgraded DB)
  let savedPlan = null;
  const planRow = db.prepare('SELECT plan_json FROM workflow_plans WHERE batch_id = ?').get(safeBatch);
  if (planRow?.plan_json) {
    try { savedPlan = JSON.parse(planRow.plan_json); } catch {}
  }
  if (!savedPlan) {
    const legacyEvents = db.prepare("SELECT payload_json FROM events WHERE event_type = 'workflow.plan' ORDER BY id DESC LIMIT 40").all();
    for (const pe of legacyEvents) {
      try {
        const p = JSON.parse(pe.payload_json || '{}');
        if (p?.batch_id === safeBatch && Array.isArray(p.steps)) { savedPlan = p; break; }
      } catch {}
    }
  }
  const planStepsByTaskId = new Map((savedPlan?.steps || []).map((s) => [s.taskId, s]));

  if (allRows.length === 0 && planStepsByTaskId.size === 0) {
    throw new Error(`No tasks or workflow plan found for batch_id=${safeBatch}`);
  }

  // Group retry chains to find the latest task attempt per logical root task
  const byId = new Map(allRows.map((t) => [t.task_id, t]));
  const rootOf = (task) => {
    let cur = task;
    const seen = new Set();
    while (cur.parent_task_id && byId.has(cur.parent_task_id) && !seen.has(cur.task_id)) {
      seen.add(cur.task_id);
      cur = byId.get(cur.parent_task_id);
    }
    return cur.task_id;
  };

  const latestByRoot = new Map();
  const attemptCount = new Map();
  for (const row of allRows) {
    const r = rootOf(row);
    latestByRoot.set(r, row);
    attemptCount.set(r, (attemptCount.get(r) || 0) + 1);
  }

  const latestTasks = [...latestByRoot.entries()].map(([rootId, row]) => ({ rootId, row }));

  // Strictly retry ONLY confirmed terminal failures/cancellations — NEVER resend uncertain or stalled tasks!
  const resumableStates = new Set(['failed', 'cancelled']);
  const blockedUncertain = latestTasks.filter((x) => ['uncertain', 'stalled', 'needs_input'].includes(x.row.state)).map((x) => x.row.task_id);
  const toRetryRoots = new Set(latestTasks.filter((x) => resumableStates.has(x.row.state)).map((x) => x.rootId));

  // Propagate retry flag to any downstream non-completed task that depended on a retried root
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of latestTasks) {
      if (toRetryRoots.has(item.rootId) || item.row.state === 'completed') continue;
      if (['uncertain', 'stalled', 'needs_input'].includes(item.row.state)) continue;
      const depRoots = (item.row.depends_on || []).map((depId) => (byId.has(depId) ? rootOf(byId.get(depId)) : depId));
      if (depRoots.some((dr) => toRetryRoots.has(dr))) {
        toRetryRoots.add(item.rootId);
        changed = true;
      }
    }
  }

  // Assign deterministic append-only retry task_ids for failed/cancelled steps AND pick up undispatched plan steps
  const effectiveTaskIdByRoot = new Map();
  const retryPlan = [];
  for (const item of latestTasks) {
    if (!toRetryRoots.has(item.rootId)) {
      effectiveTaskIdByRoot.set(item.rootId, item.row.task_id);
    } else {
      const nextAttempt = (attemptCount.get(item.rootId) || 1) + 1;
      const suffix = `_r${nextAttempt}`;
      const base = item.rootId.slice(0, Math.max(1, 60 - suffix.length));
      let candidate = assertValidTaskId(`${base}${suffix}`, 'task_id');
      while (db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(candidate)) {
        candidate = assertValidTaskId(`${item.rootId.slice(0, 52)}_${randomUUID().slice(0, 6)}`, 'task_id');
      }
      effectiveTaskIdByRoot.set(item.rootId, candidate);
      const origStep = planStepsByTaskId.get(item.rootId);
      const depRoots = origStep
        ? (origStep.dependsOnTaskIds || [])
        : (item.row.depends_on || []).map((depId) => (byId.has(depId) ? rootOf(byId.get(depId)) : depId));
      retryPlan.push({
        rootId: item.rootId,
        previousTaskId: item.row.task_id,
        newTaskId: candidate,
        member: origStep?.member || item.row.member,
        role: origStep?.role || item.row.role,
        projectDir: savedPlan?.project_dir || item.row.project_dir,
        title: origStep?.title || item.row.title,
        prompt: origStep?.prompt ?? item.row.prompt,
        autoInjectContext: origStep ? origStep.autoInjectContext !== false : depRoots.length > 0,
        reservePaths: Array.isArray(origStep?.reservePaths) ? origStep.reservePaths : [],
        worktreePath: origStep?.worktreePath ?? item.row.worktree_path ?? null,
        branchName: origStep?.branchName ?? item.row.branch_name ?? null,
        depRoots,
      });
    }
  }

  for (const s of (savedPlan?.steps || [])) {
    if (latestByRoot.has(s.taskId) || db.prepare('SELECT 1 FROM tasks WHERE task_id = ?').get(s.taskId)) continue;
    effectiveTaskIdByRoot.set(s.taskId, s.taskId);
    retryPlan.push({
      rootId: s.taskId,
      previousTaskId: null,
      newTaskId: s.taskId,
      member: s.member,
      role: s.role || 'researcher',
      projectDir: savedPlan.project_dir || allRows[0]?.project_dir,
      title: s.title || s.stepId,
      prompt: s.prompt,
      autoInjectContext: s.autoInjectContext !== false,
      reservePaths: Array.isArray(s.reservePaths) ? s.reservePaths : [],
      worktreePath: s.worktreePath || null,
      branchName: s.branchName || null,
      depRoots: Array.isArray(s.dependsOnTaskIds) ? s.dependsOnTaskIds : [],
    });
  }

  const stateByRoot = new Map(latestTasks.map((x) => [x.rootId, toRetryRoots.has(x.rootId) ? 'pending' : x.row.state]));
  for (const s of retryPlan) {
    if (!stateByRoot.has(s.rootId)) stateByRoot.set(s.rootId, 'pending');
  }

  const skippedCompleted = latestTasks.filter((x) => x.row.state === 'completed').map((x) => x.row.task_id);
  if (retryPlan.length === 0) {
    return {
      batch_id: safeBatch,
      resumed: false,
      message: blockedUncertain.length
        ? `Refusing to retry uncertain/stalled/needs_input tasks (${blockedUncertain.join(', ')}); inspect and reconcile them first.`
        : 'No failed, cancelled, or pending workflow steps to resume',
      skipped_completed: skippedCompleted,
      blocked_uncertain: blockedUncertain,
      retried_steps: [],
      all_completed: stateByRoot.size > 0 && [...stateByRoot.values()].every((st) => st === 'completed'),
      tasks: allRows,
    };
  }

  const dispatched = new Set();
  const retriedSteps = [];
  const errors = [];
  const clampedWait = Math.max(0, Math.min(45, Number(waitSec) || 0));

  for (let wave = 0; wave < retryPlan.length + 1; wave++) {
    const ready = retryPlan.filter((s) => {
      if (dispatched.has(s.rootId)) return false;
      return s.depRoots.every((dr) => stateByRoot.get(dr) === 'completed' || db.prepare('SELECT state FROM tasks WHERE task_id = ?').get(dr)?.state === 'completed');
    });

    if (ready.length > 0) {
      const settled = await Promise.allSettled(ready.map((s) => {
        dispatched.add(s.rootId);
        const mappedDeps = s.depRoots.map((dr) => effectiveTaskIdByRoot.get(dr) || dr);
        return dispatchBackgroundTask(db, {
          taskId: s.newTaskId,
          batchId: safeBatch,
          parentTaskId: s.previousTaskId,
          dependsOn: mappedDeps,
          autoInjectContext: Boolean(s.autoInjectContext) && mappedDeps.length > 0,
          reservePaths: s.reservePaths || [],
          member: s.member,
          role: s.role,
          projectDir: s.projectDir,
          title: s.title,
          prompt: s.prompt,
          worktreePath: s.worktreePath,
          branchName: s.branchName,
          waitSec: 0,
        }, deps);
      }));

      settled.forEach((res, i) => {
        const s = ready[i];
        if (res.status === 'fulfilled') {
          stateByRoot.set(s.rootId, res.value.state);
          retriedSteps.push({ previous_task_id: s.previousTaskId, task_id: res.value.task_id, member: res.value.member, state: res.value.state });
        } else {
          stateByRoot.set(s.rootId, 'failed');
          errors.push({ previous_task_id: s.previousTaskId, task_id: s.newTaskId, error: String(res.reason?.message || res.reason) });
        }
      });
    }

    const hasActive = retryPlan.some((s) => dispatched.has(s.rootId) && !TERMINAL_STATES.has(stateByRoot.get(s.rootId)));
    if (hasActive && clampedWait > 0) {
      const polled = await pollBatchTasks(db, { batchId: safeBatch, waitSec: clampedWait }, deps);
      for (const s of retryPlan) {
        const found = polled.tasks.find((t) => t.task_id === s.newTaskId);
        if (found) stateByRoot.set(s.rootId, found.state);
      }
    }

    const moreReady = retryPlan.some((s) => !dispatched.has(s.rootId) && s.depRoots.every((dr) => stateByRoot.get(dr) === 'completed'));
    if (!moreReady) break;
  }

  const freshTasks = db.prepare('SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at ASC').all(safeBatch).map(parseTaskRow);
  const allCompleted = stateByRoot.size > 0 && [...stateByRoot.values()].every((st) => st === 'completed');
  let memoryNote = null;
  if (saveReportToMemory && allCompleted && freshTasks.length > 0) {
    const md = buildBatchMarkdownReport(db, safeBatch).markdown;
    const projSlug = String(savedPlan?.project_dir || allRows[0]?.project_dir || 'workspace').split(/[\\/]/).filter(Boolean).pop() || 'workspace';
    memoryNote = writeMemoryNote(db, {
      project: projSlug,
      slug: `workflow-${safeBatch}`,
      title: `Workflow 恢复完成报告：${safeBatch}`,
      tags: ['workflow', 'resumed', safeBatch],
      author: 'collab-hub',
      content: md,
      memoryDir: deps.memoryDir,
    });
  }

  return {
    batch_id: safeBatch,
    resumed: retriedSteps.length > 0,
    skipped_completed: skippedCompleted,
    blocked_uncertain: blockedUncertain,
    retried_steps: retriedSteps,
    all_completed: allCompleted,
    errors,
    memory_note: memoryNote,
    tasks: freshTasks.map((t) => ({
      task_id: t.task_id,
      parent_task_id: t.parent_task_id,
      member: t.member,
      role: t.role,
      state: t.state,
      external_id: t.external_id,
      result_preview: t.result_text ? t.result_text.slice(0, 300) : null,
      error_code: t.error_code,
    })),
  };
}

/**
 * Generate a clean, shareable Markdown synthesis report for any batch_id.
 */
export function buildBatchMarkdownReport(db, batchId) {
  const safeBatch = assertValidTaskId(batchId, 'batch_id');
  const tasks = db.prepare('SELECT * FROM tasks WHERE batch_id = ? ORDER BY created_at ASC').all(safeBatch).map(parseTaskRow);
  if (tasks.length === 0) {
    throw new Error(`No tasks found for batch_id=${safeBatch}`);
  }
  const counts = {};
  for (const t of tasks) counts[t.state] = (counts[t.state] || 0) + 1;

  const lines = [
    `# CollabHub Batch Report · \`${safeBatch}\``,
    '',
    `- **Generated**: ${new Date().toISOString()}`,
    `- **Total Tasks**: ${tasks.length} (${Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ')})`,
    `- **Participants**: ${[...new Set(tasks.map((t) => `${t.member} (${t.role})`))].join(', ')}`,
    '',
    '## Summary Table',
    '',
    '| Task ID | Agent | Role | State | Receipt | Updated |',
    '| --- | --- | --- | --- | --- | --- |',
  ];

  for (const t of tasks) {
    lines.push(`| \`${t.task_id}\` | ${t.member} | ${t.role} | **${t.state}** | \`${t.external_id || '-'}\` | ${t.updated_at} |`);
  }

  lines.push('', '## Detailed Outputs', '');
  for (const t of tasks) {
    lines.push(`### ${t.title} (\`${t.task_id}\` · ${t.member}/${t.role} · ${t.state})`, '');
    if (t.depends_on?.length) lines.push(`- **Depends on**: ${t.depends_on.map((d) => `\`${d}\``).join(', ')}`);
    if (t.worktree_path) lines.push(`- **Worktree**: \`${t.worktree_path}\` (\`${t.branch_name || ''}\`)`);
    if (t.result_text) {
      lines.push('', t.result_text, '');
    } else if (t.error_message) {
      lines.push('', `> **Diagnostic (${t.error_code || t.state})**: ${t.error_message}`, '');
    } else {
      lines.push('', '_No final output recorded yet._', '');
    }
  }

  return {
    batch_id: safeBatch,
    task_count: tasks.length,
    counts,
    markdown: lines.join('\n'),
  };
}
