// Claude Code (Anthropic). docs/KNOWN_ISSUES.md#claude-code has the details.
// - `claude -p` runs one prompt headless, with no console: fine for workers and autopilot cycles. (Only
//   a new *cloud* session needs a real terminal, FR-006: that is nextlevel fix, src/fix.mjs.)
// - It has no sandbox of its own that keeps .git read-only, but the orchestrator's git writes still go
//   through the hub, as on every engine: its permission rules deny them (and allow the hub's commands,
//   so an unattended cycle doesn't stop at a question).
// - It reads CLAUDE.md, not AGENTS.md: the prompt tells it to read AGENTS.md.
// - A second account: CLAUDE_CONFIG_DIR moves its folder: settings, sessions and the sign-in
//   (.credentials.json; on macOS a Keychain entry named after the folder's path, as written). An API key
//   or token in the environment wins over that sign-in, so a named account's sessions get none.
// - Model and effort: --model takes an alias (opus, sonnet...) or a full name, --effort low...max. Without
//   them it uses `model` and `effortLevel` in its settings.json (ANTHROPIC_MODEL wins over the file). No
//   command lists the models.
// - Tokens and the feed: a headless run prints its steps as JSON lines (--output-format stream-json, which
//   -p takes only with --verbose): "system" (init), "assistant" (its text and tool calls: Bash with the
//   command, Edit and Write with the file), "user" (each tool's result, is_error when it failed) and a last
//   "result" with `usage`: input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens.
//   The dashboard's feed and the log it shows are read from them. In text mode it prints the final answer
//   alone, so the log loses nothing. Its interactive window's tokens aren't counted.
import { firstLine } from '../checks/lib.mjs';
import { accountDir, commandEvent, commandOutcome, count, inFolder, jsonLine, lastJsonWith, lastLines, oneLine, readJsonText } from './util.mjs';
import { ASSISTANT_DENY_TOOLS, ASSISTANT_LOOK, ORCHESTRATOR_ALLOW, ORCHESTRATOR_DENY, WORKER_DENY } from './rules.mjs';

