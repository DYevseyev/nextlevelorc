// The owner's Ask threads (src/ask.mjs): one JSON file per thread in .nextlevel/chats/<id>.json,
// { id, title, createdAt, updatedAt, messages: [{ role: 'owner' | 'assistant', text, at, ... }] }. Ids are made here
// (letters and digits), never taken from a request, and every text is capped, so nothing a page sends picks a path
// or fills the disk. Written to a file of its own and renamed, so a reader never gets one half written.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CHAT_ID_RE = /^[a-z0-9]{8,32}$/;
export const LIMITS = { title: 120, question: 4000, answer: 64 * 1024, messages: 400 };
const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
export const titleOf = (question) => cut(oneLine(question), 60) || 'Untitled';

export function chatStore(dir) {
  const file = (id) => {
    if (!CHAT_ID_RE.test(String(id))) throw new Error(`no thread "${id}"`);
    return path.join(dir, `${id}.json`);
  };
  const read = (id) => {
    try {
      const v = JSON.parse(fs.readFileSync(file(id), 'utf8'));
      return v && typeof v === 'object' && Array.isArray(v.messages) ? v : null;
    } catch {
      return null;
    }
  };
  const save = (t) => {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file(t.id)}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(t, null, 2));
    fs.renameSync(tmp, file(t.id));
    return t;
  };
  const must = (id) => {
    const t = read(id);
    if (!t) throw new Error(`no thread "${id}"`);
    return t;
  };
  const now = () => new Date().toISOString();
  const summary = (t) => {
    const last = t.messages.at(-1);
    return { id: t.id, title: t.title, createdAt: t.createdAt, updatedAt: t.updatedAt, count: t.messages.length, last: last ? cut(oneLine(last.text), 140) : '' };
  };
  return {
    dir,
    get: (id) => (CHAT_ID_RE.test(String(id)) ? read(id) : null),
    // Threads, newest first; `search`: those whose title or messages hold it (any case), each with where it is
    list({ search = '' } = {}) {
      if (typeof search !== 'string') search = ''; // (a string given instead of { search } would bring String.prototype.search)
      let names = [];
      try {
        names = fs.readdirSync(dir).filter((f) => /^[a-z0-9]{8,32}\.json$/.test(f));
      } catch {
        return [];
      }
      const q = oneLine(search).toLowerCase().slice(0, 200);
      const out = [];
      for (const n of names) {
        const t = read(n.slice(0, -5));
        if (!t) continue;
        if (!q) {
          out.push(summary(t));
          continue;
        }
        const hit = [t.title, ...t.messages.map((m) => m.text)].map((x) => oneLine(x)).find((x) => x.toLowerCase().includes(q));
        if (hit) {
          const at = hit.toLowerCase().indexOf(q);
          out.push({ ...summary(t), match: cut(hit.slice(Math.max(0, at - 50)), 160) });
        }
      }
      return out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    },
    create(title) {
      const t = { id: crypto.randomBytes(8).toString('hex'), title: cut(oneLine(title), LIMITS.title) || 'Untitled', createdAt: now(), updatedAt: now(), messages: [] };
      return save(t);
    },
    append(id, message) {
      const t = must(id);
      const text = cut(message.text, message.role === 'owner' ? LIMITS.question : LIMITS.answer);
      t.messages = [...t.messages, { ...message, text, at: message.at || now() }].slice(-LIMITS.messages);
      t.updatedAt = now();
      return save(t);
    },
    rename(id, title) {
      const t = must(id);
      const next = cut(oneLine(title), LIMITS.title);
      if (!next) throw new Error('a title needs a word or two');
      return save({ ...t, title: next, updatedAt: now() });
    },
    clear(id) {
      const t = must(id);
      return save({ ...t, messages: [], updatedAt: now() });
    },
    remove(id) {
      must(id);
      fs.rmSync(file(id), { force: true });
    },
  };
}
