import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  INTEGRATIONS, TOOLKIT_PATHS, WORKTREE_DIR, resolveProjectDir,
} from './config.mjs';

const execFileAsync = promisify(execFile);

function requireToolFile(filePath, label) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Toolkit binary "${label}" is not installed at ${filePath}`);
  }
  return filePath;
}

function assertSafeGlobOrArg(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\0\r\n]/.test(value) || value.trim().startsWith('-')) {
    throw new Error(`Unsafe ${label}: must be non-empty and must not start with '-'`);
  }
  return value.trim();
}

let cachedToolkitStatus = null;
let cachedToolkitAt = 0;
const TOOLKIT_STATUS_TTL_MS = 5000;

export function getToolkitStatus({ force = false } = {}) {
  const now = Date.now();
  if (!force && cachedToolkitStatus && (now - cachedToolkitAt) < TOOLKIT_STATUS_TTL_MS) {
    return cachedToolkitStatus;
  }
  let provenance = null;
  try {
    if (fs.existsSync(TOOLKIT_PATHS.provenanceJson)) {
      const st = fs.statSync(TOOLKIT_PATHS.provenanceJson);
      if (st.isFile() && st.size <= 512 * 1024) {
        provenance = JSON.parse(fs.readFileSync(TOOLKIT_PATHS.provenanceJson, 'utf8'));
      }
    }
  } catch {}
  cachedToolkitStatus = {
    cass: { installed: fs.existsSync(TOOLKIT_PATHS.cassExe), path: TOOLKIT_PATHS.cassExe, purpose: '跨端历史会话检索 (Codex/Claude/Gemini)' },
    ast_grep: { installed: fs.existsSync(TOOLKIT_PATHS.astGrepExe), path: TOOLKIT_PATHS.astGrepExe, purpose: 'AST 语法树精准代码检索' },
    beads: { installed: fs.existsSync(TOOLKIT_PATHS.beadsExe), path: TOOLKIT_PATHS.beadsExe, purpose: 'Git 仓库级长期任务/史诗依赖图' },
    repomix: { installed: fs.existsSync(TOOLKIT_PATHS.repomixCjs), path: TOOLKIT_PATHS.repomixCjs, purpose: '安全打包项目上下文 (专治 Muse 无本地文件)' },
    markitdown: { installed: fs.existsSync(TOOLKIT_PATHS.markitdownExe), path: TOOLKIT_PATHS.markitdownExe, purpose: '本地 PDF/Word/Excel/PPT 转 Markdown' },
    provenance,
  };
  cachedToolkitAt = now;
  return cachedToolkitStatus;
}

/**
 * 1. Read-only cross-client coding session history search via Dicklesworthstone/coding_agent_session_search (cass.exe).
 */
export async function searchSessionsCass({ query, limit = 10, agent = null, maxChars = 16000 }) {
  const exe = requireToolFile(TOOLKIT_PATHS.cassExe, 'cass.exe');
  if (typeof query !== 'string' || !query.trim() || /[\0\r\n]/.test(query)) {
    throw new Error('query is required');
  }
  const lim = Math.max(1, Math.min(30, Number(limit) || 10));
  fs.mkdirSync(TOOLKIT_PATHS.cassDataDir, { recursive: true });
  const args = ['search', query.trim(), '--robot', '--limit', String(lim), '--data-dir', TOOLKIT_PATHS.cassDataDir];
  if (agent) args.push('--agent', assertSafeGlobOrArg(agent, 'agent'));

  try {
    const { stdout } = await execFileAsync(exe, args, {
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 6 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    try {
      const parsed = JSON.parse(trimmed);
      return { ok: true, query: query.trim(), result: parsed };
    } catch {
      return { ok: true, query: query.trim(), raw: trimmed.slice(0, maxChars), truncated: trimmed.length > maxChars };
    }
  } catch (err) {
    // Some cass subcommands write JSON or hints on non-zero exit when index not built yet
    const out = String(err.stdout || err.stderr || err.message || '').trim();
    if (/index|not initialized|no database/i.test(out)) {
      return { ok: false, needs_index: true, hint: `Run \`cass index --full --data-dir ${TOOLKIT_PATHS.cassDataDir}\` once to build the local read-only session index on D:.`, detail: out.slice(0, 600) };
    }
    throw new Error(`cass search failed: ${out.slice(0, 400)}`);
  }
}

/**
 * 1b. Read-only cass archive stats & incremental index refresh (stored on D:\Apps\CollabHub\data\cass).
 */
