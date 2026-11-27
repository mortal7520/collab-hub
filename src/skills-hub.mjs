/**
 * CollabHub v1.5.0 — Cross-Agent Skills & Rules Sync Hub
 *
 * Adapted & ported (zero npm runtime dependencies) from open-source upstream patterns:
 * - lbb00/ai-rules-sync (Unlicense, ddc7704653ac): unified adapter layout for Skills
 *   (`SKILL.md`) and Rules (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/*.mdc`)
 *   across Antigravity, Claude Code, Codex, Cursor, and Windsurf.
 * - fALECX/shareskills (ISC, 4b68eb88b117): central skill inventory, backup filtering,
 *   and recursive directory merge semantics.
 * - viteinfinite/sync-skills (MIT, 88e22f83eb16): cross-client `.claude` <-> `.codex` skill diffing.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WORKSPACE_ROOT, resolveProjectDir } from './config.mjs';
import { logEvent } from './db.mjs';
import { detectInlineSecret } from './mcp-hub.mjs';

const SAFE_SKILL_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_SKILL_FILE_BYTES = 512 * 1024;
const MAX_SKILL_FILES = 40;

export function assertValidSkillName(name) {
  if (typeof name !== 'string' || !SAFE_SKILL_NAME.test(name.trim())) {
    throw new Error(`Invalid skill name "${name}": use 1-64 chars of [A-Za-z0-9._-]`);
  }
  return name.trim();
}

/**
 * Default local AI client Skill directory adapters (Antigravity, Claude Code, Codex, Cursor).
 */
export function getDefaultSkillAdapters({ homedir = os.homedir() } = {}) {
  return [
    {
      id: 'antigravity',
      name: 'Antigravity',
      dirs: [
        path.join(homedir, '.gemini', 'config', 'skills'),
        path.join(homedir, '.gemini', 'antigravity', 'skills'),
      ],
    },
    {
      id: 'claude',
      name: 'Claude Code',
      dirs: [path.join(homedir, '.claude', 'skills')],
    },
    {
      id: 'codex',
      name: 'Codex',
      dirs: [
        path.join(homedir, '.codex', 'skills'),
        path.join(homedir, '.agents', 'skills'),
      ],
    },
    {
      id: 'cursor',
      name: 'Cursor',
      dirs: [path.join(homedir, '.cursor', 'skills')],
    },
  ];
}

/**
 * Supported project/workspace-level Rules & Instructions file adapters.
 */
export const RULE_TARGETS = Object.freeze([
  { id: 'agents-md', name: 'AGENTS.md (Universal / AGY / Codex)', relPath: 'AGENTS.md', dialect: 'markdown' },
  { id: 'claude-md', name: 'CLAUDE.md (Claude Code)', relPath: 'CLAUDE.md', dialect: 'markdown' },
  { id: 'gemini-md', name: 'GEMINI.md (Gemini CLI / AGY)', relPath: 'GEMINI.md', dialect: 'markdown' },
  { id: 'cursor-rules', name: '.cursor/rules/project.mdc (Cursor)', relPath: '.cursor/rules/project.mdc', dialect: 'mdc' },
  { id: 'windsurf-rules', name: '.windsurfrules (Windsurf)', relPath: '.windsurfrules', dialect: 'markdown' },
]);

/**
 * Lightweight zero-dependency YAML frontmatter parser for SKILL.md and .mdc rule files.
 */
export function parseFrontmatter(markdownText) {
  const text = String(markdownText || '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { frontmatter: {}, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (!kv) continue;
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    fm[kv[1]] = val;
  }
  return { frontmatter: fm, body: m[2] };
}

function bufferHasInlineSecret(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  if (detectInlineSecret(buf.toString('utf8'))) return true;
  if (buf.includes(0)) {
    // Decode UTF-16LE and UTF-16BE (with or without BOM) so UTF-16 secrets cannot bypass NUL checks!
    const leView = (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) ? buf.subarray(2) : buf;
    if (detectInlineSecret(leView.toString('utf16le'))) return true;
    const swapped = Buffer.from(buf);
    for (let i = 0; i + 1 < swapped.length; i += 2) {
      const tmp = swapped[i];
      swapped[i] = swapped[i + 1];
      swapped[i + 1] = tmp;
    }
    const beView = (swapped.length >= 2 && swapped[0] === 0xff && swapped[1] === 0xfe) ? swapped.subarray(2) : swapped;
    if (detectInlineSecret(beView.toString('utf16le'))) return true;
  }
  return false;
}

