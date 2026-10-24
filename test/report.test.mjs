// nextlevel report (M5): the field report's text, its redaction (with planted fake secrets), the owner's
// approval, and filing it through the gh stub. Nothing here reaches GitHub.
//   npm test
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { buildReport, redactReport, reportSecrets } from '../src/report.mjs';
import { fakeContext } from './fake-context.mjs';
import { BIN, makeProject, withEnv } from './helpers.mjs';

// Fake secrets, each in a shape a real one has. None may ever appear in a report.
const PLANTED = {
  NTFY_TOPIC: 'planted-topic-9f8e7d6c5b4a3210',
  OPENAI_API_KEY: 'sk-proj-PLANTEDopenai1234567890',
  STRIPE_SECRET: 'sk_live_PLANTEDstripe123456',
  DB_PASSWORD: 'pl4nted-pw!x',
  SHORT: 'q7z2',
};
const OTHERS = [
  'ghp_PLANTEDghtoken1234567890abcd',
  'PLANTEDbearer0123456789abcdef',
  'PLANTEDurlpass',
  'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJwbGFudGVkIn0.PLANTEDsignature',
  'AKIAPLANTEDKEY012345',
  'MIIEplantedkeymaterial',
  'planted-env-token-1234',
];
const MARKERS = ['BRIEF-MARKER-7431', 'CODE-MARKER-2210', 'TASK-MARKER-5512', 'PROJECT-CHECK-MARKER-8080'];
const leaks = (text) => [...Object.values(PLANTED).filter((v) => v.length >= 4), ...OTHERS, ...MARKERS].filter((v) => text.includes(v));

test('redactReport blanks out every .env value, token shapes, keys and logins, and the home folder; ordinary text stays', () => {
  const secrets = { values: Object.values(PLANTED), names: Object.keys(PLANTED), home: '/home/me', platform: 'linux' };
  const text = [
    `ntfy ${PLANTED.NTFY_TOPIC} key ${PLANTED.OPENAI_API_KEY} stripe ${PLANTED.STRIPE_SECRET} pw ${PLANTED.DB_PASSWORD}`,
    `SHORT=${PLANTED.SHORT} and "${PLANTED.SHORT}" alone`,
    `token ${OTHERS[0]}; Authorization: Bearer ${OTHERS[1]}; https://me:${OTHERS[2]}@github.com/o/r.git`,
    `jwt ${OTHERS[3]} aws ${OTHERS[4]}`,
    '-----BEGIN RSA PRIVATE KEY-----',
    OTHERS[5],
    '-----END RSA PRIVATE KEY-----',
    `MY_SERVICE_TOKEN=${OTHERS[6]} GH_TOKEN: ${OTHERS[6]}`,
    'folder /home/me/.nextlevel/tool, not /home/meadow',
    'Codex model: "gpt-6-sol" was rejected; Basic setup instructions; token budget; PORT=3000; git version 2.55.0',
    "put the name in the project's .env as NTFY_TOPIC=...",
  ].join('\n');
  const out = redactReport(text, secrets);
  assert.deepEqual(leaks(out), [], out);
  assert.match(out, /SHORT=\*\*\*/);
  assert.match(out, /Bearer \*\*\*/);
  assert.match(out, /https:\/\/\*\*\*@github\.com\/o\/r\.git/);
  assert.match(out, /folder ~\/\.nextlevel\/tool, not \/home\/meadow/);
  assert.match(out, /Codex model: "gpt-6-sol" was rejected; Basic setup instructions; token budget; PORT=3000; git version 2\.55\.0/, 'ordinary text is left alone');
  assert.match(out, /as NTFY_TOPIC=\.\.\.$/, 'a placeholder is no secret');
  // A .env value with a login and a token in it goes whole: nothing of its host or database is left
  const url = 'postgres://u:sk_live_PLANTEDdb12345678@db.internal.example:5432/app';
  assert.equal(redactReport(`db ${url} up`, { values: [url], names: ['DATABASE_URL'] }), 'db *** up');
  // The home folder in a Markdown code span
  assert.equal(redactReport('- this window: `/home/me`', { home: '/home/me', platform: 'linux' }), '- this window: `~`');
  // Windows: the home folder in either slash, any case
  assert.equal(redactReport('C:\\Users\\Me\\x and c:/users/me/y', { home: 'C:\\Users\\Me', platform: 'win32' }), '%USERPROFILE%\\x and %USERPROFILE%/y');
  // The values come from the project's .env and from variables whose names say secret
  const ctx = fakeContext({ files: { '/proj/.env': 'NTFY_TOPIC=abcdefgh\nX=1\n' }, env: { PLANTED_API_TOKEN: 'from-the-window-123', SOME_SECRET: 'true', PATH: '/usr/bin' } });
  const found = reportSecrets(ctx);
  assert.deepEqual(found.names, ['NTFY_TOPIC', 'X']);
  assert.ok(found.values.includes('abcdefgh') && found.values.includes('from-the-window-123'));
  assert.ok(!found.values.includes('/usr/bin') && !found.values.includes('true'), 'not a path, not a word');
  assert.equal(redactReport('autopilot true, SETTING=true', { values: ['true'], names: ['SETTING'] }), 'autopilot true, SETTING=***');
});

