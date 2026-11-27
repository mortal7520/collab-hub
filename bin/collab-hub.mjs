#!/usr/bin/env node
import fs from 'node:fs';
import {
  APP_ROOT, APP_VERSION, DASHBOARD_HOST, DASHBOARD_PORT, WORKSPACE_ROOT, ensureRuntimeDirs,
} from '../src/config.mjs';
import { createDashboardServer, startReadOnlyAutoPoller } from '../src/dashboard.mjs';
import { openHubDb, openHubDbReadOnly, parseTaskRow, pruneRetentionTables } from '../src/db.mjs';
import { discoverLocalAgents } from '../src/discovery.mjs';
import { createCollabRoom } from '../src/workspace-room.mjs';
import { createHotBackup, listWorkspaceProjects, runSystemDoctor } from '../src/doctor.mjs';
import { cancelTask, dispatchBackgroundTask, getTaskLogs, pollBackgroundTask, pollBatchTasks, sweepOrphanTasks } from '../src/executors.mjs';
import { runHudCli } from '../src/hud.mjs';
import { startMcpStdioServer } from '../src/mcp-server.mjs';
import { buildMcpHubSnapshot, findMcpTools, importDiscoveredMcpServers, probeMcpServer, syncMcpToClient } from '../src/mcp-hub.mjs';
import { listMemoryNotes, searchMemoryNotes, writeMemoryNote } from '../src/memory.mjs';
import { enqueueMergeQueue, listMergeQueue, processMergeQueue, validateMergeQueue } from '../src/merge-queue.mjs';
import { runPlaybook } from '../src/playbooks.mjs';
import { probeAllMembers } from '../src/prober.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from '../src/recipes.mjs';
import { listAgents, registerAgent, removeAgent } from '../src/registry.mjs';
import { applySelfHeal, diagnoseSystem, listIncidentLessons, saveIncidentLesson, toggleIncidentLesson } from '../src/self-improve.mjs';
import { buildSkillsRulesSnapshot, syncRuleAcrossTargets, syncSkillAcrossClients } from '../src/skills-hub.mjs';
import { computeAgentTelemetry } from '../src/telemetry.mjs';
import {
  convertDocToMd, getCassStats, getToolkitStatus, packRepoRepomix,
  reindexSessionsCass, runBeads, searchAstGrep, searchSessionsCass,
} from '../src/toolkit.mjs';
import { startInteractiveTui } from '../src/tui.mjs';
import { buildBatchMarkdownReport, resumeDagWorkflow, runDagWorkflow } from '../src/workflows.mjs';
import { verifyWorktree } from '../src/worktree.mjs';

const [cmd, ...rawArgs] = process.argv.slice(2);

if (cmd === 'mcp') {
  startMcpStdioServer();
} else if (cmd === 'start') {
  ensureRuntimeDirs();
  const db = openHubDb();
  pruneRetentionTables(db);
  sweepOrphanTasks(db);
  const portIdx = rawArgs.indexOf('--port');
  const port = portIdx >= 0 && rawArgs[portIdx + 1] ? Number(rawArgs[portIdx + 1]) : DASHBOARD_PORT;
  const server = createDashboardServer(db, { host: DASHBOARD_HOST, port });
  let poller = null;
  const gracefulExit = async () => {
    poller?.stop();
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
      });
    } else if (cmd === 'hud') {
      await runHudCli(db, {
        format: flag('format', 'statusline'),
        watch: Boolean(flags.watch),
        intervalMs: Number(flag('interval', '250')),
        width: flag('width') ? Number(flag('width')) : undefined,
      });
    } else if (cmd === 'room') {
      const sub = positionals[0] || 'create';
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
      } else {
        throw new Error(`Unknown room subcommand "${sub}". Use: create <name> [--goal G --cli id1,id2 --launch app1 --confirm]`);
      }
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
        '  tui [--demo --fps 8]                         Launch 24-bit TrueColor animated Terminal Cockpit (Codex/Claude/DSH)',
        '  hud [--format statusline|card|json --watch]  Sub-100ms live StatusLine & Cyber-HUD (Claude Code / tmux / WSL)',
        '  room create <name> [--goal G --cli C --launch A --confirm]  Create shared Git collab room + register/launch agents',
        '  start [--port 5290]                          Start the interactive Web Workbench & SSE server',
        '  mcp                                          Start the 45-tool SEP-1865 MCP Apps stdio server (AGY/Claude/Codex)',
        '  mcp-hub snapshot|import|probe|find-tools|sync  All-Agent MCP Hub & Meta-MCP tool discovery',
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
