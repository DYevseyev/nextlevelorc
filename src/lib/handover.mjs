// The tool's clone (the "store") keeps a checkout of its own, and START.cmd names its bin/nextlevel.mjs as its last way
// in. Once there are version folders, code run from that checkout hands over to the launcher, which runs the version the
// project follows (src/launch.mjs). Only the store hands over: a version's own folder, a developer's checkout and the
// tests' run as they are. Never for _install (the installer runs it from the store to set the versions up), and never
// twice (NEXTLEVEL_LAUNCHED).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { TOOL_ROOT } from './project.mjs';
import { launcherFile, readVersions, runningVersion } from './versions.mjs';

const IS_WIN = process.platform === 'win32';
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const same = (a, b) => (IS_WIN ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));

// -> true when it handed over (the launcher ran the command)
export async function storeHandover(argv, { toolRoot = TOOL_ROOT } = {}) {
  if (process.env.NEXTLEVEL_LAUNCHED === '1' || argv[0] === '_install' || runningVersion(toolRoot)) return false;
  const v = readVersions();
  if (!v.release || !v.store || !same(v.store, toolRoot) || !fs.existsSync(launcherFile())) return false;
  const launcher = await import(pathToFileURL(launcherFile()).href);
  if (typeof launcher.chooseVersion !== 'function') return false;
  const home = path.dirname(path.dirname(launcherFile()));
  const pick = launcher.chooseVersion({ home, argv });
  if (pick.error) {
    console.error(pick.error);
    process.exitCode = 1;
    return true;
  }
  process.env.NEXTLEVEL_LAUNCHED = '1';
  await import(pathToFileURL(path.join(pick.dir, 'bin', 'nextlevel.mjs')).href);
  return true;
}
