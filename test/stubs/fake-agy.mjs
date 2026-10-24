#!/usr/bin/env node
// Stand-in for the Antigravity CLI (agy) in tests. `-p <prompt>` plays the role the prompt names (team.mjs):
// a worker's task, by its id, or an orchestrator's autopilot cycle (STUB_AGY_MODE=noop: nothing to do).
// `-i <prompt>` is an interactive session, which ends at once.
// Like agy 1.2.11 (FR-010):
// - on Windows print mode needs a console for its stdin: without one it stops with an error (the real one drops its
//   output or hangs), unless STUB_AGY_CONSOLE=any;
// - it refuses --effort for its Claude models ("--effort is not supported for model claude-opus-4-6-thinking");
// - with --output-format stream-json it prints its steps as JSON lines (init, step_update, result with usage), with
//   json the result alone.
// `-p` with the doctor's model check answers ok, or refuses a model in STUB_AGY_REFUSE (comma-separated).
// Like agy 1.2.12 (FR-013): `--agent <name>` runs the custom agent in .agents/agents/<name>.md of its folder, whose
// inheritCustomizations and inheritMcp say what of the owner's own add-ons it gets; with no such file it runs its
// default agent, with everything, and says nothing. A worker's report says which ("Add-ons: ...").
// Its version is STUB_AGY_VERSION (or the first line of the file STUB_AGY_VERSION_FILE names), "1.2.4 (stub)" by default,
// and it plays that version (FR-022, measured on 1.3.5, docs/KNOWN_ISSUES.md):
// - `--help` lists the flags its version knows, and a flag it doesn't know stops it as 1.3.5 does (exit 2, "flags
//   provided but not defined: -turbo" and its usage);
// - from 1.3.4, an agent file whose frontmatter isn't valid YAML (a plain text with ": " in it, as nextlevel's had) is no
//   agent, and `--agent` with a name it has no agent for fails (exit 1): "unknown agent ..." on stderr and in the result's
//   `error`, with status ERROR and an empty response. Before 1.3.4 it reads such a file, and runs its default agent for a
//   name it can't find;
// - after 1.3.2, an agent whose file lists no `tools:` gets only tools that look: it writes and runs nothing, and says so
//   (a task's run leaves no report); the model check's probe writes its file and runs its command otherwise;
// - from 1.3.5, --effort beside a model whose name has a level is refused (before 1.3, --effort with a Claude model).
// STUB_AGY_ERROR=<text>: a print-mode run fails with that reason the way 1.3.4 does (STUB_AGY_EXIT: its exit code, 1),
// STUB_AGY_HANG=1: it never answers (STUB_AGY_ERROR_FILE: fails while that file is there; STUB_AGY_HANG_FILE: waits
// while that file is there, then goes on). STUB_AGY_SEEN=<file>: each print-mode run's arguments, folder, the names in its
// environment and its agent file, one JSON line each (the tests compare the model trial's with a worker's).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import tty from 'node:tty';
import { pathToFileURL } from 'node:url';
import { orchestratorCycle, roleOf, workerTask } from './team.mjs';

