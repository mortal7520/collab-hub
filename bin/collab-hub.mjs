#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAutostartStatus, installAutostart, removeAutostart } from '../src/autostart.mjs';
import {
  APP_ROOT, APP_VERSION, DASHBOARD_HOST, DASHBOARD_PORT, WORKSPACE_ROOT, ensureRuntimeDirs,
} from '../src/config.mjs';
import { createDashboardServer, startReadOnlyAutoPoller } from '../src/dashboard.mjs';
import { openHubDb, openHubDbReadOnly, parseTaskRow, pruneRetentionTables } from '../src/db.mjs';
import { discoverLocalAgents } from '../src/discovery.mjs';
import { createHotBackup, listWorkspaceProjects, runSystemDoctor } from '../src/doctor.mjs';
import { deleteArtifact, getArtifact, listArtifacts, pruneExpiredArtifacts, putArtifact } from '../src/artifacts.mjs';
import { deleteBudgetPolicy, evaluateBudget, listBudgetPolicies, setBudgetPolicy } from '../src/budget.mjs';
import { createConsensusRound, listConsensusRounds, recordConsensusVote, synthesizeConsensus } from '../src/consensus.mjs';
import { cancelTask, dispatchBackgroundTask, getTaskLogs, pollBackgroundTask, pollBatchTasks, sweepOrphanTasks } from '../src/executors.mjs';
import { buildHandoffPack } from '../src/handoff-pack.mjs';
import { runHudCli } from '../src/hud.mjs';
import { getLiveAgentUsageAsync } from '../src/live-usage.mjs';
import { installNativePlugins, planPluginInstall } from '../src/plugin-installer.mjs';
import { planDispatch, probeAllMembers } from '../src/prober.mjs';
import { startMcpStdioServer } from '../src/mcp-server.mjs';
import { buildMcpHubSnapshot, findMcpTools, importDiscoveredMcpServers, probeMcpServer, syncMcpToClient } from '../src/mcp-hub.mjs';
import { listMemoryNotes, searchMemoryNotes, writeMemoryNote } from '../src/memory.mjs';
import { enqueueMergeQueue, listMergeQueue, processMergeQueue, validateMergeQueue } from '../src/merge-queue.mjs';
import { runPlaybook } from '../src/playbooks.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from '../src/recipes.mjs';
import { listAgents, registerAgent, removeAgent } from '../src/registry.mjs';
import { applySelfHeal, diagnoseSystem, listIncidentLessons, reconcileStaleTasks, saveIncidentLesson, toggleIncidentLesson } from '../src/self-improve.mjs';
import { buildSkillsRulesSnapshot, syncRuleAcrossTargets, syncSkillAcrossClients } from '../src/skills-hub.mjs';
import { computeAgentTelemetry } from '../src/telemetry.mjs';
import {
  convertDocToMd, getCassStats, getToolkitStatus, packRepoRepomix,
  reindexSessionsCass, runBeads, searchAstGrep, searchSessionsCass,
} from '../src/toolkit.mjs';
import { deleteTrigger, listTriggers, runTriggerNow, saveTrigger, startTriggerScheduler } from '../src/triggers.mjs';
import { applySetup, planSetup } from '../src/setup.mjs';
import { startInteractiveTui } from '../src/tui.mjs';
import { VALID_WEBHOOK_FORMATS, deleteWebhook, deliverWebhook, listWebhooks, saveWebhook, startWebhookDispatcher } from '../src/webhooks.mjs';
import { buildBatchMarkdownReport, resumeDagWorkflow, runDagWorkflow } from '../src/workflows.mjs';
import {
  appendRoomLog, claimRoomPath, createCollabRoom, getRoomStatus, listCollabRooms,
  promoteInboxFile, reconcileStaleClaimsInAllRooms, releaseRoomClaim, renewRoomClaim,
} from '../src/workspace-room.mjs';
import { verifyWorktree } from '../src/worktree.mjs';

const [cmd, ...rawArgs] = process.argv.slice(2);

