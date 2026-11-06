// Owner-side review state. Separate from jobs, cards, notifications and rounds; never an instruction to the team.
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { advisorDir } from './advisor.mjs';
import { holderGone, withFileLock, writeJsonFile } from './filelock.mjs';
import { processStartSync } from './proctree.mjs';
import { emptyReviewLedger, planReview } from './reviewpolicy.mjs';

const fresh = () => ({ version: 1, initialized: false, opened: {}, ledger: emptyReviewLedger(), lease: null, runs: [] });
const idOf = () => randomBytes(16).toString('hex');
// A lease's holder, told by its pid and the time the lease was taken (Windows reuses pids quickly: a pid another program
// has now, one that started after the lease, is not the holder). A start time is asked for once a minute per lease: on
// Windows that is a PowerShell. A lease from before `at` was kept is judged by its pid alone.
const START_LOOK_MS = 60_000;
const looked = new Map();
function leaseHolderAlive(lease, startOf) {
  const at = Number.isFinite(lease.at) ? lease.at : null;
  if (holderGone({ pid: lease.pid, at }, { look: false })) return false;
  if (at === null) return true;
  const key = `${lease.pid}:${at}`, seen = looked.get(key);
  if (seen && Date.now() - seen.t < START_LOOK_MS) return seen.alive;
  const alive = !holderGone({ pid: lease.pid, at }, { look: true, startOf });
  looked.clear(); looked.set(key, { t: Date.now(), alive });
  return alive;
}
const leaseOf = (id, kind) => ({ id, kind, pid: process.pid, at: Date.now() });
const stamp = value => { const n = Date.parse(value); return Number.isFinite(n) && n >= 0 ? n : null; };
const failure = a => !a.notCounted && ['failed', 'timeout', 'blocked', 'no-changes'].includes(a.state);

// Facts from the hub's roadmap and attempt history, never the status document's claim that a milestone is done.
// A planned task with no creation time starts its stall clock when the enabled scheduler first sees it.
export function reviewSnapshot(roadmap, jobs, opened, now) {
  const tasks = new Map(), milestones = [];
  const byId = new Map(jobs.filter(j => j.type === 'task').map(j => [j.id, j]));
  let lastMergeAt = null;
  for (const m of roadmap) {
    const taskIds = [];
    for (const t of m.tasks) {
      const j = byId.get(t.id);
      const merged = stamp(t.mergedAt);
      if (merged !== null) lastMergeAt = Math.max(lastMergeAt ?? 0, merged);
      const openedAt = stamp(j?.createdAt) ?? (Object.hasOwn(opened, t.id) ? opened[t.id] : now);
      Object.defineProperty(opened, t.id, { value: openedAt, writable: true, configurable: true, enumerable: true });
      tasks.set(t.id, { id: t.id, status: t.state === 'merged' ? 'merged' : t.state === 'closed' ? 'closed' : 'open',
        openedAt, failedAttempts: (j?.attempts || []).filter(failure).length });
      taskIds.push(t.id);
    }
    milestones.push({ id: m.key, taskIds });
  }
  return { tasks: [...tasks.values()], milestones, lastMergeAt };
}

