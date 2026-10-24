// Git's own hooks and settings (the guard): what makes git run a program or send a push somewhere else, for the
// project and each of its worktrees (the workers' slots included, whose settings keep them from pushing, FR-003). The
// hub records them in ~/.nextlevel/guard/<project>/git.json and compares before its git work; a change it didn't make
// itself stops all git work until the owner decides on the dashboard (hub.mjs gitGuard). The owner's global and the
// system's settings are FR-013's, not these.
import fs from 'node:fs';
import path from 'node:path';
import { sha } from './guard.mjs';
import { visible } from './protect.mjs';

// Settings that make git run a program or send a push elsewhere (names as git lists them, compared lowercased; a
// subsection is any text)
export const RUNS_OR_REDIRECTS = [
  /^core\.(hookspath|fsmonitor|sshcommand|editor|pager|askpass|gitproxy|worktree|alternaterefscommand)$/,
  /^(sequence\.editor|diff\.external|gpg\.program|interactive\.difffilter|web\.browser|ssh\.variant|uploadpack\.packobjectshook|remote\.pushdefault|extensions\.worktreeconfig)$/,
  /^gpg\.[^.]+\.program$/,
  /^credential\.(.+\.)?helper$/,
  /^diff\..+\.(textconv|command)$/,
  /^merge\..+\.driver$/,
  /^filter\..+\.(clean|smudge|process)$/,
  /^(difftool|mergetool|browser|man)\..+\.(cmd|path)$/,
  /^pager\./,
  /^alias\./,
  /^include\.path$/,
  /^includeif\..+\.path$/,
  /^remote\..+\.(url|pushurl|receivepack|uploadpack|proxy|vcs|pushdefault)$/,
  /^url\..+\.(insteadof|pushinsteadof)$/,
  /^branch\..+\.pushremote$/,
  /^https?\.(.+\.)?proxy$/,
  /^protocol\./,
  /^submodule\..+\.update$/,
  /^sendemail\./,
  /^lfs\.(customtransfer\.|standalonetransferagent|.+\.path$)/,
];
// (a name longer than any real one counts too: it is recorded and a change to it gets a card, and no pattern runs on it)
export const runsOrRedirects = (key) => String(key).length > 512 || RUNS_OR_REDIRECTS.some((re) => re.test(String(key).toLowerCase()));

const slash = (p) => String(p).replace(/\\/g, '/');
// A folder as the guard names it: its real path (a short name, a link, another case on Windows is the same folder)
export function folderName(p) {
  let r = p;
  try {
    r = fs.realpathSync.native(p);
  } catch {
    // named as given
  }
  return slash(path.resolve(r));
}
export const same = (a, b) => (process.platform === 'win32' ? slash(a).toLowerCase() === slash(b).toLowerCase() : slash(a) === slash(b));
const under = (child, parent) => {
  const r = path.relative(parent, child);
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
};

// `git config --list --show-scope --show-origin -z`: "scope NUL origin NUL key LF value NUL" per setting (a key with
// no value has no LF). -> [{ scope, file, key, value }] for the project's own scopes (local, worktree)
export function parseConfigList(out) {
  const t = String(out || '').split('\0');
  const list = [];
  for (let i = 0; i + 2 < t.length; i += 3) {
    const [scope, origin, kv] = [t[i], t[i + 1], t[i + 2]];
    if (!['local', 'worktree'].includes(scope)) continue;
    const nl = kv.indexOf('\n');
    const key = nl < 0 ? kv : kv.slice(0, nl);
    const value = nl < 0 ? null : kv.slice(nl + 1);
    list.push({ scope, file: origin.startsWith('file:') ? slash(origin.slice(5)) : origin, key, value });
  }
  return list;
}

// The worktrees of the project: [{ dir, main }] (git worktree list --porcelain)
export function parseWorktrees(out) {
  const list = [];
  for (const block of String(out || '').split(/\r?\n\r?\n/)) {
    const m = block.match(/^worktree (.+)$/m);
    if (m) list.push({ dir: m[1].trim(), prunable: /^prunable\b/m.test(block) });
  }
  return list.map((w, i) => ({ ...w, main: i === 0 }));
}

// The hooks in a folder: { name: { hash, size, link? } } (a sample isn't one), their content kept by `keep(buf)`
export function hookFiles(dir, keep = () => {}) {
  const out = {};
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names.filter((n) => !n.endsWith('.sample'))) {
    const f = path.join(dir, name);
    try {
      const st = fs.lstatSync(f);
      if (st.isSymbolicLink()) out[name] = { hash: `link:${sha(fs.readlinkSync(f))}`, size: 0, link: fs.readlinkSync(f) };
      else if (st.isFile()) {
        const buf = fs.readFileSync(f);
        keep(buf);
        out[name] = { hash: sha(buf), size: buf.length };
      }
    } catch {
      // gone meanwhile
    }
  }
  return out;
}

