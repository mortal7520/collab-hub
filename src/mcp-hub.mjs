/**
 * CollabHub v1.5.0 — All-Agent MCP Hub & Meta-MCP Lazy Tool Proxy
 *
 * Adapted & ported (zero npm runtime dependencies) from open-source upstream patterns:
 * - ravitemer/mcp-hub (MIT, v4.2.1 / 9c7670a4c341): centralized multi-client MCP registry,
 *   safe `${ENV_VAR}` placeholder resolution (hardened: no `${cmd:...}` shell execution).
 * - warpdev/mcp-hub-mcp (MIT, 060838ad7034): Meta-MCP lazy tool discovery (`findMcpTools`)
 *   and on-demand proxied tool execution (`callMcpServerTool`) preventing context-window bloat.
 * - samanhappy/mcphub (Apache-2.0, f2c0d9937f84): logical server grouping & unified gateway metadata.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { APP_VERSION } from './config.mjs';
import { logEvent } from './db.mjs';

const VALID_TRANSPORTS = new Set(['stdio', 'http', 'sse']);
const SAFE_SERVER_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_GROUP_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SHELL_META_RE = /[;&|`$<>()^\r\n\0]/;
const MAX_PROBE_RESPONSE_BYTES = 1024 * 1024;
const MAX_STORED_TOOLS = 80;

// Inline secret signature heuristics (strictly blocks accidental secret sync / persistence)
const INLINE_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-proj-[A-Za-z0-9_-]{20,}\b/,
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/,
  /\bghp_[A-Za-z0-9]{24,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/,
  /\bglpat-[A-Za-z0-9_-]{18,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{16,}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/i,
  /-----BEGIN\s+[A-Z ]*PRIVATE KEY-----/,
];

export function detectInlineSecret(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  if (/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value.trim())) return false;
  if (/^<SET_[A-Za-z0-9_-]+>$/.test(value.trim())) return false;
  return INLINE_SECRET_PATTERNS.some((re) => re.test(value));
}

export function assertValidMcpId(id) {
  if (typeof id !== 'string' || !SAFE_SERVER_ID.test(id.trim())) {
    throw new Error(`Invalid MCP server id "${id}": use 1-64 chars of [A-Za-z0-9._-]`);
  }
  return id.trim();
}

/**
 * Strip embedded userinfo (user:pass@) and query/fragment tokens from URLs so secrets never leak.
 */
export function stripUrlCredentials(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  try {
    const u = new URL(rawUrl.trim());
    u.username = '';
    u.password = '';
    u.search = '';
    u.hash = '';
    return u.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function isPrivateOrLinkLocalIp(ip) {
  if (!ip) return true;
  const clean = String(ip).trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (net.isIPv4(clean)) {
    const parts = clean.split('.').map(Number);
    if (parts[0] === 127) return true; // remote hostnames resolving to loopback are blocked (explicit loopback URLs bypass earlier)
    if (parts[0] === 10) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true; // RFC 6598 CGNAT / Tailscale
    if (parts[0] === 169 && parts[1] === 254) return true; // cloud metadata / link-local
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 0) return true;
    return false;
  }
  if (net.isIPv6(clean)) {
    if (clean === '::1') return true;
    // Unwrap IPv4-mapped IPv6 literals (both dotted ::ffff:169.254.169.254 and hex ::ffff:a9fe:a9fe)
    const v4Dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(clean);
    if (v4Dotted) return isPrivateOrLinkLocalIp(v4Dotted[1]);
    const v4Hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(clean);
    if (v4Hex) {
      const hi = parseInt(v4Hex[1], 16);
      const lo = parseInt(v4Hex[2], 16);
      return isPrivateOrLinkLocalIp(`${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`);
    }
    if (clean.startsWith('fe80:') || clean.startsWith('fc') || clean.startsWith('fd') || clean === '::') return true;
    return false;
  }
  return true;
}

/**
 * DNS-resolve-then-verify SSRF guard (fail-closed) for remote HTTP/SSE MCP probes & proxy calls.
 * Strips IPv6 brackets, checks IPv4-mapped IPv6 addresses, and fails closed on DNS errors.
 */
export async function assertSafeRemoteUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  const host = parsed.hostname.replace(/^\[|\]$/g, '');
  if (isLoopbackHost(host)) {
    const ipVer = net.isIP(host);
    return { parsed, host, pinnedAddress: ipVer ? host : null, pinnedFamily: ipVer || null };
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('Security rule: remote HTTP/SSE MCP servers must use https:// (plain http:// is allowed only on loopback).');
  }
  const ipVer = net.isIP(host);
  if (ipVer) {
    if (isPrivateOrLinkLocalIp(host)) {
      throw new Error(`SSRF guard: blocked private/link-local IP ${host}`);
    }
    return { parsed, host, pinnedAddress: host, pinnedFamily: ipVer };
  }
  let addrs;
  try {
    addrs = await dns.lookup(host, { all: true });
  } catch (err) {
    throw new Error(`SSRF guard: DNS resolution failed for ${host} (${err.code || err.message})`);
  }
  if (!Array.isArray(addrs) || addrs.length === 0) {
    throw new Error(`SSRF guard: ${host} did not resolve to any address`);
  }
  for (const a of addrs) {
    if (isPrivateOrLinkLocalIp(a.address)) {
      throw new Error(`SSRF guard: ${host} resolved to blocked private/link-local IP ${a.address}`);
    }
  }
  return { parsed, host, pinnedAddress: addrs[0].address, pinnedFamily: addrs[0].family || net.isIP(addrs[0].address) };
}

/**
 * Connection-time DNS-pinned HTTP/HTTPS JSON-RPC POST client.
 * Prevents DNS-rebinding TOCTOU by connecting directly to the exact IP validated by
 * `assertSafeRemoteUrl()` while preserving TLS SNI (`servername`) & certificate verification.
 */
