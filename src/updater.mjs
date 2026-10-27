// The one-click update (safe updates, docs/design/safe-updates.md, point 3). The owner's click on Home (or `nextlevel
// update` in their own window) starts a detached updater, `nextlevel _update <id>`, which outlives the dashboard that
// started it and the hubs it stops, and does, for every project the update covers (the release channel's update: every
// project that follows releases; a candidate's: that project):
//   prepare    fetch, the release checked again, its folder made (a worktree of the clone), the doctor as it is now;
//              then the updater hands over to a copy of itself from the new version's folder, so no step after this one
//              runs from the files of the version it leaves (none of which change anyway)
//   wait       until no task, round, check, push or git job runs and no orchestrator or guide window is open (no time
//              limit; Home shows what it waits for, and Stop waiting)
//   backup     the base branch's head pushed to updates.backupBranch, where a project sets one (never forced, never a
//              deploy branch); a refused push pauses here, before anything changed
//   stop       each hub (hub-stop.json) and dashboard (ui-stop.json), after recording how each ran
//   switch     the channel points at the new version (versions.json, or the project's candidate entry)
//   restart    the dashboards (which open their own page: a new key, never handed on) and the hubs, as they ran
//   templates  role docs and the other templates nobody edited, refreshed and committed through the hub as the owner's
//              change; START.cmd only while no cmd.exe runs it; edited ones are named, never changed
//   bridge     the bridge test, for a worker engine whose verdict passed before and asks again now (a new engine
//              version, or slots that refuse pushes another way: SLOT_PUSH_BLOCK)
//   doctor     the new version's doctor: a row that passed before and fails now (warn or error) pauses the update
//   finish     done; old version folders nothing runs from are removed, and the clone is tidied in the foreground
// A failing step pauses the update: Home and the phone say which step and why, with Try again and Go back. Going back
// is the same steps the other way (the role docs the update committed put back too). Everything the update keeps is in
// ~/.nextlevel/update/<id>/ (plan.json, status.json, update.log); update/current.json names the one in progress. The
// signals it sends (hub-stop.json and ui-stop.json with by "update", the fields of hub.json and ui.json it reads) are a
// protocol every later version keeps, like the file protocol.
//
// From the click to the end (done, or cancelled), the update holds new work in the projects it covers (the design's
// "Holding new work": update/hold.json, read by each hub at each look, `holdFor`): no task starts (a dispatch or a retry
// stays queued) and no autopilot round starts; while it waits, the checks, pushes and git jobs a running round or an open
// orchestrator window asks for still run (its `nextlevel wait` would wait for ever), and from the end of the wait every
// queued job waits, but the update's own (`by: "update"`: its backup push, its role-doc commit, its bridge test). A
// paused update keeps its hold until the owner chooses. Autopilot's switch and rounds.json are never touched.
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, updateJsonFile } from './lib/filelock.mjs';
import { formatProblem } from './lib/format.mjs';
import { contentHash, guardStore, recordOwner } from './lib/guard.mjs';
import { homeDir, userState } from './lib/home.mjs';
import { loadConfig } from './lib/config.mjs';
import { parseEnvFile } from './lib/envfile.mjs';
import { openWindow } from './lib/proc.mjs';
import { TOOL_ROOT } from './lib/project.mjs';
import { judgeTags, newerReleases, readSeen } from './lib/releases.mjs';
import { checkReleases, fetchTool } from './lib/update.mjs';
import { runsVersion } from './lib/runreg.mjs';
import { agentSession, ownerOnly } from './lib/session.mjs';
import { runningScan } from './lib/securityscan.mjs';
import { OLD_TEMPLATES, templateHash } from './lib/templates.mjs';
import { addVersion, candidateName, channelOf, maintenanceOff, projectKey, pruneVersions, readChannels, readVersions, runningVersion, setChannel, updateVersions, versionPath } from './lib/versions.mjs';
import { notify } from './notify.mjs';

const IS_WIN = process.platform === 'win32';
const BIN = path.join(TOOL_ROOT, 'bin', 'nextlevel.mjs');
const now = () => new Date().toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = () => Number(process.env.NEXTLEVEL_UPDATE_POLL_MS) || 2000;
const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
const readJson = (f) => readJsonFile(f, null);
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

export const STEPS = [
  ['prepare', 'Get the new version ready'],
  ['wait', 'Wait for running work'],
  ['backup', 'Back up the projects'],
  ['stop', 'Stop the hubs and dashboards'],
  ['switch', 'Switch to the new version'],
  ['restart', 'Start everything again'],
  ['templates', 'Refresh the role docs you never edited'],
  ['bridge', 'Run the bridge test where it must'],
  ['doctor', 'Check the setup'],
  ['finish', 'Finish'],
];
const STEP_KEYS = STEPS.map(([k]) => k);
// Steps after which something changed for the projects: before them, giving up changes nothing
const CHANGED_FROM = STEP_KEYS.indexOf('stop');
const FINAL = new Set(['done', 'cancelled']);

