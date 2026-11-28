import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planAutostart } from '../src/autostart.mjs';
import { isOptionalIntegrationConfigured } from '../src/config.mjs';
import { createDashboardServer } from '../src/dashboard.mjs';
import { openHubDb, upsertMemberStatus } from '../src/db.mjs';
import { createCollabHub } from '../src/index.mjs';
import { estimateCostUsd, getLiveAgentUsage, recordMcpClientActivity, scanLocalAgentUsage } from '../src/live-usage.mjs';
import { getDefaultClientSpecs, scanLocalMcpClients, syncMcpToClient } from '../src/mcp-hub.mjs';
import { MCP_PROFILES, TOOLS, getToolsForProfile, handleMcpJsonRpcMessage, handleToolCall } from '../src/mcp-server.mjs';
import { planDispatch, probeDsh, probeMuse } from '../src/prober.mjs';
import { TASK_CATEGORIES, buildCapabilityMatrix, classifyTaskIntent, getAgentCapabilityProfile, scoreAgentForTask } from '../src/router.mjs';
import { getIdeExtensionTargets, installNativePlugins, planPluginInstall } from '../src/plugin-installer.mjs';
import { diagnoseSystem } from '../src/self-improve.mjs';
import { applySetup, planSetup } from '../src/setup.mjs';
import { deleteWebhook, deliverWebhook, formatWebhookPayload, listWebhooks, saveWebhook } from '../src/webhooks.mjs';