test("buildReport: the failed check first, versions, OS, paths, every check and the hub log; the project's own checks are left out", () => {
  const ctx = fakeContext({ files: { '/proj/.nextlevel/logs/hub.log': 'line 1\nhub started · 2 worker slot(s) in /home/me/proj.slots\n' }, home: '/home/me' });
  const results = [
    { id: 'tool.git', title: 'Git', status: 'ok', severity: 'error', detail: 'git version 2.55.0', next: '', steps: [], message: '' },
    { id: 'codex.model', title: 'Codex model', status: 'fail', severity: 'error', detail: '"gpt-6-sol" was rejected', next: 'leave it empty', steps: [{ window: 'codex', command: '/model', text: 'to see the names' }], message: '' },
    { id: 'git.pushed', title: 'Pushed', status: 'fail', severity: 'warn', detail: 'origin has no main', next: '', steps: [], message: '' },
    { id: 'hub.running', title: 'Hub', status: 'fail', severity: 'info', detail: 'stopped', next: '', steps: [], message: '' },
    { id: 'acme.smtp', title: 'SMTP', status: 'fail', severity: 'warn', detail: 'PROJECT-CHECK-MARKER-8080', source: '.nextlevel/checks/smtp.mjs', next: '', steps: [], message: '' },
  ];
  const one = buildReport(ctx, results, { checkId: 'codex.model', repo: 'o/r' });
  assert.equal(one.ok, true);
  assert.equal(one.title, 'Field report: Codex model (codex.model) on Linux');
  assert.deepEqual(one.checks, ['codex.model']);
  assert.match(one.body, /^<!-- nextlevel-report v1 checks=codex\.model os=linux /);
  assert.match(one.body, /### `codex\.model` · Codex model \(error\)\n\n\*\*Found:\*\* "gpt-6-sol" was rejected\n\*\*Next, it says:\*\* leave it empty/);
  assert.match(one.body, /- Inside Codex: `\/model` \(to see the names\)/);
  assert.match(one.body, /\n\nA nextlevel check fails on this PC\.\n/);
  assert.doesNotMatch(one.body, /did not fix|Automatic fix/, "only what nextlevel knows: not whether the owner tried the steps; no automatic fix here");
  // A check with an automatic fix: whether it ran just before, was declined, or wasn't offered (the dashboard's way)
  const fixable = results.map((x) => (x.id === 'codex.model' ? { ...x, fixable: true } : x));
  assert.match(buildReport(ctx, fixable, { checkId: 'codex.model', repo: 'o/r' }).body, /\*\*Automatic fix:\*\* `nextlevel doctor --fix codex\.model` \(not run for this report\)/);
  assert.match(buildReport(ctx, fixable, { checkId: 'codex.model', repo: 'o/r', tried: { 'codex.model': 'ran' } }).body, /\*\*Automatic fix:\*\* it ran just before this report, and the check still fails/);
  assert.match(buildReport(ctx, fixable, { checkId: 'codex.model', repo: 'o/r', tried: { 'codex.model': 'declined' } }).body, /\*\*Automatic fix:\*\* offered just before this report; the owner did not run it/);
  assert.match(one.body, /\| Git \| git version 2\.55\.0 \|/);
  assert.match(one.body, /\| Codex CLI \| not checked \|/);
  assert.match(one.body, /\| \*\*!!\*\* \| `codex\.model` \| "gpt-6-sol" was rejected → leave it empty \|/);
  assert.match(one.body, /hub started · 2 worker slot\(s\) in ~\/proj\.slots/);
  assert.match(one.body, /1 check\(s\) of the project's own are left out/);
  assert.doesNotMatch(one.body, /PROJECT-CHECK-MARKER|acme\.smtp/);

  // A secret where a long hub log line is cut: redacted before the cut, so no part of it is left
  const secret = 'Zq9PLANTEDlongsecretvalue0123456';
  const long = fakeContext({ files: { '/proj/.env': `DB_PASS=${secret}\n`, '/proj/.nextlevel/logs/hub.log': `${'x'.repeat(285)} ${secret} end\n` } });
  const cut = buildReport(long, results, { checkId: 'codex.model', repo: 'o/r' });
  assert.ok(!cut.body.includes(secret.slice(0, 8)), 'no part of it');
  assert.match(cut.body, /x{285} \*\*\* end/);

  const all = buildReport(ctx, results, { repo: 'o/r' });
  assert.deepEqual(all.checks, ['codex.model', 'git.pushed'], 'errors and warnings of nextlevel\'s own checks; notes and project checks are not');
  assert.match(all.body, /\n\nThese nextlevel checks fail on this PC\.\n/);
  assert.equal(all.title, 'Field report: 2 checks fail on Linux (codex.model, git.pushed)');
  for (const [id, why] of [
    ['tool.git', /passes now: there is nothing to report/],
    ['nope.nope', /nextlevel has no check "nope\.nope"/],
    ['acme.smtp', /nextlevel has no check "acme\.smtp".*of the project's own/],
  ]) {
    const r = buildReport(ctx, results.map((x) => (x.id === 'acme.smtp' ? null : x)).filter(Boolean), { checkId: id, repo: 'o/r' });
    assert.equal(r.ok, false, id);
    assert.match(r.message, why);
  }
  assert.match(buildReport(ctx, results.slice(0, 1), { repo: 'o/r' }).message, /No check fails/);
});

// The project the end-to-end tests report from: secrets planted in its .env, this window and its hub log;
// markers in its brief, code, a task and a check of its own; and a Codex model the stub rejects.
function plantedProject() {
  const p = makeProject();
  fs.writeFileSync(path.join(p.repo, '.env'), `${Object.entries(PLANTED).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  fs.writeFileSync(path.join(p.repo, 'BRIEF.md'), `# Brief\n\n${MARKERS[0]}\n`);
  fs.mkdirSync(path.join(p.repo, 'src'));
  fs.writeFileSync(path.join(p.repo, 'src', 'secret-sauce.js'), `// ${MARKERS[1]}\n`);
  fs.writeFileSync(path.join(p.repo, 'docs', 'tasks', 'T9.md'), `# T9\n\n${MARKERS[2]}\n`);
  fs.mkdirSync(p.state('checks'), { recursive: true });
  fs.writeFileSync(p.state('checks', 'own.mjs'), `export default { id: 'proj.own', title: 'Own', severity: 'warn', run: () => ({ ok: false, detail: '${MARKERS[3]}' }) };\n`);
  fs.mkdirSync(p.state('logs'), { recursive: true });
  const home = p.env.HOME;
  fs.writeFileSync(
    p.state('logs', 'hub.log'),
    [
      `2026-09-26T10:00:00.000Z  hub started · 2 worker slot(s) in ${path.join(home, 'proj.slots')}`,
      `2026-09-26T10:00:01.000Z  hub error: push failed for https://me:${OTHERS[2]}@github.com/o/r.git with ${OTHERS[0]}`,
      `2026-09-26T10:00:02.000Z  hub error: Authorization: Bearer ${OTHERS[1]} rejected; key ${PLANTED.OPENAI_API_KEY}`,
      `2026-09-26T10:00:03.000Z  check-env: DB_PASSWORD=${PLANTED.DB_PASSWORD} SHORT=${PLANTED.SHORT} STRIPE ${PLANTED.STRIPE_SECRET} topic ${PLANTED.NTFY_TOPIC}`,
      `2026-09-26T10:00:04.000Z  jwt ${OTHERS[3]} aws ${OTHERS[4]} env ${OTHERS[6]}`,
      '-----BEGIN RSA PRIVATE KEY-----',
      OTHERS[5],
      '-----END RSA PRIVATE KEY-----',
    ].join('\n'),
  );
  p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'codex', model: 'gpt-6-sol' } } }));
  const env = { PLANTED_API_TOKEN: OTHERS[6] };
  const report = (args, opts = {}) => p.hub(['report', ...args], { ...opts, extraEnv: { ...env, ...opts.extraEnv } });
  const issuesDir = path.join(home, '.fake-github', 'issues');
  const issues = () => (fs.existsSync(issuesDir) ? fs.readdirSync(issuesDir).map((f) => JSON.parse(fs.readFileSync(path.join(issuesDir, f), 'utf8'))) : []);
  return { ...p, report, issues };
}
const between = (out, a, b) => out.slice(out.indexOf(a) + a.length, out.indexOf(b)).replace(/^[^\n]*\n/, '').replace(/\n$/, '');

