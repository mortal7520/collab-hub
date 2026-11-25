import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { APP_VERSION, assertValidGitRef, assertValidTaskId, resolveProjectDir, toWslPath } from '../src/config.mjs';
import { clearMemberCooldown, getMemberStatuses, openHubDb, setMemberCooldown, upsertMemberStatus } from '../src/db.mjs';
import { createDashboardServer } from '../src/dashboard.mjs';
import { discoverLocalAgents } from '../src/discovery.mjs';
import { createHotBackup, listWorkspaceProjects, runSystemDoctor } from '../src/doctor.mjs';
import {
  callBatonTool, cancelTask, canonicalGoJson, dispatchBackgroundTask, getTaskLogs,
  pollBackgroundTask, pollBatchTasks, reconcileTask, recordNativeHandoff, uuidv5Url,
} from '../src/executors.mjs';
import { hubBus } from '../src/event-bus.mjs';
import { createSseParser, parseSseEvents } from '../src/mail-mcp-proxy.mjs';
import { mailNameForMember } from '../src/mail-sync.mjs';
import { searchMemoryNotes, writeMemoryNote } from '../src/memory.mjs';
import { TOOLS, handleToolCall } from '../src/mcp-server.mjs';
import { runPlaybook } from '../src/playbooks.mjs';
import { planDispatch, probeAllMembers } from '../src/prober.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from '../src/recipes.mjs';
import { listAgents, registerAgent, removeAgent } from '../src/registry.mjs';
import { computeAgentTelemetry } from '../src/telemetry.mjs';
import { convertDocToMd, getToolkitStatus, packRepoRepomix, runBeads, searchAstGrep } from '../src/toolkit.mjs';
import { buildBatchMarkdownReport, resumeDagWorkflow, runDagWorkflow } from '../src/workflows.mjs';
import { createWorktree, mergeWorktree, reviewWorktree, verifyWorktree } from '../src/worktree.mjs';

function makeTempEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collab-hub-test-'));
  const ws = path.join(dir, 'workspace');
  const proj = path.join(ws, 'demo-proj');
  const mem = path.join(dir, 'memory');
  const wts = path.join(dir, 'worktrees');
  const payloads = path.join(dir, 'payloads');
  fs.mkdirSync(proj, { recursive: true });
  fs.mkdirSync(mem, { recursive: true });
  fs.mkdirSync(wts, { recursive: true });
  fs.mkdirSync(payloads, { recursive: true });
  const db = openHubDb(path.join(dir, 'hub.db'));
  return { dir, ws, proj, mem, wts, payloads, db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

function rawHttpRequest({ port, method = 'GET', pathName = '/', headers = {}, body = '' }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: pathName, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

test('C1: task_id path traversal and route injection are rejected everywhere', async () => {
  assert.throws(() => assertValidTaskId('x/../../../../Windows/Temp/p'), /Invalid task_id/);
  assert.throws(() => assertValidTaskId('../secret'), /Invalid task_id/);
  assert.throws(() => assertValidTaskId('a\\b'), /Invalid task_id/);
  const env = makeTempEnv();
  try {
    await assert.rejects(() => dispatchBackgroundTask(env.db, {
      taskId: 'x/../../../evil', member: 'muse', role: 'reviewer', projectDir: env.proj, prompt: 'test',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], payloadDir: env.payloads }), /Invalid task_id/);
  } finally {
    env.cleanup();
  }
});

test('C2: Dashboard blocks DNS rebinding (421), cross-site POST/CSRF (403), invalid member (400), and >64KB body (413)', async () => {
  const env = makeTempEnv();
  const server = createDashboardServer(env.db, { host: '127.0.0.1', port: 0 });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // 1. DNS rebinding Host mismatch -> 421
    const rebind = await rawHttpRequest({ port, pathName: '/api/overview', headers: { Host: 'attacker.example' } });
    assert.equal(rebind.status, 421);

    // 2. Simple-request CSRF POST without X-CollabHub-CSRF / JSON -> 403
    const csrf1 = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/cooldown/clear',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'text/plain' },
      body: '{"member":"claude"}',
    });
    assert.equal(csrf1.status, 403);

    // 3. Cross-origin POST with CSRF header -> 403
    const csrf2 = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/cooldown/clear',
      headers: { Host: `127.0.0.1:${port}`, Origin: 'https://evil.example', 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
      body: '{"member":"claude"}',
    });
    assert.equal(csrf2.status, 403);

    // 4. Legitimate local POST with invalid member -> 400
    const badMember = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/cooldown/clear',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
      body: '{"member":"../../etc/passwd"}',
    });
    assert.equal(badMember.status, 400);

    // 5. Oversized POST body (>64KB) -> 413
    const huge = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/cooldown/clear',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
      body: JSON.stringify({ member: 'claude', pad: 'A'.repeat(70 * 1024) }),
    });
    assert.equal(huge.status, 413);

    // 6. Valid local GET + security headers
    const ok = await rawHttpRequest({ port, pathName: '/api/overview', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers['x-frame-options'], 'DENY');
    assert.equal(ok.headers['cache-control'], 'no-store');
  } finally {
    server.close();
    env.cleanup();
  }
});

test('H1 + M1 + M4: Worktree path is dispatch-compatible, blocks base_ref injection, checks base branch on merge', async () => {
  assert.throws(() => assertValidGitRef('--output=/tmp/pwn'), /Unsafe or invalid git ref/);
  assert.throws(() => assertValidGitRef('main..evil'), /Unsafe or invalid git ref/);
  const env = makeTempEnv();
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: env.proj });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: env.proj });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: env.proj });
    fs.writeFileSync(path.join(env.proj, 'README.md'), 'hello\n');
    execFileSync('git', ['add', '.'], { cwd: env.proj });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: env.proj });

    // Reject option-injection baseRef
    assert.throws(() => createWorktree(env.db, {
      repoDir: env.proj, taskId: 'wt-bad', member: 'codex', baseRef: '--output=/tmp/PWN', worktreeRoot: env.wts, workspaceRoot: env.ws,
    }), /Unsafe or invalid git ref/);

    const wt = createWorktree(env.db, {
      repoDir: env.proj, taskId: 'wt-1', member: 'dsh', worktreeRoot: env.wts, workspaceRoot: env.ws,
    });
    assert.equal(wt.branch_name, 'collab/dsh/wt-1');

    // H1 regression: dispatchBackgroundTask MUST accept worktree_path under worktreeRoot!
    const dispatched = await dispatchBackgroundTask(env.db, {
      taskId: 'dsh-in-wt-1',
      member: 'dsh',
      role: 'implementer',
      projectDir: env.proj,
      worktreePath: wt.worktree_path,
      branchName: wt.branch_name,
      prompt: 'Edit inside isolated worktree',
    }, {
      workspaceRoot: env.ws,
      extraRoots: [env.wts],
      callBaton: async () => ({ run_id: 'hrun-wt-1', session_id: 'sess-wt-1' }),
    });
    assert.equal(dispatched.state, 'running');
    assert.equal(dispatched.project_dir.toLowerCase(), fs.realpathSync(wt.worktree_path).toLowerCase());

    fs.writeFileSync(path.join(wt.worktree_path, 'feature.txt'), 'isolated work\n');
    execFileSync('git', ['add', '.'], { cwd: wt.worktree_path });
    execFileSync('git', ['commit', '-m', 'add feature'], { cwd: wt.worktree_path });

    const rev = reviewWorktree(env.db, { taskId: 'wt-1' });
    assert.equal(rev.commits.length, 1);
    assert.match(rev.diff_preview, /isolated work/);

    // Sneak an unreviewed commit after review -> merge MUST refuse until re-reviewed!
    fs.writeFileSync(path.join(wt.worktree_path, 'sneaky.txt'), 'unreviewed\n');
    execFileSync('git', ['add', '.'], { cwd: wt.worktree_path });
    execFileSync('git', ['commit', '-m', 'sneaky commit'], { cwd: wt.worktree_path });
    assert.throws(() => mergeWorktree(env.db, { taskId: 'wt-1', confirmed: true }), /HEAD changed after review/i);

    // Re-review updates reviewed_head_sha cleanly
    const rev2 = reviewWorktree(env.db, { taskId: 'wt-1' });
    assert.equal(rev2.commits.length, 2);

    // Switch main repo to another branch -> merge MUST refuse!
    execFileSync('git', ['checkout', '-b', 'other-branch'], { cwd: env.proj });
    assert.throws(() => mergeWorktree(env.db, { taskId: 'wt-1', confirmed: true }), /expected base_ref "main"/i);
    execFileSync('git', ['checkout', 'main'], { cwd: env.proj });

    assert.throws(() => mergeWorktree(env.db, { taskId: 'wt-1', confirmed: false }), /confirmed=true/i);
    const merged = mergeWorktree(env.db, { taskId: 'wt-1', confirmed: true, cleanup: true });
    assert.equal(merged.merged, true);
    assert.equal(merged.cleaned, true);
    assert.ok(fs.existsSync(path.join(env.proj, 'feature.txt')));
  } finally {
    env.cleanup();
  }
});

