// The look after each attempt (FR-017 part 2B, 2B-1a3; docs/design/FR-017-part2B.md 3.4). nextlevel's own code and the
// owner's global git settings run as the owner and carry no signature, so a worker that changed them would be obeyed by
// the next command. The hub can't stop that in layer 1; it looks after each attempt and at its start, compared with
// the last look: the files of the running version's folder and of the tool's clone (`git status`, run so that git runs
// nothing of what it looks at), the clone's origin, the files of ~/.nextlevel/bin (the launcher and the command), and
// the global and system git settings that make git run a program or send a push elsewhere (gitguard's list), with the
// files of a global hooks folder. A change stops dispatch until the owner's Seen on the dashboard (the hub's side:
// "the look after each attempt" in hub.mjs). The last look lives in the guard's folder, outside every project.
import fs from 'node:fs';
import path from 'node:path';
import { runsOrRedirects } from './gitguard.mjs';
import { sha } from './guard.mjs';

export const LOOK = 'tool-look.json';

// The parts of a look, in the words a card uses
const LABEL = {
  version: "nextlevel's own files (the version that runs)",
  clone: "the files of nextlevel's clone",
  origin: "where nextlevel's clone updates from",
  bin: 'the nextlevel command and its launcher (~/.nextlevel/bin)',
  gitglobal: 'your global git settings that run a program or send a push elsewhere',
  globalhooks: 'the hooks in your global hooks folder',
};
export const partLabel = (name) => LABEL[name] || name;

// `git status --porcelain` lines as a part: its key and the paths it names (at most 8 in words)
function statusPart(root, out) {
  const lines = String(out || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter(Boolean)
    .sort();
  return { root, key: sha(JSON.stringify(lines)), items: lines.slice(0, 40) };
}
// `git config --<scope> --null --list`: "key LF value NUL" per setting -> [[scope, key, value]] that runs or redirects
function configEntries(scope, out) {
  const list = [];
  for (const kv of String(out || '').split('\0')) {
    if (!kv) continue;
    const nl = kv.indexOf('\n');
    const key = nl < 0 ? kv : kv.slice(0, nl);
    if (runsOrRedirects(key)) list.push([scope, key, nl < 0 ? null : kv.slice(nl + 1)]);
  }
  return list;
}
// The files of a folder (not its subfolders' contents: a hooks folder and ~/.nextlevel/bin are flat): { name: hash }
function folderFiles(dir) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.sort()) {
    const f = path.join(dir, name);
    try {
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink()) out[name] = `link:${sha(fs.readlinkSync(f))}`;
      else if (st.isFile()) out[name] = sha(fs.readFileSync(f));
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

// One look. `git(args, cwd)` -> { ok, out } runs git so that it runs nothing it looks at (the hub gives it
// core.fsmonitor off, an empty hooks folder and no optional locks); `version`: the running version's folder; `clone`:
// the tool's clone when it is another folder (an installed tool), else ''; `bin`: ~/.nextlevel/bin; `home`: the home a
// global hooks folder's ~ means. A part that can't be
// read is { unread: why } and is compared as such (a part that becomes unreadable is a change too).
export function takeLook({ git, version, clone = '', bin, home, at = new Date().toISOString() }) {
  const parts = {};
  const status = (root) => {
    const r = git(['status', '--porcelain=v1', '--untracked-files=normal', '--ignored=no'], root);
    return r.ok ? statusPart(root, r.out) : { root, unread: 'git status failed' };
  };
  parts.version = status(version);
  if (clone) {
    parts.clone = status(clone);
    const o = git(['config', '--get', 'remote.origin.url'], clone);
    parts.origin = { key: sha(o.ok ? o.out.trim() : ''), items: [o.ok ? o.out.trim() : '(none)'] };
  }
  const files = folderFiles(bin);
  parts.bin = { key: sha(JSON.stringify(files)), items: Object.keys(files) };
  const entries = [];
  for (const scope of ['global', 'system']) {
    const r = git(['config', `--${scope}`, '--null', '--list'], version);
    if (r.ok) entries.push(...configEntries(scope, r.out));
  }
  entries.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  parts.gitglobal = { key: sha(JSON.stringify(entries)), items: entries.map(([s, k, v]) => `${k} = ${v === null ? '(no value)' : String(v).slice(0, 200)} (${s})`) };
  // the files a global hooks folder holds: git runs them in every repository, the hub's too
  const hooksPath = entries.find(([, k]) => k.toLowerCase() === 'core.hookspath');
  if (hooksPath && hooksPath[2]) {
    const dir = String(hooksPath[2]).replace(/^~(?=[\\/]|$)/, home || '~');
    const hooks = folderFiles(dir);
    parts.globalhooks = { key: sha(JSON.stringify(hooks)), items: Object.keys(hooks).map((n) => `${dir}${path.sep}${n}`) };
  }
  return { at, parts };
}

// What changed from the last look `a` to `b`: [{ part, label, items }] (items: what the new look names). A part whose
// folder is another one (the hub runs another version after an update) starts again from what it is now; a part one of
// them doesn't have is compared only when both do.
export function diffLook(a, b) {
  if (!a?.parts || !b?.parts) return [];
  const out = [];
  for (const [name, now] of Object.entries(b.parts)) {
    const was = a.parts[name];
    if (!was) continue;
    if (was.root && now.root && was.root !== now.root) continue;
    if (was.key === now.key && was.unread === now.unread) continue;
    const before = new Set(was.items || []);
    const after = now.unread ? [`can't be read now (${now.unread})`] : (now.items || []).filter((x) => !before.has(x));
    const gone = now.unread ? [] : (was.items || []).filter((x) => !(now.items || []).includes(x));
    out.push({ part: name, label: partLabel(name), items: [...after, ...gone.map((x) => `no longer: ${x}`)].slice(0, 12) });
  }
  return out;
}

// A change in plain words, one line per part
export const changeWords = (changes) => changes.map((c) => `${c.label}${c.items.length ? `: ${c.items.slice(0, 6).join('; ')}${c.items.length > 6 ? '; ...' : ''}` : ' changed'}`);

// The record in the guard's folder: { base: look, change: { at, changes, tasks, when } | null }, read through a shape check
export function readLookRecord(file) {
  let r = null;
  try {
    r = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return { base: null, change: null };
  }
  const base = r?.base && typeof r.base === 'object' && r.base.parts && typeof r.base.parts === 'object' ? r.base : null;
  const c = r?.change;
  const change =
    c && typeof c === 'object' && Array.isArray(c.changes)
      ? {
          at: String(c.at || ''),
          when: String(c.when || ''),
          tasks: (Array.isArray(c.tasks) ? c.tasks : []).map(String).slice(0, 20),
          changes: c.changes.filter((x) => x && typeof x === 'object').map((x) => ({ part: String(x.part || ''), label: partLabel(String(x.part || '')), items: (Array.isArray(x.items) ? x.items : []).map(String).slice(0, 12) })),
        }
      : null;
  return { base, change };
}
export function writeLookRecord(file, record) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record, null, 2));
  fs.renameSync(tmp, file);
}
