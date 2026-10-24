// Codex hooks whose command can't run (FR-004 #4): Codex printed "Hook failed, exit 1" around every tool
// call, which looks like nextlevel failing but isn't (like broken MCP servers, codex.mcp). Where Codex
// 0.157 takes hooks from (codex-rs hooks/src/engine/discovery.rs, core-plugins):
//   hooks.json, and a [hooks] table in config.toml, in each config folder: the user's ($CODEX_HOME, else
//   ~/.codex), the project's .codex/ (when Codex trusts the project) and the system's (/etc/codex,
//   %ProgramData%\OpenAI\Codex)
//   plugins in $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/: the "hooks" of their manifest
//   (.codex-plugin/plugin.json: a file, a list of files, or the hooks themselves), else hooks/hooks.json
// A hook's command is a shell line (pwsh on Windows, which uses commandWindows when it is set). It is
// broken when its program isn't found, or a script it names by its full path isn't there. Hooks are off
// altogether with `hooks = false` under [features].
import { fail, pass, step } from './lib.mjs';

// { hooks: { <Event>: [ { matcher, hooks: [ { type, command, commandWindows } ] } ] } } -> [{ event, command, commandWindows }]
export function hooksFromJson(value) {
  const out = [];
  const events = value && typeof value === 'object' ? value.hooks : null;
  if (!events || typeof events !== 'object') return out;
  for (const [event, groups] of Object.entries(events)) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of Array.isArray(g?.hooks) ? g.hooks : []) {
        if (h && (h.type ?? 'command') === 'command' && (h.command || h.commandWindows)) out.push({ event, command: h.command || '', commandWindows: h.commandWindows || '' });
      }
    }
  }
  return out;
}

