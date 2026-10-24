// Installing nextlevel (M3): the nextlevel command (`nextlevel _install`), taking over the command that
// `npm link` made before there was an installer, and the PowerShell installer itself (install.ps1), run
// the way the owner runs it (through iex) against a fake "GitHub" (helpers.mjs). Windows runs it with
// Windows PowerShell; elsewhere with pwsh when it is installed. Registry changes go to a scratch key.
//   npm test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { INSTALL_COMMAND, PACKAGE } from '../src/lib/install.mjs';
import { REPO, TOOL_URL, fakeGithubTool, makeSandbox, processesGone, withEnv } from './helpers.mjs';

const IS_WIN = process.platform === 'win32';
const PS = IS_WIN ? 'powershell.exe' : 'pwsh';
const hasPs = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0;
const ps = (script, env = process.env) => spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', env, timeout: 60_000 });

// A scratch registry key standing in for HKCU\Environment, with a Path that has an unexpanded entry.
function scratchKey() {
  const key = `Software\\nextlevel-test-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const r = ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('${key}'); $k.SetValue('Path', '%USERPROFILE%\\keep', [Microsoft.Win32.RegistryValueKind]::ExpandString); $k.Close()`);
  assert.equal(r.status, 0, r.stderr);
  const read = () => {
    const out = ps(`$k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('${key}'); $k.GetValueKind('Path'); $k.GetValue('Path', '', 'DoNotExpandEnvironmentNames')`).stdout.trim().split(/\r?\n/);
    return { kind: out[0], value: out.slice(1).join('') };
  };
  const remove = () => ps(`[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree('${key}', $false)`);
  return { key, read, remove };
}

// What `npm link` leaves in npm's global folder for a package: a link to its folder, and command files.
function fakeNpmLink(prefix, target) {
  const link = IS_WIN ? path.join(prefix, 'node_modules', PACKAGE) : path.join(prefix, 'lib', 'node_modules', PACKAGE);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, IS_WIN ? 'junction' : 'dir');
  const shims = [];
  if (IS_WIN) {
    const entry = `node_modules\\${PACKAGE}\\bin\\nextlevel.mjs`;
    for (const [name, text] of [
      ['nextlevel.cmd', `@ECHO off\r\nnode "%~dp0\\${entry}" %*\r\n`],
      ['nextlevel.ps1', `#!/usr/bin/env pwsh\n& node "$basedir/${entry}" $args\n`],
      ['nextlevel', `#!/bin/sh\nexec node "$basedir/${entry.replace(/\\/g, '/')}" "$@"\n`],
    ]) {
      fs.writeFileSync(path.join(prefix, name), text);
      shims.push(path.join(prefix, name));
    }
    fs.writeFileSync(path.join(prefix, 'codex.cmd'), '@echo off\r\nrem another package\r\n');
  } else {
    fs.mkdirSync(path.join(prefix, 'bin'), { recursive: true });
    fs.symlinkSync(`../lib/node_modules/${PACKAGE}/bin/nextlevel.mjs`, path.join(prefix, 'bin', 'nextlevel'));
    shims.push(path.join(prefix, 'bin', 'nextlevel'));
    fs.writeFileSync(path.join(prefix, 'bin', 'codex'), '#!/bin/sh\n');
  }
  return { link, shims, other: IS_WIN ? path.join(prefix, 'codex.cmd') : path.join(prefix, 'bin', 'codex') };
}
const gone = (f) => {
  try {
    fs.lstatSync(f);
    return false;
  } catch {
    return true;
  }
};

// Run the command file the installer made, as PowerShell or a terminal would.
function runShim(bin, args, env, cwd = undefined) {
  const r = IS_WIN
    ? spawnSync('cmd.exe', ['/d', '/s', '/c', `""${path.join(bin, 'nextlevel.cmd')}" ${args.join(' ')}"`], { encoding: 'utf8', env, cwd, windowsVerbatimArguments: true })
    : spawnSync(path.join(bin, 'nextlevel'), args, { encoding: 'utf8', env, cwd });
  return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}