function makeTempDir(prefix = 'collabhub-v3-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('v3.0: external onboarding aliases, optional unconfigured integrations & zero health penalty', async () => {
  const out = execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
      import assert from 'node:assert/strict';
      const { APP_ROOT, WORKSPACE_ROOT, isOptionalIntegrationConfigured } = await import('./src/config.mjs');
      assert.equal(APP_ROOT, process.env.COLLAB_HUB_HOME);
      assert.equal(WORKSPACE_ROOT, process.env.COLLAB_HUB_WORKSPACE);
      assert.equal(isOptionalIntegrationConfigured('dsh'), false);
      assert.equal(isOptionalIntegrationConfigured('muse'), false);
      console.log('ENV_ALIASES_OK');
    `,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      COLLAB_HUB_HOME: path.join(os.tmpdir(), 'ch-home-alias'),
      COLLAB_HUB_WORKSPACE: path.join(os.tmpdir(), 'ch-ws-alias'),
      WORKSWARM_APP_DIR: '',
      WORKSWARM_WORKSPACE: '',
      WORKSWARM_WSL_DISTRO: '',
      WORKSWARM_WSL_USER: '',
      WORKSWARM_MUSE_RELAY_URL: '',
    },
    encoding: 'utf8',
  });
  assert.ok(out.includes('ENV_ALIASES_OK'));

  assert.equal(typeof isOptionalIntegrationConfigured('dsh'), 'boolean');

  const tmp = makeTempDir();
  const db = openHubDb(path.join(tmp.dir, 'hub.db'));
  try {
    const dshProbe = await probeDsh(async () => ({ ok: false }), { isConfigured: false });
    const museProbe = await probeMuse(async () => ({ ok: false }), { isConfigured: false });
    assert.equal(dshProbe.state, 'unconfigured');
    assert.equal(museProbe.state, 'unconfigured');

    // Never penalize external users for unconfigured optional bridges
    const diag = diagnoseSystem(db);
    assert.ok(!diag.findings.some((f) => ['dsh_offline', 'muse_offline'].includes(f.code)));
  } finally {
    db.close();
    tmp.cleanup();
  }
});

test('v3.0: 14 mainstream market clients + multi-rootKey JSON sync (OpenCode, Zed, Cline, Cursor)', async () => {
  const tmp = makeTempDir('ch-clients-');
  const db = openHubDb(path.join(tmp.dir, 'hub.db'));
  try {
    const specs = getDefaultClientSpecs({ homedir: tmp.dir, platform: 'linux', env: {} });
    assert.equal(specs.length, 14);
    for (const id of [
      'antigravity', 'codex', 'claude-code', 'claude-desktop', 'cursor',
      'windsurf', 'vscode', 'gemini-cli', 'cline', 'roo-code',
      'opencode', 'zed', 'continue', 'kiro',
    ]) {
      assert.ok(specs.some((s) => s.id === id), `Missing market client spec: ${id}`);
    }

    const opencodePath = path.join(tmp.dir, 'opencode.json');
    const zedPath = path.join(tmp.dir, 'zed.json');
    const clinePath = path.join(tmp.dir, 'cline.json');
    fs.writeFileSync(opencodePath, JSON.stringify({ mcp: { existing: { type: 'local', command: ['node', 'a.js'] } } }), 'utf8');
    fs.writeFileSync(zedPath, JSON.stringify({ context_servers: { old: { command: { path: 'npx', args: ['-y', 'demo'] } } } }), 'utf8');
    fs.writeFileSync(clinePath, '{}', 'utf8');

    const customSpecs = [
      { id: 'opencode', name: 'OpenCode', format: 'json', rootKey: 'mcp', paths: [opencodePath] },
      { id: 'zed', name: 'Zed', format: 'json', rootKey: 'context_servers', paths: [zedPath] },
      { id: 'cline', name: 'Cline', format: 'json', rootKey: 'mcpServers', paths: [clinePath] },
    ];
    const scan = scanLocalMcpClients({ clientSpecs: customSpecs });
    assert.equal(scan.clients.find((c) => c.id === 'opencode').servers_count, 1);
    assert.equal(scan.clients.find((c) => c.id === 'zed').servers_count, 1);

    await handleToolCall(db, 'collab_mcp_hub', {
      action: 'register',
      id: 'collab-hub',
      name: 'collab-hub',
      transport: 'stdio',
      command: 'node',
      args: ['bin/collab-hub.mjs', 'mcp'],
    });
    const resOC = syncMcpToClient(db, { clientId: 'opencode', serverIds: ['collab-hub'], confirmed: true, clientSpecs: customSpecs });
    assert.equal(resOC.applied, true);
    const writtenOC = JSON.parse(fs.readFileSync(opencodePath, 'utf8'));
    assert.equal(writtenOC.mcp['collab-hub'].type, 'local');
    assert.deepEqual(writtenOC.mcp['collab-hub'].command, ['node', 'bin/collab-hub.mjs', 'mcp']);

    const resZed = syncMcpToClient(db, { clientId: 'zed', serverIds: ['collab-hub'], confirmed: true, clientSpecs: customSpecs });
    assert.equal(resZed.applied, true);
    const writtenZed = JSON.parse(fs.readFileSync(zedPath, 'utf8'));
    assert.equal(writtenZed.context_servers['collab-hub'].source, 'custom');
  } finally {
    db.close();
    tmp.cleanup();
  }
});

test('v3.0: Real-Time Cross-Agent Usage Engine (MCP telemetry + local JSONL scan, zero prompt leaks)', async () => {
  const tmp = makeTempDir('ch-usage-');
  const db = openHubDb(path.join(tmp.dir, 'hub.db'));
  try {
    // 1. Live MCP client calls tracked automatically via handleMcpJsonRpcMessage
    const sess = { cancelledIds: new Set() };
    await handleMcpJsonRpcMessage(db, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Cursor IDE', version: '0.50' } },
    }, { transport: 'http', profile: 'cockpit', sessionState: sess });
    await handleMcpJsonRpcMessage(db, {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'collab_usage', arguments: { action: 'summary', include_local_scan: false } },
    }, { transport: 'http', profile: 'cockpit', sessionState: sess });

    recordMcpClientActivity(db, {
      clientName: 'Windsurf Cascade',
      transport: 'stdio',
      profile: 'core',
      toolName: 'collab_roster',
      bytesIn: 240,
      bytesOut: 960,
    });

    // 2. Synthetic Claude Code + Codex session logs containing SECRET prompt text that MUST NEVER be extracted
    const SECRET_PROMPT = 'SUPER_SECRET_USER_PROMPT_sk-secret1234567890abcdef_DO_NOT_LEAK';
    const claudeDir = path.join(tmp.dir, '.claude', 'projects', 'demo');
    const codexDir = path.join(tmp.dir, '.codex', 'sessions', '2026');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.mkdirSync(codexDir, { recursive: true });
    const nowIso = new Date().toISOString();
    fs.writeFileSync(path.join(claudeDir, 'sess1.jsonl'), [
      JSON.stringify({ timestamp: nowIso, message: { role: 'user', content: SECRET_PROMPT } }),
      JSON.stringify({ timestamp: nowIso, message: { model: 'claude-sonnet-4-20250514', usage: { input_tokens: 1200, output_tokens: 400, cache_read_input_tokens: 800 } } }),
    ].join('\n') + '\n', 'utf8');
    fs.writeFileSync(path.join(codexDir, 'codex1.jsonl'), [
      JSON.stringify({ timestamp: nowIso, payload: { model: 'gpt-5-codex', prompt: SECRET_PROMPT, info: { last_token_usage: { input_tokens: 1000, output_tokens: 500, cached_input_tokens: 200, total_tokens: 1500 } } } }),
    ].join('\n') + '\n', 'utf8');

    const localScan = scanLocalAgentUsage({ homedir: tmp.dir, cacheTtlMs: 0 });
    assert.equal(localScan.buckets.length, 2);
    const report = getLiveAgentUsage(db, { homedir: tmp.dir, includeLocalScan: true, cacheTtlMs: 0 });
    assert.equal(report.privacy_note, 'metadata_only_no_prompts');
    assert.ok(report.totals.connected_agents >= 4);
    assert.ok(report.totals.today_tokens >= 3900);
    assert.ok(report.totals.est_cost_usd_today > 0);
    assert.equal(estimateCostUsd('ollama/qwen2.5-coder', { inputTokens: 10000, outputTokens: 2000 }), 0);

    const serialized = JSON.stringify(report);
    assert.ok(!serialized.includes('SUPER_SECRET_USER_PROMPT'), 'Prompt text must NEVER appear in usage telemetry');
    assert.ok(!serialized.includes('sk-secret'), 'Secrets must NEVER appear in usage telemetry');
  } finally {
    db.close();
    tmp.cleanup();
  }
});

test('v3.0: MCP Profiles (13/23/53), Streamable HTTP /mcp security, and SDK createCollabHub', async () => {
  assert.equal(TOOLS.length, 53);
  assert.equal(getToolsForProfile('core').length, 13);
  assert.equal(getToolsForProfile('cockpit').length, 23);
  assert.equal(getToolsForProfile('full').length, 53);
  assert.equal(getToolsForProfile('full', ['collab_roster', 'collab_usage']).length, 2);
  assert.equal(MCP_PROFILES.core.length, 13);

  const tmp = makeTempDir('ch-http-mcp-');
  const dbPath = path.join(tmp.dir, 'hub.db');
  const hub = await createCollabHub({ dbPath, host: '127.0.0.1', port: 0, autoPoll: false, triggers: false, webhooks: false });
  try {
    // 1. GET /mcp discovery
    const infoRes = await fetch(`${hub.url}/mcp`);
    assert.equal(infoRes.status, 200);
    const info = await infoRes.json();
    assert.equal(info.transport, 'streamable-http');

    // 2. Reject cross-origin POST & non-JSON
    const crossOrigin = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://evil.example' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(crossOrigin.status, 403);

    const badMime = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: 'hello',
    });
    assert.equal(badMime.status, 415);

    // 3. Valid POST /mcp initialize + tools/list?profile=core + DELETE session
    const initRes = await fetch(`${hub.url}/mcp?profile=core`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18', clientInfo: { name: 'Kiro IDE', version: '1.0' } },
      }),
    });
    assert.equal(initRes.status, 200);
    const sessId = initRes.headers.get('mcp-session-id');
    assert.ok(sessId);

    const listRes = await fetch(`${hub.url}/mcp?profile=core`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sessId },
      body: JSON.stringify({ jsonrpc: '2.0', id: 11, method: 'tools/list', params: {} }),
    });
    const listData = await listRes.json();
    assert.equal(listData.result.tools.length, 13);

    const usageRes = await fetch(`${hub.url}/api/usage/live?local=0`);
    assert.equal(usageRes.status, 200);
    const usageJson = await usageRes.json();
    assert.ok(usageJson.agents.some((a) => a.agent_id === 'kiro'));

    const delRes = await fetch(`${hub.url}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sessId } });
    assert.equal(delRes.status, 204);
  } finally {
    await hub.close();
    tmp.cleanup();
  }
});

