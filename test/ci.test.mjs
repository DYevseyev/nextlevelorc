// CI itself (.github/): what it tests is decided from the changed files, a skipped or missing Windows run never
// counts as green, and Windows runs once per pull request (.github/ci/changes.mjs, the two workflows).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { TEST_STEP, changedFiles, docsOnly, isDoc, sameCodeAs, ubuntu, windows } from '../.github/ci/changes.mjs';
import { REPO, makeSandbox } from './helpers.mjs';

test('only documentation: docs/ and the Markdown files at the top; what tests read, templates, CI and code are code', () => {
  for (const f of ['docs/PLAN.md', 'docs/DECISIONS.md', 'docs/upstream/codex-windows-sandbox-windows.md', 'docs/examples/SETUP.md', 'README.md', 'CLAUDE.md']) assert.equal(isDoc(f), true, f);
  for (const f of ['docs/CHECKS.md', 'templates/project/AGENTS.md', 'templates/project/docs/agents/WORKER.md', 'src/hub.mjs', 'test/ci.test.mjs', '.github/workflows/ci.yml', '.github/ci/changes.mjs', 'package.json', 'install.ps1', 'docs', 'src/README.md']) {
    assert.equal(isDoc(f), false, f);
  }
  assert.equal(docsOnly(['docs/PLAN.md', 'CLAUDE.md']), true);
  assert.equal(docsOnly(['docs/PLAN.md', 'src/hub.mjs']), false);
  assert.equal(docsOnly([]), false, 'a change that touches nothing runs its tests');
  assert.equal(docsOnly(null), false, "git couldn't tell: the tests run");
});

