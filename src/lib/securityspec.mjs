// What the security engineer's scan runs with (docs/design/security-engineer.md §5, deltas 1 and 2): every `docker`
// command nextlevel runs for it, built here and nowhere else, so the tests read one place. Pure.
//
// The scan runs in OpenAI's scanner container (lib/securityimage.mjs), and Docker's mount list is its boundary: the scan's
// checkout and the approved policy as read-only binds, and three Docker volumes for what the scanner writes (its state,
// the sign-in, the scan's output; a Windows bind mount shows as 777, and the scanner wants 700). No other host path, no
// Docker socket, no ports, no --env-file and never `-e NAME` alone (it would copy the host's value). The two names the
// container has for the PC point nowhere (--add-host): that renames the host and is no wall (KNOWN_ISSUES).
import { createHash } from 'node:crypto';
import { CODEX_JS, SCAN_USER, imageRef } from './securityimage.mjs';

// Where each volume is in the container
export const STATE_AT = '/output/.codex-security-state';
export const LOGIN_AT = `${STATE_AT}/codex-home`;
export const OUT_AT = '/output/scan';
export const REPO_AT = '/input/repository';
export const KB_AT = '/input/kb';
export const POLICY_FILE = 'policy.md';
export const ROLE_FILE = 'role.md'; // the role doc, as the scan's own instructions (--scan-prompt-file)

// The helper's paths for the three volumes (V2)
const V = { state: '/v/state', login: '/v/login', out: '/v/out' };

// The scan's own Codex permission profile, as the scanner sets it (its scanRuntimeCodexConfig at the pinned revision:
// ":root" read, the workspace written, its Codex home denied; the network as Codex's profile leaves it, off), for the probe
export const PROBE_PROFILE = 'nextlevel_probe';
export const PROBE_CONFIG = [
  '-c', `default_permissions="${PROBE_PROFILE}"`,
  '-c', `permissions.${PROBE_PROFILE}.filesystem={":root"="read",":workspace_roots"="write","${LOGIN_AT}"={"."="deny"}}`,
];
// What the probe runs inside Codex's sandbox: five words, each the answer the scan needs (V5)
export const PROBE_SCRIPT = [
  `test -r ${LOGIN_AT} && echo login-readable || echo login-denied`,
  `ls ${LOGIN_AT} >/dev/null 2>&1 && echo login-listable || echo login-not-listable`,
  `test -r ${LOGIN_AT}/auth.json && echo authfile-readable || echo authfile-denied`,
  'getent hosts example.com >/dev/null && echo net-open || echo net-closed',
  // (a name that doesn't resolve says nothing of an address: a connect to one, with the image's own node)
  `node -e "const s=require('net').connect({host:'1.1.1.1',port:443});const e=(w)=>{console.log(w);process.exit(0)};s.setTimeout(3000,()=>e('ip-closed'));s.on('connect',()=>e('ip-open'));s.on('error',()=>e('ip-closed'))"`,
].join('; ');
export const PROBE_EXPECTED = ['login-denied', 'login-not-listable', 'authfile-denied', 'net-closed', 'ip-closed'];

const hash = (s) => createHash('sha256').update(s).digest('hex');

// A Codex account's key for its sign-in volume: a hash of the role's profile name, never an e-mail, a folder or a name
export const accountKey = (profileName = '') => hash(`security-login:${profileName || 'default'}`).slice(0, 16);

// The volumes (V1). projectKey: the guard's hashed key (lib/guard.mjs projectKey), so `docker volume ls` shows nothing
// about the owner
export function volumes({ projectKey, account, scanId }) {
  return {
    state: `nextlevel-sec-state-${projectKey}`,
    login: `nextlevel-sec-login-${account}`,
    ...(scanId ? { out: `nextlevel-sec-out-${scanId}` } : {}),
  };
}
export const probeLoginVolume = (account) => `nextlevel-sec-probe-${account}`;
export const LABEL_KIND = 'nextlevel.kind';
export const LABEL_PROJECT = 'nextlevel.project';

// `docker volume create` for one: labels say what it is (the sign-in's names no project)
export function volumeCreateArgs(name, { kind, projectKey = '' }) {
  return ['volume', 'create', '--label', `${LABEL_KIND}=${kind}`, ...(kind !== 'login' && projectKey ? ['--label', `${LABEL_PROJECT}=${projectKey}`] : []), name];
}

