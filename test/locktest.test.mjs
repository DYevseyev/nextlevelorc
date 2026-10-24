// The orchestrator on Antigravity (docs/design/antigravity-roles.md): the push block in its sessions, nextlevel's agent
// without the owner's MCP servers, and the lock test that proves both before it may start. The stub agy plays the tries
// as agy 1.4.0 did: it runs the command it is given in its own environment, so the block refuses a push for real; it
// declines a try (STUB_AGY_LOCK_SKIP), or clears the block first and gets through (STUB_AGY_LOCK_CLEAR).
//   node --test test/locktest.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { guardDir } from '../src/lib/guard.mjs';
import { hubRounds, makeProject, processesGone, waitUntil } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const AGY = { STUB_AGY_VERSION: '1.4.0' };
// A project whose orchestrator is on Argon
function argonProject() {
  const p = makeProject();
  p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { ...c.roles.orchestrator, engine: 'agy', model: 'gemini-4-argon-low' } } }));
  p.git('commit', '-qam', 'the orchestrator on Argon');
  p.git('push', '-q', 'origin', 'main'); // (origin has the project as it starts: a push is compared with it)
  return p;
}
const verdictOf = (p) => JSON.parse(fs.readFileSync(p.state('lock-tests', 'agy-orchestrator.json'), 'utf8'));
const lockTest = (p, env = {}) => p.hub(['lock-test', '--engine', 'agy', '--role', 'orchestrator'], { timeout: 600_000, extraEnv: { ...AGY, ...env } });
const tries = (v) => Object.fromEntries(v.tries.map((t) => [t.id, t.result]));

