// Releases (safe updates): the notes' format, version names and their order, which tags are releases, and the launcher's
// rules held together with lib/versions.mjs (the launcher lives outside every version, so it has its own copy).
//   node --test test/releases.test.mjs
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { INSTALL_COMMAND } from '../src/lib/install.mjs';
import { FIRST_RELEASE, TAG_NS, compareVersions, isReleaseName, judgeTags, newerReleases, parseNotes, tagMessage } from '../src/lib/releases.mjs';
import { VERSION_NAME, candidateName, projectKey } from '../src/lib/versions.mjs';
import { ownerNeeds } from '../src/lib/overview.mjs';
import * as launcher from '../src/launch.mjs';

test('the notes: sections, safety marks, continuation lines, After install, a signature left out', () => {
  const n = parseNotes(
    [
      'nextlevel v0.3.0',
      '',
      'Fixes:',
      '- Safety: a verify command can no longer push',
      '  with your sign-in. (#41)',
      '- The Project page finds plans named the way real projects name them. (#38)',
      '',
      'New:',
      '* Home shows what the next round waits for.',
      '',
      'After install:',
      '- Run the bridge test again.',
      'A closing line.',
      '-----BEGIN PGP SIGNATURE-----',
      'abc',
    ].join('\r\n'),
  );
  assert.equal(n.title, 'nextlevel v0.3.0');
  assert.deepEqual(n.fixes, [
    { text: 'a verify command can no longer push with your sign-in. (#41)', safety: true },
    { text: 'The Project page finds plans named the way real projects name them. (#38)', safety: false },
  ]);
  assert.deepEqual(n.added, [{ text: 'Home shows what the next round waits for.', safety: false }]);
  assert.deepEqual(n.afterInstall, ['Run the bridge test again.']);
  assert.equal(n.safety, true);
  assert.deepEqual(n.other, ['A closing line.']);
  assert.equal(parseNotes('nextlevel v0.1.0\n\nFixes:\n- plain').safety, false);
  // long and many: kept in bounds
  const big = parseNotes(`nextlevel v1.0.0\n\nFixes:\n${Array.from({ length: 100 }, (_, i) => `- ${'x'.repeat(1000)} ${i}`).join('\n')}`);
  assert.equal(big.fixes.length, 60);
  assert.ok(big.fixes.every((f) => f.text.length <= 600));
});

test('version names: the form, the order, the floor', () => {
  assert.ok(isReleaseName('v0.1.0'));
  assert.ok(isReleaseName('v1.20.3'));
  for (const bad of ['v0.0.9', '0.1.0', 'v0.1', 'v0.1.0-rc1', 'v01.1.0', 'v0.1.0 ', '-v0.1.0', 'v0.1.0/../x', 'main']) assert.ok(!isReleaseName(bad), bad);
  assert.equal(FIRST_RELEASE, 'v0.1.0');
  assert.ok(compareVersions('v0.10.0', 'v0.9.9') > 0, 'by number, not by text');
  assert.ok(compareVersions('v1.0.0', 'v0.99.99') > 0);
  assert.equal(compareVersions('v0.2.0', 'v0.2.0'), 0);
  assert.equal(tagMessage('object abc\ntype commit\ntag v0.1.0\ntagger x\n\nnextlevel v0.1.0\n\nFixes:\n- y\n'), 'nextlevel v0.1.0\n\nFixes:\n- y\n');
});

// A repository's tags as git would answer for them: for-each-ref, cat-file, merge-base
function fakeGit({ tags, onMain = [], ancestors = [] }) {
  return (args) => {
    if (args[0] === 'for-each-ref') return { ok: true, out: tags.map((t) => [`${TAG_NS}${t.name}`, t.type || 'tag', t.obj, t.type === 'commit' ? '' : t.commit].join('\t')).join('\n') };
    if (args[0] === 'cat-file') {
      const t = tags.find((x) => x.obj === args[2]);
      return { ok: true, out: `object ${t.commit}\ntype commit\ntag ${t.name}\n\n${t.message ?? `nextlevel ${t.name}\n\nFixes:\n- something\n`}` };
    }
    if (args[0] === 'merge-base') {
      const [, , a, b] = args;
      if (b === 'refs/remotes/origin/main') return { ok: onMain.includes(a) };
      return { ok: ancestors.some(([x, y]) => x === a && y === b) };
    }
    return { ok: false, out: '' };
  };
}
const sha = (c) => c.repeat(40);

