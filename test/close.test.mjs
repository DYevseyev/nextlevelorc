// FR-021: closing a task. On 4 October a real project's Project page counted five tasks the orchestrator had closed (in their
// specs only, at the owner's word) as planned work: "147 of 162 merged". `nextlevel close` asks the hub, which checks the
// task again and keeps the closure in .nextlevel/closed.json; the page, status, the daily report and the doctor read it.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { hubRounds, isAlive, makeProject, sleep, waitUntil } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

async function startHub(p) {
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  await waitUntil('the hub to start', () => fs.existsSync(p.state('hub.json')));
  return {
    async stop() {
      bg.kill();
      for (let i = 0; i < 25 && isAlive(bg.pid); i++) await sleep(200);
      fs.rmSync(p.state('hub.json'), { force: true });
    },
  };
}
const write = (p, rel, text) => {
  fs.mkdirSync(path.dirname(path.join(p.repo, rel)), { recursive: true });
  fs.writeFileSync(path.join(p.repo, rel), text);
};
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const closed = (p) => (fs.existsSync(p.state('closed.json')) ? readJson(p.state('closed.json')).tasks : {});
const realN = (p) => readJson(p.state('rounds.json')).real.n;
const branches = (p) => p.git('branch', '--list', 'task/*', '--format=%(refname:short)').split('\n').filter(Boolean);