function pinnedHttpJsonPost(target, { headers = {}, body = '', timeoutMs = 10000 } = {}) {
  const { parsed, host, pinnedAddress, pinnedFamily } = target;
  const isHttps = parsed.protocol === 'https:';
  const transport = isHttps ? https : http;
  const payload = Buffer.from(body, 'utf8');
  return new Promise((resolve, reject) => {
    const reqOpts = {
      protocol: parsed.protocol,
      hostname: host,
      port: parsed.port ? Number(parsed.port) : (isHttps ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers: {
        Host: parsed.host,
        'Content-Length': String(payload.length),
        ...headers,
      },
      timeout: timeoutMs,
      ...(isHttps ? { servername: net.isIP(host) ? undefined : host, rejectUnauthorized: true } : {}),
      ...(pinnedAddress ? {
        lookup: (_h, opts, cb) => {
          const callback = typeof opts === 'function' ? opts : cb;
          if (opts && typeof opts === 'object' && opts.all) {
            callback(null, [{ address: pinnedAddress, family: pinnedFamily || net.isIP(pinnedAddress) || 4 }]);
          } else {
            callback(null, pinnedAddress, pinnedFamily || net.isIP(pinnedAddress) || 4);
          }
        },
      } : {}),
    };
    const req = transport.request(reqOpts, (res) => {
      const status = Number(res.statusCode || 0);
      if (status >= 300 && status < 400) {
        res.resume();
        return reject(new Error(`SSRF guard: HTTP redirect (${status}) disallowed for MCP endpoint`));
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        if (total < MAX_PROBE_RESPONSE_BYTES) {
          const take = Math.min(chunk.length, MAX_PROBE_RESPONSE_BYTES - total);
          chunks.push(take === chunk.length ? chunk : chunk.subarray(0, take));
          total += take;
        }
      });
      res.on('end', () => {
        resolve({
          ok: status >= 200 && status < 300,
          status,
          headers: res.headers,
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error(`HTTP MCP timed out after ${timeoutMs}ms`)));
    req.on('error', reject);
    req.end(payload);
  });
}

function isAppOnlyTool(tool) {
  const vis = tool?._meta?.ui?.visibility;
  return Array.isArray(vis) && vis.length > 0 && !vis.includes('model');
}

/**
 * Safe `${ENV_VAR}` & predefined-variable placeholder resolver adapted from ravitemer/mcp-hub
 * `src/utils/env-resolver.js` (MIT). Explicitly refuses `${cmd:...}` shell interpolation for safety.
 */
export function resolveSafePlaceholders(value, { env = process.env, workspaceFolder = process.cwd() } = {}) {
  const predefined = {
    workspaceFolder,
    userHome: os.homedir(),
    pathSeparator: path.sep,
    cwd: workspaceFolder,
  };
  const resolveStr = (str) => {
    if (typeof str !== 'string' || !str.includes('${')) return str;
    return str.replace(/\$\{([^}]+)\}/g, (match, expr) => {
      const trimmed = String(expr || '').trim();
      if (/^cmd:/i.test(trimmed)) {
        throw new Error('Security rule: ${cmd:...} shell placeholders are disallowed in CollabHub MCP resolver.');
      }
      if (Object.prototype.hasOwnProperty.call(predefined, trimmed)) return predefined[trimmed];
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) && env[trimmed] !== undefined) return String(env[trimmed]);
      return match;
    });
  };
  if (typeof value === 'string') return resolveStr(value);
  if (Array.isArray(value)) return value.map((v) => resolveStr(v));
  return value;
}

/**
 * Validate MCP server registration strictly without storing any plaintext secrets.
 */
export function validateMcpServerSpec({
  id, name, transport, command = null, args = [], url = null,
  env_keys = [], header_keys = [], env = null, headers = null, tags = [], group_name = 'default',
}) {
  if (env && typeof env === 'object' && Object.keys(env).length > 0) {
    throw new Error('Security rule: never store plaintext env values in mcp_servers! Pass env_keys (variable names only).');
  }
  if (headers && typeof headers === 'object' && Object.keys(headers).length > 0) {
    throw new Error('Security rule: never store plaintext headers in mcp_servers! Pass header_keys (header names only).');
  }
  const safeId = assertValidMcpId(id);
  const safeName = String(name || safeId).trim().slice(0, 80) || safeId;
  const safeTransport = String(transport || '').trim().toLowerCase();
  if (!VALID_TRANSPORTS.has(safeTransport)) {
    throw new Error(`Unsupported MCP transport "${transport}". Allowed: stdio, http, sse`);
  }
  const safeGroup = SAFE_GROUP_RE.test(String(group_name || '').trim())
    ? String(group_name).trim().toLowerCase()
    : 'default';

  let safeCommand = null;
  let safeArgs = [];
  let safeUrl = null;

  if (safeTransport === 'stdio') {
    if (typeof command !== 'string' || !command.trim() || SHELL_META_RE.test(command)) {
      throw new Error('stdio MCP server requires a clean command path without shell metacharacters');
    }
    safeCommand = command.trim().slice(0, 260);
    if (!Array.isArray(args)) throw new Error('args must be an array of strings');
    safeArgs = args.slice(0, 24).map((a) => {
      const s = String(a);
      if (/[\0\r\n]/.test(s)) throw new Error('args must not contain null bytes or newlines');
      if (detectInlineSecret(s)) throw new Error('Security rule: inline secret detected in MCP args; use an env_keys reference instead.');
      return s.slice(0, 400);
    });
  } else {
    if (typeof url !== 'string' || !/^https?:\/\/.+/.test(url.trim())) {
      throw new Error(`${safeTransport} MCP server requires a valid http(s) url`);
    }
    let parsed;
    try { parsed = new URL(url.trim()); } catch {
      throw new Error(`Unparseable MCP url: ${url}`);
    }
    if (parsed.protocol !== 'https:' && !isLoopbackHost(parsed.hostname)) {
      throw new Error('Security rule: remote HTTP/SSE MCP servers must use https:// (plain http:// is allowed only on loopback).');
    }
    safeUrl = stripUrlCredentials(url.trim());
  }

  const safeEnvKeys = [...new Set(
    (Array.isArray(env_keys) ? env_keys : [])
      .map((k) => String(k).trim())
      .filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)),
  )].slice(0, 24);

  const safeHeaderKeys = [...new Set(
    (Array.isArray(header_keys) ? header_keys : [])
      .map((k) => String(k).trim())
      .filter((k) => /^[A-Za-z0-9-]{1,64}$/.test(k)),
  )].slice(0, 16);

  const safeTags = [...new Set(
    (Array.isArray(tags) ? tags : String(tags || '').split(','))
      .map((t) => String(t).trim().toLowerCase())
      .filter(Boolean)
      .map((t) => t.slice(0, 32)),
  )].slice(0, 12);

  return {
    id: safeId,
    name: safeName,
    transport: safeTransport,
    command: safeCommand,
    args: safeArgs,
    url: safeUrl,
    env_keys: safeEnvKeys,
    header_keys: safeHeaderKeys,
    tags: safeTags,
    group_name: safeGroup,
  };
}

/**
 * Default local AI client MCP configuration paths across Windows / macOS / Linux.
 */
