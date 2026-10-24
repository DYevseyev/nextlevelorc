#!/usr/bin/env node
// Scans a tree before it is published: names that must not be public (a deny-list kept outside the repo), secrets,
// e-mail addresses, home folders with a real user name, and binary files.
//
//   node scripts/public-scan.mjs --deny <deny-list file> [--allow <allow-list file>] [--binaries <list file>] [<folder>]
//
// The deny-list has one case-insensitive substring per line, read raw (a backslash is a backslash); blank lines and
// lines starting with # are skipped. Every line is matched against each file's text and its path.
// The allow-list has one entry per line, `<path>\t<text>`: a finding on a line of <path> that contains <text> is allowed
// (the planted secrets the tests redact). With the path `*`, <text> is a name that may appear anywhere (the repository's
// own owner/name): it is taken out of each line and path before the deny-list is matched, and nothing else is allowed. The binaries list names, one per line, the binary files a reviewer looked at.
// The folder defaults to the current one; in a git checkout only tracked files are read. Exits 1 on any finding.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function readList(text) {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, '')).filter((l) => l && !l.startsWith('#'));
}

export function readAllow(text) {
  return readList(text).map((l) => {
    const tab = l.indexOf('\t');
    return tab < 0 ? null : { path: l.slice(0, tab), text: l.slice(tab + 1) };
  }).filter(Boolean);
}

const SECRETS = [
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['OpenAI-style key', /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/],
  ['AWS key id', /\bAKIA[A-Z0-9]{12,}/],
  ['private key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['Slack token', /\bxox[abposr]-[A-Za-z0-9-]{10,}/],
  ['Google API key', /\bAIza[0-9A-Za-z_-]{30,}/],
];
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const EMAIL_OK = /(?:@(?:example\.(?:com|org|net)|users\.noreply\.github\.com|noreply\.github\.com|anthropic\.com|nextlevelorc\.com)|^git@github\.com|\.invalid|\.example)$/i;
const HOME = /(?:[A-Za-z]:[\\/]+Users[\\/]+|\/home\/|\/Users\/)([A-Za-z0-9._ -]+?)(?=[\\/"'`\s,;)]|$)/g;
const HOME_OK = new Set(['user', 'me', 'you', 'runner', 'node', 'claude', 'name', '<you>', 'public', 'default', 'shared',
  'example', 'alice', 'owner', 'test', 'runneradmin', 'u', '...', '…']);

function isBinary(buf) {
  return buf.subarray(0, 8000).includes(0);
}

function files(root) {
  if (existsSync(join(root, '.git'))) {
    return execFileSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  }
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p); else out.push(relative(root, p).split(sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

export function scan(root, { deny, allow = [], binaries = [], skip = [] }) {
  const denied = deny.map((d) => d.toLowerCase());
  const findings = [];
  const permits = allow.filter((a) => a.path === '*').map((a) => a.text.toLowerCase());
  const permit = (s) => permits.reduce((t, p) => t.split(p).join(' '), s.toLowerCase());
  const allowed = (path, line) => allow.some((a) => a.path === path && line.includes(a.text));
  for (const path of files(root).filter((f) => !skip.includes(f))) {
    const lower = permit(path);
    for (const d of denied) if (lower.includes(d)) findings.push({ path, line: 0, kind: 'name', what: d });
    const buf = readFileSync(join(root, path));
    if (isBinary(buf)) {
      if (!binaries.includes(path)) findings.push({ path, line: 0, kind: 'binary', what: 'not on the binaries list' });
      continue;
    }
    const lines = buf.toString('utf8').split('\n');
    lines.forEach((line, i) => {
      const at = i + 1;
      const low = permit(line);
      const hit = [];
      for (const d of denied) if (low.includes(d)) hit.push({ kind: 'name', what: d });
      for (const [name, re] of SECRETS) if (re.test(line)) hit.push({ kind: 'secret', what: name });
      for (const m of line.matchAll(EMAIL)) if (!EMAIL_OK.test(m[0])) hit.push({ kind: 'email', what: m[0] });
      for (const m of line.matchAll(HOME)) {
        if (!HOME_OK.has(m[1].toLowerCase()) && !/^[$%<{]/.test(m[1])) hit.push({ kind: 'home', what: m[0] });
      }
      if (hit.length && !allowed(path, line)) for (const h of hit) findings.push({ path, line: at, ...h });
    });
  }
  return findings;
}

function main(argv) {
  const opt = { root: '.' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--deny' || a === '--allow' || a === '--binaries') opt[a.slice(2)] = argv[++i];
    else if (a === '-h' || a === '--help') { console.log(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1, 12).join('\n')); return 0; }
    else if (a.startsWith('-')) { console.error(`unknown option ${a}`); return 2; }
    else opt.root = a;
  }
  if (!opt.deny) { console.error('--deny <file> is required'); return 2; }
  const findings = scan(opt.root, {
    deny: readList(readFileSync(opt.deny, 'utf8')),
    allow: opt.allow ? readAllow(readFileSync(opt.allow, 'utf8')) : [],
    binaries: opt.binaries ? readList(readFileSync(opt.binaries, 'utf8')) : [],
    // the allow-list itself names what it allows
    skip: opt.allow ? [relative(opt.root, opt.allow).split(sep).join('/')] : [],
  });
  for (const f of findings) console.log(`${f.path}:${f.line}\t${f.kind}\t${f.what}`);
  console.log(findings.length ? `${findings.length} finding(s)` : 'clean');
  return findings.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
