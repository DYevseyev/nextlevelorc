// A command run under a worker is refused by its ancestry (FR-017 part 2B, docs/design/FR-017-part2B.md 3.1). The hub
// records the processes it starts for a task's attempt (the worker's own process, `_run`, and its verify's shells) and
// for the checks and git jobs it runs as the owner (`agents.json` in the guard's folder, ~/.nextlevel/guard/<project>/,
// outside every project). A `nextlevel` command that acts walks its own chain of parents in one snapshot of the PC's
// processes: a link to a recorded process refuses, whatever its environment says and whichever project it names. The
// commands that only look run anyway.
//
// Nothing comes from the caller's environment once nextlevel runs from an installed version's folder: the record is
// read from the home the OS gives (os.userInfo(), never HOME, USERPROFILE or NEXTLEVEL_HOME), the listing is Windows'
// own PowerShell at its fixed path with an environment of its own (no PSModulePath a worker could set), /proc on Linux,
// /bin/ps elsewhere, and it waits LIST_WAIT_MS whatever NEXTLEVEL_PROCESS_LIST_MS says. Run from a checkout (the tests),
// os.homedir() and NEXTLEVEL_PROCESS_LIST_MS count.
//
// When the snapshot can't be had while something is recorded, the command refuses unless it carries a live session
// token of the orchestrator (NEXTLEVEL_SESSION_TOKEN: its window and each round get one; the record keeps its hash).
// This is layer 1: a worker that reads the owner's files or starts a process outside its tree passes (KNOWN_ISSUES).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { COMMANDS, parseCommand } from './commands.mjs';
import { readJsonFile, updateJsonFile } from './filelock.mjs';
import { guardDir } from './guard.mjs';
import { LIST_WAIT_MS, WMI_LIST, listProcesses, listWaitMs } from './proctree.mjs';

export const RECORD = 'agents.json';
export const REFUSED = 'refused.jsonl';
// A recorded process is the one with its pid that started no later than this after the hub recorded it (ps gives start
// times to the second); a process given that pid later is another program.
export const START_SLACK_MS = 2_000;
const KINDS = new Set(['worker', 'verify', 'check', 'git-job']);

// Whether this nextlevel runs from an installed version's folder (~/.nextlevel/versions/<name>, or a trial home's) or
// from the tool's clone (the store: ~/.nextlevel/tool, or where the OS home's versions.json says the installer put it;
// its checkout runs as it is under NEXTLEVEL_LAUNCHED=1): then none of the test switches count. A checkout (the tests,
// a developer) is anything else.
const osHome = () => {
  try {
    return os.userInfo().homedir || os.homedir();
  } catch {
    return os.homedir();
  }
};
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
export function installedTool(toolRoot, { home = osHome() } = {}) {
  const root = path.resolve(toolRoot);
  if (path.basename(path.dirname(root)) === 'versions') return true;
  const nl = path.join(home, '.nextlevel');
  const stores = [path.join(nl, 'tool')];
  try {
    const v = JSON.parse(fs.readFileSync(path.join(nl, 'versions.json'), 'utf8'));
    if (typeof v?.store === 'string' && v.store) stores.push(v.store);
  } catch {
    // no versions yet: only the default folder
  }
  return stores.some((d) => samePath(path.resolve(d).replace(/[\\/]+$/, ''), root));
}

// The home the record lives in: the OS's own answer for an installed tool, os.homedir() for a checkout (the tests give
// each hub a home of its own). The hub and the command ask the same question.
export function agentsHome({ toolRoot, installed = installedTool(toolRoot) } = {}) {
  return installed ? osHome() : os.homedir();
}

const recordFile = (root, home) => path.join(guardDir(root, home), RECORD);
const emptyRecord = () => ({ agents: [], sessions: [] });
function shaped(r) {
  const ok = r && typeof r === 'object';
  const agents = ok && Array.isArray(r.agents) ? r.agents.filter((a) => a && Number.isInteger(a.pid) && a.pid > 0 && Number.isFinite(Date.parse(a.at)) && KINDS.has(a.kind)) : [];
  const sessions = ok && Array.isArray(r.sessions) ? r.sessions.filter((s) => s && /^[0-9a-f]{64}$/.test(s.hash || '')) : [];
  return { agents, sessions };
}
const update = (root, home, fn) => updateJsonFile(recordFile(root, home), (cur) => fn(shaped(cur)), emptyRecord());

