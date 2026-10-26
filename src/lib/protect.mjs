// Protected paths: the files that steer the agents and the owner's tools outside any sandbox (Claude Code's hooks and
// settings, Codex's and Gemini's config, MCP servers, instruction files, VS Code tasks, GitHub workflows, git hooks
// kept in the project, npm's settings, nextlevel.json and START.cmd). The hub holds any change to one of them until
// the owner approves it on the dashboard (lib/guard.mjs, hub.mjs). This file is the pure part: which paths are
// protected, whether a task spec owns one, and what a change does in plain words, from code only: never from an AI
// reading the change, so a change can't talk its way past the owner.
import { whereJobsRun } from './workflows.mjs';
import { hooksFromJson, hooksFromToml } from '../checks/codex-hooks.mjs';

// The built-in list. A name ending in "/" is a folder (everything in it); a name without a "/" inside matches at any
// depth (a CLAUDE.md or .claude/ in a subfolder is loaded too); one with a "/" inside is from the project's top. The
// owner adds or removes entries in nextlevel.json: "protected": { "add": [...], "remove": [...] }.
export const BUILT_IN = ['.claude/', '.codex/', '.gemini/', '.agents/', '.vscode/', '.github/', '.husky/', '.mcp.json', '.npmrc', 'AGENTS.md', 'AGENTS.override.md', 'CLAUDE.md', 'GEMINI.md', 'SECURITY.md', 'docs/agents/', 'nextlevel.json', 'START.cmd'];

// A path as the entries are written: forward slashes, no "./", no doubled slashes; a leading "/" means the top
const clean = (p) => String(p ?? '').trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/').replace(/^(\.\/)+/, '');
// A path component as Windows reads it: case doesn't count, trailing dots and spaces are dropped ("CLAUDE.md." is
// CLAUDE.md), and so is an NTFS stream (".mcp.json::$DATA", "CLAUDE.md:x" write the file itself or a stream of it)
const comp = (c) => {
  const s = c.toLowerCase();
  const colon = s.indexOf(':');
  let end = colon < 0 ? s.length : colon;
  while (end > 0 && (s[end - 1] === '.' || s[end - 1] === ' ')) end--;
  return s.slice(0, end);
};
// An 8.3 short name ("CLAUDE~1" is .claude on Windows when the folder has that short name): it may stand for a
// protected folder or file, so such a component always counts as protected.
const SHORT_NAME = /^[^.~/]{1,6}~\d{1,6}(\.[^.]{0,3})?$/;
export const pathKey = (p) => clean(p).replace(/^\/+/, '').split('/').filter((x) => x && x !== '.').map(comp).join('/');

function entryOf(raw) {
  const e = clean(raw);
  const dir = e.endsWith('/');
  const parts = e.replace(/^\/+/, '').replace(/\/+$/, '').split('/').filter(Boolean).map(comp);
  return { raw: e, dir, parts, anchored: e.startsWith('/') || parts.length > 1 };
}

// The protected paths in effect: the built-in ones less what nextlevel.json removes, plus what it adds.
// -> { entries: ['.claude/', ...], added: [...], removed: [...], unknown: [removals that aren't built in] }
export function protectedList(config) {
  const p = config?.protected || {};
  const add = (Array.isArray(p.add) ? p.add : []).map(clean).filter(Boolean);
  const remove = (Array.isArray(p.remove) ? p.remove : []).map(clean).filter(Boolean);
  const key = (e) => entryOf(e).parts.join('/') + (clean(e).endsWith('/') ? '/' : '');
  const gone = new Set(remove.map(key));
  const entries = [];
  const seen = new Set();
  for (const e of [...BUILT_IN.filter((b) => !gone.has(key(b))), ...add]) {
    if (seen.has(key(e))) continue;
    seen.add(key(e));
    entries.push(e);
  }
  return { entries, added: add, removed: remove.filter((r) => BUILT_IN.some((b) => key(b) === key(r))), unknown: remove.filter((r) => !BUILT_IN.some((b) => key(b) === key(r))) };
}

