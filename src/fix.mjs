// nextlevel fix: Claude Code fixes a field report (an issue in nextlevel's repository), and nextlevel
// follows the fix until it is installed on this PC and the failed check has run again.
//   nextlevel fix <issue> [--json]     a Claude Code cloud session on nextlevel's repository, started in this
//                                      window from the tool's own clone (claude --cloud clones that folder's
//                                      GitHub remote). Claude Code starts one only in a terminal (FR-006), so
//                                      --json (the dashboard) gives the command for the owner's window instead.
//                                      Only once claude.github passes (FR-002: without the GitHub connection
//                                      a session gets a copy it can't push); otherwise the owner confirms it
//                                      here, or it falls back to --local or to steps for the browser.
//   nextlevel fix <issue> --local      Claude Code on this PC, in a worktree of the tool's clone
//                                      (~/.nextlevel/fixes/issue-<n>), so the installed tool stays as it is
//   nextlevel fix [--json]             the fixes started on this PC: asks GitHub about each one now
//
// The loop (followFixes): GitHub closes the issue when the pull request that says "Fixes #<n>" is merged.
// nextlevel asks about it at most every 10 minutes: at owner commands' start, and in the hub. Only an issue
// a merged pull request closed has a fix; one closed by hand, as completed or not, is closed without a fix
// (FR-006 #4). nextlevel doesn't install a merged fix by itself (FR-017): it reaches this PC with the release that has
// it (safe updates). The owner (and their phone) hears when it is merged, when a release has it, and, once the owner
// updated to that release, the verdict of the report's checks run again.
// Fixes are kept in ~/.nextlevel/state.json ("fixes").
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolGithubRepo } from './checks/engines.mjs';
import { byId, runChecks } from './checks/index.mjs';
import { firstLine, step, windowLabel } from './checks/lib.mjs';
import { makeAsker } from './lib/ask.mjs';
import { commandArgs } from './lib/commands.mjs';
import { homeDir, userState } from './lib/home.mjs';
import { resolveBin, runQuiet, spawnBin } from './lib/proc.mjs';
import { TOOL_ROOT } from './lib/project.mjs';
import { SANDBOX_NAME } from './lib/sandbox.mjs';
import { fetchTool, readAvailable, toolGit, toolState } from './lib/update.mjs';
import { toolRepo } from './report.mjs';

