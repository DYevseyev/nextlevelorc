// Runs one program with a real console as its stdin and its output through pipes (console.mjs runInConsole), and
// writes what it printed and its exit code to a file. This process was started with CREATE_NO_WINDOW, so it has a
// console with no window: the program gets that console's input (CONIN$). With no console there, it doesn't run the
// program at all and says so ({ noConsole }).
//   node console-run.mjs <base64 of { file, shell, args, resultFile, timeoutMs, direct }>
// `direct`: a .cmd shim's program starts without cmd.exe, as a worker's engine does (lib/proc.mjs spawnDirect, FR-013);
// the model check's trial runs so (FR-022: the trial launches what a worker launches).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { openConsoleInput } from './console.mjs';
import { spawnBin, spawnDirect } from './proc.mjs';

const MAX = 1024 * 1024; // what a check needs is short: at most the last megabyte
const spec = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString('utf8'));
let out = '';
let timedOut = false;
const add = (d) => {
  out = (out + d).slice(-MAX);
};
const done = (code, error = '') => {
  fs.writeFileSync(spec.resultFile, JSON.stringify({ code, timedOut, out: error ? `${out}${error}\n` : out }));
  process.exit(0);
};
const input = openConsoleInput();
if (input.error) {
  fs.writeFileSync(spec.resultFile, JSON.stringify({ code: null, noConsole: input.error }));
  process.exit(0);
}
const child = (spec.direct ? spawnDirect : spawnBin)({ file: spec.file, shell: spec.shell }, spec.args, { stdio: [input.fd, 'pipe', 'pipe'], windowsHide: true });
child.stdout.setEncoding('utf8').on('data', add);
child.stderr.setEncoding('utf8').on('data', add);
const timer = setTimeout(() => {
  timedOut = true;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
}, spec.timeoutMs || 20_000);
child.on('error', (err) => done(null, err.message));
child.on('close', (code) => {
  clearTimeout(timer);
  done(code);
});
