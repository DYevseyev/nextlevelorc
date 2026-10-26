// FR-019: autopilot starts a round only because something happened. The hub with a stub orchestrator (test/stubs/team.mjs,
// STUB_ORCH_PLAY) and a test clock (NEXTLEVEL_TEST_CLOCK, lib/clock.mjs): hours pass without waiting for them. The pure
// rules are in test/rounds.test.mjs.
//   node --test test/autopilot.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO, hubRounds, makeProject, processesGone, testClock, waitUntil } from './helpers.mjs';
import { readLedger } from '../src/lib/usage.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';


const hubLog = (p) => (fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '');
const started = (p) => (hubLog(p).match(/autopilot: a round starts because/g) || []).length;
const ended = (p) => (hubLog(p).match(/autopilot: (cycle ended|the round didn't start)/g) || []).length;
const reasons = (p) => [...hubLog(p).matchAll(/autopilot: a round starts because (.*)/g)].map((m) => m[1]);
// That nothing happens is known once autopilot has looked `n` more times (every 12 rounds of the hub's loop)
const looks = (p, n = 2) => hubRounds(p, 12 * n + 2);
const until = (p, what, check, ms = 90_000) =>
  waitUntil(what, check, ms).catch((err) => {
    throw new Error(`${err.message}\n${hubLog(p)}`);
  });

// A project with autopilot on and the team's card H1 open (what the owner is asked for)
function project({ card = true } = {}) {
  const p = makeProject();
  if (card) {
    fs.writeFileSync(path.join(p.repo, '.nextlevel-request.md'), 'Decide how to resume the task.\nWhere: the dashboard, card H1\nWhy: two attempts failed\n');
    const r = p.hub(['handoff', 'add', '--file', '.nextlevel-request.md']);
    assert.match(r.out, /Added H1/, r.out);
  }
  fs.mkdirSync(p.state(), { recursive: true });
  fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: true }));
  return p;
}
function startHub(p, clock, env = {}) {
  const bg = p.hubInBackground(['run', '--tick-ms', '50'], { ...clock.env, ...env });
  return bg;
}
async function hubUp(p, bg) {
  const before = (hubLog(p).match(/hub started/g) || []).length;
  await until(p, 'the hub to start', () => (hubLog(p).match(/hub started/g) || []).length > before && fs.existsSync(p.state('hub.json')));
  return bg;
}
async function stopHub(p, bg) {
  if (!bg || bg.exitCode !== null) return;
  fs.writeFileSync(p.state('hub-stop.json'), '{}');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      bg.kill();
      resolve();
    }, 30_000);
    bg.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  await processesGone([bg.pid]);
}
// A worker the hub started minutes ago whose processes are gone without a report: it is stopped from outside
// (in a slot no real task has used: one that has, still has that task's report)
function stoppedTask(p, id, slot = 1) {
  const gone = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }).stdout);
  const at = new Date(Date.now() - 180_000).toISOString();
  fs.mkdirSync(path.dirname(p.jobFile(id, 'job.json')), { recursive: true });
  fs.writeFileSync(p.jobFile(id, 'job.json'), JSON.stringify({ id, type: 'task', kind: 'code', engine: 'agy', attempt: 1, timeoutMin: 60 }));
  // (run.json first: the hub reads the status at any moment)
  fs.writeFileSync(p.jobFile(id, 'run.json'), JSON.stringify({ pid: gone(), startedAt: at }));
  fs.writeFileSync(p.jobFile(id, 'status.json'), JSON.stringify({ id, type: 'task', kind: 'code', state: 'running', slot, attempt: 1, engine: 'agy', startedAt: at, acked: false, launch: { mode: 'console', token: 't', at } }));
}
const statusJson = (p, env = {}) => JSON.parse(p.hub(['status', '--json'], { extraEnv: env }).out);
// A state file as it is now (null while it isn't there or is being written)
const readState = (p, name) => {
  try {
    return JSON.parse(fs.readFileSync(p.state(name), 'utf8'));
  } catch {
    return null;
  }
};
// A file replaced in one rename, the way an agent could replace it (Windows: the hub may be reading it)
function writeOver(file, value) {
  fs.writeFileSync(`${file}.test`, JSON.stringify(value));
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(`${file}.test`, file);
      return;
    } catch (err) {
      if (i > 50) throw err;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

test('only an owner card open and nothing running: no round for hours; the owner\'s reply starts exactly one (FR-019)', async () => {
  const p = project();
  const clock = testClock(p, '2026-10-04T15:16:01Z'); // H22 went up
  let bg;
  try {
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await looks(p, 2);
    // Twelve hours pass, a half hour at a time: nothing starts a round (a real project's hub ran 95)
    for (let i = 0; i < 24; i++) {
      clock.add(30);
      await looks(p, 1);
    }
    assert.equal(started(p), 0, hubLog(p));
    assert.equal(statusJson(p, clock.env).autopilotNext, 'Waits for your reply on H1, a new note, or Run a round now');
    // The owner replies: one round
    const head = p.git('rev-parse', 'HEAD');
    assert.match(p.hub(['handoff', 'reply', 'H1', 'Go with option 1']).out, /Replied to H1/);
    await until(p, 'a round for the reply, and its end', () => started(p) === 1 && ended(p) === 1);
    assert.deepEqual(reasons(p), ['your reply on H1']);
    // It found nothing new: STATUS.md written, and no commit, as the role doc says; its STATUS.md is no progress (the hub
    // before FR-019 counted its time as some), so nothing follows it
    assert.equal(p.git('rev-parse', 'HEAD'), head, 'a round with nothing new commits nothing');
    assert.match(fs.readFileSync(path.join(p.repo, 'docs', 'STATUS.md'), 'utf8'), /round at .*: nothing new/);
    clock.add(120);
    await looks(p, 3);
    assert.equal(started(p), 1, hubLog(p));
    assert.match(hubLog(p), /autopilot: cycle ended \(exit 0, nothing real happened\)/);
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('a task attempt that ends starts one round, a task stopped from outside too; triggers together start one (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  let bg;
  try {
    p.spec('M1-01-ok', 'node -e "0"');
    p.hub(['dispatch', 'M1-01-ok']);
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await until(p, 'a round for the finished task', () => started(p) === 1 && ended(p) === 1);
    assert.match(reasons(p)[0], /^task M1-01-ok ended \(done, attempt 1\)/);
    // One stopped from outside (its processes gone, no report)
    stoppedTask(p, 'M1-02-ok', 2);
    await until(p, 'a round for the task stopped from outside', () => started(p) === 2 && ended(p) === 2);
    assert.equal(reasons(p)[1], 'task M1-02-ok was stopped from outside');
    await looks(p, 3);
    assert.equal(started(p), 2);
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
  // Several things at once (here while the hub is stopped): one round
  const q = project();
  const c2 = testClock(q, '2026-10-06T10:00:00Z');
  try {
    q.hub(['note', 'add', 'Use pnpm']);
    q.hub(['note', 'add', 'Keep the API small', '--rule']);
    q.hub(['handoff', 'reply', 'H1', 'Option 2']);
    bg = await hubUp(q, startHub(q, c2, { STUB_ORCH_PLAY: 'status' }));
    await until(q, 'one round for all of it', () => started(q) === 1 && ended(q) === 1);
    await looks(q, 3);
    assert.equal(started(q), 1, hubLog(q));
    assert.equal(reasons(q)[0], 'your new rule N2 (and 1 more of yours); your reply on H1');
  } finally {
    await stopHub(q, bg);
    q.cleanup();
  }
});

test('an orchestrator that tries to stay awake gets three rounds at most, then nothing until the owner acts (FR-019)', async () => {
  const p = project();
  const clock = testClock(p, '2026-10-04T15:20:00Z');
  let bg;
  let ui;
  try {
    // Each round it commits a STATUS.md note, posts on H1, queues a check job and asks for the shortest wake-up
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'awake', STUB_ORCH_CARD: 'H1' }));
    assert.match(p.hub(['note', 'add', 'Look at H1 again']).out, /Added N1/);
    await until(p, 'the note\'s round', () => ended(p) >= 1);
    // Hours pass, ten minutes at a time: its wake-ups come due, its checks end
    for (let i = 0; i < 18; i++) {
      clock.add(10);
      await looks(p, 1);
      if (started(p) > ended(p)) await until(p, 'the round to end', () => ended(p) === started(p));
    }
    assert.equal(started(p), 3, hubLog(p));
    // Each ask is taken in once: the one the brake let go isn't taken in again (and let go again) at every look
    assert.equal((hubLog(p).match(/autopilot: the orchestrator asked for a wake-up/g) || []).length, 3, hubLog(p));
    assert.equal(reasons(p)[0], 'your new note N1');
    for (const r of reasons(p).slice(1)) assert.match(r, /^(the check check-awake-\S+ ended \(passed\)|the wake-up it asked for: anything new\?)/);
    // Its commits went through (the hub doesn't refuse them), but none was real
    assert.equal((p.git('log', '--format=%s').match(/record autopilot cycle awaiting the owner/g) || []).length, 3);
    assert.match(statusJson(p, clock.env).autopilotNext, /^Three rounds found nothing to do, so only you or a task finishing will wake the team \(your reply on H1, a new note, or Run a round now\)$/);
    // Home: the sentence, and the day's rounds by what started them
    ui = await startUi(p, clock.env);
    const b = (await client(ui).get('/api/state')).json;
    assert.equal(b.autopilot.state, 'braked');
    assert.deepEqual(b.autopilot.runNow, true);
    const by = Object.fromEntries(b.usage.roundsBy.map((r) => [r.key, r.count]));
    assert.equal(by.owner, 1);
    assert.equal((by.job || 0) + (by.wake || 0), 2, JSON.stringify(b.usage.roundsBy));
    assert.ok(b.usage.roundsBy.every((r) => r.title && r.minutes >= 0));
    // The owner acts: a round
    assert.match(p.hub(['handoff', 'reply', 'H1', 'Wait for Monday']).out, /Replied/);
    await until(p, 'the reply\'s round', () => started(p) === 4);
    assert.equal(reasons(p)[3], 'your reply on H1');
  } finally {
    await stopUi(ui);
    await stopHub(p, bg);
    p.cleanup();
  }
});

// An ntfy server that keeps what it gets
async function fakeNtfy() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

test('six rounds in a row with nothing real trip the fuse: autopilot off, the phone told, a card on Home; nothing is lost (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  const ntfy = await fakeNtfy();
  let bg;
  let ui;
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status', NTFY_TOPIC: 'nextlevel-test-topic' }));
    // Task after task stopped from outside, and an orchestrator that does nothing about them
    for (let i = 1; i <= 6; i++) {
      stoppedTask(p, `M2-0${i}-ok`);
      await until(p, `round ${i} to end`, () => ended(p) === i);
    }
    assert.equal(started(p), 6);
    assert.equal(JSON.parse(fs.readFileSync(p.state('settings.json'), 'utf8')).autopilot, false, hubLog(p));
    assert.match(hubLog(p), /autopilot: the fuse: 6 rounds in a row started with nothing real happening between them/);
    await until(p, 'the phone message', () => ntfy.got.some((m) => /autopilot turned itself off/.test(m.title)));
    const m = ntfy.got.find((x) => /autopilot turned itself off/.test(x.title));
    assert.match(m.message, /6 rounds in a row started with nothing real happening between them .*turn autopilot on again \(Home, or START\.cmd -> 6\)/);
    // A seventh task stops: no round while autopilot is off
    stoppedTask(p, 'M2-07-ok');
    await until(p, 'M2-07 to be stopped', () => p.status('M2-07-ok').state === 'stopped');
    await looks(p, 3);
    assert.equal(started(p), 6);
    // Home: a card that says why, with the way back on
    ui = await startUi(p, clock.env);
    const api = client(ui);
    const b = (await api.get('/api/state')).json;
    assert.equal(b.autopilot.state, 'fuse');
    assert.match(b.autopilot.text, /^Off: it turned itself off at /);
    const card = b.needs.find((n) => n.kind === 'autopilot');
    assert.match(card.text, /^Autopilot turned itself off: 6 rounds in a row/);
    assert.deepEqual(card.action, { label: 'Turn on autopilot', post: '/api/autopilot', body: { on: true } });
    // Turned on again: the brake and the fuse start again, and what happened meanwhile gets its round
    assert.equal((await api.post('/api/autopilot', { on: true })).status, 200);
    await until(p, 'the round for M2-07', () => started(p) === 7);
    assert.equal(reasons(p)[6], 'task M2-07-ok was stopped from outside');
    assert.equal(JSON.parse(fs.readFileSync(p.state('settings.json'), 'utf8')).autopilot, true);
  } finally {
    await stopUi(ui);
    await stopHub(p, bg);
    await ntfy.close();
    p.cleanup();
  }
});

