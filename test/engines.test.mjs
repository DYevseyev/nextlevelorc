// Engine adapters and profiles (M6): unit tests of each adapter (src/engines/) and of nextlevel.json's
// profiles, then end to end with the stub CLIs: every engine in every role, second accounts, fallbacks.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ADAPTERS, ENGINE_NAMES, accountDir, accountProblem, binHints, engine, gitByHub, profileEnv, sessionArgs } from '../src/engines/index.mjs';
import { agyFeed, parseAgyModels } from '../src/engines/agy.mjs';
import { claudeFeed, claudeTokens } from '../src/engines/claude.mjs';
import { WORKER_ENV as CODEX_KEEP_ENV, codexFeed, codexRunTokens, codexWorkerCaveat, codexWritesGit, rolloutTokens, sessionTokens } from '../src/engines/codex.mjs';
import { isTestCommand, testSummary } from '../src/engines/util.mjs';
import { asksToMerge, hasConflictMarkers, mergeText } from '../src/lib/slotgit.mjs';
import { ORCHESTRATOR_DENY, WORKER_DENY } from '../src/engines/rules.mjs';
import { defaults, describeProfile, engineUse, findProfile, loadConfig, modelFor, profilesInUse, roleProfile } from '../src/lib/config.mjs';
import { REPO, consoleWorksHere, fileExists, isAlive, makeProject, processesGone, sleep } from './helpers.mjs';

// ---------- the technical feed (the dashboard's "Show activity") ----------
test("the technical feed: Claude Code's stream-json and codex exec --json, as commands, edits and test results; none from Antigravity", () => {
  const lines = (list) => list.map((x) => JSON.stringify(x)).join('\n');
  // Claude Code: its tool calls, each with its result; its text; the end
  const claude = lines([
    { type: 'system', subtype: 'init', cwd: '/s/w1' },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Running the tests first.\nThen fixing.' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'Tests:       1 failed, 12 passed, 13 total' }], is_error: true }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/s/w1/a.js' } }, { type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/s/w1/src/a.js' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'ls' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't4', content: 'a.js\nb.js' }] } },
    { type: 'result', is_error: false, num_turns: 3, result: 'Fixed.', usage: { input_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 5, output_tokens: 20 } },
  ]);
  assert.deepEqual(claudeFeed(`not json\n${claude}`, { cwd: '/s/w1' }).map((e) => [e.kind, e.text, e.detail, e.ok]), [
    ['message', 'Running the tests first.', '', undefined],
    ['test', 'npm test', 'Tests: 1 failed, 12 passed, 13 total', false],
    ['edit', 'edited src/a.js', '', true],
    ['command', 'ls', 'b.js', true],
    ['done', 'finished', '3 turn(s)', true],
  ], 'reads (Read, Grep) are left out');
  assert.deepEqual(engine('claude').tokens(claude), { tokens: 30, cached: 5 }, 'the tokens from the last line, as before');
  const shown = engine('claude').readable(claude);
  assert.match(shown, /^Claude Code: Running the tests first\.\n\$ npm test\nedited \/s\/w1\/src\/a\.js\n\$ ls\nFixed\.\n\n\[Claude Code: 3 turn\(s\), 30 tokens, 5 more read from its cache\]$/);
  assert.deepEqual(claudeFeed('plain text only'), []);

  // Codex: its items, started and completed; the shell it wraps a command in is left out
  const codex = lines([
    { type: 'thread.started', thread_id: 'x' },
    { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: "bash -lc 'pnpm test'", aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: "bash -lc 'pnpm test'", aggregated_output: '== 3 passed, 1 failed in 0.2s ==', exit_code: 1, status: 'failed' } },
    { type: 'item.completed', item: { id: 'i2', type: 'file_change', changes: [{ path: '/s/w1/a.js', kind: 'update' }, { path: '/s/w1/b.js', kind: 'add' }], status: 'completed' } },
    { type: 'item.started', item: { id: 'i3', type: 'command_execution', command: ['powershell.exe', '-Command', 'pnpm.cmd build'].join(' '), aggregated_output: '', exit_code: null, status: 'in_progress' } },
    { type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Done: the tests pass.' } },
    { type: 'turn.failed', error: { message: 'stream error' } },
    { type: 'turn.completed', usage: { input_tokens: 13000, cached_input_tokens: 1000, output_tokens: 345 } },
  ]);
  assert.deepEqual(codexFeed(codex, { cwd: '/s/w1' }).map((e) => [e.kind, e.text, e.detail, e.ok]), [
    ['test', 'pnpm test', '3 passed, 1 failed in 0.2s', false],
    ['edit', 'edited a.js, added b.js', '', true],
    ['command', 'powershell.exe -Command pnpm.cmd build', '', undefined],
    ['message', 'Done: the tests pass.', '', undefined],
    ['error', 'stream error', '', false],
  ], 'a command still running has no result yet');
  assert.deepEqual(codexRunTokens(codex), { tokens: 12345, cached: 1000 }, 'input without the cached part, plus output');
  assert.deepEqual(engine('codex').tokens('tokens used\n12,345'), { tokens: 12345, cached: 0 }, 'an older run without --json');
  assert.match(engine('codex').readable(codex), /\$ pnpm test  -> 3 passed, 1 failed in 0\.2s\nedited \/s\/w1\/a\.js, added \/s\/w1\/b\.js\nCodex: Done: the tests pass\.\nstream error\n\[Codex: 12,345 tokens, 1,000 more read from its cache\]/);
  // Codex's older JSON events
  const legacy = lines([{ id: '1', msg: { type: 'exec_command_begin', call_id: 'c1', command: ['bash', '-lc', 'go test ./...'] } }, { id: '1', msg: { type: 'exec_command_end', call_id: 'c1', exit_code: 0, stdout: 'ok  \texample.com/x\t0.1s\n' } }]);
  assert.deepEqual(codexFeed(legacy).map((e) => [e.kind, e.text, e.detail, e.ok]), [['test', 'go test ./...', 'ok example.com/x 0.1s', true]]);

  // Antigravity (FR-010): its stream-json, as agy 1.2.11 printed it on the owner's PC (test/fixtures/agy-stream-json.txt):
  // a tool step comes twice (ACTIVE, then DONE with its output) and is one event; reading a file is left out
  const agyOut = fs.readFileSync(path.join(REPO, 'test', 'fixtures', 'agy-stream-json.txt'), 'utf8');
  const agyCwd = 'C:\\Users\\User\\AppData\\Local\\Temp\\agy-pty-NKer67';
  assert.deepEqual(engine('agy').feed(agyOut, { cwd: agyCwd }).map((e) => [e.kind, e.text, e.detail, e.ok ?? null]), [
    ['edit', 'wrote hello.txt', '', true],
    ['command', 'node --version', 'v24.19.0', null],
    ['message', 'ok', '', null],
    ['done', 'finished', '1 turn(s)', true],
  ]);
  assert.deepEqual(engine('agy').tokens(agyOut), { tokens: 40251, cached: 48942 }, 'input and output (its total_tokens); cache reads apart');
  assert.deepEqual(engine('agy').tokens('{"conversation_id":"x","status":"SUCCESS","response":"ok","usage":{"input_tokens":29025,"output_tokens":163,"cache_read_tokens":0,"total_tokens":29188}}'), { tokens: 29188, cached: 0 }, '--output-format json: one object');
  assert.match(engine('agy').readable(agyOut), /^wrote .*hello\.txt\n\$ node --version {2}→ v24\.19\.0\nAntigravity: ok\nok\n\n\[Antigravity: 1 turn\(s\), 40,251 tokens, 48,942 more read from its cache\]\n$/);
  assert.equal(engine('agy').readable('[fake agy] a line of its own'), null, 'no JSON: shown as it is');
  assert.deepEqual(agyFeed('{"event":"step_update","step_update":{"step_index":3,"state":"ERROR","step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"npm test"},"output":"# pass 1\\n# fail 2\\n"}}}').map((e) => [e.kind, e.detail, e.ok]), [['test', '1 passed, 2 failed', false]]);
  // headless runs ask for the JSON
  assert.deepEqual(sessionArgs({ engine: 'codex' }, { mode: 'headless', role: 'worker', prompt: 'P', args: ['--json'] }).filter((a) => a === '--json').length, 1, 'not twice');
  assert.ok(!sessionArgs({ engine: 'codex' }, { mode: 'interactive', role: 'orchestrator', prompt: 'P' }).includes('--json'));
  // test commands and their summaries
  for (const cmd of ['npm test', 'pnpm run test -- --watch=false', 'node --test test/', 'npx vitest run', 'pytest -q', 'go test ./...', 'cd app && yarn test']) assert.ok(isTestCommand(cmd), cmd);
  for (const cmd of ['npm install', 'git status', 'echo latest']) assert.ok(!isTestCommand(cmd), cmd);
  assert.equal(testSummary('# tests 3\n# pass 2\n# fail 1\n'), '2 passed, 1 failed');
  assert.equal(testSummary('  12 passing (3s)\n  1 failing\n'), '1 failing');
  assert.equal(testSummary('test result: ok. 4 passed; 0 failed'), 'test result: ok. 4 passed; 0 failed');
});