// What every container nextlevel starts for the scan has: the image's user (but the helper's), no capabilities, no new
// privileges, the pinned seccomp profile
const hardened = (seccomp, user = SCAN_USER) => ['--user', user, '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges:true', '--security-opt', `seccomp=${seccomp}`];
const volumeMount = (source, target, readonly = false) => ['--mount', `type=volume,source=${source},target=${target}${readonly ? ',readonly' : ''}`];
const bindMount = (source, target) => ['--mount', `type=bind,source=${source},target=${target},readonly`];
// The two names Docker Desktop gives the PC, pointed nowhere (a name change, not a wall: KNOWN_ISSUES)
const NO_HOST_NAMES = ['--add-host', 'host.docker.internal:127.0.0.255', '--add-host', 'gateway.docker.internal:127.0.0.255'];
const helperMounts = (vols) => [...volumeMount(vols.state, V.state), ...volumeMount(vols.login, V.login), ...(vols.out ? volumeMount(vols.out, V.out) : [])];
const helperPaths = (vols) => [V.state, V.login, ...(vols.out ? [V.out] : [])];

// The helper (V2): root with only CHOWN and FOWNER, no network, no shell, nothing recursive; chown, then chmod 700. Then
// the same paths read back as the image's user with no capability at all. defaultSeccomp: Docker's own profile for the
// helper only, when the pinned one refuses chown (said where it is used)
export function helperArgs(op, vols, { seccomp, defaultSeccomp = false }) {
  const security = ['--user', '0:0', '--cap-drop', 'ALL', '--cap-add', 'CHOWN', '--cap-add', 'FOWNER', '--security-opt', 'no-new-privileges:true', ...(defaultSeccomp ? [] : ['--security-opt', `seccomp=${seccomp}`])];
  const tail = op === 'chown' ? [SCAN_USER, ...helperPaths(vols)] : ['700', ...helperPaths(vols)];
  return ['run', '--rm', '--network', 'none', ...security, '--pids-limit', '16', '--entrypoint', op, ...helperMounts(vols), imageRef(), ...tail];
}
export function statArgs(vols, { seccomp }) {
  return ['run', '--rm', '--network', 'none', ...hardened(seccomp), '--pids-limit', '16', '--entrypoint', 'stat', ...helperMounts(vols), imageRef(), '-c', '%u:%g %a', ...helperPaths(vols)];
}
// What the stat lines must say: one per volume, each the image's user with 700 (V6 stop rule 1)
export function statProblem(out, vols) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const want = helperPaths(vols).length;
  if (lines.length !== want) return `the volumes' owners couldn't be read (${lines.length} of ${want} answers)`;
  const bad = lines.findIndex((l) => l !== `${SCAN_USER} 700`);
  return bad < 0 ? '' : `a volume isn't the scanner's alone (${helperPaths(vols)[bad]}: ${lines[bad].slice(0, 40)}, expected ${SCAN_USER} 700)`;
}

// The scan's arguments after the image (the exact spelling Step 0b ran, with web search off: delta 2 V4)
export function scanCommand({ model, effort, deep = false, daybreak = false, maxMinutes, policy = false, role = false, dryRun = false }) {
  return [
    'scan', REPO_AT,
    '--output-dir', OUT_AT,
    '--headless', // (the scanner's own flag, inside its Linux container: no Windows console host, FR-013)
    '--auth', 'chatgpt',
    '--mode', deep ? 'deep' : 'standard',
    ...(model ? ['--model', model] : []),
    ...(effort ? ['--effort', effort] : []),
    ...(daybreak ? ['--cyber-access-program', 'daybreak_blue', '--codex', 'daybreak=true'] : []),
    '--codex', 'approval_policy="never"',
    '--codex', 'web_search="disabled"',
    ...(policy ? ['--knowledge-base', `${KB_AT}/${POLICY_FILE}`] : []),
    ...(role ? ['--scan-prompt-file', `${KB_AT}/${ROLE_FILE}`] : []),
    '--max-time', String(maxMinutes),
    ...(dryRun ? ['--dry-run'] : []),
  ];
}

// `docker run` for the scan itself: its name (so Stop and the time limit stop it), the checkout and the policy read-only,
// the three volumes, limits, and nothing else. kb: the hub's folder with the role doc (role.md) and, once the owner
// approved one, the policy (policy.md); policy: whether it holds one.
export function scanRunArgs({ id, checkout, kb = '', policy = false, vols, seccomp, memory, ...command }) {
  return [
    'run', '--rm', '--init', '--name', containerName(id),
    ...hardened(seccomp),
    '--pids-limit', '2048', '--memory', memory,
    ...NO_HOST_NAMES,
    ...bindMount(checkout, REPO_AT),
    ...(kb ? bindMount(kb, KB_AT) : []),
    ...volumeMount(vols.out, OUT_AT),
    ...volumeMount(vols.state, STATE_AT),
    ...volumeMount(vols.login, LOGIN_AT),
    imageRef(),
    ...scanCommand({ ...command, policy: !!kb && policy, role: !!kb }),
  ];
}
export const containerName = (id) => `nextlevel-scan-${id}`;
export const copyName = (id) => `nextlevel-scan-out-${id}`;