test('a reply mid-round, while autopilot is off or while the hub is stopped gets its round afterwards; nothing new starts none (FR-019)', async () => {
  const p = project();
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  const release = path.join(p.tmp, 'release');
  let bg;
  try {
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'hang', STUB_ORCH_RELEASE: release }));
    p.hub(['note', 'add', 'Plan M2']);
    await until(p, 'the round to start', () => started(p) === 1);
    // During the round: a reply and a note
    p.hub(['handoff', 'reply', 'H1', 'Yes']);
    p.hub(['note', 'add', 'And M3']);
    await looks(p, 2);
    assert.equal(started(p), 1, 'one round at a time');
    fs.writeFileSync(release, '');
    await until(p, 'one round after it', () => started(p) === 2 && ended(p) === 2);
    await looks(p, 3);
    assert.equal(started(p), 2);
    assert.match(reasons(p)[1], /your new note N2/);
    // Autopilot off: the owner replies; on again: its round
    assert.match(p.hub([], { input: '6\n0\n' }).out, /Autopilot is now off/);
    p.hub(['handoff', 'reply', 'H1', 'One more thing']);
    await looks(p, 3);
    assert.equal(started(p), 2);
    assert.match(p.hub([], { input: '6\n0\n' }).out, /Autopilot is now ON\. A round starts when something happens/);
    await until(p, 'the round for the reply made while autopilot was off', () => started(p) === 3 && ended(p) === 3);
    assert.equal(reasons(p)[2], 'your reply on H1');
    // The hub stopped: the owner replies; started again: its round
    await stopHub(p, bg);
    p.hub(['handoff', 'reply', 'H1', 'And another']);
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'hang', STUB_ORCH_RELEASE: release }));
    await until(p, 'the round for the reply made while the hub was stopped', () => started(p) === 4 && ended(p) === 4);
    // Nothing new: turning autopilot on, or starting the hub, starts none
    p.hub([], { input: '6\n0\n' });
    p.hub([], { input: '6\n0\n' });
    await looks(p, 3);
    await stopHub(p, bg);
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'hang', STUB_ORCH_RELEASE: release }));
    await looks(p, 3);
    assert.equal(started(p), 4, hubLog(p));
  } finally {
    fs.writeFileSync(release, '');
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('a round cut off gets one retry: a crash, and one stopped at its time limit (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  let bg;
  let other;
  try {
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'crash' }));
    p.hub(['note', 'add', 'Go']);
    await until(p, 'the round and its retry', () => started(p) === 2 && ended(p) === 2);
    await looks(p, 3);
    assert.equal(started(p), 2, 'one retry, not more');
    assert.match(hubLog(p), /autopilot: cycle ended \(exit 3, nothing real happened; cut off: its engine stopped with an error, so it gets one retry\)/);
    assert.equal(reasons(p)[1], 'the round before was cut off: its engine stopped with an error');
    // Its engine started, then failed: a round that ran (cut off), never one that didn't start
    const crashed = JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8'));
    assert.deepEqual([crashed.notStarted, crashed.last.how], [0, 'crash']);
    assert.equal(JSON.parse(fs.readFileSync(p.state('cycle.json'), 'utf8')).launched, true);
    await stopHub(p, bg);
    // One that runs past its 60 minutes: the hub stops it, and runs it once more. It stops the round's process it
    // started, never the pid cycle.json gives: the round's engine can write that file, here to name another program
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'hang' }));
    p.hub(['note', 'add', 'Again']);
    await until(p, 'the round to start', () => started(p) === 3);
    await until(p, 'its engine to start', () => readState(p, 'cycle.json')?.launched === true);
    other = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    writeOver(p.state('cycle.json'), { ...readState(p, 'cycle.json'), pid: other.pid });
    clock.add(61);
    await until(p, 'it to be stopped, and its retry to start', () => started(p) === 4 && /ran over 60 min; stopping it/.test(hubLog(p)));
    assert.equal(other.exitCode, null, 'the program cycle.json named still runs');
    process.kill(other.pid, 0);
    // (a round 60 minutes old has long started its engine: the clock moves on once the retry's has)
    const roundLogs = () => [...hubLog(p).matchAll(/orchestrator cycle started \(.*\) -> (.*)/g)].map((m) => m[1].trim());
    await until(p, "the retry's engine to start", () => {
      const c = readState(p, 'cycle.json');
      return roundLogs().length === 4 && c?.log === roundLogs()[3] && c.launched === true;
    });
    assert.equal(reasons(p)[3], 'the round before was cut off: it ran past its 60-minute limit');
    clock.add(61);
    await until(p, 'the retry to be stopped too', () => ended(p) === 4);
    await looks(p, 3);
    assert.equal(started(p), 4);
  } finally {
    other?.kill();
    await stopHub(p, bg);
    if (other) await processesGone([other.pid]);
    p.cleanup();
  }
});

