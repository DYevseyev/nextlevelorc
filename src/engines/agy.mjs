// Antigravity CLI (agy, Google). The default worker. docs/KNOWN_ISSUES.md#antigravity-cli-agy has the details.
// - Print mode (-p) needs a real console on Windows: with its stdin not a console it drops its output or hangs. With
//   the console as its stdin its output may go to pipes (FR-010, measured on 1.2.11). The hub runs it in a console
//   with no window there (lib/console.mjs: CREATE_NO_WINDOW, and CONIN$ as its stdin), or in a window of its own (workers.window), and
//   reads what it prints; never without a console.
// - Headless it stalled on permission prompts before 1.1.3 (since, its changelog says, it soft-denies them), so it runs
//   with --dangerously-skip-permissions and a deny-list in its settings file (only an extra layer: FR-003, and not
//   enforced on 1.4.0 either). Its sandbox can't run a command on Windows 11 22H2 and doesn't cover its edit tools, and
//   plan mode lets them write (1.4.0): the orchestrator on agy gets nextlevel's own walls (ROLE_AGENTS, lib/rolespec.mjs).
// - A second account: agy has no setting for where it keeps its sign-in (its folder is always ~/.gemini under the
//   user's home), so one PC user has one agy account.
// - Model and level: --model takes a slug, and the level is in its name (gemini-3.8-flash-high is high,
//   claude-opus-5-5-medium is medium, gemini-4-argon-high is high: 1.3.4 names its Claude models so too). nextlevel never
//   passes --effort (not even one in engines.agy.args) and reads the level from the model's name. History: 1.2.11 refused
//   --effort for its Claude models ("--effort is not supported for model claude-opus-4-6-thinking", FR-010), and 1.3.5
//   refuses it with a model whose name has a level ("--model claude-sonnet-5-5-medium conflicts with --effort=high", FR-022).
//   `agy models` lists the models its sign-in may use, "slug<TAB>label" per line (1.1.11 on). The model picked with
//   /model is "model" in ~/.gemini/antigravity-cli/settings.json, as its label ("Gemini 3.8 Flash (High)").
// - A run that fails says why in its own words (FR-022): 1.3.4 puts it in the result's `error` field (a result with
//   status ERROR and an empty response), prints "error: ..." on stderr, and an API failure as an `AGY_ERROR: {...}` line;
//   agyFailure reads them, never just "ERROR".
// - Its steps and tokens: headless runs get --output-format stream-json (1.1.8 on): one JSON object per line, "init",
//   "step_update" (agent_response steps with their text and usage, tool steps with tool_name and tool_info:
//   parameters, and output when done) and a last "result" with `usage` (input_tokens, output_tokens,
//   thinking_tokens, cache_read_tokens, total_tokens = input + output). The feed, the log the dashboard shows and
//   the tokens are read from them. The interactive window's tokens aren't counted.
import { firstLine } from '../checks/lib.mjs';
import { commandEvent, commandOutcome, count, inFolder, jsonLine, lastLines, oneLine, readJsonText, withoutOption } from './util.mjs';
import { WORKER_DENY } from './rules.mjs';

// `agy models`: "slug<TAB>label" per line (one slug per line before 1.1.11), after a "Fetching..." line.
export function parseAgyModels(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ''))
    .map((l) => {
      const [id, ...label] = l.split(/\t|\s{2,}/);
      return { id: id.trim(), label: label.join(' ').trim() || id.trim() };
    })
    .filter(({ id }) => id && /^[\w.:/@+-]+$/.test(id) && !id.endsWith(':') && !/^(models?|name|id|slug|available)$/i.test(id))
    .map((m) => ({ ...m, efforts: [], effort: agyLevel(m.id) || agyLevel(m.label) }));
}

// The level a model's name carries: "gemini-3.8-flash-high", "Gemini 3.8 Flash (High)" and "gemini-4-argon-high" are
// high, "claude-opus-5-5-medium" medium; '' when it has none (an older agy's Claude model: claude-opus-4-6-thinking).
const LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function agyLevel(model) {
  const m = String(model || '').trim().toLowerCase().match(/[-_ (]([a-z]+)\)?$/);
  return m && LEVELS.includes(m[1]) ? m[1] : '';
}

// What it is given on top of engines.agy.args: never --effort (above), and its steps as JSON lines unless the args
// ask for another format.
const noEffort = (args) => withoutOption(args, '--effort');
const streamJson = (args) => (args.includes('--output-format') || args.some((a) => a.startsWith('--output-format=')) ? [] : ['--output-format', 'stream-json']);

