// Acceptance plans (docs/design/tester.md §3, docs/acceptance.md): what a plan is, read from the strict YAML subset
// (lib/yamlsub.mjs) or JSON, shape-checked field by field, and how a step's expectations are judged against what came
// back. A plan is data an agent wrote: it names no secret, no host and no full URL, only paths on the environment the
// owner named, and personas by name; the runner (src/tester.mjs) holds every bar. Pure.
import { createHash } from 'node:crypto';
import { parseYamlSubset } from './yamlsub.mjs';

export const PLAN_DIR = 'docs/acceptance';
export const MAX_PLAN_BYTES = 64 * 1024;
export const MAX_STEPS = 200;
export const MAX_WITHIN_S = 120;
export const SAFE_METHODS = ['GET', 'HEAD', 'OPTIONS'];
export const METHODS = [...SAFE_METHODS, 'POST', 'PUT', 'PATCH', 'DELETE'];
const BROWSER_ACTIONS = ['open', 'click', 'fill', 'press', 'wait'];
export const ACTIONS = ['request', ...BROWSER_ACTIONS];
// Response headers a step may expect and evidence may keep: never a cookie, a sign-in or a proxy's
export const HEADER_ALLOW = ['content-type', 'content-length', 'content-language', 'content-disposition', 'location', 'cache-control', 'etag', 'last-modified', 'vary', 'allow', 'www-authenticate', 'x-frame-options', 'x-content-type-options', 'content-security-policy', 'strict-transport-security', 'referrer-policy', 'access-control-allow-origin', 'retry-after'];
export const DEFAULT_DENIED = [401, 403, 404];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,59}$/;
const RUN_PLACEHOLDERS = new Set(['run.id', 'run.stamp']);

// A plain (unquoted) YAML scalar, until the plan's shape says what it is
class Plain {
  constructor(text) {
    this.text = text;
  }
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Plain);

// (line ends as LF and the end's blank lines left out: git's output, read whole or trimmed, gives one hash)
export const planHash = (text) => createHash('sha256').update(String(text ?? '').replace(/\r\n/g, '\n').replace(/\s+$/, '')).digest('hex');

// Where a plan may be: a file under docs/acceptance/, .yaml, .yml or .json, named plainly. -> '' or what is wrong
export function planPathProblem(rel) {
  const p = String(rel ?? '').replace(/\\/g, '/');
  if (!p.startsWith(`${PLAN_DIR}/`)) return `a plan is a file under ${PLAN_DIR}/ (like ${PLAN_DIR}/notes-sharing.yaml)`;
  if (!/^[A-Za-z0-9/_.-]+$/.test(p) || p.split('/').some((x) => !x || x === '.' || x === '..' || x.startsWith('.'))) return `"${p}" isn't a plain path inside ${PLAN_DIR}/`;
  if (!/\.(ya?ml|json)$/i.test(p)) return 'a plan ends in .yaml, .yml or .json';
  return '';
}

