// What a worker did outside its slot (demo, 17 October: N7's Antigravity worker wrote
// C:\Users\User\nextlevel-task\PROGRESS.md, an absolute path it typed wrong). The hub reads each attempt's log for files
// written outside the slot and commands aimed at another folder, compares the main checkout's HEAD and base branch before
// and after, keeps the guard's watch on the main checkout while a worker runs, and tells workers to use relative paths.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { guardDir } from '../src/lib/guard.mjs';
import { blockersView, ownerNeeds, pushWhy } from '../src/lib/overview.mjs';
import { outsideSlot, outsideWords, shorten, workerActions } from '../src/lib/slotwatch.mjs';
import { fileExists, makeProject } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

test("N7's attempt 1 replayed: the one write outside its slot is found, nothing it did inside is", () => {
  const log = fixture('agy-1.4.0-outside-slot.txt');
  const { files } = workerActions(log);
  assert.ok(files.length >= 4, files.join('\n'));
  const found = outsideSlot(log, { slot: 'C:\\Users\\User\\demo.slots\\w2' });
  assert.deepEqual(found, [{ kind: 'file', what: 'C:\\Users\\User\\nextlevel-task\\PROGRESS.md' }]);
  assert.equal(outsideWords(found), 'wrote C:\\Users\\User\\nextlevel-task\\PROGRESS.md');
  // Either slash, any case: the same slot
  assert.deepEqual(outsideSlot(log, { slot: 'c:/users/user/DEMO.slots/w2/' }), found);
});