function sha256Short(text) {
  return createHash('sha256').update(String(text || '').replace(/\r\n/g, '\n'), 'utf8').digest('hex').slice(0, 16);
}

function resolveAdapterRootDir(adapter) {
  const dirs = Array.isArray(adapter.dirs) ? adapter.dirs : [adapter.dir].filter(Boolean);
  return dirs.find((d) => d && fs.existsSync(d) && fs.statSync(d).isDirectory()) || dirs[0] || null;
}

function readSkillEntry(skillDir, skillName) {
  const skillMdPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMdPath)) return null;
  const st = fs.statSync(skillMdPath);
  if (!st.isFile() || st.size > MAX_SKILL_FILE_BYTES) return null;
  const raw = fs.readFileSync(skillMdPath, 'utf8');
  const { frontmatter, body } = parseFrontmatter(raw);
  const subFiles = [];
  let truncated = false;
  const walk = (dir, prefix = '') => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name.includes('.bak.') || ent.name.includes('.backup_')) continue;
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else if (ent.isFile()) {
        if (subFiles.length >= MAX_SKILL_FILES) {
          truncated = true;
          return;
        }
        subFiles.push(rel);
      }
      if (truncated) return;
    }
  };
  walk(skillDir);
  const sortedFiles = subFiles.sort();
  let secretInline = detectInlineSecret(raw);
  let oversized = false;
  const manifestLines = [];
  for (const rel of sortedFiles) {
    const abs = path.join(skillDir, rel);
    try {
      const fst = fs.statSync(abs);
      if (fst.size <= MAX_SKILL_FILE_BYTES) {
        const buf = fs.readFileSync(abs);
        const fhash = createHash('sha256').update(buf).digest('hex').slice(0, 16);
        manifestLines.push(`${rel}:${fhash}`);
        if (!secretInline && bufferHasInlineSecret(buf)) {
          secretInline = true;
        }
      } else {
        oversized = true;
        manifestLines.push(`${rel}:size=${fst.size}`);
      }
    } catch { /* skip unreadable */ }
  }
  return {
    name: skillName,
    title: frontmatter.name || skillName,
    description: String(frontmatter.description || '').slice(0, 220),
    hash: sha256Short(`${raw}\n---\n${manifestLines.join('\n')}`),
    body_preview: body.trim().slice(0, 320),
    bytes: Buffer.byteLength(raw, 'utf8'),
    files_count: sortedFiles.length,
    files: sortedFiles,
    truncated,
    oversized,
    secret_inline: secretInline,
    updated_at: st.mtime.toISOString(),
  };
}

/**
 * Scan all configured local AI clients for Skills (`SKILL.md` directories) and project Rules (`AGENTS.md`, `CLAUDE.md`, etc.).
 */
