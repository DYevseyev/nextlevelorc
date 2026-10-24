// nextlevel updating itself to releases (safe updates, docs/design/safe-updates.md): `nextlevel update` and `--to`, the
// channels (`nextlevel channel`), the launcher, and the start of an owner command, which never installs. Each test
// installs the tool as a clone of a fake "GitHub" repository holding this checkout's code (helpers.mjs), makes releases
// there (annotated tags on main), runs `nextlevel _install` as the installer would, and runs the command the way the
// installed `nextlevel` does (the launcher).
//   npm test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { INSTALL_COMMAND } from '../src/lib/install.mjs';
import { installedTool, makeProject, waitUntil, withEnv } from './helpers.mjs';

// The project p with nextlevel installed as a clone (helpers.mjs). label(l): a commit on main whose menu says l, to tell
// which code ran; install(): `nextlevel _install`, as the installer runs it (PATH left alone: never the PC's registry).
function installed(opts) {
  const t = installedTool(opts);
  const label = (l) => t.gh.commit(`Menu says ${l}`, () => t.gh.edit('src/hub.mjs', /· nextlevel(?: [\w-]+)? ===/, `· nextlevel ${l} ===`));
  const base = path.join(t.p.env.HOME, '.nextlevel');
  const launcher = path.join(base, 'bin', 'launch.mjs');
  const install = () => t.nl(['_install'], { env: { NEXTLEVEL_NO_PATH: '1' } });
  // the installed `nextlevel`: the launcher, in the project (or `cwd`)
  const run = (args, { cwd = t.p.repo, input = '0\n', env = {} } = {}) => {
    const r = spawnSync(process.execPath, [launcher, ...args], { cwd, input, encoding: 'utf8', timeout: 300_000, env: withEnv(t.p.env, { NEXTLEVEL_NO_UPDATE: undefined, NEXTLEVEL_UPDATE_POLL_MS: '200', NEXTLEVEL_HUB_WINDOW: '0', ...env }) });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const versionsJson = () => JSON.parse(fs.readFileSync(path.join(base, 'versions.json'), 'utf8'));
  const menuSays = (r) => r.out.match(/=== proj · nextlevel ?([\w-]*) ===/)?.[1];
  return { ...t, label, base, launcher, install, run, versionsJson, menuSays };
}
const aliveHub = (dir) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'hub.json'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
};
const doctorJson = (t, id) => JSON.parse(t.run(['doctor', '--json']).out).results.find((r) => r.id === id);