// Whether a path in the project (as git or the disk names it, from the top) is protected. `entries`: protectedList's.
export function isProtected(rel, entries = BUILT_IN) {
  const parts = clean(rel).replace(/^\/+/, '').split('/').filter((x) => x && x !== '.').map(comp);
  if (!parts.length) return false;
  if (clean(rel).split('/').some((c) => SHORT_NAME.test(c))) return true;
  return entries.map(entryOf).some((e) => {
    if (!e.parts.length) return false;
    if (!e.anchored) return parts.includes(e.parts[0]);
    return e.parts.every((x, i) => parts[i] === x);
  });
}

// Whether a folder of the project (its path from the top, '' for the top) holds a protected path that is named from
// the top ("docs/" holds docs/agents/): what walking the disk has to go into.
export function leadsToProtected(rel, entries = BUILT_IN) {
  const parts = pathKey(rel).split('/').filter(Boolean);
  return entries.map(entryOf).some((e) => e.anchored && e.parts.length > parts.length && parts.every((x, i) => e.parts[i] === x));
}

// ---------- a task spec's "Files owned" ----------
// The entries under "## Files owned": each list item's path (the first `code` in it, else its first word), with
// placeholders (<...>) left out.
export function ownedEntries(spec) {
  const m = String(spec || '').replace(/\r\n?/g, '\n').match(/^##+\s*Files owned\s*\n([\s\S]*?)(?=^#{1,6}\s|(?![\s\S]))/im);
  if (!m) return [];
  const out = [];
  for (const line of m[1].split('\n')) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/);
    const text = item ? item[1] : /^\s*`[^`]+`/.test(line) ? line.trim() : '';
    if (!text) continue;
    const code = text.match(/`([^`]+)`/);
    const word = code ? code[1] : text.split(/\s+/)[0];
    const path = clean(word).replace(/[,;:]+$/, '');
    if (!path || /^<.*>$/.test(path) || /^\(.*\)$/.test(path)) continue;
    out.push(path);
  }
  return out;
}

