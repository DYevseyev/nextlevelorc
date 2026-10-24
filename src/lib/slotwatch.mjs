// What a worker did outside its slot, read from its own log after the attempt (17 October: an Antigravity
// worker's file tool wrote C:\Users\User\nextlevel-task\PROGRESS.md, a path it typed wrong, outside its slot). A worker
// runs as the owner's Windows user and agy's file tool writes wherever that user can, so nothing stops it (FR-017 part 2B
// would); this says it, after the fact: the files a worker wrote or edited outside its slot, and the git commands or
// folder changes it aimed at another folder. By pattern, from the engine's own steps (agy's stream-json, Claude Code's
// stream-json, Codex's --json): a command written another way can be missed, and nothing is stopped by it. Pure.
import path from 'node:path';

// One JSON object per line; null for a line that isn't one
const json = (line) => {
  const t = String(line || '').trim();
  if (!t.startsWith('{')) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
};
const AGY_WRITES = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content', 'notebook_edit', 'sed_file']);
const CLAUDE_WRITES = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// What a log says the worker did: { files: [paths written or edited], commands: [command lines], runs: [{ command, cwd,
// carry }], cwd }; files and commands each once, in order; runs every command in order (`cwd`: the folder agy says it ran
// in; `carry`: Claude Code's Bash, whose folder stays where a `cd` left it for its next command); `cwd`: the folder the
// engine's session says it started in (agy's and Claude Code's init), '' when it says none
export function workerActions(text) {
  let cwd = '';
  const files = [];
  const commands = [];
  const runs = [];
  const add = (list, v) => {
    const s = String(v || '').trim();
    if (s && !list.includes(s)) list.push(s);
  };
  const run = (command, cwd = '', carry = false) => {
    const c = String(command || '').trim();
    if (!c) return;
    add(commands, c);
    runs.push({ command: c, cwd: String(cwd || '').trim(), carry });
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = json(line);
    if (!v) continue;
    // The session's own folder: agy's init event, Claude Code's system init
    const at = v.event === 'init' ? v.init?.cwd : v.type === 'system' && v.subtype === 'init' ? v.cwd : '';
    if (typeof at === 'string' && at.trim()) cwd = at.trim();
    // Antigravity: a tool step (ACTIVE, then DONE: either names it)
    const s = v.step_update;
    if (s?.step_type === 'tool') {
      const name = String(s.tool_name || s.tool_info?.name || '');
      const p = s.tool_info?.parameters || {};
      if (AGY_WRITES.has(name)) add(files, p.TargetFile || p.AbsolutePath || p.File || p.Path);
      if (name === 'run_command') run(p.CommandLine || p.Command, p.Cwd);
      continue;
    }
    // Claude Code: an assistant message's tool_use
    if (v.type === 'assistant' && Array.isArray(v.message?.content)) {
      for (const c of v.message.content) {
        if (c?.type !== 'tool_use') continue;
        if (CLAUDE_WRITES.has(c.name)) add(files, c.input?.file_path || c.input?.notebook_path);
        if (c.name === 'Bash') run(c.input?.command, '', true);
      }
      continue;
    }
    // Codex: an item's command, or the files a change touched
    const it = v.item;
    if (it?.type === 'command_execution') run(it.command);
    if (it?.type === 'file_change' && Array.isArray(it.changes)) for (const c of it.changes) add(files, c?.path);
  }
  return { files, commands, runs, cwd };
}

