// The guard's state, kept outside the project where the orchestrator's sandbox can't write it: ~/.nextlevel/guard/
// <project>/ (the project's .nextlevel/ is writable by the orchestrator, so nothing there decides anything):
//   held.json   the held changes: { next, items: [{ id: 'G3', kind: 'disk' | 'commit' | 'merge' | 'git' | 'secret' |
//               'push' (FR-015: a push to a deploy branch) | 'policy' (the security engineer's, a text by its hash, no
//               file), status: 'held' | 'approved' | 'rejected' | 'applied' |
//               'superseded' | 'failed', files: [{ path, before, after, link? }], key,
//               summary, diff, ... }]; before/after are sha-256 of the content ('-': not there)
//   blobs/      the content of held and watched files, by its sha-256 (what an approval puts back is exactly that)
//   pushes.jsonl every push the hub ran or refused, one JSON line each (FR-015)
//   state.json  "approved": per protected path, the contents the owner made or approved; "window": the watch while
//               the orchestrator can act (an autopilot round, its window, a check or git job it asked for): who
//               holds it open and the protected files as they were when it opened
// Outside a window only the owner acts, so what is on disk when one opens is the owner's. Inside, every change to a
// protected file that isn't approved (the owner's own writes are recorded: recordOwner) is held and set back at once.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readEnv } from './gitlock.mjs';
import { BUILT_IN, describeChanges, isProtected, leadsToProtected, pathKey, visible } from './protect.mjs';

export const ABSENT = '-';
export const BLOB_MAX = 2 * 1024 * 1024; // larger files are watched by their hash; they can't be put back
export const DIFF_MAX = 200 * 1024; // what a card shows of a diff (the approval covers the content, all of it)
const WALK_MAX = 5000;
const LOCK_STALE_MS = 30_000;
const APPROVED_KEEP = 50;
const KEEP_DECIDED = 200;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export const sha = (buf) => createHash('sha256').update(buf).digest('hex');
// (not a bare sha-256: no file's content can hash to what stands for a link)
const linkHash = (target) => `link:${sha(target)}`;
// A version's id as the guard keeps it: a file's content (its sha-256), a link's target, a submodule's commit; a version
// whose content can't be read (a blob git won't hand over) gets an id no content has, so it is never taken as approved
export const contentHash = ({ buf, link, submodule, unreadable }) =>
  link !== undefined ? linkHash(link) : submodule !== undefined ? `submodule:${submodule}` : unreadable !== undefined ? `unreadable:${unreadable}` : sha(buf);

// A project path (from git or a record) as a file under the project's folder; never outside it
export function inProject(root, rel) {
  const parts = String(rel).split('/');
  if (!rel || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel) || parts.some((p) => !p || p === '.' || p === '..' || p.includes('\\'))) throw new Error(`not a path in the project: ${rel}`);
  return path.join(root, ...parts);
}
// The first folder on the way to a project path that is a link (a junction on Windows), or '': nothing is written
// through one, since it may lead out of the project (to the owner's own ~/.claude, say)
export function linkOnTheWay(root, rel) {
  const parts = String(rel).split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    try {
      if (fs.lstatSync(path.join(root, ...parts.slice(0, i))).isSymbolicLink()) return parts.slice(0, i).join('/');
    } catch {
      return ''; // not there: nothing leads anywhere
    }
  }
  return '';
}
// A large file's sha-256, read in pieces
function hashLarge(file) {
  const h = createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1024 * 1024);
    for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) h.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}
const now = () => new Date().toISOString();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const slash = (p) => p.split(path.sep).join('/');
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// The project's folder in ~/.nextlevel/guard: named from its real path (a link or a short name is the same project)
export function projectKey(root) {
  let real = root;
  try {
    real = fs.realpathSync.native(root);
  } catch {
    // named as given
  }
  const r = path.resolve(real);
  return sha(process.platform === 'win32' ? r.toLowerCase() : r).slice(0, 16);
}
export const guardDir = (root, home = os.homedir()) => path.join(home, '.nextlevel', 'guard', projectKey(root));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 40) throw err; // Windows: a reader may hold the file for a moment
      sleepSync(25);
    }
  }
}

