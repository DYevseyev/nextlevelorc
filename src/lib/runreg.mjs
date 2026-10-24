// The run registry (safe updates, docs/design/safe-updates.md, the review's change 5): every nextlevel process that can
// writes ~/.nextlevel/update/run/<pid>.json when it starts (its version, project and command) and removes it when it
// ends. The one-click update reads it to list what still runs the old version (a long `nextlevel wait`, an open menu),
// and the pruning of old version folders never removes one a process runs from.
//
// Best effort, and it never fails a command: Codex's sandbox can't write the home folder, so a command run there isn't
// listed. That is why the update waits for the rounds and windows such commands belong to, not for the registry. A
// record whose process is gone is stale and is dropped by whoever reads it. A pid another program has taken since
// would keep a record alive; the start time in it lets a reader that cares tell (only the update shows them).
import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from './home.mjs';

export const runDir = () => path.join(homeDir(), 'update', 'run');
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

let mine = null;
// Register this process. -> whether it could (never throws)
export function register({ version = null, project = null, command = '' } = {}) {
  try {
    fs.mkdirSync(runDir(), { recursive: true });
    const file = path.join(runDir(), `${process.pid}.json`);
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), version, project, command: String(command).slice(0, 40) }));
    mine = file;
    process.once('exit', unregister);
    return true;
  } catch {
    return false;
  }
}
export function unregister() {
  if (!mine) return;
  try {
    fs.rmSync(mine, { force: true });
  } catch {
    // stale: dropped by the next reader
  }
  mine = null;
}

// The processes registered and still running: [{ pid, startedAt, version, project, command }]. Stale records go.
export function running() {
  let names = [];
  try {
    names = fs.readdirSync(runDir());
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    if (!/^\d+\.json$/.test(n)) continue;
    const file = path.join(runDir(), n);
    let rec = null;
    try {
      rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // half written, or not ours
    }
    if (!rec || !Number.isSafeInteger(rec.pid) || !alive(rec.pid)) {
      try {
        fs.rmSync(file, { force: true });
      } catch {
        // left for the next reader
      }
      continue;
    }
    if (rec.pid !== process.pid) out.push(rec);
  }
  return out;
}
// Whether a process runs from the version `name`
export const runsVersion = (name, list = running()) => list.some((r) => r.version === name);
