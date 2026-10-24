// Codex CLI (OpenAI). The default orchestrator. docs/KNOWN_ISSUES.md#codex-cli has the details.
// - `codex exec` is properly headless: no console needed, the hub reads its output from a file.
// - Its sandbox (workspace-write) keeps .git read-only: an orchestrator commits through the hub, and a
//   Codex worker can't commit or merge in its slot either (a slot's git folder is under the project's .git:
//   "Unable to create .../.git/worktrees/w1/ORIG_HEAD.lock: Permission denied", FR-008). The hub merges the
//   base branch in before a retry and commits what the worker leaves.
// - Tokens and the feed: `codex exec --json` prints its steps as JSON lines (codex-rs exec_events: "item.started"
//   and "item.completed" with an item of type command_execution (command, aggregated_output, exit_code),
//   file_change (changes: path and kind), agent_message, mcp_tool_call, web_search, error; "turn.completed" with
//   `usage`: input_tokens, cached_input_tokens, output_tokens, the session's running total). Without --json it
//   prints "tokens used" at the end instead (an older run's log). An interactive session's tokens are in its
//   session file ($CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl): "token_count" events with the running total.
// - A second account: CODEX_HOME moves Codex's whole folder (config.toml, auth.json, logs, sessions).
//   A login kept in the system's keyring is named after the folder (a hash of its path), so two folders
//   stay apart in every credential store (codex-rs 0.157: login/src/auth/storage.rs). The folder must
//   exist before Codex starts.
// - Model and effort: -m picks the model; the effort is only a setting (model_reasoning_effort), which
//   `codex exec` gets with -c (exec never uses the shared background server). An interactive session gets
//   no -c (it would leave that server, FR-004 #6), so there it is Codex's own. Codex's own choice is `model`
//   and `model_reasoning_effort` in its config.toml (what /model inside Codex saves; an effort left at the
//   model's default is removed), else the account's default model and the model's default effort, from
//   models_cache.json. `codex debug models` prints the account's models as JSON ({"models":[...]}).
import { firstLine, tomlTop } from '../checks/lib.mjs';
import { codexTokens } from '../lib/overview.mjs';
import { accountDir, commandEvent, commandOutcome, count, inFolder, jsonLine, lastLines, oneLine, readJsonText } from './util.mjs';

// The account's models from `codex debug models` (JSON): [{ id, label, efforts, effort }]. Read loosely: the
// list may be the whole answer or under "models"/"data", with each model's efforts as words or objects.
export function parseCodexModels(text) {
  const t = String(text || '');
  const json = readJsonText(t.slice(Math.min(...['[', '{'].map((c) => (t.indexOf(c) < 0 ? Infinity : t.indexOf(c))))));
  const items = Array.isArray(json) ? json : json?.models || json?.data || [];
  if (!Array.isArray(items)) return [];
  const word = (x) => (typeof x === 'string' ? x : x?.effort || x?.reasoning_effort || x?.id || '');
  return items
    .map((m) => (typeof m === 'string' ? { slug: m } : m || {}))
    .map((m) => ({
      id: String(m.slug || m.id || m.model || m.name || ''),
      label: String(m.display_name || m.displayName || m.slug || m.id || m.model || ''),
      efforts: (m.supported_reasoning_efforts || m.supported_reasoning_levels || m.reasoning_efforts || []).map(word).filter(Boolean),
      effort: word(m.default_reasoning_effort ?? m.default_reasoning_level ?? ''),
      priority: Number.isFinite(m.priority) ? m.priority : Infinity,
      hidden: m.visibility === 'hide' || m.visibility === 'none' || m.hidden === true,
    }))
    .filter((m) => m.id && !m.hidden)
    .map(({ hidden, ...m }) => m);
}
// Codex's folder for a profile: the account's own, else CODEX_HOME, else ~/.codex.
export const codexHome = ({ home, account = '', env = {}, path: p }) => (account ? accountDir(home, 'codex', account, p) : env.CODEX_HOME || p.join(home, '.codex'));

