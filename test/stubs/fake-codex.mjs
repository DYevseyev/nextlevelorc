#!/usr/bin/env node
// Stand-in for the Codex CLI in tests. `exec <prompt>` plays the role the prompt names (team.mjs): an
// orchestrator's cycle (STUB_CODEX_MODE=noop: nothing to do), or a worker's task, which it can't commit or
// merge: Codex's sandbox keeps .git read-only (FR-008), so the hub does git for it. Like codex exec, it ends
// with the tokens it used (STUB_CODEX_TOKENS, default 12,345): with --json its steps come as JSON lines as it
// goes (item.started/item.completed: commands with their output and exit code, file changes, its messages) and
// "turn.completed" with the usage (1,000 of the input cached); without, "tokens used" on stderr. STUB_CODEX_LOG: a file that gets
// each call's arguments. Like Codex, every session leaves a session file in $CODEX_HOME/sessions/Y/M/D/
// (rollout-*.jsonl): its folder and source (exec or cli) first, then "token_count" events with the running
// total (an interactive session: 50,000 input of which 20,000 cached, and 4,000 output, so 34,000 counted).
// Its folder is $CODEX_HOME when set (a profile's own account): signed in there only after `codex login`
// (auth.json), and Codex refuses a CODEX_HOME that doesn't exist, as the real one does.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_TRACE, assistantTask, orchestratorCycle, roleOf, workerTask } from './team.mjs';

