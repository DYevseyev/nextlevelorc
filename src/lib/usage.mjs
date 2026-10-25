// The usage ledger (docs/design/token-usage.md): one line per ended run, kept for good, in .nextlevel/usage/<YYYY-MM>.jsonl
// (the local month of the run's end), and what is summed from it: per range (the last hour, today, this week from
// Monday, this month, all time), per role, engine, model, worker, task, reason or day. usage.json, the day's totals the
// dashboard read before, is still written beside it for an older version (Go back); what an older version counted
// there comes into the ledger at the hub's start as one line per day, role and engine (`kind: "day"`, dayLines).
// The ledger is in .nextlevel/, which the team can write: every line is read through a shape check, so what a reader
// gets is ids, names and numbers, never free text. Pure, but its writer and readers (fs).
import fs from 'node:fs';
import path from 'node:path';
import { withFileLock } from './filelock.mjs';

export const LEDGER_VERSION = 1;
export const MAX_LINE = 2048;
export const MAX_FILE = 32 * 1024 * 1024;
const WORD = /^[a-z-]{1,24}$/;
const NAME = /^[\w.:/@+[\]-]{0,80}$/; // (a slug: Claude Code's "opus[1m]" too)
const TASK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_FILE = /^(\d{4})-(\d{2})\.jsonl$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const TOKEN_PARTS = ['total', 'input', 'cacheWrite', 'output', 'cached', 'thinking'];

export const ledgerDir = (stateDir) => path.join(stateDir, 'usage');
const pad = (n) => String(n).padStart(2, '0');
// The local day and month of a time (ms)
export const dayOf = (ms) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
export const monthOf = (ms) => dayOf(ms).slice(0, 7);
const dayStart = (day) => {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
};

const num = (x) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : null);
const word = (x) => (typeof x === 'string' && WORD.test(x) ? x : null);
const name = (x) => (typeof x === 'string' && NAME.test(x) ? x : null);
const iso = (x) => (typeof x === 'string' && ISO.test(x) && Number.isFinite(Date.parse(x)) ? x : null);
const round3 = (x) => Math.round(x * 1000) / 1000;
// A model as the ledger keeps it: its slug. Antigravity's own choice is read from its settings as a label ("Gemini 3.8
// Flash (High)"), whose slug is the label lower-cased, without its brackets, words joined by "-" (gemini-3.8-flash-high,
// as `agy models` lists them); anything else that isn't a slug is left out by the shape check.
export const modelSlug = (m) => {
  const s = String(m || '').trim().slice(0, 80);
  return NAME.test(s) ? s : s.toLowerCase().replace(/[()]/g, '').trim().replace(/\s+/g, '-');
};

// A run's tokens as the ledger keeps them: { total, input?, cacheWrite?, output?, cached?, thinking? } from an adapter's
// { tokens, cached, input, cacheWrite, output, thinking }, or null when the engine reported none
export function tokensOf(t) {
  if (!t || typeof t !== 'object') return null;
  const total = num(t.total ?? t.tokens);
  if (total === null) return null;
  const out = { total };
  for (const k of TOKEN_PARTS.slice(1)) if (num(t[k]) !== null) out[k] = t[k];
  return out;
}

// A line as it may be: the fields of the shape, each checked; a field that fails is dropped. null: not a line (no time).
export function cleanRecord(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const v = Number.isSafeInteger(o.v) && o.v >= 1 ? o.v : null;
  if (!v) return null;
  const r = { v };
  if (o.kind === 'day') {
    if (typeof o.day !== 'string' || !DAY.test(o.day) || !Number.isFinite(dayStart(o.day))) return null;
    r.kind = 'day';
    r.day = o.day;
  } else {
    const at = iso(o.at);
    if (!at) return null;
    r.at = at;
    if (iso(o.start)) r.start = o.start;
  }
  for (const k of ['role', 'engine', 'end', 'reason', 'worker']) if (word(o[k]) !== null) r[k] = o[k];
  for (const k of ['model', 'profile', 'effort']) if (name(o[k]) !== null) r[k] = o[k];
  if (typeof o.task === 'string' && TASK.test(o.task)) r.task = o.task;
  for (const k of ['attempt', 'slot', 'runs', 'minutes', 'reported']) if (num(o[k]) !== null) r[k] = o[k];
  if (o.notCounted === 'stopped from outside') r.notCounted = o.notCounted;
  const t = tokensOf(o.tokens);
  r.tokens = t;
  if (!r.role || !r.engine) return null;
  return r;
}

