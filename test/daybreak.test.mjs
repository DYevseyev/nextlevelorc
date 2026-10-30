// Security engineer 1b-1: the standard pin. Every Codex run nextlevel starts but the scans gets `-c daybreak=false` last
// among its overrides on Codex 0.163 or newer, and `-c profiles.<name>.daybreak=false` after it when the run picks a
// Codex profile; with the stub Codex playing Daybreak as 0.164 takes it (config.toml's daybreak = true, a model it
// doesn't cover failing at once: STUB_CODEX_VERSION, STUB_CODEX_NO_DAYBREAK).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import http from 'node:http';
import { engine, sessionArgs, standardPin } from '../src/engines/index.mjs';
import { codexDaybreakOn, codexProfileOf, codexStandardPin } from '../src/engines/codex.mjs';
import { droppedModel, readWatch, seenNews, untold, watchDue, watchWords, withAnswer, withTold } from '../src/lib/daybreakwatch.mjs';
import { DIGEST } from '../src/lib/securityimage.mjs';
import { accountKey } from '../src/lib/securityspec.mjs';
import { processStartSync } from '../src/lib/proctree.mjs';
import { REPO, fileExists, makeProject, testClock } from './helpers.mjs';
import { client, request, startUi, stopUi } from './ui-helpers.mjs';

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

const NEW = 'codex-cli 0.164.0';
// The `-c` settings of a command line, in order
const overrides = (args) => args.flatMap((a, i) => (args[i - 1] === '-c' ? [a] : []));
const lastFor = (args, key) => overrides(args).filter((o) => o.startsWith(`${key}=`)).at(-1);

test('the pin: from Codex 0.163, last among the overrides, with the profile a run picks', () => {
  assert.deepEqual(codexStandardPin({ version: 'codex-cli 0.162.9' }), [], 'no Daybreak setting before 0.163');
  assert.deepEqual(codexStandardPin({ version: '' }), [], 'a version that can\'t be read: none');
  assert.deepEqual(codexStandardPin({ version: 'codex-cli 0.163.0' }), ['-c', 'daybreak=false']);
  assert.deepEqual(standardPin({ engine: 'agy' }, { version: NEW }), [], 'only Codex has one');
  assert.deepEqual(standardPin({ engine: 'claude' }, { version: NEW }), []);
  // The profile a run picks: its own arguments win (the last), else config.toml's top-level profile
  assert.equal(codexProfileOf(['-p', 'a', '--profile', 'b']), 'b');
  assert.equal(codexProfileOf(['--profile=c']), 'c');
  assert.equal(codexProfileOf(['-c', 'profile="d"']), 'd');
  assert.equal(codexProfileOf([], () => 'profile = "e"\n[profiles.e]\n'), 'e');
  assert.equal(codexProfileOf(['-p', 'f'], () => 'profile = "e"\n'), 'f');
  assert.equal(codexProfileOf([], () => 'model = "x"\n[x]\nprofile = "no"\n'), '', 'only the top level');
  assert.deepEqual(codexStandardPin({ version: NEW, args: ['-p', 'work'] }), ['-c', 'daybreak=false', '-c', 'profiles.work.daybreak=false']);
  assert.deepEqual(codexStandardPin({ version: NEW, args: ['-p', 'my work'] }), ['-c', 'daybreak=false'], 'a name the pin can\'t name: the doctor warns');
  // config.toml read for its top-level profile only, in the account's own folder
  const read = (f) => (f === path.join('/h', '.codex', 'config.toml') ? 'profile = "sec"\n' : '');
  assert.deepEqual(standardPin({ engine: 'codex' }, { version: NEW, home: '/h', env: {}, read }), ['-c', 'daybreak=false', '-c', 'profiles.sec.daybreak=false']);
  // The doctor's reading of config.toml
  assert.equal(codexDaybreakOn('daybreak = true\n'), true);
  assert.equal(codexDaybreakOn('daybreak = false\n'), false);
  assert.equal(codexDaybreakOn('[x]\ndaybreak = true\n'), false);
  assert.equal(codexDaybreakOn('profile = "p"\n[profiles.p]\ndaybreak = true\n'), true);
  assert.equal(codexDaybreakOn('profile = "q"\n[profiles.p]\ndaybreak = true\n'), false);
  assert.equal(codexDaybreakOn("profile = 'p'\n[profiles.\"p\"]\ndaybreak = true # on\n"), true);

  // Every kind of session: the pin comes after the owner's arguments (a -c daybreak=true and a profile there too) and
  // the worker's own settings, so the last daybreak override is false; the prompt stays last
  const owner = ['--sandbox', 'workspace-write', '-c', 'daybreak=true', '--profile', 'p'];
  for (const [mode, role] of [['headless', 'worker'], ['headless', 'orchestrator'], ['interactive', 'orchestrator'], ['interactive', 'guide']]) {
    const args = sessionArgs({ engine: 'codex', model: 'gpt-6-astra' }, { mode, role, prompt: 'P', args: owner, extra: mode === 'interactive' ? ['--no-daemon'] : [], version: NEW });
    assert.equal(lastFor(args, 'daybreak'), 'daybreak=false', `${mode} ${role}: ${args.join(' ')}`);
    assert.equal(lastFor(args, 'profiles.p.daybreak'), 'profiles.p.daybreak=false', `${mode} ${role}`);
    assert.deepEqual(overrides(args).slice(-2), ['daybreak=false', 'profiles.p.daybreak=false'], `${mode} ${role}: both last`);
    assert.equal(args.at(-1), 'P');
    const old = sessionArgs({ engine: 'codex' }, { mode, role, prompt: 'P', args: owner, version: 'codex-cli 0.152.0' });
    assert.ok(!overrides(old).includes('daybreak=false'), `${mode} ${role}: none before 0.163`);
  }
  // agy and Claude Code sessions get nothing
  for (const name of ['agy', 'claude']) {
    const args = sessionArgs({ engine: name }, { mode: 'headless', role: 'worker', prompt: 'P', args: [], version: NEW });
    assert.ok(!args.some((a) => /daybreak/.test(a)), name);
  }
  assert.equal(typeof engine('codex').standardPin, 'function');
});

