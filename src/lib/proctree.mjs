// What a worker left running when its process ended without finishing, found in one snapshot of all processes and
// never mistaken for another program (FR-013). On Windows Node starts every child in a job that closes with its parent,
// and lets that child's own children leave the job: a worker's process (_run) that is killed takes its engine with it,
// while what the engine started lives on under a parent that is gone. `taskkill /T` can't walk down from a dead parent,
// and Windows gives a pid to a program started later. So the hub lists all processes once, with their parent ids and
// start times, and walks the worker's tree in that list from what run.json recorded (the worker's own process and its
// engine's, each with a time it was running): a child belongs to a parent only if it started after the parent did and,
// for a parent that is gone, before it was last known to run; a pid that another program has now is left alone, with
// what that program started. Elsewhere the worker's process group comes too: its id stays the group's while any process
// of it runs. docs/KNOWN_ISSUES.md#a-worker-stopped-from-outside-fr-013 has the measurements.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// How long a listing may take (NEXTLEVEL_PROCESS_LIST_MS, for tests: milliseconds; 0 gives it no time at all). Windows'
// PowerShell took over 20 s to start on a busy GitHub runner; a late listing is asked again, never taken as "nothing".
export const LIST_WAIT_MS = 20_000;
export function listWaitMs(env = process.env) {
  const v = env.NEXTLEVEL_PROCESS_LIST_MS;
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : LIST_WAIT_MS;
}

// Windows: every process CIM knows, one line each: pid|parent pid|start (ISO, UTC)|name. (The Idle and System
// processes have no start time: they are never a worker's.)
const CIM_LIST =
  "[Console]::OutputEncoding = [Text.Encoding]::UTF8; Get-CimInstance Win32_Process | ForEach-Object { if ($_.CreationDate) { '{0}|{1}|{2}|{3}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o'), $_.Name } }";
// Windows' own PowerShell, by its full path: never a program of that name in the project's folder or on PATH
const powershell = (env) => (env.SystemRoot || env.SYSTEMROOT ? path.win32.join(env.SystemRoot || env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe');
const encoded = (script) => ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
// Elsewhere: ps, with each process's state and its start time in a fixed format (lstart: "Mon Sep 28 18:13:20 2026", 24
// characters). A zombie (state Z) has ended and runs nothing; it stays listed until its parent collects it, which a parent
// busy with something else may not do for a while: it is left out.
const PS_COLUMNS = 'pid=,ppid=,pgid=,stat=,lstart=,comm=';
const C_LOCALE = { LC_ALL: 'C', LANG: 'C' };

// When the process that has `pid` now started (ms), or null when that can't be told (no such process, no access, no
// answer in `timeoutMs`): a pid with its start time is one process (a lock's holder, lib/filelock.mjs). Synchronous, for
// a lock taken in one go: Linux reads /proc (to the second: the boot time is in seconds; a tick is 10 ms, CLK_TCK 100);
// Windows asks PowerShell (about a second, so it is asked only about a holder that has kept a lock a while); elsewhere ps.
export function processStartSync(pid, { platform = process.platform, env = process.env, timeoutMs = 10_000 } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (platform === 'linux') {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const ticks = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]); // field 22, starttime (after "pid (comm) ")
      const boot = fs.readFileSync('/proc/stat', 'utf8').split('\n').find((l) => l.startsWith('btime '));
      const btime = Number(boot?.slice(6));
      return Number.isFinite(ticks) && btime > 0 ? btime * 1000 + ticks * 10 : null;
    }
    const win = platform === 'win32';
    const [file, args] = win
      ? [powershell(env), encoded(`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`)]
      : ['ps', ['-o', 'lstart=', '-p', String(pid)]];
    const r = spawnSync(file, args, { env: win ? env : { ...env, ...C_LOCALE }, windowsHide: true, encoding: 'utf8', timeout: timeoutMs });
    const t = Date.parse(String(r.stdout || '').trim());
    return r.status === 0 && Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

// Runs a program that answers within `timeoutMs`, or is stopped: { ok, code, out } | { late: true } | { error }
function ask(file, args, { timeoutMs, env }) {
  return new Promise((resolve) => {
    let out = '';
    let err = '';
    let child;
    try {
      child = spawn(file, args, { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ error: e.message });
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // already gone
      }
      resolve({ late: true });
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ error: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const why = err.trim().split(/\r?\n/).at(-1) || '';
      resolve({ ok: code === 0, code, out, error: code === 0 ? '' : `${path.basename(file)} ended with exit ${code}${why ? `: ${why}` : ''}` });
    });
  });
}

