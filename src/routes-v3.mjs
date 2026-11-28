/**
 * CollabHub v3.0 — Modular HTTP Routes (Rooms, Artifacts, Handoff, Consensus, Budget, Triggers,
 * Outbound Webhooks, Setup Wizard, Stale Task Reconcile) & Streamable HTTP MCP Endpoint (`/mcp`)
 */
import { randomUUID } from 'node:crypto';
import { deleteArtifact, getArtifact, listArtifacts, putArtifact } from './artifacts.mjs';
import { deleteBudgetPolicy, evaluateBudget, listBudgetPolicies, setBudgetPolicy } from './budget.mjs';
import { APP_VERSION } from './config.mjs';
import { createConsensusRound, listConsensusRounds, recordConsensusVote, synthesizeConsensus } from './consensus.mjs';
import { buildHandoffPack } from './handoff-pack.mjs';
import { handleMcpJsonRpcMessage } from './mcp-server.mjs';
import { getAutostartStatus, installAutostart } from './autostart.mjs';
import { getMemberStatuses } from './db.mjs';
import { getLiveAgentUsage, getLiveAgentUsageAsync } from './live-usage.mjs';
import { installNativePlugins, planPluginInstall } from './plugin-installer.mjs';
import { planDispatch } from './prober.mjs';
import { TASK_CATEGORIES, buildCapabilityMatrix } from './router.mjs';
import { reconcileStaleTasks } from './self-improve.mjs';
import { applySetup, planSetup } from './setup.mjs';
import { ALLOWED_TRIGGER_ACTIONS, deleteTrigger, listTriggers, runTriggerNow, saveTrigger } from './triggers.mjs';
import { VALID_WEBHOOK_FORMATS, deleteWebhook, deliverWebhook, listWebhooks, saveWebhook } from './webhooks.mjs';
import {
  appendRoomLog, claimRoomPath, createCollabRoom, getRoomStatus, listCollabRooms,
  promoteInboxFile, reconcileStaleClaimsInAllRooms, releaseRoomClaim, renewRoomClaim,
} from './workspace-room.mjs';

const HTTP_MCP_SESSIONS = new Map();
const HTTP_MCP_SESSION_TTL_MS = 30 * 60 * 1000;

function pruneExpiredMcpSessions(now = Date.now()) {
  for (const [id, sess] of HTTP_MCP_SESSIONS.entries()) {
    if ((now - (sess.lastUsedAt || 0)) > HTTP_MCP_SESSION_TTL_MS) {
      HTTP_MCP_SESSIONS.delete(id);
    }
  }
}

function isAllowedMcpHttpOrigin(req, actualPort) {
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && !['same-origin', 'none'].includes(fetchSite)) return false;
  const origin = req.headers.origin;
  if (origin) {
    const okOrigins = new Set([`http://127.0.0.1:${actualPort}`, `http://localhost:${actualPort}`, `http://[::1]:${actualPort}`]);
    if (!okOrigins.has(String(origin).toLowerCase())) return false;
  }
  return true;
}

/**
 * Streamable HTTP MCP endpoint (`/mcp`) reusing the exact shared JSON-RPC 2.0 dispatcher
 * as stdio MCP, with loopback-only Origin verification and optional `?profile=core|cockpit|full`.
 */