test('nextlevel report shows the owner exactly what it would file and files nothing without a yes', () => {
  const p = plantedProject();
  try {
    const no = p.report(['codex.model'], { input: 'n\n' });
    assert.equal(no.code, 0, no.out);
    assert.match(no.out, /exactly as it would go to GitHub: a new issue in DYevseyev\/nextlevelorc, labelled field-report/);
    assert.match(no.out, /Field report: Codex model \(codex\.model\) on (Linux|Windows|macOS)/);
    assert.match(no.out, /File it on GitHub \(DYevseyev\/nextlevelorc\)\? \[y\/N\] n/);
    assert.match(no.out, /Not filed\. To file one later: nextlevel report codex\.model \(in your own window\), or the dashboard \(Setup: Report and fix\)\./);
    assert.deepEqual(p.issues(), [], 'nothing is filed');
    assert.deepEqual(leaks(no.out), [], 'no secret, no project text in what the owner is shown');
    // No answer at all (no one at the keyboard) is no too
    const silent = p.report(['codex.model'], { input: '' });
    assert.match(silent.out, /\(no answer: not filed\)/);
    assert.deepEqual(p.issues(), []);
  } finally {
    p.cleanup();
  }
});

test('nextlevel report files the text the owner read, redacted, with the field-report label; the fix can start from there', () => {
  const p = plantedProject();
  try {
    const r = p.report(['codex.model'], { input: 'y\nn\n' });
    assert.equal(r.code, 0, r.out);
    const [issue] = p.issues();
    assert.ok(issue, r.out);
    assert.match(r.out, new RegExp(`Filed: #1 ${issue.url.replace(/[./]/g, '\\$&')}`));
    assert.match(r.out, /Start a Claude Code session that fixes it \(nextlevel fix 1\)\? \[y\/N\] n/);
    assert.match(r.out, /To have it fixed later: nextlevel fix 1/);
    assert.equal(issue.repo, 'DYevseyev/nextlevelorc');
    assert.deepEqual(issue.labels, ['field-report'], 'the label is made when the repository lacks it');
    // Exactly what was shown
    assert.equal(issue.title, between(r.out, '---------------- title', '---------------- text'));
    assert.equal(issue.body.replace(/\r\n/g, '\n'), between(r.out, '---------------- text', '---------------- end').replace(/\r\n/g, '\n'));
    // Only nextlevel's own facts, and nothing secret
    assert.match(issue.body, /### `codex\.model` · Codex model \(error\)/);
    assert.match(issue.body, /"gpt-6-sol" \(roles\.orchestrator\.model\) was rejected/);
    assert.match(issue.body, /\| Codex CLI \| codex-cli 0\.152\.0/);
    assert.match(issue.body, /\| Node\.js \| \d+\.\d+\.\d+ \|/);
    assert.match(issue.body, /the last \d+ lines of \.nextlevel.logs.hub\.log/);
    assert.deepEqual(leaks(`${issue.title}\n${issue.body}`), [], issue.body);
    assert.ok(!issue.body.includes(p.env.HOME), 'the home folder shows as ~');
    assert.match(issue.body, /(~|%USERPROFILE%)[\\/]proj\.slots/);
    assert.doesNotMatch(issue.body, /proj\.own/, "the project's own check isn't in it");

    // No command files a kept report (FR-017): --send, which did, refuses and says where a report is filed
    const [kept] = fs.readdirSync(path.join(p.env.HOME, '.nextlevel', 'reports')).filter((f) => f.endsWith('.json'));
    const id = kept.replace(/\.json$/, '');
    for (const args of [['--send', id], ['--send', id, '--hash', JSON.parse(fs.readFileSync(path.join(p.env.HOME, '.nextlevel', 'reports', kept), 'utf8')).hash, '--json']]) {
      const again = p.report(args, { input: 'y\n' });
      assert.equal(again.code, 1, again.out);
      assert.match(again.out, /Nothing was filed: nextlevel report --send doesn't file from the command line any more\. A report is filed from the dashboard \(Setup: Report and fix, then File it, under the text it shows you\), or by nextlevel report in your own PowerShell window, which shows it and asks you\./);
    }
    assert.equal(p.issues().length, 1);
  } finally {
    p.cleanup();
  }
});

// After the install moved to another repository (where nextlevel is published), a report goes where state.json "reports"
// says (the repository the install left, lib/install.mjs keepWhatMoved), never to the new one by itself; and a report
// whose issue would be public says so, in the window and to the dashboard.
test('a moved install files reports where state.json "reports" says, and a public target is said before anything is filed', () => {
  const p = plantedProject();
  try {
    const repos = path.join(p.env.HOME, '.fake-github', 'repos');
    fs.mkdirSync(repos, { recursive: true });
    fs.writeFileSync(path.join(repos, 'DYevseyev__nextlevelorc.json'), JSON.stringify({ visibility: 'public' }));
    fs.writeFileSync(path.join(repos, 'owner__private-reports.json'), JSON.stringify({ visibility: 'private' }));
    const pub = p.report(['codex.model'], { input: 'n\n' });
    assert.match(pub.out, /a new PUBLIC issue in DYevseyev\/nextlevelorc, labelled field-report\. Anyone can read it\./, pub.out);
    const json = p.report(['codex.model', '--json']);
    assert.equal(JSON.parse(json.out).visibility, 'public', json.out);

    const stateFile = path.join(p.env.HOME, '.nextlevel', 'state.json');
    const was = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
    fs.writeFileSync(stateFile, JSON.stringify({ ...was, reports: { repo: 'owner/private-reports', why: 'this install moved' } }));
    const r = p.report(['codex.model'], { input: 'y\nn\n' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /a new issue in owner\/private-reports, labelled field-report\.\n/, r.out);
    assert.deepEqual(p.issues().map((i) => i.repo), ['owner/private-reports']);
  } finally {
    p.cleanup();
  }
});

// `nextlevel report <args>` in the owner's window, answered as it asks: each step waits for its question (a pattern in
// what the command printed since the step before) and then does its part: a function, or the answer typed.
function reportAsking(p, args, steps, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, 'report', ...args], { cwd: p.repo, env: withEnv(p.env, { PLANTED_API_TOKEN: OTHERS[6], ...extraEnv }) });
    let out = '';
    let from = 0;
    let i = 0;
    const onData = (d) => {
      out += d;
      while (i < steps.length) {
        const m = out.slice(from).match(steps[i][0]);
        if (!m) break;
        from += m.index + m[0].length; // (the next question may have come in the same piece of output)
        const act = steps[i++][1];
        const typed = typeof act === 'function' ? act(m) : act;
        if (typeof typed === 'string') child.stdin.write(typed);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      child.stdin.destroy();
      resolve({ code, out, done: i });
    });
  });
}

