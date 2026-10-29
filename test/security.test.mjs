// The security engineer (docs/design/security-engineer.md): its scan's checkout, with every file that steers an engine
// moved aside and every link taken out, and the lease that lets one scan run at a time on the PC. Fixtures stay harmless.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { processStartSync } from '../src/lib/proctree.mjs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ASIDE, asideName, findSteering, isEnvLike, leaseFile, leaseHolder, releaseLease, setAside, takeLease } from '../src/lib/securityscan.mjs';
import { createHash } from 'node:crypto';
import { DIGEST, REVISION, SECCOMP_FILE, SECCOMP_SHA256, imageRef, seccompProblem } from '../src/lib/securityimage.mjs';
import { PROBE_EXPECTED, accountKey, copyCreateArgs, helperArgs, loginArgs, memoryLimit, probeArgs, probeProblem, scanRunArgs, statArgs, statProblem, volumeCreateArgs, volumes } from '../src/lib/securityspec.mjs';
import { readCoverage, readFindings, readManifest, safePath, sealProblem, stateOf, unsafeName } from '../src/lib/findings.mjs';
import { draftSource, scannerTokens } from '../src/security.mjs';
import { POLICY_MAX, mayDraft, policyText, readPolicyState, threatModelOf } from '../src/lib/securitypolicy.mjs';
import { guardDir } from '../src/lib/guard.mjs';
import { client, request, startUi, stopUi } from './ui-helpers.mjs';
import { makeProject } from './helpers.mjs';

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

test('the pinned scanner: the image by its digest and the seccomp profile nextlevel ships, by its hash', () => {
  assert.equal(imageRef(), 'ghcr.io/openai/codex-security@sha256:a90bc3bf8b67ae1c1b046d7987bbfc0ed44dc869b938a393204ec62b5cce65fc');
  assert.equal(REVISION, 'f05a0b096cc881242ddf34a4d6b3ce0f322f3cf9');
  assert.equal(createHash('sha256').update(fs.readFileSync(SECCOMP_FILE)).digest('hex'), SECCOMP_SHA256, 'the shipped profile is the pinned one, byte for byte');
  assert.equal(seccompProblem(), '');
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'p.json'), `${fs.readFileSync(SECCOMP_FILE, 'utf8')}\n`);
    assert.match(seccompProblem(path.join(dir, 'p.json')), /isn't the pinned one/);
    assert.match(seccompProblem(path.join(dir, 'none.json')), /is missing/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the scan's docker line: read-only checkout and instructions, the scanner's own volumes, the pins, and nothing of the PC", () => {
  const vols = volumes({ projectKey: '0123456789abcdef', account: accountKey('work'), scanId: 'sec-20261027-061500-ab12' });
  assert.deepEqual(vols, { state: 'nextlevel-sec-state-0123456789abcdef', login: `nextlevel-sec-login-${accountKey('work')}`, out: 'nextlevel-sec-out-sec-20261027-061500-ab12' });
  assert.match(accountKey('work'), /^[0-9a-f]{16}$/, 'a hash, never a name');
  assert.notEqual(accountKey('work'), accountKey(''));
  const args = scanRunArgs({ id: 'sec-1', checkout: '/p.slots/security', kb: '/p.slots/security-kb', vols, seccomp: '/tool/docker/codex-security-seccomp.json', memory: '4g', model: 'gpt-6-sol', effort: 'xhigh', deep: false, daybreak: true, maxMinutes: 90 });
  const line = args.join(' ');
  assert.deepEqual(args.slice(0, 5), ['run', '--rm', '--init', '--name', 'nextlevel-scan-sec-1']);
  for (const want of ['--user 10001:10001', '--cap-drop ALL', '--security-opt no-new-privileges:true', '--security-opt seccomp=/tool/docker/codex-security-seccomp.json', '--pids-limit 2048', '--memory 4g',
    '--add-host host.docker.internal:127.0.0.255', '--add-host gateway.docker.internal:127.0.0.255',
    '--mount type=bind,source=/p.slots/security,target=/input/repository,readonly', '--mount type=bind,source=/p.slots/security-kb,target=/input/kb,readonly',
    `--mount type=volume,source=${vols.out},target=/output/scan`, `--mount type=volume,source=${vols.state},target=/output/.codex-security-state`, `--mount type=volume,source=${vols.login},target=/output/.codex-security-state/codex-home`]) assert.ok(line.includes(want), want);
  const after = args.slice(args.indexOf(imageRef()) + 1);
  assert.deepEqual(after, ['scan', '/input/repository', '--output-dir', '/output/scan', '--headless', '--auth', 'chatgpt', '--mode', 'standard', '--model', 'gpt-6-sol', '--effort', 'xhigh', '--cyber-access-program', 'daybreak_blue', '--codex', 'daybreak=true', '--codex', 'approval_policy="never"', '--codex', 'web_search="disabled"', '--scan-prompt-file', '/input/kb/role.md', '--max-time', '90']);
  // Nothing else of the PC: no env file, no variable copied from the host, no socket, no port, no other mount
  assert.ok(!args.some((a) => ['--env-file', '-e', '--env', '-p', '--publish', '-v', '--volume', '--privileged', '--network'].includes(a)), line);
  assert.ok(!line.includes('docker.sock'));
  assert.equal(args.filter((a) => a === '--mount').length, 5);
  // Daybreak off: no access program at all; deep: the deep mode; an approved policy: the knowledge base
  const plain = scanRunArgs({ id: 'sec-1', checkout: '/c', kb: '/k', policy: true, vols, seccomp: '/s', memory: '2g', model: 'm', deep: true, daybreak: false, maxMinutes: 240 });
  assert.ok(!plain.includes('--cyber-access-program') && !plain.includes('daybreak=true'));
  assert.ok(plain.join(' ').includes('--mode deep') && plain.join(' ').includes('--knowledge-base /input/kb/policy.md'));
  assert.deepEqual([memoryLimit(64 * 1024 ** 3), memoryLimit(6 * 1024 ** 3), memoryLimit(2 * 1024 ** 3)], ['8g', '3g', '2g']);
});