test('each engine: writes and commands aimed elsewhere, relative paths that leave the slot, allowed folders, and the project never allowed', () => {
  const slot = '/home/me/proj.slots/w1';
  const agy = (name, parameters) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: name, tool_info: { name, parameters } } });
  const claude = (name, input) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const codex = (item) => JSON.stringify({ type: 'item.completed', item });
  const log = [
    agy('write_to_file', { TargetFile: `${slot}/ok.mjs` }),
    agy('replace_file_content', { TargetFile: '../../proj/stray.txt' }),
    agy('run_command', { CommandLine: 'git status' }),
    agy('run_command', { CommandLine: 'git -C /home/me/proj log -1' }),
    claude('Write', { file_path: '/home/me/notes.txt' }),
    claude('Edit', { file_path: `${slot}/src/a.mjs` }),
    claude('Bash', { command: 'cd /home/me/other && git commit -am x' }),
    claude('Bash', { command: 'cd src && npm test' }),
    codex({ type: 'command_execution', command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Set-Location C:\\proj; git log"' }),
    codex({ type: 'command_execution', command: '/bin/bash -lc "git --git-dir=/home/me/proj/.git status"' }),
    codex({ type: 'file_change', changes: [{ path: `${slot}/b.mjs` }, { path: '/home/me/proj.slots/w2/c.mjs' }] }),
    agy('write_to_file', { TargetFile: '/tmp/scratch.txt' }),
    'not JSON, a line of the hub',
  ].join('\n');
  const found = outsideSlot(log, { slot, allowed: ['/tmp'] });
  assert.deepEqual(
    found.map((x) => [x.kind, x.what, x.aims || '']),
    [
      ['file', '../../proj/stray.txt', ''],
      ['file', '/home/me/notes.txt', ''],
      ['file', '/home/me/proj.slots/w2/c.mjs', ''],
      ['command', 'git -C /home/me/proj log -1', '/home/me/proj'],
      ['command', 'cd /home/me/other && git commit -am x', '/home/me/other'],
      ['command', '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "Set-Location C:\\proj; git log"', 'C:\\proj'],
      ['command', '/bin/bash -lc "git --git-dir=/home/me/proj/.git status"', '/home/me/proj/.git'],
    ],
  );
  // The project and the other slots are outside even when an allowed folder holds them (tests' projects live in /tmp)
  const inTmp = [agy('write_to_file', { TargetFile: '/tmp/x/proj/stray.txt' }), agy('write_to_file', { TargetFile: '/tmp/x/proj.slots/w1/ok.txt' }), agy('write_to_file', { TargetFile: '/tmp/note.txt' })].join('\n');
  assert.deepEqual(
    outsideSlot(inTmp, { slot: '/tmp/x/proj.slots/w1', allowed: ['/tmp'], never: ['/tmp/x/proj', '/tmp/x/proj.slots'] }).map((x) => x.what),
    ['/tmp/x/proj/stray.txt'],
  );
  assert.match(outsideWords(Array.from({ length: 7 }, (_, i) => ({ kind: 'file', what: `/f${i}` }))), /^wrote \/f0; .*wrote \/f4; and 2 more$/);
  // A command that names the security engineer's Docker volumes, on any engine, though it runs in the slot (KNOWN_ISSUES)
  const sec = [
    codex({ type: 'command_execution', command: 'docker run --rm -v nextlevel-sec-login-0123456789abcdef:/l alpine ls /l' }),
    claude('Bash', { command: 'docker volume ls --filter name=NEXTLEVEL-SEC-' }),
    agy('run_command', { CommandLine: 'docker ps' }),
  ].join('\n');
  const named = outsideSlot(sec, { slot });
  assert.deepEqual(named.map((x) => x.kind), ['security', 'security']);
  assert.match(outsideWords(named), /^ran `docker run .*` \(it names the security engineer's Docker volumes, where its sign-in is\); ran `docker volume ls/);
});

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
const exited = (child) => new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
// (a folder by the name the file system has for it: GitHub's Windows runner has C:\Users\RUNNER~1 in TEMP, where git
// and the hub say C:\Users\runneradmin)
const real = (f) => fs.realpathSync.native(f).toLowerCase();
const mainLog = (p) => spawnSync('git', ['log', '--format=%s', '-3', 'main'], { cwd: p.repo, encoding: 'utf8' }).stdout;

const heldRecords = (p) => {
  const f = path.join(guardDir(p.repo, p.env.HOME), 'held.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items : [];
};

for (const engine of ['agy', 'codex', 'claude']) {
  test(`a worker on ${engine} that writes in the main checkout and commits there with git -C: a Home card, its status, hub.log and one phone message; Seen clears it`, async () => {
    const p = makeProject();
    const ntfy = await fakeNtfy();
    const id = `SW-01-outside-${engine}`;
    let ui;
    try {
      p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
      p.spec(id, fileExists(`${id}.mjs`));
      p.spec('SW-00-ok', fileExists('ok.mjs'));
      // (one after the other: a worker that ran beside it would see its move of main too, test below)
      p.hub(['dispatch', 'SW-00-ok', '--engine', engine]);
      p.runUntilIdle();
      p.hub(['dispatch', id, '--engine', engine]);
      await exited(p.hubInBackground(['run', '--exit-when-idle', '--tick-ms', '200'], { NTFY_TOPIC: 'a-long-random-topic-for-tests-1234' }));
      const s = p.status(id);
      assert.equal(s.state, 'done');
      assert.ok(mainLog(p).includes('stray commit from a worker'), 'the stub committed on main');
      assert.equal(p.status('SW-00-ok').outside, undefined, 'a worker that stays in its slot: nothing');
      assert.deepEqual(s.outside.items.map((x) => x.kind), ['file', 'command'], JSON.stringify(s.outside));
      assert.equal(real(s.outside.items[0].what), real(path.join(p.repo, 'stray-note.txt')));
      assert.match(s.outside.items[1].what, /git -C ".+" commit --allow-empty/);
      assert.ok(s.outside.moves.includes('the main checkout: commit: stray commit from a worker'), s.outside.moves.join('\n'));
      assert.ok(s.outside.moves.includes('main: commit: stray commit from a worker'), s.outside.moves.join('\n'));
      assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), new RegExp(`${id}: attempt 1's worker did something outside its slot`));
      const phone = ntfy.got.filter((m) => m.title === `proj: task ${id} worked outside its slot`);
      assert.equal(phone.length, 1, JSON.stringify(ntfy.got.map((m) => m.title)));
      assert.match(phone[0].message, /Found after the attempt; nothing was stopped/);
      // Home's card, and Seen
      ui = await startUi(p);
      const card = (await client(ui).get('/api/state')).json.needs.find((n) => n.kind === 'slotescape');
      assert.ok(card, 'the card is on Home');
      const stray = s.outside.items[0].what;
      const ran = s.outside.items[1];
      assert.equal(card.text, `Task ${id}'s worker (attempt 1) worked outside its slot: wrote ${stray}; ran \`${ran.what}\` (in ${ran.aims}). While it ran, git moved the main checkout, and not the hub: the main checkout: commit: stray commit from a worker; main: commit: stray commit from a worker.`);
      assert.equal(real(ran.aims), real(p.repo), 'the folder, without its quotes');
      assert.deepEqual(card.action, { label: 'Seen', post: '/api/slotescape', body: {} });
      assert.equal((await client(ui).post('/api/slotescape', {})).json?.ok, true);
      assert.equal((await client(ui).get('/api/state')).json.needs.find((n) => n.kind === 'slotescape'), undefined);
    } finally {
      await stopUi(ui);
      await ntfy.close();
      p.cleanup();
    }
  });
}

test('two workers at once: a move of the main checkout is said once, naming both, and moves alone are no alarm', async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  const id = 'SW-04-outside';
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    p.spec(id, fileExists(`${id}.mjs`));
    p.spec('SW-04-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', id, '--engine', 'agy']);
    p.hub(['dispatch', 'SW-04-ok', '--engine', 'agy']);
    await exited(p.hubInBackground(['run', '--exit-when-idle', '--tick-ms', '200'], { NTFY_TOPIC: 'a-long-random-topic-for-tests-1234' }));
    const [a, b] = [p.status(id), p.status('SW-04-ok')];
    assert.equal(a.outside.items.length, 2, JSON.stringify(a.outside));
    assert.equal(b.outside?.items?.length || 0, 0, 'the worker that stayed in its slot wrote nothing outside it');
    const withMoves = [a, b].filter((x) => x.outside?.moves?.length);
    assert.equal(withMoves.length, 1, JSON.stringify([a.outside, b.outside]));
    assert.ok(withMoves[0].outside.moves.includes('main: commit: stray commit from a worker'));
    const other = withMoves[0].id === id ? 'SW-04-ok' : id;
    // (the other was running when the commit was made only if it had started by then)
    if (withMoves[0].outside.others) assert.deepEqual(withMoves[0].outside.others, [other]);
    assert.equal(ntfy.got.filter((m) => m.title === `proj: task ${id} worked outside its slot`).length, 1);
    assert.equal(ntfy.got.filter((m) => m.title === 'proj: task SW-04-ok worked outside its slot').length, 0, JSON.stringify(ntfy.got.map((m) => m.title)));
  } finally {
    await ntfy.close();
    p.cleanup();
  }
});

