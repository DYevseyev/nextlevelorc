// A strict subset of YAML, for the tester's acceptance plans (docs/design/tester.md §0, docs/acceptance.md): Node has no
// YAML reader, and nextlevel takes no dependency. What it reads:
//   - block mappings (`key: value`, `key:` with a block below) and block sequences (`- value`, `- key: value`);
//   - one-line flow mappings and sequences (`{ a: b, c: [x, y] }`), nested at most four deep;
//   - plain, "double-quoted" and 'single-quoted' scalars on one line; comments (`#` at a line's start or after a space).
// What it refuses, with the line: anchors and aliases (&, *), tags (!), block scalars (|, >), complex keys (?),
// directives (%), a second document, a flow collection or a quoted scalar across lines, a plain scalar that runs onto the
// next line, tabs in indentation, a duplicate key. So every file it reads means the same in any YAML 1.2 reader.
// Scalars stay strings, quoted or not: the plan's shape gives each its type (lib/acceptance.mjs), never
// YAML's guesses ("no", "on", "0x1F", "1e3" are what the field's type says). Each line is read once, left to right: time
// linear in the text's length. Pure.

export const MAX_LINE = 2000;
const MAX_DEPTH = 4; // flow collections nested in each other
const MAX_NODES = 20_000;
const REFUSED_START = {
  '&': 'anchors (&) are not in the subset: write the value out',
  '*': 'aliases (*) are not in the subset: write the value out',
  '!': 'tags (!) are not in the subset',
  '|': 'block scalars (|) are not in the subset: put the text on one line, in quotes',
  '>': 'folded scalars (>) are not in the subset: put the text on one line, in quotes',
  '%': 'directives (%) are not in the subset',
  '@': 'a plain value can\'t start with "@": put it in quotes',
  '`': 'a plain value can\'t start with "`": put it in quotes',
  '?': 'complex keys (?) are not in the subset',
};

class YamlProblem extends Error {
  constructor(line, message) {
    super(message);
    this.line = line;
  }
}

// -> { value, lineOf(node) } or { problem, line }. `plain(text)`: what a plain (unquoted) scalar becomes, a string by
// default; the plans mark them (lib/acceptance.mjs) so a JSON body's plain values take YAML 1.2's core types.
export function parseYamlSubset(text, { plain = (s) => s } = {}) {
  const lineOf = new WeakMap();
  try {
    const lines = splitLines(String(text ?? ''));
    const state = { lines, i: 0, nodes: 0, lineOf, plain };
    if (!lines.length) throw new YamlProblem(1, 'the file is empty');
    const value = parseBlock(state, lines[0].indent);
    if (state.i < lines.length) {
      const l = lines[state.i];
      throw new YamlProblem(l.n, l.indent > 0 ? 'unexpected indentation (a value can\'t go on over two lines in the subset)' : 'a second top-level value: one plan per file');
    }
    return { value, lineOf: (node) => (node && typeof node === 'object' ? lineOf.get(node) || 0 : 0) };
  } catch (err) {
    if (err instanceof YamlProblem) return { problem: err.message, line: err.line };
    throw err;
  }
}

// The lines that hold something: { n, indent, content } with comments taken off
function splitLines(text) {
  const raw = text.replace(/^﻿/, '').split('\n');
  const out = [];
  let docStart = false;
  for (let k = 0; k < raw.length; k++) {
    const n = k + 1;
    const line = raw[k].endsWith('\r') ? raw[k].slice(0, -1) : raw[k];
    if (line.length > MAX_LINE) throw new YamlProblem(n, `the line is longer than ${MAX_LINE} characters`);
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') indent++;
    if (line[indent] === '\t') throw new YamlProblem(n, 'a tab in the indentation: YAML indents with spaces');
    const content = stripComment(line.slice(indent), n).trimEnd();
    if (!content) continue;
    if (indent === 0 && /^---(\s|$)/.test(content)) {
      if (out.length || docStart || content.length > 3) throw new YamlProblem(n, 'one document per file: "---" only on the first line, alone');
      docStart = true;
      continue;
    }
    if (indent === 0 && /^\.\.\.(\s|$)/.test(content)) throw new YamlProblem(n, 'the end-of-document marker ("...") is not in the subset');
    if (content.startsWith('%')) throw new YamlProblem(n, REFUSED_START['%']);
    out.push({ n, indent, content });
  }
  return out;
}