// A sandbox with the tool cloned where the installer puts it, and npm's global folder.
function setup({ branch } = {}) {
  const box = makeSandbox();
  const gh = fakeGithubTool(box);
  const base = path.join(box.env.HOME, '.nextlevel');
  const tool = path.join(base, 'tool');
  const bin = path.join(base, 'bin');
  const prefix = path.join(box.tmp, 'npm-global');
  fs.mkdirSync(prefix);
  const clone = () => {
    if (branch) gh.git('push', '-q', 'origin', `HEAD:refs/heads/${branch}`);
    box.gitIn(box.tmp, 'clone', '-q', ...(branch ? ['-b', branch] : []), TOOL_URL, tool);
  };
  return { box, gh, base, tool, bin, prefix, clone, env: (extra = {}) => withEnv(box.env, { FAKE_NPM_PREFIX: prefix, ...extra }) };
}

test('_install makes the nextlevel command and takes over the one npm link made for the same folder', () => {
  const s = setup();
  const reg = IS_WIN ? scratchKey() : null;
  try {
    s.clone();
    const npm = fakeNpmLink(s.prefix, s.tool);
    // Windows: the user PATH (a scratch key here); elsewhere the folder must already be on PATH
    const env = s.env(IS_WIN ? { NEXTLEVEL_PATH_KEY: reg.key } : { PATH: `${s.bin}${path.delimiter}${s.box.env.PATH}` });
    const install = () => spawnSync(process.execPath, [path.join(s.tool, 'bin', 'nextlevel.mjs'), '_install'], { encoding: 'utf8', env });
    const r = install();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`Made the nextlevel command: .*nextlevel${IS_WIN ? '\\.cmd' : ''} \\(it runs the tool in `));
    assert.match(r.stdout, /Removed the nextlevel command that npm link made earlier/);
    assert.ok(gone(npm.link), 'the link is gone');
    for (const f of npm.shims) assert.ok(gone(f), `${f} is gone`);
    assert.ok(fs.existsSync(npm.other), "another package's command stays");
    assert.ok(fs.existsSync(path.join(s.tool, 'bin', 'nextlevel.mjs')), 'the tool itself is untouched');
    assert.equal(s.box.gitIn(s.tool, 'status', '--porcelain'), '', 'and unchanged');
    const v = runShim(s.bin, ['version'], s.box.env);
    assert.equal(v.code, 0, v.out);
    // (compared as folders: the Windows runner's temp folder has a short 8.3 name, RUNNER~1)
    const shown = v.out.trim().split(' in ').pop();
    assert.equal(fs.realpathSync.native(shown).toLowerCase(), fs.realpathSync.native(s.tool).toLowerCase(), v.out);
    if (IS_WIN) {
      assert.match(r.stdout, /Added .*bin to your PATH/);
      const after = reg.read();
      assert.equal(after.kind, 'ExpandString');
      assert.equal(after.value, `%USERPROFILE%\\keep;${s.bin}`, 'the other entries stay unexpanded');
    }
    // Again: nothing to change, nothing doubled
    const again = install();
    assert.equal(again.status, 0);
    assert.match(again.stdout, /Checked the nextlevel command/);
    if (IS_WIN) {
      assert.match(again.stdout, /is on your PATH/);
      assert.equal(reg.read().value, `%USERPROFILE%\\keep;${s.bin}`);
    }
  } finally {
    reg?.remove();
    s.box.cleanup();
  }
});