export function reviewStore(root, home, { startOf = processStartSync } = {}) {
  const alive = lease => leaseHolderAlive(lease, startOf);
  const file = path.join(advisorDir(root, home), 'reviews.json');
  const read = () => {
    let s;
    try { s = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { if (e.code === 'ENOENT') return fresh(); throw new Error('Advisor review state (reviews.json) is unreadable.'); }
    if (s?.version !== 1 || !Array.isArray(s.runs) || !s.opened || !s.ledger || typeof s.initialized !== 'boolean'
      || (s.lease && (!Number.isInteger(s.lease.pid) || s.lease.pid <= 0 || typeof s.lease.id !== 'string'
        || (s.lease.at !== undefined && !Number.isFinite(s.lease.at)))))
      throw new Error('Advisor review state (reviews.json) is invalid.');
    return s;
  };
  // Unlike ordinary best-effort state writes, admission must never proceed without owning its lock.
  const change = fn => withFileLock(file, stillMine => {
    const s = read();
    if (s.lease && !alive(s.lease)) {
      const run = s.runs.find(r => r.id === s.lease.id);
      if (run && ['reserved', 'running'].includes(run.status)) {
        run.status = 'failed'; run.error = 'The advisor process ended before saving a result. This event will not retry automatically.';
      }
      s.lease = null;
    }
    const result = fn(s);
    if (!writeJsonFile(file, s, { onlyIf: stillMine })) throw new Error('Advisor review state changed under its lock; try again in a minute.');
    return result;
  }, { onLock: r => { if (r.forced) throw new Error('Advisor review state is busy; try again in a minute.'); } });
  const release = id => change(s => { if (s.lease?.id === id) s.lease = null; });
  return {
    file, read,
    leaseAlive: lease => !!lease && alive(lease),
    acquireManual() {
      return change(s => {
        if (s.lease) throw new Error('The advisor is already answering or reviewing. Wait for that session to finish.');
        const id = idOf(); s.lease = leaseOf(id, 'manual'); return id;
      });
    },
    release,
    reserve({ roadmap, jobs, now, reviews, gates }) {
      return change(s => {
        if (reviews?.enabled !== true) return { reason: 'disabled', run: null };
        const snapshot = reviewSnapshot(roadmap, jobs, s.opened, now);
        if (!s.initialized) {
          const tasks = new Map(snapshot.tasks.map(t => [t.id, t]));
          s.ledger.baseline = snapshot.milestones.flatMap(m => {
            const eligible = m.taskIds.filter(id => tasks.get(id).status !== 'closed');
            return eligible.length && eligible.every(id => tasks.get(id).status === 'merged')
              ? [JSON.stringify(['end', m.id]), JSON.stringify(['midpoint', m.id])] : [];
          });
          s.initialized = true;
        }
        const p = planReview({ now, snapshot, ledger: s.ledger, reviews,
          gates: { ...gates, assistantBusy: !!s.lease } });
        s.waiting = p.reason;
        if (!p.candidate) return { reason: p.reason, run: null };
        const run = { id: idOf(), candidate: p.candidate, status: 'reserved', at: now, threadId: '' };
        s.ledger = p.nextLedger; s.runs.push(run);
        s.lease = leaseOf(run.id, 'review');
        return { reason: 'due', run };
      });
    },
    claim(id, allowed) {
      return change(s => {
        const r = s.runs.find(r => r.id === id);
        if (!r || r.status !== 'reserved' || s.lease?.id !== id) return null;
        if (!allowed) {
          // Nothing ran: a hold arriving between reservation and child startup postpones, without spending a credit.
          s.ledger.reservations = s.ledger.reservations.filter(x => x.key !== r.candidate.key);
          r.status = 'deferred'; s.lease = null; return null;
        }
        r.status = 'running'; s.lease = leaseOf(id, s.lease.kind); return r;
      });
    },
    finish(id, result) {
      return change(s => {
        const r = s.runs.find(r => r.id === id);
        if (r && ['reserved', 'running'].includes(r.status)) Object.assign(r, {
          status: result.error ? 'failed' : 'complete', threadId: result.threadId || '', error: result.error || '',
        });
        if (s.lease?.id === id) s.lease = null;
      });
    },
  };
}

export function reviewTitle(candidate) {
  return candidate.kind === 'end' ? `Milestone ${candidate.milestoneId}: completion review`
    : candidate.kind === 'midpoint' ? `Milestone ${candidate.milestoneId}: midpoint review`
    : candidate.kind === 'third-failure' ? `Task ${candidate.taskId}: repeated failures`
    : 'Progress review: a day without a merge';
}

export function reviewQuestion(candidate) {
  const evidence = candidate.kind === 'end' || candidate.kind === 'midpoint'
    ? `${candidate.merged} of ${candidate.total} tasks are merged (closed tasks excluded).`
    : candidate.kind === 'third-failure' ? `${candidate.failedAttempts} failed completed attempts for ${candidate.taskId}.`
    : `No merge for at least a day with tasks open, since ${new Date(candidate.since).toISOString()}. Open tasks: ${(candidate.openTaskIds || []).slice(0, 20).join(', ')} (${candidate.openTaskIds?.length || 0} total).`;
  return `${reviewTitle(candidate)}.\n\n`
    + 'Review the plan against what was built, passing tests against time and tokens spent, scope creep, and the riskiest unproven assumption. '
    + 'Give at most three findings, each with evidence (files, jobs, tests or commits). Say "on track" when warranted; do not invent a problem. '
    + 'This is an automatic read-only review for the owner, not an instruction or approval from them. Never contact or wake the orchestrator, '
    + 'change files, send a note, or change memory. Any suggested action must wait for the owner. End with Sources: naming the evidence.\n\n'
    + `The hub detected this from its task and merge records:\n${evidence.slice(0, 2000)}`;
}