const GLOB = /[*?[{]/;
// The owned entries that take in a protected path: one that is protected (or inside a protected folder), the whole
// project, or a folder that holds a protected path named from the top ("docs/" holds docs/agents/). A glob counts
// by the folder before its first wildcard. -> [{ entry, why }]
export function protectedOwned(spec, entries = BUILT_IN) {
  const out = [];
  for (const entry of ownedEntries(spec)) {
    const glob = GLOB.test(entry);
    const literal = glob ? entry.slice(0, entry.search(GLOB)) : entry;
    const folder = glob ? literal.replace(/[^/]*$/, '') : literal;
    const whole = !pathKey(folder) || ['.', '/'].includes(entry.trim());
    if (!glob && isProtected(entry, entries)) out.push({ entry, why: 'is protected' });
    else if (glob && literal && isProtected(literal, entries)) out.push({ entry, why: 'is protected' });
    else if (whole) out.push({ entry, why: 'is the whole project, protected files included' });
    else if ((glob || entry.endsWith('/')) && leadsToProtected(folder, entries)) out.push({ entry, why: `holds ${entries.find((e) => entryOf(e).anchored && leadsToProtected(folder, [e]))}, which is protected` });
  }
  return out;
}

// ---------- what a change does, in plain words ----------
// Characters that hide text or turn its direction around (Trojan Source), and other invisible ones: shown as
// ⟨U+XXXX⟩ wherever the owner reads a change, so what they approve is what they see.
// (made from code points: this file holds none of these characters itself)
const INVISIBLE_RANGES = [[0x0, 0x8], [0xb, 0xc], [0xe, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x180b, 0x180e], [0x200b, 0x200f], [0x202a, 0x202e], [0x2060, 0x206f], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xfeff, 0xfeff], [0xffa0, 0xffa0], [0xfff0, 0xfffb], [0xe0000, 0xe007f]];
const codePoint = (n) => `${String.fromCharCode(92)}u{${n.toString(16)}}`;
const INVISIBLE = new RegExp(`[${INVISIBLE_RANGES.map(([a, b]) => (a === b ? codePoint(a) : `${codePoint(a)}-${codePoint(b)}`)).join('')}]`, 'gu');
export const visible = (s) => String(s ?? '').replace(INVISIBLE, (c) => `⟨U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}⟩`);
export const hasInvisible = (s) => new RegExp(INVISIBLE.source, 'u').test(String(s ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n'));

const lines = (t) => (t === null || t === undefined ? [] : String(t).replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n'));
// Lines added and removed, as multisets (the order of the lines doesn't matter for the counts)
function lineChanges(before, after) {
  const count = new Map();
  for (const l of lines(before)) count.set(l, (count.get(l) || 0) + 1);
  const added = [];
  for (const l of lines(after)) {
    if (count.get(l)) count.set(l, count.get(l) - 1);
    else added.push(l);
  }
  const removed = [];
  for (const [l, n] of count) for (let i = 0; i < n; i++) removed.push(l);
  return { added, removed };
}
const setDiff = (a, b) => {
  const inB = new Set(b);
  return [...new Set(a)].filter((x) => !inB.has(x));
};
const cut = (s, n = 240) => {
  const t = visible(String(s ?? '').replace(/\s+/g, ' ').trim());
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// JSON as VS Code and Claude Code write it: comments and trailing commas allowed. null when it isn't JSON.
export function looseJson(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).replace(/^./su, (c) => (c.codePointAt(0) === 0xfeff ? '' : c)); // (a byte-order mark first: Notepad writes one)
  try {
    return JSON.parse(t);
  } catch {
    // strip // and /* */ comments outside strings, then trailing commas
    let out = '';
    let quote = false;
    for (let i = 0; i < t.length; i++) {
      const c = t[i];
      if (quote) {
        out += c;
        if (c === '\\') out += t[++i] ?? '';
        else if (c === '"') quote = false;
      } else if (c === '"') {
        quote = true;
        out += c;
      } else if (c === '/' && t[i + 1] === '/') while (i < t.length && t[i] !== '\n') i++;
      else if (c === '/' && t[i + 1] === '*') {
        i += 2;
        while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++;
        i++;
      } else out += c;
    }
    try {
      return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
    } catch {
      return null;
    }
  }
}
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const commandLine = (cmd, args) => [cmd, ...(Array.isArray(args) ? args : [])].filter((x) => x !== undefined && x !== null && x !== '').map(String).join(' ');

// What a settings file would run: [label, command] pairs, from its parsed value
const CLAUDE_RUNS = ['apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'otelHeadersHelper'];
function claudeRuns(v) {
  if (!isObj(v)) return [];
  const out = hooksFromJson(v).map((h) => `hook ${h.event}: ${h.command || h.commandWindows}`);
  if (isObj(v.statusLine) && v.statusLine.command) out.push(`status line: ${v.statusLine.command}`);
  for (const k of CLAUDE_RUNS) if (typeof v[k] === 'string' && v[k]) out.push(`${k}: ${v[k]}`);
  return out;
}
function mcpServers(v) {
  const servers = isObj(v) && isObj(v.mcpServers) ? v.mcpServers : {};
  return Object.entries(servers).map(([name, s]) => {
    if (!isObj(s)) return `MCP server "${name}"`;
    if (s.command) return `MCP server "${name}" runs: ${commandLine(s.command, s.args)}`;
    const url = s.url || s.httpUrl || s.serverUrl;
    return url ? `MCP server "${name}" connects to ${url}` : `MCP server "${name}"`;
  });
}
const listOf = (v) => (Array.isArray(v) ? v.map(String) : []);
// Claude Code's settings: what runs, what it may do without asking, which MCP servers and plugins it takes
function claudeSettings(b, a) {
  const out = [];
  const say = (added, removed, now, gone) => {
    for (const x of added) out.push(`${now} ${x}`);
    for (const x of removed) out.push(`${gone} ${x}`);
  };
  say(setDiff(claudeRuns(a), claudeRuns(b)), setDiff(claudeRuns(b), claudeRuns(a)), 'would run:', 'no longer runs:');
  const perm = (v, k) => listOf(isObj(v) && isObj(v.permissions) ? v.permissions[k] : null);
  say(setDiff(perm(a, 'allow'), perm(b, 'allow')), [], 'allows without asking:', '');
  say(setDiff(perm(b, 'deny'), perm(a, 'deny')), [], 'no longer denies:', '');
  say(setDiff(perm(a, 'additionalDirectories'), perm(b, 'additionalDirectories')), [], 'may also work in:', '');
  const mode = (v) => (isObj(v) && isObj(v.permissions) ? v.permissions.defaultMode : undefined);
  if (mode(a) !== mode(b)) out.push(`permission mode: ${mode(b) ?? '(not set)'} -> ${mode(a) ?? '(not set)'}`);
  const flag = (v, k) => (isObj(v) ? v[k] : undefined);
  for (const k of ['enableAllProjectMcpServers', 'disableAllHooks', 'dangerouslySkipPermissions', 'skipDangerousModePermissionPrompt']) {
    if (flag(a, k) !== flag(b, k)) out.push(`${k}: ${JSON.stringify(flag(b, k) ?? null)} -> ${JSON.stringify(flag(a, k) ?? null)}`);
  }
  say(setDiff(listOf(flag(a, 'enabledMcpjsonServers')), listOf(flag(b, 'enabledMcpjsonServers'))), [], 'turns on MCP server:', '');
  const plugins = (v) => (isObj(v) && isObj(v.enabledPlugins) ? Object.entries(v.enabledPlugins).filter(([, on]) => on).map(([k]) => k) : []);
  say(setDiff(plugins(a), plugins(b)), [], 'turns on plugin:', '');
  const markets = (v) => (isObj(v) && isObj(v.extraKnownMarketplaces) ? Object.entries(v.extraKnownMarketplaces).map(([k, m]) => `${k} (${JSON.stringify(m?.source ?? m)})`) : []);
  say(setDiff(markets(a), markets(b)), [], 'adds plugin marketplace:', '');
  const envKeys = (v) => (isObj(v) && isObj(v.env) ? Object.keys(v.env) : []);
  say(setDiff(envKeys(a), envKeys(b)), setDiff(envKeys(b), envKeys(a)), 'sets environment variable', 'no longer sets');
  return out;
}
function mcpChange(b, a, runs = () => []) {
  const out = [];
  const now = [...mcpServers(a), ...runs(a)];
  const was = [...mcpServers(b), ...runs(b)];
  for (const x of setDiff(now, was)) out.push(`adds ${x}`);
  for (const x of setDiff(was, now)) out.push(`drops ${x}`);
  return out;
}
const geminiRuns = (v) => claudeRuns(v).concat(isObj(v) && isObj(v.tools) && v.tools.discoveryCommand ? [`tool discovery: ${v.tools.discoveryCommand}`] : []);

// Codex's config.toml: its hooks, and the lines that start programs or open the sandbox, with the table they are in
function tomlLines(text) {
  const out = [];
  let table = '';
  for (const raw of lines(text)) {
    const l = raw.trim();
    const head = l.match(/^\[\[?([^\]]*)\]/); // (linear on any line: the text is a branch's)
    if (head) {
      table = head[1].trim();
      continue;
    }
    if (/^(command|args|url|notify|sandbox_mode|approval_policy|env|shell_environment_policy|bearer_token_env_var)\s*=/.test(l) || /^(sandbox|approval)/.test(l)) out.push(`${table ? `[${table}] ` : ''}${l}`);
  }
  return out;
}
function codexConfig(before, after) {
  const out = [];
  const hooks = (t) => (t === null || t === undefined ? [] : hooksFromToml(String(t)).hooks.map((h) => `hook ${h.event}: ${h.command || h.commandWindows}`));
  for (const x of setDiff(hooks(after), hooks(before))) out.push(`would run: ${x}`);
  for (const x of setDiff(hooks(before), hooks(after))) out.push(`no longer runs: ${x}`);
  for (const x of setDiff(tomlLines(after), tomlLines(before))) out.push(`sets ${x}`);
  for (const x of setDiff(tomlLines(before), tomlLines(after))) out.push(`no longer sets ${x}`);
  return out;
}

// A GitHub workflow: the commands its steps run (run:, a block's lines one by one), the actions it uses, its triggers
function workflowParts(text) {
  const runs = [];
  const uses = [];
  const on = [];
  const ls = lines(text);
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i];
    const run = l.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
    if (run) {
      const rest = run[2].trim();
      if (/^[|>][-+]?\d*\s*(#.*)?$/.test(rest)) {
        const indent = run[1].length;
        for (i++; i < ls.length; i++) {
          if (ls[i].trim() && ls[i].search(/\S/) <= indent + (/^\s*-/.test(l) ? 0 : 0)) break;
          if (ls[i].trim()) runs.push(ls[i].trim());
        }
        i--;
      } else if (rest) runs.push(rest.replace(/^(['"])(.*)\1$/, '$2'));
      continue;
    }
    const use = l.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
    if (use) uses.push(use[1].replace(/^(['"])(.*)\1$/, '$2'));
    const trigger = l.match(/^on:\s*(.*)$/);
    if (trigger) {
      if (trigger[1].trim()) on.push(trigger[1].trim());
      for (let j = i + 1; j < ls.length && (/^\s/.test(ls[j]) || !ls[j].trim()); j++) {
        const k = ls[j].match(/^ {2}([\w-]+):/);
        if (k) on.push(k[1]);
      }
    }
  }
  return { runs, uses, on };
}
function workflow(before, after) {
  const b = workflowParts(before);
  const a = workflowParts(after);
  // where its jobs run first (a job moved onto the PC must never be cut off the card): lib/workflows.mjs
  const out = whereJobsRun(before || '', after || '').map((x) => `where jobs run: ${x}`);
  for (const x of setDiff(a.runs, b.runs)) out.push(`would run: ${x}`);
  for (const x of setDiff(b.runs, a.runs)) out.push(`no longer runs: ${x}`);
  for (const x of setDiff(a.uses, b.uses)) out.push(`uses action: ${x}`);
  for (const x of setDiff(b.uses, a.uses)) out.push(`no longer uses action: ${x}`);
  if (setDiff(a.on, b.on).length || setDiff(b.on, a.on).length) out.push(`runs on: ${a.on.join(', ') || '(nothing)'} (was: ${b.on.join(', ') || '(nothing)'})`);
  return out;
}
// VS Code's tasks: what they run, and whether they run by themselves when the folder opens
function vscodeTasks(b, a) {
  const tasks = (v) =>
    (isObj(v) && Array.isArray(v.tasks) ? v.tasks : []).map((t) => `${commandLine(t?.command, t?.args) || t?.label || 'a task'}${t?.runOptions?.runOn === 'folderOpen' ? ' (runs by itself when the folder opens)' : ''}`);
  const out = [];
  for (const x of setDiff(tasks(a), tasks(b))) out.push(`task runs: ${x}`);
  for (const x of setDiff(tasks(b), tasks(a))) out.push(`task removed: ${x}`);
  return out;
}
// Settings as flat keys: "engines.codex.args" -> its value
function flat(v, at = '', out = {}) {
  if (isObj(v)) {
    for (const [k, x] of Object.entries(v)) flat(x, at ? `${at}.${k}` : k, out);
    if (!Object.keys(v).length && at) out[at] = '{}';
  } else if (at) out[at] = JSON.stringify(v);
  return out;
}
function jsonKeys(b, a, { values = true } = {}) {
  const fb = flat(b);
  const fa = flat(a);
  const out = [];
  for (const k of [...new Set([...Object.keys(fb), ...Object.keys(fa)])].sort()) {
    if (fb[k] === fa[k]) continue;
    if (!values) out.push(`${k in fa ? (k in fb ? 'changes' : 'adds') : 'removes'} ${k}`);
    else if (!(k in fb)) out.push(`adds ${k}: ${fa[k]}`);
    else if (!(k in fa)) out.push(`removes ${k} (was ${fb[k]})`);
    else out.push(`${k}: ${fb[k]} -> ${fa[k]}`);
  }
  return out;
}
// .npmrc: key=value lines; values of keys that hold a login are never shown
function npmrc(before, after) {
  const pairs = (t) =>
    Object.fromEntries(
      lines(t)
        .map((l) => l.trim())
        .filter((l) => l && !/^[#;]/.test(l))
        .map((l) => {
          const i = l.indexOf('=');
          return i < 0 ? [l, ''] : [l.slice(0, i).trim(), l.slice(i + 1).trim()];
        }),
    );
  const b = pairs(before);
  const a = pairs(after);
  const shown = (k, v) => (/(auth|token|password|_pass|cert|key)/i.test(k) ? '(value hidden)' : v);
  const out = [];
  for (const k of [...new Set([...Object.keys(b), ...Object.keys(a)])]) {
    if (b[k] === a[k]) continue;
    if (!(k in b)) out.push(`sets ${k} = ${shown(k, a[k])}`);
    else if (!(k in a)) out.push(`removes ${k}`);
    else out.push(`changes ${k} = ${shown(k, a[k])}`);
  }
  return out;
}
const isComment = (l) => /^\s*(#|::|rem\s|REM\s|\/\/|@rem\s)/i.test(l) || /^\s*@?echo off\s*$/i.test(l);
function script(before, after) {
  const { added, removed } = lineChanges(before, after);
  return [...added.filter((l) => l.trim() && !isComment(l)).map((l) => `would run: ${l.trim()}`), ...removed.filter((l) => l.trim() && !isComment(l)).map((l) => `no longer runs: ${l.trim()}`)];
}

// Which reader a file gets, by its path
function kindOf(rel) {
  const p = pathKey(rel);
  const base = p.split('/').pop();
  if (/(^|\/)\.claude\/settings(\.local)?\.json$/.test(p)) return 'claude';
  if (base === '.mcp.json') return 'mcp';
  if (/(^|\/)\.gemini\/settings\.json$/.test(p)) return 'gemini';
  if (/(^|\/)\.codex\/config\.toml$/.test(p)) return 'codex';
  if (/(^|\/)\.codex\/hooks\.json$/.test(p) || /(^|\/)\.claude\/hooks\.json$/.test(p)) return 'hooks';
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(p)) return 'workflow';
  if (/(^|\/)\.vscode\/tasks\.json$/.test(p)) return 'tasks';
  if (base === 'nextlevel.json') return 'nextlevel';
  if (/\.(json|jsonc)$/.test(base)) return 'json';
  if (base === '.npmrc') return 'npmrc';
  if (/\.(cmd|bat|ps1|psm1|sh|bash|zsh)$/.test(base) || /(^|\/)\.husky\/[^/]+$/.test(p) || /(^|\/)hooks\/[^/.]+$/.test(p)) return 'script';
  if (/\.(md|mdc|txt)$/.test(base)) return 'instructions';
  return 'file';
}

// One file's change in plain words. `before`/`after`: the text, or null when the file isn't there; `link`: a link's
// target on either side ({ before, after }); `binary`/`size`: a file that isn't text. -> lines (the first says what
// happened to the file, the rest what it would run or allow, indented).
export function describeChange({ path: rel, before = null, after = null, link = {}, binary = false, size = 0, submodule = false }) {
  const name = visible(rel);
  if (submodule) return [`${name}: a submodule${after === null ? ' removed' : ` at commit ${cut(after, 12)}`}`];
  if (link.after !== undefined || link.before !== undefined) {
    if (link.after === undefined) return [`${name}: the link ${link.before ? `to ${cut(link.before)} ` : ''}is removed`];
    return [`${name}: ${link.before === undefined ? 'added as' : 'becomes'} a link to ${cut(link.after)}: whatever is there is read in its place`];
  }
  if (binary) return [`${name}: ${after === null ? 'removed' : before === null ? 'added' : 'changed'}, a binary file (${size} bytes): open it to see what it is`];
  const head =
    before === null
      ? `${name}: added (${plural(lines(after).length, 'line')})`
      : after === null
        ? `${name}: removed (it had ${plural(lines(before).length, 'line')})`
        : (({ added, removed }) => `${name}: changed (${added.length} added, ${removed.length} removed ${removed.length === 1 && added.length <= 1 ? 'line' : 'lines'})`)(lineChanges(before, after));
  const b = before === null ? null : String(before);
  const a = after === null ? null : String(after);
  let detail = [];
  const kind = kindOf(rel);
  const parse = (t) => (t === null ? {} : looseJson(t));
  const bad = (t) => t !== null && looseJson(t) === null;
  if (['claude', 'mcp', 'gemini', 'hooks', 'tasks', 'nextlevel', 'json'].includes(kind) && (bad(a) || bad(b))) detail.push(bad(a) ? 'not valid JSON now: the tool that reads it may ignore it or stop' : 'was not valid JSON before');
  if (kind === 'claude') detail.push(...claudeSettings(parse(b), parse(a)));
  else if (kind === 'mcp') detail.push(...mcpChange(parse(b), parse(a)));
  else if (kind === 'gemini') detail.push(...mcpChange(parse(b), parse(a), geminiRuns));
  else if (kind === 'hooks') {
    const runs = (v) => hooksFromJson(v || {}).map((h) => `hook ${h.event}: ${h.command || h.commandWindows}`);
    detail.push(...setDiff(runs(parse(a)), runs(parse(b))).map((x) => `would run: ${x}`), ...setDiff(runs(parse(b)), runs(parse(a))).map((x) => `no longer runs: ${x}`));
  } else if (kind === 'codex') detail.push(...codexConfig(b, a));
  else if (kind === 'workflow') detail.push(...workflow(b, a));
  else if (kind === 'tasks') detail.push(...vscodeTasks(parse(b), parse(a)));
  else if (kind === 'nextlevel') detail.push(...jsonKeys(parse(b), parse(a)));
  else if (kind === 'json') detail.push(...jsonKeys(parse(b), parse(a), { values: false }), ...claudeRuns(parse(a)).filter((x) => !claudeRuns(parse(b)).includes(x)).map((x) => `would run: ${x}`), ...mcpChange(parse(b), parse(a)));
  else if (kind === 'npmrc') detail.push(...npmrc(b, a));
  else if (kind === 'script') detail.push(...script(b, a));
  else if (kind === 'instructions') {
    // instructions the agents follow: every line they gain or lose
    const { added, removed } = lineChanges(b, a);
    detail.push(...added.filter((l) => l.trim()).map((l) => `adds: ${l.trim()}`), ...removed.filter((l) => l.trim()).map((l) => `removes: ${l.trim()}`));
  }
  if (hasInvisible(a)) detail.unshift('!! it has invisible or direction-changing characters, shown as ⟨U+...⟩: text may not be what it looks like');
  detail = [...new Set(detail.map((x) => cut(x)))];
  const MAX = 25;
  if (detail.length > MAX) detail = [...detail.slice(0, MAX), `... and ${detail.length - MAX} more (the diff has them all)`];
  return [head, ...detail.map((x) => `  ${x}`)];
}

// The whole change's summary: every file's lines, in path order.
export const describeChanges = (files) => [...files].sort((x, y) => String(x.path).localeCompare(String(y.path))).flatMap(describeChange);
