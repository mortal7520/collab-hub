import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { listAgents } from './registry.mjs';

const execFileAsync = promisify(execFile);

const KNOWN_LOCAL_ENDPOINTS = [
  { id_prefix: 'ollama', label: 'Ollama (本地)', base_url: 'http://127.0.0.1:11434/v1', models_url: 'http://127.0.0.1:11434/v1/models' },
  { id_prefix: 'lmstudio', label: 'LM Studio (本地)', base_url: 'http://127.0.0.1:1234/v1', models_url: 'http://127.0.0.1:1234/v1/models' },
  { id_prefix: 'vllm', label: 'vLLM / LocalAI (本地)', base_url: 'http://127.0.0.1:8000/v1', models_url: 'http://127.0.0.1:8000/v1/models' },
];

const KNOWN_CLI_CANDIDATES = [
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    binaries: ['gemini.exe', 'gemini'],
    roles: ['researcher', 'reviewer', 'synthesizer'],
    config_template: (cmd) => ({ command: cmd, args: ['-p', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 120 }),
  },
  {
    id: 'aider-cli',
    name: 'Aider CLI',
    binaries: ['aider.exe', 'aider'],
    roles: ['implementer', 'reviewer'],
    config_template: (cmd) => ({ command: cmd, args: ['--yes', '--message', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 180 }),
  },
  {
    id: 'opencode-cli',
    name: 'OpenCode CLI',
    binaries: ['opencode.exe', 'opencode'],
    roles: ['implementer', 'researcher', 'reviewer'],
    config_template: (cmd) => ({ command: cmd, args: ['run', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 180 }),
  },
  {
    id: 'qwen-cli',
    name: 'Qwen Code CLI',
    binaries: ['qwen.exe', 'qwen'],
    roles: ['researcher', 'implementer', 'reviewer'],
    config_template: (cmd) => ({ command: cmd, args: ['-p', '{{prompt}}'], prompt_mode: 'arg', timeout_s: 120 }),
  },
];

// Read-only boolean presence check ONLY — never reads or returns secret values!
const KNOWN_CLOUD_ENV_PROVIDERS = [
  { id: 'deepseek-r1', name: 'DeepSeek Reasoner', env_var: 'DEEPSEEK_API_KEY', base_url: 'https://api.deepseek.com/v1', model: 'deepseek-reasoner', roles: ['planner', 'reviewer', 'synthesizer'] },
  { id: 'openrouter-auto', name: 'OpenRouter', env_var: 'OPENROUTER_API_KEY', base_url: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4', roles: ['researcher', 'reviewer', 'synthesizer'] },
  { id: 'openai-api', name: 'OpenAI API', env_var: 'OPENAI_API_KEY', base_url: 'https://api.openai.com/v1', model: 'gpt-4.1', roles: ['planner', 'reviewer', 'synthesizer'] },
  { id: 'siliconflow-api', name: 'SiliconFlow', env_var: 'SILICONFLOW_API_KEY', base_url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-Coder-32B-Instruct', roles: ['researcher', 'reviewer'] },
];

async function probeLocalEndpoint(ep) {
  try {
    const res = await fetch(ep.models_url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return { ...ep, reachable: false, models: [] };
    const data = await res.json().catch(() => ({}));
    const models = (Array.isArray(data?.data) ? data.data : [])
      .map((m) => m.id || m.name)
      .filter((s) => typeof s === 'string' && s.trim())
      .slice(0, 12);
    return { ...ep, reachable: true, models };
  } catch {
    return { ...ep, reachable: false, models: [] };
  }
}

async function locateBinary(binName) {
  try {
    const cmd = process.platform === 'win32' ? 'where.exe' : 'which';
    const { stdout } = await execFileAsync(cmd, [binName], {
      encoding: 'utf8',
      timeout: 2500,
      windowsHide: true,
    });
    const first = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !/\.(cmd|bat)$/i.test(l));
    if (first) return { path: first, is_shim: false };
    const anyLine = stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    return anyLine ? { path: anyLine, is_shim: /\.(cmd|bat)$/i.test(anyLine) } : null;
  } catch {
    return null;
  }
}

function slugId(prefix, modelName) {
  const clean = String(modelName || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);
  return `${prefix}-${clean || 'local'}`.slice(0, 32);
}

/**
 * Safely discover locally available OpenAI-compatible model servers (Ollama/LM Studio/vLLM),
 * installed external Agent CLIs on PATH, and boolean API-key env readiness (NEVER exposes secrets).
 */
export async function discoverLocalAgents(db, deps = {}) {
  const registeredIds = new Set(listAgents(db, { includeDisabled: true }).map((a) => a.id));
  const endpointProbe = deps.probeLocalEndpoint || probeLocalEndpoint;
  const binLocator = deps.locateBinary || locateBinary;
  const envObj = deps.env || process.env;

  const [endpoints, cliMatches] = await Promise.all([
    Promise.all(KNOWN_LOCAL_ENDPOINTS.map((ep) => endpointProbe(ep))),
    Promise.all(KNOWN_CLI_CANDIDATES.map(async (c) => {
      for (const b of c.binaries) {
        const found = await binLocator(b);
        if (found) {
          return {
            ...c,
            found: true,
            path: found.path,
            is_shim: found.is_shim,
            already_registered: registeredIds.has(c.id),
            suggested_registration: {
              agent_id: c.id,
              name: c.name,
              driver: 'generic-cli',
              roles: c.roles,
              config: c.config_template(found.path),
            },
          };
        }
      }
      return { id: c.id, name: c.name, found: false, path: null, already_registered: registeredIds.has(c.id) };
    })),
  ]);

  const local_models = [];
  for (const ep of endpoints) {
    if (!ep.reachable) continue;
    for (const model of ep.models) {
      const id = slugId(ep.id_prefix, model);
      local_models.push({
        endpoint: ep.label,
        base_url: ep.base_url,
        model,
        already_registered: registeredIds.has(id),
        suggested_registration: {
          agent_id: id,
          name: `${ep.label.split(' ')[0]} ${model}`,
          driver: 'openai-http',
          roles: ['researcher', 'reviewer', 'synthesizer'],
          config: { base_url: ep.base_url, model, api_key_env: '' },
        },
      });
    }
  }

  const cloud_env_ready = KNOWN_CLOUD_ENV_PROVIDERS.map((p) => ({
    id: p.id,
    name: p.name,
    env_var: p.env_var,
    env_present: Boolean(envObj[p.env_var] && String(envObj[p.env_var]).trim()),
    already_registered: registeredIds.has(p.id),
    suggested_registration: {
      agent_id: p.id,
      name: p.name,
      driver: 'openai-http',
      roles: p.roles,
      config: { base_url: p.base_url, model: p.model, api_key_env: p.env_var },
    },
  }));

  return {
    scanned_at: new Date().toISOString(),
    local_endpoints: endpoints.map(({ id_prefix, label, base_url, reachable, models }) => ({ id_prefix, label, base_url, reachable, model_count: models.length })),
    local_models,
    cli_agents: cliMatches,
    cloud_env_ready,
  };
}
