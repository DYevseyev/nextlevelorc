// Workers' own arguments (engines.<engine>.workerArgs) and Codex workers on Windows: what every worker task on an engine
// starts with, however it was chosen, while the orchestrator, the setup guide and autopilot rounds keep engines.<engine>.args;
// a Codex worker without its sandbox commits itself; every worker gets a gh folder with no sign-in and, on Codex, the hub's
// variables and PowerShell's policy for its process; the bridge test keeps a verdict per engine, with the arguments it ran with.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { NO_GH_CONFIG, workerEnv, workerRun } from '../src/lib/workerspec.mjs';
import { defaults, loadConfig, workerArgsOf } from '../src/lib/config.mjs';
import { codexWorkerArgs } from '../src/lib/team.mjs';
import { codexWritesGit } from '../src/engines/codex.mjs';
import { fileExists, makeProject, processesGone, sleep } from './helpers.mjs';

const OFF = ['--sandbox', 'danger-full-access', '-c', 'approval_policy=never'];
const SANDBOX = ['--sandbox', 'workspace-write'];
// A task spec with no Engine: line (the workers' role decides), or one naming an engine
function spec(p, id, { engine = '' } = {}) {
  fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
  fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', `${id}.md`), `# ${id} — test\n\nKind: code\n${engine ? `Engine: ${engine}\n` : ''}\n## Goal\nTest.\n\n## Verify\n\`\`\`sh\n${fileExists('ok.mjs')}\n\`\`\`\n`);
}
const calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const workerCall = (list, id) => list.find((a) => a[0] === 'exec' && a.at(-1).includes(`ROLE: WORKER. Task ${id}.`));
const report = (p, id) => fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');

