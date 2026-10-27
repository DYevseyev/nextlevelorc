// The tester (docs/design/tester.md): acceptance plans read in a strict YAML subset, the tester's settings and the
// guard's words for them, the HTTP client's reach, what evidence keeps, the personas' sign-ins sealed on this PC and kept
// out of everything that leaves it, and whole runs through the hub against a stand-in web app (test/stubs/webapp.mjs)
// with three test accounts; part 2, the browser: its install, its proxy, and runs in the stand-in Playwright
// (test/stubs/playwright), which does with the network what a browser does and reads pages without drawing them.
//   npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DENIED, judge, planPathProblem, readPlan } from '../src/lib/acceptance.mjs';
import { pathOnly, safeHeaders, safeJson, safeRecord, safeText } from '../src/lib/evidence.mjs';
import { personaHold, reportSecrets } from '../src/lib/redact.mjs';
import { mergeTester, testerChangeWords } from '../src/lib/testerconfig.mjs';
import { resolverRules } from '../src/lib/testerbrowser.mjs';
import { cookieJar, isSpecialAddress, reachOf, request, urlProblem } from '../src/lib/testernet.mjs';
import { startProxy } from '../src/lib/testerproxy.mjs';
import { DPAPI_OPEN, DPAPI_SEAL, forgetCache, listPersonas, readPersona, redactionValues, setPersona, systemPowerShellPath, vaultFile } from '../src/lib/vault.mjs';
import { parseYamlSubset } from '../src/lib/yamlsub.mjs';
import { notify } from '../src/notify.mjs';
import { makeProject, waitUntil } from './helpers.mjs';
import { startWebApp, USERS } from './stubs/webapp.mjs';

const steps = (body) => `plan: x\nsteps:\n${body}`;
const problemsOf = (text) => readPlan(text).problems.map((p) => p.message).join('\n');
const errorsOf = (t) => {
  const problems = { errors: [], warnings: [] };
  const value = mergeTester(t, problems);
  return { value, errors: problems.errors.join('\n'), warnings: problems.warnings };
};

test('plans: the YAML subset reads what it may and refuses the rest, naming the line', () => {
  const ok = parseYamlSubset('a: [1, [2, {b: c}]]\nb: "q\\n"\nc: \'it\'\'s\'\nd:\n  - 1\n  - e: f\n# a comment\n');
  assert.deepEqual(ok.value, { a: ['1', ['2', { b: 'c' }]], b: 'q\n', c: "it's", d: ['1', { e: 'f' }] });
  for (const [text, words, line] of [
    ['a: &x 1', /anchors/, 1],
    ['a: !str 1', /tags/, 1],
    ['a: |\n  x', /block scalars/, 1],
    ['a: 1\nb: 2\na: 3', /"a" twice/, 3],
    ['__proto__: 1', /can't be a key/, 1],
    ['a:\t1', /key: value/, 1],
  ]) {
    const r = parseYamlSubset(text);
    assert.equal(r.value, undefined, text);
    assert.match(r.problem, words, text);
    assert.equal(r.line, line, text);
  }
});

// The fixtures' .expected.json were made once with a full YAML reader outside the repository (PyYAML's BaseLoader, which
// leaves every scalar a string as the subset does: python3 -I -c "import sys,json,yaml; print(json.dumps(yaml.load(
// open(sys.argv[1]), Loader=yaml.BaseLoader), indent=2, ensure_ascii=False))" <file>), never a dependency
test('plans: the YAML subset reads each fixture exactly as a full YAML reader does', () => {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tester-yaml');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yaml'));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const r = parseYamlSubset(fs.readFileSync(path.join(dir, f), 'utf8'));
    assert.equal(r.problem, undefined, `${f}: ${r.problem}`);
    assert.deepEqual(r.value, JSON.parse(fs.readFileSync(path.join(dir, f.replace(/\.yaml$/, '.expected.json')), 'utf8')), f);
  }
});

