// Phone notifications (FR-004 #5): what reaches ntfy, through a stand-in ntfy server on this PC.
//   npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import { BIN, makeProject, withEnv } from './helpers.mjs';

// An ntfy server that keeps what it gets.
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
// `nextlevel ...` without blocking this process, which serves the stand-in ntfy.
const run = (p, args, extraEnv = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd: p.repo, env: withEnv(p.env, extraEnv) });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    child.on('close', (code) => resolve({ code, out }));
  });
// What a phone would turn into a link: a .md file name outside a link
const bareMd = (text) => text.replace(/https?:\/\/\S+/g, '').match(/[\w./-]+\.md\b/g);

test('notifications carry the request itself and never a bare .md file name; files become GitHub links (FR-004 #5)', async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    fs.writeFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), '# Handoff\n\n- [ ] Put the SMTP host in .env as SMTP_HOST (mail panel -> SMTP)\n- [x] Done already\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'docs: update HANDOFF.md');
    p.git('remote', 'set-url', 'origin', 'https://github.com/owner/app.git');
    const env = { NTFY_TOPIC: 'a-long-random-topic-for-tests-1234' };

    const now = await run(p, ['notify', '--now', 'Needs you: see HANDOFF.md', 'Details in docs/HANDOFF.md and BRIEF.md. Unknown notes.md too.', 'high'], env);
    assert.equal(now.code, 0, now.out);
    const [sent] = ntfy.got;
    assert.equal(sent.title, 'Needs you: see HANDOFF');
    assert.match(sent.message, /^Details in https:\/\/github\.com\/owner\/app\/blob\/main\/docs\/HANDOFF\.md and https:\/\/github\.com\/owner\/app\/blob\/main\/BRIEF\.md\. Unknown notes too\./);
    assert.match(sent.message, /Waiting on you:\n- Put the SMTP host in \.env as SMTP_HOST \(mail panel -> SMTP\)/, 'the request itself');
    assert.doesNotMatch(sent.message, /Done already/);
    assert.equal(sent.priority, 4);
    for (const text of [sent.title, sent.message]) assert.equal(bareMd(text), null, text);

    // Queued for the hub: the same text, made when the orchestrator asked
    const queued = await run(p, ['notify', 'Blocked', 'I added a handoff item.'], env);
    assert.equal(queued.code, 0, queued.out);
    const outbox = p.state('outbox');
    const [file] = fs.readdirSync(outbox);
    const m = JSON.parse(fs.readFileSync(path.join(outbox, file), 'utf8'));
    assert.match(m.message, /^I added a handoff item\.\n\nWaiting on you:\n- Put the SMTP host in \.env as SMTP_HOST .*\nhttps:\/\/github\.com\/owner\/app\/blob\/main\/docs\/HANDOFF\.md$/);

    // The daily report: commit subjects name files too
    const daily = await run(p, ['daily-report'], env);
    assert.equal(daily.code, 0, daily.out);
    const report = ntfy.got.at(-1);
    assert.match(report.message, /docs: update https:\/\/github\.com\/owner\/app\/blob\/main\/docs\/HANDOFF\.md/);
    assert.equal(bareMd(report.message), null, report.message);

    // Not on GitHub: the names lose ".md" and there is no link
    p.git('remote', 'set-url', 'origin', p.remote);
    await run(p, ['notify', '--now', 'x', 'See docs/HANDOFF.md'], env);
    assert.match(ntfy.got.at(-1).message, /^See docs\/HANDOFF\n\nWaiting on you:\n- Put the SMTP host/);
    assert.doesNotMatch(ntfy.got.at(-1).message, /https:/);
  } finally {
    await ntfy.close();
    p.cleanup();
  }
});

// FR-017: anyone who knows the ntfy topic reads what is sent, so a value from the project's .env never leaves the PC in a
// phone message. A made-up value, planted in each way a message is made.
test("every phone message goes out redacted like a report (FR-017): notify, notify --now, what an agent writes into the outbox, a handoff answer's message and the daily report never carry a value from .env", async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  const VALUE = ['phonetest', '5d2c81f0', 'value'].join('-');
  const TOPIC = 'a-long-random-topic-for-fr017-tests';
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    fs.writeFileSync(path.join(p.repo, '.env'), `SERVICE_TOKEN=${VALUE}\n`);
    const env = { NTFY_TOPIC: TOPIC }; // (the tests' sandbox sets it empty, which .env doesn't override)
    p.git('commit', '--allow-empty', '-qm', `M1: wire the service with ${VALUE}`); // (the daily report lists the day's commits)

    // notify --now, sent at once by the command
    const now = await run(p, ['notify', '--now', `Key ${VALUE}`, `The key is ${VALUE}; SERVICE_TOKEN=${VALUE}`], env);
    assert.equal(now.code, 0, now.out);
    // notify, queued for the hub
    assert.equal((await run(p, ['notify', 'Queued', `again ${VALUE}`], env)).code, 0);
    // written straight into the outbox, as an agent can (the orchestrator can write the state folder)
    fs.writeFileSync(p.state('outbox', 'zz-by-an-agent.json'), JSON.stringify({ title: `Raw ${VALUE}`, message: `raw message ${VALUE}`, priority: 'high', tags: '', attempts: 0 }));
    // a handoff card whose request carries it, answered by the team: the phone gets a message that names the card
    fs.writeFileSync(p.state('request.md'), `Rotate the key ${VALUE}\nWhere: the provider's panel\nWhy: it was in a log\n`);
    fs.writeFileSync(p.state('answer.md'), 'Done: the new one is in .env.\n');
    assert.equal((await run(p, ['handoff', 'add', '--file', '.nextlevel/request.md'])).code, 0);
    assert.equal((await run(p, ['handoff', 'answer', 'H1', '--file', '.nextlevel/answer.md'])).code, 0);
    // the hub sends what is queued; then the daily report
    const hub = await run(p, ['run', '--exit-when-idle', '--tick-ms', '200'], env);
    assert.equal(hub.code, 0, hub.out);
    assert.equal((await run(p, ['daily-report'], env)).code, 0);

    const titles = ntfy.got.map((m) => m.title);
    assert.deepEqual(titles.slice(0, 1), ['Key ***']);
    for (const t of ['Queued', 'Raw ***', 'proj: the team answered H1']) assert.ok(titles.includes(t), `${t}: ${JSON.stringify(titles)}`);
    assert.ok(titles.some((t) => /^proj daily: /.test(t)), JSON.stringify(titles));
    const byTitle = (t) => ntfy.got.find((m) => m.title === t);
    assert.equal(byTitle('Key ***').message, 'The key is ***; SERVICE_TOKEN=***');
    assert.equal(byTitle('Queued').message, 'again ***');
    assert.equal(byTitle('Raw ***').message, 'raw message ***');
    assert.match(byTitle('proj: the team answered H1').message, /^The team answered on card H1 \("Rotate the key \*\*\*"\)\./);
    assert.match(ntfy.got.find((m) => /^proj daily: /.test(m.title)).message, /M1: wire the service with \*\*\*/);
    for (const m of ntfy.got) {
      assert.ok(!`${m.title}\n${m.message}`.includes(VALUE), `a .env value in "${m.title}": ${m.message}`);
      assert.equal(m.topic, TOPIC, 'the topic itself is where it goes');
      assert.ok(!m.message.includes(TOPIC), 'and never in a message');
    }
  } finally {
    await ntfy.close();
    p.cleanup();
  }
});