// A session file's tokens, counted like "tokens used": input without the cached part, plus output, from its
// last "token_count" event (the session's running total; the same total comes again after a compaction, so
// only the last one counts). { tokens, cached } or null.
export function rolloutTokens(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    const u = readJsonText(lines[i])?.payload?.info?.total_token_usage;
    if (!u) continue;
    const cached = count(u.cached_input_tokens);
    const tokens = u.input_tokens !== undefined ? Math.max(0, count(u.input_tokens) - cached) + count(u.output_tokens) : Math.max(0, count(u.total_tokens) - cached);
    return { tokens, cached };
  }
  return null;
}
// The interactive sessions Codex ran in `cwd` between `since` and `until` (ms), from its session files: their
// first line ("session_meta") has the folder and the time it started; `codex exec` runs (autopilot rounds,
// workers) are counted from their own output and left out here. `skip`: files counted already.
// -> { tokens, cached, files } (files: their names), or null when there are none. `list(dir)`: its file names.
export function sessionTokens({ dir, cwd, since, until = Date.now(), read, list, path: p, same = (a, b) => a === b, skip = [] }) {
  const files = [];
  const pad = (n) => String(n).padStart(2, '0');
  // Its folders are per day; a day either side covers any time zone
  for (let t = since - 86_400_000; t <= until + 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    for (const [y, m, day] of [[d.getFullYear(), d.getMonth() + 1, d.getDate()], [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()]]) {
      const folder = p.join(dir, 'sessions', String(y), pad(m), pad(day));
      for (const name of list(folder)) if (/^rollout-.*\.jsonl$/.test(name) && !files.some((f) => f.name === name)) files.push({ name, file: p.join(folder, name) });
    }
  }
  let tokens = 0;
  let cached = 0;
  const used = [];
  for (const { name, file } of files) {
    if (skip.includes(name)) continue;
    const text = read(file);
    if (!text) continue;
    const nl = text.indexOf('\n');
    const meta = readJsonText(nl < 0 ? text : text.slice(0, nl));
    const m = meta?.type === 'session_meta' ? meta.payload || {} : null;
    if (!m) continue;
    const at = Date.parse(m.timestamp || meta.timestamp || '');
    const source = typeof m.source === 'string' ? m.source : '';
    if (!(at >= since - 5000 && at <= until) || !m.cwd || !same(m.cwd, cwd) || /exec/i.test(`${source} ${m.originator || ''}`)) continue;
    const t = rolloutTokens(text);
    if (!t) continue;
    tokens += t.tokens;
    cached += t.cached;
    used.push(name);
  }
  return used.length ? { tokens, cached, files: used } : null;
}