export async function handleStreamableMcpHttp(req, res, url, db, { actualPort, readBoundedJson, baseHeaders, sendJson }) {
  if (url.pathname !== '/mcp') return false;

  if (!isAllowedMcpHttpOrigin(req, actualPort)) {
    sendJson(res, 403, { error: 'Forbidden: cross-origin /mcp request rejected' });
    return true;
  }

  pruneExpiredMcpSessions();
  const incomingSessionId = String(req.headers['mcp-session-id'] || '').trim();

  if (req.method === 'DELETE') {
    if (!incomingSessionId || !HTTP_MCP_SESSIONS.has(incomingSessionId)) {
      sendJson(res, 404, { error: 'Unknown or expired Mcp-Session-Id' });
      return true;
    }
    HTTP_MCP_SESSIONS.delete(incomingSessionId);
    res.writeHead(204, baseHeaders);
    res.end();
    return true;
  }

  if (req.method === 'GET') {
    const accept = String(req.headers.accept || '').toLowerCase();
    if (accept.includes('text/event-stream') && !accept.includes('application/json')) {
      sendJson(res, 405, { error: 'SSE stream on GET /mcp is not supported; use POST /mcp with application/json' });
      return true;
    }
    sendJson(res, 200, {
      name: 'collab-hub',
      version: APP_VERSION,
      transport: 'streamable-http',
      endpoint: '/mcp',
      profiles: ['core', 'cockpit', 'full'],
    });
    return true;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method Not Allowed for /mcp (use POST, GET, or DELETE)' });
    return true;
  }

  const ct = String(req.headers['content-type'] || '').toLowerCase();
  if (!ct.includes('application/json')) {
    sendJson(res, 415, { error: 'Unsupported Media Type: /mcp requires application/json' });
    return true;
  }

  let parsed;
  try {
    parsed = await readBoundedJson(req);
  } catch (err) {
    sendJson(res, 400, { error: String(err.message || 'Invalid JSON body') });
    return true;
  }
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  const hasInitialize = messages.some((m) => m && m.method === 'initialize');

  let sessState;
  if (incomingSessionId) {
    sessState = HTTP_MCP_SESSIONS.get(incomingSessionId);
    if (!sessState) {
      sendJson(res, 404, { error: 'Unknown or expired Mcp-Session-Id' });
      return true;
    }
    sessState.lastUsedAt = Date.now();
  } else if (hasInitialize) {
    const newId = randomUUID();
    sessState = {
      id: newId,
      detectedHostMember: null,
      detectedClientName: '',
      cancelledIds: new Set(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    if (HTTP_MCP_SESSIONS.size >= 100) {
      const oldest = HTTP_MCP_SESSIONS.keys().next().value;
      if (oldest) HTTP_MCP_SESSIONS.delete(oldest);
    }
    HTTP_MCP_SESSIONS.set(newId, sessState);
  } else {
    const requiresSession = messages.some((m) => m && m.method === 'tools/call');
    if (requiresSession) {
      sendJson(res, 400, { error: 'Missing Mcp-Session-Id header; initialize a session first.' });
      return true;
    }
    sessState = { id: null, detectedHostMember: null, detectedClientName: '', cancelledIds: new Set() };
  }

  const profile = url.searchParams.get('profile') || 'full';
  const toolsParam = url.searchParams.get('tools');
  const allowlist = toolsParam ? toolsParam.split(',').map((s) => s.trim()).filter(Boolean) : null;

  const ac = new AbortController();
  req.on('close', () => {
    if (!res.writableEnded) {
      try { ac.abort('http_client_disconnected'); } catch {}
    }
  });

  const responses = [];
  for (const m of messages) {
    const out = await handleMcpJsonRpcMessage(db, m, {
      profile,
      allowlist,
      transport: 'http',
      signal: ac.signal,
      sessionState: sessState,
    });
    if (out !== null && out !== undefined) responses.push(out);
  }

  const headers = {
    ...baseHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    ...(sessState.id ? { 'Mcp-Session-Id': sessState.id } : {}),
  };
  if (responses.length === 0) {
    res.writeHead(202, headers);
    res.end();
    return true;
  }
  const body = Array.isArray(parsed) ? responses : responses[0];
  res.writeHead(200, headers);
  res.end(JSON.stringify(body));
  return true;
}

export async function handleV3Routes(req, res, url, db, dispatchDeps, { readBoundedJson, sendJson }) {
  // ---- Shared Rooms ----
  if (req.method === 'GET' && url.pathname === '/api/rooms') {
    const roomId = url.searchParams.get('room_id');
    if (roomId) {
      try { sendJson(res, 200, { room: getRoomStatus(db, roomId) }); }
      catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
      return true;
    }
    sendJson(res, 200, { rooms: listCollabRooms(db) });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms/create') {
    const parsed = await readBoundedJson(req);
    if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
      sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
      return true;
    }
    try {
      sendJson(res, 200, await createCollabRoom(db, {
        name: parsed.name,
        goal: parsed.goal || '',
        agents: parsed.agents,
        createGitRepo: parsed.create_git_repo !== false,
        autoRegisterClis: parsed.auto_register_clis || [],
        launchApps: parsed.launch_apps || [],
        confirmed: parsed.confirmed === true,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms/claim') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        claim: claimRoomPath(db, {
          roomId: parsed.room_id || parsed.name,
          pathGlob: parsed.path_glob,
          ownerAgent: parsed.owner_agent,
          ttlMinutes: parsed.ttl_minutes ?? 30,
          notes: parsed.notes || '',
        }),
      });
    } catch (err) {
      const msg = String(err.message || err);
      sendJson(res, msg.includes('CLAIM_CONFLICT') ? 409 : 400, { error: msg });
    }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms/renew') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        claim: renewRoomClaim(db, { claimId: parsed.claim_id, ownerAgent: parsed.owner_agent, ttlMinutes: parsed.ttl_minutes ?? 30 }),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms/release') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        claim: releaseRoomClaim(db, {
          claimId: parsed.claim_id || null,
          roomId: parsed.room_id || parsed.name || null,
          pathGlob: parsed.path_glob || null,
          ownerAgent: parsed.owner_agent,
        }),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms/log') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        entry: appendRoomLog(db, { roomId: parsed.room_id || parsed.name, actor: parsed.actor || 'cockpit', kind: parsed.kind || 'note', message: parsed.message }),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms/promote') {
    const parsed = await readBoundedJson(req);
    if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
      sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
      return true;
    }
    try {
      sendJson(res, 200, promoteInboxFile(db, {
        roomId: parsed.room_id || parsed.name,
        agent: parsed.agent || parsed.owner_agent,
        relPath: parsed.rel_path,
        destRelPath: parsed.dest_rel_path || null,
        confirmed: parsed.confirmed === true,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/rooms/reconcile-stale') {
    await readBoundedJson(req);
    sendJson(res, 200, reconcileStaleClaimsInAllRooms(db));
    return true;
  }

  // ---- Artifact Vault & Handoff Pack ----
  if (req.method === 'GET' && url.pathname === '/api/artifacts') {
    const id = url.searchParams.get('id');
    if (id) {
      const artifact = getArtifact(db, id);
      if (!artifact) { sendJson(res, 404, { error: 'Artifact not found or expired' }); return true; }
      sendJson(res, 200, { artifact });
      return true;
    }
    sendJson(res, 200, {
      artifacts: listArtifacts(db, {
        roomId: url.searchParams.get('room_id') || null,
        project: url.searchParams.get('project') || null,
        limit: Number(url.searchParams.get('limit')) || 30,
      }),
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/artifacts/put') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        artifact: putArtifact(db, {
          artifactId: parsed.artifact_id || null,
          roomId: parsed.room_id || null,
          project: parsed.project || null,
          name: parsed.name,
          content: parsed.content,
          mimeType: parsed.mime_type || 'text/markdown',
          author: parsed.author || 'cockpit',
          tags: parsed.tags || [],
          ttlHours: parsed.ttl_hours ?? 72,
        }),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/artifacts/delete') {
    const parsed = await readBoundedJson(req);
    try { sendJson(res, 200, deleteArtifact(db, parsed.artifact_id || parsed.id)); }
    catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/handoff-pack') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, buildHandoffPack(db, {
        projectDir: parsed.project_dir || undefined,
        roomId: parsed.room_id || null,
        targetMember: parsed.target_member || null,
        saveArtifact: Boolean(parsed.save_artifact),
        maxBytes: parsed.max_bytes ?? 24000,
        workspaceRoot: dispatchDeps.workspaceRoot,
        extraRoots: dispatchDeps.extraRoots,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }

  // ---- Multi-Agent Consensus ----
  if (req.method === 'GET' && url.pathname === '/api/consensus') {
    sendJson(res, 200, {
      rounds: listConsensusRounds(db, {
        roomId: url.searchParams.get('room_id') || null,
        limit: Number(url.searchParams.get('limit')) || 20,
      }),
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/consensus/create') {
    const parsed = await readBoundedJson(req);
    if (parsed.auto_dispatch !== undefined && typeof parsed.auto_dispatch !== 'boolean') {
      sendJson(res, 400, { error: 'auto_dispatch must be a strict boolean' });
      return true;
    }
    try {
      sendJson(res, 200, await createConsensusRound(db, {
        roundId: parsed.round_id || null,
        roomId: parsed.room_id || null,
        topic: parsed.topic,
        members: parsed.members,
        projectDir: parsed.project_dir || undefined,
        autoDispatch: parsed.auto_dispatch === true,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/consensus/vote') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        round: recordConsensusVote(db, {
          roundId: parsed.round_id,
          member: parsed.member,
          stance: parsed.stance,
          confidence: parsed.confidence ?? 0.85,
          rationale: parsed.rationale || '',
          blockers: parsed.blockers || [],
        }),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/consensus/synthesize') {
    const parsed = await readBoundedJson(req);
    try { sendJson(res, 200, { round: synthesizeConsensus(db, parsed.round_id) }); }
    catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
    return true;
  }

  // ---- Budgets, Triggers & Stale Reconcile ----
  if (req.method === 'GET' && url.pathname === '/api/budget') {
    sendJson(res, 200, {
      policies: listBudgetPolicies(db),
      evaluation: evaluateBudget(db, {
        member: url.searchParams.get('member') || null,
        projectDir: url.searchParams.get('project_dir') || null,
      }),
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/budget/policy') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        policy: setBudgetPolicy(db, {
          policyId: parsed.policy_id || null,
          scopeType: parsed.scope_type || 'agent',
          scopeId: parsed.scope_id || '*',
          dailyTokenLimit: parsed.daily_token_limit ?? null,
          dailyCallLimit: parsed.daily_call_limit ?? null,
          softWarnPct: parsed.soft_warn_pct ?? 80,
          onExceed: parsed.on_exceed || 'warn',
          enabled: parsed.enabled !== false,
        }),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/budget/delete') {
    const parsed = await readBoundedJson(req);
    try { sendJson(res, 200, deleteBudgetPolicy(db, parsed.policy_id || parsed.id)); }
    catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/triggers') {
    sendJson(res, 200, {
      triggers: listTriggers(db),
      allowed_actions: [...ALLOWED_TRIGGER_ACTIONS],
    });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/triggers/save') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        trigger: saveTrigger(db, {
          triggerId: parsed.trigger_id || null,
          name: parsed.name,
          kind: parsed.kind || 'interval',
          action: parsed.action || parsed.trigger_action,
          intervalSec: parsed.interval_sec ?? 900,
          enabled: parsed.enabled !== false,
        }),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/triggers/delete') {
    const parsed = await readBoundedJson(req);
    try { sendJson(res, 200, deleteTrigger(db, parsed.trigger_id || parsed.id)); }
    catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/triggers/run') {
    const parsed = await readBoundedJson(req);
    try { sendJson(res, 200, runTriggerNow(db, parsed.trigger_id || parsed.id)); }
    catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/tasks/reconcile-stale') {
    const parsed = await readBoundedJson(req);
    if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
      sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
      return true;
    }
    try {
      sendJson(res, 200, reconcileStaleTasks(db, {
        taskIds: Array.isArray(parsed.task_ids) ? parsed.task_ids : null,
        resolution: parsed.resolution || 'cancelled',
        note: parsed.note || '',
        confirmed: parsed.confirmed === true,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }

  // ---- v3.0 Outbound Webhooks ----
  if (req.method === 'GET' && url.pathname === '/api/webhooks') {
    sendJson(res, 200, { webhooks: listWebhooks(db), formats: [...VALID_WEBHOOK_FORMATS] });
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/webhooks/save') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, {
        webhook: await saveWebhook(db, {
          webhookId: parsed.webhook_id || null,
          name: parsed.name,
          format: parsed.format || 'generic',
          url: parsed.url,
          secretEnv: parsed.secret_env || null,
          events: parsed.events || ['*'],
          enabled: parsed.enabled !== false,
        }, dispatchDeps.webhookDeps || {}),
      });
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/webhooks/delete') {
    const parsed = await readBoundedJson(req);
    try { sendJson(res, 200, deleteWebhook(db, parsed.webhook_id || parsed.id)); }
    catch (err) { sendJson(res, 404, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/webhooks/test') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, await deliverWebhook(db, parsed.webhook_id || parsed.id, {
        event_type: 'webhook.test',
        actor: 'collab-hub',
        payload: { message: 'CollabHub v3.0 webhook delivery test' },
      }, dispatchDeps.webhookDeps || {}));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }

  // ---- v3.0 Guided Setup Wizard ----
  if (req.method === 'GET' && url.pathname === '/api/setup/plan') {
    sendJson(res, 200, await planSetup(db, {
      profile: url.searchParams.get('profile') || 'cockpit',
      clientSpecs: dispatchDeps.mcpClientSpecs || null,
    }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/setup/apply') {
    const parsed = await readBoundedJson(req);
    if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
      sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
      return true;
    }
    if (parsed.install_claude_statusline !== undefined && typeof parsed.install_claude_statusline !== 'boolean') {
      sendJson(res, 400, { error: 'install_claude_statusline must be a strict boolean' });
      return true;
    }
    if (parsed.register_local_clis !== undefined && typeof parsed.register_local_clis !== 'boolean') {
      sendJson(res, 400, { error: 'register_local_clis must be a strict boolean' });
      return true;
    }
    try {
      sendJson(res, 200, await applySetup(db, {
        profile: parsed.profile || 'cockpit',
        clients: Array.isArray(parsed.clients) ? parsed.clients : null,
        installClaudeStatusLine: parsed.install_claude_statusline !== false,
        registerLocalClis: parsed.register_local_clis !== false,
        confirmed: parsed.confirmed === true,
        clientSpecs: dispatchDeps.mcpClientSpecs || null,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }

  // ---- v3.0 Live Cross-Agent Usage & Always-On Resident Autostart ----
  if (req.method === 'GET' && url.pathname === '/api/usage/live') {
    const includeOllama = url.searchParams.get('ollama') === '1';
    const includeLocalScan = url.searchParams.get('local') !== '0';
    sendJson(res, 200, await getLiveAgentUsageAsync(db, { includeLocalScan, includeOllama }));
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/autostart/status') {
    sendJson(res, 200, await getAutostartStatus());
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/autostart/install') {
    const parsed = await readBoundedJson(req);
    if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
      sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
      return true;
    }
    if (parsed.force !== undefined && typeof parsed.force !== 'boolean') {
      sendJson(res, 400, { error: 'force must be a strict boolean' });
      return true;
    }
    try {
      sendJson(res, 200, await installAutostart({
        confirmed: parsed.confirmed === true,
        force: parsed.force === true,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }

  // ---- v3.0 Model-Strength Smart Router & Cross-IDE Native Plugin Installer ----
  if (req.method === 'GET' && url.pathname === '/api/route/matrix') {
    const members = getMemberStatuses(db);
    const liveUsage = getLiveAgentUsage(db, { includeLocalScan: true });
    sendJson(res, 200, {
      categories: [...TASK_CATEGORIES],
      strategies: ['balanced', 'quality', 'cost', 'speed'],
      matrix: buildCapabilityMatrix(members, liveUsage),
    });
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/route/recommend') {
    try {
      const q = url.searchParams;
      sendJson(res, 200, planDispatch(db, {
        role: q.get('role') || 'researcher',
        prompt: q.get('prompt') || '',
        title: q.get('title') || '',
        taskCategory: q.get('category') || null,
        complexity: q.get('complexity') || null,
        strategy: q.get('strategy') || 'balanced',
        requireLocalFiles: q.get('local_files') === '1',
        requireLinux: q.get('linux') === '1',
        requireBackgroundAuto: q.get('bg') === '1',
        projectDir: q.get('project_dir') || null,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/route/recommend') {
    const parsed = await readBoundedJson(req);
    try {
      sendJson(res, 200, planDispatch(db, {
        role: parsed.role || 'researcher',
        prefer: Array.isArray(parsed.prefer) ? parsed.prefer : [],
        exclude: Array.isArray(parsed.exclude) ? parsed.exclude : [],
        prompt: parsed.prompt || '',
        title: parsed.title || '',
        taskCategory: parsed.task_category || null,
        complexity: parsed.complexity || null,
        strategy: parsed.strategy || 'balanced',
        requireLocalFiles: Boolean(parsed.require_local_files),
        requireLinux: Boolean(parsed.require_linux),
        requireBackgroundAuto: Boolean(parsed.require_background_auto),
        projectDir: typeof parsed.project_dir === 'string' && parsed.project_dir.trim() ? parsed.project_dir.trim() : null,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }
  if (req.method === 'GET' && url.pathname === '/api/plugins/plan') {
    const ides = url.searchParams.get('ides') ? url.searchParams.get('ides').split(',').map((s) => s.trim()).filter(Boolean) : null;
    sendJson(res, 200, planPluginInstall({ ides }));
    return true;
  }
  if (req.method === 'POST' && url.pathname === '/api/plugins/install') {
    const parsed = await readBoundedJson(req);
    if (parsed.confirmed !== undefined && typeof parsed.confirmed !== 'boolean') {
      sendJson(res, 400, { error: 'confirmed must be a strict boolean' });
      return true;
    }
    try {
      sendJson(res, 200, installNativePlugins({
        confirmed: parsed.confirmed === true,
        ides: Array.isArray(parsed.ides) ? parsed.ides : null,
      }));
    } catch (err) { sendJson(res, 400, { error: String(err.message || err) }); }
    return true;
  }

  return false;
}
