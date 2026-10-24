// The one-click update (safe updates, part B: src/updater.mjs). Each test installs the tool from a fake GitHub with
// releases (helpers.mjs), runs a project's hub with the stub engines through the installed command (the launcher), and
// updates: the updater waits for a running stub worker, stops the hub, switches, starts it again as it ran, refreshes an
// unedited role doc through the hub, and so on. Never the real CLIs.
//   node --test test/oneclick.test.mjs
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { installedTool, isAlive, processesGone, waitUntil, withEnv } from './helpers.mjs';
import { client, linksIn, request, trade } from './ui-helpers.mjs';

const FIXTURE = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function installed() {
  const t = installedTool();
  const base = path.join(t.p.env.HOME, '.nextlevel');
  const launcher = path.join(base, 'bin', 'launch.mjs');
  const label = (l) => t.gh.commit(`Menu says ${l}`, () => t.gh.edit('src/hub.mjs', /· nextlevel(?: [\w-]+)? ===/, `· nextlevel ${l} ===`));
  // what the installed nextlevel runs with: the updater polls fast, hubs start in the background (no window)
  const env = (extra = {}) => withEnv(t.p.env, { NEXTLEVEL_NO_UPDATE: undefined, NEXTLEVEL_UPDATE_POLL_MS: '200', NEXTLEVEL_HUB_WINDOW: '0', NEXTLEVEL_NO_BROWSER: '1', NEXTLEVEL_TEST_LINK_IN_FILE: '1', ...extra });
  const run = (args, { cwd = t.p.repo, input = '0\n', extra = {}, timeout = 240_000 } = {}) => {
    const r = spawnSync(process.execPath, [launcher, ...args], { cwd, input, encoding: 'utf8', timeout, env: env(extra) });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
  };
  const started = [];
  const background = (args, extra = {}) => {
    const out = fs.openSync(path.join(t.p.tmp, `bg-${started.length}.log`), 'a');
    const child = spawn(process.execPath, [launcher, ...args], { cwd: t.p.repo, env: env(extra), stdio: ['ignore', out, out], windowsHide: true });
    fs.closeSync(out);
    started.push(child);
    return child;
  };
  const hub = () => {
    try {
      const h = JSON.parse(fs.readFileSync(t.p.state('hub.json'), 'utf8'));
      return isAlive(h.pid) ? h : null;
    } catch {
      return null;
    }
  };
  const versions = () => JSON.parse(fs.readFileSync(path.join(base, 'versions.json'), 'utf8'));
  const current = () => {
    try {
      const id = JSON.parse(fs.readFileSync(path.join(base, 'update', 'current.json'), 'utf8')).id;
      return { id, status: JSON.parse(fs.readFileSync(path.join(base, 'update', id, 'status.json'), 'utf8')) };
    } catch {
      return null;
    }
  };
  // Stops the project's hub and dashboard, and waits for every process the test started or the update did
  const cleanup = async () => {
    const pids = [hub()?.pid].filter(Boolean);
    try {
      pids.push(JSON.parse(fs.readFileSync(t.p.state('ui.json'), 'utf8')).pid);
    } catch {
      // no dashboard
    }
    try {
      fs.writeFileSync(t.p.state('hub-stop.json'), JSON.stringify({ at: new Date().toISOString() }));
      fs.writeFileSync(t.p.state('ui-stop.json'), JSON.stringify({ at: new Date().toISOString() }));
    } catch {
      // no project state
    }
    for (const c of started) if (c.exitCode === null) pids.push(c.pid);
    await processesGone(pids, 30_000);
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch {
        // gone
      }
    }
    await processesGone(pids, 10_000);
    t.p.cleanup();
  };
  return { ...t, base, launcher, label, run, background, hub, versions, current, cleanup, env };
}
const read = (f) => fs.readFileSync(f, 'utf8');
// The PC's look for releases (the hubs' every 6 hours), now, until it has `name` (a hub's own look may write an older one
// at the same moment)
async function seeRelease(t, name) {
  await waitUntil(`${name} is seen`, () => {
    fs.rmSync(path.join(t.base, 'update', 'available.json'), { force: true });
    t.run(['_releases']);
    try {
      return JSON.parse(read(path.join(t.base, 'update', 'available.json'))).newer.some((r) => r.name === name);
    } catch {
      return false;
    }
  }, 60_000);
}

