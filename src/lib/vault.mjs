// The personas' sign-ins (docs/design/tester.md §5): typed once by the owner (nextlevel tester persona set), kept
// outside the project in ~/.nextlevel/vault/<project key>.json, each value sealed with AES-256-GCM under a key of the
// project's own that only the PC's secret store gives back: DPAPI for the current Windows user (through Windows
// PowerShell, the key on its stdin), the login keychain on macOS (`security`, its commands on stdin), the Secret
// Service on Linux (`secret-tool`, the key on its stdin). Never on a command line, in an environment or in the project.
// Each value is bound to its environment's name and origin and the persona (the AES's additional data), so an approved
// change of an environment's URL leaves its personas unset until the owner types them again.
// The passwords and tokens are secrets: every process that redacts what may leave it asks redactionValues(root) once
// (unsealed lazily, kept for the process's life). The usernames aren't redacted, and never leave the PC either.
// Under the tests' stubs only, NEXTLEVEL_TEST_VAULT names a folder that stands in for the secret store.
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectKey } from './guard.mjs';
import { resolveBin, testStubs } from './proc.mjs';
import { PERSONA_FIELDS, SECRET_FIELDS } from './testerconfig.mjs';

export const SERVICE = 'nextlevel-tester';
export const MIN_SECRET = 8; // a password or token shorter than this is refused (too common a string to redact everywhere)
const VERSION = 1;
const cache = new Map(); // project key -> the unsealed key, for this process's life
const redactCache = new Map(); // project key -> { stamp, result: { values, named, problem } }

export const vaultFile = (root, home = os.homedir()) => path.join(home, '.nextlevel', 'vault', `${projectKey(root)}.json`);
export const entryId = (env, origin, persona) => `${env}@${origin}/${persona}`;

// Which secret store this PC has: { kind, problem }
export function storeKind({ platform = process.platform, env = process.env, has = (cmd) => !!resolveBinQuiet(cmd) } = {}) {
  if (testStubs(env) !== null && env.NEXTLEVEL_TEST_VAULT) return { kind: 'test', problem: '' };
  if (platform === 'win32') return has('powershell') ? { kind: 'dpapi', problem: '' } : { kind: '', problem: "Windows PowerShell (powershell.exe) isn't reachable, and it seals the sign-ins with Windows' own protection (DPAPI)" };
  if (platform === 'darwin') return has('security') ? { kind: 'keychain', problem: '' } : { kind: '', problem: "macOS's security tool isn't reachable (the login keychain keeps the sign-ins' key)" };
  return has('secret-tool') ? { kind: 'secret-service', problem: '' } : { kind: '', problem: 'no Secret Service here: install libsecret-tools (sudo apt install libsecret-tools) and a keyring such as GNOME Keyring' };
}
function resolveBinQuiet(cmd) {
  try {
    return resolveBin(cmd);
  } catch {
    return null; // (the tests' trip-wire: a store outside the stubs isn't there)
  }
}

