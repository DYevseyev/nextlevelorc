// Unit tests for the setup checks (src/checks/), each against a fake PC (test/fake-context.mjs).
// The last tests make sure every registered check is covered here and every step names its window.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { CHECKS, byId, loadProjectChecks, runCheck, runChecks, validateCheck } from '../src/checks/index.mjs';
import { brokenCommand, hooksFromJson, hooksFromToml, shellWords } from '../src/checks/codex-hooks.mjs';
import { AGY_PROBE, mcpServers, githubRepo, MODEL_PROBE, tomlTop, withoutOverrides } from '../src/checks/engines.mjs';
import { OLD_TEMPLATES, templateHash } from '../src/checks/project.mjs';
import { ENV_EXAMPLE_TEMPLATES, isEnvExampleTemplate } from '../src/lib/templates.mjs';
import { WINDOWS, parseVersion, versionAtLeast } from '../src/checks/lib.mjs';
import { INSTALL_COMMAND } from '../src/lib/install.mjs';
import { DENY } from '../src/checks/safety.mjs';
import { doctorOptions, formatResults } from '../src/doctor.mjs';
import { TOOLS } from '../src/checks/tools.mjs';
import { projectKey } from '../src/lib/guard.mjs';
import { buildRoadmap, parsePlan, planProblems } from '../src/lib/roadmap.mjs';
import { fakeContext, fakeUi } from './fake-context.mjs';

const covered = new Set();
const stepsSeen = [];
const resultsSeen = [];
async function check(id, opts = {}, done = new Map()) {
  covered.add(id);
  const c = byId(id);
  assert.ok(c, `no check ${id}`);
  const ctx = fakeContext(opts);
  const r = await runCheck(c, ctx, done);
  stepsSeen.push(...r.steps.map((s) => ({ id, ...s })));
  resultsSeen.push(r);
  return withTestView(r, { ctx });
}
// The fake PC and ui ride along on a result for the asserts, out of sight of JSON.stringify
const withTestView = (r, extra) => Object.defineProperties(r, Object.fromEntries(Object.entries(extra).map(([k, value]) => [k, { value, enumerable: false }])));
// runChecks for one check, with fixes (the doctor's --fix)
async function fixed(id, opts = {}, ui = fakeUi()) {
  covered.add(id);
  const ctx = fakeContext(opts);
  const [r] = await runChecks(ctx, { checks: [byId(id)], fix: true, ui });
  return withTestView(r, { ctx, ui });
}
const GIT = { 'git --version': 'git version 2.55.0.windows.3' };
const CODEX = { 'codex --version': 'codex-cli 0.152.0', 'codex login status': 'Logged in using ChatGPT' };
// agy's print mode, as the model check tries it (FR-010): its Claude models refuse --effort, a model in `refuse` is
// refused, anything else does what the probe asks (FR-022: a file written with its tool, a command run, as agy 1.3.5
// prints those steps) and answers with a stream-json result
const step = (i, name, parameters) => `{"event":"step_update","step_update":{"step_index":${i},"state":"DONE","step_type":"tool","tool_name":"${name}","tool_info":{"name":"${name}","parameters":${JSON.stringify(parameters)}}}}`;
const AGY_DID = [step(2, 'write_to_file', { TargetFile: '/tmp/nextlevel-agy-trial/nextlevel-check.txt' }), step(3, 'run_command', { CommandLine: 'node --version' })].join('\n');
const agyRun = ({ refuse = [] } = {}) => (args) => {
  const model = args.includes('--model') ? args[args.indexOf('--model') + 1] : '';
  if (args.includes('--effort') && /^claude-/.test(model)) return { ok: false, code: 1, out: `Error: --effort is not supported for model ${model}` };
  if (refuse.includes(model)) return { ok: false, code: 1, out: `Error: model ${model} is not available for your plan` };
  return `${AGY_DID}\n{"event":"result","result":{"status":"SUCCESS","response":"ok\\n","num_turns":1,"usage":{"input_tokens":10,"output_tokens":1}}}`;
};
const AGY = { 'agy --version': '1.2.11', 'agy models': 'gemini-3-pro\ngemini-3-flash', 'agy -p *': agyRun() };

test('versions: parse and compare', () => {
  assert.deepEqual(parseVersion('git version 2.55.0.windows.3'), [2, 55, 0]);
  assert.deepEqual(parseVersion('codex-cli 0.152.0'), [0, 152, 0]);
  assert.deepEqual(parseVersion('v24.1'), [24, 1, 0]);
  assert.equal(parseVersion('no digits'), null);
  assert.ok(versionAtLeast('1.2.4', '1.2.4'));
  assert.ok(versionAtLeast('1.10.0', '1.2.4'));
  assert.ok(!versionAtLeast('1.1.16', '1.2.4'));
  assert.ok(!versionAtLeast(null, '1.0.0'));
});

test('window.elevated: an Administrator window is flagged, in any Windows language (FR-001 #9)', async () => {
  const admin = await check('window.elevated', { platform: 'win32', commands: { 'whoami /groups /fo csv /nh': '"Mandatory Label\\Hohe Verbindlichkeitsstufe","Bezeichnung","S-1-16-12288",""' } });
  assert.equal(admin.status, 'fail');
  assert.equal(admin.severity, 'warn');
  assert.match(admin.detail, /Administrator/);
  assert.equal(admin.steps[0].window, 'app');
  const normal = await check('window.elevated', { platform: 'win32', commands: { 'whoami /groups /fo csv /nh': '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""' } });
  assert.equal(normal.status, 'ok');
  const root = await check('window.elevated', { uid: 0 });
  assert.equal(root.status, 'fail');
  assert.equal(root.severity, 'info');
  assert.equal((await check('window.elevated', { uid: 1000 })).status, 'ok');
});

test('window.folder: a window in a system folder is flagged (FR-001 #9)', async () => {
  const sys = await check('window.folder', { platform: 'win32', cwd: 'C:\\Windows\\system32', env: { SystemRoot: 'C:\\WINDOWS' } });
  assert.equal(sys.status, 'fail');
  assert.match(sys.detail, /system folder: C:\\Windows\\system32/);
  assert.match(sys.steps[0].command, /^cd "C:\\proj"$/, 'says which folder to go to');
  assert.equal((await check('window.folder', { platform: 'win32', cwd: 'C:\\Users\\me\\proj', env: { SystemRoot: 'C:\\Windows' } })).status, 'ok');
  assert.equal((await check('window.folder', { cwd: '/usr/local/bin' })).status, 'fail');
  assert.equal((await check('window.folder', { cwd: '/', root: null })).status, 'fail');
  assert.equal((await check('window.folder', { cwd: '/home/me/app' })).status, 'ok');
});

test('project.folder: outside a repository it fails with the way out; in a subfolder it names the top (FR-001 #1)', async () => {
  const none = await check('project.folder', { root: null, cwd: '/home/me/Downloads', problem: 'nextlevel works on a project that is a git repository...' });
  assert.equal(none.status, 'fail');
  assert.equal(none.severity, 'error');
  assert.match(none.message, /git repository/);
  assert.ok(none.steps.some((s) => s.command === 'git init -b main'));
  const sub = await check('project.folder', { cwd: '/proj/files/kit' });
  assert.equal(sub.status, 'ok');
  assert.match(sub.detail, /^\/proj .*subfolder files\/kit/);
});

test('project.config: missing, misplaced in a subfolder (FR-001 #1), broken, with warnings, fine', async () => {
  const misplaced = await check('project.config', { configInfo: { exists: false }, files: { '/proj/files/acme-starter/START.cmd': '@echo off' } });
  assert.equal(misplaced.status, 'fail');
  assert.match(misplaced.detail, /found nextlevel files in files\/acme-starter/);
  assert.match(misplaced.next, /top folder is \/proj/);
  const missing = await check('project.config', { configInfo: { exists: false } });
  assert.match(missing.detail, /^missing \(using defaults\)$/);
  assert.equal(missing.steps[0].command, 'nextlevel init');
  const broken = await check('project.config', { configInfo: { error: 'Settings problem (/proj/nextlevel.json):\n  - "workers.slots" must be a whole number' } });
  assert.equal(broken.severity, 'error');
  assert.match(broken.message, /workers\.slots/);
  const warn = await check('project.config', { configInfo: { warnings: ['unknown setting "colour" (ignored)'] } });
  assert.equal(warn.severity, 'warn');
  assert.equal((await check('project.config')).status, 'ok');
  assert.equal((await check('project.config', { root: null })).status, 'skip');
});

test('project.state: names the state folder', async () => {
  assert.equal((await check('project.state')).detail, '.nextlevel/');
});

test('tool.node: needs 22 or newer', async () => {
  const old = await check('tool.node', { platform: 'win32', nodeVersion: '20.11.0' });
  assert.equal(old.status, 'fail');
  assert.equal(old.steps[0].command, 'winget install -e --id OpenJS.NodeJS.LTS');
  assert.equal((await check('tool.node', { nodeVersion: '22.0.0' })).status, 'ok');
});

test('install.command: the nextlevel command runs this copy; missing, it is made (M3)', async () => {
  const win = { platform: 'win32', toolRoot: 'C:\\Users\\me\\.nextlevel\\tool' };
  const missing = await check('install.command', { ...win, which: { nextlevel: null } });
  assert.equal(missing.status, 'fail');
  assert.equal(missing.severity, 'warn');
  assert.equal(missing.steps[0].command, INSTALL_COMMAND, 'on Windows the installer repairs it');
  assert.equal(missing.steps[1].window, 'new-terminal');
  const linux = await check('install.command', { which: { nextlevel: null } });
  assert.equal(linux.steps[0].command, 'node "/home/me/.nextlevel/tool/bin/nextlevel.mjs" _install');
  const made = await fixed('install.command', { which: { nextlevel: null } });
  assert.match(made.ui.ran[0], /nextlevel\.mjs _install$/);
  assert.match(made.ui.said.join('\n'), /open a new window/);

  const shim = ['C:\\Users\\me\\.nextlevel\\bin\\nextlevel.cmd'];
  const ok = await check('install.command', { ...win, which: { nextlevel: shim }, commands: { 'nextlevel version': 'nextlevel 0.1.0 (main @ 1a2b3c4) in c:\\users\\me\\.nextlevel\\tool' } });
  assert.equal(ok.status, 'ok', ok.detail);
  assert.equal(ok.detail, shim[0]);
  const other = await check('install.command', { ...win, which: { nextlevel: ['C:\\npm\\nextlevel.cmd'] }, commands: { 'nextlevel version': 'nextlevel 0.1.0 (C:\\dev\\nextlevel)' } });
  assert.match(other.detail, /^runs another copy: nextlevel 0\.1\.0 \(C:\\dev\\nextlevel\)$/);
  assert.equal(other.steps[0].command, 'Get-Command nextlevel -All');
  assert.equal((await fixed('install.command', { ...win, which: { nextlevel: ['C:\\npm\\nextlevel.cmd'] }, commands: { 'nextlevel version': 'x' } })).fixable, false, 'only a missing command is made');
  const broken = await check('install.command', { ...win, which: { nextlevel: shim }, commands: { 'nextlevel version': { ok: false, out: "'node' is not recognized" } } });
  assert.match(broken.detail, /"nextlevel version" fails: 'node' is not recognized/);
});

test('install.updates: an install from before releases says so once a release is out; pinned, other branches, changed files and failures say so', async () => {
  const TOOL = '/home/me/.nextlevel/tool';
  const git = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`git -C ${TOOL} ${k}`, v]));
  const main = {
    'symbolic-ref --short -q HEAD': 'main',
    'rev-parse --short HEAD': '1a2b3c4',
    'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/main',
    'symbolic-ref --short -q refs/remotes/origin/HEAD': 'origin/main',
    'status --porcelain --untracked-files=no': '',
    'rev-list --count HEAD..@{u}': '0',
    'rev-list --count @{u}..HEAD': '0',
  };
  const clone = (o = {}, extra = {}) => ({ dirs: [`${TOOL}/.git`], commands: { 'git --version': 'git version 2.47.1', ...git({ ...main, ...o }) }, ...extra });

  const fine = await check('install.updates', clone({}, { userState: { update: { ok: true, at: '2026-09-25T10:00:00.000Z' } } }));
  assert.equal(fine.status, 'ok');
  assert.equal(fine.detail, 'main @ 1a2b3c4; no release is published yet, checked 2026-09-25');
  const zip = await check('install.updates', { commands: { 'git --version': 'git version 2.47.1' } });
  assert.match(zip.detail, /isn't a git clone, so nextlevel can't update itself/);
  assert.equal(zip.severity, 'warn');

  const changed = await check('install.updates', clone({ 'status --porcelain --untracked-files=no': ' M src/cli.mjs\n M bin/nextlevel.mjs' }));
  assert.match(changed.detail, /^2 file\(s\) in the tool's folder were changed by hand, so it doesn't update: src\/cli\.mjs, bin\/nextlevel\.mjs$/);
  assert.equal(changed.steps[0].command, `git -C "${TOOL}" stash`);

  const pinned = await check('install.updates', clone({ 'symbolic-ref --short -q HEAD': { ok: false }, 'describe --tags --exact-match HEAD': '' }));
  assert.equal(pinned.severity, 'info');
  assert.equal(pinned.detail, 'pinned at 1a2b3c4: it stays there until the installer moves it to the first release');

  // The owner's hand install: cloned from a pull request's branch, which is gone after the merge
  const gone = await check('install.updates', clone({ 'symbolic-ref --short -q HEAD': 'claude/practical-bohr-z5rpsr', 'rev-parse --abbrev-ref --symbolic-full-name @{u}': { ok: false } }));
  assert.equal(gone.severity, 'warn');
  assert.match(gone.detail, /follows the branch claude\/practical-bohr-z5rpsr, not main/);
  const trying = await check('install.updates', clone({ 'symbolic-ref --short -q HEAD': 'claude/x', 'rev-parse --abbrev-ref --symbolic-full-name @{u}': 'origin/claude/x' }));
  assert.equal(trying.severity, 'info');

  const ahead = await check('install.updates', clone({ 'rev-list --count @{u}..HEAD': '2' }));
  assert.match(ahead.detail, /main has 2 commit\(s\) that origin\/main doesn't/);
  const failed = await check('install.updates', clone({}, { userState: { update: { ok: false, at: '2026-09-25T10:00:00.000Z', detail: 'no connection to GitHub' } } }));
  assert.equal(failed.detail, 'the last look for releases failed (2026-09-25): no connection to GitHub');

  // A release is out: the installer moves this install (pinned or not) to it
  const released = { files: { '/home/me/.nextlevel/update/available.json': JSON.stringify({ at: '2026-10-20T10:00:00.000Z', ok: true, newest: { name: 'v0.1.0' }, newer: [] }) } };
  for (const o of [{}, { 'symbolic-ref --short -q HEAD': { ok: false } }]) {
    const move = await check('install.updates', clone(o, released));
    assert.equal(move.severity, 'warn');
    assert.match(move.detail, /^nextlevel v0\.1\.0 is released, and this nextlevel is from before releases/);
    assert.match(move.steps[0].command, /install\.ps1|_install/);
  }
});