test('v3.0: Outbound Webhooks SSRF guard, secret_env guard, 6 formats & HMAC-SHA256', async () => {
  const tmp = makeTempDir('ch-whk-');
  const db = openHubDb(path.join(tmp.dir, 'hub.db'));
  try {
    await assert.rejects(
      saveWebhook(db, { name: 'bad-local', url: 'https://127.0.0.1:9000/hook' }),
      /SSRF|allowed|https|blocked|private/i,
    );
    await assert.rejects(
      saveWebhook(db, { name: 'bad-meta', url: 'https://169.254.169.254/latest' }),
      /SSRF|blocked|private/i,
    );
    await assert.rejects(
      saveWebhook(db, { name: 'bad-http', url: 'http://hooks.example.com/abc' }),
      /https/i,
    );
    await assert.rejects(
      saveWebhook(db, { name: 'bad-secret', url: 'https://hooks.example.com/abc', secretEnv: 'literal_secret_value' }, { validateUrl: async () => {} }),
      /secret_env/i,
    );

    for (const fmt of ['slack', 'discord', 'feishu', 'dingtalk', 'telegram', 'generic']) {
      const p = formatWebhookPayload(fmt, { event_type: 'task.completed', actor: 'codex', task_id: 't1', payload: { ok: true } });
      assert.equal(typeof p, 'object');
    }

    process.env.TEST_HUB_WEBHOOK_SECRET = 'top-secret-signing-key';
    const hook = await saveWebhook(db, {
      name: 'prod-slack',
      format: 'slack',
      url: 'https://hooks.example.com/services/demo',
      secretEnv: 'TEST_HUB_WEBHOOK_SECRET',
      events: ['task.*'],
    }, { validateUrl: async () => {} });

    let capturedHeaders = null;
    let capturedBody = null;
    const delivery = await deliverWebhook(db, hook.webhook_id, {
      event_type: 'task.completed',
      actor: 'codex',
      payload: { ok: true },
    }, {
      validateUrl: async () => {},
      fetch: async (_u, init) => {
        capturedHeaders = init.headers;
        capturedBody = init.body;
        return new Response('ok', { status: 200 });
      },
    });
    assert.equal(delivery.ok, true);
    const expectedHmac = `sha256=${createHmac('sha256', 'top-secret-signing-key').update(capturedBody, 'utf8').digest('hex')}`;
    assert.equal(capturedHeaders['X-CollabHub-Signature-256'], expectedHmac);
    assert.equal(listWebhooks(db).length, 1);
    assert.equal(deleteWebhook(db, hook.webhook_id).deleted, true);
  } finally {
    delete process.env.TEST_HUB_WEBHOOK_SECRET;
    db.close();
    tmp.cleanup();
  }
});

