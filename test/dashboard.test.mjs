// The dashboard (nextlevel ui), end to end: the real server on a sandbox project, spoken to over HTTP
// and server-sent events the way the page does, with stub CLIs. Nothing opens a browser or a window.
//   npm test
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { mergePath } from '../src/lib/proc.mjs';
import { BIN, REPO, fileExists, installedTool, isAlive, makeProject, processesGone, sleep, testClock, waitUntil, withEnv } from './helpers.mjs';
import { client, launchUi, linksIn, request, startUi, stopUi, trade } from './ui-helpers.mjs';

const IS_WIN = process.platform === 'win32';

// The page's live feed: `until(event, test)` waits for an event received from now on that passes `test`.
function feed(ui) {
  const got = [];
  const waiting = [];
  const req = http.get({ host: '127.0.0.1', port: ui.port, path: `/events`, headers: { 'x-nextlevel-token': ui.token }, agent: false }, (res) => {
    let buf = '';
    res.setEncoding('utf8');
    res.on('error', () => {}); // the dashboard stopping ends the feed
    res.on('data', (d) => {
      buf += d;
      for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.*)$/m.exec(chunk)?.[1];
        if (!event || !data) continue;
        const e = { event, data: JSON.parse(data), n: got.length };
        got.push(e);
        for (const w of [...waiting]) if (w.match(e)) w.done(e);
      }
    });
  });
  req.on('error', () => {});
  const until = (event, check = () => true, { since = 0, timeout = 90_000 } = {}) =>
    new Promise((resolve, reject) => {
      const match = (e) => e.event === event && e.n >= since && check(e.data);
      const hit = got.find(match);
      if (hit) return resolve(hit.data);
      const w = {
        match,
        done: (e) => {
          clearTimeout(w.timer);
          waiting.splice(waiting.indexOf(w), 1);
          resolve(e.data);
        },
      };
      w.timer = setTimeout(() => {
        waiting.splice(waiting.indexOf(w), 1);
        const last = [...got].reverse().find((e) => e.event === event);
        reject(new Error(`no "${event}" event like that in ${timeout / 1000} s; the last one: ${JSON.stringify(last?.data)?.slice(0, 3000)}`));
      }, timeout);
      waiting.push(w);
    });
  return { until, mark: () => got.length, close: () => req.destroy() };
}
const checksDone = (c) => !c.running && !c.fixing && c.results.length > 0;
const result = (c, id) => c.results.find((r) => r.id === id);

test('mergePath: folders installers added come after the ones already there', () => {
  assert.equal(mergePath('C:\\stubs;C:\\Windows', ['C:\\Windows\\', 'c:\\stubs', 'C:\\Program Files\\GitHub CLI\\', '']), 'C:\\stubs;C:\\Windows;C:\\Program Files\\GitHub CLI\\');
  assert.equal(mergePath('C:\\a', ['C:\\A']), 'C:\\a', 'nothing new: PATH stays as it is');
  assert.equal(mergePath('', ['C:\\x']), 'C:\\x');
});