test('install.updates: a version in its own folder: the newest release, a newer one (safety: warn), a moved tag, a pin, changed files', async () => {
  const V = '/home/me/.nextlevel/versions/v0.2.0';
  const git = (o = {}) => Object.fromEntries(Object.entries({ 'symbolic-ref --short -q HEAD': { ok: false }, 'rev-parse --short HEAD': '1a2b3c4', 'describe --tags --exact-match HEAD': 'v0.2.0', 'status --porcelain --untracked-files=no': '', ...o }).map(([k, v]) => [`git -C ${V} ${k}`, v]));
  const avail = (a) => ({ '/home/me/.nextlevel/update/available.json': JSON.stringify({ at: '2026-10-20T10:00:00.000Z', ok: true, newer: [], refused: [], vanished: [], ...a }) });
  const at = (o = {}, files = avail({})) => ({ toolRoot: V, dirs: [`${V}/.git`], files, commands: { 'git --version': 'git version 2.47.1', ...git(o) } });

  const newest = await check('install.updates', at());
  assert.equal(newest.status, 'ok');
  assert.equal(newest.detail, 'v0.2.0, the newest release, checked 2026-10-20');
  const newer = await check('install.updates', at({}, avail({ newer: [{ name: 'v0.3.0', notes: { safety: false } }] })));
  assert.equal(newer.severity, 'info');
  assert.match(newer.detail, /^nextlevel v0\.3\.0 is available \(you run v0\.2\.0\)$/);
  assert.equal(newer.steps[0].command, 'nextlevel update');
  const safety = await check('install.updates', at({}, avail({ newer: [{ name: 'v0.3.1', notes: { safety: true } }] })));
  assert.equal(safety.severity, 'warn');
  assert.match(safety.detail, /v0\.3\.1 is available, with a safety fix/);
  const moved = await check('install.updates', at({}, avail({ refused: [{ name: 'v0.3.0', why: 'v0.3.0 was changed on GitHub after it was published (it pointed at aaaaaaa, now bbbbbbb): nextlevel doesn\'t follow it' }] })));
  assert.equal(moved.severity, 'warn');
  assert.match(moved.detail, /changed on GitHub after it was published/);
  const vanished = await check('install.updates', at({}, avail({ vanished: ['v0.1.9'] })));
  assert.match(vanished.detail, /v0\.1\.9 was published and is gone from GitHub now/);
  const failed = await check('install.updates', at({}, avail({ ok: false, detail: 'no connection to GitHub' })));
  assert.equal(failed.detail, 'the last look for releases failed (2026-10-20): no connection to GitHub');
  const changed = await check('install.updates', at({ 'status --porcelain --untracked-files=no': ' M src/hub.mjs' }));
  assert.equal(changed.severity, 'warn');
  assert.match(changed.detail, /^1 file\(s\) in v0\.2\.0's folder were changed by hand: src\/hub\.mjs/);
  const pinned = await check('install.updates', at({}, { ...avail({ newer: [{ name: 'v0.3.0', notes: {} }] }), '/home/me/.nextlevel/channels.json': JSON.stringify({ projects: { '/proj': { channel: 'pin', ref: 'v0.2.0' } } }) }));
  assert.equal(pinned.severity, 'info');
  assert.equal(pinned.detail, 'this project is pinned at v0.2.0: it stays there');
  assert.equal(pinned.steps[0].command, 'nextlevel channel release');
});

test('install.channel: releases are quiet; a pin and a candidate say so, a candidate with autopilot on warns', async () => {
  const versions = { '/home/me/.nextlevel/versions.json': JSON.stringify({ release: 'v0.2.0' }) };
  const channels = (e) => ({ '/home/me/.nextlevel/channels.json': JSON.stringify({ projects: { '/proj': e } }) });
  const before = await check('install.channel', {});
  assert.equal(before.status, 'skip');
  const release = await check('install.channel', { files: versions });
  assert.equal(release.status, 'ok');
  assert.equal(release.detail, 'releases (v0.2.0)');
  const pin = await check('install.channel', { files: { ...versions, ...channels({ channel: 'pin', ref: 'v0.1.0' }) } });
  assert.equal(pin.severity, 'info');
  assert.equal(pin.detail, 'pinned at v0.1.0');
  const cand = await check('install.channel', { files: { ...versions, ...channels({ channel: 'candidate', ref: 'main', version: 'main@1a2b3c4' }) } });
  assert.equal(cand.severity, 'info');
  assert.match(cand.detail, /^the candidate main \(main@1a2b3c4\): it runs whatever sessions push to main/);
  const busy = await check('install.channel', { files: { ...versions, ...channels({ channel: 'candidate', ref: 'main', version: 'main@1a2b3c4' }), '/proj/.nextlevel/settings.json': JSON.stringify({ autopilot: true }) } });
  assert.equal(busy.severity, 'warn');
  assert.match(busy.next, /autopilot is on here/);
});

test('tool.git: missing, too old (with the update command and a new window), fine', async () => {
  const missing = await fixed('tool.git', { platform: 'win32', commands: {} });
  assert.equal(missing.status, 'fail');
  assert.match(missing.ui.ran[0], /^winget install -e --id Git\.Git/);
  assert.match(missing.ui.said.join('\n'), /open a new PowerShell window/);
  const old = await check('tool.git', { platform: 'win32', commands: { 'git --version': 'git version 2.30.1.windows.1' } });
  assert.match(old.detail, /older than 2\.31\.0/);
  assert.deepEqual(old.steps.map((s) => s.window), ['terminal', 'new-terminal']);
  assert.equal(old.steps[0].command, 'winget upgrade -e --id Git.Git');
  const linux = await fixed('tool.git', { commands: {} });
  assert.equal(linux.fixable, false, 'no package manager to run on Linux: guided only');
  assert.deepEqual(linux.ui.ran, []);
  assert.equal((await check('tool.git', { commands: GIT })).status, 'ok');
});

test('git.identity: git can\'t commit, git would guess, set (FR-001 #3)', async () => {
  const none = await check('git.identity', { commands: { ...GIT, 'git var GIT_AUTHOR_IDENT': { ok: false, err: 'fatal: unable to auto-detect email address' } } });
  assert.equal(none.status, 'fail');
  assert.match(none.detail, /git can't commit/);
  assert.deepEqual(none.steps.map((s) => s.command), ['git config --global user.name "Your Name"', 'git config --global user.email "you@example.com"']);
  const guessed = await check('git.identity', { commands: { ...GIT, 'git var GIT_AUTHOR_IDENT': 'me <me@DESKTOP-1.(none)> 1 +0000' } });
  assert.match(guessed.detail, /would guess/);
  const set = await check('git.identity', { commands: { 'git var GIT_AUTHOR_IDENT': 'Ada <ada@example.com> 1 +0000', 'git config user.name': 'Ada', 'git config user.email': 'ada@example.com' } });
  assert.equal(set.status, 'ok');
  assert.equal((await check('git.identity', { env: { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b.c' }, commands: { 'git var GIT_AUTHOR_IDENT': 'A <a@b.c> 1 +0000' } })).status, 'ok');

  // The fix asks for both in the menu; with --fix alone there is nobody to ask
  const cmds = { 'git var GIT_AUTHOR_IDENT': { ok: false } };
  const quiet = await fixed('git.identity', { commands: cmds });
  assert.equal(quiet.fixable, false);
  const asked = await fixed('git.identity', { commands: cmds }, fakeUi({ interactive: true, answers: ['Ada Lovelace', 'ada@example.com'] }));
  assert.ok(asked.ctx.calls.includes('git config --global user.name Ada Lovelace'));
  assert.ok(asked.ctx.calls.includes('git config --global user.email ada@example.com'));
});

test('tool.gh and gh.auth', async () => {
  const missing = await fixed('tool.gh', { platform: 'win32', commands: {} });
  assert.match(missing.ui.ran[0], /^winget install -e --id GitHub\.cli/);
  assert.equal((await check('tool.gh', { commands: { 'gh --version': 'gh version 2.96.0 (2026-09-01)' } })).detail, 'gh version 2.96.0 (2026-09-01)');
  const out = await check('gh.auth', { commands: { 'gh auth status': { ok: false, out: 'You are not logged into any GitHub hosts.' } } });
  assert.equal(out.status, 'fail');
  assert.equal(out.steps[0].command, 'gh auth login');
  assert.equal((await check('gh.auth', { commands: { 'gh auth status': 'Logged in to github.com' } })).status, 'ok');
});

test("gh.read-token (FR-017): missing is a note with the steps to make one; a token that reads the repository passes with its expiry; one that expires within a week, one GitHub refuses, or a classic token warns; the token itself is never shown", async () => {
  const DAY = 24 * 3_600_000;
  const ORIGIN = { ...GIT, 'gh --version': 'gh version 2.96.0', 'git config --get remote.origin.url': 'https://github.com/owner/app.git' };
  const TOKEN = ['github', 'pat', '11AAmadeup', 'readonly0123'].join('_');
  const files = (t) => ({ '/proj/.env': `NTFY_TOPIC=x\nNEXTLEVEL_GITHUB_READ_TOKEN=${t}\n` });
  const asked = [];
  const api = (res) => ({ 'gh api -i repos/owner/app': (args, opts) => (asked.push(opts.env?.GH_TOKEN), res) });
  const day = (n) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

  const missing = await check('gh.read-token', { commands: ORIGIN });
  assert.deepEqual([missing.status, missing.severity], ['fail', 'info']);
  assert.equal(missing.detail, "not set: verify commands run without your GitHub sign-in (FR-017), so the orchestrator can't read owner/app's CI through them");
  assert.deepEqual(missing.steps.map((s) => [s.window, s.command || null]), [['browser', 'https://github.com/settings/personal-access-tokens/new'], ['editor', null]]);
  assert.match(missing.steps[0].text, /Only select repositories, owner\/app; Repository permissions: Actions: Read-only, Contents: Read-only, Pull requests: Read-only, Commit statuses: Read-only \(Metadata: Read-only comes with them\), nothing else; an expiration date/);
  assert.match(missing.steps[1].text, /^in \/proj\/\.env add the line NEXTLEVEL_GITHUB_READ_TOKEN=<the token>/);

  const ok = await check('gh.read-token', { commands: { ...ORIGIN, ...api({ out: `HTTP/2.0 200 OK\ngithub-authentication-token-expiration: ${day(60)} 12:00:00 UTC\n\n{}` }) }, files: files(TOKEN) });
  assert.deepEqual([ok.status, ok.detail], ['ok', `reads owner/app; expires on ${day(60)}`]);
  assert.equal(asked.at(-1), TOKEN, "GitHub is asked with the token, never the owner's sign-in");
  const soon = await check('gh.read-token', { commands: { ...ORIGIN, ...api({ out: `HTTP/2.0 200 OK\nGithub-Authentication-Token-Expiration: ${day(3)} 00:00:00 +0000\n\n{}` }) }, files: files(TOKEN) });
  assert.deepEqual([soon.status, soon.severity, soon.detail], ['fail', 'warn', `NEXTLEVEL_GITHUB_READ_TOKEN in .env reads owner/app, and expires on ${day(3)}`]);
  const refused = await check('gh.read-token', { commands: { ...ORIGIN, ...api({ ok: false, out: 'gh: Bad credentials (HTTP 401)' }) }, files: files(TOKEN) });
  assert.deepEqual([refused.status, refused.severity, refused.detail], ['fail', 'warn', "NEXTLEVEL_GITHUB_READ_TOKEN in .env doesn't read owner/app: gh: Bad credentials (HTTP 401)"]);
  const classic = await check('gh.read-token', { commands: ORIGIN, files: files(`ghp_${'x'.repeat(36)}`) });
  assert.deepEqual([classic.status, classic.severity], ['fail', 'warn']);
  assert.match(classic.detail, /is a classic token, which can write whatever its scopes allow/);
  for (const r of [missing, ok, soon, refused, classic]) assert.ok(!JSON.stringify(r).includes(TOKEN) && !JSON.stringify(r).includes('ghp_x'), 'never the token');
  const elsewhere = await check('gh.read-token', { commands: { ...ORIGIN, 'git config --get remote.origin.url': 'C:/repos/app.git' } });
  assert.deepEqual([elsewhere.status, elsewhere.quiet], ['ok', true]);
});

test('tool.docker: not installed, not running, still starting, running', async () => {
  assert.match((await check('tool.docker', { platform: 'win32', commands: {} })).steps[0].command, /Docker\.DockerDesktop/);
  const stopped = await check('tool.docker', { commands: { 'docker info --format {{.ServerVersion}}': { ok: false, out: 'Cannot connect to the Docker daemon' } } });
  assert.equal(stopped.detail, 'not running');
  assert.equal(stopped.severity, 'warn');
  assert.match((await check('tool.docker', { commands: { 'docker info --format {{.ServerVersion}}': { ok: false, timedOut: true } } })).detail, /no answer in 30 s/);
  assert.equal((await check('tool.docker', { commands: { 'docker info --format {{.ServerVersion}}': '29.7.2' } })).detail, 'engine 29.7.2');
});

test('tool.codex, codex.login, codex.installs', async () => {
  const missing = await fixed('tool.codex', { platform: 'win32', commands: {} });
  assert.deepEqual(missing.ui.ran, ['npm install -g @openai/codex (shell)']);
  assert.equal((await check('tool.codex', { commands: CODEX })).detail, 'codex-cli 0.152.0');
  const out = await check('codex.login', { commands: { ...CODEX, 'codex login status': { ok: false, out: 'Not logged in' } } });
  assert.equal(out.steps[0].command, 'codex login');
  assert.equal((await check('codex.login', { commands: CODEX })).detail, 'Logged in using ChatGPT');
  const two = await check('codex.installs', { which: { codex: ['C:\\npm\\codex.cmd', 'C:\\Apps\\Codex\\codex.exe'] } });
  assert.equal(two.status, 'fail');
  assert.equal(two.severity, 'info');
  assert.match(two.next, /using C:\\npm\\codex\.cmd/);
  assert.equal((await check('codex.installs', { which: { codex: ['/usr/bin/codex'] } })).quiet, true);
});

test('codex.sandbox: the orchestrator stays sandboxed to the project (docs/CHECKS.md)', async () => {
  assert.equal((await check('codex.sandbox')).status, 'ok');
  const full = await check('codex.sandbox', { config: { engines: { codex: { args: ['--sandbox', 'danger-full-access'] } } } });
  assert.equal(full.severity, 'error');
  assert.match(full.detail, /sandbox off/);
  assert.equal(full.steps[0].window, 'editor');
  const yolo = await check('codex.sandbox', { config: { engines: { codex: { args: ['--dangerously-bypass-approvals-and-sandbox'] } } } });
  assert.equal(yolo.severity, 'error');
  const none = await check('codex.sandbox', { config: { engines: { codex: { args: [] } } } });
  assert.equal(none.severity, 'warn');
  assert.match(none.detail, /read-only/);
});

test('codex.model: a pinned model this login rejects fails, with the fix; answers are cached (FR-001 #5)', async () => {
  const probe = (model) => `codex exec --skip-git-repo-check --sandbox read-only -m ${model} ${MODEL_PROBE}`;
  // Nothing pinned: Codex's own model (FR-004 #3), from its config.toml, or the account's default
  const ownProbe = `codex exec --skip-git-repo-check --sandbox read-only ${MODEL_PROBE}`;
  const defaultModel = await check('codex.model', { commands: { ...CODEX, [ownProbe]: 'ok' } });
  assert.equal(defaultModel.detail, "the account's default (accepted by this login)");
  const toml = { '/home/me/.codex/config.toml': 'model = "gpt-6-sol"\napproval_policy = "never"\n' };
  const ownBad = await check('codex.model', { files: toml, commands: { ...CODEX, [ownProbe]: { ok: false, out: "ERROR: The 'gpt-6-sol' model is not supported when using Codex with a ChatGPT account." } } });
  assert.equal(ownBad.status, 'fail');
  assert.equal(ownBad.severity, 'error');
  assert.match(ownBad.detail, /^Codex's own model "gpt-6-sol" \(model in \/home\/me\/\.codex\/config\.toml\) was rejected: ERROR: .*ChatGPT account/);
  assert.deepEqual(ownBad.steps.map((s) => [s.window, s.command || s.text]), [['codex', '/model'], ['editor', 'in /home/me/.codex/config.toml change model = "gpt-6-sol" to one of those names, or delete that line']]);
  assert.ok(!ownBad.pinned);
  // The answer is kept per model in config.toml: a new one there is tried again
  const cached = ownBad.ctx.cacheData['codex.model'];
  assert.deepEqual(Object.keys(cached).map((k) => k.split(' | ')[0]), ['own:gpt-6-sol']);
  const ownGood = await check('codex.model', { env: { CODEX_HOME: '/opt/cx' }, files: { '/opt/cx/config.toml': "model = 'gpt-6-astra'\n" }, commands: { ...CODEX, [ownProbe]: 'ok' } });
  assert.equal(ownGood.detail, `Codex's own "gpt-6-astra" (from its config.toml; accepted by this login)`);
  assert.equal(tomlTop('[a]\nmodel = "x"', 'model'), null, 'only a top-level model counts');

  const rejected = { ...CODEX, [probe('gpt-6-sol')]: { ok: false, out: 'OpenAI Codex v0.152.0\nERROR: The \'gpt-6-sol\' model is not supported when using Codex with a ChatGPT account.' } };
  const bad = await check('codex.model', { commands: rejected, config: { roles: { orchestrator: { model: 'gpt-6-sol' } } } });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.pinned, true);
  assert.equal(bad.severity, 'error');
  assert.match(bad.detail, /"gpt-6-sol" \(roles\.orchestrator\.model\) was rejected: ERROR: .*not supported when using Codex with a ChatGPT account/);
  assert.deepEqual(bad.steps.map((s) => s.window), ['editor', 'codex']);
  assert.equal(bad.steps[1].command, '/model', 'the slash command is typed inside Codex');
  // The same model, Codex and login again: answered from the cache
  const again = await runCheck(byId('codex.model'), bad.ctx);
  assert.equal(again.status, 'fail');
  assert.equal(bad.ctx.calls.filter((c) => c.includes('exec')).length, 1);

  const good = await check('codex.model', { commands: { ...CODEX, [probe('gpt-6')]: 'ok' }, config: { roles: { orchestrator: { model: 'gpt-6' } } } });
  assert.match(good.detail, /gpt-6 \(accepted/);
  const slow = await check('codex.model', { commands: { ...CODEX, [probe('gpt-6')]: { ok: false, timedOut: true } }, config: { roles: { orchestrator: { model: 'gpt-6' } } } });
  assert.equal(slow.severity, 'warn');
  assert.deepEqual(slow.ctx.cacheData, {}, 'no answer is not cached');
});

test('codex.mcp: an MCP server that can\'t start is a note, not our failure (FR-001 #6)', async () => {
  const toml = [
    'model = "gpt-6"',
    '[mcp_servers.searchy]',
    'command = "searchy-mcp"',
    'args = ["--stdio"]',
    '[mcp_servers.searchy.env]',
    'command = "not-a-server-key"',
    '[mcp_servers."docs"]',
    "command = 'npx'",
    '[mcp_servers.off]',
    'command = "gone"',
    'enabled = false',
    '[mcp_servers.remote]',
    'url = "https://example.com/mcp"',
  ].join('\n');
  assert.deepEqual(
    mcpServers(toml).map((s) => [s.name, s.command, s.enabled]),
    [['searchy', 'searchy-mcp', true], ['docs', 'npx', true], ['off', 'gone', false], ['remote', '', true]],
  );
  const r = await check('codex.mcp', { files: { '/home/me/.codex/config.toml': toml }, commands: { 'npx --version': '10' } });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'info');
  assert.match(r.detail, /"searchy" \(searchy-mcp not found\): Codex warns about this on every start; it isn't nextlevel's problem/);
  assert.doesNotMatch(r.detail, /docs|off|remote/);
  assert.match(r.steps[0].text, /\[mcp_servers\.searchy\] in \/home\/me\/\.codex\/config\.toml/);
  const elsewhere = await check('codex.mcp', { env: { CODEX_HOME: '/opt/codex' }, files: { '/opt/codex/config.toml': '[mcp_servers.a]\ncommand = "/opt/a/server"\n', '/opt/a/server': '' } });
  assert.match(elsewhere.detail, /1 set up, all can start/);
  assert.equal((await check('codex.mcp')).quiet, true);
});

test('window.sandbox and the runner inside Codex\'s sandbox: failures there are "can\'t tell", network checks don\'t run (FR-004 #2)', async () => {
  const signed = { ...CODEX, 'gh --version': 'gh version 2.96.0', 'gh auth status': { ok: false, out: 'You are not logged into any GitHub hosts.' } };
  const inside = { env: { CODEX_SANDBOX_NETWORK_DISABLED: '1', CODEX_THREAD_ID: 't1' }, commands: signed };
  const row = await check('window.sandbox', inside);
  assert.equal(row.status, 'fail');
  assert.equal(row.severity, 'warn');
  assert.match(row.detail, /^running inside Codex's sandbox \(no network: CODEX_SANDBOX_NETWORK_DISABLED\): it hides sign-ins, Docker/);
  assert.deepEqual(row.steps.map((s) => [s.window, s.command]), [['codex', 'nextlevel verify doctor -- nextlevel doctor'], ['terminal', 'nextlevel doctor']]);
  assert.equal((await check('window.sandbox')).quiet, true, 'outside it: nothing to show');
  // Windows' elevated sandbox sets no variable; under Codex, a .git it can't write gives it away
  assert.match((await check('window.sandbox', { env: { CODEX_THREAD_ID: 't1' }, gitWritable: false })).detail, /can't write the project's \.git folder/);
  assert.equal((await check('window.sandbox', { env: { CODEX_THREAD_ID: 't1' } })).status, 'ok', 'Codex with full access is no sandbox');
  assert.equal((await check('window.sandbox', { gitWritable: false })).status, 'ok', 'without Codex, an unwritable .git is not a sandbox');

  const [auth] = await runChecks(fakeContext(inside), { checks: [byId('gh.auth')] });
  assert.equal(auth.status, 'skip');
  assert.equal(auth.detail, "can't tell inside Codex's sandbox (there: not signed in)");
  assert.deepEqual(auth.steps, [], 'no steps to sign in again: the owner is signed in');
  const ok = await runCheck(byId('tool.codex'), fakeContext(inside));
  assert.equal(ok.status, 'ok', 'what passes there passes outside too');
  const model = fakeContext({ ...inside, config: { roles: { orchestrator: { model: 'gpt-6' } } } });
  const [probe] = await runChecks(model, { checks: [byId('codex.model')] });
  assert.equal(probe.detail, "not checked inside Codex's sandbox");
  assert.ok(!model.calls.some((c) => c.includes('exec')), 'no model probe: its answer would be wrong, and cached');
  const [ignore] = await runChecks(fakeContext({ ...inside, files: { '/proj/.gitignore': '' } }), { checks: [byId('project.gitignore')] });
  assert.equal(ignore.status, 'fail', 'what only reads the project is still true');
  const [first] = await runChecks(fakeContext({ ...inside, commands: { ...GIT, 'git rev-parse --verify --quiet HEAD': { ok: false } } }), { checks: [byId('git.commits')], fix: true, ui: fakeUi() });
  assert.equal(first.fixable, false, "no first commit from inside: the sandbox can't write .git");
});

test('codex.version: against the latest release, from Codex\'s own update check or npm (FR-004 #3)', async () => {
  const now = new Date().toISOString();
  const version = (latest, at = now) => ({ '/home/me/.codex/version.json': JSON.stringify({ latest_version: latest, last_checked_at: at, dismissed_version: null }) });
  const old = await fixed('codex.version', { platform: 'win32', home: '/home/me', files: version('0.157.0'), commands: CODEX }, fakeUi());
  assert.equal(old.status, 'fail');
  assert.equal(old.severity, 'warn');
  assert.match(old.detail, /^0\.152\.0, and 0\.157\.0 is out: an older Codex doesn't know the newer models/);
  assert.deepEqual(old.steps.map((s) => [s.window, s.command]), [['terminal', 'npm install -g @openai/codex@latest'], ['new-terminal', 'nextlevel doctor']]);
  assert.deepEqual(old.ui.ran, ['npm install -g @openai/codex@latest (shell)']);
  assert.equal(byId('codex.version').fixInWindow, true);
  assert.equal((await check('codex.version', { files: version('0.152.0'), commands: CODEX })).detail, '0.152.0, the latest release');
  // Codex's answer is over 3 days old: npm is asked, and its answer kept for a day
  const npm = await check('codex.version', { files: version('0.150.0', '2026-01-01T00:00:00Z'), commands: { ...CODEX, 'npm view @openai/codex version': '0.160.0\n' } });
  assert.match(npm.detail, /0\.160\.0 is out/);
  assert.equal(npm.ctx.cacheData['codex.latest'].version, '0.160.0');
  const offline = await check('codex.version', { commands: { ...CODEX, 'npm view @openai/codex version': { ok: false, out: 'ENOTFOUND' } } });
  assert.equal(offline.status, 'ok');
  assert.equal(offline.detail, "0.152.0 (the latest release couldn't be checked: npm view @openai/codex failed)");
});

test('codex.args: -c overrides make Codex run without its shared background server; the fix takes them out of nextlevel.json (FR-004 #6)', async () => {
  assert.deepEqual(withoutOverrides(['--sandbox', 'workspace-write', '-c', 'a=1', '--config', 'b=2', '--config=c=3', '-cd=4', '-m', 'x']), {
    kept: ['--sandbox', 'workspace-write', '-m', 'x'],
    dropped: ['-c a=1', '--config b=2', '--config=c=3', '-cd=4'],
  });
  assert.equal((await check('codex.args')).quiet, true, 'the defaults have none');
  const old = ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
  const file = { '/proj/nextlevel.json': JSON.stringify({ version: 1, name: 'proj', $note: 'mine', engines: { codex: { args: old } } }) };
  const r = await fixed('codex.args', { files: file, config: { engines: { codex: { args: old } } } });
  assert.equal(r.status, 'ok', 'fixed');
  assert.equal(r.fixed, true);
  const saved = JSON.parse(r.ctx.files.get('/proj/nextlevel.json'));
  assert.deepEqual(saved.engines.codex.args, ['--sandbox', 'workspace-write']);
  assert.equal(saved.$note, 'mine', 'the rest of the file stays');
  assert.match(r.ctx.files.get('/proj/nextlevel.json'), /"args": \["--sandbox", "workspace-write"\]/);
  const seen = await check('codex.args', { config: { engines: { codex: { args: old } } } });
  assert.match(seen.detail, /^engines\.codex\.args override Codex's settings \(-c sandbox_workspace_write\.network_access=true\): Codex then runs without its shared background server/);
  const env = await fixed('codex.args', { config: { engines: { codex: { args: old } } }, configInfo: { overrides: ['CODEX_ARGS'] } });
  assert.equal(env.fixable, false, 'it comes from CODEX_ARGS: nothing in nextlevel.json to change');
  assert.match(env.steps[0].text, /CODEX_ARGS in \.env/);
});

test('codex.hooks: hooks whose command can\'t run, from hooks.json, config.toml and plugins (FR-004 #4)', async () => {
  assert.deepEqual(shellWords(`node "C:\\hooks\\a b.js" --x 'y z'`), ['node', 'C:\\hooks\\a b.js', '--x', 'y z']);
  assert.deepEqual(hooksFromJson({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'a' }, { type: 'prompt', prompt: 'x' }] }], Stop: [{ hooks: [{ type: 'command', command: 'b', commandWindows: 'b.cmd' }] }] } }), [
    { event: 'PreToolUse', command: 'a', commandWindows: '' },
    { event: 'Stop', command: 'b', commandWindows: 'b.cmd' },
  ]);
  const toml = [
    'model = "gpt-6"',
    '[[hooks.PreToolUse]]',
    'matcher = "Bash"',
    '[[hooks.PreToolUse.hooks]]',
    'type = "command"',
    'command = "python3 ~/.codex/hooks/guard.py"',
    '[[hooks.PostToolUse]]',
    'hooks = [{ type = "command", command = "node -e \\"{}\\"" }, { type = "command", command = \'jq .\' }]',
    '[hooks.state."/x/hooks.json:pre_tool_use:0:0"]',
    'enabled = false',
  ].join('\n');
  assert.deepEqual(hooksFromToml(toml).hooks.map((h) => [h.event, h.command]), [['PreToolUse', 'python3 ~/.codex/hooks/guard.py'], ['PostToolUse', 'node -e "{}"'], ['PostToolUse', 'jq .']]);
  assert.equal(hooksFromToml('[features]\nhooks = false\n').off, true);

  const plugin = '/home/me/.codex/plugins/cache/market/tidy';
  const files = {
    '/home/me/.codex/config.toml': toml,
    '/home/me/.codex/hooks.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node /home/me/.codex/hooks/start.mjs' }] }] } }),
    '/home/me/.codex/hooks/start.mjs': '',
    [`${plugin}/1.2.0/.codex-plugin/plugin.json`]: JSON.stringify({ name: 'tidy', hooks: './hooks/hooks.json' }),
    [`${plugin}/1.2.0/hooks/hooks.json`]: JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node ${PLUGIN_ROOT}/scripts/tidy.js' }] }] } }),
    [`${plugin}/1.10.0/.codex-plugin/plugin.json`]: JSON.stringify({ name: 'tidy', hooks: [{ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'bash "${CLAUDE_PLUGIN_ROOT}/stop.sh"' }] }] } }] }),
    [`${plugin}/1.10.0/stop.sh`]: '',
  };
  const r = await check('codex.hooks', { files, commands: { ...CODEX, 'node --version': 'v24', 'bash --version': '5', 'jq --version': '1.7' } });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warn');
  assert.equal(r.detail, `PreToolUse hook in your Codex settings (python3 not found): Codex prints "Hook failed" around its tool calls; it isn't nextlevel's problem`);
  assert.deepEqual(r.steps.map((s) => s.text), ['fix or remove the hook in /home/me/.codex/config.toml']);
  // The plugin's newest version (1.10.0, not 1.2.0 whose script is gone) is the one that counts
  const good = await check('codex.hooks', { files: { ...files, '/home/me/.codex/config.toml': 'model = "x"\n' }, commands: { ...CODEX, 'node --version': 'v24', 'bash --version': '5' } });
  assert.equal(good.status, 'ok', good.detail);
  assert.equal(good.detail, '2 set up, all can run');
  const off = await check('codex.hooks', { files: { ...files, '/home/me/.codex/config.toml': `${toml}\n[features]\nhooks = false\n` }, commands: CODEX });
  assert.equal(off.quiet, true);

  const win = fakeContext({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\me' }, which: { python: ['C:\\Users\\me\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe'], node: ['C:\\node\\node.exe'] }, files: { 'C:\\hooks\\ok.ps1': '' } });
  assert.equal(brokenCommand(win, 'python C:\\hooks\\x.py'), "python is only the Microsoft Store's placeholder");
  assert.equal(brokenCommand(win, 'node "%USERPROFILE%\\hooks\\gone.js"'), 'C:\\Users\\me\\hooks\\gone.js not found');
  assert.equal(brokenCommand(win, '& "C:\\hooks\\ok.ps1"'), '');
  assert.equal(brokenCommand(win, 'Write-Output hi'), '', 'a PowerShell cmdlet');
  assert.equal(brokenCommand(win, 'node $env:UNKNOWN_DIR\\x.js'), '', "an unknown variable: can't tell, so not reported");
});

