// Signed requests (FR-017 part 2B, 2B-1b; docs/design/FR-017-part2B.md 3.2). What the commands, the dashboard and the hub
// write for the hub to act on carries an HMAC made with a key per project kept outside the project
// (~/.nextlevel/keys/<project key>.key). A worker that writes a request file by hand (a job into queue/, a message into
// outbox/, wakeup.json, round-now.json) has no key in its own files, so the hub sets its file aside, unacted on. In layer 1
// a worker that reads the key from the owner's profile can still sign: that is out of scope there (section 7), and the
// agents' account closes it (layer 2).
//
// The signature is a field `sig: { v: 1, by, at, mac }` (and `seq` for a store, from 2B-1b2 on). `mac` is HMAC-SHA256,
// with a key derived per purpose from the project's key (HKDF: `requests`, `state`, `guard`), over v, by, at, seq, the
// file's name with its root (`state:queue/x.json`) and the object without `sig` in a canonical form (keys sorted at every
// depth). `by` is for logs and Home only: the key is the proof. Pure but the key's file and its marker.
import { createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { guardDir, projectKey } from './guard.mjs';

export const SIG_V = 1;
export const KEY_BYTES = 32;
const BY = new Set(['owner', 'orchestrator', 'dashboard', 'hub']);
const PURPOSES = new Set(['requests', 'state', 'guard']);

export const keysDir = (home) => path.join(home, '.nextlevel', 'keys');
export const keyFile = (root, home) => path.join(keysDir(home), `${projectKey(root)}.key`);
// The marker beside the guard's records: the key's hash since it was made. Once it is there a missing or changed key is
// never made again by itself (a worker that deleted the key must not get a fresh one its own files then match)
export const markerFile = (root, home) => path.join(guardDir(root, home), 'signing.json');
const keyHash = (key) => createHash('sha256').update(key).digest('hex').slice(0, 16);
// The hub's record of the requests it acted on (signed with the key's `guard` purpose), started empty with each new key:
// once a key is there, the record missing means it was deleted, which the hub doesn't take as "nothing acted on yet"
export const actedFile = (root, home) => path.join(guardDir(root, home), 'acted.json');
const emptyActed = (key, at) => `${JSON.stringify(sign({ ids: {} }, { key, purpose: 'guard', name: 'guard:acted.json', by: 'hub', at }), null, 2)}\n`;
function startActed(root, home, key, at) {
  try {
    writeOnce(actedFile(root, home), emptyActed(key, at));
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

function readKey(file) {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, 'hex') : 'bad';
  } catch (err) {
    return err.code === 'ENOENT' ? null : 'bad';
  }
}
function readMarker(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    return m && typeof m === 'object' && /^[0-9a-f]{16}$/.test(m.keyHash || '') ? m : 'bad';
  } catch (err) {
    return err.code === 'ENOENT' ? null : 'bad';
  }
}
// A file of its own, written once (`wx`: never through a link someone put there first, never over another's key)
function writeOnce(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag: 'wx', mode: 0o600 });
}

// The project's key: { key } or { problem } (words for the owner, with the fix). `create`: only the owner's processes
// pass it (the hub at its start, init, a command in the owner's or the orchestrator's session that writes a request);
// a key is made only while no marker says one was there.
export function projectSigningKey(root, { home, create = false, at = new Date().toISOString() } = {}) {
  const kf = keyFile(root, home);
  const mf = markerFile(root, home);
  let key = readKey(kf);
  const marker = readMarker(mf);
  const fix = 'In your own PowerShell window, in the project folder: nextlevel doctor --fix state.key';
  if (key === 'bad') return { problem: `nextlevel's signing key (${kf}) can't be read as a key. Requests aren't acted on until it is set right. ${fix}` };
  if (marker === 'bad') return { problem: `the record of nextlevel's signing key (${mf}) can't be read. Requests aren't acted on until it is set right. ${fix}` };
  if (!key) {
    if (marker) return { problem: `nextlevel's signing key (${kf}) is gone, though the project had one since ${String(marker.since || '').slice(0, 10)}. Requests aren't acted on: a new key isn't made by itself. ${fix}` };
    if (!create) return { missing: true };
    const made = randomBytes(KEY_BYTES);
    try {
      writeOnce(kf, `${made.toString('hex')}\n`);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return projectSigningKey(root, { home, create: false, at }); // (another process made it first)
    }
    key = made;
  }
  if (!marker) {
    try {
      writeOnce(mf, `${JSON.stringify({ since: at, keyHash: keyHash(key) }, null, 2)}\n`);
      startActed(root, home, key, at);
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      return projectSigningKey(root, { home, create: false, at });
    }
  } else if (marker.keyHash !== keyHash(key)) {
    return { problem: `nextlevel's signing key (${kf}) isn't the one the project had since ${String(marker.since || '').slice(0, 10)}. Requests aren't acted on until you say which is right. ${fix}` };
  }
  return { key };
}