// The text before a comment: a # at the start, or after a space, outside quotes
function stripComment(s, n) {
  let quote = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === '"') {
      if (c === '\\') i++;
      else if (c === '"') quote = '';
    } else if (quote === "'") {
      if (c === "'") {
        if (s[i + 1] === "'") i++;
        else quote = '';
      }
    } else if (c === '#' && (i === 0 || s[i - 1] === ' ' || s[i - 1] === '\t')) return s.slice(0, i);
    else if ((c === '"' || c === "'") && startsScalar(s, i)) quote = c;
  }
  if (quote) throw new YamlProblem(n, 'a quoted value isn\'t closed on its line (the subset has no quoted value across lines)');
  return s;
}
// A quote opens a quoted scalar only where a scalar starts (a line's start, after "- ", ": ", "[", "{" or ","); one inside
// a plain scalar (it's) is a plain character
function startsScalar(s, i) {
  let k = i - 1;
  while (k >= 0 && s[k] === ' ') k--;
  if (k < 0) return true;
  const c = s[k];
  if (c === '[' || c === '{' || c === ',') return true;
  if ((c === ':' || c === '-') && k < i - 1) return k === 0 || s[k - 1] === ' ' || c === ':';
  return false;
}

function count(state, line) {
  if (++state.nodes > MAX_NODES) throw new YamlProblem(line, `more than ${MAX_NODES} values: too big for a plan`);
}

const isSeqItem = (content) => content === '-' || content.startsWith('- ');

function parseBlock(state, indent) {
  const l = state.lines[state.i];
  return isSeqItem(l.content) ? parseSequence(state, indent) : parseMapping(state, indent);
}

function parseMapping(state, indent) {
  const map = {};
  state.lineOf.set(map, state.lines[state.i].n);
  count(state, state.lines[state.i].n);
  while (state.i < state.lines.length) {
    const l = state.lines[state.i];
    if (l.indent < indent) break;
    if (l.indent > indent) throw new YamlProblem(l.n, 'unexpected indentation (a value can\'t go on over two lines in the subset)');
    if (isSeqItem(l.content)) throw new YamlProblem(l.n, 'a list item where a "key: value" line was expected');
    const entry = splitEntry(l.content, l.n);
    if (!entry) throw new YamlProblem(l.n, `"${cut(l.content)}" isn't "key: value"`);
    if (Object.hasOwn(map, entry.key)) throw new YamlProblem(l.n, `"${entry.key}" twice in one mapping`);
    if (entry.key === '__proto__') throw new YamlProblem(l.n, '"__proto__" can\'t be a key');
    state.i++;
    let value;
    if (entry.rest) value = parseInline(state, entry.rest, l.n);
    else {
      const next = state.lines[state.i];
      if (next && next.indent > indent) value = parseBlock(state, next.indent);
      else if (next && next.indent === indent && isSeqItem(next.content)) value = parseSequence(state, indent);
      else value = null;
    }
    map[entry.key] = value;
  }
  return map;
}

