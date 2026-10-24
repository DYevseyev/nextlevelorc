// nextlevel fix and the fix loop (M5): a Claude Code session on a field report (through the claude stub),
// only once claude.github passes (FR-002); then GitHub (the gh stub) closes the issue, nextlevel updates
// itself (from a fake GitHub) and runs the report's check again. Nothing leaves this PC.
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { createdSession, fixPrompt, fixStore, followFixes, jsonIn, parseIssue, reportChecks } from '../src/fix.mjs';
import { installedTool } from './helpers.mjs';

test('parseIssue, reportChecks and the prompt Claude Code gets', () => {
  const repo = 'DYevseyev/nextlevelorc';
  assert.deepEqual(parseIssue('12', repo), { repo, number: 12 });
  assert.deepEqual(parseIssue('#7', repo), { repo, number: 7 });
  assert.deepEqual(parseIssue('o/r#3', repo), { repo: 'o/r', number: 3 });
  assert.deepEqual(parseIssue('https://github.com/o/r/issues/44#issuecomment-1', repo), { repo: 'o/r', number: 44 });
  assert.equal(parseIssue('twelve', repo), null);
  assert.deepEqual(reportChecks('<!-- nextlevel-report v1 checks=codex.model,git.pushed os=win32 -->\n...'), ['codex.model', 'git.pushed']);
  assert.deepEqual(reportChecks('an issue someone wrote'), []);
  const prompt = fixPrompt({ repo, number: 12, url: `https://github.com/${repo}/issues/12`, fromReport: true });
  assert.match(prompt, /^Fix issue #12 in DYevseyev\/nextlevelorc \(https:\/\/github\.com\/.*\/issues\/12\), a field report/);
  assert.match(prompt, /Fixes #12, so that merging it closes the issue/);
  assert.match(prompt, /open a draft pull request whose description says Fixes #12/);
  assert.match(prompt, /Keep fixing until the ubuntu and windows checks pass \(CLAUDE\.md, CI and merging: Windows runs once, when you mark the pull request ready for review at the end\)/);
  assert.doesNotMatch(prompt, /["%\r\n]/, 'one line, nothing cmd.exe would change');
  assert.match(fixPrompt({ repo, number: 1, url: 'u', local: true }), /worktree of the tool on its own branch/);
});

test('createdSession: the session Claude Code\'s debug log says it created, as the link its View line shows (FR-006)', () => {
  const log = [
    '2026-09-26T09:00:00.001Z [DEBUG] Git remote URL: https://github.com/DYevseyev/nextlevelorc.git',
    '2026-09-26T09:00:02.417Z [DEBUG] Successfully created remote session: session_01AbCdEfGhIjKlMnOpQrStUv',
    '2026-09-26T09:00:02.500Z [DEBUG] Skipping SessionEnd:other hook execution',
  ].join('\n');
  assert.equal(createdSession(log), 'https://claude.ai/code/session_01AbCdEfGhIjKlMnOpQrStUv');
  assert.equal(createdSession('[DEBUG] Git remote URL: null\n[DEBUG] Remote settings: No settings found (404)'), null, 'none created');
  assert.equal(createdSession(''), null);
  assert.equal(createdSession(null), null);
});

// GitHub's answer about issue o/r#5 (gh api graphql, as askIssue asks it); `closer`: what closed it
const answer = ({ state = 'OPEN', stateReason = null, closedAt = null, closer = null } = {}) =>
  JSON.stringify({ data: { repository: { issue: { state, stateReason, closedAt, url: 'https://github.com/o/r/issues/5', timelineItems: { nodes: state === 'CLOSED' ? [{ closer }] : [] } } } } });
const byPr = { __typename: 'PullRequest', number: 12, url: 'https://github.com/o/r/pull/12', merged: true };

// followFixes with GitHub, git and the doctor played by the test.
function loop({ fixes, issue = { state: 'OPEN' }, installed = false, results = [], blocker = '' }) {
  const state = { fixes };
  const store = fixStore({ get: (k) => state[k], set: (k, v) => (state[k] = v) });
  const calls = { gh: 0, doctor: 0, notified: [], ghArgs: null };
  const run = (extra = {}) =>
    followFixes({
      root: '/proj',
      store,
      installWhen: 'at the next start',
      blocker: () => blocker,
      notify: async (title, message, priority) => calls.notified.push({ title, message, priority }),
      gh: (args) => {
        calls.gh++;
        calls.ghArgs = args;
        return { ok: true, out: answer(issue) };
      },
      tool: {
        fetch: () => ({ ok: true }),
        mainRef: () => 'refs/remotes/origin/main',
        git: (args) => (args[0] === 'rev-parse' ? { ok: true, out: args[1] === '--short' ? 'abc1234' : 'f'.repeat(40) } : { ok: installed }),
      },
      doctor: async () => {
        calls.doctor++;
        return results;
      },
      ...extra,
    });
  return { run, calls, store, fix: () => store.list()[0] };
}
const started = (more = {}) => ({ repo: 'o/r', number: 5, url: 'https://github.com/o/r/issues/5', checks: ['codex.model'], checkTitles: ['Codex model'], project: '/proj', state: 'started', ...more });

test('followFixes: asks GitHub at most every 10 minutes; a merged fix waits for the owner to install it, then its check runs again', async () => {
  const l = loop({ fixes: [started(), started({ number: 6, project: '/other' }), started({ number: 7, project: null })] });
  await l.run();
  assert.equal(l.calls.gh, 2, "this project's fix, and the one started outside any project; not another project's");
  l.store.save({ ...l.store.list().find((f) => f.number === 7), state: 'closed' });
  assert.equal(l.fix().state, 'started');
  await l.run();
  assert.equal(l.calls.gh, 2, 'not again within 10 minutes');
  await l.run({ force: true });
  assert.equal(l.calls.gh, 3, 'nextlevel fix asks at once');

  // Closed by its pull request: merged, not in this nextlevel yet. The owner hears it once.
  const m = loop({ fixes: [started()], issue: { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-09-26T10:00:00Z', closer: byPr } });
  let r = await m.run();
  assert.deepEqual(m.calls.ghArgs.slice(0, 2), ['api', 'graphql']);
  assert.ok(['owner=o', 'name=r', 'number=5'].every((a) => m.calls.ghArgs.includes(a)), m.calls.ghArgs.join(' '));
  assert.doesNotMatch(m.calls.ghArgs.join(' '), /"/, 'no double quote: in tests gh is a .cmd stub, run through cmd.exe');
  assert.equal(m.fix().state, 'merged');
  assert.deepEqual(m.fix().pr, { number: 12, url: 'https://github.com/o/r/pull/12' });
  assert.equal(m.fix().mainSha, 'f'.repeat(40));
  assert.deepEqual(r.toInstall.map((f) => f.number), [5]);
  assert.match(m.calls.notified[0].title, /the fix for "Codex model" is merged/);
  // (FR-017: nothing installs it by itself; safe updates: it comes with a release)
  assert.equal(m.calls.notified[0].message, '#5 is merged. It comes with the next nextlevel release; nothing to do now. Then nextlevel runs the check again.');
  r = await m.run({ force: true });
  assert.equal(m.calls.notified.length, 1, 'said once');
  assert.equal(m.calls.doctor, 0, 'no check before the fix is installed');
  // Its pull request's own merge commit marks it (fixSha); a release that has it is told once
  const withSha = loop({ fixes: [started()], issue: { state: 'CLOSED', stateReason: 'COMPLETED', closedAt: '2026-09-26T10:00:00Z', closer: { ...byPr, mergeCommit: { oid: 'e'.repeat(40) } } } });
  await withSha.run({
    tool: {
      fetch: () => ({ ok: true }),
      mainRef: () => 'refs/remotes/origin/main',
      releases: () => [{ name: 'v0.4.0', commit: '4'.repeat(40) }, { name: 'v0.3.0', commit: '3'.repeat(40) }],
      git: (args) => (args[0] === 'rev-parse' ? { ok: true, out: 'f'.repeat(40) } : { ok: args[0] === 'merge-base' && args[2] === 'e'.repeat(40) && args[3] !== 'HEAD' }),
    },
  });
  assert.equal(withSha.fix().fixSha, 'e'.repeat(40));
  assert.equal(withSha.calls.notified.length, 2);
  assert.equal(withSha.calls.notified[1].title, 'nextlevel: the fix for "Codex model" is in v0.3.0', 'the oldest release that has it');
  assert.match(withSha.calls.notified[1].message, /Update on the dashboard's Home/);

  // Installed now: the check runs again and passes
  const ok = loop({ fixes: [{ ...m.fix() }], installed: true, results: [{ id: 'codex.model', title: 'Codex model', status: 'ok', detail: 'gpt-6 (accepted)' }] });
  r = await ok.run();
  assert.deepEqual(r.toInstall, []);
  assert.equal(ok.fix().state, 'fixed');
  assert.equal(ok.fix().head, 'abc1234');
  assert.match(ok.calls.notified[0].title, /nextlevel: fixed "Codex model"/);
  assert.match(ok.calls.notified[0].message, /installed \(nextlevel abc1234\) and Codex model passes now/);
  await ok.run({ force: true });
  assert.equal(ok.calls.doctor, 1, 'a finished fix is left alone');

  // ... or still fails: said loudly, with the way to report it again
  const bad = loop({ fixes: [{ ...m.fix() }], installed: true, results: [{ id: 'codex.model', title: 'Codex model', status: 'fail', detail: 'still rejected' }] });
  await bad.run();
  assert.equal(bad.fix().state, 'still-failing');
  assert.equal(bad.calls.notified[0].priority, 'high');
  assert.equal(bad.calls.notified[0].title, 'nextlevel: "Codex model" still fails');
  assert.match(bad.calls.notified[0].message, /but Codex model: still rejected\. To report it again: nextlevel report codex\.model/);

  // A report about several checks: the words agree, and only the ones that still fail are named
  const two = { ...m.fix(), checks: ['codex.model', 'git.remote'], checkTitles: ['Codex model', 'GitHub repo'] };
  const result = (id, title, status) => ({ id, title, status, detail: status === 'ok' ? 'fine' : `${title} broken` });
  const both = loop({ fixes: [{ ...two }], installed: true, results: [result('codex.model', 'Codex model', 'fail'), result('git.remote', 'GitHub repo', 'fail')] });
  await both.run();
  assert.equal(both.calls.notified[0].title, 'nextlevel: "Codex model", "GitHub repo" still fail');
  assert.match(both.calls.notified[0].message, /To report it again: nextlevel report$/);
  const oneLeft = loop({ fixes: [{ ...two }], installed: true, results: [result('codex.model', 'Codex model', 'ok'), result('git.remote', 'GitHub repo', 'fail')] });
  await oneLeft.run();
  assert.equal(oneLeft.calls.notified[0].title, 'nextlevel: "GitHub repo" still fails');
  const none = loop({ fixes: [{ ...two }], installed: true, results: [result('codex.model', 'Codex model', 'ok'), result('git.remote', 'GitHub repo', 'ok')] });
  await none.run();
  assert.match(none.calls.notified[0].message, /and Codex model, GitHub repo pass now\./);
});

test("followFixes: closed without a fix, an issue that wasn't a report, a nextlevel that can't update itself, GitHub not answering", async () => {
  const closed = loop({ fixes: [started()], issue: { state: 'CLOSED', stateReason: 'NOT_PLANNED' } });
  await closed.run();
  assert.equal(closed.fix().state, 'closed');
  assert.match(closed.calls.notified[0].message, /was closed as not planned: https:\/\/github\.com\/o\/r\/issues\/5$/);

  // FR-006 #4: only a merged pull request brings a fix. Closed by hand as completed (GitHub's default), by a
  // commit, or by a pull request that wasn't merged: closed without a fix, and nothing is checked again.
  for (const closer of [null, { __typename: 'Commit' }, { ...byPr, merged: false }]) {
    const byHand = loop({ fixes: [started()], issue: { state: 'CLOSED', stateReason: 'COMPLETED', closer }, installed: true });
    const r = await byHand.run();
    assert.equal(byHand.fix().state, 'closed', JSON.stringify(closer));
    assert.deepEqual(r.toInstall, []);
    assert.equal(byHand.calls.doctor, 0);
    assert.equal(byHand.calls.notified[0].title, 'nextlevel: #5 closed without a fix');
    assert.match(byHand.calls.notified[0].message, /The report "Codex model" was closed as completed, not by a pull request: /);
  }

  const plain = loop({ fixes: [started({ checks: [], checkTitles: [], state: 'merged', mainSha: 'x' })], installed: true });
  await plain.run();
  assert.equal(plain.fix().state, 'installed');
  assert.equal(plain.calls.doctor, 0, 'nothing to check again');

  const pinned = loop({ fixes: [started()], issue: { state: 'CLOSED', stateReason: 'COMPLETED', closer: byPr }, blocker: 'nextlevel is pinned at v0.1.0: nextlevel update --to main follows main again' });
  await pinned.run();
  assert.match(pinned.calls.notified[0].message, /merged, but it won't reach this nextlevel by itself: nextlevel is pinned at v0\.1\.0/);

  const silent = loop({ fixes: [started()] });
  await silent.run({ gh: () => ({ ok: false, out: 'You are not logged into any GitHub hosts.' }) });
  assert.equal(silent.fix().state, 'started');
  assert.match(silent.fix().problem, /not logged in/);
  // A GraphQL error comes back as JSON without data: asked again next time too
  const odd = loop({ fixes: [started()] });
  await odd.run({ force: true, gh: () => ({ ok: true, out: '{"errors":[{"message":"Something went wrong"}]}' }) });
  assert.equal(odd.fix().state, 'started');

  // gh's output can have more than the JSON in it (runQuiet adds what it wrote to stderr)
  const noisy = loop({ fixes: [started()] });
  await noisy.run({ gh: () => ({ ok: true, out: `${answer({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })}\n\nA new release of gh is available: 2.96.0 → 2.97.0` }) });
  assert.equal(noisy.fix().state, 'closed');
  assert.deepEqual(jsonIn('warning: x\n{"a":{"b":1}}\nmore'), { a: { b: 1 } });
  assert.equal(jsonIn('no json here'), null);
});

const calls = (t) => {
  const f = path.join(t.p.env.HOME, '.fake-claude', 'calls.jsonl');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};
const fixes = (t) => JSON.parse(fs.readFileSync(path.join(t.p.env.HOME, '.nextlevel', 'state.json'), 'utf8')).fixes || [];
const issueFile = (t, n) => path.join(t.p.env.HOME, '.fake-github', 'issues', `${n}.json`);
// Closed on the fake GitHub: by the merged pull request `pr` (its number), else by hand
function closeIssue(t, n, { stateReason = 'COMPLETED', pr = null, mergeCommit = null } = {}) {
  const issue = JSON.parse(fs.readFileSync(issueFile(t, n), 'utf8'));
  const closer = pr ? { __typename: 'PullRequest', number: pr, url: `https://github.com/${issue.repo}/pull/${pr}`, merged: true, ...(mergeCommit ? { mergeCommit: { oid: mergeCommit } } : {}) } : null;
  fs.writeFileSync(issueFile(t, n), JSON.stringify({ ...issue, state: 'CLOSED', stateReason, closedAt: new Date().toISOString(), closer }));
}
// The installed nextlevel, a project whose .env has a value no Claude Code may see, and a report filed for
// notify.topic (the sandbox has no ntfy topic, so it fails).
function reported() {
  const t = installedTool();
  fs.writeFileSync(path.join(t.p.repo, '.env'), 'NTFY_TOPIC=\nPLANTED_DOTENV=never-for-claude-5150\n');
  const r = t.nl(['report', 'notify.topic'], { input: 'y\nn\n' });
  assert.match(r.out, /Filed: #1 /, r.out);
  return t;
}
// The fix, as a release on the fake GitHub: notify.topic passes without a topic
const releaseFix = (t) => t.gh.commit('Fix notify.topic', () => t.gh.edit('src/checks/project.mjs', "if (!topic) return fail('NTFY_TOPIC empty',", "if (!topic) return pass('no topic, and that is fine now',"));

test('nextlevel fix starts a cloud session from the tool\'s clone, in the owner\'s window (FR-006), only once claude.github passes; otherwise it offers the other ways (FR-002)', () => {
  const t = reported();
  try {
    // Not confirmed, and the owner says no twice: no session, the browser steps and the prompt
    const no = t.nl(['fix', '1'], { input: 'n\nn\n' });
    assert.equal(no.code, 0, no.out);
    assert.match(no.out, /Not starting a cloud session: not confirmed: cloud sessions on DYevseyev\/nextlevelorc can push only if/);
    assert.match(no.out, /Browser: {2}https:\/\/claude\.ai\/connect-github/);
    assert.match(no.out, /Use Claude Code on this PC instead \(nextlevel fix 1 --local\)\? \[y\/N\] n/);
    assert.match(no.out, /start it in the browser: https:\/\/claude\.ai\/code, select DYevseyev\/nextlevelorc, and paste this prompt:\n\nFix issue #1 /);
    assert.deepEqual(calls(t), [], 'no session was started');
    assert.equal(fixes(t)[0].mode, 'browser', 'followed anyway, in case the owner starts it by hand');

    // The dashboard's way (--json): not started, and why, with every other way
    const j = JSON.parse(t.nl(['fix', '1', '--json']).out);
    assert.equal(j.started, false);
    assert.equal(fixes(t).length, 1, 'kept once, still followed');
    assert.equal(j.check, 'claude.github');
    assert.deepEqual(j.steps.map((s) => s.command), ['https://claude.ai/connect-github', 'https://github.com/apps/claude', 'nextlevel fix 1 --local', 'https://claude.ai/code']);
    assert.match(j.prompt, /^Fix issue #1 /);

    // Confirmed: the session starts in the tool's clone (whose remote is this repo), without .env values.
    // FR-006: Claude Code 2.1.282 refuses --cloud with -p ("--cloud cannot be combined with --print") and
    // with its output in a pipe, so it runs as `claude --cloud "<prompt>"` in the owner's window, which
    // shows its lines; nextlevel takes the session from its debug log.
    const yes = t.nl(['fix', '1'], { input: 'y\n', env: { CCR_FORCE_BUNDLE: '1' } });
    assert.equal(yes.code, 0, yes.out);
    const [call] = calls(t);
    assert.equal(call.args.at(-2), '--cloud', call.args.join(' '));
    assert.match(call.args.at(-1), /^Fix issue #1 in DYevseyev\/nextlevelorc .*a field report/);
    for (const flag of ['-p', '--print', '--output-format']) assert.ok(!call.args.includes(flag), `no ${flag}: ${call.args.join(' ')}`);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(t.tool), "run from the tool's clone, never the project");
    assert.equal(call.remote, 'https://github.com/DYevseyev/nextlevelorc.git');
    assert.deepEqual(call.env, [], 'no .env value, no CCR_FORCE_BUNDLE, no NEXTLEVEL_ROOT');
    assert.match(yes.out, /Created cloud session: Fix issue #1 /, "Claude Code's lines, in the owner's window");
    const view = yes.out.match(/View: (https:\/\/claude\.ai\/code\/(session_stub\d+))/);
    assert.ok(view, yes.out);
    assert.match(yes.out, new RegExp(`Resume with: claude --teleport ${view[2]}`));
    assert.ok(yes.out.includes(`Started: ${view[1]}\n`), `the session the View line shows: ${yes.out}`);
    assert.match(yes.out, /When it is merged, nextlevel tells you; it comes with the next release, and your update installs it \(nothing installs it by itself\); then notify\.topic runs again, and your phone hears how it went/);
    const debugLog = call.args[call.args.indexOf('--debug-file') + 1];
    assert.ok(call.args.includes('--debug-file') && debugLog !== '--cloud', call.args.join(' '));
    assert.ok(!fs.existsSync(debugLog), "Claude Code's debug log is removed");
    const [fix] = fixes(t);
    assert.deepEqual([fix.mode, fix.state, fix.checks, fix.number, fix.session], ['cloud', 'started', ['notify.topic'], 1, view[1]]);
    assert.match(t.nl(['doctor']).out, / ok +Claude on GitHub +you confirmed on /, 'the confirmation is the doctor\'s too');

    // The dashboard's way (--json) has no terminal: the command for the owner's window, or the browser
    const dash = JSON.parse(t.nl(['fix', '1', '--json']).out);
    assert.equal(dash.started, false);
    assert.match(dash.message, /A cloud session starts in your own window \(Claude Code starts one only in a terminal\): in (PowerShell|Terminal), nextlevel fix 1/);
    assert.deepEqual(dash.steps.map((s) => s.command), ['nextlevel fix 1', 'https://claude.ai/code']);
    assert.equal(fs.realpathSync.native(dash.steps[0].cwd), fs.realpathSync.native(t.p.repo), 'in the project folder'); // native: C:\Users\RUNNER~1 is C:\Users\runneradmin too
    assert.match(dash.prompt, /^Fix issue #1 /);
    assert.equal(calls(t).length, 1, 'no session from there');

    // A cloud session that doesn't start says so, with the other ways; Claude Code's own message is in the window
    const failed = t.nl(['fix', '1'], { env: { STUB_CLAUDE_CLOUD: 'fail' } });
    assert.equal(failed.code, 1);
    assert.match(failed.out, /Error: Unable to create cloud session/);
    assert.match(failed.out, /The cloud session didn't start: Claude Code exited with 1 \(what it said is above\)\. Other ways:/);
    assert.match(failed.out, /nextlevel fix 1 --local/);
    // ... as when its output isn't a terminal
    const piped = t.nl(['fix', '1'], { env: { STUB_CLAUDE_NO_TTY: '1' } });
    assert.equal(piped.code, 1);
    assert.match(piped.out, /Error: --cloud requires an interactive terminal/);
    assert.match(piped.out, /The cloud session didn't start: Claude Code exited with 1/);
    // Claude Code ended well, but its log has no new session: nextlevel doesn't claim one
    const unsure = t.nl(['fix', '1'], { env: { STUB_CLAUDE_CLOUD: 'nolog' } });
    assert.equal(unsure.code, 1);
    assert.match(unsure.out, /nextlevel can't tell whether a cloud session started: Claude Code's log has none\. If it printed a View link above, the session is there/);
    assert.equal(fixes(t)[0].session, view[1], 'the session it started first stays');

    // How they are doing, and a closed issue
    assert.match(t.nl(['fix']).out, /#1 Field report: Phone notifications \(notify\.topic\) on \w+\n +cloud session https:\/\/claude\.ai\/code\/session_stub\d+\S* · started \d{4}-\d\d-\d\d\n +waiting for its pull request to be merged/);
    // Closed by hand, as completed (GitHub's default, as #9 was): closed without a fix (FR-006 #4)
    closeIssue(t, 1);
    const after = t.nl(['fix']).out;
    assert.match(after, /nextlevel: #1 closed without a fix: The report "Phone notifications" was closed as completed, not by a pull request/);
    assert.match(after, /#1 Field report: Phone notifications .*\n.*\n +closed without a fix \(as completed, not by a pull request\)/);
    assert.doesNotMatch(after, /installed|still fail/);
    assert.match(t.nl(['fix', '1']).out, /#1 is closed already/);
  } finally {
    t.p.cleanup();
  }
});

test('nextlevel fix --local runs Claude Code in a worktree of the tool, so the installed tool stays as it is', () => {
  const t = reported();
  try {
    const r = t.nl(['fix', '1', '--local']);
    assert.equal(r.code, 0, r.out);
    const folder = path.join(t.p.env.HOME, '.nextlevel', 'fixes', 'issue-1');
    assert.match(r.out, /Claude Code on this PC, in .*issue-1 \(branch fix\/issue-1\)/);
    const [call] = calls(t);
    assert.equal(fs.realpathSync(call.cwd), fs.realpathSync(folder));
    assert.equal(call.args.length, 1, 'interactive, with the prompt');
    assert.match(call.args[0], /worktree of the tool on its own branch/);
    assert.deepEqual(call.env, []);
    assert.equal(t.p.gitIn(folder, 'rev-parse', '--abbrev-ref', 'HEAD'), 'fix/issue-1');
    assert.equal(t.git('rev-parse', '--abbrev-ref', 'HEAD'), 'main', 'the installed tool stays on main');
    assert.equal(t.git('status', '--porcelain', '--untracked-files=no'), '');
    assert.equal(fixes(t)[0].mode, 'local');
    // Again: the same folder
    assert.equal(t.nl(['fix', '1', '--local']).code, 0);
    assert.equal(calls(t).length, 2);
  } finally {
    t.p.cleanup();
  }
});

test('the fix loop with releases (safe updates): a merged fix waits for its release, the phone hears each step once, and the check runs again once the release is installed; the hub installs nothing', () => {
  const t = reported();
  const run = () => t.nl(['run', '--exit-when-idle', '--tick-ms', '200'], { timeout: 180_000 });
  try {
    assert.match(t.nl(['fix', '1'], { input: 'y\n' }).out, /Started: /);
    // The PC runs the release v0.1.0 (from before the fix)
    t.gh.release('v0.1.0');
    assert.equal(t.nl(['_install'], { env: { NEXTLEVEL_NO_PATH: '1' } }).code, 0);
    const versions = () => JSON.parse(fs.readFileSync(path.join(t.p.env.HOME, '.nextlevel', 'versions.json'), 'utf8'));
    // The fix is merged: its pull request's own merge commit is recorded
    releaseFix(t);
    const fixCommit = t.gh.git('rev-parse', 'HEAD');
    closeIssue(t, 1, { pr: 2, mergeCommit: fixCommit });
    t.gh.commit('something unreleased after it', (w) => fs.appendFileSync(path.join(w, 'README.md'), '\nlater\n'));
    // (the hub asks GitHub every 10 minutes; nextlevel fix asks at once)
    const merged = t.nl(['fix']);
    assert.equal(merged.code, 0, merged.out);
    assert.match(merged.out, /nextlevel: the fix for "Phone notifications" is merged: #1 is merged\. It comes with the next nextlevel release; nothing to do now\. Then nextlevel runs the check again\./);
    assert.match(merged.out, /\[notify\] NTFY_TOPIC not set, skipped: nextlevel: the fix for "Phone notifications" is merged/, 'and the phone is told');
    assert.doesNotMatch(merged.out, /nextlevel: fixed/);
    assert.equal(fixes(t)[0].fixSha, fixCommit);
    assert.equal(versions().release, 'v0.1.0', 'nothing installed');

    // A release has it: told once
    t.gh.release('v0.2.0', { at: fixCommit });
    fs.rmSync(path.join(t.p.env.HOME, '.nextlevel', 'update', 'available.json'), { force: true }); // (the hubs look every 6 hours: now)
    assert.equal(t.nl(['_releases']).code, 0);
    const released = run();
    assert.match(released.out, /nextlevel: the fix for "Phone notifications" is in v0\.2\.0: The fix for #1 is in nextlevel v0\.2\.0: Update on the dashboard's Home/);
    assert.equal(versions().release, 'v0.1.0', 'still nothing installed');
    assert.doesNotMatch(run().out, /is in v0\.2\.0|is merged/, 'said once');

    // The owner updates: the hub's next look runs the check again, on the new code, and tells the phone
    const up = t.nl(['update']);
    assert.equal(up.code, 0, up.out);
    assert.equal(versions().release, 'v0.2.0');
    const after = run();
    assert.match(after.out, /\[notify\] NTFY_TOPIC not set, skipped: nextlevel: fixed "Phone notifications"/);
    assert.equal(fixes(t)[0].state, 'fixed');
  } finally {
    t.p.cleanup();
  }
});

// An install that moved keeps its reports going to the repository it left (state.json "reports"): nextlevel fix never
// starts a session on such an issue from the clone, whose repository is another one (open-source plan review, PR #48)
test('nextlevel fix refuses an issue in another repository than the tool clone\'s, before anything starts', () => {
  const t = reported();
  try {
    const file = path.join(t.p.env.HOME, '.nextlevel', 'state.json');
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...st, reports: { repo: 'someone/private-tool', since: new Date().toISOString(), why: 'moved' } }));
    for (const args of [['fix', '1'], ['fix', '1', '--local'], ['fix', 'someone/private-tool#1']]) {
      const r = t.nl(args, { input: 'y\ny\n' });
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /#1 is an issue in someone\/private-tool, but this nextlevel follows DYevseyev\/nextlevelorc: a session started from here would work in DYevseyev\/nextlevelorc/);
    }
    const j = JSON.parse(t.nl(['fix', '1', '--json']).out);
    assert.equal(j.started, false);
    assert.match(j.message, /is an issue in someone\/private-tool/);
    assert.deepEqual(calls(t), [], 'no session was started');
    assert.equal(fixes(t).filter((f) => f.repo === 'someone/private-tool').length, 0, 'nothing kept to follow');
    // The clone's own repository still works as before
    const own = t.nl(['fix', 'DYevseyev/nextlevelorc#1'], { input: 'n\nn\n' });
    assert.doesNotMatch(own.out, /is an issue in/);
  } finally {
    t.p.cleanup();
  }
});