const POLL_MS = 10 * 60_000;
// (left: the install moved to another repository, whose releases never have this fix: lib/install.mjs keepWhatMoved)
const FINAL = new Set(['fixed', 'still-failing', 'installed', 'closed', 'left']);
const BIN = path.join(TOOL_ROOT, 'bin', 'nextlevel.mjs');
const now = () => new Date().toISOString();
// gh without its update notice or prompts (runQuiet mixes stderr into the output), short enough that a
// slow answer doesn't hold up the hub's loop for long
const ghRun = (args) => runQuiet('gh', args, { timeoutMs: 20_000, env: { ...process.env, GH_NO_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1' } });
// The JSON object in gh's output, with anything it printed around it left out; null if there is none.
export function jsonIn(text) {
  const s = String(text || '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}

// "12", "#12", "owner/repo#12" or the issue's link -> { repo, number }, or null.
export function parseIssue(text, repo) {
  const s = String(text || '').trim();
  let m = s.match(/^#?(\d+)$/);
  if (m) return { repo, number: Number(m[1]) };
  m = s.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/) || s.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/issues\/(\d+)(?:[/?#].*)?$/i);
  return m ? { repo: m[1], number: Number(m[2]) } : null;
}

// The check ids a report is about, from the line nextlevel report puts at its top.
export const reportChecks = (body) => (String(body || '').match(/<!--\s*nextlevel-report v1 checks=([a-z0-9.,-]*)/) || [, ''])[1].split(',').filter(Boolean);

// What Claude Code is asked. One line, without quotes or %: on Windows it goes through cmd.exe to claude.cmd.
export function fixPrompt({ repo, number, url, fromReport, local = false }) {
  const what = fromReport ? `, a field report that nextlevel report filed from a PC` : '';
  const where = local ? ' You are in a worktree of the tool on its own branch: commit there and push that branch.' : '';
  const text =
    `Fix issue #${number} in ${repo} (${url})${what}. Read CLAUDE.md and the issue, reproduce the failure in a test first ` +
    `(a check gets a unit test on a fake PC), fix it, note it in docs/FIELD_REPORTS.md, and open a draft pull request ` +
    `whose description says Fixes #${number}, so that merging it closes the issue.${where} Keep fixing until the ubuntu ` +
    'and windows checks pass (CLAUDE.md, CI and merging: Windows runs once, when you mark the pull request ready for ' +
    'review at the end), and end the pull request with an Owner check section.';
  if (/["%\r\n]/.test(text)) throw new Error(`the prompt for #${number} has a character cmd.exe would change`);
  return text;
}

// ---------- the fixes this PC started ----------
export function fixStore(state = userState()) {
  const key = (f) => `${f.repo}#${f.number}`;
  return {
    list: () => state.get('fixes') || [],
    // re-read on every change: the hub and an owner's command may both be at it
    save(fix) {
      const all = (state.get('fixes') || []).filter((f) => key(f) !== key(fix));
      state.set('fixes', [...all, fix].slice(-50));
      return fix;
    },
  };
}

// ---------- starting a session ----------
// Claude Code in this window (the owner's), with the keyboard. Ctrl+C is Claude Code's, which shares this
// console: this process waits for it instead of ending underneath it (the way rerun() waits for the
// command it runs again). Never with CCR_FORCE_BUNDLE, which would send an uploaded copy of the folder
// instead of the GitHub repository.
function claudeInWindow(bin, args, { cwd, env }) {
  const clean = { ...env };
  delete clean.CCR_FORCE_BUNDLE;
  const wait = () => {};
  process.on('SIGINT', wait);
  return new Promise((resolve) => {
    const child = spawnBin(bin, args, { cwd, env: clean, stdio: 'inherit', windowsHide: false }); // in the owner's own window
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      console.log(err.message);
      resolve(1);
    });
  }).finally(() => process.off('SIGINT', wait));
}

// The link of the cloud session Claude Code's debug log says it created (the session its "View:" line
// shows), or null if it created none.
export function createdSession(log) {
  const ids = [...String(log || '').matchAll(/created remote session: (session_[A-Za-z0-9_]+)/gi)].map((m) => m[1]);
  return ids.length ? `https://claude.ai/code/${ids.at(-1)}` : null;
}

// claude --cloud "<prompt>", from the tool's clone: the session clones that folder's GitHub remote (never
// the project's folder, which would be uploaded if the remote couldn't be used). Claude Code 2.1 starts a
// new cloud session only in a terminal (FR-006): with -p it refuses, and with its output in a pipe too.
// So it runs in this window, where it may ask the owner something first, and prints "Created cloud
// session", "View: <link>" and "Resume with: claude --teleport <id>". A terminal can't be read back: the
// session comes from Claude Code's debug log (--debug-file, in a temporary folder removed afterwards),
// the line it writes once the session is created. Returns { code, url }; url only for a new session.
async function startCloud(bin, prompt, env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-fix-'));
  const log = path.join(dir, 'claude-debug.log');
  try {
    // the path goes through cmd.exe to claude.cmd too: one it would change gets no log (and no link)
    const debug = /["%\r\n]/.test(log) ? [] : ['--debug-file', log];
    const code = await claudeInWindow(bin, [...debug, '--cloud', prompt], { cwd: TOOL_ROOT, env });
    return { code, url: fs.existsSync(log) ? createdSession(fs.readFileSync(log, 'utf8')) : null };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      // a log left in the temporary folder: nothing else depends on it
    }
  }
}

// A worktree of the tool's clone for a local session: the installed tool stays on its branch, clean.
function localFolder(number) {
  const dir = path.join(homeDir(), 'fixes', `issue-${number}`);
  if (fs.existsSync(path.join(dir, '.git'))) return { ok: true, dir };
  const f = fetchTool(60_000);
  if (!f.ok) return { ok: false, message: `couldn't fetch nextlevel's repository: ${firstLine(f.err)}` };
  const main = toolState(toolGit).defaultBranch;
  const branch = `fix/issue-${number}`;
  const has = toolGit(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]).ok;
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = toolGit(has ? ['worktree', 'add', dir, branch] : ['worktree', 'add', '-b', branch, dir, `origin/${main}`]);
  return r.ok ? { ok: true, dir, branch } : { ok: false, message: `git worktree add failed: ${firstLine(r.err)}` };
}

const formatStep = (s, platform) => `  ${windowLabel(s.window, platform)}${s.cwd ? `, in ${s.cwd}` : ''}:  ${[s.command, s.text && (s.command ? `(${s.text})` : s.text)].filter(Boolean).join('   ')}`;

// The ways to start it when nextlevel doesn't start a cloud session itself.
function otherWays(repo, number) {
  return [
    step('terminal', `nextlevel fix ${number} --local`, { text: 'Claude Code on this PC instead' }),
    step('browser', 'https://claude.ai/code', { text: `or start it there: select ${repo} and paste the prompt below` }),
  ];
}


// { ctx, env (for claude: no .env values), notify(title, message, priority), asker (from report) }.
// Returns the exit code.
export async function cmdFix(argv, { ctx, env = process.env, notify = async () => {}, asker = null, store = fixStore() }) {
  const a = commandArgs('fix', argv);
  const print = (v) => console.log(JSON.stringify(v, null, 2));
  // --json (the dashboard): steps carry the name of their window, as the doctor's do
  const stop = (message, extra = {}, code = 1) => {
    if (a.json) print({ ok: false, started: false, message, ...extra, ...(extra.steps ? { steps: extra.steps.map((s) => ({ ...s, label: windowLabel(s.window, ctx.platform) })) } : {}) });
    else console.log(message);
    return code;
  };
  if (ctx.sandbox) return stop(`nextlevel fix can't run inside ${SANDBOX_NAME}: it starts Claude Code with your sign-ins, which the sandbox hides. Owner: run it in a normal PowerShell window.`);
  if (!a._.length) return cmdFixStatus({ ctx, json: a.json, notify, store });

  const target = parseIssue(a._[0], toolRepo(ctx));
  if (!target) return stop(`"${a._[0]}" is not an issue: give its number (nextlevel fix 12) or its link.`);
  const { repo, number } = target;
  // A session here works in the tool clone's repository. An issue somewhere else (this install moved, and its reports
  // still go to the repository it left: state.json "reports") is never worked on from here: the session's pull request,
  // with what it read in the issue, would be in the clone's repository, and its "Fixes #n" would close an issue there.
  const cloneRepo = toolGithubRepo(ctx);
  if (cloneRepo && cloneRepo.toLowerCase() !== repo.toLowerCase()) {
    return stop(
      `#${number} is an issue in ${repo}, but this nextlevel follows ${cloneRepo}: a session started from here would work in ${cloneRepo}, not ${repo}. Fix it in a clone of ${repo}, or start a session on ${repo} at https://claude.ai/code with the issue's link: https://github.com/${repo}/issues/${number}`,
    );
  }
  const view = ghRun(['issue', 'view', String(number), '--repo', repo, '--json', 'number,title,state,url,body']);
  if (!view.ok) {
    const why = view.missing ? 'the GitHub CLI (gh) is not installed' : /auth login|not logged/i.test(view.out) ? 'gh is not signed in (in PowerShell: gh auth login)' : firstLine(view.out);
    return stop(`Couldn't read issue #${number} of ${repo} from GitHub: ${why}.`);
  }
  const issue = jsonIn(view.out);
  if (!issue) return stop(`GitHub's answer about #${number} wasn't readable: ${firstLine(view.out)}`);
  if (issue.state !== 'OPEN') return stop(`#${number} is closed already: ${issue.url}`);
  const checks = reportChecks(issue.body);
  const fix = {
    repo,
    number,
    url: issue.url,
    title: String(issue.title || '').slice(0, 200),
    checks,
    checkTitles: checks.map((id) => byId(id)?.title || id),
    project: ctx.root,
    state: 'started',
    startedAt: now(),
  };
  // A fix not started here is kept to be followed, unless one for this issue is kept already (a session
  // started earlier, say)
  const follow = (f) => store.list().some((x) => x.repo === repo && x.number === number) || store.save(f);
  const promptFor = (local) => fixPrompt({ repo, number, url: issue.url, fromReport: checks.length > 0, local });
  const followUp = checks.length
    ? `When it is merged, nextlevel tells you; it comes with the next release, and your update installs it (nothing installs it by itself); then ${checks.join(', ')} runs again, and your phone hears how it went. The hub looks every 10 minutes, and each nextlevel start looks too. To look now: nextlevel fix`
    : 'When it is merged, nextlevel tells you; it comes with the next release, and your update installs it (nothing installs it by itself). The hub looks every 10 minutes. To look now: nextlevel fix';

  let mode = a.local ? 'local' : 'cloud';
  let ask = asker;
  const closeOwnAsker = () => {
    if (ask && ask !== asker) ask.close();
  };
  try {
    if (mode === 'cloud') {
      const [tool, github] = await runChecks(ctx, { checks: [byId('tool.claude'), byId('claude.github')] });
      if (tool.status !== 'ok') {
        const steps = [...tool.steps, otherWays(repo, number)[1]];
        if (a.json) return stop(`Claude Code isn't ready on this PC: ${tool.detail}.`, { steps, prompt: promptFor(false) });
        console.log(`Claude Code isn't ready on this PC: ${tool.detail}. Install it, then run this again:`);
        for (const s of steps) console.log(formatStep(s, ctx.platform));
        console.log(`\nThe prompt:\n${promptFor(false)}`);
        return 1;
      }
      if (github.status !== 'ok') {
        const why = `Not starting a cloud session: ${github.detail}. A session started without that gets a copy of the tool it can't push, and its work is lost (FR-002).`;
        const steps = [...github.steps, ...otherWays(repo, number)];
        if (a.json) {
          follow({ ...fix, mode: 'browser' }); // the page offers the prompt for claude.ai/code: followed like the others
          return stop(why, { steps, prompt: promptFor(false), check: 'claude.github' }, 2);
        }
        console.log(why);
        for (const s of github.steps) console.log(formatStep(s, ctx.platform));
        ask ||= makeAsker({ onNoAnswer: '(no answer: no)' });
        const check = byId('claude.github');
        if (github.repo && (await ask.yes(check.fixPrompt(github)))) {
          await check.fix(ctx, { interactive: true, say: console.log }, github);
          console.log('Noted: cloud sessions can use GitHub (the doctor shows it as confirmed).');
        } else if (await ask.yes(`Use Claude Code on this PC instead (nextlevel fix ${number} --local)?`)) {
          mode = 'local';
        } else {
          console.log(`\nThen start it in the browser: https://claude.ai/code, select ${repo}, and paste this prompt:\n\n${promptFor(false)}\n`);
          store.save({ ...fix, mode: 'browser' });
          console.log(followUp);
          return 0;
        }
      }
    }

    // The dashboard has no terminal, and Claude Code starts a cloud session only in one (FR-006)
    if (mode === 'cloud' && a.json) {
      follow({ ...fix, mode: 'browser' }); // started from the owner's window or the browser, it is followed all the same
      const here = step('terminal', `nextlevel fix ${number}`, { cwd: ctx.root || undefined, text: 'Claude Code starts the cloud session there' });
      return stop(`A cloud session starts in your own window (Claude Code starts one only in a terminal): in ${windowLabel('terminal', ctx.platform)}, nextlevel fix ${number}`, { steps: [here, otherWays(repo, number)[1]], prompt: promptFor(false) });
    }
    if (mode === 'cloud') {
      const bin = resolveBin('claude');
      if (!bin) return stop('Claude Code is not installed: nextlevel doctor shows how to install it (Claude Code row).');
      closeOwnAsker();
      ask = null;
      asker?.close(); // Claude Code may ask something first (whether to trust the folder, say): it needs the keyboard
      console.log(`Starting a Claude Code cloud session on ${repo} for #${number}, in this window. If Claude Code asks you something, answer it here; it prints the session's link and ends.\n`);
      const started = await startCloud(bin, promptFor(false), env);
      if (!started.url) {
        follow({ ...fix, mode: 'browser' }); // started some other way, it is followed all the same
        console.log(
          started.code === 0
            ? "\nnextlevel can't tell whether a cloud session started: Claude Code's log has none. If it printed a View link above, the session is there (the fix is followed either way). If not, other ways:"
            : `\nThe cloud session didn't start: Claude Code exited with ${started.code} (what it said is above). Other ways:`,
        );
        for (const s of otherWays(repo, number)) console.log(formatStep(s, ctx.platform));
        console.log(`\nThe prompt:\n${promptFor(false)}`);
        return 1;
      }
      store.save({ ...fix, mode: 'cloud', session: started.url });
      console.log(`\nStarted: ${started.url}`);
      console.log("Follow it there (or in the Claude app's Code tab). It opens a draft pull request and marks it ready for review at the end, which runs Windows; merge it once its ubuntu and windows checks are green.");
      console.log(followUp);
      return 0;
    }

    // --local: an interactive Claude Code in the owner's own window
    if (a.json) return stop(`A local session runs in your own window: in PowerShell, nextlevel fix ${number} --local`, { steps: [otherWays(repo, number)[0]] });
    const bin = resolveBin('claude');
    if (!bin) return stop('Claude Code is not installed: nextlevel doctor shows how to install it (Claude Code row).');
    const folder = localFolder(number);
    if (!folder.ok) return stop(`Couldn't make a folder for the fix: ${folder.message}.`);
    store.save({ ...fix, mode: 'local', folder: folder.dir });
    closeOwnAsker();
    ask = null;
    asker?.close(); // Claude Code needs the keyboard
    console.log(`Claude Code on this PC, in ${folder.dir}${folder.branch ? ` (branch ${folder.branch})` : ''}. It asks before it changes things; when it is done, close it (/exit).`);
    const code = await claudeInWindow(bin, [promptFor(true)], { cwd: folder.dir, env });
    console.log(`\nClaude Code has ended (exit ${code}). ${followUp}`);
    return 0;
  } finally {
    closeOwnAsker();
  }
}

// ---------- following the fixes ----------
// What closed an issue is in its close event, which only GitHub's GraphQL API has (gh issue view doesn't).
// One line without double quotes: in tests gh is a .cmd stub, run through cmd.exe.
const CLOSED_BY =
  'query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){issue(number:$number){' +
  'state stateReason closedAt url timelineItems(itemTypes:[CLOSED_EVENT],last:1){nodes{... on ClosedEvent{closer{__typename ... on PullRequest{number url merged mergeCommit{oid}}}}}}}}}';

// An issue as the loop needs it: { state, stateReason, closedAt, url, pr } (pr: the merged pull request that
// closed it, else null), or { problem } when GitHub gave no answer (it is asked again next time).
export function askIssue(gh, repo, number) {
  const [owner, name] = String(repo).split('/');
  const r = gh(['api', 'graphql', '-f', `query=${CLOSED_BY}`, '-f', `owner=${owner}`, '-f', `name=${name}`, '-F', `number=${number}`]);
  const issue = r.ok ? jsonIn(r.out)?.data?.repository?.issue : null;
  if (!issue) return { problem: firstLine(r.out) || 'gh gave no answer' };
  const closer = issue.timelineItems?.nodes?.at(-1)?.closer;
  const pr = closer?.__typename === 'PullRequest' && closer.merged ? { number: closer.number, url: closer.url, mergeSha: /^[0-9a-f]{40}$/.test(String(closer.mergeCommit?.oid)) ? closer.mergeCommit.oid : '' } : null;
  return { state: issue.state, stateReason: issue.stateReason || '', closedAt: issue.closedAt, url: issue.url, pr };
}

// Why a closed issue has no fix to install: "as not planned", "as completed, not by a pull request".
function closedHow(f) {
  const as = f.reason ? `as ${String(f.reason).toLowerCase().replace(/_/g, ' ')}` : '';
  return ['NOT_PLANNED', 'DUPLICATE'].includes(f.reason) ? as : [as, 'not by a pull request'].filter(Boolean).join(', ');
}

// The doctor's results for a project, from the code on disk now (after an update: the new code).
function doctorChild(root) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...(root ? ['--project', root] : []), '--no-update', 'doctor', '--json'], {
      cwd: root || homeDir(),
      env: process.env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', () => {});
    const timer = setTimeout(() => child.kill(), 5 * 60_000);
    child.on('error', () => resolve(null));
    child.on('close', () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(out).results);
      } catch {
        resolve(null);
      }
    });
  });
}
const toolOps = () => ({
  fetch: () => fetchTool(30_000),
  git: toolGit,
  mainRef: () => `refs/remotes/origin/${toolState(toolGit).defaultBranch}`,
  // the releases newer than the installed one (update/available.json: the hubs and the dashboard refresh it)
  releases: () => readAvailable()?.newer || [],
});
const label = (f) => (f.checks?.length ? `"${f.checkTitles?.join('", "') || f.checks.join(', ')}"` : `#${f.number}`);
// "passes" / "pass", "still fails" / "still fail": one check or more
const verb = (n, one, more) => (n === 1 ? one : more);

