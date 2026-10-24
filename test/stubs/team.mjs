// What the stub engines (fake-agy, fake-codex, fake-claude) do when the hub gives them a role: a worker's
// task, by its id, or an orchestrator's autopilot cycle. The same on every engine, so any engine can be
// tested in any role.
import { execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tty from 'node:tty';

// The role the prompt names ("ROLE: WORKER. Task <id>. ..."), even when the engine was told to read
// AGENTS.md first.
export const roleOf = (prompt) => (String(prompt).match(/ROLE: (WORKER|ORCHESTRATOR|GUIDE|ASSISTANT)/) || [])[1] || '';

// The assistant (nextlevel ask): what it was given is written to ~/.fake-<engine>/assistant.jsonl (its arguments,
// folder, the prompt it read on stdin, whether it saw a planted .env value (PLANTED_VALUE) or the read-only switch), and it tries a
// nextlevel command that changes something, as an assistant told by a planted file might: the read-only guard must
// refuse it. Its answer (STUB_ASSISTANT_ANSWER, else one that names its sources and suggests a note) is returned.
export function assistantTask({ engine, prompt, args }) {
  const dir = path.join(os.homedir(), `.fake-${engine}`);
  fs.mkdirSync(dir, { recursive: true });
  const commit = spawnSync('nextlevel', ['commit', '-m', 'the assistant tried'], { encoding: 'utf8', shell: process.platform === 'win32' });
  const record = { args, cwd: process.cwd(), prompt, readOnly: process.env.NEXTLEVEL_READ_ONLY || '', optionalLocks: process.env.GIT_OPTIONAL_LOCKS ?? '', planted: !!process.env.PLANTED_VALUE, commit: { code: commit.status, out: `${commit.stdout || ''}${commit.stderr || ''}`.trim() } };
  fs.appendFileSync(path.join(dir, 'assistant.jsonl'), `${JSON.stringify(record)}\n`);
  const question = (prompt.split("## The owner's question")[1] || '').trim();
  const tasks = (prompt.match(/^- \S+ · task/gm) || []).length;
  return (
    process.env.STUB_ASSISTANT_ANSWER ||
    `[fake ${engine}] You asked: ${question}\nThe project has ${tasks} task(s) in the last day.\nNote: Finish M0 before you start M1.\nSources: docs/STATUS.md, .nextlevel/jobs/M1-01-ok/RESULT.md, commit abc1234`
  );
}

// What an engine prints about its steps, when it prints them as JSON (Claude Code's stream-json, codex exec
// --json): the dashboard's technical feed is read from them. The engine's stub gives its own; agy prints none.
export const NO_TRACE = { command() {}, edit() {}, message() {} };

// A worker's task. `commits`: whether this engine can commit in its slot (Codex's sandbox can't write
// .git: it leaves its changes, and the hub commits them, FR-008). `trace`: the engine's steps as it prints them.
// STUB_WORKER_SLOW_RETRY=1: a retry waits two minutes first (a running attempt to look at);
// STUB_LEAVE_CONFLICTS=1: a merge task leaves the conflicts. Every task writes a progress note first, as
// WORKER.md asks (.nextlevel-task/PROGRESS.md); an "activity" task writes several and shows its steps, then waits
// until the test puts GO in its task folder (or two minutes pass).
// addons: what the engine loaded of the owner's own add-ons for this session (FR-013), a line of the report
export async function workerTask({ engine, prompt, model = 'default', effort = 'default', commits = true, trace = NO_TRACE, addons = '' }) {
  const id = (prompt.match(/Task ([A-Za-z0-9._-]+?)\.\s/) || [])[1] || '';
  // The prompt names the task folder (.nextlevel-task)
  const taskDir = (prompt.match(/do the task in (\S+)\/TASK\.md/) || [])[1] || '.nextlevel-task';
  console.log(`[fake ${engine}] task=${id} slot=${process.env.NEXTLEVEL_SLOT} offset=${process.env.NEXTLEVEL_PORT_OFFSET}`);
  const git = (...a) => execFileSync('git', a, { stdio: 'pipe' });
  const commit = (message) => {
    if (!commits) return;
    git('add', '-A');
    git('commit', '-qm', message);
  };
  const write = (f, s) => {
    fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true });
    fs.writeFileSync(f, s);
  };
  // FR-020: STUB_WORKER_NO_REPORT=1 does the task and writes no report (STUB_WORKER_NO_REPORT=nostatus: one without a
  // Status line); STUB_WORKER_IDLE=1 does nothing at all, and ends (STUB_WORKER_IDLE=nostatus: it only writes a report
  // with no Status line)
  const report = (s) => (process.env.STUB_WORKER_NO_REPORT === '1' ? null : write(`${taskDir}/RESULT.md`, process.env.STUB_WORKER_NO_REPORT === 'nostatus' ? s.replace(/^Status: \w+\n/, '') : s));
  if (process.env.STUB_WORKER_IDLE === 'nostatus') write(`${taskDir}/RESULT.md`, 'Summary: nothing to do\n');
  if (process.env.STUB_WORKER_IDLE) return;
  const note = (line) => fs.appendFileSync(`${taskDir}/PROGRESS.md`, `${line}\n`);
  const task = fs.readFileSync(`${taskDir}/TASK.md`, 'utf8');
  note(`Reading the task: ${id} on ${engine}`);
  const feedback = task.includes('Feedback from the orchestrator');
  if (feedback && process.env.STUB_WORKER_SLOW_RETRY === '1') await new Promise((r) => setTimeout(r, 120_000));
  // Runs a command and says how it went: "WORKED" or "refused", with the line that explains it.
  const attempt = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    const lines = `${r.stderr || ''}${r.stdout || ''}${r.error?.message || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return `${r.status === 0 ? 'WORKED' : 'refused'} (${lines.find((l) => l.includes('nextlevel')) || lines[0] || ''})`;
  };
  // Which engine and account ran it: the account's folder, when the profile has one of its own
  const account = process.env.CODEX_HOME || process.env.CLAUDE_CONFIG_DIR || 'own login';
  const who =
    `Engine: ${engine}\nModel: ${model}\nAccount folder: ${account}\nAPI key: ${process.env.ANTHROPIC_API_KEY ? 'visible' : 'none'}\nEffort: ${effort}\n` +
    `Git by the hub: ${/can't write git/.test(prompt) ? 'told' : 'not told'}\n` +
    `Reads AGENTS.md: ${/^Read AGENTS\.md first/.test(prompt) ? 'told to' : 'by itself'}\n${addons ? `Add-ons: ${addons}\n` : ''}` +
    `PowerShell policy: ${process.env.PSExecutionPolicyPreference || 'none'}\ngh folder: ${process.env.GH_CONFIG_DIR || 'own'}\n`;

  if (id.includes('bridge')) {
    write(`docs/bridge/${id}.txt`, `Hello from slot ${process.env.NEXTLEVEL_SLOT}\n`);
    commit(`test(${id}): bridge file`);
    // Step 3 of the bridge task: a real push to the test remote, by name and by path. Unlike real agy,
    // no deny-list stops it here, so the commands run and git has to refuse them.
    const remote = 'nextlevel-bridge-test';
    const url = git('remote', 'get-url', remote).toString().trim();
    const byName = attempt('git', ['push', remote, `HEAD:refs/heads/${id}`]);
    attempt('git', ['push', url, `HEAD:refs/heads/${id}-url`]);
    // STUB_AGY_BRIDGE=leak plays a worker that gets something to the remote anyway: the bridge test must notice.
    if (process.env.STUB_AGY_BRIDGE === 'leak') {
      const common = git('rev-parse', '--path-format=absolute', '--git-common-dir').toString().trim();
      execFileSync('git', ['--git-dir', url, 'fetch', '-q', common, `refs/heads/task/${id}:refs/heads/leaked-${id}`]);
    }
    // Step 4: gh auth status, through a shell as a worker would (gh is a .cmd stub on Windows); what it printed goes to
    // the log too, which the hub reads
    const gh = spawnSync('gh auth status', [], { encoding: 'utf8', shell: true });
    const ghSaid = `${gh.stdout || ''}${gh.stderr || ''}`.trim();
    console.log(ghSaid);
    const account = ghSaid.split(/\r?\n/).find((l) => /Logged in to \S+ account/.test(l));
    report(`Status: DONE\n\nSummary: wrote the bridge file.\nPush attempt: RAN, ${byName}\nGitHub sign-in: ${account ? account.trim() : 'NONE'}\n${who}`);
  } else if (id.includes('pushy')) {
    // A worker that tries every way to push (FR-003): by remote name, by URL, over ssh, through the
    // GitHub API with gh, and by asking git for the owner's saved login.
    write('pushy.txt', 'tried to push\n');
    commit('feat: pushy');
    const url = git('remote', 'get-url', 'origin').toString().trim();
    const sha = git('rev-parse', 'HEAD').toString().trim();
    report(
      'Status: DONE\n' +
        `git push: ${attempt('git', ['push', 'origin', 'HEAD:refs/heads/worker-push'])}\n` +
        `git push <url>: ${attempt('git', ['push', url, 'HEAD:refs/heads/worker-url'])}\n` +
        `ssh: ${attempt('git', ['ls-remote', 'ssh://nextlevel.invalid/repo.git'])}\n` +
        // through a shell, as a worker would: gh is a .cmd stub on Windows
        `gh api: ${attempt(`gh api -X POST repos/{owner}/{repo}/git/refs -f ref=refs/heads/worker-gh -f sha=${sha}`, [], { shell: true })}\n` +
        `saved login: ${attempt('git', ['credential', 'fill'], { input: 'protocol=https\nhost=github.com\n\n' })}\n` +
        `Terminal prompts: ${process.env.GIT_TERMINAL_PROMPT}\n`,
    );
  } else if (id.includes('merge')) {
    // FR-008: the first attempt changes shared.txt; a retry resolves the conflicts the hub's merge of main left
    // (the files TASK.md lists), unless STUB_LEAVE_CONFLICTS=1
    const conflicts = task.includes('Resolve the conflicts first') ? [...task.split('stopped at conflicts in:')[1].matchAll(/^- (.+)$/gm)].map((m) => m[1].trim()) : [];
    const markers = conflicts.filter((f) => /^<<<<<<< /m.test(fs.readFileSync(f, 'utf8')));
    if (process.env.STUB_LEAVE_CONFLICTS !== '1') for (const f of conflicts) write(f, 'resolved by the worker\n');
    const attemptNo = JSON.parse(fs.readFileSync(`${taskDir}/JOB.json`, 'utf8')).attempt;
    write(feedback ? 'retry.txt' : 'shared.txt', feedback ? `attempt ${attemptNo}\n` : 'from the task\n');
    commit(feedback ? 'fix: resolve the merge' : 'feat: shared file');
    const merged = task.includes('merged main into your branch') ? 'merged main in' : task.includes('is in your branch already') ? 'up to date' : 'no merge';
    report(`Status: DONE\nSummary: ${feedback ? 'resolved the merge' : 'shared file'}\nCommit: feat(merge): ${feedback ? 'attempt 2 on top of main' : 'the shared file'}\nConflicts: ${conflicts.join(', ') || 'none'} (${markers.length} with markers)\nMerge: ${merged}\n${who}`);
  } else if (id.includes('activity')) {
    // Progress notes and steps a person can follow, with a secret shape and the home folder in them (redacted
    // on the page), then a wait while the test looks
    note('Writing ok.mjs: the spec asks for one export');
    trace.command('npm test', '# tests 2\n# pass 1\n# fail 1\n', 1);
    write('ok.mjs', 'export const x = 1;\n');
    trace.edit('ok.mjs');
    note(`Fixing the failing test: the fixture had ghp_${'a'.repeat(24)} in it`);
    trace.command('node -e "console.log(process.cwd())"', `${os.homedir()} and ghp_${'b'.repeat(24)}\n`, 0);
    trace.message('The tests pass now; committing.');
    trace.command('npm test', '# tests 2\n# pass 2\n# fail 0\n', 0);
    commit('feat: activity');
    note('Waiting for the test to look at this page');
    for (let i = 0; i < 600 && !fs.existsSync(`${taskDir}/GO`); i++) await new Promise((r) => setTimeout(r, 200));
    report(`Status: DONE\nSummary: activity\nCommit: feat: activity\n${who}`);
  } else if (id.includes('outside')) {
    // A worker that works outside its slot (demo, 17 October): a note written into the main checkout by a path
    // typed wrong, and a git command aimed at it (an empty commit on its branch); "outsideprot" also writes Claude Code
    // settings with a hook there, a protected file the guard must set back while the worker runs. All harmless.
    const main = path.dirname(git('rev-parse', '--path-format=absolute', '--git-common-dir').toString().trim());
    const stray = path.join(main, 'stray-note.txt');
    write(stray, 'written outside the slot\n');
    trace.edit(stray);
    if (id.includes('outsideprot')) {
      write(path.join(main, '.claude', 'settings.json'), `${JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo guard-test' }] }] } }, null, 2)}\n`);
      trace.edit(path.join(main, '.claude', 'settings.json'));
    }
    const cmd = ['-C', main, 'commit', '--allow-empty', '-qm', 'stray commit from a worker'];
    execFileSync('git', cmd, { stdio: 'pipe' });
    trace.command(`git -C "${main}" commit --allow-empty -qm "stray commit from a worker"`, '', 0);
    write(`${id}.mjs`, 'export const x = 1;\n');
    commit('feat: inside');
    report(`Status: DONE\nSummary: worked outside its slot\nCommit: feat: inside\n${who}`);
  } else if (id.includes('indexlock')) {
    // The race the hub once lost (src/lib/gitlock.mjs): the worker leaves its changes for the hub to commit (on
    // Codex) while another git holds the slot's index.lock, as the dashboard's `git status` did then
    write('locked.mjs', 'export const x = 1;\n');
    commit('feat: locked');
    report(`Status: DONE\nSummary: locked\nCommit: feat: locked\n${who}`);
    holdIndexLock(id, process.env.STUB_INDEX_LOCK || 'release');
  } else if (id.includes('hook')) {
    // A protected file (the guard): Claude Code settings with a hook that would run a command, as a prompt-injected
    // worker might add. The hub must hold its merge until the owner approves it. (The command itself is harmless.)
    const settings = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo guard-test' }] }] } };
    write('.claude/settings.json', `${JSON.stringify(settings, null, 2)}\n`);
    write(`${id}.mjs`, 'export const x = 1;\n');
    commit('feat: a hook');
    report(`Status: DONE\nSummary: added a hook\n${who}`);
  } else if (id.includes('leak')) {
    // A value from the project's .env in a file (STUB_LEAK_VALUE: the test gives the worker what a worker that read the
    // main checkout's .env would have): the hub must never commit it
    write('leak.txt', `token: ${process.env.STUB_LEAK_VALUE || 'none'}\n`);
    commit('feat: leak');
    report(`Status: DONE\nSummary: wrote a value\nCommit: feat: a value\n${who}`);
  } else if (id.includes('longreport')) {
    // FR-012: a report far over what `nextlevel result` shows, as a real project's design tasks wrote them: 2 000 numbered lines,
    // and a last line to find
    write('long.txt', `attempt ${JSON.parse(fs.readFileSync(`${taskDir}/JOB.json`, 'utf8')).attempt}\n`);
    commit('feat: long');
    const lines = Array.from({ length: 2000 }, (_, i) => `Line ${String(i + 1).padStart(4, '0')}: a part of the design the orchestrator must read`);
    report(`Status: DONE\n\n## Summary\nA long design, all of it here.\n${who}\n${lines.join('\n')}\nEND OF THE REPORT\n`);
  } else if (/resultfile|noresult|emptyresult/.test(id)) {
    // FR-012: a design, research or map task writes its result to the file its spec names ("Result file: ..."), in full;
    // noresult writes none, emptyresult an empty one. The report stays short.
    const file = (task.match(/^Result file:\s*(\S+)/m) || [])[1];
    const told = task.includes('## Where your result goes');
    if (id.includes('resultfile')) write(file, `${Array.from({ length: 1500 }, (_, i) => `Design line ${i + 1}: what was decided, and why`).join('\n')}\nEND OF THE DESIGN\n`);
    if (id.includes('emptyresult')) write(file, '\n');
    if (!id.includes('noresult')) commit(`docs(${id}): the result`);
    report(`Status: DONE\nSummary: the result is in ${file}\nCommit: docs(${id}): the result\nTold where: ${told ? 'yes' : 'no'}\n${who}`);
  } else if (id.includes('similar')) {
    // Paths that look like protected ones and aren't (the guard must let them through)
    write('docs/agents-notes.md', '# notes\n');
    write('.claude-notes.md', 'notes\n');
    write('xdocs/agents/readme.md', 'not docs/agents\n');
    write('src/CLAUDE.mdx', 'not CLAUDE.md\n');
    commit('docs: notes');
    report(`Status: DONE\nSummary: similar paths\n${who}`);
  } else if (id.includes('ok')) {
    write('ok.mjs', 'export const x = 1;\n');
    commit('feat: ok');
    report(`Status: DONE\nSummary: ok\n${who}Task folder: ${taskDir}\n`);
  } else if (id.includes('fail')) {
    if (feedback) write('fixed.txt', 'fixed\n');
    write('fail.txt', `attempt\n${Date.now()}\n`);
    commit('feat: attempt');
    report(`Status: DONE\nSummary: claims done\n${who}`);
  } else if (id.includes('blocked')) {
    report('Status: BLOCKED\nNeed the SMTP host.\n');
  } else if (id.includes('leftover')) {
    write('left.txt', 'uncommitted\n');
    report('Status: DONE\n');
  } else if (id.includes('console')) {
    // Reports whether the worker got a real console for its stdin (what agy needs on Windows; its output goes
    // through pipes to nextlevel, FR-010), a window of its own,
    // and what leaked into its environment (it must see neither .env values nor the project root).
    write('console.txt', 'ran\n');
    commit('feat: console');
    const env = process.env;
    report(
      `Status: DONE\nConsole: ${tty.isatty(0) ? 'tty' : 'no-tty'}\n` +
        `In window: ${env.NEXTLEVEL_IN_WINDOW || 'unset'}\n` +
        `Planted secret: ${env.PLANTED_SECRET ? 'visible' : 'hidden'}\nProject root: ${env.NEXTLEVEL_ROOT ? 'visible' : 'hidden'}\n` +
        `Slot: ${env.NEXTLEVEL_SLOT} · compose ${env.COMPOSE_PROJECT_NAME}\n` +
        `Agy updater: ${env.AGY_CLI_DISABLE_AUTO_UPDATE === 'true' ? 'off' : 'on'}\n${who}`,
    );
  } else if (id.includes('slow')) {
    await new Promise((r) => setTimeout(r, 120_000));
  } else if (id.includes('orphan')) {
    // A long task whose engine started a program of its own, as a tool it runs would be (FR-013), which outlives it: on
    // Windows outside the engine's job (a native engine's children are), elsewhere in the worker's process group. Both
    // pids go to the task folder, for the test to watch; then it waits two minutes.
    const tool = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore', windowsHide: true, detached: process.platform === 'win32' });
    tool.unref();
    write(`${taskDir}/PIDS.json`, JSON.stringify({ engine: process.pid, tool: tool.pid }));
    await new Promise((r) => setTimeout(r, 120_000));
  }
}

