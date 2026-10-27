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


// ---------- the checkout: a standalone clone (delta 1 D1) ----------
// A worktree's .git file names a Windows path the container can't see, so the scan's checkout is a clone of its own:
// made once with no hard links and nothing checked out, its origin removed, hooks and git's automatic housekeeping off;
// before each scan the base branch's head is fetched from the project by path, the folder cleaned and that commit
// checked out detached. Every git command here runs with an empty hooks folder. git(args, cwd) -> { ok, out, err }.
export const NO_HOOKS = '.git/nextlevel-no-hooks';
export function refreshCheckout({ root, slot, base, head, git }) {
  const g = (args) => git(['-c', `core.hooksPath=${path.join(slot, NO_HOOKS)}`, '-c', 'maintenance.auto=false', '-c', 'gc.auto=0', ...args], slot);
  if (!fs.existsSync(path.join(slot, '.git'))) {
    fs.rmSync(slot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(slot), { recursive: true });
    const c = git(['-c', 'core.hooksPath=', 'clone', '--no-hardlinks', '--no-checkout', '--quiet', root, slot], path.dirname(slot));
    if (!c.ok) return `the scan's checkout couldn't be made (git clone: ${(c.err || c.out).split('\n')[0]})`;
    fs.mkdirSync(path.join(slot, NO_HOOKS), { recursive: true });
    g(['remote', 'remove', 'origin']);
    for (const [k, v] of [['core.hooksPath', path.join(slot, NO_HOOKS)], ['maintenance.auto', 'false'], ['gc.auto', '0']]) g(['config', k, v]);
  }
  fs.mkdirSync(path.join(slot, NO_HOOKS), { recursive: true });
  const f = g(['fetch', '--quiet', '--no-tags', root, `+refs/heads/${base}:refs/nextlevel/scan-base`]);
  if (!f.ok) return `the base branch couldn't be fetched into the scan's checkout (${(f.err || f.out).split('\n')[0]})`;
  const tip = g(['rev-parse', 'refs/nextlevel/scan-base']).out.trim();
  if (tip !== head) return `the base branch moved while the scan started (${tip.slice(0, 8)}, not ${head.slice(0, 8)}): start it again`;
  g(['clean', '-fdxq']);
  const c = g(['checkout', '--quiet', '--force', '--detach', head]);
  if (!c.ok) return `the scan's checkout couldn't be set to ${head.slice(0, 8)} (${(c.err || c.out).split('\n')[0]})`;
  g(['clean', '-fdxq']);
  return '';
}

// A tracked file the scan would send to OpenAI that looks like a secrets file (delta 2 V6, stop rule 5): its name only,
// never opened. -> [rel]
export const isEnvLike = (rel) => {
  const name = String(rel).split('/').pop().toLowerCase();
  return name === '.env' || (name.startsWith('.env.') && !/^\.env\.(example|sample|template|dist|defaults)$/.test(name)) || name.endsWith('.env');
};
export function trackedSecrets({ slot, git }) {
  const r = git(['-c', 'core.quotePath=false', 'ls-files', '-z'], slot);
  return r.ok ? r.out.split('\0').filter(Boolean).filter(isEnvLike) : [];
}

// ---------- the scans' records ----------
export const scansDir = (stateDir) => path.join(stateDir, 'security', 'scans');
export const scanDir = (stateDir, id) => path.join(scansDir(stateDir), id);
export const SCAN_ID = /^sec-\d{8}-\d{6}-[0-9a-f]{4}$/;
export const newScanId = (at = new Date()) => `sec-${at.toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/^(\d{8})/, '$1-')}-${randomBytes(2).toString('hex')}`;
export function readScan(stateDir, id) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(scanDir(stateDir, id), 'scan.json'), 'utf8'));
    return s && typeof s === 'object' && s.id === id ? s : null;
  } catch {
    return null;
  }
}
export function writeScan(stateDir, id, change) {
  const dir = scanDir(stateDir, id);
  fs.mkdirSync(dir, { recursive: true });
  const next = { ...(readScan(stateDir, id) || { id }), ...change, id };
  const tmp = path.join(dir, `scan.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  fs.renameSync(tmp, path.join(dir, 'scan.json'));
  return next;
}
export function listScans(stateDir) {
  let ids = [];
  try {
    ids = fs.readdirSync(scansDir(stateDir)).filter((n) => SCAN_ID.test(n));
  } catch {
    // none yet
  }
  return ids.sort().reverse().map((id) => readScan(stateDir, id)).filter(Boolean);
}
// A scan whose process still runs (its pid with its start time), for the hub's exit-when-idle and the update's wait
export function runningScan(stateDir, { startOf = processStartSync } = {}) {
  return listScans(stateDir).find((s) => ['starting', 'waiting', 'running'].includes(s.state) && Number.isInteger(s.pid) && typeof s.pidStart === 'number' && (() => {
    const now = startOf(s.pid);
    return now !== null && Math.abs(now - s.pidStart) <= START_SLACK_MS;
  })()) || null;
}
