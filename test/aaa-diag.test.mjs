// TEMPORARY diagnosis of the ancestry listing on Windows (removed before merge)
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { windowsEnv } from '../src/lib/ancestry.mjs';

const CIM = "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.Name } }";
const enc = (s) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(s, 'utf16le').toString('base64')];
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function run(label, env, script = CIM, ms = 30000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let err = '';
    const c = spawn(PS, enc(script), { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { c.kill('SIGKILL'); console.log(`DIAG ${label}: LATE after ${ms} ms; stderr: ${err.slice(0, 400)} out: ${out.slice(0, 200)}`); resolve(false); }, ms);
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => { clearTimeout(timer); console.log(`DIAG ${label}: exit ${code} in ${Date.now() - t0} ms, ${out.split('\n').length} lines; stderr: ${err.slice(0, 400)}`); resolve(code === 0); });
  });
}
const timed = (label, env, script) => new Promise((resolve) => { const t = Date.now(); run(label, env, script).then((ok) => resolve(ok ? Date.now() - t : 99999)); });
test('DIAG listing environments', { skip: process.platform !== 'win32' }, async () => {
  const base = windowsEnv('C:\\Windows');
  const extra = Object.keys(process.env).filter((k) => !Object.keys(base).some((b) => b.toLowerCase() === k.toLowerCase()));
  const withSome = (names) => ({ ...base, ...Object.fromEntries(names.map((n) => [n, process.env[n]])) });
  const GP = "(Get-Process).Count";
  const IMP = "Import-Module 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules\\CimCmdlets\\CimCmdlets.psd1'; " + CIM;
  await timed('full env, GP', process.env, GP);
  await timed('base, GP', base, GP);
  await timed('base, explicit import CIM', base, IMP);
  await timed('full, explicit import CIM', process.env, IMP);
  const arch = Object.keys(process.env).filter((k) => /^(PROCESSOR_|NUMBER_OF_PROCESSORS|USERDOMAIN|PSModuleAnalysisCachePath|__PS)/i.test(k));
  console.log('DIAG arch names', arch.join(','), arch.map((k) => `${k}=${process.env[k]}`).join(' '));
  await timed('base + PROCESSOR_* etc, GP', withSome(arch), GP);
  console.log('DIAG full PSModulePath', process.env.PSModulePath);
  let need = extra;
  const fast = async (names) => (await timed(`base + ${names.length} [${names.slice(0, 12).join(',')}]`, withSome(names), GP)) < 10000;
  if (!(await fast(extra))) return;
  while (need.length > 1) {
    const half = need.slice(0, Math.ceil(need.length / 2));
    const rest = need.slice(half.length);
    if (await fast(half)) need = half;
    else if (await fast(rest)) need = rest;
    else { console.log('DIAG neither half alone', half.join(','), '|', rest.join(',')); break; }
  }
  console.log('DIAG needed', need.join(','));
  for (const n of need) console.log(`DIAG value ${n}=${String(process.env[n]).slice(0, 300)}`);
});
