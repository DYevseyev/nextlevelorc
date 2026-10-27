// Unit tests for small shared pieces: phone-safe text (FR-004 #5), port blocks (FR-004 #7), and what keeps the PC
// quiet and the tests apart from it (FR-010): hidden processes, the console with no window, a worker's log, slow
// answers kept, and the test runner's trip-wire.
//   npm test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CONSOLE_INPUT, CONSOLE_MEMORY_MS, consoleBroken, consoleProblem, forgetConsoleFailure, openConsoleInput, rememberConsoleFailure, runInConsole } from '../src/lib/console.mjs';
import { loadConfig } from '../src/lib/config.mjs';
import { githubFileUrl, phoneText } from '../src/lib/phone.mjs';
import { MAX_BLOCKS, portBlock, portBlocks, projectKey, slotOffset } from '../src/lib/ports.mjs';
import { cacheKey, shimLaunch, tripWire, windowTitle } from '../src/lib/proc.mjs';
import { LIST_WAIT_MS, listProcesses, listWaitMs, parseCim, parsePs, processTree, stopProcesses } from '../src/lib/proctree.mjs';
import { logWriter, plainText } from '../src/lib/workerlog.mjs';
import { BIN, consoleWorksHere, hasNextlevel, isAlive, makeProject, makeSandbox, sleep, withEnv } from './helpers.mjs';
import { spawnSites } from './spawn-sites.mjs';

const IS_WIN = process.platform === 'win32';

