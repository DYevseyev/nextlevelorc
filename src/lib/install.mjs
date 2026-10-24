// The nextlevel command on this PC. The installer (install.ps1) puts the tool in ~/.nextlevel/tool (or the
// folder NEXTLEVEL_DIR names) and runs `nextlevel _install`, which is this file: it writes the command into
// ~/.nextlevel/bin, puts that folder on the user's PATH (Windows), notes where the tool is (state.json
// "tool", so the installer finds it there next time), and removes a `nextlevel` that `npm link` made for the
// same folder before there was an installer, so there is one command. Running it again repairs all of that.
//
// Windows gets nextlevel.cmd, not a .ps1: PowerShell's default execution policy blocks .ps1 scripts
// (npm link makes one), and a .cmd runs everywhere. An extensionless sh script serves Git Bash.
//
// Since safe updates (docs/design/safe-updates.md) it also puts the newest release in a folder of its own
// (~/.nextlevel/versions/<release>, a worktree of the clone: lib/versions.mjs), copies the launcher (src/launch.mjs) to
// ~/.nextlevel/bin/launch.mjs and points the command at it: the launcher runs the version each project follows. A
// pinned install from before releases moves to the newest release too (the pin was for exactly that move). With no
// release published yet, the command runs the clone's own checkout, as before. git's automatic housekeeping is turned
// off in the clone (KNOWN_ISSUES, "git"). The installer runs this only while no nextlevel runs, which is why it may
// rewrite nextlevel.cmd (cmd.exe reads a running batch file as it goes).
//
// An install can move to another repository (where nextlevel is published now): the installer does it only when the
// owner names the repository it leaves (NEXTLEVEL_MOVE_FROM) and keeps the old one as the git remote nextlevel-previous.
// This command sees that remote (once: state.json "moved", so a run after an installer that stopped half way still
// does it) and keeps what the install had: the releases it saw there
// stay marked as that repository's (never "gone"), field reports keep going to that repository (state.json "reports":
// a project's report never becomes an issue somewhere else without the owner saying so), fixes still waiting there are
// closed with a note (their merge commits never reach the new repository's releases), and the version folders and the
// projects pinned to them stay as they are.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, userState } from './home.mjs';
import { FETCH_ARGS, isReleaseName, judgeTags, leaveSeen, readSeen, recordSeen } from './releases.mjs';
import { addVersion, launcherFile, maintenanceOff, readVersions, runningVersion, updateVersions } from './versions.mjs';
import { runQuiet } from './proc.mjs';
import { TOOL_ROOT } from './project.mjs';

export const REPO_SLUG = 'DYevseyev/nextlevelorc';
export const PACKAGE = 'nextlevel'; // package.json "name": what npm link knows the tool as
// The one PowerShell command that installs, repairs or updates the tool.
export const INSTALL_COMMAND = `irm https://raw.githubusercontent.com/${REPO_SLUG}/main/install.ps1 | iex`;

export const binDir = () => path.join(homeDir(), 'bin');
const IS_WIN = process.platform === 'win32';
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const samePath = (a, b) => (IS_WIN ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));

// The files that make the command, for a tool in `toolRoot`, or (`entry`) for the launcher.
export function shimFiles(dir, toolRoot, platform = process.platform, { entry = path.join(toolRoot, 'bin', 'nextlevel.mjs') } = {}) {
  const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
  const sh = (file) => `#!/bin/sh\n# The nextlevel command, made by the nextlevel installer: it runs the tool in this folder.\nexec node ${sq(file)} "$@"\n`;
  if (platform !== 'win32') return [{ file: path.join(dir, 'nextlevel'), text: sh(entry), mode: 0o755 }];
  const cmd = [
    '@echo off',
    'rem The nextlevel command, made by the nextlevel installer: it runs the tool in the folder below.',
    'where node >nul 2>nul || (echo nextlevel needs Node.js 22 or newer. In PowerShell: winget install -e --id OpenJS.NodeJS.LTS & exit /b 1)',
    `node "${entry.replace(/%/g, '%%')}" %*`,
    '',
  ].join('\r\n');
  return [
    { file: path.join(dir, 'nextlevel.cmd'), text: cmd },
    { file: path.join(dir, 'nextlevel'), text: sh(entry.replace(/\\/g, '/')) }, // Git Bash
  ];
}