test("the owner leaves something out of a report in their own window: they edit the kept file before they answer, and what it holds then is shown again, redacted again, and asked again (FR-017: no command files a kept report)", async () => {
  const p = plantedProject();
  try {
    let file = '';
    const r = await reportAsking(p, ['codex.model'], [
      [/It is kept in (.+\.md)\. To leave something out, edit it there before you answer: what the file holds then is shown again, and you are asked again\./, (m) => void (file = m[1])],
      [
        /File it on GitHub \(DYevseyev\/nextlevelorc\)\? \[y\/N\] $/,
        () => {
          const body = fs.readFileSync(file, 'utf8');
          fs.writeFileSync(file, body.replace(/### Recent hub log[\s\S]*?<\/details>\n/, `### Recent hub log\n\n(left out by the owner; ${PLANTED.OPENAI_API_KEY})\n`));
          return 'y\n';
        },
      ],
      [/File your version on GitHub \(DYevseyev\/nextlevelorc\)\? \[y\/N\] $/, 'y\n'],
      [/Start a Claude Code session that fixes it \(nextlevel fix 1\)\? \[y\/N\] $/, 'n\n'],
    ]);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.done, 4, r.out);
    assert.match(r.out, /You changed .*\. This is what would be filed now:/);
    assert.match(r.out, /Filed: #1 /);
    const [issue] = p.issues();
    assert.match(issue.body, /### Recent hub log\n\n\(left out by the owner; \*\*\*\)/, 'redacted again');
    assert.doesNotMatch(issue.body, /hub error/);
    assert.deepEqual(leaks(`${issue.title}\n${issue.body}`), []);
    assert.equal(fs.readFileSync(file, 'utf8'), issue.body, 'the kept file is the text that was filed');
  } finally {
    p.cleanup();
  }
});

test('report --json keeps the report for the dashboard and files nothing; gh signed out or without leave to make labels; in an agent\'s session nothing files a report (FR-017)', () => {
  const p = plantedProject();
  try {
    const built = p.report(['codex.model', '--json']);
    assert.equal(built.code, 0, built.out);
    const j = JSON.parse(built.out);
    assert.equal(j.ok, true);
    assert.deepEqual(j.checks, ['codex.model']);
    assert.match(j.hash, /^[0-9a-f]{16}$/);
    assert.deepEqual(leaks(built.out), []);
    assert.deepEqual(p.issues(), [], '--json never files');
    assert.equal(fs.readFileSync(j.file, 'utf8'), j.body);

    // Filing is the owner's: in an agent's session (the orchestrator's window, an autopilot round, a verify command, a
    // worker's slot, the assistant) nextlevel report refuses, says why, and files nothing, whatever it is answered;
    // --json builds one there and files nothing
    const sessions = [
      [{ NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'interactive' }, "the orchestrator's window"],
      [{ NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: 'autopilot' }, 'an autopilot round'],
      [{ NEXTLEVEL_AGENT: 'check' }, 'a verify command the orchestrator asked for \\(nextlevel verify\\)'],
      [{ NEXTLEVEL_AGENT: 'worker', NEXTLEVEL_TASK_ID: 'M1-01' }, "a worker's slot"],
    ];
    for (const [env, who] of sessions) {
      const r = p.report(['codex.model'], { input: 'y\ny\n', extraEnv: env });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, new RegExp(`nextlevel report \\(it files an issue on GitHub with your sign-in when you answer yes\\) is the owner's, so it doesn't run in an agent's session \\(this is ${who}\\): nothing was done\\. The owner runs it in their own PowerShell window`));
      assert.doesNotMatch(r.out, /File it on GitHub/);
      assert.equal(JSON.parse(p.report(['codex.model', '--json'], { extraEnv: env }).out).ok, true, `--json in ${who}`);
    }
    assert.deepEqual(p.issues(), []);

    // gh signed out: not filed, and it says how to try again
    const out = p.report(['codex.model'], { input: 'y\n', extraEnv: { GH_TOKEN: 'expired' } });
    assert.equal(out.code, 1);
    assert.match(out.out, /Not filed: gh is not signed in: in PowerShell, gh auth login, then try again\. To try again: nextlevel report codex\.model \(in your own window; it builds the report again\), or the dashboard \(Setup: Report and fix\)\./);

    // An account that may not make labels: filed without it, and it says so
    const sent = p.report(['codex.model'], { input: 'y\nn\n', extraEnv: { STUB_GH_LABELS: 'deny' } });
    assert.match(sent.out, /Filed: #1 \S+ \(without the field-report label, which gh could not add/);
    assert.equal(p.issues()[0].labels.length, 0);

    // A check that passes, or nothing failing: nothing to report
    const passes = p.report(['tool.git']);
    assert.match(passes.out, /passes now: there is nothing to report/);
  } finally {
    p.cleanup();
  }
});

test("nextlevel report offers the doctor's automatic fixes first, and reports only what they don't fix", () => {
  const p = makeProject();
  try {
    // codex.args fails (a -c override, FR-004 #6), and the doctor can fix it
    const withC = ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
    p.setConfig((c) => ({ ...c, engines: { ...(c.engines || {}), codex: { ...(c.engines?.codex || {}), args: withC } } }));
    const issuesDir = path.join(p.env.HOME, '.fake-github', 'issues');

    // Declined: the report says so, and nothing claims the owner tried anything else
    const no = p.hub(['report', 'codex.args'], { input: 'n\nn\n' });
    assert.equal(no.code, 0, no.out);
    assert.match(no.out, /"Codex overrides" has an automatic fix \(the doctor's\): try it first, and the report is only about what it doesn't fix\./);
    assert.match(no.out, /Remove -c sandbox_workspace_write\.network_access=true from engines\.codex\.args in nextlevel\.json\? \[y\/N\] n/);
    assert.match(no.out, /A nextlevel check fails on this PC\.\n/);
    assert.match(no.out, /\*\*Automatic fix:\*\* offered just before this report; the owner did not run it/);
    assert.doesNotMatch(no.out, /did not fix/);
    assert.match(no.out, /File it on GitHub \(DYevseyev\/nextlevelorc\)\? \[y\/N\] n/);

    // The dashboard's way (--json) offers nothing (the page offers its Fix button first) and says how
    const j = JSON.parse(p.hub(['report', 'codex.args', '--json']).out);
    assert.match(j.body, /\*\*Automatic fix:\*\* `nextlevel doctor --fix codex\.args` \(not run for this report\)/);

    // Yes: fixed, so there is nothing left to report and nothing is filed
    const yes = p.hub(['report', 'codex.args'], { input: 'y\n' });
    assert.equal(yes.code, 0, yes.out);
    assert.match(yes.out, /Removed -c sandbox_workspace_write\.network_access=true from engines\.codex\.args/);
    assert.match(yes.out, /Fixed: Codex overrides\./);
    assert.match(yes.out, /"Codex overrides" \(codex\.args\) passes now: there is nothing to report\./);
    assert.doesNotMatch(yes.out, /File it on GitHub/);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(p.repo, 'nextlevel.json'), 'utf8')).engines.codex.args, ['--sandbox', 'workspace-write']);
    assert.ok(!fs.existsSync(issuesDir) || !fs.readdirSync(issuesDir).length, 'nothing filed');
  } finally {
    p.cleanup();
  }
});

test('nextlevel report works outside a project, and refuses inside Codex\'s sandbox', () => {
  const p = makeProject();
  try {
    const outside = p.nextlevel(['report', 'tool.git', '--json'], { cwd: p.tmp });
    assert.match(JSON.parse(outside.out).message, /passes now/);
    const all = p.nextlevel(['report', '--json'], { cwd: p.tmp });
    const j = JSON.parse(all.out);
    assert.equal(j.ok, true, all.out);
    assert.ok(j.checks.includes('project.folder'));
    assert.match(j.body, /- project: none \(nextlevel works on a project that is a git repository/);
    const sandboxed = p.hub(['report', '--json'], { extraEnv: { CODEX_SANDBOX_NETWORK_DISABLED: '1' } });
    assert.equal(sandboxed.code, 1);
    assert.match(JSON.parse(sandboxed.out).message, /can't run inside Codex's sandbox/);
  } finally {
    p.cleanup();
  }
});
