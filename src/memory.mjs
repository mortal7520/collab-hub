import fs from 'node:fs';
import path from 'node:path';
import { MEMORY_DIR } from './config.mjs';
import { logEvent } from './db.mjs';

function sanitizeSegment(value, fallback = 'default') {
  const cleaned = String(value || '').trim().toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return cleaned || fallback;
}

export function writeMemoryNote(db, {
  project, slug, title, content, tags = [], author = 'coordinator', memoryDir = MEMORY_DIR,
}) {
  if (!project || !String(project).trim()) throw new Error('project is required');
  if (!title || !String(title).trim()) throw new Error('title is required');
  if (!content || !String(content).trim()) throw new Error('content is required');

  const safeProject = sanitizeSegment(project, 'workspace');
  const safeSlug = sanitizeSegment(slug || title, `note-${Date.now()}`);
  const tagStr = Array.isArray(tags) ? tags.map((t) => String(t).trim()).filter(Boolean).join(', ') : String(tags || '');
  const now = new Date().toISOString();

  const projDir = path.join(memoryDir, safeProject);
  fs.mkdirSync(projDir, { recursive: true });
  const filePath = path.join(projDir, `${safeSlug}.md`);
  const md = [
    '---',
    `project: ${safeProject}`,
    `slug: ${safeSlug}`,
    `title: ${JSON.stringify(String(title).trim())}`,
    `tags: ${JSON.stringify(tagStr)}`,
    `author: ${JSON.stringify(String(author || 'coordinator'))}`,
    `updated_at: ${now}`,
    '---',
    '',
    String(content).trim(),
    '',
  ].join('\n');

  // SQLite is authoritative: commit inside short transaction first, then atomically export Markdown
  // (never hold SQLite write lock across disk I/O or leave unindexed files on rollback).
  db.exec('BEGIN IMMEDIATE;');
  try {
    db.prepare(`
      INSERT INTO memory_notes (project, slug, title, tags, author, file_path, content, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project, slug) DO UPDATE SET
        title = excluded.title,
        tags = excluded.tags,
        author = excluded.author,
        file_path = excluded.file_path,
        content = excluded.content,
        updated_at = excluded.updated_at
    `).run(safeProject, safeSlug, String(title).trim(), tagStr, String(author || 'coordinator'), filePath, String(content).trim(), now);
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }

  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, md, 'utf8');
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch {}
    console.error(`[collab-hub] memory markdown export warning (${filePath}): ${err.message}`);
  }

  logEvent(db, { eventType: 'memory.write', actor: author, payload: { project: safeProject, slug: safeSlug, title } });
  return { project: safeProject, slug: safeSlug, title: String(title).trim(), tags: tagStr, author, file_path: filePath, updated_at: now };
}

export function listMemoryNotes(db, { project = null, limit = 30 } = {}) {
  const safeLimit = Math.max(1, Math.min(200, Number(limit) || 30));
  if (project) {
    const safeProject = sanitizeSegment(project);
    return db.prepare(`
      SELECT id, project, slug, title, tags, author, file_path, substr(content, 1, 240) AS preview, updated_at
      FROM memory_notes WHERE project = ? ORDER BY updated_at DESC LIMIT ?
    `).all(safeProject, safeLimit);
  }
  return db.prepare(`
    SELECT id, project, slug, title, tags, author, file_path, substr(content, 1, 240) AS preview, updated_at
    FROM memory_notes ORDER BY updated_at DESC LIMIT ?
  `).all(safeLimit);
}

/**
 * Hybrid search: SQLite FTS5 + SQL-side LIKE filter (supports CJK substrings without scanning full table in JS).
 */