// A plan's text -> { plan, problems: [{ line, message }] }. plan: { name, env: [names] | null, steps: [step] } where a
// step is { n, line, label, as, action, mutates, within, expect, mask }. A plan with a problem never runs.
export function readPlan(text, { file = '' } = {}) {
  const problems = [];
  const add = (line, message) => problems.push({ line: line || 0, message });
  const t = String(text ?? '');
  if (Buffer.byteLength(t) > MAX_PLAN_BYTES) return { plan: null, problems: [{ line: 0, message: `the plan is over ${MAX_PLAN_BYTES / 1024} KB` }] };
  let raw;
  let lineOf = () => 0;
  if (/\.json$/i.test(file) || /^\s*\{/.test(t.replace(/^\uFEFF/, ''))) {
    try {
      raw = JSON.parse(t.replace(/^\uFEFF/, ''));
    } catch (err) {
      return { plan: null, problems: [{ line: 0, message: `not valid JSON: ${err.message}` }] };
    }
  } else {
    const r = parseYamlSubset(t, { plain: (s) => new Plain(s) });
    if (r.problem) return { plan: null, problems: [{ line: r.line, message: r.problem }] };
    raw = r.value;
    lineOf = r.lineOf;
  }
  if (!isObj(raw)) return { plan: null, problems: [{ line: 1, message: 'a plan is a mapping: plan, env, steps' }] };
  unknownKeys(raw, ['plan', 'env', 'steps'], 'the plan', lineOf(raw), add);
  const name = str(raw.plan);
  if (!name || !NAME_RE.test(name)) add(lineOf(raw), '"plan": a name of lowercase letters, digits and "-" (like notes-sharing)');
  let env = null;
  if (raw.env !== undefined && raw.env !== null) {
    const list = Array.isArray(raw.env) ? raw.env : [raw.env];
    env = list.map(str);
    if (!env.length || env.some((e) => !e || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(e))) add(lineOf(raw), '"env": environment names as nextlevel.json names them (like staging), or a list of them');
  }
  const steps = [];
  if (!Array.isArray(raw.steps) || !raw.steps.length) add(lineOf(raw), '"steps": a list of at least one step');
  else if (raw.steps.length > MAX_STEPS) add(lineOf(raw.steps), `more than ${MAX_STEPS} steps`);
  else raw.steps.forEach((s, i) => steps.push(readStep(s, i + 1, lineOf(s) || lineOf(raw.steps), add)));
  // (every text the plan holds: no placeholder but the run's own)
  scanPlaceholders(raw, lineOf, add);
  return { plan: problems.length ? null : { name, env, steps }, problems };
}

function readStep(s, n, line, add) {
  const at = `step ${n}`;
  const step = { n, line, label: '', as: '', action: null, mutates: false, within: 0, expect: {}, mask: [] };
  if (!isObj(s)) {
    add(line, `${at}: a step is a mapping (as, do, expect)`);
    return step;
  }
  unknownKeys(s, ['name', 'as', 'do', 'expect', 'mutates', 'mask'], at, line, add);
  if (s.name !== undefined) step.label = str(s.name).slice(0, 120);
  if (s.as !== undefined && s.as !== null) {
    step.as = str(s.as);
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(step.as)) add(line, `${at}: "as" names a persona as nextlevel.json names it (like member)`);
  }
  const m = bool(s.mutates);
  if (s.mutates !== undefined && m === null) add(line, `${at}: "mutates" is true or false`);
  step.mutates = m === true;
  if (s.mask !== undefined) {
    const list = Array.isArray(s.mask) ? s.mask : [s.mask];
    step.mask = list.map(str).filter(Boolean);
    if (step.mask.length !== list.length || step.mask.some((x) => x.length > 300)) add(line, `${at}: "mask" is a selector or a list of them`);
  }
  step.action = readAction(s.do, at, line, add);
  if (step.action?.method && !SAFE_METHODS.includes(step.action.method) && !step.mutates) add(line, `${at}: ${step.action.method} changes data: mark the step "mutates: true" (it then runs only where nextlevel.json allows mutations)`);
  readExpect(s.expect, step, at, line, add);
  return step;
}

