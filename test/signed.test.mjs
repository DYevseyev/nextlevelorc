// Signed requests (FR-017 part 2B, 2B-1b; docs/design/FR-017-part2B.md 3.2 and 5): what the commands, the dashboard and
// the hub write for the hub to act on (a queue job, an outbox message, wakeup.json, round-now.json) carries an HMAC with
// the project's key, kept outside the project. A request without a good one is never acted on: set aside (or ignored
// where it lies), logged, its running tasks flagged, one Home card with Seen and one phone message. A request is acted on
// once. Test content stays harmless (a push of a branch that isn't there, a message that says guard-test).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { guardDir } from '../src/lib/guard.mjs';
import { ownerNeeds, taskAlerts } from '../src/lib/overview.mjs';
import { canonical, keyFile, markStores, markerFile, newSigningKey, projectSigningKey, seenFile, sign, stateName, storeCopyFile, storesStarted, verify } from '../src/lib/sign.mjs';
import { fileExists, makeProject, waitUntil, writeSignedRequest } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const exited = (child) => new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
async function fakeNtfy() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
const tmpHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sign-'));

test('a signature: the same object in any key order verifies; a changed value, another name, another purpose or no signature fails', () => {
  const home = tmpHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sign-root-'));
  try {
    const { key } = projectSigningKey(root, { home, create: true });
    assert.equal(key.length, 32);
    const name = stateName(path.join('queue', 'T-1.json'));
    assert.equal(name, 'state:queue/T-1.json');
    const job = { id: 'T-1', type: 'task', nested: { b: 2, a: [1, { y: 1, x: 2 }] }, rid: '0123456789abcdef' };
    const signed = sign(job, { key, name, by: 'owner' });
    assert.equal(signed.sig.by, 'owner');
    assert.equal(verify(signed, { key, name }).ok, true);
    // the same object, its keys in another order, as another writer's JSON would have them
    const reordered = JSON.parse(JSON.stringify({ sig: signed.sig, rid: job.rid, nested: { a: [1, { x: 2, y: 1 }], b: 2 }, type: 'task', id: 'T-1' }));
    assert.equal(canonical(reordered.nested), canonical(job.nested));
    assert.equal(verify(reordered, { key, name }).ok, true);
    // each change fails
    assert.match(verify({ ...signed, type: 'push' }, { key, name }).why, /doesn't match/);
    assert.match(verify({ ...signed, sig: { ...signed.sig, by: 'hub' } }, { key, name }).why, /doesn't match/);
    assert.match(verify(signed, { key, name: 'state:outbox/T-1.json' }).why, /doesn't match/, 'a request copied into another folder');
    assert.match(verify(signed, { key, name, purpose: 'guard' }).why, /doesn't match/);
    assert.match(verify(job, { key, name }).why, /no signature/);
    assert.match(verify({ ...job, sig: { v: 1, by: 'owner', at: 'x', mac: '00' } }, { key, name }).why, /form/);
    assert.match(verify([], { key, name }).why, /object/);
    assert.match(verify(signed, { key: Buffer.alloc(32, 7), name }).why, /doesn't match/, 'another key');
    assert.throws(() => sign(job, { key, name, by: 'worker' }), /unknown signer/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the key: made once outside the project with a marker; never made again by itself once the marker is there; a changed key is a problem; the owner's fix makes a new one", () => {
  const home = tmpHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sign-root-'));
  try {
    assert.deepEqual(projectSigningKey(root, { home }), { missing: true }, 'a reader never makes one');
    const first = projectSigningKey(root, { home, create: true });
    assert.ok(first.key);
    assert.ok(keyFile(root, home).startsWith(path.join(home, '.nextlevel', 'keys')));
    assert.ok(fs.existsSync(markerFile(root, home)));
    assert.ok(!keyFile(root, home).startsWith(root), 'never inside the project');
    assert.deepEqual(projectSigningKey(root, { home, create: true }).key, first.key, 'the same key every time');
    // a key deleted (a worker that wants a fresh one its own files then match): not made again
    fs.rmSync(keyFile(root, home));
    const gone = projectSigningKey(root, { home, create: true });
    assert.match(gone.problem, /is gone.*isn't made by itself.*nextlevel doctor --fix state\.key/);
    assert.ok(!fs.existsSync(keyFile(root, home)));
    // a key put there by someone else
    fs.writeFileSync(keyFile(root, home), `${'ab'.repeat(32)}\n`);
    assert.match(projectSigningKey(root, { home, create: true }).problem, /isn't the one the project had/);
    fs.writeFileSync(keyFile(root, home), 'not a key\n');
    assert.match(projectSigningKey(root, { home }).problem, /can't be read as a key/);
    // the owner's fix
    const fresh = newSigningKey(root, { home });
    assert.deepEqual(projectSigningKey(root, { home }).key, fresh.key);
    assert.notDeepEqual(fresh.key, first.key);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Home's card: what was set aside and the tasks running then, with Seen; a key it can't have is a card of its own", () => {
  const b = { active: [], queued: [], review: [], waiting: [], milestones: [], hub: { running: true }, autopilot: { on: false }, untraced: { items: [{ at: 'x', what: 'a push job forged-push', why: 'it has no signature', file: '.nextlevel/untraced/x-forged-push.json', tasks: ['SG-01-forge'] }], keyProblem: '' } };
  const card = ownerNeeds(b).find((n) => n.kind === 'untraced');
  assert.match(card.text, /A request nextlevel didn't write was set aside, not acted on: a push job forged-push \(it has no signature\)\. Running then: SG-01-forge\./);
  assert.deepEqual(card.action, { label: 'Seen', post: '/api/untraced', body: {} });
  // (a store is a file, not a request, and the card says the hub's copy went back: 2B-1b2)
  const store = ownerNeeds({ ...b, untraced: { items: [{ at: 'x', kind: 'store', what: 'the list of closed tasks (closed.json); the last one the hub took is put back', why: 'it has no signature', file: '.nextlevel/closed.json', tasks: [] }], keyProblem: '' } }).find((n) => n.kind === 'untraced');
  assert.match(store.text, /^A file nextlevel didn't write was set aside, not acted on: the list of closed tasks/);
  assert.match(store.why, /it put that back/);
  assert.doesNotMatch(card.why, /it put that back/);
  // (a task whose queued request was set aside: no "setup problem on this PC", the job's own words. Review of 2B-1b1)
  const [aside] = taskAlerts([{ id: 'SG-07-old', type: 'task', state: 'error', notStarted: true, acked: false, attempt: 1, error: 'its request in the queue was set aside, not acted on (it has no signature): nothing ran. If you want it, ask again: nextlevel retry SG-07-old' }]);
  assert.match(aside.text, /^SG-07-old didn't start: its request in the queue was set aside, not acted on \(it has no signature\): nothing ran\. If you want it, ask again: nextlevel retry SG-07-old$/);
  const key = ownerNeeds({ ...b, untraced: { items: [], keyProblem: 'the key is gone' } });
  assert.equal(key.find((n) => n.kind === 'untraced'), undefined);
  assert.match(key.find((n) => n.kind === 'signkey').text, /Nothing the team or you ask of the hub is acted on: the key is gone/);
  assert.equal(ownerNeeds({ ...b, untraced: null }).find((n) => ['untraced', 'signkey'].includes(n.kind)), undefined);
});

test('a worker that writes requests by hand into the main project (a push job, a phone message, a wake-up, a press): none acted on, each set aside or ignored and logged, its task flagged, one Home card and one phone message; the ordinary commands still work', async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  const id = 'SG-01-forge';
  const topic = { NTFY_TOPIC: 'a-long-random-topic-for-tests-1234' };
  const run = () => exited(p.hubInBackground(['run', '--exit-when-idle', '--tick-ms', '200'], topic));
  let ui;
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url }, hub: { ...c.hub, autopilot: false } }));
    p.spec(id, fileExists(`${id}.mjs`));
    p.spec('SG-02-ok', fileExists('ok.mjs'));
    assert.equal(p.hub(['dispatch', id]).code, 0);
    // (the command signed the job it queued, with an id of its own)
    const queued = JSON.parse(fs.readFileSync(p.state('queue', `${id}.json`), 'utf8'));
    assert.equal(queued.sig.by, 'owner');
    assert.match(queued.rid, /^[0-9a-f]{16}$/);
    await run();
    // the worker's own task ran as ever, flagged: the requests appeared while it ran (by the hub's own clock)
    assert.equal(p.status(id).state, 'done');
    assert.ok(Array.isArray(p.status(id).untraced) && p.status(id).untraced.length >= 1, JSON.stringify(p.status(id).untraced));
    assert.match(p.hub(['result', id, '--peek']).out, /request\(s\) nextlevel didn't write appeared while it ran, set aside/);
    // (the wake-up and the press are read at autopilot's look, every twelfth tick: a hub that runs until it has looked)
    const hubLog = () => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    const bg = p.hubInBackground(['run', '--tick-ms', '50'], topic);
    try {
      await waitUntil('the wake-up and the press to be looked at', () => /round-now\.json: not acted on/.test(hubLog()) && /wakeup\.json: not acted on/.test(hubLog()));
      await waitUntil('another look', () => (hubLog().match(/hub started/g) || []).length && fs.existsSync(p.state('hub.json')));
    } finally {
      bg.kill();
      await exited(bg);
      fs.rmSync(p.state('hub.json'), { force: true });
    }
    const log = hubLog();
    // the push job: never run, set aside with its words
    assert.ok(!fs.existsSync(p.state('jobs', 'forged-push')), 'no job folder for it');
    assert.ok(!fs.existsSync(p.state('queue', 'forged-push.json')));
    const aside = fs.readdirSync(p.state('untraced'));
    assert.ok(aside.some((f) => f.endsWith('-forged-push.json')), aside.join(', '));
    assert.ok(aside.some((f) => f.endsWith('-forged-message.json')), aside.join(', '));
    assert.match(log, /\.nextlevel[\\/]queue[\\/]forged-push\.json: not acted on, nextlevel can't trace it \(it has no signature\): a push job forged-push/);
    assert.match(log, /forged-message\.json: not acted on, nextlevel can't trace it \(it has no signature\): a phone message;/);
    // the message: never sent; the one message the phone gets says what was set aside
    assert.equal(ntfy.got.filter((m) => m.title === 'forged by a worker').length, 0);
    const told = ntfy.got.filter((m) => m.title === "proj: a request nextlevel didn't write was set aside");
    assert.equal(told.length, 1, JSON.stringify(ntfy.got.map((m) => m.title)));
    // the wake-up and the press: ignored where they lie (the files are the command's and the dashboard's), said once
    assert.match(log, /wakeup\.json: not acted on, nextlevel can't trace it \(it has no signature\): a wake-up for the orchestrator/);
    assert.match(log, /round-now\.json: not acted on, nextlevel can't trace it \(it has no signature\): a press of Run a round now/);
    assert.equal(log.match(/round-now\.json: not acted on/g).length, 1, 'said once, however many looks');
    assert.doesNotMatch(log, /autopilot: the orchestrator asked for a wake-up/);
    // the guard's record of it, outside the project
    const lines = fs.readFileSync(path.join(guardDir(p.repo, p.env.HOME), 'untraced.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(new Set(lines.map((l) => l.kind)), new Set(['queue', 'outbox', 'wakeup', 'round-now']));
    // Home's card, then Seen
    ui = await startUi(p);
    const card = (await client(ui).get('/api/state')).json.needs.find((n) => n.kind === 'untraced');
    assert.ok(card, 'the card is on Home');
    assert.match(card.text, /requests nextlevel didn't write were set aside, not acted on/);
    assert.equal((await client(ui).post('/api/untraced', {})).json?.ok, true);
    assert.equal((await client(ui).get('/api/state')).json.needs.find((n) => n.kind === 'untraced'), undefined);
    await stopUi(ui);
    ui = null;
    // the ordinary commands still work: a task dispatched by the owner runs, a phone message is sent
    assert.equal(p.hub(['dispatch', 'SG-02-ok']).code, 0);
    assert.equal(p.hub(['notify', 'ordinary message', 'guard-test']).code, 0);
    await run();
    assert.equal(p.status('SG-02-ok').state, 'done');
    assert.equal(ntfy.got.filter((m) => m.title === 'ordinary message').length, 1);
  } finally {
    await stopUi(ui);
    await ntfy.close();
    p.cleanup();
  }
});

test('a copy of a request: a job acted on, put back, is set aside; a signed phone message copied into the queue is set aside; an old one too', async () => {
  const p = makeProject();
  try {
    p.setConfig((c) => ({ ...c, hub: { ...c.hub, autopilot: false } }));
    p.spec('SG-04-ok', fileExists('ok.mjs'));
    assert.equal(p.hub(['dispatch', 'SG-04-ok']).code, 0);
    const copy = fs.readFileSync(p.state('queue', 'SG-04-ok.json'), 'utf8');
    p.runUntilIdle();
    assert.equal(p.status('SG-04-ok').state, 'done');
    const acted = JSON.parse(fs.readFileSync(path.join(guardDir(p.repo, p.env.HOME), 'acted.json'), 'utf8'));
    assert.ok(acted.ids[JSON.parse(copy).rid], 'its id is in the record of requests acted on');
    assert.equal(acted.sig.by, 'hub');
    // put back: the same signed job
    fs.writeFileSync(p.state('queue', 'SG-04-ok.json'), copy);
    // a signed message, copied into the queue under a job's name
    assert.equal(p.hub(['notify', 'a message', 'guard-test']).code, 0);
    const msg = fs.readdirSync(p.state('outbox'))[0];
    fs.copyFileSync(p.state('outbox', msg), p.state('queue', 'from-outbox.json'));
    fs.rmSync(p.state('outbox', msg)); // (no phone here: the message itself isn't the point)
    p.runUntilIdle();
    const log = fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    assert.match(log, /SG-04-ok\.json: not acted on, nextlevel can't trace it \(it was acted on already \(a copy of a request nextlevel took\)\)/);
    assert.match(log, /from-outbox\.json: not acted on, nextlevel can't trace it \(its signature doesn't match/);
    assert.equal(p.status('SG-04-ok').attempt ?? 1, 1, 'not run again');
  } finally {
    p.cleanup();
  }
});

test("a signing key that is gone after the project had one: no request is acted on or set aside, the command refuses saying the fix, Home says it", async () => {
  const p = makeProject();
  let ui;
  try {
    p.setConfig((c) => ({ ...c, hub: { ...c.hub, autopilot: false } }));
    p.spec('SG-05-ok', fileExists('ok.mjs'));
    p.runUntilIdle(); // (the hub makes the key as it starts)
    const kf = keyFile(p.repo, p.env.HOME);
    assert.ok(fs.existsSync(kf));
    assert.equal(p.hub(['dispatch', 'SG-05-ok']).code, 0);
    fs.rmSync(kf);
    p.runUntilIdle();
    assert.equal(p.status('SG-05-ok').state, 'queued', 'nothing acted on');
    assert.equal(p.status('SG-05-ok').waitingFor, 'key', 'and it says what it waits for');
    assert.match(p.status('SG-05-ok').waiting, /signing key can't be had.*nextlevel doctor --fix state\.key/);
    assert.ok(fs.existsSync(p.state('queue', 'SG-05-ok.json')), 'nothing set aside either');
    assert.ok(!fs.existsSync(kf), 'the hub made no new key');
    const r = p.hub(['notify', 'x', 'y']);
    assert.notEqual(r.code, 0);
    assert.match(r.err + r.out, /signing key .* is gone.*nextlevel doctor --fix state\.key/);
    ui = await startUi(p);
    const card = (await client(ui).get('/api/state')).json.needs.find((n) => n.kind === 'signkey');
    assert.match(card.text, /Nothing the team or you ask of the hub is acted on/);
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
});

test("the owner's new key while the hub runs: the running hub takes it, a request signed with it is acted on, and its record of the requests acted on is kept under it", async () => {
  const p = makeProject();
  let hub;
  try {
    p.setConfig((c) => ({ ...c, hub: { ...c.hub, autopilot: false } }));
    p.spec('SG-06-before', fileExists('before.mjs'));
    p.spec('SG-06-after', fileExists('after.mjs'));
    hub = p.hubInBackground(['run', '--tick-ms', '200']);
    await waitUntil('the key', () => fs.existsSync(keyFile(p.repo, p.env.HOME)));
    assert.equal(p.hub(['dispatch', 'SG-06-before']).code, 0);
    await waitUntil('the first job taken', () => !fs.existsSync(p.state('queue', 'SG-06-before.json')), 20000);
    newSigningKey(p.repo, { home: p.env.HOME }); // (what `nextlevel doctor --fix state.key` does)
    assert.equal(p.hub(['dispatch', 'SG-06-after']).code, 0);
    await waitUntil('the second job taken', () => !fs.existsSync(p.state('queue', 'SG-06-after.json')), 20000);
    const untracedDir = p.state('untraced');
    const setAside = fs.existsSync(untracedDir) ? fs.readdirSync(untracedDir) : [];
    assert.deepEqual(setAside, [], 'nothing signed with the new key is set aside');
    const key = projectSigningKey(p.repo, { home: p.env.HOME }).key;
    const rec = JSON.parse(fs.readFileSync(path.join(guardDir(p.repo, p.env.HOME), 'acted.json'), 'utf8'));
    assert.ok(verify(rec, { key, purpose: 'guard', name: 'guard:acted.json' }).ok, 'the record verifies with the new key');
    assert.equal(Object.keys(rec.ids).length, 2, 'both requests kept');
  } finally {
    hub?.kill();
    p.cleanup();
  }
});

test("a wake-up nextlevel signed but the hub first saw too late is said once in hub.log, quietly: no card, no flag, no phone message (review)", async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  const topic = { NTFY_TOPIC: 'a-long-random-topic-for-tests-1234' };
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url }, hub: { ...c.hub, autopilot: false } }));
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    writeSignedRequest(p, 'wakeup.json', { id: 'abcdef123456', askedAt: at, minutes: 5, reason: 'guard-test', by: 'an autopilot round' }, { by: 'orchestrator', at });
    const hubLog = () => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    const bg = p.hubInBackground(['run', '--tick-ms', '50'], topic);
    try {
      await waitUntil('the wake-up to be looked at', () => fs.existsSync(p.state('logs', 'hub.log')) && /wakeup\.json: not acted on/.test(hubLog()));
    } finally {
      bg.kill();
      await exited(bg);
    }
    assert.match(hubLog(), /wakeup\.json: not acted on, too late \(it was signed 20 minutes before the hub first saw it/);
    assert.doesNotMatch(hubLog(), /nextlevel can't trace it/);
    const card = path.join(guardDir(p.repo, p.env.HOME), 'untraced.json');
    assert.ok(!fs.existsSync(card) || JSON.parse(fs.readFileSync(card, 'utf8')).items.length === 0, 'no card');
    assert.equal(ntfy.got.length, 0, 'no phone message');
  } finally {
    await ntfy.close();
    p.cleanup();
  }
});

test("the record of the requests acted on starts with the key; deleted, it isn't taken as empty: a request signed before the hub started is set aside, a new one is acted on; a new key starts it again (review)", async () => {
  const p = makeProject();
  try {
    p.setConfig((c) => ({ ...c, hub: { ...c.hub, autopilot: false } }));
    p.spec('SG-07-old', fileExists('old.mjs'));
    p.spec('SG-07-ok', fileExists('ok.mjs'));
    const actedPath = path.join(guardDir(p.repo, p.env.HOME), 'acted.json');
    const { key } = projectSigningKey(p.repo, { home: p.env.HOME, create: true });
    const first = JSON.parse(fs.readFileSync(actedPath, 'utf8'));
    assert.deepEqual(first.ids, {});
    assert.ok(verify(first, { key, purpose: 'guard', name: 'guard:acted.json' }).ok, 'made with the key, signed');
    assert.equal(p.hub(['dispatch', 'SG-07-old']).code, 0);
    fs.rmSync(actedPath);
    p.runUntilIdle();
    const log = fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    assert.match(log, /acted\.json: not acted on, nextlevel can't trace it \(it is gone, though the key that started it is there\)/);
    assert.match(log, /SG-07-old\.json: not acted on, nextlevel can't trace it \(it was signed before the hub could trust its record/);
    // (its job says so, rather than wait as queued for ever)
    assert.equal(p.status('SG-07-old').state, 'error');
    assert.match(p.status('SG-07-old').error, /its request in the queue was set aside, not acted on \(it was signed before the hub could trust its record[^)]*\): nothing ran\. If you want it, ask again: nextlevel retry SG-07-old/);
    assert.equal(p.hub(['dispatch', 'SG-07-ok']).code, 0);
    p.runUntilIdle();
    assert.equal(p.status('SG-07-ok').state, 'done', 'a request signed since is acted on');
    // The owner's new key: the record starts again empty under it (nothing signed with the old key is good any more)
    const { key: fresh } = newSigningKey(p.repo, { home: p.env.HOME });
    const again = JSON.parse(fs.readFileSync(actedPath, 'utf8'));
    assert.deepEqual(again.ids, {});
    assert.ok(verify(again, { key: fresh, purpose: 'guard', name: 'guard:acted.json' }).ok);
  } finally {
    p.cleanup();
  }
});

// ---------- signed stores (2B-1b2): rounds.json and closed.json ----------
const readJsonFile = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const tryJson = (f) => {
  try {
    return readJsonFile(f);
  } catch {
    return null;
  }
};
async function stopBg(p, bg) {
  if (!bg) return;
  bg.kill();
  await exited(bg);
  fs.rmSync(p.state('hub.json'), { force: true });
}

test("the stores' memory starts with the key: seen.json beside acted.json, and the key's record says so; a key from before gets it at the hub's first look", () => {
  const home = tmpHome();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sign-root-'));
  try {
    const { key } = projectSigningKey(root, { home, create: true });
    const seen = readJsonFile(seenFile(root, home));
    assert.deepEqual(seen.seqs, {});
    assert.ok(verify(seen, { key, purpose: 'guard', name: 'guard:seen.json' }).ok);
    assert.equal(storesStarted(root, home), true);
    // a key from before stores were signed: its record has no such word, until the hub's first look says so
    const mf = markerFile(root, home);
    const { stores, ...old } = readJsonFile(mf);
    fs.writeFileSync(mf, JSON.stringify(old));
    assert.equal(storesStarted(root, home), false);
    markStores(root, home);
    assert.equal(storesStarted(root, home), true);
    assert.equal(readJsonFile(mf).keyHash, old.keyHash, 'the same key');
    assert.ok(projectSigningKey(root, { home }).key.equals(key));
    // the owner's new key starts it again, empty
    fs.writeFileSync(seenFile(root, home), '{"seqs":{"state:rounds.json":9}}');
    const fresh = newSigningKey(root, { home }).key;
    assert.deepEqual(readJsonFile(seenFile(root, home)).seqs, {});
    assert.ok(verify(readJsonFile(seenFile(root, home)), { key: fresh, purpose: 'guard', name: 'guard:seen.json' }).ok);
    assert.ok(storeCopyFile(root, home, 'rounds.json').startsWith(path.join(home, '.nextlevel', 'guard')), 'the last good copies are outside the project');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a store only the hub writes (rounds.json): signed with a number that rises; one written by hand, an older copy put back and a deleted one are each set aside and the hub's last one put back, with a card", async () => {
  const p = makeProject();
  let bg;
  try {
    p.setConfig((c) => ({ ...c, hub: { ...c.hub, autopilot: false } }));
    const file = p.state('rounds.json');
    const hubLog = () => (fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '');
    bg = p.hubInBackground(['run', '--tick-ms', '50']);
    await waitUntil('the hub to write rounds.json', () => tryJson(file)?.sig);
    const key = projectSigningKey(p.repo, { home: p.env.HOME }).key;
    const name = stateName('rounds.json');
    const first = readJsonFile(file);
    assert.ok(verify(first, { key, purpose: 'state', name }).ok, 'signed for the state');
    assert.equal(first.sig.by, 'hub');
    assert.ok(first.sig.seq >= 1);
    assert.ok(!verify(first, { key, name }).ok, "not with the requests' key");
    const guard = guardDir(p.repo, p.env.HOME);
    await waitUntil("the hub's memory of it", () => tryJson(seenFile(p.repo, p.env.HOME))?.seqs?.[name] >= first.sig.seq);
    // the owner's note moves the state: a higher number, and the last good copy follows
    const old = fs.readFileSync(file, 'utf8');
    assert.equal(p.hub(['note', 'add', 'guard-test']).code, 0);
    await waitUntil('the note to be counted', () => tryJson(file)?.owner?.notes === 1 && tryJson(file)?.sig?.seq > first.sig.seq);
    await waitUntil('the last good copy', () => tryJson(path.join(guard, 'stores', 'rounds.json'))?.owner?.notes === 1);
    assert.equal(tryJson(path.join(guard, 'stores', 'rounds.json')).sig, undefined);
    // an older copy, put back
    fs.writeFileSync(file, old);
    await waitUntil('the older copy to be set aside', () => /rounds\.json: not acted on, nextlevel can't trace it \(it is an older copy: its number \d+ is below \d+, the last the hub took\)/.test(hubLog()));
    await waitUntil('the last one back', () => tryJson(file)?.owner?.notes === 1 && verify(tryJson(file), { key, purpose: 'state', name }).ok);
    // one written by hand
    fs.writeFileSync(file, JSON.stringify({ version: 1, owner: { notes: 0, handoff: 0 }, starts: [] }));
    await waitUntil('the hand-written one to be set aside', () => /rounds\.json: not acted on, nextlevel can't trace it \(it has no signature\): autopilot's record of what may start a round \(rounds\.json\); the last one the hub took is put back; kept in \.nextlevel[\\/]untraced[\\/]/.test(hubLog()));
    await waitUntil('the last one back again', () => tryJson(file)?.owner?.notes === 1 && tryJson(file)?.sig);
    assert.ok(fs.readdirSync(p.state('untraced')).some((f) => f.endsWith('-rounds.json')), 'what was written is kept aside');
    // a deleted one
    fs.rmSync(file);
    await waitUntil('the deleted one to be said', () => /rounds\.json: not acted on, nextlevel can't trace it \(it is gone\)/.test(hubLog()));
    await waitUntil('and put back', () => tryJson(file)?.owner?.notes === 1);
    // one card on Home, the store named
    const card = readJsonFile(path.join(guard, 'untraced.json'));
    assert.ok(card.items.length >= 3 && card.items.every((i) => i.kind === 'store'), JSON.stringify(card.items.map((i) => i.kind)));
    assert.equal(bg.exitCode, null, 'the hub runs');
  } finally {
    await stopBg(p, bg);
    p.cleanup();
  }
});

test("closed.json from before stores were signed is taken as it is, once, and signed; after the owner's new key again; with the hub's memory deleted nothing is taken as it is: a hand-written one is set aside and the last good one put back", async () => {
  const p = makeProject();
  let bg;
  try {
    p.setConfig((c) => ({ ...c, hub: { ...c.hub, autopilot: false } }));
    const file = p.state('closed.json');
    const name = stateName('closed.json');
    const hubLog = () => (fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '');
    const taken = () => (hubLog().match(/closed\.json: taken as it is \(written before the hub signed it\); signed from now on/g) || []).length;
    const closure = (reason) => ({ at: '2026-11-01T10:00:00.000Z', by: 'owner', source: "the owner's command", reason, discarded: false, branch: '', jobState: '', milestone: '', title: '' });
    fs.mkdirSync(p.state(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: { 'X-1': closure('from before') } }));
    bg = p.hubInBackground(['run', '--tick-ms', '50']);
    await waitUntil('closed.json to be taken as it is', () => taken() === 1 && tryJson(file)?.sig);
    let key = projectSigningKey(p.repo, { home: p.env.HOME }).key;
    assert.ok(verify(readJsonFile(file), { key, purpose: 'state', name }).ok);
    assert.equal(readJsonFile(file).tasks['X-1'].reason, 'from before');
    await stopBg(p, bg);
    // the owner's new key (nextlevel doctor --fix state.key): the store signed with the old one is taken again, once
    key = newSigningKey(p.repo, { home: p.env.HOME }).key;
    bg = p.hubInBackground(['run', '--tick-ms', '50']);
    await waitUntil('closed.json to be signed with the new key', () => taken() === 2 && verify(tryJson(file), { key, purpose: 'state', name }).ok);
    assert.equal(readJsonFile(file).tasks['X-1'].reason, 'from before');
    await stopBg(p, bg);
    assert.ok(!fs.existsSync(p.state('untraced')), 'nothing was set aside so far');
    // the hub's memory deleted, and a hand-written store: not taken as it is
    fs.rmSync(seenFile(p.repo, p.env.HOME));
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: { 'X-1': closure('from before'), 'X-2': closure('planted') } }));
    bg = p.hubInBackground(['run', '--tick-ms', '50']);
    await waitUntil("the hub's memory to be said", () => /seen\.json: not acted on, nextlevel can't trace it \(it is gone, though the key that started it is there\): the hub's memory of its stores' numbers/.test(hubLog()));
    await waitUntil('the hand-written one to be set aside', () => /closed\.json: not acted on, nextlevel can't trace it \(it has no signature\): the list of closed tasks \(closed\.json\); the last one the hub took is put back/.test(hubLog()));
    await waitUntil('the last good one back', () => tryJson(file)?.sig && !tryJson(file).tasks['X-2']);
    assert.equal(taken(), 2, 'not taken as it is');
    assert.equal(readJsonFile(file).tasks['X-1'].reason, 'from before');
    assert.match(p.hub(['status']).out, /./, 'the commands still read it');
  } finally {
    await stopBg(p, bg);
    p.cleanup();
  }
});

test('a store that was not there when the hub first looked (no closed.json yet) is remembered as none: one that appears unsigned is set aside, never taken as it is', async () => {
  const p = makeProject();
  let bg;
  try {
    p.setConfig((c) => ({ ...c, hub: { ...c.hub, autopilot: false } }));
    const file = p.state('closed.json');
    const name = stateName('closed.json');
    const hubLog = () => (fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '');
    bg = p.hubInBackground(['run', '--tick-ms', '50']);
    await waitUntil('the hub to remember there is none', () => tryJson(seenFile(p.repo, p.env.HOME))?.seqs?.[name] === 0);
    assert.ok(!fs.existsSync(file));
    fs.writeFileSync(file, JSON.stringify({ version: 1, tasks: { 'X-9': { at: '2026-11-01T10:00:00.000Z', by: 'owner', source: '', reason: 'planted', discarded: false, branch: '', jobState: '', milestone: '', title: '' } } }));
    await waitUntil('the planted one to be set aside', () => /closed\.json: not acted on, nextlevel can't trace it \(it has no signature\): the list of closed tasks \(closed\.json\); kept in/.test(hubLog()));
    await waitUntil('it to be gone from its place', () => !fs.existsSync(file));
    assert.doesNotMatch(hubLog(), /closed\.json: taken as it is/);
    assert.ok(fs.readdirSync(p.state('untraced')).some((f) => f.endsWith('-closed.json')));
    assert.equal(bg.exitCode, null, 'the hub runs');
  } finally {
    await stopBg(p, bg);
    p.cleanup();
  }
});
