// FR-015: on a real project the orchestrator ran `nextlevel push --help` to learn the command's options; push took no
// arguments, ignored the flag and pushed main, which deployed production. Every command now answers -h and --help with
// its usage and does nothing else, and an option or argument it doesn't take prints the usage and fails, doing nothing
// (one strict parser, lib/commands.mjs); push names its branch; a deploy branch waits for the owner's approval on the
// dashboard; and every push goes through one function (the hub's pushBranch). Each project here has a local bare
// repository as its origin, never a real remote.
//   npm test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { CLI_COMMANDS } from '../src/cli.mjs';
import { HUB_COMMANDS } from '../src/hub.mjs';
import { COMMANDS, COMMAND_NAMES, parseCommand, usageText } from '../src/lib/commands.mjs';
import { defaults, loadConfig } from '../src/lib/config.mjs';
import { guardDir, recordOwner } from '../src/lib/guard.mjs';
import { writeShims } from '../src/lib/install.mjs';
import { isProtected, protectedList } from '../src/lib/protect.mjs';
import { branchNameProblem, deployList, isDeployBranch, parseLsRemote, pushArgs, targetProblem } from '../src/lib/push.mjs';
import { BIN, REPO, makeProject, withEnv } from './helpers.mjs';
import { client, request, startUi, stopUi } from './ui-helpers.mjs';

const IS_WIN = process.platform === 'win32';

// ---------- what a test looks at ----------
const gitOut = (args, opts = {}) => spawnSync('git', args, { encoding: 'utf8', ...opts }).stdout.trim();
const remoteRefs = (p) => gitOut(['--git-dir', p.remote, 'for-each-ref', '--format=%(refname) %(objectname)']);
const remoteHead = (p, branch) => gitOut(['--git-dir', p.remote, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
const guardFile = (p, name) => path.join(guardDir(p.repo, p.env.HOME), name);
const pushRecords = (p) => {
  try {
    return JSON.parse(fs.readFileSync(guardFile(p, 'held.json'), 'utf8')).items.filter((x) => x.kind === 'push');
  } catch {
    return [];
  }
};
const pushLog = (p) => {
  try {
    return fs.readFileSync(guardFile(p, 'pushes.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const handoffCards = (p) => {
  try {
    return JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items;
  } catch {
    return [];
  }
};
const queued = (p) => {
  try {
    return fs.readdirSync(p.state('queue'));
  } catch {
    return [];
  }
};
// A commit on the project's current branch, with its own file: its full id
function commit(p, message, file = `f-${createHash('sha1').update(message).digest('hex').slice(0, 8)}.txt`) {
  fs.writeFileSync(path.join(p.repo, file), `${message}\n`);
  p.git('add', file);
  p.git('commit', '-qm', message);
  return p.git('rev-parse', 'HEAD');
}
// origin as the test itself sets it up: its main where the project's main is (the test's own git, not nextlevel's), and
// a hook that writes down every push that arrives with the push job nextlevel's pushBranch gives it
function seedOrigin(p) {
  p.git('push', '-q', 'origin', 'main');
  const log = path.join(p.tmp, 'origin-received.log');
  const hook = path.join(p.remote, 'hooks', 'pre-receive');
  fs.writeFileSync(hook, `#!/bin/sh\nwhile read old new ref; do echo "\${NEXTLEVEL_PUSH_JOB:-none} $ref $new" >> "${log.replace(/\\/g, '/')}"; done\n`);
  fs.chmodSync(hook, 0o755);
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' ')) : []);
}
// Every push that reached origin came through pushBranch: it has the job's mark, and the job's log says it pushed
function everyPushThroughTheHub(p, received) {
  const done = new Set(pushLog(p).filter((e) => e.state === 'done').map((e) => e.job));
  for (const [job, ref] of received()) {
    assert.notEqual(job, 'none', `a push to ${ref} arrived at origin without nextlevel's push job`);
    assert.ok(done.has(job), `${job} pushed ${ref}, and the guard's push log has it done`);
  }
}

// The owner's own change of nextlevel.json, as the Team page and the doctor write it: recorded as the owner's, so the push
// guard doesn't ask about it again when main goes out (it compares a push with origin's main)
function ownerConfig(p, patch) {
  p.setConfig(patch);
  assert.ok(recordOwner(p.repo, ['nextlevel.json'], { home: p.env.HOME, env: {} }));
}

// `nextlevel ...` without blocking this process (it may serve the stand-in ntfy)
const runAsync = (p, args, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: p.repo, env: withEnv(p.env, extraEnv) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, out });
    });
  });
const hubRun = (p, extraEnv = {}) => runAsync(p, ['run', '--exit-when-idle', '--tick-ms', '200'], extraEnv);
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

// ---------- every command's --help ----------
// What must not change when a command only prints its usage: the remote's refs, the project's refs, index and settings,
// every file of the project (its hub state, cards and notes in .nextlevel/ included) and of the sandbox's home (the
// guard's records, engines' sessions), and no stub CLI called (no engine, gh, docker...)
function snapshot(p) {
  const files = {};
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (f === path.join(p.repo, '.git') || f === p.remote) continue;
      if (e.isDirectory()) walk(f);
      else files[path.relative(p.tmp, f)] = createHash('sha1').update(fs.readFileSync(f)).digest('hex');
    }
  };
  walk(p.tmp);
  const git = (...a) => gitOut(a, { cwd: p.repo });
  return {
    files,
    remote: remoteRefs(p),
    refs: git('for-each-ref', '--format=%(refname) %(objectname)'),
    head: git('symbolic-ref', '-q', 'HEAD'),
    staged: git('diff', '--cached', '--raw'),
    config: fs.readFileSync(path.join(p.repo, '.git', 'config'), 'utf8'),
    hooks: fs.readdirSync(path.join(p.repo, '.git', 'hooks')).join(','),
  };
}
function changes(a, b) {
  const out = [];
  for (const k of new Set([...Object.keys(a.files), ...Object.keys(b.files)])) if (a.files[k] !== b.files[k]) out.push(`${a.files[k] ? (b.files[k] ? 'changed' : 'removed') : 'added'}: ${k}`);
  for (const k of ['remote', 'refs', 'head', 'staged', 'config', 'hooks']) if (a[k] !== b[k]) out.push(`${k} changed`);
  return out;
}
// More arguments than the command takes (null: it takes any number)
function tooMany(name) {
  const spec = COMMANDS[name];
  if (spec.subs) return ['no-such-subcommand'];
  const most = (spec.args || [0, 0])[1];
  return Number.isFinite(most) ? Array.from({ length: most + 1 }, (_, i) => `extra-${i}`) : null;
}

