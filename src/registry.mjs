import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DEFAULT_MEMBER_SEEDS, VALID_DRIVERS, VALID_ROLES, assertValidAgentId,
} from './config.mjs';
import { logEvent } from './db.mjs';

const execFileAsync = promisify(execFile);

/**
 * Ensure the dynamic `agents` table exists and seed the 5 built-in members cleanly.
 * Users can register ANY additional agent (generic-cli, openai-http, desktop-native, etc.)
 * via MCP (`collab_agent_register`), CLI, or the :5290 Web Cockpit without editing code!
 */
export function ensureAgentsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      agent_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      driver TEXT NOT NULL,
      default_channel TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      capabilities_json TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      enabled INTEGER NOT NULL DEFAULT 1,
      builtin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const now = new Date().toISOString();
  const seedAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (agent_id, name, driver, default_channel, roles_json, capabilities_json, config_json, enabled, builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, '{}', 1, 1, ?, ?)
  `);
  const seedStatus = db.prepare(`
    INSERT OR IGNORE INTO member_status (member, channel, state, sessions_json, detail, checked_at)
    VALUES (?, ?, 'unknown', '[]', 'Not probed yet', ?)
  `);

  for (const m of Object.values(DEFAULT_MEMBER_SEEDS)) {
    seedAgent.run(
      m.id, m.name, m.driver, m.defaultChannel,
      JSON.stringify(m.roles), JSON.stringify(m.capabilities), now, now,
    );
    seedStatus.run(m.id, m.defaultChannel, now);
  }
}

function parseAgentRow(row) {
  if (!row) return null;
  let roles = [];
  let capabilities = [];
  let config = {};
  try { roles = JSON.parse(row.roles_json || '[]'); } catch {}
  try { capabilities = JSON.parse(row.capabilities_json || '[]'); } catch {}
  try { config = JSON.parse(row.config_json || '{}'); } catch {}
  return {
    id: row.agent_id,
    name: row.name,
    driver: row.driver,
    defaultChannel: row.default_channel,
    roles,
    capabilities,
    config,
    enabled: Boolean(row.enabled),
    builtin: Boolean(row.builtin),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listAgents(db, { includeDisabled = false } = {}) {
  const sql = includeDisabled
    ? 'SELECT * FROM agents ORDER BY builtin DESC, agent_id ASC'
    : 'SELECT * FROM agents WHERE enabled = 1 ORDER BY builtin DESC, agent_id ASC';
  return db.prepare(sql).all().map(parseAgentRow);
}

export function getAgent(db, agentId) {
  const safeId = assertValidAgentId(agentId);
  return parseAgentRow(db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(safeId));
}

function validateDriverConfig(driver, config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('config must be a JSON object');
  }
  if (driver === 'generic-cli') {
    if (typeof config.command !== 'string' || !config.command.trim()) {
      throw new Error('generic-cli driver requires config.command (executable name or absolute path)');
    }
    if (/[;&|`$<>]/.test(config.command)) {
      throw new Error('config.command must be an executable path/name without shell metacharacters');
    }
    if (config.args !== undefined && (!Array.isArray(config.args) || config.args.some((a) => typeof a !== 'string'))) {
      throw new Error('generic-cli config.args must be an array of strings (supports {{prompt}} and {{cwd}} placeholders)');
    }
    const envAllow = Array.isArray(config.env_allow)
      ? config.env_allow.filter((k) => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/^(NODE_OPTIONS|LD_PRELOAD|LD_LIBRARY_PATH)$/i.test(k))
      : [];
    return {
      command: config.command.trim(),
      args: config.args || [],
      prompt_mode: config.prompt_mode === 'stdin' ? 'stdin' : 'arg',
      timeout_s: Math.max(10, Math.min(600, Number(config.timeout_s) || 120)),
      env_allow: envAllow,
    };
  }
  if (driver === 'openai-http') {
    if (typeof config.base_url !== 'string' || !/^https?:\/\/.+/.test(config.base_url.trim())) {
      throw new Error('openai-http driver requires valid http(s) config.base_url');
    }
    let parsedUrl;
    try { parsedUrl = new URL(config.base_url.trim()); } catch {
      throw new Error('openai-http driver requires a parseable config.base_url');
    }
    const isLoopback = ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(parsedUrl.hostname.toLowerCase());
    if (parsedUrl.protocol !== 'https:' && !isLoopback) {
      throw new Error('Security rule: remote openai-http config.base_url must use https:// (plain http:// is allowed only for loopback hosts).');
    }
    if (typeof config.model !== 'string' || !config.model.trim()) {
      throw new Error('openai-http driver requires config.model');
    }
    if (config.api_key) {
      throw new Error('Security rule: never store plaintext api_key in hub.db! Pass config.api_key_env (an environment variable name) instead.');
    }
    const keyEnv = typeof config.api_key_env === 'string' && config.api_key_env.trim() ? config.api_key_env.trim() : null;
    if (keyEnv && !/^[A-Z][A-Z0-9_]*_(API_KEY|KEY|TOKEN)$/.test(keyEnv)) {
      throw new Error('Security rule: config.api_key_env must match *_API_KEY, *_KEY, or *_TOKEN to prevent arbitrary environment exfiltration.');
    }
    return {
      base_url: config.base_url.trim().replace(/\/+$/, ''),
      model: config.model.trim(),
      api_key_env: keyEnv,
      system_prompt: typeof config.system_prompt === 'string' ? config.system_prompt.slice(0, 4000) : '',
      max_tokens: Math.max(128, Math.min(32768, Number(config.max_tokens) || 4096)),
      timeout_s: Math.max(10, Math.min(300, Number(config.timeout_s) || 90)),
    };
  }
  return config;
}

