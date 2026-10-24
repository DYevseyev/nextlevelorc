// FR-019: autopilot starts a round only because something happened (lib/rounds.mjs), never on a timer. The pure part
// here, with a clock the test moves (times are ISO strings in UTC); the hub with a stub orchestrator and a fake clock in
// test/autopilot.test.mjs.
//   node --test test/rounds.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ROUND_DEFAULTS, WAKE_MAX_MIN, addTrigger, autopilotOn, decide, freshState, noteReal, oneLine, roundEnded, roundStarted, roundsProblem, takeWake, waitView, wakeKey } from '../src/lib/rounds.mjs';

const cfg = { ...ROUND_DEFAULTS, perHour: 8 };
const T = (iso) => Date.parse(iso);
const MIN = 60_000;
const nothingSeen = () => false;
// One look of the hub: a round starts if decide() says so. -> the round's reasons, or null
function look(s, now, seen = nothingSeen) {
  const d = decide(s, { now, cfg, seen });
  if (!d.start) return null;
  const r = roundStarted(s, { now, reasons: d.reasons, cfg });
  return { reasons: d.reasons.map((x) => x.type), fuse: r.fuse };
}

test('4 October replayed (FR-019): after H22 nothing starts a round until the owner replies, the next morning', () => {
  // The day as a real project's hub log, round logs and card H22 have it (event types and times only, UTC)
  const timeline = [
    { at: '2026-10-04T15:12:12Z', kind: 'task-end', job: 'WS-62' }, // attempt 10 of the held task ends
    { at: '2026-10-04T15:16:01Z', kind: 'team-card' }, // the round raises H22 (the team's card: not real)
    { at: '2026-10-04T15:18:03Z', kind: 'team-commit' }, // ... commits STATUS.md (not real)
    { at: '2026-10-04T15:18:48Z', kind: 'round-end' },
    { at: '2026-10-05T03:04:07Z', kind: 'hub-stop' }, // the PC restarts (no hub until 07:21)
    { at: '2026-10-05T07:21:05Z', kind: 'hub-start' },
    { at: '2026-10-05T08:00:05Z', kind: 'bridge' }, // the owner's bridge test (its tasks are no team work)
    { at: '2026-10-05T08:20:52Z', kind: 'owner-reply' }, // the owner replies on H22
  ];
  let s = freshState();
  const rounds = [];
  let hubUp = true;
  const events = [...timeline];
  // The hub looks every minute while it runs, from just before the task's end to 09:00 the next day
  for (let now = T('2026-10-04T15:12:00Z'); now <= T('2026-10-05T09:00:00Z'); now += MIN) {
    while (events.length && T(events[0].at) <= now) {
      const e = events.shift();
      if (e.kind === 'task-end') addTrigger(s, { type: 'task', what: `task ${e.job} ended`, job: e.job }, now);
      if (e.kind === 'owner-reply') {
        noteReal(s, 'your reply on H22', now);
        addTrigger(s, { type: 'owner', what: 'your reply on H22' }, now);
      }
      if (e.kind === 'round-end') roundEnded(s, { now, how: 'ok', cfg });
      if (e.kind === 'hub-stop') hubUp = false;
      if (e.kind === 'hub-start') {
        hubUp = true;
        s = JSON.parse(JSON.stringify(s)); // what rounds.json kept
      }
      // team-card, team-commit, bridge: nothing for the rounds
    }
    if (!hubUp || s.round) continue;
    const started = look(s, now, (id) => id === 'WS-62' && now > T('2026-10-04T15:18:48Z'));
    if (started) rounds.push({ at: new Date(now).toISOString(), ...started });
    // the round after the reply ends at once
    if (started && now > T('2026-10-05T08:00:00Z')) roundEnded(s, { now, how: 'ok', cfg });
  }
  assert.deepEqual(rounds.map((r) => [r.at.slice(0, 16), r.reasons]), [
    ['2026-10-04T15:13', ['task']], // the round that reviewed WS-62 and raised H22
    ['2026-10-05T08:21', ['owner']], // the owner's reply: and nothing in between (a real project ran 95)
  ]);
});