test('v3.0: Guided Setup Wizard (.bak + Claude statusLine) & Cross-Platform Autostart Planner', async () => {
  const tmp = makeTempDir('ch-setup-');
  const db = openHubDb(path.join(tmp.dir, 'hub.db'));
  try {
    const cursorCfg = path.join(tmp.dir, '.cursor', 'mcp.json');
    const claudeCfg = path.join(tmp.dir, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(cursorCfg), { recursive: true });
    fs.mkdirSync(path.dirname(claudeCfg), { recursive: true });
    fs.writeFileSync(cursorCfg, JSON.stringify({ mcpServers: { unrelated: { command: 'echo', args: ['hi'] } } }, null, 2));
    fs.writeFileSync(claudeCfg, JSON.stringify({ theme: 'dark' }, null, 2));

    const fakeSpecs = [
      { id: 'cursor', name: 'Cursor', format: 'json', rootKey: 'mcpServers', paths: [cursorCfg] },
    ];
    const plan = await planSetup(db, {
      profile: 'cockpit',
      clientSpecs: fakeSpecs,
      homedir: tmp.dir,
      discoveryDeps: { locateBinary: async () => null, probeLocalEndpoint: async () => ({ reachable: false, models: [] }) },
    });
    assert.equal(plan.dry_run, true);
    assert.equal(plan.detected_clients[0].server_count, 1);
    assert.equal(plan.claude_statusline.will_write, true);

    const applied = await applySetup(db, {
      profile: 'cockpit',
      confirmed: true,
      clientSpecs: fakeSpecs,
      homedir: tmp.dir,
      discoveryDeps: { locateBinary: async () => null, probeLocalEndpoint: async () => ({ reachable: false, models: [] }) },
    });
    assert.equal(applied.dry_run, false);
    assert.equal(applied.client_syncs[0].ok, true);
    assert.equal(applied.client_syncs[0].backup_created, true);
    assert.equal(applied.claude_statusline.ok, true);

    const updatedCursor = JSON.parse(fs.readFileSync(cursorCfg, 'utf8'));
    assert.ok(updatedCursor.mcpServers.unrelated);
    assert.ok(updatedCursor.mcpServers['collab-hub']);
    const updatedClaude = JSON.parse(fs.readFileSync(claudeCfg, 'utf8'));
    assert.ok(updatedClaude.statusLine.command.includes('hud --format statusline'));

    // Cross-platform autostart planning (read-only)
    const macPlan = planAutostart({ platform: 'darwin', homedir: tmp.dir });
    const linPlan = planAutostart({ platform: 'linux', homedir: tmp.dir });
    const winPlan = planAutostart({ platform: 'win32', homedir: tmp.dir });
    assert.ok(macPlan.content.includes('io.github.mortal7520.collab-hub'));
    assert.ok(linPlan.content.includes('[Service]') && linPlan.content.includes('COLLAB_HUB_HOME'));
    assert.equal(winPlan.manager, 'schtasks');
  } finally {
    db.close();
    tmp.cleanup();
  }
});

