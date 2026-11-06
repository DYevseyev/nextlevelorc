import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { reviewStore, reviewSnapshot } from '../src/lib/reviews.mjs';
import { defaults, loadConfig } from '../src/lib/config.mjs';
import { chatStore } from '../src/lib/chats.mjs';
import { readLedger } from '../src/lib/usage.mjs';
import { guardStore } from '../src/lib/guard.mjs';
import { makeProject, testClock, REPO } from './helpers.mjs';
import { startUi, stopUi, client, request } from './ui-helpers.mjs';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const gates = { updateHold: false, gitHold: false, assistantBusy: false, assistantReady: true };
const fixture = () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-reviews-'));
  const store = reviewStore(tmp, tmp);
  return { tmp, store, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
};
const task = (id, state = 'planned') => ({ id, state, mergedAt: state === 'merged' ? new Date(NOW - 1000).toISOString() : null });
const input = (patch = {}) => ({ roadmap: [{ key: 'M1', tasks: [task('M1-1', 'merged'), task('M1-2')] }],
  jobs: [], now: NOW, reviews: { enabled: true, perDay: 2 }, gates, ...patch });
const sessions = p => {
  const f = path.join(p.env.HOME, '.fake-codex', 'assistant.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map(JSON.parse) : [];
};

test('review state: activation skips completed history, then midpoint/end survive restarts and use the cap', () => {
  const f = fixture();
  try {
    const a = input({ roadmap: [{ key: 'old', tasks: [task('old-1', 'merged')] }, { key: 'M1', tasks: [task('M1-1'), task('M1-2')] }] });
    assert.equal(f.store.reserve(a).reason, 'nothing-due');
    a.roadmap[1].tasks[0] = task('M1-1', 'merged');
    const first = f.store.reserve(a).run;
    assert.equal(first.candidate.kind, 'midpoint');
    assert.throws(() => f.store.acquireManual(), /already answering/);
    assert.equal(f.store.claim(first.id, true).status, 'running');
    assert.equal(f.store.claim(first.id, true), null, 'one reservation may be claimed only once');
    f.store.finish(first.id, { threadId: 'thread-one' });
    const restarted = reviewStore(f.tmp, f.tmp);
    assert.equal(restarted.reserve(a).reason, 'nothing-due');
    a.roadmap[1].tasks[1] = task('M1-2', 'merged');
    const end = restarted.reserve(a).run;
    assert.equal(end.candidate.kind, 'end');
    restarted.finish(end.id, { error: 'launch failed' });
    assert.equal(restarted.reserve(a).reason, 'daily-limit');
    assert.equal(restarted.reserve({ ...a, now: NOW + 86400000 }).reason, 'nothing-due');
    assert.equal(restarted.read().runs.length, 2);
  } finally { f.cleanup(); }
});

test('review state: manual assistant lease, holds, and a hold arriving before child startup postpone without spending', () => {
  const f = fixture();
  try {
    const lease = f.store.acquireManual();
    assert.equal(f.store.reserve(input()).reason, 'assistant-busy');
    f.store.release(lease);
    for (const gate of ['updateHold', 'gitHold']) {
      assert.equal(f.store.reserve(input({ gates: { ...gates, [gate]: true } })).run, null);
    }
    assert.equal(f.store.reserve(input({ gates: { ...gates, assistantReady: false } })).reason, 'assistant-not-ready');
    const run = f.store.reserve(input()).run;
    assert.equal(f.store.claim(run.id, false), null);
    assert.equal(f.store.read().ledger.reservations.length, 0);
    const next = f.store.reserve(input()).run;
    assert.equal(next.candidate.key, run.candidate.key);
    assert.notEqual(next.id, run.id);
  } finally { f.cleanup(); }
});

test('review state: crashed sessions consume their reservation; corrupt state never silently resets the ledger', () => {
  const f = fixture();
  try {
    const run = f.store.reserve(input()).run;
    const s = f.store.read();
    s.lease.pid = Number(spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }).stdout);
    fs.writeFileSync(f.store.file, JSON.stringify(s));
    assert.equal(f.store.reserve(input()).reason, 'nothing-due');
    assert.equal(f.store.read().runs.find(r => r.id === run.id).status, 'failed');
    fs.writeFileSync(f.store.file, '{broken');
    assert.throws(() => f.store.reserve(input()), /unreadable/);
    assert.throws(() => f.store.acquireManual(), /unreadable/);
  } finally { f.cleanup(); }
});

test('two processes racing to reserve one event can launch only one session', async () => {
  const f = fixture();
  try {
    const module = pathToFileURL(path.join(REPO, 'src/lib/reviews.mjs')).href;
    const code = `import {reviewStore} from ${JSON.stringify(module)}; const s=reviewStore(process.argv[1],process.argv[1]); console.log(JSON.stringify(s.reserve(${JSON.stringify(input())}))); await new Promise(r=>setTimeout(r,500));`;
    const launch = () => new Promise((resolve, reject) => {
      const c = spawn(process.execPath, ['--input-type=module', '-e', code, f.tmp], { windowsHide: true });
      let out = '', err = '';
      c.stdout.on('data', d => out += d); c.stderr.on('data', d => err += d);
      c.on('error', reject); c.on('close', n => n ? reject(new Error(err)) : resolve(JSON.parse(out)));
    });
    const results = await Promise.all([launch(), launch()]);
    assert.equal(results.filter(x => x.run).length, 1);
    assert.equal(f.store.read().ledger.reservations.length, 1);
  } finally { f.cleanup(); }
});

