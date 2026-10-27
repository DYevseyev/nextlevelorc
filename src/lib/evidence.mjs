// What a run keeps of each step (docs/design/tester.md §7), made safe before anything is written: one function per kind
// of thing, and every text through `safeText`. No Cookie, Set-Cookie, Authorization or proxy header ever kept (only
// the allow-listed ones); JSON keys that look secret blanked; JWT-shaped and long base64 strings blanked; the persona
// values, the .env values and the run's own session values (its cookies, bearer tokens and captures) replaced; query
// strings kept by name only; control and direction-changing characters dropped; every field cut to its length. Pure.
import { HEADER_ALLOW } from './acceptance.mjs';
import { SECRET_NAME, redactReport } from './redact.mjs';

export const BODY_KEEP = 2048;
const LONG_B64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
// (C0 and C1 controls but tab and newline, and the bidi and zero-width characters a text can hide behind)
const INVISIBLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g;

// secrets: { values, names, home, platform } as redactReport takes them; the run adds its session values to `values`
export function safeText(text, secrets, max = BODY_KEEP) {
  let s = String(text ?? '').replace(INVISIBLE, '');
  s = redactReport(s, secrets);
  s = s.replace(LONG_B64, '***');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// A path with its query's values left out: /cb?code=x&state=y -> /cb?code=…&state=…
export function pathOnly(p) {
  const s = String(p ?? '');
  const q = s.indexOf('?');
  const hash = s.indexOf('#');
  const base = s.slice(0, q >= 0 ? q : hash >= 0 ? hash : s.length);
  if (q < 0) return base;
  const query = s.slice(q + 1, hash > q ? hash : s.length);
  const names = query.split('&').filter(Boolean).map((kv) => `${kv.split('=')[0]}=…`);
  return `${base}?${names.join('&')}`;
}

export function safeHeaders(headers, secrets) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const name = k.toLowerCase();
    if (!HEADER_ALLOW.includes(name)) continue;
    const value = Array.isArray(v) ? v.join(', ') : String(v ?? '');
    out[name] = safeText(name === 'location' ? pathOnly(value) : value, secrets, 300);
  }
  return out;
}

// A JSON value with secret-looking keys blanked and every string made safe
export function safeJson(value, secrets, depth = 0) {
  if (depth > 20) return '…';
  if (typeof value === 'string') return safeText(value, secrets, 500);
  if (Array.isArray(value)) return value.slice(0, 50).map((x) => safeJson(x, secrets, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(value).slice(0, 100)) out[safeText(k, secrets, 100)] = SECRET_NAME.test(k) || /^(session|sid|csrf|xsrf|jwt|otp|code)$/i.test(k) ? '***' : safeJson(x, secrets, depth + 1);
    return out;
  }
  return value;
}

// A response's body as evidence: JSON made safe and shown, else the first 2 KB of its text
export function safeBody(text, isJson, json, secrets) {
  if (isJson) {
    const shown = JSON.stringify(safeJson(json, secrets), null, 1);
    return shown.length > BODY_KEEP ? `${shown.slice(0, BODY_KEEP - 1)}…` : shown;
  }
  return safeText(text, secrets);
}

// The last pass over a whole record before it is written: no kept value anywhere in it
export function safeRecord(record, secrets) {
  const text = JSON.stringify(record);
  let out = text;
  for (const v of [...(secrets.values || [])].filter((x) => x && x.length >= 4).sort((a, b) => b.length - a.length)) {
    const enc = JSON.stringify(v).slice(1, -1);
    out = out.split(enc).join('***');
  }
  return out === text ? record : JSON.parse(out);
}