test('project.role-docs: an older template is replaced; an own orchestrator doc that runs git itself is pointed at init (FR-004 #1)', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  const current = { orch: read('../templates/project/docs/agents/ORCHESTRATOR.md'), guide: read('../templates/project/docs/agents/GUIDE.md') };
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-M1.md'))));
  assert.ok(OLD_TEMPLATES['docs/agents/GUIDE.md'].includes(templateHash(read('./fixtures/GUIDE-M4.md').replace(/\n/g, '\r\n'))), 'CRLF line ends too');
  for (const [file, list] of Object.entries(OLD_TEMPLATES)) assert.ok(!list.includes(templateHash(read(`../templates/project/${file}`))), `${file}: the current template is not an old one`);
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const files = (orch, guide) => ({ '/proj/docs/agents/ORCHESTRATOR.md': orch, '/proj/docs/agents/GUIDE.md': guide, [`${tool}/ORCHESTRATOR.md`]: current.orch, [`${tool}/GUIDE.md`]: current.guide });

  assert.equal((await check('project.role-docs', { files: files(current.orch, current.guide) })).quiet, true);
  const old = await fixed('project.role-docs', { files: files(read('./fixtures/ORCHESTRATOR-M1.md'), read('./fixtures/GUIDE-M4.md')) });
  assert.equal(old.fixed, true);
  assert.equal(old.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), current.orch);
  assert.equal(old.ctx.files.get('/proj/docs/agents/GUIDE.md'), current.guide);
  assert.match(old.ui.said.join('\n'), /Updated docs\/agents\/ORCHESTRATOR\.md to the current template/);
  const seen = await check('project.role-docs', { files: files(read('./fixtures/ORCHESTRATOR-M1.md'), current.guide) });
  assert.equal(seen.detail, 'docs/agents/ORCHESTRATOR.md: an older nextlevel template, unchanged');
  const own = await fixed('project.role-docs', { files: files('# Mine\nThen git merge --no-ff task/<id>.\n', current.guide) });
  assert.equal(own.fixable, false, "the owner's own text is never replaced");
  resultsSeen.push(own);
  assert.match(own.detail, /tells the orchestrator to commit and merge with git itself, which Codex's sandbox refuses/);
  assert.equal(own.steps[0].command, 'nextlevel init');

  // FR-008: the M6 orchestrator doc and the FR-003 worker doc are older templates now (they didn't say that the
  // hub merges and commits for a worker whose sandbox can't write git); the worker doc is replaced like the others
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-M6.md'))));
  assert.ok(OLD_TEMPLATES['docs/agents/WORKER.md'].includes(templateHash(read('./fixtures/WORKER-FR003.md'))));
  const worker = read('../templates/project/docs/agents/WORKER.md');
  const withWorker = (orch, guide, w) => ({ ...files(orch, guide), '/proj/docs/agents/WORKER.md': w, [`${tool}/WORKER.md`]: worker });
  const before = withWorker(read('./fixtures/ORCHESTRATOR-M6.md'), current.guide, read('./fixtures/WORKER-FR003.md'));
  assert.equal((await check('project.role-docs', { files: before })).detail, 'docs/agents/ORCHESTRATOR.md, docs/agents/WORKER.md: an older nextlevel template, unchanged');
  const olds = await fixed('project.role-docs', { files: before });
  assert.equal(olds.fixed, true);
  assert.equal(olds.ctx.files.get('/proj/docs/agents/WORKER.md'), worker);
  assert.equal(olds.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), current.orch);
  assert.equal((await check('project.role-docs', { files: withWorker(current.orch, current.guide, worker) })).quiet, true);
  // An own doc that escalates to an engine it names, instead of the workers' fallback: pointed at init
  const named = await check('project.role-docs', {
    files: files('# Mine\nUse nextlevel commit and nextlevel merge; keep docs/PROJECT.md.\nEscalation: `retry <id> --engine codex --feedback "..."`.\n', '# Guide\nMeanwhile: `nextlevel retry <id> --engine codex --feedback "rerun"`.\n'),
  });
  assert.equal(named.status, 'fail');
  assert.equal(named.detail, "docs/agents/ORCHESTRATOR.md, docs/agents/GUIDE.md: retry a task with --engine codex instead of the workers' fallback in nextlevel.json (retry --fallback, FR-008)");
  assert.deepEqual(named.old, [], "the owner's own text is never replaced");
  assert.equal(named.steps[0].command, 'nextlevel init');
});

test('project.role-docs (M10): the FR-008 role docs are older templates; an own orchestrator doc that edits the notes files by hand is pointed at init', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const [file, fixture] of [['docs/agents/ORCHESTRATOR.md', 'ORCHESTRATOR-FR008'], ['docs/agents/WORKER.md', 'WORKER-FR008'], ['docs/agents/GUIDE.md', 'GUIDE-FR008']]) {
    assert.ok(OLD_TEMPLATES[file].includes(templateHash(read(`./fixtures/${fixture}.md`))), `${fixture} is an older template`);
  }
  const current = { orch: read('../templates/project/docs/agents/ORCHESTRATOR.md'), guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  assert.match(current.orch, /nextlevel note list/);
  assert.match(current.orch, /nextlevel handoff add/);
  assert.match(current.orch, /never edit those two files by hand/);
  assert.match(current.worker, /\.nextlevel-task\/PROGRESS\.md/);
  assert.match(current.worker, /pnpm\.cmd/, 'the .cmd shims (FR-009)');
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const files = (orch, worker) => ({ '/proj/docs/agents/ORCHESTRATOR.md': orch, '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': worker, [`${tool}/ORCHESTRATOR.md`]: current.orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker });
  const old = await fixed('project.role-docs', { files: files(read('./fixtures/ORCHESTRATOR-FR008.md'), read('./fixtures/WORKER-FR008.md')) });
  assert.equal(old.fixed, true);
  assert.equal(old.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), current.orch);
  assert.equal(old.ctx.files.get('/proj/docs/agents/WORKER.md'), current.worker);
  const own = await check('project.role-docs', { files: files('# Mine\nUse nextlevel commit and nextlevel merge.\nMove handled notes in docs/OWNER_NOTES.md to Done; add steps to docs/HANDOFF.md.\n', current.worker) });
  assert.equal(own.status, 'fail');
  assert.match(own.detail, /docs\/agents\/ORCHESTRATOR\.md: has the orchestrator edit the owner's notes and the handoff list by hand, which nextlevel now writes from its cards/);
  assert.deepEqual(own.old, []);
  const commands = await check('project.role-docs', { files: files('# Mine\nUse nextlevel commit and nextlevel merge; keep docs/PROJECT.md.\nRead docs/OWNER_NOTES.md through nextlevel note list.\n', current.worker) });
  assert.equal(commands.quiet, true, 'an own doc that uses the commands is fine');
});