// The command Codex ran, without the shell it wrapped it in: bash -lc 'npm test' -> npm test.
function bareCommand(command) {
  if (Array.isArray(command)) {
    const shell = /(^|[\\/])(bash|zsh|sh|powershell|pwsh)(\.exe)?$/i.test(String(command[0] || ''));
    const at = command.findIndex((a, i) => i > 0 && /^(-l?c|-Command)$/i.test(a));
    if (shell && at > 0 && at < command.length - 1) return command.slice(at + 1).join(' ');
  }
  const c = Array.isArray(command) ? command.join(' ') : String(command || '');
  const m = c.match(/^(?:\S*[\\/])?(?:bash|zsh|sh)(?:\.exe)?\s+-l?c\s+(['"])([\s\S]*)\1\s*$/) || c.match(/^(?:\S*[\\/])?(?:powershell|pwsh)(?:\.exe)?\s+(?:-\w+\s+)*-Command\s+(['"])([\s\S]*)\1\s*$/i);
  return m ? m[2] : c;
}

// What `codex exec --json` did, from its JSON lines, oldest first: commands with what came of them, files
// changed, its messages, errors. [] for a log without them (an older run without --json). Codex's older JSON
// (`{"msg":{"type":"exec_command_begin",...}}`) is read too.
export function codexFeed(text, { cwd = '' } = {}) {
  const events = [];
  const byId = new Map(); // item or call id -> its event
  const command = (id, cmd) => {
    let e = byId.get(id);
    if (!e) {
      e = commandEvent(bareCommand(cmd));
      events.push(e);
      if (id) byId.set(id, e);
    }
    return e;
  };
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = jsonLine(line);
    if (!v) continue;
    const it = v.item;
    if (it && /^item\.(started|updated|completed)$/.test(v.type)) {
      const done = v.type === 'item.completed';
      if (it.type === 'command_execution') {
        const e = command(it.id, it.command);
        if (done || it.exit_code !== null && it.exit_code !== undefined) commandOutcome(e, it.aggregated_output, it.exit_code === 0 && it.status !== 'failed');
      } else if (it.type === 'file_change' && done) {
        const files = (Array.isArray(it.changes) ? it.changes : []).map((c) => `${c.kind === 'add' ? 'added' : c.kind === 'delete' ? 'deleted' : 'edited'} ${inFolder(c.path, cwd)}`);
        events.push({ kind: 'edit', text: oneLine(files.join(', ') || 'changed files', 240), detail: '', ok: it.status === 'failed' ? false : true });
      } else if (it.type === 'agent_message' && done && String(it.text || '').trim()) {
        events.push({ kind: 'message', text: oneLine(String(it.text).split(/\r?\n/).find((l) => l.trim()), 240), detail: '', ok: undefined });
      } else if (it.type === 'mcp_tool_call' && done) {
        events.push({ kind: 'tool', text: oneLine(`${it.server || 'tool'}.${it.tool || ''}`, 120), detail: '', ok: it.status !== 'failed' });
      } else if (it.type === 'web_search' && done) {
        events.push({ kind: 'tool', text: `searched the web: ${oneLine(it.query, 160)}`, detail: '', ok: undefined });
      } else if (it.type === 'error' && done) events.push({ kind: 'error', text: oneLine(it.message, 240), detail: '', ok: false });
      continue;
    }
    if (v.type === 'turn.failed') events.push({ kind: 'error', text: oneLine(v.error?.message || 'the turn failed', 240), detail: '', ok: false });
    else if (v.type === 'error') events.push({ kind: 'error', text: oneLine(v.message || 'error', 240), detail: '', ok: false });
    // Codex's older JSON events
    const m = v.msg;
    if (!m || typeof m !== 'object') continue;
    if (m.type === 'exec_command_begin') command(m.call_id, m.command);
    else if (m.type === 'exec_command_end') commandOutcome(command(m.call_id, m.command), m.aggregated_output ?? `${m.stdout || ''}${m.stderr || ''}`, m.exit_code === 0);
    else if (m.type === 'patch_apply_begin' && m.changes && typeof m.changes === 'object') {
      events.push({ kind: 'edit', text: oneLine(`edited ${Object.keys(m.changes).map((f) => inFolder(f, cwd)).join(', ')}`, 240), detail: '', ok: undefined });
    } else if (m.type === 'agent_message' && m.message) events.push({ kind: 'message', text: oneLine(m.message, 240), detail: '', ok: undefined });
    else if (m.type === 'error' && m.message) events.push({ kind: 'error', text: oneLine(m.message, 240), detail: '', ok: false });
  }
  return events;
}

// How a `codex exec --json` run ended, by Codex's own account (FR-020): its last turn, "turn.completed" or "turn.failed"
// (with error.message), and an "error" event after it, on which the run ended; its last message when it ended well, and
// its last lines. -> { status ('' when it printed no turn: an older run without --json), error, reason, turns, said,
// stopped, last }. Not redacted.
export function codexEnd(text, { code = null } = {}) {
  let status = '';
  let reason = '';
  let error = false;
  let turns = 0;
  let said = '';
  let lastError = '';
  for (const line of String(text || '').split(/\r?\n/)) {
    const v = jsonLine(line);
    if (!v) continue;
    if (v.type === 'turn.completed' || v.type === 'turn.failed') {
      turns++;
      status = v.type === 'turn.failed' ? 'failed' : 'completed';
      error = v.type === 'turn.failed';
      reason = error ? oneLine(v.error?.message || 'the turn failed', 400) : '';
      lastError = '';
    } else if (v.type === 'error') lastError = oneLine(v.message || 'error', 400);
    else if (v.type === 'item.completed' && v.item?.type === 'agent_message' && String(v.item.text || '').trim()) said = oneLine(firstLine(v.item.text), 300);
  }
  // (an error with no turn ended after it: the run ended on it)
  if (lastError) [status, error, reason] = [status || 'error', true, lastError];
  return { status, error, reason, turns: turns || null, said: error ? '' : said, stopped: 0, code, last: lastLines(codexReadable(text) ?? text) };
}

// The tokens of a `codex exec --json` run: its last "turn.completed" usage (the running total), counted like
// "tokens used" (input without the cached part, plus output); else "tokens used" in its output. null: none.
export function codexRunTokens(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('turn.completed')) continue;
    const u = jsonLine(lines[i])?.usage;
    if (!u || typeof u !== 'object') continue;
    const cached = count(u.cached_input_tokens);
    return { tokens: Math.max(0, count(u.input_tokens) - cached) + count(u.output_tokens), cached };
  }
  const n = codexTokens(text);
  return n ? { tokens: n, cached: 0 } : null;
}

