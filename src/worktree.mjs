import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { WORKTREE_DIR, assertValidAgentId, assertValidGitRef, assertValidTaskId, resolveProjectDir, toWslPath } from './config.mjs';
import { isProcessAlive, isRegisteredAgent, logEvent } from './db.mjs';

const execFileAsync = promisify(execFile);

/**
 * Safely copy untracked local environment files listed in `.worktreeinclude` (inspired by git-worktree-runner)
 * from the main repository into a newly spawned worktree. Strictly prevents traversal, absolute paths,
 * `.git` tampering, or symlinks escaping the repository root.
 */
function syncWorktreeIncludeFiles(repoTopLevel, wtPath) {
  const incFile = path.join(repoTopLevel, '.worktreeinclude');
  if (!fs.existsSync(incFile)) return [];
  const realRepo = fs.realpathSync(repoTopLevel);
  const lines = fs.readFileSync(incFile, 'utf8').split(/\r?\n/);
  const copied = [];
  for (const rawLine of lines) {
    const entry = rawLine.trim();
    if (!entry || entry.startsWith('#') || entry.includes('\0')) continue;
    if (path.isAbsolute(entry) || entry.includes('..') || /(^|[\\/])\.git([\\/]|$)/i.test(entry)) continue;
    const src = path.resolve(realRepo, entry);
    const rel = path.relative(realRepo, src);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
    if (!fs.existsSync(src)) continue;
    const realSrc = fs.realpathSync(src);
    const realRel = path.relative(realRepo, realSrc);
    if (!realRel || realRel.startsWith('..') || path.isAbsolute(realRel)) continue;
    const st = fs.statSync(realSrc);
    if (!st.isFile() || st.size > 5 * 1024 * 1024) continue;
    const realWt = fs.realpathSync(wtPath);
    const dst = path.resolve(realWt, realRel);
    const dstRel = path.relative(realWt, dst);
    if (!dstRel || dstRel.startsWith('..') || path.isAbsolute(dstRel)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const realDstDir = fs.realpathSync(path.dirname(dst));
    const dirRel = path.relative(realWt, realDstDir);
    if (dirRel.startsWith('..') || path.isAbsolute(dirRel)) continue;
    if (fs.existsSync(dst) && fs.lstatSync(dst).isSymbolicLink()) continue;
    fs.copyFileSync(realSrc, dst);
    copied.push(realRel.replaceAll('\\', '/'));
  }
  return copied;
}

const VERIFY_PRESETS = Object.freeze({
  'node-test': () => ({ cmd: process.execPath, args: ['--test'] }),
  'npm-test': () => ({ cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm', args: ['test'] }),
  'pytest': () => ({ cmd: 'pytest', args: ['-q'] }),
  'cargo-test': () => ({ cmd: 'cargo', args: ['test'] }),
  'go-test': () => ({ cmd: 'go', args: ['./...'] }),
});

function detectVerifyPreset(wtPath) {
  if (fs.existsSync(path.join(wtPath, 'package.json'))) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(wtPath, 'package.json'), 'utf8'));
      if (pkg?.scripts?.test && /node\s+--test/.test(pkg.scripts.test)) return 'node-test';
      if (pkg?.scripts?.test) return 'npm-test';
    } catch {}
    return 'node-test';
  }
  if (fs.existsSync(path.join(wtPath, 'Cargo.toml'))) return 'cargo-test';
  if (fs.existsSync(path.join(wtPath, 'go.mod'))) return 'go-test';
  if (fs.existsSync(path.join(wtPath, 'pyproject.toml')) || fs.existsSync(path.join(wtPath, 'pytest.ini'))) return 'pytest';
  return 'node-test';
}

