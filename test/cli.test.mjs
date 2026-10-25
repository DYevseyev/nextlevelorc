// The `nextlevel` command itself: finding the project, `init`, and nextlevel.json.
//   npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { INSTALL_COMMAND } from '../src/lib/install.mjs';
import { BIN, REPO, TEST_PATH_DIRS, makeProject, makeSandbox, withEnv } from './helpers.mjs';

const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');

test('help, version, and unknown commands', () => {
  const box = makeSandbox();
  try {
    const help = box.nextlevel(['help']);
    assert.equal(help.code, 0);
    assert.match(help.out, /nextlevel init/);
    assert.match(box.nextlevel(['version']).out, /^nextlevel \d+\.\d+\.\d+/);
    const bad = box.nextlevel(['frobnicate']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /unknown command "frobnicate"/);
    const orphan = box.nextlevel(['_run', 'x'], { extraEnv: { NEXTLEVEL_ROOT: undefined } });
    assert.equal(orphan.code, 1);
    assert.match(orphan.out, /started by the hub/);
  } finally {
    box.cleanup();
  }
});

test('outside a git repository nextlevel says so and gives the exact fix', () => {
  const box = makeSandbox();
  try {
    const here = path.join(box.tmp, 'Downloads');
    fs.mkdirSync(path.join(here, 'myapp'), { recursive: true });
    box.gitIn(path.join(here, 'myapp'), 'init', '-q', '-b', 'main');
    const r = box.nextlevel(['status'], { cwd: here });
    assert.equal(r.code, 1);
    assert.match(r.out, /this folder is not inside one/);
    assert.match(r.out, /git init -b main/);
    assert.match(r.out, /cd ".*myapp"/, 'points at the project folder inside this one');
    assert.deepEqual(fs.readdirSync(here), ['myapp'], 'nothing is written');
    const missing = box.nextlevel(['--project', path.join(box.tmp, 'nope'), 'status']);
    assert.equal(missing.code, 1);
    assert.match(missing.out, /Project folder not found/);
  } finally {
    box.cleanup();
  }
});

test('the project is the git root: commands work from a subfolder and with --project from anywhere', () => {
  const p = makeProject();
  try {
    p.spec('M1-01-ok', 'node -e "0"');
    const r = p.nextlevel(['dispatch', 'M1-01-ok'], { cwd: path.join(p.repo, 'docs', 'agents') });
    assert.equal(r.code, 0, r.out);
    assert.ok(fs.existsSync(p.jobFile('M1-01-ok', 'status.json')), 'state goes to the project root');
    const s = p.nextlevel(['--project', p.repo, 'status', '--json'], { cwd: p.tmp });
    assert.equal(s.code, 0, s.out);
    assert.equal(JSON.parse(s.out).jobs[0].id, 'M1-01-ok');
    const s2 = p.nextlevel(['status', `--project=${path.join(p.repo, 'docs')}`], { cwd: p.tmp });
    assert.match(s2.out, /queued +M1-01-ok/);
  } finally {
    p.cleanup();
  }
});

