/**
 * CollabHub v2.2 — Multi-Agent Consensus & Arbitration Engine (`consensus_rounds`)
 *
 * Enables heterogeneous agents (`agy`, `codex`, `claude`, `dsh`, `muse`, custom) to vote on
 * releases, architecture trade-offs, or diffs with weighted confidence + explicit hard blockers.
 */
import { randomUUID } from 'node:crypto';
import { WORKSPACE_ROOT } from './config.mjs';
import { logEvent } from './db.mjs';
import { dispatchBackgroundTask } from './executors.mjs';
import { writeMemoryNote } from './memory.mjs';
import { appendRoomLog } from './workspace-room.mjs';

const VALID_STANCES = new Set(['approve', 'reject', 'modify', 'abstain']);
const BACKGROUND_CAPABLE = new Set(['dsh', 'muse']);

function parseRoundRow(r) {
  if (!r) return null;
  let members = [];
  let votes = [];
  let verdict = null;
  try { members = JSON.parse(r.members_json || '[]'); } catch { members = []; }
  try { votes = JSON.parse(r.votes_json || '[]'); } catch { votes = []; }
  try { verdict = r.verdict_json ? JSON.parse(r.verdict_json) : null; } catch { verdict = null; }
  return {
    round_id: r.round_id,
    room_id: r.room_id || null,
    topic: r.topic,
    members,
    votes,
    verdict,
    status: r.status,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

export function computeVerdict(votes = [], expectedMembersCount = 0) {
  const counts = { approve: 0, reject: 0, modify: 0, abstain: 0 };
  const weights = { approve: 0, reject: 0, modify: 0, abstain: 0 };
  const hardBlockers = [];
  const dissenters = [];

  for (const v of votes) {
    const st = VALID_STANCES.has(v.stance) ? v.stance : 'abstain';
    const conf = Math.max(0.1, Math.min(1, Number(v.confidence) || 0.8));
    counts[st] += 1;
    weights[st] += conf;
    for (const b of (Array.isArray(v.blockers) ? v.blockers : [])) {
      const txt = String(b || '').trim();
      if (txt) hardBlockers.push({ member: v.member, blocker: txt });
    }
    if (st === 'reject' || st === 'modify') {
      dissenters.push({ member: v.member, stance: st, rationale: String(v.rationale || '').slice(0, 200) });
    }
  }

  const nonAbstain = votes.length - counts.abstain;
  const requiredQuorum = expectedMembersCount > 0 ? Math.max(1, Math.ceil(expectedMembersCount / 2)) : 1;
  let decision = 'pending';
  if (votes.length > 0 && nonAbstain > 0) {
    if (hardBlockers.length > 0 || counts.reject > 0) {
      decision = counts.reject >= counts.approve ? 'rejected' : 'needs_modification';
    } else if (nonAbstain < requiredQuorum) {
      decision = 'pending_quorum';
    } else if (counts.modify > 0 && counts.modify >= counts.approve) {
      decision = 'needs_modification';
    } else if (counts.approve > 0 && counts.reject === 0 && counts.modify === 0 && hardBlockers.length === 0) {
      decision = expectedMembersCount > 0 && nonAbstain < expectedMembersCount ? 'approved_quorum' : 'approved_unanimous';
    } else if (weights.approve > (weights.reject + weights.modify)) {
      decision = counts.modify > 0 ? 'approved_with_modifications' : 'approved_majority';
    } else {
      decision = 'split_decision';
    }
  }

  const agreementRatio = nonAbstain > 0 ? Math.round((Math.max(counts.approve, counts.reject, counts.modify) / nonAbstain) * 100) / 100 : 0;
  return {
    decision,
    total_votes: votes.length,
    counts,
    weighted_scores: Object.fromEntries(Object.entries(weights).map(([k, val]) => [k, Math.round(val * 100) / 100])),
    agreement_ratio: agreementRatio,
    hard_blockers: hardBlockers,
    dissenters,
    computed_at: new Date().toISOString(),
  };
}

export async function createConsensusRound(db, {
  roundId = null,
  roomId = null,
  topic,
  members = ['agy', 'codex', 'claude', 'dsh', 'muse'],
  projectDir = WORKSPACE_ROOT,
  autoDispatch = false,
} = {}, dispatchDeps = {}) {
  const cleanTopic = String(topic || '').trim().slice(0, 400);
  if (!cleanTopic) throw new Error('Consensus topic is required');
  const memberList = Array.isArray(members) && members.length > 0
    ? [...new Set(members.map((m) => String(m).trim()).filter(Boolean))].slice(0, 12)
    : ['agy', 'codex', 'claude', 'dsh', 'muse'];
  const id = roundId
    ? String(roundId).replace(/[^A-Za-z0-9._-]/g, '').slice(0, 48)
    : `con_${Date.now().toString(36)}_${randomUUID().slice(0, 6)}`;
  const now = new Date().toISOString();

  db.prepare(`
    INSERT INTO consensus_rounds (round_id, room_id, topic, members_json, votes_json, verdict_json, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, '[]', NULL, 'open', ?, ?)
  `).run(id, roomId || null, cleanTopic, JSON.stringify(memberList), now, now);

  const dispatched = [];
  if (autoDispatch === true) {
    for (const m of memberList) {
      if (!BACKGROUND_CAPABLE.has(m)) continue;
      try {
        const res = await dispatchBackgroundTask(db, {
          batchId: id,
          member: m,
          role: 'reviewer',
          projectDir: projectDir || WORKSPACE_ROOT,
          title: `Consensus ${id}: ${cleanTopic.slice(0, 48)}`,
          prompt: `Evaluate consensus topic [${id}]: ${cleanTopic}\nRespond with JSON stance ("approve"|"reject"|"modify"|"abstain"), confidence (0-1), rationale, and blockers[].`,
          asyncRun: true,
        }, dispatchDeps);
        dispatched.push({ member: m, task_id: res.task_id });
      } catch (err) {
        dispatched.push({ member: m, skipped_reason: String(err.message || err).slice(0, 120) });
      }
    }
  }

  logEvent(db, { eventType: 'consensus.created', actor: 'collab-hub', payload: { round_id: id, room_id: roomId || null, members: memberList, dispatched } });
  return {
    round: parseRoundRow(db.prepare('SELECT * FROM consensus_rounds WHERE round_id = ?').get(id)),
    dispatched,
  };
}

export function recordConsensusVote(db, {
  roundId, member, stance, confidence = 0.85, rationale = '', blockers = [],
} = {}) {
  const safeMember = String(member || '').trim();
  if (!safeMember) throw new Error('member is required');
  const safeStance = String(stance || '').trim().toLowerCase();
  if (!VALID_STANCES.has(safeStance)) {
    throw new Error(`Invalid stance "${stance}". Use: approve | reject | modify | abstain`);
  }

  let savedRoundId = null;
  let verdict = null;
  db.exec('BEGIN IMMEDIATE;');
  try {
    const row = db.prepare('SELECT * FROM consensus_rounds WHERE round_id = ?').get(String(roundId || ''));
    if (!row) throw new Error(`Consensus round not found: ${roundId}`);
    const parsed = parseRoundRow(row);
    const nextVotes = parsed.votes.filter((v) => v.member !== safeMember);
    nextVotes.push({
      member: safeMember,
      stance: safeStance,
      confidence: Math.max(0.1, Math.min(1, Number(confidence) || 0.85)),
      rationale: String(rationale || '').slice(0, 600),
      blockers: Array.isArray(blockers) ? blockers.map((b) => String(b).slice(0, 200)).filter(Boolean) : [],
      voted_at: new Date().toISOString(),
    });
    verdict = computeVerdict(nextVotes, parsed.members.length);
    const now = new Date().toISOString();

    db.prepare(`
      UPDATE consensus_rounds
      SET votes_json = ?, verdict_json = ?, updated_at = ?
      WHERE round_id = ?
    `).run(JSON.stringify(nextVotes), JSON.stringify(verdict), now, row.round_id);
    savedRoundId = row.round_id;
    db.exec('COMMIT;');
  } catch (err) {
    try { db.exec('ROLLBACK;'); } catch {}
    throw err;
  }

  logEvent(db, { eventType: 'consensus.voted', actor: safeMember, payload: { round_id: savedRoundId, stance: safeStance, decision: verdict.decision } });
  return parseRoundRow(db.prepare('SELECT * FROM consensus_rounds WHERE round_id = ?').get(savedRoundId));
}

export function synthesizeConsensus(db, roundId) {
  const row = db.prepare('SELECT * FROM consensus_rounds WHERE round_id = ?').get(String(roundId || ''));
  if (!row) throw new Error(`Consensus round not found: ${roundId}`);
  const parsed = parseRoundRow(row);
  const verdict = computeVerdict(parsed.votes, parsed.members.length);
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE consensus_rounds
    SET verdict_json = ?, status = 'synthesized', updated_at = ?
    WHERE round_id = ?
  `).run(JSON.stringify(verdict), now, row.round_id);

  const md = [
    `Consensus Verdict [${row.round_id}]: **${verdict.decision}** (agreement=${verdict.agreement_ratio}, votes=${verdict.total_votes})`,
    `Topic: ${row.topic}`,
    ...(verdict.hard_blockers.length ? ['', 'Hard Blockers:', ...verdict.hard_blockers.map((b) => `- [${b.member}] ${b.blocker}`)] : []),
    ...(verdict.dissenters.length ? ['', 'Dissent / Modifications:', ...verdict.dissenters.map((d) => `- [${d.member}:${d.stance}] ${d.rationale}`)] : []),
  ].join('\n');

  try {
    writeMemoryNote(db, {
      project: row.room_id || 'collab-hub-consensus',
      slug: `consensus-${row.round_id}`,
      title: `Consensus: ${row.topic.slice(0, 60)}`,
      author: 'collab-hub',
      tags: ['consensus', verdict.decision],
      content: md,
    });
  } catch { /* best-effort memory */ }

  if (row.room_id) {
    try {
      appendRoomLog(db, {
        roomId: row.room_id,
        actor: 'collab-hub',
        kind: 'consensus',
        message: `[${row.round_id}] Verdict=${verdict.decision} (${verdict.counts.approve} approve / ${verdict.counts.modify} modify / ${verdict.counts.reject} reject)`,
      });
    } catch { /* room optional */ }
  }

  logEvent(db, { eventType: 'consensus.synthesized', actor: 'collab-hub', payload: { round_id: row.round_id, decision: verdict.decision } });
  return parseRoundRow(db.prepare('SELECT * FROM consensus_rounds WHERE round_id = ?').get(row.round_id));
}

export function listConsensusRounds(db, { roomId = null, limit = 20 } = {}) {
  try {
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const rows = roomId
      ? db.prepare('SELECT * FROM consensus_rounds WHERE room_id = ? ORDER BY updated_at DESC LIMIT ?').all(String(roomId), lim)
      : db.prepare('SELECT * FROM consensus_rounds ORDER BY updated_at DESC LIMIT ?').all(lim);
    return rows.map(parseRoundRow);
  } catch {
    return [];
  }
}
