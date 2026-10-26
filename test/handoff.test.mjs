// FR-014: handoff conversations. The owner's replies and the team's answers on a card stay whole, line breaks included,
// on the dashboard, in docs/HANDOFF.md and in what the orchestrator reads; the orchestrator answers on the card with the
// text in a file, through the Windows .cmd shim; a new answer waits under What needs you and the phone gets a message
// that names the card; every text on the page is plain text, never HTML.
//   npm test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { MAX_LINE, MAX_MESSAGE, cardStore, handoffMarkdown, threadOf, unreadAnswer } from '../src/lib/cards.mjs';
import { writeShims } from '../src/lib/install.mjs';
import { ownerNeeds } from '../src/lib/overview.mjs';
import { OUTPUT_BUDGET, sizeOf } from '../src/lib/reports.mjs';
import { decodeText, readTextFile } from '../src/lib/textin.mjs';
import { BIN, REPO, makeProject, withEnv } from './helpers.mjs';
import { client, request, startUi, stopUi } from './ui-helpers.mjs';

const IS_WIN = process.platform === 'win32';
const FILES = { notes: 'docs/OWNER_NOTES.md', handoff: 'docs/HANDOFF.md' };
const count = (n) => n.toLocaleString('en-US');
const PAD = ' '.repeat(18); // where `handoff list` puts a card's texts
const write = (root, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), text);
};
const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const withinBudget = (text, what) => {
  const s = sizeOf(text);
  assert.ok(s.bytes <= OUTPUT_BUDGET.bytes && s.lines <= OUTPUT_BUDGET.lines, `${what} is ${s.bytes} bytes and ${s.lines} lines, over what the orchestrator's engine shows`);
};
// The text of the quoted block right after the line that matches `head` (a blank line between them is skipped): its
// lines without `pad` and "> "
function quotedAfter(text, head, pad) {
  const lines = String(text).replace(/\r\n/g, '\n').split('\n');
  const i = lines.findIndex((l) => head.test(l));
  assert.ok(i >= 0, `no line matches ${head}:\n${text}`);
  let j = i + 1;
  while (j < lines.length && lines[j] === '') j++;
  const out = [];
  for (; j < lines.length && lines[j].startsWith(`${pad}>`); j++) out.push(lines[j].slice(pad.length).replace(/^> ?/, ''));
  return out.join('\n');
}

// The owner's reply on a real project's H9 was about 1,700 characters with a checklist; this one is over 3,000, with the things
// that could break the Markdown file or a command line in it
function longReply() {
  const lines = [
    "Approved in principle; don't apply it yet. Once M1-129 is merged:",
    '',
    '1. Show me the exact diff for .github/workflows/ci.yml as a unified diff, and nothing else.',
    '2. Check the diff against this list and answer each point under it:',
    '   - the three steps come right after the M0 verification step',
    '   - [ ] no secret is printed in a log',
    '   - `pnpm` stays pinned, and "100% ^ & !" stays as it is',
    '## Not a heading of the file',
    '```yaml',
    'services: { postgres: 16, mailpit: 1 }',
    '```',
    '<!-- not a comment of the file -->',
  ];
  for (let i = 1; lines.join('\n').length < 3000; i++) lines.push(`- point ${i}: keep the Mailpit and Postgres containers exactly as the plan says, no more`);
  lines.push('END OF THE REPLY');
  return lines.join('\n');
}

// An ntfy server on this PC that keeps what it gets (test/notify.test.mjs)
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
// `nextlevel ...` without blocking this process (which serves the stand-in ntfy)
const runAsync = (p, args, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: p.repo, env: withEnv(p.env, extraEnv) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });

