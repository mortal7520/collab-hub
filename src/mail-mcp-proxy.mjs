import readline from 'node:readline';
import { MAIL_BASE_URL } from './config.mjs';

const endpoint = `${MAIL_BASE_URL}/mcp/`;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;
let sessionId = null;

/**
 * Incremental SSE parser: aggregates multi-line `data:` fields until blank line delimiter.
 */
export function createSseParser(onEvent) {
  let buffer = '';
  let dataLines = [];

  const flushEvent = () => {
    if (dataLines.length > 0) {
      onEvent(dataLines.join('\n'));
      dataLines = [];
    }
  };

  return {
    push(chunk) {
      buffer += chunk;
      if (buffer.length > MAX_FRAME_BYTES) {
        throw new Error(`SSE buffer exceeded ${MAX_FRAME_BYTES} byte limit`);
      }
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (rawLine === '') {
          flushEvent();
        } else if (rawLine.startsWith('data:')) {
          dataLines.push(rawLine.slice(5).replace(/^ /, ''));
        }
      }
    },
    end() {
      if (buffer.length > 0) {
        const rawLine = buffer.replace(/\r$/, '');
        buffer = '';
        if (rawLine.startsWith('data:')) dataLines.push(rawLine.slice(5).replace(/^ /, ''));
      }
      flushEvent();
    },
  };
}

export function parseSseEvents(text) {
  const events = [];
  const parser = createSseParser((ev) => events.push(ev));
  parser.push(String(text || ''));
  parser.end();
  return events;
}

function writeJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

const activeControllers = new Set();

function startProxy() {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  const abortAll = () => {
    for (const ac of activeControllers) {
      try { ac.abort(); } catch {}
    }
    activeControllers.clear();
  };
  rl.on('close', abortAll);
  process.on('SIGINT', () => { abortAll(); process.exit(0); });
  process.on('SIGTERM', () => { abortAll(); process.exit(0); });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      writeJson({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }

    const hasId = Object.prototype.hasOwnProperty.call(msg, 'id') && msg.id !== undefined;
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) headers['mcp-session-id'] = sessionId;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 45000);
    activeControllers.add(controller);

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(msg),
        signal: controller.signal,
      });
      const nextSession = res.headers.get('mcp-session-id');
      if (nextSession) sessionId = nextSession;

      if (!hasId) {
        try { await res.body?.cancel(); } catch {}
        return;
      }

      const contentType = res.headers.get('content-type') || '';

      if (!res.ok) {
        const text = (await res.text()).slice(0, 300);
        writeJson({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32001, message: `mcp-agent-mail HTTP ${res.status}: ${text}` },
        });
        return;
      }

      if (contentType.includes('text/event-stream') && res.body) {
        let emitted = 0;
        const decoder = new TextDecoder();
        const parser = createSseParser((payload) => {
          try {
            const parsed = JSON.parse(payload);
            writeJson(parsed);
            emitted += 1;
          } catch { /* skip keepalive/non-JSON comment events */ }
        });
        const reader = res.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        parser.push(decoder.decode());
        parser.end();
        if (emitted === 0) {
          writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32002, message: 'mcp-agent-mail SSE stream contained no valid JSON-RPC payload' },
          });
        }
      } else {
        const text = await res.text();
        if (text.length > MAX_FRAME_BYTES) {
          writeJson({
            jsonrpc: '2.0',
            id: msg.id,
            error: { code: -32002, message: 'mcp-agent-mail response exceeded 4MB safety cap' },
          });
          return;
        }
        if (text.trim()) {
          try {
            writeJson(JSON.parse(text.trim()));
          } catch {
            writeJson({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32002, message: `mcp-agent-mail returned non-JSON body: ${text.slice(0, 160)}` },
            });
          }
        }
      }
    } catch (err) {
      if (hasId) {
        writeJson({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32000, message: `mcp-agent-mail proxy error (${endpoint}): ${err.message}` },
        });
      }
    } finally {
      clearTimeout(timer);
      activeControllers.delete(controller);
    }
  });
}

import path from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  startProxy();
}
