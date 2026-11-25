import { logEvent } from './db.mjs';

const BUILTIN_RECIPES = [
  {
    recipe_id: 'security-redteam',
    title: '安全红队对抗审计',
    role: 'reviewer',
    tags: 'security, redteam, audit',
    prompt: '从第一性原理做对抗式安全审计：逐一检查路径穿越、命令/参数注入、SSRF/CSRF/DNS重绑定、并发竞态、密钥泄漏与权限边界绕过。按 Critical / High / Medium 输出具体文件行号、复现路径与最小修复补丁。',
  },
  {
    recipe_id: 'pr-diff-review',
    title: '精准代码变更审查 (PR Review)',
    role: 'reviewer',
    tags: 'review, quality, regression',
    prompt: '审查当前仓库/分支的最新代码改动：重点关注边界条件、错误处理遗漏、资源泄漏、向后兼容性及测试缺口。给出按严重度排序的问题清单与可直接落地的修复建议。',
  },
  {
    recipe_id: 'perf-bottleneck',
    title: '性能瓶颈与并发诊断',
    role: 'researcher',
    tags: 'performance, latency, profiling',
    prompt: '分析当前项目的热路径、同步阻塞 I/O、锁竞争、SQLite/查询索引与内存占用风险。输出可量化验证的 Top 5 优化点（包含预期收益与实施复杂度）。',
  },
  {
    recipe_id: 'test-coverage-gap',
    title: '核心路径测试覆盖补全',
    role: 'tester',
    tags: 'testing, regression, edge-cases',
    prompt: '识别当前项目最关键但缺乏自动化测试覆盖的失败分支与并发边界，设计并补充高信噪比单元测试与对抗回归用例，验证全部测试通过。',
  },
  {
    recipe_id: 'arch-refactor-plan',
    title: '架构演进与极简重构提案',
    role: 'planner',
    tags: 'architecture, design, first-principles',
    prompt: '运用第一性原理评估当前架构：找出重复模块、隐式耦合与脆弱状态机，提出一套增量可回退的演进方案，附带明确的分阶段里程碑与验收标准。',
  },
  {
    recipe_id: 'cn-tech-doc',
    title: '中文实战文档与排障手册生成',
    role: 'synthesizer',
    tags: 'docs, runbook, chinese',
    prompt: '基于当前项目源码与实测配置，整理一份清晰简洁的中文工程文档：包含架构图、核心接口、日常命令速查、常见故障定位与回退步骤（全部内容须以真实代码为依据）。',
  },
];

export function ensureRecipesTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS recipes (
      recipe_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'researcher',
      tags TEXT NOT NULL DEFAULT '',
      prompt TEXT NOT NULL,
      builtin INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    );
  `);
  const now = new Date().toISOString();
  const ins = db.prepare(`
    INSERT OR IGNORE INTO recipes (recipe_id, title, role, tags, prompt, builtin, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `);
  for (const r of BUILTIN_RECIPES) {
    ins.run(r.recipe_id, r.title, r.role, r.tags, r.prompt, now);
  }
}

export function listRecipes(db) {
  ensureRecipesTable(db);
  return db.prepare('SELECT * FROM recipes ORDER BY builtin DESC, updated_at DESC').all().map((r) => ({
    ...r,
    builtin: Boolean(r.builtin),
  }));
}

export function saveRecipe(db, { recipeId, title, role = 'researcher', tags = '', prompt }) {
  ensureRecipesTable(db);
  const safeId = String(recipeId || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!safeId) throw new Error('recipe_id is required (lowercase letters, digits, - or _)');
  if (!title || !String(title).trim()) throw new Error('title is required');
  if (!prompt || !String(prompt).trim()) throw new Error('prompt is required');
  const existing = db.prepare('SELECT builtin FROM recipes WHERE recipe_id = ?').get(safeId);
  const tagStr = Array.isArray(tags) ? tags.join(', ') : String(tags || '');
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO recipes (recipe_id, title, role, tags, prompt, builtin, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(recipe_id) DO UPDATE SET
      title = excluded.title,
      role = excluded.role,
      tags = excluded.tags,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at
  `).run(safeId, String(title).trim(), role, tagStr, String(prompt).trim(), existing?.builtin ?? 0, now);
  logEvent(db, { eventType: 'recipe.saved', actor: 'coordinator', payload: { recipe_id: safeId, title } });
  const saved = db.prepare('SELECT * FROM recipes WHERE recipe_id = ?').get(safeId);
  return { ...saved, builtin: Boolean(saved.builtin) };
}

export function deleteRecipe(db, recipeId) {
  ensureRecipesTable(db);
  const row = db.prepare('SELECT * FROM recipes WHERE recipe_id = ?').get(recipeId);
  if (!row) throw new Error(`Recipe not found: ${recipeId}`);
  if (row.builtin) throw new Error(`Cannot delete built-in recipe "${recipeId}" (you may update its prompt instead).`);
  db.prepare('DELETE FROM recipes WHERE recipe_id = ?').run(recipeId);
  logEvent(db, { eventType: 'recipe.deleted', actor: 'coordinator', payload: { recipe_id: recipeId } });
  return { recipe_id: recipeId, deleted: true };
}