test("an owner's 3,000-character reply with line breaks and bullets arrives whole: on the dashboard, in docs/HANDOFF.md and in what the orchestrator reads", async () => {
  const p = makeProject();
  const copy = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-handoff-'));
  let ui;
  try {
    const REPLY = longReply();
    assert.ok(REPLY.length > 3000 && REPLY.split('\n').length > 20);
    // The team asks, the request in a file (where and why are lines of it)
    write(p.repo, '.nextlevel/request.md', 'After M1-129 merges, review and apply the three-step M1 CI patch\nWhere: the dashboard card, then .github/workflows/ci.yml\nWhy: M1 needs its browser journeys in CI\n');
    let r = p.hub(['handoff', 'add', '--file', '.nextlevel/request.md', '--task', 'M1-131-ci-plan']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Added H1\. Tell the owner, with the same words: nextlevel notify "Needs you: H1" --file \.nextlevel\/request\.md high/);

    // The owner replies on the dashboard
    ui = await startUi(p);
    const api = client(ui);
    const js = await request(ui.port, { path: '/dom.js' });
    assert.equal(js.status, 200, 'the page gets its dom.js');
    assert.match(js.headers['content-type'], /^text\/javascript/);
    const sent = await api.post('/api/handoff', { action: 'reply', id: 'H1', reply: REPLY });
    assert.equal(sent.status, 200, sent.text);

    // On the dashboard: whole, its line breaks included
    const cards = (await api.get('/api/cards')).json;
    const h1 = cards.handoff.open.find((x) => x.id === 'H1');
    assert.deepEqual([h1.what, h1.where, h1.why, h1.task], ['After M1-129 merges, review and apply the three-step M1 CI patch', 'the dashboard card, then .github/workflows/ci.yml', 'M1 needs its browser journeys in CI', 'M1-131-ci-plan']);
    assert.deepEqual(h1.thread.map((e) => [e.by, e.text]), [['owner', REPLY]]);
    assert.equal(h1.reply, REPLY, "the owner's last reply, as older nextlevels read it");

    // In docs/HANDOFF.md: a quoted block, whole
    const md = read(p.repo, 'docs/HANDOFF.md');
    assert.equal(quotedAfter(md, /^ {2}- The owner replied [\d-]+ [\d:]+:$/, '    '), REPLY);
    assert.doesNotMatch(md, /…/, 'nothing shortened');
    assert.doesNotMatch(md, /^## Not a heading/m, "the reply's heading stays inside its quote");
    // ... that doesn't break the file: read back from it alone, it is the same card, and the reply's "- [ ]" line is no item
    write(copy, 'docs/HANDOFF.md', md);
    const again = cardStore({ root: copy, stateDir: path.join(copy, '.nextlevel'), files: FILES }).handoff.list();
    assert.deepEqual(again.map((x) => [x.id, x.status, x.what]), [['H1', 'open', 'After M1-129 merges, review and apply the three-step M1 CI patch']]);
    assert.deepEqual(again[0].thread.map((e) => [e.by, e.text]), [['owner', REPLY]]);

    // In what the orchestrator reads at its round: `nextlevel handoff list`, through its shell
    const seen = path.join(p.tmp, 'orchestrator-cards.txt');
    r = p.runUntilIdle(['--autopilot'], { extraEnv: { STUB_ORCH_CARDS: seen } });
    assert.equal(r.code, 0, r.out);
    const input = fs.readFileSync(seen, 'utf8');
    assert.match(input, new RegExp(`the owner replied \\([\\d-]+ [\\d:]+\\), ${count(REPLY.length)} characters, whole:`));
    assert.equal(quotedAfter(input, /the owner replied .*, whole:$/, PAD), REPLY);
    assert.doesNotMatch(input, /cut here|shortened/i);
    assert.match(input, /The owner replied to H1: read it, then nextlevel handoff seen <id> \(or answer it on the card\)/);
    assert.match(input, /To answer the owner on a card: write the answer to a file .*\n {2}nextlevel handoff answer <id> --file \.nextlevel\/answer\.md\n {2}It is kept whole, line breaks included\. Never put the text in the command itself: on Windows it would end at its first line break\./);
    withinBudget(input, 'nextlevel handoff list');
  } finally {
    await stopUi(ui);
    fs.rmSync(copy, { recursive: true, force: true });
    p.cleanup();
  }
});

test("the orchestrator answers on the card through nextlevel.cmd, the text in a file: whole, with line breaks, quotes and % ^ & !; redacted; it waits under What needs you, and the phone message names the card", async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  let ui;
  try {
    // The installer's own nextlevel command (nextlevel.cmd on Windows), the one the orchestrator's shell runs
    writeShims(p.bin, REPO);
    const TOPIC = 'a-long-random-topic-for-fr014-tests';
    const planted = ['planted', 'answer', 'secret', '5c1e'].join('-');
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    write(p.repo, '.env', `DEPLOY_KEY=${planted}\n`);
    write(p.repo, '.nextlevel/request.md', 'Pick the mail provider for sign-up mails\nWhere: the dashboard card\nWhy: M2 sends sign-up mails\n');
    assert.equal(p.hub(['handoff', 'add', '--file', '.nextlevel/request.md']).code, 0);
    assert.equal(p.hub(['handoff', 'reply', 'H1', 'Which one would you pick, and why?']).code, 0);
    const token = `ghp_${'c'.repeat(36)}`;
    const ANSWER = [
      'Postmark, for three reasons:',
      '',
      '- "transactional" mail is all it does',
      "- the step's name is 'M2 sign-up mail' (100% of the E2E suite runs it)",
      '- carets ^, ampersands & and bangs ! stay as they are; %PATH% is no variable here',
      '',
      `The key is ${planted}, and the token ${token} too.`,
      'Reply "go" and I set it up.',
    ].join('\n');
    const KEPT = ANSWER.replace(planted, '***').replace(token, '***');
    write(p.repo, '.nextlevel/answer.md', ANSWER.replace(/\n/g, '\r\n'));

    // The owner's reply wakes the orchestrator; it answers, as its role doc says (and first with the text as an argument)
    const run = await runAsync(p, ['run', '--exit-when-idle', '--tick-ms', '200', '--autopilot'], { STUB_ORCH_ANSWER: 'H1:.nextlevel/answer.md', STUB_ORCH_ANSWER_ARG: '1', NTFY_TOPIC: TOPIC });
    assert.equal(run.code, 0, run.out);
    const arg = JSON.parse(read(p.repo, '.nextlevel/answer-arg.json'));
    assert.notEqual(arg.code, 0, 'the text as an argument is refused');
    assert.match(arg.out, /usage: nextlevel handoff answer <id> --file <path> .*Never the text in the command: on Windows it would end at its first line break/);
    const done = JSON.parse(read(p.repo, '.nextlevel/answer-result.json'));
    assert.equal(done.code, 0, done.out);
    assert.match(done.out, new RegExp(`Answered on H1: ${count(KEPT.length)} characters in 8 lines, kept whole\\. The owner's phone gets a message that names the card \\(don't send the answer with nextlevel notify\\)`));

    // On the card: whole, line breaks, quotes and % ^ & ! as written; the .env value and the token blanked out
    const store = cardStore({ root: p.repo, stateDir: p.state(), files: FILES });
    const [h1] = store.handoff.list();
    assert.deepEqual(h1.thread.map((e) => [e.by, e.text]), [['owner', 'Which one would you pick, and why?'], ['team', KEPT]]);
    assert.equal(unreadAnswer(h1), true);
    assert.deepEqual(store.news().handoff, [], 'answering is reading what the owner said');
    const md = read(p.repo, 'docs/HANDOFF.md');
    assert.equal(quotedAfter(md, /^ {2}- The team answered [\d-]+ [\d:]+:$/, '    '), KEPT);
    assert.ok(!md.includes(planted) && !md.includes(token), 'no secret in the Markdown that goes into Git');
    const shown = p.hub(['handoff', 'show', 'H1']).out;
    assert.equal(quotedAfter(shown, /^the team answered \(.*\), \d+ characters:$/, ''), KEPT);

    // The phone: a message that names the card, not the answer
    const msg = ntfy.got.find((m) => /the team answered H1/.test(m.title));
    assert.ok(msg, JSON.stringify(ntfy.got));
    assert.match(msg.message, /^The team answered on card H1 \("Pick the mail provider for sign-up mails"\)\. Read it, then reply or mark it done, on the dashboard: Notes and handoffs, card H1\./);
    for (const line of ['Postmark', 'transactional', 'Reply "go"']) assert.ok(!msg.message.includes(line), `the answer isn't on the phone: ${msg.message}`);
    assert.equal(msg.priority, 4);

    // What needs you: the card, until the owner replies or marks it done
    ui = await startUi(p);
    const api = client(ui);
    let state = (await api.get('/api/state')).json;
    const need = state.needs.find((n) => n.id === 'H1');
    assert.deepEqual([need.kind, need.text, need.action], ['answer', 'H1: the team answered: Pick the mail provider for sign-up mails', { label: 'Read the answer', page: 'notes', focus: 'H1' }]);
    let cards = (await api.get('/api/cards')).json;
    assert.equal(cards.handoff.open[0].unread, true);
    assert.equal(cards.handoff.open[0].thread[1].text, KEPT);
    assert.equal((await api.post('/api/handoff', { action: 'reply', id: 'H1', reply: 'Go.' })).status, 200);
    state = (await api.get('/api/state')).json;
    assert.deepEqual(state.needs.filter((n) => n.id === 'H1').map((n) => n.kind), ['handoff'], 'replied: an open card like any other');
    assert.equal((await api.post('/api/handoff', { action: 'done', id: 'H1' })).status, 200);
    state = (await api.get('/api/state')).json;
    assert.deepEqual(state.needs.filter((n) => n.id === 'H1'), []);

    // An answer on a card that is done already: it waits for the owner again, and Done marks it read without waking the team
    p.hub(['handoff', 'seen', 'H1']);
    write(p.repo, '.nextlevel/answer.md', 'Set up and tested: a sign-up mail arrived in the test inbox.\n');
    assert.equal(p.hub(['handoff', 'answer', 'H1', '--file', '.nextlevel/answer.md']).code, 0);
    state = (await api.get('/api/state')).json;
    assert.deepEqual(state.needs.filter((n) => n.id === 'H1').map((n) => [n.kind, n.action.label]), [['answer', 'Read the answer']]);
    assert.deepEqual(state.blockersCard.items.filter((x) => (x.ids || []).includes('H1')), [], 'an answer on a done card blocks nothing');
    cards = (await api.get('/api/cards')).json;
    assert.deepEqual([cards.handoff.open.length, cards.handoff.answered.map((x) => x.id)], [0, ['H1']]);
    const read1 = await api.post('/api/handoff', { action: 'done', id: 'H1' });
    assert.equal(read1.status, 200, read1.text);
    assert.equal(read1.json.message, 'Marked read.');
    state = (await api.get('/api/state')).json;
    assert.deepEqual(state.needs.filter((n) => n.id === 'H1'), []);
    assert.deepEqual(store.news().handoff, [], 'reading an answer wakes no orchestrator');
    assert.match(read(p.repo, 'docs/HANDOFF.md'), /- \[x\] \*\*H1\*\* Pick the mail provider/);

    // Why it needs a file on Windows: through nextlevel.cmd, an argument ends at its first line break
    if (IS_WIN) {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'nextlevel note add "line one`nline two"'], { cwd: p.repo, env: p.env, encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
      assert.deepEqual(store.notes.list().map((n) => n.text), ['line one'], 'cmd.exe cut the argument at its line break');
    }
  } finally {
    await stopUi(ui);
    await ntfy.close();
    p.cleanup();
  }
});