// The line for a run (what addUsage was given), or null when it isn't one
export function runRecord({ at, start, role, engine, runs = 1, minutes = 0, tokens = null, model, effort, profile, worker, task, attempt, slot, reason, end, notCounted }) {
  return cleanRecord({
    v: LEDGER_VERSION,
    at,
    start,
    role,
    engine,
    runs,
    minutes: round3(Number(minutes) || 0),
    tokens: tokensOf(tokens),
    ...(model ? { model: modelSlug(model) } : {}),
    ...(effort ? { effort } : {}),
    ...(profile ? { profile } : {}),
    ...(worker ? { worker } : {}),
    ...(task ? { task } : {}),
    ...(attempt ? { attempt } : {}),
    ...(slot ? { slot: Number(String(slot).replace(/^\D+/, '')) || undefined } : {}),
    ...(reason ? { reason } : {}),
    ...(end ? { end } : {}),
    ...(notCounted ? { notCounted } : {}),
  });
}

// Appends lines to the month file of their time, under that file's own lock. A file whose last line was cut (no final
// newline: a write a power loss stopped) gets its newline first, so only that line is lost. -> the files written
export function appendLedger(stateDir, records, { onLock } = {}) {
  const byFile = new Map();
  for (const r of records) {
    const c = cleanRecord(r);
    if (!c) continue;
    const month = c.kind === 'day' ? c.day.slice(0, 7) : monthOf(Date.parse(c.at));
    const file = path.join(ledgerDir(stateDir), `${month}.jsonl`);
    byFile.set(file, [...(byFile.get(file) || []), c]);
  }
  for (const [file, list] of byFile) {
    withFileLock(
      file,
      () => {
        let cut = false;
        try {
          const size = fs.statSync(file).size;
          if (size > 0) {
            const fd = fs.openSync(file, 'r');
            try {
              const b = Buffer.alloc(1);
              fs.readSync(fd, b, 0, 1, size - 1);
              cut = b[0] !== 0x0a;
            } finally {
              fs.closeSync(fd);
            }
          }
        } catch {
          // no file yet
        }
        fs.appendFileSync(file, `${cut ? '\n' : ''}${list.map((r) => JSON.stringify(r)).join('\n')}\n`);
      },
      { onLock },
    );
  }
  return [...byFile.keys()];
}

// The lines of the months that overlap [from, to) (ms; to: Infinity for none), in time order, each through the shape
// check. -> { records, notes } (notes: what it couldn't read, in words)
export function readLedger(stateDir, { from = -Infinity, to = Infinity } = {}) {
  const dir = ledgerDir(stateDir);
  const notes = [];
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => MONTH_FILE.test(f)).sort();
  } catch {
    return { records: [], notes };
  }
  const records = [];
  for (const f of names) {
    const [, y, m] = f.match(MONTH_FILE);
    const start = new Date(Number(y), Number(m) - 1, 1).getTime();
    const end = new Date(Number(y), Number(m), 1).getTime();
    if (end <= from || start >= to) continue;
    let text = '';
    try {
      const file = path.join(dir, f);
      const size = fs.statSync(file).size;
      if (size > MAX_FILE) {
        const fd = fs.openSync(file, 'r');
        try {
          const b = Buffer.alloc(MAX_FILE);
          fs.readSync(fd, b, 0, MAX_FILE, 0);
          text = b.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
        notes.push(`${f} is ${Math.round(size / 1048576)} MB: only its first ${MAX_FILE / 1048576} MB were read`);
      } else text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      notes.push(`${f} couldn't be read (${err.code || err.message})`);
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line || line.length > MAX_LINE) continue;
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      const r = cleanRecord(o);
      if (r && inRange(r, from, to)) records.push(r);
    }
  }
  records.sort((a, b) => timeOf(a) - timeOf(b));
  return { records, notes };
}
const timeOf = (r) => (r.kind === 'day' ? dayStart(r.day) : Date.parse(r.at));
// A run counts at its end; a day's line only in a range that holds the whole day
function inRange(r, from, to) {
  if (r.kind !== 'day') {
    const t = Date.parse(r.at);
    return t >= from && t < to;
  }
  const s = dayStart(r.day);
  const [y, m, d] = r.day.split('-').map(Number);
  const e = new Date(y, m - 1, d + 1).getTime();
  return s >= from && e <= to;
}