test('the command list is every command nextlevel runs, and each has its usage: one missing from lib/commands.mjs fails here', () => {
  const runs = new Set([...HUB_COMMANDS, ...CLI_COMMANDS]);
  assert.deepEqual([...runs].filter((c) => !COMMAND_NAMES.includes(c)), [], 'every command nextlevel runs is in lib/commands.mjs');
  assert.deepEqual(COMMAND_NAMES.filter((c) => !runs.has(c)), [], 'every listed command runs');
  for (const name of COMMAND_NAMES) {
    const usage = usageText(name);
    assert.match(usage, /^Usage:\n {2}nextlevel /, name);
    assert.match(usage, /-h, --help +print this, and do nothing else/, name);
  }
});

test('every command: --help and -h print its usage and do nothing; an unknown option or an argument it does not take prints the usage and fails, doing nothing (and through nextlevel.cmd on Windows)', { timeout: 30 * 60_000 }, () => {
  const p = makeProject();
  try {
    seedOrigin(p);
    // The installer's own nextlevel command (nextlevel.cmd on Windows, a sh script elsewhere), the one an agent's shell runs
    writeShims(p.bin, REPO);
    const calls = path.join(p.tmp, 'stub-calls.log');
    const env = { STUB_CALLS: calls, NEXTLEVEL_NO_BROWSER: '1', NEXTLEVEL_HUB_WINDOW: '0' };
    const viaNode = (args) => p.hub(args, { extraEnv: env, timeout: 60_000 });
    const viaShim = (args) => {
      const r = IS_WIN
        ? spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', path.join(p.bin, 'nextlevel.cmd'), ...args], { cwd: p.repo, env: withEnv(p.env, env), encoding: 'utf8', timeout: 60_000 })
        : spawnSync('sh', [path.join(p.bin, 'nextlevel'), ...args], { cwd: p.repo, env: withEnv(p.env, env), encoding: 'utf8', timeout: 60_000 });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    };
    const before = snapshot(p);
    const nothing = (what) => {
      assert.deepEqual(changes(before, snapshot(p)), [], `${what} changed nothing`);
      assert.equal(fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '', '', `${what} started no engine or tool`);
    };
    for (const name of COMMAND_NAMES) {
      const usage = usageText(name);
      const runs = [['node', viaNode], [IS_WIN ? 'nextlevel.cmd' : 'the launcher', viaShim]];
      for (const [how, run] of runs) {
        for (const flag of ['--help', '-h']) {
          const r = run([name, flag]);
          assert.equal(r.code, 0, `${how}: nextlevel ${name} ${flag}\n${r.out}`);
          assert.equal(r.out.replace(/\r\n/g, '\n').trim(), usage, `${how}: nextlevel ${name} ${flag} prints its usage, and only that`);
          nothing(`${how}: nextlevel ${name} ${flag}`);
        }
        // -h in a group of short options is help too (FR-017): commit -hm "x", merge <id> -hm "x"
        for (const s of Object.values(COMMANDS[name].options || {}).map((o) => o.short).filter(Boolean)) {
          const args = [name, ...Array.from({ length: (COMMANDS[name].args || [0, 0])[0] }, () => 'T1'), `-h${s}`, 'x'];
          const r = run(args);
          assert.equal(r.code, 0, `${how}: nextlevel ${args.join(' ')}\n${r.out}`);
          assert.equal(r.out.replace(/\r\n/g, '\n').trim(), usage, `${how}: nextlevel ${args.join(' ')} prints its usage, and only that`);
          nothing(`${how}: nextlevel ${args.join(' ')}`);
        }
        const bad = run([name, '--no-such-option']);
        assert.equal(bad.code, 1, `${how}: nextlevel ${name} --no-such-option\n${bad.out}`);
        assert.ok(bad.out.includes(`nextlevel ${name}: nextlevel ${name} has no option --no-such-option`), `${how}: ${name} says what is wrong\n${bad.out}`);
        assert.ok(bad.out.replace(/\r\n/g, '\n').includes(usage), `${how}: ${name} prints its usage with the error`);
        nothing(`${how}: nextlevel ${name} --no-such-option`);
      }
      const extra = tooMany(name);
      if (extra) {
        const r = viaNode([name, ...extra]);
        assert.equal(r.code, 1, `nextlevel ${name} ${extra.join(' ')}\n${r.out}`);
        assert.ok(r.out.replace(/\r\n/g, '\n').includes(usage), `${name} ${extra.join(' ')} prints its usage`);
        nothing(`nextlevel ${name} ${extra.join(' ')}`);
      }
      const help = viaNode(['help', name]);
      assert.equal(help.code, 0, help.out);
      assert.equal(help.out.replace(/\r\n/g, '\n').trim(), usage, `nextlevel help ${name} prints the same usage`);
      nothing(`nextlevel help ${name}`);
    }
    // The first thing the orchestrator typed on a real project, and what it meant
    const push = viaShim(['push', '--help']).out.replace(/\r\n/g, '\n');
    assert.match(push, /nextlevel push <branch> \[--from <local branch>\]/);
    assert.match(push, /nextlevel push backup\/main/);
    assert.match(push, /A deploy branch \(deployBranches in nextlevel\.json; until it is set, the base branch\) is not pushed by this\ncommand/);
    assert.equal(remoteRefs(p), before.remote);
    assert.deepEqual(queued(p), []);
  } finally {
    p.cleanup();
  }
});