// One process at a time (the hub, the dashboard, the orchestrator's window, the owner's commands): a lock folder;
// one left by a process that died is taken over after a while.
function withLock(dir, fn) {
  const lock = path.join(dir, 'lock');
  fs.mkdirSync(dir, { recursive: true });
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      fs.mkdirSync(lock);
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { recursive: true, force: true });
      } catch {
        // gone meanwhile
      }
      if (Date.now() > deadline) throw new Error("nextlevel's guard is busy in another process: try again in a moment");
      sleepSync(30);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(lock, { recursive: true, force: true });
  }
}

// Git for the guard's reads (the protected files git knows of, a diff of two texts): no optional locks, no external
// diff or text conversion programs (a changed git setting must not run anything here).
function gitRead(args, cwd) {
  const r = spawnSync('git', args, { cwd, env: readEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

// A diff of two versions of a file, as git shows one ("diff --git a/<path> b/<path>"). null: not there.
export function diffTexts(rel, before, after, { tmpDir }) {
  fs.mkdirSync(tmpDir, { recursive: true });
  const stamp = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const a = path.join(tmpDir, `a-${stamp}`);
  const b = path.join(tmpDir, `b-${stamp}`);
  try {
    fs.writeFileSync(a, before ?? '');
    fs.writeFileSync(b, after ?? '');
    const r = gitRead(['diff', '--no-index', '--no-color', '--no-ext-diff', '--no-textconv', '--', a, b], tmpDir);
    const body = r.out.slice(Math.max(0, r.out.search(/^(@@|Binary files)/m)));
    const name = slash(rel);
    const head = [`diff --git a/${name} b/${name}`, before === null ? 'new file' : after === null ? 'deleted file' : '', `--- ${before === null ? '/dev/null' : `a/${name}`}`, `+++ ${after === null ? '/dev/null' : `b/${name}`}`].filter(Boolean);
    return r.out.trim() ? `${head.join('\n')}\n${body.replace(/^Binary files .* differ$/m, `Binary files a/${name} and b/${name} differ`)}` : '';
  } finally {
    fs.rmSync(a, { force: true });
    fs.rmSync(b, { force: true });
  }
}

// A diff cut to what a card shows, with the characters that hide or turn text made visible.
export function shownDiff(text) {
  const t = String(text || '');
  const cutAt = t.length > DIFF_MAX ? t.lastIndexOf('\n', DIFF_MAX) : -1;
  return { diff: visible(cutAt > 0 ? t.slice(0, cutAt) : t.slice(0, DIFF_MAX)).replace(/⟨U\+000A⟩/g, '\n'), diffCut: t.length > DIFF_MAX };
}

// The protected files of the project on disk, from the top: every one git knows of (tracked, or new and not ignored,
// at any depth), and those in the protected folders named at the top, ignored ones included (.claude/settings.local
// .json). Links aren't followed; nested repositories and worktrees (.claude/worktrees/...), node_modules and .git are
// skipped. -> Map(rel -> { size, mtimeMs, link? })
export function scanProtected(root, entries = BUILT_IN) {
  const found = new Map();
  const add = (rel, abs) => {
    if (found.size >= WALK_MAX || found.has(rel)) return;
    let st;
    try {
      st = fs.lstatSync(abs);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.readlinkSync(abs);
      } catch {
        // an unreadable link is still a link
      }
      found.set(rel, { size: 0, mtimeMs: st.mtimeMs, link: target });
    } else if (st.isFile()) found.set(rel, { size: st.size, mtimeMs: st.mtimeMs });
  };
  const nested = (abs) => {
    try {
      return fs.existsSync(path.join(abs, '.git'));
    } catch {
      return false;
    }
  };
  const walk = (abs, rel, inside) => {
    if (found.size >= WALK_MAX) return;
    let list;
    try {
      list = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of list) {
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const childAbs = path.join(abs, d.name);
      const prot = inside || isProtected(childRel, entries);
      if (d.isDirectory() && !d.isSymbolicLink()) {
        if (SKIP_DIRS.has(d.name.toLowerCase()) || !(prot || leadsToProtected(childRel, entries)) || nested(childAbs)) continue;
        walk(childAbs, childRel, prot);
      } else if (prot) add(childRel, childAbs);
    }
  };
  walk(root, '', false);
  // (a file in another checkout inside the project, such as .claude/worktrees/<name>/, isn't this project's)
  const inNested = new Map();
  const nestedAbove = (f) => {
    const parts = f.split('/').slice(0, -1);
    for (let i = 1; i <= parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!inNested.has(dir)) inNested.set(dir, nested(path.join(root, ...parts.slice(0, i))));
      if (inNested.get(dir)) return true;
    }
    return false;
  };
  const r = gitRead(['ls-files', '-z', '-c', '-o', '--exclude-standard'], root);
  // (git lists what is behind a link to a folder, a junction on Windows, as if it were one: never read through it)
  if (r.ok) {
    for (const f of r.out.split('\0')) {
      if (!f || f.endsWith('/') || !isProtected(f, entries) || nestedAbove(f) || linkOnTheWay(root, f)) continue;
      try {
        add(f, inProject(root, f));
      } catch {
        // not a path in the project: never looked at
      }
    }
  }
  return found;
}

export function guardStore({ root, home = os.homedir(), entries = () => BUILT_IN }) {
  const dir = guardDir(root, home);
  const F = { state: path.join(dir, 'state.json'), held: path.join(dir, 'held.json'), blobs: path.join(dir, 'blobs'), tmp: path.join(dir, 'tmp') };
  const list = () => (typeof entries === 'function' ? entries() : entries) || BUILT_IN;
  const lock = (fn) => withLock(dir, fn);
  const readState = () => ({ version: 1, approved: {}, window: null, ...readJson(F.state, {}) });
  const readHeld = () => ({ version: 1, next: 1, items: [], ...readJson(F.held, {}) });
  const abs = (rel) => inProject(root, rel);

  // ---- content, by its sha-256 ----
  function putBlob(buf) {
    const h = sha(buf);
    if (buf.length > BLOB_MAX) return h;
    const f = path.join(F.blobs, h);
    if (!fs.existsSync(f)) {
      fs.mkdirSync(F.blobs, { recursive: true });
      fs.writeFileSync(`${f}.${process.pid}.tmp`, buf);
      fs.renameSync(`${f}.${process.pid}.tmp`, f);
    }
    return h;
  }
  function getBlob(h) {
    if (!/^[0-9a-f]{64}$/.test(String(h))) return null; // (a link's or a submodule's id has no content kept)
    try {
      const buf = fs.readFileSync(path.join(F.blobs, h));
      return sha(buf) === h ? buf : null;
    } catch {
      return null;
    }
  }

  // A file as it is now: { hash, size, mtimeMs, link? }, its content kept as a blob; `known`: its last entry, whose
  // hash is used again while its size and time are the same.
  function entryOf(rel, st, known) {
    if (!st) return { hash: ABSENT };
    if (st.link !== undefined) return { hash: linkHash(st.link), size: 0, mtimeMs: st.mtimeMs, link: st.link };
    if (known && known.hash !== ABSENT && known.size === st.size && known.mtimeMs === st.mtimeMs && known.link === undefined) return known;
    try {
      // (a large one is hashed in pieces and not kept: it can be taken away, not put back)
      if (st.size > BLOB_MAX) return { hash: hashLarge(abs(rel)), size: st.size, mtimeMs: st.mtimeMs };
      return { hash: putBlob(fs.readFileSync(abs(rel))), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return { hash: ABSENT };
    }
  }
  const statOf = (rel) => scanOne(rel);
  function scanOne(rel) {
    try {
      const st = fs.lstatSync(abs(rel));
      if (st.isSymbolicLink()) return { size: 0, mtimeMs: st.mtimeMs, link: fs.readlinkSync(abs(rel)) };
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch {
      return null;
    }
  }

  const approvedOf = (st, rel) => st.approved[pathKey(rel)] || [];
  function approve(st, rel, h) {
    const k = pathKey(rel);
    st.approved[k] = [...(st.approved[k] || []).filter((x) => x !== h), h].slice(-APPROVED_KEEP);
  }

  // Put a file back as an entry says (a blob's content, a link, or not there). -> '' or why it couldn't
  function putBack(rel, e) {
    try {
      const file = abs(rel);
      const link = linkOnTheWay(root, rel);
      if (link) return `${link} is a link: nothing is written through it`;
      if (!e || e.hash === ABSENT) {
        fs.rmSync(file, { force: true });
        return '';
      }
      if (e.link !== undefined) {
        fs.rmSync(file, { force: true });
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.symlinkSync(e.link, file);
        return '';
      }
      const buf = getBlob(e.hash);
      if (!buf) return 'its earlier content is too large to keep';
      fs.rmSync(file, { force: true }); // (a link in its place is removed, not written through)
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, buf);
      return '';
    } catch (err) {
      return err.message;
    }
  }
  const textOf = (e) => {
    if (!e || e.hash === ABSENT) return null;
    if (e.link !== undefined) return Buffer.from(`(a link to ${e.link})\n`);
    const buf = getBlob(e.hash);
    return buf ? buf : Buffer.from(`(${e.size} bytes, too large to keep: its sha-256 is ${e.hash})\n`);
  };
  const isBinary = (buf) => !!buf && buf.subarray(0, 8000).includes(0);

  // One held change's words and diff from the entries before and after: { summary, diff, diffCut }
  function describeFiles(changes) {
    const parts = changes.map((c) => {
      const b = textOf(c.was);
      const a = textOf(c.now);
      const binary = isBinary(b) || isBinary(a);
      const summaryInput = {
        path: c.path,
        before: b && !binary ? b.toString('utf8') : null,
        after: a && !binary ? a.toString('utf8') : null,
        binary,
        size: c.now?.size || 0,
        link: { ...(c.was?.link !== undefined ? { before: c.was.link } : {}), ...(c.now?.link !== undefined ? { after: c.now.link } : {}) },
      };
      if (binary) Object.assign(summaryInput, { before: b ? '' : null, after: a ? '' : null });
      return { summaryInput, diff: diffTexts(c.path, b, a, { tmpDir: F.tmp }) };
    });
    return { summary: describeChanges(parts.map((p) => p.summaryInput)), ...shownDiff(parts.map((p) => p.diff).join('\n')) };
  }

  // ---- the held changes ----
  // What waits is kept, and the last KEEP_DECIDED decided ones (each has its diff)
  function prune(h) {
    const decided = h.items.filter((x) => !['held', 'approved'].includes(x.status));
    if (decided.length <= KEEP_DECIDED) return;
    const drop = new Set(decided.slice(0, decided.length - KEEP_DECIDED));
    h.items = h.items.filter((x) => !drop.has(x));
  }
  const keyOf = (files) => sha(JSON.stringify([...files].map((f) => [pathKey(f.path), f.before, f.after]).sort()));
  const held = {
    list: () => readHeld().items,
    get: (id) => readHeld().items.find((x) => x.id === String(id)),
    // A new held change, unless the same one is already held (or, for a merge, was rejected): { item, fresh }
    add(rec) {
      return lock(() => {
        const h = readHeld();
        const key = rec.key || keyOf(rec.files);
        const same = h.items.find((x) => x.kind === rec.kind && x.key === key && (x.task || '') === (rec.task || '') && (x.status === 'held' || (['merge', 'secret', 'push', 'policy'].includes(rec.kind) && x.status === 'rejected')));
        if (same) return { item: same, fresh: false };
        const item = { id: `G${h.next}`, status: 'held', createdAt: now(), decidedAt: null, reason: '', ...rec, key };
        h.items.push(item);
        h.next += 1;
        prune(h);
        writeJson(F.held, h);
        return { item, fresh: true };
      });
    },
    update(id, patch, { expect } = {}) {
      return lock(() => {
        const h = readHeld();
        const x = h.items.find((i) => i.id === String(id));
        if (!x) throw new Error(`there is no held change ${id}`);
        if (expect && !expect.includes(x.status)) throw new Error(`${x.id} is ${x.status} already`);
        Object.assign(x, patch);
        writeJson(F.held, h);
        return x;
      });
    },
  };

  // ---- the watch window ----
  // Opens it, with the protected files as they are now as what a change is measured against, or joins it. `key`: who
  // holds it open. What is on disk then isn't approved by that alone: a commit of it still needs the owner's own
  // write (recordOwn) or approval, since something the orchestrator left running could have written it meanwhile.
  function open(key, { pid = process.pid, what = '' } = {}) {
    return lock(() => {
      const st = readState();
      if (!st.window) {
        const files = {};
        for (const [rel, s] of scanProtected(root, list())) {
          const e = entryOf(rel, s);
          if (e.hash !== ABSENT) files[rel] = e;
        }
        st.window = { openedAt: now(), holders: {}, files };
      }
      st.window.holders[key] = { pid, what, since: now() };
      writeJson(F.state, st);
      return st.window;
    });
  }

  // Compares the protected files with the window: what the owner made or approved is taken in; any other change is
  // held (one record for the lot) and set back at once. `drop`: a holder that is done; holders whose process is gone
  // are dropped too, and the window closes when none is left. -> { held: [new records], again: [records it matched],
  // restored: [paths], closed }
  function check({ drop = null } = {}) {
    if (!readState().window) return { held: [], again: [], restored: [], closed: false, open: false };
    return lock(() => {
      const st = readState();
      const w = st.window;
      if (!w) return { held: [], again: [], restored: [], closed: false, open: false };
      const holders = { ...w.holders }; // (who was at work, the one that just ended included)
      if (drop) delete w.holders[drop];
      for (const [k, h] of Object.entries(w.holders)) if (!alive(h.pid)) delete w.holders[k];
      const cur = scanProtected(root, list());
      const changes = [];
      for (const rel of new Set([...Object.keys(w.files), ...cur.keys()])) {
        const was = w.files[rel] || { hash: ABSENT };
        const nowE = entryOf(rel, cur.get(rel), was);
        if (nowE.hash === was.hash) {
          if (nowE.hash !== ABSENT) w.files[rel] = nowE;
          continue;
        }
        if (approvedOf(st, rel).includes(nowE.hash)) {
          if (nowE.hash === ABSENT) delete w.files[rel];
          else w.files[rel] = nowE;
          continue;
        }
        changes.push({ path: rel, was, now: nowE });
      }
      // shallow first: a link that took a folder's place is gone before anything is put back in that folder
      changes.sort((x, y) => x.path.split('/').length - y.path.split('/').length || x.path.localeCompare(y.path));
      const out = { held: [], again: [], restored: [], closed: false, open: true, notRestored: [] };
      if (changes.length) {
        const files = changes.map((c) => ({ path: c.path, before: c.was.hash, after: c.now.hash, ...(c.now.link !== undefined ? { link: c.now.link } : {}), ...(c.was.link !== undefined ? { linkBefore: c.was.link } : {}), size: c.now.size || 0 }));
        const key = keyOf(files);
        const h = readHeld();
        const same = h.items.find((x) => x.kind === 'disk' && x.key === key && x.status === 'held');
        let rec = same;
        if (!same) {
          const who = [...new Set(Object.values(holders).map((x) => x.what).filter(Boolean))].join(', ') || "the orchestrator's work";
          rec = { id: `G${h.next}`, kind: 'disk', status: 'held', createdAt: now(), decidedAt: null, reason: '', by: who, task: '', job: '', files, key, ...describeFiles(changes) };
          h.items.push(rec);
          h.next += 1;
          prune(h);
        }
        for (const c of changes) {
          const why = putBack(c.path, c.was);
          if (why) out.notRestored.push(`${c.path} (${why})`);
          else out.restored.push(c.path);
        }
        if (out.notRestored.length) rec.notRestored = [...new Set([...(rec.notRestored || []), ...out.notRestored])];
        writeJson(F.held, h);
        (same ? out.again : out.held).push(rec);
        // what is on disk now is the window's again (set back); a file that couldn't be put back stays a change
        for (const c of changes) {
          if (out.notRestored.some((n) => n.startsWith(`${c.path} (`))) continue;
          if (c.was.hash === ABSENT) delete w.files[c.path];
          else w.files[c.path] = entryOf(c.path, statOf(c.path), null);
        }
      }
      if (!Object.keys(w.holders).length) {
        st.window = null;
        out.closed = true;
      }
      writeJson(F.state, st);
      if (out.closed) gc();
      return out;
    });
  }
  const close = (key) => check({ drop: key });
  const windowOpen = () => !!readState().window;

  // The owner's own write (the Team page, the doctor, init): its content is approved, and the window takes it in.
  function recordOwn(rels) {
    return lock(() => {
      const st = readState();
      for (const rel of rels) {
        const e = entryOf(rel, statOf(rel), null);
        approve(st, rel, e.hash);
        if (st.window) {
          if (e.hash === ABSENT) delete st.window.files[rel];
          else st.window.files[rel] = e;
        }
      }
      writeJson(F.state, st);
    });
  }
  // Content the owner approved (a held change applied, a merge's result): approved, and the window takes it in.
  function accept(rels) {
    return recordOwn(rels);
  }
  const isApproved = (rel, h) => approvedOf(readState(), rel).includes(h);
  // Content for a path, approved beforehand (what the hub is about to write for an approved change)
  function approveContent(rel, h) {
    return lock(() => {
      const st = readState();
      approve(st, rel, h);
      writeJson(F.state, st);
    });
  }

  // An approved change on disk goes back as it was held: only while each file is still as it was set back to (else
  // it changed since, and this approval doesn't cover what is there now). -> { ok, detail }
  function applyDisk(id) {
    return lock(() => {
      const h = readHeld();
      const rec = h.items.find((x) => x.id === String(id));
      if (!rec || rec.kind !== 'disk') throw new Error(`there is no held change ${id} on disk`);
      if (rec.status !== 'approved') throw new Error(`${rec.id} is ${rec.status}`);
      const st = readState();
      const moved = rec.files.filter((f) => entryOf(f.path, statOf(f.path), null).hash !== f.before);
      if (moved.length) {
        Object.assign(rec, { status: 'superseded', appliedAt: now(), detail: `${moved.map((f) => f.path).join(', ')} changed again since it was held, so this approval doesn't cover what is there now: nothing was put back` });
        writeJson(F.held, h);
        return { ok: false, detail: rec.detail };
      }
      const failed = [];
      for (const f of rec.files) {
        approve(st, f.path, f.after);
        const why = putBack(f.path, { hash: f.after, ...(f.link !== undefined ? { link: f.link } : {}) });
        if (why) failed.push(`${f.path} (${why})`);
        if (st.window) {
          const e = entryOf(f.path, statOf(f.path), null);
          if (e.hash === ABSENT) delete st.window.files[f.path];
          else st.window.files[f.path] = e;
        }
      }
      writeJson(F.state, st);
      Object.assign(rec, { status: failed.length ? 'approved' : 'applied', appliedAt: now(), detail: failed.length ? `couldn't put back ${failed.join(', ')}` : `put back as held: ${rec.files.map((f) => f.path).join(', ')}` });
      writeJson(F.held, h);
      return { ok: !failed.length, detail: rec.detail };
    });
  }

  // A file that is gone put back as an entry says (a rejected deletion: antivirus may have removed it). The window
  // takes it in. -> '' when it is there now, or why it couldn't be put back
  function restoreGone(rel, e) {
    return lock(() => {
      if (statOf(rel)) return '';
      const why = putBack(rel, e);
      const st = readState();
      if (!why && st.window) {
        st.window.files[rel] = entryOf(rel, statOf(rel), null);
        writeJson(F.state, st);
      }
      return why;
    });
  }

  // Blobs nothing refers to any more (a closed window's, a decided change's) are removed
  function gc() {
    try {
      const keep = new Set();
      const st = readState();
      for (const e of Object.values(st.window?.files || {})) keep.add(e.hash);
      for (const x of readHeld().items) if (['held', 'approved'].includes(x.status)) for (const f of x.files || []) keep.add(f.before), keep.add(f.after);
      // (git's hooks, as recorded and as held: Reject puts the recorded ones back)
      const hookHashes = (s) => Object.values(s?.hooks || {}).flatMap((files) => Object.values(files).map((h) => h.hash));
      for (const h of hookHashes(readJson(path.join(dir, 'git.json'), null))) keep.add(h);
      for (const x of readHeld().items) if (x.kind === 'git' && x.status === 'held') for (const h of [...hookHashes(x.before), ...hookHashes(x.after)]) keep.add(h);
      // (the security engineer's policies: a text waiting on its card, and the approved one every scan reads, which has no
      // file and lives in the blobs alone)
      for (const x of readHeld().items) if (x.kind === 'policy' && x.status === 'held' && x.hash) keep.add(x.hash);
      const approved = readJson(path.join(dir, 'security-policy.json'), null)?.approved?.hash;
      if (typeof approved === 'string') keep.add(approved);
      for (const name of fs.existsSync(F.blobs) ? fs.readdirSync(F.blobs) : []) if (!keep.has(name)) fs.rmSync(path.join(F.blobs, name), { force: true });
    } catch {
      // only tidying
    }
  }

  // Git's own hooks and settings as the owner last had them (lib/gitguard.mjs; the hub compares before its git work)
  const gitFile = path.join(dir, 'git.json');
  const readGit = () => readJson(gitFile, null);
  const writeGit = (s) => lock(() => writeJson(gitFile, s));
  // nextlevel itself changing git's settings in another process (the owner's bridge test adds a remote): the hub doesn't
  // look meanwhile, for up to a minute, while that process lives
  const gitBusyFile = path.join(dir, 'git-busy.json');
  const setGitBusy = (on) => (on ? writeJson(gitBusyFile, { pid: process.pid, at: now() }) : fs.rmSync(gitBusyFile, { force: true }));
  const gitBusy = () => {
    const b = readJson(gitBusyFile, null);
    return !!b && alive(b.pid) && Date.now() - Date.parse(b.at) < 60_000;
  };
  // The contents of .env the owner let be committed: { "<path key>": [sha-256...] } (a held change with a value approved)
  const secretOk = (rel, h) => (readState().secretOk?.[pathKey(rel)] || []).includes(h);
  const approveSecret = (rel, h) =>
    lock(() => {
      const st = readState();
      const k = pathKey(rel);
      st.secretOk = { ...(st.secretOk || {}), [k]: [...(st.secretOk?.[k] || []).filter((x) => x !== h), h].slice(-APPROVED_KEEP) };
      writeJson(F.state, st);
    });

  return { dir, files: F, lock, putBlob, getBlob, held, open, close, check, windowOpen, recordOwn, accept, isApproved, approveContent, applyDisk, restoreGone, describeFiles, keyOf, readState, readGit, writeGit, setGitBusy, gitBusy, secretOk, approveSecret, scan: () => scanProtected(root, list()) };
}

// The owner's own write of files in the project (the Team page's save, the doctor's fixes, nextlevel init): their
// content is approved, so the guard never holds it. Not from an agent's session (NEXTLEVEL_AGENT: the orchestrator's,
// a worker's, a check the orchestrator asked for), whose writes are the guard's to judge. Never fails the caller.
export function recordOwner(root, rels, { home = os.homedir(), env = process.env } = {}) {
  if (env.NEXTLEVEL_AGENT || !root || !rels?.length) return false;
  try {
    guardStore({ root, home }).recordOwn(rels.map((r) => slash(path.isAbsolute(r) ? path.relative(root, r) : r)).filter((r) => r && !r.startsWith('..')));
    return true;
  } catch {
    return false;
  }
}

// Before the owner's own write of a file the guard watches (the Team page's switches, the doctor's fixes), while the
// watch is open (the orchestrator can act): the file must be as it was when the watch opened, or as the owner made,
// approved or committed it. Else the owner's write would approve, with the owner's own change, one the orchestrator made
// on disk meanwhile (a round's edit of nextlevel.json before the watch looked). Outside the watch only the owner acts,
// so an edit by hand stays theirs. -> '' or why not. Not in an agent's session (recordOwner records nothing there: the
// guard judges that write). What can't be read says nothing here: recordOwner then records nothing either, and the
// guard holds the whole change.
export function ownerWriteProblem(root, rels, { home = os.homedir(), env = process.env } = {}) {
  if (env.NEXTLEVEL_AGENT || !root || !rels?.length) return '';
  try {
    const g = guardStore({ root, home });
    const win = g.readState().window;
    if (!win) return '';
    const fold = (buf) => buf.toString('latin1').replace(/\r\n/g, '\n');
    for (const r of rels) {
      const rel = slash(path.isAbsolute(r) ? path.relative(root, r) : r);
      if (!rel || rel.startsWith('..') || !isProtected(rel)) continue; // (the guard judges only what it watches)
      let st;
      try {
        st = fs.lstatSync(inProject(root, rel));
      } catch {
        continue; // (not there: nothing of anyone's to approve with it)
      }
      if (!st.isFile() || st.size > BLOB_MAX) continue; // (a link is refused by its writer; a large file isn't a setting)
      const buf = fs.readFileSync(inProject(root, rel));
      const h = sha(buf);
      const base = Object.entries(win.files || {}).find(([k]) => pathKey(k) === pathKey(rel))?.[1]?.hash;
      if (h === base || g.isApproved(rel, h)) continue;
      const head = spawnSync('git', ['cat-file', 'blob', `HEAD:${rel}`], { cwd: root, env: readEnv(), windowsHide: true, maxBuffer: 2 * BLOB_MAX });
      if (head.status === 0 && fold(head.stdout) === fold(buf)) continue; // (as committed, line ends aside)
      return `${rel} changed while the orchestrator is at work, and you haven't approved that change: nothing was saved. Try again once the orchestrator is done (its round ends, or you close its window); Home shows the change on a card if it was the orchestrator's.`;
    }
    return '';
  } catch {
    return '';
  }
}
