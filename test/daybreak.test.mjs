// Security engineer 1b-1: the standard pin. Every Codex run nextlevel starts but the scans gets `-c daybreak=false` last
// among its overrides on Codex 0.163 or newer, and `-c profiles.<name>.daybreak=false` after it when the run picks a
// Codex profile; with the stub Codex playing Daybreak as 0.164 takes it (config.toml's daybreak = true, a model it
// doesn't cover failing at once: STUB_CODEX_VERSION, STUB_CODEX_NO_DAYBREAK).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { engine, sessionArgs, standardPin } from '../src/engines/index.mjs';
import { codexDaybreakOn, codexProfileOf, codexStandardPin } from '../src/engines/codex.mjs';
import { REPO, fileExists, makeProject } from './helpers.mjs';

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
