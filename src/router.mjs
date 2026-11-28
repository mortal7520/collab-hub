/**
 * CollabHub v3.0 — Capability & Model-Strength Intelligent Task Router (Zero Dependencies)
 *
 * Adapts proven open-source LLM routing concepts:
 * - lm-sys/RouteLLM: complexity & preference-aware stratification (avoid overpaying or
 *   under-powering flagship vs fast/local tasks).
 * - BerriAI/litellm Router: capability profiles merged with live cooldown, error-rate,
 *   latency, and budget guardrails.
 *
 * Strictly deterministic & explainable — always emits transparent `routing_reasons[]`.
 */

export const TASK_CATEGORIES = Object.freeze([
  'coding',
  'security_audit',
  'architecture',
  'frontend_ui',
  'copywriting',
  'long_context',
  'linux_ops',
  'debugging',
  'research',
  'fast_cheap',
]);

export const ROUTING_STRATEGIES = new Set(['balanced', 'quality', 'cost', 'speed']);

const ROLE_TO_CATEGORY = Object.freeze({
  implementer: 'coding',
  reviewer: 'security_audit',
  planner: 'architecture',
  tester: 'debugging',
  researcher: 'research',
  synthesizer: 'copywriting',
  coordinator: 'architecture',
});

const CATEGORY_SIGNALS = [
  { category: 'security_audit', re: /\b(security|audit|ssrf|csrf|xss|sqli|authz?|oauth|hmac|cve|vulnerab|penetration|threat|secret|red[- ]?team)\b|安全|审计|漏洞|权限|越权|红队/i },
  { category: 'copywriting', re: /\b(readme|copywriting|launch|announcement|marketing|positioning|blog|tweet|post|docs|release[- ]?notes|showcase)\b|文案|推广|宣发|文档|双语|简介|卖点|博客/i },
  { category: 'frontend_ui', re: /\b(ui|ux|css|html|svg|canvas|dashboard|cockpit|layout|responsive|accessibility|a11y|dark[- ]?mode|animation|webview)\b|界面|前端|交互|样式|视图|排版|常驻|动效/i },
  { category: 'linux_ops', re: /\b(linux|wsl|ubuntu|debian|docker|systemd|bash|posix|nginx|container|ci|github[- ]?actions|makefile)\b|部署|容器|脚本/i },
  { category: 'architecture', re: /\b(architecture|design|rfc|schema|migration|protocol|refactor|roadmap|plan|system[- ]?design|tradeoff)\b|架构|规划|方案|协议|重构|迁移/i },
  { category: 'long_context', re: /\b(whole[- ]?repo|monorepo|entire[- ]?codebase|multi[- ]?file|100k|200k|1m|book|full[- ]?transcript)\b|全库|全局|长上下文|跨文件|全文/i },
  { category: 'debugging', re: /\b(bug|fix|crash|trace|stack|flaky|regression|failing[- ]?test|unit[- ]?test|diagnose|debug)\b|修复|报错|调试|排障|单测|回归|异常/i },
  { category: 'coding', re: /\b(implement|build|feature|endpoint|api|module|class|function|cli|sdk|typescript|javascript|python|rust)\b|开发|实现|编写|接口|功能|代码/i },
  { category: 'fast_cheap', re: /\b(quick|simple|typo|format|lint|rename|short|trivial|summarize[- ]?log|local[- ]?model)\b|简单|快速|错别字|格式化|摘要|本地模型/i },
  { category: 'research', re: /\b(research|compare|survey|explore|benchmark|find|lookup|inventory|summarize)\b|调研|对比|检索|整理|汇总|探索/i },
];

