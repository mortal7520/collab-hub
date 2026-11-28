/**
 * CollabHub v3.0 — Programmatic Zero-Dependency ESM SDK Entrypoint
 */
import { ensureRuntimeDirs } from './config.mjs';
import { createDashboardServer, startReadOnlyAutoPoller } from './dashboard.mjs';
import { openHubDb, openHubDbReadOnly, pruneRetentionTables } from './db.mjs';
import { sweepOrphanTasks } from './executors.mjs';
import { startTriggerScheduler } from './triggers.mjs';
import { startWebhookDispatcher } from './webhooks.mjs';

export { APP_VERSION, APP_ROOT, WORKSPACE_ROOT, DASHBOARD_HOST, DASHBOARD_PORT } from './config.mjs';
export { openHubDb, openHubDbReadOnly, getMemberStatuses, touchPassiveDesktopHeartbeat } from './db.mjs';
export { createDashboardServer, startReadOnlyAutoPoller } from './dashboard.mjs';
export {
  MCP_APP_RESOURCES, MCP_PROFILES, TOOLS, getToolsForProfile,
  handleMcpJsonRpcMessage, handleToolCall, startMcpStdioServer,
} from './mcp-server.mjs';
export { dispatchBackgroundTask, pollBackgroundTask, cancelTask, getTaskLogs } from './executors.mjs';
export {
  createCollabRoom, listCollabRooms, getRoomStatus, appendRoomLog,
  claimRoomPath, renewRoomClaim, releaseRoomClaim, promoteInboxFile,
} from './workspace-room.mjs';
export { putArtifact, getArtifact, listArtifacts, deleteArtifact, pruneExpiredArtifacts } from './artifacts.mjs';
export { buildHandoffPack } from './handoff-pack.mjs';
export { computeVerdict, createConsensusRound, recordConsensusVote, synthesizeConsensus, listConsensusRounds } from './consensus.mjs';
export { setBudgetPolicy, listBudgetPolicies, deleteBudgetPolicy, evaluateBudget } from './budget.mjs';
export { saveTrigger, listTriggers, deleteTrigger, runTriggerNow, startTriggerScheduler } from './triggers.mjs';
export { VALID_WEBHOOK_FORMATS, saveWebhook, listWebhooks, deleteWebhook, deliverWebhook, formatWebhookPayload, startWebhookDispatcher } from './webhooks.mjs';
export { getLiveAgentUsage, getLiveAgentUsageAsync, recordMcpClientActivity, estimateCostUsd } from './live-usage.mjs';
export { planAutostart, getAutostartStatus, installAutostart, removeAutostart } from './autostart.mjs';
export { TASK_CATEGORIES, classifyTaskIntent, getAgentCapabilityProfile, scoreAgentForTask, buildCapabilityMatrix } from './router.mjs';
export { getIdeExtensionTargets, planPluginInstall, installNativePlugins } from './plugin-installer.mjs';
export { planSetup, applySetup } from './setup.mjs';
export { applySelfHeal, diagnoseSystem, reconcileStaleTasks } from './self-improve.mjs';

export async function createCollabHub({
  dbPath,
  host = '127.0.0.1',
  port = 5290,
  autoPoll = true,
  triggers = true,
  webhooks = true,
} = {}) {
  ensureRuntimeDirs();
  const db = openHubDb(dbPath);
  pruneRetentionTables(db);
  sweepOrphanTasks(db);
  const server = createDashboardServer(db, { host, port });
  await new Promise((resolve) => server.listen(port, host, resolve));
  const poller = autoPoll ? startReadOnlyAutoPoller(db) : null;
  const triggerSched = triggers ? startTriggerScheduler(db) : null;
  const webhookDisp = webhooks ? startWebhookDispatcher(db) : null;
  const addr = server.address();
  return {
    db,
    server,
    port: addr?.port || port,
    url: `http://${host}:${addr?.port || port}`,
    async close() {
      poller?.stop();
      triggerSched?.stop();
      webhookDisp?.stop();
      await server.shutdown();
      try { db.close(); } catch {}
    },
  };
}