// The copy-out's container (V3): created, never started, no network, the output volume read-only
export function copyCreateArgs(id, vols, { seccomp }) {
  return ['create', '--name', copyName(id), '--network', 'none', ...hardened(seccomp), ...volumeMount(vols.out, OUT_AT, true), imageRef()];
}
// One file out of it (rel: a plain relative name the copy-out checked)
export const copyFileArgs = (id, rel, dest) => ['cp', `${copyName(id)}:${OUT_AT}/${rel}`, dest];

// The memory a scan may use: half the PC's, at most 8 GB, at least 2
export function memoryLimit(totalBytes) {
  const gb = Math.max(2, Math.min(8, Math.floor(totalBytes / 2 / 1024 ** 3)));
  return `${gb}g`;
}

// The probes, no model in any (D5 and V5): Codex's sandbox can start in the container (upstream's own check), and inside
// it, under the scan's profile, the sign-in can't be read or listed and the network is closed. Against a throwaway login
// volume (probeLoginVolume) that holds a planted harmless auth.json, never the real sign-in.
export function nestedArgs({ seccomp }) {
  return ['run', '--rm', '--network', 'none', ...hardened(seccomp), '--entrypoint', 'node', imageRef(), CODEX_JS, 'sandbox', '/usr/bin/true'];
}
export function plantArgs(probeVolume, { seccomp }) {
  return ['run', '--rm', '--network', 'none', ...hardened(seccomp), '--entrypoint', 'sh', ...volumeMount(probeVolume, LOGIN_AT), imageRef(), '-c', `printf '%s\\n' '{"planted":"nextlevel-probe"}' > ${LOGIN_AT}/auth.json`];
}
export function probeArgs(probeVolume, { seccomp, stateVolume }) {
  return [
    'run', '--rm', ...hardened(seccomp), ...NO_HOST_NAMES,
    ...volumeMount(stateVolume, STATE_AT), ...volumeMount(probeVolume, LOGIN_AT),
    '--entrypoint', 'node', imageRef(), CODEX_JS, 'sandbox', ...PROBE_CONFIG, 'sh', '-c', PROBE_SCRIPT,
  ];
}
// The probe's verdict from its output: '' when the five answers are exactly the ones the scan needs
export function probeProblem(out) {
  const words = String(out || '').split(/\s+/).filter((w) => /^(login|authfile|net|ip)-/.test(w));
  if (words.join(' ') === PROBE_EXPECTED.join(' ')) return '';
  return `Codex's sandbox in the scanner answered ${words.length ? words.join(', ') : 'nothing'} (expected ${PROBE_EXPECTED.join(', ')})`;
}

// The sign-in (security.login's fix, in the owner's own window): only the state and login volumes, OpenAI's device page
export function loginArgs(vols, { seccomp, status = false }) {
  return ['run', '--rm', ...(status ? [] : ['-it']), ...hardened(seccomp), ...NO_HOST_NAMES, ...volumeMount(vols.state, STATE_AT), ...volumeMount(vols.login, LOGIN_AT), imageRef(), 'login', ...(status ? ['status'] : ['--device-auth'])];
}
// Which files the sign-in volume holds, by name only (never read)
export function loginFilesArgs(vols, { seccomp }) {
  return ['run', '--rm', '--network', 'none', ...hardened(seccomp), '--entrypoint', 'ls', ...volumeMount(vols.login, LOGIN_AT, true), imageRef(), '-A', LOGIN_AT];
}

// The Daybreak check (security.daybreak): the container's Codex lists its models with the access programs each takes
export function modelsArgs(vols, { seccomp }) {
  return ['run', '--rm', ...hardened(seccomp), ...NO_HOST_NAMES, ...volumeMount(vols.state, STATE_AT), ...volumeMount(vols.login, LOGIN_AT), '-e', `CODEX_HOME=${LOGIN_AT}`, '--entrypoint', 'node', imageRef(), CODEX_JS, 'debug', 'models'];
}
