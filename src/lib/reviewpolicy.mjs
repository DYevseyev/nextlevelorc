// Automatic advisor review admission. No I/O, model decisions, or agent execution.
const DAY = 24 * 60 * 60 * 1000;
const keyFor = (...parts) => JSON.stringify(parts);
const validTime = value => Number.isSafeInteger(value) && value >= 0;
const validId = value => typeof value === 'string' && value.trim().length > 0;
const utcDay = time => new Date(time).toISOString().slice(0, 10);

export const emptyReviewLedger = () => ({ version: 1, reservations: [] });

/**
 * Pure admission policy. The caller must serialize read -> plan -> durable save,
 * then launch only the saved reservation. Never launch from an unsaved result.
 *
 * Snapshot facts come from verified hub state, never model-authored prose.
 * `baseline` covers milestones completed before reviews were first enabled.
 * IDs are immutable for the lifetime of a project. Times are epoch milliseconds.
 */
export function planReview({ now, snapshot, ledger, reviews, gates }) {
  const blocked = reason => ({ reason, candidate: null, nextLedger: ledger });
  if (!validTime(now) || now > 8.64e15) return blocked('invalid-clock');
  if (reviews?.enabled !== true) return blocked('disabled');
  const perDay = reviews.perDay ?? 2;
  if (!Number.isSafeInteger(perDay) || perDay < 0) return blocked('invalid-limit');
  if (!gates || !['updateHold', 'gitHold', 'assistantBusy', 'assistantReady']
    .every(name => typeof gates[name] === 'boolean')) return blocked('unknown-gates');
  if (gates.updateHold) return blocked('update-hold');
  if (gates.gitHold) return blocked('git-hold');
  if (gates.assistantBusy) return blocked('assistant-busy');
  // The hub includes the assistant lock-test result here for Antigravity.
  if (!gates.assistantReady) return blocked('assistant-not-ready');
  if (!validLedger(ledger, now)) return blocked('invalid-ledger');
  if (!validSnapshot(snapshot, now)) return blocked('invalid-snapshot');

  const today = utcDay(now);
  const used = ledger.reservations.filter(item => utcDay(item.startedAt) === today).length;
  if (used >= perDay) return blocked('daily-limit');
  const seen = new Set([...(ledger.baseline || []), ...ledger.reservations.flatMap(item => item.covers)]);
  const tasks = new Map(snapshot.tasks.map(task => [task.id, task]));
  const candidates = [];

  for (const milestone of snapshot.milestones) {
    const eligible = milestone.taskIds.filter(id => tasks.get(id).status !== 'closed');
    const total = eligible.length;
    if (!total) continue;
    const merged = eligible.filter(id => tasks.get(id).status === 'merged').length;
    const midpoint = keyFor('midpoint', milestone.id);
    const end = keyFor('end', milestone.id);
    if (merged === total) {
      // Completion covers midpoint too: a one-task milestone gets one review.
      candidates.push({ kind: 'end', key: end, covers: [end, midpoint],
        milestoneId: milestone.id, merged, total });
    } else if (merged * 2 >= total) {
      candidates.push({ kind: 'midpoint', key: midpoint, covers: [midpoint],
        milestoneId: milestone.id, merged, total });
    }
  }

  const open = snapshot.tasks.filter(task => task.status === 'open');
  for (const task of open) {
    if (task.failedAttempts >= 3) {
      const key = keyFor('third-failure', task.id);
      candidates.push({ kind: 'third-failure', key, covers: [key], taskId: task.id,
        failedAttempts: task.failedAttempts });
    }
  }
  if (open.length) {
    // An old last merge does not make newly opened work immediately stalled.
    const firstOpen = Math.min(...open.map(task => task.openedAt));
    const anchor = Math.max(snapshot.lastMergeAt ?? firstOpen, firstOpen);
    if (now - anchor >= DAY) {
      const key = keyFor('stalled', anchor);
      candidates.push({ kind: 'stalled', key, covers: [key], since: anchor,
        openTaskIds: open.map(task => task.id).sort() });
    }
  }

  const priority = { end: 0, 'third-failure': 1, stalled: 2, midpoint: 3 };
  candidates.sort((a, b) => priority[a.kind] - priority[b.kind]
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const candidate = candidates.find(item => !seen.has(item.key));
  if (!candidate) return blocked('nothing-due');
  const reservation = { key: candidate.key, covers: [...candidate.covers], startedAt: now };
  return { reason: 'due', candidate: { ...candidate, observedAt: now },
    nextLedger: { ...ledger, reservations: [...ledger.reservations, reservation] } };
}

function validLedger(ledger, now) {
  if (ledger?.version !== 1 || !Array.isArray(ledger.reservations)) return false;
  if (ledger.baseline !== undefined && (!Array.isArray(ledger.baseline) || !ledger.baseline.every(validId))) return false;
  const keys = new Set();
  for (const item of ledger.reservations) {
    if (!item || !validId(item.key) || keys.has(item.key)
      || !validTime(item.startedAt) || item.startedAt > now
      || !Array.isArray(item.covers) || !item.covers.length
      || !item.covers.every(validId) || !item.covers.includes(item.key)) return false;
    keys.add(item.key);
  }
  return true;
}

function validSnapshot(snapshot, now) {
  if (!snapshot || !Array.isArray(snapshot.tasks) || !Array.isArray(snapshot.milestones)
    || !(snapshot.lastMergeAt === null
      || (validTime(snapshot.lastMergeAt) && snapshot.lastMergeAt <= now))) return false;
  const tasks = new Set();
  for (const task of snapshot.tasks) {
    if (!task || !validId(task.id) || tasks.has(task.id)
      || !['open', 'merged', 'closed'].includes(task.status)
      || !Number.isSafeInteger(task.failedAttempts) || task.failedAttempts < 0
      || !validTime(task.openedAt) || task.openedAt > now) return false;
    tasks.add(task.id);
  }
  const milestones = new Set();
  for (const milestone of snapshot.milestones) {
    if (!milestone || !validId(milestone.id) || milestones.has(milestone.id)
      || !Array.isArray(milestone.taskIds)
      || new Set(milestone.taskIds).size !== milestone.taskIds.length
      || !milestone.taskIds.every(id => tasks.has(id))) return false;
    milestones.add(milestone.id);
  }
  return true;
}
