// Every place nextlevel starts a process (FR-010): each call of spawn, spawnSync, execFile, execFileSync, exec,
// execSync, fork and spawnBin in src/ and bin/, with the text of its arguments. test/lib.test.mjs checks each one
// says windowsHide: a process started in the background with a console of its own and no windowsHide gets a
// window on Windows (Windows Terminal, as the default terminal, even takes the focus).
import fs from 'node:fs';
import path from 'node:path';
import { REPO } from './helpers.mjs';

const CALL_RE = /(?<![.\w$])(spawn|spawnSync|execFile|execFileSync|exec|execSync|fork|spawnBin)\s*\(/g;

function files(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? files(p) : /\.m?js$/.test(e.name) ? [p] : [];
  });
}

// The text between a call's parentheses (strings, template strings, comments and regexes aside for the counting).
function argsText(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {
      i = src.indexOf('\n', i);
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

export function spawnSites(roots = ['src', 'bin']) {
  const out = [];
  for (const root of roots) {
    for (const file of files(path.join(REPO, root))) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(CALL_RE)) {
        const line = src.slice(0, m.index).split('\n').length;
        const lineText = src.split('\n')[line - 1];
        const before = src.slice(Math.max(0, m.index - 9), m.index);
        if (/function\s+$/.test(before) || /^\s*\/\//.test(lineText) || /^\s*\*/.test(lineText)) continue; // a definition or a comment
        if (/^\s*import\b/.test(lineText)) continue;
        out.push({ file: path.relative(REPO, file).replace(/\\/g, '/'), line, name: m[1], args: argsText(src, m.index + m[0].length - 1) });
      }
    }
  }
  return out;
}