// Claude Code's permission rules for shell commands: "Bash(git push:*)" matches git push and anything after it.
const bash = (commands) => commands.map((c) => `Bash(${c}:*)`).join(',');
const model = (m) => (m ? ['--model', m] : []);
// Its steps as JSON lines, for the feed and the tokens it used (stream-json needs --verbose with -p); unless
// engines.claude.args ask for another format
const json = (args) => (args.includes('--output-format') || args.some((a) => a.startsWith('--output-format=')) ? [] : ['--output-format', 'stream-json', ...(args.includes('--verbose') ? [] : ['--verbose'])]);
const effort = (e) => (e ? ['--effort', e] : []);
function jsonIn(text) {
  const t = String(text || '');
  try {
    return JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
}

// What a headless run used, from its JSON result: input (new, and written to the cache) and output, like
// Codex's "tokens used"; the cache reads apart (cheap, and they would dwarf the rest). null: no result.
export function claudeTokens(text) {
  const u = lastJsonWith(text, 'usage')?.usage;
  if (!u || typeof u !== 'object') return null;
  // (its parts too, for the usage ledger: thinking is inside output, so it is a part of nothing)
  const parts = { input: count(u.input_tokens), cacheWrite: count(u.cache_creation_input_tokens), output: count(u.output_tokens) };
  const thinking = u.output_tokens_details && typeof u.output_tokens_details === 'object' ? count(u.output_tokens_details.thinking_tokens) : 0;
  return { tokens: parts.input + parts.cacheWrite + parts.output, cached: count(u.cache_read_input_tokens), ...parts, ...(thinking ? { thinking } : {}) };
}
// A tool call as an event of the feed (util.mjs): a command, a file edited, another tool; null for the ones that
// only look (Read, Grep, Glob, LS) or plan (TodoWrite).
function toolEvent(name, input = {}, cwd = '') {
  const file = input.file_path || input.notebook_path || input.path || '';
  if (name === 'Bash') return commandEvent(input.command || '');
  if (['Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return { kind: 'edit', text: `edited ${inFolder(file, cwd)}`, detail: '', ok: undefined };
  if (name === 'Write') return { kind: 'edit', text: `wrote ${inFolder(file, cwd)}`, detail: '', ok: undefined };
  if (['Read', 'Grep', 'Glob', 'LS', 'TodoWrite', 'BashOutput', 'KillShell', 'KillBash'].includes(name)) return null;
  if (name === 'WebFetch') return { kind: 'tool', text: `fetched ${oneLine(input.url, 160)}`, detail: '', ok: undefined };
  if (name === 'WebSearch') return { kind: 'tool', text: `searched the web: ${oneLine(input.query, 160)}`, detail: '', ok: undefined };
  if (name === 'Task' || name === 'Agent') return { kind: 'tool', text: `a subagent: ${oneLine(input.description || input.prompt, 160)}`, detail: '', ok: undefined };
  return { kind: 'tool', text: oneLine(name, 80), detail: '', ok: undefined };
}
const resultText = (content) => (typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => (typeof c === 'string' ? c : c?.text || '')).join('\n') : '');

// What a headless run did, from its stream-json lines, oldest first: commands with what came of them, files
// edited, its messages, and the end. [] for a log with none (text mode, or an older run with its JSON result).
export function claudeFeed(text, { cwd = '' } = {}) {
  const events = [];
  const calls = new Map(); // tool_use id -> its event, for its result
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = jsonLine(line);
    if (!v) continue;
    const content = Array.isArray(v.message?.content) ? v.message.content : [];
    if (v.type === 'assistant') {
      for (const c of content) {
        if (c?.type === 'text' && String(c.text || '').trim()) events.push({ kind: 'message', text: oneLine(firstLine(c.text), 240), detail: '', ok: undefined });
        else if (c?.type === 'tool_use') {
          const e = toolEvent(c.name, c.input || {}, cwd);
          if (e) {
            events.push(e);
            calls.set(c.id, e);
          }
        }
      }
    } else if (v.type === 'user') {
      for (const c of content) {
        const e = c?.type === 'tool_result' && calls.get(c.tool_use_id);
        if (!e) continue;
        if (e.kind === 'command' || e.kind === 'test') commandOutcome(e, resultText(c.content), !c.is_error);
        else if (c.is_error) Object.assign(e, { ok: false, detail: `failed: ${oneLine(firstLine(resultText(c.content)), 160)}` });
        else e.ok = true;
      }
    } else if (v.type === 'result') {
      events.push({ kind: 'done', text: v.is_error ? 'finished with an error' : 'finished', detail: v.num_turns ? `${v.num_turns} turn(s)` : '', ok: !v.is_error });
    }
  }
  return events;
}

// A log with its JSON as a person reads it (the dashboard shows a log this way): each stream-json step as a
// line ("$ npm test", "edited src/a.js", its text), the result as the answer and what it used; null when there
// is no JSON in it.
function claudeReadable(text) {
  const r = lastJsonWith(text, 'usage');
  const lines = String(text).split(/\r?\n/);
  let any = false;
  const n = (x) => x.toLocaleString('en-US');
  const out = [];
  for (const line of lines) {
    const v = jsonLine(line);
    if (!v || !v.type) {
      out.push(line);
      continue;
    }
    any = true;
    if (v.type === 'result') {
      const t = claudeTokens(line);
      if (typeof v.result === 'string') out.push(`${v.result}\n\n[Claude Code${v.is_error ? ', error' : ''}: ${v.num_turns ?? '?'} turn(s), ${n(t?.tokens || 0)} tokens${t?.cached ? `, ${n(t.cached)} more read from its cache` : ''}]`);
      continue;
    }
    for (const e of claudeFeed(line)) out.push(e.kind === 'command' || e.kind === 'test' ? `$ ${e.text}` : e.kind === 'message' ? `Claude Code: ${e.text}` : e.text);
  }
  if (any) return out.join('\n');
  // a pretty-printed result (an older run's --output-format json)
  if (!r || typeof r.result !== 'string') return null;
  const t = claudeTokens(text);
  const shown = `${r.result}\n\n[Claude Code${r.is_error ? ', error' : ''}: ${r.num_turns ?? '?'} turn(s), ${n(t.tokens)} tokens${t.cached ? `, ${n(t.cached)} more read from its cache` : ''}]`;
  const at = lines.findIndex((l) => l.trim().startsWith('{'));
  return at < 0 ? shown : [...lines.slice(0, at), shown].join('\n');
}

// How a headless run ended, by Claude Code's own account (FR-020): its last stream-json "result" event, with `subtype`
// (success; error_max_turns, error_during_execution...), `is_error`, `num_turns`, its last answer (`result`) and, for an
// error, `errors`. Measured on 2.1.284 (test/fixtures/claude-2.1.284-max-turns.jsonl): --max-turns 1 ends with exit 1,
// subtype error_max_turns, is_error true and errors ["Reached maximum number of turns (1)"]. A session ends when the
// model ends its turn, and it stops the background commands still running: "task_updated" events with status "killed"
// after the result (a real task's attempt 10 ended its turn to wait for one, and never wrote its report). -> { status, error,
// reason, turns, said, stopped, last }; status '' when it printed no result. Not redacted.
export function claudeEnd(text, { code = null } = {}) {
  let r = null;
  let stopped = 0;
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = jsonLine(line);
    if (!v) continue;
    if (v.type === 'result') {
      r = v;
      stopped = 0;
    } else if (r && v.type === 'system' && v.subtype === 'task_updated' && v.patch?.status === 'killed') stopped++;
  }
  const last = lastLines(claudeReadable(text) ?? text);
  if (!r) return { status: '', error: false, reason: '', turns: null, said: '', stopped: 0, code, last };
  const status = String(r.subtype || '');
  const error = r.is_error === true || status.startsWith('error');
  const words = typeof r.result === 'string' ? oneLine(firstLine(r.result), 300) : '';
  const errors = Array.isArray(r.errors) ? r.errors.map((e) => (typeof e === 'string' ? e : e?.message || '')).filter(Boolean) : [];
  const reason = error ? oneLine(errors[0] || words || status || 'an error', 400) : '';
  return { status, error, reason, turns: Number.isFinite(r.num_turns) ? r.num_turns : null, said: error ? '' : words, stopped, code, last };
}