export function buildSkillsRulesSnapshot({
  projectDir = WORKSPACE_ROOT,
  skillAdapters = null,
  workspaceRoot = WORKSPACE_ROOT,
} = {}) {
  const adapters = skillAdapters || getDefaultSkillAdapters();
  const clients = [];
  const skillsByName = new Map();

  for (const adapter of adapters) {
    const rootDir = resolveAdapterRootDir(adapter);
    const exists = Boolean(rootDir && fs.existsSync(rootDir) && fs.statSync(rootDir).isDirectory());
    let skillCount = 0;
    const discovered = new Map();

    if (exists) {
      try {
        for (const ent of fs.readdirSync(rootDir, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          if (ent.name.startsWith('.') || ent.name.includes('.bak.') || ent.name.includes('.backup_')) continue;
          if (!SAFE_SKILL_NAME.test(ent.name)) continue;
          const full = path.join(rootDir, ent.name);
          const rec = readSkillEntry(full, ent.name);
          if (!rec) continue;
          discovered.set(ent.name, rec);
          skillCount += 1;
          if (!skillsByName.has(ent.name)) {
            skillsByName.set(ent.name, {
              name: ent.name,
              title: rec.title,
              description: rec.description,
              canonical_client: adapter.id,
              canonical_hash: rec.hash,
              bytes: rec.bytes,
              files_count: rec.files_count,
              files: rec.files,
              body_preview: rec.body_preview,
              secret_inline: rec.secret_inline,
              updated_at: rec.updated_at,
              client_presence: {},
              client_hashes: {},
            });
          } else if (rec.secret_inline) {
            skillsByName.get(ent.name).secret_inline = true;
          }
        }
      } catch { /* best-effort read */ }
    }

    clients.push({
      id: adapter.id,
      name: adapter.name,
      exists,
      skills_count: skillCount,
      discovered,
    });
  }

  let skillDriftCount = 0;
  let skillSyncedPairs = 0;
  for (const skill of skillsByName.values()) {
    for (const cli of clients) {
      const found = cli.discovered.get(skill.name);
      if (!found) {
        skill.client_presence[cli.id] = 'missing';
      } else if (found.hash === skill.canonical_hash) {
        skill.client_presence[cli.id] = 'present';
        skill.client_hashes[cli.id] = found.hash;
        skillSyncedPairs += 1;
      } else {
        skill.client_presence[cli.id] = 'drifted';
        skill.client_hashes[cli.id] = found.hash;
        skillDriftCount += 1;
      }
    }
  }

  // Scan project rules (safely resolved within workspaceRoot)
  let safeProjectDir = workspaceRoot;
  if (projectDir) {
    try {
      const resolved = resolveProjectDir(projectDir, { requireSubdir: false, workspaceRoot });
      safeProjectDir = resolved.windows;
    } catch {
      safeProjectDir = workspaceRoot;
    }
  }

  const rules = [];
  let canonicalRuleHash = null;
  let canonicalRuleId = null;
  for (const rt of RULE_TARGETS) {
    const absPath = path.join(safeProjectDir, rt.relPath);
    const exists = fs.existsSync(absPath) && fs.statSync(absPath).isFile();
    if (!exists) {
      rules.push({
        id: rt.id,
        name: rt.name,
        rel_path: rt.relPath,
        dialect: rt.dialect,
        exists: false,
        status: 'missing',
        hash: null,
        bytes: 0,
        preview: '',
        secret_inline: false,
        updated_at: null,
      });
      continue;
    }
    const st = fs.statSync(absPath);
    const raw = st.size <= MAX_SKILL_FILE_BYTES ? fs.readFileSync(absPath, 'utf8') : '';
    const { body } = rt.dialect === 'mdc' ? parseFrontmatter(raw) : { body: raw };
    const normHash = sha256Short(body.trim());
    if (!canonicalRuleHash) {
      canonicalRuleHash = normHash;
      canonicalRuleId = rt.id;
    }
    rules.push({
      id: rt.id,
      name: rt.name,
      rel_path: rt.relPath,
      dialect: rt.dialect,
      exists: true,
      status: normHash === canonicalRuleHash ? 'present' : 'drifted',
      hash: normHash,
      bytes: st.size,
      preview: body.trim().slice(0, 420),
      secret_inline: detectInlineSecret(raw),
      updated_at: st.mtime.toISOString(),
    });
  }

  const skills = [...skillsByName.values()].sort((a, b) => a.name.localeCompare(b.name));
  const publicClients = clients.map(({ discovered: _d, ...rest }) => rest);
  const rulesDetected = rules.filter((r) => r.exists).length;
  const rulesDrifted = rules.filter((r) => r.status === 'drifted').length;

  return {
    scanned_at: new Date().toISOString(),
    project_name: path.basename(safeProjectDir) || 'workspace',
    clients: publicClients,
    skills,
    rules,
    canonical_rule_id: canonicalRuleId,
    summary: {
      skills_total: skills.length,
      clients_detected: publicClients.filter((c) => c.exists).length,
      skill_synced_pairs: skillSyncedPairs,
      skill_drift_count: skillDriftCount,
      rules_detected: rulesDetected,
      rules_drifted: rulesDrifted,
    },
  };
}

function buildLineDiff(beforeText, afterText, label) {
  const a = String(beforeText || '').split(/\r?\n/);
  const b = String(afterText || '').split(/\r?\n/);
  const out = [`--- ${label} (current)`, `+++ ${label} (proposed)`];
  const maxLen = Math.max(a.length, b.length);
  let changed = 0;
  for (let i = 0; i < maxLen; i += 1) {
    if (a[i] === b[i]) continue;
    changed += 1;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    if (out.length > 140) {
      out.push('... [diff truncated]');
      break;
    }
  }
  if (changed === 0) out.push('  (no textual changes)');
  return { diff: out.join('\n'), changed_lines: changed };
}

/**
 * Sync a single Skill directory (`SKILL.md` + supporting files) from `sourceClient` to `targetClients`.
 * Default `confirmed: false` is a read-only Dry-Run returning diff preview + backup plan.
 * `confirmed: true` creates `.bak.<ts>` backup before overwriting any existing target skill directory.
 */
export function syncSkillAcrossClients(db, {
  skillName,
  sourceClient,
  targetClients = [],
  confirmed = false,
  skillAdapters = null,
} = {}) {
  const safeSkill = assertValidSkillName(skillName);
  const adapters = skillAdapters || getDefaultSkillAdapters();
  const srcAdapter = adapters.find((a) => a.id === sourceClient);
  if (!srcAdapter) throw new Error(`Unknown source skill client: ${sourceClient}`);
  const srcRoot = resolveAdapterRootDir(srcAdapter);
  const srcDir = srcRoot ? path.join(srcRoot, safeSkill) : null;
  if (!srcDir || !fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
    throw new Error(`Skill "${safeSkill}" not found in source client "${sourceClient}"`);
  }
  const srcEntry = readSkillEntry(srcDir, safeSkill);
  const srcSkillMd = fs.readFileSync(path.join(srcDir, 'SKILL.md'), 'utf8');
  if (srcEntry?.truncated) {
    throw new Error(`Security rule: skill "${safeSkill}" exceeds MAX_SKILL_FILES (${MAX_SKILL_FILES}) and cannot be fully secret-scanned; refusing partial sync.`);
  }
  if (srcEntry?.oversized) {
    throw new Error(`Security rule: skill "${safeSkill}" contains a file exceeding ${MAX_SKILL_FILE_BYTES} bytes that could bypass secret scanning.`);
  }
  if (srcEntry?.secret_inline || detectInlineSecret(srcSkillMd)) {
    throw new Error(`Security rule: inline secret detected inside skill "${safeSkill}" (SKILL.md or supporting file). Remove secrets before syncing.`);
  }

  // Build ONE bounded verified byte manifest so only bytes that passed inspection are ever staged/published!
  const verifiedManifest = [];
  for (const rel of (srcEntry?.files || ['SKILL.md'])) {
    const abs = path.join(srcDir, rel);
    const lst = fs.lstatSync(abs);
    if (lst.isSymbolicLink() || !lst.isFile() || lst.size > MAX_SKILL_FILE_BYTES) {
      throw new Error(`Security rule: skill file "${rel}" changed or exceeded limits during verification.`);
    }
    const buf = fs.readFileSync(abs);
    if (bufferHasInlineSecret(buf)) {
      throw new Error(`Security rule: inline secret detected inside skill file "${rel}". Remove secrets before syncing.`);
    }
    verifiedManifest.push({ rel, buf });
  }

  const targetIds = Array.isArray(targetClients) && targetClients.length > 0
    ? [...new Set(targetClients)].filter((id) => id !== sourceClient)
    : adapters.map((a) => a.id).filter((id) => id !== sourceClient);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const plans = [];

  for (const tid of targetIds) {
    const tAdapter = adapters.find((a) => a.id === tid);
    if (!tAdapter) throw new Error(`Unknown target skill client: ${tid}`);
    const tRoot = resolveAdapterRootDir(tAdapter);
    if (!tRoot) continue;
    const tDir = path.join(tRoot, safeSkill);
    const tSkillMdPath = path.join(tDir, 'SKILL.md');
    const existed = fs.existsSync(tSkillMdPath);
    const beforeText = existed ? fs.readFileSync(tSkillMdPath, 'utf8') : '';
    const { diff, changed_lines } = buildLineDiff(beforeText, srcSkillMd, `${tid}/${safeSkill}/SKILL.md`);
    const backupDir = `${tDir}.bak.${ts}`;

    if (confirmed === true) {
      fs.mkdirSync(tRoot, { recursive: true });
      const suffix = `${process.pid}.${Date.now()}`;
      const tmpDir = path.join(tRoot, `.${safeSkill}.collabhub-tmp.${suffix}`);
      const prevDir = path.join(tRoot, `.${safeSkill}.collabhub-prev.${suffix}`);
      fs.mkdirSync(tmpDir, { recursive: true });
      let movedLiveAside = false;
      try {
        for (const { rel, buf } of verifiedManifest) {
          const dest = path.join(tmpDir, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, buf);
        }
        if (fs.existsSync(tDir)) {
          fs.cpSync(tDir, backupDir, { recursive: true, force: true });
          fs.renameSync(tDir, prevDir);
          movedLiveAside = true;
        }
        fs.renameSync(tmpDir, tDir);
        if (movedLiveAside) {
          try { fs.rmSync(prevDir, { recursive: true, force: true }); } catch {}
        }
      } catch (err) {
        if (movedLiveAside && !fs.existsSync(tDir) && fs.existsSync(prevDir)) {
          try { fs.renameSync(prevDir, tDir); } catch {}
        }
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        throw err;
      }
    }

    plans.push({
      target_client: tid,
      target_name: tAdapter.name,
      existed,
      backup_basename: existed ? path.basename(backupDir) : null,
      changed_lines,
      diff_preview: diff,
      applied: confirmed === true,
    });
  }

  if (confirmed === true && db) {
    logEvent(db, {
      eventType: 'skills.synced',
      actor: 'collab-hub',
      payload: { skill: safeSkill, source: sourceClient, targets: plans.map((p) => p.target_client) },
    });
  }

  return {
    mode: confirmed === true ? 'applied' : 'dry_run',
    applied: confirmed === true,
    skill_name: safeSkill,
    source_client: sourceClient,
    plans,
  };
}

/**
 * Sync a project Rule/Instructions file (e.g. `AGENTS.md` -> `CLAUDE.md`, `GEMINI.md`, `.cursor/rules/project.mdc`)
 * with dialect adaptation (`.mdc` frontmatter wrapper), Dry-Run diff preview, `.bak` backup, and explicit confirm.
 */
export function syncRuleAcrossTargets(db, {
  projectDir = WORKSPACE_ROOT,
  sourceRuleId = 'agents-md',
  targetRuleIds = [],
  confirmed = false,
  workspaceRoot = WORKSPACE_ROOT,
} = {}) {
  const resolved = resolveProjectDir(projectDir, { requireSubdir: false, workspaceRoot });
  const rootDir = resolved.windows;
  const srcSpec = RULE_TARGETS.find((r) => r.id === sourceRuleId);
  if (!srcSpec) throw new Error(`Unknown source rule id: ${sourceRuleId}`);
  const srcPath = path.join(rootDir, srcSpec.relPath);
  if (!fs.existsSync(srcPath) || !fs.statSync(srcPath).isFile()) {
    throw new Error(`Source rule file not found: ${srcSpec.relPath}`);
  }
  const rawSrc = fs.readFileSync(srcPath, 'utf8');
  if (detectInlineSecret(rawSrc)) {
    throw new Error(`Security rule: inline secret detected inside ${srcSpec.relPath}. Remove secrets before syncing.`);
  }
  const { body: canonicalBody } = srcSpec.dialect === 'mdc' ? parseFrontmatter(rawSrc) : { body: rawSrc };
  const cleanBody = canonicalBody.trim() + '\n';

  const targets = Array.isArray(targetRuleIds) && targetRuleIds.length > 0
    ? [...new Set(targetRuleIds)].filter((id) => id !== sourceRuleId)
    : RULE_TARGETS.map((r) => r.id).filter((id) => id !== sourceRuleId);

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const plans = [];

  for (const tid of targets) {
    const tSpec = RULE_TARGETS.find((r) => r.id === tid);
    if (!tSpec) throw new Error(`Unknown target rule id: ${tid}`);
    const dstPath = path.join(rootDir, tSpec.relPath);
    const relCheck = path.relative(rootDir, dstPath);
    if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) {
      throw new Error(`Unsafe target path for rule ${tid}`);
    }
    const afterText = tSpec.dialect === 'mdc'
      ? `---\ndescription: Synced project rules from ${srcSpec.relPath}\nalwaysApply: true\n---\n\n${cleanBody}`
      : cleanBody;
    const existed = fs.existsSync(dstPath);
    const beforeText = existed ? fs.readFileSync(dstPath, 'utf8') : '';
    const { diff, changed_lines } = buildLineDiff(beforeText, afterText, tSpec.relPath);
    const backupPath = `${dstPath}.bak.${ts}`;

    if (confirmed === true) {
      fs.mkdirSync(path.dirname(dstPath), { recursive: true });
      if (existed) fs.copyFileSync(dstPath, backupPath);
      const tmp = `${dstPath}.collabhub-tmp.${process.pid}`;
      fs.writeFileSync(tmp, afterText, 'utf8');
      fs.renameSync(tmp, dstPath);
    }

    plans.push({
      target_rule_id: tid,
      rel_path: tSpec.relPath,
      dialect: tSpec.dialect,
      existed,
      backup_basename: existed ? path.basename(backupPath) : null,
      changed_lines,
      diff_preview: diff,
      applied: confirmed === true,
    });
  }

  if (confirmed === true && db) {
    logEvent(db, {
      eventType: 'rules.synced',
      actor: 'collab-hub',
      payload: { source: sourceRuleId, targets: plans.map((p) => p.target_rule_id) },
    });
  }

  return {
    mode: confirmed === true ? 'applied' : 'dry_run',
    applied: confirmed === true,
    source_rule_id: sourceRuleId,
    project_name: path.basename(rootDir) || 'workspace',
    plans,
  };
}