test('a setting word stays readable in a phone message (FR-017): NODE_ENV=production leaves "production" in it, and API_TOKEN=production still blanks it out', async () => {
  const p = makeProject();
  const ntfy = await fakeNtfy();
  const env = { NTFY_TOPIC: 'a-long-random-topic-for-fr017-words' };
  try {
    p.setConfig((c) => ({ ...c, notifications: { server: ntfy.url } }));
    const send = async () => {
      const r = await run(p, ['notify', '--now', 'Deployed to production', 'production is up; NODE_ENV=production, LOG_LEVEL=info'], env);
      assert.equal(r.code, 0, r.out);
      return ntfy.got.at(-1);
    };
    fs.writeFileSync(path.join(p.repo, '.env'), 'NODE_ENV=production\nLOG_LEVEL=info\n');
    const plain = await send();
    assert.deepEqual([plain.title, plain.message], ['Deployed to production', 'production is up; NODE_ENV=production, LOG_LEVEL=info']);
    // the same word under a name that looks secret is a secret, wherever it appears
    fs.writeFileSync(path.join(p.repo, '.env'), 'NODE_ENV=production\nAPI_TOKEN=production\nLOG_LEVEL=info\n');
    const secret = await send();
    assert.deepEqual([secret.title, secret.message], ['Deployed to ***', '*** is up; NODE_ENV=***, LOG_LEVEL=info']);
  } finally {
    await ntfy.close();
    p.cleanup();
  }
});

test('one way to the phone (FR-017): nothing in src/ talks to ntfy but notify(), which redacts; every call of it names the project', () => {
  const src = path.join(path.dirname(BIN), '..', 'src');
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith('.mjs')) files.push(f);
    }
  };
  walk(src);
  const rel = (f) => path.relative(src, f).split(path.sep).join('/');
  // (src/ui/ is the dashboard's page: its fetch() asks the dashboard's own server)
  assert.deepEqual(files.filter((f) => /(?<![.\w])fetch\(/.test(fs.readFileSync(f, 'utf8'))).map(rel), ['notify.mjs'], 'only notify.mjs sends anything over the network (a fetch of its own; tool.fetch() is git)');
  // notify() refuses a call that doesn't say its project, so none can skip the .env's values by leaving it out
  const calls = [];
  for (const f of files) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/\bnotify\(([^;{}\n]*)\{([^}\n]*)\}\)/g)) {
      // (notify.mjs defines it; fix.mjs's notify is the caller's, passed in: the hub's and the CLI's name the project)
      if (['notify.mjs', 'fix.mjs'].includes(rel(f))) continue;
      assert.match(m[2], /\broot\b/, `${rel(f)}: notify(${m[1]}{${m[2]}}) names the project`);
      calls.push(rel(f));
    }
  }
  assert.deepEqual([...new Set(calls)].sort(), ['cli.mjs', 'daily-report.mjs', 'hub.mjs'], 'every place that sends to the phone was looked at');
});

test("the tests' switches never come from a project's .env (FR-019): an agent that writes one can't turn on the test clock or hooks", async () => {
  const { loadEnv } = await import('../src/notify.mjs');
  const p = makeProject();
  const names = ['NEXTLEVEL_TEST_STUBS_FROM_ENV', 'NEXTLEVEL_TEST_CLOCK_FROM_ENV', 'NEXTLEVEL_FROM_ENV_OK'];
  try {
    const file = path.join(p.repo, '.env');
    fs.writeFileSync(file, 'NEXTLEVEL_TEST_STUBS_FROM_ENV=1\nNEXTLEVEL_TEST_CLOCK_FROM_ENV=x\nNEXTLEVEL_FROM_ENV_OK=yes\n');
    assert.deepEqual(loadEnv(file), ['NEXTLEVEL_FROM_ENV_OK']);
    assert.deepEqual(names.map((n) => process.env[n]), [undefined, undefined, 'yes']);
  } finally {
    for (const n of names) delete process.env[n];
    p.cleanup();
  }
});
