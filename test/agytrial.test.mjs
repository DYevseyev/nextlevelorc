// FR-022: after agy updated itself to 1.3.4 on a real project, the model check failed with nothing but "ERROR", and nothing kept
// tasks from starting on the broken agy. With the stub agy (test/stubs/fake-agy.mjs, STUB_AGY_VERSION and the like):
// the model check's trial runs what a worker runs; a failure says why in agy's words, redacted; tasks on agy wait for a
// passing trial while other engines' run, with a card, one phone message and a way to move them; the hub tries again on
// Check again, when agy's version changes, and once an hour (the test clock, lib/clock.mjs).
//   node --test test/agytrial.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { hubRounds, makeProject, processesGone, waitUntil } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const PLANTED = 'planted-dotenv-value-1234';
const GOOGLE_KEY = `AIza${'Sy'.padEnd(35, 'q')}`;
const IS_WIN = process.platform === 'win32';

// A task spec on an engine of its own
function spec(p, id, engine = 'agy') {
  fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', `${id}.md`), `# ${id} — test\n\nKind: code\nEngine: ${engine}\n\n## Goal\nTest.\n\n## Verify\n\`\`\`sh\nnode -e "process.exit(require('fs').existsSync('ok.mjs')?0:1)"\n\`\`\`\n`);
}
const seen = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const probes = (file) => seen(file).filter((s) => s.prompt !== 'worker');
const hubLog = (p) => (fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '');
const until = (p, what, check, ms = 90_000) =>
  waitUntil(what, check, ms).catch((err) => {
    throw new Error(`${err.message}\n${hubLog(p)}`);
  });
const status = (p, id) => {
  try {
    return p.status(id);
  } catch {
    return {};
  }
};
// agy updated itself: its version, and its program file replaced (the hub asks its version again when the file changes)
function setVersion(p, file, version) {
  fs.writeFileSync(file, version);
  const stub = path.join(p.bin, IS_WIN ? 'agy.cmd' : 'agy');
  fs.appendFileSync(stub, IS_WIN ? `REM ${version}\r\n` : `# ${version}\n`);
}
// The test's clock (lib/clock.mjs)
function testClock(p, at) {
  const file = path.join(p.tmp, 'clock.json');
  const clock = {
    env: { NEXTLEVEL_TEST_CLOCK: file },
    now: 0,
    set(t) {
      clock.now = t;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: new Date(t).toISOString() }));
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, file);
          return;
        } catch (err) {
          if (i > 50) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    },
    add: (min) => clock.set(clock.now + min * 60_000),
  };
  clock.set(Date.parse(at));
  return clock;
}
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
async function stopHub(p, bg) {
  if (!bg || bg.exitCode !== null) return;
  fs.writeFileSync(p.state('hub-stop.json'), '{}');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      bg.kill();
      resolve();
    }, 20_000);
    bg.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  await processesGone([bg.pid]);
}

test("the model check's trial runs what a worker runs: the same arguments, launcher, environment and agent file; a planted .env variable reaches neither (FR-022)", () => {
  const p = makeProject();
  try {
    const file = path.join(p.tmp, 'agy-seen.jsonl');
    fs.writeFileSync(path.join(p.repo, '.env'), `PLANTED=${PLANTED}\n`);
    const env = { STUB_AGY_SEEN: file, STUB_AGY_VERSION: '1.3.4' };
    // The doctor's trial
    const doctor = JSON.parse(p.hub(['doctor', '--json'], { extraEnv: env }).out);
    const row = doctor.results.find((r) => r.id === 'agy.model');
    assert.equal(row.status, 'ok', row.detail);
    assert.match(row.detail, /ran as a worker runs, on agy 1\.3\.4\)\. It ran: agy -p "nextlevel model check:…" --print-timeout 2m --output-format stream-json --dangerously-skip-permissions --mode accept-edits --agent nextlevel-worker, in .*nextlevel-agy-trial, (in a console with no window|headless)\.$/);
    // A task through the hub: its kept answer counts (no trial of the hub's own), then the worker
    spec(p, 'T1-ok');
    p.hub(['dispatch', 'T1-ok']);
    const r = p.runUntilIdle([], { extraEnv: env });
    assert.equal(p.status('T1-ok').state, 'done', r.out);
    const [trial, worker] = seen(file);
    assert.equal(seen(file).length, 2, 'the doctor\'s trial, then the worker');
    assert.match(trial.prompt, /^nextlevel model check/);
    assert.equal(worker.prompt, 'worker');
    // The same arguments but the prompt and the time limit
    const same = (args) => args.map((a, i) => (args[i - 1] === '-p' ? '<prompt>' : args[i - 1] === '--print-timeout' ? '<limit>' : a));
    assert.deepEqual(same(trial.args), same(worker.args));
    // The same agent file, its YAML quoted
    assert.equal(trial.agent, worker.agent);
    assert.match(worker.agent, /^description: "A worker of nextlevel's build team: one task in its slot\./m);
    // The same environment, but what is the slot's own (its task, slot and ports) and the hub's token for this start
    const slotOwn = new Set(['NEXTLEVEL_TASK_ID', 'NEXTLEVEL_SLOT', 'NEXTLEVEL_PORT_OFFSET', 'COMPOSE_PROJECT_NAME', 'NEXTLEVEL_LAUNCH']);
    const names = (s) => s.env.filter((k) => !slotOwn.has(k.toUpperCase()));
    assert.deepEqual(names(trial), names(worker));
    for (const s of [trial, worker]) {
      assert.ok(!s.env.includes('PLANTED'), `${s.prompt}: no .env variable`);
      assert.ok(s.env.includes('AGY_CLI_DISABLE_AUTO_UPDATE') && s.env.includes('GIT_SSH_COMMAND') && s.env.includes('NEXTLEVEL_AGENT'), `${s.prompt}: a worker's environment`);
    }
    // Started directly, never through cmd.exe: the engine's parent is node (the runner, or the worker's process)
    assert.ok(trial.cwd.endsWith('nextlevel-agy-trial'));
  } finally {
    p.cleanup();
  }
});