test('the brake: after the last real event three rounds at most for what isn\'t the owner or a task; a real event releases it', () => {
  const s = freshState();
  let now = T('2026-10-06T10:00:00Z');
  noteReal(s, 'your new note N1', now);
  addTrigger(s, { type: 'owner', what: 'your new note N1' }, now);
  const started = [];
  const round = (how = 'ok') => {
    const r = look(s, now);
    if (r) {
      started.push(r.reasons.join('+'));
      now += 2 * MIN;
      roundEnded(s, { now, how, cfg });
    }
    now += MIN;
    return r;
  };
  round(); // the note
  // An orchestrator that keeps itself busy: a check job ending, a wake-up, again and again
  for (let i = 0; i < 6; i++) {
    addTrigger(s, { type: 'job', what: `the check awake-${i} ended`, job: `check-${i}` }, now);
    round();
  }
  assert.deepEqual(started, ['owner', 'job', 'job'], 'three rounds since the note, then nothing');
  assert.match(s.dropped.what, /the check awake-5 ended/);
  // A wake-up that comes due under the brake is let go, and cleared
  takeWake(s, { askedAt: new Date(now).toISOString(), minutes: 5, reason: 'CI' }, { cfg });
  assert.equal(s.wake.waits, 40, 'three rounds in a row found nothing new: 5 doubled three times');
  now = T(s.wake.due);
  assert.equal(round(), null);
  assert.equal(s.wake, null);
  // The owner and a task's end always start one
  addTrigger(s, { type: 'task', what: 'task M1-01 ended', job: 'M1-01' }, now);
  assert.deepEqual(round().reasons, ['task']);
  // A real event (a task dispatched) releases the brake as it happens
  noteReal(s, 'task M1-02 was dispatched', now);
  addTrigger(s, { type: 'job', what: 'the check ci ended', job: 'check-ci' }, now);
  assert.deepEqual(round().reasons, ['job']);
});

test('the round right after one in which work moved; a job end the round reviewed starts nothing; triggers together start one round', () => {
  const s = freshState();
  let now = T('2026-10-06T10:00:00Z');
  addTrigger(s, { type: 'task', what: 'task A ended', job: 'A' }, now);
  addTrigger(s, { type: 'task', what: 'task B ended', job: 'B' }, now);
  noteReal(s, 'your reply on H3', now);
  addTrigger(s, { type: 'owner', what: 'your reply on H3' }, now);
  assert.deepEqual(look(s, now).reasons, ['owner', 'task', 'task'], 'one round for all three');
  // During the round: a check ends (the round reviews it) and the round merges A
  addTrigger(s, { type: 'job', what: 'the check t ended', job: 'check-t' }, now);
  noteReal(s, 'task A was merged into main', now);
  now += 5 * MIN;
  const end = roundEnded(s, { now, how: 'ok', cfg });
  assert.equal(end.real, true);
  const next = look(s, now, (id) => id === 'check-t');
  assert.deepEqual(next.reasons, ['next'], 'the round right after, and not for the check it reviewed');
  assert.match(s.round.what, /right after a round in which task A was merged into main/);
  roundEnded(s, { now, how: 'ok', cfg });
  assert.equal(look(s, now), null, 'nothing real in that one: nothing follows');
});

test('the fuse: six rounds in a row with nothing real between them, whatever started them', () => {
  const s = freshState();
  let now = T('2026-10-06T10:00:00Z');
  const fuses = [];
  for (let i = 1; i <= 6; i++) {
    addTrigger(s, { type: 'task', what: `task T${i} was stopped from outside`, job: `T${i}` }, now);
    const r = look(s, now);
    fuses.push(r.fuse);
    now += 10 * MIN;
    roundEnded(s, { now, how: 'ok', cfg });
    now += 20 * MIN; // (the hourly ceiling is no part of it)
  }
  assert.deepEqual(fuses, [false, false, false, false, false, true]);
  // Something real in between starts the count again; turning autopilot on releases the brake and the fuse
  noteReal(s, 'task T7 was dispatched', now);
  addTrigger(s, { type: 'task', what: 'task T7 ended', job: 'T7' }, now);
  assert.equal(look(s, now).fuse, false);
  assert.equal(s.streak, 1);
  autopilotOn(s, new Date(now).toISOString());
  assert.deepEqual([s.streak, s.sinceReal, s.fuse], [0, 0, null]);
});

