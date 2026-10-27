// The security engineer's Docker steps that both the doctor's checks and a scan run (docs/design/security-engineer.md,
// deltas 1 and 2): Docker itself, the pinned image, the volumes and their owners, the model-free probes, the sign-in's
// file names, the Daybreak check's model list, and the copy-out. Each takes `docker(args, { timeoutMs })` -> { ok, code,
// missing, timedOut, out } (lib/proc.mjs runQuiet's shape), so the checks' fake PC and the scan's process drive them alike.
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { COPY_LIMITS, MANIFEST, copyList, readManifest, sha256, unsafeName } from './findings.mjs';
import { DIGEST, IMAGE, imageRef } from './securityimage.mjs';
import { LABEL_KIND, copyCreateArgs, copyFileArgs, copyName, helperArgs, loginFilesArgs, modelsArgs, nestedArgs, plantArgs, probeArgs, probeLoginVolume, probeProblem, statArgs, statProblem, volumeCreateArgs } from './securityspec.mjs';

const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

// Docker as the scan needs it: running, Linux containers, its API not open on TCP. -> { ok, detail, apparmor } or
// { ok: false, why, stopped }. settingsText: Docker Desktop's settings-store.json, read by key only ('' when none).
export function dockerFacts(docker, { settingsText = '' } = {}) {
  const r = docker(['info', '--format', '{{json .OSType}} {{json .SecurityOptions}} {{json .ServerVersion}}'], { timeoutMs: 30_000 });
  if (r.missing) return { ok: false, missing: true, why: 'Docker is not installed' };
  if (!r.ok) return { ok: false, stopped: true, why: r.timedOut ? 'Docker gave no answer in 30 s (still starting?)' : 'Docker is not running' };
  const [os = '', opts = '', version = ''] = firstLine(r.out).split(' ');
  if (os !== '"linux"') return { ok: false, why: `Docker runs ${os.replace(/"/g, '') || 'no'} containers: the scanner needs Linux containers` };
  if (/"?ExposeDockerAPIOnTCP2375"?\s*:\s*true/i.test(settingsText)) return { ok: false, tcp: true, why: "Docker's API is open on TCP port 2375 (Docker Desktop: Settings, General, \"Expose daemon on tcp://localhost:2375 without TLS\"): any program on this PC, a scanned project's included, could drive Docker" };
  return { ok: true, detail: `engine ${version.replace(/"/g, '')}, Linux containers`, apparmor: /name=apparmor/.test(opts) };
}

// Docker Desktop's settings, for one key (ExposeDockerAPIOnTCP2375; never shown): Windows only, '' elsewhere
export function dockerSettingsText({ platform = process.platform, env = process.env, read, join = path.join } = {}) {
  if (platform !== 'win32' || !env.APPDATA) return '';
  const readText = read || ((f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  });
  return readText(join(env.APPDATA, 'Docker', 'settings-store.json')) || readText(join(env.APPDATA, 'Docker', 'settings.json')) || '';
}

// Whether Docker's API answers on TCP on this PC (2375 without TLS, 2376 with): the first open port, or 0. Under the
// tests' stubs no port is tried: NEXTLEVEL_TEST_DOCKER_API names the ones that play open
export function apiPortOpen({ connect = net.connect, ports = [2375, 2376], env = process.env } = {}) {
  if (env.NEXTLEVEL_TEST_STUBS) return Promise.resolve(ports.find((p) => String(env.NEXTLEVEL_TEST_DOCKER_API || '').split(',').includes(String(p))) || 0);
  return Promise.all(ports.map((port) => new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    const done = (open) => {
      s.destroy();
      resolve(open ? port : 0);
    };
    s.setTimeout(1500, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  }))).then((r) => r.find(Boolean) || 0);
}
export const apiPortWords = (port) => `Docker's API answers on 127.0.0.1:${port}: any program on this PC, a scanned project's included, could drive Docker`;

// Whether the pinned image is on this PC (pulled by its digest)
export function imagePresent(docker) {
  const r = docker(['image', 'inspect', '--format', '{{json .RepoDigests}}', imageRef()], { timeoutMs: 30_000 });
  return r.ok && r.out.includes(`${IMAGE}@${DIGEST}`);
}
export const pullArgs = () => ['pull', imageRef()];