test('agy updated itself: the hub runs the trial before its next agy task, and none when nothing changed; the doctor names both versions (FR-022)', () => {
  const p = makeProject();
  try {
    const seenFile = path.join(p.tmp, 'agy-seen.jsonl');
    const versionFile = path.join(p.tmp, 'agy-version.txt');
    const errorFile = path.join(p.tmp, 'agy-error.txt');
    const env = { STUB_AGY_SEEN: seenFile, STUB_AGY_VERSION_FILE: versionFile, STUB_AGY_ERROR_FILE: errorFile };
    setVersion(p, versionFile, '1.3.2');
    assert.equal(JSON.parse(p.hub(['doctor', '--json'], { extraEnv: env }).out).results.find((r) => r.id === 'agy.model').status, 'ok');
    spec(p, 'T1-ok');
    p.hub(['dispatch', 'T1-ok']);
    p.runUntilIdle([], { extraEnv: env });
    assert.equal(p.status('T1-ok').state, 'done');
    assert.equal(probes(seenFile).length, 1, "the doctor's answer counts: no trial of the hub's own");

    // agy 1.3.4: the hub tries before the next task
    setVersion(p, versionFile, '1.3.4');
    spec(p, 'T2-ok');
    p.hub(['dispatch', 'T2-ok']);
    const r2 = p.runUntilIdle([], { extraEnv: env });
    assert.equal(p.status('T2-ok').state, 'done', r2.out);
    assert.equal(probes(seenFile).length, 2, 'one trial for the new version');
    assert.match(hubLog(p), /checking Antigravity 1\.3\.4 with what a worker runs before its tasks start/);
    spec(p, 'T3-ok');
    p.hub(['dispatch', 'T3-ok']);
    p.runUntilIdle([], { extraEnv: env });
    assert.equal(p.status('T3-ok').state, 'done');
    assert.equal(probes(seenFile).length, 2, 'nothing changed: no trial');

    // A refusal on the new version names both (Check again: --fresh)
    fs.writeFileSync(errorFile, 'You have reached your individual quota');
    const row = JSON.parse(p.hub(['doctor', '--json', '--fresh'], { extraEnv: env }).out).results.find((x) => x.id === 'agy.model');
    assert.equal(row.status, 'fail');
    assert.match(row.detail, /^agy's default model was refused on agy 1\.3\.4 \(passed on 1\.3\.2\): You have reached your individual quota, exit 1\. It ran: /);
  } finally {
    p.cleanup();
  }
});

test("a failing trial holds the agy tasks (with a card, one phone message and a way to move them) while other engines' run; Check again and the hourly try release them; the hub's heartbeat goes on while a trial hangs (FR-022)", async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  let bg;
  let ui;
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    fs.writeFileSync(path.join(p.repo, '.env'), `PLANTED=${PLANTED}\n`);
    const errorFile = path.join(p.tmp, 'agy-error.txt');
    const hangFile = path.join(p.tmp, 'agy-hang.txt');
    fs.writeFileSync(errorFile, `You have reached your individual quota (${PLANTED}, ${GOOGLE_KEY})`);
    const clock = testClock(p, '2026-10-14T10:00:00Z');
    const env = { ...clock.env, NTFY_TOPIC: 'a-long-random-topic-for-tests-1234', STUB_AGY_ERROR_FILE: errorFile, STUB_AGY_HANG_FILE: hangFile, STUB_AGY_VERSION: '1.3.4', STUB_AGY_MODELS: 'stub-model,gemini-4-argon-high' };
    for (const [id, engine] of [['A1-ok', 'agy'], ['C1-ok', 'codex'], ['A2-ok', 'agy']]) spec(p, id, engine);
    for (const id of ['A1-ok', 'C1-ok']) p.hub(['dispatch', id]);
    bg = p.hubInBackground(['run', '--tick-ms', '50'], env);
    await until(p, 'A1-ok to wait for Antigravity and C1-ok to finish', () => /refused what a worker runs/.test(status(p, 'A1-ok').waiting || '') && status(p, 'C1-ok').state === 'done');
    assert.equal(status(p, 'A1-ok').state, 'queued');
    // agy's own words, redacted, in one line: the job, hub.log, status, the card and the phone
    const words = /^Antigravity 1\.3\.4 refused what a worker runs: You have reached your individual quota \(\*\*\*, \*\*\*\), exit 1\./;
    assert.match(status(p, 'A1-ok').waiting, words);
    assert.match(hubLog(p), /Antigravity 1\.3\.4 refused what a worker runs: You have reached your individual quota \(\*\*\*, \*\*\*\), exit 1\. Tasks on it wait in the queue; tasks on other engines go on/);
    for (const s of [PLANTED, GOOGLE_KEY]) assert.ok(!hubLog(p).includes(s) && !JSON.stringify(p.settings()).includes(s), 'redacted everywhere');
    const st = JSON.parse(p.hub(['status', '--json']).out);
    assert.match(st.agyHold.text, /^Antigravity 1\.3\.4 refused what a worker runs: You have reached your individual quota/);
    assert.deepEqual(st.agyHold.tasks, ['A1-ok']);
    assert.match(p.hub(['status']).out, /queued {5}A1-ok .*waiting: Antigravity 1\.3\.4 refused/);
    const wait = p.hub(['wait', 'A1-ok', '--minutes', '0.02']);
    assert.match(wait.out, /A1-ok waits for Antigravity\. To move it to the workers' fallback: nextlevel retry A1-ok --fallback/);
    // One round for the orchestrator (a trigger under the brake, as a check ending)
    const rounds = JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8'));
    assert.equal(rounds.pending.filter((t) => /^Antigravity 1\.3\.4 tasks wait/.test(t.what) && t.type === 'job').length, 1);
    // The bridge test refuses at once (on the same agy: its own run's trial is the one refused)
    const bridge = p.hub(['bridge-test'], { extraEnv: env });
    assert.equal(bridge.code, 1);
    assert.match(bridge.out, /The bridge test doesn't start: Antigravity 1\.3\.4 refused what a worker runs/);

    // Another agy task waits too, with no second phone message; a retry moves it, the same attempt
    p.hub(['dispatch', 'A2-ok']);
    await until(p, 'A2-ok to wait', () => /refused/.test(status(p, 'A2-ok').waiting || ''));
    await hubRounds(p, 3);
    const phone = ntfy.got.filter((m) => m.title === 'proj: Antigravity tasks wait');
    assert.equal(phone.length, 1, 'one phone message');
    assert.match(phone[0].message, /^Antigravity 1\.3\.4 refused what a worker runs: You have reached your individual quota \(\*\*\*, \*\*\*\), exit 1\. Nothing falls back by itself/);
    assert.ok(!phone[0].message.includes('\n'), 'one line');
    assert.match(p.hub(['retry', 'A2-ok']).out, /A2-ok is queued, waiting for Antigravity/);
    const moved = p.hub(['retry', 'A2-ok', '--fallback']);
    assert.match(moved.out, /queued A2-ok \(attempt 1, codex/, moved.out);
    await until(p, 'A2-ok to run on the fallback', () => status(p, 'A2-ok').state === 'done');
    assert.equal(status(p, 'A2-ok').engine, 'codex');

    // The card on Home, with Check again
    ui = await startUi(p, env);
    const needs = (await client(ui).get('/api/state')).json.needs;
    const card = needs.find((n) => n.kind === 'agy');
    assert.match(card.text, /^Antigravity 1\.3\.4 refused what a worker runs: You have reached your individual quota \(\*\*\*, \*\*\*\), exit 1\. 1 task waits for it \(A1-ok\)\.$/);
    assert.deepEqual(card.action, { label: 'Check again', post: '/api/agy', body: {} });

    // The hourly try: agy passes again, but its refusal stands until an hour has passed (on the test clock)
    fs.rmSync(errorFile);
    clock.add(30);
    await hubRounds(p, 4);
    assert.equal(status(p, 'A1-ok').state, 'queued', 'half an hour: still waiting');
    clock.add(31);
    await until(p, 'A1-ok to run after the hourly try', () => status(p, 'A1-ok').state === 'done');
    assert.equal(p.settings().agyHold, null);
    assert.match(hubLog(p), /Antigravity 1\.3\.4 passed the trial \(what a worker runs\)/);

    // Check again: a task on another model fails its trial (a key of its own); with agy fixed meanwhile, Check again runs
    // the trial at once. While it hangs the hub's heartbeat goes on.
    fs.writeFileSync(errorFile, 'model gemini-4-argon-high is not available for your plan');
    spec(p, 'A3-ok');
    p.hub(['dispatch', 'A3-ok', '--model', 'gemini-4-argon-high']);
    await until(p, 'A3-ok to wait', () => /not available for your plan/.test(status(p, 'A3-ok').waiting || ''));
    fs.rmSync(errorFile);
    fs.writeFileSync(hangFile, 'hang');
    assert.equal((await client(ui).post('/api/agy', {})).json?.ok, true);
    await until(p, 'the trial to start again', () => /checking Antigravity/.test(status(p, 'A3-ok').waiting || ''));
    await hubRounds(p, 4); // (each round writes the heartbeat: the hub goes on while the trial hangs)
    assert.equal(status(p, 'A3-ok').state, 'queued');
    fs.rmSync(hangFile);
    await until(p, 'A3-ok to run once the trial passes', () => status(p, 'A3-ok').state === 'done');
    assert.equal(ntfy.got.filter((m) => m.title === 'proj: Antigravity tasks wait').length, 2, 'one message per hold');
  } finally {
    await stopUi(ui);
    await stopHub(p, bg);
    await ntfy.close();
    p.cleanup();
  }
});

test("a worker's failed attempt on agy says why in agy's own words, with the exit code and its last lines, redacted (FR-022)", () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.repo, '.env'), `PLANTED=${PLANTED}\n`);
    fs.mkdirSync(path.join(p.tmp, 'home', '.gemini', 'config'), { recursive: true });
    const mcpKey = 'stitch-header-value-8c1f0e2b9d';
    fs.writeFileSync(path.join(p.tmp, 'home', '.gemini', 'config', 'mcp_config.json'), JSON.stringify({ mcpServers: { stitch: { command: 'npx', args: ['-y', 'stitch-mcp', '--header', `X-Goog-Api-Key: ${mcpKey}`] } } }));
    spec(p, 'F1');
    p.hub(['dispatch', 'F1']);
    const r = p.runUntilIdle([], { extraEnv: { STUB_AGY_VERSION: '1.3.4', STUB_AGY_TASK_ERROR: `the model request failed (${PLANTED} ${GOOGLE_KEY} ${mcpKey})` } });
    const s = p.status('F1');
    assert.equal(s.state, 'failed', r.out);
    // (why its report is missing, FR-020: agy's ERROR result is an error end of its own)
    assert.match(s.missing, /^Antigravity ended with an error: the model request failed \(\*\*\* \*\*\* \*\*\*\)$/);
    assert.deepEqual([s.engineError.reason, s.engineError.code], ['the model request failed (*** *** ***)', 1]);
    assert.ok(s.engineError.last.length > 0 && s.engineError.last.length <= 20);
    const result = p.hub(['result', 'F1', '--peek']).out;
    assert.match(result, /## How Antigravity ended\nERROR; the model request failed \(\*\*\* \*\*\* \*\*\*\) \(exit 1\)\nWhat it printed last:\n/);
    assert.match(hubLog(p), /F1: Antigravity said: the model request failed \(\*\*\* \*\*\* \*\*\*\) \(exit 1\); it printed last: /);
    for (const x of [PLANTED, GOOGLE_KEY, mcpKey]) {
      assert.ok(!hubLog(p).includes(x) && !result.includes(x) && !JSON.stringify(s).includes(x), `${x.slice(0, 8)}... is redacted`);
    }
  } finally {
    p.cleanup();
  }
});