export function getDefaultClientSpecs({ homedir = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const appData = env.APPDATA || path.join(homedir, 'AppData', 'Roaming');
  const macAppSupport = path.join(homedir, 'Library', 'Application Support');
  const xdgConfig = env.XDG_CONFIG_HOME || path.join(homedir, '.config');

  const claudeDesktopPath = platform === 'win32'
    ? path.join(appData, 'Claude', 'claude_desktop_config.json')
    : (platform === 'darwin'
      ? path.join(macAppSupport, 'Claude', 'claude_desktop_config.json')
      : path.join(xdgConfig, 'Claude', 'claude_desktop_config.json'));

  const vscodePath = platform === 'win32'
    ? path.join(appData, 'Code', 'User', 'mcp.json')
    : (platform === 'darwin'
      ? path.join(macAppSupport, 'Code', 'User', 'mcp.json')
      : path.join(xdgConfig, 'Code', 'User', 'mcp.json'));

  const agyPrimary = path.join(homedir, '.gemini', 'config', 'mcp_config.json');
  const agyLegacy = path.join(homedir, '.gemini', 'antigravity', 'mcp_config.json');

  return [
    { id: 'antigravity', name: 'Antigravity', format: 'json', rootKey: 'mcpServers', paths: [agyPrimary, agyLegacy] },
    { id: 'codex', name: 'Codex', format: 'toml', rootKey: 'mcp_servers', paths: [path.join(homedir, '.codex', 'config.toml')] },
    { id: 'claude-code', name: 'Claude Code', format: 'json', rootKey: 'mcpServers', paths: [path.join(homedir, '.claude.json')] },
    { id: 'claude-desktop', name: 'Claude Desktop', format: 'json', rootKey: 'mcpServers', paths: [claudeDesktopPath] },
    { id: 'gemini-cli', name: 'Gemini CLI', format: 'json', rootKey: 'mcpServers', paths: [path.join(homedir, '.gemini', 'settings.json')] },
    { id: 'cursor', name: 'Cursor', format: 'json', rootKey: 'mcpServers', paths: [path.join(homedir, '.cursor', 'mcp.json')] },
    { id: 'windsurf', name: 'Windsurf', format: 'json', rootKey: 'mcpServers', paths: [path.join(homedir, '.codeium', 'windsurf', 'mcp_config.json')] },
    { id: 'vscode', name: 'VS Code', format: 'json', rootKey: 'servers', paths: [vscodePath] },
  ];
}

function unquoteTomlString(raw) {
  const s = String(raw || '').trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    return s.startsWith('"')
      ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : inner;
  }
  return s;
}

function parseTomlStringArray(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('[') || !s.endsWith(']')) return [];
  const inner = s.slice(1, -1);
  const out = [];
  const re = /"((?:\\.|[^"\\])*)"|'([^']*)'/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\') : m[2]);
  }
  return out;
}

/**
 * Zero-dependency TOML parser specifically for `[mcp_servers.<name>]` & `[mcp_servers.<name>.env]` sections.
 * Never returns raw env/header values — only key names + `secret_inline` audit flag!
 */