test('the parser: options by their long and short names, "--" and what follows it, subcommands with options of their own, values that may be empty', () => {
  assert.deepEqual(parseCommand('push', ['--help']), { help: true });
  assert.deepEqual(parseCommand('push', ['x', '-h']), { help: true });
  // -h is what the parser reads as help, in a group of short options too, whatever else is wrong (FR-017)
  assert.deepEqual(parseCommand('commit', ['-hm', 'x']), { help: true });
  assert.deepEqual(parseCommand('merge', ['T1', '-hm', 'x']), { help: true });
  assert.deepEqual(parseCommand('commit', ['-hm']), { help: true });
  assert.deepEqual(parseCommand('push', ['-xh']), { help: true });
  assert.deepEqual(parseCommand('commit', ['-mh']).args, { _: [], message: 'h' }, '-mh is -m "h": the parser reads no help there');
  assert.deepEqual(parseCommand('ask', ['--', '-hm']).args?._, ['-hm'], 'after "--" it is an argument');
  assert.deepEqual(parseCommand('push', ['--', '--help']).args?._, ['--help'], 'after "--" it is an argument (and push refuses it as a branch)');
  assert.deepEqual(parseCommand('push', ['backup/main', '--from', 'ci']).args, { _: ['backup/main'], from: 'ci' });
  assert.match(parseCommand('push', []).error, /name the branch on origin to push to .*there is no default/);
  assert.match(parseCommand('push', ['main', 'more']).error, /nextlevel push takes at most 1 argument: "more" is more than it takes/);
  assert.match(parseCommand('push', ['--force', 'main']).error, /nextlevel push has no option --force/);
  assert.match(parseCommand('push', ['main', '--from']).error, /argument missing/);
  assert.deepEqual(parseCommand('commit', ['-m', 'a message', 'a.txt', '--', 'b.txt']).args, { _: ['a.txt', 'b.txt'], message: 'a message' });
  assert.deepEqual(parseCommand('verify', ['tests', '--', 'npm', 'test']).args, { _: ['tests'], '--': ['npm', 'test'] });
  assert.deepEqual(parseCommand('doctor', ['--fix', 'codex.login', '--json']).args, { _: ['codex.login'], fix: true, json: true });
  assert.deepEqual(parseCommand('doctor', ['--fix=codex.login']).args, { _: ['codex.login'], fix: true });
  assert.match(parseCommand('doctor', ['codex.login']).error, /a check id goes with --fix/);
  assert.deepEqual(parseCommand('dispatch', ['T1', '--verify', 'a', '--verify', 'b']).args, { _: ['T1'], verify: ['a', 'b'] });
  assert.deepEqual(parseCommand('team', ['set', 'worker', '--engine', '', '--model', '', '--effort', '', '--json']).args, { _: ['set', 'worker'], engine: '', model: '', effort: '', json: true }, "the dashboard's Team page sends empty values");
  assert.match(parseCommand('note', ['add', 'x', '--reply', 'y']).error, /nextlevel note add doesn't take --reply/);
  assert.match(parseCommand('note', ['frobnicate']).error, /"frobnicate" isn't one of nextlevel note's commands/);
  assert.deepEqual(parseCommand('ask', ['--json', '--thread', 't1', '--', '-h in git?']).args, { _: ['-h in git?'], json: true, thread: 't1' });
  assert.match(parseCommand('wait', []).error, /give a job id, or --any/);
  assert.match(parseCommand('status', ['--json=yes']).error, /does not take an argument/);
});

// ---------- push: the rules ----------
test('lib/push: a push names a plain branch; anything that could reach a branch another way is refused, and nothing is ever forced', () => {
  for (const ok of ['main', 'backup/main', 'ci/m1-gates', 'release-1.2', 'feature/a_b']) assert.equal(targetProblem(ok, { remotes: ['origin', 'upstream'], tags: ['v1'] }), '', ok);
  const refused = {
    '': /no branch name/,
    '+main': /a leading "\+" forces a push/,
    'main:main': /a colon makes it a refspec/,
    ':main': /a colon/,
    'refs/heads/main': /names a ref directly/,
    'HEAD': /is not a branch/,
    'head': /is not a branch/,
    '@': /is not a branch/,
    'main@{1}': /is not a branch/,
    '-f': /reads as an option/,
    '--force': /reads as an option/,
    'origin/main': /names a branch through the remote origin: give the branch's own name \(main\)/,
    'upstream/main': /through the remote upstream/,
    'origin': /is the name of a remote, not a branch/,
    'remotes/origin/main': /reads as a remote's branch/,
    'v1': /is a tag, not a branch/,
    'a..b': /isn't a valid branch name/,
    'a b': /characters a branch name can't have/,
    'main~1': /characters/,
    'main^': /characters/,
    'x.lock': /isn't a valid branch name/,
    'a//b': /isn't a valid branch name/,
    '.hidden': /isn't a valid branch name/,
  };
  for (const [name, why] of Object.entries(refused)) assert.match(targetProblem(name, { remotes: ['origin', 'upstream'], tags: ['v1'] }), why, JSON.stringify(name));
  const sha = 'a'.repeat(40);
  const args = pushArgs(sha, 'backup/main');
  assert.deepEqual(args, ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', 'origin', `${sha}:refs/heads/backup/main`]);
  assert.ok(!args.some((a) => /force|^\+|mirror|--all|--tags|--delete|--prune/.test(a)), 'nothing forced, deleted or carried along');
  assert.throws(() => pushArgs('main', 'x'), /not a commit id/);
  assert.throws(() => pushArgs(sha, '+main'), /forces a push/);
  assert.equal(branchNameProblem('main'), '');
  assert.deepEqual(parseLsRemote(`${'1'.repeat(40)}\trefs/heads/main\n${'2'.repeat(40)}\trefs/tags/v1\n${'3'.repeat(40)}\trefs/tags/v1^{}\n${'4'.repeat(40)}\trefs/heads/__proto__\nnot a line\n`), { heads: new Map([['main', '1'.repeat(40)], ['__proto__', '4'.repeat(40)]]), tags: ['v1'] });
  // The deploy branches: the list, or while it isn't set the base branch; a name counts whatever its case
  assert.deepEqual(deployList(defaults('p')), ['main']);
  assert.deepEqual(deployList({ ...defaults('p'), baseBranch: 'trunk' }), ['trunk']);
  assert.deepEqual(deployList({ ...defaults('p'), deployBranches: [] }), []);
  assert.equal(isDeployBranch('Main', ['main']), true);
  // nextlevel.json holds the list, and it is protected: the team can't change it without the owner
  assert.equal(isProtected('nextlevel.json', protectedList(defaults('p')).entries), true);
  assert.throws(() => loadConfig(REPO, { raw: { deployBranches: ['origin:main'] }, env: {} }), /"deployBranches" names branches on origin by their plain names/);
  assert.throws(() => loadConfig(REPO, { raw: { deployBranches: 'main' }, env: {} }), /"deployBranches" must be a list of branch names/);
  assert.deepEqual(loadConfig(REPO, { raw: { deployBranches: ['main', 'production'] }, env: {} }).config.deployBranches, ['main', 'production']);
  assert.equal(loadConfig(REPO, { raw: {}, env: {} }).config.deployBranches, null, 'not set');
});

// ---------- push: the command and the hub ----------
test('push names its branch: none refuses; backup/main and a CI branch push only that branch; each refused form is refused by the command and again by the hub; a push that would drop commits is refused', async () => {
  const p = makeProject();
  try {
    const received = seedOrigin(p);
    const main0 = p.git('rev-parse', 'HEAD');
    const main1 = commit(p, 'M1: a new page');
    p.git('tag', 'v1');
    // No branch: refused, nothing queued, the usage shown
    const none = p.hub(['push']);
    assert.equal(none.code, 1, none.out);
    assert.match(none.out, /nextlevel push: name the branch on origin to push to \(nextlevel push backup\/main\): there is no default/);
    assert.match(none.out, /Usage:\n {2}nextlevel push <branch>/);
    // Each form that could reach a branch another way: refused by the command
    const forms = { '+main': /forces a push/, 'main:main': /refspec/, 'refs/heads/main': /names a ref directly/, HEAD: /is not a branch/, 'origin/main': /through the remote origin/, origin: /name of a remote/, v1: /is a tag/, '-x': /reads as an option/, 'a..b': /isn't a valid branch name/ };
    for (const [form, why] of Object.entries(forms)) {
      const r = p.hub(['push', '--', form]);
      assert.equal(r.code, 1, `${form}: ${r.out}`);
      assert.match(r.out, /nothing was queued: /, form);
      assert.match(r.out, why, form);
    }
    assert.match(p.hub(['push', 'backup/main', '--from', 'no-such-branch']).out, /nothing was queued: there is no local branch "no-such-branch"/);
    assert.match(p.hub(['push', 'backup/main', '--from', 'origin/main']).out, /nothing was queued: --from "origin\/main" names a branch through the remote origin/);
    // A worker never pushes, not even through the hub
    assert.match(p.hub(['push', 'backup/main'], { extraEnv: { NEXTLEVEL_TASK_ID: 'M1-01' } }).out, /workers don't push/);
    assert.deepEqual(queued(p), []);
    // ... and by the hub: jobs written into the queue by hand (the state folder is writable by the orchestrator), and one
    // from before FR-015 with no branch, which that nextlevel took to mean main
    const craft = (id, job) => fs.writeFileSync(p.state('queue', `${id}.json`), JSON.stringify({ id, type: 'push', queuedAt: new Date().toISOString(), ...job }));
    fs.mkdirSync(p.state('queue'), { recursive: true });
    Object.keys(forms).forEach((form, i) => craft(`push-crafted-${i}`, { target: form }));
    craft('push-old', {});
    craft('push-fake-approval', { target: 'main', approval: 'G9' });
    craft('push-from-a-remote', { target: 'backup/main', from: 'origin/main' });
    // an id that would give the job a folder outside jobs/: never run, no folder
    fs.writeFileSync(p.state('queue', 'escape.json'), JSON.stringify({ id: '../../escaped-push', type: 'push', target: 'backup/escape', queuedAt: new Date().toISOString() }));
    const run = await hubRun(p);
    assert.equal(run.code, 0, run.out);
    assert.equal(fs.existsSync(path.join(p.repo, 'escaped-push')), false, 'no folder outside jobs/');
    assert.equal(fs.existsSync(p.state('queue', 'escape.json')), false);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /queue: escape\.json not run: its id "\.\.\/\.\.\/escaped-push" isn't a plain name/);
    assert.equal(remoteHead(p, 'backup/escape'), '');
    Object.entries(forms).forEach(([form, why], i) => {
      assert.equal(p.status(`push-crafted-${i}`).state, 'failed', form);
      assert.match(p.status(`push-crafted-${i}`).detail, /^not pushed: /, form);
      assert.match(p.status(`push-crafted-${i}`).detail, why, form);
    });
    assert.match(p.status('push-old').detail, /^not pushed: the job names no branch to push to \(a nextlevel from before FR-015 queued it; it pushed main whatever it was asked\)/);
    assert.match(p.status('push-fake-approval').detail, /^not pushed: G9 isn't the owner's approval of this push/);
    assert.match(p.status('push-from-a-remote').detail, /^not pushed: --from "origin\/main" names a branch through the remote origin/);
    assert.equal(remoteHead(p, 'main'), main0, "origin's main didn't move");
    assert.deepEqual(received(), [], 'nothing arrived at origin');

    // backup/main: main's commit to that branch alone
    const backup = p.hub(['push', 'backup/main']);
    assert.equal(backup.code, 0, backup.out);
    assert.match(backup.out, /^queued (push-\S+): main to backup\/main on origin\nnext: nextlevel wait \1/m);
    const backupJob = backup.out.match(/queued (push-\S+):/)[1];
    // a CI branch, from a local branch of its own
    p.git('checkout', '-q', '-b', 'ci/m1-gates');
    const ci = commit(p, 'CI: M1 gates');
    p.git('checkout', '-q', 'main');
    const ciPush = p.hub(['push', 'ci/m1-gates', '--from', 'ci/m1-gates']);
    assert.match(ciPush.out, /queued push-\S+: ci\/m1-gates to ci\/m1-gates on origin/);
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'backup/main'), main1);
    assert.equal(remoteHead(p, 'ci/m1-gates'), ci);
    assert.equal(remoteHead(p, 'main'), main0, 'main stays where it was: only the branches named moved');
    assert.equal(p.status(backupJob).state, 'done');
    assert.match(p.status(backupJob).detail, /^pushed main at \w{7} to backup\/main on origin: 2 commit\(s\), a new branch$/);
    // Logged: the source, the target, the range and who asked, in the job, hub.log and the guard's push log
    assert.match(fs.readFileSync(p.jobFile(backupJob, 'push.log'), 'utf8'), /main at \w{7} to backup\/main on origin: 2 commit\(s\) since [\d-]+, a new branch; asked by owner \(the owner's command\)/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /push done: main at \w{7} to backup\/main on origin \(a new branch, 2 commit\(s\)\) · asked by owner \(the owner's command\) · push-/);
    const logged = pushLog(p).find((e) => e.job === backupJob);
    assert.deepEqual([logged.state, logged.source, logged.by, logged.target, logged.from, logged.sha, logged.there, logged.count], ['done', "the owner's command", 'owner', 'backup/main', 'main', main1, '', 2]);
    assert.equal(pushLog(p).filter((e) => e.state === 'failed').length, Object.keys(forms).length + 3, 'the refused ones are logged too');

    // Someone else moved origin's backup/main: a push that would drop that commit is refused, never forced
    const other = path.join(p.tmp, 'other');
    p.gitIn(p.tmp, 'clone', '-q', '-b', 'backup/main', p.remote, other);
    fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
    p.gitIn(other, 'add', 'theirs.txt');
    p.gitIn(other, 'commit', '-qm', 'theirs');
    p.gitIn(other, 'push', '-q', 'origin', 'backup/main');
    const theirs = remoteHead(p, 'backup/main');
    const main2 = commit(p, 'M1: another page');
    const again = p.hub(['push', 'backup/main']);
    const againJob = again.out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(p.status(againJob).state, 'failed');
    assert.match(p.status(againJob).detail, /^not pushed: origin's backup\/main \(at \w{7}\) has commits that main at \w{7} doesn't have: pushing would drop them, and nextlevel never forces a push/);
    assert.equal(remoteHead(p, 'backup/main'), theirs);
    assert.notEqual(theirs, main2);
    everyPushThroughTheHub(p, () => received().filter(([job]) => job !== 'none'));
    assert.deepEqual(received().map(([job, ref]) => [job === 'none' ? 'the other clone' : 'nextlevel', ref]), [['nextlevel', 'refs/heads/backup/main'], ['nextlevel', 'refs/heads/ci/m1-gates'], ['the other clone', 'refs/heads/backup/main']]);
  } finally {
    p.cleanup();
  }
});

test("a deploy branch: push main makes a card with the branch, how many commits since when and the newest one's message, and the phone names the card; nothing is pushed until the owner approves on the dashboard, and then exactly that commit; never from the command line", async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  let ui;
  try {
    const received = seedOrigin(p);
    const main0 = p.git('rev-parse', 'HEAD');
    commit(p, 'M3: the sign-up form');
    const sha = commit(p, 'M3: sign-up emails');
    ownerConfig(p, (c) => ({ ...c, notifications: { server: ntfy.url } }));
    p.git('commit', '-qam', 'notifications');
    const tip = p.git('rev-parse', 'HEAD');
    const q = p.hub(['push', 'main']);
    assert.equal(q.code, 0, q.out);
    assert.match(q.out, /main is a deploy branch \(deployBranches in nextlevel\.json names it\), so nothing is pushed yet: the hub makes a card for the owner, who approves or rejects the push on the dashboard\. Only that approval pushes\./);
    const job = q.out.match(/queued (push-\S+):/)[1];
    const run = await hubRun(p, { NTFY_TOPIC: 'fr015-test-topic' });
    assert.equal(run.code, 0, run.out);
    assert.equal(remoteHead(p, 'main'), main0, 'nothing pushed');
    assert.equal(p.status(job).state, 'blocked');
    const [rec] = pushRecords(p);
    assert.equal(rec.status, 'held');
    assert.match(p.status(job).detail, new RegExp(`^not pushed yet: main is a deploy branch, so the owner approves the push first, on the dashboard \\(${rec.id}, card ${rec.card}\\): 3 commit\\(s\\) of main at ${tip.slice(0, 7)}`));
    assert.deepEqual([rec.target, rec.from, rec.sha, rec.there, rec.count], ['main', 'main', tip, main0, 3]);
    assert.equal(rec.summary[0], `Push to main on origin (${p.remote}), a deploy branch: deployBranches in nextlevel.json names it`);
    assert.match(rec.summary[1], new RegExp(`^3 commit\\(s\\) would go out, the oldest from \\d{4}-\\d\\d-\\d\\d; origin's main is at ${main0.slice(0, 7)} now$`));
    assert.match(rec.summary[2], /^The newest: \w{7} \([\d-]+\) "notifications"$/);
    assert.match(rec.diff, /^\w{7} [\d-]+ notifications\n\w{7} [\d-]+ M3: sign-up emails\n\w{7} [\d-]+ M3: the sign-up form$/);
    assert.ok(sha);
    const card = handoffCards(p).find((c) => c.id === rec.card);
    assert.equal(card.guard, rec.id);
    assert.equal(card.what, `Approve or reject: A push of 3 commit(s) to main on origin, a deploy branch (${rec.id})`);
    // The phone: a message that names the card, and says it can't be approved there
    const phone = ntfy.got.find((m) => /approve or reject a push to main/.test(m.title));
    assert.ok(phone, JSON.stringify(ntfy.got));
    assert.match(phone.message, new RegExp(`^Card ${rec.card}: A push of 3 commit\\(s\\) to main on origin, a deploy branch, since [\\d-]+\\. Nothing goes out until you decide\\. Open the dashboard \\(Notes and handoffs, card ${rec.card}\\) to see the commits and approve or reject it\\. It can't be approved from your phone\\.$`));
    // Asking again changes nothing: the same card asks
    const twice = p.hub(['push', 'main']);
    const twiceJob = twice.out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(p.status(twiceJob).state, 'blocked');
    assert.equal(pushRecords(p).length, 1);
    // Never from the command line: the card can't be done, answered or cancelled there
    for (const args of [['handoff', 'done', rec.card], ['handoff', 'reply', rec.card, 'yes, push it'], ['handoff', 'cancel', rec.card, '--reply', 'x']]) {
      const r = p.hub(args);
      assert.notEqual(r.code, 0, `${args.join(' ')}: ${r.out}`);
    }
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'main'), main0);
    // The dashboard shows it, and its Approve pushes exactly that commit
    ui = await startUi(p);
    const c = client(ui);
    const g = (await c.get('/api/cards')).json.guard.find((x) => x.id === rec.id);
    assert.deepEqual([g.kind, g.target, g.sha, g.count, g.status], ['push', 'main', tip, 3, 'held']);
    assert.equal(g.summary.length, 5);
    const state = (await c.get('/api/state')).json;
    assert.ok(state.needs.some((n) => n.kind === 'guard' && n.text === `A push of 3 commit(s) to main on origin, a deploy branch: approve or reject it (${rec.id})`), JSON.stringify(state.needs));
    // Without the dashboard's session key (FR-017 part 2A) nothing is approved and nothing pushed
    for (const headers of [{}, { 'x-nextlevel-token': ui.code }, { 'x-nextlevel-token': `${ui.token}0` }]) {
      assert.equal((await request(ui.port, { method: 'POST', path: '/api/guard', body: { action: 'approve', id: rec.id }, headers })).status, 403);
    }
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(pushRecords(p).find((x) => x.id === rec.id).status, 'held');
    assert.equal(remoteHead(p, 'main'), main0, 'nothing pushed');
    const ok = await c.post('/api/guard', { action: 'approve', id: rec.id });
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.json.message, new RegExp(`^Approved: the hub pushes exactly ${tip.slice(0, 7)} to main on origin \\(3 commit\\(s\\)\\), if origin's main is still where the card showed it`));
    assert.equal(remoteHead(p, 'main'), main0, 'the hub pushes it, not the dashboard');
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'main'), tip);
    const approved = pushLog(p).find((e) => e.state === 'done' && e.target === 'main');
    assert.deepEqual([approved.approval, approved.card, approved.by, approved.sha, approved.there, approved.count], [rec.id, rec.card, 'owner', tip, main0, 3]);
    assert.equal(approved.source, `the owner's approval on the dashboard of ${job}, which says the owner asked`);
    // (who asked is what the job says: the card never vouches for it)
    assert.equal(rec.summary[4], `The push job ${job} says it was asked by the owner, the owner's command`);
    assert.equal(pushRecords(p)[0].status, 'applied');
    assert.match(handoffCards(p).find((x) => x.id === rec.card).thread.at(-1).text, new RegExp(`^Approved: the hub pushes ${tip.slice(0, 7)} to main$`));
    everyPushThroughTheHub(p, received);
    assert.equal(received().length, 1);
  } finally {
    await stopUi(ui);
    await ntfy.close();
    p.cleanup();
  }
});