test('wake-ups: a round that asks for one gets no round right after it; the shortest wait doubles for each round in a row with nothing real (5, 10, 20) and is 5 again after a real event; a longer ask stands; one at a time, cleared by any round', () => {
  const s = freshState();
  let now = T('2026-11-01T05:00:00Z');
  const iso = (t) => new Date(t).toISOString();
  noteReal(s, 'your note N1', now);
  addTrigger(s, { type: 'owner', what: 'your note N1' }, now);
  look(s, now);
  // The round pushes (real) and asks for 1 minute: its time is set at the round's end, at least 5 minutes after the ask
  noteReal(s, '3 commit(s) were pushed to ci/m1', now + MIN);
  assert.equal(takeWake(s, { askedAt: iso(now + 2 * MIN), minutes: 1, reason: 'the CI run of ci/m1 is still running' }, { cfg }), 'taken');
  assert.equal(s.wake.due, null);
  now += 3 * MIN;
  roundEnded(s, { now, how: 'ok', cfg });
  assert.deepEqual([s.wake.waits, s.wake.due, s.wake.why, s.idle], [5, '2026-11-01T05:07:00.000Z', 'the shortest wake-up is 5 min', 0]);
  // Work moved in it, but it asked for a wake-up: that is its next round, none comes right after it
  assert.equal(look(s, now), null, 'no round right after');
  now = T(s.wake.due);
  assert.deepEqual(look(s, now).reasons, ['wake']);
  assert.equal(s.wake, null, 'the round that starts clears it');
  // Nothing real in that one (CI still runs): it asks again for 1 minute, and waits 10
  takeWake(s, { askedAt: iso(now + MIN), minutes: 1, reason: 'still running' }, { cfg });
  now += 2 * MIN;
  roundEnded(s, { now, how: 'ok', cfg });
  assert.deepEqual([s.wake.waits, s.idle, s.wake.why], [10, 1, 'the shortest wake-up is 10 min after one round in a row that found nothing new']);
  assert.equal(look(s, now), null, 'not due yet');
  now = T(s.wake.due);
  assert.deepEqual(look(s, now).reasons, ['wake']);
  // Again nothing: 20
  takeWake(s, { askedAt: iso(now + MIN), minutes: 1, reason: 'still running' }, { cfg });
  now += 2 * MIN;
  roundEnded(s, { now, how: 'ok', cfg });
  assert.deepEqual([s.wake.waits, s.idle], [20, 2]);
  // A longer ask stands as asked (asked outside a round, in the orchestrator's window: its time is set at once)
  takeWake(s, { askedAt: iso(now + MIN), minutes: 30, reason: 'a long build' }, { cfg });
  assert.deepEqual([s.wake.waits, s.wake.why], [30, '']);
  // A new ask replaces the old; one from before the last round started is stale
  takeWake(s, { askedAt: iso(now + 2 * MIN), minutes: 45, reason: 'the deploy' }, { cfg });
  assert.equal(s.wake.reason, 'the deploy');
  assert.equal(takeWake(s, { askedAt: iso(now - 30 * MIN), minutes: 5, reason: 'old' }, { cfg }), 'stale');
  assert.equal(s.wake.reason, 'the deploy');
  // Any round clears it (the owner's here); a real event in a round makes the shortest wait 5 again
  noteReal(s, 'your reply on H1', now + 3 * MIN);
  addTrigger(s, { type: 'owner', what: 'your reply on H1' }, now + 3 * MIN);
  look(s, now + 3 * MIN);
  assert.equal(s.wake, null);
  noteReal(s, 'task T4 was dispatched', now + 4 * MIN);
  takeWake(s, { askedAt: iso(now + 5 * MIN), minutes: 1, reason: 'the CI run of ci/m2' }, { cfg });
  roundEnded(s, { now: now + 6 * MIN, how: 'ok', cfg });
  assert.deepEqual([s.wake.waits, s.idle], [5, 0]);
  assert.equal(look(s, now + 6 * MIN), null, 'work moved, but it asked for a wake-up: no round right after it');
  // Without a wake-up, a round in which work moved still gets the next one straight after it
  const due = T(s.wake.due);
  assert.deepEqual(look(s, due).reasons, ['wake']);
  noteReal(s, 'task T4 was merged into main', due + MIN);
  roundEnded(s, { now: due + 2 * MIN, how: 'ok', cfg });
  assert.deepEqual(look(s, due + 2 * MIN).reasons, ['next']);
});

