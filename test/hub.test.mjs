// End-to-end tests for the hub, run as `nextlevel <command>` against stub CLIs (never the real agy/codex).
//   npm test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ownerNeeds, taskAlerts } from '../src/lib/overview.mjs';
import { BIN, consoleWorksHere, fileExists, hubRounds, isAlive, makeProject, processesGone, sleep, waitUntil, withEnv } from './helpers.mjs';

test('doctor creates .env and sees the stub tools', () => {
  const p = makeProject();
  try {
    const r = p.hub(['doctor']);
    assert.match(r.out, /Codex CLI\s+codex-cli 0\.152\.0/);
    assert.match(r.out, /Antigravity CLI\s+1\.2\.4/);
    assert.ok(fs.existsSync(path.join(p.repo, '.env')), '.env should be created from .env.example');
  } finally {
    p.cleanup();
  }
});

test('doctor --json lists every check and never shows a secret', () => {
  const p = makeProject();
  try {
    const topic = 'topic-that-is-a-secret-7f3a9c21';
    fs.writeFileSync(path.join(p.repo, '.env'), `NTFY_TOPIC=${topic}\nPLANTED_SECRET=hunter2\n`);
    p.git('remote', 'set-url', 'origin', `https://owner:ghp_plantedtoken@github.com/o/r.git`);
    const text = p.hub(['doctor']);
    const r = p.hub(['doctor', '--json']);
    assert.equal(r.code, 0, r.out);
    const json = JSON.parse(r.out);
    assert.equal(path.basename(json.project), 'proj');
    assert.equal(json.summary.errors, 0, JSON.stringify(json.results.filter((x) => x.status === 'fail'), null, 2));
    const ids = json.results.map((x) => x.id);
    for (const id of ['project.folder', 'git.identity', 'codex.model', 'agy.deny-list', 'claude.github', 'bridge.test', 'pc.sleep']) assert.ok(ids.includes(id), id);
    for (const x of json.results) for (const s of x.steps) assert.ok(s.label, `${x.id}: a step without its window's label`);
    assert.match(text.out, / ok +GitHub repo +https:\/\/\*\*\*@github\.com\/o\/r\.git/);
    for (const out of [text.out, r.out]) assert.doesNotMatch(out, new RegExp(`${topic}|hunter2|ghp_plantedtoken`));
  } finally {
    p.cleanup();
  }
});

test('a pinned Codex model the login rejects stops the orchestrator and pauses autopilot (FR-001 #5)', () => {
  const p = makeProject();
  try {
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'codex', model: 'gpt-6-sol' } } }));
    const doctor = p.hub(['doctor']);
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /!! +Codex model +"gpt-6-sol" \(roles\.orchestrator\.model\) was rejected: .*not supported when using Codex with a ChatGPT account/);
    assert.match(doctor.out, /Inside Codex: {2}\/model/);
    const orch = p.hub(['orchestrator']);
    assert.equal(orch.code, 1, orch.out);
    assert.match(orch.out, /Not starting the orchestrator: "gpt-6-sol" .*rejected/);
    assert.doesNotMatch(orch.out, /\[fake codex\] interactive/);
    const head = p.git('rev-parse', 'HEAD');
    // (FR-019: a round starts only for something that happened; here the owner's note)
    assert.match(p.hub(['note', 'add', 'Start M1']).out, /Added N1/);
    p.runUntilIdle(['--autopilot']);
    assert.equal(p.settings().pausedReason, 'the Codex model in nextlevel.json was rejected');
    assert.equal(p.git('rev-parse', 'HEAD'), head, 'no orchestrator cycle ran');
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /autopilot paused: "gpt-6-sol"/);
    // A name the login accepts passes (checked through the doctor: on Windows the orchestrator opens a window)
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'codex', model: 'gpt-6' } } }));
    assert.match(p.hub(['doctor']).out, / ok +Codex model +gpt-6 \(accepted by this Codex login\)/);
  } finally {
    p.cleanup();
  }
});

test("the doctor runs the project's own checks from .nextlevel/checks/", () => {
  const p = makeProject();
  try {
    const dir = p.state('checks');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'site.mjs'),
      "export default { id: 'myapp.smtp', title: 'SMTP host', severity: 'warn', run: (ctx) => ctx.env.SMTP_HOST ? { ok: true, detail: 'set' } : { ok: false, detail: 'SMTP_HOST empty', steps: [{ window: 'editor', text: 'put it in .env' }] } };\n",
    );
    fs.writeFileSync(path.join(dir, 'broken.mjs'), 'export default {');
    const r = p.hub(['doctor']);
    assert.match(r.out, /!! +SMTP host +SMTP_HOST empty/);
    assert.match(r.out, /Text editor: {2}put it in \.env/);
    assert.match(r.out, /!! +broken\.mjs +doesn't load/);
    fs.appendFileSync(path.join(p.repo, '.env'), 'SMTP_HOST=mail.example.com\n');
    assert.match(p.hub(['doctor']).out, / ok +SMTP host +set/);
  } finally {
    p.cleanup();
  }
});

test('doctor --fix merges the worker deny-list without losing existing agy settings', () => {
  const p = makeProject();
  try {
    const dir = path.join(p.env.HOME, '.gemini', 'antigravity-cli');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ colorScheme: 'dark', permissions: { allow: ['command(git)'] } }));
    const r = p.hub(['doctor', '--fix']);
    // Configured is all the doctor can see; whether agy obeys is for the bridge test to show (FR-003)
    assert.match(r.out, /ok +Worker safety rules +agy deny-list configured \(not proof it works\) +-> +proof that workers can't push: the bridge test/);
    assert.doesNotMatch(r.out, /safety rules present/);
    const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
    assert.equal(s.colorScheme, 'dark');
    assert.deepEqual(s.permissions.allow, ['command(git)']);
    assert.ok(s.permissions.deny.includes('command(git push)'));
    assert.ok(s.permissions.deny.includes('command(gh)'));
    assert.ok(fs.existsSync(path.join(dir, 'settings.json.nextlevel-backup')));
    // It says the write stuck, from the file itself (FR-001 #10), and doesn't ask again
    assert.match(r.out, /Saved the \d+ rules in .*settings\.json and read them back: they are all there/);
    assert.doesNotMatch(p.hub(['doctor', '--fix']).out, /Saved the/);
  } finally {
    p.cleanup();
  }
});

test('two slots run tasks in parallel; states reflect verification, blocks and leftovers', () => {
  const p = makeProject();
  try {
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.spec('M1-02-fail', fileExists('fixed.txt'));
    p.spec('M1-03-blocked', 'node -e "process.exit(0)"');
    p.spec('M1-04-leftover', 'node -e "process.exit(0)"');
    for (const id of ['M1-01-ok', 'M1-02-fail', 'M1-03-blocked', 'M1-04-leftover']) assert.equal(p.hub(['dispatch', id]).code, 0);
    assert.notEqual(p.hub(['dispatch', 'M1-01-ok']).code, 0, 'a queued task cannot be dispatched twice');
    p.runUntilIdle();
    assert.equal(p.status('M1-01-ok').state, 'done');
    assert.equal(p.status('M1-01-ok').verify, 'pass');
    assert.equal(p.status('M1-02-fail').state, 'failed');
    assert.equal(p.status('M1-03-blocked').state, 'blocked');
    assert.equal(p.status('M1-04-leftover').state, 'done');
    assert.match(p.git('log', '--oneline', 'main..task/M1-04-leftover'), /left uncommitted/);
    const slots = new Set(['M1-01-ok', 'M1-02-fail'].map((id) => p.status(id).slot));
    assert.equal(slots.size, 2, 'the first two tasks should run in different slots');
  } finally {
    p.cleanup();
  }
});

test('retry passes the feedback to the worker and re-verifies', () => {
  const p = makeProject();
  try {
    p.spec('M1-02-fail', fileExists('fixed.txt'));
    p.hub(['dispatch', 'M1-02-fail']);
    p.runUntilIdle();
    assert.equal(p.status('M1-02-fail').state, 'failed');
    assert.notEqual(p.hub(['retry', 'M1-02-fail']).code, 0, 'retry without feedback is refused');
    assert.equal(p.hub(['retry', 'M1-02-fail', '--feedback', 'Create fixed.txt']).code, 0);
    p.runUntilIdle();
    const s = p.status('M1-02-fail');
    assert.equal(s.state, 'done');
    assert.equal(s.attempt, 2);
  } finally {
    p.cleanup();
  }
});

test('a task spec saved with Windows line ends (CRLF) keeps its Verify commands, and the hub runs them', () => {
  const p = makeProject();
  const id = 'M1-11-ok-crlf';
  try {
    p.spec(id, `${fileExists('ok.mjs')}\n# a comment\n${fileExists('missing-on-purpose.txt')}`);
    const file = path.join(p.repo, 'docs', 'tasks', `${id}.md`);
    // (and a blank line between the heading and its fence, as an editor on Windows saves it)
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('## Verify\n', '## Verify\n\n').replace(/\n/g, '\r\n'));
    const r = p.hub(['dispatch', id]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /, 2 verify command\(s\)\)/);
    assert.doesNotMatch(r.out, /warning/);
    const queued = JSON.parse(fs.readFileSync(p.state('queue', `${id}.json`), 'utf8'));
    assert.deepEqual(queued.verify, [fileExists('ok.mjs'), fileExists('missing-on-purpose.txt')]);
    p.runUntilIdle();
    const s = p.status(id);
    assert.equal(s.claimed, 'DONE');
    assert.equal(s.state, 'failed', 'the second Verify command ran, and failed');
    // A Verify heading that gives no command is said at dispatch, never passed over in silence
    const none = 'M1-12-no-commands';
    p.spec(none, 'x');
    const noneFile = path.join(p.repo, 'docs', 'tasks', `${none}.md`);
    fs.writeFileSync(noneFile, fs.readFileSync(noneFile, 'utf8').replace(/```sh\n[\s\S]*```\n/, 'Run the tests.\n'));
    const w = p.hub(['dispatch', none]);
    assert.equal(w.code, 0, w.out);
    assert.match(w.out, /, 0 verify command\(s\)\)/);
    assert.match(w.out, new RegExp(`warning: docs/tasks/${none}\\.md has a Verify heading, but no command came out of it`));
    assert.match(w.out, new RegExp(`the task's next attempt reads them \\(nextlevel retry ${none} --feedback`));
  } finally {
    p.cleanup();
  }
});

