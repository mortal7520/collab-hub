/**
 * CollabHub v3.0 — Zero-Dependency Outbound Webhook Engine (`webhooks`)
 *
 * Pushes signed lifecycle notifications (`task.completed`, `task.failed`, `merge_queue.merged`,
 * `budget.exceeded`, `consensus.synthesized`, etc.) to Slack, Discord, Feishu, DingTalk,
 * Telegram, or any generic HTTPS/loopback receiver.
 *
 * Security invariants:
 * - Reuses `assertSafeRemoteUrl` (DNS-pinned SSRF guard blocking private/CGNAT/metadata IPs).
 * - Never stores plaintext signing secrets (`secret_env` must reference `*_SECRET|*_TOKEN|*_KEY`).
 * - Signs payloads with `X-CollabHub-Signature-256: sha256=<hmac>` using `node:crypto`.
 * - Sets `redirect: 'error'` and bounded 5s timeout.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { logEvent } from './db.mjs';
import { hubBus } from './event-bus.mjs';
import { assertSafeRemoteUrl, detectInlineSecret, pinnedHttpJsonPost } from './mcp-hub.mjs';

export const VALID_WEBHOOK_FORMATS = new Set(['generic', 'slack', 'discord', 'feishu', 'dingtalk', 'telegram']);
const SAFE_SECRET_ENV_RE = /^[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|KEY)$/;
const SUSPICIOUS_QUERY_KEY_RE = /^(?:token|api_?key|key|secret|sig|signature|auth|password|pass)$/i;

export function redactWebhookUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''));
    u.username = '';
    u.password = '';
    for (const k of [...u.searchParams.keys()]) {
      u.searchParams.set(k, SUSPICIOUS_QUERY_KEY_RE.test(k) ? 'REDACTED' : '...');
    }
    const segs = u.pathname.split('/').map((seg, idx, arr) => {
      if (!seg) return seg;
      const prev = arr[idx - 1] || '';
      if (['services', 'webhooks', 'hook', 'bot'].includes(prev) || idx === arr.length - 1 && seg.length >= 16) {
        return seg.length > 6 ? `${seg.slice(0, 4)}***REDACTED***` : '***REDACTED***';
      }
      if (/^bot\d+:/i.test(seg)) return 'bot***REDACTED***';
      return seg;
    });
    u.pathname = segs.join('/');
    return u.toString();
  } catch {
    return '***REDACTED***';
  }
}

function assertSafeWebhookUrlSyntax(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'https:') {
    throw new Error('Webhook SSRF guard: only https:// URLs are permitted.');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Webhook SSRF guard: embedded URL credentials (user:pass@) are forbidden.');
  }
  for (const k of parsed.searchParams.keys()) {
    if (SUSPICIOUS_QUERY_KEY_RE.test(k)) {
      throw new Error(`Webhook SSRF guard: secret query parameter "${k}" in URL is forbidden; use secret_env.`);
    }
  }
  return parsed;
}

async function validateWebhookUrl(rawUrl) {
  const parsed = assertSafeWebhookUrlSyntax(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0.0.0.0' || host.startsWith('127.')) {
    throw new Error(`Webhook SSRF guard: loopback/unspecified host "${host}" is blocked.`);
  }
  const checked = await assertSafeRemoteUrl(rawUrl);
  const pinned = String(checked?.pinnedAddress || '').toLowerCase();
  if (pinned === '::1' || pinned === '0.0.0.0' || pinned.startsWith('127.')) {
    throw new Error(`Webhook SSRF guard: resolved loopback IP "${pinned}" is blocked.`);
  }
  return checked;
}

function parseWebhookRow(row, { redactUrl = true } = {}) {
  if (!row) return null;
  let events = ['*'];
  try {
    const parsed = JSON.parse(row.events_json || '["*"]');
    if (Array.isArray(parsed) && parsed.length > 0) events = parsed.map(String);
  } catch {}
  return {
    webhook_id: row.webhook_id,
    name: row.name,
    format: row.format || 'generic',
    url: redactUrl ? redactWebhookUrl(row.url) : row.url,
    secret_env: row.secret_env || null,
    events,
    enabled: Boolean(row.enabled),
    last_status: row.last_status ?? null,
    last_error: row.last_error || null,
    last_sent_at: row.last_sent_at || null,
    delivery_count: Number(row.delivery_count || 0),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function saveWebhook(db, {
  webhookId = null,
  name,
  format = 'generic',
  url,
  secretEnv = null,
  events = ['*'],
  enabled = true,
} = {}, deps = {}) {
  const safeName = String(name || '').trim().slice(0, 80);
  if (!safeName) throw new Error('Webhook name is required');
  const safeFormat = String(format || 'generic').trim().toLowerCase();
  if (!VALID_WEBHOOK_FORMATS.has(safeFormat)) {
    throw new Error(`Invalid webhook format "${format}". Use: ${[...VALID_WEBHOOK_FORMATS].join(' | ')}`);
  }
  if (!url || typeof url !== 'string') throw new Error('Webhook url is required');
  assertSafeWebhookUrlSyntax(url);
  if (detectInlineSecret(url)) throw new Error('Webhook URL appears to contain an inline token; use secret_env instead.');
  await (deps.validateUrl || validateWebhookUrl)(url);

  let cleanEnv = null;
  if (secretEnv !== null && secretEnv !== undefined && String(secretEnv).trim()) {
    cleanEnv = String(secretEnv).trim();
    if (!SAFE_SECRET_ENV_RE.test(cleanEnv)) {
      throw new Error('secret_env must be an uppercase env variable ending in _SECRET, _TOKEN, or _KEY');
    }
  }

  const eventList = Array.isArray(events) && events.length > 0
    ? [...new Set(events.map((e) => String(e || '').trim().slice(0, 64)).filter(Boolean))].slice(0, 20)
    : ['*'];
  const id = webhookId
    ? String(webhookId).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48)
    : `whk_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  if (!id) throw new Error('Invalid webhook_id');
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO webhooks (webhook_id, name, format, url, secret_env, events_json, enabled, delivery_count, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    ON CONFLICT(webhook_id) DO UPDATE SET
      name = excluded.name,
      format = excluded.format,
      url = excluded.url,
      secret_env = excluded.secret_env,
      events_json = excluded.events_json,
      enabled = excluded.enabled,
      updated_at = excluded.updated_at
  `).run(id, safeName, safeFormat, url.trim(), cleanEnv, JSON.stringify(eventList), enabled ? 1 : 0, now, now);

  logEvent(db, { eventType: 'webhook.saved', actor: 'collab-hub', payload: { webhook_id: id, name: safeName, format: safeFormat } });
  return parseWebhookRow(db.prepare('SELECT * FROM webhooks WHERE webhook_id = ?').get(id));
}

export function listWebhooks(db) {
  try {
    return db.prepare('SELECT * FROM webhooks ORDER BY updated_at DESC, webhook_id ASC').all().map(parseWebhookRow);
  } catch {
    return [];
  }
}

export function deleteWebhook(db, webhookId) {
  const res = db.prepare('DELETE FROM webhooks WHERE webhook_id = ?').run(String(webhookId || ''));
  if (!res.changes) throw new Error(`Webhook not found: ${webhookId}`);
  return { deleted: true, webhook_id: String(webhookId) };
}

export function formatWebhookPayload(format, event) {
  const evType = String(event?.event_type || event?.type || 'hub.event');
  const actor = String(event?.actor || 'collab-hub');
  const taskId = event?.task_id ? ` [${event.task_id}]` : '';
  const rawPayload = event?.payload ?? {};
  const summary = typeof rawPayload === 'string'
    ? rawPayload.slice(0, 260)
    : JSON.stringify(rawPayload).slice(0, 260);
  const text = `[CollabHub] ${evType}${taskId} by ${actor}: ${summary}`;

  if (format === 'slack') {
    return { text, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*CollabHub* · \`${evType}\`${taskId}\n${summary}` } }] };
  }
  if (format === 'discord') {
    return { content: text, embeds: [{ title: `CollabHub · ${evType}${taskId}`, description: summary, color: 6187730 }] };
  }
  if (format === 'feishu') {
    return { msg_type: 'text', content: { text } };
  }
  if (format === 'dingtalk') {
    return { msgtype: 'text', text: { content: text } };
  }
  if (format === 'telegram') {
    return { text, disable_web_page_preview: true };
  }
  return {
    source: 'collab-hub',
    event_type: evType,
    task_id: event?.task_id || null,
    actor,
    timestamp: event?.created_at || new Date().toISOString(),
    payload: rawPayload,
  };
}

function eventMatches(subscribed, evType) {
  if (!Array.isArray(subscribed) || subscribed.length === 0) return false;
  if (subscribed.includes('*')) return true;
  return subscribed.some((pat) => (pat.endsWith('*') ? evType.startsWith(pat.slice(0, -1)) : evType === pat));
}

export async function deliverWebhook(db, webhookOrId, event, deps = {}) {
  const hook = typeof webhookOrId === 'string'
    ? parseWebhookRow(db.prepare('SELECT * FROM webhooks WHERE webhook_id = ?').get(webhookOrId), { redactUrl: false })
    : (webhookOrId?.webhook_id
      ? (parseWebhookRow(db.prepare('SELECT * FROM webhooks WHERE webhook_id = ?').get(webhookOrId.webhook_id), { redactUrl: false }) || webhookOrId)
      : webhookOrId);
  if (!hook) throw new Error(`Webhook not found: ${webhookOrId}`);

  const checked = await (deps.validateUrl || validateWebhookUrl)(hook.url);
  if (hook.secret_env && !process.env[hook.secret_env]) {
    throw new Error(`Webhook signing secret env "${hook.secret_env}" is not set; refusing unsigned delivery.`);
  }
  const bodyObj = formatWebhookPayload(hook.format, event);
  const bodyStr = JSON.stringify(bodyObj);
  const headers = { 'Content-Type': 'application/json', 'User-Agent': 'CollabHub-Webhook/3.0' };
  if (hook.secret_env && process.env[hook.secret_env]) {
    const sig = createHmac('sha256', process.env[hook.secret_env]).update(bodyStr, 'utf8').digest('hex');
    headers['X-CollabHub-Signature-256'] = `sha256=${sig}`;
  }

  const now = new Date().toISOString();
  const timeoutMs = Number(deps.timeoutMs) || 5000;
  let status = 0;
  let error = null;
  try {
    let res;
    if (deps.fetch) {
      res = await deps.fetch(hook.url, {
        method: 'POST',
        headers,
        body: bodyStr,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } else if (checked && checked.parsed) {
      res = await pinnedHttpJsonPost(checked, { headers, body: bodyStr, timeoutMs });
    } else {
      throw new Error('Webhook SSRF guard: missing validated DNS target');
    }
    status = res.status;
    if (!res.ok) error = `HTTP ${res.status}`;
  } catch (err) {
    error = String(err.message || err).slice(0, 200);
  }

  try {
    db.prepare(`
      UPDATE webhooks
      SET last_status = ?, last_error = ?, last_sent_at = ?, delivery_count = delivery_count + 1, updated_at = ?
      WHERE webhook_id = ?
    `).run(status || null, error, now, now, hook.webhook_id);
  } catch { /* ignore if db closed */ }

  return { ok: !error && status >= 200 && status < 300, webhook_id: hook.webhook_id, status, error };
}

export function startWebhookDispatcher(db, deps = {}) {
  let active = true;
  let inflight = 0;
  const MAX_INFLIGHT = 16;
  const onEvent = (evt) => {
    if (!active || !evt) return;
    const evType = String(evt.event_type || evt.type || '');
    if (!evType || evType.startsWith('webhook.')) return;
    const hooks = listWebhooks(db).filter((h) => h.enabled && eventMatches(h.events, evType));
    for (const hook of hooks) {
      if (inflight >= MAX_INFLIGHT) break;
      inflight += 1;
      Promise.resolve()
        .then(() => deliverWebhook(db, hook.webhook_id, evt, deps))
        .catch(() => {})
        .finally(() => { inflight = Math.max(0, inflight - 1); });
    }
  };
  hubBus.on('hub-event', onEvent);
  return {
    stop() {
      active = false;
      hubBus.off('hub-event', onEvent);
    },
  };
}