// -> [{ pid, ppid, start (ms), name }]
export function parseCim(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const [pid, ppid, start, name = ''] = line.trim().split('|');
    const p = { pid: Number(pid), ppid: Number(ppid), start: Date.parse(start), name: name.trim() };
    if (Number.isInteger(p.pid) && p.pid > 0 && Number.isInteger(p.ppid) && Number.isFinite(p.start)) out.push(p);
  }
  return out;
}
// -> [{ pid, ppid, pgid, start (ms, to the second), name }], zombies left out
export function parsePs(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+/.exec(line);
    if (!m || m[4].startsWith('Z')) continue;
    const rest = line.slice(m[0].length);
    const p = { pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), start: Date.parse(rest.slice(0, 24)), name: rest.slice(24).trim() };
    if (p.pid > 0 && Number.isFinite(p.start)) out.push(p);
  }
  return out;
}

// One snapshot of all processes: { list } | { late: true } (no answer in `timeoutMs`: the listing is stopped, and the
// caller asks again later) | { error }. `command` ([file, args]) stands in for the listing in tests, printing Windows' lines.
export async function listProcesses({ timeoutMs = listWaitMs(), platform = process.platform, env = process.env, command } = {}) {
  if (timeoutMs <= 0) return { late: true };
  const win = platform === 'win32';
  const [file, args] = command || (win ? [powershell(env), encoded(CIM_LIST)] : ['ps', ['-A', '-o', PS_COLUMNS]]);
  const r = await ask(file, args, { timeoutMs, env: win ? env : { ...env, ...C_LOCALE } });
  if (r.late || !r.ok) return r.late ? { late: true } : { error: r.error };
  const list = (win || command ? parseCim : parsePs)(r.out);
  return list.length ? { list } : { error: `${path.basename(file)} listed nothing` };
}

// Stops processes of a snapshot ([{ pid, start }]), each only while the process with that pid is still the one that
// started when the snapshot says: a pid another program has now is never touched. On Windows the check and the kill go
// through one handle to the process (while it is open, Windows gives that pid to no other program); elsewhere ps is asked
// right before the kill (pids are handed out in turn: one comes back only after all the others). A zombie has ended.
// -> { stopped, gone (ended before), other (another program has the pid), left (still runs 3 s after the kill) }, each
// a part of `list`; or { late: true } | { error }
export async function stopProcesses(list, { timeoutMs = listWaitMs(), platform = process.platform, env = process.env } = {}) {
  const targets = list.filter((p) => Number.isInteger(p.pid) && p.pid > 0 && Number.isFinite(p.start));
  const out = { stopped: [], gone: [], other: [], left: [] };
  if (!targets.length) return out;
  if (timeoutMs <= 0) return { late: true };
  if (platform === 'win32') {
    const r = await ask(powershell(env), encoded(stopScript(targets)), { timeoutMs, env });
    if (r.late || !r.ok) return r.late ? { late: true } : { error: r.error };
    const said = new Map(r.out.split(/\r?\n/).map((l) => l.trim().split('|')).filter((x) => x.length === 2).map(([pid, what]) => [Number(pid), what]));
    for (const p of targets) out[['stopped', 'gone', 'other'].includes(said.get(p.pid)) ? said.get(p.pid) : 'left'].push(p);
    return out;
  }
  const opts = { timeoutMs, env: { ...env, ...C_LOCALE } };
  const now = await psNow(targets, opts);
  if (!now.rows) return now;
  const killed = [];
  for (const p of targets) {
    const row = now.rows.get(p.pid);
    if (!row || row.zombie) out.gone.push(p);
    else if (row.start !== p.start) out.other.push(p);
    else {
      try {
        process.kill(p.pid, 'SIGKILL');
      } catch {
        // it ended just now
      }
      killed.push(p);
    }
  }
  // Still there: the same pid with the same start, not a zombie
  let pending = killed;
  for (let i = 0; i < 30 && pending.length; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const again = await psNow(pending, opts);
    if (!again.rows) continue;
    pending = pending.filter((p) => again.rows.get(p.pid) && !again.rows.get(p.pid).zombie && again.rows.get(p.pid).start === p.start);
  }
  out.stopped.push(...killed.filter((p) => !pending.includes(p)));
  out.left.push(...pending);
  return out;
}
// ps on these pids: { rows: Map pid -> { zombie, start } } (no row: not there) | { late } | { error }
async function psNow(list, opts) {
  const r = await ask('ps', ['-o', 'pid=,stat=,lstart=', '-p', list.map((p) => p.pid).join(',')], opts);
  if (r.late) return { late: true };
  // (ps ends with 1 when none of them is there)
  if (!r.ok && !(r.code === 1 && !r.out.trim())) return { error: r.error };
  const rows = new Map();
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\S+)\s+/.exec(line);
    if (m) rows.set(Number(m[1]), { zombie: m[2].startsWith('Z'), start: Date.parse(line.slice(m[0].length, m[0].length + 24)) });
  }
  return { rows };
}
// Windows: for each "pid:start" (start in ms since 1970), the process is opened and held, its start compared, and only
// then killed: one line each, pid|stopped, gone, other or left
const stopScript = (targets) => `$ErrorActionPreference = 'Stop'
foreach ($t in '${targets.map((p) => `${p.pid}:${Math.trunc(p.start)}`).join(';')}'.Split(';')) {
  $id = [int]$t.Split(':')[0]; $want = [long]$t.Split(':')[1]
  try { $p = [Diagnostics.Process]::GetProcessById($id) } catch { "$id|gone"; continue }
  try { $null = $p.Handle; $ms = ([DateTimeOffset]$p.StartTime).ToUnixTimeMilliseconds() } catch { "$id|left"; continue }
  if ([Math]::Abs($ms - $want) -gt 1) { "$id|other"; continue }
  try { $p.Kill() } catch { }
  if ($p.WaitForExit(3000)) { "$id|stopped" } else { "$id|left" }
}`;

