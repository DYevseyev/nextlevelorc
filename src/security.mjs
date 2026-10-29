// nextlevel security: the security engineer's scans (docs/design/security-engineer.md, deltas 1 and 2).
//   nextlevel security scan [--deep]   the owner asks for a scan; the hub starts it at its next look (never by itself)
//   nextlevel security status [--json] the scans and the last trusted scan's findings (ids, severities, titles)
//   nextlevel security stop [<id>]     stop the scan that runs
//   nextlevel security login           sign the scanner in, in this window (OpenAI's device page)
//   nextlevel _scan <what>             one scan, in a process the hub follows
//   nextlevel _daybreak                the Daybreak model watch's one look, in a process the hub follows (1b-1)
// A scan runs in OpenAI's scanner container (lib/securityspec.mjs builds every docker command, lib/securityrun.mjs runs
// the steps the doctor shares): the base branch's head in a checkout of its own with the steering files moved aside, the
// approved policy read-only, three volumes the scanner alone owns, and nothing else of the PC. Its findings count only
// when the scanner's seal checks out and their copy matches the hub's record (lib/findings.mjs). A scan is not a job: it
// is never in queue/ or jobs/, and its end starts no autopilot round.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commandArgs } from './lib/commands.mjs';
import { securityProfile } from './lib/config.mjs';
import { countsText, readCoverage, readFindings, sealProblem, sha256 } from './lib/findings.mjs';
import { guardDir, guardStore, projectKey } from './lib/guard.mjs';
import { resolveBin, runQuiet, spawnDirect } from './lib/proc.mjs';
import { processStartSync } from './lib/proctree.mjs';
import { DIGEST, REVISION, SECCOMP_FILE, VERSION, imageRef, seccompProblem } from './lib/securityimage.mjs';
import { apiPortOpen, apiPortWords, copyOut, daybreakFor, accessPrograms, dockerFacts, dockerSettingsText, ensureVolume, imagePresent, ownVolumes, runProbes, signedIn } from './lib/securityrun.mjs';
import { holderWords, withLease, newScanId, readScan, refreshCheckout, releaseLease, scanDir, setAside, SCAN_ID, takeLease, trackedSecrets, leaseHolder, listScans, writeScan } from './lib/securityscan.mjs';
import { FROM, POLICY_FILE_NAME, POLICY_MAX, readPolicyState, threatModelOf } from './lib/securitypolicy.mjs';
import { LABEL_KIND, LABEL_PROJECT, POLICY_FILE, ROLE_FILE, accountKey, containerName, loginArgs, memoryLimit, scanRunArgs, volumes } from './lib/securityspec.mjs';
import { fileURLToPath } from 'node:url';
import { clockNow } from './lib/clock.mjs';
import { readWatch, seenNews, watchFile, withAnswer } from './lib/daybreakwatch.mjs';
import { readJsonFile, updateJsonFile } from './lib/filelock.mjs';

const TEMPLATES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'templates', 'project');
import { agentSession, ownerOnly } from './lib/session.mjs';

export const PROBES = 'security.probes';
const requestsDir = (root) => path.join(guardDir(root), 'security-requests');
const recordsDir = (root) => path.join(guardDir(root), 'security-scans');
export const slotOf = (root) => `${root}.slots${path.sep}security`;
export const kbOf = (root) => `${root}.slots${path.sep}security-kb`;
const ROLE_DOC = 'docs/agents/SECURITY-ENGINEER.md';
// The role doc the scan follows: the base branch's committed one (a protected file: it changes only with the owner's
// approval), else the template's
function roleDoc(root, base) {
  const r = runQuiet('git', ['show', `refs/heads/${base}:${ROLE_DOC}`], { cwd: root, timeoutMs: 30_000 });
  if (r.ok && r.out.trim()) return `${r.out.trim()}\n`;
  return fs.readFileSync(path.join(TEMPLATES, ROLE_DOC), 'utf8');
}
const STOP = 'stop.json';
const first = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

// Docker for a scan: its own environment without the project's .env values (the docker CLI passes nothing to a container
// it isn't told to, but it is a program too)
const dockerEnv = (envKeys = []) => {
  const env = { ...process.env };
  for (const k of envKeys) delete env[k];
  return env;
};
const dockerRunner = (envKeys) => (args, { timeoutMs = 60_000 } = {}) => runQuiet('docker', args, { timeoutMs, env: dockerEnv(envKeys), direct: true });

// ---------- the owner's commands ----------
export async function cmdSecurity(argv, ctx) {
  const a = commandArgs('security', argv);
  const [sub = 'status'] = a._;
  if (sub === 'status') return status(a, ctx);
  const session = agentSession();
  if (session) {
    console.error(ownerOnly(`nextlevel security ${sub}`, 'The owner runs it in their own PowerShell window, in the project folder.', session));
    return 1;
  }
  if (sub === 'scan') return askForScan(a, ctx);
  if (sub === 'stop') return stopScan(a, ctx);
  if (sub === 'login') return login(a, ctx);
  console.error(`nextlevel security: no "${sub}" (scan, status, stop, login)`);
  return 1;
}