// ---------- the page: every text as a text node ----------
// A DOM for the page's dom.js that parses HTML the way a browser would where the page asked it to (innerHTML): if a card
// ever put a text in as HTML, its <script> would become an element here.
class FakeNode {
  constructor() {
    this.childNodes = [];
  }
  append(...kids) {
    for (const k of kids) this.childNodes.push(typeof k === 'string' ? new FakeText(k) : k);
  }
  get textContent() {
    return this.childNodes.map((c) => c.textContent).join('');
  }
}
class FakeText extends FakeNode {
  constructor(data) {
    super();
    this.data = data;
  }
  get textContent() {
    return this.data;
  }
}
class FakeElement extends FakeNode {
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.attributes = {};
    this.dataset = {};
  }
  setAttribute(k, v) {
    this.attributes[k] = v;
  }
  addEventListener() {}
  get textContent() {
    return super.textContent;
  }
  set textContent(v) {
    this.childNodes = [new FakeText(String(v))];
  }
  get innerHTML() {
    return this.childNodes.map((c) => (c instanceof FakeText ? c.data : `<${c.tagName.toLowerCase()}>${c.innerHTML}</${c.tagName.toLowerCase()}>`)).join('');
  }
  set innerHTML(html) {
    this.childNodes = [];
    for (const m of String(html).matchAll(/<(\/?)([a-zA-Z][\w-]*)[^>]*>|[^<]+|</g)) {
      if (m[2] && !m[1]) this.childNodes.push(new FakeElement(m[2]));
      else if (!m[2]) this.childNodes.push(new FakeText(m[0]));
    }
  }
}
const allElements = (node) => node.childNodes.flatMap((c) => (c instanceof FakeElement ? [c, ...allElements(c)] : []));