export async function getCassStats() {
  const exe = requireToolFile(TOOLKIT_PATHS.cassExe, 'cass.exe');
  if (!fs.existsSync(TOOLKIT_PATHS.cassDataDir)) {
    return { ok: false, initialized: false, data_dir: TOOLKIT_PATHS.cassDataDir };
  }
  try {
    const { stdout } = await execFileAsync(exe, ['stats', '--json', '--data-dir', TOOLKIT_PATHS.cassDataDir], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    return { ok: true, initialized: true, data_dir: TOOLKIT_PATHS.cassDataDir, stats: JSON.parse(stdout.trim()) };
  } catch (err) {
    return { ok: false, initialized: false, data_dir: TOOLKIT_PATHS.cassDataDir, detail: String(err.stderr || err.message || '').slice(0, 300) };
  }
}

export async function reindexSessionsCass({ full = false } = {}) {
  const exe = requireToolFile(TOOLKIT_PATHS.cassExe, 'cass.exe');
  fs.mkdirSync(TOOLKIT_PATHS.cassDataDir, { recursive: true });
  const args = ['index', '--json', '--no-progress-events', '--data-dir', TOOLKIT_PATHS.cassDataDir];
  if (full) args.splice(1, 0, '--full');
  try {
    const { stdout } = await execFileAsync(exe, args, {
      encoding: 'utf8',
      timeout: 90000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const stats = await getCassStats().catch(() => null);
    return { ok: true, partial: false, data_dir: TOOLKIT_PATHS.cassDataDir, output: stdout.trim().slice(0, 1200), stats: stats?.stats || null };
  } catch (err) {
    const detail = String(err.stderr || err.stdout || err.message || '').trim();
    // Exit code 9 = retained completed work, one live file was concurrently written
    if (err.code === 9 || /retained completed work/i.test(detail)) {
      const stats = await getCassStats().catch(() => null);
      return { ok: true, partial: true, data_dir: TOOLKIT_PATHS.cassDataDir, note: 'Incremental index updated (skipped active locked transcript).', stats: stats?.stats || null };
    }
    throw new Error(`cass index failed: ${detail.slice(0, 400)}`);
  }
}

/**
 * 2. Sandboxed repository context packer via yamadashy/repomix.
 * Produces bounded Markdown/XML ideal for feeding Cloud Muse or cross-agent code reviews.
 */
export async function packRepoRepomix({
  projectDir, include = null, ignore = null, style = 'markdown', compress = true, maxChars = 48000, workspaceRoot, extraRoots,
}) {
  const script = requireToolFile(TOOLKIT_PATHS.repomixCjs, 'repomix');
  const resolved = resolveProjectDir(projectDir, { requireSubdir: true, workspaceRoot, extraRoots: extraRoots ?? [WORKTREE_DIR] });
  const allowedStyles = new Set(['markdown', 'xml', 'plain']);
  const safeStyle = allowedStyles.has(style) ? style : 'markdown';

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collabhub-repomix-'));
  const tmpOut = path.join(tmpDir, 'pack.txt');
  const args = [
    script,
    resolved.windows,
    '--style', safeStyle,
    '--output', tmpOut,
    '--no-file-summary',
  ];
  if (compress) args.push('--compress');
  if (include) args.push('--include', assertSafeGlobOrArg(include, 'include'));
  if (ignore) args.push('--ignore', assertSafeGlobOrArg(ignore, 'ignore'));

  try {
    const { stdout } = await execFileAsync(INTEGRATIONS.nodeExe, args, {
      cwd: resolved.windows,
      encoding: 'utf8',
      timeout: 60000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!fs.existsSync(tmpOut)) {
      throw new Error(`repomix finished without producing output (${stdout.slice(0, 300)})`);
    }
    // Bounded read (never slurp a 150MB pack into V8 heap only to slice maxChars!)
    const maxBytes = Math.min(2 * 1024 * 1024, Math.max(4096, Number(maxChars) || 48000) * 4);
    const stat = fs.statSync(tmpOut);
    const fd = fs.openSync(tmpOut, 'r');
    let rawChunk = '';
    try {
      const readLen = Math.min(stat.size, maxBytes);
      const buf = Buffer.allocUnsafe(readLen);
      const bytesRead = fs.readSync(fd, buf, 0, readLen, 0);
      rawChunk = buf.subarray(0, bytesRead).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
    const truncated = stat.size > maxBytes || rawChunk.length > maxChars;
    const content = rawChunk.length > maxChars ? rawChunk.slice(0, maxChars) : rawChunk;
    return {
      ok: true,
      project_dir: resolved.windows,
      style: safeStyle,
      compressed: Boolean(compress),
      total_bytes: stat.size,
      total_chars: content.length,
      approx_tokens: Math.ceil(stat.size / 4),
      truncated,
      content: truncated ? content + '\n\n... [repomix output truncated]' : content,
    };
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/**
 * 3. AST structural code search via ast-grep (sg.exe) — read-only, strictly jailed to projectDir.
 */
export async function searchAstGrep({
  projectDir, pattern, lang = null, maxMatches = 40, workspaceRoot, extraRoots,
}) {
  const exe = requireToolFile(TOOLKIT_PATHS.astGrepExe, 'sg.exe');
  if (typeof pattern !== 'string' || !pattern.trim() || /[\0\r\n]/.test(pattern)) {
    throw new Error('AST pattern is required');
  }
  const resolved = resolveProjectDir(projectDir, { requireSubdir: true, workspaceRoot, extraRoots: extraRoots ?? [WORKTREE_DIR] });
  const args = ['run', '--pattern', pattern.trim(), '--json=compact'];
  if (lang) args.push('--lang', assertSafeGlobOrArg(lang, 'lang'));
  args.push('--', resolved.windows);

  try {
    const { stdout } = await execFileAsync(exe, args, {
      cwd: resolved.windows,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    const parsed = stdout.trim() ? JSON.parse(stdout.trim()) : [];
    const list = Array.isArray(parsed) ? parsed : [];
    const cap = Math.max(1, Math.min(200, Number(maxMatches) || 40));
    const matches = list.slice(0, cap).map((m) => ({
      file: m.file,
      line: (m.range?.start?.line ?? 0) + 1,
      column: (m.range?.start?.column ?? 0) + 1,
      text: String(m.text || '').slice(0, 400),
    }));
    return {
      ok: true,
      project_dir: resolved.windows,
      pattern: pattern.trim(),
      total_matches: list.length,
      truncated: list.length > cap,
      matches,
    };
  } catch (err) {
    // sg exits 1 when 0 matches in some modes
    if (err.stdout && String(err.stdout).trim() === '[]') {
      return { ok: true, project_dir: resolved.windows, pattern: pattern.trim(), total_matches: 0, truncated: false, matches: [] };
    }
    throw new Error(`ast-grep failed: ${String(err.stderr || err.message || '').slice(0, 400)}`);
  }
}

/**
 * 4. Git-native long-horizon issue/dependency graph via steveyegge/beads (bd.exe).
 */
export async function runBeads({
  projectDir, action, title = null, description = null, issueId = null, status = null, priority = null, workspaceRoot, extraRoots,
}) {
  const exe = requireToolFile(TOOLKIT_PATHS.beadsExe, 'bd.exe');
  const resolved = resolveProjectDir(projectDir, { requireSubdir: true, workspaceRoot, extraRoots: extraRoots ?? [WORKTREE_DIR] });
  const allowedActions = new Set(['init', 'list', 'ready', 'show', 'create', 'close']);
  if (!allowedActions.has(action)) {
    throw new Error(`Invalid beads action "${action}". Allowed: ${[...allowedActions].join(', ')}`);
  }

  let args;
  if (action === 'init') args = ['init', '--quiet'];
  else if (action === 'list') args = ['list', '--json'];
  else if (action === 'ready') args = ['ready', '--json'];
  else if (action === 'show') {
    args = ['show', assertSafeGlobOrArg(issueId, 'issue_id'), '--json'];
  } else if (action === 'create') {
    if (!title || !String(title).trim()) throw new Error('title is required for beads create');
    const safeTitle = String(title).trim();
    if (/[\0\r\n]/.test(safeTitle)) throw new Error('title must not contain newlines or null bytes');
    args = ['create', '--json', '--', safeTitle];
    if (description) args.push('-d', String(description).trim().slice(0, 4000));
    if (priority !== null && priority !== undefined) args.push('-p', String(Math.max(0, Math.min(4, Number(priority)))));
  } else if (action === 'close') {
    args = ['close', assertSafeGlobOrArg(issueId, 'issue_id'), '--json'];
    if (status) args.push('--reason', String(status).slice(0, 300));
  }

  let stdout = '';
  try {
    ({ stdout } = await execFileAsync(exe, args, {
      cwd: resolved.windows,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    const detail = String(err.stderr || err.message || 'unknown error').slice(0, 400);
    throw new Error(`beads ${action} failed: ${detail}`);
  }
  const trimmed = stdout.trim();
  try {
    return { ok: true, project_dir: resolved.windows, action, data: JSON.parse(trimmed) };
  } catch {
    return { ok: true, project_dir: resolved.windows, action, output: trimmed.slice(0, 8000) };
  }
}

/**
 * 5. Local PDF/Word/Excel/PPT/HTML -> Markdown conversion via microsoft/markitdown.
 * Strictly jailed to files inside allowed project roots.
 */
export async function convertDocToMd({ filePath, maxChars = 32000, workspaceRoot, extraRoots }) {
  const exe = requireToolFile(TOOLKIT_PATHS.markitdownExe, 'markitdown.exe');
  if (typeof filePath !== 'string' || !filePath.trim() || /[\0\r\n]/.test(filePath)) {
    throw new Error('file_path is required');
  }
  const abs = path.resolve(filePath.trim());
  const parentDir = path.dirname(abs);
  resolveProjectDir(parentDir, { requireSubdir: false, workspaceRoot, extraRoots: extraRoots ?? [WORKTREE_DIR] });
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new Error(`Document file does not exist: ${abs}`);
  }
  const canonical = fs.realpathSync(abs);
  // Re-verify realpath parent is still inside allowed roots
  resolveProjectDir(path.dirname(canonical), { requireSubdir: false, workspaceRoot, extraRoots: extraRoots ?? [WORKTREE_DIR] });

  const { stdout } = await execFileAsync(exe, [canonical], {
    encoding: 'utf8',
    timeout: 60000,
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  const truncated = stdout.length > maxChars;
  return {
    ok: true,
    file_path: canonical,
    total_chars: stdout.length,
    truncated,
    markdown: truncated ? stdout.slice(0, maxChars) + '\n\n... [markdown truncated]' : stdout,
  };
}
