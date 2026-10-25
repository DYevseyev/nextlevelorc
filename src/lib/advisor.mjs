// The advisor (docs/design/advisor.md): what its answers draft for the owner, and its memory.
//
// Drafts, from the answer's own lines (pure; every pattern runs in time linear in a line's length): `Note: <text>` and
// `Rule: <text>`; `Reply to H12:` followed by a block opened and closed by a line of exactly three backticks;
// `Remember: <text>`, `Remember: <text> (replaces M3)` and `Forget: M3`. At most three per answer. None of them acts:
// the dashboard shows each one whole, and only the owner's click sends it (a note or a reply through the Notes page's
// routes, the memory through its own). There is no draft for an Approve, a Reject, a push, a deploy or a card's Done.
//
// The memory: ~/.nextlevel/advisor/<project key>/memory.json, outside the project like the guard's records, at most 30
// entries of at most 200 characters, read through a shape check (a bad file reads as empty, and says so). Only the
// owner writes it: `nextlevel ask memory add|edit|remove` refuses in an agent's session, and the dashboard's route
// needs its session key. No wall (docs/KNOWN_ISSUES.md): an agent running as the owner without permission checks
// could still write the file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectKey } from './guard.mjs';
import { readJsonFile, updateJsonFile } from './filelock.mjs';
import { MAX_MESSAGE } from './cards.mjs';

export const MEMORY = { entries: 30, text: 200 };
export const MAX_DRAFTS = 3;
const NOTE_MAX = 4000; // (a note's limit, lib/cards.mjs)
const KINDS = ['decision', 'preference'];
const MEMORY_ID_RE = /^M[1-9]\d{0,5}$/;
const CARD_ID_RE = /^H[1-9]\d{0,6}$/;
const FENCE = '```';

const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? t.slice(0, n) : t;
};
// A line's label (Note, Rule, Remember, Forget, Reply to H12), with up to four marks around it (`**Note:**`, `- Note:`)
const LABEL = /^\W{0,4}(note|rule|remember|forget|reply to (h\d{1,7}))\W{0,4}:\s*(.*)$/i;
const strip = (s) => s.replace(/[`*]+/g, '').trim();

// [{ kind: 'note' | 'rule' | 'reply' | 'remember' | 'forget', text, card?, replaces?, id? }]
export function draftsOf(answer) {
  const lines = String(answer ?? '').split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length && out.length < MAX_DRAFTS; i++) {
    const m = lines[i].trim().match(LABEL);
    if (!m) continue;
    const label = m[1].toLowerCase();
    const rest = m[3];
    if (label === 'note' || label === 'rule') {
      const text = cut(strip(rest), NOTE_MAX);
      if (text) out.push({ kind: label, text });
    } else if (label === 'forget') {
      const id = strip(rest).toUpperCase();
      if (MEMORY_ID_RE.test(id)) out.push({ kind: 'forget', id });
    } else if (label === 'remember') {
      let text = strip(rest);
      // "(replaces M3)" at its end: an update of that entry
      const r = text.match(/\(\s*replaces\s+(M\d{1,6})\s*\)$/i);
      const replaces = r && MEMORY_ID_RE.test(r[1].toUpperCase()) ? r[1].toUpperCase() : '';
      if (r) text = text.slice(0, r.index).trim();
      text = cut(text, MEMORY.text);
      if (text) out.push({ kind: 'remember', text, ...(replaces ? { replaces } : {}) });
    } else {
      // Reply to H12: then a block between two lines of exactly three backticks; an unclosed block drafts nothing
      const card = m[2].toUpperCase();
      if (!CARD_ID_RE.test(card) || rest.trim() || lines[i + 1]?.trim() !== FENCE) continue;
      const end = lines.findIndex((l, j) => j > i + 1 && l.trim() === FENCE);
      if (end < 0) continue;
      const text = cut(lines.slice(i + 2, end).join('\n').trim(), MAX_MESSAGE);
      if (text) out.push({ kind: 'reply', card, text });
      i = end;
    }
  }
  return out;
}

// What a draft for a card can be on the page: '' (it can be sent), or why it can't (a held change's or a push's card,
// decided on its own card; a card that is gone). `cards`: the handoff items.
export function replyProblem(draft, cards = []) {
  const c = cards.find((x) => x.id === draft.card);
  if (!c) return `${draft.card} is gone`;
  if (c.guard || c.from === 'guard') return `${draft.card} is decided on its own card`;
  return '';
}

// ---------- the memory ----------
export const advisorDir = (root, home = os.homedir()) => path.join(home, '.nextlevel', 'advisor', projectKey(root));

// Why a memory file's content isn't the store's shape, or ''
export function memoryProblem(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'not an object';
  if (!Array.isArray(v.items)) return 'no list of entries';
  if (!Number.isInteger(v.next) || v.next < 1) return 'no next id';
  if (v.items.length > MEMORY.entries) return `more than ${MEMORY.entries} entries`;
  for (const x of v.items) {
    if (!x || typeof x !== 'object') return 'an entry that is not an object';
    if (!MEMORY_ID_RE.test(String(x.id))) return `an entry with the id "${String(x.id).slice(0, 20)}"`;
    if (typeof x.text !== 'string' || !x.text.trim() || x.text.length > MEMORY.text) return `${x.id}'s text`;
    if (!KINDS.includes(x.kind)) return `${x.id}'s kind`;
    if (typeof x.at !== 'string' || typeof x.from !== 'string') return `${x.id}'s time or origin`;
  }
  if (new Set(v.items.map((x) => x.id)).size !== v.items.length) return 'two entries with one id';
  return '';
}