test('a round cut off gets one retry; one whose engine never started waits again, counts for the hour, and two in a row stop autopilot', () => {
  const s = freshState();
  let now = T('2026-10-06T10:00:00Z');
  addTrigger(s, { type: 'task', what: 'task A ended', job: 'A' }, now);
  look(s, now);
  // Its engine never started (its process found no console): its trigger waits again, the brake and the fuse don't count
  // it, the hourly ceiling does, and Home says what failed
  const first = roundEnded(s, { now, how: 'not-started', cfg, why: "the round's process found no console to give Antigravity (exit 3)" });
  assert.deepEqual([first.notStarted, first.stop], [true, false]);
  assert.deepEqual([s.pending.map((t) => t.type), s.sinceReal, s.streak, s.starts.length, s.notStarted], [['task'], 0, 0, 1, 1]);
  assert.match(waitView(s, { on: true, hubRunning: true, cfg, now, time: (x) => x }).text, /because task A ended \(the last round didn't start: the round's process found no console to give Antigravity \(exit 3\)\)$/);
  // The second in a row: autopilot turns itself off (the hub does it); what started them still waits
  look(s, now);
  const second = roundEnded(s, { now, how: 'not-started', cfg, why: 'its process ended with exit 127 before it started Antigravity (it was not found)' });
  assert.deepEqual([second.stop, s.notStarted, s.starts.length, s.pending.map((t) => t.type)], [true, 2, 2, ['task']]);
  autopilotOn(s, new Date(now).toISOString());
  assert.equal(s.notStarted, 0, 'turned on again: counted from zero');
  // A round whose engine started is a round, whatever became of it: the count starts again
  look(s, now);
  roundEnded(s, { now, how: 'not-started', cfg, why: 'x' });
  look(s, now);
  roundEnded(s, { now, how: 'crash', cfg });
  assert.equal(s.notStarted, 0);
  assert.deepEqual(look(s, now).reasons, ['retry'], 'a crash is a round that ran, cut off: its one retry');
  roundEnded(s, { now, how: 'ok', cfg });
  autopilotOn(s, new Date(now).toISOString());
  addTrigger(s, { type: 'task', what: 'task A ended', job: 'A' }, now);
  assert.deepEqual(look(s, now).reasons, ['task']);
  now += 61 * MIN;
  assert.match(roundEnded(s, { now, how: 'limit', cfg }).cut, /ran past its 60-minute limit/);
  assert.deepEqual(look(s, now).reasons, ['retry']);
  now += 2 * MIN;
  roundEnded(s, { now, how: 'crash', cfg });
  assert.equal(look(s, now), null, 'one retry, not two');
  // (a retry is held by the brake like the rest: here a dispatch released it first)
  noteReal(s, 'task B was dispatched', now);
  addTrigger(s, { type: 'task', what: 'task B ended', job: 'B' }, now);
  look(s, now);
  roundEnded(s, { now, how: 'outside', cfg });
  assert.deepEqual(look(s, now).reasons, ['retry'], 'a stop from outside is cut off too');
  roundEnded(s, { now, how: 'outside', cfg });
  addTrigger(s, { type: 'task', what: 'task C ended', job: 'C' }, now);
  look(s, now);
  roundEnded(s, { now, how: 'crash', cfg });
  assert.equal(look(s, now), null, 'three rounds since the dispatch: the brake holds the retry back');
});

test('at most eight rounds an hour, as a ceiling: what waits starts once the hour lets it', () => {
  const s = freshState();
  let now = T('2026-10-06T10:00:00Z');
  for (let i = 0; i < 9; i++) {
    noteReal(s, `your note N${i}`, now);
    addTrigger(s, { type: 'owner', what: `your note N${i}` }, now);
    const d = decide(s, { now, cfg, seen: nothingSeen });
    if (i < 8) {
      roundStarted(s, { now, reasons: d.reasons, cfg });
      roundEnded(s, { now: now + MIN, how: 'ok', cfg });
      s.pending = []; // (the round right after each is left out here)
    } else assert.deepEqual([d.start, d.until], [false, '2026-10-06T11:00:00.000Z']);
    now += 2 * MIN;
  }
  assert.equal(decide(s, { now: T('2026-10-06T11:00:01Z'), cfg, seen: nothingSeen }).start, true, 'the owner\'s note waited, it wasn\'t lost');
});

