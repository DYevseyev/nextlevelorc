// The nextlevel folder in the user's home (~/.nextlevel, %USERPROFILE%\.nextlevel): the installed tool
// (tool/), the nextlevel command (bin/) and what nextlevel keeps for this user (state.json).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const defaultHomeDir = () => path.join(os.homedir(), '.nextlevel');
export const homeDir = () => (process.env.NEXTLEVEL_HOME ? path.resolve(process.env.NEXTLEVEL_HOME) : defaultHomeDir());
// Whether this install is a trial's, in a folder of its own (NEXTLEVEL_HOME), not the owner's own
export const trialHome = () => {
  const a = homeDir();
  const b = defaultHomeDir();
  return process.platform === 'win32' ? a.toLowerCase() !== b.toLowerCase() : a !== b;
};

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};

// A small JSON file of key -> value, read on every get so two windows don't overwrite each other's news.
// Written to a file of its own and renamed over the old one, so a reader never gets it half written (and
// then writes back only its own key: the hub follows fixes in it while owner commands run).
export function jsonStore(file) {
  return {
    get: (k) => (file ? readJson(file)?.[k] : undefined),
    set(k, v) {
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ ...(readJson(file) || {}), [k]: v }, null, 2));
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, file);
          return;
        } catch (err) {
          // Windows: another process may have the file open for a moment
          if (i >= 20 || !['EPERM', 'EACCES', 'EBUSY'].includes(err.code)) {
            fs.rmSync(tmp, { force: true });
            throw err;
          }
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
        }
      }
    },
  };
}

// Per-user answers and records: the owner's confirmations (checks), the projects whose hubs ran on this
// PC and the last update check (lib/update.mjs).
export const userState = () => jsonStore(path.join(homeDir(), 'state.json'));