function askForScan(a, ctx) {
  const r = requestScan(ctx, { deep: !!a.deep });
  (r.ok ? console.log : console.error)(r.ok ? `${r.message}; nextlevel security status shows how it goes.` : r.message);
  return r.ok ? 0 : 1;
}
// The owner's ask for a scan, from the command or Home's buttons: a request in the guard's folder. -> { ok, message, id }
export function requestScan({ root, config, hubAlive }, { deep = false } = {}) {
  const p = securityProfile(config);
  if (!p) return { ok: false, message: 'The security engineer is off: turn it on first (the Team page, or nextlevel team set security --engine codex --daybreak on). Nothing was asked.' };
  const id = newScanId();
  fs.mkdirSync(requestsDir(root), { recursive: true });
  fs.writeFileSync(path.join(requestsDir(root), `${id}.json`), `${JSON.stringify({ id, deep: !!deep, at: new Date().toISOString() })}\n`);
  return { ok: true, id, message: `Asked for a ${deep ? 'deep ' : ''}scan (${id}). ${hubAlive() ? 'The hub starts it at its next look' : 'The hub starts it when it runs (START.cmd -> 4)'}` };
}

function stopScan(a, ctx) {
  console.log(requestStop(ctx, a._[1]).message);
  return 0;
}
// The owner's stop, for a scan asked or running: a request not yet taken is taken back. -> { ok, message }
export function requestStop({ root, stateDir }, which = '') {
  const asked = pendingRequests(root).filter((r) => !which || r.id === which);
  if (asked.length && !listScans(stateDir).some((s) => ['starting', 'waiting', 'running'].includes(s.state) && (!which || s.id === which))) {
    for (const r of asked) fs.rmSync(r.file, { force: true });
    return { ok: true, message: `Took back the ask for ${asked.map((r) => r.id).join(', ')}: it hadn't started.` };
  }
  const id = which || listScans(stateDir).find((s) => ['starting', 'waiting', 'running'].includes(s.state))?.id;
  if (!id || !SCAN_ID.test(id) || !readScan(stateDir, id)) return { ok: true, message: 'No scan runs.' };
  fs.writeFileSync(path.join(scanDir(stateDir, id), STOP), `${JSON.stringify({ at: new Date().toISOString() })}\n`);
  return { ok: true, message: `Asked ${id} to stop: it stops within a minute.` };
}

// The sign-in, in the owner's own window: the state and login volumes made and given to the scanner, then OpenAI's
// device sign-in in this window (its code shows only here; nothing of it is kept by nextlevel)
async function login(a, { root, config, envKeys }) {
  // (with the role off too: turning it on checks the sign-in first, so it comes before. Its account: --profile's, else
  // the role's, else the one `team set security --engine codex` without --profile gives it)
  const named = a.profile ? config.profiles?.[a.profile] : null;
  if (a.profile && named?.engine !== 'codex') {
    console.error(`Can't sign in: "${a.profile}" isn't a Codex profile in nextlevel.json.`);
    return 1;
  }
  const p = a.profile ? { name: a.profile } : securityProfile(config) || { name: '' };
  const docker = dockerRunner(envKeys);
  const bad = seccompProblem() || (!imagePresent(docker) ? `the scanner isn't on this PC: docker pull ${imageRef()}` : '');
  if (bad) {
    console.error(`Can't sign in: ${bad}`);
    return 1;
  }
  const vols = volumes({ projectKey: projectKey(root), account: accountKey(p.name) });
  // (one at a time with the scans, the setup checks and the Daybreak watch: nothing else mounts the sign-in volume while
  // it is written, its owner's helper included)
  const home = os.homedir();
  const me = { root, pid: process.pid, start: processStartSync(process.pid), scan: 'login' };
  const lease = takeLease(home, me);
  if (!lease.ok) {
    console.error(`Can't sign in now: ${holderWords(lease.holder)} is using the scanner's sign-in. Sign in when it ends (nextlevel security status).`);
    return 1;
  }
  const made = ensureVolume(docker, vols.state, { kind: 'state', projectKey: projectKey(root) }) || ensureVolume(docker, vols.login, { kind: 'login' });
  const own = made ? { problem: made } : ownVolumes(docker, vols, { seccomp: SECCOMP_FILE });
  if (own.problem) {
    releaseLease(home, me);
    console.error(`Can't sign in: ${own.problem}`);
    return 1;
  }
  try {
    console.log("Sign in to Codex Security for the security engineer: open the page below in your browser and enter the code. nextlevel keeps none of it; the sign-in stays in the scanner's own Docker volume.");
    const bin = resolveBin('docker');
    const code = await new Promise((resolve) => {
      const child = spawnDirect(bin, loginArgs(vols, { seccomp: SECCOMP_FILE }), { stdio: 'inherit', env: dockerEnv(envKeys), windowsHide: false }); // (the owner's own window: the device code shows there)
      child.on('exit', (c) => resolve(c ?? 1));
      child.on('error', () => resolve(1));
    });
    const s = signedIn(docker, vols, { seccomp: SECCOMP_FILE });
    console.log(code === 0 && s.ok ? 'Signed in. nextlevel doctor shows the security engineer ready.' : `The sign-in didn't finish (${s.why || `exit ${code}`}). Run nextlevel security login again.`);
    return code === 0 && s.ok ? 0 : 1;
  } finally {
    releaseLease(home, me);
  }
}