test('v3.0: Capability & Model-Strength Smart Router (bilingual classification, strength scoring & /api/route/*)', async () => {
  assert.equal(TASK_CATEGORIES.length, 10);
  const copyCls = classifyTaskIntent({ prompt: '编写双语 README 与产品推广文案', role: 'synthesizer' });
  assert.equal(copyCls.category, 'copywriting');
  const secCls = classifyTaskIntent({ prompt: 'Audit SSRF and CSRF security boundaries', role: 'reviewer' });
  assert.equal(secCls.category, 'security_audit');
  assert.equal(secCls.complexity, 'high');
  const linCls = classifyTaskIntent({ prompt: 'Fix Ubuntu WSL Docker bash CI failure', role: 'tester' });
  assert.equal(linCls.category, 'linux_ops');
  const lowCls = classifyTaskIntent({ prompt: 'quick typo fix', role: 'implementer' });
  assert.equal(lowCls.complexity, 'low');

  const tmp = makeTempDir('ch-router-');
  const dbPath = path.join(tmp.dir, 'hub.db');
  const hub = await createCollabHub({ dbPath, host: '127.0.0.1', port: 0, autoPoll: false, triggers: false, webhooks: false });
  try {
    // Make dsh & muse online + register local ollama agent for testing capability ranking
    upsertMemberStatus(hub.db, { member: 'dsh', channel: 'dsh-baton', state: 'online', detail: 'WSL ok' });
    upsertMemberStatus(hub.db, { member: 'muse', channel: 'muse-tailnet', state: 'online', detail: 'Tailnet ok' });
    upsertMemberStatus(hub.db, { member: 'agy', channel: 'desktop-native', state: 'online', detail: 'Active' });
    upsertMemberStatus(hub.db, { member: 'codex', channel: 'desktop-native', state: 'online', detail: 'Active' });
    upsertMemberStatus(hub.db, { member: 'claude', channel: 'desktop-native', state: 'online', detail: 'Active' });

    // 1. Copywriting -> AGY/Claude beats weaker cloud Muse!
    const copyPlan = planDispatch(hub.db, { role: 'synthesizer', prompt: '撰写双语 README 和推广文案' });
    assert.ok(['agy', 'claude'].includes(copyPlan.recommended.member));
    assert.ok(copyPlan.recommended.routing_reasons.length >= 1);

    // 2. Security audit -> Codex beats weaker agents!
    const secPlan = planDispatch(hub.db, { role: 'reviewer', prompt: 'Deep security audit of SSRF & HMAC boundaries', strategy: 'quality' });
    assert.equal(secPlan.recommended.member, 'codex');

    // 3. Linux CI / Docker -> DSH beats desktop UI agents on linux_ops!
    const linuxPlan = planDispatch(hub.db, { role: 'implementer', prompt: 'Fix Linux Docker bash CI workflow' });
    assert.equal(linuxPlan.recommended.member, 'dsh');

    // 4. Registered free local model wins cost-optimized simple task!
    await handleToolCall(hub.db, 'collab_agent_register', {
      agent_id: 'ollama-qwen',
      name: 'Ollama Qwen',
      driver: 'openai-http',
      roles: ['researcher', 'synthesizer'],
      config: { base_url: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
    });
    upsertMemberStatus(hub.db, { member: 'ollama-qwen', channel: 'openai-http', state: 'online', detail: 'Local' });
    const cheapPlan = planDispatch(hub.db, { role: 'researcher', prompt: 'quick format summary', strategy: 'cost' });
    assert.equal(cheapPlan.recommended.member, 'ollama-qwen');

    // 5. Matrix & HTTP API check
    const matRes = await fetch(`${hub.url}/api/route/matrix`);
    assert.equal(matRes.status, 200);
    const matJson = await matRes.json();
    assert.equal(matJson.categories.length, 10);
    assert.ok(matJson.matrix.some((m) => m.member === 'ollama-qwen' && m.cost_tier === 'free'));

    const recRes = await fetch(`${hub.url}/api/route/recommend`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
      body: JSON.stringify({ role: 'reviewer', prompt: 'Security audit of SSRF' }),
    });
    assert.equal(recRes.status, 200);
    const recJson = await recRes.json();
    assert.equal(recJson.recommended.member, 'codex');
    assert.ok(buildCapabilityMatrix([{ member: 'codex', config: {} }])[0].top_strengths.length === 3);
    assert.equal(getAgentCapabilityProfile({ member: 'agy' }).tier, 'flagship');
    assert.ok(scoreAgentForTask({ member: 'ollama-local', config: { model: 'ollama/qwen' } }, { category: 'fast_cheap', strategy: 'cost' }).delta > 0);
  } finally {
    await hub.close();
    tmp.cleanup();
  }
});