test("Home's sentence: what the next round waits for, a wake-up's time, the brake, the fuse", () => {
  const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
  const base = { on: true, hubRunning: true, cfg, now: T('2026-10-04T19:00:00Z'), cards: ['H22'], time };
  const s = freshState();
  assert.equal(waitView(s, { ...base, tasksActive: 1 }).text, 'Waits for your reply on H22, a new note, or a task finishing');
  assert.equal(waitView(s, base).text, 'Waits for your reply on H22, a new note, or Run a round now');
  s.wake = { askedAt: '2026-10-04T19:00:00Z', minutes: 10, reason: 'the CI run of ci/m1 is still running', due: '2026-10-04T19:10:00Z', waits: 10 };
  assert.equal(waitView(s, base).text, 'Next round at 3:10 PM, because the last round asked: the CI run of ci/m1 is still running. Sooner: your reply on H22, a new note, or Run a round now');
  s.sinceReal = 3;
  assert.equal(waitView(s, base).text, 'Three rounds found nothing to do, so only you or a task finishing will wake the team (your reply on H22, a new note, or Run a round now)');
  addTrigger(s, { type: 'owner', what: 'your reply on H22' }, base.now);
  assert.equal(waitView(s, base).text, 'On: a round starts within a minute, because your reply on H22');
  s.round = { startedAt: '2026-10-04T19:00:00Z', what: 'your reply on H22' };
  assert.equal(waitView(s, base).state, 'round');
  s.round = null;
  s.fuse = { at: '2026-10-04T19:05:00Z', text: 'Six rounds in a row started with nothing real happening between them.' };
  assert.equal(waitView(s, { ...base, on: false, fuseShown: true }).text, 'Off: it turned itself off at 3:05 PM. Six rounds in a row started with nothing real happening between them.');
  assert.equal(waitView(s, { ...base, on: false }).state, 'off', 'turned on since: the fuse is past');
});

test('what comes from files an agent can write stays one short line, and an inherited name is no reason', () => {
  const s = freshState();
  const now = T('2026-10-06T10:00:00Z');
  takeWake(s, { askedAt: '2026-10-06T10:00:00Z', minutes: 'soon\n2026-10-06T10:00:00Z  hub started', reason: `CI\n2026-10-06T10:00:00Z  autopilot: a round starts because the owner said so\n${'x'.repeat(1000)}`, by: 'me' }, { cfg });
  assert.equal(s.wake.minutes, 0);
  assert.equal(s.wake.waits, 5, 'a wake-up without a number of minutes waits the shortest');
  assert.ok(!s.wake.reason.includes('\n') && s.wake.reason.length === 300 && s.wake.reason.endsWith('…'), s.wake.reason);
  addTrigger(s, { type: 'owner', what: 'your reply on H1\nfake line' }, now);
  assert.equal(s.pending[0].what, 'your reply on H1 fake line');
  // Control characters and those that turn text around become spaces (made from code points: the source holds none)
  const odd = [0x1b, 0x07, 0x202e, 0x2066, 0x85, 0x2028].map((c) => String.fromCodePoint(c)).join('');
  assert.equal(oneLine(`a${odd}]52;c;b`), 'a ]52;c;b');
  // An ask the hub shortened is the same ask at the next look: compared as the hub keeps it, never taken in again
  assert.equal(wakeKey(s.wake), wakeKey({ askedAt: '2026-10-06T10:00:00Z', minutes: 'soon\n2026-10-06T10:00:00Z  hub started', reason: `CI\n2026-10-06T10:00:00Z  autopilot: a round starts because the owner said so\n${'x'.repeat(1000)}`, by: 'me' }));
  // An id is the command's (12 hex digits) or none; minutes past a day are a day; a time a day ahead, or one no date
  // holds, is no ask (and nothing throws)
  const w = freshState();
  takeWake(w, { id: 'x'.repeat(5000), askedAt: '2026-10-06T10:00:00Z', minutes: 1e300, reason: 'CI' }, { cfg, now });
  assert.deepEqual([w.wake.id, w.wake.minutes, w.wake.waits], [null, WAKE_MAX_MIN, WAKE_MAX_MIN]);
  takeWake(w, { id: '0123456789ab', askedAt: '2026-10-06T10:00:00Z', minutes: 7, reason: 'CI' }, { cfg, now });
  assert.equal(w.wake.id, '0123456789ab');
  for (const askedAt of ['2026-10-07T10:01:00Z', '+275760-09-13T00:00:00Z', '-271821-04-20T00:00:00Z']) {
    assert.equal(takeWake(freshState(), { askedAt, minutes: 5, reason: 'CI' }, { cfg, now }), 'stale', askedAt);
  }
  // An ask whose fields aren't text (an agent wrote the file: objects that throw when made a string) is no ask, and
  // nothing throws
  const notText = JSON.parse('{"id":{"toString":0},"askedAt":{"toString":0},"minutes":{"toString":0},"reason":{"toString":0},"by":{"toString":0}}');
  assert.equal(wakeKey(notText), '|0|0|no reason given');
  assert.equal(takeWake(freshState(), notText, { cfg, now }), 'stale');
  assert.equal(oneLine({ toString: 0 }), '');
  // The doubling stops at a day
  const d = freshState();
  d.last = { startedAt: '2026-10-06T09:00:00Z', real: false };
  d.idle = 40;
  takeWake(d, { askedAt: '2026-10-06T10:00:00Z', minutes: 5, reason: 'CI' }, { cfg, now });
  assert.equal(d.wake.waits, WAKE_MAX_MIN);
  // A trigger whose type is an inherited name is held by the brake like any that isn't the owner's or a task's
  const t = freshState();
  t.sinceReal = 3;
  addTrigger(t, { type: '__proto__', what: 'x' }, now);
  addTrigger(t, { type: 'constructor', what: 'y' }, now);
  assert.equal(decide(t, { now, cfg, seen: nothingSeen }).start, false);
});