test('H2: Crash self-healing for Muse (/mappings) & Claude (uuidv5), plus explicit DSH reconcile', async () => {
  const env = makeTempEnv();
  try {
    const now = new Date().toISOString();
    // Simulate crash right after Muse publish before DB saved external_id
    env.db.prepare(`
      INSERT INTO tasks (task_id, project_dir, member, role, channel, title, prompt, state, external_id, created_at, updated_at)
      VALUES ('muse-crash-1', ?, 'muse', 'reviewer', 'muse-tailnet', 't', 'p', 'dispatching', NULL, ?, ?)
    `).run(env.proj, now, now);

    const recoveredMuse = await pollBackgroundTask(env.db, 'muse-crash-1', { waitSec: 0 }, {
      runMuseOperator: async (method, route) => {
        if (method === 'GET' && route === '/mappings/muse-crash-1') {
          return { ok: true, http_status: 200, result: { task_id: 'muse-crash-1', request_id: 'muse-rec-99' } };
        }
        return {
          ok: true, http_status: 200,
          result: {
            task_id: 'muse-crash-1', request_id: 'muse-rec-99',
            upstream: { status: 'claimed', request: { id: 'muse-rec-99', from: 'workswarm', to: 'muse' } },
          },
        };
      },
    });
    assert.equal(recoveredMuse.external_id, 'muse-rec-99');
    assert.equal(recoveredMuse.state, 'running');

    // Simulate DSH crash with missing run_id -> poll marks uncertain -> reconcile attaches real run_id
    env.db.prepare(`
      INSERT INTO tasks (task_id, project_dir, member, role, channel, title, prompt, state, external_id, created_at, updated_at)
      VALUES ('dsh-crash-1', ?, 'dsh', 'tester', 'dsh-baton', 't', 'p', 'dispatching', NULL, ?, ?)
    `).run(env.proj, now, now);
    const uncertainDsh = await pollBackgroundTask(env.db, 'dsh-crash-1', { waitSec: 0 });
    assert.equal(uncertainDsh.state, 'uncertain');
    assert.equal(uncertainDsh.error_code, 'DSH_RECONCILE_REQUIRED');

    const attached = reconcileTask(env.db, { taskId: 'dsh-crash-1', externalId: 'hrun-recovered-1', state: 'running', note: 'Recovered from dsh_list_sessions' });
    assert.equal(attached.external_id, 'hrun-recovered-1');
    assert.equal(attached.state, 'running');
  } finally {
    env.cleanup();
  }
});

test('H3 + Codex terminal regression guard: no cross-member handoff hijacking and slow poll cannot regress completed', async () => {
  const env = makeTempEnv();
  try {
    // Reject non-native member in recordNativeHandoff
    assert.throws(() => recordNativeHandoff(env.db, {
      taskId: 'forged-muse', member: 'muse', role: 'reviewer', projectDir: env.proj, state: 'completed', resultText: 'FAKE',
    }), /Invalid member/);

    // Seed a DSH task; claude native handoff MUST NOT hijack it
    const dshTask = await dispatchBackgroundTask(env.db, {
      taskId: 'dsh-race-1', member: 'dsh', role: 'tester', projectDir: env.proj, prompt: 'test',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], callBaton: async () => ({ run_id: 'hrun-r1', session_id: 's1' }) });
    assert.equal(dshTask.state, 'running');

    assert.throws(() => recordNativeHandoff(env.db, {
      taskId: 'dsh-race-1', member: 'claude', role: 'reviewer', state: 'completed', resultText: 'HIJACK',
    }), /cross-member\/cross-channel/i);

    // Concurrent slow poll vs fast completion: slow poll MUST NOT overwrite completed -> running!
    let resolveSlow;
    const slowPoll = pollBackgroundTask(env.db, 'dsh-race-1', { waitSec: 0 }, {
      callBaton: () => new Promise((r) => { resolveSlow = r; }),
    });
    const fastDone = await pollBackgroundTask(env.db, 'dsh-race-1', { waitSec: 0 }, {
      callBaton: async () => ({ state: 'completed', session_id: 's1', final_text: 'REAL-VERIFIED' }),
    });
    assert.equal(fastDone.state, 'completed');
    resolveSlow({ state: 'running', session_id: 's1' });
    await slowPoll;

    const afterRace = env.db.prepare('SELECT state, result_text FROM tasks WHERE task_id = ?').get('dsh-race-1');
    assert.equal(afterRace.state, 'completed');
    assert.equal(afterRace.result_text, 'REAL-VERIFIED');

    // Completed native task cannot be regressed to dispatched
    recordNativeHandoff(env.db, {
      taskId: 'nat-done-1', member: 'codex', role: 'implementer', projectDir: env.proj, state: 'completed', resultText: 'DONE',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.throws(() => recordNativeHandoff(env.db, {
      taskId: 'nat-done-1', member: 'codex', role: 'implementer', state: 'dispatched',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] }), /terminal state=completed/i);
  } finally {
    env.cleanup();
  }
});

test('H4 + Per-channel Claude 429 cooldown + diagnostic shape detection', async () => {
  const env = makeTempEnv();
  try {
    // Unknown members are NEVER recommended
    const emptyPlan = planDispatch(env.db, { role: 'researcher' });
    assert.equal(emptyPlan.recommended, null);

    // Stale Desktop snapshot (20m old) is downgraded to stale and excluded
    const oldTime = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    env.db.prepare(`UPDATE member_status SET channel='desktop-native', state='online', checked_at=? WHERE member='codex'`).run(oldTime);
    const codexStatus = getMemberStatuses(env.db, { desktopTtlMs: 5 * 60 * 1000 }).find((m) => m.member === 'codex');
    assert.equal(codexStatus.state, 'stale');
    assert.equal(codexStatus.is_stale, true);

    // Claude CLI hits real-shape diagnostic rate limit -> sets claude-cli cooldown
    const reqId = uuidv5Url('collab-hub-claude-cli:cl-diag-1');
    const now = new Date().toISOString();
    env.db.prepare(`
      INSERT INTO tasks (task_id, project_dir, member, role, channel, title, prompt, state, external_id, created_at, updated_at)
      VALUES ('cl-diag-1', ?, 'claude', 'reviewer', 'claude-cli', 't', 'p', 'running', ?, ?, ?)
    `).run(env.proj, reqId, now, now);

    const failed = await pollBackgroundTask(env.db, 'cl-diag-1', { waitSec: 0 }, {
      callClaudeWorker: async () => ({
        requestId: reqId, agent: 'claude', surface: 'background-cli',
        status: 'failed', sent: true, deliveryState: 'sent', sessionId: 'real-s',
        output: '', outputTruncated: false,
        diagnostic: { code: 'CLAUDE_CLI_RATE_LIMIT', reason: 'Resource has been exhausted', retrySafe: false },
      }),
    });
    assert.equal(failed.error_code, 'CLAUDE_UPSTREAM_429');

    // Now simulate user opening Claude Desktop -> Desktop MUST remain usable despite claude-cli cooldown!
    upsertMemberStatus(env.db, { member: 'claude', channel: 'desktop-native', state: 'online', detail: 'Active Desktop session' });
    const clAfter = getMemberStatuses(env.db).find((m) => m.member === 'claude');
    assert.equal(clAfter.state, 'online');
    assert.equal(clAfter.in_cooldown, false);
    assert.equal(clAfter.cli_in_cooldown, true);

    const desktopPlan = planDispatch(env.db, { role: 'reviewer', prefer: ['claude'] });
    assert.equal(desktopPlan.recommended.member, 'claude');
    assert.equal(desktopPlan.recommended.execution_mode, 'desktop_native_bridge');

    const bgPlan = planDispatch(env.db, { role: 'reviewer', prefer: ['claude'], requireBackgroundAuto: true });
    assert.equal(bgPlan.recommended, null);
    assert.ok(bgPlan.skipped.some((s) => s.member === 'claude' && s.reason.includes('cooldown')));

    clearMemberCooldown(env.db, 'claude');
  } finally {
    env.cleanup();
  }
});

test('H5: callBatonTool rejects cleanly on spawn ENOENT without crashing process', async () => {
  await assert.rejects(() => callBatonTool('dsh_status', {}, {
    nodeExe: 'C:\\definitely-nonexistent-node-binary-99999.exe',
    launcher: 'D:\\nonexistent.cjs',
    timeoutMs: 2000,
  }), /Baton spawn error/i);
});

test('Muse outer identity verification, monotonic generation, ACK-only rejection, and payload cleanup', async () => {
  assert.equal(canonicalGoJson({ b: '<&>', a: 1 }), '{"a":1,"b":"\\u003c\\u0026\\u003e"}');
  const env = makeTempEnv();
  try {
    const task = await dispatchBackgroundTask(env.db, {
      taskId: 'muse-strict-1', member: 'muse', role: 'reviewer', projectDir: env.proj, prompt: 'Review',
    }, {
      workspaceRoot: env.ws, extraRoots: [env.wts], payloadDir: env.payloads,
      runMuseOperator: async (method, route) => {
        if (method === 'GET' && route === '/mappings/muse-strict-1') return { ok: false, http_status: 404, result: { error: 'mapping_not_found', task_id: 'muse-strict-1' } };
        return { ok: true, http_status: 201, result: { request_id: 'mreq-1', state: 'queued' } };
      },
    });
    assert.equal(task.external_id, 'mreq-1');
    // Plaintext payload file was cleaned up immediately after publish!
    assert.equal(fs.existsSync(path.join(env.payloads, 'muse-muse-strict-1.json')), false);

    // Mismatched outer request_id -> uncertain!
    const badOuter = await pollBackgroundTask(env.db, 'muse-strict-1', { waitSec: 0 }, {
      runMuseOperator: async () => ({
        ok: true, http_status: 200,
        result: { task_id: 'OTHER', request_id: 'WRONG', upstream: { status: 'answered' } },
      }),
    });
    assert.equal(badOuter.state, 'uncertain');
    assert.equal(badOuter.error_code, 'MUSE_IDENTITY_MISMATCH');

    // Valid completed reply clears error_code and records generation
    const okDone = await pollBackgroundTask(env.db, 'muse-strict-1', { waitSec: 0 }, {
      runMuseOperator: async () => ({
        ok: true, http_status: 200,
        result: {
          task_id: 'muse-strict-1', request_id: 'mreq-1',
          upstream: {
            status: 'answered',
            request: { id: 'mreq-1', from: 'workswarm', to: 'muse' },
            reply: {
              request_id: 'mreq-1', from: 'muse', generation: 1, status: 'answered', kept_open: false,
              body: JSON.stringify({ task_id: 'muse-strict-1', actor_id: 'muse', role: 'reviewer', status: 'completed', result: 'VERIFIED-CRITIQUE', evidence: ['e1'], blockers: [] }),
            },
          },
        },
      }),
    });
    assert.equal(okDone.state, 'completed');
    assert.equal(okDone.error_code, null);
    assert.equal(okDone.reply_generation, 1);
  } finally {
    env.cleanup();
  }
});