test('no flashes (FR-010): every process nextlevel starts says windowsHide, and only a run in the owner\'s own window has it off', () => {
  const sites = spawnSites();
  assert.ok(sites.length > 25, `found ${sites.length} call sites: the scan must see them`);
  const missing = sites.filter((s) => !/\bwindowsHide\b/.test(s.args)).map((s) => `${s.file}:${s.line} ${s.name}(${s.args.replace(/\s+/g, ' ').slice(0, 100)})`);
  assert.deepEqual(missing, [], 'a background process without windowsHide gets a window on Windows (Windows Terminal takes the focus)');
  const shown = sites.filter((s) => /windowsHide:\s*false/.test(s.args) && !/stdio:\s*'inherit'/.test(s.args)).map((s) => `${s.file}:${s.line}`);
  assert.deepEqual(shown, [], "windowsHide: false only for a program in the owner's own window (stdio: 'inherit')");
  // No `cmd start` for background work: only openWindow (windows the owner asked for) and openUrl (the browser) use it
  const starts = [];
  for (const dir of ['src', 'bin']) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
    for (const f of walk(path.join(BIN, '..', '..', dir)).filter((x) => /\.m?js$/.test(x))) {
      fs.readFileSync(f, 'utf8').split('\n').forEach((l, i) => /`start "|'start "|"start "/.test(l) && !/^\s*\/\//.test(l) && starts.push(`${path.basename(f)}:${i + 1}`));
    }
  }
  assert.deepEqual(starts.map((s) => s.split(':')[0]).sort(), ['proc.mjs', 'proc.mjs'], starts.join(', ')); // (openWindow and openUrl)
});

test("a window's title never lets cmd.exe run anything: the project's name comes from a repository's nextlevel.json", () => {
  assert.equal(windowTitle('acme worker w1 - M0-17-load-probe'), 'acme worker w1 - M0-17-load-probe');
  assert.equal(windowTitle('x" & calc & "'), 'x  calc  ');
  assert.equal(windowTitle('%GH_TOKEN% ^|<>'), 'GH_TOKEN ');
  assert.equal(windowTitle('Проект é'), 'Проект é', 'letters of any language stay');
  assert.equal(windowTitle('"&"'), 'nextlevel');
});

test("the console with no window (FR-013): Windows' CREATE_NO_WINDOW and the console's input, never conhost.exe started by nextlevel", () => {
  assert.equal(consoleProblem('linux'), 'a console with no window is for Windows');
  assert.equal(consoleProblem('win32'), '');
  assert.equal(CONSOLE_INPUT({}), '\\\\.\\CONIN$');
  assert.equal(CONSOLE_INPUT({ NEXTLEVEL_CONIN: 'C:\\nope' }), 'C:\\nope', 'the tests play a PC without one');
  const none = openConsoleInput({ NEXTLEVEL_CONIN: path.join(os.tmpdir(), 'nextlevel-no-console-here') });
  assert.ok(none.error && none.fd === undefined, JSON.stringify(none));
  if (IS_WIN) assert.equal(none.error, 'this process has no console to give it (ENOENT)');
  // An antivirus judged a hidden console started by launching conhost.exe directly, with an agent in it, malicious
  // (FR-013): no source file starts conhost.exe, or passes the arguments that started it headless
  const src = path.join(path.dirname(BIN), '..', 'src');
  const code = (text) => text.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  // (the security scanner's own --headless flag, an argument inside its Linux container, is no conhost's)
  const HEADLESS_OK = new Set([path.join('lib', 'securityspec.mjs')]);
  const hits = fs.readdirSync(src, { recursive: true }).filter((n) => {
    if (!n.endsWith('.mjs')) return false;
    const c = code(fs.readFileSync(path.join(src, n), 'utf8'));
    return /conhost(\.exe)?['"`]|conhostPath/i.test(c) || (/['"`]--headless['"`]/i.test(c) && !HEADLESS_OK.has(n));
  });
  assert.deepEqual(hits, []);
});

test('a console with no window that didn\'t start is remembered for this PC for a day, then tried again (FR-010)', () => {
  const box = makeSandbox();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  Object.assign(process.env, { HOME: box.env.HOME, USERPROFILE: box.env.USERPROFILE || box.env.HOME });
  try {
    assert.equal(consoleBroken(), null);
    const at = new Date('2026-09-27T10:00:00Z');
    rememberConsoleFailure('the console host ended before the worker started (exit 0)', at);
    const m = consoleBroken(at.getTime() + 60_000);
    assert.deepEqual(m, { why: 'the console host ended before the worker started (exit 0)', at: at.toISOString() });
    assert.ok(fs.existsSync(path.join(os.homedir(), '.nextlevel', 'console.json')), "kept in the user's nextlevel folder: it is about this PC");
    assert.ok(consoleBroken(at.getTime() + CONSOLE_MEMORY_MS - 1000), 'still within the day');
    assert.equal(consoleBroken(at.getTime() + CONSOLE_MEMORY_MS + 1000), null, 'after a day it is tried again');
    forgetConsoleFailure();
    assert.equal(consoleBroken(at.getTime()), null);
  } finally {
    for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
    else process.env[k] = v;
    box.cleanup();
  }
});

test(
  'on Windows a program run in the console with no window gets a real console for its stdin, and its output back through pipes (FR-010)',
  { skip: !IS_WIN && 'Windows only' },
  () => {
    const box = makeSandbox();
    try {
      const probe = path.join(box.tmp, 'probe.mjs');
      fs.writeFileSync(probe, "import tty from 'node:tty';\nconsole.log(`stdin ${tty.isatty(0) ? 'console' : 'no console'}, stdout ${tty.isatty(1) ? 'console' : 'pipe'}`);\nconsole.log('{\"a\":\"' + 'x'.repeat(5000) + '\"}');\nprocess.exit(3);\n");
      fs.writeFileSync(path.join(box.bin, 'probe.cmd'), `@"${process.execPath}" "${probe}" %*\r\n`);
      // (the home is the sandbox's: a console that doesn't start is remembered there)
      const prev = { PATH: process.env.PATH, NEXTLEVEL_TEST_STUBS: process.env.NEXTLEVEL_TEST_STUBS, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
      Object.assign(process.env, { PATH: box.env.PATH, NEXTLEVEL_TEST_STUBS: box.bin, HOME: box.env.HOME, USERPROFILE: box.env.USERPROFILE || box.env.HOME });
      let r;
      const t0 = Date.now();
      try {
        r = runInConsole('probe', [], { cwd: box.tmp, timeoutMs: 30_000 });
        if (!consoleWorksHere()) {
          // A PC where a process started with no window has no console to give (the next test plays one): said at
          // once, and remembered
          assert.deepEqual([r.ok, r.noConsole, r.timedOut], [false, true, undefined], JSON.stringify(r));
          assert.match(r.out, /^the console with no window didn't start here: /);
          assert.ok(Date.now() - t0 < 15_000, 'not after the time a program gets');
          return;
        }
      } finally {
        for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      assert.equal(r.code, 3, r.out);
      assert.equal(r.ok, false);
      const [first, second] = r.out.split(/\r?\n/);
      assert.equal(first, 'stdin console, stdout pipe');
      assert.equal(second, `{"a":"${'x'.repeat(5000)}"}`, "a long line comes back whole: through a pipe, not the console's screen");
    } finally {
      box.cleanup();
    }
  },
);

test(
  "on a PC where the console with no window has no input to give (played with NEXTLEVEL_CONIN), a check's run says so at once, the program never runs, and the PC remembers it (FR-010, FR-013)",
  { skip: !IS_WIN && 'Windows only' },
  () => {
    const box = makeSandbox();
    try {
      const marker = path.join(box.tmp, 'ran.txt');
      const probe = path.join(box.tmp, 'probe.mjs');
      fs.writeFileSync(probe, `import fs from 'node:fs';\nfs.writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
      fs.writeFileSync(path.join(box.bin, 'probe.cmd'), `@"${process.execPath}" "${probe}" %*\r\n`);
      const prev = { PATH: process.env.PATH, NEXTLEVEL_TEST_STUBS: process.env.NEXTLEVEL_TEST_STUBS, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NEXTLEVEL_CONIN: process.env.NEXTLEVEL_CONIN };
      Object.assign(process.env, { PATH: box.env.PATH, NEXTLEVEL_TEST_STUBS: box.bin, HOME: box.env.HOME, USERPROFILE: box.env.USERPROFILE || box.env.HOME, NEXTLEVEL_CONIN: path.join(box.tmp, 'no-console-here') });
      try {
        const t0 = Date.now();
        const r = runInConsole('probe', [], { cwd: box.tmp, timeoutMs: 30_000 });
        assert.deepEqual([r.ok, r.noConsole, r.timedOut], [false, true, undefined], JSON.stringify(r));
        assert.equal(r.out, "the console with no window didn't start here: this process has no console to give it (ENOENT)");
        assert.ok(Date.now() - t0 < 15_000, 'not after the time a program gets');
        assert.ok(!fs.existsSync(marker), 'a program that needs a console never runs without one');
        assert.equal(consoleBroken()?.why, 'this process has no console to give it (ENOENT)');
        assert.match(runInConsole('probe', []).out, /^the console with no window doesn't start on this PC \(this process has no console/);
      } finally {
        for (const [k, v] of Object.entries(prev)) if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    } finally {
      box.cleanup();
    }
  },
);

test("the hub's files in a slot (FR-013): written in the slot, never through a link a task's commit made", async () => {
  const { writeSlotFile } = await import('../src/lib/slotfiles.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-slotfile-'));
  try {
    const slot = path.join(dir, 'w1');
    const elsewhere = path.join(dir, 'elsewhere');
    fs.mkdirSync(slot);
    fs.mkdirSync(elsewhere);
    const parts = ['.agents', 'agents', 'nextlevel-worker.md'];
    assert.equal(writeSlotFile(slot, parts, 'agent'), true);
    assert.equal(fs.readFileSync(path.join(slot, ...parts), 'utf8'), 'agent');
    assert.equal(writeSlotFile(slot, parts, 'again'), true, 'written again at every start');
    // A folder on the way that is a link (a junction on Windows, which needs no rights): nothing is written there
    fs.rmSync(path.join(slot, '.agents'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(slot, '.agents'), 'junction');
    assert.equal(writeSlotFile(slot, parts, 'agent'), false);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing made or written outside the slot');
    // The file itself a link, or a file where a folder should be
    fs.rmSync(path.join(slot, '.agents'));
    fs.mkdirSync(path.join(slot, '.agents', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(elsewhere, 'target.md'), 'theirs');
    try {
      fs.symlinkSync(path.join(elsewhere, 'target.md'), path.join(slot, ...parts), 'file');
      assert.equal(writeSlotFile(slot, parts, 'agent'), false);
      assert.equal(fs.readFileSync(path.join(elsewhere, 'target.md'), 'utf8'), 'theirs');
    } catch (err) {
      if (err.code !== 'EPERM') throw err; // (a file symlink needs Developer Mode or rights on Windows)
    }
    fs.rmSync(path.join(slot, '.agents'), { recursive: true, force: true });
    fs.writeFileSync(path.join(slot, '.agents'), 'a file');
    assert.equal(writeSlotFile(slot, parts, 'agent'), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a worker's log (FR-010): plain text, window titles dropped whole, secrets redacted, lines joined across chunks", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-log-'));
  try {
    // A window title can hold a command line with a key in it (agy's MCP servers put theirs there)
    assert.equal(plainText('\x1b[?25l\x1b[2J\x1b[m\x1b[H\x1b]0;npm exec mcp-remote --header X-Api-Key: SECRET123\x07ok\x1b[32m done\x1b[0m\r\n'), 'ok done\n');
    assert.equal(plainText('spinner\rline\r\n'), 'spinnerline\n');
    const file = path.join(dir, 'worker.log');
    const shown = [];
    const w = logWriter(file, { redact: (s) => s.replaceAll('hunter2', '***'), echo: (l) => shown.push(l), show: (l) => (l.startsWith('{') ? `[json] ${l.length}` : l) });
    w.line('header');
    w.feed('out', '{"a":1');
    w.feed('err', 'error: hunter2 was refused\n');
    w.feed('out', '}\npartial');
    w.end();
    assert.equal(fs.readFileSync(file, 'utf8'), 'header\nerror: *** was refused\n{"a":1}\npartial\n');
    assert.deepEqual(shown, ['header', 'error: *** was refused', '[json] 7', 'partial']);
    assert.equal(w.lastLine(), 'partial', "the program's last line, not nextlevel's own");
    // A line that never ends isn't kept whole in memory: it is written in parts of a megabyte
    const long = logWriter(path.join(dir, 'long.log'));
    long.feed('out', 'x'.repeat(2.5 * 1024 * 1024));
    assert.equal(fs.readFileSync(path.join(dir, 'long.log'), 'utf8').split('\n').filter(Boolean).map((l) => l.length).join(','), `${1024 * 1024},${1024 * 1024}`);
    long.end();
    assert.equal(fs.statSync(path.join(dir, 'long.log')).size, 2.5 * 1024 * 1024 + 3, 'all of it, in three lines');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('workers.window (FR-010): hidden by default; minimized or visible; NEXTLEVEL_WORKER_WINDOW=0 is hidden', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-cfg-'));
  try {
    assert.equal(loadConfig(root, { file: null, env: {} }).config.workers.window, 'hidden');
    assert.equal(loadConfig(root, { raw: { workers: { window: 'minimized' } }, env: {} }).config.workers.window, 'minimized');
    assert.throws(() => loadConfig(root, { raw: { workers: { window: 'tiny' } }, env: {} }), /"workers\.window" must be hidden, minimized or visible, not "tiny"/);
    assert.equal(loadConfig(root, { raw: { workers: { window: 'visible' } }, env: { NEXTLEVEL_WORKER_WINDOW: '0' } }).config.workers.window, 'hidden', 'the old switch for the background');
    assert.equal(loadConfig(root, { file: null, env: { NEXTLEVEL_WORKER_WINDOW: 'visible' } }).config.workers.window, 'visible');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('slow answers are kept a few minutes: a yes is reused, a no and a fresh run ask again (FR-010)', () => {
  const p = makeProject();
  try {
    const env = { NEXTLEVEL_RUN_CACHE: undefined };
    const calls = () => (fs.existsSync(path.join(p.env.HOME, '.fake-claude', 'status.log')) ? fs.readFileSync(path.join(p.env.HOME, '.fake-claude', 'status.log'), 'utf8').split('\n').filter(Boolean).length : 0);
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { engine: 'claude', model: '' } } }));
    const doctor = (extra = [], more = {}) => JSON.parse(p.hub(['doctor', '--json', ...extra], { extraEnv: { ...env, STUB_CLAUDE_STATUS_LOG: '1', ...more } }).out).results.find((r) => r.id === 'claude.login');
    assert.equal(doctor().status, 'ok');
    assert.equal(calls(), 1);
    assert.equal(doctor().status, 'ok');
    assert.equal(calls(), 1, 'kept: claude auth status is not run again');
    assert.equal(doctor(['--fresh']).status, 'ok');
    assert.equal(calls(), 2, 'Check again (--fresh) asks again');
    assert.equal(doctor(['--fresh'], { STUB_CLAUDE_SIGNED_OUT: '1' }).status, 'fail');
    assert.equal(doctor([], { STUB_CLAUDE_SIGNED_OUT: '1' }).status, 'fail', 'a no is not kept: asked again');
    assert.equal(calls(), 4);
    assert.equal(doctor().status, 'ok');
    assert.equal(calls(), 5, 'the yes kept before the no is gone: asked again');
    assert.ok(fs.existsSync(path.join(p.env.HOME, '.nextlevel', 'cache', 'runs.json')));
    // A key per program, arguments and account folder
    assert.notEqual(cacheKey('node', ['-v'], { CODEX_HOME: 'a' }), cacheKey('node', ['-v'], { CODEX_HOME: 'b' }));
    assert.equal(cacheKey('no-such-program-here', []), null, 'nothing kept for a program that isn\'t there');
  } finally {
    p.cleanup();
  }
});

test("the tests' own PATH (FR-010): only the stubs' nextlevel, never the one installed on the PC; programs found the same way here and in CI", () => {
  const box = makeSandbox();
  try {
    const dirs = box.env.PATH.split(path.delimiter);
    assert.equal(dirs[0], box.bin, 'the stubs first');
    const installed = path.join(os.homedir(), '.nextlevel', 'bin');
    assert.ok(!dirs.some((d) => path.resolve(d).toLowerCase() === path.resolve(installed).toLowerCase()), `${installed} is not on the tests' PATH`);
    assert.deepEqual(dirs.slice(1).filter(hasNextlevel), [], 'no folder with another nextlevel command in it');
    // What a shell finds for `nextlevel` there: the stub, and only it
    const found = IS_WIN
      ? spawnSync('where', ['nextlevel'], { env: box.env, encoding: 'utf8', windowsHide: true }).stdout.split(/\r?\n/).filter(Boolean)
      : spawnSync('sh', ['-c', 'command -v nextlevel'], { env: box.env, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);
    // (as real paths: on GitHub's runner the stub folder is C:\Users\RUNNER~1\..., and `where` answers the long name)
    const real = (p) => fs.realpathSync.native(p).toLowerCase();
    assert.deepEqual(found.map((f) => real(path.dirname(f))), found.map(() => real(box.bin)));
    assert.ok(found.length >= 1);
    // NoDefaultCurrentDirectoryInExePath: cleared, whatever the shell that started the tests set
    assert.ok(!Object.keys(box.env).some((k) => k.toLowerCase() === 'nodefaultcurrentdirectoryinexepath'));
  } finally {
    box.cleanup();
  }
});

test("the test runner's trip-wire (FR-010): no CLI outside the stub folder starts, and the test's cleanup fails on one", () => {
  const box = makeSandbox();
  try {
    const stubs = { NEXTLEVEL_TEST_STUBS: box.bin };
    assert.doesNotThrow(() => tripWire('agy', path.join(box.bin, 'agy.cmd'), stubs));
    // The stub folder spelled another way (GitHub's Windows runner: TEMP is C:\Users\RUNNER~1\..., `where` answers
    // C:\Users\runneradmin\...): a junction (a symlink elsewhere) names the same folder twice
    const alias = path.join(box.tmp, 'alias');
    fs.symlinkSync(box.bin, alias, IS_WIN ? 'junction' : 'dir');
    const stub = fs.readdirSync(box.bin).find((n) => /^agy(\.cmd)?$/.test(n));
    assert.doesNotThrow(() => tripWire('agy', path.join(box.bin, stub), { NEXTLEVEL_TEST_STUBS: alias }), 'the folder by another name');
    assert.doesNotThrow(() => tripWire('agy', path.join(alias, stub), stubs), 'the file by another name');
    assert.throws(() => tripWire('agy', path.join(box.tmp, 'agy.cmd'), { NEXTLEVEL_TEST_STUBS: alias }), /outside the stub folder/, 'next to it is still outside');
    fs.rmSync(path.join(box.tmp, 'test-leaks.log'));
    assert.doesNotThrow(() => tripWire('git', IS_WIN ? 'C:\\Program Files\\Git\\cmd\\git.exe' : '/usr/bin/git', stubs), "the system's tools");
    const real = IS_WIN ? 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe' : '/home/me/.local/bin/agy';
    assert.throws(() => tripWire('agy', real, stubs), /test isolation: nextlevel refused to start .*agy.* outside the stub folder/);
    assert.throws(() => tripWire('codex', real, { NODE_TEST_CONTEXT: 'child-v8' }), /NEXTLEVEL_TEST_STUBS is not set/, 'under the test runner without stubs: nothing but the system');
    assert.doesNotThrow(() => tripWire('agy', real, {}), 'outside the tests: anything');
    assert.match(box.leaks(), /refused to start/, 'written down for the test');
    fs.rmSync(path.join(box.tmp, 'test-leaks.log'));
    // End to end: a real-looking agy on PATH, the stub gone: nextlevel refuses it, and cleanup fails the test
    const other = path.join(box.tmp, 'elsewhere');
    fs.mkdirSync(other);
    fs.copyFileSync(path.join(box.bin, IS_WIN ? 'agy.cmd' : 'agy'), path.join(other, IS_WIN ? 'agy.cmd' : 'agy'));
    for (const f of fs.readdirSync(box.bin).filter((n) => /^agy(\.cmd)?$/.test(n))) fs.rmSync(path.join(box.bin, f));
    const r = spawnSync(process.execPath, [BIN, 'doctor', '--json'], { cwd: box.tmp, env: withEnv(box.env, { PATH: `${box.env.PATH}${path.delimiter}${other}` }), encoding: 'utf8', timeout: 120_000 });
    const agy = JSON.parse(r.stdout).results.find((x) => x.id === 'tool.agy');
    assert.match(agy.detail, /test isolation: nextlevel refused to start/, JSON.stringify(agy));
    assert.throws(() => box.cleanup(), /test isolation: nextlevel tried to start a CLI outside the stubs/);
  } finally {
    try {
      box.cleanup();
    } catch {
      // the leak was the point
    }
  }
});

test('phoneText: .md file names become links or lose ".md"; links and other words stay', () => {
  const link = (name) => (name === 'docs/HANDOFF.md' || name === 'HANDOFF.md' ? 'https://github.com/o/r/blob/main/docs/HANDOFF.md' : null);
  assert.equal(phoneText('See HANDOFF.md.', { link }), 'See https://github.com/o/r/blob/main/docs/HANDOFF.md.');
  assert.equal(phoneText('(docs/HANDOFF.md) and NOTES.MD, C:\\proj\\README.md'), '(docs/HANDOFF) and NOTES, C:\\proj\\README');
  assert.equal(phoneText('keep https://example.com/a/README.md and README.mdx, notes.md.bak, md, .md'), 'keep https://example.com/a/README.md and README.mdx, notes.md.bak, md, .md');
  assert.equal(phoneText(undefined), '');
  assert.equal(githubFileUrl('o/r', 'feature/x', 'docs/My Notes.md'), 'https://github.com/o/r/blob/feature/x/docs/My%20Notes.md');
});

test('port blocks: one per project, the first keeps 100, 200; a block whose folder is gone is given out again', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-ports-'));
  try {
    const P = (name) => path.join(home, 'projects', name); // a project folder, as this OS writes it
    const live = new Set(['a', 'b', 'c'].map((n) => projectKey(P(n))));
    const exists = (k) => live.has(k);
    const opts = { home, exists };
    assert.equal(portBlock(P('a'), { ...opts, assign: false }), null, 'looking gives nothing out');
    assert.equal(portBlock(P('a'), opts), 0);
    assert.equal(portBlock(P('b'), opts), 1);
    assert.equal(portBlock(P('a'), opts), 0, 'kept');
    assert.deepEqual([slotOffset(0, 1), slotOffset(0, 2), slotOffset(1, 1), slotOffset(1, 6)], [100, 200, 1100, 1600]);
    live.delete(projectKey(P('a')));
    assert.equal(portBlock(P('c'), opts), 0, "a's folder is gone: its block is free again");
    assert.deepEqual(portBlocks(opts).map((x) => [x.root, x.block]).sort(), [[projectKey(P('b')), 1], [projectKey(P('c')), 0]]);
    assert.ok(!fs.existsSync(path.join(home, 'ports.lock')), 'the lock is released');
    assert.equal(projectKey('C:\\Users\\Me\\Proj', 'win32'), 'c:\\users\\me\\proj');
    assert.equal(projectKey('C:/Users/Me/Proj/', 'win32'), 'c:\\users\\me\\proj');
    for (let i = 0; i < MAX_BLOCKS; i++) live.add(projectKey(P(`q${i}`)));
    for (let i = 0; i < MAX_BLOCKS - 2; i++) portBlock(P(`q${i}`), opts);
    assert.throws(() => portBlock(P('last'), opts), /all 40 port blocks .* are taken/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ---------- what a stopped worker left running (FR-013): one snapshot, parent ids and start times ----------
test("a stopped worker's tree in one snapshot of all processes: a parent that is gone hides nothing, and a pid another program has now is never taken (FR-013)", () => {
  const t0 = Date.parse('2026-09-28T10:00:00Z');
  const s = (sec) => t0 + sec * 1000;
  const tree = (list, opts) => processTree(list, { now: s(3600), ...opts }); // (the clock, an hour on)
  // run.json: the worker's process (100) and its engine (200), both gone (Windows took the engine along); the hub saw
  // the worker end at 60 s
  const roots = [
    { pid: 100, at: s(1), until: s(60), what: "its worker's process", id: 'M1-01' },
    { pid: 200, at: s(10), until: s(60), what: 'its engine', id: 'M1-01' },
  ];
  const list = [
    { pid: 300, ppid: 200, start: s(20), name: 'cmd.exe' }, // a tool shell the engine started: taken
    { pid: 301, ppid: 300, start: s(21), name: 'node.exe' }, // what that started: taken
    { pid: 400, ppid: 200, start: s(-50), name: 'old.exe' }, // of an earlier program with pid 200: not taken
    { pid: 600, ppid: 200, start: s(70), name: 'late.exe' }, // of a later one, after the engine was gone: not taken
    { pid: 100, ppid: 7, start: s(90), name: 'reuser.exe' }, // the worker's pid, now another program's: never taken
    { pid: 500, ppid: 100, start: s(95), name: 'its-child.exe' }, // nor what that program started
    { pid: 42, ppid: 1, start: s(0), name: 'node.exe' }, // the hub
    { pid: 700, ppid: 42, start: s(30), name: 'powershell.exe' }, // the hub's own listing
  ];
  const { found, reused } = tree(list, { roots, self: 42 });
  assert.deepEqual(found.map((p) => p.pid).sort(), [300, 301]);
  assert.deepEqual(reused.map((r) => [r.pid, r.what, r.id, r.now.name]), [[100, "its worker's process", 'M1-01', 'reuser.exe']]);
  // An engine that still runs (it started before its recorded time): taken, with what it started
  const running = [{ pid: 200, ppid: 100, start: s(9.5), name: 'agy.exe' }, { pid: 300, ppid: 200, start: s(20), name: 'cmd.exe' }];
  assert.deepEqual(tree(running, { roots }).found.map((p) => p.pid), [200, 300]);
  // A program that got the engine's pid after the engine was gone: never taken, nor what it started; what the engine
  // started before is
  const other = [
    { pid: 200, ppid: 5, start: s(40), name: 'browser.exe' },
    { pid: 201, ppid: 200, start: s(41), name: 'tab.exe' },
    { pid: 300, ppid: 200, start: s(20), name: 'cmd.exe' },
  ];
  const r = tree(other, { roots });
  assert.deepEqual(r.found.map((p) => p.pid), [300]);
  assert.deepEqual(r.reused.map((x) => [x.pid, x.now.name]), [[200, 'browser.exe']]);
  // Nor a process with that pid that started long before the time recorded for it (a record that doesn't fit)
  assert.deepEqual(tree([{ pid: 200, ppid: 5, start: s(-3600), name: 'service.exe' }], { roots: [{ ...roots[1], within: 30_000 }] }).found, []);
  // The hub, and what it runs under, are never taken, whatever their parent
  assert.deepEqual(tree([{ pid: 42, ppid: 200, start: s(30), name: 'node.exe' }], { roots, self: 42 }).found, []);
  // A record with a time still to come fits no process
  assert.deepEqual(processTree(running, { roots, now: s(0.5) }).found.map((p) => p.pid), [], 'at 0.5 s neither recorded time has come');
  // (POSIX) what is left of the worker's process group, orphans that init took over too; not a group whose id another
  // process has now (the worker's group is gone then: its id can't go to another process while it has one)
  const posix = [
    { pid: 300, ppid: 1, pgid: 100, start: s(20), name: 'node' },
    { pid: 301, ppid: 300, pgid: 100, start: s(21), name: 'sh' },
  ];
  assert.deepEqual(tree(posix, { roots, group: 100 }).found.map((p) => p.pid), [300, 301]);
  assert.deepEqual(tree([...posix, { pid: 100, ppid: 1, pgid: 100, start: s(90), name: 'other' }], { roots, group: 100 }).found, []);
});

test("the listing of processes: Windows' CIM lines and ps's, one that is late is stopped and never taken as \"nothing runs\" (FR-013)", async () => {
  assert.deepEqual(parseCim('0|0|2026-09-28T06:32:38.2745070Z|System Idle Process\r\n1234|4|2026-09-28T10:00:00.1234567Z|agy.exe\r\n\r\nnot a line\r\n'), [
    { pid: 1234, ppid: 4, start: Date.parse('2026-09-28T10:00:00.123Z'), name: 'agy.exe' },
  ]);
  // (ps's state: a zombie, Z, has ended and runs nothing, so it isn't in the snapshot)
  assert.deepEqual(parsePs('   77     1    77 Ssl  Mon Sep 28 18:13:20 2026 node\n   78    77    77 S+   Tue Sep  1 08:00:05 2026 sh\n   79    77    77 Z    Tue Sep  1 08:00:06 2026 sleep\n'), [
    { pid: 77, ppid: 1, pgid: 77, start: Date.parse('Mon Sep 28 18:13:20 2026'), name: 'node' },
    { pid: 78, ppid: 77, pgid: 77, start: Date.parse('Tue Sep  1 08:00:05 2026'), name: 'sh' },
  ]);
  assert.equal(listWaitMs({}), LIST_WAIT_MS);
  assert.equal(listWaitMs({ NEXTLEVEL_PROCESS_LIST_MS: '0' }), 0);
  // One that doesn't answer in time is stopped, and says it was late
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-list-'));
  try {
    const pidFile = path.join(dir, 'pid');
    const hangs = [process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`]];
    const started = Date.now();
    assert.deepEqual(await listProcesses({ timeoutMs: 3000, command: hangs }), { late: true });
    assert.ok(Date.now() - started < 15_000);
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await sleep(100);
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    for (let i = 0; i < 50 && isAlive(pid); i++) await sleep(100);
    assert.ok(!isAlive(pid), 'the late listing is stopped');
    assert.deepEqual(await listProcesses({ timeoutMs: 0, command: hangs }), { late: true }, 'no time at all: nothing is started');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.deepEqual(await listProcesses({ command: [process.execPath, ['-e', "console.log('7|1|2026-09-28T10:00:00.000Z|x.exe')"]] }), { list: [{ pid: 7, ppid: 1, start: Date.parse('2026-09-28T10:00:00.000Z'), name: 'x.exe' }] });
  assert.match((await listProcesses({ command: [process.execPath, ['-e', 'process.exit(2)']] })).error, /ended with exit 2/);
  // The real one (PowerShell's CIM on Windows, ps elsewhere): this process, with its parent and a start before now
  const real = await listProcesses({ timeoutMs: 60_000 });
  assert.ok(real.list || real.late, real.error);
  if (real.list) {
    const me = real.list.find((p) => p.pid === process.pid);
    assert.ok(me && me.ppid === process.ppid && me.start <= Date.now() && me.start > Date.now() - 3_600_000, JSON.stringify(me));
  }
});

test('a process is stopped only by its pid and its start time together: a pid another program has is never touched (FR-013)', async () => {
  const one = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  const two = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore', windowsHide: true });
  try {
    const snap = await listProcesses({ timeoutMs: 60_000 });
    assert.ok(snap.list, snap.error || 'the listing was late');
    const [a, b] = [one, two].map((c) => snap.list.find((p) => p.pid === c.pid));
    assert.ok(a && b, 'both are in the snapshot');
    // The same pid with another start: that is another program, as when the pid was given again
    const other = await stopProcesses([{ ...b, start: b.start - 5000 }], { timeoutMs: 60_000 });
    assert.deepEqual([other.other?.map((p) => p.pid), other.stopped], [[b.pid], []], JSON.stringify(other));
    assert.ok(isAlive(b.pid), 'never touched');
    // Its own start: stopped, and said so; a second time it is gone already
    const r = await stopProcesses([a, b], { timeoutMs: 60_000 });
    assert.deepEqual(r.stopped?.map((p) => p.pid).sort(), [a.pid, b.pid].sort(), JSON.stringify(r));
    for (let i = 0; i < 50 && (isAlive(a.pid) || isAlive(b.pid)); i++) await sleep(100);
    assert.deepEqual((await stopProcesses([a], { timeoutMs: 60_000 })).gone?.map((p) => p.pid), [a.pid]);
    assert.deepEqual(await stopProcesses([a], { timeoutMs: 0 }), { late: true }, 'no time at all: nothing is started');
  } finally {
    for (const c of [one, two]) if (isAlive(c.pid)) c.kill();
  }
});

test('a zombie (a process that ended and that its parent has not collected yet) runs nothing: not in the snapshot, and gone when it is to be stopped (FR-013)', { skip: IS_WIN && 'Windows has no zombies' }, async () => {
  // sh starts a short sleep in the background, then becomes node, which never collects that sleep
  const parent = spawn('sh', ['-c', `sleep 0.3 & exec "${process.execPath}" -e "setTimeout(() => {}, 30000)"`], { stdio: 'ignore' });
  try {
    let zombie = null;
    for (let i = 0; i < 50 && !zombie; i++) {
      await sleep(100);
      const raw = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,stat=,lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', LANG: 'C' } }).stdout;
      for (const line of raw.split('\n')) {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.{24})/.exec(line);
        if (m && Number(m[2]) === parent.pid && m[3].startsWith('Z')) zombie = { pid: Number(m[1]), start: Date.parse(m[4]) };
      }
    }
    assert.ok(zombie, 'the test made a zombie');
    const snap = await listProcesses({ timeoutMs: 60_000 });
    assert.ok(snap.list?.some((p) => p.pid === parent.pid), 'its parent is in the snapshot');
    assert.ok(!snap.list.some((p) => p.pid === zombie.pid), 'the zombie is not');
    const r = await stopProcesses([zombie], { timeoutMs: 60_000 });
    assert.deepEqual([r.gone?.map((p) => p.pid), r.left], [[zombie.pid], []], "gone, never \"wouldn't stop\"");
  } finally {
    parent.kill('SIGKILL');
  }
});

test("a .cmd shim's program starts without cmd.exe, so on Windows the engine ends with the worker's process (FR-013); any other shim keeps cmd.exe", () => {
  const npm = 'C:\\Users\\u\\AppData\\Roaming\\npm';
  const all = () => true;
  const cmdShim = (target) =>
    `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*\r\n`;
  // npm's cmd-shim for a script: node beside the shim, else the one on PATH
  const codex = cmdShim('node_modules\\@openai\\codex\\bin\\codex.js');
  const script = `${npm}\\node_modules\\@openai\\codex\\bin\\codex.js`;
  assert.deepEqual(shimLaunch(codex, `${npm}\\codex.cmd`, { exists: all }), { file: `${npm}\\node.exe`, args: [script] });
  assert.deepEqual(shimLaunch(codex, `${npm}\\codex.cmd`, { exists: (f) => f !== `${npm}\\node.exe`, which: () => 'C:\\Program Files\\nodejs\\node.exe' }), { file: 'C:\\Program Files\\nodejs\\node.exe', args: [script] });
  // ... for a program (Claude Code's claude.exe, pnpm.exe), and a plain launcher (the tests' stubs)
  const claude = '@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*\r\n';
  assert.deepEqual(shimLaunch(claude, `${npm}\\claude.cmd`, { exists: all }), { file: `${npm}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, args: [] });
  assert.deepEqual(shimLaunch('@"C:\\nodejs\\node.exe" "C:\\repo\\test\\stubs\\fake-agy.mjs" %*\r\n', 'C:\\t\\bin\\agy.cmd', { exists: all }), { file: 'C:\\nodejs\\node.exe', args: ['C:\\repo\\test\\stubs\\fake-agy.mjs'] });
  // Anything else keeps cmd.exe: another variable (npm's own npm.cmd), a line after the program, two programs (npm's
  // oldest shims), a program that isn't there, a shim that runs another shim, no node to run a script with
  assert.equal(shimLaunch('SET "NODE_EXE=%~dp0\\node.exe"\r\n"%NODE_EXE%" "%NPM_CLI_JS%" %*\r\n', 'C:\\nodejs\\npm.cmd', { exists: all }), null);
  assert.equal(shimLaunch('@"C:\\a.exe" %* | more\r\n', 'C:\\b\\x.cmd', { exists: all }), null);
  assert.equal(shimLaunch('@"C:\\a.exe" & calc %*\r\n', 'C:\\b\\x.cmd', { exists: all }), null);
  assert.equal(shimLaunch('@IF EXIST "%~dp0\\node.exe" (\r\n  "%~dp0\\node.exe" "%~dp0\\x.js" %*\r\n) ELSE (\r\n  node "%~dp0\\x.js" %*\r\n)\r\n', 'C:\\b\\x.cmd', { exists: all }), null);
  assert.equal(shimLaunch('@"C:\\a.exe" %*\r\n', 'C:\\b\\x.cmd', { exists: () => false }), null);
  assert.equal(shimLaunch('@"C:\\b\\other.cmd" %*\r\n', 'C:\\b\\x.cmd', { exists: all }), null);
  assert.equal(shimLaunch(codex, `${npm}\\codex.cmd`, { exists: (f) => f !== `${npm}\\node.exe` }), null);
});