test('the update goes to the newest release, never main\'s head; each version in a folder of its own; --to goes back and the release gone back from is offered again', () => {
  const t = installed();
  try {
    t.label('one');
    const one = t.gh.release('v0.1.0', { notes: 'Fixes:\n- Safety: a verify command can no longer push.\n- The Project page counts closed tasks.\n\nAfter install:\n- Run the bridge test again.' });
    t.label('unreleased');
    const inst = t.install();
    assert.equal(inst.code, 0, inst.out);
    assert.match(inst.out, /It runs nextlevel v0\.1\.0/);
    assert.equal(t.menuSays(t.run([])), 'one', 'the release, not main\'s head');
    assert.match(t.run(['version']).out, /^nextlevel v0\.1\.0 \(release\) in .*versions.v0\.1\.0/);

    t.label('two');
    const two = t.gh.release('v0.2.0', { notes: 'New:\n- Home shows the update.' });
    t.label('three-unreleased');
    const up = t.run(['update']);
    assert.equal(up.code, 0, up.out);
    assert.match(up.out, /Updated nextlevel: v0\.1\.0 -> v0\.2\.0/);
    assert.match(up.out, /- Home shows the update\./);
    assert.match(up.out, /To go back: nextlevel update --to v0\.1\.0/);
    assert.equal(t.menuSays(t.run([])), 'two');
    assert.equal(t.versionsJson().release, 'v0.2.0');
    assert.equal(t.versionsJson().previous, 'v0.1.0');
    // the old version's folder is as it was: nothing changed under what may still run it
    assert.equal(t.p.gitIn(path.join(t.base, 'versions', 'v0.1.0'), 'rev-parse', 'HEAD'), one);
    assert.equal(t.p.gitIn(path.join(t.base, 'versions', 'v0.2.0'), 'rev-parse', 'HEAD'), two);
    assert.match(t.run(['update']).out, /nextlevel is up to date \(v0\.2\.0\)\./);

    // Going back is the owner's: --to an older release
    const back = t.run(['update', '--to', 'v0.1.0']);
    assert.equal(back.code, 0, back.out);
    assert.match(back.out, /Going back from v0\.2\.0 to v0\.1\.0 \(your choice: nextlevel offers v0\.2\.0 again, marked "you went back from this one"\)/);
    assert.equal(t.menuSays(t.run([])), 'one');
    assert.equal(t.versionsJson().wentBackFrom, 'v0.2.0');
    const avail = JSON.parse(fs.readFileSync(path.join(t.base, 'update', 'available.json'), 'utf8'));
    assert.deepEqual(avail.newer.map((r) => r.name), ['v0.2.0'], 'offered again');
    assert.equal(avail.wentBackFrom, 'v0.2.0');
    assert.equal(t.run(['update']).code, 0);
    assert.equal(t.menuSays(t.run([])), 'two');

    // --to takes releases only: a branch points to the channel, a name that isn't there lists the releases
    const branch = t.run(['update', '--to', 'main']);
    assert.equal(branch.code, 1);
    assert.match(branch.out, /--to takes a release \(v0\.3\.0\)\. To run a branch in this project, the owner sets its channel: nextlevel channel candidate main/);
    assert.match(t.run(['update', '--to', 'v9.9.9']).out, /There is no release v9\.9\.9\. Releases: v0\.2\.0, v0\.1\.0/);
    assert.equal(t.run(['update', '--force']).code, 1, '--force is gone');
  } finally {
    t.p.cleanup();
  }
});

test('a tag that moved, vanished, is lightweight, is off main, is from before releases or has no release title is refused and said; later releases are still taken', () => {
  const t = installed();
  try {
    t.label('one');
    t.gh.release('v0.1.0');
    assert.equal(t.install().code, 0);
    // Off main: a side branch's commit
    t.gh.git('switch', '-q', '-c', 'side');
    fs.appendFileSync(path.join(t.gh.work, 'README.md'), '\nside\n');
    t.gh.git('commit', '-qam', 'side work');
    t.gh.git('push', '-q', 'origin', 'side');
    t.gh.release('v0.5.0');
    t.gh.git('switch', '-q', 'main');
    // Lightweight, and a message without the release's title
    t.label('two');
    t.gh.tag('v0.2.0');
    t.gh.tag('v0.2.1', { message: 'some notes\n' });
    const r = t.run(['update']);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /v0\.5\.0 isn't on main's history: not a release/);
    assert.match(r.out, /v0\.2\.0 is a lightweight tag, not an annotated one with release notes: not a release/);
    assert.match(r.out, /v0\.2\.1's message doesn't start with "nextlevel v0\.2\.1": not a release/);
    assert.match(r.out, /nextlevel is up to date \(v0\.1\.0\)\./);

    // A release seen, then moved on GitHub: refused, said, never followed; the fetch still works
    t.label('three');
    t.gh.release('v0.3.0');
    fs.rmSync(path.join(t.base, 'update', 'available.json'), { force: true }); // (6 hours on: the hubs look again)
    assert.equal(t.run(['_releases']).code, 0); // (the hubs' look: v0.3.0 is seen now, and recorded as it is)
    t.label('evil');
    t.gh.tag('v0.3.0', { message: 'nextlevel v0.3.0\n\nFixes:\n- moved\n', force: true });
    const moved = t.run(['update']);
    assert.match(moved.out, /v0\.3\.0 was changed on GitHub after it was published \(it pointed at \w{7}, now \w{7}\): nextlevel doesn't follow it/);
    assert.notEqual(t.menuSays(t.run([])), 'evil');
    assert.match(doctorJson(t, 'install.updates').detail, /changed on GitHub after it was published/);
    // A newer release after it is taken: a moved tag never stops later updates
    t.label('four');
    t.gh.release('v0.4.0');
    const later = t.run(['update']);
    assert.equal(later.code, 0, later.out);
    assert.match(later.out, /Updated nextlevel: v0\.1\.0 -> v0\.4\.0/);
    assert.equal(t.menuSays(t.run([])), 'four');
    // Vanished: said; the installed one stays
    t.gh.untag('v0.4.0');
    const vanished = t.run(['update']);
    assert.match(vanished.out, /v0\.4\.0 was published and is gone from GitHub now: nextlevel no longer offers it/);
    assert.equal(t.menuSays(t.run([])), 'four', 'the installed version stays');
    // From before releases: never one
    t.gh.tag('v0.0.5', { message: 'nextlevel v0.0.5\n' });
    assert.match(t.run(['update', '--to', 'v0.0.5']).out, /"v0\.0\.5" isn't a release's name/);
  } finally {
    t.p.cleanup();
  }
});

