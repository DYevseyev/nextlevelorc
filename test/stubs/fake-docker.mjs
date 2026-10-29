#!/usr/bin/env node
// Stand-in for the Docker CLI in tests, so the doctor never waits on a real Docker engine (a cold one
// on the Windows runner made the first doctor run take 20 s). STUB_DOCKER=stopped plays an engine that isn't running.
//
// It also plays OpenAI's Codex Security scanner image for the security engineer (src/security.mjs), with its state in
// ~/.fake-docker: volumes (a folder each, with their labels, owner and mode), containers made with `create`, the pulled
// image. What each `run` was given is appended to ~/.fake-docker/seen.jsonl (its arguments, and for a scan the files of
// the checkout it was given and the policy it read from /input/kb), so a test can say what the scan saw. Settings:
//   STUB_DOCKER=stopped          not running          STUB_DOCKER_OS=windows   Windows containers
//   STUB_DOCKER_NO_IMAGE=1       the pinned image isn't pulled yet (a pull brings it)
//   STUB_DOCKER_PERMS=777        the helper's chmod doesn't take (stat says 777)
//   STUB_DOCKER_CHOWN=eperm      the vendored seccomp profile refuses the helper's chown (Docker's default takes it)
//   STUB_DOCKER_NESTED=fail      Codex's sandbox can't start in the container
//   STUB_DOCKER_PROBE=<words>    what the probe prints (default: the five words the scan needs)
//   STUB_DOCKER_MODELS=<json>    `codex debug models` (default: two models, one with Daybreak Blue)
//   STUB_DOCKER_DRYRUN=refuse    the scanner's dry run refuses its settings
//   STUB_SCAN=ok|broken-seal|link|unlisted|reproduced-text|malformed|slow|exit2|exit2-sealed|deep-name
//                                (exit2-sealed: a whole, sealed output, then exit 2: the scanner's integrity failure)
//   STUB_SCAN_TEXT=<text>        put into the first finding's summary (a planted .env value)
//   STUB_SCAN_THREAT=<text>      the threat model it writes (a policy's draft comes from it)
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (process.env.STUB_CALLS) fs.appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['docker', ...args])}\n`); // (every call, for tests that nothing ran)
const env = process.env;
const STATE = path.join(env.HOME || env.USERPROFILE || os.homedir(), '.fake-docker');
const DIGEST = 'sha256:a90bc3bf8b67ae1c1b046d7987bbfc0ed44dc869b938a393204ec62b5cce65fc';
const IMAGE = `ghcr.io/openai/codex-security@${DIGEST}`;
const sha = (b) => createHash('sha256').update(b).digest('hex');
const volDir = (name) => path.join(STATE, 'volumes', name);
const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const out = (s) => process.stdout.write(`${s}\n`);
const die = (msg, code = 1) => {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
};
const seen = (rec) => {
  fs.mkdirSync(STATE, { recursive: true });
  fs.appendFileSync(path.join(STATE, 'seen.jsonl'), `${JSON.stringify(rec)}\n`);
};

if (env.STUB_DOCKER === 'stopped' && args[0] !== '--version') die('Cannot connect to the Docker daemon. Is the docker daemon running?');

if (args[0] === 'info') {
  const fmt = args[args.indexOf('--format') + 1] || '';
  if (fmt.includes('OSType')) out(`"${env.STUB_DOCKER_OS || 'linux'}" ["name=seccomp,profile=builtin","name=cgroupns"] "29.7.2"`);
  else out('29.7.2');
  process.exit(0);
}

const pulled = () => !env.STUB_DOCKER_NO_IMAGE || fs.existsSync(path.join(STATE, 'pulled'));
if (args[0] === 'image' && args[1] === 'inspect') {
  if (args.at(-1) !== IMAGE || !pulled()) die(`Error: No such image: ${args.at(-1)}`);
  out(JSON.stringify([IMAGE]));
  process.exit(0);
}
if (args[0] === 'pull') {
  if (args[1] !== IMAGE) die('stub docker pulls only the pinned scanner');
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'pulled'), '1');
  out(`Status: Downloaded newer image for ${IMAGE}`);
  process.exit(0);
}

// ---------- volumes ----------
if (args[0] === 'volume') {
  const sub = args[1];
  if (sub === 'create') {
    const name = args.at(-1);
    const labels = {};
    for (let i = 2; i < args.length - 1; i++) if (args[i] === '--label') labels[args[i + 1].split('=')[0]] = args[++i].split('=').slice(1).join('=');
    fs.mkdirSync(path.join(volDir(name), 'data'), { recursive: true });
    if (!fs.existsSync(path.join(volDir(name), 'meta.json'))) fs.writeFileSync(path.join(volDir(name), 'meta.json'), JSON.stringify({ labels, owner: '0:0', mode: '755' }));
    out(name);
    process.exit(0);
  }
  if (sub === 'inspect') {
    const name = args.at(-1);
    const meta = readJson(path.join(volDir(name), 'meta.json'));
    if (!meta) die(`Error: no such volume: ${name}`);
    const fmt = args[args.indexOf('--format') + 1] || '';
    const m = fmt.match(/index \.Labels "([^"]+)"/);
    out(m ? meta.labels[m[1]] || '' : name);
    process.exit(0);
  }
  if (sub === 'ls') {
    const filters = [];
    for (let i = 2; i < args.length; i++) if (args[i] === '--filter') filters.push(args[++i].replace(/^label=/, '').split('='));
    let names = [];
    try {
      names = fs.readdirSync(path.join(STATE, 'volumes'));
    } catch {
      // none
    }
    out(names.filter((n) => filters.every(([k, v]) => readJson(path.join(volDir(n), 'meta.json'))?.labels?.[k] === v)).join('\n'));
    process.exit(0);
  }
  if (sub === 'rm') {
    for (const n of args.slice(2).filter((a) => !a.startsWith('-'))) fs.rmSync(volDir(n), { recursive: true, force: true });
    process.exit(0);
  }
}

// ---------- containers ----------
// --mount type=volume,source=S,target=T[,readonly] and type=bind,... -> [{ type, source, target, readonly }]
function parseRun(list) {
  const o = { mounts: [], name: '', entrypoint: '', user: '', network: '', flags: [] };
  let i = 0;
  const takes = new Set(['--name', '--user', '--entrypoint', '--network', '--mount', '--security-opt', '--cap-drop', '--cap-add', '--pids-limit', '--memory', '--add-host', '-e', '-v', '--label']);
  for (; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith('-')) break;
    if (takes.has(a)) {
      const v = list[++i];
      o.flags.push([a, v]);
      if (a === '--mount') o.mounts.push(Object.fromEntries(v.split(',').map((kv) => (kv.includes('=') ? kv.split('=') : [kv, true]))));
      if (a === '--name') o.name = v;
      if (a === '--user') o.user = v;
      if (a === '--entrypoint') o.entrypoint = v;
      if (a === '--network') o.network = v;
    } else o.flags.push([a]);
  }
  o.image = list[i];
  o.rest = list.slice(i + 1);
  return o;
}
const at = (o, target) => o.mounts.find((m) => m.target === target);
const dataOf = (m) => (m.type === 'volume' ? path.join(volDir(m.source), 'data') : m.source);
const meta = (m) => readJson(path.join(volDir(m.source), 'meta.json'), {});
const setMeta = (m, change) => fs.writeFileSync(path.join(volDir(m.source), 'meta.json'), JSON.stringify({ ...meta(m), ...change }));
const mountFor = (o, p) => o.mounts.filter((m) => p === m.target || p.startsWith(`${m.target}/`)).sort((a, b) => b.target.length - a.target.length)[0];
const hostPath = (o, p) => {
  const m = mountFor(o, p);
  return m ? path.join(dataOf(m), ...p.slice(m.target.length).split('/').filter(Boolean)) : null;
};
const listFiles = (dir, rel = '') => {
  let names = [];
  try {
    names = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch {
    return [];
  }
  return names.flatMap((e) => (e.name === '.git' && !rel ? [] : e.isDirectory() ? listFiles(dir, rel ? `${rel}/${e.name}` : e.name) : [rel ? `${rel}/${e.name}` : e.name]));
};

if (args[0] === 'run') {
  const o = parseRun(args.slice(1));
  if (o.image !== IMAGE) die(`stub docker runs only the pinned scanner, not ${o.image}`);
  if (!pulled()) die(`Unable to find image '${IMAGE}' locally`);
  // (a volume a run names is made as Docker makes it: no labels, root's)
  for (const m of o.mounts) {
    if (m.type !== 'volume' || fs.existsSync(volDir(m.source))) continue;
    fs.mkdirSync(path.join(volDir(m.source), 'data'), { recursive: true });
    fs.writeFileSync(path.join(volDir(m.source), 'meta.json'), JSON.stringify({ labels: {}, owner: '0:0', mode: '755' }));
  }
  const isScan = !o.entrypoint && o.rest[0] === 'scan';
  const kbText = (name) => {
    const m = at(o, '/input/kb');
    try {
      return m ? fs.readFileSync(path.join(dataOf(m), name), 'utf8') : null;
    } catch {
      return null;
    }
  };
  seen({ name: o.name, entrypoint: o.entrypoint, args: args.slice(1), ...(isScan ? { files: listFiles(dataOf(at(o, '/input/repository'))), policy: kbText('policy.md') } : {}) });
  if (o.entrypoint === 'chown' || o.entrypoint === 'chmod') {
    if (o.user !== '0:0') die(`${o.entrypoint}: Operation not permitted`);
    if (o.entrypoint === 'chown' && env.STUB_DOCKER_CHOWN === 'eperm' && o.flags.some(([f, v]) => f === '--security-opt' && /^seccomp=/.test(v || ''))) die("chown: changing ownership of '/v': Operation not permitted");
    const [value, ...paths] = o.rest;
    for (const p of paths) {
      const m = mountFor(o, p);
      if (!m) die(`${o.entrypoint}: cannot access '${p}': No such file or directory`);
      setMeta(m, o.entrypoint === 'chown' ? { owner: value } : { mode: env.STUB_DOCKER_PERMS || value });
    }
    process.exit(0);
  }
  if (o.entrypoint === 'stat') {
    const paths = o.rest.slice(2);
    for (const p of paths) {
      const m = mountFor(o, p);
      out(`${meta(m).owner} ${meta(m).mode}`);
    }
    process.exit(0);
  }
  if (o.entrypoint === 'ls') {
    const dir = hostPath(o, o.rest.at(-1));
    let names = [];
    try {
      names = fs.readdirSync(dir);
    } catch {
      // empty
    }
    out(names.join('\n'));
    process.exit(0);
  }
  if (o.entrypoint === 'sh') {
    // (the probe's planted file)
    const target = hostPath(o, '/output/.codex-security-state/codex-home/auth.json');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '{"planted":"nextlevel-probe"}\n');
    process.exit(0);
  }
  if (o.entrypoint === 'node') {
    const [, sub, ...more] = o.rest;
    if (sub === 'sandbox' && more[0] === '/usr/bin/true') process.exit(env.STUB_DOCKER_NESTED === 'fail' ? 1 : 0);
    if (sub === 'sandbox') {
      out(env.STUB_DOCKER_PROBE || 'login-denied\nlogin-not-listable\nauthfile-denied\nnet-closed\nip-closed');
      process.exit(0);
    }
    if (sub === 'debug' && more[0] === 'models') {
      out(env.STUB_DOCKER_MODELS || JSON.stringify({ models: [{ slug: 'gpt-6-sol', visibility: 'list', available_access_programs: { cyber: ['standard', 'daybreak_blue'] } }, { slug: 'gpt-6-astra', visibility: 'list', available_access_programs: { cyber: ['standard'] } }, { slug: 'gpt-red-only', visibility: 'list', available_access_programs: { cyber: ['daybreak_red'] } }] }));
      process.exit(0);
    }
    die(`[fake docker] node ${o.rest.join(' ')}: not supported`);
  }
  if (o.rest[0] === 'login') {
    const home = hostPath(o, '/output/.codex-security-state/codex-home');
    if (meta(at(o, '/output/.codex-security-state/codex-home')).mode !== '700') die('codex-security: Error: Scan output directory must not be accessible to other users (chmod 700): /output/.codex-security-state/codex-home', 2);
    if (o.rest[1] === 'status') {
      if (!fs.existsSync(path.join(home, 'auth.json'))) die('Not logged in', 1);
      out('Logged in using ChatGPT');
      process.exit(0);
    }
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'auth.json'), '{"stub":"signed-in"}\n');
    out('Successfully logged in');
    process.exit(0);
  }
  if (isScan) await scan(o);
  die(`[fake docker] run ${o.rest.join(' ')}: not supported`);
}

if (args[0] === 'create') {
  const o = parseRun(args.slice(1));
  fs.mkdirSync(path.join(STATE, 'containers'), { recursive: true });
  fs.writeFileSync(path.join(STATE, 'containers', `${o.name}.json`), JSON.stringify({ mounts: o.mounts }));
  out('stub-container-id');
  process.exit(0);
}
if (args[0] === 'cp') {
  const [from, dest] = args.slice(1);
  const [name, p] = from.split(/:(.*)/s);
  const c = readJson(path.join(STATE, 'containers', `${name}.json`));
  if (!c) die(`Error: No such container: ${name}`);
  const src = hostPath({ mounts: c.mounts }, p);
  let st;
  try {
    st = fs.lstatSync(src);
  } catch {
    die(`Error: Could not find the file ${p} in container ${name}`);
  }
  if (st.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
  else if (st.isDirectory()) fs.cpSync(src, dest, { recursive: true });
  else fs.copyFileSync(src, dest);
  process.exit(0);
}
if (args[0] === 'rm') {
  for (const n of args.slice(1).filter((a) => !a.startsWith('-'))) fs.rmSync(path.join(STATE, 'containers', `${n}.json`), { force: true });
  process.exit(0);
}
if (args[0] === 'stop') {
  fs.mkdirSync(path.join(STATE, 'stops'), { recursive: true });
  fs.writeFileSync(path.join(STATE, 'stops', args.at(-1)), '1');
  process.exit(0);
}

console.error(`[fake docker] not supported: ${args.join(' ')}`);
process.exit(1);

// ---------- the scanner's scan ----------
async function scan(o) {
  const outDir = dataOf(at(o, '/output/scan'));
  const loginM = at(o, '/output/.codex-security-state/codex-home');
  for (const m of [at(o, '/output/scan'), at(o, '/output/.codex-security-state'), loginM]) {
    if (meta(m).owner !== '10001:10001' || meta(m).mode !== '700') die(`codex-security: Error: Scan output directory must not be accessible to other users (chmod 700): ${m.target}`, 2);
  }
  if (!fs.existsSync(path.join(dataOf(loginM), 'auth.json'))) die('codex-security: Error: not signed in', 2);
  const flag = (n) => o.rest.includes(n);
  if (flag('--dry-run')) {
    if (env.STUB_DOCKER_DRYRUN === 'refuse') die('codex-security: Invalid --codex key', 2);
    out('codex-security: scan inputs are valid');
    process.exit(0);
  }
  const kind = env.STUB_SCAN || 'ok';
  process.stderr.write('codex-security: scanning /input/repository\n');
  if (kind === 'slow') {
    for (let i = 0; i < 600; i++) {
      if (fs.existsSync(path.join(STATE, 'stops', o.name))) {
        fs.rmSync(path.join(STATE, 'stops', o.name), { force: true });
        process.exit(143);
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (kind === 'exit2') die('codex-security: Error: usage limit reached for this plan', 2);
  const scanId = 'stub-scan-1';
  const done = '2026-10-27T06:07:16Z';
  const findings = {
    documentType: 'codex-security.findings',
    schemaVersion: '1.0',
    scanId,
    findings: [
      {
        findingId: 'csf_stub_traversal',
        occurrenceId: 'o1',
        ruleId: 'path-traversal.local-file-read',
        identity: { anchor: 'a' },
        fingerprints: { algorithm: 'codex-security/v1', primary: 'fp-traversal' },
        title: 'HTTP clients can read files outside the public directory',
        summary: `A request path reaches the file system unchecked.${env.STUB_SCAN_TEXT ? ` ${env.STUB_SCAN_TEXT}` : ''}`,
        severity: { level: 'medium' },
        confidence: { level: 'high', rationale: 'r' },
        taxonomy: { category: 'path-traversal', cwe: ['CWE-22'] },
        locations: [{ path: '/input/repository/server.js', startLine: 6, endLine: 7 }, { path: '../../etc/passwd', startLine: 1 }],
        remediation: 'Resolve the path and refuse one outside the public folder.',
        validation: kind === 'reproduced-text' ? { status: 'not reproduced', summary: 'Codex Security reproduced it (it says)' } : { method: 'static source trace', status: 'validated', summary: 'No live server was tested' },
      },
      {
        findingId: 'csf_stub_crash',
        occurrenceId: 'o2',
        ruleId: 'uncaught-filesystem-error.http',
        identity: { anchor: 'b' },
        fingerprints: { algorithm: 'codex-security/v1', primary: 'fp-crash' },
        title: `A missing file request can stop the HTTP server${String.fromCodePoint(0x202e)}`, // (a bidi character the findings drop)
        summary: 'An error is not caught.',
        severity: { level: 'low' },
        confidence: { level: 'medium', rationale: 'r' },
        taxonomy: { category: 'dos', cwe: [] },
        locations: [{ path: 'server.js', startLine: 6 }],
        remediation: 'Catch it.',
        validation: null,
      },
    ],
  };
  const coverage = { documentType: 'codex-security.coverage', schemaVersion: '1.0', scanId, includePaths: ['.'], excludePaths: ['.git/**'], deferred: [], inventoryStrategy: '2 scoped files, all independently reviewed', surfaces: [] };
  const files = {
    'findings.json': kind === 'malformed' ? '{"documentType":"codex-security.findings","findings":"no"}' : JSON.stringify(findings),
    'coverage.json': JSON.stringify(coverage),
    'report.md': '# Report\n',
    'artifacts/01_context/threat_model.md': env.STUB_SCAN_THREAT ?? '# Threat model\nThe server serves files from public/ only.\n',
  };
  if (kind === 'deep-name') files['artifacts/a/b/c.md'] = 'deep\n';
  fs.mkdirSync(outDir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(outDir, rel)), { recursive: true });
    fs.writeFileSync(path.join(outDir, rel), text);
  }
  if (kind === 'unlisted') fs.writeFileSync(path.join(outDir, 'extra.sh'), 'echo stub\n');
  const listed = Object.keys(files).filter((r) => r !== 'report.md');
  if (kind === 'link') {
    fs.symlinkSync(path.join(os.tmpdir()), path.join(outDir, 'artifacts', 'link'));
    listed.push('artifacts/link');
  }
  const artifacts = listed.map((rel) => ({ path: rel, sha256: rel === 'artifacts/link' ? '0'.repeat(64) : sha(fs.readFileSync(path.join(outDir, rel))), mediaType: 'application/json' }));
  if (kind === 'broken-seal') artifacts[0].sha256 = '1'.repeat(64);
  const manifest = { documentType: 'codex-security.scan-manifest', schemaVersion: '1.0', scan: { id: scanId, producer: { name: 'codex-security', version: '0.7.0' }, status: 'completed', startedAt: '2026-10-27T06:02:58Z', completedAt: done, sealedAt: done, target: { kind: 'directory_snapshot', targetId: 't', displayName: 'repository', snapshotDigest: 'd' }, scope: { includePaths: ['.'], excludePaths: ['.git/**'] }, coverageRef: 'coverage.json', findingsRef: 'findings.json', artifacts } };
  fs.writeFileSync(path.join(outDir, 'scan-manifest.json'), JSON.stringify(manifest));
  process.stderr.write('\n  FINDINGS  2 (1 medium, 1 low)\n  TOKENS    160,071 uncached input, 3,265,408 cache reads, 0 cache writes, 19,397 output, 3,444,876 total\n');
  if (kind === 'exit2-sealed') die('codex-security: Error: target integrity check failed', 2);
  process.exit(0);
}