test("a new attempt never shows the one before's report; a worker that fails to start keeps its output with that attempt (FR-010)", () => {
  const p = makeProject();
  const id = 'M1-10-ok';
  try {
    p.spec(id, fileExists('ok.mjs'));
    p.hub(['dispatch', id]);
    p.runUntilIdle();
    assert.equal(p.status(id).claimed, 'DONE');
    // Attempt 2: agy refuses to start (on the owner's PC: "--effort is not supported for model ...")
    assert.equal(p.hub(['retry', id, '--feedback', 'Once more']).code, 0);
    const r = p.runUntilIdle([], { extraEnv: { STUB_AGY_FAIL: 'Error: --effort is not supported for model claude-opus-4-6-thinking' } });
    const s = p.status(id);
    assert.equal(s.attempt, 2);
    assert.equal(s.state, 'failed', r.out);
    assert.equal(s.claimed, 'MISSING', "attempt 1's report is not attempt 2's");
    // (in agy's own words, FR-022)
    // (FR-020: why the report is missing, in the summary, the hub log and `nextlevel result`)
    const why = 'the worker stopped (exit 1) before it wrote a report: Antigravity said: --effort is not supported for model claude-opus-4-6-thinking';
    assert.equal(s.missing, why);
    assert.ok(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8').includes(`finished M1-10-ok: failed · verify pass · no report: ${why} · 0 commit(s) this attempt, 1 in all`));
    assert.ok(!fs.existsSync(p.jobFile(id, 'RESULT.md')), 'no report for attempt 2');
    assert.match(fs.readFileSync(p.jobFile(id, 'RESULT.attempt-1.md'), 'utf8'), /^Status: DONE/, "attempt 1's report is kept beside it");
    assert.ok(p.hub(['result', id]).out.includes(`## Worker report\n(none written: ${why})`));
    // Its output is this attempt's part of worker.log
    const log = fs.readFileSync(p.jobFile(id, 'worker.log'), 'utf8');
    const second = log.slice(s.logFrom);
    assert.match(second, /task M1-10-ok · attempt 2 ·[\s\S]*Error: --effort is not supported[\s\S]*Worker finished \(exit 1\)/);
    assert.doesNotMatch(second, /attempt 1 ·/);
  } finally {
    p.cleanup();
  }
});

test('checks, push and notifications go through the hub', () => {
  const p = makeProject();
  try {
    const one = p.hub(['verify', 'args', '--', 'node', '-e', "console.log('hi there')"]);
    const chain = p.hub(['verify', 'chain', '--', 'node -e "process.exit(0)" && node -e "process.exit(0)"']);
    const bad = p.hub(['verify', 'bad', '--', 'node -e "process.exit(3)"']);
    // (a push names its branch; main is a deploy branch, which the owner approves first: test/push.test.mjs, FR-015)
    const push = p.hub(['push', 'backup/main']);
    p.hub(['notify', 'Test', 'hello']);
    p.runUntilIdle();
    const id = (r) => r.out.match(/queued ([^\s:]+)/)[1];
    assert.equal(p.status(id(one)).state, 'passed');
    assert.equal(p.status(id(chain)).state, 'passed');
    assert.equal(p.status(id(bad)).state, 'failed');
    assert.equal(p.status(id(push)).state, 'done');
    assert.equal(p.git('rev-parse', 'main'), p.git('--git-dir', p.remote, 'rev-parse', 'backup/main'));
    assert.equal(fs.readdirSync(p.state('outbox')).length, 0, 'outbox should be flushed');
  } finally {
    p.cleanup();
  }
});

test("workers can't push (FR-003): by name, by URL, over ssh, with gh or a saved login; the hub still pushes", () => {
  const p = makeProject();
  const id = 'M1-08-pushy';
  try {
    // The project's own hooks: pre-commit must still run in slots, pre-push only for the hub's push
    const marks = path.join(p.tmp, 'marks');
    fs.mkdirSync(marks);
    for (const name of ['pre-commit', 'pre-push']) {
      const f = path.join(p.repo, '.git', 'hooks', name);
      fs.writeFileSync(f, `#!/bin/sh\necho ran >> '${marks.split(path.sep).join('/')}/${name}'\n`);
      fs.chmodSync(f, 0o755);
    }
    // A saved login git would hand out, like Git Credential Manager on the owner's PC
    p.git('config', 'credential.helper', '!f() { echo username=owner; echo password=owner-secret; }; f');
    p.spec(id, fileExists('pushy.txt'));
    p.hub(['dispatch', id]);
    const r = p.runUntilIdle();
    assert.equal(p.status(id).state, 'done', r.out);
    const report = fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
    for (const way of ['git push', 'git push .url.', 'ssh', 'gh api', 'saved login']) assert.match(report, new RegExp(`^${way}: refused`, 'm'), report);
    assert.match(report, /^ssh: refused \(nextlevel: ssh is blocked/m, 'ssh runs the refusing GIT_SSH_COMMAND');
    assert.match(report, /^gh api: refused \(HTTP 401/m, "gh gets a token that doesn't work instead of the owner's login");
    assert.match(report, /^Terminal prompts: 0$/m);
    assert.equal(p.git('--git-dir', p.remote, 'for-each-ref'), '', 'nothing a worker pushed may arrive');
    assert.ok(fs.existsSync(path.join(marks, 'pre-commit')), "the project's own pre-commit hook still runs in slots");

    // Without the worker's environment and with the push URL put back by hand, the slot's pre-push hook refuses
    const slot = path.join(`${p.repo}.slots`, `w${p.status(id).slot}`);
    const byHand = spawnSync('git', ['-c', `url.${p.remote}.pushInsteadOf=${p.remote}`, 'push', p.remote, 'HEAD:refs/heads/by-hand'], {
      cwd: slot,
      env: p.env,
      encoding: 'utf8',
    });
    assert.notEqual(byHand.status, 0, byHand.stderr);
    assert.match(byHand.stderr, /nextlevel: pushing from a worker slot is blocked/);
    assert.equal(p.git('--git-dir', p.remote, 'for-each-ref'), '');
    assert.ok(!fs.existsSync(path.join(marks, 'pre-push')), "slots never run the project's own pre-push");

    // The hub's own push from the main checkout still works, and runs the project's pre-push hook
    const push = p.hub(['push', 'backup/main']).out.match(/queued (push-\S+):/)[1];
    p.runUntilIdle();
    assert.equal(p.status(push).state, 'done', fs.readFileSync(p.jobFile(push, 'push.log'), 'utf8'));
    assert.equal(p.git('rev-parse', 'main'), p.git('--git-dir', p.remote, 'rev-parse', 'backup/main'));
    assert.ok(fs.existsSync(path.join(marks, 'pre-push')), "the main checkout keeps the project's own hooks");
  } finally {
    p.cleanup();
  }
});

test('a push URL in the shared git config is switched off in slots, or no worker starts', () => {
  const p = makeProject();
  try {
    p.git('config', 'remote.origin.pushurl', p.remote);
    p.spec('M1-08-pushy', fileExists('pushy.txt'));
    p.hub(['dispatch', 'M1-08-pushy']);
    const r = p.runUntilIdle();
    const s = p.status('M1-08-pushy');
    // Git 2.46+ can clear the shared pushurl for one slot; older Git can't, so the hub refuses the slot
    const [major, minor] = p.git('--version').match(/(\d+)\.(\d+)/).slice(1).map(Number);
    if (major > 2 || (major === 2 && minor >= 46)) {
      assert.equal(s.state, 'done', r.out);
      assert.match(fs.readFileSync(p.jobFile('M1-08-pushy', 'RESULT.md'), 'utf8'), /^git push: refused/m);
    } else {
      assert.equal(s.state, 'error', r.out);
      assert.match(s.error, /could still push to "origin".*Git 2\.46/);
    }
    assert.equal(p.git('--git-dir', p.remote, 'for-each-ref'), '', 'nothing a worker pushed may arrive');
  } finally {
    p.cleanup();
  }
});

test('a worker that runs past its time limit is stopped and marked timeout', () => {
  const p = makeProject();
  try {
    p.spec('M1-05-slow', 'node -e "process.exit(0)"');
    p.hub(['dispatch', 'M1-05-slow', '--timeout', '0.05']);
    p.runUntilIdle([], { timeout: 90_000 });
    const s = p.status('M1-05-slow');
    assert.equal(s.state, 'timeout');
    // (FR-020: and it says so where its report would be)
    assert.equal(s.missing, 'the time limit (0.05 min) stopped it first');
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /finished M1-05-slow: timeout · no report: the time limit \(0\.05 min\) stopped it first/);
    assert.match(p.hub(['result', 'M1-05-slow']).out, /\(none written: the time limit \(0\.05 min\) stopped it first\)/);
  } finally {
    p.cleanup();
  }
});

test('a background worker exits within 5 s of finishing', async () => {
  const p = makeProject();
  try {
    p.spec('M0-01-console', fileExists('console.txt'));
    // (Codex: a worker in the background on every PC; agy runs in a window where the console with no window fails)
    p.hub(['dispatch', 'M0-01-console', '--engine', 'codex']);
    // Only workers the hub opens a window for may pause at exit, even if the hub's own environment says otherwise
    const r = p.runUntilIdle([], { extraEnv: { NEXTLEVEL_IN_WINDOW: '1' } });
    assert.equal(p.status('M0-01-console').state, 'done', r.out);
    const run = JSON.parse(fs.readFileSync(p.jobFile('M0-01-console', 'run.json'), 'utf8'));
    const deadline = Date.parse(run.endedAt) + 5000;
    while (isAlive(run.pid) && Date.now() < deadline) await sleep(100);
    assert.ok(!isAlive(run.pid), `worker process ${run.pid} was still running 5 s after it finished`);
    assert.match(fs.readFileSync(p.jobFile('M0-01-console', 'RESULT.md'), 'utf8'), /In window: unset/);
  } finally {
    p.cleanup();
  }
});

test(
  'on Windows an Antigravity worker gets a real console with no window by default, and its output is its worker.log (FR-010)',
  { skip: process.platform !== 'win32' && 'agy needs a real console on Windows only' },
  () => {
    const p = makeProject();
    const id = 'M0-02-console';
    try {
      p.spec(id, fileExists('console.txt'));
      p.hub(['dispatch', id]);
      const r = p.runUntilIdle([], { extraEnv: { NEXTLEVEL_WORKER_WINDOW: undefined } });
      assert.equal(p.status(id).state, 'done', r.out);
      const hubLog = fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
      assert.match(hubLog, /started M0-02-console in slot w1 \(agy, attempt 1; in a console with no window\)/, 'it is always tried first');
      const report = fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
      assert.match(report, /Console: tty/, 'its stdin is a real console, which agy needs (the stub refuses print mode without one)');
      if (consoleWorksHere()) {
        assert.equal(p.status(id).windowMode, 'console');
        assert.match(report, /In window: unset/);
      } else {
        // A PC where a process started with no window has no console to give agy: the same attempt starts again in a
        // window of its own, the PC remembers it, and the task says why (a visible window beats a stuck task)
        assert.equal(p.status(id).windowMode, 'visible');
        assert.match(p.status(id).launch.note, /^The console with no window didn't start on this PC \(its process found no console to give the engine \(exit 3\)\), so this worker runs in a window of its own/);
        assert.match(hubLog, /M0-02-console: the console with no window didn't start \(its process found no console to give the engine \(exit 3\)\); it starts again in a window of its own/);
        assert.match(report, /In window: visible/);
      }
      // Nothing of nextlevel's started conhost.exe (FR-013): the worker's process is node, started with no window
      assert.doesNotMatch(hubLog, /conhost/i);
      // What it printed came through pipes: its stream-json, in worker.log, and its tokens in the day's numbers
      const log = fs.readFileSync(p.jobFile(id, 'worker.log'), 'utf8');
      assert.match(log, /^\{"event":"result","result":\{.*"status":"SUCCESS"/m, log);
      assert.doesNotMatch(log, /\x1b/, 'no terminal escape codes');
      const usage = JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8'));
      assert.deepEqual(Object.values(usage)[0].by['worker:agy'], { runs: 1, minutes: Object.values(usage)[0].by['worker:agy'].minutes, reported: 1, tokens: 2150, cached: 9000 });
    } finally {
      p.cleanup();
    }
  },
);

test(
  "on Windows a worker never runs agy without a console: _run with no console to give ends before it starts, and says why (FR-010, FR-013)",
  { skip: process.platform !== 'win32' && 'agy needs a real console on Windows only' },
  () => {
    const p = makeProject();
    const id = 'M0-03-console';
    try {
      p.spec(id, fileExists('console.txt'));
      p.hub(['dispatch', id]);
      // The job as the hub would start it, _run run here on a PC played without a console to give (NEXTLEVEL_CONIN)
      fs.mkdirSync(p.jobFile(id, '..'), { recursive: true });
      fs.writeFileSync(p.jobFile(id, 'job.json'), JSON.stringify({ id, type: 'task', kind: 'code', engine: 'agy', role: '', attempt: 1, timeoutMin: 5 }));
      const noConsole = path.join(p.repo, 'no-console-here');
      const r = spawnSync(process.execPath, [BIN, '_run', id], { cwd: p.repo, env: withEnv(p.env, { NEXTLEVEL_ROOT: p.repo, NEXTLEVEL_CONIN: noConsole }), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], timeout: 60_000 });
      assert.equal(r.status, 3, `the exit that tells the hub to start it in a window: ${r.stdout}${r.stderr}`);
      assert.ok(!fs.existsSync(p.jobFile(id, 'run.json')), 'it never counted as started');
      const log = fs.readFileSync(p.jobFile(id, 'worker.log'), 'utf8');
      assert.match(log, /Antigravity needs a real console on Windows and this worker's process has none \(this process has no console to give it \(ENOENT\)\): the hub starts this attempt again in a window of its own/);
      assert.doesNotMatch(log, /fake agy/, 'agy was never started');
      if (!consoleWorksHere()) return;
      // A failure in a window of its own waits for Enter; where its input ends (no keyboard), the log says why the
      // window closed. (Its console is the one it was started with: CREATE_NO_WINDOW, since the test gives it pipes.)
      const w = spawnSync(process.execPath, [BIN, '_run', id], { cwd: p.repo, env: withEnv(p.env, { NEXTLEVEL_ROOT: p.repo, NEXTLEVEL_IN_WINDOW: 'visible', STUB_AGY_FAIL: 'Error: the service is currently unavailable' }), input: '', encoding: 'utf8', timeout: 60_000 });
      assert.equal(w.status, 0, w.stdout + w.stderr);
      assert.match(w.stdout, /Press Enter to close this window\./);
      assert.match(fs.readFileSync(p.jobFile(id, 'worker.log'), 'utf8'), /\(This window closed: its input ended \(no keyboard here\)\.\)\s*$/);
    } finally {
      p.cleanup();
    }
  },
);

test(
  'workers.window visible: a worker in a window of its own writes worker.log too, and a failed one keeps its window open (FR-010)',
  // It opens real windows, which take the focus: CI only
  { skip: (process.platform !== 'win32' && 'windows are for Windows') || (!process.env.CI && 'opens windows that take the focus: CI only') },
  async (t) => {
    const p = makeProject();
    const ok = 'M0-04-console';
    const failing = 'M0-05-console';
    const pids = [];
    // (a finished worker's window closes by itself 20 s after it is done; 1 s here, and the test waits for it)
    const windows = { NEXTLEVEL_WORKER_WINDOW: undefined, NEXTLEVEL_WINDOW_CLOSE_S: '1' };
    try {
      p.setConfig((c) => ({ ...c, workers: { ...c.workers, window: 'visible' } }));
      // A worker whose engine fails before it writes a report: its window stays open for the owner to read. (Not a
      // time limit: with the tests' grace of 0 the hub's own stop comes at once and kills the window.)
      p.spec(failing, fileExists('console.txt'));
      p.hub(['dispatch', failing]);
      p.runUntilIdle([], { extraEnv: { ...windows, STUB_AGY_FAIL: 'Error: the service is currently unavailable' } });
      const run = JSON.parse(fs.readFileSync(p.jobFile(failing, 'run.json'), 'utf8'));
      pids.push(run.pid);
      assert.notEqual(run.exitCode, 0, JSON.stringify(run));
      assert.equal(p.status(failing).state, 'failed');
      // Then one that finishes
      p.spec(ok, fileExists('console.txt'));
      p.hub(['dispatch', ok]);
      const r = p.runUntilIdle([], { extraEnv: windows });
      assert.equal(p.status(ok).state, 'done', r.out);
      assert.equal(p.status(ok).windowMode, 'visible');
      assert.match(fs.readFileSync(p.jobFile(ok, 'RESULT.md'), 'utf8'), /Console: tty[\s\S]*In window: visible/);
      assert.match(fs.readFileSync(p.jobFile(ok, 'worker.log'), 'utf8'), /"event":"result"/, 'its output is in worker.log as well as in its window');
      const done = JSON.parse(fs.readFileSync(p.jobFile(ok, 'run.json'), 'utf8')).pid;
      pids.push(done);
      // Its window closes by itself; the failed one, open since before it started, is still waiting for Enter
      await waitUntil("the finished worker's window to close by itself", () => !isAlive(done));
      if (!isAlive(run.pid)) {
        // Only where its log proves the machine can't do it: a console with no keyboard input can't wait for Enter
        const log = fs.readFileSync(p.jobFile(failing, 'worker.log'), 'utf8');
        if (/\(This window closed: its input ended \(no keyboard here\)\.\)/.test(log)) return t.skip("this machine's new consoles have no keyboard input, so a window can't wait for Enter (its worker.log says so)");
        assert.fail(`the window of a failed worker waits for Enter; its worker.log ends:\n${log.trim().split('\n').slice(-3).join('\n')}`);
      }
    } finally {
      for (const pid of pids) if (pid && isAlive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      p.cleanup();
    }
  },
);

test("a worker that doesn't start ends its attempt within a minute as a setup problem, never left running; its retry is the same attempt (FR-010)", () => {
  const p = makeProject();
  const id = 'M1-01-ok';
  try {
    p.spec(id, fileExists('ok.mjs'));
    p.hub(['dispatch', id]);
    // A hub started it 90 s ago and stopped before its worker wrote run.json (a console host that never ran it, say)
    const queued = JSON.parse(fs.readFileSync(p.state('queue', `${id}.json`), 'utf8'));
    fs.rmSync(p.state('queue', `${id}.json`));
    const at = new Date(Date.now() - 90_000).toISOString();
    fs.mkdirSync(path.dirname(p.jobFile(id, 'job.json')), { recursive: true });
    fs.writeFileSync(p.jobFile(id, 'job.json'), JSON.stringify(queued));
    fs.writeFileSync(p.jobFile(id, 'status.json'), JSON.stringify({ id, type: 'task', kind: 'code', state: 'running', slot: 1, attempt: 1, startedAt: at, launch: { mode: 'background', token: 'gone', at } }));
    const r = p.runUntilIdle();
    const s = p.status(id);
    assert.deepEqual([s.state, s.notStarted], ['error', true], r.out);
    assert.match(s.error, /^the worker didn't start: no sign of the worker \d+ s after it was started\. A setup problem on this PC, not the task's: nothing ran, and `nextlevel retry M1-01-ok` runs attempt 1 again$/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /M1-01-ok: the worker didn't start: no sign of the worker/);
    // Home (and the phone) say it is a setup problem, not a task that failed
    const alerts = taskAlerts([s]);
    assert.deepEqual(alerts.map((x) => x.kind), ['start']);
    assert.match(alerts[0].text, /^M1-01-ok's worker didn't start: a setup problem on this PC, not the task's \(the worker didn't start: no sign/);
    // A start of it that comes late does nothing: its token is no longer the job's
    spawnSync(process.execPath, [BIN, '_run', id], { cwd: p.repo, env: withEnv(p.env, { NEXTLEVEL_ROOT: p.repo, NEXTLEVEL_LAUNCH: 'gone' }), encoding: 'utf8', timeout: 60_000 });
    assert.ok(!fs.existsSync(p.jobFile(id, 'run.json')), 'the late start ran nothing');
    // Its retry is the same attempt again, and needs no feedback: nothing ran
    const again = p.hub(['retry', id]);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /queued M1-01-ok \(attempt 1,/);
    p.runUntilIdle();
    assert.deepEqual([p.status(id).state, p.status(id).attempt, p.status(id).notStarted], ['done', 1, null]);
    assert.deepEqual(taskAlerts([p.status(id)]), []);
  } finally {
    p.cleanup();
  }
});

test("an Antigravity worker starts without the owner's own add-ons: as the agent written into its slot, never committed, and without agy's updater (FR-011, FR-013)", () => {
  const p = makeProject();
  const id = 'M0-08-console';
  try {
    p.spec(id, fileExists('console.txt'));
    p.hub(['dispatch', id]);
    const r = p.runUntilIdle([], { extraEnv: { NEXTLEVEL_WORKER_WINDOW: undefined } });
    assert.equal(p.status(id).state, 'done', r.out);
    const report = fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
    assert.match(report, /^Add-ons: agent nextlevel-worker: customizations false, mcp false$/m, 'agy found the agent the worker was started as');
    assert.match(report, /^Reads AGENTS\.md: told to$/m, "without its customizations it wouldn't get the project's AGENTS.md");
    assert.match(report, /^Agy updater: off$/m);
    assert.match(fs.readFileSync(p.jobFile(id, 'worker.log'), 'utf8'), /Without your own add-ons \(workers\.addons in nextlevel\.json can keep some\): --agent nextlevel-worker/);
    // The agent's file is the hub's, not the task's: in the slot, never in a commit
    const committed = p.git('log', '--name-only', '--format=', `main..task/${id}`);
    assert.doesNotMatch(committed, /nextlevel-worker/, committed);
    assert.match(committed, /console\.txt/);
    // workers.addons keeps all of it: agy's own agent, with everything
    const all = 'M0-09-console';
    p.setConfig((c) => ({ ...c, workers: { ...c.workers, addons: { mcpServers: ['rafter'], skills: true, hooks: true } } }));
    p.spec(all, fileExists('console.txt'));
    p.hub(['dispatch', all]);
    p.runUntilIdle([], { extraEnv: { NEXTLEVEL_WORKER_WINDOW: undefined } });
    assert.match(fs.readFileSync(p.jobFile(all, 'RESULT.md'), 'utf8'), /^Add-ons: all \(the default agent\)$/m);
  } finally {
    p.cleanup();
  }
});

test('a worker whose processes are gone without a report was stopped from outside: not an attempt, and Home and the phone point at the antivirus (FR-013)', async () => {
  const p = makeProject();
  const id = 'M1-03-ok';
  try {
    p.spec(id, fileExists('ok.mjs'));
    p.hub(['dispatch', id]);
    // A worker the hub started two minutes ago, whose processes (its own and agy's) an antivirus has since killed
    const gone = () => {
      const c = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8', windowsHide: true });
      return Number(c.stdout);
    };
    const queued = JSON.parse(fs.readFileSync(p.state('queue', `${id}.json`), 'utf8'));
    fs.rmSync(p.state('queue', `${id}.json`));
    const at = new Date(Date.now() - 120_000).toISOString();
    fs.mkdirSync(path.dirname(p.jobFile(id, 'job.json')), { recursive: true });
    fs.writeFileSync(p.jobFile(id, 'job.json'), JSON.stringify(queued));
    fs.writeFileSync(p.jobFile(id, 'status.json'), JSON.stringify({ id, type: 'task', kind: 'code', state: 'running', slot: 1, attempt: 1, engine: 'agy', startedAt: at, windowMode: 'console', launch: { mode: 'console', token: 't', at } }));
    fs.writeFileSync(p.jobFile(id, 'run.json'), JSON.stringify({ pid: gone(), enginePid: gone(), startedAt: at }));
    const r = p.runUntilIdle();
    const s = p.status(id);
    assert.deepEqual([s.state, s.stoppedOutside, s.attempt], ['stopped', true, 1], r.out);
    assert.match(s.error, /^stopped from outside: its worker's processes are gone and it left no report\. An antivirus is a likely cause\. Look at your antivirus's notifications and quarantine \(Bitdefender: .*nextlevel doctor lists tool files that are missing\. It doesn't count as an attempt: nextlevel retry M1-03-ok runs it again$/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /M1-03-ok: stopped from outside \(its worker's processes are gone and it left no report\): not counted as an attempt; an antivirus is a likely cause/);
    // The status line and Home say it in words; Home's card opens Setup, where tool.files lists what is gone
    assert.match(p.hub(['status']).out, /M1-03-ok +w1 Stopped from outside · /);
    // (FR-020: kept with its attempt, and not counted)
    assert.equal(s.missing, "its worker's processes vanished (stopped from outside)");
    assert.deepEqual(s.attempts.map((a) => [a.attempt, a.notCounted]), [[1, 'stopped from outside']]);
    const alerts = taskAlerts([s]);
    assert.deepEqual(alerts.map((x) => x.kind), ['outside']);
    assert.match(alerts[0].text, /^M1-03-ok was stopped from outside: its worker's processes are gone/);
    const need = ownerNeeds({ active: [], queued: [], review: [], waiting: [], milestones: [], hub: { running: true }, autopilot: { on: false }, alerts }).find((n) => n.kind === 'task');
    assert.deepEqual([need.level, need.action.page, need.more.page], ['error', 'setup', 'build']);
    // Its retry is the same attempt again, and needs no feedback
    const again = p.hub(['retry', id]);
    assert.match(again.out, /queued M1-03-ok \(attempt 1,/, again.out);
    p.runUntilIdle();
    assert.deepEqual([p.status(id).state, p.status(id).attempt, p.status(id).stoppedOutside ?? null], ['done', 1, null]);
  } finally {
    p.cleanup();
  }
});

// ---------- a worker stopped from outside: what it left running, and its slot (FR-013) ----------
const readJsonFile = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const hubLog = (p) => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
const heldSlots = (p) => readJsonFile(p.state('settings.json'))?.heldSlots || {};
// A task "running" in slot `slot`, started two minutes ago by a hub before this one, with run.json as `run` says
function fakeRunning(p, id, slot, run) {
  p.spec(id, fileExists('ok.mjs'));
  p.hub(['dispatch', id]);
  const queued = JSON.parse(fs.readFileSync(p.state('queue', `${id}.json`), 'utf8'));
  fs.rmSync(p.state('queue', `${id}.json`));
  const at = new Date(Date.now() - 120_000).toISOString();
  fs.writeFileSync(p.jobFile(id, 'job.json'), JSON.stringify(queued));
  fs.writeFileSync(p.jobFile(id, 'status.json'), JSON.stringify({ id, type: 'task', kind: 'code', state: 'running', slot, attempt: 1, engine: 'agy', startedAt: at, windowMode: 'console', launch: { mode: 'console', token: 't', at } }));
  fs.writeFileSync(p.jobFile(id, 'run.json'), JSON.stringify({ startedAt: at, ...run }));
}
// A program that runs two minutes, as an engine or another program; a pid that nothing has any more
const longRunning = () => spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true });
const gonePid = () => spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;

test("stopped from outside: the hub stops the engine of a worker it started at once, without a listing, and its slot takes no task until nothing the worker started runs there (FR-013)", async () => {
  const p = makeProject();
  const id = 'M1-09-orphan';
  const kept = [];
  let bg;
  try {
    p.spec(id, fileExists('ok.mjs'));
    // (on Claude Code: no console needed, so the hub's own child is the worker's process on every OS)
    const spec = path.join(p.repo, 'docs', 'tasks', `${id}.md`);
    fs.writeFileSync(spec, fs.readFileSync(spec, 'utf8').replace('Engine: agy', 'Engine: claude'));
    p.hub(['dispatch', id]);
    // The listing of processes never answers in time here: what the hub holds must be enough to stop the engine
    bg = p.hubInBackground(['run', '--tick-ms', '200'], { NEXTLEVEL_PROCESS_LIST_MS: '0' });
    const pidsFile = path.join(`${p.repo}.slots`, 'w1', '.nextlevel-task', 'PIDS.json');
    await waitUntil('the worker and its engine', () => readJsonFile(pidsFile) && readJsonFile(p.jobFile(id, 'run.json'))?.enginePid);
    const { engine, tool } = readJsonFile(pidsFile);
    kept.push(engine, tool);
    const run = readJsonFile(p.jobFile(id, 'run.json'));
    assert.equal(run.enginePid, engine, "the engine is the worker's own child: a .cmd shim's program starts without cmd.exe");
    // An antivirus kills the worker's process alone
    process.kill(run.pid, 'SIGKILL');
    await waitUntil('the engine to be stopped', () => !isAlive(engine), 10_000);
    await waitUntil('the task to be stopped from outside', () => p.status(id).state === 'stopped', 20_000);
    assert.equal(p.status(id).stoppedOutside, true);
    const log = hubLog(p);
    assert.match(log, new RegExp(`${id}: its worker's process \\(pid ${run.pid}\\) ended without finishing.*; slot w1 is held until nothing it started runs there`));
    assert.match(log, /slot w1 stays held: (Windows \(PowerShell\)|ps) didn't list the processes within 0 s, so whether what M1-09-orphan's worker started still runs there isn't known yet; asked again in 1 min/);
    // What the engine started: on Windows outside Node's job, so only the listing finds it; elsewhere in the worker's
    // process group, stopped with it
    if (process.platform === 'win32') assert.ok(isAlive(tool), 'what the engine started waits for the listing');
    else await waitUntil('the process group to be stopped', () => !isAlive(tool), 10_000);
    // The held slot takes no task: the next one starts in w2
    p.spec('M1-10-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-10-ok']);
    await waitUntil('M1-10-ok', () => fs.existsSync(p.jobFile('M1-10-ok', 'status.json')) && p.status('M1-10-ok').state === 'done');
    assert.equal(p.status('M1-10-ok').slot, 2);
    assert.match(p.hub(['status']).out, /held slot {2}w1: no task starts there while what M1-09-orphan's stopped worker started may run · (Windows \(PowerShell\)|ps) didn't list the processes within 0 s; asked again at /);
    fs.writeFileSync(p.state('hub-stop.json'), '{}');
    await waitUntil('the hub to stop', () => bg.exitCode !== null);
    // A hub that starts looks once more, with a listing that answers: what the engine started is found under the engine
    // that is gone, stopped, and the slot is free
    for (let i = 0; i < 3 && heldSlots(p)[1]; i++) p.runUntilIdle();
    assert.deepEqual(heldSlots(p), {}, hubLog(p));
    assert.ok(!isAlive(tool));
    if (process.platform === 'win32') assert.match(hubLog(p), new RegExp(`${id}: stopped what its worker left running in slot w1: node\\.exe \\(pid ${tool}\\)`));
    assert.match(hubLog(p), new RegExp(`slot w1 is free again: nothing ${id}'s worker started runs there`));
  } finally {
    if (bg?.exitCode === null) bg.kill();
    for (const pid of kept) if (isAlive(pid)) process.kill(pid);
    p.cleanup();
  }
});

test("stopped from outside, from an earlier hub run: its engine is stopped when its start time matches; a program that got a pid since is left alone (FR-013)", async () => {
  const p = makeProject();
  const engine = longRunning();
  const other = longRunning();
  try {
    fakeRunning(p, 'M1-07-ok', 1, { pid: gonePid(), enginePid: engine.pid, engineAt: new Date().toISOString() });
    // (its engine's pid went to a program started after it)
    fakeRunning(p, 'M1-08-ok', 2, { pid: gonePid(), enginePid: other.pid, engineAt: new Date(Date.now() - 600_000).toISOString() });
    // (a late listing is asked again; a hub that starts asks at once)
    for (let i = 0; i < 3 && (i === 0 || Object.keys(heldSlots(p)).length); i++) p.runUntilIdle();
    assert.deepEqual([p.status('M1-07-ok').state, p.status('M1-08-ok').state], ['stopped', 'stopped']);
    assert.deepEqual(heldSlots(p), {}, 'both slots are free again');
    await waitUntil('the engine to be stopped', () => !isAlive(engine.pid), 5000);
    assert.ok(isAlive(other.pid), 'a program that got the pid later is left alone');
    const log = hubLog(p);
    assert.match(log, new RegExp(`M1-07-ok: stopped what its worker left running in slot w1: [^\\n]*\\(pid ${engine.pid}\\)`));
    assert.match(log, new RegExp(`M1-08-ok: pid ${other.pid} is no longer its engine \\(another program has it now\\): left alone`));
    assert.doesNotMatch(log, new RegExp(`stopped what its worker left running in slot w2`));
  } finally {
    for (const c of [engine, other]) if (isAlive(c.pid)) c.kill();
    p.cleanup();
  }
});

test('a slot the hub cannot make sure of stays out of use: asked again when late, then a card on Home, and Check again frees it (FR-013)', async () => {
  const p = makeProject();
  const id = 'M1-11-ok';
  const engine = longRunning();
  try {
    fakeRunning(p, id, 1, { pid: gonePid(), enginePid: engine.pid, engineAt: new Date().toISOString() });
    const late = { extraEnv: { NEXTLEVEL_PROCESS_LIST_MS: '0' } };
    p.runUntilIdle([], late);
    assert.equal(p.status(id).state, 'stopped');
    assert.deepEqual([heldSlots(p)[1]?.state, heldSlots(p)[1]?.tries], ['waiting', 1]);
    assert.ok(isAlive(engine.pid), "not known to be its engine yet: it isn't guessed at");
    // Each hub start asks once more; the third late answer is the last
    p.runUntilIdle([], late);
    assert.deepEqual([heldSlots(p)[1]?.state, heldSlots(p)[1]?.tries], ['waiting', 2]);
    assert.match(hubLog(p), /slot w1 stays held: .*; asked again in 5 min/);
    p.runUntilIdle([], late);
    const held = heldSlots(p)[1];
    assert.deepEqual([held?.state, held?.tries], ['failed', 3]);
    // Home's card, with Check again; the status and the hub's log say it
    const view = JSON.parse(p.hub(['status', '--json']).out).heldSlots;
    assert.deepEqual(view.map((h) => [h.slot, h.id, h.state]), [[1, id, 'failed']]);
    assert.match(view[0].text, /^Slot w1 is kept out of use: M1-11-ok's worker was stopped and (Windows \(PowerShell\)|ps) didn't list the processes within 0 s\. Close what it started \(Task Manager, or restart the PC\), then Check again on Home; tasks start in the other slots meanwhile$/);
    const card = ownerNeeds({ active: [], queued: [], review: [], waiting: [], milestones: [], hub: { running: true }, autopilot: { on: false }, heldSlots: view }).find((n) => n.kind === 'slot');
    assert.deepEqual([card.level, card.text, card.action], ['error', view[0].text, { label: 'Check again', post: '/api/slot', body: { slot: 1 } }]);
    assert.match(p.hub(['status']).out, /held slot {2}w1: .* couldn't be freed: .*; Check again on Home/);
    assert.equal(hubLog(p).split('Slot w1 is kept out of use').length - 1, 1, 'said once');
    // The owner's Check again (the dashboard's, as api.checkSlot does it), with a listing that answers
    const settings = readJsonFile(p.state('settings.json'));
    fs.writeFileSync(p.state('settings.json'), JSON.stringify({ ...settings, heldSlots: { 1: { ...held, again: new Date().toISOString() } } }));
    for (let i = 0; i < 3 && heldSlots(p)[1]; i++) p.runUntilIdle();
    assert.deepEqual(heldSlots(p), {}, hubLog(p));
    await waitUntil('the engine to be stopped', () => !isAlive(engine.pid), 5000);
  } finally {
    if (isAlive(engine.pid)) engine.kill();
    p.cleanup();
  }
});

test("dispatch pauses while a file a worker needs is gone (a quarantine), says so, and goes on by itself once it's back (FR-013)", async () => {
  const p = makeProject();
  const id = 'M1-04-ok';
  const stub = path.join(p.bin, process.platform === 'win32' ? 'agy.cmd' : 'agy');
  let bg;
  try {
    p.spec(id, fileExists('ok.mjs')); // (its spec says Engine: agy, so no automatic fallback takes it elsewhere)
    p.hub(['dispatch', id]);
    fs.renameSync(stub, `${stub}.quarantined`);
    bg = p.hubInBackground(['run', '--tick-ms', '200']);
    const until = async (what, ok, ms = 30_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (ok()) return;
      assert.fail(`waited ${ms / 1000} s for ${what}`);
    };
    const settings = () => (fs.existsSync(p.state('settings.json')) ? p.settings() : {});
    await until('dispatch to pause', () => settings().dispatchPaused);
    await hubRounds(p, 3); // a few more rounds: it stays queued, and is said once
    assert.equal(p.status(id).state, 'queued', 'the task waits instead of failing');
    assert.deepEqual(settings().dispatchPaused.files, ["Antigravity's program (agy)"]);
    // Home's card: an error, which opens Setup (tool.files says how to put it back)
    const card = ownerNeeds({ active: [], queued: [{ id }], review: [], waiting: [], milestones: [], hub: { running: true }, autopilot: { on: false }, dispatchPaused: settings().dispatchPaused }).find((n) => n.kind === 'dispatch');
    assert.deepEqual([card.level, card.action.page], ['error', 'setup']);
    assert.match(card.text, /^Dispatch is paused: a file a worker needs is missing \(Antigravity's program \(agy\)\)\. An antivirus may have quarantined it: restore from its quarantine; tasks start again by themselves once the files are back\.$/);
    const hubLog = () => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    assert.equal((hubLog().match(/Dispatch is paused: a file a worker needs is missing \(Antigravity's program \(agy\)\)\. An antivirus may have quarantined it\./g) || []).length, 1, hubLog());
    fs.renameSync(`${stub}.quarantined`, stub);
    await until('the task to run once the file is back', () => p.status(id).state === 'done', 60_000);
    assert.equal(settings().dispatchPaused, null);
    assert.match(hubLog(), /dispatch goes on: the files it waited for are back/);
  } finally {
    if (bg) {
      fs.writeFileSync(p.state('hub-stop.json'), '{}');
      await new Promise((resolve) => (bg.exitCode !== null ? resolve() : bg.once('exit', resolve)));
    }
    if (fs.existsSync(`${stub}.quarantined`)) fs.renameSync(`${stub}.quarantined`, stub);
    p.cleanup();
  }
});

test('autopilot wakes the orchestrator for finished work, once: a round that found nothing new starts no other (FR-019)', () => {
  const p = makeProject();
  try {
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-01-ok']);
    p.runUntilIdle();
    // The task ended while autopilot was off: turning it on, the hub starts one round for it
    p.runUntilIdle(['--autopilot']);
    assert.equal(p.status('M1-01-ok').acked, true, 'the orchestrator cycle should have reviewed the job');
    assert.match(p.git('log', '-1', '--format=%s'), /orchestrator cycle/);
    const log = () => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    assert.equal((log().match(/autopilot: a round starts because/g) || []).length, 1, log());
    assert.match(log(), /autopilot: a round starts because task M1-01-ok ended \(done, attempt 1\)/);
    assert.match(log(), /autopilot: cycle ended \(exit 0, nothing real happened\)/, 'its own commit is no progress');

    // Another task's end: one round again (the old hub paused after three rounds "without progress"; now nothing timed
    // starts one, so there is nothing to pause)
    p.spec('M1-03-blocked', 'node -e "process.exit(0)"');
    p.hub(['dispatch', 'M1-03-blocked']);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_MODE: 'noop' } });
    assert.equal((log().match(/autopilot: a round starts because/g) || []).length, 2, log());
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_MODE: 'noop' } });
    assert.equal((log().match(/autopilot: a round starts because/g) || []).length, 2, 'nothing new: no round');
    assert.equal(p.settings().pausedReason ?? null, null);
  } finally {
    p.cleanup();
  }
});

test('bridge test passes when workers try to push and nothing arrives, then cleans up after itself', async () => {
  const p = makeProject();
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  try {
    for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await sleep(200);
    const r = p.hub(['bridge-test', '--timeout', '2'], { timeout: 150_000 });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Bridge works/, r.out);
    assert.match(r.out, /Workers can't push: they tried, and nothing arrived at the test remote/);
    // The stub worker isn't stopped by a deny-list: its push ran, and git refused it
    assert.match(r.out, /T000-bridge-1: done .*push attempt: RAN/);
    assert.match(r.out, /own safety rules didn't stop the push command/);
    assert.equal(p.git('branch', '--list', 'task/*'), '');
    assert.ok(!fs.existsSync(path.join(p.repo, 'docs', 'tasks', 'T000-bridge-1.md')));
    assert.equal(p.git('remote'), 'origin', 'the test remote is removed from the project');
    assert.ok(!fs.existsSync(p.state('bridge-remote.git')));
    assert.match(r.out, /Workers aren't signed in to GitHub: gh auth status answered as no one/);
    // The doctor shows the verdict (bridge.test), per worker engine: the workers' fallback (Codex) needs its own
    assert.match(p.hub(['doctor']).out, /!! +Bridge test +Antigravity workers: passed on \d{4}-\d\d-\d\d \(agy 1\.2\.4 \(stub\)\): workers tried to push and nothing arrived, and gh answered as no one; Codex workers \(the workers' fallback\): not run yet/);
  } finally {
    bg.kill();
    await processesGone([bg.pid]);
    p.cleanup();
  }
});

test('bridge test fails and keeps the evidence when a worker gets a push through', async () => {
  const p = makeProject();
  // The stub worker pushes the way it's told, then gets its branch into the test remote another way
  const bg = p.hubInBackground(['run', '--tick-ms', '200'], { STUB_AGY_BRIDGE: 'leak' });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await sleep(200);
    const r = p.hub(['bridge-test', '--timeout', '2'], { timeout: 150_000 });
    assert.notEqual(r.code, 0, r.out);
    assert.match(r.out, /Bridge test FAILED: a worker's push arrived at the test remote \(refs\/heads\/leaked-T000-bridge-1/, r.out);
    assert.doesNotMatch(r.out, /Bridge works|Workers can't push/);
    // Nothing is cleaned up: the job records, branches, task specs and the test remote stay for a look
    for (const id of ['T000-bridge-1', 'T000-bridge-2']) {
      assert.match(fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8'), /Push attempt: RAN/);
      assert.equal(p.status(id).state, 'done');
      assert.ok(fs.existsSync(path.join(p.repo, 'docs', 'tasks', `${id}.md`)));
    }
    assert.match(p.git('branch', '--list', 'task/*'), /task\/T000-bridge-1[\s\S]*task\/T000-bridge-2/);
    assert.match(p.git('--git-dir', p.state('bridge-remote.git'), 'for-each-ref'), /leaked-T000-bridge-1/);
    const doctor = p.hub(['doctor']);
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /!! +Bridge test +Antigravity workers: FAILED on .*: a worker's push arrived at the test remote/);
  } finally {
    bg.kill();
    await processesGone([bg.pid]);
    p.cleanup();
  }
});

test('nextlevel.json sets the slots, the task folder and the worker model', () => {
  const p = makeProject();
  try {
    p.setConfig((c) => ({
      ...c,
      workers: { ...c.workers, slots: 1 },
      roles: { ...c.roles, worker: { engine: 'agy', model: 'stub-pro' } },
      paths: { ...c.paths, tasks: 'work/tasks' },
    }));
    for (const id of ['M1-01-ok', 'M1-06-ok']) {
      p.spec(id, fileExists('ok.mjs'), { dir: 'work/tasks' });
      assert.equal(p.hub(['dispatch', id]).code, 0);
    }
    p.runUntilIdle();
    for (const id of ['M1-01-ok', 'M1-06-ok']) {
      assert.equal(p.status(id).state, 'done');
      assert.equal(p.status(id).slot, 1, 'with one slot, every task runs in w1');
      const report = fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
      assert.match(report, /Model: stub-pro/);
      assert.match(report, /Task folder: \.nextlevel-task/);
    }
  } finally {
    p.cleanup();
  }
});

test('workers see no .env values and no project root; slots get their names and ports', () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.repo, '.env'), 'NTFY_TOPIC=\nPLANTED_SECRET=hunter2\n');
    // The verify command runs in the slot too, and must not see the secret either
    p.spec('M1-07-console', 'node -e "process.exit(process.env.PLANTED_SECRET ? 1 : 0)"');
    p.hub(['dispatch', 'M1-07-console']);
    const r = p.runUntilIdle();
    const s = p.status('M1-07-console');
    assert.equal(s.state, 'done', r.out);
    assert.equal(s.verify, 'pass');
    const report = fs.readFileSync(p.jobFile('M1-07-console', 'RESULT.md'), 'utf8');
    assert.match(report, /Planted secret: hidden/);
    assert.match(report, /Project root: hidden/);
    assert.match(report, /Slot: 1 · compose proj_w1/);

    // A hub started by another nextlevel (START.cmd -> 4, the dashboard's Start button) inherits the .env
    // values that one loaded: they are still .env values, and workers still don't see them
    p.spec('M1-08-console', 'node -e "process.exit(process.env.PLANTED_SECRET ? 1 : 0)"');
    p.hub(['dispatch', 'M1-08-console']);
    const inherited = p.runUntilIdle([], { extraEnv: { PLANTED_SECRET: 'hunter2' } });
    assert.equal(p.status('M1-08-console').verify, 'pass', inherited.out);
    assert.match(fs.readFileSync(p.jobFile('M1-08-console', 'RESULT.md'), 'utf8'), /Planted secret: hidden/);

    // The read-only GitHub token of verify commands (FR-017) never reaches a worker, in .env or set anywhere else
    fs.appendFileSync(path.join(p.repo, '.env'), 'NEXTLEVEL_GITHUB_READ_TOKEN=made-up-read-token-in-env\n');
    p.spec('M1-09-console', 'node -e "process.exit(process.env.NEXTLEVEL_GITHUB_READ_TOKEN || /read-token/.test(process.env.GH_TOKEN || \'\') ? 1 : 0)"');
    p.hub(['dispatch', 'M1-09-console']);
    const token = p.runUntilIdle([], { extraEnv: { NEXTLEVEL_GITHUB_READ_TOKEN: 'made-up-read-token-from-the-window' } });
    assert.equal(p.status('M1-09-console').verify, 'pass', token.out);
  } finally {
    p.cleanup();
  }
});

test('a project without nextlevel.json keeps its settings in .env working', () => {
  const p = makeProject();
  try {
    // A project set up before nextlevel.json: settings in .env
    fs.rmSync(path.join(p.repo, 'nextlevel.json'));
    fs.writeFileSync(path.join(p.repo, '.env'), 'NEXTLEVEL_WORKER_SLOTS=1\nAGY_MODEL=legacy-model\nNEXTLEVEL_KILL_GRACE_MIN=0\n');
    for (const id of ['M1-01-ok', 'M1-06-ok']) {
      p.spec(id, fileExists('ok.mjs'));
      assert.equal(p.hub(['dispatch', id]).code, 0);
    }
    p.runUntilIdle();
    for (const id of ['M1-01-ok', 'M1-06-ok']) {
      const s = JSON.parse(fs.readFileSync(path.join(p.state(), 'jobs', id, 'status.json'), 'utf8'));
      assert.equal(s.state, 'done');
      assert.equal(s.slot, 1, 'NEXTLEVEL_WORKER_SLOTS=1 still applies');
      const report = fs.readFileSync(path.join(p.state(), 'jobs', id, 'RESULT.md'), 'utf8');
      assert.match(report, /Model: legacy-model/);
      assert.match(report, /Task folder: \.nextlevel-task/);
    }
    const doctor = p.hub(['doctor']);
    assert.match(doctor.out, /!! +Settings in \.env +NEXTLEVEL_WORKER_SLOTS, AGY_MODEL, NEXTLEVEL_KILL_GRACE_MIN/);
    assert.match(doctor.out, /!! +nextlevel\.json +missing/);
  } finally {
    p.cleanup();
  }
});

// Starts the hub in the background and waits for its heartbeat; stop() ends it.
async function startHub(p, extraEnv = {}) {
  const bg = p.hubInBackground(['run', '--tick-ms', '200'], extraEnv);
  for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await sleep(200);
  return {
    async stop() {
      bg.kill();
      for (let i = 0; i < 25 && isAlive(bg.pid); i++) await sleep(200);
      fs.rmSync(p.state('hub.json'), { force: true });
    },
  };
}

test("the orchestrator's git writes go through the hub (FR-004 #1): commit, merge, a conflict undone, cleanup", async () => {
  const p = makeProject();
  const hub = await startHub(p);
  try {
    // commit: the hub runs git, no shell sees the message, and only the paths given are committed
    fs.mkdirSync(path.join(p.repo, 'docs', 'plans'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, 'docs', 'plans', 'M1.md'), '# M1\n');
    fs.writeFileSync(path.join(p.repo, 'scratch.txt'), 'not part of the plan\n');
    const message = 'plan: M1 "tasks" & 100% ready';
    const c = p.hub(['commit', '-m', message, 'docs/plans']);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /commit-\S+: done · committed [0-9a-f]+ plan: M1/);
    assert.equal(p.git('log', '-1', '--format=%s'), message);
    assert.equal(p.git('status', '--porcelain'), '?? scratch.txt');
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /commit-\S+: git commit -q -F /, 'the hub logs the git commands it runs');
    assert.match(p.hub(['commit', '-m', 'again', 'docs/plans']).out, /done · nothing to commit/);
    // The same folder by another name (a link here; on Windows also a short name like RUNNER~1)
    fs.symlinkSync(p.repo, path.join(p.tmp, 'link'), 'junction');
    fs.writeFileSync(path.join(p.repo, 'docs', 'plans', 'M2.md'), '# M2\n');
    assert.match(p.hub(['commit', '-m', 'plan: M2', path.join(p.tmp, 'link', 'docs', 'plans', 'M2.md')]).out, /done · committed [0-9a-f]+ plan: M2/);
    assert.match(p.hub(['status']).out, /no jobs waiting, running or to review/, 'the command saw the result: nothing is left to review');
    assert.notEqual(p.hub(['commit', 'docs/plans']).code, 0, 'a commit needs a message');
    assert.match(p.hub(['commit', '-m', 'x', path.join(p.tmp, 'elsewhere')]).out, /outside the project/);

    // two tasks from the same commit; merging both makes a conflict once main changed the same file
    p.spec('M1-02-fail', 'node -e "0"');
    p.spec('M1-09-fail', 'node -e "0"');
    assert.equal(p.hub(['commit', '-m', 'tasks']).code, 0, 'without paths: every change');
    assert.equal(p.git('status', '--porcelain'), '');
    for (const id of ['M1-02-fail', 'M1-09-fail']) p.hub(['dispatch', id]);
    for (const id of ['M1-02-fail', 'M1-09-fail']) assert.equal(p.hub(['wait', id, '--minutes', '2']).code, 0);
    assert.match(p.hub(['merge', 'M1-02-fail']).out, /done · merged task\/M1-02-fail \(1 commit\(s\)\) into main/);
    assert.match(p.git('log', '-1', '--format=%s'), /Merge branch 'task\/M1-02-fail'/);
    fs.writeFileSync(path.join(p.repo, 'fail.txt'), "main's version\n");
    assert.equal(p.hub(['commit', '-m', 'main changes fail.txt']).code, 0);
    const head = p.git('rev-parse', 'HEAD');
    const conflict = p.hub(['merge', 'M1-09-fail']);
    assert.equal(conflict.code, 1, conflict.out);
    assert.match(conflict.out, /conflicts in fail\.txt: the merge was undone and main is unchanged\. Next: nextlevel retry M1-09-fail --feedback "merge main into your branch first/);
    assert.equal(p.git('rev-parse', 'HEAD'), head);
    assert.equal(p.git('status', '--porcelain'), '', 'no merge left half-done');
    fs.writeFileSync(path.join(p.repo, 'fail.txt'), 'edited, not committed\n');
    assert.match(p.hub(['merge', 'M1-09-fail']).out, /uncommitted changes in the main checkout are in the way \(fail\.txt\): commit them first/);
    p.git('checkout', '--', 'fail.txt');

    // cleanup: a merged branch goes; an unmerged one only with --discard
    assert.match(p.hub(['cleanup', 'M1-02-fail']).out, /done · deleted task\/M1-02-fail/);
    assert.equal(p.status('M1-02-fail').cleaned, true);
    const unmerged = p.hub(['cleanup', 'M1-09-fail']);
    assert.equal(unmerged.code, 1);
    assert.match(unmerged.out, /task\/M1-09-fail is not merged into main: merge it \(nextlevel merge M1-09-fail\), or throw the work away/);
    assert.equal(p.hub(['cleanup', 'M1-09-fail', '--discard']).code, 0);
    assert.equal(p.git('branch', '--list', 'task/*'), '');
    assert.match(p.hub(['merge', 'M1-09-fail']).out, /there is no branch task\/M1-09-fail \(cleaned up already\)/);
  } finally {
    await hub.stop();
    p.cleanup();
  }
  // Without a hub nothing is queued: a commit that runs hours later would take whatever is there then
  const q = makeProject();
  try {
    const r = q.hub(['commit', '-m', 'x']);
    assert.equal(r.code, 2);
    assert.match(r.out, /The hub is not running, so nothing was queued/);
    assert.ok(!fs.existsSync(q.state('queue')) || fs.readdirSync(q.state('queue')).length === 0);
  } finally {
    q.cleanup();
  }
});

test("under Codex the hub's heartbeat is enough: its Linux sandbox hides other processes (FR-004)", () => {
  const p = makeProject();
  try {
    const gone = spawnSync(process.execPath, ['-e', '0']).pid; // a process that has ended
    fs.mkdirSync(p.state(), { recursive: true });
    fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: gone, heartbeatAt: new Date().toISOString() }));
    assert.match(p.hub(['status']).out, /^Hub: stopped/m);
    assert.match(p.hub(['status'], { extraEnv: { CODEX_THREAD_ID: 't1' } }).out, /^Hub: running/m);
    fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: gone, heartbeatAt: new Date(Date.now() - 120_000).toISOString() }));
    assert.match(p.hub(['status'], { extraEnv: { CODEX_THREAD_ID: 't1' } }).out, /^Hub: stopped/m, 'an old heartbeat is a stopped hub');
  } finally {
    p.cleanup();
  }
});

test('a check or git job that was running when the hub stopped is marked lost at the next start', () => {
  const p = makeProject();
  try {
    fs.mkdirSync(p.state('jobs', 'commit-x'), { recursive: true });
    fs.writeFileSync(p.jobFile('commit-x', 'status.json'), JSON.stringify({ id: 'commit-x', type: 'git', state: 'running' }));
    p.runUntilIdle();
    assert.equal(p.status('commit-x').state, 'lost');
    assert.match(p.status('commit-x').error, /the hub stopped while it ran/);
  } finally {
    p.cleanup();
  }
});

test('worker slots get port offsets no other project on this PC has (FR-004 #7)', () => {
  const a = makeProject();
  const b = makeProject({ box: a, dir: 'other' });
  try {
    const offsets = (p) => {
      p.spec('M1-01-ok', fileExists('ok.mjs'));
      p.hub(['dispatch', 'M1-01-ok']);
      const r = p.runUntilIdle();
      assert.equal(p.status('M1-01-ok').state, 'done', r.out);
      const job = JSON.parse(fs.readFileSync(path.join(`${p.repo}.slots`, 'w1', '.nextlevel-task', 'JOB.json'), 'utf8'));
      const env = fs.readFileSync(p.jobFile('M1-01-ok', 'worker.log'), 'utf8').match(/offset=(\d+)/)[1];
      assert.equal(String(job.portOffset), env, 'JOB.json and the environment agree');
      return { offset: job.portOffset, hubLog: r.out };
    };
    const first = offsets(a);
    assert.equal(first.offset, 100, 'the first project keeps the ports it always had');
    const second = offsets(b);
    assert.equal(second.offset, 1100);
    assert.match(second.hubLog, /slot port offsets 1100, 1200/);
    assert.equal(offsets(a).offset, 100, 'a project keeps its block');
    assert.match(b.hub(['doctor']).out, /Slot ports +NEXTLEVEL_PORT_OFFSET 1100, 1200 \(no other project on this PC has them\)/);
  } finally {
    a.cleanup();
  }
});

test('an interactive orchestrator that stopped with finished jobs to review gets the owner a nudge (FR-004 #8)', () => {
  const p = makeProject();
  try {
    // It is told to keep going (_orch is what the orchestrator's window runs; on Windows `orchestrator` opens one)
    const orch = p.nextlevel(['_orch'], { cwd: p.repo, extraEnv: { NEXTLEVEL_ROOT: p.repo } });
    assert.match(orch.out, /\[fake codex\] interactive: ROLE: ORCHESTRATOR, interactive session\. .*Keep going until something needs the owner/);
    assert.match(fs.readFileSync(path.join(p.repo, 'docs', 'agents', 'ORCHESTRATOR.md'), 'utf8'), /## Interactive sessions/);

    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-01-ok']);
    p.runUntilIdle();
    const f = p.jobFile('M1-01-ok', 'status.json');
    fs.writeFileSync(f, JSON.stringify({ ...p.status('M1-01-ok'), finishedAt: new Date(Date.now() - 20 * 60_000).toISOString() }));
    fs.writeFileSync(p.state('orchestrator.json'), JSON.stringify({ mode: 'interactive', pid: process.pid, startedAt: new Date().toISOString() }));
    const r = p.runUntilIdle();
    assert.match(r.out, /\[notify\] NTFY_TOPIC not set, skipped: proj: the orchestrator stopped/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /left 1 finished job\(s\) unreviewed for 15\+ min/);
    assert.doesNotMatch(p.runUntilIdle().out, /the orchestrator stopped/, 'once per set of jobs');
  } finally {
    p.cleanup();
  }
});

test("Codex in the orchestrator's window runs without its shared background server, whose helpers opened a window per command; an older Codex without the flag gets none (FR-011)", () => {
  const p = makeProject();
  try {
    const log = path.join(p.tmp, 'codex-args.jsonl');
    const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((a) => a.at(-1)?.startsWith?.('ROLE: ORCHESTRATOR'));
    let orch = p.nextlevel(['_orch'], { cwd: p.repo, extraEnv: { NEXTLEVEL_ROOT: p.repo, STUB_CODEX_LOG: log } });
    assert.match(orch.out, /\[fake codex\] interactive: ROLE: ORCHESTRATOR/, orch.out);
    assert.deepEqual(calls().at(-1).slice(0, -1), ['--sandbox', 'workspace-write', '--no-daemon'], 'the flag, not a -c: nothing else about the session changes');
    orch = p.nextlevel(['_orch'], { cwd: p.repo, extraEnv: { NEXTLEVEL_ROOT: p.repo, STUB_CODEX_LOG: log, STUB_CODEX_NO_DAEMON_FLAG: '0' } });
    assert.match(orch.out, /\[fake codex\] interactive: ROLE: ORCHESTRATOR/, `a Codex that doesn't know it isn't given it: ${orch.out}`);
    assert.deepEqual(calls().at(-1).slice(0, -1), ['--sandbox', 'workspace-write']);
  } finally {
    p.cleanup();
  }
});

test("inside Codex's sandbox the doctor says so and doesn't report what it can't see; the hub runs it outside (FR-004 #2)", () => {
  const p = makeProject();
  try {
    // As on the owner's PC: in there, gh looked signed out (here: it gets a token that doesn't work)
    const inside = { CODEX_THREAD_ID: 'thread-1', CODEX_SANDBOX_NETWORK_DISABLED: '1', GH_TOKEN: 'what-the-sandbox-sees' };
    const r = p.hub(['doctor'], { extraEnv: inside });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /!! +Sandbox +running inside Codex's sandbox \(no network: CODEX_SANDBOX_NETWORK_DISABLED\)/);
    assert.match(r.out, /-- +GitHub sign-in +can't tell inside Codex's sandbox \(there: not signed in\)/);
    assert.match(r.out, /-- +Codex model +not checked inside Codex's sandbox/);
    assert.doesNotMatch(r.out, /gh auth login/, "nobody is told to sign in again");
    assert.match(p.hub(['doctor'], { extraEnv: { GH_TOKEN: 'what-the-sandbox-sees' } }).out, /!! +GitHub sign-in +not signed in/, 'outside, a real sign-out is still reported');

    // The hub won't start in there; the orchestrator runs the doctor through the hub instead
    const hub = p.hub(['run', '--exit-when-idle'], { extraEnv: inside });
    assert.equal(hub.code, 1);
    assert.match(hub.out, /The hub can't run inside Codex's sandbox/);
    const id = p.hub(['verify', 'doctor', '--', 'nextlevel doctor'], { extraEnv: inside }).out.match(/queued (\S+):/)[1];
    p.runUntilIdle();
    const result = p.hub(['result', id]);
    assert.equal(p.status(id).state, 'passed', result.out);
    // (the doctor's whole output, as the hub ran it: `result` shows only its last lines within the output budget, FR-012)
    const log = fs.readFileSync(p.jobFile(id, 'check.log'), 'utf8');
    assert.match(log, / ok +GitHub sign-in +signed in/);
    assert.doesNotMatch(log, /Sandbox/);
    assert.doesNotMatch(result.out, /Sandbox/);
  } finally {
    p.cleanup();
  }
});

test('Codex runs without -c overrides; the doctor takes them out of an older nextlevel.json (FR-004 #6)', () => {
  const p = makeProject();
  try {
    assert.deepEqual(p.config().engines.codex.args, ['--sandbox', 'workspace-write'], 'new projects get none');
    p.setConfig((c) => ({ ...c, engines: { ...c.engines, codex: { args: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'] } } }));
    assert.match(p.hub(['doctor']).out, /!! +Codex overrides +engines\.codex\.args override Codex's settings \(-c sandbox_workspace_write\.network_access=true\)/);
    const fix = p.hub(['doctor', '--fix', 'codex.args']);
    assert.match(fix.out, /Removed -c sandbox_workspace_write\.network_access=true from engines\.codex\.args in .*nextlevel\.json/);
    assert.deepEqual(p.config().engines.codex.args, ['--sandbox', 'workspace-write']);
    assert.equal(p.config().workers.slots, 2, 'the rest of the file stays');

    const log = path.join(p.tmp, 'codex-args.log');
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-01-ok']);
    p.runUntilIdle();
    p.runUntilIdle(['--autopilot'], { extraEnv: { STUB_CODEX_LOG: log } });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const cycle = calls.find((a) => a[0] === 'exec' && a.at(-1).includes('autopilot cycle'));
    assert.deepEqual(cycle.slice(0, 3), ['exec', '--sandbox', 'workspace-write']);
    assert.ok(!calls.flat().includes('-c'), JSON.stringify(calls));
  } finally {
    p.cleanup();
  }
});

// ---------- FR-008: the hub's git around workers whose sandbox can't write it ----------
const inSlot = (p, id, ...args) => spawnSync('git', args, { cwd: path.join(`${p.repo}.slots`, `w${p.status(id).slot}`), encoding: 'utf8' });

test("a Codex worker's git is the hub's (FR-008): main merged in before its retry, the conflict resolved by the worker and committed by the hub", () => {
  const p = makeProject();
  const id = 'M8-01-merge';
  try {
    p.spec(id, fileExists('shared.txt'));
    p.hub(['dispatch', id]);
    p.runUntilIdle();
    assert.equal(p.status(id).state, 'done');
    // main moves on, and changes the file the task changed
    fs.writeFileSync(path.join(p.repo, 'shared.txt'), 'from main\n');
    fs.writeFileSync(path.join(p.repo, 'main-only.txt'), 'main\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'main: shared.txt');
    // The orchestrator escalates to Codex, whose sandbox can't write the slot's git (ORIG_HEAD.lock: Permission denied)
    const retry = p.hub(['retry', id, '--engine', 'codex', '--feedback', 'Merge main into your branch first, then finish the task.']);
    assert.match(retry.out, /on Codex: retry with --engine codex/);
    assert.match(retry.out, /Codex's sandbox can't write git in its slot: the hub merges main into task\/M8-01-merge before it starts and commits what it leaves/);
    const r = p.runUntilIdle();
    const s = p.status(id);
    assert.equal(s.state, 'done', r.out);
    assert.deepEqual([s.merge.result, s.merge.files, s.merge.resolved], ['conflicts', ['shared.txt'], true]);
    const report = fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
    assert.match(report, /Git by the hub: told/, 'the prompt tells it not to run git writes');
    assert.match(report, /Conflicts: shared\.txt \(1 with markers\)/, 'TASK.md named the file, and the slot had the conflict in it');
    // The hub committed the merge with the worker's resolution: main is in the task branch now
    assert.equal(p.git('show', `task/${id}:shared.txt`), 'resolved by the worker');
    assert.equal(p.git('show', `task/${id}:main-only.txt`), 'main');
    assert.equal(p.git('show', `task/${id}:retry.txt`), 'attempt 2');
    p.git('merge-base', '--is-ancestor', 'main', `task/${id}`);
    assert.equal(p.git('rev-list', '--parents', '-n', '1', `task/${id}`).split(' ').length, 3, 'a merge commit');
    const message = p.git('log', '-1', '--format=%s%n%b', `task/${id}`);
    assert.match(message, /^Merge main into task\/M8-01-merge; conflicts resolved by the worker \(attempt 2\)/);
    assert.match(message, /feat\(merge\): attempt 2 on top of main/, "the worker's Commit: line");
    // Every git command the hub ran for it is logged
    const gitLog = fs.readFileSync(p.jobFile(id, 'git.log'), 'utf8');
    assert.match(gitLog, /\$ git merge --no-ff --no-edit -m Merge main into task\/M8-01-merge \(the hub, before attempt 2\) main/);
    assert.match(gitLog, /\$ git commit -q -F /);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /M8-01-merge: the hub merged main in first: conflicts in 1 file\(s\) \(shared\.txt\): the worker resolves them/);
    const result = p.hub(['result', id]).out;
    assert.match(result, /the hub merged main in first: conflicts in 1 file\(s\), resolved/);
    assert.match(result, /engine: Codex, retry with --engine codex/);
    assert.match(result, /the hub committed what the worker left: [0-9a-f]{7}/);
    assert.equal(inSlot(p, id, 'status', '--porcelain').stdout.trim(), '', 'the slot is left clean');
    // Home lists it among the engine switches, with why
    const switches = JSON.parse(fs.readFileSync(p.state('switches.json'), 'utf8'));
    assert.deepEqual(switches.map((x) => [x.kind, x.id, x.attempt, x.engine, x.roleEngine, x.how, x.why]), [['task', id, 2, 'codex', 'agy', 'asked', 'retry with --engine codex']]);
  } finally {
    p.cleanup();
  }
});

test('conflicts a worker leaves are never committed; an engine that writes git gets main merged in only when the feedback asks (FR-008)', () => {
  const p = makeProject();
  try {
    const id = 'M8-02-merge';
    p.spec(id, fileExists('shared.txt'));
    p.hub(['dispatch', id]);
    p.runUntilIdle();
    fs.writeFileSync(path.join(p.repo, 'shared.txt'), 'from main\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'main: shared.txt');
    const head = p.git('rev-parse', `task/${id}`);
    // On Codex main is merged in at every retry, asked or not; this worker leaves the conflict as it is
    p.hub(['retry', id, '--engine', 'codex', '--feedback', 'Finish it.']);
    const r = p.runUntilIdle([], { extraEnv: { STUB_LEAVE_CONFLICTS: '1' } });
    const s = p.status(id);
    assert.equal(s.state, 'failed', r.out);
    assert.equal(s.verify, 'skipped');
    assert.match(s.detail, /^conflict markers are still in shared\.txt after the merge of main: nothing was committed \(the worker's changes are in \.nextlevel.jobs.M8-02-merge.unresolved\.diff\)$/);
    assert.match(p.hub(['status']).out, /the hub merged main in first: conflicts in 1 file\(s\) left unresolved/);
    assert.equal(p.git('rev-parse', `task/${id}`), head, 'nothing with markers is committed');
    assert.match(fs.readFileSync(p.jobFile(id, 'unresolved.diff'), 'utf8'), /retry\.txt/);
    assert.notEqual(inSlot(p, id, 'rev-parse', '-q', '--verify', 'MERGE_HEAD').status, 0, 'no merge left half-done in the slot');

    // Antigravity writes git itself: main comes in only when the feedback asks for it
    const other = 'M8-03-merge';
    p.spec(other, fileExists('shared.txt'));
    p.hub(['dispatch', other]);
    p.runUntilIdle();
    fs.writeFileSync(path.join(p.repo, 'other.txt'), 'main\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'main: other.txt');
    p.hub(['retry', other, '--feedback', 'Add the retry file.']);
    p.runUntilIdle();
    assert.equal(p.status(other).state, 'done');
    assert.equal(p.status(other).merge, null);
    assert.match(fs.readFileSync(p.jobFile(other, 'RESULT.md'), 'utf8'), /Merge: no merge/);
    assert.throws(() => p.git('merge-base', '--is-ancestor', 'main', `task/${other}`));
    p.hub(['retry', other, '--feedback', 'Merge main into your branch first.']);
    p.runUntilIdle();
    const s3 = p.status(other);
    assert.equal(s3.state, 'done');
    assert.deepEqual([s3.merge.result, s3.merge.commits], ['merged', 1]);
    assert.match(fs.readFileSync(p.jobFile(other, 'RESULT.md'), 'utf8'), /Merge: merged main in\n[\s\S]*Git by the hub: not told/);
    p.git('merge-base', '--is-ancestor', 'main', `task/${other}`);
    assert.match(p.hub(['result', other]).out, /done · verify pass · worker says DONE · \d commit\(s\) this attempt, \d in all · the hub merged main in first/);
  } finally {
    p.cleanup();
  }
});
