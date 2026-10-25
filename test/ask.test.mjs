// The assistant (Ask, src/ask.mjs): a read-only side chat about the project, apart from the orchestrator. End to end
// with the stub engines (they record what they were given in ~/.fake-<engine>/assistant.jsonl), and its pieces.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { answerOf, noteOf, sourcesOf } from '../src/ask.mjs';
import { ADAPTERS, ADDON_KINDS, workerIsolation } from '../src/engines/index.mjs';
import { chatStore } from '../src/lib/chats.mjs';
import { assistantAuto, defaults, loadConfig, roleProfile } from '../src/lib/config.mjs';
import { readOnlyRefusal } from '../src/lib/readonly.mjs';
import { fileExists, makeProject } from './helpers.mjs';

// A value planted in the project's .env: it must never reach the assistant, its answers or its threads
const PLANTED = 'planted-ask-value-5150';
const askJson = (p, args, opts) => {
  const r = p.hub(['ask', '--json', ...args], opts);
  try {
    return { ...JSON.parse(r.out), code: r.code };
  } catch {
    throw new Error(`no JSON from nextlevel ask ${args.join(' ')}:\n${r.out}`);
  }
};
// What the stub engine was given, one entry per question
const sessions = (p, engine) => {
  const f = path.join(p.env.HOME, `.fake-${engine}`, 'assistant.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

test('nextlevel ask: a fresh read-only session on a light model, never the orchestrator; its briefing and answer are redacted', () => {
  const p = makeProject();
  try {
    fs.writeFileSync(path.join(p.repo, '.env'), `NTFY_TOPIC=\nPLANTED_VALUE=${PLANTED}\n`);
    fs.writeFileSync(path.join(p.repo, 'docs', 'PROJECT.md'), '# Project\n\nA shop for second-hand bikes.\n');
    fs.appendFileSync(path.join(p.repo, 'docs', 'STATUS.md'), `\nThe mail login is ${PLANTED} (planted: never shown).\n`);
    p.git('add', '-A');
    p.git('commit', '-qm', 'docs: the project in a line');
    assert.equal(p.hub(['handoff', 'add', 'Set the SMTP login', '--where', '.env', '--why', 'mail']).code, 0);
    assert.equal(p.hub(['note', 'add', 'Keep the public API stable', '--rule']).code, 0);
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-01-ok']);
    p.runUntilIdle();

    const r = askJson(p, ['What is blocked?']);
    assert.equal(r.ok, true, r.message);
    // Automatic: Codex (a role uses it, Claude Code none) with its smallest listed model, at low effort
    assert.deepEqual([r.answer.engine, r.answer.model, r.answer.effort], ['codex', 'gpt-6-mini', 'low']);
    assert.deepEqual(r.answer.sources, ['docs/STATUS.md', '.nextlevel/jobs/M1-01-ok/RESULT.md', 'commit abc1234']);
    assert.deepEqual(r.answer.note, { type: 'once', text: 'Finish M0 before you start M1.' });
    assert.ok(r.answer.tokens?.tokens > 0, 'its tokens');

    // Read-only by construction: Codex's read-only sandbox, whatever engines.codex.args say, the question on stdin
    const s = sessions(p, 'codex').at(-1);
    // (and without the owner's add-ons, as a worker that keeps none: this PC's Codex has no MCP servers or skills)
    assert.deepEqual(s.args, ['exec', '-m', 'gpt-6-mini', '-c', 'model_reasoning_effort=low', '--sandbox', 'read-only', '--disable', 'plugins', '--disable', 'hooks', '--disable', 'apps', '--json', '-']);
    assert.equal(s.readOnly, '1', 'nextlevel runs read-only in its session');
    assert.equal(s.optionalLocks, '0', "its git takes no optional lock: a `git status` of its never holds index.lock while the hub commits");
    assert.equal(s.planted, false, 'no .env value in its environment');
    assert.equal(fs.realpathSync.native(s.cwd).toLowerCase(), fs.realpathSync.native(p.repo).toLowerCase(), 'it looks at the project');
    // ... and a nextlevel command that changes something is refused in it (a planted instruction couldn't commit)
    assert.notEqual(s.commit.code, 0);
    assert.match(s.commit.out, /refused\. This is a read-only session \(the assistant\)/);
    assert.deepEqual(fs.readdirSync(p.state('jobs')), ['M1-01-ok'], 'nothing was queued');

    // The briefing: the project, the status file, what the team needs, the notes, the hub, the day's jobs, commits
    const b = s.prompt;
    assert.match(b, /^ROLE: ASSISTANT\./);
    assert.match(b, /A shop for second-hand bikes/);
    assert.match(b, /## Status \(docs\/STATUS\.md\)[\s\S]*M0 Foundation/);
    assert.match(b, /- H\d+: Set the SMTP login \(where: \.env\) \(why: mail\)/);
    assert.match(b, /- N\d+ \(standing rule\): Keep the public API stable/);
    assert.match(b, /"milestones": "0\/2"/);
    assert.match(b, /- M1-01-ok · task\/code · done · agy \(why: the spec's "Engine: agy" line\) · worker says DONE · verify pass/);
    assert.match(b, /docs: the project in a line/);
    assert.match(b, /## The owner's question\nWhat is blocked\?/);
    assert.ok(!b.includes(PLANTED), 'the .env value is redacted from the briefing');
    assert.match(b, /The mail login is \*\*\*/);

    // Stored: the thread with both messages, nothing planted; the orchestrator untouched
    const thread = JSON.parse(fs.readFileSync(p.state('chats', `${r.thread.id}.json`), 'utf8'));
    assert.deepEqual(thread.messages.map((m) => m.role), ['owner', 'assistant']);
    assert.equal(thread.title, 'What is blocked?');
    assert.ok(!JSON.stringify(thread).includes(PLANTED));
    assert.ok(!fs.existsSync(p.state('orchestrator.json')), 'no orchestrator session');
    assert.ok(!fs.existsSync(p.state('settings.json')) || p.settings().cycles === undefined, 'no autopilot round');
    // Today: the assistant as its own row
    const day = Object.values(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8'))).at(-1);
    assert.deepEqual([day.by['assistant:codex'].runs, day.by['assistant:codex'].reported], [1, 1]);

    // A follow-up: a fresh session again, with the thread so far
    const follow = askJson(p, ['--thread', r.thread.id, 'And why is that?']);
    assert.equal(follow.thread.id, r.thread.id);
    const second = sessions(p, 'codex').at(-1).prompt;
    assert.match(second, /## This conversation so far\nOwner: What is blocked\?\n\nYou: \[fake codex\] You asked: What is blocked\?/);
    assert.equal(JSON.parse(fs.readFileSync(p.state('chats', `${r.thread.id}.json`), 'utf8')).messages.length, 4);
    // Plain text for PowerShell, with how to follow up
    const text = p.hub(['ask', 'One more?']).out;
    assert.match(text, /\[fake codex\] You asked: One more\?[\s\S]*\(Assistant: Codex gpt-6-mini, [\d,]+ tokens · thread [a-z0-9]+: nextlevel ask --thread [a-z0-9]+ "a follow-up"\)/);
  } finally {
    p.cleanup();
  }
});

test("Ask on Codex starts without the owner's MCP servers, plugins, hooks and apps, as a worker that keeps none: a server workers.addons keeps for workers stays off for Ask", () => {
  const p = makeProject();
  try {
    // The owner's Codex: two servers that could write a live site (one whose name Codex can't switch off), a disabled one
    const codexDir = path.join(p.env.HOME, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      ['[mcp_servers.novamira-site]', 'command = "npx"', '', '[mcp_servers.shop-admin]', 'url = "https://example.com/mcp"', '', '[mcp_servers."wp.shop"]', 'command = "npx"', '', '[mcp_servers.old]', 'command = "npx"', 'enabled = false', ''].join('\n'),
    );
    p.setConfig((c) => ({ ...c, workers: { ...c.workers, addons: { mcpServers: ['novamira-site'], skills: false, hooks: false } } }));
    const r = askJson(p, ['What is blocked?']);
    assert.equal(r.ok, true, r.message);
    assert.equal(r.answer.engine, 'codex');
    const args = sessions(p, 'codex').at(-1).args;
    const off = (name) => args.some((a, i) => a === `mcp_servers.${name}.enabled=false` && args[i - 1] === '-c');
    assert.ok(off('novamira-site'), `kept for workers, still off for Ask: ${args.join(' ')}`);
    assert.ok(off('shop-admin'), args.join(' '));
    assert.ok(!args.some((a) => a.includes('wp.shop') || a.includes('mcp_servers.old')), 'a name Codex takes no switch for, and a disabled server, get none');
    for (const what of ['plugins', 'hooks', 'apps']) assert.ok(args.some((a, i) => a === what && args[i - 1] === '--disable'), what);
    assert.deepEqual(args.slice(-2), ['--json', '-'], 'the question still comes on stdin');
    assert.equal(args[args.indexOf('--sandbox') + 1], 'read-only');
    // The doctor's row for a name Codex can't switch off says Ask gets it too
    const iso = workerIsolation({ engine: 'codex' }, ADDON_KINDS, { home: p.env.HOME, env: {}, path, read: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null), list: () => [] });
    assert.match(iso.left.find((l) => l.what === 'mcp-name').text, /"wp\.shop" .*so Codex workers and the assistant \(Ask\) on Codex still get it/);
  } finally {
    p.cleanup();
  }
});

test('threads: start, list, search, show, rename, clear and delete', () => {
  const p = makeProject();
  try {
    const a = askJson(p, ['Which tasks failed today?']);
    const b = askJson(p, ['What does the brief say about payments?']);
    const list = askJson(p, ['threads']).threads;
    assert.deepEqual(list.map((t) => t.id), [b.thread.id, a.thread.id], 'newest first');
    assert.deepEqual(askJson(p, ['threads', '--search', 'PAYMENTS']).threads.map((t) => t.id), [b.thread.id], 'any case');
    assert.match(askJson(p, ['threads', '--search', 'payments']).threads[0].match, /payments/);
    assert.equal(askJson(p, ['rename', a.thread.id, 'Failures']).thread.title, 'Failures');
    assert.equal(askJson(p, ['show', a.thread.id]).thread.messages.length, 2);
    assert.deepEqual(askJson(p, ['clear', a.thread.id]).thread.messages, []);
    assert.equal(askJson(p, ['delete', b.thread.id]).deleted, b.thread.id);
    assert.deepEqual(askJson(p, ['threads']).threads.map((t) => t.title), ['Failures']);
    const started = askJson(p, ['new', 'Plans']);
    assert.match(started.thread.id, /^[a-z0-9]{16}$/);
    // Ids are nextlevel's own: nothing else picks a path
    assert.match(askJson(p, ['show', '..\\..\\x']).message, /which thread\?/);
    assert.match(askJson(p, ['--thread', 'nope1234', 'hello']).message, /no thread "nope1234"/);
    assert.match(askJson(p, ['x'.repeat(4001)]).message, /at most 4000 characters/);
  } finally {
    p.cleanup();
  }
});

test('on Claude Code: plan mode, the read tools and look-only commands allowed, writes and .env denied, the question on stdin', () => {
  const p = makeProject();
  try {
    // Automatic, with a role on Claude Code: Claude Code's haiku
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { engine: 'claude', model: '', fallback: 'codex' } } }));
    const r = askJson(p, ['Where are we?']);
    assert.equal(r.ok, true, r.message);
    assert.deepEqual([r.answer.engine, r.answer.model], ['claude', 'haiku']);
    assert.deepEqual(r.answer.tokens, { tokens: 920, cached: 5000, input: 800, cacheWrite: 0, output: 120 });
    const s = sessions(p, 'claude').at(-1);
    const arg = (flag) => s.args[s.args.indexOf(flag) + 1];
    assert.equal(s.args[0], '-p');
    assert.equal(arg('--permission-mode'), 'plan');
    assert.equal(arg('--model'), 'haiku');
    assert.ok(arg('--allowedTools').split(',').includes('Bash(nextlevel status:*)') && arg('--allowedTools').split(',').includes('Read'));
    assert.ok(!arg('--allowedTools').includes('nextlevel commit'));
    // Git's flags that write a file, read outside the repository or run a program, and any command naming .env
    for (const denied of ['Edit', 'Write', 'Read(./.env)', 'Bash(git *--output*)', 'Bash(git *--no-index*)', 'Bash(*.env*)']) assert.ok(arg('--disallowedTools').split(',').includes(denied), denied);
    // No MCP servers, and the repository's own .claude settings (allow rules, hooks) don't apply
    assert.ok(s.args.includes('--strict-mcp-config'));
    assert.equal(arg('--setting-sources'), 'user');
    assert.ok(!s.args.some((x) => x.includes('Where are we')), 'the question came on stdin, not in its arguments');
    assert.match(s.prompt, /## The owner's question\nWhere are we\?/);
    // Chosen in nextlevel.json instead
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { engine: 'agy', model: '', fallback: 'codex' }, assistant: { engine: 'claude', model: 'sonnet', effort: 'low', profile: '' } } }));
    assert.deepEqual([askJson(p, ['Again?']).answer.model, sessions(p, 'claude').at(-1).args.includes('sonnet')], ['sonnet', true]);
  } finally {
    p.cleanup();
  }
});

