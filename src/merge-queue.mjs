/**
 * CollabHub v1.5.0 — Worktree Inline Diff Comments, Rework Dispatch & Serialized Agent Merge Queue
 *
 * Adapted & inspired (zero npm runtime dependencies) by open-source upstream patterns:
 * - BloopAI/vibe-kanban (Apache-2.0, 37bee50ff4ca): inline diff line comments bound to isolated
 *   Git worktrees that can be dispatched back to the owning coding agent for targeted rework.
 * - Speculative Agent Merge Queue: uses Git's side-effect-free `git merge-tree --write-tree`
 *   to detect both base-branch conflicts and cross-worktree semantic/textual collisions in queue
 *   order BEFORE mutating `main`.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { assertValidGitRef, assertValidTaskId } from './config.mjs';
import { logEvent } from './db.mjs';
import { dispatchBackgroundTask } from './executors.mjs';
import { mergeWorktree, reviewWorktree } from './worktree.mjs';

const VALID_SIDES = new Set(['new', 'old', 'file']);
const VALID_COMMENT_STATUSES = new Set(['open', 'sent', 'resolved']);

function runGit(cwd, args, { timeout = 30000 } = {}) {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

// ---------------------------------------------------------------------------
// 1. Worktree Inline Diff Comments & Rework Dispatch
// ---------------------------------------------------------------------------

export function listWorktreeComments(db, taskId = null) {
  if (taskId) {
    const safeTask = assertValidTaskId(taskId, 'task_id');
    return db.prepare('SELECT * FROM worktree_comments WHERE task_id = ? ORDER BY id ASC').all(safeTask);
  }
  return db.prepare('SELECT * FROM worktree_comments ORDER BY updated_at DESC, id DESC LIMIT 100').all();
}

export function addWorktreeComment(db, {
  taskId, filePath, lineNo = null, side = 'new', author = 'reviewer', body,
}) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const wt = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (!wt) throw new Error(`Worktree not found for task_id=${safeTask}`);
  const safeFile = String(filePath || '').trim().replaceAll('\\', '/').slice(0, 260);
  if (!safeFile || safeFile.includes('..') || safeFile.includes('\0')) {
    throw new Error('Invalid file_path for diff comment');
  }
  const safeBody = String(body || '').trim().slice(0, 2000);
  if (!safeBody) throw new Error('Comment body is required');
  const safeSide = VALID_SIDES.has(String(side || 'new')) ? String(side) : 'new';
  const safeLine = lineNo === null || lineNo === undefined || lineNo === '' ? null : Math.max(1, Math.min(200000, Number(lineNo) || 1));
  const safeAuthor = String(author || 'reviewer').trim().slice(0, 48) || 'reviewer';
  const now = new Date().toISOString();

  const res = db.prepare(`
    INSERT INTO worktree_comments (task_id, file_path, line_no, side, author, body, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)
  `).run(safeTask, safeFile, safeLine, safeSide, safeAuthor, safeBody, now, now);

  const comment = db.prepare('SELECT * FROM worktree_comments WHERE id = ?').get(Number(res.lastInsertRowid));
  logEvent(db, {
    taskId: safeTask,
    eventType: 'worktree.comment_added',
    actor: safeAuthor,
    payload: { comment_id: comment.id, file_path: safeFile, line_no: safeLine },
  });
  return comment;
}

export function resolveWorktreeComment(db, { commentId, status = 'resolved' }) {
  const id = Number(commentId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('Invalid comment_id');
  const safeStatus = VALID_COMMENT_STATUSES.has(status) ? status : 'resolved';
  const now = new Date().toISOString();
  const res = db.prepare('UPDATE worktree_comments SET status = ?, updated_at = ? WHERE id = ?').run(safeStatus, now, id);
  if (!res.changes) throw new Error(`Worktree comment not found: ${id}`);
  return db.prepare('SELECT * FROM worktree_comments WHERE id = ?').get(id);
}

/**
 * Bundle all `open` inline diff comments on a worktree and dispatch a targeted rework task
 * back to the owning (or requested) agent inside that exact isolated worktree!
 */
