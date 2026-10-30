// The tester (docs/design/tester.md): acceptance plans read in a strict YAML subset, the tester's settings and the
// guard's words for them, the HTTP client's reach, what evidence keeps, the personas' sign-ins sealed on this PC and kept
// out of everything that leaves it, and whole runs through the hub against a stand-in web app (test/stubs/webapp.mjs)
// with three test accounts; part 2, the browser: its install, its proxy, and runs in the stand-in Playwright
// (test/stubs/playwright), which does with the network what a browser does and reads pages without drawing them; part 3,
// cards closed on proof; part 4, schedules, the Team page's switch and persona form, a fix that changes its own plan.
//   npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_DENIED, judge, planPathProblem, readPlan } from '../src/lib/acceptance.mjs';
import { changesWords, failedStep, fixDraft, planChanges, resultKey, specAcceptance, versionNames } from '../src/lib/acceptloop.mjs';
import { acceptState, acceptWords, awaitsOwner, eventsOf, eventWords } from '../src/lib/cards.mjs';
import { pathOnly, safeHeaders, safeJson, safeRecord, safeText } from '../src/lib/evidence.mjs';
import { personaHold, reportSecrets } from '../src/lib/redact.mjs';
import { everyMinutes, mergeTester, testerChangeWords } from '../src/lib/testerconfig.mjs';
import { guardDir, guardStore } from '../src/lib/guard.mjs';
import { resolverRules } from '../src/lib/testerbrowser.mjs';
import { cookieJar, isSpecialAddress, reachOf, request, urlProblem } from '../src/lib/testernet.mjs';
import { startProxy } from '../src/lib/testerproxy.mjs';
import { DPAPI_OPEN, DPAPI_SEAL, forgetCache, listPersonas, readPersona, redactionValues, setPersona, systemPowerShellPath, vaultFile } from '../src/lib/vault.mjs';
import { parseYamlSubset } from '../src/lib/yamlsub.mjs';
import { notify } from '../src/notify.mjs';
import { makeProject, waitUntil } from './helpers.mjs';
import { client, request as uiRequest, startUi, stopUi } from './ui-helpers.mjs';
import { SPA_TOKEN, startWebApp, USERS } from './stubs/webapp.mjs';

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

