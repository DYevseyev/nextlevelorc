// Codex workers on Windows, part B: a second worker (roles.worker.second, reached as "second"), a worker task's model and
// effort from the worker profiles on its engine (never the orchestrator's), and a task's "Needs:" line (docker, network,
// packages): refused at dispatch on a worker that can't give it, held at start, never moved there by the automatic
// fallback, and no attempt spent. NEXTLEVEL_TEST_PLATFORM plays Windows for what a Codex worker in its sandbox can't give.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { codexWorkerLacks } from '../src/engines/codex.mjs';
import { findProfile, loadConfig, profilesInUse, roleProfile, withRole } from '../src/lib/config.mjs';
import { lacks, specNeeds, workersThatCan } from '../src/lib/needs.mjs';
import { fileExists, hubRounds, makeProject, processesGone } from './helpers.mjs';

const load = (raw) => loadConfig('/proj', { raw, env: {} }).config;
// A real project's shape: the orchestrator on Codex at its strongest, workers on Antigravity, Codex as the fallback by name
const SAMPLE = { roles: { orchestrator: { engine: 'codex', model: 'gpt-6.1-sol', effort: 'xhigh' }, worker: { engine: 'agy', fallback: 'codex' } } };
const SECOND = { engine: 'codex', model: 'gpt-6-mini', effort: 'low', takes: 'no-docker' };
const withSecond = (extra = {}) => ({ ...SAMPLE, roles: { ...SAMPLE.roles, worker: { ...SAMPLE.roles.worker, second: SECOND, ...extra } } });

