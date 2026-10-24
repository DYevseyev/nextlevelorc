// The owner's notes and the team's handoff items as cards (src/lib/cards.mjs, src/notes.mjs): the store, the import
// of a project's current Markdown, the Markdown written from the cards, hand edits read back, several writers at
// once, and the commands the orchestrator and the owner use.
//   npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { cardStore, handoffMarkdown, noteGroups, notesMarkdown } from '../src/lib/cards.mjs';
import { getState } from '../src/lib/state.mjs';
import { REPO, hubRounds, makeProject, processesGone, sleep } from './helpers.mjs';

const FILES = { notes: 'docs/OWNER_NOTES.md', handoff: 'docs/HANDOFF.md' };
function tempProject(files = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-cards-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  const store = cardStore({ root, stateDir: path.join(root, '.nextlevel'), files: FILES });
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  return { root, store, read, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("a project's current notes and handoff list are imported: New, rules and Done; open and ticked items (reading writes nothing)", () => {
  const t = tempProject({
    'docs/OWNER_NOTES.md':
      '# Owner notes\r\n\r\nWrite instructions for the orchestrator here.\r\n\r\n## New\r\n- Use Postgres.\r\n- Keep the API small:\r\n  no GraphQL.\r\n\r\nA paragraph note\r\nover two lines.\r\n\r\n## Rules\r\n- Never deploy on Fridays.\r\n\r\n## Done\r\n- Use port 8080. (done)\r\n',
    'docs/HANDOFF.md': '# Handoff - steps only the owner can do\n\nThe agent team adds any manual step as a `- [ ]` item.\n\n- [ ] Add the SMTP password to .env\n  Where: .env in the project folder\n  Why: sign-up mail\n- [x] Buy the domain\n- [ ] (none yet)\n',
  });
  try {
    const notes = t.store.notes.list();
    assert.deepEqual(notes.map((n) => [n.id, n.type, n.status, n.text]), [
      ['N1', 'once', 'new', 'Use Postgres.'],
      ['N2', 'once', 'new', 'Keep the API small:\nno GraphQL.'],
      ['N3', 'once', 'new', 'A paragraph note\nover two lines.'],
      ['N4', 'rule', 'new', 'Never deploy on Fridays.'],
      ['N5', 'once', 'done', 'Use port 8080. (done)'],
    ]);
    assert.deepEqual(t.store.handoff.list().map((x) => [x.id, x.status, x.what, x.where, x.why]), [
      ['H1', 'open', 'Add the SMTP password to .env', '.env in the project folder', 'sign-up mail'],
      ['H2', 'done', 'Buy the domain', '', ''],
    ]);
    assert.deepEqual(t.store.news(), { notes: ['N1', 'N2', 'N3', 'N4'], handoff: [] }, 'what the orchestrator has not answered; imported handoff items are not news');
    assert.ok(!fs.existsSync(path.join(t.root, '.nextlevel', 'notes.json')), 'reading writes nothing');
    assert.match(t.read('docs/OWNER_NOTES.md'), /## New\r\n- Use Postgres\./, 'the file as it was');
    const g = noteGroups(notes);
    assert.deepEqual([g.rules, g.open, g.history].map((l) => l.map((n) => n.id)), [['N4'], ['N1', 'N2', 'N3'], ['N5']]);
    // getState's "waiting on the owner": the open items
    assert.deepEqual(getState({ root: t.root, handoff: () => t.store.handoff.list() }).waiting, ['Add the SMTP password to .env']);
  } finally {
    t.cleanup();
  }
});

test('every change writes the cards and the Markdown from them; the Markdown can be imported again with its ids and states', () => {
  const t = tempProject({ 'docs/OWNER_NOTES.md': '# Owner notes\n\n## New\n- Use Postgres.\n\n## Done\n' });
  try {
    const s = t.store;
    assert.equal(s.notes.add({ text: 'Add a dark mode', type: 'once' }).id, 'N2', 'after the imported one');
    assert.equal(s.notes.add({ text: 'Never deploy on Fridays', type: 'rule' }).id, 'N3');
    s.notes.seen(['N1', 'N3']);
    s.notes.done('N1', { reply: 'Switched to Postgres 17', commit: 'abc1234', task: 'M1-02' });
    s.notes.decline('N2', { reply: 'The brief says light only' });
    s.handoff.add({ what: 'Put the SMTP host in .env', where: 'the mail panel, Settings -> SMTP', why: 'sign-up mail', task: 'M2-03' });
    const md = t.read('docs/OWNER_NOTES.md');
    assert.match(md, /^# Owner notes\n\n<!-- Written by nextlevel from \.nextlevel\/notes\.json: don't edit it by hand/);
    assert.match(md, /## Standing rules\n\n- \*\*N3\*\* \(rule, seen\) Never deploy on Fridays\n/);
    assert.match(md, /## To do\n\n_None\._/);
    assert.match(md, /- \*\*N1\*\* \(one-time, done\) Use Postgres\.\n.*\n  - Done [\d-]+ [\d:]+: Switched to Postgres 17 \(commit abc1234, task M1-02\)/);
    assert.match(md, /- \*\*N2\*\* \(one-time, declined\) Add a dark mode\n.*\n  - Declined [\d-]+ [\d:]+: The brief says light only/);
    assert.match(t.read('docs/HANDOFF.md'), /## Open\n\n- \[ \] \*\*H1\*\* Put the SMTP host in \.env\n  - Where: the mail panel, Settings -> SMTP\n  - Why: sign-up mail\n  - Asked [\d-]+ [\d:]+ \(task M2-03\)\n/);
    // The state folder is gone (a fresh clone): the Markdown brings the cards back, ids and states included
    fs.rmSync(path.join(t.root, '.nextlevel'), { recursive: true });
    const again = cardStore({ root: t.root, stateDir: path.join(t.root, '.nextlevel'), files: FILES });
    assert.deepEqual(again.notes.list().map((n) => [n.id, n.type, n.status, n.text, n.reply]).sort(), [
      ['N1', 'once', 'done', 'Use Postgres.', 'Switched to Postgres 17 (commit abc1234, task M1-02)'],
      ['N2', 'once', 'declined', 'Add a dark mode', 'The brief says light only'],
      ['N3', 'rule', 'seen', 'Never deploy on Fridays', ''],
    ]);
    assert.deepEqual(again.handoff.list().map((x) => [x.id, x.status, x.what, x.where, x.why]), [['H1', 'open', 'Put the SMTP host in .env', 'the mail panel, Settings -> SMTP', 'sign-up mail']]);
    assert.equal(again.notes.add({ text: 'Next one' }).id, 'N4', 'numbering goes on after the highest id');
  } finally {
    t.cleanup();
  }
});

test("the owner's actions and the orchestrator's answers, and what each may not do", () => {
  const t = tempProject();
  try {
    const { notes, handoff } = t.store;
    notes.add({ text: 'Rename the app to Foo' });
    notes.add({ text: 'Always write tests first', type: 'rule' });
    notes.seen(['N1']);
    // An edit after the orchestrator saw it: it reads it again
    const edited = notes.edit('N1', 'Rename the app to Bar');
    assert.deepEqual([edited.status, edited.seenAt, !!edited.editedAt], ['new', null, true]);
    assert.throws(() => notes.done('N2', { reply: 'x' }), /standing rule: it stays until the owner removes it/);
    assert.throws(() => notes.withdraw('N2'), /switch it off or remove it/);
    assert.throws(() => notes.setOff('N1', true), /only a standing rule is switched off/);
    assert.throws(() => notes.done('N1', { reply: '  ' }), /the reply is empty/);
    assert.throws(() => notes.done('N9', { reply: 'x' }), /there is no "N9"/);
    assert.throws(() => notes.add({ text: '' }), /the note is empty/);
    assert.equal(notes.withdraw('n1').status, 'withdrawn', 'ids in any case');
    assert.throws(() => notes.edit('N1', 'again'), /N1 is withdrawn already/);
    // A rule switched off, on again (the orchestrator is told), removed (history)
    notes.seen(['N2']);
    assert.equal(notes.setOff('N2', true).off, true);
    assert.deepEqual(t.store.news().notes, [], 'a rule switched off is no news');
    const on = notes.setOff('N2', false);
    assert.deepEqual([on.off, on.status], [false, 'new']);
    assert.equal(notes.remove('N2').status, 'removed');
    assert.deepEqual(noteGroups(notes.list()).history.map((n) => n.id).sort(), ['N1', 'N2']);
    // Handoff: the owner replies, then marks it done; the orchestrator picks it up
    handoff.add({ what: 'Buy the domain', where: 'the registrar', why: 'the site needs it' });
    assert.throws(() => handoff.add({ what: 'x', where: '', why: 'y' }), /where is empty/);
    assert.deepEqual(t.store.news().handoff, [], 'what the team asked is no news to the team');
    handoff.reply('H1', 'Which registrar?');
    assert.deepEqual(t.store.news().handoff, ['H1'], 'a reply is');
    handoff.seen(['H1']);
    assert.deepEqual(t.store.news().handoff, []);
    handoff.done('H1', { reply: 'bought example.com' });
    assert.deepEqual(t.store.news().handoff, ['H1']);
    assert.throws(() => handoff.done('H1'), /H1 is done already/);
    handoff.seen(['H1']);
    handoff.add({ what: 'Rotate the key', where: 'the provider panel', why: 'it leaked' });
    assert.equal(handoff.cancel('H2', { reply: 'not needed after all' }).status, 'cancelled');
    assert.match(t.read('docs/HANDOFF.md'), /- \[x\] \*\*H2\*\* Rotate the key\n(.*\n)*  - Cancelled [\d-]+ [\d:]+: not needed after all/);
  } finally {
    t.cleanup();
  }
});

test("lines added to the Markdown by hand are read back: a note typed there, an item an older orchestrator added, an item ticked; nothing is deleted", () => {
  const t = tempProject();
  try {
    t.store.notes.add({ text: 'First' });
    t.store.handoff.add({ what: 'Set the DNS', where: 'the registrar', why: 'the domain' });
    const notesFile = path.join(t.root, 'docs', 'OWNER_NOTES.md');
    fs.writeFileSync(notesFile, t.read('docs/OWNER_NOTES.md').replace('## To do\n\n', '## To do\n\n- Also: use pnpm, not npm\n').replace(/- \*\*N1\*\*.*\n.*\n/, ''));
    const handoffFile = path.join(t.root, 'docs', 'HANDOFF.md');
    fs.writeFileSync(handoffFile, `${t.read('docs/HANDOFF.md').replace('- [ ] **H1**', '- [x] **H1**')}- [ ] Rotate the API key\n`);
    assert.deepEqual(t.store.notes.list().map((n) => [n.id, n.status, n.text]), [['N1', 'new', 'First'], ['N2', 'new', 'Also: use pnpm, not npm']], 'N1 stays although its lines were deleted');
    assert.deepEqual(t.store.handoff.list().map((x) => [x.id, x.status, x.what]), [['H1', 'done', 'Set the DNS'], ['H2', 'open', 'Rotate the API key']]);
    assert.deepEqual(t.store.news().handoff, ['H1'], 'ticked by hand: news for the orchestrator');
    // The next change keeps them, with the same ids, and writes the files again
    t.store.notes.seen(['N2']);
    assert.match(t.read('docs/OWNER_NOTES.md'), /\*\*N2\*\* \(one-time, seen\) Also: use pnpm, not npm/);
    assert.match(t.read('docs/OWNER_NOTES.md'), /\*\*N1\*\* \(one-time, new\) First/);
    t.store.handoff.seen(['H1']);
    assert.deepEqual(t.store.handoff.list().map((x) => [x.id, x.status]), [['H1', 'done'], ['H2', 'open']]);
    assert.match(t.read('docs/HANDOFF.md'), /- \[ \] \*\*H2\*\* Rotate the API key/);
    // Windows line ends (git's autocrlf) are no hand edit
    fs.writeFileSync(notesFile, t.read('docs/OWNER_NOTES.md').replace(/\n/g, '\r\n'));
    assert.equal(t.store.notes.list().length, 2);
  } finally {
    t.cleanup();
  }
});

test('several nextlevel processes changing the notes at once lose nothing (the dashboard, the owner, the orchestrator)', async () => {
  const t = tempProject();
  try {
    const script = `import(${JSON.stringify(pathToFileURL(path.join(REPO, 'src', 'lib', 'cards.mjs')).href)}).then(({ cardStore }) => { const s = cardStore({ root: process.argv[1], stateDir: process.argv[1] + '/.nextlevel', files: ${JSON.stringify(FILES)} }); for (let i = 0; i < 5; i++) s.notes.add({ text: 'from ' + process.argv[2] + ' #' + i }); })`;
    const runs = [...Array(4).keys()].map((n) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, t.root, `p${n}`], { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = '';
      child.stderr.on('data', (d) => (err += d));
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(err))));
    }));
    await Promise.all(runs);
    const items = t.store.notes.list();
    assert.equal(items.length, 20, 'every note is there');
    assert.equal(new Set(items.map((n) => n.id)).size, 20, 'every id is its own');
    assert.equal((t.read('docs/OWNER_NOTES.md').match(/^- \*\*N\d+\*\*/gm) || []).length, 20, 'the Markdown has them all');
    assert.ok(!fs.existsSync(path.join(t.root, '.nextlevel', 'cards.lock')), 'the lock is gone');
  } finally {
    t.cleanup();
  }
});

test("a new project's notes and handoff files are the Markdown the cards write when there are none", () => {
  const template = (f) => fs.readFileSync(path.join(REPO, 'templates', 'project', 'docs', f), 'utf8');
  assert.equal(template('OWNER_NOTES.md'), notesMarkdown([]));
  assert.equal(template('HANDOFF.md'), handoffMarkdown([]));
});

test('nextlevel note and nextlevel handoff: the orchestrator reads and answers, the owner adds and marks done; status and the hub see them', () => {
  const p = makeProject();
  try {
    const nl = (args, extraEnv) => p.hub(args, { extraEnv });
    let r = nl(['note', 'add', 'Use Postgres for everything']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Added N1 \(a one-time instruction\)/);
    assert.match(nl(['note', 'add', 'Never deploy on Fridays', '--rule']).out, /Added N2 \(a standing rule\)/);
    r = nl(['note', 'list']);
    assert.match(r.out, /Standing rules: follow them in everything you do\n {2}N2 {4}NEW .*Never deploy on Fridays/);
    assert.match(r.out, /One-time instructions to act on\n {2}N1 {4}NEW .*Use Postgres for everything/);
    assert.match(r.out, /New or changed: N2, N1\. When you take one on \(or follow a rule\): nextlevel note seen <id>/);
    const json = JSON.parse(nl(['note', 'list', '--json']).out);
    assert.deepEqual([json.rules.map((n) => n.id), json.open.map((n) => n.id), json.file], [['N2'], ['N1'], 'docs/OWNER_NOTES.md']);
    assert.match(nl(['note', 'seen', 'N1', 'N2']).out, /Marked seen: N1, N2\./);
    // done needs a reply; a commit is a hash
    assert.equal(nl(['note', 'done', 'N1']).code, 1);
    r = nl(['note', 'done', 'N1', '--reply', 'Switched to Postgres 17', '--commit', 'not-a-sha']);
    assert.equal(r.code, 1);
    assert.match(r.out, /--commit takes a commit's hash/);
    r = nl(['note', 'done', 'N1', '--reply', 'Switched to Postgres 17', '--commit', 'abc1234', '--task', 'M1-02']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /N1 is done: "Switched to Postgres 17"/);
    assert.match(nl(['note', 'list', '--all', '--search', 'postgres']).out, /History matching "postgres"\n {2}N1 {4}done .* -> done: Switched to Postgres 17 \(commit abc1234, task M1-02\)/);
    assert.match(nl(['note', 'done', 'N2', '--reply', 'x']).out, /standing rule/);
    // The owner's side of the notes
    nl(['note', 'add', 'Add a dark mode']);
    assert.match(nl(['note', 'edit', 'N3', 'Add a dark mode, off by default']).out, /Changed N3: the orchestrator reads it again/);
    assert.match(nl(['note', 'withdraw', 'N3']).out, /Withdrew N3/);
    assert.match(nl(['note', 'off', 'N2']).out, /Switched N2 off/);
    assert.match(nl(['note', 'list']).out, /1 switched off by the owner: don't follow it: N2/);
    assert.match(nl(['note', 'on', 'N2']).out, /Switched N2 on/);
    assert.match(nl(['note', 'remove', 'N2']).out, /Removed the rule N2/);
    assert.equal(nl(['note', 'frobnicate']).code, 1);
    // A worker in its slot doesn't write them (they would end up in its task branch)
    const slot = nl(['note', 'add', 'from a worker'], { NEXTLEVEL_TASK_ID: 'M1-01-x' });
    assert.equal(slot.code, 1);
    assert.match(slot.out, /workers don't change the owner's notes: put what the orchestrator or the owner should know in your report/);
    assert.match(nl(['handoff', 'list'], { NEXTLEVEL_TASK_ID: 'M1-01-x' }).out, /workers don't change the handoff list/);

    // Handoff: what, where and why are required; the owner's reply comes back to the team
    r = nl(['handoff', 'add', 'Put the SMTP host in .env']);
    assert.equal(r.code, 1);
    assert.match(r.out, /--where "which window, panel or file" --why/);
    r = nl(['handoff', 'add', 'Put the SMTP host in .env as SMTP_HOST', '--where', 'the mail panel, Settings -> SMTP', '--why', 'sign-up mail', '--task', 'M2-03']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Added H1\. Tell the owner, with the same words: nextlevel notify "Needs you: Put the SMTP host in \.env as SMTP_HOST" "Put the SMTP host in \.env as SMTP_HOST \(where: the mail panel, Settings -> SMTP; why: sign-up mail\)" high/);
    assert.deepEqual(JSON.parse(nl(['status', '--json']).out).waitingOnOwner, ['Put the SMTP host in .env as SMTP_HOST'], 'status: from the cards');
    assert.match(nl(['handoff', 'done', 'H1', '--reply', 'smtp.example.com']).out, /H1 is done/);
    r = nl(['handoff', 'list']);
    assert.match(r.out, /Waiting on the owner .*\n {2}nothing\n\nDone by the owner, not picked up yet: act on it, then nextlevel handoff seen <id>\n {2}H1 {4}done {6}Put the SMTP host/);
    assert.match(r.out, /the owner replied \([\d-]+ [\d:]+\): "smtp\.example\.com"/);
    assert.match(nl(['handoff', 'seen', 'H1']).out, /Picked up: H1\./);
    assert.doesNotMatch(nl(['handoff', 'list']).out, /not picked up yet/);
    assert.deepEqual(JSON.parse(nl(['status', '--json']).out).waitingOnOwner, []);
    // The Markdown for Git
    const md = fs.readFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), 'utf8');
    assert.match(md, /- \[x\] \*\*H1\*\* Put the SMTP host in \.env as SMTP_HOST\n  - Where: the mail panel, Settings -> SMTP\n  - Why: sign-up mail\n  - Asked .* \(task M2-03\)\n  - The owner replied [\d-]+ [\d:]+:\n\n    > smtp\.example\.com\n\n  - Done [\d-]+ [\d:]+ by the owner\n/, "the owner's reply in a quoted block (FR-014)");
    assert.ok(fs.existsSync(p.state('notes.json')) && fs.existsSync(p.state('handoff.json')), 'the cards live in the state folder');
    // A path in nextlevel.json of the project's own
    p.setConfig((c) => ({ ...c, paths: { ...c.paths, notes: 'docs/NOTES-FOR-THE-TEAM.md' } }));
    nl(['note', 'add', 'Elsewhere now']);
    const moved = fs.readFileSync(path.join(p.repo, 'docs', 'NOTES-FOR-THE-TEAM.md'), 'utf8');
    assert.match(moved, /\*\*N4\*\* \(one-time, new\) Elsewhere now/);
    assert.match(moved, /\*\*N1\*\* \(one-time, done\) Use Postgres for everything/, 'the cards, all of them');
  } finally {
    p.cleanup();
  }
});

test('the orchestrator is told about the notes and progress notes: the worker prompt asks for them (and the .cmd shims for Codex on Windows)', () => {
  const p = makeProject();
  try {
    const log = path.join(p.tmp, 'codex-calls.jsonl');
    p.spec('M10-01-ok', 'node -e "0"');
    p.hub(['dispatch', 'M10-01-ok', '--engine', 'codex']);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    const call = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a[0] === 'exec' && /ROLE: WORKER/.test(a.at(-1)));
    const prompt = call.at(-1);
    assert.match(prompt, /Every few steps, add one short line to \.nextlevel-task\/PROGRESS\.md: what you are doing and why\./);
    assert.equal(call.at(-2), '--json', 'its steps as JSON, for the feed');
    if (process.platform === 'win32') assert.match(prompt, /run pnpm\.cmd, npm\.cmd and npx\.cmd/);
    else assert.doesNotMatch(prompt, /pnpm\.cmd/, 'the .ps1 shims are a Windows thing');
    // The worker's progress notes stay beside the job once the slot is free
    assert.match(fs.readFileSync(p.jobFile('M10-01-ok', 'PROGRESS.md'), 'utf8'), /^Reading the task: M10-01-ok on codex$/m);
    assert.equal(p.status('M10-01-ok').state, 'done');
  } finally {
    p.cleanup();
  }
});

test('autopilot wakes the orchestrator for a new note even while the workers are busy', async () => {
  const p = makeProject();
  // A task that runs (its worker: a process that waits), so the workers are busy
  const busy = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' });
  let hub;
  try {
    const at = new Date().toISOString();
    fs.mkdirSync(p.state('jobs', 'M10-02-busy'), { recursive: true });
    fs.writeFileSync(p.jobFile('M10-02-busy', 'job.json'), JSON.stringify({ id: 'M10-02-busy', type: 'task', kind: 'code', engine: 'agy', attempt: 1, timeoutMin: 60 }));
    fs.writeFileSync(p.jobFile('M10-02-busy', 'status.json'), JSON.stringify({ id: 'M10-02-busy', type: 'task', kind: 'code', engine: 'agy', state: 'running', slot: 1, attempt: 1, startedAt: at, acked: false }));
    fs.writeFileSync(p.jobFile('M10-02-busy', 'run.json'), JSON.stringify({ pid: busy.pid, startedAt: at }));
    fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: true }));
    const hubLog = () => (fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '');
    const until = async (test, what, ms = 60_000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (test()) return;
      throw new Error(`${what}:\n${hubLog()}`);
    };
    hub = p.hubInBackground(['run', '--tick-ms', '100'], { STUB_CODEX_MODE: 'noop' });
    await until(() => /hub started/.test(hubLog()), 'the hub did not start');
    await hubRounds(p, 13); // autopilot looks every 12 rounds (0, 12, ...): it has looked twice
    assert.doesNotMatch(hubLog(), /autopilot: orchestrator cycle started/, 'workers busy, nothing to decide');
    assert.match(p.hub(['note', 'add', 'Use pnpm']).out, /Added N1/);
    await until(() => /autopilot: orchestrator cycle started/.test(hubLog()), 'a new note is something to decide');
  } finally {
    fs.writeFileSync(p.state('hub-stop.json'), '{}');
    for (let i = 0; i < 50 && hub && hub.exitCode === null; i++) await sleep(200);
    hub?.kill();
    busy.kill();
    await processesGone([hub?.pid, busy.pid]);
    p.cleanup();
  }
});