test('the one click: never installs by itself; waits for a running worker; stops the hub, switches, starts it again as it ran, autopilot and the brake as they were; refreshes an unedited role doc and leaves an edited one', async () => {
  const t = installed();
  try {
    t.label('one');
    t.gh.release('v0.1.0');
    assert.equal(t.nl(['_install'], { env: { NEXTLEVEL_NO_PATH: '1' } }).code, 0);
    // The project has an older orchestrator doc nobody edited, and a worker doc of its own
    fs.writeFileSync(path.join(t.p.repo, 'docs', 'agents', 'ORCHESTRATOR.md'), FIXTURE('ORCHESTRATOR-FR012.md'));
    fs.appendFileSync(path.join(t.p.repo, 'docs', 'agents', 'WORKER.md'), '\nOur own rule: keep commits small.\n');
    // ...and START.cmd as nextlevel M3 wrote it, in a project whose git keeps text with LF line ends (so git stores other
    // bytes than the CRLF on disk: the guard must still know the update's commit as the owner's)
    fs.writeFileSync(path.join(t.p.repo, 'START.cmd'), FIXTURE('START-M3.cmd').replace(/\r?\n/g, '\r\n'));
    fs.writeFileSync(path.join(t.p.repo, '.gitattributes'), '* text=auto eol=lf\n');
    t.p.gitIn(t.p.repo, 'add', '-A');
    t.p.gitIn(t.p.repo, 'commit', '-qm', 'docs as they are');
    fs.writeFileSync(path.join(t.p.repo, 'START.cmd'), FIXTURE('START-M3.cmd').replace(/\r?\n/g, '\r\n')); // (CRLF on disk again)
    const guardLib = new URL('../src/lib/guard.mjs', import.meta.url).href;
    const own = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(guardLib)}).then((m) => m.recordOwner(${JSON.stringify(t.p.repo)}, ['START.cmd', '.gitattributes', 'docs/agents/ORCHESTRATOR.md', 'docs/agents/WORKER.md']))`], { env: t.p.env, encoding: 'utf8' });
    assert.equal(own.status, 0, own.stderr);
    t.p.spec('T1-activity', 'node -e "process.exit(0)"');
    t.p.gitIn(t.p.repo, 'add', '-A');
    t.p.gitIn(t.p.repo, 'commit', '-qm', 'a task');

    t.background(['run', '--tick-ms', '200']);
    await waitUntil('the hub starts', () => t.hub(), 60_000);
    const first = t.hub();
    assert.equal(first.version, 'v0.1.0');
    const rounds = () => {
      try {
        const r = JSON.parse(read(t.p.state('rounds.json')));
        return JSON.stringify([r.sinceReal, r.streak, r.fuse, r.onAt]);
      } catch {
        return 'none';
      }
    };
    const settings = () => {
      try {
        const s = JSON.parse(read(t.p.state('settings.json')));
        return JSON.stringify([!!s.autopilot, s.onAt || null]);
      } catch {
        return '[false,null]'; // (no settings.json yet: autopilot as nextlevel.json says, off)
      }
    };

    // A newer release, seen by the hub: nothing installs it by itself (only the owner's click)
    t.label('two');
    t.gh.release('v0.2.0', { notes: 'Fixes:\n- Safety: a test fix.' });
    await seeRelease(t, 'v0.2.0');
    await new Promise((r) => setTimeout(r, 3000)); // (a few ticks of the hub)
    assert.equal(t.current(), null, 'no update starts without the click');
    assert.equal(t.versions().release, 'v0.1.0', 'nothing installs without the click');
    assert.equal(t.hub().pid, first.pid);

    // A worker runs: the update waits for it
    assert.match(t.run(['dispatch', 'T1-activity']).out, /queued/);
    await waitUntil('the worker starts', () => /"state":\s*"running"/.test(read(t.p.state('jobs', 'T1-activity', 'status.json'))), 60_000);
    const brake = rounds();
    const autopilot = settings();
    const update = t.background(['update']);
    await waitUntil('the update waits for the worker', () => (t.current()?.status.waitingFor || []).some((w) => /T1-activity runs/.test(w)), 120_000);
    await new Promise((r) => setTimeout(r, 4000)); // (a few of the updater's looks)
    assert.equal(t.current().status.phase, 'waiting', 'it still waits');
    assert.equal(t.versions().release, 'v0.1.0');
    assert.equal(t.hub()?.pid, first.pid, 'the hub runs on while the worker does');
    // The worker finishes: the update goes on
    const slot = path.join(path.dirname(t.p.repo), 'proj.slots', `w${JSON.parse(read(t.p.state('jobs', 'T1-activity', 'status.json'))).slot}`);
    fs.writeFileSync(path.join(slot, '.nextlevel-task', 'GO'), 'go');
    await waitUntil('the update ends', () => update.exitCode !== null, 240_000);
    const said = read(path.join(t.p.tmp, 'bg-1.log'));
    assert.equal(update.exitCode, 0, said);
    assert.match(said, /Updated nextlevel: v0\.1\.0 -> v0\.2\.0/);
    assert.equal(t.versions().release, 'v0.2.0');
    // The hub runs again, on the new version, the way it ran (in the background, its tick)
    const again = t.hub();
    assert.ok(again, 'the hub runs again');
    assert.notEqual(again.pid, first.pid);
    assert.equal(again.version, 'v0.2.0');
    assert.deepEqual(again.argv, ['--tick-ms', '200']);
    assert.match(read(t.p.state('logs', 'hub.log')), /nextlevel is updating: this hub stops/);
    // Autopilot and FR-019's brake and fuse as they were: the update is no real event and no owner's action
    assert.equal(settings(), autopilot);
    assert.equal(rounds(), brake);
    // The unedited role doc is the new template, committed through the hub as the owner's change; the edited one is left
    assert.equal(read(path.join(t.p.repo, 'docs', 'agents', 'ORCHESTRATOR.md')), read(path.join(t.base, 'versions', 'v0.2.0', 'templates', 'project', 'docs', 'agents', 'ORCHESTRATOR.md')));
    assert.match(t.p.gitIn(t.p.repo, 'log', '-1', '--format=%s'), /^nextlevel v0\.2\.0: docs\/agents\/ORCHESTRATOR\.md, START\.cmd updated to the new templates$/);
    const norm = (s) => s.replace(/\r\n/g, '\n');
    assert.equal(norm(read(path.join(t.p.repo, 'START.cmd'))), norm(read(path.join(t.base, 'versions', 'v0.2.0', 'templates', 'project', 'START.cmd'))));
    assert.match(read(path.join(t.p.repo, 'docs', 'agents', 'WORKER.md')), /Our own rule/);
    const status = t.current().status;
    assert.equal(status.phase, 'done');
    assert.ok(status.notes.some((n) => /docs\/agents\/WORKER\.md is your own version/.test(n)), status.notes.join('\n'));
    assert.doesNotMatch(status.steps.bridge.detail, /ran again/, 'no bridge test run: no engine changed, nor how slots refuse pushes');
    const guard = JSON.parse(t.run(['doctor', '--json']).out).results.find((r) => r.id === 'guard.held');
    assert.notEqual(guard?.status, 'fail', 'no card for the owner: the update committed it as the owner');

    // The owner edits the refreshed role doc afterwards; going back leaves their edit (and says so) instead of putting the
    // older template over it
    fs.appendFileSync(path.join(t.p.repo, 'docs', 'agents', 'ORCHESTRATOR.md'), '\nOur own orchestrator rule.\n');
    t.p.gitIn(t.p.repo, 'commit', '-qam', 'our own rule');
    const own2 = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(guardLib)}).then((m) => m.recordOwner(${JSON.stringify(t.p.repo)}, ['docs/agents/ORCHESTRATOR.md']))`], { env: t.p.env, encoding: 'utf8' });
    assert.equal(own2.status, 0, own2.stderr);
    const back = t.run(['update', '--to', 'v0.1.0'], { timeout: 300_000 });
    assert.equal(back.code, 0, back.out);
    assert.equal(t.versions().release, 'v0.1.0');
    assert.match(read(path.join(t.p.repo, 'docs', 'agents', 'ORCHESTRATOR.md')), /Our own orchestrator rule/);
    assert.ok(t.current().status.notes.some((n) => /ORCHESTRATOR\.md changed after the update's commit/.test(n)), t.current().status.notes.join('\n'));
  } finally {
    await t.cleanup();
  }
});

