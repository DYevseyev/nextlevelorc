import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyReviewLedger, planReview } from '../src/lib/reviewpolicy.mjs';

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-31T12:00:00Z');
const task = (id, status = 'open', failedAttempts = 0, openedAt = NOW - 1000) =>
  ({ id, status, failedAttempts, openedAt });
const milestone = (id, ...taskIds) => ({ id, taskIds });
function input(patch = {}) {
  return { now: NOW, reviews: { enabled: true }, ledger: emptyReviewLedger(),
    gates: { updateHold: false, gitHold: false, assistantBusy: false, assistantReady: true },
    snapshot: { tasks: [task('a', 'merged'), task('b')],
      milestones: [milestone('m', 'a', 'b')], lastMergeAt: NOW - 500 }, ...patch };
}
function deeplyFreeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deeplyFreeze);
    Object.freeze(value);
  }
  return value;
}

test('midpoint requires at least half the tasks to be verified merged', () => {
  const data = input();
  data.snapshot.tasks.push(task('c'));
  data.snapshot.milestones[0].taskIds.push('c');
  assert.equal(planReview(data).reason, 'nothing-due');
  data.snapshot.tasks[2].status = 'merged';
  const result = planReview(data);
  assert.equal(result.candidate.kind, 'midpoint');
  assert.equal(result.candidate.merged, 2);
  assert.equal(result.candidate.total, 3);
});

test('completion supersedes midpoint and remains deduplicated after restart', () => {
  const data = input();
  data.snapshot.tasks[1].status = 'merged';
  const first = planReview(data);
  assert.equal(first.candidate.kind, 'end');
  assert.equal(first.nextLedger.reservations[0].covers.length, 2);
  data.ledger = JSON.parse(JSON.stringify(first.nextLedger));
  assert.equal(planReview(data).reason, 'nothing-due');
  // A later plan expansion cannot resurrect the already covered midpoint.
  data.snapshot.tasks.push(task('c'));
  data.snapshot.milestones[0].taskIds.push('c');
  assert.equal(planReview(data).reason, 'nothing-due');
});

test('one-task and empty milestones do not produce duplicate or empty reviews', () => {
  const data = input({ snapshot: { tasks: [task('a', 'merged')],
    milestones: [milestone('empty'), milestone('m', 'a')], lastMergeAt: NOW } });
  const first = planReview(data);
  assert.equal(first.candidate.kind, 'end');
  assert.equal(planReview({ ...data, ledger: first.nextLedger }).reason, 'nothing-due');
});

test('a previously reviewed midpoint still permits the end review', () => {
  const data = input();
  data.ledger = planReview(data).nextLedger;
  data.snapshot.tasks[1].status = 'merged';
  assert.equal(planReview(data).candidate.kind, 'end');
});

test('third failure is detected even if the hub first observes attempt four, once per task', () => {
  const data = input({ snapshot: { tasks: [task('a', 'open', 2)], milestones: [], lastMergeAt: null } });
  assert.equal(planReview(data).reason, 'nothing-due');
  data.snapshot.tasks[0].failedAttempts = 4;
  const first = planReview(data);
  assert.equal(first.candidate.kind, 'third-failure');
  data.ledger = first.nextLedger;
  data.snapshot.tasks[0].failedAttempts = 5;
  assert.equal(planReview(data).reason, 'nothing-due');
});

test('closed and merged tasks cannot trigger failure or stalled-work reviews', () => {
  const data = input({ snapshot: { tasks: [task('a', 'closed', 3, NOW - 3 * DAY),
    task('b', 'merged', 3, NOW - 3 * DAY)], milestones: [], lastMergeAt: NOW - 2 * DAY } });
  assert.equal(planReview(data).reason, 'nothing-due');
});

test('stall requires a full 24 hours and new work starts its own waiting period', () => {
  const data = input({ snapshot: { tasks: [task('a', 'open', 0, NOW - DAY + 1)],
    milestones: [], lastMergeAt: NOW - 10 * DAY } });
  assert.equal(planReview(data).reason, 'nothing-due');
  data.now += 1;
  assert.equal(planReview(data).candidate.kind, 'stalled');
});

test('a project with no merges can stall, and a later merge resets the stall episode', () => {
  const data = input({ snapshot: { tasks: [task('a', 'open', 0, NOW - 2 * DAY)],
    milestones: [], lastMergeAt: null } });
  const first = planReview(data);
  assert.equal(first.candidate.kind, 'stalled');
  data.ledger = first.nextLedger;
  data.now += DAY;
  assert.equal(planReview(data).reason, 'nothing-due');
  data.snapshot.lastMergeAt = NOW;
  const second = planReview(data);
  assert.equal(second.candidate.kind, 'stalled');
  assert.notEqual(second.candidate.key, first.candidate.key);
});