function readAction(d, at, line, add) {
  if (!isObj(d)) {
    add(line, `${at}: "do" is a mapping with one action (${ACTIONS.join(', ')})`);
    return null;
  }
  const kinds = Object.keys(d).filter((k) => ACTIONS.includes(k));
  if (kinds.length !== 1) {
    add(line, `${at}: "do" has exactly one action (${ACTIONS.join(', ')})`);
    return null;
  }
  const kind = kinds[0];
  unknownKeys(d, kind === 'request' ? ['request', 'json', 'form', 'headers'] : [kind], `${at}'s "do"`, line, add);
  if (kind === 'request') {
    const words = str(d.request).trim().split(/\s+/);
    const method = (words[0] || '').toUpperCase();
    const p = words[1] || '';
    if (words.length !== 2 || !METHODS.includes(method)) add(line, `${at}: "request" is a method and a path, like "GET /api/notes/42" (${METHODS.join(', ')})`);
    const bad = pathProblem(p);
    if (bad) add(line, `${at}: ${bad}`);
    const a = { kind, method, path: p, json: undefined, form: undefined, headers: {} };
    if (d.json !== undefined && d.form !== undefined) add(line, `${at}: "json" or "form", not both`);
    if (d.json !== undefined) {
      const v = jsonValue(d.json);
      if (v.problem) add(line, `${at}: "json": ${v.problem}`);
      a.json = v.value;
    }
    if (d.form !== undefined) {
      if (!isObj(d.form)) add(line, `${at}: "form" is a mapping of field: value`);
      else a.form = Object.fromEntries(Object.entries(d.form).map(([k, v]) => [k, str(v)]));
    }
    if (d.headers !== undefined) {
      if (!isObj(d.headers)) add(line, `${at}: "headers" is a mapping of name: value`);
      else {
        for (const [k, v] of Object.entries(d.headers)) {
          const name = k.toLowerCase();
          if (!/^[a-z0-9-]{1,64}$/.test(name) || ['cookie', 'authorization', 'proxy-authorization', 'host', 'origin', 'referer', 'content-length', 'transfer-encoding', 'connection', 'x-http-method-override', 'x-http-method', 'x-method-override'].includes(name)) add(line, `${at}: the header "${k}" can't be set by a plan (the sign-in recipe in nextlevel.json gives the sign-in)`);
          else a.headers[name] = str(v);
        }
      }
    }
    return a;
  }
  if (kind === 'open' || kind === 'wait' || kind === 'click' || kind === 'press') {
    const v = str(d[kind]);
    if (kind === 'open') {
      const bad = pathProblem(v);
      if (bad) add(line, `${at}: ${bad}`);
      return { kind, path: v };
    }
    if (!v || v.length > 300) add(line, `${at}: "${kind}" is ${kind === 'press' ? 'a key, like Enter' : 'a selector, like "#save"'}`);
    return { kind, [kind === 'press' ? 'key' : 'selector']: v };
  }
  // fill: [selector, value]
  const f = Array.isArray(d.fill) ? d.fill.map(str) : [];
  if (f.length !== 2 || !f[0]) add(line, `${at}: "fill" is [selector, value], like ["#title", "acceptance check"]`);
  return { kind, selector: f[0] || '', value: f[1] || '' };
}

const EXPECTS = ['status', 'text', 'noText', 'url', 'redirect', 'allowed', 'denied', 'json', 'header', 'within'];
function readExpect(e, step, at, line, add) {
  if (!isObj(e)) {
    add(line, `${at}: "expect" is a mapping (${EXPECTS.join(', ')})`);
    return;
  }
  unknownKeys(e, EXPECTS, `${at}'s "expect"`, line, add);
  const x = {};
  if (e.status !== undefined) {
    const list = (Array.isArray(e.status) ? e.status : [e.status]).map(int);
    if (!list.length || list.some((s) => s === null || s < 100 || s > 599)) add(line, `${at}: "status" is an HTTP status (like 403) or a list of them`);
    else x.status = list;
  }
  for (const k of ['text', 'noText']) {
    if (e[k] === undefined) continue;
    const v = str(e[k]);
    if (!v || v.length > 500) add(line, `${at}: "${k}" is a text of up to 500 characters`);
    else x[k] = v;
  }
  for (const k of ['url', 'redirect']) {
    if (e[k] === undefined) continue;
    const v = str(e[k]);
    const bad = pathProblem(v);
    if (bad) add(line, `${at}: "${k}": ${bad}`);
    else x[k] = v;
  }
  for (const k of ['allowed', 'denied']) {
    if (e[k] === undefined) continue;
    if (bool(e[k]) !== true) add(line, `${at}: "${k}" is true (say the other one for the opposite)`);
    else x[k] = true;
  }
  if (x.allowed && x.denied) add(line, `${at}: "allowed" or "denied", not both`);
  if (e.json !== undefined) {
    const j = e.json;
    if (!isObj(j)) add(line, `${at}: "json" is { path, equals | contains | exists }`);
    else {
      unknownKeys(j, ['path', 'equals', 'contains', 'exists'], `${at}'s "json"`, line, add);
      const p = parseJsonPath(str(j.path));
      if (p.problem) add(line, `${at}: "json.path": ${p.problem}`);
      const tests = ['equals', 'contains', 'exists'].filter((k) => j[k] !== undefined);
      if (tests.length !== 1) add(line, `${at}: "json" has one of equals, contains or exists`);
      const want = tests[0] === 'exists' ? bool(j.exists) : tests[0] ? jsonValue(j[tests[0]]) : null;
      if (tests[0] === 'exists' && want === null) add(line, `${at}: "json.exists" is true or false`);
      if (tests[0] && tests[0] !== 'exists' && want?.problem) add(line, `${at}: "json.${tests[0]}": ${want.problem}`);
      x.json = { path: str(j.path), test: tests[0] || '', value: tests[0] === 'exists' ? want : want?.value };
    }
  }
  if (e.header !== undefined) {
    const h = e.header;
    if (!isObj(h)) add(line, `${at}: "header" is { name, equals | contains }`);
    else {
      unknownKeys(h, ['name', 'equals', 'contains'], `${at}'s "header"`, line, add);
      const name = str(h.name).toLowerCase();
      if (!HEADER_ALLOW.includes(name)) add(line, `${at}: "header.name" is one of ${HEADER_ALLOW.join(', ')} (never a cookie or a sign-in)`);
      const tests = ['equals', 'contains'].filter((k) => h[k] !== undefined);
      if (tests.length !== 1) add(line, `${at}: "header" has equals or contains`);
      x.header = { name, test: tests[0] || '', value: str(h[tests[0]]) };
    }
  }
  if (e.within !== undefined) {
    const s = duration(e.within);
    if (s === null || s < 1 || s > MAX_WITHIN_S) add(line, `${at}: "within" is a time up to ${MAX_WITHIN_S / 60} minutes, like 30s or 2m`);
    else step.within = s;
    if (step.mutates) add(line, `${at}: "within" tries a step again, and a step that mutates is never sent twice`);
  }
  if (!Object.keys(x).length) add(line, `${at}: "expect" needs at least one expectation (${EXPECTS.filter((k) => k !== 'within').join(', ')})`);
  step.expect = x;
}