// The hub's writes. entry: { pid, kind: worker|verify|check|git-job, task?, job? }; `at` is now.
export function addAgent(root, entry, { home } = {}) {
  const at = new Date().toISOString();
  update(root, home, (r) => ({ ...r, agents: [...r.agents.filter((a) => a.pid !== entry.pid), { ...entry, at }] }));
}
export function removeAgents(root, pred, { home } = {}) {
  update(root, home, (r) => ({ ...r, agents: r.agents.filter((a) => !pred(a)) }));
}
export function readRecord(root, { home } = {}) {
  return shaped(readJsonFile(recordFile(root, home), emptyRecord()));
}

// The orchestrator's session token: a random value in its environment, never on disk; its SHA-256 in the record while
// the session's process runs. -> the token
const hashOf = (token) => createHash('sha256').update(String(token)).digest('hex');
export function addSession(root, { pid = process.pid, kind, home } = {}) {
  const token = randomBytes(24).toString('hex');
  const at = new Date().toISOString();
  update(root, home, (r) => ({ ...r, sessions: [...r.sessions, { hash: hashOf(token), pid, kind, at }] }));
  return token;
}
export function removeSession(root, token, { home } = {}) {
  const hash = hashOf(token);
  update(root, home, (r) => ({ ...r, sessions: r.sessions.filter((s) => s.hash !== hash) }));
}
// Sessions whose process is gone leave the record (the hub's tick)
export function pruneSessions(root, { home, alive = pidAlive } = {}) {
  const r = readRecord(root, { home });
  if (r.sessions.every((s) => !Number.isInteger(s.pid) || alive(s.pid))) return;
  update(root, home, (cur) => ({ ...cur, sessions: cur.sessions.filter((s) => !Number.isInteger(s.pid) || alive(s.pid)) }));
}
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Every project's record on this PC: a worker can name any project (--project), or none.
export function allRecords(home) {
  const dir = path.join(home, '.nextlevel', 'guard');
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch {
    return [];
  }
  return names.map((name) => ({ dir: path.join(dir, name), ...shaped(readJsonFile(path.join(dir, name, RECORD), emptyRecord())) })).filter((r) => r.agents.length || r.sessions.length);
}

// The commands that only look: they run under a worker too (the design's list, 3.1). Everything else acts and refuses,
// the underscore commands included; a new command acts until it is put here.
const LOOK = {
  status: () => true,
  result: () => true,
  wait: () => true,
  usage: (rest) => !rest.some((a) => a === '--all-projects' || a.startsWith('--all-projects=')),
  note: (rest) => rest[0] === 'list',
  handoff: (rest) => rest[0] === 'list' || rest[0] === 'show',
  doctor: (rest) => !rest.some((a) => a === '--fix' || a.startsWith('--fix=')),
  version: () => true,
  help: () => true,
};
export function looksOnly(cmd, rest = []) {
  // Help is what the parser reads as help: a "--help" after "--" is an argument (`verify v -- npm test --help` queues a
  // check), never help
  if (cmd !== undefined && Object.hasOwn(COMMANDS, cmd) && parseCommand(cmd, rest).help) return true;
  const name = ['--help', '-h'].includes(cmd) ? 'help' : ['--version', '-v'].includes(cmd) ? 'version' : cmd;
  return !!LOOK[name]?.(rest);
}

// The command's chain of parents, nearest first: [{ pid, ppid, start }], each parent taken only if it started no later
// than its child (a pid Windows gave to a later program is never a parent). From a snapshot list.
export function chainIn(list, pid) {
  const by = new Map(list.map((p) => [p.pid, p]));
  const out = [];
  let cur = by.get(pid);
  const seen = new Set();
  while (cur && !seen.has(cur.pid)) {
    seen.add(cur.pid);
    const parent = by.get(cur.ppid);
    if (!parent || parent.pid === cur.pid || parent.start > cur.start) break;
    out.push(parent);
    cur = parent;
  }
  return out;
}

