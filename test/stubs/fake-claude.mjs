#!/usr/bin/env node
// Stand-in for Claude Code in tests: tests never run the real `claude`. STUB_CLAUDE=broken plays an npm
// install whose install script was skipped (FR-001 #7): the command is there but doesn't run.
// Sessions are recorded in ~/.fake-claude/calls.jsonl: the arguments, the folder, that folder's git remote
// (as configured), its config folder (CLAUDE_CONFIG_DIR) and whether variables it must not get were there.
// `--cloud <prompt>` answers like Claude Code 2.1.282 (FR-006): it refuses -p/--print, and output that isn't
// a terminal (tests can't give it one, so it takes its output for the owner's window; STUB_CLAUDE_NO_TTY=1
// plays a pipe). A new session prints "Created cloud session", "View" and "Resume with", and --debug-file
// gets the line Claude Code logs once it is created. STUB_CLAUDE_CLOUD=fail makes creating it fail,
// STUB_CLAUDE_CLOUD=nolog creates it without that log line.
// `-p <prompt>` plays the role the prompt names (team.mjs): a worker's task or an autopilot cycle
// (STUB_CLAUDE_MODE=noop: nothing to do). With `--output-format stream-json` (which, like Claude Code, it takes
// with -p only together with --verbose) it prints its steps as JSON lines as it goes (init, the assistant's tool
// calls and text, each tool's result); with it or `--output-format json` it ends with its result as JSON, with the
// tokens it used (1,000 input, 200 written to the cache, 30,000 read from it, 300 output: 1,500 counted);
// `-p` with the doctor's model check answers ok, or refuses a model
// in STUB_CLAUDE_REJECT. Anything else with a prompt is an interactive session, which ends
// at once. `auth status` answers in JSON like 2.1.283; its folder (CLAUDE_CONFIG_DIR, else ~/.claude) is
// signed in once `auth login` wrote its .credentials.json there, or always for ~/.claude unless
// STUB_CLAUDE_SIGNED_OUT=1.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { NO_TRACE, assistantTask, orchestratorCycle, roleOf, workerTask } from './team.mjs';