// ---------- a worker without the owner's own add-ons (FR-013) ----------
// `claude -p` loads the owner's user settings (hooks, enabled plugins, permissions, model), skills (~/.claude/skills) and
// MCP servers (~/.claude.json, and the claude.ai connectors). Measured on 2.1.280: with `--setting-sources project,local`
// and `--strict-mcp-config` a session had no MCP servers, and of the skills only Claude Code's own (the owner's Rafter
// and novamira skills, and the plugins' ones, were gone); the project's settings and CLAUDE.md stay. Leaving the user
// settings out leaves their model and effort out too, so a worker without a model of its own is given those
// (`pin`). Claude Code keeps hooks, skills and plugins together in the user settings, and has no way to start only some
// MCP servers without copying their settings: listing any in workers.addons gives the workers all of that kind.
export function claudeAddons({ home, account = '', env = {}, read, list = () => [], path: p }) {
  const dir = account ? accountDir(home, 'claude', account, p) : env.CLAUDE_CONFIG_DIR || p.join(home, '.claude');
  const settings = readJsonText(read(p.join(dir, 'settings.json'))) || {};
  const state = readJsonText(read(account || env.CLAUDE_CONFIG_DIR ? p.join(dir, '.claude.json') : p.join(home, '.claude.json'))) || {};
  // (the program only: a server's arguments and environment can hold its keys)
  const mcpServers = Object.entries(state.mcpServers || {}).map(([name, s]) => ({ name, command: typeof s?.command === 'string' ? s.command : s?.url ? 'a remote server' : '' }));
  const hooks = Object.keys(settings.hooks || {});
  const plugins = Object.entries(settings.enabledPlugins || {}).filter(([, on]) => on).map(([name]) => name);
  const skills = list(p.join(dir, 'skills')).filter((n) => !n.startsWith('.'));
  return { mcpServers, hooks, plugins, skills, rules: [], files: { settings: p.join(dir, 'settings.json'), dir }, model: typeof settings.model === 'string' ? settings.model : '', effort: typeof settings.effortLevel === 'string' ? settings.effortLevel : '' };
}
function claudeWorker(keep = {}, found = {}) {
  const args = [];
  const left = [];
  if (!(keep.mcpServers || []).length) args.push('--strict-mcp-config');
  else left.push({ what: 'mcp-some', text: 'Claude Code has no way to give a session only some MCP servers without copying their settings: listing any in workers.addons.mcpServers gives the workers all of them' });
  const user = !!(keep.skills || keep.hooks);
  if (!user) args.push('--setting-sources', 'project,local');
  else if (!(keep.skills && keep.hooks)) left.push({ what: 'user-some', text: "Claude Code keeps hooks, skills and plugins together in the owner's settings: workers.addons.skills or .hooks gives the workers all of them" });
  // (what the owner's settings name, only when it looks like a model or an effort: it goes on a command line)
  const model = /^[\w.:/@+[\]-]{1,100}$/.test(found.model || '') ? found.model : '';
  const effort = /^[a-z]{1,20}$/.test(found.effort || '') ? found.effort : '';
  return { args, files: [], readsAgentsMd: false, left, pin: user ? null : { model, effort } };
}