test('a failing step pauses the update and says so; Update without the backup goes on; Go back puts the version and the role docs back (the dashboard\'s buttons)', async () => {
  const t = installed();
  let ui;
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.nl(['_install'], { env: { NEXTLEVEL_NO_PATH: '1' } }).code, 0);
    fs.writeFileSync(path.join(t.p.repo, 'docs', 'agents', 'ORCHESTRATOR.md'), FIXTURE('ORCHESTRATOR-FR012.md'));
    const cfg = JSON.parse(read(path.join(t.p.repo, 'nextlevel.json')));
    fs.writeFileSync(path.join(t.p.repo, 'nextlevel.json'), JSON.stringify({ ...cfg, updates: { backupBranch: 'nextlevel-backup' } }, null, 2));
    t.p.gitIn(t.p.repo, 'commit', '-qam', 'a backup branch, and an older role doc');
    // (the owner's own edits, as the Team page or the doctor records them: the guard holds no card for them)
    const guard = new URL('../src/lib/guard.mjs', import.meta.url).href;
    const own = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(guard)}).then((m) => m.recordOwner(${JSON.stringify(t.p.repo)}, ['nextlevel.json', 'docs/agents/ORCHESTRATOR.md']))`], { env: t.p.env, encoding: 'utf8' });
    assert.equal(own.status, 0, own.stderr);
    // GitHub refuses the backup branch for now (a hook in the stand-in remote, not the project's: the project's own git
    // settings stay as they are, or the guard would stop all git work)
    const refuse = path.join(t.p.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(refuse, '#!/bin/sh\necho refused for the test >&2\nexit 1\n');
    fs.chmodSync(refuse, 0o755);
    t.background(['run', '--tick-ms', '200']);
    await waitUntil('the hub starts', () => t.hub(), 60_000);
    const old = t.hub().pid;
    t.label('two');
    t.gh.release('v0.2.0');
    await seeRelease(t, 'v0.2.0');

    // The dashboard, as the owner uses it: Update on Home
    const child = t.background(['ui', '--no-open']);
    await waitUntil('the dashboard prints its link', () => linksIn(read(path.join(t.p.tmp, 'bg-1.log'))).length, 60_000);
    const [{ port, code }] = linksIn(read(path.join(t.p.tmp, 'bg-1.log')));
    const token = (await trade(port, code)).json.key;
    ui = { child, port, token };
    const api = client(ui);
    const card = (await api.get('/api/state')).json.update;
    assert.equal(card.newer[0].name, 'v0.2.0');
    // the click names exactly what the card showed: another version is refused
    const wrong = await api.post('/api/update', { action: 'update', to: 'v0.9.9', commit: card.newer[0].commit });
    assert.equal(wrong.status, 409);
    assert.match(wrong.json.message, /changed since the page showed it/);
    // ...and only from the page's own origin, with its key
    const noKey = await request(ui.port, { method: 'POST', path: '/api/update', body: { action: 'update', to: 'v0.2.0', commit: card.newer[0].commit } });
    assert.equal(noKey.status, 403);
    const go = await api.post('/api/update', { action: 'update', to: 'v0.2.0', commit: card.newer[0].commit });
    assert.equal(go.status, 200, JSON.stringify(go.json));
    await waitUntil('the update pauses at the backup', () => t.current()?.status.phase === 'paused', 240_000);
    const paused = t.current().status.paused;
    assert.equal(paused.step, 'backup');
    assert.match(paused.text, /the backup push of main to nextlevel-backup/);
    assert.equal(paused.canSkipBackup, true);
    assert.equal(paused.changed, false);
    assert.equal(t.versions().release, 'v0.1.0', 'nothing changed');
    assert.equal(t.hub().pid, old, 'the hub was never stopped');
    assert.match(read(t.p.state('logs', 'hub.log')) + read(path.join(t.base, 'update', t.current().id, 'update.log')), /paused at backup/);

    // Update without the backup: the update goes on, and the dashboard stops and opens again on the new version
    assert.equal((await api.post('/api/update', { action: 'skip-backup', id: t.current().id })).status, 200);
    await waitUntil('the update ends', () => t.current()?.status.phase === 'done', 300_000).catch((err) => {
      throw new Error(`${err.message}: ${JSON.stringify(t.current())}`);
    });
    assert.equal(t.versions().release, 'v0.2.0');
    assert.equal(t.hub().version, 'v0.2.0');
    await waitUntil('the old dashboard stopped', () => child.exitCode !== null, 60_000);
    await waitUntil('the dashboard runs again on v0.2.0', () => {
      try {
        return JSON.parse(read(t.p.state('ui.json'))).version === 'v0.2.0';
      } catch {
        return false;
      }
    }, 60_000);
    const roleDoc = path.join(t.p.repo, 'docs', 'agents', 'ORCHESTRATOR.md');
    assert.notEqual(read(roleDoc), FIXTURE('ORCHESTRATOR-FR012.md'));

    // Go back (Tools page, or Home after a pause): v0.1.0 again, the role doc as it was, and v0.2.0 offered again
    const newPort = JSON.parse(read(t.p.state('ui.json'))).port;
    // (the new dashboard has new links and keys: the test reads its link where it printed it, as the tests let it)
    const logs = read(path.join(t.p.repo, '.nextlevel', 'logs', 'ui-console.log'));
    const newToken = (await trade(newPort, linksIn(logs).at(-1).code)).json.key;
    assert.ok(newToken && newToken !== token, 'a new key: the old page and server never learn it');
    assert.equal((await client({ port: newPort, token }).get('/api/state')).status, 403, "the old page's key is no good on it");
    // (GitHub takes the backup again: going back makes its backup too, and it goes through now)
    fs.rmSync(refuse);
    const back = await client({ port: newPort, token: newToken }).post('/api/update', { action: 'back' });
    assert.equal(back.status, 200, JSON.stringify(back.json));
    await waitUntil('gone back', () => t.current()?.status.phase === 'done' && t.versions().release === 'v0.1.0', 300_000).catch((err) => {
      throw new Error(`${err.message}: ${JSON.stringify(t.current())}`);
    });
    assert.equal(read(roleDoc).replace(/\r\n/g, '\n'), FIXTURE('ORCHESTRATOR-FR012.md').replace(/\r\n/g, '\n'), 'the role doc the update committed is put back');
    assert.equal(t.versions().wentBackFrom, 'v0.2.0');
    assert.equal(t.hub().version, 'v0.1.0');
  } finally {
    await t.cleanup();
  }
});

test('an agent\'s session can\'t start the update; the updater survives the dashboard that started it (the review\'s change 8)', async () => {
  const t = installed();
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.nl(['_install'], { env: { NEXTLEVEL_NO_PATH: '1' } }).code, 0);
    t.background(['run', '--tick-ms', '200']);
    await waitUntil('the hub starts', () => t.hub(), 60_000);
    t.label('two');
    t.gh.release('v0.2.0');
    await seeRelease(t, 'v0.2.0');
    const refused = t.run(['update'], { extra: { NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'autopilot' } });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /is the owner's, so it doesn't run in an agent's session/);
    assert.equal(t.current(), null);

    const child = t.background(['ui', '--no-open']);
    await waitUntil('the dashboard prints its link', () => linksIn(read(path.join(t.p.tmp, 'bg-1.log'))).length, 60_000);
    const [{ port, code }] = linksIn(read(path.join(t.p.tmp, 'bg-1.log')));
    const token = (await trade(port, code)).json.key;
    const card = (await client({ port, token }).get('/api/state')).json.update;
    assert.ok(card?.newer?.[0], JSON.stringify(card) + fs.readFileSync(path.join(t.base, 'update', 'available.json'), 'utf8'));
    assert.equal((await client({ port, token }).post('/api/update', { action: 'update', to: 'v0.2.0', commit: card.newer[0].commit })).status, 200);
    // The owner closes the dashboard's window at once (killed): the updater runs on, detached
    child.kill();
    await waitUntil('the update ends without the dashboard', () => t.current()?.status.phase === 'done', 300_000);
    const updater = t.current().status.updaterPid;
    await processesGone([updater], 30_000);
    // What it started outlives it: the hub on the new version
    await new Promise((r) => setTimeout(r, 2000));
    assert.equal(t.hub()?.version, 'v0.2.0', 'the hub the updater started runs on after it ended');
  } finally {
    await t.cleanup();
  }
});

test('an updater that is gone leaves its update paused at its step, with Try again and Go back; a second click while one runs is refused', async () => {
  const t = installed();
  try {
    const home = path.join(t.p.tmp, 'nlhome');
    const id = 'u-test-gone1';
    const dir = path.join(home, 'update', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(home, 'update', 'current.json'), JSON.stringify({ protocol: 1, id }));
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify({ protocol: 1, id, kind: 'update', from: 'v0.1.0', to: 'v0.2.0', channel: 'release', projects: [] }));
    const old = new Date(Date.now() - 5 * 60_000).toISOString();
    const status = (phase, pid) => JSON.stringify({ protocol: 1, id, phase, updaterPid: pid, steps: { prepare: { state: 'done' }, wait: { state: 'done' }, backup: { state: 'done' }, stop: { state: 'running' } }, at: old });
    const lib = new URL('../src/updater.mjs', import.meta.url).href;
    const look = () => {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(lib)}).then((u) => console.log(JSON.stringify(u.currentUpdate().status)))`], { env: withEnv(t.p.env, { NEXTLEVEL_HOME: home }), encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    // its updater still runs (this test's own process): it is in progress
    fs.writeFileSync(path.join(dir, 'status.json'), status('stopping', process.pid));
    assert.equal(look().phase, 'stopping');
    const second = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(lib)}).then((u) => console.log(JSON.stringify(u.startUpdate({ git: () => ({ out: '' }), back: true, to: 'v0.1.0' }))))`], { env: withEnv(t.p.env, { NEXTLEVEL_HOME: home }), encoding: 'utf8' });
    assert.match(second.stdout, /in progress already/, second.stderr);
    // ...gone (a pid nothing has): paused at the step it was in, after the stop, so Go back is offered
    const gone = spawnSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(dir, 'status.json'), status('stopping', Number(gone.stdout.trim())));
    const s = look();
    assert.equal(s.phase, 'paused');
    assert.equal(s.paused.step, 'stop');
    assert.equal(s.paused.changed, true);
    assert.match(s.paused.text, /the updater stopped before it finished/);
  } finally {
    await t.cleanup();
  }
});

test('the update runs the bridge test again when the new version changes how slots refuse pushes, and only then (the review\'s Required 11)', async () => {
  const t = installed();
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.nl(['_install'], { env: { NEXTLEVEL_NO_PATH: '1' } }).code, 0);
    t.background(['run', '--tick-ms', '200']);
    await waitUntil('the hub starts', () => t.hub(), 60_000);
    // Passing verdicts for the stub workers' engine and their fallback's, from v0.1.0
    for (const args of [[], ['--engine', 'codex']]) {
      const bridge = t.run(['bridge-test', ...args, '--timeout', '3'], { timeout: 420_000 });
      assert.equal(bridge.code, 0, bridge.out);
    }
    const kept = () => JSON.parse(read(t.p.state('bridge-tests', 'agy.json')));
    assert.deepEqual([kept().result, kept().slotPushBlock], ['passed', 1]);
    const ranAt = kept().at;
    // v0.2.0 refuses pushes in the slots another way: its doctor asks for the test again, so the update runs it
    t.label('two');
    t.gh.commit('Slots refuse pushes another way', () => t.gh.edit('src/lib/workerspec.mjs', /SLOT_PUSH_BLOCK = 1/, 'SLOT_PUSH_BLOCK = 2'));
    t.gh.release('v0.2.0');
    await seeRelease(t, 'v0.2.0');
    const update = t.run(['update'], { timeout: 400_000 });
    assert.equal(update.code, 0, update.out);
    assert.equal(t.versions().release, 'v0.2.0');
    const status = t.current().status;
    assert.equal(status.phase, 'done');
    assert.match(status.steps.bridge.detail, /the bridge test ran again and passed/);
    assert.equal(kept().slotPushBlock, 2, 'the new verdict is the new version\'s');
    assert.notEqual(kept().at, ranAt);
    assert.equal(t.hub()?.version, 'v0.2.0');
  } finally {
    await t.cleanup();
  }
});

test("the update's hold: from the click no task or round starts, while a check a round asks for still runs; from the end of the wait every queued job waits but the update's own; Stop waiting lets it all go", async () => {
  const t = installed();
  try {
    t.gh.release('v0.1.0');
    assert.equal(t.nl(['_install'], { env: { NEXTLEVEL_NO_PATH: '1' } }).code, 0);
    // a backup branch GitHub refuses (a hook in the stand-in remote): the update pauses after its wait, with the hub running
    const cfg = JSON.parse(read(path.join(t.p.repo, 'nextlevel.json')));
    fs.writeFileSync(path.join(t.p.repo, 'nextlevel.json'), JSON.stringify({ ...cfg, updates: { backupBranch: 'nextlevel-backup' } }, null, 2));
    t.p.spec('T1-activity', 'node -e "process.exit(0)"');
    t.p.spec('T2-later', 'node -e "process.exit(0)"');
    t.p.gitIn(t.p.repo, 'add', '-A');
    t.p.gitIn(t.p.repo, 'commit', '-qm', 'a backup branch, and two tasks');
    const guardLib = new URL('../src/lib/guard.mjs', import.meta.url).href;
    const own = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(guardLib)}).then((m) => m.recordOwner(${JSON.stringify(t.p.repo)}, ['nextlevel.json']))`], { env: t.p.env, encoding: 'utf8' });
    assert.equal(own.status, 0, own.stderr);
    const refuse = path.join(t.p.remote, 'hooks', 'pre-receive');
    fs.writeFileSync(refuse, '#!/bin/sh\necho refused for the test >&2\nexit 1\n');
    fs.chmodSync(refuse, 0o755);
    // autopilot on, as the owner turned it on
    fs.mkdirSync(t.p.state(), { recursive: true });
    fs.writeFileSync(t.p.state('settings.json'), JSON.stringify({ autopilot: true, onAt: new Date().toISOString() }));
    t.background(['run', '--tick-ms', '200']);
    await waitUntil('the hub starts', () => t.hub(), 60_000);
    const first = t.hub().pid;
    t.label('two');
    t.gh.release('v0.2.0');
    await seeRelease(t, 'v0.2.0');
    assert.match(t.run(['dispatch', 'T1-activity']).out, /queued/);
    const status = (id) => {
      try {
        return JSON.parse(read(t.p.state('jobs', id, 'status.json')));
      } catch {
        return null;
      }
    };
    await waitUntil('the worker starts', () => status('T1-activity')?.state === 'running', 60_000);
    const roundsStarted = () => {
      try {
        return JSON.parse(read(t.p.state('rounds.json'))).starts?.length || 0;
      } catch {
        return 0;
      }
    };
    const rounds = roundsStarted();

    // The click: the update waits for the worker, and holds new work from now
    t.background(['update']);
    await waitUntil('the update waits for the worker', () => (t.current()?.status.waitingFor || []).some((w) => /T1-activity runs/.test(w)), 120_000);
    const id = t.current().id;
    await waitUntil('the hub holds', () => t.hub()?.held === id, 30_000);
    // a new task waits, and says why
    assert.match(t.run(['dispatch', 'T2-later']).out, /queued/);
    await waitUntil('T2 waits for the update', () => /nextlevel is updating to v0\.2\.0: new work waits/.test(status('T2-later')?.waiting || ''), 30_000);
    // ...while a check a running round (or the orchestrator's window) asks for runs: its nextlevel wait would wait for ever
    const early = t.run(['verify', 'while-waiting', '--', 'node', '-e', 'process.exit(0)']).out.match(/queued (\S+):/)?.[1];
    assert.ok(early);
    await waitUntil('the check runs while the update waits', () => status(early)?.state === 'passed', 60_000);
    assert.equal(status('T2-later').state, 'queued');

    // The worker ends (a real event: a round is due), the wait ends, and the backup is refused: paused, the hub still runs
    const slot = path.join(path.dirname(t.p.repo), 'proj.slots', `w${status('T1-activity').slot}`);
    fs.writeFileSync(path.join(slot, '.nextlevel-task', 'GO'), 'go');
    await waitUntil('the update pauses at the backup', () => t.current()?.status.phase === 'paused', 240_000);
    assert.equal(t.current().status.paused.step, 'backup');
    // the update's own job went through the hold: its backup push ran (and GitHub refused it)
    const pushes = fs.readdirSync(t.p.state('jobs')).filter((j) => j.startsWith('push-'));
    assert.equal(pushes.length, 1, pushes.join(', '));
    assert.equal(JSON.parse(read(t.p.state('jobs', pushes[0], 'job.json'))).by, 'update');
    // no round starts while held, though one is due; Home says why
    await waitUntil('the round is held', () => /update to v0\.2\.0 is paused: new work waits until you choose/.test(JSON.parse(read(t.p.state('settings.json'))).roundHeld || ''), 30_000);
    assert.equal(roundsStarted(), rounds, 'no round started');
    // from the end of the wait every queued job waits too
    const late = t.run(['verify', 'after-the-wait', '--', 'node', '-e', 'process.exit(0)']).out.match(/queued (\S+):/)?.[1];
    await waitUntil('the check waits for the update', () => /update to v0\.2\.0 is paused/.test(status(late)?.waiting || ''), 30_000);
    assert.equal(status(late).state, 'queued');
    assert.equal(status('T2-later').state, 'queued');
    assert.equal(t.hub().pid, first, 'the hub was never stopped');
    assert.equal(roundsStarted(), rounds, 'still no round');

    // Stop waiting: nothing changed, the hold goes, and what waited goes on (autopilot off first: the round that is due
    // would start now, which FR-019's tests cover)
    const s = JSON.parse(read(t.p.state('settings.json')));
    fs.writeFileSync(t.p.state('settings.json'), JSON.stringify({ ...s, autopilot: false }));
    const lib = new URL('../src/updater.mjs', import.meta.url).href;
    const stop = spawnSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(lib)}).then((u) => console.log(JSON.stringify(u.stopWaiting(${JSON.stringify(id)}))))`], { env: t.p.env, encoding: 'utf8' });
    assert.match(stop.stdout, /"ok":true/, stop.stderr);
    assert.equal(t.current().status.phase, 'cancelled');
    await waitUntil('the hold ends', () => t.hub()?.held === null, 30_000);
    await waitUntil('the check runs', () => status(late)?.state === 'passed', 60_000);
    await waitUntil('T2 starts', () => status('T2-later')?.state !== 'queued', 60_000);
    assert.equal(status(late).waiting, null);
    assert.equal(t.versions().release, 'v0.1.0', 'nothing changed');
    assert.match(read(t.p.state('logs', 'hub.log')), /the update's hold has ended: new work goes on/);
    await waitUntil('T2 ends', () => ['done', 'failed', 'error', 'no-changes'].includes(status('T2-later')?.state), 120_000);
  } finally {
    await t.cleanup();
  }
});