test('the update waits while a worker runs in a project that follows releases; a channel, and a candidate\'s update, look only at their own project', async () => {
  const t = installed();
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.install().code, 0);
    t.label('two');
    t.gh.release('v0.2.0');
    // Another project this PC knows (an owner command ran there), with a worker still running (its hub stopped)
    const other = makeProject();
    try {
      const doc = spawnSync(process.execPath, [t.launcher, 'doctor'], { cwd: other.repo, encoding: 'utf8', env: withEnv(t.p.env, { NEXTLEVEL_NO_UPDATE: undefined }), timeout: 120_000 });
      assert.ok(doc.status !== null);
      const state = JSON.parse(fs.readFileSync(path.join(t.base, 'state.json'), 'utf8'));
      assert.ok(state.projects.some((r) => r.endsWith('proj')), 'the doctor recorded its project');
      const job = other.state('jobs', 'T1');
      fs.mkdirSync(job, { recursive: true });
      fs.writeFileSync(path.join(job, 'status.json'), JSON.stringify({ id: 'T1', type: 'task', state: 'running', startedAt: new Date().toISOString() }));
      fs.writeFileSync(path.join(job, 'run.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));

      // A channel, and a candidate's update, change only this project's version: the other project's worker doesn't stop them
      const cand = t.run(['channel', 'candidate', 'main']);
      assert.equal(cand.code, 0, cand.out);
      t.label('main-later');
      const moved = t.run(['update'], { env: { NEXTLEVEL_UPDATE_POLL_MS: '200' } });
      assert.equal(moved.code, 0, moved.out);
      assert.match(moved.out, /This project runs main at \w{7} now/);
      assert.equal(t.run(['channel', 'release']).code, 0);
      // ...this project's own hub does
      aliveHub(t.p.state());
      assert.match(t.run(['channel', 'candidate', 'main']).out, /Not changing what this project runs while nextlevel is at work: the hub is running for/);
      fs.rmSync(t.p.state('hub.json'));

      // The release channel's update waits for the other project's worker, which follows releases
      const out = path.join(t.p.tmp, 'update.log');
      const fd = fs.openSync(out, 'a');
      const update = spawn(process.execPath, [t.launcher, 'update'], { cwd: t.p.repo, env: withEnv(t.p.env, { NEXTLEVEL_NO_UPDATE: undefined, NEXTLEVEL_UPDATE_POLL_MS: '200' }), stdio: ['ignore', fd, fd] });
      fs.closeSync(fd);
      const status = () => {
        try {
          const id = JSON.parse(fs.readFileSync(path.join(t.base, 'update', 'current.json'), 'utf8')).id;
          return JSON.parse(fs.readFileSync(path.join(t.base, 'update', id, 'status.json'), 'utf8'));
        } catch {
          return {};
        }
      };
      await waitUntil('the update waits for the worker', () => (status().waitingFor || []).some((w) => /T1 runs/.test(w)), 180_000);
      assert.equal(t.versionsJson().release, 'v0.1.0', 'nothing switched while it waits');
      // The worker ends: the update goes on
      fs.writeFileSync(path.join(job, 'run.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), endedAt: new Date().toISOString() }));
      await waitUntil('the update ends', () => update.exitCode !== null, 240_000);
      assert.equal(update.exitCode, 0, fs.readFileSync(out, 'utf8'));
      assert.equal(t.versionsJson().release, 'v0.2.0');
    } finally {
      other.cleanup();
    }
  } finally {
    t.p.cleanup();
  }
});

test("an agent's session can't update or change a channel, plain or not (safe updates: the owner's alone)", () => {
  const t = installed();
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.install().code, 0);
    t.label('two');
    t.gh.release('v0.2.0');
    const sessions = [
      [{ NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'interactive' }, "the orchestrator's window"],
      [{ NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'autopilot' }, 'an autopilot round'],
      [{ NEXTLEVEL_AGENT: 'check' }, 'a verify command the orchestrator asked for \\(nextlevel verify\\)'],
      [{ NEXTLEVEL_AGENT: 'worker', NEXTLEVEL_TASK_ID: 'M1-01', NEXTLEVEL_SLOT: '1' }, "a worker's slot"],
    ];
    for (const [env, who] of sessions) {
      for (const args of [['update'], ['update', '--to', 'v0.2.0'], ['channel', 'candidate', 'main'], ['channel', 'pin', 'v0.1.0'], ['channel', 'release']]) {
        const r = t.run(args, { env });
        assert.equal(r.code, 1, `${args.join(' ')} in ${who}: ${r.out}`);
        assert.match(r.out, new RegExp(`is the owner's, so it doesn't run in an agent's session \\(this is ${who}\\): nothing was done`), r.out);
        assert.equal(t.versionsJson().release, 'v0.1.0');
      }
    }
    assert.match(t.run(['update'], { env: { NEXTLEVEL_READ_ONLY: '1' } }).out, /refused\. This is a read-only session \(the assistant\)/);
    assert.ok(!fs.existsSync(path.join(t.base, 'channels.json')));
    // Showing the channel only looks: anyone may
    assert.match(t.run(['channel'], { env: sessions[0][0] }).out, /This project follows releases \(v0\.1\.0\)\./);
    // The owner's own window
    assert.equal(t.run(['update']).code, 0);
    assert.equal(t.versionsJson().release, 'v0.2.0');
  } finally {
    t.p.cleanup();
  }
});