test('a push the owner rejected is never pushed, and the same push is not asked again', async () => {
  const p = makeProject();
  let ui;
  try {
    const received = seedOrigin(p);
    const main0 = p.git('rev-parse', 'HEAD');
    commit(p, 'M4: payments');
    const first = p.hub(['push', 'main']).out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    const [rec] = pushRecords(p);
    ui = await startUi(p);
    const no = await client(ui).post('/api/guard', { action: 'reject', id: rec.id, reason: 'not before the demo' });
    assert.equal(no.status, 200, no.text);
    assert.equal(no.json.message, 'Rejected: nothing was pushed to main. The orchestrator sees your answer on its card.');
    assert.equal(p.status(first).state, 'failed');
    assert.match(p.status(first).detail, new RegExp(`^not pushed: the owner rejected the push to main \\(${rec.id}, card ${rec.card}\\): "not before the demo"$`));
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'main'), main0);
    // The same push again: refused at once, no new card
    const again = p.hub(['push', 'main']).out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(p.status(again).state, 'failed');
    assert.match(p.status(again).detail, new RegExp(`^not pushed: the owner rejected exactly this push to main \\(${rec.id}, card ${rec.card}\\): "not before the demo"\\. Don't ask again unless the owner says so$`));
    assert.equal(pushRecords(p).length, 1);
    assert.equal(remoteHead(p, 'main'), main0);
    assert.deepEqual(received(), []);
    // A decided card can't be decided again
    assert.equal((await client(ui).post('/api/guard', { action: 'approve', id: rec.id })).status, 409);
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'main'), main0);
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
});