const args = process.argv.slice(2);
if (process.env.STUB_CALLS) fs.appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['claude', ...process.argv.slice(2)])}\n`); // (every call, for tests that nothing ran)
if (process.env.STUB_CLAUDE === 'broken') {
  console.error('claude: native binary not installed (npm skipped the install script)');
  process.exit(1);
}
if (args[0] === '--version') {
  console.log('2.1.282 (Claude Code, stub)');
  process.exit(0);
}
// Options that take a value; the prompt is the first argument that is neither an option nor a value
const VALUES = new Set(['--model', '--effort', '--permission-mode', '--allowedTools', '--disallowedTools', '--debug-file', '--cloud', '--output-format', '--setting-sources']);
let prompt = '';
for (let i = 0; i < args.length; i++) {
  if (VALUES.has(args[i])) i++;
  else if (!args[i].startsWith('-') && !prompt) prompt = args[i];
}
// -p without a prompt reads it from stdin (the assistant's question)
if (args.includes('-p') && !prompt && !args.includes('--cloud')) prompt = fs.readFileSync(0, 'utf8');
const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const credentials = path.join(configDir, '.credentials.json');
if (args[0] === 'auth') {
  if (args[1] === 'login') {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(credentials, JSON.stringify({ who: `stub account in ${path.basename(configDir)}` }));
    console.log('Login successful.');
    process.exit(0);
  }
  if (args[1] === 'status') {
    // STUB_CLAUDE_STATUS_LOG=1: each time it is asked, a line in ~/.fake-claude/status.log (slow answers kept, FR-010)
    if (process.env.STUB_CLAUDE_STATUS_LOG === '1') {
      fs.mkdirSync(path.join(os.homedir(), '.fake-claude'), { recursive: true });
      fs.appendFileSync(path.join(os.homedir(), '.fake-claude', 'status.log'), `${new Date().toISOString()}\n`);
    }
    const own = !process.env.CLAUDE_CONFIG_DIR && process.env.STUB_CLAUDE_SIGNED_OUT !== '1';
    const loggedIn = own || fs.existsSync(credentials);
    const status = { loggedIn, authMethod: loggedIn ? 'claude.ai' : 'none', apiProvider: 'firstParty', configDirectory: configDir };
    if (loggedIn) Object.assign(status, { email: fs.existsSync(credentials) ? `${path.basename(configDir)}@example.com` : 'owner@example.com', subscriptionType: 'max' });
    console.log(JSON.stringify(status, null, 2));
    process.exit(loggedIn ? 0 : 1);
  }
}
// The doctor's model check (claude.model): models in STUB_CLAUDE_REJECT (default claude-nope) are refused
// the way Claude Code refuses a model the account can't use. Not recorded: it isn't a session.
if (args.includes('-p') && prompt.startsWith('nextlevel model check')) {
  const m = args.includes('--model') ? args[args.indexOf('--model') + 1] : '';
  if ((process.env.STUB_CLAUDE_REJECT ?? 'claude-nope').split(',').includes(m)) {
    console.error(`There's an issue with the selected model (${m}). It may not exist or you may not have access to it. Run /model to pick a different model.`);
    process.exit(1);
  }
  console.log('ok');
  process.exit(0);
}
if (!prompt && !args.includes('--cloud')) {
  console.error(`[fake claude] not supported: ${args.join(' ')}`);
  process.exit(1);
}
const dir = path.join(os.homedir(), '.fake-claude');
fs.mkdirSync(dir, { recursive: true });
const remote = spawnSync('git', ['config', '--get', 'remote.origin.url'], { encoding: 'utf8' });
fs.appendFileSync(
  path.join(dir, 'calls.jsonl'),
  `${JSON.stringify({ args, cwd: process.cwd(), remote: (remote.stdout || '').trim(), configDir: process.env.CLAUDE_CONFIG_DIR || null, apiKey: !!process.env.ANTHROPIC_API_KEY, env: Object.keys(process.env).filter((k) => /^(PLANTED_|CCR_FORCE_BUNDLE$|NEXTLEVEL_ROOT$)/.test(k)) })}\n`,
);
if (args.includes('-p') && !args.includes('--cloud')) {
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'default';
  const effort = args.includes('--effort') ? args[args.indexOf('--effort') + 1] : 'default';
  const format = args.includes('--output-format') ? args[args.indexOf('--output-format') + 1] : 'text';
  if (format === 'stream-json' && !args.includes('--verbose')) {
    console.error('Error: When using --print, --output-format=stream-json requires --verbose');
    process.exit(1);
  }
  const print = (v) => console.log(JSON.stringify(v));
  let calls = 0;
  const tool = (name, input, content, isError = false) => {
    const id = `toolu_stub${++calls}`;
    print({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] }, session_id: 'stub' });
    print({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] }, session_id: 'stub' });
  };
  const trace =
    format === 'stream-json'
      ? {
          command: (command, output, exit = 0) => tool('Bash', { command, description: 'run it' }, exit ? `${output}\nExit code ${exit}` : output, exit !== 0),
          edit: (file) => tool('Edit', { file_path: path.resolve(file), old_string: '', new_string: 'x' }, 'The file has been updated.'),
          message: (text) => print({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] }, session_id: 'stub' }),
        }
      : NO_TRACE;
  if (format === 'stream-json') print({ type: 'system', subtype: 'init', cwd: process.cwd(), session_id: 'stub', model, tools: ['Bash', 'Edit', 'Write', 'Read'] });
  if (roleOf(prompt) === 'ASSISTANT') {
    const answer = assistantTask({ engine: 'claude', prompt, args });
    const usage = { input_tokens: 800, cache_creation_input_tokens: 0, cache_read_input_tokens: 5000, output_tokens: 120 };
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: answer, session_id: 'stub', usage }));
    process.exit(0);
  }
  if (roleOf(prompt) === 'ORCHESTRATOR') orchestratorCycle({ engine: 'claude', noop: process.env.STUB_CLAUDE_MODE === 'noop' });
  else await workerTask({ engine: 'claude', prompt, model, effort, trace });
  // FR-020: STUB_WORKER_EXTRA_COMMIT=<n>, n more commits of its own after the task's; STUB_WORKER_AMEND=1, the commit the
  // attempt started on rewritten (amended), so where it started is no longer on the branch
  for (let i = 0; roleOf(prompt) === 'WORKER' && i < Number(process.env.STUB_WORKER_EXTRA_COMMIT || 0); i++) {
    fs.writeFileSync('extra.txt', `${i} ${Date.now()}\n`);
    spawnSync('git', ['add', '-A'], { stdio: 'ignore' });
    spawnSync('git', ['commit', '-qm', `feat: extra ${i + 1}`], { stdio: 'ignore' });
  }
  if (roleOf(prompt) === 'WORKER' && process.env.STUB_WORKER_AMEND === '1') spawnSync('git', ['commit', '--amend', '-qm', 'rewritten by the worker'], { stdio: 'ignore' });
  // FR-020: how a worker's run ends, as Claude Code ends one (STUB_CLAUDE_END): max-turns, as measured on 2.1.284 (exit 1,
  // test/fixtures/claude-2.1.284-max-turns.jsonl); error, an error subtype with exit 0; background, a success that
  // stopped two background commands as it ended (WS-62's attempt 10: test/fixtures/claude-2.1.284-background-end.jsonl).
  // The worker's environment is written down too (~/.fake-claude/worker-env.json: the background switch and Bash limits).
  const endAs = roleOf(prompt) === 'WORKER' && (format === 'json' || format === 'stream-json') ? process.env.STUB_CLAUDE_END || '' : '';
  if (roleOf(prompt) === 'WORKER') {
    const keep = Object.fromEntries(Object.entries(process.env).filter(([k]) => /^(CLAUDE_CODE_DISABLE_BACKGROUND_TASKS|BASH_DEFAULT_TIMEOUT_MS|BASH_MAX_TIMEOUT_MS)$/.test(k)));
    fs.writeFileSync(path.join(dir, 'worker-env.json'), JSON.stringify({ env: keep, prompt }));
  }
  const fixture = (name) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').split(/\r?\n/).filter((l) => l.startsWith('{'));
  if (endAs === 'max-turns') {
    console.log(fixture('claude-2.1.284-max-turns.jsonl').find((l) => l.includes('"type":"result"')));
    process.exit(1);
  }
  if (endAs === 'error') {
    print({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 3, errors: ['API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"}}'], session_id: 'stub' });
    process.exit(0);
  }
  if (endAs === 'background') {
    for (const l of fixture('claude-2.1.284-background-end.jsonl').filter((x) => /"type":"(result|system)"/.test(x))) console.log(l);
    process.exit(0);
  }
  if (format === 'json' || format === 'stream-json') {
    const usage = { input_tokens: 1000, cache_creation_input_tokens: 200, cache_read_input_tokens: 30000, output_tokens: 300 };
    console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 4, result: `[fake claude] ${roleOf(prompt).toLowerCase()} done`, session_id: 'stub', total_cost_usd: 0.01, usage }));
  }
  process.exit(0);
}
if (args.includes('--cloud')) {
  // Claude Code's own messages (2.1.283's; the owner's 2.1.282 gave the first line of the -p one)
  if (args.includes('-p') || args.includes('--print')) {
    console.error(
      'Error: --cloud cannot be combined with --print.\nStarting a new cloud session with --cloud is interactive only: drop --print, or drop --cloud to run locally. ' +
        'To message an existing cloud session instead, pass its ID: `claude -p "message" --cloud <session-id>` (find IDs at claude.ai/code).',
    );
    process.exit(1);
  }
  if (process.env.STUB_CLAUDE_NO_TTY === '1') {
    console.error('Error: --cloud requires an interactive terminal.\nNon-interactive invocations (piped stdout, --init-only, --sdk-url) run locally and would silently ignore --cloud. Drop --cloud, or run from a TTY.');
    process.exit(1);
  }
  if (process.env.STUB_CLAUDE_CLOUD === 'fail') {
    console.error('Error: Unable to create cloud session');
    process.exit(1);
  }
  const description = args[args.indexOf('--cloud') + 1];
  const id = `session_stub${String(Date.now()).slice(-6)}`;
  const debug = args.includes('--debug-file') ? args[args.indexOf('--debug-file') + 1] : null;
  if (debug) {
    const at = () => new Date().toISOString();
    const lines = [`${at()} [DEBUG] Git remote URL: ${(remote.stdout || '').trim()}`];
    if (process.env.STUB_CLAUDE_CLOUD !== 'nolog') lines.push(`${at()} [DEBUG] Successfully created remote session: ${id}`);
    fs.writeFileSync(debug, `${lines.join('\n')}\n`);
  }
  console.log(`Created cloud session: ${description.split(' ').slice(0, 8).join(' ')}`);
  console.log(`View: https://claude.ai/code/${id}?from=cli&m=0`);
  console.log(`Resume with: claude --teleport ${id}`);
  process.exit(0);
}
console.log(`[fake claude] interactive session in ${process.cwd()}: ${prompt.slice(0, 60)}...`);
process.exit(0);