test("a token a single-page app keeps in the browser's storage is kept out of everything; a frame that shows a password, or can't be read, keeps the picture out", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { extra: { signIn: BROWSER_SIGN_IN } });
  try {
    installBrowserFor(p);
    setAll(p, app.url);
    fs.writeFileSync(
      path.join(p.env.HOME, '.fake-playwright', 'knobs.json'),
      JSON.stringify({
        storage: { [new URL(app.url).origin]: { token: SPA_TOKEN, theme: 'dark' }, 'http://other.test': { theirs: 'other-origin-value-0123456789' } },
        frames: [
          { on: '/framed-closed', unreadable: true },
          { on: '/framed', html: `<p>a widget</p><input id="pw" value="${USERS.member.password}">` },
        ],
      }),
    );
    commitPlan(p, 'spa.yaml', `plan: single-page-app
steps:
  - as: member
    do: { open: /spa }
    expect: { text: "token:" }
  - as: member
    do: { open: /framed }
    expect: { text: A page with a frame }
  - as: admin
    do: { open: /framed-closed }
    expect: { text: A page with a frame }
`);
    const { id, run, evidence, shown, hub } = runPlan(p, 'spa.yaml');
    assert.equal(run.state, 'passed', shown);
    const files = fs.readdirSync(p.state('evidence', id));
    const pictures = files.filter((f) => f.endsWith('.png')).map((f) => fs.readFileSync(p.state('evidence', id, f), 'latin1')).join('\n');
    const kept = [evidence, pictures, shown, hub.out, fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), JSON.stringify(run)].join('\n');
    assert.ok(!kept.includes(SPA_TOKEN), "the app's token from its storage");
    assert.ok(!kept.includes(USERS.member.password));
    const spa = JSON.parse(fs.readFileSync(p.state('evidence', id, 'step-1.json'), 'utf8'));
    assert.match(spa.text, /token: \*\*\*/);
    assert.equal(spa.screenshot, 'step-1.png', 'the token masked where the page shows it');
    const framed = JSON.parse(fs.readFileSync(p.state('evidence', id, 'step-2.json'), 'utf8'));
    assert.match(framed.screenshot, /a value the run keeps out is in a frame on the page: the screenshot isn't kept/);
    assert.ok(!files.includes('step-2.png'));
    const closed = JSON.parse(fs.readFileSync(p.state('evidence', id, 'step-3.json'), 'utf8'));
    assert.match(closed.screenshot, /a frame on the page couldn't be read: the screenshot isn't kept/);
    assert.ok(!files.includes('step-3.png'));
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

// ---------- part 3: closing the loop on cards ----------
const handoff = (p) => JSON.parse(fs.readFileSync(p.state('handoff.json'), 'utf8')).items;
const cardOf = (p, id) => handoff(p).find((x) => x.id === id);
const hubLog = (p) => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
const roundsOf = (p) => JSON.parse(fs.readFileSync(p.state('rounds.json'), 'utf8'));
// The orchestrator's card with a plan: the request in a file, as ORCHESTRATOR.md says
function addCard(p, plan, { text = 'The notes page shows who may read a note.' } = {}) {
  fs.mkdirSync(p.state(), { recursive: true });
  fs.writeFileSync(p.state('request.md'), `${text}\nWhere: the notes page\nWhy: the feature is done\n`);
  const r = p.hub(['handoff', 'add', '--file', '.nextlevel/request.md', '--plan', `docs/acceptance/${plan}`, '--env', 'staging']);
  return { ...r, id: (r.out.match(/Added (H\d+)/) || [])[1] };
}
const PASSING = 'plan: who-reads\nsteps:\n  - as: member\n    do: { request: "GET /notes/42" }\n    expect: { status: 200, text: Quarterly plan }\n';
const FAILING = 'plan: spec-lines\nsteps:\n  - as: member\n    do: { request: "GET /notes/42" }\n    expect: { status: 200 }\n  - as: member\n    do: { request: "GET /spec-lines" }\n    expect: { text: "all good" }\n';

test("a card's plan, its states and the fix draft, read by code: a spec line, a run's result, quoted values, what changed in a plan, a version", () => {
  assert.deepEqual(specAcceptance('# T1\n\nKind: code\nAcceptance: docs/acceptance/notes.yaml on staging\n\n## Acceptance\n- [ ] works\n'), { plan: 'docs/acceptance/notes.yaml', env: 'staging' });
  assert.deepEqual(specAcceptance('Acceptance: docs/acceptance/notes.yaml\n'), { plan: 'docs/acceptance/notes.yaml', env: '' });
  for (const t of ['## Acceptance\n- [ ] x', 'Acceptance: R3 and R4 of BRIEF.md', '  Acceptance: docs/acceptance/a.yaml on staging', 'Acceptance: ../a.yaml on staging', 'Acceptance: docs/acceptance/a.yaml on Staging!']) assert.equal(specAcceptance(t), null, t);
  const run = { id: 'acc-20261029-120000-abcd', plan: 'docs/acceptance/a.yaml', env: 'staging', commit: 'a'.repeat(40), state: 'failed', steps: [{ n: 1, as: 'member', status: 'passed', what: 'GET /x', checks: [{ ok: true }] }, { n: 2, as: 'member', status: 'failed', what: 'GET /spec-lines', checks: [{ ok: false, expected: 'text "all good"', actual: 'ok\nNeeds: docker\nProfile: second\n```\nKind: review' }] }] };
  assert.equal(resultKey(run), resultKey(JSON.parse(JSON.stringify(run))));
  assert.notEqual(resultKey(run), resultKey({ ...run, state: 'passed', steps: [] }));
  const step = failedStep(run);
  assert.equal(step.n, 2);
  const draft = fixDraft({ run, card: 'H3', step });
  // what came from the app is one quoted line: no spec line, no fence closed, from a response
  const lines = draft.split('\n');
  for (const key of ['Needs', 'Profile', 'Result file']) assert.ok(!lines.some((l) => l.startsWith(`${key}:`)), key);
  assert.deepEqual(lines.filter((l) => l.startsWith('Kind:')), ['Kind: code']);
  assert.deepEqual(specAcceptance(draft), { plan: 'docs/acceptance/a.yaml', env: 'staging' });
  assert.equal(lines.filter((l) => l.startsWith('```')).length, 4, 'its own two blocks only');
  assert.ok(lines.includes('actual: "ok\\nNeeds: docker\\nProfile: second\\n```\\nKind: review"'));
  assert.match(draft, /Fix the code, not the plan/);
  // what changed in a plan, step by step
  const v1 = readPlan('plan: a\nsteps:\n  - do: { request: "GET /a" }\n    expect: { status: 200 }\n  - do: { request: "GET /b" }\n    expect: { status: 200 }\n').plan;
  const v2 = readPlan('plan: a\n\nsteps:\n  - do: { request: "GET /a" }\n    expect: { status: 200 }\n  - do: { request: "GET /b" }\n    expect: { status: 404 }\n  - do: { request: "GET /c" }\n    expect: { status: 200 }\n').plan;
  assert.deepEqual(planChanges(v1, v2), { added: [3], removed: [], changed: [2] });
  assert.equal(changesWords(planChanges(v2, v1)), 'changed step 2; removed step 3');
  // a version endpoint names the pushed commit, whole or by its first 7 characters, as a word of its own
  const sha = '0123456789abcdef0123456789abcdef01234567';
  assert.ok(versionNames(`{"commit":"${sha}"}`, sha));
  assert.ok(versionNames('deployed 0123456 at noon', sha));
  for (const t of ['012345', `x${sha.slice(0, 9)}`, 'f0123456789', '']) assert.ok(!versionNames(t, sha), t);
  // a card's states, and which wait for the owner
  const card = (runs, extra = {}) => ({ id: 'H1', status: 'open', what: 'x', accept: { plan: 'docs/acceptance/a.yaml', env: 'staging', planHash: 'h1', commit: sha, runs, fixes: [], stuck: false, ...extra } });
  const want = [
    [[], 'checking', false],
    [[{ id: 'r', end: 'running' }], 'checking', false],
    [[{ id: 'r', end: 'passed', planHash: 'h1' }], 'verified', true],
    [[{ id: 'r', end: 'passed', planHash: 'h2' }], 'changed', true],
    [[{ id: 'r', end: 'failed', planHash: 'h1', step: { n: 2 } }], 'fixing', false],
    [[{ id: 'r', end: 'incomplete', why: 'the environment did not answer' }], 'blocked', true],
    [[{ id: 'r', end: 'refused', why: 'the hourly cap' }], 'blocked', true],
  ];
  for (const [runs, state, owner] of want) {
    assert.equal(acceptState(card(runs)).state, state, state);
    assert.equal(awaitsOwner(card(runs)), owner, state);
  }
  assert.equal(acceptState(card([{ id: 'r', end: 'failed', step: { n: 2 } }], { stuck: true })).state, 'stuck');
  assert.match(acceptWords(card([{ id: 'r', end: 'failed', step: { n: 2, as: 'member', what: 'GET /x' } }], { fixes: [{ run: 'r', step: 2, file: '.nextlevel/tester/fixes/r.md' }] })), /step 2 \(as member\) failed: GET \/x; a fix draft waits in \.nextlevel\/tester\/fixes\/r\.md/);
  assert.equal(acceptState({ id: 'H2', status: 'open' }), null, 'a card without a plan');
  assert.equal(awaitsOwner({ id: 'H2', status: 'open' }), true);
  // a card the tester closed: its event, and the words for it
  const closed = { id: 'H1', status: 'done', closedBy: 'tester', note: 'run r', doneAt: '2026-10-29T10:00:00Z' };
  assert.deepEqual(eventsOf(closed).map((e) => [e.kind, e.by, e.note]), [['closed', 'tester', 'run r']]);
  assert.match(eventWords(eventsOf(closed)[0], () => 'then'), /^Verified and closed by the tester then \(run r\)$/);
});

test('a card with a plan: added with the plan the base branch has, checked by the tester with no owner click, Verified on a pass; with autoClose, closed by the tester and reopened by the owner', async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false });
  try {
    setAll(p, app.url);
    // refusals: a plan that isn't committed, an environment nextlevel.json doesn't have, half of the pair
    assert.match(addCard(p, 'who-reads.yaml').out, /the card wasn't added: docs\/acceptance\/who-reads\.yaml isn't committed on main/);
    commitPlan(p, 'who-reads.yaml', PASSING);
    fs.writeFileSync(p.state('request.md'), 'x\nWhere: y\nWhy: z\n');
    assert.match(p.hub(['handoff', 'add', '--file', '.nextlevel/request.md', '--plan', 'docs/acceptance/who-reads.yaml', '--env', 'prod']).out, /no environment prod/);
    assert.match(p.hub(['handoff', 'add', '--file', '.nextlevel/request.md', '--plan', 'docs/acceptance/who-reads.yaml']).out, /both, or neither/);
    assert.ok(!fs.existsSync(p.state('handoff.json')) || handoff(p).length === 0, 'no card');

    const add = addCard(p, 'who-reads.yaml');
    assert.equal(add.code, 0, add.out);
    assert.match(add.out, /The hub runs it \(acc-\d{8}-\d{6}-[0-9a-f]{4}\)/);
    assert.match(add.out, /Don't tell the owner yet/);
    let card = cardOf(p, add.id);
    assert.equal(card.accept.plan, 'docs/acceptance/who-reads.yaml');
    assert.match(card.accept.planHash, /^[0-9a-f]{64}$/);
    assert.equal(acceptState(card).state, 'checking');
    assert.equal(awaitsOwner(card), false, 'the tester is checking it: not the owner\'s yet');

    const hub = p.runUntilIdle([], { extraEnv: vaultEnv(p) });
    assert.equal(hub.code, 0, hub.out);
    card = cardOf(p, add.id);
    const last = card.accept.runs.at(-1);
    assert.equal(last.end, 'passed', hubLog(p));
    assert.equal(last.by, 'card');
    assert.equal(acceptState(card).state, 'verified');
    assert.equal(card.status, 'open', 'autoClose is off: the owner closes it');
    assert.equal(awaitsOwner(card), true);
    assert.match(hubLog(p), new RegExp(`tester: phone: .*${add.id} verified`));
    // the run's end is a real event, and waits to start a round
    const rs = roundsOf(p);
    assert.ok(rs.pending.some((t) => t.type === 'accept' && /ended \(passed\)/.test(t.what)), JSON.stringify(rs.pending));
    assert.match(rs.real.what, /acceptance run/);
    // what the team reads, and the Markdown
    assert.match(p.hub(['handoff', 'list']).out, new RegExp(`acceptance: docs/acceptance/who-reads\\.yaml on staging: verified by run ${last.id}: ready to close`));
    assert.match(fs.readFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), 'utf8'), /- Acceptance: docs\/acceptance\/who-reads\.yaml on staging: verified by run/);

    // autoClose on: the next card's pass closes it, as the tester; the owner's Reopen undoes it
    p.setConfig((c) => ({ ...c, tester: { ...c.tester, autoClose: true } }));
    const two = addCard(p, 'who-reads.yaml', { text: 'Who may read a note, again.' });
    assert.equal(two.code, 0, two.out);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    card = cardOf(p, two.id);
    assert.equal(card.status, 'done', hubLog(p));
    assert.equal(card.closedBy, 'tester');
    assert.deepEqual(eventsOf(card).map((e) => [e.kind, e.by]), [['closed', 'tester']]);
    assert.match(fs.readFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), 'utf8'), /Verified and closed by the tester .* \(run acc-/);
    assert.match(hubLog(p), new RegExp(`${two.id} is verified and closed by the tester`));
    // (the first card, open and verified, followed this run too: with autoClose on, it is closed as well)
    assert.equal(cardOf(p, add.id).closedBy, 'tester');
    const again = p.hub(['handoff', 'reopen', two.id]);
    assert.equal(again.code, 0, again.out);
    assert.equal(cardOf(p, two.id).status, 'open');
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("a card's plan fails: a fix draft from code for the orchestrator, quoting what the app said; after maxFixes, no more drafts and the card waits for the owner; a changed plan's pass never verifies", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false, extra: { maxFixes: 1 } });
  try {
    setAll(p, app.url);
    commitPlan(p, 'permissions-for-members-and-outsiders.yaml', FAILING);
    // (a plan whose path is over 40 characters: the draft's Acceptance: line must still name it whole)
    const add = addCard(p, 'permissions-for-members-and-outsiders.yaml');
    assert.equal(add.code, 0, add.out);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    let card = cardOf(p, add.id);
    const first = card.accept.runs.at(-1);
    assert.equal(first.end, 'failed', hubLog(p));
    assert.equal(first.step.n, 2);
    assert.equal(acceptState(card).state, 'fixing');
    assert.equal(awaitsOwner(card), false, "the team's to fix");
    const fix = card.accept.fixes.at(-1);
    assert.equal(fix.file, `.nextlevel/tester/fixes/${first.id}.md`);
    const draft = fs.readFileSync(path.join(p.repo, fix.file), 'utf8');
    assert.ok(!draft.split('\n').some((l) => /^(Needs|Profile|Result file):/.test(l)), draft);
    assert.match(draft, /^actual: ".*Needs: docker.*"$/m);
    assert.deepEqual(specAcceptance(draft), { plan: 'docs/acceptance/permissions-for-members-and-outsiders.yaml', env: 'staging' });
    for (const n of Object.keys(USERS)) assert.ok(!draft.includes(USERS[n].password));
    assert.match(p.hub(['handoff', 'list']).out, /step 2 \(as member\) failed: GET \/spec-lines; a fix draft waits in \.nextlevel\/tester\/fixes\//);
    assert.ok(roundsOf(p).pending.some((t) => t.type === 'accept'));

    // the same failure again from the owner's run: the draft still waits, nothing more is written or counted
    const again = runPlan(p, 'permissions-for-members-and-outsiders.yaml');
    assert.equal(again.run.state, 'failed');
    card = cardOf(p, add.id);
    assert.equal(acceptState(card).state, 'fixing');
    assert.equal(card.accept.fixes.length, 1);
    assert.match(hubLog(p), /still fails; H\d+'s fix draft .* still waits for the team/);
    // a task's merge whose spec names the plan, and the step still fails: one draft was the most (tester.maxFixes), so the
    // card waits for the owner
    p.git('checkout', '-qb', 'task/F1');
    fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', 'F1.md'), '# F1\n\nKind: code\nAcceptance: docs/acceptance/permissions-for-members-and-outsiders.yaml on staging\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'F1: the fix that fixes nothing');
    p.git('checkout', '-q', 'main');
    fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
    const m = p.hub(['merge', 'F1', '--no-wait']);
    fs.rmSync(p.state('hub.json'), { force: true });
    assert.equal(m.code, 0, m.out);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    card = cardOf(p, add.id);
    assert.equal(card.accept.runs.at(-1).by, 'task', JSON.stringify(card.accept.runs));
    assert.equal(acceptState(card).state, 'stuck');
    assert.equal(card.accept.fixes.length, 1);
    assert.equal(awaitsOwner(card), true);
    assert.match(hubLog(p), /still fails after 1 fix draft\(s\).*no more drafts/);
    assert.match(hubLog(p), new RegExp(`tester: phone: .*${add.id} needs you`));

    // A card added with a plan that changes before its run: the pass is the new plan's, and it never verifies
    commitPlan(p, 'who-reads.yaml', PASSING);
    const changed = addCard(p, 'who-reads.yaml', { text: 'Readers, with a plan that changes.' });
    commitPlan(p, 'who-reads.yaml', `${PASSING}  - as: admin\n    do: { request: "GET /notes/42" }\n    expect: { status: 200 }\n`);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    card = cardOf(p, changed.id);
    assert.equal(card.accept.runs.at(-1).end, 'passed', hubLog(p));
    assert.equal(acceptState(card).state, 'changed');
    assert.equal(card.status, 'open');
    assert.match(p.hub(['handoff', 'show', changed.id]).out, /the plan changed since the card was added/);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("after a task's merge and after a deploy: a spec's Acceptance line runs its plan once the environment has the merge; a deploy waits for the version endpoint to name the pushed commit, or its wait; a deploy's new failure tells the phone", async () => {
  const versionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-version-'));
  const versionFile = path.join(versionDir, 'version');
  fs.writeFileSync(versionFile, 'old');
  const app = await startWebApp({ versionFile });
  const p = testerProject(app, { mutations: false });
  const clock = path.join(p.tmp, 'clock.json');
  const at = (iso) => fs.writeFileSync(clock, JSON.stringify({ at: iso }));
  const hubEnv = () => ({ ...vaultEnv(p), NEXTLEVEL_TEST_CLOCK: clock });
  try {
    at('2026-10-29T10:00:00Z');
    setAll(p, app.url);
    commitPlan(p, 'who-reads.yaml', PASSING);
    // a task branch whose spec names the plan; staging is deployed by no branch yet: the run follows the merge
    const task = (id, env = 'staging') => {
      p.git('checkout', '-qb', `task/${id}`);
      fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', `${id}.md`), `# ${id}\n\nKind: code\nAcceptance: docs/acceptance/who-reads.yaml on ${env}\n`);
      p.git('add', '-A');
      p.git('commit', '-qm', `${id}: the spec`);
      p.git('checkout', '-q', 'main');
      // (a git job is queued only while a hub runs: one is said to, for the command, and runUntilIdle runs it)
      fs.mkdirSync(p.state(), { recursive: true });
      fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
      const m = p.hub(['merge', id, '--no-wait']);
      fs.rmSync(p.state('hub.json'), { force: true });
      assert.equal(m.code, 0, m.out);
    };
    task('T1');
    assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
    assert.match(hubLog(p), /tester: task T1 merged: docs\/acceptance\/who-reads\.yaml runs on staging/);
    const byTask = listRunsOf(p).find((r) => r.by === 'task');
    assert.ok(byTask && byTask.task === 'T1' && byTask.state === 'passed', JSON.stringify(listRunsOf(p)));

    // now a branch deploys staging (a branch that isn't a deploy branch: no approval needed for the test's push)
    p.setConfig((c) => ({ ...c, deployBranches: ['prod'], tester: { ...c.tester, afterDeploy: { release: ['staging'] }, environments: { staging: { ...c.tester.environments.staging, version: '/version' } } } }));
    p.git('add', '-A');
    p.git('commit', '-qm', 'staging is deployed from release');
    // (the owner's own settings, on origin already: a push that changed nextlevel.json would wait for their approval)
    p.git('push', '-q', 'origin', 'main');
    task('T2');
    assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
    assert.match(hubLog(p), /task T2 merged: docs\/acceptance\/who-reads\.yaml runs on staging after the deploy that carries it/);
    const before = listRunsOf(p).length;
    const sha = p.git('rev-parse', 'main').trim();
    assert.equal(p.hub(['push', 'release']).code, 0);
    assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
    assert.match(hubLog(p), /tester: release went out at .*: acceptance runs on staging once it is deployed/);
    assert.equal(listRunsOf(p).length, before, 'the version endpoint still names the old commit: nothing runs');
    // the endpoint is asked at most every 30 s: the commit it names now is seen at the next ask
    fs.writeFileSync(versionFile, sha);
    at('2026-10-29T10:00:10Z');
    assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
    assert.equal(listRunsOf(p).length, before, 'not asked again yet');
    at('2026-10-29T10:00:45Z');
    assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
    assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
    assert.match(hubLog(p), new RegExp(`staging answers ${sha.slice(0, 7)} at /version`));
    assert.match(hubLog(p), /release at .* is deployed to staging: 1 acceptance plan\(s\) run, after task\(s\) T2/);
    const after = listRunsOf(p).filter((r) => r.by === 'task' && r.task === 'T2');
    assert.equal(after.length, 1, 'the plan the task named, as the task\'s run');
    assert.equal(after[0].state, 'passed');

    // a deploy whose plan fails anew: the phone hears it, once
    commitPlan(p, 'spec-lines.yaml', FAILING);
    const sha2 = p.git('rev-parse', 'main').trim();
    fs.writeFileSync(versionFile, sha2);
    assert.equal(p.hub(['push', 'release']).code, 0);
    at('2026-10-29T10:05:00Z');
    for (let i = 0; i < 3; i++) assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
    const deploys = listRunsOf(p).filter((r) => r.by === 'deploy');
    assert.deepEqual(deploys.map((r) => [r.plan, r.state]).sort(), [['docs/acceptance/spec-lines.yaml', 'failed'], ['docs/acceptance/who-reads.yaml', 'passed']], hubLog(p));
    assert.equal(hubLog(p).match(/tester: phone: .*acceptance failed after the deploy/g)?.length, 1);
  } finally {
    await app.close();
    p.cleanup();
    fs.rmSync(versionDir, { recursive: true, force: true });
  }
});
const listRunsOf = (p) => {
  const dir = p.state('evidence');
  return (fs.existsSync(dir) ? fs.readdirSync(dir) : []).map((n) => JSON.parse(fs.readFileSync(path.join(dir, n, 'run.json'), 'utf8')));
};

test("the tester off: a card with a plan isn't added; the orchestrator's cap holds a card's run like its own", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false, extra: { maxRunsPerHour: 1 } });
  try {
    setAll(p, app.url);
    commitPlan(p, 'who-reads.yaml', PASSING);
    assert.equal(addCard(p, 'who-reads.yaml').code, 0);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    const over = addCard(p, 'who-reads.yaml', { text: 'Once more.' });
    assert.notEqual(over.code, 0);
    assert.match(over.out, /the card wasn't added: the tester ran 1 runs of docs\/acceptance\/who-reads\.yaml on staging in the last hour \(tester\.maxRunsPerHour is 1\)/);
    p.setConfig((c) => ({ ...c, tester: { ...c.tester, enabled: false } }));
    const off = addCard(p, 'who-reads.yaml', { text: 'With the tester off.' });
    assert.notEqual(off.code, 0);
    assert.match(off.out, /the card wasn't added: The tester is off/);
    assert.equal(handoff(p).length, 1);
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("the dashboard's tester: the committed plans, a run's table and its evidence with the page's key only, the owner's Run acceptance, and a verified card's Close on Home", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false });
  let ui = null;
  try {
    setAll(p, app.url);
    commitPlan(p, 'who-reads.yaml', PASSING);
    const card = addCard(p, 'who-reads.yaml');
    assert.equal(card.code, 0, card.out);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    const done = listRunsOf(p).find((r) => r.by === 'card');
    assert.equal(done?.state, 'passed', hubLog(p));
    ui = await startUi(p, vaultEnv(p));
    const c = client(ui);
    const view = (await c.get('/api/tester')).json;
    assert.equal(view.ok, true);
    assert.deepEqual(view.plans.map((x) => [x.file, x.envs]), [['docs/acceptance/who-reads.yaml', ['staging']]]);
    assert.ok(view.runs.some((r) => r.id === done.id));
    const run = (await c.get(`/api/tester/run?id=${done.id}`)).json.run;
    assert.deepEqual(run.files, ['step-1.json']);
    assert.equal(run.steps[0].status, 'passed');
    const rec = await c.get(`/api/tester/evidence?id=${done.id}&file=step-1.json`);
    assert.equal(rec.json.record.status, 200);
    // the key or nothing; a step's files and nothing else
    assert.notEqual((await uiRequest(ui.port, { path: `/api/tester/evidence?id=${done.id}&file=step-1.json` })).status, 200);
    assert.notEqual((await uiRequest(ui.port, { path: '/api/tester' })).status, 200);
    for (const file of ['run.json', '../run.json', 'step-1.json.bak']) assert.equal((await c.get(`/api/tester/evidence?id=${done.id}&file=${encodeURIComponent(file)}`)).status, 404, file);
    // a picture comes as one
    fs.writeFileSync(p.state('evidence', done.id, 'step-1.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const png = await uiRequest(ui.port, { path: `/api/tester/evidence?id=${done.id}&file=step-1.png`, headers: { 'x-nextlevel-token': ui.token } });
    assert.equal(png.status, 200);
    assert.equal(png.headers['content-type'], 'image/png');
    // Home: the verified card's Close
    const need = (await c.get('/api/state')).json.needs.find((n) => n.kind === 'accept' && n.id === card.id);
    assert.ok(need, JSON.stringify((await c.get('/api/state')).json.needs));
    assert.equal(need.action.label, 'Close');
    // a card whose fix draft waits: under What needs you only while autopilot is off (no one else picks the draft up)
    commitPlan(p, 'spec-lines.yaml', FAILING);
    const fixing = addCard(p, 'spec-lines.yaml', { text: 'The spec lines page says all good.' });
    assert.equal(fixing.code, 0, fixing.out);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    assert.equal(acceptState(cardOf(p, fixing.id)).state, 'fixing', hubLog(p));
    const fixNeed = async () => (await c.get('/api/state')).json.needs.find((n) => n.kind === 'accept' && n.id === fixing.id);
    await waitUntil('the fixing card under What needs you, autopilot off', async () => !!(await fixNeed()));
    assert.match((await fixNeed()).text, /a fix draft waits for the orchestrator, and autopilot is off/);
    fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: true }));
    await waitUntil('the fixing card off What needs you, autopilot on', async () => !(await fixNeed()));
    fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: false }));
    // Run acceptance: a committed plan on a named environment, the owner's run; anything else refused
    assert.equal((await c.post('/api/tester', { action: 'run', plan: 'docs/acceptance/none.yaml', env: 'staging' })).status, 409);
    assert.equal((await c.post('/api/tester', { action: 'run', plan: 'docs/acceptance/who-reads.yaml', env: 'prod' })).status, 409);
    assert.equal((await c.post('/api/tester', { action: 'delete', plan: 'docs/acceptance/who-reads.yaml', env: 'staging' })).status, 400);
    const asked = await c.post('/api/tester', { action: 'run', plan: 'docs/acceptance/who-reads.yaml', env: 'staging' });
    assert.equal(asked.status, 200, asked.text);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    const mine = listRunsOf(p).find((r) => r.id === asked.json.id);
    assert.equal(mine?.by, 'owner');
    assert.equal(mine.state, 'passed');
  } finally {
    await stopUi(ui);
    await app.close();
    p.cleanup();
  }
});