test('the dashboard listens on 127.0.0.1 only; its link has a one-time code, traded once for a session key every request needs', async (t) => {
  const p = makeProject();
  const clock = path.join(p.tmp, 'clock.json');
  const setClock = (ms) => fs.writeFileSync(clock, JSON.stringify({ at: new Date(ms).toISOString() }));
  const start = Date.now();
  setClock(start);
  let ui;
  try {
    ui = await launchUi(p, { NEXTLEVEL_TEST_CLOCK: clock });
    assert.match(ui.url, /^http:\/\/127\.0\.0\.1:\d+\/\?code=[A-Za-z0-9_-]{32}$/);
    assert.match(ui.out, /Open this link in your browser \(Edge or Chrome\) within a minute; it works once: http/);
    const record = fs.readFileSync(p.state('ui.json'), 'utf8');
    assert.equal(JSON.parse(record).port, ui.port);
    assert.ok(!record.includes(ui.code), 'the code is never written down');

    // The page with the link's code, and safe headers; the page itself holds no data
    const page = await request(ui.port, { path: `/?code=${ui.code}` });
    assert.equal(page.status, 200);
    assert.match(page.text, /<script type="module" src="app\.js">/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'/);
    assert.equal(page.headers['referrer-policy'], 'no-referrer', "the link's code never goes to another site");
    assert.ok(!page.text.includes(p.repo) && !/\bproj\b/.test(page.text), 'the page says nothing about the project');
    assert.equal((await request(ui.port, { path: '/app.js' })).status, 200, "the page's own files hold no data");
    // The page takes the code out of the address bar first, and keeps its key in the tab's session storage, in a header
    const app = (await request(ui.port, { path: '/app.js' })).text;
    assert.match(app, /history\.replaceState\(null, '', `\$\{location\.pathname\}\$\{location\.hash\}`\)/);
    assert.match(app, /sessionStorage\.setItem\(KEY_STORE, sessionKey\)/);
    assert.doesNotMatch(app, /new EventSource|document\.cookie|localStorage\.setItem\(KEY_STORE/);

    // The trade: once. The code is no good after it, nor a wrong one, nor an older version's token link
    const offByOne = `${ui.code.slice(0, -1)}${ui.code.endsWith('x') ? 'y' : 'x'}`;
    assert.equal((await trade(ui.port, offByOne)).status, 403, 'one character off');
    const traded = await trade(ui.port, ui.code);
    assert.equal(traded.status, 200, traded.text);
    const key = traded.json.key;
    assert.match(key, /^[A-Za-z0-9_-]{43}$/);
    const again = await trade(ui.port, ui.code);
    assert.equal(again.status, 403, 'a code works once');
    assert.equal(again.json.gone, true);
    assert.ok(!again.text.includes(key));
    for (const bad of [`/?code=${ui.code}`, '/?code=nope', `/?code=${offByOne}`, `/?token=${key}`, '/?x=1']) {
      const r = await request(ui.port, { path: bad });
      assert.equal(r.status, 403, bad);
      assert.match(r.text, /This link was used already, or it is more than a minute old/, bad);
      assert.match(r.text, /double-click START\.cmd in your project's folder and choose d, or type\s+<code>nextlevel ui<\/code>/);
      assert.match(r.text, /color-scheme" content="light dark"/, 'the browser\'s own colors, light or dark');
      assert.doesNotMatch(r.text, /<script|<link|app\.js/, 'nothing else');
      assert.ok(!r.text.includes(p.repo) && !/\bproj\b/.test(r.text), 'says nothing about the project');
    }
    assert.equal((await request(ui.port, { path: '/' })).status, 200, 'a reload, with no code: the page, which works with its own key');
    assert.match(ui.out, /A dashboard link was tried after it was used or had expired/);

    // A code is good for a minute: a new one (the hub's reopen) and the clock a minute on
    assert.equal(p.hub(['ui', '--no-open']).code, 0);
    await waitUntil('a new link', () => linksIn(ui.out).length === 2, 10_000);
    const late = linksIn(ui.out)[1].code;
    assert.notEqual(late, ui.code);
    setClock(start + 61_000);
    assert.equal((await request(ui.port, { path: `/?code=${late}` })).status, 403, 'a minute later: the page says how to open it again');
    assert.equal((await trade(ui.port, late)).status, 403, 'a minute later: no key');
    assert.equal(p.hub(['ui', '--no-open']).code, 0);
    await waitUntil('a third link', () => linksIn(ui.out).length === 3, 10_000);
    setClock(start + 61_000 + 59_000);
    const second = await trade(ui.port, linksIn(ui.out)[2].code);
    assert.equal(second.status, 200, 'under a minute: a key, for another tab');
    assert.notEqual(second.json.key, key, 'a key of its own');

    // Data needs a session key in the header, at 127.0.0.1 or localhost with its port
    Object.assign(ui, { token: key });
    const api = client(ui);
    for (const [given, why] of [[undefined, 'no key'], ['', 'an empty key'], [ui.code, 'the used code'], [late, 'an expired code'], [`${key}x`, 'a key one character longer']]) {
      const headers = given === undefined ? {} : { 'x-nextlevel-token': given };
      const r = await request(ui.port, { path: '/api/state', headers });
      assert.equal(r.status, 403, why);
      assert.equal(r.json.nokey, true, why);
      assert.equal((await request(ui.port, { path: '/events', headers })).status, 403, why);
    }
    assert.equal((await request(ui.port, { path: `/events?token=${key}` })).status, 403, 'never a key in the address');
    assert.equal((await request(ui.port, { path: '/api/state', headers: { cookie: `token=${key}` } })).status, 403, 'never a cookie');
    const state = await api.get('/api/state');
    assert.equal(state.status, 200);
    assert.equal(state.json.project.name, 'proj');
    assert.equal((await request(ui.port, { path: '/api/state', headers: { 'x-nextlevel-token': second.json.key } })).status, 200, "the other tab's key");
    assert.equal((await request(ui.port, { path: '/api/state', headers: { 'x-nextlevel-token': key, host: `localhost:${ui.port}` } })).status, 200);
    for (const host of [`evil.example:${ui.port}`, '127.0.0.1', `127.0.0.1:${ui.port + 1}`, `localhost.evil.example:${ui.port}`]) {
      const r = await request(ui.port, { path: '/api/state', headers: { 'x-nextlevel-token': key, host } });
      assert.equal(r.status, 403, `Host ${host}: a page elsewhere that points its own name at 127.0.0.1 is refused`);
    }
    const reboundTrade = await request(ui.port, { method: 'POST', path: '/api/session', headers: { host: `evil.example:${ui.port}` }, body: { code: linksIn(ui.out)[2].code } });
    assert.equal(reboundTrade.status, 403, 'nor does it trade a code');
    const inQuery = await request(ui.port, { method: 'POST', path: `/api/autopilot?token=${key}`, body: { on: true } });
    assert.equal(inQuery.status, 403, "a POST needs the key in a header, which another site can't set");
    assert.equal((await api.post('/api/autopilot', { on: true }, { origin: 'http://evil.example' })).status, 403);
    assert.equal((await api.post('/api/autopilot', { on: true }, { 'sec-fetch-site': 'cross-site' })).status, 403);
    assert.equal((await api.post('/api/autopilot', 'on=1', { 'content-type': 'application/x-www-form-urlencoded' })).status, 415);
    assert.ok(!fs.existsSync(p.state('settings.json')) || !p.settings().autopilot, 'none of those turned autopilot on');
    const same = await api.post('/api/autopilot', { on: false }, { origin: `http://127.0.0.1:${ui.port}`, 'sec-fetch-site': 'same-origin' });
    assert.equal(same.status, 200, same.text);

    // The keys and codes are in no file (the project, its .nextlevel/, the home folder with ~/.nextlevel, the logs) and the
    // keys in nothing the dashboard printed
    const secrets = [key, second.json.key, ...linksIn(ui.out).map((l) => l.code)];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const f = path.join(dir, e.name);
      return e.isDirectory() ? walk(f) : e.isFile() ? [f] : [];
    });
    const files = walk(p.tmp);
    assert.ok(files.some((f) => f.endsWith('ui.json')) && files.some((f) => f.includes(`${path.sep}.nextlevel${path.sep}`)), 'the walk sees the state');
    for (const f of files) {
      const text = fs.readFileSync(f, 'latin1');
      for (const x of secrets) assert.ok(!text.includes(x), `${f} has a key or a code`);
    }
    for (const x of [key, second.json.key]) assert.ok(!ui.out.includes(x), 'the dashboard never prints a key');

    // Other machines can't connect: this PC's own network address has nothing listening
    const other = Object.values(os.networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal);
    if (!other) t.diagnostic('no network address besides 127.0.0.1 to try');
    else {
      const reached = await new Promise((resolve) => {
        const s = net.connect({ host: other.address, port: ui.port, timeout: 5000 });
        s.on('connect', () => (s.destroy(), resolve(true)));
        s.on('error', () => resolve(false));
        s.on('timeout', () => (s.destroy(), resolve(false)));
      });
      assert.equal(reached, false, `port ${ui.port} answered on ${other.address}`);
    }
    if (!IS_WIN) {
      // Ctrl+C or the window closing: the record goes too
      ui.child.kill('SIGTERM');
      await new Promise((r) => ui.child.once('exit', r));
      assert.ok(!fs.existsSync(p.state('ui.json')));
    }
  } finally {
    stopUi(ui);
    p.cleanup();
  }
});

test('Setup shows every check of doctor --json with its window-labeled steps; Fix runs only fixes that need no window of the owner\'s', async () => {
  const p = makeProject();
  let ui;
  let live;
  const npmLog = path.join(p.tmp, 'npm-calls.log');
  const env = { STUB_CLAUDE: 'broken', FAKE_NPM_LOG: npmLog };
  try {
    // Three kinds of problem: one nextlevel fixes by itself (.gitignore, .env), an install (Claude Code:
    // npm skipped its script), and one only the owner can do (the phone topic)
    const ignore = path.join(p.repo, '.gitignore');
    fs.writeFileSync(ignore, fs.readFileSync(ignore, 'utf8').replace('.nextlevel-task/\n', ''));
    fs.rmSync(path.join(p.repo, '.env'), { force: true });
    const direct = JSON.parse(p.hub(['doctor', '--json'], { extraEnv: env }).out);
    assert.ok(!fs.existsSync(path.join(p.repo, '.env')), 'doctor --json changes nothing');

    ui = await startUi(p, env);
    live = feed(ui);
    const checks = await live.until('checks', checksDone);
    assert.deepEqual(checks.results.map((r) => r.id), direct.results.map((r) => r.id), 'every check the doctor runs, in its order');
    for (const r of checks.results) for (const s of r.steps) assert.ok(s.label && s.window, `${r.id}: every step says where to type it`);
    const labels = checks.results.flatMap((r) => r.steps.map((s) => s.label));
    for (const where of [IS_WIN ? 'PowerShell' : 'Terminal', 'Your phone', 'Text editor']) assert.ok(labels.includes(where), where);

    const gitignore = result(checks, 'project.gitignore');
    assert.equal(gitignore.status, 'fail');
    assert.equal(gitignore.autoFix, true);
    assert.equal(result(checks, 'project.env').autoFix, true);
    const claude = result(checks, 'tool.claude');
    assert.equal(claude.status, 'fail');
    assert.equal(claude.fixable, true, 'the doctor in your own window can install it...');
    assert.equal(claude.autoFix, false, '...the dashboard shows the command instead');
    assert.match(claude.steps[0].command, /npm install -g @anthropic-ai\/claude-code/);
    const topic = result(checks, 'notify.topic');
    assert.equal(topic.fixable, false);
    assert.equal(topic.autoFix, false);

    const api = client(ui);
    const install = await api.post('/api/fix', { id: 'tool.claude' });
    assert.equal(install.status, 409);
    assert.match(install.json.message, /runs in your own window/);
    const owner = await api.post('/api/fix', { id: 'notify.topic' });
    assert.equal(owner.status, 409);
    assert.match(owner.json.message, /no automatic fix/);
    assert.equal((await api.post('/api/fix', { id: 'no.such-check' })).status, 404);

    const since = live.mark();
    const fix = await api.post('/api/fix', { id: 'project.gitignore' });
    assert.equal(fix.status, 200, fix.text);
    assert.equal(fix.json.ran, true);
    assert.equal(fix.json.fixed, true);
    assert.ok(fs.readFileSync(ignore, 'utf8').split(/\r?\n/).includes('.nextlevel-task/'));
    const after = await live.until('checks', (c) => checksDone(c) && c.lastFix?.id === 'project.gitignore', { since });
    assert.equal(result(after, 'project.gitignore').status, 'ok', 'every page sees the check pass');
    assert.equal((await api.post('/api/fix', { id: 'project.env' })).json.fixed, true);
    assert.ok(fs.existsSync(path.join(p.repo, '.env')));

    // The doctor itself refuses an installer without a window; in the owner's own window it runs it
    const refused = JSON.parse(p.hub(['doctor', '--fix', 'tool.claude', '--json'], { extraEnv: env }).out);
    assert.deepEqual({ ran: refused.fix.ran, fixed: refused.fix.fixed }, { ran: false, fixed: false });
    assert.match(refused.fix.reason, /runs in your own window/);
    assert.doesNotMatch(fs.existsSync(npmLog) ? fs.readFileSync(npmLog, 'utf8') : '', /install/, 'no installer ran from the dashboard or --json');
    const text = p.hub(['doctor', '--fix', 'tool.claude'], { extraEnv: env });
    assert.match(fs.readFileSync(npmLog, 'utf8'), /^install -g @anthropic-ai\/claude-code/m, text.out);
    assert.match(p.hub(['doctor', '--fix', 'nope.nope']).out, /There is no check "nope\.nope"/);

    // "Check again" reruns the doctor, asking the slow things afresh (doctor --fresh, FR-010); the page's own
    // checks when it comes back into view use what was kept from the last few minutes
    const before = live.mark();
    assert.equal((await api.post('/api/checks', { fresh: true })).status, 202);
    await live.until('checks', (c) => c.running, { since: before });
    await live.until('checks', checksDone, { since: before });
    assert.match((await request(ui.port, { path: '/app.js' })).text, /api\('\/api\/checks', \{ fresh: force \}\)/);
  } finally {
    live?.close();
    stopUi(ui);
    p.cleanup();
  }
});

test('Report and fix: the page gets the report\'s exact text, filing needs that text, and the fix goes to the owner\'s window (FR-006) once claude.github passes', async () => {
  const t = installedTool(); // the dashboard runs an installed clone: its remote is nextlevel's GitHub repository
  const p = t.p;
  let ui;
  let live;
  const planted = 'planted-dashboard-secret-4242';
  const issues = () => {
    const dir = path.join(p.env.HOME, '.fake-github', 'issues');
    return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  };
  try {
    fs.writeFileSync(path.join(p.repo, '.env'), `NTFY_TOPIC=\nPLANTED_KEY=${planted}\n`);
    fs.mkdirSync(p.state('logs'), { recursive: true });
    fs.writeFileSync(p.state('logs', 'hub.log'), `2026-09-26T10:00:00.000Z  hub error: ${planted}\n`);
    ui = await startUi(p, {}, { bin: path.join(t.tool, 'bin', 'nextlevel.mjs') });
    live = feed(ui);
    const checks = await live.until('checks', checksDone);
    assert.equal(result(checks, 'notify.topic').status, 'fail', 'no ntfy topic: a warning the owner can report');
    const api = client(ui);

    const built = await api.post('/api/report', { id: 'notify.topic' });
    assert.equal(built.status, 200, built.text);
    const r = built.json;
    assert.equal(r.repo, 'DYevseyev/nextlevelorc');
    assert.match(r.title, /^Field report: Phone notifications \(notify\.topic\) on /);
    assert.match(r.body, /### `notify\.topic` · Phone notifications \(warn\)/);
    assert.ok(!built.text.includes(planted), 'redacted before the page sees it');
    assert.deepEqual(issues(), [], 'showing it files nothing');
    assert.equal((await api.post('/api/report', { id: 'tool.git' })).status, 409, 'a check that passes has nothing to report');
    assert.equal((await api.post('/api/report', { id: '../x' })).status, 400);

    // Only the text that was shown can be filed
    assert.equal((await api.post('/api/report/send', { id: r.id, hash: 'nope' })).status, 400);
    const other = await api.post('/api/report/send', { id: r.id, hash: '0123456789abcdef' });
    assert.equal(other.status, 409);
    assert.match(other.json.message, /not the text you were shown/);
    assert.deepEqual(issues(), []);
    // The page files in the dashboard's own process, exactly the text it showed (FR-017: no command files a kept report):
    // its file changed since, it isn't filed from here
    const kept = path.join(p.env.HOME, '.nextlevel', 'reports', `${r.id}.md`);
    fs.writeFileSync(kept, `${r.body}\nsomething the page never showed\n`);
    const changed = await api.post('/api/report/send', { id: r.id, hash: r.hash });
    assert.equal(changed.status, 409);
    assert.match(changed.json.message, /was changed after the report was shown, so it isn't filed from here/);
    assert.deepEqual(issues(), []);
    fs.writeFileSync(kept, r.body);

    // File it needs the dashboard's session key (FR-017 part 2A): without it nothing is filed
    for (const headers of [{}, { 'x-nextlevel-token': ui.code }]) {
      assert.equal((await request(ui.port, { method: 'POST', path: '/api/report/send', body: { id: r.id, hash: r.hash, fix: true }, headers })).status, 403);
    }
    assert.deepEqual(issues(), []);

    // Filed; the fix doesn't start while the Claude-GitHub connection isn't confirmed (FR-002)
    const sent = await api.post('/api/report/send', { id: r.id, hash: r.hash, fix: true });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.json.issue.number, 1);
    const issue = JSON.parse(fs.readFileSync(path.join(p.env.HOME, '.fake-github', 'issues', '1.json'), 'utf8'));
    assert.equal(issue.body, r.body, 'exactly the text the page showed');
    assert.equal(issue.title, r.title);
    assert.equal(sent.json.fix.started, false);
    assert.equal(sent.json.fix.check, 'claude.github');
    assert.deepEqual(sent.json.fix.steps.map((s) => s.label), ['Browser', 'Browser', IS_WIN ? 'PowerShell' : 'Terminal', 'Browser']);
    assert.match(sent.json.fix.prompt, /^Fix issue #1 /);
    assert.ok(!fs.existsSync(path.join(p.env.HOME, '.fake-claude', 'calls.jsonl')), 'no session');

    // Confirmed (as the menu's doctor records it): Claude Code starts a cloud session only in a terminal
    // (FR-006), which the page hasn't, so it gives the command for the owner's window, and the browser way
    const stateFile = path.join(p.env.HOME, '.nextlevel', 'state.json');
    const st = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    fs.writeFileSync(stateFile, JSON.stringify({ ...st, claudeGithub: { repo: 'DYevseyev/nextlevelorc', at: new Date().toISOString() } }));
    const again = (await api.post('/api/report', { id: 'notify.topic' })).json;
    assert.equal(again.earlier.number, 1, 'it says this check was reported before');
    const since = live.mark();
    const sentAgain = await api.post('/api/report/send', { id: again.id, hash: again.hash, fix: true });
    assert.equal(sentAgain.status, 200, sentAgain.text);
    assert.equal(sentAgain.json.issue.number, 2);
    assert.equal(sentAgain.json.fix.started, false, `fix: ${JSON.stringify(sentAgain.json.fix)}`);
    assert.match(sentAgain.json.fix.message, /A cloud session starts in your own window \(Claude Code starts one only in a terminal\): in (PowerShell|Terminal), nextlevel fix 2/);
    assert.deepEqual(sentAgain.json.fix.steps.map((s) => [s.label, s.command]), [[IS_WIN ? 'PowerShell' : 'Terminal', 'nextlevel fix 2'], ['Browser', 'https://claude.ai/code']]);
    assert.match(sentAgain.json.fix.prompt, /^Fix issue #2 /);
    assert.ok(!fs.existsSync(path.join(p.env.HOME, '.fake-claude', 'calls.jsonl')), 'no session from the page');
    const b = await live.until('build', (x) => x.fixes?.length === 2, { since });
    assert.deepEqual(b.fixes.map((f) => [f.number, f.state, f.mode, f.checks]).sort((x, y) => x[0] - y[0]), [[1, 'started', 'browser', ['notify.topic']], [2, 'started', 'browser', ['notify.topic']]], 'both followed, however the owner starts them');
  } finally {
    live?.close();
    stopUi(ui);
    p.cleanup();
  }
});

test('Build shows the hub, milestones, workers with their log, reviews and handoff items; the controls work', async () => {
  const p = makeProject();
  const clock = testClock(p, Date.now());
  let ui;
  let live;
  const secret = 'planted-secret-value-9c1e';
  try {
    fs.writeFileSync(path.join(p.repo, '.env'), `NTFY_TOPIC=\nPLANTED_SECRET=${secret}\n`);
    fs.writeFileSync(path.join(p.repo, 'docs', 'STATUS.md'), '# Status\n\n| Milestone | State | Verified by |\n|---|---|---|\n| M0 Foundation | done | CI |\n| M1 First feature | in progress | |\n\n## Blockers\n\nNone.\n');
    fs.writeFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), '# Handoff\n\n- [ ] Add the SMTP password to .env\n- [x] Buy the domain\n');
    fs.mkdirSync(p.state('logs'), { recursive: true });
    fs.writeFileSync(p.state('logs', 'hub.log'), `2026-09-25T10:00:00.000Z  a line that mentions ${secret}\n`);
    p.spec('M1-01-ok', fileExists('ok.mjs'));
    p.spec('M1-02-slow', 'node -e "0"');
    p.hub(['dispatch', 'M1-01-ok']);
    p.hub(['dispatch', 'M1-02-slow']);

    ui = await startUi(p, clock.env);
    live = feed(ui);
    const api = client(ui);
    const first = await live.until('build');
    assert.equal(first.hub.running, false);
    assert.deepEqual(first.milestones.map((m) => [m.name, m.done]), [['M0 Foundation', true], ['M1 First feature', false]]);
    assert.deepEqual(first.waiting, ['Add the SMTP password to .env']);
    assert.deepEqual(first.queued.map((j) => j.id), ['M1-01-ok', 'M1-02-slow']);
    assert.match(first.hub.log[0], /a line that mentions \*\*\*/, '.env values are blanked out of everything the page gets');
    assert.ok(!JSON.stringify(first).includes(secret));

    // Start the hub: workers run, one finishes and waits for review, the other shows its log live
    let since = live.mark();
    const start = await api.post('/api/hub', { action: 'start' });
    assert.equal(start.status, 200, start.text);
    assert.match(start.json.message, /Started the hub/);
    await live.until('build', (b) => b.hub.running, { since });
    const running = await live.until('build', (b) => b.review.some((j) => j.id === 'M1-01-ok') && b.active.some((j) => j.id === 'M1-02-slow' && j.log.lines.some((l) => l.includes('[fake agy] task=M1-02-slow'))), { since });
    assert.equal(running.review.find((j) => j.id === 'M1-01-ok').state, 'done');
    const slow = running.active.find((j) => j.id === 'M1-02-slow');
    assert.equal(slow.log.name, 'worker.log');
    assert.equal(slow.log.attempt, 1);
    assert.equal(slow.slot > 0, true);

    const job = await api.get('/api/job?id=M1-01-ok');
    assert.equal(job.status, 200);
    assert.match(job.json.report, /Status: DONE/);
    assert.equal(job.json.branch, 'task/M1-01-ok');
    assert.ok(job.json.logs['verify.log · attempt 1'].length > 0, Object.keys(job.json.logs).join(', '));
    assert.match(job.json.logs['worker.log · attempt 1'].join('\n'), /task M1-01-ok · attempt 1 ·/);
    for (const bad of ['..', '../x', 'nope', '%2e%2e%2fsettings']) assert.equal((await api.get(`/api/job?id=${bad}`)).status, 404, bad);

    // Stop the hub: it stops at its next tick; the slow worker keeps running on its own
    since = live.mark();
    const stop = await api.post('/api/hub', { action: 'stop' });
    assert.equal(stop.status, 200, stop.text);
    assert.match(stop.json.message, /has stopped|is stopping/);
    await live.until('build', (b) => !b.hub.running, { since });
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /stop requested from the dashboard/);
    assert.equal((await api.post('/api/hub', { action: 'stop' })).json.message, 'The hub is not running.');

    // Autopilot on and off
    assert.match((await api.post('/api/autopilot', { on: true })).json.message, /Autopilot is now ON\. Start the hub for it to act\./);
    assert.equal(p.settings().autopilot, true);
    await api.post('/api/autopilot', { on: false });
    assert.equal(p.settings().autopilot, false);

    // A handoff item (imported from the file as it was), marked done
    const item = first.handoff.find((x) => x.what === 'Add the SMTP password to .env');
    assert.equal(item.id, 'H1');
    const tick = await api.post('/api/handoff', { action: 'done', id: 'H1' });
    assert.equal(tick.status, 200, tick.text);
    // (undo Done: final 10 seconds later, by the test clock; until then the file still has it open)
    const handoffMd = () => fs.readFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), 'utf8');
    assert.match(handoffMd(), /^- \[ \] \*\*H1\*\* Add the SMTP password to \.env$/m);
    clock.addSeconds(11);
    await waitUntil('the Done made final', () => /^- \[x\] \*\*H1\*\* Add the SMTP password to \.env$/m.test(handoffMd()));
    const again = await api.post('/api/handoff', { action: 'done', id: 'H1' });
    assert.equal(again.status, 409);
    assert.match(again.json.message, /H1 is done already/);
    await live.until('build', (b) => b.waiting.length === 0 && b.handoff.length === 0);

    // Windows of their own open on Windows only; elsewhere the page shows the command
    if (!IS_WIN) {
      const open = await api.post('/api/open', { what: 'orchestrator' });
      assert.equal(open.status, 409);
      assert.match(open.json.message, /In a terminal, in .*:  nextlevel orchestrator/);
    }
    assert.equal((await api.post('/api/open', { what: 'calc.exe' })).status, 400);
  } finally {
    // The slow worker runs for two minutes (and a hub may be left if the test failed): stop them now,
    // so the folder can be deleted
    for (const f of [p.jobFile('M1-02-slow', 'run.json'), p.state('hub.json')]) {
      try {
        const { pid } = JSON.parse(fs.readFileSync(f, 'utf8'));
        if (!pid || !isAlive(pid)) continue;
        if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-pid, 'SIGKILL');
      } catch {
        // not started, or gone
      }
    }
    live?.close();
    await stopUi(ui);
    p.cleanup();
  }
});

