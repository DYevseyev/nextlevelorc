// FR-020: a worker's missing report. On a real project, WS-62's attempt 10 (Claude Code) ended its turn to wait for a check it had
// started in the background, so `claude -p` ended, stopped the check and wrote no report; the hub said "done · verify
// pass · worker says MISSING · 18 commit(s)", 16 of them earlier attempts', and nothing said why. These tests play each
// way a report goes missing with the stubs (STUB_WORKER_NO_REPORT, STUB_WORKER_IDLE, STUB_CLAUDE_END) and read what the
// summary, `nextlevel result`, the hub log, status.json's attempts and the alert say.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { agyEnd } from '../src/engines/agy.mjs';
import claude, { claudeEnd } from '../src/engines/claude.mjs';
import { codexEnd } from '../src/engines/codex.mjs';
import { attemptCategory, attemptTally, taskAlerts } from '../src/lib/overview.mjs';
import { fileExists, makeProject } from './helpers.mjs';

const fixture = (name) => fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const hubLog = (p) => fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
const finishedLine = (p, id) => hubLog(p).split(/\r?\n/).filter((l) => l.includes(`finished ${id}:`)).at(-1) || '';

test("each engine's own end (FR-020): Claude Code's result as measured, Codex's last turn, agy's status", () => {
  // --max-turns 1 on 2.1.284: exit 1, error_max_turns, is_error, the reason in `errors`
  const turns = claudeEnd(fixture('claude-2.1.284-max-turns.jsonl'), { code: 1 });
  assert.deepEqual([turns.status, turns.error, turns.reason, turns.turns], ['error_max_turns', true, 'Reached maximum number of turns (1)', 2]);
  // WS-62's attempt 10: a success whose session stopped its two background commands as it ended
  const bg = claudeEnd(fixture('claude-2.1.284-background-end.jsonl'), { code: 0 });
  assert.deepEqual([bg.status, bg.error, bg.reason, bg.stopped], ['success', false, '', 2]);
  assert.match(bg.said, /^Waiting for the long check\. I'll go on to the next check and M0 once it finishes\.$/);
  assert.equal(claudeEnd('no JSON here').status, '', 'an end it never printed says nothing');
  // A worker's Bash commands: half the attempt, at least 10 minutes (a review: a cut-off command leaves time for the report)
  assert.equal(claude.workerEnv({ timeoutMin: 60 }).BASH_MAX_TIMEOUT_MS, String(30 * 60_000));
  assert.equal(claude.workerEnv({ timeoutMin: 12 }).BASH_DEFAULT_TIMEOUT_MS, String(10 * 60_000));
  const failed = codexEnd(['{"type":"turn.started"}', '{"type":"turn.failed","error":{"message":"stream disconnected before completion"}}'].join('\n'));
  assert.deepEqual([failed.status, failed.error, failed.reason, failed.turns], ['failed', true, 'stream disconnected before completion', 1]);
  const ok = codexEnd(['{"type":"item.completed","item":{"id":"i","type":"agent_message","text":"All done.\\nMore."}}', '{"type":"turn.completed","usage":{}}'].join('\n'));
  assert.deepEqual([ok.status, ok.error, ok.said], ['completed', false, 'All done.']);
  assert.equal(codexEnd('{"type":"turn.completed"}\n{"type":"error","message":"Quota exceeded"}').reason, 'Quota exceeded', 'an error after its last turn is how it ended');
  const agy = agyEnd(fixture('agy-1.3.5-stream-json.txt'), { code: 0 });
  assert.deepEqual([agy.status, agy.error], ['SUCCESS', false]);
  // (an "error: ..." line and an exit code, with no result: agy stopping, not an error end of its own)
  const stopped = agyEnd('Error: --effort is not supported', { code: 1 });
  assert.deepEqual([stopped.error, stopped.reason], [false, '--effort is not supported']);
});

test('the attempts tally (FR-020): one category each, runs stopped from outside left out, earlier attempts not recorded', () => {
  const attempts = [
    { attempt: 2, state: 'failed', verify: 'fail', claimed: 'PARTIAL', exitCode: 0 },
    { attempt: 3, state: 'failed', verify: 'skipped', claimed: 'MISSING', exitCode: 1 },
    { attempt: 4, state: 'failed', claimed: 'DONE', exitCode: 0, end: { error: true } },
    { attempt: 5, state: 'stopped', notCounted: 'stopped from outside' },
    { attempt: 5, state: 'timeout', claimed: 'MISSING' },
    { attempt: 6, state: 'no-changes', claimed: 'MISSING', exitCode: 0 },
    { attempt: 7, state: 'done', verify: 'pass', claimed: 'MISSING', mark: 'verify passed', exitCode: 0 },
    { attempt: 8, state: 'blocked', claimed: 'BLOCKED' },
    { attempt: 9, state: 'done', verify: 'pass', claimed: 'DONE', exitCode: 0 },
  ];
  assert.deepEqual(attempts.map(attemptCategory), ['failed verify', 'engine stopped', 'engine error', null, 'timed out', 'no report and no changes', 'no report but verified', 'blocked', 'done']);
  const job = { id: 'T', type: 'task', attempt: 10, state: 'running', attempts };
  assert.equal(attemptTally(job).text, '1 failed verify, 1 engine stopped, 1 engine error, 1 timed out, 1 no report and no changes, 1 no report but verified, 1 blocked, 1 done; plus 1 run(s) stopped from outside or not started (not counted); 1 earlier attempt(s) not recorded');
  const alert = taskAlerts([job]).find((a) => a.kind === 'attempts');
  assert.match(alert.text, /^T is on attempt 10, past 3 \(1 failed verify, .*; 1 earlier attempt\(s\) not recorded\): it may need a smaller task, another engine or your call$/);
  // A task from before FR-020: nothing recorded
  assert.equal(attemptTally({ attempt: 5, state: 'queued' }).text, '4 earlier attempt(s) not recorded');
});

test("finished without a report (FR-020): WS-62's attempt 10 replayed on Claude Code is done and marked; a retry that does nothing is no-changes", () => {
  const p = makeProject();
  const id = 'FR20-01-ok';
  try {
    p.spec(id, fileExists('ok.mjs'));
    p.hub(['dispatch', id, '--engine', 'claude']);
    let r = p.runUntilIdle([], { extraEnv: { STUB_WORKER_NO_REPORT: '1', STUB_CLAUDE_END: 'background' } });
    let s = p.status(id);
    assert.deepEqual([s.state, s.mark, s.claimed, s.verify, s.ownCommits, s.commits], ['done', 'verify passed', 'MISSING', 'pass', 1, 1], r.out);
    const why = 'Claude Code ended without writing it (success after 85 turn(s); its last words: "Waiting for the long check. I\'ll go on to the next check and M0 once it finishes."; 2 background command(s) still running were stopped when it ended)';
    assert.equal(s.missing, why);
    const summary = `done · finished without a report, verify passed · verify pass · no report: ${why} · 1 commit(s) this attempt, 1 in all`;
    assert.ok(finishedLine(p, id).endsWith(`finished ${id}: ${summary}`), finishedLine(p, id));
    assert.match(p.hub(['status']).out, new RegExp(`${id} .*finished without a report, verify passed`));
    const result = p.hub(['result', id, '--peek']).out;
    assert.ok(result.includes(summary), result);
    assert.match(result, /## This attempt's commits \(1; git log --oneline [0-9a-f]{8}\.\.task\/FR20-01-ok\)\n[0-9a-f]+ feat: ok\n ?ok\.mjs \| 1 \+/);
    assert.match(result, /## Worker report\n\(none written: Claude Code ended without writing it .*\)\nFinished without a report, verify passed: review this attempt's own commits and diff stat/);
    assert.match(result, /## How Claude Code ended\nsuccess after 85 turn\(s\); its last words: .*; 2 background command\(s\) still running were stopped when it ended \(exit 0\)/);
    assert.ok(result.indexOf("## This attempt's commits") < result.indexOf('## Diff ('), "this attempt's commits come before the branch's");
    assert.deepEqual(s.attempts.map((a) => [a.attempt, a.engine, a.state, a.mark, a.ownCommits]), [[1, 'claude', 'done', 'verify passed', 1]]);

    // Attempt 2 does nothing at all: an earlier attempt's passing work isn't its own
    assert.equal(p.hub(['retry', id, '--engine', 'claude', '--feedback', 'Once more']).code, 0);
    r = p.runUntilIdle([], { extraEnv: { STUB_WORKER_IDLE: '1' } });
    s = p.status(id);
    assert.deepEqual([s.state, s.mark, s.ownCommits, s.commits], ['no-changes', null, 0, 1], r.out);
    assert.match(s.missing, /^Claude Code ended without writing it \(success after 4 turn\(s\); its last words: "\[fake claude\] worker done"\)$/);
    assert.match(finishedLine(p, id), /no-changes · verify pass · no report: Claude Code ended without writing it .* · 0 commit\(s\) this attempt, 1 in all$/);
    assert.deepEqual(s.attempts.map((a) => a.state), ['done', 'no-changes']);
    assert.match(p.hub(['result', id, '--peek']).out, /^attempts so far: 1 no report and no changes, 1 no report but verified$/m);
  } finally {
    p.cleanup();
  }
});

test("Claude Code's error ends fail the attempt (FR-020): an error subtype with exit 0, even with a report; its turns used up, with no report", () => {
  const p = makeProject();
  try {
    p.spec('FR20-02-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'FR20-02-ok', '--engine', 'claude']);
    let r = p.runUntilIdle([], { extraEnv: { STUB_CLAUDE_END: 'error' } });
    let s = p.status('FR20-02-ok');
    assert.deepEqual([s.state, s.claimed, s.exitCode, s.engineEnd.status, s.engineEnd.error], ['failed', 'DONE', 0, 'error_during_execution', true], r.out);
    assert.match(s.detail, /^Claude Code ended with an error: API Error: 500 .*Internal server error.* \(exit 0\)$/);
    assert.match(hubLog(p), /FR20-02-ok: Claude Code said: API Error: 500 .* \(exit 0\)/);
    assert.match(p.hub(['result', 'FR20-02-ok', '--peek']).out, /## How Claude Code ended\nerror_during_execution after 3 turn\(s\); API Error: 500/);

    p.spec('FR20-03-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'FR20-03-ok', '--engine', 'claude']);
    r = p.runUntilIdle([], { extraEnv: { STUB_CLAUDE_END: 'max-turns', STUB_WORKER_NO_REPORT: '1' } });
    s = p.status('FR20-03-ok');
    assert.deepEqual([s.state, s.exitCode, s.mark], ['failed', 1, null], r.out);
    assert.equal(s.missing, 'Claude Code ended with an error: Reached maximum number of turns (1) (2 turn(s))');
    assert.match(finishedLine(p, 'FR20-03-ok'), /failed · verify pass · no report: Claude Code ended with an error: Reached maximum number of turns \(1\) \(2 turn\(s\)\) · 1 commit\(s\) this attempt, 1 in all$/);
    assert.match(p.hub(['result', 'FR20-03-ok', '--peek']).out, /\(none written: Claude Code ended with an error: Reached maximum number of turns \(1\)/);
    assert.equal(attemptCategory(s.attempts[0]), 'engine error');
  } finally {
    p.cleanup();
  }
});

test('a design attempt that changed its result file and wrote no report is finished without a report; one with no Status line still has a report (FR-020)', () => {
  const p = makeProject();
  try {
    p.spec('FR20-04-resultfile', 'node -e "process.exit(0)"', { kind: 'design', resultFile: 'docs/design/fr20.md' });
    p.hub(['dispatch', 'FR20-04-resultfile', '--engine', 'claude']);
    const r = p.runUntilIdle([], { extraEnv: { STUB_WORKER_NO_REPORT: '1' } });
    const s = p.status('FR20-04-resultfile');
    assert.deepEqual([s.state, s.mark, s.verify, s.ownCommits], ['done', 'verify passed', 'pass', 1], r.out);

    p.spec('FR20-05-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'FR20-05-ok', '--engine', 'claude']);
    p.runUntilIdle([], { extraEnv: { STUB_WORKER_NO_REPORT: 'nostatus' } });
    const n = p.status('FR20-05-ok');
    assert.deepEqual([n.state, n.mark, n.claimed, n.missing], ['done', null, 'MISSING', 'its report has no Status line']);
    assert.match(finishedLine(p, 'FR20-05-ok'), /done · verify pass · its report has no Status line · 1 commit\(s\) this attempt, 1 in all$/);
    // ...and one with no work of its own is no-changes, never done on an earlier attempt's work (a review)
    assert.equal(p.hub(['retry', 'FR20-05-ok', '--engine', 'claude', '--feedback', 'Once more']).code, 0);
    p.runUntilIdle([], { extraEnv: { STUB_WORKER_IDLE: 'nostatus' } });
    const again = p.status('FR20-05-ok');
    assert.deepEqual([again.state, again.missing, again.ownCommits, again.commits], ['no-changes', 'its report has no Status line', 0, 1]);
  } finally {
    p.cleanup();
  }
});

test("every worker's prompt names its report and its Status line, and says the session ends with its turn; Claude Code workers run with no background commands (FR-020)", () => {
  const p = makeProject();
  const calls = path.join(p.tmp, 'calls.jsonl');
  try {
    for (const engine of ['agy', 'codex', 'claude']) {
      p.spec(`FR20-06-ok-${engine}`, fileExists('ok.mjs'));
      p.hub(['dispatch', `FR20-06-ok-${engine}`, '--engine', engine, '--timeout', '45']);
    }
    p.runUntilIdle([], { extraEnv: { STUB_CALLS: calls } });
    const prompts = fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).map((a) => [a[0], a.find((x) => typeof x === 'string' && x.includes('ROLE: WORKER'))]).filter(([, x]) => x);
    assert.deepEqual([...new Set(prompts.map(([e]) => e))].sort(), ['agy', 'claude', 'codex']);
    for (const [engine, prompt] of prompts) {
      assert.ok(prompt.includes('When you finish, write your report in .nextlevel-task/RESULT.md, even when you fail: its first line is exactly "Status: DONE", "Status: PARTIAL" or "Status: BLOCKED".'), `${engine}: ${prompt}`);
      assert.ok(prompt.includes('Run every command in the foreground and wait for it to end. Write the report before you end your turn: your session ends with it, and anything still running is stopped. A command stopped at its time limit is no reason to skip the report: say what you know.'), engine);
    }
    // A command in the foreground may run half the attempt (22.5 of 45 minutes), so a command cut off leaves time for the
    // report; at least 10 minutes
    const seen = JSON.parse(fs.readFileSync(path.join(p.env.HOME, '.fake-claude', 'worker-env.json'), 'utf8'));
    assert.deepEqual(seen.env, { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1', BASH_DEFAULT_TIMEOUT_MS: String(22.5 * 60_000), BASH_MAX_TIMEOUT_MS: String(22.5 * 60_000) });
    for (const engine of ['agy', 'codex', 'claude']) assert.equal(p.status(`FR20-06-ok-${engine}`).state, 'done');
  } finally {
    p.cleanup();
  }
});

test("an attempt's own commits on top of earlier ones, and a start no longer on the branch (FR-020)", () => {
  const p = makeProject();
  const id = 'FR20-07-ok';
  try {
    p.spec(id, fileExists('ok.mjs'));
    p.hub(['dispatch', id, '--engine', 'claude']);
    p.runUntilIdle();
    assert.equal(p.status(id).commits, 1);
    // Attempt 2: two commits of its own on top of attempt 1's, and no report
    p.hub(['retry', id, '--engine', 'claude', '--feedback', 'Two more']);
    let r = p.runUntilIdle([], { extraEnv: { STUB_WORKER_IDLE: '1', STUB_WORKER_EXTRA_COMMIT: '2' } });
    let s = p.status(id);
    assert.deepEqual([s.state, s.mark, s.ownCommits, s.commits], ['done', 'verify passed', 2, 3], r.out);
    assert.match(finishedLine(p, id), / · 2 commit\(s\) this attempt, 3 in all$/);
    assert.match(p.hub(['result', id, '--peek']).out, /## This attempt's commits \(2; [^\n]*\)\n[0-9a-f]+ feat: extra 2\n[0-9a-f]+ feat: extra 1\n/);
    // Attempt 3 rewrites the commit it started on: its own commits can't be told apart, and it says so
    p.hub(['retry', id, '--engine', 'claude', '--feedback', 'Rewrite']);
    r = p.runUntilIdle([], { extraEnv: { STUB_WORKER_IDLE: '1', STUB_WORKER_AMEND: '1' } });
    s = p.status(id);
    assert.match(s.ownLost || '', /^[0-9a-f]{8}$/, r.out);
    assert.equal(s.ownCommits, null);
    assert.ok(finishedLine(p, id).endsWith(` · 3 commit(s) in all (where this attempt started, ${s.ownLost}, is no longer on the branch)`), finishedLine(p, id));
    assert.ok(p.hub(['result', id, '--peek']).out.includes(`## This attempt's commits
Where this attempt started (${s.ownLost}) is no longer on task/${id}`));
  } finally {
    p.cleanup();
  }
});
