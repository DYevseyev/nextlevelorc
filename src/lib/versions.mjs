// Each version of the tool in use is a folder of its own (safe updates, docs/design/safe-updates.md): a git worktree of
// the tool's clone in ~/.nextlevel/versions/<name>, where <name> is a release (v0.3.0) or, for a candidate, the branch
// and its commit (main@1a2b3c4). Nothing ever changes the files of a version folder: an update makes a new one and
// points at it, and going back points at the old one. The `nextlevel` command runs the launcher (src/launch.mjs, copied
// to ~/.nextlevel/bin/launch.mjs), which runs the version the current project follows.
//
// What is kept, in the nextlevel folder (lib/home.mjs), each file under its lock (lib/filelock.mjs), never in state.json
// (jsonStore there merges without a lock, and two versions may write at once):
//   versions.json  { protocol, release, previous, wentBackFrom, store, installed: { <name>: { commit, kind, at } } }:
//                  the versions here, which one the release channel runs, the one before it (for going back), and the
//                  tool's clone (`store`, the folder the installer made: its own checkout runs nothing once there is a
//                  version, and hands over to the launcher)
//   channels.json  { protocol, projects: { <project key>: { channel, ref, version, setAt } } }: what each project
//                  follows. A project not in it follows "release". "pin" runs the release `ref`; "candidate" follows the
//                  branch `ref`, and `version` is the folder it runs now. Only the owner writes it (the Tools page, or
//                  `nextlevel channel` in their own window): it is outside every project, where Codex's sandbox can't
//                  write (an agent without a sandbox can: KNOWN_ISSUES).
// The launcher reads both files with code of its own (it lives outside every version), so their shape and the project
// key below are a protocol every version keeps.
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, updateJsonFile } from './filelock.mjs';
import { homeDir } from './home.mjs';
import { branchNameProblem } from './push.mjs';
import { RELEASE_NAME } from './releases.mjs';

export const PROTOCOL = 1;
// A version's folder name: a release, or <branch, made safe>@<commit>. Nothing else is ever a folder under versions/.
export const VERSION_NAME = /^(v(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})|[A-Za-z0-9][A-Za-z0-9._-]{0,59}@[0-9a-f]{7,12})$/;
export const CHANNELS = ['release', 'pin', 'candidate'];
export const versionsDir = () => path.join(homeDir(), 'versions');
export const versionsFile = () => path.join(homeDir(), 'versions.json');
export const channelsFile = () => path.join(homeDir(), 'channels.json');
export const launcherFile = () => path.join(homeDir(), 'bin', 'launch.mjs');

const IS_WIN = process.platform === 'win32';
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
// A project's key in channels.json: its real path, in lower case on Windows (the launcher computes the same)
export const projectKey = (root) => (IS_WIN ? real(root).toLowerCase() : real(root));
const samePath = (a, b) => (IS_WIN ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));

// ---------- versions.json ----------
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const validName = (n) => typeof n === 'string' && VERSION_NAME.test(n);
export function readVersions(file = versionsFile()) {
  const v = readJsonFile(file, null);
  const installed = {};
  if (isObj(v?.installed)) {
    for (const [name, rec] of Object.entries(v.installed)) if (validName(name) && isObj(rec) && /^[0-9a-f]{40}$/.test(String(rec.commit))) installed[name] = rec;
  }
  return {
    protocol: Number(v?.protocol) || PROTOCOL,
    release: validName(v?.release) ? v.release : null,
    previous: validName(v?.previous) ? v.previous : null,
    wentBackFrom: validName(v?.wentBackFrom) ? v.wentBackFrom : null,
    store: typeof v?.store === 'string' ? v.store : null,
    installed,
  };
}
export const updateVersions = (fn, file = versionsFile()) => updateJsonFile(file, (cur) => ({ ...cur, ...fn(readVersions(file)), protocol: PROTOCOL }), {});

// ---------- channels.json ----------
export function readChannels(file = channelsFile()) {
  const v = readJsonFile(file, null);
  const projects = {};
  if (isObj(v?.projects)) {
    for (const [key, e] of Object.entries(v.projects)) {
      if (!isObj(e) || !CHANNELS.includes(e.channel)) continue;
      if (e.channel === 'pin' && !RELEASE_NAME.test(String(e.ref))) continue;
      if (e.channel === 'candidate' && (branchNameProblem(e.ref) || !validName(e.version))) continue;
      projects[key] = e;
    }
  }
  return { protocol: Number(v?.protocol) || PROTOCOL, projects };
}
// The project's channel: { channel, ref?, version?, setAt? }; "release" when nothing is set
export const channelOf = (root, channels = readChannels()) => channels.projects[projectKey(root)] || { channel: 'release' };
// `entry` null: back to the release channel (the entry goes)
export function setChannel(root, entry, file = channelsFile()) {
  const key = projectKey(root);
  return updateJsonFile(
    file,
    (cur) => {
      const projects = isObj(cur?.projects) ? { ...cur.projects } : {};
      if (entry) projects[key] = { ...entry, setAt: new Date().toISOString() };
      else delete projects[key];
      return { ...cur, protocol: PROTOCOL, projects };
    },
    {},
  );
}