test('_install leaves npm link alone when it points at another folder, or when the new command is not on PATH yet', () => {
  const s = setup();
  try {
    s.clone();
    const elsewhere = path.join(s.box.tmp, 'my-checkout');
    fs.mkdirSync(elsewhere);
    const npm = fakeNpmLink(s.prefix, elsewhere);
    const env = s.env({ NEXTLEVEL_NO_PATH: '1' });
    const other = spawnSync(process.execPath, [path.join(s.tool, 'bin', 'nextlevel.mjs'), '_install'], { encoding: 'utf8', env });
    assert.equal(other.status, 0, other.stderr);
    assert.match(other.stdout, /npm also has a nextlevel command, for another folder \(.*my-checkout\)/);
    assert.match(other.stdout, /Left PATH alone \(NEXTLEVEL_NO_PATH=1\)/);
    assert.ok(!gone(npm.link));
    fs.unlinkSync(npm.link);
    for (const f of npm.shims) fs.unlinkSync(f);

    const ours = fakeNpmLink(s.prefix, s.tool);
    const kept = spawnSync(process.execPath, [path.join(s.tool, 'bin', 'nextlevel.mjs'), '_install'], { encoding: 'utf8', env });
    assert.match(kept.stdout, /npm link's nextlevel command .* runs this folder too; it stays until .* is on your PATH/);
    assert.ok(!gone(ours.link), 'without the new command on PATH, the old one stays');
  } finally {
    s.box.cleanup();
  }
});

// ---------- install.ps1 ----------
test('install.ps1 is ASCII and never exits (it runs through iex in the owner\'s window)', () => {
  const text = fs.readFileSync(path.join(REPO, 'install.ps1'), 'utf8');
  assert.ok(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(text), 'ASCII only: Windows PowerShell decodes piped text in the console code page');
  const code = text
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(code, /\bexit\b/i, 'exit would close the window');
});

test('the install command is the same everywhere it is shown', () => {
  const read = (...f) => fs.readFileSync(path.join(REPO, ...f), 'utf8');
  for (const [file, text] of [
    ['install.ps1', read('install.ps1')],
    ['README.md', read('README.md')],
    ['docs/GUIDE.md', read('docs', 'GUIDE.md')],
  ]) {
    assert.ok(text.includes(INSTALL_COMMAND), `${file} shows ${INSTALL_COMMAND}`);
  }
  assert.ok(read('templates', 'project', 'START.cmd').includes(INSTALL_COMMAND.replaceAll('|', '^|')), 'START.cmd shows it (| escaped for cmd)');
});

// The owner's way: the script's text through iex, in a PowerShell that can't ask questions.
function installer(s, extra = {}, reg = null) {
  const env = s.env({
    NEXTLEVEL_TEST_INSTALLER: path.join(REPO, 'install.ps1'),
    ...(IS_WIN ? { NEXTLEVEL_PATH_KEY: reg.key } : { PATH: `${s.bin}${path.delimiter}${s.box.env.PATH}` }),
    ...extra,
  });
  const r = spawnSync(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'iex ([IO.File]::ReadAllText($env:NEXTLEVEL_TEST_INSTALLER))'], {
    encoding: 'utf8',
    env,
    timeout: 240_000,
  });
  return `${r.stdout || ''}${r.stderr || ''}`;
}

