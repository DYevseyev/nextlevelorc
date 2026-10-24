// GitHub checks on this PC, the self-hosted runner's part A (docs/design/self-hosted-runner.md): where a workflow's jobs
// run, read from code (every form of runs-on, and what it can't tell said so, never "GitHub's runner"), the repository's
// facts through the stub gh (its visibility, owner, fork settings, collaborators, workflows and runs: GETs only), whether
// the Team page offers and recommends it (never a public, internal or organization's repository), `nextlevel team runner
// status|on`, the dashboard's card, and the guard's card for a task branch that moves a job onto the PC. Part A sets up
// no runner and changes nothing on GitHub. Each project here has the stub gh and a home of its own.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { checksView, minutesText, offer, readRepoFacts } from '../src/lib/ghrepo.mjs';
import { guardDir } from '../src/lib/guard.mjs';
import { describeChanges } from '../src/lib/protect.mjs';
import { jobWhere, paidJobs, whereJobsRun, workflowJobs } from '../src/lib/workflows.mjs';
import { isAlive, makeProject, sleep, waitUntil } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

const CANT = "nextlevel can't tell where (read the diff)";
const flow = (runsOn, { job = 'verify', extra = '' } = {}) => `name: ci\non: push\njobs:\n  ${job}:\n    runs-on: ${runsOn}\n${extra}    steps:\n      - uses: actions/checkout@v4\n      - run: npm test\n`;
const whereOf = (text) => workflowJobs(text).map((j) => jobWhere(j.id, j.runsOn));