test('M6 + M8 + Batch poll: atomic Chinese memory, multi-line SSE framing, and 34 MCP tools', async () => {
  assert.equal(TOOLS.length, 34);
  const sse = parseSseEvents('event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":1}\n\ndata: {"id":2}\n\n');
  assert.equal(sse.length, 2);
  assert.deepEqual(JSON.parse(sse[0]), { jsonrpc: '2.0', id: 1 });

  const env = makeTempEnv();
  try {
    writeMemoryNote(env.db, {
      project: 'money-ops',
      title: '闲鱼客服防混售架构决策',
      tags: ['闲鱼', '429冷却'],
      content: '采用 Worktree 隔离和按通道冷却，避免多 Agent 并发冲突。',
      memoryDir: env.mem,
    });
    const cnHits = searchMemoryNotes(env.db, { query: '防混售', project: 'money-ops' });
    assert.equal(cnHits.length, 1);

    await dispatchBackgroundTask(env.db, {
      taskId: 'b-dsh-1', batchId: 'batch-alpha', member: 'dsh', role: 'tester', projectDir: env.proj, prompt: 't1',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], callBaton: async () => ({ run_id: 'hrun-b1', session_id: 's1' }) });

    const batchRes = await pollBatchTasks(env.db, { batchId: 'batch-alpha', waitSec: 0 }, {
      callBaton: async () => ({ state: 'completed', session_id: 's1', final_text: 'BATCH-OK' }),
    });
    assert.equal(batchRes.total, 1);
    assert.equal(batchRes.all_terminal, true);
    assert.equal(batchRes.counts.completed, 1);

    const statusRes = await handleToolCall(env.db, 'collab_cooldown', { action: 'status' });
    assert.equal(statusRes.members.length, 5);
  } finally {
    env.cleanup();
  }
});

test('resolveProjectDir rejects workspace root for DSH and maps WSL paths', () => {
  const env = makeTempEnv();
  try {
    assert.throws(() => resolveProjectDir(env.ws, { requireSubdir: true, workspaceRoot: env.ws, extraRoots: [env.wts] }), /subdirectory/i);
    const ok = resolveProjectDir(env.proj, { requireSubdir: true, workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(ok.windows.toLowerCase(), fs.realpathSync(env.proj).toLowerCase());
    assert.equal(toWslPath('D:\\workspace\\collab-hub'), '/mnt/d/workspace/collab-hub');
  } finally {
    env.cleanup();
  }
});

test('v3: Muse relay_note surfaces stalled state, DSH 3x harness_down surfaces stalled, and incremental SSE works', async () => {
  const streamed = [];
  const p = createSseParser((ev) => streamed.push(ev));
  p.push('data: {"a":');
  p.push('1}\n\ndata: {"b":2}\n');
  p.push('\n');
  p.end();
  assert.deepEqual(streamed.map((s) => JSON.parse(s)), [{ a: 1 }, { b: 2 }]);

  const env = makeTempEnv();
  try {
    const now = new Date().toISOString();
    env.db.prepare(`
      INSERT INTO tasks (task_id, project_dir, member, role, channel, title, prompt, state, external_id, created_at, updated_at)
      VALUES ('muse-stalled-1', ?, 'muse', 'reviewer', 'muse-tailnet', 't', 'p', 'running', 'mreq-st-1', ?, ?)
    `).run(env.proj, now, now);

    const stMuse = await pollBackgroundTask(env.db, 'muse-stalled-1', { waitSec: 0 }, {
      runMuseOperator: async () => ({
        ok: true, http_status: 200,
        result: {
          task_id: 'muse-stalled-1', request_id: 'mreq-st-1',
          upstream: {
            status: 'delivered',
            request: { id: 'mreq-st-1', from: 'workswarm', to: 'muse' },
            relay_note: { note: 'muse claimed this 30m ago and lease expired; requeued', by: 'relay' },
          },
        },
      }),
    });
    assert.equal(stMuse.state, 'stalled');
    assert.equal(stMuse.error_code, 'MUSE_LEASE_EXPIRED_REQUEUED');

    // DSH 3 consecutive harness_down -> stalled
    env.db.prepare(`
      INSERT INTO tasks (task_id, project_dir, member, role, channel, title, prompt, state, external_id, created_at, updated_at)
      VALUES ('dsh-down-1', ?, 'dsh', 'tester', 'dsh-baton', 't', 'p', 'running', 'hrun-d1', ?, ?)
    `).run(env.proj, now, now);
    const downBaton = async () => ({ harness_down: true, state: 'running' });
    assert.equal((await pollBackgroundTask(env.db, 'dsh-down-1', { waitSec: 0 }, { callBaton: downBaton })).state, 'running');
    assert.equal((await pollBackgroundTask(env.db, 'dsh-down-1', { waitSec: 0 }, { callBaton: downBaton })).state, 'running');
    const third = await pollBackgroundTask(env.db, 'dsh-down-1', { waitSec: 0 }, { callBaton: downBaton });
    assert.equal(third.state, 'stalled');
    assert.equal(third.error_code, 'DSH_HARNESS_DOWN');
  } finally {
    env.cleanup();
  }
});

test('v3: depends_on DAG gate, auto_inject_context, reservePaths conflict check, and dashboard reconcile', async () => {
  const env = makeTempEnv();
  try {
    // Seed an incomplete upstream task
    await dispatchBackgroundTask(env.db, {
      taskId: 'up-1', batchId: 'b-dag', member: 'dsh', role: 'researcher', projectDir: env.proj, title: 'Step 1', prompt: 'Gather facts',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], callBaton: async () => ({ run_id: 'hrun-up1', session_id: 's1' }) });

    // Downstream blocked until up-1 completes
    await assert.rejects(() => dispatchBackgroundTask(env.db, {
      taskId: 'down-1', batchId: 'b-dag', dependsOn: ['up-1'], member: 'dsh', role: 'synthesizer', projectDir: env.proj, prompt: 'Synthesize',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], callBaton: async () => ({ run_id: 'hrun-d2', session_id: 's2' }) }), /Dependency gate blocked/i);

    // Complete up-1
    await pollBackgroundTask(env.db, 'up-1', { waitSec: 0 }, {
      callBaton: async () => ({ state: 'completed', session_id: 's1', final_text: 'UPSTREAM-FACT-42' }),
    });

    // Lease conflict check blocks dispatch unless allowLeaseConflict=true
    await assert.rejects(() => dispatchBackgroundTask(env.db, {
      taskId: 'down-conflict', batchId: 'b-dag', dependsOn: ['up-1'], reservePaths: ['src/app.mjs'], member: 'dsh', role: 'implementer', projectDir: env.proj, prompt: 'Edit',
    }, {
      workspaceRoot: env.ws, extraRoots: [env.wts],
      reserveMailPaths: async () => ({ synced: true, has_conflicts: true, conflicts: [{ path: 'src/app.mjs', holder: 'CollabCodex' }] }),
      callBaton: async () => ({ run_id: 'hrun-never', session_id: 's' }),
    }), /File reservation conflict/i);

    // Dispatch down-1 with autoInjectContext=true -> receives UPSTREAM-FACT-42 in prompt!
    let sentMessage = '';
    const down = await dispatchBackgroundTask(env.db, {
      taskId: 'down-1', batchId: 'b-dag', dependsOn: ['up-1'], autoInjectContext: true, member: 'dsh', role: 'synthesizer', projectDir: env.proj, prompt: 'Final summary',
    }, {
      workspaceRoot: env.ws, extraRoots: [env.wts],
      callBaton: async (_tool, args) => { sentMessage = args.message; return { run_id: 'hrun-down1', session_id: 's2' }; },
    });
    assert.equal(down.state, 'running');
    assert.match(sentMessage, /UPSTREAM-FACT-42/);
    assert.deepEqual(down.depends_on, ['up-1']);

    // Test dashboard v3 batches + POST /api/tasks/reconcile
    const server = createDashboardServer(env.db, { host: '127.0.0.1', port: 0 });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const recRes = await rawHttpRequest({
        port, method: 'POST', pathName: '/api/tasks/reconcile',
        headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' },
        body: JSON.stringify({ task_id: 'down-1', state: 'rerouted', note: 'Moved to Codex' }),
      });
      assert.equal(recRes.status, 200);
      assert.equal(JSON.parse(recRes.body).task.state, 'rerouted');

      const ov = JSON.parse((await rawHttpRequest({ port, pathName: '/api/overview', headers: { Host: `127.0.0.1:${port}` } })).body);
      const b = ov.batches.find((x) => x.batch_id === 'b-dag');
      assert.equal(b.total, 2);
      assert.equal(b.all_terminal, true);
      assert.equal(b.all_succeeded, false);
    } finally {
      server.close();
    }
  } finally {
    env.cleanup();
  }
});

