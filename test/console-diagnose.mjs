// Diagnostics for the console with no window (src/lib/console.mjs, FR-010 and FR-013) on a machine where workers
// didn't start: what Windows is, whether a process started the way nextlevel starts a worker (CREATE_NO_WINDOW: Node's
// windowsHide with no handle inherited) has a console whose input it can give a program, and then the hub's own path
// with a stub Antigravity task. Prints everything; exits 0. Not a test (CI runs it as a step of its own on Windows).
//   node test/console-diagnose.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONSOLE_INPUT, runInConsole } from '../src/lib/console.mjs';
import { fileExists, makeProject } from './helpers.mjs';

const say = (...a) => console.log(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (process.platform !== 'win32') {
  say('not Windows: nothing to diagnose');
  process.exit(0);
}
const ps = (cmd) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 30_000 }).stdout?.trim();
say('## Windows');
say(`os.release ${os.release()} · ${os.version()} · node ${process.version} · user ${os.userInfo().username}`);
say(`SESSIONNAME=${process.env.SESSIONNAME || '(unset)'} · UserInteractive=${ps('[Environment]::UserInteractive')} · session ${ps('(Get-Process -Id $PID).SessionId')}`);
say(`stdin is a TTY here: ${process.stdin.isTTY ? 'yes' : 'no'} · console input: ${CONSOLE_INPUT()}`);

// A process started with no window: does it have a console, and can it hand its input to a program as its stdin?
say('\n## a process started with CREATE_NO_WINDOW (stdio pipes, windowsHide), as a worker is');
const ask = `
  const fs = require('node:fs'), tty = require('node:tty'), { spawnSync } = require('node:child_process');
  let fd = null, err = '';
  try { fd = fs.openSync(${JSON.stringify(CONSOLE_INPUT())}, 'r+'); } catch (e) { err = e.code || e.message; }
  const inner = fd === null ? null : spawnSync(process.execPath, ['-e', "process.stdout.write(String(require('tty').isatty(0)))"], { stdio: [fd, 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true });
  process.stdout.write(JSON.stringify({ ownStdinTTY: tty.isatty(0), conin: fd !== null, coninTTY: fd !== null && tty.isatty(fd), err, programStdinTTY: inner ? inner.stdout : null }));`;
const r = spawnSync(process.execPath, ['-e', ask], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 });
say(`- ${r.stdout || '(nothing)'}${r.stderr ? ` · stderr: ${r.stderr.trim()}` : ''} · exit ${r.status}`);

say('\n## runInConsole (a check: a command in the console, its output through pipes)');
say(`- ${JSON.stringify(runInConsole('node', ['-e', "console.log('stdin TTY', require('tty').isatty(0))"], { timeoutMs: 15_000 }))}`);

say('\n## the hub: a stub Antigravity task (it needs a real console)');
const p = makeProject();
try {
  p.spec('M1-01-ok', fileExists('ok.mjs'));
  p.hub(['dispatch', 'M1-01-ok']);
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  for (let i = 0; i < 300; i++) {
    await sleep(200);
    const s = fs.existsSync(p.jobFile('M1-01-ok', 'status.json')) ? p.status('M1-01-ok') : null;
    if (s && !['queued', 'running', 'verifying'].includes(s.state)) break;
    if (i === 150) say('(30 s, still waiting)');
  }
  say(`status: ${fs.existsSync(p.jobFile('M1-01-ok', 'status.json')) ? JSON.stringify(p.status('M1-01-ok')) : '(none)'}`);
  say(`run.json: ${fs.existsSync(p.jobFile('M1-01-ok', 'run.json')) ? fs.readFileSync(p.jobFile('M1-01-ok', 'run.json'), 'utf8') : '(none: _run never started)'}`);
  say(`worker.log:\n${fs.existsSync(p.jobFile('M1-01-ok', 'worker.log')) ? fs.readFileSync(p.jobFile('M1-01-ok', 'worker.log'), 'utf8') : '(none)'}`);
  say(`hub.log:\n${fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '(none)'}`);
  // nextlevel's own processes only: other programs' command lines can hold keys
  say(`nextlevel's processes now: ${ps("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'nextlevel' } | ForEach-Object { \"$($_.ProcessId) $($_.Name) $($_.CommandLine)\" } | Out-String") || '(none)'}`);
  fs.writeFileSync(p.state('hub-stop.json'), '{}');
  await sleep(2000);
  bg.kill();
} finally {
  try {
    p.cleanup();
  } catch (err) {
    say(`cleanup: ${err.message}`);
  }
}
process.exit(0);