export function searchMemoryNotes(db, { query, project = null, limit = 15 } = {}) {
  const q = String(query || '').trim();
  if (!q) return listMemoryNotes(db, { project, limit });
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 15));
  const safeProject = project ? sanitizeSegment(project) : null;

  const scores = new Map();
  const rowsById = new Map();

  // 1. FTS5 query (sanitize operators & reserved keywords so URLs/colons/hyphens never break MATCH)
  const ftsKeywords = new Set(['AND', 'OR', 'NOT', 'NEAR']);
  const ftsTokens = q
    .split(/[\s:/\\.,;!?()[\]{}"'`~*^+<>|=-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !ftsKeywords.has(t.toUpperCase()))
    .slice(0, 8);
  if (ftsTokens.length > 0) {
    const ftsExpr = ftsTokens.map((t) => `"${t.replaceAll('"', '')}"*`).join(' OR ');
    try {
      const ftsSql = safeProject
        ? `SELECT m.*, bm25(memory_notes_fts) AS rank FROM memory_notes_fts f JOIN memory_notes m ON m.id = f.rowid WHERE memory_notes_fts MATCH ? AND m.project = ? ORDER BY rank LIMIT ?`
        : `SELECT m.*, bm25(memory_notes_fts) AS rank FROM memory_notes_fts f JOIN memory_notes m ON m.id = f.rowid WHERE memory_notes_fts MATCH ? ORDER BY rank LIMIT ?`;
      const ftsRows = safeProject
        ? db.prepare(ftsSql).all(ftsExpr, safeProject, safeLimit * 2)
        : db.prepare(ftsSql).all(ftsExpr, safeLimit * 2);
      for (const r of ftsRows) {
        rowsById.set(r.id, r);
        scores.set(r.id, (scores.get(r.id) || 0) + 10 - Math.min(9, Math.abs(Number(r.rank) || 0)));
      }
    } catch {
      // fallback to SQL LIKE below
    }
  }

  // 2. SQL-side LIKE query for exact & CJK substrings
  const terms = q.split(/\s+/).filter(Boolean).slice(0, 6);
  const likeClauses = [];
  const params = [];
  if (safeProject) {
    likeClauses.push('project = ?');
    params.push(safeProject);
  }
  const termOr = [];
  for (const term of terms) {
    const pat = `%${term.replace(/[\\%_]/g, '\\$&')}%`;
    termOr.push("(title LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR content LIKE ? ESCAPE '\\' OR slug LIKE ? ESCAPE '\\')");
    params.push(pat, pat, pat, pat);
  }
  if (termOr.length) likeClauses.push(`(${termOr.join(' OR ')})`);
  const where = likeClauses.length ? `WHERE ${likeClauses.join(' AND ')}` : '';
  const sqlRows = db.prepare(`SELECT * FROM memory_notes ${where} ORDER BY updated_at DESC LIMIT ?`).all(...params, safeLimit * 3);

  const lowerQ = q.toLowerCase();
  for (const row of sqlRows) {
    const hayTitle = `${row.title} ${row.slug}`.toLowerCase();
    const hayTags = (row.tags || '').toLowerCase();
    const hayContent = (row.content || '').toLowerCase();
    let score = 0;
    if (hayTitle.includes(lowerQ)) score += 20;
    if (hayTags.includes(lowerQ)) score += 12;
    if (hayContent.includes(lowerQ)) score += 8;
    for (const term of terms) {
      const lt = term.toLowerCase();
      if (hayTitle.includes(lt)) score += 6;
      if (hayTags.includes(lt)) score += 4;
      if (hayContent.includes(lt)) score += 3;
    }
    if (score > 0) {
      rowsById.set(row.id, row);
      scores.set(row.id, (scores.get(row.id) || 0) + score);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, safeLimit)
    .map(([id, score]) => {
      const r = rowsById.get(id);
      return {
        id: r.id,
        project: r.project,
        slug: r.slug,
        title: r.title,
        tags: r.tags,
        author: r.author,
        file_path: r.file_path,
        content: r.content,
        updated_at: r.updated_at,
        score: Number(score.toFixed(2)),
      };
    });
}
