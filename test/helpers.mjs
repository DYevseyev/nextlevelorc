// Builds a throwaway project for end-to-end tests: a git repo set up with `nextlevel init`, a bare
// "GitHub" remote, and stub agy/codex/gh/docker/claude/powercfg/npm commands (plus `nextlevel`) first on
// PATH. The tool runs from this repo's bin/nextlevel.mjs, as it would from its install folder. Works on
// Linux, macOS and Windows.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach } from 'node:test';
import { fileURLToPath } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(REPO, 'bin', 'nextlevel.mjs');
const IS_WIN = process.platform === 'win32';

// ---------- a failing test that drove the hub explains itself ----------
// A test's projects are remembered; when the test fails, what the hub logged and what its engines printed (worker.log,
// an autopilot round's log) go with the failure, so a CI run that fails says why. Read when the test's cleanup removes
// the project, or after the test for one it didn't remove. Only under the test runner.
const LOG_TAIL = 6000;
const made = []; // { repo, logs }
function hubLogs(repo) {
  const state = [path.join(repo, '.nextlevel')].find((d) => fs.existsSync(d));
  if (!state) return '';
  const files = (dir, re) => {
    try {
      return fs.readdirSync(dir).filter((f) => re.test(f)).map((f) => path.join(dir, f));
    } catch {
      return [];
    }
  };
  const mtime = (f) => {
    try {
      return fs.statSync(f).mtimeMs;
    } catch {
      return 0;
    }
  };
  const newest = (list, n) => list.map((f) => [f, mtime(f)]).sort((a, b) => a[1] - b[1]).slice(-n).map(([f]) => f);
  const jobs = files(path.join(state, 'jobs'), /./).map((d) => path.join(d, 'worker.log')).filter((f) => fs.existsSync(f));
  const parts = [path.join(state, 'logs', 'hub.log'), ...newest(jobs, 6), ...newest(files(path.join(state, 'logs'), /^orchestrator-.*\.log$/), 3)].map((f) => {
    let text = '';
    try {
      text = fs.readFileSync(f, 'utf8').trimEnd();
    } catch {
      return '';
    }
    const name = path.relative(state, f).split(path.sep).join('/');
    return text ? `--- ${name}${text.length > LOG_TAIL ? ` (its last ${LOG_TAIL} characters)` : ''}:\n${text.slice(-LOG_TAIL)}` : '';
  });
  const text = parts.filter(Boolean).join('\n');
  return text ? `What the hub of ${path.basename(repo)} logged, and what its engines printed:\n${text}` : '';
}
if (process.env.NODE_TEST_CONTEXT) {
  afterEach((t) => {
    const projects = made.splice(0);
    if (t.passed) return;
    for (const p of projects) {
      const text = p.logs ?? hubLogs(p.repo);
      if (text) t.diagnostic(text);
    }
  });
}

// A copy of `base` with `extra` applied: a value of undefined or null removes the variable. Windows
// treats variable names case-insensitively (process.env has "Path", not "PATH"), so removal does too.
export function withEnv(base, extra = {}) {
  const env = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    for (const k of Object.keys(env)) if (IS_WIN ? k.toUpperCase() === key.toUpperCase() : k === key) delete env[k];
    if (value !== undefined && value !== null) env[key] = value;
  }
  return env;
}