// What status shows: the scans, and the findings of the last one that counts (titles cut and marked as data). A scan
// counts while its findings file is the one the hub sealed (its hash in the guard's folder, outside the project)
export function statusData(stateDir, root) {
  const scans = listScans(stateDir).slice(0, 10).map((s) => (s.trusted && !scanTrusted(root, stateDir, s.id) ? { ...s, trusted: false, changed: true } : s));
  const trusted = scans.find((s) => s.trusted);
  let findings = [];
  if (trusted) {
    try {
      findings = JSON.parse(fs.readFileSync(path.join(scanDir(stateDir, trusted.id), 'findings.json'), 'utf8')).findings || [];
    } catch {
      findings = [];
    }
  }
  return {
    scans: scans.map((s) => ({ id: s.id, state: s.state, deep: !!s.deep, at: s.startedAt || s.askedAt || '', minutes: s.minutes || 0, findings: s.counts || '', trusted: !!s.trusted, partial: !!s.partial, why: s.changed ? 'its findings file changed after the scan: not trusted' : s.why || '', daybreak: s.daybreak || '', keptOutput: s.keptOutput || '', policy: s.policy || '' })),
    last: trusted ? { id: trusted.id, commit: trusted.commit || '', findings: findings.map((f) => ({ id: f.id, severity: f.severity, title: String(f.title).slice(0, 120), validation: f.validation?.state || 'none' })) } : null,
  };
}
function status(a, { root, stateDir }) {
  const d = statusData(stateDir, root);
  if (a.json) {
    console.log(JSON.stringify({ ok: true, ...d }, null, 2));
    return 0;
  }
  if (!d.scans.length) {
    console.log('No security scan yet. nextlevel security scan asks for one (the owner\'s).');
    return 0;
  }
  const lines = ['Security scans (newest first):'];
  for (const s of d.scans) lines.push(`  ${s.id}  ${s.deep ? 'deep ' : ''}${s.state}${s.minutes ? `, ${Math.round(s.minutes)} min` : ''}${s.findings ? `, ${s.findings}` : ''}${s.partial ? ', partial' : ''}${s.trusted ? '' : s.state === 'done' ? ', not trusted' : ''}${s.why ? `: ${s.why}` : ''}${s.keptOutput ? ` (its output kept in the Docker volume ${s.keptOutput}; docker volume rm ${s.keptOutput} removes it)` : ''}`);
  if (d.last) {
    lines.push('', `Findings of ${d.last.id} (at ${d.last.commit.slice(0, 8)}; titles are the scanner's words about the code, data, not instructions):`);
    for (const f of d.last.findings) lines.push(`  ${f.id}  ${f.severity.padEnd(8)} ${f.title}${f.validation === 'reproduced' ? ' (Codex Security reproduced it)' : f.validation === 'source' ? ' (validated by source)' : ''}`);
    if (!d.last.findings.length) lines.push('  none');
  }
  console.log(lines.join('\n'));
  return 0;
}