const MODEL_FAMILY_PRESETS = [
  {
    match: /haiku/i,
    family: 'claude-fast',
    tier: 'fast',
    cost_tier: 'low',
    strengths: { coding: 78, security_audit: 70, architecture: 72, frontend_ui: 78, copywriting: 82, long_context: 74, linux_ops: 74, debugging: 76, research: 84, fast_cheap: 96 },
  },
  {
    match: /flash|mini|nano|instant/i,
    family: 'fast-mini',
    tier: 'fast',
    cost_tier: 'low',
    strengths: { coding: 74, security_audit: 65, architecture: 68, frontend_ui: 75, copywriting: 76, long_context: 80, linux_ops: 72, debugging: 74, research: 82, fast_cheap: 97 },
  },
  {
    match: /ollama|lmstudio|vllm|qwen|llama|mistral|gemma|local/i,
    family: 'local-open-weights',
    tier: 'local',
    cost_tier: 'free',
    strengths: { coding: 76, security_audit: 68, architecture: 70, frontend_ui: 72, copywriting: 68, long_context: 64, linux_ops: 74, debugging: 74, research: 78, fast_cheap: 99 },
  },
  {
    match: /deepseek.*r1|reasoner/i,
    family: 'deepseek-reasoner',
    tier: 'balanced',
    cost_tier: 'low',
    strengths: { coding: 89, security_audit: 88, architecture: 91, frontend_ui: 78, copywriting: 74, long_context: 82, linux_ops: 84, debugging: 91, research: 86, fast_cheap: 90 },
  },
  {
    match: /opus|claude[-_ ]?4|sonnet/i,
    family: 'claude-flagship',
    tier: 'flagship',
    cost_tier: 'high',
    strengths: { coding: 94, security_audit: 90, architecture: 96, frontend_ui: 95, copywriting: 94, long_context: 92, linux_ops: 86, debugging: 91, research: 92, fast_cheap: 58 },
  },
  {
    match: /codex|gpt-?5|o3\b|o4\b/i,
    family: 'openai-codex-flagship',
    tier: 'flagship',
    cost_tier: 'high',
    strengths: { coding: 97, security_audit: 96, architecture: 93, frontend_ui: 86, copywriting: 80, long_context: 88, linux_ops: 90, debugging: 96, research: 88, fast_cheap: 55 },
  },
  {
    match: /gemini.*(pro|3|2\.5)|antigravity|\bagy\b/i,
    family: 'gemini-agy-flagship',
    tier: 'flagship',
    cost_tier: 'medium',
    strengths: { coding: 91, security_audit: 88, architecture: 93, frontend_ui: 94, copywriting: 96, long_context: 98, linux_ops: 86, debugging: 89, research: 95, fast_cheap: 72 },
  },
];

const BUILTIN_DEFAULTS = {
  codex: { family: 'openai-codex-flagship', tier: 'flagship', cost_tier: 'high', strengths: { coding: 97, security_audit: 96, architecture: 93, frontend_ui: 86, copywriting: 80, long_context: 88, linux_ops: 90, debugging: 96, research: 88, fast_cheap: 55 } },
  claude: { family: 'claude-flagship', tier: 'flagship', cost_tier: 'high', strengths: { coding: 94, security_audit: 90, architecture: 96, frontend_ui: 95, copywriting: 94, long_context: 92, linux_ops: 86, debugging: 91, research: 92, fast_cheap: 58 } },
  agy: { family: 'gemini-agy-flagship', tier: 'flagship', cost_tier: 'medium', strengths: { coding: 91, security_audit: 88, architecture: 93, frontend_ui: 94, copywriting: 96, long_context: 98, linux_ops: 86, debugging: 89, research: 95, fast_cheap: 72 } },
  dsh: { family: 'wsl-dsh-runtime', tier: 'balanced', cost_tier: 'medium', strengths: { coding: 90, security_audit: 87, architecture: 84, frontend_ui: 76, copywriting: 70, long_context: 84, linux_ops: 99, debugging: 92, research: 84, fast_cheap: 76 } },
  muse: { family: 'cloud-muse-research', tier: 'fast', cost_tier: 'low', strengths: { coding: 45, security_audit: 52, architecture: 64, frontend_ui: 50, copywriting: 60, long_context: 75, linux_ops: 40, debugging: 50, research: 86, fast_cheap: 82 } },
};

export function classifyTaskIntent({
  prompt = '',
  title = '',
  role = 'researcher',
  taskCategory = null,
  complexity = null,
} = {}) {
  const combined = `${title || ''} ${prompt || ''}`.trim();
  const signals = [];

  let category = TASK_CATEGORIES.includes(taskCategory) ? taskCategory : null;
  if (!category && combined) {
    for (const rule of CATEGORY_SIGNALS) {
      if (rule.re.test(combined)) {
        category = rule.category;
        signals.push(`matched:${rule.category}`);
        break;
      }
    }
  }
  if (!category) {
    category = ROLE_TO_CATEGORY[role] || 'research';
    signals.push(`role_default:${role}->${category}`);
  }

  let level = ['low', 'medium', 'high'].includes(complexity) ? complexity : null;
  if (!level) {
    if (
      combined.length > 600
      || /architecture|security|audit|refactor|migrate|multi-agent|orchestrate|release|v3|旗舰|架构|审计|全面/i.test(combined)
      || ['security_audit', 'architecture', 'long_context'].includes(category)
    ) {
      level = 'high';
    } else if (
      (combined.length > 0 && combined.length < 110 && /quick|simple|typo|lint|status|summarize|ping|简单|快速/i.test(combined))
      || category === 'fast_cheap'
    ) {
      level = 'low';
    } else {
      level = 'medium';
    }
  }

  return { category, complexity: level, signals };
}