test('judgeTags: annotated, titled, on main, from the floor up, never moved; vanished ones said; newest first', () => {
  const tags = [
    { name: 'v0.1.0', obj: sha('1'), commit: sha('a') },
    { name: 'v0.2.0', obj: sha('2'), commit: sha('b') },
    { name: 'v0.2.1', type: 'commit', obj: sha('c') }, // lightweight
    { name: 'v0.3.0', obj: sha('3'), commit: sha('d') }, // off main
    { name: 'v0.4.0', obj: sha('4'), commit: sha('e'), message: 'a tag without the title\n' },
    { name: 'v0.0.9', obj: sha('5'), commit: sha('f') }, // from before releases
    { name: 'vNext', obj: sha('6'), commit: sha('a') }, // not a version: not ours
  ];
  const git = fakeGit({ tags, onMain: [sha('a'), sha('b'), sha('c'), sha('e'), sha('f')] });
  const seen = { 'v0.1.0': { tag: sha('1'), commit: sha('a') }, 'v0.2.0': { tag: sha('9'), commit: sha('b') }, 'v0.1.5': { tag: sha('7'), commit: sha('7') } };
  const j = judgeTags(git, { seen });
  assert.deepEqual(j.releases.map((r) => r.name), ['v0.1.0']);
  const why = Object.fromEntries(j.refused.map((r) => [r.name, r.why]));
  assert.match(why['v0.2.0'], /was changed on GitHub after it was published/);
  assert.match(why['v0.2.1'], /lightweight tag/);
  assert.match(why['v0.3.0'], /isn't on main's history/);
  assert.match(why['v0.4.0'], /doesn't start with "nextlevel v0\.4\.0"/);
  assert.equal(why['v0.0.9'], undefined, 'from before releases: silently not one');
  assert.deepEqual(j.vanished, ['v0.1.5']);
  assert.equal(j.seen['v0.2.0'].tag, sha('9'), 'what was first seen is kept');
  assert.ok(j.seen['v0.3.0'], 'a new name is recorded when first seen');
});

test('judgeTags after a move to another repository: what was seen there is never "gone", and a tag of the same name here is not that release', () => {
  const tags = [{ name: 'v0.1.0', obj: sha('8'), commit: sha('9') }, { name: 'v0.2.0', obj: sha('2'), commit: sha('b') }];
  const git = fakeGit({ tags, onMain: [sha('9'), sha('b')] });
  const seen = { 'v0.1.0': { tag: sha('1'), commit: sha('a'), left: 'owner/old' }, 'v0.0.9': { tag: sha('3'), commit: sha('3'), left: 'owner/old' }, 'v0.1.5': { tag: sha('7'), commit: sha('7') } };
  const j = judgeTags(git, { seen });
  assert.deepEqual(j.releases.map((r) => r.name), ['v0.2.0']);
  assert.match(j.refused.find((r) => r.name === 'v0.1.0').why, /was a release of owner\/old, the repository this install followed before, and this v0\.1\.0 is another commit/);
  assert.deepEqual(j.vanished, ['v0.1.5'], 'only a release of the repository it follows now can be gone');
  assert.equal(j.seen['v0.1.0'].left, 'owner/old', 'what was seen there is kept as it was');
});

test('newerReleases: a higher number AND after the installed commit in main\'s history', () => {
  const rel = (name, c) => ({ name, commit: sha(c) });
  const list = [rel('v0.4.0', 'd'), rel('v0.3.0', 'c'), rel('v0.2.0', 'b'), rel('v0.1.0', 'a')];
  const git = fakeGit({ tags: [], ancestors: [[sha('b'), sha('d')], [sha('a'), sha('b')], [sha('a'), sha('d')]] });
  // v0.3.0 has a higher number but isn't after v0.2.0 in main's history: not offered
  assert.deepEqual(newerReleases(git, list, { name: 'v0.2.0', commit: sha('b') }).map((r) => r.name), ['v0.4.0']);
  assert.deepEqual(newerReleases(git, list, { name: 'v0.4.0', commit: sha('d') }), []);
  // the same commit tagged twice is not newer code
  assert.deepEqual(newerReleases(git, [rel('v0.2.1', 'b')], { name: 'v0.2.0', commit: sha('b') }), []);
});

test('the launcher and lib/versions.mjs agree: the version names, the project key, the install command', () => {
  for (const n of ['v0.1.0', 'main@1a2b3c4', 'claude-x@1a2b3c4d5e6f', '../x', 'v0.1.0/..', '@1a2b3c4', 'main@zzzzzzz']) {
    const r = launcher.chooseVersion({ home: os.tmpdir(), env: { NEXTLEVEL_VERSION: n } });
    assert.equal(!/isn't a version's name/.test(r.error || ''), VERSION_NAME.test(n), n);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-key-'));
  try {
    assert.equal(launcher.projectKey(dir), projectKey(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(fs.readFileSync(new URL('../src/launch.mjs', import.meta.url), 'utf8').includes(INSTALL_COMMAND), 'the launcher gives the same repair command');
  assert.equal(candidateName('claude/x y', 'abcdef0123456789'), 'claude-x-y@abcdef0');
  assert.ok(VERSION_NAME.test(candidateName('---', 'abcdef0')));
});

test('the launcher: NEXTLEVEL_VERSION first, then the project\'s channel, then the release; a missing folder stops it', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-launch-'));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-proj-'));
  try {
    fs.mkdirSync(path.join(proj, '.git'));
    for (const v of ['v0.1.0', 'v0.2.0', 'main@1a2b3c4']) {
      fs.mkdirSync(path.join(home, 'versions', v, 'bin'), { recursive: true });
      fs.mkdirSync(path.join(home, 'versions', v, '.git'));
      fs.writeFileSync(path.join(home, 'versions', v, 'bin', 'nextlevel.mjs'), '');
    }
    fs.writeFileSync(path.join(home, 'versions.json'), JSON.stringify({ release: 'v0.2.0' }));
    assert.equal(launcher.chooseVersion({ home, cwd: proj, env: {} }).name, 'v0.2.0');
    fs.writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ projects: { [launcher.projectKey(proj)]: { channel: 'pin', ref: 'v0.1.0' } } }));
    assert.equal(launcher.chooseVersion({ home, cwd: path.join(proj), env: {} }).name, 'v0.1.0');
    assert.equal(launcher.chooseVersion({ home, cwd: os.tmpdir(), argv: ['--project', proj, 'status'], env: {} }).name, 'v0.1.0', '--project');
    assert.equal(launcher.chooseVersion({ home, cwd: os.tmpdir(), env: {} }).name, 'v0.2.0', 'no project: the release');
    assert.equal(launcher.chooseVersion({ home, cwd: proj, env: { NEXTLEVEL_VERSION: 'main@1a2b3c4' } }).name, 'main@1a2b3c4');
    // a folder that is there but that versions.json doesn't list is never run
    fs.writeFileSync(path.join(home, 'versions.json'), JSON.stringify({ release: 'v0.2.0', installed: { 'v0.1.0': {}, 'v0.2.0': {} } }));
    // (NEXTLEVEL_VERSION names a version an older window carries: gone since an update, it says to open a new window)
    assert.match(launcher.chooseVersion({ home, cwd: proj, env: { NEXTLEVEL_VERSION: 'main@1a2b3c4' } }).error, /This window was opened by nextlevel main@1a2b3c4, which was updated since.*open a new window/);
    fs.writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ projects: { [launcher.projectKey(proj)]: { channel: 'candidate', ref: 'main', version: 'main@1a2b3c4' } } }));
    assert.match(launcher.chooseVersion({ home, cwd: proj, env: {} }).error, /isn't a version this install made/);
    fs.writeFileSync(path.join(home, 'channels.json'), JSON.stringify({ projects: { [launcher.projectKey(proj)]: { channel: 'pin', ref: 'v0.1.0' } } }));
    assert.equal(launcher.chooseVersion({ home, cwd: proj, env: { NEXTLEVEL_VERSION: 'v0.2.0' } }).name, 'v0.2.0');
    fs.rmSync(path.join(home, 'versions', 'v0.1.0'), { recursive: true });
    assert.match(launcher.chooseVersion({ home, cwd: proj, env: {} }).error, /nextlevel v0\.1\.0 \(pinned\) isn't on this PC any more/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(proj, { recursive: true, force: true });
  }
});