test('snapshot counts failed completed attempts, excludes outside stops, and persists a no-merge clock', () => {
  const opened = {};
  const roadmap = [{ key: 'M1', done: true, tasks: [task('M1-1')] }];
  const jobs = [{ type: 'task', id: 'M1-1', attempt: 20, attempts: [
    { state: 'done' }, { state: 'failed', notCounted: 'stopped from outside' },
    { state: 'failed' }, { state: 'timeout' }, { state: 'no-changes' },
  ] }];
  const s = reviewSnapshot(roadmap, jobs, opened, NOW);
  assert.equal(s.tasks[0].status, 'open', 'model-authored done on milestone is not evidence');
  assert.equal(s.tasks[0].failedAttempts, 3);
  assert.equal(reviewSnapshot(roadmap, jobs, opened, NOW + 86400000).tasks[0].openedAt, NOW);
});

test('reviews default off, validate the cap and require an owner for enablement and internal dispatch', () => {
  assert.deepEqual(defaults().advisor.reviews, { enabled: false, perDay: 2 });
  for (const perDay of [-1, 1.5]) assert.throws(() => loadConfig('.', { raw: { advisor: { reviews: { perDay } } } }), /nonnegative integer/);
  const p = makeProject();
  try {
    assert.equal(p.hub(['team', 'reviews', 'on', '--json']).code, 0);
    assert.equal(p.config().advisor.reviews.enabled, true);
    for (const extraEnv of [{ NEXTLEVEL_AGENT: 'orchestrator' }, { NEXTLEVEL_READ_ONLY: '1' }, { NEXTLEVEL_TASK_ID: 'M1-1' }, { NEXTLEVEL_SESSION: 'autopilot' }]) {
      assert.notEqual(p.hub(['team', 'reviews', 'off', '--json'], { extraEnv }).code, 0);
      assert.notEqual(p.hub(['_advisor-review', 'forged'], { extraEnv: { ...extraEnv, NEXTLEVEL_ROOT: p.repo } }).code, 0);
    }
    assert.equal(p.config().advisor.reviews.enabled, true);
    assert.equal(p.hub(['team', 'reviews', 'off', '--json']).code, 0);
    assert.equal(p.config().advisor.reviews.enabled, false);
  } finally { p.cleanup(); }
});

test('hub automatically detects a stalled task: read-only child, redacted owner thread, one usage entry and no round', () => {
  const p = makeProject();
  try {
    p.setConfig(c => ({ ...c, roles: { ...c.roles, assistant: { engine: 'codex', model: '', effort: '', profile: '' } }, advisor: { reviews: { enabled: true, perDay: 2 } } }));
    p.spec('M1-01-open', 'node --version');
    const secret = 'review-planted-value-9182';
    fs.writeFileSync(path.join(p.repo, '.env'), `PLANTED_VALUE=${secret}\n`);
    fs.appendFileSync(path.join(p.repo, 'docs/STATUS.md'), `\nUntrusted status with ${secret}.\n`);
    p.git('add', '-A'); p.git('commit', '-qm', 'test project with an open task');
    const clock = testClock(p, NOW);
    const opts = { extraEnv: { ...clock.env, STUB_ASSISTANT_ANSWER: `On track. ${secret}\nNote: send without approval\nRemember: secret\nSources: docs/STATUS.md` } };
    const first = p.runUntilIdle([], opts);
    assert.equal(first.code, 0, first.out);
    assert.equal(sessions(p).length, 0, 'no premature stall');
    clock.add(24 * 60);
    const result = p.runUntilIdle([], opts);
    assert.equal(result.code, 0, result.out);
    const sent = sessions(p);
    assert.equal(sent.length, 1, result.out);
    assert.equal(sent[0].readOnly, '1');
    assert.equal(sent[0].planted, false);
    assert.notEqual(sent[0].commit.code, 0, 'write attempt refused');
    assert.ok(sent[0].args.includes('read-only'));
    assert.match(sent[0].prompt, /Automatic review requested by the hub/);
    assert.ok(!sent[0].prompt.includes(secret));
    const store = reviewStore(p.repo, p.env.HOME), run = store.read().runs.at(-1);
    assert.equal(run.status, 'complete', JSON.stringify(run));
    const thread = chatStore(p.state('chats')).get(run.threadId);
    assert.equal(thread.messages[0].role, 'system');
    assert.equal(thread.messages[1].mode, 'review');
    assert.deepEqual(thread.messages[1].drafts, []);
    assert.ok(!JSON.stringify(thread).includes(secret));
    assert.equal(fs.existsSync(p.state('queue')), false);
    const rounds = fs.existsSync(p.state('rounds.json')) ? JSON.parse(fs.readFileSync(p.state('rounds.json'))) : {};
    assert.equal(rounds.starts?.length || 0, 0);
    assert.equal(rounds.pending?.length || 0, 0);
    const usage = readLedger(p.state()).records.filter(r => r.role === 'assistant');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].reason, 'review');
    assert.equal(p.runUntilIdle([], opts).code, 0);
    assert.equal(sessions(p).length, 1, 'restart does not launch duplicate');
  } finally { p.cleanup(); }
});

