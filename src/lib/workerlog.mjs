// What a worker or an autopilot round printed, as its log keeps it (FR-010): written by nextlevel's own process in
// every mode (with no window, minimized or in a window), one line at a time, as plain text: terminal escape codes
// removed (colours, cursor moves, and window titles whole, since a title can hold a command line with a secret in
// it: agy's MCP servers put theirs there) and secrets redacted before anything is written. In a window of its own
// each line is shown there too, as a person reads it.
import fs from 'node:fs';

// Window titles and other OSC strings (ended by BEL or ST), CSI sequences (colours, cursor moves), other escapes
const OSC_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\|$)/g;
const CSI_RE = /\x1b\[[0-9;?<=>]*[ -/]*[@-~]/g;
const ESC_RE = /\x1b[@-Z\\-_]|\x1b[ -/]+[0-~]/g;
// Control characters but tab; a carriage return that doesn't end a line goes too (a spinner redraws the line)
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;
const PART = 1024 * 1024;
export const plainText = (s) => String(s ?? '').replace(OSC_RE, '').replace(CSI_RE, '').replace(ESC_RE, '').replace(/\r+(?=\n|$)/g, '').replace(CTRL_RE, '');

// A writer for one log file. `redact(text)`: the text as it may be kept (secrets out); `echo(line)`: also shows a
// line (in a window of its own), null when there is none. `feed(name, chunk)` takes a stream's output as it
// comes (lines split across chunks are joined); `line(text)` writes one line of nextlevel's own; `end()` writes
// what is left of each stream; `lastLine()` is the program's last line that isn't empty (redacted). The log gets
// the program's own lines; a window gets them as `show` turns them (null: not shown).
export function logWriter(file, { redact = (s) => s, echo = null, show = (line) => line } = {}) {
  const partial = new Map();
  let last = ''; // the program's last line that isn't empty: what a failure says
  const write = (lines, own = false) => {
    if (!lines.length) return;
    const clean = lines.map((l) => redact(plainText(l)));
    if (!own) last = clean.findLast((l) => l.trim()) ?? last;
    try {
      fs.appendFileSync(file, `${clean.join('\n')}\n`);
    } catch {
      // a log that can't be written must never stop the worker
    }
    if (echo) {
      for (const l of clean) {
        const shown = show(l);
        if (shown !== null && shown !== undefined) echo(shown);
      }
    }
  };
  return {
    line: (text) => write(String(text).split(/\r?\n/), true),
    lastLine: () => last,
    feed(name, chunk) {
      const text = (partial.get(name) || '') + chunk;
      const lines = text.split('\n');
      let rest = lines.pop();
      // a line that never ends is written in parts of a megabyte, not kept whole in memory
      while (rest.length > PART) {
        lines.push(rest.slice(0, PART));
        rest = rest.slice(PART);
      }
      partial.set(name, rest);
      write(lines);
    },
    end() {
      for (const rest of partial.values()) if (rest) write([rest]);
      partial.clear();
    },
  };
}