test("notes and handoffs as cards: the owner adds, edits, withdraws and switches off; marks items done with a reply; the orchestrator's answers come back live", async () => {
  const p = makeProject();
  let ui;
  let live;
  const secret = 'planted-cards-secret-7b2d';
  try {
    fs.writeFileSync(path.join(p.repo, '.env'), `NTFY_TOPIC=\nPLANTED_SECRET=${secret}\n`);
    // The project's notes as they were before cards: imported
    fs.writeFileSync(path.join(p.repo, 'docs', 'OWNER_NOTES.md'), '# Owner notes\n\n## New\n- Use Postgres.\n\n## Done\n- Use port 8080.\n');
    ui = await startUi(p);
    live = feed(ui);
    const api = client(ui);
    const first = await live.until('build', (b) => b.ok && b.cards?.stamp);
    assert.deepEqual([first.cards.open, first.cards.fresh], [1, 1]);
    let cards = await api.get('/api/cards');
    assert.equal(cards.status, 200, cards.text);
    assert.deepEqual([cards.json.notes.open.map((n) => [n.id, n.text, n.status]), cards.json.notes.history.map((n) => [n.id, n.status])], [[['N1', 'Use Postgres.', 'new']], [['N2', 'done']]]);
    assert.deepEqual(cards.json.files, { notes: 'docs/OWNER_NOTES.md', handoff: 'docs/HANDOFF.md' });

    // The owner: a one-time note (its own words, a value from .env included, come back as they are) and a rule
    const added = await api.post('/api/notes', { action: 'add', text: `Use the staging key ${secret} for demos`, type: 'once' });
    assert.equal(added.status, 200, added.text);
    assert.equal(added.json.item.id, 'N3');
    assert.equal(added.json.item.text, `Use the staging key ${secret} for demos`, "the owner's own text, which the page may edit");
    assert.equal((await api.post('/api/notes', { action: 'add', text: 'Never deploy on Fridays', type: 'rule' })).json.item.type, 'rule');
    assert.equal((await api.post('/api/notes', { action: 'add', text: '   ' })).status, 409);
    assert.equal((await api.post('/api/notes', { action: 'edit', id: 'N3', text: 'Use the demo key for demos' })).status, 200);
    assert.equal((await api.post('/api/notes', { action: 'off', id: 'N4' })).json.item.off, true);
    assert.equal((await api.post('/api/notes', { action: 'withdraw', id: 'N4' })).status, 409, 'a rule is switched off or removed, not withdrawn');
    assert.equal((await api.post('/api/notes', { action: 'on', id: 'N4' })).json.item.off, false);
    assert.equal((await api.post('/api/notes', { action: 'withdraw', id: 'N3' })).json.item.status, 'withdrawn');
    assert.equal((await api.post('/api/notes', { action: 'nope', id: 'N3' })).status, 409);
    const md = fs.readFileSync(path.join(p.repo, 'docs', 'OWNER_NOTES.md'), 'utf8');
    assert.match(md, /## Standing rules\n\n- \*\*N4\*\* \(rule, new\) Never deploy on Fridays/);
    assert.match(md, /- \*\*N3\*\* \(one-time, withdrawn\) Use the demo key for demos/);

    // The orchestrator answers with its commands; the page hears of it (the build data's stamp) and shows it
    let since = live.mark();
    p.hub(['note', 'done', 'N1', '--reply', `Done with ${secret} left out`, '--commit', 'abc1234', '--task', 'M1-02']);
    p.hub(['handoff', 'add', 'Put the SMTP host in .env', '--where', 'the mail panel, Settings -> SMTP', '--why', 'sign-up mail']);
    const after = await live.until('build', (b) => b.handoff?.length === 1 && b.cards.open === 0, { since });
    assert.deepEqual(after.handoff.map((x) => [x.id, x.what, x.where, x.why]), [['H1', 'Put the SMTP host in .env', 'the mail panel, Settings -> SMTP', 'sign-up mail']]);
    const need = after.needs.find((n) => n.kind === 'handoff');
    assert.deepEqual([need.text, need.why, need.action.label, need.action.body, need.more.page], ['H1: Put the SMTP host in .env (where: the mail panel, Settings -> SMTP)', 'sign-up mail', 'Done', { action: 'done', id: 'H1' }, 'notes']);
    cards = await api.get('/api/cards');
    const n1 = cards.json.notes.history.find((n) => n.id === 'N1');
    assert.deepEqual([n1.status, n1.reply, n1.commit, n1.task], ['done', 'Done with *** left out', 'abc1234', 'M1-02'], "the team's words are redacted");

    // The owner replies to the handoff item, then marks it done with a reply; the orchestrator sees both
    assert.equal((await api.post('/api/handoff', { action: 'reply', id: 'H1', reply: 'Which provider?' })).status, 200);
    assert.match(p.hub(['handoff', 'list']).out, /the owner replied .*: "Which provider\?"/);
    since = live.mark();
    const done = await api.post('/api/handoff', { action: 'done', id: 'H1', reply: 'smtp.example.com, in .env' });
    assert.equal(done.status, 200, done.text);
    assert.match(done.json.message, /Marked done/);
    await live.until('build', (b) => b.handoff.length === 0, { since });
    assert.match(p.hub(['handoff', 'list']).out, /Done by the owner, not picked up yet[\s\S]*"smtp\.example\.com, in \.env"/);
    assert.equal((await api.post('/api/handoff', { action: 'reply', id: 'H9', reply: 'x' })).status, 409);
    assert.match(fs.readFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), 'utf8'), /- \[x\] \*\*H1\*\* Put the SMTP host in \.env\n(.*\n)* {2}- The owner replied [\d-]+ [\d:]+:\n\n {4}> Which provider\?\n\n {2}- The owner replied [\d-]+ [\d:]+:\n\n {4}> smtp\.example\.com, in \.env\n/, 'both replies, each in its quote (FR-014)');
  } finally {
    live?.close();
    stopUi(ui);
    p.cleanup();
  }
});