test('plans: a step that changes data says so, never repeats, never names a host, a cookie or a persona value', () => {
  const good = readPlan(steps('  - as: member\n    do: { request: "GET /notes/42" }\n    expect: { status: 200, text: Quarterly plan, within: 10s }\n  - as: member\n    mutates: true\n    do: { request: "POST /api/notes/42/comments", json: { text: "run {{run.id}}" } }\n    expect: { status: 201 }'));
  assert.deepEqual(good.problems, []);
  assert.equal(good.plan.steps.length, 2);
  assert.equal(good.plan.steps[0].within, 10);
  assert.equal(good.plan.steps[1].mutates, true);
  assert.match(problemsOf(steps('  - do: { request: "POST /a" }\n    expect: { status: 201 }')), /POST changes data: mark the step "mutates: true"/);
  assert.match(problemsOf(steps('  - do: { request: "DELETE /a" }\n    mutates: true\n    expect: { status: 204, within: 5s }')), /a step that mutates is never sent twice/);
  assert.match(problemsOf(steps('  - do: { request: "GET https://other.example.com/a" }\n    expect: { status: 200 }')), /never names a host or a full URL/);
  assert.match(problemsOf(steps('  - do: { request: "GET //other.example.com/a" }\n    expect: { status: 200 }')), /./);
  assert.match(problemsOf(steps('  - do: { request: "GET /a", headers: { Cookie: "a=b" } }\n    expect: { status: 200 }')), /"Cookie" can't be set by a plan/);
  assert.match(problemsOf(steps('  - do: { request: "GET /a", headers: { authorization: "Bearer x" } }\n    expect: { status: 200 }')), /can't be set by a plan/);
  // (a GET that a framework would take for a DELETE never passes for a read)
  for (const h of ['X-HTTP-Method-Override', 'x-http-method', 'X-Method-Override']) assert.match(problemsOf(steps(`  - do: { request: "GET /a", headers: { ${h}: DELETE } }\n    expect: { status: 200 }`)), /can't be set by a plan/, h);
  assert.match(problemsOf(steps('  - do: { request: "GET /a?x={{password}}" }\n    expect: { status: 200 }')), /only \{\{run\.id\}\} and \{\{run\.stamp\}\}/);
  assert.match(problemsOf('plan: x\nsteps: []\nextra: 1'), /./);
  assert.equal(planPathProblem('docs/acceptance/notes.yaml'), '');
  for (const bad of ['docs/acceptance/../../x.yaml', 'docs/other/notes.yaml', '/etc/x.yaml', 'docs/acceptance/notes.txt']) assert.ok(planPathProblem(bad), bad);
});

test("plans: a step's checks, and what denied means for an environment", () => {
  const expectOf = (e) => readPlan(steps(`  - do: { request: "GET /x" }\n    expect: ${e}`)).plan.steps[0].expect;
  const res = (o) => ({ status: 200, url: '/x', hops: [], headers: {}, text: '', json: null, isJson: false, ...o });
  const checks = judge(expectOf('{ status: 200, text: hi, json: { path: "$.a", equals: 1 } }'), res({ text: 'hi there', json: { a: 2 }, isJson: true }));
  assert.deepEqual(checks.map((c) => [c.what, c.ok]), [['status', true], ['text', true], ['json', false]]);
  assert.equal(checks[2].actual, '$.a is 2');
  const denied = [403, 'redirect:/sign-in'];
  assert.equal(judge(expectOf('{ denied: true }'), res({ status: 302, hops: [{ status: 302, location: '/sign-in?next=1' }] }), { denied })[0].ok, true);
  assert.equal(judge(expectOf('{ denied: true }'), res({ status: 200 }), { denied })[0].ok, false);
  assert.equal(judge(expectOf('{ denied: true }'), res({ status: 404 }), { denied: DEFAULT_DENIED })[0].ok, true);
});

test("settings: the tester runs no model, reaches https origins, never mutates production; the guard's words", () => {
  const bad = errorsOf({ enabled: true, engine: 'codex', environments: { prod: { url: 'http://example.com', production: true }, s: { url: 'https://s.example.com/path' } }, allowMutations: ['prod'] });
  assert.match(bad.errors, /"engine": the tester runs no model/);
  assert.match(bad.errors, /"environments\.prod\.url": https:\/\//);
  assert.match(bad.errors, /"environments\.s\.url": the origin alone \(https:\/\/s\.example\.com\)/);
  assert.match(bad.errors, /a step that mutates never runs on production/);
  assert.match(errorsOf({ enabled: true, environments: { s: { url: 'https://user:pw@example.com' } } }).errors, /no login in it/);
  assert.match(errorsOf({ enabled: true, environments: {} }).errors, /no environment is named/);
  const { value, errors } = errorsOf({ enabled: true, environments: { staging: { url: 'https://staging.example.com' } }, personas: ['member'], signIn: { http: { request: 'POST /api/session', json: { email: '{{username}}', password: '{{password}}' } } } });
  assert.equal(errors, '');
  assert.equal(errorsOf({ enabled: true, environments: { local: { url: 'http://127.0.0.1:8080' } } }).errors, '', 'plain http on this PC');

  assert.deepEqual(testerChangeWords(null, value).slice(0, 1), ['adds the tester (acceptance runs against the environments it names)']);
  const more = testerChangeWords(value, { ...value, allowMutations: ['staging'], alsoAllow: ['https://auth.example.com'], personas: ['member', 'admin'], signIn: { http: { request: 'POST /api/login', json: { u: '{{username}}', p: '{{password}}' } } } });
  assert.ok(more.includes('mutations allowed on staging'), more.join('\n'));
  assert.ok(more.includes('steps may also reach https://auth.example.com'));
  assert.ok(more.includes('adds the persona admin'));
  assert.ok(more.includes('sign-in now sends username and password to POST /api/login'));
  assert.ok(testerChangeWords(value, { ...value, environments: { staging: { url: 'https://new.example.com' } } }).includes("staging's URL changes to https://new.example.com: its personas must be set again"));
  assert.deepEqual(testerChangeWords(value, null), ['removes the tester']);
  assert.deepEqual(testerChangeWords(null, null), []);
});

test("the HTTP client: special addresses, the environment's origin only, every answer checked, never the dashboard", async () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '203.0.113.9', 'not-an-ip']) assert.ok(isSpecialAddress(ip), ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:4700::1111']) assert.ok(!isSpecialAddress(ip), ip);

  const reach = reachOf('https://staging.example.com', ['https://auth.example.com']);
  assert.equal(urlProblem('https://staging.example.com/a', reach), '');
  assert.equal(urlProblem('https://auth.example.com/a', reach), '');
  assert.match(urlProblem('https://other.example.com/a', reach), /isn't the environment's origin/);
  assert.match(urlProblem('http://staging.example.com/a', reach), /isn't the environment's origin/);
  assert.match(urlProblem('https://x:y@example.com/a', reach), /login/);
  assert.match(urlProblem('file:///etc/passwd', reach), /isn't reached/);
  const local = reachOf('http://127.0.0.1:5000', [], { denyPorts: [5000] });
  assert.match(urlProblem('http://127.0.0.1:5000/api/state', local), /nextlevel's own dashboard/);

  // a name that resolves to this PC or a private network is never reached for an environment on the internet, at each
  // request (a second answer is checked like the first)
  const old = process.env.NEXTLEVEL_TEST_RESOLVE;
  process.env.NEXTLEVEL_TEST_RESOLVE = JSON.stringify({ 'staging.example.com': ['127.0.0.1', '10.0.0.7'] });
  try {
    await assert.rejects(request('https://staging.example.com/a', { reach }), (e) => e.refused && /resolves to 127\.0\.0\.1/.test(e.message));
    await assert.rejects(request('https://staging.example.com/a', { reach }), (e) => e.refused && /resolves to 10\.0\.0\.7/.test(e.message));
    await assert.rejects(request('https://other.example.com/a', { reach }), (e) => e.refused);
  } finally {
    if (old === undefined) delete process.env.NEXTLEVEL_TEST_RESOLVE;
    else process.env.NEXTLEVEL_TEST_RESOLVE = old;
  }

  // a stand-in on this PC: only its own origin, a body read up to the cap, no redirect followed
  const server = http.createServer((req, res) => {
    if (req.url === '/big') return res.end('x'.repeat(5000));
    res.writeHead(302, { location: 'http://127.0.0.1:1/elsewhere' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    const here = reachOf(url);
    const big = await request(`${url}/big`, { reach: here, maxBytes: 1000 });
    assert.equal(big.body.length, 1000);
    assert.equal(big.truncated, true);
    const moved = await request(`${url}/moved`, { reach: here });
    assert.equal(moved.status, 302, 'the runner checks each hop itself');
    assert.match(urlProblem('http://127.0.0.1:1/elsewhere', here), /isn't the environment's origin/);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const jar = cookieJar();
  jar.take('a.example.com', ['sid=abc; Path=/; HttpOnly', 'theme=dark']);
  assert.equal(jar.header('a.example.com'), 'sid=abc; theme=dark');
  assert.equal(jar.header('b.example.com'), '', 'one jar per host');
  jar.take('a.example.com', 'sid=; Max-Age=0');
  assert.equal(jar.header('a.example.com'), 'theme=dark');
});

test('evidence: no session header, no secret-looking value, query values left out, every kept value replaced', () => {
  const secrets = { values: ['member-pass-0002', 'sessionvalue-123456'], names: [] };
  assert.equal(pathOnly('/cb?code=abc&state=xyz#frag'), '/cb?code=…&state=…');
  const h = safeHeaders({ 'set-cookie': ['sid=1'], authorization: 'Bearer x', 'content-type': 'text/html', location: '/next?token=abc', 'x-custom': 'y' }, secrets);
  assert.deepEqual(h, { 'content-type': 'text/html', location: '/next?token=…' });
  const j = safeJson({ token: 'abc', csrf: 'x', title: 'hi member-pass-0002', nested: [{ password: 'p', ok: 1 }], jwt: 'z' }, secrets);
  assert.deepEqual(j, { token: '***', csrf: '***', title: 'hi ***', nested: [{ password: '***', ok: 1 }], jwt: '***' });
  assert.equal(safeText('a\u202eb eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk', secrets).includes('\u202e'), false);
  assert.doesNotMatch(safeText('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk', secrets), /eyJ/);
  assert.match(safeText('a b '.repeat(2000), secrets), /…$/);
  assert.deepEqual(safeRecord({ a: 'sessionvalue-123456', b: ['member-pass-0002'] }, secrets), { a: '***', b: ['***'] });
});

// The personas' sign-ins of a project, sealed with the stand-in store in the project's own home
function inHome(p, fn) {
  const keep = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, NEXTLEVEL_TEST_VAULT: process.env.NEXTLEVEL_TEST_VAULT };
  process.env.HOME = p.env.HOME;
  process.env.USERPROFILE = p.env.USERPROFILE;
  process.env.NEXTLEVEL_TEST_VAULT = path.join(p.tmp, 'vault-store');
  forgetCache();
  const done = () => {
    for (const [k, v] of Object.entries(keep)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    forgetCache();
  };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.finally(done);
    done();
    return r;
  } catch (err) {
    done();
    throw err;
  }
}
const vaultEnv = (p) => ({ NEXTLEVEL_TEST_VAULT: path.join(p.tmp, 'vault-store') });
const setAll = (p, origin, env = 'staging') => inHome(p, () => {
  for (const n of Object.keys(USERS)) assert.equal(setPersona(p.repo, { env, origin, persona: n, values: { username: USERS[n].email, password: USERS[n].password } }), '');
});

test("the vault: values sealed per environment and origin, outside the project; short ones refused; what can't be read holds every message back", async () => {
  const p = makeProject();
  try {
    await inHome(p, async () => {
      const origin = 'https://staging.example.com';
      assert.match(setPersona(p.repo, { env: 'staging', origin, persona: 'member', values: { password: 'short' } }), /at least 8 characters/);
      assert.match(setPersona(p.repo, { env: 'staging', origin, persona: 'member', values: { cookie: 'x' } }), /isn't a persona's value/);
      assert.equal(setPersona(p.repo, { env: 'staging', origin, persona: 'member', values: { username: 'member@example.com', password: 'member-pass-0002' } }), '');
      const file = vaultFile(p.repo);
      assert.ok(!file.startsWith(p.repo), 'outside the project');
      assert.ok(!fs.readFileSync(file, 'utf8').includes('member-pass-0002'), 'sealed');
      assert.ok(!fs.readFileSync(file, 'utf8').includes('member@example.com'), 'the username too');
      assert.deepEqual(readPersona(p.repo, { env: 'staging', origin, persona: 'member' }).values, { username: 'member@example.com', password: 'member-pass-0002' });
      assert.match(readPersona(p.repo, { env: 'staging', origin: 'https://other.example.com', persona: 'member' }).problem, /isn't set/, 'bound to its origin');
      // an entry moved to another environment doesn't open (the entry's name is part of what was sealed)
      const v = JSON.parse(fs.readFileSync(file, 'utf8'));
      v.entries[`prod@${origin}/member`] = v.entries[`staging@${origin}/member`];
      fs.writeFileSync(file, JSON.stringify(v));
      forgetCache();
      assert.match(readPersona(p.repo, { env: 'prod', origin, persona: 'member' }).problem, /don't open/);
      assert.deepEqual(listPersonas(p.repo).map((x) => `${x.env}/${x.persona}`).sort(), ['prod/member', 'staging/member']);
      assert.match(personaHold(p.repo), /no longer opens/, "a sign-in that doesn't open holds every message back");
      delete v.entries[`prod@${origin}/member`];
      fs.writeFileSync(file, JSON.stringify(v));
      forgetCache();
      assert.equal(personaHold(p.repo), '');

      // every report and phone message has the password replaced
      assert.ok(redactionValues(p.repo).values.includes('member-pass-0002'));
      assert.ok(!redactionValues(p.repo).values.includes('member@example.com'), 'a username is no secret');
      assert.ok(reportSecrets({ root: p.repo, env: {}, path, read: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '') }).values.includes('member-pass-0002'));
      const got = [];
      const ntfy = http.createServer((req, res) => {
        let b = '';
        req.on('data', (d) => (b += d));
        req.on('end', () => {
          got.push(JSON.parse(b));
          res.end('{}');
        });
      });
      await new Promise((r) => ntfy.listen(0, '127.0.0.1', r));
      const topic = process.env.NTFY_TOPIC;
      process.env.NTFY_TOPIC = 'a-long-random-topic-for-tests-5678';
      try {
        const server = `http://127.0.0.1:${ntfy.address().port}`;
        assert.equal(await notify('Signed in', 'the app printed member-pass-0002 in a page', { server, root: p.repo }), true);
        assert.equal(got.length, 1);
        assert.ok(!JSON.stringify(got[0]).includes('member-pass-0002'));
        assert.match(got[0].message, /\*\*\*/);
        // a store that no longer answers: nothing leaves, rather than a text that may hold a password
        fs.rmSync(process.env.NEXTLEVEL_TEST_VAULT, { recursive: true, force: true });
        forgetCache();
        assert.match(personaHold(p.repo), /can't be read to keep them out/);
        assert.equal(await notify('Signed in', 'anything', { server, root: p.repo }), false);
        assert.equal(got.length, 1, 'nothing sent');
      } finally {
        if (topic === undefined) delete process.env.NTFY_TOPIC;
        else process.env.NTFY_TOPIC = topic;
        await new Promise((r) => ntfy.close(r));
      }
    });
  } finally {
    p.cleanup();
  }
});

const SIGN_IN = { http: [{ request: 'GET /api/csrf', capture: { csrf: '$.token' } }, { request: 'POST /api/session', json: { email: '{{username}}', password: '{{password}}', csrf: '{{csrf}}' } }] };
function testerProject(app, { mutations = true, extra = {} } = {}) {
  const p = makeProject();
  p.setConfig((c) => ({ ...c, tester: { enabled: true, environments: { staging: { url: app.url, denied: [403, 'redirect:/sign-in'] } }, allowMutations: mutations ? ['staging'] : [], personas: ['admin', 'member', 'outsider'], signIn: SIGN_IN, ...extra } }));
  p.git('add', '-A');
  p.git('commit', '-qm', 'the tester');
  return p;
}
function commitPlan(p, name, text) {
  fs.mkdirSync(path.join(p.repo, 'docs/acceptance'), { recursive: true });
  fs.writeFileSync(path.join(p.repo, 'docs/acceptance', name), text);
  p.git('add', '-A');
  p.git('commit', '-qm', `plan ${name}`);
}
// Ask for a run, let the hub run it, and read its record and evidence
function runPlan(p, plan, { env = {} } = {}) {
  const extraEnv = { ...vaultEnv(p), ...env };
  const ask = p.hub(['tester', 'run', `docs/acceptance/${plan}`, '--env', 'staging'], { extraEnv });
  assert.equal(ask.code, 0, ask.out);
  const id = ask.out.match(/acc-\d{8}-\d{6}-[0-9a-f]{4}/)[0];
  const hub = p.runUntilIdle([], { extraEnv: vaultEnv(p) });
  assert.equal(hub.code, 0, hub.out);
  const run = JSON.parse(fs.readFileSync(p.state('evidence', id, 'run.json'), 'utf8'));
  const evidence = fs.readdirSync(p.state('evidence', id)).map((f) => fs.readFileSync(p.state('evidence', id, f), 'utf8')).join('\n');
  const shown = p.hub(['tester', 'show', id]).out;
  return { id, run, evidence, shown, hub };
}
const NOTES = `plan: notes-sharing
steps:
  - as: member
    do: { request: "GET /notes/42" }
    expect: { status: 200, text: Quarterly plan }
  - as: outsider
    do: { request: "GET /notes/42" }
    expect: { denied: true }
  - do: { request: "GET /notes/42" }
    expect: { denied: true }
  - as: admin
    do: { request: "GET /api/audit?note=42" }
    expect: { json: { path: "$.entries[*].action", contains: access-denied }, within: 20s }
  - as: member
    do: { request: "GET /echo-session" }
    expect: { status: 200 }
  - as: member
    do: { request: "GET /leak" }
    expect: { status: 200 }
  - as: member
    mutates: true
    do: { request: "POST /api/notes/42/comments", json: { text: "check {{run.stamp}}" } }
    expect: { status: 201 }
`;

test('a run: three personas sign in, every step passes, and no password, cookie or token is kept anywhere', async () => {
  const app = await startWebApp({ auditDelayMs: 1500 });
  const p = testerProject(app);
  try {
    setAll(p, app.url);
    commitPlan(p, 'notes.yaml', NOTES);
    const status = p.hub(['tester', 'status'], { extraEnv: vaultEnv(p) });
    assert.match(status.out, /The tester is on\./);
    assert.match(status.out, /member +set/);
    const { id, run, evidence, shown, hub } = runPlan(p, 'notes.yaml');
    assert.equal(run.state, 'passed', shown);
    assert.deepEqual(run.steps.map((s) => s.status), Array(7).fill('passed'));
    assert.match(shown, new RegExp(`Acceptance run ${id}: passed`));
    assert.match(hub.out, new RegExp(`acceptance run ${id}: passed`));
    const seen = await app.state();
    assert.equal(seen.comments.length, 1, 'the step that mutates ran once');
    assert.equal(seen.sessions.length, 3, 'one sign-in per persona');
    const kept = [evidence, shown, hub.out, fs.readFileSync(p.state('logs', 'hub.log'), 'utf8')].join('\n');
    for (const n of Object.keys(USERS)) assert.ok(!kept.includes(USERS[n].password), `${n}'s password`);
    for (const sid of seen.sessions) assert.ok(!kept.includes(sid), 'a session value');
    const echo = JSON.parse(fs.readFileSync(p.state('evidence', id, 'step-5.json'), 'utf8'));
    assert.match(echo.body, /"cookie": "\*\*\*"/);
    assert.match(fs.readFileSync(p.state('evidence', id, 'step-6.json'), 'utf8'), /password=\*\*\*/);
    // the audit trail, in the guard's folder: who, which plan, which personas; no evidence
    const auditDir = fs.readdirSync(path.join(p.env.HOME, '.nextlevel', 'guard')).map((d) => path.join(p.env.HOME, '.nextlevel', 'guard', d, 'tester.jsonl')).find((f) => fs.existsSync(f));
    const trail = fs.readFileSync(auditDir, 'utf8');
    assert.match(trail, new RegExp(id));
    assert.ok(!trail.includes(USERS.member.password));
    // Today counts the run under the tester
    assert.match(JSON.stringify(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8'))), /tester/);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("a run that fails: the step that failed, the persona's later steps not run; a redirect off the origin refused; a mutating step on a read-only environment never sent", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false });
  try {
    setAll(p, app.url);
    commitPlan(p, 'fails.yaml', `plan: fails
steps:
  - as: member
    do: { request: "GET /api/audit?note=42" }
    expect: { status: 200 }
  - as: member
    do: { request: "GET /notes/42" }
    expect: { status: 200 }
  - as: admin
    do: { request: "GET /off-site" }
    expect: { status: 200 }
  - as: outsider
    mutates: true
    do: { request: "POST /api/notes/42/comments", json: { text: "x" } }
    expect: { status: 403 }
`);
    const { run, shown } = runPlan(p, 'fails.yaml');
    assert.equal(run.state, 'failed', shown);
    assert.deepEqual(run.steps.map((s) => s.status), ['failed', 'not run', 'refused', 'incomplete']);
    assert.match(shown, /expected 200; got 403/);
    assert.match(shown, /redirected to other\.test: other\.test isn't the environment's origin/);
    assert.match(shown, /it mutates, and nextlevel\.json doesn't allow mutations on staging: not sent/);
    const seen = await app.state();
    assert.equal(seen.comments.length, 0);
    assert.ok(!seen.requests.some((r) => r.method === 'POST' && r.path.includes('comments')), 'never sent');
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("a run reads the plan as the base branch has it, never the working tree; refusals: off, a plan that isn't committed, a persona not set", async () => {
  const app = await startWebApp();
  const p = testerProject(app);
  try {
    setAll(p, app.url);
    commitPlan(p, 'one.yaml', 'plan: one\nsteps:\n  - as: member\n    do: { request: "GET /notes/42" }\n    expect: { status: 200 }\n');
    // an edit nobody committed: the run never sees it
    fs.writeFileSync(path.join(p.repo, 'docs/acceptance/one.yaml'), 'plan: one\nsteps:\n  - as: member\n    do: { request: "GET /counter" }\n    expect: { status: 500 }\n');
    const { run } = runPlan(p, 'one.yaml');
    assert.equal(run.state, 'passed');
    assert.equal(run.commit, p.git('rev-parse', 'main'));
    assert.equal((await app.state()).sideEffects, 0);

    fs.writeFileSync(path.join(p.repo, 'docs/acceptance/new.yaml'), 'plan: new\nsteps:\n  - do: { request: "GET /version" }\n    expect: { status: 200 }\n');
    const notCommitted = p.hub(['tester', 'run', 'docs/acceptance/new.yaml', '--env', 'staging'], { extraEnv: vaultEnv(p) });
    assert.equal(notCommitted.code, 1);
    assert.match(notCommitted.out, /isn't committed on main/);
    assert.match(p.hub(['tester', 'run', 'docs/acceptance/one.yaml'], { extraEnv: vaultEnv(p) }).out, /--env <name>/);
    assert.match(p.hub(['tester', 'check', 'docs/acceptance/new.yaml']).out, /reads/);

    // a persona with no sign-in kept: its steps can't run, and the run says how to set it
    inHome(p, () => fs.rmSync(vaultFile(p.repo)));
    const unset = runPlan(p, 'one.yaml');
    assert.equal(unset.run.state, 'incomplete');
    assert.match(unset.shown, /nextlevel tester persona set staging member/);

    p.setConfig((c) => ({ ...c, tester: { ...c.tester, enabled: false } }));
    const off = p.hub(['tester', 'run', 'docs/acceptance/one.yaml', '--env', 'staging']);
    assert.equal(off.code, 1);
    assert.match(off.out, /The tester is off/);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("who may run it: the owner and the orchestrator (held to its hourly cap); never a worker or the assistant; the owner's commands only in the owner's window", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { extra: { maxRunsPerHour: 1 } });
  try {
    setAll(p, app.url);
    commitPlan(p, 'one.yaml', 'plan: one\nsteps:\n  - as: member\n    do: { request: "GET /notes/42" }\n    expect: { status: 200 }\n');
    const plan = ['tester', 'run', 'docs/acceptance/one.yaml', '--env', 'staging'];
    const worker = p.hub(plan, { extraEnv: { NEXTLEVEL_AGENT: 'worker', NEXTLEVEL_TASK_ID: 'M1-01' } });
    assert.equal(worker.code, 1);
    assert.match(worker.out, /doesn't run in a worker's slot/);
    const assistant = p.hub(plan, { extraEnv: { NEXTLEVEL_READ_ONLY: '1' } });
    assert.equal(assistant.code, 1);
    assert.match(assistant.out, /read-only session/);
    assert.equal(p.hub(['tester', 'status'], { extraEnv: { NEXTLEVEL_READ_ONLY: '1' } }).code, 0, 'the assistant may look');
    const orch = { NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'interactive' };
    assert.match(p.hub(['tester', 'persona', 'list'], { extraEnv: orch }).out, /only|owner/i);
    assert.equal(p.hub(['tester', 'stop'], { extraEnv: orch }).code, 1);
    // what the tester's own process starts may run no nextlevel command
    const inRun = p.hub(['status'], { extraEnv: { NEXTLEVEL_AGENT: 'tester' } });
    assert.equal(inRun.code, 1, inRun.out);

    const first = runPlan(p, 'one.yaml', { env: orch });
    assert.equal(first.run.state, 'passed');
    assert.equal(first.run.by, 'orchestrator');
    const second = runPlan(p, 'one.yaml', { env: orch });
    assert.equal(second.run.state, 'refused');
    assert.match(second.run.why, /in the last hour \(tester\.maxRunsPerHour is 1\)/);
    assert.equal(runPlan(p, 'one.yaml').run.state, 'passed', "the owner's runs aren't capped");

    const notTty = p.hub(['tester', 'persona', 'set', 'staging', 'member']);
    assert.equal(notTty.code, 1);
    assert.match(notTty.out, /runs in your own window/);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test('the tester off: the hub, status and the doctor are as before; a commit with a persona password is held like a .env value', async () => {
  const p = makeProject();
  try {
    const idle = p.runUntilIdle();
    assert.equal(idle.code, 0, idle.out);
    assert.doesNotMatch(idle.out, /acceptance/);
    assert.ok(!fs.existsSync(p.state('evidence')));
    assert.match(p.hub(['tester', 'status']).out, /The tester is off/);

    setAll(p, 'https://staging.example.com');
    fs.writeFileSync(path.join(p.repo, 'notes.txt'), `the admin signs in with ${USERS.admin.password}\n`);
    const bg = p.hubInBackground(['run', '--tick-ms', '200'], vaultEnv(p));
    try {
      await waitUntil('the hub to start', () => fs.existsSync(p.state('hub.json')));
      const r = p.hub(['commit', '-m', 'notes', 'notes.txt'], { extraEnv: vaultEnv(p) });
      assert.match(r.out, /held notes\.txt: it has the value of admin on staging \(password\) from the tester's sign-ins/);
      assert.ok(!r.out.includes(USERS.admin.password));
    } finally {
      fs.writeFileSync(p.state('hub-stop.json'), '{}');
      await waitUntil('the hub to stop', () => bg.exitCode !== null);
    }
  } finally {
    p.cleanup();
  }
});

test('a 307 never carries a body to another origin; to its own origin it does', async () => {
  const other = await startWebApp();
  const app = await startWebApp({ moveTo: `${other.url}/api/session` });
  const p = testerProject(app, { extra: { alsoAllow: [other.url] } });
  try {
    setAll(p, app.url);
    commitPlan(p, 'moved.yaml', `plan: moved
steps:
  - as: member
    mutates: true
    do: { request: "POST /moved", json: { note: carried } }
    expect: { status: 200 }
  - as: admin
    mutates: true
    do: { request: "POST /moved-here", json: { note: kept } }
    expect: { json: { path: "$.got", contains: kept } }
`);
    const { run, shown } = runPlan(p, 'moved.yaml');
    assert.deepEqual(run.steps.map((s) => s.status), ['refused', 'passed'], shown);
    assert.match(shown, /redirected with its body to 127\.0\.0\.1:\d+: a request's body only goes to the origin it was sent to/);
    assert.ok(!(await other.state()).requests.some((r) => r.body.includes('carried')), 'the other origin never saw the body');
  } finally {
    await app.close();
    await other.close();
    p.cleanup();
  }
});

// (a stub git first on PATH, which notes the environment it got when a run's process starts it: POSIX only, a shell
// script; Windows runs the same code)
test('the run\'s own process holds no .env value in its environment', { skip: process.platform === 'win32' }, async () => {
  const app = await startWebApp();
  const p = testerProject(app);
  try {
    const PLANTED = 'testerenv-5d2a91c7-planted';
    fs.writeFileSync(path.join(p.repo, '.env'), `APP_SETTING=${PLANTED}\n`);
    setAll(p, app.url);
    commitPlan(p, 'one.yaml', 'plan: one\nsteps:\n  - as: member\n    do: { request: "GET /notes/42" }\n    expect: { status: 200 }\n');
    const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    const bin = path.join(p.tmp, 'envgit');
    const seen = path.join(p.tmp, 'git-env.txt');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$NEXTLEVEL_AGENT" = tester ]; then env >> '${seen}'; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
    const extraEnv = { ...vaultEnv(p), PATH: `${bin}${path.delimiter}${p.env.PATH}` };
    const ask = p.hub(['tester', 'run', 'docs/acceptance/one.yaml', '--env', 'staging'], { extraEnv });
    assert.equal(ask.code, 0, ask.out);
    const hub = p.runUntilIdle([], { extraEnv });
    assert.match(hub.out, /acceptance run acc-[\d-]+[0-9a-f]{4}: passed/, hub.out);
    const env = fs.readFileSync(seen, 'utf8');
    assert.match(env, /NEXTLEVEL_AGENT=tester/, 'the stub git saw the run');
    assert.ok(!env.includes(PLANTED), 'no .env value');
    assert.doesNotMatch(env, /^APP_SETTING=/m);
  } finally {
    await app.close();
    p.cleanup();
  }
});

// The real store on Windows: the vault's own arguments, through Windows' own PowerShell (the one nextlevel starts outside
// the tests' stubs), seal a key and open it again, the key only on stdin
test("Windows: DPAPI seals and opens the sign-ins' key through Windows' own PowerShell", { skip: process.platform !== 'win32' }, () => {
  const ps = systemPowerShellPath();
  assert.ok(ps.toLowerCase().endsWith('\\system32\\windowspowershell\\v1.0\\powershell.exe'), ps);
  assert.ok(fs.existsSync(ps), ps);
  for (const args of [DPAPI_SEAL, DPAPI_OPEN]) assert.ok(!args.includes('Bypass') && !args.includes('-ExecutionPolicy'), args.join(' '));
  const key = randomBytes(32).toString('base64');
  const run = (args, input) => spawnSync(ps, args, { input, encoding: 'utf8', windowsHide: true, timeout: 60_000 });
  const sealed = run(DPAPI_SEAL, key);
  assert.equal(sealed.status, 0, sealed.stderr);
  const blob = sealed.stdout.trim();
  assert.ok(blob && blob !== key && !blob.includes(key));
  assert.ok(!DPAPI_SEAL.join(' ').includes(key), 'the key is never on the command line');
  const opened = run(DPAPI_OPEN, blob);
  assert.equal(opened.status, 0, opened.stderr);
  assert.equal(opened.stdout.trim(), key);
});

// ---------- part 2: the browser ----------
// What the stand-in Playwright (test/stubs/playwright) saw: launches, route() decisions, requests, screenshots
const pwLog = (p) => {
  try {
    return fs.readFileSync(path.join(p.env.HOME, '.fake-playwright', 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
// The owner's install, as `nextlevel tester browser install --yes` does it, with the stand-in npm and Playwright
function installBrowserFor(p) {
  const r = p.hub(['tester', 'browser', 'install', '--yes']);
  assert.equal(r.code, 0, r.out);
  return r;
}
const BROWSER_SIGN_IN = { browser: [{ open: '/sign-in' }, { fill: ['#email', '{{username}}'] }, { fill: ['#password', '{{password}}'] }, { click: '#go' }] };

test("the browser's proxy: only the run's origins, at their checked addresses; never another port on this PC; a tunnel checked by host and port", async () => {
  const app = await startWebApp();
  const dash = http.createServer((req, res) => res.end('the dashboard'));
  await new Promise((r) => dash.listen(0, '127.0.0.1', r));
  const reach = reachOf(app.url, [], { denyPorts: [dash.address().port] });
  const blocks = [];
  const proxy = await startProxy({ reach, onBlock: (b) => blocks.push(b) });
  const through = (url, method = 'GET') =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      http.request({ host: '127.0.0.1', port: proxy.port, method, path: url, headers: { host: u.host } }, (res) => {
        let b = '';
        res.on('data', (d) => (b += d));
        res.on('end', () => resolve({ status: res.statusCode, refused: !!res.headers['x-nextlevel-refused'], body: b }));
      }).on('error', reject).end();
    });
  const tunnel = (target) =>
    new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: proxy.port, method: 'CONNECT', path: target });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          return resolve({ status: res.statusCode });
        }
        socket.write(`GET /notes/42 HTTP/1.1\r\nHost: ${target}\r\nConnection: close\r\n\r\n`);
        let b = '';
        socket.on('data', (d) => (b += d));
        socket.on('end', () => resolve({ status: 200, body: b }));
      });
      req.on('error', () => resolve({ status: 0 }));
      req.end();
    });
  try {
    const ok = await through(`${app.url}/notes/42`);
    assert.equal(ok.status, 302, 'the app answered');
    assert.equal(ok.refused, false);
    for (const url of ['http://other.test/collect', `http://127.0.0.1:${dash.address().port}/`, `http://localhost:${app.port}/notes/42`]) {
      const r = await through(url);
      assert.deepEqual([r.status, r.refused], [403, true], url);
    }
    assert.equal((await through(`${app.url}/__test/state`)).status, 200);
    assert.ok(!(await app.state()).requests.some((r) => r.path === '/collect'));
    assert.equal(blocks.length, 3);
    assert.match(blocks[1].why, /127\.0\.0\.1:\d+ isn't the environment's origin/);
    // CONNECT: the app's own host and port pass (a WebSocket on its http origin), anything else doesn't
    const t = await tunnel(`127.0.0.1:${app.port}`);
    assert.equal(t.status, 200);
    assert.match(t.body, /^HTTP\/1\.1 302/);
    assert.equal((await tunnel(`127.0.0.1:${dash.address().port}`)).status, 403);
    assert.equal((await tunnel('other.test:443')).status, 403);
  } finally {
    await proxy.close();
    await app.close();
    dash.close();
  }
  // a name whose address moves to this PC is never reached through the proxy either (one lookup, checked)
  const keep = process.env.NEXTLEVEL_TEST_RESOLVE;
  process.env.NEXTLEVEL_TEST_RESOLVE = JSON.stringify({ 'staging.example.com': ['127.0.0.1'] });
  const p2 = await startProxy({ reach: reachOf('https://staging.example.com'), onBlock: (b) => blocks.push(b) });
  try {
    const t = await new Promise((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: p2.port, method: 'CONNECT', path: 'staging.example.com:443' });
      req.on('connect', (res, socket) => {
        socket.destroy();
        resolve(res.statusCode);
      });
      req.end();
    });
    assert.equal(t, 403);
    assert.match(blocks.at(-1).why, /resolves to 127\.0\.0\.1, an address on this PC or a private network/);
  } finally {
    if (keep === undefined) delete process.env.NEXTLEVEL_TEST_RESOLVE;
    else process.env.NEXTLEVEL_TEST_RESOLVE = keep;
    await p2.close();
  }
  assert.equal(resolverRules([['staging.example.com', '93.184.216.34'], ['127.0.0.1', '127.0.0.1'], ['v6.example.com', '2001:4860::1']]), 'MAP staging.example.com 93.184.216.34, MAP v6.example.com [2001:4860::1], MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
});

test("the browser's install: the owner's, from the lock file with no scripts, every file recorded; a changed file is caught; never in an agent's session", async () => {
  const p = makeProject();
  try {
    const orch = { NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'interactive' };
    const refused = p.hub(['tester', 'browser', 'install', '--yes'], { extraEnv: orch });
    assert.equal(refused.code, 1);
    assert.match(refused.out, /owner/i);
    assert.match(p.hub(['tester', 'browser']).out, /^The browser isn't installed\. .*nextlevel tester browser install, in your own PowerShell window/m);
    assert.equal(p.hub(['tester', 'browser', 'install']).code, 1, 'no window to ask in, no --yes: nothing installed');
    const calls = path.join(p.tmp, 'calls.jsonl');
    const r = p.hub(['tester', 'browser', 'install', '--yes'], { extraEnv: { STUB_CALLS: calls } });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /Playwright 1\.63\.0 and its headless Chromium \(about 120 MB to download/);
    assert.match(r.out, /The browser opens pages/);
    assert.match(fs.readFileSync(calls, 'utf8'), /\["npm","ci","--ignore-scripts","--no-audit","--no-fund"\]/);
    const dir = path.join(p.env.HOME, '.nextlevel', 'tools', 'playwright@1.63.0');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
    assert.match(lock.packages['node_modules/playwright-core'].integrity, /^sha512-/);
    const record = JSON.parse(fs.readFileSync(`${dir}.json`, 'utf8'));
    assert.ok(record.files['node_modules/playwright-core/index.mjs'], 'every file recorded');
    assert.ok(Object.keys(record.files).some((f) => f.startsWith('browsers/')), 'the browser too');
    assert.ok(pwLog(p).some((x) => x.kind === 'cli' && x.args.includes('chromium-headless-shell') && x.browsersPath === path.join(dir, 'browsers')));
    assert.match(p.hub(['tester', 'browser']).out, /^The browser is installed: Playwright 1\.63\.0/);
    assert.equal(p.hub(['tester', 'browser'], { extraEnv: { NEXTLEVEL_READ_ONLY: '1' } }).code, 0, 'the assistant may look');
    // a file changed after the install: said, and a run won't start the browser
    fs.appendFileSync(path.join(dir, 'node_modules', 'playwright-core', 'index.mjs'), '\n// changed\n');
    assert.match(p.hub(['tester', 'browser']).out, /files differ from what was installed \(node_modules\/playwright-core\/index\.mjs changed\): install it again/);
  } finally {
    p.cleanup();
  }
});

test('a run in the browser: each persona in its own context, signed in through the browser; a mutating click once; the password masked in every screenshot and kept out of everything', async () => {
  const app = await startWebApp();
  const p = testerProject(app, { extra: { signIn: BROWSER_SIGN_IN } });
  try {
    const PLANTED = 'browserenv-71c2e0aa-planted';
    fs.writeFileSync(path.join(p.repo, '.env'), `APP_SETTING=${PLANTED}\n`);
    installBrowserFor(p);
    setAll(p, app.url);
    commitPlan(p, 'browser.yaml', `plan: notes-in-the-browser
steps:
  - as: member
    do: { open: /notes/42 }
    expect: { text: Quarterly plan }
  - as: member
    do: { fill: ["#comment", "acceptance check {{run.stamp}}"] }
    expect: { url: /notes/42 }
  - as: member
    mutates: true
    do: { click: "#save" }
    expect: { text: acceptance check }
  - as: outsider
    do: { open: /notes/42 }
    expect: { denied: true }
  - do: { open: /notes/42 }
    expect: { redirect: /sign-in }
  - as: member
    do: { open: /leak }
    expect: { text: debug }
  - as: member
    do: { open: /with-pixel }
    expect: { text: A page with a pixel }
  - as: admin
    do: { request: "GET /api/audit?note=42" }
    expect: { json: { path: "$.entries[*].action", contains: access-denied }, within: 20s }
`);
    fs.rmSync(path.join(p.env.HOME, '.fake-playwright', 'log.jsonl'), { force: true }); // (the install's own check aside)
    const { id, run, evidence, shown, hub } = runPlan(p, 'browser.yaml');
    assert.equal(run.state, 'passed', shown);
    assert.deepEqual(run.steps.map((s) => s.status), Array(8).fill('passed'));
    const seen = await app.state();
    assert.equal(seen.comments.length, 1, 'the click that mutates sent its form once');
    assert.equal(seen.sessions.length, 3, 'member and outsider through the browser, admin for its HTTP step through it too');
    assert.deepEqual(run.mutations, ['POST /notes/42/comments'], 'the sign-ins are not mutations');
    // each browser step has its picture; the password masked, the session never kept
    const files = fs.readdirSync(p.state('evidence', id));
    for (const n of [1, 2, 3, 4, 5, 6, 7]) assert.ok(files.includes(`step-${n}.png`), `step ${n}'s screenshot`);
    const pictures = files.filter((f) => f.endsWith('.png')).map((f) => fs.readFileSync(p.state('evidence', id, f), 'latin1')).join('\n');
    const kept = [evidence, pictures, shown, hub.out, fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), JSON.stringify(run)].join('\n');
    for (const n of Object.keys(USERS)) assert.ok(!kept.includes(USERS[n].password), `${n}'s password`);
    for (const sid of seen.sessions) assert.ok(!kept.includes(sid), 'a session value');
    assert.ok(!kept.includes(PLANTED));
    const leak = JSON.parse(fs.readFileSync(p.state('evidence', id, 'step-6.json'), 'utf8'));
    assert.match(leak.text, /password=\*\*\*/);
    assert.equal(leak.screenshot, 'step-6.png');
    const pixel = JSON.parse(fs.readFileSync(p.state('evidence', id, 'step-7.json'), 'utf8'));
    assert.deepEqual(pixel.blocked.map((b) => [b.method, b.where]), [['GET', 'http://other.test/pixel.gif']], "another host's picture: not loaded, said, and the step still passes");
    // what the browser was started with: through the run's proxy only, every other name to nothing, no .env value
    const log = pwLog(p);
    const launch = log.find((x) => x.kind === 'launch');
    assert.match(launch.proxy.server, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(launch.proxy.bypass, '<-loopback>');
    assert.ok(launch.args.includes('--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'), launch.args.join(' '));
    assert.equal(launch.headless, true);
    assert.ok(!JSON.stringify(launch.env).includes(PLANTED));
    assert.ok(!Object.keys(launch.env).some((k) => /^NEXTLEVEL_|^APP_SETTING$/.test(k)), Object.keys(launch.env).join(' '));
    assert.equal(log.filter((x) => x.kind === 'launch').length, 1, 'one browser for the run');
    assert.equal(log.filter((x) => x.kind === 'context').length, 4, "member, outsider, signed out, and the admin's sign-in for its HTTP step");
    for (const c of log.filter((x) => x.kind === 'context')) assert.deepEqual([c.opts.acceptDownloads, c.opts.serviceWorkers], [false, 'block']);
    assert.equal(log.filter((x) => x.kind === 'context-closed').length, 0, 'closed with the browser');
    assert.ok(log.some((x) => x.kind === 'browser-closed'));
    // every screenshot had the password fields and the filled fields masked
    const shots = log.filter((x) => x.kind === 'screenshot');
    for (const s of shots) assert.ok(s.masks.includes('input[type=password]'), s.masks.join(' '));
    for (const s of shots.filter((x) => x.masks.includes('#email'))) assert.ok(s.masks.includes('#password'), 'the fields its sign-in filled');
    assert.ok(shots.filter((x) => x.masks.includes('#comment')).length >= 4, 'the field a step filled, from then on');
    const leakShot = log.find((x) => x.kind === 'screenshot' && x.url.endsWith('/leak'));
    assert.ok(leakShot.masks.some((m) => m.startsWith('[data-nextlevel-i=')), 'the element that shows the password got a mask of its own');
    assert.deepEqual(leakShot.shown, []);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("the browser on a read-only environment: a click that would write is stopped and fails the step; redirects off the origin and to the dashboard refused; a password across two elements keeps the picture out", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false, extra: { signIn: BROWSER_SIGN_IN } });
  try {
    installBrowserFor(p);
    setAll(p, app.url);
    fs.mkdirSync(p.state(), { recursive: true });
    fs.writeFileSync(p.state('ui.json'), JSON.stringify({ port: 47123 }));
    commitPlan(p, 'readonly.yaml', `plan: read-only
steps:
  - as: member
    do: { fill: ["#comment", "x"] }
    expect: { url: /notes/42 }
  - as: member
    do: { click: "#save" }
    expect: { text: Quarterly plan }
  - as: admin
    mutates: true
    do: { click: "#save" }
    expect: { text: Quarterly plan }
  - do: { open: /off-site }
    expect: { status: 200 }
  - as: outsider
    do: { open: "/to-port?port=47123" }
    expect: { status: 200 }
  - as: admin
    do: { open: /split-leak }
    expect: { text: debug }
  - as: admin
    do: { wait: "#not-there" }
    expect: { text: debug }
`);
    const { id, run, shown } = runPlan(p, 'readonly.yaml');
    assert.equal(run.state, 'failed', shown);
    assert.deepEqual(run.steps.map((s) => s.status), ['passed', 'refused', 'incomplete', 'refused', 'refused', 'passed', 'failed'], shown);
    assert.match(shown, /the page sent POST \/notes\/42\/comments, and the step isn't marked "mutates": not sent/);
    assert.match(shown, /it mutates, and nextlevel\.json doesn't allow mutations on staging: not sent/);
    assert.match(shown, /http:\/\/other\.test\/collect: other\.test isn't the environment's origin/);
    assert.match(shown, /http:\/\/127\.0\.0\.1:47123\/: (port 47123 on this PC is nextlevel's own dashboard|127\.0\.0\.1:47123 isn't the environment's origin)/);
    assert.match(shown, /expected an element #not-there shown; got none in 30 s/);
    const seen = await app.state();
    assert.equal(seen.comments.length, 0, 'nothing written');
    assert.ok(!seen.requests.some((r) => r.method === 'POST' && r.path.includes('comments')), 'never sent');
    assert.ok(seen.requests.some((r) => r.method === 'POST' && r.path === '/sign-in'), "the sign-in's own POST is let through");
    assert.deepEqual(run.mutations, []);
    const split = JSON.parse(fs.readFileSync(p.state('evidence', id, 'step-6.json'), 'utf8'));
    assert.match(split.screenshot, /not in one element: the screenshot isn't kept/);
    assert.ok(!fs.existsSync(p.state('evidence', id, 'step-6.png')));
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("without the browser: browser steps end incomplete, saying how to install it, and HTTP steps run; an HTTP sign-in's cookies carry into the browser; a browser that doesn't start says so", async () => {
  const app = await startWebApp();
  const p = testerProject(app);
  try {
    setAll(p, app.url);
    commitPlan(p, 'mixed.yaml', `plan: mixed
steps:
  - as: member
    do: { request: "GET /notes/42" }
    expect: { status: 200 }
  - as: member
    do: { open: /notes/42 }
    expect: { text: Signed in as member@example.com }
  - as: admin
    do: { request: "GET /api/notes/42" }
    expect: { status: 200 }
`);
    const none = runPlan(p, 'mixed.yaml');
    assert.equal(none.run.state, 'incomplete', none.shown);
    assert.deepEqual(none.run.steps.map((s) => s.status), ['passed', 'incomplete', 'passed']);
    assert.match(none.shown, /it needs the browser, and the browser isn't installed/);
    installBrowserFor(p);
    const ok = runPlan(p, 'mixed.yaml');
    assert.equal(ok.run.state, 'passed', ok.shown);
    assert.equal((await app.state()).sessions.length, 4, "one HTTP sign-in each, the browser used the member's");
    fs.mkdirSync(path.join(p.env.HOME, '.fake-playwright'), { recursive: true });
    fs.writeFileSync(path.join(p.env.HOME, '.fake-playwright', 'knobs.json'), JSON.stringify({ launchFails: true }));
    const broken = runPlan(p, 'mixed.yaml');
    assert.deepEqual(broken.run.steps.map((s) => s.status), ['passed', 'incomplete', 'passed']);
    assert.match(broken.shown, /the browser didn't start \(browserType\.launch: Executable doesn't exist/);
  } finally {
    await app.close();
    p.cleanup();
  }
});