test("the page: a run loaded while the Notes page shows redraws the cards, where a card's last run is drawn; a details drawn open doesn't redraw again", async () => {
  const app = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'app.js'), 'utf8');
  const src = app.match(/^async function loadRun\(id, force = false\) \{\n[\s\S]*?\n\}\n/m)?.[0];
  assert.ok(src, 'loadRun in app.js');
  const vm = await import('node:vm');
  for (const tab of ['notes', 'home']) {
    const calls = [];
    const ctx = vm.createContext({ tst: { runs: new Map(), loadingRun: new Set() }, api: async () => ({ ok: true, run: { id: 'acc-1', steps: [] } }), renderAll: () => calls.push('all'), renderCards: () => calls.push('cards'), currentTab: () => tab });
    vm.runInContext(`${src}\nglobalThis.loadRun = loadRun;`, ctx);
    await ctx.loadRun('acc-1');
    assert.deepEqual(calls, tab === 'notes' ? ['all', 'cards'] : ['all'], tab);
    assert.equal(ctx.tst.runs.get('acc-1').id, 'acc-1');
  }
  // the card's and the Acceptance card's details: a toggle of one already marked open (drawn open) redraws nothing
  assert.match(app, /ontoggle: \(e\) => \(e\.currentTarget\.open \? !tst\.open\.has\(x\.id\) && \(tst\.open\.add\(x\.id\), renderCards\(\)\)/);
  assert.match(app, /ontoggle: \(e\) => \(e\.currentTarget\.open \? !tst\.open\.has\(r\.id\) && \(tst\.open\.add\(r\.id\), renderAll\(\)\)/);
});