const EMPTY = { version: 1, next: 1, items: [] };
// One line of text for an entry: no line breaks or control characters, within the limit
function entryText(s) {
  const t = String(s ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) throw new Error('the entry is empty');
  if (t.length > MEMORY.text) throw new Error(`an entry has at most ${MEMORY.text} characters (this one has ${t.length}): say it shorter`);
  return t;
}
const kindOf = (k) => {
  if (k === undefined || k === '' || k === null) return 'decision';
  if (!KINDS.includes(k)) throw new Error(`the kind is ${KINDS.join(' or ')}`);
  return k;
};
// The origin of an entry: a thread's id (letters and digits) or 'by hand'
const fromOf = (f) => (/^[a-z0-9]{8,32}$/.test(String(f || '')) ? String(f) : 'by hand');

export function memoryStore(dir) {
  const file = path.join(dir, 'memory.json');
  // -> { items, problem }: a file that isn't the store's shape reads as empty, and says why
  const read = () => {
    if (!fs.existsSync(file)) return { items: [], problem: '' };
    const bad = Symbol('not JSON');
    const v = readJsonFile(file, bad);
    const problem = v === bad ? 'not JSON' : memoryProblem(v);
    return problem ? { items: [], problem: `the advisor's memory (${file}) can't be read: ${problem}. It is left as it is; delete it to start again` } : { items: v.items, problem: '' };
  };
  const change = (fn) => {
    let result;
    updateJsonFile(
      file,
      (cur) => {
        if (fs.existsSync(file) && memoryProblem(cur)) throw new Error(read().problem || "the advisor's memory can't be read");
        const data = memoryProblem(cur) ? structuredClone(EMPTY) : structuredClone(cur);
        result = fn(data);
        return data;
      },
      structuredClone(EMPTY),
    );
    return result;
  };
  const find = (data, id) => {
    const x = data.items.find((e) => e.id === String(id || '').toUpperCase());
    if (!x) throw new Error(`no memory entry "${String(id).slice(0, 20)}": nextlevel ask memory lists them`);
    return x;
  };
  return {
    file,
    read,
    list: () => read().items,
    add({ text, kind, from } = {}) {
      return change((data) => {
        const t = entryText(text);
        if (data.items.length >= MEMORY.entries) throw new Error(`the memory is full (${MEMORY.entries}): forget one first`);
        const item = { id: `M${data.next}`, text: t, kind: kindOf(kind), at: new Date().toISOString(), from: fromOf(from) };
        data.items.push(item);
        data.next += 1;
        return item;
      });
    },
    edit(id, { text, kind } = {}) {
      return change((data) => {
        const x = find(data, id);
        x.text = entryText(text);
        if (kind !== undefined) x.kind = kindOf(kind);
        x.at = new Date().toISOString();
        return { ...x };
      });
    },
    remove(id) {
      return change((data) => {
        const x = find(data, id);
        data.items = data.items.filter((e) => e !== x);
        return x;
      });
    },
  };
}

// The memory as the briefing has it: one line per entry (never cut: the store's limits keep it within its budget)
export const memoryLines = (items) => items.map((x) => `- ${x.id} (${x.kind}): ${x.text}`).join('\n');