test('v3.0: Cross-IDE Native Resident Plugin Installer (VS Code/Cursor/Windsurf/AGY/Kiro) & extension manifest', () => {
  const tmp = makeTempDir('ch-plugins-');
  try {
    fs.mkdirSync(path.join(tmp.dir, '.vscode', 'extensions'), { recursive: true });
    fs.mkdirSync(path.join(tmp.dir, '.cursor', 'extensions'), { recursive: true });
    fs.mkdirSync(path.join(tmp.dir, '.antigravity', 'extensions'), { recursive: true });

    const targets = getIdeExtensionTargets({ homedir: tmp.dir });
    assert.equal(targets.length, 5);

    const plan = planPluginInstall({ homedir: tmp.dir });
    assert.equal(plan.dry_run, true);
    assert.equal(plan.source_exists, true);
    assert.equal(plan.ides.filter((i) => i.detected).length, 3);

    const applied = installNativePlugins({ confirmed: true, homedir: tmp.dir });
    assert.equal(applied.dry_run, false);
    assert.equal(applied.installed_count, 3);
    for (const id of ['vscode', 'cursor', 'antigravity']) {
      const r = applied.results.find((x) => x.id === id);
      assert.equal(r.installed, true);
      assert.ok(fs.existsSync(path.join(r.install_dir, 'extension.js')));
      assert.ok(fs.existsSync(path.join(r.install_dir, 'package.json')));
    }
    const extPkg = JSON.parse(fs.readFileSync(path.resolve('extensions/collab-hub-vscode/package.json'), 'utf8'));
    assert.equal(extPkg.name, 'collab-hub');
    assert.ok(extPkg.contributes.views.collabhub.length === 1);

    // Explicit empty selection must select zero IDEs (never fall back to all detected)
    const emptyPlan = planPluginInstall({ ides: [], homedir: tmp.dir });
    assert.equal(emptyPlan.ides.filter((i) => i.will_install).length, 0);
  } finally {
    tmp.cleanup();
  }
});

