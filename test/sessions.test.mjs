// FR-017 (part 1): what an agent's session can't do through nextlevel. Its sessions are known by what the hub puts in
// their environment (lib/session.mjs); `nextlevel verify` runs the orchestrator's command with the owner's access, so it
// waits while the guard has stopped git work, runs without Git pushes or GitHub sign-ins, and is logged with its exact
// command line in the guard's folder. Each project here has a local bare repository as its origin, never a real remote;
// the gh stub plays GitHub (a write through its API reaches that origin only with the owner's stored sign-in).
//   npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { guardDir } from '../src/lib/guard.mjs';
import { agentSession, ownerOnly } from '../src/lib/session.mjs';
import { hubRounds, isAlive, makeProject, sleep, waitUntil, withEnv } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const IS_WIN = process.platform === 'win32';

test("agentSession: whose session a nextlevel command runs in, from what the hub puts in its environment; the owner's own window is none", () => {
  assert.equal(agentSession({}), '');
  assert.equal(agentSession({ PATH: '/bin', NEXTLEVEL_NO_UPDATE: '1' }), '');
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'interactive' }), "the orchestrator's window");
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'autopilot' }), 'an autopilot round');
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'worker', NEXTLEVEL_TASK_ID: 'M1-01' }), "a worker's slot");
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'check' }), 'a verify command the orchestrator asked for (nextlevel verify)');
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'git-job' }), "a project hook during the hub's git work for the orchestrator");
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'push' }), 'a project hook during a push');
  assert.equal(agentSession({ NEXTLEVEL_READ_ONLY: '1' }), "the assistant's read-only session (nextlevel ask)");
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'security' }), "the security engineer's scan");
  assert.equal(agentSession({ NEXTLEVEL_AGENT: 'robot' }), "the robot's session");
  assert.equal(ownerOnly('nextlevel update --to', 'The owner runs it in their own PowerShell window.', 'an autopilot round'), "nextlevel update --to is the owner's, so it doesn't run in an agent's session (this is an autopilot round): nothing was done. The owner runs it in their own PowerShell window.");
});

test("the security engineer's scan runs no nextlevel command, its help included, and starts nothing", () => {
  const p = makeProject();
  try {
    const calls = path.join(p.tmp, 'calls.log');
    for (const args of [['status'], ['--help'], ['team', '--help'], ['doctor'], ['ask', 'what is this?'], ['security', 'scan']]) {
      const r = p.hub(args, { extraEnv: { NEXTLEVEL_AGENT: 'security', STUB_CALLS: calls } });
      assert.equal(r.code, 1, `${args.join(' ')}: ${r.out}`);
      assert.match(r.out, /nextlevel doesn't run in the security engineer's scan/);
    }
    assert.ok(!fs.existsSync(calls), 'no stub CLI started');
  } finally {
    p.cleanup();
  }
});