test("Antigravity as the assistant (the Argon roles, part B): nextlevel.json allows it, its automatic choice stays Claude Code and Codex, team set refuses it until its lock test passes, and the Team page offers it", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-ask-'));
  try {
    // (a verdict never makes nextlevel.json invalid: the hold is where a question starts)
    assert.equal(loadConfig(root, { raw: { roles: { assistant: { engine: 'agy' } } }, env: {} }).config.roles.assistant.engine, 'agy');
    assert.equal(loadConfig(root, { raw: { roles: { assistant: { profile: 'spare' } }, profiles: { spare: { engine: 'agy' } } }, env: {} }).config.roles.assistant.profile, 'spare');
    assert.equal(ADAPTERS.agy.readOnly, null, 'no read-only mode of its own: it answers in a copy');
    // the automatic choice never picks it, even with every role on agy
    const auto = roleProfile(loadConfig(root, { raw: { roles: { orchestrator: { engine: 'agy' }, worker: { engine: 'agy', fallback: '' } } }, env: {} }).config, 'assistant');
    assert.notEqual(auto.engine, 'agy');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  const p = makeProject();
  try {
    const env = { STUB_AGY_VERSION: '1.4.0', STUB_AGY_MODELS: 'gemini-4-argon-low\tGemini 4 Argon (Low)' };
    const refused = JSON.parse(p.hub(['team', 'set', 'assistant', '--engine', 'agy', '--model', 'gemini-4-argon-low', '--json'], { extraEnv: env }).out);
    assert.equal(refused.saved, false);
    assert.match(refused.message, /^Not saved: Roles on Antigravity: lock test: the assistant \(gemini-4-argon-low\): it hasn't had its lock test yet, so it doesn't answer on Antigravity/);
    assert.ok(refused.results.find((r) => r.id === 'lock.test').steps.some((s) => s.command === 'nextlevel lock-test --engine agy --role assistant --model gemini-4-argon-low'));
    const saved = JSON.parse(p.hub(['team', 'set', 'assistant', '--engine', 'codex', '--model', 'gpt-6-mini', '--json']).out);
    assert.equal(saved.saved, true, saved.message);
    assert.match(saved.message, /applies to the next question you ask/);
    assert.deepEqual(p.config().roles.assistant, { engine: 'codex', model: 'gpt-6-mini', effort: '', profile: '' });
    assert.equal(JSON.parse(p.hub(['team', 'set', 'assistant', '--engine', 'auto', '--json']).out).saved, true);
    assert.equal(p.config().roles.assistant.engine, '');
    // The Team page's row, and Antigravity offered for it
    const row = JSON.parse(p.hub(['team', '--json']).out).rows.find((x) => x.key === 'assistant');
    assert.deepEqual([row.auto, row.engine, row.model.text], [true, 'codex', 'the smallest model Codex lists (picked when it runs) (automatic)']);
    const agy = JSON.parse(p.hub(['team', '--json']).out).engines.find((e) => e.name === 'agy');
    assert.deepEqual([agy.assistant, agy.notAssistant], [true, '']);
    assert.match(agy.notes.assistant, /a copy of your project made for each question and thrown away after/);
  } finally {
    p.cleanup();
  }
});