test('an answer with HTML in it shows as text on the card, never as HTML (src/ui/dom.js, in a DOM that parses HTML)', async () => {
  globalThis.Node = FakeNode;
  globalThis.document = { createElement: (tag) => new FakeElement(tag) };
  try {
    const { h, requestParts, textBlock, threadView } = await import('../src/ui/dom.js');
    const at = new Date().toISOString();
    const answer = 'Done, and checked.\n<script>document.title = "answered"</script>\n<b>bold?</b> & <i>more</i>';
    const x = { id: 'H1', what: 'Check the <b>CI</b> patch\n<script>document.title = "asked"</script>', unread: true, thread: [{ by: 'owner', text: 'Go <script>document.title = "replied"</script>', at }, { by: 'team', text: answer, at }] };
    const req = requestParts(x.what);
    const card = h('div.cardx.handoff', {}, h('strong.what', {}, req.title), textBlock(req.rest, '.request'), threadView(x, { when: (iso) => iso.slice(0, 10) }));
    const els = allElements(card);
    assert.deepEqual(els.filter((e) => ['SCRIPT', 'B', 'I'].includes(e.tagName)).map((e) => e.tagName), [], 'no text became an element');
    assert.equal(els.find((e) => e.tagName === 'STRONG').textContent, 'Check the <b>CI</b> patch');
    const texts = els.filter((e) => e.className.split(' ').includes('msg-text')).map((e) => e.textContent);
    assert.deepEqual(texts, ['<script>document.title = "asked"</script>', 'Go <script>document.title = "replied"</script>', answer], 'each text whole, as written, line breaks included');
    const items = els.filter((e) => e.tagName === 'LI');
    assert.deepEqual(items.map((e) => e.className), ['msg by-owner', 'msg by-team unread'], 'in time order; the new answer marked');
    // The cards redesign: earlier messages fold into one line; the team's newest answer, waiting for the owner, never does
    const long = { id: 'H2', unread: true, thread: ['owner', 'team', 'owner', 'team', 'owner', 'team'].map((by, i) => ({ by, text: `${by} ${i} <b>x</b>`, at })) };
    const folded = allElements(threadView(long, { fold: 2 }));
    const summary = folded.find((e) => e.tagName === 'SUMMARY');
    assert.equal(summary.textContent, '4 earlier messages');
    assert.deepEqual(folded.filter((e) => e.tagName === 'DETAILS').map((e) => e.attributes.open), [undefined], 'folded unless the owner opened it');
    assert.equal(allElements(threadView(long, { fold: 2, open: true })).find((e) => e.tagName === 'DETAILS').attributes.open, '');
    const lists = folded.filter((e) => e.tagName === 'OL');
    assert.deepEqual(lists.map((l) => l.childNodes.length), [4, 2], 'four folded, the last two shown');
    assert.equal(lists[1].childNodes[1].className, 'msg by-team unread');
    const one = allElements(threadView(long, { fold: 1 })).filter((e) => e.tagName === 'OL');
    assert.deepEqual([one[0].childNodes.length, one[1].childNodes[0].className], [5, 'msg by-team unread'], "the team's newest answer stays out of the fold");
    assert.equal(allElements(threadView({ ...long, thread: long.thread.slice(0, 3) }, { fold: 2 })).filter((e) => e.tagName === 'DETAILS').length, 0, 'one earlier message is never folded');
    // The page builds its handoff cards with dom.js, and nothing in it parses HTML
    const app = read(REPO, 'src/ui/app.js');
    const dom = read(REPO, 'src/ui/dom.js');
    assert.match(app, /import \{ h, requestParts, textBlock, threadView \} from '\.\/dom\.js';/);
    assert.match(app, /threadView\(x, \{ when: ago2\b/);
    assert.doesNotMatch(`${app}\n${dom}`, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|DOMParser|createContextualFragment/);
  } finally {
    delete globalThis.Node;
    delete globalThis.document;
  }
});

// ---------- the store ----------
function tempStore(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-handoff-'));
  for (const [f, text] of Object.entries(files)) write(root, f, text);
  const store = () => cardStore({ root, stateDir: path.join(root, '.nextlevel'), files: FILES });
  return { root, store, read: (f) => read(root, f), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('the card store keeps every reply and answer whole, in time order; nothing is cut without saying so; an answer waits for the owner until a reply or Done', () => {
  const t = tempStore({ 'docs/HANDOFF.md': '# Handoff\n\n- [ ] **H1** Buy the domain\n  - Where: the registrar\n  - Why: the site\n  - Reply: "Which registrar?" (2026-09-27 03:31)\n' });
  try {
    const s = t.store();
    // Before FR-014 the file had the owner's last reply on a "Reply:" line: it is the thread's first entry
    assert.deepEqual(s.handoff.list()[0].thread.map((e) => [e.by, e.text]), [['owner', 'Which registrar?']]);
    // A real project's H5: a request of 450 characters lost its end ("Reply with the…"); now it is kept whole
    const what = `Confirm the M0 production environment is saved on the host. ${'Keep existing secrets if already configured; do not paste values into the reply. '.repeat(4)}Reply with the result.`;
    assert.ok(what.length > 400);
    const h2 = s.handoff.add({ what: `${what}\nThen:\n- step one\n- [ ] step two`, where: 'the host', why: 'the new images need them' });
    assert.equal(h2.what, `${what}\nThen:\n- step one\n- [ ] step two`);
    assert.doesNotMatch(t.read('docs/HANDOFF.md'), /…/);
    assert.match(t.read('docs/HANDOFF.md'), /- \[ \] \*\*H2\*\* Confirm the M0 production environment .*Reply with the result\.\n\n {2}> Then:\n {2}> - step one\n {2}> - \[ \] step two\n\n {2}- Where: the host\n/);
    // Too long: refused, saying so (never cut)
    assert.throws(() => s.handoff.add({ what: 'x', where: 'w'.repeat(MAX_LINE + 1), why: 'y' }), new RegExp(`where has ${count(MAX_LINE + 1)} characters, more than ${count(MAX_LINE)}: say it in fewer words`));
    assert.throws(() => s.handoff.reply('H1', 'r'.repeat(MAX_MESSAGE + 1)), new RegExp(`the reply has ${count(MAX_MESSAGE + 1)} characters, more than ${count(MAX_MESSAGE)}: split it into two replies`));
    assert.throws(() => s.handoff.answer('H1', 'a'.repeat(MAX_MESSAGE + 1)), /the answer has 20,001 characters, more than 20,000: put the long part in a file under docs\//);
    assert.throws(() => s.handoff.answer('H1', ' \n '), /the answer is empty/);

    // A conversation: the owner, the team, the owner; each whole, in time order
    s.handoff.reply('H1', 'Namecheap, please.\nThe .com and the .net.');
    let x = s.handoff.answer('h1', 'Bought both.\r\nThe receipt is in the shared folder.\x1b[31m');
    assert.deepEqual(x.thread.map((e) => [e.by, e.text]), [['owner', 'Which registrar?'], ['owner', 'Namecheap, please.\nThe .com and the .net.'], ['team', 'Bought both.\nThe receipt is in the shared folder.[31m']], 'Windows line ends made plain, control characters out');
    assert.equal(unreadAnswer(x), true);
    x = s.handoff.reply('H1', 'Thanks!');
    assert.equal(unreadAnswer(x), false, 'the owner replied: read');
    s.handoff.answer('H1', 'You are welcome.');
    x = s.handoff.done('H1');
    assert.deepEqual([x.status, unreadAnswer(x)], ['done', false], 'Done reads it too');
    assert.throws(() => s.handoff.done('H1'), /H1 is done already/);
    // An answer after Done: it waits for the owner again; Done marks it read and doesn't wake the team
    s.handoff.seen(['H1']);
    x = s.handoff.answer('H1', 'The DNS records are set too.');
    assert.equal(unreadAnswer(x), true);
    x = s.handoff.done('H1');
    assert.deepEqual([x.status, unreadAnswer(x), !!x.readAt], ['done', false, true]);
    assert.deepEqual(s.news().handoff, [], 'no news for the team');
    // ... unless the owner says something with it
    s.handoff.answer('H1', 'One more: renew in a year.');
    s.handoff.done('H1', { reply: 'Noted.' });
    assert.deepEqual(s.news().handoff, ['H1']);
    // A cancelled card takes no answer
    s.handoff.add({ what: 'Rotate the key', where: 'the provider', why: 'it leaked' });
    s.handoff.cancel('H3', { reply: 'not needed after all' });
    assert.throws(() => s.handoff.answer('H3', 'x'), /H3 is cancelled: ask the owner with a new item/);

    // The Markdown has the whole conversation, each text in its quote, and brings it back
    const md = t.read('docs/HANDOFF.md');
    assert.match(md, / {2}- The owner replied [\d-]+ [\d:]+:\n\n {4}> Namecheap, please\.\n {4}> The \.com and the \.net\.\n\n {2}- The team answered [\d-]+ [\d:]+:\n\n {4}> Bought both\./);
    const copy = tempStore({ 'docs/HANDOFF.md': md });
    try {
      const back = Object.fromEntries(copy.store().handoff.list().map((i) => [i.id, i]));
      assert.deepEqual(Object.keys(back).sort(), ['H1', 'H2', 'H3']);
      assert.deepEqual(back.H1.thread.map((e) => [e.by, e.text]), s.handoff.list()[0].thread.map((e) => [e.by, e.text]));
      assert.deepEqual([back.H1.status, back.H2.status, back.H3.status, back.H3.note], ['done', 'open', 'cancelled', 'not needed after all']);
      assert.equal(back.H2.what, h2.what);
    } finally {
      copy.cleanup();
    }
  } finally {
    t.cleanup();
  }
});

test("a terminal's control characters don't get into a card: the owner's window prints the cards (handoff list)", () => {
  const t = tempStore();
  try {
    const s = t.store();
    const x = s.handoff.add({ what: 'Check\x1b[2J the logs', where: 'the\x1b]0;x\x07 server', why: 'errors\x00' });
    assert.deepEqual([x.what, x.where, x.why], ['Check[2J the logs', 'the]0;x server', 'errors']);
    assert.equal(s.handoff.answer('H1', 'Done\x1b[31m.\ttabs\tstay').thread[0].text, 'Done[31m.\ttabs\tstay');
  } finally {
    t.cleanup();
  }
});

test("cards saved before FR-014 and replies an older nextlevel writes join the thread in time order", () => {
  const x = { id: 'H9', status: 'open', reply: 'Yes, on the conditions in my note.', repliedAt: '2026-09-29T03:08:00.000Z', thread: [{ by: 'owner', text: 'Approved in principle.', at: '2026-09-29T00:57:00.000Z' }, { by: 'team', text: 'Here is the diff.', at: '2026-09-29T05:00:00.000Z' }] };
  assert.deepEqual(threadOf(x).map((e) => e.text), ['Approved in principle.', 'Yes, on the conditions in my note.', 'Here is the diff.']);
  assert.deepEqual(threadOf({ id: 'H5', reply: 'Done.', repliedAt: '2026-09-27T03:30:57.759Z' }), [{ by: 'owner', text: 'Done.', at: '2026-09-27T03:30:57.759Z' }]);
  assert.deepEqual(threadOf({ id: 'H1', reply: '' }), []);
  // What the empty file looks like, with the commands to use
  assert.match(handoffMarkdown([]), /nextlevel handoff add --file <request>.*\n.*handoff answer <id> --file <answer>/);
});

// ---------- free text from a file ----------
test('free text comes from a file in the project (or stdin), never a .env or git file; UTF-16 and code page 1252 are read right', () => {
  const t = tempStore();
  try {
    write(t.root, '.nextlevel/answer.md', 'whole\n');
    assert.equal(readTextFile('.nextlevel/answer.md', { root: t.root, cwd: t.root }), 'whole\n');
    assert.equal(readTextFile(path.join(t.root, '.nextlevel', 'answer.md'), { root: t.root }), 'whole\n');
    assert.equal(readTextFile('-', { root: t.root, stdin: () => Buffer.from('from stdin') }), 'from stdin');
    assert.throws(() => readTextFile('-', { root: t.root, stdin: () => Buffer.alloc(300 * 1024, 0x61) }), /stdin brought 300 KB, more than 256 KB/);
    assert.throws(() => readTextFile('', { root: t.root }), /--file needs a path/);
    assert.throws(() => readTextFile('nope.md', { root: t.root, cwd: t.root }), /there is no file nope\.md: write the text to a file in the project folder first/);
    const outside = path.join(os.tmpdir(), `nextlevel-outside-${process.pid}.md`);
    fs.writeFileSync(outside, 'x');
    try {
      assert.throws(() => readTextFile(outside, { root: t.root }), /is outside the project folder/);
    } finally {
      fs.rmSync(outside, { force: true });
    }
    for (const f of ['.env', 'apps/web/.env.local']) {
      write(t.root, f, 'KEY=value\n');
      assert.throws(() => readTextFile(f, { root: t.root, cwd: t.root }), /is a \.env file: its values are secrets/);
    }
    write(t.root, '.env.example', 'KEY=\n');
    assert.equal(readTextFile('.env.example', { root: t.root, cwd: t.root }), 'KEY=\n');
    write(t.root, '.git/config', '[core]\n');
    assert.throws(() => readTextFile('.git/config', { root: t.root, cwd: t.root }), /is in git's own folder/);
    // PowerShell 5.1's `>` writes UTF-16 with a mark; its Set-Content, code page 1252
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('“Go” – 100%', 'utf16le')])), '“Go” – 100%');
    assert.equal(decodeText(Buffer.from([0x93, 0x47, 0x6f, 0x94, 0x20, 0x96])), '“Go” –');
    assert.equal(decodeText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('é')])), 'é');
  } finally {
    t.cleanup();
  }
});