// A path on the environment: starts with "/", no scheme or host, nothing a browser reads as another place
export function pathProblem(p) {
  const s = String(p ?? '');
  if (!s.startsWith('/') || s.startsWith('//')) return `"${cut(s)}" isn't a path on the environment: it starts with one "/" (a plan never names a host or a full URL)`;
  if (s.length > 2000) return 'a path is up to 2000 characters';
  if (/[\\\s\x00-\x1f\x7f]/.test(s)) return `"${cut(s)}" has a space, a backslash or a control character: encode it (%20)`;
  return '';
}

// ---------- values ----------
const str = (v) => {
  if (v instanceof Plain) return v.text;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return '';
};
// YAML 1.2's core booleans, or JSON's -> true | false | null
const bool = (v) => {
  if (typeof v === 'boolean') return v;
  if (v instanceof Plain && /^(true|True|TRUE)$/.test(v.text)) return true;
  if (v instanceof Plain && /^(false|False|FALSE)$/.test(v.text)) return false;
  return null;
};
const int = (v) => {
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (v instanceof Plain && /^[-+]?[0-9]{1,9}$/.test(v.text)) return Number(v.text);
  return null;
};
// "30s", "2m", 45 (seconds) -> seconds, or null
const duration = (v) => {
  const n = int(v);
  if (n !== null) return n;
  const m = /^([0-9]{1,4})(s|m)$/.exec(str(v));
  return m ? Number(m[1]) * (m[2] === 'm' ? 60 : 1) : null;
};
// A JSON value from a plan: from YAML, a plain scalar takes YAML 1.2's core type (null, true/false, a number), a quoted
// one stays a string. -> { value } or { problem }
export function jsonValue(v, depth = 0) {
  if (depth > 20) return { problem: 'nested too deep' };
  if (v instanceof Plain) {
    const t = v.text;
    if (/^(null|Null|NULL|~)$/.test(t)) return { value: null };
    const b = bool(v);
    if (b !== null) return { value: b };
    if (/^[-+]?[0-9]+$/.test(t)) {
      const n = Number(t);
      return Number.isSafeInteger(n) ? { value: n } : { problem: `${t} is too big for a whole number: put it in quotes` };
    }
    if (/^0o[0-7]+$/.test(t)) return { value: parseInt(t.slice(2), 8) };
    if (/^0x[0-9a-fA-F]+$/.test(t)) return { value: parseInt(t.slice(2), 16) };
    if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(t)) return { value: Number(t) };
    if (/^[-+]?\.(inf|Inf|INF)$|^\.(nan|NaN|NAN)$/.test(t)) return { problem: `${t} has no JSON form` };
    return { value: t };
  }
  if (v === null || ['string', 'number', 'boolean'].includes(typeof v)) return { value: v };
  if (Array.isArray(v)) {
    const out = [];
    for (const x of v) {
      const r = jsonValue(x, depth + 1);
      if (r.problem) return r;
      out.push(r.value);
    }
    return { value: out };
  }
  if (isObj(v)) {
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      const r = jsonValue(x, depth + 1);
      if (r.problem) return r;
      out[k] = r.value;
    }
    return { value: out };
  }
  return { problem: 'not a JSON value' };
}

