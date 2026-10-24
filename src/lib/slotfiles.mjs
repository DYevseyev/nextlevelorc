// Files of the hub's in a worker's slot (FR-013: the agent agy workers run as, .agents/agents/nextlevel-worker.md).
// A slot holds what a task's commits put there, and a commit can make a folder a link (or a junction) to anywhere:
// the file is written only where no link is on the way, so it never lands outside the slot.
import fs from 'node:fs';
import path from 'node:path';

// Writes `text` to `parts` (a path relative to `slot`, as its parts), making the folders on the way. -> true, or false
// when a link, or a file where a folder should be, is on the way (then nothing is written).
export function writeSlotFile(slot, parts, text, { fs: f = fs, path: p = path } = {}) {
  let at = slot;
  for (const part of parts.slice(0, -1)) {
    at = p.join(at, part);
    let st = null;
    try {
      st = f.lstatSync(at);
    } catch {
      st = null; // not there yet
    }
    if (!st) f.mkdirSync(at);
    else if (st.isSymbolicLink() || !st.isDirectory()) return false;
  }
  const file = p.join(slot, ...parts);
  try {
    if (!f.lstatSync(file).isFile()) return false; // a link, or a folder
  } catch {
    // not there yet
  }
  f.writeFileSync(file, text);
  return true;
}
