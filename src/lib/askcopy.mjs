// The assistant on Antigravity (docs/design/antigravity-roles.md, part B). Nothing of agy's own keeps it read-only (on
// 1.4.0 its plan mode let its edit tool write, and its sandbox doesn't cover that tool), so it answers in a copy of the
// project made for the question and thrown away after: what it writes lands there. The copy has the project's history
// (a clone that shares the real one's objects, `--shared`, no remotes) and its working tree as it is on disk, tracked
// and untracked but not ignored, never a .env file. agy runs there as nextlevel's agent (`nextlevel-assistant`: none of
// the owner's MCP servers or add-ons), with the push block and NEXTLEVEL_READ_ONLY=1; its nextlevel commands read the real
// project, only looking (NEXTLEVEL_READ_ROOT, honoured only under NEXTLEVEL_READ_ONLY=1: cli.mjs). And a tripwire: the real
// project's HEAD, refs, git status and protected files before and after the question, so a change that lands there
// anyway (it runs as the owner's Windows user, and can write outside its folder) is said, never silently kept.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from './gitlock.mjs';
import { scanProtected } from './guard.mjs';
import { BUILT_IN } from './protect.mjs';
import { roleRun } from './rolespec.mjs';
import { isEnvFile } from './secrets.mjs';
import { writeSlotFile } from './slotfiles.mjs';

export const ASK_PREFIX = 'nextlevel-ask-';
export const QUESTION_FILE = ['.nextlevel-ask', 'QUESTION.md'];
const git = (cwd, args, input) => {
  const r = spawnSync('git', args, { cwd, env: readEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, input });
  return { ok: r.status === 0, out: String(r.stdout || ''), err: String(r.stderr || r.error?.message || '').trim() };
};
// (a folder name of the project's own, so the hub knows its leftovers: the project's folder name, cleaned, and a hash)
const tag = (root) => `${path.basename(root).replace(/[^\w.-]+/g, '-').slice(0, 30)}-${createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 8)}`;

// The copy: { dir, files, seconds } (files: how many were copied); throws with git's words when it can't be made
export function makeAskCopy(root, { tmp = os.tmpdir() } = {}) {
  const started = Date.now();
  const dir = fs.mkdtempSync(path.join(tmp, `${ASK_PREFIX}${tag(root)}-`));
  try {
    const clone = git(tmp, ['clone', '-q', '--shared', '--no-checkout', '--', root, dir]);
    if (!clone.ok) throw new Error(`git couldn't make the assistant's copy of the project: ${clone.err}`);
    git(dir, ['remote', 'remove', 'origin']); // (no remote at all: the clone's origin is the real project)
    if (git(dir, ['rev-parse', '--verify', '--quiet', 'HEAD']).ok) git(dir, ['read-tree', 'HEAD']);
    const list = git(root, ['ls-files', '-z', '-co', '--exclude-standard']);
    if (!list.ok) throw new Error(`git couldn't list the project's files: ${list.err}`);
    let files = 0;
    for (const rel of [...new Set(list.out.split('\0').filter(Boolean))]) {
      if (isEnvFile(rel)) continue; // (never a .env file, whatever git thinks of it)
      const from = path.join(root, rel);
      let st;
      try {
        st = fs.lstatSync(from);
      } catch {
        continue; // (deleted on disk)
      }
      if (!st.isFile()) continue; // (a link, a folder that is a submodule: not copied)
      const to = path.join(dir, rel);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
      files++;
    }
    const exclude = path.join(dir, '.git', 'info', 'exclude');
    fs.mkdirSync(path.dirname(exclude), { recursive: true });
    fs.appendFileSync(exclude, `\n/${QUESTION_FILE[0]}/\n/.agents/agents/nextlevel-assistant.md\n`);
    return { dir, files, seconds: Math.round((Date.now() - started) / 100) / 10 };
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}
// An answer's names of files in `roots` (the copy it answered in, the project) as paths from the project's top: the copy
// is removed after the answer, so a link into it is dead (17 October: agy cited file:///.../Temp/
// nextlevel-ask-.../BRIEF.md), and the dashboard's page opens no file:/// link anyway. Matched as Windows reads a name
// (either slash, any case), with or without file:///, its characters as they are or percent-encoded; only where a name
// starts, never inside a longer one (macOS's /private/var/... holds /var/..., a web address can hold a path), the
// longest root first. Pure.
export function projectRelative(text, roots = []) {
  let t = String(text ?? '');
  for (const root of [...new Set(roots.filter(Boolean).map(String))].sort((a, b) => b.length - a.length)) {
    const parts = String(root).split(/[\\/]+/).filter(Boolean);
    if (!parts.length) continue;
    // (a letter in either case; any other character as it is or percent-encoded, as a file URL has it: a space as %20, and
    // the ~ of a Windows short name, C:\Users\RUNNER~1, as %7E, which Node's pathToFileURL encodes)
    const hex = (ch) => [...Buffer.from(ch)].map((b) => `%${[...b.toString(16).padStart(2, '0')].map((c) => (/[a-f]/.test(c) ? `[${c}${c.toUpperCase()}]` : c)).join('')}`).join('');
    const esc = (s) => [...s].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : /[0-9]/.test(ch) ? ch : `(?:${ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}|${hex(ch)})`)).join('');
    const lead = /^[a-z]:$/i.test(parts[0]) ? '' : '[\\\\/]'; // (a drive, or a POSIX root)
    const re = new RegExp(`(?<![\\w.%:/\\\\-])(?:file:///?)?${lead}${parts.map(esc).join('[\\\\/]+')}(?:([\\\\/]+)|(?![\\w.-]))`, 'g');
    t = t.replace(re, (_, sep) => (sep ? '' : '.'));
  }
  return t;
}

