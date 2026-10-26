// Owner notes and handoff items as cards: structured data the dashboard, the owner and the orchestrator change
// through nextlevel (the dashboard's Notes page, `nextlevel note ...`, `nextlevel handoff ...`), never by editing
// Markdown. Kept in the state folder (.nextlevel/notes.json, .nextlevel/handoff.json); docs/OWNER_NOTES.md and
// docs/HANDOFF.md are written from them after every change, for Git history and for anyone reading the repo.
//
// A note (from the owner to the orchestrator): { id: 'N3', type: 'once' | 'rule', text, status, off, createdAt,
//   updatedAt, editedAt, seenAt, handledAt, reply, commit, task }. status: new -> seen (the orchestrator read it)
//   -> done (with its one-line reply and the commit or task) or declined (with why); the owner can withdraw a
//   one-time note, and switch a standing rule off (off: true) or remove it. A rule is never done: it stays
//   listed until it is removed. Handled one-time notes (done, declined, withdrawn) and removed rules are history.
// A handoff item (from the team to the owner): { id: 'H2', what, where, why, task, status: open | done |
//   cancelled, createdAt, updatedAt, doneAt, thread, reply, repliedAt, answeredAt, readAt, seenAt, note }. The owner
//   marks it done or replies; the orchestrator sees what it hasn't seen yet (seenAt), answers on the card and cancels
//   what it no longer needs. `thread` (FR-014): the conversation after the question, in time order, { by: 'owner' |
//   'team', text, at }, each text whole with its line breaks; `reply`/`repliedAt` are the owner's last reply (what
//   older nextlevels read), `answeredAt` the team's last answer, `readAt` when the owner marked an answer on a done
//   card read. A card the team answered waits for the owner until the owner replies or marks it done.
//   Since undo Done and FR-018: `pending` ({ action: 'done', reply, at, finalAt }) is a Done from the dashboard that
//   can still be undone: until `finalAt` the card is what it was for everyone (the team, autopilot, the Markdown), and
//   any writer or reader past `finalAt` makes it final (`settle`), so it never needs the page or a timer. `closedBy`
//   ('owner' | 'team') says whose a done card's closing was (the team closes one with `close`, after the owner acted);
//   `events` ({ kind: 'done' | 'closed' | 'cancelled' | 'reopened', by, how, note, at }) are the card's closings and
//   reopenings, beside `thread` (messages only, as older readers know it); `reopenedAt` and `reopenedHow` ('dashboard'
//   | 'terminal' | 'reply') the last reopening, which the orchestrator is told of.
//
// The first time a store is needed, the project's current Markdown is imported (bullets under "New" become new
// notes, under "Done" done ones; "- [ ]" items become open handoff items, "- [x]" done ones). A file edited by
// hand afterwards (the owner typing a note there out of habit, an orchestrator on an older ORCHESTRATOR.md adding
// a "- [ ]" line) is read back on the next change: lines it doesn't know become new items, a ticked item is
// done; nothing is deleted. Reading never writes: an import is saved with the first change.
// Each store counts what the owner did on it (`owner`: { n, at, what }, FR-019): a note added, changed, withdrawn,
// switched off or on, or removed; a reply on a card, a card marked done, a decision on a held change's card; a note
// typed into the Markdown, a card ticked there. Autopilot starts a round for that (and only the owner's side counts:
// the team's answers, its cards and its notes never do).
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clockNow } from './clock.mjs';
import { withFileLock } from './filelock.mjs';
import { cleanText } from './textin.mjs';

const VERSION = 1;
// How long a text on a card may be (FR-014): an owner's reply or a team's answer, a request, a one-line field
export const MAX_MESSAGE = 20_000;
export const MAX_REQUEST = 4000;
export const MAX_LINE = 2000;
// How long a Done on the dashboard can be undone (undo Done): the card's `pending.finalAt` is this after the click
export const UNDO_MS = 10_000;
const count = (n) => n.toLocaleString('en-US');
const hash = (text) => createHash('sha256').update(String(text).replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
// Times that only go forward in this process: "did the owner answer after the team last looked" compares them. From
// lib/clock.mjs: the tests move a test clock past an Undo's 10 seconds instead of waiting for them.
let last = 0;
const now = () => {
  last = Math.max(clockNow(), last + 1);
  return new Date(last).toISOString();
};
const norm = (s) => String(s || '').replace(/\*\*[NH]\d+\*\*/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
// "2026-09-26 10:02", this PC's time
export const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
const readText = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};
// (the new content goes to a new file of a name no one can guess, `wx`: never through a link an agent put there first)
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, text, { flag: 'wx' });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, file);
      return;
    } catch (err) {
      if (i >= 40) {
        fs.rmSync(tmp, { force: true });
        throw err; // Windows: a reader may hold the file for a moment
      }
      sleepSync(25);
    }
  }
}


// ---------- reading the Markdown (an import, or a file edited by hand) ----------
// A handoff item's "- The owner replied <time>:" or "- The team answered <time>:" line (FR-014) -> { by, when }, or null.
// In plain steps rather than one regex that could backtrack (rafter's scan).
function threadHead(t) {
  if (!/^[-*] /.test(t)) return null;
  const words = t.slice(2).trim();
  const m = /^the (owner|team) (replied|answered)/i.exec(words);
  if (!m) return null;
  const rest = words.slice(m[0].length).replace(/:$/, '').trim();
  if (rest && !/^\d{4}-\d\d-\d\d \d\d:\d\d$/.test(rest)) return null;
  return { by: m[1].toLowerCase(), when: rest };
}