const TOML_STRING = /\b(command|commandWindows|type)\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')/g;
const eventOf = (table) => {
  const event = (table.match(/^hooks\.([A-Za-z]+)(\.hooks)?$/) || [])[1];
  return event && event !== 'state' ? event : null; // [hooks.state."..."]: trust and on/off, not hooks
};
// The { ... } inline tables of a TOML line (braces inside strings don't count).
function inlineTables(line) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = -1;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') break;
    else if (c === '{' && depth++ === 0) start = i + 1;
    else if (c === '}' && depth > 0 && --depth === 0) out.push(line.slice(start, i));
  }
  return out;
}
const unquote = (s) => (s.startsWith("'") ? s.slice(1, -1) : s.slice(1, -1).replace(/\\(["\\])/g, '$1'));

// The command hooks of a config.toml's [hooks] table ([[hooks.<Event>]] with [[hooks.<Event>.hooks]], or
// inline tables), and whether [features] turns hooks off.
export function hooksFromToml(text) {
  const hooks = [];
  let off = false;
  let table = '';
  let current = null;
  const add = (event, fields) => {
    if ((fields.type ?? 'command') === 'command' && (fields.command || fields.commandWindows)) {
      hooks.push({ event, command: fields.command || '', commandWindows: fields.commandWindows || '' });
    }
  };
  const flush = () => {
    if (current) add(current.event, current.fields);
    current = null;
  };
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\s+/, '');
    // (linear: a line of a project's .codex/config.toml, which a task's branch may bring, never makes it backtrack)
    const head = line.match(/^\[\[?([^\]]*)\]\]?\s*(#.*)?$/);
    if (head) {
      flush();
      table = head[1].replace(/\s+/g, '');
      const event = eventOf(table);
      if (event && table.endsWith('.hooks')) current = { event, fields: {} };
      continue;
    }
    if (table === 'features' && /^(hooks|codex_hooks)\s*=\s*false\b/.test(line)) off = true;
    const event = eventOf(table);
    if (!event) continue;
    const pairs = (segment) => Object.fromEntries([...segment.matchAll(TOML_STRING)].map((m) => [m[1], unquote(m[2])]));
    if (current) Object.assign(current.fields, pairs(line));
    else for (const segment of inlineTables(line)) add(event, pairs(segment));
  }
  flush();
  return { hooks, off };
}

// A shell line's words, with quotes removed.
export function shellWords(line) {
  const words = [];
  for (const m of String(line || '').matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3]);
  return words;
}

const BUILTINS = new Set(['echo', 'cd', 'exit', 'true', 'false', 'test', '[', 'if', 'for', 'set', 'export', 'exec', 'call', 'start', 'type', 'cls', 'env']);
const SCRIPT = /\.(js|mjs|cjs|ts|py|ps1|sh|bash|rb|pl|bat|cmd|exe|jar)$/i;

// Why a hook's command can't run, or '' (also when it can't be told: a variable it names isn't known).
export function brokenCommand(ctx, line, vars = {}) {
  const win = ctx.platform === 'win32';
  const expand = (w) => {
    let unknown = false;
    const val = (name) => {
      const v = vars[name] ?? ctx.env[name] ?? (name === 'HOME' || name === 'USERPROFILE' ? ctx.home : undefined);
      if (v === undefined) unknown = true;
      return v ?? '';
    };
    const s = w
      .replace(/^~(?=[\\/]|$)/, ctx.home)
      .replace(/\$env:([A-Za-z_]\w*)/gi, (_, n) => val(n))
      .replace(/\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)/g, (_, a, b) => val(a || b))
      .replace(/%([A-Za-z_][\w()]*)%/g, (_, n) => val(n));
    return unknown ? null : s;
  };
  const words = shellWords(line).filter((w) => !['&', '&&', '||', ';', '|'].includes(w));
  while (words.length && (/^[A-Za-z_]\w*=/.test(words[0]) || ['&', 'call', 'exec'].includes(words[0].toLowerCase()))) words.shift();
  if (!words.length) return '';
  const program = expand(words[0]);
  if (program === null) return '';
  const isPath = /[\\/]/.test(program);
  if (isPath) {
    const found = ['', ...(win ? ['.exe', '.cmd', '.bat', '.ps1'] : [])].some((x) => ctx.exists(program + x));
    if (!found) return `${program} not found`;
  } else if (!BUILTINS.has(program.toLowerCase()) && !/^[A-Za-z]+-[A-Za-z]+$/.test(program)) {
    // a PowerShell cmdlet (Verb-Noun) needs no program; anything else must be on PATH
    const bin = ctx.which(program);
    if (!bin) return `${program} not found`;
    // Windows' "App execution alias" for Python only opens the Microsoft Store
    if (win && /^python3?(\.exe)?$/i.test(program) && /\\Microsoft\\WindowsApps\\/i.test(bin.file)) return `${program} is only the Microsoft Store's placeholder`;
  }
  for (const w of words.slice(1)) {
    const file = expand(w);
    if (!file || !SCRIPT.test(file) || !ctx.path.isAbsolute(file)) continue;
    if (!ctx.exists(file)) return `${file} not found`;
  }
  return '';
}

const readJson = (ctx, file) => {
  try {
    return JSON.parse((ctx.read(file) || '').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
};
const byVersion = (a, b) => a.localeCompare(b, undefined, { numeric: true });

// Every command hook Codex may run: [{ where, file, event, command, vars }], and whether hooks are off.
export function codexHooks(ctx, home) {
  const p = ctx.path;
  const system = ctx.platform === 'win32' ? p.join(ctx.env.ProgramData || 'C:\\ProgramData', 'OpenAI', 'Codex') : '/etc/codex';
  const folders = [
    { dir: home, where: 'your Codex settings' },
    ...(ctx.root ? [{ dir: p.join(ctx.root, '.codex'), where: "the project's .codex folder" }] : []),
    { dir: system, where: "the PC's Codex settings" },
  ];
  const found = [];
  let off = false;
  for (const f of folders) {
    const json = p.join(f.dir, 'hooks.json');
    for (const h of hooksFromJson(readJson(ctx, json))) found.push({ ...h, where: f.where, file: json });
    const toml = p.join(f.dir, 'config.toml');
    const t = hooksFromToml(ctx.read(toml));
    if (f.dir === home && t.off) off = true;
    for (const h of t.hooks) found.push({ ...h, where: f.where, file: toml });
  }
  // Plugins: the newest version of each
  const cache = p.join(home, 'plugins', 'cache');
  for (const market of ctx.list(cache)) {
    for (const plugin of ctx.list(p.join(cache, market))) {
      const version = ctx.list(p.join(cache, market, plugin)).sort(byVersion).at(-1);
      if (!version) continue;
      const root = p.join(cache, market, plugin, version);
      const manifest = ['.codex-plugin', '.claude-plugin', '.cursor-plugin'].map((d) => readJson(ctx, p.join(root, d, 'plugin.json'))).find(Boolean);
      const vars = { PLUGIN_ROOT: root, CLAUDE_PLUGIN_ROOT: root, PLUGIN_DATA: p.join(home, 'plugins', 'data', `${plugin}-${market}`) };
      vars.CLAUDE_PLUGIN_DATA = vars.PLUGIN_DATA;
      const where = `the plugin ${plugin}`;
      const decl = manifest?.hooks ?? 'hooks/hooks.json';
      for (const item of [decl].flat()) {
        if (typeof item === 'string') {
          const file = p.join(root, ...item.replace(/^\.\//, '').split('/'));
          for (const h of hooksFromJson(readJson(ctx, file))) found.push({ ...h, where, file, vars });
        } else for (const h of hooksFromJson(item)) found.push({ ...h, where, file: p.join(root, '.codex-plugin', 'plugin.json'), vars });
      }
    }
  }
  return { hooks: found, off };
}

export const codexHooksCheck = {
  id: 'codex.hooks',
  title: 'Codex hooks',
  severity: 'warn',
  requires: ['tool.codex'],
  learnMore: 'docs/CHECKS.md#codexhooks',
  run(ctx) {
    const home = ctx.env.CODEX_HOME || ctx.path.join(ctx.home, '.codex');
    const { hooks, off } = codexHooks(ctx, home);
    if (off) return pass('turned off ([features] hooks = false)', { quiet: true });
    const broken = hooks
      .map((h) => ({ ...h, why: brokenCommand(ctx, (ctx.platform === 'win32' && h.commandWindows) || h.command, h.vars) }))
      .filter((h) => h.why);
    if (!broken.length) return pass(hooks.length ? `${hooks.length} set up, all can run` : 'none set up', { quiet: !hooks.length });
    const shown = broken.slice(0, 3).map((h) => `${h.event} hook in ${h.where} (${h.why})`);
    const more = broken.length > 3 ? `, and ${broken.length - 3} more` : '';
    const files = [...new Set(broken.map((h) => h.file))];
    return fail(`${shown.join('; ')}${more}: Codex prints "Hook failed" around its tool calls; it isn't nextlevel's problem`, {
      steps: files.map((f) => step('editor', null, { text: `fix or remove the hook in ${f}` })),
    });
  },
};
