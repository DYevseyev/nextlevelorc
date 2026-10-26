// The security engineer (docs/design/security-engineer.md): its scan's checkout, with every file that steers an engine
// moved aside and every link taken out, and the lease that lets one scan run at a time on the PC. Fixtures stay harmless.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ASIDE, asideName, findSteering, leaseFile, leaseHolder, releaseLease, setAside, takeLease } from '../src/lib/securityscan.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sec-'));
const put = (root, rel, text = 'x\n') => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};

test("a scan's checkout: steering files at any depth move aside as plain text, links go, the code stays", () => {
  const root = tmp();
  const outside = tmp();
  try {
    for (const rel of [
      'src/app.js',
      'README.md',
      '.claude/settings.json',
      '.codex/config.toml',
      'AGENTS.md',
      'packages/api/AGENTS.override.md',
      'packages/api/SECURITY.md',
      'docs/security.md',
      'docs/agents/WORKER.md',
      '.github/workflows/ci.yml',
      'codex-security.toml',
      '.git/HEAD',
    ]) put(root, rel, `harmless ${rel}\n`);
    put(outside, 'notes.txt', 'outside\n');
    // a link that points outside the checkout: a folder link (a junction on Windows, which needs no admin) and a file one
    fs.symlinkSync(outside, path.join(root, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
    let fileLink = false;
    try {
      fs.symlinkSync(path.join(outside, 'notes.txt'), path.join(root, 'CLAUDE.md'));
      fileLink = true;
    } catch {
      // (Windows without the right to make file links: the folder link is enough)
    }
    const found = findSteering(root);
    assert.deepEqual(found.files, [
      '.claude/settings.json',
      '.codex/config.toml',
      '.github/workflows/ci.yml',
      'AGENTS.md',
      'codex-security.toml',
      'docs/agents/WORKER.md',
      'docs/security.md',
      'packages/api/AGENTS.override.md',
      'packages/api/SECURITY.md',
    ]);
    assert.deepEqual(found.links, fileLink ? ['CLAUDE.md', 'shared'] : ['shared']);

    const r = setAside(root);
    assert.equal(r.moved.length, 9);
    for (const { from, to } of r.moved) {
      assert.ok(!fs.existsSync(path.join(root, from)), `${from} is gone from its place`);
      assert.equal(fs.readFileSync(path.join(root, to), 'utf8'), `harmless ${from}\n`, `${from} kept as plain text`);
      assert.match(path.basename(to), /^\d{3}-[^/]+\.txt$/, 'one flat name: no folder an engine loads');
    }
    assert.equal(asideName('.claude/settings.json', 0), '001-.claude__settings.json.txt');
    assert.ok(!fs.existsSync(path.join(root, 'shared')), 'the link is gone');
    assert.equal(fs.readFileSync(path.join(outside, 'notes.txt'), 'utf8'), 'outside\n', 'what it pointed to is untouched');
    assert.ok(fs.existsSync(path.join(root, 'src/app.js')) && fs.existsSync(path.join(root, 'README.md')), 'the code stays');
    assert.ok(fs.existsSync(path.join(root, '.git/HEAD')), "git's own folder is never touched");
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ASIDE, 'index.json'), 'utf8')).moved, r.moved);
    // Nothing steering is left, and a second look finds nothing new (the aside folder is never walked)
    assert.deepEqual(findSteering(root), { files: [], links: [] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the lease: one scan at a time on the PC, a gone holder taken over, given back only by its holder', () => {
  const home = tmp();
  try {
    const alive = new Map(); // pid -> start
    const startOf = (pid) => alive.get(pid) ?? null;
    const a = { root: '/p/one', pid: 101, start: 1000, scan: 's1' };
    const b = { root: '/p/two', pid: 202, start: 2000, scan: 's2' };
    alive.set(101, 1000).set(202, 2000);
    assert.deepEqual(takeLease(home, a, { startOf }), { ok: true });
    const refused = takeLease(home, b, { startOf });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.holder, { root: '/p/one', pid: 101, start: 1000, scan: 's1' }, 'another project waits, and knows for which');
    assert.deepEqual(takeLease(home, a, { startOf }), { ok: true }, 'the holder taking it again keeps it');
    releaseLease(home, b);
    assert.ok(fs.existsSync(leaseFile(home)), "only its holder gives it back");
    // The holder is gone, or its pid now runs another program (started later): taken over
    alive.set(101, 99_999);
    assert.equal(leaseHolder(home, { startOf }), null);
    assert.deepEqual(takeLease(home, b, { startOf }), { ok: true });
    assert.equal(leaseHolder(home, { startOf }).root, '/p/two');
    releaseLease(home, b);
    assert.ok(!fs.existsSync(leaseFile(home)));
    // A lease file that isn't one (an agent wrote it) holds nothing
    fs.writeFileSync(leaseFile(home), '{"pid":"101"}');
    assert.equal(leaseHolder(home, { startOf }), null);
    assert.deepEqual(takeLease(home, a, { startOf }), { ok: true });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