// What a process of the worker started, it started after the time run.json recorded for that process, give or take this
// (the engine's time is written the moment it starts; the worker's own when its code starts, before it starts anything)
const RECORDED_MS = 2000;
// The worker's tree in a snapshot `list` (start times on one clock: ps's are cut to the second, which keeps their order).
// `roots`: [{ pid, at, within, until, what }] from run.json: `at` a time it was running, which it started at most `within`
// ms before, and `until` the last time it was known to run (when the hub saw it end); `group`: the worker's process group
// (POSIX). `self`: the hub, which is never part of it, nor is anything it runs under.
// -> { found: the tree's processes that run (to stop), reused: [{ ...root, now }]: a root whose pid another program has now }
export function processTree(list, { roots = [], group = 0, self = 0, now: clock = Date.now() } = {}) {
  const byPid = new Map(list.map((p) => [p.pid, p]));
  const spared = new Set([0, 1, 4]);
  for (let p = byPid.get(self); p && !spared.has(p.pid); p = byPid.get(p.ppid)) spared.add(p.pid);
  const found = new Map();
  const reused = [];
  const parents = []; // { pid, from, to }: a process of the tree, and when what it started may have started
  const take = (p) => {
    if (found.has(p.pid) || spared.has(p.pid)) return;
    found.set(p.pid, p);
    parents.push({ pid: p.pid, from: p.start, to: Infinity }); // (it runs: its pid is its own)
  };
  // (a record with a time still to come fits no process: it is left out)
  for (const r of roots.filter((x) => Number.isInteger(x.pid) && x.pid > 0 && Number.isFinite(x.at) && x.at <= clock)) {
    const now = byPid.get(r.pid);
    // running, and started shortly before the time it was recorded at: that process itself
    if (now && now.start <= r.at && now.start >= r.at - (Number.isFinite(r.within) ? r.within : RECORDED_MS)) {
      take(now);
      continue;
    }
    // Another program has its pid (one started later, or a record that doesn't fit it): never touched. What the root
    // started, it started after the root's recorded time and before the root was last known to run, and before its pid
    // went to that program.
    if (now) reused.push({ ...r, now });
    parents.push({ pid: r.pid, from: r.at - RECORDED_MS, to: Math.min(Number.isFinite(r.until) ? r.until : r.at, now ? now.start - 1 : Infinity) });
  }
  // (POSIX) what is left of the worker's process group. Its id can't go to another process while the group has one, so
  // a process of another group with that id means the worker's group is gone.
  const leader = group ? byPid.get(group) : null;
  if (group && (!leader || found.has(group))) for (const p of list) if (p.pgid === group) take(p);
  for (let i = 0; i < parents.length; i++) {
    const par = parents[i];
    for (const p of list) if (p.ppid === par.pid && p.start >= par.from && p.start <= par.to) take(p);
  }
  return { found: [...found.values()], reused };
}

// A process in words: "node.exe (pid 1234)"
export const processName = (p) => `${p.name || 'a process'} (pid ${p.pid})`;