export async function dispatchWorktreeRework(db, {
  taskId, member = null, extraNote = '', asyncRun = true,
}, dispatchDeps = {}) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const wt = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (!wt) throw new Error(`Worktree not found for task_id=${safeTask}`);
  if (wt.state !== 'active' || !fs.existsSync(wt.worktree_path)) {
    throw new Error(`Worktree ${safeTask} is not active on disk`);
  }
  const openComments = db.prepare(
    "SELECT * FROM worktree_comments WHERE task_id = ? AND status = 'open' ORDER BY file_path ASC, line_no ASC, id ASC",
  ).all(safeTask);
  if (openComments.length === 0) {
    throw new Error(`No open inline diff comments on worktree ${safeTask}`);
  }

  const targetMember = member || wt.member || 'auto';
  const bullets = openComments.map((c, idx) => {
    const loc = c.line_no ? `${c.file_path}:${c.line_no} (${c.side})` : c.file_path;
    return `${idx + 1}. \`${loc}\` — ${c.body}`;
  }).join('\n');

  const prompt = [
    `Address the following inline code-review comments inside worktree branch \`${wt.branch_name}\`:`,
    '',
    bullets,
    extraNote ? `\nAdditional reviewer guidance: ${String(extraNote).trim()}` : '',
    '',
    'Apply minimal, clean fixes directly in this worktree, run tests to verify, and summarize every addressed comment by file and line.',
  ].join('\n');

  const reworkTask = await dispatchBackgroundTask(db, {
    parentTaskId: safeTask,
    member: targetMember,
    role: 'implementer',
    projectDir: wt.worktree_path,
    title: `Rework ${safeTask} (${openComments.length} diff comments)`,
    prompt,
    worktreePath: wt.worktree_path,
    branchName: wt.branch_name,
    autoFallback: true,
    asyncRun,
    waitSec: 0,
  }, dispatchDeps);

  const now = new Date().toISOString();
  const stmt = db.prepare("UPDATE worktree_comments SET status = 'sent', rework_task_id = ?, updated_at = ? WHERE id = ?");
  for (const c of openComments) stmt.run(reworkTask.task_id, now, c.id);

  logEvent(db, {
    taskId: safeTask,
    eventType: 'worktree.rework_dispatched',
    actor: 'collab-hub',
    payload: { rework_task_id: reworkTask.task_id, member: reworkTask.member, comments_count: openComments.length },
  });

  return {
    worktree_task_id: safeTask,
    rework_task: reworkTask,
    comments_sent: openComments.length,
  };
}

// ---------------------------------------------------------------------------
// 2. Serialized Agent Merge Queue (Speculative `git merge-tree` Pre-Flight)
// ---------------------------------------------------------------------------