test("Home's needs: a release with a safety fix is one of them, with its line", () => {
  const b = { active: [], queued: [], review: [], waiting: [], milestones: [], alerts: [], hub: { running: true }, autopilot: { on: false }, guard: [] };
  assert.equal(ownerNeeds(b).filter((n) => n.kind === 'update').length, 0);
  const update = { newer: [{ name: 'v0.3.0', notes: { safety: true, fixes: [{ text: 'closes a push', safety: true }], added: [] } }] };
  const needs = ownerNeeds({ ...b, update });
  const n = needs.find((x) => x.kind === 'update');
  assert.equal(n.text, 'nextlevel v0.3.0 has a safety fix: closes a push');
  assert.equal(n.level, 'warn');
  assert.equal(ownerNeeds({ ...b, update: { ...update, off: true } }).filter((x) => x.kind === 'update').length, 0);
  assert.equal(ownerNeeds({ ...b, update: { newer: [{ name: 'v0.3.0', notes: { safety: false } }] } }).filter((x) => x.kind === 'update').length, 0);
});

test("pruning old version folders keeps one a registered process runs from, and removes it once that process ends (the run registry, the #42 review's \"For B\")", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-prune-'));
  const saved = process.env.NEXTLEVEL_HOME;
  process.env.NEXTLEVEL_HOME = home;
  let child;
  try {
    const { pruneVersions, readVersions } = await import('../src/lib/versions.mjs');
    const { runsVersion } = await import('../src/lib/runreg.mjs');
    fs.writeFileSync(path.join(home, 'versions.json'), JSON.stringify({ release: 'v0.2.0', installed: { 'v0.1.0': { commit: 'a'.repeat(40) }, 'v0.2.0': { commit: 'b'.repeat(40) } } }));
    for (const v of ['v0.1.0', 'v0.2.0']) fs.mkdirSync(path.join(home, 'versions', v, '.git'), { recursive: true });
    // a process that runs v0.1.0 (an open menu, a long nextlevel wait): registered, as cli.mjs registers every command
    const runreg = new URL('../src/lib/runreg.mjs', import.meta.url).href;
    child = spawn(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(runreg)}).then((m) => { m.register({ version: 'v0.1.0', command: 'wait' }); console.log('registered'); setInterval(() => {}, 1000); })`], { env: { ...process.env, NEXTLEVEL_HOME: home }, stdio: ['ignore', 'pipe', 'inherit'] });
    await new Promise((resolve) => child.stdout.on('data', (d) => /registered/.test(String(d)) && resolve()));
    const removed = [];
    const git = (args) => {
      if (args[0] === 'worktree' && args[1] === 'remove') {
        fs.rmSync(args.at(-1), { recursive: true, force: true });
        removed.push(path.basename(args.at(-1)));
      }
      return { ok: true, out: '' };
    };
    const keep = new Set(['v0.2.0']);
    assert.deepEqual(pruneVersions(git, { keep, running: (name) => runsVersion(name) }), [], 'kept: a process runs from it');
    assert.ok(fs.existsSync(path.join(home, 'versions', 'v0.1.0')));
    assert.ok(readVersions().installed['v0.1.0']);
    // the process ends: its record goes (stale, dropped by the reader), and so does the folder
    child.kill();
    await new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', resolve)));
    assert.deepEqual(pruneVersions(git, { keep, running: (name) => runsVersion(name) }), ['v0.1.0']);
    assert.deepEqual(removed, ['v0.1.0']);
    assert.ok(!readVersions().installed['v0.1.0']);
    assert.ok(readVersions().installed['v0.2.0'], 'the release stays');
    assert.deepEqual(fs.readdirSync(path.join(home, 'update', 'run')), [], 'the stale record went');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) child.kill();
    if (saved === undefined) delete process.env.NEXTLEVEL_HOME;
    else process.env.NEXTLEVEL_HOME = saved;
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5 });
  }
});
