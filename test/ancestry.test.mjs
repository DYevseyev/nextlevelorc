// FR-017 part 2B, 2B-1a: a nextlevel command that acts, run under a worker, its task's verify or a check the hub runs as
// the owner, is refused by its ancestry (docs/design/FR-017-part2B.md 3.1), whatever its environment says and whichever
// project it names. The record (agents.json in the guard's folder) is the hub's; the chain is the command's own parents
// in one snapshot (/proc on Linux).
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { addAgent, addSession, agentsHome, allRecords, ancestryRefusal, chainIn, installedTool, looksOnly, readRecord, removeAgents, underAgent } from '../src/lib/ancestry.mjs';
import { withoutTool } from '../src/lib/workerspec.mjs';
import { makeProject, makeSandbox } from './helpers.mjs';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'nextlevel.mjs');

test('which commands only look: they run under a worker; everything else, underscore commands too, acts', () => {
  for (const [cmd, rest] of [['status', []], ['result', ['X']], ['wait', ['--any']], ['usage', []], ['note', ['list']], ['handoff', ['show', 'H1']], ['doctor', ['--json']], ['version', []], ['help', []], ['dispatch', ['--help']], ['close', ['-h']]]) assert.ok(looksOnly(cmd, rest), `${cmd} ${rest.join(' ')}`);
  for (const [cmd, rest] of [[undefined, []], ['dispatch', ['X']], ['usage', ['--all-projects']], ['note', ['add']], ['handoff', ['answer', 'H1']], ['doctor', ['--fix', 'x']], ['doctor', ['--fix=x']], ['_run', ['X']], ['_update', ['u']], ['team', []], ['update', []], ['channel', ['release']], ['ui', []], ['init', []], ['notify', ['--now']], ['verify', ['v', '--', 'npm', 'test', '--help']], ['notify', ['--', 'hi', '--help']], ['commit', ['-m', 'x', '--', '-h']], ['dispatch', ['--', '--help']]]) assert.ok(!looksOnly(cmd, rest), `${cmd} ${rest.join(' ')}`);
  assert.ok(looksOnly('commit', ['-hm', 'x']), 'help is what the parser reads as help (FR-017)');
});

test("the chain of parents: each parent only if it started no later than its child; a recorded process only if it started by the record's time", () => {
  const list = [
    { pid: 1, ppid: 0, start: 0 },
    { pid: 10, ppid: 1, start: 1000 },
    { pid: 20, ppid: 10, start: 2000 },
    { pid: 30, ppid: 20, start: 3000 },
    { pid: 40, ppid: 99, start: 4000 }, // a parent that's gone
    { pid: 50, ppid: 60, start: 1000 }, // a "parent" started after it: a pid given to a later program
    { pid: 60, ppid: 1, start: 5000 },
  ];
  assert.deepEqual(chainIn(list, 30).map((p) => p.pid), [20, 10, 1]);
  assert.deepEqual(chainIn(list, 40), []);
  assert.deepEqual(chainIn(list, 50), []);
  const rec = (at) => [{ dir: 'd', agents: [{ pid: 20, kind: 'worker', task: 'T1', at: new Date(at).toISOString() }], sessions: [] }];
  assert.equal(underAgent(chainIn(list, 30), rec(2500))?.entry.task, 'T1');
  assert.equal(underAgent(chainIn(list, 30), rec(-5000)), null, 'a process that started after the record named its pid is another program');
});

