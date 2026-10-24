// nextlevel updates itself to releases (safe updates, docs/design/safe-updates.md). The installer makes the tool's
// folder a clone of its repository (the "store"); each version in use is a folder of its own, a worktree of that clone
// in ~/.nextlevel/versions/<name> (lib/versions.mjs), and the `nextlevel` command runs the launcher (src/launch.mjs),
// which runs the version the current project follows: the release channel (the default), a pinned release, or a
// candidate branch (for trying a change in a test project). A release is an annotated tag on main that passes the checks
// in lib/releases.mjs; a merge alone never reaches a project.
//
// Only the owner updates: the dashboard's one click, or `nextlevel update` in their own window (it refuses in an agent's
// session, plain or not). Both start the same updater (src/updater.mjs), which waits for running work, stops the hubs
// and dashboards, switches and starts them again. An update never changes the files of a version folder: it makes the
// new version's folder and points the channel at it, and going back points at the old one.
//
// Nothing installs at a command's start any more: owner commands only say, in one line, that a release is available
// (from update/available.json, which the hubs and the dashboard refresh: checkReleases). An install from before
// releases (the clone's own checkout runs, no versions.json release) keeps running as it is until the installer moves
// it to the first release.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { commandArgs } from './commands.mjs';
import { readJsonFile, updateJsonFile } from './filelock.mjs';
import { homeDir, userState } from './home.mjs';
import { INSTALL_COMMAND } from './install.mjs';
import { resolveBin } from './proc.mjs';
import { TOOL_ROOT } from './project.mjs';
import { FETCH_ARGS, isReleaseName, judgeTags, newerReleases, readSeen, recordSeen } from './releases.mjs';
import { agentSession, ownerOnly } from './session.mjs';
import { addVersion, candidateName, channelOf, maintenanceOff, readChannels, readVersions, runningVersion, setChannel, versionFor } from './versions.mjs';
import { branchNameProblem } from './push.mjs';

const say = (m) => console.log(m);
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

export const updatesOff = () => !['', '0', undefined].includes(process.env.NEXTLEVEL_NO_UPDATE);
// What nextlevel set NEXTLEVEL_NO_UPDATE to for what its commands start, before releases (kept: an older hub's windows
// may still carry it). Any other value is the owner's, who wants no update checks or notices at all.
export const CHECKED = 'checked';
export const ownerSaysNoUpdates = () => updatesOff() && process.env.NEXTLEVEL_NO_UPDATE !== CHECKED;
export const isClone = (root = TOOL_ROOT) => fs.existsSync(path.join(root, '.git'));

// git in the tool's folder (a version's folder is a worktree of the same repository). It never asks for a login: a
// prompt would hang a command.
export function toolGit(args, { timeoutMs = 60_000, cwd = TOOL_ROOT } = {}) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  const err = (r.stderr || '').trim() || (r.error?.code === 'ETIMEDOUT' ? `no answer in ${timeoutMs / 1000} s` : r.error?.message || '');
  return { ok: r.status === 0, out: (r.stdout || '').trimEnd(), err };
}