test('every file of this repository that a test reads counts as code', () => {
  const read = new Set();
  for (const f of fs.readdirSync(path.join(REPO, 'test')).filter((x) => x.endsWith('.mjs'))) {
    const text = fs.readFileSync(path.join(REPO, 'test', f), 'utf8');
    for (const m of text.matchAll(/new URL\('\.\.\/([^']+)'/g)) read.add(m[1]);
    for (const m of text.matchAll(/path\.join\(REPO((?:,\s*'[^']*')+)\)/g)) read.add([...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]).join('/'));
  }
  assert.ok(read.has('docs/CHECKS.md'), `the scan finds what tests read: ${[...read].join(', ')}`);
  for (const f of read) assert.equal(isDoc(f), false, `${f} is read by a test, so changing it runs the tests`);
});

// A repository with main and a branch; git as the CI script runs it
function repo() {
  const box = makeSandbox();
  const dir = path.join(box.tmp, 'repo');
  fs.mkdirSync(dir);
  const git = (args) => {
    const r = spawnSync('git', args, { cwd: dir, env: box.env, encoding: 'utf8' });
    return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
  };
  const run = (...args) => {
    const r = git(args);
    if (!r.ok) throw new Error(`git ${args.join(' ')}: ${r.err}`);
    return r.out.trim();
  };
  const write = (files) => {
    for (const [f, text] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      if (text === null) fs.rmSync(path.join(dir, f));
      else fs.writeFileSync(path.join(dir, f), text);
    }
  };
  const commit = (message, files = {}) => {
    write(files);
    run('add', '-A');
    run('commit', '-qm', message, '--allow-empty');
    return run('rev-parse', 'HEAD');
  };
  run('init', '-q', '-b', 'main');
  const base = commit('base', { 'src/a.mjs': 'export const a = 1;\n', 'docs/PLAN.md': '# Plan\n', 'docs/CHECKS.md': '# Checks\n', 'README.md': '# nextlevel\n' });
  return { box, dir, git, run, commit, base, cleanup: () => box.cleanup() };
}

test('changed files: a rename counts as both names, so code moved into docs/ is a code change', () => {
  const r = repo();
  try {
    const moved = r.commit('move', { 'src/a.mjs': null, 'docs/a.md': 'export const a = 1;\n' });
    assert.deepEqual(changedFiles(r.base, moved, r.git).sort(), ['docs/a.md', 'src/a.mjs']);
    assert.equal(docsOnly(changedFiles(r.base, moved, r.git)), false);
    assert.equal(changedFiles(r.base, 'no-such-commit', r.git), null);
    assert.equal(changedFiles('--output=x', moved, r.git), null, 'never one of git\'s options');
    assert.equal(changedFiles(r.base, '', r.git), null);
  } finally {
    r.cleanup();
  }
});

test('the same code: the first commit that passed, that the head contains, with only documentation changed since', () => {
  const r = repo();
  try {
    const code = r.commit('code', { 'src/a.mjs': 'export const a = 2;\n' });
    const docs = r.commit('docs', { 'docs/PLAN.md': '# Plan\n\n- [x] done\n', 'CLAUDE.md': '# rules\n' });
    const head = r.commit('more docs', { 'docs/DECISIONS.md': '# Decisions\n' });
    assert.deepEqual(sameCodeAs(head, [{ sha: head }], r.git).files, [], 'the head itself passed already');
    const same = sameCodeAs(head, [{ sha: code, url: 'u' }], r.git);
    assert.equal(same.sha, code);
    assert.deepEqual(same.files.sort(), ['CLAUDE.md', 'docs/DECISIONS.md', 'docs/PLAN.md']);
    assert.equal(sameCodeAs(head, [{ sha: r.base }], r.git), null, 'code changed since');
    assert.equal(sameCodeAs(docs, [{ sha: head }], r.git), null, 'a later commit is not in it');
    assert.equal(sameCodeAs(head, [{ sha: 'HEAD~1; echo' }, { sha: '' }, null], r.git), null, 'only commit ids');
    // docs/CHECKS.md is read by a test: not the same code
    const checks = r.commit('checks', { 'docs/CHECKS.md': '# Checks\n\n### x\n' });
    assert.equal(sameCodeAs(checks, [{ sha: head }], r.git), null);
  } finally {
    r.cleanup();
  }
});

// GitHub's API as the workflows' token sees it: the branch's Windows runs (a pass's `tests`: its test step's conclusion,
// 'success' unless said), and what the script asked for
function fakeApi({ passes = [], going = [], fail = '' } = {}) {
  const calls = [];
  const api = async (method, p, body) => {
    calls.push({ method, path: p, body });
    if (fail && p.includes(fail)) throw new Error('HTTP 403 Resource not accessible by integration');
    if (method === 'GET' && p.startsWith('/actions/workflows/windows.yml/runs?')) return { workflow_runs: p.includes('status=success') ? passes : going };
    const jobs = method === 'GET' && p.match(/^\/actions\/runs\/(\d+)\/jobs\?filter=latest$/);
    if (jobs) {
      const run = passes.find((r) => String(r.id) === jobs[1]);
      return { jobs: [{ name: 'windows', conclusion: 'success', steps: [{ name: 'What changed', conclusion: 'success' }, { name: TEST_STEP, conclusion: run?.tests ?? 'success' }] }] };
    }
    return method === 'POST' ? {} : null;
  };
  return { api, calls };
}

// A pull request of branch `feat` and GitHub's merge of it into main, checked out as a pull_request run has it
function pullRequest(r, branchFiles, mainFiles = { 'src/b.mjs': 'export const b = 1;\n' }) {
  r.run('checkout', '-q', '-b', 'feat');
  const head = r.commit('the change', branchFiles);
  r.run('checkout', '-q', 'main');
  const mainTip = r.commit('main moved', mainFiles);
  r.run('checkout', '-q', '--detach', mainTip);
  r.run('merge', '-q', '--no-ff', '--no-edit', 'feat');
  return { head, mainTip, event: { pull_request: { head: { sha: head, ref: 'feat' } } } };
}

test('ci.yml on a pull request of documentation only: the tests are skipped, and the windows check passes at once', async () => {
  const r = repo();
  try {
    const pr = pullRequest(r, { 'docs/PLAN.md': '# Plan\n\n- [x] CI costs less\n' });
    const { api, calls } = fakeApi({ going: [{ id: 7, status: 'in_progress', head_sha: r.base, html_url: 'https://github.com/o/r/actions/runs/7' }, { id: 8, status: 'in_progress', head_sha: pr.head, html_url: 'x' }, { id: 9, status: 'completed', head_sha: r.base, html_url: 'y' }] });
    const res = await ubuntu({ eventName: 'pull_request', event: pr.event, git: r.git, api });
    assert.equal(res.skip, true);
    assert.match(res.why, /^only documentation changed \(docs\/PLAN\.md\)$/);
    // the Windows run on the older commit is cancelled; one on this commit, or finished, is left alone
    assert.deepEqual(calls.filter((c) => c.method === 'POST' && c.path.includes('/cancel')).map((c) => c.path), ['/actions/runs/7/cancel']);
    const check = calls.find((c) => c.path === '/check-runs');
    assert.deepEqual([check.body.name, check.body.head_sha, check.body.status, check.body.conclusion], ['windows', pr.head, 'completed', 'success']);
    assert.match(check.body.output.summary, /^No Windows run needed: the code is main's: only documentation changed \(docs\/PLAN\.md\)\.$/);
  } finally {
    r.cleanup();
  }
});

test("ci.yml on a pull request that changes code: the tests run, and the windows check waits for a Windows run", async () => {
  const r = repo();
  try {
    const pr = pullRequest(r, { 'src/a.mjs': 'export const a = 3;\n', 'docs/PLAN.md': '# Plan\n\n- [x] a\n' });
    const { api, calls } = fakeApi({ passes: [{ id: 5, head_sha: r.base, html_url: 'z' }] });
    const res = await ubuntu({ eventName: 'pull_request', event: pr.event, git: r.git, api });
    assert.equal(res.skip, false);
    assert.ok(!calls.some((c) => c.path === '/check-runs'), 'no windows check: the merge waits for the Windows run');
  } finally {
    r.cleanup();
  }
});

test('ci.yml after the Windows run passed, on a push of documentation only: the windows check passes, the tests still run', async () => {
  const r = repo();
  try {
    const pr = pullRequest(r, { 'src/a.mjs': 'export const a = 3;\n' });
    r.run('checkout', '-q', 'feat');
    const tested = pr.head;
    const head = r.commit('the decisions', { 'docs/DECISIONS.md': '# Decisions\n\n- why\n' });
    r.run('checkout', '-q', '--detach', pr.mainTip);
    r.run('merge', '-q', '--no-ff', '--no-edit', 'feat');
    const event = { pull_request: { head: { sha: head, ref: 'feat' } } };
    // (a Windows run of a push, which windows.yml never has, wouldn't count)
    const passes = [{ id: 12, event: 'push', head_sha: head, html_url: 'x' }, { id: 11, event: 'pull_request', head_sha: tested, html_url: 'https://github.com/o/r/actions/runs/11' }];
    const { api, calls } = fakeApi({ passes });
    const res = await ubuntu({ eventName: 'pull_request', event, git: r.git, api });
    assert.equal(res.skip, false, "the pull request changes code: Ubuntu's tests run");
    const check = calls.find((c) => c.path === '/check-runs');
    assert.equal(check.body.head_sha, head);
    assert.equal(check.body.output.summary, `No Windows run needed: the code is the same as ${tested.slice(0, 7)}, which passed on Windows (https://github.com/o/r/actions/runs/11); only documentation changed since (docs/DECISIONS.md).`);
    assert.ok(calls.some((c) => c.method === 'GET' && /branch=feat&per_page=50&status=success$/.test(c.path)), "the branch's runs that passed");
  } finally {
    r.cleanup();
  }
});

test("ci.yml: when GitHub's API refuses, it says so and the tests run; nothing counts as green", async () => {
  const r = repo();
  try {
    const pr = pullRequest(r, { 'src/a.mjs': 'export const a = 3;\n' });
    const { api, calls } = fakeApi({ passes: [{ id: 5, event: 'pull_request', head_sha: pr.head, html_url: 'z' }], fail: '/actions/' });
    const res = await ubuntu({ eventName: 'pull_request', event: pr.event, git: r.git, api });
    assert.equal(res.skip, false);
    assert.ok(!calls.some((c) => c.path === '/check-runs'));
    assert.equal(res.notes.filter((n) => n.startsWith('warning: ')).length, 2, res.notes.join('\n'));
    // a documentation change whose windows check can't be posted: the tests are still skipped, and it says to ask
    const docs = repo();
    try {
      const dpr = pullRequest(docs, { 'README.md': '# nextlevel\n\nMore.\n' });
      const res2 = await ubuntu({ eventName: 'pull_request', event: dpr.event, git: docs.git, api: fakeApi({ fail: '/check-runs' }).api });
      assert.equal(res2.skip, true);
      assert.ok(res2.notes.some((n) => /warning: the windows check could not be passed \(ask for the Windows run as usual\)/.test(n)));
    } finally {
      docs.cleanup();
    }
  } finally {
    r.cleanup();
  }
});

test("a file's name never starts a line of the log (the runner reads a line that starts with :: as a command)", async () => {
  // (git as it answers for a file whose name has a line break: Windows can't make one, Linux can)
  const git = (args) => (args[0] === 'diff' ? { ok: true, out: 'docs/a\n::add-mask::x.md\0' } : { ok: false, out: '' });
  const res = await ubuntu({ eventName: 'pull_request', event: { pull_request: { head: { sha: 'a'.repeat(40), ref: 'feat' } } }, git, api: fakeApi().api });
  assert.equal(res.skip, true);
  assert.equal(res.why, 'only documentation changed (docs/a?::add-mask::x.md)');
});

test('ci.yml on main after a merge: only documentation skips the tests; a new branch or unknown commit runs them', async () => {
  const r = repo();
  try {
    const docs = r.commit('docs', { 'docs/PLAN.md': '# Plan\n\n- [x] b\n' });
    const { api, calls } = fakeApi();
    assert.equal((await ubuntu({ eventName: 'push', event: { before: r.base }, sha: docs, git: r.git, api })).skip, true);
    const code = r.commit('code', { 'src/a.mjs': 'export const a = 4;\n' });
    assert.equal((await ubuntu({ eventName: 'push', event: { before: docs }, sha: code, git: r.git, api })).skip, false);
    assert.equal((await ubuntu({ eventName: 'push', event: { before: '0000000000000000000000000000000000000000' }, sha: code, git: r.git, api })).skip, false);
    assert.equal((await ubuntu({ eventName: 'push', event: { before: 'f'.repeat(40) }, sha: code, git: r.git, api })).skip, false);
    assert.deepEqual(calls, [], 'main posts and cancels nothing');
  } finally {
    r.cleanup();
  }
});

test('windows.yml run by hand: a branch behind main fails in seconds; new code runs the tests; the same code as a pass is a quick pass', async () => {
  const r = repo();
  try {
    r.run('checkout', '-q', '-b', 'feat');
    r.commit('code', { 'src/a.mjs': 'export const a = 5;\n' });
    r.run('checkout', '-q', 'main');
    r.commit('main moved', { 'src/b.mjs': 'export const b = 1;\n' });
    r.run('update-ref', 'refs/remotes/origin/main', 'main');
    r.run('checkout', '-q', 'feat');
    const ctx = (api, runId = '99') => ({ eventName: 'workflow_dispatch', event: { repository: { default_branch: 'main' } }, refName: 'feat', runId, git: r.git, api });
    const behind = await windows(ctx(fakeApi().api));
    assert.match(behind.fail, /^feat is behind main, and a merge needs the Windows run on a commit that has main in it: bring the branch up to date first \(git fetch origin, git merge origin\/main, npm test, push\), then ask for this run again\.$/);

    r.run('merge', '-q', '--no-edit', 'main');
    const up = r.run('rev-parse', 'HEAD');
    const fresh = await windows(ctx(fakeApi().api));
    assert.deepEqual([fresh.skip, fresh.fail], [false, undefined], 'new code: the tests run');
    // an earlier run of the same branch passed at `up`; only documentation changed since
    const docs = r.commit('docs', { 'docs/PLAN.md': '# Plan\n\n- [x] c\n' });
    const { api, calls } = fakeApi({ passes: [{ id: 99, event: 'workflow_dispatch', head_sha: docs, html_url: 'this run' }, { id: 12, event: 'workflow_dispatch', head_sha: up, html_url: 'https://github.com/o/r/actions/runs/12' }] });
    const same = await windows(ctx(api));
    assert.equal(same.skip, true);
    assert.equal(same.why, `the code is the same as ${up.slice(0, 7)}, which passed on Windows (https://github.com/o/r/actions/runs/12); only documentation changed since (docs/PLAN.md)`);
    assert.match(calls[0].path, /branch=feat&per_page=50&status=success$/);
    // documentation alone on top of main: main's code (it passed as the head of the pull request merged last)
    r.run('checkout', '-q', '-b', 'docs-only', 'main');
    r.commit('readme', { 'README.md': '# nextlevel\n\nHow to.\n' });
    const docsOnlyRun = await windows({ ...ctx(fakeApi().api), refName: 'docs-only' });
    assert.equal(docsOnlyRun.skip, true);
    assert.equal(docsOnlyRun.why, "the code is main's: only documentation changed (README.md)");
    // asked for on main itself: the tests run (main is no pass of its own)
    r.run('checkout', '-q', 'main');
    assert.equal((await windows({ ...ctx(fakeApi().api), refName: 'main' })).skip, false);
  } finally {
    r.cleanup();
  }
});

test('windows.yml when the pull request is marked ready for review: behind main it fails; up to date its code is tested; a pass counts for the next commit', async () => {
  const r = repo();
  try {
    // behind: main moved after the branch left it (GitHub's merge would have main's new code; the head doesn't)
    const pr = pullRequest(r, { 'src/a.mjs': 'export const a = 6;\n' });
    r.run('update-ref', 'refs/remotes/origin/main', pr.mainTip);
    const ready = (event, runId = '50', api = fakeApi().api) => windows({ eventName: 'pull_request', event, refName: '26/merge', runId, git: r.git, api });
    const event = (sha) => ({ pull_request: { head: { sha, ref: 'feat' }, base: { ref: 'main' } } });
    assert.match((await ready(event(pr.head))).fail, /^feat is behind main, and a merge needs the Windows run on a commit that has main in it: bring the branch up to date first/);
    // up to date (main merged in): its code runs the tests, on GitHub's merge of it
    r.run('checkout', '-q', 'feat');
    r.run('merge', '-q', '--no-edit', 'main');
    const up = r.run('rev-parse', 'HEAD');
    r.run('checkout', '-q', '--detach', pr.mainTip);
    r.run('merge', '-q', '--no-ff', '--no-edit', 'feat');
    const fresh = await ready(event(up));
    assert.deepEqual([fresh.skip, fresh.fail], [false, undefined]);
    // that run passed; the next commit only adds documentation: a quick pass, from the files
    r.run('checkout', '-q', 'feat');
    const docs = r.commit('decisions', { 'docs/DECISIONS.md': '# Decisions\n' });
    r.run('checkout', '-q', '--detach', pr.mainTip);
    r.run('merge', '-q', '--no-ff', '--no-edit', 'feat');
    const same = await ready(event(docs), '51', fakeApi({ passes: [{ id: 50, event: 'pull_request', head_sha: up, html_url: 'https://github.com/o/r/actions/runs/50' }] }).api);
    assert.equal(same.skip, true);
    assert.equal(same.why, `the code is the same as ${up.slice(0, 7)}, which passed on Windows (https://github.com/o/r/actions/runs/50); only documentation changed since (docs/DECISIONS.md)`);
    assert.match((await ready(event('not a commit'))).fail, /^no commit to test/);
  } finally {
    r.cleanup();
  }
});

// The pull request as both jobs see it: GitHub's merge of branch `feat` into main's tip, checked out; main as fetched
function checkoutMerge(r, mainTip) {
  r.run('update-ref', 'refs/remotes/origin/main', mainTip);
  r.run('checkout', '-q', '--detach', mainTip);
  r.run('merge', '-q', '--no-ff', '--no-edit', 'feat');
}
// (`before`: the head before this push, as GitHub's event has it)
const prEvent = (sha, before) => ({ before, after: sha, pull_request: { head: { sha, ref: 'feat' }, base: { ref: 'main' } } });
const asked = (r, head, api, before) => windows({ eventName: 'pull_request', event: prEvent(head, before), refName: '26/merge', runId: '90', git: r.git, api });
const pushed = (r, head, api, before) => ubuntu({ eventName: 'pull_request', event: prEvent(head, before), git: r.git, api });

test('documentation only means the whole pull request against main: a code commit, then a documentation commit on top, gets no windows quick pass', async () => {
  const r = repo();
  try {
    r.run('checkout', '-q', '-b', 'feat');
    const code = r.commit('code', { 'src/a.mjs': 'export const a = 7;\n' });
    const docs = r.commit('docs on top', { 'docs/PLAN.md': '# Plan\n\n- [x] d\n' });
    assert.equal(docsOnly(changedFiles(code, docs, r.git)), true, '(the latest push alone is documentation)');
    checkoutMerge(r, r.base);
    const { api, calls } = fakeApi();
    const ci = await pushed(r, docs, api, code);
    assert.equal(ci.skip, false, "Ubuntu's tests run: the pull request changes code");
    assert.ok(!calls.some((c) => c.path === '/check-runs'), 'no windows check: the merge waits for a Windows run');
    const win = await asked(r, docs, fakeApi().api, code);
    assert.deepEqual([win.skip, win.fail], [false, undefined], 'asked for, the Windows tests run');
  } finally {
    r.cleanup();
  }
});

test("a Windows pass counts only for exactly its code: an update from main that brings code runs Windows again, as does a new commit; one that brings only documentation doesn't", async () => {
  const r = repo();
  try {
    r.run('checkout', '-q', '-b', 'feat');
    const passedAt = r.commit('code', { 'src/a.mjs': 'export const a = 8;\n' });
    const passes = [{ id: 70, event: 'pull_request', head_sha: passedAt, html_url: 'https://github.com/o/r/actions/runs/70' }];
    // main brings code; the branch takes it in
    r.run('checkout', '-q', 'main');
    const mainCode = r.commit('main: code', { 'src/b.mjs': 'export const b = 2;\n' });
    r.run('checkout', '-q', 'feat');
    r.run('merge', '-q', '--no-edit', 'main');
    const updated = r.run('rev-parse', 'HEAD');
    checkoutMerge(r, mainCode);
    const { api, calls } = fakeApi({ passes });
    assert.equal((await asked(r, updated, api)).skip, false, 'the Windows tests run again: code from main changed since the pass');
    assert.ok(calls.some((c) => c.path === '/actions/runs/70/jobs?filter=latest'), 'the pass was looked at');
    const ci = fakeApi({ passes });
    await pushed(r, updated, ci.api);
    assert.ok(!ci.calls.some((c) => c.path === '/check-runs'), 'and no windows quick pass');
    // a new commit of the branch's own code after the pass: the same
    r.run('checkout', '-q', 'feat');
    const more = r.commit('more code', { 'src/a.mjs': 'export const a = 9;\n' });
    checkoutMerge(r, mainCode);
    assert.equal((await asked(r, more, fakeApi({ passes: [{ ...passes[0], head_sha: updated }] }).api)).skip, false);

    // main brings only documentation after a pass: exactly the same code, so no second run
    const s = repo();
    try {
      s.run('checkout', '-q', '-b', 'feat');
      const tested = s.commit('code', { 'src/a.mjs': 'export const a = 10;\n' });
      s.run('checkout', '-q', 'main');
      const mainDocs = s.commit('main: docs', { 'docs/DECISIONS.md': '# Decisions\n\n- main\n' });
      s.run('checkout', '-q', 'feat');
      s.run('merge', '-q', '--no-edit', 'main');
      const head = s.run('rev-parse', 'HEAD');
      checkoutMerge(s, mainDocs);
      const same = await asked(s, head, fakeApi({ passes: [{ id: 71, event: 'pull_request', head_sha: tested, html_url: 'https://github.com/o/r/actions/runs/71' }] }).api);
      assert.equal(same.skip, true);
      assert.equal(same.why, `the code is the same as ${tested.slice(0, 7)}, which passed on Windows (https://github.com/o/r/actions/runs/71); only documentation changed since (docs/DECISIONS.md)`);
    } finally {
      s.cleanup();
    }
  } finally {
    r.cleanup();
  }
});

test('a Windows run that skipped its tests (the same code as an earlier one) is no pass for later commits', async () => {
  const r = repo();
  try {
    r.run('checkout', '-q', '-b', 'feat');
    const quick = r.commit('code', { 'src/a.mjs': 'export const a = 11;\n' });
    const head = r.commit('docs', { 'docs/PLAN.md': '# Plan\n\n- [x] e\n' });
    checkoutMerge(r, r.base);
    const passes = [{ id: 72, event: 'pull_request', head_sha: quick, html_url: 'x', tests: 'skipped' }];
    assert.equal((await asked(r, head, fakeApi({ passes }).api)).skip, false);
    const ci = fakeApi({ passes });
    await pushed(r, head, ci.api);
    assert.ok(!ci.calls.some((c) => c.path === '/check-runs'));
    // the same run with its tests passed would count
    assert.equal((await asked(r, head, fakeApi({ passes: [{ ...passes[0], tests: 'success' }] }).api)).skip, true);
  } finally {
    r.cleanup();
  }
});

// The workflows, read as text (no YAML parser: the tool has no dependencies)
const workflow = (name) => fs.readFileSync(path.join(REPO, '.github', 'workflows', name), 'utf8');
const jobsOf = (text) => [...text.slice(text.indexOf('\njobs:')).matchAll(/^ {2}([\w-]+):$/gm)].map((m) => m[1]);

test('the workflows: Ubuntu on every pull request push and main; Windows only when asked for, never skipped', () => {
  const ci = workflow('ci.yml');
  const win = workflow('windows.yml');
  assert.deepEqual(jobsOf(ci), ['ubuntu']);
  assert.deepEqual(jobsOf(win), ['windows']);
  assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]\n {2}pull_request:\n\n/m, 'one run per commit: pull requests, and main after a merge');
  // asked for: a draft marked ready for review, or by hand; no other pull request event starts it, so before the
  // request the commit has no windows check at all (a skipped or neutral one would count as passed)
  assert.match(win, /^on:\n {2}pull_request:\n {4}types: \[ready_for_review\]\n {2}workflow_dispatch:\n\n/m);
  assert.match(ci, /^ {4}name: ubuntu$/m);
  assert.match(win, /^ {4}name: windows$/m, 'the check a merge needs is this job');
  assert.match(win, /runs-on: windows-latest/);
  assert.doesNotMatch(ci, /windows-latest/, 'no Windows on every push, nor on main after a merge');
  for (const text of [ci, win]) {
    assert.doesNotMatch(text, /^ {4}if:/m, 'a job with a condition can be skipped, and a skipped job counts as green');
    assert.match(text, /^ {2}cancel-in-progress: true$/m, 'a newer push (or request) replaces the run in progress');
    // the tests run unless the script said, from the changed files, that they may be skipped
    const guarded = [...text.matchAll(/- name: (Syntax check|End-to-end tests \(stub CLIs\))\n {8}if: (.*)$/gm)].map((m) => m[2]);
    assert.deepEqual(guarded, ["steps.changes.outputs.skip != 'true'", "steps.changes.outputs.skip != 'true'"]);
    assert.doesNotMatch(text, /\$\{\{[^}]*label/i, 'never from a label');
    // (a branch name in a run: line would be run by the shell; the script reads it from the event instead)
    for (const line of text.split('\n').filter((l) => /\$\{\{[^}]*github\.(head_ref|event\.pull_request)/.test(l))) assert.match(line, /^\s*group: /, line);
  }
  assert.match(ci, /run: node \.github\/ci\/changes\.mjs ubuntu/);
  assert.match(win, /run: node \.github\/ci\/changes\.mjs windows/);
  assert.match(win, /- name: End-to-end tests \(stub CLIs\)\n {8}if: .*\n {8}run: npm test\n/, 'the whole suite, the tests that open windows too');
  assert.ok(win.includes(`- name: ${TEST_STEP}\n`), 'a pass is a run whose step of this name passed');
});