test('nextlevel refuses to work in its own folder or in a worker slot', () => {
  const p = makeProject();
  try {
    const own = p.nextlevel(['status'], { cwd: REPO });
    assert.equal(own.code, 1);
    assert.match(own.out, /nextlevel tool's own folder/);
    const slot = path.join(`${p.repo}.slots`, 'w1');
    p.git('worktree', 'add', '--detach', slot, 'main');
    const r = p.nextlevel(['status'], { cwd: slot });
    assert.equal(r.code, 1);
    assert.match(r.out, /worker slot of the project/);
  } finally {
    p.cleanup();
  }
});

test('a repository without commits gets a clear message with the fix', (t) => {
  const box = makeSandbox();
  try {
    const repo = path.join(box.tmp, 'fresh');
    fs.mkdirSync(repo);
    box.gitIn(repo, 'init', '-q', '-b', 'main');
    const init = box.nextlevel(['init'], { cwd: repo });
    assert.equal(init.code, 0, init.out);
    assert.match(init.out, /no commits yet/);
    fs.writeFileSync(path.join(repo, 'docs', 'tasks', 'T1.md'), '# T1\n');
    const r = box.nextlevel(['dispatch', 'T1'], { cwd: repo });
    assert.equal(r.code, 1);
    assert.match(r.out, /no commits yet/);
    assert.match(r.out, /git commit -m "first commit"/);
    // The suite's first doctor run: its slowest checks go to the test log (a cold tool shows up here)
    const started = Date.now();
    const json = JSON.parse(box.nextlevel(['doctor', '--json'], { cwd: repo }).out);
    const slow = [...json.results].sort((x, y) => (y.ms || 0) - (x.ms || 0)).slice(0, 3);
    t.diagnostic(`doctor took ${Date.now() - started} ms; slowest checks: ${slow.map((x) => `${x.id} ${x.ms} ms`).join(', ')}`);
    assert.equal(json.results.find((x) => x.id === 'git.commits').detail, 'none yet');
    const doctor = box.nextlevel(['doctor'], { cwd: repo });
    assert.match(doctor.out, /!! +Commits +none yet/);
    assert.match(doctor.out, / ok +Branch +main/, 'an unborn branch still has its name');
    assert.equal(doctor.code, 1, 'no commits is an error');

    // The doctor offers the first commit (FR-001 #2); a secret in .env stays out of it
    fs.writeFileSync(path.join(repo, '.env'), 'NTFY_TOPIC=\nAPI_KEY=hunter2\n');
    const fixed = box.nextlevel(['doctor', '--fix'], { cwd: repo });
    assert.match(fixed.out, /Made the first commit \(\d+ files\)/, fixed.out);
    assert.match(fixed.out, / ok +Commits +yes/);
    assert.equal(box.gitIn(repo, 'log', '--format=%s'), 'first commit');
    assert.doesNotMatch(box.gitIn(repo, 'ls-files'), /^\.env$/m, '.env is never committed');
    assert.ok(box.gitIn(repo, 'ls-files').split('\n').includes('docs/tasks/T1.md'));
  } finally {
    box.cleanup();
  }
});

test('the doctor works outside a project: it checks the tools and says where the project should be (FR-001 #1)', () => {
  const box = makeSandbox();
  try {
    const here = path.join(box.tmp, 'files', 'acme-starter');
    fs.mkdirSync(here, { recursive: true });
    const r = box.nextlevel(['doctor'], { cwd: here });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /!! +Project +this folder is not inside a git repository/);
    assert.match(r.out, /git init -b main/);
    assert.match(r.out, / ok +Codex CLI +codex-cli 0\.152\.0/, 'the tools are still checked');
    assert.doesNotMatch(r.out, /Commits|Bridge test/, 'project checks are left out');
    const json = JSON.parse(box.nextlevel(['doctor', '--json'], { cwd: here }).out);
    assert.equal(json.project, null);
    assert.equal(json.results.find((x) => x.id === 'project.folder').status, 'fail');
  } finally {
    box.cleanup();
  }
});