if (cmd === 'mcp') {
  const profIdx = rawArgs.indexOf('--profile');
  const profile = profIdx >= 0 && rawArgs[profIdx + 1] ? rawArgs[profIdx + 1] : null;
  const toolsIdx = rawArgs.indexOf('--tools');
  const allowlist = toolsIdx >= 0 && rawArgs[toolsIdx + 1]
    ? rawArgs[toolsIdx + 1].split(',').map((s) => s.trim()).filter(Boolean)
    : null;
  startMcpStdioServer({ profile, allowlist });
} else if (cmd === 'start') {
  ensureRuntimeDirs();
  const db = openHubDb();
  pruneRetentionTables(db);
  sweepOrphanTasks(db);
  const portIdx = rawArgs.indexOf('--port');
  const port = portIdx >= 0 && rawArgs[portIdx + 1] ? Number(rawArgs[portIdx + 1]) : DASHBOARD_PORT;
  const server = createDashboardServer(db, { host: DASHBOARD_HOST, port });
  let poller = null;
  let triggerSched = null;
  let webhookDisp = null;
  const gracefulExit = async () => {
    poller?.stop();
    triggerSched?.stop();
    webhookDisp?.stop();
    await server.shutdown();
    try { db.close(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT', gracefulExit);
  process.on('SIGTERM', gracefulExit);
  server.listen(port, DASHBOARD_HOST, () => {
    console.log(JSON.stringify({
      event: 'dashboard.listening',
      version: APP_VERSION,
      url: `http://${DASHBOARD_HOST}:${port}`,
      app_root: APP_ROOT,
      workspace_root: WORKSPACE_ROOT,
      pid: process.pid,
    }));
    probeAllMembers(db).catch(() => {});
    poller = startReadOnlyAutoPoller(db);
    triggerSched = startTriggerScheduler(db);
    webhookDisp = startWebhookDispatcher(db);
  });
} else {
  const isReadOnlyUi = cmd === 'hud' || cmd === 'tui';
  if (!isReadOnlyUi) ensureRuntimeDirs();
  const db = isReadOnlyUi ? openHubDbReadOnly() : openHubDb();

  function parseArgs(argv) {
    const positionals = [];
    const flags = {};
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i];
      if (token.startsWith('--') && token.length > 2) {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags[key] = next;
          i += 1;
        } else {
          flags[key] = true;
        }
      } else {
        positionals.push(token);
      }
    }
    return { positionals, flags };
  }

  const { positionals, flags } = parseArgs(rawArgs);
  const flag = (name, fallback = null) => (flags[name] !== undefined && flags[name] !== true ? flags[name] : fallback);

  try {
    if (cmd === 'init') {
      console.log(JSON.stringify({ ok: true, app_root: APP_ROOT, workspace_root: WORKSPACE_ROOT, initialized: true }, null, 2));
    } else if (cmd === 'probe' || cmd === 'roster') {
      console.log(JSON.stringify({ ...(await probeAllMembers(db)), toolkit: getToolkitStatus() }, null, 2));
    } else if (cmd === 'agents' || cmd === 'agent') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') {
        console.log(JSON.stringify(listAgents(db, { includeDisabled: true }), null, 2));
      } else if (sub === 'add') {
        const agentId = flag('id') || positionals[1];
        const name = flag('name') || positionals[2] || agentId;
        const driver = flag('driver') || positionals[3];
        const cfgRaw = flag('config', '{}');
        console.log(JSON.stringify(registerAgent(db, {
          agentId,
          name,
          driver,
          roles: String(flag('roles', 'researcher,reviewer')).split(',').map((s) => s.trim()).filter(Boolean),
          config: JSON.parse(cfgRaw),
        }), null, 2));
      } else if (sub === 'remove') {
        console.log(JSON.stringify(removeAgent(db, flag('id') || positionals[1]), null, 2));
      } else {
        throw new Error(`Unknown agents subcommand "${sub}". Use: list | add | remove`);
      }
    } else if (cmd === 'tasks') {
      const taskId = positionals[0] || flag('id');
      if (taskId) {
        const row = parseTaskRow(db.prepare('SELECT * FROM tasks WHERE task_id = ?').get(taskId));
        const events = row ? db.prepare('SELECT * FROM events WHERE task_id = ? ORDER BY id DESC LIMIT 30').all(taskId) : [];
        console.log(JSON.stringify({ task: row, events }, null, 2));
      } else {
        const lim = Math.max(1, Math.min(100, Number(flag('limit', '20'))));
        const rows = db.prepare('SELECT * FROM tasks ORDER BY updated_at DESC LIMIT ?').all(lim).map(parseTaskRow);
        console.log(JSON.stringify({ count: rows.length, tasks: rows }, null, 2));
      }
    } else if (cmd === 'memory') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') {
        console.log(JSON.stringify(listMemoryNotes(db, { project: flag('project'), limit: Number(flag('limit', '20')) }), null, 2));
      } else if (sub === 'search') {
        const q = positionals.slice(1).join(' ') || flag('query', '');
        console.log(JSON.stringify(searchMemoryNotes(db, { query: q, project: flag('project'), limit: Number(flag('limit', '15')) }), null, 2));
      } else if (sub === 'write') {
        console.log(JSON.stringify(writeMemoryNote(db, {
          project: flag('project', 'workspace'),
          slug: flag('slug'),
          title: flag('title'),
          content: flag('content'),
          tags: String(flag('tags', '')).split(',').map((s) => s.trim()).filter(Boolean),
          author: flag('author', 'cli'),
        }), null, 2));
      } else {
        throw new Error(`Unknown memory subcommand "${sub}". Use: list | search | write`);
      }
    } else if (cmd === 'dispatch') {
      console.log(JSON.stringify(await dispatchBackgroundTask(db, {
        member: flag('member') || 'auto',
        role: flag('role', 'researcher'),
        projectDir: flag('dir') || process.cwd(),
        title: flag('title'),
        prompt: flag('prompt'),
        batchId: flag('batch'),
        autoFallback: Boolean(flags.fallback),
        waitSec: Number(flag('wait', '0')),
      }), null, 2));
    } else if (cmd === 'poll') {
      console.log(JSON.stringify(await pollBackgroundTask(db, positionals[0] || flag('id'), { waitSec: Number(flag('wait', '10')) }), null, 2));
    } else if (cmd === 'poll-batch') {
      console.log(JSON.stringify(await pollBatchTasks(db, { batchId: positionals[0] || flag('batch'), waitSec: Number(flag('wait', '10')) }), null, 2));
    } else if (cmd === 'cancel') {
      console.log(JSON.stringify(await cancelTask(db, positionals[0] || flag('id'), {
        reason: flag('reason', 'Cancelled via CLI'),
        force: Boolean(flags.force),
      }), null, 2));
    } else if (cmd === 'logs') {
      console.log(JSON.stringify(getTaskLogs(positionals[0] || flag('id'), db), null, 2));
    } else if (cmd === 'resume') {
      console.log(JSON.stringify(await resumeDagWorkflow(db, {
        batchId: positionals[0] || flag('batch'),
        waitSec: Number(flag('wait', '15')),
        saveReportToMemory: !flags['no-memory'],
      }), null, 2));
    } else if (cmd === 'verify-worktree') {
      console.log(JSON.stringify(await verifyWorktree(db, {
        taskId: positionals[0] || flag('id'),
        preset: flag('preset', 'auto'),
      }), null, 2));
    } else if (cmd === 'pack') {
      console.log(JSON.stringify(await packRepoRepomix({
        projectDir: positionals[0] || flag('dir') || process.cwd(),
        include: flag('include'),
        ignore: flag('ignore'),
        maxChars: Number(flag('max-chars', '24000')),
      }), null, 2));
    } else if (cmd === 'ast') {
      console.log(JSON.stringify(await searchAstGrep({
        projectDir: flag('dir') || process.cwd(),
        pattern: positionals[0] || flag('pattern'),
        lang: flag('lang'),
        maxMatches: Number(flag('max', '40')),
      }), null, 2));
    } else if (cmd === 'sessions') {
      const query = positionals.join(' ') || flag('query', '');
      console.log(JSON.stringify(await searchSessionsCass({
        query,
        limit: Number(flag('limit', '8')),
        agent: flag('agent'),
      }), null, 2));
    } else if (cmd === 'cass-index') {
      console.log(JSON.stringify(await reindexSessionsCass({ full: Boolean(flags.full) }), null, 2));
    } else if (cmd === 'doc2md') {
      console.log(JSON.stringify(await convertDocToMd({ filePath: positionals[0] || flag('file'), maxChars: Number(flag('max-chars', '32000')) }), null, 2));
    } else if (cmd === 'beads') {
      console.log(JSON.stringify(await runBeads({
        projectDir: flag('dir') || process.cwd(),
        action: positionals[0] || 'list',
        title: flag('title'),
        description: flag('desc'),
        issueId: flag('id'),
      }), null, 2));
    } else if (cmd === 'playbook') {
      const pbName = positionals[0];
      const pbDir = flag('dir') || positionals[1] || process.cwd();
      const membersRaw = flag('members');
      console.log(JSON.stringify(await runPlaybook(db, {
        playbook: pbName,
        projectDir: pbDir,
        goal: flag('goal', ''),
        members: membersRaw ? membersRaw.split(',').map((s) => s.trim()).filter(Boolean) : null,
        include: flag('include'),
        astPattern: flag('ast'),
        astLang: flag('lang'),
        docPath: flag('doc'),
        sessionQuery: flag('sessions') || flag('query'),
      }), null, 2));
    } else if (cmd === 'discover') {
      console.log(JSON.stringify(await discoverLocalAgents(db), null, 2));
    } else if (cmd === 'doctor') {
      const rep = await runSystemDoctor(db);
      if (flags.backup) rep.backup = createHotBackup(db);
      console.log(JSON.stringify(rep, null, 2));
    } else if (cmd === 'self-check') {
      console.log(JSON.stringify(diagnoseSystem(db), null, 2));
    } else if (cmd === 'self-heal') {
      if (flags.apply !== undefined && flags.apply !== true && flags.apply !== 'true' && flags.apply !== 'false') {
        throw new Error('--apply accepts only true/false or bare flag');
      }
      console.log(JSON.stringify(applySelfHeal(db, {
        apply: flags.apply === true || flags.apply === 'true',
        recordLessons: flags['no-lessons'] ? false : true,
      }), null, 2));
    } else if (cmd === 'lessons') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify({ lessons: listIncidentLessons(db) }, null, 2));
      else if (sub === 'save') {
        console.log(JSON.stringify({
          lesson: saveIncidentLesson(db, {
            project: flag('project', '*'),
            member: flag('member', '*'),
            role: flag('role', '*'),
            errorCode: flag('code', ''),
            pattern: flag('pattern'),
            guardrail: flag('guardrail'),
          }),
        }, null, 2));
      } else if (sub === 'toggle') {
        console.log(JSON.stringify({ lesson: toggleIncidentLesson(db, Number(positionals[1] || flag('id')), flags.active !== 'false' && !flags.disable) }, null, 2));
      } else throw new Error(`Unknown lessons subcommand "${sub}". Use: list | save | toggle`);
    } else if (cmd === 'backup') {
      console.log(JSON.stringify(createHotBackup(db), null, 2));
    } else if (cmd === 'metrics') {
      console.log(JSON.stringify(computeAgentTelemetry(db, { days: Number(flag('days', '30')) }), null, 2));
    } else if (cmd === 'workspaces') {
      console.log(JSON.stringify(listWorkspaceProjects(), null, 2));
    } else if (cmd === 'recipes') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify(listRecipes(db), null, 2));
      else if (sub === 'save') console.log(JSON.stringify(saveRecipe(db, { recipeId: flag('id') || positionals[1], title: flag('title'), role: flag('role', 'researcher'), tags: flag('tags', ''), prompt: flag('prompt') }), null, 2));
      else if (sub === 'delete') console.log(JSON.stringify(deleteRecipe(db, flag('id') || positionals[1]), null, 2));
      else throw new Error(`Unknown recipes subcommand "${sub}". Use: list | save | delete`);
    } else if (cmd === 'workflow') {
      const wfFile = positionals[0] || flag('file');
      if (!wfFile) throw new Error('Pass a workflow JSON file path: collab-hub workflow <file.json>');
      const spec = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
      console.log(JSON.stringify(await runDagWorkflow(db, {
        name: spec.name || 'cli-dag',
        batchId: spec.batch_id || null,
        projectDir: flag('dir') || spec.project_dir || process.cwd(),
        steps: spec.steps || [],
        waitSec: Number(flag('wait', String(spec.wait_sec ?? 15))),
        saveReportToMemory: spec.save_report_to_memory !== false,
      }), null, 2));
    } else if (cmd === 'export-batch') {
      const rep = buildBatchMarkdownReport(db, positionals[0] || flag('batch'));
      if (flags.json) console.log(JSON.stringify(rep, null, 2));
      else console.log(rep.markdown);
    } else if (cmd === 'toolkit') {
      console.log(JSON.stringify({ ...getToolkitStatus(), cass_archive: await getCassStats() }, null, 2));
    } else if (cmd === 'mcp-hub') {
      const sub = positionals[0] || 'snapshot';
      if (sub === 'snapshot') console.log(JSON.stringify(buildMcpHubSnapshot(db), null, 2));
      else if (sub === 'import') console.log(JSON.stringify(importDiscoveredMcpServers(db, { clientId: flag('client') }), null, 2));
      else if (sub === 'probe') console.log(JSON.stringify(await probeMcpServer(db, positionals[1] || flag('id')), null, 2));
      else if (sub === 'find-tools') console.log(JSON.stringify(findMcpTools(db, { query: positionals.slice(1).join(' ') || flag('q', '') }), null, 2));
      else if (sub === 'sync') console.log(JSON.stringify(syncMcpToClient(db, { clientId: flag('client') || positionals[1], confirmed: flags.confirm === true }), null, 2));
      else throw new Error(`Unknown mcp-hub subcommand "${sub}". Use: snapshot | import | probe | find-tools | sync`);
    } else if (cmd === 'skills-hub') {
      const sub = positionals[0] || 'snapshot';
      if (sub === 'snapshot') console.log(JSON.stringify(buildSkillsRulesSnapshot({ projectDir: flag('dir') || WORKSPACE_ROOT }), null, 2));
      else if (sub === 'sync-skill') console.log(JSON.stringify(syncSkillAcrossClients(db, { skillName: flag('skill') || positionals[1], sourceClient: flag('from'), targetClients: flag('to') ? String(flag('to')).split(',') : [], confirmed: flags.confirm === true }), null, 2));
      else if (sub === 'sync-rule') console.log(JSON.stringify(syncRuleAcrossTargets(db, { projectDir: flag('dir') || WORKSPACE_ROOT, sourceRuleId: flag('from', 'agents-md'), targetRuleIds: flag('to') ? String(flag('to')).split(',') : [], confirmed: flags.confirm === true }), null, 2));
      else throw new Error(`Unknown skills-hub subcommand "${sub}". Use: snapshot | sync-skill | sync-rule`);
    } else if (cmd === 'tui') {
      await startInteractiveTui(db, {
        demo: Boolean(flags.demo),
        fps: Number(flag('fps', '8')),
        width: flag('width') ? Number(flag('width')) : undefined,
        height: flag('height') ? Number(flag('height')) : undefined,
        projectDir: flag('dir') || WORKSPACE_ROOT,
        reopenDb: () => openHubDbReadOnly(),
      });
    } else if (cmd === 'hud') {
      await runHudCli(db, {
        format: flag('format', 'statusline'),
        watch: Boolean(flags.watch),
        intervalMs: Number(flag('interval', '250')),
        width: flag('width') ? Number(flag('width')) : undefined,
        reopenDb: () => openHubDbReadOnly(),
      });
    } else if (cmd === 'room') {
      const sub = positionals[0] || 'list';
      if (sub === 'create') {
        console.log(JSON.stringify(await createCollabRoom(db, {
          name: positionals[1] || flag('name'),
          goal: flag('goal', ''),
          agents: flag('agents') ? String(flag('agents')).split(',').map((s) => s.trim()).filter(Boolean) : ['agy', 'codex', 'claude', 'dsh', 'muse'],
          createGitRepo: flags['no-git'] !== true,
          autoRegisterClis: flag('cli') ? String(flag('cli')).split(',').map((s) => s.trim()).filter(Boolean) : [],
          launchApps: flag('launch') ? String(flag('launch')).split(',').map((s) => s.trim()).filter(Boolean) : [],
          confirmed: flags.confirm === true,
          workspaceRoot: flag('root') || WORKSPACE_ROOT,
        }), null, 2));
      } else if (sub === 'list') {
        console.log(JSON.stringify({ rooms: listCollabRooms(db) }, null, 2));
      } else if (sub === 'status') {
        console.log(JSON.stringify({ room: getRoomStatus(db, positionals[1] || flag('room') || flag('id')) }, null, 2));
      } else if (sub === 'claim') {
        console.log(JSON.stringify({
          claim: claimRoomPath(db, {
            roomId: flag('room') || positionals[1],
            pathGlob: flag('path') || positionals[2],
            ownerAgent: flag('agent') || flag('owner') || positionals[3],
            ttlMinutes: Number(flag('ttl', '30')),
            notes: flag('notes', ''),
          }),
        }, null, 2));
      } else if (sub === 'renew') {
        console.log(JSON.stringify({
          claim: renewRoomClaim(db, { claimId: flag('claim') || positionals[1], ownerAgent: flag('agent') || null, ttlMinutes: Number(flag('ttl', '30')) }),
        }, null, 2));
      } else if (sub === 'release') {
        console.log(JSON.stringify({
          claim: releaseRoomClaim(db, { claimId: flag('claim') || null, roomId: flag('room') || null, pathGlob: flag('path') || null, ownerAgent: flag('agent') || null }),
        }, null, 2));
      } else if (sub === 'log') {
        console.log(JSON.stringify({
          entry: appendRoomLog(db, { roomId: flag('room') || positionals[1], actor: flag('actor', 'cli'), kind: flag('kind', 'note'), message: flag('message') || positionals.slice(2).join(' ') }),
        }, null, 2));
      } else if (sub === 'promote') {
        console.log(JSON.stringify(promoteInboxFile(db, {
          roomId: flag('room') || positionals[1],
          agent: flag('agent') || positionals[2],
          relPath: flag('file') || positionals[3],
          destRelPath: flag('dest') || null,
          confirmed: flags.confirm === true,
        }), null, 2));
      } else if (sub === 'reconcile-stale') {
        console.log(JSON.stringify(reconcileStaleClaimsInAllRooms(db), null, 2));
      } else {
        throw new Error(`Unknown room subcommand "${sub}". Use: create | list | status | claim | renew | release | log | promote | reconcile-stale`);
      }
    } else if (cmd === 'handoff') {
      console.log(JSON.stringify(buildHandoffPack(db, {
        projectDir: flag('dir') || WORKSPACE_ROOT,
        roomId: flag('room') || null,
        targetMember: flag('member') || null,
        saveArtifact: Boolean(flags.save),
      }), null, 2));
    } else if (cmd === 'consensus') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify({ rounds: listConsensusRounds(db, { roomId: flag('room') || null }) }, null, 2));
      else if (sub === 'create') console.log(JSON.stringify(await createConsensusRound(db, { roomId: flag('room') || null, topic: flag('topic') || positionals.slice(1).join(' '), autoDispatch: Boolean(flags.dispatch) }), null, 2));
      else if (sub === 'vote') console.log(JSON.stringify({ round: recordConsensusVote(db, { roundId: flag('round') || positionals[1], member: flag('member'), stance: flag('stance'), confidence: Number(flag('confidence', '0.85')), rationale: flag('rationale', '') }) }, null, 2));
      else if (sub === 'synthesize') console.log(JSON.stringify({ round: synthesizeConsensus(db, flag('round') || positionals[1]) }, null, 2));
      else throw new Error(`Unknown consensus subcommand "${sub}". Use: list | create | vote | synthesize`);
    } else if (cmd === 'artifacts') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify({ artifacts: listArtifacts(db, { roomId: flag('room') || null }) }, null, 2));
      else if (sub === 'get') console.log(JSON.stringify({ artifact: getArtifact(db, positionals[1] || flag('id')) }, null, 2));
      else if (sub === 'put') console.log(JSON.stringify({ artifact: putArtifact(db, { roomId: flag('room') || null, name: flag('name') || positionals[1], content: flag('content') || fs.readFileSync(flag('file'), 'utf8'), author: flag('author', 'cli') }) }, null, 2));
      else if (sub === 'delete') console.log(JSON.stringify(deleteArtifact(db, positionals[1] || flag('id')), null, 2));
      else if (sub === 'prune') console.log(JSON.stringify(pruneExpiredArtifacts(db), null, 2));
      else throw new Error(`Unknown artifacts subcommand "${sub}". Use: list | get | put | delete | prune`);
    } else if (cmd === 'budget') {
      const sub = positionals[0] || 'evaluate';
      if (sub === 'list') console.log(JSON.stringify({ policies: listBudgetPolicies(db) }, null, 2));
      else if (sub === 'evaluate') console.log(JSON.stringify(evaluateBudget(db, { member: flag('member') || null, projectDir: flag('dir') || null }), null, 2));
      else if (sub === 'set') console.log(JSON.stringify({ policy: setBudgetPolicy(db, { scopeType: flag('scope', 'agent'), scopeId: flag('id', '*'), dailyCallLimit: flag('calls') ? Number(flag('calls')) : null, dailyTokenLimit: flag('tokens') ? Number(flag('tokens')) : null, onExceed: flag('on-exceed', 'warn') }) }, null, 2));
      else if (sub === 'delete') console.log(JSON.stringify(deleteBudgetPolicy(db, positionals[1] || flag('id')), null, 2));
      else throw new Error(`Unknown budget subcommand "${sub}". Use: list | evaluate | set | delete`);
    } else if (cmd === 'triggers') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify({ triggers: listTriggers(db) }, null, 2));
      else if (sub === 'save') console.log(JSON.stringify({ trigger: saveTrigger(db, { name: flag('name') || positionals[1], kind: flag('kind', 'interval'), action: flag('action'), intervalSec: Number(flag('interval', '900')) }) }, null, 2));
      else if (sub === 'run') console.log(JSON.stringify(runTriggerNow(db, positionals[1] || flag('id')), null, 2));
      else if (sub === 'delete') console.log(JSON.stringify(deleteTrigger(db, positionals[1] || flag('id')), null, 2));
      else throw new Error(`Unknown triggers subcommand "${sub}". Use: list | save | run | delete`);
    } else if (cmd === 'reconcile-stale') {
      console.log(JSON.stringify(reconcileStaleTasks(db, {
        taskIds: flag('ids') ? String(flag('ids')).split(',').map((s) => s.trim()).filter(Boolean) : null,
        resolution: flag('resolution', 'cancelled'),
        note: flag('note', ''),
        confirmed: flags.confirm === true,
      }), null, 2));
    } else if (cmd === 'setup') {
      const profile = flag('profile', 'cockpit');
      const clients = flag('clients') ? String(flag('clients')).split(',').map((s) => s.trim()).filter(Boolean) : null;
      const installHud = flags['no-hud'] !== true;
      const regClis = flags['no-clis'] !== true;
      const out = flags.confirm === true
        ? await applySetup(db, {
          profile, clients, installClaudeStatusLine: installHud, registerLocalClis: regClis, confirmed: true,
        })
        : await planSetup(db, {
          profile, clients, installClaudeStatusLine: installHud, registerLocalClis: regClis,
        });
      if (flags.autostart === true && flags.confirm === true) {
        out.autostart = await installAutostart({ confirmed: true, force: flags.force === true });
      }
      console.log(JSON.stringify(out, null, 2));
    } else if (cmd === 'cockpit' || cmd === 'open') {
      const targetPort = Number(flag('port', String(DASHBOARD_PORT))) || DASHBOARD_PORT;
      const baseUrl = `http://${DASHBOARD_HOST}:${targetPort}`;
      const isDock = flags.dock === true || cmd === 'cockpit';
      const targetUrl = isDock ? `${baseUrl}/cockpit?mode=dock` : baseUrl;
      const checkAlive = async () => {
        try {
          const r = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(900) });
          return r.ok;
        } catch { return false; }
      };
      let alive = await checkAlive();
      if (!alive && !flags['no-start']) {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'start', '--port', String(targetPort)], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
        for (let i = 0; i < 15; i += 1) {
          await new Promise((r) => setTimeout(r, 200));
          alive = await checkAlive();
          if (alive) break;
        }
      }
      const trySpawn = (exe, args) => {
        try {
          const p = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
          p.unref();
          return true;
        } catch { return false; }
      };
      if (flags.split === true) {
        const cliSelf = fileURLToPath(import.meta.url);
        let splitMode = 'manual';
        if (process.platform === 'win32') {
          if (trySpawn('wt.exe', ['-w', '0', 'sp', '-V', '-s', '0.28', process.execPath, cliSelf, 'hud', '--watch'])) {
            splitMode = 'windows-terminal-split';
          }
        } else if (process.env.TMUX) {
          if (trySpawn('tmux', ['split-window', '-h', '-l', '36', '-d', `${process.execPath} "${cliSelf}" hud --watch`])) {
            splitMode = 'tmux-sidebar';
          }
        }
        console.log(JSON.stringify({ ok: true, daemon_online: alive, url: targetUrl, mode: 'split-hud', launcher: splitMode }, null, 2));
      } else {
        let launcher = 'manual';
        if (!flags['no-launch']) {
          if (process.platform === 'win32') {
            const edge = [
              path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
              path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            ].find((p) => fs.existsSync(p));
            const chrome = [
              path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
              path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
            ].find((p) => fs.existsSync(p));
            const browserExe = chrome || edge;
            if (browserExe && isDock && trySpawn(browserExe, [`--app=${targetUrl}`, '--window-size=440,860'])) {
              launcher = path.basename(browserExe) + ' --app';
              if (flags.pin === true) {
                const psPin = `Add-Type -Name W -Namespace N -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'; for($i=0;$i -lt 16;$i++){ $p = Get-Process | Where-Object { $_.MainWindowTitle -like '*CollabHub*' } | Select-Object -First 1; if($p -and $p.MainWindowHandle -ne 0){ [N.W]::SetWindowPos($p.MainWindowHandle, [IntPtr](-1), 0, 0, 0, 0, 3); break }; Start-Sleep -Milliseconds 400 }`;
                trySpawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', psPin]);
                launcher += ' --pin-topmost';
              }
            } else {
              trySpawn('cmd.exe', ['/c', 'start', '', targetUrl]);
              launcher = 'shell-open';
            }
          } else if (process.platform === 'darwin') {
            trySpawn('open', [targetUrl]);
            launcher = 'open';
          } else {
            trySpawn('xdg-open', [targetUrl]);
            launcher = 'xdg-open';
          }
        }
        console.log(JSON.stringify({ ok: true, daemon_online: alive, url: targetUrl, mode: isDock ? 'resident-dock' : 'workbench', launcher }, null, 2));
      }
    } else if (cmd === 'autostart') {
      const sub = positionals[0] || 'status';
      if (sub === 'status') console.log(JSON.stringify(await getAutostartStatus(), null, 2));
      else if (sub === 'install') console.log(JSON.stringify(await installAutostart({ confirmed: flags.confirm === true, force: flags.force === true }), null, 2));
      else if (sub === 'remove') console.log(JSON.stringify(await removeAutostart({ confirmed: flags.confirm === true }), null, 2));
      else throw new Error(`Unknown autostart subcommand "${sub}". Use: status | install | remove`);
    } else if (cmd === 'usage') {
      console.log(JSON.stringify(await getLiveAgentUsageAsync(db, {
        includeLocalScan: !flags['no-scan'],
        includeOllama: flags.ollama !== false,
      }), null, 2));
    } else if (cmd === 'plan') {
      console.log(JSON.stringify(planDispatch(db, {
        role: flag('role', 'researcher'),
        prompt: flag('prompt', positionals.join(' ')),
        title: flag('title', ''),
        taskCategory: flag('category'),
        complexity: flag('complexity'),
        strategy: flag('strategy', 'balanced'),
        requireBackgroundAuto: flags.bg === true,
      }), null, 2));
    } else if (cmd === 'install-plugins') {
      const ides = flag('ides') ? String(flag('ides')).split(',').map((s) => s.trim()).filter(Boolean) : null;
      console.log(JSON.stringify(installNativePlugins({ confirmed: flags.confirm === true, ides }), null, 2));
    } else if (cmd === 'webhooks') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify({ webhooks: listWebhooks(db), formats: [...VALID_WEBHOOK_FORMATS] }, null, 2));
      else if (sub === 'save') console.log(JSON.stringify({ webhook: await saveWebhook(db, { name: flag('name') || positionals[1], format: flag('format', 'generic'), url: flag('url'), secretEnv: flag('secret-env'), events: flag('events') ? String(flag('events')).split(',') : ['*'] }) }, null, 2));
      else if (sub === 'delete') console.log(JSON.stringify(deleteWebhook(db, positionals[1] || flag('id')), null, 2));
      else if (sub === 'test') console.log(JSON.stringify(await deliverWebhook(db, positionals[1] || flag('id'), { event_type: 'webhook.test', actor: 'cli', payload: { message: 'CollabHub CLI webhook test' } }), null, 2));
      else throw new Error(`Unknown webhooks subcommand "${sub}". Use: list | save | delete | test`);
    } else if (cmd === 'merge-queue') {
      const sub = positionals[0] || 'list';
      if (sub === 'list') console.log(JSON.stringify({ queue: listMergeQueue(db) }, null, 2));
      else if (sub === 'enqueue') console.log(JSON.stringify(enqueueMergeQueue(db, { taskId: positionals[1] || flag('task'), priority: Number(flag('priority', '100')) }), null, 2));
      else if (sub === 'validate') console.log(JSON.stringify(validateMergeQueue(db), null, 2));
      else if (sub === 'process') console.log(JSON.stringify(processMergeQueue(db, { confirmed: flags.confirm === true }), null, 2));
      else throw new Error(`Unknown merge-queue subcommand "${sub}". Use: list | enqueue | validate | process`);
    } else {
      console.log([
        `CollabHub v${APP_VERSION} — Zero-Dependency Host-Native Multi-Agent Mission Control`,
        'Commands:',
        '  setup [--profile core|cockpit|full --clients a,b --confirm --autostart]  Auto-detect 14 AI clients & install CollabHub + HUD',
        '  cockpit [--dock --port 5290]                 Auto-start hub & pop out Always-On Resident Floating Cockpit',
        '  autostart [status|install|remove --confirm]  Manage zero-admin OS autostart (LaunchAgent / systemd / Task Scheduler)',
        '  usage [--no-scan]                            Real-time cross-agent usage, token burn rate & est. USD cost',
        '  tui [--demo --fps 8]                         Launch 24-bit TrueColor animated Terminal Cockpit (Codex/Claude/DSH)',
        '  hud [--format statusline|card|json --watch]  Sub-100ms live StatusLine & Cyber-HUD (Claude Code / tmux / WSL)',
        '  room create|list|status|claim|renew|release|log|promote|reconcile-stale  Living shared room lifecycle',
        '  handoff [--dir D --room R --save]            Generate sanitized Context Handoff Pack',
        '  consensus list|create|vote|synthesize        Multi-agent arbitration & consensus verdict',
        '  artifacts list|get|put|delete|prune          Shared redacted Artifact Vault',
        '  budget list|evaluate|set|delete              Token & call budget guardrails',
        '  triggers list|save|run|delete                Safe allowlisted periodic triggers',
        '  webhooks list|save|delete|test               Signed outbound webhooks (Slack/Discord/Feishu/DingTalk/Telegram)',
        '  reconcile-stale [--confirm --resolution R]   Batch-archive aged non-terminal tasks',
        '  start [--port 5290]                          Start Web Workbench, SSE & Streamable HTTP /mcp server',
        '  mcp [--profile core|cockpit|full --tools ..] Start 53-tool SEP-1865 MCP stdio server (AGY/Claude/Codex/14 clients)',
        '  mcp-hub snapshot|import|probe|find-tools|sync  All-Agent MCP Hub (14 clients) & Meta-MCP tool discovery',
        '  skills-hub snapshot|sync-skill|sync-rule     Cross-Agent Skills & Rules sync hub',
        '  merge-queue list|enqueue|validate|process    Speculative Git Merge Queue',
        '  init                                         Initialize runtime directories & SQLite ledger',
        '  probe | roster                               Live-probe all agents + Mail Hub + toolkit',
        '  doctor [--backup]                            8-point system health check (+ optional VACUUM INTO backup)',
        '  backup                                       Create safe hot SQLite snapshot',
        '  metrics [--days 30]                          Per-agent success rate, latency & token telemetry',
        '  discover                                     Auto-discover local Ollama/LM Studio/vLLM models, CLIs & env keys',
        '  workspaces                                   List projects & Git repos under WORKSPACE_ROOT',
        '  recipes list|save|delete                     Manage built-in & custom prompt recipes',
        '  agent(s) list|add|remove                     Manage built-in & custom agents',
        '  tasks [task_id] [--limit N]                  List tasks or inspect task + audit trail',
        '  memory list|search|write                     Query or write shared FTS5 + Markdown project memory',
        '  dispatch --member M|auto --dir D --prompt P  Dispatch background task [--fallback --role R --batch B]',
        '  poll <task_id> [--wait S]                    Poll task receipt without ever re-sending',
        '  poll-batch <batch_id> [--wait S]             Aggregate batch status',
        '  cancel <task_id> [--reason R]                Cancel active task & abort local process/HTTP run',
        '  logs <task_id>                               Inspect recent live streaming log chunks',
        '  resume <batch_id> [--wait S]                 Resume failed/cancelled DAG workflow from checkpoint',
        '  verify-worktree <task_id> [--preset auto]    Run allowlisted test gate inside isolated worktree',
        '  workflow <spec.json> [--dir D --wait S]      Execute multi-stage DAG workflow',
        '  export-batch <batch_id> [--json]             Export Markdown synthesis report for a batch',
        '  pack / ast / sessions / cass-index / doc2md / beads / playbook / toolkit',
      ].join('\n'));
    }
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: String(err.message || err) }, null, 2));
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}