// ---------- part 4: schedules, the Team page's switch and persona form, a fix that changes its own plan ----------
test("settings: a schedule runs from an hour to a week apart, on an environment the owner named, plans under docs/acceptance/; the guard's words", () => {
  const env = { staging: { url: 'https://staging.example.com' } };
  const merged = (schedule) => {
    const problems = { errors: [], warnings: [] };
    const t = mergeTester({ enabled: true, environments: env, personas: ['member'], schedule }, problems);
    return { t, problems };
  };
  assert.deepEqual([everyMinutes('90m'), everyMinutes('6h'), everyMinutes('1d'), everyMinutes('7d')], [90, 360, 1440, 10080]);
  for (const bad of ['30m', '59m', '8d', '6', 'h', '0h', '-1h', '1.5h', ' 6h', 6]) assert.equal(everyMinutes(bad), 0, String(bad));
  const ok = merged([{ every: '6h', env: 'staging' }, { every: '1d', env: 'staging', plans: ['docs/acceptance/a.yaml', 'docs/acceptance/a.yaml'] }]);
  assert.deepEqual(ok.problems, { errors: [], warnings: [] });
  assert.deepEqual(ok.t.schedule, [{ every: '6h', minutes: 360, env: 'staging', plans: [] }, { every: '1d', minutes: 1440, env: 'staging', plans: ['docs/acceptance/a.yaml'] }]);
  assert.deepEqual(merged(undefined).t.schedule, [], 'none by default');
  const errs = (schedule) => merged(schedule).problems.errors.join('\n');
  assert.match(errs([{ every: '30m', env: 'staging' }]), /schedule\[0\]\.every" is how often, from an hour to a week/);
  assert.match(errs([{ every: '6h', env: 'prod' }]), /schedule\[0\]\.env" names an environment/);
  for (const plans of [['docs/acceptance/../x.yaml'], ['notes/x.yaml'], ['docs/acceptance/x.sh'], 'docs/acceptance/x.yaml']) assert.match(errs([{ every: '6h', env: 'staging', plans }]), /schedule\[0\]\.plans" lists plans under docs\/acceptance\//, JSON.stringify(plans));
  assert.match(errs({ every: '6h' }), /"schedule" is a list/);
  assert.match(errs(Array.from({ length: 21 }, () => ({ every: '6h', env: 'staging' }))), /at most 20/);
  assert.deepEqual(merged([{ every: '6h', env: 'staging', when: 'night' }]).problems.warnings, ['unknown setting "tester.schedule[0].when" (ignored)']);
  const before = { enabled: true, environments: env, personas: ['member'] };
  assert.deepEqual(testerChangeWords(before, { ...before, schedule: [{ every: '6h', env: 'staging' }] }), ['runs every plan on staging every 6h']);
  assert.deepEqual(testerChangeWords({ ...before, schedule: [{ every: '6h', env: 'staging', plans: ['docs/acceptance/a.yaml'] }] }, before), ['no longer runs docs/acceptance/a.yaml on staging every 6h']);
});

test("a schedule: the first run one interval after the hub first sees it, none caught up after the hub stopped, a scheduled run's end a real event only when its result is new, a new failure tells the phone once", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false, extra: { schedule: [{ every: '6h', env: 'staging' }] } });
  const clock = path.join(p.tmp, 'clock.json');
  const at = (iso) => fs.writeFileSync(clock, JSON.stringify({ at: iso }));
  const hubEnv = () => ({ ...vaultEnv(p), NEXTLEVEL_TEST_CLOCK: clock });
  const run = () => assert.equal(p.runUntilIdle([], { extraEnv: hubEnv() }).code, 0);
  const scheduled = () => listRunsOf(p).filter((r) => r.by === 'schedule');
  const accepts = () => (fs.existsSync(p.state('rounds.json')) ? roundsOf(p).pending.filter((t) => t.type === 'accept').length : 0);
  try {
    setAll(p, app.url);
    commitPlan(p, 'who-reads.yaml', PASSING);
    at('2026-10-30T08:00:00Z');
    run();
    assert.deepEqual(scheduled(), [], 'nothing at once');
    const kept = inHome(p, () => JSON.parse(fs.readFileSync(path.join(guardDir(p.repo), 'tester-schedule.json'), 'utf8')));
    assert.deepEqual(kept, { 'staging every 6h: every plan': { next: '2026-10-30T14:00:00.000Z' } }, 'kept in the guard\'s folder');
    at('2026-10-30T13:59:00Z');
    run();
    assert.deepEqual(scheduled(), []);
    // the hub was stopped for three intervals: one run, not three
    at('2026-10-31T08:30:00Z');
    run();
    run();
    assert.deepEqual(scheduled().map((r) => [r.plan, r.state]), [['docs/acceptance/who-reads.yaml', 'passed']], hubLog(p));
    assert.match(hubLog(p), /tester: the schedule \(staging every 6h: every plan\): 1 acceptance plan\(s\) run/);
    assert.equal(accepts(), 1, 'the first result is new: a real event');
    assert.equal(inHome(p, () => JSON.parse(fs.readFileSync(path.join(guardDir(p.repo), 'tester-schedule.json'), 'utf8')))['staging every 6h: every plan'].next, '2026-10-31T14:30:00.000Z');
    // the same result again: no event; the round already noted stays one
    at('2026-10-31T14:30:00Z');
    run();
    run();
    assert.equal(scheduled().length, 2);
    assert.equal(accepts(), 1, 'the same pass again is no event');
    // a failure: the phone hears it once, and a real event; the same failure again neither
    commitPlan(p, 'spec-lines.yaml', FAILING);
    for (const t of ['2026-10-31T20:30:00Z', '2026-11-01T02:30:00Z']) {
      at(t);
      run();
      run();
    }
    const fails = scheduled().filter((r) => r.plan === 'docs/acceptance/spec-lines.yaml');
    assert.deepEqual(fails.map((r) => r.state), ['failed', 'failed'], hubLog(p));
    assert.equal(hubLog(p).match(/tester: phone: .*acceptance failed on its schedule/g)?.length, 1, hubLog(p));
    assert.equal(accepts(), 2);
    // the schedule is gone from nextlevel.json: its state goes with it, and nothing runs
    p.setConfig((c) => ({ ...c, tester: { ...c.tester, schedule: [] } }));
    at('2026-11-02T02:30:00Z');
    run();
    assert.equal(scheduled().length, 6);
    assert.deepEqual(inHome(p, () => JSON.parse(fs.readFileSync(path.join(guardDir(p.repo), 'tester-schedule.json'), 'utf8'))), {});
  } finally {
    await app.close();
    p.cleanup();
  }
});