// A log with its JSON lines as a person reads them: "$ npm test" and what came of it, files changed, its
// messages; null when there are none.
function codexReadable(text, opts) {
  const lines = String(text || '').split(/\r?\n/);
  if (!lines.some((l) => jsonLine(l))) return null;
  const out = [];
  for (const line of lines) {
    const v = jsonLine(line);
    if (!v) {
      out.push(line);
      continue;
    }
    if (v.type === 'item.completed' || v.type === 'turn.failed' || v.type === 'error' || v.msg) {
      for (const e of codexFeed(line, opts)) {
        if (e.kind === 'command' || e.kind === 'test') out.push(`$ ${e.text}${e.detail ? `  -> ${e.detail}` : ''}`);
        else out.push(e.kind === 'message' ? `Codex: ${e.text}` : e.text);
      }
    } else if (v.type === 'turn.completed') {
      const t = codexRunTokens(line);
      if (t) out.push(`[Codex: ${t.tokens.toLocaleString('en-US')} tokens${t.cached ? `, ${t.cached.toLocaleString('en-US')} more read from its cache` : ''}]`);
    }
  }
  return out.join('\n');
}

// FR-009: a Codex worker on Windows, in its sandbox (on 0.160.0 the "elevated" one: its commands run as the local
// accounts CodexSandboxOffline and CodexSandboxOnline), is denied the Docker pipe (\\.\pipe\docker_engine),
// ~/.docker/config.json and pnpm's store in the owner's AppData ("ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK ... Access is
// denied"), with network on or off; so a real project's task blocked even after the hub did its git (FR-008). PowerShell
// refused npm's .ps1 shims there ("running scripts is disabled") where the PC's policy doesn't allow scripts: a Codex
// worker now gets the policy for its own process (workerEnv), and the .cmd shims work anyway. Without its sandbox
// (danger-full-access: the Team page's switch, engines.codex.workerArgs) none of this applies.
// -> { warning, tips } for a worker on this platform with these arguments, or null.
export const SANDBOX_BLOCKS = 'anything that starts Docker (a stack, compose, an integration check that needs containers) or reads ~/.docker, and package installs (pnpm install: its store is in your AppData, which the sandbox\'s account can\'t write)';
export function codexWorkerCaveat(platform, args = []) {
  if (platform !== 'win32' || codexWritesGit(args)) return null;
  return {
    warning: `On Windows, Codex's sandbox runs a worker's commands under accounts of its own, which are refused ${SANDBOX_BLOCKS}. Turning its network on doesn't change that. Those tasks block on a Codex worker in its sandbox: take Codex workers out of it on the Team page ("like your other workers"), or send those tasks to another engine (FR-009).`,
    tips:
      "You run in Codex's sandbox on Windows: if a .ps1 shim is refused (\"running scripts is disabled\"), run pnpm.cmd, npm.cmd and npx.cmd instead of pnpm, npm or npx. Docker, ~/.docker and pnpm's store can't be reached from this sandbox: if the task needs Docker or a package install, say so in your report and finish with Status: BLOCKED.",
  };
}