export function parseCodexTomlMcpServers(tomlText) {
  const servers = new Map();
  let curId = null;
  let curSub = null;
  const lines = String(tomlText || '').split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      const header = sec[1].trim();
      const mcpMatch = /^mcp_servers\.("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))(?:\.(.+))?$/.exec(header);
      if (mcpMatch) {
        curId = mcpMatch[2] || mcpMatch[3] || mcpMatch[4];
        const sub = (mcpMatch[5] || '').trim().toLowerCase();
        curSub = sub ? (sub === 'env' ? 'env' : (sub.includes('header') ? 'headers' : 'other')) : null;
        if (!servers.has(curId)) {
          servers.set(curId, {
            id: curId, command: null, args: [], url: null, env_keys: [], header_keys: [], enabled: true, secret_inline: false,
          });
        }
      } else {
        curId = null;
        curSub = null;
      }
      continue;
    }
    if (!curId) continue;
    const kv = /^("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[2] || kv[3] || kv[4];
    const valRaw = kv[5].replace(/\s+#.*$/, '').trim();
    const rec = servers.get(curId);
    if (curSub === 'env') {
      if (!rec.env_keys.includes(key)) rec.env_keys.push(key);
      if (detectInlineSecret(unquoteTomlString(valRaw))) rec.secret_inline = true;
      continue;
    }
    if (curSub === 'headers') {
      if (!rec.header_keys.includes(key)) rec.header_keys.push(key);
      if (detectInlineSecret(unquoteTomlString(valRaw))) rec.secret_inline = true;
      continue;
    }
    if (curSub !== null) continue;
    if (key === 'command') rec.command = unquoteTomlString(valRaw);
    else if (key === 'args') {
      rec.args = parseTomlStringArray(valRaw);
      if (rec.args.some(detectInlineSecret)) rec.secret_inline = true;
    } else if (key === 'url' || key === 'serverUrl') {
      const rawU = unquoteTomlString(valRaw);
      if (detectInlineSecret(rawU)) rec.secret_inline = true;
      rec.url = stripUrlCredentials(rawU);
    } else if (key === 'enabled') rec.enabled = valRaw.toLowerCase() !== 'false';
    else if (key === 'disabled') rec.enabled = valRaw.toLowerCase() !== 'true';
    else if (key === 'env' && valRaw.startsWith('{')) {
      const keyRe = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
      let km;
      while ((km = keyRe.exec(valRaw)) !== null) {
        if (!rec.env_keys.includes(km[1])) rec.env_keys.push(km[1]);
        if (detectInlineSecret(km[3] || km[4] || '')) rec.secret_inline = true;
      }
    }
  }
  const result = {};
  for (const [id, rec] of servers.entries()) {
    const transport = rec.url ? (/\/sse\b/i.test(rec.url) ? 'sse' : 'http') : 'stdio';
    result[id] = {
      id,
      transport,
      command: rec.command,
      args: rec.args,
      url: rec.url,
      env_keys: rec.env_keys.sort(),
      header_keys: rec.header_keys.sort(),
      enabled: rec.enabled,
      secret_inline: rec.secret_inline,
    };
  }
  return result;
}

function parseJsonMcpServers(jsonText, preferredRootKey = 'mcpServers') {
  let parsed;
  try { parsed = JSON.parse(jsonText); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object') return {};
  const map = parsed[preferredRootKey] || parsed.mcpServers || parsed.servers || null;
  if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
  const out = {};
  for (const [id, cfg] of Object.entries(map)) {
    if (!cfg || typeof cfg !== 'object') continue;
    const rawUrl = cfg.serverUrl || cfg.url || null;
    const cleanUrl = rawUrl ? stripUrlCredentials(String(rawUrl)) : null;
    const rawType = String(cfg.type || cfg.transport || '').toLowerCase();
    const transport = cleanUrl
      ? (rawType === 'sse' || /\/sse\b/i.test(cleanUrl) ? 'sse' : 'http')
      : 'stdio';
    const envObj = cfg.env && typeof cfg.env === 'object' ? cfg.env : {};
    const headerObj = cfg.headers && typeof cfg.headers === 'object' ? cfg.headers : {};
    const envKeys = Object.keys(envObj).sort();
    const headerKeys = Object.keys(headerObj).sort();
    const args = Array.isArray(cfg.args) ? cfg.args.map(String) : [];
    const secretInline = Object.values(envObj).some((v) => detectInlineSecret(String(v)))
      || Object.values(headerObj).some((v) => detectInlineSecret(String(v)))
      || args.some(detectInlineSecret)
      || (rawUrl ? detectInlineSecret(String(rawUrl)) : false);
    out[id] = {
      id,
      transport,
      command: typeof cfg.command === 'string' ? cfg.command : null,
      args,
      url: cleanUrl,
      env_keys: envKeys,
      header_keys: headerKeys,
      enabled: cfg.disabled === true ? false : (cfg.enabled === false ? false : true),
      secret_inline: secretInline,
    };
  }
  return out;
}

/**
 * Scan all configured local AI clients for MCP server definitions (strictly zero-secret).
 */
export function scanLocalMcpClients({ clientSpecs = null } = {}) {
  const specs = clientSpecs || getDefaultClientSpecs();
  const clients = [];
  const discoveredByClient = new Map();

  for (const spec of specs) {
    const paths = Array.isArray(spec.paths) ? spec.paths : [spec.path].filter(Boolean);
    const foundPath = paths.find((p) => p && fs.existsSync(p)) || null;
    let serversMap = {};
    let parseError = null;
    if (foundPath) {
      try {
        const stat = fs.statSync(foundPath);
        if (stat.isFile() && stat.size <= 4 * 1024 * 1024) {
          const text = fs.readFileSync(foundPath, 'utf8');
          serversMap = spec.format === 'toml'
            ? parseCodexTomlMcpServers(text)
            : parseJsonMcpServers(text, spec.rootKey);
        }
      } catch (err) {
        parseError = String(err.message || err).slice(0, 200);
      }
    }
    discoveredByClient.set(spec.id, serversMap);
    clients.push({
      id: spec.id,
      name: spec.name,
      format: spec.format,
      root_key: spec.rootKey || 'mcpServers',
      exists: Boolean(foundPath),
      servers_count: Object.keys(serversMap).length,
      secret_inline_count: Object.values(serversMap).filter((s) => s.secret_inline).length,
      ...(parseError ? { error: parseError } : {}),
    });
  }
  return { clients, discoveredByClient, specs };
}

function parseServerRow(row) {
  if (!row) return null;
  let args = [];
  let envKeys = [];
  let headerKeys = [];
  let tags = [];
  let probeTools = [];
  try { args = JSON.parse(row.args_json || '[]'); } catch {}
  try { envKeys = JSON.parse(row.env_keys_json || '[]'); } catch {}
  try { headerKeys = JSON.parse(row.header_keys_json || '[]'); } catch {}
  try { tags = JSON.parse(row.tags_json || '[]'); } catch {}
  try { probeTools = JSON.parse(row.last_probe_tools_json || '[]'); } catch {}
  return {
    id: row.server_id,
    name: row.name,
    transport: row.transport,
    command: row.command || null,
    args,
    url: row.url || null,
    env_keys: envKeys,
    header_keys: headerKeys,
    tags,
    group_name: row.group_name || 'default',
    source: row.source || 'registered',
    enabled: Boolean(row.enabled),
    last_probe_ok: row.last_probe_ok === null || row.last_probe_ok === undefined ? null : Boolean(row.last_probe_ok),
    last_probe_tools_count: row.last_probe_tools_count ?? null,
    last_probe_tools: probeTools,
    last_probe_detail: row.last_probe_detail || null,
    last_probed_at: row.last_probed_at || null,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listRegisteredMcpServers(db) {
  return db.prepare('SELECT * FROM mcp_servers ORDER BY server_id ASC').all().map(parseServerRow);
}

export function registerMcpServer(db, spec, { source = 'registered' } = {}) {
  const clean = validateMcpServerSpec(spec);
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO mcp_servers (server_id, name, transport, command, args_json, url, env_keys_json, header_keys_json, tags_json, group_name, source, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      name = excluded.name,
      transport = excluded.transport,
      command = excluded.command,
      args_json = excluded.args_json,
      url = excluded.url,
      env_keys_json = excluded.env_keys_json,
      header_keys_json = excluded.header_keys_json,
      tags_json = excluded.tags_json,
      group_name = excluded.group_name,
      enabled = 1,
      updated_at = excluded.updated_at
  `).run(
    clean.id, clean.name, clean.transport, clean.command,
    JSON.stringify(clean.args), clean.url,
    JSON.stringify(clean.env_keys), JSON.stringify(clean.header_keys),
    JSON.stringify(clean.tags), clean.group_name, source, now, now,
  );
  const saved = parseServerRow(db.prepare('SELECT * FROM mcp_servers WHERE server_id = ?').get(clean.id));
  logEvent(db, { eventType: 'mcp.registered', actor: 'collab-hub', payload: { id: saved.id, transport: saved.transport, group: saved.group_name } });
  return saved;
}

export function removeMcpServer(db, id) {
  const safeId = assertValidMcpId(id);
  const res = db.prepare('DELETE FROM mcp_servers WHERE server_id = ?').run(safeId);
  if (!res.changes) throw new Error(`MCP server not found in registry: ${safeId}`);
  logEvent(db, { eventType: 'mcp.removed', actor: 'collab-hub', payload: { id: safeId } });
  return { removed: true, id: safeId };
}

function normalizeServerSignature(s) {
  if (!s) return '';
  if (s.transport === 'stdio') {
    const cmdBase = path.basename(String(s.command || '')).toLowerCase().replace(/\.exe$/i, '');
    const normArgs = (Array.isArray(s.args) ? s.args : []).map((a) => path.basename(String(a)).toLowerCase()).join('|');
    return createHash('sha1').update(`stdio:${cmdBase}:${normArgs}`).digest('hex').slice(0, 12);
  }
  return createHash('sha1').update(`${s.transport}:${String(stripUrlCredentials(s.url) || '').toLowerCase()}`).digest('hex').slice(0, 12);
}

/**
 * Build the unified All-Agent MCP Hub snapshot: canonical registry + discovered local clients + sync/drift matrix.
 */
export function buildMcpHubSnapshot(db, { clientSpecs = null } = {}) {
  const { clients, discoveredByClient } = scanLocalMcpClients({ clientSpecs });
  const registered = listRegisteredMcpServers(db);
  const byId = new Map();

  for (const r of registered) {
    byId.set(r.id, { ...r, registered: true, secret_inline: false, client_presence: {} });
  }

  for (const client of clients) {
    if (!client.exists) continue;
    const map = discoveredByClient.get(client.id) || {};
    for (const [id, srv] of Object.entries(map)) {
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: id,
          transport: srv.transport,
          command: srv.command,
          args: srv.args,
          url: srv.url,
          env_keys: srv.env_keys,
          header_keys: srv.header_keys,
          tags: [client.id],
          group_name: 'discovered',
          source: `discovered:${client.id}`,
          registered: false,
          enabled: srv.enabled,
          secret_inline: Boolean(srv.secret_inline),
          last_probe_ok: null,
          last_probe_tools_count: null,
          last_probe_tools: [],
          last_probe_detail: null,
          last_probed_at: null,
          client_presence: {},
        });
      } else if (srv.secret_inline) {
        byId.get(id).secret_inline = true;
      }
    }
  }

  const detectedClients = clients.filter((c) => c.exists);
  let syncedPairs = 0;
  let driftCount = 0;
  let cachedToolsTotal = 0;

  for (const entry of byId.values()) {
    const canonicalSig = normalizeServerSignature(entry);
    entry.canonical_hash = canonicalSig;
    if (Array.isArray(entry.last_probe_tools)) cachedToolsTotal += entry.last_probe_tools.length;
    for (const client of detectedClients) {
      const map = discoveredByClient.get(client.id) || {};
      const cliSrv = map[entry.id];
      if (!cliSrv) {
        entry.client_presence[client.id] = 'missing';
      } else {
        const cliSig = normalizeServerSignature(cliSrv);
        if (cliSig === canonicalSig) {
          entry.client_presence[client.id] = 'present';
          syncedPairs += 1;
        } else {
          entry.client_presence[client.id] = 'drifted';
          driftCount += 1;
        }
      }
    }
  }

  const servers = [...byId.values()].sort((a, b) => Number(b.registered) - Number(a.registered) || a.id.localeCompare(b.id));
  return {
    scanned_at: new Date().toISOString(),
    clients,
    servers,
    summary: {
      total_servers: servers.length,
      registered_count: registered.length,
      clients_detected: detectedClients.length,
      synced_pairs: syncedPairs,
      drift_count: driftCount,
      cached_tools_total: cachedToolsTotal,
    },
  };
}

export function getMcpHubSummary(db, { clientSpecs = null } = {}) {
  const snap = buildMcpHubSnapshot(db, { clientSpecs });
  return {
    servers_count: snap.summary.total_servers,
    registered_count: snap.summary.registered_count,
    clients_detected: snap.summary.clients_detected,
    synced_pairs: snap.summary.synced_pairs,
    drift_count: snap.summary.drift_count,
    cached_tools_total: snap.summary.cached_tools_total,
  };
}

/**
 * Safely import discovered local client MCP server definitions (strictly zero-secret) into CollabHub's canonical SQLite registry.
 */
export function importDiscoveredMcpServers(db, { clientId = null, clientSpecs = null } = {}) {
  const { clients, discoveredByClient } = scanLocalMcpClients({ clientSpecs });
  const targets = clientId
    ? clients.filter((c) => c.id === clientId && c.exists)
    : clients.filter((c) => c.exists);
  const imported = [];
  const skipped = [];

  for (const client of targets) {
    const map = discoveredByClient.get(client.id) || {};
    for (const [id, srv] of Object.entries(map)) {
      if (!SAFE_SERVER_ID.test(id)) {
        skipped.push({ id, client: client.id, reason: 'invalid_server_id' });
        continue;
      }
      try {
        const saved = registerMcpServer(db, {
          id,
          name: id,
          transport: srv.transport,
          command: srv.command,
          args: srv.args,
          url: srv.url,
          env_keys: srv.env_keys,
          header_keys: srv.header_keys,
          tags: [client.id],
          group_name: 'imported',
        }, { source: `imported:${client.id}` });
        imported.push(saved);
      } catch (err) {
        skipped.push({ id, client: client.id, reason: String(err.message || err).slice(0, 140) });
      }
    }
  }
  return { imported_count: imported.length, imported, skipped };
}

function parseSseOrJson(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch {}
  const dataLines = [];
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  if (dataLines.length > 0) {
    try { return JSON.parse(dataLines.join('\n')); } catch {}
  }
  return null;
}

/**
 * Shared JSON-RPC 2.0 MCP session helper (stdio / HTTP / SSE) used by both live probe and Meta-MCP proxy calls.
 */
async function executeMcpJsonRpc(clean, { method, params = {}, timeoutMs = 8000 } = {}) {
  if (clean.transport === 'stdio') {
    const resolvedCmd = resolveSafePlaceholders(clean.command);
    const resolvedArgs = resolveSafePlaceholders(clean.args);
    const childEnv = {
      PATH: process.env.PATH,
      SystemRoot: process.env.SystemRoot,
      USERPROFILE: process.env.USERPROFILE,
      HOME: process.env.HOME,
    };
    for (const k of clean.env_keys) {
      if (process.env[k] !== undefined) childEnv[k] = process.env[k];
    }
    return new Promise((resolve, reject) => {
      const child = spawn(resolvedCmd, resolvedArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: false,
        env: childEnv,
      });
      let settled = false;
      let stderr = '';
      let initRes = null;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { child.kill(); } catch {}
        fn(val);
      };
      const timer = setTimeout(() => finish(reject, new Error(`stdio MCP timed out after ${timeoutMs}ms`)), timeoutMs);
      child.on('error', (err) => finish(reject, err));
      child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-600); });
      const rl = readline.createInterface({ input: child.stdout });
      rl.on('line', (line) => {
        const t = line.trim();
        if (!t) return;
        let msg;
        try { msg = JSON.parse(t); } catch { return; }
        if (msg.id === 1) {
          if (msg.error) return finish(reject, new Error(msg.error.message || 'MCP initialize error'));
          initRes = msg.result || null;
          try {
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n');
            child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n');
          } catch (err) {
            finish(reject, err);
          }
        } else if (msg.id === 2) {
          if (msg.error) return finish(reject, new Error(msg.error.message || `MCP ${method} error`));
          finish(resolve, { initRes, result: msg.result || null });
        }
      });
      child.on('close', (code) => {
        if (!settled) finish(reject, new Error(`Exited ${code} before MCP ${method} completed${stderr ? `: ${stderr.slice(0, 160)}` : ''}`));
      });
      try {
        child.stdin.write(JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'collab-hub-mcp-gateway', version: APP_VERSION } },
        }) + '\n');
      } catch (err) {
        finish(reject, err);
      }
    });
  }

  // HTTP / Streamable-HTTP / SSE transport with connection-time DNS-pinned SSRF guard and redirects disabled
  const pinnedTarget = await assertSafeRemoteUrl(clean.url);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  const initHttp = await pinnedHttpJsonPost(pinnedTarget, {
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'collab-hub-mcp-gateway', version: APP_VERSION } },
    }),
    timeoutMs: Math.min(8000, timeoutMs),
  });
  const parsedInit = parseSseOrJson(initHttp.text);
  if (!initHttp.ok || !parsedInit?.result) {
    throw new Error(`HTTP ${initHttp.status} during MCP initialize`);
  }
  const sessionId = initHttp.headers['mcp-session-id'];
  const callHeaders = { ...headers, ...(sessionId ? { 'mcp-session-id': String(sessionId) } : {}) };
  const callHttp = await pinnedHttpJsonPost(pinnedTarget, {
    headers: callHeaders,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
    timeoutMs,
  });
  const parsedCall = parseSseOrJson(callHttp.text);
  if (!callHttp.ok || parsedCall?.error) {
    throw new Error(parsedCall?.error?.message || `HTTP ${callHttp.status} during MCP ${method}`);
  }
  return { initRes: parsedInit.result, result: parsedCall?.result || null };
}

/**
 * Live-probe an MCP server (`initialize` + `tools/list`) with strict timeouts, SSRF guard, and minimal env.
 */
export async function probeMcpServer(db, id, { clientSpecs = null, timeoutMs = 8000 } = {}) {
  const safeId = assertValidMcpId(id);
  const snap = buildMcpHubSnapshot(db, { clientSpecs });
  const server = snap.servers.find((s) => s.id === safeId);
  if (!server) throw new Error(`MCP server not found: ${safeId}`);

  const clean = validateMcpServerSpec({
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env_keys: server.env_keys,
    header_keys: server.header_keys,
    group_name: server.group_name,
  });

  const t0 = Date.now();
  let ok = false;
  let tools = [];
  let detail = '';
  let serverInfo = null;

  try {
    const res = await executeMcpJsonRpc(clean, { method: 'tools/list', params: {}, timeoutMs });
    const rawTools = Array.isArray(res.result?.tools) ? res.result.tools : [];
    ok = true;
    serverInfo = res.initRes?.serverInfo || null;
    tools = rawTools.slice(0, MAX_STORED_TOOLS).map((t) => {
      const uiUri = t._meta?.ui?.resourceUri || t._meta?.['ui/resourceUri'] || null;
      const rawVis = Array.isArray(t._meta?.ui?.visibility)
        ? t._meta.ui.visibility.filter((v) => v === 'model' || v === 'app')
        : null;
      const uiMeta = {};
      if (typeof uiUri === 'string' && uiUri.startsWith('ui://')) uiMeta.resourceUri = uiUri.slice(0, 160);
      if (rawVis && rawVis.length > 0) uiMeta.visibility = [...new Set(rawVis)];
      return {
        name: String(t.name || '').slice(0, 80),
        description: String(t.description || '').slice(0, 180),
        inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? {
          required: Array.isArray(t.inputSchema.required) ? t.inputSchema.required.slice(0, 12) : [],
          properties: t.inputSchema.properties && typeof t.inputSchema.properties === 'object'
            ? Object.keys(t.inputSchema.properties).slice(0, 20)
            : [],
        } : null,
        ...(Object.keys(uiMeta).length > 0 ? { _meta: { ui: uiMeta } } : {}),
      };
    });
    detail = `${clean.transport.toUpperCase()} MCP ready (${serverInfo?.name || clean.id}${serverInfo?.version ? ' v' + serverInfo.version : ''}) · ${rawTools.length} tool(s)`;
  } catch (err) {
    ok = false;
    detail = `${clean.transport.toUpperCase()} probe failed: ${String(err.message || err).slice(0, 240)}`;
  }

  const now = new Date().toISOString();
  const durationMs = Date.now() - t0;
  if (server.registered) {
    db.prepare(`
      UPDATE mcp_servers
      SET last_probe_ok = ?, last_probe_tools_count = ?, last_probe_tools_json = ?, last_probe_detail = ?, last_probed_at = ?, updated_at = ?
      WHERE server_id = ?
    `).run(ok ? 1 : 0, tools.length, JSON.stringify(tools), detail, now, now, safeId);
  }
  logEvent(db, { eventType: 'mcp.probed', actor: 'collab-hub', payload: { id: safeId, ok, tools_count: tools.length, duration_ms: durationMs } });
  return {
    id: safeId,
    ok,
    transport: clean.transport,
    server_info: serverInfo,
    tools_count: tools.length,
    tools,
    detail,
    duration_ms: durationMs,
    probed_at: now,
  };
}

/**
 * Meta-MCP Lazy Tool Discovery (adapted from warpdev/mcp-hub-mcp `find-tools`).
 * Searches cached tool catalogs across all registered MCP servers by keyword/substring without
 * loading all tool schemas into every agent's context window!
 */
export function findMcpTools(db, { query = '', serverId = null, searchIn = 'both', limit = 30, includeAppOnly = false } = {}) {
  const servers = listRegisteredMcpServers(db).filter((s) => s.enabled && (!serverId || s.id === serverId));
  const needle = String(query || '').trim().toLowerCase();
  const maxItems = Math.max(1, Math.min(100, Number(limit) || 30));
  const matches = [];
  let totalIndexedTools = 0;

  for (const srv of servers) {
    const tools = Array.isArray(srv.last_probe_tools) ? srv.last_probe_tools : [];
    for (const tool of tools) {
      if (!includeAppOnly && isAppOnlyTool(tool)) continue;
      totalIndexedTools += 1;
      const name = String(tool.name || '');
      const desc = String(tool.description || '');
      let hit = !needle;
      if (!hit) {
        if (searchIn === 'name') hit = name.toLowerCase().includes(needle);
        else if (searchIn === 'description') hit = desc.toLowerCase().includes(needle);
        else hit = name.toLowerCase().includes(needle) || desc.toLowerCase().includes(needle) || srv.id.toLowerCase().includes(needle);
      }
      if (hit) {
        matches.push({
          server_id: srv.id,
          server_name: srv.name,
          group_name: srv.group_name,
          transport: srv.transport,
          tool_name: name,
          description: desc,
          input_hint: tool.inputSchema || null,
          ...(tool._meta ? { _meta: tool._meta } : {}),
        });
      }
    }
  }

  return {
    query: String(query || ''),
    servers_indexed: servers.filter((s) => (s.last_probe_tools || []).length > 0).length,
    total_indexed_tools: totalIndexedTools,
    matched_count: matches.length,
    matches: matches.slice(0, maxItems),
  };
}

/**
 * Meta-MCP On-Demand Tool Proxy (adapted from warpdev/mcp-hub-mcp `call-tool`).
 * Calls a single tool on any registered/discovered MCP server lazily via JSON-RPC 2.0.
 * Enforces SEP-1865 `visibility: ["app"]` boundaries so model callers cannot invoke app-only tools.
 */
export async function callMcpServerTool(db, {
  serverId, toolName, toolArgs = {}, clientSpecs = null, timeoutMs = 15000, callerRole = 'model',
} = {}) {
  const safeId = assertValidMcpId(serverId);
  if (typeof toolName !== 'string' || !/^[A-Za-z0-9._:/-]{1,128}$/.test(toolName.trim())) {
    throw new Error(`Invalid tool_name "${toolName}"`);
  }
  const safeTool = toolName.trim();
  const snap = buildMcpHubSnapshot(db, { clientSpecs });
  const server = snap.servers.find((s) => s.id === safeId);
  if (!server) throw new Error(`MCP server not found: ${safeId}`);
  if (!server.enabled) throw new Error(`MCP server "${safeId}" is disabled`);

  const clean = validateMcpServerSpec({
    id: server.id,
    name: server.name,
    transport: server.transport,
    command: server.command,
    args: server.args,
    url: server.url,
    env_keys: server.env_keys,
    header_keys: server.header_keys,
    group_name: server.group_name,
  });

  // Enforce SEP-1865 app-only visibility fail-closed: check cached catalog first, and on cache miss live-probe tools/list!
  if (callerRole !== 'app') {
    let toolMeta = (Array.isArray(server.last_probe_tools) ? server.last_probe_tools : [])
      .find((t) => t.name === safeTool) || null;
    if (!toolMeta) {
      const listRes = await executeMcpJsonRpc(clean, {
        method: 'tools/list',
        params: {},
        timeoutMs: Math.min(8000, Math.max(2000, Number(timeoutMs) || 8000)),
      });
      const liveTools = Array.isArray(listRes.result?.tools) ? listRes.result.tools : [];
      toolMeta = liveTools.find((t) => t.name === safeTool) || null;
      if (!toolMeta) {
        throw new Error(`TOOL_NOT_FOUND: tool "${safeTool}" is not advertised by MCP server "${safeId}".`);
      }
    }
    if (isAppOnlyTool(toolMeta)) {
      throw new Error(`APP_ONLY_TOOL_FORBIDDEN: tool "${safeTool}" on server "${safeId}" is restricted to MCP App UI callers (visibility: ["app"]).`);
    }
  }

  const t0 = Date.now();
  const argsObj = toolArgs && typeof toolArgs === 'object' && !Array.isArray(toolArgs) ? toolArgs : {};
  const res = await executeMcpJsonRpc(clean, {
    method: 'tools/call',
    params: { name: safeTool, arguments: argsObj },
    timeoutMs: Math.max(2000, Math.min(30000, Number(timeoutMs) || 15000)),
  });
  const durationMs = Date.now() - t0;
  logEvent(db, {
    eventType: 'mcp.proxy_called',
    actor: 'collab-hub',
    payload: { server_id: safeId, tool_name: safeTool, duration_ms: durationMs, is_error: Boolean(res.result?.isError) },
  });
  return {
    server_id: safeId,
    tool_name: safeTool,
    duration_ms: durationMs,
    is_error: Boolean(res.result?.isError),
    result: res.result,
  };
}

/**
 * Generate a safe, zero-secret copyable JSON or TOML configuration snippet for any supported AI client.
 */
export function generateClientSnippet(db, { clientId = 'antigravity', serverIds = null, clientSpecs = null } = {}) {
  const snap = buildMcpHubSnapshot(db, { clientSpecs });
  const client = snap.clients.find((c) => c.id === clientId) || { id: clientId, name: clientId, format: clientId === 'codex' ? 'toml' : 'json' };
  const idSet = Array.isArray(serverIds) && serverIds.length > 0 ? new Set(serverIds) : null;
  const targets = snap.servers.filter((s) => s.enabled && (!idSet || idSet.has(s.id)));

  if (client.format === 'toml' || clientId === 'codex') {
    const blocks = targets.map((s) => formatTomlServerBlock(s));
    return {
      client_id: client.id,
      format: 'toml',
      server_count: targets.length,
      snippet: blocks.join('\n\n') || '# No MCP servers registered yet.',
    };
  }

  const rootKey = clientId === 'vscode' ? 'servers' : 'mcpServers';
  const obj = { [rootKey]: {} };
  for (const s of targets) {
    obj[rootKey][s.id] = buildJsonServerEntry(s, clientId);
  }
  return {
    client_id: client.id,
    format: 'json',
    server_count: targets.length,
    snippet: JSON.stringify(obj, null, 2),
  };
}

function buildJsonServerEntry(s, clientId) {
  if (s.transport === 'stdio') {
    const entry = { command: s.command || '', args: s.args || [] };
    if (s.env_keys?.length) {
      entry.env = Object.fromEntries(s.env_keys.map((k) => [k, `\${${k}}`]));
    }
    return entry;
  }
  const entry = clientId === 'antigravity'
    ? { serverUrl: s.url }
    : { url: s.url, type: s.transport };
  if (s.header_keys?.length) {
    entry.headers = Object.fromEntries(s.header_keys.map((k) => [k, `\${${k.toUpperCase().replace(/[^A-Z0-9_]/g, '_')}}`]));
  }
  return entry;
}

function formatTomlServerBlock(s) {
  const safeKey = /^[A-Za-z0-9_-]+$/.test(s.id) ? s.id : JSON.stringify(s.id);
  const lines = [`[mcp_servers.${safeKey}]`];
  if (s.transport === 'stdio') {
    lines.push(`command = ${JSON.stringify(s.command || '')}`);
    if (s.args?.length) lines.push(`args = [${s.args.map((a) => JSON.stringify(a)).join(', ')}]`);
  } else {
    lines.push(`url = ${JSON.stringify(s.url || '')}`);
  }
  if (s.env_keys?.length) {
    lines.push(`[mcp_servers.${safeKey}.env]`);
    for (const k of s.env_keys) lines.push(`${k} = ${JSON.stringify(`\${${k}}`)}`);
  }
  return lines.join('\n');
}

function buildUnifiedLineDiff(beforeText, afterText, label) {
  const a = String(beforeText || '').split(/\r?\n/);
  const b = String(afterText || '').split(/\r?\n/);
  const out = [`--- ${label} (current)`, `+++ ${label} (proposed)`];
  const maxLen = Math.max(a.length, b.length);
  let changes = 0;
  for (let i = 0; i < maxLen; i += 1) {
    if (a[i] === b[i]) continue;
    changes += 1;
    if (a[i] !== undefined) out.push(`- ${a[i]}`);
    if (b[i] !== undefined) out.push(`+ ${b[i]}`);
    if (out.length > 140) {
      out.push('... [diff preview truncated]');
      break;
    }
  }
  if (changes === 0) out.push('  (no textual changes)');
  return { diff: out.join('\n'), changed_lines: changes };
}

/**
 * Strip existing `[mcp_servers.<id>]` and `[mcp_servers.<id>.*]` sections from a TOML file
 * while preserving all unrelated comments and sections intact.
 */
function upsertTomlMcpServers(existingText, serversToWrite) {
  const idSet = new Set(serversToWrite.map((s) => s.id));
  const lines = String(existingText || '').split(/\r?\n/);
  const kept = [];
  let skipping = false;
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    const sec = /^\[([^\]]+)\]$/.exec(trimmed);
    if (sec) {
      const header = sec[1].trim();
      const mcpMatch = /^mcp_servers\.("([^"]+)"|'([^']+)'|([A-Za-z0-9._-]+))(?:\.(.+))?$/.exec(header);
      if (mcpMatch) {
        const id = mcpMatch[2] || mcpMatch[3] || mcpMatch[4];
        skipping = idSet.has(id);
      } else {
        skipping = false;
      }
    }
    if (!skipping) kept.push(rawLine);
  }
  const base = kept.join('\n').replace(/\s+$/, '');
  const appended = serversToWrite.map(formatTomlServerBlock).join('\n\n');
  return (base ? `${base}\n\n` : '') + appended + '\n';
}

/**
 * Dry-Run & Confirmed Safe Config Sync for a target local AI client.
 * - Strictly refuses writing any server flagged with `secret_inline` or containing inline secret tokens.
 * - Default (`confirmed: false`) is a pure read-only Dry-Run returning diff preview + backup plan.
 * - `confirmed: true` writes a timestamped `.bak.<ts>` backup first, then atomically replaces the target file.
 */
export function syncMcpToClient(db, {
  clientId, serverIds = null, confirmed = false, clientSpecs = null,
} = {}) {
  const { clients, discoveredByClient, specs } = scanLocalMcpClients({ clientSpecs });
  const spec = specs.find((s) => s.id === clientId);
  const clientInfo = clients.find((c) => c.id === clientId);
  if (!spec || !clientInfo) throw new Error(`Unknown MCP client: ${clientId}`);

  const paths = Array.isArray(spec.paths) ? spec.paths : [spec.path].filter(Boolean);
  const targetPath = paths.find((p) => p && fs.existsSync(p)) || paths[0];
  if (!targetPath) throw new Error(`No config path configured for client: ${clientId}`);

  const snap = buildMcpHubSnapshot(db, { clientSpecs });
  const idSet = Array.isArray(serverIds) && serverIds.length > 0 ? new Set(serverIds) : null;
  const candidates = snap.servers.filter((s) => s.enabled && (idSet ? idSet.has(s.id) : s.registered));

  const blockedSecrets = [];
  const toSync = [];
  for (const s of candidates) {
    if (s.secret_inline || (s.args || []).some(detectInlineSecret) || detectInlineSecret(s.url || '')) {
      blockedSecrets.push({ id: s.id, reason: 'secret_inline_detected' });
      continue;
    }
    toSync.push(s);
  }

  const existingMap = discoveredByClient.get(clientId) || {};
  const added = [];
  const updated = [];
  const unchanged = [];
  for (const s of toSync) {
    const cur = existingMap[s.id];
    if (!cur) added.push(s.id);
    else if (normalizeServerSignature(cur) !== normalizeServerSignature(s)) updated.push(s.id);
    else unchanged.push(s.id);
  }

  const existed = fs.existsSync(targetPath);
  const beforeText = existed ? fs.readFileSync(targetPath, 'utf8') : '';
  let afterText = beforeText;

  if (spec.format === 'toml') {
    afterText = toSync.length ? upsertTomlMcpServers(beforeText, toSync) : beforeText;
  } else {
    let parsed = {};
    if (beforeText.trim()) {
      try { parsed = JSON.parse(beforeText); } catch (err) {
        throw new Error(`Target JSON config is invalid and cannot be safely merged: ${err.message}`);
      }
    }
    const rootKey = spec.rootKey || 'mcpServers';
    if (!parsed[rootKey] || typeof parsed[rootKey] !== 'object' || Array.isArray(parsed[rootKey])) {
      parsed[rootKey] = {};
    }
    for (const s of toSync) {
      // Preserve existing env/header keys if user already had values in local config without exposing them!
      const nextEntry = buildJsonServerEntry(s, clientId);
      const prevEntry = parsed[rootKey][s.id];
      if (prevEntry && typeof prevEntry === 'object') {
        if (prevEntry.env && typeof prevEntry.env === 'object') nextEntry.env = { ...(nextEntry.env || {}), ...prevEntry.env };
        if (prevEntry.headers && typeof prevEntry.headers === 'object') nextEntry.headers = { ...(nextEntry.headers || {}), ...prevEntry.headers };
      }
      parsed[rootKey][s.id] = nextEntry;
    }
    afterText = JSON.stringify(parsed, null, 2) + '\n';
  }

  // Redact any pre-existing secret values from diff preview so secrets NEVER appear in API/UI output
  const redactPreview = (txt) => String(txt || '').replace(
    /("(?:api[_-]?key|token|secret|authorization|password|bearer|cookie)"\s*:\s*")([^"]+)(")/gi,
    '$1<REDACTED>$3',
  );
  const { diff, changed_lines } = buildUnifiedLineDiff(redactPreview(beforeText), redactPreview(afterText), path.basename(targetPath));
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${targetPath}.bak.${ts}`;

  if (confirmed !== true) {
    return {
      mode: 'dry_run',
      applied: false,
      client_id: clientId,
      client_name: spec.name,
      format: spec.format,
      target_exists: existed,
      target_basename: path.basename(targetPath),
      backup_basename: path.basename(backupPath),
      added,
      updated,
      unchanged,
      blocked_secrets: blockedSecrets,
      changed_lines,
      diff_preview: diff,
    };
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (existed) {
    fs.copyFileSync(targetPath, backupPath);
  }
  const tmpPath = `${targetPath}.collabhub-tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, afterText, 'utf8');
  fs.renameSync(tmpPath, targetPath);

  logEvent(db, {
    eventType: 'mcp.client_synced',
    actor: 'collab-hub',
    payload: { client_id: clientId, added: added.length, updated: updated.length, blocked: blockedSecrets.length },
  });

  return {
    mode: 'applied',
    applied: true,
    client_id: clientId,
    client_name: spec.name,
    format: spec.format,
    target_basename: path.basename(targetPath),
    backup_created: existed,
    backup_basename: existed ? path.basename(backupPath) : null,
    added,
    updated,
    unchanged,
    blocked_secrets: blockedSecrets,
    changed_lines,
    diff_preview: diff,
  };
}