// The ranges, at a time (ms): [{ key, title, from, to, since }] (since: the start, in words)
// The records of a range, from records read already (the dashboard keeps them while no month file changes)
export const within = (records, { from = -Infinity, to = Infinity } = {}) => records.filter((r) => inRange(r, from, to));

export function ranges(now) {
  const d = new Date(now);
  const today = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
  const month = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  const words = (ms) => new Date(ms).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return [
    { key: 'hour', title: 'Last hour', from: now - 3_600_000, to: Infinity, since: 'the last 60 minutes' },
    { key: 'today', title: 'Today', from: today, to: Infinity, since: words(today) },
    { key: 'week', title: 'This week', from: monday, to: Infinity, since: `from ${words(monday)}` },
    { key: 'month', title: 'This month', from: month, to: Infinity, since: `from ${words(month).replace(/^\w+ /, '')}` },
    { key: 'all', title: 'All time', from: -Infinity, to: Infinity, since: 'everything this PC has counted' },
  ];
}
export const RANGE_KEYS = ['hour', 'today', 'week', 'month', 'all'];
export const BY_KEYS = ['role', 'engine', 'model', 'worker', 'task', 'reason', 'day', 'profile'];

// The key a line is grouped under, for `by`
function keyOf(r, by) {
  if (by === 'day') return r.kind === 'day' ? r.day : dayOf(Date.parse(r.at));
  if (by === 'reason') return r.reason || (r.role === 'assistant' ? 'advise' : '');
  if (by === 'role') return r.role;
  return r[by] ?? '';
}

// The sums of `records` by one field: [{ key, runs, minutes, tokens, cached, reported, failedTokens }], the biggest
// first (by tokens, then minutes; days in time order). `reported`: the runs whose engine reported tokens.
export function sumUsage(records, { by = 'role' } = {}) {
  const groups = new Map();
  for (const r of records) {
    const k = keyOf(r, by);
    const g = groups.get(k) || { key: k, runs: 0, minutes: 0, tokens: 0, cached: 0, reported: 0, failedTokens: 0 };
    const runs = r.runs ?? (r.kind === 'day' ? 0 : 1);
    g.runs += runs;
    g.minutes += r.minutes || 0;
    if (r.tokens) {
      g.tokens += r.tokens.total;
      g.cached += r.tokens.cached || 0;
      g.reported += r.kind === 'day' ? r.reported ?? runs : 1;
      if (r.role === 'worker' && r.end && r.end !== 'done') g.failedTokens += r.tokens.total;
    }
    groups.set(k, g);
  }
  const list = [...groups.values()].map((g) => ({ ...g, minutes: Math.round(g.minutes * 10) / 10 }));
  if (by === 'day') return list.sort((a, b) => a.key.localeCompare(b.key));
  return list.sort((a, b) => b.tokens - a.tokens || b.minutes - a.minutes || String(a.key).localeCompare(String(b.key)));
}

// The chart's series: one entry per local day in [from, to), each { day, engines: { <engine>: tokens }, tokens, runs }.
// from: the first line's day when the range has no start.
export function perDay(records, { from = -Infinity, to = Infinity, now = Date.now() } = {}) {
  const first = Number.isFinite(from) ? from : records.length ? dayStart(keyOf(records[0], 'day')) : dayStart(dayOf(now));
  const last = Number.isFinite(to) ? to : now;
  const days = [];
  const d0 = new Date(first);
  for (let i = 0; i < 4000; i++) {
    const ms = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate() + i).getTime();
    if (ms >= last && i > 0) break;
    days.push({ day: dayOf(ms), engines: {}, tokens: 0, runs: 0 });
  }
  const at = new Map(days.map((x) => [x.day, x]));
  for (const r of records) {
    const x = at.get(keyOf(r, 'day'));
    if (!x) continue;
    x.runs += r.runs ?? (r.kind === 'day' ? 0 : 1);
    if (r.tokens) {
      x.tokens += r.tokens.total;
      x.engines[r.engine] = (x.engines[r.engine] || 0) + r.tokens.total;
    }
  }
  return days;
}