// Linux: the chain from /proc, a file per process (no listing to start). -> [{ pid, ppid, start }] or null
function procStat(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { pid, ppid: Number(f[1]), ticks: Number(f[19]) };
  } catch {
    return null;
  }
}
export function procChain(pid) {
  let btime = 0;
  try {
    btime = Number(fs.readFileSync('/proc/stat', 'utf8').split('\n').find((l) => l.startsWith('btime '))?.slice(6));
  } catch {
    return null;
  }
  const self = procStat(pid);
  if (!self || !(btime > 0)) return null;
  const list = [];
  const seen = new Set([pid]);
  let cur = self;
  while (cur.ppid > 0 && !seen.has(cur.ppid)) {
    const parent = procStat(cur.ppid);
    if (!parent || parent.ticks > cur.ticks) break;
    seen.add(parent.pid);
    list.push({ pid: parent.pid, ppid: parent.ppid, start: btime * 1000 + parent.ticks * 10 });
    cur = parent;
  }
  return list;
}

// Where Windows is, not from the caller's environment: C:\Windows, else SystemRoot when it is a drive's own Windows folder
function windowsDir(env) {
  if (fs.existsSync('C:\\Windows\\System32')) return 'C:\\Windows';
  const v = String(env.SystemRoot || env.SYSTEMROOT || '');
  return /^[A-Za-z]:\\Windows$/i.test(v) ? v : 'C:\\Windows';
}
// The environment Windows' PowerShell lists the processes in: what Windows gives every program, made here from the OS
// (Windows' folder, the OS's home for this account, its name), never from the caller's environment, so no variable a
// worker set (PSModulePath, a .NET profiler's COR_*) reaches it. The listing loads no module (WMI_LIST in
// lib/proctree.mjs): a cmdlet's module analysis took about 18 s on GitHub's Windows runner in this environment.
export function windowsEnv(winDir, { home = osHome(), user = os.userInfo().username, host = os.hostname() } = {}) {
  const drive = winDir.slice(0, 2);
  const sys = path.win32.join(winDir, 'System32');
  const local = path.win32.join(home, 'AppData', 'Local');
  const temp = path.win32.join(local, 'Temp');
  return {
    SystemRoot: winDir,
    windir: winDir,
    SystemDrive: drive,
    ComSpec: path.win32.join(sys, 'cmd.exe'),
    PATH: [sys, winDir, path.win32.join(sys, 'Wbem'), path.win32.join(sys, 'WindowsPowerShell', 'v1.0')].join(';'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PSModulePath: path.win32.join(sys, 'WindowsPowerShell', 'v1.0', 'Modules'),
    USERPROFILE: home,
    HOMEDRIVE: home.slice(0, 2),
    HOMEPATH: home.slice(2),
    APPDATA: path.win32.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: local,
    TEMP: temp,
    TMP: temp,
    ProgramData: `${drive}\\ProgramData`,
    ProgramFiles: `${drive}\\Program Files`,
    'ProgramFiles(x86)': `${drive}\\Program Files (x86)`,
    ProgramW6432: `${drive}\\Program Files`,
    CommonProgramFiles: `${drive}\\Program Files\\Common Files`,
    'CommonProgramFiles(x86)': `${drive}\\Program Files (x86)\\Common Files`,
    CommonProgramW6432: `${drive}\\Program Files\\Common Files`,
    PUBLIC: `${drive}\\Users\\Public`,
    ALLUSERSPROFILE: `${drive}\\ProgramData`,
    USERNAME: user,
    COMPUTERNAME: host,
    OS: 'Windows_NT',
  };
}
// The chain of this process's parents: { chain } | { late: true } | { error }
export async function ownChain({ pid = process.pid, platform = process.platform, env = process.env, installed, listing = listProcesses } = {}) {
  const wait = installed ? LIST_WAIT_MS : listWaitMs(env);
  if (!installed && wait <= 0) return { late: true };
  if (platform === 'linux') {
    const chain = procChain(pid);
    return chain ? { chain } : { error: '/proc could not be read' };
  }
  const win = platform === 'win32';
  const winDir = windowsDir(env);
  const own = win ? windowsEnv(winDir) : { PATH: '/usr/bin:/bin', LC_ALL: 'C', LANG: 'C' };
  if (win && !fs.existsSync(path.win32.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'))) return { error: "Windows' PowerShell wasn't found at its own path" };
  const r = await listing({ timeoutMs: wait, platform, env: own, script: WMI_LIST });
  if (r.late || r.error) return r;
  return { chain: chainIn(r.list, pid) };
}

// The recorded process a chain runs under: { entry, dir } or null
export function underAgent(chain, records) {
  for (const p of chain) {
    for (const rec of records) {
      const entry = rec.agents.find((a) => a.pid === p.pid && p.start <= Date.parse(a.at) + START_SLACK_MS);
      if (entry) return { entry, dir: rec.dir };
    }
  }
  return null;
}

const WHAT = { worker: "task {task}'s worker", verify: "task {task}'s verify", check: 'a check the hub runs (nextlevel verify)', 'git-job': "one of the hub's git jobs" };
const what = (entry) => WHAT[entry.kind].replace('{task}', entry.task || '?');
function logRefusal(dir, line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, REFUSED), `${JSON.stringify(line)}\n`);
  } catch {
    // the refusal stands without its line
  }
}