test("an approval after main moved, or after origin's main moved, pushes nothing and a new card asks again; that one's approval pushes", async () => {
  const p = makeProject();
  let ui;
  try {
    const received = seedOrigin(p);
    const main0 = p.git('rev-parse', 'HEAD');
    const a = commit(p, 'M5: step A');
    p.hub(['push', 'main']);
    assert.equal((await hubRun(p)).code, 0);
    const [g1] = pushRecords(p);
    assert.equal(g1.sha, a);
    // main moves after the card was made, then the owner approves the card
    const b = commit(p, 'M5: step B');
    ui = await startUi(p);
    const c = client(ui);
    const moved = await c.post('/api/guard', { action: 'approve', id: g1.id });
    assert.equal(moved.status, 200, moved.text);
    assert.match(moved.json.message, new RegExp(`^main moved since this card was made \\(it is at ${b.slice(0, 7)} now\\), so nothing is pushed: the hub makes a new card with what would go out now, and asks again\\.`));
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'main'), main0, 'nothing pushed: not A (the branch moved), not B (not approved)');
    const [, g2] = pushRecords(p);
    assert.equal(pushRecords(p)[0].status, 'superseded');
    assert.deepEqual([g2.status, g2.sha, g2.there, g2.count], ['held', b, main0, 2]);
    assert.match(g2.summary.at(-1), new RegExp(`^This card asks again: main moved \\(${a.slice(0, 7)} -> ${b.slice(0, 7)}\\) after you approved ${g1.id}`));
    assert.notEqual(g2.card, g1.card);
    // origin's main moves after the new card (someone pushed step A), then the owner approves it
    p.git('push', '-q', 'origin', `${a}:refs/heads/main`);
    const ok = await c.post('/api/guard', { action: 'approve', id: g2.id });
    assert.match(ok.json.message, /^Approved: the hub pushes exactly/);
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'main'), a, 'only what the test itself pushed');
    const [, , g3] = pushRecords(p);
    assert.equal(pushRecords(p)[1].status, 'superseded');
    assert.deepEqual([g3.status, g3.sha, g3.there, g3.count], ['held', b, a, 1]);
    assert.match(g3.summary.at(-1), new RegExp(`^This card asks again: origin's main moved \\(${main0.slice(0, 7)} -> ${a.slice(0, 7)}\\) after you approved ${g2.id}`));
    // Its approval pushes exactly B
    assert.equal((await c.post('/api/guard', { action: 'approve', id: g3.id })).status, 200);
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'main'), b);
    assert.equal(pushRecords(p)[2].status, 'applied');
    everyPushThroughTheHub(p, () => received().filter(([, , sha]) => sha !== a));
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
});