// Everything the guard records of git: { worktrees: [dir], config: [{ where, scope, file, key, value }], hooks: { dir:
// files } }. `git(args, cwd)` -> { ok, out }; `slotHooks`: the folder the hub writes the slots' hooks to; `keep`: keeps a
// hook's content (to put it back). Where: 'main' for the main checkout (its local and worktree settings), a worktree's
// folder for the others (their worktree settings; local ones are the main checkout's).
export function readGitState({ root, git, slotHooks = '', hookDirs = [], keep }) {
  const trees = parseWorktrees(git(['worktree', 'list', '--porcelain'], root).out)
    .filter((w) => !w.prunable && fs.existsSync(w.dir))
    .map((w) => ({ ...w, dir: folderName(w.dir) }));
  const config = [];
  const hooks = {};
  const addHooks = (cwd) => {
    const r = git(['rev-parse', '--path-format=absolute', '--git-path', 'hooks'], cwd);
    const dir = r.ok ? folderName(r.out.trim()) : '';
    // a hooks folder in a working tree (core.hooksPath = .husky) is made of protected files: the protected-paths guard
    // has it. (.git/hooks is in the main checkout's folder, but not in its working tree.)
    if (!dir || trees.some((w) => under(dir, w.dir) && !under(dir, path.join(w.dir, '.git')))) return;
    if (!Object.keys(hooks).some((d) => same(d, dir))) hooks[dir] = hookFiles(dir, keep);
  };
  // the folders always looked at, whichever one git uses now (the common .git/hooks: core.hooksPath may point back)
  for (const d of hookDirs.map(folderName)) if (!Object.keys(hooks).some((x) => same(x, d))) hooks[d] = hookFiles(d, keep);
  for (const w of trees.length ? trees : [{ dir: folderName(root), main: true }]) {
    const where = w.main ? 'main' : w.dir;
    for (const e of parseConfigList(git(['config', '--list', '--show-scope', '--show-origin', '-z'], w.dir).out)) {
      if (!runsOrRedirects(e.key)) continue;
      if (!w.main && e.scope !== 'worktree') continue; // (the shared ones are the main checkout's)
      // (git names a checkout's own file from the folder it ran in: ".git/config")
      const onDisk = !!e.file && (path.isAbsolute(e.file) || !e.file.includes(':')); // (not "command line:" and the like)
      const file = onDisk ? folderName(path.resolve(w.dir, e.file)) : e.file;
      config.push({ where, ...e, file });
    }
    addHooks(w.dir);
  }
  const slotDir = slotHooks && folderName(slotHooks);
  if (slotDir && !Object.keys(hooks).some((d) => same(d, slotDir))) hooks[slotDir] = hookFiles(slotDir, keep);
  return { worktrees: trees.map((w) => w.dir), config, hooks };
}

const entryText = (e) => `${e.where}|${e.scope}|${e.file}|${e.key}|${e.value ?? ''}`;
// What changed from the recorded state `a` to `b`. A worktree that is gone takes its settings with it (nothing runs
// there any more); a new one is compared with nothing, so its settings are changes. -> { config: { added, removed },
// hooks: [{ dir, name, before, after }] } and `empty`
export function diffGitState(a, b) {
  const gone = new Set((a.worktrees || []).filter((w) => !(b.worktrees || []).some((x) => same(x, w))).map((w) => w.toLowerCase()));
  const keep = (e) => e.where === 'main' || !gone.has(String(e.where).toLowerCase());
  const was = new Map(a.config.filter(keep).map((e) => [entryText(e), e]));
  const now = new Map(b.config.map((e) => [entryText(e), e]));
  const added = [...now.keys()].filter((k) => !was.has(k)).map((k) => now.get(k));
  const removed = [...was.keys()].filter((k) => !now.has(k)).map((k) => was.get(k));
  const hooks = [];
  for (const dir of new Set([...Object.keys(a.hooks || {}), ...Object.keys(b.hooks || {})])) {
    const x = a.hooks?.[dir] || {};
    const y = b.hooks?.[dir] || {};
    for (const name of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (x[name]?.hash !== y[name]?.hash) hooks.push({ dir, name, before: x[name] || null, after: y[name] || null });
    }
  }
  return { config: { added, removed }, hooks, empty: !added.length && !removed.length && !hooks.length };
}

const whereText = (w) => (w === 'main' ? "the project's settings" : `the settings of the worktree ${w}`);
// The change in plain words (from code): each setting added or removed, with where it is, and each hook
export function describeGitChange(d, { text = () => null } = {}) {
  const out = [];
  const val = (e) => (e.value === null ? '(no value)' : visible(e.value).slice(0, 300));
  for (const e of d.config.added) out.push(`adds ${e.key} = ${val(e)} (${whereText(e.where)}, ${e.file})`);
  for (const e of d.config.removed) out.push(`removes ${e.key} = ${val(e)} (${whereText(e.where)}, ${e.file})`);
  for (const h of d.hooks) {
    const label = `the ${h.name} hook in ${h.dir}`;
    if (!h.before) out.push(`adds ${label}: git runs it`);
    else if (!h.after) out.push(`removes ${label}`);
    else out.push(`changes ${label}`);
    const now = h.after ? text(h.after) : null;
    if (now) for (const l of String(now).split(/\r?\n/).filter((x) => x.trim() && !/^\s*#/.test(x)).slice(0, 12)) out.push(`  would run: ${visible(l.trim()).slice(0, 240)}`);
  }
  return out;
}

// A state's key: the same settings and hooks give the same key, whatever order git and the folder listed them in
export function stateKey(s) {
  const config = [...(s.config || [])].map(entryText).sort();
  const hooks = Object.keys(s.hooks || {})
    .sort()
    .map((d) => [d.toLowerCase(), Object.keys(s.hooks[d]).sort().map((n) => [n, s.hooks[d][n].hash])]);
  return sha(JSON.stringify([config, hooks]));
}