// What a headless run used, from its last "result" (or a --output-format json envelope): input and output, like
// Codex's "tokens used" (total_tokens is the two); cache reads apart. null: no result.
const usageOf = (u) => (u && typeof u === 'object' ? { tokens: count(u.input_tokens) + count(u.output_tokens) || count(u.total_tokens), cached: count(u.cache_read_tokens) } : null);
// A run's result: the "result" event of stream-json, or the one object --output-format json prints.
const resultOf = (v) => (v?.event === 'result' ? v.result || {} : v && !v.event && v.conversation_id ? v : null);
// A headless run's outcome, from its last result: { ok, status, response, error } (ok: SUCCESS; error: agy's own words
// for a failure, 1.3.4 on), or null when it printed none.
const text1 = (v) => (typeof v === 'string' ? v : v && typeof v === 'object' ? String(v.message || v.short_error || v.error || '') : '');
export function agyResult(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const r = resultOf(jsonLine(lines[i]));
    if (r) return { ok: /^SUCCESS$/i.test(r.status || ''), status: String(r.status || ''), response: String(r.response ?? ''), error: text1(r.error) };
  }
  return null;
}

// Why a headless run failed, in agy's own words (FR-022: nextlevel showed only "ERROR"): the result's `error` (1.3.4
// on), else its error events, else an `AGY_ERROR: {...}` line (an API failure), else an "error: ..." line it printed,
// else the response of a result that isn't SUCCESS, else its status. `code`: its exit code. -> { reason, status, code,
// last } (reason: one line, '' when it said nothing; last: the last lines it printed, at most `lines`, as a person reads
// them). Not redacted: its caller redacts what it shows (reports' redaction, the MCP servers' strings).
export function agyFailure(text, { code = null, lines: max = 20 } = {}) {
  const all = String(text || '').split(/\r?\n/);
  const result = agyResult(text);
  let fromEvents = '';
  let agyError = '';
  let errorLine = '';
  for (const line of all) {
    const v = jsonLine(line);
    if (v && (v.event === 'error' || (v.error && !v.event && !v.conversation_id))) fromEvents = text1(v.error) || text1(v) || fromEvents;
    const m = line.match(/AGY_ERROR:\s*(\{.*\})\s*$/);
    if (m) {
      const e = jsonLine(m[1]);
      agyError = (e && (text1(e.short_error) || text1(e.message) || text1(e.error) || text1(e.status))) || agyError;
    }
    const plain = line.trim().match(/^(?:error|Error|ERROR|fatal):\s*(.+)$/) || line.trim().match(/^(flags? provided but not defined: .+)$/);
    if (plain && !v) errorLine = plain[1];
  }
  const status = result?.status || '';
  const response = result && !result.ok ? result.response.trim() : '';
  const reason = oneLine(result?.error || fromEvents || agyError || errorLine || (response ? firstLine(response) : '') || (result && !result.ok ? status : ''), 400);
  return { reason, status, code, last: lastLines(agyReadable(text) ?? text, max) };
}

// How a headless run ended, by agy's own account (FR-020): its result's status (SUCCESS, ERROR...), whether that is an
// error (a result that isn't SUCCESS: a stop with an exit code and no result isn't one, it is the engine stopping), why
// (agyFailure), its last answer when it ended well, and its last lines. Not redacted.
export function agyEnd(text, { code = null } = {}) {
  const f = agyFailure(text, { code });
  const r = agyResult(text);
  return { status: f.status, error: !!r && !r.ok, reason: f.reason, turns: null, said: r?.ok ? oneLine(firstLine(r.response), 300) : '', stopped: 0, last: f.last };
}

// Every string in the owner's MCP servers' settings (~/.gemini/config/mcp_config.json): their args, env and headers,
// where a key can look like nothing secret (Stitch's --header on a real PC). What agy prints about a failure is
// redacted with them (FR-022). Six characters at least: shorter ones (-y, npx) are no secret worth blanking out.
export function agyMcpStrings({ home, read, path: p }) {
  const servers = looseJson(read(p.join(home, '.gemini', 'config', 'mcp_config.json')))?.mcpServers || {};
  const out = new Set();
  const add = (v) => {
    if (typeof v === 'string' && v.trim().length >= 6) out.add(v.trim());
    else if (Array.isArray(v)) v.forEach(add);
    else if (v && typeof v === 'object') Object.values(v).forEach(add);
  };
  for (const s of Object.values(servers)) {
    if (!s || typeof s !== 'object') continue;
    add(s.args);
    add(s.env);
    add(s.headers);
  }
  // (a value can carry a key after a word: "Bearer <key>", "X-Api-Key: <key>", "--api-key=<key>")
  for (const v of [...out]) for (const part of v.split(/[\s:=]+/)) if (part.length >= 12) out.add(part);
  return [...out];
}
export function agyTokens(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = usageOf(resultOf(jsonLine(lines[i]))?.usage);
    if (t) return t;
  }
  return null;
}