// The file's items: { id?, heading, done, text, meta: { where, why, reply } }, from list items (with their
// indented lines) and, for notes, paragraphs. The intro before the first "##" heading and HTML comments are skipped.
function markdownItems(text, { checkboxes }) {
  const out = [];
  let heading = null;
  let cur = null;
  let para = null;
  let inComment = false;
  const flush = () => {
    if (cur) out.push(cur);
    if (para) out.push(para);
    cur = null;
    para = null;
  };
  for (const raw of String(text || '').replace(/\r\n/g, '\n').split('\n')) {
    let line = raw;
    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (line.trim().startsWith('<!--')) {
      if (!line.includes('-->')) inComment = true;
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flush();
      if (h[1].length >= 2) heading = h[2].trim();
      continue;
    }
    if (heading === null && !checkboxes) continue; // the notes file's intro (a handoff file's items may come before any heading)
    const box = line.match(/^[-*]\s+\[([ xX])\]\s+(.*)$/);
    const bullet = line.match(/^(?:[-*]|\d+[.)])\s+(.*)$/);
    if (checkboxes ? box : bullet) {
      flush();
      const body = checkboxes ? box[2] : bullet[1];
      const id = (body.match(/^\*\*([NH]\d+)\*\*\s*/) || [])[1] || '';
      let rest = body.replace(/^\*\*[NH]\d+\*\*\s*/, '');
      const tags = (!checkboxes && id && rest.match(/^\(([^)]*)\)\s*/)) || null;
      if (tags) rest = rest.slice(tags[0].length);
      cur = { id, heading, done: checkboxes ? box[1] !== ' ' : false, tags: tags ? tags[1] : '', lines: [rest], meta: {}, more: [], thread: [], entry: null };
      continue;
    }
    if (cur && /^\s+\S/.test(line)) {
      // (FR-014) a handoff card's conversation: "- The owner replied <time>:" or "- The team answered <time>:", then its
      // text as a quoted block; quoted lines right under the item are the rest of its request
      const quote = checkboxes && line.match(/^\s+>\s?(.*)$/);
      if (quote) {
        (cur.entry ? cur.entry.lines : cur.more).push(quote[1]);
        continue;
      }
      const said = checkboxes && threadHead(line.trim());
      if (said) {
        cur.entry = { ...said, lines: [] };
        cur.thread.push(cur.entry);
        continue;
      }
      cur.entry = null;
      // its fields: "- Where: ..." (as nextlevel writes them), or "Where: ..." on a line of its own
      const labels = 'Where|Why|Reply|Replied|Added|Asked|Seen|Done|Declined|Withdrawn|Removed|Edited|Switched off|Cancelled|Closed|Reopened';
      const sub = line.trim().match(new RegExp(`^[-*]\\s+(${labels})\\b:?\\s*(.*)$`, 'i')) || line.trim().match(new RegExp(`^(${labels}):\\s*(.*)$`, 'i'));
      if (sub) {
        const key = sub[1].toLowerCase();
        if (['where', 'why', 'reply'].includes(key)) cur.meta[key] = sub[2].replace(/^"(.*)"(\s*\(.*\))?$/, '$1').trim();
        else if (['done', 'declined'].includes(key)) cur.meta.handled = sub[2].replace(/^[\d-]+ [\d:]+:?\s*/, '').trim();
        else if (key === 'cancelled') cur.meta.cancelled = sub[2].replace(/^[\d-]+ [\d:]+:?\s*/, '').trim() || 'no longer needed';
      } else if (!checkboxes || !/^\s*[-*]\s/.test(line)) cur.lines.push(line.trim());
      else cur.lines.push(line.trim().replace(/^[-*]\s+/, ''));
      continue;
    }
    if (!line.trim()) {
      if (para) flush();
      continue;
    }
    if (!checkboxes && !cur) {
      para ||= { id: '', heading, done: false, tags: '', lines: [], meta: {} };
      para.lines.push(line.trim());
      continue;
    }
    if (cur) {
      // a line that isn't indented ends the item; for notes it starts a paragraph
      flush();
      if (!checkboxes) para = { id: '', heading, done: false, tags: '', lines: [line.trim()], meta: {} };
    }
  }
  flush();
  return out
    .map((x) => ({ ...x, text: [...x.lines, ...(x.more || [])].join('\n').trim() }))
    .filter((x) => x.text && !/^\(?(none|nothing)( yet)?\.?\)?\.?$/i.test(x.text) && !/^_?none\._?$/i.test(x.text));
}

const DONE_HEADING = /^(done|history|handled|declined|closed|finished)\b/i;
const RULE_HEADING = /\brules?\b|\bstanding\b|\balways\b/i;

// Notes from OWNER_NOTES.md: under a "Done"/"History" heading handled, under a "rules" heading standing rules,
// anything else a new one-time note. A file nextlevel wrote keeps its ids and states.
function notesFromMarkdown(text) {
  return markdownItems(text, { checkboxes: false }).map((x) => {
    const tags = x.tags.split(',').map((t) => t.trim().toLowerCase());
    const type = tags.includes('rule') || (!x.tags && RULE_HEADING.test(x.heading)) ? 'rule' : 'once';
    const known = ['new', 'seen', 'done', 'declined', 'withdrawn', 'removed', 'off'].find((t) => tags.includes(t));
    let status = known || (DONE_HEADING.test(x.heading) ? 'done' : 'new');
    const off = status === 'off';
    if (off) status = 'seen';
    if (type === 'rule' && status === 'done') status = 'seen';
    return { id: x.id && x.id.startsWith('N') ? x.id : '', type, text: x.text, status, off, reply: x.meta.handled || '' };
  });
}
// Handoff items from HANDOFF.md: "- [ ]" open, "- [x]" done; "Where:" and "Why:" lines under one are its fields, and
// its conversation the quoted replies and answers (or a "Reply:" line, as nextlevel wrote it before FR-014).
const fromWhen = (s) => {
  const d = new Date(String(s || '').replace(' ', 'T'));
  return s && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};