// ---------- where it keeps things ----------
export const updateRoot = () => path.join(homeDir(), 'update');
const ID = /^u-[0-9a-z-]{6,60}$/;
export function updateDir(id) {
  if (!ID.test(String(id))) throw new Error(`"${id}" isn't an update's id`);
  return path.join(updateRoot(), id);
}
const planFile = (id) => path.join(updateDir(id), 'plan.json');
const statusFile = (id) => path.join(updateDir(id), 'status.json');
const currentFile = () => path.join(updateRoot(), 'current.json');
const holdFile = () => path.join(updateRoot(), 'hold.json');
export const readPlan = (id) => readJson(planFile(id));
export const readStatus = (id) => readJson(statusFile(id));
export function currentUpdate() {
  const id = readJson(currentFile())?.id;
  if (!id || !ID.test(id)) return null;
  const status = settle(id, readStatus(id));
  return status ? { id, plan: readPlan(id), status } : null;
}
// An updater that is gone (killed, the PC restarted) leaves its update paused at the step it was in, so Home offers Try
// again and Go back instead of "Updating" for ever (a minute's grace: the hand-over to the new folder, a slow start)
function settle(id, status) {
  if (!status || FINAL.has(status.phase) || status.phase === 'paused') return status;
  if (alive(status.updaterPid) || Date.now() - Date.parse(status.at || 0) < 60_000) return status;
  const key = STEP_KEYS.find((k) => status.steps?.[k]?.state === 'running') || STEP_KEYS.find((k) => status.steps?.[k]?.state !== 'done') || 'prepare';
  const text = 'the updater stopped before it finished (closed, or the PC restarted)';
  setStep(id, key, 'failed', text);
  writeStatus(id, { phase: 'paused', paused: { step: key, title: STEPS.find(([k]) => k === key)?.[1] || key, text, output: '', canSkipBackup: false, changed: STEP_KEYS.indexOf(key) >= CHANGED_FROM } });
  log(id, `paused at ${key}: ${text}`);
  return readStatus(id);
}
// ---------- the hold (the design's "Holding new work") ----------
// update/hold.json: { protocol, id, from, to, projects (their keys), phase, at }. "waiting": only new tasks and rounds wait;
// "held" (from the end of the wait): every queued job too, but the update's own. Written by the click and the updater only.
function writeHold(id, phase) {
  const p = readPlan(id);
  if (!p) return;
  updateJsonFile(holdFile(), () => ({ protocol: 1, id, from: p.from || '', to: p.to || '', projects: (p.projects || []).map(projectKey), phase, at: now() }), {});
}
function dropHold(id) {
  updateJsonFile(holdFile(), (h) => (h?.id === id ? {} : h), {});
}
// The hold on a project's new work, or null: { id, to, strict, text }. Only one that names the update in progress (a hold
// file left by an update that ended, or naming none, holds nothing; an updater that is gone leaves its update paused, and
// Home offers Try again, Go back and Stop waiting).
export function holdFor(root) {
  const h = readJson(holdFile());
  if (!h || h.protocol !== 1 || !ID.test(String(h.id)) || !Array.isArray(h.projects)) return null;
  if (readJson(currentFile())?.id !== h.id) return null;
  const status = settle(h.id, readStatus(h.id));
  if (!status || FINAL.has(status.phase)) return null;
  if (!h.projects.includes(projectKey(root))) return null;
  const to = typeof h.to === 'string' && /^[\w.@-]{1,80}$/.test(h.to) ? h.to : 'a new version';
  return {
    id: h.id,
    to,
    strict: h.phase !== 'waiting',
    text: status.phase === 'paused' ? `nextlevel's update to ${to} is paused: new work waits until you choose on Home` : `nextlevel is updating to ${to}: new work waits until it's done`,
  };
}
// Whether a job a command queues now is the update's own: queued by the updater (its NEXTLEVEL_UPDATE_ID) for the update
// that holds this project
export const queuedByUpdate = (root, env = process.env) => !!env.NEXTLEVEL_UPDATE_ID && holdFor(root)?.id === env.NEXTLEVEL_UPDATE_ID;
function writeStatus(id, patch) {
  return updateJsonFile(statusFile(id), (s) => ({ ...s, ...(typeof patch === 'function' ? patch(s) : patch), at: now() }), {});
}
function setStep(id, key, state, detail = '') {
  writeStatus(id, (s) => ({ steps: { ...(s.steps || {}), [key]: { state, detail: String(detail).slice(0, 2000), at: now() } } }));
}
function log(id, line) {
  try {
    fs.appendFileSync(path.join(updateDir(id), 'update.log'), `${now()}  ${line}\n`);
  } catch {
    // the status file has the steps
  }
}

// ---------- the projects ----------
const stateDirOf = (root) => path.join(root, '.nextlevel');
const projectName = (root) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'nextlevel.json'), 'utf8')).name || path.basename(root);
  } catch {
    return path.basename(root);
  }
};
// Every project this PC knows (each owner command records its own), with its nextlevel.json still there
export function knownProjects() {
  const roots = (userState().get('projects') || []).filter((r) => typeof r === 'string');
  return [...new Set(roots)].filter((r) => fs.existsSync(path.join(r, 'nextlevel.json')));
}
const hubOf = (root) => {
  const h = readJson(path.join(stateDirOf(root), 'hub.json'));
  return h && alive(h.pid) && Date.now() - Date.parse(h.heartbeatAt || 0) < 90_000 ? h : null;
};
const uiOf = (root) => {
  const u = readJson(path.join(stateDirOf(root), 'ui.json'));
  return u && alive(u.pid) && Date.now() - Date.parse(u.heartbeatAt || 0) < 30_000 ? u : null;
};
// What runs in a project that the update waits for: [words]
export function workIn(root) {
  const dir = stateDirOf(root);
  const out = [];
  const hub = hubOf(root);
  let ids = [];
  try {
    ids = fs.readdirSync(path.join(dir, 'jobs'));
  } catch {
    // no jobs yet
  }
  for (const id of ids) {
    const s = readJson(path.join(dir, 'jobs', id, 'status.json'));
    if (!s || !['running', 'verifying'].includes(s.state)) continue;
    const job = readJson(path.join(dir, 'jobs', id, 'job.json')) || {};
    const type = s.type || job.type || 'task';
    const run = readJson(path.join(dir, 'jobs', id, 'run.json'));
    const going = type === 'task' ? (run ? !run.endedAt && alive(run.pid) : false) || (s.state === 'verifying' && hub) : !!hub;
    if (!going) continue;
    const min = s.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(s.startedAt)) / 60_000)) : 0;
    out.push(type === 'task' ? `${id} ${s.state === 'verifying' ? 'is being verified' : 'runs'} (${min} min)` : `${id} (${type}) runs`);
  }
  const orch = readJson(path.join(dir, 'orchestrator.json'));
  if (orch && alive(orch.pid)) out.push(orch.mode === 'autopilot' ? 'an autopilot round runs' : "the orchestrator's window is open: close it when you're done with it");
  const guide = readJson(path.join(dir, 'guide.json'));
  if (guide && alive(guide.pid)) out.push("the setup guide's window is open: close it when you're done with it");
  const ui = uiOf(root);
  if (ui?.asking) out.push('the assistant is answering a question');
  const scan = runningScan(dir);
  if (scan) out.push(`security scan ${scan.id} runs`);
  return out;
}