function unknownKeys(obj, known, at, line, add) {
  for (const k of Object.keys(obj)) if (!known.includes(k)) add(line, `${at}: "${k}" isn't a field here (${known.join(', ')})`);
}
// Every text in the plan: a {{...}} other than the run's own is refused (a plan never names a secret: the sign-in recipe
// in nextlevel.json alone puts a persona's values anywhere)
function scanPlaceholders(node, lineOf, add, line = 0) {
  const here = lineOf(node) || line;
  const check = (s) => {
    for (const m of String(s).matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) {
      if (!RUN_PLACEHOLDERS.has(m[1])) add(here, `"{{${m[1]}}}": a plan may use only {{run.id}} and {{run.stamp}}; a persona's values go only where the sign-in recipe in nextlevel.json puts them`);
    }
  };
  if (node instanceof Plain) return check(node.text);
  if (typeof node === 'string') return check(node);
  if (Array.isArray(node)) for (const x of node) scanPlaceholders(x, lineOf, add, here);
  else if (isObj(node)) {
    for (const [k, x] of Object.entries(node)) {
      check(k);
      scanPlaceholders(x, lineOf, add, here);
    }
  }
}
// The run's placeholders filled in, in a step's texts and JSON body
export function fillRun(value, run) {
  const sub = (s) => String(s).replace(/\{\{\s*run\.(id|stamp)\s*\}\}/g, (all, k) => (k === 'id' ? run.id : run.stamp));
  if (typeof value === 'string') return sub(value);
  if (Array.isArray(value)) return value.map((x) => fillRun(x, run));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, fillRun(x, run)]));
  return value;
}

// ---------- JSON paths: $, .name, ["name"], [n], [*] ----------
export function parseJsonPath(p) {
  const s = String(p ?? '');
  if (!s.startsWith('$')) return { problem: 'a path starts with "$" (like $.entries[*].action)' };
  if (s.length > 300) return { problem: 'a path is up to 300 characters' };
  const segs = [];
  let i = 1;
  while (i < s.length) {
    if (s[i] === '.') {
      let k = i + 1;
      while (k < s.length && /[A-Za-z0-9_-]/.test(s[k])) k++;
      if (k === i + 1) return { problem: `a name expected after "." at "${cut(s.slice(i))}"` };
      segs.push({ key: s.slice(i + 1, k) });
      i = k;
    } else if (s[i] === '[') {
      const end = s.indexOf(']', i);
      if (end < 0) return { problem: '"[" not closed' };
      const inner = s.slice(i + 1, end);
      if (inner === '*') segs.push({ all: true });
      else if (/^[0-9]{1,6}$/.test(inner)) segs.push({ index: Number(inner) });
      else if (/^"[^"\\]*"$/.test(inner) || /^'[^'\\]*'$/.test(inner)) segs.push({ key: inner.slice(1, -1) });
      else return { problem: `"[${cut(inner)}]": a number, * or a quoted name` };
      i = end + 1;
    } else return { problem: `"." or "[" expected at "${cut(s.slice(i))}"` };
    if (segs.length > 30) return { problem: 'a path of more than 30 steps' };
  }
  return { segs };
}
// The values a path reaches in a JSON value: [values]
export function jsonPathValues(data, p) {
  const r = typeof p === 'string' ? parseJsonPath(p) : p;
  if (r.problem) return [];
  let cur = [data];
  for (const seg of r.segs) {
    const next = [];
    for (const v of cur) {
      if (seg.all) {
        if (Array.isArray(v)) next.push(...v);
        else if (v && typeof v === 'object') next.push(...Object.values(v));
      } else if (seg.index !== undefined) {
        if (Array.isArray(v) && seg.index < v.length) next.push(v[seg.index]);
      } else if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, seg.key)) next.push(v[seg.key]);
    }
    cur = next;
    if (cur.length > 10_000) cur = cur.slice(0, 10_000);
  }
  return cur;
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b) || (typeof a !== 'object' && typeof b !== 'object' && String(a) === String(b));

