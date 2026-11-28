// CollabHub v3.0 — MV3 Loopback-Only Background Bridge (Zero Cookies, Read-Only GET)
'use strict';

const DEFAULT_ORIGIN = 'http://127.0.0.1:5290';

async function fetchLoopbackJson(pathname) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2200);
  try {
    const res = await fetch(`${DEFAULT_ORIGIN}${pathname}`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.type === 'GET_SNAPSHOT') {
    fetchLoopbackJson('/api/overview')
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  if (msg.type === 'ROUTE_PROMPT') {
    const q = new URLSearchParams({
      prompt: String(msg.prompt || '').slice(0, 800),
      role: String(msg.role || 'researcher'),
      strategy: String(msg.strategy || 'balanced'),
    });
    fetchLoopbackJson(`/api/route/recommend?${q.toString()}`)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
  return false;
});
