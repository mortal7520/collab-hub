'use strict';

chrome.runtime.sendMessage({ type: 'GET_SNAPSHOT' }, (resp) => {
  const box = document.getElementById('statusBox');
  if (chrome.runtime.lastError || !resp?.ok || !resp.data) {
    box.textContent = 'Daemon offline — start via `collab-hub start`.';
    return;
  }
  const tot = resp.data.live_usage?.totals || {};
  const health = resp.data.self_improve?.health_score ?? 100;
  box.textContent = `Online · ♥${health}/100 · ${tot.connected_agents || 0} agents · $${Number(tot.est_cost_usd_today || 0).toFixed(2)} today`;
});

document.getElementById('btnOpen').addEventListener('click', () => {
  chrome.tabs.create({ url: 'http://127.0.0.1:5290/' });
});