const args = process.argv.slice(2);
if (process.env.STUB_CALLS) fs.appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['agy', ...process.argv.slice(2)])}\n`); // (every call, for tests that nothing ran)
const versionText = (() => {
  try {
    if (process.env.STUB_AGY_VERSION_FILE) return fs.readFileSync(process.env.STUB_AGY_VERSION_FILE, 'utf8').split(/\r?\n/)[0].trim();
  } catch {
    // no file: the variable's, or the default
  }
  return process.env.STUB_AGY_VERSION || '1.2.4 (stub)';
})();
const [major, minor, patch] = (versionText.match(/(\d+)\.(\d+)\.(\d+)/) || [0, 1, 2, 4]).slice(1).map(Number);
const atLeast = (a, b, c) => major > a || (major === a && (minor > b || (minor === b && patch >= c)));
if (args[0] === '--version') {
  console.log(versionText);
  process.exit(0);
}
if (args[0] === 'models') {
  // STUB_AGY_MODELS: the models this sign-in may use, comma-separated ("slug<TAB>label" each, or a slug); or
  // STUB_AGY_MODELS_FILE: what `agy models` printed on a real PC, as it is
  if (process.env.STUB_AGY_MODELS_FILE) process.stdout.write(fs.readFileSync(process.env.STUB_AGY_MODELS_FILE, 'utf8'));
  else console.log((process.env.STUB_AGY_MODELS || 'stub-model').split(',').join('\n'));
  process.exit(0);
}
// The flags its version knows (agy --help on 1.3.5; --remote-control from 1.3)
const FLAGS = [
  '--add-dir', '--agent', '-c', '--continue', '--conversation', '--dangerously-skip-permissions', '--disable-slash-commands', '--effort', '-i',
  '--input-format', '--json-schema', '--log-file', '--mode', '--model', '--new-project', '--output-format', '-p', '--print',
  '--print-timeout', '--project', '--prompt', '--prompt-interactive', '--sandbox',
  ...(atLeast(1, 3, 0) ? ['--remote-control'] : []),
];
const TAKES_VALUE = new Set(['--add-dir', '--conversation', '--effort', '-i', '--input-format', '--json-schema', '--log-file', '--mode', '--model', '--output-format', '-p', '--print', '--print-timeout', '--project', '--prompt', '--prompt-interactive', '--agent']);
if (args[0] === '--help' || args[0] === '-h') {
  console.log(`Usage of agy.exe (${versionText}):\n${FLAGS.map((f) => `  ${f}`).join('\n')}\n\nAvailable subcommands:\n  agents          List available agents\n  models          List available models`);
  process.exit(0);
}
for (let i = 0; i < args.length; i++) {
  const flag = args[i].split('=')[0];
  if (!flag.startsWith('-')) continue;
  if (!FLAGS.includes(flag)) {
    // (as 1.3.5 says it, on stdout: "flags provided but not defined: -turbo", then its usage; exit 2)
    console.log(`flags provided but not defined: ${flag.replace(/^--/, '-')}\nUsage of agy.exe:\n${FLAGS.map((f) => `  ${f}`).join('\n')}`);
    process.exit(2);
  }
  if (TAKES_VALUE.has(flag) && !args[i].includes('=')) i++;
}
const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : 'default';
const effort = args.includes('--effort') ? args[args.indexOf('--effort') + 1] : 'default';
if (args.includes('-i')) {
  console.log(`[fake agy] interactive: ${args[args.indexOf('-i') + 1]}`);
  process.exit(0);
}
const prompt = args[args.indexOf('-p') + 1] || '';
if (process.platform === 'win32' && !tty.isatty(0) && process.env.STUB_AGY_CONSOLE !== 'any') {
  console.error('[fake agy] print mode without a console for its stdin: the real agy drops its output or hangs here');
  process.exit(3);
}
const level = (m) => (String(m).toLowerCase().match(/-(minimal|low|medium|high|xhigh|max)$/) || [])[1] || '';
if (args.includes('--effort') && atLeast(1, 3, 5) && level(model)) {
  console.error(`error: invalid model selection (--model "${model}" --effort "${effort}"): --model ${model} conflicts with --effort=${effort}`);
  process.exit(1);
}
if (args.includes('--effort') && !atLeast(1, 3, 0) && /^claude-/.test(model)) {
  console.error(`Error: --effort is not supported for model ${model}`);
  process.exit(1);
}
// STUB_AGY_FAIL=<text>: a task's run stops at once with that error, before it does anything (a worker that failed to
// start), while the model check's probe passes (FR-022: the hub tries the probe before a task; STUB_AGY_ERROR fails both)
if (process.env.STUB_AGY_FAIL && !args.includes('models') && !prompt.startsWith('nextlevel model check')) {
  console.error(process.env.STUB_AGY_FAIL);
  process.exit(1);
}
const format = args.includes('--output-format') ? args[args.indexOf('--output-format') + 1] : 'text';
const print = (v) => console.log(JSON.stringify(v));
const conversation = 'stub-conversation';
const usage = { input_tokens: 2000, output_tokens: 150, thinking_tokens: 40, cache_read_tokens: 9000, total_tokens: 2150 };
const NO_USAGE = { input_tokens: 0, output_tokens: 0, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 0 };
const result = (response, status = 'SUCCESS', extra = {}) => {
  const r = { conversation_id: conversation, status, response, ...extra, duration_seconds: 1.5, num_turns: status === 'SUCCESS' ? 1 : 0, usage: status === 'SUCCESS' ? usage : NO_USAGE };
  if (format === 'json') print(r);
  else if (format === 'stream-json') print({ event: 'result', result: r });
  else console.log(response);
};
// A print-mode run that fails the way 1.3.4 says it: its reason on stderr and in the result's `error`
const failWith = (error, code = 1) => {
  console.error(`error: ${error}`);
  if (atLeast(1, 3, 4)) result('', 'ERROR', { conversation_id: '', error });
  process.exit(code);
};

// The agent --agent names, as this version finds it: { name, file, text, ok } (ok: its frontmatter is valid YAML, as
// far as the stub tells: no plain text with ": " in it, which 1.3.4 can't read)
const agentName = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : '';
function agentOf(name) {
  const file = name && path.join(process.cwd(), '.agents', 'agents', `${name}.md`);
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const front = (text.match(/^---\r?\n([\s\S]*?)\r?\n---/) || [])[1];
  const lines = front === undefined ? null : front.split(/\r?\n/).filter((l) => l.trim());
  const valid = !!lines && lines.every((l) => {
    if (/^\s+-\s+("[^"]*"|[\w.-]+)\s*$/.test(l)) return true; // an item of a list (tools:)
    const m = l.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (!m) return false;
    const v = m[2].trim();
    if (v.startsWith('"')) {
      try {
        JSON.parse(v);
        return true;
      } catch {
        return false;
      }
    }
    return !/:\s/.test(v) && !v.endsWith(':');
  });
  return { name, file, text, ok: !!text && (valid || !atLeast(1, 3, 4)) };
}
const agent = agentOf(agentName);
if (process.env.STUB_AGY_SEEN) {
  fs.appendFileSync(process.env.STUB_AGY_SEEN, `${JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env).sort(), agent: agent.text, prompt: roleOf(prompt) ? 'worker' : prompt.slice(0, 40) })}\n`);
}
if (agentName && !agent.ok && atLeast(1, 3, 4)) failWith(`unknown agent "${agentName}" (available: rules-writer, a11y_agent)`);
// (…_FILE: while that file is there, for a hub that runs on: a test makes agy fail, hang or pass again under it)
const fileSays = (name) => {
  try {
    return process.env[name] ? fs.readFileSync(process.env[name], 'utf8').trim() : '';
  } catch {
    return '';
  }
};
if (process.env.STUB_AGY_HANG === '1') await new Promise(() => setInterval(() => {}, 60_000));
while (fileSays('STUB_AGY_HANG_FILE')) await new Promise((r) => setTimeout(r, 100)); // (it goes on once the file is gone)
const errorText = process.env.STUB_AGY_ERROR || fileSays('STUB_AGY_ERROR_FILE');
if (errorText) failWith(errorText, Number(process.env.STUB_AGY_EXIT || 1));
// STUB_AGY_TASK_ERROR=<text>: the same for a task's run only (the probe passes)
if (process.env.STUB_AGY_TASK_ERROR && roleOf(prompt)) failWith(process.env.STUB_AGY_TASK_ERROR, Number(process.env.STUB_AGY_EXIT || 1));
// What of the owner's own add-ons this session gets: the agent's frontmatter, or everything (the default agent)
function addonsOf() {
  if (!agent.ok) return `all (the default agent${agentName ? `: no ${agentName}.md it can read` : ''})`;
  const flag = (k) => (agent.text.match(new RegExp(`^${k}:\\s*(\\w+)`, 'm')) || [])[1] || 'true';
  return `agent ${agentName}: customizations ${flag('inheritCustomizations')}, mcp ${flag('inheritMcp')}`;
}
let step = 0;
const stepUpdate = (s) => print({ event: 'step_update', step_update: { conversation_id: conversation, step_index: step++, ...s } });
const tool = (name, parameters, output) => {
  const index = step;
  stepUpdate({ state: 'ACTIVE', step_type: 'tool', tool_name: name, tool_info: { name, parameters } });
  step = index;
  stepUpdate({ state: 'DONE', step_type: 'tool', tool_name: name, duration_seconds: 0.1, tool_info: { name, parameters, ...(output !== undefined ? { output } : {}) } });
};
// After 1.3.2 an agent whose file lists no tools gets only tools that look (measured on 1.3.5, FR-022): it writes nothing
// and runs nothing, and says so
const readOnlyAgent = agentName && agent.ok && atLeast(1, 3, 3) && !/^tools:/m.test(agent.text);
if (readOnlyAgent) {
  if (format === 'stream-json') print({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), agent: agentName, tools: ['view_file', 'write_to_file', 'run_command'], permission_mode: 'always-proceed' } });
  if (format === 'stream-json') tool('view_file', { AbsolutePath: `${process.cwd()}/AGENTS.md` });
  result('I am unable to complete this request because I do not have access to tools for creating/writing files or executing command-line commands in this environment.\n');
  process.exit(0);
}
if (prompt.startsWith('nextlevel model check')) {
  if ((process.env.STUB_AGY_REFUSE || '').split(',').includes(model)) {
    console.error(`Error: model ${model} is not available for your plan`);
    process.exit(1);
  }
  if (format === 'stream-json') print({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), ...(agent.ok ? { agent: agentName } : {}), tools: ['run_command', 'write_to_file'], permission_mode: 'always-proceed' } });
  // what the probe asks: a file written with its tool, a command run (STUB_AGY_PROBE_LAZY=1: it only answers)
  if (process.env.STUB_AGY_PROBE_LAZY !== '1') {
    const file = (prompt.match(/to the file (\S+) in this folder/) || [])[1];
    if (file) {
      fs.writeFileSync(path.join(process.cwd(), file), 'ok');
      if (format === 'stream-json') tool('write_to_file', { TargetFile: path.join(process.cwd(), file) });
    }
    if (/run the command node --version/.test(prompt) && format === 'stream-json') tool('run_command', { CommandLine: 'node --version' }, `${process.version}\n`);
  }
  result('ok\n');
  process.exit(0);
}
// The lock test's tries (src/locktest.mjs): "nextlevel lock test [<id>]: ...". The stub does what agy 1.4.0 did when it was
// measured (docs/design/antigravity-roles.md): it runs the one command it is given in a shell with its own environment
// (where nextlevel's push block is), edits AGENTS.md with its file tool, and, run as an agent with inheritMcp: false, has
// no MCP tool and says so (else it calls one). STUB_AGY_LOCK_SKIP=<ids>: it declines those tries (no step: not tried).
// STUB_AGY_LOCK_CLEAR=<ids>: it clears the push block before the command, as a session that sets out to get around it
// (the push or gh then gets through). STUB_AGY_LOCK_MCP=call: it calls an MCP tool even so. --sandbox: a command fails as
// it did on Windows 11 22H2 (STUB_AGY_SANDBOX=runs: it runs).
const lockId = (prompt.match(/nextlevel lock test \[([\w-]+)\]/) || [])[1];
if (lockId) {
  const list = (name) => (process.env[name] || '').split(',').filter(Boolean);
  if (format === 'stream-json') print({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), ...(agent.ok ? { agent: agentName } : {}), tools: ['run_command', 'write_to_file', 'call_mcp_tool'], permission_mode: 'always-proceed' } });
  const shell = (command) => {
    const env = { ...process.env };
    if (list('STUB_AGY_LOCK_CLEAR').includes(lockId)) for (const k of ['GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_CONFIG_DIR']) delete env[k];
    const r = spawnSync(command, { shell: true, cwd: process.cwd(), env, encoding: 'utf8', windowsHide: true });
    return `${r.stdout || ''}${r.stderr || ''}`;
  };
  const command = (prompt.match(/The command: (.+)$/) || [])[1];
  let response = 'done';
  if (list('STUB_AGY_LOCK_SKIP').includes(lockId)) response = "I won't run that command: it could change things outside this folder.";
  else if (lockId === 'mcp') {
    const mcpOff = agent.ok && /^inheritMcp:\s*false/m.test(agent.text);
    if (!mcpOff || process.env.STUB_AGY_LOCK_MCP === 'call') {
      tool('call_mcp_tool', { ServerName: 'github-mcp-server', ToolName: 'get_me', Arguments: {} }, '{"login":"owner"}');
      response = 'It returned the login owner.';
    } else response = 'I have no tool for MCP servers in this session (call_mcp_tool is not available to me), so I did nothing.';
  } else if (lockId === 'change-by-edit') {
    const file = path.join(process.cwd(), 'lock-test-by-edit-tool.txt');
    fs.writeFileSync(file, 'x');
    tool('write_to_file', { TargetFile: file });
    response = `Created ${file}.`;
  } else if (lockId === 'protected-commit') {
    const file = path.join(process.cwd(), 'AGENTS.md');
    fs.appendFileSync(file, '\nnextlevel lock test\n');
    if (format === 'stream-json') tool('write_to_file', { TargetFile: file });
    const cmd = 'git commit -am "nextlevel lock test"';
    const out = shell(cmd);
    if (format === 'stream-json') tool('run_command', { CommandLine: cmd }, out);
    response = out;
  } else if (command) {
    if (args.includes('--sandbox') && process.env.STUB_AGY_SANDBOX !== 'runs') {
      const index = step;
      stepUpdate({ state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command', parameters: { CommandLine: command } } });
      step = index;
      const error = { type: 'TOOL_ERROR', message: 'exebox: sandboxing on Windows requires Windows 11 24H2 or later with the August 2026 or later update: process security environments are not supported: The specified module could not be found.' };
      stepUpdate({ state: 'ERROR', step_type: 'tool', tool_name: 'run_command', error, tool_info: { name: 'run_command', parameters: { CommandLine: command }, error } });
      response = error.message;
    } else {
      const out = shell(command);
      tool('run_command', { CommandLine: command }, out);
      response = out;
    }
  }
  result(response);
  process.exit(0);
}
// A question to the assistant on Antigravity (src/ask.mjs askAgy): it reads the question from the file the prompt names, in
// the copy of the project it runs in, runs `nextlevel status` (which reads the real project) and answers. STUB_AGY_ASK_WRITE=1:
// it also writes a file where it runs (the copy); STUB_AGY_ASK_WRITE_REAL=1: one in the real project (NEXTLEVEL_READ_ROOT),
// which the tripwire must notice.
if (/nextlevel ask: read the file (\S+) in this folder/.test(prompt)) {
  const file = prompt.match(/nextlevel ask: read the file (\S+) in this folder/)[1];
  if (format === 'stream-json') print({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), ...(agent.ok ? { agent: agentName } : {}), tools: ['run_command', 'write_to_file', 'view_file'], permission_mode: 'always-proceed' } });
  const question = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
  tool('view_file', { AbsolutePath: path.join(process.cwd(), file) });
  const status = spawnSync('nextlevel status', { shell: true, cwd: process.cwd(), env: process.env, encoding: 'utf8', windowsHide: true });
  tool('run_command', { CommandLine: 'nextlevel status' }, `${status.stdout || ''}${status.stderr || ''}`);
  if (process.env.STUB_AGY_ASK_WRITE === '1') {
    fs.writeFileSync(path.join(process.cwd(), 'written-by-the-assistant.txt'), 'x');
    tool('write_to_file', { TargetFile: path.join(process.cwd(), 'written-by-the-assistant.txt') });
  }
  if (process.env.STUB_AGY_ASK_WRITE_REAL === '1' && process.env.NEXTLEVEL_READ_ROOT) fs.writeFileSync(path.join(process.env.NEXTLEVEL_READ_ROOT, 'written-outside-the-copy.txt'), 'x');
  // (STUB_AGY_ASK_WRITE_REAL_PROTECTED=1: a line added to the real project's AGENTS.md, which the guard's watch sets back)
  if (process.env.STUB_AGY_ASK_WRITE_REAL_PROTECTED === '1' && process.env.NEXTLEVEL_READ_ROOT) fs.appendFileSync(path.join(process.env.NEXTLEVEL_READ_ROOT, 'AGENTS.md'), '\nwritten by the assistant outside its copy\n');
  const asked = (question.match(/## The owner's question\n([\s\S]*)$/) || [])[1]?.trim() || '?';
  const hub = (status.stdout || '').split(/\r?\n/).find((l) => l.startsWith('Hub:')) || '';
  // (it cites files as agy does, by file:/// links and full paths into the copy it runs in: demo, 17 October)
  const cites = `See [BRIEF.md](${pathToFileURL(path.join(process.cwd(), 'BRIEF.md')).href}#L3) and ${path.join(process.cwd(), 'docs', 'PLAN.md')}.`;
  result(`[fake agy] the assistant in ${path.basename(process.cwd())}: you asked "${asked}". ${hub}\n${cites}\nAgent: ${addonsOf()}. Read-only: ${process.env.NEXTLEVEL_READ_ONLY || 'no'}.\nSources: docs/PROJECT.md, nextlevel status\n`);
  process.exit(0);
}
const trace =
  format === 'stream-json'
    ? {
        command: (command, output) => tool('run_command', { CommandLine: command }, output),
        edit: (file) => tool('replace_file_content', { TargetFile: path.isAbsolute(file) ? file : `${process.cwd()}/${file}` }),
        message: (text) => stepUpdate({ state: 'DONE', step_type: 'agent_response', text_delta: `${text}\n`, usage }),
      }
    : undefined;
if (format === 'stream-json') print({ event: 'init', conversation_id: conversation, init: { model, cwd: process.cwd(), tools: ['run_command', 'write_to_file'], permission_mode: 'always-proceed' } });
if (roleOf(prompt) === 'ORCHESTRATOR') orchestratorCycle({ engine: 'agy', noop: process.env.STUB_AGY_MODE === 'noop' });
else await workerTask({ engine: 'agy', prompt, model, effort, addons: addonsOf(), ...(trace ? { trace } : {}) });
result(`[fake agy] ${roleOf(prompt).toLowerCase() || 'task'} done\n`);