// ---------- running nextlevel as the owner ----------
// The environment of what the updater runs: the owner's, without what marks an agent's session or names a version
function ownerEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ['NEXTLEVEL_AGENT', 'NEXTLEVEL_SESSION', 'NEXTLEVEL_TASK_ID', 'NEXTLEVEL_READ_ONLY', 'NEXTLEVEL_ROOT', 'NEXTLEVEL_VERSION', 'NEXTLEVEL_LAUNCHED', 'NEXTLEVEL_UPDATE_ID']) delete env[k];
  return { ...env, ...extra };
}
const binOf = (name) => (name ? path.join(versionPath(name), 'bin', 'nextlevel.mjs') : BIN);
// The version the update leaves, by its name (never a path from the plan, which sits in a folder an agent without a sandbox
// can write): its folder if it is still there, else this code
const fromBinOf = (p) => (p.from && fs.existsSync(binOf(p.from)) ? binOf(p.from) : BIN);
// A file a plan names for going back: a path in the project, and a commit
const safeRel = (f) => typeof f === 'string' && f !== '' && !path.isAbsolute(f) && !f.split(/[\\/]/).includes('..') && !/[\0:]/.test(f);
function runIn(root, bin, args, { timeoutMs = 10 * 60_000 } = {}) {
  // (the jobs it queues are the update's own, which its hold lets through: never the hubs' or dashboards' environment)
  const r = spawnSync(process.execPath, [bin, '--project', root, ...args], { cwd: root, env: ownerEnv(running ? { NEXTLEVEL_UPDATE_ID: running } : {}), encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
  return { code: r.status ?? 1, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
function doctorOf(root, bin) {
  const r = runIn(root, bin, ['--no-update', 'doctor', '--json'], { timeoutMs: 5 * 60_000 });
  try {
    return JSON.parse(r.out.slice(r.out.indexOf('{'))).results || [];
  } catch {
    return null;
  }
}
function detach(file, args, { cwd, out = 'ignore', env = ownerEnv() } = {}) {
  const child = spawn(file, args, { cwd, env, detached: true, windowsHide: true, stdio: ['ignore', out, out] });
  child.unref();
  return child;
}
// A console window of its own on Windows, as the hub's (cmd /k: it stays at a prompt after the program ends)
const inWindow = (title, args, { cwd }) => openWindow(title, process.execPath, args, { cwd, env: ownerEnv(), keepOpen: true });
const windowsAllowed = () => IS_WIN && process.env.NEXTLEVEL_HUB_WINDOW !== '0';
function launchHub(root, bin, how = {}) {
  const args = [bin, 'run', ...(Array.isArray(how.argv) ? how.argv.filter((a) => /^(--tick-ms|\d+)$/.test(a)) : [])];
  if (how.window && windowsAllowed()) return inWindow(`${projectName(root)} hub`, args, { cwd: root });
  const logs = path.join(stateDirOf(root), 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const fd = fs.openSync(path.join(logs, 'hub-console.log'), 'a');
  detach(process.execPath, args, { cwd: root, out: fd });
  fs.closeSync(fd);
}
function launchDashboard(root, bin, how = {}) {
  const args = [bin, 'ui', ...(how.open === false ? ['--no-open'] : [])];
  if (how.window && windowsAllowed()) return inWindow(`${projectName(root)} dashboard`, args, { cwd: root });
  const logs = path.join(stateDirOf(root), 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const fd = fs.openSync(path.join(logs, 'ui-console.log'), 'a');
  detach(process.execPath, args, { cwd: root, out: fd });
  fs.closeSync(fd);
}
async function until(test, ms) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (test()) return true;
  return test();
}

// ---------- starting, stopping, retrying, going back (the dashboard's buttons and `nextlevel update`) ----------
const newId = () => `u-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`;
// What an update to the newest release (or a candidate's head) would be for the project `root`: { to, commit, channel,
// ref, from } or { none } / { problem }. `git(args)` runs git in the tool's clone.
export function offer(git, root) {
  const v = readVersions();
  const c = root ? channelOf(root) : { channel: 'release' };
  if (c.channel === 'pin') return { problem: `this project is pinned at ${c.ref}: nextlevel channel release follows releases again` };
  if (c.channel === 'candidate') {
    const tip = git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${c.ref}^{commit}`]).out.trim();
    if (!tip) return { problem: `the branch ${c.ref} this project follows isn't on GitHub (any more)` };
    if (v.installed[c.version]?.commit === tip) return { none: true, from: c.version };
    return { to: candidateName(c.ref, tip), commit: tip, channel: 'candidate', ref: c.ref, from: c.version };
  }
  const judged = judgeTags(git, { seen: readSeen() });
  const newer = newerReleases(git, judged.releases, { name: v.release, commit: v.installed[v.release]?.commit });
  if (!newer.length) return { none: true, from: v.release };
  return { to: newer[0].name, commit: newer[0].commit, channel: 'release', from: v.release, notes: newer[0].notes };
}

// Start an update. `want`: { to, commit } the owner's card showed (refused when the offer changed since); `back`: go back
// to the previous release (or `to`, an older one). -> { id } or { problem }
export function startUpdate({ git, root = null, want = null, back = false, to = null, by = 'command' }) {
  const session = agentSession();
  if (session) return { problem: ownerOnly('The update', "The owner updates on the dashboard's Home, or with nextlevel update in their own PowerShell window.", session) };
  const cur = currentUpdate();
  if (cur && !FINAL.has(cur.status.phase) && cur.status.phase !== 'paused') return { problem: `an update is in progress already (${cur.plan?.to || cur.id}): Home shows how it goes` };
  if (cur?.status.phase === 'paused') return { problem: `the update to ${cur.plan?.to} is paused: Try again, or Go back, on Home` };
  const v = readVersions();
  let target;
  if (back || to) {
    const name = to || v.previous;
    if (!name) return { problem: 'there is no earlier release to go back to on this PC' };
    const rec = v.installed[name];
    const judged = judgeTags(git, { seen: readSeen() }).releases.find((r) => r.name === name);
    const commit = rec?.commit || judged?.commit;
    if (!commit) return { problem: `there is no release ${name}` };
    if (name === v.release) return { problem: `nextlevel runs ${name} already` };
    target = { to: name, commit, channel: 'release', from: v.release, back: !!back || (judged ? newerReleases(git, [{ name: v.release, commit: v.installed[v.release]?.commit }], { name, commit }).length > 0 : true) };
  } else {
    target = offer(git, root);
    if (target.problem) return { problem: target.problem };
    if (target.none) return { problem: `nextlevel is up to date (${target.from})` };
  }
  if (want && (want.to !== target.to || (want.commit && want.commit !== target.commit))) {
    return { problem: `the update on offer changed since the page showed it (now ${target.to}): look at Home again` };
  }
  return launchPlan({ target, root, by });
}
// Write the plan and start the updater (from this version's folder; it hands over to the new one after preparing)
function launchPlan({ target, root, by, revert = null }) {
  const projects = target.channel === 'candidate' ? [root] : knownProjects().filter((r) => channelOf(r).channel === 'release');
  const id = newId();
  // One update at a time: current.json is claimed under its lock (two clicks at once start one updater)
  let busyWith = null;
  updateJsonFile(currentFile(), (cur) => {
    const s = cur?.id && ID.test(cur.id) ? settle(cur.id, readStatus(cur.id)) : null;
    if (s && !FINAL.has(s.phase)) {
      busyWith = cur.id;
      return cur;
    }
    return { protocol: 1, id };
  }, {});
  if (busyWith) return { problem: `an update is in progress already (${readPlan(busyWith)?.to || busyWith}): Home shows how it goes` };
  fs.mkdirSync(updateDir(id), { recursive: true });
  const plan = { protocol: 1, id, kind: target.back ? 'back' : 'update', from: target.from || runningVersion(TOOL_ROOT), to: target.to, toCommit: target.commit, channel: target.channel, ref: target.ref || '', candidateRoot: target.channel === 'candidate' ? root : null, projects, by, at: now(), revert: revert || (target.back ? lastTemplateCommits(target.to) : []) };
  fs.writeFileSync(planFile(id), JSON.stringify(plan, null, 2));
  fs.writeFileSync(statusFile(id), JSON.stringify({ protocol: 1, id, phase: 'preparing', steps: {}, waitingFor: [], at: now() }, null, 2));
  writeHold(id, 'waiting'); // (from the click: no new task or round anywhere it covers)
  spawnUpdater(id, BIN);
  return { id, plan };
}
// The role-doc commits the update to `from` made, for going back from it: [{ root, files, commit }]
function lastTemplateCommits(backTo) {
  const v = readVersions();
  let ids = [];
  try {
    ids = fs.readdirSync(updateRoot()).filter((d) => ID.test(d)).sort().reverse();
  } catch {
    return [];
  }
  for (const id of ids) {
    const p = readPlan(id);
    const s = readStatus(id);
    if (p?.kind === 'update' && p.to === v.release && p.from === backTo && s?.phase === 'done') return Object.entries(s.templates || {}).map(([root, t]) => ({ root, ...t })).filter((t) => t.commit && t.files?.length);
  }
  return [];
}
function spawnUpdater(id, bin) {
  const fd = fs.openSync(path.join(updateDir(id), 'updater-console.log'), 'a');
  detach(process.execPath, [bin, '_update', id], { cwd: updateDir(id), out: fd });
  fs.closeSync(fd);
}
// Stop waiting: before the stop step, nothing has changed
export function stopWaiting(id) {
  const s = readStatus(id);
  if (!s) return { problem: 'there is no such update' };
  if (FINAL.has(s.phase)) return { problem: `the update is ${s.phase} already` };
  const at = STEP_KEYS.findIndex((k) => s.steps?.[k]?.state !== 'done');
  if (at >= CHANGED_FROM && s.phase !== 'paused') return { problem: 'the update has stopped the hubs already: let it finish, or Go back once it pauses' };
  fs.writeFileSync(path.join(updateDir(id), 'stop.json'), JSON.stringify({ at: now() }));
  if (s.phase === 'paused' && at < CHANGED_FROM) finishAs(id, 'cancelled', 'You stopped waiting: nothing was changed.');
  return { ok: true };
}
// Try again from the failed step (skipBackup: the owner's "Update without the backup")
export function retryUpdate(id, { skipBackup = false } = {}) {
  const s = readStatus(id);
  const p = readPlan(id);
  if (!s || !p) return { problem: 'there is no such update' };
  if (s.phase !== 'paused') return { problem: `the update isn't paused (${s.phase})` };
  if (skipBackup) fs.writeFileSync(planFile(id), JSON.stringify({ ...p, skipBackup: true }, null, 2));
  writeStatus(id, { phase: 'resuming', paused: null });
  const prepared = s.steps?.prepare?.state === 'done' && fs.existsSync(binOf(p.to));
  spawnUpdater(id, prepared ? binOf(p.to) : BIN);
  return { ok: true };
}
// Go back from a paused update: before the stop step nothing changed (it ends); after the switch, an update the other way
export function goBack(git, id) {
  const s = readStatus(id);
  const p = readPlan(id);
  if (!s || !p) return { problem: 'there is no such update' };
  const switched = s.steps?.switch?.state === 'done';
  if (!switched) {
    // The hubs it stopped come back on the version they ran
    for (const [root, how] of Object.entries(s.restart?.hubs || {})) if (!hubOf(root)) launchHub(root, fromBinOf(p), how);
    for (const [root, how] of Object.entries(s.restart?.dashboards || {})) if (!uiOf(root)) launchDashboard(root, fromBinOf(p), how);
    finishAs(id, 'cancelled', `Gone back: nothing had switched; everything runs ${p.from} as before.`);
    return { ok: true };
  }
  const commit = readVersions().installed[p.from]?.commit;
  if (!p.from || !commit) return { problem: `the version ${p.from || 'from before'} isn't on this PC any more: the installer puts a release back` };
  finishAs(id, 'cancelled', `Going back to ${p.from}.`);
  // the role docs this update committed go back too
  const revert = Object.entries(readStatus(id)?.templates || {}).map(([root, t]) => ({ root, ...t })).filter((t) => t.commit && t.files?.length);
  return launchPlan({ target: { to: p.from, commit, channel: p.channel, ref: p.ref, from: p.to, back: true }, root: p.candidateRoot, by: 'go back', revert });
}
function finishAs(id, phase, text) {
  writeStatus(id, { phase, text, waitingFor: [] });
  dropHold(id);
  log(id, text);
}

// ---------- the updater itself (`nextlevel _update <id>`) ----------
let running = ''; // the update this process runs
export async function runUpdater(id) {
  const p = readPlan(id);
  if (!p) throw new Error(`there is no update ${id}`);
  running = id;
  writeStatus(id, { updaterPid: process.pid, phase: readStatus(id)?.phase === 'resuming' ? 'resuming' : readStatus(id)?.phase });
  const done = (k) => readStatus(id)?.steps?.[k]?.state === 'done';
  const here = runningVersion(TOOL_ROOT);
  try {
    if (!done('prepare')) {
      setStep(id, 'prepare', 'running');
      writeStatus(id, { phase: 'preparing' });
      const r = await prepare(id, p);
      if (r) return pause(id, 'prepare', r);
      setStep(id, 'prepare', 'done', `nextlevel ${p.to} is ready in its folder`);
    }
    // Every later step runs from the new version's folder
    if (here !== p.to) {
      log(id, `handing over to nextlevel ${p.to}`);
      spawnUpdater(id, binOf(p.to));
      return;
    }
    const plan = () => readPlan(id);
    for (const key of STEP_KEYS.slice(1)) {
      if (done(key)) continue;
      if (fs.existsSync(path.join(updateDir(id), 'stop.json')) && STEP_KEYS.indexOf(key) <= CHANGED_FROM) return finishAs(id, 'cancelled', 'You stopped waiting: nothing was changed.');
      // (the wait has ended: from now every queued job waits too, but the update's own)
      if (STEP_KEYS.indexOf(key) > STEP_KEYS.indexOf('wait') && readJson(holdFile())?.phase !== 'held') writeHold(id, 'held');
      setStep(id, key, 'running');
      writeStatus(id, { phase: { wait: 'waiting', backup: 'backup', stop: 'stopping', switch: 'switching', restart: 'restarting', templates: 'templates', bridge: 'bridge', doctor: 'doctor', finish: 'finishing' }[key] });
      log(id, `step ${key}`);
      const r = await STEP_RUN[key](id, plan());
      if (r === 'cancelled') return finishAs(id, 'cancelled', 'You stopped waiting: nothing was changed.');
      if (r) return pause(id, key, r);
      if (readStatus(id).steps?.[key]?.state === 'running') setStep(id, key, 'done', readStatus(id).steps[key].detail);
    }
    finishAs(id, 'done', p.kind === 'back' ? `Gone back to nextlevel ${p.to}.` : `Updated to nextlevel ${p.to}.`);
  } catch (err) {
    const key = STEP_KEYS.find((k) => readStatus(id)?.steps?.[k]?.state === 'running') || 'prepare';
    pause(id, key, { text: err.message });
  }
}

async function pause(id, key, { text, output = '', canSkipBackup = false }) {
  const p = readPlan(id);
  setStep(id, key, 'failed', text);
  writeStatus(id, { phase: 'paused', paused: { step: key, title: STEPS.find(([k]) => k === key)?.[1] || key, text: String(text).slice(0, 2000), output: String(output).slice(-4000), canSkipBackup, changed: STEP_KEYS.indexOf(key) >= CHANGED_FROM } });
  log(id, `paused at ${key}: ${text}`);
  // The phone hears it, once per project, through notify() (redacted for that project)
  for (const root of p?.projects || []) {
    const env = parseEnvFile(path.join(root, '.env'));
    const saved = process.env.NTFY_TOPIC;
    if (env.NTFY_TOPIC) process.env.NTFY_TOPIC = env.NTFY_TOPIC;
    try {
      const server = loadConfig(root).config?.notifications?.server;
      await notify(`${projectName(root)}: the nextlevel update to ${p.to} is paused`, `${STEPS.find(([k]) => k === key)?.[1] || key}: ${firstLine(text)}. Home has Try again and Go back.`, { priority: 'high', root, ...(server ? { server } : {}) });
    } catch {
      // Home says it anyway
    } finally {
      if (saved === undefined) delete process.env.NTFY_TOPIC;
      else process.env.NTFY_TOPIC = saved;
    }
  }
}

// ---------- the steps ----------
async function prepare(id, p) {
  const git = gitIn(TOOL_ROOT);
  const f = fetchTool(120_000);
  if (!f.ok && p.kind !== 'back') log(id, `fetch failed (${firstLine(f.err)}): going on with what this PC has`);
  if (p.channel === 'release' && p.kind === 'update') {
    const rel = judgeTags(git, { seen: readSeen() }).releases.find((r) => r.name === p.to);
    if (!rel || rel.commit !== p.toCommit) return { text: `${p.to} is no longer the release it was when you clicked (moved, or gone from GitHub): nothing was changed` };
  }
  maintenanceOff(git);
  const made = addVersion(git, p.to, p.toCommit, { kind: p.channel === 'candidate' ? 'candidate' : 'release' });
  if (!made.ok) return { text: made.message };
  // Going back: each project's .nextlevel/ must be one the older version can read (.nextlevel/format.json), checked before
  // anything stops (its FORMAT read from its file, never its code run here)
  if (p.kind === 'back') {
    let known = 1;
    try {
      known = Number(fs.readFileSync(path.join(versionPath(p.to), 'src', 'lib', 'format.mjs'), 'utf8').match(/export const FORMAT = (\d+);/)?.[1]) || 1;
    } catch {
      // a version from before format.json: format 1
    }
    for (const root of p.projects) {
      const why = formatProblem(stateDirOf(root), { format: known });
      if (why) return { text: `${projectName(root)}: ${why}. Nothing was changed` };
    }
  }
  // The doctor as it is now, per project, to tell afterwards a row the update broke
  const before = {};
  for (const root of p.projects) {
    const rows = doctorOf(root, fromBinOf(p));
    // (without it no row could tell what the update broke: pause here, while nothing has changed)
    if (!rows) return { text: `${projectName(root)}: the doctor gave no answer before the update, so the update couldn't tell what it changes: nothing was changed` };
    before[root] = rows;
  }
  fs.writeFileSync(path.join(updateDir(id), 'before.json'), JSON.stringify(before));
  return null;
}
async function stepWait(id, p) {
  for (;;) {
    if (fs.existsSync(path.join(updateDir(id), 'stop.json'))) return 'cancelled';
    const waitingFor = [];
    for (const root of p.projects) for (const w of workIn(root)) waitingFor.push(`${projectName(root)}: ${w}`);
    writeStatus(id, { waitingFor });
    if (!waitingFor.length) {
      setStep(id, 'wait', 'running', 'nothing runs');
      return null;
    }
    await sleep(POLL_MS());
  }
}
async function stepBackup(id, p) {
  const said = [];
  for (const root of p.projects) {
    let cfg;
    try {
      cfg = loadConfig(root).config;
    } catch {
      continue;
    }
    const branch = cfg?.updates?.backupBranch;
    if (!branch) continue;
    if (p.skipBackup) {
      said.push(`${projectName(root)}: no backup (you chose to update without it)`);
      continue;
    }
    if (!hubOf(root)) {
      said.push(`${projectName(root)}: no backup, its hub wasn't running`);
      continue;
    }
    const q = runIn(root, fromBinOf(p), ['push', branch, '--from', cfg.baseBranch || 'main']);
    const job = q.out.match(/queued (push-[\w-]+)/)?.[1];
    if (!job) return { text: `${projectName(root)}: the backup push to ${branch} wasn't queued`, output: q.out, canSkipBackup: true };
    const w = runIn(root, fromBinOf(p), ['wait', job, '--minutes', '10'], { timeoutMs: 11 * 60_000 });
    // (wait ends when the job does, however it ended: the job's own state says whether the push went out)
    const pushed = readJson(path.join(stateDirOf(root), 'jobs', job, 'status.json'))?.state === 'done';
    if (w.code !== 0 || !pushed || /card|held|approv/i.test(w.out)) return { text: `${projectName(root)}: the backup push of ${cfg.baseBranch || 'main'} to ${branch} didn't go through: nothing was changed`, output: w.out, canSkipBackup: true };
    said.push(`${projectName(root)}: ${cfg.baseBranch || 'main'} pushed to ${branch}`);
  }
  setStep(id, 'backup', 'running', said.join('; ') || 'no project sets a backup branch');
  return null;
}
async function stepStop(id, p) {
  const hubs = {};
  const dashboards = {};
  for (const root of p.projects) {
    const h = hubOf(root);
    if (h) {
      hubs[root] = { window: !!h.window, argv: Array.isArray(h.argv) ? h.argv : [] };
      fs.writeFileSync(path.join(stateDirOf(root), 'hub-stop.json'), JSON.stringify({ at: now(), by: 'update', to: p.to }));
    }
    const u = uiOf(root);
    if (u) {
      dashboards[root] = { window: !!u.window, open: u.open !== false };
      fs.writeFileSync(path.join(stateDirOf(root), 'ui-stop.json'), JSON.stringify({ at: now(), by: 'update', to: p.to }));
    }
  }
  // (merged with what an earlier try stopped: Try again after a hub that didn't stop must still start the others again)
  writeStatus(id, (s) => ({ restart: { hubs: { ...(s.restart?.hubs || {}), ...hubs }, dashboards: { ...(s.restart?.dashboards || {}), ...dashboards } } }));
  const stopped = await until(() => Object.keys(hubs).every((r) => !hubOf(r)) && Object.keys(dashboards).every((r) => !uiOf(r)), 5 * 60_000);
  if (!stopped) {
    const left = [...Object.keys(hubs).filter((r) => hubOf(r)).map((r) => `${projectName(r)}'s hub`), ...Object.keys(dashboards).filter((r) => uiOf(r)).map((r) => `${projectName(r)}'s dashboard`)];
    return { text: `${left.join(', ')} didn't stop in 5 minutes (an older nextlevel that doesn't know the update's stop?): close ${left.length === 1 ? 'its window' : 'their windows'}, then Try again` };
  }
  setStep(id, 'stop', 'running', `${Object.keys(hubs).length} hub(s) and ${Object.keys(dashboards).length} dashboard(s) stopped`);
  return null;
}
async function stepSwitch(id, p) {
  if (p.channel === 'candidate') setChannel(p.candidateRoot, { channel: 'candidate', ref: p.ref, version: p.to });
  else updateVersions((v) => ({ release: p.to, previous: v.release && v.release !== p.to ? v.release : v.previous, wentBackFrom: p.kind === 'back' ? p.from : null }));
  setStep(id, 'switch', 'running', `the ${p.channel === 'candidate' ? `candidate ${p.ref}` : 'release channel'} runs ${p.to}`);
  try {
    checkReleases({ fetch: false });
  } catch {
    // Home's card is fresh at the next look
  }
  return null;
}
async function stepRestart(id, p) {
  const r = readStatus(id).restart || { hubs: {}, dashboards: {} };
  const bin = binOf(p.to);
  for (const [root, how] of Object.entries(r.dashboards || {})) launchDashboard(root, bin, how);
  for (const [root, how] of Object.entries(r.hubs || {})) launchHub(root, bin, how);
  const ok = await until(() => Object.keys(r.hubs || {}).every((root) => hubOf(root)?.version === p.to), 3 * 60_000);
  if (!ok) {
    const left = Object.keys(r.hubs || {}).filter((root) => hubOf(root)?.version !== p.to).map(projectName);
    return { text: `the hub of ${left.join(', ')} didn't start again on ${p.to}: its hub log says why (the Build page), then Try again` };
  }
  await until(() => Object.keys(r.dashboards || {}).every((root) => uiOf(root)?.version === p.to), 60_000);
  setStep(id, 'restart', 'running', `${Object.keys(r.hubs || {}).length} hub(s) and ${Object.keys(r.dashboards || {}).length} dashboard(s) run ${p.to}`);
  return null;
}
// Whether a cmd.exe runs this project's START.cmd now (one snapshot of the processes; the review's change 7)
export function startCmdRunning(root) {
  if (!IS_WIN) return false;
  const file = path.join(root, 'START.cmd').toLowerCase();
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name = 'cmd.exe'\" | ForEach-Object { $_.CommandLine }"], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  if (r.status !== 0) return true; // can't tell: leave START.cmd alone
  return String(r.stdout || '').toLowerCase().split(/\r?\n/).some((l) => l.includes(file) || (l.includes('start.cmd') && l.includes(root.toLowerCase())));
}
// The templates the update refreshes in a project: [template, path in the project]
const templateFiles = (cfg) => [
  ['docs/agents/ORCHESTRATOR.md', cfg.paths.roles.orchestrator],
  ['docs/agents/GUIDE.md', cfg.paths.roles.guide],
  ['docs/agents/WORKER.md', cfg.paths.roles.worker],
  ['AGENTS.md', 'AGENTS.md'],
  ['docs/tasks/_TEMPLATE.md', `${cfg.paths.tasks}/_TEMPLATE.md`],
  ['START.cmd', 'START.cmd'],
];
const gitOut = (root, args) => spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
async function stepTemplates(id, p) {
  const bin = binOf(p.to);
  const notes = [];
  // (each project's commit is kept as soon as it is made: Go back after a pause further on still finds it, and Try again
  // adds to it)
  const keep = (root, rec) => writeStatus(id, (s) => ({ templates: { ...(s.templates || {}), [root]: rec } }));
  for (const root of p.projects) {
    let cfg;
    try {
      cfg = loadConfig(root).config;
    } catch {
      continue;
    }
    const docs = templateFiles(cfg);
    if (p.kind === 'back') {
      // Only the update's own commit, and only a template file nothing changed since: anything else stays and is said
      const rev = (p.revert || []).find((x) => x.root === root);
      if (!rev || !/^[0-9a-f]{40}$/.test(String(rev.commit))) continue;
      if (gitOut(root, ['merge-base', '--is-ancestor', rev.commit, 'HEAD']).status !== 0 || !/^nextlevel /.test(gitOut(root, ['log', '-1', '--format=%s', rev.commit]).stdout || '')) continue;
      const allowed = new Set(docs.map(([, rel]) => rel.replace(/\\/g, '/')));
      const files = [];
      for (const f of (rev.files || []).filter((x) => safeRel(x) && allowed.has(x))) {
        if (gitOut(root, ['log', '--format=%H', `${rev.commit}..HEAD`, '--', f]).stdout.trim() || gitOut(root, ['status', '--porcelain', '--', f]).stdout.trim()) {
          notes.push(`${projectName(root)}: ${f} changed after the update's commit, so it stays as it is`);
          continue;
        }
        if (f === 'START.cmd' && startCmdRunning(root)) {
          notes.push(`${projectName(root)}: START.cmd stays the newer one while a menu window runs it: close that window, then nextlevel init offers the older one`);
          continue;
        }
        // as git would check it out (its line ends: a START.cmd keeps its CRLF)
        const r = spawnSync('git', ['cat-file', '--filters', `${rev.commit}^:${f}`], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
        if (r.status !== 0) continue;
        fs.writeFileSync(path.join(root, f), r.stdout);
        files.push(f);
      }
      if (!files.length) continue;
      const done = commitAsOwner(root, bin, files, `nextlevel ${p.to}: ${files.join(', ')} back to ${p.to}'s`);
      if (done.problem) return done.problem;
      if (done.note) notes.push(`${projectName(root)}: ${done.note}`);
      keep(root, { files, commit: done.commit });
      continue;
    }
    const files = [];
    for (const [template, rel] of docs) {
      const file = path.join(root, rel);
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const fresh = fs.readFileSync(path.join(TOOL_ROOT, 'templates', 'project', ...template.split('/')), 'utf8');
      if (templateHash(text) === templateHash(fresh)) continue;
      if (!(OLD_TEMPLATES[template] || []).includes(templateHash(text))) {
        notes.push(`${projectName(root)}: ${rel} is your own version: nextlevel init shows the difference to the new template`);
        continue;
      }
      if (template === 'START.cmd' && startCmdRunning(root)) {
        notes.push(`${projectName(root)}: START.cmd has a new version, but a menu window runs it: close that window, then nextlevel init replaces it`);
        continue;
      }
      fs.writeFileSync(file, fresh);
      files.push(rel.replace(/\\/g, '/'));
    }
    if (!files.length) continue;
    const done = commitAsOwner(root, bin, files, `nextlevel ${p.to}: ${files.join(', ')} updated to the new templates`);
    if (done.problem) return done.problem;
    if (done.note) notes.push(`${projectName(root)}: ${done.note}`);
    keep(root, { files, commit: done.commit });
  }
  const records = readStatus(id).templates || {};
  writeStatus(id, { notes });
  setStep(id, 'templates', 'running', Object.keys(records).length ? Object.entries(records).map(([root, r]) => `${projectName(root)}: ${r.files.join(', ')}`).join('; ') : 'nothing to refresh');
  return null;
}
// A commit of `files` in the project through its hub, as the owner's change (the guard makes no card for it)
function commitAsOwner(root, bin, files, message) {
  recordOwner(root, files);
  // ...in the form git stores it too: a file whose line ends git's settings change (START.cmd, with eol=crlf or
  // text=auto) is staged as other bytes than are on disk, and the guard knows content by its bytes. The same text,
  // as git keeps it, is approved as the owner's (never anything the update didn't write).
  if (!process.env.NEXTLEVEL_AGENT) {
    const store = guardStore({ root });
    for (const rel of files) {
      const sha = spawnSync('git', ['hash-object', '-w', '--path', rel, '--', path.join(root, rel)], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(sha)) continue;
      const blob = spawnSync('git', ['cat-file', 'blob', sha], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (blob.status === 0) store.approveContent(rel, contentHash({ buf: blob.stdout }));
    }
  }
  if (!hubOf(root)) return { note: `${files.join(', ')} refreshed; commit ${files.length === 1 ? 'it' : 'them'} with your next change (the hub wasn't running)` };
  const r = runIn(root, bin, ['commit', '-m', message, ...files]);
  if (r.code !== 0) {
    if (/git work|stopped all git|guard/i.test(r.out)) return { note: `${files.join(', ')} refreshed; the commit waits for your decision on the Notes page (git work is stopped)` };
    return { problem: { text: `${projectName(root)}: committing the refreshed role docs failed`, output: r.out } };
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', windowsHide: true }).stdout.trim();
  return { commit: head };
}
async function stepBridge(id, p) {
  const before = readJson(path.join(updateDir(id), 'before.json')) || {};
  const bin = binOf(p.to);
  const said = [];
  for (const root of p.projects) {
    const after = doctorOf(root, bin) || [];
    const row = after.find((r) => r.id === 'bridge.test');
    if (!row || row.status === 'ok') continue;
    if (row.severity === 'error') return { text: `${projectName(root)}: ${row.detail}` };
    const was = (before[root] || []).find((r) => r.id === 'bridge.test');
    if (was?.status !== 'ok') {
      said.push(`${projectName(root)}: the bridge test didn't pass before the update either (${firstLine(row.detail)}): left for you`);
      continue;
    }
    const commands = [...new Set((row.steps || []).map((s) => s.command).filter((c) => /^nextlevel bridge-test\b/.test(c || '')))];
    for (const c of commands.length ? commands : ['nextlevel bridge-test']) {
      const args = c.split(/\s+/).slice(1);
      if (!args.every((a) => /^[\w.@=-]+$/.test(a))) continue;
      log(id, `${projectName(root)}: ${c}`);
      const r = runIn(root, bin, args, { timeoutMs: 30 * 60_000 });
      if (r.code !== 0) return { text: `${projectName(root)}: the bridge test didn't pass on ${p.to}`, output: r.out };
    }
    const again = (doctorOf(root, bin) || []).find((r) => r.id === 'bridge.test');
    if (again && again.status !== 'ok') return { text: `${projectName(root)}: ${again.detail}` };
    said.push(`${projectName(root)}: the bridge test ran again and passed`);
  }
  setStep(id, 'bridge', 'running', said.join('; ') || 'not needed');
  return null;
}
async function stepDoctor(id, p) {
  const before = readJson(path.join(updateDir(id), 'before.json')) || {};
  const bin = binOf(p.to);
  const broke = [];
  for (const root of p.projects) {
    const after = doctorOf(root, bin);
    if (!after) return { text: `${projectName(root)}: the doctor of ${p.to} gave no answer` };
    const was = new Map((before[root] || []).map((r) => [r.id, r]));
    for (const r of after) {
      if (r.status !== 'fail' || !['warn', 'error'].includes(r.severity)) continue;
      if (was.get(r.id)?.status !== 'ok') continue;
      // (going back puts older role docs back on purpose, and leaves a newer release on offer, maybe a safety one: the
      // role-docs and updates rows say so, and it isn't the update's fault)
      if (p.kind === 'back' && ['project.role-docs', 'install.updates'].includes(r.id)) continue;
      broke.push(`${projectName(root)}: ${r.title}: ${r.detail}`);
    }
  }
  if (broke.length) return { text: `a check that passed before fails now: ${broke.join('; ')}` };
  setStep(id, 'doctor', 'running', 'every check that passed before passes');
  return null;
}
async function stepFinish(id, p) {
  const git = gitIn(TOOL_ROOT);
  const removed = pruneVersions(git, { running: (name) => name === p.to || runsVersion(name) });
  // Housekeeping in the foreground, while no fix session works in the clone (a worktree of its own there)
  let fixes = [];
  try {
    fixes = fs.readdirSync(path.join(homeDir(), 'fixes'));
  } catch {
    // none
  }
  if (!fixes.length) git(['gc', '--quiet'], { timeoutMs: 5 * 60_000 });
  setStep(id, 'finish', 'running', removed.length ? `removed the old version folders ${removed.join(', ')}` : 'done');
  return null;
}
const STEP_RUN = { wait: stepWait, backup: stepBackup, stop: stepStop, switch: stepSwitch, restart: stepRestart, templates: stepTemplates, bridge: stepBridge, doctor: stepDoctor, finish: stepFinish };

function gitIn(cwd) {
  return (args, { timeoutMs = 60_000 } = {}) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: timeoutMs, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } });
    return { ok: r.status === 0, out: (r.stdout || '').trimEnd(), err: (r.stderr || '').trim() };
  };
}

// `nextlevel update` in the owner's window follows the updater: each step as it ends, what it waits for. -> exit code
export async function followUpdate(id, { say = (m) => console.log(m) } = {}) {
  const told = new Set();
  let waited = '';
  for (;;) {
    const s = readStatus(id) || {};
    for (const [key, title] of STEPS) {
      const st = s.steps?.[key];
      if (!st || !['done', 'failed'].includes(st.state) || told.has(key)) continue;
      told.add(key);
      if (st.state === 'done') say(`  done: ${title}${st.detail ? ` (${st.detail})` : ''}`);
    }
    const w = (s.waitingFor || []).join('; ');
    if (s.phase === 'waiting' && w && w !== waited) say(`  waiting for: ${w}`);
    waited = w;
    if (s.phase === 'done') return 0;
    if (s.phase === 'cancelled') {
      say(s.text || 'The update was cancelled: nothing was changed.');
      return 1;
    }
    if (s.phase === 'paused') {
      say(`The update is paused at "${s.paused?.title}": ${s.paused?.text}`);
      if (s.paused?.output) say(s.paused.output.split(/\r?\n/).slice(-15).join('\n'));
      say("Home has Try again and Go back (the dashboard), and your phone was told.");
      return 1;
    }
    await sleep(500);
  }
}

// ---------- what Home shows ----------
export function updateRunView() {
  const cur = currentUpdate();
  if (!cur) return null;
  const { id, plan, status } = cur;
  // a finished one shows for a day
  if (FINAL.has(status.phase) && Date.now() - Date.parse(status.at || 0) > 24 * 60 * 60_000) return null;
  return {
    id,
    from: plan?.from || '',
    to: plan?.to || '',
    kind: plan?.kind || 'update',
    channel: plan?.channel || 'release',
    phase: status.phase,
    text: status.text || '',
    steps: STEPS.map(([key, title]) => ({ key, title, state: status.steps?.[key]?.state || 'todo', detail: status.steps?.[key]?.detail || '' })),
    waitingFor: status.waitingFor || [],
    paused: status.paused || null,
    notes: status.notes || [],
    projects: (plan?.projects || []).map(projectName),
    canStop: !FINAL.has(status.phase) && STEP_KEYS.findIndex((k) => status.steps?.[k]?.state !== 'done') < CHANGED_FROM,
  };
}
export { channelOf, readChannels };