// ---------- which version ----------
// The folder of a version, only for a valid name: never a path read from a file
export function versionPath(name) {
  if (!validName(name)) throw new Error(`"${name}" isn't a version's name`);
  return path.join(versionsDir(), name);
}
// The version a project runs: its channel's, or the release's. null: none installed (an install from before releases)
export function versionFor(root, { versions = readVersions(), channels = readChannels() } = {}) {
  const c = root ? channelOf(root, channels) : { channel: 'release' };
  if (c.channel === 'pin') return c.ref;
  if (c.channel === 'candidate') return c.version;
  return versions.release;
}
// The version this code is, from where it runs: the name of its folder under versions/, or null (the store's checkout,
// a developer's checkout, the tests')
export function runningVersion(toolRoot) {
  const dir = path.dirname(toolRoot);
  return samePath(dir, versionsDir()) && validName(path.basename(toolRoot)) ? path.basename(toolRoot) : null;
}
// A candidate's folder name: its branch made safe for a folder, and its commit
export function candidateName(branch, commit) {
  const safe = String(branch).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60) || 'branch';
  return `${safe}@${String(commit).slice(0, 7)}`;
}
// Versions to keep: what each channel runs, the previous release (for going back), and pins
export function keptVersions(versions = readVersions(), channels = readChannels()) {
  const keep = new Set([versions.release, versions.previous].filter(Boolean));
  for (const e of Object.values(channels.projects)) keep.add(e.channel === 'pin' ? e.ref : e.channel === 'candidate' ? e.version : null);
  keep.delete(null);
  keep.delete(undefined);
  return keep;
}

// ---------- the tool's clone ----------
// git's automatic housekeeping off in the clone (worktrees share its config): a detached repack outlives the git
// command that started it, keeps files open and blocks moves and deletes on Windows (KNOWN_ISSUES, "git").
// Housekeeping happens in the foreground instead, when nextlevel chooses.
export const MAINTENANCE_OFF = [
  ['gc.auto', '0'],
  ['gc.autoDetach', 'false'],
  ['maintenance.auto', 'false'],
  ['maintenance.autoDetach', 'false'],
];
export function maintenanceOff(git) {
  const failed = [];
  for (const [k, v] of MAINTENANCE_OFF) if (!git(['config', '--local', k, v]).ok) failed.push(k);
  return failed;
}

// Put the version `name` at `commit` in its folder (a worktree of the clone, detached), unless it is there already.
// git(args) runs git in the clone. -> { ok, dir, message? }
export function addVersion(git, name, commit, { kind = 'release' } = {}) {
  const dir = versionPath(name);
  if (fs.existsSync(path.join(dir, '.git'))) {
    const head = git(['-C', dir, 'rev-parse', 'HEAD']);
    if (head.ok && head.out.trim() === commit) {
      updateVersions((v) => ({ installed: { ...v.installed, [name]: v.installed[name] || { commit, kind, at: new Date().toISOString() } } }));
      return { ok: true, dir };
    }
    return { ok: false, dir, message: `${dir} is there already, at another commit: nextlevel never changes a version's folder (remove it with git worktree remove "${dir}" once nothing runs from it)` };
  }
  if (fs.existsSync(dir)) return { ok: false, dir, message: `${dir} is there already and isn't a version nextlevel made: move it away, then try again` };
  fs.mkdirSync(versionsDir(), { recursive: true });
  git(['worktree', 'prune']);
  const r = git(['worktree', 'add', '--detach', '--quiet', dir, commit]);
  if (!r.ok) return { ok: false, dir, message: `git worktree add failed: ${String(r.err || r.out).split(/\r?\n/)[0]}` };
  updateVersions((v) => ({ installed: { ...v.installed, [name]: { commit, kind, at: new Date().toISOString() } } }));
  return { ok: true, dir };
}

// Remove version folders nothing points at any more. A folder in use (Windows keeps one open while a process runs from
// it) is left for the next time. -> the names removed
export function pruneVersions(git, { keep = keptVersions(), running = () => false } = {}) {
  const removed = [];
  const v = readVersions();
  for (const name of Object.keys(v.installed)) {
    if (keep.has(name) || running(name)) continue;
    const dir = versionPath(name);
    const r = fs.existsSync(dir) ? git(['worktree', 'remove', '--force', dir]) : { ok: true };
    // (git can leave part of a folder it couldn't remove whole, a file in use on Windows: once its .git is gone it is no
    // version any more; what is left goes when it can)
    if (!r.ok && fs.existsSync(path.join(dir, '.git'))) continue;
    if (!r.ok) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // left for the next time
      }
      git(['worktree', 'prune']);
    }
    removed.push(name);
  }
  if (removed.length) updateVersions((cur) => ({ installed: Object.fromEntries(Object.entries(cur.installed).filter(([n]) => !removed.includes(n))) }));
  return removed;
}