test("the Project page (M11): what the project is, the roadmap with its plans, tasks and dates, the pace and the decisions; Home's Blockers", async () => {
  const p = makeProject();
  let ui;
  let live;
  const marker = ['planted', 'dotenv', 'value', '5b8e'].join('-'); // a value in .env: blanked out of everything shown
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(p.repo, rel)), { recursive: true });
    fs.writeFileSync(path.join(p.repo, rel), text);
  };
  try {
    fs.writeFileSync(path.join(p.repo, '.env'), `NTFY_TOPIC=\nPLANTED=${marker}\n`);
    write('BRIEF.md', "# Brief\n\n## Goal\nMembers book a gym class in two taps.\n\n## Milestones\n| Milestone | What is true when it's done |\n|---|---|\n| M0 Foundation | CI green |\n| M1 Booking | members book a class |\n| M2 Payments | members pay by card |\n");
    write('docs/STATUS.md', [
      '# Status', '', '| Milestone | State | Verified by |', '|---|---|---|', '| M0 Foundation | done | CI green on main |', '| M1 Booking | in progress | |', '',
      '## Blockers', '', '- **Needs you:** put the SMTP host in `.env` (H1)', `- **Blocked by the tool:** Codex can't reach Docker; ${marker} is in its log`, '- **Note:** staging is slow', '',
      '### History', '- **Resolved:** the build was red', '', '## Next step', '', 'M1-01.', '',
    ].join('\n'));
    write('docs/plans/M0.md', '# M0 — Foundation\n\nOutcome: The app builds and its tests run.\nTry it:\n1. In PowerShell, in the project folder: `pnpm test`\n2. You should see every test pass.\n\n## Tasks\n');
    write('docs/plans/M1.md', '# M1 — Booking\n\n**Outcome:** Members book a class.\n**Acceptance:** R1; the booking E2E passes.\n\n## Tasks\n');
    write('docs/DECISIONS.md', '# Decisions\n\n## 2026-09-20 — Postgres, not SQLite\nWhy: parallel tests lock SQLite.\n\n## 2026-09-22 — Resolved: the build was red\nA flaky test, fixed in M0-01.\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'docs: brief, status, plans');
    // M0's one task, merged the way nextlevel merge does it
    p.git('checkout', '-qb', 'task/M0-01-repo');
    write('app.txt', 'app\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'feat: the app');
    p.git('checkout', '-q', 'main');
    p.git('merge', '--no-ff', '--no-edit', '-q', 'task/M0-01-repo');
    p.spec('M1-01-api', 'node -e "0"');
    p.hub(['dispatch', 'M1-01-api']);
    const added = p.hub(['handoff', 'add', 'Put the SMTP host in .env', '--where', '.env in the project folder', '--why', 'sign-up mail']);
    assert.equal(added.code, 0, added.out);

    ui = await startUi(p);
    live = feed(ui);
    const api = client(ui);
    // Home's Blockers: red, the bullets with their labels, what is resolved folded away, .env values blanked out
    const first = await live.until('build');
    const card = first.blockersCard;
    assert.equal(card.level, 'blocked');
    assert.equal(card.headline, "Blocked: Codex can't reach Docker");
    assert.equal(card.items[0].text, "Codex can't reach Docker; *** is in its log");
    assert.equal(card.sub, 'Waiting on you: 1', 'the bullet names H1, the open handoff item: counted once');
    assert.deepEqual(card.items.map((x) => x.label), ['Blocked by the tool', 'Needs you', 'Note']);
    assert.deepEqual(card.history, ['- **Resolved:** the build was red']);
    assert.match(first.projectStamp, /^[0-9a-f]{16}$/);
    assert.ok(!JSON.stringify(first).includes(marker));

    // The Project page: docs/PROJECT.md is still the template, so the page shows the brief's goal meanwhile
    assert.equal((await request(ui.port, { path: '/api/project' })).status, 403, 'needs the key');
    let proj = (await api.get('/api/project')).json;
    assert.equal(proj.ok, true);
    assert.deepEqual([proj.about.exists, proj.about.written, proj.about.goal], [true, 0, 'Members book a gym class in two taps.']);
    assert.deepEqual(proj.files, { project: 'docs/PROJECT.md', status: 'docs/STATUS.md', decisions: 'docs/DECISIONS.md', plans: 'docs/plans', brief: 'BRIEF.md' });
    assert.deepEqual(proj.roadmap.map((m) => [m.key, m.state, m.current]), [['M0', 'done', false], ['M1', 'in progress', true], ['M2', 'not started', false]]);
    const [m0, m1, m2] = proj.roadmap;
    assert.equal(m0.plan.outcome, 'The app builds and its tests run.');
    assert.equal(m0.plan.tryIt, '1. In PowerShell, in the project folder: `pnpm test`\n2. You should see every test pass.');
    assert.equal(m0.verified, 'CI green on main');
    assert.deepEqual(m0.tasks.map((t) => [t.id, t.state]), [['M0-01-repo', 'merged']], 'from the merge commit: no job record needed');
    assert.ok(m0.started && m0.finished && Date.parse(m0.finished) >= Date.parse(m0.started), 'from its plan in git to its merge');
    assert.deepEqual([m1.plan.acceptance, m1.goal], ['R1; the booking E2E passes.', 'members book a class']);
    assert.deepEqual(m1.tasks.map((t) => [t.id, t.state, t.attempts, t.engine]), [['M1-01-api', 'queued', 1, 'Antigravity']]);
    assert.deepEqual([m2.plan, m2.goal], [null, 'members pay by card']);
    assert.deepEqual([proj.pace.done, proj.pace.left, proj.pace.basis], [1, 2, 1]);
    assert.ok(proj.pace.estimate.days > 0, 'a rough estimate from the one finished milestone');
    assert.deepEqual(proj.decisions.map((d) => [d.date, d.title, d.resolved]), [['2026-09-22', 'The build was red', true], ['2026-09-20', 'Postgres, not SQLite', false]]);
    // FR-016: what the page warns about (M2 has neither a plan nor tasks yet: nothing to say)
    assert.deepEqual([m0.plan.by, m1.plan.by, m2.planPath], ['title', 'title', 'docs/plans/M2.md']);
    assert.deepEqual(proj.planProblems.map((x) => [x.key, x.kind, x.card]), [
      ['M0', 'fields', 'Its plan, docs/plans/M0.md, has no Acceptance (a line "Acceptance:" in its header).'],
      ['M1', 'fields', 'Its plan, docs/plans/M1.md, has no Try it (a line "Try it:" in its header).'],
    ]);

    // The orchestrator writes docs/PROJECT.md: the stamp changes, and the page reads it again
    const since = live.mark();
    write('docs/PROJECT.md', `# Project\n\n## What it is\nA booking app for small gyms.\n\n## Who it's for\nGym members.\n\n## Where it runs\n- Code: https://github.com/me/gym\n- Live: not deployed yet (${marker})\n\n## How it works\n- A web app\n- Postgres\n\n## Current state\nM0 is done; M1 is being built.\n`);
    const next = await live.until('build', (b) => b.projectStamp !== first.projectStamp, { since });
    assert.notEqual(next.projectStamp, first.projectStamp);
    const res = await api.get('/api/project');
    proj = res.json;
    assert.deepEqual([proj.about.written, proj.about.complete], [5, true]);
    assert.equal(proj.about.sections.find((s) => s.key === 'where').text, '- Code: https://github.com/me/gym\n- Live: not deployed yet (***)');
    assert.ok(!res.text.includes(marker), 'blanked out like everything the page gets');

    // FR-016: the orchestrator writes M1's plan under a name of its own, with its Milestone line: the page finds it by
    // that line; a copy left under the old name is a second plan for M1, which the page says
    const renamed = live.mark();
    fs.renameSync(path.join(p.repo, 'docs/plans/M1.md'), path.join(p.repo, 'docs/plans/booking-and-classes.md'));
    write('docs/plans/booking-and-classes.md', '# Booking and classes\n\nMilestone: M1 Booking\nOutcome: Members book a class.\nAcceptance: R1.\nTry it:\n1. Open http://localhost:3000 and book a class.\n');
    const third = await live.until('build', (b) => b.projectStamp !== next.projectStamp, { since: renamed });
    proj = (await api.get('/api/project')).json;
    assert.deepEqual([proj.roadmap[1].plan.file, proj.roadmap[1].plan.by, proj.roadmap[1].plan.tryIt], ['docs/plans/booking-and-classes.md', 'header', '1. Open http://localhost:3000 and book a class.']);
    assert.deepEqual(proj.planProblems.map((x) => [x.key, x.kind]), [['M0', 'fields']]);
    const copied = live.mark();
    write('docs/plans/M1.md', '# M1 — Booking\n\nOutcome: Members book a class.\n');
    await live.until('build', (b) => b.projectStamp !== third.projectStamp, { since: copied });
    proj = (await api.get('/api/project')).json;
    assert.deepEqual(proj.roadmap[1].rivals, [{ file: 'docs/plans/M1.md', by: 'title' }]);
    assert.equal(proj.planProblems.find((x) => x.kind === 'rivals').text, 'M1 Booking: 2 plans claim it, docs/plans/booking-and-classes.md and docs/plans/M1.md. The page shows docs/plans/booking-and-classes.md, whose "Milestone:" line names it. Keep one plan per milestone in docs/plans/.');
  } finally {
    live?.close();
    await stopUi(ui);
    p.cleanup();
  }
});

