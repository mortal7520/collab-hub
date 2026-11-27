/**
 * CollabHub v2.2 — Cross-Agent Context Handoff Pack (`buildHandoffPack`)
 *
 * One-call sanitized snapshot bundling Git state, recent tasks, active room claims/logs,
 * relevant memory notes, and active incident guardrails so ANY heterogeneous agent
 * (`AGY` / `Codex` / `Claude` / `DSH` / `Muse` / custom CLI) can resume cleanly in 1 step.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { putArtifact, redactArtifactSecrets } from './artifacts.mjs';
import { WORKSPACE_ROOT, WORKTREE_DIR, resolveProjectDir } from './config.mjs';
import { parseTaskRow } from './db.mjs';
import { listMemoryNotes } from './memory.mjs';
import { listIncidentLessons } from './self-improve.mjs';
import { getRoomStatus } from './workspace-room.mjs';

function safeGit(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true }).trim();
  } catch {
    return '';
  }
}

export function buildHandoffPack(db, {
  projectDir = WORKSPACE_ROOT,
  roomId = null,
  targetMember = null,
  saveArtifact = false,
  maxBytes = 24000,
  workspaceRoot = WORKSPACE_ROOT,
  extraRoots = [WORKTREE_DIR],
} = {}) {
  let dir = workspaceRoot || WORKSPACE_ROOT;
  if (projectDir && String(projectDir).trim()) {
    dir = resolveProjectDir(projectDir, {
      workspaceRoot: workspaceRoot || WORKSPACE_ROOT,
      extraRoots: Array.isArray(extraRoots) ? extraRoots : [WORKTREE_DIR],
    }).windows;
  }
  const gitBranch = dir && fs.existsSync(dir) ? safeGit(dir, ['rev-parse', '--abbrev-ref', 'HEAD']) : '';
  const gitStatus = dir && fs.existsSync(dir) ? safeGit(dir, ['status', '--short']).split(/\r?\n/).filter(Boolean).slice(0, 25) : [];
  const gitDiffStat = dir && fs.existsSync(dir) ? safeGit(dir, ['diff', '--stat']) : '';

  const recentTasks = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT 8').all().map((r) => {
    const t = parseTaskRow(r);
    return {
      task_id: t.task_id,
      member: t.member,
      state: t.state,
      title: t.title,
      error_code: t.error_code,
      updated_at: t.updated_at,
    };
  });

  const openComments = db.prepare("SELECT task_id, file_path, line_no, author, body FROM worktree_comments WHERE status = 'open' ORDER BY id DESC LIMIT 10").all();
  const memories = listMemoryNotes(db, { project: dir ? path.basename(dir) : null, limit: 5 });
  const lessons = listIncidentLessons(db, { member: targetMember || null, activeOnly: true }).slice(0, 8);

  let room = null;
  if (roomId) {
    try { room = getRoomStatus(db, roomId); } catch { room = null; }
  }

  const lines = [
    `# CollabHub Context Handoff Pack`,
    `- **Generated**: ${new Date().toISOString()}`,
    `- **Project**: \`${dir}\`${gitBranch ? ` (branch \`${gitBranch}\`)` : ''}`,
    ...(targetMember ? [`- **Target Agent**: \`${targetMember}\``] : []),
    ...(room ? [`- **Shared Room**: \`${room.name}\` (${room.active_claims.length} active claims)`] : []),
    '',
    '## Git Working Tree',
    gitStatus.length ? gitStatus.map((l) => `- \`${l}\``).join('\n') : '- (clean or not a git repository)',
    ...(gitDiffStat ? ['', '```text', gitDiffStat.slice(0, 1800), '```'] : []),
    '',
    '## Recent Tasks',
    ...(recentTasks.length
      ? recentTasks.map((t) => `- \`${t.task_id}\` [${t.member}:${t.state}] ${t.title}${t.error_code ? ` (${t.error_code})` : ''}`)
      : ['- (none)']),
    ...(openComments.length ? ['', '## Open Diff Review Comments', ...openComments.map((c) => `- \`${c.task_id}\` ${c.file_path}:${c.line_no ?? '?'} (${c.author}): ${c.body}`)] : []),
    ...(room ? [
      '',
      '## Shared Room Leases & Log Tail',
      ...(room.active_claims.length
        ? room.active_claims.map((c) => `- CLAIM \`${c.path_glob}\` owned by \`${c.owner_agent}\` until ${c.lease_expires_at}`)
        : ['- No active exclusive claims']),
      ...room.logs.slice(0, 8).map((l) => `- LOG ${l.created_at} [${l.actor}] ${l.message}`),
    ] : []),
    ...(lessons.length ? ['', '## Active Runtime Guardrails', ...lessons.map((l) => `- [${l.member}] ${l.guardrail}`)] : []),
    ...(memories.length ? ['', '## Key Project Memory Notes', ...memories.map((m) => `- **${m.title}** (\`${m.slug}\`): ${String(m.body || '').replace(/\s+/g, ' ').slice(0, 220)}`)] : []),
  ];

  const cap = Math.max(2048, Math.min(128000, Number(maxBytes) || 24000));
  const { text: cleanMd, redacted } = redactArtifactSecrets(lines.join('\n').slice(0, cap));

  let artifact = null;
  if (saveArtifact) {
    artifact = putArtifact(db, {
      roomId: room?.room_id || null,
      project: dir ? path.basename(dir) : 'workspace',
      name: `handoff-${targetMember || 'team'}.md`,
      content: cleanMd,
      mimeType: 'text/markdown',
      author: 'collab-hub',
      tags: ['handoff', ...(targetMember ? [targetMember] : [])],
    });
  }

  return {
    generated_at: new Date().toISOString(),
    project_dir: dir,
    git_branch: gitBranch || null,
    target_member: targetMember || null,
    secrets_redacted: redacted,
    bytes: Buffer.byteLength(cleanMd, 'utf8'),
    markdown: cleanMd,
    artifact,
    summary: {
      git_changed_files: gitStatus.length,
      recent_tasks: recentTasks.length,
      open_comments: openComments.length,
      active_room_claims: room ? room.active_claims.length : 0,
      guardrails: lessons.length,
    },
  };
}