// A tool step as an event of the feed (util.mjs): a command, a file written or edited, another tool; null for the
// ones that only look (view_file, list_dir, grep_search...) or keep its own notes.
const LOOKS = new Set(['view_file', 'list_dir', 'grep_search', 'find_by_name', 'command_status', 'read_resource', 'list_resources', 'list_permissions', 'wait', 'wait_5_seconds', 'manage_task', 'manage_inbox', 'finish', 'ask_permission', 'ask_custom_permission']);
function toolEvent(name, params = {}, cwd = '') {
  const file = params.TargetFile || params.AbsolutePath || params.File || params.Path || '';
  if (name === 'run_command') return commandEvent(params.CommandLine || params.Command || '');
  if (name === 'write_to_file') return { kind: 'edit', text: `wrote ${inFolder(file, cwd)}`, detail: '', ok: undefined };
  if (['replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit'].includes(name)) return { kind: 'edit', text: `edited ${inFolder(file, cwd)}`, detail: '', ok: undefined };
  if (LOOKS.has(name)) return null;
  if (name === 'search_web') return { kind: 'tool', text: `searched the web: ${oneLine(params.query || params.Query, 160)}`, detail: '', ok: undefined };
  if (name === 'read_url_content') return { kind: 'tool', text: `fetched ${oneLine(params.Url || params.url, 160)}`, detail: '', ok: undefined };
  if (name === 'call_mcp_tool') return { kind: 'tool', text: `an MCP tool: ${oneLine(params.ToolName || params.name || '', 120)}`, detail: '', ok: undefined };
  if (/subagent/.test(name)) return { kind: 'tool', text: `a subagent: ${oneLine(params.Task || params.Prompt || params.Name || name, 160)}`, detail: '', ok: undefined };
  return { kind: 'tool', text: oneLine(name, 80), detail: '', ok: undefined };
}
const failed = (s) => /^(ERROR|FAILED|CANCELED|CANCELLED)$/i.test(String(s || ''));

// A message of its own: 1.2.11 sent it whole in its DONE step; 1.3.5 streams it, a piece in each ACTIVE step of the same
// step_index, then DONE (test/fixtures/agy-1.3.5-stream-json.txt, FR-022). The pieces are put together, and the message
// is there once its step is DONE. -> its text, or null (not done yet, or empty)
function messageOf(s, buffers) {
  const key = `${s.conversation_id || ''}#${s.step_index}`;
  const text = (buffers.get(key) || '') + String(s.text_delta || '');
  if (s.state === 'ACTIVE') {
    buffers.set(key, text);
    if (buffers.size > 200) buffers.delete(buffers.keys().next().value);
    return null;
  }
  buffers.delete(key);
  return text.trim() ? text : null;
}
// (agyReadable gets one line at a time from a worker's log as it is written: the pieces wait here between its calls)
const STREAMED = new Map();