test("normal work in a slot: cd into a folder and back, Claude Code's folder kept between commands, Git Bash names, agy's Cwd", () => {
  const slot = 'C:\\Users\\User\\proj.slots\\w1';
  const agy = (CommandLine, extra = {}) => JSON.stringify({ step_update: { step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine, ...extra } } } });
  const claude = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command } }] } });
  const codex = (command) => JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command } });
  const aims = (...lines) => outsideSlot(lines.join('\n'), { slot }).map((x) => x.aims);
  assert.deepEqual(aims(claude('cd apps/web && npm test && cd ..')), []);
  assert.deepEqual(aims(agy('cd apps\\web; pnpm test; cd ..\\..')), []);
  assert.deepEqual(aims(codex('"C:\\pwsh.exe" -Command "Set-Location sub; npm test; Set-Location .."')), []);
  assert.deepEqual(aims(claude('cd /c/Users/User/proj.slots/w1/apps && git status')), []);
  assert.deepEqual(aims(claude('cd apps/web'), claude('npm test'), claude('cd ..')), []);
  assert.deepEqual(aims(claude('cd apps'), claude('cd ../..')), ['../..']);
  assert.deepEqual(aims(claude('cd ../proj'), claude('cd apps')), ['../proj'], "Claude Code's Bash goes back to the slot when a command leaves it");
  assert.deepEqual(aims(claude('cd /c/Users/User/proj && git log')), ['/c/Users/User/proj']);
  assert.deepEqual(aims(codex('cmd /c "cd /d C:\\Users\\User\\proj && git log"')), ['C:\\Users\\User\\proj']);
  assert.deepEqual(aims(agy('git commit -am x', { Cwd: 'C:\\Users\\User\\proj' })), ['C:\\Users\\User\\proj']);
  assert.deepEqual(aims(agy('git status', { Cwd: `${slot}\\apps` })), []);
  // A relative name is read from the folder the session says it started in: one that started outside the slot is said
  const init = (cwd) => JSON.stringify({ event: 'init', init: { cwd } });
  const write = (TargetFile) => JSON.stringify({ step_update: { step_type: 'tool', tool_name: 'write_to_file', tool_info: { name: 'write_to_file', parameters: { TargetFile } } } });
  assert.deepEqual(outsideSlot([init(slot), write('.nextlevel-task\\PROGRESS.md'), agy('git status')].join('\n'), { slot }), []);
  assert.deepEqual(
    outsideSlot([init('C:\\Users\\User'), write('.nextlevel-task\\PROGRESS.md'), agy('cd docs; git add .')].join('\n'), { slot }).map((x) => [x.kind, x.what]),
    [
      ['file', '.nextlevel-task\\PROGRESS.md'],
      ['command', 'cd docs; git add .'],
    ],
  );
  assert.deepEqual(outsideSlot([JSON.stringify({ type: 'system', subtype: 'init', cwd: 'C:\\Users\\User' }), claude('cd src && npm test')].join('\n'), { slot }).map((x) => x.aims), ['src']);
});

