import { randomUUID } from 'node:crypto';
import { dispatchBackgroundTask } from './executors.mjs';
import { reserveMailPaths } from './mail-sync.mjs';
import { writeMemoryNote } from './memory.mjs';
import { planDispatch } from './prober.mjs';
import { convertDocToMd, packRepoRepomix, searchAstGrep, searchSessionsCass } from './toolkit.mjs';
import { runDagWorkflow } from './workflows.mjs';
import { createWorktree } from './worktree.mjs';

/**
 * Practical, high-leverage multi-agent playbooks that chain CollabHub's toolkit + dynamic agent roster.
 */
export async function runPlaybook(db, {
  playbook, projectDir, goal = '', members = null, include = null, astPattern = null, astLang = null, docPath = null, sessionQuery = null,
}, deps = {}) {
  const batchId = `pb_${Date.now().toString(36)}_${randomUUID().slice(0, 4)}`;

  if (playbook === 'code-review-squad') {
    // 1. Pack bounded repo context via repomix (so even remote/cloud or HTTP agents get exact source!)
    const pack = await (deps.packRepoRepomix || packRepoRepomix)({
      projectDir,
      include,
      compress: true,
      maxChars: 24000,
      workspaceRoot: deps.workspaceRoot,
      extraRoots: deps.extraRoots,
    });
    let astSummary = '';
    if (astPattern) {
      const astRes = await (deps.searchAstGrep || searchAstGrep)({
        projectDir, pattern: astPattern, lang: astLang, maxMatches: 25,
        workspaceRoot: deps.workspaceRoot, extraRoots: deps.extraRoots,
      });
      astSummary = `\n\n[AST Search "${astPattern}" (${astRes.total_matches} matches)]\n`
        + astRes.matches.map((m) => `- ${m.file}:${m.line}: ${m.text}`).join('\n');
    }

    // 2. Select available background-capable reviewers dynamically (never hardcoded to just 5!)
    let targetMembers = Array.isArray(members) && members.length ? members : null;
    let skipped = [];
    if (!targetMembers) {
      const plan = planDispatch(db, { role: 'reviewer', requireBackgroundAuto: true });
      targetMembers = plan.candidates.slice(0, 2).map((c) => c.member);
      skipped = plan.skipped;
    }

    const reviewPrompt = [
      `[CollabHub Adversarial Code Review Playbook | batch=${batchId}]`,
      `Goal: ${goal || 'Find Critical/High security, concurrency, and architectural flaws.'}`,
      astSummary,
      '\n[Compressed Repository Snapshot]\n' + pack.content,
    ].join('\n');

    // Dispatch all selected reviewers concurrently without aborting the squad on a single failure
    const settled = await Promise.allSettled(targetMembers.map((m) => dispatchBackgroundTask(db, {
      batchId,
      member: m,
      role: 'reviewer',
      projectDir,
      title: `[Review Squad] ${m} 独立代码审查`,
      prompt: reviewPrompt,
      waitSec: 0,
    }, deps)));

    const dispatched = [];
    const errors = [];
    settled.forEach((res, idx) => {
      const m = targetMembers[idx];
      if (res.status === 'fulfilled') {
        const t = res.value;
        dispatched.push({ task_id: t.task_id, member: t.member, state: t.state, external_id: t.external_id });
      } else {
        errors.push({ member: m, error: String(res.reason?.message || res.reason) });
      }
    });

    return {
      playbook,
      batch_id: batchId,
      packed_tokens: pack.approx_tokens,
      dispatched_count: dispatched.length,
      dispatched,
      errors,
      skipped,
      next_step: dispatched.length
        ? `Call collab_poll_batch(batch_id="${batchId}") to aggregate all independent reviews.`
        : 'No online background reviewers available right now; run collab_roster or register a generic-cli/openai-http reviewer.',
    };
  }

  if (playbook === 'research-and-pack') {
    const sections = [`# Research Pack (${batchId})`, `Goal: ${goal || 'Project research & evidence pack'}`];
    if (docPath) {
      const doc = await (deps.convertDocToMd || convertDocToMd)({
        filePath: docPath, maxChars: 12000, workspaceRoot: deps.workspaceRoot, extraRoots: deps.extraRoots,
      });
      sections.push(`## Converted Document (${doc.file_path})\n\n${doc.markdown}`);
    }
    if (sessionQuery) {
      const sess = await (deps.searchSessionsCass || searchSessionsCass)({ query: sessionQuery, limit: 8 });
      sections.push(`## Cross-Agent Session History ("${sessionQuery}")\n\n\`\`\`json\n${JSON.stringify(sess, null, 2).slice(0, 8000)}\n\`\`\``);
    }
    if (projectDir) {
      const pack = await (deps.packRepoRepomix || packRepoRepomix)({
        projectDir, include, compress: true, maxChars: 12000, workspaceRoot: deps.workspaceRoot, extraRoots: deps.extraRoots,
      });
      sections.push(`## Codebase Snapshot (~${pack.approx_tokens} tokens)\n\n${pack.content}`);
    }
    const projSlug = projectDir ? projectDir.split(/[\\/]/).filter(Boolean).pop() : 'workspace';
    const saved = writeMemoryNote(db, {
      project: projSlug,
      slug: `research-${batchId}`,
      title: `调研汇总：${(goal || projSlug).slice(0, 60)}`,
      tags: ['playbook', 'research-pack', batchId],
      author: 'collab-hub',
      content: sections.join('\n\n'),
      memoryDir: deps.memoryDir,
    });
    return { playbook, batch_id: batchId, memory_note: saved };
  }

  if (playbook === 'adversarial-debate') {
    let targetMembers = Array.isArray(members) && members.length >= 2 ? members.slice(0, 3) : null;
    let skipped = [];
    if (!targetMembers) {
      const plan = planDispatch(db, { role: 'reviewer', requireBackgroundAuto: true });
      targetMembers = plan.candidates.slice(0, 2).map((c) => c.member);
      skipped = plan.skipped;
    }
    if (targetMembers.length < 2) {
      return {
        playbook,
        batch_id: batchId,
        dispatched_count: 0,
        skipped,
        next_step: 'adversarial-debate needs at least 2 online background agents (pass members=[...] or register local CLI/HTTP agents).',
      };
    }

    let snapshot = '';
    if (projectDir && include) {
      const pack = await (deps.packRepoRepomix || packRepoRepomix)({
        projectDir, include, compress: true, maxChars: 16000,
        workspaceRoot: deps.workspaceRoot, extraRoots: deps.extraRoots,
      });
      snapshot = `\n\n[Relevant Code Snapshot]\n${pack.content}`;
    }

    const topic = goal || 'Evaluate the current architecture and propose the highest-leverage improvements.';
    const steps = [
      {
        id: 'advocate',
        member: targetMembers[0],
        role: 'planner',
        title: `[Debate] ${targetMembers[0]} 正方方案与落地路径`,
        prompt: `You are the constructive architect/advocate.\nTopic: ${topic}\nPropose the clearest, most practical architecture & step-by-step plan with explicit trade-offs.${snapshot}`,
      },
      {
        id: 'redteam',
        member: targetMembers[1],
        role: 'reviewer',
        title: `[Debate] ${targetMembers[1]} 反方红队对抗审查`,
        prompt: `You are an adversarial red-team critic.\nTopic: ${topic}\nIdentify hidden failure modes, security holes, race conditions, maintenance traps, and simpler alternatives.${snapshot}`,
      },
    ];
    const synthMember = targetMembers[2] || targetMembers[0];
    steps.push({
      id: 'verdict',
      member: synthMember,
      role: 'synthesizer',
      title: `[Debate] ${synthMember} 最终仲裁与行动清单`,
      depends_on: ['advocate', 'redteam'],
      auto_inject_context: true,
      prompt: `Synthesize the advocate proposal and red-team critique above into: (1) Consensus decisions, (2) Disagreements resolved with reasoning, (3) Concrete prioritized action checklist for topic: ${topic}`,
    });

    const wfRes = await runDagWorkflow(db, {
      name: 'adversarial-debate',
      batchId,
      projectDir,
      steps,
      waitSec: 0,
      saveReportToMemory: true,
    }, deps);
    return { playbook, ...wfRes };
  }

  if (playbook === 'multi-agent-build') {
    let builder = Array.isArray(members) && members.length ? members[0] : null;
    let skipped = [];
    if (!builder) {
      const plan = planDispatch(db, { role: 'implementer', requireLocalFiles: true, requireBackgroundAuto: true });
      builder = plan.recommended?.member || null;
      skipped = plan.skipped;
    }
    if (!builder) {
      return {
        playbook,
        batch_id: batchId,
        dispatched_count: 0,
        skipped,
        next_step: 'multi-agent-build needs an online local-filesystem background implementer (e.g. dsh or a generic-cli agent).',
      };
    }

    const wtTaskId = `build_${batchId}`;
    const wt = createWorktree(db, {
      repoDir: projectDir,
      taskId: wtTaskId,
      member: builder,
      worktreeRoot: deps.worktreeRoot,
      workspaceRoot: deps.workspaceRoot,
    });
    const mail_lease = await (deps.reserveMailPaths || reserveMailPaths)({
      projectDir: wt.repo_dir,
      member: builder,
      paths: [`worktree:${wt.branch_name}`],
      reason: `Playbook multi-agent-build ${batchId}`,
    });
    const task = await dispatchBackgroundTask(db, {
      taskId: `${wtTaskId}_impl`,
      batchId,
      member: builder,
      role: 'implementer',
      projectDir: wt.repo_dir,
      worktreePath: wt.worktree_path,
      branchName: wt.branch_name,
      title: `[Build] ${builder} 隔离分支实现`,
      prompt: `Work strictly inside your isolated Git worktree (${wt.worktree_path}, branch ${wt.branch_name}).\nGoal: ${goal || 'Implement requested feature with unit tests.'}\nCommit clean changes to this branch and report exact test results.`,
      waitSec: 0,
    }, deps);

    return {
      playbook,
      batch_id: batchId,
      worktree: wt,
      mail_lease,
      task: { task_id: task.task_id, member: task.member, state: task.state, external_id: task.external_id },
      next_step: `Poll task "${task.task_id}", then run collab_worktree_review(task_id="${wtTaskId}") and collab_worktree_merge(task_id="${wtTaskId}", confirmed=true).`,
    };
  }

  throw new Error(`Unknown playbook "${playbook}". Available: code-review-squad, research-and-pack, adversarial-debate, multi-agent-build`);
}