// What a headless run did, from its stream-json lines, oldest first: commands with what came of them, files written
// or edited, its messages, and the end. A tool step comes twice (ACTIVE, then DONE with its output): one event.
export function agyFeed(text, { cwd = '', buffers = new Map() } = {}) {
  const events = [];
  const steps = new Map(); // step_index -> its event
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = jsonLine(line);
    if (!v) continue;
    if (v.event === 'step_update') {
      const s = v.step_update || {};
      if (s.step_type === 'agent_response') {
        const said = messageOf(s, buffers);
        if (said) events.push({ kind: 'message', text: oneLine(firstLine(said), 240), detail: '', ok: undefined });
        continue;
      }
      if (s.step_type !== 'tool') continue;
      let e = steps.get(s.step_index);
      if (!e && !steps.has(s.step_index)) {
        e = toolEvent(s.tool_name || s.tool_info?.name || '', s.tool_info?.parameters || {}, cwd);
        steps.set(s.step_index, e);
        if (e) events.push(e);
      }
      if (!e || s.state === 'ACTIVE') continue;
      const output = typeof s.tool_info?.output === 'string' ? s.tool_info.output : '';
      // (a step's error: a text, or on 1.3.5 an object in tool_info, { type, message })
      const error = text1(s.error) || text1(s.tool_info?.error);
      // (its JSON doesn't say a command's exit code: only a step that failed is known to have failed)
      if (e.kind === 'command' || e.kind === 'test') commandOutcome(e, output || error, failed(s.state) || error ? false : undefined);
      else if (failed(s.state) || error) Object.assign(e, { ok: false, detail: `failed${error ? `: ${oneLine(error, 160)}` : ''}` });
      else e.ok = true;
    } else if (v.event === 'result') {
      const r = v.result || {};
      const ok = /^SUCCESS$/i.test(r.status || '');
      events.push({ kind: 'done', text: ok ? 'finished' : `finished: ${oneLine(r.status || 'no status', 60)}`, detail: r.num_turns ? `${r.num_turns} turn(s)` : '', ok });
    } else if (v.event === 'error' || v.error) {
      events.push({ kind: 'error', text: oneLine(v.error?.message || v.error || v.message || 'error', 240), detail: '', ok: false });
    }
  }
  return events;
}

// A log with its JSON as a person reads it (the dashboard shows a log this way, and a worker's window shows each line
// so): each step as a line ("$ npm test", "wrote src/a.js", its text), the result as the answer and what it used;
// lines that aren't its JSON as they are. null when there is none of its JSON in it.
const n = (x) => Number(x || 0).toLocaleString('en-US');
export function agyReadable(text) {
  let any = false;
  const out = [];
  const lines = String(text || '').split(/\r?\n/);
  const buffers = lines.filter((l) => l.trim()).length > 1 ? new Map() : STREAMED;
  for (const line of lines) {
    const v = jsonLine(line);
    if (!v || (!v.event && !v.conversation_id)) {
      out.push(line);
      continue;
    }
    any = true;
    const r = resultOf(v);
    if (r) {
      const t = usageOf(r.usage);
      const status = /^SUCCESS$/i.test(r.status || '') ? '' : `, ${r.status || 'no status'}`;
      out.push(`${String(r.response ?? '').trimEnd()}\n\n[Antigravity${status}: ${r.num_turns ?? '?'} turn(s), ${n(t?.tokens)} tokens${t?.cached ? `, ${n(t.cached)} more read from its cache` : ''}]`);
      continue;
    }
    const s = v.step_update;
    if (v.event === 'step_update' && s?.step_type === 'tool' && s.state === 'ACTIVE') continue; // shown once, when done
    for (const e of agyFeed(line, { buffers })) out.push(e.kind === 'command' || e.kind === 'test' ? `$ ${e.text}${e.detail ? `  → ${e.detail}` : ''}` : e.kind === 'message' ? `Antigravity: ${e.text}` : `${e.text}${e.ok === false && e.detail ? ` (${e.detail})` : ''}`);
  }
  return any ? out.join('\n') : null;
}