export const removeAskCopy = (dir) => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

// Copies a hub left behind (a question stopped half-way), older than an hour, for this project: removed. -> how many
export function sweepAskCopies(root, { tmp = os.tmpdir(), now = Date.now() } = {}) {
  let n = 0;
  const mine = `${ASK_PREFIX}${tag(root)}-`;
  for (const name of fs.existsSync(tmp) ? fs.readdirSync(tmp) : []) {
    if (!name.startsWith(mine)) continue;
    const dir = path.join(tmp, name);
    try {
      if (now - fs.statSync(dir).mtimeMs < 3_600_000) continue;
      removeAskCopy(dir);
      n++;
    } catch {
      // in use, or gone
    }
  }
  return n;
}

// The assistant's run on agy in the copy: { args, env, problem } (lib/rolespec.mjs roleRun, its agent file written into
// the copy). `env`: the assistant's environment (no .env values, hub.mjs askContext), `root`: the real project.
export function agyAssistantRun({ copy, root, profile, prompt, env, engineArgs = [], version = '', timeoutMin = 10 }) {
  // (the push block is built for the real project's remotes: the copy has none, and a push from the real project, git -C,
  // is the one that would matter)
  const run = roleRun({ profile, role: 'assistant', mode: 'headless', prompt, timeoutMin, engineArgs, version, env: { ...env, NEXTLEVEL_READ_ROOT: path.resolve(root) }, root });
  if (run.problem) return { problem: run.problem };
  for (const f of run.files) if (!writeSlotFile(copy, f.path, f.text)) return { problem: `its agent file ${f.path.join('/')} can't be written in the copy` };
  return { args: run.args, env: run.env };
}

// ---------- the tripwire on the real project ----------
const sha = (s) => createHash('sha256').update(s).digest('hex');
// What the assistant must not change, as hashes: { head, refs, status, protected: { rel: hash } }
export function projectSnapshot(root, entries = BUILT_IN) {
  const head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).out.trim();
  const refs = sha(git(root, ['for-each-ref', '--format=%(refname) %(objectname)']).out);
  const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).out;
  const prot = {};
  for (const rel of scanProtected(root, entries).keys()) {
    const abs = path.join(root, rel);
    try {
      const st = fs.lstatSync(abs);
      prot[rel] = st.isSymbolicLink() ? `link:${fs.readlinkSync(abs)}` : st.isFile() ? sha(fs.readFileSync(abs)) : 'folder';
    } catch {
      prot[rel] = 'gone';
    }
  }
  return { head, refs, status, statusHash: sha(status), protected: prot };
}
// What changed between two snapshots, in words: [] when nothing did
export function projectChanges(before, after) {
  const out = [];
  if (before.head !== after.head) out.push(`HEAD moved (${before.head.slice(0, 7) || 'none'} -> ${after.head.slice(0, 7) || 'none'})`);
  else if (before.refs !== after.refs) out.push('a branch or a tag moved');
  if (before.statusHash !== after.statusHash) {
    const names = (s) => new Set(s.split('\0').filter(Boolean).map((l) => l.slice(3)));
    const b = names(before.status);
    const changed = [...names(after.status)].filter((n) => !b.has(n));
    out.push(changed.length ? `files changed on disk: ${changed.slice(0, 8).join(', ')}${changed.length > 8 ? ', ...' : ''}` : 'what git sees as changed on disk is different');
  }
  const prot = [...new Set([...Object.keys(before.protected), ...Object.keys(after.protected)])].filter((rel) => before.protected[rel] !== after.protected[rel]);
  if (prot.length) out.push(`protected files changed: ${prot.slice(0, 8).join(', ')}${prot.length > 8 ? ', ...' : ''}`);
  return out;
}