// What each role may do without asking. The prompt goes first: the rule lists take several values.
function permissions(role, mode) {
  if (role === 'worker') {
    // Unattended in a slot with no secrets and no way to push: edits in the slot, any command but these. No Monitor:
    // a session ends when the model ends its turn, so a wait for what a background watcher reports never comes back
    // (FR-020; workerEnv turns the background commands off)
    return ['--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,WebFetch,WebSearch', '--disallowedTools', `${bash(WORKER_DENY)},Monitor`];
  }
  if (role === 'orchestrator') {
    // The hub's commands and git that only reads, without asking; git writes never (the hub does them)
    return [...(mode === 'headless' ? ['--permission-mode', 'acceptEdits'] : []), '--allowedTools', bash(ORCHESTRATOR_ALLOW), '--disallowedTools', bash(ORCHESTRATOR_DENY)];
  }
  return []; // the setup guide asks the owner before it runs things
}

export default {
  name: 'claude',
  title: 'Claude Code',
  command: 'claude',
  window: 'claude',
  defaultArgs: [],
  // FR-017: a role it runs with no permission check (the assistant gets its own read-only arguments, never these)
  fullAccess: (args, role) =>
    role !== 'assistant' && args.some((a, i) => a === '--dangerously-skip-permissions' || a === '--permission-mode=bypassPermissions' || (a === '--permission-mode' && args[i + 1] === 'bypassPermissions'))
      ? 'Claude Code skips its permission checks for it (--dangerously-skip-permissions or bypassPermissions in engines.claude.args)'
      : '',
  readsAgentsMd: false,
  writesGit: true,
  needsRealConsole: () => false,
  addons: claudeAddons, // the owner's own add-ons, and what keeps them out of a worker (FR-013)
  workerAddons: claudeWorker,
  account: {
    env: 'CLAUDE_CONFIG_DIR',
    holds: "Claude Code's own folder: its settings, sessions and sign-in",
    clear: ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'],
  },
  // `claude auth status` (2.1): JSON, exit 0 when signed in and 1 when not
  login: { status: ['auth', 'status'], signIn: ['auth', 'login'], signInText: 'it opens the browser: sign in with the Claude account for this profile' },
  loginResult(r) {
    const status = jsonIn(r.out);
    if (status && typeof status.loggedIn === 'boolean') {
      if (!status.loggedIn) return { ok: false, detail: 'not signed in' };
      if (status.authMethod === 'api_key') return { ok: true, detail: `an API key${status.apiKeySource ? ` (${status.apiKeySource})` : ''}, billed by use, not a subscription` };
      const who = [status.email, status.subscriptionType].filter(Boolean).join(', ');
      return { ok: true, detail: `signed in${who ? ` (${who})` : ''}` };
    }
    // An older Claude Code has no `auth status`
    if (/unknown command|too many arguments|error: unknown/i.test(r.out)) return { ok: false, unknown: true, detail: `unknown: ${firstLine(r.out)} (an older Claude Code: update it)` };
    return r.ok ? { ok: true, detail: firstLine(r.out) || 'signed in' } : { ok: false, detail: 'not signed in' };
  },
  // A worker's session (FR-020): `claude -p` ends when the model ends its turn and stops what still runs in the
  // background, so a worker that started its long check in the background and ended its turn to wait for it never wrote
  // its report (a real task's attempt 10). Background commands are off (CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: measured on
  // 2.1.284, its Bash tool then refuses run_in_background), and a command in the foreground may run half the attempt,
  // at least 10 minutes (the Bash tool's own limit is 2 minutes, 10 at most; with BASH_DEFAULT_TIMEOUT_MS and
  // BASH_MAX_TIMEOUT_MS a 150-second command ran to its end): a long check fits (a real task's verify list took 26 minutes of a
  // 60-minute attempt), and a command that hangs or is cut off still leaves the worker time to write its report.
  workerEnv: ({ timeoutMin = 60 } = {}) => {
    const ms = String(Math.round(Math.max(10, (Number(timeoutMin) || 60) / 2) * 60_000));
    return { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', BASH_DEFAULT_TIMEOUT_MS: ms, BASH_MAX_TIMEOUT_MS: ms };
  },
  // extra: what keeps the owner's own add-ons out of a worker (workerAddons, FR-013)
  headless: ({ prompt, model: m, effort: e, args, role, extra = [] }) => ['-p', prompt, ...model(m), ...effort(e), ...permissions(role, 'headless'), ...json(args), ...args, ...extra],
  // The assistant (Ask): plan mode (it looks, it doesn't change), the read tools and look-only commands allowed, the
  // tools that write or read .env denied (rules.mjs); no MCP servers, and only the account's own settings, not the
  // repository's .claude/settings*.json (a merged task could put allow rules or hooks there); none of
  // engines.claude.args; the question on stdin (-p with no prompt)
  readOnly: ({ model: m, effort: e }) => ['-p', ...model(m), ...effort(e), '--permission-mode', 'plan', '--allowedTools', `Read,Grep,Glob,LS,${bash(ASSISTANT_LOOK)}`, '--disallowedTools', ASSISTANT_DENY_TOOLS.join(','), '--strict-mcp-config', '--setting-sources', 'user', '--output-format', 'stream-json', '--verbose'],
  interactive: ({ prompt, model: m, effort: e, args, role }) => [prompt, ...model(m), ...effort(e), ...permissions(role, 'interactive'), ...args],
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  // What it uses when nextlevel pins nothing: its settings.json (the account's own folder for a named one)
  own({ home, account = '', env = {}, read, path: p }) {
    const dir = account ? accountDir(home, 'claude', account, p) : env.CLAUDE_CONFIG_DIR || p.join(home, '.claude');
    const file = p.join(dir, 'settings.json');
    const s = readJsonText(read(file)) || {};
    const fromEnv = !!env.ANTHROPIC_MODEL;
    return {
      model: fromEnv ? env.ANTHROPIC_MODEL : typeof s.model === 'string' ? s.model : '',
      from: fromEnv ? 'ANTHROPIC_MODEL' : s.model ? file : '',
      effort: typeof s.effortLevel === 'string' ? s.effortLevel : '',
      effortFrom: s.effortLevel ? file : '',
      byDefault: "Claude Code's default for your plan",
    };
  },
  tokens: claudeTokens,
  readable: claudeReadable,
  feed: claudeFeed,
  end: claudeEnd, // how a headless run ended (FR-020)
  usage: { headless: 'its JSON output', interactive: '' },
  models: () => null, // no command lists them: its --model takes these, or a full name
  modelHints: ['opus', 'sonnet', 'haiku', 'fable', 'opusplan', 'best'],
  notes: {
    plan: 'Uses the Claude plan it is signed into (Pro, Max, Team); signed in with an API key it is billed by use instead.',
    orchestrator: 'Plans and reviews on your Claude plan. Autopilot rounds run headless (claude -p), with no window; its git writes go through the hub.',
    worker: 'Each task runs headless (claude -p) in its slot, with no window, on your Claude plan. Its tokens are counted from its JSON output.',
    guide: 'Opens Claude Code in a window of its own; it asks you before it runs anything.',
    assistant: 'Answers each question in a fresh session in plan mode: it reads the project, never changes it (the tools that write, and reading .env, are denied). Its tokens count in Today.',
  },
  knownIssues: [
    'a new cloud session starts only in a real terminal (FR-006); claude -p runs headless locally',
    'it reads CLAUDE.md, not AGENTS.md: the prompt tells it to read AGENTS.md',
    'no sandbox keeps .git read-only: its permission rules keep the orchestrator\'s git writes with the hub',
  ],
};