test("the record's home: the OS's for an installed version, never HOME; os.homedir() for a checkout (the tests)", () => {
  assert.equal(installedTool(path.join('h', '.nextlevel', 'versions', 'v0.3.0')), true);
  assert.equal(installedTool(path.join('src', 'repo')), false);
  // the tool's clone (the store) counts as installed: run as it is (NEXTLEVEL_LAUNCHED=1), its test switches don't count
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-store-'));
  try {
    const moved = path.join(fakeHome, 'tools', 'nextlevel');
    assert.equal(installedTool(path.join(fakeHome, '.nextlevel', 'tool'), { home: fakeHome }), true);
    assert.equal(installedTool(moved, { home: fakeHome }), false);
    fs.mkdirSync(path.join(fakeHome, '.nextlevel'), { recursive: true });
    fs.writeFileSync(path.join(fakeHome, '.nextlevel', 'versions.json'), JSON.stringify({ store: moved }));
    assert.equal(installedTool(moved, { home: fakeHome }), true, "versions.json's store (NEXTLEVEL_DIR)");
  } finally {
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
  const home = process.env.HOME;
  try {
    process.env.HOME = path.join(os.tmpdir(), 'not-the-home');
    process.env.USERPROFILE = process.env.HOME;
    assert.equal(agentsHome({ installed: true }), os.userInfo().homedir);
    assert.equal(agentsHome({ installed: false }), os.homedir());
  } finally {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
  }
  assert.deepEqual(withoutTool([path.join(os.homedir(), '.nextlevel', 'bin'), '/usr/bin'].join(path.delimiter), [path.join(os.homedir(), '.nextlevel', 'bin')]), '/usr/bin');
});

test('a command under a recorded process is refused and logged, for any project; one that only looks runs; a failed listing needs a session token', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-anc-'));
  const saved = [process.env.HOME, process.env.USERPROFILE];
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  const proj = path.join(home, 'proj');
  fs.mkdirSync(proj);
  try {
    // This test's own process plays the worker's _run: what it starts runs under it
    addAgent(proj, { pid: process.pid, kind: 'worker', task: 'T7' });
    assert.equal(readRecord(proj).agents.length, 1);
    const run = (args, env = {}) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, NEXTLEVEL_NO_UPDATE: '1', ...env }, cwd: home });
    const refused = run(['--project', path.join(home, 'elsewhere'), 'dispatch', 'X']);
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /nextlevel dispatch X: refused\. This command runs under task T7's worker: workers don't ask the hub for anything/);
    const log = fs.readFileSync(path.join(allRecords(home)[0].dir, 'refused.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual([log[0].task, log[0].kind, log[0].command], ['T7', 'worker', 'dispatch']);
    // (help never acts, and says what it is; a "--help" after "--" is an argument, and refused)
    assert.equal(run(['dispatch', '--help']).status, 0);
    const dashed = run(['--project', proj, 'verify', 'v', '--', 'node', '-e', '0', '--help']);
    assert.equal(dashed.status, 1);
    assert.match(dashed.stderr, /nextlevel verify v: refused\. This command runs under task T7's worker/);
    assert.ok(!fs.existsSync(path.join(proj, '.nextlevel', 'queue')) || !fs.readdirSync(path.join(proj, '.nextlevel', 'queue')).length, 'nothing queued');
    // No listing: refused without a token, run with the orchestrator's
    const late = run(['_update', 'u1'], { NEXTLEVEL_PROCESS_LIST_MS: '0' });
    assert.match(late.stderr, /couldn't list this PC's processes \(no answer in time\) while a worker or a check runs/);
    const token = addSession(proj, { pid: process.pid, kind: 'window' });
    const own = await ancestryRefusal('dispatch', ['X'], { toolRoot: process.cwd(), env: { NEXTLEVEL_PROCESS_LIST_MS: '0', NEXTLEVEL_SESSION_TOKEN: token } });
    assert.equal(own, '');
    assert.match(await ancestryRefusal('dispatch', ['X'], { toolRoot: process.cwd(), env: { NEXTLEVEL_PROCESS_LIST_MS: '0', NEXTLEVEL_SESSION_TOKEN: 'guessed' } }), /couldn't list/);
    // A process not under it: runs (a shell started by another parent: this test's chain is its own, so record another pid)
    removeAgents(proj, () => true);
    addAgent(proj, { pid: process.ppid, kind: 'check', job: 'C1' });
    const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 30000)']);
    try {
      // the test's parent is recorded: this test's commands are under it...
      assert.match(await ancestryRefusal('commit', [], { toolRoot: process.cwd() }), /runs under a check the hub runs/);
      // ...and a process whose chain doesn't reach it isn't (the check names a pid outside the chain)
      removeAgents(proj, () => true);
      addAgent(proj, { pid: child.pid, kind: 'worker', task: 'T8' });
      assert.equal(await ancestryRefusal('commit', [], { toolRoot: process.cwd() }), '');
    } finally {
      child.kill();
    }
  } finally {
    [process.env.HOME, process.env.USERPROFILE] = saved;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("a worker that asks the hub (FR-017 part 2B): every way is refused by its ancestry, logged and flagged on its task; 'status' runs; the record empties after", () => {
  const p = makeProject();
  const id = 'P2B-01-askhub';
  try {
    p.spec(id, 'node -e "process.exit(0)"');
    p.hub(['dispatch', id]);
    const r = p.runUntilIdle();
    const s = p.status(id);
    const report = fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
    assert.match(report, /^from PATH: refused \(nextlevel wakeup 5: refused\. This command runs under task P2B-01-askhub's worker/m, report);
    assert.match(report, /^full path, variables cleared, --project main: refused \(nextlevel close NOPE-1: refused\. This command runs under task P2B-01-askhub's worker/m);
    assert.match(report, /^no listing \(NEXTLEVEL_PROCESS_LIST_MS=0\): refused \(nextlevel dispatch NOPE-2: refused\. nextlevel couldn't list/m);
    assert.match(report, /^status: WORKED/m);
    assert.equal(s.state, 'done', r.out);
    assert.deepEqual(s.refused.map((x) => x.command).sort(), ['close', 'wakeup'], 'the ones refused under the worker flag its task');
    assert.match(p.hub(['result', id, '--peek']).out, /2 nextlevel command\(s\) from its worker refused \(wakeup, close\)|2 nextlevel command\(s\) from its worker refused \(close, wakeup\)/);
    // Nothing they asked for happened
    assert.ok(!fs.existsSync(p.state('wakeup.json')));
    assert.ok(!fs.existsSync(p.state('closed.json')) || !fs.readFileSync(p.state('closed.json'), 'utf8').includes('NOPE-1'));
    assert.ok(!fs.existsSync(p.jobFile('NOPE-2', 'job.json')));
    // The attempt left the record
    const rec = allRecords(p.home || path.join(p.tmp, 'home'));
    assert.ok(rec.every((x) => !x.agents.length), JSON.stringify(rec));
  } finally {
    p.cleanup();
  }
});

test("a task's verify that asks the hub is refused, and flags the task", () => {
  const p = makeProject();
  const id = 'P2B-02-ok';
  try {
    p.spec(id, 'nextlevel close NOPE-3 --reason verify');
    p.hub(['dispatch', id]);
    p.runUntilIdle();
    const s = p.status(id);
    assert.equal(s.verify, 'fail');
    assert.deepEqual(s.refused.map((x) => [x.kind, x.command]), [['verify', 'close']]);
    assert.match(fs.readFileSync(p.jobFile(id, 'verify.log'), 'utf8'), /runs under task P2B-02-ok's verify/);
  } finally {
    p.cleanup();
  }
});