test("FR-019: each store counts what the owner did, never what the team did, and the hub's own closing of a card isn't the owner's", () => {
  const t = tempProject({ 'docs/OWNER_NOTES.md': '# Owner notes\n\n## New\n- Use Postgres.\n', 'docs/HANDOFF.md': '# Handoff\n\n- [ ] Buy the domain\n' });
  try {
    const n = () => t.store.ownerActs().notes.n || 0;
    const h = () => t.store.ownerActs().handoff.n || 0;
    assert.deepEqual([n(), h()], [0, 0], 'what was imported is no action');
    // The team's side: nothing
    t.store.notes.seen(['N1']);
    t.store.notes.done('N1', { reply: 'Postgres it is' });
    const card = t.store.handoff.add({ what: 'Approve the plan', where: 'the dashboard', why: 'it changes M2' });
    t.store.handoff.answer('H1', 'Done on our side');
    t.store.handoff.seen(['H1']);
    assert.deepEqual([n(), h()], [0, 0]);
    // The owner's side, each counted, with what it was
    t.store.notes.add({ text: 'Plan M2' });
    t.store.notes.edit('N2', 'Plan M2 and M3');
    t.store.notes.add({ text: 'No Fridays', type: 'rule' });
    t.store.notes.setOff('N3', true);
    assert.deepEqual([n(), t.store.ownerActs().notes.what], [4, 'you switched N3 off']);
    t.store.handoff.reply(card.id, 'Go');
    t.store.handoff.done('H1');
    assert.deepEqual([h(), t.store.ownerActs().handoff.what], [2, 'you marked H1 done']);
    // A held change's card: the owner's decision counts; the hub closing a pointless one doesn't
    t.store.handoff.addGuard({ what: 'Approve or reject G1', where: 'the dashboard', why: 'a protected file', guard: 'G1' });
    t.store.handoff.addGuard({ what: 'Approve or reject G2', where: 'the dashboard', why: 'a push', guard: 'G2' });
    t.store.handoff.decideGuard('G1', { reply: 'Approved' });
    t.store.handoff.decideGuard('G2', { reply: 'Not needed any more', hub: true });
    assert.deepEqual([h(), t.store.ownerActs().handoff.what], [3, 'your decision on H3']);
    // A note typed into the Markdown by hand is the owner's, from the first look on
    fs.appendFileSync(path.join(t.root, 'docs/OWNER_NOTES.md'), '\n## New\n- Typed by hand\n');
    assert.equal(n(), 5);
    assert.equal(n(), 5, 'reading again counts it once');
    assert.match(t.store.ownerActs().notes.what, /^your note N\d+, typed into docs\/OWNER_NOTES\.md$/);
  } finally {
    t.cleanup();
  }
});