function readFile(root) {
  try {
    return vaultFromText(fs.readFileSync(vaultFile(root), 'utf8'));
  } catch {
    return null; // none yet
  }
}
// The file's content as a vault, or null (the doctor reads it through its context: src/checks/tester.mjs)
export function vaultFromText(text) {
  try {
    const v = JSON.parse(text);
    if (v && v.version === VERSION && v.entries && typeof v.entries === 'object' && !Array.isArray(v.entries)) return v;
  } catch {
    // not one
  }
  return null;
}
function writeFile(root, v) {
  const file = vaultFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(v, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- the project's key, through the store ----------
// (Windows PowerShell from Windows' own folder, never one a PATH entry puts first: the key goes through it)
const systemPowerShell = () => (process.platform === 'win32' && process.env.SYSTEMROOT && testStubs() === null ? { file: path.join(process.env.SYSTEMROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') } : null);
const run = (cmd, args, input) => {
  const bin = (cmd === 'powershell' && systemPowerShell()) || resolveBinQuiet(cmd);
  if (!bin) return { ok: false, out: '', err: `${cmd} isn't reachable` };
  const r = spawnSync(bin.file, args, { input, encoding: 'utf8', windowsHide: true, timeout: 60_000, env: storeEnv() });
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: ((r.stderr || '').trim() || r.error?.message || `exit ${r.status}`).split(/\r?\n/)[0].slice(0, 200) };
};
// The store's programs get nothing of the project's .env (only what they need to find the user's store)
const storeEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|COMPUTERNAME|USERNAME|USERDOMAIN|HOME|USER|LOGNAME|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|DISPLAY|WAYLAND_DISPLAY|PSModulePath)$/i.test(k)));
const PS = (body) => ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $d=[Convert]::FromBase64String([Console]::In.ReadToEnd().Trim()); ${body}`];
const DPAPI_SEAL = PS("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($d,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))");
const DPAPI_OPEN = PS("[Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect($d,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))");
const testKeyFile = (pk) => path.join(process.env.NEXTLEVEL_TEST_VAULT, `${pk}.key`);

// The key for a project: { key } or { problem }. create: make one when there is none.
function projectSecret(root, file, { create = false } = {}) {
  const pk = projectKey(root);
  if (cache.has(pk)) return { key: cache.get(pk) };
  const kind = storeKind().kind;
  if (!kind) return { problem: storeKind().problem };
  const take = (b64) => {
    const key = Buffer.from(String(b64 || '').trim(), 'base64');
    if (key.length !== 32) return { problem: "the secret store gave back a key that isn't one: set the personas again (nextlevel tester persona set)" };
    cache.set(pk, key);
    return { key };
  };
  // (a store that changed kind since: the file says which sealed it)
  const sealedBy = file?.store || '';
  if (sealedBy && sealedBy !== kind) return { problem: `the sign-ins were kept with ${sealedBy}, and this PC now has ${kind}: set the personas again` };
  if (kind === 'test') {
    try {
      return take(fs.readFileSync(testKeyFile(pk), 'utf8'));
    } catch {
      if (!create) return { problem: 'no key in the stand-in store' };
      const b64 = randomBytes(32).toString('base64');
      fs.mkdirSync(process.env.NEXTLEVEL_TEST_VAULT, { recursive: true });
      fs.writeFileSync(testKeyFile(pk), b64);
      return take(b64);
    }
  }
  if (kind === 'dpapi') {
    if (file?.sealedKey) {
      const r = run('powershell', DPAPI_OPEN, file.sealedKey);
      return r.ok ? take(r.out) : { problem: `Windows couldn't unseal the sign-ins' key (${r.err}): set the personas again if your Windows account changed` };
    }
    if (!create) return { problem: 'no sign-ins kept yet' };
    const b64 = randomBytes(32).toString('base64');
    const r = run('powershell', DPAPI_SEAL, b64);
    if (!r.ok || !r.out) return { problem: `Windows couldn't seal the sign-ins' key (${r.err})` };
    const t = take(b64);
    if (t.key) t.sealedKey = r.out;
    return t;
  }
  if (kind === 'keychain') {
    const r = run('security', ['find-generic-password', '-s', SERVICE, '-a', pk, '-w']);
    if (r.ok && r.out) return take(r.out);
    if (!create) return { problem: `the login keychain has no key for these sign-ins (${r.err})` };
    const b64 = randomBytes(32).toString('base64');
    const w = run('security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${pk} -w ${b64}\n`);
    return w.ok ? take(b64) : { problem: `the login keychain refused the key (${w.err})` };
  }
  const r = run('secret-tool', ['lookup', 'service', SERVICE, 'project', pk]);
  if (r.ok && r.out) return take(r.out);
  if (!create) return { problem: `the Secret Service has no key for these sign-ins (${r.err})` };
  const b64 = randomBytes(32).toString('base64');
  const w = run('secret-tool', ['store', '--label', `nextlevel tester ${pk}`, 'service', SERVICE, 'project', pk], b64);
  return w.ok ? take(b64) : { problem: `the Secret Service refused the key (${w.err})` };
}

const seal = (key, aad, text) => {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const data = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return { iv: iv.toString('base64'), tag: c.getAuthTag().toString('base64'), data: data.toString('base64') };
};
const open = (key, aad, box) => {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(box.tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(box.data, 'base64')), d.final()]).toString('utf8');
};

// ---------- what the commands use ----------
// What is kept, without opening anything: [{ env, origin, persona, fields, setAt }]
export function listPersonas(root) {
  return personasOf(readFile(root));
}
export function personasOf(v) {
  if (!v) return [];
  return Object.entries(v.entries).map(([id, e]) => {
    const m = /^([a-z0-9-]+)@(.+)\/([a-z0-9-]+)$/.exec(id);
    return m ? { env: m[1], origin: m[2], persona: m[3], fields: Object.keys(e?.fields || {}).filter((f) => PERSONA_FIELDS.includes(f)), setAt: String(e?.setAt || '') } : null;
  }).filter(Boolean);
}

// The problem with a value the owner typed, or ''
export function valueProblem(field, value) {
  const v = String(value ?? '');
  if (/[\r\n\0]/.test(v)) return 'a value on one line';
  if (field === 'username') return v.length > 320 ? 'a username of up to 320 characters' : '';
  if (v && v.length < MIN_SECRET) return `a ${field} of at least ${MIN_SECRET} characters (a shorter one is too common a string to keep out of every log)`;
  if (v.length > 4096) return `a ${field} of up to 4096 characters`;
  return '';
}