function parseQueueRow(row) {
  if (!row) return null;
  let conflictFiles = [];
  try { conflictFiles = JSON.parse(row.conflict_files_json || '[]'); } catch {}
  return {
    id: row.id,
    task_id: row.task_id,
    repo_dir: row.repo_dir,
    branch_name: row.branch_name,
    head_sha: row.head_sha,
    base_ref: row.base_ref,
    priority: row.priority,
    status: row.status,
    verify_preset: row.verify_preset,
    check_summary: row.check_summary || null,
    conflict_files: conflictFiles,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listMergeQueue(db) {
  const rows = db.prepare(`
    SELECT mq.*, wt.member, wt.verify_status, wt.reviewed_head_sha, wt.state AS worktree_state
    FROM merge_queue mq
    LEFT JOIN worktrees wt ON wt.task_id = mq.task_id
    ORDER BY
      CASE mq.status WHEN 'validating' THEN 0 WHEN 'ready' THEN 1 WHEN 'queued' THEN 2 WHEN 'conflict' THEN 3 WHEN 'failed' THEN 4 ELSE 5 END,
      mq.priority ASC,
      mq.id ASC
  `).all();
  return rows.map((r) => ({
    ...parseQueueRow(r),
    member: r.member || 'unknown',
    verify_status: r.verify_status || null,
    reviewed_head_sha: r.reviewed_head_sha || null,
    worktree_state: r.worktree_state || null,
  }));
}

export function enqueueMergeQueue(db, { taskId, priority = 100, verifyPreset = 'auto' }) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const wt = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (!wt) throw new Error(`Worktree not found for task_id=${safeTask}`);
  if (wt.state !== 'active') throw new Error(`Worktree ${safeTask} is state=${wt.state}, expected active`);
  if (!fs.existsSync(wt.worktree_path)) throw new Error(`Worktree directory missing: ${wt.worktree_path}`);

  const dirty = runGit(wt.worktree_path, ['status', '--porcelain']);
  if (dirty) throw new Error(`Worktree ${safeTask} has uncommitted changes; commit them before enqueuing.`);
  const headSha = runGit(wt.worktree_path, ['rev-parse', 'HEAD']);
  const prio = Math.max(1, Math.min(999, Number(priority) || 100));
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO merge_queue (task_id, repo_dir, branch_name, head_sha, base_ref, priority, status, verify_preset, check_summary, conflict_files_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, NULL, '[]', ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      head_sha = excluded.head_sha,
      priority = excluded.priority,
      status = 'queued',
      verify_preset = excluded.verify_preset,
      check_summary = NULL,
      conflict_files_json = '[]',
      updated_at = excluded.updated_at
  `).run(safeTask, wt.repo_dir, wt.branch_name, headSha, wt.base_ref, prio, String(verifyPreset || 'auto'), now, now);

  const item = listMergeQueue(db).find((q) => q.task_id === safeTask);
  logEvent(db, {
    taskId: safeTask,
    eventType: 'merge_queue.enqueued',
    actor: wt.member,
    payload: { branch: wt.branch_name, head_sha: headSha.slice(0, 12), priority: prio },
  });
  return item;
}

export function removeMergeQueueItem(db, { taskId }) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const res = db.prepare('DELETE FROM merge_queue WHERE task_id = ?').run(safeTask);
  if (!res.changes) throw new Error(`Task not in merge queue: ${safeTask}`);
  logEvent(db, { taskId: safeTask, eventType: 'merge_queue.removed', actor: 'collab-hub', payload: {} });
  return { removed: true, task_id: safeTask };
}

/**
 * Side-effect-free speculative merge check using `git merge-tree --write-tree` (Git 2.38+).
 * Tests merging `headSha` onto `baseTreeOrCommit` without touching any files or refs!
 */
function speculativeMergeTree(repoDir, baseCommit, headSha) {
  try {
    const out = runGit(repoDir, ['merge-tree', '--write-tree', '--name-only', baseCommit, headSha]);
    const treeOid = out.split(/\r?\n/)[0]?.trim() || null;
    return { clean: true, tree_oid: treeOid, conflict_files: [], error: null };
  } catch (err) {
    // Only exit code 1 from `git merge-tree` indicates merge conflicts; other exits/ENOENT/timeouts are operational errors
    if (err.status !== 1) {
      return { clean: false, tree_oid: null, conflict_files: [], error: String(err.code || err.message || err).slice(0, 140) };
    }
    const stdout = String(err.stdout || '');
    const lines = stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const conflicts = [];
    for (const line of lines) {
      if (line.startsWith('CONFLICT')) {
        const m = /in\s+(.+)$/.exec(line);
        if (m) conflicts.push(m[1].trim());
      }
    }
    if (conflicts.length === 0 && lines.length > 1) {
      for (const l of lines.slice(1)) {
        if (!/^[0-9a-f]{40}$/i.test(l) && !l.startsWith('Auto-merging')) conflicts.push(l);
      }
    }
    return { clean: false, tree_oid: null, conflict_files: [...new Set(conflicts)].slice(0, 20), error: null };
  }
}

/**
 * Speculatively validate the entire active Merge Queue in order!
 * Checks each queued worktree both against `base_ref` AND cumulatively against the combined
 * speculative tree of preceding clean items (using synthetic `commit-tree` objects — zero ref mutations!)
 * so cross-worktree collisions are detected before any merge touches `main`.
 */
export function validateMergeQueue(db) {
  const items = listMergeQueue(db).filter((q) => ['queued', 'ready', 'conflict', 'failed'].includes(q.status));
  const byRepoBase = new Map();
  for (const item of items) {
    const key = `${item.repo_dir}::${item.base_ref}`;
    if (!byRepoBase.has(key)) byRepoBase.set(key, []);
    byRepoBase.get(key).push(item);
  }

  const results = [];
  const now = new Date().toISOString();

  for (const group of byRepoBase.values()) {
    const { repo_dir: repoDir, base_ref: baseRef } = group[0];
    let rollingBaseCommit;
    try {
      rollingBaseCommit = runGit(repoDir, ['rev-parse', `${assertValidGitRef(baseRef)}^{commit}`]);
    } catch (err) {
      for (const item of group) {
        const summary = `Base ref ${baseRef} unreachable: ${String(err.message || err).slice(0, 120)}`;
        const upd = db.prepare("UPDATE merge_queue SET status = 'failed', check_summary = ?, updated_at = ? WHERE task_id = ? AND status = ? AND updated_at = ?")
          .run(summary, now, item.task_id, item.status, item.updated_at);
        if (upd.changes) results.push({ task_id: item.task_id, status: 'failed', summary, conflict_files: [] });
      }
      continue;
    }

    let priorCount = 0;
    for (const item of group) {
      const wt = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(item.task_id);
      if (!wt || wt.state !== 'active' || !fs.existsSync(wt.worktree_path)) {
        const summary = 'Worktree no longer active on disk';
        const upd = db.prepare("UPDATE merge_queue SET status = 'failed', check_summary = ?, updated_at = ? WHERE task_id = ? AND status = ? AND updated_at = ?")
          .run(summary, now, item.task_id, item.status, item.updated_at);
        if (upd.changes) results.push({ task_id: item.task_id, status: 'failed', summary, conflict_files: [] });
        continue;
      }

      const currentHead = runGit(wt.worktree_path, ['rev-parse', 'HEAD']);
      const check = speculativeMergeTree(repoDir, rollingBaseCommit, currentHead);

      if (check.error) {
        const summary = `Speculative merge-tree error: ${check.error}`;
        const upd = db.prepare("UPDATE merge_queue SET head_sha = ?, status = 'failed', check_summary = ?, conflict_files_json = '[]', updated_at = ? WHERE task_id = ? AND status = ? AND updated_at = ?")
          .run(currentHead, summary, now, item.task_id, item.status, item.updated_at);
        if (upd.changes) results.push({ task_id: item.task_id, status: 'failed', summary, conflict_files: [] });
      } else if (check.clean && check.tree_oid) {
        const summary = priorCount === 0
          ? `Clean speculative merge onto ${baseRef} (HEAD ${currentHead.slice(0, 10)})`
          : `Clean cumulative merge after ${priorCount} preceding queued branch(es) (HEAD ${currentHead.slice(0, 10)})`;
        // CAS write guarded by observed status + updated_at so a stale validator can NEVER overwrite an in-flight 'validating' claim!
        const upd = db.prepare("UPDATE merge_queue SET head_sha = ?, status = 'ready', check_summary = ?, conflict_files_json = '[]', updated_at = ? WHERE task_id = ? AND status = ? AND updated_at = ?")
          .run(currentHead, summary, now, item.task_id, item.status, item.updated_at);
        if (upd.changes) {
          try {
            rollingBaseCommit = runGit(repoDir, [
              'commit-tree', check.tree_oid, '-p', rollingBaseCommit, '-p', currentHead,
              '-m', `speculative queue check ${item.task_id}`,
            ]);
          } catch { /* fallback: keep previous rolling base */ }
          priorCount += 1;
          results.push({ task_id: item.task_id, status: 'ready', summary, conflict_files: [] });
        }
      } else {
        const summary = priorCount === 0
          ? `Conflicts with ${baseRef}: ${check.conflict_files.join(', ') || 'merge conflict'}`
          : `Collides with preceding queued branch(es) on ${check.conflict_files.join(', ') || 'overlapping edits'}`;
        const upd = db.prepare("UPDATE merge_queue SET head_sha = ?, status = 'conflict', check_summary = ?, conflict_files_json = ?, updated_at = ? WHERE task_id = ? AND status = ? AND updated_at = ?")
          .run(currentHead, summary, JSON.stringify(check.conflict_files), now, item.task_id, item.status, item.updated_at);
        if (upd.changes) results.push({ task_id: item.task_id, status: 'conflict', summary, conflict_files: check.conflict_files });
      }
    }
  }

  logEvent(db, {
    eventType: 'merge_queue.validated',
    actor: 'collab-hub',
    payload: {
      total: results.length,
      ready: results.filter((r) => r.status === 'ready').length,
      conflicts: results.filter((r) => r.status === 'conflict').length,
    },
  });

  return {
    validated_at: now,
    results,
    queue: listMergeQueue(db),
  };
}

/**
 * Serially execute the Merge Queue into `base_ref`.
 * - Requires `confirmed: true` (default is safe dry-run running speculative validation only).
 * - Automatically binds `reviewWorktree` SHA before each merge and stops on any conflict/failure.
 */
export function processMergeQueue(db, {
  confirmed = false, requireVerified = false, cleanup = true, stopOnFailure = true,
} = {}) {
  const preflight = validateMergeQueue(db);
  if (confirmed !== true) {
    return {
      mode: 'dry_run',
      applied: false,
      preflight: preflight.results,
      merged: [],
      failed: [],
      queue: preflight.queue,
    };
  }

  const readyItems = preflight.queue.filter((q) => q.status === 'ready');
  const merged = [];
  const failed = [];
  const now = new Date().toISOString();

  for (const item of readyItems) {
    // Atomic claim with unique owner marker prevents concurrent processors or stale validators from stealing ownership
    const claimMarker = `${new Date().toISOString()}#${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const claim = db.prepare("UPDATE merge_queue SET status = 'validating', updated_at = ? WHERE task_id = ? AND status = 'ready'")
      .run(claimMarker, item.task_id);
    if (!claim.changes) continue;

    try {
      const wt = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(item.task_id);
      if (!wt || wt.state !== 'active' || !fs.existsSync(wt.worktree_path)) {
        throw new Error(`Worktree ${item.task_id} is no longer active on disk`);
      }
      const liveHead = runGit(wt.worktree_path, ['rev-parse', 'HEAD']);
      if (liveHead !== item.head_sha) {
        throw new Error(`Worktree HEAD moved after speculative validation (${item.head_sha.slice(0, 10)} -> ${liveHead.slice(0, 10)}); re-run validate before merging.`);
      }
      // Bind reviewed_head_sha ONLY to the exact validated SHA (no silent re-stamping of moved commits)
      if (wt.reviewed_head_sha !== item.head_sha) {
        reviewWorktree(db, { taskId: item.task_id, maxDiffChars: 2000 });
        const afterRevHead = runGit(wt.worktree_path, ['rev-parse', 'HEAD']);
        if (afterRevHead !== item.head_sha) {
          throw new Error(`Worktree HEAD changed during review (${item.head_sha.slice(0, 10)} -> ${afterRevHead.slice(0, 10)}).`);
        }
      }
      const res = mergeWorktree(db, {
        taskId: item.task_id,
        confirmed: true,
        cleanup,
        requireVerified,
      });
      db.prepare("UPDATE merge_queue SET status = 'merged', check_summary = ?, updated_at = ? WHERE task_id = ? AND status = 'validating' AND updated_at = ?")
        .run(`Merged into ${item.base_ref} at ${now}`, now, item.task_id, claimMarker);
      merged.push({ task_id: item.task_id, branch_name: item.branch_name, result: res });
    } catch (err) {
      const msg = String(err.message || err).slice(0, 260);
      db.prepare("UPDATE merge_queue SET status = 'failed', check_summary = ?, updated_at = ? WHERE task_id = ? AND status = 'validating' AND updated_at = ?")
        .run(msg, now, item.task_id, claimMarker);
      failed.push({ task_id: item.task_id, branch_name: item.branch_name, error: msg });
      if (stopOnFailure) break;
    }
  }

  logEvent(db, {
    eventType: 'merge_queue.processed',
    actor: 'collab-hub',
    payload: { merged: merged.length, failed: failed.length },
  });

  return {
    mode: 'applied',
    applied: true,
    merged,
    failed,
    queue: listMergeQueue(db),
  };
}