// A volume made when it isn't there (labels say what it is). -> '' or why not
export function ensureVolume(docker, name, labels) {
  const r = docker(['volume', 'inspect', '--format', `{{index .Labels "${LABEL_KIND}"}}`, name], { timeoutMs: 20_000 });
  if (r.ok) return firstLine(r.out) === labels.kind ? '' : `a Docker volume named ${name} is there but isn't nextlevel's ${labels.kind} volume`;
  const c = docker(volumeCreateArgs(name, labels), { timeoutMs: 20_000 });
  return c.ok ? '' : `Docker couldn't make the volume ${name}: ${firstLine(c.out)}`;
}
export const volumeExists = (docker, name) => docker(['volume', 'inspect', '--format', '{{.Name}}', name], { timeoutMs: 20_000 }).ok;

// The volumes given to the image's user with 700, then read back (V2). -> { problem, defaultSeccomp }
export function ownVolumes(docker, vols, { seccomp }) {
  let defaultSeccomp = false;
  let r = docker(helperArgs('chown', vols, { seccomp }), { timeoutMs: 60_000 });
  // (the pinned profile may refuse chown: the helper alone then runs with Docker's default profile, said)
  if (!r.ok && /operation not permitted/i.test(r.out)) {
    defaultSeccomp = true;
    r = docker(helperArgs('chown', vols, { seccomp, defaultSeccomp }), { timeoutMs: 60_000 });
  }
  if (!r.ok) return { problem: `the volumes couldn't be given to the scanner (chown: ${firstLine(r.out) || `exit ${r.code}`})`, defaultSeccomp };
  const m = docker(helperArgs('chmod', vols, { seccomp, defaultSeccomp }), { timeoutMs: 60_000 });
  if (!m.ok) return { problem: `the volumes couldn't be closed to others (chmod: ${firstLine(m.out) || `exit ${m.code}`})`, defaultSeccomp };
  const s = docker(statArgs(vols, { seccomp }), { timeoutMs: 60_000 });
  if (!s.ok) return { problem: `the volumes' owners couldn't be read (${firstLine(s.out) || `exit ${s.code}`})`, defaultSeccomp };
  return { problem: statProblem(s.out, vols), defaultSeccomp };
}

// The probes (D5, V5), no model: Codex's sandbox starts in the container, and under the scan's profile the sign-in (a
// throwaway volume with a planted harmless auth.json) can't be read or listed and the network is closed.
// -> { ok, problem, answer }
export function runProbes(docker, { seccomp, account, stateVolume }) {
  const n = docker(nestedArgs({ seccomp }), { timeoutMs: 120_000 });
  if (!n.ok) return { ok: false, kept: true, problem: `Codex's sandbox can't start in the scanner (nested namespaces: ${firstLine(n.out) || `exit ${n.code}`})` };
  const probe = probeLoginVolume(account);
  const made = ensureVolume(docker, probe, { kind: 'probe' }) || ensureVolume(docker, stateVolume, { kind: 'state' });
  if (made) return { ok: false, problem: made };
  const own = ownVolumes(docker, { state: stateVolume, login: probe }, { seccomp });
  if (own.problem) return { ok: false, problem: own.problem };
  const p = docker(plantArgs(probe, { seccomp }), { timeoutMs: 60_000 });
  if (!p.ok) return { ok: false, problem: `the probe's planted file couldn't be written (${firstLine(p.out) || `exit ${p.code}`})` };
  const r = docker(probeArgs(probe, { seccomp, stateVolume }), { timeoutMs: 120_000 });
  docker(['volume', 'rm', probe], { timeoutMs: 20_000 });
  const problem = r.ok ? probeProblem(r.out) : `the probe didn't run (${firstLine(r.out) || `exit ${r.code}`})`;
  // (kept for the image only when the probe answered: a volume or Docker problem is asked again next time)
  return { ok: !problem, kept: r.ok, problem, answer: r.out.split(/\s+/).filter((w) => /^(login|authfile|net|ip)-/.test(w)) };
}

// Whether the sign-in volume holds a sign-in: by its files' names only (never read)
export function signedIn(docker, vols, { seccomp }) {
  if (!volumeExists(docker, vols.login)) return { ok: false, why: 'not signed in yet' };
  const r = docker(loginFilesArgs(vols, { seccomp }), { timeoutMs: 60_000 });
  if (!r.ok) return { ok: false, why: `the sign-in's folder couldn't be listed (${firstLine(r.out) || `exit ${r.code}`})` };
  return r.out.split(/\s+/).includes('auth.json') ? { ok: true } : { ok: false, why: 'not signed in yet (no sign-in in its volume)' };
}