test("the guard watches the main checkout while a worker runs: a protected file it writes there is set back and held, naming the task's worker", () => {
  const p = makeProject();
  const id = 'SW-02-outsideprot';
  try {
    p.spec(id, fileExists(`${id}.mjs`));
    p.hub(['dispatch', id]);
    p.runUntilIdle();
    assert.equal(p.status(id).state, 'done');
    assert.equal(fs.existsSync(path.join(p.repo, '.claude', 'settings.json')), false, 'set back: the file it made is gone');
    const held = heldRecords(p).filter((x) => x.status === 'held');
    assert.equal(held.length, 1, JSON.stringify(heldRecords(p)));
    assert.deepEqual(held[0].files.map((f) => f.path), ['.claude/settings.json']);
    assert.match(JSON.stringify(held[0]), new RegExp(`task ${id}'s worker`));
    assert.ok(p.status(id).outside.items.some((x) => x.kind === 'file' && x.what.endsWith('settings.json')));
  } finally {
    p.cleanup();
  }
});

test("every worker's prompt names its slot, says to write only there with that folder as given, and to run git and commands there", () => {
  const p = makeProject();
  const calls = path.join(p.tmp, 'calls.jsonl');
  try {
    for (const engine of ['agy', 'codex', 'claude']) {
      p.spec(`SW-03-ok-${engine}`, fileExists('ok.mjs'));
      p.hub(['dispatch', `SW-03-ok-${engine}`, '--engine', engine]);
    }
    p.runUntilIdle([], { extraEnv: { STUB_CALLS: calls } });
    const prompts = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((a) => [a[0], a.find((x) => typeof x === 'string' && x.includes('ROLE: WORKER'))]).filter(([, x]) => x);
    assert.equal(prompts.length, 3);
    for (const [engine, prompt] of prompts) {
      const slot = prompt.match(/ Your slot is (.+?), a checkout of its own and your current folder: write files only inside it \(where a tool asks for a full path, start it with that folder exactly as written here, never typed from memory\), and run git and every command there, never in another folder\./)?.[1];
      assert.ok(slot && real(slot).startsWith(real(`${p.repo}.slots`)), `${engine}: ${prompt}`);
    }
  } finally {
    p.cleanup();
  }
});

