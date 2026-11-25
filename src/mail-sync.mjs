import { createHash } from 'node:crypto';
import { MAIL_BASE_URL, WORKSPACE_ROOT } from './config.mjs';

const MAIL_ENDPOINT = `${MAIL_BASE_URL}/mcp/`;
const DEFAULT_TIMEOUT_MS = 3500;

let cachedSessionId = null;

async function mailRpc(method, params, { timeoutMs = DEFAULT_TIMEOUT_MS, endpoint = MAIL_ENDPOINT } = {}) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (cachedSessionId) headers['mcp-session-id'] = cachedSessionId;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: `ch_${Date.now()}`, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const sid = res.headers.get('mcp-session-id');
  if (sid) cachedSessionId = sid;
  if (!res.ok) throw new Error(`mail HTTP ${res.status}`);

  const text = await res.text();
  const parsed = JSON.parse(text.trim());
  if (parsed.error) throw new Error(parsed.error.message || JSON.stringify(parsed.error));
  return parsed.result;
}

async function callMailTool(name, args, opts = {}) {
  const res = await mailRpc('tools/call', { name, arguments: args }, opts);
  if (res?.isError) {
    const msg = (res.content || []).map((c) => c.text || '').join(' ');
    throw new Error(msg || `mail tool ${name} failed`);
  }
  if (res?.structuredContent) return res.structuredContent;
  for (const item of res?.content || []) {
    if (item.type === 'text' && item.text) {
      try { return JSON.parse(item.text); } catch { /* plain text */ }
    }
  }
  return res;
}

// Valid Adjective+Noun names compatible with mcp_agent_mail_rust's strict naming rules
const DEFAULT_MAIL_NAMES = Object.freeze({
  agy: 'BlueFalcon',
  codex: 'GreenCastle',
  claude: 'AmberOwl',
  dsh: 'SilverWolf',
  muse: 'CoralCrane',
});

const CUSTOM_ADJECTIVES = ['Azure', 'Cobalt', 'Jade', 'Ivory', 'Crimson', 'Golden', 'Onyx', 'Slate', 'Copper', 'Indigo', 'Emerald', 'Scarlet', 'Topaz', 'Opal', 'Cedar', 'Frost'];
const CUSTOM_NOUNS = ['Heron', 'Lynx', 'Otter', 'Hawk', 'Fox', 'Raven', 'Bison', 'Eagle', 'Viper', 'Finch', 'Moose', 'Stag', 'Wren', 'Puma', 'Badger', 'Drake'];

export function mailNameForMember(member) {
  if (DEFAULT_MAIL_NAMES[member]) return DEFAULT_MAIL_NAMES[member];
  const digest = createHash('sha256').update(String(member || 'custom')).digest();
  return CUSTOM_ADJECTIVES[digest[0] % CUSTOM_ADJECTIVES.length] + CUSTOM_NOUNS[digest[1] % CUSTOM_NOUNS.length];
}

const resolvedAgentCache = new Map();

/**
 * Best-effort ensure project + agent registration in mcp-agent-mail (:5291).
 * Uses deterministic valid Adjective+Noun names (unique per custom agent) and falls back to server auto-generated name if needed.
 */
export async function ensureMailIdentity({ projectDir, member }, opts = {}) {
  try {
    const projectKey = String(projectDir || WORKSPACE_ROOT).replaceAll('\\', '/');
    const cacheKey = `${projectKey}::${member}`;
    if (resolvedAgentCache.has(cacheKey)) {
      const cached = resolvedAgentCache.get(cacheKey);
      return { synced: true, project_key: cached.project_key, agent_name: cached.agent_name };
    }
    const projRes = await callMailTool('ensure_project', { human_key: projectKey }, opts);
    const slugKey = projRes?.slug || projRes?.human_key || projectKey;
    const preferred = mailNameForMember(member);
    let actualName = preferred;
    try {
      const reg = await callMailTool('register_agent', {
        project_key: slugKey,
        program: 'collab-hub',
        model: member,
        name: preferred,
        task_description: `CollabHub ${member} participant`,
      }, opts);
      actualName = reg?.name || preferred;
    } catch {
      const reg2 = await callMailTool('register_agent', {
        project_key: slugKey,
        program: 'collab-hub',
        model: member,
        task_description: `CollabHub ${member} participant`,
      }, opts);
      actualName = reg2?.name || preferred;
    }
    resolvedAgentCache.set(cacheKey, { project_key: slugKey, agent_name: actualName });
    return { synced: true, project_key: slugKey, agent_name: actualName };
  } catch (err) {
    return { synced: false, reason: err.message };
  }
}