test('the second worker: in nextlevel.json under roles.worker.second, reached as "second", a worker marked second', () => {
  const cfg = load(withSecond());
  assert.deepEqual(findProfile(cfg, 'second'), { name: 'second', engine: 'codex', account: '', model: 'gpt-6-mini', effort: 'low', second: true, takes: 'no-docker' });
  assert.deepEqual(roleProfile(cfg, 'worker', { second: true }), findProfile(cfg, 'second'));
  assert.deepEqual(profilesInUse(cfg).filter((p) => p.role === 'worker').map((p) => [p.second, p.fallback, p.engine, p.keys.model]), [
    [false, false, 'agy', 'roles.worker.model'],
    [true, false, 'codex', 'roles.worker.second.model'],
    [false, true, 'codex', 'roles.worker.second.model'],
  ]);
  // On a profile of its own: reached as "second" too, by the profile's name
  const prof = load({ ...withSecond(), profiles: { 'codex-small': { engine: 'codex', model: 'gpt-6-mini', effort: 'low' } }, roles: { ...SAMPLE.roles, worker: { engine: 'agy', second: { profile: 'codex-small', takes: 'any' } } } });
  assert.deepEqual([findProfile(prof, 'second').name, findProfile(prof, 'second').takes], ['codex-small', 'any']);
  // None by default; no profile may be called "second"; what it takes is one of three
  assert.equal(load({}).roles.worker.second, null);
  assert.equal(findProfile(load({}), 'second'), null);
  assert.throws(() => load({ profiles: { second: { engine: 'codex' } } }), /"second" is the second worker's name/);
  assert.throws(() => load(withSecond({ second: { ...SECOND, takes: 'docker' } })), /"roles\.worker\.second\.takes" is no-docker, any or asked/);
  assert.throws(() => load(withSecond({ second: { engine: 'gemini' } })), /"roles\.worker\.second\.engine" must be/);
  // A change to the workers keeps it; the Team page's change of it keeps the rest
  const raw = withSecond();
  assert.deepEqual(withRole(raw, 'worker', { engine: 'claude', model: '', effort: '' }).roles.worker.second, SECOND);
  assert.deepEqual(withRole(raw, 'worker', { engine: 'codex', model: 'gpt-6', effort: '', takes: 'any' }, { second: true }).roles.worker, { engine: 'agy', fallback: 'codex', second: { engine: 'codex', model: 'gpt-6', effort: '', takes: 'any' } });
  assert.equal(withRole(raw, 'worker', { none: true }, { second: true }).roles.worker.second, null);
});

test("a worker task on an engine named on its own takes a worker's model and effort on that engine: the workers', then the second worker's, then a fallback's with a model of its own; never the orchestrator's", () => {
  const w = (raw) => findProfile(load(raw), 'codex', { worker: true });
  assert.deepEqual([w(withSecond()).model, w(withSecond()).effort], ['gpt-6-mini', 'low'], "the second worker's");
  assert.deepEqual([w(SAMPLE).model, w(SAMPLE).effort], ['', ''], "none: Codex's own choice, never the orchestrator's gpt-6.1-sol at xhigh");
  const fb = { ...SAMPLE, roles: { ...SAMPLE.roles, worker: { engine: 'agy', fallback: { engine: 'codex', model: 'gpt-6-luna', effort: 'medium' } } } };
  assert.deepEqual([w(fb).model, w(fb).effort], ['gpt-6-luna', 'medium'], "a fallback's with a model of its own");
  const workers = { ...SAMPLE, roles: { ...SAMPLE.roles, worker: { engine: 'codex', model: 'gpt-6', effort: 'high', second: { engine: 'codex', model: 'gpt-6-mini', effort: 'low', takes: 'any' } } } };
  assert.deepEqual([w(workers).model, w(workers).effort], ['gpt-6', 'high'], "the workers' first");
  // The workers' fallback named by its engine is a worker profile too
  assert.equal(roleProfile(load(withSecond()), 'worker', { fallback: true }).model, 'gpt-6-mini');
  // Elsewhere (the setup guide on an engine named on its own), as before: the orchestrator's counts
  assert.equal(findProfile(load(SAMPLE), 'codex').model, 'gpt-6.1-sol');
});

test('a "Needs:" line, and what a Codex worker in its sandbox can\'t give: Docker and package installs on Windows, network or not; the network without -c', () => {
  assert.deepEqual(specNeeds('# T\n\nKind: code\nNeeds: docker, network\n'), { needs: ['docker', 'network'], unknown: [] });
  assert.deepEqual(specNeeds('Needs: none\n'), { needs: [], unknown: [] });
  assert.deepEqual(specNeeds('Needs: Docker packages gpu\n'), { needs: ['docker', 'packages'], unknown: ['gpu'] });
  assert.deepEqual(specNeeds('Kind: code\n'), { needs: [], unknown: [] });
  const sandbox = ['--sandbox', 'workspace-write'];
  const net = [...sandbox, '-c', 'sandbox_workspace_write.network_access=true'];
  const all = ['docker', 'network', 'packages'];
  const needs = (platform, args) => codexWorkerLacks(all, { platform, args }).map((m) => m.need);
  assert.deepEqual(needs('win32', sandbox), ['docker', 'network', 'packages']);
  assert.deepEqual(needs('win32', net), ['docker', 'packages'], 'the network on changes neither');
  assert.deepEqual(needs('linux', sandbox), ['network', 'packages'], 'elsewhere a package install needs the network');
  assert.deepEqual(needs('linux', net), []);
  assert.deepEqual(needs('win32', ['--sandbox', 'danger-full-access', '-c', 'approval_policy=never']), [], 'out of its sandbox: all of it');
  // Through the workers' own arguments; the other engines give all of it
  const cfg = load(withSecond());
  assert.deepEqual(lacks(findProfile(cfg, 'second'), ['docker'], { config: cfg, platform: 'win32' }).map((m) => m.need), ['docker']);
  assert.deepEqual(lacks(roleProfile(cfg, 'worker'), all, { config: cfg, platform: 'win32' }), []);
  const out = load({ ...withSecond(), engines: { codex: { workerArgs: ['--sandbox', 'danger-full-access', '-c', 'approval_policy=never'] } } });
  assert.deepEqual(lacks(findProfile(out, 'second'), all, { config: out, platform: 'win32' }), []);
  assert.deepEqual(workersThatCan(['docker'], { config: cfg, platform: 'win32' }).map((c) => c.who), ['the workers']);
});

// A task spec: its kind, an Engine: or Profile: line, a Needs: line
function spec(p, id, { engine = '', profile = '', needs = '' } = {}) {
  fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
  const lines = ['Kind: code', engine && `Engine: ${engine}`, profile && `Profile: ${profile}`, needs && `Needs: ${needs}`].filter(Boolean).join('\n');
  fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', `${id}.md`), `# ${id} — test\n\n${lines}\n\n## Goal\nTest.\n\n## Verify\n\`\`\`sh\n${fileExists('ok.mjs')}\n\`\`\`\n`);
}
const calls = (log) => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const workerCalls = (list, id) => list.filter((a) => a[0] === 'exec' && a.at(-1).includes(`ROLE: WORKER. Task ${id}.`));
const arg = (a, flag) => a[a.indexOf(flag) + 1];
const effortOf = (a) => (a.find((x, i) => a[i - 1] === '-c' && x.startsWith('model_reasoning_effort=')) || '').split('=')[1] || '';

test("a worker task on Codex gets the second worker's model and effort through every path (--engine, a spec's Engine:, a retry, --fallback, --model, --profile second), never the orchestrator's", () => {
  const p = makeProject();
  const log = path.join(p.tmp, 'codex-args.log');
  try {
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { ...c.roles.orchestrator, model: 'gpt-6.1-sol', effort: 'xhigh' }, worker: { ...c.roles.worker, second: SECOND } } }));
    spec(p, 'B1-01-engine-ok');
    spec(p, 'B1-02-spec-ok', { engine: 'codex' });
    spec(p, 'B1-03-fallback-ok');
    spec(p, 'B1-04-model-ok');
    spec(p, 'B1-05-second-ok', { profile: 'second' });
    assert.equal(p.hub(['dispatch', 'B1-01-engine-ok', '--engine', 'codex']).code, 0);
    assert.equal(p.hub(['dispatch', 'B1-02-spec-ok']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    assert.equal(p.hub(['dispatch', 'B1-03-fallback-ok', '--fallback']).code, 0);
    assert.equal(p.hub(['dispatch', 'B1-04-model-ok', '--engine', 'codex', '--model', 'gpt-6']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    const second = p.hub(['dispatch', 'B1-05-second-ok']);
    assert.equal(second.code, 0, second.out);
    assert.equal(p.hub(['retry', 'B1-01-engine-ok', '--feedback', 'again']).code, 0, 'a retry keeps its engine');
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    const list = calls(log);
    for (const id of ['B1-01-engine-ok', 'B1-02-spec-ok', 'B1-03-fallback-ok', 'B1-05-second-ok']) {
      const runs = workerCalls(list, id);
      assert.ok(runs.length, `${id} ran on Codex`);
      for (const a of runs) assert.deepEqual([arg(a, '-m'), effortOf(a)], ['gpt-6-mini', 'low'], id);
    }
    assert.equal(workerCalls(list, 'B1-01-engine-ok').length, 2, 'and its retry');
    // --model: that model, with the effort from the same place
    const [m] = workerCalls(list, 'B1-04-model-ok');
    assert.deepEqual([arg(m, '-m'), effortOf(m)], ['gpt-6', 'low']);
    assert.ok(!list.filter((a) => a.at(-1).includes('ROLE: WORKER')).some((a) => a.includes('gpt-6.1-sol') || a.includes('model_reasoning_effort=xhigh')), "never the orchestrator's");
    // Which worker took it: the second worker's task is no engine switch; one sent with --engine is
    assert.deepEqual([p.status('B1-05-second-ok').worker, p.status('B1-05-second-ok').switched], ['second', false]);
    assert.deepEqual([p.status('B1-02-spec-ok').worker, p.status('B1-02-spec-ok').switched], ['asked', true]);
    assert.equal(p.status('B1-03-fallback-ok').worker, 'fallback');
    // nextlevel status names the workers first, with what each takes
    const status = p.hub(['status']).out;
    assert.match(status, /Worker: workers +Antigravity.* · takes any task · no --engine or --profile/);
    assert.match(status, /Worker: second worker +Codex \(profile second\), gpt-6-mini \(effort low\) · takes tasks without Docker · --profile second or a spec's "Profile: second" line/);
    assert.match(status, /Worker: fallback +Codex, gpt-6-mini \(effort low\) · takes retries/);
  } finally {
    p.cleanup();
  }
});

test("without a worker profile on that engine a task sent there runs on the engine's own choice, and the job says so", () => {
  const p = makeProject();
  const log = path.join(p.tmp, 'codex-args.log');
  try {
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { ...c.roles.orchestrator, model: 'gpt-6.1-sol', effort: 'xhigh' }, worker: { engine: 'agy', fallback: 'agy' } } }));
    spec(p, 'B2-01-own-ok', { engine: 'codex' });
    const d = p.hub(['dispatch', 'B2-01-own-ok']);
    assert.match(d.out, /its model: Codex's own choice \(no worker on Codex sets one\)/);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    const [a] = workerCalls(calls(log), 'B2-01-own-ok');
    assert.ok(!a.includes('-m') && !effortOf(a), JSON.stringify(a));
    assert.equal(p.status('B2-01-own-ok').modelOwn, true);
  } finally {
    p.cleanup();
  }
});