test('v3.0 regressions: router fast-tier order, task token rollup, /mcp 404 session, webhook redaction & fail-closed signing, autostart escaping', async () => {
  // 1. Model regex ordering: mini / flash / haiku must resolve to fast tier, never flagship
  assert.equal(getAgentCapabilityProfile({ member: 'custom-mini', config: { model: 'gpt-5-mini' } }).tier, 'fast');
  assert.equal(getAgentCapabilityProfile({ member: 'custom-flash', config: { model: 'gemini-2.5-flash' } }).tier, 'fast');
  assert.equal(getAgentCapabilityProfile({ member: 'custom-haiku', config: { model: 'claude-4-haiku' } }).tier, 'fast');

  const tmp = makeTempDir('ch-reg-');
  const dbPath = path.join(tmp.dir, 'hub.db');
  const hub = await createCollabHub({ dbPath, host: '127.0.0.1', port: 0, autoPoll: false, triggers: false, webhooks: false });
  try {
    // 2. Task ledger token aggregation into getLiveAgentUsage (`taskTel.agents` map)
    const nowIso = new Date().toISOString();
    hub.db.prepare(`
      INSERT INTO tasks (task_id, project_dir, member, role, channel, title, prompt, state, evidence_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('t_reg_tok_1', tmp.dir, 'codex', 'reviewer', 'codex-bridge', 'Audit PR', 'Audit security', 'completed', JSON.stringify({ usage: { prompt_tokens: 2500, completion_tokens: 1200, total_tokens: 3700 } }), nowIso, nowIso);
    const live = getLiveAgentUsage(hub.db, { includeLocalScan: false, homedir: tmp.dir });
    const codexRow = live.agents.find((a) => a.agent_id === 'codex');
    assert.ok(codexRow, 'codex task ledger row should appear in live usage');
    assert.equal(codexRow.task_tokens, 3700);
    assert.ok(codexRow.today_tokens >= 3700);

    // 3. Streamable HTTP /mcp session checks
    const badSess = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': 'nonexistent-session-id' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    assert.equal(badSess.status, 404);

    const noInitCall = await fetch(`${hub.url}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'collab_roster', arguments: {} } }),
    });
    assert.equal(noInitCall.status, 400);

    const sseGet = await fetch(`${hub.url}/mcp`, { headers: { Accept: 'text/event-stream' } });
    assert.equal(sseGet.status, 405);

    // 4. Empty `clients: []` stays empty in planSetup
    const cursorCfg = path.join(tmp.dir, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursorCfg), { recursive: true });
    fs.writeFileSync(cursorCfg, '{"mcpServers":{}}', 'utf8');
    const setupEmpty = await planSetup(hub.db, {
      clients: [],
      clientSpecs: [{ id: 'cursor', name: 'Cursor', format: 'json', rootKey: 'mcpServers', paths: [cursorCfg] }],
      homedir: tmp.dir,
      discoveryDeps: { locateBinary: async () => null, probeLocalEndpoint: async () => ({ reachable: false, models: [] }) },
    });
    assert.deepEqual(setupEmpty.target_clients, []);

    // 5. Webhook credential rejection, URL redaction in listWebhooks, and fail-closed missing secret_env
    await assert.rejects(
      saveWebhook(hub.db, { name: 'bad-userinfo', url: 'https://user:pass@hooks.example.com/a' }, { validateUrl: async () => {} }),
      /credentials|userinfo/i,
    );
    await assert.rejects(
      saveWebhook(hub.db, { name: 'bad-qtok', url: 'https://hooks.example.com/hook?token=abc123' }, { validateUrl: async () => {} }),
      /query parameter|secret_env/i,
    );
    process.env.REG_HOOK_SIGN_SECRET = 'reg-secret-value';
    const saved = await saveWebhook(hub.db, {
      name: 'redacted-hook',
      format: 'slack',
      url: 'https://hooks.example.com/services/T0000000000000000/B1111111111111111/SUPERSECRETSEGMENT999',
      secretEnv: 'REG_HOOK_SIGN_SECRET',
    }, { validateUrl: async () => {} });
    assert.ok(!saved.url.includes('SUPERSECRETSEGMENT999'));
    assert.ok(listWebhooks(hub.db).every((h) => !h.url.includes('SUPERSECRETSEGMENT999')));
    delete process.env.REG_HOOK_SIGN_SECRET;
    await assert.rejects(
      deliverWebhook(hub.db, saved.webhook_id, { event_type: 'task.completed', payload: {} }, {
        validateUrl: async () => ({ parsed: new URL('https://hooks.example.com/hook') }),
        fetch: async () => new Response('ok', { status: 200 }),
      }),
      /secret env.*not set|refusing unsigned/i,
    );

    // 6. Autostart validation & escaping
    assert.throws(() => planAutostart({ platform: 'linux', workspaceRoot: '/tmp/bad\nExecStart=evil' }), /control character/i);
    const linEsc = planAutostart({ platform: 'linux', homedir: tmp.dir, workspaceRoot: '/tmp/foo%bar' });
    assert.ok(linEsc.content.includes('/tmp/foo%%bar'));
    const winPort = planAutostart({ platform: 'win32', port: 5399 });
    assert.ok(winPort.preview.includes('--port 5399'));
  } finally {
    delete process.env.REG_HOOK_SIGN_SECRET;
    await hub.close();
    tmp.cleanup();
  }
});