const args = process.argv.slice(2);
if (process.env.STUB_CALLS) fs.appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['codex', ...process.argv.slice(2)])}\n`); // (every call, for tests that nothing ran)
if (process.env.STUB_CODEX_LOG) fs.appendFileSync(process.env.STUB_CODEX_LOG, `${JSON.stringify(args)}\n`);
const home = process.env.CODEX_HOME;
if (home && !fs.existsSync(home)) {
  console.error(`Error: CODEX_HOME points to "${home}", but that path does not exist`);
  process.exit(1);
}
if (args[0] === '--version') {
  console.log(`codex-cli ${process.env.STUB_CODEX_VERSION || '0.152.0'} (stub)`);
  process.exit(0);
}
// Its help lists --no-daemon (0.157 on), unless STUB_CODEX_NO_DAEMON_FLAG=0 plays an older Codex, which refuses it
if (args[0] === '--help') {
  console.log(`Codex CLI\n\nOptions:\n  -m, --model <MODEL>\n${process.env.STUB_CODEX_NO_DAEMON_FLAG === '0' ? '' : '      --no-daemon\n          Run without the shared background server, even if it is already running\n'}  -h, --help`);
  process.exit(0);
}
if (args.includes('--no-daemon') && process.env.STUB_CODEX_NO_DAEMON_FLAG === '0') {
  console.error("error: unexpected argument '--no-daemon' found");
  process.exit(2);
}
if (args[0] === 'login') {
  const auth = home && path.join(home, 'auth.json');
  if (args[1] === 'status') {
    if (auth && !fs.existsSync(auth)) {
      console.error('Not logged in');
      process.exit(1);
    }
    console.log(`Logged in using ChatGPT${auth ? ` (${JSON.parse(fs.readFileSync(auth, 'utf8')).who})` : ''}`);
    process.exit(0);
  }
  if (auth) fs.writeFileSync(auth, JSON.stringify({ who: `stub account in ${path.basename(home)}` }));
  console.log('Successfully logged in');
  process.exit(0);
}
// `codex debug models`: the account's models as JSON, the way Codex lists them (STUB_CODEX_MODELS: their
// slugs, comma-separated; the first is the account's default)
if (args[0] === 'debug' && args[1] === 'models') {
  const slugs = (process.env.STUB_CODEX_MODELS || 'gpt-6,gpt-6-mini').split(',');
  const models = slugs.map((slug, i) => ({
    slug,
    display_name: slug.toUpperCase(),
    default_reasoning_level: 'medium',
    supported_reasoning_levels: (i ? ['low', 'medium'] : ['low', 'medium', 'high', 'xhigh']).map((effort) => ({ effort, description: effort })),
    visibility: 'list',
  }));
  console.log(JSON.stringify({ models }, null, 2));
  process.exit(0);
}
// A session file, as Codex writes one for every session (codex-rs rollout: session_meta, then events)
function sessionFile(source, total) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dir = path.join(home || path.join(os.homedir(), '.codex'), 'sessions', String(now.getFullYear()), pad(now.getMonth() + 1), pad(now.getDate()));
  fs.mkdirSync(dir, { recursive: true });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const id = `${Date.now().toString(16)}-${Math.random().toString(16).slice(2, 10)}`;
  const event = (usage) => ({ timestamp: new Date().toISOString(), type: 'event_msg', payload: { type: 'token_count', info: usage && { total_token_usage: usage, last_token_usage: usage, model_context_window: 400000 }, rate_limits: null } });
  const lines = [
    { timestamp: now.toISOString(), type: 'session_meta', payload: { id, timestamp: now.toISOString(), cwd: process.cwd(), originator: source === 'exec' ? 'codex_exec' : 'codex_cli_rs', cli_version: '0.152.0', source } },
    event({ input_tokens: 1000, cached_input_tokens: 0, output_tokens: 100, reasoning_output_tokens: 0, total_tokens: 1100 }),
    event(null), // a rate-limit update, without usage
    event(total),
    event(total), // the same total again, as after a compaction
  ];
  fs.writeFileSync(path.join(dir, `rollout-${stamp}-${id}.jsonl`), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
}
// OpenAI's Daybreak (security engineer 1b-1), as Codex 0.164 takes it: on when config.toml's top level says
// `daybreak = true` (or the [profiles.<name>] table a top-level `profile`, or --profile/-p, picks), the last
// `-c daybreak=` or `-c profiles.<name>.daybreak=` for it winning (a profile's own field over the root's). On, a model in
// STUB_CODEX_NO_DAYBREAK (default gpt-6-astra) fails at once, with Codex's words. Only from STUB_CODEX_VERSION 0.163 on.
function daybreakOn() {
  const [maj, min] = String(process.env.STUB_CODEX_VERSION || '0.152.0').split('.').map(Number);
  if (maj === 0 && min < 163) return false;
  const config = path.join(home || path.join(os.homedir(), '.codex'), 'config.toml');
  const text = fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : '';
  let table = '';
  let root = false;
  let topProfile = '';
  const inProfile = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const head = line.match(/^\[([^\]]*)\]/);
    if (head) table = head[1].trim();
    else if (/^daybreak\s*=\s*(true|false)/.test(line)) {
      const v = /true/.test(line);
      if (!table) root = v;
      else if (table.startsWith('profiles.')) inProfile[table.slice(9)] = v;
    } else if (!table && /^profile\s*=/.test(line)) topProfile = (line.match(/"([^"]*)"/) || [])[1] || '';
  }
  let picked = topProfile;
  for (let i = 0; i < args.length; i++) if ((args[i] === '--profile' || args[i] === '-p') && args[i + 1]) picked = args[i + 1];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '-c') continue;
    const m = String(args[i + 1] || '').match(/^(?:profiles\.([\w-]+)\.)?daybreak=(true|false)$/);
    if (!m) continue;
    if (m[1]) inProfile[m[1]] = m[2] === 'true';
    else root = m[2] === 'true';
  }
  return picked && picked in inProfile ? inProfile[picked] : root;
}
if (daybreakOn()) {
  const model = args.includes('-m') ? args[args.indexOf('-m') + 1] : '';
  if ((process.env.STUB_CODEX_NO_DAYBREAK ?? 'gpt-6-astra').split(',').includes(model)) {
    console.error(`Error: Daybreak is unavailable for model ${model}; turn it off or choose a compatible model`);
    process.exit(1);
  }
}
if (args[0] !== 'exec') {
  console.log(`[fake codex] interactive: ${args.at(-1)}`);
  sessionFile('cli', { input_tokens: 50000, cached_input_tokens: 20000, output_tokens: 4000, reasoning_output_tokens: 1500, total_tokens: 54000 });
  process.exit(0);
}
// The doctor's model check (FR-001 #5): models in STUB_CODEX_REJECT (default gpt-6-sol) are refused the
// way Codex refuses them for a ChatGPT login. Without -m, Codex uses `model` in its config.toml (FR-004 #3).
const model = args.includes('-m') ? args[args.indexOf('-m') + 1] : '';
if (args.at(-1).startsWith('nextlevel model check')) {
  const config = path.join(home || path.join(os.homedir(), '.codex'), 'config.toml');
  const own = fs.existsSync(config) ? (fs.readFileSync(config, 'utf8').match(/^model\s*=\s*"([^"]*)"/m) || [])[1] : '';
  const used = model || own || '';
  if ((process.env.STUB_CODEX_REJECT ?? 'gpt-6-sol').split(',').includes(used)) {
    console.error(`ERROR: {"detail":"The '${used}' model is not supported when using Codex with a ChatGPT account."}`);
    process.exit(1);
  }
  console.log('ok');
  process.exit(0);
}
// '-': the prompt is on stdin (the assistant's question never goes through cmd.exe)
const prompt = args.at(-1) === '-' ? fs.readFileSync(0, 'utf8') : args.at(-1);
sessionFile('exec', { input_tokens: 9000, cached_input_tokens: 1000, output_tokens: 700, reasoning_output_tokens: 0, total_tokens: 9700 });
const setting = args.find((a, i) => args[i - 1] === '-c' && a.startsWith('model_reasoning_effort='));
const effort = setting ? setting.split('=')[1] : 'default';
const json = args.includes('--json');
const print = (v) => console.log(JSON.stringify(v));
let items = 0;
const item = (started, done) => {
  const id = `item_${items++}`;
  if (started) print({ type: 'item.started', item: { id, ...started } });
  print({ type: 'item.completed', item: { id, ...done } });
};
const trace = json
  ? {
      command: (command, output, exit = 0) => {
        const cmd = `bash -lc '${command.replace(/'/g, `'\\''`)}'`;
        item({ type: 'command_execution', command: cmd, aggregated_output: '', exit_code: null, status: 'in_progress' }, { type: 'command_execution', command: cmd, aggregated_output: output, exit_code: exit, status: exit ? 'failed' : 'completed' });
      },
      edit: (file) => item(null, { type: 'file_change', changes: [{ path: path.resolve(file), kind: 'update' }], status: 'completed' }),
      message: (text) => item(null, { type: 'agent_message', text }),
    }
  : NO_TRACE;