test('every form of runs-on the reader meets, and each one it can\'t read says so (never "GitHub\'s runner")', () => {
  const cases = [
    // a string, quoted or not, with a comment
    [flow('ubuntu-latest'), "verify on GitHub's runner ubuntu-latest (paid on a private repository)"],
    [flow("'windows-2025' # the Windows check"), "verify on GitHub's runner windows-2025 (paid on a private repository)"],
    [flow('"macos-15"'), "verify on GitHub's runner macos-15 (paid on a private repository)"],
    // a one-line list, and a list on the following lines
    [flow('[self-hosted, nextlevel-linux]'), 'verify on THIS PC (self-hosted: nextlevel-linux)'],
    ['jobs:\n  verify:\n    runs-on:\n      - self-hosted\n      - "nextlevel-windows"\n    steps: []\n', 'verify on THIS PC (self-hosted: nextlevel-windows)'],
    [flow('[self-hosted, linux, gpu]'), 'verify on a self-hosted runner (labels: self-hosted, linux, gpu): a runner on your machines'],
    // a group/labels map
    ['jobs:\n  verify:\n    runs-on:\n      group: big-runners\n      labels: [ubuntu-latest-16core]\n    steps: []\n', `verify on the runner group big-runners (labels: ubuntu-latest-16core): ${CANT}`],
    ['jobs:\n  verify:\n    runs-on:\n      labels:\n        - self-hosted\n        - nextlevel-linux\n    steps: []\n', 'verify on THIS PC (self-hosted: nextlevel-linux)'],
    // an expression with vars.: nextlevel's own, and another
    [flow("${{ github.actor != 'dependabot[bot]' && vars.NEXTLEVEL_RUNS_ON_LINUX && fromJSON(vars.NEXTLEVEL_RUNS_ON_LINUX) || 'ubuntu-latest' }}"), "verify runs where the repository variable NEXTLEVEL_RUNS_ON_LINUX says: this PC when nextlevel's switch is on, else GitHub's ubuntu-latest"],
    [flow('${{ vars.RUNNER }}'), `verify runs where the repository variable RUNNER says: ${CANT}`],
    // a matrix, an anchor and an alias
    [flow('${{ matrix.os }}', { extra: '    strategy:\n      matrix:\n        os: [ubuntu-latest, self-hosted]\n' }), `verify: ${CANT}`],
    [flow('&where ubuntu-latest'), `verify: ${CANT}`],
    ['jobs:\n  a:\n    runs-on: &r ubuntu-latest\n    steps: []\n  b:\n    runs-on: *r\n    steps: []\n', `a: ${CANT}`],
    // a reusable workflow, from another repository and from this one
    ['jobs:\n  verify:\n    uses: someone/else/.github/workflows/ci.yml@v1\n', "verify uses a workflow from someone/else: nextlevel can't tell where it runs, and changes there aren't guarded"],
    ['jobs:\n  verify:\n    uses: ./.github/workflows/build.yml\n', "verify uses this repository's workflow ./.github/workflows/build.yml: it runs where that file's jobs say"],
    // a job whose runs-on the reader missed, one on one line, and a label of its own without self-hosted
    ['jobs:\n  verify:\n    steps:\n      - run: npm test\n', `verify: ${CANT}`],
    ['jobs:\n  verify: { runs-on: self-hosted }\n', `verify: ${CANT}`],
    [flow('my-box'), `verify: ${CANT}`],
  ];
  for (const [text, want] of cases) assert.equal(whereOf(text)[0], want, text);
  // the alias's job too
  assert.equal(whereOf('jobs:\n  a:\n    runs-on: &r ubuntu-latest\n    steps: []\n  b:\n    runs-on: *r\n    steps: []\n')[1], `b: ${CANT}`);
  // nothing the reader can't read is ever said to be on GitHub's runners
  for (const [text, want] of cases) if (want.endsWith(CANT)) assert.ok(!/GitHub's runner \S+ \(paid/.test(whereOf(text)[0]), text);
});

test("the guard's card says where jobs run (where jobs run:), from code: a job moved onto the PC, a new one there, one moved to the variable; a hosted job that stays gets no line", () => {
  const before = flow('ubuntu-latest');
  const card = (after) => describeChanges([{ path: '.github/workflows/ci.yml', before, after }]).join('\n');
  assert.match(card(flow('[self-hosted, nextlevel-linux]')), /^ {2}where jobs run: verify moves from GitHub's runner ubuntu-latest to THIS PC \(self-hosted: nextlevel-linux\)$/m);
  assert.match(card(`${flow('ubuntu-latest')}  deploy:\n    runs-on: [self-hosted, gpu]\n    steps: []\n`), /^ {2}where jobs run: new job deploy on a self-hosted runner \(labels: self-hosted, gpu\): a runner on your machines$/m);
  assert.match(card(flow("${{ vars.NEXTLEVEL_RUNS_ON_LINUX && fromJSON(vars.NEXTLEVEL_RUNS_ON_LINUX) || 'ubuntu-latest' }}")), /where jobs run: verify moves from GitHub's runner ubuntu-latest to where the repository variable NEXTLEVEL_RUNS_ON_LINUX says: this PC when nextlevel's switch is on, else GitHub's ubuntu-latest/);
  assert.match(card('jobs:\n  verify:\n    uses: someone/else/.github/workflows/ci.yml@v1\n'), /where jobs run: verify moves from GitHub's runner ubuntu-latest to a workflow from someone\/else: nextlevel can't tell where it runs, and changes there aren't guarded/);
  // a step changed in a job that stays on GitHub's runners: no where line (the would-run lines say what changed)
  const steps = card(flow('ubuntu-latest').replace('npm test', 'npm run lint'));
  assert.ok(!/where jobs run/.test(steps), steps);
  assert.match(steps, /would run: npm run lint/);
  // a job already on the PC whose steps change: said every time
  assert.match(describeChanges([{ path: '.github/workflows/ci.yml', before: flow('[self-hosted, nextlevel-linux]'), after: flow('[self-hosted, nextlevel-linux]').replace('npm test', 'echo guard-test') }]).join('\n'), /where jobs run: verify on THIS PC \(self-hosted: nextlevel-linux\)/);
  // the where lines come before the rest, so a long card never cuts them off
  const many = `${flow('[self-hosted, nextlevel-linux]').replace('      - run: npm test\n', Array.from({ length: 40 }, (_, i) => `      - run: echo step-${i}\n`).join(''))}`;
  const lines = describeChanges([{ path: '.github/workflows/ci.yml', before, after: many }]);
  assert.match(lines[1], /where jobs run: verify moves .* THIS PC/);
  // nor many new jobs on GitHub's runners before it, nor a long name: a job on the PC stays on the card
  const crowd = `name: ci\non: push\njobs:\n${Array.from({ length: 30 }, (_, i) => `  j${i}:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo ${i}\n`).join('')}  verify:\n    name: ${'Run the unit tests and lint '.repeat(10)}\n    runs-on: [self-hosted, nextlevel-linux]\n    steps:\n      - run: npm test\n`;
  assert.match(describeChanges([{ path: '.github/workflows/ci.yml', before, after: crowd }])[1], /where jobs run: verify \(Run the unit .*… moves from GitHub's runner ubuntu-latest to THIS PC \(self-hosted: nextlevel-linux\)$/);
  // a quoted jobs: is still read
  assert.match(card(`name: ci\non: push\n"jobs":\n  verify:\n    runs-on: [self-hosted, nextlevel-linux]\n    steps: []\n`), /where jobs run: verify moves from GitHub's runner ubuntu-latest to THIS PC/);
  // a || 'label' under an && or after a literal that always wins says nothing: can't tell, never "else GitHub's"
  for (const e of ["${{ vars.NEXTLEVEL_RUNS_ON_LINUX || 'ubuntu-latest' && 'self-hosted' }}", `\${{ fromJSON('["self-hosted","nextlevel-linux"]') || vars.NEXTLEVEL_RUNS_ON_LINUX || 'ubuntu-latest' }}`]) {
    const where = whereJobsRun(before, flow(e)).join('\n');
    assert.match(where, /nextlevel can't tell where \(read the diff\)$/, e);
    assert.ok(!/else GitHub's/.test(where), e);
  }
  // the reader stays fast on a line a branch could write to make it slow (linear in the line's length)
  const start = Date.now();
  whereJobsRun('', `jobs:\n  a:\n    runs-on: ${'['.repeat(50_000)}\n  ${'b'.repeat(50_000)}: x\n    runs-on: ${"'".repeat(50_000)}\n`);
  assert.ok(Date.now() - start < 2000, 'read in time linear in its length');
});

// A repository as the stub gh answers for it (test/stubs/fake-gh.mjs): ~/.fake-github/repos/<owner>__<name>.json
function fakeRepo(p, slug, repo) {
  const dir = path.join(p.env.HOME, '.fake-github', 'repos');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${slug.replace('/', '__')}.json`), JSON.stringify(repo, null, 2));
}
const ghWrites = (p) => {
  const f = path.join(p.env.HOME, '.fake-github', 'repos', 'writes.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean) : [];
};
const at = (min) => new Date(Date.UTC(2026, 9, 10, 12, min)).toISOString();
const CI = flow('ubuntu-latest', { job: 'ubuntu' });
const WINDOWS = flow('windows-latest', { job: 'windows' });
const RELEASE = `name: release\non: workflow_dispatch\njobs:\n  publish:\n    runs-on: windows-latest\n    environment: release\n    steps:\n      - run: echo \${{ secrets.PUBLISH_TOKEN }}\n`;
const PRIVATE = {
  visibility: 'private',
  workflows: { 'ci.yml': CI, 'windows.yml': WINDOWS, 'release.yml': RELEASE },
  runs: [
    { id: 11, created_at: at(0), jobs: [{ name: 'ubuntu', labels: ['ubuntu-latest'], started_at: at(0), completed_at: new Date(Date.parse(at(4)) + 30_000).toISOString() }] },
    { id: 12, created_at: at(10), jobs: [{ name: 'windows', labels: ['windows-latest'], started_at: at(10), completed_at: at(19) }, { name: 'old', labels: ['self-hosted', 'linux'], started_at: at(10), completed_at: at(12) }] },
  ],
};
// A project whose origin names GitHub (nothing here pushes to it)
function project(slug = 'owner/app') {
  const p = makeProject();
  p.git('remote', 'set-url', 'origin', `https://github.com/${slug}.git`);
  return p;
}
const status = (p, args = []) => {
  const r = p.hub(['team', 'runner', 'status', ...args, '--json']);
  assert.equal(r.code, 0, r.out);
  return JSON.parse(r.out).githubChecks;
};

test("a personal account's private repository on GitHub's paid runners is recommended, with the minutes and its jobs; release jobs with a secret stay on GitHub; reads are GETs only", async () => {
  const p = project();
  try {
    fakeRepo(p, 'owner/app', PRIVATE);
    const v = status(p);
    assert.equal(v.state, 'recommended');
    assert.equal(v.slug, 'owner/app');
    assert.equal(v.where, "GitHub's runners (paid: this repository is private)");
    assert.match(v.text, /cost nothing \(GitHub doesn't charge for runners on your own machines today, which may change\)/);
    assert.match(v.text, /waits while the PC is off or asleep \(GitHub cancels a check that waits 24 hours\)/);
    // each job rounded up to a whole minute, the self-hosted one left out
    assert.equal(v.minutes, "Last 30 days: 14 minutes on GitHub's runners (Linux 5, Windows 9). Windows minutes count twice.");
    assert.deepEqual(v.jobs.map((j) => [j.file, j.job, j.runsOn, j.stays]), [
      ['.github/workflows/ci.yml', 'ubuntu', 'ubuntu-latest', false],
      ['.github/workflows/windows.yml', 'windows', 'windows-latest', false],
      ['.github/workflows/release.yml', 'publish', 'windows-latest', true],
    ]);
    assert.match(v.jobs.find((j) => j.job === 'publish').why, /environment release with PUBLISH_TOKEN/);
    assert.match(v.later, /Nothing is set up yet/);
    // the text command says the same
    const text = p.hub(['team', 'runner', 'status']);
    assert.equal(text.code, 0, text.out);
    assert.match(text.out, /GitHub checks \(owner\/app\): Recommended: run them on this PC/);
    assert.match(text.out, /\.github\/workflows\/release\.yml: publish on windows-latest \(stays on GitHub by default: it runs in the environment release with PUBLISH_TOKEN\)/);
    // nothing was written on GitHub
    assert.deepEqual(ghWrites(p), []);
  } finally {
    p.cleanup();
  }
});

test('not offered: a public repository (and team runner on refuses), an internal one, an organization\'s; offered, not recommended, with no job on the paid runners; gh that can\'t answer offers nothing', async () => {
  const p = project('owner/pub');
  try {
    fakeRepo(p, 'owner/pub', { ...PRIVATE, visibility: 'public', forks: { run: true } });
    const pub = status(p);
    assert.equal(pub.state, 'not-offered');
    assert.match(pub.text, /This repository is public\. GitHub's runners are free for a public repository, and anyone's pull request could run code on this PC: nextlevel doesn't offer it\./);
    assert.deepEqual([pub.jobs, pub.minutes, pub.later], [[], undefined, undefined], 'nothing about running it here');
    const on = p.hub(['team', 'runner', 'on', '--json']);
    assert.equal(on.code, 1, on.out);
    assert.match(JSON.parse(on.out).message, /^Not turned on: This repository is public/);

    for (const [slug, repo, words] of [
      ['owner/inner', { ...PRIVATE, visibility: 'internal' }, /This repository is internal: every member of its enterprise can see it/],
      ['owner/team', { ...PRIVATE, ownerType: 'Organization' }, /belongs to an organization \(owner\): nextlevel offers it only for a personal account's private repository/],
    ]) {
      fakeRepo(p, slug, repo);
      const v = status(p, ['--repo', slug]);
      assert.equal(v.state, 'not-offered', slug);
      assert.match(v.text, words);
      const r = p.hub(['team', 'runner', 'on', '--repo', slug]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /Not turned on/);
    }

    fakeRepo(p, 'owner/quiet', { visibility: 'private', workflows: { 'ci.yml': flow('[self-hosted, nextlevel-linux]') } });
    const quiet = status(p, ['--repo', 'owner/quiet']);
    assert.equal(quiet.state, 'offered');
    assert.match(quiet.text, /No job of this repository's workflows runs on GitHub's paid Linux or Windows runners/);

    fakeRepo(p, 'owner/down', { fail: 'error connecting to api.github.com' });
    const down = status(p, ['--repo', 'owner/down']);
    assert.equal(down.state, 'unknown');
    assert.match(down.text, /nextlevel can't tell whether this repository is private: error connecting to api\.github\.com\. Nothing is offered until it can\./);
    // a repository the stub doesn't know: GitHub's 404
    const gone = status(p, ['--repo', 'owner/none']);
    assert.equal(gone.state, 'unknown');
    assert.match(gone.text, /Not Found \(HTTP 404\)/);
    assert.equal(p.hub(['team', 'runner', 'on', '--repo', 'owner/none']).code, 1);
    // --repo takes owner/name only
    const bad = p.hub(['team', 'runner', 'status', '--repo', '../x']);
    assert.equal(bad.code, 1);
    assert.match(bad.out, /--repo takes owner\/name/);
    assert.deepEqual(ghWrites(p), []);
  } finally {
    p.cleanup();
  }
});

test("team runner on: read at that moment, never from the kept answer; for a private repository it changes nothing yet; an agent's session can't", async () => {
  const p = project();
  try {
    fakeRepo(p, 'owner/app', PRIVATE);
    assert.equal(status(p).state, 'recommended');
    // the repository turns public: the kept answer still says private, `on` asks GitHub again
    fakeRepo(p, 'owner/app', { ...PRIVATE, visibility: 'public' });
    const on = p.hub(['team', 'runner', 'on', '--json']);
    assert.equal(on.code, 1, on.out);
    assert.match(JSON.parse(on.out).message, /This repository is public/);
    fakeRepo(p, 'owner/app', PRIVATE);
    const ok = p.hub(['team', 'runner', 'on', '--json']);
    assert.equal(ok.code, 0, ok.out);
    const j = JSON.parse(ok.out);
    assert.equal(j.setUp, false);
    assert.match(j.message, /its checks can run on this PC\. Setting the runner up comes in a later version of nextlevel \(the design's part B\): nothing was changed\./);
    for (const env of [{ NEXTLEVEL_AGENT: 'orchestrator' }, { NEXTLEVEL_AGENT: 'worker', NEXTLEVEL_TASK_ID: 'T-1' }, { NEXTLEVEL_SESSION: 'autopilot' }]) {
      const r = p.hub(['team', 'runner', 'on'], { extraEnv: env });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /nextlevel team runner on/);
      assert.match(r.out, /The owner turns it on on the dashboard \(Team -> GitHub checks\) or in their own PowerShell window/);
    }
    // a fork's pull request could run code where the checks run: refused while fork workflows are on, or unreadable
    fakeRepo(p, 'owner/app', { ...PRIVATE, forks: { run: true, approval: true } });
    const forks = p.hub(['team', 'runner', 'on', '--json']);
    assert.equal(forks.code, 1, forks.out);
    assert.match(JSON.parse(forks.out).message, /workflows from fork pull requests are on for owner\/app: turn them off first/);
    fakeRepo(p, 'owner/app', { ...PRIVATE, forks: 'deny' });
    const unread = p.hub(['team', 'runner', 'on', '--json']);
    assert.equal(unread.code, 1, unread.out);
    assert.match(JSON.parse(unread.out).message, /can't read the fork pull request settings of owner\/app/);
    fakeRepo(p, 'owner/app', PRIVATE);
    // status only reads, so an agent may look
    assert.equal(p.hub(['team', 'runner', 'status'], { extraEnv: { NEXTLEVEL_AGENT: 'orchestrator' } }).code, 0);
    assert.deepEqual(ghWrites(p), []);
  } finally {
    p.cleanup();
  }
});

test("the Team page's card: the dashboard reads the repository by itself, shows the recommendation, Check again reads afresh; a project without a GitHub origin says so", async () => {
  const p = project();
  let ui;
  try {
    fakeRepo(p, 'owner/app', PRIVATE);
    ui = await startUi(p);
    const c = client(ui);
    let g;
    await waitUntil('the card has its answer', async () => {
      g = (await c.get('/api/state')).json.githubChecks;
      return g && g.state === 'recommended' && !g.refreshing;
    }, 60_000);
    assert.equal(g.slug, 'owner/app');
    assert.match(g.minutes, /14 minutes on GitHub's runners/);
    // the repository turns public: Check again reads it afresh, and the card stops offering it
    fakeRepo(p, 'owner/app', { ...PRIVATE, visibility: 'public' });
    const r = await c.post('/api/team', { githubChecks: 'check' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    g = (await c.get('/api/state')).json.githubChecks;
    assert.equal(g.state, 'not-offered');
    assert.equal((await c.post('/api/team', { githubChecks: 'on' })).status, 400, 'the card has nothing that turns it on');
    await stopUi(ui);
    ui = null;
    // no GitHub origin
    p.git('remote', 'set-url', 'origin', p.remote);
    ui = await startUi(p);
    const none = (await client(ui).get('/api/state')).json.githubChecks;
    assert.equal(none.state, 'no-repo');
    assert.match(none.text, /origin isn't a GitHub repository/);
    assert.deepEqual(ghWrites(p), []);
  } finally {
    if (ui) await stopUi(ui);
    p.cleanup();
  }
});

// The push guard (hub.mjs pushProtected) with the new lines: a task branch that moves a job onto this PC waits on a card
// whose words say so, and nothing reaches origin
async function startHub(p) {
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  await waitUntil('the hub is up', () => fs.existsSync(p.state('hub.json')), 20_000);
  return {
    async stop() {
      bg.kill();
      for (let i = 0; i < 25 && isAlive(bg.pid); i++) await sleep(200);
      fs.rmSync(p.state('hub.json'), { force: true });
    },
  };
}
test('a task branch that moves a job onto the PC is held on a card that names the PC, and nothing reaches origin', async () => {
  const p = makeProject();
  let hub;
  try {
    fs.mkdirSync(path.join(p.repo, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(p.repo, '.github', 'workflows', 'ci.yml'), CI);
    p.git('add', '-A');
    p.git('commit', '-qm', 'ci');
    p.git('push', '-q', 'origin', 'main');
    p.git('checkout', '-q', '-b', 'task/M1-09');
    fs.writeFileSync(path.join(p.repo, '.github', 'workflows', 'ci.yml'), flow('[self-hosted, nextlevel-linux]', { job: 'ubuntu' }));
    p.git('commit', '-qam', 'M1-09: faster CI');
    p.git('checkout', '-q', 'main');
    hub = await startHub(p);
    const q = p.hub(['push', 'ci/m1-09', '--from', 'task/M1-09']);
    assert.equal(q.code, 0, q.out);
    const id = q.out.match(/queued (push-\S+):/)[1];
    await waitUntil(`${id} decided`, () => {
      try {
        return ['done', 'failed', 'blocked'].includes(p.status(id).state);
      } catch {
        return false;
      }
    });
    assert.equal(p.status(id).state, 'blocked');
    const held = JSON.parse(fs.readFileSync(path.join(guardDir(p.repo, p.env.HOME), 'held.json'), 'utf8')).items.filter((x) => x.kind === 'push');
    assert.equal(held.length, 1);
    assert.match(held[0].summary.join('\n'), /where jobs run: ubuntu moves from GitHub's runner ubuntu-latest to THIS PC \(self-hosted: nextlevel-linux\)/);
    const branches = p.git('--git-dir', p.remote, 'for-each-ref', '--format=%(refname:strip=2)', 'refs/heads');
    assert.ok(!branches.split('\n').includes('ci/m1-09'), 'nothing reached origin');
  } finally {
    if (hub) await hub.stop();
    p.cleanup();
  }
});

test('offer() and the view, pure: never for a public, internal or organization\'s repository, whatever its workflows; the minutes in words', async () => {
  const workflows = [{ file: '.github/workflows/ci.yml', jobs: workflowJobs(CI) }];
  const base = { ok: true, slug: 'o/r', visibility: 'private', ownerType: 'User', owner: 'o', workflows };
  assert.equal(offer(base).state, 'recommended');
  for (const f of [{ ...base, visibility: 'public' }, { ...base, visibility: 'internal' }, { ...base, ownerType: 'Organization' }, { ...base, ownerType: '' }]) {
    assert.equal(offer(f).state, 'not-offered', JSON.stringify(f));
    assert.deepEqual(checksView('o/r', f).jobs, []);
  }
  assert.equal(offer({ ok: false, error: 'x' }).state, 'unknown');
  assert.equal(offer(null).state, 'unknown');
  // macOS jobs never move (the PC isn't a Mac): nothing to save
  assert.equal(offer({ ...base, workflows: [{ file: 'm.yml', jobs: workflowJobs(flow('macos-15')) }] }).state, 'offered');
  assert.equal(paidJobs(workflows).length, 1);
  assert.equal(minutesText({ linux: 0, windows: 0, macos: 0, runs: 3, more: false, days: 30 }), "Last 30 days: no minutes on GitHub's runners.");
  assert.equal(minutesText({ linux: 3, windows: 0, macos: 0, runs: 30, more: true, days: 30 }), "Last 30 days (the latest 30 runs): 3 minutes on GitHub's runners (Linux 3).");
  // the reads: only GETs, whatever the answers
  const asked = [];
  await readRepoFacts('o/r', (args) => (asked.push(args), { ok: false, out: 'gh: Not Found (HTTP 404)' }));
  assert.ok(asked.every((a) => !a.includes('-X') && !a.includes('-F') && !a.includes('-f') && !a.includes('--method')), JSON.stringify(asked));
  assert.equal((await readRepoFacts('../etc', () => assert.fail('asked GitHub'))).ok, false);
});