test("the Team page's switch: nextlevel team tester on|off changes tester.enabled only, as the owner's change; refused without a section and in an agent's session", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false, extra: { enabled: false } });
  let ui = null;
  try {
    assert.match(p.hub(['team', 'tester']).out, /Tester: off \(environments staging, personas admin, member, outsider\)/);
    const agent = p.hub(['team', 'tester', 'on'], { extraEnv: { NEXTLEVEL_AGENT: 'orchestrator' } });
    assert.equal(agent.code, 1, agent.out);
    assert.match(agent.out, /nextlevel team tester on is the owner's, so it doesn't run in an agent's session/);
    assert.equal(p.config().tester.enabled, false);
    for (const bad of [['team', 'tester', 'maybe'], ['team', 'tester', 'on', 'now']]) assert.notEqual(p.hub(bad).code, 0, bad.join(' '));
    const before = p.config().tester;
    const on = p.hub(['team', 'tester', 'on']);
    assert.equal(on.code, 0, on.out);
    assert.match(on.out, /Saved: the tester is on/);
    assert.deepEqual(p.config().tester, { ...before, enabled: true }, 'nothing else of the section changes');
    // the owner's change: it goes in without a card
    fs.mkdirSync(p.state(), { recursive: true });
    fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
    const commit = p.hub(['commit', '-m', 'chore: the tester on', '--no-wait']);
    fs.rmSync(p.state('hub.json'), { force: true });
    assert.equal(commit.code, 0, commit.out);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    assert.doesNotMatch(hubLog(p), /held/);
    assert.match(p.git('show', '--name-only', '--format=%s', 'HEAD'), /^chore: the tester on\n+nextlevel\.json$/m);
    assert.match(p.hub(['team', 'tester', 'on']).out, /already on/);
    // While the orchestrator acts, a switch never approves its edit of the section with the owner's (a new schedule here)
    const watch = guardStore({ root: p.repo, home: p.env.HOME });
    watch.open('test:round', { what: 'a test round' });
    p.setConfig((cfg) => ({ ...cfg, tester: { ...cfg.tester, schedule: [] } }));
    const theirs = fs.readFileSync(path.join(p.repo, 'nextlevel.json'), 'utf8');
    const refused = p.hub(['team', 'tester', 'off']);
    assert.equal(refused.code, 1, refused.out);
    assert.match(refused.out, /nextlevel\.json changed while the orchestrator is at work, and you haven't approved that change: nothing was saved/);
    assert.equal(fs.readFileSync(path.join(p.repo, 'nextlevel.json'), 'utf8'), theirs);
    assert.equal(watch.check().held.length, 1, 'the watch holds it and sets it back');
    watch.close('test:round');
    // the dashboard's Turn off runs the same command
    ui = await startUi(p, vaultEnv(p));
    const c = client(ui);
    assert.equal((await c.post('/api/team', { tester: 'off' })).status, 400);
    const off = await c.post('/api/team', { tester: false });
    assert.equal(off.status, 200, off.text);
    assert.match(off.json.message, /the tester is off/);
    assert.equal(p.config().tester.enabled, false);
    assert.equal((await c.get('/api/tester')).json.section, true);
    // no section: nothing to turn on
    await stopUi(ui);
    ui = null;
    p.setConfig((cfg) => {
      const { tester, ...rest } = cfg;
      return rest;
    });
    const none = p.hub(['team', 'tester', 'on']);
    assert.equal(none.code, 1);
    assert.match(none.out, /no tester section: add one with its environments and personas first/);
    assert.equal(p.config().tester, undefined);
  } finally {
    await stopUi(ui);
    await app.close();
    p.cleanup();
  }
});

