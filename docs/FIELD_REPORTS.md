# Field reports

Problems hit on real machines. Each item gets fixed by a check (and a fix, and a test) in M2 or later;
note the check id here when it lands. `docs/CHECKS.md` explains each check; `test/checks.test.mjs`
tests each one on a fake PC.

## FR-001 — Owner's PC, Windows 11, first real setup (2026-09-25)
Tools: Node 24.19.0, Git 2.55.0.windows.3, gh 2.96.0, Docker 29.7.2, Codex CLI 0.152.0 (ChatGPT
login), Antigravity CLI 1.1.16.

1. **Kit unzipped into a subfolder** (`...\files\acme-starter`) instead of the repo root. The doctor
   reported "no origin remote" and "Branch (none)", which pointed at the wrong fix. Needed: detect
   "not at the root of the project's git repo" and say which folder to use. M1/M3 remove unzipping.
   *M1: nextlevel works on the git root from any subfolder; outside a repo it says so, names project
   folders just below, and gives the commands. M3: the tool is installed with one command (a clone,
   nothing to unzip); a folder in its place that isn't a clone is moved aside.* **Checks: `project.folder`** (the doctor runs outside a
   repo too, checks the tools and says where the project is; from a subfolder it names the top folder),
   **`project.config`** (nextlevel files found in a subfolder instead of the top folder).
2. **Repo had no commits** (unborn branch); branch shown as "(none)". Needed: detect it and offer the
   first commit. *M1: the doctor shows "Commits: none yet" with the commands, the branch keeps its
   name, and `dispatch`/`bridge-test` stop with the same fix.* **Check: `git.commits`**; `doctor --fix`
   makes the first commit once the git identity is set and `.gitignore` ignores `.env`
   (`project.gitignore`).