test('until a project sets deployBranches its base branch counts as one, and the doctor says so; a change of the list counts once it is committed, and only to add one before that', async () => {
  const p = makeProject();
  try {
    seedOrigin(p);
    const main0 = p.git('rev-parse', 'HEAD');
    assert.deepEqual(p.config().deployBranches, ['main'], 'a new project names its deploy branch');
    // Not set (and committed so): the base branch counts
    ownerConfig(p, (c) => {
      delete c.deployBranches;
      return c;
    });
    p.git('commit', '-qam', 'no deployBranches');
    const doctor = JSON.parse(p.hub(['doctor', '--json']).out);
    const row = doctor.results.find((r) => r.id === 'project.deploy-branches');
    assert.deepEqual([row.status, row.severity, row.detail], ['fail', 'info', 'not set, so the base branch main counts as one: a push to it waits for your approval on the dashboard']);
    const q = p.hub(['push', 'main']);
    assert.match(q.out, /main is a deploy branch \(it is the base branch, and nextlevel\.json doesn't set deployBranches: until it does, the base branch counts as one\)/);
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(pushRecords(p).length, 1);
    assert.equal(remoteHead(p, 'main'), main0);
    // The list on disk takes main out, not committed yet: main still counts (the committed file names it)
    ownerConfig(p, (c) => ({ ...c, deployBranches: ['production'] }));
    const stillQ = p.hub(['push', 'main']);
    assert.match(stillQ.out, /main is a deploy branch \(the committed nextlevel\.json names it, or the one there was when the orchestrator began its work: a change of the list counts once it is committed\)/);
    const still = stillQ.out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(p.status(still).state, 'blocked');
    assert.equal(remoteHead(p, 'main'), main0);
    // Committed: main is no deploy branch any more and goes out at once (the card that still asked is closed); production is
    p.git('commit', '-qam', 'deploy from production');
    const tip = p.git('rev-parse', 'HEAD');
    const now = p.hub(['push', 'main']);
    assert.doesNotMatch(now.out, /deploy branch/);
    const nowJob = now.out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(p.status(nowJob).state, 'done');
    assert.equal(remoteHead(p, 'main'), tip);
    assert.deepEqual(pushRecords(p).map((x) => x.status), ['superseded']);
    const prod = p.hub(['push', 'production']);
    assert.match(prod.out, /production is a deploy branch \(deployBranches in nextlevel\.json names it\)/);
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(remoteHead(p, 'production'), '');
    assert.equal(pushRecords(p).at(-1).target, 'production');
  } finally {
    p.cleanup();
  }
});

test('"deployBranches": [] means no deploy branch (FR-017): once it is committed main goes out without a card; an uncommitted [] asks as before', async () => {
  const p = makeProject();
  try {
    const received = seedOrigin(p);
    const main0 = p.git('rev-parse', 'HEAD');
    commit(p, 'M6: the settings page');
    // [] on disk, not committed: the committed nextlevel.json names main, so a push to it still waits for the owner
    ownerConfig(p, (c) => ({ ...c, deployBranches: [] }));
    const q = p.hub(['push', 'main']);
    assert.match(q.out, /main is a deploy branch \(the committed nextlevel\.json names it, or the one there was when the orchestrator began its work: a change of the list counts once it is committed\)/);
    const held = q.out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(p.status(held).state, 'blocked');
    assert.equal(pushRecords(p).length, 1);
    assert.equal(remoteHead(p, 'main'), main0, 'nothing pushed');
    // Committed: every source says [], so there is none (the base branch no longer stands in for an empty list)
    p.git('commit', '-qam', 'no deploy branch');
    const tip = p.git('rev-parse', 'HEAD');
    const now = p.hub(['push', 'main']);
    assert.equal(now.code, 0, now.out);
    assert.doesNotMatch(now.out, /deploy branch/);
    const job = now.out.match(/queued (push-\S+):/)[1];
    assert.equal((await hubRun(p)).code, 0);
    assert.equal(p.status(job).state, 'done', p.status(job).detail);
    assert.equal(remoteHead(p, 'main'), tip, 'main went out without a card');
    assert.deepEqual(pushRecords(p).map((x) => x.status), ['superseded'], 'no new card; the one that asked is closed');
    everyPushThroughTheHub(p, received);
    // The doctor says so, as it did
    const row = JSON.parse(p.hub(['doctor', '--json']).out).results.find((r) => r.id === 'project.deploy-branches');
    assert.equal(row.detail, 'none: deployBranches is [] in nextlevel.json, so every push goes out without asking you');
  } finally {
    p.cleanup();
  }
});

test('an older hub, which pushed main whatever a push named, gets no push job', async () => {
  const p = makeProject();
  try {
    fs.mkdirSync(p.state(), { recursive: true });
    // A hub from before FR-015 is running: its hub.json has no pushProtocol
    fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(), slots: 2, root: p.repo }));
    const r = p.hub(['push', 'backup/main']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /nothing was queued: the hub running now is an older nextlevel, which pushed the base branch whatever a push named\. Owner: stop the hub and start it again/);
    assert.deepEqual(queued(p), []);
  } finally {
    p.cleanup();
  }
});

