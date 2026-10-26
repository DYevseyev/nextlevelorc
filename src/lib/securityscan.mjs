// The security engineer's scan checkout and its lease (docs/design/security-engineer.md, §6).
// A scan reads the base branch's head in a checkout of its own. Before each scan, in that checkout only, the hub takes
// out every link (the link itself, never what it points to) and moves every file that steers an AI engine or runs a hook
// into one plain-text folder the scan reads as data and no engine loads: the guard's protected paths at any depth
// (lib/protect.mjs: .claude/, .codex/, AGENTS.md, AGENTS.override.md, SECURITY.md...) and the files Codex Security reads
// as its own settings. The approved policy reaches the scan as its knowledge base, from outside the checkout, never as a
// file in it. One scan at a time on the PC: a lease in ~/.nextlevel, its holder told by pid and start time, as the file
// lock's is (lib/filelock.mjs), since the 12-second lock can't hold a scan of hours.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { BUILT_IN, isProtected } from './protect.mjs';
import { processStartSync } from './proctree.mjs';

// What Codex Security reads as settings of its own in the scanned folder, on top of the guard's list
export const SCANNER_FILES = ['codex-security.toml', '.codex-security.toml'];
// The folder in the checkout the steering files go to, as plain text
export const ASIDE = '.nextlevel-scan';
const SKIP = new Set(['.git', ASIDE]);
const START_SLACK_MS = 2_000;

const lower = (s) => s.toLowerCase();

// What in a checkout steers an engine, and its links: { files: [rel], links: [rel] }, paths from the top with "/".
// A protected folder gives every file in it. Never follows a link.
export function findSteering(checkout, entries = BUILT_IN) {
  const files = [];
  const links = [];
  const extra = new Set(SCANNER_FILES.map(lower));
  const walk = (dir, rel) => {
    let list;
    try {
      list = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of list.sort((a, b) => a.name.localeCompare(b.name))) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && SKIP.has(e.name)) continue;
      const abs = path.join(dir, e.name);
      let st;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) links.push(r);
      else if (st.isDirectory()) walk(abs, r);
      else if (isProtected(r, entries) || extra.has(lower(e.name))) files.push(r);
    }
  };
  walk(checkout, '');
  return { files, links };
}

// Takes a link out (a symbolic link, or on Windows a junction): the link itself, never what it points to
export function removeLink(abs) {
  try {
    fs.unlinkSync(abs);
  } catch {
    fs.rmdirSync(abs); // (a junction or a folder link on Windows: rmdir takes the link, not the folder it names)
  }
}

// A steering file's name in the aside folder: one flat name, no folder of its own, so nothing there is named like a
// file or folder an engine loads (.claude/settings.json becomes 001-.claude__settings.json.txt)
export const asideName = (rel, i) => `${String(i + 1).padStart(3, '0')}-${rel.replace(/\//g, '__')}.txt`;

// Prepares a checkout for a scan: links out, steering files moved aside. -> { links, moved: [{ from, to }] }, written
// to <aside>/index.json too, so the scan's prompt can say what each file was.
export function setAside(checkout, entries = BUILT_IN) {
  const { files, links } = findSteering(checkout, entries);
  for (const l of links) removeLink(path.join(checkout, ...l.split('/')));
  // (a link removed may have hidden steering files behind it in no walk: none, since a walk never follows one)
  const dir = path.join(checkout, ASIDE, 'steering');
  fs.mkdirSync(dir, { recursive: true });
  const moved = files.map((from, i) => {
    const to = `${ASIDE}/steering/${asideName(from, i)}`;
    fs.renameSync(path.join(checkout, ...from.split('/')), path.join(checkout, ...to.split('/')));
    return { from, to };
  });
  fs.writeFileSync(path.join(checkout, ASIDE, 'index.json'), `${JSON.stringify({ links, moved }, null, 2)}\n`);
  return { links, moved };
}

// ---------- the lease: one scan at a time on the PC ----------
export const leaseFile = (home) => path.join(home, '.nextlevel', 'security-lease.json');

// The lease's holder, or null: { root, pid, start (ms), scan } when its process still runs (the same pid, started when
// the lease says, give or take the clock's grain)
export function leaseHolder(home, { startOf = processStartSync } = {}) {
  let h;
  try {
    h = JSON.parse(fs.readFileSync(leaseFile(home), 'utf8'));
  } catch {
    return null;
  }
  if (!h || typeof h !== 'object' || !Number.isInteger(h.pid) || typeof h.start !== 'number' || typeof h.root !== 'string') return null;
  const now = startOf(h.pid);
  if (now === null || Math.abs(now - h.start) > START_SLACK_MS) return null;
  return { root: h.root, pid: h.pid, start: h.start, scan: typeof h.scan === 'string' ? h.scan : '' };
}

// Takes the lease for a scan: { ok: true } or { ok: false, holder }. The file is made only where none is (exclusive
// create), so of two takers one wins; a lease whose holder is gone is moved aside in one rename (of two, one does) and
// the take tried again.
export function takeLease(home, { root, pid, start, scan }, { startOf = processStartSync } = {}) {
  const file = leaseFile(home);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify({ root, pid, start, scan, at: new Date().toISOString() });
  for (let i = 0; i < 3; i++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' });
      return { ok: true };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const holder = leaseHolder(home, { startOf });
    if (holder) return holder.pid === pid && holder.start === start ? { ok: true } : { ok: false, holder };
    try {
      fs.renameSync(file, `${file}.${randomBytes(6).toString('hex')}.gone`);
    } catch {
      // another taker moved it first
    }
    for (const f of fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith('security-lease.json.') && n.endsWith('.gone'))) fs.rmSync(path.join(path.dirname(file), f), { force: true });
  }
  return { ok: false, holder: leaseHolder(home, { startOf }) };
}

// Gives the lease back, only when it is still the caller's
export function releaseLease(home, { pid, start }) {
  try {
    const h = JSON.parse(fs.readFileSync(leaseFile(home), 'utf8'));
    if (h?.pid === pid && h?.start === start) fs.rmSync(leaseFile(home), { force: true });
  } catch {
    // nothing there
  }
}

