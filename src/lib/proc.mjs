// Finding and starting the command-line tools nextlevel drives (git, gh, codex, agy, docker, ...).
// Shared by the hub and the setup checks. Read docs/KNOWN_ISSUES.md before changing anything here.
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { binHints } from '../engines/index.mjs';
import { homeDir, jsonStore } from './home.mjs';

export const IS_WIN = process.platform === 'win32';

// ---------- the test runner's trip-wire (FR-010) ----------
// Tests once reached the owner's real agy (%LOCALAPPDATA%\agy\bin is on the user's PATH) and ran it. Under the test
// runner (test/helpers.mjs sets NEXTLEVEL_TEST_STUBS to the stub CLIs' folder; node --test sets NODE_TEST_CONTEXT)
// nextlevel starts no CLI outside that folder but the system's own tools: a leak fails loudly, and is written down
// next to the stub folder (test-leaks.log), where the test's cleanup finds it.
const SYSTEM_TOOLS = new Set(['git', 'node', 'where', 'cmd', 'powershell', 'pwsh', 'taskkill', 'whoami', 'sh', 'bash', 'tasklist']);
export const testStubs = (env = process.env) => (env.NEXTLEVEL_TEST_STUBS ? env.NEXTLEVEL_TEST_STUBS : env.NODE_TEST_CONTEXT ? '' : null);
// The same folder can be spelled two ways: GitHub's Windows runner has TEMP as C:\Users\RUNNER~1\... (an 8.3 short
// name) while `where` answers C:\Users\runneradmin\..., and a link or junction is another spelling. So both are
// compared as the real path (realpath.native gives the long names); for a file that isn't there, its folder's.
const realPath = (p) => {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    return parent === abs ? abs : path.join(realPath(parent), path.basename(abs));
  }
};
function isInside(file, dir) {
  const r = path.relative(realPath(dir), realPath(file));
  return !!r && !r.startsWith('..') && !path.isAbsolute(r);
}
export function tripWire(name, file, env = process.env) {
  const stubs = testStubs(env);
  if (stubs === null) return; // not under the test runner
  if (SYSTEM_TOOLS.has(path.basename(file).replace(/\.(exe|cmd|bat|com)$/i, '').toLowerCase())) return;
  if (stubs && isInside(file, stubs)) return;
  // nextlevel's own command as a test installed it, in the test's own home (safe updates: a version puts its command first
  // on PATH): inside the test's temporary folder, never the PC's
  if (stubs && /^nextlevel(\.cmd)?$/i.test(path.basename(file)) && isInside(file, path.dirname(stubs))) return;
  const message = `test isolation: nextlevel refused to start ${file} ("${name}"): it is outside the stub folder (${stubs || 'NEXTLEVEL_TEST_STUBS is not set'})`;
  try {
    if (stubs) fs.appendFileSync(path.join(path.dirname(stubs), 'test-leaks.log'), `${message}\n`);
  } catch {
    // the error below says it anyway
  }
  throw new Error(message);
}

// Find an executable. On Windows, npm installs .cmd shims that can't be spawned directly, and an engine's
// installer may put it where an older console's PATH doesn't reach (agy: %USERPROFILE%\.local\bin), so
// its adapter's places come first (src/engines/). Under the test runner only the stubs and the system's tools.
export function resolveBin(name) {
  const bin = findBin(name);
  if (bin) tripWire(name, bin.file);
  return bin;
}
function findBin(name) {
  if (IS_WIN) {
    const hit = binHints(name, os.homedir(), process.platform, path).find((f) => fs.existsSync(f));
    if (hit) return { file: hit, shell: false, all: [hit] };
    const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return null;
    const all = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter((s) => /\.(exe|cmd|bat|com)$/i.test(s));
    return all.length ? { file: all[0], shell: /\.(cmd|bat)$/i.test(all[0]), all } : null;
  }
  const r = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8', windowsHide: true });
  const file = (r.stdout || '').trim().split('\n')[0];
  return r.status === 0 && file ? { file, shell: false, all: [file] } : null;
}