3. **Git identity probably missing** on a fresh machine, so the first commit fails. Needed: check
   `user.name`/`user.email`, guide setting them. **Check: `git.identity`** (`git var GIT_AUTHOR_IDENT`
   fails exactly when a commit would; the menu's doctor asks for name and email and sets them).
4. **Antigravity CLI 1.1.16** — older than the flags we use. Needed: minimum version, `agy update`,
   and a note that a new window is needed afterwards. **Check: `tool.agy`** (minimum 1.2.4; `--fix` runs
   `agy update`; the next step is `nextlevel doctor` in a new PowerShell window). Every tool has its
   minimum and update command in `src/checks/tools.mjs`.
5. **`CODEX_MODEL=gpt-6-sol` rejected** for a ChatGPT-account login. Needed: default to Codex's own
   model choice; validate a pinned model before starting sessions. *M1: the default model is empty
   (Codex's own choice).* **Check: `codex.model`** (one cached one-line `codex exec` per model and
   login); the hub runs it before the orchestrator, the Codex setup guide and each autopilot cycle, and
   stops or pauses with the fix. **`agy.model`** does the same for agy against `agy models`.
6. **Unrelated broken MCP server** in the user's Codex config warns on every start. Needed:
   surface it as informational so it isn't mistaken for our failure. **Check: `codex.mcp`** (info:
   servers in `~/.codex/config.toml` whose command isn't installed, with the section to fix).
7. **npm skipped Claude Code's install script** ("not yet covered by allowScripts"). Needed: install
   with `--allow-scripts=@anthropic-ai/claude-code` and verify `claude --version`. **Check:
   `tool.claude`** (runs `claude --version`; installed-but-not-running is told apart from missing; the
   install command has the flag).
8. **A Claude Code slash command was typed into PowerShell** (`/web-setup`). Needed: every instruction
   says which window to type it in; the dashboard labels commands by window. **Covered by the check
   format, not one check:** every step a check gives names its window (PowerShell, a new PowerShell
   window, Browser, Text editor, Start menu, Your phone, Inside Codex / agy / Claude Code), the doctor
   prints it and `--json` carries the label for the dashboard. A test fails if any step lacks a known
   window or puts a slash command outside the tool that runs it. *M4: the dashboard's Setup page shows
   each step with its window as a label and a Copy button; installs and sign-ins stay commands for the
   owner's own window, and Fix buttons appear only for fixes that need none.*
9. **PowerShell opened as Administrator** in `C:\Windows\system32`. Needed: warn when elevated or when
   running from a system folder. **Checks: `window.elevated`** (integrity level from `whoami /groups`,
   the same in every Windows language), **`window.folder`**.
10. **Deny-list question appeared again** after answering yes (unconfirmed — the output may have been
    pasted twice). Needed: verify the settings write persisted and say so explicitly. **Check:
    `agy.deny-list`**: after writing, the fix reads the file back and says "Saved the 18 rules in ... and
    read them back: they are all there", or which are missing; the doctor checks again and doesn't ask
    once they are there.

## FR-002 — Claude Code cloud sessions for this repo, M0 (2026-09-25)
1. **Cloud sessions couldn't push.** Two sessions were started with `claude --cloud "..."` in
   PowerShell before the owner's Claude account was connected to GitHub. Each got an uploaded copy of
   the folder without a git remote, did the M0 work, and couldn't push a branch or open a pull request,
   so the work had to be redone. Starting the session from claude.ai/code with the repo selected fixed
   it. Needed: before anything starts a cloud session (`nextlevel fix`, M5), check that the Claude
   account can reach the repo on GitHub; if not, say what is missing and where to fix it (browser:
   https://claude.ai/connect-github, and the Claude GitHub App installed on the repo). **Check:
   `claude.github`**: the tool's folder must have a GitHub remote (else a session gets a copy it can't
   push); the Claude side can't be seen from the PC, so the browser steps are shown and the owner
   confirms them once in the menu's doctor. `nextlevel fix` (M5) must require this check. *M5: it
   does: without it, `nextlevel fix` asks the owner to confirm the two browser steps, or offers Claude Code
   on the PC (`--local`) or the steps to start the session at claude.ai/code, and never starts a cloud
   session that couldn't push.*

## FR-003 — Owner's PC, M1 owner check: workers could push (2026-09-25)
Tools: Windows 11, Antigravity CLI 1.2.11.

1. **agy's deny-list didn't stop `git push`.** The doctor said "Worker safety rules: safety rules
   present" (the deny-list was in `~/.gemini/antigravity-cli/settings.json`), yet both bridge workers
   reported `Push dry run: RAN`. Workers run with `--dangerously-skip-permissions` (headless mode
   stalls on prompts otherwise), and in 1.2.11 the `permissions.deny` rules didn't stop the command.
   We don't know whether that flag skips deny rules too or the rule syntax no longer matches; either
   way nothing may depend on agy's rule engine.
   *Fixed: git refuses pushes from worker slots. Each slot has its own git config
   (`extensions.worktreeConfig`) that gives every remote a push URL that fails, rewrites any other push
   URL to it, clears credential helpers and points hooks at a folder whose `pre-push` refuses. Workers
   also get `GIT_TERMINAL_PROMPT=0`, a refusing `GIT_SSH_COMMAND`, a dummy `GH_TOKEN`/`GITHUB_TOKEN` and
   the same git settings through `GIT_CONFIG_PARAMETERS`. The hub reads the slot's push URLs back and
   won't start a worker if one still works. The deny-list stays as an extra layer, now with `command(gh)`.*
2. **The bridge test said "Bridge works" anyway and deleted the evidence.** It trusted the workers'
   reports, printed a warning for `RAN`, then removed the job records and branches.
   *Fixed: the bridge test adds a temporary local bare remote, the workers try a real push to it, and
   the hub checks the remote itself. If anything arrived, the test fails and keeps the job records,
   branches and test remote.*
3. **"Safety rules present" read as "workers are safe".** The doctor only saw that the rules were in
   the settings file. *Fixed: it says the deny-list is configured, not proven, and points to the
   bridge test.*

**Checks: `agy.deny-list`** (the deny-list, "configured (not proof it works)"), **`bridge.test`** (the
last bridge test's verdict, kept in `.nextlevel/bridge-test.json`: a push that arrived is an error; not
run, or run with an older worker CLI than the one installed now, asks for a run), **`slots.push-lock`**
(a shared `pushurl` that Git older than 2.46 can't switch off in slots).

## FR-004 — Owner's PC, real use on a real project: Codex orchestrator in its sandbox (2026-09-25)
Tools: Windows 11, Codex CLI 0.152.0 at first (ChatGPT login), Antigravity CLI workers, nextlevel after M4.

1. **Codex's sandbox refuses writes to `.git`** (`index.lock: Permission denied`), so every commit and
   merge the orchestrator made needed the owner's approval, and autopilot couldn't work at all. Codex
   keeps `.git` read-only under `workspace-write` on every OS (codex-rs `PROTECTED_METADATA_PATH_NAMES`).
   *Fixed: the orchestrator's git writes are hub commands. `nextlevel commit -m "..." [<path>...]`,
   `nextlevel merge <task-id>` and `nextlevel cleanup <task-id>` queue a `git` job that the hub runs in
   the main checkout, outside the sandbox (its own lane, one at a time, each git command logged in
   `jobs/<id>/git.log` and `hub.log`); the command waits and prints the result. A merge conflict undoes
   the merge and says what to retry. The orchestrator template says never to run git writes itself.*
   **Check: `project.role-docs`** (role docs copied from an older template, which still say `git merge`:
   an unchanged one is replaced by the fix; one of the owner's own points at `nextlevel init`).
2. **`nextlevel doctor` inside Codex's sandbox** falsely reported gh signed out and Docker, Codex and agy
   unavailable. The sandbox hides the owner's sign-ins, programs and network.
   *Fixed: the doctor detects the sandbox (`CODEX_SANDBOX`, `CODEX_SANDBOX_NETWORK_DISABLED`,
   `SBX_NONET_ACTIVE`, or a `.git` it can't write when Codex ran it) and says so; failures it can't see
   from there show as "can't tell", network checks don't run, and no fix writes outside the project.
   The orchestrator runs it through the hub (`nextlevel verify doctor -- nextlevel doctor`), and the hub
   and the bridge test refuse to start in the sandbox.* **Check: `window.sandbox`**; the runner's
   handling is in `src/checks/index.mjs` (`sandbox: 'same' | 'skip'`).
3. **Codex CLI 0.152 couldn't list GPT-6 models, and Codex's own default model** (`model` in
   `~/.codex/config.toml`) was rejected for a ChatGPT login while the doctor said "Codex's own choice".
   *Fixed: the version is compared with the latest release, and the model check tries the model Codex
   will actually use: a pinned one, else `model` in its config.toml, else the account's default. The
   hub checks it before every orchestrator session.* **Checks: `codex.version`** (Codex's own
   `version.json`, else `npm view @openai/codex version`; `--fix` updates it in the owner's window),
   **`codex.model`**.
4. **Codex printed "Hook failed, exit 1" around every tool call**: a Codex hook ran a command that
   wasn't there. *Fixed like broken MCP servers (FR-001 #6):* **Check: `codex.hooks`** (hooks from
   `hooks.json` and `[hooks]` in `config.toml` of the user's, the project's and the PC's Codex folders,
   and from plugins; a program that isn't found, Python's Microsoft Store placeholder, or a script path
   that isn't there).
5. **Phones turn "HANDOFF.md" into a link to a random website** (`.md` is a country's domain), and the
   notification didn't say what the owner had to do. *Fixed: a notification never carries a bare `.md`
   file name: it becomes a link to the file on GitHub when the project is there, else loses its `.md`
   (`src/lib/phone.mjs`, applied in `notify()` itself). One that mentions the handoff file carries its
   open items, and the orchestrator template says to put the request itself in the message.* No check:
   every notification goes through it.
6. **Codex warned "running without the shared background server"** because nextlevel passed
   `-c sandbox_workspace_write.network_access=true`. Recent Codex (0.157) runs interactive sessions in a
   shared background server, and a `-c` (or `--profile`) setting override keeps a session out of it. *Fixed: the default
   arguments have no `-c` (the orchestrator needs no network: the hub has it).* **Check: `codex.args`**
   (a `-c` in `engines.codex.args` of an older `nextlevel.json`; the fix takes it out).
7. **Worker slot port offsets collided between projects on one PC**: every project's slots got 100, 200,
   .... *Fixed: each project gets a block of offsets that no other project on the PC has
   (`~/.nextlevel/state.json`, "portBlocks"; slot n of block b gets b × 1000 + n × 100, and the first
   project keeps 100, 200, ...).* **Check: `slots.ports`**.
8. **In interactive mode the orchestrator stopped after dispatching** and needed a nudge. *Fixed: its
   prompt and template say to keep going until something needs the owner (wait with `nextlevel wait
   --any`, review, merge, dispatch; never end the turn only to report progress), `dispatch` and `wait`
   say what's next, and if finished jobs still wait 15 minutes for review the hub asks the owner once,
   on the phone, to type "continue" in the orchestrator's window.* No check: behaviour of the
   orchestrator; the `project.role-docs` check brings an older template up to date.

## FR-005 — Owner's PC, `nextlevel init` on a real project replaced its own .env.example (2026-09-26)
1. **`nextlevel init` offered to replace a real project's own `.env.example` with the generic
   template, and the owner said yes.** Init treated `.env.example` like the team files (roles, task
   template), which follow the template, so it showed a diff and asked; a "yes" swapped the project's
   own list of keys for the generic one. A project fills that file with its own keys, like `BRIEF.md`
   with its brief. *Fixed: once `.env.example` differs from every template nextlevel has shipped (their
   hashes are in `src/lib/templates.mjs`), init treats it as the project's own and never offers to
   replace it; one that is still an unchanged older template is offered as before (nothing of the
   project's is in it). When the project's own has no `NTFY_TOPIC` line, init says to add one.*
   **Check: `project.env-example`**: `.env.example` is a nextlevel template now while git has a version
   of the project's own before it (the replacement, committed or not); `--fix` puts that version back.


## FR-006 — Owner's PC, M5 owner check: report and fix (2026-09-26)
Tools: Windows 11, Claude Code 2.1.282.

1. **`nextlevel fix` stopped with "Error: --cloud cannot be combined with --print."** The report worked
   (issue #9 filed, clean contents; only a test report, closed since), but the fix ran
   `claude -p --output-format json --cloud "<prompt>"`, and Claude Code 2.1.282 starts a new cloud
   session only interactively (with `-p`, `--cloud` only sends a message to an existing session). Plain
   `claude --cloud "<prompt>"` in PowerShell had worked earlier that day and printed three lines:
   `Created cloud session: <title>`, `View: https://claude.ai/code/session_...` and
   `Resume with: claude --teleport session_...`. That form needs a terminal too: with its output in a
   pipe, which is how a program reads it, Claude Code refuses ("Error: --cloud requires an interactive
   terminal", seen on 2.1.283), and in a terminal it may ask the owner something first (whether to trust
   the folder, say).
   *Fixed: `nextlevel fix` runs `claude --cloud "<prompt>"` in the owner's own window (from the tool's
   clone, as before), so Claude Code's questions and its three lines appear there. A terminal can't be
   read back, so nextlevel takes the session from Claude Code's debug log (`--debug-file`, in a temporary
   folder removed afterwards): the line it writes once the session is created has the id the View line
   shows, and "Started:" repeats that link. Without that line nextlevel says it can't tell and never
   claims a session. The dashboard has no terminal: its "File it and fix it" gives the command for
   PowerShell (`nextlevel fix <n>`, in the project folder) and the browser way.* No check: this is how
   nextlevel starts the session, not something on the PC. The claude stub answers like 2.1.282 (it
   refuses `-p` with `--cloud`, and output that isn't a terminal), so `test/fix.test.mjs` fails if
   `nextlevel fix` goes back to either.
2. **The report said the checks' steps "did not fix them"**, though the owner had not tried them, and
   some of those checks had automatic fixes. *Fixed: `nextlevel report` first offers the doctor's
   automatic fixes for the checks it would report, each asked as the menu's doctor asks, and reports
   only what they don't fix. The text says only what nextlevel knows: for a check with an automatic fix,
   that it ran just before and the check still fails, that the owner declined it, or the command for it
   (the dashboard's report, whose page offers the check's Fix button first).* No check: how the report
   is made; `test/report.test.mjs` covers it.
3. **"5 checks ... still fails"**: the message after a fix named every check of the report with a
   singular verb. *Fixed: it names the checks that still fail, and the verb agrees ("still fail",
   "pass now"), in the notification, `nextlevel fix` and the dashboard.* No check: wording.
4. **A report closed by hand counted as fixed.** The owner closed #9 (a test report) as completed, GitHub's
   default. The fix loop took any issue closed as completed for a merged fix, so it "installed" it, ran
   #9's five checks again and sent "... still fails". *Fixed: only an issue a merged pull request closed
   has a fix. The loop reads what closed it (the close event's closer, through `gh api graphql`); by hand,
   as completed or not, or by a commit, it is "closed without a fix (as completed, not by a pull request)",
   said once, and nothing is installed or checked again.* No check: how the loop reads GitHub;
   `test/fix.test.mjs` covers it (the gh stub answers with what closed an issue).

## FR-007 — Owner's PC, the doctor after real use (2026-09-26)
1. **`bridge.test` said "not run yet" although bridge tests had run.** The hub's log showed the
   bridge test's tasks (`started T000-bridge-1 ...`), but they ran before nextlevel kept the bridge test's
   verdict in `.nextlevel/bridge-test.json`, so the doctor found no verdict and said the test had never
   run. *Fixed: without a verdict, `bridge.test` looks in the hub's log; if the bridge test's tasks are
   there it says it ran, on which day, and to run it again for a saved verdict (still a warning: the log
   doesn't say whether anything reached the test remote).* Check: `bridge.test`;
   `test/checks.test.mjs` covers it.

## FR-008 — Owner's PC, real use on a real project M0: a Codex worker can't write git in its slot (2026-09-26)
Tools: Windows 11, Codex CLI (ChatGPT login) as the workers' fallback, Antigravity CLI workers, nextlevel after M9.

1. **A Codex worker couldn't merge or commit in its slot.** Twice the orchestrator escalated a retry with
   `--engine codex`, and its feedback asked to merge `main` first. Codex's sandbox keeps the worktree's git
   folder read-only (a slot's is in the main checkout, `.git/worktrees/<slot>`), so `git merge main` failed
   with "Unable to create .../.git/worktrees/w1/ORIG_HEAD.lock: Permission denied", commits failed too, and
   both attempts were wasted. *Fixed: the hub does the git steps around a worker whose engine can't write
   git (`gitByHub`: Codex, unless its arguments turn the sandbox off). Before a retry whose feedback asks to
   merge the base branch, and before every retry on such an engine, the hub merges the base branch into the
   task branch in the slot (`git merge --no-ff`, with the worker's environment); a conflict stays in the slot
   and `TASK.md` lists the files for the worker to resolve (no git needed), anything else that stops the
   merge is undone and said. When the worker finishes the hub commits what it left, with the message the
   worker put in its report (`Commit: ...`); a merge is committed only once no file has conflict markers
   (else the job fails, says which files, and keeps the worker's changes in `unresolved.diff`). Every command
   is in `jobs/<id>/git.log` and `hub.log`. The worker's prompt, `TASK.md` and `WORKER.md` tell it not to run
   git writes.* No check: how the hub runs a worker; `test/hub.test.mjs` covers it (the Codex stub can't
   commit, and resolves the conflicts the hub hands it).
2. **The escalation named an engine.** The orchestrator retried with `--engine codex`, as the project's own
   orchestrator doc said, instead of the workers' fallback the owner chose in `nextlevel.json`. *Fixed: the
   template says to escalate with `retry <id> --fallback` (`roles.worker.fallback`) and not to pick an engine
   unless the owner or the spec asks.* **Check: `project.role-docs`**: the M6 orchestrator doc and the FR-003
   worker doc are older templates now (the doctor puts the current ones in place), and an orchestrator or
   guide doc of the owner's own that retries with `--engine <name>` is pointed at `nextlevel init`.
3. **The dashboard showed the previous attempt's log under the running one.** The attempts of a task share
   `worker.log`; a new attempt (or one in a window of its own, which writes nothing there) showed the end of
   the last one. *Fixed: the hub notes where each attempt's output starts (`logFrom` in `status.json`), and
   the Build page and a job's details show only that attempt's part, named "worker.log · attempt N".*
4. **Why a job ran on its engine wasn't recorded**, and the day's numbers had Codex's tokens only. *Fixed:
   every task records why (`engineWhy`: the worker role's, the spec's line, the orchestrator's `--engine`
   or `--fallback`, as the attempt before, or an automatic fallback with the check that caused it: a task
   on the worker role goes to the role's fallback when the role's engine can't start). `nextlevel result`
   says it; Home lists "Fallbacks and engine switches" (tasks on another engine than the workers', autopilot
   rounds on the orchestrator's fallback). Home's "Today" counts per role (autopilot rounds, the
   orchestrator's window, workers, the setup guide) and per engine: runs, minutes, and tokens where the
   engine reports them: Codex's "tokens used" and its session files for its interactive windows, Claude
   Code's JSON output (headless runs now ask for it); Antigravity's JSON output has a `usage` object, but on
   Windows its output is in a console window nextlevel can't read, and its `--log-file` has no counts, so it
   says "not reported".* No check; `test/team.test.mjs`, `test/dashboard.test.mjs` and
   `test/engines.test.mjs` cover it.

## FR-009 — Owner's PC, real use on a real project: a Codex worker on Windows can't use Docker or npm's shims (2026-09-26)
Tools: Windows 11, Codex CLI (ChatGPT login) as the workers' fallback, Antigravity CLI workers, nextlevel after FR-008.

1. **A Codex worker blocked on a real task although the hub now did its git.** In Codex's sandbox on Windows
   the worker was denied the Docker pipe and `~/.docker/config.json`, and PowerShell refused the `.ps1` shims
   npm installs (`pnpm.ps1`: "running scripts is disabled on this system"), so it could neither start the
   project's services nor run its package scripts. *Fixed: a Codex worker on Windows is told in its prompt to
   run `pnpm.cmd`, `npm.cmd` and `npx.cmd` (the shims next to the `.ps1` ones, which work) and, when a task
   needs Docker, to say so and finish BLOCKED instead of trying. The doctor warns when the workers or their
   fallback are on Codex on Windows, and the Team page shows the same warning on those roles (choosing Codex
   there is saved, with the warning). Both suggest a stronger model on the workers' own engine as the fallback (for
   Antigravity workers: a Claude model Antigravity offers), rather than Codex.* Check: `codex.worker-windows`;
   `test/checks.test.mjs`, `test/engines.test.mjs` and `test/team.test.mjs` cover it.
2. **"Fallbacks and engine switches" said "the orchestrator's retry"** for a retry the owner ran. *Fixed: it
   says what was run ("retry with --fallback", "retry with --engine codex"), not who ran it.* No check:
   wording; `test/dashboard.test.mjs` covers it.

## FR-010 — Owner's PC, real use: Antigravity workers' windows, their output, and how they were started (2026-09-26)
Tools: Windows 11 22621 with Windows Terminal as the default terminal, Antigravity CLI 1.2.11 workers, nextlevel
after FR-009.

1. **Every worker opened a console window that took the focus, and short-lived windows flashed.** agy's print mode
   needs a real console on Windows, so the hub opened one per worker (`cmd start`). Windows 11 hands every new
   console to Windows Terminal, which ignores hidden and minimized starts: measured with a UI Automation monitor,
   `cmd start` opened a Windows Terminal window that took the focus; `conhost.exe` started with a hidden window
   still took the keyboard focus while it ran; started minimized (`start /min`, and `SW_SHOWMINNOACTIVE` through
   `WScript.Shell`) it took it too. *Fixed: a worker runs in a real console with no window, Windows' own console
   host in headless mode (`conhost.exe --headless`, the way ConPTY hosts a terminal's shell): nothing opens and
   nothing takes the focus (the monitor saw no window and no focus change), and Windows Terminal is never asked.
   agy gets that console as its stdin, which is what it needs: with it, its output may go to pipes (measured on
   1.2.11), and it never runs without one (a worker process that has none says so and doesn't start it).
   `workers.window` in `nextlevel.json` chooses: `hidden` (the default), `minimized` (a window of its own, conhost
   started minimized: Windows still gives it the focus, and the Team page says so) or `visible` (a window of its own,
   which stays open after a failure until Enter); the Team page shows it and changes it (`nextlevel team window`).
   Autopilot rounds on agy run the same way, with no window. Every process nextlevel starts in the background is
   hidden (a test fails when a call site doesn't say `windowsHide`), none is started through `cmd start`, a
   worker writes its own log instead of inheriting a file handle (a child given a handle gets a window of its own
   when its parent has no console), and the slow checks (agy's sign-in and model list, Codex's and Claude Code's
   sign-in) are kept 5 minutes; the dashboard's Check again asks again.* Checks: `agy.model`, `agy.login`,
   `codex.login`, `claude.login` (kept answers); `test/lib.test.mjs` and `test/hub.test.mjs` cover it.
2. **A worker's output couldn't be seen**: it was in its window, and on the dashboard only its progress notes; its
   tokens were "not reported". *Fixed: agy's output comes through pipes into `worker.log` in every mode (plain text:
   terminal escape codes removed, window titles dropped whole, since agy's MCP servers put their command lines,
   one with an API key in it, there; secrets redacted). Headless runs get `--output-format stream-json`: its steps
   (tools with their parameters and output, messages) feed Show activity, and the last `result` has its `usage`,
   counted in Today (input and output; cache reads apart). A worker in a window shows the same steps there, as a
   person reads them.* No check: how the hub runs a worker; `test/engines.test.mjs` (the stream-json the owner's agy
   printed), `test/dashboard.test.mjs` and `test/team.test.mjs` cover it.
3. **agy refused `--effort` for its Claude models** ("--effort is not supported for model
   claude-opus-4-6-thinking"), so every attempt on such a model failed at once; its Gemini models carry the level
   in their name (`gemini-3.1-pro-high`). *Fixed: nextlevel never passes `--effort` to agy (not a role's effort,
   not one in `engines.agy.args`, whose default had `--effort high`); the Team page has no Effort field for it and
   shows the level from the model's name; its check tries the exact model and flags a worker gets, headless, before
   a change is saved.* **Checks: `agy.model`** (the trial, kept until the model, the flags or agy change),
   **`agy.effort`** (an effort for agy left in `nextlevel.json`; the fix takes it out).
4. **A failed attempt showed the previous attempt's report**: the hub showed attempt 2's `RESULT.md`, its status
   line and all, for an attempt 3 that failed to start. *Fixed: a new attempt moves the report before it aside
   (`RESULT.attempt-<n>.md`), an attempt that writes none has none, and one that stopped before writing one fails
   with what its engine printed last; its whole output is that attempt's part of `worker.log`.* No check;
   `test/hub.test.mjs` covers it.
5. **The tests ran the owner's real agy.** It is installed in `%LOCALAPPDATA%\agy\bin`, which is on the user's PATH,
   and the dashboard merges the PC's own PATH into its own. *Fixed: tests point PATH at the stubs, Node, Git and the
   system's folders only, and HOME, USERPROFILE, APPDATA and LOCALAPPDATA at temporary folders; under the test
   runner nextlevel starts no CLI outside the stub folder (`NEXTLEVEL_TEST_STUBS`), writes down any it refused,
   and the test's cleanup fails on it.* No check: `test/lib.test.mjs` covers the trip-wire.
6. **The tests found the installed nextlevel, and this PC's shell changed how Windows finds programs** (found by
   another session on this PC). The START.cmd test's "not on PATH" case used the PC's PATH, where
   `%USERPROFILE%\.nextlevel\bin\nextlevel.cmd` is; and the shell set `NoDefaultCurrentDirectoryInExePath`, with
   which cmd.exe doesn't run a program from the current folder (`START.cmd` "is not recognized"). *Fixed: the tests'
   PATH never has a folder with a nextlevel command in it but the stubs' (Node from a folder of its own when npm puts
   global commands next to it), the START.cmd test uses that PATH, and `NoDefaultCurrentDirectoryInExePath` is
   cleared in the tests' environment, so they find programs the same way here and on GitHub's runner.* No check:
   `test/lib.test.mjs` covers it.
7. **On GitHub's Windows runner the console with no window runs nothing, and its workers sat at "running"** (CI of
   the FR-010 pull request). The runner is Windows Server 2025, whose conhost ends within about 50 ms when started
   with a program and never runs it (`test/console-diagnose.mjs`); the hub waited three minutes for each worker's
   `run.json` and every Antigravity test timed out. *Fixed: the hub watches each start (a process that ended before
   the worker wrote `run.json`, or none after 45 s); in a console with no window the PC remembers it for a day and
   the same attempt starts again in a window of its own, the way before FR-010, and Show activity says why; any other
   start that fails ends the attempt at once as a setup problem ("the worker didn't start: ... not the task's"), an
   alert on Home, whose retry is the same attempt. Checks that try agy's print mode say they didn't try it there.
   The tests ask conhost directly whether it runs a program on the machine, and expect the console or the window.*
   No check: nothing to set up, the hub finds it out by itself. *FR-013: nextlevel no longer starts conhost.exe; the
   same fallback now follows a worker's process that finds no console to give agy.*

## FR-011 — Owner's PC, real use: windows still flash (2026-09-27, 2026-09-28)
Tools: Windows 11 22621, Antigravity CLI 1.2.12 workers, Codex CLI 0.157.1 orchestrator, nextlevel after FR-010.

1. **Windows still flashed after FR-010, when a worker started.** After the owner switched Windows' default terminal
   from Windows Terminal to Windows Console Host there were fewer, but still some (asked on 2026-09-28: "fewer, still
   some", "when a worker starts"). Measured on this PC with Console Host as the default terminal (the owner chose not to
   measure Windows Terminal again), with a monitor of top-level windows and focus (UI Automation) and of new processes
   with their parents and command lines (WMI), on a test project: a worker task and an autopilot round (Codex) with
   FR-010's start (`conhost.exe --headless`), a worker with FR-013's start, and agy started directly each way. No window
   came from how nextlevel starts anything: nothing in the worker's or the round's tree opened one, either way. The one
   that did was **agy's own background updater**: when agy's update check is due (about every 15 minutes) an agy
   session starts `agy.exe --bg-updater`, which has no console, and that runs `agy.exe --version`, which Windows then
   gives a console of its own, with a window: open 0.9 s, and in one run it took the focus (in two of four runs where
   the updater ran). A worker starting is when agy starts, so that is when the owner saw it. *Fixed as far as
   nextlevel can:* the agy sessions it starts headless (workers, autopilot rounds, the model trial) get
   `AGY_CLI_DISABLE_AUTO_UPDATE=true`, found in agy's program and not documented: measured, with it the due update check
   didn't run (no updater, no window), and the next run without it ran it (`=1` didn't stop it). agy still updates
   itself in the owner's own sessions. The window itself is agy's to fix, in a ready-to-file issue
   (`docs/upstream/antigravity-updater-console-window.md`) and in KNOWN_ISSUES.
2. **The orchestrator's window flashed a window, which took the focus, for nearly every command** (measured, one turn:
   12 windows of 0.7 to 1.4 s). In a window of its own Codex hands its commands to its shared background server
   (`codex app-server --managed-daemon`, started with no console), and for each command that server starts its
   sandbox's setup helper (`codex-windows-sandbox-setup.exe`), which Windows then gives a console window of its own.
   An autopilot round (`codex exec`, its own server in its own process) showed none. *Fixed:* the orchestrator's
   and the setup guide's Codex windows get `--no-daemon` (Codex's own flag since 0.156, only when its `--help` lists
   it), which keeps the session's server in Codex's own process: measured, the helper ran 44 times in one turn and no
   window opened. Such a session shows only as history in `codex agents`. The helper opening a window at all is
   Codex's to fix (`docs/upstream/codex-windows-sandbox-windows.md`).
   No check for either: the default terminal doesn't decide them (nothing of nextlevel's asks the default terminal for
   a console any more, FR-013), and they were measured with Console Host only.

## FR-012 — A real project, 2026-09-27 and 2026-09-28: long worker reports cut short without a word
Tools: Codex CLI orchestrator on autopilot, Antigravity CLI 1.2.x workers, nextlevel after FR-010.

1. **The orchestrator judged part of a report and sent the task back.** a real project's design tasks (`Kind: research`,
   "Files owned: None. Put the design and implementation split in RESULT.md") delivered their result in the worker's
   report. `nextlevel result` printed its first 200 lines and said nothing of the rest: M1-35's three reports were 376,
   641 and 839 lines (32 to 50 KB), M1-39's first 406 lines (28 KB), and both took three attempts, verify passing every time
   (`git diff --check`). The specs had started to ask the worker to "keep RESULT concise enough for `nextlevel result`
   to show the entire decision". *Fixed:* every attempt's report is kept whole in the job folder from the moment the
   attempt ends (`RESULT.attempt-<n>.md`; `RESULT.md` is the latest one's). What the hub prints for the orchestrator fits
   in what its engine shows of one command's output (9,000 bytes and 240 lines: Codex cuts the middle of a longer
   output, Claude Code the end): a longer report is shortened there and says so at its top and where it is cut, with
   its length, the lines shown, the file with all of it and `nextlevel result <id> --from <line>` for the next part.
   The logs in it say when they are shortened, with the path, and so does the dashboard's job view. The orchestrator's
   role doc tells it to read the whole report before judging, and that a report that looks cut off is never a reason
   to retry. No check; `test/reports.test.mjs` covers it with a stub worker whose report is 2,000 lines.
2. **A design's result belongs in a file, not in the report.** *Fixed:* design, research and map tasks (`Kind: design`,
   `research`, `map`) name a file under `docs/` on a line `Result file: docs/...` in their spec (never a protected
   path; `nextlevel dispatch` refuses such a spec without one). The worker writes the result there in full and commits
   it with the task (the hub commits it for a worker whose sandbox can't write git); the hub's verify checks that the
   file is on the task's branch and not empty, and the task fails, saying which, when it isn't. `nextlevel result`
   names the file with its length, and `--file` shows it in parts. No check: dispatch and verify do it.
3. **The owner's own words were cut too.** `nextlevel note list` cut each note to 110 characters and `handoff list` the
   owner's reply to 200, with only an ellipsis; a reply was also cut to 400 characters when it was saved, so the rest
   was nowhere. *Fixed:* a note to follow and an owner's reply are shown whole up to 1,500 characters (handled ones
   shorter), and a longer one ends with "cut here: N characters in all; the whole text: N3 in docs/OWNER_NOTES.md". A
   reply is kept whole, up to the 4,000 characters a note may have (a longer one is refused, like a note).
4. **`docs/DECISIONS.md` grew to 5,871 lines** (about 200 entries from 2026-09-26 to 09-28), most of them the story of a round (what was
   merged, retried and dispatched), and the orchestrator reads it at every start. *Fixed:* the orchestrator's role doc
   says it records decisions only, what was decided and why; a round's story stays in the round's log, which the hub
   keeps (`.nextlevel/logs/orchestrator-<time>.log`), and what the next round must know goes in `docs/STATUS.md`.
   **Check: `project.decisions`** (past about 1,000 lines it says how to archive the older entries, in plain words).
5. **The orchestrator asked workers to run `rafter run`,** a remote scan, which failed every time: a worker's branch
   isn't published (only the hub pushes, and only the base branch). *Fixed:* the orchestrator's role doc says not to
   ask for remote scans from workers, and the worker's says not to run them. The new orchestrator and worker docs are a
   new template version (`project.role-docs` offers them).

## FR-013 — Owner's PC, 2026-09-28: Bitdefender stopped an Antigravity worker and quarantined tool files
Tools: Windows 11 22621 with Bitdefender (Advanced Threat Defense and its antivirus), Antigravity CLI 1.2.12 workers on
a real project, nextlevel after FR-010.

1. **Bitdefender judged a worker's behaviour malicious and stopped the whole chain.** Advanced Threat Defense:
   "Bitdefender detected potentially malicious behavior and blocked all applications involved" (SuspiciousBehavior; a
   restart to finish cleaning). Then its antivirus moved to quarantine, within four minutes: nextlevel's
   `bin\nextlevel.mjs`, the project's `START.cmd`, agy's `~\.gemini\antigravity-cli\bin\agentapi.bat`, npm's
   `pnpm.cmd` and pnpm's programs in `AppData\Roaming\npm\node_modules\pnpm\` (`pnpm.exe`, `pn.exe`, `pnpx.exe`,
   `pnx.exe` and their extensionless twins), pnpm's task state in the project and both worker slots
   (`node_modules\.pnpm-task-run-state-v1\*`, `.pnpm-workspace-state-v1.json`), and two MCP servers from npx's cache:
   `mcp-remote`'s `dist\proxy.js` and `@rafter-security/cli`'s `dist\index.js`. The owner restored them and added one
   exception, for `agy.exe`. What in the chain looked malicious, as the owner read it: a hidden console started by
   launching conhost.exe directly (FR-010's `conhost.exe --headless`), an agent with every permission
   (`--dangerously-skip-permissions`), and probably global add-ons like Rafter and mcp-remote running inside the worker.
   Measured on this PC (agy 1.2.12): every `agy -p`, a one-line prompt too, starts every MCP server in
   `~/.gemini/config/mcp_config.json`, here Rafter's (`cmd /c "cd /d ... && npx -y @rafter-security/cli@0.10.0 mcp
   serve"`), Stitch's (`cmd /c npx -y mcp-remote ... --header "X-Goog-Api-Key: ..."`: an API key on a command line) and
   GitHub's (`docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ...`), and gives the agent the owner's global rules
   (`~/.gemini/GEMINI.md`), plugins and skills; an autopilot round's `codex exec` started the owner's Codex MCP servers
   (two through npx) the same way.
   *Fixed:* (a) **nextlevel starts no conhost.exe.** Workers, autopilot rounds and the checks that try agy's print mode
   start with `CREATE_NO_WINDOW`, Windows' documented flag for a console program without a window (Node's `windowsHide`
   with no handle inherited): the process gets a console of its own with no window, and gives agy that console's input
   (`CONIN$`) as its stdin. Measured: agy runs, its output comes through pipes as before, and the monitor saw no window
   from it. `workers.window: minimized` is `start /min`, not conhost. (b) **Workers start without the owner's own
   add-ons** unless `workers.addons` in `nextlevel.json` lists them: agy runs as an agent the worker's process writes
   into its slot (`.agents/agents/nextlevel-worker.md`, `--agent nextlevel-worker`, with `inheritCustomizations: false`
   and `inheritMcp: false`: 28 800 input tokens went to 6 000, the global rules and MCP tools were gone); Codex gets each
   MCP server switched off (`-c mcp_servers.<name>.enabled=false`), its plugins, hooks and apps off (`--disable`) and
   the owner's skills off by name (`skills.config`); Claude Code gets `--strict-mcp-config` and `--setting-sources
   project,local` (no MCP servers, and of the skills only its own), with the owner's model passed on. No sign-in is
   copied. **agy still starts the MCP servers' processes** (their tools stay out): nothing documented keeps them from
   starting for one session, which the doctor says (`workers.addons`), KNOWN_ISSUES has, and a ready-to-file issue asks
   for (`docs/upstream/antigravity-mcp-per-session.md`).
   **Checks: `workers.addons`** (the owner's own add-ons each worker engine has, and what still reaches a worker),
   **`tool.files`** (below).
2. **A worker stopped from outside counted as a lost attempt.** *Fixed:* a worker whose processes are gone without a
   report (the engine's own process is in `run.json` now) is "Stopped from outside": what it left is kept as for any
   worker, it doesn't count as an attempt (its retry is the same attempt, like one that didn't start), and Home (a card
   that opens Setup) and the phone say that an antivirus is a likely cause and what to check. No check: the hub finds
   it by itself; `test/hub.test.mjs` covers it.
3. **Dispatch would have gone on with the tools' files gone,** failing task after task. *Fixed:* before it starts a
   worker the hub checks nextlevel's own entry point and the engine's program with what its launcher runs (an npm
   `.cmd` shim's files); if any is gone it pauses dispatch (the tasks wait in the queue), raises a card and notifies
   the phone, and goes on by itself once they are back. **Check: `tool.files`** (nextlevel's own files and command,
   the project's `START.cmd`, each engine's launcher and what it runs, agy's `agentapi.bat`, pnpm's shims and
   programs), with the fix in plain words: restore from the quarantine, make one narrow exception, or put the file back
   (git, the installer, `agy update`, `npm install -g pnpm`).
4. **Nothing said what to do about the antivirus.** *Fixed:* `docs/ANTIVIRUS.md` (once a section of the setup notes) says
   why an agent tool can look suspicious, the one narrow exception, and the recovery steps above. The bridge test's
   note about agy's rules names the installed Antigravity version instead of 1.2.11.

## FR-014 — A real project, 2026-09-28: handoff conversations break
Tools: Codex CLI orchestrator on autopilot (through PowerShell and `nextlevel.cmd`), the dashboard's Notes page;
nextlevel from 2026-09-28 12:30 (after FR-013's first part, before FR-012).

1. **The owner's reply on handoff card H9 was saved cut short.** About 1,700 characters with line breaks and a bulleted
   checklist; the dashboard showed it ending in "…", and the orchestrator told the owner the hub had saved only the
   beginning. The evidence (read-only): `docs/HANDOFF.md` as the round of 2026-09-28 21:00 read it has the reply cut at
   400 characters with an ellipsis ("...answer each point under it:…"), all on one line; `nextlevel handoff list` gave
   the orchestrator its first 200 characters ("...The only changes allowed are the three st…"). H5's and H8's replies
   and H5's request itself ("Reply with the…") were cut the same way. Notes of that length arrived whole because the
   orchestrator also read `docs/OWNER_NOTES.md`, where a note was kept whole. The cause was in the store: every text on
   a handoff card went through one function that joined its lines into one and cut it at 400 characters with "…";
   `handoff list` cut the reply again at 200. FR-012 had raised the reply to 4,000 characters and 1,500 in the list, but
   still joined its lines, and it never reached that project: nextlevel doesn't update itself while a hub runs, and a real project's
   hub had run without a break since before FR-012 merged. *Fixed:* the owner's replies and the team's answers are kept
   whole with their line breaks (up to 20,000 characters; a longer one is refused, saying so, never cut); a request up
   to 4,000, where and why up to 2,000 each, refused beyond. `docs/HANDOFF.md` has each reply and answer in a quoted
   block, so its headings, bullets, fences or HTML stay inside the quote (and a "- [ ]" line in a reply is no item when
   the file is read back); the Markdown brings the whole conversation back. `nextlevel handoff list` gives the
   orchestrator the owner's words new to it whole, with their line breaks, within what its engine shows of one command's
   output (FR-012's budget); when they don't all fit, the last cards' are shortened, saying so, with
   `nextlevel handoff show <id>`, which shows a card whole (in parts, each naming the next). No check: the store does
   it; `test/handoff.test.mjs` covers it with a 3,000-character reply on the dashboard, in the file and in the stub
   orchestrator's input.
2. **The orchestrator's answers never reached the card.** It could answer the owner only through phone messages and
   the Blockers in STATUS, although the Notes page says "It answers on these cards". And every text the orchestrator gave
   nextlevel went on the command line: on Windows through `nextlevel.cmd`, where cmd.exe ends an argument at its first
   line break and changes `%...%` (measured on the owner's PC: `"line one<LF>line two"` arrived as `line one`, quotes
   were dropped, `%PATH%` became the PATH). *Fixed:* `nextlevel handoff answer <id> --file <path>` (`--file -`: stdin)
   puts an answer on the card, whole; the text never comes from the command line, which the command refuses. The
   answer is redacted like a report (.env values, token shapes) before it is kept. Each card is one conversation in time
   order: the request, the owner's replies, the team's answers. A new answer puts the card under What needs you on Home
   and at the top of the Notes page ("The team answered") until the owner replies or presses Done (on a card that was
   done, Done marks the answer read and wakes no orchestrator), and the phone gets a message that names the card, not
   the answer. Every command that takes free text takes `--file` (`handoff add`, with `Where:` and `Why:` lines in the
   file; `handoff cancel`, `note done`, `note decline`, `notify`, and the owner's `note add`, `note edit`,
   `handoff reply`, `handoff done`). The orchestrator's role doc says so (a new template version, `project.role-docs`
   offers it), and so does `handoff list`, which it runs every round.
3. **An answer is written by an AI, and the page it shows on approves the guard's held changes.** *Fixed:* every
   reply and answer shows as plain text with its line breaks (text nodes, `white-space: pre-wrap`), never as HTML:
   the page's `h()` and the card's conversation are in `src/ui/dom.js`, and a test renders a card whose answer holds
   a `<script>` in a DOM that parses HTML (the test fails when the escaping is broken on purpose).
4. **A merged fix didn't reach a PC whose hub runs all day** (FR-012 above). Not fixed here: noted for its own change.

## FR-015 — A real project, 2026-09-29: `nextlevel push --help` pushed main and deployed production
Tools: Codex CLI orchestrator on autopilot (through PowerShell and `nextlevel.cmd`); nextlevel 60e3be1. **High
severity**: on a real project a push to main deploys production.

1. **A command asked for its help acted instead.** The owner's notes asked the orchestrator to push a backup branch
   (`backup/main`) and a CI branch (`ci/m1-gates`) through the hub. The hub's only push command, `nextlevel push`, pushed
   `origin main` and took no branch, so the orchestrator ran `nextlevel push --help` to see its options. `cmdPush` took no
   arguments at all: it queued `git push origin main`, and the hub pushed main (evidence, read-only, in
   a real project's folder: `.nextlevel/jobs/push-20260929-183321-e48g/`, `.nextlevel/logs/orchestrator-20260929-183226.log`,
   handoff card H16). Hundreds of unreleased commits went live. Reproduced on main (40aba83) in a
   project whose origin is a local bare repository: `push --help`, `push -h` and `push --branch backup/main` each pushed
   main. The same probe found more commands that acted on `--help`, `-h` or an option they don't have: `notify` (a phone
   message titled "--help"), `ask` (a question "--help" to the assistant's engine), `init`, `doctor` (its checks and a
   harmless fix), `daily-report`, `login` and, from the code, `run`, `ui`, `orchestrator`, `bridge-test` and `update`;
   the others ignored an unknown option once their argument was there (`dispatch T1 --help` dispatched). Each command had
   a parser of its own that dropped what it didn't know. *Fixed:* every command is in `src/lib/commands.mjs` with its
   usage and options, and one strict parser (Node's `util.parseArgs`, strict) reads every command's arguments before
   anything runs (no update, no project, no hub): `-h` and `--help` print the usage and exit 0; an option or an argument
   the command doesn't take prints the usage and exits 1; `nextlevel help <command>` prints the same usage. The commands'
   code reads its arguments from that parser, never from its own, and a command that isn't listed doesn't run.
   `test/push.test.mjs` walks every command with `--help`, `-h` and an unknown option, through `nextlevel.cmd` on
   Windows too, and checks that nothing changed: origin's refs, the project's files, hub state, cards and notes, and no
   stub CLI called.
2. **A push took no branch and could reach anything the hub could.** *Fixed:* `nextlevel push <branch> [--from <local
   branch>]`: the branch on origin is always named (no default), pushing the base branch unless `--from` says otherwise.
   The name must be a plain branch name: a leading `+`, a colon, `refs/...`, `HEAD`, a tag, a remote's name or one in
   front of it (`origin/main`) are refused, by the command and again by the hub (the orchestrator can write the queue).
   Nothing is ever forced: when origin's branch has commits the pushed one doesn't have, the push is refused and says
   so. A job from before FR-015 (no branch) is never taken to mean main, and a new `nextlevel push` refuses to queue for a
   hub that is still the old code (it would push main).
3. **A push to a deploy branch needed no one's approval.** *Fixed:* `deployBranches` in `nextlevel.json` lists them;
   until a project sets it the base branch counts as one (the `project.deploy-branches` check says so, and how to set it;
   `nextlevel init` writes `["main"]`). A push to one doesn't push: the hub makes a card, written by code as the guard's
   are, with the branch, how many commits would go out and since when, the newest commit's message and the list of
   commits, and the phone gets a message that names the card. Only the owner's Approve on the dashboard pushes, never the
   phone or a command, and it pushes exactly the commit the card showed; if the branch or origin's moved since, nothing
   is pushed and a new card asks again. A rejected push isn't asked again. Every push, from any path, goes through one
   function (`pushBranch` in the hub), logged with its source, target, commit range, who asked and, for a deploy
   branch, the card (the job's `push.log`, `hub.log`, and `pushes.jsonl` in the guard's folder, outside the project);
   a test reads `src/` to prove nothing else runs `git push`. `nextlevel.json` is protected, so the team can't change the
   list without the owner, and until a change of it is committed the hub counts both versions' branches.
4. **The role docs never said not to try a command to learn what it does.** *Fixed:* the orchestrator's, the
   worker's and the guide's say it (read the role doc, or `--help`, which never acts from this version on); the
   orchestrator's has the push's exact usage with backup and CI examples, and says a deploy branch asks the owner. A new
   template version: `project.role-docs` offers it.
5. **Found while fixing it, not fixed here (for their own changes):** `nextlevel verify <name> -- <command>` runs any
   command in the main checkout with the hub's own environment and sign-ins, so a `git push` or a deploy CLI through it
   reaches origin without `pushBranch`, even while git work is stopped by the guard; a worker whose engine allows shell
   commands can run the main project's `nextlevel` (`--project`) or write its queue and outbox; notifications and the
   daily report aren't redacted; `report --send` and `update` have no check against an agent's session.
   *Fixed in FR-017 part 1*, but for the workers' reach to the hub (part 2).

## FR-016 — A real project, 2026-09-30: the Project page lost a milestone's plan
Tools: Codex CLI orchestrator on autopilot; nextlevel after FR-015. Low severity: nothing was lost, the page hid it.

1. **A plan under a name the page didn't look for.** The orchestrator wrote the Walking skeleton's plan as
   `docs/plans/WS-walking-skeleton.md` (its tasks are WS-01, WS-02, ...). The page took a plan's milestone from its file
   name alone and looked for `docs/plans/walking-skeleton.md` ("Walking skeleton" has no number in `docs/STATUS.md`), so
   it said "No plan yet" for a milestone with 33 merged tasks and hid its Outcome, Acceptance and Try it, and nothing
   warned. The owner's note N22 had the orchestrator rename the file (30 September). Evidence,
   read-only in a real project's folder: `docs/plans/` (`M0-foundation.md`, `M1-accounts-households.md`, `walking-skeleton.md`),
   the milestone table of `docs/STATUS.md` (Pre-flight (owner), M0, M1, Walking skeleton, M2 to M7), N22 in
   `docs/OWNER_NOTES.md` and its entry in `docs/DECISIONS.md`. Run on those files with the plan's old name, the page's
   code found no plan for the Walking skeleton. *Fixed:* a plan is found first by what it says, a line `Milestone:
   <name>` in its header (the role doc's form); else by the better of its title and its file name, each naming the
   milestone's id or name in any common form (`M1`, `M1-accounts-households`, `accounts-households`, `WS-walking-skeleton`,
   `walking-skeleton`, `WS`); two different ids never match. When two plans claim one milestone the page says so and
   shows the one whose Milestone line names it. A task spec's `Milestone:` line that isn't a milestone's id is matched
   the same way (`Milestone: WS Walking skeleton`).
2. **M0's and M1's "Its plan has no Try it steps" was wrong too.** Both plans have their steps, under labels the
   parser missed: M0's says `Try-it:` (with a hyphen) and starts with a byte-order mark (PowerShell wrote it), which also
   cost it its title on the page; M1's says `Try it (accepted local flow; production signup also confirmed by the
   owner):`. *Fixed:* a label may have a hyphen, and words in brackets after it, which stay, in brackets, at the start of
   its text; a file's byte-order mark is no part of it (this helps every file the page reads).
3. **Nothing warned.** *Fixed:* the Project page (at the top of the roadmap, and on each milestone's card) and the
   doctor say, for each milestone: it has tasks but no plan was found (naming the files in `docs/plans/` that match no
   milestone, and where its plan goes), its plan has no Outcome, Acceptance or Try it (which), or two plans claim it
   (which one is shown, and why). A milestone without tasks yet needs no plan: it comes before them. **Check:
   `project.plans`** (no fix: the orchestrator keeps the plans; its step is a note that asks it to).
4. **The role doc named no exact path.** *Fixed:* the orchestrator's role doc says the plan is
   `docs/plans/<milestone id or name>.md` and starts with its title and a line `Milestone: <the milestone's name exactly
   as in docs/STATUS.md>`, and that the page and the doctor say when they can't find it. A new template version
   (`project.role-docs` offers it; a real project's and a test project's are unchanged older templates).
5. **Found in its review: the page's parsers could hang on one line.** Their heading patterns had two or three `\s*`
   that share a run of spaces, so a plan heading with 500 spaces in it took 3.6 s to read and one with 1,000 took 56 s
   (measured on main, 2026-10-01); the doctor reads these files now too. *Fixed:* every pattern over the team's files
   (`lib/roadmap.mjs`) runs in time linear in a line's length: a heading's end is trimmed by hand, each optional part of
   a label starts with what isn't a space, a placeholder is tested per bracketed part. 100,000-character lines of each
   kind take milliseconds; `test/project.test.mjs` reads them in a process it stops after 20 s.

## FR-017 — FR-015's inventory and review, 2026-09-30: what an agent's session could still do through nextlevel (part 1)
Tools: nextlevel 37a44c3 (FR-015 merged). No new incident: FR-015's fix found these (its #5) and its review three more.
The agents run as the owner's own Windows user, so without a separate Windows user for them none of this is a wall
against an agent determined to get around it; the aim is that no agent does these things by accident or through an
ordinary nextlevel command. `docs/KNOWN_ISSUES.md` ("What an agent running as the owner can still do") says what a
determined one still can. Part 2, a later change: workers can't reach the hub at all.

1. **`-h` inside a group of short options wasn't help.** FR-015's parser took help only from the words `-h` and
   `--help`. Node's parser reads `commit -hm "x"` as `-h` and `-m "x"`, and the command then said "nextlevel commit
   doesn't take --help" and failed (measured on 37a44c3; `merge <id> -hm "x"` the same). Nothing ran, but only because
   of that second check: help must be help. *Fixed:* help is what the parser reads, in a group too, whatever else is
   wrong with the arguments (`src/lib/commands.mjs` reads the arguments leniently first); `test/push.test.mjs` walks the
   grouped form of each command's short options, through `nextlevel.cmd` on Windows too: the usage, exit 0, and nothing
   changed.
2. **`"deployBranches": []` still asked for main.** The doctor and the config's messages say `[]` means no deploy
   branch, but the hub fell back to the base branch whenever every source said `[]`. *Fixed:* when every source (the
   file on disk, the committed one, the one when the orchestrator's work began, the settings the hub read) says `[]`,
   there is none; a change still counts only once committed, and before that it can only add a branch.
3. **The worker checks in `push` and `note`/`handoff` read variables a worker can clear.** Left as they are (they catch
   a mistake) and said so in the code and `docs/KNOWN_ISSUES.md`; part 2 replaces them.
4. **`nextlevel verify` ran any command with the owner's access** in the main checkout: a `git push` or a `gh` write in
   it reached origin without `pushBranch`, even while the guard had stopped git work. *Fixed:* a verify command waits
   while git work is stopped (its status and `nextlevel wait` say why); it runs with Git pushes and GitHub sign-ins
   switched off through its environment, as the slots' push block (FR-003): every push URL rewritten to one that fails,
   each remote's explicit push URL replaced (an empty value first, Git 2.46+; a Git that can't leaves the command
   unrun, saying why), no credential helper or prompt, no ssh, and `GH_TOKEN`/`GITHUB_TOKEN` (and the Enterprise ones)
   set to a token that doesn't work. Each verify command is logged with its exact command line, who asked and how it
   ended in `verify.jsonl` in the guard's folder, outside the project. `test/sessions.test.mjs` pushes by the remote's
   name, by its address and through a pushurl, and writes through gh: nothing reaches the bare origin, and gh finds no
   sign-in; with the block taken out on purpose, the test fails. The one exception: `nextlevel verify doctor --
   nextlevel doctor`, exactly nextlevel's own doctor (the setup as seen from outside Codex's sandbox, FR-004 #2), is the
   hub's own run of its doctor with the owner's sign-ins, since the doctor only looks; without them it said gh was
   signed out. **GitHub reads (a review):** inside Codex's sandbox verify is the orchestrator's only way
   to GitHub, and a real project's reads CI through it: 35 of its 329 verify jobs ran `gh run list`, `gh run view`, `gh run
   watch` or `gh api user` (read-only, in a real project's `.nextlevel/jobs/check-*/job.json`), and the block turned them into
   "Bad credentials"; a fetch or a clone from a private GitHub remote would fail too. An optional read-only token in
   the project's `.env` (`NEXTLEVEL_GITHUB_READ_TOKEN`, fine-grained, the one repository) gives the reads back: gh gets
   it, git gets it for github.com only, through a credential helper that returns nothing else, and GitHub refuses any
   write made with it; pushes stay blocked. The doctor's `gh.read-token` says whether it is there, reads, or expires
   soon; without it a verify job's log says when gh or git failed for want of a sign-in; the orchestrator's role doc
   says how CI is read. What `nextlevel result` shows of a verify job's log is redacted like a phone message.
5. **`update --to`, `update --force` and `report --send` had no check against an agent's session.** *Fixed:* `update
   --to` and `--force` refuse in an agent's session (the orchestrator's window, an autopilot round, a verify command, a
   worker's slot, the assistant), saying why, and do nothing (`src/lib/session.mjs` knows the session from what the hub
   puts in its environment). `report --send` files nothing from any command line any more: the dashboard's File it
   files the report its page showed in the dashboard's own process, on a request with the dashboard's key, which is
   never written down; `nextlevel report` files only after a yes in the owner's own window and refuses in an agent's
   session (`--json` builds one there and files nothing). To leave something out, the owner edits the kept file before
   answering, and what it holds then is shown again, redacted again, and asked again (it was `report --send <id>`).
6. **The fix follow-up installed merged fixes by itself:** an idle hub stopped, updated nextlevel and started again on
   the new code, without the owner. *Fixed:* it tells the owner (and the phone) that a fix is merged, with how to
   install it (`nextlevel update`), and waits; once installed, the check runs again as before. Safe updates, a later
   change, brings a one-click update. The start-up update of the owner's own commands (M3) is unchanged.
7. **Phone messages weren't redacted:** a value from `.env` in a notification, a handoff card, a commit subject or
   anything an agent wrote into the outbox went to ntfy as it was, where anyone who knows the topic reads it. *Fixed:*
   `notify()`, the one function that talks to ntfy (a test reads `src/` for any other), redacts title and message the
   way reports are, for the project it must name; the hub redacts again before its links change the text. Covered:
   notify, notify --now, the outbox (written by the hub or an agent), alerts, the daily report and handoff answers; a
   planted value reaches the stand-in ntfy as `***`, and with the redaction taken out on purpose the test fails. A
   setting's ordinary word (production, development, staging, test, local, localhost, debug, info, warn, warning, error)
   under a name that doesn't look secret stays readable: `NODE_ENV=production` leaves "production" in a message, and
   `API_TOKEN=production` still blanks it out (a review).
8. **Nothing said that a role on Antigravity acts with the owner's full access.** It skips its permission checks to run
   unattended (`--dangerously-skip-permissions`), so its workers, or an orchestrator on it, could push or deploy
   directly. *Fixed:* the doctor's `profiles.full-access` and the Team page say so for each such role (also Codex
   without its sandbox and Claude Code with bypassPermissions): a warning for a role in the main checkout (the
   orchestrator, the setup guide, the assistant, their fallbacks), which can move to a sandboxed engine, and information
   for workers, whose risk is accepted by design (slots behind the push block, Antigravity's unattended mode). The setup
   guide on Antigravity, which asks before it runs anything, doesn't count.

## FR-018 — A real project, 2026-10-01: a card the team closed after the owner's reply read "Cancelled"
Tools: Codex CLI orchestrator; nextlevel after FR-014. Low severity: nothing was lost, but the owner read the card as
abandoned and couldn't follow up on it.

1. **"Cancelled" after "Deployed".** The owner replied "Deployed" on card H18; the orchestrator, with nothing left to do,
   ran `nextlevel handoff cancel H18 --reply "..."`, the only way it had to close a card, and the dashboard showed
   "Cancelled", which reads as the team giving up on it. **Cause:** a card had two ends, the owner's Done and the team's
   cancel, and nothing said who closed it or why. *Fixed:* `nextlevel handoff close <id> --file <path>` closes a card as
   resolved, its text kept whole in the card's conversation; the card says "Done by you", "Closed by the team" (with
   the team's words) or "Cancelled by the team" (withdrawn before the owner acted), and a held change's card "Approved
   by you", "Rejected by you" or "Closed by nextlevel". A `cancel` on a card the owner replied to is recorded as a close
   and says so, so an orchestrator on an older role doc gets it right too. The role doc says when to use which (a new
   template version).
2. **No follow-up on a closed card.** A reply on a done or cancelled card was kept, but the card stayed closed: the team
   wasn't told. *Fixed:* every closed card has Reopen, and a reply reopens it ("Reopened by your reply"); `nextlevel
   handoff reopen <id>` does it from the terminal ("Reopened from the terminal"). The card comes back under "The team
   needs from you" with its whole conversation and its closings and reopenings in time order; the next round's
   `handoff list` says it was reopened, after what, and that what the team did since may need another look.
3. **Done by mistake had no way back** (the owner, with this report). *Fixed:* a Done on the dashboard can be undone for
   10 seconds. Until then nothing happens (the team, autopilot and docs/HANDOFF.md see the card open); the click is kept
   with the time it becomes final, so a reload shows Undo with the seconds left and a Done whose page closed still
   counts, after a hub restart too. A write on the card in those seconds makes the Done final first, so the owner's
   words are never lost.

## FR-019 — A real project, 2026-10-04: autopilot ran rounds while it only waited for the owner
Tools: Codex CLI orchestrator (gpt-6.1-sol, effort xhigh) on autopilot, Antigravity and Claude Code workers; nextlevel
facd8e9. Medium severity: nothing broke, but it spent Codex, the scarce plan, on rounds that had nothing to do.

1. **Rounds every few minutes for twelve hours, with nothing to do.** The round at 11:13 AM reviewed a held task and
   raised card H22 (11:16 AM) for the owner's decision. Nothing ran after it (no worker, no check), and the owner's reply
   came the next morning. Home said "Autopilot wakes the orchestrator when there is something to decide", yet the hub
   started 95 more rounds, one every 4 to 10 minutes up to its 8-per-hour cap, until 11:04 PM, when the PC restarted. Each
   took about a minute and ended "the owner hasn't replied", after a commit of a STATUS.md note. Evidence, read-only in
   a real project's folder: `.nextlevel/logs/hub.log` (4 October, 15:13 to 03:04 UTC), the 95 round logs
   (`orchestrator-20261004-152210.log` to `orchestrator-20261005-030258.log`), the commit jobs and `usage.json`. Those
   rounds used about 3.0 million Codex tokens as nextlevel counts them (another 22 million read from Codex's cache) and
   99 minutes; the day's 121 rounds used 5.86 million and 298 minutes. **Cause:** the hub started a round whenever no
   worker ran, whatever had happened, 3 minutes after the last one ended, at most 8 an hour; and it judged a round's
   progress by a fingerprint that every round changed itself (the base branch's head, STATUS.md's time, every job's id:
   a `nextlevel commit` makes a job even with nothing to commit), so its pause after three rounds without progress never
   came. *Fixed:* a round starts only because something happened (`src/lib/rounds.mjs`), and the hub enforces it, whatever
   the role doc says. Real: work moved (a task dispatched, merged, retried or closed; a push that sent new commits) or the
   owner acted (a reply, a note added or changed, a decision on a card, Run a round now). Always a round: the owner, a task
   attempt that ended any way. Only while fewer than three rounds have started since the last real event (the brake): a
   check, push or merge job ending, a wake-up the orchestrator asked for, the round right after one in which work moved,
   one retry of a round cut off. Nothing timed. A job's end the round running then had already reviewed starts nothing;
   what comes together starts one round, what comes during a round one round after it. The 8 an hour stay, as a
   ceiling. Replayed from a hand-written timeline of that day (`test/rounds.test.mjs`): one round for the task, none
   after H22, one for the owner's reply.
2. **A round's own bookkeeping counted as progress.** *Fixed:* nothing the team does for itself is real: a commit,
   STATUS.md or its notes, a post on a card, a card it raises, its own check jobs, a push with nothing new, a wake-up.
   The owner's side of the cards is counted where it happens (`lib/cards.mjs`: each store counts what the owner did), and
   `nextlevel note add|edit|...` and `handoff reply|done` refuse in an agent's session, so the team never passes for the
   owner through an ordinary command. The role doc: a round with nothing new ends without a commit (its round log keeps
   what it checked). The hub doesn't refuse such a commit: a commit no longer starts or keeps a round going, so refusing
   it would save nothing, and it would leave changes in the main checkout in the way of the next merge (DECISIONS).
3. **Nothing stopped a loop of rounds.** *Fixed:* the fuse: six rounds in a row that start with nothing real between them
   turn autopilot off, with a phone message and a card on Home that say why and how to turn it on again. Turning it on
   releases the brake and the fuse.
4. **Nothing was lost only because rounds were timed.** *Fixed:* what would start a round is kept in
   `.nextlevel/rounds.json` until a round starts, so what happens while the hub is stopped or autopilot is off (the owner's
   reply, a task attempt that ended, a wake-up that came due) gets one round when the hub starts or autopilot is turned on,
   and nothing new gets none. A round the last hub started is followed to its end by the next one.
5. **The orchestrator had no way to come back for something outside the hub** (a CI run it pushed for) other than the
   timer. *Fixed:* `nextlevel wakeup <minutes> --reason "..."`, the orchestrator's only (it refuses for workers, verify
   commands, the assistant and the owner's window: a bar, not a wall, until FR-017 part 2B). As long as asked, and at
   least 5 minutes doubled for each round in a row with nothing real (5, 10, 20), 5 again after a real event; a round
   that asks for one gets no round right after it (the wake-up is its next round); one at a time, cleared by any round;
   kept on disk in UTC, so it survives a restart and a clock change. The role doc: wait on CI with a wake-up for about as
   long as the run usually takes (a check that polls would hold up every push and check behind it: one lane), never to
   wait for the owner.
6. **Home couldn't say what the team waits for.** *Fixed:* the Autopilot tile says it ("Waits for your reply on H22, a new
   note, or a task finishing"; a wake-up's time and reason; "Three rounds found nothing to do, so only you or a task
   finishing will wake the team"; the fuse), it has Run a round now (the owner acting), and Today counts the rounds,
   their minutes and Codex tokens by what started them. The brake, the fuse and the shortest wake-up are settings
   (`hub.rounds` in `nextlevel.json`).
7. **A round whose engine never started was tried again every minute, without end.** Found in review, not on a real project: a
   round that failed before the orchestrator's engine was launched (its process couldn't be started, ended first, found
   no console, or left no sign within 45 s) gave back what started it and counted nothing, so the hub started another at
   its next look, with a window each time where rounds run in one, and Home said only that a round starts within a
   minute. *Fixed:* the round's process records when it launches the engine (`launched` in `cycle.json`); a round that
   never got there counts toward the 8 an hour, Home says what failed, and two in a row turn autopilot off, with a phone
   message and a Home card that say what failed (with its exit code) and how to turn it on again. A round whose engine
   started is a round, cut off or not.
8. **Several processes wrote the same small files whole.** Found in review: `settings.json` (autopilot on or off, when it
   was turned on) is written by the hub, the dashboard, the menu and the interactive windows, and `usage.json` (Today)
   by the hub, the interactive windows and the assistant, so a write at the same moment as another could undo the
   owner's "turn autopilot on". *Fixed:* both are written under a lock (`src/lib/filelock.mjs`, the cards' stores too):
   its holder is told by its pid and start time, one that keeps it 12 s has it taken over (said in hub.log), and a
   writer whose lock was taken over makes its change again on the file as it is, so no change is lost; the owner's two
   actions say on the dashboard when that happened. `rounds.json` has one writer, the hub; a wake-up ask (with an id) is
   the command's file and Run a round now a count the dashboard raises, both only read by the hub. A test runs four
   writers at once.

## FR-020 — A real project, 2026-10-04: a worker's report went missing and nothing said why
Tools: Codex CLI orchestrator; Antigravity workers (gemini-3.8-flash-high), the Claude Code fallback (`claude -p`,
claude-sonnet-5-5, effort xhigh, Claude Code 2.1.284); nextlevel facd8e9. Medium severity: the work was right, but the
orchestrator judged it on the wrong evidence, and one task took 13 attempts.

Evidence, read-only in a real project's folder: the task's job folder `.nextlevel/jobs/WS-62-.../` (status.json, every
`RESULT.attempt-*.md`, git.log, attempt 10's part of worker.log by its header and "Worker finished"), `logs/hub.log`'s
started and finished lines, and the task's spec.

1. **Attempt 10 ended "done · verify pass · worker says MISSING · 18 commit(s)", and nothing said why.** On the Claude
   Code fallback it worked 85 turns over 14 minutes, made one commit of its own and ran Verify 1 to 9. Then it started
   its longest check with `run_in_background`, a background wait for it, and ended its turn, saying it would go
   on with the remaining checks once that one finished. In print mode the session ends with the
   turn: Claude Code printed `result` (success, `terminal_reason: completed`), stopped both background commands
   (`task_updated`, `killed`) and exited 0. It never tried to write its report; nothing kept it from writing one
   (`acceptEdits`, all tools, no MCP; the project and the slot have no CLAUDE.md or `.claude/` settings, no hooks; a real project's
   WORKER.md names `RESULT.md`). The hub's own verify then passed all of it. **Cause:** the hub explained a missing report
   only for an engine that crashed (an exit code other than 0); Claude Code's own end was never read; the worker's prompt
   never named the report; and a Claude Code worker could put commands in the background, which its session stops when it
   ends. *Fixed:* every way a report goes missing says why, everywhere an attempt shows (the time limit, the engine stopped
   with its exit code, an error end of the engine's own, the engine ended without writing it with its own end: its
   status, turns, last words and the background commands it stopped, or stopped from outside); each engine's end is read
   (Claude Code's last `result`, Codex's last turn, agy's status: `engineEnd`), and an error end fails the attempt
   whatever its exit code; every worker's prompt names `RESULT.md` and its Status line and says the session ends with its
   turn; Claude Code workers run with background commands off (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`) and Bash's
   limit at half the attempt's, so the report still fits (KNOWN_ISSUES).
2. **"18 commit(s)" were the whole branch's: 2 were attempt 10's** (the hub's merge of main and Claude Code's commit),
   16 earlier attempts'. Nothing recorded where an attempt started, so an attempt that did nothing would also have ended
   `done` on earlier work. *Fixed:* the branch's tip after the hub's merge is recorded as each attempt starts; its own
   commits and diff stat come first in the summary ("1 commit(s) this attempt, 18 in all"), `nextlevel result` and Home;
   an attempt with none of its own and no report is `no-changes`; one that ended normally with its own commits passing
   verify (or, for a design, research or map task, changing its result file) is "finished without a report, verify
   passed": `done`, marked, and not a failed attempt.
3. **Why WS-62 reached attempt 13:** the orchestrator ran every review round as a retry of the same task, so its spec
   grew from C1 to C12 over 962 lines. Attempts 1 to 8 (agy) each failed verify on a different gate; attempt 9 passed,
   and review found a fixture problem (C9), sent to the fallback; attempt 10 is above; attempts 11 to 13 were the owner's
   preparation-only runs for a twenty-run check, PARTIAL on purpose. The attempts alert fired from attempt 4 on ("past 3")
   and never said how they ended; each attempt's start deleted the last one's run.json and verify.log, so only worker.log
   and hub.log kept them. *Fixed:* status.json keeps every attempt's end (`attempts`), the alert counts them by how they
   ended, and the orchestrator's role doc says which attempts count toward the fallback and that a new requirement from
   review is a task of its own. Acting on a stuck task (the stuck ladder) is a later pull request.
## FR-021 — A real project, 2026-10-04: closed tasks counted as open
Tools: Codex CLI orchestrator, Antigravity and Claude Code workers; nextlevel facd8e9. Low severity: nothing broke, but
the Project page's count was wrong, and the owner reads it to judge how far a milestone is.

1. **Five closed tasks counted as planned.** a real project's Project page said the Walking skeleton had "147 of 162 merged",
   and the 162 held five tasks the orchestrator had closed on 1 October at the owner's word (a note: keep only the tasks
   the Acceptance needs, put the rest on Later). They showed "not dispatched yet". Evidence, read-only in a real project's folder: each spec
   got a line "Status: closed, not dispatched" with the note and the date, the plan a step "Close undispatched ..."
   (`docs/plans/walking-skeleton.md`), `docs/LATER.md` the two Later items; none had a job record or a branch. One more
   task was closed in the docs only (superseded after two reviewed attempts, its branch kept unmerged); it
   showed as done. On 14 October, from a real project's files and a clone of its history (fed to `buildRoadmap` by a script, never
   nextlevel on a real project): 192 of 205 merged, 8 done and kept unmerged, 5 planned but closed in the docs. **Cause:**
   nextlevel had no way to close a task: no command, no record. The only mark was `cleaned: true` on a job, which a
   merged task's cleanup sets too; `cleanup` with no branch said "marked cleaned up" and wrote nothing for a task never
   dispatched; nothing read a "closed" in a spec, STATUS.md or a plan. *Fixed:* `nextlevel close <task-id> --reason "..."`
   (or `--file`), the orchestrator's and the owner's (it refuses in a worker's slot, a verify command, a project hook and
   the assistant). It queues a git job, `close`, which checks the task again and keeps the closure (when, who, why, what
   it had) in `.nextlevel/closed.json`, written only by the hub and read through a shape check (`src/lib/closures.mjs`).
   It refuses an unknown id, a task queued, running or merged, and one whose branch has work that isn't merged unless
   `--discard`, which deletes the branch in the same job. Every close marks the task's job reviewed and is one real event
   for autopilot (FR-019). Dispatching or retrying a closed task opens it again (the hub drops the closure when it starts
   it, and says so). `cleanup --discard` of an unmerged branch closes the task ("its work thrown away"); `cleanup` with
   no branch and no job writes nothing and points to `close`. Bridge-test tasks never get a closure.
2. **Honest counts.** *Fixed:* a closed task shows as "closed" with its reason on the Project page and in the Build
   page's lists (and a "Closed lately" card), "N of M merged" leaves it out and says it apart ("192 of 200 merged · 5
   closed"), a milestone whose only tasks are closed isn't one with tasks but no plan, and a closed task's attempts never
   set a milestone's dates. `nextlevel status` lists the tasks closed in the last day (`--json`: `closed`, and each job's
   `state` stays), the daily report counts them, and the doctor's `project.plans` reads them as the page does. The page's
   cached view changes with them.
3. **A merge given its own text could miss the count.** The page counts a task merged when a merge commit's subject
   names `task/<id>`; `nextlevel merge -m "..."` used the text as it was, and a branch "merged already" makes no merge
   commit. On a real project it changed nothing: 326 finished merge jobs, all 326 in the merge log, none with its own `-m`. M0-06
   and M0-43 have branches inside main with no merge commit: both are on main's own line of commits, empty branches, so
   they rightly stay unmerged. *Fixed:* the hub's merge commit names `task/<id>` in its subject whatever the text, and the
   hub's finished merge jobs count as merged too (the page and the doctor).
4. **The role doc had no way to close a task.** It named `cleanup --discard` "for abandoned work" and said nothing about a
   task never dispatched or a spec another replaces. *Fixed:* "Closing a task" in the orchestrator's role doc (a new
   template version): `nextlevel close` with the reason (replaced by other tasks, out of scope, the owner's call), never
   only by editing the docs; STATUS and DECISIONS keep the story.

## FR-022 — A real project, 2026-10-13: Antigravity 1.3.4 fails the model check with "ERROR"
Tools: Antigravity CLI 1.3.4 (it updated itself from 1.3.2), workers pinned to gemini-3.8-flash-high; nextlevel
3e4f85e. High severity: no worker could have run on agy, and nothing kept tasks from starting on it.

1. **Setup's "Antigravity model" row failed with nothing but agy's status:** `"gemini-3.8-flash-high"
   (roles.worker.model) was refused with the flags a worker gets: ERROR`, and the Team page wouldn't save the worker role.
   By hand, `agy -p "Reply with the word OK" --model gemini-3.8-flash-high --dangerously-skip-permissions --mode
   accept-edits` answered OK. **Cause, measured on this PC's agy 1.3.5** (it had updated itself again; 1.3.4 and 1.3.2
   weren't run): nextlevel's own agent file. Its plain `description:` held a second `: `, which isn't valid YAML; 1.3.2
   read it (the 9 October workers on a test project ran as the agent), 1.3.4 drops it and, new in 1.3.4, refuses
   `--agent` with a name it has no agent for: exit 1, `unknown agent "nextlevel-worker" (available: ...)` in the result's
   new `error` field, which nextlevel threw away. Changing one thing at a time from the trial toward the owner's command
   (console, launcher, environment, output format, time limit, prompt, updater variable, folder) changed nothing; the
   same file with the description quoted ran. *Fixed:* the agent file's texts are quoted YAML (KNOWN_ISSUES).
2. **With the file fixed, a real worker answered BLOCKED:** after 1.3.2 an agent without a `tools:` list gets only tools
   that look ("no file-write tools available in this session"), and the model check, whose probe only asked for "ok",
   passed. *Fixed:* after 1.3.2 (from `agy --version`) the agent lists the tools a worker needs, agy's own only (FR-013
   holds: 8 197 input tokens for "hi" as the agent, 27 864 as the default agent); the probe asks agy to write a file and
   run a command, and a run that did neither fails.
3. **nextlevel showed only "ERROR".** *Fixed:* wherever a run on agy fails (the check, a worker's attempt, an autopilot
   round), agy's own reason (the result's `error`, its error events, an `AGY_ERROR` line, its error line), the exit code
   and its last lines (about 20), redacted like a report and with every string of the owner's MCP servers' settings; the
   phone and a card's headline get the reason in one line.
4. **The trial wasn't what a worker runs** (the project's `.env` in its environment, cmd.exe for a `.cmd`). *Fixed:* one
   function builds both (`src/lib/workerspec.mjs`); its answer is kept under that run's key with agy's version; a
   refusal an hour; the version it last passed on is named ("refused on agy 1.3.4 (passed on 1.3.2): ...").
5. **Nothing stopped a task from starting on a broken agy:** each would have spent an attempt. *Fixed:* tasks on agy wait
   in the queue (`waiting: ...`) until a trial of what that worker runs passes, which the hub runs in a child process it
   follows; a Home card with Check again, one phone message, one round; other engines go on; `retry <id> --fallback`
   moves a held task; nothing falls back by itself (agy's ERROR can be a usage limit).
6. **The owner asked which flags the hub really passes,** since Setup listed `--dangerously-skip-permissions --mode
   accept-edits` while a real project's `nextlevel.json` also has `--effort high`. Answer: those two, `--output-format
   stream-json`, the model, the time limit and `--agent nextlevel-worker`; never `--effort` (FR-010). The check now shows
   the whole command it ran and says `--effort` isn't passed; `nextlevel doctor --fix agy.effort` takes it out.
7. **New the same week:** Gemini 4 Argon (13 October, Ultra plans): `gemini-4-argon-low`, `-medium` and `-high` in `agy
   models`, and 1.3.4's Claude models with a level in their name (`claude-opus-5-5-medium`). The Team page reads their
   levels from the names; a real task ran on `gemini-4-argon-high` on a test project. Argon in the other roles is a later
   pull request.