test('v4: Dynamic Agent Registry security + real generic-cli & openai-http drivers (with 429 cooldown)', async () => {
  const env = makeTempEnv();
  // Local mock OpenAI-compatible HTTP server
  let return429 = false;
  const mockLlm = http.createServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'mock-coder' }] }));
      return;
    }
    if (req.url === '/v1/chat/completions') {
      if (return429) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'rate limit exceeded' } }));
        return;
      }
      let body = '';
      for await (const c of req) body += c;
      const parsed = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-mock-1',
        model: parsed.model,
        choices: [{ message: { content: `MOCK-HTTP-OK:${parsed.messages.at(-1).content}` } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => mockLlm.listen(0, '127.0.0.1', r));
  const llmPort = mockLlm.address().port;

  try {
    // 1. Security rejections: plaintext api_key, shell metachars, hijacking built-in drivers
    assert.throws(() => registerAgent(env.db, {
      agentId: 'bad-http', name: 'Bad', driver: 'openai-http',
      config: { base_url: 'http://127.0.0.1:11434/v1', model: 'm', api_key: 'sk-secret-plaintext' },
    }), /never store plaintext api_key/i);

    assert.throws(() => registerAgent(env.db, {
      agentId: 'bad-cli', name: 'Bad', driver: 'generic-cli',
      config: { command: 'node; calc.exe' },
    }), /without shell metacharacters/i);

    assert.throws(() => registerAgent(env.db, {
      agentId: 'fake-dsh', name: 'Fake', driver: 'dsh-baton',
    }), /Custom agents must use/i);

    assert.throws(() => registerAgent(env.db, {
      agentId: 'dsh', name: 'Hijack', driver: 'generic-cli', config: { command: 'node' },
    }), /Cannot change driver of built-in/i);

    // 2. Register & run a real generic-cli agent (node reading prompt from arg)
    const cliAgent = registerAgent(env.db, {
      agentId: 'local-echo-cli',
      name: 'Local Echo CLI',
      driver: 'generic-cli',
      roles: ['reviewer', 'researcher'],
      config: {
        command: process.execPath,
        args: ['-e', 'process.stdout.write("CLI-OK:" + process.argv[1])', '{{prompt}}'],
        prompt_mode: 'arg',
        timeout_s: 20,
      },
    });
    assert.equal(cliAgent.driver, 'generic-cli');
    assert.ok(listAgents(env.db).some((a) => a.id === 'local-echo-cli'));

    const cliTask = await dispatchBackgroundTask(env.db, {
      taskId: 'v4-cli-1', member: 'local-echo-cli', role: 'reviewer', projectDir: env.proj, prompt: 'hello-v4',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(cliTask.state, 'completed');
    assert.equal(cliTask.result_text, 'CLI-OK:hello-v4');

    // 3. Register & run a real openai-http agent against mock server
    registerAgent(env.db, {
      agentId: 'ollama-mock',
      name: 'Mock Ollama',
      driver: 'openai-http',
      roles: ['reviewer', 'synthesizer'],
      config: { base_url: `http://127.0.0.1:${llmPort}/v1`, model: 'mock-coder' },
    });
    const httpTask = await dispatchBackgroundTask(env.db, {
      taskId: 'v4-http-1', member: 'ollama-mock', role: 'reviewer', projectDir: env.proj, prompt: 'review-this',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(httpTask.state, 'completed');
    assert.equal(httpTask.result_text, 'MOCK-HTTP-OK:review-this');

    // 4. Trigger HTTP 429 on openai-http -> enters per-channel cooldown & blocks immediate re-dispatch
    return429 = true;
    const rateLimited = await dispatchBackgroundTask(env.db, {
      taskId: 'v4-http-429', member: 'ollama-mock', role: 'reviewer', projectDir: env.proj, prompt: 'hit-limit',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(rateLimited.state, 'failed');
    assert.equal(rateLimited.error_code, 'HTTP_AGENT_429');

    await assert.rejects(() => dispatchBackgroundTask(env.db, {
      taskId: 'v4-http-blocked', member: 'ollama-mock', role: 'reviewer', projectDir: env.proj, prompt: 'should-block',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] }), /429 cooldown/i);

    // 5. Remove custom agent vs disable built-in agent
    const rmCustom = removeAgent(env.db, 'local-echo-cli');
    assert.equal(rmCustom.removed, true);
    assert.equal(listAgents(env.db).some((a) => a.id === 'local-echo-cli'), false);

    const rmBuiltin = removeAgent(env.db, 'muse');
    assert.equal(rmBuiltin.removed, false);
    assert.equal(rmBuiltin.disabled, true);
  } finally {
    mockLlm.close();
    env.cleanup();
  }
});

test('v4: Reused GitHub toolkit wrappers (ast-grep, repomix, markitdown, beads) + path jails + playbooks', async () => {
  const env = makeTempEnv();
  try {
    const tk = getToolkitStatus();
    fs.writeFileSync(path.join(env.proj, 'sample.js'), 'export function greetAgent(name) { return "hi " + name; }\n');
    fs.writeFileSync(path.join(env.proj, 'spec.html'), '<h1>CollabHub Spec</h1><p>Practical multi-agent ops.</p>\n');
    const outsideFile = path.resolve(env.dir, 'outside-secret.txt');
    fs.writeFileSync(outsideFile, 'secret\n');

    if (tk.ast_grep.installed) {
      const astRes = await searchAstGrep({
        projectDir: env.proj, pattern: 'export function $NAME($$$) { $$$ }', lang: 'js',
        workspaceRoot: env.ws, extraRoots: [env.wts],
      });
      assert.equal(astRes.ok, true);
      assert.equal(astRes.total_matches, 1);
      assert.match(astRes.matches[0].text, /greetAgent/);

      await assert.rejects(() => searchAstGrep({
        projectDir: path.join(env.ws, '..'), pattern: 'foo', workspaceRoot: env.ws, extraRoots: [env.wts],
      }), /inside allowed roots/i);
    }

    if (tk.repomix.installed) {
      const packRes = await packRepoRepomix({
        projectDir: env.proj, include: 'sample.js', compress: false,
        workspaceRoot: env.ws, extraRoots: [env.wts],
      });
      assert.equal(packRes.ok, true);
      assert.match(packRes.content, /greetAgent/);
    }

    if (tk.markitdown.installed) {
      const mdRes = await convertDocToMd({
        filePath: path.join(env.proj, 'spec.html'), workspaceRoot: env.ws, extraRoots: [env.wts],
      });
      assert.equal(mdRes.ok, true);
      assert.match(mdRes.markdown, /CollabHub Spec/);

      await assert.rejects(() => convertDocToMd({
        filePath: outsideFile, workspaceRoot: env.ws, extraRoots: [env.wts],
      }), /inside allowed roots/i);
    }

    if (tk.beads.installed) {
      await assert.rejects(() => runBeads({
        projectDir: env.proj, action: 'exec-shell', workspaceRoot: env.ws, extraRoots: [env.wts],
      }), /Invalid beads action/i);
    }

    // Playbooks work both with real installed tools or injected mock packers (portable across CI!)
    const mockDeps = {
      workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem,
      ...(tk.repomix.installed ? {} : { packRepoRepomix: async () => ({ ok: true, approx_tokens: 42, content: 'export function greetAgent() {}' }) }),
      ...(tk.markitdown.installed ? {} : { convertDocToMd: async () => ({ ok: true, file_path: 'spec.html', markdown: '# CollabHub Spec' }) }),
      ...(tk.ast_grep.installed ? {} : { searchAstGrep: async () => ({ ok: true, total_matches: 1, matches: [{ file: 'sample.js', line: 1, text: 'greetAgent' }] }) }),
    };
    const rp = await runPlaybook(env.db, {
      playbook: 'research-and-pack',
      projectDir: env.proj,
      goal: 'Pack sample project',
      docPath: path.join(env.proj, 'spec.html'),
      include: 'sample.js',
    }, mockDeps);
    assert.equal(rp.playbook, 'research-and-pack');
    assert.ok(rp.memory_note.slug.startsWith('research-pb_'));

    registerAgent(env.db, {
      agentId: 'squad-reviewer',
      name: 'Squad Reviewer',
      driver: 'generic-cli',
      roles: ['reviewer'],
      config: { command: process.execPath, args: ['-e', 'console.log("SQUAD-REVIEW-OK")'], timeout_s: 20 },
    });
    const squad = await runPlaybook(env.db, {
      playbook: 'code-review-squad',
      projectDir: env.proj,
      goal: 'Check sample.js',
      members: ['squad-reviewer'],
      include: 'sample.js',
      astPattern: 'export function $NAME($$$) { $$$ }',
      astLang: 'js',
    }, mockDeps);
    assert.equal(squad.dispatched_count, 1);
    assert.equal(squad.dispatched[0].state, 'completed');
  } finally {
    env.cleanup();
  }
});

test('v4: Dashboard /api/agents/register, /api/tasks/dispatch, /api/health v4, and CSRF protection on new endpoints', async () => {
  const env = makeTempEnv();
  const server = createDashboardServer(env.db, {
    host: '127.0.0.1',
    port: 0,
    dispatchDeps: { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const hdrs = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' };

  try {
    const health = JSON.parse((await rawHttpRequest({ port, pathName: '/api/health', headers: { Host: `127.0.0.1:${port}` } })).body);
    assert.equal(health.version, APP_VERSION);
    assert.equal(typeof health.toolkit.ast_grep.installed, 'boolean');

    // CSRF block on new register route
    const csrfReg = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/agents/register',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agent_id: 'x', name: 'X', driver: 'desktop-native' }),
    });
    assert.equal(csrfReg.status, 403);

    // Plaintext api_key returns 400 cleanly
    const badKey = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/agents/register', headers: hdrs,
      body: JSON.stringify({ agent_id: 'bad', name: 'Bad', driver: 'openai-http', config: { base_url: 'http://127.0.0.1:11434/v1', model: 'q', api_key: 'secret' } }),
    });
    assert.equal(badKey.status, 400);

    // Valid register + dispatch via UI API + remove
    const reg = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/agents/register', headers: hdrs,
      body: JSON.stringify({
        agent_id: 'ui-cli',
        name: 'UI CLI Agent',
        driver: 'generic-cli',
        roles: ['researcher'],
        config: { command: process.execPath, args: ['-e', 'console.log("UI-DISPATCH-OK")'], timeout_s: 20 },
      }),
    });
    assert.equal(reg.status, 200);

    const disp = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/tasks/dispatch', headers: hdrs,
      body: JSON.stringify({ member: 'ui-cli', role: 'researcher', project_dir: env.proj, title: 'UI Test', prompt: 'hi' }),
    });
    assert.equal(disp.status, 200);
    assert.equal(JSON.parse(disp.body).task.result_text, 'UI-DISPATCH-OK');

    const rm = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/agents/remove', headers: hdrs,
      body: JSON.stringify({ agent_id: 'ui-cli' }),
    });
    assert.equal(rm.status, 200);
    assert.equal(JSON.parse(rm.body).removed, true);

    // Verify new v4.1 cockpit routes: POST /api/memory/write, GET /api/memory/note, POST /api/tasks/poll, POST /api/playbooks/run
    const mw = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/memory/write', headers: hdrs,
      body: JSON.stringify({ project: 'demo', title: 'Cockpit Note', content: 'Full note body here', tags: ['ops'] }),
    });
    assert.equal(mw.status, 200);
    const savedNote = JSON.parse(mw.body).note;
    const mn = await rawHttpRequest({
      port, pathName: `/api/memory/note?project=${encodeURIComponent(savedNote.project)}&slug=${encodeURIComponent(savedNote.slug)}`,
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(mn.status, 200);
    assert.equal(JSON.parse(mn.body).note.content, 'Full note body here');

    // Verify custom mail names don't collide + custom desktop-native agent accepts probeAllMembers desktopObservations & recordNativeHandoff
    assert.notEqual(mailNameForMember('ollama-qwen'), mailNameForMember('gemini-cli'));
    registerAgent(env.db, { agentId: 'cursor-ide', name: 'Cursor', driver: 'desktop-native', roles: ['implementer'] });
    const listed = await handleToolCall(env.db, 'collab_agent_list', {});
    assert.ok(listed.agents.some((a) => a.id === 'cursor-ide'));
    const handoff = recordNativeHandoff(env.db, {
      taskId: 'cur-1', member: 'cursor-ide', role: 'implementer', projectDir: env.proj, state: 'completed', resultText: 'CURSOR-DONE',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(handoff.state, 'completed');
  } finally {
    server.close();
    env.cleanup();
  }
});

test('v5: Local Agent Auto-Discovery never leaks secret env values and suggests clean registrations', async () => {
  const env = makeTempEnv();
  try {
    const found = await discoverLocalAgents(env.db, {
      probeLocalEndpoint: async (ep) => ep.id_prefix === 'ollama'
        ? { ...ep, reachable: true, models: ['qwen2.5-coder:14b'] }
        : { ...ep, reachable: false, models: [] },
      locateBinary: async (bin) => bin === 'gemini.exe' ? { path: 'D:\\tools\\gemini.exe', is_shim: false } : null,
      env: { DEEPSEEK_API_KEY: 'sk-SUPER-SECRET-NEVER-LEAK' },
    });
    const rawJson = JSON.stringify(found);
    assert.equal(rawJson.includes('sk-SUPER-SECRET-NEVER-LEAK'), false);
    assert.equal(found.local_models.length, 1);
    assert.equal(found.local_models[0].suggested_registration.agent_id, 'ollama-qwen2-5-coder-14b');
    assert.ok(found.cli_agents.some((c) => c.id === 'gemini-cli' && c.found === true));
    assert.ok(found.cloud_env_ready.some((p) => p.id === 'deepseek-r1' && p.env_present === true));
  } finally {
    env.cleanup();
  }
});

test('v5: Autonomous multi-stage DAG workflow, cycle rejection, upstream context injection & Markdown report', async () => {
  const env = makeTempEnv();
  try {
    registerAgent(env.db, {
      agentId: 'dag-a', name: 'DAG A', driver: 'generic-cli', roles: ['planner', 'synthesizer'],
      config: { command: process.execPath, args: ['-e', 'process.stdout.write("OUT-A:" + process.argv[1].slice(0, 120))', '{{prompt}}'], timeout_s: 20 },
    });
    registerAgent(env.db, {
      agentId: 'dag-b', name: 'DAG B', driver: 'generic-cli', roles: ['reviewer'],
      config: { command: process.execPath, args: ['-e', 'process.stdout.write("OUT-B:" + process.argv[1].slice(0, 120))', '{{prompt}}'], timeout_s: 20 },
    });

    // Reject cyclic DAG
    await assert.rejects(() => runDagWorkflow(env.db, {
      name: 'cyclic', projectDir: env.proj,
      steps: [
        { id: 's1', member: 'dag-a', prompt: 'p1', depends_on: ['s2'] },
        { id: 's2', member: 'dag-b', prompt: 'p2', depends_on: ['s1'] },
      ],
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem }), /dependency cycle/i);

    // Real 3-step fan-out -> synthesizer DAG (s1 + s2 in parallel -> s3 receives both outputs!)
    const wf = await runDagWorkflow(env.db, {
      name: 'two-wave-test',
      batchId: 'wf-v5-demo',
      projectDir: env.proj,
      steps: [
        { id: 'plan', member: 'dag-a', role: 'planner', prompt: 'PROPOSAL-ALPHA' },
        { id: 'critique', member: 'dag-b', role: 'reviewer', prompt: 'REDTEAM-BETA' },
        { id: 'synth', member: 'dag-a', role: 'synthesizer', depends_on: ['plan', 'critique'], prompt: 'FINAL-VERDICT' },
      ],
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem });

    assert.equal(wf.all_completed, true);
    assert.equal(wf.dispatched_count, 3);
    assert.ok(wf.memory_note && wf.memory_note.slug === 'workflow-wf-v5-demo');

    const synthRow = env.db.prepare('SELECT prompt FROM tasks WHERE task_id = ?').get('wf-v5-demo_synth');
    assert.match(synthRow.prompt, /OUT-A:PROPOSAL-ALPHA/);
    assert.match(synthRow.prompt, /OUT-B:REDTEAM-BETA/);

    const rep = buildBatchMarkdownReport(env.db, 'wf-v5-demo');
    assert.equal(rep.task_count, 3);
    assert.match(rep.markdown, /# CollabHub Batch Report/);
    assert.match(rep.markdown, /OUT-B:REDTEAM-BETA/);
  } finally {
    env.cleanup();
  }
});

test('v5: adversarial-debate & multi-agent-build playbooks + v5 dashboard toolkit & batch report APIs', async () => {
  const env = makeTempEnv();
  execFileSync('git', ['init', '-b', 'main'], { cwd: env.proj });
  execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: env.proj });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: env.proj });
  fs.writeFileSync(path.join(env.proj, 'app.js'), 'export function runCheck() { return 42; }\n');
  execFileSync('git', ['add', '.'], { cwd: env.proj });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: env.proj });

  registerAgent(env.db, {
    agentId: 'deb-1', name: 'Debater 1', driver: 'generic-cli', roles: ['planner', 'reviewer', 'synthesizer', 'implementer'],
    config: { command: process.execPath, args: ['-e', 'console.log("DEB1-OK")'], timeout_s: 20 },
  });
  registerAgent(env.db, {
    agentId: 'deb-2', name: 'Debater 2', driver: 'generic-cli', roles: ['reviewer'],
    config: { command: process.execPath, args: ['-e', 'console.log("DEB2-REDTEAM")'], timeout_s: 20 },
  });

  const server = createDashboardServer(env.db, {
    host: '127.0.0.1', port: 0,
    dispatchDeps: {
      workspaceRoot: env.ws, extraRoots: [env.wts], worktreeRoot: env.wts, memoryDir: env.mem,
      reserveMailPaths: async () => ({ synced: false, reason: 'mock' }),
    },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const hdrs = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' };

  try {
    // 1. adversarial-debate playbook
    const deb = await runPlaybook(env.db, {
      playbook: 'adversarial-debate', projectDir: env.proj, goal: 'Pick DB engine', members: ['deb-1', 'deb-2'],
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem });
    assert.equal(deb.all_completed, true);
    assert.equal(deb.dispatched_count, 3);

    // 2. multi-agent-build playbook creates isolated worktree + runs implementer inside it
    const bld = await runPlaybook(env.db, {
      playbook: 'multi-agent-build', projectDir: env.proj, goal: 'Add check', members: ['deb-1'],
    }, {
      workspaceRoot: env.ws, extraRoots: [env.wts], worktreeRoot: env.wts,
      reserveMailPaths: async () => ({ synced: false, reason: 'mock' }),
    });
    assert.equal(bld.task.state, 'completed');
    assert.ok(fs.existsSync(bld.worktree.worktree_path));

    // 3. Dashboard v5 endpoints: /api/toolkit/ast (when installed), /api/batches/:id/report, /api/worktrees/review, /api/overview metrics
    if (getToolkitStatus().ast_grep.installed) {
      const astApi = await rawHttpRequest({
        port, method: 'POST', pathName: '/api/toolkit/ast', headers: hdrs,
        body: JSON.stringify({ project_dir: env.proj, pattern: 'export function $NAME($$$) { $$$ }', lang: 'js' }),
      });
      assert.equal(astApi.status, 200);
      assert.equal(JSON.parse(astApi.body).total_matches, 1);
    }

    const repApi = await rawHttpRequest({
      port, pathName: `/api/batches/${encodeURIComponent(deb.batch_id)}/report`,
      headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(repApi.status, 200);
    assert.match(JSON.parse(repApi.body).markdown, /DEB2-REDTEAM/);

    const wtRevApi = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/worktrees/review', headers: hdrs,
      body: JSON.stringify({ task_id: bld.worktree.task_id }),
    });
    assert.equal(wtRevApi.status, 200);
    assert.equal(JSON.parse(wtRevApi.body).exists, true);

    const ov = JSON.parse((await rawHttpRequest({ port, pathName: '/api/overview', headers: { Host: `127.0.0.1:${port}` } })).body);
    assert.ok(ov.metrics && ov.metrics.tasks_completed >= 4);
  } finally {
    server.close();
    env.cleanup();
  }
});