// .cmd shims need cmd.exe; our arguments never contain quotes or %, so plain quoting is safe.
const cmdQuote = (a) => (/^[\w\-.:/\\=@,]+$/.test(a) ? a : `"${String(a).replace(/"/g, "'")}"`);
const cmdLine = (bin, args) => ['cmd.exe', ['/d', '/s', '/c', `"${[cmdQuote(bin.file), ...args.map(cmdQuote)].join(' ')}"`]];

// Hidden unless it runs in the owner's own window (stdio 'inherit'): a caller says which (FR-010).
const hidden = (opts) => opts.windowsHide ?? opts.stdio !== 'inherit';
export function spawnBin(bin, args, opts = {}) {
  if (bin.shell) {
    const [file, line] = cmdLine(bin, args);
    return spawn(file, line, { ...opts, windowsHide: hidden(opts), windowsVerbatimArguments: true });
  }
  return spawn(bin.file, args, { ...opts, windowsHide: hidden(opts) });
}

// What a .cmd shim runs, to start that without cmd.exe: { file, args } (args before the caller's), or null for a shim
// that does more than run one program with its arguments (then it runs through cmd.exe, as before). Why: on Windows
// Node puts a child in a job that closes with its parent, and lets the child's own children out of it, so a worker's
// process that is killed takes its engine along only when the engine is its own child, not a cmd.exe in between
// (FR-013; lib/proctree.mjs). The one line that ends with %*: npm's cmd-shim (`"%_prog%"  "%dp0%\...\cli.js" %*`, with
// node.exe beside the shim or else on PATH; `"%dp0%\...\tool.exe" %*`) and a plain launcher (`@"C:\...\node.exe"
// "C:\...\cli.mjs" %*`, the tests' stubs). Only quoted paths, %dp0% (the shim's folder) and %_prog%: anything else
// (another variable, a pipe, a second command) keeps cmd.exe. Pure: `exists` and `which` (a program on PATH) are given.
const NPM_PREFIX = 'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & ';
export function shimLaunch(text, shimFile, { exists = fs.existsSync, which = () => '' } = {}) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter((l) => l.endsWith('%*'));
  if (lines.length !== 1) return null;
  let line = lines[0].slice(0, -2).trim();
  if (line.toLowerCase().startsWith(NPM_PREFIX.toLowerCase())) line = line.slice(NPM_PREFIX.length);
  else if (line.startsWith('@')) line = line.slice(1);
  const tokens = [];
  for (let rest = line.trim(); rest; ) {
    const end = rest.startsWith('"') ? rest.indexOf('"', 1) : -1;
    if (end < 1) return null;
    tokens.push(rest.slice(1, end));
    const after = rest.slice(end + 1);
    if (after && !/^\s/.test(after)) return null;
    rest = after.trim();
  }
  if (!tokens.length) return null;
  const dir = path.win32.dirname(shimFile);
  const own = path.win32.join(dir, 'node.exe');
  const expand = (t) => (t.toLowerCase() === '%_prog%' ? (exists(own) ? own : which('node')) : t.replace(/%~?dp0%?/gi, `${dir}\\`));
  const parts = tokens.map(expand);
  if (parts.some((t) => !t || t.includes('%') || !path.win32.isAbsolute(t))) return null;
  const [file, ...args] = parts.map((t) => path.win32.normalize(t));
  return /\.(exe|com)$/i.test(file) && exists(file) ? { file, args } : null;
}
// A program in a folder on PATH, never in the current one (a worker's process runs in its slot, which the worker writes)
function onPath(name, env = process.env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  for (const dir of String(env[key] || '').split(path.delimiter).filter((d) => path.isAbsolute(d))) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return '';
}
// How to start `bin` with `args` (FR-013): a shim's program directly where shimLaunch finds it, else as spawnBin does
export function spawnDirect(bin, args, opts = {}) {
  const direct = shimProgram(bin, opts.env);
  if (!direct) return spawnBin(bin, args, { ...opts, windowsHide: hidden(opts) });
  tripWire(path.basename(bin.file), direct.file);
  return spawn(direct.file, [...direct.args, ...args], { ...opts, windowsHide: hidden(opts) });
}
const shimProgram = (bin, env) => (IS_WIN && bin.shell ? shimLaunch(readShim(bin.file), bin.file, { which: (n) => onPath(`${n}.exe`, env) }) : null);
function readShim(file) {
  try {
    return fs.statSync(file).size <= 64 * 1024 ? fs.readFileSync(file, 'utf8') : '';
  } catch {
    return '';
  }
}