// Every place in src/ that builds a Codex command line gets the pin: sessionArgs (the orchestrator's window and rounds,
// the guide, workers, the trial and bridge test through workerRun) with the engine's version, the advisor's readOnly and
// the model check's probe. A new one fails here until it does too.
test('every Codex command line nextlevel builds carries the pin', () => {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f);
      else if (f.endsWith('.mjs')) files.push(f);
    }
  };
  walk(path.join(REPO, 'src'));
  const sites = [];
  for (const f of files) {
    const rel = path.relative(REPO, f).split(path.sep).join('/');
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (/^\s*\/\//.test(line)) return;
      if (/\bsessionArgs\(/.test(line) && !/export function sessionArgs/.test(line)) sites.push({ rel, line, kind: 'session' });
      if (/\.readOnly\(/.test(line)) sites.push({ rel, line, kind: 'readOnly' });
      if (/\['exec'/.test(line) && rel !== 'src/engines/codex.mjs') sites.push({ rel, line, kind: 'exec' });
      if (/\.(headless|interactive)\(/.test(line)) sites.push({ rel, line, kind: 'builder' });
    });
  }
  assert.ok(sites.length >= 6, JSON.stringify(sites));
  for (const s of sites) {
    if (s.kind === 'session') assert.match(s.line, /\bversion\b/, `${s.rel}: a sessionArgs call without the engine's version: ${s.line.trim()}`);
    else if (s.kind === 'builder') assert.fail(`${s.rel}: builds a session's arguments outside sessionArgs: ${s.line.trim()}`);
    else assert.match(s.line, /\bpin\b/, `${s.rel}: a Codex command line without the pin: ${s.line.trim()}`);
  }
  // The builder itself: the pin after isolation's and the caller's extra
  const index = fs.readFileSync(path.join(REPO, 'src', 'engines', 'index.mjs'), 'utf8');
  assert.match(index, /extra: \[\.\.\.\(isolation\?\.args \|\| \[\]\), \.\.\.extra, \.\.\.standardPin\(profile, \{ version, args: \[\.\.\.args, \.\.\.extra\] \}\)\]/);
});

test("a Codex worker on a model Daybreak doesn't cover works though config.toml turns Daybreak on, with the pin last", () => {
  const p = makeProject();
  const log = path.join(p.tmp, 'codex-args.log');
  try {
    fs.mkdirSync(path.join(p.env.HOME, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(p.env.HOME, '.codex', 'config.toml'), 'daybreak = true\n');
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { ...c.roles.worker, engine: 'codex', model: 'gpt-6-astra' } } }));
    const spec = (id) => {
      fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', `${id}.md`), `# ${id} — test\n\nKind: code\n\n## Goal\nTest.\n\n## Verify\n\`\`\`sh\n${fileExists('ok.mjs')}\n\`\`\`\n`);
    };
    spec('M1-01-pin-ok');
    assert.equal(p.hub(['dispatch', 'M1-01-pin-ok']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log, STUB_CODEX_VERSION: '0.164.0' } });
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const worker = calls.find((a) => a[0] === 'exec' && a.at(-1).includes('ROLE: WORKER. Task M1-01-pin-ok.'));
    assert.ok(worker, JSON.stringify(calls.map((a) => a.slice(0, 3))));
    assert.equal(lastFor(worker, 'daybreak'), 'daybreak=false');
    assert.equal(overrides(worker).at(-1), 'daybreak=false', 'last among its overrides');
    assert.equal(p.status('M1-01-pin-ok').state, 'done', p.status('M1-01-pin-ok').detail || '');
    assert.match(fs.readFileSync(p.jobFile('M1-01-pin-ok', 'worker.log'), 'utf8'), /OpenAI's Daybreak off for this run \(-c daybreak=false\), whatever Codex's config\.toml says/, 'its log says so');
    // Without the pin (a Codex before 0.163 has no Daybreak: the stub plays it off), the same model works too, and no -c
    // daybreak is passed
    spec('M1-02-old-ok');
    fs.writeFileSync(log, '');
    assert.equal(p.hub(['dispatch', 'M1-02-old-ok']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_CODEX_LOG: log } });
    const old = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((a) => a[0] === 'exec' && a.at(-1).includes('M1-02-old-ok'));
    assert.ok(old && !old.includes('daybreak=false'));
    assert.equal(p.status('M1-02-old-ok').state, 'done');
  } finally {
    p.cleanup();
  }
});

