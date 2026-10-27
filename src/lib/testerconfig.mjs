// The tester's settings: nextlevel.json's "tester" section (docs/design/tester.md §4). nextlevel.json is protected, so
// every change here is the owner's approval on the dashboard: the environments, the personas, where mutations may run
// and the sign-in recipe, the one place a persona's values go. The tester runs no model, so the section has no engine.
// Off when the section is missing or "enabled" isn't true. Pure.
import { parseJsonPath, pathProblem } from './acceptance.mjs';

export const TESTER_DEFAULTS = {
  enabled: false,
  environments: {},
  allowMutations: [],
  alsoAllow: [],
  personas: [],
  signIn: null,
  afterDeploy: {},
  deployWaitMinutes: 10,
  autoClose: false,
  maxRunsPerHour: 6,
  maxFixes: 2,
  runMinutes: 15,
  keepRuns: 20,
};
const ENV_DEFAULTS = { url: '', denied: [401, 403, 404], version: '', production: false, signIn: null, mask: [] };
export const SECRET_FIELDS = ['password', 'token']; // a persona's values that are secrets (the username is kept, not redacted)
export const PERSONA_FIELDS = ['username', ...SECRET_FIELDS];
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const CAPTURE_RE = /^[a-z][a-z0-9_]{0,30}$/;
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

export const testerOn = (cfg) => cfg?.tester?.enabled === true;

// An environment's URL -> its origin ("https://staging.example.com"), or '' when it isn't one the tester takes
export function originOf(url) {
  try {
    const u = new URL(String(url));
    return u.origin === 'null' ? '' : u.origin;
  } catch {
    return '';
  }
}
// A loopback host: the only place a plain http: environment may be (a stand-in app on this PC)
export const isLoopbackHost = (host) => /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(String(host));