test('v3.0 chat-adjacent embedding: inline chat-strip MCP App, GET /api/route/recommend, MV3 browser companion & IDE chatParticipant', async () => {
  const vm = await import('node:vm');
  const tmp = makeTempDir('ch-embed-');
  const dbPath = path.join(tmp.dir, 'hub.db');
  const hub = await createCollabHub({ dbPath, host: '127.0.0.1', port: 0, autoPoll: false, triggers: false, webhooks: false });
  try {
    // 1. Both MCP App resources declared & inline chat-strip HTML parses cleanly
    const resList = await handleMcpJsonRpcMessage(hub.db, { jsonrpc: '2.0', id: 1, method: 'resources/list', params: {} });
    const uris = resList.result.resources.map((r) => r.uri);
    assert.ok(uris.includes('ui://collab-hub/cockpit.html'));
    assert.ok(uris.includes('ui://collab-hub/chat-strip.html'));

    const stripRead = await handleMcpJsonRpcMessage(hub.db, {
      jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'ui://collab-hub/chat-strip.html' },
    });
    assert.equal(stripRead.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    const html = stripRead.result.contents[0].text;
    const m = html.match(/<script[^>]*>([\s\S]*?)<\/script>/);
    assert.ok(m, 'chat-strip inline script must exist');
    new vm.Script(m[1]);
    assert.ok(html.includes('ui/update-model-context'));

    // 2. collab_plan & collab_usage carry inline chat-strip resourceUri while keeping 53/23/13 profile counts
    const planTool = TOOLS.find((t) => t.name === 'collab_plan');
    const usageTool = TOOLS.find((t) => t.name === 'collab_usage');
    assert.equal(planTool._meta.ui.resourceUri, 'ui://collab-hub/chat-strip.html');
    assert.equal(usageTool._meta.ui.resourceUri, 'ui://collab-hub/chat-strip.html');
    assert.equal(TOOLS.length, 53);

    // 3. Read-only GET /api/route/recommend & /chat-strip preview endpoints
    upsertMemberStatus(hub.db, { member: 'codex', channel: 'desktop-native', state: 'online', detail: 'Active' });
    const getRoute = await fetch(`${hub.url}/api/route/recommend?prompt=Audit+SSRF&strategy=quality`);
    assert.equal(getRoute.status, 200);
    const routeJson = await getRoute.json();
    assert.ok(routeJson.recommended?.member);
    assert.ok(Array.isArray(routeJson.recommended.routing_reasons));

    const stripHttp = await fetch(`${hub.url}/chat-strip`);
    assert.equal(stripHttp.status, 200);
    assert.ok((await stripHttp.text()).includes('CollabHub In-Chat HUD'));

    // 4. Browser MV3 Shadow DOM companion & IDE extension manifest contracts
    const mv3 = JSON.parse(fs.readFileSync(path.resolve('extensions/collab-hub-browser/manifest.json'), 'utf8'));
    assert.equal(mv3.manifest_version, 3);
    assert.ok(mv3.host_permissions.every((h) => /^http:\/\/(127\.0\.0\.1|localhost):/.test(h)));
    assert.ok(fs.readFileSync(path.resolve('extensions/collab-hub-browser/content.js'), 'utf8').includes('attachShadow'));

    const vsPkg = JSON.parse(fs.readFileSync(path.resolve('extensions/collab-hub-vscode/package.json'), 'utf8'));
    assert.ok(vsPkg.contributes.viewsContainers.panel.some((p) => p.id === 'collabhub-panel'));
    assert.ok(vsPkg.contributes.chatParticipants.some((p) => p.name === 'collabhub'));
    assert.ok(fs.existsSync(path.resolve('extensions/terminal-hud/tmux-sidebar.sh')));

    // 5. Windows UTF-8 BOM JSON config tolerance across setup & mcp-hub
    const bomClaude = path.join(tmp.dir, '.claude', 'settings.json');
    const bomMcp = path.join(tmp.dir, 'bom-cursor.json');
    fs.mkdirSync(path.dirname(bomClaude), { recursive: true });
    fs.writeFileSync(bomClaude, '\uFEFF' + JSON.stringify({ theme: 'dark', statusLine: { type: 'command', command: 'echo ok' } }), 'utf8');
    fs.writeFileSync(bomMcp, '\uFEFF' + JSON.stringify({ mcpServers: { existing: { command: 'node', args: ['a.js'] } } }), 'utf8');
    const bomPlan = await planSetup(hub.db, {
      homedir: tmp.dir,
      clientSpecs: [{ id: 'cursor', name: 'Cursor', format: 'json', rootKey: 'mcpServers', paths: [bomMcp] }],
      discoveryDeps: { locateBinary: async () => null, probeLocalEndpoint: async () => ({ reachable: false, models: [] }) },
    });
    assert.equal(bomPlan.claude_statusline.parse_error, null);
    assert.equal(bomPlan.claude_statusline.current_command, 'echo ok');
    assert.equal(bomPlan.detected_clients[0].server_count, 1);
  } finally {
    await hub.close();
    tmp.cleanup();
  }
});