// ---------- one push path ----------
// Nothing in src/ runs git push but the hub's pushBranch, with the arguments lib/push.mjs builds: a "push" argument for
// git, or a command line that runs git push, anywhere else fails this test. What may say "git push" is listed, each with
// why it runs nothing.
test('one push path: nothing in src/ runs git push but pushBranch, whose arguments lib/push.mjs builds', () => {
  const src = path.join(REPO, 'src');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (/\.(mjs|js)$/.test(e.name)) files.push(f);
    }
  };
  walk(src);
  const rel = (f) => path.relative(REPO, f).split(path.sep).join('/');
  const SAYS_GIT_PUSH = [
    { file: 'src/engines/rules.mjs', line: /^\s*'git push',$/, why: 'the rules that forbid it to workers and the orchestrator' },
    { file: 'src/checks/git.mjs', line: /inProject\(ctx, `git push -u origin \$\{base\}`\)/, why: 'a step the owner types themselves' },
    { file: 'src/hub.mjs', line: /^ {3}- \\`git push (\$\{BRIDGE_REMOTE\}|"\$\{remoteDir\}")/, why: "the bridge test's instructions to a worker, whose push must fail" },
    { file: 'src/locktest.mjs', line: /^ {4}pushTry\('push-/, why: "the lock test's prompts to the orchestrator's session on Antigravity, whose push must fail (it checks the remotes)" },
  ];
  // "push" as the nextlevel command's name, run by nextlevel itself: the hub's push job, so pushBranch
  const RUNS_NEXTLEVEL_PUSH = [
    { file: 'src/updater.mjs', line: /runIn\(root, fromBinOf\(p\), \['push', branch, '--from', /, why: "the update's backup push: nextlevel push, queued to the hub" },
  ];
  const used = new Set();
  const problems = [];
  let calls = [];
  for (const f of files) {
    const name = rel(f);
    if (name === 'src/lib/push.mjs') continue;
    const text = fs.readFileSync(f, 'utf8');
    text.split(/\r?\n/).forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return; // a comment
      const at = `${name}:${i + 1}`;
      // "push" as an argument of its own: only as a job's or a held change's kind, or the command's name
      for (const m of line.matchAll(/(['"`])push\1/g)) {
        const before = line.slice(0, m.index);
        const after = line.slice(m.index + m[0].length);
        const kind = /(===|!==|:)\s*$/.test(before) || /commandArgs\($/.test(before) || /^[^\]]*\]\.includes\(\w+\.kind\)/.test(after);
        if (!kind && !RUNS_NEXTLEVEL_PUSH.some((s) => s.file === name && s.line.test(line))) problems.push(`${at}: "push" as an argument: ${line.trim()}`);
      }
      // a command line that runs git push
      if (/\bgit(\.exe)?\s+(-{1,2}[\w.-]+(=\S+)?\s+)*push\b/.test(line)) {
        const ok = SAYS_GIT_PUSH.findIndex((s) => s.file === name && s.line.test(line));
        if (ok < 0) problems.push(`${at}: "git push" in code: ${line.trim()}`);
        else used.add(ok);
      }
      if (/\bpushArgs\(/.test(line) && !/^import /.test(line)) calls.push({ name, i, line });
    });
  }
  assert.deepEqual(problems, [], 'only pushBranch pushes');
  assert.deepEqual(SAYS_GIT_PUSH.filter((_, i) => !used.has(i)).map((s) => s.file), [], 'every line allowed above is still there (else take it out of the list)');
  // pushArgs is called once, in hub.mjs's pushBranch, and every push job goes there
  assert.equal(calls.length, 1, JSON.stringify(calls));
  assert.equal(calls[0].name, 'src/hub.mjs');
  const hub = fs.readFileSync(path.join(src, 'hub.mjs'), 'utf8');
  const start = hub.indexOf('\nasync function pushBranch(');
  const end = hub.indexOf('\n}\n', start);
  const call = hub.indexOf('pushArgs(', start);
  assert.ok(start > 0 && call > start && call < end, 'the call is in pushBranch');
  assert.match(hub, /\n {2}if \(job\.type === 'push'\) return runPush\(job\);\n/);
  assert.match(hub.slice(hub.indexOf('\nasync function runPush('), hub.indexOf('\nasync function pushBranch(')), /r = await pushBranch\(job\);/);
});