// Run a tool and collect what it printed. `missing` means it isn't installed (or not on this window's PATH). `direct`: a
// .cmd shim's program starts without cmd.exe, as spawnDirect does, so an argument with quotes reaches it whole (the
// security engineer's docker lines: a Go template, a probe's script).
export function runQuiet(cmd, args, { timeoutMs = 20000, cwd, env = process.env, input, direct = false } = {}) {
  const bin = resolveBin(cmd);
  if (!bin) return { ok: false, missing: true, code: null, out: '' };
  const program = direct ? shimProgram(bin, env) : null;
  if (program) tripWire(path.basename(bin.file), program.file);
  const [file, line] = program ? [program.file, [...program.args, ...args]] : bin.shell ? cmdLine(bin, args) : [bin.file, args];
  const r = spawnSync(file, line, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    windowsVerbatimArguments: bin.shell && !program,
    cwd,
    env,
    input,
  });
  return { ok: r.status === 0, code: r.status, timedOut: r.error?.code === 'ETIMEDOUT', out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
// The same, without holding the process while it runs (the dashboard files a report in its own process, FR-017: its page
// stays live while GitHub answers). What it printed comes in the order it came.
export function runQuietAsync(cmd, args, { timeoutMs = 20000, cwd, env = process.env } = {}) {
  const bin = resolveBin(cmd);
  if (!bin) return Promise.resolve({ ok: false, missing: true, code: null, out: '' });
  const [file, line] = bin.shell ? cmdLine(bin, args) : [bin.file, args];
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    const child = spawn(file, line, { windowsHide: true, windowsVerbatimArguments: bin.shell, cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, timedOut, out: `${out}${err.message}`.trim() });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, timedOut, out: out.trim() });
    });
  });
}

// ---------- slow answers, kept a few minutes (FR-010) ----------
// agy's sign-in and model list (`agy models`, a few seconds over the network) and Codex's and Claude Code's sign-in
// were asked again at every doctor run, and the dashboard runs the doctor whenever its page comes back into view.
// An answer that says yes is kept for `cacheMs` in ~/.nextlevel/cache/runs.json, per program (its file and
// version: a new install asks again), arguments and account folder; one that says no is asked again next time,
// so a sign-in shows at once. `fresh` (the dashboard's Check again, doctor --fresh) asks again and keeps the new
// answer. NEXTLEVEL_RUN_CACHE=0 keeps nothing (the tests, but the one about this).
export const RUN_CACHE_MS = 5 * 60_000;
const runCache = () => jsonStore(path.join(homeDir(), 'cache', 'runs.json'));
export function cacheKey(cmd, args, env = process.env) {
  const bin = findBin(cmd);
  let stamp = '';
  try {
    const st = bin && fs.statSync(bin.file);
    stamp = st ? `${st.size}:${st.mtimeMs}` : '';
  } catch {
    // not there: no answer is kept
  }
  const account = ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'].map((k) => env[k] || '');
  return bin ? createHash('sha256').update(JSON.stringify([cmd, args, bin.file, stamp, account])).digest('hex').slice(0, 32) : null;
}
export function runCached(cmd, args, { cacheMs = RUN_CACHE_MS, fresh = false, ...opts } = {}) {
  if (process.env.NEXTLEVEL_RUN_CACHE === '0') return runQuiet(cmd, args, opts);
  const key = cacheKey(cmd, args, opts.env || process.env);
  const store = runCache();
  const kept = key && !fresh ? store.get(key) : null;
  if (kept?.r?.ok && Date.now() - Date.parse(kept.at) < cacheMs) return { ...kept.r, cached: kept.at };
  const r = runQuiet(cmd, args, opts);
  if (key) {
    try {
      store.set(key, r.ok ? { at: new Date().toISOString(), r } : null);
    } catch {
      // an answer that can't be kept is asked for again next time
    }
  }
  return r;
}