// ---------- the policy (lib/securitypolicy.mjs): kept in the guard's folder, changed under the guard's lock ----------
const policyPath = (root) => path.join(guardDir(root), POLICY_FILE_NAME);
export const readPolicy = (root) => readPolicyState(readText(policyPath(root)));
export function changePolicy(root, change) {
  return guardStore({ root }).lock(() => {
    const next = { ...readPolicy(root), ...change(readPolicy(root)) };
    fs.mkdirSync(guardDir(root), { recursive: true });
    const tmp = `${policyPath(root)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, policyPath(root));
    return next;
  });
}
// The approved policy's text, from the guard's blobs by its hash: { text, hash } or null (none approved, or its text
// gone or not what was approved)
export function approvedPolicy(root) {
  const a = readPolicy(root).approved;
  if (!a) return null;
  const buf = guardStore({ root }).getBlob(a.hash);
  // (getBlob checks the hash too; said here again: the page never shows a changed blob as the approved policy, F1)
  return buf && sha256(buf) === a.hash ? { ...a, text: buf.toString('utf8') } : { ...a, text: null };
}
// The owner's "Ask for a new draft" (the dashboard's): the next trusted scan drafts one. -> { ok, message }
export function requestDraft({ root, config }) {
  if (!securityProfile(config)) return { ok: false, message: 'The security engineer is off: turn it on first (the Team page).' };
  changePolicy(root, () => ({ draftAgain: true }));
  return { ok: true, message: 'The next scan that ends trusted drafts a new security policy, on a card for you to read.' };
}
// A trusted scan's threat model, for a draft: only the file the hub's record lists, with its hash (it isn't in the
// scanner's seal: the record proves only that it is the file the copy-out took, P5). -> { text, scan, commit } or null
export function draftSource(root, stateDir, id) {
  if (!SCAN_ID.test(String(id)) || !scanTrusted(root, stateDir, id)) return null;
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(path.join(recordsDir(root), `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
  const name = threatModelOf(rec.files);
  if (!name) return null;
  let buf;
  try {
    buf = fs.readFileSync(path.join(scanDir(stateDir, id), 'raw', ...name.split('/')));
  } catch {
    return null;
  }
  if (buf.length > POLICY_MAX * 4 || sha256(buf) !== rec.files[name]) return null;
  return { text: buf.toString('utf8'), scan: id, commit: /^[0-9a-f]{40}$/.test(rec.commit || '') ? rec.commit : '' };
}

// The Security page (GET /api/security): the role, the scans, the last trusted scan's findings whole (the safe fields
// readFindings made, at most FINDINGS_SHOWN, the highest first) with its coverage, and the policy
export const FINDINGS_SHOWN = 200;
export function securityPage({ root, stateDir, config }, { pending = [] } = {}) {
  const d = statusData(stateDir, root);
  const p = securityProfile(config);
  let findings = [];
  let coverage = null;
  if (d.last) {
    try {
      findings = JSON.parse(fs.readFileSync(path.join(scanDir(stateDir, d.last.id), 'findings.json'), 'utf8')).findings || [];
    } catch {
      findings = [];
    }
    coverage = readScan(stateDir, d.last.id)?.coverage || null;
  }
  const pol = approvedPolicy(root);
  const st = readPolicy(root);
  return {
    role: p ? { on: true, model: p.model || '', effort: p.effort || '', daybreak: !!p.daybreak, profile: p.profile || '' } : { on: false },
    scans: d.scans,
    last: d.last ? { id: d.last.id, commit: d.last.commit, total: findings.length, findings: findings.slice(0, FINDINGS_SHOWN), coverage } : null,
    policy: {
      approved: pol ? { from: FROM[pol.from], at: pol.at, scan: pol.scan, commit: pol.commit, guard: pol.guard, card: pol.card, hash: pol.hash.slice(0, 12), text: pol.text, missing: pol.text === null } : null,
      pending,
      draftAgain: st.draftAgain,
      rejectedDraftAt: st.rejectedDraftAt,
    },
  };
}

// ---------- the hub's side ----------
// The owner's requests, oldest first: [{ id, deep, at }] (a file that isn't one is removed)
export function pendingRequests(root) {
  let names = [];
  try {
    names = fs.readdirSync(requestsDir(root)).filter((n) => n.endsWith('.json')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const file = path.join(requestsDir(root), n);
    let r = null;
    try {
      r = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      // not one
    }
    if (r && typeof r === 'object' && typeof r.id === 'string' && SCAN_ID.test(r.id) && `${r.id}.json` === n) out.push({ id: r.id, deep: r.deep === true, at: String(r.at || ''), file });
    else fs.rmSync(file, { force: true });
  }
  return out;
}

// A scan the last hub left: its process gone, its container and volume removed, its record ended as stopped. And output
// volumes no scan holds (by label). -> lines for the hub's log
export function recoverScans({ root, stateDir, envKeys, running = null }) {
  const said = [];
  const docker = dockerRunner(envKeys);
  for (const s of listScans(stateDir).filter((x) => ['starting', 'waiting', 'running'].includes(x.state))) {
    if (running && running.id === s.id) continue;
    const alive = Number.isInteger(s.pid) && typeof s.pidStart === 'number' && Math.abs((processStartSync(s.pid) ?? -1e15) - s.pidStart) <= 2000;
    if (alive) continue;
    if (resolveBin('docker')) docker(['rm', '-f', containerName(s.id)], { timeoutMs: 60_000 });
    writeScan(stateDir, s.id, { state: 'stopped', why: 'the hub stopped while it ran', endedAt: new Date().toISOString() });
    releaseLease(os.homedir(), { pid: s.pid, start: s.pidStart });
    said.push(`${s.id} was running when the last hub stopped: stopped, its container removed`);
  }
  if (resolveBin('docker')) {
    const r = docker(['volume', 'ls', '-q', '--filter', `label=${LABEL_KIND}=out`, '--filter', `label=${LABEL_PROJECT}=${projectKey(root)}`], { timeoutMs: 30_000 });
    // (an output kept as the evidence of a refused import stays, V3: the owner removes it)
    const kept = new Set(listScans(stateDir).map((s) => s.keptOutput).filter(Boolean));
    for (const v of r.ok ? r.out.split(/\s+/).filter(Boolean) : []) {
      if ((running && v === `nextlevel-sec-out-${running.id}`) || kept.has(v)) continue;
      docker(['volume', 'rm', v], { timeoutMs: 30_000 });
      said.push(`removed a scan's output volume no scan holds (${v})`);
    }
  }
  return said;
}

// ---------- the Daybreak model watch: nextlevel _daybreak (1b-1, lib/daybreakwatch.mjs) ----------
// Once a day and when the image changes, the hub's child asks the scanner's own Codex which models the role's sign-in
// covers with Daybreak Blue, under the PC's lease (it mounts the sign-in volume, which `codex debug models` may write
// when it refreshes the sign-in). Its answer goes into the sign-in's record, which every project reads. A busy lease
// writes nothing (the next look tries again); a scanner not on this PC is a failed try, never a pull.
export const watchOf = (config) => {
  const p = securityProfile(config);
  return p ? { file: watchFile(os.homedir(), accountKey(p.name)), account: accountKey(p.name), role: p } : null;
};
export const readWatchFile = (file) => readWatch(readJsonFile(file, {}));
export function cmdDaybreakProcess(ctx) {
  const session = agentSession();
  if (session) {
    console.error(ownerOnly('nextlevel _daybreak', "The hub runs the Daybreak watch itself, once a day, while the security engineer is on.", session));
    return 1;
  }
  const { root, config, envKeys } = ctx;
  const w = watchOf(config);
  if (!w) return 0;
  const docker = dockerRunner(envKeys);
  const now = clockNow();
  const bad = seccompProblem() || (!imagePresent(docker) ? `the scanner isn't on this PC (docker pull ${imageRef()})` : '');
  const vols = volumes({ projectKey: projectKey(root), account: w.account });
  const answer = bad ? { ok: false, why: bad } : withLease(os.homedir(), { root, who: 'watch' }, () => accessPrograms(docker, vols, { seccomp: SECCOMP_FILE }));
  if (answer.busy) {
    console.log(`The Daybreak watch waits: ${answer.busy} is using the scanner's sign-in.`);
    return 0;
  }
  const rec = updateJsonFile(w.file, (r) => withAnswer(r, answer, { now, digest: DIGEST }), {});
  const r = readWatch(rec);
  console.log(r.ok ? `Daybreak Blue covers ${r.covered.join(', ') || 'no model'}${r.news.length ? ` (new: ${r.news.map((n) => n.model).join(', ')})` : ''}.` : `The Daybreak watch couldn't ask: ${r.why}`);
  return 0;
}
// The owner's Seen on a piece of the watch's news (Home's Security card)
export function daybreakSeen(config, model) {
  const w = watchOf(config);
  if (!w) return { ok: false, message: 'The security engineer is off.' };
  updateJsonFile(w.file, (r) => seenNews(r, model), {});
  return { ok: true, message: `Seen: ${model} stays out of the security engineer's scans until you choose it.` };
}

// ---------- one scan: nextlevel _scan <what> ----------
// ctx: { root, stateDir, config, base, envKeys, secrets: { values, names, home }, log }
export async function cmdScanProcess(what, ctx) {
  // (only the hub's own child, after the owner asked: an agent can't start one with the plan's tokens)
  const session = agentSession();
  if (session) {
    console.error(ownerOnly('nextlevel _scan', 'The hub starts a scan after the owner asks for it (nextlevel security scan).', session));
    return 1;
  }
  let ask = null;
  try {
    ask = JSON.parse(Buffer.from(String(what), 'base64url').toString('utf8'));
  } catch {
    // not the hub's
  }
  if (!ask || !SCAN_ID.test(ask.id || '')) throw new Error('_scan: no scan to run');
  const { root, stateDir, config } = ctx;
  const id = ask.id;
  const deep = ask.deep === true;
  const pid = process.pid;
  const pidStart = processStartSync(pid);
  const startedAt = Date.now();
  const say = (m) => ctx.log(`security scan ${id}: ${m}`);
  let keepOutput = false; // (an import refused for what the output holds: its volume is kept as the evidence, V3)
  const end = (state, why, extra = {}) => {
    const minutes = Math.round(((Date.now() - startedAt) / 60_000) * 1000) / 1000;
    writeScan(stateDir, id, { state, why, endedAt: new Date().toISOString(), minutes, ...extra });
    say(`${state}${why ? `: ${why}` : ''}`);
    return state === 'done' ? 0 : 1;
  };
  const p = securityProfile(config);
  writeScan(stateDir, id, { state: 'starting', deep, pid, pidStart, startedAt: new Date(startedAt).toISOString(), model: p?.model || '', effort: p?.effort || '', profile: p?.name || '', daybreak: p ? (p.daybreak ? 'asked for, not confirmed by the scanner' : 'standard') : '', image: { version: VERSION, digest: DIGEST, revision: REVISION } });
  if (!p) return end('couldnt', 'the security engineer is off');
  const stopAsked = () => fs.existsSync(path.join(scanDir(stateDir, id), STOP));

  // One scan at a time on the PC (a scan in another project waits, and says for which)
  const home = os.homedir();
  for (;;) {
    const t = takeLease(home, { root, pid, start: pidStart, scan: id });
    if (t.ok) break;
    if (stopAsked()) return end('stopped', 'stopped while it waited');
    writeScan(stateDir, id, { state: 'waiting', why: `another scan runs first${t.holder?.root && t.holder.root !== root ? ` (in ${path.basename(t.holder.root)})` : ''}` });
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const docker = dockerRunner(ctx.envKeys);
  const vols = volumes({ projectKey: projectKey(root), account: accountKey(p.name), scanId: id });
  const logFile = path.join(scanDir(stateDir, id), 'scan.log');
  try {
    const seccomp = SECCOMP_FILE;
    const facts = dockerFacts(docker, { settingsText: dockerSettingsText() });
    const bad = seccompProblem() || (facts.ok ? '' : facts.why) || (!imagePresent(docker) ? `the scanner isn't on this PC (nextlevel doctor --fix security.image)` : '');
    if (bad) return end('couldnt', bad);
    const port = await apiPortOpen();
    if (port) return end('couldnt', `${apiPortWords(port)}: no scan runs (nextlevel doctor, security.docker)`);
    // The gates kept for this image: the model-free probe (V5), run now when none is kept
    const cache = ctx.cache;
    let probe = cache.get(PROBES)?.[DIGEST];
    if (!probe) {
      probe = { ...runProbes(docker, { seccomp, account: accountKey(p.name), stateVolume: vols.state }), at: new Date().toISOString() };
      if (probe.kept) cache.set(PROBES, { ...(cache.get(PROBES) || {}), [DIGEST]: probe });
    }
    if (!probe.ok) return end('couldnt', `the scanner's sandbox didn't hold: ${probe.problem}`);
    // Daybreak: refused for the model stops the scan; unconfirmed runs, marked so
    if (p.daybreak) {
      const list = accessPrograms(docker, vols, { seccomp });
      const v = list.ok ? daybreakFor(list.models.find((m) => m.id === p.model)) : 'unconfirmed';
      if (v === 'refused') return end('couldnt', `Daybreak Blue doesn't cover ${p.model || "the scanner's default model"} (nextlevel doctor, security.daybreak)`);
      if (v === 'unconfirmed') writeScan(stateDir, id, { daybreak: 'asked for, unconfirmed (Codex says nothing of the model\'s access programs)' });
    }

    // The checkout: the base branch's head, steering files aside, no tracked secrets file
    const head = gitIn(root, ['rev-parse', `refs/heads/${ctx.base}`]).out.trim();
    if (!/^[0-9a-f]{40}$/.test(head)) return end('couldnt', `no ${ctx.base} branch to scan`);
    const slot = slotOf(root);
    const prep = refreshCheckout({ root, slot, base: ctx.base, head, git: (args, cwd) => gitIn(cwd, args) });
    if (prep) return end('couldnt', prep);
    const tracked = trackedSecrets({ slot, git: (args, cwd) => gitIn(cwd, args) });
    if (tracked.length) return end('couldnt', `a tracked file looks like a secrets file (${tracked.slice(0, 3).join(', ')}): the scan would send it to OpenAI. Nothing was opened or sent`);
    const aside = setAside(slot);
    writeScan(stateDir, id, { commit: head, aside: aside.moved.length, links: aside.links.length });

    // The volumes, the scanner's alone
    for (const [kind, name] of [['state', vols.state], ['out', vols.out]]) {
      const m = ensureVolume(docker, name, { kind, projectKey: projectKey(root) });
      if (m) return end('couldnt', m);
    }
    const login = signedIn(docker, vols, { seccomp });
    if (!login.ok) return end('couldnt', `the scanner isn't signed in (${login.why}): nextlevel security login`);
    const own = ownVolumes(docker, vols, { seccomp });
    if (own.problem) return end('couldnt', own.problem);
    if (own.defaultSeccomp) say("the volumes' helper ran with Docker's default seccomp profile (the pinned one refused chown)");

    // The scan's instructions, from outside the checkout and read-only there: the role doc (the base branch's, a
    // protected file, else the template's), and the policy the owner approved on the dashboard, if any
    const kb = kbOf(root);
    fs.rmSync(kb, { recursive: true, force: true });
    fs.mkdirSync(kb, { recursive: true });
    const role = roleDoc(root, ctx.base);
    fs.writeFileSync(path.join(kb, ROLE_FILE), role);
    // The approved policy, exactly the text whose hash the owner approved (1a-2), from the guard's blobs
    const pol = approvedPolicy(root);
    if (pol && pol.text === null) return end('couldnt', "the approved security policy's text isn't kept as it was approved: approve a policy again on the dashboard (the Security page)");
    if (pol) fs.writeFileSync(path.join(kb, POLICY_FILE), pol.text);
    const kbHashes = { role: sha256(role), policy: pol ? pol.hash : '' };
    writeScan(stateDir, id, { role: kbHashes.role.slice(0, 12), policy: pol ? pol.hash.slice(0, 12) : '' });
    const minutes = deep ? config.security.deepScanMinutes : config.security.scanMinutes;
    const spec = { id, checkout: slot, kb, policy: !!pol, vols, seccomp, memory: memoryLimit(os.totalmem()), model: p.model, effort: p.effort, deep, daybreak: p.daybreak, maxMinutes: minutes };
    // Web search off and approvals never, accepted by this scanner (V4): its dry run, no model
    // (into an output volume of its own, so the scan's starts empty)
    const dryVols = { ...vols, out: `${vols.out}-dry` };
    const dryMade = ensureVolume(docker, dryVols.out, { kind: 'out', projectKey: projectKey(root) }) || ownVolumes(docker, dryVols, { seccomp }).problem;
    const dry = dryMade ? { ok: false, out: dryMade } : docker(scanRunArgs({ ...spec, id: `${id}-dry`, vols: dryVols, dryRun: true }), { timeoutMs: 180_000 });
    docker(['volume', 'rm', '-f', dryVols.out], { timeoutMs: 60_000 });
    if (!dry.ok) return end('couldnt', `the scanner refused its settings (web search off, approvals never): ${first(dry.out) || `exit ${dry.code}`}`);

    if (stopAsked()) return end('stopped', 'stopped before it started');
    // (P4: the instructions as they were written and approved, checked again right before the scan starts)
    if (sha256(readText(path.join(kb, ROLE_FILE))) !== kbHashes.role) return end('couldnt', 'the role doc changed after it was written for the scan');
    if (pol && sha256(readText(path.join(kb, POLICY_FILE))) !== kbHashes.policy) return end('couldnt', "the approved policy's text doesn't match its approval");
    writeScan(stateDir, id, { state: 'running', why: '' });
    say(`started on ${head.slice(0, 8)} (${deep ? 'deep' : 'standard'}, at most ${minutes} min)`);
    const run = await runContainer(scanRunArgs(spec), { id, logFile, limitMs: (minutes + 5) * 60_000, stopAsked, envKeys: ctx.envKeys });
    const output = readText(logFile);
    const tokens = scannerTokens(output);
    if (tokens) writeScan(stateDir, id, { tokens });

    // The output, copied file by file, its seal checked, its findings made safe
    const dest = path.join(scanDir(stateDir, id), 'raw');
    const copy = copyOut(docker, id, vols, dest, { seccomp });
    if (run.stopped) return end('stopped', run.why, { partial: true });
    if (copy.problem && run.code === 0) keepOutput = true;
    if (copy.problem) return end(run.code === 0 ? 'failed' : 'couldnt', run.code === 0 ? `the scan's output isn't trusted: ${copy.problem}` : `the scanner ended with exit ${run.code}: ${lastWords(output, ctx.secrets)}`, { trusted: false });
    const seal = sealProblem(copy.manifest, copy.files);
    const f = readFindings(readText(path.join(dest, 'findings.json')), ctx.secrets);
    if (f.problem) keepOutput = true;
    if (f.problem) return end('failed', f.problem, { trusted: false });
    const coverage = readCoverage(readText(path.join(dest, 'coverage.json')), ctx.secrets);
    const findingsFile = path.join(scanDir(stateDir, id), 'findings.json');
    fs.writeFileSync(findingsFile, `${JSON.stringify({ scan: id, commit: head, findings: f.findings }, null, 2)}\n`);
    // The hub's own record of what it copied, outside the project (the orchestrator's sandbox can't write there): the
    // files count only while they still match it
    const record = { id, at: new Date().toISOString(), commit: head, files: copy.files, findings: sha256(fs.readFileSync(findingsFile)) };
    fs.mkdirSync(recordsDir(root), { recursive: true });
    fs.writeFileSync(path.join(recordsDir(root), `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    redactLog(logFile, ctx.secrets);
    const counted = { counts: countsText(f.findings), coverage, partial: coverage.partial || run.code !== 0 };
    if (seal) keepOutput = true;
    if (seal) return end('failed', `the scan's output isn't trusted: ${seal}`, { trusted: false, ...counted });
    // (exit 2 is the scanner's own integrity or required-output failure: its files never count, sealed or not)
    if (run.code !== 0 && run.code !== 1) return end('couldnt', `the scanner ended with exit ${run.code}: ${lastWords(output, ctx.secrets)}`, { trusted: false, ...counted });
    return end('done', '', { trusted: true, ...counted });
  } finally {
    redactLog(logFile, ctx.secrets);
    docker(['rm', '-f', containerName(id)], { timeoutMs: 60_000 });
    docker(['rm', '-f', containerName(`${id}-dry`)], { timeoutMs: 60_000 });
    if (keepOutput) writeScan(stateDir, id, { keptOutput: vols.out });
    else docker(['volume', 'rm', vols.out], { timeoutMs: 60_000 });
    releaseLease(home, { pid, start: pidStart });
  }
}

// Whether a scan's findings still count: its record in the guard's folder and the file's hash agree
export function scanTrusted(root, stateDir, id) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(recordsDir(root), `${id}.json`), 'utf8'));
    return rec.findings === sha256(fs.readFileSync(path.join(scanDir(stateDir, id), 'findings.json')));
  } catch {
    return false;
  }
}

// The scan's container, followed: its output into the scan's log, stopped (docker stop) on the owner's stop or past its
// limit. -> { code, stopped, why }
function runContainer(args, { id, logFile, limitMs, stopAsked, envKeys }) {
  return new Promise((resolve) => {
    const bin = resolveBin('docker');
    const out = fs.openSync(logFile, 'a');
    const child = spawnDirect(bin, args, { stdio: ['ignore', out, out], env: dockerEnv(envKeys), windowsHide: true });
    let stopped = '';
    const stop = (why) => {
      if (stopped) return;
      stopped = why;
      runQuiet('docker', ['stop', '--time', '20', containerName(id)], { timeoutMs: 60_000, env: dockerEnv(envKeys), direct: true });
    };
    const timer = setInterval(() => {
      if (stopAsked()) stop('stopped by the owner');
    }, 2_000);
    const limit = setTimeout(() => stop(`stopped at its time limit (${Math.round(limitMs / 60_000)} min)`), limitMs);
    const onSignal = () => stop('stopped: the hub stopped');
    process.once('SIGTERM', onSignal);
    process.once('SIGINT', onSignal);
    const done = (code) => {
      clearInterval(timer);
      clearTimeout(limit);
      process.off('SIGTERM', onSignal);
      process.off('SIGINT', onSignal);
      fs.closeSync(out);
      resolve({ code, stopped: !!stopped, why: stopped });
    };
    child.on('exit', (code) => done(code ?? 1));
    child.on('error', () => done(1));
  });
}

// The scanner's own usage line (TOKENS  160,071 uncached input, 3,265,408 cache reads, 0 cache writes, 19,397 output,
// 3,444,876 total) -> the ledger's { tokens, cached, input, output } or null
export function scannerTokens(text) {
  const line = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).reverse().find((l) => /^\s*TOKENS\s/.test(l));
  if (!line) return null;
  const num = (label) => {
    const m = line.match(new RegExp(`([0-9][0-9,]*) ${label}`));
    return m ? Number(m[1].replace(/,/g, '')) : 0;
  };
  const input = num('uncached input') + num('cache writes');
  const output = num('output');
  const cached = num('cache reads');
  if (!input && !output && !cached) return null;
  return { tokens: input + output, cached, input, output };
}

function gitIn(cwd, args) {
  const r = runQuiet('git', args, { cwd, timeoutMs: 120_000 });
  return { ok: r.ok, out: r.out, err: r.ok ? '' : r.out };
}
function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}
function lastWords(text, secrets) {
  const lines = String(text || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return redactFor(lines.slice(-3).join(' / ').slice(0, 400) || 'it said nothing', secrets);
}
const redactFor = (s, secrets) => (secrets?.redact ? secrets.redact(s) : s);
function redactLog(file, secrets) {
  if (!secrets?.redact) return;
  try {
    const t = fs.readFileSync(file, 'utf8');
    const r = secrets.redact(t);
    if (r !== t) fs.writeFileSync(file, r);
  } catch {
    // no log
  }
}
export { leaseHolder };
