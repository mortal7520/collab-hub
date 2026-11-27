import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    return pkg.version || '1.1.0';
  } catch {
    return '1.1.0';
  }
})();

function loadLocalBootstrap() {
  const localFile = path.join(REPO_ROOT, '.collab-hub.local.json');
  try {
    if (fs.existsSync(localFile)) {
      const parsed = JSON.parse(fs.readFileSync(localFile, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch { /* ignore invalid optional local override */ }
  return {};
}

function normalizeCrossOsPath(p) {
  if (!p || typeof p !== 'string') return p;
  if (process.platform !== 'win32') {
    const m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
    if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replaceAll('\\', '/')}`;
  }
  return p;
}

const LOCAL_BOOT = loadLocalBootstrap();

export const APP_ROOT = normalizeCrossOsPath(process.env.COLLAB_HUB_APP_ROOT || LOCAL_BOOT.appRoot) || path.join(os.homedir(), '.collab-hub');
export const WORKSPACE_ROOT = normalizeCrossOsPath(process.env.COLLAB_HUB_WORKSPACE_ROOT || LOCAL_BOOT.workspaceRoot) || process.cwd();
export const DATA_DIR = path.join(APP_ROOT, 'data');
export const DB_PATH = normalizeCrossOsPath(process.env.COLLAB_HUB_DB_PATH) || path.join(DATA_DIR, 'hub.db');
export const MEMORY_DIR = normalizeCrossOsPath(process.env.COLLAB_HUB_MEMORY_DIR) || path.join(DATA_DIR, 'memory');
export const WORKTREE_DIR = normalizeCrossOsPath(process.env.COLLAB_HUB_WORKTREE_DIR) || path.join(APP_ROOT, 'worktrees');
export const LOG_DIR = path.join(APP_ROOT, 'logs');
export const PAYLOAD_DIR = path.join(DATA_DIR, 'muse-payloads');
export const POLICY_PATH = normalizeCrossOsPath(process.env.COLLAB_HUB_POLICY_PATH) || path.join(DATA_DIR, 'hub-policy.json');
export const INTEGRATIONS_PATH = normalizeCrossOsPath(process.env.COLLAB_HUB_INTEGRATIONS_PATH) || path.join(DATA_DIR, 'integrations.json');

export const DASHBOARD_HOST = '127.0.0.1';
export const DASHBOARD_PORT = Number(process.env.COLLAB_HUB_PORT || 5290);
export const MAIL_HOST = '127.0.0.1';
export const MAIL_PORT = Number(process.env.COLLAB_HUB_MAIL_PORT || 5291);
export const MAIL_BASE_URL = `http://${MAIL_HOST}:${MAIL_PORT}`;

export const DESKTOP_FRESHNESS_TTL_MS = Number(process.env.COLLAB_HUB_DESKTOP_TTL_MS || 15 * 60 * 1000);
export const MAX_PROMPT_BYTES = 256 * 1024;

function loadIntegrationsFile() {
  try {
    if (fs.existsSync(INTEGRATIONS_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(INTEGRATIONS_PATH, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
  } catch { /* fallback to portable defaults */ }
  return {};
}

const LOCAL_INT = loadIntegrationsFile();

/**
 * Optional local adapter bindings loaded from `<APP_ROOT>/data/integrations.json` or env vars.
 * Keeps source code 100% portable across Windows, macOS, and Linux with zero hardcoded machine secrets.
 */
export const INTEGRATIONS = Object.freeze({
  nodeExe: process.execPath || 'node',
  batonLauncher: process.env.COLLAB_HUB_BATON_LAUNCHER || LOCAL_INT.batonLauncher || '',
  wslDistro: process.env.COLLAB_HUB_WSL_DISTRO || LOCAL_INT.wslDistro || '',
  wslUser: process.env.COLLAB_HUB_WSL_USER || LOCAL_INT.wslUser || '',
  dshService: process.env.COLLAB_HUB_DSH_SERVICE || LOCAL_INT.dshService || 'dsh-web.service',
  dshSocket: process.env.COLLAB_HUB_DSH_SOCKET || LOCAL_INT.dshSocket || '',
  museOperatorClient: process.env.COLLAB_HUB_MUSE_CLIENT || LOCAL_INT.museOperatorClient || '',
  musePublisherSocket: process.env.COLLAB_HUB_MUSE_SOCKET || LOCAL_INT.musePublisherSocket || '',
  museRelayIp: process.env.COLLAB_HUB_MUSE_RELAY_IP || LOCAL_INT.museRelayIp || '',
  musePeerIp: process.env.COLLAB_HUB_MUSE_PEER_IP || LOCAL_INT.musePeerIp || '',
  tailscaleExe: process.env.COLLAB_HUB_TAILSCALE_EXE || LOCAL_INT.tailscaleExe || 'tailscale',
  claudeWorkerClient: process.env.COLLAB_HUB_CLAUDE_WORKER_CLIENT || LOCAL_INT.claudeWorkerClient || '',
  claudeWorkerRelayDir: process.env.COLLAB_HUB_CLAUDE_RELAY_DIR || LOCAL_INT.claudeWorkerRelayDir || '',
  claudeCooldownSeconds: Number(process.env.COLLAB_HUB_CLAUDE_COOLDOWN_S || LOCAL_INT.claudeCooldownSeconds || 1800),
});

const EXE = process.platform === 'win32' ? '.exe' : '';
const VENV_BIN = process.platform === 'win32' ? 'Scripts' : 'bin';

export const TOOLKIT_PATHS = Object.freeze({
  cassExe: path.join(APP_ROOT, 'bin', `cass${EXE}`),
  cassDataDir: path.join(DATA_DIR, 'cass'),
  astGrepExe: fs.existsSync(path.join(APP_ROOT, 'bin', `ast-grep${EXE}`))
    ? path.join(APP_ROOT, 'bin', `ast-grep${EXE}`)
    : path.join(APP_ROOT, 'bin', `sg${EXE}`),
  beadsExe: path.join(APP_ROOT, 'bin', `bd${EXE}`),
  repomixCjs: path.join(APP_ROOT, 'tools', 'repomix', 'node_modules', 'repomix', 'bin', 'repomix.cjs'),
  markitdownExe: path.join(APP_ROOT, 'tools', 'markitdown-venv', VENV_BIN, `markitdown${EXE}`),
  provenanceJson: path.join(APP_ROOT, 'bin', 'provenance.json'),
});

export const MEMBERS = Object.freeze({
  codex: {
    id: 'codex',
    name: 'Codex',
    driver: 'desktop-native',
    defaultChannel: 'desktop-native',
    roles: ['planner', 'researcher', 'implementer', 'tester', 'reviewer', 'synthesizer'],
    capabilities: ['local_fs', 'coding', 'testing', 'review', 'planning', 'synthesis', 'desktop_native'],
  },
  agy: {
    id: 'agy',
    name: 'AGY (Antigravity)',
    driver: 'desktop-native',
    defaultChannel: 'desktop-native',
    roles: ['planner', 'researcher', 'implementer', 'tester', 'reviewer', 'synthesizer'],
    capabilities: ['local_fs', 'coding', 'testing', 'review', 'planning', 'synthesis', 'desktop_native', 'browser'],
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    driver: 'claude-dual',
    defaultChannel: 'dual-mode',
    roles: ['planner', 'researcher', 'implementer', 'reviewer', 'synthesizer'],
    capabilities: ['local_fs', 'coding', 'review', 'planning', 'research', 'synthesis', 'desktop_native', 'background_cli'],
  },
  dsh: {
    id: 'dsh',
    name: 'WSL DSH',
    driver: 'dsh-baton',
    defaultChannel: 'dsh-baton',
    roles: ['planner', 'researcher', 'implementer', 'tester', 'reviewer', 'synthesizer'],
    capabilities: ['local_linux', 'coding', 'testing', 'review', 'planning', 'research', 'synthesis', 'background_auto'],
  },
  muse: {
    id: 'muse',
    name: 'Muse (Cloud)',
    driver: 'muse-tailnet',
    defaultChannel: 'muse-tailnet',
    roles: ['planner', 'researcher', 'reviewer', 'synthesizer'],
    capabilities: ['research', 'review', 'planning', 'synthesis', 'background_auto', 'remote_cloud'],
  },
});

export const DEFAULT_MEMBER_SEEDS = MEMBERS;

export const VALID_ROLES = new Set(['planner', 'researcher', 'implementer', 'tester', 'reviewer', 'synthesizer']);
export const VALID_MEMBERS = new Set(Object.keys(MEMBERS));
export const NATIVE_MEMBERS = new Set(['codex', 'agy', 'claude']);
export const BACKGROUND_MEMBERS = new Set(['dsh', 'muse', 'claude']);
export const VALID_DRIVERS = new Set(['desktop-native', 'claude-dual', 'dsh-baton', 'muse-tailnet', 'generic-cli', 'openai-http']);

export const AGENT_ID_RE = /^[a-z0-9][a-z0-9_-]{1,31}$/;
export const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
export const SAFE_GIT_REF_RE = /^(?!-)(?!.*\.\.)(?!.*[\0\r\n\s~^:?*\[\\])[A-Za-z0-9._\/-]{1,128}$/;

export function assertValidAgentId(value) {
  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) {
    throw new Error(`Invalid agent_id "${value}": use 2-32 lowercase letters, digits, '-' or '_'.`);
  }
  return value;
}

export function assertValidTaskId(value, label = 'task_id') {
  if (typeof value !== 'string' || !TASK_ID_RE.test(value)) {
    throw new Error(`Invalid ${label}: must match ${TASK_ID_RE} (no slashes, dots, or traversal).`);
  }
  return value;
}

export function assertValidMember(value, allowed = VALID_MEMBERS) {
  if (typeof value !== 'string' || !allowed.has(value)) {
    throw new Error(`Invalid member "${value}". Allowed: ${[...allowed].join(', ')}`);
  }
  return value;
}

export function assertValidGitRef(value) {
  if (typeof value !== 'string' || !SAFE_GIT_REF_RE.test(value) || value.endsWith('/') || value.endsWith('.lock')) {
    throw new Error(`Unsafe or invalid git ref: ${value}`);
  }
  return value;
}

export function defaultPolicy() {
  return {
    schemaVersion: 1,
    allowedWorkspaceRoot: WORKSPACE_ROOT,
    allowedWorktreeRoot: WORKTREE_DIR,
    claudeCliAllowedRoots: [WORKSPACE_ROOT, WORKTREE_DIR],
    claudeCooldownSeconds: INTEGRATIONS.claudeCooldownSeconds,
  };
}

export function ensureRuntimeDirs() {
  for (const dir of [APP_ROOT, DATA_DIR, MEMORY_DIR, WORKTREE_DIR, LOG_DIR, PAYLOAD_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(POLICY_PATH)) {
    try {
      fs.writeFileSync(POLICY_PATH, JSON.stringify(defaultPolicy(), null, 2) + '\n', { flag: 'wx', encoding: 'utf8' });
    } catch (err) {
      if (err.code !== 'EEXIST') console.error(`[collab-hub] failed writing default policy: ${err.message}`);
    }
  }
}

export function loadPolicy(policyPath = POLICY_PATH) {
  const defaults = defaultPolicy();
  try {
    if (fs.existsSync(policyPath)) {
      const parsed = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return { ...defaults, ...parsed };
      }
      console.error(`[collab-hub] invalid policy object in ${policyPath}; using defaults`);
    }
  } catch (err) {
    console.error(`[collab-hub] failed to parse ${policyPath}: ${err.message}; using defaults`);
  }
  return defaults;
}

function isInsideRoot(rootNorm, targetNorm) {
  const rel = path.relative(rootNorm, targetNorm);
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Cross-platform (Windows / macOS / Linux) project & isolated worktree directory resolver.
 * Strictly jails targets inside allowed roots (resolving symlinks via realpathSync) and
 * rejects root-level paths when requireSubdir=true.
 */
export function resolveProjectDir(input, {
  requireSubdir = false,
  workspaceRoot = null,
  extraRoots = null,
} = {}) {
  if (typeof input !== 'string' || !input.trim() || /[\0\r\n]/.test(input)) {
    throw new Error('Project directory must be a non-empty path inside allowed roots.');
  }
  const policy = loadPolicy();
  const trimSep = (p) => {
    const norm = path.resolve(p);
    return norm.length > 3 ? norm.replace(/[\\/]+$/, '') : norm;
  };
  const nativeReal = (p) => {
    try { return trimSep((fs.realpathSync.native || fs.realpathSync)(p)); } catch { return trimSep(p); }
  };
  const primaryRoot = trimSep(workspaceRoot || policy.allowedWorkspaceRoot || WORKSPACE_ROOT);
  const rawRoots = [
    primaryRoot,
    ...((extraRoots ?? [policy.allowedWorktreeRoot || WORKTREE_DIR]).filter(Boolean).map(trimSep)),
  ];
  const roots = [...new Set([...rawRoots, ...rawRoots.map(nativeReal)])];

  let raw = input.trim();
  if (process.platform === 'win32') {
    if (/^\/mnt\/[a-z]\//i.test(raw)) {
      raw = raw[5].toUpperCase() + ':\\' + raw.slice(7).replaceAll('/', '\\');
    }
    if (!/^[a-zA-Z]:[\\/]/.test(raw) || /[:*?"<>|]/.test(raw.slice(2))) {
      throw new Error(`Invalid Windows project path: ${input}`);
    }
  } else if (!path.isAbsolute(raw)) {
    throw new Error(`Project path must be absolute: ${input}`);
  }

  const normalized = trimSep(raw);
  if (process.platform === 'win32') {
    const parts = normalized.slice(3).split('\\').filter(Boolean);
    if (parts.some((p) => /[. ]$/.test(p))) {
      throw new Error(`Ambiguous Windows path component in ${normalized}`);
    }
  }

  const matchedRoot = roots.find((r) => isInsideRoot(r, normalized));
  if (!matchedRoot) {
    throw new Error(`Project path must remain inside allowed roots (${roots.join(', ')}): got ${normalized}`);
  }
  if (requireSubdir) {
    const rel = path.relative(matchedRoot, normalized);
    if (!rel || rel === '.') {
      throw new Error(`Must specify a concrete project subdirectory under ${matchedRoot}, not the root directory.`);
    }
  }
  if (!fs.existsSync(normalized) || !fs.statSync(normalized).isDirectory()) {
    throw new Error(`Project directory does not exist: ${normalized}`);
  }

  const canonical = nativeReal(normalized);
  const canonicalRoots = [...new Set(rawRoots.filter((r) => fs.existsSync(r)).map((r) => nativeReal(r)))];
  const canonicalMatch = canonicalRoots.find((r) => isInsideRoot(r, canonical));
  if (!canonicalMatch) {
    throw new Error(`Resolved symlink escapes allowed roots (${canonicalRoots.join(', ')}): ${canonical}`);
  }
  if (requireSubdir) {
    const cRel = path.relative(canonicalMatch, canonical);
    if (!cRel || cRel === '.') {
      throw new Error(`Resolved path must be a concrete subdirectory under ${canonicalMatch}.`);
    }
  }

  return {
    windows: canonical,
    path: canonical,
    wsl: /^[a-zA-Z]:\\/.test(canonical) ? toWslPath(canonical) : canonical,
    matched_root: canonicalMatch,
  };
}

export function toWslPath(winPath) {
  const norm = path.win32.normalize(winPath);
  const match = /^([a-zA-Z]):\\(.*)$/.exec(norm);
  if (!match) return winPath;
  return `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll('\\', '/')}`;
}