test('every command that takes free text takes it from --file; an answer only from a file; notify --file', () => {
  const p = makeProject();
  try {
    write(p.repo, '.nextlevel/reply.md', 'Switched to Postgres 17.\nThe migration ran clean.\n');
    assert.equal(p.hub(['note', 'add', 'Use Postgres']).code, 0);
    let r = p.hub(['note', 'done', 'N1', '--file', '.nextlevel/reply.md']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /N1 is done: "Switched to Postgres 17\. The migration ran clean\."/, 'a note reply is one line');
    r = p.hub(['note', 'done', 'N1', '--reply', 'x', '--file', '.nextlevel/reply.md']);
    assert.match(r.out, /give the reply once: in a file \(--file\) or in the command, not both/);
    write(p.repo, '.nextlevel/note.md', 'Keep the API small:\n- no GraphQL\n- REST only\n');
    assert.equal(p.hub(['note', 'add', '--file', '.nextlevel/note.md', '--rule']).code, 0);
    assert.equal(JSON.parse(p.hub(['note', 'list', '--json']).out).rules[0].text, 'Keep the API small:\n- no GraphQL\n- REST only');
    // A request, where and why from lines of the file
    write(p.repo, '.nextlevel/request.md', 'Put the SMTP host in .env as SMTP_HOST\nWhere: the mail panel, Settings -> SMTP\nWhy: sign-up mail\nTask: M2-03\n');
    assert.equal(p.hub(['handoff', 'add', '--file', '.nextlevel/request.md']).code, 0);
    const [h1] = JSON.parse(p.hub(['handoff', 'list', '--json']).out).open;
    assert.deepEqual([h1.what, h1.where, h1.why, h1.task], ['Put the SMTP host in .env as SMTP_HOST', 'the mail panel, Settings -> SMTP', 'sign-up mail', 'M2-03']);
    // An answer: only from a file
    r = p.hub(['handoff', 'answer', 'H1', 'It is done']);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /usage: nextlevel handoff answer <id> --file <path>/);
    assert.notEqual(p.hub(['handoff', 'answer', 'H1']).code, 0);
    assert.match(p.hub(['handoff', 'answer', 'H1', '--file', '../elsewhere.md']).out, /there is no file|outside the project folder/);
    r = p.hub(['handoff', 'answer', 'H1', '--file', '-'], { input: 'From stdin:\nline two\n' });
    assert.equal(r.code, 0, r.out);
    assert.equal(JSON.parse(p.hub(['handoff', 'show', 'H1', '--json']).out).item.thread[0].text, 'From stdin:\nline two');
    // The phone's message from a file too
    write(p.repo, '.nextlevel/message.md', 'Line one\nLine two with "quotes" and 100%\n');
    r = p.hub(['notify', 'Needs you: H1', '--file', '.nextlevel/message.md', 'high']);
    assert.equal(r.code, 0, r.out);
    const queued = fs.readdirSync(p.state('outbox')).map((f) => JSON.parse(fs.readFileSync(p.state('outbox', f), 'utf8')));
    assert.deepEqual(queued.map((m) => [m.title, m.message, m.priority]).sort(), [
      ['Needs you: H1', 'Line one\nLine two with "quotes" and 100%', 'high'],
      ['proj: the team answered H1', 'The team answered on card H1 ("Put the SMTP host in .env as SMTP_HOST"). Read it, then reply or mark it done, on the dashboard: Notes and handoffs, card H1.', 'high'],
    ], "the notify, and the answer's own message");
    assert.match(p.hub(['notify', 'x', 'y', '--file', '.nextlevel/message.md']).out, /give the message once/);
  } finally {
    p.cleanup();
  }
});

