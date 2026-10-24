// Git's index lock and the hub (src/lib/gitlock.mjs): the race in which the dashboard's `git status` held a slot's
// index.lock while the hub ran `git add -A` for a worker, so the worker's changes weren't committed. Reproduced by
// holding the lock at that moment; the dashboard's side is in dashboard.test.mjs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { LOCK_WAIT_MS, lockHeld, lockNote, lockWaitMs, readEnv, retryOnLock, retryOnLockAsync } from '../src/lib/gitlock.mjs';
import { fileExists, makeProject, sleep } from './helpers.mjs';

const hubLog = (p) => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');

test('a held index.lock: its command runs again for a while, only for that, and it is told in any language', async () => {
  const held = { ok: false, out: "fatal: Unable to create 'C:/p/.git/worktrees/w1/index.lock': File exists." };
  // git's messages are in the owner's language; the lock's path is in them as it is
  assert.ok(lockHeld("fatal: Konnte '/p/.git/index.lock' nicht erstellen: Datei existiert."));
  assert.ok(!lockHeld("error: pathspec 'x' did not match any file(s) known to git"));
  let t = 0;
  const clock = () => t;
  const sleepFor = (ms) => {
    t += ms;
  };
  let n = 0;
  const r = retryOnLock(() => (++n < 3 ? held : { ok: true, out: '' }), { clock, sleep: sleepFor, waitMs: 10_000 });
  assert.deepEqual([r.ok, r.tries, r.waited, r.lockHeld], [true, 3, 400, false]);
  // any other failure is final at once
  n = 0;
  const other = retryOnLock(() => (n++, { ok: false, out: 'fatal: bad revision' }), { clock, sleep: sleepFor });
  assert.deepEqual([other.ok, other.tries, n], [false, 1, 1]);
  // a lock that stays: given up after the wait, and said
  t = 0;
  const stuck = retryOnLock(() => held, { clock, sleep: sleepFor, waitMs: 1000 });
  assert.deepEqual([stuck.ok, stuck.lockHeld, stuck.waited], [false, true, 1000]);
  assert.match(lockNote(stuck), /git's index\.lock was held for 1 s: another git runs there, or one that stopped left it behind/);
  assert.equal(lockNote(r), '');
  // what git printed on stderr counts too (`text`), not only stdout
  t = 0;
  n = 0;
  assert.equal(retryOnLock(() => (++n < 2 ? { ok: false, out: '', text: held.out } : { ok: true, out: 'x' }), { clock, sleep: sleepFor }).tries, 2);
  // the orchestrator's git jobs run asynchronously
  t = 0;
  n = 0;
  const a = await retryOnLockAsync(async () => (++n < 2 ? held : { ok: true, out: '' }), { clock, sleep: async (ms) => sleepFor(ms) });
  assert.deepEqual([a.ok, a.tries], [true, 2]);
  assert.equal(lockWaitMs({}), LOCK_WAIT_MS);
  assert.equal(lockWaitMs({ NEXTLEVEL_GIT_LOCK_WAIT_MS: '1500' }), 1500);
  assert.equal(lockWaitMs({ NEXTLEVEL_GIT_LOCK_WAIT_MS: 'soon' }), LOCK_WAIT_MS);
  // reads never take an optional lock
  assert.deepEqual(readEnv({ A: '1' }), { A: '1', GIT_OPTIONAL_LOCKS: '0' });
});

test("the race: another git holds the slot's index.lock while the hub commits a worker's changes; the hub waits and commits them", () => {
  const p = makeProject();
  try {
    p.spec('M1-01-indexlock', fileExists('locked.mjs'));
    // Codex can't commit in its sandbox: the hub commits what it left (FR-008). The stub holds the slot's
    // index.lock from its end until the hub's git.log shows a git that found it held.
    p.hub(['dispatch', 'M1-01-indexlock', '--engine', 'codex']);
    const r = p.runUntilIdle();
    const s = p.status('M1-01-indexlock');
    assert.equal(s.state, 'done', `${s.detail || ''}\n${r.out}`);
    assert.equal(s.commits, 1);
    assert.match(p.git('log', '--format=%s', 'main..task/M1-01-indexlock'), /^feat: locked$/);
    assert.match(p.git('show', 'task/M1-01-indexlock:locked.mjs'), /export const x = 1;/);
    // It met the lock and waited: git.log has the try that found it held, then the one that went through
    const gitLog = fs.readFileSync(p.jobFile('M1-01-indexlock', 'git.log'), 'utf8');
    const adds = gitLog.split('\n$ ').filter((b) => b.startsWith('git add -A'));
    assert.ok(adds.length >= 2, gitLog);
    assert.match(adds[0], /index\.lock/);
    assert.match(adds.at(-1), /\[exit 0\]/);
    assert.match(gitLog, /\$ git commit -q -F .*\n\[exit 0\]/);
    assert.match(hubLog(p), /M1-01-indexlock: git add in slot w\d found index\.lock held; it went through after \d+\.\d s/);
  } finally {
    p.cleanup();
  }
});

test('a lock that never goes: the attempt fails, says why, and the worker\'s changes are kept beside the job', () => {
  const p = makeProject();
  try {
    p.spec('M1-02-indexlock', fileExists('locked.mjs'));
    p.hub(['dispatch', 'M1-02-indexlock', '--engine', 'codex']);
    // The stub keeps the lock until the task has finished; the hub waits 1.5 s for it here (10 s by default)
    p.runUntilIdle([], { extraEnv: { STUB_INDEX_LOCK: 'hold', NEXTLEVEL_GIT_LOCK_WAIT_MS: '1500' } });
    const s = p.status('M1-02-indexlock');
    assert.equal(s.state, 'failed');
    assert.match(s.detail, /^the hub couldn't stage the worker's changes: .+ \(git's index\.lock was held for \d+ s: another git runs there, or one that stopped left it behind\) \(see git\.log\)\. Its changes are kept in \.nextlevel[\\/]jobs[\\/]M1-02-indexlock[\\/]left[\\/]attempt-1 \(1 file\(s\)\)\.$/);
    assert.equal(fs.readFileSync(p.jobFile('M1-02-indexlock', path.join('left', 'attempt-1', 'locked.mjs')), 'utf8'), 'export const x = 1;\n');
    assert.equal(p.git('log', '--oneline', 'main..task/M1-02-indexlock'), '', 'nothing was committed, and nothing says otherwise');
    assert.match(hubLog(p), /M1-02-indexlock: git add in slot w\d found index\.lock held; still held after \d+\.\d s/);
  } finally {
    p.cleanup();
  }
});

test("the orchestrator's commit in the main checkout waits for a held index.lock too", async () => {
  const p = makeProject();
  let hub;
  const lock = path.join(p.repo, '.git', 'index.lock');
  try {
    hub = p.hubInBackground(['run', '--tick-ms', '200']);
    for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await sleep(200);
    fs.writeFileSync(path.join(p.repo, 'plan.md'), '# plan\n');
    fs.writeFileSync(lock, '');
    // Another git (the owner's editor, say) holds the main checkout's lock until the hub's git job has met it
    const jobs = p.state('jobs');
    const holder = `
      const fs = require('node:fs'), path = require('node:path');
      const [lock, jobs] = process.argv.slice(1);
      const met = () => { try { return fs.readdirSync(jobs).some((d) => { try { return fs.readFileSync(path.join(jobs, d, 'git.log'), 'utf8').includes('index.lock'); } catch { return false; } }); } catch { return false; } };
      const start = Date.now();
      const tick = () => (met() || Date.now() - start > 60000 ? fs.rmSync(lock, { force: true }) : setTimeout(tick, 100));
      tick();`;
    spawn(process.execPath, ['-e', holder, lock, jobs], { cwd: path.parse(lock).root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
    const c = p.hub(['commit', '-m', 'plan: M1', 'plan.md']);
    assert.equal(c.code, 0, c.out);
    assert.match(c.out, /commit-\S+: done · committed [0-9a-f]+ plan: M1/);
    assert.equal(p.git('log', '-1', '--format=%s'), 'plan: M1');
    assert.match(hubLog(p), /commit-\S+: git add found index\.lock held; it went through after \d+\.\d s/);
  } finally {
    fs.rmSync(lock, { force: true });
    if (hub) {
      fs.writeFileSync(p.state('hub-stop.json'), '{}');
      for (let i = 0; i < 50 && hub.exitCode === null; i++) await sleep(200);
      hub.kill();
    }
    p.cleanup();
  }
});
