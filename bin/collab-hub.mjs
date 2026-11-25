#!/usr/bin/env node
import fs from 'node:fs';
import {
  APP_ROOT, DASHBOARD_HOST, DASHBOARD_PORT, WORKSPACE_ROOT, ensureRuntimeDirs,
} from '../src/config.mjs';
import { createDashboardServer } from '../src/dashboard.mjs';
import { openHubDb, parseTaskRow } from '../src/db.mjs';
import { discoverLocalAgents } from '../src/discovery.mjs';
import { createHotBackup, listWorkspaceProjects, runSystemDoctor } from '../src/doctor.mjs';
import { dispatchBackgroundTask, pollBackgroundTask, pollBatchTasks } from '../src/executors.mjs';
import { startMcpStdioServer } from '../src/mcp-server.mjs';
import { listMemoryNotes, searchMemoryNotes, writeMemoryNote } from '../src/memory.mjs';
import { runPlaybook } from '../src/playbooks.mjs';
import { probeAllMembers } from '../src/prober.mjs';
import { deleteRecipe, listRecipes, saveRecipe } from '../src/recipes.mjs';
import { listAgents, registerAgent, removeAgent } from '../src/registry.mjs';
import { computeAgentTelemetry } from '../src/telemetry.mjs';
import {
  convertDocToMd, getCassStats, getToolkitStatus, packRepoRepomix,
  reindexSessionsCass, runBeads, searchAstGrep, searchSessionsCass,
} from '../src/toolkit.mjs';
import { buildBatchMarkdownReport, runDagWorkflow } from '../src/workflows.mjs';
import { verifyWorktree } from '../src/worktree.mjs';

const [cmd, ...rawArgs] = process.argv.slice(2);

if (cmd === 'mcp') {
  startMcpStdioServer();
} else if (cmd === 'start') {
  ensureRuntimeDirs();
  const db = openHubDb();
  const portIdx = rawArgs.indexOf('--port');
  const port = portIdx >= 0 && rawArgs[portIdx + 1] ? Number(rawArgs[portIdx + 1]) : DASHBOARD_PORT;
  const server = createDashboardServer(db, { host: DASHBOARD_HOST, port });
  server.listen(port, DASHBOARD_HOST, () => {
    console.log(JSON.stringify({
      event: 'dashboard.listening',
      version: '1.0.0',
      url: `http://${DASHBOARD_HOST}:${port}`,
      app_root: APP_ROOT,
      workspace_root: WORKSPACE_ROOT,
      pid: process.pid,
    }));
    probeAllMembers(db).catch(() => {});
  });
} else {
  ensureRuntimeDirs();
  const db = openHubDb();

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
    } else {
      console.log([
        'CollabHub v1.0.0 — Zero-Dependency Local-First Multi-Agent Workbench',
        'Commands:',
        '  start [--port 5290]                          Start the interactive Web Workbench & SSE server',
        '  mcp                                          Start the 32-tool MCP stdio server',
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
    db.close();
  }
}