/**
 * Best-effort advisory file reservation in mcp-agent-mail when creating a worktree or dispatching file-scoped work.
 */
export async function reserveMailPaths({ projectDir, member, paths = [], reason = '', ttlSeconds = 3600 }, opts = {}) {
  if (!Array.isArray(paths) || paths.length === 0) return { synced: false, reason: 'no_paths' };
  const ident = await ensureMailIdentity({ projectDir, member }, opts);
  if (!ident.synced) return ident;
  try {
    const result = await callMailTool('file_reservation_paths', {
      project_key: ident.project_key,
      agent_name: ident.agent_name,
      paths,
      ttl_seconds: Math.max(60, Math.min(86400, Number(ttlSeconds) || 3600)),
      exclusive: true,
      reason: String(reason || `CollabHub ${member} task`).slice(0, 240),
    }, opts);
    const conflicts = result?.conflicts || result?.data?.conflicts || [];
    return {
      synced: true,
      project_key: ident.project_key,
      agent_name: ident.agent_name,
      granted: result?.granted || result?.reservations || [],
      conflicts,
      has_conflicts: Array.isArray(conflicts) && conflicts.length > 0,
    };
  } catch (err) {
    return { synced: false, reason: err.message };
  }
}

/**
 * Best-effort release of advisory file reservations when a worktree is merged or cleaned up.
 */
export async function releaseMailPaths({ projectDir, member, paths = [] }, opts = {}) {
  const ident = await ensureMailIdentity({ projectDir, member }, opts);
  if (!ident.synced) return ident;
  try {
    const args = { project_key: ident.project_key, agent_name: ident.agent_name };
    if (Array.isArray(paths) && paths.length > 0) args.paths = paths;
    const result = await callMailTool('release_file_reservations', args, opts);
    return { synced: true, released: result };
  } catch (err) {
    return { synced: false, reason: err.message };
  }
}

/**
 * Best-effort cross-agent mail thread summary post (links CollabHub task/batch with :5291/mail inbox).
 */
export async function postMailUpdate({ projectDir, fromMember, toMembers = [], threadId = null, subject, bodyMd }, opts = {}) {
  const ident = await ensureMailIdentity({ projectDir, member: fromMember }, opts);
  if (!ident.synced) return ident;
  const targets = toMembers.length ? toMembers : ['agy', 'codex'];
  const recipients = [];
  for (const m of targets) {
    const r = await ensureMailIdentity({ projectDir, member: m }, opts);
    if (r.synced) recipients.push(r.agent_name);
  }
  if (!recipients.length) return { synced: false, reason: 'no_valid_recipients' };
  try {
    const args = {
      project_key: ident.project_key,
      sender_name: ident.agent_name,
      to: [...new Set(recipients)],
      subject: String(subject || 'CollabHub update').slice(0, 180),
      body_md: String(bodyMd || '').slice(0, 16000),
    };
    if (threadId) args.thread_id = String(threadId);
    const result = await callMailTool('send_message', args, opts);
    const msgId = result?.deliveries?.[0]?.payload?.id
      || result?.message?.id
      || result?.id
      || null;
    return { synced: true, message_id: msgId !== null ? String(msgId) : null, thread_id: threadId };
  } catch (err) {
    return { synced: false, reason: err.message };
  }
}