test('"Needs: docker" on a Codex worker in its sandbox (Windows): refused at dispatch, held at start with no attempt spent, never moved there by the automatic fallback; the same task on another worker runs', async () => {
  const p = makeProject();
  const win = { NEXTLEVEL_TEST_PLATFORM: 'win32' };
  try {
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { ...c.roles.worker, second: SECOND } } }));
    spec(p, 'B3-01-docker-ok', { profile: 'second', needs: 'docker' });
    // At dispatch: refused, saying who can
    const r = p.hub(['dispatch', 'B3-01-docker-ok'], { extraEnv: win });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /B3-01-docker-ok needs Docker; Codex workers here can't give it \(its sandbox's accounts are refused the Docker pipe and ~\/\.docker\); the workers \(agy\) can, so nothing was dispatched\. Send it to one that can \(the workers: no Engine: or Profile: line in its spec, and no --engine or --profile\)/);
    assert.ok(!fs.existsSync(p.jobFile('B3-01-docker-ok', 'status.json')), 'nothing queued');
    // Not on Windows the same worker can give Docker: Windows only, as FR-009 measured
    spec(p, 'B3-02-linux-ok', { profile: 'second', needs: 'docker' });
    assert.equal(p.hub(['dispatch', 'B3-02-linux-ok'], { extraEnv: { NEXTLEVEL_TEST_PLATFORM: 'linux' } }).code, 0);
    p.hub(['cleanup', 'B3-02-linux-ok', '--discard', '--no-wait']);
    fs.rmSync(path.join(p.repo, '.nextlevel', 'queue', 'B3-02-linux-ok.json'), { force: true });
    fs.rmSync(path.join(p.repo, '.nextlevel', 'jobs', 'B3-02-linux-ok'), { recursive: true, force: true });
    // An unknown need is refused
    spec(p, 'B3-03-gpu-ok', { needs: 'gpu' });
    assert.match(p.hub(['dispatch', 'B3-03-gpu-ok']).out, /has "Needs: gpu", which nextlevel doesn't know/);

    // At start: queued for the workers (Antigravity), then the owner puts the workers on Codex in its sandbox
    spec(p, 'B3-04-held-ok', { needs: 'docker' });
    assert.equal(p.hub(['dispatch', 'B3-04-held-ok'], { extraEnv: win }).code, 0);
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { engine: 'codex', fallback: 'agy' } } }));
    p.runUntilIdle([], { extraEnv: win });
    const held = p.status('B3-04-held-ok');
    assert.deepEqual([held.state, held.waitingFor, held.attempt, held.attempts || []], ['queued', 'needs', 1, []]);
    assert.match(held.waiting, /^it needs Docker; Codex workers here can't give it .*; the workers' fallback \(agy\) can$/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /B3-04-held-ok waits in the queue: it needs Docker/);
    // wait says so at once; a retry without a place to go is refused; one that moves it runs, the same attempt
    const waited = p.hub(['wait', 'B3-04-held-ok', '--minutes', '1']);
    assert.equal(waited.code, 3);
    assert.match(waited.out, /B3-04-held-ok is queued and can't start: it needs Docker.*\nnext: move it to a worker that can: nextlevel retry B3-04-held-ok --profile P/);
    assert.match(p.hub(['retry', 'B3-04-held-ok']).out, /is queued and can't start: it needs Docker/);
    assert.match(p.hub(['retry', 'B3-04-held-ok', '--engine', 'codex'], { extraEnv: win }).out, /needs Docker; Codex workers here can't give it/);
    assert.equal(p.hub(['retry', 'B3-04-held-ok', '--fallback'], { extraEnv: win }).code, 0);
    p.runUntilIdle([], { extraEnv: win });
    const ran = p.status('B3-04-held-ok');
    assert.deepEqual([ran.state, ran.engine, ran.attempt], ['done', 'agy', 1]);

    // The automatic fallback never moves a task onto a worker that can't give what it needs: Antigravity isn't installed,
    // and the workers' fallback is Codex in its sandbox
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { engine: 'agy', fallback: 'codex' } } }));
    for (const f of fs.readdirSync(p.bin).filter((n) => /^agy(\.cmd)?$/.test(n))) fs.rmSync(path.join(p.bin, f));
    spec(p, 'B3-05-nofallback-ok', { needs: 'docker' });
    assert.equal(p.hub(['dispatch', 'B3-05-nofallback-ok'], { extraEnv: win }).code, 0);
    // (it then waits for Antigravity's files, FR-013: a hub in the background, looked at over a few of its rounds)
    const bg = p.hubInBackground(['run', '--tick-ms', '200'], win);
    try {
      await hubRounds(p, 4);
    } finally {
      bg.kill();
      await processesGone([bg.pid]);
    }
    const s = p.status('B3-05-nofallback-ok');
    assert.notEqual(s.engine, 'codex', 'not moved onto Codex');
    assert.ok(s.engineWhy?.how !== 'auto-fallback', JSON.stringify(s.engineWhy));
    assert.doesNotMatch(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /B3-05-nofallback-ok: automatic fallback/);
    // (a task that needs nothing goes to that fallback in the same setup: engines.test.mjs, FR-008's automatic fallback)
  } finally {
    p.cleanup();
  }
});