test('v6: Telemetry-aware smart routing + member="auto" + pre-dispatch autoFallback on cooldown', async () => {
  const env = makeTempEnv();
  try {
    registerAgent(env.db, {
      agentId: 'fast-good', name: 'Fast Good', driver: 'generic-cli', roles: ['reviewer'],
      config: { command: process.execPath, args: ['-e', 'console.log("FAST-GOOD-OK")'], timeout_s: 20 },
    });
    registerAgent(env.db, {
      agentId: 'cool-agent', name: 'Cooled Agent', driver: 'generic-cli', roles: ['reviewer'],
      config: { command: process.execPath, args: ['-e', 'console.log("SHOULD-FALLBACK")'], timeout_s: 20 },
    });
    upsertMemberStatus(env.db, { member: 'fast-good', channel: 'generic-cli', state: 'online', detail: 'ready' });
    setMemberCooldown(env.db, 'cool-agent', 600, 'Simulated 429', 'generic-cli');

    // 1. member="auto" picks fast-good and records routed_from="auto"
    const autoTask = await dispatchBackgroundTask(env.db, {
      taskId: 'v6-auto-1', member: 'auto', role: 'reviewer', projectDir: env.proj, prompt: 'review',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(autoTask.member, 'fast-good');
    assert.equal(autoTask.state, 'completed');
    assert.equal(autoTask.meta.routed_from, 'auto');

    // 2. autoFallback reroutes pre-dispatch away from cooled agent
    const fbTask = await dispatchBackgroundTask(env.db, {
      taskId: 'v6-fb-1', member: 'cool-agent', role: 'reviewer', projectDir: env.proj, prompt: 'review', autoFallback: true,
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(fbTask.member, 'fast-good');
    assert.equal(fbTask.state, 'completed');
    assert.match(fbTask.meta.routed_from, /cool-agent\(cooldown\)/);

    // 3. Telemetry reflects 2/2 completed (100% success rate, positive reliability_delta)
    const tele = computeAgentTelemetry(env.db, { days: 7 });
    assert.equal(tele.agents['fast-good'].completed, 2);
    assert.equal(tele.agents['fast-good'].success_rate, 1);
    assert.ok(tele.agents['fast-good'].reliability_delta > 0);
  } finally {
    env.cleanup();
  }
});

test('v6: Built-in & custom Prompt Recipes CRUD + built-in deletion guard', () => {
  const env = makeTempEnv();
  try {
    const initial = listRecipes(env.db);
    assert.ok(initial.length >= 6);
    assert.ok(initial.some((r) => r.recipe_id === 'security-redteam' && r.builtin));

    // Built-in recipes cannot be deleted
    assert.throws(() => deleteRecipe(env.db, 'security-redteam'), /Cannot delete built-in/i);

    // Custom recipe CRUD
    const saved = saveRecipe(env.db, { recipeId: 'my-custom', title: 'My Check', role: 'tester', tags: 'unit', prompt: 'Run checks' });
    assert.equal(saved.recipe_id, 'my-custom');
    assert.equal(saved.builtin, false);

    const del = deleteRecipe(env.db, 'my-custom');
    assert.equal(del.deleted, true);
  } finally {
    env.cleanup();
  }
});

test('v6: Hot SQLite backup (VACUUM INTO), workspace project lister, and 8-point Doctor', async () => {
  const env = makeTempEnv();
  const backupDir = path.join(env.dir, 'backups');
  try {
    const projects = listWorkspaceProjects(env.ws);
    assert.ok(projects.some((p) => p.name === 'demo-proj'));

    const bk = createHotBackup(env.db, { backupDir, keepLast: 3 });
    assert.equal(bk.ok, true);
    assert.ok(fs.existsSync(bk.backup_path));
    assert.ok(bk.size_bytes > 0);

    const doc = await runSystemDoctor(env.db, { dbPath: path.join(env.dir, 'hub.db'), worktreeDir: env.wts });
    assert.equal(doc.total_checks, 8);
    assert.ok(doc.checks.some((c) => c.id === 'sqlite_integrity' && c.status === 'pass'));
  } finally {
    env.cleanup();
  }
});

test('v6: Dashboard SSE /api/events/stream push, /api/events, /api/workspaces, /api/recipes, /api/doctor & backup', async () => {
  const env = makeTempEnv();
  const backupDir = path.join(env.dir, 'backups');
  const server = createDashboardServer(env.db, {
    host: '127.0.0.1', port: 0,
    dispatchDeps: { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem, backupDir },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const hdrs = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' };

  try {
    const [wsRes, rcRes, evRes, bkRes] = await Promise.all([
      rawHttpRequest({ port, pathName: '/api/workspaces', headers: { Host: `127.0.0.1:${port}` } }),
      rawHttpRequest({ port, pathName: '/api/recipes', headers: { Host: `127.0.0.1:${port}` } }),
      rawHttpRequest({ port, pathName: '/api/events?limit=10', headers: { Host: `127.0.0.1:${port}` } }),
      rawHttpRequest({ port, method: 'POST', pathName: '/api/system/backup', headers: hdrs, body: '{}' }),
    ]);
    assert.equal(wsRes.status, 200);
    assert.ok(JSON.parse(wsRes.body).projects.some((p) => p.name === 'demo-proj'));
    assert.equal(rcRes.status, 200);
    assert.ok(JSON.parse(rcRes.body).recipes.length >= 6);
    assert.equal(evRes.status, 200);
    assert.equal(bkRes.status, 200);
    assert.equal(JSON.parse(bkRes.body).ok, true);

    // Verify live SSE stream receives initial connected frame + live event push
    const sseChunk = await new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/api/events/stream', headers: { Host: `127.0.0.1:${port}` } }, (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          if (buf.includes('connected') && buf.includes('recipe.saved')) {
            req.destroy();
            resolve(buf);
          } else if (buf.includes('connected') && !buf.includes('__triggered')) {
            buf += '__triggered';
            saveRecipe(env.db, { recipeId: 'sse-test', title: 'SSE Test', prompt: 'ping' });
          }
        });
      });
      req.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
      req.end();
      setTimeout(() => { req.destroy(); reject(new Error('SSE test timed out')); }, 3000);
    });
    assert.match(sseChunk, /recipe\.saved/);
  } finally {
    server.close();
    env.cleanup();
  }
});