test("the Team page's persona form: the values in the request only, kept as nextlevel tester persona set keeps them; never logged, said back or kept in the page's data; the page's key or nothing", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false, extra: { enabled: false } });
  let ui = null;
  const password = USERS.member.password;
  try {
    ui = await startUi(p, vaultEnv(p));
    const c = client(ui);
    const form = (body) => c.post('/api/tester', body);
    // the page's key or nothing
    assert.notEqual((await uiRequest(ui.port, { method: 'POST', path: '/api/tester', body: { action: 'persona', env: 'staging', persona: 'member', values: { password } } })).status, 200);
    // the same checks as the command
    assert.equal((await form({ action: 'persona', env: 'staging', persona: 'member' })).status, 400);
    assert.equal((await form({ action: 'persona', env: '../x', persona: 'member', values: {} })).status, 400);
    assert.match((await form({ action: 'persona', env: 'prod', persona: 'member', values: { password } })).json.message, /no environment prod/);
    assert.match((await form({ action: 'persona', env: 'staging', persona: 'boss', values: { password } })).json.message, /no persona boss/);
    assert.match((await form({ action: 'persona', env: 'staging', persona: 'member', values: { password: 'short' } })).json.message, /at least 8 characters.*Nothing was kept/);
    assert.match((await form({ action: 'persona', env: 'staging', persona: 'member', values: { token: 'a-token-value-1234' } })).json.message, /doesn't use a token/);
    assert.match((await form({ action: 'persona', env: 'staging', persona: 'member', values: { password: `two\nlines-here` } })).json.message, /one line/);
    assert.match((await form({ action: 'persona', env: 'staging', persona: 'member', values: {} })).json.message, /nothing typed/);
    assert.deepEqual(inHome(p, () => listPersonas(p.repo)), [], 'nothing kept by a refusal');
    const set = await form({ action: 'persona', env: 'staging', persona: 'member', values: { username: USERS.member.email, password } });
    assert.equal(set.status, 200, set.text);
    assert.equal(set.json.message, 'Set member on staging (username, password), kept with the stand-in store.');
    const got = inHome(p, () => readPersona(p.repo, { env: 'staging', origin: app.url, persona: 'member' }));
    assert.deepEqual(got.values, { username: USERS.member.email, password });
    // Set again with the username left empty: refused, never a username dropped under "set"
    const half = await form({ action: 'persona', env: 'staging', persona: 'member', values: { password: `${password}-new` } });
    assert.equal(half.status, 409, half.text);
    assert.match(half.json.message, /type each one \(username left empty\).*Nothing was kept/);
    assert.deepEqual(inHome(p, () => readPersona(p.repo, { env: 'staging', origin: app.url, persona: 'member' })).values, { username: USERS.member.email, password });
    // the Team card's data: set, and no value
    const view = await c.get('/api/tester');
    assert.equal(view.json.environments[0].personas.find((x) => x.persona === 'member').set, true);
    assert.deepEqual(view.json.environments[0].fields, ['username', 'password']);
    assert.doesNotMatch(view.text, new RegExp(password));
    // a run uses it (the tester turned on by the owner)
    assert.equal(p.hub(['team', 'tester', 'on']).code, 0);
    commitPlan(p, 'who-reads.yaml', PASSING);
    const asked = await form({ action: 'run', plan: 'docs/acceptance/who-reads.yaml', env: 'staging' });
    assert.equal(asked.status, 200, asked.text);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    assert.equal(listRunsOf(p).find((r) => r.id === asked.json.id)?.state, 'passed', hubLog(p));
    // forget
    const gone = await form({ action: 'forget', env: 'staging', persona: 'member' });
    assert.equal(gone.json.message, 'Forgot member on staging.');
    assert.deepEqual(inHome(p, () => listPersonas(p.repo)), []);
    // the audit line says who did what, never a value; nothing anywhere has the password
    const audit = inHome(p, () => fs.readFileSync(path.join(guardDir(p.repo), 'tester.jsonl'), 'utf8'));
    assert.match(audit, /"by":"owner","from":"dashboard","persona":"set","env":"staging","personas":\["member"\],"fields":\["username","password"\]/);
    assert.match(audit, /"persona":"forget"/);
    const everywhere = [ui.out, audit, hubLog(p), ...listRunsOf(p).map((r) => JSON.stringify(r))].join('\n');
    assert.doesNotMatch(everywhere, new RegExp(password));
    for (const f of fs.readdirSync(p.state(), { recursive: true })) {
      const file = p.state(String(f));
      if (fs.statSync(file).isFile()) assert.doesNotMatch(fs.readFileSync(file, 'utf8'), new RegExp(password), String(f));
    }
  } finally {
    await stopUi(ui);
    await app.close();
    p.cleanup();
  }
});