// ---------- nextlevel verify ----------
async function startHub(p, extraEnv = {}) {
  const bg = p.hubInBackground(['run', '--tick-ms', '200'], extraEnv);
  await waitUntil('the hub to start', () => fs.existsSync(p.state('hub.json')));
  return {
    async stop() {
      bg.kill();
      for (let i = 0; i < 25 && isAlive(bg.pid); i++) await sleep(200);
      fs.rmSync(p.state('hub.json'), { force: true });
    },
  };
}
const guardFile = (p, name) => path.join(guardDir(p.repo, p.env.HOME), name);
const verifyLog = (p) => (fs.existsSync(guardFile(p, 'verify.jsonl')) ? fs.readFileSync(guardFile(p, 'verify.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const heldGit = (p) => (fs.existsSync(guardFile(p, 'held.json')) ? JSON.parse(fs.readFileSync(guardFile(p, 'held.json'), 'utf8')).items.filter((x) => x.kind === 'git') : []);
const originRefs = (p) => spawnSync('git', ['--git-dir', p.remote, 'for-each-ref', '--format=%(refname)'], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
const FINAL = ['passed', 'failed', 'timeout', 'blocked', 'error', 'lost'];
const queuedId = (out) => (out.match(/^queued (check-\S+):/m) || [])[1];

// What the probe runs in a verify command, as a command of the orchestrator's might: pushes to origin by its name and by
// its address, and GitHub through gh (its sign-in, and a write that would make a branch on origin). One JSON line out.
const PROBE = `import { spawnSync } from 'node:child_process';
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: process.platform === 'win32' && cmd === 'gh' });
  return { what: [cmd, ...args].join(' '), code: r.status, out: \`\${r.stdout || ''}\${r.stderr || ''}\`.trim() };
};
const [remote, sha, ownPushurl] = process.argv.slice(2);
const results = [
  run('git', ['push', 'origin', 'HEAD:refs/heads/by-name']),
  run('git', ['push', remote, 'HEAD:refs/heads/by-address']),
  run('gh', ['auth', 'status']),
  run('gh', ['api', '-X', 'POST', 'repos/owner/app/git/refs', '-f', 'ref=refs/heads/by-gh', '-f', 'sha=' + sha]),
];
// a push URL the command writes into the project's settings itself, then takes out again
if (ownPushurl === 'yes') {
  run('git', ['config', 'remote.origin.pushurl', remote]);
  results.push(run('git', ['push', 'origin', 'HEAD:refs/heads/by-own-pushurl']));
  run('git', ['config', '--unset', 'remote.origin.pushurl']);
}
console.log('PROBE ' + JSON.stringify(results));
`;
// Git 2.46 and later take an empty pushurl as "none of the earlier ones": then even a push URL a command writes itself is
// cleared (an older Git keeps it: docs/KNOWN_ISSUES.md)
const GIT_CLEARS = (() => {
  const [a, b] = (spawnSync('git', ['--version'], { encoding: 'utf8' }).stdout.match(/(\d+)\.(\d+)/) || []).slice(1).map(Number);
  return a > 2 || (a === 2 && b >= 46);
})();

test('nextlevel verify (FR-017): it waits while the guard has stopped git work; its command runs without Git pushes or GitHub sign-ins, so a git push or a gh write reaches nothing; each is logged with its exact command line in the guard\'s folder', async () => {
  const p = makeProject();
  const hub = await startHub(p);
  let ui;
  try {
    p.git('push', '-q', 'origin', 'main'); // origin as the test itself sets it up
    const main = p.git('rev-parse', 'HEAD');
    await hubRounds(p); // the guard's first look: git's settings as they are now are the owner's
    // A push URL of the project's own appears (the owner's, here: it points at origin itself). A remote's explicit
    // pushurl is what pushInsteadOf doesn't rewrite; and a change nextlevel didn't make stops all git work
    p.git('config', 'remote.origin.pushurl', p.remote);
    const q = p.hub(['verify', 'pushit', '--', 'git', 'push', 'origin', 'HEAD:refs/heads/sneaky']);
    assert.equal(q.code, 0, q.out);
    assert.match(q.out, /It runs in the main checkout without Git pushes or GitHub sign-ins, and waits while git work is stopped for the owner\./);
    const id = queuedId(q.out);
    // It waits, saying why, as other git work does
    await waitUntil('the verify job to say it waits', () => /git's own hooks or settings changed/.test(p.status(id).waiting || ''));
    await hubRounds(p);
    assert.equal(p.status(id).state, 'queued');
    const waited = p.hub(['wait', id, '--minutes', '0.02']);
    assert.match(waited.out, new RegExp(`still running after 0\\.02 min: ${id} \\(queued, waiting: git's own hooks or settings changed and nextlevel didn't make that change, so all git work waits for the owner \\(G1, card H\\d+ on the dashboard\\)\\)`));
    assert.deepEqual(originRefs(p), ['refs/heads/main']);
    assert.deepEqual(verifyLog(p), [], 'nothing ran');

    // The owner approves the setting on the dashboard: git work goes on, and the verify command runs, without pushes
    ui = await startUi(p);
    const [rec] = heldGit(p);
    assert.deepEqual(rec.items, ['remote.origin.pushurl']);
    assert.equal((await client(ui).post('/api/guard', { action: 'approve', id: rec.id })).status, 200);
    await waitUntil('the verify job to end', () => FINAL.includes(p.status(id).state));
    const s = p.status(id);
    const log = fs.readFileSync(p.jobFile(id, 'check.log'), 'utf8');
    if (s.state === 'blocked') {
      // A Git older than 2.46 can't clear a remote's own pushurl for one command: then the command doesn't run at all
      assert.match(s.detail, /^not run: a push from it could still reach the remote "origin": the project's git config sets remote\.origin\.pushurl, which only Git 2\.46 or later can switch off/);
    } else {
      assert.equal(s.state, 'failed', log);
      assert.match(log, /nextlevel-no-push-from-verify-commands/, log);
    }
    assert.deepEqual(originRefs(p), ['refs/heads/main'], 'nothing reached origin');
    assert.equal(spawnSync('git', ['--git-dir', p.remote, 'rev-parse', 'main'], { encoding: 'utf8' }).stdout.trim(), main);

    // Without the project's own pushurl: every way a command of the orchestrator's might push, by git or through gh
    p.git('config', '--unset', 'remote.origin.pushurl');
    assert.equal((await client(ui).post('/api/guard', { action: 'approve', id: (await waitForHeld(p)).id })).status, 200);
    const probe = path.join(p.tmp, 'probe.mjs');
    fs.writeFileSync(probe, PROBE);
    // (asked from the orchestrator's window: the log says so, as the job says it)
    const ownPushurl = GIT_CLEARS ? 'yes' : 'no';
    const q2 = p.hub(['verify', 'probe', '--', 'node', probe, p.remote, main, ownPushurl], { extraEnv: { NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'interactive' } });
    const id2 = queuedId(q2.out);
    await waitUntil('the probe to end', () => FINAL.includes(p.status(id2).state));
    const log2 = fs.readFileSync(p.jobFile(id2, 'check.log'), 'utf8');
    assert.equal(p.status(id2).state, 'passed', log2);
    const [byName, byAddress, auth, write, byOwnPushurl] = JSON.parse(log2.match(/^PROBE (.*)$/m)[1]);
    for (const r of [byName, byAddress, ...(GIT_CLEARS ? [byOwnPushurl] : [])]) {
      assert.notEqual(r.code, 0, `${r.what}: ${r.out}`);
      assert.match(r.out, /nextlevel-no-push-from-verify-commands/, r.what);
    }
    // gh's sign-in is the block's token, which fails, and gh's folder has none of the owner's (real gh, which the stub plays,
    // lists a stored login beside a failing token: KNOWN_ISSUES, "GitHub CLI"; a verify command gets NO_GH_CONFIG, as workers do)
    assert.notEqual(auth.code, 0, auth.out);
    assert.match(auth.out, /Bad credentials/, 'gh finds no sign-in of the owner');
    assert.doesNotMatch(auth.out, /Logged in to/, "the owner's stored login isn't listed");
    assert.notEqual(write.code, 0, write.out);
    assert.deepEqual(originRefs(p), ['refs/heads/main'], 'nothing reached origin, by git or through gh');
    // ... where the owner's own window, without the block, has the sign-in and could push: the block is what stopped them
    // (on Windows the gh stub is a .cmd: one command line through the shell, not arguments beside shell: true, DEP0190)
    const own = IS_WIN ? spawnSync('gh auth status', { cwd: p.repo, env: withEnv(p.env), encoding: 'utf8', shell: true }) : spawnSync('gh', ['auth', 'status'], { cwd: p.repo, env: withEnv(p.env), encoding: 'utf8' });
    assert.equal(own.status, 0, `${own.stdout}${own.stderr}`);

    // The guard's log (outside the project): each verify command with its exact command line, who asked, and how it ended
    const logged = verifyLog(p);
    const push = 'git push origin HEAD:refs/heads/sneaky';
    const node = `node ${[probe, p.remote, main, ownPushurl].map((x) => (/^[\w\-.:/\\=@,+%]+$/.test(x) ? x : IS_WIN ? `"${x}"` : `'${x}'`)).join(' ')}`;
    assert.deepEqual(logged.map((e) => [e.job, e.state, e.command]), [
      ...(p.status(id).state === 'blocked' ? [[id, 'refused', push]] : [[id, 'started', push], [id, 'failed', push]]),
      [id2, 'started', node],
      [id2, 'passed', node],
    ]);
    const started = logged.find((e) => e.job === id2 && e.state === 'started');
    // (the same folder, as real paths: GitHub's Windows runner spells the temp folder C:\Users\RUNNER~1, the hub its real name)
    assert.deepEqual([started.by, started.source, fs.realpathSync.native(started.cwd)], ['orchestrator', "the orchestrator's window", fs.realpathSync.native(p.repo)]);
    assert.ok(!guardFile(p, 'verify.jsonl').startsWith(p.repo), 'outside the project');
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), new RegExp(`${id}: running "git push origin HEAD:refs/heads/sneaky" in the main checkout \\(Git pushes and GitHub sign-ins off\\)|${id}: not run: a push from it could still reach`));

    // nextlevel's own doctor, as the role docs give it (the setup seen from outside Codex's sandbox, FR-004 #2), is the
    // hub's own run with the owner's sign-ins: it only looks. Anything more on the line is an ordinary verify command.
    const doc = queuedId(p.hub(['verify', 'doctor', '--', 'nextlevel doctor']).out);
    const more = queuedId(p.hub(['verify', 'more', '--', 'nextlevel doctor && gh auth status']).out);
    await waitUntil('both doctors to end', () => FINAL.includes(p.status(doc).state) && FINAL.includes(p.status(more).state));
    const docLog = fs.readFileSync(p.jobFile(doc, 'check.log'), 'utf8');
    assert.match(docLog, / ok +GitHub sign-in +signed in/, docLog);
    assert.match(verifyLog(p).find((e) => e.job === doc && e.state === 'started').ran, /^nextlevel's own doctor \(doctor\), the hub's copy, with the owner's sign-ins: it only looks$/);
    const moreLog = fs.readFileSync(p.jobFile(more, 'check.log'), 'utf8');
    assert.equal(p.status(more).state, 'failed', moreLog);
    assert.match(moreLog, /!! +GitHub sign-in +not signed in/, 'with more on the line, the doctor in it had no sign-in');
    assert.equal(verifyLog(p).find((e) => e.job === more && e.state === 'started').ran, undefined);
    assert.deepEqual(originRefs(p), ['refs/heads/main']);
  } finally {
    stopUi(ui);
    await hub.stop();
    p.cleanup();
  }
});
// What the reads probe runs in a verify command: gh reading CI and its sign-in; git's credential for github.com (and for
// another host); a write through GitHub's API; a push. The token is never printed by the probe but once, on purpose, as
// GH_TOKEN=..., so the test can see `nextlevel result` hide it. One JSON line out.
const READS_PROBE = `import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const NL = String.fromCharCode(10);
const run = (cmd, args, input) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', input, shell: process.platform === 'win32' && cmd === 'gh' });
  return { what: [cmd, ...args].join(' '), code: r.status, out: \`\${r.stdout || ''}\${r.stderr || ''}\`.trim() };
};
const [expected, sha] = process.argv.slice(2);
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const fill = (host) => run('git', ['credential', 'fill'], ['protocol=https', 'host=' + host, '', ''].join(NL));
const github = fill('github.com');
const password = (github.out.split(NL).find((l) => l.startsWith('password=')) || '').slice('password='.length);
const other = fill('example.com');
console.log('GH_TOKEN=' + process.env.GH_TOKEN);
console.log('READS ' + JSON.stringify({
  ghHasIt: hash(process.env.GH_TOKEN) === expected && hash(process.env.GITHUB_TOKEN) === expected,
  gitHasIt: github.code === 0 && hash(password) === expected,
  otherHost: { code: other.code, password: /password=/.test(other.out) },
  list: run('gh', ['run', 'list', '--limit', '1']),
  auth: run('gh', ['auth', 'status']),
  write: run('gh', ['api', '-X', 'POST', 'repos/owner/app/git/refs', '-f', 'ref=refs/heads/by-gh', '-f', 'sha=' + sha]),
  push: run('git', ['push', 'origin', 'HEAD:refs/heads/with-token']),
}));
`;

test("GitHub reads in verify (FR-017): with a read-only token in the project's .env, gh gets it and git gets it for github.com only; GitHub refuses a write with it, a push still reaches nothing, and `nextlevel result` hides it; without it gh gets the token that doesn't work, and the log says why", async () => {
  const p = makeProject();
  const READ = ['stub', 'read', 'token', '7f3a', 'made', 'up'].join('-');
  const hub = await startHub(p, { STUB_GH_READ_TOKEN: READ });
  try {
    p.git('push', '-q', 'origin', 'main');
    const main = p.git('rev-parse', 'HEAD');
    await hubRounds(p);
    // Without the token: gh gets the one that doesn't work, and the log and the status say why
    const none = queuedId(p.hub(['verify', 'ci', '--', 'gh run list --limit 1']).out);
    await waitUntil('the read without a token to end', () => FINAL.includes(p.status(none).state));
    const noneLog = fs.readFileSync(p.jobFile(none, 'check.log'), 'utf8');
    assert.equal(p.status(none).state, 'failed', noneLog);
    assert.match(noneLog, /Bad credentials/);
    assert.match(noneLog, /nextlevel: this command had no GitHub sign-in: verify commands run without the owner's \(FR-017\), so gh and git can't read GitHub from here\. A read-only token in the project's \.env \(NEXTLEVEL_GITHUB_READ_TOKEN\) lets them read/);
    assert.match(p.status(none).detail, /^this command had no GitHub sign-in/);

    // With it in .env (the hub reads .env again for each verify command)
    fs.appendFileSync(path.join(p.repo, '.env'), `NEXTLEVEL_GITHUB_READ_TOKEN=${READ}\n`);
    const probe = path.join(p.tmp, 'reads.mjs');
    fs.writeFileSync(probe, READS_PROBE);
    const expected = createHash('sha256').update(READ).digest('hex');
    const id = queuedId(p.hub(['verify', 'reads', '--', 'node', probe, expected, main]).out);
    await waitUntil('the reads probe to end', () => FINAL.includes(p.status(id).state));
    const log = fs.readFileSync(p.jobFile(id, 'check.log'), 'utf8');
    assert.equal(p.status(id).state, 'passed', log);
    const r = JSON.parse(log.match(/^READS (.*)$/m)[1]);
    assert.equal(r.ghHasIt, true, 'gh gets the token as GH_TOKEN and GITHUB_TOKEN');
    assert.equal(r.gitHasIt, true, 'git credential fill for github.com returns it');
    assert.deepEqual(r.otherHost.password, false, 'and nothing for another host');
    assert.equal(r.list.code, 0, r.list.out);
    assert.match(r.auth.out, /read-only token/);
    assert.notEqual(r.write.code, 0, r.write.out);
    assert.match(r.write.out, /HTTP 403: Resource not accessible by personal access token/, 'GitHub refuses a write with it');
    assert.notEqual(r.push.code, 0, r.push.out);
    assert.match(r.push.out, /nextlevel-no-push-from-verify-commands/);
    assert.deepEqual(originRefs(p), ['refs/heads/main'], 'nothing reached origin');
    // The token is a secret like any .env value: what the orchestrator reads of the log never has it
    assert.ok(log.includes(`GH_TOKEN=${READ}`), 'the probe printed it once, on purpose');
    const shown = p.hub(['result', id]).out;
    assert.match(shown, /GH_TOKEN=\*\*\*/);
    assert.ok(!shown.includes(READ), shown);
    assert.ok(!verifyLog(p).some((e) => JSON.stringify(e).includes(READ)), "nor the guard's log");
  } finally {
    await hub.stop();
    p.cleanup();
  }
});

async function waitForHeld(p) {
  let rec;
  await waitUntil('a card for the changed git setting', () => (rec = heldGit(p).find((x) => x.status === 'held')));
  return rec;
}