// The folders a test's PATH has besides the stubs (FR-010): Node's, Git's, the system's (and PowerShell's for the
// installer's tests), never the PC's own PATH, where the owner's real agy, codex or claude are (the tests once ran the
// real agy from %LOCALAPPDATA%\agy\bin). Under the test runner nextlevel starts no other CLI (lib/proc.mjs tripWire).
function whereAll(cmd) {
  const r = IS_WIN ? spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true }) : spawnSync('sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : [];
}
const whereIs = (cmd) => (whereAll(cmd)[0] ? path.dirname(whereAll(cmd)[0]) : null);
// Git for Windows: its cmd\git.exe sets up the sh that runs hooks; mingw64\bin\git.exe (first on Git Bash's PATH)
// doesn't, so then sh's folder comes too, after the system's (its find and sort must not hide Windows' own)
const gitCmd = IS_WIN ? whereAll('git').find((f) => /[\\/]cmd[\\/]git\.exe$/i.test(f)) : null;
const SYSTEM_ROOT = process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\Windows';
// A folder with a nextlevel command in it never comes either: the one installed on the PC (~/.nextlevel/bin, where
// the START.cmd test found it) or an old `npm link`. The tests run this checkout's, as the stub folder's `nextlevel`.
const LAUNCHERS = ['nextlevel', 'nextlevel.cmd', 'nextlevel.ps1', 'nextlevel.bat', 'nextlevel.exe'];
export const hasNextlevel = (dir) => LAUNCHERS.some((f) => fs.existsSync(path.join(dir, f)));
// Node's own folder holds one when npm's global commands go there: then Node comes from a folder of its own
// (a hard link to it, else a copy), kept for the next run.
function nodeDir() {
  const dir = path.dirname(process.execPath);
  if (!hasNextlevel(dir)) return dir;
  const own = path.join(os.tmpdir(), `nextlevel-test-node-${process.version}`);
  const exe = path.join(own, path.basename(process.execPath));
  if (!fs.existsSync(exe)) {
    fs.mkdirSync(own, { recursive: true });
    try {
      fs.linkSync(process.execPath, exe);
    } catch {
      fs.copyFileSync(process.execPath, exe);
    }
  }
  return own;
}
export const TEST_PATH_DIRS = [
  ...new Set(
    [
      nodeDir(),
      gitCmd ? path.dirname(gitCmd) : whereIs('git'),
      ...(IS_WIN
        ? [path.join(SYSTEM_ROOT, 'System32'), SYSTEM_ROOT, path.join(SYSTEM_ROOT, 'System32', 'Wbem'), path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0'), gitCmd ? null : whereIs('sh')]
        : [whereIs('pwsh'), '/usr/local/bin', '/usr/bin', '/bin']),
    ].filter((d) => d && !hasNextlevel(d)),
  ),
];

function writeStub(bin, name, script) {
  if (IS_WIN) {
    fs.writeFileSync(path.join(bin, `${name}.cmd`), `@"${process.execPath}" "${script}" %*\r\n`);
  } else {
    const f = path.join(bin, name);
    fs.writeFileSync(f, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
    fs.chmodSync(f, 0o755);
  }
}

// A temp folder with stub CLIs and the environment tests run the tool in (no project yet).
export function makeSandbox() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-'));
  const bin = path.join(tmp, 'bin');
  const home = path.join(tmp, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  writeStub(bin, 'agy', path.join(REPO, 'test', 'stubs', 'fake-agy.mjs'));
  writeStub(bin, 'codex', path.join(REPO, 'test', 'stubs', 'fake-codex.mjs'));
  writeStub(bin, 'gh', path.join(REPO, 'test', 'stubs', 'fake-gh.mjs'));
  // The doctor checks these too: never the real ones (a cold Docker engine alone took 20 s on Windows)
  writeStub(bin, 'docker', path.join(REPO, 'test', 'stubs', 'fake-docker.mjs'));
  writeStub(bin, 'claude', path.join(REPO, 'test', 'stubs', 'fake-claude.mjs'));
  writeStub(bin, 'powercfg', path.join(REPO, 'test', 'stubs', 'fake-powercfg.mjs'));
  writeStub(bin, 'npm', path.join(REPO, 'test', 'stubs', 'fake-npm.mjs'));
  writeStub(bin, 'nextlevel', BIN);
  // Makes the tests deterministic: git's own housekeeping never outlives a git command here. Git runs `maintenance run
  // --auto` detached after commands that write; once a clone crosses its thresholds (git 2.55's geometric repack), a
  // repack went on writing into a tool folder install.test.mjs had just deleted (EEXIST, 15 of 20 runs in Docker on
  // FR-019's branch, 0 of 20 on main: KNOWN_ISSUES, "git"). Temporary: safe updates will turn git's automatic
  // maintenance off for the tool's clone in install and update, and then this setting goes.
  fs.writeFileSync(path.join(home, '.gitconfig'), '[maintenance]\n\tauto = false\n\tautoDetach = false\n[gc]\n\tauto = 0\n\tautoDetach = false\n');
  // The owner is signed in to gh (the stub's stored login), as on a set-up PC
  fs.mkdirSync(path.join(home, '.config', 'gh'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'gh', 'hosts.yml'), 'github.com:\n    oauth_token: stub-owner-token\n');

  // The owner's own folders never reach a test: its PATH, home and application data are temporary folders (FR-010)
  const appData = path.join(home, 'AppData', 'Roaming');
  const localAppData = path.join(home, 'AppData', 'Local');
  fs.mkdirSync(appData, { recursive: true });
  fs.mkdirSync(localAppData, { recursive: true });
  const env = {
    // NoDefaultCurrentDirectoryInExePath is cleared, whatever the shell that started the tests set: with it, Windows
    // doesn't look in the current folder for a program (cmd.exe wouldn't run START.cmd there), which a PC's shell may
    // set and GitHub's runner doesn't. Cleared, the tests find programs the same way here and in CI.
    ...withEnv(process.env, { GH_TOKEN: undefined, GITHUB_TOKEN: undefined, GIT_CONFIG_PARAMETERS: undefined, PATH: undefined, NoDefaultCurrentDirectoryInExePath: undefined }),
    PATH: [bin, ...TEST_PATH_DIRS].join(path.delimiter),
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    LOCALAPPDATA: localAppData,
    NEXTLEVEL_TEST_STUBS: bin, // the trip-wire: nextlevel starts no CLI outside it (lib/proc.mjs)
    NEXTLEVEL_RUN_CACHE: '0', // slow answers aren't kept between runs (the test about that turns it on)
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    NEXTLEVEL_WORKER_WINDOW: '0',
    NEXTLEVEL_NO_UPDATE: '1', // never update this checkout; test/update.test.mjs updates a clone of its own
    NEXTLEVEL_KILL_GRACE_MIN: '0',
    NTFY_TOPIC: '',
  };
  // Run the tool: `nextlevel ...` in `cwd`.
  const nextlevel = (args, { cwd = tmp, timeout = 120_000, extraEnv = {}, input } = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { cwd, env: withEnv(env, extraEnv), encoding: 'utf8', timeout, input });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const gitIn = (cwd, ...a) => {
    const r = spawnSync('git', a, { cwd, env, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr || r.stdout}`);
    return r.stdout.trim();
  };
  // A CLI nextlevel refused to start because it was outside the stub folder fails the test (lib/proc.mjs tripWire)
  const leaks = () => {
    try {
      return fs.readFileSync(path.join(tmp, 'test-leaks.log'), 'utf8');
    } catch {
      return '';
    }
  };
  const cleanup = () => {
    const leaked = leaks();
    // (what a failing test's hub logged is read before its folder goes)
    for (const p of made) if (p.tmp === tmp && p.logs === undefined) p.logs = hubLogs(p.repo);
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // Windows can hold files open for a moment; a leftover temp folder must not fail a test
    }
    if (leaked) throw new Error(`test isolation: nextlevel tried to start a CLI outside the stubs:\n${leaked}`);
  };
  return { tmp, bin, env, nextlevel, gitIn, cleanup, leaks };
}

// A project the way a user gets one: `git init`, `nextlevel init`, first commit, a GitHub remote.
// `before(repo)` runs before `nextlevel init` (e.g. to plant an old .env or state folder). `box`: the
// sandbox of another project, for a second project on the same PC (in folder `dir`).
export function makeProject({ before, box = makeSandbox(), dir = 'proj' } = {}) {
  const { tmp, env, nextlevel } = box;
  const repo = path.join(tmp, dir);
  const remote = path.join(tmp, `${dir}-remote.git`);
  fs.mkdirSync(repo);
  made.push({ tmp, repo, logs: undefined });
  const git = (...a) => box.gitIn(repo, ...a);
  spawnSync('git', ['init', '-q', '--bare', remote], { env });
  git('init', '-q', '-b', 'main');
  before?.(repo);
  const init = nextlevel(['init'], { cwd: repo });
  if (init.code !== 0) throw new Error(`nextlevel init failed:\n${init.out}`);
  git('add', '-A');
  git('commit', '-qm', 'project');
  git('remote', 'add', 'origin', remote);

  const hub = (args, opts = {}) => nextlevel(args, { cwd: repo, ...opts });
  const hubInBackground = (args, extraEnv = {}) =>
    spawn(process.execPath, [BIN, ...args], { cwd: repo, env: withEnv(env, extraEnv), stdio: 'ignore' });
  const runUntilIdle = (extra = [], opts = {}) => hub(['run', '--exit-when-idle', '--tick-ms', '200', ...extra], opts);
  const state = (...p) => path.join(repo, '.nextlevel', ...p);
  const jobFile = (id, name) => state('jobs', id, name);
  const status = (id) => JSON.parse(fs.readFileSync(jobFile(id, 'status.json'), 'utf8'));
  const settings = () => JSON.parse(fs.readFileSync(state('settings.json'), 'utf8'));
  const config = () => JSON.parse(fs.readFileSync(path.join(repo, 'nextlevel.json'), 'utf8'));
  const setConfig = (patch) => fs.writeFileSync(path.join(repo, 'nextlevel.json'), JSON.stringify(patch(config()), null, 2));
  // (resultFile: a "Result file:" line, which design, research and map tasks have, FR-012)
  const spec = (id, verify, { kind = 'code', dir = 'docs/tasks', resultFile = '' } = {}) => {
    fs.mkdirSync(path.join(repo, dir), { recursive: true });
    fs.writeFileSync(
      path.join(repo, dir, `${id}.md`),
      `# ${id} — test\n\nKind: ${kind}\n${resultFile ? `Result file: ${resultFile}\n` : ''}Engine: agy\n\n## Goal\nTest.\n\n## Verify\n\`\`\`sh\n${verify}\n\`\`\`\n`,
    );
  };
  return { ...box, repo, remote, git, hub, hubInBackground, runUntilIdle, state, jobFile, status, settings, config, setConfig, spec };
}

export const fileExists = (f) => `node -e "process.exit(require('fs').existsSync('${f}')?0:1)"`;
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Waiting for what a test expects to happen (a process gone, a line in a log), never for a fixed time: `check` is
// asked every 100 ms, and after `ms` the test fails with what didn't happen. A fixed sleep is slow where the event
// comes quickly and flaky where it comes late (GitHub's Windows runner).
export async function waitUntil(what, check, ms = 60_000) {
  for (const end = Date.now() + ms; !(await check()); await sleep(100)) {
    if (Date.now() > end) throw new Error(`waited ${ms / 1000} s for ${what}`);
  }
}
// That nothing happens (a task stays queued, no round starts) is known once the hub has looked: this waits until a hub
// started with hubInBackground has begun `n` more rounds of its loop. Each round writes its heartbeat to hub.json
// before it looks at the queue, so with n = 2 one whole round ran after the call.
export async function hubRounds(p, n = 2, ms = 60_000) {
  const beat = () => {
    try {
      return JSON.parse(fs.readFileSync(p.state('hub.json'), 'utf8')).heartbeatAt;
    } catch {
      return null; // not written yet (or being replaced, on Windows)
    }
  };
  const first = beat();
  const rounds = new Set();
  await waitUntil(`${n} more rounds of the hub`, () => {
    const b = beat();
    if (b && b !== first) rounds.add(b);
    return rounds.size >= n;
  }, ms);
}
// For a test's cleanup: waits until these processes are gone, so their folder can be removed (up to `ms`; it never
// fails a test, whose own failure matters more)
export async function processesGone(pids, ms = 30_000) {
  for (const end = Date.now() + ms; Date.now() < end && pids.some((pid) => pid && isAlive(pid)); ) await sleep(50);
}

// nextlevel's own repository on "GitHub", for the installer and updates: this checkout's files as they
// are now (committed or not) become commit "nextlevel" on main of a local bare repository, and the
// sandbox's git config sends https://github.com/DYevseyev/nextlevelorc.git there, so the
// code under test uses the real URL and nothing leaves the PC. commit() adds a commit on main, as a merged pull
// request would; release(name, { notes, at }) makes the annotated tag a session makes for a release (safe updates), on
// main's head or on the commit `at`; tag() any other tag (lightweight, moved, off main: what the checks refuse).
// `slug`: another repository on "GitHub" (with a history of its own: where nextlevel is published after a move).
export const TOOL_URL = 'https://github.com/DYevseyev/nextlevelorc.git';
export function fakeGithubTool(box, { slug = null } = {}) {
  const url = slug ? `https://github.com/${slug}.git` : TOOL_URL;
  const name = slug ? slug.replace('/', '-') : 'nextlevelorc';
  const work = path.join(box.tmp, slug ? `tool-dev-${name}` : 'tool-dev');
  const remote = path.join(box.tmp, 'github', `${name}.git`);
  const list = spawnSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], { cwd: REPO, encoding: 'utf8' }).stdout.split('\0').filter(Boolean);
  for (const f of list) {
    const from = path.join(REPO, f);
    if (!fs.existsSync(from) || fs.statSync(from).isDirectory()) continue;
    fs.mkdirSync(path.dirname(path.join(work, f)), { recursive: true });
    fs.copyFileSync(from, path.join(work, f));
  }
  const git = (...a) => box.gitIn(work, ...a);
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git('commit', '-qm', 'nextlevel');
  fs.mkdirSync(path.dirname(remote), { recursive: true });
  box.gitIn(box.tmp, 'clone', '-q', '--bare', work, remote);
  git('remote', 'add', 'origin', remote);
  git('fetch', '-q', 'origin');
  box.gitIn(box.tmp, 'config', '--global', `url.${remote.replace(/\\/g, '/')}.insteadOf`, url);
  // A new version on main: `edit(work)` changes files, then it is committed and "merged"
  const commit = (message, edit = () => {}) => {
    edit(work);
    git('add', '-A');
    git('commit', '-qm', message);
    git('push', '-q', 'origin', 'HEAD:main');
    return git('rev-parse', '--short', 'HEAD');
  };
  // A release: an annotated tag whose message starts "nextlevel <name>", then the notes (Fixes:, New:, After install:)
  const release = (name, { notes = 'Fixes:\n- A test release.', at = 'HEAD' } = {}) => {
    const file = path.join(box.tmp, `tag-${name}.txt`);
    fs.writeFileSync(file, `nextlevel ${name}\n\n${notes}\n`);
    git('tag', '-a', '-F', file, name, at);
    git('push', '-q', 'origin', `refs/tags/${name}`);
    return git('rev-parse', `${name}^{commit}`);
  };
  // Any tag, as GitHub may hold one: a lightweight one, one moved (force), one deleted
  const tag = (name, { at = 'HEAD', message = null, force = false } = {}) => {
    if (message !== null) {
      const file = path.join(box.tmp, `tag-${name}-${Date.now()}.txt`);
      fs.writeFileSync(file, message);
      git('tag', ...(force ? ['-f'] : []), '-a', '-F', file, name, at);
    } else git('tag', ...(force ? ['-f'] : []), name, at);
    git('push', '-q', ...(force ? ['--force'] : []), 'origin', `refs/tags/${name}`);
  };
  const untag = (name) => {
    git('tag', '-d', name);
    git('push', '-q', 'origin', `:refs/tags/${name}`);
  };
  const edit = (file, from, to) => {
    const f = path.join(work, file);
    const text = fs.readFileSync(f, 'utf8');
    if (!(from instanceof RegExp ? from.test(text) : text.includes(from))) throw new Error(`${file} has no "${from}"`);
    fs.writeFileSync(f, text.replace(from, to));
  };
  return { url, work, remote, git, commit, release, tag, untag, edit };
}

