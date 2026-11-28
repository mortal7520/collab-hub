/**
 * CollabHub v3.0 — Zero-Friction 60-Second Onboarding & Auto-Setup Wizard (`src/setup.mjs`)
 *
 * Detects OS, local AI coding clients (Claude Code, Claude Desktop, Codex, Antigravity,
 * Cursor, Windsurf, VS Code, Gemini CLI), installed coding CLIs, and Ollama/LM Studio models.
 * Dry-run by default; with `confirmed === true`, safely writes `.bak`-backed MCP server entries,
 * optional Claude Code StatusLine HUD config, and discovered local CLI/model registrations.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_ROOT } from './config.mjs';
import { logEvent } from './db.mjs';
import { discoverLocalAgents } from './discovery.mjs';
import { buildMcpHubSnapshot, registerMcpServer, syncMcpToClient } from './mcp-hub.mjs';
import { registerAgent } from './registry.mjs';

const CLI_BIN_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'collab-hub.mjs');
const VALID_PROFILES = new Set(['core', 'cockpit', 'full']);

function sanitizeProfile(profile) {
  const p = String(profile || 'cockpit').trim().toLowerCase();
  if (!VALID_PROFILES.has(p)) {
    throw new Error(`Invalid MCP profile "${profile}". Use: core | cockpit | full`);
  }
  return p;
}

function buildStatusLineCommand(cliPath = CLI_BIN_PATH) {
  const safePath = String(cliPath || '');
  if (/[\r\n\0]/.test(safePath)) {
    throw new Error('Unsafe control character in cliPath');
  }
  return `node ${JSON.stringify(safePath)} hud --format statusline`;
}

function planClaudeStatusLine({ homedir = os.homedir(), cliPath = CLI_BIN_PATH } = {}) {
  const settingsPath = path.join(homedir, '.claude', 'settings.json');
  const desiredCmd = buildStatusLineCommand(cliPath);
  const exists = fs.existsSync(settingsPath);
  let current = {};
  let parseError = null;
  if (exists) {
    try {
      current = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    } catch (err) {
      parseError = err.message;
    }
  }
  const currentCmd = current?.statusLine?.command || null;
  const alreadySynced = currentCmd === desiredCmd;
  return {
    path: settingsPath,
    exists,
    parse_error: parseError,
    already_synced: alreadySynced,
    current_command: currentCmd,
    proposed_command: desiredCmd,
    will_write: !parseError && !alreadySynced,
  };
}

export async function planSetup(db, {
  projectDir = WORKSPACE_ROOT,
  profile = 'cockpit',
  clients = null,
  installClaudeStatusLine = true,
  registerLocalClis = true,
  clientSpecs = null,
  homedir = os.homedir(),
  cliPath = CLI_BIN_PATH,
  discoveryDeps = {},
} = {}) {
  const safeProfile = sanitizeProfile(profile);
  const discovery = await discoverLocalAgents(db, discoveryDeps);
  const mcpSnap = buildMcpHubSnapshot(db, { clientSpecs });

  const detectedClients = mcpSnap.clients.filter((c) => c.exists);
  const requestedSet = Array.isArray(clients) ? new Set(clients.map(String)) : null;
  const targetClients = (requestedSet ? mcpSnap.clients.filter((c) => requestedSet.has(c.id)) : detectedClients)
    .map((c) => c.id);

  const recommendedCliArgs = [cliPath, 'mcp', '--profile', safeProfile];
  const clisToRegister = registerLocalClis
    ? [
      ...(discovery.cli_agents || []).filter((c) => c.found && !c.already_registered).map((c) => c.suggested_registration),
      ...(discovery.local_models || []).filter((m) => !m.already_registered).map((m) => m.suggested_registration),
    ].filter(Boolean)
    : [];

  const statusLinePlan = installClaudeStatusLine ? planClaudeStatusLine({ homedir, cliPath }) : null;

  const isEphemeralNpx = /[\\/]_npx[\\/]/i.test(String(cliPath || ''));
  return {
    ok: true,
    dry_run: true,
    platform: process.platform,
    project_dir: projectDir,
    profile: safeProfile,
    ...(isEphemeralNpx ? { ephemeral_npx_warning: 'Running from ephemeral npm _npx cache; install globally (`npm install -g collab-hub`) or clone the repository before persisting MCP/statusLine paths.' } : {}),
    mcp_server_entry: {
      id: 'collab-hub',
      transport: 'stdio',
      command: process.execPath,
      args: recommendedCliArgs,
    },
    detected_clients: mcpSnap.clients.map((c) => ({
      id: c.id,
      name: c.name,
      exists: c.exists,
      server_count: c.servers_count ?? 0,
      will_sync: targetClients.includes(c.id),
    })),
    target_clients: targetClients,
    claude_statusline: statusLinePlan,
    discoverable_agents: clisToRegister.map((r) => ({ agent_id: r.agent_id, name: r.name, driver: r.driver })),
    discovery_summary: discovery.summary,
    hint: 'Pass confirmed=true (or CLI --confirm) to register CollabHub into selected AI clients with automatic .bak backups.',
  };
}

export async function applySetup(db, {
  projectDir = WORKSPACE_ROOT,
  profile = 'cockpit',
  clients = null,
  installClaudeStatusLine = true,
  registerLocalClis = true,
  confirmed = false,
  clientSpecs = null,
  homedir = os.homedir(),
  cliPath = CLI_BIN_PATH,
  discoveryDeps = {},
} = {}) {
  if (confirmed !== undefined && typeof confirmed !== 'boolean') {
    throw new Error('confirmed must be a strict boolean');
  }
  const plan = await planSetup(db, {
    projectDir,
    profile,
    clients,
    installClaudeStatusLine,
    registerLocalClis,
    clientSpecs,
    homedir,
    cliPath,
    discoveryDeps,
  });
  if (confirmed !== true) return plan;

  const safeProfile = plan.profile;
  registerMcpServer(db, {
    id: 'collab-hub',
    name: 'collab-hub',
    transport: 'stdio',
    command: process.execPath,
    args: [cliPath, 'mcp', '--profile', safeProfile],
    tags: ['collab-hub', 'local-first'],
    group_name: 'core',
  }, { source: 'setup' });

  const clientSyncResults = [];
  for (const clientId of plan.target_clients) {
    try {
      const res = syncMcpToClient(db, {
        clientId,
        serverIds: ['collab-hub'],
        confirmed: true,
        clientSpecs,
      });
      clientSyncResults.push({
        client_id: clientId,
        ok: true,
        backup_created: res.backup_created,
        backup_basename: res.backup_basename || null,
        target_basename: res.target_basename || null,
      });
    } catch (err) {
      clientSyncResults.push({ client_id: clientId, ok: false, error: String(err.message || err) });
    }
  }

  let statusLineResult = null;
  if (installClaudeStatusLine && plan.claude_statusline && !plan.claude_statusline.parse_error && plan.claude_statusline.will_write) {
    const slPath = plan.claude_statusline.path;
    fs.mkdirSync(path.dirname(slPath), { recursive: true });
    let existing = {};
    let backupPath = null;
    if (fs.existsSync(slPath)) {
      const raw = fs.readFileSync(slPath, 'utf8');
      existing = JSON.parse(raw);
      backupPath = `${slPath}.bak.${Date.now()}`;
      fs.writeFileSync(backupPath, raw, { encoding: 'utf8', mode: 0o600 });
    }
    existing.statusLine = { type: 'command', command: plan.claude_statusline.proposed_command };
    const tmp = `${slPath}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(existing, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, slPath);
    statusLineResult = { ok: true, path: slPath, backup_path: backupPath, command: existing.statusLine.command };
  }

  const registeredAgents = [];
  if (registerLocalClis) {
    const discovery = await discoverLocalAgents(db, discoveryDeps);
    const items = [
      ...(discovery.cli_agents || []).filter((c) => c.found && !c.already_registered).map((c) => c.suggested_registration),
      ...(discovery.local_models || []).filter((m) => !m.already_registered).map((m) => m.suggested_registration),
    ].filter(Boolean);
    for (const reg of items) {
      try {
        const saved = registerAgent(db, reg);
        registeredAgents.push({ id: saved.id, driver: saved.driver });
      } catch { /* skip conflicting ID */ }
    }
  }

  logEvent(db, {
    eventType: 'setup.applied',
    actor: 'collab-hub',
    payload: {
      profile: safeProfile,
      clients_synced: clientSyncResults.filter((r) => r.ok).map((r) => r.client_id),
      registered_agents: registeredAgents.map((a) => a.id),
      statusline_updated: Boolean(statusLineResult?.ok),
    },
  });

  return {
    ok: true,
    dry_run: false,
    profile: safeProfile,
    client_syncs: clientSyncResults,
    claude_statusline: statusLineResult || { skipped: true, reason: plan.claude_statusline?.already_synced ? 'already_synced' : 'disabled_or_unwritable' },
    registered_agents: registeredAgents,
  };
}