test('default cap is two durable reservations per UTC day, including failed launches', () => {
  const data = input({ snapshot: { tasks: ['a', 'b', 'c'].map(id => task(id, 'open', 3)),
    milestones: [], lastMergeAt: NOW } });
  data.ledger = planReview(data).nextLedger;
  data.ledger = planReview(data).nextLedger;
  assert.equal(planReview(data).reason, 'daily-limit');
  data.now = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(planReview(data).candidate.taskId, 'c');
});

test('off switch, zero cap, all holds and assistant readiness prevent reservations', () => {
  const cases = [
    [{ reviews: {} }, 'disabled'],
    [{ reviews: { enabled: false } }, 'disabled'],
    [{ reviews: { enabled: true, perDay: 0 } }, 'daily-limit'],
    [{ gates: {} }, 'unknown-gates'],
    ...[['updateHold', true, 'update-hold'], ['gitHold', true, 'git-hold'],
      ['assistantBusy', true, 'assistant-busy'], ['assistantReady', false, 'assistant-not-ready']]
      .map(([name, value, reason]) => [{ gates: { ...input().gates, [name]: value } }, reason]),
  ];
  for (const [patch, reason] of cases) {
    const data = input(patch);
    const result = planReview(data);
    assert.equal(result.reason, reason);
    assert.equal(result.candidate, null);
    assert.equal(result.nextLedger, data.ledger);
  }
});

test('corrupt facts, unknown ledger versions and clock rollback fail closed', () => {
  const checks = [
    [data => { data.now = NaN; }, 'invalid-clock'],
    [data => { data.reviews.perDay = -1; }, 'invalid-limit'],
    [data => { data.reviews.perDay = 1.5; }, 'invalid-limit'],
    [data => { data.ledger.version = 2; }, 'invalid-ledger'],
    [data => { data.snapshot.tasks.push(data.snapshot.tasks[0]); }, 'invalid-snapshot'],
    [data => { data.snapshot.tasks[0].status = 'probably merged'; }, 'invalid-snapshot'],
    [data => { data.snapshot.milestones[0].taskIds.push('missing'); }, 'invalid-snapshot'],
    [data => { data.snapshot.milestones[0].taskIds.push('a'); }, 'invalid-snapshot'],
    [data => { data.snapshot.lastMergeAt = NOW + 1; }, 'invalid-snapshot'],
    [data => { data.snapshot.tasks[1].openedAt = NOW + 1; }, 'invalid-snapshot'],
    [data => { data.ledger = planReview(data).nextLedger; data.now--; }, 'invalid-ledger'],
  ];
  for (const [edit, reason] of checks) {
    const data = input(); edit(data);
    assert.equal(planReview(data).reason, reason);
  }
});

test('completion takes priority; task ordering cannot change the next review', () => {
  const data = input({ snapshot: { tasks: [task('z', 'open', 3), task('a', 'open', 3), task('done', 'merged')],
    milestones: [milestone('m', 'done')], lastMergeAt: NOW } });
  const first = planReview(data);
  assert.equal(first.candidate.kind, 'end');
  data.ledger = first.nextLedger;
  assert.equal(planReview(data).candidate.taskId, 'a');
  data.snapshot.tasks.reverse();
  assert.equal(planReview(data).candidate.taskId, 'a');
});

test('planning is deterministic and does not mutate frozen input or reserve implicitly', () => {
  const data = deeplyFreeze(input());
  const before = JSON.stringify(data);
  const first = planReview(data);
  assert.deepEqual(planReview(data), first);
  assert.equal(JSON.stringify(data), before);
  assert.equal(data.ledger.reservations.length, 0);
  assert.equal(first.nextLedger.reservations.length, 1);
});

test('closed work does not prevent completion, and an entirely closed milestone has no review', () => {
  const data = input({ snapshot: { tasks: [task('a', 'merged'), task('b', 'closed')], milestones: [milestone('m', 'a', 'b')], lastMergeAt: NOW } });
  assert.equal(planReview(data).candidate.kind, 'end');
  data.snapshot.tasks[0].status = 'closed';
  assert.equal(planReview(data).reason, 'nothing-due');
});