test("the volumes' helper, the copy-out's container and the probe: no network, no shell, never the real sign-in", () => {
  const vols = { state: 'st', login: 'lg', out: 'ou' };
  const chown = helperArgs('chown', vols, { seccomp: '/s' });
  assert.deepEqual(chown.slice(0, 4), ['run', '--rm', '--network', 'none']);
  assert.ok(chown.join(' ').includes('--user 0:0 --cap-drop ALL --cap-add CHOWN --cap-add FOWNER --security-opt no-new-privileges:true --security-opt seccomp=/s --pids-limit 16 --entrypoint chown'));
  assert.deepEqual(chown.slice(-4), ['10001:10001', '/v/state', '/v/login', '/v/out'], 'not recursive');
  assert.ok(!chown.includes('sh') && !chown.includes('-R'));
  assert.deepEqual(helperArgs('chmod', vols, { seccomp: '/s' }).slice(-4), ['700', '/v/state', '/v/login', '/v/out']);
  assert.ok(!helperArgs('chmod', vols, { seccomp: '/s', defaultSeccomp: true }).some((a) => a.startsWith('seccomp=')));
  const stat = statArgs(vols, { seccomp: '/s' });
  assert.ok(stat.join(' ').includes('--network none --user 10001:10001 --cap-drop ALL') && !stat.includes('--cap-add'));
  assert.equal(statProblem('10001:10001 700\n10001:10001 700\n10001:10001 700', vols), '');
  assert.match(statProblem('10001:10001 700\n10001:10001 777\n10001:10001 700', vols), /\/v\/login: 10001:10001 777, expected 10001:10001 700/);
  assert.match(statProblem('10001:10001 700', vols), /1 of 3 answers/);
  const create = copyCreateArgs('sec-1', vols, { seccomp: '/s' });
  assert.equal(create[0], 'create', 'created, never started');
  assert.ok(create.join(' ').includes('--network none') && create.join(' ').includes('type=volume,source=ou,target=/output/scan,readonly'));
  assert.equal(create.filter((a) => a === '--mount').length, 1);
  const probe = probeArgs('nextlevel-sec-probe-x', { seccomp: '/s', stateVolume: 'st' }).join(' ');
  assert.ok(probe.includes('source=nextlevel-sec-probe-x,target=/output/.codex-security-state/codex-home') && !probe.includes('nextlevel-sec-login-'));
  assert.ok(probe.includes(`permissions.nextlevel_probe.filesystem={":root"="read",":workspace_roots"="write","/output/.codex-security-state/codex-home"={"."="deny"}}`));
  assert.equal(probeProblem(PROBE_EXPECTED.join('\n')), '');
  assert.match(probeProblem('login-denied login-not-listable authfile-readable net-closed ip-closed'), /authfile-readable/);
  // (a name that doesn't resolve isn't enough: an address that answers fails it, and so does a missing answer)
  assert.match(probeProblem('login-denied login-not-listable authfile-denied net-closed ip-open'), /ip-open/);
  assert.match(probeProblem('login-denied login-not-listable authfile-denied net-closed'), /expected .*ip-closed/);
  assert.match(probeProblem(''), /answered nothing/);
  assert.ok(loginArgs({ state: 'st', login: 'lg' }, { seccomp: '/s' }).join(' ').endsWith('login --device-auth'));
  assert.deepEqual(volumeCreateArgs('lg', { kind: 'login', projectKey: 'k' }), ['volume', 'create', '--label', 'nextlevel.kind=login', 'lg'], "the sign-in's volume names no project");
});

