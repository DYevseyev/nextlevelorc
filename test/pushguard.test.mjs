// A push that carries a change to a protected file (a review, 14 October): GitHub runs a pushed branch's
// own workflows, so a worker's change to .github/workflows/ci.yml ran on GitHub as soon as the orchestrator pushed its
// branch (nextlevel push ci/m1-07 --from task/M1-07), before the owner saw it at the task's merge. Every push now reads
// what it changes in protected files compared with the base branch, and one with a change the owner hasn't approved waits
// for the owner's Approve on the dashboard, like a push to a deploy branch; the owner decides each change once, on the
// push's card or on the task's merge card. Each project here has a local bare repository as its origin, never a real
// remote, and the stub engines.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { guardDir, recordOwner } from '../src/lib/guard.mjs';
import { isAlive, makeProject, sleep, waitUntil } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const WORKFLOW = '.github/workflows/ci.yml';
const WORKFLOW_TEXT = 'name: ci\non: push\npermissions:\n  contents: write\njobs:\n  test:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo guard-test\n';
const FINAL = new Set(['done', 'failed', 'blocked']);

const heldRecords = (p) => {
  const f = path.join(guardDir(p.repo, p.env.HOME), 'held.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items : [];
};
const pushRecords = (p) => heldRecords(p).filter((x) => x.kind === 'push');
const guardCards = (p) => (fs.existsSync(p.state('handoff.json')) ? JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items.filter((x) => x.guard) : []);
const remoteHead = (p, branch) => remoteBranches(p).includes(branch) ? p.git('--git-dir', p.remote, 'rev-parse', `refs/heads/${branch}`) : '';
const remoteBranches = (p) => p.git('--git-dir', p.remote, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads').split('\n').filter(Boolean);

// A branch made from `from` with one commit that writes `files` ({ path: text }); the project stays on main. -> its tip
function branch(p, name, files, { from = 'main', message = `${name}: work` } = {}) {
  p.git('checkout', '-q', '-b', name, from);
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(p.repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(p.repo, rel), text);
    p.git('add', '--', rel);
  }
  p.git('commit', '-qm', message);
  const tip = p.git('rev-parse', 'HEAD');
  p.git('checkout', '-q', 'main');
  return tip;
}
// A commit on a branch that exists, the project staying on main. -> its tip
function moveBranch(p, name, rel, text) {
  p.git('checkout', '-q', name);
  fs.writeFileSync(path.join(p.repo, rel), text);
  p.git('add', '--', rel);
  p.git('commit', '-qm', `${name}: more`);
  const tip = p.git('rev-parse', 'HEAD');
  p.git('checkout', '-q', 'main');
  return tip;
}

// The hub in the background (it serves merges, which wait for it); stop() ends it
async function startHub(p) {
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  await waitUntil('the hub is up', () => fs.existsSync(p.state('hub.json')), 20_000);
  return {
    async stop() {
      bg.kill();
      for (let i = 0; i < 25 && isAlive(bg.pid); i++) await sleep(200);
      fs.rmSync(p.state('hub.json'), { force: true });
    },
  };
}
// nextlevel push ...: the push job's id, once the hub has decided it (its final state)
async function push(p, args) {
  const q = p.hub(['push', ...args]);
  assert.equal(q.code, 0, q.out);
  const id = q.out.match(/queued (push-\S+):/)[1];
  await waitUntil(`${id} decided`, () => {
    try {
      return FINAL.has(p.status(id).state);
    } catch {
      return false;
    }
  });
  return { id, out: q.out, s: p.status(id) };
}
// A hub job that ends a decision of the owner's (an approval's push, a merge) has run: its state is final
async function settled(p, check, what) {
  await waitUntil(what, check, 60_000);
}
const setup = () => {
  const p = makeProject();
  p.git('push', '-q', 'origin', 'main');
  return p;
};

test("the reproduction, turned around: a task branch that adds a workflow waits with a card that names the file and shows its diff; nothing reaches origin; wait says blocked; Approve pushes exactly that commit, and the task's merge needs no second card", async () => {
  const p = setup();
  const hub = await startHub(p);
  let ui;
  try {
    const main0 = p.git('rev-parse', 'HEAD');
    const tip = branch(p, 'task/M1-07', { [WORKFLOW]: WORKFLOW_TEXT }, { message: 'M1-07: fix CI' });
    const { id, out, s } = await push(p, ['ci/m1-07', '--from', 'task/M1-07']);
    assert.match(out, /task\/M1-07 changes protected file compared with origin's main \(\.github\/workflows\/ci\.yml\): unless the owner has approved that change already, nothing is pushed yet/);
    assert.equal(s.state, 'blocked', s.detail);
    assert.ok(!remoteBranches(p).includes('ci/m1-07'), 'nothing reached origin');
    const [rec] = pushRecords(p);
    assert.equal(rec.status, 'held');
    assert.deepEqual([rec.target, rec.from, rec.sha, rec.task, rec.deploy, rec.files.map((f) => f.path)], ['ci/m1-07', 'task/M1-07', tip, 'M1-07', false, [WORKFLOW]]);
    assert.match(s.detail, new RegExp(`^not pushed yet: the push changes \\.github/workflows/ci\\.yml, protected file, so the owner approves the push first, on the dashboard \\(${rec.id}, card ${rec.card}\\): 2 commit\\(s\\) of task/M1-07 at ${tip.slice(0, 7)}\\. Only that approval pushes it; carry on with other work meanwhile\\. A change to a protected file is best in a task of its own`));
    // The card: the file in plain words and its diff, and the commits
    assert.equal(rec.summary[0], `Push to ci/m1-07 on origin (${p.remote}): it changes protected file (${WORKFLOW}) compared with origin's main, and you haven't approved that change: GitHub runs a pushed branch's own workflows, and the agents and your tools load these files outside any sandbox`);
    assert.ok(rec.summary.includes("What it changes in protected files, compared with origin's main:"), rec.summary.join('\n'));
    assert.match(rec.summary.join('\n'), /\.github\/workflows\/ci\.yml: added[\s\S]*echo guard-test/);
    assert.match(rec.diff, /^\+permissions:$/m);
    assert.match(rec.diff, /^\+ {6}- run: echo guard-test$/m);
    assert.match(rec.log, /^\w{7} [\d-]+ M1-07: fix CI$/m);
    const card = guardCards(p).find((c) => c.id === rec.card);
    assert.equal(card.what, `Approve or reject: A push of 2 commit(s) to ci/m1-07 on origin that changes ${WORKFLOW} (${rec.id})`);
    // wait says blocked, with the card
    const w = p.hub(['wait', id, '--minutes', '1']);
    assert.match(w.out, /blocked/);
    assert.match(w.out, new RegExp(`card ${rec.card}`));
    // Asking again: the same card
    assert.equal((await push(p, ['ci/m1-07', '--from', 'task/M1-07'])).s.state, 'blocked');
    assert.equal(pushRecords(p).length, 1);

    // The dashboard: the card with the change, the commits, Approve
    ui = await startUi(p);
    const c = client(ui);
    const g = (await c.get('/api/cards')).json.guard.find((x) => x.id === rec.id);
    assert.deepEqual([g.kind, g.deploy, g.files, g.status], ['push', false, [WORKFLOW], 'held']);
    assert.match(g.why, /^This push to ci\/m1-07 carries a change you haven't approved: it changes \.github\/workflows\/ci\.yml, protected/);
    assert.match(g.diff, /echo guard-test/);
    assert.match(g.log, /M1-07: fix CI/);
    const state = (await c.get('/api/state')).json;
    assert.ok(state.needs.some((n) => n.kind === 'guard' && n.text.startsWith(`A push of 2 commit(s) to ci/m1-07 on origin that changes ${WORKFLOW}`)), JSON.stringify(state.needs));
    const ok = await c.post('/api/guard', { action: 'approve', id: rec.id });
    assert.equal(ok.status, 200, ok.text);
    await settled(p, () => pushRecords(p)[0].status === 'applied', 'the approved push went out');
    assert.equal(remoteHead(p, 'ci/m1-07'), tip, 'exactly that commit');
    assert.equal(remoteHead(p, 'main'), main0);

    // One decision per change: the task's merge goes in with no second card
    const m = p.hub(['merge', 'M1-07']);
    assert.equal(m.code, 0, m.out);
    assert.match(m.out, /merged task\/M1-07/);
    assert.match(p.git('log', '-1', '--format=%B'), new RegExp(`Its change to \\.github/workflows/ci\\.yml was approved by the owner \\(${rec.id}, on the card of a push to ci/m1-07\\)`));
    assert.equal(heldRecords(p).filter((x) => x.kind === 'merge').length, 0, 'no merge card');
    assert.equal(guardCards(p).length, 1);
    assert.equal(pushRecords(p)[0].status, 'applied', "the merge doesn't rewrite the push's record");
  } finally {
    await stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});

test('Reject pushes nothing and the job gives the owner\'s reason; the task\'s merge then refuses; a branch that moved after its card makes a new card ask again', async () => {
  const p = setup();
  const hub = await startHub(p);
  let ui;
  try {
    branch(p, 'task/M1-07', { [WORKFLOW]: WORKFLOW_TEXT });
    const first = await push(p, ['ci/m1-07', '--from', 'task/M1-07']);
    const [rec] = pushRecords(p);
    ui = await startUi(p);
    const c = client(ui);
    const no = await c.post('/api/guard', { action: 'reject', id: rec.id, reason: 'no workflow changes from tasks' });
    assert.equal(no.status, 200, no.text);
    assert.equal(p.status(first.id).state, 'failed');
    assert.match(p.status(first.id).detail, new RegExp(`^not pushed: the owner rejected the push to ci/m1-07 \\(${rec.id}, card ${rec.card}\\): "no workflow changes from tasks"$`));
    assert.ok(!remoteBranches(p).includes('ci/m1-07'));
    // The same change again, by another branch name: refused at once, no new card
    const again = await push(p, ['ci/other', '--from', 'task/M1-07']);
    assert.equal(again.s.state, 'failed');
    assert.match(again.s.detail, new RegExp(`^not pushed: the owner rejected this change to \\.github/workflows/ci\\.yml on the card of a push to ci/m1-07 \\(${rec.id}, card ${rec.card}\\): "no workflow changes from tasks"`));
    // ... and at the task's merge
    const m = p.hub(['merge', 'M1-07']);
    assert.equal(m.code, 1, m.out);
    assert.match(m.out, new RegExp(`not merged: the owner rejected M1-07's change to \\.github/workflows/ci\\.yml \\(${rec.id}, on the card of a push to ci/m1-07\\): "no workflow changes from tasks"`));
    assert.equal(guardCards(p).length, 1);
    assert.deepEqual(remoteBranches(p), ['main']);

    // Another task: its card, then the branch moves, then the owner approves: nothing pushed, a new card asks again
    const a = branch(p, 'task/M1-08', { '.github/workflows/lint.yml': 'name: lint\non: push\njobs: {}\n' });
    await push(p, ['ci/m1-08', '--from', 'task/M1-08']);
    const g1 = pushRecords(p).find((x) => x.from === 'task/M1-08');
    assert.equal(g1.sha, a);
    const b = moveBranch(p, 'task/M1-08', 'notes.txt', 'more work\n');
    const moved = await c.post('/api/guard', { action: 'approve', id: g1.id });
    assert.equal(moved.status, 200, moved.text);
    assert.match(moved.json.message, /^task\/M1-08 moved since this card was made/);
    await settled(p, () => pushRecords(p).filter((x) => x.from === 'task/M1-08').length === 2, 'a new card');
    const [, g2] = pushRecords(p).filter((x) => x.from === 'task/M1-08');
    assert.equal(pushRecords(p).find((x) => x.id === g1.id).status, 'superseded');
    assert.deepEqual([g2.status, g2.sha, g2.files.map((f) => f.path)], ['held', b, ['.github/workflows/lint.yml']]);
    assert.match(g2.summary.at(-1), new RegExp(`^This card asks again: task/M1-08 moved \\(${a.slice(0, 7)} -> ${b.slice(0, 7)}\\) after you approved ${g1.id}`));
    assert.ok(!remoteBranches(p).includes('ci/m1-08'), 'nothing pushed meanwhile');
    assert.equal((await c.post('/api/guard', { action: 'approve', id: g2.id })).status, 200);
    await settled(p, () => remoteHead(p, 'ci/m1-08') === b, 'the second approval pushed');
  } finally {
    await stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});

test("no card when nothing protected changes: backup/main, a CI branch made from main (main's workflow on origin already, or one the owner made and hasn't pushed), and a task branch that changes only ordinary files", async () => {
  const p = setup();
  const hub = await startHub(p);
  try {
    // main itself has a workflow the owner committed: a branch made from main carries no change to it
    fs.mkdirSync(path.join(p.repo, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, WORKFLOW), WORKFLOW_TEXT);
    p.git('add', '--', WORKFLOW);
    p.git('commit', '-qm', "the owner's CI");
    p.git('push', '-q', 'origin', 'main'); // (the owner's own push, outside nextlevel: origin's main has it)
    // ... and one the owner wrote (the Team page, the doctor: recorded as the owner's) and committed, not on origin yet
    const LINT = '.github/workflows/lint.yml';
    fs.writeFileSync(path.join(p.repo, LINT), 'name: lint\non: push\njobs: {}\n');
    assert.ok(recordOwner(p.repo, [LINT], { home: p.env.HOME, env: {} }));
    p.git('add', '--', LINT);
    p.git('commit', '-qm', "the owner's lint");
    const main1 = p.git('rev-parse', 'HEAD');
    const backup = await push(p, ['backup/main']);
    assert.equal(backup.s.state, 'done', backup.s.detail);
    assert.doesNotMatch(backup.out, /protected/);
    const ci = branch(p, 'ci/m1-gates', { 'gates.txt': 'gates\n' });
    const gates = await push(p, ['ci/m1-gates', '--from', 'ci/m1-gates']);
    assert.equal(gates.s.state, 'done', gates.s.detail);
    const ordinary = branch(p, 'task/M1-09', { 'src/page.txt': 'a page\n' });
    const task = await push(p, ['ci/m1-09', '--from', 'task/M1-09']);
    assert.equal(task.s.state, 'done', task.s.detail);
    assert.deepEqual([remoteHead(p, 'backup/main'), remoteHead(p, 'ci/m1-gates'), remoteHead(p, 'ci/m1-09')], [main1, ci, ordinary]);
    assert.deepEqual(pushRecords(p), []);
    assert.deepEqual(guardCards(p), []);
  } finally {
    await hub.stop();
    p.cleanup();
  }
});

test("one decision per change at the merge: approved on the task's merge card, a later push of that change needs no card; rejected there, the push refuses", async () => {
  const p = setup();
  const hub = await startHub(p);
  let ui;
  try {
    const tip = branch(p, 'task/M2-01', { [WORKFLOW]: WORKFLOW_TEXT });
    // The same change on a branch of its own (made from main as it was), for after the merge
    const twin = branch(p, 'ci/m2-01', { [WORKFLOW]: WORKFLOW_TEXT });
    const held = p.hub(['merge', 'M2-01']);
    assert.equal(held.code, 1, held.out);
    const mrec = heldRecords(p).find((x) => x.kind === 'merge');
    ui = await startUi(p);
    const c = client(ui);
    assert.equal((await c.post('/api/guard', { action: 'approve', id: mrec.id })).status, 200);
    await settled(p, () => heldRecords(p).find((x) => x.id === mrec.id).status === 'applied', 'the approved merge');
    const pushed = await push(p, ['ci/m2-01', '--from', 'ci/m2-01']);
    assert.equal(pushed.s.state, 'done', pushed.s.detail);
    assert.equal(remoteHead(p, 'ci/m2-01'), twin);
    const fromTask = await push(p, ['ci/m2-01-task', '--from', 'task/M2-01']);
    assert.equal(fromTask.s.state, 'done', fromTask.s.detail);
    assert.equal(remoteHead(p, 'ci/m2-01-task'), tip);
    assert.deepEqual(pushRecords(p), []);

    // Rejected at the merge: a push of that task's change refuses, with no card
    branch(p, 'task/M2-02', { '.github/workflows/deploy.yml': 'name: deploy\non: push\njobs: {}\n' });
    assert.equal(p.hub(['merge', 'M2-02']).code, 1);
    const r2 = heldRecords(p).find((x) => x.kind === 'merge' && x.task === 'M2-02');
    assert.equal((await c.post('/api/guard', { action: 'reject', id: r2.id, reason: 'no deploy workflow' })).status, 200);
    const refused = await push(p, ['ci/m2-02', '--from', 'task/M2-02']);
    assert.equal(refused.s.state, 'failed');
    assert.match(refused.s.detail, new RegExp(`^not pushed: the owner rejected this change to \\.github/workflows/deploy\\.yml on task M2-02's merge card \\(${r2.id}, card ${r2.card}\\): "no deploy workflow"`));
    assert.deepEqual(pushRecords(p), []);
    assert.ok(!remoteBranches(p).includes('ci/m2-02'));
  } finally {
    await stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});

test("a change asked about on both cards is decided once: the push's card decides it, and the merge's card closes saying where", async () => {
  const p = setup();
  const hub = await startHub(p);
  let ui;
  try {
    branch(p, 'task/M2-03', { 'CLAUDE.md': '# rules\nrun echo guard-test\n' });
    assert.equal(p.hub(['merge', 'M2-03']).code, 1);
    const mrec = heldRecords(p).find((x) => x.kind === 'merge');
    const first = await push(p, ['ci/m2-03', '--from', 'task/M2-03']);
    assert.equal(first.s.state, 'blocked');
    const prec = pushRecords(p)[0];
    ui = await startUi(p);
    assert.equal((await client(ui).post('/api/guard', { action: 'reject', id: prec.id, reason: 'not this' })).status, 200);
    const m = heldRecords(p).find((x) => x.id === mrec.id);
    assert.equal(m.status, 'superseded');
    assert.match(m.detail, new RegExp(`the owner rejected this change on the card of a push to ci/m2-03 \\(${prec.id}\\)`));
    assert.match(guardCards(p).find((x) => x.id === mrec.card).thread.at(-1).text, /^Decided on the card of a push to ci\/m2-03/);
    const again = p.hub(['merge', 'M2-03']);
    assert.equal(again.code, 1);
    assert.match(again.out, /not merged: the owner rejected M2-03's change to CLAUDE\.md/);
  } finally {
    await stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});

test('a branch with no history in common with main is compared with nothing: its workflow waits with a card', async () => {
  const p = setup();
  const hub = await startHub(p);
  try {
    // (a worker can make one in its slot: git checkout --orphan)
    p.git('checkout', '-q', '--orphan', 'task/M4-01');
    p.git('rm', '-rq', '--cached', '.');
    fs.mkdirSync(path.join(p.repo, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, WORKFLOW), WORKFLOW_TEXT);
    p.git('add', '--', WORKFLOW);
    p.git('commit', '-qm', 'M4-01: CI from nothing');
    const tip = p.git('rev-parse', 'HEAD');
    p.git('checkout', '-q', '-f', 'main');
    p.git('clean', '-qfd', '--', '.github');
    const { s } = await push(p, ['ci/m4-01', '--from', 'task/M4-01']);
    assert.equal(s.state, 'blocked', s.detail);
    const [rec] = pushRecords(p);
    assert.deepEqual([rec.sha, rec.files.map((f) => f.path)], [tip, [WORKFLOW]]);
    assert.match(rec.diff, /^\+ {6}- run: echo guard-test$/m);
    assert.ok(!remoteBranches(p).includes('ci/m4-01'), 'nothing reached origin');
  } finally {
    await hub.stop();
    p.cleanup();
  }
});

test("a worker that moves the local main to its own commit (the slots share the main checkout's refs) still gets a card: a push is compared with origin's main", async () => {
  const p = setup();
  const hub = await startHub(p);
  try {
    const main0 = p.git('rev-parse', 'HEAD');
    const tip = branch(p, 'task/M4-02', { [WORKFLOW]: WORKFLOW_TEXT });
    // what a worker could run in its slot: the main checkout's main is now its commit
    p.git('update-ref', 'refs/heads/main', tip);
    for (const [target, from] of [['ci/m4-02', 'task/M4-02'], ['backup/main', 'main']]) {
      const { s } = await push(p, [target, '--from', from]);
      assert.equal(s.state, 'blocked', `${target}: ${s.detail}`);
      assert.ok(!remoteBranches(p).includes(target), `${target}: nothing reached origin`);
    }
    assert.deepEqual(pushRecords(p).map((x) => [x.target, x.sha, x.files.map((f) => f.path).join()]), [['ci/m4-02', tip, WORKFLOW], ['backup/main', tip, WORKFLOW]]);
    assert.equal(remoteHead(p, 'main'), main0);
  } finally {
    await hub.stop();
    p.cleanup();
  }
});

test('a push to a deploy branch that also carries a protected change gets one card, which says both', async () => {
  const p = setup();
  const hub = await startHub(p);
  let ui;
  try {
    const main0 = p.git('rev-parse', 'HEAD');
    const tip = branch(p, 'task/M3-01', { [WORKFLOW]: WORKFLOW_TEXT });
    const { s } = await push(p, ['main', '--from', 'task/M3-01']);
    assert.equal(s.state, 'blocked');
    const recs = pushRecords(p);
    assert.equal(recs.length, 1);
    const [rec] = recs;
    assert.equal(guardCards(p).length, 1);
    assert.deepEqual([rec.deploy, rec.files.map((f) => f.path)], [true, [WORKFLOW]]);
    assert.match(s.detail, /^not pushed yet: main is a deploy branch and the push changes \.github\/workflows\/ci\.yml, protected, so the owner approves the push first/);
    assert.match(rec.summary[0], /^Push to main on origin \(.*\), a deploy branch: deployBranches in nextlevel\.json names it; and it changes protected file \(\.github\/workflows\/ci\.yml\) compared with origin's main/);
    assert.equal(guardCards(p)[0].what, `Approve or reject: A push of 1 commit(s) to main on origin, a deploy branch, that changes ${WORKFLOW} (${rec.id})`);
    ui = await startUi(p);
    const g = (await client(ui).get('/api/cards')).json.guard.find((x) => x.id === rec.id);
    assert.match(g.why, /^A push to main may deploy, and it changes \.github\/workflows\/ci\.yml, protected/);
    assert.equal(remoteHead(p, 'main'), main0);
    assert.equal((await client(ui).post('/api/guard', { action: 'approve', id: rec.id })).status, 200);
    await settled(p, () => remoteHead(p, 'main') === tip, 'the approved push');
  } finally {
    await stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});

// A value from .env in what a push sends (docs/design/antigravity-roles.md): an orchestrator that writes git itself
// (Antigravity) commits without the hub's own scan, so every push looks at each commit that goes out. A value that origin
// has already holds no later push; the card never shows the value; Reject refuses the push, saying what to do.
test('a push whose commits carry a value from .env waits for the owner, the value never shown; one origin has already holds nothing; Reject refuses the push and says how to take it out', async () => {
  const VALUE = 'zq7-made-up-service-token-48151623';
  const p = setup();
  fs.writeFileSync(path.join(p.repo, '.env'), `SERVICE_TOKEN=${VALUE}\n`);
  const hub = await startHub(p);
  let ui;
  try {
    // a commit with the value, and a later one that takes it out again: the value still goes out with the first
    p.git('checkout', '-q', '-b', 'work');
    fs.writeFileSync(path.join(p.repo, 'config.js'), `export const token = '${VALUE}';\n`);
    p.git('add', 'config.js');
    p.git('commit', '-qm', 'work: the token, by mistake');
    fs.writeFileSync(path.join(p.repo, 'config.js'), 'export const token = process.env.SERVICE_TOKEN;\n');
    p.git('commit', '-qam', 'work: read it from the environment');
    p.git('checkout', '-q', 'main');
    const held = await push(p, ['work', '--from', 'work']);
    assert.equal(held.s.state, 'blocked', held.s.detail);
    assert.match(held.s.detail, /^not pushed: the commits of work carry the value of SERVICE_TOKEN from \.env in config\.js: nextlevel pushes it only once the owner approves that on the dashboard/);
    assert.ok(!remoteBranches(p).includes('work'), 'nothing reached origin');
    const rec = heldRecords(p).find((x) => x.kind === 'secret');
    assert.deepEqual([rec.on, rec.target, rec.from, rec.files.map((f) => f.path)], ['push', 'work', 'work', ['config.js']]);
    assert.ok(!JSON.stringify(rec).includes(VALUE), 'the card never has the value');
    ui = await startUi(p);
    const c = client(ui);
    const no = await c.post('/api/guard', { action: 'reject', id: rec.id, reason: 'not that token' });
    assert.equal(no.status, 200, no.text);
    assert.match(no.json.message, /Rejected: nothing goes out with it/);
    const again = await push(p, ['work', '--from', 'work']);
    assert.equal(again.s.state, 'failed');
    assert.match(again.s.detail, /the owner rejected that .* Take it out of those commits \(git revert, or rewrite the branch before it is pushed\), then push again/);
    assert.ok(!remoteBranches(p).includes('work'));
    // A value origin has already (the owner pushed it): a later push of other work isn't held for it
    p.git('push', '-q', 'origin', 'work:refs/heads/old');
    p.git('checkout', '-q', '-b', 'more', 'work');
    fs.writeFileSync(path.join(p.repo, 'more.txt'), 'more\n');
    p.git('add', 'more.txt');
    p.git('commit', '-qm', 'more: other work');
    p.git('checkout', '-q', 'main');
    const later = await push(p, ['old', '--from', 'more']);
    assert.equal(later.s.state, 'done', later.s.detail);
  } finally {
    await stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});

test("a value from .env that main brought into a branch through git merge isn't read as new on that branch's push", async () => {
  const VALUE = 'zq7-made-up-public-key-27182818';
  const p = setup();
  fs.writeFileSync(path.join(p.repo, '.env'), `PUBLIC_KEY=${VALUE}\n`);
  const hub = await startHub(p);
  try {
    p.git('checkout', '-q', '-b', 'work');
    fs.writeFileSync(path.join(p.repo, 'work.txt'), 'work\n');
    p.git('add', 'work.txt');
    p.git('commit', '-qm', 'work: its own change');
    // main gets the value (the owner put it there and pushed it), and work merges main in
    p.git('checkout', '-q', 'main');
    fs.writeFileSync(path.join(p.repo, 'key.js'), `export const key = '${VALUE}';\n`);
    p.git('add', 'key.js');
    p.git('commit', '-qm', 'main: the public key');
    p.git('push', '-q', 'origin', 'main');
    p.git('checkout', '-q', 'work');
    p.git('merge', '-q', '--no-edit', '--no-ff', 'main');
    p.git('checkout', '-q', 'main');
    const r = await push(p, ['work', '--from', 'work']);
    assert.equal(r.s.state, 'done', r.s.detail);
    assert.equal(heldRecords(p).filter((x) => x.kind === 'secret').length, 0);
  } finally {
    await hub.stop();
    p.cleanup();
  }
});
