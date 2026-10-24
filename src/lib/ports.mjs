// Port offsets for worker slots, unique across every project on this PC (FR-004 #7). Services in a slot
// add NEXTLEVEL_PORT_OFFSET to their ports. It used to be 100 × the slot number in every project, so two
// projects' hubs put their workers' services on the same ports. Now each project gets a block number the
// first time its hub starts a worker, kept in ~/.nextlevel/state.json ("portBlocks", by project folder):
// slot n of block b gets b × 1000 + n × 100. Block 0 is 100, 200, ... as before, so the first project
// keeps its ports. A block whose project folder is gone is given out again.
import fs from 'node:fs';
import path from 'node:path';
import { defaultHomeDir, homeDir, jsonStore } from './home.mjs';

export const BLOCK_SIZE = 1000;
export const SLOT_STEP = 100; // up to 6 slots: 100..600 stays inside a block
export const MAX_BLOCKS = 40; // 40 × 1000 + 600: a service on port 9999 still ends below 65536
export const slotOffset = (block, n) => block * BLOCK_SIZE + n * SLOT_STEP;

// The same folder, however it is written (Windows: any case, either slash). Project roots come from
// findProject, which already resolves links and short names.
export const projectKey = (root, platform = process.platform) => (platform === 'win32' ? path.win32.resolve(root).toLowerCase() : path.posix.resolve(root));

// A lock file around the read-modify-write, so two hubs starting at once don't take the same block.
function withLock(file, fn) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const until = Date.now() + 5000;
  for (;;) {
    try {
      fs.closeSync(fs.openSync(file, 'wx'));
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs > 10_000) fs.rmSync(file, { force: true }); // left by a crash
      } catch {
        // gone meanwhile
      }
      if (Date.now() > until) throw new Error(`another nextlevel holds ${file}; if none runs, delete that file`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// The project's block: the one it has, or the lowest one no existing project folder holds.
// `assign: false` only looks (the doctor): null when the project has none yet.
export function portBlock(root, { home = homeDir(), assign = true, exists = fs.existsSync } = {}) {
  const store = jsonStore(path.join(home, 'state.json'));
  const key = projectKey(root);
  const mine = store.get('portBlocks')?.[key];
  if (Number.isInteger(mine) || !assign) return Number.isInteger(mine) ? mine : null;
  return withLock(path.join(home, 'ports.lock'), () => {
    const blocks = store.get('portBlocks') || {};
    if (Number.isInteger(blocks[key])) return blocks[key];
    const taken = new Set(Object.entries(blocks).filter(([k, b]) => k !== key && Number.isInteger(b) && exists(k)).map(([, b]) => b));
    // A trial install (NEXTLEVEL_HOME) never takes a block the owner's own install gave a project: it reads that one's
    // blocks, never writes them (docs/design/safe-updates.md)
    if (home !== defaultHomeDir()) {
      for (const [k, b] of Object.entries(jsonStore(path.join(defaultHomeDir(), 'state.json')).get('portBlocks') || {})) if (k !== key && Number.isInteger(b) && exists(k)) taken.add(b);
    }
    const free = [...Array(MAX_BLOCKS).keys()].find((b) => !taken.has(b));
    if (free === undefined) {
      throw new Error(`all ${MAX_BLOCKS} port blocks for worker slots are taken by projects on this PC: remove the ones you no longer use from "portBlocks" in ${path.join(home, 'state.json')}`);
    }
    const kept = Object.fromEntries(Object.entries(blocks).filter(([k]) => exists(k)));
    store.set('portBlocks', { ...kept, [key]: free });
    return free;
  });
}

// Every project's block, for the doctor: [{ root, block, exists }].
export function portBlocks({ home = homeDir(), exists = fs.existsSync } = {}) {
  const blocks = jsonStore(path.join(home, 'state.json')).get('portBlocks') || {};
  return Object.entries(blocks).map(([root, block]) => ({ root, block, exists: exists(root) }));
}
