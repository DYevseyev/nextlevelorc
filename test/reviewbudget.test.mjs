import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { planReview, emptyReviewLedger } from '../src/lib/reviewpolicy.mjs';
import { guardStore } from '../src/lib/guard.mjs';
import { makeProject, REPO } from './helpers.mjs';
import { client, request, startUi, stopUi } from './ui-helpers.mjs';

test('the owner changes the review cap without enabling reviews or losing other settings; bad values and agent writes change nothing', () => {
  const p = makeProject();
  try {
    p.setConfig(c => ({ ...c, name: 'owners-project', advisor: { reviews: { enabled: false, perDay: 2 } } }));
    const change = (value, extraEnv) => p.hub(['team', 'reviews', '--per-day', value, '--json'], { extraEnv });
    const saved = change('5');
    assert.equal(saved.code, 0, saved.out);
    assert.deepEqual(p.config().advisor.reviews, { enabled: false, perDay: 5 });
    assert.equal(p.config().name, 'owners-project');
    assert.equal(change('0').code, 0);
    assert.equal(p.config().advisor.reviews.perDay, 0);
    const on = p.hub(['team', 'reviews', 'on', '--per-day', '3', '--json']);
    assert.equal(on.code, 0, on.out);
    assert.deepEqual(p.config().advisor.reviews, { enabled: true, perDay: 3 });
    const file = path.join(p.repo, 'nextlevel.json');
    const before = fs.readFileSync(file, 'utf8');
    for (const invalid of ['', '-1', '1.5', '1e3', 'Infinity', '9007199254740992']) {
      assert.notEqual(change(invalid).code, 0, invalid);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    for (const extraEnv of [{ NEXTLEVEL_AGENT: 'orchestrator' }, { NEXTLEVEL_READ_ONLY: '1' }, { NEXTLEVEL_TASK_ID: 'M1-1' }, { NEXTLEVEL_SESSION: 'autopilot' }]) {
      assert.notEqual(change('9', extraEnv).code, 0);
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    }
    assert.equal(p.hub(['team', 'reviews', '--per-day', '9', '--help']).code, 0);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'help never changes the cap');
    assert.deepEqual(JSON.parse(p.hub(['team', 'reviews', '--json']).out).reviews, { enabled: true, perDay: 3 });
  } finally { p.cleanup(); }
});

test('changing the review cap refuses an unapproved concurrent configuration edit', () => {
  const p = makeProject();
  try {
    const guard = guardStore({ root: p.repo, home: p.env.HOME });
    guard.open('test:review-budget', { what: 'a test round' });
    const file = path.join(p.repo, 'nextlevel.json');
    const edited = JSON.stringify({ ...p.config(), name: 'concurrent-edit' }, null, 2);
    fs.writeFileSync(file, edited);
    const refused = p.hub(['team', 'reviews', '--per-day', '5', '--json']);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /changed while the orchestrator is at work/);
    assert.equal(fs.readFileSync(file, 'utf8'), edited);
    guard.close('test:review-budget');
  } finally { p.cleanup(); }
});

test('lowering and raising the daily cap preserves spent credits and pending review events', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const snapshot = { lastMergeAt: null, milestones: [], tasks: ['a', 'b'].map(id => ({ id, status: 'open', openedAt: now, failedAttempts: 3 })) };
  const gates = { updateHold: false, gitHold: false, assistantBusy: false, assistantReady: true };
  const plan = (perDay, ledger) => planReview({ now, snapshot, gates, ledger, reviews: { enabled: true, perDay } });
  const first = plan(2, emptyReviewLedger());
  assert.equal(first.candidate.taskId, 'a');
  for (const limit of [0, 1]) {
    const held = plan(limit, first.nextLedger);
    assert.equal(held.reason, 'daily-limit');
    assert.deepEqual(held.nextLedger, first.nextLedger);
  }
  const second = plan(2, first.nextLedger);
  assert.equal(second.candidate.taskId, 'b');
  assert.equal(second.nextLedger.reservations.length, 2);
});

test('the authenticated Team endpoint saves only valid review limits and preserves the switch', async () => {
  const p = makeProject(); let ui;
  try {
    ui = await startUi(p);
    const c = client(ui);
    const body = { advisorReviewsPerDay: 4 };
    assert.equal((await request(ui.port, { method: 'POST', path: '/api/team', body })).status, 403);
    for (const value of [-1, 1.5, '', '4', null, true, 9007199254740992]) {
      assert.equal((await c.post('/api/team', { advisorReviewsPerDay: value })).status, 400, String(value));
    }
    const saved = await c.post('/api/team', body);
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(p.config().advisor.reviews, { enabled: false, perDay: 4 });
    const both = await c.post('/api/team', { advisorReviews: true, advisorReviewsPerDay: 0 });
    assert.equal(both.status, 200, both.text);
    assert.deepEqual(p.config().advisor.reviews, { enabled: true, perDay: 0 });
    const bad = await c.post('/api/team', { advisorReviews: false, advisorReviewsPerDay: -1 });
    assert.equal(bad.status, 400);
    assert.deepEqual(p.config().advisor.reviews, { enabled: true, perDay: 0 });
    const state = await c.get('/api/state');
    assert.equal(state.json.advisorReviews.perDay, 0);
    assert.equal(state.json.advisorReviews.enabled, true);
  } finally { await stopUi(ui); p.cleanup(); }
});

test('Team edits the cap only after Save, rejects invalid input locally, and Home explains a zero cap', async () => {
  const text = fs.readFileSync(path.join(REPO, 'src/ui/app.js'), 'utf8');
  const source = text.slice(text.indexOf('let reviewsSaving = false;'), text.indexOf('function testerTeamCard()'));
  const calls = [];
  const h = (tag, attrs, ...children) => ({ tag, attrs, value: attrs.value ?? '', children: children.flat(), append(...xs) { this.children.push(...xs); } });
  const ctx = vm.createContext({ h, time: x => x, renderTeam() {}, toast() {}, api: async (...args) => (calls.push(args), { ok: true }), askToggle() {} });
  vm.runInContext(`${source}\nglobalThis.card = advisorReviewsCard;`, ctx);
  const tree = ctx.card({ advisorReviews: { enabled: false, used: 1, perDay: 2 } }, true);
  const all = node => [node, ...(node.children || []).flatMap(x => x && typeof x === 'object' ? all(x) : [])];
  const nodes = all(tree);
  const input = nodes.find(x => x.tag.startsWith('input'));
  const save = nodes.find(x => x.tag.startsWith('button') && x.children.includes('Save daily limit'));
  assert.ok(input && save, 'Team offers a daily-limit input and Save');
  assert.equal(calls.length, 0);
  for (const invalid of ['', '-1', '1.5', '1e3']) {
    input.value = invalid;
    await save.attrs.onclick();
    assert.equal(calls.length, 0);
  }
  input.value = '0';
  await save.attrs.onclick();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/team');
  assert.equal(calls[0][1].advisorReviewsPerDay, 0);
  assert.equal(Object.hasOwn(calls[0][1], 'advisorReviews'), false, 'changing the cap does not toggle reviews');
  const home = ctx.card({ advisorReviews: { enabled: true, used: 1, perDay: 0, waiting: 'daily-limit' } });
  assert.match(JSON.stringify(home), /No new reviews start while the daily limit is 0/);
  assert.doesNotMatch(JSON.stringify(home), /due events wait until the next UTC day/);
});