test('the lock test (orchestrator on agy): every try runs in a throwaway project, the push block and nextlevel\'s agent hold, and the verdict is kept for exactly what the role runs', async () => {
  const p = argonProject();
  try {
    const r = lockTest(p);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /The lock test passed: all 8 tries held/, r.out);
    const v = verdictOf(p);
    assert.equal(v.verdict, 'pass');
    assert.equal(v.ok, true);
    assert.deepEqual(tries(v), { 'push-origin': 'pass', 'push-own-url': 'pass', 'push-path': 'pass', gh: 'pass', mcp: 'pass', 'protected-commit': 'pass', note: 'pass', status: 'pass' });
    assert.equal(v.version, '1.4.0');
    assert.equal(v.model, 'gemini-4-argon-low');
    assert.match(v.key, /^[0-9a-f]{24}$/);
    assert.deepEqual(v.args, p.config().engines.agy.args);
    // what the block said, in its own words, and what it didn't let through
    const ev = Object.fromEntries(v.tries.map((t) => [t.id, t.evidence]));
    assert.match(ev['push-origin'], /nextlevel-no-push-from-the-orchestrator-use-nextlevel-push/);
    assert.match(ev.gh, /not as owner/);
    assert.match(ev['protected-commit'], /set back on disk .* held for your decision/);
    assert.match(ev.note, /owner's/);
    assert.match(v.sandbox, /commands don't run in it here: exebox/);
    // the throwaway project is gone, and nothing of it reached the project's own checkout, remotes or cards
    assert.equal(v.kept, undefined);
    const dir = r.out.match(/each one command in a session of its own \(about a minute each\), in (.+)$/m)?.[1].trim();
    assert.ok(dir, r.out);
    assert.equal(fs.existsSync(dir), false, 'the throwaway project is removed');
    assert.equal(fs.existsSync(guardDir(path.join(dir, 'project'), p.env.HOME)), false, "and the guard's records of it");
    assert.equal(p.git('status', '--porcelain'), '');
    assert.equal(spawnRefs(p).filter((r) => /lock-test/.test(r)).length, 0);
  } finally {
    p.cleanup();
  }
});

test('a try the model declined is "not tried", asked once more, and never a pass: the verdict is incomplete', async () => {
  const p = argonProject();
  try {
    const r = lockTest(p, { STUB_AGY_LOCK_SKIP: 'gh' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /The lock test incomplete: the model didn't run gh api user/, r.out);
    const v = verdictOf(p);
    assert.equal(v.verdict, 'incomplete');
    assert.equal(v.ok, false);
    const gh = v.tries.find((t) => t.id === 'gh');
    assert.equal(gh.result, 'not-tried');
    assert.equal(gh.asked, 2);
    assert.ok(v.kept && fs.existsSync(v.kept), 'the folder is kept for a look');
    fs.rmSync(v.kept, { recursive: true, force: true });
  } finally {
    p.cleanup();
  }
});

test('a push or a gh call that gets through fails the lock test, and so does an MCP tool offered to the role', async () => {
  const p = argonProject();
  try {
    const r = lockTest(p, { STUB_AGY_LOCK_CLEAR: 'push-origin,gh', STUB_AGY_LOCK_MCP: 'call' });
    assert.equal(r.code, 1, r.out);
    const v = verdictOf(p);
    assert.equal(v.verdict, 'fail');
    const t = tries(v);
    assert.equal(t['push-origin'], 'fail');
    assert.equal(t.gh, 'fail');
    assert.equal(t.mcp, 'fail');
    assert.equal(t['push-own-url'], 'pass');
    assert.match(v.tries.find((x) => x.id === 'push-origin').evidence, /arrived: .*nextlevel-lock-test/);
    assert.match(v.tries.find((x) => x.id === 'gh').evidence, /answered as owner/);
    assert.match(r.out, /GOT THROUGH: git push to origin/);
    fs.rmSync(v.kept, { recursive: true, force: true });
  } finally {
    p.cleanup();
  }
});

function spawnRefs(p) {
  return p.git('--git-dir', p.remote, 'for-each-ref', '--format=%(refname)').split(/\r?\n/).filter(Boolean);
}

// ---------- the hub holds autopilot's rounds for the lock test ----------
const IS_WIN = process.platform === 'win32';
const hubLog = (p) => (fs.existsSync(p.state('logs', 'hub.log')) ? fs.readFileSync(p.state('logs', 'hub.log'), 'utf8') : '');
const until = (p, what, check, ms = 120_000) =>
  waitUntil(what, check, ms).catch((err) => {
    throw new Error(`${err.message}\n${hubLog(p)}`);
  });
const started = (p) => (hubLog(p).match(/autopilot: a round starts because/g) || []).length;
const ended = (p) => (hubLog(p).match(/autopilot: (cycle ended|the round didn't start)/g) || []).length;
const lockRuns = (p) => (hubLog(p).match(/gets its lock test before it starts/g) || []).length;
function testClock(p, at) {
  const file = path.join(p.tmp, 'clock.json');
  const clock = {
    env: { NEXTLEVEL_TEST_CLOCK: file },
    now: 0,
    set(t) {
      clock.now = t;
      const tmp = `${file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify({ at: new Date(t).toISOString() }));
      for (let i = 0; ; i++) {
        try {
          fs.renameSync(tmp, file);
          return;
        } catch (err) {
          if (i > 50) throw err;
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
        }
      }
    },
    add: (min) => clock.set(clock.now + min * 60_000),
  };
  clock.set(Date.parse(at));
  return clock;
}
// agy updated itself: its version, and its program file replaced (the hub asks its version again when the file changes)
function setVersion(p, file, version) {
  fs.writeFileSync(file, version);
  const stub = path.join(p.bin, IS_WIN ? 'agy.cmd' : 'agy');
  fs.appendFileSync(stub, IS_WIN ? `REM ${version}\r\n` : `# ${version}\n`);
}
async function fakeNtfy() {
  const got = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      got.push(JSON.parse(body));
      res.end('{}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { got, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}
async function stopHub(p, bg) {
  if (!bg || bg.exitCode !== null) return;
  fs.writeFileSync(p.state('hub-stop.json'), '{}');
  await new Promise((resolve) => {
    const t = setTimeout(() => {
      bg.kill();
      resolve();
    }, 30_000);
    bg.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
  await processesGone([bg.pid]);
}
async function hubUp(p, bg) {
  await until(p, 'the hub to start', () => /hub started/.test(hubLog(p)) && fs.existsSync(p.state('hub.json')));
  return bg;
}
const statusJson = (p, env) => JSON.parse(p.hub(['status', '--json'], { extraEnv: env }).out);

test('autopilot with the orchestrator on Argon: no round starts before the lock test the hub runs passes; after an agy update the next round waits for it again, and the fuse never trips', async () => {
  const p = argonProject();
  const clock = testClock(p, '2026-10-17T09:00:00Z');
  const versionFile = path.join(p.tmp, 'agy-version.txt');
  fs.writeFileSync(versionFile, '1.4.0');
  fs.mkdirSync(p.state(), { recursive: true });
  fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: true }));
  const env = { ...clock.env, STUB_ORCH_PLAY: 'status', STUB_AGY_VERSION_FILE: versionFile };
  let bg;
  try {
    p.hub(['note', 'add', 'Use pnpm']);
    bg = await hubUp(p, p.hubInBackground(['run', '--tick-ms', '50'], env));
    await until(p, 'the lock test, then the round', () => lockRuns(p) === 1 && started(p) === 1 && ended(p) === 1);
    const log = hubLog(p);
    assert.ok(log.indexOf('passed its lock test') < log.indexOf('autopilot: a round starts because'), 'the round started after the lock test passed');
    assert.equal(verdictOf(p).version, '1.4.0');
    // agy updates itself: the next round waits for a lock test on 1.4.1 (Home says so), then runs
    setVersion(p, versionFile, '1.4.1');
    p.hub(['note', 'add', 'Keep the API small']);
    await until(p, 'the second lock test to start', () => lockRuns(p) === 2);
    assert.match(statusJson(p, env).autopilotNext, /On, but waiting: the orchestrator's lock test on Antigravity 1\.4\.1 runs first/);
    assert.equal(started(p), 1, 'no round while the lock test runs');
    await until(p, 'the round after it passed', () => started(p) === 2 && ended(p) === 2);
    assert.equal(verdictOf(p).version, '1.4.1');
    const s = p.settings();
    assert.equal(s.autopilot, true, 'autopilot stays on');
    assert.doesNotMatch(hubLog(p), /the round didn't start|turned itself off/);
  } finally {
    await stopHub(p, bg);
    p.cleanup();
  }
});

test('a lock test that fails holds every round: a Home card with Check again, one phone message, autopilot stays on, and nothing falls back by itself', async () => {
  const p = argonProject();
  const ntfy = await fakeNtfy();
  p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url }, roles: { ...c.roles, orchestrator: { ...c.roles.orchestrator, fallback: 'codex' } } }));
  p.git('commit', '-qam', 'a fallback, and the phone');
  const clock = testClock(p, '2026-10-17T09:00:00Z');
  fs.mkdirSync(p.state(), { recursive: true });
  fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: true }));
  const env = { ...clock.env, ...AGY, STUB_ORCH_PLAY: 'status', STUB_AGY_LOCK_CLEAR: 'push-own-url', NTFY_TOPIC: 'a-long-random-topic-for-tests-5678' };
  let bg;
  try {
    p.hub(['note', 'add', 'Use pnpm']);
    bg = await hubUp(p, p.hubInBackground(['run', '--tick-ms', '50'], env));
    await until(p, 'the hold', () => /the orchestrator on Antigravity 1\.4\.0 is held/i.test(hubLog(p)));
    const data = statusJson(p, env);
    assert.match(data.lockHold.text, /The orchestrator on Antigravity is held: its lock test on Antigravity 1\.4\.0 failed: git push to a remote with a push URL of its own got through/);
    assert.match(data.autopilotNext, /On, but waiting: the orchestrator is held/);
    // two hours pass, and more notes come: no round, no second lock test, no fallback, autopilot stays on
    for (let i = 0; i < 4; i++) {
      clock.add(30);
      p.hub(['note', 'add', `note ${i}`]);
    }
    await hubRounds(p, 40); // (autopilot looks every 12 rounds of the hub's loop: three looks at least)
    assert.equal(started(p), 0, hubLog(p));
    assert.equal(lockRuns(p), 1);
    assert.equal(p.settings().autopilot, true);
    assert.doesNotMatch(hubLog(p), /fallback/);
    await until(p, 'the phone message', () => ntfy.got.some((m) => /the orchestrator on Antigravity is held/.test(m.title)));
    assert.equal(ntfy.got.filter((m) => /the orchestrator on Antigravity is held/.test(m.title)).length, 1, 'one message');
    const kept = verdictOf(p).kept;
    if (kept) fs.rmSync(kept, { recursive: true, force: true });
  } finally {
    await stopHub(p, bg);
    await ntfy.close();
    p.cleanup();
  }
});

// An orchestrator on Antigravity writes git itself: a protected file it commits in its round is set back on disk and held;
// the commit stays. Reject: a push that carries it is refused, saying which commit to revert. Approve: it goes out with no
// second card.
async function ownCommit(p, decide) {
  fs.mkdirSync(p.state(), { recursive: true });
  fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: true }));
  const env = { ...AGY, STUB_ORCH_PLAY: 'commit-agents' };
  const agents = fs.readFileSync(path.join(p.repo, 'AGENTS.md'));
  let bg;
  let ui;
  try {
    p.hub(['note', 'add', 'Go on']);
    bg = await hubUp(p, p.hubInBackground(['run', '--tick-ms', '50'], env));
    await until(p, 'the round and its hold', () => ended(p) === 1 && /guard: held G1: A change on disk during the orchestrator's autopilot round changes AGENTS\.md/.test(hubLog(p)));
    assert.match(p.git('log', '-1', '--format=%s'), /the orchestrator's own commit of AGENTS\.md/, 'the commit stays');
    const own = p.git('rev-parse', 'HEAD');
    assert.ok(fs.readFileSync(path.join(p.repo, 'AGENTS.md')).equals(agents), 'AGENTS.md is set back on disk');
    ui = await startUi(p, env);
    const c = client(ui);
    const r = await c.post('/api/guard', { action: decide, id: 'G1', reason: decide === 'reject' ? 'not from a round' : '' });
    assert.equal(r.status, 200, r.text);
    // a push of main's work to another branch (no deploy branch: only a protected file could hold it)
    const push = p.hub(['push', 'feature', '--from', 'main'], { extraEnv: env });
    const id = push.out.match(/(push-[\w-]+)/)?.[1];
    assert.ok(id, push.out);
    await until(p, 'the push job to end', () => ['done', 'failed', 'blocked'].includes(p.status(id).state));
    return { r, own, s: p.status(id), remoteBranches: p.git('--git-dir', p.remote, 'for-each-ref', '--format=%(refname)') };
  } finally {
    await stopUi(ui);
    await stopHub(p, bg);
  }
}

test('a protected file the orchestrator on Argon commits itself, rejected: the push that carries the commit is refused, and says which commit to revert', async () => {
  const p = argonProject();
  try {
    const { r, own, s, remoteBranches } = await ownCommit(p, 'reject');
    assert.ok(r.json.message.includes(`The orchestrator committed it itself (${own.slice(0, 7)}): it is told to revert it`), r.json.message);
    assert.equal(s.state, 'failed', JSON.stringify(s));
    assert.match(s.detail, /the owner rejected this change to AGENTS.md .G1/);
    assert.ok(s.detail.includes(`commit ${own.slice(0, 7)} on main still has it. Revert it (git revert ${own.slice(0, 7)}), then push again`), s.detail);
    assert.doesNotMatch(remoteBranches, /feature/, 'nothing went out');
    assert.match(p.hub(['handoff', 'list']).out, /G1/);
  } finally {
    p.cleanup();
  }
});

test('a protected file the orchestrator on Argon commits itself, approved: the push goes out with no second card', async () => {
  const p = argonProject();
  try {
    const { s, remoteBranches } = await ownCommit(p, 'approve');
    assert.equal(s.state, 'done', JSON.stringify(s));
    assert.match(remoteBranches, /refs\/heads\/feature/);
    const held = JSON.parse(fs.readFileSync(guardDir(p.repo, p.env.HOME) + '/held.json', 'utf8')).items;
    assert.deepEqual(held.map((x) => x.kind), ['disk'], 'no push card');
  } finally {
    p.cleanup();
  }
});

// ---------- the push block's builder, the role's run, and what a round's commands look like ----------
test("the push block has one builder: a verify command's environment is what it was (its read token, NEXTLEVEL_AGENT=check); the orchestrator's on agy has no read token, nextlevel's agent and its own words", async () => {
  const { pushBlockEnv } = await import('../src/lib/pushblock.mjs');
  const { roleRun } = await import('../src/lib/rolespec.mjs');
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-pushblock-'));
  try {
    const git = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/example/app.git');
    git('remote', 'add', 'deploy', 'https://example.invalid/app.git');
    git('config', 'remote.deploy.pushurl', 'https://example.invalid/push.git');
    const base = { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, NEXTLEVEL_GITHUB_READ_TOKEN: 'a-read-token-from-an-earlier-env', GH_TOKEN: 'the-owners' };
    const verify = pushBlockEnv(base, { root: dir, block: 'check', session: { NEXTLEVEL_AGENT: 'check' }, readToken: 'github_pat_read_only_token' });
    assert.equal(verify.problem, undefined, verify.problem);
    assert.equal(verify.token, true);
    assert.equal(verify.env.NEXTLEVEL_AGENT, 'check');
    assert.equal(verify.env.GH_TOKEN, 'github_pat_read_only_token');
    assert.equal(verify.env.NEXTLEVEL_GITHUB_READ_TOKEN, 'github_pat_read_only_token');
    assert.match(verify.env.GIT_CONFIG_PARAMETERS, /'url\.nextlevel-no-push-from-verify-commands::\.pushinsteadof='/);
    assert.match(verify.env.GIT_CONFIG_PARAMETERS, /'remote\.deploy\.pushurl=nextlevel-no-push-from-verify-commands::deploy'/);
    assert.match(verify.env.GIT_CONFIG_PARAMETERS, /credential\.https:\/\/github\.com\.helper=/);
    // the push URLs, read back the way git uses them: nowhere
    const urls = (env, r) => spawnSync('git', ['remote', 'get-url', '--push', '--all', r], { cwd: dir, env, encoding: 'utf8' }).stdout.trim();
    assert.equal(urls(verify.env, 'deploy'), 'nextlevel-no-push-from-verify-commands::deploy');
    // the orchestrator's on agy: a round's, through the role's own run
    const run = roleRun({ profile: { engine: 'agy', model: 'gemini-4-argon-low' }, role: 'orchestrator', mode: 'headless', prompt: 'ROLE: ORCHESTRATOR', engineArgs: ['--dangerously-skip-permissions', '--mode', 'accept-edits'], version: '1.4.0', env: base, root: dir });
    assert.equal(run.problem, undefined, run.problem);
    assert.equal(run.env.NEXTLEVEL_GITHUB_READ_TOKEN, undefined, 'a round has no read token, even one an earlier .env left');
    assert.equal(run.env.GH_TOKEN, 'nextlevel-the-orchestrator-has-no-github-access');
    assert.equal(run.env.NEXTLEVEL_AGENT, 'orchestrator');
    assert.equal(run.env.NEXTLEVEL_SESSION, 'autopilot');
    assert.equal(run.env.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');
    assert.doesNotMatch(run.env.GIT_CONFIG_PARAMETERS, /credential\.https:\/\/github\.com\.helper/);
    assert.equal(urls(run.env, 'origin'), 'nextlevel-no-push-from-the-orchestrator-use-nextlevel-push::origin');
    assert.equal(urls(run.env, 'deploy'), 'nextlevel-no-push-from-the-orchestrator-use-nextlevel-push::deploy');
    assert.deepEqual(run.args.slice(-2), ['--agent', 'nextlevel-orchestrator']);
    assert.match(run.args[1], /^Read AGENTS\.md first/, "nextlevel's agent doesn't read AGENTS.md by itself: the prompt says to");
    assert.deepEqual(run.files[0].path, ['.agents', 'agents', 'nextlevel-orchestrator.md']);
    assert.match(run.files[0].text, /^inheritMcp: false$/m);
    assert.match(run.files[0].text, /never work around it|Never work around it/);
    assert.doesNotMatch(run.files[0].text, /call_mcp_tool/);
    // its window: the same agent, -i
    const win = roleRun({ profile: { engine: 'agy', model: 'gemini-4-argon-low' }, role: 'orchestrator', mode: 'interactive', prompt: 'ROLE: ORCHESTRATOR', engineArgs: [], version: '1.4.0', env: base, root: dir });
    assert.equal(win.args[0], '-i');
    assert.equal(win.args.filter((a) => a === '--agent').length, 1);
    assert.equal(win.env.NEXTLEVEL_SESSION, 'interactive');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a round's commands that clear the push block or go past it are found by pattern after the round; ordinary ones aren't", async () => {
  const { blockCommands, masked } = await import('../src/lib/blockwatch.mjs');
  const step = (i, cmd) => JSON.stringify({ event: 'step_update', step_update: { conversation_id: 'c', step_index: i, step_type: 'tool', tool_name: 'run_command', state: 'DONE', tool_info: { name: 'run_command', parameters: { CommandLine: cmd }, output: '' } } });
  const cmds = [
    'git status',
    'nextlevel push main',
    'git push origin HEAD:main',
    'Remove-Item Env:GIT_CONFIG_PARAMETERS; git status',
    '$env:GH_TOKEN = "x"',
    'git -c credential.helper=manager fetch',
    'gh auth login --with-token',
    'gh api -X POST repos/o/r/issues -f title=x',
    'gh api repos/o/r',
    'git config --unset-all remote.origin.pushurl',
    'unset GIT_SSH_COMMAND',
    // (ordinary: push as a word in a commit message, a variable's name in a search)
    'git commit -am "Add push notifications"',
    'grep -rn "GITHUB_TOKEN=" src',
  ];
  const found = blockCommands(cmds.map((c, i) => step(i, c)).join('\n'));
  assert.deepEqual(found.map((x) => x.command), [cmds[2], cmds[3], cmds[4], cmds[5], cmds[6], cmds[7], cmds[9], cmds[10]].map(masked));
  // the value a command gives a token or a sign-in is never shown
  assert.equal(found[2].command, '$env:GH_TOKEN = ***');
  assert.equal(found[3].command, 'git -c credential.helper=*** fetch');
  assert.equal(masked('GH_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123 gh api user'), 'GH_TOKEN=*** gh api user');
  assert.match(found[0].why, /a push with git itself/);
  // git's options before push are read in time linear in the line's length (the team writes these commands)
  for (const opt of ['-C', '-c "', '--a=b', '-c x']) assert.deepEqual(blockCommands(step(0, `git ${Array(5000).fill(opt).join(' ')} log`)), []);
  assert.equal(blockCommands(step(0, 'git -C repo -c core.pager=cat --no-pager push origin main')).length, 1);
});

test("the Team page and team set refuse the orchestrator on Argon until its lock test passes, saying why and the command; nextlevel orchestrator refuses its window too", async () => {
  const p = makeProject();
  const env = { ...AGY, STUB_AGY_MODELS: 'gemini-4-argon-low\tGemini 4 Argon (Low),gemini-4-argon-high\tGemini 4 Argon (High)' };
  try {
    const refused = p.hub(['team', 'set', 'orchestrator', '--engine', 'agy', '--model', 'gemini-4-argon-low', '--json'], { extraEnv: env });
    assert.equal(refused.code, 1, refused.out);
    const j = JSON.parse(refused.out);
    assert.equal(j.saved, false);
    assert.match(j.message, /^Not saved: Roles on Antigravity: lock test: the orchestrator \(gemini-4-argon-low\): it hasn't had its lock test yet, so it doesn't start on Antigravity/);
    assert.ok(j.results.find((r) => r.id === 'lock.test').steps.some((s) => s.command === 'nextlevel lock-test --engine agy --role orchestrator --model gemini-4-argon-low'));
    assert.equal(p.config().roles.orchestrator.engine, 'codex', 'nothing saved');
    // the lock test, by hand, before the orchestrator is on agy: then the change is saved
    const t = p.hub(['lock-test', '--engine', 'agy', '--role', 'orchestrator', '--model', 'gemini-4-argon-low'], { timeout: 600_000, extraEnv: env });
    assert.equal(t.code, 0, t.out);
    const saved = p.hub(['team', 'set', 'orchestrator', '--engine', 'agy', '--model', 'gemini-4-argon-low', '--json'], { extraEnv: env });
    assert.equal(saved.code, 0, saved.out);
    assert.equal(p.config().roles.orchestrator.engine, 'agy');
    // the Team page's row: still full access, and what nextlevel blocks
    const row = JSON.parse(p.hub(['team', '--json'], { extraEnv: env }).out).rows.find((r) => r.key === 'orchestrator');
    assert.ok(row.warnings.some((w) => /nextlevel blocks its pushes, your GitHub sign-in and your MCP servers \(its lock test passed on agy 1\.4\.0\)/.test(w)), row.warnings.join('\n'));
    assert.ok(row.notes.some((n) => /It starts only once its lock test passes on this agy version/.test(n)));
    // its lock test passed, and still no window: agy 1.4.0's window doesn't run the agent (16:25 on demo), rounds do
    for (const cmd of [['orchestrator'], ['_orch']]) {
      const open = cmd[0] === '_orch' ? p.nextlevel(cmd, { cwd: p.repo, extraEnv: { ...env, NEXTLEVEL_ROOT: p.repo } }) : p.hub(cmd, { extraEnv: env });
      assert.equal(open.code, 1, open.out);
      assert.match(open.out, /Not starting the orchestrator: Antigravity's interactive window doesn't run nextlevel's agent .*Autopilot rounds on Antigravity run as the agent/);
    }
    assert.equal(fs.existsSync(p.state('orchestrator.json')), false, 'no window was opened');
    // another model is another run, its lock test not passed: the window says first that it doesn't open on agy at all,
    // never asking for a lock test it wouldn't open after
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { ...c.roles.orchestrator, model: 'gemini-4-argon-high' } } }));
    const win = p.hub(['orchestrator'], { extraEnv: env });
    assert.equal(win.code, 1, win.out);
    assert.match(win.out, /Not starting the orchestrator: Antigravity's interactive window doesn't run nextlevel's agent/);
    assert.doesNotMatch(win.out, /lock-test/);
    assert.equal(fs.existsSync(p.state('orchestrator.json')), false, 'no window was opened');
  } finally {
    p.cleanup();
  }
});

test("the orchestrator's window on Antigravity is refused before any lock test: with none run, both commands say the window doesn't open there, not to run one", () => {
  const p = argonProject();
  try {
    for (const cmd of [['orchestrator'], ['_orch']]) {
      const open = cmd[0] === '_orch' ? p.nextlevel(cmd, { cwd: p.repo, extraEnv: { ...AGY, NEXTLEVEL_ROOT: p.repo } }) : p.hub(cmd, { extraEnv: AGY });
      assert.equal(open.code, 1, open.out);
      assert.match(open.out, /Not starting the orchestrator: Antigravity's interactive window doesn't run nextlevel's agent .*Autopilot rounds on Antigravity run as the agent/);
      assert.doesNotMatch(open.out, /lock-test|hasn't had its lock test/, cmd[0]);
    }
    assert.equal(fs.existsSync(p.state('orchestrator.json')), false, 'no window was opened');
    assert.equal(fs.existsSync(p.state('lock-tests', 'agy-orchestrator.json')), false, 'no lock test ran');
  } finally {
    p.cleanup();
  }
});

test("on a Git older than 2.46 the lock test's sessions can't start (its remote has a push URL of its own): the verdict says why and stands until Check again", async () => {
  const p = argonProject();
  try {
    const r = lockTest(p, { NEXTLEVEL_TEST_OLD_GIT: '1' });
    assert.equal(r.code, 1, r.out);
    const v = verdictOf(p);
    assert.equal(v.verdict, 'incomplete');
    assert.equal(v.startProblem, true);
    assert.match(v.reason, /^Not starting the orchestrator on Antigravity: a push from it could still reach the remote "second": .*only Git 2\.46 or later can switch off/);
    assert.equal(v.tries.length, 1, 'no try can run: it stops at the first');
    assert.match(r.out, /The lock test couldn't start its sessions: Not starting the orchestrator on Antigravity/);
    if (v.kept) fs.rmSync(v.kept, { recursive: true, force: true });
  } finally {
    p.cleanup();
  }
});