// Write the command files; a file that is already right is left alone (cmd.exe reads a running .cmd
// line by line, so rewriting one under a running hub could break it).
export function writeShims(dir = binDir(), toolRoot = TOOL_ROOT, { entry } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  return shimFiles(dir, toolRoot, process.platform, entry ? { entry } : {}).map(({ file, text, mode }) => {
    let old = null;
    try {
      old = fs.readFileSync(file, 'utf8');
    } catch {
      // not there yet
    }
    if (old !== text) fs.writeFileSync(file, text);
    if (mode) fs.chmodSync(file, mode);
    return { file, changed: old !== text };
  });
}

// git in a folder of the tool (the clone), never asking for a login
function gitIn(cwd) {
  return (args, { timeoutMs = 60_000 } = {}) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
    return { ok: r.status === 0, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trim() || r.error?.message || '' };
  };
}

// The launcher in ~/.nextlevel/bin, from `toolRoot`'s src/launch.mjs: a new file renamed into place, only when it
// differs (a launcher that runs is never changed under it). -> whether it changed
export function writeLauncher(toolRoot = TOOL_ROOT, file = launcherFile()) {
  const text = fs.readFileSync(path.join(toolRoot, 'src', 'launch.mjs'), 'utf8');
  let old = null;
  try {
    old = fs.readFileSync(file, 'utf8');
  } catch {
    // not there yet
  }
  if (old === text) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  fs.renameSync(tmp, file);
  return true;
}

// The releases side of _install: the newest release (or NEXTLEVEL_RELEASE, the owner's choice) in its folder, the release
// channel pointed at it, and the launcher. -> { release } | { none: true } | { problem }
export function installRelease({ store, say = () => {} } = {}) {
  const git = gitIn(store);
  const off = maintenanceOff(git);
  if (off.length) say(`(Couldn't turn git's automatic housekeeping off in ${store}: ${off.join(', ')}.)`);
  if (!git(['for-each-ref', '--count=1', 'refs/nextlevel/tags/']).out.trim()) git(FETCH_ARGS, { timeoutMs: 120_000 }); // an installer from before releases fetched tags elsewhere
  const judged = judgeTags(git, { seen: readSeen() });
  try {
    recordSeen(judged.seen);
  } catch {
    // kept next time
  }
  for (const r of judged.refused) say(`(${r.why}.)`);
  const wanted = process.env.NEXTLEVEL_RELEASE;
  if (wanted && !isReleaseName(wanted)) return { problem: `NEXTLEVEL_RELEASE=${wanted} isn't a release's name (v0.3.0)` };
  const rel = wanted ? judged.releases.find((r) => r.name === wanted) : judged.releases[0];
  if (wanted && !rel) return { problem: `there is no release ${wanted}` };
  if (!rel) return { none: true };
  const made = addVersion(git, rel.name, rel.commit, { kind: 'release' });
  if (!made.ok) return { problem: made.message };
  updateVersions((v) => ({ release: rel.name, previous: v.release && v.release !== rel.name ? v.release : v.previous, wentBackFrom: null, store }));
  return { release: rel.name, dir: made.dir };
}

// Windows: add `dir` to the user's PATH (HKCU\Environment), keeping the other entries as they are
// (unexpanded, REG_EXPAND_SZ; [Environment]::SetEnvironmentVariable would expand %VARS% and store
// REG_SZ), then tell Explorer so windows opened from now on have it. Returns 'added' or 'present'.
// `key` is another key under HKEY_CURRENT_USER for tests.
const PATH_SCRIPT = `
$ErrorActionPreference = 'Stop'
$dir = $env:NEXTLEVEL_BIN_DIR
$name = $env:NEXTLEVEL_PATH_KEY
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($name)
try {
  $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  $want = $dir.TrimEnd('\\').ToLowerInvariant()
  foreach ($p in $old.Split(';')) {
    if ([Environment]::ExpandEnvironmentVariables($p).TrimEnd('\\').ToLowerInvariant() -eq $want) { Write-Output 'present'; return }
  }
  $parts = @($old.Split(';') | Where-Object { $_ -ne '' }) + $dir
  $key.SetValue('Path', ($parts -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally { $key.Close() }
if ($name -eq 'Environment') {
  [Environment]::SetEnvironmentVariable('NEXTLEVEL_PATH_CHANGED', '1', 'User')
  [Environment]::SetEnvironmentVariable('NEXTLEVEL_PATH_CHANGED', $null, 'User')
}
Write-Output 'added'
`;
export function addToUserPath(dir, { key = 'Environment' } = {}) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PATH_SCRIPT, 'utf16le').toString('base64')], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60_000,
    env: { ...process.env, NEXTLEVEL_BIN_DIR: dir, NEXTLEVEL_PATH_KEY: key },
  });
  const said = (r.stdout || '').match(/\b(added|present)\b/);
  if (r.status === 0 && said) return said[1];
  throw new Error((r.stderr || r.error?.message || `powershell exit ${r.status}`).split(/\r?\n/).find((l) => l.trim() && !l.startsWith('#<')) || 'powershell failed');
}

