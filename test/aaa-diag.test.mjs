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
test('DIAG listing environments', { skip: process.platform !== 'win32' }, async () => {
  const base = windowsEnv('C:\\Windows');
  console.log('DIAG base', JSON.stringify(base));
  const extra = Object.keys(process.env).filter((k) => !Object.keys(base).some((b) => b.toLowerCase() === k.toLowerCase()));
  console.log('DIAG extra names', extra.join(','));
  await run('full env', process.env);
  await run('base, echo', base, "'hi'");
  await run('base, Get-Process', base, "(Get-Process).Count");
  const okBase = await run('base, CIM', base);
  await run('base, WMI .NET', base, "Add-Type -AssemblyName System.Management; (New-Object System.Management.ManagementObjectSearcher 'SELECT ProcessId FROM Win32_Process').Get().Count");
  if (okBase) return;
  let need = extra;
  const withSome = (names) => ({ ...base, ...Object.fromEntries(names.map((n) => [n, process.env[n]])) });
  if (!(await run('base + all extra', withSome(extra)))) return;
  // bisect to a small set that makes it answer
  while (need.length > 1) {
    const half = need.slice(0, Math.ceil(need.length / 2));
    const rest = need.slice(half.length);
    if (await run(`base + [${half.join(',')}]`, withSome(half))) need = half;
    else if (await run(`base + [${rest.join(',')}]`, withSome(rest))) need = rest;
    else break;
  }
  console.log('DIAG needed', need.join(','));
  for (const n of need) console.log(`DIAG value ${n}=${String(process.env[n]).slice(0, 200)}`);
  // and from a CLI-like child started by spawnSync
  const r = spawnSync(process.execPath, ['-e', `const {spawnSync}=require('child_process');const t=Date.now();const x=spawnSync(${JSON.stringify(PS)},${JSON.stringify(enc(CIM))},{env:${JSON.stringify(base)},windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:30000});console.log('child status',x.status,x.signal,Date.now()-t)`], { encoding: 'utf8', windowsHide: true });
  console.log('DIAG from a spawnSync child:', r.stdout, r.stderr);
});