// ---------- a worker without the owner's own add-ons (FR-013) ----------
// agy loads the owner's global customizations into every session, `-p` too: the rules in ~/.gemini/GEMINI.md, skills,
// plugins and hooks under ~/.gemini/config/, and the MCP servers in ~/.gemini/config/mcp_config.json. A worker runs as
// a custom agent the hub writes into its slot (.agents/agents/nextlevel-worker.md, run with --agent) that inherits none
// of them: `inheritCustomizations: false` (skills, rules, plugins, subagents) and `inheritMcp: false` (the MCP servers'
// tools). Measured on 1.2.12: the prompt went from 28 800 to 6 000 input tokens, and the owner's global rules were gone,
// but so was the project's AGENTS.md (the worker is told to read it) and agy still started every MCP server's process
// (they aren't in the worker's tools, but they run: nothing documented keeps them from starting for one session).
// A missing agent file wasn't an error to agy before 1.3.4: it ran its default agent, with everything; 1.3.4 refuses an
// --agent it can't find (exit 1, "unknown agent"). The hub writes the file at every task start. What nextlevel.json lets
// workers keep (workers.addons) switches the part that holds it back on.
// FR-022: its frontmatter is YAML, and every text in it is quoted. The description used to be plain ("...build team: one
// task..."), whose second ": " makes the line invalid YAML: agy 1.3.2 read it anyway (the 9 October workers ran as the
// agent), 1.3.4 and 1.3.5 drop the file, so every worker and the model check failed with "unknown agent". A quoted text
// is valid YAML for every agy, so there is one file for all of them.
// FR-022 too: on 1.3.5 an agent without a `tools:` list gets only tools that look (view_file, search_web, manage_task...):
// the first real worker answered "Status: BLOCKED... no file-write tools available in this session", where 1.3.2 gave
// the agent the default tools (the 9 October workers wrote and ran commands). So after 1.3.2 the file lists the tools a
// worker needs, all of them agy's own (none of the owner's MCP servers or plugins: FR-013 holds); each name is one 1.3.5's
// registry knows (it refuses an agent that names one it doesn't, "unknown component: tool ... not found in registry":
// command_status, send_command_input, sed_file and notebook_execution are such). For 1.3.2 and before the file stays as
// it was, without the list (decided from `agy --version`).
export const WORKER_TOOLS = ['view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'notebook_edit', 'run_command', 'list_dir', 'grep_search', 'find_by_name', 'manage_task', 'wait', 'search_web', 'read_url_content'];
export const TOOLS_AFTER = '1.3.2'; // the last agy whose custom agents got the default tools
export const listsTools = (version) => {
  const v = String(version || '').match(/(\d+)\.(\d+)\.(\d+)/);
  if (!v) return true; // (an agy that doesn't say: as the newest)
  const [a, b, c] = v.slice(1).map(Number);
  const [x, y, z] = TOOLS_AFTER.split('.').map(Number);
  return a > x || (a === x && (b > y || (b === y && c > z)));
};
export const WORKER_AGENT = 'nextlevel-worker';
export const WORKER_AGENT_FILE = ['.agents', 'agents', `${WORKER_AGENT}.md`];
const yamlText = (s) => JSON.stringify(String(s)); // a double-quoted YAML scalar: JSON's escapes are YAML's
// An agent file of nextlevel's: quoted YAML frontmatter (FR-022), what of the owner's add-ons it inherits, its tools (after
// 1.3.2), and its body
function agentFile({ name, description, body, customizations = false, mcp = false, tools = null }) {
  return [
    '---',
    `name: ${yamlText(name)}`,
    `description: ${yamlText(description)}`,
    `inheritCustomizations: ${customizations}`,
    `inheritMcp: ${mcp}`,
    ...(tools ? ['tools:', ...tools.map((t) => `  - ${yamlText(t)}`)] : []),
    '---',
    ...body,
    '',
  ].join('\n');
}
export function agyWorkerAgent({ customizations = false, mcp = false, tools = null } = {}) {
  return agentFile({
    name: WORKER_AGENT,
    description: "A worker of nextlevel's build team: one task in its slot. Written by the nextlevel hub at every task start.",
    customizations,
    mcp,
    tools,
    body: [
      "You are a worker of a nextlevel build team, started by its hub for one task. The team's rules and your role are in",
      'AGENTS.md and the worker guide the prompt names, your task in the task file it names: read them before you start.',
    ],
  });
}

// ---------- the orchestrator on Antigravity (docs/design/antigravity-roles.md) ----------
// Its window and its autopilot rounds run as an agent of nextlevel's too, written by the hub into the main checkout before
// each start: none of the owner's MCP servers, skills, rules, plugins or hooks (measured on 1.4.0: a round as agy's default
// agent reached the owner's GitHub MCP server, which nextlevel's push block can't reach; as this agent the tool was gone),
// the workers' tools, and a body that says how pushes go. Its environment has the push block (lib/pushblock.mjs).
export const ROLE_AGENTS = { orchestrator: 'nextlevel-orchestrator', assistant: 'nextlevel-assistant' };
export const roleAgentFile = (role) => ['.agents', 'agents', `${ROLE_AGENTS[role]}.md`];
const NEVER_AROUND = [
  "Your git and gh have no access to the remotes or to GitHub: if git or gh says a push or a GitHub call is blocked, stop",
  "and say so. Never work around it: don't clear or change environment variables, git's settings or sign-ins, and don't",
  'use another tool to reach GitHub.',
];
const ROLE_BODIES = {
  orchestrator: [
    "You are the orchestrator of a nextlevel build team, started by its hub. The team's rules and your role are in AGENTS.md",
    'and the orchestrator guide the prompt names: read them before you start.',
    '',
    'Pushes go through `nextlevel push <branch>`, never through git itself.',
    ...NEVER_AROUND,
  ],
  // The assistant (Ask) works in a throwaway copy of the project, made for its question (src/ask.mjs). What it may do is the
  // question's briefing's to say (read-only); the agent says where it is. (With "never edit" here too, Argon declined every
  // try of the lock test that changes something, so the lock test couldn't prove where a change lands: measured on 1.4.0.)
  assistant: [
    "You are the owner's assistant for a nextlevel project. You work in a copy of the project made for this session, which",
    'is thrown away after it: what you write lands in the copy, never in the project. The nextlevel commands you run read',
    'the real project, and only the ones that look run there.',
    ...NEVER_AROUND,
  ],
};
export function agyRoleAgent(role, { version = '' } = {}) {
  const name = ROLE_AGENTS[role];
  if (!name) throw new Error(`no Antigravity agent for the ${role}`);
  return agentFile({
    name,
    description: role === 'assistant' ? "The owner's read-only assistant (nextlevel ask), in a copy of the project. Written by nextlevel for each question." : `The ${role} of nextlevel's build team. Written by the nextlevel hub before each start.`,
    tools: listsTools(version) ? WORKER_TOOLS : null,
    body: ROLE_BODIES[role],
  });
}

// JSON as agy reads it: comments (// and /* */) and trailing commas allowed, a byte order mark too. null: not JSON.
export function looseJson(text) {
  if (text === null || text === undefined) return null;
  const t = String(text).replace(/^﻿/, '');
  let out = '';
  for (let i = 0, str = false; i < t.length; i++) {
    const c = t[i];
    if (str) {
      out += c;
      if (c === '\\') out += t[++i] ?? '';
      else if (c === '"') str = false;
    } else if (c === '"') {
      str = true;
      out += c;
    } else if (c === '/' && t[i + 1] === '/') while (i < t.length && t[i] !== '\n') i++;
    else if (c === '/' && t[i + 1] === '*') {
      i += 2;
      while (i < t.length && !(t[i] === '*' && t[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return readJsonText(out.replace(/,(\s*[}\]])/g, '$1'));
}

// The owner's global add-ons for agy, from its files: { mcpServers: [{ name, command }], skills, plugins, hooks, rules,
// files } (names; files: where they are). The processes of the MCP servers start with every agy session.
export function agyAddons({ home, read, list = () => [], path: p }) {
  const dir = p.join(home, '.gemini', 'config');
  const mcpFile = p.join(dir, 'mcp_config.json');
  const mcp = looseJson(read(mcpFile))?.mcpServers || {};
  const mcpServers = Object.entries(mcp)
    .filter(([, s]) => s && typeof s === 'object' && s.disabled !== true)
    // (the program only: a server's arguments hold its keys too, Stitch's --header on a real PC)
    .map(([name, s]) => ({ name, command: typeof s.command === 'string' ? s.command : s.serverUrl || s.url || s.httpUrl ? 'a remote server' : '' }));
  const pluginState = looseJson(read(p.join(dir, 'config.json')))?.plugins || {};
  const plugins = list(p.join(dir, 'plugins')).filter((n) => pluginState[n]?.enabled !== false);
  const skills = list(p.join(dir, 'skills')).filter((n) => !n.startsWith('.'));
  const hooksFile = p.join(dir, 'hooks.json');
  const hooks = Object.keys(looseJson(read(hooksFile)) || {});
  const rulesFile = p.join(home, '.gemini', 'GEMINI.md');
  const rules = String(read(rulesFile) || '').trim() ? ['GEMINI.md'] : [];
  return { mcpServers, skills, plugins, hooks, rules, files: { mcp: mcpFile, config: dir, rules: rulesFile } };
}

// What a worker gets on top of its arguments, and what it still can't be kept from (FR-013): `keep` is workers.addons;
// `version`: agy's (`agy --version`), which says whether the agent lists its tools (FR-022).
function agyWorker(keep = {}, found = {}, { version = '' } = {}) {
  const customizations = !!(keep.skills || keep.hooks);
  const mcp = (keep.mcpServers || []).length > 0;
  const left = [{ what: 'mcp-processes', text: "agy starts every MCP server in ~/.gemini/config/mcp_config.json for every session, a worker's too: its tools stay out of the worker, but the servers' processes run (no documented flag or setting keeps them from starting for one session)" }];
  if (mcp) left.push({ what: 'mcp-some', text: 'agy has no way to give a session only some of the MCP servers: listing any in workers.addons.mcpServers gives the workers all of them' });
  if (customizations && !(keep.skills && keep.hooks)) left.push({ what: 'custom-some', text: "agy keeps skills, rules, plugins and hooks together: workers.addons.skills or .hooks gives the workers all of the owner's own customizations" });
  if (customizations && mcp) return { args: [], files: [], readsAgentsMd: true, left };
  return {
    args: ['--agent', WORKER_AGENT],
    files: [{ path: WORKER_AGENT_FILE, text: agyWorkerAgent({ customizations, mcp, tools: listsTools(version) ? WORKER_TOOLS : null }) }],
    // (without its customizations the agent doesn't get the project's AGENTS.md either: the prompt names it)
    readsAgentsMd: customizations,
    left,
  };
}

export default {
  name: 'agy',
  title: 'Antigravity',
  command: 'agy',
  window: 'agy',
  // The installer puts agy.exe in %USERPROFILE%\.local\bin, which a console opened before the install doesn't have
  // on PATH (FR-001 #4); newer installers use %LOCALAPPDATA%\agy\bin
  binPaths: (home, platform) => (platform === 'win32' ? [[home, '.local', 'bin', 'agy.exe'], [home, 'AppData', 'Local', 'agy', 'bin', 'agy.exe']] : []),
  defaultArgs: ['--dangerously-skip-permissions', '--mode', 'accept-edits'],
  // FR-017: a role it runs with no permission check. Headless it has to (--dangerously-skip-permissions, or it stalls on
  // a prompt), and the orchestrator's window and the assistant (in its copy of the project) get the same arguments; the
  // setup guide gets none of them (it asks).
  // facts.asksNothing: the owner's own agy settings approve every command (checks/argon.mjs agyOwnSettings), so the setup
  // guide, which gets none of nextlevel's flags, doesn't ask either
  fullAccess: (args, role, facts = {}) =>
    role === 'guide' ? (facts.asksNothing ? "your own Antigravity settings approve every command without asking (always-proceed, or a global command(*) grant), so it doesn't ask before it runs one" : '')
    : args.includes('--dangerously-skip-permissions') ?'Antigravity skips its permission checks for it (--dangerously-skip-permissions in engines.agy.args, which it needs to run unattended)'
    : '',
  readsAgentsMd: true,
  writesGit: true,
  needsRealConsole: (platform) => platform === 'win32',
  addons: agyAddons, // the owner's own add-ons, and what keeps them out of a worker (FR-013)
  workerAddons: agyWorker,
  // For the sessions nextlevel starts headless (workers, autopilot rounds, the model trial): no background updater. It
  // runs `agy.exe --version` in a console window of its own, which flashed and once took the focus (FR-011); measured on
  // 1.2.12, `true` keeps it from starting (`1` doesn't). Not documented by agy: agy updates itself in the owner's own
  // sessions, and `agy update` does it by hand (docs/upstream/antigravity-updater-console-window.md).
  headlessEnv: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
  account: null,
  noAccount:
    "Antigravity CLI can't keep a second account apart: it has no setting for where it keeps its sign-in " +
    '(always .gemini in your home folder), so every agy session on this PC user uses the account agy is signed in with',
  login: { status: ['models'], statusTimeoutMs: 30_000, signIn: [], signInText: 'sign in with the account whose plan the workers use, then /model inside agy' },
  loginResult: (r) => (r.ok ? { ok: true, detail: 'signed in' } : { ok: false, detail: r.timedOut ? 'unknown (no answer)' : 'not signed in', unknown: !!r.timedOut }),
  // -p runs one prompt and exits; --print-timeout: the task's limit
  // extra: what keeps the owner's own add-ons out of a worker (workerAddons, FR-013)
  headless: ({ prompt, model, args, timeoutMin, extra = [] }) => ['-p', prompt, '--print-timeout', `${Math.max(1, Math.ceil(timeoutMin))}m`, ...(model ? ['--model', model] : []), ...streamJson(args), ...noEffort(args), ...extra],
  // -i: an interactive session that starts with the prompt. The setup guide gets none of the unattended arguments
  // (the owner is there, and it asks before it runs things).
  // No read-only mode: the assistant on it answers in a throwaway copy of the project (lib/askcopy.mjs)
  readOnly: null,
  // extra: the orchestrator's agent (--agent nextlevel-orchestrator, ROLE_AGENTS)
  interactive: ({ prompt, model, args, role, extra = [] }) => ['-i', prompt, ...(model ? ['--model', model] : []), ...(role === 'guide' ? [] : noEffort(args)), ...extra],
  // No effort setting: the level is in the model's name (effortOf), so the Team page has no Effort field for it
  efforts: [],
  effortOf: agyLevel,
  effortNote: "Antigravity takes the level from the model's name (gemini-3.8-flash-high is high, claude-opus-5-5-medium is medium): pick the model with the level you want. nextlevel doesn't pass --effort.",
  // What it uses when nextlevel pins nothing: the model picked with /model inside agy (its settings file, as the
  // model's label; none there: agy's default), and the level that label carries
  own({ home, read, path: p }) {
    const file = p.join(home, '.gemini', 'antigravity-cli', 'settings.json');
    const model = readJsonText(read(file))?.model;
    const own = typeof model === 'string' ? model : '';
    return { model: own, from: own ? file : '', effort: agyLevel(own), effortFrom: agyLevel(own) ? "the model's name" : '', byDefault: "agy's default model" };
  },
  tokens: agyTokens,
  readable: agyReadable,
  feed: agyFeed,
  // how a headless run ended (FR-020), why it failed in its own words, and what of its settings is redacted from
  // that (FR-022)
  end: agyEnd,
  secretStrings: agyMcpStrings,
  usage: { headless: 'its stream-json output', interactive: '' },
  models(run) {
    const r = run('agy', ['models'], { timeoutMs: 30_000 });
    const list = r.ok ? parseAgyModels(r.out) : [];
    return list.length ? { list, from: 'agy models' } : null;
  },
  notes: {
    plan: 'Uses the Google plan agy is signed into (for example Ultra). One agy account per PC user.',
    orchestrator: "Its autopilot rounds run as nextlevel's own agent, without your MCP servers and add-ons, and with git pushes and GitHub switched off (it pushes with nextlevel push). It starts only once its lock test passes on this agy version; the hub runs it again after an agy update. Rounds run headless (on Windows in a console with no window), and their steps and tokens are read from its output. Its window doesn't open on Antigravity: agy 1.4.0's window runs its default agent, with your add-ons (KNOWN_ISSUES).",
    worker: 'On Windows each task runs in a console with no window (agy needs a real console), unless Worker windows says otherwise; its steps show here, and its tokens count in Today.',
    guide: "Opens agy in a window of its own, with your own Antigravity settings: it asks before it runs things only if they say so (the doctor's agy.permissions shows what they approve). Its tokens aren't counted.",
    assistant: "It answers in a copy of your project made for each question and thrown away after, as nextlevel's own agent (without your MCP servers), with git pushes and GitHub switched off; nothing of Antigravity's own keeps it read-only, so what it writes lands in the copy. It starts only once its lock test passes on this agy version. Its tokens count in Today.",
  },
  // The rules in ~/.gemini/antigravity-cli/settings.json (agy.deny-list)
  denyRules: WORKER_DENY.map((c) => `command(${c})`),
  knownIssues: [
    'print mode needs a real console on Windows: the hub gives it one with no window (CREATE_NO_WINDOW, and CONIN$ as its stdin)',
    "it starts every MCP server in the owner's global config for every session: a worker runs as an agent that gets none of their tools, but their processes still run (FR-013)",
    'its background updater runs agy.exe --version in a console window of its own: headless sessions get AGY_CLI_DISABLE_AUTO_UPDATE=true (FR-011)',
    'headless it stalled on permission prompts before 1.1.3: it runs with --dangerously-skip-permissions and a deny-list',
    "its sandbox can't run a command on Windows 11 before 24H2 with the August 2026 update, and doesn't cover its edit tools; plan mode lets them write (1.4.0): the orchestrator on it runs behind nextlevel's push block and agent, proven by its lock test",
    "the deny-list wasn't enforced on 1.2.11 (FR-003), nor on 1.4.0: git refuses pushes from slots, and the bridge test proves it",
    "the level is in the model's name (gemini-3.8-flash-high, claude-opus-5-5-medium): nextlevel never passes --effort, which older agy refused for its Claude models (FR-010) and 1.3.5 refuses beside a model with a level",
    "1.3.4 refuses an agent file it can't read (unknown agent, exit 1) where 1.3.2 read it: the worker's agent file is quoted YAML (FR-022)",
    'no setting for its folder: one agy account per PC user',
  ],
};