test('v1.0: .worktreeinclude safe env sync (blocks traversal) + closed-loop verifyWorktree test gate', async () => {
  const env = makeTempEnv();
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: env.proj });
    execFileSync('git', ['config', 'user.email', 'test@local'], { cwd: env.proj });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: env.proj });
    fs.writeFileSync(path.join(env.proj, 'package.json'), JSON.stringify({ name: 'demo', type: 'module', scripts: { test: 'node --test' } }));
    fs.writeFileSync(path.join(env.proj, 'sample.test.mjs'), "import test from 'node:test'; import assert from 'node:assert/strict'; test('ok', () => assert.equal(1+1, 2));\n");
    fs.writeFileSync(path.join(env.proj, '.worktreeinclude'), '# local files\n.env.local\n../escape.txt\n.git/config\n');
    execFileSync('git', ['add', 'package.json', 'sample.test.mjs', '.worktreeinclude'], { cwd: env.proj });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: env.proj });
    // Untracked local file & outside file
    fs.writeFileSync(path.join(env.proj, '.env.local'), 'PORT=9999\n');
    fs.writeFileSync(path.join(env.ws, 'escape.txt'), 'NOPE\n');

    const wt = createWorktree(env.db, {
      repoDir: env.proj, taskId: 'wt-verify-1', member: 'dsh', worktreeRoot: env.wts, workspaceRoot: env.ws,
    });
    // .env.local synced; traversal & .git entries safely ignored!
    assert.deepEqual(wt.synced_files, ['.env.local']);
    assert.equal(fs.readFileSync(path.join(wt.worktree_path, '.env.local'), 'utf8').trim(), 'PORT=9999');

    // Run real closed-loop allowlisted node-test gate inside worktree
    const ver = await verifyWorktree(env.db, { taskId: 'wt-verify-1', preset: 'auto' });
    assert.equal(ver.passed, true);
    assert.equal(ver.status, 'passed');
    assert.equal(ver.preset, 'node-test');

    // Reject unknown preset (no arbitrary shell!)
    await assert.rejects(() => verifyWorktree(env.db, { taskId: 'wt-verify-1', preset: 'rm -rf /' }), /Unsupported verify preset/i);

    const dbRow = env.db.prepare('SELECT verify_status, verified_head_sha FROM worktrees WHERE task_id = ?').get('wt-verify-1');
    assert.equal(dbRow.verify_status, 'passed');
    assert.equal(dbRow.verified_head_sha, ver.head_sha);
  } finally {
    env.cleanup();
  }
});