test('a read-only session: nextlevel refuses what changes things; result --peek only looks', () => {
  const p = makeProject();
  try {
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M1-01-ok']);
    p.runUntilIdle();
    const ro = { extraEnv: { NEXTLEVEL_READ_ONLY: '1' } };
    for (const args of [['commit', '-m', 'x'], ['dispatch', 'M1-02'], ['note', 'add', 'hi'], ['doctor'], ['doctor', '--fix', '--json'], ['team', 'set', 'worker', '--engine', 'codex'], ['ask', 'hi'], ['update'], ['run'], ['push']]) {
      const r = p.hub(args, ro);
      assert.equal(r.code, 1, args.join(' '));
      assert.match(r.out, /refused\. This is a read-only session/, args.join(' '));
    }
    assert.equal(p.hub(['status'], ro).code, 0);
    assert.equal(p.hub(['team'], ro).code, 0);
    assert.equal(JSON.parse(p.hub(['doctor', '--json'], ro).out).results.length > 10, true);
    // A job's result marks it reviewed, except with --peek or in a read-only session
    assert.equal(p.status('M1-01-ok').acked, false);
    assert.match(p.hub(['result', 'M1-01-ok'], ro).out, /## Worker report/);
    assert.equal(p.status('M1-01-ok').acked, false);
    p.hub(['result', 'M1-01-ok', '--peek']);
    assert.equal(p.status('M1-01-ok').acked, false);
    p.hub(['result', 'M1-01-ok']);
    assert.equal(p.status('M1-01-ok').acked, true);
  } finally {
    p.cleanup();
  }
  assert.equal(readOnlyRefusal('status', ['--json']), '');
  assert.equal(readOnlyRefusal('team', ['models', 'codex']), '');
  assert.match(readOnlyRefusal(undefined, []), /nextlevel \(the menu\): refused/);
});

test('the pieces: the answer, its sources and suggested note, the automatic engine, the thread store', () => {
  const codex = ['{"type":"thread.started"}', '{"type":"item.completed","item":{"type":"agent_message","text":"Thinking"}}', '{"type":"item.completed","item":{"type":"agent_message","text":"It is blocked on SMTP.\\nSources: docs/HANDOFF.md"}}', '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}'].join('\n');
  assert.deepEqual(answerOf('codex', codex), { text: 'It is blocked on SMTP.\nSources: docs/HANDOFF.md', error: '' });
  assert.equal(answerOf('codex', '{"type":"turn.failed","error":{"message":"stream disconnected"}}').error, 'stream disconnected');
  assert.deepEqual(answerOf('claude', '{"type":"result","is_error":false,"result":"Fine."}'), { text: 'Fine.', error: '' });
  assert.deepEqual(answerOf('claude', 'plain words\n'), { text: 'plain words', error: '' });
  assert.deepEqual(sourcesOf('x\n**Sources:** `src/a.js`, job M1-02; commit 1a2b3c4 and docs/STATUS.md'), ['src/a.js', 'job M1-02', 'commit 1a2b3c4', 'docs/STATUS.md']);
  assert.deepEqual(sourcesOf('no sources here'), []);
  assert.deepEqual(noteOf('Answer.\nRule: Always run the tests before a merge.'), { type: 'rule', text: 'Always run the tests before a merge.' });
  assert.deepEqual(noteOf('- **Note:** Retry M1-02 with the fallback.'), { type: 'once', text: 'Retry M1-02 with the fallback.' });
  assert.equal(noteOf('Nothing to do.'), null);
  // Automatic: the first engine a role uses that can be run read-only
  assert.deepEqual(assistantAuto(defaults('p')), { name: '', engine: 'codex', account: '', model: '', effort: 'low', auto: true });
  const withClaude = defaults('p');
  withClaude.roles.orchestrator.fallback = 'claude';
  assert.equal(assistantAuto(withClaude).engine, 'claude');
  assert.equal(assistantAuto(withClaude).model, 'haiku');
  // The store: its own ids, capped texts
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-chats-'));
  try {
    const store = chatStore(dir);
    const t = store.create('x'.repeat(500));
    assert.equal(t.title.length, 120);
    const long = store.append(t.id, { role: 'assistant', text: 'y'.repeat(100_000) });
    assert.equal(long.messages[0].text.length, 64 * 1024);
    assert.throws(() => store.rename('../evil', 'x'), /no thread/);
    assert.equal(store.get('../evil'), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