export function registerAgent(db, {
  agentId, name, driver, roles = ['researcher', 'reviewer'], capabilities = [], config = {}, enabled = true,
}) {
  const safeId = assertValidAgentId(agentId);
  if (!name || !String(name).trim()) throw new Error('name is required');
  const existing = db.prepare('SELECT * FROM agents WHERE agent_id = ?').get(safeId);
  const customDrivers = new Set(['generic-cli', 'openai-http', 'desktop-native']);
  if (existing?.builtin) {
    if (driver && driver !== existing.driver) {
      throw new Error(`Cannot change driver of built-in agent "${safeId}" (remains "${existing.driver}")`);
    }
    driver = existing.driver;
  } else if (!customDrivers.has(driver)) {
    throw new Error(`Custom agents must use one of: ${[...customDrivers].join(', ')} (got "${driver}")`);
  }
  if (!VALID_DRIVERS.has(driver)) {
    throw new Error(`Unsupported driver "${driver}". Allowed: ${[...VALID_DRIVERS].join(', ')}`);
  }
  const cleanRoles = (Array.isArray(roles) ? roles : []).filter((r) => VALID_ROLES.has(r));
  if (cleanRoles.length === 0) throw new Error('At least one valid role is required');
  const cleanCaps = [...new Set([
    ...(Array.isArray(capabilities) ? capabilities.map((c) => String(c).trim()).filter(Boolean) : []),
    driver === 'generic-cli' ? 'background_auto' : null,
    driver === 'openai-http' ? 'background_auto' : null,
    driver === 'desktop-native' ? 'desktop_native' : null,
  ].filter(Boolean))];

  const cleanConfig = validateDriverConfig(driver, config);
  const now = new Date().toISOString();
  const defaultChannel = existing?.builtin ? existing.default_channel : driver;

  db.prepare(`
    INSERT INTO agents (agent_id, name, driver, default_channel, roles_json, capabilities_json, config_json, enabled, builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(agent_id) DO UPDATE SET
      name = excluded.name,
      driver = excluded.driver,
      default_channel = excluded.default_channel,
      roles_json = excluded.roles_json,
      capabilities_json = excluded.capabilities_json,
      config_json = excluded.config_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(
    safeId, String(name).trim(), driver, defaultChannel,
    JSON.stringify(cleanRoles), JSON.stringify(cleanCaps), JSON.stringify(cleanConfig),
    enabled ? 1 : 0, existing?.builtin ?? 0, existing?.created_at ?? now, now,
  );

  db.prepare(`
    INSERT INTO member_status (member, channel, state, sessions_json, detail, checked_at)
    VALUES (?, ?, 'idle', '[]', ?, ?)
    ON CONFLICT(member) DO UPDATE SET
      channel = excluded.channel,
      detail = excluded.detail,
      checked_at = excluded.checked_at
  `).run(
    safeId, defaultChannel, `Registered (${driver})`, now,
  );

  logEvent(db, { eventType: 'agent.registered', actor: safeId, payload: { driver, roles: cleanRoles } });
  return getAgent(db, safeId);
}

export function removeAgent(db, agentId) {
  const safeId = assertValidAgentId(agentId);
  const existing = getAgent(db, safeId);
  if (!existing) throw new Error(`Agent not found: ${safeId}`);
  if (existing.builtin) {
    // Built-in core agents are disabled rather than hard-deleted so history stays intact
    db.prepare('UPDATE agents SET enabled = 0, updated_at = ? WHERE agent_id = ?').run(new Date().toISOString(), safeId);
    logEvent(db, { eventType: 'agent.disabled', actor: safeId });
    return { agent_id: safeId, removed: false, disabled: true };
  }
  db.prepare('DELETE FROM agents WHERE agent_id = ?').run(safeId);
  db.prepare('DELETE FROM member_status WHERE member = ?').run(safeId);
  logEvent(db, { eventType: 'agent.removed', actor: safeId });
  return { agent_id: safeId, removed: true };
}

/**
 * Probe a custom registered agent (`generic-cli` binary availability or `openai-http` /models reachability).
 */
export async function probeCustomAgent(agent, { timeoutMs = 5000, probeArgs = ['--version'] } = {}) {
  if (agent.driver === 'generic-cli') {
    const cmd = agent.config?.command;
    if (!cmd) return { member: agent.id, channel: 'generic-cli', state: 'offline', detail: 'Missing command' };
    const childEnv = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME };
    for (const key of (agent.config?.env_allow || [])) {
      if (process.env[key] !== undefined) childEnv[key] = process.env[key];
    }
    try {
      await execFileAsync(cmd, probeArgs, { encoding: 'utf8', timeout: timeoutMs, windowsHide: true, env: childEnv });
      return { member: agent.id, channel: 'generic-cli', state: 'online', detail: `CLI executable ready (${cmd})` };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { member: agent.id, channel: 'generic-cli', state: 'offline', detail: `Executable not found: ${cmd}` };
      }
      if (err.killed || err.signal) {
        return { member: agent.id, channel: 'generic-cli', state: 'offline', detail: `CLI probe timed out (${cmd})` };
      }
      // Only a clean non-zero numeric exit code on --version indicates the CLI exists and ran
      if (typeof err.code === 'number') {
        return { member: agent.id, channel: 'generic-cli', state: 'idle', detail: `CLI present, exit ${err.code} (${cmd})` };
      }
      return { member: agent.id, channel: 'generic-cli', state: 'offline', detail: `CLI probe failed (${err.code || err.message})` };
    }
  }
  if (agent.driver === 'openai-http') {
    const base = agent.config?.base_url;
    const keyEnv = agent.config?.api_key_env;
    const headers = {};
    if (keyEnv && process.env[keyEnv]) headers.Authorization = `Bearer ${process.env[keyEnv]}`;
    try {
      const res = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(4000) });
      if (res.ok) {
        return { member: agent.id, channel: 'openai-http', state: 'online', detail: `HTTP endpoint ready (${agent.config.model} @ ${base})` };
      }
      return { member: agent.id, channel: 'openai-http', state: 'idle', detail: `Endpoint HTTP ${res.status} (${agent.config.model})` };
    } catch (err) {
      return { member: agent.id, channel: 'openai-http', state: 'offline', detail: `Endpoint unreachable: ${err.message}` };
    }
  }
  return null;
}