const onPath = (dir, envPath = process.env.PATH || process.env.Path || '') =>
  envPath.split(path.delimiter).some((p) => p && (IS_WIN ? path.resolve(p).toLowerCase().replace(/\\$/, '') === path.resolve(dir).toLowerCase() : path.resolve(p) === path.resolve(dir)));

// A `nextlevel` that `npm link` (or npm install -g of a folder) made for this tool: the link in npm's
// global folder and the command files next to it. Only links are ours to remove; a link to another
// folder (someone's own checkout) is reported, not touched.
export function findNpmLink(toolRoot = TOOL_ROOT) {
  const r = runQuiet('npm', ['prefix', '-g'], { timeoutMs: 30_000 });
  const prefix = r.ok && r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop();
  if (!prefix) return null;
  const link = [path.join(prefix, 'node_modules', PACKAGE), path.join(prefix, 'lib', 'node_modules', PACKAGE)].find((p) => {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  });
  if (!link) return null;
  const mentions = (f) => {
    try {
      const st = fs.lstatSync(f);
      return (st.isSymbolicLink() ? fs.readlinkSync(f) : fs.readFileSync(f, 'utf8')).includes(PACKAGE);
    } catch {
      return false;
    }
  };
  const shims = ['nextlevel', 'nextlevel.cmd', 'nextlevel.ps1', path.join('bin', 'nextlevel')].map((f) => path.join(prefix, f)).filter(mentions);
  return { prefix, link, target: real(link), ours: samePath(link, toolRoot), shims };
}

// Only the links are removed: fs.unlinkSync deletes a symlink or a Windows junction itself, never the
// folder it points to.
export function removeNpmLink(found) {
  for (const f of found.shims) fs.unlinkSync(f);
  fs.unlinkSync(found.link);
}

// owner/name of a GitHub repository's URL, or ''
export const githubSlug = (url) => /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?\/?$/i.exec(String(url || '').trim())?.[1] || '';
export const SLUG_RE = /^[\w.-]+\/[\w.-]+$/;

