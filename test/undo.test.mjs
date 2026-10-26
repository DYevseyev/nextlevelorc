// Undo Done, reopening a card, and FR-018 (who closed a card): the store (src/lib/cards.mjs) with the test's clock
// (lib/clock.mjs: the 10 seconds pass without waiting for them), the commands (src/notes.mjs), the dashboard alone, and
// several writers at once. A Done on the dashboard and its round with a stub orchestrator: test/autopilot.test.mjs.
//   npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { UNDO_MS, cardStore, conversation, eventsOf, unreadAnswer } from '../src/lib/cards.mjs';
import { REPO, makeProject, testClock } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

// The store's clock, in this process too (lib/clock.mjs reads it only under the tests' stubs)
const CLOCK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-undo-clock-')), 'clock.json');
process.env.NEXTLEVEL_TEST_STUBS = process.env.NEXTLEVEL_TEST_STUBS || '1';
process.env.NEXTLEVEL_TEST_CLOCK = CLOCK;
let now = Date.parse('2026-10-26T10:00:00Z');
const setClock = (ms) => {
  now = ms;
  fs.writeFileSync(`${CLOCK}.tmp`, JSON.stringify({ at: new Date(now).toISOString() }));
  fs.renameSync(`${CLOCK}.tmp`, CLOCK);
};
const seconds = (s) => setClock(now + s * 1000);
setClock(now);