// The section from nextlevel.json, merged over the defaults and checked: problems go into problems.errors/warnings
export function mergeTester(v, problems) {
  const err = (m) => problems.errors.push(`"tester": ${m}`);
  if (v === null) return null;
  if (!isObj(v)) {
    err('the section is an object (docs/acceptance.md has an example), or null for none');
    return null;
  }
  for (const k of ['engine', 'model', 'profile', 'effort']) if (Object.hasOwn(v, k)) err(`"${k}": the tester runs no model (it walks each plan's steps itself), so it has no ${k}`);
  const t = { ...TESTER_DEFAULTS };
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('$') || ['engine', 'model', 'profile', 'effort'].includes(k)) continue;
    if (!Object.hasOwn(TESTER_DEFAULTS, k)) {
      problems.warnings.push(`unknown setting "tester.${k}" (ignored)`);
      continue;
    }
    t[k] = x;
  }
  if (typeof t.enabled !== 'boolean') err('"enabled" is true or false');
  if (typeof t.autoClose !== 'boolean') err('"autoClose" is true or false');
  const nums = { deployWaitMinutes: [0, 120], maxRunsPerHour: [1, 60], maxFixes: [0, 10], runMinutes: [1, 120], keepRuns: [1, 500] };
  for (const [k, [lo, hi]] of Object.entries(nums)) if (!Number.isInteger(t[k]) || t[k] < lo || t[k] > hi) err(`"${k}" is a whole number from ${lo} to ${hi}`);
  // environments
  const envs = {};
  if (!isObj(t.environments)) err('"environments" is { "<name>": { "url": "https://..." } }');
  else {
    for (const [name, e] of Object.entries(t.environments)) {
      if (name.startsWith('$')) continue;
      const at = `environments.${name}`;
      if (!NAME_RE.test(name)) err(`"${at}": an environment's name has lowercase letters, digits and "-" only`);
      if (!isObj(e)) {
        err(`"${at}" is { "url": "https://..." }`);
        continue;
      }
      const env = { ...ENV_DEFAULTS };
      for (const [k, x] of Object.entries(e)) {
        if (k.startsWith('$')) continue;
        if (!Object.hasOwn(ENV_DEFAULTS, k)) problems.warnings.push(`unknown setting "tester.${at}.${k}" (ignored)`);
        else env[k] = x;
      }
      const urlProblem = envUrlProblem(env.url);
      if (urlProblem) err(`"${at}.url": ${urlProblem}`);
      if (!Array.isArray(env.denied) || !env.denied.length || !env.denied.every((d) => (Number.isInteger(d) && d >= 300 && d <= 599) || (typeof d === 'string' && /^redirect:\//.test(d) && !pathProblem(d.slice(9))))) err(`"${at}.denied" lists what "denied" means there: statuses (403) and redirects ("redirect:/sign-in")`);
      if (typeof env.version !== 'string' || (env.version && pathProblem(env.version))) err(`"${at}.version" is a path that answers the deployed commit (like /version), or ""`);
      if (typeof env.production !== 'boolean') err(`"${at}.production" is true or false`);
      if (!Array.isArray(env.mask) || !env.mask.every((m) => typeof m === 'string' && m && m.length <= 300)) err(`"${at}.mask" is a list of selectors to black out in screenshots`);
      if (env.signIn !== null) env.signIn = checkSignIn(env.signIn, `${at}.signIn`, err);
      envs[name] = env;
    }
  }
  t.environments = envs;
  const envNames = Object.keys(envs);
  const listOf = (k, check, words) => {
    if (!Array.isArray(t[k]) || !t[k].every((x) => typeof x === 'string' && check(x))) err(`"${k}" ${words}`);
  };
  listOf('allowMutations', (x) => envNames.includes(x), 'names environments of "environments" where a step that mutates may run');
  for (const name of Array.isArray(t.allowMutations) ? t.allowMutations : []) if (envs[name]?.production) err(`"allowMutations" names ${name}, marked "production": true: a step that mutates never runs on production`);
  listOf('personas', (x) => NAME_RE.test(x), 'names personas, like ["admin", "member", "outsider"] (lowercase letters, digits, "-")');
  if (Array.isArray(t.personas) && new Set(t.personas).size !== t.personas.length) err('"personas" names a persona twice');
  listOf('alsoAllow', (x) => !envUrlProblem(x), 'lists other origins a step may be redirected to (like "https://auth.example.com"), nothing else');
  t.alsoAllow = Array.isArray(t.alsoAllow) ? t.alsoAllow.map(originOf) : [];
  if (t.signIn !== null) t.signIn = checkSignIn(t.signIn, 'signIn', err);
  if (!isObj(t.afterDeploy) || !Object.values(t.afterDeploy).every((l) => Array.isArray(l) && l.every((x) => envNames.includes(x)))) err('"afterDeploy" maps a deploy branch to the environments it deploys to, like { "main": ["staging"] }');
  if (t.enabled && !envNames.length) err('"enabled" is true but no environment is named');
  return t;
}

// What an environment's URL may be: an origin, https (http only on this PC), no login, path, query or fragment
export function envUrlProblem(url) {
  if (typeof url !== 'string' || !url) return 'an address like https://staging.example.com';
  let u;
  try {
    u = new URL(url);
  } catch {
    return `"${url}" isn't an address`;
  }
  if (u.username || u.password) return 'an address with no login in it (personas sign in with the recipe)';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) return 'https:// (plain http:// only for a stand-in app on this PC: localhost or 127.0.0.1)';
  if ((u.pathname && u.pathname !== '/') || u.search || u.hash) return `the origin alone (${u.origin}): plans give the paths`;
  return '';
}

// The sign-in recipe: { http: step | [steps], browser: [steps] }. Persona values ({{username}}, {{password}},
// {{token}}) and captured values only in a filled value, a JSON or form value or a header's value; never in a path.
function checkSignIn(s, at, err) {
  if (!isObj(s)) {
    err(`"${at}" is { "http": [...], "browser": [...] }`);
    return null;
  }
  const out = { http: [], browser: [] };
  for (const k of Object.keys(s)) if (!['http', 'browser'].includes(k) && !k.startsWith('$')) err(`"${at}.${k}" isn't a part of the recipe (http, browser)`);
  const captures = new Set();
  if (s.http !== undefined) {
    const steps = Array.isArray(s.http) ? s.http : [s.http];
    if (!steps.length || steps.length > 10) err(`"${at}.http" is one request or a list of up to 10`);
    steps.forEach((r, i) => {
      const where = `${at}.http[${i}]`;
      if (!isObj(r)) return err(`"${where}" is { "request": "POST /api/session", "json": { ... } }`);
      for (const k of Object.keys(r)) if (!['request', 'json', 'form', 'headers', 'capture', 'keep'].includes(k)) err(`"${where}.${k}" isn't a field of a sign-in request`);
      const [method, p, extra] = String(r.request || '').trim().split(/\s+/);
      if (!['GET', 'POST', 'PUT'].includes(method) || !p || extra !== undefined || pathProblem(p)) err(`"${where}.request" is a method and a path, like "POST /api/session"`);
      if (/\{\{/.test(String(r.request || ''))) err(`"${where}.request": a persona's values never go in a path`);
      if (r.json !== undefined && r.form !== undefined) err(`"${where}": "json" or "form", not both`);
      placeholders(r.json, captures, where, err);
      placeholders(r.form, captures, where, err);
      if (r.headers !== undefined) {
        if (!isObj(r.headers)) err(`"${where}.headers" is a mapping of name: value`);
        else placeholders(r.headers, captures, where, err);
      }
      if (r.capture !== undefined) {
        if (!isObj(r.capture)) err(`"${where}.capture" is { "<name>": "$.json.path" }`);
        else {
          for (const [name, jp] of Object.entries(r.capture)) {
            if (!CAPTURE_RE.test(name) || PERSONA_FIELDS.includes(name)) err(`"${where}.capture.${name}": a name of lowercase letters, digits and "_" (not ${PERSONA_FIELDS.join(', ')})`);
            if (parseJsonPath(jp).problem) err(`"${where}.capture.${name}" is a JSON path like $.token`);
            captures.add(name);
          }
        }
      }
      if (r.keep !== undefined && !(r.keep === 'cookie' || (typeof r.keep === 'string' && r.keep.startsWith('bearer:') && !parseJsonPath(r.keep.slice(7)).problem))) err(`"${where}.keep" is "cookie" or "bearer:<JSON path>" (like "bearer:$.token")`);
      out.http.push({ method, path: p, json: r.json, form: r.form, headers: r.headers || {}, capture: r.capture || {}, keep: r.keep || '' });
    });
  }
  if (s.browser !== undefined) {
    if (!Array.isArray(s.browser) || !s.browser.length || s.browser.length > 20) err(`"${at}.browser" is a list of up to 20 browser steps`);
    else {
      s.browser.forEach((b, i) => {
        const where = `${at}.browser[${i}]`;
        const kinds = isObj(b) ? Object.keys(b) : [];
        if (kinds.length !== 1 || !['open', 'fill', 'click', 'press', 'wait'].includes(kinds[0])) return err(`"${where}" is one of { "open": "/sign-in" }, { "fill": ["#email", "{{username}}"] }, { "click": "..." }, { "press": "Enter" }, { "wait": "..." }`);
        const v = b[kinds[0]];
        if (kinds[0] === 'fill') {
          if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'string')) return err(`"${where}.fill" is [selector, value]`);
          if (/\{\{/.test(v[0])) err(`"${where}.fill": a persona's values never go in a selector`);
          placeholders(v[1], captures, where, err);
        } else if (typeof v !== 'string' || !v || /\{\{/.test(v) || (kinds[0] === 'open' && pathProblem(v))) err(`"${where}.${kinds[0]}" is ${kinds[0] === 'open' ? 'a path' : 'a selector or key'}, without a persona's values`);
      });
      out.browser = s.browser;
    }
  }
  if (!out.http.length && !out.browser.length) err(`"${at}" gives an "http" or a "browser" recipe`);
  return out;
}
function placeholders(v, captures, where, err) {
  const known = new Set([...PERSONA_FIELDS, ...captures]);
  const walk = (x) => {
    if (typeof x === 'string') {
      for (const m of x.matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) if (!known.has(m[1])) err(`"${where}": "{{${m[1]}}}" is none of ${[...known].map((k) => `{{${k}}}`).join(', ')}`);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) Object.values(x).forEach(walk);
  };
  walk(v);
}

// The recipe for an environment: its own, else the section's
export const signInFor = (t, env) => t?.environments?.[env]?.signIn || t?.signIn || null;
// Which recipe values a persona needs: the placeholders the recipe uses (its HTTP requests and its browser steps)
export function recipeFields(recipe) {
  const out = new Set();
  const walk = (x) => {
    if (typeof x === 'string') for (const m of x.matchAll(/\{\{\s*(username|password|token)\s*\}\}/g)) out.add(m[1]);
    else if (Array.isArray(x)) x.forEach(walk);
    else if (isObj(x)) Object.values(x).forEach(walk);
  };
  walk(recipe?.http || []);
  walk(recipe?.browser || []);
  return [...out];
}

// The guard's plain words for a change of the section (lib/protect.mjs), from code: where a persona's values would go
// and what may write. -> [lines]
export function testerChangeWords(before, after) {
  const b = isObj(before) ? before : null;
  const a = isObj(after) ? after : null;
  if (!b && !a) return [];
  const out = [];
  if (!b) out.push('adds the tester (acceptance runs against the environments it names)');
  if (!a) return ['removes the tester'];
  if (!!b?.enabled !== !!a.enabled) out.push(a.enabled ? 'turns the tester on' : 'turns the tester off');
  const envs = (x) => (isObj(x?.environments) ? x.environments : {});
  for (const [name, e] of Object.entries(envs(a))) {
    const old = envs(b)[name];
    if (!old) out.push(`adds the environment ${name} at ${e?.url}`);
    else if (old.url !== e?.url) out.push(`${name}'s URL changes to ${e?.url}: its personas must be set again`);
    if (e?.production !== true && old?.production === true) out.push(`${name} is no longer marked production`);
    if (JSON.stringify(e?.signIn ?? null) !== JSON.stringify(old?.signIn ?? null)) out.push(...recipeWords(e?.signIn, `${name}'s own sign-in`));
  }
  for (const name of Object.keys(envs(b))) if (!envs(a)[name]) out.push(`removes the environment ${name}`);
  const added = (k) => (Array.isArray(a[k]) ? a[k] : []).filter((x) => !(Array.isArray(b?.[k]) ? b[k] : []).includes(x));
  for (const e of added('allowMutations')) out.push(`mutations allowed on ${e}`);
  for (const o of added('alsoAllow')) out.push(`steps may also reach ${o}`);
  for (const p of added('personas')) out.push(`adds the persona ${p}`);
  if (JSON.stringify(a.signIn ?? null) !== JSON.stringify(b?.signIn ?? null)) out.push(...recipeWords(a.signIn, 'sign-in'));
  if (!!a.autoClose !== !!b?.autoClose) out.push(a.autoClose ? 'a card whose plan passes closes itself' : 'cards with a plan wait for the owner to close them');
  return out;
}
function recipeWords(recipe, what) {
  if (!isObj(recipe)) return [`${what}: removed`];
  const out = [];
  const http = Array.isArray(recipe.http) ? recipe.http : recipe.http ? [recipe.http] : [];
  for (const r of http) {
    const sent = [...JSON.stringify([r?.json, r?.form, r?.headers]).matchAll(/\{\{\s*(username|password|token)\s*\}\}/g)].map((m) => m[1]);
    out.push(`${what} now sends ${sent.length ? [...new Set(sent)].join(' and ') : 'no persona value'} to ${r?.request || '?'}`);
  }
  for (const b of Array.isArray(recipe.browser) ? recipe.browser : []) {
    if (isObj(b) && Array.isArray(b.fill) && /\{\{/.test(String(b.fill[1]))) out.push(`${what} now types ${String(b.fill[1]).replace(/[{}\s]/g, '')} into ${b.fill[0]}`);
  }
  return out.length ? out : [`${what} changes`];
}