test('a wake-up survives a restart and a clock change, fires on start if it came due meanwhile, and any round clears it (FR-019)', async () => {
  const p = project({ card: false });
  // 1:40 AM in New York on 1 November, 20 minutes before the clocks go back an hour
  const clock = testClock(p, '2026-11-01T05:40:00Z');
  const tz = { TZ: 'America/New_York' };
  let bg;
  try {
    bg = await hubUp(p, startHub(p, clock, { ...tz, STUB_ORCH_PLAY: 'wake:40' }));
    p.hub(['note', 'add', 'Push ci/m1 and read its CI run']);
    await until(p, 'the round that asks', () => ended(p) === 1);
    const wake = JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8')).wake;
    assert.deepEqual([wake.askedAt, wake.waits, wake.due], ['2026-11-01T05:40:00.000Z', 40, '2026-11-01T06:20:00.000Z']);
    await stopHub(p, bg);
    // 1:10 AM again, after the clocks went back: the wake-up keeps its time in UTC
    clock.set('2026-11-01T06:10:00Z');
    bg = await hubUp(p, startHub(p, clock, { ...tz, STUB_ORCH_PLAY: 'status' }));
    await looks(p, 3);
    assert.equal(started(p), 1);
    const next = statusJson(p, { ...clock.env, ...tz }).autopilotNext;
    assert.match(next, /^Next round at 1:20\sAM, because the last round asked: the CI run of ci\/m1 is still running\. Sooner: a new note or Run a round now$/);
    await stopHub(p, bg);
    // It came due while the hub was stopped: it fires as the hub starts
    clock.set('2026-11-01T06:30:00Z');
    bg = await hubUp(p, startHub(p, clock, { ...tz, STUB_ORCH_PLAY: 'wake:30' }));
    await until(p, 'the wake-up\'s round', () => started(p) === 2 && ended(p) === 2);
    assert.equal(reasons(p)[1], 'the wake-up it asked for: the CI run of ci/m1 is still running');
    // That round asked again; the owner's round clears it
    assert.ok(fs.existsSync(p.state('wakeup.json')));
    await stopHub(p, bg);
    bg = await hubUp(p, startHub(p, clock, { ...tz, STUB_ORCH_PLAY: 'status' }));
    p.hub(['note', 'add', 'Stop waiting for CI']);
    await until(p, 'the owner\'s round', () => started(p) === 3 && ended(p) === 3);
    // (the file is the command's alone, FR-019: the hub never writes or deletes it; an ask from before the last round
    // started is stale, and nothing takes it again)
    const st = JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8'));
    assert.equal(st.wake, null);
    const left = JSON.parse(fs.readFileSync(p.state('wakeup.json'), 'utf8'));
    assert.equal(st.wakeCleared, left.id, 'the ask left in the file is the one the owner\'s round cleared (same time, by the test clock)');
    clock.add(120);
    await looks(p, 3);
    assert.equal(started(p), 3, 'a stale ask starts nothing, however long it waits');
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('a round that moves work and asks for a wake-up gets no round right after it: the wake-up, asked as its last act, is its next round (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  let bg;
  try {
    // The round pushes main to ci-stub (new commits on origin: real), reads the push's result, and asks for a wake-up in
    // 25 minutes, the last thing before its process ends (the hub takes the ask in before it decides the round's end)
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'ci:25' }));
    p.hub(['note', 'add', 'Push ci-stub and wait for its CI run']);
    await until(p, 'the round to end', () => started(p) === 1 && ended(p) === 1);
    assert.match(hubLog(p), /autopilot: cycle ended \(exit 0, something real happened: \d+ commit\(s\) were pushed to ci-stub; it asked for a wake-up, its next round \(at /);
    const st = readState(p, 'rounds.json');
    assert.deepEqual([st.wake.waits, st.wake.due, st.pending.some((t) => t.type === 'next'), st.idle], [25, '2026-10-06T10:25:00.000Z', false, 0]);
    await looks(p, 3);
    assert.equal(started(p), 1, 'no round right after it');
    assert.deepEqual(readState(p, 'rounds.json').pending, [], "the push's end, which the round read, starts nothing");
    assert.match(statusJson(p, clock.env).autopilotNext, /^Next round at .*, because the last round asked: the CI run of ci-stub is still running\. Sooner: /);
    clock.add(26);
    await until(p, "the wake-up's round", () => started(p) === 2);
    assert.equal(reasons(p)[1], 'the wake-up it asked for: the CI run of ci-stub is still running');
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('a round that ended while the hub was stopped, after it moved work and asked for a wake-up: the hub that starts takes the ask in before it ends the round, so no round comes right after it (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:30:00Z');
  let bg;
  try {
    // The round (as the last hub left it): started at 10:00 for the owner's note, pushed at 10:10 (real.n 2, past the
    // round's realN 1), asked at 10:20 for a wake-up in 25 minutes, and ended at 10:21 while no hub ran
    const log = path.join('.nextlevel', 'logs', 'orchestrator-20261006-100000.log');
    writeOver(p.state('rounds.json'), {
      version: 1,
      pending: [],
      sinceReal: 0,
      streak: 1,
      realAtStart: 1,
      last: null,
      wake: null,
      idle: 0,
      starts: ['2026-10-06T10:00:00.000Z'],
      owner: { notes: 0, handoff: 0 },
      real: { n: 2, at: '2026-10-06T10:10:00.000Z', what: '3 commit(s) were pushed to ci-stub' },
      round: { startedAt: '2026-10-06T10:00:00.000Z', reasons: [{ type: 'owner', what: 'your new note N1', at: '2026-10-06T10:00:00.000Z' }], type: 'owner', what: 'your new note N1', realN: 1, retried: false, log, engine: 'codex' },
    });
    writeOver(p.state('cycle.json'), { pid: 999999, startedAt: '2026-10-06T10:00:00.000Z', log, launched: true, endedAt: '2026-10-06T10:21:00.000Z', exitCode: 0 });
    writeOver(p.state('wakeup.json'), { id: '0123456789ab', askedAt: '2026-10-06T10:20:00.000Z', minutes: 25, reason: 'the CI run of ci-stub is still running', by: 'an autopilot round' });
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await until(p, 'the round to be ended', () => ended(p) === 1);
    assert.match(hubLog(p), /autopilot: cycle ended \(exit 0, something real happened: 3 commit\(s\) were pushed to ci-stub; it asked for a wake-up, its next round \(at /);
    await looks(p, 3);
    assert.equal(started(p), 0, 'no round right after it');
    assert.equal(readState(p, 'rounds.json').wake.due, '2026-10-06T10:45:00.000Z');
    clock.add(16);
    await until(p, "the wake-up's round", () => started(p) === 1);
    assert.equal(reasons(p)[0], 'the wake-up it asked for: the CI run of ci-stub is still running');
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test("a wakeup.json whose fields aren't text (an agent wrote it) is no ask: the hub starts, ends the round it found, and goes on (FR-019)", async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:30:00Z');
  let bg;
  try {
    const log = path.join('.nextlevel', 'logs', 'orchestrator-20261006-100000.log');
    writeOver(p.state('rounds.json'), {
      version: 1,
      pending: [],
      sinceReal: 0,
      streak: 1,
      realAtStart: 1,
      idle: 0,
      starts: ['2026-10-06T10:00:00.000Z'],
      owner: { notes: 0, handoff: 0 },
      real: { n: 2, at: '2026-10-06T10:10:00.000Z', what: '3 commit(s) were pushed to ci-stub' },
      round: { startedAt: '2026-10-06T10:00:00.000Z', reasons: [{ type: 'owner', what: 'your new note N1', at: '2026-10-06T10:00:00.000Z' }], type: 'owner', what: 'your new note N1', realN: 1, retried: false, log, engine: 'codex' },
    });
    writeOver(p.state('cycle.json'), { pid: 999999, startedAt: '2026-10-06T10:00:00.000Z', log, launched: true, endedAt: '2026-10-06T10:21:00.000Z', exitCode: 0 });
    // (objects whose toString isn't a function: making one a string throws)
    fs.writeFileSync(p.state('wakeup.json'), '{"id":{"toString":0},"askedAt":{"toString":0},"minutes":{"toString":0},"reason":{"toString":0},"by":{"toString":0}}');
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await until(p, 'the round it found to end, and the one right after it to run', () => ended(p) === 2);
    assert.match(hubLog(p), /autopilot: cycle ended \(exit 0, something real happened: 3 commit\(s\) were pushed to ci-stub\)/);
    assert.equal(reasons(p)[0], 'right after a round in which 3 commit(s) were pushed to ci-stub');
    assert.equal(bg.exitCode, null, 'the hub runs');
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

// A round the last hub left running (rounds.json and cycle.json as it wrote them), its process named by pid
function leftRound(p, { pid, startedAt, startedReal, at = '2026-10-06T10:00:00.000Z' }) {
  const log = path.join('.nextlevel', 'logs', 'orchestrator-20261006-100000.log');
  writeOver(p.state('rounds.json'), {
    version: 1,
    pending: [],
    sinceReal: 1,
    streak: 1,
    realAtStart: 1,
    idle: 0,
    starts: [at],
    owner: { notes: 0, handoff: 0 },
    real: { n: 1, at, what: 'your new note N1' },
    round: { startedAt: at, reasons: [{ type: 'owner', what: 'your new note N1', at }], type: 'owner', what: 'your new note N1', realN: 1, retried: false, log, engine: 'codex', startedReal },
  });
  writeOver(p.state('cycle.json'), { pid, startedAt, log, launched: true });
}
const program = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });

test('a round the last hub left whose pid another program has now (it started later, as after a restart of the PC) ends at once as cut off and gets its retry; that program is never touched (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:20:00Z');
  const other = program();
  let bg;
  try {
    // The round's process said it started 10 minutes ago; the program with its pid now started just now
    const ago = Date.now() - 10 * 60_000;
    leftRound(p, { pid: other.pid, startedAt: new Date(ago).toISOString(), startedReal: ago });
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await until(p, 'the round to end, and its retry to run', () => ended(p) === 2);
    assert.match(hubLog(p), /autopilot: cycle ended \(exit -1, nothing real happened; cut off: its process was stopped from outside, so it gets one retry\)/);
    assert.equal(reasons(p)[0], 'the round before was cut off: its process was stopped from outside');
    assert.equal(other.exitCode, null, 'the program with that pid still runs');
    process.kill(other.pid, 0);
  } finally {
    other.kill();
    await stopHub(p, bg);
    await processesGone([other.pid]);
    p.cleanup();
  }
});

test("a round the last hub left whose start can't be read is followed, and counts as ended once it is 70 minutes old (its own limit and 5 more); one whose pid and start say it runs is never ended (FR-019)", async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:20:00Z');
  const same = program();
  let bg;
  try {
    // Its pid and start say it still runs (the program started before the round's process said it did, after the round
    // started): followed, never ended, past its time limit too
    const begun = Date.now() - 60_000;
    leftRound(p, { pid: same.pid, startedAt: new Date(Date.now() + 60_000).toISOString(), startedReal: begun - 60_000 });
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await until(p, 'the hub to follow it', () => /a round the last hub started still runs \(pid \d+\): following it/.test(hubLog(p)));
    clock.add(80);
    await looks(p, 3);
    assert.equal(ended(p), 0, 'its pid and start time say it runs: it ends itself at its own limit');
    assert.match(statusJson(p, clock.env).autopilotNext, /^A round is running/);
    await stopHub(p, bg);
    // Its start can't be read (under the tests' stubs): followed until it is 70 minutes old, then it ends as cut off
    leftRound(p, { pid: same.pid, startedAt: new Date().toISOString(), startedReal: Date.now() - 60_000, at: '2026-10-06T11:40:00.000Z' });
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status', NEXTLEVEL_TEST_PROCESS_START: 'unknown' }));
    await until(p, 'the hub to follow it', () => /its start can't be read, so it counts as ended once it is 70 min old\): following it/.test(hubLog(p)));
    clock.add(69);
    await looks(p, 3);
    assert.equal(ended(p), 0, 'not yet 70 minutes old');
    clock.add(2);
    await until(p, 'the round to end, and its retry to run', () => ended(p) === 2);
    assert.equal(reasons(p)[0], 'the round before was cut off: it ran past its 60-minute limit');
    assert.equal(same.exitCode, null, 'never killed');
  } finally {
    same.kill();
    await stopHub(p, bg);
    await processesGone([same.pid]);
    p.cleanup();
  }
});

test("a round's own jobs start no round after it: a check it saw finish with nextlevel wait only; a merge it made, when it asked for a wake-up the wake-up is its next round (FR-019)", async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  let bg;
  try {
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'check-wait' }));
    p.hub(['note', 'add', 'Run the checks']);
    await until(p, 'the round to end', () => started(p) === 1 && ended(p) === 1);
    await looks(p, 3);
    assert.equal(started(p), 1, 'the check it waited for starts no round');
    const check = fs.readdirSync(p.state('jobs')).find((d) => d.startsWith('check-own-'));
    const st = JSON.parse(fs.readFileSync(p.state('jobs', check, 'status.json'), 'utf8'));
    assert.deepEqual([st.state, !!st.acked, fs.existsSync(p.state('jobs', check, 'seen-in-round.json'))], ['passed', false, true], 'seen by its round, not reviewed');
    await stopHub(p, bg);
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'merge-wake:25' }));
    p.hub(['note', 'add', 'Merge T9']);
    await until(p, 'the round to end', () => started(p) === 2 && ended(p) === 2);
    assert.match(hubLog(p), /autopilot: cycle ended \(exit 0, something real happened: task T9 was merged into main; it asked for a wake-up, its next round \(at /);
    await looks(p, 3);
    assert.equal(started(p), 2, 'neither its merge nor work moving starts a round: the wake-up is its next one');
    clock.add(26);
    await until(p, "the wake-up's round", () => started(p) === 3);
    assert.equal(reasons(p)[2], 'the wake-up it asked for: the CI run of main is still running');
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('the hourly ceiling holds when rounds.json is rewritten: the hub keeps the hour\'s starts in its memory too (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  let bg;
  try {
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    for (let i = 1; i <= 8; i++) {
      p.hub(['note', 'add', `Note ${i}`]);
      await until(p, `round ${i}`, () => started(p) === i && ended(p) === i);
    }
    // An agent rewrites rounds.json without the hour's starts; the owner adds a ninth note: it waits for the hour
    writeOver(p.state('rounds.json'), { ...readState(p, 'rounds.json'), starts: [] });
    p.hub(['note', 'add', 'Note 9']);
    await looks(p, 3);
    assert.equal(started(p), 8);
    assert.match(statusJson(p, clock.env).autopilotNext, /^On, but waiting: 8 rounds in the last hour is the most it runs; the next starts at /);
    clock.add(61);
    await until(p, 'the ninth, once the hour has passed', () => started(p) === 9);
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test("cycle.json's and rounds.json's fields that aren't text (an agent wrote them) stop nothing: the hub starts and goes on; a rounds.json not as the hub writes it starts again as on a first run, said once, the owner's old actions seen (FR-019)", async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:20:00Z');
  const notText = { toString: 0 }; // (making it a string throws)
  let bg;
  try {
    // A round the last hub left, ended; its cycle.json's log an object that throws when made a string
    const ago = Date.now() - 10 * 60_000;
    leftRound(p, { pid: 999999, startedAt: new Date(ago).toISOString(), startedReal: ago });
    writeOver(p.state('cycle.json'), { ...readState(p, 'cycle.json'), log: notText, endedAt: new Date().toISOString(), exitCode: 0 });
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await until(p, 'the round it found to end', () => ended(p) === 1);
    p.hub(['note', 'add', 'Go on']);
    await until(p, "the note's round", () => started(p) === 1 && ended(p) === 2);
    await stopHub(p, bg);
    // rounds.json with round.log and round.what as such objects: a fresh state, said once; the notes so far are seen
    leftRound(p, { pid: 999999, startedAt: new Date(ago).toISOString(), startedReal: ago });
    const st = readState(p, 'rounds.json');
    writeOver(p.state('rounds.json'), { ...st, round: { ...st.round, log: notText, what: notText } });
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await looks(p, 3);
    assert.equal((hubLog(p).match(/autopilot: rounds\.json isn't as the hub writes it \(its "round"\), so it starts again from what is there now, as on its first run: the owner's actions so far count as seen/g) || []).length, 1, hubLog(p));
    assert.equal(started(p), 1, "the owner's old notes start no round");
    assert.equal(readState(p, 'rounds.json').round, null, 'the hub wrote the fresh state');
    p.hub(['note', 'add', 'And again']);
    await until(p, "the new note's round", () => started(p) === 2 && ended(p) === 3);
    assert.equal(bg.exitCode, null, 'the hub runs');
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('only the orchestrator asks for a wake-up; the owner\'s side of the cards refuses in an agent\'s session (FR-019)', () => {
  const p = project();
  try {
    const clock = testClock(p, '2026-10-06T10:00:00Z');
    const ask = (env, ...args) => p.hub(['wakeup', ...(args.length ? args : ['10', '--reason', 'the CI run is still running'])], { extraEnv: { ...clock.env, ...env } });
    for (const [env, who] of [
      [{ NEXTLEVEL_AGENT: 'worker', NEXTLEVEL_TASK_ID: 'M1-01' }, "this is a worker's slot"],
      [{ NEXTLEVEL_AGENT: 'check' }, 'this is a verify command the orchestrator asked for'],
      [{}, "this is the owner's own window: Home's Run a round now starts a round"],
    ]) {
      const r = ask(env);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /nextlevel wakeup is the orchestrator's \(an autopilot round or its window\) and refuses anywhere else/);
      assert.ok(r.out.includes(who), r.out);
    }
    assert.equal(ask({ NEXTLEVEL_READ_ONLY: '1', NEXTLEVEL_AGENT: 'orchestrator' }).code, 1, "the assistant's read-only session");
    assert.ok(!fs.existsSync(p.state('wakeup.json')), 'none of those asked');
    const orch = { NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'autopilot' };
    for (const bad of [['0', '--reason', 'x'], ['soon', '--reason', 'x'], ['2000', '--reason', 'x'], ['1e3', '--reason', 'x'], ['0x10', '--reason', 'x'], ['.', '--reason', 'x'], ['5', '--reason', 'x'.repeat(301)]]) assert.equal(ask(orch, ...bad).code, 1, bad.join(' '));
    assert.ok(!fs.existsSync(p.state('wakeup.json')));
    assert.equal(ask(orch, '7.5', '--reason', 'a build').code, 0, 'minutes with a dot are fine');
    assert.match(ask(orch, '5').out, /say why/);
    const ok = ask(orch);
    assert.equal(ok.code, 0, ok.out);
    assert.match(ok.out, /Asked for a round in 10 min or later, because: the CI run is still running/);
    const asked = JSON.parse(fs.readFileSync(p.state('wakeup.json'), 'utf8'));
    assert.match(asked.id, /^[0-9a-f]{12}$/);
    assert.deepEqual({ ...asked, id: '' }, { id: '', askedAt: '2026-10-06T10:00:00.000Z', minutes: 10, reason: 'the CI run is still running', by: 'an autopilot round' });
    // The owner's side of the cards is what wakes the team: in an agent's session it is refused
    for (const args of [['note', 'add', 'keep going'], ['handoff', 'reply', 'H1', 'yes'], ['handoff', 'done', 'H1']]) {
      const r = p.hub(args, { extraEnv: orch });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /is the owner's, so it doesn't run in an agent's session \(this is an autopilot round\): nothing was done/);
    }
    assert.match(p.hub(['note', 'add', 'keep going']).out, /Added N1/, "the owner's own window");
  } finally {
    p.cleanup();
  }
});

test('rounds whose engine never starts: what started them waits, the hour counts them, and two in a row turn autopilot off, saying why (FR-019)', async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  const ntfy = await fakeNtfy();
  let bg;
  let ui;
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    // (under the tests' stubs only: the round's process ends with exit 42 before it starts its engine)
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status', NEXTLEVEL_TEST_ROUND_EXIT: '42', NTFY_TOPIC: 'nextlevel-test-topic' }));
    p.hub(['note', 'add', 'Plan M2']);
    await until(p, 'autopilot to turn itself off', () => JSON.parse(fs.readFileSync(p.state('settings.json'), 'utf8')).autopilot === false);
    // (the setting is written before the hub logs why: wait for the line too)
    await until(p, 'the hub to say why autopilot turned itself off', () => /autopilot: rounds that never started:/.test(hubLog(p)));
    const log = hubLog(p);
    assert.equal((log.match(/autopilot: the round didn't start, so the next one may start at once \(what started it waits again\): its process ended with exit 42 before it started Codex/g) || []).length, 2, log);
    assert.match(log, /autopilot: rounds that never started: Two autopilot rounds in a row didn't start: the orchestrator's engine was never started, the last time because its process ended with exit 42 before it started Codex\. Nothing ran, so nothing is lost/);
    const st = JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8'));
    // the hour counts both; the brake and the fuse neither; what started them waits
    assert.deepEqual([st.notStarted, st.starts.length, st.sinceReal, st.streak, st.pending.map((t) => t.what), st.fuse.kind], [2, 2, 0, 0, ['your new note N1'], 'not-started']);
    assert.ok(!(JSON.parse(fs.readFileSync(p.state('cycle.json'), 'utf8')).launched), 'its engine never ran');
    await until(p, 'the phone message', () => ntfy.got.some((m) => /autopilot turned itself off/.test(m.title)));
    assert.match(ntfy.got.find((m) => /autopilot turned itself off/.test(m.title)).message, /didn't start: .*exit 42 before it started Codex.*turn autopilot on again \(Home, or START\.cmd -> 6\)/);
    // Home: the card says what failed, with the way back on
    ui = await startUi(p, clock.env);
    const api = client(ui);
    const b = (await api.get('/api/state')).json;
    assert.equal(b.autopilot.state, 'fuse');
    const card = b.needs.find((n) => n.kind === 'autopilot');
    assert.match(card.text, /^Autopilot turned itself off: Two autopilot rounds in a row didn't start: .*exit 42/);
    assert.deepEqual(card.action, { label: 'Turn on autopilot', post: '/api/autopilot', body: { on: true } });
    // Fixed (the hook gone), turned on: the note's round runs, its engine starts, and the count starts again
    await stopHub(p, bg);
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    assert.equal((await api.post('/api/autopilot', { on: true })).status, 200);
    await until(p, 'the note\'s round to run', () => ended(p) === 3);
    // The usage ledger has every round, the two that never started too, as usage.json counts them (at their start)
    const ledger = readLedger(p.state()).records.filter((r) => r.role === 'autopilot');
    assert.deepEqual(ledger.map((r) => [r.end || '', r.runs, r.tokens === null ? null : 'tokens', r.at.slice(0, 10)]).slice(0, 2), [['not-started', 1, null, '2026-10-06'], ['not-started', 1, null, '2026-10-06']]);
    assert.equal(ledger.length, Object.values(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8'))).reduce((t, d) => t + (d.rounds || 0), 0));
    const after = JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8'));
    assert.deepEqual([after.notStarted, after.last.how, after.starts.length], [0, 'ok', 3]);
    assert.equal(JSON.parse(fs.readFileSync(p.state('cycle.json'), 'utf8')).launched, true);
    // Run a round now: a count the dashboard keeps, which the hub only reads
    const press = await api.post('/api/round', {});
    assert.match(press.json.message, /A round starts within a minute/);
    await until(p, 'the round it asked for', () => started(p) === 4 && ended(p) === 4);
    assert.equal(reasons(p)[3], 'you pressed Run a round now');
    assert.equal(JSON.parse(fs.readFileSync(p.state('round-now.json'), 'utf8')).n, 1, 'the hub left the count as it was');
    await looks(p, 3);
    assert.equal(started(p), 4, 'pressed once: one round');
    // A count set out of range in the file (an agent can write it, and that is taken as a press: KNOWN_ISSUES) doesn't
    // stop the button: it reads as 0, and the owner's next press is one round more
    writeOver(p.state('round-now.json'), { n: 1e308 });
    await until(p, 'the round for the changed count', () => started(p) === 5 && ended(p) === 5);
    assert.equal((await api.post('/api/round', {})).status, 200);
    assert.equal(readState(p, 'round-now.json').n, 1);
    await until(p, "the owner's press", () => started(p) === 6 && ended(p) === 6);
    assert.equal(reasons(p)[5], 'you pressed Run a round now');
  } finally {
    await stopUi(ui);
    await stopHub(p, bg);
    await ntfy.close();
    p.cleanup();
  }
});

test("a round's process that ends before it writes cycle.json is known at once, with its exit code, not after 45 s (FR-019)", async () => {
  const p = project({ card: false });
  const clock = testClock(p, '2026-10-06T10:00:00Z');
  let bg;
  try {
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status', NEXTLEVEL_TEST_ROUND_EXIT: 'early:43' }));
    p.hub(['note', 'add', 'Plan M3']);
    await until(p, 'autopilot to turn itself off', () => readState(p, 'settings.json')?.autopilot === false, 40_000);
    const log = hubLog(p);
    assert.equal((log.match(/autopilot: the round didn't start, so the next one may start at once \(what started it waits again\): its process ended with exit 43 before it started Codex/g) || []).length, 2, log);
    assert.doesNotMatch(log, /no sign of its process/);
    assert.equal(readState(p, 'cycle.json'), null, 'it never wrote cycle.json');
    assert.equal(readState(p, 'rounds.json').fuse.kind, 'not-started');
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

// Processes at once, as the hub, the dashboard, the menu and an orchestrator's window may be
function runAll(scripts) {
  return Promise.all(
    scripts.map(
      (code) =>
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (out += d));
          child.on('close', (c) => (c === 0 ? resolve(out) : reject(new Error(`exit ${c}: ${out}`))));
        }),
    ),
  );
}

test("writers at once lose nothing: four on settings.json under its lock (the one usage.json, the Run-a-round-now count and the cards use too: its holder told by pid and start time, one kept over 12 s taken over and said, a change whose lock was taken over made again); the owner's actions counted (FR-019)", async () => {
  const p = project({ card: false });
  try {
    const lock = pathToFileURL(path.join(REPO, 'src', 'lib', 'filelock.mjs')).href;
    const file = p.state('settings.json');
    fs.writeFileSync(file, JSON.stringify({ autopilot: false }));
    // The hub writes one setting after another while the owner turns autopilot on and off, and the menu and an
    // orchestrator's window write theirs: every write of each stays (four at once: on Windows a writer then meets another's
    // lock folder while it is being deleted, EPERM, which must mean "wait", never a failed write)
    const writer = (key, n, extra = '') => `
      import { updateJsonFile } from ${JSON.stringify(lock)};
      for (let i = 1; i <= ${n}; i++) updateJsonFile(${JSON.stringify(file)}, (s) => ({ ...s, ${JSON.stringify(key)}: (s[${JSON.stringify(key)}] || 0) + 1${extra} }));`;
    await runAll([writer('hubWrites', 300), writer('ownerWrites', 300, ', autopilot: i % 2 === 1, onAt: "at-" + i'), writer('menuWrites', 300), writer('windowWrites', 300)]);
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual([s.hubWrites, s.ownerWrites, s.menuWrites, s.windowWrites, s.autopilot, s.onAt], [300, 300, 300, 300, false, 'at-300']);
    assert.ok(!fs.existsSync(`${file}.lock`), 'the lock is let go');
    const { updateJsonFile, withFileLock } = await import(lock);
    const lockDir = `${file}.lock`;
    // A lock as a holder left it: its pid, its token, the time it took the lock (the holder file's)
    const holder = (pid, token, at = new Date()) => {
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(path.join(lockDir, 'holder'), JSON.stringify({ pid, token }));
      fs.utimesSync(path.join(lockDir, 'holder'), at, at);
    };
    const gonePid = () => Number(spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true }).stdout);
    const events = [];
    const onLock = (e) => events.push(e);
    const took = (since) => Date.now() - since;
    // A holder whose pid runs no more is gone: its lock is taken over at once, and said
    holder(gonePid(), 'dead');
    let t0 = Date.now();
    updateJsonFile(file, (x) => ({ ...x, afterDead: true }), {}, { onLock });
    assert.ok(took(t0) < 3_000, `taken over at once (${took(t0)} ms)`);
    assert.match(events.at(-1).why, /^its holder \(pid \d+\) has ended$/);
    assert.ok(!fs.existsSync(lockDir), 'let go after the write');
    const later = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
    try {
      // A pid another program has now (it started after the lock was taken) is no holder: told by its start time
      holder(later.pid, 'reused', new Date(Date.now() - 60_000));
      t0 = Date.now();
      updateJsonFile(file, (x) => ({ ...x, afterReused: true }), {}, { onLock });
      assert.ok(took(t0) < 10_000, `taken over once its start was read (${took(t0)} ms)`);
      assert.match(events.at(-1).why, /^pid \d+ is another program's now \(it started after the lock was taken\)$/);
    } finally {
      later.kill();
      await processesGone([later.pid]);
    }
    // A holder that runs, was there when it took the lock, and writes a new token every half second (an agent can): the
    // writer waits 12 s on its own clock, whatever the holder file says, then takes the lock over and says so. The write
    // is made, never skipped
    const keeper = spawn(process.execPath, ['-e', `const fs = require("fs"); fs.mkdirSync(${JSON.stringify(lockDir)}, { recursive: true }); const put = () => { try { fs.writeFileSync(${JSON.stringify(path.join(lockDir, "holder"))}, JSON.stringify({ pid: process.pid, token: String(Math.random()) })); } catch {} }; put(); setInterval(put, 500); setTimeout(() => process.exit(0), 30000);`], { stdio: 'ignore', windowsHide: true });
    try {
      await waitUntil('the keeper to hold the lock', () => fs.existsSync(path.join(lockDir, 'holder')), 10_000);
      t0 = Date.now();
      updateJsonFile(file, (x) => ({ ...x, afterHeld: true }), {}, { onLock });
      assert.ok(took(t0) >= 11_000 && took(t0) < 15_000, `waited 12 s, then took it over (${took(t0)} ms)`);
      assert.match(events.at(-1).why, /^it was held over 12 s \(by pid \d+ last\)$/);
    } finally {
      keeper.kill();
      await processesGone([keeper.pid]);
    }
    fs.rmSync(lockDir, { recursive: true, force: true });
    // A folder without a holder, its time set in 2100: taken over 2 s after the writer first saw it so, never "not yet"
    fs.mkdirSync(lockDir);
    fs.utimesSync(lockDir, new Date('2100-01-01'), new Date('2100-01-01'));
    t0 = Date.now();
    updateJsonFile(file, (x) => ({ ...x, afterEmpty: true }), {}, { onLock });
    assert.ok(took(t0) < 6_000, `taken over after 2 s (${took(t0)} ms)`);
    assert.match(events.at(-1).why, /^its folder has no holder in it/);
    // What has the lock's name and is no folder (a file here; a link the same): taken over at once
    fs.writeFileSync(lockDir, 'not a lock');
    t0 = Date.now();
    updateJsonFile(file, (x) => ({ ...x, afterFile: true }), {}, { onLock });
    assert.ok(took(t0) < 3_000, `taken over at once (${took(t0)} ms)`);
    assert.match(events.at(-1).why, /^what has its name is no folder/);
    // A lock that can't be moved aside (on Windows a process working in its folder keeps it there): after 15 s the
    // writer writes without it and says so, rather than hang (elsewhere the folder moves, and it is taken over at 12 s)
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'holder'), JSON.stringify({ pid: process.pid, token: 'stuck' }));
    const inside = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { cwd: lockDir, stdio: 'ignore', windowsHide: true });
    try {
      t0 = Date.now();
      updateJsonFile(file, (x) => ({ ...x, afterStuck: true }), {}, { onLock });
      if (process.platform === 'win32') {
        assert.ok(took(t0) >= 14_000 && took(t0) < 20_000, `gave up after 15 s (${took(t0)} ms)`);
        assert.ok(events.some((e) => e.forced && /couldn't be taken or moved aside in 15 s .*: written without it$/.test(e.why)), JSON.stringify(events.slice(-2)));
      } else assert.match(events.at(-1).why, /^it was held over 12 s/);
    } finally {
      inside.kill();
      await processesGone([inside.pid]);
    }
    // (Windows lets the folder go once this process has taken in the child's end: wait for it without blocking)
    if (inside.exitCode === null && inside.signalCode === null) await new Promise((r) => inside.once('exit', r));
    await waitUntil('the lock folder to be free', () => {
      try {
        fs.rmSync(lockDir, { recursive: true, force: true });
        return true;
      } catch {
        return false;
      }
    }, 20_000);
    // A writer whose lock was taken over before it wrote makes its change again on the file as it is then: neither
    // change is lost (here the other writer wrote, and died holding the lock)
    let first = true;
    updateJsonFile(
      file,
      (x) => {
        if (first) {
          first = false;
          fs.writeFileSync(path.join(lockDir, 'holder'), JSON.stringify({ pid: gonePid(), token: 'other' }));
          fs.writeFileSync(file, JSON.stringify({ ...x, other: true }));
        }
        return { ...x, mine: true };
      },
      {},
      { onLock },
    );
    assert.ok(events.some((e) => e.lost && !e.forced), JSON.stringify(events));
    // A writer removes only the lock that holds its token
    withFileLock(file, () => fs.writeFileSync(path.join(lockDir, 'holder'), JSON.stringify({ pid: process.pid, token: 'another' })));
    assert.match(fs.readFileSync(path.join(lockDir, 'holder'), 'utf8'), /"another"/, "another's lock stays");
    fs.rmSync(lockDir, { recursive: true });
    const now = readState(p, 'settings.json');
    assert.deepEqual([now.afterDead, now.afterReused, now.afterHeld, now.afterEmpty, now.afterFile, now.afterStuck, now.other, now.mine, now.hubWrites], [true, true, true, true, true, true, true, true, 300]);
    assert.deepEqual(fs.readdirSync(p.state()).filter((n) => n.endsWith('.tmp') || n.includes('.lock')), [], 'no temporary file or lock is left');
    // The owner's actions on the cards: two processes at once, every one counted (lib/cards.mjs, the same lock)
    const cards = pathToFileURL(path.join(REPO, 'src', 'lib', 'cards.mjs')).href;
    const owner = (who) => `
      import { cardStore } from ${JSON.stringify(cards)};
      const store = cardStore({ root: ${JSON.stringify(p.repo)}, stateDir: ${JSON.stringify(p.state())}, files: { notes: 'docs/OWNER_NOTES.md', handoff: 'docs/HANDOFF.md' } });
      for (let i = 0; i < 20; i++) store.notes.add({ text: ${JSON.stringify(who)} + ' ' + i });`;
    await runAll([owner('from the dashboard'), owner('from the owner\'s window')]);
    const { cardStore } = await import(cards);
    const store = cardStore({ root: p.repo, stateDir: p.state(), files: { notes: 'docs/OWNER_NOTES.md', handoff: 'docs/HANDOFF.md' } });
    assert.deepEqual([store.notes.list().length, store.ownerActs().notes.n], [40, 40]);
  } finally {
    p.cleanup();
  }
});

test("undo Done: a Done on the dashboard starts a round only once its Undo time is over; an undone one starts none and changes nothing; one made just before the hub stopped is final after it starts again; a reopen starts one", async () => {
  const p = project();
  const clock = testClock(p, Date.now());
  let bg;
  let ui;
  try {
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await looks(p, 2);
    ui = await startUi(p, clock.env);
    const api = client(ui);
    const md = fs.readFileSync(path.join(p.repo, 'docs/HANDOFF.md'), 'utf8');
    const head = p.git('rev-parse', 'HEAD');
    // Done, then Undo inside the 10 seconds: no round, no change, no commit
    assert.equal((await api.post('/api/handoff', { action: 'done', id: 'H1', reply: 'Resume it' })).status, 200);
    await looks(p, 3);
    clock.addSeconds(5);
    await looks(p, 2);
    assert.equal(started(p), 0, hubLog(p));
    assert.equal((await api.post('/api/handoff', { action: 'undo', id: 'H1' })).status, 200);
    clock.addSeconds(30);
    await looks(p, 3);
    assert.equal(started(p), 0, hubLog(p));
    assert.equal(fs.readFileSync(path.join(p.repo, 'docs/HANDOFF.md'), 'utf8'), md, 'docs/HANDOFF.md as it was');
    assert.equal(p.git('rev-parse', 'HEAD'), head);
    assert.match(p.hub(['handoff', 'list']).out, /H1 {4}open/, "the orchestrator's list has it open");
    // Done, and the hub stops before its time is over (no dashboard either): it is final once the hub runs again
    assert.equal((await api.post('/api/handoff', { action: 'done', id: 'H1', reply: 'Resume it' })).status, 200);
    await stopUi(ui);
    ui = null;
    await stopHub(p, bg);
    clock.addSeconds(11);
    bg = await hubUp(p, startHub(p, clock, { STUB_ORCH_PLAY: 'status' }));
    await until(p, 'a round for the Done, and its end', () => started(p) === 1 && ended(p) === 1);
    assert.deepEqual(reasons(p), ['your reply on H1, marked done']);
    assert.match(fs.readFileSync(path.join(p.repo, 'docs/HANDOFF.md'), 'utf8'), /- \[x\] \*\*H1\*\*/);
    // Reopened from the terminal: one more round, which reads it as reopened
    clock.addSeconds(60);
    assert.match(p.hub(['handoff', 'reopen', 'H1']).out, /H1 is open again/);
    await until(p, 'a round for the reopen', () => started(p) === 2 && ended(p) === 2);
    assert.deepEqual(reasons(p).at(-1), 'you reopened H1');
    assert.match(p.hub(['handoff', 'list']).out, /reopened by the owner from the terminal .*after it was done by the owner/);
  } finally {
    await stopUi(ui);
    await stopHub(p, bg);
    p.cleanup();
  }
});
