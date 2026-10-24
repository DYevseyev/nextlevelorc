// Whether this process runs inside Codex's sandbox (FR-004 #2). The orchestrator runs there, and a
// `nextlevel doctor` it ran said gh was signed out and Docker, Codex and agy weren't there: the sandbox
// hides the owner's sign-ins and programs, and has no network. What Codex sets (codex-rs, 0.157):
//   CODEX_THREAD_ID           every command Codex runs, sandboxed or not (with CODEX_SESSION_ID, CODEX_CI=1)
//   CODEX_SANDBOX=seatbelt    macOS's sandbox
//   CODEX_SANDBOX_NETWORK_DISABLED=1   any OS, when the sandbox has no network
//   SBX_NONET_ACTIVE=1        Windows' unelevated sandbox, without network
// Windows' elevated sandbox with network sets none of those, but like every workspace-write sandbox it
// can't write the project's .git folder: under Codex, that is the sign.
import fs from 'node:fs';
import path from 'node:path';

export const SANDBOX_NAME = "Codex's sandbox";

// null, or { name, signs }. gitWritable() is asked only when Codex ran this (it writes a probe into .git).
export function detectSandbox(env = process.env, { gitWritable = () => true } = {}) {
  const signs = [];
  if (env.CODEX_SANDBOX) signs.push(`CODEX_SANDBOX=${env.CODEX_SANDBOX}`);
  if (env.CODEX_SANDBOX_NETWORK_DISABLED === '1') signs.push('no network: CODEX_SANDBOX_NETWORK_DISABLED');
  if (env.SBX_NONET_ACTIVE === '1') signs.push('no network: SBX_NONET_ACTIVE');
  const codex = !!(env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || env.CODEX_CI === '1');
  if (!signs.length && codex && gitWritable() === false) signs.push("can't write the project's .git folder");
  return signs.length ? { name: SANDBOX_NAME, signs } : null;
}

// Can this process create a file in the project's .git folder? (A folder that isn't there: true.)
export function canWriteGit(root) {
  const dir = root && path.join(root, '.git');
  try {
    if (!dir || !fs.statSync(dir).isDirectory()) return true;
  } catch {
    return true;
  }
  const probe = path.join(dir, `nextlevel-write-probe-${process.pid}`);
  try {
    fs.writeFileSync(probe, '', { flag: 'wx' });
    fs.rmSync(probe, { force: true });
    return true;
  } catch (err) {
    return !['EPERM', 'EACCES', 'EROFS'].includes(err.code);
  }
}

// What the hub and the other programs that need the owner's own access say inside the sandbox.
export const OUTSIDE_ONLY = (what) =>
  `${what} can't run inside ${SANDBOX_NAME}: it writes the project's .git folder, starts workers and uses the network. ` +
  'Owner: run it in a normal PowerShell window, in the project folder (START.cmd -> 4 starts the hub).';
