// The Daybreak model watch (security engineer 1b-1): which models the security engineer's sign-in covers with OpenAI's
// Daybreak Blue, from the scanner's own `codex debug models` (lib/securityrun.mjs accessPrograms: model-free, no plan
// spent), once a day and when the scanner's image changes. A model counts as covered only when its
// available_access_programs.cyber lists daybreak_blue, the one proof Step 0 found; one that says nothing of its programs
// never does. Pure, but the record's path.
// The record is the sign-in's, not a project's: one per account key (lib/securityspec.mjs accountKey), in
// ~/.nextlevel/security/daybreak-watch/<account key>.json, written by the hub whose `_daybreak` took the PC's lease and
// read by every project's hub and dashboard (updateJsonFile: several writers). What a project makes of it (whether its
// chosen model is still covered) is worked out at each look from the record and its role, never kept.
//   { at (the last answer that listed models), tried (the last try), digest (the image it asked), ok, why, fails,
//     models: [{ id, programs }], covered: [ids], news: [{ kind: 'new', model, at }], told: [keys] }
// News: a model covered now that the answer before didn't list as covered (never on the first answer: everything would
// be new), until the owner's Seen or it stops being covered. The phone hears each piece of news once per PC (`told`).
import path from 'node:path';

export const WATCH_EVERY_MS = 24 * 3600_000;
export const RETRY_MS = 3600_000;
export const BACKOFF_AFTER = 3; // failed tries in a row, after which the hourly retry becomes a daily one
const KEEP = 200;
const ID = /^[A-Za-z0-9._:-]{1,80}$/;

export const watchFile = (home, account) => path.join(home, '.nextlevel', 'security', 'daybreak-watch', `${account}.json`);

// The record, read through a shape check (a field that isn't its type is dropped)
export function readWatch(d) {
  const o = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  const iso = (x) => (typeof x === 'string' && !Number.isNaN(Date.parse(x)) ? x : '');
  const ids = (x) => (Array.isArray(x) ? [...new Set(x.filter((y) => typeof y === 'string' && ID.test(y)))].slice(0, KEEP) : []);
  const models = Array.isArray(o.models)
    ? o.models.filter((m) => m && typeof m.id === 'string' && ID.test(m.id)).slice(0, KEEP).map((m) => ({ id: m.id, programs: Array.isArray(m.programs) ? m.programs.filter((x) => typeof x === 'string').slice(0, 10) : null }))
    : [];
  const news = Array.isArray(o.news) ? o.news.filter((n) => n && n.kind === 'new' && typeof n.model === 'string' && ID.test(n.model)).slice(0, KEEP).map((n) => ({ kind: 'new', model: n.model, at: iso(n.at) })) : [];
  return {
    at: iso(o.at),
    tried: iso(o.tried),
    digest: typeof o.digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(o.digest) ? o.digest : '',
    ok: o.ok === true,
    why: typeof o.why === 'string' ? o.why.slice(0, 300) : '',
    fails: Number.isInteger(o.fails) && o.fails > 0 ? Math.min(o.fails, 1000) : 0,
    models,
    covered: ids(o.covered),
    news,
    told: Array.isArray(o.told) ? o.told.filter((k) => typeof k === 'string' && k.length <= 120).slice(-KEEP) : [],
  };
}

// Whether a look should ask now: no answer yet, another image, a day since the last answer, or (after a failed try) an
// hour since it, a day after BACKOFF_AFTER failures in a row
export function watchDue(rec, { now, digest }) {
  const r = readWatch(rec);
  if (!r.tried) return true;
  if (r.digest !== digest) return true;
  const since = (x) => now - Date.parse(x || 0);
  if (!r.ok) return since(r.tried) >= (r.fails >= BACKOFF_AFTER ? WATCH_EVERY_MS : RETRY_MS);
  return since(r.at) >= WATCH_EVERY_MS;
}

const covers = (m) => Array.isArray(m.programs) && m.programs.includes('daybreak_blue');