test('init adds the team files and nextlevel.json, and never replaces a file without asking', () => {
  const box = makeSandbox();
  try {
    const repo = path.join(box.tmp, 'app');
    fs.mkdirSync(repo);
    box.gitIn(repo, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# My own rules\n\nBe nice.\n');

    const first = box.nextlevel(['init'], { cwd: repo });
    assert.equal(first.code, 0, first.out);
    for (const f of ['nextlevel.json', 'BRIEF.md', 'START.cmd', '.env.example', 'docs/agents/WORKER.md', 'docs/tasks/_TEMPLATE.md', 'docs/STATUS.md', 'docs/PROJECT.md', 'docs/DECISIONS.md']) {
      assert.ok(fs.existsSync(path.join(repo, f)), `${f} should be created`);
    }
    const cfg = JSON.parse(read(repo, 'nextlevel.json'));
    assert.equal(cfg.roles.orchestrator.engine, 'codex');
    assert.equal(cfg.roles.worker.engine, 'agy');
    assert.equal(cfg.workers.slots, 2);
    assert.equal(cfg.baseBranch, 'main');
    assert.equal(cfg.name, 'app');

    // An existing file that differs is shown as a diff, and kept when nobody says yes
    assert.match(first.out, /AGENTS\.md differs from the template/);
    assert.match(first.out, /- # My own rules/);
    assert.match(first.out, /\+ # AGENTS\.md/);
    assert.match(first.out, /Kept +AGENTS\.md/);
    assert.equal(read(repo, 'AGENTS.md'), '# My own rules\n\nBe nice.\n');

    // .gitignore keeps its lines and gains the ones that protect secrets and state
    const ignore = read(repo, '.gitignore');
    assert.match(ignore, /^node_modules\/$/m);
    for (const line of ['.env', '.nextlevel/', '.nextlevel-task/']) assert.ok(ignore.split('\n').includes(line), line);
    box.gitIn(repo, 'check-ignore', '-q', '.env');
    box.gitIn(repo, 'check-ignore', '-q', '.nextlevel/jobs/x/status.json');

    // The project's own documents are never offered for replacement; "y" replaces AGENTS.md
    fs.writeFileSync(path.join(repo, 'docs', 'STATUS.md'), '# Status\n\nOurs.\n');
    fs.writeFileSync(path.join(repo, 'docs', 'PROJECT.md'), '# Project\n\n## What it is\nOurs.\n');
    const second = box.nextlevel(['init'], { cwd: repo, input: 'y\n' });
    assert.equal(second.code, 0, second.out);
    assert.doesNotMatch(second.out, /STATUS\.md differs/);
    assert.equal(read(repo, 'docs', 'STATUS.md'), '# Status\n\nOurs.\n');
    assert.doesNotMatch(second.out, /PROJECT\.md differs/, "the orchestrator's project page is the project's own too");
    assert.equal(read(repo, 'docs', 'PROJECT.md'), '# Project\n\n## What it is\nOurs.\n');
    assert.match(second.out, /Replaced +AGENTS\.md/);
    assert.equal(read(repo, 'AGENTS.md'), read(REPO, 'templates', 'project', 'AGENTS.md'));

    // Nothing left to do on a third run
    const third = box.nextlevel(['init'], { cwd: repo });
    assert.doesNotMatch(third.out, /differs|Created|Replaced|now ignores/);
    assert.equal(read(repo, '.gitignore'), ignore);
  } finally {
    box.cleanup();
  }
});

test('init never offers to replace a .env.example the project has changed (FR-005); an unchanged older template it does', () => {
  const box = makeSandbox();
  try {
    const repo = path.join(box.tmp, 'older');
    fs.mkdirSync(repo);
    box.gitIn(repo, 'init', '-q', '-b', 'main');
    const own = '# Acme\nSTRIPE_SECRET=\nSMTP_PASSWORD=\n';
    fs.writeFileSync(path.join(repo, '.env.example'), own);
    const r = box.nextlevel(['init'], { cwd: repo, input: 'y\ny\ny\n' });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /\.env\.example differs|Replace \.env\.example/);
    assert.equal(read(repo, '.env.example'), own, 'the project\'s own keys stay');
    assert.match(r.out, /\.env\.example is the project's own, so init leaves it alone\. It has no NTFY_TOPIC line/);

    // The first kit's template, unchanged: nothing of the project's in it, so init offers the current one
    fs.copyFileSync(path.join(REPO, 'test', 'fixtures', 'env.example-kit'), path.join(repo, '.env.example'));
    const again = box.nextlevel(['init'], { cwd: repo, input: 'y\n' });
    assert.match(again.out, /\.env\.example differs from the template/);
    assert.equal(read(repo, '.env.example'), read(REPO, 'templates', 'project', '.env.example'));

    // What FR-005 left behind: the template, committed over the project's own. The doctor puts it back.
    fs.writeFileSync(path.join(repo, '.env.example'), own);
    box.gitIn(repo, 'add', '-A');
    box.gitIn(repo, 'commit', '-qm', 'own .env.example');
    fs.copyFileSync(path.join(REPO, 'templates', 'project', '.env.example'), path.join(repo, '.env.example'));
    box.gitIn(repo, 'commit', '-qam', 'chore: set up nextlevel');
    const doctor = box.nextlevel(['doctor'], { cwd: repo });
    assert.match(doctor.out, /!! +\.env\.example +nextlevel's template replaced the project's own \(FR-005\); commit [0-9a-f]{7} /);
    const fixedRun = box.nextlevel(['doctor', '--fix', 'project.env-example'], { cwd: repo });
    assert.match(fixedRun.out, /Put back the project's own \.env\.example from commit/);
    assert.equal(read(repo, '.env.example').replace(/\r\n/g, '\n'), own);
  } finally {
    box.cleanup();
  }
});

test('init carries the settings of an older .env into nextlevel.json, and leaves secrets in .env', () => {
  const box = makeSandbox();
  try {
    const repo = path.join(box.tmp, 'older');
    fs.mkdirSync(repo);
    box.gitIn(repo, 'init', '-q', '-b', 'main');
    const env = 'NTFY_TOPIC=secret-topic-123\nNEXTLEVEL_WORKER_SLOTS=3\nCODEX_MODEL=gpt-test\nAGY_ARGS=--dangerously-skip-permissions --effort low\nNEXTLEVEL_BASE_BRANCH=trunk\n';
    fs.writeFileSync(path.join(repo, '.env'), env);
    const r = box.nextlevel(['init'], { cwd: repo });
    assert.equal(r.code, 0, r.out);
    const cfg = JSON.parse(read(repo, 'nextlevel.json'));
    assert.equal(cfg.workers.slots, 3);
    assert.equal(cfg.roles.orchestrator.model, 'gpt-test');
    assert.deepEqual(cfg.engines.agy.args, ['--dangerously-skip-permissions', '--effort', 'low']);
    assert.equal(cfg.baseBranch, 'trunk');
    assert.match(r.out, /Copied these settings from \.env into nextlevel\.json: .*NEXTLEVEL_WORKER_SLOTS/);
    assert.doesNotMatch(read(repo, 'nextlevel.json'), /secret-topic/);
    assert.equal(read(repo, '.env'), env, '.env is never changed');
  } finally {
    box.cleanup();
  }
});

test('problems in nextlevel.json are reported with the file and the setting', () => {
  const p = makeProject();
  const file = path.join(p.repo, 'nextlevel.json');
  try {
    fs.writeFileSync(file, '{ "workers": { "slots": 2, } }');
    const broken = p.hub(['status']);
    assert.equal(broken.code, 1);
    assert.match(broken.out, /nextlevel\.json is not valid JSON/);

    // (any engine can orchestrate since M6: an engine nextlevel doesn't know can't)
    fs.writeFileSync(file, JSON.stringify({ version: 1, workers: { slots: 9 }, roles: { orchestrator: { engine: 'gemini' } }, paths: { tasks: '../elsewhere' } }));
    const bad = p.hub(['status']);
    assert.equal(bad.code, 1);
    for (const key of ['workers.slots', 'roles.orchestrator.engine', 'paths.tasks']) assert.match(bad.out, new RegExp(key.replaceAll('.', '\\.')));

    // Unknown settings only warn (the doctor lists them), and a byte-order mark from Notepad is fine
    fs.writeFileSync(file, `﻿${JSON.stringify({ version: 1, colour: 'blue', $comment: 'notes are fine' })}`);
    assert.equal(p.hub(['status']).code, 0);
    assert.match(p.hub(['doctor']).out, /!! +nextlevel\.json +unknown setting "colour"/);
  } finally {
    p.cleanup();
  }
});

test(
  "on Windows the project's START.cmd starts the installed tool",
  { skip: process.platform !== 'win32' && 'START.cmd is for Windows' },
  () => {
    const p = makeProject();
    try {
      const start = (env) => spawnSync('cmd.exe', ['/d', '/c', 'START.cmd', 'status'], { cwd: p.repo, env, encoding: 'utf8', input: '', timeout: 60_000 });
      // `nextlevel` on PATH (what npm link or the installer provide)
      const onPath = start(p.env);
      assert.equal(onPath.status, 0, onPath.stdout + onPath.stderr);
      assert.match(onPath.stdout, /Hub: stopped/);
      // Not on PATH, but installed where the installer puts it (%USERPROFILE%\.nextlevel\tool)
      const tool = path.join(p.env.USERPROFILE, '.nextlevel', 'tool', 'bin');
      fs.mkdirSync(tool, { recursive: true });
      fs.writeFileSync(path.join(tool, 'nextlevel.mjs'), `await import(${JSON.stringify(pathToFileURL(BIN).href)});\n`);
      const installed = start(withEnv(p.env, { PATH: TEST_PATH_DIRS.join(path.delimiter) }));
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      assert.match(installed.stdout, /Hub: stopped/);
      // Not installed: it says so, with the install command to paste into PowerShell
      const nowhere = path.join(p.tmp, 'another-user');
      fs.mkdirSync(nowhere);
      const none = start(withEnv(p.env, { PATH: TEST_PATH_DIRS.join(path.delimiter), USERPROFILE: nowhere }));
      assert.equal(none.status, 1, none.stdout + none.stderr);
      assert.ok(none.stdout.includes(`  ${INSTALL_COMMAND}\r\n`), none.stdout);
      assert.match(none.stdout, /iex\r\nThen run START\.cmd again\.\r\n/, 'a public repository: no GitHub CLI needed');
    } finally {
      p.cleanup();
    }
  },
);