const FILES = { notes: 'docs/OWNER_NOTES.md', handoff: 'docs/HANDOFF.md' };
function tempProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-undo-'));
  const store = cardStore({ root, stateDir: path.join(root, '.nextlevel'), files: FILES });
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const json = () => JSON.parse(read('.nextlevel/handoff.json'));
  return { root, store, read, json, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const card = (t, what = 'Put the SMTP host in .env') => t.store.handoff.add({ what, where: 'the mail panel', why: 'sign-up mail' });
const acts = (t) => t.store.ownerActs().handoff.n || 0;
const get = (t, id) => t.store.handoff.list().find((x) => x.id === id);

test('a Done from the dashboard waits 10 seconds: undone in time, it leaves nothing; past its time it is final for every reader', () => {
  const t = tempProject();
  try {
    card(t);
    seconds(1);
    const md = t.read('docs/HANDOFF.md');
    const before = acts(t);
    const x = t.store.handoff.done('H1', { reply: 'Set: smtp.example.com', delay: UNDO_MS });
    assert.equal(x.status, 'open');
    assert.equal(x.pending.finalAt, new Date(now + UNDO_MS).toISOString());
    // Until then the card is what it was, for the team, autopilot and the Markdown
    assert.equal(t.read('docs/HANDOFF.md'), md, 'the Markdown is the same, byte for byte');
    assert.deepEqual([acts(t), t.store.news().handoff, get(t, 'H1').thread], [before, [], []], 'no owner act, nothing new for the team, the reply not in the thread');
    seconds(9);
    assert.equal(get(t, 'H1').status, 'open');
    // Undo inside the window: as it was
    t.store.handoff.undo('H1');
    assert.equal(t.read('docs/HANDOFF.md'), md);
    assert.deepEqual([acts(t), get(t, 'H1').pending, get(t, 'H1').status], [before, undefined, 'open']);
    seconds(30);
    assert.deepEqual([acts(t), get(t, 'H1').status], [before, 'open'], 'an undone Done never becomes final');
    assert.throws(() => t.store.handoff.undo('H1'), /H1 has no Done to undo/);

    // Again, and the window passes: a reader sees it done before anyone wrote it; the next write makes it so on disk
    t.store.handoff.done('H1', { reply: 'Set: smtp.example.com', delay: UNDO_MS });
    assert.throws(() => t.store.handoff.done('H1', { delay: UNDO_MS }), /H1 is marked done already/);
    seconds(11);
    const seen = get(t, 'H1');
    assert.deepEqual([seen.status, seen.closedBy, seen.thread.map((e) => e.text)], ['done', 'owner', ['Set: smtp.example.com']]);
    assert.equal(t.json().items[0].status, 'open', 'reading never writes');
    assert.deepEqual([acts(t), t.store.news().handoff], [before + 1, ['H1']], 'the owner act counts, and the team is told, from the first look on');
    assert.deepEqual(t.store.handoff.settle().length, 0);
    assert.equal(t.json().items[0].status, 'done', 'settle wrote it');
    assert.match(t.read('docs/HANDOFF.md'), /- \[x\] \*\*H1\*\*[\s\S]*- Done \d{4}-\d\d-\d\d \d\d:\d\d by the owner/);
    assert.throws(() => t.store.handoff.undo('H1'), /Too late: H1 is done now\. Reopen it if you need to\./);
    // Settle with nothing due writes nothing
    const mtime = fs.statSync(path.join(t.root, '.nextlevel/handoff.json')).mtimeMs;
    t.store.handoff.settle();
    assert.equal(fs.statSync(path.join(t.root, '.nextlevel/handoff.json')).mtimeMs, mtime);
  } finally {
    t.cleanup();
  }
});

test('a write on a card with a pending Done makes it final first: the team answer is then unread, a cancel refused, the reply kept', () => {
  const t = tempProject();
  try {
    card(t);
    card(t, 'Approve the staging DNS record');
    seconds(1);
    t.store.handoff.done('H1', { reply: 'Done, see the panel', delay: UNDO_MS });
    seconds(2);
    t.store.handoff.answer('H1', 'Thanks: the mail arrived.');
    const x = get(t, 'H1');
    assert.equal(x.status, 'done');
    assert.deepEqual(x.thread.map((e) => [e.by, e.text]), [['owner', 'Done, see the panel'], ['team', 'Thanks: the mail arrived.']], 'the reply before the answer');
    assert.equal(unreadAnswer(x), true, 'the answer waits for the owner, as on any done card');
    // A cancel during the window: the Done is made final, and the cancel refused
    t.store.handoff.done('H2', { reply: 'Approved it', delay: UNDO_MS });
    assert.throws(() => t.store.handoff.cancel('H2', { reply: 'not needed' }), /H2 is done already/);
    assert.deepEqual(get(t, 'H2').thread.map((e) => e.text), ['Approved it']);
    assert.throws(() => t.store.handoff.undo('H2'), /Too late/);
  } finally {
    t.cleanup();
  }
});

test('reopen: the card is open again with its whole conversation, its closing kept, what was read stays read; the team is told', () => {
  const t = tempProject();
  try {
    card(t);
    seconds(1);
    t.store.handoff.reply('H1', 'Which host?');
    seconds(1);
    t.store.handoff.answer('H1', 'smtp.example.com');
    seconds(1);
    t.store.handoff.seen(['H1']);
    t.store.handoff.done('H1');
    seconds(60);
    const before = acts(t);
    t.store.handoff.seen(['H1']);
    const x = t.store.handoff.reopen('H1');
    assert.deepEqual([x.status, x.reopenedHow, x.doneAt, unreadAnswer(x)], ['open', 'dashboard', null, false], 'the answer read before Done is not new again');
    assert.deepEqual(eventsOf(x).map((e) => [e.kind, e.by]), [['done', 'owner'], ['reopened', 'owner']], "its Done by you survives the reopen");
    assert.deepEqual(conversation(x).map((e) => e.text ?? e.kind), ['Which host?', 'smtp.example.com', 'done', 'reopened']);
    assert.equal(acts(t), before + 1);
    assert.deepEqual(t.store.news().handoff, ['H1'], 'news for the team');
    assert.match(t.read('docs/HANDOFF.md'), /## Open\n\n- \[ \] \*\*H1\*\*[\s\S]*- Done [\d-]+ [\d:]+ by the owner\n {2}- Reopened [\d-]+ [\d:]+ by the owner\n/);
    assert.throws(() => t.store.handoff.reopen('H1'), /H1 is open/);
    // A card closed before these events: its closing is written before the reopen, never lost
    card(t, 'Buy the domain');
    const raw = t.json();
    Object.assign(raw.items[1], { status: 'cancelled', note: 'bought already', doneAt: new Date(now).toISOString() });
    delete raw.items[1].events;
    fs.writeFileSync(path.join(t.root, '.nextlevel/handoff.json'), JSON.stringify(raw));
    seconds(5);
    const y = t.store.handoff.reopen('H2', { how: 'terminal' });
    assert.deepEqual(y.events.map((e) => [e.kind, e.by, e.how, e.note]), [['cancelled', 'team', '', 'bought already'], ['reopened', 'owner', 'terminal', '']]);
    // A held change's card is decided once, on its own card
    t.store.handoff.addGuard({ what: 'Approve or reject G1', where: 'the dashboard', why: 'a protected file', guard: 'G1' });
    t.store.handoff.decideGuard('G1', { reply: 'Approved' });
    assert.throws(() => t.store.handoff.reopen('H3'), /a change nextlevel holds/);
  } finally {
    t.cleanup();
  }
});

test('FR-018: a card says who closed it; the team closes one as resolved, a cancel after the owner replied is a close; a reply on a closed card reopens it', () => {
  const t = tempProject();
  try {
    card(t, 'Deploy the release');
    card(t, 'Pick a logo');
    card(t, 'Renew the certificate');
    seconds(1);
    t.store.handoff.reply('H1', 'Deployed');
    seconds(1);
    // H18's case: the team withdraws a card the owner acted on
    const c = t.store.handoff.cancel('H1', { reply: 'The owner deployed it' });
    assert.equal(c.closedInstead, true);
    const h1 = get(t, 'H1');
    assert.deepEqual([h1.status, h1.closedBy, h1.note, 'closedInstead' in h1], ['done', 'team', 'The owner deployed it', false]);
    assert.deepEqual(t.store.news().handoff, [], 'a closing by the team is no news to it');
    // close: the text whole in the thread (line breaks kept), its first line the note
    const text = 'Resolved: the owner picked logo B.\n- favicon updated\n- docs/BRAND.md says so';
    const h2 = t.store.handoff.close('H2', { note: text });
    assert.deepEqual([h2.status, h2.closedBy, h2.note, h2.thread.at(-1)], ['done', 'team', 'Resolved: the owner picked logo B.', { by: 'team', text, at: h2.doneAt }]);
    assert.throws(() => t.store.handoff.close('H2', { note: 'again' }), /H2 is done already/);
    // a cancel before the owner acted stays a cancel
    const h3 = t.store.handoff.cancel('H3', { reply: 'renewed itself' });
    assert.deepEqual([h3.status, h3.closedBy, eventsOf(h3).map((e) => e.kind)], ['cancelled', undefined, ['cancelled']]);
    // The Markdown says who, and stays valid: read back, nothing becomes a new card or request text
    const md = t.read('docs/HANDOFF.md');
    assert.match(md, /- Closed by the team [\d-]+ [\d:]+: The owner deployed it/);
    assert.match(md, /- Closed by the team [\d-]+ [\d:]+: Resolved: the owner picked logo B\./);
    assert.match(md, /> - favicon updated/);
    assert.match(md, /- Cancelled [\d-]+ [\d:]+: renewed itself/);
    fs.appendFileSync(path.join(t.root, 'docs/HANDOFF.md'), '\n');
    assert.deepEqual(t.store.handoff.list().map((x) => [x.id, x.what]), [['H1', 'Deploy the release'], ['H2', 'Pick a logo'], ['H3', 'Renew the certificate']], 'read back as it was');
    // The owner's follow-up on a closed card reopens it
    seconds(5);
    const before = acts(t);
    const r = t.store.handoff.reply('H1', 'It broke the login page: please look');
    assert.deepEqual([r.status, r.reopenedHow, eventsOf(r).map((e) => e.kind)], ['open', 'reply', ['closed', 'reopened']]);
    assert.equal(acts(t), before + 1);
    assert.equal(t.store.ownerActs().handoff.what, 'your reply on H1, which reopened it');
    // A held change's card the hub closed itself
    t.store.handoff.addGuard({ what: 'Approve or reject G2', where: 'the dashboard', why: 'a push', guard: 'G2' });
    t.store.handoff.decideGuard('G2', { reply: 'Not needed any more', hub: true });
    assert.deepEqual(eventsOf(get(t, 'H4')).map((e) => [e.kind, e.by]), [['done', 'hub']]);
    assert.match(t.read('docs/HANDOFF.md'), /- Closed by nextlevel [\d-]+ [\d:]+/);
  } finally {
    t.cleanup();
  }
});

test('a card or reply added by another process while a Done becomes final is kept (one lock for every writer)', async () => {
  const t = tempProject();
  try {
    card(t);
    t.store.handoff.done('H1', { delay: UNDO_MS });
    seconds(11);
    const script = `import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'lib', 'cards.mjs')).href)}).then(({ cardStore }) => { const s = cardStore({ root: process.argv[1], stateDir: process.argv[1] + '/.nextlevel', files: ${JSON.stringify(FILES)} }); for (let i = 0; i < 5; i++) { if (process.argv[2] === 'settle') s.handoff.settle(); else s.handoff.add({ what: 'from ' + process.argv[2] + ' #' + i, where: 'w', why: 'y' }); } })`;
    const runs = ['settle', 'p1', 'p2'].map((who) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, t.root, who], { stdio: ['ignore', 'ignore', 'pipe'], env: process.env });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    }));
    await Promise.all(runs);
    const items = t.json().items;
    assert.equal(items.length, 11, 'every card is there');
    assert.equal(items[0].status, 'done', 'and the Done is final');
    assert.equal(t.json().owner.n, 1, 'counted once');
  } finally {
    t.cleanup();
  }
});