// The record after an answer: `answer` is accessPrograms's ({ ok, models } or { ok: false, why })
export function withAnswer(rec, answer, { now, digest }) {
  const r = readWatch(rec);
  const at = new Date(now).toISOString();
  if (!answer?.ok) return { ...r, tried: at, digest, ok: false, why: String(answer?.why || 'no answer').slice(0, 300), fails: r.fails + 1 };
  const models = readWatch({ models: answer.models }).models;
  const covered = models.filter(covers).map((m) => m.id);
  const before = r.at ? new Set(r.covered) : null; // (the first answer: no news)
  const kept = r.news.filter((n) => covered.includes(n.model));
  const fresh = before ? covered.filter((id) => !before.has(id) && !kept.some((n) => n.model === id)).map((model) => ({ kind: 'new', model, at })) : [];
  // (a model no longer covered may be told again when it comes back, and a chosen model that came back may be told
  // again when it drops)
  const told = r.told.filter((k) => {
    const [kind] = k.split(':');
    const model = k.split(':').slice(2).join(':');
    return kind === 'new' ? covered.includes(model) : kind === 'dropped' ? !covered.includes(model) : true;
  });
  return { ...r, at, tried: at, digest, ok: true, why: '', fails: 0, models, covered, news: [...kept, ...fresh], told };
}

// What a project's role makes of it: the chosen model, when Daybreak is on for it and the last answer that listed models
// doesn't cover it (or doesn't list it at all); '' otherwise
export function droppedModel(rec, role) {
  const r = readWatch(rec);
  if (!r.at || !role?.daybreak || !role.model) return '';
  return r.covered.includes(role.model) ? '' : role.model;
}

// The owner's Seen on a piece of news: gone from the record (the model stays covered, and is never news again until it
// stops being covered and comes back)
export const seenNews = (rec, model) => {
  const r = readWatch(rec);
  return { ...r, news: r.news.filter((n) => n.model !== model) };
};

// What the phone hasn't heard yet (once per PC): [{ key, text }] for the news and a project's dropped model
export function untold(rec, { account, dropped = '', project = '' }) {
  const r = readWatch(rec);
  const out = r.news.map((n) => ({ key: `new:${account}:${n.model}`, text: `Daybreak Blue now covers ${n.model} for the security engineer's sign-in. Switch to it on Home or the Team page if you want it: nextlevel never switches by itself.` }));
  if (dropped) out.push({ key: `dropped:${account}:${dropped}`, text: `${project ? `${project}: ` : ''}the security engineer's model ${dropped} no longer takes Daybreak Blue, so its next scan won't start. Choose another model on the Team page.` });
  return out.filter((x) => !r.told.includes(x.key));
}
export const withTold = (rec, keys) => {
  const r = readWatch(rec);
  return { ...r, told: [...r.told, ...keys.filter((k) => !r.told.includes(k))].slice(-KEEP) };
};

// Home's and the Security page's words for it
export function watchWords(rec, role, { now }) {
  const r = readWatch(rec);
  if (!r.tried) return { text: 'The Daybreak watch hasn\'t looked yet: it asks the scanner which models Daybreak Blue covers once a day.', covered: [], news: [], dropped: '' };
  const ago = (x) => {
    const m = Math.max(0, Math.round((now - Date.parse(x)) / 60_000));
    return m < 1 ? 'just now' : m < 90 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
  };
  const dropped = droppedModel(r, role);
  const last = r.at ? `Daybreak Blue covers ${r.covered.length ? r.covered.join(', ') : 'no model'} on this sign-in (checked ${ago(r.at)})` : 'No answer yet';
  const failed = r.ok ? '' : `; the last try (${ago(r.tried)}) couldn't ask: ${r.why}${r.fails >= BACKOFF_AFTER ? `. After ${r.fails} tries in a row it asks once a day` : '. It asks again in an hour'}`;
  return { text: `${last}${failed}.`, covered: r.covered, news: r.news.map((n) => n.model), dropped, at: r.at, ok: r.ok, fails: r.fails };
}