// One look at the fixes started on this PC for this project (or outside any project): ask GitHub whether
// each one's issue is closed, and run the checks again for those whose fix this nextlevel has now.
// A merged fix is never installed here (FR-017): it reaches this PC with the release that has it (safe updates). The owner
// hears it once when it is merged (it comes with the next release), once when a release has it (Update on Home), and
// the verdict once the installed version has it and the report's checks ran again. A fix is in a version when the fix's
// own merge commit is (fixSha); a record from before kept main's head when the issue closed (mainSha). Returns
// { toInstall, events }: the fixes that are merged but not installed yet.
export async function followFixes({ root, force = false, notify = async () => {}, say = () => {}, blocker = () => '', store = fixStore(), gh = ghRun, tool = toolOps(), doctor = doctorChild }) {
  // this project's, and those started outside any project (a report about the tools), which anyone follows
  const mine = store.list().filter((f) => !FINAL.has(f.state) && (!f.project || f.project === root));
  const toInstall = [];
  const events = [];
  const tell = async (f, title, message, priority = 'default') => {
    events.push({ number: f.number, title, message });
    say(`${title}: ${message}`);
    try {
      await notify(title, message, priority);
    } catch (err) {
      say(`(the notification didn't go out: ${err.message})`);
    }
  };
  let fetched = null;
  for (let f of mine) {
    if (f.state === 'started' && (force || !f.polledAt || Date.now() - Date.parse(f.polledAt) > POLL_MS)) {
      f = { ...f, polledAt: now() };
      const issue = askIssue(gh, f.repo, f.number);
      if (issue.problem) f.problem = issue.problem;
      else if (issue.state === 'CLOSED' && issue.pr) {
        fetched ??= tool.fetch();
        if (fetched.ok) {
          const main = tool.git(['rev-parse', tool.mainRef()]);
          if (main.ok) f = { ...f, state: 'merged', mergedAt: issue.closedAt || now(), pr: { number: issue.pr.number, url: issue.pr.url }, mainSha: main.out.trim(), ...(issue.pr.mergeSha ? { fixSha: issue.pr.mergeSha } : {}), problem: undefined };
        } else f.problem = `couldn't fetch nextlevel's repository: ${firstLine(fetched.err)}`;
      } else if (issue.state === 'CLOSED') {
        // by hand (as completed or not) or by a commit: no pull request brought a fix
        f = { ...f, state: 'closed', closedAt: issue.closedAt || now(), reason: issue.stateReason, problem: undefined };
        await tell(f, `nextlevel: #${f.number} closed without a fix`, `The report ${label(f)} was closed ${closedHow(f)}: ${f.url}`);
      }
      store.save(f);
    }
    if (f.state !== 'merged') continue;
    const mark = f.fixSha || f.mainSha;
    if (!tool.git(['merge-base', '--is-ancestor', mark, 'HEAD']).ok) {
      toInstall.push(f);
      if (!f.toldMerged) {
        const why = blocker();
        f = store.save({ ...f, toldMerged: now() });
        await tell(f, `nextlevel: the fix for ${label(f)} is merged`, why ? `#${f.number} is merged, but it won't reach this nextlevel by itself: ${why}.` : `#${f.number} is merged. It comes with the next nextlevel release; nothing to do now. Then nextlevel runs the check again.`);
      }
      // a release has it: the owner updates when the team is idle
      const rel = (tool.releases?.() || []).filter((r) => /^[0-9a-f]{40}$/.test(String(r.commit))).reverse().find((r) => tool.git(['merge-base', '--is-ancestor', mark, r.commit]).ok);
      if (rel && f.toldReleased !== rel.name) {
        f = store.save({ ...f, toldReleased: rel.name });
        await tell(f, `nextlevel: the fix for ${label(f)} is in ${rel.name}`, `The fix for #${f.number} is in nextlevel ${rel.name}: Update on the dashboard's Home (or nextlevel update in PowerShell) when no hub or worker runs. Then nextlevel runs the check again.`);
      }
      continue;
    }
    // Installed: this nextlevel has the merged code. The report's checks run again, on it.
    const head = firstLine(tool.git(['rev-parse', '--short', 'HEAD']).out);
    if (!f.checks?.length) {
      f = store.save({ ...f, state: 'installed', installedAt: now(), head });
      await tell(f, `nextlevel: the fix for #${f.number} is installed`, `nextlevel ${head} has it: ${f.url}`);
      continue;
    }
    const results = await doctor(f.project);
    if (!results) {
      store.save({ ...f, problem: 'the doctor gave no answer' });
      continue;
    }
    const checked = f.checks.map((id) => results.find((r) => r.id === id) || { id, title: id, status: 'gone', detail: 'there is no such check any more' });
    const failing = checked.filter((r) => r.status !== 'ok');
    const titles = checked.map((r) => r.title);
    f = store.save({ ...f, state: failing.length ? 'still-failing' : 'fixed', checkedAt: now(), head, checkTitles: titles, result: checked.map((r) => ({ id: r.id, status: r.status, detail: r.detail })) });
    if (!failing.length) await tell(f, `nextlevel: fixed ${label(f)}`, `The fix for #${f.number} is installed (nextlevel ${head}) and ${titles.join(', ')} ${verb(titles.length, 'passes', 'pass')} now.`);
    else {
      // named: the ones that still fail, not every check the report was about
      const what = failing.map((r) => `${r.title}: ${r.status === 'skip' ? `not checked (${r.detail})` : r.detail}`).join('; ');
      const again = failing.length === 1 ? `nextlevel report ${failing[0].id}` : 'nextlevel report';
      await tell(f, `nextlevel: "${failing.map((r) => r.title).join('", "')}" ${verb(failing.length, 'still fails', 'still fail')}`, `The fix for #${f.number} is installed (nextlevel ${head}), but ${what}. To report it again: ${again}`, 'high');
    }
  }
  return { toInstall, events };
}