function parseSequence(state, indent) {
  const list = [];
  state.lineOf.set(list, state.lines[state.i].n);
  count(state, state.lines[state.i].n);
  while (state.i < state.lines.length) {
    const l = state.lines[state.i];
    if (l.indent < indent) break;
    if (l.indent > indent) throw new YamlProblem(l.n, 'unexpected indentation (a value can\'t go on over two lines in the subset)');
    if (!isSeqItem(l.content)) break;
    let k = 1;
    while (k < l.content.length && l.content[k] === ' ') k++;
    const rest = l.content.slice(k);
    if (!rest) {
      state.i++;
      const next = state.lines[state.i];
      list.push(next && next.indent > indent ? parseBlock(state, next.indent) : null);
      continue;
    }
    const itemIndent = indent + k;
    if (isSeqItem(rest) || (!/^[[{]/.test(rest) && splitEntry(rest, l.n))) {
      // "- key: value" (a mapping) or "- - x" (a list) that starts on this line: read as if it began at its own column
      state.lines[state.i] = { n: l.n, indent: itemIndent, content: rest };
      list.push(parseBlock(state, itemIndent));
    } else {
      state.i++;
      list.push(parseInline(state, rest, l.n));
    }
  }
  return list;
}

// "key: rest" -> { key, rest } (rest '' when the value is below), or null when the line isn't one
function splitEntry(content, n) {
  let key;
  let at;
  if (content[0] === '"' || content[0] === "'") {
    const q = readQuoted(content, 0, n);
    key = q.value;
    at = q.end;
    while (content[at] === ' ') at++;
    if (content[at] !== ':') return null;
  } else {
    if (/^[[{]/.test(content)) return null;
    at = -1;
    for (let i = 0; i < content.length; i++) {
      if (content[i] === ':' && (i + 1 === content.length || content[i + 1] === ' ')) {
        at = i;
        break;
      }
    }
    if (at <= 0) return null;
    key = content.slice(0, at).trimEnd();
    plainProblem(key, n, 'key');
  }
  const rest = content.slice(at + 1).trim();
  return { key, rest };
}

function parseInline(state, s, n) {
  count(state, n);
  if (s[0] === '{' || s[0] === '[') {
    const r = parseFlow(state, s, 0, n, 1);
    let end = r.end;
    while (s[end] === ' ') end++;
    if (end < s.length) throw new YamlProblem(n, `"${cut(s.slice(end))}" after the closing bracket`);
    return r.value;
  }
  if (s[0] === '"' || s[0] === "'") {
    const q = readQuoted(s, 0, n);
    if (s.slice(q.end).trim()) throw new YamlProblem(n, `"${cut(s.slice(q.end).trim())}" after a quoted value`);
    return q.value;
  }
  if (s.includes(': ') || s.endsWith(':')) throw new YamlProblem(n, `"${cut(s)}": a value with ": " in it goes in quotes`);
  plainProblem(s, n, 'value');
  return state.plain(s);
}

function plainProblem(s, n, what) {
  const c = s[0];
  if (REFUSED_START[c]) throw new YamlProblem(n, REFUSED_START[c]);
  if (c === '-' && (s.length === 1 || s[1] === ' ')) throw new YamlProblem(n, `a ${what} can't be "-" alone: put it in quotes`);
  if (c === ':' || c === ',' || c === ']' || c === '}' || c === '#') throw new YamlProblem(n, `a plain ${what} can't start with "${c}": put it in quotes`);
}

// A flow collection from s[i] ('{' or '['): -> { value, end }
function parseFlow(state, s, i, n, depth) {
  if (depth > MAX_DEPTH) throw new YamlProblem(n, `flow collections nested more than ${MAX_DEPTH} deep`);
  const open = s[i];
  const close = open === '{' ? '}' : ']';
  const out = open === '{' ? {} : [];
  state.lineOf.set(out, n);
  count(state, n);
  let k = i + 1;
  const skip = () => {
    while (s[k] === ' ') k++;
  };
  skip();
  if (s[k] === close) return { value: out, end: k + 1 };
  for (;;) {
    skip();
    if (k >= s.length) throw new YamlProblem(n, `"${open}" isn't closed on its line`);
    if (open === '{') {
      let key;
      if (s[k] === '"' || s[k] === "'") {
        const q = readQuoted(s, k, n);
        key = q.value;
        k = q.end;
        skip();
        if (s[k] !== ':') throw new YamlProblem(n, `":" expected after the key "${cut(key)}"`);
      } else {
        const start = k;
        while (k < s.length && !(s[k] === ':' && (s[k + 1] === ' ' || s[k + 1] === ',' || s[k + 1] === '}' || k + 1 === s.length)) && !',{}[]'.includes(s[k])) k++;
        key = s.slice(start, k).trimEnd();
        if (s[k] !== ':' || !key) throw new YamlProblem(n, `"key: value" expected in "{ }", at "${cut(s.slice(start))}"`);
        plainProblem(key, n, 'key');
      }
      if (Object.hasOwn(out, key)) throw new YamlProblem(n, `"${key}" twice in one mapping`);
      if (key === '__proto__') throw new YamlProblem(n, '"__proto__" can\'t be a key');
      k++; // the colon
      skip();
      const v = flowValue(state, s, k, n, depth, close);
      out[key] = v.value;
      k = v.end;
    } else {
      const v = flowValue(state, s, k, n, depth, close);
      if (v.pair) throw new YamlProblem(n, 'a "key: value" inside "[ ]": write it as "{ key: value }"');
      out.push(v.value);
      k = v.end;
    }
    skip();
    if (s[k] === ',') {
      k++;
      skip();
      if (s[k] === close || s[k] === ',') throw new YamlProblem(n, `an empty entry in "${open} ${close}"`);
      continue;
    }
    if (s[k] === close) return { value: out, end: k + 1 };
    throw new YamlProblem(n, `"," or "${close}" expected at "${cut(s.slice(k))}"`);
  }
}

function flowValue(state, s, k, n, depth, close) {
  if (s[k] === '{' || s[k] === '[') return parseFlow(state, s, k, n, depth + 1);
  if (s[k] === '"' || s[k] === "'") {
    count(state, n);
    const q = readQuoted(s, k, n);
    return { value: q.value, end: q.end };
  }
  const start = k;
  while (k < s.length && !',{}[]'.includes(s[k])) k++;
  const v = s.slice(start, k).trimEnd();
  if (!v) {
    if (s[k] === ',' || s[k] === close) return { value: null, end: k }; // "{ a: }" is a: null
    throw new YamlProblem(n, `a value expected at "${cut(s.slice(start))}"`);
  }
  count(state, n);
  const colon = v.indexOf(': ');
  if (colon >= 0 || v.endsWith(':')) return { value: v, end: k, pair: true };
  plainProblem(v, n, 'value');
  return { value: state.plain(v), end: k };
}

// A quoted scalar from s[i]: -> { value, end }
function readQuoted(s, i, n) {
  const q = s[i];
  let out = '';
  let k = i + 1;
  if (q === "'") {
    for (; k < s.length; k++) {
      if (s[k] === "'") {
        if (s[k + 1] === "'") {
          out += "'";
          k++;
        } else return { value: out, end: k + 1 };
      } else out += s[k];
    }
    throw new YamlProblem(n, 'a quoted value isn\'t closed on its line');
  }
  const ESC = { '\\': '\\', '"': '"', '/': '/', n: '\n', t: '\t', r: '\r', 0: '\0', ' ': ' ' };
  for (; k < s.length; k++) {
    const c = s[k];
    if (c === '"') return { value: out, end: k + 1 };
    if (c !== '\\') {
      out += c;
      continue;
    }
    const e = s[++k];
    if (Object.hasOwn(ESC, e)) out += ESC[e];
    else if (e === 'x' || e === 'u') {
      const len = e === 'x' ? 2 : 4;
      const hex = s.slice(k + 1, k + 1 + len);
      if (hex.length !== len || !/^[0-9a-fA-F]+$/.test(hex)) throw new YamlProblem(n, `"\\${e}" needs ${len} hex digits`);
      out += String.fromCharCode(parseInt(hex, 16));
      k += len;
    } else throw new YamlProblem(n, `"\\${e ?? ''}" is not an escape the subset knows (\\\\, \\", \\n, \\t, \\r, \\xXX, \\uXXXX)`);
  }
  throw new YamlProblem(n, 'a quoted value isn\'t closed on its line');
}

const cut = (s) => (String(s).length > 40 ? `${String(s).slice(0, 39)}…` : String(s));