test("`handoff list` fits what the orchestrator's engine shows, and says where a text it shortened is whole; `handoff show` shows a card whole, in parts", async () => {
  const t = tempStore();
  const { cmdHandoff } = await import('../src/notes.mjs');
  // What a command prints
  const printed = async (args, store) => {
    const lines = [];
    const log = console.log;
    console.log = (x) => lines.push(String(x));
    try {
      await cmdHandoff(args, { store });
    } finally {
      console.log = log;
    }
    return lines.join('\n');
  };
  try {
    const s = t.store();
    const reply = (n) => Array.from({ length: 40 }, (_, i) => `- H${n}, point ${i + 1}: the owner's words, all of them for the team`).join('\n');
    for (let n = 1; n <= 6; n++) {
      s.handoff.add({ what: `Decide on part ${n}`, where: 'the card', why: 'the plan' });
      s.handoff.reply(`H${n}`, reply(n));
    }
    const list = await printed(['list'], s);
    withinBudget(list, 'nextlevel handoff list');
    assert.equal(quotedAfter(list, /^ +the owner replied \([^)]*\), [\d,]+ characters, whole:$/, PAD), reply(1), 'the first card whole');
    assert.match(list, new RegExp(`H6 +open +Decide on part 6\\n.*\\n +the owner replied \\([^)]*\\): "- H6, point 1: .*… \\[cut here: ${reply(6).length} characters in all; the whole text: nextlevel handoff show H6\\]"`));
    const shown = await printed(['show', 'H6'], s);
    assert.equal(quotedAfter(shown, /^the owner replied \(.*\), new to you, [\d,]+ characters:$/, ''), reply(6));
    // An answer longer than one output: in parts that each fit, the next part named
    s.handoff.answer('H1', Array.from({ length: 600 }, (_, i) => `Answer line ${i + 1}`).join('\n'));
    const parts = [];
    for (let from = 1, i = 0; from && i < 10; i++) {
      const part = await printed(['show', 'H1', '--from', String(from)], s);
      withinBudget(part, 'nextlevel handoff show');
      parts.push(part);
      from = Number((part.match(/nextlevel handoff show H1 --from (\d+)\]$/) || [])[1]) || 0;
    }
    assert.ok(parts.length > 2, `${parts.length} parts`);
    assert.match(parts[0], /^Shortened here: H1 has \d+ lines \(\d+ KB\), and lines 1-\d+ are shown below\. Read all of it before you answer\. The next part: nextlevel handoff show H1 --from \d+\./);
    assert.match(parts.at(-1), /Answer line 600\n\[the end of H1\]$/);
    const answerLines = parts.join('\n').split('\n').filter((l) => /^> Answer line \d+$/.test(l));
    assert.equal(answerLines.length, 600, 'every line of it, once');
  } finally {
    t.cleanup();
  }
});

test("What needs you: a card the team answered, until the owner replies or marks it done (lib/overview.mjs)", () => {
  const base = { hub: { running: true }, autopilot: { on: true, paused: null }, active: [], queued: [], review: [], alerts: [], milestones: [], waiting: [], orchestrator: null };
  const needs = ownerNeeds({ ...base, handoff: [{ id: 'H1', what: 'Pick the mail provider\nmore lines', where: 'the card', why: 'M2', status: 'open', unread: true }, { id: 'H2', what: 'Buy the domain', where: 'the registrar', why: 'the site', status: 'open' }] });
  assert.deepEqual(needs.map((n) => [n.kind, n.text]), [['answer', 'H1: the team answered: Pick the mail provider'], ['handoff', 'H2: Buy the domain (where: the registrar)']]);
  assert.deepEqual(needs[0].action, { label: 'Read the answer', page: 'notes', focus: 'H1' });
});