test("a nextlevel.json from before FR-019, with hub but no hub.rounds (as a real project's), gets the defaults and passes validation; a partial one keeps the rest", async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { loadConfig } = await import('../src/lib/config.mjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-config-'));
  try {
    const old = loadConfig(root, { raw: { version: 1, hub: { autopilot: true, reportHour: 20 } }, env: {} });
    assert.deepEqual(old.config.hub.rounds, { brake: 3, fuse: 6, wakeMinMinutes: 5 });
    assert.deepEqual(old.warnings, []);
    assert.equal(old.config.hub.autopilot, true);
    const some = loadConfig(root, { raw: { version: 1, hub: { rounds: { fuse: 4 } } }, env: {} });
    assert.deepEqual(some.config.hub.rounds, { brake: 3, fuse: 4, wakeMinMinutes: 5 });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rounds.json's shape: every state the rules make passes, and a field that isn't its type (an agent wrote the file) is named", () => {
  const s = freshState();
  const now = T('2026-10-06T10:00:00Z');
  const states = [JSON.parse(JSON.stringify(s))];
  noteReal(s, 'your note N1', now);
  addTrigger(s, { type: 'owner', what: 'your note N1' }, now);
  addTrigger(s, { type: 'job', what: 'the check c1 ended', job: 'check-c1' }, now);
  states.push(JSON.parse(JSON.stringify(s)));
  look(s, now);
  s.round.log = '.nextlevel/logs/orchestrator-1.log';
  s.round.engine = 'codex';
  s.round.startedReal = now;
  takeWake(s, { id: '0123456789ab', askedAt: '2026-10-06T10:01:00Z', minutes: 5, reason: 'CI', by: 'an autopilot round' }, { cfg });
  states.push(JSON.parse(JSON.stringify(s)));
  roundEnded(s, { now: now + 2 * MIN, how: 'crash', cfg });
  s.fuse = { at: '2026-10-06T10:03:00.000Z', text: 'off', kind: 'fuse' };
  s.failed = { at: '2026-10-06T10:03:00.000Z', why: 'exit 3' };
  s.owner = { notes: 2, handoff: 0 };
  s.runNow = 1;
  s.queued = ['T1@2026-10-06T10:00:00.000Z'];
  s.wakeTaken = 'k';
  states.push(JSON.parse(JSON.stringify(s)));
  look(s, now + 3 * MIN);
  roundEnded(s, { now: now + 4 * MIN, how: 'not-started', cfg, why: 'exit 42' });
  states.push(JSON.parse(JSON.stringify(s)));
  for (const st of states) assert.equal(roundsProblem(st), '', JSON.stringify(st));
  // A field written as an object that throws when made a string, or of another type, is named
  const notText = { toString: 0 };
  const bad = (patch) => roundsProblem({ ...states[2], ...patch });
  assert.equal(bad({ round: { ...states[2].round, log: notText } }), 'round');
  assert.equal(bad({ round: { ...states[2].round, what: notText } }), 'round');
  assert.equal(bad({ pending: 5 }), 'pending');
  assert.equal(bad({ pending: [{ type: 'owner', what: notText, at: 'x' }] }), 'pending');
  assert.equal(bad({ wake: { ...states[2].wake, reason: notText } }), 'wake');
  assert.equal(bad({ starts: ['2026-10-06T10:00:00Z', 7] }), 'starts');
  assert.equal(bad({ sinceReal: '1' }), 'sinceReal');
  assert.equal(bad({ owner: { notes: notText, handoff: 0 } }), 'owner');
  assert.equal(roundsProblem(null), 'the state');
  assert.equal(roundsProblem({ ...states[0], version: 2 }), 'version');
});