function handoffFromMarkdown(text) {
  return markdownItems(text, { checkboxes: true }).map((x) => {
    const thread = (x.thread || []).map((e) => ({ by: e.by === 'team' ? 'team' : 'owner', text: cleanText(e.lines.join('\n')), at: fromWhen(e.when) })).filter((e) => e.text.trim());
    if (!thread.length && x.meta.reply) thread.push({ by: 'owner', text: x.meta.reply, at: null });
    return {
      id: x.id && x.id.startsWith('H') ? x.id : '',
      what: x.text,
      where: x.meta.where || '',
      why: x.meta.why || '',
      thread,
      // (a "- Cancelled <time>: why" line, as nextlevel writes a cancelled item)
      status: x.done ? ((DONE_HEADING.test(x.heading) && /cancel/i.test(x.heading)) || x.meta.cancelled ? 'cancelled' : 'done') : 'open',
      note: x.meta.cancelled || '',
    };
  });
}

// ---------- writing the Markdown ----------
const indent = (text) => String(text).split('\n').map((l, i) => (i ? `  ${l}` : l)).join('\n');
const links = (x) => [x.commit ? `commit ${x.commit}` : '', x.task ? `task ${x.task}` : ''].filter(Boolean).join(', ');

export function notesMarkdown(items, { store = '.nextlevel/notes.json' } = {}) {
  const { rules, open, history } = noteGroups(items);
  const item = (n) => {
    const tags = [n.type === 'rule' ? 'rule' : 'one-time', n.off ? 'off' : n.status].join(', ');
    const meta = [`Added ${when(n.createdAt)}${n.editedAt ? `, edited ${when(n.editedAt)}` : ''}${n.seenAt ? ` · seen by the orchestrator ${when(n.seenAt)}` : ''}`];
    if (n.status === 'done') meta.push(`Done ${when(n.handledAt)}${n.reply ? `: ${n.reply}` : ''}${links(n) ? ` (${links(n)})` : ''}`);
    if (n.status === 'declined') meta.push(`Declined ${when(n.handledAt)}${n.reply ? `: ${n.reply}` : ''}`);
    if (n.status === 'withdrawn') meta.push(`Withdrawn ${when(n.handledAt)} by the owner`);
    if (n.status === 'removed') meta.push(`Removed ${when(n.handledAt)} by the owner`);
    if (n.off) meta.push('Switched off by the owner: not followed until it is switched on');
    return `- **${n.id}** (${tags}) ${indent(n.text)}\n${meta.map((m) => `  - ${m}`).join('\n')}`;
  };
  const section = (title, list) => [`## ${title}`, '', list.length ? list.map(item).join('\n') : '_None._', ''];
  return [
    '# Owner notes',
    '',
    `<!-- Written by nextlevel from ${store}: don't edit it by hand, it is written again after every change.`,
    '     The owner adds, edits and withdraws notes on the dashboard\'s Notes page (or: nextlevel note add "...").',
    '     The orchestrator reads them with nextlevel note list and answers with nextlevel note seen, done or decline. -->',
    '',
    ...section('Standing rules', rules),
    ...section('To do', open),
    ...section('History', history),
  ].join('\n').replace(/\n+$/, '\n');
}

// A text as a quoted block, `pad` in (FR-014): its own headings, lists, code fences or HTML stay inside the quote, so a
// reply or an answer can't break the file (or add an item to it when it is read back)
const quoted = (text, pad) => String(text).split('\n').map((l) => `${pad}>${l ? ` ${l}` : ''}`).join('\n');

export function handoffMarkdown(items, { store = '.nextlevel/handoff.json' } = {}) {
  const open = items.filter((x) => x.status === 'open');
  const done = items.filter((x) => x.status !== 'open').sort((a, b) => String(b.doneAt || b.updatedAt).localeCompare(String(a.doneAt || a.updatedAt)));
  const item = (x) => {
    const [first, ...rest] = String(x.what).split('\n');
    const more = rest.join('\n').trim();
    const out = [`- [${x.status === 'open' ? ' ' : 'x'}] **${x.id}** ${first}`, ...(more ? ['', quoted(more, '  '), ''] : [])];
    if (x.where) out.push(`  - Where: ${x.where}`);
    if (x.why) out.push(`  - Why: ${x.why}`);
    out.push(`  - Asked ${when(x.createdAt)}${x.task ? ` (task ${x.task})` : ''}`);
    // (the replies and answers, and the card's closings and reopenings, in time order: undo Done, FR-018)
    for (const e of conversation(x)) {
      if (e.text !== undefined) out.push(`  - The ${e.by === 'team' ? 'team answered' : 'owner replied'} ${when(e.at)}:`, '', quoted(e.text, '    '), '');
      else out.push(`  - ${eventWords(e, when)}`);
    }
    return out.join('\n');
  };
  return [
    '# Handoff: steps only the owner can do',
    '',
    `<!-- Written by nextlevel from ${store}: don't edit it by hand, it is written again after every change.`,
    '     The team asks the owner with nextlevel handoff add --file <request> and answers on a card with nextlevel',
    '     handoff answer <id> --file <answer>; the owner marks it done, or replies, on the dashboard\'s Notes page (or:',
    '     nextlevel handoff done <id>). Replies and answers are quoted whole, as they were written. -->',
    '',
    '## Open',
    '',
    open.length ? open.map(item).join('\n') : '_None._',
    '',
    '## Done',
    '',
    done.length ? done.map(item).join('\n') : '_None._',
    '',
  ].join('\n');
}

// ---------- the stores ----------
const KINDS = {
  notes: { file: 'notes.json', prefix: 'N', parse: notesFromMarkdown, markdown: notesMarkdown, key: (x) => norm(x.text) },
  handoff: { file: 'handoff.json', prefix: 'H', parse: handoffFromMarkdown, markdown: handoffMarkdown, key: (x) => norm(x.what) },
};