test('findings: shape-checked, made safe, three states from exact values only; the seal and the copy-out names', () => {
  const doc = {
    documentType: 'codex-security.findings',
    scanId: 's',
    findings: [
      { findingId: 'csf_1', fingerprints: { primary: 'fp1' }, title: 'Path traversal\u202e in \u0007 the server', summary: 'Reads files. Token PLANTED-harmless-value-123 here.', severity: { level: 'high' }, locations: [{ path: '/input/repository/src/a.js', startLine: 3 }, { path: '../outside.txt', startLine: 1 }, { path: 'C:/x.txt', startLine: 1 }], remediation: 'fix', validation: { status: 'reproduced', method: 'ran a test' } },
      { findingId: 'csf_2', title: 'Text says reproduced', summary: 'Codex Security reproduced it', severity: { level: 'informational' }, locations: [], remediation: '', validation: { status: 'not validated', summary: 'reproduced' } },
      { findingId: 'csf_3', title: 'By source', severity: { level: 'low' }, locations: [], remediation: '', validation: { method: 'static source trace', status: 'validated' } },
      { findingId: 'bad id with spaces', title: 'x', severity: { level: 'low' } },
      { findingId: 'csf_4', title: 'No severity' },
      'not an object',
    ],
  };
  const r = readFindings(JSON.stringify(doc), { values: ['PLANTED-harmless-value-123'], names: [] });
  assert.deepEqual(r.findings.map((f) => [f.id, f.severity, f.validation.state]), [['csf_1', 'high', 'reproduced'], ['csf_3', 'low', 'source'], ['csf_2', 'info', 'none']]);
  const f = r.findings[0];
  assert.equal(f.title, 'Path traversal  in   the server', 'control and bidi characters dropped');
  assert.doesNotMatch(f.what, /PLANTED/, 'a .env value redacted');
  assert.deepEqual(f.where, [{ path: 'src/a.js', line: 3, end: null }], 'paths outside the checkout dropped, never read');
  assert.equal(f.key, 'fp1');
  assert.equal(r.findings[2].key, 'csf_2', 'no fingerprint: its id');
  assert.equal(stateOf({ summary: 'reproduced' }), 'none', 'free text never upgrades a finding');
  assert.equal(stateOf(null), 'none');
  assert.match(readFindings('{"documentType":"x"}').problem, /isn't the scanner's/);
  assert.match(readFindings('not json').problem, /not JSON/);
  assert.deepEqual([safePath('a/../b'), safePath('/etc/passwd'), safePath('ok/x.js')], ['', '', 'ok/x.js']);
  // The manifest and the seal
  const files = { 'findings.json': 'a'.repeat(64), 'coverage.json': 'b'.repeat(64) };
  const manifest = (scan) => JSON.stringify({ documentType: 'codex-security.scan-manifest', scan: { id: 's', status: 'completed', completedAt: 't', sealedAt: 't', findingsRef: 'findings.json', coverageRef: 'coverage.json', artifacts: Object.entries(files).map(([p, h]) => ({ path: p, sha256: h })), ...scan } });
  const m = readManifest(manifest({})).manifest;
  assert.equal(sealProblem(m, files), '');
  assert.match(sealProblem(m, { ...files, 'findings.json': 'c'.repeat(64) }), /a sealed file changed \(findings\.json\)/);
  assert.match(sealProblem(m, { 'findings.json': files['findings.json'] }), /a sealed file is missing \(coverage\.json\)/);
  assert.match(sealProblem(readManifest(manifest({ sealedAt: 'other' })).manifest, files), /aren't sealed/);
  assert.match(sealProblem(readManifest(manifest({ status: 'interrupted' })).manifest, files), /didn't complete \(interrupted\)/);
  assert.match(readManifest(manifest({ artifacts: [{ path: '../x', sha256: 'a'.repeat(64) }] })).problem, /unsafe name/);
  assert.match(readManifest(manifest({ artifacts: [{ path: 'a.json' }] })).problem, /without its sha256/);
  for (const bad of ['../x', '/abs', 'C:\\x', 'a\\b', 'con', 'a/b/c/d.json', 'x ', 'a//b']) assert.ok(unsafeName(bad), bad);
  for (const good of ['findings.json', 'artifacts/01_context/threat_model.md']) assert.equal(unsafeName(good), '', good);
  assert.deepEqual(readCoverage('{"deferred":["a"]}').partial, true);
  // The scanner's own usage line
  assert.deepEqual(scannerTokens('x\n  TOKENS    160,071 uncached input, 3,265,408 cache reads, 0 cache writes, 19,397 output, 3,444,876 total\n'), { tokens: 179468, cached: 3265408, input: 160071, output: 19397 });
  assert.equal(scannerTokens('no usage'), null);
  assert.deepEqual([isEnvLike('.env'), isEnvLike('apps/web/.env.local'), isEnvLike('prod.env'), isEnvLike('.env.example'), isEnvLike('env.md')], [true, true, true, false, false]);
});

// ---------- a scan end to end, with the stub scanner (test/stubs/fake-docker.mjs) ----------
function secProject() {
  const p = makeProject();
  p.setConfig((c) => ({ ...c, roles: { ...c.roles, security: { engine: 'codex', model: 'gpt-6-sol', effort: '', profile: '', daybreak: true } } }));
  fs.writeFileSync(path.join(p.repo, 'server.js'), 'harmless\n');
  for (const rel of ['.claude/settings.json', 'packages/api/SECURITY.md', 'AGENTS.override.md']) put(p.repo, rel, 'harmless steering\n');
  fs.writeFileSync(path.join(p.repo, '.env'), 'NTFY_TOPIC=PLANTED-harmless-value-123\n');
  p.git('add', '-A'); // (.env is ignored)
  p.git('commit', '-qm', 'code');
  const login = p.hub(['security', 'login']);
  assert.equal(login.code, 0, login.out);
  return p;
}
const seenRuns = (p) => {
  try {
    return fs.readFileSync(path.join(p.env.HOME, '.fake-docker', 'seen.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
function scanOnce(p, env = {}, { deep = false } = {}) {
  const asked = p.hub(['security', 'scan', ...(deep ? ['--deep'] : [])]);
  assert.equal(asked.code, 0, asked.out);
  const id = asked.out.match(/\((sec-[\w-]+)\)/)[1];
  const run = p.runUntilIdle([], { extraEnv: env });
  const scan = JSON.parse(fs.readFileSync(p.state('security', 'scans', id, 'scan.json'), 'utf8'));
  return { id, scan, run };
}

test('a scan end to end: asked by the owner, run by the hub in the scanner, its findings sealed, counted, and no job or round', () => {
  const p = secProject();
  try {
    const { id, scan } = scanOnce(p);
    assert.equal(scan.state, 'done', scan.why);
    assert.equal(scan.trusted, true);
    assert.equal(scan.counts, '1 medium, 1 low');
    assert.equal(scan.commit, p.git('rev-parse', 'main'));
    assert.equal(scan.daybreak, 'asked for, not confirmed by the scanner');
    assert.deepEqual(scan.image, { version: '0.7.0', digest: DIGEST, revision: REVISION });
    // What the scanner saw: the code, the steering files only as plain text aside, no .env
    const scanRun = seenRuns(p).find((r) => !r.entrypoint && r.args.includes('scan') && !r.args.includes('--dry-run'));
    assert.ok(scanRun.files.includes('server.js'));
    for (const rel of ['.claude/settings.json', 'packages/api/SECURITY.md', 'AGENTS.override.md', 'AGENTS.md', '.env']) assert.ok(!scanRun.files.includes(rel), `${rel} not where an engine loads it`);
    assert.ok(scanRun.files.some((f) => /^\.nextlevel-scan\/steering\/\d{3}-\.claude__settings\.json\.txt$/.test(f)));
    assert.ok(scanRun.args.includes('web_search="disabled"') && scanRun.args.includes('approval_policy="never"'));
    // Before it: the dry run in an output volume of its own, the helper with no network
    assert.ok(seenRuns(p).some((r) => r.args.includes('--dry-run') && r.args.join(' ').includes(`nextlevel-sec-out-${id}-dry`)));
    assert.ok(seenRuns(p).filter((r) => r.entrypoint === 'chown').every((r) => r.args.includes('none')));
    // Its findings: made safe, and counted only while they match the hub's record outside the project
    const findings = JSON.parse(fs.readFileSync(p.state('security', 'scans', id, 'findings.json'), 'utf8')).findings;
    assert.deepEqual(findings.map((f) => [f.id, f.severity, f.validation.state]), [['csf_stub_traversal', 'medium', 'source'], ['csf_stub_crash', 'low', 'none']]);
    assert.deepEqual(findings[0].where, [{ path: 'server.js', line: 6, end: 7 }]);
    assert.doesNotMatch(findings[1].title, /\u202e/);
    const status = p.hub(['security', 'status']);
    assert.match(status.out, new RegExp(`${id}  done, 0 min, 1 medium, 1 low`));
    assert.match(status.out, /csf_stub_traversal  medium +HTTP clients can read files outside the public directory \(validated by source\)/);
    const json = JSON.parse(p.hub(['security', 'status', '--json']).out);
    assert.equal(json.last.id, id);
    // The usage ledger: a Security engineer line with the scanner's tokens
    const month = fs.readdirSync(p.state('usage'))[0];
    const line = fs.readFileSync(p.state('usage', month), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.role === 'security');
    assert.equal(line.reason, 'scan');
    assert.equal(line.tokens.total, 179468);
    // Not a job, and the output volume is gone; the state and sign-in stay
    assert.ok(!fs.existsSync(p.state('jobs')) || !fs.readdirSync(p.state('jobs')).length);
    const vols = fs.readdirSync(path.join(p.env.HOME, '.fake-docker', 'volumes'));
    assert.ok(!vols.some((v) => v.startsWith('nextlevel-sec-out-')), vols.join(' '));
    assert.ok(vols.some((v) => v.startsWith('nextlevel-sec-login-')) && vols.some((v) => v.startsWith('nextlevel-sec-state-')));
    // The lease is given back
    assert.ok(!fs.existsSync(path.join(p.env.HOME, '.nextlevel', 'security-lease.json')));
    // A findings file changed after the scan (anything in the project can write there) no longer counts
    const file = p.state('security', 'scans', id, 'findings.json');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('medium', 'low'));
    const after = p.hub(['security', 'status']).out;
    assert.match(after, new RegExp(`${id}  done.*its findings file changed after the scan: not trusted`));
    assert.doesNotMatch(after, /Findings of/);
  } finally {
    p.cleanup();
  }
});

test("a scan's output that doesn't hold is never trusted: a broken seal, a link, a malformed file, an unsafe name", () => {
  const p = secProject();
  const kept = [];
  try {
    for (const [kind, want] of [['broken-seal', /a sealed file changed/], ['link', /isn't a plain file/], ['malformed', /findings file isn't the scanner's/], ['deep-name', /more than two folders deep/]]) {
      const { id, scan } = scanOnce(p, { STUB_SCAN: kind });
      assert.equal(scan.state, 'failed', `${kind}: ${scan.why}`);
      assert.ok(!scan.trusted, kind);
      assert.match(scan.why, want, kind);
      // The output volume is kept as the evidence (V3), and a refused copy leaves nothing on the PC
      assert.equal(scan.keptOutput, `nextlevel-sec-out-${id}`, kind);
      if (kind !== 'malformed') assert.ok(!fs.existsSync(p.state('security', 'scans', id, 'raw')), `${kind}: what it copied is removed`);
      kept.push(scan.keptOutput);
    }
    const status = p.hub(['security', 'status']).out;
    assert.doesNotMatch(status, /Findings of/, 'no trusted scan, no findings shown');
    assert.match(status, new RegExp(`its output kept in the Docker volume ${kept[0]}; docker volume rm ${kept[0]} removes it`));
    // Each hub's start removes the output volumes no scan holds, never a kept one (four hubs have started by now)
    const vols = fs.readdirSync(path.join(p.env.HOME, '.fake-docker', 'volumes'));
    for (const v of kept) assert.ok(vols.includes(v), v);
  } finally {
    p.cleanup();
  }
});

test("a scan stops before it runs on what it can't trust: the volumes, the probe, the settings, a tracked secrets file, the role off", () => {
  const p = secProject();
  try {
    const scanRuns = () => seenRuns(p).filter((r) => !r.entrypoint && r.args.includes('scan') && !r.args.includes('--dry-run')).length;
    const cases = [
      [{ STUB_DOCKER_PERMS: '777' }, /isn't the scanner's alone/],
      [{ STUB_DOCKER_DRYRUN: 'refuse' }, /refused its settings \(web search off, approvals never\)/],
      [{ STUB_DOCKER_OS: 'windows' }, /needs Linux containers/],
      // (Docker's API on TCP, whatever the setting says: delta 1's stop rule, at the scan's own start too)
      [{ NEXTLEVEL_TEST_DOCKER_API: '2376' }, /Docker's API answers on 127\.0\.0\.1:2376: any program on this PC, a scanned project's included, could drive Docker: no scan runs/],
    ];
    for (const [env, want] of cases) {
      const { scan } = scanOnce(p, env);
      assert.equal(scan.state, 'couldnt', JSON.stringify(env));
      assert.match(scan.why, want);
    }
    assert.equal(scanRuns(), 0, 'no scan started');
    // The probe, kept for the image: a leaky answer stops every scan with it (a fresh doctor run asks again)
    fs.rmSync(p.state('check-cache.json'), { force: true });
    const leaky = scanOnce(p, { STUB_DOCKER_PROBE: 'login-readable login-listable authfile-readable net-open' }).scan;
    assert.match(leaky.why, /sandbox didn't hold/);
    fs.rmSync(p.state('check-cache.json'), { force: true });
    // A tracked file that looks like a secrets file: the scan never starts, and the file is never opened
    put(p.repo, 'config/.env.production', 'harmless\n');
    p.git('add', '-f', 'config/.env.production');
    p.git('commit', '-qm', 'oops');
    const env = scanOnce(p).scan;
    assert.equal(env.state, 'couldnt');
    assert.match(env.why, /a tracked file looks like a secrets file \(config\/\.env\.production\)/);
    assert.equal(scanRuns(), 0);
    p.git('rm', '-q', 'config/.env.production');
    p.git('commit', '-qm', 'fixed');
    // Off: nothing is asked
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, security: { ...c.roles.security, engine: '' } } }));
    const off = p.hub(['security', 'scan']);
    assert.equal(off.code, 1);
    assert.match(off.out, /The security engineer is off/);
  } finally {
    p.cleanup();
  }
});

test("a scan's end: a scanner error says so with its words, a stop is partial, a planted .env value never reaches the findings", async () => {
  const p = secProject();
  try {
    const err = scanOnce(p, { STUB_SCAN: 'exit2' }).scan;
    assert.equal(err.state, 'couldnt');
    assert.match(err.why, /ended with exit 2: .*usage limit reached/);
    // Exit 2 after a whole, sealed output: the scanner's own integrity failure, never trusted (its findings unshown)
    const sealed2 = scanOnce(p, { STUB_SCAN: 'exit2-sealed' });
    assert.equal(sealed2.scan.state, 'couldnt');
    assert.equal(sealed2.scan.trusted, false);
    assert.match(sealed2.scan.why, /ended with exit 2: .*target integrity check failed/);
    assert.equal(JSON.parse(p.hub(['security', 'status', '--json']).out).last, null);
    const planted = scanOnce(p, { STUB_SCAN_TEXT: 'the value is PLANTED-harmless-value-123' });
    assert.equal(planted.scan.state, 'done');
    const text = fs.readFileSync(p.state('security', 'scans', planted.id, 'findings.json'), 'utf8');
    assert.doesNotMatch(text, /PLANTED-harmless-value-123/);
    assert.match(text, /the value is \*\*\*/);
    // The vendored profile refuses the helper's chown on this PC: the helper alone runs with Docker's default, and the
    // hub's log says which one it used (delta 2, V2); the scan keeps the vendored one
    const before = seenRuns(p).length;
    const eperm = scanOnce(p, { STUB_DOCKER_CHOWN: 'eperm' });
    assert.equal(eperm.scan.state, 'done', eperm.scan.why);
    const runs = seenRuns(p).slice(before);
    const chowns = runs.filter((r) => r.entrypoint === 'chown');
    assert.ok(chowns.some((r) => r.args.some((a) => a.startsWith('seccomp='))) && chowns.at(-1).args.every((a) => !a.startsWith('seccomp=')), 'tried with the vendored profile, then without');
    assert.ok(runs.filter((r) => r.entrypoint === 'chmod').every((r) => r.args.every((a) => !a.startsWith('seccomp='))));
    assert.ok(runs.find((r) => !r.entrypoint && r.args.includes('scan') && !r.args.includes('--dry-run')).args.some((a) => a.startsWith('seccomp=') && a.endsWith('codex-security-seccomp.json')));
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), new RegExp(`security scan ${eperm.id}: the volumes' helper ran with Docker's default seccomp profile \\(the pinned one refused chown\\)`));
    // Stopped by the owner while it runs: its container stopped, its record stopped and partial
    const asked = p.hub(['security', 'scan']);
    const id = asked.out.match(/\((sec-[\w-]+)\)/)[1];
    const hub = p.hubInBackground(['run', '--exit-when-idle', '--tick-ms', '200'], { STUB_SCAN: 'slow' });
    const file = p.state('security', 'scans', id, 'scan.json');
    const { waitUntil } = await import('./helpers.mjs');
    await waitUntil('the scan to run', () => fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).state === 'running');
    assert.equal(p.hub(['security', 'stop']).code, 0);
    await waitUntil('the scan to stop', () => JSON.parse(fs.readFileSync(file, 'utf8')).state === 'stopped');
    await new Promise((r) => hub.once('exit', r));
    const s = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(s.why, 'stopped by the owner');
    assert.equal(s.partial, true);
    assert.ok(fs.readdirSync(path.join(p.env.HOME, '.fake-docker', 'stops')).length === 0, 'docker stop reached the container');
  } finally {
    p.cleanup();
  }
});

test("who may scan: the owner's commands refuse in an agent's session, status is a look the advisor may run", () => {
  const p = secProject();
  try {
    for (const env of [{ NEXTLEVEL_AGENT: 'orchestrator' }, { NEXTLEVEL_TASK_ID: 'T1' }]) {
      const r = p.hub(['security', 'scan'], { extraEnv: env });
      assert.equal(r.code, 1);
      assert.match(r.out, /nextlevel security scan is the owner's, so it doesn't run in an agent's session/);
    }
    assert.ok(!fs.existsSync(path.join(p.env.HOME, '.nextlevel', 'guard')) || !fs.readdirSync(path.join(p.env.HOME, '.nextlevel', 'guard')).some((d) => fs.existsSync(path.join(p.env.HOME, '.nextlevel', 'guard', d, 'security-requests')) && fs.readdirSync(path.join(p.env.HOME, '.nextlevel', 'guard', d, 'security-requests')).length), 'nothing asked');
    assert.equal(p.hub(['security', 'status'], { extraEnv: { NEXTLEVEL_READ_ONLY: '1' } }).code, 0);
    const ro = p.hub(['security', 'scan'], { extraEnv: { NEXTLEVEL_READ_ONLY: '1' } });
    assert.match(ro.out, /refused\. This is a read-only session/);
    // The scan's own session runs no nextlevel at all
    assert.match(p.hub(['security', 'status'], { extraEnv: { NEXTLEVEL_AGENT: 'security' } }).out, /nextlevel doesn't run in the security engineer's scan/);
    // Nor can an agent start the hub's own scan process with no ask from the owner
    const runsBefore = seenRuns(p).length;
    const direct = p.hub(['_scan', Buffer.from(JSON.stringify({ id: 'sec-20261027-080000-abcd' })).toString('base64url')], { extraEnv: { NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_ROOT: p.repo } }); // (as an agent that knows how the hub calls it)
    assert.equal(direct.code, 1);
    assert.match(direct.out, /nextlevel _scan is the owner's, so it doesn't run in an agent's session \(this is the orchestrator's window\)/);
    assert.equal(seenRuns(p).length, runsBefore, 'no docker run');
    assert.ok(!fs.existsSync(p.state('security', 'scans', 'sec-20261027-080000-abcd')));
    // The sign-in waits for a scan that runs (one writer of the sign-in volume at a time)
    const lease = path.join(p.env.HOME, '.nextlevel', 'security-lease.json');
    fs.mkdirSync(path.dirname(lease), { recursive: true });
    fs.writeFileSync(lease, JSON.stringify({ root: '/elsewhere/other-project', pid: process.pid, start: processStartSync(process.pid), scan: 'sec-20261027-070000-beef' }));
    const busy = p.hub(['security', 'login']);
    assert.equal(busy.code, 1);
    assert.match(busy.out, /Can't sign in now: a security scan runs \(in other-project\)/);
    assert.ok(!seenRuns(p).slice(runsBefore).some((r) => r.args.includes('login')), 'no sign-in container');
    fs.rmSync(lease);
    assert.equal(p.hub(['security', 'login']).code, 0);
    assert.ok(!fs.existsSync(lease), 'the sign-in gives the lease back');
  } finally {
    p.cleanup();
  }
});

test('a security engineer on a named profile: its sign-in is that account\'s, and turning it on says how to make it', () => {
  const p = makeProject();
  try {
    p.setConfig((c) => ({ ...c, profiles: { ...(c.profiles || {}), work: { engine: 'codex', account: 'work', model: '', effort: '' }, gem: { engine: 'agy', account: '', model: '', effort: '' } } }));
    const team = (args) => JSON.parse(p.hub(['team', 'set', 'security', ...args, '--json']).out);
    const early = team(['--profile', 'work', '--daybreak', 'on']);
    assert.equal(early.saved, false, early.message);
    const r = p.hub(['team', 'set', 'security', '--profile', 'work', '--daybreak', 'on']);
    assert.match(r.out, /nextlevel security login --profile work/);
    // Only a Codex profile of nextlevel.json; then its own volume, apart from the unnamed account's
    assert.match(p.hub(['security', 'login', '--profile', 'nope']).out, /Can't sign in: "nope" isn't a Codex profile in nextlevel\.json/);
    assert.match(p.hub(['security', 'login', '--profile', 'gem']).out, /isn't a Codex profile/);
    assert.equal(p.hub(['security', 'login', '--profile', 'work']).code, 0);
    const vols = fs.readdirSync(path.join(p.env.HOME, '.fake-docker', 'volumes'));
    assert.ok(vols.includes(`nextlevel-sec-login-${accountKey('work')}`) && !vols.includes(`nextlevel-sec-login-${accountKey('')}`), vols.join(' '));
    const on = team(['--profile', 'work', '--daybreak', 'on']);
    assert.equal(on.saved, true, on.message);
  } finally {
    p.cleanup();
  }
});

test("Docker's API on TCP: the first port that answers on 127.0.0.1, never a real one under the tests' stubs", async () => {
  const { EventEmitter } = await import('node:events');
  const { apiPortOpen } = await import('../src/lib/securityrun.mjs');
  const asked = [];
  const connect = (open) => ({ host, port }) => {
    asked.push(`${host}:${port}`);
    const s = new EventEmitter();
    s.setTimeout = () => {};
    s.destroy = () => {};
    setImmediate(() => (open.includes(port) ? s.emit('connect') : s.emit('error', new Error('ECONNREFUSED'))));
    return s;
  };
  assert.equal(await apiPortOpen({ connect: connect([2376]), env: {} }), 2376);
  assert.equal(await apiPortOpen({ connect: connect([]), env: {} }), 0);
  assert.deepEqual([...new Set(asked)].sort(), ['127.0.0.1:2375', '127.0.0.1:2376']);
  asked.length = 0;
  assert.equal(await apiPortOpen({ connect: connect([2375]), env: { NEXTLEVEL_TEST_STUBS: '1' } }), 0);
  assert.equal(await apiPortOpen({ connect: connect([]), env: { NEXTLEVEL_TEST_STUBS: '1', NEXTLEVEL_TEST_DOCKER_API: '2375' } }), 2375);
  assert.deepEqual(asked, [], 'no port tried under the stubs');
});

// ---------- the policy (1a-2): a text the owner approves on a card, then every scan reads it ----------
const policyHeld = (p) => {
  const f = path.join(guardDir(p.repo, p.env.HOME), 'held.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')).items.filter((x) => x.kind === 'policy') : [];
};
const policyKept = (p) => readPolicyState(fs.existsSync(path.join(guardDir(p.repo, p.env.HOME), 'security-policy.json')) ? fs.readFileSync(path.join(guardDir(p.repo, p.env.HOME), 'security-policy.json'), 'utf8') : '');
const blobOf = (p, hash) => fs.readFileSync(path.join(guardDir(p.repo, p.env.HOME), 'blobs', hash), 'utf8');
const RLO = String.fromCodePoint(0x202e); // (a bidi character, made from its code point: Trojan Source)
const scanSaw = (p) => seenRuns(p).filter((r) => !r.entrypoint && r.args.includes('scan') && !r.args.includes('--dry-run')).at(-1);

test('the policy, pure: the safe text alone (no header), a threat model by name, the kept state through a shape check, when a draft may come', () => {
  const secrets = { values: ['PLANTED-harmless-value-123'], names: [] };
  const t = policyText(`# Rules\nToken PLANTED-harmless-value-123 here${RLO} and\u0007 there\n`, secrets);
  assert.doesNotMatch(t.text, new RegExp(`PLANTED|${RLO}|\u0007`));
  assert.match(t.text, /^# Rules\n/, 'no header line: the same text is the same policy whatever its commit (P1)');
  assert.equal(t.hash, createHash('sha256').update(t.text).digest('hex'));
  assert.equal(policyText('same', secrets).hash, policyText('same', secrets).hash);
  const big = policyText('x'.repeat(POLICY_MAX * 2), secrets);
  assert.ok(big.cut > 0 && big.text.length <= POLICY_MAX && /\(cut: \d+ more characters\)\n$/.test(big.text));
  assert.equal(policyText('  \n ', secrets).text, '');
  assert.equal(threatModelOf({ 'findings.json': 'a', 'threatmodel.md': 'b', 'artifacts/01_context/threat_model.md': 'c' }), 'threatmodel.md');
  assert.equal(threatModelOf({ 'artifacts/01_context/threat_model.md': 'c' }), 'artifacts/01_context/threat_model.md');
  assert.equal(threatModelOf({ 'report.md': 'r' }), '');
  const ok = readPolicyState(JSON.stringify({ approved: { hash: 'a'.repeat(64), from: 'draft', scan: 'sec-1', commit: 'b'.repeat(40), at: 't' }, draftAgain: true }));
  assert.equal(ok.approved.hash, 'a'.repeat(64));
  assert.equal(ok.draftAgain, true);
  assert.equal(readPolicyState(JSON.stringify({ approved: { hash: 'not-a-hash', from: 'draft' }, draftAgain: 'yes' })).approved, null, "a field that isn't its type is dropped");
  assert.equal(readPolicyState('not json').approved, null);
  // A draft (P8): none waiting; never approved and none rejected since the owner asked, or the owner asked
  const none = readPolicyState('');
  assert.equal(mayDraft(none, { pending: false }), true);
  assert.equal(mayDraft(none, { pending: true }), false);
  assert.equal(mayDraft({ ...none, rejectedDraftAt: 't' }, { pending: false }), false);
  assert.equal(mayDraft({ ...none, approved: ok.approved }, { pending: false }), false);
  assert.equal(mayDraft({ ...none, approved: ok.approved, draftAgain: true }, { pending: false }), true);
});

test("a policy end to end: a trusted scan's draft on a card, approved on the dashboard, then exactly that text is every scan's knowledge base; nothing in the project changes", async () => {
  const p = secProject();
  let ui;
  try {
    // The first trusted scan drafts one from its threat model: made safe, kept as a blob, on a card
    const first = scanOnce(p, { STUB_SCAN_THREAT: `# Threat model\nThe server serves public/ only.\nA token: PLANTED-harmless-value-123${RLO}\n` });
    assert.equal(first.scan.state, 'done', first.scan.why);
    const [draft] = policyHeld(p);
    assert.equal(draft.status, 'held');
    assert.equal(draft.source, 'draft');
    assert.equal(draft.scan, first.id);
    assert.equal(draft.commit, p.git('rev-parse', 'main'));
    const text = blobOf(p, draft.hash);
    assert.match(text, /^# Threat model\nThe server serves public\/ only\./);
    assert.doesNotMatch(text, new RegExp(`PLANTED|${RLO}`), 'redacted, no bidi character');
    assert.ok(draft.card && JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items.some((x) => x.id === draft.card && x.guard === draft.id));
    assert.equal(first.scan.policy, '', 'that scan read no policy');
    assert.ok(!scanSaw(p).args.includes('--knowledge-base') && scanSaw(p).policy === null);
    // A second scan while it waits drafts nothing more
    scanOnce(p);
    assert.equal(policyHeld(p).length, 1);

    ui = await startUi(p);
    const c = client(ui);
    const page = (await c.get('/api/security')).json;
    assert.equal(page.policy.approved, null);
    assert.deepEqual(page.policy.pending.map((x) => x.id), [draft.id]);
    assert.equal(page.last.findings[0].id, 'csf_stub_traversal');
    assert.equal(page.last.findings[0].fix, 'Resolve the path and refuse one outside the public folder.');
    const g = (await c.get('/api/cards')).json.guard.find((x) => x.id === draft.id);
    assert.equal(g.kind, 'policy');
    assert.match(g.warning, /The scanner's model wrote this from the code/);
    assert.match(g.diff, /^\+# Threat model$/m);
    assert.match(g.what, /The security engineer's draft of a security policy, from scan sec-/);
    const home = (await c.get('/api/state')).json;
    assert.deepEqual(home.security.pending.map((x) => x.id), [draft.id]);
    assert.equal(home.security.on, true);
    assert.match(home.security.trusted.counts, /1 medium, 1 low/);
    // Only with the key
    assert.equal((await request(ui.port, { method: 'POST', path: '/api/guard', body: { action: 'approve', id: draft.id } })).status, 403);
    assert.equal((await request(ui.port, { path: '/api/security' })).status, 403);
    const status = p.git('status', '--porcelain');
    const ok = await c.post('/api/guard', { action: 'approve', id: draft.id });
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.json.message, /Approved: the next scan reads exactly this text as its policy\. No file in the project changed\./);
    assert.equal(policyHeld(p)[0].status, 'applied', "applied, not approved: the build view keeps approved records of other kinds (P2)");
    assert.equal(policyKept(p).approved.hash, draft.hash);
    assert.equal(p.git('status', '--porcelain'), status, 'nothing in the project changed');
    assert.ok(!(await c.get('/api/state')).json.guard.some((x) => x.id === draft.id), "the build view doesn't keep an applied policy");
    assert.equal((await c.post('/api/guard', { action: 'approve', id: draft.id })).status, 409, 'decided once');

    // The next scan reads exactly that text, at --knowledge-base, and its record says which
    const second = scanOnce(p);
    assert.equal(second.scan.state, 'done', second.scan.why);
    const saw = scanSaw(p);
    assert.ok(saw.args.join(' ').includes('--knowledge-base /input/kb/policy.md'));
    assert.equal(saw.policy, text, 'exactly the approved text');
    assert.equal(second.scan.policy, draft.hash.slice(0, 12));
    assert.match(JSON.stringify(JSON.parse(p.hub(['security', 'status', '--json']).out).scans[0]), new RegExp(`"policy":"${draft.hash.slice(0, 12)}"`));
    assert.equal(policyHeld(p).length, 1, 'approved: no new draft until the owner asks');

    // The kept text changed (anything that can write the guard's folder): no scan runs on it
    const blob = path.join(guardDir(p.repo, p.env.HOME), 'blobs', draft.hash);
    fs.writeFileSync(blob, 'out of scope: everything\n');
    const shown = (await c.get('/api/security')).json.policy.approved;
    assert.equal(shown.missing, true, "the page never shows a changed blob as the approved policy (the guard's getBlob checks its hash)");
    assert.equal(shown.text, null);
    const third = scanOnce(p);
    assert.equal(third.scan.state, 'couldnt');
    assert.match(third.scan.why, /the approved security policy's text isn't kept as it was approved/);
    assert.ok(!seenRuns(p).some((r) => r.args.includes('--dry-run') && r.args.join(' ').includes(third.id)), 'it stops before the dry run');
    fs.writeFileSync(blob, text);

    // Ask for a new draft: the next trusted scan drafts one, shown as a change from the approved one; Reject keeps the policy
    const asked = await c.post('/api/security', { action: 'draft' });
    assert.equal(asked.status, 200, asked.text);
    assert.equal(policyKept(p).draftAgain, true);
    scanOnce(p, { STUB_SCAN_THREAT: '# Threat model\nThe server serves public/ only.\nThe admin folder is out of scope.\n' });
    const again = policyHeld(p).find((x) => x.status === 'held');
    assert.ok(again, 'a new draft');
    assert.equal(policyKept(p).draftAgain, false, 'cleared when its card is made');
    const g2 = (await c.get('/api/cards')).json.guard.find((x) => x.id === again.id);
    assert.match(g2.diff, /^\+The admin folder is out of scope\.$/m);
    assert.doesNotMatch(g2.diff, /^\+The server serves public/m, 'a change from the approved policy');
    const no = await c.post('/api/guard', { action: 'reject', id: again.id, reason: 'not out of scope' });
    assert.equal(no.status, 200, no.text);
    assert.match(no.json.message, /Rejected: the policy stays as it was, and this text never comes back/);
    assert.doesNotMatch(no.json.message, /orchestrator|task/i);
    assert.equal(policyKept(p).approved.hash, draft.hash, 'the policy stays');
    assert.ok(policyKept(p).rejectedDraftAt);
    // The same text asked for again never comes back
    await c.post('/api/security', { action: 'draft' });
    scanOnce(p, { STUB_SCAN_THREAT: '# Threat model\nThe server serves public/ only.\nThe admin folder is out of scope.\n' });
    assert.equal(policyHeld(p).filter((x) => x.status === 'held').length, 0);

    // Home's buttons: a scan, a deep scan, stop, all the owner's through the key
    const s = await c.post('/api/security', { action: 'scan' });
    assert.equal(s.status, 200, s.text);
    assert.match(s.json.message, /Asked for a scan \(sec-/);
    assert.equal((await c.get('/api/state')).json.security.last.state, 'asked');
    const stop = await c.post('/api/security', { action: 'stop' });
    assert.match(stop.json.message, /Took back the ask for sec-/);
    assert.equal((await c.post('/api/security', { action: 'nope' })).status, 400);
    assert.equal((await request(ui.port, { method: 'POST', path: '/api/security', body: { action: 'scan' } })).status, 403);
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
});

test("the project's SECURITY.md as a policy: the base branch's root file only, one card per text whatever its commit, a changed text closes the older card", () => {
  const p = secProject();
  try {
    // (no draft in this test: a waiting policy card keeps the drafts out)
    put(p.repo, 'SECURITY.md', '# Policy\nReport issues privately.\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'policy');
    scanOnce(p);
    const cards = () => policyHeld(p).filter((x) => x.source === 'SECURITY.md');
    assert.equal(cards().length, 1);
    const [first] = cards();
    assert.equal(first.commit, p.git('rev-parse', 'main'));
    assert.equal(blobOf(p, first.hash), '# Policy\nReport issues privately.\n');
    // The same text at a new commit: no new card (P1)
    put(p.repo, 'other.js', 'harmless\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'other');
    scanOnce(p);
    assert.equal(cards().length, 1);
    // A changed text: a new card, and the older one is closed by nextlevel
    put(p.repo, 'SECURITY.md', '# Policy\nReport issues privately, within 90 days.\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'policy 2');
    scanOnce(p);
    assert.deepEqual(cards().map((x) => x.status), ['superseded', 'held']);
    assert.match(cards()[0].detail, /SECURITY\.md changed again/);
    const handoff = JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items;
    assert.equal(handoff.find((x) => x.guard === first.id).closedBy, 'hub');
    // Not a regular file at the root (a link), or only a nested one: no card (P6)
    const q = secProject();
    try {
      put(q.repo, 'packages/api/SECURITY.md', '# nested\n');
      fs.symlinkSync('README.md', path.join(q.repo, 'SECURITY.md'));
      q.git('add', '-A');
      q.git('commit', '-qm', 'link');
      scanOnce(q);
      assert.ok(!policyHeld(q).some((x) => x.source === 'SECURITY.md'));
      assert.match(fs.readFileSync(q.state('logs', 'hub.log'), 'utf8'), /SECURITY\.md on main isn't a regular file: no card/);
    } finally {
      q.cleanup();
    }
  } finally {
    p.cleanup();
  }
});

test("a draft comes only from the threat model the hub's record lists, unchanged since the copy-out (it isn't in the scanner's seal)", () => {
  const p = secProject();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  try {
    // (a SECURITY.md card waits, so the scan drafts nothing by itself)
    put(p.repo, 'SECURITY.md', '# Policy\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'policy');
    const { id } = scanOnce(p);
    assert.ok(!policyHeld(p).some((x) => x.source === 'draft'));
    Object.assign(process.env, { HOME: p.env.HOME, USERPROFILE: p.env.USERPROFILE || p.env.HOME });
    const src = draftSource(p.repo, p.state(), id);
    assert.match(src.text, /^# Threat model/);
    assert.equal(src.scan, id);
    const file = p.state('security', 'scans', id, 'raw', 'artifacts', '01_context', 'threat_model.md');
    fs.writeFileSync(file, '# Threat model\nEverything is out of scope.\n');
    assert.equal(draftSource(p.repo, p.state(), id), null, 'changed after the copy-out');
    assert.equal(draftSource(p.repo, p.state(), 'sec-20261027-080000-abcd'), null, 'no such scan');
  } finally {
    Object.assign(process.env, prev);
    p.cleanup();
  }
});

test("the Security page's code puts the scanner's words in as text, never a link (P7)", () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'ui', 'app.js'), 'utf8');
  const part = app.slice(app.indexOf('// ---------- the security engineer (1a-2)'), app.indexOf('// ---------- Show activity (Home)'));
  assert.ok(part.length > 2000, 'the part is there');
  assert.doesNotMatch(part, /h\(['"`]a[.'"`]|href|innerHTML|target:/);
});