// ---------- the Daybreak model watch (lib/daybreakwatch.mjs, `_daybreak` in src/security.mjs) ----------
const D = `sha256:${'a'.repeat(64)}`;
const T0 = Date.parse('2026-10-29T08:00:00Z');
const models = (...covered) => ({ ok: true, models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-quiet'].map((id) => ({ id, programs: id === 'gpt-quiet' ? null : covered.includes(id) ? ['standard', 'daybreak_blue'] : ['standard'] })) });

test('the watch, pure: when it asks, what is news, what a project makes of it, and the phone once', () => {
  assert.equal(watchDue({}, { now: T0, digest: D }), true, 'never asked');
  let r = withAnswer({}, models('gpt-6-sol'), { now: T0, digest: D });
  assert.deepEqual([r.ok, r.covered, r.news], [true, ['gpt-6-sol'], []], 'the first answer: no news');
  assert.equal(watchDue(r, { now: T0 + 23 * 3600_000, digest: D }), false);
  assert.equal(watchDue(r, { now: T0 + 24 * 3600_000, digest: D }), true, 'a day later');
  assert.equal(watchDue(r, { now: T0 + 60_000, digest: `sha256:${'b'.repeat(64)}` }), true, 'another image: at once');
  // A newly covered model is news, once; "unconfirmed" (no programs listed) never counts
  r = withAnswer(r, models('gpt-6-sol', 'gpt-6-astra'), { now: T0 + 24 * 3600_000, digest: D });
  assert.deepEqual(r.news.map((n) => n.model), ['gpt-6-astra']);
  assert.ok(!r.covered.includes('gpt-quiet'));
  r = withAnswer(r, models('gpt-6-sol', 'gpt-6-astra'), { now: T0 + 48 * 3600_000, digest: D });
  assert.deepEqual(r.news.map((n) => n.model), ['gpt-6-astra'], 'still one');
  const tell = untold(r, { account: 'acc' });
  assert.deepEqual(tell.map((x) => x.key), ['new:acc:gpt-6-astra']);
  assert.match(tell[0].text, /Daybreak Blue now covers gpt-6-astra .*nextlevel never switches by itself/);
  r = withTold(r, tell.map((x) => x.key));
  assert.deepEqual(untold(r, { account: 'acc' }), [], 'the phone hears it once');
  assert.deepEqual(seenNews(r, 'gpt-6-astra').news, [], 'Seen clears it');
  // A chosen model no longer covered: the project's own part, said once too, and again only after it came back
  const role = { daybreak: true, model: 'gpt-6-sol' };
  assert.equal(droppedModel(r, role), '');
  r = withAnswer(r, models('gpt-6-astra'), { now: T0 + 72 * 3600_000, digest: D });
  assert.equal(droppedModel(r, role), 'gpt-6-sol');
  assert.equal(droppedModel(r, { daybreak: false, model: 'gpt-6-sol' }), '', 'Daybreak off: nothing to lose');
  const drop = untold(r, { account: 'acc', dropped: 'gpt-6-sol', project: 'proj' });
  assert.deepEqual(drop.map((x) => x.key), ['dropped:acc:gpt-6-sol']);
  assert.match(drop[0].text, /^proj: the security engineer's model gpt-6-sol no longer takes Daybreak Blue, so its next scan won't start/);
  r = withTold(r, ['dropped:acc:gpt-6-sol']);
  r = withAnswer(r, models('gpt-6-sol', 'gpt-6-astra'), { now: T0 + 96 * 3600_000, digest: D });
  assert.ok(!r.told.includes('dropped:acc:gpt-6-sol'), 'it came back: a later drop is told again');
  // Even on the first answer, a chosen model it doesn't cover is said
  assert.equal(droppedModel(withAnswer({}, models('gpt-6-luna'), { now: T0, digest: D }), role), 'gpt-6-sol');
  // Failed tries: an hour apart, then a day after three in a row
  let f = withAnswer(r, { ok: false, why: 'Cannot connect to the Docker daemon' }, { now: T0, digest: D });
  assert.deepEqual([f.ok, f.fails, f.covered], [false, 1, ['gpt-6-sol', 'gpt-6-astra']], 'what it knew stays');
  assert.equal(watchDue(f, { now: T0 + 59 * 60_000, digest: D }), false);
  assert.equal(watchDue(f, { now: T0 + 60 * 60_000, digest: D }), true);
  f = withAnswer(withAnswer(f, { ok: false, why: 'x' }, { now: T0, digest: D }), { ok: false, why: 'x' }, { now: T0, digest: D });
  assert.equal(f.fails, 3);
  assert.equal(watchDue(f, { now: T0 + 2 * 3600_000, digest: D }), false, 'after three: daily');
  assert.equal(watchDue(f, { now: T0 + 24 * 3600_000, digest: D }), true);
  assert.match(watchWords(f, role, { now: T0 + 3600_000 }).text, /couldn't ask: x\. After 3 tries in a row it asks once a day/);
  // The record's shape check
  assert.deepEqual(readWatch({ covered: ['ok-1', 'bad id', 7], news: [{ kind: 'new', model: '<b>' }], fails: -2 }), { at: '', tried: '', digest: '', ok: false, why: '', fails: 0, models: [], covered: ['ok-1'], news: [], told: [] });
});

function watchProject() {
  const p = makeProject();
  p.setConfig((c) => ({ ...c, roles: { ...c.roles, security: { engine: 'codex', model: 'gpt-6-sol', effort: '', profile: '', daybreak: true } } }));
  p.git('commit', '-qam', 'the security engineer on');
  assert.equal(p.hub(['security', 'login']).code, 0);
  return p;
}
const watchRecord = (p) => JSON.parse(fs.readFileSync(path.join(p.env.HOME, '.nextlevel', 'security', 'daybreak-watch', `${accountKey('')}.json`), 'utf8'));
const modelRuns = (p) => {
  try {
    return fs.readFileSync(path.join(p.env.HOME, '.fake-docker', 'seen.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.args.includes('debug') && r.args.includes('models')).length;
  } catch {
    return 0;
  }
};
const exited = (child) => new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('exit', resolve)));
const STUB_MODELS = (...covered) => JSON.stringify({ models: ['gpt-6-sol', 'gpt-6-astra'].map((slug) => ({ slug, visibility: 'list', available_access_programs: { cyber: covered.includes(slug) ? ['standard', 'daybreak_blue'] : ['standard'] } })) });

test('the watch through the hub: once a day under the lease, news once to the phone, Seen, a dropped model, and never beside a scan', async () => {
  const p = watchProject();
  const ntfy = await fakeNtfy();
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    const clock = testClock(p, '2026-10-29T08:00:00Z');
    const run = (extra = {}) => exited(p.hubInBackground(['run', '--exit-when-idle', '--tick-ms', '200'], { ...clock.env, NTFY_TOPIC: 'a-long-random-topic-for-tests-1234', ...extra }));
    const before = modelRuns(p);
    await run({ STUB_DOCKER_MODELS: STUB_MODELS('gpt-6-sol') });
    let r = watchRecord(p);
    assert.deepEqual([r.ok, r.covered, r.news], [true, ['gpt-6-sol'], []]);
    assert.equal(r.digest, DIGEST);
    assert.equal(modelRuns(p), before + 1, 'one look');
    assert.ok(!fs.existsSync(path.join(p.env.HOME, '.nextlevel', 'security-lease.json')), 'the lease given back');
    assert.deepEqual(ntfy.got, [], 'the first answer tells nothing');
    // An hour later: not asked again
    clock.add(60);
    await run({ STUB_DOCKER_MODELS: STUB_MODELS('gpt-6-sol', 'gpt-6-astra') });
    assert.equal(modelRuns(p), before + 1);
    // A day later: Astra is covered now. News, one phone message, a line on Home's Security card
    clock.add(24 * 60);
    await run({ STUB_DOCKER_MODELS: STUB_MODELS('gpt-6-sol', 'gpt-6-astra') });
    r = watchRecord(p);
    assert.deepEqual(r.news.map((n) => n.model), ['gpt-6-astra']);
    assert.equal(ntfy.got.length, 1, JSON.stringify(ntfy.got));
    assert.match(ntfy.got[0].message, /Daybreak Blue now covers gpt-6-astra/);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /Daybreak watch: Blue covers gpt-6-sol, gpt-6-astra \(new: gpt-6-astra\)/);
    // The hub again: no second message (once per PC, whichever hub looks)
    clock.add(1);
    await run();
    assert.equal(ntfy.got.length, 1);
    // Home's Security card has it; Seen clears it (the dashboard's key only)
    const ui = await startUi(p, clock.env);
    try {
      const c = client(ui);
      const home = (await c.get('/api/state')).json.security;
      assert.deepEqual(home.daybreak.news, ['gpt-6-astra']);
      assert.deepEqual(home.daybreak.covered, ['gpt-6-sol', 'gpt-6-astra']);
      assert.match(home.daybreak.text, /^Daybreak Blue covers gpt-6-sol, gpt-6-astra on this sign-in \(checked /);
      assert.equal((await request(ui.port, { method: 'POST', path: '/api/security', body: { action: 'daybreak-seen', model: 'gpt-6-astra' } })).status, 403);
      assert.equal((await c.post('/api/security', { action: 'daybreak-seen', model: '<b>' })).status, 400);
      const seen = await c.post('/api/security', { action: 'daybreak-seen', model: 'gpt-6-astra' });
      assert.equal(seen.status, 200, JSON.stringify(seen.json));
      assert.deepEqual(watchRecord(p).news, []);
      assert.deepEqual((await c.get('/api/state')).json.security.daybreak.news, []);
    } finally {
      stopUi(ui);
    }
    // The chosen model is dropped: the next day, the project hears it once
    clock.add(24 * 60);
    await run({ STUB_DOCKER_MODELS: STUB_MODELS('gpt-6-astra') });
    assert.equal(ntfy.got.length, 2, JSON.stringify(ntfy.got.map((m) => m.message)));
    assert.match(ntfy.got[1].message, /the security engineer's model gpt-6-sol no longer takes Daybreak Blue, so its next scan won't start/);
    // Never beside a scan or another holder of the lease: a day later, with the lease held, nothing is asked
    clock.add(24 * 60);
    const lease = path.join(p.env.HOME, '.nextlevel', 'security-lease.json');
    fs.writeFileSync(lease, JSON.stringify({ root: '/elsewhere/other', pid: process.pid, start: processStartSync(process.pid), scan: 'sec-20261029-120000-abcd' }));
    const runs = modelRuns(p);
    await run({ STUB_DOCKER_MODELS: STUB_MODELS('gpt-6-astra') });
    assert.equal(modelRuns(p), runs, 'no look while the lease is held');
    fs.rmSync(lease);
    // Docker stopped: a failed try, said, no card and no phone message; an hour later it asks again
    await run({ STUB_DOCKER: 'stopped' });
    r = watchRecord(p);
    assert.deepEqual([r.ok, r.fails], [false, 1]);
    assert.equal(ntfy.got.length, 2);
  } finally {
    await ntfy.close();
    p.cleanup();
  }
});