// An item from the Markdown, as the store keeps it.
function fromParsed(kind, x, id, at) {
  if (kind === 'notes') {
    const handled = ['done', 'declined', 'withdrawn', 'removed'].includes(x.status);
    return { id, type: x.type, text: x.text, status: x.status, off: !!x.off, createdAt: at, updatedAt: at, editedAt: null, seenAt: x.status === 'seen' ? at : null, handledAt: handled ? at : null, reply: x.reply || '', commit: '', task: '', from: 'markdown' };
  }
  // seen as it is: an item ticked by hand later is news for the orchestrator (its doneAt comes after this)
  const thread = (x.thread || []).map((e) => ({ by: e.by, text: e.text, at: e.at || at }));
  const last = (by) => thread.filter((e) => e.by === by).at(-1);
  return { id, what: x.what, where: x.where, why: x.why, task: '', status: x.status, createdAt: at, updatedAt: at, doneAt: x.status === 'open' ? null : at, thread, reply: last('owner')?.text || '', repliedAt: last('owner')?.at || null, answeredAt: last('team')?.at || null, readAt: null, seenAt: at, note: x.status === 'cancelled' ? x.note || '' : '', from: 'markdown' };
}

// ---------- a handoff card's conversation (FR-014) ----------
const ms = (iso) => Date.parse(iso || '') || 0;
// Its replies and answers in time order. A card saved before FR-014 kept only the owner's last reply, and an older
// nextlevel still writes only that: such a reply joins the thread where its time puts it.
export function threadOf(x) {
  const list = Array.isArray(x.thread) ? x.thread.filter((e) => e && typeof e.text === 'string').map((e) => ({ by: e.by === 'team' ? 'team' : 'owner', text: e.text, at: e.at || null })) : [];
  if (x.reply && !list.some((e) => e.by === 'owner' && e.text === x.reply)) {
    const entry = { by: 'owner', text: x.reply, at: x.repliedAt || x.updatedAt || x.createdAt || null };
    const i = list.findIndex((e) => ms(e.at) > ms(entry.at));
    list.splice(i < 0 ? list.length : i, 0, entry);
  }
  return list;
}
// A card's closings and reopenings (undo Done, FR-018), oldest first. A card closed before them has none kept: its one
// closing is read from its state (a done card's the owner's, as every one was then, unless `closedBy` says the team's).
const EVENT_KINDS = new Set(['done', 'closed', 'cancelled', 'reopened']);
const HOW = new Set(['dashboard', 'terminal', 'reply']);
const BY = new Set(['owner', 'team', 'hub']);
export function eventsOf(x) {
  const list = Array.isArray(x.events)
    ? x.events.filter((e) => e && EVENT_KINDS.has(e.kind)).map((e) => ({ kind: e.kind, by: BY.has(e.by) ? e.by : 'owner', how: HOW.has(e.how) ? e.how : '', note: typeof e.note === 'string' ? e.note : '', at: e.at || null }))
    : [];
  // (a held change's card the hub closed itself: "Closed by nextlevel", never "Done by you")
  // (and a card closed again by an older version, or ticked in the Markdown, after a reopening: its closing from its state)
  const unsaid = x.status !== 'open' && (!list.length || list.at(-1).kind === 'reopened');
  if (unsaid && x.status === 'done') list.push({ kind: x.closedBy === 'team' ? 'closed' : 'done', by: BY.has(x.closedBy) ? x.closedBy : 'owner', how: '', note: x.closedBy === 'team' ? x.note || '' : '', at: x.doneAt || null });
  if (unsaid && x.status === 'cancelled') list.push({ kind: 'cancelled', by: 'team', how: '', note: x.note || '', at: x.doneAt || null });
  return list;
}
// The thread's messages and the card's events in one list, by time (an event at the same time as a message after it)
export function conversation(x) {
  const all = [...threadOf(x).map((e, i) => ({ ...e, i, k: 0 })), ...eventsOf(x).map((e, i) => ({ ...e, i, k: 1 }))];
  return all.sort((a, b) => ms(a.at) - ms(b.at) || a.k - b.k || a.i - b.i).map(({ i, k, ...e }) => e);
}
// An event in the Markdown's and the terminal's words. `when(iso)`: the time as the reader says it.
export function eventWords(e, at = when) {
  const t = at(e.at);
  if (e.kind === 'done') return e.by === 'hub' ? `Closed by nextlevel ${t}` : `Done ${t} by the owner`;
  if (e.kind === 'closed') return `Closed by the team ${t}${e.note ? `: ${e.note}` : ''}`;
  if (e.kind === 'cancelled') return `Cancelled ${t}: ${e.note || 'no longer needed'}`;
  return `Reopened ${t} by the owner${e.how === 'reply' ? ' (by a reply)' : e.how === 'terminal' ? ' (from the terminal)' : ''}`;
}
// The team answered after the owner's last reply, and after the owner marked the card done or read the answer
export const unreadAnswer = (x) => x.status !== 'cancelled' && !!x.answeredAt && ms(x.answeredAt) > Math.max(ms(x.repliedAt), x.status === 'done' ? ms(x.doneAt) : 0, ms(x.readAt));
// What waits for the owner: an open card, or one the team answered since the owner last replied or marked it done
export const awaitsOwner = (x) => x.status === 'open' || (!x.guard && unreadAnswer(x));
export const firstLine = (s) => String(s ?? '').split('\n')[0].trim();

