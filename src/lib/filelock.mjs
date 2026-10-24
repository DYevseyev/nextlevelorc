// A JSON file several nextlevel processes change (FR-019): settings.json (the hub, the dashboard, the menu, an
// orchestrator's window), usage.json (the hub, interactive windows, the assistant) and round-now.json (the dashboard);
// the cards' stores take the same lock (lib/cards.mjs). Each change reads, changes and writes the file inside one lock,
// so a change another process makes at the same moment is never lost: the owner turning autopilot on can't be undone by
// the hub writing another setting it had read before. The file itself is replaced in one rename, so a reader without the
// lock always sees a whole file.
// The lock is a folder next to the file (`<file>.lock`) with a holder file in it: the holder's pid, a token of its own
// and the time it took the lock. A waiter takes the lock over (moves it aside in one rename: of two waiters, one does)
// when its holder is gone, told by the pid and its start time together: a pid that runs no more, at once; a pid another
// program has now (it started after the lock was taken), once the holder has kept it LOOK_MS (asking for a start time
// takes a moment on Windows). Whatever it finds, a waiter waits HELD_MS at most, on its own clock: then it takes the lock
// over from any holder (a process that hangs, or a holder file an agent wrote: `.nextlevel/` is the team's to write).
// What is no lock folder (a link, a file) is taken over at once; a folder without a holder file in it, once it has been
// so NO_HOLDER_MS (its maker died before it wrote one). A lock that can't be moved aside (on Windows, a file in it held
// open) is waited for until GIVE_UP_MS, and then the writer writes without it rather than hang. `onLock` hears every
// takeover and every write without the lock (the hub logs them).
// A writer changes the file only while the lock is still its own (its token in the holder file, looked at right before
// the rename): one whose lock was taken over reads the file again and makes its change on what is there now, so neither
// change is lost; only a write in the moment between that look and the rename can be.
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { processStartSync } from './proctree.mjs';

const HELD_MS = 12_000;
const GIVE_UP_MS = 15_000;
const LOOK_MS = 1_000;
const NO_HOLDER_MS = 2_000;
const START_SLACK_MS = 2_000; // (a start time read to the second: /proc's boot time, ps)
const TRIES = 3; // writes whose lock was taken over, before the last one writes whatever happens (and says so)
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const newToken = () => `${process.pid}-${randomBytes(6).toString('hex')}`;
// What mkdir says while another writer has the lock: it is there, or (Windows) it is being deleted (EPERM, EACCES:
// another writer's lock folder whose delete hasn't finished; seen with four writers at once)
const BUSY = new Set(['EEXIST', 'EPERM', 'EACCES']);