test('the commands: reopen (the owner\'s), close (the team\'s), their usage through the strict parser; the list tells the team a card was reopened', () => {
  const p = makeProject();
  try {
    fs.mkdirSync(p.state(), { recursive: true });
    fs.writeFileSync(path.join(p.repo, '.nextlevel', 'request.md'), 'Put the SMTP host in .env\nWhere: the mail panel\nWhy: sign-up mail\n');
    assert.equal(p.hub(['handoff', 'add', '--file', '.nextlevel/request.md']).code, 0);
    assert.equal(p.hub(['handoff', 'done', 'H1']).code, 0, 'the terminal Done is final at once');
    let r = p.hub(['handoff', 'reopen', 'H1']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /H1 is open again, with its whole conversation/);
    r = p.hub(['handoff', 'list']);
    assert.match(r.out, /H1 {4}open {6}Put the SMTP host in \.env/);
    assert.match(r.out, /reopened by the owner from the terminal [\d-]+ [\d:]+, after it was done by the owner [\d-]+ [\d:]+: anything the team did since that relied on it being closed may need another look/);
    assert.match(r.out, /nextlevel handoff close <id> --file <path>/);
    r = p.hub(['handoff', 'show', 'H1']);
    assert.match(r.out, /Done [\d-]+ [\d:]+ by the owner\.\n\nReopened [\d-]+ [\d:]+ by the owner \(from the terminal\)\./);
    // close: from a file only, through the parser
    r = p.hub(['handoff', 'close', 'H1']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /close <id> --file <path>/);
    fs.writeFileSync(path.join(p.repo, '.nextlevel', 'close.md'), 'The owner set it; mail works.\nChecked with a test sign-up.\n');
    r = p.hub(['handoff', 'close', 'H1', '--file', '.nextlevel/close.md']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /H1 is closed as resolved: "The owner set it; mail works\."/);
    r = p.hub(['handoff', 'list', '--all']);
    assert.match(r.out, /H1 {4}closed {4}/);
    for (const args of [['handoff', 'reopen', '--help'], ['handoff', 'close', 'H1', '-h']]) {
      r = p.hub(args);
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /^Usage:/m);
    }
    assert.equal(JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items[0].status, 'done', '--help changed nothing');
    r = p.hub(['handoff', 'reopen', 'H1', '--reply', 'x']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /doesn't take --reply/);
    // reopen is the owner's: refused in an agent's session; and the read-only assistant runs neither
    r = p.hub(['handoff', 'reopen', 'H1'], { extraEnv: { NEXTLEVEL_AGENT: 'orchestrator' } });
    assert.notEqual(r.code, 0);
    for (const sub of ['reopen', 'close']) {
      r = p.hub(['handoff', sub, 'H1', ...(sub === 'close' ? ['--file', '.nextlevel/close.md'] : [])], { extraEnv: { NEXTLEVEL_READ_ONLY: '1' } });
      assert.notEqual(r.code, 0);
      assert.match(r.out, /read-only session/);
    }
    assert.equal(JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items[0].status, 'done');
  } finally {
    p.cleanup();
  }
});