// What the tool's checkout is, from git alone (no network). `git(args)` runs git in the tool's folder and returns
// { ok, out }; the doctor passes its own (checks/install.mjs).
export function toolState(git, { clone = true, full = true } = {}) {
  if (!clone) return { clone: false };
  const val = (args) => {
    const r = git(args);
    return r.ok ? String(r.out).trim() : '';
  };
  const branch = val(['symbolic-ref', '--short', '-q', 'HEAD']);
  const s = { clone: true, branch, head: val(['rev-parse', '--short', 'HEAD']), tag: branch ? '' : val(['describe', '--tags', '--exact-match', 'HEAD']) };
  if (!full) return s;
  const upstream = branch ? val(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']) : '';
  const count = (range) => (upstream ? Number(val(['rev-list', '--count', range])) || 0 : 0);
  return {
    ...s,
    upstream,
    defaultBranch: val(['symbolic-ref', '--short', '-q', 'refs/remotes/origin/HEAD']).replace(/^origin\//, '') || 'main',
    // tracked files only: npm link, for one, leaves an untracked package-lock.json
    changed: String(git(['status', '--porcelain', '--untracked-files=no']).out || '')
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => l.replace(/^[ MADRCUT?!]{1,2} /, '')),
    behind: count('HEAD..@{u}'),
    ahead: count('@{u}..HEAD'),
  };
}
export const describeState = (s) => (s.branch ? `${s.branch} @ ${s.head}` : `pinned at ${s.tag ? `${s.tag}, ${s.head}` : s.head}`);

// The version this code is: { name, commit, channel words } when it runs from a version folder, else null
export function thisVersion() {
  const name = runningVersion(TOOL_ROOT);
  if (!name) return null;
  const rec = readVersions().installed[name];
  return { name, commit: rec?.commit || toolGit(['rev-parse', 'HEAD']).out.trim(), kind: rec?.kind || (isReleaseName(name) ? 'release' : 'candidate') };
}
// "v0.3.0 (release)", "main@1a2b3c4 (candidate)", or for an install from before releases "main @ 1a2b3c4"
export function describeTool() {
  const v = thisVersion();
  if (v) return `${v.name} (${v.kind})`;
  return isClone() ? describeState(toolState(toolGit, { full: false })) : '';
}
// The new layout is in place: a version folder runs, or the launcher and a release exist
export const hasVersions = () => !!readVersions().release;

// ---------- is nextlevel at work? ----------
// Why nextlevel must not change under this project now, or '': its hub runs, or one of its workers does.
export function activity(root) {
  const dir = [path.join(root, '.nextlevel')].find((d) => fs.existsSync(d));
  if (!dir) return '';
  const hub = readJson(path.join(dir, 'hub.json'));
  if (hub && alive(hub.pid) && Date.now() - Date.parse(hub.heartbeatAt || 0) < 90_000) return `the hub is running for ${root}`;
  const jobs = path.join(dir, 'jobs');
  let ids = [];
  try {
    ids = fs.readdirSync(jobs);
  } catch {
    // no jobs yet
  }
  for (const id of ids) {
    const s = readJson(path.join(jobs, id, 'status.json'));
    if (s?.state !== 'running') continue;
    const run = readJson(path.join(jobs, id, 'run.json'));
    if (run ? !run.endedAt && alive(run.pid) : Date.now() - Date.parse(s.startedAt || 0) < 5 * 60_000) return `worker ${id} is running in ${root}`;
  }
  return '';
}
// Every owner command in a project records it, so an update started anywhere knows every project this PC works on.
// A project whose folder or nextlevel.json is gone drops out; none is dropped for being old (safe updates).
export function rememberProject(root) {
  const store = userState();
  const known = (store.get('projects') || []).filter((r) => typeof r === 'string' && r !== root && fs.existsSync(path.join(r, 'nextlevel.json')));
  store.set('projects', [root, ...known].slice(0, 200));
}
// `except`: a project whose own activity doesn't count. `only`: the projects whose activity counts (the release
// channel's update waits only for the projects that follow releases).
export function busy(roots = [], { except = null, only = () => true } = {}) {
  const all = [...new Set([...roots, ...(userState().get('projects') || [])])].filter((r) => r !== except && only(r));
  return all.filter((r) => r && fs.existsSync(r)).map(activity).filter(Boolean);
}

// ---------- talking to GitHub ----------
// github.com over https gets the GitHub CLI's login, the way gh runs git itself: the repository is private, and a git
// that isn't signed in would otherwise ask (or pop up a login window). Tags go to nextlevel's own namespace
// (lib/releases.mjs FETCH_ARGS): a tag that moved on GitHub never makes this fail.
export function fetchTool(timeoutMs = 60_000) {
  const url = toolGit(['remote', 'get-url', 'origin']).out.trim();
  const gh = /^https:\/\/github\.com\//i.test(url) && resolveBin('gh');
  const auth = gh ? ['-c', 'credential.helper=', '-c', `credential.helper=!"${gh.file.replace(/\\/g, '/')}" auth git-credential`] : [];
  return toolGit([...auth, ...FETCH_ARGS], { timeoutMs });
}
function why(r) {
  const text = String(r.err || r.out || '').replace(/(\/\/)[^/@\s]+@/g, '$1***@');
  if (/could not read (Username|Password)|Authentication failed|terminal prompts disabled|Repository not found|\b40[13]\b/i.test(text)) {
    return 'GitHub did not let this PC read the nextlevel repository: sign in with gh auth login (PowerShell), then try again';
  }
  if (/Could not resolve host|unable to access|timed out|no answer in|Connection refused|network/i.test(text)) return `no connection to GitHub (${firstLine(text)})`;
  return firstLine(text) || 'git fetch failed';
}
const record = (r) => userState().set('update', { at: new Date().toISOString(), ...r });

// ---------- what is available (update/available.json) ----------
// One record for the PC, refreshed by whoever fetched last (a hub at its start and every 6 hours, a dashboard at its
// start; never more often than that between them), read by Home, the doctor and the start of an owner command.
export const AVAILABLE_EVERY_MS = 6 * 60 * 60_000;
export const availableFile = () => path.join(homeDir(), 'update', 'available.json');
export const readAvailable = () => readJsonFile(availableFile(), null);
// The release the release channel runs (whatever version this code is: the update may run from the one it leaves); for
// an install from before releases, its HEAD if that is exactly a release
function installedRelease(releases) {
  const v = readVersions();
  if (v.release && v.installed[v.release]) return { name: v.release, commit: v.installed[v.release].commit };
  const head = toolGit(['rev-parse', 'HEAD']).out.trim();
  const at = releases.find((r) => r.commit === head);
  return at ? { name: at.name, commit: head } : { name: null, commit: head };
}
const noteView = (r) => ({ name: r.name, commit: r.commit, notes: r.notes });

// Fetch (unless `fetch` is false), judge the tags, and write available.json. `ifOlderThan`: skip the fetch when the
// record is fresher than that. -> the record
export function checkReleases({ fetch = true, ifOlderThan = 0, timeoutMs = 60_000 } = {}) {
  const was = readAvailable();
  if (ifOlderThan && was?.at && Date.now() - Date.parse(was.at) < ifOlderThan) return was;
  if (!isClone()) return was;
  let ok = true;
  const lookedAt = new Date().toISOString(); // (a look that started earlier and ends later never replaces this one's record)
  let detail = '';
  if (fetch) {
    const f = fetchTool(timeoutMs);
    if (!f.ok) [ok, detail] = [false, why(f)];
  }
  const judged = judgeTags(toolGit, { seen: readSeen() });
  try {
    recordSeen(judged.seen);
  } catch {
    // kept next time
  }
  const installed = installedRelease(judged.releases);
  const newer = newerReleases(toolGit, judged.releases, installed);
  const versions = readVersions();
  // what the candidates (any project on one) could move to: the branch's new commits
  const candidates = {};
  for (const e of Object.values(readChannels().projects)) {
    if (e.channel !== 'candidate' || candidates[e.ref]) continue;
    const tip = toolGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${e.ref}^{commit}`]).out.trim();
    const at = versions.installed[e.version]?.commit || '';
    const subjects = tip && at && tip !== at ? toolGit(['log', '--no-merges', '--format=%s', '-n', '20', `${at}..${tip}`]).out.split(/\r?\n/).filter(Boolean) : [];
    candidates[e.ref] = { tip, at, subjects, gone: !tip };
  }
  const rec = {
    protocol: 1,
    at: new Date().toISOString(),
    lookedAt,
    ok,
    detail,
    installed: installed.name,
    newest: judged.releases[0] ? noteView(judged.releases[0]) : null,
    newer: newer.map(noteView),
    wentBackFrom: versions.wentBackFrom,
    refused: judged.refused,
    vanished: judged.vanished,
    candidates,
  };
  try {
    updateJsonFile(availableFile(), (cur) => (cur?.lookedAt && cur.lookedAt > lookedAt ? cur : rec), {});
  } catch {
    // shown from what was kept
  }
  if (fetch) record(ok ? { ok: true, head: installed.name || installed.commit.slice(0, 7) } : { ok: false, detail });
  return rec;
}

// The one line an owner command prints at its start, or '' (never a fetch, never an install)
export function startNotice() {
  if (ownerSaysNoUpdates()) return '';
  const a = readAvailable();
  const next = a?.newer?.[0];
  if (!next) return '';
  const safety = next.notes?.safety ? ' (it has a safety fix)' : '';
  return hasVersions()
    ? `(nextlevel ${next.name} is available${safety}: Update on the dashboard's Home, or nextlevel update in PowerShell.)`
    : `(nextlevel ${next.name} is available${safety}: run the install command in PowerShell to move to releases. nextlevel doctor shows it.)`;
}

// Why this nextlevel won't get a merged fix by updating itself, or '' when a release with it will reach it (a field
// report's follow-up says so)
export function updateBlocker(root = null) {
  if (ownerSaysNoUpdates()) return 'NEXTLEVEL_NO_UPDATE is set, so nextlevel never looks for releases: nextlevel update installs one';
  if (!isClone()) return `${TOOL_ROOT} isn't a git clone, so it can't update itself: install nextlevel with its installer`;
  if (!hasVersions()) return 'this nextlevel is from before releases: run the install command (PowerShell) to move it to releases, which then bring the fix';
  const c = root ? channelOf(root) : { channel: 'release' };
  if (c.channel === 'pin') return `this project is pinned at ${c.ref}: nextlevel channel release follows releases again`;
  const s = toolState(toolGit);
  if (s.changed.length) return `files in the version's folder were changed by hand (${s.changed.slice(0, 3).join(', ')}): nextlevel doctor shows what to do`;
  return '';
}

// ---------- updating ----------
function showNotes(list, { left = [] } = {}) {
  for (const r of list.slice(0, 5)) {
    say(`  ${r.name}:`);
    const items = [...(r.notes?.fixes || []), ...(r.notes?.added || [])];
    for (const i of items.slice(0, 12)) say(`    - ${i.safety ? 'Safety: ' : ''}${i.text}`);
    if (items.length > 12) say(`    ... and ${items.length - 12} more`);
    for (const t of (r.notes?.afterInstall || []).slice(0, 6)) say(`    After install: ${t}`);
  }
  if (list.length > 5) say(`  ... and ${list.length - 5} older releases`);
  if (left.length) say(`  Left out (newer than where it is now): ${left.map((r) => r.name).join(', ')}`);
}

// What is available changes with what is installed (and with a channel): available.json is judged again, without a fetch
function refreshAvailable() {
  try {
    checkReleases({ fetch: false });
  } catch {
    // the next look refreshes it
  }
}
// `nextlevel update [--to <release>]`. Returns the exit code.
export async function cmdUpdate(args, { root = null } = {}) {
  const a = commandArgs('update', args);
  // The owner's alone, plain or not (safe updates): an agent's session never updates the tool
  const session = agentSession();
  if (session) {
    say(ownerOnly(`nextlevel update${a.to !== undefined ? ' --to' : ''}`, 'The owner updates on the dashboard\'s Home, or with nextlevel update in their own PowerShell window.', session));
    return 1;
  }
  const to = a.to;
  if (to !== undefined && !isReleaseName(to)) {
    say(/^(origin\/)?main$|^[\w./-]+$/.test(String(to)) && !/^v\d/.test(String(to))
      ? `--to takes a release (v0.3.0). To run a branch in this project, the owner sets its channel: nextlevel channel candidate ${String(to).replace(/^origin\//, '')}`
      : `"${to}" isn't a release's name: releases are named like v0.3.0 (nextlevel update lists the ones there are).`);
    return 1;
  }
  if (!isClone()) {
    say(`This nextlevel (${TOOL_ROOT}) isn't a git clone, so it can't update itself.`);
    say(`Install it with the installer instead, in PowerShell:\n  ${INSTALL_COMMAND}`);
    return 1;
  }
  const rec = checkReleases({ timeoutMs: 60_000 });
  if (rec && !rec.ok) {
    say(`Couldn't reach the nextlevel repository: ${rec.detail}.`);
    return 1;
  }
  for (const r of rec?.refused || []) say(`(${r.why}.)`);
  for (const n of rec?.vanished || []) say(`(${n} was published and is gone from GitHub now: nextlevel no longer offers it.)`);
  const channel = root ? channelOf(root) : { channel: 'release' };
  if (!hasVersions()) {
    if (!rec?.newest) {
      say('No nextlevel release has been published yet, so this nextlevel stays as it is (releases replace following main).');
      return 0;
    }
    say(`nextlevel ${rec.newest.name} is released. This nextlevel is from before releases: move it with the install command, in PowerShell (when no hub or worker runs):\n  ${INSTALL_COMMAND}`);
    return 1;
  }
  if (channel.channel === 'pin' && to === undefined) {
    say(`This project is pinned at ${channel.ref}, so it stays there. To follow releases again: nextlevel channel release`);
    return 0;
  }
  const judged = judgeTags(toolGit, { seen: readSeen() });
  const versions = readVersions();
  const current = versions.release;
  let back = false;
  let newer = [];
  if (to !== undefined) {
    const rel = judged.releases.find((r) => r.name === to);
    if (!rel) {
      const why = judged.refused.find((r) => r.name === to);
      say(why ? `Not going to ${to}: ${why.why}.` : `There is no release ${to}. Releases: ${judged.releases.map((r) => r.name).slice(0, 10).join(', ') || 'none yet'}`);
      return 1;
    }
    if (rel.name === current) {
      say(`nextlevel is at ${rel.name} already.`);
      return 0;
    }
    back = !!current && toolGit(['merge-base', '--is-ancestor', rel.commit, versions.installed[current]?.commit || 'HEAD']).ok;
    if (back) say(`Going back from ${current} to ${rel.name} (your choice: nextlevel offers ${current} again, marked "you went back from this one").`);
    else newer = [rel];
  } else if (channel.channel !== 'candidate') newer = newerReleases(toolGit, judged.releases, { name: current, commit: versions.installed[current]?.commit });
  // The one-click update's steps (src/updater.mjs): it holds and waits for running work, stops the hubs and dashboards,
  // switches, starts them again, refreshes the unedited role docs, runs the bridge test where it must and the doctor.
  // It runs detached: Ctrl+C here stops following it, not the update (Home shows it too).
  const { startUpdate, followUpdate } = await import('../updater.mjs');
  const fromCandidate = channel.channel === 'candidate' ? channel.version : null;
  const started = startUpdate({ git: toolGit, root, to: to ?? null, back, by: 'command' });
  if (started.problem) {
    say(/up to date/.test(started.problem) ? `${started.problem}.` : started.problem);
    return /up to date/.test(started.problem) ? 0 : 1;
  }
  const code = await followUpdate(started.id, { say });
  if (code) return code;
  const p = started.plan;
  if (p.channel === 'candidate') {
    const at = readVersions().installed[fromCandidate]?.commit;
    const subjects = at ? toolGit(['log', '--no-merges', '--format=%s', '-n', '20', `${at}..${p.toCommit}`]).out.split(/\r?\n/).filter(Boolean) : [];
    say(`This project runs ${p.ref} at ${p.toCommit.slice(0, 7)} now (${p.to}; not released):`);
    for (const s of subjects.slice(0, 15)) say(`  - ${s}`);
    return 0;
  }
  if (back) {
    say(`nextlevel runs ${p.to} now.`);
    return 0;
  }
  say(`Updated nextlevel: ${p.from} -> ${p.to}`);
  showNotes(newer.length ? newer : [{ name: p.to, notes: {} }]);
  say(`  To go back: nextlevel update --to ${p.from}`);
  return 0;
}

// `nextlevel channel [release | pin <release> | candidate <branch>]`: show or set what this project follows. The owner's.
export function cmdChannel(args, { root }) {
  const a = commandArgs('channel', args);
  const [what, ref] = a._;
  const c = channelOf(root);
  const shown = () => (c.channel === 'pin' ? `pinned at ${c.ref}` : c.channel === 'candidate' ? `the candidate ${c.ref} (${c.version}; runs whatever is pushed there, once you update)` : `releases (${readVersions().release || 'none installed yet'})`);
  if (what === undefined) {
    say(`This project follows ${shown()}.`);
    return 0;
  }
  const session = agentSession();
  if (session) {
    say(ownerOnly(`nextlevel channel ${what}`, 'The owner changes it in their own PowerShell window (or on the dashboard).', session));
    return 1;
  }
  if (!hasVersions()) {
    say(`Channels come with releases, and this nextlevel is from before them: move it with the install command, in PowerShell:\n  ${INSTALL_COMMAND}`);
    return 1;
  }
  const running = [activity(root)].filter(Boolean); // a channel changes only this project's version
  if (running.length) {
    say(`Not changing what this project runs while nextlevel is at work: ${running.join('; ')}. Stop the hub, let workers finish, then run it again.`);
    return 1;
  }
  if (what === 'release') {
    if (ref !== undefined) return say('nextlevel channel release takes nothing after it.'), 1;
    setChannel(root, null);
    refreshAvailable();
    say(`This project follows releases now (${readVersions().release}).`);
    return 0;
  }
  if (what === 'pin') {
    if (!isReleaseName(ref)) return say('nextlevel channel pin needs a release: nextlevel channel pin v0.3.0'), 1;
    const rec = checkReleases({ timeoutMs: 60_000 });
    if (rec && !rec.ok) return say(`Couldn't reach the nextlevel repository: ${rec.detail}.`), 1;
    const rel = judgeTags(toolGit, { seen: readSeen() }).releases.find((r) => r.name === ref);
    if (!rel) return say(`There is no release ${ref}.`), 1;
    maintenanceOff(toolGit);
    const made = addVersion(toolGit, rel.name, rel.commit, { kind: 'release' });
    if (!made.ok) return say(`Couldn't make the folder for ${rel.name}: ${made.message}`), 1;
    setChannel(root, { channel: 'pin', ref: rel.name });
    refreshAvailable();
    say(`This project is pinned at ${rel.name} now: it stays there until nextlevel channel release.`);
    return 0;
  }
  if (what === 'candidate') {
    const problem = branchNameProblem(ref);
    if (problem) return say(`nextlevel channel candidate needs a branch on GitHub: ${problem}`), 1;
    const f = fetchTool(60_000);
    if (!f.ok) return say(`Couldn't reach the nextlevel repository: ${why(f)}.`), 1;
    const tip = toolGit(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${ref}^{commit}`]).out.trim();
    if (!tip) return say(`There is no branch ${ref} on GitHub.`), 1;
    const name = candidateName(ref, tip);
    maintenanceOff(toolGit);
    const made = addVersion(toolGit, name, tip, { kind: 'candidate' });
    if (!made.ok) return say(`Couldn't make the folder for ${name}: ${made.message}`), 1;
    setChannel(root, { channel: 'candidate', ref, version: name });
    refreshAvailable();
    say(`This project follows the candidate ${ref} now, at ${tip.slice(0, 7)} (${name}). It runs whatever sessions push to ${ref}, once you update (nextlevel update): for trying a change before its release, never for a project whose work matters.`);
    return 0;
  }
  say(`nextlevel channel: "${what}" isn't a channel (release, pin <release>, candidate <branch>).`);
  return 1;
}

export { versionFor };