// A window's title as `cmd /c start "<title>"` may get it: letters, digits, spaces and . , ( ) - only. It holds the
// project's name from nextlevel.json, which a cloned repository sets: a quote there would end the title, and cmd
// would run the rest (a rafter finding, FR-010); % would expand a variable.
export const windowTitle = (title) => String(title ?? '').replace(/[^\p{L}\p{N} .,()_-]/gu, '').slice(0, 120) || 'nextlevel';

// Open a new console window on Windows, for a window the owner asked for (the hub, the orchestrator, the setup guide, a
// worker with workers.window minimized or visible, the hub or dashboard the one-click update starts again as it ran); run
// inline elsewhere. `minimized`: `start /min`, which Windows Console Host honours and Windows Terminal ignores (FR-010);
// nextlevel never starts conhost.exe itself (FR-013). Never for background work.
export function openWindow(title, file, args, { cwd, env = process.env, keepOpen = false, minimized = false } = {}) {
  if (process.platform !== 'win32') return spawn(file, args, { cwd, env, stdio: 'inherit', windowsHide: false });
  const q = (a) => `"${String(a).replace(/"/g, "'")}"`;
  const cmdline = [file, ...args].map(q).join(' ');
  const inner = keepOpen ? `cmd /k "${cmdline}"` : cmdline;
  const line = `start "${windowTitle(title)}"${minimized ? ' /min' : ''} ${inner}`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', `"${line}"`], {
    cwd,
    env,
    windowsVerbatimArguments: true,
    windowsHide: true,
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child;
}

// Open a page in the default browser. Only plain http(s) links without characters that cmd.exe treats
// specially (the dashboard's own link is one); false when that isn't one or nothing could be started.
export function openUrl(url) {
  if (!/^https?:\/\/[A-Za-z0-9.:/?=_~-]+$/.test(url)) return false;
  const [cmd, args, extra] = IS_WIN
    ? ['cmd.exe', ['/d', '/s', '/c', `"start "" "${url}""`], { windowsVerbatimArguments: true }]
    : process.platform === 'darwin'
      ? ['open', [url], {}]
      : ['xdg-open', [url], {}];
  try {
    const child = spawn(cmd, args, { ...extra, detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {}); // no xdg-open (a server without a desktop): the link is printed anyway
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// PATH as a window opened now would get it. Installers add their folder to the machine's or the user's
// Path in the registry, which only windows opened afterwards see (FR-001 #4); a process that runs for
// hours (the dashboard) adds those folders to its own PATH before it runs the doctor or starts
// anything, so a tool installed in another window meanwhile is found. Folders already on PATH keep
// their place (in tests the stub CLIs come first). Windows only; returns whether PATH changed.
export function mergePath(current, added, delimiter = ';') {
  const key = (p) => p.trim().replace(/[\\/]+$/, '').toLowerCase();
  const seen = new Set(String(current || '').split(delimiter).filter(Boolean).map(key));
  const extra = added.map((p) => p.trim()).filter((p) => p && !seen.has(key(p)) && seen.add(key(p)));
  return extra.length ? [current, ...extra].filter(Boolean).join(delimiter) : current;
}
const REGISTRY_PATH =
  "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; [Environment]::GetEnvironmentVariable('Path', 'Machine'); [Environment]::GetEnvironmentVariable('Path', 'User')";
export function refreshPath(env = process.env) {
  // (the tests' PATH is the stubs' and the system's: the PC's own Path has the real CLIs on it, FR-010)
  if (!IS_WIN || testStubs(env) !== null) return false;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(REGISTRY_PATH, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
  });
  if (r.status !== 0 || !r.stdout) return false;
  const next = mergePath(env.PATH, r.stdout.replace(/^\uFEFF/, '').split(/[\r\n;]+/));
  if (next === env.PATH) return false;
  env.PATH = next;
  return true;
}