export function getAgentCapabilityProfile(member, { modelHint = null } = {}) {
  const m = member || {};
  const id = String(m.member || m.agent_id || m.id || '').toLowerCase();
  const cfg = (m.config && typeof m.config === 'object') ? m.config : {};
  const modelText = [modelHint, cfg.model, m.name, id].filter(Boolean).join(' ');

  let base = {
    family: 'custom-agent',
    tier: 'balanced',
    cost_tier: 'medium',
    strengths: { coding: 78, security_audit: 72, architecture: 74, frontend_ui: 74, copywriting: 72, long_context: 72, linux_ops: 74, debugging: 76, research: 78, fast_cheap: 76 },
  };

  if (BUILTIN_DEFAULTS[id]) {
    base = BUILTIN_DEFAULTS[id];
  } else {
    const preset = MODEL_FAMILY_PRESETS.find((p) => p.match.test(modelText));
    if (preset) base = preset;
    else if (/cursor|windsurf|cline|roo|opencode|vscode|kiro/i.test(id)) {
      base = {
        family: 'ide-coding-agent',
        tier: 'balanced',
        cost_tier: 'medium',
        strengths: { coding: 91, security_audit: 82, architecture: 84, frontend_ui: 89, copywriting: 76, long_context: 82, linux_ops: 80, debugging: 88, research: 82, fast_cheap: 70 },
      };
    }
  }

  const mergedStrengths = { ...base.strengths };
  if (cfg.strengths && typeof cfg.strengths === 'object') {
    for (const k of TASK_CATEGORIES) {
      const v = Number(cfg.strengths[k]);
      if (Number.isFinite(v)) mergedStrengths[k] = Math.max(0, Math.min(100, Math.round(v)));
    }
  }

  const tier = ['flagship', 'balanced', 'fast', 'local'].includes(cfg.tier) ? cfg.tier : base.tier;
  const costTier = ['free', 'low', 'medium', 'high'].includes(cfg.cost_tier) ? cfg.cost_tier : base.cost_tier;

  const topStrengths = Object.entries(mergedStrengths)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => ({ category: k, score: v }));

  return {
    model_family: base.family,
    tier,
    cost_tier: costTier,
    strengths: mergedStrengths,
    top_strengths: topStrengths,
  };
}

export function scoreAgentForTask(member, {
  category = 'research',
  complexity = 'medium',
  strategy = 'balanced',
  modelHint = null,
} = {}) {
  const safeStrat = ROUTING_STRATEGIES.has(strategy) ? strategy : 'balanced';
  const profile = getAgentCapabilityProfile(member, { modelHint });
  const catScore = profile.strengths[category] ?? 70;
  const reasons = [`${category}=${catScore}/100 (${profile.model_family}, ${profile.tier})`];

  // Baseline capability contribution centered around 75 -> [-18..+22]
  let delta = Math.round((catScore - 75) * 0.85);

  if (complexity === 'high') {
    if (profile.tier === 'flagship') {
      delta += 8;
      reasons.push('flagship_boost_for_high_complexity(+8)');
    } else if (profile.tier === 'local' || profile.tier === 'fast') {
      delta -= 10;
      reasons.push(`${profile.tier}_downgraded_for_high_complexity(-10)`);
    }
  } else if (complexity === 'low') {
    if (profile.tier === 'local' || profile.tier === 'fast') {
      delta += 10;
      reasons.push(`${profile.tier}_efficiency_boost_for_low_complexity(+10)`);
    }
  }

  if (safeStrat === 'quality') {
    delta += Math.round((catScore - 70) * 0.45);
    if (profile.tier === 'flagship') delta += 6;
    reasons.push('strategy=quality');
  } else if (safeStrat === 'cost') {
    const costBonus = { free: 24, low: 14, medium: 0, high: -12 }[profile.cost_tier] ?? 0;
    delta += costBonus;
    reasons.push(`strategy=cost(${profile.cost_tier}:${costBonus >= 0 ? '+' : ''}${costBonus})`);
  } else if (safeStrat === 'speed') {
    const speedBonus = { fast: 16, local: 12, balanced: 4, flagship: -4 }[profile.tier] ?? 0;
    delta += speedBonus;
    reasons.push(`strategy=speed(${profile.tier}:${speedBonus >= 0 ? '+' : ''}${speedBonus})`);
  }

  delta = Math.max(-30, Math.min(60, delta));
  return {
    delta,
    capability_score: catScore,
    tier: profile.tier,
    cost_tier: profile.cost_tier,
    model_family: profile.model_family,
    top_strengths: profile.top_strengths,
    reasons,
  };
}

export function buildCapabilityMatrix(members = [], liveUsage = null) {
  const usageMap = new Map((liveUsage?.agents || []).map((a) => [String(a.agent_id).toLowerCase(), a]));
  return members.map((m) => {
    const id = String(m.member || m.agent_id || m.id || '').toLowerCase();
    const u = usageMap.get(id) || null;
    const prof = getAgentCapabilityProfile(m, { modelHint: u?.last_model || null });
    return {
      member: m.member || m.agent_id,
      name: m.name || m.member,
      state: m.state || 'unknown',
      driver: m.driver,
      model_hint: u?.last_model || m.config?.model || prof.model_family,
      ...prof,
    };
  });
}