test("the second worker's row on the Team page: checked by the doctor (its engine and model) before it is saved, saved as the owner's change, and taken away again", () => {
  const p = makeProject();
  try {
    const set = (...args) => {
      const r = p.hub(['team', 'set', 'worker-second', ...args, '--json']);
      return { code: r.code, json: JSON.parse(r.out) };
    };
    // A model the account refuses (the stub refuses gpt-6-sol): not saved, and the doctor's model check says why
    const refused = set('--engine', 'codex', '--model', 'gpt-6-sol', '--takes', 'no-docker');
    assert.equal(refused.code, 1);
    assert.equal(refused.json.saved, false);
    assert.ok(refused.json.results.some((r) => r.id === 'codex.model' && r.status === 'fail'), JSON.stringify(refused.json.results.map((r) => [r.id, r.status])));
    assert.equal(p.config().roles.worker.second, undefined);
    // One it takes: saved, with what it takes; the checks were its engine's
    const ok = set('--engine', 'codex', '--model', 'gpt-6-mini', '--effort', 'low', '--takes', 'no-docker');
    assert.equal(ok.code, 0, JSON.stringify(ok.json));
    assert.deepEqual(ok.json.results.map((r) => r.id).filter((id) => id.startsWith('codex.') || id === 'tool.codex').sort(), ['codex.login', 'codex.model', 'codex.worker-windows', 'tool.codex'].filter((id) => ok.json.results.some((r) => r.id === id)).sort());
    assert.deepEqual(p.config().roles.worker.second, { engine: 'codex', model: 'gpt-6-mini', effort: 'low', takes: 'no-docker' });
    assert.deepEqual([p.config().roles.worker.engine, p.config().roles.worker.fallback], ['agy', 'codex'], 'the workers stay as they were');
    // What it takes, alone, and the wrong word for it
    assert.match(p.hub(['team', 'set', 'worker-second', '--engine', 'codex', '--takes', 'docker']).out, /--takes is no-docker, any, asked, not "docker"/);
    assert.match(p.hub(['team', 'set', 'worker', '--engine', 'agy', '--takes', 'any']).out, /--takes is the second worker's/);
    // The Team page shows it, and nextlevel team
    const view = JSON.parse(p.hub(['team', '--json']).out).rows.find((r) => r.key === 'worker-second');
    assert.deepEqual([view.engine, view.model.set, view.takes.value, view.takes.text], ['codex', 'gpt-6-mini', 'no-docker', 'tasks without Docker']);
    // Taken away
    const none = set('--engine', 'none');
    assert.equal(none.code, 0);
    assert.equal(p.config().roles.worker.second, null);
    spec(p, 'B4-01-ok');
    assert.match(p.hub(['dispatch', 'B4-01-ok', '--profile', 'second']).out, /--profile names the second worker, and there is none: the owner adds one on the Team page/);
  } finally {
    p.cleanup();
  }
});