test('nextlevel close (FR-021): a task never dispatched, one thrown away, refusals, the page and the doctor, one real event each, a dispatch reopens', async () => {
  const p = makeProject();
  let hub = null;
  let ui = null;
  try {
    write(p, 'docs/STATUS.md', '# Status\n\n| Milestone | State | Verified by |\n|---|---|---|\n| M1 Sign-up | in progress | |\n| M2 Billing | not started | |\n');
    write(p, 'docs/plans/M1.md', '# M1 Sign-up\n\nMilestone: M1 Sign-up\nOutcome: you can sign up.\nAcceptance: the tests pass.\nTry it:\n1. Open the page.\n');
    for (const id of ['M1-01-planned', 'M1-02-draftfail', 'M1-03-blocked', 'M1-04-landok', 'M1-06-activity', 'M2-01-planned']) p.spec(id, 'node -e "0"');
    p.git('add', '-A');
    p.git('commit', '-qm', 'plan');

    // Without a hub nothing is queued, and nothing is written
    const nohub = p.hub(['close', 'M1-01-planned', '--reason', 'replaced']);
    assert.equal(nohub.code, 2, nohub.out);
    assert.match(nohub.out, /The hub is not running, so nothing was queued/);
    assert.ok(!fs.existsSync(p.state('closed.json')));

    hub = await startHub(p);
    // A cleanup with nothing to delete writes nothing false, and points to close
    const clean = p.hub(['cleanup', 'M1-01-planned']);
    assert.equal(clean.code, 1, clean.out);
    assert.match(clean.out, /There is no branch task\/M1-01-planned and no job for M1-01-planned: nothing was deleted or written\. To close a task you won't build: nextlevel close M1-01-planned --reason/);
    assert.ok(!fs.existsSync(p.state('jobs', 'M1-01-planned')), 'no job record made up');
    assert.ok(!fs.existsSync(p.state('closed.json')));

    // Refused, saying why: an unknown id, no reason, a reason too long, and in an agent's session that isn't the orchestrator's
    const refused = (args, re, extraEnv = {}) => {
      const r = p.hub(['close', ...args], { extraEnv });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, re);
    };
    refused(['M9-99-nothing', '--reason', 'x'], /there is no task M9-99-nothing: no spec docs\/tasks\/M9-99-nothing\.md, no job and no branch task\/M9-99-nothing: nothing was closed/);
    refused(['M1-01-planned'], /say why: --reason "replaced by M2-05 and M2-06"/);
    refused(['M1-01-planned', '--reason', 'x'.repeat(301)], /301 characters, more than 300/);
    refused(['M1-01-planned', '--reason', 'x', '--file', 'y'], /give the reason once/);
    for (const [env, who] of [
      [{ NEXTLEVEL_AGENT: 'worker', NEXTLEVEL_TASK_ID: 'M1-02-draftfail' }, "a worker's slot"],
      [{ NEXTLEVEL_AGENT: 'check' }, 'a verify command'],
      [{ NEXTLEVEL_AGENT: 'git-job' }, 'a project hook'],
      [{ NEXTLEVEL_READ_ONLY: '1', NEXTLEVEL_AGENT: 'orchestrator' }, 'read-only'],
    ]) refused(['M1-01-planned', '--reason', 'replaced'], new RegExp(`(refuses anywhere else|refused)[\\s\\S]*${who}`), env);
    assert.ok(!fs.existsSync(p.state('jobs')) || !fs.readdirSync(p.state('jobs')).some((d) => d.startsWith('close-')), 'none of those queued a close');

    // Three tasks run: one merged with its own message, one left unmerged, one blocked with nothing on its branch
    for (const id of ['M1-02-draftfail', 'M1-03-blocked', 'M1-04-landok']) assert.equal(p.hub(['dispatch', id]).code, 0);
    for (const id of ['M1-02-draftfail', 'M1-03-blocked', 'M1-04-landok']) assert.equal(p.hub(['wait', id, '--minutes', '3']).code, 0, id);
    const merge = p.hub(['merge', 'M1-04-landok', '-m', 'The landing page']);
    assert.equal(merge.code, 0, merge.out);
    assert.equal(p.git('log', '-1', '--format=%s'), 'Merge task/M1-04-landok: The landing page', 'the subject names the task, with -m too');
    ui = await startUi(p);
    const api = client(ui);
    const view = async () => (await api.get('/api/project')).json;
    const m = (v, key) => v.roadmap.find((x) => x.key === key);
    const first = await view();
    assert.equal(m(first, 'M1').tasks.find((t) => t.id === 'M1-04-landok').state, 'merged', 'a merge with its own -m text counts as merged');
    assert.deepEqual(first.planProblems.map((x) => x.key), ['M2'], 'M2 has a task and no plan');
    const doctorPlans = () => JSON.parse(p.hub(['doctor', '--json']).out).results.find((x) => x.id === 'project.plans');
    assert.equal(doctorPlans().status, 'fail', 'the doctor agrees with the page: M2 has a task but no plan');

    refused(['M1-04-landok', '--reason', 'x'], /M1-04-landok is merged into main: a merged task is done, not closed/);
    assert.equal(p.hub(['cleanup', 'M1-04-landok']).code, 0);
    refused(['M1-04-landok', '--reason', 'x'], /is merged into main/, {}); // (its branch gone: the merge log still says so)
    refused(['M1-02-draftfail', '--reason', 'x'], /task\/M1-02-draftfail has work that isn't merged into main: merge it \(nextlevel merge M1-02-draftfail\), or close it and throw that work away \(nextlevel close M1-02-draftfail --discard/);
    assert.ok(branches(p).includes('task/M1-02-draftfail'), 'refused: the branch stays');

    // A task never dispatched: closed with its reason, one real event, nothing else changes
    const n0 = realN(p);
    const c1 = p.hub(['close', 'M1-01-planned', '--reason', 'replaced by M1-05-signup-form']);
    assert.equal(c1.code, 0, c1.out);
    assert.match(c1.out, /close-M1-01-planned-\S+: done · closed M1-01-planned: replaced by M1-05-signup-form/);
    assert.equal(realN(p), n0 + 1, 'one real event');
    const rec = closed(p)['M1-01-planned'];
    assert.deepEqual([rec.reason, rec.by, rec.discarded, rec.branch, rec.jobState], ['replaced by M1-05-signup-form', 'owner', false, '', '']);
    assert.ok(Number.isFinite(Date.parse(rec.at)));
    assert.ok(!fs.existsSync(p.state('jobs', 'M1-01-planned')), 'no job record for a task never dispatched');
    refused(['M1-01-planned', '--reason', 'again'], /M1-01-planned is closed already \(closed \d{4}-\d\d-\d\d: replaced by M1-05-signup-form\): nothing changed/);

    // With --discard: its branch is gone, the closure says its work was thrown away, its job is reviewed
    const tip = p.git('rev-parse', 'task/M1-02-draftfail');
    const c2 = p.hub(['close', 'M1-02-draftfail', '--discard', '--reason', 'out of scope: BRIEF.md R7 is for M5']);
    assert.equal(c2.code, 0, c2.out);
    assert.match(c2.out, /task\/M1-02-draftfail was deleted, its work thrown away/);
    assert.ok(!branches(p).includes('task/M1-02-draftfail'));
    assert.deepEqual([closed(p)['M1-02-draftfail'].discarded, closed(p)['M1-02-draftfail'].branch, closed(p)['M1-02-draftfail'].jobState], [true, tip, 'done']);
    assert.deepEqual([p.status('M1-02-draftfail').acked, p.status('M1-02-draftfail').state], [true, 'done'], 'reviewed; its state stays');
    assert.equal(realN(p), n0 + 2);
    // A branch with no work of its own throws nothing away; the milestone whose only task is closed has no warning
    assert.equal(p.hub(['close', 'M1-03-blocked', '--reason', "the owner's call"]).code, 0);
    assert.equal(closed(p)['M1-03-blocked'].discarded, false);
    assert.equal(p.hub(['close', 'M2-01-planned', '--reason', 'billing moved to M5']).code, 0);
    assert.equal(realN(p), n0 + 4, 'one real event per close');

    // The page: closed with the reason, out of the count; its cached view changed; the doctor agrees
    const after = await view();
    assert.notEqual(after.stamp, first.stamp, 'the cached view is made again');
    const m1 = m(after, 'M1');
    assert.deepEqual(m1.tasks.map((t) => [t.id, t.state]), [['M1-01-planned', 'closed'], ['M1-02-draftfail', 'closed'], ['M1-03-blocked', 'closed'], ['M1-04-landok', 'merged'], ['M1-06-activity', 'planned']]);
    assert.match(m1.tasks[0].summary, /^closed \d{4}-\d\d-\d\d: replaced by M1-05-signup-form$/);
    assert.deepEqual(m1.counts, { total: 2, closed: 3, merged: 1, running: 0, queued: 0 });
    assert.deepEqual(m(after, 'M2').counts, { total: 0, closed: 1, merged: 0, running: 0, queued: 0 });
    assert.deepEqual(after.planProblems, []);
    assert.equal(doctorPlans().status, 'ok', "the doctor's project.plans agrees with the page");
    // The Build page's lists: the closed task's job says closed with its reason; the never-dispatched ones are listed
    const build = (await api.get('/api/state')).json;
    assert.match(build.recent.find((j) => j.id === 'M1-02-draftfail').closed.text, /closed \d{4}-\d\d-\d\d: out of scope/);
    assert.deepEqual(build.closed.map((c) => c.id).sort(), ['M1-01-planned', 'M1-02-draftfail', 'M1-03-blocked', 'M2-01-planned']);

    // status: the tasks closed in the last day; --json adds closed and keeps state
    const st = p.hub(['status']);
    assert.match(st.out, /closed +M1-01-planned +\S+ \S+ by owner: replaced by M1-05-signup-form/);
    assert.match(st.out, /closed +M1-02-draftfail .*: out of scope: BRIEF\.md R7 is for M5 \(its work thrown away\)/);
    const json = JSON.parse(p.hub(['status', '--json']).out);
    assert.equal(json.closed.length, 4);
    const job = json.jobs.find((j) => j.id === 'M1-02-draftfail');
    assert.deepEqual([job.state, job.closed.reason], ['done', 'out of scope: BRIEF.md R7 is for M5']);
    // The daily report counts them
    assert.match(p.hub(['daily-report', '--no-send']).out, /Tasks closed, last 24 h: 4 \(/);

    // Later looks and a hub restart add no real event
    await hubRounds(p, 3);
    assert.equal(realN(p), n0 + 4);
    await hub.stop();
    hub = await startHub(p);
    await hubRounds(p, 3);
    assert.equal(realN(p), n0 + 4, 'a restart reads the closures, and adds nothing');

    // A running task is refused; dispatching or retrying a closed one reopens it, and the hub says so
    assert.equal(p.hub(['dispatch', 'M1-06-activity']).code, 0);
    await waitUntil('M1-06-activity to run', () => p.status('M1-06-activity').state === 'running');
    refused(['M1-06-activity', '--reason', 'x'], /M1-06-activity is running: a task that is queued or running isn't closed/);
    fs.writeFileSync(path.join(`${p.repo}.slots`, `w${p.status('M1-06-activity').slot}`, '.nextlevel-task', 'GO'), 'go\n');
    assert.equal(p.hub(['wait', 'M1-06-activity', '--minutes', '3']).code, 0);
    const again = p.hub(['retry', 'M1-03-blocked', '--feedback', 'the owner wants it after all']);
    assert.match(again.out, /M1-03-blocked was closed \d{4}-\d\d-\d\d: the owner's call\. It is open again once the hub starts this retry/);
    await waitUntil('the retry to start', () => !closed(p)['M1-03-blocked']);
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /M1-03-blocked: dispatched or retried, so it is open again \(it was closed \d{4}-\d\d-\d\d: the owner's call\)/);
    assert.equal(p.hub(['wait', 'M1-03-blocked', '--minutes', '3']).code, 0);
    assert.notEqual(m(await view(), 'M1').tasks.find((t) => t.id === 'M1-03-blocked').state, 'closed');

    // Bridge-test tasks never get a closure: close refuses, and a cleanup that throws one's branch away records none
    p.git('checkout', '-qb', 'task/T000-bridge-x');
    write(p, 'bridge.txt', 'x\n');
    p.git('add', '-A');
    p.git('commit', '-qm', 'bridge');
    p.git('checkout', '-q', 'main');
    refused(['T000-bridge-x', '--reason', 'x'], /T000-bridge-x is a bridge-test task .*: it is never closed/);
    assert.equal(p.hub(['cleanup', 'T000-bridge-x', '--discard']).code, 0);
    assert.ok(!branches(p).includes('task/T000-bridge-x'));
    assert.equal(closed(p)['T000-bridge-x'], undefined);
  } finally {
    await stopUi(ui);
    await hub?.stop();
    p.cleanup();
  }
});

test('cleanup --discard of an unmerged branch closes the task (FR-021); a merged one, or no branch, closes nothing and says nothing false', async () => {
  const p = makeProject();
  const hub = await startHub(p);
  try {
    for (const id of ['M1-01-ok', 'M1-02-fail']) p.spec(id, 'node -e "0"');
    p.git('add', '-A');
    p.git('commit', '-qm', 'tasks');
    for (const id of ['M1-01-ok', 'M1-02-fail']) p.hub(['dispatch', id]);
    for (const id of ['M1-01-ok', 'M1-02-fail']) assert.equal(p.hub(['wait', id, '--minutes', '3']).code, 0);
    assert.equal(p.hub(['merge', 'M1-01-ok']).code, 0);
    assert.match(p.hub(['cleanup', 'M1-01-ok']).out, /done · deleted task\/M1-01-ok$/m);
    // Merged, with its spec, job and branch gone since: still merged (the merge log), never "there is no task"
    fs.rmSync(path.join(p.repo, 'docs', 'tasks', 'M1-01-ok.md'));
    fs.rmSync(p.state('jobs', 'M1-01-ok'), { recursive: true, force: true });
    const gone = p.hub(['close', 'M1-01-ok', '--reason', 'x']);
    assert.equal(gone.code, 1, gone.out);
    assert.match(gone.out, /M1-01-ok is merged into main: a merged task is done, not closed/);
    const n0 = realN(p);
    const discard = p.hub(['cleanup', 'M1-02-fail', '--discard']);
    assert.match(discard.out, /done · deleted task\/M1-02-fail \(its work thrown away; the task is closed\)/);
    assert.equal(realN(p), n0 + 1, 'one real event');
    assert.deepEqual(Object.keys(closed(p)), ['M1-02-fail'], 'the merged one is not closed');
    assert.deepEqual([closed(p)['M1-02-fail'].reason, closed(p)['M1-02-fail'].discarded], ['its work thrown away (nextlevel cleanup --discard)', true]);
    // Again, with no branch left: nothing deleted, and it says so
    const none = p.hub(['cleanup', 'M1-02-fail']);
    assert.equal(none.code, 0, none.out);
    assert.match(none.out, /There is no branch task\/M1-02-fail: nothing was deleted\. M1-02-fail's job is marked cleaned up and reviewed$/m);
    assert.doesNotMatch(none.out, /deleted task\//);
  } finally {
    await hub.stop();
    p.cleanup();
  }
});