// The install moved from the repository `from` (owner/name) to `to`: what it keeps of the one it left. `state` is
// state.json, `fixes` the fixes started on this PC (fix.mjs fixStore). -> the lines said
export function keepWhatMoved({ from, to, state = userState(), fixes, now = new Date().toISOString() }) {
  const lines = [];
  const marked = leaveSeen(from);
  if (marked.length) lines.push(`The releases this install had from ${from} (${marked.join(', ')}) stay as they are, with their folders: a project pinned to one still runs it.`);
  const reports = state.get('reports');
  if (!reports?.repo) {
    state.set('reports', { repo: from, since: now, why: `this install moved from ${from} to ${to}` });
    lines.push(`Field reports from this PC keep going to ${from}, not ${to}. To send them to ${to} instead, remove "reports" from ${path.join(homeDir(), 'state.json')}.`);
  }
  const waiting = fixes.list().filter((f) => (f.state === 'started' || f.state === 'merged') && f.repo !== to);
  for (const f of waiting) fixes.save({ ...f, state: 'left', leftAt: now, note: `this install moved from ${from} to ${to}, whose releases never have this fix's merge commit` });
  if (waiting.length) lines.push(`Fixes still waiting in ${from} (${waiting.map((f) => `#${f.number}`).join(', ')}) are no longer followed: their merge commits never reach ${to}'s releases.`);
  return lines;
}

// { from, to } when the clone in `store` was moved to another repository (the installer's NEXTLEVEL_MOVE_FROM) and this
// PC hasn't kept what it had yet, else null
export function movedFrom(store, state = userState()) {
  const git = gitIn(store);
  const from = githubSlug(git(['config', '--get', 'remote.nextlevel-previous.url']).out);
  const to = githubSlug(git(['config', '--get', 'remote.origin.url']).out);
  if (!from || !to || from.toLowerCase() === to.toLowerCase()) return null;
  return state.get('moved')?.from === from ? null : { from, to };
}

// `nextlevel _install`. Returns the exit code.
export async function installCommand({ toolRoot = TOOL_ROOT, say = (m) => console.log(m) } = {}) {
  const dir = binDir();
  // The clone: where the installer runs this from (or, run from a version's folder, the clone versions.json names)
  const store = runningVersion(toolRoot) ? readVersions().store || toolRoot : toolRoot;
  const moved = movedFrom(store);
  if (moved) {
    try {
      const { fixStore } = await import('../fix.mjs');
      for (const l of keepWhatMoved({ ...moved, fixes: fixStore() })) say(l);
      userState().set('moved', { ...moved, at: new Date().toISOString() });
    } catch (err) {
      say(`Couldn't note the move from ${moved.from}: ${err.message}.`);
      return 1;
    }
  }
  let rel;
  try {
    rel = installRelease({ store, say });
  } catch (err) {
    rel = { problem: err.message };
  }
  if (rel.problem) {
    say(`Couldn't install a release: ${rel.problem}.`);
    return 1;
  }
  let files;
  try {
    if (rel.release) writeLauncher(rel.dir);
    files = writeShims(dir, store, rel.release ? { entry: launcherFile() } : {});
  } catch (err) {
    say(`Couldn't make the nextlevel command in ${dir}: ${err.message}`);
    return 1;
  }
  const main = files[0].file;
  if (rel.release) say(`${files.some((f) => f.changed) ? 'Made' : 'Checked'} the nextlevel command: ${main}. It runs nextlevel ${rel.release} (${rel.dir}), or the version a project follows.`);
  else say(`${files.some((f) => f.changed) ? 'Made' : 'Checked'} the nextlevel command: ${main} (it runs the tool in ${store}; no release is published yet).`);
  toolRoot = store;
  // Where the tool is: the installer runs again in this folder, and moves it from here when told another
  try {
    const store = userState();
    const was = store.get('tool')?.dir;
    if (!was || !samePath(was, toolRoot)) store.set('tool', { dir: toolRoot, at: new Date().toISOString(), ...(was ? { from: was } : {}) });
  } catch (err) {
    say(`(Couldn't note where nextlevel is installed: ${err.message}. The installer then looks in its usual folder.)`);
  }

  // PATH: without it, only this installer's window knows the command
  let reachable = onPath(dir);
  if (process.env.NEXTLEVEL_NO_PATH === '1') {
    if (!reachable) say(`Left PATH alone (NEXTLEVEL_NO_PATH=1): add ${dir} to it yourself.`);
  } else if (IS_WIN) {
    try {
      const r = addToUserPath(dir, { key: process.env.NEXTLEVEL_PATH_KEY || 'Environment' });
      say(r === 'added' ? `Added ${dir} to your PATH: PowerShell windows opened from now on have the nextlevel command.` : `${dir} is on your PATH.`);
      reachable = true;
    } catch (err) {
      say(`Couldn't add ${dir} to your PATH (${err.message}). Add it yourself: Start menu -> "Edit environment variables for your account" -> Path -> New.`);
    }
  } else if (!reachable) {
    say(`Add ${dir} to your PATH, in a terminal:  echo 'export PATH="$HOME/.nextlevel/bin:$PATH"' >> ~/.profile   then open a new terminal.`);
  }

  // The command npm link made before there was an installer: one nextlevel command, not two
  const npm = findNpmLink(toolRoot);
  if (npm && !npm.ours) {
    say(`Note: npm also has a nextlevel command, for another folder (${npm.target}). If "nextlevel version" doesn't name ${toolRoot}, remove that one: npm rm -g ${PACKAGE}`);
  } else if (npm && reachable) {
    try {
      removeNpmLink(npm);
      say(`Removed the nextlevel command that npm link made earlier (in ${npm.prefix}): it ran this same folder, and the new command replaces it.`);
    } catch (err) {
      say(`Couldn't remove the nextlevel command that npm link made earlier (${err.message}). In PowerShell: npm rm -g ${PACKAGE}`);
    }
  } else if (npm) {
    say(`npm link's nextlevel command (in ${npm.prefix}) runs this folder too; it stays until ${dir} is on your PATH.`);
  }
  return 0;
}
