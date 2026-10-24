// The scan run before anything is published (scripts/public-scan.mjs): a deny-list read raw, the allow-list and its
// permitted names, secrets, e-mail addresses, home folders and binaries.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { readAllow, readList, scan } from '../scripts/public-scan.mjs';

function tree(files) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-scan-'));
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), text);
  }
  return root;
}
const found = (root, opts) => scan(root, opts).map((f) => `${f.path}:${f.line} ${f.kind} ${f.what}`);

test('the deny-list is read raw, case-insensitive, in texts and in paths', () => {
  const deny = readList('# a comment\n\nAcmeCorp\nprojects\\secret-app\n');
  assert.deepEqual(deny, ['AcmeCorp', 'projects\\secret-app'], 'a backslash stays a backslash; comments and blank lines go');
  const root = tree({
    'a.md': 'fine\nbuilt for ACMECORP\n',
    'b.md': 'C:\\Users\\User\\projects\\secret-app\\x\n',
    'c.md': 'projects/secret-app is the other slash\n',
    'docs/acmecorp-notes.md': 'nothing\n',
  });
  try {
    assert.deepEqual(found(root, { deny }), [
      'a.md:2 name acmecorp',
      'b.md:1 name projects\\secret-app',
      'docs/acmecorp-notes.md:0 name acmecorp',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the allow-list: a finding on a named line of a named file, and a name permitted anywhere', () => {
  const allow = readAllow('# a comment\ntest/x.mjs\tPLANTED\n*\tAcmeCorp/tool\nno tab here\n');
  assert.deepEqual(allow, [{ path: 'test/x.mjs', text: 'PLANTED' }, { path: '*', text: 'AcmeCorp/tool' }]);
  const root = tree({
    // (the values are put together here, so this file holds none for the scan of this repository to find)
    'test/x.mjs': `const t = '${'ghp'}_PLANTED0123456789abcdefghij';\nconst u = '${'ghp'}_real0123456789abcdefghijkl';\n`,
    'README.md': 'irm https://example.com/AcmeCorp/tool/install.ps1\nAcmeCorp/other\n',
  });
  try {
    assert.deepEqual(found(root, { deny: ['acmecorp'], allow }), [
      'README.md:2 name acmecorp',
      'test/x.mjs:2 secret GitHub token',
    ], 'the permitted name is taken out, the rest of the line is still read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('secrets, e-mail addresses, home folders and binaries', () => {
  const root = tree({
    'keys.txt': `${'AKIA'}ABCDEFGHIJKLMNOP\n-----BEGIN OPENSSH ${'PRIVATE'} KEY-----\n`,
    'mail.md': `write to ${'someone'}@mail.test.org or security@nextlevelorc.com or a@example.com\n`,
    'paths.md': `C:\\${'Users'}\\jane\\x and C:\\Users\\User\\y and /home/me/z and /${'Users'}/bob/w\n`,
    'pic.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]),
    'ok.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 3]),
  });
  try {
    assert.deepEqual(found(root, { deny: [], binaries: ['ok.png'] }), [
      'keys.txt:1 secret AWS key id',
      'keys.txt:2 secret private key',
      `mail.md:1 email ${'someone'}@mail.test.org`,
      `paths.md:1 home C:\\${'Users'}\\jane`,
      `paths.md:1 home /${'Users'}/bob`,
      'pic.png:0 binary not on the binaries list',
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