// The project's stores. `stateDir`: .nextlevel/; `files`: { notes, handoff } Markdown paths from the
// project's top folder.
// onLock: what the lock met on the way (lib/filelock.mjs), for a caller that logs it
export function cardStore({ root, stateDir, files, onLock }) {
  const jsonFile = (kind) => path.join(stateDir, KINDS[kind].file);
  const mdFile = (kind) => path.join(root, files[kind]);
  const storeName = (kind) => path.relative(root, jsonFile(kind)).split(path.sep).join('/');

  // The store as it is, with the Markdown's own items when it was never saved, or with lines added to the
  // file by hand since nextlevel wrote it. { data, changed }
  function load(kind) {
    const k = KINDS[kind];
    const saved = readJson(jsonFile(kind));
    const data = saved && Array.isArray(saved.items) ? { version: VERSION, next: 1, generated: '', ...saved } : { version: VERSION, next: 1, generated: '', items: [] };
    if (kind === 'handoff') for (const x of data.items) x.thread = threadOf(x);
    const md = readText(mdFile(kind));
    if (md === null || (saved && hash(md) === data.generated)) return { data, changed: false };
    let changed = !saved;
    const at = now();
    const byId = new Map(data.items.map((x) => [x.id, x]));
    const byKey = new Map(data.items.map((x) => [k.key(x), x]));
    const nextNumber = () => Math.max(data.next || 1, ...data.items.map((x) => Number(x.id.slice(1)) + 1 || 1));
    for (const x of k.parse(md)) {
      const known = (x.id && byId.get(x.id)) || byKey.get(k.key(x));
      if (known) {
        // a ticked item is done; nothing else a hand edit says is taken over (and a held change's card is decided on
        // the dashboard only: a tick in the file never approves anything)
        if (kind === 'handoff' && known.status === 'open' && x.status === 'done' && !known.guard) {
          Object.assign(known, { status: 'done', doneAt: at, updatedAt: at });
          acted(data, `you ticked ${known.id} in ${files.handoff}`, at);
          changed = true;
        }
        continue;
      }
      const id = !saved && x.id && !byId.has(x.id) ? x.id : `${k.prefix}${nextNumber()}`;
      // imported first: its state as the file says; added by hand later: a new item
      const item = fromParsed(kind, saved ? { ...x, status: kind === 'notes' ? 'new' : x.status === 'done' ? 'done' : 'open', off: false } : x, id, at);
      data.items.push(item);
      byId.set(id, item);
      byKey.set(k.key(item), item);
      data.next = Math.max(nextNumber(), Number(id.slice(1)) + 1);
      // (a note typed into the file is the owner's; a "- [ ]" line there is a team's on an older role doc)
      if (saved && kind === 'notes') acted(data, `your note ${id}, typed into ${files.notes}`, at);
      changed = true;
    }
    return { data, changed };
  }
  // The owner did something on this store (FR-019): autopilot starts a round for it
  const acted = (data, what, at) => {
    data.owner = { n: (data.owner?.n || 0) + 1, at, what };
  };

  // Change a store: `fn(data)` changes it and returns what the caller gets back; the store and its Markdown are
  // written after it (the Markdown only when it would change).
  // One writer at a time across processes (the dashboard, the owner's window, the orchestrator's commands): the lock of
  // lib/filelock.mjs (cards.lock), whose holder is told by its pid and start time. A change is written only while the
  // lock is still this call's; one whose lock was taken over (its holder kept it too long) is made again on the store as
  // it is then, so the owner's actions it counts are never lost to another writer.
  function change(kind, fn) {
    for (let attempt = 1; ; attempt++) {
      let wrote = false;
      const result = withFileLock(
        path.join(stateDir, 'cards'),
        (stillMine) => {
          const { data } = load(kind);
          // (a Done past its Undo becomes final first, in the same write as this change: never lost to it)
          if (kind === 'handoff') settleIn(data);
          const r = fn(data);
          data.next = Math.max(data.next || 1, ...data.items.map((x) => Number(x.id.slice(1)) + 1 || 1));
          const md = KINDS[kind].markdown(data.items, { store: storeName(kind) });
          if (attempt < 3 && !stillMine()) return r;
          if (readText(mdFile(kind)) !== md) writeAtomic(mdFile(kind), md);
          data.generated = hash(md);
          writeAtomic(jsonFile(kind), `${JSON.stringify(data, null, 2)}\n`);
          wrote = true;
          return r;
        },
        { onLock },
      );
      if (wrote) {
        if (attempt >= 3) onLock?.({ lost: true, forced: true, why: `its lock was taken over ${attempt - 1} times before it wrote: this time it wrote without looking` });
        return result;
      }
      onLock?.({ lost: true, why: 'its lock was taken over before it wrote: the change is made again on the store as it is now' });
    }
  }
  const find = (data, id) => {
    const x = data.items.find((i) => i.id.toLowerCase() === String(id || '').trim().toLowerCase());
    if (!x) throw new Error(`there is no ${id ? `"${id}"` : 'such item'} (nextlevel ${data.items[0]?.id?.startsWith('H') ? 'handoff' : 'note'} list --all shows them all)`);
    return x;
  };
  // The hub's own words on a held change's card (lib/guard.mjs has them whole)
  const oneLine = (s, what) => {
    const t = String(s ?? '').replace(/\s+/g, ' ').trim();
    if (!t) throw new Error(`${what} is empty`);
    return t.length > 400 ? `${t.slice(0, 399)}…` : t;
  };
  // The team's short fields (where, why, a reason) and its replies to notes: one line, whole. A longer one is refused,
  // saying so: they were cut to 400 characters with an ellipsis (FR-014: a real request lost its end).
  const line = (s, what) => {
    const t = cleanText(s).replace(/\s+/g, ' ').trim();
    if (!t) throw new Error(`${what} is empty`);
    if (t.length > MAX_LINE) throw new Error(`${what} has ${count(t.length)} characters, more than ${count(MAX_LINE)}: say it in fewer words (a long text goes in a file under docs/, named here)`);
    return t;
  };
  // A text kept whole with its line breaks (FR-014): a request, an owner's reply, a team's answer. A reply was saved cut
  // to 400 characters with an ellipsis, and FR-012's fix still joined its lines into one: a real reply lost its checklist.
  const whole = (s, what, max, hint) => {
    const t = cleanText(s);
    if (!t.trim()) throw new Error(`${what} is empty`);
    if (t.length > max) throw new Error(`${what} has ${count(t.length)} characters, more than ${count(max)}: ${hint}`);
    return t;
  };
  const request = (s) => whole(s, 'what the owner should do', MAX_REQUEST, 'put the details in a file under docs/ and name it in the request').replace(/^\s+/, '');
  const ownerText = (s) => whole(s, 'the reply', MAX_MESSAGE, 'split it into two replies');
  // (the owner's own words: a reply, as the owner wrote it; the owner's last reply stays in `reply`, for older readers)
  const ownerSays = (x, text, at) => {
    x.thread = threadOf(x);
    x.thread.push({ by: 'owner', text, at });
    Object.assign(x, { reply: text, repliedAt: at, updatedAt: at });
  };
  const textOf = (s) => {
    const t = String(s ?? '').replace(/\r\n/g, '\n').trim();
    if (!t) throw new Error('the note is empty');
    if (t.length > 4000) throw new Error('the note is longer than 4,000 characters: split it');
    return t;
  };

  const notes = {
    list: () => load('notes').data.items,
    add({ text, type = 'once' }) {
      return change('notes', (data) => {
        const at = now();
        const item = { id: `N${data.next}`, type: type === 'rule' ? 'rule' : 'once', text: textOf(text), status: 'new', off: false, createdAt: at, updatedAt: at, editedAt: null, seenAt: null, handledAt: null, reply: '', commit: '', task: '', from: 'owner' };
        data.items.push(item);
        data.next += 1;
        acted(data, `your new ${item.type === 'rule' ? 'rule' : 'note'} ${item.id}`, at);
        return item;
      });
    },
    // The owner's edit: the orchestrator reads it again (new), unless it was handled already
    edit(id, text) {
      return change('notes', (data) => {
        const n = find(data, id);
        if (!['new', 'seen'].includes(n.status)) throw new Error(`${n.id} is ${n.status} already: add a new note instead`);
        const at = now();
        Object.assign(n, { text: textOf(text), status: 'new', editedAt: at, updatedAt: at, seenAt: null });
        acted(data, `your change to ${n.id}`, at);
        return n;
      });
    },
    withdraw(id) {
      return change('notes', (data) => {
        const n = find(data, id);
        if (n.type === 'rule') throw new Error(`${n.id} is a standing rule: switch it off or remove it`);
        if (!['new', 'seen'].includes(n.status)) throw new Error(`${n.id} is ${n.status} already`);
        const at = now();
        acted(data, `you withdrew ${n.id}`, at);
        return Object.assign(n, { status: 'withdrawn', handledAt: at, updatedAt: at });
      });
    },
    setOff(id, off) {
      return change('notes', (data) => {
        const n = find(data, id);
        if (n.type !== 'rule') throw new Error(`${n.id} is a one-time note: only a standing rule is switched off (a note is withdrawn)`);
        if (n.status === 'removed') throw new Error(`${n.id} was removed`);
        const at = now();
        acted(data, `you switched ${n.id} ${off ? 'off' : 'on'}`, at);
        // switched on again: the orchestrator is told, as for a new rule
        return Object.assign(n, { off: !!off, updatedAt: at, ...(off ? {} : { status: 'new', seenAt: null }) });
      });
    },
    remove(id) {
      return change('notes', (data) => {
        const n = find(data, id);
        if (n.type !== 'rule') throw new Error(`${n.id} is a one-time note: withdraw it instead`);
        const at = now();
        acted(data, `you removed the rule ${n.id}`, at);
        return Object.assign(n, { status: 'removed', handledAt: at, updatedAt: at });
      });
    },
    // The orchestrator's answers
    seen(ids) {
      return change('notes', (data) => {
        const at = now();
        return ids.map((id) => {
          const n = find(data, id);
          if (n.status === 'new') Object.assign(n, { status: 'seen', seenAt: at, updatedAt: at });
          return n;
        });
      });
    },
    done(id, { reply, commit = '', task = '' }) {
      return change('notes', (data) => {
        const n = find(data, id);
        if (n.type === 'rule') throw new Error(`${n.id} is a standing rule: it stays until the owner removes it (nextlevel note seen ${n.id} says you follow it)`);
        if (!['new', 'seen'].includes(n.status)) throw new Error(`${n.id} is ${n.status} already`);
        const at = now();
        return Object.assign(n, { status: 'done', reply: line(reply, 'the reply'), commit, task, handledAt: at, updatedAt: at, seenAt: n.seenAt || at });
      });
    },
    decline(id, { reply }) {
      return change('notes', (data) => {
        const n = find(data, id);
        if (!['new', 'seen'].includes(n.status)) throw new Error(`${n.id} is ${n.status} already`);
        const at = now();
        return Object.assign(n, { status: 'declined', reply: line(reply, 'why'), handledAt: at, updatedAt: at, seenAt: n.seenAt || at });
      });
    },
  };

  // A held change's card (lib/guard.mjs) is decided with Approve or Reject on the dashboard, where its exact diff is:
  // never done, answered or cancelled here, from a command or from the phone.
  const guarded = (x) => {
    if (x.guard) throw new Error(`${x.id} is a change nextlevel holds (${x.guard}): the owner approves or rejects it on the dashboard (Notes and handoffs), where its exact diff is. It can't be done, answered or cancelled from here.`);
  };
  // (a reader past a Done's Undo sees it final, before anyone wrote it: settled in what it reads, never written here)
  const settled = () => {
    const { data } = load('handoff');
    settleIn(data);
    return data;
  };
  // A card's pending Done made final in a write of its own before another write on it, so that one being refused
  // (a cancel on a card now done) never takes the owner's Done back with it
  const settleFirst = (id) => {
    const x = load('handoff').data.items.find((i) => i.id.toLowerCase() === String(id || '').trim().toLowerCase());
    if (x?.pending) change('handoff', (data) => settleCard(data, find(data, id)));
  };
  const handoff = {
    list: () => settled().items,
    add({ what, where, why, task = '' }) {
      return change('handoff', (data) => {
        const at = now();
        const item = { id: `H${data.next}`, what: request(what), where: line(where, 'where'), why: line(why, 'why'), task, status: 'open', createdAt: at, updatedAt: at, doneAt: null, thread: [], reply: '', repliedAt: null, answeredAt: null, readAt: null, seenAt: at, note: '', from: 'team' };
        data.items.push(item);
        data.next += 1;
        return item;
      });
    },
    // The hub's card for a held change (`guard`: its id, G<n>); the orchestrator reads it like any item
    addGuard({ what, where, why, task = '', guard }) {
      return change('handoff', (data) => {
        const open = data.items.find((x) => x.guard === guard && x.status === 'open');
        if (open) return open;
        const at = now();
        const item = { id: `H${data.next}`, what: oneLine(what, 'what the owner should do'), where: oneLine(where, 'where'), why: oneLine(why, 'why'), task, status: 'open', createdAt: at, updatedAt: at, doneAt: null, thread: [], reply: '', repliedAt: null, answeredAt: null, readAt: null, seenAt: at, note: '', from: 'guard', guard };
        data.items.push(item);
        data.next += 1;
        return item;
      });
    },
    // The owner's decision on a held change, made on the dashboard (hub.mjs guardDecide): the card is done, with it.
    // `hub`: the hub closes the card itself (a push card a newer push made pointless): not the owner's doing.
    decideGuard(guard, { reply, hub = false }) {
      return change('handoff', (data) => {
        const at = now();
        const list = data.items
          .filter((x) => x.guard === guard && x.status === 'open')
          .map((x) => {
            ownerSays(x, oneLine(reply, 'the decision').slice(0, 1000), at);
            // (whose closing it was: the owner's Approve or Reject, or the hub's own, FR-018)
            return Object.assign(x, { status: 'done', doneAt: at, closedBy: hub ? 'hub' : 'owner' });
          });
        if (list.length && !hub) acted(data, `your decision on ${list.map((x) => x.id).join(', ')}`, at);
        return list;
      });
    },
    // The owner's side. Done on a card the team answered after it was done: the answer is read (the team isn't woken
    // for that, unless the owner says something with it). `delay` (the dashboard's Done, UNDO_MS): nothing changes but
    // `pending`, which becomes this Done once its time has passed, unless the owner undoes it first.
    done(id, { reply = '', delay = 0 } = {}) {
      if (!delay) settleFirst(id);
      return change('handoff', (data) => {
        const x = find(data, id);
        guarded(x);
        if (x.pending && delay > 0) throw new Error(`${x.id} is marked done already: Undo, or wait until it is final`);
        settleCard(data, x);
        const r = cleanText(reply);
        const said = r.trim() ? ownerText(r) : '';
        const at = now();
        if (!(x.status === 'done' && unreadAnswer(x)) && x.status !== 'open') throw new Error(`${x.id} is ${x.status} already`);
        if (delay > 0) {
          // (`was`: what the click was made on; it becomes final only on a card still in that state)
          x.pending = { action: 'done', was: x.status, reply: said, at, finalAt: new Date(ms(at) + delay).toISOString() };
          return x;
        }
        return markDone(data, x, said, at);
      });
    },
    // Undo a pending Done (only before its time: settled first, a Done past it is final and "too late")
    undo(id) {
      return change('handoff', (data) => {
        const x = find(data, id);
        if (!x.pending) throw new Error(x.status === 'open' ? `${x.id} has no Done to undo` : `Too late: ${x.id} is ${x.status} now. Reopen it if you need to.`);
        delete x.pending;
        return x;
      });
    },
    // Back to "The team needs from you", with its whole thread (`how`: dashboard, terminal, or reply: a reply on a
    // closed card reopens it first). What the team did since isn't undone: its next round is told the card is open again.
    reopen(id, { how = 'dashboard' } = {}) {
      settleFirst(id);
      return change('handoff', (data) => {
        const x = find(data, id);
        guarded(x);
        settleCard(data, x);
        if (x.status === 'open') throw new Error(`${x.id} is open`);
        const at = now();
        reopenIn(x, how, at);
        acted(data, `you reopened ${x.id}`, at);
        return x;
      });
    },
    reply(id, reply) {
      settleFirst(id);
      return change('handoff', (data) => {
        const x = find(data, id);
        guarded(x);
        settleCard(data, x);
        const said = ownerText(reply);
        const at = now();
        // (FR-018: a reply on a closed card is a follow-up the team must see: it reopens the card)
        const closed = x.status !== 'open';
        if (closed) reopenIn(x, 'reply', at);
        ownerSays(x, said, at);
        acted(data, closed ? `your reply on ${x.id}, which reopened it` : `your reply on ${x.id}`, at);
        return x;
      });
    },
    // The team's answer on a card (FR-014): whole, with its line breaks, after the owner's words; the owner reads it on
    // the card, which waits for the owner again until the owner replies or marks it done
    answer(id, text) {
      settleFirst(id);
      return change('handoff', (data) => {
        const x = find(data, id);
        guarded(x);
        // (an owner's pending Done is made final first: the answer then waits for the owner on a done card, FR-014)
        settleCard(data, x);
        if (x.status === 'cancelled') throw new Error(`${x.id} is cancelled: ask the owner with a new item (nextlevel handoff add --file <path>)`);
        const said = whole(text, 'the answer', MAX_MESSAGE, 'put the long part in a file under docs/, commit it, and name it in the answer');
        const at = now();
        x.thread = threadOf(x);
        x.thread.push({ by: 'team', text: said, at });
        // (answering is reading what the owner said so far)
        return Object.assign(x, { answeredAt: at, seenAt: at, updatedAt: at });
      });
    },
    // The team's side
    seen(ids) {
      return change('handoff', (data) => {
        const at = now();
        return ids.map((id) => Object.assign(find(data, id), { seenAt: at }));
      });
    },
    // Withdrawn: no longer needed, before the owner acted. On a card the owner replied to it is closed as resolved
    // instead (FR-018: "Cancelled" after the owner's "Deployed" read as abandoned), and `closedInstead` says so.
    cancel(id, { reply }) {
      settleFirst(id);
      return change('handoff', (data) => {
        const x = find(data, id);
        guarded(x);
        settleCard(data, x);
        if (x.status !== 'open') throw new Error(`${x.id} is ${x.status} already`);
        const at = now();
        if (threadOf(x).some((e) => e.by === 'owner')) return { ...closeIn(x, whole(reply, 'why', MAX_MESSAGE, 'put the long part in a file under docs/, commit it, and name it here'), at), closedInstead: true };
        const note = line(reply, 'why');
        x.events = [...eventsOf(x), { kind: 'cancelled', by: 'team', how: '', note, at }];
        return Object.assign(x, { status: 'cancelled', note, doneAt: at, updatedAt: at, seenAt: at });
      });
    },
    // Closed as resolved by the team (FR-018): the owner did it or answered, and nothing is left; with the team's note
    close(id, { note }) {
      settleFirst(id);
      return change('handoff', (data) => {
        const x = find(data, id);
        guarded(x);
        settleCard(data, x);
        if (x.status !== 'open') throw new Error(`${x.id} is ${x.status} already`);
        const said = whole(note, 'what resolved it', MAX_MESSAGE, 'put the long part in a file under docs/, commit it, and name it here');
        return closeIn(x, said, now());
      });
    },
    // Make every Done past its Undo final, in a write (the hub's tick, the dashboard): nothing is written when none is
    settle() {
      if (!load('handoff').data.items.some(due)) return [];
      return change('handoff', () => []);
    },
  };
  // (the store's own steps on a card, inside a change)
  function markDone(data, x, said, at) {
    if (x.status === 'done' && unreadAnswer(x)) {
      if (said) {
        ownerSays(x, said, at);
        acted(data, `your reply on ${x.id}`, at);
      }
      return Object.assign(x, { readAt: at, updatedAt: at });
    }
    if (x.status !== 'open') throw new Error(`${x.id} is ${x.status} already`);
    if (said) ownerSays(x, said, at);
    acted(data, said ? `your reply on ${x.id}, marked done` : `you marked ${x.id} done`, at);
    x.events = [...eventsOf(x), { kind: 'done', by: 'owner', how: '', note: '', at }];
    return Object.assign(x, { status: 'done', closedBy: 'owner', doneAt: at, updatedAt: at });
  }
  // (what the owner had read stays read: an answer read before Done isn't new again; the closing a card from before
  // these events had only in its state is written first, so the reopen never hides it)
  function reopenIn(x, how, at) {
    const h = HOW.has(how) ? how : 'dashboard';
    x.events = [...eventsOf(x), { kind: 'reopened', by: 'owner', how: h, note: '', at }];
    const readAt = Math.max(ms(x.readAt), ms(x.doneAt));
    delete x.closedBy;
    Object.assign(x, { status: 'open', doneAt: null, readAt: readAt ? new Date(readAt).toISOString() : null, note: '', reopenedAt: at, reopenedHow: h, updatedAt: at });
  }
  // Closed as resolved by the team: its words whole in the thread (FR-014's rule), the event and `note` their first line
  function closeIn(x, text, at) {
    const note = firstLine(text).slice(0, 400);
    x.thread = threadOf(x);
    x.thread.push({ by: 'team', text, at });
    x.events = [...eventsOf(x), { kind: 'closed', by: 'team', how: '', note, at }];
    return Object.assign(x, { status: 'done', closedBy: 'team', note, doneAt: at, updatedAt: at, seenAt: at });
  }
  // A pending Done whose time has come (by lib/clock.mjs)
  const due = (x) => !!x.pending && ms(x.pending.finalAt) <= clockNow();
  // Each due Done made as it would have been at the click's end: an owner's act, the Markdown written with the change.
  function settleIn(data) {
    for (const x of data.items.filter(due)) settleCard(data, x);
  }
  // A card's pending Done made final now, due or not (any write on the card but Undo does it first: the owner's click is
  // never lost, the team's words never hidden). Only on a card still as it was clicked; on any other (an older version
  // changed it after a Go back) the pending is dropped, its reply kept in the thread, nothing reopened.
  function settleCard(data, x) {
    if (!x.pending) return;
    const p = x.pending;
    delete x.pending;
    const reply = typeof p.reply === 'string' ? p.reply : '';
    const at = now();
    const was = p.was || 'open';
    if (x.status === was && (was === 'open' || unreadAnswer(x))) {
      markDone(data, x, reply, at);
      return;
    }
    if (reply.trim()) {
      ownerSays(x, reply, at);
      acted(data, `your reply on ${x.id}`, at);
    }
  }

  // Something the orchestrator hasn't answered or picked up: a new note or rule (on), a handoff item the owner
  // did or replied to since it last looked.
  const news = () => ({
    notes: notes.list().filter((n) => n.status === 'new' && !n.off).map((n) => n.id),
    handoff: handoff.list().filter((x) => x.status !== 'cancelled' && Math.max(ms(x.doneAt), ms(x.repliedAt), ms(x.reopenedAt)) > ms(x.seenAt)).map((x) => x.id),
  });
  // What the owner did on each store, as counted (FR-019): { notes: { n, at, what }, handoff: { n, at, what } }. Reading
  // never writes: a note typed into the Markdown counts from the first look on, and the same once it is saved.
  const ownerActs = () => ({ notes: load('notes').data.owner || { n: 0 }, handoff: settled().owner || { n: 0 } });
  // Changes whenever either store or its Markdown does (the dashboard reads the cards again)
  const stamp = () =>
    ['notes', 'handoff']
      .flatMap((kind) => [jsonFile(kind), mdFile(kind)])
      .map((f) => {
        try {
          const st = fs.statSync(f);
          return `${st.mtimeMs}:${st.size}`;
        } catch {
          return '-';
        }
      })
      .join('|');
  return { root, notes, handoff, news, ownerActs, stamp, files: { notes: files.notes, handoff: files.handoff }, store: { notes: storeName('notes'), handoff: storeName('handoff') } };
}

// Where a note is on the Notes page: standing rules (not removed), to do (one-time, new or seen), history.
export function noteGroups(items) {
  const rules = items.filter((n) => n.type === 'rule' && n.status !== 'removed');
  const open = items.filter((n) => n.type !== 'rule' && ['new', 'seen'].includes(n.status));
  const history = items.filter((n) => !rules.includes(n) && !open.includes(n)).sort((a, b) => String(b.handledAt || b.updatedAt).localeCompare(String(a.handledAt || a.updatedAt)));
  return { rules, open, history };
}