test('the dashboard alone, no hub: Done shows Undo; past its time the next build data has it done; Reopen and a reply on a closed card', async () => {
  const p = makeProject();
  const clock = testClock(p, Date.now());
  Object.assign(p.env, clock.env);
  let ui;
  try {
    fs.mkdirSync(p.state(), { recursive: true });
    fs.writeFileSync(path.join(p.repo, '.nextlevel', 'request.md'), 'Put the SMTP host in .env\nWhere: the mail panel\nWhy: sign-up mail\n');
    assert.equal(p.hub(['handoff', 'add', '--file', '.nextlevel/request.md']).code, 0);
    ui = await startUi(p);
    const api = client(ui);
    let r = await api.post('/api/handoff', { action: 'done', id: 'H1', reply: 'Set' });
    assert.equal(r.json.message, 'Marked done: Undo for 10 seconds, then the team picks it up at its next start or round.');
    let cards = (await api.get('/api/cards')).json;
    // (ten seconds after the click, by the test's clock: the store's times only go forward, a millisecond a step)
    const tenOn = (iso) => Math.abs(Date.parse(iso) - (clock.now + UNDO_MS)) < 100;
    assert.ok(tenOn(cards.handoff.open[0].pending.finalAt), cards.handoff.open[0].pending.finalAt);
    assert.equal(typeof cards.now, 'string');
    let state = (await api.get('/api/state')).json;
    const need = state.needs.filter((n) => n.id === 'H1');
    assert.deepEqual(need.map((n) => [n.kind, n.action.body]), [['pending', { action: 'undo', id: 'H1' }]]);
    assert.ok(tenOn(need[0].pending));
    assert.equal(state.handoff.find((x) => x.id === 'H1').pending.reply, undefined, "the build data carries when, never the reply");
    r = await api.post('/api/handoff', { action: 'undo', id: 'H1' });
    assert.equal(r.status, 200, r.text);
    assert.equal(JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items[0].pending, undefined);
    await api.post('/api/handoff', { action: 'done', id: 'H1' });
    clock.addSeconds(11);
    state = (await api.get('/api/state')).json;
    assert.deepEqual(state.needs.filter((n) => n.id === 'H1'), []);
    assert.equal(JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items[0].status, 'done', 'the dashboard wrote it');
    assert.match(fs.readFileSync(path.join(p.repo, 'docs/HANDOFF.md'), 'utf8'), /- \[x\] \*\*H1\*\*/);
    r = await api.post('/api/handoff', { action: 'undo', id: 'H1' });
    assert.equal(r.status, 409);
    assert.match(r.json.message, /Too late/);
    clock.addSeconds(5);
    r = await api.post('/api/handoff', { action: 'reopen', id: 'H1' });
    assert.equal(r.status, 200, r.text);
    cards = (await api.get('/api/cards')).json;
    assert.deepEqual(cards.handoff.open[0].events.map((e) => [e.kind, e.how]), [['done', ''], ['reopened', 'dashboard']]);
    await api.post('/api/handoff', { action: 'done', id: 'H1' });
    clock.addSeconds(11);
    await api.get('/api/state');
    clock.addSeconds(5);
    r = await api.post('/api/handoff', { action: 'reply', id: 'H1', reply: 'One more thing: the port' });
    assert.equal(r.json.message, 'Sent, and H1 is open again: the team reads it at its next start or round.');
    cards = (await api.get('/api/cards')).json;
    assert.equal(cards.handoff.open[0].reopenedHow, 'reply');
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
});
