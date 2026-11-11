// The look after each attempt (FR-017 part 2B, 2B-1a3; docs/design/FR-017-part2B.md 3.4): nextlevel's own files, its
// clone's origin, ~/.nextlevel/bin and the owner's global git settings, compared after each attempt and at the hub's
// start. A change stops dispatch until the owner's Seen on the dashboard, with a Home card, the attempts flagged and
// one phone message. Test content stays harmless (an alias that echoes, a text file).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { guardDir } from '../src/lib/guard.mjs';
import { ownerNeeds } from '../src/lib/overview.mjs';
import { LOOK, changeWords, diffLook, readLookRecord, takeLook } from '../src/lib/toollook.mjs';
import { fileExists, makeProject } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const exited = (child) => new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r)));
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

test('a look: each part compared with the last one; a part whose folder is another one starts again; only settings that run or redirect count', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-look-'));
  try {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'nextlevel.cmd'), '@echo off\n');
    let status = '';
    let config = 'user.name\nOwner\0core.editor\nnotepad\0';
    const git = (args) => {
      if (args[0] === 'status') return { ok: true, out: status };
      if (args[0] === 'config' && args[1] === '--global') return { ok: true, out: config };
      if (args[0] === 'config' && args[1] === '--system') return { ok: false, out: '' };
      if (args[0] === 'config' && args[1] === '--get') return { ok: true, out: 'https://github.com/owner/nextlevel.git\n' };
      return { ok: false, out: '' };
    };
    const look = (version = '/v/a', clone = '') => takeLook({ git, version, clone, bin, home: tmp });
    const a = look();
    assert.deepEqual(diffLook(a, look()), [], 'nothing changed: nothing said');
    // A setting that doesn't run anything changes nothing; one that does is said
    config = 'user.name\nSomeone else\0core.editor\nnotepad\0';
    assert.deepEqual(diffLook(a, look()), []);
    config += 'alias.nltest\n!echo guard-test\0';
    const b = look();
    assert.deepEqual(diffLook(a, b).map((c) => c.part), ['gitglobal']);
    assert.deepEqual(diffLook(a, b)[0].items, ['alias.nltest = !echo guard-test (global)']);
    // A file beside the command, and nextlevel's own files
    fs.writeFileSync(path.join(bin, 'guard-test.txt'), 'guard-test\n');
    status = ' M src/hub.mjs\n?? src/extra.mjs\n';
    const c = look();
    assert.deepEqual(diffLook(b, c).map((x) => x.part).sort(), ['bin', 'version']);
    assert.deepEqual(diffLook(b, c).find((x) => x.part === 'version').items, [' M src/hub.mjs', '?? src/extra.mjs']);
    assert.deepEqual(diffLook(b, c).find((x) => x.part === 'bin').items, ['guard-test.txt']);
    assert.match(changeWords(diffLook(b, c)).join('\n'), /nextlevel's own files \(the version that runs\):  M src\/hub\.mjs; \?\? src\/extra\.mjs/);
    // After an update the hub runs from another version's folder: its files are compared from there on
    assert.deepEqual(diffLook(c, look('/v/b')), []);
    // The clone and its origin, for an installed tool
    const d = look('/v/a', '/tool');
    assert.deepEqual(d.parts.origin.items, ['https://github.com/owner/nextlevel.git']);
    // A global hooks folder: the files in it count too
    const hooks = path.join(tmp, 'hooks');
    fs.mkdirSync(hooks);
    config += `core.hooksPath\n~/hooks\0`;
    const e = look();
    fs.writeFileSync(path.join(hooks, 'pre-commit'), 'echo guard-test\n');
    assert.deepEqual(diffLook(e, look()).map((x) => x.part), ['globalhooks']);
    // A record that isn't the hub's shape is no record
    const f = path.join(tmp, LOOK);
    fs.writeFileSync(f, JSON.stringify({ base: 'x', change: { changes: 'y' } }));
    assert.deepEqual(readLookRecord(f), { base: null, change: null });
    fs.writeFileSync(f, '{not json');
    assert.deepEqual(readLookRecord(f), { base: null, change: null });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("Home's card: what changed, the attempts that ran, and Seen", () => {
  const b = { active: [], queued: [], review: [], waiting: [], milestones: [], hub: { running: true }, autopilot: { on: false }, toolChange: { at: '2026-11-11T10:00:00Z', when: 'after attempt 1 of T1', tasks: ['T1'], changes: ['your global git settings that run a program or send a push elsewhere: alias.nltest = !echo guard-test (global)'] } };
  const card = ownerNeeds(b).find((n) => n.kind === 'toolchange');
  assert.ok(card);
  assert.equal(card.level, 'error');
  assert.match(card.text, /found after attempt 1 of T1\): your global git settings .*alias\.nltest.*Attempts that ran since the last look: T1\./);
  assert.deepEqual(card.action, { label: 'Seen', post: '/api/toolchange', body: {} });
});