test('v1.0: Real token usage telemetry aggregation + Kanban board HTML & /api/worktrees/verify', async () => {
  const env = makeTempEnv();
  const server = createDashboardServer(env.db, {
    host: '127.0.0.1', port: 0,
    dispatchDeps: { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const now = new Date().toISOString();
    env.db.prepare(`
      INSERT INTO tasks (task_id, project_dir, member, role, channel, title, prompt, state, evidence_json, created_at, updated_at, completed_at)
      VALUES ('tok-1', ?, 'codex', 'reviewer', 'openai-http', 'Tok Test', 'p', 'completed', ?, ?, ?, ?)
    `).run(env.proj, JSON.stringify({ model: 'm', usage: { prompt_tokens: 1200, completion_tokens: 300, total_tokens: 1500 } }), now, now, now);

    const tele = computeAgentTelemetry(env.db, { days: 30 });
    assert.equal(tele.total_tokens, 1500);
    assert.equal(tele.agents.codex.prompt_tokens, 1200);
    assert.equal(tele.agents.codex.completion_tokens, 300);

    const html = (await rawHttpRequest({ port, pathName: '/', headers: { Host: `127.0.0.1:${port}` } })).body;
    assert.match(html, /tasksKanbanWrap/);
    assert.match(html, /btnViewKanban/);
    assert.match(html, /CollabHub v1\.1/);
  } finally {
    server.close();
    env.cleanup();
  }
});

test('v1.1: static assets served from jailed public allowlist with strict CSP', async () => {
  const env = makeTempEnv();
  const server = createDashboardServer(env.db, {
    host: '127.0.0.1', port: 0,
    dispatchDeps: { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const host = `127.0.0.1:${port}`;
  try {
    // Every allowlisted asset: exact MIME, strict CSP (no script-src unsafe-inline).
    for (const [pathName, expectedType] of [['/assets/styles.css', 'text/css'], ['/assets/app.js', 'text/javascript']]) {
      const res = await rawHttpRequest({ port, pathName, headers: { Host: host } });
      assert.equal(res.status, 200, `${pathName} must be served`);
      assert.match(String(res.headers['content-type']), new RegExp(expectedType));
      const csp = String(res.headers['content-security-policy']);
      assert.ok(csp.includes("script-src 'self'"), `${pathName} CSP must lock script-src to 'self'`);
      assert.ok(csp.includes("base-uri 'none'") && csp.includes("frame-ancestors 'none'"));
      assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
      assert.ok(res.body.length > 0);

      const headRes = await rawHttpRequest({ port, method: 'HEAD', pathName, headers: { Host: host } });
      assert.equal(headRes.status, 200);
      assert.equal(headRes.body, '');
    }

    // Jail: traversal (plain + encoded), null byte, and non-allowlisted names all 404.
    for (const bad of [
      '/assets/../package.json',
      '/assets/app.js%00.txt',
      '/assets/nope.css',
      '/assets/%2e%2e%2fpackage.json',
      '/assets/..%2fapp.js',
      '/assets/%00index.html',
    ]) {
      const res = await rawHttpRequest({ port, pathName: bad, headers: { Host: host } });
      assert.equal(res.status, 404, `${bad} must be 404, got ${res.status}`);
    }
  } finally {
    server.close();
    env.cleanup();
  }
});

test('v1.1: read-only demo overview is anonymized with zero personal paths', async () => {
  const env = makeTempEnv();
  const server = createDashboardServer(env.db, {
    host: '127.0.0.1', port: 0,
    dispatchDeps: { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    // Seed a real DB canary note to prove ?demo=1 NEVER reads or leaks real DB data (Codex P0 audit)
    writeMemoryNote(env.db, {
      project: 'canary-private',
      title: 'CANARY-REAL-DB-SECRET-999',
      content: 'MUST_NEVER_APPEAR_IN_DEMO_MODE',
      memoryDir: env.mem,
    });

    const res = await rawHttpRequest({ port, pathName: '/api/overview?demo=1', headers: { Host: `127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(body.includes('CANARY-REAL-DB-SECRET-999'), false);
    assert.equal(body.includes('MUST_NEVER_APPEAR_IN_DEMO_MODE'), false);
    const demo = JSON.parse(body);

    assert.equal(demo.demo, true);
    assert.equal(demo.members.length, 4);
    assert.equal(demo.tasks.length, 6);

    // At least one task in every Kanban column.
    const states = new Set(demo.tasks.map((t) => t.state));
    const groups = {
      queued: ['created', 'dispatching', 'dispatched'],
      running: ['running'],
      attention: ['stalled', 'uncertain', 'needs_input'],
      done: ['completed', 'failed', 'rerouted'],
    };
    for (const [group, allowed] of Object.entries(groups)) {
      assert.ok([...states].some((s) => allowed.includes(s)), `no demo task in Kanban group ${group} (states: ${[...states].join(',')})`);
    }

    assert.equal(demo.worktrees.length, 1);
    assert.equal(demo.worktrees[0].verify_status, 'passed');
    assert.equal(demo.notes.length, 2);
    assert.equal(Object.keys(demo.telemetry.agents).length, 4);
    assert.equal(demo.metrics.tasks_total, 6);

    // Privacy: no personal paths, no drive letters, no IPs, no localhost, no relative escapes.
    assert.doesNotMatch(body, /\/home\/|\/Users\/|\/mnt\/|[A-Za-z]:\\|\b127\.0\.0\.1\b|\blocalhost\b|\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    assert.ok(!body.includes(os.homedir()), 'demo payload must not contain the real home directory');
    assert.ok(!body.includes('../'), 'demo payload must not contain a .. traversal segment');
  } finally {
    server.close();
    env.cleanup();
  }
});

test('v1.2: live CLI streaming logs (hubBus + getTaskLogs) and real cancelTask process abort', async () => {
  const env = makeTempEnv();
  const seenLogs = [];
  const onEvt = (evt) => { if (evt.type === 'task.log') seenLogs.push(evt); };
  hubBus.on('hub-event', onEvt);
  try {
    // 1. Streaming logs captured on normal CLI completion
    registerAgent(env.db, {
      agentId: 'log-cli', name: 'Log CLI', driver: 'generic-cli', roles: ['implementer'],
      config: { command: process.execPath, args: ['-e', 'console.log("STREAM-LINE-1"); console.error("STREAM-ERR-2");'], timeout_s: 20 },
    });
    const done = await dispatchBackgroundTask(env.db, {
      taskId: 'v12-log-ok', member: 'log-cli', role: 'implementer', projectDir: env.proj, title: 'Log stream test', prompt: 'run',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });
    assert.equal(done.state, 'completed');
    const logs = getTaskLogs('v12-log-ok');
    assert.equal(logs.active, false);
    assert.ok(logs.logs.some((e) => e.stream === 'stdout' && e.text.includes('STREAM-LINE-1')));
    assert.ok(logs.logs.some((e) => e.stream === 'stderr' && e.text.includes('STREAM-ERR-2')));
    assert.ok(seenLogs.some((e) => e.task_id === 'v12-log-ok' && e.text.includes('STREAM-LINE-1')));

    // 2. Live cancel aborts a long-running CLI process cleanly
    registerAgent(env.db, {
      agentId: 'slow-cli', name: 'Slow CLI', driver: 'generic-cli', roles: ['implementer'],
      config: { command: process.execPath, args: ['-e', 'console.log("SLOW-STARTED"); setTimeout(() => console.log("NEVER"), 20000);'], timeout_s: 30 },
    });
    const runPromise = dispatchBackgroundTask(env.db, {
      taskId: 'v12-slow-abort', member: 'slow-cli', role: 'implementer', projectDir: env.proj, title: 'Cancel target', prompt: 'wait',
    }, { workspaceRoot: env.ws, extraRoots: [env.wts] });

    // Wait until the live process is active in ACTIVE_RUNS
    const deadline = Date.now() + 5000;
    while (!getTaskLogs('v12-slow-abort').active && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    assert.equal(getTaskLogs('v12-slow-abort').active, true);

    const cancelled = await cancelTask(env.db, 'v12-slow-abort', { reason: 'User clicked abort' });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.aborted_live_process, true);
    assert.equal(cancelled.task.state, 'cancelled');

    const settled = await runPromise;
    assert.equal(settled.state, 'cancelled');
    await assert.rejects(() => cancelTask(env.db, 'v12-slow-abort'), /terminal state=cancelled/i);
  } finally {
    hubBus.off('hub-event', onEvt);
    env.cleanup();
  }
});

test('v1.2: resumeDagWorkflow skips completed steps, retries failed + downstream with append-only IDs', async () => {
  const env = makeTempEnv();
  const flagFile = path.join(env.dir, 'allow-step-b.flag');
  try {
    registerAgent(env.db, {
      agentId: 'wf-ok', name: 'WF OK', driver: 'generic-cli', roles: ['planner', 'synthesizer'],
      config: { command: process.execPath, args: ['-e', 'process.stdout.write("OK:" + process.argv[1].slice(0, 140))', '{{prompt}}'], timeout_s: 20 },
    });
    registerAgent(env.db, {
      agentId: 'wf-flaky', name: 'WF Flaky', driver: 'generic-cli', roles: ['reviewer'],
      config: {
        command: process.execPath,
        args: ['-e', `const fs=require("fs"); if(!fs.existsSync(${JSON.stringify(flagFile)})){console.error("BOOM-ONCE"); process.exit(2);} process.stdout.write("RECOVERED-B");`],
        timeout_s: 20,
      },
    });

    const first = await runDagWorkflow(env.db, {
      name: 'checkpoint-test',
      batchId: 'wf-v12-resume',
      projectDir: env.proj,
      steps: [
        { id: 'plan', member: 'wf-ok', role: 'planner', prompt: 'STEP-A' },
        { id: 'check', member: 'wf-flaky', role: 'reviewer', prompt: 'STEP-B' },
        { id: 'synth', member: 'wf-ok', role: 'synthesizer', depends_on: ['plan', 'check'], prompt: 'FINAL-C' },
      ],
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem });

    assert.equal(first.all_completed, false);
    assert.equal(first.pending_steps.length, 1);
    assert.equal(first.pending_steps[0].step, 'synth');

    // Now unblock flaky step and also insert the blocked synth step? Wait: synth wasn't dispatched yet, let's test resuming failed step!
    fs.writeFileSync(flagFile, 'ok');
    const resumed = await resumeDagWorkflow(env.db, {
      batchId: 'wf-v12-resume',
      waitSec: 10,
    }, { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem });

    assert.equal(resumed.resumed, true);
    assert.deepEqual(resumed.skipped_completed, ['wf-v12-resume_plan']);
    assert.equal(resumed.retried_steps.length, 2);
    assert.equal(resumed.retried_steps[0].previous_task_id, 'wf-v12-resume_check');
    assert.equal(resumed.retried_steps[0].task_id, 'wf-v12-resume_check_r2');
    assert.equal(resumed.retried_steps[0].state, 'completed');
    assert.equal(resumed.retried_steps[1].task_id, 'wf-v12-resume_synth');
    assert.equal(resumed.retried_steps[1].state, 'completed');
    assert.equal(resumed.all_completed, true);

    // Downstream synth step inherited BOTH original completed plan AND recovered check_r2!
    const synthRow = env.db.prepare('SELECT prompt FROM tasks WHERE task_id = ?').get('wf-v12-resume_synth');
    assert.match(synthRow.prompt, /OK:STEP-A/);
    assert.match(synthRow.prompt, /RECOVERED-B/);
  } finally {
    env.cleanup();
  }
});

test('v1.2: Dashboard /api/tasks/logs, /api/tasks/cancel, /api/workflows/resume & CSRF enforcement', async () => {
  const env = makeTempEnv();
  const server = createDashboardServer(env.db, {
    host: '127.0.0.1', port: 0,
    dispatchDeps: { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem },
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const hdrs = { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'X-CollabHub-CSRF': '1' };
  try {
    // Seed a running task and a failed batch task
    const now = new Date().toISOString();
    env.db.prepare(`
      INSERT INTO tasks (task_id, batch_id, project_dir, member, role, channel, title, prompt, state, created_at, updated_at)
      VALUES ('api-cancel-1', 'b-api', ?, 'dsh', 'implementer', 'dsh-baton', 'Running task', 'work', 'running', ?, ?)
    `).run(env.proj, now, now);

    // 1. GET /api/tasks/logs works without hitting /api/tasks/:id 404
    const logsRes = await rawHttpRequest({
      port, pathName: '/api/tasks/logs?task_id=api-cancel-1', headers: { Host: `127.0.0.1:${port}` },
    });
    assert.equal(logsRes.status, 200);
    assert.equal(JSON.parse(logsRes.body).task_id, 'api-cancel-1');

    // 2. POST /api/tasks/cancel blocks missing CSRF header (403)
    const noCsrf = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/tasks/cancel',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id: 'api-cancel-1' }),
    });
    assert.equal(noCsrf.status, 403);

    // 3. POST /api/tasks/cancel refuses unconfirmed out-of-process cancel without force=true (Codex P1 #1)
    const cancelRefused = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/tasks/cancel', headers: hdrs,
      body: JSON.stringify({ task_id: 'api-cancel-1', reason: 'Dashboard stop' }),
    });
    assert.equal(cancelRefused.status, 400);

    // 4. POST /api/tasks/cancel with force=true cancels cleanly
    const cancelRes = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/tasks/cancel', headers: hdrs,
      body: JSON.stringify({ task_id: 'api-cancel-1', reason: 'Dashboard stop', force: true }),
    });
    assert.equal(cancelRes.status, 200);
    assert.equal(JSON.parse(cancelRes.body).task.state, 'cancelled');

    // 5. POST /api/workflows/resume requires batch_id and refuses to retry uncertain tasks (Codex P1 #2)
    const resumeBad = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/workflows/resume', headers: hdrs,
      body: JSON.stringify({}),
    });
    assert.equal(resumeBad.status, 400);

    env.db.prepare(`
      INSERT INTO tasks (task_id, batch_id, project_dir, member, role, channel, title, prompt, state, created_at, updated_at)
      VALUES ('uncertain-1', 'b-uncertain', ?, 'dsh', 'implementer', 'dsh-baton', 'Uncertain task', 'work', 'uncertain', ?, ?)
    `).run(env.proj, now, now);
    const resumeUncertain = await rawHttpRequest({
      port, method: 'POST', pathName: '/api/workflows/resume', headers: hdrs,
      body: JSON.stringify({ batch_id: 'b-uncertain' }),
    });
    assert.equal(resumeUncertain.status, 200);
    const uBody = JSON.parse(resumeUncertain.body);
    assert.equal(uBody.resumed, false);
    assert.deepEqual(uBody.blocked_uncertain, ['uncertain-1']);

    // 6. Three-step workflow_plans persistence: step 1 completed, steps 2-3 undispatched -> resume advances them instead of false all_completed (Codex P1 #3 & #4)
    registerAgent(env.db, {
      agentId: 'step-cli', name: 'Step CLI', driver: 'generic-cli', roles: ['planner', 'implementer', 'synthesizer'],
      config: { command: process.execPath, args: ['-e', 'process.stdout.write("DONE:" + process.argv[1])', '{{prompt}}'], timeout_s: 20 },
    });
    env.db.prepare(`
      INSERT INTO workflow_plans (batch_id, name, project_dir, plan_json, created_at)
      VALUES ('b-partial', 'three-step', ?, ?, ?)
    `).run(env.proj, JSON.stringify({
      batch_id: 'b-partial',
      name: 'three-step',
      project_dir: env.proj,
      steps: [
        { stepId: 's1', taskId: 'b-partial_s1', member: 'step-cli', role: 'planner', title: 'S1', prompt: 'RAW-S1', dependsOnTaskIds: [], autoInjectContext: true, reservePaths: [] },
        { stepId: 's2', taskId: 'b-partial_s2', member: 'step-cli', role: 'implementer', title: 'S2', prompt: 'RAW-S2', dependsOnTaskIds: ['b-partial_s1'], autoInjectContext: false, reservePaths: [] },
      ],
    }), now);
    env.db.prepare(`
      INSERT INTO tasks (task_id, batch_id, project_dir, member, role, channel, title, prompt, state, result_text, created_at, updated_at, completed_at)
      VALUES ('b-partial_s1', 'b-partial', ?, 'step-cli', 'planner', 'generic-cli', 'S1', 'RAW-S1', 'completed', 'OUT-S1', ?, ?, ?)
    `).run(env.proj, now, now, now);
    const partialResumed = await resumeDagWorkflow(env.db, { batchId: 'b-partial', waitSec: 10 }, { workspaceRoot: env.ws, extraRoots: [env.wts], memoryDir: env.mem });
    assert.equal(partialResumed.resumed, true);
    assert.equal(partialResumed.all_completed, true);
    const s2Row = env.db.prepare('SELECT prompt FROM tasks WHERE task_id = ?').get('b-partial_s2');
    assert.equal(s2Row.prompt, 'RAW-S2', 'autoInjectContext=false must be preserved on resume');
  } finally {
    server.close();
    env.cleanup();
  }
});
