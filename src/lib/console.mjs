// A real console with no window, for programs that need one: agy's print mode on Windows (FR-010). Windows' own
// documented way to start a console program without a window is the CREATE_NO_WINDOW process flag: the program gets a
// console of its own that has no window, and every program it starts shares it. Node gives a child that flag
// (windowsHide) when the child inherits no handle, so the process nextlevel starts (a worker's _run, an autopilot
// round's _cycle, the runner below) gets stdio 'ignore' or pipes, and inside it opens the console's input, CONIN$, as
// the stdin of the program that needs a console (openConsoleInput). Nothing appears on the screen, nothing takes the
// focus, and no default terminal (Windows Terminal) is asked. What reaches that console's screen is thrown away:
// nextlevel reads a program's output through pipes, which agy accepts once its stdin is the console.
// Before FR-013 nextlevel started conhost.exe itself (`conhost.exe --headless`); an antivirus judged that hidden console,
// with an agent running in it, malicious (FR-013), so nextlevel no longer starts conhost.exe directly.
// A program started this way must never fall back to running without a console (agy drops its output or hangs).
// docs/KNOWN_ISSUES.md#windows-consoles-fr-010-fr-013 has the measurements.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';
import { fileURLToPath } from 'node:url';
import { homeDir, jsonStore } from './home.mjs';
import { resolveBin } from './proc.mjs';

// A console with no window that didn't start on this PC is remembered for a day (~/.nextlevel/console.json). What
// needs a console then gets a window of its own, the way it was before FR-010: a visible window beats a stuck task.
// After a day it is tried again (an update of Windows may have changed it).
export const CONSOLE_MEMORY_MS = 24 * 3_600_000;
const memory = () => jsonStore(path.join(homeDir(), 'console.json'));
// { why, at } while it is remembered, else null
export function consoleBroken(now = Date.now()) {
  const m = memory().get('failed');
  return m?.at && now - Date.parse(m.at) < CONSOLE_MEMORY_MS ? m : null;
}
export const rememberConsoleFailure = (why, at = new Date()) => memory().set('failed', { why: String(why), at: at.toISOString() });
export const forgetConsoleFailure = () => memory().set('failed', null);
// Why a program can't get a console with no window here, or ''.
export const consoleProblem = (platform = process.platform) => (platform === 'win32' ? '' : 'a console with no window is for Windows');

// The console's input, where a process started with CREATE_NO_WINDOW has one. NEXTLEVEL_CONIN names another file
// instead (the tests point it at one that isn't there, to play a PC where the console with no window doesn't start).
export const CONSOLE_INPUT = (env = process.env) => env.NEXTLEVEL_CONIN || '\\\\.\\CONIN$';

// Opens this process's console input for a program that needs a real console as its stdin: { fd } (a console), or
// { error } (no console: the program must not run then). Windows only.
export function openConsoleInput(env = process.env) {
  if (process.platform !== 'win32') return { error: 'a console with no window is for Windows' };
  let fd;
  try {
    fd = fs.openSync(CONSOLE_INPUT(env), 'r+');
  } catch (err) {
    return { error: `this process has no console to give it (${err.code || err.message})` };
  }
  if (tty.isatty(fd)) return { fd };
  fs.closeSync(fd);
  return { error: 'what this process has as its console input is not a console' };
}

// Starts `file args` in a console of its own with no window and leaves it running (a worker, an autopilot round):
// the process that started it may end. CREATE_NO_WINDOW (windowsHide, no handle inherited); not detached, since a
// detached process has no console at all. Returns the child.
export function startInConsole(file, args, { cwd, env = process.env } = {}) {
  const problem = consoleProblem();
  if (problem) throw new Error(problem);
  const child = spawn(file, args, { cwd, env, stdio: 'ignore', windowsHide: true });
  child.unref();
  return child;
}

// Runs a command in a console with no window and waits for it (a check that tries agy's print mode): what it printed
// (stdout and stderr, through pipes) and how it ended, like proc.mjs runQuiet. The runner (console-run.mjs) starts
// with CREATE_NO_WINDOW, opens its console's input for the program's stdin and writes the result to a file.
const RUNNER = fileURLToPath(new URL('./console-run.mjs', import.meta.url));
// A runner that ended without the program's result, before the time was up, found no console to give it:
// { noConsole: true }, remembered for this PC.
// `direct`: a .cmd shim's program starts without cmd.exe, as a worker's engine does (FR-022).
export function runInConsole(cmd, args, { timeoutMs = 20_000, cwd, env = process.env, direct = false } = {}) {
  const bin = resolveBin(cmd);
  if (!bin) return { ok: false, missing: true, code: null, out: '' };
  const problem = consoleProblem();
  if (problem) return { ok: false, code: null, out: problem };
  const broken = consoleBroken();
  if (broken) return { ok: false, code: null, noConsole: true, out: `the console with no window doesn't start on this PC (${broken.why})` };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-console-'));
  const resultFile = path.join(dir, 'result.json');
  const spec = Buffer.from(JSON.stringify({ file: bin.file, shell: bin.shell, args, resultFile, timeoutMs, direct })).toString('base64');
  try {
    const runner = spawnSync(process.execPath, [RUNNER, spec], { cwd, env, stdio: 'ignore', windowsHide: true, timeout: timeoutMs + 15_000 });
    const r = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : null;
    if (!r) {
      if (runner.error?.code === 'ETIMEDOUT' || runner.signal) return { ok: false, code: null, timedOut: true, out: `no answer from ${cmd} in its console` };
      const why = runner.error ? `the runner didn't start: ${runner.error.message}` : `the runner ended before ${cmd} ran (exit ${runner.status})`;
      return { ok: false, code: null, out: why };
    }
    if (r.noConsole) {
      rememberConsoleFailure(r.noConsole);
      return { ok: false, code: null, noConsole: true, out: `the console with no window didn't start here: ${r.noConsole}` };
    }
    return { ok: r.code === 0 && !r.timedOut, code: r.code, timedOut: !!r.timedOut, out: String(r.out || '').trim() };
  } catch (err) {
    return { ok: false, code: null, timedOut: true, out: `no answer from ${cmd} in its console (${err.message})` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