// Whether `p` (as a worker named it, from `cwd`) is outside every folder in `inside`: Windows' names compared as Windows
// does (either slash, any case)
const norm = (p) => path.win32.normalize(String(p).replace(/\//g, '\\')).replace(/\\+$/, '').toLowerCase();
const isAbs = (p) => /^[a-z]:[\\/]/i.test(p) || /^[\\/]/.test(p) || p.startsWith('~');
// The full name of `p` as a worker named it from `cwd` (Git Bash's /c/... is C:\... when the slot is a Windows folder:
// Claude Code's Bash on Windows)
function fullName(p, cwd) {
  let raw = String(p).trim().replace(/^["']|["']$/g, '');
  if (/^[a-z]:[\\/]/i.test(cwd)) raw = raw.replace(/^\/([a-z])(?=\/)/i, '$1:');
  return isAbs(raw) ? raw : path.win32.join(cwd, raw);
}
function outside(p, cwd, inside, never = []) {
  if (!String(p).trim().replace(/^["']|["']$/g, '')) return false;
  const f = norm(fullName(p, cwd));
  const within = (d) => {
    const b = norm(d);
    return f === b || f.startsWith(`${b}\\`);
  };
  // (its own slot is always fine; the project and the other slots never are, even inside an allowed folder)
  if (within(inside[0])) return false;
  return never.some(within) || !inside.some(within);
}

// The folders a command line aims at: git -C <p>, --git-dir=<p>, --work-tree=<p>, cd <p>, Set-Location <p>, pushd <p>
// (git -C by its words, not one pattern: a pattern for it backtracks on a long run of spaces, which a worker writes)
const WORD = /"[^"]*"|'[^']*'|[;&|]+|[^\s;&|"']+/g;
const unquote = (s) => s.replace(/^["']|["']$/g, '');
// (a quoted word with spaces is a command of its own too: bash -lc 'git -C ...', pwsh -Command "git -C ...")
function gitDashC(cmd, depth = 0) {
  const out = [];
  if (depth > 2) return out;
  let inGit = false;
  const words = cmd.match(WORD) || [];
  for (let i = 0; i < words.length; i++) {
    const w = unquote(words[i]);
    if (/^[;&|]+$/.test(words[i])) inGit = false;
    else if (/(?:^|[\\/])git(?:\.exe)?$/i.test(w)) inGit = true;
    else if (inGit && w === '-C' && i + 1 < words.length) out.push(words[++i]);
    else if (/\s/.test(w) && /^["']/.test(words[i])) out.push(...gitDashC(w, depth + 1));
  }
  return out;
}
const GIT_DIRS = /--(?:git-dir|work-tree)[=\s]("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
// (at the start, after ; & | or (, or as the first word of a quoted command: pwsh -Command "Set-Location ..."; cmd's
// cd /d <folder>)
const CDS = /(?:^|[;&|("']\s*)(?:cd|chdir|Set-Location|sl|pushd|Push-Location)\s+(?:-(?:Path|LiteralPath)\s+|\/d\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/gi;
// The folders a command line aims at outside the slot, from `start`, where it began: git -C, --git-dir and --work-tree
// from there, each cd from where the one before it left it (`cd web && npm test && cd ..` stays in the slot); and where
// it ended (the next command of Claude Code's Bash starts there). The first 8 KB of a command: the worker writes it.
function aimsOf(cmd, start, inside, never) {
  const c = String(cmd).slice(0, 8192);
  const aims = [...gitDashC(c), ...[...c.matchAll(GIT_DIRS)].map((m) => m[1])].map(unquote).filter((d) => outside(d, start, inside, never));
  let cur = start;
  for (const m of c.matchAll(CDS)) {
    const d = unquote(m[1]);
    if (d === '-') continue; // (`cd -` goes back where it was)
    if (outside(d, cur, inside, never)) aims.push(d);
    else cur = fullName(d, cur);
  }
  return { aims: [...new Set(aims)], end: cur };
}
const MAX_COMMANDS = 4000; // (agy names a command twice: ACTIVE, then DONE)

// What a worker did outside its slot: [{ kind: 'file' | 'command', what (the path or the command line), aims (a command's
// folder) }]. `slot`: its folder; `allowed`: other folders a worker may write in (the system's temporary folder, the engine's
// own scratch); `never`: folders that count as outside even inside an allowed one (the project, the other slots).
export function outsideSlot(text, { slot, allowed = [], never = [] }) {
  const inside = [slot, ...allowed].filter(Boolean);
  const { files, runs, cwd } = workerActions(text);
  // (a relative name is read from the folder the session says it started in, else from the slot, where the hub starts it:
  // a session that started elsewhere has its relative writes and folders said as outside)
  const base = cwd ? fullName(cwd, slot) : slot;
  const out = [];
  for (const f of files) if (outside(f, base, inside, never)) out.push({ kind: 'file', what: f });
  let carried = base; // (where Claude Code's Bash is: back where it started when a command leaves the slot, as Claude Code does)
  for (const r of runs.slice(0, MAX_COMMANDS)) {
    // (agy's own folder for a command, when it names one, is where it ran: outside the slot is said as such)
    const cwdOut = r.cwd && outside(r.cwd, base, inside, never);
    const start = r.carry ? carried : r.cwd && !cwdOut ? fullName(r.cwd, base) : base;
    const { aims, end } = aimsOf(r.command, start, inside, never);
    if (r.carry) carried = aims.length ? base : end;
    if (cwdOut) aims.unshift(r.cwd);
    if (aims.length && !out.some((x) => x.kind === 'command' && x.what === r.command)) out.push({ kind: 'command', what: r.command, aims: aims.join(', ') });
  }
  return out;
}

// In one line, for the card, the phone and hub.log
export const outsideWords = (found) =>
  found
    .slice(0, 5)
    .map((x) => (x.kind === 'file' ? `wrote ${x.what}` : `ran \`${x.what}\` (in ${x.aims})`))
    .join('; ') + (found.length > 5 ? `; and ${found.length - 5} more` : '');

// A path or command line cut for the card, the phone and hub.log (after redaction: a value cut in two isn't found)
export const shorten = (s, n = 300) => (String(s).length > n ? `${String(s).slice(0, n - 1)}…` : String(s));