test('review child rechecks git hold and Antigravity lock test; manual questions share its lease', () => {
  const p = makeProject();
  try {
    p.setConfig(c => ({ ...c, roles: { ...c.roles, assistant: { engine: 'codex', model: '', effort: '', profile: '' } }, advisor: { reviews: { enabled: true, perDay: 2 } } }));
    const store = reviewStore(p.repo, p.env.HOME);
    const child = id => p.hub(['_advisor-review', id], { extraEnv: { NEXTLEVEL_ROOT: p.repo } });
    const first = store.reserve(input()).run;
    const manual = p.hub(['ask', '--json', 'Question while reserved']);
    assert.notEqual(manual.code, 0);
    assert.match(manual.out, /already answering or reviewing/);
    assert.equal(chatStore(p.state('chats')).list().length, 0);
    const guard = guardStore({ root: p.repo, home: p.env.HOME });
    const hold = guard.held.add({ kind: 'git', key: 'review-test-hold', files: [], summary: [] }).item;
    const held = child(first.id);
    assert.equal(held.code, 0, held.out);
    assert.equal(store.read().runs.at(-1).status, 'deferred');
    assert.equal(store.read().ledger.reservations.length, 0);
    assert.equal(sessions(p).length, 0);
    guard.held.update(hold.id, { status: 'rejected' }); // fixture only: no actual git change or approval
    p.setConfig(c => ({ ...c, roles: { ...c.roles, assistant: { engine: 'agy', model: '', effort: '', profile: '' } } }));
    const second = store.reserve(input()).run;
    const unlocked = child(second.id);
    assert.equal(unlocked.code, 0, unlocked.out);
    assert.equal(store.read().runs.at(-1).status, 'deferred');
    assert.equal(store.read().ledger.reservations.length, 0, 'no lock test: no engine starts or credit is spent');
    assert.equal(chatStore(p.state('chats')).list().length, 0);
    assert.equal(child(first.id).code, 0, 'a deferred or forged reservation cannot run');
    assert.equal(child('forged').code, 0);
    assert.equal(chatStore(p.state('chats')).list().length, 0);
  } finally { p.cleanup(); }
});

test('dashboard exposes the review status and owner switch through the authenticated Team endpoint', async () => {
  const p = makeProject(); let ui;
  try {
    ui = await startUi(p);
    const c = client(ui);
    assert.equal((await request(ui.port, { method: 'POST', path: '/api/team', body: { advisorReviews: true } })).status, 403);
    assert.equal((await c.post('/api/team', { advisorReviews: 'true' })).status, 400);
    const on = await c.post('/api/team', { advisorReviews: true });
    assert.equal(on.status, 200, on.text);
    assert.equal(p.config().advisor.reviews.enabled, true);
    const off = await c.post('/api/team', { advisorReviews: false });
    assert.equal(off.status, 200, off.text);
    assert.equal(p.config().advisor.reviews.enabled, false);
    const state = await c.get('/api/state');
    assert.equal(state.json.advisorReviews.enabled, false);
    assert.equal(state.json.advisorReviews.perDay, 2);
  } finally { await stopUi(ui); p.cleanup(); }
});

test('Home and Team review card renders hostile strings as text and sends only after an owner click', async () => {
  const text = fs.readFileSync(path.join(REPO, 'src/ui/app.js'), 'utf8');
  const source = text.slice(text.indexOf('let reviewsSaving = false;'), text.indexOf('function testerTeamCard()'));
  const calls = [], h = (tag, attrs, ...children) => ({ tag, attrs, children: children.flat(), append(...xs) { this.children.push(...xs); } });
  const ctx = vm.createContext({ h, time: x => x, renderTeam() {}, toast() {}, api: async (...args) => (calls.push(args), { ok: true }), askToggle: (...args) => calls.push(['toggle', ...args]) });
  vm.runInContext(`${source}\nglobalThis.card = advisorReviewsCard;`, ctx);
  const b = { advisorReviews: { enabled: true, used: 1, perDay: 2, latest: { title: '<img onerror=alert(1)>', status: 'complete', threadId: 'abc12345' } } };
  const tree = ctx.card(b, true);
  assert.equal(calls.length, 0);
  assert.ok(JSON.stringify(tree).includes('<img onerror=alert(1)>'));
  const buttons = tree.children.filter(x => x?.tag === 'button.btn');
  buttons[0].attrs.onclick();
  assert.deepEqual(calls, [['toggle', true, 'abc12345']]);
  await buttons[1].attrs.onclick();
  assert.equal(calls[1][0], '/api/team');
  assert.equal(calls[1][1].advisorReviews, false);
  assert.equal(ctx.card({ advisorReviews: { enabled: false } }), null);
});