// What a worker on Codex with these arguments can't give a task that needs it (lib/needs.mjs): out of its sandbox,
// nothing. In it: the network unless the arguments turn it on (on every system); on Windows also Docker and package
// installs, network or not (its accounts are refused the Docker pipe, ~/.docker and pnpm's store: measured on 0.160.0).
// Elsewhere a package install needs the network. -> [{ need, why }]
export function codexWorkerLacks(needs, { platform = process.platform, args = [] } = {}) {
  if (codexWritesGit(args)) return [];
  const network = args.some((a, i) => /^sandbox_workspace_write\.network_access\s*=\s*true$/.test(String(a)) && ['-c', '--config'].includes(args[i - 1]));
  const win = platform === 'win32';
  const why = {
    docker: win ? "its sandbox's accounts are refused the Docker pipe and ~/.docker" : '',
    packages: win ? "its sandbox's accounts can't write pnpm's store in your AppData" : network ? '' : 'its sandbox has no network',
    network: network ? '' : 'its sandbox has no network',
  };
  return needs.filter((n) => why[n]).map((need) => ({ need, why: why[need] }));
}

// Whether sessions with these arguments can write .git: only without Codex's sandbox (danger-full-access,
// or the flag that bypasses it). --full-auto (older Codex: the workspace-write sandbox, which won over --sandbox; 0.160.0
// refuses the flag) counts as in it, whatever else the arguments say.
export function codexWritesGit(args = []) {
  if (args.includes('--full-auto')) return false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dangerously-bypass-approvals-and-sandbox' || a === '--yolo') return true;
    if ((a === '--sandbox' || a === '-s') && args[i + 1] === 'danger-full-access') return true;
    if (a === '--sandbox=danger-full-access') return true;
  }
  return false;
}

