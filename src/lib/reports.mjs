// What the hub hands the orchestrator of a worker's report, its logs and the owner's notes (FR-012). On a real project, design
// tasks put their whole result in the report; `nextlevel result` printed its first 200 lines and said nothing of the
// rest, so the orchestrator judged part of a design and sent it back (two tasks: three attempts each, verify
// passing every time). Now every attempt's report is kept whole in the job folder, what the hub prints for the
// orchestrator fits in what its engine shows of a command's output, and a part left out is said, with the full length
// and where the whole text is. Design, research and map tasks put their result in a file under docs/ that the spec
// names, committed with the task, and the hub checks that it is there. Pure functions.
import { isProtected } from './protect.mjs';

// What an orchestrator's engine shows of one command's output: Codex about 10 000 bytes and 256 lines (it cuts the
// middle of anything longer), Claude Code 30 000 characters. What nextlevel prints for the orchestrator stays under the
// smallest, so no engine cuts it without the hub saying so.
export const OUTPUT_BUDGET = { bytes: 9000, lines: 240 };

const norm = (t) => String(t ?? '').replace(/\r\n?/g, '\n');
const split = (t) => {
  const s = norm(t).replace(/\n$/, '');
  return s ? s.split('\n') : [];
};
export const byteLength = (s) => Buffer.byteLength(String(s ?? ''));
// A text's length as the notes say it: { lines, bytes }; "839 lines (48 KB)"
export const sizeOf = (text) => ({ lines: split(text).length, bytes: byteLength(text) });
export const sizeText = ({ lines, bytes }) => `${lines} line${lines === 1 ? '' : 's'} (${bytes < 1024 ? `${bytes} bytes` : `${Math.round(bytes / 1024)} KB`})`;

// A line too long for the room left: its start, and a mark that says it goes on
function cutLine(line, max) {
  const mark = ' … [this line goes on]';
  let out = '';
  for (const ch of line) {
    if (byteLength(out + ch) + byteLength(mark) > Math.max(max, 40)) break;
    out += ch;
  }
  return out + mark;
}

// Whole lines from line `from` (1-based) while they fit in `lines` and `bytes`; a first line that doesn't fit alone is
// cut in it, marked. { text, first, last, total, more }: `more` when lines after `last` were left out.
export function head(text, { from = 1, lines = Infinity, bytes = Infinity } = {}) {
  const all = split(text);
  const start = Math.max(1, Math.floor(from) || 1);
  const out = [];
  let used = 0;
  let i = start - 1;
  for (; i < all.length && out.length < lines; i++) {
    const add = byteLength(all[i]) + 1;
    if (used + add > bytes) {
      if (!out.length) {
        out.push(cutLine(all[i], bytes));
        i++;
      }
      break;
    }
    out.push(all[i]);
    used += add;
  }
  return { text: out.join('\n'), first: start, last: start + out.length - 1, total: all.length, more: i < all.length };
}

// The last lines that fit in `lines` and `bytes` (a last line that doesn't fit alone is cut, marked).
// { text, first, last, total, cut }: `cut` when lines before `first` were left out.
export function tail(text, { lines = Infinity, bytes = Infinity } = {}) {
  const all = split(text);
  const out = [];
  let used = 0;
  for (let i = all.length - 1; i >= 0 && out.length < lines; i--) {
    const add = byteLength(all[i]) + 1;
    if (used + add > bytes) {
      if (!out.length) out.unshift(cutLine(all[i], bytes));
      break;
    }
    out.unshift(all[i]);
    used += add;
  }
  return { text: out.join('\n'), first: all.length - out.length + 1, last: all.length, total: all.length, cut: out.length < all.length };
}

// A text cut to `max` characters, saying so: its full length and where the whole of it is ("N3 in docs/OWNER_NOTES.md").
// The owner's notes and replies, in what `nextlevel note list` and `handoff list` print (FR-012: they were cut to 110
// characters with only an ellipsis). `total`: the length of the text as it was written, when `text` is it made one line.
export function cutSaid(text, max, where, total) {
  const s = String(text ?? '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1)).trimEnd()}… [cut here: ${total ?? s.length} characters in all; the whole text: ${where}]`;
}

// ---------- the result file of design, research and map tasks ----------
// Their result goes in a file under docs/ that the spec names on a line "Result file: docs/design/<id>.md", committed
// with the task; the hub's verify checks that it is on the task's branch and not empty.
export const KINDS = ['code', 'review', 'research', 'design', 'map'];
export const RESULT_KINDS = new Set(['design', 'research', 'map']);
export const kindOf = (spec) => (String(spec ?? '').match(/^\s*Kind:\s*([a-z]+)\b/im) || [])[1]?.toLowerCase() || '';
export const resultFileOf = (spec) => (String(spec ?? '').match(/^\s*Result file:\s*`?([^`\s]+?)`?\s*$/im) || [])[1] || '';

// Why a result file can't be used, in words that follow its name ("is not under docs/"), or ''.
export function resultFileProblem(file, entries) {
  const p = String(file ?? '').replace(/\\/g, '/');
  if (!p) return 'is empty';
  if (/^[a-z]:/i.test(p) || p.startsWith('/')) return 'is not a path in the project (it must start with docs/)';
  if (p.split('/').includes('..')) return 'leads out of docs/ (..)';
  if (/[*?[\]{}]/.test(p)) return 'is a pattern: name one file';
  if (p.endsWith('/')) return 'is a folder: name one file in it';
  if (!/^docs\/[^/]/i.test(p)) return 'is not under docs/';
  if (isProtected(p, entries)) return 'is protected (a task never writes a protected file)';
  return '';
}