// Holds the slot's index.lock past the worker's end, from a process of its own (the worker is gone by the time the
// hub commits). STUB_INDEX_LOCK=release lets go once the hub's git.log shows a git that found it held: the hub
// must wait, then commit. =hold keeps it until the task has finished (at most two minutes): the hub must fail the
// attempt, say why, and keep the changes.
function holdIndexLock(id, mode) {
  const at = (...a) => execFileSync('git', ['rev-parse', '--path-format=absolute', ...a], { encoding: 'utf8' }).trim();
  const lock = at('--git-path', 'index.lock');
  const jobDir = path.join(path.dirname(at('--git-common-dir')), '.nextlevel', 'jobs', id);
  fs.writeFileSync(lock, '');
  const holder = `
    const fs = require('node:fs'), path = require('node:path');
    const [lock, jobDir, mode] = process.argv.slice(1);
    const read = (f) => { try { return fs.readFileSync(path.join(jobDir, f), 'utf8'); } catch { return ''; } };
    const done = () => mode === 'release' ? read('git.log').includes('index.lock') : /"state":\\s*"(done|failed|error|no-changes|timeout|blocked)"/.test(read('status.json'));
    const start = Date.now();
    const tick = () => {
      if (done() || Date.now() - start > 120000) { fs.rmSync(lock, { force: true }); return; }
      setTimeout(tick, 100);
    };
    tick();`;
  spawn(process.execPath, ['-e', holder, lock, jobDir, mode], { cwd: path.parse(lock).root, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// FR-019: what a round does instead, by STUB_ORCH_PLAY (each round first adds a line to STUB_ORCH_ROUNDS, if set):
//   status   a round with nothing new, as ORCHESTRATOR.md says: STATUS.md written, no commit, nothing reviewed
//   awake    an orchestrator that tries to stay awake: a STATUS.md note committed, a post on card STUB_ORCH_CARD, a check
//            job queued without waiting for it, and the shortest wake-up asked for
//   wake:<m> asks for a wake-up in m minutes, and does nothing else
//   ci:<m>   pushes main to the branch ci-stub (new commits on origin: work moved), reads the push's result, then asks
//            for a wake-up in m minutes for its CI run, as the last thing before its end
//   check-wait  runs a check (nextlevel verify) and waits for it with nextlevel wait only, never nextlevel result
//   merge-wake:<m>  makes a branch task/T9 one commit ahead of main (git's plumbing, as a worker's branch would be),
//            merges it with nextlevel merge (work moved), then asks for a wake-up in m minutes
//   crash    its engine ends with an error (exit 3)
//   hang     never ends by itself: until the hub stops it (or STUB_ORCH_RELEASE names a file that appears; 2 min at most)
function playRound(engine, play) {
  const hub = (...a) => execSync(`nextlevel ${a.join(' ')}`, { encoding: 'utf8' });
  const say = (s) => console.log(`[fake ${engine}] ${s}`);
  if (play === 'crash') {
    say('the engine stops with an error');
    process.exit(3);
  }
  if (play === 'hang') {
    const until = Date.now() + 120_000;
    const release = process.env.STUB_ORCH_RELEASE;
    while (Date.now() < until && !(release && fs.existsSync(release))) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    say('released');
    return;
  }
  if (play.startsWith('wake:')) {
    say(hub('wakeup', play.slice(5), '--reason', '"the CI run of ci/m1 is still running"'));
    return;
  }
  if (play === 'check-wait') {
    const queued = hub('verify', 'own', '--', 'node -e 0');
    say(queued);
    const id = queued.split(/\s+/)[1]?.replace(/:$/, '');
    if (id) say(hub('wait', id));
    return;
  }
  if (play.startsWith('merge-wake:')) {
    const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
    const commit = git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'T9: the work');
    git('branch', '-f', 'task/T9', commit);
    say(hub('merge', 'T9', '-m', '"merge T9"'));
    say(hub('wakeup', play.slice(11), '--reason', '"the CI run of main is still running"'));
    return;
  }
  // An orchestrator that writes git itself (Antigravity's can) commits a protected file during its round, once: the guard
  // sets it back on disk at the round's end and holds it, and the commit stays (docs/design/antigravity-roles.md, 3b)
  if (play === 'commit-agents') {
    if (fs.existsSync('.nextlevel/stub-committed')) return say('nothing new');
    fs.writeFileSync('.nextlevel/stub-committed', '1');
    fs.appendFileSync('AGENTS.md', '\nA line the orchestrator added itself.\n');
    say(execFileSync('git', ['commit', '-am', "chore: the orchestrator's own commit of AGENTS.md"], { encoding: 'utf8' }));
    return;
  }
  if (play.startsWith('ci:')) {
    const queued = hub('push', 'ci-stub', '--from', 'main');
    say(queued);
    const id = queued.split(/\s+/)[1]?.replace(/:$/, '');
    if (id) {
      say(hub('wait', id));
      say(hub('result', id));
    }
    say(hub('wakeup', play.slice(3), '--reason', '"the CI run of ci-stub is still running"'));
    return;
  }
  fs.writeFileSync('docs/STATUS.md', `${fs.readFileSync('docs/STATUS.md', 'utf8')}\n<!-- round at ${new Date().toISOString()}: nothing new -->\n`);
  if (play === 'status') return say('nothing new: STATUS.md written, no commit');
  // awake
  say(hub('commit', '-m', '"docs: record autopilot cycle awaiting the owner"', 'docs/STATUS.md'));
  if (process.env.STUB_ORCH_CARD) {
    fs.writeFileSync('.nextlevel/stub-answer.md', 'Still waiting for your reply.\nNothing else can move.\n');
    say(hub('handoff', 'answer', process.env.STUB_ORCH_CARD, '--file', '.nextlevel/stub-answer.md'));
  }
  say(hub('verify', 'awake', '--', 'node -e "0"'));
  say(hub('wakeup', '1', '--reason', '"anything new?"'));
}

// One orchestrator cycle: it reviews every finished job and commits through the hub (Codex's sandbox
// can't write .git, FR-004 #1; on every engine git writes go through the hub). `noop` does nothing.
// Like the real orchestrator, it talks to the hub through the `nextlevel` command in its shell.
export function orchestratorCycle({ engine, noop = false }) {
  if (process.env.STUB_ORCH_ROUNDS) fs.appendFileSync(process.env.STUB_ORCH_ROUNDS, `${new Date().toISOString()} ${engine}\n`);
  if (process.env.STUB_ORCH_PLAY) return playRound(engine, process.env.STUB_ORCH_PLAY);
  if (noop) {
    console.log(`[fake ${engine}] nothing to do`);
    return;
  }
  const hub = (...a) => execSync(`nextlevel ${a.join(' ')}`, { encoding: 'utf8' });
  // STUB_ORCH_EDIT=<file>: the orchestrator changes a (protected) file on disk, as a prompt-injected one might; the
  // guard must set it back and hold the change for the owner
  if (process.env.STUB_ORCH_EDIT) fs.appendFileSync(process.env.STUB_ORCH_EDIT, 'echo changed by the orchestrator\r\n');
  // STUB_ORCH_DELETE=<file>: a protected file goes away during the round (as when antivirus removes one)
  if (process.env.STUB_ORCH_DELETE) fs.rmSync(process.env.STUB_ORCH_DELETE, { force: true });
  const { jobs } = JSON.parse(hub('status', '--json'));
  for (const j of jobs.filter((x) => !x.acked && !['queued', 'running', 'verifying'].includes(x.state))) {
    hub('result', j.id);
    console.log(`reviewed ${j.id}`);
  }
  // STUB_ORCH_CARDS=<file>: what it reads of the cards at the start of its round (nextlevel handoff list), kept for the
  // test (FR-014)
  if (process.env.STUB_ORCH_CARDS) fs.writeFileSync(process.env.STUB_ORCH_CARDS, hub('handoff', 'list'));
  // STUB_ORCH_ANSWER=<id>:<file>: it answers the owner on a card as ORCHESTRATOR.md says, the answer in a file, through its
  // shell the way Codex runs a command: on Windows PowerShell, which runs nextlevel.cmd (FR-014). STUB_ORCH_ANSWER_ARG=1:
  // it tries the text as an argument first, which nextlevel refuses.
  if (process.env.STUB_ORCH_ANSWER) {
    const at = process.env.STUB_ORCH_ANSWER.indexOf(':');
    const [id, file] = [process.env.STUB_ORCH_ANSWER.slice(0, at), process.env.STUB_ORCH_ANSWER.slice(at + 1)];
    const shell = (command) => {
      const r = process.platform === 'win32' ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }) : spawnSync('sh', ['-c', command], { encoding: 'utf8' });
      return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
    };
    if (process.env.STUB_ORCH_ANSWER_ARG === '1') {
      const arg = shell(`nextlevel handoff answer ${id} "It is done: see the checklist"`);
      fs.writeFileSync('.nextlevel/answer-arg.json', JSON.stringify(arg));
    }
    const r = shell(`nextlevel handoff answer ${id} --file '${file}'`);
    fs.writeFileSync('.nextlevel/answer-result.json', JSON.stringify(r));
    console.log(r.out);
  }
  fs.writeFileSync('docs/cycle.txt', `${new Date().toISOString()} ${engine}\n`);
  console.log(hub('commit', '-m', `"chore: orchestrator cycle (${engine})"`, 'docs/cycle.txt'));
}