// `nextlevel fix` alone: what each fix started here is doing, after asking GitHub now.
async function cmdFixStatus({ ctx, json, notify, store }) {
  // --json: stdout carries the answer only (notify() says on stdout what it sent)
  const quiet = (fn) => async (...args) => {
    const log = console.log;
    console.log = console.error;
    try {
      return await fn(...args);
    } finally {
      console.log = log;
    }
  };
  const r = await followFixes({ root: ctx.root, force: true, notify: json ? quiet(notify) : notify, say: json ? () => {} : (m) => console.log(m), store });
  const fixes = store.list().filter((f) => !f.project || f.project === ctx.root);
  if (json) {
    console.log(JSON.stringify({ ok: true, fixes, waiting: r.toInstall.map((f) => f.number) }, null, 2));
    return 0;
  }
  if (!fixes.length) {
    console.log('No fixes started from here yet. To start one: nextlevel report (it files the report), then nextlevel fix <its number>.');
    return 0;
  }
  const STATE = {
    started: (f) => `waiting for its pull request to be merged${f.problem ? ` (asking GitHub failed: ${f.problem})` : ''}`,
    merged: (f) => (f.toldReleased ? `in ${f.toldReleased}, not installed: Update on Home (when no hub or worker runs); then the check runs again` : 'merged: it comes with the next release; then the check runs again'),
    fixed: (f) => `fixed: ${f.checkTitles?.join(', ')} ${verb(f.checkTitles?.length || 1, 'passes', 'pass')} since ${String(f.checkedAt).slice(0, 10)} (nextlevel ${f.head})`,
    'still-failing': (f) => `installed (nextlevel ${f.head}), but still failing: ${f.result?.filter((x) => x.status !== 'ok').map((x) => x.detail).join('; ')}`,
    installed: (f) => `installed (nextlevel ${f.head})`,
    closed: (f) => `closed without a fix (${closedHow(f)})`,
    left: (f) => `no longer followed: ${f.note || 'this install moved to another repository'}`,
  };
  console.log('Fixes started from here:');
  for (const f of fixes) {
    console.log(`  #${f.number} ${f.title}`);
    console.log(`      ${f.mode === 'cloud' ? `cloud session ${f.session}` : f.mode === 'local' ? `Claude Code on this PC, in ${f.folder}` : 'to start in the browser (claude.ai/code)'} · started ${String(f.startedAt).slice(0, 10)}`);
    console.log(`      ${(STATE[f.state] || (() => f.state))(f)}`);
  }
  return 0;
}