// ---------- judging a step ----------
// What came back: { status, url (the last path), hops: [{ status, location }], headers: { name: value }, text, json,
// isJson }. denied: the environment's list (statuses, "redirect:/path"). -> [{ what, ok, expected, actual }]
export function judge(expect, res, { denied = DEFAULT_DENIED } = {}) {
  const out = [];
  const add = (what, ok, expected, actual) => out.push({ what, ok: !!ok, expected: cut(expected, 300), actual: cut(actual, 300) });
  const statusWords = () => `${res.status}${res.hops.length ? ` after ${res.hops.map((h) => `${h.status} to ${h.location}`).join(', ')}` : ''}`;
  if (expect.status) add('status', expect.status.includes(res.status), expect.status.join(' or '), statusWords());
  if (expect.text) add('text', res.text.includes(expect.text), `the text "${expect.text}"`, res.text.includes(expect.text) ? 'it is there' : `not there (${res.text.length} characters${res.text ? `, starting "${cut(res.text.replace(/\s+/g, ' ').trim(), 80)}"` : ''})`);
  if (expect.noText) add('noText', !res.text.includes(expect.noText), `no "${expect.noText}"`, res.text.includes(expect.noText) ? 'it is there' : 'not there');
  if (expect.url) add('url', res.url === expect.url, `ends at ${expect.url}`, `ends at ${res.url}`);
  if (expect.redirect) {
    const hit = res.hops.some((h) => h.location === expect.redirect || h.location.startsWith(`${expect.redirect}?`));
    add('redirect', hit, `a redirect to ${expect.redirect}`, res.hops.length ? `redirects: ${res.hops.map((h) => h.location).join(', ')}` : `no redirect (${res.status})`);
  }
  if (expect.denied || expect.allowed) {
    const why = deniedBy(res, denied);
    if (expect.denied) add('denied', !!why, `denied (${denied.join(', ')})`, why || `allowed: ${statusWords()}`);
    else add('allowed', !why && res.status >= 200 && res.status < 300, 'allowed (2xx)', why ? `denied: ${why}` : statusWords());
  }
  if (expect.json) {
    const j = expect.json;
    if (!res.isJson) add('json', false, `${j.path} ${j.test} ${JSON.stringify(j.value)}`, "the body isn't JSON");
    else {
      const vals = jsonPathValues(res.json, j.path);
      let ok = false;
      if (j.test === 'exists') ok = j.value ? vals.length > 0 : vals.length === 0;
      else if (j.test === 'equals') ok = vals.some((v) => same(v, j.value));
      else if (j.test === 'contains') ok = vals.some((v) => (typeof v === 'string' && typeof j.value === 'string' ? v.includes(j.value) : Array.isArray(v) ? v.some((x) => same(x, j.value)) : same(v, j.value)));
      add('json', ok, `${j.path} ${j.test}${j.test === 'exists' ? (j.value ? '' : ' false') : ` ${JSON.stringify(j.value)}`}`, vals.length ? `${j.path} is ${cut(vals.slice(0, 5).map((v) => JSON.stringify(v)).join(', '), 200)}${vals.length > 5 ? ` and ${vals.length - 5} more` : ''}` : `${j.path} reaches nothing`);
    }
  }
  if (expect.header) {
    const h = expect.header;
    const v = res.headers[h.name];
    const ok = v !== undefined && (h.test === 'equals' ? v === h.value : v.includes(h.value));
    add('header', ok, `${h.name} ${h.test} "${h.value}"`, v === undefined ? `no ${h.name}` : `${h.name}: ${v}`);
  }
  return out;
}
// Why a response counts as denied, or ''
export function deniedBy(res, denied = DEFAULT_DENIED) {
  for (const d of denied) {
    if (typeof d === 'number' && (res.status === d || res.hops.some((h) => h.status === d))) return `status ${d}`;
    if (typeof d === 'string' && d.startsWith('redirect:')) {
      const p = d.slice('redirect:'.length);
      if (res.hops.some((h) => h.location === p || h.location.startsWith(`${p}?`))) return `redirected to ${p}`;
    }
  }
  return '';
}

const cut = (s, n = 60) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