test("a held push's Why says why it's held, and the Blockers headline names it as a push", () => {
  const deploy = { kind: 'push', id: 'G1', card: 'H7', status: 'held', target: 'main', deploy: true, files: [] };
  const prot = { kind: 'push', id: 'G2', card: 'H8', status: 'held', target: 'task/N7', deploy: false, files: ['.github/workflows/guard-test.yml'] };
  const both = { ...prot, id: 'G3', card: 'H9', target: 'main', deploy: true };
  assert.equal(pushWhy(deploy), 'a push to a deploy branch may deploy: nothing goes out until you approve it');
  assert.equal(pushWhy(prot), "it changes protected file (.github/workflows/guard-test.yml) you haven't approved: GitHub runs a pushed branch's own workflows, and the agents and your tools load these files outside any sandbox: nothing goes out until you approve it");
  assert.match(pushWhy(both), /^a push to a deploy branch may deploy, and it changes protected file \(\.github\/workflows\/guard-test\.yml\)/);
  const b = { guard: [deploy, prot], active: [], queued: [], review: [], waiting: [], milestones: [], hub: { running: true }, autopilot: { on: false } };
  const whys = ownerNeeds(b).filter((n) => n.kind === 'guard').map((n) => n.why);
  assert.deepEqual(whys, [pushWhy(deploy), pushWhy(prot)]);
  const items = blockersView('', [], [], [deploy, prot]).items.map((x) => x.text);
  assert.deepEqual(items, ['A push to main, a deploy branch, waits for your approval (G1, card H7)', 'A push to task/N7 waits for your approval: it changes .github/workflows/guard-test.yml, protected files (G2, card H8)']);
});

test("git -C is read by its words: quoted git.exe, another command's -C left alone, and a worker's long run of spaces costs nothing", () => {
  const run = (CommandLine) => JSON.stringify({ event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine } } } });
  const aims = (cmd) => outsideSlot(run(cmd), { slot: '/s' }).map((x) => x.aims);
  assert.deepEqual(aims('"/usr/bin/git" -c a=b -C "/elsewhere" status'), ['/elsewhere']);
  assert.deepEqual(aims('grep -C 3 x /etc/hosts; git status'), []);
  assert.deepEqual(aims('git status | grep -C 3 x'), []);
  const slow = Array.from({ length: 200 }, (_, i) => run(`git${' '.repeat(8000)}${i}`)).join('\n');
  const t = Date.now();
  assert.deepEqual(outsideSlot(slow, { slot: '/s' }), []);
  assert.ok(Date.now() - t < 2000, `${Date.now() - t} ms`);
  assert.equal(shorten('x'.repeat(400)).length, 300);
});

test("the orchestrator's window and its autopilot rounds are told the project's folder, and run their commands there", () => {
  const p = makeProject();
  const calls = path.join(p.tmp, 'calls.jsonl');
  try {
    p.nextlevel(['_orch'], { cwd: p.repo, extraEnv: { NEXTLEVEL_ROOT: p.repo, STUB_CALLS: calls } });
    p.spec('SW-04-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'SW-04-ok']);
    p.runUntilIdle();
    p.runUntilIdle(['--autopilot'], { extraEnv: { STUB_CALLS: calls } });
    const prompts = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).flat().filter((x) => typeof x === 'string' && x.startsWith('ROLE: ORCHESTRATOR'));
    for (const kind of ['interactive session', 'autopilot cycle']) {
      const prompt = prompts.find((x) => x.startsWith(`ROLE: ORCHESTRATOR, ${kind}.`));
      assert.ok(prompt, `${kind}: ${prompts.join('\n')}`);
      const folder = (prompt.match(/ Your project is (.+?): run every command and every git command there\. /) || [])[1];
      assert.ok(folder, prompt);
      assert.equal(fs.realpathSync.native(folder), fs.realpathSync.native(p.repo));
    }
  } finally {
    p.cleanup();
  }
});

test("Home's rounds by what started them show every engine's tokens, not Codex's alone (an Argon round's showed as a dash)", () => {
  const app = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const table = app.slice(app.indexOf("'Autopilot rounds, by what started them'"), app.indexOf("'By engine'"));
  assert.ok(table.includes("h('th.num', {}, 'Tokens')"), table);
  assert.ok(table.includes('r.tokens ? Number(r.tokens).toLocaleString()'), table);
  assert.ok(!/codex/i.test(table), table);
});