test("a hold no task waits for goes: the owner moved the held task with retry --fallback; the bridge test looks at its own run's trial, refused while it fails and not after a pass (FR-022, review)", async () => {
  const p = makeProject();
  let bg;
  try {
    const errorFile = path.join(p.tmp, 'agy-error.txt');
    fs.writeFileSync(errorFile, 'You have reached your individual quota');
    const env = { STUB_AGY_ERROR_FILE: errorFile, STUB_AGY_VERSION: '1.3.4' };
    spec(p, 'A1-ok');
    p.hub(['dispatch', 'A1-ok']);
    bg = p.hubInBackground(['run', '--tick-ms', '50'], env);
    await until(p, 'A1-ok to wait for Antigravity', () => /refused what a worker runs/.test(status(p, 'A1-ok').waiting || ''));
    assert.ok(p.settings().agyHold, 'held');
    const refused = p.hub(['bridge-test'], { extraEnv: env });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /The bridge test doesn't start: Antigravity 1\.3\.4 refused what a worker runs: You have reached your individual quota, exit 1/);
    // The owner moves the only held task: the card goes
    assert.match(p.hub(['retry', 'A1-ok', '--fallback']).out, /queued A1-ok \(attempt 1, codex/);
    await until(p, 'the hold to go once no task waits for it', () => p.settings().agyHold === null);
    assert.match(hubLog(p), /no task waits for Antigravity any more: its card goes/);
    await until(p, 'A1-ok to run on the fallback', () => status(p, 'A1-ok').state === 'done');
    // agy is fixed and the doctor tries again: the bridge test goes on (its own run's trial passed), and passes
    fs.rmSync(errorFile);
    assert.equal(JSON.parse(p.hub(['doctor', '--json', '--fresh'], { extraEnv: env }).out).results.find((r) => r.id === 'agy.model').status, 'ok');
    const bridge = p.hub(['bridge-test'], { extraEnv: env, timeout: 300_000 });
    assert.doesNotMatch(bridge.out, /doesn't start/);
    assert.match(bridge.out, /Bridge works/, bridge.out);
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('a trial that ends without an answer (stopped at its limit) keeps a short "no answer": the agy task waits, and no new trial starts at every tick (FR-022, review)', async () => {
  const p = makeProject();
  let bg;
  try {
    const hangFile = path.join(p.tmp, 'agy-hang.txt');
    fs.writeFileSync(hangFile, 'hang');
    spec(p, 'A1-ok');
    p.hub(['dispatch', 'A1-ok']);
    bg = p.hubInBackground(['run', '--tick-ms', '50'], { STUB_AGY_HANG_FILE: hangFile, NEXTLEVEL_TEST_TRIAL_LIMIT_MS: '3000' });
    await until(p, 'A1-ok to wait with no answer', () => /the trial ended without an answer/.test(status(p, 'A1-ok').waiting || ''));
    await hubRounds(p, 8);
    assert.equal((hubLog(p).match(/checking Antigravity/g) || []).length, 1, 'one trial, not one at every tick');
    assert.equal(status(p, 'A1-ok').state, 'queued');
    fs.rmSync(hangFile);
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test(
  'a PC where the console with no window doesn\'t start: agy tasks start as before, in a window of their own, with no trial at every tick (FR-022, review)',
  // (its worker opens a window, which takes the focus: CI only)
  { skip: (process.platform !== 'win32' && 'a console with no window is for Windows') || (!process.env.CI && 'opens a window that takes the focus: CI only') },
  () => {
    const p = makeProject();
    try {
      fs.mkdirSync(path.join(p.env.HOME, '.nextlevel'), { recursive: true });
      fs.writeFileSync(path.join(p.env.HOME, '.nextlevel', 'console.json'), JSON.stringify({ failed: { why: 'the test plays a PC without one', at: new Date().toISOString() } }));
      spec(p, 'A1-ok');
      p.hub(['dispatch', 'A1-ok']);
      const r = p.runUntilIdle([], { extraEnv: { NEXTLEVEL_WORKER_WINDOW: undefined, NEXTLEVEL_WINDOW_CLOSE_S: '1' }, timeout: 240_000 });
      assert.equal(p.status('A1-ok').state, 'done', r.out);
      assert.doesNotMatch(hubLog(p), /checking Antigravity/);
      const row = JSON.parse(p.hub(['doctor', '--json']).out).results.find((x) => x.id === 'agy.model');
      assert.deepEqual([row.status, row.severity], ['fail', 'warn']);
      assert.match(row.detail, /what a worker runs is not tried/);
    } finally {
      p.cleanup();
    }
  },
);