// Why `nextlevel <cmd> <rest>` doesn't run here, or '' when it may. Logs a refusal in the guard's refused.jsonl.
export async function ancestryRefusal(cmd, rest = [], { toolRoot, env = process.env, pid = process.pid, platform = process.platform, listing } = {}) {
  if (looksOnly(cmd, rest)) return '';
  const installed = installedTool(toolRoot);
  const home = agentsHome({ toolRoot, installed });
  const records = allRecords(home);
  if (!records.some((r) => r.agents.length)) return '';
  const shown = `nextlevel ${[cmd, ...rest.slice(0, 1)].filter(Boolean).join(' ') || '(the menu)'}`;
  const own = await ownChain({ pid, platform, env, installed, listing });
  if (own.chain) {
    const hit = underAgent(own.chain, records);
    if (!hit) return '';
    logRefusal(hit.dir, { at: new Date().toISOString(), kind: hit.entry.kind, task: hit.entry.task || null, job: hit.entry.job || null, command: cmd || 'menu' });
    const tail = hit.entry.kind === 'worker' || hit.entry.kind === 'verify' ? "workers don't ask the hub for anything; put it in your report (RESULT.md)" : 'what the hub runs as the owner asks nothing of nextlevel';
    return `${shown}: refused. This command runs under ${what(hit.entry)}: ${tail}. Nothing was done.`;
  }
  // No snapshot: only a live session of the orchestrator's runs, or what the hub itself starts (its own token, which the
  // command takes out of its environment at once: nothing it starts inherits it)
  const tokens = [env.NEXTLEVEL_SESSION_TOKEN, env.NEXTLEVEL_HUB_TOKEN].filter(Boolean).map(hashOf);
  if (tokens.length && records.some((r) => r.sessions.some((s) => tokens.includes(s.hash)))) return '';
  for (const r of records) logRefusal(r.dir, { at: new Date().toISOString(), kind: 'unlisted', task: null, command: cmd || 'menu', why: own.late ? 'late' : String(own.error || '') });
  return `${shown}: refused. nextlevel couldn't list this PC's processes (${own.late ? 'no answer in time' : own.error}) while a worker or a check runs, so it can't tell this command isn't one of theirs. Nothing was done; try again in a moment.`;
}

// The hub's read of the refusals for a task since `since` (ISO): [{ at, kind, command }]
export function refusalsFor(root, task, since, { home } = {}) {
  let text = '';
  try {
    text = fs.readFileSync(path.join(guardDir(root, home), REFUSED), 'utf8');
  } catch {
    return [];
  }
  const from = Date.parse(since) || 0;
  const out = [];
  for (const line of text.split('\n')) {
    try {
      const r = JSON.parse(line);
      if (r.task === task && Date.parse(r.at) >= from) out.push({ at: r.at, kind: r.kind, command: String(r.command).slice(0, 40) });
    } catch {
      // a line cut short
    }
  }
  return out.slice(-20);
}