// What older versions counted that the ledger doesn't have: for one day of usage.json, the lines for the difference
// between its `by` (every version adds there) and `ledgered` (what this version added, in the same change). -> lines
export function dayLines(day, entry) {
  if (!DAY.test(day) || !entry || typeof entry !== 'object') return [];
  const by = entry.by && typeof entry.by === 'object' ? entry.by : {};
  const done = entry.ledgered && typeof entry.ledgered === 'object' ? entry.ledgered : {};
  const out = [];
  for (const [key, row] of Object.entries(by)) {
    const [role, engine] = key.split(':');
    if (!row || typeof row !== 'object') continue;
    const had = done[key] || {};
    const diff = (k) => Math.max(0, (num(row[k]) || 0) - (num(had[k]) || 0));
    const runs = diff('runs');
    const minutes = round3(diff('minutes'));
    const tokens = diff('tokens');
    const reported = diff('reported');
    if (!runs && !minutes && !tokens) continue;
    const line = cleanRecord({ v: LEDGER_VERSION, kind: 'day', day, role, engine, runs, minutes, reported, tokens: reported || tokens ? { total: tokens, cached: diff('cached') } : null });
    if (line) out.push(line);
  }
  return out;
}

// The oldest day the ledger has, or ''
export const oldestDay = (records) => (records.length ? keyOf(records[0], 'day') : '');

// ---------- `nextlevel usage` in words ----------
const n = (x) => Math.round(x).toLocaleString('en-US');
// A group's tokens: "412,000", "412,000 (12 of 14 runs reported)", or "not reported"
export function tokensWords(g) {
  if (!g.reported) return g.runs ? 'not reported' : '—';
  return g.reported < g.runs ? `${n(g.tokens)} (${g.reported} of ${g.runs} runs reported)` : n(g.tokens);
}
// The rows as lines of a table, as many as fit `maxBytes`: { lines, left } (left: the rows left out)
export function usageLines(rows, { label = 'Who', maxBytes = Infinity } = {}) {
  const cells = rows.map((g) => [String(g.key || '(none)'), String(g.runs), String(g.minutes), tokensWords(g), g.cached ? n(g.cached) : '']);
  const head = [label, 'Runs', 'Minutes', 'Tokens', 'Cache reads'];
  const w = head.map((h, i) => Math.min(48, Math.max(h.length, ...cells.map((c) => c[i].length))));
  const line = (c) => c.map((x, i) => (i === 0 ? x.padEnd(w[i]) : x.padStart(w[i]))).join('  ').trimEnd();
  const lines = [line(head)];
  let bytes = Buffer.byteLength(lines[0]) + 1;
  let shown = 0;
  for (const c of cells) {
    const l = line(c);
    if (bytes + Buffer.byteLength(l) + 1 > maxBytes) break;
    lines.push(l);
    bytes += Buffer.byteLength(l) + 1;
    shown++;
  }
  return { lines, left: rows.length - shown };
}
// A task's tokens, from its lines: "412,000 over 3 attempts (the 2 that didn't end done: 230,000)", or '' for none
export function taskTokensText(records) {
  const runs = records.filter((r) => r.role === 'worker' && r.kind !== 'day');
  if (!runs.length) return '';
  const [g] = sumUsage(runs, { by: 'task' });
  const failed = runs.filter((r) => r.end && r.end !== 'done').length;
  return `${tokensWords(g)} over ${g.runs} attempt${g.runs === 1 ? '' : 's'}${failed && g.failedTokens ? ` (the ${failed} that didn't end done: ${n(g.failedTokens)})` : ''}, ${g.minutes} minutes`;
}