test('workers.args: unset, workers get args; set, [] means none; anything else is refused', () => {
  const cfg = defaults('p');
  assert.equal(cfg.engines.codex.workerArgs, null);
  assert.deepEqual(workerArgsOf(cfg, 'codex'), SANDBOX, 'not set: the engine\'s args, as before');
  const load = (engines) => loadConfig('/proj', { raw: { engines }, env: {} }).config;
  assert.deepEqual(workerArgsOf(load({ codex: { workerArgs: OFF } }), 'codex'), OFF);
  assert.deepEqual(workerArgsOf(load({ codex: { workerArgs: [] } }), 'codex'), [], '[]: workers get no arguments at all');
  assert.deepEqual(workerArgsOf(load({ codex: { workerArgs: null } }), 'codex'), SANDBOX);
  assert.throws(() => load({ codex: { workerArgs: '--sandbox danger-full-access' } }), /"engines\.codex\.workerArgs" must be a list of arguments/);
  assert.deepEqual(load({ codex: { workerArgs: OFF } }).engines.codex.args, SANDBOX, 'args stay the orchestrator\'s');
  // The switch: the rest of args copied as it is, its own sandbox flags in place of theirs; --full-auto (an older Codex's
  // workspace-write sandbox, which won over --sandbox) is taken out, and counts as the sandbox wherever it is
  const args = ['--full-auto', '-m', 'gpt-6-mini', '-s', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=false'];
  assert.deepEqual(codexWorkerArgs(load({ codex: { args } }), false), [...OFF, '-m', 'gpt-6-mini']);
  assert.deepEqual(codexWorkerArgs(load({ codex: { args } }), true), ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true', '-m', 'gpt-6-mini']);
  assert.equal(codexWritesGit(['--full-auto', '--sandbox', 'danger-full-access']), false);
  assert.equal(codexWritesGit(OFF), true);
});

test("workers' own arguments reach every worker task on the engine (the workers, their fallback, --engine, --profile, a retry), never an autopilot round or the orchestrator's window", () => {
  const p = makeProject();
  const log = path.join(p.tmp, 'codex-args.log');
  try {
    p.setConfig((c) => ({ ...c, profiles: { 'codex-small': { engine: 'codex', model: 'gpt-6-mini', effort: 'low' } }, engines: { ...c.engines, codex: { args: SANDBOX, workerArgs: OFF } } }));
    // The workers' own engine (Antigravity), with Codex as the fallback (a new project's), --engine codex and --profile
    spec(p, 'M1-01-engine-ok');
    spec(p, 'M1-02-profile-ok');
    spec(p, 'M1-03-spec-ok', { engine: 'codex' });
    spec(p, 'M1-04-fallback-ok');
    assert.equal(p.hub(['dispatch', 'M1-01-engine-ok', '--engine', 'codex']).code, 0);
    assert.equal(p.hub(['dispatch', 'M1-02-profile-ok', '--profile', 'codex-small']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    assert.equal(p.hub(['dispatch', 'M1-03-spec-ok']).code, 0);
    assert.equal(p.hub(['dispatch', 'M1-04-fallback-ok', '--fallback']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    assert.equal(p.status('M1-01-engine-ok').state, 'done', 'committed by the worker itself');
    // A retry keeps the earlier attempt's engine (this stub worker has nothing new to commit then: only its arguments count)
    assert.equal(p.hub(['retry', 'M1-01-engine-ok', '--feedback', 'again']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    // The workers' role itself on Codex
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { ...c.roles.worker, engine: 'codex' } } }));
    spec(p, 'M1-05-role-ok');
    assert.equal(p.hub(['dispatch', 'M1-05-role-ok']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    const list = calls(log);
    for (const id of ['M1-01-engine-ok', 'M1-02-profile-ok', 'M1-03-spec-ok', 'M1-04-fallback-ok', 'M1-05-role-ok']) {
      const args = workerCall(list, id);
      assert.ok(args, `${id} ran on Codex: ${JSON.stringify(list.map((a) => a.at(-1).slice(0, 40)))}`);
      const at = args.indexOf('--sandbox');
      assert.deepEqual(args.slice(at, at + 4), OFF, `${id}: the workers' own arguments`);
      assert.ok(!args.includes('workspace-write'), `${id}: never args`);
      assert.deepEqual(JSON.parse(fs.readFileSync(p.jobFile(id, 'job.json'), 'utf8')).resolved.args, OFF, `${id}: job.json has them`);
      // Without its sandbox a Codex worker commits itself (as Antigravity and Claude Code workers do): no git by the hub
      if (id !== 'M1-01-engine-ok') assert.equal(p.status(id).state, 'done', `${id}: ${p.status(id).detail || ''}`);
      assert.equal(p.status(id).gitByHub, false, id);
      if (id !== 'M1-01-engine-ok') assert.match(report(p, id), /Git by the hub: not told/);
    }
    const both = list.filter((x) => x.at(-1).includes('ROLE: WORKER. Task M1-01-engine-ok.'));
    assert.equal(both.length, 2);
    assert.ok(both.every((x) => x.includes('danger-full-access') && !x.includes('workspace-write')), 'the retry too');
    // An autopilot round and the orchestrator's window keep engines.codex.args
    p.runUntilIdle(['--autopilot'], { extraEnv: { STUB_CODEX_LOG: log } });
    const cycle = calls(log).find((a) => a[0] === 'exec' && a.at(-1).includes('autopilot cycle'));
    assert.ok(cycle, 'a round ran');
    assert.deepEqual(cycle.slice(cycle.indexOf('--sandbox'), cycle.indexOf('--sandbox') + 2), SANDBOX);
    assert.ok(!cycle.includes('danger-full-access') && !cycle.includes('approval_policy=never'));
    const orch = p.nextlevel(['_orch'], { cwd: p.repo, extraEnv: { NEXTLEVEL_ROOT: p.repo, STUB_CODEX_LOG: log } });
    assert.equal(orch.code, 0, orch.out);
    const window = calls(log).at(-1);
    assert.notEqual(window[0], 'exec', "the orchestrator's window");
    assert.deepEqual(window.slice(window.indexOf('--sandbox'), window.indexOf('--sandbox') + 2), SANDBOX);
    assert.ok(!window.includes('danger-full-access'));
  } finally {
    p.cleanup();
  }
});

test("without workers' own arguments a Codex worker gets engines.codex.args, as before: its sandbox, and the hub does its git", () => {
  const p = makeProject();
  const log = path.join(p.tmp, 'codex-args.log');
  try {
    spec(p, 'M2-01-sandbox-ok');
    p.hub(['dispatch', 'M2-01-sandbox-ok', '--engine', 'codex']);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    const args = workerCall(calls(log), 'M2-01-sandbox-ok');
    assert.deepEqual(args.slice(args.indexOf('--sandbox'), args.indexOf('--sandbox') + 2), SANDBOX);
    assert.equal(p.status('M2-01-sandbox-ok').state, 'done');
    assert.equal(p.status('M2-01-sandbox-ok').gitByHub, true);
    assert.match(report(p, 'M2-01-sandbox-ok'), /Git by the hub: told/);
  } finally {
    p.cleanup();
  }
});

test("every worker and verify command gets a gh folder with no sign-in (the hub's own gh doesn't), and a sign-in left there is taken out; a Codex worker keeps the hub's variables, and on Windows PowerShell's policy for its process", () => {
  // The pure part: what a worker's run is given, and what a verify command in the main checkout keeps
  const base = { PATH: 'x', GH_CONFIG_DIR: '/owner/gh' };
  for (const engine of ['codex', 'agy', 'claude']) {
    const run = workerRun({ profile: { engine }, prompt: 'P', timeoutMin: 10, env: base, platform: 'win32' });
    assert.equal(run.env.GH_CONFIG_DIR, NO_GH_CONFIG, engine);
    assert.equal(run.env.PSExecutionPolicyPreference, engine === 'codex' ? 'RemoteSigned' : undefined, engine);
  }
  assert.equal(workerRun({ profile: { engine: 'codex' }, prompt: 'P', timeoutMin: 10, env: base, platform: 'linux' }).env.PSExecutionPolicyPreference, undefined, 'only on Windows');
  assert.equal(workerEnv(base).GH_CONFIG_DIR, '/owner/gh', "the hub's own gh keeps the owner's folder");
  // A Codex worker's command line keeps the hub's variables, whatever the owner's config.toml says of them
  const codex = workerRun({ profile: { engine: 'codex' }, engineArgs: SANDBOX, prompt: 'P', timeoutMin: 10, env: base });
  for (const s of ['shell_environment_policy.inherit=all', 'shell_environment_policy.ignore_default_excludes=true', 'shell_environment_policy.exclude=[]', 'shell_environment_policy.include_only=[]']) assert.ok(codex.args.includes(s), s);

  // Through the hub: a worker on each engine sees the folder, and so does a verify command; a sign-in an earlier worker left
  // in that folder (one for every slot and project) is taken out before a task starts
  const p = makeProject();
  try {
    fs.mkdirSync(NO_GH_CONFIG, { recursive: true });
    fs.writeFileSync(path.join(NO_GH_CONFIG, 'hosts.yml'), 'github.com:\n    oauth_token: stub-owner-token\n');
    for (const [id, engine] of [['M3-01-agy-ok', 'agy'], ['M3-02-codex-ok', 'codex'], ['M3-03-claude-ok', 'claude']]) {
      spec(p, id);
      p.hub(['dispatch', id, '--engine', engine]);
    }
    p.runUntilIdle();
    p.runUntilIdle();
    for (const id of ['M3-01-agy-ok', 'M3-02-codex-ok', 'M3-03-claude-ok']) {
      assert.match(report(p, id), new RegExp(`gh folder: ${NO_GH_CONFIG.replace(/[\\.]/g, (c) => `\\${c}`)}`), id);
      assert.match(report(p, id), process.platform === 'win32' && id === 'M3-02-codex-ok' ? /PowerShell policy: RemoteSigned/ : /PowerShell policy: none/, id);
    }
    assert.ok(!fs.existsSync(path.join(NO_GH_CONFIG, 'hosts.yml')), 'the sign-in left there is gone');
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /removed .*hosts\.yml: gh's folder for workers holds no sign-in/);
    const q = p.hub(['verify', 'ghdir', '--', 'node', '-e', "console.log('GHDIR=' + (process.env.GH_CONFIG_DIR || 'none'))"]);
    const id = q.out.match(/queued (\S+):/)[1];
    p.runUntilIdle();
    assert.ok(fs.readFileSync(p.jobFile(id, 'check.log'), 'utf8').includes(`GHDIR=${NO_GH_CONFIG}`), 'a verify command gets it too');
  } finally {
    p.cleanup();
  }
});

test('the bridge test per engine: Codex workers out of their sandbox are tested with their own arguments, beside the Antigravity verdict; a worker whose gh answers as the owner fails it', async () => {
  const p = makeProject();
  p.setConfig((c) => ({ ...c, engines: { ...c.engines, codex: { args: SANDBOX, workerArgs: OFF } } }));
  let bg = p.hubInBackground(['run', '--tick-ms', '200']);
  try {
    for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await sleep(200);
    const agy = p.hub(['bridge-test', '--timeout', '2'], { timeout: 150_000 });
    assert.equal(agy.code, 0, agy.out);
    const codex = p.hub(['bridge-test', '--engine', 'codex', '--timeout', '2'], { timeout: 150_000 });
    assert.equal(codex.code, 0, codex.out);
    assert.match(codex.out, /Bridge works: the orchestrator can hand work to codex workers/);
    assert.match(codex.out, /T000-bridge-1: done .*push attempt: RAN .*GitHub sign-in: NONE/);
    const kept = (e) => JSON.parse(fs.readFileSync(p.state('bridge-tests', `${e}.json`), 'utf8'));
    assert.deepEqual([kept('codex').result, kept('codex').workerArgs, kept('codex').gh], ['passed', OFF, 'none']);
    assert.equal(kept('agy').result, 'passed', "the Codex run keeps Antigravity's verdict");
    // bridge-test.json stays as an older nextlevel reads it: the last run
    assert.equal(JSON.parse(fs.readFileSync(p.state('bridge-test.json'), 'utf8')).engine, 'codex');
    assert.match(p.hub(['doctor']).out, /ok +Bridge test +Antigravity workers: passed .*; Codex workers \(the workers' fallback\): passed .*gh answered as no one/);
    // An agent's session can't move them (the owner's choice, FR-017); the owner can
    const agent = p.hub(['team', 'sandbox', 'on'], { extraEnv: { NEXTLEVEL_AGENT: 'orchestrator' } });
    assert.equal(agent.code, 1, agent.out);
    assert.match(agent.out, /nextlevel team sandbox on is the owner's, so it doesn't run in an agent's session \(this is the orchestrator's window\): nothing was done/);
    assert.deepEqual(p.config().engines.codex.workerArgs, OFF);
    // Codex workers back in their sandbox: other arguments, so the doctor asks for the test again
    assert.equal(p.hub(['team', 'sandbox', 'on']).code, 0);
    assert.match(p.hub(['doctor']).out, /Codex workers \(the workers' fallback\): passed on \S+ \(codex codex-cli 0\.152\.0 \(stub\)\) with other worker arguments/);

    // A gh that finds the owner's login anyway: the test fails, as for a push that arrived
    bg.kill();
    await processesGone([bg.pid]);
    bg = p.hubInBackground(['run', '--tick-ms', '200'], { STUB_GH_IGNORE_CONFIG_DIR: '1' });
    const hubPid = () => {
      try {
        return JSON.parse(fs.readFileSync(p.state('hub.json'), 'utf8')).pid;
      } catch {
        return null;
      }
    };
    for (let i = 0; i < 100 && hubPid() !== bg.pid; i++) await sleep(200);
    const leak = p.hub(['bridge-test', '--timeout', '2'], { timeout: 150_000 });
    assert.notEqual(leak.code, 0, leak.out);
    assert.match(leak.out, /Bridge test FAILED: a worker's gh answered as owner \(github\.com\)/, leak.out);
    assert.equal(kept('agy').result, 'signed-in');
    assert.match(p.hub(['doctor']).out, /Antigravity workers: FAILED on \S+: a worker's gh answered as owner \(github\.com\)/);
  } finally {
    bg.kill();
    await processesGone([bg.pid]);
    p.cleanup();
  }
});

test("upgrading with only an older nextlevel's verdict (bridge-test.json, Antigravity): a Codex bridge test keeps it, and the doctor still counts it for Antigravity", async () => {
  const p = makeProject();
  // The shape a verdict had before they were kept per engine: no workerArgs, no gh
  const old = { at: new Date().toISOString(), result: 'passed', reason: '', engine: 'agy', profile: '', engineVersion: '1.2.4 (stub)', claims: { 'T000-bridge-1': 'RAN', 'T000-bridge-2': 'RAN' }, refs: [] };
  fs.mkdirSync(p.state(), { recursive: true });
  fs.writeFileSync(p.state('bridge-test.json'), JSON.stringify(old));
  assert.match(p.hub(['doctor']).out, /Antigravity workers: passed .*; Codex workers \(the workers' fallback\): not run yet/);
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  try {
    for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await sleep(200);
    const codex = p.hub(['bridge-test', '--engine', 'codex', '--timeout', '2'], { timeout: 150_000 });
    assert.equal(codex.code, 0, codex.out);
    assert.deepEqual(JSON.parse(fs.readFileSync(p.state('bridge-tests', 'agy.json'), 'utf8')), old, 'moved beside the others as it was');
    assert.equal(JSON.parse(fs.readFileSync(p.state('bridge-test.json'), 'utf8')).engine, 'codex');
    assert.match(p.hub(['doctor']).out, /ok +Bridge test +Antigravity workers: passed .*; Codex workers \(the workers' fallback\): passed/);
  } finally {
    bg.kill();
    await processesGone([bg.pid]);
    p.cleanup();
  }
});