if (json) {
  print({ type: 'thread.started', thread_id: 'stub-thread' });
  print({ type: 'turn.started' });
}
// Without its sandbox (danger-full-access, or the flag that bypasses it: engines.codex.workerArgs) a worker commits itself
const noSandbox = args.some((a, i) => a === '--dangerously-bypass-approvals-and-sandbox' || a === '--sandbox=danger-full-access' || (['--sandbox', '-s'].includes(a) && args[i + 1] === 'danger-full-access'));
if (roleOf(prompt) === 'WORKER') await workerTask({ engine: 'codex', prompt, model: model || 'default', effort, commits: noSandbox, trace });
else if (roleOf(prompt) === 'ASSISTANT') {
  const text = assistantTask({ engine: 'codex', prompt, args });
  if (json) print({ type: 'item.completed', item: { id: 'item_answer', type: 'agent_message', text } });
  else console.log(text);
} else orchestratorCycle({ engine: 'codex', noop: process.env.STUB_CODEX_MODE === 'noop' });
// What codex exec prints at the end of a run: the tokens it used, as JSON, or on stderr with this PC's separators
const tokens = process.env.STUB_CODEX_TOKENS || '12,345';
if (json) {
  const n = Number(tokens.replace(/\D/g, ''));
  print({ type: 'turn.completed', usage: { input_tokens: n - 345 + 1000, cached_input_tokens: 1000, output_tokens: 345 } });
} else console.error(`tokens used\n${tokens}`);
