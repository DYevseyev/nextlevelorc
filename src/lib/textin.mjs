// Free text for nextlevel's commands from a file or stdin, never from the command line (FR-014). On Windows the
// orchestrator runs nextlevel through nextlevel.cmd, and cmd.exe cuts an argument at its first line break and may change
// % ^ & ! and quotes in it; PowerShell 5.1 mangles the quotes on its way there. `--file <path>` reads the text as it is,
// line breaks and every character kept, from a file in the project folder; `--file -` reads it from stdin.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILE = 256 * 1024;

// A file's bytes as text: UTF-8 (a byte-order mark dropped); UTF-16 with its mark (what PowerShell 5.1's `>` and
// Out-File write); else Windows' code page 1252 (its Set-Content), when the bytes aren't UTF-8.
export function decodeText(buf) {
  const b = Buffer.from(buf);
  if (b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString('utf16le');
  if (b[0] === 0xfe && b[1] === 0xff) return Buffer.from(b.subarray(2, 2 + ((b.length - 2) & ~1))).swap16().toString('utf16le');
  const body = b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf ? b.subarray(3) : b;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    try {
      return new TextDecoder('windows-1252').decode(body);
    } catch {
      return body.toString('latin1');
    }
  }
}

// A text as it is kept: Windows line ends made plain, control characters out (a terminal would act on them), no blank
// lines or spaces around it. Everything else as it was.
export function cleanText(s) {
  return String(s ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .replace(/^\s*\n/, '')
    .trimEnd();
}

// A file that holds secrets: .env and its variants (not .env.example, which is committed)
const secretFile = (name) => {
  const n = String(name).toLowerCase();
  return (n === '.env' || n.startsWith('.env.')) && !['.env.example', '.env.sample', '.env.template'].includes(n);
};

// The text `--file` names. `root`: the project folder, where the file must be (through links too), outside .git and
// not a .env file; `-` reads stdin. It keeps a mistake from reading a file elsewhere, and .env out; it is no sandbox:
// whoever runs nextlevel can read what the account reads (a link swapped between the check and the read isn't caught).
export function readTextFile(file, { root, cwd = process.cwd(), stdin = () => fs.readFileSync(0) } = {}) {
  if (file === '-') {
    const buf = stdin();
    if (buf.length > MAX_FILE) throw new Error(`stdin brought ${Math.round(buf.length / 1024)} KB, more than ${MAX_FILE / 1024} KB: that is no text for a card`);
    return decodeText(buf);
  }
  if (typeof file !== 'string' || !file.trim()) throw new Error('--file needs a path: the file with the text (or --file - to read it from stdin)');
  const real = (p) => fs.realpathSync.native(p);
  let at;
  try {
    at = real(path.resolve(cwd, file));
  } catch {
    throw new Error(`there is no file ${file}: write the text to a file in the project folder first (for example .nextlevel/answer.md, which git ignores)`);
  }
  let top;
  try {
    top = real(root);
  } catch {
    top = path.resolve(root);
  }
  const rel = path.relative(top, at);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`${file} is outside the project folder: put the text in a file in it (for example .nextlevel/answer.md, which git ignores)`);
  const parts = rel.split(path.sep);
  if (parts[0].toLowerCase() === '.git') throw new Error(`${file} is in git's own folder: put the text in a file of its own (for example .nextlevel/answer.md)`);
  if (secretFile(parts.at(-1))) throw new Error(`${file} is a .env file: its values are secrets, and nextlevel never reads one into a text`);
  const st = fs.statSync(at);
  if (!st.isFile()) throw new Error(`${file} is not a file`);
  if (st.size > MAX_FILE) throw new Error(`${file} has ${Math.round(st.size / 1024)} KB, more than ${MAX_FILE / 1024} KB: that is no text for a card`);
  return decodeText(fs.readFileSync(at));
}