test('project.role-docs (the guard): the orchestrator and worker docs before it are older templates; the current ones name the protected files', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const [file, fixture] of [['docs/agents/ORCHESTRATOR.md', 'ORCHESTRATOR-M11'], ['docs/agents/WORKER.md', 'WORKER-M10'], ['docs/agents/ORCHESTRATOR.md', 'ORCHESTRATOR-GUARD1'], ['docs/agents/WORKER.md', 'WORKER-GUARD1']]) {
    assert.ok(OLD_TEMPLATES[file].includes(templateHash(read(`./fixtures/${fixture}.md`))), `${fixture} is an older template`);
  }
  const current = { orch: read('../templates/project/docs/agents/ORCHESTRATOR.md'), guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  for (const doc of [current.orch, current.worker]) {
    for (const p of ['.claude/', '.mcp.json', 'AGENTS.md', 'docs/agents/', 'nextlevel.json', 'START.cmd']) assert.ok(doc.includes(`\`${p}\``), p);
  }
  assert.match(current.orch, /Never put one in a task's "Files owned": `nextlevel dispatch` refuses such a spec/);
  assert.match(current.orch, /when the owner rejects it, the task comes back failed with the owner's reason/);
  assert.match(current.orch, /Never put `\.env`, or a value from it, into any file/);
  assert.match(current.worker, /\*\*Protected files:\*\* don't create, change or delete/);
  // the second part: git's own settings and hooks, and .env values never committed
  for (const doc of [current.orch, current.worker]) assert.match(doc, /Never change git's (own )?settings or hooks \(`git config`, `\.git\/hooks`/);
  assert.match(current.orch, /The hub never commits either/);
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const files = { '/proj/docs/agents/ORCHESTRATOR.md': read('./fixtures/ORCHESTRATOR-M11.md'), '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': read('./fixtures/WORKER-M10.md'), [`${tool}/ORCHESTRATOR.md`]: current.orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker };
  assert.equal((await check('project.role-docs', { files })).detail, 'docs/agents/ORCHESTRATOR.md, docs/agents/WORKER.md: an older nextlevel template, unchanged');
  const updated = await fixed('project.role-docs', { files });
  assert.equal(updated.fixed, true);
  assert.equal(updated.ctx.files.get('/proj/docs/agents/WORKER.md'), current.worker);
});

test('project.role-docs (M11): the M10 orchestrator doc is an older template; an own one that keeps no docs/PROJECT.md is pointed at init', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-M10.md'))), 'ORCHESTRATOR-M10 is an older template');
  const current = { orch: read('../templates/project/docs/agents/ORCHESTRATOR.md'), guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  // What the dashboard's Project page and Home's Blockers read: the project page, the plan header, labeled blockers
  assert.match(current.orch, /docs\/PROJECT\.md/);
  for (const heading of ['What it is', "Who it's for", 'Where it runs', 'How it works', 'Current state']) assert.ok(current.orch.includes(`**${heading}**`), heading);
  for (const f of ['Outcome:', 'Acceptance:', 'Try it:']) assert.ok(current.orch.includes(f), f);
  for (const label of ['Needs you:', 'Blocked by the tool:', 'Known limitation:', 'Decision:', 'Note:']) assert.ok(current.orch.includes(`**${label}**`), label);
  assert.match(current.orch, /take it out and add an entry to\s+`docs\/DECISIONS\.md`/, 'resolved blockers move to DECISIONS.md');
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const files = (orch) => ({ '/proj/docs/agents/ORCHESTRATOR.md': orch, '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': current.worker, [`${tool}/ORCHESTRATOR.md`]: current.orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker });
  const seen = await check('project.role-docs', { files: files(read('./fixtures/ORCHESTRATOR-M10.md')) });
  assert.equal(seen.detail, 'docs/agents/ORCHESTRATOR.md: an older nextlevel template, unchanged');
  const old = await fixed('project.role-docs', { files: files(read('./fixtures/ORCHESTRATOR-M10.md')) });
  assert.equal(old.fixed, true);
  assert.equal(old.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), current.orch);
  assert.equal((await check('project.role-docs', { files: files(current.orch) })).quiet, true);
  // The owner's own doc is never replaced: init shows the difference and asks
  const own = await fixed('project.role-docs', { files: files('# Mine\nUse nextlevel commit and nextlevel merge, nextlevel note and nextlevel handoff.\n') });
  assert.equal(own.status, 'fail');
  assert.equal(own.detail, "docs/agents/ORCHESTRATOR.md: doesn't have the orchestrator keep docs/PROJECT.md, the plan headers (Outcome, Acceptance, Try it) and the labeled blockers that the dashboard shows");
  assert.deepEqual(own.old, []);
  assert.equal(own.fixable, false);
  assert.equal(own.steps[0].command, 'nextlevel init');
});

test('project.role-docs (FR-012): the orchestrator and worker docs before it are older templates; the current ones have result files, whole reports and decisions only', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  for (const [file, fixture] of [['docs/agents/ORCHESTRATOR.md', 'ORCHESTRATOR-GUARD2'], ['docs/agents/WORKER.md', 'WORKER-GUARD2']]) {
    assert.ok(OLD_TEMPLATES[file].includes(templateHash(read(`./fixtures/${fixture}.md`))), `${fixture} is an older template`);
  }
  const current = { orch: read('../templates/project/docs/agents/ORCHESTRATOR.md'), guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  // The orchestrator: reads a shortened report's file before judging, result files for design, research and map tasks,
  // no remote scans from workers, DECISIONS for decisions only
  assert.match(current.orch, /a long report is shortened there, and it says so \("Shortened\s+here"\), with the report's length and the file that has all of it\. Read that file/);
  assert.match(current.orch, /Read all of the report before you judge: when `nextlevel result` says it is shortened, read the file it names/);
  assert.match(current.orch, /\*\*Design, research and map tasks put their result in a file under `docs\/`\*\*/);
  assert.match(current.orch, /`Result file: docs\/design\/M2-04-signup-design\.md` \(never a protected path\)/);
  assert.match(current.orch, /Don't ask workers to run remote scans such as `rafter run`: their branches aren't published/);
  assert.match(current.orch, /`docs\/DECISIONS\.md` records decisions only: what was decided and why/);
  assert.match(current.orch, /stays in that round's log, which the hub keeps\s+\(`\.nextlevel\/logs\/orchestrator-<time>\.log`\); anything the next round must know goes in `docs\/STATUS\.md`/);
  assert.match(current.orch, /Past\s+about 1,000 lines the doctor asks to archive it/);
  // The worker: the result goes in the result file, whole; the report stays short; no remote scans
  assert.match(current.worker, /\*\*A result file\.\*\* When the spec names one/);
  assert.match(current.worker, /Never put the result in the report alone/);
  assert.match(current.worker, /Don't run remote scans such as `rafter run`/);
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const files = { '/proj/docs/agents/ORCHESTRATOR.md': read('./fixtures/ORCHESTRATOR-GUARD2.md'), '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': read('./fixtures/WORKER-GUARD2.md'), [`${tool}/ORCHESTRATOR.md`]: current.orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker };
  assert.equal((await check('project.role-docs', { files })).detail, 'docs/agents/ORCHESTRATOR.md, docs/agents/WORKER.md: an older nextlevel template, unchanged');
  const updated = await fixed('project.role-docs', { files });
  assert.equal(updated.fixed, true);
  assert.equal(updated.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), current.orch);
  assert.equal(updated.ctx.files.get('/proj/docs/agents/WORKER.md'), current.worker);
});

test('project.role-docs (FR-014): the orchestrator doc before it is an older template; the current one puts text in files and answers on the cards', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-FR012.md'))), 'ORCHESTRATOR-FR012 is an older template');
  const orch = read('../templates/project/docs/agents/ORCHESTRATOR.md');
  assert.match(orch, /\*\*Text goes to nextlevel in a\s+file, never in the command itself\*\*: on Windows nextlevel runs through `nextlevel\.cmd`, where an argument ends at\s+its first line break/);
  assert.match(orch, /`nextlevel handoff add --file \.nextlevel\/request\.md --task M2-03`/);
  assert.match(orch, /`nextlevel handoff answer <id> --file \.nextlevel\/answer\.md`/);
  assert.match(orch, /The owner's phone gets a message that names the card, so don't send the answer with\s+`nextlevel notify` as well/);
  assert.match(orch, /`nextlevel handoff show <id>` shows a\s+card whole/);
  assert.doesNotMatch(orch, /nextlevel handoff add "/, 'no request text in the command any more');
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const current = { guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  const files = { '/proj/docs/agents/ORCHESTRATOR.md': read('./fixtures/ORCHESTRATOR-FR012.md'), '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': current.worker, [`${tool}/ORCHESTRATOR.md`]: orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker };
  assert.equal((await check('project.role-docs', { files })).detail, 'docs/agents/ORCHESTRATOR.md: an older nextlevel template, unchanged');
  const updated = await fixed('project.role-docs', { files });
  assert.equal(updated.fixed, true);
  assert.equal(updated.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), orch);
});

test('project.role-docs (FR-016): the orchestrator doc before it is an older template; the current one names the plan\'s path and its Milestone line', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-FR017.md'))), 'ORCHESTRATOR-FR017 is an older template');
  const orch = read('../templates/project/docs/agents/ORCHESTRATOR.md');
  // The exact path and header the Project page reads first, and that the doctor warns when it can't find a plan
  assert.match(orch, /Write the milestone's plan first, as\s+`docs\/plans\/<milestone id or name>\.md`: its id when it has one \(`docs\/plans\/M2\.md` for "M2 Sign-up and sign-in"\),\s+else its name in lowercase with `-` between the words \(`docs\/plans\/walking-skeleton\.md` for "Walking skeleton"\)/);
  assert.match(orch, /It starts with its title and a line `Milestone: <the milestone's name exactly as in docs\/STATUS\.md>`, which is how\s+the dashboard's Project page finds the plan/);
  assert.match(orch, /# M2 — Sign-up and sign-in\n\n {2}Milestone: M2 Sign-up and sign-in\n {2}Outcome: /, 'the example has the line, under the title');
  assert.match(orch, /the Project page and the doctor say so \(its row\s+"Milestone plans": `nextlevel verify doctor -- nextlevel doctor`\): fix the plan's name or its Milestone line/);
  // The example plan in the role doc is found by its Milestone line, with all three fields
  const example = orch.match(/ {2}```\n((?: {2}# M2[\s\S]*?))\n {2}```/)[1].replace(/^ {2}/gm, '');
  const r = buildRoadmap({ status: [{ name: 'M2 Sign-up and sign-in', state: 'in progress', verified: '', done: false }], plans: [{ file: 'docs/plans/sign-up.md', ...parsePlan(example) }], specs: [{ id: 'M2-01-accounts', milestone: 'M2' }] });
  assert.deepEqual([r[0].plan.by, r[0].missing, planProblems(r)], ['header', [], []]);
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const current = { guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  const files = { '/proj/docs/agents/ORCHESTRATOR.md': read('./fixtures/ORCHESTRATOR-FR017.md'), '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': current.worker, [`${tool}/ORCHESTRATOR.md`]: orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker };
  assert.equal((await check('project.role-docs', { files })).detail, 'docs/agents/ORCHESTRATOR.md: an older nextlevel template, unchanged');
  const updated = await fixed('project.role-docs', { files });
  assert.equal(updated.fixed, true);
  assert.equal(updated.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), orch);
});

test('project.role-docs (FR-019): the orchestrator doc before it is an older template; the current one ends a round with nothing new without a commit, and asks for wake-ups only for what is outside the hub', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-FR016.md'))), 'ORCHESTRATOR-FR016 is an older template');
  const orch = read('../templates/project/docs/agents/ORCHESTRATOR.md');
  assert.ok(!OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(orch)), 'the current one is not');
  assert.match(orch, /\*\*What starts the next round is the hub's to decide\*\*/);
  assert.match(orch, /\*\*A round with nothing new ends without a commit\.\*\*/);
  assert.match(orch, /Plan and dispatch in the same round: a round that\s+dispatches, merges, retries or closes a task gets the next round straight after it/);
  assert.match(orch, /\*\*Waiting on CI\*\*, or anything else outside the hub that the next round must read and that is still going on: a\s+wake-up, `nextlevel wakeup <minutes> --reason "what the next round reads"`, for about as long as it usually takes/);
  assert.match(orch, /Don't wait for CI inside a round \(waiting\s+for your own check, push or merge jobs with `nextlevel wait` is fine/);
  assert.match(orch, /don't queue a check that polls CI: checks and pushes run one at a time/);
  assert.match(orch, /A round that asks for a wake-up gets no round right after it: the wake-up is its next round\./);
  assert.match(orch, /\*\*Never to wait for the owner:\*\* their reply wakes the team anyway\./);
  assert.doesNotMatch(orch, /update STATUS, commit — then end your turn/, "the FR-016 doc's rule: a commit every round");
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const current = { guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  const files = { '/proj/docs/agents/ORCHESTRATOR.md': read('./fixtures/ORCHESTRATOR-FR016.md'), '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': current.worker, [`${tool}/ORCHESTRATOR.md`]: orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker };
  assert.equal((await check('project.role-docs', { files })).detail, 'docs/agents/ORCHESTRATOR.md: an older nextlevel template, unchanged');
  const updated = await fixed('project.role-docs', { files });
  assert.equal(updated.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), orch);
});

test('project.role-docs (FR-021): the orchestrator doc before it is an older template; the current one closes a task with nextlevel close, never only in the docs', async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-FR019.md'))), 'ORCHESTRATOR-FR019 is an older template');
  const orch = read('../templates/project/docs/agents/ORCHESTRATOR.md');
  assert.ok(!OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(orch)), 'the current one is not');
  assert.match(orch, /## Closing a task\nA task you won't build is closed with `nextlevel close`, never only by editing the docs/);
  assert.match(orch, /`nextlevel close M2-04-signup --reason "replaced by M2-05-signup-form and M2-06-signup-api"`/);
  assert.match(orch, /A task whose branch has work that isn't merged is closed only with `--discard`/);
  assert.match(orch, /Dispatching or retrying a closed task opens it again\. Keep the story in `docs\/STATUS\.md` and `docs\/DECISIONS\.md` as\s+before/);
  assert.doesNotMatch(read('./fixtures/ORCHESTRATOR-FR019.md'), /nextlevel close/, 'the FR-019 doc had no way to close a task');
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const current = { guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  const files = { '/proj/docs/agents/ORCHESTRATOR.md': read('./fixtures/ORCHESTRATOR-FR019.md'), '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': current.worker, [`${tool}/ORCHESTRATOR.md`]: orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker };
  assert.equal((await check('project.role-docs', { files })).detail, 'docs/agents/ORCHESTRATOR.md: an older nextlevel template, unchanged');
  const updated = await fixed('project.role-docs', { files });
  assert.equal(updated.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), orch);
});

test("project.role-docs (FR-020): the orchestrator doc before it (FR-021's) is an older template; the current one judges an attempt's own work, reviews one finished without a report, and says which attempts count", async () => {
  const read = (f) => fs.readFileSync(new URL(f, import.meta.url), 'utf8');
  assert.ok(OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(read('./fixtures/ORCHESTRATOR-FR021.md'))), 'ORCHESTRATOR-FR021 is an older template');
  const orch = read('../templates/project/docs/agents/ORCHESTRATOR.md');
  assert.ok(!OLD_TEMPLATES['docs/agents/ORCHESTRATOR.md'].includes(templateHash(orch)), 'the current one is not');
  assert.match(orch, /Judge \*\*this attempt's own work\*\*/);
  assert.match(orch, /`nextlevel result` lists this attempt's own commits and diff stat first,\s+then the branch's/);
  assert.match(orch, /A missing report always says why: the time limit, the engine stopped \(exit N\) or ended with an error of its own/);
  assert.match(orch, /\*\*Finished without a report, verify passed\*\* \(`done`, marked so\)/);
  assert.match(orch, /Don't retry only because the report is missing\./);
  assert.match(orch, /`no-changes`: this attempt made no commits of its own\./);
  assert.match(orch, /A failed\s+attempt is one that ended `failed`, `timeout` or `no-changes`, with or without a report; one finished without a\s+report whose verify passed is not, and neither is a run stopped from outside or a worker that didn't start\./);
  const tool = '/home/me/.nextlevel/tool/templates/project/docs/agents';
  const current = { guide: read('../templates/project/docs/agents/GUIDE.md'), worker: read('../templates/project/docs/agents/WORKER.md') };
  const files = { '/proj/docs/agents/ORCHESTRATOR.md': read('./fixtures/ORCHESTRATOR-FR021.md'), '/proj/docs/agents/GUIDE.md': current.guide, '/proj/docs/agents/WORKER.md': current.worker, [`${tool}/ORCHESTRATOR.md`]: orch, [`${tool}/GUIDE.md`]: current.guide, [`${tool}/WORKER.md`]: current.worker };
  assert.equal((await check('project.role-docs', { files })).detail, 'docs/agents/ORCHESTRATOR.md: an older nextlevel template, unchanged');
  const updated = await fixed('project.role-docs', { files });
  assert.equal(updated.ctx.files.get('/proj/docs/agents/ORCHESTRATOR.md'), orch);
});

test("project.deploy-branches (FR-015): not set, the base branch counts as one and the doctor says how to name them, and can; a list, none, and a nextlevel.json the team could change", async () => {
  const unset = await check('project.deploy-branches', { files: { '/proj/nextlevel.json': '{ "version": 1 }' } });
  assert.equal(unset.status, 'fail');
  assert.equal(unset.severity, 'info');
  assert.equal(unset.detail, 'not set, so the base branch main counts as one: a push to it waits for your approval on the dashboard');
  assert.equal(unset.next, 'to name them yourself, put "deployBranches": ["main"] in nextlevel.json: the branches on origin a push to which deploys (or might), [] if none does. The doctor can write it (answer y)');
  const trunk = await check('project.deploy-branches', { config: { baseBranch: 'trunk' } });
  assert.match(trunk.detail, /^not set, so the base branch trunk counts as one/);
  const two = await check('project.deploy-branches', { files: { '/proj/nextlevel.json': '{ "deployBranches": ["main", "production"] }' } });
  assert.equal(two.status, 'ok');
  assert.equal(two.detail, 'main, production: a push to one of them waits for your approval on the dashboard');
  const none = await check('project.deploy-branches', { files: { '/proj/nextlevel.json': '{ "deployBranches": [] }' } });
  assert.equal(none.status, 'ok');
  assert.equal(none.detail, 'none: deployBranches is [] in nextlevel.json, so every push goes out without asking you');
  // The list is the owner's only while nextlevel.json is protected
  const open = await check('project.deploy-branches', { config: { protected: { remove: ['nextlevel.json'] } } });
  assert.equal(open.status, 'fail');
  assert.equal(open.severity, 'warn');
  assert.equal(open.detail, 'nextlevel.json isn\'t protected ("protected" in it removes it): the team could change deployBranches without you');
  // The fix writes the base branch in, keeping the rest of the file (and its CRLF line ends), and the check passes
  const file = '{\r\n  "version": 1,\r\n  "name": "proj",\r\n  "baseBranch": "trunk"\r\n}\r\n';
  const f = await fixed('project.deploy-branches', { config: { baseBranch: 'trunk' }, files: { '/proj/nextlevel.json': file } });
  assert.equal(f.fixed, true);
  const written = f.ctx.files.get('/proj/nextlevel.json');
  assert.deepEqual(JSON.parse(written), { version: 1, name: 'proj', baseBranch: 'trunk', deployBranches: ['trunk'] });
  assert.match(written, /\r\n {2}"deployBranches": \["trunk"\]\r\n\}\r\n$/);
  assert.match(f.ui.said.join('\n'), /Wrote "deployBranches": \["trunk"\] into nextlevel\.json\. Commit it with your next change\./);
});

test('project.decisions: a docs/DECISIONS.md past about 1,000 lines warns, with how to archive its older entries in plain words (FR-012)', async () => {
  const entries = (n) => Array.from({ length: n }, (_, i) => `## 2026-09-${String((i % 28) + 1).padStart(2, '0')} - Round ${i + 1}\n\nMerged, retried and dispatched.\n`).join('\n');
  const none = await check('project.decisions', {});
  assert.equal(none.status, 'ok');
  assert.equal(none.quiet, true);
  const short = await check('project.decisions', { files: { '/proj/docs/DECISIONS.md': entries(10) } });
  assert.equal(short.status, 'ok');
  assert.equal(short.detail, '39 lines');
  // A real project's, at almost 6,000 lines (CRLF line ends count the same)
  const long = await check('project.decisions', { files: { '/proj/docs/DECISIONS.md': entries(1470).replace(/\n/g, '\r\n') } });
  assert.equal(long.status, 'fail');
  assert.equal(long.severity, 'warn');
  assert.equal(long.detail, 'docs/DECISIONS.md has 5,879 lines, past about 1,000: the orchestrator reads it at every start, so every round pays for it and the decisions that matter get lost in it');
  assert.equal(long.next, "archive its older entries: move them, whole, to the end of docs/DECISIONS-archive.md, and keep only decisions in docs/DECISIONS.md from now on (what was decided and why; what happened in a round is in that round's log)");
  assert.equal(long.steps[0].window, 'terminal');
  assert.equal(long.steps[0].cwd, '/proj');
  assert.equal(
    long.steps[0].command,
    'nextlevel note add "Archive docs/DECISIONS.md: move every entry but the newest (keep about the last 200 lines) to the end of docs/DECISIONS-archive.md, whole and in their order, and put a line at the top of docs/DECISIONS.md that names the archive. Commit both. From now on docs/DECISIONS.md records decisions only: what was decided and why."',
  );
  assert.equal(long.steps[1].window, 'editor');
  assert.match(long.steps[1].text, /^or by hand, while no autopilot round runs: in docs\/DECISIONS\.md, cut every entry but the newest .* put a line "Older decisions: docs\/DECISIONS-archive\.md" at the top of docs\/DECISIONS\.md, and commit both files$/);
  assert.equal(byId('project.decisions').fix, undefined, 'no automatic fix: the orchestrator keeps that file');
  // At the limit it passes; paths.decisions elsewhere names its own archive
  assert.equal((await check('project.decisions', { files: { '/proj/docs/DECISIONS.md': 'x\n'.repeat(1000) } })).status, 'ok');
  const moved = await check('project.decisions', { config: { paths: { decisions: 'notes/decisions.txt' } }, files: { '/proj/notes/decisions.txt': 'x\n'.repeat(1001) } });
  assert.match(moved.next, /the end of notes\/decisions-archive\.txt/);
  // A path a shell would read things in, pasted between quotes, gets no command to copy: the steps by hand only
  const odd = await check('project.decisions', { config: { paths: { decisions: 'docs/$(x).md' } }, files: { '/proj/docs/$(x).md': 'x\n'.repeat(1001) } });
  assert.deepEqual(odd.steps.map((s) => s.window), ['editor']);
  assert.match(odd.steps[0].text, /^by hand, while no autopilot round runs/);
});

test("project.plans (FR-016): the plans the Project page finds, from the same files: a real project's on 30 September, one gone, one incomplete, two for one milestone", async () => {
  const BOM = String.fromCharCode(0xfeff);
  const fixture = (f) => fs.readFileSync(new URL(`./fixtures/fr016/${f}`, import.meta.url), 'utf8');
  const spec = (id, milestone) => `# ${id} - test\n\nKind: code\nMilestone: ${milestone}\n\n## Goal\nTest.\n`;
  const job = (id, type, state) => JSON.stringify({ id, type, state, attempt: 1 });
  const sample = {
    '/proj/docs/STATUS.md': BOM + fixture('STATUS.md'),
    '/proj/docs/plans/M0-foundation.md': BOM + fixture('plans/M0-foundation.md'),
    '/proj/docs/plans/M1-accounts-households.md': fixture('plans/M1-accounts-households.md'),
    '/proj/docs/plans/WS-walking-skeleton.md': fixture('plans/WS-walking-skeleton.md'),
    '/proj/docs/tasks/_TEMPLATE.md': spec('<task-id>', 'M<n>'),
    '/proj/docs/tasks/M0-02-app-health.md': spec('M0-02-app-health', 'M0'),
    '/proj/docs/tasks/M1-18-web-sessions.md': spec('M1-18-web-sessions', 'M1'),
    '/proj/docs/tasks/WS-01-recipe-store-design.md': spec('WS-01-recipe-store-design', 'Walking skeleton'),
    '/proj/docs/tasks/WS-34A-list-checker.md': spec('WS-34A-list-checker', 'Walking skeleton'),
    // the hub's jobs: a task's, and jobs that are no task (a commit, the bridge test, one being written)
    '/proj/.nextlevel/jobs/WS-34A-list-checker/status.json': job('WS-34A-list-checker', 'task', 'running'),
    '/proj/.nextlevel/jobs/commit-20260930-101500-ab12/status.json': job('commit-20260930-101500-ab12', 'git', 'done'),
    '/proj/.nextlevel/jobs/T000-bridge-1/status.json': job('T000-bridge-1', 'task', 'done'),
    '/proj/.nextlevel/jobs/half-written/status.json': '{"id": "half',
  };
  // M0-01's spec and job are gone; its merge is in git
  const merges = (...ids) => ({ 'git log --merges --format=%cI%x09%s -n 2000': ids.map((id) => `2026-09-26T09:00:00+02:00\tMerge branch 'task/${id}'`).join('\n') });
  const commands = merges('M0-01-workspace-db');
  const all = await check('project.plans', { files: sample, commands });
  assert.equal(all.status, 'ok');
  assert.equal(all.quiet, true);
  assert.equal(all.detail, '3 plans for 10 milestones; each with tasks has one, with Outcome, Acceptance and Try it');

  // The Walking skeleton's plan under a name nothing finds, and M0's without its Try it
  const others = Object.fromEntries(Object.entries(sample).filter(([f]) => !f.endsWith('/WS-walking-skeleton.md')));
  const gone = { ...others, '/proj/docs/plans/first-recipe.md': '# First recipe\n\nOutcome: x\n', '/proj/docs/plans/M0-foundation.md': fixture('plans/M0-foundation.md').replace('Try-it:', 'Steps:') };
  const r = await check('project.plans', { files: gone, commands });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warn');
  assert.equal(r.detail, [
    'M0 Foundation: its plan, docs/plans/M0-foundation.md, has no Try it (a line "Try it:" in its header).',
    'Walking skeleton has 2 tasks but no plan: no file in docs/plans/ names it. Files there that match no milestone: first-recipe.md. Its plan goes in docs/plans/walking-skeleton.md, with the line "Milestone: Walking skeleton" under its title.',
  ].join(' '));
  assert.equal(r.next, 'the orchestrator keeps one plan per milestone, docs/plans/<milestone id or name>.md, with the line "Milestone: <its name as in docs/STATUS.md>" under its title, then Outcome, Acceptance and Try it (its role doc, "Planning")');
  assert.deepEqual(r.steps.map((s) => s.window), ['browser', 'terminal']);
  assert.match(r.steps[0].text, /^On the dashboard \(START\.cmd -> d\): Project\./);
  assert.equal(r.steps[1].cwd, '/proj');
  assert.match(r.steps[1].command, /^nextlevel note add "Fix the milestone plans the doctor warns about: M0 Foundation: its plan, docs\/plans\/M0-foundation\.md, has no Try it \(a line 'Try it:' in its header\)\. Walking skeleton has 2 tasks/);
  assert.match(r.steps[1].command, /with the line Milestone: <its name as in docs\/STATUS\.md> under its title, then Outcome, Acceptance and Try it\."$/);
  assert.equal(r.steps[1].command.slice('nextlevel note add "'.length, -1).includes('"'), false, 'no quote inside the one the command has');
  assert.equal(byId('project.plans').fix, undefined, 'no automatic fix: the orchestrator keeps the plans');

  // Two plans for the Walking skeleton: the one whose Milestone line names it is shown
  const two = await check('project.plans', { files: { ...sample, '/proj/docs/plans/walking-skeleton.md': '# Walking skeleton\n\nMilestone: Walking skeleton\nOutcome: x\nAcceptance: y\nTry it:\n1. z\n' }, commands });
  assert.equal(two.detail, 'Walking skeleton: 2 plans claim it, docs/plans/walking-skeleton.md and docs/plans/WS-walking-skeleton.md. The page shows docs/plans/walking-skeleton.md, whose "Milestone:" line names it. Keep one plan per milestone in docs/plans/.');

  // A task only the hub's job knows of, and one only git's merge does: each makes its milestone one with tasks
  const job2 = await check('project.plans', { files: { ...sample, '/proj/.nextlevel/jobs/M2-01-recipe-search/status.json': job('M2-01-recipe-search', 'task', 'queued') }, commands });
  assert.match(job2.detail, /^M2 Recipes and search has 1 task but no plan: .* Its plan goes in docs\/plans\/M2\.md, with the line "Milestone: M2 Recipes and search" under its title\.$/);
  const merged3 = await check('project.plans', { files: sample, commands: merges('M0-01-workspace-db', 'M3-01-planner-shell') });
  assert.match(merged3.detail, /^M3 Meal planner has 1 task but no plan/);
  // A plans folder of its own (paths.plans)
  const own = await check('project.plans', { files: Object.fromEntries(Object.entries(sample).map(([f, t]) => [f.replace('/docs/plans/', '/plans/'), t])), config: { paths: { plans: 'plans' } }, commands });
  assert.equal(own.status, 'ok');

  // A name PowerShell or nextlevel.cmd would change, pasted between quotes: no command to copy
  const strange = (t) => t.replace('Walking skeleton', 'Walking skeleton & $more');
  const odd = await check('project.plans', { files: { ...gone, '/proj/docs/STATUS.md': strange(fixture('STATUS.md')), '/proj/docs/tasks/WS-01-recipe-store-design.md': strange(gone['/proj/docs/tasks/WS-01-recipe-store-design.md']), '/proj/docs/tasks/WS-34A-list-checker.md': strange(gone['/proj/docs/tasks/WS-34A-list-checker.md']) }, commands });
  assert.match(odd.detail, /Walking skeleton & \$more has 2 tasks but no plan/);
  assert.deepEqual(odd.steps.map((s) => s.window), ['browser']);
  // No milestones yet, no project
  assert.deepEqual([(await check('project.plans', {})).status, (await check('project.plans', {})).quiet, (await check('project.plans', {})).detail], ['ok', true, 'no milestones yet']);
  assert.equal((await check('project.plans', { root: null })).status, 'skip');
});

test('codex.worker-windows: Codex workers in its sandbox on Windows: a warning that names the tasks that fail there (Docker, package installs) and the switch out of it (FR-009)', async () => {
  // The default team on Windows: Antigravity workers, Codex as their fallback
  const r = await check('codex.worker-windows', { platform: 'win32' });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warn');
  assert.match(r.detail, /^the workers' fallback runs on Codex in its sandbox: on Windows a worker there is refused anything that starts Docker \(a stack, compose, an integration check that needs containers\) or reads ~\/\.docker, and package installs \(pnpm install: its store is in your AppData, which the sandbox's account can't write\), and turning its network on doesn't change that$/);
  assert.match(r.next, /take Codex workers out of it, like your other workers/);
  assert.deepEqual(r.steps.map((s) => [s.window, s.command]), [['terminal', 'nextlevel team sandbox off'], ['terminal', 'nextlevel team set worker-fallback --engine agy --model <model>']]);
  assert.match(r.steps[0].text, /Team -> Codex workers.*bridge-test --engine codex/);
  assert.match(r.steps[1].text, /stronger model than the workers' own \(a Claude one\): nextlevel team models agy lists them/);
  // Workers on Codex themselves: the switch, or another engine for them
  const workers = await check('codex.worker-windows', { platform: 'win32', config: { roles: { worker: { engine: 'codex', fallback: 'agy' } } } });
  assert.match(workers.detail, /^the workers run on Codex in its sandbox/);
  assert.deepEqual(workers.steps.map((s) => s.command), ['nextlevel team sandbox off', 'nextlevel team set worker --engine agy']);
  // The sandbox with its network on, for workers only: the same warning (the network doesn't help)
  assert.equal((await check('codex.worker-windows', { platform: 'win32', config: { engines: { codex: { workerArgs: ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'] } } } })).status, 'fail');
  // A stronger model on the workers' engine as the fallback: nothing to say
  assert.equal((await check('codex.worker-windows', { platform: 'win32', config: { roles: { worker: { engine: 'agy', fallback: { engine: 'agy', model: 'claude-opus-4-6' } } } } })).quiet, true);
  // Codex's sandbox off for its workers (their own arguments, or args from before them), or not Windows: nothing to say
  const off = await check('codex.worker-windows', { platform: 'win32', config: { engines: { codex: { args: ['--sandbox', 'workspace-write'], workerArgs: ['--sandbox', 'danger-full-access', '-c', 'approval_policy=never'] } } } });
  assert.deepEqual([off.status, off.quiet, off.detail], ['ok', true, "Codex's sandbox is off for its workers (engines.codex.workerArgs)"]);
  assert.equal((await check('codex.worker-windows', { platform: 'win32', config: { engines: { codex: { args: ['--sandbox', 'danger-full-access'] } } } })).quiet, true);
  // ... and the orchestrator's args without the sandbox don't take the workers out of it once they have their own
  assert.equal((await check('codex.worker-windows', { platform: 'win32', config: { engines: { codex: { args: ['--sandbox', 'danger-full-access'], workerArgs: ['--sandbox', 'workspace-write'] } } } })).status, 'fail');
  const linux = await check('codex.worker-windows');
  assert.equal(linux.status, 'skip');
  assert.equal(linux.quiet, true);
});

test('slots.ports: the offsets this project\'s slots get, unique on this PC (FR-004 #7)', async () => {
  assert.match((await check('slots.ports')).detail, /given out when the hub first starts/);
  const mine = await check('slots.ports', { userState: { portBlocks: { '/proj': 2, '/other': 0 } } });
  assert.equal(mine.detail, 'NEXTLEVEL_PORT_OFFSET 2100, 2200 (no other project on this PC has them)');
  const clash = await check('slots.ports', { userState: { portBlocks: { '/proj': 1, '/other': 1 } }, dirs: ['/other'] });
  assert.equal(clash.status, 'fail');
  assert.match(clash.detail, /the same as the project in \/other/);
  assert.equal((await check('slots.ports', { platform: 'win32', userState: { portBlocks: { 'c:\\proj': 3 } } })).detail, 'NEXTLEVEL_PORT_OFFSET 3100, 3200 (no other project on this PC has them)');
});

test('tool.agy: older than 1.2.4 gets agy update and a new window; unused engines are only notes (FR-001 #4)', async () => {
  const old = await fixed('tool.agy', { commands: { 'agy --version': '1.1.16' } });
  assert.match(old.detail, /^1\.1\.16: older than 1\.2\.4/);
  assert.equal(old.severity, 'error');
  assert.deepEqual(old.ui.ran, ['agy update']);
  const guided = await check('tool.agy', { commands: { 'agy --version': '1.1.16' } });
  assert.deepEqual(guided.steps.map((s) => [s.window, s.command]), [['terminal', 'agy update'], ['new-terminal', 'nextlevel doctor']]);
  const missing = await check('tool.agy', { platform: 'win32', commands: {} });
  assert.match(missing.steps[0].command, /install\.ps1 \| iex/);
  const unused = await check('tool.agy', { commands: {}, config: { roles: { worker: { engine: 'codex' } } } });
  assert.equal(unused.severity, 'info');
  assert.equal((await check('tool.agy', { commands: AGY })).status, 'ok');
});

test('agy.login and agy.model', async () => {
  assert.equal((await check('agy.login', { commands: AGY })).status, 'ok');
  const out = await check('agy.login', { commands: { ...AGY, 'agy models': { ok: false, out: 'Please sign in' } } });
  assert.equal(out.detail, 'not signed in');
  assert.deepEqual(out.steps.map((s) => s.window), ['terminal', 'agy']);
  assert.equal((await check('agy.login', { commands: { ...AGY, 'agy models': { ok: false, timedOut: true } } })).detail, 'unknown (no answer)');

  // No pinned model: agy's own, tried as a worker runs (FR-010, FR-022): the whole command, its folder, and the version
  const TRIAL = `agy -p "nextlevel model check:…" --print-timeout 2m --output-format stream-json --dangerously-skip-permissions --mode accept-edits --agent nextlevel-worker, in /tmp/nextlevel-agy-trial, headless`;
  const own = await check('agy.model', { commands: AGY });
  assert.equal(own.status, 'ok', own.detail);
  assert.equal(own.detail, `agy's default model (ran as a worker runs, on agy 1.2.11). It ran: ${TRIAL}.`);
  const listed = await check('agy.model', { commands: AGY, config: { roles: { worker: { model: 'gemini-3-pro' } } } });
  assert.equal(listed.detail, `gemini-3-pro (listed by agy models, and ran as a worker runs, on agy 1.2.11). It ran: ${TRIAL.replace('--print-timeout 2m', '--print-timeout 2m --model gemini-3-pro')}.`);
  const bad = await check('agy.model', { commands: AGY, config: { roles: { worker: { model: 'gemini-3' } } } });
  assert.equal(bad.status, 'fail', 'a prefix of a listed name is not a listed name');
  assert.match(bad.detail, /"gemini-3" \(roles\.worker\.model\) not in agy models/);
  // The trial is the worker's exact command line, in a real console (runConsole), with the one-line prompt; never --effort,
  // and the check says so when engines.agy.args has one (the owner's question on a real project, FR-022)
  const ctx = fakeContext({ commands: AGY, config: { roles: { worker: { model: 'gemini-3-pro' } }, engines: { agy: { args: ['--dangerously-skip-permissions', '--mode', 'accept-edits', '--effort', 'high'] } } } });
  const withEffort = (await runChecks(ctx, { checks: ['tool.agy', 'agy.login', 'agy.model'].map((id) => byId(id)) })).at(-1);
  assert.equal(withEffort.status, 'ok');
  assert.match(withEffort.detail, / engines\.agy\.args also has --effort high: not passed, since Antigravity takes the level from the model's name \(nextlevel doctor --fix agy\.effort takes it out\)$/);
  // (as the agent a worker runs as, FR-013: the agent's file written where the trial runs, its YAML quoted, FR-022)
  assert.deepEqual(ctx.consoleCalls, [`agy -p ${AGY_PROBE} --print-timeout 2m --model gemini-3-pro --output-format stream-json --dangerously-skip-permissions --mode accept-edits --agent nextlevel-worker`]);
  const agentFile = ctx.read('/tmp/nextlevel-agy-trial/.agents/agents/nextlevel-worker.md');
  assert.match(agentFile, /^inheritCustomizations: false$/m);
  assert.match(agentFile, /^description: "A worker of nextlevel's build team: one task in its slot\. Written by the nextlevel hub at every task start\."$/m);
  // ...and kept: the same run and version aren't tried again
  await runChecks(ctx, { checks: [byId('agy.model')] });
  assert.equal(ctx.consoleCalls.length, 1);
  // A model agy refuses with those flags: the Team page doesn't save it (FR-010: every attempt failed on the owner's PC)
  const refused = await check('agy.model', { commands: { ...AGY, 'agy models': 'gemini-3-pro\nclaude-opus-4-6-thinking', 'agy -p *': agyRun({ refuse: ['claude-opus-4-6-thinking'] }) }, config: { roles: { worker: { model: 'claude-opus-4-6-thinking' } } } });
  assert.equal(refused.status, 'fail');
  assert.equal(refused.severity, 'error', 'the workers run on it');
  assert.match(refused.detail, /^"claude-opus-4-6-thinking" \(roles\.worker\.model\) was refused on agy 1\.2\.11: model claude-opus-4-6-thinking is not available for your plan, exit 1\. It ran: agy -p "nextlevel model check:…" --print-timeout 2m --model claude-opus-4-6-thinking /);
  assert.match(refused.detail, /\nWhat agy printed last:\nError: model claude-opus-4-6-thinking is not available for your plan$/);
  assert.deepEqual(refused.steps.map((s) => s.window), ['terminal', 'editor']);
  // A refusal is kept an hour (a plan or quota can change): the next doctor run doesn't try again, a Team page save
  // (retryRefusals) and Check again (fresh) do
  const refusing = fakeContext({ commands: { ...AGY, 'agy -p *': agyRun({ refuse: ['gemini-3-pro'] }) }, config: { roles: { worker: { model: 'gemini-3-pro' } } } });
  for (let i = 0; i < 2; i++) await runChecks(refusing, { checks: [byId('agy.model')] });
  assert.equal(refusing.consoleCalls.length, 1, 'a refusal is kept');
  refusing.retryRefusals = true;
  await runChecks(refusing, { checks: [byId('agy.model')] });
  assert.equal(refusing.consoleCalls.length, 2, 'a Team page save tries again');
  ctx.fresh = true;
  await runChecks(ctx, { checks: [byId('agy.model')] });
  assert.equal(ctx.consoleCalls.length, 2, 'Check again: tried afresh');
  // A result that isn't SUCCESS is a refusal too, in agy's own words; no answer in time is a warning
  const status = await check('agy.model', { commands: { ...AGY, 'agy -p *': { ok: false, code: 1, out: 'error: quota exhausted\n{"event":"result","result":{"status":"ERROR","response":"","error":"quota exhausted"}}' } } });
  assert.match(status.detail, /^agy's default model was refused on agy 1\.2\.11: quota exhausted, exit 1\. It ran: /);
  const slow = await check('agy.model', { commands: { ...AGY, 'agy -p *': { ok: false, timedOut: true } } });
  assert.equal(slow.severity, 'warn');
  // agy's own model, from its settings: named
  const named = await check('agy.model', { commands: AGY, files: { '/home/me/.gemini/antigravity-cli/settings.json': '{"model":"Gemini 3.8 Flash (High)"}' } });
  assert.match(named.detail, /^agy's own model "Gemini 3\.8 Flash \(High\)" \(picked with \/model\) \(ran as a worker runs, on agy 1\.2\.11\)\. It ran: /);
});

test('agy.model (FR-022): agy 1.3.4 said why, the versions are named, the trial runs what a worker runs, and the check stays strict', async () => {
  // What agy 1.3.5 printed on the owner's PC for the doctor's trial (redacted: the PC's paths and names)
  const unknown = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'agy-1.3.5-unknown-agent.txt'), 'utf8');
  const AGY134 = { ...AGY, 'agy --version': '1.3.4', 'agy -p *': { ok: false, code: 1, out: unknown } };
  // The version it last passed on is named with the one it is refused on
  const ctx = fakeContext({ commands: AGY, config: { roles: { worker: { model: 'gemini-3-pro' } } } });
  const passed = (await runChecks(ctx, { checks: [byId('agy.model')] }))[0];
  assert.match(passed.detail, /on agy 1\.2\.11\)/);
  const after = fakeContext({ commands: AGY134, config: { roles: { worker: { model: 'gemini-3-pro' } } } });
  Object.assign(after.cacheData, ctx.cacheData); // (the same project's check-cache.json)
  const r = (await runChecks(after, { checks: [byId('agy.model')] }))[0];
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /^"gemini-3-pro" \(roles\.worker\.model\) was refused on agy 1\.3\.4 \(passed on 1\.2\.11\): unknown agent "nextlevel-worker" \(available: [^)]*\), exit 1\. It ran: agy -p "nextlevel model check:…" /);
  assert.doesNotMatch(r.detail, /^[^\n]*: ERROR[,.]/, 'never just ERROR');
  assert.match(r.detail, /\nWhat agy printed last:\nerror: unknown agent "nextlevel-worker"/);
  assert.ok(r.detail.split('\nWhat agy printed last:\n')[1].split('\n').length <= 20, 'about 20 lines at most');
  // After 1.3.2 the agent the trial runs as lists its tools, as a worker's does (1.3.5 gave one without the list only
  // tools that look); for 1.2.11 the file stays as it was
  assert.match(after.read('/tmp/nextlevel-agy-trial/.agents/agents/nextlevel-worker.md'), /^tools:\n {2}- "view_file"\n {2}- "write_to_file"\n[\s\S]*- "run_command"\n/m);
  assert.doesNotMatch(ctx.read('/tmp/nextlevel-agy-trial/.agents/agents/nextlevel-worker.md'), /^tools:/m);

  // Redacted: a planted .env value, a Google key shape, a key in an MCP server's args, never a console's title
  const planted = 'planted-dotenv-value-1234';
  const mcpKey = 'stitch-header-value-8c1f0e2b9d';
  const google = `AIza${'Sy'.padEnd(35, 'x')}`;
  const leaky = { ok: false, code: 1, out: `error: refused: ${planted} ${google} --header X-Goog-Api-Key: ${mcpKey}\n{"event":"result","result":{"status":"ERROR","response":"","error":"refused: ${planted} ${google} ${mcpKey}"}}` };
  const secret = await check('agy.model', {
    commands: { ...AGY, 'agy -p *': leaky },
    env: { PLANTED: planted },
    files: { '/proj/.env': `PLANTED=${planted}\n`, '/home/me/.gemini/config/mcp_config.json': JSON.stringify({ mcpServers: { stitch: { command: 'npx', args: ['-y', 'stitch-mcp', '--header', `X-Goog-Api-Key: ${mcpKey}`] } } }) },
  });
  assert.equal(secret.status, 'fail');
  for (const s of [planted, google, mcpKey]) assert.ok(!secret.detail.includes(s), `${s.slice(0, 8)}... is redacted`);
  assert.match(secret.detail, /refused on agy 1\.2\.11: refused: \*\*\* \*\*\* \*\*\*, exit 1/);

  // The trial runs what a worker runs: a worker's environment (no .env variable, the push block), the agent file, started
  // directly (FR-022: on a real project it had the project's .env and went through cmd.exe)
  const env = { PLANTED: planted, PATH: '/usr/bin', AGY_HOME_HINT: 'x' };
  const seen = fakeContext({ commands: AGY, env, files: { '/proj/.env': `PLANTED=${planted}\n` } });
  await runChecks(seen, { checks: [byId('agy.model')] });
  const trialEnv = seen.envs.at(-1);
  assert.ok(!('PLANTED' in trialEnv), 'no .env variable');
  assert.equal(trialEnv.NEXTLEVEL_AGENT, 'worker');
  assert.equal(trialEnv.GH_TOKEN, 'nextlevel-workers-have-no-github-access');
  assert.equal(trialEnv.AGY_CLI_DISABLE_AUTO_UPDATE, 'true');

  // Strict: a model agy doesn't list, a model it refuses, a flag it doesn't know, a result that isn't SUCCESS, and no result
  // where JSON was asked for, all fail
  assert.equal((await check('agy.model', { commands: AGY, config: { roles: { worker: { model: 'gemini-9' } } } })).status, 'fail');
  assert.equal((await check('agy.model', { commands: { ...AGY, 'agy -p *': agyRun({ refuse: ['gemini-3-pro'] }) }, config: { roles: { worker: { model: 'gemini-3-pro' } } } })).status, 'fail');
  assert.equal((await check('agy.model', { commands: { ...AGY, 'agy -p *': { ok: false, code: 2, out: 'flags provided but not defined: -turbo\nUsage of agy.exe:' } }, config: { engines: { agy: { args: ['--turbo'] } } } })).status, 'fail');
  assert.equal((await check('agy.model', { commands: { ...AGY, 'agy -p *': `${AGY_DID}\n{"event":"result","result":{"status":"CANCELED","response":"ok"}}` } })).status, 'fail');
  assert.equal((await check('agy.model', { commands: { ...AGY, 'agy -p *': 'ok' } })).status, 'fail', 'stream-json was asked for: no result is no pass');
  // ...and a run that says SUCCESS but wrote no file and ran no command (agy 1.3.5's worker agent without its tools
  // list: only tools that look) fails, saying so
  const lazy = await check('agy.model', { commands: { ...AGY, 'agy -p *': `${step(2, 'view_file', { AbsolutePath: '/tmp/AGENTS.md' })}\n{"event":"result","result":{"status":"SUCCESS","response":"I do not have access to tools for writing files.\\n"}}` } });
  assert.equal(lazy.status, 'fail');
  assert.match(lazy.detail, /^agy's default model was refused on agy 1\.2\.11: agy ran, but its worker agent wrote no file and ran no command, so a worker on it can't do a task \(the tools it used: view_file\)\. It said: I do not have access to tools for writing files\., exit 0\./);
  const noCommand = await check('agy.model', { commands: { ...AGY, 'agy -p *': `${step(2, 'write_to_file', { TargetFile: 'x' })}\n{"event":"result","result":{"status":"SUCCESS","response":"ok"}}` } });
  assert.match(noCommand.detail, /its worker agent ran no command/);
  // The probe asks for what a worker does, in one line
  assert.match(AGY_PROBE, /^nextlevel model check: write the word ok to the file nextlevel-check\.txt in this folder with your file tool, run the command node --version, then reply with the single word ok\.$/);
});

test('agy.effort: an effort nothing passes to Antigravity is said, and the fix takes it out of nextlevel.json (FR-010)', async () => {
  const none = await check('agy.effort', { config: { engines: { agy: { args: ['--dangerously-skip-permissions'] } } } });
  assert.equal(none.status, 'ok');
  assert.equal(none.quiet, true);
  const file = '/proj/nextlevel.json';
  const raw = { version: 1, roles: { worker: { engine: 'agy', model: 'gemini-3-pro', effort: 'high', fallback: { engine: 'agy', model: '', effort: 'low' } }, orchestrator: { engine: 'codex', effort: 'high' } }, profiles: { spare: { engine: 'agy', effort: 'max' } }, engines: { agy: { args: ['--dangerously-skip-permissions', '--effort', 'high'] } } };
  const config = { roles: raw.roles, profiles: raw.profiles, engines: raw.engines };
  const r = await fixed('agy.effort', { config: structuredClone(config), files: { [file]: JSON.stringify(raw) } });
  assert.equal(r.fixed, true, r.detail);
  assert.equal(r.status, 'ok');
  assert.match(r.ui.said.join('\n'), /^Removed engines\.agy\.args --effort, roles\.worker\.effort, roles\.worker\.fallback\.effort, profiles\.spare\.effort from \/proj\/nextlevel\.json/);
  const saved = JSON.parse(r.ctx.files.get(file));
  assert.deepEqual(saved.engines.agy.args, ['--dangerously-skip-permissions']);
  assert.deepEqual([saved.roles.worker.effort, saved.roles.worker.fallback.effort, saved.profiles.spare.effort, saved.roles.orchestrator.effort], ['', '', '', 'high'], "Codex's effort stays");
  const before = await check('agy.effort', { config: structuredClone(config) });
  assert.equal(before.severity, 'info', 'nothing breaks: nextlevel never passes it');
  assert.match(before.detail, /^engines\.agy\.args --effort \("high"\), roles\.worker\.effort \("high"\), roles\.worker\.fallback\.effort \("low"\), profiles\.spare\.effort \("max"\) in nextlevel\.json: not used/);
  const fromEnv = await fixed('agy.effort', { config: structuredClone(config), configInfo: { overrides: ['AGY_ARGS'] } });
  assert.deepEqual([fromEnv.status, fromEnv.fixable], ['fail', false], 'AGY_ARGS in .env: the owner edits it');
});

test('agy.deny-list: added without losing settings, read back and said so (FR-001 #10, FR-003 #3)', async () => {
  const file = '/home/me/.gemini/antigravity-cli/settings.json';
  const none = await check('agy.deny-list', { commands: AGY });
  assert.equal(none.detail, 'no settings file yet');
  const invalid = await fixed('agy.deny-list', { commands: AGY, files: { [file]: '{ nope' } });
  assert.match(invalid.detail, /not valid JSON; not touching it/);
  assert.equal(invalid.fixable, false);
  assert.equal(invalid.ctx.files.get(file), '{ nope');

  const r = await fixed('agy.deny-list', { commands: AGY, files: { [file]: JSON.stringify({ colorScheme: 'dark', permissions: { deny: ['command(rm)'] } }) } });
  assert.equal(r.status, 'ok');
  assert.equal(r.fixed, true);
  assert.equal(r.detail, 'agy deny-list configured (not proof it works)');
  assert.match(r.next, /bridge test/);
  assert.match(r.ui.said.join('\n'), new RegExp(`Saved the ${DENY.length} rules in .*settings\\.json and read them back: they are all there`));
  const saved = JSON.parse(r.ctx.files.get(file));
  assert.equal(saved.colorScheme, 'dark');
  assert.equal(saved.permissions.deny.filter((d) => d === 'command(rm)').length, 1);
  assert.ok(saved.permissions.deny.includes('command(gh)'));
  assert.ok(r.ctx.files.has(`${file}.nextlevel-backup`));

  // A write that doesn't stick is said, not hidden
  const ui = fakeUi();
  const ctx = fakeContext({ commands: AGY });
  ctx.write = () => {};
  const [lost] = await runChecks(ctx, { checks: [byId('agy.deny-list')], fix: true, ui });
  assert.equal(lost.status, 'fail');
  assert.match(ui.said.join('\n'), /reading it back 18 rule\(s\) are missing/);
});

test('tool.claude: not installed is a note; installed but not running means npm skipped its script (FR-001 #7)', async () => {
  const missing = await fixed('tool.claude', { platform: 'win32', commands: {} });
  assert.equal(missing.severity, 'info');
  assert.match(missing.detail, /needed for nextlevel fix/);
  assert.deepEqual(missing.ui.ran, ['npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code (shell)']);
  const broken = await check('tool.claude', { commands: { 'claude --version': { ok: false, out: 'claude: native binary not installed' } } });
  assert.match(broken.detail, /installed, but "claude --version" fails/);
  assert.match(broken.steps[0].command, /--allow-scripts=@anthropic-ai\/claude-code/);
  assert.equal((await check('tool.claude', { commands: { 'claude --version': '2.9.0 (Claude Code)' } })).status, 'ok');
});

test('claude.github: the tool needs a GitHub remote, and the owner confirms Claude is connected (FR-002)', async () => {
  const tool = '/home/me/.nextlevel/tool';
  const remote = (url) => ({ [`git -C ${tool} config --get remote.origin.url`]: url });
  assert.equal(githubRepo('https://github.com/DYevseyev/nextlevelorc.git'), 'DYevseyev/nextlevelorc');
  assert.equal(githubRepo('git@github.com:a/b.git'), 'a/b');
  assert.equal(githubRepo('/tmp/remote.git'), null);

  const copy = await check('claude.github', { commands: { git: '' } });
  assert.equal(copy.severity, 'warn');
  assert.match(copy.detail, /no GitHub remote: a cloud session started from it would get a copy it can't push/);
  const unconfirmed = await check('claude.github', { commands: remote('https://github.com/o/r') });
  assert.equal(unconfirmed.severity, 'info');
  assert.deepEqual(unconfirmed.steps.map((s) => [s.window, s.command]), [['browser', 'https://claude.ai/connect-github'], ['browser', 'https://github.com/apps/claude']]);
  // Only the owner can say it's done: not with --fix alone
  assert.equal((await fixed('claude.github', { commands: remote('https://github.com/o/r') })).fixable, false);
  const yes = await fixed('claude.github', { commands: remote('https://github.com/o/r') }, fakeUi({ interactive: true }));
  assert.equal(yes.status, 'ok');
  assert.match(yes.detail, /you confirmed on \d{4}-\d\d-\d\d that Claude can reach o\/r/);
  assert.equal(yes.ctx.userData.claudeGithub.repo, 'o/r');
  // Confirmed for another repo doesn't count
  assert.equal((await check('claude.github', { commands: remote('https://github.com/o/r2'), userState: { claudeGithub: { repo: 'o/r', at: 'x' } } })).status, 'fail');
});

test('project.roles, project.gitignore, project.env, project.env-settings', async () => {
  const roles = ['GUIDE', 'ORCHESTRATOR', 'WORKER'].map((r) => `/proj/docs/agents/${r}.md`);
  const some = await check('project.roles', { files: Object.fromEntries(roles.slice(1).map((f) => [f, 'x'])) });
  assert.match(some.detail, /missing: docs\/agents\/GUIDE\.md, docs\/tasks\/_TEMPLATE\.md/);
  assert.equal((await check('project.roles', { files: Object.fromEntries([...roles, '/proj/docs/tasks/_TEMPLATE.md'].map((f) => [f, 'x'])) })).status, 'ok');

  const ignore = await fixed('project.gitignore', { files: { '/proj/.gitignore': 'node_modules/\n' } });
  assert.equal(ignore.status, 'ok');
  assert.match(ignore.ctx.files.get('/proj/.gitignore'), /^node_modules\/\n\n# nextlevel: .*\n\.env\n\.nextlevel\/\n\.nextlevel-task\/\n$/);
  assert.match((await check('project.gitignore', { files: { '/proj/.gitignore': '.env\n' } })).detail, /doesn't ignore \.nextlevel\/, \.nextlevel-task\//);

  // .env from .env.example is made without --fix: it's always safe
  const ctx = fakeContext({ files: { '/proj/.env.example': 'NTFY_TOPIC=\n' } });
  const [env] = await runChecks(ctx, { checks: [byId('project.env')], ui: fakeUi() });
  covered.add('project.env');
  assert.equal(env.status, 'ok');
  assert.equal(ctx.files.get('/proj/.env'), 'NTFY_TOPIC=\n');
  const [asJson] = await runChecks(fakeContext({ files: { '/proj/.env.example': '' } }), { checks: [byId('project.env')] });
  assert.equal(asJson.status, 'fail', 'without a ui (--json) nothing is changed');
  assert.match((await check('project.env')).detail, /no \.env\.example/);

  const moved = await check('project.env-settings', { files: { '/proj/.env': 'NEXTLEVEL_WORKER_SLOTS=1\nAPI_KEY=hunter2\nCODEX_MODEL=gpt-x\n' } });
  assert.equal(moved.detail, 'NEXTLEVEL_WORKER_SLOTS, CODEX_MODEL');
  assert.doesNotMatch(JSON.stringify(moved), /hunter2|gpt-x/, 'values in .env are never shown');
  assert.equal((await check('project.env-settings', { files: { '/proj/.env': 'NTFY_TOPIC=x\n' } })).status, 'ok');
});

test('project.env-example: the project\'s own .env.example that a template replaced is found in git and put back (FR-005)', async () => {
  const template = fs.readFileSync(new URL('../templates/project/.env.example', import.meta.url), 'utf8');
  assert.ok(ENV_EXAMPLE_TEMPLATES.includes(templateHash(template)), 'the current .env.example template is in ENV_EXAMPLE_TEMPLATES: add its hash there');
  assert.ok(isEnvExampleTemplate(template.replace(/\n/g, '\r\n')), 'CRLF line ends too');
  const own = 'NTFY_TOPIC=\nSTRIPE_SECRET=\nSMTP_PASSWORD=\n';
  const log = 'git log --format=%H %cs -n 30 -- .env.example';
  const history = {
    [log]: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2026-09-25\naaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 2026-09-20',
    'git show bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:.env.example': template,
    'git show aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:.env.example': own,
  };
  const replaced = await fixed('project.env-example', { files: { '/proj/.env.example': template }, commands: history }, fakeUi());
  assert.equal(replaced.fixed, true);
  assert.equal(replaced.ctx.files.get('/proj/.env.example'), own, 'the project\'s own version is back');
  assert.match(replaced.ui.said.join('\n'), /from commit aaaaaaa/);
  const found = await check('project.env-example', { files: { '/proj/.env.example': template }, commands: history });
  assert.equal(found.severity, 'warn');
  assert.match(found.detail, /nextlevel's template replaced the project's own \(FR-005\); commit aaaaaaa \(2026-09-20\) has yours/);
  assert.equal(found.steps[0].command, 'git checkout aaaaaaa -- .env.example');
  // A template with nothing of the project's before it, the project's own file, none at all: nothing to do
  const onlyTemplates = { [log]: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2026-09-25', 'git show bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:.env.example': template };
  assert.equal((await check('project.env-example', { files: { '/proj/.env.example': template }, commands: onlyTemplates })).status, 'ok');
  const mine = await check('project.env-example', { files: { '/proj/.env.example': own }, commands: history });
  assert.deepEqual([mine.status, mine.detail], ['ok', "the project's own"]);
  assert.equal((await check('project.env-example', { commands: history })).status, 'ok');
});

test('notify.topic: set, long enough, and never shown', async () => {
  const empty = await check('notify.topic', { files: { '/proj/.env': 'NTFY_TOPIC=\n' } });
  assert.equal(empty.detail, 'NTFY_TOPIC empty');
  assert.deepEqual(empty.steps.map((s) => s.window), ['phone', 'terminal', 'editor', 'terminal']);
  const short = await check('notify.topic', { files: { '/proj/.env': 'NTFY_TOPIC=abc123\n' } });
  assert.match(short.detail, /short \(6 characters\)/);
  const topic = 'a'.repeat(40);
  const set = await check('notify.topic', { env: { NTFY_TOPIC: topic } });
  assert.equal(set.status, 'ok');
  assert.doesNotMatch(JSON.stringify([short, set]), new RegExp(`abc123|${topic}`));
});

test('git.commits: none yet, and the fix makes the first commit only when it is safe (FR-001 #2)', async () => {
  const cmds = { ...GIT, 'git var GIT_AUTHOR_IDENT': 'A <a@b.c> 1 +0000', 'git config user.name': 'A', 'git config user.email': 'a@b.c', 'git add -A': '', 'git commit -q -m first commit': '', 'git ls-files': 'a\nb\n' };
  const none = await check('git.commits', { commands: cmds });
  assert.equal(none.detail, 'none yet');
  assert.deepEqual(none.steps.map((s) => s.command), ['git add -A', 'git commit -m "first commit"']);
  const made = await fixed('git.commits', { commands: cmds, files: { '/proj/.gitignore': '.env\n.nextlevel/\n' } });
  assert.ok(made.ctx.calls.includes('git commit -q -m first commit'));
  assert.match(made.ui.said.join('\n'), /Made the first commit \(2 files\)/);
  const secrets = await fixed('git.commits', { commands: cmds, files: { '/proj/.gitignore': 'node_modules/\n' } });
  assert.ok(!secrets.ctx.calls.includes('git add -A'), 'never commits while .env could go in');
  assert.match(secrets.ui.said.join('\n'), /doesn't ignore \.env/);
  const noIdentity = await fixed('git.commits', { commands: { ...cmds, 'git var GIT_AUTHOR_IDENT': { ok: false } }, files: { '/proj/.gitignore': '.env\n' } });
  assert.ok(!noIdentity.ctx.calls.includes('git add -A'));
  assert.match(noIdentity.ui.said.join('\n'), /First set your git identity/);
  assert.equal((await check('git.commits', { commands: { ...GIT, 'git rev-parse --verify --quiet HEAD': 'abc' } })).status, 'ok');
});

test('git.remote, git.pushed, git.branch, git.clean', async () => {
  const token = await check('git.remote', { commands: { 'git remote get-url origin': 'https://owner:ghp_secret@github.com/o/r.git' } });
  assert.equal(token.detail, 'https://***@github.com/o/r.git', 'a login in the URL is never shown');
  const none = await check('git.remote', { commands: GIT, config: { name: 'My App' } });
  assert.equal(none.steps[0].command, 'gh repo create My-App --private --source . --remote origin --push');

  assert.equal((await check('git.pushed', { commands: { 'git rev-parse --verify --quiet refs/remotes/origin/main': 'abc' } })).status, 'ok');
  const unpushed = await check('git.pushed', { commands: GIT });
  assert.equal(unpushed.severity, 'warn');
  assert.equal(unpushed.steps[0].command, 'git push -u origin main');

  assert.equal((await check('git.branch', { commands: { 'git symbolic-ref --short HEAD': 'main' } })).status, 'ok');
  const master = await check('git.branch', { commands: { 'git symbolic-ref --short HEAD': 'master' } });
  assert.equal(master.severity, 'error');
  assert.equal(master.steps[0].command, 'git branch -M main');
  const feature = await check('git.branch', { commands: { 'git symbolic-ref --short HEAD': 'feature', 'git rev-parse --verify --quiet refs/heads/main': 'abc' } });
  assert.equal(feature.severity, 'warn');
  assert.equal(feature.steps[0].command, 'git switch main');
  assert.equal((await check('git.branch', { commands: GIT })).detail, '(none)');

  const dirty = await check('git.clean', { commands: { 'git status --porcelain': ' M a.txt\n?? b.txt' } });
  assert.equal(dirty.severity, 'info');
  assert.match(dirty.detail, /^2: workers start from the last commit/);
  assert.equal((await check('git.clean', { commands: { 'git status --porcelain': '' } })).status, 'ok');
});

test('slots.push-lock: a shared pushurl needs Git 2.46 to be switched off in slots (FR-003)', async () => {
  const regexp = 'git config --get-regexp ^remote\\..*\\.pushurl$';
  assert.equal((await check('slots.push-lock', { commands: GIT })).status, 'ok');
  const old = await check('slots.push-lock', { platform: 'win32', commands: { 'git --version': 'git version 2.43.0.windows.1', [regexp]: 'remote.origin.pushurl https://github.com/o/r' } });
  assert.equal(old.severity, 'error');
  assert.match(old.detail, /remote\.origin\.pushurl is set and Git 2\.43\.0 can't switch it off/);
  assert.deepEqual(old.steps.map((s) => s.command), ['winget upgrade -e --id Git.Git', 'git config --unset-all remote.origin.pushurl']);
  const recent = await check('slots.push-lock', { commands: { 'git --version': 'git version 2.47.1', [regexp]: 'remote.origin.pushurl x' } });
  assert.equal(recent.status, 'ok');
});

test("lock.test: the orchestrator on Antigravity needs a passing lock test for exactly what it runs (agy's version, its model and arguments); agy.permissions says what the owner's own agy settings approve", async () => {
  const { roleKey } = await import('../src/lib/rolespec.mjs');
  const { defaults } = await import('../src/lib/config.mjs');
  const config = { roles: { orchestrator: { engine: 'agy', model: 'gemini-4-argon-low' } } };
  const verdictFile = '/proj/.nextlevel/lock-tests/agy-orchestrator.json';
  const keyFor = (version, model = 'gemini-4-argon-low') => roleKey({ profile: { name: '', engine: 'agy', account: '', model }, role: 'orchestrator', engineArgs: defaults().engines.agy.args, version, bin: 'agy' });
  const verdict = (extra = {}) => JSON.stringify({ ok: true, verdict: 'pass', role: 'orchestrator', key: keyFor('1.4.0'), version: '1.4.0', at: '2026-10-16T20:00:00.000Z', sandbox: "commands don't run in it here: exebox", tries: [], ...extra });
  const lock = (opts) => check('lock.test', { config, commands: { 'agy --version': '1.4.0' }, ...opts });

  // None yet: an error, with the exact command (the model included: the orchestrator may not be on agy yet)
  let r = await lock();
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'error');
  assert.match(r.detail, /the orchestrator \(gemini-4-argon-low\): it hasn't had its lock test yet, so it doesn't start on Antigravity/);
  assert.equal(r.steps.at(-1).command, 'nextlevel lock-test --engine agy --role orchestrator --model gemini-4-argon-low');
  // A pass for exactly this: passes, and says what agy's own sandbox did
  r = await lock({ files: { [verdictFile]: verdict() } });
  assert.equal(r.status, 'ok', r.detail);
  assert.match(r.detail, /passed on 2026-10-16 \(agy 1\.4\.0\): its pushes and gh go nowhere and your MCP servers aren't offered to it; agy's own sandbox here: commands don't run in it here/);
  // agy updated itself: the lock test runs again first
  r = await lock({ files: { [verdictFile]: verdict() }, commands: { 'agy --version': '1.4.1' } });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /its lock test ran on agy 1\.4\.0, and agy is 1\.4\.1 now/);
  // another model (a key of its own)
  r = await lock({ config: { roles: { orchestrator: { engine: 'agy', model: 'gemini-4-argon-high' } } }, files: { [verdictFile]: verdict() } });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /with other arguments, another model or another agent file/);
  // one that failed for exactly this: what got through, and the field report
  r = await lock({ files: { [verdictFile]: verdict({ ok: false, verdict: 'fail', tries: [{ id: 'gh', what: 'gh api user (your GitHub sign-in)', result: 'fail' }] }) } });
  assert.match(r.detail, /its lock test failed: gh api user \(your GitHub sign-in\) got through/);
  assert.match(r.next, /field report/);
  // a verdict a try wasn't run for is no pass
  r = await lock({ files: { [verdictFile]: verdict({ ok: false, verdict: 'incomplete', tries: [{ id: 'mcp', what: 'an MCP tool', result: 'not-tried' }] }) } });
  assert.equal(r.status, 'fail');
  assert.match(r.detail, /incomplete: the model didn't run an MCP tool/);
  // a pass whose "ok" was written by hand, without the verdict, counts for nothing
  r = await lock({ files: { [verdictFile]: verdict({ verdict: 'incomplete' }) } });
  assert.equal(r.status, 'fail');
  // The orchestrator on Codex: nothing to check
  r = await check('lock.test', { commands: { 'agy --version': '1.4.0' } });
  assert.equal(r.status, 'skip');

  // agy.permissions: the owner's own settings, read only: information, never a warning
  const home = '/home/me/.gemini';
  r = await check('agy.permissions', {
    commands: { 'agy --version': '1.4.0' },
    files: { [`${home}/antigravity-cli/settings.json`]: JSON.stringify({ toolPermission: 'always-proceed' }), [`${home}/config/config.json`]: JSON.stringify({ userSettings: { globalPermissionGrants: { allow: ['command(*)'] }, nonWorkspaceFileAccessPolicy: 'AGENT_SETTING_POLICY_ALLOW' } }) },
  });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'info');
  assert.match(r.detail, /toolPermission is always-proceed; a global grant allows every command \(command\(\*\)\); files outside the workspace are allowed\. So agy asks nothing, even in the setup guide/);
  r = await check('agy.permissions', { commands: { 'agy --version': '1.4.0' }, files: { [`${home}/antigravity-cli/settings.json`]: JSON.stringify({ toolPermission: 'request-review' }) } });
  assert.equal(r.status, 'ok');
  // and the Team page's note for the setup guide on agy says it won't ask
  const { fullAccessNote } = await import('../src/engines/index.mjs');
  assert.match(fullAccessNote({ engine: 'agy' }, 'guide', [], { asksNothing: true }).text, /your own Antigravity settings approve every command without asking/);
  assert.equal(fullAccessNote({ engine: 'agy' }, 'guide', [], { asksNothing: false }), null);
  const passed = fullAccessNote({ engine: 'agy' }, 'orchestrator', ['--dangerously-skip-permissions'], { lock: { passed: true, version: '1.4.0' } }).text;
  assert.match(passed, /nextlevel blocks its pushes, your GitHub sign-in and your MCP servers \(its lock test passed on agy 1\.4\.0\); it still acts as your Windows user/);
  assert.match(passed, /a session that sets out to can switch nextlevel's blocks off with one command, then push and act on GitHub as you/);
  assert.match(fullAccessNote({ engine: 'agy' }, 'orchestrator', ['--dangerously-skip-permissions'], { lock: { passed: false, why: "it hasn't had its lock test yet", command: 'nextlevel lock-test --engine agy --role orchestrator' } }).text, /On Antigravity it doesn't start until its lock test passes/);
  // the assistant on agy (part B): in its copy, with what stays open said plainly
  const asks = fullAccessNote({ engine: 'agy' }, 'assistant', ['--dangerously-skip-permissions'], { lock: { passed: true, version: '1.4.0' } });
  assert.equal(asks.level, 'warn');
  assert.match(asks.text, /It answers in a throwaway copy of your project, and nextlevel blocks its pushes, your GitHub sign-in and your MCP servers \(its lock test passed on agy 1\.4\.0\)/);
  assert.match(asks.text, /change files outside its copy, and a session that sets out to can switch nextlevel's blocks off with one command, then push and act on GitHub as you/);
  assert.match(fullAccessNote({ engine: 'agy' }, 'assistant', ['--dangerously-skip-permissions'], { lock: { passed: false, why: "it hasn't had its lock test yet", command: 'nextlevel lock-test --engine agy --role assistant' } }).text, /On Antigravity it doesn't answer until its lock test passes \(it hasn't had its lock test yet; run nextlevel lock-test --engine agy --role assistant\)/);
});

test('bridge.test: reads the last verdict; a leak blocks, a new worker CLI version asks for a rerun (FR-003)', async () => {
  // (workers on Antigravity with no fallback: one engine to test; a fallback's engine needs its own, below)
  const bridge = (opts = {}) => check('bridge.test', { config: { roles: { worker: { engine: 'agy', fallback: '' } } }, ...opts });
  const file = '/proj/.nextlevel/bridge-test.json';
  const rec = (r) => ({ [file]: JSON.stringify({ at: '2026-09-25T10:00:00.000Z', engine: 'agy', engineVersion: '1.2.11', ...r }) });
  const none = await bridge();
  assert.equal(none.detail, 'not run yet');
  assert.equal(none.severity, 'warn');
  assert.deepEqual(none.steps.map((s) => s.command), ['nextlevel run', 'nextlevel bridge-test']);
  const leak = await bridge({ files: rec({ result: 'leaked' }) });
  assert.equal(leak.severity, 'error');
  assert.match(leak.detail, /FAILED on 2026-09-25: a worker's push arrived/);
  assert.match((await bridge({ files: rec({ result: 'failed', reason: 'a worker did not finish' }) })).detail, /didn't pass on 2026-09-25: a worker did not finish/);
  const ok = await bridge({ files: rec({ result: 'passed' }), commands: { 'agy --version': '1.2.11' } });
  assert.equal(ok.status, 'ok');
  assert.match(ok.detail, /passed on 2026-09-25 \(agy 1\.2\.11\): workers tried to push and nothing arrived/);
  const newer = await bridge({ files: rec({ result: 'passed' }), commands: { 'agy --version': '1.3.0' } });
  assert.equal(newer.status, 'fail');
  assert.match(newer.detail, /agy is 1\.3\.0 now: run it again/);
  // FR-007: bridge tests that ran before the verdict was kept are in the hub's log, not "not run yet"
  const log = [
    '2026-09-24T20:00:00.000Z  hub started · 2 worker slot(s)',
    '2026-09-24T20:00:05.000Z  started T000-bridge-1 in slot w1 (agy, attempt 1)',
    '2026-09-24T20:00:06.000Z  started T000-bridge-2 in slot w2 (agy, attempt 1)',
    '2026-09-25T09:12:00.000Z  started T000-bridge-1 in slot w1 (agy, attempt 1)',
    '2026-09-25T09:15:00.000Z  finished T000-bridge-1: done · verify pass · worker says DONE · 1 commit(s)',
    '2026-09-25T09:16:00.000Z  finished M1-01-ok: done',
  ].join('\n');
  const before = await bridge({ files: { '/proj/.nextlevel/logs/hub.log': `${log}\n` } });
  assert.equal(before.status, 'fail');
  assert.equal(before.severity, 'warn');
  assert.equal(before.detail, 'ran on 2026-09-25 (the hub log shows T000-bridge-1 and T000-bridge-2), before nextlevel saved its verdict: run it again for a saved verdict');
  assert.deepEqual(before.steps.map((s) => s.command), ['nextlevel run', 'nextlevel bridge-test']);
  assert.equal((await bridge({ files: { '/proj/.nextlevel/logs/hub.log': '2026-09-25T09:16:00.000Z  finished M1-01-ok: done\n' } })).detail, 'not run yet');
  // Once the verdict is kept, the log doesn't matter
  assert.match((await bridge({ files: { ...rec({ result: 'passed' }), '/proj/.nextlevel/logs/hub.log': log }, commands: { 'agy --version': '1.2.11' } })).detail, /^passed on 2026-09-25/);
});

test('bridge.test: one verdict per worker engine (the workers, their fallback), kept with the workers\' arguments; an old record counts for its engine; gh signed in fails', async () => {
  const at = '2026-10-15T10:00:00.000Z';
  const old = (r) => ({ '/proj/.nextlevel/bridge-test.json': JSON.stringify({ at, engine: 'agy', engineVersion: '1.2.11', result: 'passed', ...r }) });
  const per = (engine, r) => ({ [`/proj/.nextlevel/bridge-tests/${engine}.json`]: JSON.stringify({ at, engine, engineVersion: engine === 'agy' ? '1.2.11' : 'codex-cli 0.152.0', result: 'passed', gh: 'none', ...r }) });
  const versions = { 'agy --version': '1.2.11', 'codex --version': 'codex-cli 0.152.0' };
  const sandboxOff = ['--sandbox', 'danger-full-access', '-c', 'approval_policy=never'];
  // The default team: Antigravity workers, Codex as their fallback. An old record (bridge-test.json, agy) counts for agy;
  // Codex's fallback workers need their own
  const one = await check('bridge.test', { files: old(), commands: versions });
  assert.equal(one.status, 'fail');
  assert.equal(one.detail, "Antigravity workers: passed on 2026-10-15 (agy 1.2.11): workers tried to push and nothing arrived; Codex workers (the workers' fallback): not run yet");
  assert.deepEqual(one.steps.map((s) => s.command), ['nextlevel run', 'nextlevel bridge-test --engine codex']);
  // A Codex run beside it keeps the agy verdict (bridge-test.json now names codex, as an older nextlevel reads it)
  const both = await check('bridge.test', { files: { '/proj/.nextlevel/bridge-test.json': JSON.stringify({ at, engine: 'codex', engineVersion: 'codex-cli 0.152.0', result: 'passed' }), ...per('agy'), ...per('codex', { workerArgs: ['--sandbox', 'workspace-write'] }) }, commands: versions });
  assert.equal(both.status, 'ok', both.detail);
  assert.match(both.detail, /^Antigravity workers: passed on 2026-10-15 \(agy 1\.2\.11\): workers tried to push and nothing arrived, and gh answered as no one; Codex workers \(the workers' fallback\): passed/);
  // Codex workers taken out of their sandbox: new worker arguments ask for the test again
  const config = { engines: { codex: { workerArgs: sandboxOff } } };
  const again = await check('bridge.test', { config, files: { ...per('agy'), ...per('codex', { workerArgs: ['--sandbox', 'workspace-write'] }) }, commands: versions });
  assert.equal(again.status, 'fail');
  assert.match(again.detail, /Codex workers \(the workers' fallback\): passed on 2026-10-15 \(codex codex-cli 0\.152\.0\) with other worker arguments \(--sandbox workspace-write; now --sandbox danger-full-access -c approval_policy=never\): run it again/);
  assert.deepEqual(again.steps.map((s) => s.command), ['nextlevel run', 'nextlevel bridge-test --engine codex']);
  assert.equal((await check('bridge.test', { config, files: { ...per('agy'), ...per('codex', { workerArgs: sandboxOff }) }, commands: versions })).status, 'ok');
  // An old record ran with the engine's args: it no longer counts once that engine's workers have arguments of their own
  const oldCodex = { '/proj/.nextlevel/bridge-test.json': JSON.stringify({ at, engine: 'codex', engineVersion: 'codex-cli 0.152.0', result: 'passed' }) };
  assert.equal((await check('bridge.test', { files: { ...per('agy'), ...oldCodex }, commands: versions })).status, 'ok');
  assert.match((await check('bridge.test', { config, files: { ...per('agy'), ...oldCodex }, commands: versions })).detail, /with other worker arguments \(before engines\.codex\.workerArgs; now --sandbox danger-full-access/);
  // A worker whose gh answered as someone: as bad as a push that arrived
  const signed = await check('bridge.test', { files: { ...per('agy', { result: 'signed-in', gh: 'owner (github.com)' }), ...per('codex') }, commands: versions });
  assert.equal(signed.severity, 'error');
  assert.match(signed.detail, /Antigravity workers: FAILED on 2026-10-15: a worker's gh answered as owner \(github\.com\)/);
  // A fallback named by its profile is tested with --profile
  const prof = await check('bridge.test', { config: { profiles: { 'codex-small': { engine: 'codex', model: 'gpt-6-mini' } }, roles: { worker: { engine: 'agy', fallback: 'codex-small' } } }, files: per('agy'), commands: versions });
  assert.deepEqual(prof.steps.map((s) => s.command), ['nextlevel run', 'nextlevel bridge-test --profile codex-small']);
});

test('guard.held: the changes to protected files that wait for the owner, and the protected paths in effect', async () => {
  // The held changes are kept in the owner's home, outside the project (lib/guard.mjs)
  const held = (items) => ({ [path.posix.join('/home/me', '.nextlevel', 'guard', projectKey('/proj'), 'held.json')]: JSON.stringify({ next: 3, items }) });
  const none = await check('guard.held');
  assert.equal(none.status, 'ok');
  assert.equal(none.quiet, true);
  assert.match(none.detail, /none waiting for you; 17 protected paths/);
  const own = await check('guard.held', { config: { protected: { add: ['.cursor/'], remove: ['.vscode/'] } } });
  assert.match(own.detail, /17 protected paths \(nextlevel\.json adds \.cursor\/; removes \.vscode\/\)/);
  const waiting = await check('guard.held', {
    files: held([
      { id: 'G1', kind: 'merge', task: 'M1-01-hook', status: 'held', files: [{ path: '.claude/settings.json' }] },
      { id: 'G2', kind: 'disk', status: 'rejected', files: [{ path: 'START.cmd' }] },
    ]),
  });
  assert.equal(waiting.status, 'fail');
  assert.equal(waiting.severity, 'warn');
  assert.match(waiting.detail, /^1 waiting for you: G1 \(task M1-01-hook: \.claude\/settings\.json\)$/);
  assert.equal(waiting.steps[0].window, 'browser');
  assert.match(waiting.steps[0].text, /Notes and handoffs.*Not from your phone/);
  assert.equal((await check('guard.held', { files: { [Object.keys(held([]))[0]]: '{broken' } })).severity, 'info');
  // git's own hooks or settings changed: all git work waits, so it is an error
  const git = await check('guard.held', { files: held([{ id: 'G3', kind: 'git', status: 'held', items: ['pre-commit hook'], files: [] }, { id: 'G4', kind: 'secret', on: 'commit', status: 'held', files: [{ path: 'config.txt' }] }]) });
  assert.equal(git.severity, 'error');
  assert.match(git.detail, /^2 waiting for you: G3 \(git's own hooks and settings: pre-commit hook\); G4 \(the orchestrator's commit: config\.txt\)\. All git work waits/);
  // a push held on a card: a deploy push names its commit, a push carrying protected files names them
  const pushes = await check('guard.held', { files: held([
    { id: 'G5', kind: 'push', deploy: true, status: 'held', from: 'main', target: 'production', sha: '0123456789abcdef', files: [] },
    { id: 'G6', kind: 'push', status: 'held', from: 'M1-02-ci', target: 'M1-02-ci', sha: 'fedcba9876543210', files: [{ path: '.github/workflows/ci.yml' }] },
  ]) });
  assert.match(pushes.detail, /^2 waiting for you: G5 \(the push of main to production: commit 0123456\); G6 \(the push of M1-02-ci to M1-02-ci: \.github\/workflows\/ci\.yml\)$/);
  assert.equal((await check('guard.held', { root: null })).status, 'skip');
});

test('hub.running and pc.sleep (docs/CHECKS.md)', async () => {
  assert.equal((await check('hub.running', { hubAlive: true })).status, 'ok');
  const stopped = await check('hub.running');
  assert.equal(stopped.severity, 'info');

  const q = 'powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE';
  const out = (ac) => `GUID: 29f6c1db (Sleep after)\n  Minimum: 0x00000000\n  Maximum: 0xffffffff\n  Increment: 0x00000001\n  AC: 0x${ac.toString(16).padStart(8, '0')}\n  DC: 0x00000384`;
  const sleeps = await fixed('pc.sleep', { platform: 'win32', commands: { [q]: out(1800), 'powercfg /change standby-timeout-ac 0': '' } });
  assert.ok(sleeps.ctx.calls.includes('powercfg /change standby-timeout-ac 0'));
  const guided = await check('pc.sleep', { platform: 'win32', commands: { [q]: out(1800) } });
  assert.match(guided.detail, /sleeps after 30 min when plugged in/);
  assert.equal(guided.steps[0].command, 'powercfg /change standby-timeout-ac 0');
  assert.equal((await check('pc.sleep', { platform: 'win32', commands: { [q]: out(0) } })).status, 'ok');
  assert.equal((await check('pc.sleep', { platform: 'win32', commands: { [q]: { ok: false, out: 'Access denied' } } })).severity, 'info');
  assert.equal((await check('pc.sleep', { platform: 'linux' })).status, 'skip', 'only on Windows');
});

test('the runner blanks out secrets in everything a check returns', async () => {
  const leaky = {
    id: 'test.leaky',
    title: 'Leaky',
    run: () => ({
      ok: false,
      detail: 'Logged in using an API key - sk-proj-abcdefghijklmnop, topic hunter2-topic',
      next: 'token ghp_abcdefghijklmnopqrstuvwxyz0123 and https://me:pw@example.com/x',
      steps: [{ window: 'terminal', command: 'echo hunter2-topic' }],
      message: 'AIzaSyA1234567890abcdefghijklmn',
    }),
  };
  const r = await runCheck(leaky, fakeContext({ secrets: ['hunter2-topic', 'x'] }));
  assert.equal(r.detail, 'Logged in using an API key - ***, topic ***');
  assert.equal(r.next, 'token *** and https://***@example.com/x');
  assert.equal(r.steps[0].command, 'echo ***');
  assert.equal(r.message, '***');
  assert.equal((await runCheck({ ...leaky, run: () => ({ ok: true, detail: 'fix the x' }) }, fakeContext({ secrets: ['x'] }))).detail, 'fix the x', 'values shorter than 6 characters are left alone');
});

test('the runner: requirements, a check that throws, and output', async () => {
  const done = new Map([['tool.codex', { status: 'fail', title: 'Codex CLI' }]]);
  const skipped = await check('codex.login', { commands: CODEX }, done);
  assert.equal(skipped.status, 'skip');
  assert.equal(skipped.detail, 'needs "Codex CLI" first');
  const thrower = { id: 'test.throws', title: 'Throws', run: () => { throw new Error('boom'); } };
  const r = await runCheck(thrower, fakeContext());
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warn');
  assert.match(r.detail, /the check itself failed: boom/);

  const text = formatResults(
    [
      { status: 'ok', title: 'Quiet', detail: 'hidden', quiet: true, steps: [] },
      { status: 'fail', severity: 'error', title: 'Git identity', detail: 'not set', next: 'set it', steps: [{ window: 'terminal', command: 'git config --global user.name "N"' }] },
      { status: 'fail', severity: 'info', title: 'Note', detail: 'fyi', steps: [{ window: 'claude', command: '/web-setup', text: 'connects GitHub' }] },
      { status: 'fail', severity: 'error', title: 'Project', detail: 'no repo', message: 'line one\nline two', steps: [{ window: 'terminal', command: 'x' }] },
    ],
    { platform: 'win32' },
  );
  assert.doesNotMatch(text, /Quiet/);
  assert.match(text, /^ !!  Git identity {11}not set {2}-> {2}set it$/m);
  assert.match(text, /^ {8}PowerShell: {2}git config --global user\.name "N"$/m);
  assert.match(text, /^ i {3}Note/m);
  assert.match(text, /^ {8}Inside Claude Code: {2}\/web-setup {3}\(connects GitHub\)$/m, 'a slash command says it goes inside Claude Code (FR-001 #8)');
  assert.match(text, /^ {8}line two$/m);
  assert.doesNotMatch(text, /^ {8}PowerShell: {2}x$/m, 'a message replaces the steps');
  assert.match(text, /^2 item\(s\) need attention \(2 to fix\)\. The setup guide \(START\.cmd -> 2 or 3\) walks you through the rest\.$/m, 'a sentence starts with a capital');
  const fixable = formatResults([{ status: 'fail', severity: 'warn', title: 'Sleep', detail: 'x', steps: [], fixable: true }]);
  assert.match(fixable, /^1 item\(s\) need attention \(1 warning\(s\)\)\. `nextlevel doctor --fix` fixes what it can; the setup guide/m);
  assert.match(formatResults([{ status: 'ok', title: 'Fine', detail: 'yes', steps: [] }]), /^All good\.$/m);
});

test('project checks load from .nextlevel/checks/*.mjs; broken ones say why', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-checks-'));
  try {
    const checks = path.join(dir, '.nextlevel', 'checks');
    fs.mkdirSync(checks, { recursive: true });
    fs.writeFileSync(path.join(checks, 'a-good.mjs'), "export default [{ id: 'acme.smtp', title: 'SMTP', run: (ctx) => ({ ok: !!ctx.env.SMTP_HOST, detail: 'x' }) }];\n");
    fs.writeFileSync(path.join(checks, 'b-single.mjs'), "export default { id: 'acme.site', title: 'Site', run: () => ({ ok: true, detail: 'up' }) };\n");
    fs.writeFileSync(path.join(checks, 'c-syntax.mjs'), 'export default {\n');
    fs.writeFileSync(path.join(checks, 'd-taken.mjs'), "export default { id: 'tool.git', title: 'Mine', run: () => ({ ok: true }) };\n");
    fs.writeFileSync(path.join(checks, 'e-bad.mjs'), "export const checks = [{ id: 'NoDots', run: 1 }];\n");
    fs.writeFileSync(path.join(checks, 'f-empty.mjs'), 'export const x = 1;\n');
    fs.writeFileSync(path.join(checks, 'notes.txt'), 'not a check');
    const list = await loadProjectChecks(path.join(dir, '.nextlevel'));
    assert.deepEqual(list.map((c) => c.id), ['acme.smtp', 'acme.site', 'project.check-c-syntax', 'project.check-d-taken', 'project.check-e-bad', 'project.check-f-empty']);
    assert.equal(list[0].source, path.join('.nextlevel', 'checks', 'a-good.mjs'));
    const results = await runChecks(fakeContext({ env: { SMTP_HOST: 'mail' } }), { checks: list });
    const detail = Object.fromEntries(results.map((r) => [r.id, r.detail]));
    assert.equal(results[0].status, 'ok');
    assert.match(detail['project.check-c-syntax'], /^doesn't load: /);
    assert.match(detail['project.check-d-taken'], /id "tool\.git" is already taken/);
    assert.match(detail['project.check-e-bad'], /id must look like "area\.name".*needs a title.*needs run/);
    assert.match(detail['project.check-f-empty'], /exports no checks/);
    assert.ok(results.slice(2).every((r) => r.status === 'fail' && r.severity === 'warn'));
    assert.deepEqual(await loadProjectChecks(path.join(dir, 'nothing-here')), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- profiles and second accounts (M6) ----------
const CODEX_TWO = { roles: { worker: { profile: 'codex-two', fallback: 'codex' } }, profiles: { 'codex-two': { engine: 'codex', account: 'two', model: '' } } };
const TWO_HOME = '/home/me/.nextlevel/accounts/codex/two';

test('profiles.accounts: a second account gets its own folder; an engine that can\'t keep one apart is said plainly', async () => {
  const none = await check('profiles.accounts');
  assert.equal(none.status, 'ok');
  assert.equal(none.quiet, true);
  const two = await check('profiles.accounts', { config: CODEX_TWO });
  assert.equal(two.status, 'ok');
  assert.equal(two.detail, `codex-two: Codex account two, in its own folder ${TWO_HOME} (CODEX_HOME)`);
  const claude = await check('profiles.accounts', { platform: 'win32', config: { roles: { orchestrator: { profile: 'cw' } }, profiles: { cw: { engine: 'claude', account: 'work' } } } });
  assert.match(claude.detail, /cw: Claude Code account work, in its own folder C:\\Users\\me\\\.nextlevel\\accounts\\claude\\work \(CLAUDE_CONFIG_DIR\)/);
  // Antigravity has no setting for its folder: a role on such a profile is an error, a fallback a warning
  const agy = { profiles: { 'agy-two': { engine: 'agy', account: 'two' } } };
  const role = await check('profiles.accounts', { config: { ...agy, roles: { worker: { profile: 'agy-two', fallback: 'codex' } } } });
  assert.equal(role.status, 'fail');
  assert.equal(role.severity, 'error');
  assert.match(role.detail, /^profile "agy-two" names account "two", but Antigravity CLI can't keep a second account apart: it has no setting for where it keeps its sign-in/);
  assert.deepEqual(role.steps.map((s) => [s.window, s.text]), [['editor', 'in nextlevel.json take "account" out of profiles.agy-two, or give it "engine": "codex" or "claude"']]);
  const fallback = await check('profiles.accounts', { config: { ...agy, roles: { worker: { fallback: 'agy-two' } } } });
  assert.equal(fallback.severity, 'warn');
  assert.equal((await check('profiles.accounts', { config: agy })).quiet, true, 'a profile no role uses is left alone');
});

test("profiles.full-access (FR-017): a role on an engine that runs it with no permission check acts with the owner's full access: a warning for a role in the main checkout, information for workers; the setup guide and Codex in its sandbox don't count", async () => {
  // The default team: the workers on Antigravity, which skips its permission checks to run unattended: accepted by design
  const d = await check('profiles.full-access');
  assert.deepEqual([d.status, d.severity], ['fail', 'info']);
  assert.equal(
    d.detail,
    "the workers (Antigravity): Antigravity skips its permission checks for it (--dangerously-skip-permissions in engines.agy.args, which it needs to run unattended): it acts with your full access. Accepted by design: a worker runs in a slot of its own, where git refuses its pushes (FR-003), and Antigravity needs this to run unattended; a worker can still undo the push block, and a deploy tool signed in as you isn't stopped",
  );
  assert.match(d.next, /^nothing to do: workers on Antigravity need it to run unattended/);
  assert.deepEqual(d.steps.map((s) => [s.window, s.command]), [['terminal', 'nextlevel team']]);
  // The orchestrator on Antigravity (it works in the main checkout, with the owner's sign-ins): a warning, first
  const orch = await check('profiles.full-access', { config: { roles: { orchestrator: { engine: 'agy' } } } });
  assert.equal(orch.severity, 'warn');
  assert.match(orch.detail, /^the orchestrator \(Antigravity\): Antigravity skips its permission checks for it .*: it acts with your full access in your main checkout and could push or deploy directly, past nextlevel push and your approval of a deploy branch\. An engine with permission checks keeps it from that: Codex, in its sandbox, or Claude Code, with nextlevel's rules; the workers \(Antigravity\): .*Accepted by design/);
  assert.deepEqual(orch.steps.map((s) => s.command), ['nextlevel team set orchestrator --engine codex', 'nextlevel team']);
  // ... and so is the orchestrator's fallback
  assert.equal((await check('profiles.full-access', { config: { roles: { orchestrator: { fallback: 'agy' }, worker: { engine: 'codex' } } } })).severity, 'warn');
  // The setup guide gets none of the unattended arguments (it asks before it runs anything); Codex in its sandbox
  assert.equal((await check('profiles.full-access', { config: { roles: { guide: { engine: 'agy' }, worker: { engine: 'codex' } } } })).quiet, true);
  // Antigravity without the flag, Codex without its sandbox, Claude Code with bypassPermissions, a fallback
  assert.equal((await check('profiles.full-access', { config: { engines: { agy: { args: ['--mode', 'accept-edits'] } } } })).status, 'ok');
  const codex = await check('profiles.full-access', { config: { roles: { worker: { engine: 'codex', fallback: '' } }, engines: { codex: { args: ['--sandbox', 'danger-full-access'] } } } });
  assert.match(codex.detail, /^the orchestrator \(Codex\): Codex runs it without its sandbox \(danger-full-access or --dangerously-bypass-approvals-and-sandbox in engines\.codex\.args\): .*; the workers \(Codex\): Codex runs it without its sandbox/);
  const claude = await check('profiles.full-access', { config: { roles: { orchestrator: { engine: 'claude' }, worker: { engine: 'codex' } }, engines: { claude: { args: ['--permission-mode', 'bypassPermissions'] } } } });
  assert.match(claude.detail, /^the orchestrator \(Claude Code\): Claude Code skips its permission checks for it \(--dangerously-skip-permissions or bypassPermissions in engines\.claude\.args\)/);
  const fb = await check('profiles.full-access', { config: { roles: { worker: { engine: 'codex', fallback: 'agy' } } } });
  assert.match(fb.detail, /^the workers' fallback \(Antigravity\): /);
  assert.equal(fb.severity, 'info', 'a worker, in a slot: information');
});

test('codex.login and codex.model: every Codex account a profile uses, each with its own folder', async () => {
  // Codex's own login is fine; account two isn't signed in yet
  const status = (args, opts) => (opts.env?.CODEX_HOME === TWO_HOME ? { ok: false, out: 'Not logged in' } : 'Logged in using ChatGPT');
  const login = await check('codex.login', { root: '/proj', config: CODEX_TWO, commands: { ...CODEX, 'codex login status': status } });
  assert.equal(login.status, 'fail');
  assert.equal(login.severity, 'error');
  assert.equal(login.detail, 'account two (profile codex-two): not signed in');
  assert.deepEqual(login.steps.map((s) => [s.window, s.command, s.cwd]), [['terminal', 'nextlevel login codex-two', '/proj']]);
  assert.equal(login.ctx.envs.find((e) => e)?.CODEX_HOME, TWO_HOME, "account two is asked in its own folder");
  const both = await check('codex.login', { config: CODEX_TWO, commands: { ...CODEX, 'codex login status': (a, o) => (o.env ? 'Logged in using ChatGPT (two)' : 'Logged in using ChatGPT') } });
  assert.equal(both.detail, 'its own login: Logged in using ChatGPT; account two (profile codex-two): Logged in using ChatGPT (two)');

  // The model: each account's own config.toml and login; a profile's pinned model says where it is set
  const probe = `codex exec --skip-git-repo-check --sandbox read-only ${MODEL_PROBE}`;
  const pinnedProbe = `codex exec --skip-git-repo-check --sandbox read-only -m gpt-6-sol ${MODEL_PROBE}`;
  const files = { [`${TWO_HOME}/config.toml`]: 'model = "gpt-6-astra"\n' };
  const own = await check('codex.model', { config: CODEX_TWO, files, commands: { ...CODEX, [probe]: 'ok' } });
  assert.equal(own.detail, "the account's default (accepted by this login); Codex's own \"gpt-6-astra\" for account two (from its config.toml; accepted by this login)");
  const probes = own.ctx.calls.map((c, i) => [c, own.ctx.envs[i]?.CODEX_HOME || '']).filter(([c]) => c === probe);
  assert.deepEqual(probes.map(([, home]) => home), ['', TWO_HOME], 'each account is asked with its own folder');
  assert.deepEqual(Object.keys(own.ctx.cacheData['codex.model']).map((k) => k.split(' | ').slice(0, 2).join(' | ')), ['own: | ', 'own:gpt-6-astra | two']);
  const pinned = { ...CODEX_TWO, profiles: { 'codex-two': { engine: 'codex', account: 'two', model: 'gpt-6-sol' } } };
  const bad = await check('codex.model', { config: pinned, commands: { ...CODEX, [probe]: 'ok', [pinnedProbe]: { ok: false, out: "ERROR: The 'gpt-6-sol' model is not supported" } } });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.pinned, true);
  assert.match(bad.detail, /^"gpt-6-sol" \(profiles\.codex-two\.model\) was rejected/);
  assert.equal(bad.steps[0].text, 'in nextlevel.json set "profiles": { "codex-two": { "model": "" } }');
});

test('claude.login: when a role runs on Claude Code, each of its accounts is signed in', async () => {
  const onClaude = { roles: { orchestrator: { engine: 'claude' } } };
  const CLAUDE = { 'claude --version': '2.1.283 (Claude Code)' };
  const json = (o) => JSON.stringify({ apiProvider: 'firstParty', ...o });
  assert.equal((await check('claude.login', { commands: CLAUDE })).status, 'skip', 'no role uses Claude Code');
  const ok = await check('claude.login', { config: onClaude, commands: { ...CLAUDE, 'claude auth status': json({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'max' }) } });
  assert.equal(ok.detail, 'signed in (me@example.com, max)');
  const out = await check('claude.login', { config: onClaude, commands: { ...CLAUDE, 'claude auth status': { ok: false, out: json({ loggedIn: false, authMethod: 'none' }) } } });
  assert.equal(out.severity, 'error');
  assert.deepEqual(out.steps.map((s) => s.command), ['claude auth login']);
  const old = await check('claude.login', { config: onClaude, commands: { ...CLAUDE, 'claude auth status': { ok: false, out: "error: unknown command 'auth'" } } });
  assert.equal(old.severity, 'warn');
  assert.match(old.detail, /older Claude Code: update it/);
  // A named account: its own folder, and the step is nextlevel login
  const named = { roles: { worker: { profile: 'cw' } }, profiles: { cw: { engine: 'claude', account: 'work' } } };
  const status = (a, o) => (o.env?.CLAUDE_CONFIG_DIR === '/home/me/.nextlevel/accounts/claude/work' ? { ok: false, out: json({ loggedIn: false }) } : json({ loggedIn: true, authMethod: 'claude.ai' }));
  const two = await check('claude.login', { config: named, env: { ANTHROPIC_API_KEY: 'sk-ant-planted-abcdef' }, commands: { ...CLAUDE, 'claude auth status': status } });
  assert.equal(two.detail, 'account work (profile cw): not signed in');
  assert.equal(two.steps[0].command, 'nextlevel login cw');
  assert.ok(!('ANTHROPIC_API_KEY' in two.ctx.envs.find((e) => e)), "the owner's API key would win over the account's sign-in");
});

test('claude.model: a model pinned for a Claude Code role is tried once, and a rejected one fails with the fix (M9)', async () => {
  const CLAUDE = { 'claude --version': '2.1.283 (Claude Code)', 'claude auth status': JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }) };
  const probe = (m) => `claude -p ${MODEL_PROBE} --model ${m}`;
  assert.equal((await check('claude.model', { commands: CLAUDE })).status, 'skip', 'no role uses Claude Code');
  const own = await check('claude.model', { config: { roles: { worker: { engine: 'claude' } } }, commands: CLAUDE });
  assert.equal(own.status, 'ok');
  assert.match(own.detail, /Claude Code's own choice/);
  assert.ok(!own.ctx.calls.some((c) => c.includes('-p')), 'nothing to try: no session is started');
  const good = await check('claude.model', { config: { roles: { worker: { engine: 'claude', model: 'opus' } } }, commands: { ...CLAUDE, [probe('opus')]: 'ok' } });
  assert.equal(good.detail, 'opus (accepted by this Claude Code sign-in)');
  const bad = await check('claude.model', {
    config: { roles: { orchestrator: { engine: 'claude', model: 'claude-nope' } } },
    commands: { ...CLAUDE, [probe('claude-nope')]: { ok: false, out: "There's an issue with the selected model (claude-nope). It may not exist or you may not have access to it." } },
  });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.severity, 'error');
  assert.match(bad.detail, /^"claude-nope" \(roles\.orchestrator\.model\) was rejected: There's an issue with the selected model/);
  assert.deepEqual(bad.steps.map((s) => [s.window, s.command || s.text]), [['editor', 'in nextlevel.json set "roles": { "orchestrator": { "model": "" } }'], ['claude', '/model']]);
  // Kept until the model, Claude Code or the sign-in changes
  const again = await runCheck(byId('claude.model'), bad.ctx);
  assert.equal(again.status, 'fail');
  assert.equal(bad.ctx.calls.filter((c) => c.startsWith('claude -p')).length, 1);
  // A fallback of its own ({ engine, model, effort }) is checked too, with where it is set
  const fb = await check('claude.model', {
    config: { roles: { worker: { engine: 'agy', fallback: { engine: 'claude', model: 'claude-nope', effort: 'high' } } } },
    commands: { ...CLAUDE, [probe('claude-nope')]: { ok: false, out: 'Error: model not found' } },
  });
  assert.match(fb.detail, /\(roles\.worker\.fallback\.model\) was rejected/);
  assert.equal(fb.severity, 'warn', 'only a fallback runs on it');
  assert.equal(fb.steps[0].text, 'in nextlevel.json set "roles": { "worker": { "fallback": { "model": "" } } }');
  const slow = await check('claude.model', { config: { roles: { worker: { engine: 'claude', model: 'opus' } } }, commands: { ...CLAUDE, [probe('opus')]: { ok: false, timedOut: true } } });
  assert.equal(slow.severity, 'warn');
  assert.deepEqual(slow.ctx.cacheData, {}, 'no answer is not cached');
});

test('engine rows matter as much as the roles use them: a role (error), only a fallback (warn), none (info)', async () => {
  const claudeRole = await check('tool.claude', { commands: {}, config: { roles: { worker: { engine: 'claude' } } } });
  assert.equal(claudeRole.severity, 'error');
  assert.equal(claudeRole.detail, 'not found', 'no "only for nextlevel fix" when a role needs it');
  assert.equal((await check('tool.claude', { commands: {}, config: { roles: { worker: { fallback: 'claude' } } } })).severity, 'warn');
  const noCodex = { roles: { orchestrator: { engine: 'claude' }, worker: { engine: 'agy', fallback: '' } } };
  assert.equal((await check('tool.codex', { commands: {}, config: noCodex })).severity, 'info');
  assert.equal((await check('codex.sandbox', { config: noCodex })).status, 'skip');
  assert.equal((await check('tool.agy', { commands: {}, config: { roles: { worker: { engine: 'codex', fallback: 'agy' } } } })).severity, 'warn');
  const agyPinned = await check('agy.model', { commands: AGY, config: { roles: { worker: { profile: 'fast' } }, profiles: { fast: { engine: 'agy', model: 'gemini-9' } } } });
  assert.match(agyPinned.detail, /"gemini-9" \(profiles\.fast\.model\) not in agy models/);
});

// ---------- FR-013: tool files a quarantine took, and the owner's own add-ons in workers ----------
const ME = 'C:\\Users\\me';
const TOOL = `${ME}\\.nextlevel\\tool`;
const NPM = `${ME}\\AppData\\Roaming\\npm`;
const AGY_EXE = `${ME}\\AppData\\Local\\agy\\bin\\agy.exe`;
const shim = (target) => `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\${target}"   %*\r\n`;
const QUARANTINABLE = {
  [`${TOOL}\\bin\\nextlevel.mjs`]: '',
  [`${TOOL}\\src\\cli.mjs`]: '',
  [`${TOOL}\\src\\hub.mjs`]: '',
  [`${ME}\\.nextlevel\\bin\\nextlevel.cmd`]: '',
  [`${ME}\\.nextlevel\\bin\\nextlevel`]: '',
  'C:\\proj\\START.cmd': '',
  [AGY_EXE]: '',
  [`${ME}\\.gemini\\antigravity-cli\\bin\\agentapi.bat`]: '',
  [`${NPM}\\codex.cmd`]: shim('node_modules\\@openai\\codex\\bin\\codex.js'),
  [`${NPM}\\node_modules\\@openai\\codex\\bin\\codex.js`]: '',
  [`${NPM}\\pnpm.cmd`]: shim('node_modules\\pnpm\\pnpm.exe'),
  [`${NPM}\\node_modules\\pnpm\\package.json`]: JSON.stringify({ version: '12.6.0', bin: { pnpm: 'pnpm.exe', pn: 'pn.exe', pnpx: 'pnpx.exe', pnx: 'pnx.exe' } }),
  ...Object.fromEntries(['pnpm', 'pn', 'pnpx', 'pnx'].map((n) => [`${NPM}\\node_modules\\pnpm\\${n}.exe`, ''])),
};
const onWindows = (files, extra = {}) => ({
  platform: 'win32',
  env: { APPDATA: `${ME}\\AppData\\Roaming` },
  toolRoot: TOOL,
  files,
  dirs: [`${ME}\\.gemini\\antigravity-cli\\bin`, `${ME}\\AppData\\Local\\agy\\bin`],
  which: { agy: [AGY_EXE], codex: [`${NPM}\\codex.cmd`] },
  commands: { 'git -C C:\\proj ls-files --error-unmatch START.cmd': 'START.cmd' },
  ...extra,
});
const without = (...gone) => Object.fromEntries(Object.entries(QUARANTINABLE).filter(([f]) => !gone.some((g) => f.endsWith(g))));

test('tool.files (FR-013): nothing gone, nothing said', async () => {
  const r = await check('tool.files', onWindows(QUARANTINABLE));
  assert.deepEqual([r.status, r.detail, r.quiet], ['ok', 'none missing', true]);
});

test("tool.files (FR-013): what Bitdefender took on the owner's PC: a launcher's programs, agy's helper, START.cmd, with the steps in plain words", async () => {
  const r = await check('tool.files', onWindows(without('pnpm\\pnpm.exe', 'pnpm\\pn.exe', 'agentapi.bat', 'START.cmd')));
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'error', "agy's file, and agy runs the workers");
  assert.match(r.detail, /^the project: START\.cmd; Antigravity: agentapi\.bat; pnpm: pnpm\.exe, pn\.exe are missing: an antivirus may have quarantined them$/);
  assert.match(r.steps[0].text, /quarantine .*Restore these files, then make the one narrow exception .*Don't turn the antivirus off/);
  assert.deepEqual(r.steps.slice(1).map((s) => [s.window, s.command, s.cwd || '']), [
    ['terminal', 'git checkout -- START.cmd', 'C:\\proj'],
    ['terminal', 'agy update', ''],
    ['terminal', 'npm install -g pnpm', ''],
  ]);
  assert.ok(r.files.includes(`${NPM}\\node_modules\\pnpm\\pnpm.exe`));
});

test("tool.files (FR-013): nextlevel's own entry point, a shim's target, and an engine gone from its own installer's folder", async () => {
  const own = await check('tool.files', onWindows(without('bin\\nextlevel.mjs')));
  assert.equal(own.severity, 'error');
  assert.match(own.detail, /^nextlevel: nextlevel\.mjs is missing/);
  assert.equal(own.steps[1].command, `git -C "${TOOL}" checkout -- .`);
  assert.equal(own.steps[2].command, INSTALL_COMMAND);
  // A launcher that runs a file that is gone: Codex's (the orchestrator's engine, so an error), then only a fallback's
  const codex = await check('tool.files', onWindows(without('codex\\bin\\codex.js')));
  assert.deepEqual([codex.severity, codex.detail], ['error', 'Codex: codex.js is missing: an antivirus may have quarantined it']);
  const fallback = await check('tool.files', onWindows(without('codex\\bin\\codex.js'), { config: { roles: { orchestrator: { engine: 'agy' } } } }));
  assert.equal(fallback.severity, 'warn', "only the workers' fallback runs on Codex");
  // agy not found at all, but the folder its installer made is there: its program was taken
  const agy = await check('tool.files', onWindows(without('agy\\bin\\agy.exe'), { which: { agy: null, codex: [`${NPM}\\codex.cmd`] } }));
  assert.match(agy.detail, /^Antigravity: agy\.exe is missing/);
  // Not there and never was (no folder of its own): tool.agy says it's not installed; this says nothing
  const never = await check('tool.files', { ...onWindows(without('agy\\bin\\agy.exe', 'agentapi.bat')), dirs: [], which: { agy: null, codex: [`${NPM}\\codex.cmd`] } });
  assert.equal(never.status, 'ok');
  // Elsewhere: no START.cmd, no npm shims
  const linux = await check('tool.files', { toolRoot: '/home/me/.nextlevel/tool', files: { '/home/me/.nextlevel/tool/bin/nextlevel.mjs': '', '/home/me/.nextlevel/tool/src/cli.mjs': '', '/home/me/.nextlevel/tool/src/hub.mjs': '' } });
  assert.equal(linux.status, 'ok');
});

const AGY_MCP = `{
  // the owner's own, as agy writes them (comments and a trailing comma are fine to agy)
  "mcpServers": {
    "rafter": { "command": "cmd", "args": ["/c", "npx -y @rafter-security/cli mcp serve"] },
    "StitchMCP": { "command": "npx", "args": ["-y", "mcp-remote", "https://stitch.example/mcp"] },
    "old": { "command": "x", "disabled": true },
  },
}`;
test("workers.addons (FR-013): what of the owner's own add-ons each worker engine has, and that agy still starts its MCP servers' processes", async () => {
  const files = {
    '/home/me/.gemini/config/mcp_config.json': AGY_MCP,
    '/home/me/.gemini/GEMINI.md': '# my rules\nRun rafter before you finish.\n',
    '/home/me/.codex/config.toml': '[mcp_servers.searchy]\ncommand = "searchy"\n\n[plugins."computer-use@openai-bundled"]\nenabled = true\n',
  };
  const r = await check('workers.addons', { files });
  assert.equal(r.status, 'fail');
  assert.equal(r.severity, 'warn');
  assert.match(r.detail, /^Antigravity: your 2 MCP server\(s\) \(rafter, StitchMCP\), global rules \(GEMINI\.md\); workers start without them \(--agent nextlevel-worker\)\. Antigravity: agy starts every MCP server/);
  assert.match(r.detail, /Codex: your 1 MCP server\(s\) \(searchy\), 1 plugin\(s\); workers start without them \(-c mcp_servers\.searchy\.enabled=false \.\.\.\)/, "the workers' fallback");
  assert.deepEqual(r.steps.map((s) => s.command || ''), ['agy mcp list', '']);
  // workers.addons keeps some: said, and agy's workers get all its MCP servers' tools
  const kept = await check('workers.addons', { files, config: { workers: { addons: { mcpServers: ['rafter'] } } } });
  assert.match(kept.detail, /agy has no way to give a session only some of the MCP servers/);
  assert.match(kept.detail, /workers\.addons keeps MCP servers rafter$/);
  // Nothing of the owner's own: nothing to keep out
  const none = await check('workers.addons', {});
  assert.deepEqual([none.status, none.detail], ['ok', 'Antigravity: none of your own. Codex: none of your own']);
  // Claude Code workers: no MCP servers and none of the user's settings, with its model passed on
  const claude = await check('workers.addons', { files: { '/home/me/.claude/settings.json': '{ "model": "opus", "hooks": { "PreToolUse": [] } }', '/home/me/.claude.json': '{ "mcpServers": { "searchy": { "command": "searchy" } } }' }, config: { roles: { worker: { engine: 'claude', fallback: '' } } } });
  assert.deepEqual([claude.status, claude.detail], ['ok', 'Claude Code: your 1 MCP server(s) (searchy), hooks (PreToolUse); workers start without them (--strict-mcp-config --setting-sources ...)']);
});

test('fixes for the dashboard: --fix <id> runs one; a ui without a window never runs an installer; autoFix says which get a Fix button', async () => {
  const ids = ['project.gitignore', 'tool.agy', 'git.identity'];
  const opts = { commands: { ...GIT, 'agy --version': '1.1.16', 'git var GIT_AUTHOR_IDENT': { ok: false, err: 'unknown' } }, files: { '/proj/.gitignore': 'node_modules/\n' } };
  const run = async (fix, ui) => {
    const ctx = fakeContext(opts);
    const results = await runChecks(ctx, { checks: ids.map((id) => byId(id)), fix, ui });
    return { by: Object.fromEntries(results.map((r) => [r.id, r])), ctx, ui };
  };
  // Before any fix: which ones the dashboard offers
  const seen = await run(false, null);
  assert.deepEqual(ids.map((id) => [seen.by[id].fixable, seen.by[id].autoFix]), [[true, true], [true, false], [false, false]], 'gitignore: Fix button; agy update: steps in your window; identity: asks, so the menu only');

  const one = await run('project.gitignore', fakeUi());
  assert.equal(one.by['project.gitignore'].fixed, true);
  assert.ok(!('fixed' in one.by['tool.agy']), 'only the check that was named');
  assert.deepEqual(one.ui.ran, []);

  const windowless = await run(true, { ...fakeUi(), windowless: true });
  assert.equal(windowless.by['project.gitignore'].fixed, true);
  assert.ok(!('fixed' in windowless.by['tool.agy']), 'no installer without a window of the owner\'s');
  assert.deepEqual(windowless.ui.ran, []);
  const named = await run('tool.agy', { ...fakeUi(), windowless: true });
  assert.deepEqual(named.ui.ran, [], 'not even when it is named');

  const owner = await run(true, fakeUi());
  assert.deepEqual(owner.ui.ran, ['agy update'], 'the doctor in the owner\'s own window runs it');

  assert.deepEqual(doctorOptions(['--json']), { json: true, fix: false, fresh: false });
  assert.deepEqual(doctorOptions(['--fresh', '--json']), { json: true, fix: false, fresh: true }, 'Check again: slow answers asked again (FR-010)');
  assert.deepEqual(doctorOptions(['--fix']), { json: false, fix: true, fresh: false });
  assert.deepEqual(doctorOptions(['--fix', '--json']), { json: true, fix: true, fresh: false });
  assert.deepEqual(doctorOptions(['--fix', 'pc.sleep', '--json']), { json: true, fix: 'pc.sleep', fresh: false });
  assert.deepEqual(doctorOptions(['--fix=pc.sleep']), { json: false, fix: 'pc.sleep', fresh: false });
});

test('every fix says whether it needs the owner\'s own window: installers do, and only they are left out of the dashboard', () => {
  for (const cmd of Object.keys(TOOLS)) assert.equal(byId(`tool.${cmd}`).fixInWindow, true, `tool.${cmd} installs a program`);
  // A new fix lands here on purpose: can it run from the dashboard, with no window, no questions and no
  // console of its own? If it runs an installer, give it fixInWindow instead.
  const dashboard = CHECKS.filter((c) => c.fix && !c.fixInWindow).map((c) => c.id);
  assert.deepEqual(dashboard.sort(), ['agy.deny-list', 'agy.effort', 'claude.github', 'codex.args', 'git.commits', 'git.identity', 'install.command', 'pc.sleep', 'project.deploy-branches', 'project.env', 'project.env-example', 'project.gitignore', 'project.role-docs', 'runner.forks'].sort());
});

// GitHub checks on this PC (the self-hosted runner's part A): the repository as GitHub answers through the owner's gh.
// repo: { visibility, ownerType, admin, forks, collaborators, fail }; every gh call is recorded in the context's calls.
const ghRepo = (repo, slug = 'owner/app') => ({
  'git config --get remote.origin.url': `https://github.com/${slug}.git`,
  'gh api *': (args) => {
    // a PUT of the fork settings: GitHub has them as sent (the fix's own check then reads them)
    if (args.includes('-X')) return (repo.forks = { run: false, approval: true }), { ok: true, out: '' };
    const target = args.at(-1);
    if (repo.fail) return { ok: false, out: repo.fail };
    if (target === `repos/${slug}`) return { out: JSON.stringify({ full_name: slug, id: 7, visibility: repo.visibility, private: repo.visibility !== 'public', default_branch: 'main', owner: { login: slug.split('/')[0], type: repo.ownerType || 'User' }, permissions: { admin: repo.admin !== false } }) };
    if (target.endsWith('/fork-pr-workflows-private-repos')) {
      if (repo.forks === 'deny') return { ok: false, out: 'gh: Must have admin rights to Repository. (HTTP 403)' };
      const f = repo.forks || {};
      return { out: JSON.stringify({ run_workflows_from_fork_pull_requests: !!f.run, send_write_tokens_to_workflows: !!f.writeTokens, send_secrets_and_variables: !!f.secrets, require_approval_for_fork_pr_workflows: !!f.approval }) };
    }
    if (target.includes('/collaborators')) return { out: JSON.stringify(repo.collaborators || [{ login: 'owner', type: 'User', permissions: { admin: true, push: true } }]) };
    return { ok: false, out: 'gh: Not Found (HTTP 404)' };
  },
});

test("runner.visibility: offered only for a personal account's private repository; public, internal and an organization's aren't; gh that can't answer says so", async () => {
  const priv = await check('runner.visibility', { commands: ghRepo({ visibility: 'private' }) });
  assert.equal(priv.status, 'ok', priv.detail);
  assert.match(priv.detail, /owner\/app is a personal account's private repository: running its checks on this PC can be offered/);
  for (const [repo, words] of [
    [{ visibility: 'public' }, /owner\/app is public: running its checks on this PC isn't offered/],
    [{ visibility: 'internal' }, /is internal: running its checks on this PC isn't offered/],
    [{ visibility: 'private', ownerType: 'Organization' }, /an organization's private repository: running its checks on this PC isn't offered/],
  ]) {
    const r = await check('runner.visibility', { commands: ghRepo(repo) });
    assert.equal(r.status, 'ok', r.detail);
    assert.match(r.detail, words);
  }
  const lost = await check('runner.visibility', { commands: ghRepo({ fail: 'error connecting to api.github.com' }) });
  assert.equal(lost.status, 'fail');
  assert.equal(lost.severity, 'info');
  assert.match(lost.detail, /can't tell whether owner\/app is private: error connecting to api\.github\.com/);
  // no GitHub origin: nothing to say, and nothing asked of GitHub
  const none = await check('runner.visibility', { commands: { 'git config --get remote.origin.url': '/srv/git/app.git', 'gh api *': () => assert.fail('asked GitHub') } });
  assert.equal(none.status, 'skip');
  // only GETs: no -X, no fields
  const r = await check('runner.visibility', { commands: ghRepo({ visibility: 'private' }) });
  assert.ok(r.ctx.calls.filter((c) => c.startsWith('gh ')).every((c) => !/ -X | -[fF] /.test(c)), r.ctx.calls.join('\n'));
});

test("runner.forks: fork pull requests' workflows on without approval is an error, with a fix that turns them off with the owner's gh; off passes; unreadable warns", async () => {
  const on = await check('runner.forks', { commands: ghRepo({ visibility: 'private', forks: { run: true } }) });
  assert.equal(on.status, 'fail');
  assert.equal(on.severity, 'error');
  assert.match(on.detail, /workflows from fork pull requests are on: no approval is required/);
  const approved = await check('runner.forks', { commands: ghRepo({ visibility: 'private', forks: { run: true, approval: true } }) });
  assert.equal(approved.severity, 'warn');
  const off = await check('runner.forks', { commands: ghRepo({ visibility: 'private', forks: {} }) });
  assert.equal(off.status, 'ok', off.detail);
  const deny = await check('runner.forks', { commands: ghRepo({ visibility: 'private', forks: 'deny' }) });
  assert.equal(deny.severity, 'warn');
  assert.match(deny.detail, /can't read the fork pull request settings of owner\/app: gh: Must have admin rights/);
  // a public repository: nothing to say here (runner.visibility says why)
  const pub = await check('runner.forks', { commands: ghRepo({ visibility: 'public', forks: { run: true } }) });
  assert.equal(pub.status, 'ok');
  // the fix: one PUT with the owner's gh, every fork setting closed
  const f = await fixed('runner.forks', { commands: ghRepo({ visibility: 'private', forks: { run: true } }) });
  const put = f.ctx.calls.find((c) => c.includes(' -X PUT '));
  assert.ok(put, f.ctx.calls.join('\n'));
  assert.equal(f.fixed, true, 'checked again on what GitHub says after the fix');
  assert.match(put, /repos\/owner\/app\/actions\/permissions\/fork-pr-workflows-private-repos -F run_workflows_from_fork_pull_requests=false -F send_write_tokens_to_workflows=false -F send_secrets_and_variables=false -F require_approval_for_fork_pr_workflows=true/);
});

test('runner.collaborators: anyone but the owner who can push is named (each could run code on the PC)', async () => {
  const alone = await check('runner.collaborators', { commands: ghRepo({ visibility: 'private' }) });
  assert.equal(alone.status, 'ok');
  assert.match(alone.detail, /only owner can push/);
  const more = await check('runner.collaborators', {
    commands: ghRepo({ visibility: 'private', collaborators: [{ login: 'owner', permissions: { admin: true, push: true } }, { login: 'pal', permissions: { push: true } }, { login: 'reader', permissions: { push: false, pull: true } }] }),
  });
  assert.equal(more.status, 'fail');
  assert.equal(more.severity, 'warn');
  assert.match(more.detail, /1 other account can push to owner\/app: pal$/);
});

test('advisor.independent: the engine the advisor runs on, whether it is the orchestrator\'s, and the sign-in of an engine only the advisor uses', async () => {
  const signedIn = { 'claude auth status': JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'me@example.com', subscriptionType: 'max' }) };
  // Claude Code installed and signed in, no role on it: the automatic advisor is on it, apart from the Codex orchestrator
  const ok = await check('advisor.independent', { commands: { 'claude --version': '2.1.284 (Claude Code)', ...signedIn } });
  assert.deepEqual([ok.status, ok.severity], ['ok', 'info']);
  assert.match(ok.detail, /^on Claude Code \(automatic\)\. Independent of the orchestrator \(Codex\): it can disagree with it\.$/);
  // ... not signed in: a warning with its login command, since no other row covers that engine
  const out = await check('advisor.independent', { commands: { 'claude --version': '2.1.284 (Claude Code)', 'claude auth status': { ok: false, out: JSON.stringify({ loggedIn: false }) } } });
  assert.deepEqual([out.status, out.severity], ['fail', 'warn']);
  assert.match(out.detail, /which no other role uses, and it isn't signed in: not signed in/);
  assert.deepEqual(out.steps.map((s) => [s.window, s.command]), [['terminal', 'claude auth login']]);
  // Claude Code not installed: the orchestrator's engine, said so (information)
  const same = await check('advisor.independent', { commands: { 'codex --version': 'codex-cli 0.164.0' } });
  assert.deepEqual([same.status, same.severity], ['ok', 'info']);
  assert.match(same.detail, /^on Codex \(automatic\)\. Same engine as the orchestrator \(Codex\): it may agree with it too easily\. Another engine for it: nextlevel team set assistant --engine claude/);
  // Pinned in nextlevel.json: no sign-in asked here (the engine's own row covers a role in nextlevel.json)
  const pinned = await check('advisor.independent', { config: { roles: { assistant: { engine: 'claude', model: 'sonnet' } } }, commands: { 'claude --version': '2.1.284 (Claude Code)', 'claude auth status': { ok: false, out: '' } } });
  assert.deepEqual([pinned.status, pinned.detail], ['ok', 'on Claude Code. Independent of the orchestrator (Codex): it can disagree with it.']);
  // No read-only engine installed (an Antigravity orchestrator): said "isn't installed", with the install command,
  // never a sign-in asked of a CLI that isn't there
  const none = await check('advisor.independent', { config: { roles: { orchestrator: { engine: 'agy' }, worker: { engine: 'agy', fallback: '' } } }, commands: { 'agy --version': '1.4.6' } });
  assert.deepEqual([none.status, none.severity], ['fail', 'warn']);
  assert.match(none.detail, /^the advisor runs on Codex \(automatic\), which no other role uses, and it isn't installed$/);
  assert.deepEqual(none.steps.map((s) => [s.window, s.command]), [['terminal', 'npm install -g @openai/codex']]);
});

// The security engineer's checks (src/checks/security.mjs): a pretend Docker that answers as the scanner image does
const SEC_ON = { roles: { security: { engine: 'codex', model: 'gpt-6-sol', daybreak: true } } };
function fakeDocker({ os = 'linux', image = true, signedIn = true, probe = 'login-denied\nlogin-not-listable\nauthfile-denied\nnet-closed\nip-closed', nested = true, models } = {}) {
  return (args) => {
    const line = args.join(' ');
    if (args[0] === 'info') return { out: `"${os}" ["name=seccomp,profile=builtin"] "29.7.2"` };
    if (args[0] === 'image') return image ? { out: '["ghcr.io/openai/codex-security@sha256:a90bc3bf8b67ae1c1b046d7987bbfc0ed44dc869b938a393204ec62b5cce65fc"]' } : { ok: false, code: 1, out: 'Error: No such image' };
    if (args[0] === 'volume' && args[1] === 'inspect') return line.includes('nextlevel-sec-login-') && !signedIn ? { ok: false, code: 1 } : { out: args.includes('{{.Name}}') ? args.at(-1) : line.includes('-probe-') ? 'probe' : 'state' };
    if (args[0] === 'volume') return { out: '' };
    if (args.includes('stat')) return { out: '10001:10001 700\n10001:10001 700' };
    if (args.includes('ls')) return { out: signedIn ? 'auth.json\nlog' : 'log' };
    if (line.includes('sandbox /usr/bin/true')) return nested ? { out: '' } : { ok: false, code: 1, out: 'bwrap: No permissions to create new namespace' };
    if (line.includes(' sandbox ')) return { out: probe };
    if (line.includes('debug models')) return { out: models || JSON.stringify({ models: [{ slug: 'gpt-6-sol', available_access_programs: { cyber: ['standard', 'daybreak_blue'] } }, { slug: 'gpt-6-astra', available_access_programs: { cyber: ['standard'] } }, { slug: 'gpt-red', available_access_programs: { cyber: ['daybreak_red'] } }, { slug: 'gpt-quiet' }] }) };
    return { out: '' };
  };
}

test("security.docker, security.image, security.login: the scanner's Docker, its pinned image and its own sign-in (docs/CHECKS.md)", async () => {
  // Off: nothing is asked of Docker
  const off = await check('security.docker', { commands: { 'docker *': fakeDocker() } });
  assert.deepEqual([off.status, off.detail], ['skip', 'the security engineer is off']);
  const on = await check('security.docker', { config: SEC_ON, commands: { 'docker *': fakeDocker() } });
  assert.deepEqual([on.status, on.detail], ['ok', 'engine 29.7.2, Linux containers']);
  const win = await check('security.docker', { config: SEC_ON, commands: { 'docker *': fakeDocker({ os: 'windows' }) } });
  assert.match(win.detail, /Docker runs windows containers: the scanner needs Linux containers/);
  // Docker's API open on TCP (read from Docker Desktop's settings by its key only): an error, with where to turn it off
  const tcp = await check('security.docker', { platform: 'win32', config: SEC_ON, env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' }, files: { 'C:\\Users\\me\\AppData\\Roaming\\Docker\\settings-store.json': '{"ExposeDockerAPIOnTCP2375": true, "other": "x"}' }, commands: { 'docker *': fakeDocker() } });
  assert.deepEqual([tcp.status, tcp.severity], ['fail', 'error']);
  assert.match(tcp.detail, /API is open on TCP port 2375/);
  assert.match(tcp.steps[0].text, /Expose daemon on tcp:\/\/localhost:2375/);
  // ...and by its ports, whatever the setting says (2376 is the API with TLS): the same error
  for (const port of [2375, 2376]) {
    const open = await check('security.docker', { config: SEC_ON, tcpOpen: [port], commands: { 'docker *': fakeDocker() } });
    assert.deepEqual([open.status, open.severity], ['fail', 'error'], String(port));
    assert.equal(open.detail, `Docker's API answers on 127.0.0.1:${port}: any program on this PC, a scanned project's included, could drive Docker`);
    assert.match(open.steps[0].text, /Expose daemon on tcp:\/\/localhost:2375/);
  }
  const none = await check('security.docker', { config: SEC_ON });
  assert.match(none.detail, /^not installed/);
  // The image, pinned by its digest; pulling it is the owner's fix, in their own window
  const img = await check('security.image', { config: SEC_ON, commands: { 'docker *': fakeDocker() } });
  assert.match(img.detail, /^Codex Security 0\.7\.0 \(ghcr\.io\/openai\/codex-security@sha256:a90bc3bf8b67/);
  const noImg = await check('security.image', { config: SEC_ON, commands: { 'docker *': fakeDocker({ image: false }) } });
  assert.equal(noImg.status, 'fail');
  assert.deepEqual(noImg.steps.map((s) => s.command), ['docker pull ghcr.io/openai/codex-security@sha256:a90bc3bf8b67ae1c1b046d7987bbfc0ed44dc869b938a393204ec62b5cce65fc']);
  assert.equal(byId('security.image').fixInWindow, true, 'an install: never from the dashboard');
  const ui = fakeUi();
  byId('security.image').fix(noImg.ctx, ui);
  assert.deepEqual(ui.ran, ['docker pull ghcr.io/openai/codex-security@sha256:a90bc3bf8b67ae1c1b046d7987bbfc0ed44dc869b938a393204ec62b5cce65fc']);
  // The sign-in: its volume's file names, never their content
  const inOk = await check('security.login', { config: SEC_ON, commands: { 'docker *': fakeDocker() } });
  assert.equal(inOk.status, 'ok');
  assert.ok(!inOk.ctx.calls.some((c) => /\bcat\b|auth\.json/.test(c)), 'nothing reads the sign-in');
  const out = await check('security.login', { config: SEC_ON, commands: { 'docker *': fakeDocker({ signedIn: false }) } });
  assert.deepEqual([out.status, out.steps[0].command], ['fail', 'nextlevel security login']);
});

test("security.probe and security.daybreak: Codex's sandbox inside the scanner, kept for the image; Daybreak Blue from its model list (docs/CHECKS.md)", async () => {
  const ok = await check('security.probe', { config: SEC_ON, commands: { 'docker *': fakeDocker() } });
  assert.equal(ok.status, 'ok', ok.detail);
  assert.deepEqual(Object.keys(ok.ctx.cacheData['security.probes']), ['sha256:a90bc3bf8b67ae1c1b046d7987bbfc0ed44dc869b938a393204ec62b5cce65fc'], 'kept for the image digest');
  const probeRun = ok.ctx.calls.find((c) => c.includes(' sandbox ') && !c.includes('/usr/bin/true'));
  assert.match(probeRun, /nextlevel-sec-probe-/, 'against a throwaway sign-in volume, never the real one');
  assert.doesNotMatch(probeRun, /nextlevel-sec-login-/);
  const leaky = await check('security.probe', { config: SEC_ON, commands: { 'docker *': fakeDocker({ probe: 'login-readable\nlogin-listable\nauthfile-readable\nnet-open' }) } });
  assert.deepEqual([leaky.status, leaky.severity], ['fail', 'error']);
  assert.match(leaky.detail, /answered login-readable, login-listable, authfile-readable, net-open .*: no scan runs with this scanner/);
  const nested = await check('security.probe', { config: SEC_ON, commands: { 'docker *': fakeDocker({ nested: false }) } });
  assert.match(nested.detail, /Codex's sandbox can't start in the scanner \(nested namespaces/);
  // Daybreak
  const works = await check('security.daybreak', { config: SEC_ON, commands: { 'docker *': fakeDocker() } });
  assert.deepEqual([works.status, works.detail], ['ok', 'Daybreak Blue works on gpt-6-sol']);
  const standardOnly = await check('security.daybreak', { config: { roles: { security: { engine: 'codex', model: 'gpt-6-astra', daybreak: true } } }, commands: { 'docker *': fakeDocker() } });
  assert.deepEqual([standardOnly.status, standardOnly.severity], ['fail', 'error']);
  assert.match(standardOnly.detail, /gpt-6-astra doesn't take Daybreak Blue \(standard\)/);
  const red = await check('security.daybreak', { config: { roles: { security: { engine: 'codex', model: 'gpt-red', daybreak: true } } }, commands: { 'docker *': fakeDocker() } });
  assert.match(red.detail, /gpt-red doesn't take Daybreak Blue \(daybreak_red\)/, 'never Red');
  const quiet = await check('security.daybreak', { config: { roles: { security: { engine: 'codex', model: 'gpt-quiet', daybreak: true } } }, commands: { 'docker *': fakeDocker() } });
  assert.deepEqual([quiet.status, quiet.unconfirmed], ['ok', true]);
  assert.match(quiet.detail, /^Daybreak unconfirmed on gpt-quiet/);
  const pick = await check('security.daybreak', { config: { roles: { security: { engine: 'codex', daybreak: true } } }, commands: { 'docker *': fakeDocker() } });
  assert.equal(pick.pick, 'gpt-6-sol', 'no model: the first that takes Blue');
  const standard = await check('security.daybreak', { config: { roles: { security: { engine: 'codex', model: 'gpt-6-astra', daybreak: false } } }, commands: { 'docker *': fakeDocker() } });
  assert.deepEqual([standard.status, standard.severity], ['fail', 'info']);
  assert.match(standard.detail, /^standard safeguards on gpt-6-astra: OpenAI's cyber screening may block parts of a scan/);
});

test('every registered check is valid, has a unique id and a learnMore, and is covered above', () => {
  const ids = CHECKS.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'ids are unique');
  for (const c of CHECKS) {
    assert.deepEqual(validateCheck(c), [], c.id);
    assert.match(c.learnMore || '', /^docs\/CHECKS\.md#[a-z0-9-]+$/, `${c.id} has a learnMore`);
  }
  const docs = fs.readFileSync(new URL('../docs/CHECKS.md', import.meta.url), 'utf8');
  for (const c of CHECKS) assert.ok(docs.includes(`### ${c.id}`), `docs/CHECKS.md explains ${c.id}`);
  assert.deepEqual(ids.filter((id) => !covered.has(id)), [], 'every check has a unit test');
});

test('a row says its fix once: the one-line hint never repeats a step\'s command', async () => {
  // The "GitHub repo" row printed "-> PowerShell, in the project folder: gh repo create ..." and then the same step
  const row = formatResults([await check('git.remote', { commands: GIT })], { platform: 'win32' });
  assert.equal(row.split('gh repo create').length - 1, 1, row);
  assert.ok(resultsSeen.length > 80);
  for (const r of resultsSeen) {
    // a whole command line, that is; naming a slash command such as /model in a sentence is fine
    for (const s of r.steps) if (s.command?.includes(' ')) assert.ok(!r.next.includes(s.command), `${r.id}: the hint "${r.next}" repeats the step ${s.command}`);
  }
});

test('every step says which window to type it in, and has something to type or do (FR-001 #8)', () => {
  assert.ok(stepsSeen.length > 40);
  for (const s of stepsSeen) {
    assert.ok(Object.hasOwn(WINDOWS, s.window), `${s.id}: unknown window ${s.window}`);
    assert.ok(s.command || s.text, `${s.id}: a step with nothing in it`);
    if (s.command?.startsWith('/')) assert.ok(['codex', 'agy', 'claude'].includes(s.window), `${s.id}: slash command ${s.command} outside the tool that runs it`);
  }
});