test("a worker that changes a global git setting and a file beside the nextlevel command: its task flagged, hub.log, one phone message, tasks wait until the owner's Seen; a change while the hub is stopped is found at its start", async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  const id = 'TL-01-toolgit';
  const topic = { NTFY_TOPIC: 'a-long-random-topic-for-tests-1234' };
  // (in the background: the stand-in ntfy answers in this process, which a hub run with spawnSync would block)
  const run = () => exited(p.hubInBackground(['run', '--exit-when-idle', '--tick-ms', '200'], topic));
  let ui;
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    p.spec(id, fileExists(`${id}.mjs`));
    p.spec('TL-02-ok', fileExists('ok.mjs'));
    p.spec('TL-03-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', id]);
    await run();
    const s = p.status(id);
    assert.equal(s.state, 'done');
    assert.match(s.toolChange, /alias\.nltest = !echo guard-test \(global\)/);
    assert.match(s.toolChange, /guard-test\.txt/);
    assert.match(p.hub(['result', id, '--peek']).out, /nextlevel's own code or your git settings changed while it ran/);
    const log = () => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    assert.match(log(), new RegExp(`after attempt 1 of ${id}, nextlevel's own code or your git settings changed and nextlevel didn't change them`));
    const phone = () => ntfy.got.filter((m) => m.title === "proj: nextlevel's own files changed");
    assert.equal(phone().length, 1, JSON.stringify(ntfy.got.map((m) => m.title)));
    assert.match(phone()[0].message, /No task starts until you press Seen on the dashboard/);
    // The next task waits, saying why; nothing changed by that
    p.hub(['dispatch', 'TL-02-ok']);
    await run();
    assert.equal(p.status('TL-02-ok').state, 'queued');
    assert.match(p.status('TL-02-ok').waiting, /no task starts until you press Seen on Home/);
    assert.equal(phone().length, 1, 'one phone message for the change');
    // Home's card, and the owner's Seen
    ui = await startUi(p);
    const card = (await client(ui).get('/api/state')).json.needs.find((n) => n.kind === 'toolchange');
    assert.ok(card, 'the card is on Home');
    assert.match(card.text, /alias\.nltest/);
    assert.match(card.text, new RegExp(`Attempts that ran since the last look: ${id}\\.`));
    assert.equal((await client(ui).post('/api/toolchange', {})).json?.ok, true);
    assert.equal((await client(ui).get('/api/state')).json.needs.find((n) => n.kind === 'toolchange'), undefined);
    await stopUi(ui);
    ui = null;
    await run();
    assert.equal(p.status('TL-02-ok').state, 'done');
    assert.equal(p.status('TL-02-ok').waiting ?? null, null);
    assert.equal(p.status('TL-02-ok').toolChange, undefined, 'what the owner saw is the new base: nothing new to flag');
    // A change made while the hub is stopped: found at its start, no attempt to flag
    spawnSync('git', ['config', '--global', 'alias.nlother', '!echo guard-test'], { env: p.env });
    p.hub(['dispatch', 'TL-03-ok']);
    await run();
    assert.equal(p.status('TL-03-ok').state, 'queued');
    assert.match(log(), /while the hub was stopped, nextlevel's own code or your git settings changed and nextlevel didn't change them: .*alias\.nlother/);
    assert.equal(phone().length, 2);
    // The record lives in the guard's folder, outside the project
    const rec = readLookRecord(path.join(guardDir(p.repo, p.env.HOME), LOOK));
    assert.equal(rec.change.when, 'while the hub was stopped');
    assert.ok(!fs.existsSync(p.state(LOOK)));
  } finally {
    await stopUi(ui);
    await ntfy.close();
    p.cleanup();
  }
});