test('install.ps1 takes over the hand install: the clone moves from its old branch to main, and npm link\'s command is replaced', { skip: !hasPs && `${PS} is not installed` }, () => {
  const s = setup({ branch: 'claude/practical-bohr-z5rpsr' });
  const reg = IS_WIN ? scratchKey() : null;
  try {
    s.clone(); // what the M1 owner check did, before npm link
    const npm = fakeNpmLink(s.prefix, s.tool);
    s.gh.commit('M2 and M3', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\nM2 and M3\n'));
    const out = installer(s, {}, reg);
    assert.match(out, /Found nextlevel there: bringing it up to date\./, out);
    assert.match(out, /Moved the tool from the branch claude\/practical-bohr-z5rpsr to main \(that branch is still there\)\./);
    assert.match(out, /Removed the nextlevel command that npm link made earlier/);
    assert.match(out, /nextlevel \d+\.\d+\.\d+ \(main @ \w+\) in /);
    assert.match(out, /nextlevel is installed\./);
    const git = (...a) => s.box.gitIn(s.tool, ...a);
    assert.equal(git('symbolic-ref', '--short', 'HEAD'), 'main');
    assert.equal(git('rev-parse', 'HEAD'), s.gh.git('rev-parse', 'origin/main'));
    assert.equal(git('rev-parse', '--abbrev-ref', '@{u}'), 'origin/main');
    assert.ok(git('branch', '--list', 'claude/practical-bohr-z5rpsr'), 'the old branch is kept');
    assert.ok(gone(npm.link));
    assert.ok(fs.existsSync(path.join(s.tool, 'bin', 'nextlevel.mjs')));
    assert.match(runShim(s.bin, ['version'], s.box.env).out, /\(main @ \w+\)/);
  } finally {
    reg?.remove();
    s.box.cleanup();
  }
});

test('install.ps1: a fresh install (gh, or plain git once public), a repair, changed files, a folder that is not a clone', { skip: !hasPs && `${PS} is not installed` }, () => {
  const s = setup();
  const reg = IS_WIN ? scratchKey() : null;
  try {
    const fresh = installer(s, {}, reg);
    assert.match(fresh, /Getting nextlevel \(DYevseyev\/nextlevelorc\) into /, fresh);
    assert.match(fresh, /nextlevel is installed\./);
    assert.equal(s.box.gitIn(s.tool, 'config', '--get', 'remote.origin.url'), TOOL_URL, 'the GitHub URL (the tests redirect it with insteadOf)');
    assert.equal(s.box.gitIn(s.tool, 'symbolic-ref', '--short', 'HEAD'), 'main');

    // Running it again repairs: a deleted command comes back
    const shim = path.join(s.bin, IS_WIN ? 'nextlevel.cmd' : 'nextlevel');
    fs.rmSync(shim);
    const repair = installer(s, {}, reg);
    assert.match(repair, /Found nextlevel there/, repair);
    assert.ok(fs.existsSync(shim));

    // Files changed by hand stop it, and stay as they are
    fs.appendFileSync(path.join(s.tool, 'README.md'), '\nmine\n');
    s.gh.commit('newer', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\nnewer\n'));
    const before = s.box.gitIn(s.tool, 'rev-parse', 'HEAD');
    const dirty = installer(s, {}, reg);
    assert.match(dirty, /Files in .* were changed by hand, so the installer leaves that folder as it is/, dirty);
    assert.match(dirty, /README\.md/);
    assert.match(dirty, /git -C ".*tool" stash/);
    assert.equal(s.box.gitIn(s.tool, 'rev-parse', 'HEAD'), before);
    assert.match(fs.readFileSync(path.join(s.tool, 'README.md'), 'utf8'), /mine/);

    // A folder that isn't a clone is moved aside, and a fresh clone made without gh (a public repository)
    fs.rmSync(s.tool, { recursive: true, force: true, maxRetries: 5 });
    fs.mkdirSync(s.tool);
    fs.writeFileSync(path.join(s.tool, 'unzipped.txt'), 'x');
    fs.rmSync(path.join(s.box.env.HOME, '.config', 'gh', 'hosts.yml')); // gh isn't signed in
    const aside = installer(s, {}, reg);
    assert.match(aside, /wasn't a git clone \(an unzipped or copied folder\?\): moved it to .*tool\.old-\d{8}-\d{6}/, aside);
    assert.match(aside, /nextlevel is installed\./);
    const old = fs.readdirSync(s.base).find((f) => f.startsWith('tool.old-'));
    assert.ok(fs.existsSync(path.join(s.base, old, 'unzipped.txt')), 'nothing is thrown away');
    assert.equal(s.box.gitIn(s.tool, 'rev-parse', 'HEAD'), s.gh.git('rev-parse', 'origin/main'));
  } finally {
    reg?.remove();
    s.box.cleanup();
  }
});

test('install.ps1 with a release (safe updates): a pinned install from before releases moves to the newest release, in a folder of its own, with the launcher; a re-run repairs; git housekeeping is off', { skip: !hasPs && `${PS} is not installed` }, () => {
  const s = setup();
  const reg = IS_WIN ? scratchKey() : null;
  try {
    // The owner's install, pinned for the last manual pause (nextlevel update --to <commit> on the old code)
    s.clone();
    const pinnedAt = s.box.gitIn(s.tool, 'rev-parse', 'HEAD');
    s.box.gitIn(s.tool, 'switch', '-q', '--detach', pinnedAt);
    s.gh.commit('releases', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\nreleases\n'));
    s.gh.tag('v0.0.9', { message: 'nextlevel v0.0.9\n\nFixes:\n- before releases\n' }); // older than the first release: never one
    const v010 = s.gh.release('v0.1.0', { notes: 'New:\n- Releases instead of main.\n\nAfter install:\n- Nothing.' });
    s.gh.commit('after the release', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\nunreleased\n'));

    const out = installer(s, {}, reg);
    assert.match(out, /nextlevel v0\.1\.0 is the release to install\./, out);
    assert.match(out, /It runs nextlevel v0\.1\.0 \(.*versions.v0\.1\.0\), or the version a project follows\./, out);
    assert.match(out, /nextlevel is installed\./);
    const v = path.join(s.base, 'versions', 'v0.1.0');
    assert.equal(s.box.gitIn(v, 'rev-parse', 'HEAD'), v010, 'the release, never main\'s head');
    assert.ok(fs.existsSync(path.join(s.bin, 'launch.mjs')));
    const versions = JSON.parse(fs.readFileSync(path.join(s.base, 'versions.json'), 'utf8'));
    assert.equal(versions.release, 'v0.1.0');
    const cmd = fs.readFileSync(path.join(s.bin, IS_WIN ? 'nextlevel.cmd' : 'nextlevel'), 'utf8');
    assert.match(cmd, /launch\.mjs/, 'the command runs the launcher');
    const ver = runShim(s.bin, ['version'], s.box.env, s.box.tmp);
    assert.equal(ver.code, 0, ver.out);
    assert.match(ver.out, /^nextlevel v0\.1\.0 \(release\) in .*versions.v0\.1\.0/);
    // git's automatic housekeeping is off in the clone, and so in every version's folder (KNOWN_ISSUES, "git")
    for (const [k, want] of [['gc.auto', '0'], ['gc.autoDetach', 'false'], ['maintenance.auto', 'false'], ['maintenance.autoDetach', 'false']]) {
      assert.equal(s.box.gitIn(s.tool, 'config', '--local', '--get', k), want, k);
    }
    assert.ok(JSON.parse(fs.readFileSync(path.join(s.base, 'releases.json'), 'utf8')).seen['v0.1.0'], 'the release is recorded as seen');

    // A repair: the version's folder gone (an antivirus took it) stops the command loudly, and the installer puts it back
    fs.rmSync(v, { recursive: true, force: true, maxRetries: 5 });
    const broken = runShim(s.bin, ['version'], s.box.env, s.box.tmp);
    assert.equal(broken.code, 1);
    assert.match(broken.out, /nextlevel v0\.1\.0 \(release\) isn't on this PC any more/);
    assert.match(broken.out, /Nothing was run/);
    s.box.gitIn(s.tool, 'worktree', 'prune');
    const repair = installer(s, {}, reg);
    assert.match(repair, /nextlevel is installed\./, repair);
    assert.match(runShim(s.bin, ['version'], s.box.env, s.box.tmp).out, /^nextlevel v0\.1\.0 \(release\)/);
  } finally {
    reg?.remove();
    s.box.cleanup();
  }
});

test('install.ps1 takes a folder (NEXTLEVEL_DIR): the install moves there, the command and updates follow it, and a re-run stays there', { skip: !hasPs && `${PS} is not installed` }, () => {
  const s = setup();
  const reg = IS_WIN ? scratchKey() : null;
  const real = (f) => fs.realpathSync.native(f).toLowerCase();
  try {
    assert.match(installer(s, {}, reg), /nextlevel is installed\./);
    s.box.gitIn(s.tool, 'branch', 'kept-branch'); // the clone's own state goes with it
    const dest = path.join(s.box.tmp, 'Desktop', 'DEV', 'claude', 'nextlevel');
    const moved = installer(s, { NEXTLEVEL_DIR: dest }, reg);
    assert.match(moved, /the tool goes in .*nextlevel/, moved);
    assert.match(moved, /Moved nextlevel from .*tool to .*nextlevel\./);
    assert.match(moved, /nextlevel now runs from .*nextlevel; the nextlevel command and its updates use that folder\./);
    assert.match(moved, /nextlevel is installed\./);
    assert.ok(!fs.existsSync(s.tool), 'moved, not copied');
    assert.ok(s.box.gitIn(dest, 'branch', '--list', 'kept-branch'), 'the same clone');
    assert.equal(s.box.gitIn(dest, 'symbolic-ref', '--short', 'HEAD'), 'main');
    const v = runShim(s.bin, ['version'], s.box.env, s.box.tmp);
    assert.equal(v.code, 0, v.out);
    assert.equal(real(v.out.trim().split(' in ').pop()), real(dest), 'the command runs the new folder');
    const state = JSON.parse(fs.readFileSync(path.join(s.base, 'state.json'), 'utf8'));
    assert.equal(real(state.tool.dir), real(dest), 'remembered for the next run');

    // Again without NEXTLEVEL_DIR: it stays in the new folder and updates it there
    s.gh.commit('newer', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\nnewer\n'));
    const again = installer(s, {}, reg);
    assert.match(again, /the tool goes in .*nextlevel/, again);
    assert.doesNotMatch(again, /Moved nextlevel/);
    assert.equal(s.box.gitIn(dest, 'rev-parse', 'HEAD'), s.gh.git('rev-parse', 'origin/main'));
    assert.ok(!fs.existsSync(s.tool), 'nothing new in the old place');
    // With no release published, nextlevel update leaves it as it is (releases replace following main)
    s.gh.commit('newest', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\nnewest\n'));
    const up = runShim(s.bin, ['update'], s.box.env, s.box.tmp);
    assert.equal(up.code, 0, up.out);
    assert.match(up.out, /No nextlevel release has been published yet, so this nextlevel stays as it is/);
    assert.notEqual(s.box.gitIn(dest, 'rev-parse', 'HEAD'), s.gh.git('rev-parse', 'origin/main'));

    // A folder with other things in it is the owner's: refused, and nothing moves
    const busy = path.join(s.box.tmp, 'Desktop', 'DEV');
    const refused = installer(s, { NEXTLEVEL_DIR: busy }, reg);
    assert.match(refused, /already has other files in it\. nextlevel goes in a folder of its own: name a new one, for example .*DEV.nextlevel/, refused);
    assert.ok(fs.existsSync(path.join(dest, 'bin', 'nextlevel.mjs')));
  } finally {
    reg?.remove();
    s.box.cleanup();
  }
});

// A path's short 8.3 form (C:\Users\RUNNER~1\...), as Windows gives it: the same folder, named another way.
const shortPath = (p) => spawnSync('cmd.exe', ['/d', '/c', `for %I in ("${p}") do @echo %~sI`], { encoding: 'utf8', windowsVerbatimArguments: true }).stdout.trim();

test('install.ps1 sees the same folder in its short 8.3 form and its long one: a nextlevel running from the short name, a remembered short name', { skip: (!IS_WIN || !hasPs) && 'Windows only (8.3 names)' }, async (t) => {
  const s = setup();
  const reg = scratchKey();
  let child;
  try {
    // The tool in a folder with a long name, and that folder's short name as Windows would give it
    const long = path.join(fs.realpathSync.native(s.box.tmp), 'Tool Folder With A Long Name');
    s.box.gitIn(s.box.tmp, 'clone', '-q', TOOL_URL, long);
    const short = shortPath(long);
    if (!short || short.toLowerCase() === long.toLowerCase()) {
      t.skip(`this drive keeps no 8.3 names (${short || 'none'})`);
      return;
    }
    assert.match(short, /~/, short);
    fs.mkdirSync(s.base, { recursive: true });
    const remember = (dir) => fs.writeFileSync(path.join(s.base, 'state.json'), JSON.stringify({ tool: { dir, at: new Date().toISOString() } }));

    // A hub started from the short name; the installer knows the folder by its long name
    remember(long);
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(short, 'bin', 'nextlevel.mjs'), 'run'], { stdio: 'ignore' });
    await once(child, 'spawn'); // (it runs: Windows lists it with its command line)
    const waits = installer(s, { NEXTLEVEL_DIR: long }, reg);
    assert.match(waits, /nextlevel is running on this PC \(1 process\(es\)/, waits);
    assert.ok(!fs.existsSync(s.bin), 'nothing was changed');
    child.kill();
    await processesGone([child.pid]);
    child = null;

    // Remembered by its short name, asked for by its long one: the same folder, so nothing moves
    remember(short);
    const same = installer(s, { NEXTLEVEL_DIR: long }, reg);
    assert.doesNotMatch(same, /Moved nextlevel|inside each other|already has other files/, same);
    assert.match(same, /Found nextlevel there: bringing it up to date\./);
    assert.match(same, /nextlevel is installed\./);
    assert.ok(fs.existsSync(path.join(long, 'bin', 'nextlevel.mjs')));
  } finally {
    child?.kill();
    reg.remove();
    s.box.cleanup();
  }
});

test('install.ps1 waits while nextlevel runs from the folder it would change', { skip: (!IS_WIN || !hasPs) && 'Windows only (it asks Windows for the processes)' }, async () => {
  const s = setup();
  const reg = scratchKey();
  let child;
  try {
    s.clone();
    // A node process whose command line names the tool, as a hub or worker would
    child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', path.join(s.tool, 'bin', 'nextlevel.mjs'), 'run'], { stdio: 'ignore' });
    await once(child, 'spawn'); // (it runs: Windows lists it with its command line)
    const out = installer(s, {}, reg);
    assert.match(out, /nextlevel is running on this PC \(1 process\(es\)/, out);
    assert.ok(!fs.existsSync(s.bin), 'nothing was changed');
  } finally {
    child?.kill();
    reg.remove();
    s.box.cleanup();
  }
});

// Moving an install to another repository (where nextlevel is published now, docs: the open-source release): only when
// the owner names the one it leaves (NEXTLEVEL_MOVE_FROM), never from an agent's session, and with a folder move too.
// What it had stays: the releases it saw (never "gone"), its version folders and the projects pinned to them, field
// reports going to the old repository, and fixes waiting there closed with a note. The new repository's history is
// unrelated, and its first release is installed all the same; its next one is offered.
test('install.ps1 moves an install to another repository only when the owner names the one it leaves, and keeps what it had', { skip: !hasPs && `${PS} is not installed` }, () => {
  const s = setup();
  const reg = IS_WIN ? scratchKey() : null;
  const PRIVATE = 'DYevseyev/nextlevelorc';
  const PUBLIC = 'example/nextlevel-public';
  try {
    // The owner's install: v0.1.0 of the private repository, a project pinned to it, a fix waiting there
    const v010 = s.gh.release('v0.1.0');
    assert.match(installer(s, {}, reg), /nextlevel is installed\./);
    const pinned = path.join(s.box.tmp, 'pinned-project');
    fs.mkdirSync(pinned);
    s.box.gitIn(pinned, 'init', '-q');
    const key = IS_WIN ? fs.realpathSync.native(pinned).toLowerCase() : fs.realpathSync.native(pinned);
    fs.writeFileSync(path.join(s.base, 'channels.json'), JSON.stringify({ protocol: 1, projects: { [key]: { channel: 'pin', ref: 'v0.1.0' } } }));
    const stateFile = path.join(s.base, 'state.json');
    const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    fs.writeFileSync(stateFile, JSON.stringify({ ...state(), fixes: [{ repo: PRIVATE, number: 7, title: 'a fix', state: 'started' }, { repo: PRIVATE, number: 5, state: 'fixed' }] }));

    // Where nextlevel is published now: a history of its own
    const pub = fakeGithubTool(s.box, { slug: PUBLIC });
    pub.commit('the public version', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\npublic\n'));
    const v020 = pub.release('v0.2.0');
    const moveEnv = { NEXTLEVEL_REPO: PUBLIC };
    const origin = () => s.box.gitIn(s.tool, 'config', '--get', 'remote.origin.url');

    // Without NEXTLEVEL_MOVE_FROM: nothing changes, and it says how
    const asked = installer(s, moveEnv, reg);
    assert.match(asked, new RegExp(`is a clone of .*nextlevelorc\\.git, not of ${PUBLIC}\\. To move this install to ${PUBLIC}`), asked);
    assert.match(asked, /\$env:NEXTLEVEL_MOVE_FROM = 'DYevseyev\/nextlevelorc'/);
    assert.equal(origin(), TOOL_URL);
    // Naming another repository, or from an agent's session: refused, nothing changes
    assert.match(installer(s, { ...moveEnv, NEXTLEVEL_MOVE_FROM: 'someone/else' }, reg), /NEXTLEVEL_MOVE_FROM is someone\/else, but .* follows .*: nothing was changed/);
    assert.match(installer(s, { ...moveEnv, NEXTLEVEL_MOVE_FROM: PRIVATE, NEXTLEVEL_AGENT: 'worker' }, reg), /an agent's session: nothing was changed/);
    assert.equal(origin(), TOOL_URL);

    // The owner's move, with a folder move too (NEXTLEVEL_DIR): settled before the folder moves
    const dest = path.join(s.box.tmp, 'Tools', 'nextlevel');
    const out = installer(s, { ...moveEnv, NEXTLEVEL_MOVE_FROM: PRIVATE, NEXTLEVEL_DIR: dest }, reg);
    assert.match(out, new RegExp(`This install follows ${PUBLIC} from now on \\(it followed ${PRIVATE}, kept as the git remote nextlevel-previous\\)`), out);
    assert.match(out, /nextlevel v0\.2\.0 is the release to install\./);
    assert.match(out, /The releases this install had from DYevseyev\/nextlevelorc \(v0\.1\.0\) stay as they are/);
    assert.match(out, new RegExp(`Field reports from this PC keep going to ${PRIVATE}, not ${PUBLIC}`));
    assert.match(out, /Fixes still waiting in DYevseyev\/nextlevelorc \(#7\) are no longer followed/);
    assert.match(out, /nextlevel is installed\./);
    const git = (...a) => s.box.gitIn(dest, ...a);
    assert.equal(git('config', '--get', 'remote.origin.url'), pub.url);
    assert.equal(git('config', '--get', 'remote.nextlevel-previous.url'), TOOL_URL);
    assert.equal(s.box.gitIn(path.join(s.base, 'versions', 'v0.2.0'), 'rev-parse', 'HEAD'), v020);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.base, 'versions.json'), 'utf8')).release, 'v0.2.0');
    const st = state();
    assert.equal(st.reports.repo, PRIVATE);
    assert.deepEqual(st.fixes.map((f) => [f.number, f.state]).sort(), [[5, 'fixed'], [7, 'left']]);
    assert.equal(st.moved.from, PRIVATE);
    assert.equal(JSON.parse(fs.readFileSync(path.join(s.base, 'releases.json'), 'utf8')).seen['v0.1.0'].left, PRIVATE);

    // The release channel runs the new release; the pinned project still runs v0.1.0, from its folder
    assert.match(runShim(s.bin, ['version'], s.box.env, s.box.tmp).out, /^nextlevel v0\.2\.0 \(release\)/);
    const pin = runShim(s.bin, ['version'], s.box.env, pinned);
    assert.equal(pin.code, 0, pin.out);
    assert.match(pin.out, /^nextlevel v0\.1\.0 /);
    assert.equal(s.box.gitIn(path.join(s.base, 'versions', 'v0.1.0'), 'rev-parse', 'HEAD'), v010);

    // A re-run changes nothing more and says nothing of the move; v0.1.0 is never said to be gone
    const again = installer(s, moveEnv, reg);
    assert.match(again, /nextlevel is installed\./, again);
    assert.doesNotMatch(again, /Field reports from this PC|This install follows/);
    // The new repository's next release is offered (its history is the new one's)
    pub.commit('newer', (work) => fs.appendFileSync(path.join(work, 'README.md'), '\nnewer\n'));
    pub.release('v0.3.0');
    const look = runShim(s.bin, ['_releases'], s.box.env, s.box.tmp);
    assert.equal(look.code, 0, look.out);
    const available = JSON.parse(fs.readFileSync(path.join(s.base, 'update', 'available.json'), 'utf8'));
    assert.deepEqual(available.newer.map((r) => r.name), ['v0.3.0']);
    assert.deepEqual(available.vanished, [], 'the old repository\'s v0.1.0 is not "gone"');
  } finally {
    reg?.remove();
    s.box.cleanup();
  }
});