// The owner's fix (`nextlevel doctor --fix state.key`, in their own window): a new key and its marker. What was signed with
// the old one is no longer good; the caller lists what that sets aside.
export function newSigningKey(root, { home, at = new Date().toISOString() } = {}) {
  const key = randomBytes(KEY_BYTES);
  // (the record of the requests acted on starts again empty: nothing signed with the old key is good any more. A running
  // hub signs its own record again with the new key when it sees the marker change)
  for (const [file, text] of [
    [keyFile(root, home), `${key.toString('hex')}\n`],
    [markerFile(root, home), `${JSON.stringify({ since: at, keyHash: keyHash(key) }, null, 2)}\n`],
    [actedFile(root, home), emptyActed(key, at)],
  ]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  return { key };
}

const purposeKey = (key, purpose) => {
  if (!PURPOSES.has(purpose)) throw new Error(`unknown signing purpose ${purpose}`);
  return Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `nextlevel ${purpose}`, 32));
};

// The object in one form whatever the order its keys were written in: keys sorted at every depth
export function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v === undefined ? null : v);
}
const withoutSig = (obj) => {
  const { sig, ...rest } = obj;
  return rest;
};
function mac(key, purpose, name, sig, body) {
  const h = createHmac('sha256', purposeKey(key, purpose));
  h.update(canonical({ v: sig.v, by: sig.by, at: sig.at, seq: sig.seq ?? null, name, body }));
  return h.digest('hex');
}

// `name`: the file's name with its root, `state:queue/<id>.json`. -> the object with its `sig`
export function sign(obj, { key, purpose = 'requests', name, by, at = new Date().toISOString(), seq } = {}) {
  if (!BY.has(by)) throw new Error(`unknown signer ${by}`);
  if (!name) throw new Error('a signed file needs its name');
  const body = withoutSig(obj);
  const sig = { v: SIG_V, by, at, ...(seq === undefined ? {} : { seq }) };
  return { ...body, sig: { ...sig, mac: mac(key, purpose, name, sig, body) } };
}

// -> { ok: true, by, at, seq } or { ok: false, why } (why in words: "no signature", "a signature that doesn't match")
export function verify(obj, { key, purpose = 'requests', name } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, why: "it isn't a JSON object" };
  const s = obj.sig;
  if (s === undefined) return { ok: false, why: 'it has no signature' };
  if (!s || typeof s !== 'object' || s.v !== SIG_V || !BY.has(s.by) || typeof s.at !== 'string' || !Number.isFinite(Date.parse(s.at)) || typeof s.mac !== 'string' || !/^[0-9a-f]{64}$/.test(s.mac) || (s.seq !== undefined && !Number.isSafeInteger(s.seq))) {
    return { ok: false, why: "its signature isn't in nextlevel's form" };
  }
  const want = Buffer.from(mac(key, purpose, name, s, withoutSig(obj)), 'hex');
  const got = Buffer.from(s.mac, 'hex');
  if (want.length !== got.length || !timingSafeEqual(want, got)) return { ok: false, why: "its signature doesn't match (it wasn't written by nextlevel, or was changed after)" };
  return { ok: true, by: s.by, at: s.at, seq: s.seq };
}

// The name a request file is signed under: its path under .nextlevel/, with forward slashes
export const stateName = (rel) => `state:${String(rel).split(path.sep).join('/')}`;