// Keep a persona's values (the owner's command): -> '' or the problem
export function setPersona(root, { env, origin, persona, values }) {
  for (const [f, v] of Object.entries(values)) {
    if (!PERSONA_FIELDS.includes(f)) return `"${f}" isn't a persona's value (${PERSONA_FIELDS.join(', ')})`;
    const bad = valueProblem(f, v);
    if (bad) return bad;
  }
  const file = readFile(root) || { version: VERSION, store: '', entries: {} };
  const k = projectSecret(root, file, { create: true });
  if (k.problem) return k.problem;
  if (!file.store) file.store = storeKind().kind;
  if (k.sealedKey) file.sealedKey = k.sealedKey;
  const id = entryId(env, origin, persona);
  const fields = {};
  for (const [f, v] of Object.entries(values)) if (v) fields[f] = seal(k.key, `${id}#${f}`, v);
  file.entries[id] = { setAt: new Date().toISOString(), fields };
  writeFile(root, file);
  redactCache.delete(projectKey(root));
  return '';
}

export function forgetPersona(root, { env, origin, persona }) {
  const file = readFile(root);
  const ids = file ? Object.keys(file.entries).filter((id) => id.startsWith(`${env}@`) && id.endsWith(`/${persona}`) && (!origin || id === entryId(env, origin, persona))) : [];
  if (!ids.length) return false;
  for (const id of ids) delete file.entries[id];
  writeFile(root, file);
  redactCache.delete(projectKey(root));
  return true;
}

// A persona's values for a run: { values: { username, password, token } } or { problem }
export function readPersona(root, { env, origin, persona }) {
  const file = readFile(root);
  const e = file?.entries?.[entryId(env, origin, persona)];
  if (!e) return { problem: `${persona} on ${env} isn't set: the owner runs nextlevel tester persona set ${env} ${persona} in PowerShell, in the project` };
  const k = projectSecret(root, file);
  if (k.problem) return { problem: k.problem };
  const values = {};
  try {
    for (const [f, box] of Object.entries(e.fields || {})) if (PERSONA_FIELDS.includes(f)) values[f] = open(k.key, `${entryId(env, origin, persona)}#${f}`, box);
  } catch {
    return { problem: `${persona}'s values on ${env} don't open with this PC's key: set them again` };
  }
  return { values };
}

// Every password and token kept for the project, for redaction: { values, named: [{ name, value, from }], problem }
// (named: for the guard's commit and push scans, lib/secrets.mjs). Nothing is opened (and no store program starts) when
// the project keeps no sign-in. Once per process.
export function redactionValues(root) {
  if (!root) return { values: [], problem: '' };
  const pk = projectKey(root);
  // (kept while the file is the same: the owner may set a persona while the hub runs)
  let stamp = '';
  try {
    const st = fs.statSync(vaultFile(root));
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    stamp = 'none';
  }
  if (redactCache.get(pk)?.stamp === stamp) return redactCache.get(pk).result;
  const file = readFile(root);
  const entries = file ? Object.entries(file.entries) : [];
  let result = { values: [], named: [], problem: '' };
  if (entries.some(([, e]) => SECRET_FIELDS.some((f) => e?.fields?.[f]))) {
    const k = projectSecret(root, file);
    if (k.problem) result = { values: [], named: [], problem: k.problem };
    else {
      const values = [];
      for (const [id, e] of entries) {
        const m = /^([a-z0-9-]+)@.+\/([a-z0-9-]+)$/.exec(id);
        for (const f of SECRET_FIELDS) {
          if (!e?.fields?.[f]) continue;
          try {
            const value = open(k.key, `${id}#${f}`, e.fields[f]);
            values.push(value);
            result.named.push({ name: `${m ? `${m[2]} on ${m[1]}` : 'a persona'} (${f})`, value, from: "the tester's sign-ins" });
          } catch {
            result.problem = 'a kept sign-in no longer opens';
          }
        }
      }
      result.values = [...new Set(values)].sort((a, b) => b.length - a.length);
      result.named.sort((a, b) => b.value.length - a.value.length);
    }
  }
  redactCache.set(pk, { stamp, result });
  return result;
}
// Whether the project keeps any password or token (a store that can't be read must then hold back, never send)
export function keepsSecrets(root) {
  const file = root ? readFile(root) : null;
  return !!file && Object.values(file.entries).some((e) => SECRET_FIELDS.some((f) => e?.fields?.[f]));
}
// (tests: a process that starts over)
export function forgetCache() {
  cache.clear();
  redactCache.clear();
}