test("a fix that changes its own plan: the merge is said in hub.log and on the task's run; a card added before reads changed, never verified", async () => {
  const app = await startWebApp();
  const p = testerProject(app, { mutations: false });
  try {
    setAll(p, app.url);
    commitPlan(p, 'who-reads.yaml', PASSING);
    const card = addCard(p, 'who-reads.yaml');
    assert.equal(card.code, 0, card.out);
    assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
    const merge = (id, { plan }) => {
      p.git('checkout', '-qb', `task/${id}`);
      fs.mkdirSync(path.join(p.repo, 'docs', 'tasks'), { recursive: true });
      fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', `${id}.md`), `# ${id}\n\nKind: code\nAcceptance: docs/acceptance/who-reads.yaml on staging\n`);
      if (plan) fs.writeFileSync(path.join(p.repo, 'docs', 'acceptance', 'who-reads.yaml'), plan);
      p.git('add', '-A');
      p.git('commit', '-qm', `${id}: the fix`);
      p.git('checkout', '-q', 'main');
      fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: process.pid, heartbeatAt: new Date().toISOString() }));
      const m = p.hub(['merge', id, '--no-wait']);
      fs.rmSync(p.state('hub.json'), { force: true });
      assert.equal(m.code, 0, m.out);
      assert.equal(p.runUntilIdle([], { extraEnv: vaultEnv(p) }).code, 0);
      return listRunsOf(p).find((r) => r.by === 'task' && r.task === id);
    };
    const plain = merge('T1', {});
    assert.equal(plain?.state, 'passed', hubLog(p));
    assert.equal(plain.planChanged, undefined);
    assert.doesNotMatch(hubLog(p), /T1's merge changes/);
    const easier = merge('T2', { plan: PASSING.replace('text: Quarterly plan', 'text: Quarterly') });
    assert.equal(easier?.state, 'passed', hubLog(p));
    assert.equal(easier.planChanged, true);
    assert.match(hubLog(p), /tester: task T2's merge changes docs\/acceptance\/who-reads\.yaml, the plan its Acceptance: line names: its run says so/);
    assert.equal(acceptState(cardOf(p, card.id)).state, 'changed', 'the plan the card was added with is not the one that passed');
    // (a team's request can't say it: only the hub's own folder carries planChanged)
    const page = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'ui', 'app.js'), 'utf8');
    assert.match(page, /run\.planChanged && run\.task \? h\('p\.small\.warn', \{\}, `Task \$\{run\.task\}'s merge changed this plan/);
    assert.match(page, /if \(!force && tform\.open && root\.querySelector\('form\.persona-form'\)\) return;/, "the Team page doesn't redraw under the persona form");
  } finally {
    await app.close();
    p.cleanup();
  }
});