test('channels: a candidate runs its branch\'s head and moves on the owner\'s update; a pin stays; back to releases; the launcher runs NEXTLEVEL_VERSION first and refuses a missing folder', () => {
  const t = installed();
  try {
    t.label('one');
    t.gh.release('v0.1.0');
    assert.equal(t.install().code, 0);
    t.label('main-a');
    const cand = t.run(['channel', 'candidate', 'main']);
    assert.equal(cand.code, 0, cand.out);
    assert.match(cand.out, /This project follows the candidate main now, at \w{7} \(main@\w{7}\)\. It runs whatever sessions push to main, once you update/);
    assert.equal(t.menuSays(t.run([])), 'main-a');
    assert.match(t.run(['version']).out, /^nextlevel main@\w{7} \(candidate\)/);
    assert.equal(doctorJson(t, 'install.channel').severity, 'info');
    // Another project on the same PC still runs the release
    const other = makeProject();
    try {
      const o = spawnSync(process.execPath, [t.launcher, 'version'], { cwd: other.repo, encoding: 'utf8', env: t.p.env });
      assert.match(o.stdout, /^nextlevel v0\.1\.0 \(release\)/, 'side by side');
    } finally {
      other.cleanup();
    }
    // New commits on main reach the candidate only on the owner's update
    t.label('main-b');
    assert.equal(t.menuSays(t.run([])), 'main-a');
    const moved = t.run(['update']);
    assert.equal(moved.code, 0, moved.out);
    assert.match(moved.out, /This project runs main at \w{7} now \(main@\w{7}; not released\):\n {2}- Menu says main-b/);
    assert.equal(t.menuSays(t.run([])), 'main-b');

    // A pin stays, whatever is released
    t.label('two');
    t.gh.release('v0.2.0');
    assert.equal(t.run(['channel', 'pin', 'v0.1.0']).code, 0);
    assert.equal(t.menuSays(t.run([])), 'one');
    assert.match(t.run(['update']).out, /This project is pinned at v0\.1\.0, so it stays there\. To follow releases again: nextlevel channel release/);
    assert.equal(t.menuSays(t.run([])), 'one');
    assert.equal(doctorJson(t, 'install.channel').detail, 'pinned at v0.1.0');

    // Back to releases: the release channel's version (v0.1.0 until the owner updates)
    assert.match(t.run(['channel', 'release']).out, /This project follows releases now \(v0\.1\.0\)\./);
    assert.equal(t.menuSays(t.run([])), 'one');

    // NEXTLEVEL_VERSION (what a hub puts in its agents' environment) comes first
    const names = Object.keys(t.versionsJson().installed);
    // (the newest candidate folder; an older one stays while the window that ran the update runs it: the next update removes it)
    const installedAt = t.versionsJson().installed;
    const mainVersion = names.filter((n) => n.startsWith('main@')).sort((a, b) => String(installedAt[b].at).localeCompare(String(installedAt[a].at)))[0];
    assert.ok(mainVersion, names.join(', '));
    const pinnedRun = t.run([], { env: { NEXTLEVEL_VERSION: mainVersion } });
    assert.equal(t.menuSays(pinnedRun), 'main-b', pinnedRun.out);
    const bad = t.run(['version'], { env: { NEXTLEVEL_VERSION: '../../evil' } });
    assert.equal(bad.code, 1);
    assert.match(bad.out, /isn't a version's name/);
    // A version's folder gone: loud, with the repair command; never another version
    fs.rmSync(path.join(t.base, 'versions', 'v0.1.0'), { recursive: true, force: true, maxRetries: 5 });
    const gone = t.run(['version']);
    assert.equal(gone.code, 1);
    assert.match(gone.out, /nextlevel v0\.1\.0 \(release\) isn't on this PC any more/);
    assert.ok(gone.out.includes(INSTALL_COMMAND));
  } finally {
    t.p.cleanup();
  }
});

test('an owner command never installs: it says, in one line, that a release is available', () => {
  const t = installed();
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.install().code, 0);
    t.label('two');
    t.gh.release('v0.2.0', { notes: 'Fixes:\n- Safety: closes a way to push.' });
    // the hubs and the dashboard look for releases (update/available.json); an owner command only reads it
    assert.equal(t.run(['_releases']).code, 0);
    const menu = t.run([]);
    assert.match(menu.out, /\(nextlevel v0\.2\.0 is available \(it has a safety fix\): Update on the dashboard's Home, or nextlevel update in PowerShell\.\)/);
    assert.notEqual(t.menuSays(menu), 'two', 'not installed');
    assert.equal(t.versionsJson().release, 'v0.1.0');
    for (const args of [['doctor'], ['init'], ['--no-update']]) {
      t.run(args);
      assert.equal(t.versionsJson().release, 'v0.1.0', args.join(' '));
    }
    assert.doesNotMatch(t.run([], { env: { NEXTLEVEL_NO_UPDATE: '1' } }).out, /is available/, "the owner's NEXTLEVEL_NO_UPDATE: no notice");
    const row = doctorJson(t, 'install.updates');
    assert.equal(row.severity, 'warn');
    assert.match(row.detail, /^nextlevel v0\.2\.0 is available, with a safety fix \(you run v0\.1\.0\)$/);
  } finally {
    t.p.cleanup();
  }
});

test('an install from before releases: update leaves it while no release exists, and points to the installer once one does', () => {
  const t = installed();
  try {
    t.label('two');
    const none = t.nl(['update']);
    assert.equal(none.code, 0, none.out);
    assert.match(none.out, /No nextlevel release has been published yet, so this nextlevel stays as it is/);
    assert.notEqual(t.head(), t.remoteMain(), 'it never follows main by itself any more');
    assert.doesNotMatch(t.nl([]).out, /Updated nextlevel/);
    t.gh.release('v0.1.0');
    const one = t.nl(['update']);
    assert.equal(one.code, 1);
    assert.match(one.out, /nextlevel v0\.1\.0 is released\. This nextlevel is from before releases: move it with the install command/);
    assert.ok(one.out.includes(INSTALL_COMMAND));
    assert.match(t.nl([]).out, /\(nextlevel v0\.1\.0 is available: run the install command in PowerShell to move to releases\./);
    // Changed files and no connection are said, never fatal
    fs.appendFileSync(path.join(t.tool, 'README.md'), '\nmine\n');
    assert.match(JSON.parse(t.nl(['doctor', '--json']).out).results.find((r) => r.id === 'install.updates').detail, /changed by hand/);
    t.git('checkout', '--', 'README.md');
    const url = t.git('remote', 'get-url', 'origin');
    t.git('remote', 'set-url', 'origin', path.join(t.p.tmp, 'gone.git'));
    const offline = t.nl(['update']);
    assert.equal(offline.code, 1);
    assert.match(offline.out, /Couldn't reach the nextlevel repository/);
    t.git('remote', 'set-url', 'origin', url);
    // A copy that isn't a git clone can't update itself: it says how to install
    const copy = path.join(t.p.tmp, 'copy');
    fs.cpSync(t.gh.work, copy, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
    const r = spawnSync(process.execPath, [path.join(copy, 'bin', 'nextlevel.mjs'), 'update'], { cwd: t.p.repo, encoding: 'utf8', env: withEnv(t.p.env, { NEXTLEVEL_NO_UPDATE: undefined }) });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /isn't a git clone, so it can't update itself/);
  } finally {
    t.p.cleanup();
  }
});

test("a version run from its own folder puts its command first on PATH and its name in NEXTLEVEL_VERSION for what it starts (the review's change 2)", () => {
  const t = installed();
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.install().code, 0);
    // A version's own code, asked what its children get: nextlevel's verify runs its command with the hub's environment,
    // which starts from this one; here the version's cli is loaded and the environment read back
    const v = path.join(t.base, 'versions', 'v0.1.0');
    const probe = `import(${JSON.stringify(new URL(`file:///${path.join(v, 'src', 'cli.mjs').replace(/\\/g, '/')}`).href)}).then(async (m) => { await m.main(['version']); console.log('VERSION=' + process.env.NEXTLEVEL_VERSION); console.log('PATH0=' + (process.env.PATH || process.env.Path).split(${JSON.stringify(path.delimiter)})[0]); })`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', probe], { cwd: t.p.repo, encoding: 'utf8', env: t.p.env });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /VERSION=v0\.1\.0/);
    assert.equal(path.resolve(r.stdout.match(/PATH0=(.*)/)[1].trim()), path.resolve(path.join(t.base, 'bin')));
  } finally {
    t.p.cleanup();
  }
});