test('a Codex worker on Windows, in its sandbox, is told about the .cmd shims and that Docker and package installs are out of reach (FR-009)', () => {
  const c = codexWorkerCaveat('win32', ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']);
  assert.match(c.tips, /run pnpm\.cmd, npm\.cmd and npx\.cmd instead of pnpm, npm or npx/);
  assert.match(c.tips, /Docker, ~\/\.docker and pnpm's store can't be reached from this sandbox.*Status: BLOCKED/);
  // the warning names the tasks that fail there, says the network doesn't help, and where to switch
  assert.match(c.warning, /anything that starts Docker \(a stack, compose, an integration check that needs containers\) or reads ~\/\.docker, and package installs \(pnpm install/);
  assert.match(c.warning, /Turning its network on doesn't change that/);
  assert.match(c.warning, /on the Team page/);
  assert.equal(codexWorkerCaveat('linux', []), null);
  assert.equal(codexWorkerCaveat('win32', ['--sandbox', 'danger-full-access']), null, 'without its sandbox it can');
  assert.equal(engine('agy').workerCaveat, undefined);
});

// ---------- adapters ----------
test('every adapter has the whole interface', () => {
  assert.deepEqual(Object.keys(ADAPTERS).sort(), [...ENGINE_NAMES].sort());
  for (const name of ENGINE_NAMES) {
    const e = engine(name);
    assert.equal(e.name, name);
    for (const k of ['title', 'command', 'window']) assert.equal(typeof e[k], 'string', `${name}.${k}`);
    for (const k of ['headless', 'interactive', 'needsRealConsole', 'loginResult']) assert.equal(typeof e[k], 'function', `${name}.${k}`);
    assert.ok(Array.isArray(e.defaultArgs) && Array.isArray(e.login.status) && Array.isArray(e.login.signIn), name);
    assert.ok(e.knownIssues.length > 0, `${name} lists its known issues`);
    assert.equal(typeof e.readsAgentsMd, 'boolean');
    assert.equal(typeof e.writesGit, 'boolean');
    assert.ok(e.account ? typeof e.account.env === 'string' : typeof e.noAccount === 'string', `${name}: how it keeps a second account apart, or why it can't`);
  }
  assert.throws(() => engine('gemini'), /unknown engine "gemini"/);
});

test('headless and interactive arguments per engine and role', () => {
  const codex = { engine: 'codex', model: 'gpt-6' };
  // (a worker keeps the hub's variables whatever the owner's config.toml says of them: Codex's shell_environment_policy)
  assert.deepEqual(sessionArgs(codex, { mode: 'headless', role: 'worker', prompt: 'P', args: ['--sandbox', 'workspace-write'] }), ['exec', '-m', 'gpt-6', '--sandbox', 'workspace-write', ...CODEX_KEEP_ENV, '--json', 'P']);
  assert.deepEqual(sessionArgs(codex, { mode: 'headless', role: 'orchestrator', prompt: 'P', args: ['--sandbox', 'workspace-write'] }), ['exec', '-m', 'gpt-6', '--sandbox', 'workspace-write', '--json', 'P']);
  assert.deepEqual(sessionArgs({ engine: 'codex' }, { mode: 'interactive', role: 'orchestrator', prompt: 'P', args: ['-s', 'x'] }), ['-s', 'x', 'P']);

  // agy: print mode with the task's time limit, its steps as JSON lines; never --effort, not even one in its args (its
  // Claude models refuse it; a Gemini model's name carries the level, FR-010); the guide asks before it acts
  const agy = { engine: 'agy', model: 'stub-pro' };
  assert.deepEqual(sessionArgs(agy, { mode: 'headless', role: 'worker', prompt: 'P', timeoutMin: 45, args: ['--effort', 'high'] }), ['-p', 'P', '--print-timeout', '45m', '--model', 'stub-pro', '--output-format', 'stream-json']);
  assert.deepEqual(sessionArgs({ ...agy, effort: 'high' }, { mode: 'headless', role: 'worker', prompt: 'P', timeoutMin: 5, args: ['--output-format', 'json'] }), ['-p', 'P', '--print-timeout', '5m', '--model', 'stub-pro', '--output-format', 'json'], 'an effort on the profile never reaches it; a format in its args is kept');
  assert.ok(!sessionArgs({ ...agy, model: 'claude-opus-4-6-thinking', effort: 'high' }, { mode: 'interactive', role: 'orchestrator', prompt: 'O', args: ['--effort', 'max'] }).includes('--effort'));
  assert.deepEqual(ADAPTERS.agy.efforts, [], 'no effort setting: the Team page has no Effort field for it');
  assert.deepEqual(['gemini-3.1-pro-high', 'Gemini 3.8 Flash (High)', 'gemini-3.8-flash-low', 'claude-opus-4-6-thinking', 'stub-pro'].map(ADAPTERS.agy.effortOf), ['high', 'high', 'low', '', '']);
  assert.deepEqual(parseAgyModels('Fetching available models...\ngemini-3.1-pro-high\tGemini 3.1 Pro (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)').map((m) => [m.id, m.effort]), [['gemini-3.1-pro-high', 'high'], ['claude-opus-4-6-thinking', '']]);
  assert.deepEqual(sessionArgs(agy, { mode: 'interactive', role: 'guide', prompt: 'G', args: ['--dangerously-skip-permissions'] }), ['-i', 'G', '--model', 'stub-pro']);
  assert.deepEqual(sessionArgs(agy, { mode: 'interactive', role: 'orchestrator', prompt: 'O', args: ['--mode', 'accept-edits'] }), ['-i', 'O', '--model', 'stub-pro', '--mode', 'accept-edits']);

  // Claude Code: the prompt first (the rule lists take several values), told to read AGENTS.md
  const w = sessionArgs({ engine: 'claude', model: 'opus' }, { mode: 'headless', role: 'worker', prompt: 'ROLE: WORKER. Task T.', args: ['--verbose'] });
  assert.deepEqual(w.slice(0, 4), ['-p', "Read AGENTS.md first: it has the team's roles and rules. ROLE: WORKER. Task T.", '--model', 'opus']);
  assert.equal(w[w.indexOf('--permission-mode') + 1], 'acceptEdits');
  assert.equal(w[w.indexOf('--allowedTools') + 1], 'Bash,WebFetch,WebSearch');
  const deny = w[w.indexOf('--disallowedTools') + 1].split(',');
  // (and no Monitor: a wait for what a background watcher reports never comes back to a session that ended, FR-020)
  assert.deepEqual(deny, [...WORKER_DENY.map((c) => `Bash(${c}:*)`), 'Monitor']);
  assert.ok(deny.includes('Bash(git push:*)') && deny.includes('Bash(gh:*)'));
  assert.equal(w.at(-1), '--verbose', "engines.claude.args come last");
  // The orchestrator: the hub's commands without asking, its own git writes never (the hub does them)
  const cycle = sessionArgs({ engine: 'claude' }, { mode: 'headless', role: 'orchestrator', prompt: 'C' });
  assert.equal(cycle[cycle.indexOf('--allowedTools') + 1], 'Bash(nextlevel:*),Bash(git status:*),Bash(git log:*),Bash(git diff:*),Bash(git show:*)');
  assert.deepEqual(cycle[cycle.indexOf('--disallowedTools') + 1].split(','), ORCHESTRATOR_DENY.map((c) => `Bash(${c}:*)`));
  assert.ok(ORCHESTRATOR_DENY.includes('git commit') && ORCHESTRATOR_DENY.includes('git merge'));
  const orch = sessionArgs({ engine: 'claude' }, { mode: 'interactive', role: 'orchestrator', prompt: 'O' });
  assert.match(orch[0], /O$/);
  assert.ok(!orch.includes('-p') && !orch.includes('--permission-mode'), 'the owner is there: edits are asked for');
  assert.deepEqual(sessionArgs({ engine: 'claude' }, { mode: 'interactive', role: 'guide', prompt: 'G' }), ["Read AGENTS.md first: it has the team's roles and rules. G"]);
  // What goes through cmd.exe to a .cmd shim on Windows must not hold quotes or %
  for (const a of [...w, ...cycle, ...orch]) assert.doesNotMatch(a, /["%]/);
});

// ---------- FR-013: workers without the owner's own add-ons ----------
const HOME = path.join(os.tmpdir(), 'nl-addons-home');
function ownerFiles(files) {
  const map = new Map(Object.entries(files).map(([rel, text]) => [path.join(HOME, ...rel.split('/')), text]));
  return {
    home: HOME,
    env: {},
    path,
    read: (f) => (map.has(f) ? map.get(f) : null),
    list: (d) => [...new Set([...map.keys()].filter((f) => f.startsWith(d + path.sep)).map((f) => f.slice(d.length + 1).split(path.sep)[0]))],
  };
}
test("agy workers run as an agent that inherits none of the owner's own add-ons, written into the slot (FR-013)", async () => {
  const { workerIsolation } = await import('../src/engines/index.mjs');
  const files = ownerFiles({
    '.gemini/config/mcp_config.json': '{\n  // comments and a trailing comma, as agy allows\n  "mcpServers": { "rafter": { "command": "cmd", "args": ["/c", "npx"] }, "old": { "command": "x", "disabled": true }, },\n}',
    '.gemini/GEMINI.md': 'my rules',
    '.gemini/config/plugins/firebase/plugin.json': '{}',
  });
  const iso = workerIsolation({ engine: 'agy' }, undefined, files);
  assert.deepEqual(iso.args, ['--agent', 'nextlevel-worker']);
  assert.deepEqual(iso.files.map((f) => f.path), [['.agents', 'agents', 'nextlevel-worker.md']]);
  assert.match(iso.files[0].text, /^---\nname: "nextlevel-worker"\n[\s\S]*^inheritCustomizations: false\ninheritMcp: false\n(tools:\n[\s\S]*?)?---\n/m);
  assert.equal(iso.readsAgentsMd, false, "without its customizations agy doesn't get the project's AGENTS.md either");
  assert.deepEqual(iso.found.mcpServers.map((s) => s.name), ['rafter'], 'a disabled server is none');
  assert.deepEqual([iso.found.plugins, iso.found.rules], [['firebase'], ['GEMINI.md']]);
  assert.deepEqual(iso.left.map((l) => l.what), ['mcp-processes'], 'its MCP servers still start: said, not hidden');
  // The worker's arguments: the agent on top of its own, and told to read AGENTS.md
  const args = sessionArgs({ engine: 'agy', model: 'm' }, { mode: 'headless', role: 'worker', prompt: 'ROLE: WORKER.', timeoutMin: 5, args: ['--mode', 'accept-edits'], isolation: iso });
  assert.deepEqual(args, ['-p', "Read AGENTS.md first: it has the team's roles and rules. ROLE: WORKER.", '--print-timeout', '5m', '--model', 'm', '--output-format', 'stream-json', '--mode', 'accept-edits', '--agent', 'nextlevel-worker']);
  // What workers.addons keeps turns the part that holds it back on; agy can't pick single servers
  const mcp = workerIsolation({ engine: 'agy' }, { mcpServers: ['rafter'] }, files);
  assert.match(mcp.files[0].text, /inheritCustomizations: false\ninheritMcp: true/);
  assert.deepEqual(mcp.left.map((l) => l.what), ['mcp-processes', 'mcp-some']);
  const all = workerIsolation({ engine: 'agy' }, { mcpServers: ['rafter'], skills: true, hooks: true }, files);
  assert.deepEqual([all.args, all.files, all.readsAgentsMd], [[], [], true], 'everything kept: its default agent');
});

test('agy 1.3.4 and on (FR-022): the agent file is valid YAML, a failure says why in its own words, and its output, tokens and models read right', async () => {
  const { agyFailure, agyMcpStrings, agyResult, agyWorkerAgent } = await import('../src/engines/agy.mjs');
  const fixture = (name) => fs.readFileSync(path.join(REPO, 'test', 'fixtures', name), 'utf8');
  // The agent file: every text in its frontmatter quoted, so no ": " can end a plain YAML value (1.3.4 dropped the
  // file whose description had one: "unknown agent")
  const front = agyWorkerAgent().match(/^---\n([\s\S]*?)\n---\n/)[1].split('\n');
  for (const line of front) {
    const [, key, value] = line.match(/^(\w+): (.*)$/);
    assert.ok(/^(true|false|".*")$/.test(value), `${key}: ${value}`);
    if (value.startsWith('"')) assert.equal(typeof JSON.parse(value), 'string', `${key} is a quoted text`);
  }
  assert.equal(JSON.parse(front.find((l) => l.startsWith('description:')).slice(13)), "A worker of nextlevel's build team: one task in its slot. Written by the nextlevel hub at every task start.");
  // After 1.3.2 it lists the tools a worker needs (1.3.5 gave an agent without the list only tools that look), each one
  // its registry knows, none of the owner's (MCP servers stay out, FR-013); for 1.3.2 the file is as it was
  const { workerIsolation } = await import('../src/engines/index.mjs');
  const fileFor = (version) => workerIsolation({ engine: 'agy' }, undefined, { ...ownerFiles({}), version }).files[0].text;
  for (const v of ['1.3.4', '1.3.5', 'agy 1.4.0 (beta)', '']) {
    const tools = fileFor(v).match(/^tools:\n((?: {2}- ".*"\n)+)/m)?.[1].trim().split('\n').map((l) => JSON.parse(l.trim().slice(2)));
    assert.deepEqual(tools, ['view_file', 'write_to_file', 'replace_file_content', 'multi_replace_file_content', 'notebook_edit', 'run_command', 'list_dir', 'grep_search', 'find_by_name', 'manage_task', 'wait', 'search_web', 'read_url_content'], v || 'a version it can\'t read: as the newest');
  }
  for (const v of ['1.3.2', '1.2.12']) assert.doesNotMatch(fileFor(v), /^tools:/m, v);
  for (const name of ['call_mcp_tool', 'list_resources', 'read_resource', 'command_status', 'send_command_input', 'sed_file', 'notebook_execution']) assert.doesNotMatch(fileFor('1.3.5'), new RegExp(`"${name}"`), name);

  // What 1.3.5 printed for the doctor's trial on the owner's PC: its own reason, never just ERROR
  const unknown = fixture('agy-1.3.5-unknown-agent.txt');
  assert.deepEqual(agyResult(unknown), { ok: false, status: 'ERROR', response: '', error: 'unknown agent "nextlevel-worker" (available: rules-writer, a11y_agent)' });
  const f = agyFailure(unknown, { code: 1 });
  assert.equal(f.reason, 'unknown agent "nextlevel-worker" (available: rules-writer, a11y_agent)');
  assert.equal(f.code, 1);
  assert.equal(f.last[0], 'error: unknown agent "nextlevel-worker" (available: rules-writer, a11y_agent)');
  assert.ok(f.last.length <= 20);
  // ...an API failure's AGY_ERROR line, an error event, a plain error line, and the response of a result that isn't SUCCESS
  assert.equal(agyFailure('AGY_ERROR: {"short_error":"You have reached your individual quota","status":"RESOURCE_EXHAUSTED","retryable":false}').reason, 'You have reached your individual quota');
  assert.equal(agyFailure('{"event":"error","error":{"message":"Authentication expired. Please log back in."}}').reason, 'Authentication expired. Please log back in.');
  assert.equal(agyFailure('Error: model x is not available for your plan', { code: 1 }).reason, 'model x is not available for your plan');
  assert.equal(agyFailure('{"event":"result","result":{"status":"CANCELED","response":"stopped by the user\\nmore"}}').reason, 'stopped by the user');
  assert.equal(agyFailure('{"event":"result","result":{"status":"SUCCESS","response":"ok"}}').reason, '', 'a run that went well has no reason');
  const long = agyFailure(Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n'));
  assert.deepEqual([long.last.length, long.last[0], long.last.at(-1)], [20, 'line 30', 'line 49'], 'its last 20 lines');
  // The owner's MCP servers' settings: every string of their args, env and headers, and the keys inside them
  const mcp = agyMcpStrings({ home: '/h', path: path.posix, read: () => JSON.stringify({ mcpServers: { stitch: { command: 'npx', args: ['-y', 'stitch-mcp', '--header', 'X-Goog-Api-Key: abcdefghijklmnop123'] }, r: { serverUrl: 'https://x', headers: { 'X-Api-Key': 'tok_1234567890abcdef' }, env: { RAFTER_API_KEY: 'rf_live_0123456789' } } } }) });
  for (const s of ['stitch-mcp', '--header', 'abcdefghijklmnop123', 'tok_1234567890abcdef', 'rf_live_0123456789']) assert.ok(mcp.includes(s), s);
  assert.ok(!mcp.includes('-y') && !mcp.includes('npx'), 'shorter than six characters: no secret worth blanking out');

  // A real 1.3.5 run as a worker (redacted: the PC's paths): its result, tokens and feed
  const out = fixture('agy-1.3.5-stream-json.txt');
  assert.equal(agyResult(out).ok, true);
  assert.deepEqual(engine('agy').tokens(out), { tokens: 8490, cached: 3790 }, 'input and output of its result; cache reads apart');
  assert.deepEqual(engine('agy').feed(out, { cwd: 'C:\\Users\\me\\proj.slots\\w1' }).map((e) => [e.kind, e.ok ?? null]), [['message', null], ['done', true]], 'reading AGENTS.md (which failed) is left out; its message and the end');
  assert.match(engine('agy').feed(out)[0].text, /^Hello! I'm ready to help\. Please let me know what task you'd like me to work on/, '1.3.5 streams a message in pieces: put together');
  // ...and the worker's log, written a line at a time as it comes, shows it once, whole
  const shown = out.split('\n').map((l) => engine('agy').readable(l)).filter((l) => l);
  assert.deepEqual(shown.filter((l) => l.startsWith('Antigravity: ')), ["Antigravity: Hello! I'm ready to help. Please let me know what task you'd like me to work on (or point me to the worker guide and task file if applicable)."]);
  assert.match(engine('agy').readable(out), /\[Antigravity: 1 turn\(s\), 8,490 tokens, 3,790 more read from its cache\]/);
  // its tool step's error is an object on 1.3.5: read as its message, never [object Object]
  const stepError = agyFeed('{"event":"step_update","step_update":{"step_index":2,"state":"ERROR","step_type":"tool","tool_name":"write_to_file","tool_info":{"parameters":{"TargetFile":"/s/a.txt"},"error":{"type":"TOOL_ERROR","message":"permission denied"}}}}');
  assert.deepEqual(stepError.map((e) => [e.text, e.detail, e.ok]), [['wrote /s/a.txt', 'failed: permission denied', false]]);

  // `agy models` on 1.3.5 (Gemini 4 Argon, 13 October): every model with the level its name carries
  const models = parseAgyModels(fixture('agy-1.3.5-models.txt'));
  assert.deepEqual(models.map((m) => [m.id, m.effort]), [
    ['gemini-4-argon-medium', 'medium'], ['gemini-4-argon-high', 'high'], ['gemini-4-argon-low', 'low'],
    ['gemini-3.8-flash-high', 'high'], ['gemini-3.8-flash-medium', 'medium'], ['gemini-3.8-flash-low', 'low'],
    ['claude-opus-5-5-low', 'low'], ['claude-opus-5-5-medium', 'medium'], ['claude-opus-5-5-high', 'high'],
    ['claude-sonnet-5-5-low', 'low'], ['claude-sonnet-5-5-medium', 'medium'], ['claude-sonnet-5-5-high', 'high'],
    ['gpt-oss-120b-medium', 'medium'],
  ]);
  assert.equal(models[1].label, 'Gemini 4 Argon (High)');
  assert.match(ADAPTERS.agy.effortNote, /^Antigravity takes the level from the model's name \(gemini-3\.8-flash-high is high, claude-opus-5-5-medium is medium\): pick the model with the level you want\. nextlevel doesn't pass --effort\.$/);
});

test("Codex workers get the owner's MCP servers, plugins, hooks, apps and skills switched off for the session; the sign-in stays (FR-013)", async () => {
  const { workerIsolation } = await import('../src/engines/index.mjs');
  const files = ownerFiles({
    '.codex/config.toml': 'model = "gpt-6"\n[mcp_servers.searchy]\ncommand = "searchy.exe"\n[mcp_servers.node_repl]\ncommand = "node_repl.exe"\n[mcp_servers.node_repl.env]\nA = "1"\n[mcp_servers."odd name"]\ncommand = "x"\n[mcp_servers.off]\ncommand = "y"\nenabled = false\n[mcp_servers.remote]\nurl = "https://example.com/mcp"\n[plugins."browser@openai-bundled"]\nenabled = true\n[plugins."gone@x"]\nenabled = false\n[hooks.state."a"]\ntrusted_hash = "x"\n',
    '.codex/skills/.system/x/SKILL.md': '',
    '.agents/skills/rafter/SKILL.md': '---\nname: rafter\ndescription: x\n---\n',
    '.agents/skills/folder-name/SKILL.md': 'no frontmatter',
  });
  const iso = workerIsolation({ engine: 'codex' }, undefined, files);
  assert.deepEqual(iso.found.mcpServers.map((s) => s.name), ['searchy', 'node_repl', 'odd name', 'remote']);
  assert.deepEqual([iso.found.plugins, iso.found.hooks, iso.found.skills], [['browser@openai-bundled'], [], ['rafter', 'folder-name']]);
  assert.deepEqual(iso.args, [
    '-c', 'mcp_servers.searchy.enabled=false',
    '-c', 'mcp_servers.node_repl.enabled=false',
    '-c', 'mcp_servers.remote.enabled=false',
    '--disable', 'plugins',
    '-c', "skills.config=[{name='rafter',enabled=false},{name='folder-name',enabled=false}]",
    '--disable', 'hooks',
    '--disable', 'apps',
  ]);
  assert.deepEqual(iso.left.map((l) => l.what), ['mcp-name'], 'a server whose name -c can\'t carry is said');
  assert.equal(iso.readsAgentsMd, true);
  // On the command line: after engines.codex.args, before --json and the prompt, which stays last
  const args = sessionArgs({ engine: 'codex', model: 'gpt-6' }, { mode: 'headless', role: 'worker', prompt: 'P', args: ['--sandbox', 'workspace-write'], isolation: iso });
  assert.deepEqual(args.slice(0, 5), ['exec', '-m', 'gpt-6', '--sandbox', 'workspace-write']);
  assert.deepEqual(args.slice(-2), ['--json', 'P']);
  // Kept by workers.addons: those stay on
  const kept = workerIsolation({ engine: 'codex' }, { mcpServers: ['searchy', 'apps'], skills: true, hooks: true }, files);
  assert.deepEqual(kept.args, ['-c', 'mcp_servers.node_repl.enabled=false', '-c', 'mcp_servers.remote.enabled=false']);
});

test("Claude Code workers get no MCP servers and none of the user's settings, with the owner's model passed on (FR-013)", async () => {
  const { workerIsolation } = await import('../src/engines/index.mjs');
  const files = ownerFiles({ '.claude/settings.json': '{ "model": "opus", "effortLevel": "high", "hooks": { "PreToolUse": [] }, "enabledPlugins": { "a@b": true, "c@d": false } }', '.claude.json': '{ "mcpServers": { "searchy": { "command": "searchy" } } }', '.claude/skills/rafter/SKILL.md': '' });
  const iso = workerIsolation({ engine: 'claude' }, undefined, files);
  assert.deepEqual(iso.args, ['--strict-mcp-config', '--setting-sources', 'project,local']);
  assert.deepEqual(iso.pin, { model: 'opus', effort: 'high' }, "the user's settings are left out, so their model and effort are passed");
  assert.deepEqual([iso.found.mcpServers.map((s) => s.name), iso.found.hooks, iso.found.plugins, iso.found.skills], [['searchy'], ['PreToolUse'], ['a@b'], ['rafter']]);
  const args = sessionArgs({ engine: 'claude', model: 'opus' }, { mode: 'headless', role: 'worker', prompt: 'P', isolation: iso });
  assert.deepEqual(args.slice(-3), ['--strict-mcp-config', '--setting-sources', 'project,local']);
  const kept = workerIsolation({ engine: 'claude' }, { mcpServers: ['searchy'], skills: true }, files);
  assert.deepEqual([kept.args, kept.pin, kept.left.map((l) => l.what)], [[], null, ['mcp-some', 'user-some']]);
  // An engine's own login in another folder (a named account) is read there
  const named = workerIsolation({ engine: 'claude', account: 'work' }, undefined, ownerFiles({ '.nextlevel/accounts/claude/work/settings.json': '{ "model": "sonnet" }' }));
  assert.equal(named.pin.model, 'sonnet');
  // What goes on the command line looks like a model and an effort, or isn't passed; a server's arguments aren't kept
  const odd = workerIsolation({ engine: 'claude' }, undefined, ownerFiles({ '.claude/settings.json': '{ "model": "opus\\" & calc & \\"", "effortLevel": "%HIGH%" }', '.claude.json': '{ "mcpServers": { "s": { "command": "npx", "args": ["-y", "x", "--key", "SECRET"] } } }' }));
  assert.deepEqual(odd.pin, { model: '', effort: '' });
  assert.deepEqual(odd.found.mcpServers, [{ name: 's', command: 'npx' }]);
});

test("Codex's windows run without its shared background server when its --help lists --no-daemon; agy's headless sessions without its updater (FR-011)", async () => {
  const { windowArgs } = await import('../src/engines/index.mjs');
  const asked = [];
  const run = (out, ok = true) => (cmd, args) => (asked.push([cmd, ...args].join(' ')), { ok, out });
  assert.deepEqual(windowArgs({ engine: 'codex' }, run('Options:\n      --no-daemon\n          Run without the shared background server')), ['--no-daemon']);
  assert.deepEqual(asked, ['codex --help']);
  assert.deepEqual(windowArgs({ engine: 'codex' }, run('Options:\n  -m, --model <MODEL>')), [], 'an older Codex would refuse it');
  assert.deepEqual(windowArgs({ engine: 'codex' }, run('', false)), []);
  assert.deepEqual(windowArgs({ engine: 'agy' }, run('--no-daemon')), [], 'nothing for an engine without them');
  assert.deepEqual(sessionArgs({ engine: 'codex' }, { mode: 'interactive', role: 'orchestrator', prompt: 'O', args: ['--sandbox', 'workspace-write'], extra: ['--no-daemon'] }), ['--sandbox', 'workspace-write', '--no-daemon', 'O']);
  assert.deepEqual(engine('agy').headlessEnv, { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' }, '"true": "1" was measured not to stop it');
});

test('workers.addons in nextlevel.json: MCP servers by name, skills and hooks as switches; none by default (FR-013)', () => {
  assert.deepEqual(defaults().workers.addons, { mcpServers: [], skills: false, hooks: false });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-addons-'));
  try {
    const write = (addons) => fs.writeFileSync(path.join(root, 'nextlevel.json'), JSON.stringify({ version: 1, name: 'p', workers: { addons } }));
    write({ mcpServers: ['github', 'rafter'], skills: true });
    assert.deepEqual(loadConfig(root, { env: {} }).config.workers.addons, { mcpServers: ['github', 'rafter'], skills: true, hooks: false });
    write({ mcpServers: ['has space'] });
    assert.throws(() => loadConfig(root, { env: {} }), /"workers\.addons\.mcpServers" names MCP servers as the engine's own config names them, like "github": "has space" isn't one/);
    write({ skills: 'yes' });
    assert.throws(() => loadConfig(root, { env: {} }), /"workers\.addons\.skills" must be a boolean/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('which engines need a real console, and where agy may be installed', () => {
  assert.equal(engine('agy').needsRealConsole('win32'), true, 'agy -p drops its output without a real console on Windows');
  assert.equal(engine('agy').needsRealConsole('linux'), false);
  for (const name of ['codex', 'claude']) assert.equal(engine(name).needsRealConsole('win32'), false, `${name} runs headless`);
  assert.deepEqual(binHints('agy', 'C:\\Users\\me', 'win32', path.win32), ['C:\\Users\\me\\.local\\bin\\agy.exe', 'C:\\Users\\me\\AppData\\Local\\agy\\bin\\agy.exe']);
  assert.deepEqual(binHints('agy', '/home/me', 'linux', path.posix), []);
  assert.deepEqual(binHints('git', 'C:\\Users\\me', 'win32', path.win32), []);
  assert.equal(engine('codex').writesGit, false, "Codex's sandbox keeps .git read-only");
});

test("FR-008: who does a worker's git, and when the hub merges the base branch in", () => {
  // Codex's sandbox can't write a slot's git: the hub does it, unless the owner runs Codex without its sandbox
  assert.equal(gitByHub({ engine: 'codex' }, ['--sandbox', 'workspace-write']), true);
  assert.equal(codexWritesGit(['-s', 'danger-full-access']), true);
  assert.equal(gitByHub({ engine: 'codex' }, ['--dangerously-bypass-approvals-and-sandbox']), false);
  for (const name of ['agy', 'claude']) assert.equal(gitByHub({ engine: name }, ADAPTERS[name].defaultArgs), false, name);
  // Feedback that asks for the base branch
  for (const text of ['merge main into your branch first and resolve the conflicts', 'Rebase onto main.', 'Please merge the latest origin/main, then rerun the tests', 'merge the base branch in']) assert.equal(asksToMerge(text, 'main'), true, text);
  for (const text of ['Fix the merge conflict marker in main.js', 'Create fixed.txt', 'the main problem is the merge sort']) assert.equal(asksToMerge(text, 'main'), false, text);
  assert.equal(asksToMerge('merge develop into your branch', 'develop'), true);
  assert.equal(hasConflictMarkers('a\n<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> main\n'), true);
  assert.equal(hasConflictMarkers('# Title\n=======\ntext <<<<<<< inline\n'), false, 'a heading underline or markers inside a line are not conflicts');
  assert.equal(mergeText({ base: 'main', result: 'up to date' }), '');
  assert.equal(mergeText({ base: 'main', result: 'conflicts', files: ['a', 'b'], resolved: false }), 'the hub merged main in first: conflicts in 2 file(s) left unresolved');
});

test("tokens as each engine reports them: Codex's output and session files, Claude Code's JSON, none from Antigravity (FR-008)", () => {
  // Claude Code's JSON result, at the end of whatever it printed; cache reads apart
  const json = { type: 'result', result: 'ok', num_turns: 2, usage: { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 900, output_tokens: 20 } };
  assert.deepEqual(claudeTokens(`[fake claude] task=x\n${JSON.stringify(json)}\n`), { tokens: 35, cached: 900 });
  assert.deepEqual(engine('claude').tokens(JSON.stringify(json, null, 2)), { tokens: 35, cached: 900 }, 'pretty-printed too');
  assert.equal(engine('claude').tokens('plain text, no JSON'), null);
  assert.match(engine('claude').readable(JSON.stringify(json)), /^ok\n\n\[Claude Code: 2 turn\(s\), 35 tokens, 900 more read from its cache\]$/);
  assert.equal(engine('claude').readable(`header\n${JSON.stringify(json)}\n`), 'header\nok\n\n[Claude Code: 2 turn(s), 35 tokens, 900 more read from its cache]\n', 'the lines before it stay');
  // headless runs ask for it, unless engines.claude.args chose a format
  const args = sessionArgs({ engine: 'claude' }, { mode: 'headless', role: 'worker', prompt: 'P' });
  assert.equal(args[args.indexOf('--output-format') + 1], 'stream-json');
  assert.ok(args.includes('--verbose'), 'claude -p takes stream-json only with --verbose');
  assert.equal(sessionArgs({ engine: 'claude' }, { mode: 'headless', role: 'worker', prompt: 'P', args: ['--output-format', 'stream-json'] }).filter((a) => a === '--output-format').length, 1);
  assert.ok(!sessionArgs({ engine: 'claude' }, { mode: 'interactive', role: 'orchestrator', prompt: 'P' }).includes('--output-format'));
  assert.deepEqual(engine('codex').tokens('...\ntokens used\n12,345\n'), { tokens: 12345, cached: 0 });
  assert.equal(engine('codex').tokens('failed early'), null);
  assert.equal(engine('agy').tokens('anything'), null);
  assert.equal(engine('agy').usage.headless, 'its stream-json output', 'Antigravity: reported since FR-010 (its output comes through pipes)');

  // Codex's session files: the last running total of each interactive session that started in the folder
  const event = (u) => JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: u && { total_token_usage: u } } });
  const meta = (cwd, at, source) => JSON.stringify({ timestamp: at, type: 'session_meta', payload: { id: 'x', timestamp: at, cwd, originator: source === 'exec' ? 'codex_exec' : 'codex_cli_rs', source } });
  const total = { input_tokens: 5000, cached_input_tokens: 3000, output_tokens: 400, total_tokens: 5400 };
  assert.deepEqual(rolloutTokens([event({ input_tokens: 1, output_tokens: 1 }), event(total), event(null)].join('\n')), { tokens: 2400, cached: 3000 });
  const since = Date.parse('2026-09-26T10:00:00Z');
  const d = new Date(since);
  const day = path.posix.join('/codex', 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  const at = (min) => new Date(since + min * 60_000).toISOString();
  const files = {
    [`${day}/rollout-a.jsonl`]: [meta('/proj', at(1), 'cli'), event(total)].join('\n'),
    [`${day}/rollout-b.jsonl`]: [meta('/proj', at(2), 'exec'), event(total)].join('\n'), // codex exec: counted from its output
    [`${day}/rollout-c.jsonl`]: [meta('/other', at(3), 'cli'), event(total)].join('\n'), // another folder
    [`${day}/rollout-d.jsonl`]: [meta('/proj', at(-30), 'cli'), event(total)].join('\n'), // before the session
    [`${day}/rollout-e.jsonl`]: [meta('/proj', at(4), 'vscode'), event(total)].join('\n'),
    [`${day}/notes.txt`]: 'x',
  };
  const list = (dir) => Object.keys(files).filter((f) => path.posix.dirname(f) === dir).map((f) => path.posix.basename(f));
  const read = (f) => files[f] ?? null;
  const got = sessionTokens({ dir: '/codex', cwd: '/proj', since, until: since + 10 * 60_000, read, list, path: path.posix });
  assert.deepEqual(got, { tokens: 4800, cached: 6000, files: ['rollout-a.jsonl', 'rollout-e.jsonl'] });
  assert.deepEqual(sessionTokens({ dir: '/codex', cwd: '/proj', since, until: since + 10 * 60_000, read, list, path: path.posix, skip: ['rollout-a.jsonl'] }).files, ['rollout-e.jsonl'], 'a session counted once');
  assert.equal(sessionTokens({ dir: '/codex', cwd: '/proj', since: since + 3_600_000, read, list, path: path.posix }), null);
});

test('a second account: its own folder for Codex and Claude Code, said plainly for Antigravity', () => {
  const home = '/home/me';
  assert.equal(accountDir(home, 'codex', 'work', path.posix), '/home/me/.nextlevel/accounts/codex/work');
  const base = { PATH: '/bin', anthropic_api_key: 'sk-ant-x', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_OAUTH_TOKEN: 'o', CODEX_HOME: '/elsewhere' };
  // The engine's own login: the environment as it is
  assert.deepEqual(profileEnv(base, { engine: 'claude', account: '' }, { home, path: path.posix }), base);
  const claude = profileEnv(base, { name: 'cw', engine: 'claude', account: 'work' }, { home, path: path.posix });
  assert.equal(claude.CLAUDE_CONFIG_DIR, '/home/me/.nextlevel/accounts/claude/work');
  for (const k of ['anthropic_api_key', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.ok(!(k in claude), `${k} would win over the account's own sign-in`);
  assert.equal(claude.CODEX_HOME, '/elsewhere', 'other engines keep theirs');
  const codex = profileEnv({ PATH: '/bin', Codex_Home: '/old' }, { name: 'cx', engine: 'codex', account: 'two' }, { home, path: path.posix });
  assert.deepEqual(codex, { PATH: '/bin', CODEX_HOME: '/home/me/.nextlevel/accounts/codex/two' }, 'one CODEX_HOME, whatever the case of the old one (Windows)');

  const agy = { name: 'agy-two', engine: 'agy', account: 'two' };
  assert.match(accountProblem(agy), /^profile "agy-two" names account "two", but Antigravity CLI can't keep a second account apart: it has no setting for where it keeps its sign-in/);
  assert.throws(() => profileEnv(base, agy, { home }), /can't keep a second account apart/);
  assert.equal(accountProblem({ engine: 'agy', account: '' }), '');
});

test('sign-in status, as each CLI tells it', () => {
  const claude = engine('claude').loginResult;
  assert.deepEqual(claude({ ok: true, out: JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'max' }) }), { ok: true, detail: 'signed in (me@example.com, max)' });
  assert.deepEqual(claude({ ok: false, out: JSON.stringify({ loggedIn: false, authMethod: 'none' }) }), { ok: false, detail: 'not signed in' });
  assert.match(claude({ ok: true, out: JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKeySource: 'ANTHROPIC_API_KEY' }) }).detail, /an API key \(ANTHROPIC_API_KEY\), billed by use, not a subscription/);
  const old = claude({ ok: false, out: "error: unknown command 'auth'" });
  assert.equal(old.unknown, true);
  assert.match(old.detail, /older Claude Code: update it/);
  assert.deepEqual(engine('codex').loginResult({ ok: true, out: 'Logged in using ChatGPT\n' }), { ok: true, detail: 'Logged in using ChatGPT' });
  assert.deepEqual(engine('codex').loginResult({ ok: false, out: 'Not logged in' }), { ok: false, detail: 'not signed in' });
  assert.equal(engine('agy').loginResult({ ok: false, timedOut: true }).detail, 'unknown (no answer)');
});

// ---------- nextlevel.json: profiles ----------
function configFile(obj) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-cfg-'));
  fs.writeFileSync(path.join(dir, 'nextlevel.json'), JSON.stringify({ version: 1, ...obj }));
  try {
    return loadConfig(dir, { env: {} });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the default team is unchanged: Codex orchestrates, Antigravity works and falls back to Codex', () => {
  const cfg = defaults('p');
  assert.deepEqual(roleProfile(cfg, 'orchestrator'), { name: '', engine: 'codex', account: '', model: '', effort: '' });
  assert.deepEqual(roleProfile(cfg, 'worker'), { name: '', engine: 'agy', account: '', model: '', effort: '' });
  assert.deepEqual(roleProfile(cfg, 'worker', { fallback: true }), { name: '', engine: 'codex', account: '', model: '', effort: '' });
  assert.deepEqual(roleProfile(cfg, 'guide'), roleProfile(cfg, 'orchestrator'), "the setup guide is on the orchestrator's engine");
  assert.equal(roleProfile(cfg, 'orchestrator', { fallback: true }), null);
  assert.deepEqual(cfg.engines.codex.args, ['--sandbox', 'workspace-write']);
  assert.deepEqual(cfg.engines.claude.args, []);
  // A file from before M6 (roles as { engine, model }, no profiles) reads the same
  const old = configFile({ roles: { orchestrator: { engine: 'codex', model: 'gpt-6' }, worker: { engine: 'agy', model: '' } } });
  assert.deepEqual(old.warnings, []);
  // (the workers' fallback named by its engine takes a worker's model on that engine, never the orchestrator's: none here,
  // so Codex's own choice)
  assert.deepEqual(profilesInUse(old.config).map(describeProfile), ['codex gpt-6', 'agy', 'codex']);
  assert.equal(engineUse(old.config, 'codex'), 'role');
  assert.equal(engineUse(old.config, 'claude'), null);
});

test('profiles: an engine, an account and a model, named by a role; any engine in any role', () => {
  const { config } = configFile({
    roles: { orchestrator: { profile: 'claude-work', fallback: 'codex' }, worker: { profile: 'codex-two', fallback: 'agy' } },
    profiles: { 'claude-work': { engine: 'claude', account: 'work', model: 'opus' }, 'codex-two': { engine: 'codex', account: 'two' }, spare: { engine: 'agy' } },
  });
  assert.deepEqual(roleProfile(config, 'orchestrator'), { name: 'claude-work', engine: 'claude', account: 'work', model: 'opus', effort: '' });
  assert.deepEqual(roleProfile(config, 'worker'), { name: 'codex-two', engine: 'codex', account: 'two', model: '', effort: '' });
  assert.equal(roleProfile(config, 'worker', { fallback: true }).engine, 'agy');
  assert.deepEqual(profilesInUse(config).map((p) => [p.role, p.fallback, p.name || p.engine]), [
    ['orchestrator', false, 'claude-work'],
    ['worker', false, 'codex-two'],
    ['orchestrator', true, 'codex'],
    ['worker', true, 'agy'],
  ]);
  assert.equal(engineUse(config, 'agy'), 'fallback');
  assert.equal(findProfile(config, 'spare').engine, 'agy');
  assert.equal(findProfile(config, 'nope'), null);
  assert.equal(describeProfile(roleProfile(config, 'orchestrator')), 'claude-work (claude, account work, opus)');
  // An engine named on its own takes the model a role pins for it with its own login
  const pinned = configFile({ roles: { orchestrator: { engine: 'claude', model: 'sonnet' } } }).config;
  assert.equal(modelFor(pinned, 'claude'), 'sonnet');
  assert.equal(findProfile(pinned, 'claude').model, 'sonnet');
});

test('profile mistakes in nextlevel.json are errors that name the setting', () => {
  const bad = (obj, re) => assert.throws(() => configFile(obj), re);
  bad({ roles: { worker: { profile: 'ghost' } } }, /"roles\.worker\.profile" is "ghost", which "profiles" doesn't have/);
  bad({ roles: { worker: { profile: 'a', engine: 'agy' } }, profiles: { a: { engine: 'codex' } } }, /"roles\.worker" names profile "a" and an engine, model or effort too/);
  bad({ profiles: { codex: { engine: 'codex' } } }, /"profiles\.codex": a profile can't have an engine's name/);
  bad({ profiles: { 'My Profile': { engine: 'codex' } } }, /"profiles\.My Profile": a profile's name has lowercase letters/);
  bad({ profiles: { a: { engine: 'gemini' } } }, /"profiles\.a\.engine" must be agy, codex or claude, not "gemini"/);
  bad({ profiles: { a: { engine: 'codex', account: '../x' } } }, /"profiles\.a\.account" becomes a folder name/);
  bad({ profiles: { a: 'codex' } }, /"profiles\.a" must be an object/);
  bad({ roles: { orchestrator: { fallback: 'nobody' } } }, /"roles\.orchestrator\.fallback" names a profile or an engine \(agy, codex, claude\), not "nobody"/);
  bad({ roles: { worker: { engine: 'gemini' } } }, /"roles\.worker\.engine" must be agy, codex or claude, not "gemini"/);
  // A key a newer nextlevel knows only warns; "$" keys are comments
  const warned = configFile({ profiles: { a: { engine: 'codex', colour: 'blue', $note: 'x' } } });
  assert.deepEqual(warned.warnings, ['unknown setting "profiles.a.colour" (ignored)']);
});

// ---------- end to end, with the stub CLIs ----------
const report = (p, id) => fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
// A task spec whose "Engine: agy" line (helpers.mjs writes one) is replaced: by `line`, or by nothing, so
// the worker role's profile takes it
function spec(p, id, verify, line = '') {
  p.spec(id, verify);
  const f = path.join(p.repo, 'docs', 'tasks', `${id}.md`);
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Engine: agy\n', line ? `${line}\n` : ''));
}
const claudeCalls = (p) => {
  const f = path.join(p.env.HOME, '.fake-claude', 'calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('workers on every engine: Claude Code headless with its rules, Codex leaving its commit to the hub', () => {
  const p = makeProject();
  try {
    p.spec('M6-01-ok', fileExists('ok.mjs'));
    spec(p, 'M6-02-ok', fileExists('ok.mjs'), 'Engine: codex'); // the spec's own line
    assert.match(p.hub(['dispatch', 'M6-01-ok', '--engine', 'claude', '--model', 'opus']).out, /queued M6-01-ok \(attempt 1, claude, kind code/);
    p.hub(['dispatch', 'M6-02-ok']);
    const r = p.runUntilIdle();
    assert.equal(p.status('M6-01-ok').state, 'done', r.out);
    assert.equal(p.status('M6-01-ok').engine, 'claude');
    assert.match(report(p, 'M6-01-ok'), /Engine: claude\nModel: opus\nAccount folder: own login/);
    const call = claudeCalls(p).find((c) => c.args.includes('-p'));
    assert.match(call.args[1], /^Read AGENTS\.md first: .*ROLE: WORKER\. Task M6-01-ok\./);
    assert.ok(call.args[call.args.indexOf('--disallowedTools') + 1].includes('Bash(git push:*)'));
    assert.deepEqual(call.env, [], 'no .env value and no project root');
    // Codex can't commit in its sandbox: the hub commits what it left, says so, and the job is done (FR-008)
    assert.equal(p.status('M6-02-ok').state, 'done', r.out);
    assert.equal(p.status('M6-02-ok').engine, 'codex');
    assert.equal(p.status('M6-02-ok').gitByHub, true);
    assert.match(p.git('log', '--format=%s%n%b', 'main..task/M6-02-ok'), /^M6-02-ok: test\n+Committed by the nextlevel hub for the worker \(Codex, attempt 1\): its sandbox can't write git\./);
    assert.match(report(p, 'M6-02-ok'), /Git by the hub: told/, "the worker's prompt says the hub does git for it");
    assert.match(report(p, 'M6-01-ok'), /Git by the hub: not told/, 'Claude Code can write git: nothing to say');
    assert.equal(p.status('M6-02-ok').engineWhy.text, 'the spec\'s "Engine: codex" line');
    assert.equal(p.status('M6-01-ok').engineWhy.text, 'dispatch with --engine claude');
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /started M6-01-ok in slot w\d \(claude opus, attempt 1; in the background\)/);
  } finally {
    p.cleanup();
  }
});

test('a second Codex account: its own folder, signed in with nextlevel login, and the doctor follows it', () => {
  const p = makeProject();
  const folder = path.join(p.env.HOME, '.nextlevel', 'accounts', 'codex', 'two');
  try {
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { profile: 'codex-two', fallback: 'codex' } }, profiles: { 'codex-two': { engine: 'codex', account: 'two' } } }));
    // Not signed in yet: the doctor says so for that account, with the command that does it
    const before = p.hub(['doctor']);
    assert.equal(before.code, 1, before.out);
    assert.match(before.out, /!! +Codex sign-in +account two \(profile codex-two\): (not signed in|Not logged in)/);
    assert.match(before.out, /(PowerShell|Terminal), in .*: {2}nextlevel login codex-two {3}\(it opens the browser/);
    assert.match(before.out, / ok +Second accounts +codex-two: Codex account two, in its own folder .*accounts.codex.two \(CODEX_HOME\)/);
    // nextlevel login makes the folder Codex needs, and signs the account in there
    const login = p.hub(['login', 'codex-two']);
    assert.equal(login.code, 0, login.out);
    assert.match(login.out, /keeps its own Codex folder: .*accounts.codex.two/);
    assert.match(login.out, /codex-two \(codex, account two\): Logged in using ChatGPT \(stub account in two\)/);
    assert.ok(fs.existsSync(path.join(folder, 'auth.json')));
    assert.match(p.hub(['login']).out, /worker: codex-two \(codex, account two\): Logged in using ChatGPT \(stub account in two\)/);
    const after = p.hub(['doctor']);
    assert.match(after.out, / ok +Codex sign-in +its own login: Logged in using ChatGPT; account two \(profile codex-two\): Logged in using ChatGPT \(stub account in two\)/);
    // The worker runs with that folder
    spec(p, 'M6-03-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M6-03-ok']);
    const r = p.runUntilIdle();
    assert.equal(p.status('M6-03-ok').state, 'done', r.out);
    assert.match(report(p, 'M6-03-ok'), new RegExp(`Account folder: ${folder.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  } finally {
    p.cleanup();
  }
});

test("Antigravity can't keep a second account apart: the doctor says so plainly, and nothing starts on it", () => {
  const p = makeProject();
  try {
    p.setConfig((c) => ({ ...c, profiles: { 'agy-two': { engine: 'agy', account: 'two' } } }));
    p.spec('M6-04-ok', fileExists('ok.mjs'));
    const d = p.hub(['dispatch', 'M6-04-ok', '--profile', 'agy-two']);
    assert.notEqual(d.code, 0);
    assert.match(d.out, /profile "agy-two" names account "two", but Antigravity CLI can't keep a second account apart/);
    assert.ok(!fs.existsSync(p.jobFile('M6-04-ok', 'status.json')), 'nothing queued');
    assert.match(p.hub(['login', 'agy-two']).out, /can't keep a second account apart.*Take "account" out of profiles\.agy-two/s);
    // Unused, it isn't in the doctor; once a role uses it, it is an error there
    assert.doesNotMatch(p.hub(['doctor']).out, /Second accounts/);
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { profile: 'agy-two', fallback: 'codex' } } }));
    const doctor = p.hub(['doctor']);
    assert.equal(doctor.code, 1);
    assert.match(doctor.out, /!! +Second accounts +profile "agy-two" names account "two", but Antigravity CLI can't keep a second account apart/);
    assert.match(doctor.out, /Text editor: {2}in nextlevel\.json take "account" out of profiles\.agy-two/);
  } finally {
    p.cleanup();
  }
});

test('Claude Code as the orchestrator: autopilot cycles headless, the interactive one with its rules, a named account without API keys', () => {
  const p = makeProject();
  try {
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { profile: 'claude-work' } }, profiles: { 'claude-work': { engine: 'claude', account: 'work', model: 'opus' } } }));
    assert.match(p.hub(['doctor']).out, /!! +Claude Code sign-in +account work \(profile claude-work\): not signed in/);
    assert.equal(p.hub(['login', 'claude-work']).code, 0);
    assert.match(p.hub(['doctor']).out, / ok +Claude Code sign-in +account work \(profile claude-work\): signed in \(work@example\.com, max\)/);

    p.spec('M6-05-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M6-05-ok']);
    p.runUntilIdle();
    const r = p.runUntilIdle(['--autopilot'], { extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-owners-own-key' } });
    assert.equal(p.status('M6-05-ok').acked, true, r.out);
    assert.match(p.git('log', '-1', '--format=%s'), /orchestrator cycle \(claude\)/, 'its commit went through the hub');
    const cycle = claudeCalls(p).find((c) => c.args.includes('-p') && c.args[1].includes('autopilot cycle'));
    assert.equal(cycle.configDir, path.join(p.env.HOME, '.nextlevel', 'accounts', 'claude', 'work'));
    assert.equal(cycle.apiKey, false, "the owner's API key would win over the account's own sign-in");
    assert.ok(cycle.args.includes('--allowedTools') && cycle.args.includes('opus'));
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /autopilot: orchestrator cycle started \(claude-work \(claude, account work, opus\)/);

    const orch = p.nextlevel(['_orch'], { cwd: p.repo, extraEnv: { NEXTLEVEL_ROOT: p.repo } });
    assert.match(orch.out, /\[fake claude\] interactive session in .*: Read AGENTS\.md first/);
    const interactive = claudeCalls(p).at(-1);
    assert.match(interactive.args[0], /ROLE: ORCHESTRATOR, interactive session/);
    assert.ok(interactive.args.includes('--disallowedTools'));
    assert.ok(!interactive.args.includes('-p'));
    // The setup guide on it: no rules, it asks the owner (on Windows it opens a window of its own, which stays open)
    if (process.platform !== 'win32') {
      const guide = p.hub(['guide', 'claude']);
      assert.equal(guide.code, 0, guide.out);
      assert.match(guide.out, /\[fake claude\] interactive session/);
      assert.deepEqual(claudeCalls(p).at(-1).args, ["Read AGENTS.md first: it has the team's roles and rules. ROLE: GUIDE. Follow docs/agents/GUIDE.md."]);
    }
  } finally {
    p.cleanup();
  }
});

test("fallbacks: a worker's task on the role's fallback, and the orchestrator on its fallback when its own engine isn't ready", () => {
  const p = makeProject();
  try {
    p.spec('M6-06-fail', fileExists('fixed.txt'));
    p.hub(['dispatch', 'M6-06-fail']);
    p.runUntilIdle();
    assert.equal(p.status('M6-06-fail').state, 'failed');
    assert.equal(p.status('M6-06-fail').engine, 'agy');
    assert.match(p.hub(['retry', 'M6-06-fail', '--fallback', '--feedback', 'Create fixed.txt']).out, /attempt 2, codex/);
    p.runUntilIdle();
    assert.equal(p.status('M6-06-fail').engine, 'codex');
    assert.equal(p.status('M6-06-fail').state, 'done');
    assert.match(report(p, 'M6-06-fail'), /Engine: codex/);
    assert.match(p.hub(['dispatch', 'M6-99', '--fallback']).out, /write docs.tasks.M6-99\.md first/);

    // The orchestrator's model is rejected (FR-001 #5) and its fallback is Claude Code: autopilot runs there
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'codex', model: 'gpt-6-sol', fallback: 'claude' } } }));
    const orch = p.hub(['orchestrator']);
    assert.equal(orch.code, 1);
    assert.match(orch.out, /Not starting the orchestrator: "gpt-6-sol" .*rejected[\s\S]*Its fallback, claude, is ready: nextlevel orchestrator --fallback/);
    p.spec('M6-07-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M6-07-ok']);
    p.runUntilIdle();
    const r = p.runUntilIdle(['--autopilot']);
    assert.equal(p.status('M6-07-ok').acked, true, r.out);
    assert.ok(!p.settings().pausedReason, 'not paused: it ran on the fallback');
    assert.equal(p.settings().onFallback, 'claude');
    assert.match(r.out, /\[notify\] NTFY_TOPIC not set, skipped: proj autopilot runs on its fallback/);
    // Home's list of fallbacks and engine switches has both, with why (FR-008)
    const switches = JSON.parse(fs.readFileSync(p.state('switches.json'), 'utf8'));
    assert.deepEqual(switches.map((x) => [x.kind, x.engine, x.how]), [['task', 'codex', 'fallback'], ['round', 'claude', 'auto-fallback']]);
    assert.match(switches[0].why, /^retry with --fallback: the workers' fallback \(roles\.worker\.fallback in nextlevel\.json\)$/);
    assert.equal(switches[1].check, 'codex.model');
    assert.match(switches[1].why, /^automatic fallback: the orchestrator's codex gpt-6-sol can't start \(codex\.model: "gpt-6-sol" .*rejected/);
    assert.match(p.git('log', '-1', '--format=%s'), /orchestrator cycle \(claude\)/);
    // Without a fallback it pauses, as before M6
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'codex', model: 'gpt-6-sol', fallback: '' } } }));
    fs.writeFileSync(p.state('settings.json'), JSON.stringify({ ...p.settings(), lastCycleEnd: 0, onFallback: null }));
    p.spec('M6-08-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M6-08-ok']);
    p.runUntilIdle();
    p.runUntilIdle();
    assert.equal(p.settings().pausedReason, 'the Codex model in nextlevel.json was rejected');
  } finally {
    p.cleanup();
  }
});

test("a task on the worker role goes to the role's fallback when the role's engine can't start, and says which check (FR-008)", () => {
  const p = makeProject();
  try {
    // Antigravity isn't installed on this PC
    for (const f of fs.readdirSync(p.bin).filter((n) => /^agy(\.cmd)?$/.test(n))) fs.rmSync(path.join(p.bin, f));
    spec(p, 'M8-04-ok', fileExists('ok.mjs'), ''); // no Engine line: the worker role's
    p.hub(['dispatch', 'M8-04-ok']);
    const r = p.runUntilIdle();
    const s = p.status('M8-04-ok');
    assert.equal(s.state, 'done', r.out);
    assert.equal(s.engine, 'codex');
    assert.deepEqual([s.engineWhy.how, s.engineWhy.check], ['auto-fallback', 'tool.agy']);
    assert.match(s.engineWhy.text, /^automatic fallback: the workers' agy can't start \(tool\.agy: Antigravity \(agy\) is not installed/);
    assert.match(report(p, 'M8-04-ok'), /Engine: codex/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /M8-04-ok: automatic fallback: .* it runs on the fallback, codex/);
    assert.match(p.hub(['result', 'M8-04-ok']).out, /engine: Codex, automatic fallback: the workers' agy can't start \(tool\.agy/);
    // A retry goes back to the worker role, and falls back again only while agy is missing
    const job = JSON.parse(fs.readFileSync(p.jobFile('M8-04-ok', 'job.json'), 'utf8'));
    assert.deepEqual([job.role, job.fellBack], ['worker', true]);
    const switches = JSON.parse(fs.readFileSync(p.state('switches.json'), 'utf8'));
    assert.deepEqual(switches.map((x) => [x.id, x.engine, x.roleEngine, x.how, x.check]), [['M8-04-ok', 'codex', 'agy', 'auto-fallback', 'tool.agy']]);
  } finally {
    p.cleanup();
  }
});

test('the bridge test runs on any engine: Claude Code workers try to push and git refuses', async () => {
  const p = makeProject();
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  try {
    for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await sleep(200);
    const r = p.hub(['bridge-test', '--engine', 'claude', '--timeout', '2'], { timeout: 150_000 });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Waiting for 2 worker\(s\) on claude/);
    assert.match(r.out, /Bridge works: the orchestrator can hand work to claude workers/);
    assert.doesNotMatch(r.out, /Antigravity CLI 1\.2\.11/);
    const saved = JSON.parse(fs.readFileSync(p.state('bridge-test.json'), 'utf8'));
    assert.equal(saved.engine, 'claude');
    assert.match(saved.engineVersion, /Claude Code/);
  } finally {
    bg.kill();
    await processesGone([bg.pid]);
    p.cleanup();
  }
});

test(
  'on Windows an autopilot cycle on Antigravity runs in a console with no window, its log and tokens read from its output (FR-010)',
  { skip: process.platform !== 'win32' && 'agy needs a real console on Windows only' },
  () => {
    const p = makeProject();
    try {
      p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'agy', model: '' } } }));
      p.spec('M6-09-ok', fileExists('ok.mjs'));
      p.hub(['dispatch', 'M6-09-ok']);
      p.runUntilIdle();
      const r = p.runUntilIdle(['--autopilot'], { extraEnv: { NEXTLEVEL_WORKER_WINDOW: undefined }, timeout: 240_000 });
      const hubLog = fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
      if (consoleWorksHere()) assert.match(hubLog, /orchestrator cycle started \(agy, in a console with no window; 1 to review, 0 active\) -> \.nextlevel[\\/]logs[\\/]orchestrator-/, r.out);
      // A PC where the worker before found no console to give agy: the round opens a window of its own and says why
      else assert.match(hubLog, /orchestrator cycle started \(agy, in a window of its own: the console with no window didn't start on this PC \(its process found no console to give the engine \(exit 3\)\); 1 to review, 0 active\) -> \.nextlevel[\\/]logs[\\/]orchestrator-/, r.out);
      assert.equal(p.status('M6-09-ok').acked, true, r.out);
      assert.match(p.git('log', '-1', '--format=%s'), /orchestrator cycle \(agy\)/);
      const cycle = JSON.parse(fs.readFileSync(p.state('cycle.json'), 'utf8'));
      assert.equal(cycle.exitCode, 0);
      assert.match(fs.readFileSync(path.join(p.repo, cycle.log), 'utf8'), /"event":"result"/, 'its output is the round\'s log');
      const usage = Object.values(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8')))[0];
      assert.equal(usage.by['autopilot:agy'].tokens, 2150, "the round's tokens, from its stream-json");
    } finally {
      p.cleanup();
    }
  },
);

test(
  "an autopilot round whose process has no console to give agy ends at once, the PC remembers it, and the next round opens a window of its own (FR-010, FR-013)",
  // Its second round opens a real window, which takes the focus: CI only
  { skip: (process.platform !== 'win32' && 'agy needs a real console on Windows only') || (!process.env.CI && 'opens windows that take the focus: CI only') },
  () => {
    const p = makeProject();
    try {
      p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'agy', model: '' } } }));
      p.spec('M6-10-ok', fileExists('ok.mjs'));
      // (the orchestrator on agy starts only with a passing lock test, run here while the console with no window works)
      const lock = p.hub(['lock-test', '--engine', 'agy', '--role', 'orchestrator'], { timeout: 600_000 });
      assert.equal(lock.code, 0, lock.out);
      p.hub(['dispatch', 'M6-10-ok', '--engine', 'codex']); // a worker that needs no console: the round is the first to try one
      p.runUntilIdle();
      // A PC whose console with no window has no input to give (NEXTLEVEL_CONIN names a file that isn't there)
      const opts = { extraEnv: { NEXTLEVEL_WORKER_WINDOW: undefined, NEXTLEVEL_CONIN: path.join(p.repo, 'no-console-here') }, timeout: 240_000 };
      const first = p.runUntilIdle(['--autopilot'], opts);
      let hubLog = fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
      assert.match(hubLog, /orchestrator cycle started \(agy, in a console with no window; 1 to review, 0 active\)[\s\S]*autopilot: the console with no window didn't start \(the round's process found no console to give Antigravity \(exit 3\)\); the next round opens a window of its own/, first.out);
      assert.match(hubLog, /autopilot: the round didn't start, so the next one may start at once/);
      // The next round, at once in the same run (what started the first waits again, FR-019: the hub doesn't stop while a
      // round can start), opens a window of its own and says why
      assert.match(hubLog, /the round didn't start, so the next one may start at once[\s\S]*autopilot: a round starts because task M6-10-ok ended \(done, attempt 1\)\n[^\n]*orchestrator cycle started \(agy, in a window of its own: the console with no window didn't start on this PC \(the round's process found no console to give Antigravity \(exit 3\)\); 1 to review, 0 active\)/, first.out);
      assert.equal(p.status('M6-10-ok').acked, true, 'the round in a window reviewed it');
      assert.equal((hubLog.match(/autopilot: a round starts because/g) || []).length, 2);
      // The first, whose engine never started, counted for the hour only, and the second (its engine started) set the count of
      // such rounds back to none: the brake counts the second alone, and what failed is kept for Home
      const st = JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8'));
      assert.deepEqual([st.starts.length, st.sinceReal, st.notStarted, st.last.how, st.fuse], [2, 1, 0, 'ok', null]);
      assert.equal(st.failed.why, "the round's process found no console to give Antigravity (exit 3)");
      assert.equal(JSON.parse(fs.readFileSync(p.state('cycle.json'), 'utf8')).launched, true);
      // A round that never ran counted for nothing: once the one in a window has run, nothing waits for another
      const second = p.runUntilIdle(['--autopilot'], opts);
      hubLog = fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
      assert.equal((hubLog.match(/autopilot: a round starts because/g) || []).length, 2, second.out);
    } finally {
      p.cleanup();
    }
  },
);