function git(cwd, args, { timeout = 60000 } = {}) {
  return execFileSync('git', ['--no-optional-locks', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function repoBucketName(topLevel) {
  const base = path.basename(topLevel).replace(/[^A-Za-z0-9_-]+/g, '-').slice(0, 32) || 'repo';
  const digest = createHash('sha1').update(topLevel.toLowerCase()).digest('hex').slice(0, 8);
  return `${base}-${digest}`;
}

function withRepoLock(repoDir, fn) {
  const commonDir = git(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  const lockPath = path.join(commonDir, 'collabhub-merge.lock');
  const acquire = () => {
    const fd = fs.openSync(lockPath, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    acquire();
  } catch (err) {
    if (err.code === 'EEXIST') {
      // Stale lock recovery: if the recorded holder PID is demonstrably dead, reclaim safely
      let staleReclaimed = false;
      try {
        const info = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (info?.pid && !isProcessAlive(info.pid)) {
          fs.unlinkSync(lockPath);
          acquire();
          staleReclaimed = true;
        }
      } catch { /* fall through to active lock error */ }
      if (!staleReclaimed) {
        throw new Error(`Repository merge lock held (${lockPath}). Wait for concurrent merge to finish or inspect stale lock.`);
      }
    } else {
      throw err;
    }
  }
  try {
    return fn();
  } finally {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

export function createWorktree(db, {
  repoDir, taskId, member, baseRef = null, worktreeRoot = WORKTREE_DIR, workspaceRoot,
}) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const safeMember = assertValidAgentId(member);
  if (!isRegisteredAgent(db, safeMember)) throw new Error(`Unknown or disabled agent: ${safeMember}`);
  const resolved = resolveProjectDir(repoDir, { requireSubdir: true, workspaceRoot, extraRoots: [worktreeRoot] });
  const rawTop = git(resolved.windows, ['rev-parse', '--show-toplevel']);
  const topLevel = process.platform === 'win32' ? rawTop.replaceAll('/', '\\') : rawTop;
  // Re-verify discovered Git root stays inside allowed workspace/worktree roots (prevents parent-repo escape)
  resolveProjectDir(topLevel, { requireSubdir: true, workspaceRoot, extraRoots: [worktreeRoot] });
  const bucket = repoBucketName(topLevel);

  const existing = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (existing && existing.state === 'active' && fs.existsSync(existing.worktree_path)) {
    return existing;
  }

  let currentBranch;
  if (baseRef) {
    currentBranch = assertValidGitRef(baseRef);
    // Verify commit exists (prevents git option injection!)
    git(topLevel, ['rev-parse', '--verify', '--quiet', `${currentBranch}^{commit}`]);
  } else {
    currentBranch = assertValidGitRef(git(topLevel, ['rev-parse', '--abbrev-ref', 'HEAD']));
  }

  const branchName = assertValidGitRef(`collab/${safeMember}/${safeTask}`);
  const wtPath = path.join(worktreeRoot, bucket, safeTask);
  fs.mkdirSync(path.dirname(wtPath), { recursive: true });

  // Prune stale deleted worktree records before adding
  git(topLevel, ['worktree', 'prune']);

  const branchExists = (() => {
    try { git(topLevel, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`]); return true; }
    catch { return false; }
  })();
  if (branchExists) {
    git(topLevel, ['worktree', 'add', '--', wtPath, branchName]);
  } else {
    git(topLevel, ['worktree', 'add', '-b', branchName, '--', wtPath, currentBranch]);
  }

  // Contract verification: confirm dispatch will accept this worktree path!
  resolveProjectDir(wtPath, { requireSubdir: true, workspaceRoot, extraRoots: [worktreeRoot] });

  // Auto-sync safe local env/config files listed in `.worktreeinclude`
  const syncedFiles = syncWorktreeIncludeFiles(topLevel, wtPath);

  const wslPath = toWslPath(wtPath);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO worktrees (task_id, repo_dir, worktree_path, wsl_path, branch_name, member, base_ref, state, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    ON CONFLICT(task_id) DO UPDATE SET
      repo_dir = excluded.repo_dir,
      worktree_path = excluded.worktree_path,
      wsl_path = excluded.wsl_path,
      branch_name = excluded.branch_name,
      base_ref = excluded.base_ref,
      state = 'active',
      updated_at = excluded.updated_at
  `).run(safeTask, topLevel, wtPath, wslPath, branchName, safeMember, currentBranch, now, now);

  logEvent(db, { taskId: safeTask, eventType: 'worktree.created', actor: safeMember, payload: { wtPath, branchName, baseRef: currentBranch, syncedFiles } });
  return { ...db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask), synced_files: syncedFiles };
}

/**
 * Closed-loop test verification gate inside an isolated worktree (allowlisted presets only, shell: false).
 */
export async function verifyWorktree(db, { taskId, preset = 'auto', timeoutSec = 90 } = {}) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const row = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (!row) throw new Error(`Worktree not found for task_id=${safeTask}`);
  if (!fs.existsSync(row.worktree_path)) throw new Error(`Worktree directory missing: ${row.worktree_path}`);

  const chosen = preset === 'auto' ? detectVerifyPreset(row.worktree_path) : preset;
  const builder = VERIFY_PRESETS[chosen];
  if (!builder) {
    throw new Error(`Unsupported verify preset "${chosen}". Allowed: auto, ${Object.keys(VERIFY_PRESETS).join(', ')}`);
  }

  const headSha = git(row.worktree_path, ['rev-parse', 'HEAD']);
  const { cmd, args } = builder();
  const started = Date.now();
  const timeoutMs = Math.max(5, Math.min(300, Number(timeoutSec) || 90)) * 1000;

  let passed = false;
  let exitCode = 0;
  let output = '';
  try {
    const res = await execFileAsync(cmd, args, {
      cwd: row.worktree_path,
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    passed = true;
    output = `${res.stdout || ''}\n${res.stderr || ''}`.trim();
  } catch (err) {
    passed = false;
    exitCode = typeof err.code === 'number' ? err.code : 1;
    output = `${err.stdout || ''}\n${err.stderr || ''}\n${err.message || ''}`.trim();
  }

  const durationMs = Date.now() - started;
  const status = passed ? 'passed' : 'failed';
  const summary = `${chosen}: ${status} (${durationMs}ms, head=${headSha.slice(0, 10)})`;
  db.prepare(`
    UPDATE worktrees
    SET verified_head_sha = ?, verify_status = ?, verify_summary = ?, updated_at = ?
    WHERE task_id = ?
  `).run(headSha, status, summary, new Date().toISOString(), safeTask);

  logEvent(db, { taskId: safeTask, eventType: `worktree.verify_${status}`, actor: row.member, payload: { preset: chosen, headSha, durationMs, exitCode } });
  return {
    task_id: safeTask,
    branch_name: row.branch_name,
    preset: chosen,
    head_sha: headSha,
    passed,
    status,
    exit_code: exitCode,
    duration_ms: durationMs,
    output: output.slice(0, 12000),
    truncated: output.length > 12000,
  };
}

export function reviewWorktree(db, { taskId, maxDiffChars = 12000 }) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const row = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (!row) throw new Error(`Worktree not found for task_id=${safeTask}`);
  if (!fs.existsSync(row.worktree_path)) {
    return { ...row, exists: false, warning: 'Worktree directory is missing on disk' };
  }

  const baseRef = assertValidGitRef(row.base_ref);
  const headSha = git(row.worktree_path, ['rev-parse', 'HEAD']);
  const statusShort = git(row.worktree_path, ['status', '--short']);
  const commits = git(row.worktree_path, ['log', '--oneline', `${baseRef}..HEAD`, '--']);
  const committedStat = git(row.worktree_path, ['diff', '--stat', `${baseRef}...HEAD`, '--']);
  const uncommittedStat = git(row.worktree_path, ['diff', '--stat', '--']);
  let diffPreview = git(row.worktree_path, ['diff', `${baseRef}...HEAD`, '--']);
  if (!diffPreview) diffPreview = git(row.worktree_path, ['diff', '--']);
  const truncated = diffPreview.length > maxDiffChars;
  if (truncated) diffPreview = diffPreview.slice(0, maxDiffChars) + '\n... [diff truncated]';

  db.prepare(`UPDATE worktrees SET reviewed_head_sha = ?, updated_at = ? WHERE task_id = ?`).run(headSha, new Date().toISOString(), safeTask);

  return {
    ...row,
    reviewed_head_sha: headSha,
    exists: true,
    dirty: Boolean(statusShort),
    status_short: statusShort,
    commits: commits ? commits.split('\n') : [],
    committed_stat: committedStat,
    uncommitted_stat: uncommittedStat,
    diff_preview: diffPreview,
    diff_truncated: truncated,
  };
}

export function mergeWorktree(db, { taskId, confirmed = false, cleanup = true, requireVerified = false }) {
  if (confirmed !== true) {
    throw new Error('Merging a worktree into the main repository requires confirmed=true after reviewing diff and tests.');
  }
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const row = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (!row) throw new Error(`Worktree not found for task_id=${safeTask}`);
  if (row.state !== 'active') throw new Error(`Worktree ${safeTask} is in state=${row.state}, not active`);
  if (!fs.existsSync(row.worktree_path)) throw new Error(`Worktree directory missing: ${row.worktree_path}`);

  const baseRef = assertValidGitRef(row.base_ref);
  const branchName = assertValidGitRef(row.branch_name);

  return withRepoLock(row.repo_dir, () => {
    const mainHead = git(row.repo_dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (mainHead !== baseRef) {
      throw new Error(`Main repo is currently on branch "${mainHead}", expected base_ref "${baseRef}". Switch branch before merging.`);
    }
    const wtHead = git(row.worktree_path, ['rev-parse', 'HEAD']);
    if (!row.reviewed_head_sha) {
      throw new Error('Must call collab_worktree_review before merging so the exact commit SHA is recorded and verified.');
    }
    if (wtHead !== row.reviewed_head_sha) {
      throw new Error(`Worktree HEAD changed after review (reviewed=${row.reviewed_head_sha.slice(0, 12)}, current=${wtHead.slice(0, 12)}). Re-run collab_worktree_review before merging.`);
    }
    if (row.verify_status === 'failed' && row.verified_head_sha === wtHead) {
      throw new Error(`Worktree test verification failed on HEAD ${wtHead.slice(0, 12)} (${row.verify_summary || 'failed'}). Fix tests and re-run collab_worktree_verify before merging.`);
    }
    if (requireVerified && (row.verify_status !== 'passed' || row.verified_head_sha !== wtHead)) {
      throw new Error(`Worktree requires passing collab_worktree_verify on current HEAD ${wtHead.slice(0, 12)} before merging.`);
    }
    const wtDirty = git(row.worktree_path, ['status', '--porcelain']);
    if (wtDirty) {
      throw new Error('Worktree has uncommitted changes. Commit or discard them inside the worktree before merging.');
    }
    const mainDirty = git(row.repo_dir, ['status', '--porcelain']);
    if (mainDirty) {
      throw new Error('Main repository has uncommitted changes. Keep main clean before merging a worktree branch.');
    }

    // Merge the exact reviewed/verified commit SHA (eliminates TOCTOU against mutable branch refs)
    const mergeOutput = git(row.repo_dir, ['merge', '--no-ff', wtHead, '-m', `Merge collab worktree ${row.task_id} (${row.member})`]);
    const now = new Date().toISOString();
    db.prepare(`UPDATE worktrees SET state = 'merged', updated_at = ? WHERE task_id = ?`).run(now, safeTask);
    logEvent(db, { taskId: safeTask, eventType: 'worktree.merged', actor: row.member, payload: { branch: branchName, head_sha: wtHead } });

    let cleaned = false;
    let cleanupWarning = null;
    if (cleanup) {
      const cleanRes = cleanupWorktree(db, { taskId: safeTask, force: false, deleteBranch: true });
      cleaned = cleanRes.cleaned;
      cleanupWarning = cleanRes.branch_warning || null;
    }
    return { merged: true, cleaned, cleanup_warning: cleanupWarning, branch_name: branchName, repo_dir: row.repo_dir, merge_output: mergeOutput };
  });
}

export function cleanupWorktree(db, { taskId, force = false, deleteBranch = false }) {
  const safeTask = assertValidTaskId(taskId, 'task_id');
  const row = db.prepare('SELECT * FROM worktrees WHERE task_id = ?').get(safeTask);
  if (!row) throw new Error(`Worktree not found for task_id=${safeTask}`);
  const branchName = assertValidGitRef(row.branch_name);

  if (fs.existsSync(row.worktree_path)) {
    const args = ['worktree', 'remove'];
    if (force) args.push('--force');
    args.push('--', row.worktree_path);
    git(row.repo_dir, args);
  } else {
    git(row.repo_dir, ['worktree', 'prune']);
  }

  let branchDeleted = false;
  let branchWarning = null;
  if (deleteBranch) {
    try {
      git(row.repo_dir, ['branch', force ? '-D' : '-d', '--', branchName]);
      branchDeleted = true;
    } catch (err) {
      branchWarning = `Branch ${branchName} not deleted (${err.message.split('\n')[0]})`;
    }
  }
  const now = new Date().toISOString();
  db.prepare(`UPDATE worktrees SET state = 'cleaned', updated_at = ? WHERE task_id = ?`).run(now, safeTask);
  logEvent(db, { taskId: safeTask, eventType: 'worktree.cleaned', actor: row.member, payload: { deleteBranch, branchDeleted, branchWarning } });
  return { cleaned: true, task_id: safeTask, branch_name: branchName, branch_deleted: branchDeleted, branch_warning: branchWarning };
}

export function listWorktrees(db, { state = null } = {}) {
  if (state) return db.prepare('SELECT * FROM worktrees WHERE state = ? ORDER BY updated_at DESC').all(state);
  return db.prepare('SELECT * FROM worktrees ORDER BY updated_at DESC').all();
}
