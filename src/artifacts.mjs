/**
 * CollabHub v2.2 — Shared Artifact Vault (`shared_artifacts`)
 *
 * Cross-host artifact store for patches, review reports, JSON summaries, and context bundles.
 * - Hard size cap (256 KB per artifact)
 * - Automatic inline-secret redaction before persistence
 * - SHA-256 content integrity & TTL expiration cleanup
 */
import { createHash, randomUUID } from 'node:crypto';
import { logEvent } from './db.mjs';

export const MAX_ARTIFACT_BYTES = 256 * 1024;

const SECRET_REDACTION_PATTERNS = [
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, '[REDACTED_PRIVATE_KEY]'],
  [/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*/g, '[REDACTED_PRIVATE_KEY]'],
  [/-----BEGIN PGP PRIVATE KEY BLOCK-----[\s\S]*?(?:-----END PGP PRIVATE KEY BLOCK-----|$)/g, '[REDACTED_PRIVATE_KEY]'],
  [/\bsk-proj-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]'],
  [/\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]'],
  [/\bsk-[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_KEY]'],
  [/\bghp_[A-Za-z0-9]{20,}\b/g, '[REDACTED_TOKEN]'],
  [/\bgithub_pat_[A-Za-z0-9_]{24,}\b/g, '[REDACTED_TOKEN]'],
  [/\bglpat-[A-Za-z0-9_-]{18,}\b/g, '[REDACTED_TOKEN]'],
  [/\bxox[baprs]-[A-Za-z0-9-]{16,}\b/g, '[REDACTED_TOKEN]'],
  [/\bAIza[0-9A-Za-z_-]{28,}\b/g, '[REDACTED_KEY]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED_AWS_KEY]'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/gi, 'Bearer [REDACTED]'],
];

export function redactArtifactSecrets(text) {
  let out = String(text ?? '');
  let redacted = false;
  for (const [re, rep] of SECRET_REDACTION_PATTERNS) {
    const next = out.replace(re, rep);
    if (next !== out) redacted = true;
    out = next;
  }
  return { text: out, redacted };
}

function parseArtifactRow(row, includeContent = false) {
  if (!row) return null;
  let tags = [];
  try { tags = JSON.parse(row.tags_json || '[]'); } catch { tags = []; }
  const out = {
    artifact_id: row.artifact_id,
    room_id: row.room_id || null,
    project: row.project || null,
    name: row.name,
    mime_type: row.mime_type,
    sha256: row.sha256,
    size_bytes: row.size_bytes,
    author: row.author,
    tags: Array.isArray(tags) ? tags : [],
    expires_at: row.expires_at || null,
    created_at: row.created_at,
  };
  if (includeContent) out.content = row.content;
  return out;
}

export function pruneExpiredArtifacts(db) {
  const now = new Date().toISOString();
  const res = db.prepare('DELETE FROM shared_artifacts WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  return { pruned: res.changes || 0, checked_at: now };
}

export function putArtifact(db, {
  artifactId = null,
  roomId = null,
  project = null,
  name,
  content,
  mimeType = 'text/markdown',
  author = 'collab-hub',
  tags = [],
  ttlHours = 72,
} = {}) {
  const safeName = String(name || '').trim().slice(0, 120);
  if (!safeName || /[\\/\0]|\.\./.test(safeName)) {
    throw new Error('Invalid artifact name');
  }
  const rawContent = String(content ?? '');
  if (!rawContent) throw new Error('Artifact content is required');
  if (Buffer.byteLength(rawContent, 'utf8') > MAX_ARTIFACT_BYTES) {
    throw new Error(`Artifact exceeds max ${MAX_ARTIFACT_BYTES} bytes cap`);
  }
  pruneExpiredArtifacts(db);

  const { text: cleanText, redacted } = redactArtifactSecrets(rawContent);
  const sha256 = createHash('sha256').update(cleanText, 'utf8').digest('hex');
  const sizeBytes = Buffer.byteLength(cleanText, 'utf8');
  const id = artifactId ? String(artifactId).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48) : `art_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  if (!id) throw new Error('Invalid artifact_id');

  const now = new Date().toISOString();
  const ttlNum = ttlHours === null || ttlHours === 0 ? null : Math.max(1, Math.min(24 * 90, Number(ttlHours) || 72));
  const expiresAt = ttlNum ? new Date(Date.now() + ttlNum * 3600 * 1000).toISOString() : null;
  const tagList = Array.isArray(tags) ? tags.map((t) => String(t).slice(0, 32)).filter(Boolean).slice(0, 10) : [];

  db.prepare(`
    INSERT INTO shared_artifacts (artifact_id, room_id, project, name, mime_type, sha256, size_bytes, content, author, tags_json, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(artifact_id) DO UPDATE SET
      room_id = excluded.room_id,
      project = excluded.project,
      name = excluded.name,
      mime_type = excluded.mime_type,
      sha256 = excluded.sha256,
      size_bytes = excluded.size_bytes,
      content = excluded.content,
      author = excluded.author,
      tags_json = excluded.tags_json,
      expires_at = excluded.expires_at
  `).run(id, roomId || null, project || null, safeName, String(mimeType || 'text/plain').slice(0, 80), sha256, sizeBytes, cleanText, String(author || 'collab-hub').slice(0, 40), JSON.stringify(tagList), expiresAt, now);

  logEvent(db, {
    eventType: 'artifact.saved',
    actor: String(author || 'collab-hub'),
    payload: { artifact_id: id, name: safeName, size_bytes: sizeBytes, redacted, room_id: roomId || null },
  });

  const saved = getArtifact(db, id);
  return { ...saved, secrets_redacted: redacted };
}

export function getArtifact(db, artifactId) {
  const row = db.prepare('SELECT * FROM shared_artifacts WHERE artifact_id = ?').get(String(artifactId || ''));
  if (!row) return null;
  if (row.expires_at && row.expires_at <= new Date().toISOString()) {
    db.prepare('DELETE FROM shared_artifacts WHERE artifact_id = ?').run(row.artifact_id);
    return null;
  }
  return parseArtifactRow(row, true);
}

export function listArtifacts(db, { roomId = null, project = null, limit = 30 } = {}) {
  pruneExpiredArtifacts(db);
  const lim = Math.max(1, Math.min(100, Number(limit) || 30));
  let sql = 'SELECT * FROM shared_artifacts';
  const conds = [];
  const params = [];
  if (roomId) { conds.push('room_id = ?'); params.push(String(roomId)); }
  if (project) { conds.push('project = ?'); params.push(String(project)); }
  if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC LIMIT ?';
  params.push(lim);
  return db.prepare(sql).all(...params).map((r) => parseArtifactRow(r, false));
}

export function deleteArtifact(db, artifactId) {
  const res = db.prepare('DELETE FROM shared_artifacts WHERE artifact_id = ?').run(String(artifactId || ''));
  if (!res.changes) throw new Error(`Artifact not found: ${artifactId}`);
  logEvent(db, { eventType: 'artifact.deleted', actor: 'collab-hub', payload: { artifact_id: String(artifactId) } });
  return { deleted: true, artifact_id: String(artifactId) };
}