test("a dashboard whose output goes into a file (the update starts it so) prints no link there, and its reopen says so", async () => {
  const p = makeProject();
  let child;
  try {
    const log = path.join(p.tmp, 'ui-console.log');
    const fd = fs.openSync(log, 'a');
    child = spawn(process.execPath, [BIN, 'ui', '--no-open'], { cwd: p.repo, env: withEnv(p.env, { NEXTLEVEL_HUB_WINDOW: '0', NEXTLEVEL_NO_BROWSER: '1' }), stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    await waitUntil('its record and its last words', () => fs.existsSync(p.state('ui.json')) && /Leave this window open/.test(fs.readFileSync(log, 'utf8')));
    const reopen = p.hub(['ui', '--no-open']);
    assert.equal(reopen.code, 0, reopen.out);
    assert.match(reopen.out, /already running: it runs without a browser or a window, so it has nowhere to show a new link: stop it and start it again\./);
    await waitUntil('its answer', () => /Asked to show the dashboard again, but it runs without a browser or a window here/.test(fs.readFileSync(log, 'utf8')));
    const out = fs.readFileSync(log, 'utf8');
    assert.match(out, /It runs without a browser or a window: start it with START\.cmd -> d to open it\./);
    assert.doesNotMatch(out, /code=|token=/, out);
  } finally {
    child?.kill();
    if (child) await processesGone([child.pid]);
    p.cleanup();
  }
});

test('START.cmd -> d opens the dashboard, or shows the one that already runs', async () => {
  const p = makeProject();
  let ui;
  try {
    if (!IS_WIN) {
      // On Windows it opens a window of its own; here it says where to start it
      const menu = p.hub([], { input: 'd\n' });
      assert.match(menu.out, /d\) Dashboard in your browser: setup, build and controls/);
      assert.match(menu.out, /Run in another terminal, in .*proj: nextlevel ui/);
    }
    // The menu's autopilot switch and the dashboard's are one: the menu names its own item for the hub.
    // (One choice per run: the menu reads piped input only while it waits at "Choose:".)
    assert.match(p.hub([], { input: '6\n' }).out, /Autopilot is now ON\. Start the hub \(4\) for it to act\./);
    assert.equal(p.settings().autopilot, true);
    assert.match(p.hub([], { input: '6\n' }).out, /Autopilot is now off\./);
    assert.equal(p.settings().autopilot, false);
    ui = await startUi(p);
    const menu = p.hub([], { input: 'D\n' });
    // (this one runs without a browser: its window shows the new link, which never comes back to the one who asked)
    assert.match(menu.out, /The dashboard was already running: its window shows a new link, good once and for a minute\./, menu.out);
    assert.doesNotMatch(menu.out, /code=/);
    const again = p.hub(['ui', '--no-open']);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /already running: its window shows a new link/);
    assert.doesNotMatch(again.out, /code=/);
    for (let i = 0; i < 20 && (ui.out.match(/Asked to show the dashboard again/g) || []).length < 2; i++) await sleep(250);
    assert.equal((ui.out.match(/Asked to show the dashboard again\. Its link, good once and for a minute: http:\/\/127\.0\.0\.1:\d+\/\?code=/g) || []).length, 2, ui.out);
    const codes = linksIn(ui.out).map((l) => l.code);
    assert.equal(new Set(codes).size, 3, 'a new code each time');
    // An agent's session doesn't ask for one
    const agent = p.hub(['ui', '--no-open'], { extraEnv: { NEXTLEVEL_AGENT: 'worker' } });
    assert.notEqual(agent.code, 0, agent.out);
    assert.match(agent.out, /The dashboard is the owner's: it doesn't start from an agent's session/);
    await sleep(2000);
    assert.equal(linksIn(ui.out).length, 3, 'no new link for it');
  } finally {
    stopUi(ui);
    p.cleanup();
  }
});

test('with a broken nextlevel.json the dashboard still opens and shows it; the hub waits for the fix', async () => {
  const p = makeProject();
  let ui;
  let live;
  try {
    fs.writeFileSync(path.join(p.repo, 'nextlevel.json'), '{ "workers": { "slots": 2, } }');
    ui = await startUi(p);
    live = feed(ui);
    const checks = await live.until('checks', checksDone);
    const config = result(checks, 'project.config');
    assert.equal(config.status, 'fail');
    assert.match(config.detail, /not valid JSON/);
    const start = await client(ui).post('/api/hub', { action: 'start' });
    assert.equal(start.status, 409);
    assert.match(start.json.message, /can't start until nextlevel\.json is fixed/);
    assert.ok(!fs.existsSync(p.state('hub.json')));
  } finally {
    live?.close();
    stopUi(ui);
    p.cleanup();
  }
});

test("a slot held for a stopped worker's processes is a card on Home, and Check again asks the hub to look once more (FR-013)", async () => {
  const p = makeProject();
  let ui;
  try {
    const held = { id: 'M1-11-ok', attempt: 1, since: new Date().toISOString(), roots: [], group: 0, state: 'failed', tries: 3, why: "Windows (PowerShell) didn't list the processes within 20 s", left: [] };
    const settings = fs.existsSync(p.state('settings.json')) ? JSON.parse(fs.readFileSync(p.state('settings.json'), 'utf8')) : {};
    fs.mkdirSync(p.state(), { recursive: true });
    fs.writeFileSync(p.state('settings.json'), JSON.stringify({ ...settings, heldSlots: { 1: held } }));
    ui = await startUi(p);
    const api = client(ui);
    const card = (await api.get('/api/state')).json.needs.find((n) => n.kind === 'slot');
    assert.equal(card.level, 'error');
    assert.match(card.text, /^Slot w1 is kept out of use: M1-11-ok's worker was stopped and Windows \(PowerShell\) didn't list the processes within 20 s\. Close what it started/);
    assert.deepEqual(card.action, { label: 'Check again', post: '/api/slot', body: { slot: 1 } });
    const again = await api.post('/api/slot', { slot: 1 });
    assert.equal(again.status, 200, again.text);
    assert.match(again.json.message, /looks at slot w1 again when it starts: start the hub/);
    assert.ok(JSON.parse(fs.readFileSync(p.state('settings.json'), 'utf8')).heldSlots[1].again, 'the hub takes it at its next tick');
    assert.equal((await api.post('/api/slot', { slot: 'w1' })).status, 400);
    assert.match((await api.post('/api/slot', { slot: 2 })).json.message, /Slot w2 is not held/);
  } finally {
    stopUi(ui);
    p.cleanup();
  }
});

test('Home and Team (M9): what needs the owner with the next action, autopilot waiting for an open orchestrator, alerts, and a team change checked before it is saved', async () => {
  const p = makeProject();
  let ui;
  let live;
  try {
    fs.writeFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), '# Handoff\n\n- [ ] Add the SMTP password to .env\n');
    fs.mkdirSync(path.join(p.env.HOME, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(p.env.HOME, '.codex', 'config.toml'), 'model = "gpt-6"\nmodel_reasoning_effort = "high"\n');
    // A task on its fourth attempt, waiting for review
    fs.mkdirSync(p.state('jobs', 'M9-04-gateway'), { recursive: true });
    fs.writeFileSync(p.jobFile('M9-04-gateway', 'status.json'), JSON.stringify({ id: 'M9-04-gateway', type: 'task', kind: 'code', engine: 'agy', state: 'failed', attempt: 4, acked: false, finishedAt: new Date().toISOString() }));
    ui = await startUi(p, { NEXTLEVEL_WORKER_WINDOW: undefined }); // (the tests set it, and it wins over nextlevel.json)
    live = feed(ui);
    const api = client(ui);
    const page = await request(ui.port, { path: '/' });
    for (const tab of ['home', 'setup', 'build', 'team', 'tools', 'notes']) assert.match(page.text, new RegExp(`data-tab="${tab}"`), tab);

    const first = await live.until('build', (b) => b.ok && b.needs);
    assert.equal(fs.realpathSync.native(first.tool.root).toLowerCase(), fs.realpathSync.native(REPO).toLowerCase(), "the tool's location is on the page");
    assert.match(first.tool.installCommand, /install\.ps1/);
    assert.deepEqual(first.team.map((r) => r.key), ['orchestrator', 'worker', 'worker-second', 'worker-fallback', 'guide', 'assistant', 'security']);
    assert.match(first.team[0].model.text, /^gpt-6 \(Codex's own, from ~[\\/]\.codex[\\/]config\.toml\)$/);
    assert.deepEqual(first.alerts.map((a) => [a.id, a.kind]), [['M9-04-gateway', 'attempts']]);
    assert.equal(first.usage.rounds, 0);
    // The hub is stopped: that comes first (after setup checks that fail, once the doctor has run), with its
    // button; then the alert and the handoff item
    assert.deepEqual(first.needs.filter((n) => n.kind !== 'setup').slice(0, 3).map((n) => [n.kind, n.action?.label]), [['hub', 'Start the hub'], ['task', 'See it on Build'], ['handoff', 'Done']]);
    const checked = await live.until('build', (b) => b.ok && b.needs.some((n) => n.kind === 'setup'));
    assert.equal(checked.needs[0].kind, 'setup', 'a setup error comes before everything');
    assert.ok(checked.needs[0].action.fix || checked.needs[0].action.page === 'setup');

    // Autopilot on, the hub running, and the orchestrator open in its window: autopilot says it waits for it
    fs.writeFileSync(p.state('settings.json'), JSON.stringify({ autopilot: true }));
    fs.writeFileSync(p.state('hub.json'), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString() }));
    fs.writeFileSync(p.state('orchestrator.json'), JSON.stringify({ mode: 'interactive', pid: process.pid, startedAt: new Date().toISOString(), engine: 'codex', model: 'gpt-6', effort: 'high' }));
    const waiting = await live.until('build', (b) => b.autopilot.state === 'interactive');
    assert.match(waiting.autopilot.text, /waiting: the orchestrator is open in its own window/);
    assert.deepEqual([waiting.orchestrator.mode, waiting.orchestrator.engine, waiting.orchestrator.model, waiting.orchestrator.effort], ['interactive', 'Codex', 'gpt-6', 'high']);
    assert.ok(!waiting.needs.some((n) => n.kind === 'hub' || n.kind === 'review'), 'the hub runs, and the orchestrator is at work');
    fs.rmSync(p.state('orchestrator.json'));
    fs.rmSync(p.state('hub.json'));

    // Team: the models a CLI lists; a change is refused with the doctor's results, or saved
    const models = await api.get('/api/team/models?engine=codex');
    assert.equal(models.status, 200, models.text);
    assert.deepEqual(models.json.list.map((m) => m.id), ['gpt-6', 'gpt-6-mini']);
    assert.equal((await api.get('/api/team/models?engine=..%2Fx')).status, 400);
    assert.equal((await api.post('/api/team', { role: 'boss', engine: 'codex' })).status, 400);
    assert.equal((await api.post('/api/team', { role: 'worker', engine: 'codex', model: 'gpt"6' })).status, 400);
    assert.equal((await api.post('/api/team', { role: 'worker', engine: 'gemini' })).status, 400);
    const before = fs.readFileSync(path.join(p.repo, 'nextlevel.json'), 'utf8');
    const refused = await api.post('/api/team', { role: 'orchestrator', engine: 'codex', model: 'gpt-6-sol' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.json.saved, false);
    assert.equal(refused.json.results.find((r) => r.id === 'codex.model').status, 'fail');
    assert.equal(fs.readFileSync(path.join(p.repo, 'nextlevel.json'), 'utf8'), before);
    const since = live.mark();
    const saved = await api.post('/api/team', { role: 'worker', engine: 'claude', model: 'opus', effort: 'high' });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(saved.json.saved, true);
    assert.match(saved.json.message, /applies to the next task that starts/);
    // FR-009 on Windows (the workers' fallback is Codex): a warning, shown with the saved change
    assert.equal(saved.json.results.find((r) => r.id === 'codex.worker-windows').status, process.platform === 'win32' ? 'fail' : 'skip');
    const after = await live.until('build', (b) => b.team?.find((r) => r.key === 'worker')?.engine === 'claude', { since });
    const worker = after.team.find((r) => r.key === 'worker');
    assert.deepEqual([worker.engineTitle, worker.model.text, worker.effort.text], ['Claude Code', 'opus', 'high']);
    assert.ok(worker.notes.some((n) => /Claude plan/.test(n)), 'what choosing Claude Code means');
    // Antigravity has no Effort field: its level is in the model's name (FR-010)
    assert.equal(after.teamChoices.engines.find((e) => e.name === 'agy').levelInModel, true);
    assert.equal(after.team.find((r) => r.key === 'orchestrator').effort.fixed, undefined);
    assert.match(page.text, /data-tab="team"/);
    const app = await request(ui.port, { path: '/app.js' });
    assert.match(app.text, /eng\.levelInModel/, 'the editor leaves the Effort field out for it');
    // Worker windows (FR-010): shown, and changed through nextlevel team window
    assert.deepEqual([after.workerWindow.mode, after.workerWindow.choices.map((c) => c.mode)], ['hidden', ['hidden', 'minimized', 'visible']]);
    assert.equal((await api.post('/api/team', { window: 'tiny' })).status, 400);
    const win = await api.post('/api/team', { window: 'visible' });
    assert.equal(win.status, 200, win.text);
    assert.equal(p.config().workers.window, 'visible');
    await live.until('build', (b) => b.workerWindow?.mode === 'visible');
    // Codex workers' sandbox: in it until the owner chooses otherwise; the switch saves engines.codex.workerArgs through
    // nextlevel team sandbox, and the orchestrator keeps engines.codex.args
    assert.deepEqual([after.codexWorkers.sandbox, after.codexWorkers.set, after.codexWorkers.choices.map((c) => c.sandbox)], [true, false, [true, false]]);
    assert.equal((await api.post('/api/team', { codexSandbox: 'off' })).status, 400);
    const off = await api.post('/api/team', { codexSandbox: false });
    assert.equal(off.status, 200, off.text);
    assert.match(off.json.message, /Saved: Codex workers: Without it, like your other workers .*The orchestrator keeps engines\.codex\.args\. The rest of engines\.codex\.args is copied as it is now.*Run the bridge test for Codex workers again/);
    assert.deepEqual([p.config().engines.codex.workerArgs, p.config().engines.codex.args], [['--sandbox', 'danger-full-access', '-c', 'approval_policy=never'], ['--sandbox', 'workspace-write']]);
    await live.until('build', (b) => b.codexWorkers?.sandbox === false);
    const on = await api.post('/api/team', { codexSandbox: true });
    assert.equal(on.status, 200, on.text);
    assert.deepEqual(p.config().engines.codex.workerArgs, ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true']);
    assert.match(app.text, /codexWorkersCard/);
    // The second worker's row: none at first; saved with what it takes (checked as any row), and taken away
    assert.deepEqual([after.team.find((r) => r.key === 'worker-second').none, after.team.find((r) => r.key === 'worker-second').takes.choices.map((c) => c.value)], [true, ['no-docker', 'any', 'asked']]);
    assert.equal((await api.post('/api/team', { role: 'worker-second', engine: 'codex', takes: 'docker' })).status, 400);
    assert.equal((await api.post('/api/team', { role: 'worker', engine: 'agy', takes: 'any' })).status, 400, "takes is the second worker's");
    const second = await api.post('/api/team', { role: 'worker-second', engine: 'codex', model: '', effort: '', takes: 'any' });
    assert.equal(second.status, 200, second.text);
    assert.deepEqual(p.config().roles.worker.second, { engine: 'codex', model: '', effort: '', takes: 'any' });
    await live.until('build', (b) => b.team?.find((r) => r.key === 'worker-second')?.takes?.value === 'any');
    const gone = await api.post('/api/team', { role: 'worker-second', engine: 'none' });
    assert.equal(gone.status, 200, gone.text);
    assert.equal(p.config().roles.worker.second, null);
    assert.match(app.text, /No second worker/);
  } finally {
    live?.close();
    stopUi(ui);
    p.cleanup();
  }
});

test("worker.log says which attempt it is, and never shows the attempt before under the running one (FR-008); Home has the day per role and engine, and the engine switches", async () => {
  const p = makeProject();
  let ui;
  let live;
  let bg;
  try {
    p.spec('M8-06-fail', fileExists('fixed.txt'));
    p.hub(['dispatch', 'M8-06-fail']);
    p.runUntilIdle();
    assert.equal(p.status('M8-06-fail').state, 'failed');
    assert.match(fs.readFileSync(p.jobFile('M8-06-fail', 'worker.log'), 'utf8'), /\[fake agy\] task=M8-06-fail/);
    // The retry on Codex takes a while: the page shows it running, with its own log only
    p.hub(['retry', 'M8-06-fail', '--engine', 'codex', '--feedback', 'Create fixed.txt']);
    ui = await startUi(p);
    live = feed(ui);
    bg = p.hubInBackground(['run', '--tick-ms', '200'], { STUB_WORKER_SLOW_RETRY: '1' });
    const b = await live.until('build', (x) => x.ok && x.active.some((j) => j.id === 'M8-06-fail' && j.log.lines.some((l) => l.includes('[fake codex] task=M8-06-fail'))));
    const j = b.active.find((x) => x.id === 'M8-06-fail');
    assert.deepEqual([j.log.name, j.log.attempt, j.inWindow], ['worker.log', 2, false]);
    assert.ok(j.log.lines.some((l) => /task M8-06-fail · attempt 2 · Codex/.test(l)), j.log.lines.join('\n'));
    assert.ok(!j.log.lines.some((l) => /attempt 1 ·|\[fake agy\]/.test(l)), `attempt 1's lines under attempt 2:\n${j.log.lines.join('\n')}`);
    assert.equal(j.why, 'retry with --engine codex', 'what was run, not who ran it (FR-009)');
    const details = await client(ui).get('/api/job?id=M8-06-fail');
    assert.deepEqual(Object.keys(details.json.logs).filter((k) => k.startsWith('worker.log')), ['worker.log · attempt 2']);
    assert.ok(!details.json.logs['worker.log · attempt 2'].some((l) => l.includes('[fake agy]')));

    // Home: the switch with why, and the day per role (the finished attempt, and the one running now) and engine
    assert.deepEqual(b.switches.map((x) => [x.kind, x.id, x.attempt, x.engineTitle, x.roleEngineTitle, x.why]), [['task', 'M8-06-fail', 2, 'Codex', 'Antigravity', 'retry with --engine codex']]);
    assert.deepEqual(b.usage.roles.map((r) => r.key), ['autopilot', 'orchestrator', 'worker', 'guide', 'assistant']);
    const workers = b.usage.roles.find((r) => r.key === 'worker');
    assert.deepEqual([workers.count, workers.running], [2, 1]);
    assert.deepEqual(workers.engines.map((e) => [e.engine, e.count, e.tokensFrom]).sort(), [['agy', 1, 'its stream-json output'], ['codex', 1, 'its JSON output (codex exec --json)']]);
    // Antigravity's tokens are read from its output since FR-010 (it comes through pipes, not a window of its own)
    const agy = b.usage.engines.find((e) => e.engine === 'agy');
    assert.deepEqual([agy.tokensKnown, agy.reported, agy.tokens, agy.notReported], [true, 1, 2150, '']);
  } finally {
    live?.close();
    const stopped = stopUi(ui);
    bg?.kill();
    const run = fs.existsSync(p.jobFile('M8-06-fail', 'run.json')) ? JSON.parse(fs.readFileSync(p.jobFile('M8-06-fail', 'run.json'), 'utf8')) : null;
    if (run?.pid && isAlive(run.pid)) {
      if (IS_WIN) spawnSync('taskkill', ['/PID', String(run.pid), '/T', '/F'], { windowsHide: true });
      else {
        try {
          process.kill(-run.pid, 'SIGKILL');
        } catch {
          // already gone
        }
      }
    }
    await stopped;
    await processesGone([bg?.pid, run?.pid]);
    p.cleanup();
  }
});

test('Show activity: a running task\'s progress notes and its engine\'s steps as a technical feed (Claude Code, Codex, Antigravity since FR-010), redacted, asked for only while open', async () => {
  const p = makeProject();
  let ui;
  let live;
  let bg;
  const ids = { claude: 'M10-03-activity', codex: 'M10-04-activity', agy: 'M10-05-activity' };
  const slotOf = (id) => path.join(path.dirname(p.repo), 'proj.slots', `w${p.status(id).slot}`);
  try {
    p.setConfig((c) => ({ ...c, workers: { ...c.workers, slots: 3 } }));
    for (const id of Object.values(ids)) p.spec(id, fileExists('ok.mjs'));
    p.hub(['dispatch', ids.claude, '--engine', 'claude']);
    p.hub(['dispatch', ids.codex, '--engine', 'codex']);
    p.hub(['dispatch', ids.agy]);
    ui = await startUi(p);
    live = feed(ui);
    const api = client(ui);
    bg = p.hubInBackground(['run', '--tick-ms', '200']);
    // Home gets each running task's latest note; the feed is never in the build data
    const b = await live.until('build', (x) => x.ok && Object.values(ids).every((id) => x.active.find((j) => j.id === id)?.progress?.line === 'Waiting for the test to look at this page'));
    assert.ok(!JSON.stringify(b).includes('"feed"'), 'the feed comes only from /api/activity');
    const page = await request(ui.port, { path: '/app.js' });
    assert.match(page.text, /Show activity/);
    assert.match(page.text, /localStorage\.setItem\(ACTIVITY_KEY/, 'which toggles are open is remembered in the browser');

    const home = p.env.HOME;
    for (const [eng, id] of Object.entries(ids)) {
      const r = await api.get(`/api/activity?id=${id}`);
      assert.equal(r.status, 200, r.text);
      const a = r.json;
      assert.deepEqual([a.id, a.state, a.attempt, a.engine], [id, 'running', 1, eng]);
      // progress notes, newest first, redacted like a report
      assert.deepEqual(a.notes.lines, ['Waiting for the test to look at this page', 'Fixing the failing test: the fixture had *** in it', 'Writing ok.mjs: the spec asks for one export', `Reading the task: ${id} on ${eng}`]);
      assert.equal(a.notes.file, '.nextlevel-task/PROGRESS.md');
      assert.ok(a.notes.at);
      assert.ok(!r.text.includes('ghp_'), `${eng}: token shapes are redacted`);
      assert.ok(!r.text.includes(home) && !r.text.includes(home.replace(/\\/g, '\\\\')), `${eng}: the home folder is not shown`);
      // the feed, newest first: the test run that passed, its message, a command, the edit, the test run that failed.
      // (Antigravity's JSON doesn't say a command's exit code: its commands' results are what they printed)
      assert.equal(a.feed.available, true);
      const exit = (ok) => (eng === 'agy' ? null : ok);
      assert.deepEqual(a.feed.events.map((e) => [e.kind, e.text, e.detail, e.ok]), [
        ['test', 'npm test', '2 passed, 0 failed', exit(true)],
        ['message', 'The tests pass now; committing.', '', null],
        ['command', 'node -e "console.log(process.cwd())"', `${IS_WIN ? '%USERPROFILE%' : '~'} and ***`, exit(true)],
        ['edit', 'edited ok.mjs', '', true],
        ['test', 'npm test', '1 passed, 1 failed', exit(false)],
      ], eng);
    }
    assert.equal((await api.get('/api/activity?id=nope')).status, 404);
    assert.equal((await api.get('/api/activity?id=..%2Fx')).status, 404);

    // Done: the notes stay beside the job, and its details show them
    for (const id of Object.values(ids)) fs.writeFileSync(path.join(slotOf(id), '.nextlevel-task', 'GO'), '');
    await live.until('build', (x) => Object.values(ids).every((id) => x.review.some((j) => j.id === id && j.state === 'done')));
    const job = await api.get(`/api/job?id=${ids.claude}`);
    assert.deepEqual(job.json.progress.at(-1), 'Waiting for the test to look at this page', 'oldest first, as written');
    assert.match(fs.readFileSync(p.jobFile(ids.codex, 'PROGRESS.md'), 'utf8'), /Writing ok\.mjs/);
    const later = await api.get(`/api/activity?id=${ids.codex}`);
    assert.equal(later.json.notes.lines[0], 'Waiting for the test to look at this page');
    assert.equal(later.json.feed.events[0].kind, 'test');
    // The Build page's log reads as steps, not JSON
    assert.ok(!job.json.logs['worker.log · attempt 1'].some((l) => l.trim().startsWith('{"type"')), job.json.logs['worker.log · attempt 1'].join('\n'));
    assert.ok(job.json.logs['worker.log · attempt 1'].includes('$ npm test'));

    // The dashboard keeps its port, so the browser keeps what it remembered: it notes it, and takes it again
    assert.equal(JSON.parse(fs.readFileSync(p.state('ui-port.json'), 'utf8')).port, ui.port);
    live.close();
    live = null;
    stopUi(ui);
    for (let i = 0; i < 50 && ui.child.exitCode === null; i++) await sleep(100);
    const free = await new Promise((resolve) => {
      const probe = net.createServer().listen(0, '127.0.0.1', () => {
        const { port } = probe.address();
        probe.close(() => resolve(port));
      });
    });
    fs.writeFileSync(p.state('ui-port.json'), JSON.stringify({ port: free })); // (a port no connection has used yet)
    ui = await startUi(p);
    assert.equal(ui.port, free, 'the port it had last time');
  } finally {
    live?.close();
    const stopped = stopUi(ui);
    if (bg) {
      fs.writeFileSync(p.state('hub-stop.json'), '{}');
      for (let i = 0; i < 50 && bg.exitCode === null; i++) await sleep(200);
      bg.kill();
    }
    for (const id of Object.values(ids)) {
      try {
        const { pid } = JSON.parse(fs.readFileSync(p.jobFile(id, 'run.json'), 'utf8'));
        if (pid && isAlive(pid)) {
          if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
          else process.kill(-pid, 'SIGKILL');
        }
      } catch {
        // not started, or gone
      }
    }
    await stopped;
    await processesGone([bg?.pid]);
    p.cleanup();
  }
});

test('Ask: the panel on every page, a question answered read-only, its threads, and a note only the owner sends', async () => {
  const p = makeProject();
  let ui;
  let live;
  try {
    ui = await startUi(p);
    live = feed(ui);
    const api = client(ui);
    // On every page: a button in the header and the slide-out panel
    const page = await request(ui.port, { path: '/' });
    assert.match(page.text, /id="ask-open"/);
    assert.match(page.text, /<aside class="ask" id="ask" hidden/);
    const app = await request(ui.port, { path: '/app.js' });
    assert.match(app.text, /api\('\/api\/ask', \{ question/);
    assert.match(app.text, /api\('\/api\/notes', \{ action: 'add'/, 'a draft note goes through the Notes cards');

    // What the page may send
    assert.equal((await api.post('/api/ask', { question: '' })).status, 400);
    assert.equal((await api.post('/api/ask', { question: 'x'.repeat(4001) })).status, 400);
    assert.equal((await api.post('/api/ask', { question: 'hi', thread: '../x' })).status, 400);
    assert.equal((await api.post('/api/chats', { action: 'rename', id: '../x', title: 'y' })).status, 400);
    assert.equal((await api.get('/api/chat?id=nope1234')).status, 404);

    // A question: answered by a fresh read-only session, never the orchestrator
    const r = await api.post('/api/ask', { question: 'What is next?' });
    assert.equal(r.status, 200, r.text);
    assert.match(r.json.answer.text, /You asked: What is next\?/);
    assert.deepEqual(r.json.answer.note, { type: 'once', text: 'Finish M0 before you start M1.' });
    const id = r.json.thread.id;
    const follow = await api.post('/api/ask', { question: 'And then?', thread: id });
    assert.equal(follow.json.thread.id, id);
    assert.equal((await api.get(`/api/chat?id=${id}`)).json.thread.messages.length, 4);
    // Threads: listed, searched, renamed, started, cleared, deleted
    assert.deepEqual((await api.get('/api/chats')).json.threads.map((t) => t.id), [id]);
    assert.equal((await api.get('/api/chats?q=AND%20THEN')).json.threads.length, 1);
    assert.equal((await api.get('/api/chats?q=nothing-like-this')).json.threads.length, 0);
    assert.equal((await api.post('/api/chats', { action: 'rename', id, title: 'Next steps' })).json.thread.title, 'Next steps');
    const fresh = (await api.post('/api/chats', { action: 'new', title: 'Scratch' })).json.thread;
    assert.deepEqual((await api.post('/api/chats', { action: 'clear', id: fresh.id })).json.thread.messages, []);
    assert.equal((await api.post('/api/chats', { action: 'delete', id: fresh.id })).status, 200);
    assert.deepEqual((await api.get('/api/chats')).json.threads.map((t) => t.title), ['Next steps']);

    // Nothing reached the orchestrator: no note until the owner sends the draft
    assert.match(p.hub(['note', 'list']).out, /no notes|none/i);
    const sent = await api.post('/api/notes', { action: 'add', text: r.json.answer.note.text, type: 'once' });
    assert.equal(sent.status, 200, sent.text);
    assert.match(p.hub(['note', 'list']).out, /Finish M0 before you start M1\./);
    // Today: the assistant's own row
    const b = await live.until('build', (x) => x.ok && x.usage.roles.find((row) => row.key === 'assistant')?.count >= 2);
    const row = b.usage.roles.find((x) => x.key === 'assistant');
    assert.equal(row.title, 'Advisor');
    assert.ok(row.tokens > 0, 'its tokens');
    // (the advisor's automatic choice: an installed engine other than the Codex orchestrator's)
    const advisorRow = b.team.find((x) => x.key === 'assistant');
    assert.deepEqual([advisorRow.engineTitle, advisorRow.title, advisorRow.independent.ok], ['Claude Code', 'Advisor', true]);

    // The advisor: Quick or Advise, Explain of a team's card, what a question sends, and its memory
    assert.equal((await api.post('/api/ask', { question: 'hi', mode: 'loud' })).status, 400);
    assert.equal((await api.post('/api/ask', { question: 'hi', card: '../H1' })).status, 400);
    const quick = await api.post('/api/ask', { question: 'Quick one?', mode: 'quick' });
    assert.deepEqual([quick.json.answer.mode, quick.json.answer.engine], ['quick', 'codex']);
    assert.equal(p.hub(['handoff', 'add', 'Set the SMTP login', '--where', '.env', '--why', 'mail']).code, 0);
    const explained = await api.post('/api/ask', { card: 'H1' });
    assert.equal(explained.status, 200, explained.text);
    assert.deepEqual([explained.json.answer.mode, explained.json.thread.title], ['explain', 'Explain H1']);
    // a draft the owner sent is marked on its answer in the thread, so a reload shows it sent and never its Send again
    const eid = explained.json.thread.id;
    const msgs = (await api.get(`/api/chat?id=${eid}`)).json.thread.messages;
    const at = msgs.length - 1;
    const answer = msgs[at];
    assert.equal(answer.drafts[0].kind, 'note');
    assert.equal((await api.post('/api/chats', { action: 'sent', id: eid, index: at, at: 'an old time', draft: 0, label: 'Sent as a note' })).status, 409, 'another answer');
    assert.equal((await api.post('/api/chats', { action: 'sent', id: eid, index: at, at: answer.at, draft: 9, label: 'x' })).status, 409, 'no such draft');
    assert.equal((await api.post('/api/chats', { action: 'sent', id: eid, index: '1', at: answer.at, draft: 0 })).status, 400);
    assert.equal((await api.post('/api/chats', { action: 'sent', id: eid, index: at, at: answer.at, draft: 0, label: 'Sent as a note' })).status, 200);
    assert.deepEqual((await api.get(`/api/chat?id=${eid}`)).json.thread.messages[at].sent, { 0: 'Sent as a note' });
    const est = await api.get('/api/ask/estimate?mode=advise');
    assert.equal(est.status, 200, est.text);
    assert.ok(est.json.tokens > 100 && est.json.tokens === Math.round(est.json.chars / 4));
    assert.ok((await api.get('/api/ask/estimate?mode=quick')).json.chars < est.json.chars, 'Quick sends less');
    assert.ok((await api.get('/api/ask/estimate?card=H1')).json.chars > est.json.chars, 'Explain sends the card too');
    assert.equal((await api.get('/api/ask/estimate?mode=x')).status, 400);
    // memory: the owner's click, behind the session key; no route takes anything else
    assert.equal((await request(ui.port, { method: 'POST', path: '/api/advisor/memory', body: { action: 'add', text: 'x' } })).status, 403, 'no key');
    assert.equal((await api.post('/api/advisor/memory', { action: 'wipe' })).status, 400);
    assert.equal((await api.post('/api/advisor/memory', { action: 'remove', id: '../M1' })).status, 400);
    const remembered = await api.post('/api/advisor/memory', { action: 'add', text: 'Small PRs, one step each.', kind: 'preference', from: id });
    assert.equal(remembered.status, 200, remembered.text);
    assert.deepEqual([remembered.json.item.id, remembered.json.item.from], ['M1', id]);
    assert.equal((await api.post('/api/advisor/memory', { action: 'edit', id: 'M1', text: 'Small PRs.' })).json.item.text, 'Small PRs.');
    assert.deepEqual((await api.get('/api/advisor/memory')).json.items.map((x) => x.text), ['Small PRs.']);
    assert.equal((await api.post('/api/advisor/memory', { action: 'remove', id: 'M9' })).status, 409);
    assert.equal((await api.post('/api/advisor/memory', { action: 'remove', id: 'M1' })).json.removed, 'M1');
    // a memory change gives the team nothing to do: no owner action for autopilot
    assert.ok(!fs.existsSync(p.state('round-now.json')));
  } finally {
    live?.close();
    stopUi(ui);
    p.cleanup();
  }
});

test("the dashboard's git reads never take a slot's index.lock (the race with the hub's commit of a worker's changes)", async () => {
  const p = makeProject();
  let ui;
  let live;
  let bg;
  const id = 'M1-05-activity';
  try {
    p.spec(id, fileExists('ok.mjs'));
    p.hub(['dispatch', id, '--engine', 'codex']);
    ui = await startUi(p);
    live = feed(ui);
    const api = client(ui);
    bg = p.hubInBackground(['run', '--tick-ms', '200']);
    await live.until('build', (x) => x.ok && x.active.find((j) => j.id === id)?.progress?.line === 'Waiting for the test to look at this page');
    const slot = path.join(path.dirname(p.repo), 'proj.slots', `w${p.status(id).slot}`);
    const gitIn = (...a) => spawnSync('git', a, { cwd: slot, encoding: 'utf8' });
    const index = path.resolve(slot, gitIn('rev-parse', '--git-path', 'index').stdout.trim());
    // A tracked file touched (the same content, a new time): a `git status` that may take the lock writes the index
    // back, and holds index.lock while it does, which is what stopped the hub's `git add -A`
    const later = new Date(Date.now() + 120_000);
    fs.utimesSync(path.join(slot, 'nextlevel.json'), later, later);
    const before = fs.readFileSync(index);
    for (let i = 0; i < 3; i++) {
      const s = await api.get('/api/state'); // the Build page's data: `git status --porcelain` in the running task's slot
      assert.ok(s.json.active.find((j) => j.id === id).changed.some((l) => l.includes('ok.mjs')), s.text);
    }
    assert.ok(fs.readFileSync(index).equals(before), "the dashboard's git status left the slot's index alone: it took no lock");
    // The same `git status` as git runs it by default does write it
    gitIn('status', '--porcelain');
    assert.ok(!fs.readFileSync(index).equals(before), 'a plain git status writes the index (so the check above means something)');
    // And the hub still commits what the worker left
    fs.writeFileSync(path.join(slot, '.nextlevel-task', 'GO'), '');
    await live.until('build', (x) => x.review.some((j) => j.id === id && j.state === 'done'));
  } finally {
    live?.close();
    const stopped = stopUi(ui);
    if (bg) {
      fs.writeFileSync(p.state('hub-stop.json'), '{}');
      for (let i = 0; i < 50 && bg.exitCode === null; i++) await sleep(200);
      bg.kill();
    }
    try {
      const { pid } = JSON.parse(fs.readFileSync(p.jobFile(id, 'run.json'), 'utf8'));
      if (pid && isAlive(pid)) {
        if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-pid, 'SIGKILL');
      }
    } catch {
      // not started, or gone
    }
    await stopped;
    await processesGone([bg?.pid]);
    p.cleanup();
  }
});

test(
  "a console with no window that has no input to give (FR-010, FR-013): the attempt starts again in a window of its own, the PC remembers it, and Show activity says why",
  // It opens real windows, which take the focus: CI only
  { skip: (!IS_WIN && 'windows are for Windows') || (!process.env.CI && 'opens windows that take the focus: CI only') },
  async () => {
    const p = makeProject();
    let ui;
    const ids = ['M0-06-console', 'M0-07-console'];
    try {
      for (const id of ids) p.spec(id, fileExists('console.txt'));
      // A PC whose console with no window has no input to give (NEXTLEVEL_CONIN names a file that isn't there)
      const env = { NEXTLEVEL_WORKER_WINDOW: undefined, NEXTLEVEL_CONIN: path.join(p.repo, 'no-console-here') };
      // (the model check's trial passes first, where the console works: the hub keeps its answer and runs no trial of its own
      // before the task, so it is the worker's process that finds no console, as this test is about; FR-022)
      assert.equal(JSON.parse(p.hub(['doctor', '--json']).out).results.find((x) => x.id === 'agy.model').status, 'ok');
      p.hub(['dispatch', ids[0]]);
      const r = p.runUntilIdle([], { extraEnv: env });
      const first = p.status(ids[0]);
      assert.deepEqual([first.state, first.windowMode], ['done', 'visible'], r.out);
      assert.match(first.launch.note, /^The console with no window didn't start on this PC \(its process found no console to give the engine \(exit 3\)\), so this worker runs in a window of its own/);
      assert.match(fs.readFileSync(p.jobFile(ids[0], 'RESULT.md'), 'utf8'), /Console: tty[\s\S]*In window: visible/);
      const hubLog = () => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
      assert.match(hubLog(), /started M0-06-console in slot w1 \(agy, attempt 1; in a console with no window\)[\s\S]*M0-06-console: the console with no window didn't start \(its process found no console to give the engine \(exit 3\)\); it starts again in a window of its own/);
      assert.equal(JSON.parse(fs.readFileSync(path.join(p.env.HOME, '.nextlevel', 'console.json'), 'utf8')).failed.why, 'its process found no console to give the engine (exit 3)');
      // The next worker goes to a window straight away, and says why
      p.hub(['dispatch', ids[1]]);
      p.runUntilIdle([], { extraEnv: env });
      const second = p.status(ids[1]);
      assert.deepEqual([second.state, second.windowMode], ['done', 'visible']);
      assert.match(second.launch.note, /didn't start on this PC \(its process found no console to give the engine \(exit 3\), \d+ min ago\)/);
      assert.match(hubLog(), /started M0-07-console in slot w\d \(agy, attempt 1; in a window of its own\)/);
      // Show activity says it, above the notes and the feed
      ui = await startUi(p, env);
      const a = await client(ui).get(`/api/activity?id=${ids[0]}`);
      assert.deepEqual(a.json.launch.mode, 'visible');
      assert.match(a.json.launch.text, /^The console with no window didn't start on this PC/);
      assert.match((await request(ui.port, { path: '/app.js' })).text, /Started in a window of its own\. /);
    } finally {
      stopUi(ui);
      p.cleanup();
    }
  },
);