// The MCP servers in a Codex config.toml: [{ name, command, url, enabled }] (codex.mcp checks that they can start,
// FR-001 #6; a worker gets the ones workers.addons doesn't list switched off, FR-013).
export function codexMcpServers(text) {
  const servers = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^\[\s*mcp_servers\.(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*\]\s*(#.*)?$/);
    if (head) {
      cur = { name: head[1] || head[2] || head[3], command: '', url: '', enabled: true };
      servers.push(cur);
      continue;
    }
    if (line.startsWith('[')) {
      cur = null; // another table, or a sub-table like [mcp_servers.x.env]
      continue;
    }
    const kv = cur && line.match(/^(command|url|enabled)\s*=\s*("([^"]*)"|'([^']*)'|(\w+))/);
    if (!kv) continue;
    const value = kv[3] ?? kv[4] ?? kv[5];
    if (kv[1] === 'enabled') cur.enabled = value !== 'false';
    else cur[kv[1]] = value;
  }
  return servers;
}

// ---------- a worker without the owner's own add-ons (FR-013) ----------
// `codex exec` loads everything in $CODEX_HOME/config.toml: its MCP servers (on a real PC every autopilot round
// started two npx servers and two of the Codex app's, measured on 0.157.1), plugins (with their skills, MCP servers and
// hooks), hooks and ChatGPT's apps. A worker gets each MCP server workers.addons doesn't list switched off
// (`-c mcp_servers.<name>.enabled=false`, which `codex mcp list` shows as disabled), and plugins, hooks and apps off
// (`--disable plugins|hooks|apps`, Codex's own feature switches) unless workers.addons keeps them. The account's
// sign-in, model and sandbox stay as they are: nothing is copied.
const tableName = (h) => (h.match(/^"([^"]+)"$|^'([^']+)'$|^([\w@.-]+)$/) || []).slice(1).find(Boolean) || null;
// [{ table, name, keys: { key: raw value } }] for the tables under `prefix` (plugins, mcp_servers)
function tomlTables(text, prefix) {
  const out = [];
  let cur = null;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    // (patterns without repeats that overlap: no slow backtracking on a long line)
    const head = line.match(/^\[([^\]]*)\]\s*(?:#.*)?$/);
    if (head) {
      const m = head[1].trim().match(new RegExp(`^${prefix}\\.(.+)$`));
      const name = m && tableName(m[1]);
      cur = name ? { name, keys: {} } : null;
      if (cur) out.push(cur);
      continue;
    }
    const kv = cur && line.match(/^(\w+)\s*=\s*([^\s#]+)/); // (the value's first word: enabled = false)
    if (kv) cur.keys[kv[1]] = kv[2];
  }
  return out;
}
export function codexAddons({ home, account = '', env = {}, read, list = () => [], path: p }) {
  const dir = codexHome({ home, account, env, path: p });
  const file = p.join(dir, 'config.toml');
  const text = read(file) || '';
  const mcpServers = codexMcpServers(text)
    .filter((s) => s.enabled)
    .map((s) => ({ name: s.name, command: s.command || (s.url ? 'a remote server' : '') }));
  const plugins = tomlTables(text, 'plugins').filter((t) => t.keys.enabled !== 'false').map((t) => t.name);
  const hooks = [...(String(read(p.join(dir, 'hooks.json')) || '').trim() ? ['hooks.json'] : []), ...(/^\s*\[\[?hooks\.(?!state\b)/m.test(text) ? ['[hooks] in config.toml'] : [])];
  // The owner's own skills: $CODEX_HOME/skills and ~/.agents/skills (codex-rs ext/skills host_roots), each by the name
  // its SKILL.md gives (else its folder's); .system holds Codex's own
  const skills = [];
  for (const root of [p.join(dir, 'skills'), p.join(home, '.agents', 'skills')]) {
    for (const folder of list(root).filter((n) => !n.startsWith('.'))) {
      const head = String(read(p.join(root, folder, 'SKILL.md')) || '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
      const name = ((head?.[1].match(/^name:(.*)$/m) || [])[1] || '').trim().replace(/^["']|["']$/g, '').trim() || folder;
      if (!skills.includes(name)) skills.push(name);
    }
  }
  return { mcpServers, plugins, hooks, skills, rules: [], files: { config: file, dir } };
}
const TOML_KEY = /^[A-Za-z0-9_-]+$/;
function codexWorker(keep = {}, found = {}) {
  const mcp = keep.mcpServers || [];
  const args = [];
  const left = [];
  for (const s of found.mcpServers || []) {
    if (mcp.includes(s.name)) continue;
    if (TOML_KEY.test(s.name)) args.push('-c', `mcp_servers.${s.name}.enabled=false`);
    else left.push({ what: 'mcp-name', text: `the MCP server "${s.name}" in config.toml: a name with those characters can't be switched off for one session, so Codex workers and the assistant (Ask) on Codex still get it` });
  }
  if (!keep.skills) {
    args.push('--disable', 'plugins');
    // Each of the owner's own skills by name ([[skills.config]] { name, enabled = false }, codex-rs config
    // skills_config.rs): single quotes, TOML's literal strings, since a .cmd shim's command line can't carry double ones
    const named = (found.skills || []).filter((n) => /^[\w .:@-]{1,80}$/.test(n) && !n.includes("'"));
    if (named.length) args.push('-c', `skills.config=[${named.map((n) => `{name='${n}',enabled=false}`).join(',')}]`);
    const odd = (found.skills || []).filter((n) => !named.includes(n));
    if (odd.length) left.push({ what: 'skills', text: `the skills ${odd.join(', ')}: their names can't be given to Codex for one session, so its workers still see them` });
  }
  if (!keep.hooks) args.push('--disable', 'hooks');
  if (!mcp.includes('apps')) args.push('--disable', 'apps');
  return { args, files: [], readsAgentsMd: true, left };
}

// What keeps the hub's variables in a worker's commands (Codex's shell_environment_policy: every variable, none left out
// by name; the owner's own `set` still adds its own). Without quotes: a value that isn't TOML is taken as a string.
export const WORKER_ENV = ['-c', 'shell_environment_policy.inherit=all', '-c', 'shell_environment_policy.ignore_default_excludes=true', '-c', 'shell_environment_policy.exclude=[]', '-c', 'shell_environment_policy.include_only=[]'];

// The account's list as Codex keeps it ($CODEX_HOME/models_cache.json): [{ id, efforts, effort, priority }]
const cachedModels = (read, file) => parseCodexModels(read(file) || '');

export default {
  name: 'codex',
  title: 'Codex',
  command: 'codex',
  window: 'codex', // where its slash commands (/model) are typed (checks/lib.mjs WINDOWS)
  // No -c: Codex runs without its shared background server when a session overrides its settings,
  // and warns about it every time (FR-004 #6). The orchestrator needs no network: the hub has it.
  defaultArgs: ['--sandbox', 'workspace-write'],
  readsAgentsMd: true,
  writesGit: false,
  writesGitWith: codexWritesGit,
  workerCaveat: codexWorkerCaveat, // FR-009
  workerLacks: codexWorkerLacks, // what a task's "Needs:" asks that a worker in its sandbox can't give (lib/needs.mjs)
  // FR-017: a role it runs without its sandbox (the assistant always gets its read-only one). Workers have their own
  // arguments (engines.codex.workerArgs, the Team page's switch), the other roles engines.codex.args.
  fullAccess: (args, role) => (role !== 'assistant' && codexWritesGit(args) ? `Codex runs it without its sandbox (danger-full-access or --dangerously-bypass-approvals-and-sandbox in ${role === 'worker' ? "the workers' arguments" : 'engines.codex.args'})` : ''),
  // A worker's session (headless, role worker: WORKER_ENV): the hub's variables reach its commands whatever the owner's
  // config.toml says of them (Codex's shell_environment_policy can leave out variables whose names have KEY, SECRET or
  // TOKEN: the push block's GH_TOKEN, GITHUB_TOKEN), and on Windows PowerShell may run npm's .ps1 shims (pnpm, npm, npx)
  // in its process: the policy for that process only, which wins over the user's and the machine's but not a Group
  // Policy, and changes nothing on the PC (FR-009: "running scripts is disabled"; it reached the commands of Codex 0.160.0,
  // in its sandbox and without it).
  workerEnv: ({ platform = process.platform } = {}) => (platform === 'win32' ? { PSExecutionPolicyPreference: 'RemoteSigned' } : {}),

  needsRealConsole: () => false,
  addons: codexAddons, // the owner's own add-ons, and what keeps them out of a worker (FR-013)
  workerAddons: codexWorker,
  account: {
    env: 'CODEX_HOME',
    holds: "Codex's own folder: its settings (config.toml), its sign-in (auth.json, or a keyring entry named after the folder) and sessions",
  },
  // `codex login status`: "Logged in using ..." (exit 0) or "Not logged in" (exit 1)
  login: {
    status: ['login', 'status'],
    signIn: ['login'],
    signInText: 'it opens the browser: sign in with the ChatGPT account for this profile; if the browser offers another account, open the link Codex prints in a private window',
  },
  loginResult: (r) => (r.ok ? { ok: true, detail: firstLine(r.out) } : { ok: false, detail: 'not signed in' }),
  // --json: its steps as JSON lines, for the feed and its tokens (unless engines.codex.args have it already)
  // extra: what keeps the owner's own add-ons out of a worker (workerAddons, FR-013)
  headless: ({ prompt, model, effort, args, role, extra = [] }) => ['exec', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), ...args, ...(role === 'worker' ? WORKER_ENV : []), ...extra, ...(args.includes('--json') || args.includes('--experimental-json') ? [] : ['--json']), prompt],
  interactive: ({ prompt, model, args, extra = [] }) => [...(model ? ['-m', model] : []), ...args, ...extra, prompt],
  // FR-011: in a window of its own Codex hands every command to its shared background server (`codex app-server
  // --managed-daemon`, started with no console), whose sandbox helper (codex-windows-sandbox-setup.exe) then gets a
  // console window of its own for each command, and the focus: 12 windows in one orchestrator turn, measured on the
  // owner's PC (0.157.1's window, 0.158.0's server). --no-daemon keeps the session's server in Codex's own process, so
  // its helpers share the window's console. Only a Codex whose --help lists the flag gets it.
  windowArgs: { probe: ['--help'], args: (help) => (/--no-daemon\b/.test(String(help || '')) ? ['--no-daemon'] : []) },
  // The assistant (Ask): its read-only sandbox (no writes, no network) whatever engines.codex.args say, and the
  // question on stdin ('-'), so no text of the owner's goes through cmd.exe to a .cmd shim. extra: what keeps the owner's
  // own add-ons out of it, as for a worker that keeps none (src/ask.mjs: every MCP server in config.toml off, plugins,
  // hooks and apps off; an MCP server can write where its config points, past the read-only sandbox)
  readOnly: ({ model, effort, extra = [] }) => ['exec', ...(model ? ['-m', model] : []), ...(effort ? ['-c', `model_reasoning_effort=${effort}`] : []), '--sandbox', 'read-only', ...extra, '--json', '-'],
  efforts: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'], // each model takes some: codex debug models lists them
  effortNote: "Autopilot rounds and Codex workers get this effort. Codex's own window (the interactive orchestrator, the setup guide) keeps Codex's own (/model inside Codex): a setting on its command line would take it off Codex's shared background server (FR-004 #6).",
  // What it uses when nextlevel pins nothing: its config.toml (the account's own folder for a named one)
  own({ home, account = '', env = {}, read, path: p }) {
    const dir = codexHome({ home, account, env, path: p });
    const file = p.join(dir, 'config.toml');
    const cache = p.join(dir, 'models_cache.json');
    const text = read(file);
    const list = cachedModels(read, cache);
    // Without a model of its own, the first in the account's list (the picker's order)
    const first = [...list].sort((a, b) => a.priority - b.priority)[0];
    const model = tomlTop(text, 'model') || '';
    const effort = tomlTop(text, 'model_reasoning_effort') || '';
    const used = model || first?.id || '';
    const modelDefault = list.find((m) => m.id === used)?.effort || '';
    return {
      model: used,
      from: model ? file : first ? `${cache}: the account's default` : '',
      effort: effort || modelDefault,
      effortFrom: effort ? file : modelDefault ? `${cache}: ${used}'s default` : '',
      byDefault: "the account's default model",
    };
  },
  tokens: codexRunTokens,
  readable: codexReadable,
  feed: codexFeed,
  end: codexEnd, // how a headless run ended (FR-020)
  usage: { headless: 'its JSON output (codex exec --json)', interactive: 'its session files' },
  sessionTokens,
  home: codexHome,
  models(run) {
    const r = run('codex', ['debug', 'models'], { timeoutMs: 30_000 });
    const list = r.ok ? parseCodexModels(r.out) : [];
    return list.length ? { list, from: 'codex debug models' } : null;
  },
  notes: {
    plan: 'Uses the ChatGPT plan it is signed into.',
    orchestrator: "Plans and reviews in Codex's sandbox (no network, .git read-only: the hub does git for it). Autopilot rounds run headless (codex exec), with no window.",
    worker: "Each task runs headless (codex exec) in its slot, with no window. In its sandbox it can't write git (the hub merges the base branch in before a retry and commits what it leaves), and on Windows it can't reach Docker or install packages with pnpm. The Team page can take Codex workers out of its sandbox, like your other workers: then Docker, pnpm and git work.",
    guide: 'Opens Codex in a window of its own, in its sandbox: the doctor runs through the hub from there.',
    assistant: "Answers each question in a fresh codex exec in its read-only sandbox: it can't write or reach the network. Its tokens count in Today.",
  },
  knownIssues: [
    "codex exec's sandbox keeps .git read-only: git writes go through the hub (nextlevel commit, merge, cleanup)",
    "a Codex worker can't commit or merge in its slot (ORIG_HEAD.lock: Permission denied, FR-008): the hub does it",
    "a Codex worker on Windows, in its sandbox, can't reach Docker or pnpm's store, network or not (FR-009): the Team page can take Codex workers out of it",
    'inside its sandbox the owner\'s sign-ins, programs, Docker and the network are out of sight (FR-004 #2)',
    'any -c keeps Codex off its shared background server, with a warning at every start (FR-004 #6)',
    'model names depend on the account and on the Codex version (FR-001 #5, FR-004 #3)',
  ],
};
