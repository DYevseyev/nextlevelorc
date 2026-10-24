// Git's index lock, as nextlevel meets it. Several processes run git in the same checkout at once: the hub commits a
// worker's changes in its slot while the dashboard (another process) reads that slot every few seconds, the owner's
// editor polls the main checkout, a worker runs git itself. A plain `git status` refreshes the index and, to write
// it back, takes index.lock for a moment; a `git add -A` or `git commit` that comes then fails ("Unable to create
// '.../index.lock': File exists"). That way the hub once failed to commit a finished worker's changes: its
// `add -A` failed unnoticed, and the commit said "nothing added to commit", which hid why:
// - what only reads runs with GIT_OPTIONAL_LOCKS=0: it never takes the lock (git skips the index refresh);
// - what writes is run again, for a few seconds, while it fails on a held index.lock. A git command that couldn't
//   take the lock changed nothing, so running it again is safe. Git's messages are in the owner's language, but
//   the lock's path is in them as it is, so "index.lock" in the output is how a held lock is told apart.
// A lock still held after that (a git that crashed leaves its lock behind) is a failure the caller reports.

// For every git that only reads (and harmless for one that writes: its own locks aren't optional)
export const NO_OPTIONAL_LOCKS = { GIT_OPTIONAL_LOCKS: '0' };
export const readEnv = (env = process.env) => ({ ...env, ...NO_OPTIONAL_LOCKS });

export const LOCK_WAIT_MS = 10_000;
const STEP_MS = 200;
// How long a command waits for a held index.lock (NEXTLEVEL_GIT_LOCK_WAIT_MS, for tests: milliseconds)
export function lockWaitMs(env = process.env) {
  const v = env.NEXTLEVEL_GIT_LOCK_WAIT_MS;
  const n = Number(v);
  return v !== undefined && v !== '' && Number.isFinite(n) && n >= 0 ? n : LOCK_WAIT_MS;
}
// Whether git's output says it found index.lock held
export const lockHeld = (out) => /index\.lock\b/.test(String(out || ''));

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Runs `once()` (-> { ok, out, text? }; `text`: all it printed, where `out` is stdout alone) again while it fails
// on a held index.lock, up to `waitMs`. Its last result, with `tries` and `waited` (ms): a caller logs the wait,
// and reports a lock still held.
export function retryOnLock(once, { waitMs = lockWaitMs(), sleep = sleepSync, clock = Date.now } = {}) {
  const start = clock();
  for (let tries = 1; ; tries++) {
    const r = once();
    const waited = clock() - start;
    if (r.ok || !lockHeld(r.text ?? r.out) || waited >= waitMs) return { ...r, tries, waited, lockHeld: !r.ok && lockHeld(r.text ?? r.out) };
    sleep(STEP_MS);
  }
}
export async function retryOnLockAsync(once, { waitMs = lockWaitMs(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), clock = Date.now } = {}) {
  const start = clock();
  for (let tries = 1; ; tries++) {
    const r = await once();
    const waited = clock() - start;
    if (r.ok || !lockHeld(r.text ?? r.out) || waited >= waitMs) return { ...r, tries, waited, lockHeld: !r.ok && lockHeld(r.text ?? r.out) };
    await sleep(STEP_MS);
  }
}

// What a caller says about a lock that was never let go
export const lockNote = (r) => (r?.lockHeld ? ` (git's index.lock was held for ${Math.round(r.waited / 1000)} s: another git runs there, or one that stopped left it behind)` : '');
