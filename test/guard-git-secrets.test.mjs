// The guard, second part: git's own hooks and settings (a change the hub didn't make stops all git work until the owner
// decides) and .env values (never committed; held with the value hidden). src/lib/gitguard.mjs, src/lib/secrets.mjs and
// the hub. Unit tests, then the whole way with stub engines. Every command in them is harmless (echo guard-test).
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { describeGitChange, diffGitState, parseConfigList, parseWorktrees, runsOrRedirects, stateKey } from '../src/lib/gitguard.mjs';
import { guardDir } from '../src/lib/guard.mjs';
import { describeSecretFile, findSecrets, isEnvFile, redactSecrets, secretValues } from '../src/lib/secrets.mjs';
import { fileExists, hubRounds, isAlive, makeProject, sleep } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const VALUE = 'guardtest-7c1e9a42-value'; // a made-up value for the tests' .env: nothing real

test("git's settings that run a program or send a push elsewhere, as git lists them; a state's changes in plain words", () => {
  for (const k of ['core.hooksPath', 'core.fsmonitor', 'core.sshCommand', 'credential.helper', 'credential.https://x.example.helper', 'remote.origin.url', 'remote.origin.pushurl', 'url.https://x.example/.pushInsteadOf', 'alias.st', 'filter.lfs.smudge', 'diff.x.textconv', 'include.path', 'includeIf.gitdir:~/x/.path', 'extensions.worktreeConfig', 'branch.main.pushRemote', 'sequence.editor', 'gpg.program']) {
    assert.equal(runsOrRedirects(k), true, k);
  }
  for (const k of ['user.name', 'core.autocrlf', 'branch.main.remote', 'remote.origin.fetch', 'init.defaultbranch', 'core.ignorecase']) assert.equal(runsOrRedirects(k), false, k);
  const listed = ['system', 'file:C:/Program Files/Git/etc/gitconfig', 'core.pager\nless', 'local', 'file:.git/config', 'core.hookspath\nhooks', 'local', 'file:.git/config', 'core.bare\nfalse', 'worktree', 'file:.git/config.worktree', 'core.sparsecheckout', ''].join('\0');
  assert.deepEqual(parseConfigList(listed), [
    { scope: 'local', file: '.git/config', key: 'core.hookspath', value: 'hooks' },
    { scope: 'local', file: '.git/config', key: 'core.bare', value: 'false' },
    { scope: 'worktree', file: '.git/config.worktree', key: 'core.sparsecheckout', value: null },
  ]);
  assert.deepEqual(parseWorktrees('worktree /p\nHEAD 1\nbranch refs/heads/main\n\nworktree /p.slots/w1\nHEAD 2\ndetached\n\nworktree /gone\nprunable gitdir file points to non-existent location\n'), [
    { dir: '/p', prunable: false, main: true },
    { dir: '/p.slots/w1', prunable: false, main: false },
    { dir: '/gone', prunable: true, main: false },
  ]);
  const a = { worktrees: ['/p', '/p.slots/w1'], config: [{ where: 'main', scope: 'local', file: '/p/.git/config', key: 'remote.origin.url', value: 'u' }, { where: '/p.slots/w1', scope: 'worktree', file: 'f', key: 'remote.origin.pushurl', value: 'nextlevel-no-push' }], hooks: { '/p/.git/hooks': { 'pre-push': { hash: 'h1', size: 3 } } } };
  const b = { worktrees: ['/p'], config: [{ where: 'main', scope: 'local', file: '/p/.git/config', key: 'remote.origin.url', value: 'u' }, { where: 'main', scope: 'local', file: '/p/.git/config', key: 'core.hooksPath', value: 'x' }], hooks: { '/p/.git/hooks': { 'pre-push': { hash: 'h2', size: 3 }, 'pre-commit': { hash: 'h3', size: 20 } } } };
  const d = diffGitState(a, b);
  assert.deepEqual(d.config.removed, [], "a worktree that is gone takes its settings with it");
  assert.deepEqual(d.config.added.map((e) => e.key), ['core.hooksPath']);
  assert.deepEqual(d.hooks.map((h) => [h.name, !!h.before, !!h.after]), [['pre-push', true, true], ['pre-commit', false, true]]);
  const words = describeGitChange(d, { text: (h) => (h.hash === 'h3' ? '#!/bin/sh\n# a comment\necho guard-test\n' : null) }).join('\n');
  assert.match(words, /adds core\.hooksPath = x \(the project's settings, \/p\/\.git\/config\)/);
  assert.match(words, /changes the pre-push hook in \/p\/\.git\/hooks/);
  assert.match(words, /adds the pre-commit hook in \/p\/\.git\/hooks: git runs it\n {2}would run: echo guard-test/);
  assert.equal(stateKey({ ...b, config: [...b.config].reverse() }), stateKey(b), 'the order git lists them in makes no difference');
  assert.notEqual(stateKey(a), stateKey(b));
});

test('.env values: which count, where they are, and the card never shows one', () => {
  const values = secretValues({ SERVICE_TOKEN: VALUE, PORT: '3000', SHORT: 'abc123', FLAG: 'true', EXAMPLE_URL: 'https://example.test/x', EMPTY: '' }, { example: { EXAMPLE_URL: 'https://example.test/x' } });
  assert.deepEqual(values.map((v) => v.name), ['SERVICE_TOKEN'], 'too short, a number, a word like true, and what .env.example has are not secrets');
  assert.deepEqual(findSecrets(Buffer.from(`a\ntoken: ${VALUE}\n`), values), ['SERVICE_TOKEN']);
  assert.deepEqual(findSecrets('nothing here', values), []);
  assert.equal(redactSecrets(`token: ${VALUE}`, values), 'token: [the value of SERVICE_TOKEN from .env]');
  assert.deepEqual(describeSecretFile('config/app.txt', `x\ntoken: ${VALUE}\n`, values), ['config/app.txt: has the value of SERVICE_TOKEN from .env (line 2)']);
  for (const p of ['.env', 'apps/web/.env', '.ENV']) assert.equal(isEnvFile(p), true, p);
  for (const p of ['.env.example', 'env', '.envrc', 'x.env']) assert.equal(isEnvFile(p), false, p);
  assert.match(describeSecretFile('.env', `SERVICE_TOKEN=${VALUE}`, values)[0], /^\.env: a \.env file: nextlevel never commits one/);
  assert.ok(!describeSecretFile('config/app.txt', `token: ${VALUE}`, values).join('').includes(VALUE));
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
const heldRecords = (p) => {
  const f = path.join(guardDir(p.repo, p.env.HOME), 'held.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items : [];
};
const waitFor = async (what, check, ms = 30_000) => {
  for (let i = 0; i < ms / 200; i++) {
    if (check()) return;
    await sleep(200);
  }
  assert.fail(`${what}: not in ${ms / 1000} s`);
};

test("a changed git hook stops all git work until the owner decides: Approve records it; a changed setting, Rejected, is put back", async () => {
  const p = makeProject();
  const hub = await startHub(p);
  let ui;
  try {
    fs.writeFileSync(path.join(p.repo, 'notes.txt'), 'one\n');
    assert.equal(p.hub(['commit', '-m', 'first', 'notes.txt']).code, 0, 'recorded at the first look: git work goes on');
    // A pre-commit hook appears (harmless: it echoes), as an agent that can write .git might add one
    const hook = path.join(p.repo, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho guard-test\n');
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(p.repo, 'notes.txt'), 'two\n');
    const stopped = p.hub(['commit', '-m', 'second', 'notes.txt']);
    assert.equal(stopped.code, 1, stopped.out);
    assert.match(stopped.out, /blocked · not run: git's own hooks or settings changed and nextlevel didn't make that change, so all git work waits for the owner \(G1, card H\d+ on the dashboard\)/);
    assert.equal(p.git('log', '-1', '--format=%s'), 'first');
    // a task waits too: nothing starts while git work is stopped
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.git('add', 'docs/tasks');
    p.git('commit', '-qm', 'the spec');
    assert.equal(p.hub(['dispatch', 'M1-01-ok']).code, 0);
    await hubRounds(p);
    assert.equal(p.status('M1-01-ok').state, 'queued', 'the hub looked at the queue and left it there');
    const [rec] = heldRecords(p);
    assert.equal(rec.kind, 'git');
    assert.deepEqual(rec.items, ['pre-commit hook']);
    assert.match(rec.summary.join('\n'), /adds the pre-commit hook in [^\n]*hooks: git runs it\n {2}would run: echo guard-test/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /all git work stops until the owner decides \(G1\)/);

    ui = await startUi(p);
    const c = client(ui);
    const state = (await c.get('/api/state')).json;
    assert.ok(state.needs.some((n) => n.kind === 'guard' && /^Git's own hooks or settings changed \(pre-commit hook\): all git work waits: approve or reject it \(G1\)$/.test(n.text)));
    assert.match(state.blockersCard.headline, /^Blocked: Git's own hooks or settings changed/);
    const g = (await c.get('/api/cards')).json.guard.find((x) => x.id === rec.id);
    assert.match(g.diff, /^\+echo guard-test/m);
    // Approve: recorded, and git work goes on (the task runs, the commit goes in)
    const ok = await c.post('/api/guard', { action: 'approve', id: rec.id });
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.json.message, /Approved: git's hooks and settings are recorded as they are now/);
    assert.equal(p.hub(['wait', 'M1-01-ok', '--minutes', '2']).code, 0);
    assert.equal(p.status('M1-01-ok').state, 'done');
    assert.equal(p.hub(['commit', '-m', 'second', 'notes.txt']).code, 0);
    assert.equal(p.git('log', '-1', '--format=%s'), 'second');

    // A setting that runs a program appears (core.hooksPath to a folder of its own): stopped; Reject puts it back
    p.git('config', 'core.hooksPath', path.join(p.tmp, 'other-hooks'));
    fs.writeFileSync(path.join(p.repo, 'notes.txt'), 'three\n');
    assert.match(p.hub(['commit', '-m', 'third', 'notes.txt']).out, /blocked · not run: git's own hooks or settings changed/);
    const rec2 = heldRecords(p).find((x) => x.kind === 'git' && x.status === 'held');
    assert.match(rec2.summary.join('\n'), /adds core\.hookspath = [^\n]*other-hooks \(the project's settings/i);
    const no = await c.post('/api/guard', { action: 'reject', id: rec2.id, reason: 'not mine' });
    assert.equal(no.status, 200, no.text);
    assert.match(no.json.message, /Rejected: git's hooks and settings are back as they were recorded/);
    assert.equal(spawnGit(p, ['config', '--get', 'core.hooksPath']).status, 1, 'unset again');
    assert.equal(p.hub(['commit', '-m', 'third', 'notes.txt']).code, 0);
  } finally {
    stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});
const spawnGit = (p, args) => {
  const r = { status: 0 };
  try {
    p.git(...args);
  } catch {
    r.status = 1;
  }
  return r;
};

test("a worker's slot whose push lock was changed (FR-003) stops all git work", async () => {
  const p = makeProject();
  try {
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-01-ok']);
    p.runUntilIdle();
    assert.equal(p.status('M1-01-ok').state, 'done');
    // the slot's own settings, which make every push from it fail: an agent takes the push URL out
    const slot = path.join(`${p.repo}.slots`, 'w1');
    p.gitIn(slot, 'config', '--worktree', '--unset-all', 'remote.origin.pushurl');
    p.spec('M1-02-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-02-ok']);
    const hub = await startHub(p);
    try {
      await waitFor('the card', () => heldRecords(p).some((x) => x.kind === 'git'));
      await hubRounds(p);
      assert.equal(p.status('M1-02-ok').state, 'queued', 'no task starts in a slot whose push lock is gone');
      const rec = heldRecords(p).find((x) => x.kind === 'git');
      assert.match(rec.summary.join('\n'), /removes remote\.origin\.pushurl = nextlevel-no-push-from-worker-slots::origin \(the settings of the worktree [^\n]*w1/);
    } finally {
      await hub.stop();
    }
  } finally {
    p.cleanup();
  }
});

test('a commit with a value from .env is held, the value never shown; a .env file is never approved; a worker branch with one waits', async () => {
  const p = makeProject();
  fs.writeFileSync(path.join(p.repo, '.env'), `SERVICE_TOKEN=${VALUE}\nPORT=3000\n`);
  const hub = await startHub(p, { STUB_LEAK_VALUE: VALUE });
  let ui;
  try {
    // the orchestrator's commit: the file with the value stays out, on disk; the rest goes in
    fs.writeFileSync(path.join(p.repo, 'config.txt'), `token: ${VALUE}\n`);
    fs.writeFileSync(path.join(p.repo, 'plain.txt'), 'port: 3000\n');
    const r = p.hub(['commit', '-m', 'config']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /committed [0-9a-f]+ config; held config\.txt: it has the value of SERVICE_TOKEN from \.env \(G1, card H\d+\)/);
    assert.ok(!r.out.includes(VALUE));
    assert.equal(p.git('show', '--name-only', '--format=', 'HEAD'), 'plain.txt');
    assert.ok(fs.existsSync(path.join(p.repo, 'config.txt')), 'it stays on disk, uncommitted');
    const held = fs.readFileSync(path.join(guardDir(p.repo, p.env.HOME), 'held.json'), 'utf8');
    assert.ok(!held.includes(VALUE), "the guard's record never has the value");
    const [rec] = heldRecords(p);
    assert.equal(rec.kind, 'secret');
    assert.deepEqual(rec.summary, ['config.txt: has the value of SERVICE_TOKEN from .env (line 1)']);
    assert.match(rec.diff, /^\+token: \[the value of SERVICE_TOKEN from \.env\]$/m);
    // a .env file itself (its line taken out of .gitignore): held, and never approved
    fs.writeFileSync(path.join(p.repo, '.gitignore'), fs.readFileSync(path.join(p.repo, '.gitignore'), 'utf8').replace(/^\.env\r?$/m, ''));
    const env = p.hub(['commit', '-m', 'env', '.env', '.gitignore']);
    assert.match(env.out, /held \.env: a \.env file is never committed \(G2/);
    assert.ok(!p.git('ls-files').split('\n').includes('.env'));

    ui = await startUi(p);
    const c = client(ui);
    const cards = (await c.get('/api/cards')).json.guard;
    assert.ok(!JSON.stringify(cards).includes(VALUE));
    const envCard = cards.find((x) => x.env);
    const refused = await c.post('/api/guard', { action: 'approve', id: envCard.id });
    assert.equal(refused.status, 409);
    assert.match(refused.json.message, /\.env is a \.env file: nextlevel never commits one, so this can't be approved/);
    assert.equal((await c.post('/api/guard', { action: 'reject', id: envCard.id, reason: 'never' })).status, 200);
    // the owner says the value may be committed: the hub commits exactly that
    const ok = await c.post('/api/guard', { action: 'approve', id: rec.id });
    assert.equal(ok.status, 200, ok.text);
    await waitFor('the approved commit', () => heldRecords(p).find((x) => x.id === rec.id).status === 'applied');
    assert.equal(p.git('show', '--name-only', '--format=', 'HEAD'), 'config.txt');

    // a worker's branch with a value from .env: its merge waits; Rejected, it goes back to the orchestrator
    p.spec('M1-03-leak', 'node -e "0"');
    assert.equal(p.hub(['commit', '-m', 'task']).code, 0);
    p.hub(['dispatch', 'M1-03-leak']);
    assert.equal(p.hub(['wait', 'M1-03-leak', '--minutes', '2']).code, 0);
    const merge = p.hub(['merge', 'M1-03-leak']);
    assert.equal(merge.code, 1, merge.out);
    assert.match(merge.out, /held: M1-03-leak puts the value of SERVICE_TOKEN from \.env in leak\.txt/);
    const leak = heldRecords(p).find((x) => x.task === 'M1-03-leak');
    assert.equal((await c.post('/api/guard', { action: 'reject', id: leak.id, reason: 'no secrets in the code' })).status, 200);
    assert.equal(p.status('M1-03-leak').state, 'failed');
    assert.match(p.status('M1-03-leak').detail, /the owner rejected the value of SERVICE_TOKEN from \.env in leak\.txt \(G\d+\): "no secrets in the code"/);
    assert.match(p.hub(['merge', 'M1-03-leak']).out, /not merged: the owner rejected M1-03-leak's value of SERVICE_TOKEN/);
  } finally {
    stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});

test("the hub's own commit of a worker's work never takes a value from .env: held, out of the slot; Approve commits it on the task's branch", async () => {
  const p = makeProject();
  fs.writeFileSync(path.join(p.repo, '.env'), `SERVICE_TOKEN=${VALUE}\n`);
  let ui;
  try {
    // a Codex worker leaves its changes for the hub to commit (FR-008)
    fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', 'M1-04-leak.md'), '# M1-04-leak — x\n\nKind: code\nEngine: codex\n\n## Verify\n```sh\nnode -e "0"\n```\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'the spec');
    p.hub(['dispatch', 'M1-04-leak']);
    p.runUntilIdle([], { extraEnv: { STUB_LEAK_VALUE: VALUE } });
    const s = p.status('M1-04-leak');
    assert.equal(s.state, 'failed');
    assert.match(s.detail, /held leak\.txt: the worker's changes put the value of SERVICE_TOKEN from \.env in leak\.txt; nothing of that was committed \(G1/);
    assert.ok(!p.git('show', '--name-only', '--format=', 'task/M1-04-leak').includes('leak.txt'));
    assert.ok(!fs.existsSync(path.join(`${p.repo}.slots`, 'w1', 'leak.txt')), 'out of the slot too');
    assert.ok(!fs.existsSync(p.jobFile('M1-04-leak', 'left')) || !JSON.stringify(fs.readdirSync(p.jobFile('M1-04-leak', 'left'), { recursive: true })).includes('leak.txt'), 'and not copied into the project');
    const [rec] = heldRecords(p);
    assert.equal(rec.on, 'slot');
    const hub = await startHub(p);
    try {
      ui = await startUi(p);
      const ok = await client(ui).post('/api/guard', { action: 'approve', id: rec.id });
      assert.equal(ok.status, 200, ok.text);
      assert.match(ok.json.message, /the hub commits leak\.txt on task\/M1-04-leak/);
      await waitFor('the commit on the task branch', () => heldRecords(p)[0].status === 'applied');
      assert.equal(p.git('show', 'task/M1-04-leak:leak.txt').trim(), `token: ${VALUE}`);
      // its merge goes through now: that content was approved
      assert.equal(p.hub(['merge', 'M1-04-leak']).code, 0);
    } finally {
      await hub.stop();
    }
  } finally {
    stopUi(ui);
    p.cleanup();
  }
});
