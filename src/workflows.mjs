import { randomUUID } from 'node:crypto';
import { assertValidTaskId } from './config.mjs';
import { parseTaskRow } from './db.mjs';
import { dispatchBackgroundTask, pollBatchTasks } from './executors.mjs';
import { writeMemoryNote } from './memory.mjs';

const TERMINAL_STATES = new Set(['completed', 'failed', 'rerouted']);

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
  const normalized = steps.map((s, idx) => {
    const rawId = s.id || `step_${idx + 1}`;
    const safeStepId = assertValidTaskId(rawId, 'step.id');
    if (seenStepIds.has(safeStepId)) throw new Error(`Duplicate step id: ${safeStepId}`);
    seenStepIds.add(safeStepId);
    const taskId = assertValidTaskId(`${safeBatchId}_${safeStepId}`.slice(0, 60), 'task_id');
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

  const dispatchedIds = new Set();
  const stepResults = new Map();
  const errors = [];
  const maxWaves = normalized.length + 1;
  const clampedWait = Math.max(0, Math.min(45, Number(waitSec) || 0));

  for (let wave = 0; wave < maxWaves; wave++) {
    const ready = normalized.filter((s) => {
      if (dispatchedIds.has(s.stepId)) return false;
      return s.dependsOnSteps.every((depId) => stepResults.get(depId)?.state === 'completed');
    });

    if (ready.length > 0) {
      const settled = await Promise.allSettled(ready.map((s) => {
        dispatchedIds.add(s.stepId);
        const depTaskIds = s.dependsOnSteps.map((d) => byStepId.get(d).taskId);
        return dispatchBackgroundTask(db, {
          taskId: s.taskId,
          batchId: safeBatchId,
          dependsOn: depTaskIds,
          autoInjectContext: s.autoInjectContext && depTaskIds.length > 0,
          reservePaths: s.reservePaths,
          member: s.member,
          role: s.role,
          projectDir,
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
          stepResults.set(s.stepId, res.value);
        } else {
          errors.push({ step: s.stepId, member: s.member, error: String(res.reason?.message || res.reason) });
          stepResults.set(s.stepId, { task_id: s.taskId, state: 'failed', error_message: String(res.reason?.message || res.reason) });
        }
      });
    }

    // If any dispatched tasks are still running and waitSec > 0, poll the batch once
    const hasActive = [...stepResults.values()].some((r) => r && !TERMINAL_STATES.has(r.state));
    if (hasActive && clampedWait > 0) {
      const polled = await pollBatchTasks(db, { batchId: safeBatchId, waitSec: clampedWait }, deps);
      for (const t of polled.tasks) {
        const match = normalized.find((s) => s.taskId === t.task_id);
        if (match) stepResults.set(match.stepId, t);
      }
    }

    // Check if any more steps can become ready
    const moreReady = normalized.some((s) => !dispatchedIds.has(s.stepId) && s.dependsOnSteps.every((d) => stepResults.get(d)?.state === 'completed'));
    if (!moreReady) break;
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