// The project p with nextlevel installed as a clone of the fake GitHub repository in the fake home, the way
// the installer leaves it. nl(args): run the installed tool, with its start-up update check (unlike the
// other tests) and `input` on stdin.
export function installedTool({ branch } = {}) {
  const p = makeProject();
  const gh = fakeGithubTool(p);
  const tool = path.join(p.env.HOME, '.nextlevel', 'tool');
  if (branch) {
    gh.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    p.gitIn(p.tmp, 'clone', '-q', '-b', branch, TOOL_URL, tool);
  } else p.gitIn(p.tmp, 'clone', '-q', TOOL_URL, tool);
  const git = (...a) => p.gitIn(tool, ...a);
  const nl = (args, { cwd = p.repo, input = '0\n', env = {}, timeout = 120_000 } = {}) => {
    const r = spawnSync(process.execPath, [path.join(tool, 'bin', 'nextlevel.mjs'), ...args], {
      cwd,
      input,
      encoding: 'utf8',
      timeout,
      env: withEnv(p.env, { NEXTLEVEL_NO_UPDATE: undefined, ...env }),
    });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const head = () => git('rev-parse', '--short', 'HEAD');
  const remoteMain = () => gh.git('rev-parse', '--short', 'origin/main');
  return { p, gh, tool, git, nl, head, remoteMain };
}

// Whether a process started the way nextlevel starts a worker (FR-013: CREATE_NO_WINDOW, which Node gives a child that
// inherits no handle) has a console whose input (CONIN$) it can give a program, as agy needs. Asked of Windows
// directly, not through nextlevel, once per test process. Tests of the console with no window expect it where this
// says yes, and nextlevel's fallback to a window where it says no. (NEXTLEVEL_CONIN, as nextlevel's own:
// `NEXTLEVEL_CONIN=<a file that isn't there> npm test` plays a PC where it doesn't work.)
let consoleAnswer;
export function consoleWorksHere() {
  if (process.platform !== 'win32') return false;
  if (consoleAnswer !== undefined) return consoleAnswer;
  const ask = `
    const fs = require('node:fs'), tty = require('node:tty');
    try { const fd = fs.openSync(process.env.NEXTLEVEL_CONIN || '\\\\\\\\.\\\\CONIN$', 'r+'); process.stdout.write(tty.isatty(fd) ? 'yes' : 'no'); } catch { process.stdout.write('no'); }`;
  const r = spawnSync(process.execPath, ['-e', ask], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
  consoleAnswer = r.stdout === 'yes';
  return consoleAnswer;
}

// The test's clock (lib/clock.mjs, NEXTLEVEL_TEST_CLOCK): { set(iso|ms), add(minutes), addSeconds(s), env }. The time
// stands where the test puts it, so an hour, or an Undo's 10 seconds, passes without waiting for it.
export function testClock(p, at) {
  const file = path.join(p.tmp, 'clock.json');
  const clock = {
    file,
    now: 0,
    env: { NEXTLEVEL_TEST_CLOCK: file },
    set(t) {
      clock.now = typeof t === 'number' ? t : Date.parse(t);
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: new Date(clock.now).toISOString() }));
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, file);
          return;
        } catch (err) {
          if (i > 50) throw err; // (Windows: the hub may be reading it)
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    },
    add: (min) => clock.set(clock.now + min * 60_000),
    addSeconds: (sec) => clock.set(clock.now + sec * 1000),
  };
  clock.set(at);
  return clock;
}