// The lock's holder: { pid, token, at (ms: when it took the lock, the holder file's time) } | null
function readHolder(lock) {
  try {
    const file = path.join(lock, 'holder');
    const h = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { pid: Number(h?.pid), token: String(h?.token ?? ''), at: fs.statSync(file).mtimeMs };
  } catch {
    return null;
  }
}
// What is at the lock's name: 'folder', 'other' (a link, a file: no lock of ours), or '' (nothing)
const kindAt = (lock) => {
  try {
    return fs.lstatSync(lock).isDirectory() ? 'folder' : 'other';
  } catch {
    return '';
  }
};
// (a lock folder that can't be removed now, a file in it held a moment by another program, is taken over later)
const release = (lock) => {
  try {
    fs.rmSync(lock, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  } catch {
    // its holder file is gone with it or not: a waiter tells
  }
};
const runs = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
const since = (ms) => (Number.isFinite(new Date(ms).getTime()) ? new Date(ms).toISOString() : null);

// Whether a lock's holder is gone: its pid runs no more, or (look) another program has that pid now, one that started
// after the lock was taken (pids are unique among running processes: one that ran when the lock was taken is its holder).
// startOf(pid) -> ms | null (unknown: not gone). -> why, or ''
export function holderGone(h, { look = false, startOf = processStartSync } = {}) {
  if (!Number.isInteger(h.pid) || h.pid <= 0) return 'its holder file names no process';
  if (!runs(h.pid)) return `its holder (pid ${h.pid}) has ended`;
  if (!look) return '';
  const start = startOf(h.pid);
  return start !== null && start > h.at + START_SLACK_MS ? `pid ${h.pid} is another program's now (it started after the lock was taken)` : '';
}

// -> the lock's token, or '' when the writer goes on without it (the lock couldn't be moved aside in GIVE_UP_MS)
function takeLock(lock, onLock) {
  const mine = newToken();
  const start = Date.now(); // (this waiter's own clock: nothing in the lock folder moves it)
  let seen = null; // the holder being waited for: { token, since, looked }
  let noHolder = 0; // since when the folder has been without a holder file
  for (;;) {
    let made = false;
    try {
      fs.mkdirSync(lock);
      made = true;
      fs.writeFileSync(path.join(lock, 'holder'), JSON.stringify({ pid: process.pid, token: mine, at: new Date().toISOString() }), { flag: 'wx' });
      // (the folder could have been put aside for a link between the two: then the holder file went where the link
      // points, and is taken back)
      if (kindAt(lock) === 'folder') return mine;
      try {
        fs.rmSync(path.join(lock, 'holder'), { force: true });
      } catch {
        // gone with the link
      }
      made = false;
    } catch (err) {
      if (made) release(lock); // (the folder was ours, but its holder file couldn't go in: let it go and try again)
      else if (!BUSY.has(err.code)) throw err;
    }
    const now = Date.now();
    const kind = kindAt(lock);
    let why = '';
    let h = null;
    if (kind === 'other') why = 'what has its name is no folder (a link or a file)';
    else if (kind === 'folder') {
      h = readHolder(lock);
      if (!h) {
        noHolder ||= now;
        if (now - noHolder > NO_HOLDER_MS) why = 'its folder has no holder in it (its maker died before it wrote one)';
      } else {
        noHolder = 0;
        if (seen?.token !== h.token) seen = { token: h.token, since: now, looked: false };
        why = holderGone(h);
        if (!why && !seen.looked && now - seen.since > LOOK_MS) {
          seen.looked = true;
          why = holderGone(h, { look: true });
        }
      }
      if (!why && now - start > HELD_MS) why = h ? `it was held over ${Math.round(HELD_MS / 1000)} s (by pid ${h.pid} last)` : `it was held over ${Math.round(HELD_MS / 1000)} s`;
    }
    if (why) {
      let took = false;
      try {
        fs.renameSync(lock, `${lock}.gone-${mine}`);
        took = true;
      } catch {
        // another waiter moved it first, it was let go meanwhile, or (Windows) a file in it is held open
      }
      if (took) {
        release(`${lock}.gone-${mine}`);
        onLock?.({ took: true, why, holder: h ? { pid: h.pid, since: since(h.at) } : null });
        seen = null;
        noHolder = 0;
        continue;
      }
    }
    if (now - start > GIVE_UP_MS) {
      onLock?.({ forced: true, why: `its lock couldn't be taken or moved aside in ${Math.round(GIVE_UP_MS / 1000)} s${why ? ` (${why})` : ''}: written without it` });
      return '';
    }
    sleepSync(10);
  }
}

// fn(stillMine): stillMine() says whether the lock is still this call's (looked at right before a write; a writer that
// went on without the lock writes without looking)
export function withFileLock(file, fn, { onLock } = {}) {
  const lock = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const mine = takeLock(lock, onLock);
  const stillMine = mine ? () => readHolder(lock)?.token === mine : () => true;
  try {
    return fn(stillMine);
  } finally {
    if (mine && readHolder(lock)?.token === mine) release(lock);
  }
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// The file replaced in one rename (Windows: a reader may hold it for a moment). The new content goes to a new file of a
// name no one can guess (`wx`: never through a link someone put there first). onlyIf(): looked at right before the
// rename; false: nothing is written. -> whether it was written
export function writeJsonFile(file, value, { onlyIf = null } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { flag: 'wx' });
  if (onlyIf && !onlyIf()) {
    fs.rmSync(tmp, { force: true });
    return false;
  }
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return true;
    } catch (err) {
      if (i >= 20) {
        fs.rmSync(tmp, { force: true });
        throw err;
      }
      sleepSync(50);
    }
  }
}

// Read, change and write the file under its lock. `fn(current)` returns the new value (current: `fallback` when the file
// is missing or not JSON); it runs again on the file as it is then when the lock was taken over before the write.
// onLock({ took, why, holder } | { lost, forced, why } | { forced, why }): what the caller logs. -> the new value
export function updateJsonFile(file, fn, fallback = {}, { onLock } = {}) {
  for (let attempt = 1; ; attempt++) {
    const last = attempt >= TRIES;
    let wrote = false;
    const next = withFileLock(
      file,
      (stillMine) => {
        const value = fn(readJsonFile(file, fallback) ?? fallback);
        wrote = writeJsonFile(file, value, { onlyIf: last ? null : stillMine });
        return value;
      },
      { onLock },
    );
    if (wrote) {
      if (last && attempt > 1) onLock?.({ lost: true, forced: true, why: `its lock was taken over ${attempt - 1} times before it wrote: this time it wrote without looking` });
      return next;
    }
    onLock?.({ lost: true, why: 'its lock was taken over before it wrote: the change is made again on the file as it is now' });
  }
}
