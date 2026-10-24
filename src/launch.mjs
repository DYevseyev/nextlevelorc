// The nextlevel launcher (safe updates, docs/design/safe-updates.md). `nextlevel _install` copies this file to
// ~/.nextlevel/bin/launch.mjs, and the `nextlevel` command (nextlevel.cmd, and the sh script for Git Bash) runs it.
// Its one job: run the version of nextlevel the current project follows, from that version's own folder.
//   - NEXTLEVEL_VERSION in the environment comes first: the hub puts its own version there for everything it starts,
//     so an agent's `nextlevel`, in a worker's slot or the main checkout, runs the hub's version;
//   - else the project (--project <folder>, or the git root of the current folder) and its channel in channels.json:
//     "pin" runs that release, "candidate" the folder it runs now, and anything else, or no project, the release
//     versions.json names.
// A version folder that isn't there (removed, or quarantined by an antivirus) stops it, with the repair command: it
// never runs another version instead, which may be older than what the project's files need.
//
// It lives outside every version, so it imports nothing of nextlevel's: what it reads (versions.json, channels.json, the
// project key, the version names) is a protocol every version keeps (src/lib/versions.mjs has the same rules, and a test
// holds the two together). It is replaced only by writing a new file and renaming it into place: Node reads a script
// whole when it starts, so a launcher that runs is never changed under it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LAUNCHER_PROTOCOL = 1;
const INSTALL_COMMAND = 'irm https://raw.githubusercontent.com/DYevseyev/nextlevelorc/main/install.ps1 | iex';
const VERSION_NAME = /^(v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})|[A-Za-z0-9][A-Za-z0-9._-]{0,59}@[0-9a-f]{7,12})$/;
const IS_WIN = process.platform === 'win32';

const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
export const projectKey = (root) => (IS_WIN ? real(root).toLowerCase() : real(root));

// The nextlevel folder: NEXTLEVEL_HOME, else the folder this file is in the bin/ of
export function launcherHome(env = process.env, file = fileURLToPath(import.meta.url)) {
  return env.NEXTLEVEL_HOME ? path.resolve(env.NEXTLEVEL_HOME) : path.dirname(path.dirname(file));
}

// The project folder a command is about: --project (before "--"), else the git root above the current folder
export function projectOf(argv, cwd = process.cwd()) {
  const end = argv.includes('--') ? argv.indexOf('--') : argv.length;
  let start = cwd;
  for (let i = 0; i < end; i++) {
    if (argv[i] === '--project' && argv[i + 1] !== undefined) start = path.resolve(cwd, argv[i + 1]);
    else if (argv[i].startsWith('--project=')) start = path.resolve(cwd, argv[i].slice('--project='.length));
  }
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (path.dirname(dir) === dir) return null;
  }
}

// -> { name, dir, why } or { error }
export function chooseVersion({ home, argv = [], cwd = process.cwd(), env = process.env }) {
  const versions = readJson(path.join(home, 'versions.json')) || {};
  const channels = readJson(path.join(home, 'channels.json')) || {};
  let name = null;
  let why = '';
  if (env.NEXTLEVEL_VERSION) {
    name = env.NEXTLEVEL_VERSION;
    why = 'NEXTLEVEL_VERSION';
  } else {
    const root = projectOf(argv, cwd);
    const entry = root && channels.projects && typeof channels.projects === 'object' ? channels.projects[projectKey(root)] : null;
    if (entry?.channel === 'pin') [name, why] = [entry.ref, 'pinned'];
    else if (entry?.channel === 'candidate') [name, why] = [entry.version, `candidate ${entry.ref}`];
    else [name, why] = [versions.release, 'release'];
  }
  if (!name) return { error: `nextlevel has no version to run here: ${path.join(home, 'versions.json')} names none. Repair the install with the installer, in PowerShell:\n  ${INSTALL_COMMAND}` };
  if (typeof name !== 'string' || !VERSION_NAME.test(name)) return { error: `nextlevel was asked to run "${String(name).slice(0, 80)}", which isn't a version's name (${why}). Nothing was run.` };
  // only a version the install made (versions.json's list), never just any folder that happens to be there
  const installed = versions.installed && typeof versions.installed === 'object' ? versions.installed : null;
  // A window an older nextlevel opened (its hub, the orchestrator's) carries its version, gone since an update
  const gone = `This window was opened by nextlevel ${name}, which was updated since (it isn't on this PC any more). Nothing was run: open a new window (or START.cmd again) for the version this project runs now.`;
  if (installed && !Object.hasOwn(installed, name) && why === 'NEXTLEVEL_VERSION') return { error: gone };
  if (installed && !Object.hasOwn(installed, name)) return { error: `nextlevel ${name} (${why}) isn't a version this install made (${path.join(home, 'versions.json')} doesn't list it). Nothing was run. Repair the install with the installer, in PowerShell:\n  ${INSTALL_COMMAND}` };
  const dir = path.join(home, 'versions', name);
  if (!fs.existsSync(path.join(dir, 'bin', 'nextlevel.mjs')) || !fs.existsSync(path.join(dir, '.git'))) {
    // A window an older nextlevel opened (its hub, the orchestrator's) carries its version: gone after an update
    if (why === 'NEXTLEVEL_VERSION' && !installed) return { error: gone };
    return {
      error: [
        `nextlevel ${name} (${why}) isn't on this PC any more: ${dir} is gone or incomplete. It was removed, or an antivirus quarantined its files.`,
        "Nothing was run: another version could be older than what this project's files need.",
        `Restore the files from the antivirus's quarantine, or repair the install with the installer, in PowerShell:\n  ${INSTALL_COMMAND}`,
      ].join('\n'),
    };
  }
  return { name, dir, why };
}

async function launch() {
  const argv = process.argv.slice(2);
  const home = launcherHome();
  const defaultHome = path.join(os.homedir(), '.nextlevel');
  if (!process.env.NEXTLEVEL_HOME && (IS_WIN ? home.toLowerCase() !== defaultHome.toLowerCase() : home !== defaultHome)) process.env.NEXTLEVEL_HOME = home;
  const pick = chooseVersion({ home, argv });
  if (pick.error) {
    console.error(pick.error);
    process.exitCode = 1;
    return;
  }
  process.env.NEXTLEVEL_LAUNCHED = '1';
  await import(pathToFileURL(path.join(pick.dir, 'bin', 'nextlevel.mjs')).href);
}

// Run when it is the program itself (not when a test imports it)
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) await launch();