// The container's models with the access programs each takes (`codex debug models`). -> { ok, models: [{ id, programs }] }
export function accessPrograms(docker, vols, { seccomp }) {
  const r = docker(modelsArgs(vols, { seccomp }), { timeoutMs: 120_000 });
  if (!r.ok) return { ok: false, why: firstLine(r.out) || `exit ${r.code}` };
  const t = r.out;
  let json = null;
  try {
    json = JSON.parse(t.slice(Math.max(0, t.indexOf('{'))));
  } catch {
    // not JSON
  }
  const items = Array.isArray(json?.models) ? json.models : [];
  const models = items
    .filter((m) => m && typeof m === 'object' && typeof m.slug === 'string' && m.visibility !== 'hide' && m.visibility !== 'none')
    .map((m) => ({ id: m.slug, programs: Array.isArray(m.available_access_programs?.cyber) ? m.available_access_programs.cyber.filter((x) => typeof x === 'string') : null }));
  return models.length ? { ok: true, models } : { ok: false, why: "the scanner's Codex listed no models" };
}
// What Daybreak Blue is for one model: 'works' (it takes daybreak_blue), 'refused' (it doesn't: standard, or Red only), or
// 'unconfirmed' (Codex said nothing of its access programs)
export const daybreakFor = (m) => (!m ? 'refused' : m.programs === null ? 'unconfirmed' : m.programs.includes('daybreak_blue') ? 'works' : 'refused');

// The copy-out (V3): the output volume through a container that never starts, the manifest first, then each listed file
// and the few the scan writes beside them, one `docker cp` each, every one checked (a regular file, no link, within the
// caps; the listed ones' hashes against the manifest). -> { files: { rel: sha256 }, manifest } or { problem }
export function copyOut(docker, id, vols, dest, opts) {
  const r = copyFiles(docker, id, vols, dest, opts);
  // (a refused copy leaves nothing on the PC: rmSync removes a link, never its target; the output volume is the evidence
  // until the scan ends)
  if (r.problem) fs.rmSync(dest, { recursive: true, force: true });
  return r;
}
function copyFiles(docker, id, vols, dest, { seccomp, lstat = fs.lstatSync, read = fs.readFileSync }) {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  docker(['rm', '-f', copyName(id)], { timeoutMs: 30_000 });
  const c = docker(copyCreateArgs(id, vols, { seccomp }), { timeoutMs: 60_000 });
  if (!c.ok) return { problem: `the scan's output couldn't be reached (${firstLine(c.out) || `exit ${c.code}`})` };
  let total = 0;
  const files = {};
  const take = (rel, { optional = false } = {}) => {
    const why = unsafeName(rel);
    if (why) return `the scan's output has an unsafe name (${why})`;
    const parts = rel.split('/');
    const to = path.join(dest, ...parts);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const r = docker(copyFileArgs(id, rel, to), { timeoutMs: 120_000 });
    if (!r.ok) return optional ? '' : `a file of the scan's output couldn't be copied (${rel})`;
    let st;
    try {
      st = lstat(to);
    } catch {
      return optional ? '' : `a file of the scan's output is missing (${rel})`;
    }
    if (!st.isFile()) return `the scan's output has something that isn't a plain file (${rel})`;
    if (st.size > COPY_LIMITS.file) return `a file of the scan's output is over ${COPY_LIMITS.file / 1024 / 1024} MB (${rel})`;
    total += st.size;
    if (total > COPY_LIMITS.total) return `the scan's output is over ${COPY_LIMITS.total / 1024 / 1024} MB`;
    files[rel] = sha256(read(to));
    return '';
  };
  try {
    let problem = take(MANIFEST);
    if (problem) return { problem };
    const m = readManifest(read(path.join(dest, MANIFEST), 'utf8'));
    if (m.problem) return { problem: m.problem };
    for (const rel of copyList(m.manifest)) {
      const listed = m.manifest.artifacts.some((a) => a.path === rel);
      problem = take(rel, { optional: !listed });
      if (problem) return { problem };
      const want = m.manifest.artifacts.find((a) => a.path === rel);
      if (want && files[rel] !== want.sha256) return { problem: `a sealed file changed (${rel})` };
    }
    // (nothing else: a file the manifest doesn't list never reaches the PC)
    return { files, manifest: m.manifest };
  } finally {
    docker(['rm', '-f', copyName(id)], { timeoutMs: 30_000 });
  }
}
