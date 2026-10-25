# Decisions

One entry each: date, decision, why, alternatives.

- 2026-09-25 — **Zero runtime dependencies, Node ≥ 22.** Installs can't break on a user's machine and
  there's no build step. Alternative: a framework CLI or Electron app (heavier, more to break).
- 2026-09-25 — **Files are the protocol between orchestrator, hub and workers.** Survives restarts and
  sandboxes; any tool that can read and write files can take part. Alternative: sockets or a database.
- 2026-09-25 — **Workers run in separate git worktrees ("slots") with fixed paths.** Isolation without
  copying the repo, warm dependencies between tasks, stable ports per slot.
- 2026-09-25 — **Windows first.** The first user is on Windows and most of the hard problems are there.
- 2026-09-25 — **CLI name `nextlevel`.** Developed in a private repository until the first public version.
- 2026-09-25 — **Only workers with their own window pause at exit.** The hub sets `NEXTLEVEL_IN_WINDOW=1`
  for the workers it opens a window for and strips it from every other environment it builds; only
  those workers keep their window open for 20 s so the owner can read it. Background workers
  (`NEXTLEVEL_WORKER_WINDOW=0`, Codex workers, CI) exit as soon as they finish; before, they slept 20 s on
  Windows for nobody and kept their slot folder busy. Alternative: guess from `process.stdout.isTTY`
  (a worker run by hand in a terminal would pause for nothing; the hub knows which windows it opened).
- 2026-09-25 — **CI runs the console-window worker path on Windows.** A Windows-only test runs a worker
  with `NEXTLEVEL_WORKER_WINDOW` unset and checks that it ran in its own window with a real console (what
  agy needs) and that the job finishes and verifies as usual; the other tests keep workers in the
  background so they don't depend on windows. The test helper removes a variable given as `undefined` or `null` in
  `extraEnv`. Alternative: leave the window path to owner checks on the real PC (slower feedback).
- 2026-09-25 — **Cloud sessions start only with GitHub connected.** Start them at claude.ai/code with
  the repo selected, or with `claude --cloud` after the Claude account is connected to GitHub: without
  that, the session gets a copy with no remote and its work can't be pushed (FR-002). Anything that
  starts sessions for users (`nextlevel fix`, M5) checks the connection first. Alternative: have such
  sessions hand back a patch to apply by hand (manual, and easy to lose).
- 2026-09-25 — **The project is the git root of the current folder, or `--project <path>`.** The tool
  never guesses from where it's installed. Outside a git repo it says so, lists project folders just
  below, and gives the exact commands (FR-001 #1). It refuses to run in its own folder and in a worker
  slot (a worktree under `<project>.slots/`), where `.nextlevel/` state would go to the wrong place.
  Commands that need a commit (`dispatch`, `bridge-test`) stop with the fix when there is none; the
  doctor shows it (FR-001 #2). The hub's own children (`_run`, `_orch`) get the root in
  `NEXTLEVEL_ROOT`, which public commands ignore and workers never see.
- 2026-09-25 — **`nextlevel.json` shape: roles are `{ engine, model }`, `engines.<name>` holds only
  CLI arguments.** A role entry is a profile without an account, so M6 can add named profiles
  (engine + account + model) that roles point to without breaking files; engine settings are shared
  by every profile of that engine. `version` lets an older tool refuse a newer file; unknown keys only
  warn (the doctor lists them); keys starting with `$` are comments. Until M6 the orchestrator must be
  Codex (its commands are still Codex-specific). Alternative: keep settings in `.env` (mixes secrets
  with settings, and can't hold lists or per-role structure).
- 2026-09-25 — **Old names keep working for one release, without moving anything.** Environment
  variables override `nextlevel.json` (`NEXTLEVEL_*`, then the original kit's names, `CODEX_MODEL`, `AGY_MODEL`,
  `CODEX_ARGS`, `AGY_ARGS`, `NTFY_SERVER`); the doctor flags settings still in `.env`, and `init` copies
  them into a new `nextlevel.json`. A project with the kit's state folder and no `.nextlevel/` kept using it, so an
  older hub running on it and this one shared the same files. Slots get `NEXTLEVEL_SLOT`/`_PORT_OFFSET`/`_TASK_ID`;
  `COMPOSE_PROJECT_NAME` is `<name>_w<n>` (`name` in `nextlevel.json`, default the folder name). Alternative: rename
  the old folder on first run (breaks a hub that is still running from the old scripts). The first public version
  dropped the kit's names and folders.
- 2026-09-25 — **Workers no longer inherit `.env` values through the environment.** The hub loads
  the project's `.env` into its own process; before, workers and their verify commands inherited all
  of it (slots had no `.env` file, but the environment carried the values). Now every variable that
  came from `.env` is removed from what workers, their verify commands and the worker CLI see. Checks
  in the main checkout (`verify`) and pushes still get them. Alternative: don't load `.env` in the hub
  (the hub needs `NTFY_TOPIC`, and checks may need project secrets).
- 2026-09-25 — **`nextlevel init` asks per file, and never offers the project's own documents.**
  Files that belong to the team setup (roles, task template, `START.cmd`, `.env.example`, `AGENTS.md`)
  are created when missing; when they differ, init shows a line diff and asks. `BRIEF.md`,
  `docs/STATUS.md`, `HANDOFF.md`, `DECISIONS.md` and `OWNER_NOTES.md` are only created, never replaced.
  Answers can be piped in (one per line); no answer means no, so a non-interactive run never
  overwrites. `.gitignore` entries are checked in the project's `.gitignore` itself (not this PC's
  global excludes), so the protection travels with the repo. Templates go where `nextlevel.json`'s
  paths say.
- 2026-09-25 — **The project's `START.cmd` only finds and starts the tool:** `nextlevel` on PATH,
  else `%USERPROFILE%\.nextlevel\tool\bin\nextlevel.mjs` (where M3's installer will put it), else it
  says the tool isn't installed. Alternative: copy the hub into each project (what M1 removes).
- 2026-09-25 — **`daily-report` is the daily report's name; `report` stays as an alias until M5**
  takes it for field reports.
- 2026-09-25 — **CI runs once per change:** on pull requests, and on pushes to `main` (after merges).
  Before, every push to a pull request branch ran it twice. A newer push to a pull request cancels
  its run in progress.
- 2026-09-25 — **Workers can't push, and git enforces it rather than the worker CLI (FR-003).** agy's
  deny-list didn't stop `git push` on the owner's PC. Now each slot has its own git config
  (`extensions.worktreeConfig`, rewritten at every task start): every remote gets a push URL that
  fails, an empty `pushInsteadOf` sends every other push URL there too, credential helpers are
  cleared, and `core.hooksPath` points at a folder whose `pre-push` refuses. The project's own hooks
  still run there through forwarders. The main checkout, where the hub pushes, keeps its settings.
  Workers also get `GIT_TERMINAL_PROMPT=0`, a `GIT_SSH_COMMAND` that refuses, a dummy
  `GH_TOKEN`/`GITHUB_TOKEN`, and the same credential and push-URL settings through
  `GIT_CONFIG_PARAMETERS`: a worker isn't confined to its slot, and in the main checkout the owner's
  saved login would otherwise work. The hub reads each slot's push URLs back and won't start a worker
  if one still works (a `pushurl` in the shared config can only be cleared per slot from Git 2.46).
  Limit: a worker runs as the owner's own account, so one set on getting around this can still do it
  (`--no-verify` plus its own `-c` settings). These layers stop an agent that follows instructions
  or makes a mistake. Real isolation needs a separate OS account or a container (later).
  Alternatives: trust the deny-list (failed); a separate clone per slot without credentials (loses
  the shared branches the hub reviews); `GIT_CONFIG_COUNT` (Codex can drop `GIT_CONFIG_KEY_<n>`).
- 2026-09-25 — **The bridge test's verdict comes from a remote, not from the workers.** It adds a
  temporary bare remote (`.nextlevel/bridge-remote.git`), both workers try a real push to it by name
  and by path, and the hub checks it for refs and objects. Anything there fails the test, and the
  job records, branches, task specs and remote stay as evidence. A worker that doesn't report trying
  also fails the run, since it proves nothing about pushing. A worker that reports `RAN` with nothing
  arriving passes, with a note that the worker CLI's own rules didn't stop the command. The hub must
  run before anything is dispatched; on Linux and macOS the test now says so instead of queueing
  jobs nobody checks.
- 2026-09-25 — **The doctor reports what it can see.** It reads agy's settings file, so it says the
  deny-list is "configured (not proof it works)" and points to the bridge test for the proof.
- 2026-09-25 — **Setup checks are code with a fake-able context (M2).** Each check in `src/checks/`
  does all its reading and running through `ctx` (`src/checks/context.mjs`), so every check has unit
  tests on a fake PC (`test/fake-context.mjs`) besides the end-to-end tests with stub CLIs. Results
  carry `steps` that name the window to type them in (FR-001 #8); a test rejects a step without a known
  window. Severity decides the exit code: only **error** makes `nextlevel doctor` exit 1; warnings and
  notes are shown but don't fail it (before, a stopped hub made every doctor run "need attention").
  `--fix` runs every offered fix without asking (as it did); the menu's doctor asks before each one;
  fixes that need the owner's own answer (git identity, the Claude GitHub connection) run only there.
  Creating `.env` from `.env.example` stays the one fix the doctor does without `--fix`; `--json`
  changes nothing. Alternative: keep the doctor as one function (can't be tested per check, and the
  dashboard needs structured results).
- 2026-09-25 — **The doctor runs outside a project too.** It checks the tools and reports
  `project.folder` as failed with the way out, instead of stopping at "not a git repository"; the tool
  checks are useful before there is a project. Every other command still stops there. A broken
  `nextlevel.json` is a failed `project.config` for the doctor, not a crash, so the rest still runs.
- 2026-09-25 — **A project's own checks live in `.nextlevel/checks/`, which stays on the PC.** That
  folder is gitignored state, so worker commits can't add code the doctor runs with the project's
  `.env` loaded. A project that wants to share its checks copies them in (the guide or the owner).
  A file that doesn't load becomes a failed check that says why. Alternative: a committed folder
  (travels with the repo, but merges would then change what the privileged doctor runs).
- 2026-09-25 — **A pinned Codex model is tried once, with a one-line prompt (FR-001 #5).** There is no
  way to list the models a login may use, so `codex.model` runs `codex exec` read-only, outside the
  project, and keeps the answer (`.nextlevel/check-cache.json`) until the model, Codex's version or
  the login changes; a timeout isn't kept. The hub runs the check before the orchestrator, the Codex
  setup guide and each autopilot cycle; a rejection stops them (autopilot pauses and notifies) with
  the fix. With no model pinned nothing is run. agy's pinned models are compared with `agy models`.
- 2026-09-25 — **The Claude-GitHub connection is confirmed by the owner (FR-002).** Whether the Claude
  account is connected to GitHub and the Claude GitHub App is on the repo can't be seen from the PC
  with the owner's own logins, so `claude.github` checks what it can (the tool's folder has a GitHub
  remote), shows the two browser steps, and records the owner's "yes" from the menu's doctor in
  `~/.nextlevel/state.json`, saying it's their confirmation. `--fix` alone never records it.
- 2026-09-25 — **The bridge test's verdict is kept for the doctor.** It writes
  `.nextlevel/bridge-test.json` (result, reason, worker CLI and its version); `bridge.test` shows it,
  treats a push that arrived as an error, and asks for a new run when the worker CLI's version changed.
  Added to the state folder next to the file protocol, which is unchanged.
- 2026-09-25 — **The tool is a git clone that updates itself by fast-forward (M3).** The installer
  (`install.ps1`) clones the repository into `%USERPROFILE%\.nextlevel\tool`; an update is
  `git fetch` plus `git merge --ff-only` of the branch the clone follows, so it never rewrites or
  drops anything, and files changed by hand (tracked ones) stop it with the way out. A detached HEAD
  is a pin (`nextlevel update --to <tag or commit>`, also how to roll back); automatic updates leave
  it alone until `--to main`. A version older than the updater itself is refused without `--force`
  (from there nothing could bring the tool back; the message gives the git command that would). Fetches use the GitHub CLI's login for github.com (`-c credential.helper=
  -c credential.helper=!gh auth git-credential`, what gh itself does) with prompts off, so a private
  repository works without `gh auth setup-git` and nothing pops up at start; public, plain git works.
  Alternatives: npm packages (need a registry, and a private one), zip downloads (no history to roll
  back to), a separate update channel (more to host).
- 2026-09-25 — **Owner commands check for updates as they start; orchestrator commands never do.**
  The menu, `init`, `doctor`, `guide`, `run`, `orchestrator` and `bridge-test` fetch (15 s limit) and
  fast-forward, then run again as a new process on the new code, so a fix is used at once (the M5 loop
  re-runs a check after an update). `dispatch`, `wait`, `status` and the rest run many times per
  cycle and never touch the network. `--json` never updates (the dashboard reads it). The first check
  sets `NEXTLEVEL_NO_UPDATE=1` for what the command starts, so the hub's window and workers don't
  check again. A failed check only prints one line and is kept for the doctor (`install.updates`).
  Alternative: a scheduled update (updates would land while nobody watches).
- 2026-09-25 — **No update while a hub or worker runs, in any project on this PC.** A running hub
  keeps its code in memory but starts workers from the files on disk, so an update would mix
  versions. The hub records its project in `~/.nextlevel/state.json`; before installing an update,
  nextlevel checks every recorded project (and the current one) for a live hub (`hub.json` heartbeat)
  or a running worker (`run.json` pid alive, not ended). The fetch still happens and the owner is told
  an update is waiting; `nextlevel update --force` overrides for the explicit command. The installer,
  which may run before any of this exists, looks for node processes whose command line names the
  tool's folder (or npm link's folder) and asks to close them first.
- 2026-09-25 — **The installer makes its own `nextlevel.cmd` in `%USERPROFILE%\.nextlevel\bin` and
  replaces the `npm link` one.** npm link's `nextlevel.ps1` is blocked by PowerShell's default
  execution policy, and its folder moves with how Node was installed (nvm, Volta); a `.cmd` works in
  PowerShell and cmd whatever the policy. The folder is appended to the user's PATH through the
  registry API, keeping other entries unexpanded (REG_EXPAND_SZ), and Explorer is told so new windows
  get it. A link npm made to the tool's own folder is removed only once the new command is on PATH;
  a link to another folder is reported, never touched. `_install` does this (the installer runs it,
  and `doctor --fix` for `install.command`); it's Node so both platforms test it. The installer is a
  thin PowerShell script (ASCII, no `exit`: it runs through `iex` in the owner's window) that gets Node,
  Git and the clone right, then hands over.
- 2026-09-25 — **A hand install is taken over, not replaced.** The M1 owner check cloned a pull
  request's branch into the install folder and ran `npm link`. The installer keeps that clone, fetches,
  switches it to `main` (the old branch stays), fast-forwards, and swaps npm link's command for its
  own. A folder there that isn't a git clone is renamed `tool.old-<time>`, never deleted; a clone of
  another repository stops it. `NEXTLEVEL_REF` installs a branch or tag instead of `main`.
- 2026-09-25 — **Doctor rows say their fix once.** A row's one-line hint (`next`) explains; the steps
  under it carry the commands. The "GitHub repo" row showed `gh repo create ...` in both (and in
  "PowerShell" wording on Linux); seven other rows had the same pattern. A test checks that no hint repeats a
  step's command line.
- 2026-09-25 — **Tests stub every tool the doctor calls.** Docker, Claude Code and `powercfg` got stubs
  like agy, codex and gh: the doctor must not wait on a real Docker engine (on the Windows runner the
  suite's first doctor run took 18-26 s because of a cold `docker info`; with the stub it takes 3 s),
  must never run the real `claude`, and `doctor --fix` must not change the runner's power settings.
- 2026-09-25 — **The dashboard's Setup page is the doctor's JSON, and Fix is `doctor --fix <id>`
  (M4).** The dashboard runs `nextlevel doctor --json` in a child process, as the owner would, so the
  page shows exactly what the doctor sees (the project's own checks, its `.env`, redaction) and the
  server holds no check code of its own. A Fix button runs `doctor --fix <id> --json`, which fixes that
  one check with a ui that has no window: no questions, nothing printed but the JSON, and what the fix
  said comes back in `fix.log`. A result's `autoFix` says whether the button is offered: a fix that
  installs or updates a program is marked `fixInWindow` (every `tool.*` check), because installers ask
  for permission, show progress and change PATH for new windows only; those run only from the doctor
  in the owner's own window, and the page shows their commands with the window to type them in. Fixes
  that need the owner's answer (`git.identity`, `claude.github`) stay in the menu's doctor. A registry
  test lists every fix the dashboard may run, so a new fix is classified on purpose. `--json` alone
  still changes nothing. Alternative: run the checks inside the server (faster, but a second way to
  run them, and a stale module could disagree with the doctor after an update).
- 2026-09-25 — **The dashboard answers only this PC and only its own page.** It listens on 127.0.0.1
  (never 0.0.0.0) on a port the OS picks, with 24 random bytes as a token in the link it opens. The
  token is kept in memory only (`.nextlevel/ui.json` holds the pid and port), needed for every request
  but the page's own static files, sent by the page in a header (POSTs accept nothing else, so another
  site's form can't carry it), compared in constant time. The `Host` header must be `127.0.0.1:<port>`
  or `localhost:<port>`, so a page elsewhere that points a name of its own at 127.0.0.1 (DNS rebinding)
  gets nothing; POSTs must be JSON from the page's own origin. Responses carry a strict CSP and
  `Referrer-Policy: no-referrer` (the link holds the token). Everything sent is redacted like check
  results, except `docs/OWNER_NOTES.md`, which the page edits (redacting it would write `***` back).
  Limit: a program running as the owner on the same PC can do what the dashboard does anyway; the
  token keeps out web pages and other machines, not the owner's own processes.
- 2026-09-25 — **One dashboard per project, found again by START.cmd.** START.cmd -> d opens
  `nextlevel ui` in a window of its own (Windows; elsewhere it says to run it in another terminal).
  If one already runs for the project (`ui.json` heartbeat), `nextlevel ui` and the menu leave a
  request file (`.nextlevel/ui-open.json`) that the running one takes within 1.5 s and opens its page
  again, since only it has the token. The page's files are read once at start, so an update of the
  tool doesn't change a running page under it; what it starts (doctor, hub) runs the code on disk.
- 2026-09-25 — **The dashboard starts the hub like START.cmd -> 4, and stops it with a request.** On
  Windows the hub gets its own window, as from the menu, which the owner knows how to close; on
  Linux and macOS, and with `NEXTLEVEL_HUB_WINDOW=0` (tests), it runs in the background with its console
  output in `logs/hub-console.log`. Stop writes `.nextlevel/hub-stop.json`; the hub takes it at its next
  tick, finishes the verifications in progress and exits, while workers keep running (the next hub
  picks their results up). A hub from before this version doesn't know the request: after 15 s the page
  says to close its window. The request file is new next to the file protocol, which is unchanged.
  The orchestrator and the setup guides open through `nextlevel orchestrator` and `nextlevel guide`, in
  windows of their own on Windows only; elsewhere the page shows the command to type.
- 2026-09-25 — **A hub started by another nextlevel still keeps `.env` values from its workers.** The
  menu (START.cmd -> 4) and the dashboard load the project's `.env`, and the hub they start inherited
  those values; the hub's `loadEnv` leaves variables that are already set alone, so it recorded none as
  coming from `.env`, and workers and their verify commands got every secret. Now every variable whose
  value is the one in `.env` counts as a `.env` value, however it got there. (Found while building the
  dashboard's Start button; the M1 test only started the hub directly.) A variable the owner set to a
  different value in their own window is still theirs.
- 2026-09-25 — **A long-running dashboard picks up PATH changes from installers (Windows).** An
  installer adds its folder to the registry's Path, which only windows opened later get (FR-001 #4), so
  a dashboard opened before `winget install GitHub.cli` would keep reporting gh as missing. Before it
  runs the doctor or starts anything, it adds the machine's and the user's Path from the registry to its
  own, after the folders it already has (which keeps the tests' stub CLIs first).
- 2026-09-25 — **Workers in a window of their own show progress through git.** agy needs a real console
  on Windows, so its output is in its window and not in a file the page could follow. For those the
  Build page shows the task branch's commits and the files changed in the slot so far; background
  workers (Codex, CI) show the end of `worker.log`, and a job being verified the end of `verify.log`.
- 2026-09-25 — **The orchestrator's git writes are hub jobs (FR-004 #1).** Codex's sandbox keeps `.git`
  read-only on every OS, so `git commit` and `git merge` from the orchestrator needed the owner's
  approval each time and autopilot stalled. `nextlevel commit -m "..." [<path>...]`, `merge <task-id>`
  and `cleanup <task-id>` queue a job of the new type `git` that the hub runs in the main checkout, like
  `push`. Git jobs get a lane of their own (one at a time, in order) so a commit never waits behind a
  half-hour `verify`. The command waits for the result (`--no-wait` only queues), prints it, and marks
  it reviewed, so these jobs don't pile up for review or wake autopilot. Without a running hub nothing is
  queued (exit 2): a commit that runs hours later would take whatever is there then. Git runs without a
  shell (the message goes in a file, `-F`), the project's own hooks run as usual, and every git command
  is logged. A merge conflict is undone at once (`git merge --abort`), `main` stays as it was, and the
  result names the files and the retry to send. Commit and merge refuse unless the main checkout is on
  the base branch with no merge in progress. The bridge test, run by the owner, still deletes its
  branches directly. The file protocol gains the job type `git` and `jobs/<id>/git.log`; nothing existing
  changes, and a hub never meets a newer command's job, since the tool doesn't update while a hub runs.
  Alternatives: add `.git` to Codex's writable roots (needs `-c`, see below, and lets the orchestrator
  write git hooks, which are code that runs outside the sandbox); full access for the orchestrator.
- 2026-09-25 — **A check or git job left "running" by a hub that stopped is marked lost** when the next
  hub starts; before, `wait` on it hung until its time ran out.
- 2026-09-25 — **The doctor knows when it runs inside Codex's sandbox (FR-004 #2).** Signs: `CODEX_SANDBOX`
  (macOS), `CODEX_SANDBOX_NETWORK_DISABLED` or `SBX_NONET_ACTIVE` (no network), or, only when Codex ran it
  (`CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_CI`), a `.git` it can't write: Windows' elevated sandbox
  sets no variable, and the probe (a file created and deleted in `.git`) runs only under Codex. There a
  failing check that looks beyond the project becomes "can't tell" (a skip, without steps), because a
  passing result is true outside too but a failure isn't; checks that need the network (`codex.model`,
  `codex.version`) don't run, since a wrong answer would also be cached; checks that only read the
  project keep their result (`sandbox: 'same'`); fixes that write outside the project don't run. The
  `window.sandbox` row says how to see the real state. The hub and the bridge test refuse to start
  there. The orchestrator gets the real state with `nextlevel verify doctor -- nextlevel doctor`.
  Under Codex (its variables, or a sandbox sign) the hub counts as running on its heartbeat alone: Codex's
  Linux sandbox hides other processes, so `wait` and `commit` saw a running hub as stopped.
  Alternatives: refuse to run the doctor in the sandbox (the setup guide on Codex needs what it can see);
  guess from the user name of Windows' sandbox accounts (undocumented).
- 2026-09-25 — **The model Codex will actually use is tried, and Codex is compared with its latest
  release (FR-004 #3).** With no model pinned, `codex.model` used to pass without asking; now it probes
  Codex's own choice too (`model` in its `config.toml`, else the account's default), cached by that
  value, Codex's version and the login. The latest release comes from Codex's own update check
  (`version.json`, while under three days old) or `npm view @openai/codex version` (kept a day), so the
  doctor never needs GitHub's API; offline, the row says it couldn't check and passes.
- 2026-09-25 — **Broken Codex hooks are shown like broken MCP servers (FR-004 #4)**, as a warning: they
  run around every tool call. A command counts as broken only when that is certain: its program isn't
  found (or is Python's Microsoft Store placeholder) or a script it names by its full path isn't there.
  Relative paths and unknown variables aren't judged. For a plugin, only its newest cached version counts.
- 2026-09-25 — **Notifications never carry a bare `.md` file name (FR-004 #5).** `notify()` itself strips
  the `.md` of any file name outside a link, so nothing can send one; before that, the hub turns each name
  of a committed file into a link to it on GitHub (the base branch), and a notification that mentions the
  handoff file gets its open items (the request itself) and a link to it. The daily report goes through
  the same. Alternatives: zero-width characters to stop phones making links (invisible, and copied along);
  ntfy's Markdown mode (whether the phone still makes links there can't be tested here).
- 2026-09-25 — **No `-c` in Codex's arguments (FR-004 #6).** Codex (0.157) runs interactive sessions in a
  shared background server and leaves any session with a `-c`/`--profile` override out of it, with a
  warning each time; `-m` and `--sandbox` are fine. The default `engines.codex.args` lost
  `-c sandbox_workspace_write.network_access=true`: the orchestrator needs no network. The `codex.args`
  check takes it out of older `nextlevel.json` files, which it rewrites in the file's usual layout
  (`formatConfig`). Codex *workers* now have no network in their sandbox either; an owner who wants it
  sets `[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml` (there is no flag).
- 2026-09-25 — **Slot port offsets are unique per PC (FR-004 #7).** Each project gets a block number in
  `~/.nextlevel/state.json` ("portBlocks", by project folder, under a lock file) the first time its hub
  starts; slot n of block b gets b × 1000 + n × 100, so block 0 keeps the old 100, 200, ... and the first
  project's services keep their ports. 40 blocks (an offset below 40 000, so a base port up to about
  25 000 stays valid); a block whose folder is gone is given out again. `COMPOSE_PROJECT_NAME` stays
  `<name>_w<n>`: it already differs between projects with different names.
- 2026-09-25 — **The interactive orchestrator keeps going (FR-004 #8).** Its prompt says it is an
  interactive session and to keep working until something needs the owner; the template has the loop
  (wait with `wait --any`, review, merge, dispatch; end the turn only for the owner), and `dispatch` and
  `wait` print the next step. As a safety net the hub notifies the owner once per set of finished jobs
  that have waited 15 minutes for review while an interactive orchestrator runs. Alternative: have the
  hub type into the orchestrator's window (no such interface, and fragile).
- 2026-09-25 — **Role docs from an older template are recognised by hash.** `init` copies templates into
  the project, so an update of the tool never reached them and a real project's orchestrator kept its old
  instructions. `project.role-docs` knows the sha-256 of every earlier nextlevel template of the
  orchestrator and guide docs (normalised line ends): such a file has nothing of the owner's in it, and
  the fix replaces it. An orchestrator doc of the owner's own that doesn't use the hub's git commands
  gets `nextlevel init` (a diff, and a question). The original kit's own (pre-M1) versions are left to M7.
- 2026-09-26 — **A field report holds nextlevel's own facts only, and is filed exactly as the owner read
  it (M5).** `nextlevel report [check-id]` runs nextlevel's checks (never a project's own
  `.nextlevel/checks/`, whose results are about the project) and writes Markdown: the failed checks with
  their steps, versions, the OS, paths, every check's one-line result and the last 40 hub log lines. No
  project code, brief, task or `nextlevel.json` beyond the roles. Everything goes through `redactReport`:
  the checks' `redact()` (token shapes, logins in URLs, `.env` values), more token shapes (private keys,
  JWTs, AWS, Stripe, npm, GitLab, `Bearer`), every `.env` name's `NAME=value` (so short values go too),
  the values of this window's variables whose names say secret, and the home folder as `~`
  (`%USERPROFILE%`). The `.env` values go first, longest first (in the checks' `redact()` too): once a
  pattern had changed part of one, a login or a token inside it, the rest would stay. Hub log lines are
  redacted before they are cut to 300 characters, for the same reason. The text is kept in
  `~/.nextlevel/reports/<id>.md` and printed between rules; the owner may edit it there to leave
  something out, and `report --send <id>` then shows their version (redacted again) and asks. Only
  a "yes" files it (`gh issue create --body-file`, so nothing is quoted through cmd), with the
  `field-report` label (made if missing, left off if gh may not). The dashboard shows the same text and
  sends it back by id and hash (`report --send <id> --hash <h>`), so what is filed is what was shown;
  if the page's own redaction would still change the text, it is neither shown nor filed. Alternatives:
  a zip bundle (can't be read on the page before sending), letting the model write the report (could
  pick up anything it saw).
- 2026-09-26 — **`nextlevel fix` starts a cloud session from the tool's clone, and only once
  `claude.github` passes (FR-002).** `claude -p --output-format json --cloud "<prompt>"` in
  `~/.nextlevel/tool`: the session clones that folder's GitHub remote (never the project, which
  `claude --cloud` would otherwise upload), `-p` returns once it is created, and the JSON has its link.
  `CCR_FORCE_BUNDLE` and the project's `.env` values are taken out of its environment. When the check
  fails, the owner can confirm the two browser steps right there (the same record the menu's doctor
  keeps), or take `--local` (Claude Code in the owner's window, in a worktree of the tool's clone at
  `~/.nextlevel/fixes/issue-<n>` on `fix/issue-<n>`, so the installed tool stays on `main`, clean, and
  keeps updating), or start it at claude.ai/code with the prompt shown. The prompt is one line without
  quotes or `%` (it goes through cmd.exe to `claude.cmd`) and asks for a test first, a field-report
  note, "Fixes #n" in the pull request and both CI jobs green. Alternative: run the session in the
  project (it would upload the project's code).
- 2026-09-26 — **`nextlevel fix` runs `claude --cloud "<prompt>"` in the owner's window and gets the
  session from Claude Code's debug log (FR-006).** This replaces the `-p --output-format json` form
  above: Claude Code 2.1.282 refuses `-p` with a new cloud session, and plain `--cloud` needs a terminal
  (it refuses a pipe, and may ask the owner something first), so nextlevel can't read the View line it
  prints. It runs in the owner's window, where those lines show, with `--debug-file` in a temporary
  folder (removed afterwards); the "created remote session" line there has the session's id, and only
  that line counts as a started session. The dashboard has no terminal, so it gives the command for
  PowerShell. Alternatives: a pseudo-terminal to read the View line (nothing in Node or Windows without
  native code), reading the console's screen buffer back (fragile in Windows Terminal), asking the owner
  to paste the link (a step a program can take), the dashboard opening a window of its own for it
  (possible later; the owner would still answer Claude Code there).
- 2026-09-26 — **`nextlevel report` offers the doctor's automatic fixes first (FR-006 #2).** A report is
  for what nextlevel can't fix by itself, so the fixes for the checks it would report are offered
  first, each with the doctor's own question; one that fixes its check leaves nothing to report. The
  text says only what nextlevel knows (the fix ran just before, was declined, or the command for it),
  never that the owner tried the steps. Only those checks' fixes are offered, not every failing check's.
  The dashboard's page offers the check's Fix button first. Alternative: file first and let the
  Claude Code session find that a fix existed (a report and a session for nothing).
- 2026-09-26 — **Only an issue a merged pull request closed has a fix (FR-006 #4).** GitHub closes an
  issue as completed both when a pull request with "Fixes #n" is merged and when someone closes it by
  hand (its default), so the loop reads the close event's `closer` (`gh api graphql`): a merged
  `PullRequest` is the fix, which is installed and checked again; anything else (by hand, as completed or
  not, by a commit, or by a pull request that wasn't merged) is "closed without a fix", and the owner
  hears so once. This replaces "closed as completed" in the entry below. Alternatives: the issue's
  `closedByPullRequestsReferences` (open pull requests only, by default, and a mention isn't a close);
  asking the owner (they may not know which way it was closed).
- 2026-09-26 — **The fix loop follows the issue, not the pull request.** A pull request that says
  "Fixes #n" closes the issue when it is merged, so nextlevel asks `gh issue view` (at most every 10
  minutes per fix; at once right after nextlevel updated itself, and with `nextlevel fix`). Closed as
  completed: nextlevel fetches and notes `origin/main`; the fix is installed once that commit is in the
  tool's `HEAD`, however it got there (a start's update, `nextlevel update`, the hub). Then the report's
  checks (named at the top of the issue) run again in a new `doctor --json` process, on the new code, and
  the owner's phone hears "fixed" or "still fails" (with `nextlevel report <id>` to report it again).
  Closed as not planned: the owner hears that. Fixes are kept in `~/.nextlevel/state.json` with the
  project they came from; owner commands of that project and its hub follow them, and every project follows
  those started outside a project (a report about the tools). A fix the owner starts some other way (the
  dashboard gave the prompt for claude.ai/code) is followed too. `state.json` is now written to a file of
  its own and renamed over the old one, so the hub and an owner's command never read it half written. Alternative: watch the
  pull request (the session opens it later, and it may be replaced by another).
- 2026-09-26 — **An idle hub updates itself for a merged fix.** Updates never go in while a hub runs
  (M3), and a hub runs for days, so a merged fix would wait for the owner to restart it. When a fix it
  follows is merged and nothing runs (no job queued or running, no verification, no autopilot cycle, no
  orchestrator open, no other project's hub or worker), the hub stops its loop, runs `nextlevel update` and starts itself again
  on the new code in the same window (as an owner command does after an update); once an hour at most.
  The new hub runs the report's checks again. An owner who set `NEXTLEVEL_NO_UPDATE` keeps it: nextlevel
  now sets that variable to `checked` for what its commands start after their own update check, so the
  owner's own value can be told apart. Following the fixes runs beside the hub's loop (a report's checks
  take a doctor run), so the heartbeat and the jobs go on meanwhile. Alternative: update the files under a
  running hub (workers would start from newer code than the hub's).
- 2026-09-26 — **The tool's GitHub repository comes from its configured remote URL.** `claude.github`
  and the report read `git config remote.origin.url` in the tool's clone rather than `git remote
  get-url`, which applies the PC's `url.<base>.insteadOf` rewrites (the tests' fake GitHub is one; a
  mirror would be another) and would then say the clone has no GitHub remote.
- 2026-09-26 — **A `.env.example` the project has changed is its own (FR-005).** `init` offered the
  generic template in place of a real project's own `.env.example`, and a "yes" lost its keys. Now it
  is replaced only while it is an unchanged nextlevel template (every version's hash is in
  `src/lib/templates.mjs`, and a test makes sure the current one is); otherwise it is kept like
  `BRIEF.md`. The `project.env-example` check finds a project whose own file was already replaced (git
  has a version of the project's before the template) and puts it back. Alternative: never replace
  `.env.example` at all (an unchanged older template would never get the current one).
- 2026-09-26 — **`nextlevel report` is the field report now.** Until M5 it was an old name of
  `daily-report`; the menu, the hub and the docs use `daily-report`.
- 2026-09-26 — **Engines are adapters; any engine can take any role (M6).** Everything nextlevel knows
  about driving a CLI lives in `src/engines/<name>.mjs` behind one interface: the program, its version
  and sign-in commands, the arguments of a headless run and of an interactive session (per role),
  whether a headless run needs a console window of its own (`needsRealConsole`: agy on Windows), whether
  its sessions can write `.git`, the variable that moves its folder for a second account, and its known
  issues. The hub asks the adapter and has no engine names in its code paths any more (only the Codex
  model check before an orchestrator session, which is a doctor check). Codex, Antigravity and Claude
  Code each take the orchestrator, worker and setup guide roles. Alternative: keep the engine `if`s in the
  hub (every new engine touches every command).
- 2026-09-26 — **Roles are filled by profiles; the default team is unchanged.** A profile is an engine,
  the account it's signed into and a model. In `nextlevel.json` a role is `{ engine, model }` as before
  (a profile on the engine's own login), or `{ profile: "<name>" }` naming one of `profiles`
  (`{ engine, account, model }`), so the same engine can appear twice with different logins. A profile
  may not have an engine's name (a name must mean one thing), and a role gives a profile or an engine, not
  both. New files get `profile` and `fallback` in each role and an empty `profiles`, so they can be seen;
  files from before M6 read exactly as they did (Codex orchestrates, Antigravity works), and the
  version stays 1: the new keys are optional, and an older nextlevel only warns about them (owner
  commands update it first anyway).
- 2026-09-26 — **A second account is a folder of its own, and nextlevel never touches a sign-in.** A
  profile's `account` gets `~/.nextlevel/accounts/<engine>/<account>`, and its sessions run with the
  variable that points the CLI there: `CODEX_HOME` (Codex; a keyring login is named after the folder's
  path, so two folders stay apart in every credential store) or `CLAUDE_CONFIG_DIR` (Claude Code; its
  docs suggest it for several accounts side by side), always the same absolute path (Claude Code's macOS
  Keychain entry is named after the path as written). Such a session gets no `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`, which would win over the folder's sign-in. The
  owner signs each account in with the CLI's own login (`nextlevel login <profile>` runs it in their
  window with the folder set); nextlevel only asks the CLI's own status command, and never reads, copies
  or moves a credential (Anthropic's terms forbid tools that intermediate Claude.ai credentials).
  **Antigravity can't do it:** agy has no setting for where it keeps its sign-in (issues
  google-antigravity/antigravity-cli#155 and #381 ask for one), so a second account would silently be
  whichever one agy is signed in with. The doctor says so plainly (`profiles.accounts`), and the hub
  starts nothing on such a profile. Alternatives: a different `HOME`/`USERPROFILE` for agy with its
  token forced into a file (unofficial, untested, breaks git and npm for that process, and a known bug
  in containers), or swapping credential files (touches sign-ins, and two sessions at once would fight).
- 2026-09-26 — **A fallback is for a setup that isn't ready, never for a provider's limits.** Each role
  may name a `fallback` (a profile or an engine); the workers fall back to Codex by default, as the
  orchestrator's escalation always did. A worker's task goes there when the orchestrator asks
  (`retry <id> --fallback`); the orchestrator goes there when its own engine isn't ready (not installed,
  its account can't be used, Codex's model rejected): `nextlevel orchestrator` says so and offers
  `--fallback`, and autopilot runs its cycles there, telling the owner's phone once. nextlevel doesn't look
  at usage or rate limits at all and never moves work between accounts because one ran out: each account
  is the owner's own, used within its provider's terms (OpenAI's forbid getting around rate limits).
  Without a fallback the orchestrator pauses as before M6. Alternative: switch on any failed session
  (would also switch on quota errors).
- 2026-09-26 — **Claude Code's roles are set by its permission rules.** `claude -p` runs headless (a new
  *cloud* session is what needs a terminal, FR-006), and nothing sandboxes `.git` for it, so what each role
  may do is in its arguments: a worker edits in its slot and runs any command but the ones agy's deny-list
  names (`--permission-mode acceptEdits --allowedTools Bash,WebFetch,WebSearch --disallowedTools
  "Bash(git push:*),..."`, one list in `src/engines/rules.mjs` for both); an orchestrator runs the hub's
  commands and git that only reads without asking, and never git writes (`--disallowedTools
  "Bash(git commit:*),..."`): its git writes go through the hub as on every engine (Codex's sandbox can't
  write `.git`, and the hub keeps them in one lane, logged). The setup guide gets no rules: it asks the
  owner. The prompt comes first (the rule options take several values), and tells Claude Code to read
  `AGENTS.md`, which it doesn't read by itself. Alternative: `--dangerously-skip-permissions` for workers
  (refused as root, and deny rules are the layer we want anyway).
- 2026-09-26 — **An autopilot cycle on an engine that needs a console gets a window of its own.** agy's
  print mode needs a real console on Windows for any role, so a cycle on agy runs in a window
  (`nextlevel _cycle`), which writes `.nextlevel/cycle.json` (pid, then end and exit code); the hub follows
  it as it follows a worker's `run.json`, and stops it after 60 minutes. `NEXTLEVEL_WORKER_WINDOW=0` keeps
  it in the background like workers (CI). `cycle.json` is new next to the file protocol, which is
  unchanged (`job.json` gains `profile` and `account`, which older hubs ignore).
- 2026-09-26 — **`bridge.test` reads the hub's log when no verdict was kept (FR-007).** Bridge tests that
  ran before `bridge-test.json` existed left only log lines ("started T000-bridge-1 ..."), and the doctor
  said "not run yet". It now says the test ran, on which day, and to run it again for a saved verdict;
  the log isn't a verdict (it doesn't say whether anything reached the test remote), so the row still
  warns.
- 2026-09-26 — **The dashboard opens on Home, and every "needs you" item carries its one action (M9).**
  The Build page answered "what is going on" only for someone who knew where to look. Home answers it for
  the whole project: whether the team runs, one sentence per running task (the spec's title, and on a
  retry the first sentence of the orchestrator's last feedback: no model writes the sentence), what needs
  the owner in a fixed order (a setup error, the hub stopped with work, paused autopilot, task alerts,
  handoff items, finished work nobody reviews, nothing planned) with the first one as the "Next" button, and
  the day's numbers. The order is computed on the server (`lib/overview.mjs` `ownerNeeds`) from the hub's
  state and the doctor's last results, so it is tested without a browser. Alternative: a smarter summary by
  a model (costs tokens on every refresh, and could be wrong about the state the hub knows exactly).
- 2026-09-26 — **A role's effort is a setting of its own, and reaches each engine its own way.** `effort` in
  a role, profile or fallback ('' is the engine's own). Claude Code and agy take `--effort`; the role's
  replaces the `--effort` in `engines.agy.args`. Codex has no flag: `codex exec` gets `-c
  model_reasoning_effort=<e>` (exec never uses Codex's shared background server, so FR-004 #6 doesn't
  apply there), and Codex's interactive window gets none, so it keeps Codex's own effort, which the Team
  page says. Alternatives: write the effort into Codex's `config.toml` (changes every Codex session of the
  owner's, the ones outside nextlevel too), or `-c` in the interactive window too (the warning at every
  start the owner reported).
- 2026-09-26 — **"The engine's own choice" is shown as the real model where the engine's files say it.**
  Codex: `model` and `model_reasoning_effort` in its `config.toml` (what `/model` saves), else the
  account's default: the lowest-priority listed model in `models_cache.json`, with that model's default
  effort. Claude Code: `ANTHROPIC_MODEL`, else `model` and `effortLevel` in its `settings.json`. agy:
  `model` in `~/.gemini/antigravity-cli/settings.json` (a label, as agy saves it). The file it came from is
  shown next to it; nothing is run to find out, so the page stays cheap. Each job records the model and
  effort it started with (`status.json`: `model`, `effort`, `modelOwn`). Alternative: ask each CLI (slow,
  and Claude Code has no command for it).
- 2026-09-26 — **A team change is checked with the doctor's own checks before it is saved, and never
  interrupts work.** `nextlevel team set <role> --engine E --model M --effort X` (the Team page runs it)
  applies `nextlevel.json`'s rules to the changed file, then `tool.<engine>`, `<engine>.login`, the model
  check (`codex.model`, `agy.model`, the new `claude.model`, which asks Claude Code once with a one-line
  prompt and keeps the answer) and `profiles.accounts` on it; only when they pass is the file written
  (only an error about the role being changed blocks; warnings are shown with the result, see below). The
  running hub reads `nextlevel.json` again when it changes (its size and time), so the next autopilot round
  and the next task use it; a task dispatched on
  the worker role (no `Engine:`/`Profile:` line or flag) is recorded with `role: "worker"` and takes the
  role as it is when it starts. A round or task already running keeps what it started with. A file that
  doesn't load leaves the hub on its old settings, and says so in its log. Alternatives: restart the hub on
  a change (stops verifications in progress), or let the page write the file directly (nothing would stop
  a model the account can't use).
- 2026-09-26 — **The setup guide is a role, and a fallback can be an engine with its own model and effort.**
  `roles.guide` without an engine is the orchestrator's (as before), so old files read the same; with one,
  `nextlevel guide` and the menu open it there. A fallback stays a profile's or engine's name, or becomes
  `{ engine, model, effort }` when the Team page gives it a model or effort; `retry --fallback` carries
  that model and effort in the job. The guide and fallbacks count as "only a fallback" for the doctor's
  severities (warn): the build team doesn't stop without them.
- 2026-09-26 — **The day's numbers come from what the hub already sees.** `.nextlevel/usage.json` per day
  (two weeks kept): autopilot rounds and their minutes, finished task attempts and their minutes, and
  Codex's tokens from `codex exec`'s own last line ("tokens used" and the number, with the PC's thousands
  separators, on stderr) in the logs of rounds and background workers. An interactive window's tokens and
  other engines' aren't in any log nextlevel has, so they aren't counted, and the page says where the number
  comes from. Alternative: read Codex's session files (undocumented format, and they mix in the owner's
  other work).
- 2026-09-26 — **Task alerts: past three attempts, or past the time limit.** The orchestrator's rule is two
  attempts, then the fallback, then fix it or split it; a fourth attempt means that didn't happen. A task
  running past its limit is stopped by the hub at the limit plus three grace periods; until then the owner
  sees it. Each alert is on Home and goes to the phone once per task, attempt and kind.
- 2026-09-26 — **The installer takes a folder, and moves an install there rather than making a second.**
  `$env:NEXTLEVEL_DIR` names it; the existing clone (where the last install was, kept in
  `~/.nextlevel/state.json` "tool" by `nextlevel _install`, else `~/.nextlevel/tool`) is moved there with
  `Move-Item`, so its branch, pin and anything else in it come along, and `git worktree repair` points
  `nextlevel fix --local` worktrees at it. The command in `~/.nextlevel/bin` is made again for the new
  folder; self-update needs nothing (it works on the folder the code runs from). Nothing runs from either
  folder while it moves (the installer checks, on Windows). A folder that can't be moved into (another
  drive, a file in use) gets a fresh clone and the old one is left, unused. A named folder that has other
  files in it is refused (the default folder's non-clone content is still moved aside, as before). The
  next run without `NEXTLEVEL_DIR` stays in the new folder. START.cmd also looks for the command in
  `~/.nextlevel/bin`, which is where it is wherever the tool lives. Alternatives: a `nextlevel move`
  command (the tool moving the folder it runs from, on Windows, where that folder is locked), or a second
  clone (two installs, one of them stale).
- 2026-09-26 — **The hub does the git steps around a worker whose sandbox can't write git (FR-008).** Codex's
  sandbox keeps a slot's git folder read-only (it lives under the main checkout's `.git/worktrees/`), so a
  Codex worker can neither merge the base branch in nor commit. The hub already committed what a worker
  left; now it also merges: before a retry whose latest feedback asks for the base branch ("merge main",
  "rebase on main"), on any engine, and before every retry on an engine that can't write git (`writesGit`
  false, and no `danger-full-access` in its arguments). The merge runs in the slot with the worker's
  environment (the project's hooks run, and never see a `.env` value) and is logged in `jobs/<id>/git.log`. A
  conflict is left in the slot for the worker: its files keep git's markers, `TASK.md` lists them, and
  resolving them needs no git; the hub commits the merge when the worker finishes, but never a file that
  still has markers (the job fails, and the worker's changes are kept in `unresolved.diff`). A merge that
  stops for another reason is undone. Its commit uses the `Commit:` line of the worker's report.
  Alternatives: give Codex workers `--sandbox danger-full-access` (no sandbox at all for an unattended
  worker), abort on a conflict and fail the job (the orchestrator can't merge either, so the task would
  never move), or rebase (rewrites commits the orchestrator has reviewed).
- 2026-09-26 — **Why a job ran on its engine is recorded, and a worker-role task falls back by itself only
  when the role's engine can't start.** `engineWhy` on each task: the worker role's, the spec's line, the
  orchestrator's `--engine`/`--profile`/`--fallback`, the attempt before, or an automatic fallback with the
  check that caused it (`tool.<engine>`, `profiles.accounts`, `codex.model`: `engineProblem`, the same
  test autopilot uses for the orchestrator). An engine the orchestrator or the spec named is never
  swapped. `.nextlevel/switches.json` keeps the last 50 switches (tasks on another engine than the
  workers', autopilot rounds going to and back from the orchestrator's fallback, the orchestrator opened
  with `--fallback`) for Home. A fallback is still for a setup that isn't ready, never for usage limits.
- 2026-09-26 — **The day's numbers per role and engine, with tokens where the engine reports them
  (FR-008).** `usage.json` gets `by["<role>:<engine>"] = { runs, minutes, tokens, cached, reported }` next
  to the old totals. Tokens are counted like Codex's `tokens used`: input without cache reads, plus output.
  Codex: `tokens used` in `codex exec`'s output; its interactive windows (the orchestrator's, the guide's,
  which now runs through `nextlevel _guide` so its end is seen) from its session files: this supersedes the
  earlier "don't read Codex's session files": they are read only for sessions that started in the
  project's folder while nextlevel's window was open, not `exec` ones, and each file once. Claude Code:
  headless runs ask for `--output-format json` (text mode prints only the final answer anyway), and the
  dashboard shows that JSON as the answer. Antigravity: "not reported". Its `--output-format json` has a
  usage object, but on Windows its print mode must write to a window of its own that nextlevel can't read,
  and its `--log-file` has no counts; asking it for JSON on other systems only would change what the owner
  sees in its window for numbers on a platform the owner doesn't use. Interactive Claude Code and agy
  windows count minutes only. "reported" says how many runs gave a number, so a sum is never passed off as
  complete.
- 2026-09-26 — **Each attempt's part of worker.log is where the file ended when it started.** The attempts
  of a task keep sharing `worker.log` (the file protocol and older logs stay as they are); `status.json`
  gets `logFrom` (its size when the attempt started) and `window` (the worker writes to a window of its own).
  The page shows that part only and names the attempt; an attempt in a window shows the hint, never the
  file's older lines. A job an older hub started is found by its worker's header line. Alternative: a file
  per attempt (`worker-2.log`: a protocol change for what reads `worker.log`).
- 2026-09-26 — **Show activity: progress notes the worker writes, and a feed read from what the engine prints (M10).**
  Two layers, because the owner wants the why and the what. The why: every worker adds one line to
  `.nextlevel-task/PROGRESS.md` every few steps (WORKER.md, and the worker's prompt for workers on an older
  WORKER.md). A file in the slot works on every engine, Antigravity's window included; the hub empties it when an
  attempt starts and copies it to `jobs/<id>/PROGRESS.md` when it ends (a new file beside the job, nothing in the
  file protocol changes). The what: headless runs now ask Claude Code for `--output-format stream-json --verbose`
  (its steps as JSON lines; the last line is the same result with `usage` as before) and Codex for `exec --json`
  (its items; the tokens come from `turn.completed`, since it prints no "tokens used" then), and each adapter's
  `feed()` turns them into events: commands with a test summary or their last line, files edited, messages,
  errors. Reads (Read, Grep) and plans are left out, to keep the feed about what changed. Everything shown is
  redacted with the report's redaction (every `.env` value and name, token shapes, NAME=value, the home folder),
  before and after the JSON is read, and each line is cut after it is redacted. The page asks for a task's
  activity (`/api/activity`) every 2 seconds only while its toggle is open; the build data carries only the latest
  note. Which toggles are open is kept in the browser's localStorage, which is per address, so the dashboard now
  tries the port it had last time first (`.nextlevel/ui-port.json`). Antigravity has no feed: on Windows its steps
  go to the console window print mode needs; `--log-file` only moves the CLI's own diagnostic log (following that
  file wouldn't disturb the window, but it doesn't list what agy ran), and its per-conversation transcript
  (`~/.gemini/antigravity-cli/brain/<id>/.system_generated/logs/transcript.jsonl`) can't be matched to a task, since
  nothing gives the hub the conversation's id, and reading the folder would mean reading the owner's other agy
  conversations. Alternatives: a pseudo-terminal around agy (a dependency, and FR-001's console problems), or
  guessing the newest transcript.
- 2026-09-26 — **Notes and handoffs are cards in the state folder; the Markdown is written from them (M10).** The
  owner's notes and the team's handoff items are `.nextlevel/notes.json` and `.nextlevel/handoff.json`, changed only
  through nextlevel (the dashboard, `nextlevel note`, `nextlevel handoff`), each change under a lock folder
  (`cards.lock`, taken over after 15 s) because the dashboard, the owner's window and the orchestrator write at
  once. After every change `docs/OWNER_NOTES.md` and `docs/HANDOFF.md` are written from them (ids, states, replies
  and times in plain Markdown, `- [ ]` kept for handoff items), so Git has their history and a fresh clone can
  import them back with their ids. The first time, a project's current files are imported (under "New" new notes,
  under "Done" done ones, a "rules" heading standing rules; "- [ ]" open items, "- [x]" done ones, "Where:" and
  "Why:" lines as fields); reading never writes, the import is saved with the first change. A file changed by
  hand since nextlevel wrote it (the owner typing a note there, an orchestrator on the old template adding a line)
  is read back: unknown lines become new items, a ticked item is done, nothing is deleted. A rule is never done:
  the orchestrator acknowledges it (seen) and it stays until the owner removes it; an owner's edit makes a note
  new again. Workers can't use the commands (their slot would get its own copy, and their branch the file).
  Autopilot counts a new note, or a handoff item the owner did or answered since the orchestrator last looked, as
  something to decide, also while workers are busy; the cards' files are part of its "made progress". Alternatives:
  the JSON committed next to the Markdown (two copies of the same thing in Git), or keep editing Markdown (what
  the owner asked to stop: the orchestrator moved notes by hand, and the owner couldn't see what happened to one).
- 2026-09-26 — **A Codex worker on Windows gets a warning and the .cmd shims, not a workaround for its sandbox
  (FR-009).** In Codex's sandbox on Windows a worker can't reach Docker or run npm's `.ps1` shims. The prompt of a
  Codex worker there names `pnpm.cmd`, `npm.cmd` and `npx.cmd` (they work) and says to finish BLOCKED when a task
  needs Docker; the doctor (`codex.worker-windows`, a warning) and the Team page say it where Codex is a worker or
  the workers' fallback, and suggest a stronger model on the workers' own engine as the fallback. Nothing turns
  the sandbox off (`danger-full-access` for an unattended worker is the owner's choice, and then none of this
  applies). The switch list says what was run ("retry with --fallback"), since the owner runs retries too.
- 2026-09-26 — **A team change is refused only for an error about the role being changed; warnings are saved
  and shown.** With FR-009's `codex.worker-windows` among a worker change's checks, every worker change on Windows
  (where the default fallback worker is Codex) warned, and warnings needed "Save anyway": the Team page refused
  what the doctor calls a warning. Now a change is blocked by a check of its engine that fails as an error, or
  can't run where it would be one (installed, signed in, the model accepted), and by `profiles.accounts` only for
  the changed role's own account; warnings (an engine only a fallback uses, a Codex worker on Windows) and errors
  about other roles come back with the result, which says "Warning: ...", and the change is saved. "Save anyway"
  is gone; `--anyway` is still taken and changes nothing. Alternative: keep "Save anyway" and leave FR-009 out of
  the change's checks (the owner would not see the warning where the choice is made).
- 2026-09-26 — **The Project page reads the orchestrator's own files, in fixed formats it keeps (M11).**
  `docs/PROJECT.md` (five headings: what it is, who it's for, where it runs, how it works, current state), a header
  at the top of each `docs/plans/<milestone>.md` (Outcome, Acceptance, Try it), labeled bullets under Blockers in
  the status file, and `## <date> — <decision>` entries in `docs/DECISIONS.md`. The orchestrator writes them in its
  own words from BRIEF.md; the dashboard only reads and renders them (`lib/roadmap.mjs`, Markdown as elements,
  never as HTML, redacted like everything else). Formats written before (bullet decisions, `## Outcome` headings,
  unlabeled blockers) are still read. `docs/PROJECT.md` is the project's own document, like the status file:
  `nextlevel init` creates it and never offers to replace it. Alternatives: a JSON file the page edits (the owner
  would maintain it; the point is that the orchestrator explains the project), or the page summarizing BRIEF.md
  itself (no model runs in the dashboard, and the brief says what to build, not where it stands).
- 2026-09-26 — **Roadmap dates and pace come from the hub's records and git, not from the orchestrator's words.**
  A milestone starts when its plan first reached git or its first task was dispatched, and finishes (once the status
  table says done) at its last task's finish or merge (`task/<id>` in the merge commit). The estimate for the rest is
  the pace so far, gaps included: the days from the first start to the last finish per finished milestone, times the
  milestones left, less the time the current one has had; the page labels it a rough estimate and shows none before
  a milestone has finished. Alternatives: dates the orchestrator writes into the status table (a model's claim, and
  one more thing to keep), or an estimate per task (tasks vary even more than milestones).
- 2026-09-26 — **Home's Blockers headline says what kind of wait it is, and counts what waits on the owner once.**
  Red "Blocked: ..." (a "Blocked by the tool" item, cut to its first clause) before amber "Waiting on you: N" before
  green "No blockers". N counts the "Needs you" bullets and the open handoff items no bullet names (a bullet that
  names H3 stands for H3); a bullet whose handoff items the owner has done is shown struck through and not counted,
  until the orchestrator takes it out. Items without a label are "not labeled yet" in amber, never "No blockers".
  Resolved items, and whatever sits under a History or Details heading, fold under Details; the template has the
  orchestrator move them to DECISIONS.md instead. Alternative: show the section as text (what Home did: a long
  history under "Blockers" read as if everything were still blocked).
- 2026-09-26 — **Ask: a read-only assistant is a role of its own, one fresh session per question, read-only by
  construction.** The owner's questions ("what is blocked?", "why did M1-02 fail?") go to the `assistant` role
  (`nextlevel.json`, the Team page), never to the orchestrator's session: asking costs the orchestrator nothing
  and can't steer it, and nothing reaches it unless the owner sends a note (the answer's suggested "Note:" or
  "Rule:" line opens as a draft the owner edits and sends through the Notes cards). Each question is a new
  session with the thread so far (the last 8 messages) in its briefing: engines keep no Ask state, so a thread
  survives a change of engine, and nextlevel never resumes a session it didn't start. Read-only is enforced in
  three places, not asked for: the engine's own mode (Codex `exec --sandbox read-only`, which wins over
  `config.toml` and gets none of `engines.codex.args`; Claude Code in plan mode with the read tools and look-only
  commands allowed and every tool that writes, fetches or names `.env` denied, no MCP servers and no settings
  from the repository), `NEXTLEVEL_READ_ONLY=1` in its environment (then nextlevel runs only `status`, `result
  --peek`, `team` and `doctor --json`, and never updates itself), and no `.env` values in that environment.
  Antigravity isn't offered: its plan mode is the agent's behaviour, not a sandbox, and its deny-list wasn't
  enforced (FR-003). The question goes to the engine on stdin, not as an argument, because `codex` and `claude`
  can be `.cmd` shims and cmd.exe would read `%`, `^` and `"` in it. The briefing and the answer are redacted
  like a report (the project's `.env` values and anything that looks like a secret become `***`). The automatic
  choice is a light model on the first engine that can be run read-only which the roles already use (Claude
  Code's haiku, else Codex's smallest listed model at low effort), else Codex: a signed-in engine the owner
  already pays for, not a new one. Residual risks, accepted: Codex's read-only sandbox can still read any file the
  account can (what it prints is redacted, and its commands have no network); the owner's own allow rules in
  their Claude Code settings still apply (deny rules win over them); project files can carry instructions to the
  assistant, and the worst it can then do is answer badly or suggest a bad note, which the owner reads before
  sending. Alternatives: the orchestrator answers (what the owner asked to avoid: it costs a round, and a
  question could turn into work), a resumed engine session per thread (engine-specific, and the orchestrator's
  session could be resumed by mistake), `claude --restricted` (the strongest mode, but older versions refuse the
  flag).
- 2026-09-26 — **No git step of the hub's fails unnoticed; reads take no lock; writes wait a while for one.** A
  full test run failed once: the dashboard's `git status` in a verifying task's slot held `index.lock` just as the
  hub ran `git add -A` for a Codex worker; the `add` failed unchecked and the commit said "nothing added to
  commit". Three changes, in `src/lib/gitlock.mjs` and the hub: every git that only reads (the hub's and the
  dashboard's `git()`, the checks, the run state, the project finder, the Ask assistant's engine) runs with `GIT_OPTIONAL_LOCKS=0`; a git that
  writes (the hub's in a slot, the orchestrator's git jobs, the hub's `git()`) is run again every 200 ms for up to
  10 s while its output names `index.lock` (a command that couldn't take the lock changed nothing, so running it
  again is safe; the path is in git's message in every language); and every step's exit code is checked. A worker's
  changes the hub can't stage or commit fail the attempt with the step and the reason, and are copied to
  `.nextlevel/jobs/<id>/left/attempt-<n>/` first (links and deleted files listed, a link never followed, nothing from outside the slot), because the slot is
  reset for its next task; after the hub's commit the slot must be clean; with conflict markers left, the slot is
  reset only once the diff that keeps the worker's changes was written; a failed `merge --abort` says the checkout
  is mid-merge. Alternatives: a lock of nextlevel's own around each slot (it can't cover the owner's editor or a
  worker's own git), `git status --no-optional-locks` at the one call site (the next read added would bring it
  back), waiting on the lock file's disappearance (a crashed git's lock never goes).
- 2026-09-26 — **Workers get a real console with no window: Windows' console host, headless (FR-010).** Every
  worker opened a console window that took the focus, because agy's print mode needs a real console and Windows 11
  hands every new console to Windows Terminal, which ignores hidden and minimized starts. Tried on the owner's PC in
  the order the owner asked, with a UI Automation monitor watching for windows and focus: (a) `conhost.exe
  --headless` (ConPTY's host, without the API: Node has no FFI and nextlevel no dependencies) gave a real console,
  no window and no focus change; (b) conhost with a hidden window took the keyboard focus; (c) minimized took it too.
  So (a) is the default. What stays from (b)/(c): `workers.window: minimized` (conhost started minimized, which
  Windows still focuses, said on the Team page) and `visible` (a window in the default terminal, open after a
  failure until Enter), both the same `_run` inside. The console's screen isn't read: it cuts long lines when output
  is fast and loses the exit code. Instead the worker process (`_run`) runs inside the console and gives agy the
  console as its stdin and pipes for its output, which agy 1.2.11 accepts (measured), so nextlevel reads agy's
  output exactly. `_run` writes `worker.log` itself in every mode (redacted, escape codes and window titles out),
  and the hub starts it with `stdio: 'ignore'`, since Node gives a child `CREATE_NO_WINDOW` only when it inherits
  no handle. Autopilot rounds on every engine now run the same way (`_cycle`, followed through `cycle.json`), so
  the hub never holds a child whose output handle could open a window. Never the old background mode for agy: a
  worker process without a console refuses to start it. Alternatives: a pseudo-terminal package (a runtime
  dependency, and a native build on the owner's PC), agy-headless-bridge (Python), reading agy's transcript files
  (nothing names a task's conversation).
- 2026-09-26 — **agy runs with `--output-format stream-json`, not `json` (FR-010).** The owner asked to try `json`
  for the tokens; `stream-json` ends with the same `result` (with `usage`) and also prints each step as it happens,
  so Show activity has a feed for Antigravity like Claude Code's and Codex's, and a worker's window can show what it
  does. Both were measured on 1.2.11 in the console with no window.
- 2026-09-26 — **nextlevel never passes `--effort` to agy (FR-010).** Its Claude models refuse it (every attempt of
  the owner's workers failed with "--effort is not supported for model claude-opus-4-6-thinking"), and its Gemini
  models carry the level in their slug. The adapter drops `--effort` from `engines.agy.args` too (the old default
  had `--effort high`), the Team page shows the level from the model's name instead of an Effort field, and
  `agy.model` tries the exact model and flags a worker gets, headless, before a change is saved (kept until the
  model, the flags or agy change). `agy.effort` (info) offers to take the unused settings out of `nextlevel.json`.
- 2026-09-26 — **A new attempt moves the report before it aside (FR-010).** The hub showed attempt 2's `RESULT.md`
  for an attempt 3 that failed to start, because the file stayed in the job's folder and was read as the new one.
  Now `RESULT.md` is always the current attempt's or absent; earlier ones stay as `RESULT.attempt-<n>.md` (the
  retry's "Your previous report" still reads the one before). The file protocol keeps its names.
- 2026-09-26 — **Slow answers are kept 5 minutes, per user (FR-010).** The dashboard checks again whenever its page
  comes back into view, and each check started agy (`agy models`) or Codex again. `ctx.run(..., { cacheMs })` keeps
  an answer that says yes in `~/.nextlevel/cache/runs.json` (keyed by the program's file and size/date, its
  arguments and account folder); a no is asked again at once, so a sign-in shows immediately. Check again and
  `doctor --fresh` ask afresh. The project's `check-cache.json` keeps the model trials as before.
- 2026-09-26 — **Tests can't reach the owner's CLIs (FR-010).** They found the real agy in `%LOCALAPPDATA%\agy\bin`
  and ran it. A test's PATH is now the stubs, Node, Git and the system's folders only, its home and application
  data folders are temporary, and under the test runner `resolveBin` refuses any CLI outside the stub folder
  (`NEXTLEVEL_TEST_STUBS`; `NODE_TEST_CONTEXT` without it allows the system's tools only), writing it down so the
  test's cleanup fails. The dashboard doesn't merge the PC's PATH into its own there. No folder with a nextlevel
  command in it (the installed one in ~/.nextlevel/bin) is on a test's PATH but the stubs', and
  NoDefaultCurrentDirectoryInExePath is cleared: a PC's shell may set it, CI's doesn't, and it changes how Windows
  finds a program (cmd.exe wouldn't run START.cmd from its folder).
- 2026-09-27 — **Where the console with no window doesn't start, workers get a window; a worker that doesn't
  start is a setup problem, never a stuck task (FR-010 #7).** On Windows Server 2025 conhost runs nothing when
  started with a program (measured in CI), so every Antigravity worker sat at "running" for three minutes. The
  owner's rules: a worker that doesn't start fails its attempt quickly, says why, and counts as a tool problem, not
  a task failure; where the hidden console can't start, fall back to the old way and say so, since a visible window
  beats a stuck task. So each start is watched (its process ending before `run.json`, or 45 s without one); a
  console that failed is remembered per PC for a day (`~/.nextlevel/console.json`, then tried again, since an update
  of Windows may change it) and the same attempt starts again in a window of its own; anything else ends the
  attempt as `error` with `notStarted`, an alert on Home and the phone, and its retry is the same attempt with no
  feedback needed. Each start has a token, so a start that comes after the hub gave up on it does nothing (two
  workers must never share a slot). An autopilot round that never started isn't a round without progress and
  doesn't make the next one wait. The tests ask conhost directly (not through nextlevel) whether it runs a
  program on the machine, and expect the console where it does and the window where it doesn't; `NEXTLEVEL_CONHOST`
  points nextlevel and that question at another program, so any PC can play the runner. Alternatives: skip the
  console tests on the runner (they would prove nothing there, and the fallback would go untested), a console with
  a hidden window there (it took the focus on Windows 11), or `CREATE_NO_WINDOW` with the worker opening `CONIN$`
  for agy (not measured yet: worth trying as a later step, since it would need no window on Server 2025 either).
- 2026-09-28 — **Files that steer agents and tools change only with the owner's approval (the guard).** A worker's
  branch, an orchestrator commit or an orchestrator edit on disk could add a Claude Code hook, an MCP server, a
  workflow or new instructions that the owner's tools then run outside any sandbox. The hub now holds any commit or
  merge that changes a protected path, and sets back a change made on disk while the orchestrator works, until the
  owner approves exactly that change on the dashboard. The list is built in (`src/lib/protect.mjs`) and
  `nextlevel.json` adds or removes paths (`"protected": { "add", "remove" }`), the same list the Discovery's
  owner-marked paths will extend. Alternatives: a deny rule per engine (agy didn't enforce its own, FR-003), or
  refusing such changes outright (a project does need a workflow changed now and then; the owner decides).
- 2026-09-28 — **The guard's records live in the owner's home, not in the project.** Held changes, their content
  and the contents the owner approved are in `~/.nextlevel/guard/<project>/`: `.nextlevel/` is writable by the
  orchestrator (Codex's workspace sandbox), so nothing there may decide anything. The handoff card in
  `.nextlevel/handoff.json` is only a view: the dashboard shows the words and the diff from the home record, and
  Approve and Reject act on it. A card can't be done, answered or cancelled from a command, and a ticked line in
  `docs/HANDOFF.md` never decides it.
- 2026-09-28 — **Approve only on the dashboard, for exactly the change shown.** Not from a command (the orchestrator
  has a shell), not from the phone (a notification has no diff). An approval covers content by its sha-256: a held
  file goes back only while it is still as it was set back, a held commit only while the base branch still has the
  version it was held against, and a held merge is keyed on the protected part of the task's diff (each path's
  blob before and after), so a new attempt that changes the file again asks again, and one that doesn't is covered.
  A merge merges the commit that was checked, not the branch name, so the branch can't move in between. The
  dashboard and the hub don't start in an agent's session (`NEXTLEVEL_AGENT`, set for the orchestrator, workers and
  the orchestrator's check and git jobs), so an agent can't run a dashboard of its own and read its key. Rejected
  merges are refused with the owner's reason, without a new card.
- 2026-09-28 — **The words on a held change come from code, never from an AI.** A change could be written to talk
  its way past a summary an AI makes of it. `describeChange` reads what it can: the commands of Claude Code hooks,
  status lines and helpers, MCP servers (`.mcp.json`, Gemini's settings, Codex's `config.toml`), GitHub workflows'
  `run:` lines, actions and triggers, VS Code tasks (and which run when the folder opens), `.npmrc` keys (a login's
  value hidden), `nextlevel.json` settings, scripts and hooks line by line, instructions line by line; characters
  that hide or turn text are shown as ⟨U+...⟩. Everything is shown as text, never as HTML or Markdown.
- 2026-09-28 — **On disk, the guard watches while the orchestrator can act, and the rest is the owner's.** A window
  opens when an autopilot round, the orchestrator's window, or a check, push or git job it asked for starts (each
  holds it open; one whose process is gone is dropped), with the protected files as they are then as what a change
  is measured against. At every hub tick, before `nextlevel.json` is read again or a worker starts, a change whose
  content isn't approved is held and set back; the window's last holder checks once more as it ends. What is on disk
  when a window opens is only the baseline, never approved by that: a commit of a protected file passes only with
  content the owner wrote through nextlevel (Team page saves, the doctor's fixes, init) or approved, so something the
  orchestrator left running can't slip a change in between rounds; the owner's own hand edit, committed by the
  orchestrator, is a card to approve. A hand edit during a window can't be told apart either and is held. Workers get their engine, model and arguments from the hub
  (`job.json` "resolved"), never from a `nextlevel.json` read at their start. Alternatives: a file watcher (a
  process of its own, and misses changes while the hub is stopped), or a snapshot per commit only (a hook would be
  live on disk until then).
- 2026-09-28 — **A held commit is split; a held merge waits.** The orchestrator's `nextlevel commit` commits
  everything else and takes the protected files out, setting them back to the base branch's version, so its other
  work isn't stopped by a card the owner hasn't seen; Approve commits them with the orchestrator's message. A task's
  merge waits whole, since the task was reviewed as one change; the task shows "Blocked by the tool" with the reason
  in Show activity.
- 2026-09-28 — **A protected name counts as Windows reads it.** Case doesn't count, trailing dots and spaces and an
  NTFS stream (`CLAUDE.md::$DATA`) are dropped, an 8.3 short name (`CLAUDE~1`) always counts, and a name without a
  "/" inside counts at any depth (Claude Code and Codex load nested `CLAUDE.md` and `AGENTS.md`); `docs/agents/` is
  from the top. `docs/agents-notes.md` and `.claude-notes.md` are not protected. A task spec that owns a protected
  path, a folder that holds one (`docs/`) or the whole project isn't dispatched.
- 2026-09-28 — **The guard comes in two pull requests.** This one: protected paths (the list, holds, the watch,
  the cards, Approve and Reject, dispatch refusal, role docs). The next: git's own hooks and settings (recorded, a
  change the hub didn't make stops all git work) and `.env` values (never committed, held with the value redacted).
- 2026-09-28 — **A deleted protected file may be the antivirus's doing.** While the guard was being built, Bitdefender
  removed a test `START.cmd` that had a download-and-run line in it, and the guard held that as a deletion. So a card
  for a deleted protected file says "If nobody meant to delete it, antivirus may have removed it; Reject puts it
  back", and Reject does: from the version before the change (a change on disk) or the base branch's (a commit or a
  merge), when the file is gone at that moment. Tests and demos keep their content harmless (`echo guard-test`).
- 2026-09-28 — **The project's own checks are watched like protected files, and the guard's code holds no invisible
  characters.** `.nextlevel/checks/*.mjs` is code the doctor runs outside any sandbox, in a folder the orchestrator
  can write: the hub's watch covers it (and a task can't own it). `rafter run` found that the pattern which shows
  hidden and direction-changing characters held those characters itself (escapes written into the file came out as
  the characters): it is made from code points now, and a test checks that no file of nextlevel has one. It also
  flagged a TOML pattern that backtracked badly on one long line (fixed, with a timing test) and, in older code, a
  few patterns that are linear in fact and the dashboard's key in its link (by design: the page never sends it
  elsewhere, Referrer-Policy no-referrer).
- 2026-09-28 — **Git's own hooks and settings are recorded; a change nextlevel didn't make stops all git work.** Git
  runs programs from its hooks and from settings (core.hooksPath, core.fsmonitor, core.sshCommand, credential
  helpers, filters, aliases, includes...) and sends pushes where remote.*.url, pushurl and url.*.insteadOf say; the
  slots' push lock (FR-003) is such settings too. The hub records those of the project and each worktree (local and
  worktree settings and what they include; hooks in .git/hooks, a core.hooksPath folder outside the working tree
  and the slots' hook folder) in `~/.nextlevel/guard/<project>/git.json`, and compares before its git work (starting
  or checking a task, a commit, a merge, a push) and once a minute. A change stops that work, a card shows it (hooks
  line by line, settings with their file), Approve records the state as it is (only if it is still the one shown),
  Reject puts back the recorded settings, in the files they were in, and hooks. The hub's own changes (a slot's
  settings and hooks at every task start; the bridge test's remote, from the owner's process, which the hub doesn't
  look at while it is made) are recorded as it makes them. The owner's own `git config` or `husky install` gets a
  card too: nextlevel can't tell who typed it. Global and system settings are FR-013's. A slot's hook forwarder now
  runs the main checkout's hook by its full path: it ran the slot's copy for a relative core.hooksPath, which a
  worker could change and the hub's commit in the slot would then run outside the worker's sandbox.
- 2026-09-28 — **A value from .env is never committed; a .env file, not even with the owner's approval.** The hub
  looks at what the orchestrator's commit stages, what a task's merge brings and what its own commit of a worker's
  work takes in: a file named `.env` at any depth, or one that newly holds a value of the project's `.env` (under 8
  characters, a number, a word like true, or a value `.env.example` has aside), is held with a card whose words and
  diff show `[the value of NAME from .env]`; the value is never on a command line, in a log, or in the guard's records.
  A commit leaves the file out and on disk; a merge waits; the hub's commit in a slot takes the file out of the slot
  too (its content is kept with the guard, not copied into the project), and the attempt fails with why. Approve says
  the value may be committed (exactly that content: the hub commits it, merges the task, or commits it on the task's
  branch from the kept content); Reject leaves it out and sends a task back with the reason. With paths, the
  orchestrator's commit names exactly the files still staged under them (in a pathspec file), so a file taken out is
  never read from disk again.
- 2026-09-28 — **Workers start with `CREATE_NO_WINDOW` and give agy `CONIN$`; nextlevel starts no conhost.exe
  (FR-013).** Bitdefender judged a worker's behaviour malicious, and the owner named the hidden console started by
  launching conhost.exe directly first. `CREATE_NO_WINDOW` is Windows' documented flag for a console program with no
  window, and the one Node sets for `windowsHide` when a child inherits no handle: the worker's process (`_run`), a
  round's (`_cycle`) and a check's runner get a console of their own with no window, open its input (`\\.\CONIN$`)
  and hand it to agy as stdin. Measured on the owner's PC, with a window monitor (UI Automation) and a process monitor
  (WMI): agy 1.2.12 ran the same way as under conhost (output through pipes, exit code kept), and no window came from
  anything nextlevel started. It is FR-010's "later step". The fallback stays: a process whose `CONIN$` doesn't open
  ends with exit 3 before `run.json`, and the attempt starts again in a window of its own (only exit 3 is remembered as
  the console's failure now; any other early end is a worker that didn't start). `workers.window: minimized` became
  `start /min` of the worker's own process, and a test fails if a source file starts conhost.exe. Alternatives: keep
  conhost with an antivirus exception for it (the owner's rule: one narrow exception, for the engine), a pseudoconsole
  (`CreatePseudoConsole` needs native code, so a dependency), starting workers through the Task Scheduler or WMI
  (more of what behaviour engines look for, not less).
- 2026-09-28 — **Workers start without the owner's own add-ons, by each engine's own switch (FR-013).** Every agy
  session, `-p` too, started the owner's global MCP servers through `cmd /c npx` (one with an API key on its command
  line) and loaded their rules and skills; Bitdefender quarantined two of those servers from npx's cache. Unless
  `workers.addons` in `nextlevel.json` lists them (`mcpServers` by name, `skills` and `hooks` as switches), workers get
  none: agy runs as an agent the worker's process writes into its slot at every start (`inheritCustomizations: false`,
  `inheritMcp: false`, `--agent nextlevel-worker`; a missing file would silently mean the default agent), excluded from
  git, and never written through a link (a task's commit could make `.agents` one: the worker doesn't start then,
  `lib/slotfiles.mjs`); Codex gets `-c mcp_servers.<name>.enabled=false` per server, `--disable plugins|hooks|apps` and its skills off by
  name (`skills.config`); Claude Code `--strict-mcp-config --setting-sources project,local` with the owner's model and
  effort passed on. Where an engine can't, it is said, not hidden: agy still starts the servers' processes (`workers.addons`
  warns, KNOWN_ISSUES, an upstream issue), and agy and Claude Code give all of a kind or none. No sign-in is copied,
  moved or read. Alternatives: a worker-only config folder (it moves the sign-in: agy documents no such folder, and
  Codex's and Claude Code's would need a login of their own), Codex's `--ignore-user-config` (drops the sandbox and model
  settings, keeps the skills), Claude Code's `--safe-mode` (drops the project's `CLAUDE.md` and hooks too) or `--bare`
  (reads only an API key), the agent's own `rules:` for `AGENTS.md` (didn't bring it back: the prompt names it).
- 2026-09-28 — **A worker stopped from outside isn't an attempt, and dispatch waits for missing files (FR-013).** A
  worker whose processes (its own and, now in `run.json`, the engine's) are gone without a report is "Stopped from
  outside": finished like any (what it left is kept), its retry the same attempt with no feedback, a card on Home that
  opens Setup and a notification, both naming the antivirus as a likely cause. One that wrote its report first is
  verified as usual. An engine left running without its worker's process is stopped only if the process with that pid
  started when `run.json` says it did (`engineAt`): Windows gives pids again, and a program that got it since is left
  alone (found by the Rafter review). Before a worker starts, the hub checks nextlevel's entry point and the engine's program with what
  its launcher runs; while any is gone dispatch pauses (tasks stay queued, checks and git jobs go on), once said, and
  resumes by itself when they are back. Alternatives: count it as a failed attempt (it punishes the task for the PC),
  stop the hub (the owner's other jobs wait too), resume only when the owner says so (a restore is enough of a say).
- 2026-09-28 — **agy's headless sessions get `AGY_CLI_DISABLE_AUTO_UPDATE=true` (FR-011).** The flashes left after
  FR-010 were agy's background updater, which runs `agy.exe --version` in a console window of its own about every 15
  minutes. The variable isn't documented; measured, `true` kept a due check from starting the updater, and the next run
  without it started it (`1` didn't). agy still updates itself in the owner's own sessions. Alternatives: nothing (the
  flash stays until agy fixes it; the upstream issue asks for that and for the variable to be documented).
- 2026-09-28 — **Codex's windows run with `--no-daemon` (FR-011).** In the orchestrator's window (and the setup guide's)
  Codex hands its commands to its shared background server, which has no console, so its sandbox helper opened a
  window, and took the focus, for nearly every command (12 in one measured turn). `--no-daemon`, Codex's own flag
  (0.156 on), keeps the session's server in Codex's own process: measured, no window in a whole turn. It is a flag,
  not a `-c` (FR-004 #6's warning came from those), and Codex prints nothing about it; the session is then only
  history in `codex agents`, which nextlevel doesn't use. Given only when `codex --help` lists it, so an older Codex
  isn't refused. Alternatives: `-c features.daemon_auto_start=false` (still joins a server that already runs, so the
  windows stay once the owner's own Codex started one), nothing (the owner's typing goes to a window that closes).
- 2026-09-28 — **No check about the default terminal (FR-011).** Asked first, the owner said the flashes were fewer but
  not gone after switching to Windows Console Host, and chose not to measure Windows Terminal again. With Console Host
  the flashes left came from agy's updater and Codex's shared server, programs that make consoles of their own, and
  both are gone now (above); workers and rounds opened none, before or after FR-013, and background work no longer
  asks the default terminal for a console at all. So the terminal didn't decide them. A check that offers the switch
  would change a Windows setting for no measured gain. `tool.files` has no `--fix` either: a file an antivirus took is
  the owner's to restore, and its steps give the commands that put the tools' files back.
- 2026-09-28 — **What the hub prints for the orchestrator fits in 9,000 bytes and 240 lines, and says what it leaves out
  (FR-012).** `nextlevel result` cut reports at 200 lines without a word, and a real project's orchestrator judged part of a
  design. Printing the whole report instead doesn't work: an engine keeps only so much of one command's output (Codex
  about 10 KB by default, `tool_output_token_limit`, and it cuts the middle; Claude Code's Bash tool 30,000
  characters), so a 50 KB report would be cut again, by the engine. The budget sits under the smallest, whatever
  engine the orchestrator runs on this round (its fallback may be another). The report gets what the header, diff stat
  and logs leave; a longer one says so at its top (where an engine that cuts the middle keeps it) and where it is cut,
  with its length, the file with all of it, and `--from <line>` for the next part, which fits the same budget, so a
  report can be read whole on any engine. Alternatives: only a pointer to the file (the orchestrator starts from
  nothing, and reads a 50 KB file with the same engine limit), a budget per engine (the round's engine isn't known to
  `result`, and Antigravity's limit isn't documented).
- 2026-09-28 — **Every attempt's report is copied when the attempt ends (FR-012).** Before, `RESULT.md` was moved aside
  as `RESULT.attempt-<n>.md` only when the next attempt started, so the path to a report changed under the orchestrator
  when it retried. Now the copy is made at the end of the attempt and `result` names it; `RESULT.md` stays the latest
  one's (the file protocol is unchanged), and the next attempt drops it when its copy is there. An attempt that ran
  again without counting (it didn't start, or was stopped from outside) keeps its own name with `-2`.
- 2026-09-28 — **Design, research and map tasks name a result file, and the hub checks it (FR-012).** A result in the
  report alone gets shortened; one in a file under `docs/` is committed, reviewed like code and merged, and the
  orchestrator reads it in parts (`result --file`). The spec says where (`Result file: docs/...`); dispatch refuses a
  spec of those kinds without one, and any result file outside `docs/`, leading out of it, a pattern, a folder or a
  protected path. The check that it exists and isn't empty is the hub's own step of the task's verify (a `git cat-file`
  of the task branch), not a command in the spec: `test -s` doesn't exist in cmd.exe, and a job's state comes from
  verification the hub ran itself. The worker is told where in `TASK.md` too, so a project on an older WORKER.md gets it.
  An unknown `Kind:` in a spec still means `code`, as before; an unknown `--kind` is refused. Alternatives: collect the
  worker's final message as the result (it isn't reviewed or merged, and is as long), require the file for reviews too
  (their findings are short and belong to the report; a review's spec may still name one).
- 2026-09-28 — **The owner's words reach the orchestrator whole (FR-012).** `note list` and `handoff list` cut them to
  110 and 200 characters with only an ellipsis, and a reply was cut to 400 characters when it was saved. Now a note to
  follow and a reply are shown whole up to 1,500 characters, and a longer one says where it is cut, with its length
  and the card in `docs/OWNER_NOTES.md` or `docs/HANDOFF.md`; handled ones stay short in the history. A reply is saved
  whole up to 4,000 characters, the length a note may have, and a longer one is refused the same way. The orchestrator's
  own one-line replies keep their 400.
- 2026-09-28 — **`project.decisions` warns past about 1,000 lines and has no fix (FR-012).** a real project's DECISIONS.md was
  5,871 lines, mostly the story of each round, and the orchestrator reads it at every start. The role doc now keeps
  it to decisions; the check catches a file that grew anyway and says how to archive in plain words, with a
  `nextlevel note add` that asks the orchestrator to do it. One archive file, `docs/DECISIONS-archive.md`, older
  entries appended at its end in their order, so it reads the same as before. No automatic fix: the file is the
  orchestrator's, an autopilot round may be writing it, and which entries still matter is its call. Alternatives: a
  fix that moves all but the newest 200 lines (races a round), one archive per date (more files for nothing).
- 2026-09-28 — **CI runs Windows once per pull request, in a workflow of its own that only a request starts.** From 24
  to 28 September CI used 965 Windows and 271 Linux minutes, the account's whole free allowance: 46 Windows minutes
  per merged pull request, 79 for the last eight (the tests now take 17 to 25 minutes on the Windows runner). Of the
  Windows minutes, 280 went to main after a merge, 259 to commits that a newer push replaced, 135 to cancelled runs
  and 17 to re-runs; 274 were the first run of a pull request's last commit. Sessions run `npm test` on Windows 11
  before they push, so the runs in between mostly repeated it. Now `ci.yml` has one job, `ubuntu`, on every push and
  on main; `windows.yml` has one job, `windows`, and branch protection requires both checks on the pull request's
  head, up to date with main. A required check that ends skipped or neutral counts as passed, a job skipped by its
  `if:` included, so the `windows` check must not exist on a code change's head until a real Windows run makes it: a
  workflow of its own that no push starts, and a job without a condition. The request is marking the draft pull
  request ready for review (`pull_request: types: [ready_for_review]`, `gh pr ready`): GitHub runs that from the pull
  request's own workflow file, so it works before main has the file (a pull request that changes `windows.yml` is
  tested by it) and for a cloud session that can mark a pull request ready. `workflow_dispatch` alone can't: GitHub
  starts a workflow by hand only once main has it; it stays for running it from the Actions tab. Not a label: a label
  stays, and a label event for any other label would start the job or leave it skipped. A push after the request
  starts nothing, so its commit has no `windows` check until the session asks again (back to draft, then ready).
  Auto-merge only under that protection: without required checks GitHub counts a pull request as mergeable while
  `windows` still runs or even fails, so `gh pr merge --auto` could merge at once. Sessions read main's required checks
  through the API first and otherwise leave the merge to the owner, and the owner sets the required checks before
  allowing auto-merge, never the other way round.
  From this month's runs: one Windows run per pull request is 13 minutes
  (19 for the last eight), a cut of 72% (76%); with one more run for each Windows-only failure the pull requests had
  (5 in the last eight, 3 of them flaky), 20 (32), a cut of 57% (60%). Alternatives: Windows on a schedule (a merge
  wouldn't wait for it), only the Windows-specific tests per push (the rest differs on Windows too: paths, consoles,
  process trees), a commit status instead of the job's own check (more code for the same rule).
- 2026-09-28 — **Only documentation changed: quick passes decided from the files, and code that already passed on
  Windows isn't tested again.** `paths-ignore` would leave the required checks missing, which blocks forever, so the
  jobs run and their first step (`.github/ci/changes.mjs`) looks at the changed files: always the whole pull request
  against main (GitHub's merge of it against main), never the latest push, so code then a documentation commit on top
  is a code change. All in `docs/` but `docs/CHECKS.md` (a test reads it), or Markdown at the top: the tests are
  skipped, and `ci.yml` creates the `windows` check itself (the Checks API, with the job's token) only after deciding
  so. It also passes `windows` when the head has exactly the code of a commit on which a Windows run ran the tests
  and they passed (only documentation differs, main's changes included; a DECISIONS entry written after the run), and
  `windows.yml` skips its tests then. A run that skipped its own tests that way is no pass for later commits, so every
  pass rests on tests that ran; and a pass never covers code that came after it, from the branch or from main (an
  update that brings main's code runs Windows again). A rename counts as both names; whatever the script can't tell,
  the tests run. It trusts that
  main's code passed on Windows, which branch protection's "up to date" makes true: main's tree is then the tested
  head of the pull request merged last. Never a label: a label says what someone thinks changed, the files what did.
  A test keeps every file of this repository that a test reads out of "documentation".
- 2026-09-28 — **Tests wait for the event, never a fixed time.** A fixed sleep is too long where the event comes at
  once and too short on a slow runner. `hubRounds` counts the hub's heartbeats, so "nothing starts" is checked after
  the hub looked at the queue, not after a second or two; `processesGone` waits for killed processes before a
  cleanup; the visible-window test waits for a finished worker's window to close by itself instead of sleeping 25 s,
  with that window's pause shortened for the test (`NEXTLEVEL_WINDOW_CLOSE_S`, 20 s by default). It still proves what
  it did: the failed window, open since before the other worker started, is open when that one's has closed. CI sets
  `NODE_COMPILE_CACHE` too: the tests start nextlevel again and again, and keeping its compiled code saved about 7% of
  each start on the owner's PC. Nothing else is cached: there are no dependencies, and Node comes from the runner's
  tool cache. Not tried: test files in parallel (the installer's tests count nextlevel's processes on the whole PC).
- 2026-09-28 — **A stopped worker's engine is stopped through what the hub holds; the rest is found in one listing of
  all processes (FR-013).** The hub asked PowerShell when the engine's pid started, with a 20-second limit, and left the
  engine running when the answer was late: on a busy GitHub runner that failed the FR-013 test, and on a busy PC it
  would leave a live engine in a slot where the next attempt starts. Measured then: on Windows Node starts every child
  in a job that closes with it and lets the child's own children out, so killing a worker's process (`_run`) also kills
  its own child, which was the cmd.exe of the engine's `.cmd` shim, while the engine lived on under a parent that was
  gone. Now: a `.cmd` shim's program starts directly (`spawnDirect`), so the engine is the worker's own child and
  Windows ends it with the worker's process, at once, with nothing asked; elsewhere the hub, told the moment the
  process it started ends, stops that process's group (the group keeps its id while any of it runs). What the engine
  started, and every worker the hub doesn't hold (one from an earlier hub run, one in a window of its own), is found in
  one snapshot of all processes (PowerShell's CIM on Windows, `ps` elsewhere): the worker's tree is walked from what
  `run.json` recorded (its process and its engine's, each with a time it ran), a child counts only if it started after
  its parent and, for a parent that is gone, before the hub saw it end, and a pid that a program started later has now
  is left alone with what that program started. The listing runs when a worker ends, when the hub starts and when the
  owner asks, never on a timer (the owner's call: PowerShell runs stay rare, and an antivirus watches them). Alternatives:
  the old start-time lookup of one pid (late on a busy PC, and on Windows the pid in `run.json` was the shim's, already
  gone), `taskkill /T` from the engine's pid (finds nothing under a parent that is gone), killing a pid without its
  start time (another program's by then), starting engines detached (no console: what they start gets a window).
- 2026-09-28 — **No task starts in a slot until nothing its stopped worker started runs there (FR-013).** The slot is
  held (`heldSlots` in settings.json) from the moment the hub knows the worker's process ended without finishing, or
  the task passed its time limit; one clean listing frees it. A late listing is asked again 1 and 5 minutes later; the
  third late answer, a listing that fails, or processes that won't stop make it a card on Home (Check again) and a
  notification, and the status says it; a hub that starts looks once more (a restart of the PC ends them). Tasks go to
  the other slots meanwhile. Alternatives: start the next attempt anyway (it shares the folder with a live engine),
  pause all dispatch (the other slots can work), let the owner free a slot without a listing (nothing would say the
  processes are gone).
- 2026-09-28 — **Tests follow nextlevel's own answer about the console, and a failing hub test prints the hub's log.**
  `team.test.mjs` asked Windows whether the console with no window works before nextlevel tried it, and the two could
  disagree on a CI runner; the test now reads nextlevel's result (tried and refused, or "not tried: the console with no
  window didn't start", which only Windows may say). A test that fails prints the hub's log, the workers' `worker.log`
  and the rounds' logs of the projects it made (`test/helpers.mjs`, before its cleanup removes them), so a CI failure
  explains itself. Alternatives: remove the test (it still proves a refused model isn't saved), print logs always (the
  CI output would be mostly logs of passing tests).
- 2026-09-29 — **Every kill of a stopped worker's processes names the process by its pid and its start time, and a
  zombie has ended (FR-013).** The first Linux CI run failed: processes the hub had killed stayed listed as zombies (their
  parent, the test, was busy waiting for the hub) and answered `kill(pid, 0)`, so the hub held the slot for processes that
  "wouldn't stop". Now the snapshot leaves zombies out, and "still there" is a snapshot's answer: the same pid with the
  same start. Each kill checks the start time first, on Windows through the handle the kill then uses (while it is open
  Windows gives the pid to no other program: the owner's call, since Windows gives pids out again quickly), elsewhere
  with `ps` right before. A task past its time limit is stopped through the worker's process the hub holds, never by
  a pid alone. The one kill that names no single process is the worker's process group elsewhere, just after the hub
  collected the process that led it (the group keeps its id while any of it runs). Alternatives: `taskkill /PID` after
  the snapshot (another program may have the pid by then), `kill(pid, 0)` for "still there" (a zombie answers it).
- 2026-09-29 — **Replies and answers on a handoff card are kept whole with their line breaks; a text too long is
  refused, never cut (FR-014).** a real project's H9 reply (about 1,700 characters, a checklist) was saved as one line cut to 400
  characters with "…". Now an owner's reply and a team's answer keep their lines up to 20,000 characters, a request up
  to 4,000, where and why up to 2,000 each; beyond that the command or the page says how long it is and what to do,
  and nothing is kept. Alternatives: a higher cut (still silent), one line (loses the checklist the owner wrote), no
  limit (a card of any size in a Markdown file that goes into Git).
- 2026-09-29 — **Free text reaches nextlevel in a file, never on the command line (FR-014).** On Windows the
  orchestrator's shell runs `nextlevel.cmd`, where cmd.exe ends an argument at its first line break and expands `%...%`
  (measured: `%PATH%` became the PATH). Every command that takes free text takes `--file <path>`; an answer only takes
  it that way. The file must be in the project folder, not a `.env` file and not in `.git`; UTF-16 with a mark and code
  page 1252 are read as PowerShell 5.1 writes them. `--file -` reads stdin; stdin is never read unasked (a pipe left open
  would hang the command). Alternatives: escaping for cmd.exe (a line break can't be escaped in `%*`), a `.ps1` shim
  (PowerShell's execution policy blocks it, which is why the installer writes a `.cmd`), the text in base64 (unreadable in
  the orchestrator's log, and the command line's length still limits it).
- 2026-09-29 — **A card is one conversation, and an answer waits for the owner until a reply or Done (FR-014).** The
  thread holds the owner's replies and the team's answers in time order (`reply`/`repliedAt` still hold the owner's last
  reply, for an older nextlevel, whose replies join the thread when it is read). An answer puts the card under What needs
  you; on a card that was done, Done marks the answer read (`readAt`) and wakes no orchestrator, while a reply with it
  does. Answering marks the owner's words seen; a cancelled card takes no answer. The phone gets a message that names the
  card, never the answer (it can be long, and anyone who knows the topic reads the phone's messages). Alternatives:
  reopen a done card on an answer (the owner would close it again for a note of news), the answer on the phone, one
  `answer` field (each answer would replace the last, as each reply did).
- 2026-09-29 — **An answer is redacted like a report when it is kept; a request is not (FR-014).** A request names what
  the owner should set, `APP_URL=...` for one, which a report's redaction would blank out. The dashboard redacts every
  text the team wrote as it shows it, and the guard holds a commit of `docs/HANDOFF.md` that has a value from `.env`.
- 2026-09-29 — **The page's `h()` is in `src/ui/dom.js`, so a test can render a card (FR-014).** The tests have no
  browser; a small DOM that parses HTML where a page would ask for it (`innerHTML`) shows whether a text became an
  element, and the test fails when the escaping is broken on purpose. Alternatives: a browser in CI (a dependency, and
  minutes), a search of `app.js` for `innerHTML` alone (the test does that too, but it can't see a text put in as HTML
  another way).
- 2026-09-29 — **Every command's arguments go through one strict parser, before anything runs (FR-015).** On a real project
  `nextlevel push --help` pushed main, which deployed production: push took no arguments, and every command had a parser
  of its own that dropped what it didn't know. `src/lib/commands.mjs` lists every command with its usage, options,
  subcommands and how many arguments it takes; `cli.mjs` asks it first (before the update check, the project and the
  hub), and each command's code reads its arguments from it (`commandArgs`), so what was checked is what runs. `-h` and
  `--help` anywhere before `--` print the usage and exit 0, whatever else is there; an unknown option or an argument too
  many prints the usage and exits 1; a command that isn't listed doesn't run (the hub refuses to load one). The parsing
  is Node's (`util.parseArgs`, strict), with two additions of ours: an option whose value may be left out
  (`doctor --fix [<id>]`) and per-subcommand options. In a read-only session a command that changes things says so
  before its arguments are judged. Alternatives: a `--help` check in each command (the next command forgets it), a
  dependency such as commander (the tool has none at runtime), non-strict parsing with warnings (an agent reads past a
  warning; nothing must act).
- 2026-09-29 — **A push always names its branch, as a plain name, and is never forced (FR-015).** `nextlevel push
  <branch> [--from <local branch>]` has no default target. A leading `+`, a colon, `refs/...`, `HEAD`, a tag, a remote's
  name or one in front (`origin/main`) is refused by the command and again by the hub, which pushes exactly a commit id
  to `refs/heads/<branch>` (`git push --porcelain --no-follow-tags --recurse-submodules=no origin <sha>:refs/heads/<branch>`):
  nothing but that branch moves, and only forward. The remote is always `origin`. A push that would drop origin's
  commits is refused before git is asked, from git's refs (never from its messages, which are in the owner's language).
  Alternatives: a default of the base branch (what deployed a real project's production), `--force-with-lease` (still a force), pushing the
  branch's name rather than its commit (the branch can move between the check and the push).
- 2026-09-29 — **A push to a deploy branch is the owner's decision, on the dashboard only, for exactly the commit its
  card shows (FR-015).** `deployBranches` in `nextlevel.json`; not set, the base branch counts (new projects get
  `["main"]` from `nextlevel init`, older ones hear it from the doctor). The hub holds the push as a guard record (kind
  `push`, in `~/.nextlevel/guard/<project>/`, which the orchestrator can't write) with a card written by code, like the
  guard's: the branch, how many commits would go out and since when, the newest commit's message, the commits. Approve
  queues a push of the record's commit; the hub pushes it only while the branch and origin's are where the card showed
  them, else the record is superseded and a new card asks again (a new record, a new id: a click never approves content
  that changed under it; "the card updates" is the old card closing with a pointer and a new one asking). A rejected push
  of the same commits isn't asked again; a newer state of the branch replaces an older card. Alternatives: a `--yes` or a
  phone reply to approve (anything an agent can write or send could approve it), approving the branch rather than a
  commit (it would push whatever the branch has at push time), updating the record in place (an approval could land on
  content the owner hadn't seen).
- 2026-09-29 — **The deploy list the hub uses is the union of every version of it the owner may have had (FR-015).**
  The branches named by `nextlevel.json` on disk, by the version the guard's watch kept when the orchestrator's work began,
  by the committed `nextlevel.json` and by the settings the hub read; a list that isn't set counts as the base branch.
  `nextlevel.json` is protected, so the guard sets back the team's change of it within a tick, but a push job could be
  judged in between; with the union, a change can only add a deploy branch until the owner has committed it. The cost:
  an owner who takes a branch off the list waits for that commit before a push to it goes out without a card (the card
  says why). Alternatives: the settings read at the hub's start (the team's edit lands there at the next refresh), the
  disk alone (the race above).
- 2026-09-29 — **Every push goes through one function, and a test reads `src/` for any other (FR-015).** Push jobs from
  every path (`nextlevel push` by the owner or the orchestrator, in its window or an autopilot round, and the owner's
  Approve on the dashboard) run in the hub's `pushBranch`, the only caller of `pushArgs` (`src/lib/push.mjs`). The test
  fails on a `"push"` argument or a `git ... push` command line anywhere else in `src/`, with a short list of what may
  say it and why (the rules that forbid it to workers, a step the owner types, the bridge test's instructions to a
  worker). In the push tests a hook in the bare origin records each push with the job that made it
  (`NEXTLEVEL_PUSH_JOB`), and every one must be a job the guard's push log has done. Each push is logged with its source,
  target, commit range, who asked and the card: the job's `push.log`, `hub.log` and `pushes.jsonl` in the guard's folder.
  `hub.json` says the hub pushes what a job names (`pushProtocol`), and `nextlevel push` queues nothing for a hub without
  it. Not covered: `nextlevel verify` runs any command with the hub's environment, a push or a deploy included (FR-015
  #5, for its own change).
- 2026-09-29 — **Rafter's note on `runs-on: windows-latest` is answered, not acted on: the Windows check runs on
  GitHub's current Windows.** Rafter's scan of main (fast mode; severity "note", the only finding under `.github/`)
  says a `-latest` label moves to GitHub's newest image by itself, which can break CI with no change here, and
  suggests pinning a version such as `windows-2019`. It isn't a security finding. The image is GitHub's either way, and
  a pin changes nothing about what runs, with which token, or on which code. So the repository being private, with only
  the owner's sessions pushing to it, doesn't bear on it either way. The point is true, but here a pin costs more than
  it saves:
  - nextlevel's users run Windows 11, which moves too, so the check should test on current Windows.
  - A pin doesn't make runs repeatable anyway. A pinned image still gets new software versions. #26's run had
    `windows-2025-vs2026`, version 20260922.246.2, which the log's "Runner Image" shows.
  - GitHub announces a label's move weeks ahead, in every run's annotations. The runs show one now: `ubuntu-latest`
    moves to Ubuntu 26 from 19 October. Each run's log also names the image it had, so a failure from a move is found at
    once.
  - A pinned image is retired on a date. Rafter's own example, `windows-2019`, was retired in June 2025. After that
    the required `windows` check can't run at all, and every merge waits for a `.github/` change, which the owner has
    to merge by hand (2026-09-29, below).
  - Pinning Windows alone while `ubuntu-latest` moves would be half a rule, and pinning both doubles the chore.

  Nothing under `.github/` changed. Revisit if a move ever breaks a pull request's Windows run: then pin, and move the
  pin in a pull request of its own. Alternative: `windows-2025` (the same image today, a chore later).
- 2026-09-29 — **Main's branch protection, and when a session may turn on auto-merge.** Since 29 September main has a
  classic branch protection rule (no rulesets):
  - `ubuntu` and `windows` are required, each from GitHub Actions (`app_id` 15368). A check or commit status of the
    same name from anything else doesn't count.
  - `strict`: a branch must be up to date with main. This keeps main's tree the tested head of the pull request merged
    last, which the documentation rule and the Windows gate's "behind main fails" rest on (2026-09-28).
  - `enforce_admins`: no bypass. Sessions run `gh` with the owner's account, an admin, so without it a session could
    merge past a red or missing check.
  - Force pushes to main and deleting it are refused.
  - No reviews are required. Sessions open pull requests with the owner's account, and GitHub lets no one approve their
    own, so a required review would block every merge.

  The repository's "Allow auto-merge" stays off until the pull request with these rules is merged; then the owner
  turns it on. This replaces 2026-09-28's rule, which read only the required checks' names. A name alone lets a check of
  that name from another app pass, and says nothing about "up to date" or admins. Now, in CLAUDE.md's "CI and
  merging":
  - Before `gh pr merge --auto`, a session reads the protection through the API. It must show `strict`, both checks
    with `app_id` 15368, and `enforce_admins`. If anything is missing or looser, there is no auto-merge and the owner
    is told.
  - There is never auto-merge for a pull request that changes what "green" means: `.github/` (the CI decision script
    included), `test/ci.test.mjs`, `package.json`'s scripts, the CI and merging rules, or a test deleted, skipped or
    weakened. A pull request's checks run the workflows and tests it brings, so such a pull request grades itself. A
    `pull_request` run takes its workflow from the pull request, which is how `windows.yml` tested itself in #26. The
    owner merges it after the reviewer has reviewed the diff.
  - Sessions never change repository settings, branch protection or rulesets. They hold the owner's admin account, so
    only this rule stops them, and a session that could loosen the protection could merge anything.

  These hold by rule for now. PLAN's later items make them hold by construction: a guard workflow on
  `pull_request_target`, a restricted identity for dev sessions, and the honesty checks in CI. Alternatives: a ruleset
  (the same checks; the owner set up the classic rule), a required review (the owner can't give one), auto-merge
  decided from the required checks alone (the rule this replaces).
- 2026-09-30 — **Help is what the parser reads (FR-017).** `commit -hm "x"` is `-h` and `-m "x"` to Node's parser, so it
  is help: `parseCommand` reads the arguments leniently first (`strict: false`, the same options) and a help token before
  `--` wins over anything else wrong, as the words `-h` and `--help` already did. `-mh` stays `-m "h"`: what the parser
  reads decides. Alternatives: looking for an `h` in every group by hand (a second parser, and wrong for `-mh`), the
  strict reading alone (an error elsewhere in the arguments would hide the help).
- 2026-09-30 — **`"deployBranches": []` is no deploy branch (FR-017).** The hub's union of every version of the list
  (FR-015) no longer falls back to the base branch when it is empty. A source that doesn't set the list still counts its
  base branch, and the settings the hub read are always a source, so the union is empty only when every version the
  owner may have had says `[]`: an uncommitted `[]` still can't take main off the list.
- 2026-09-30 — **An agent's session is known from its environment, and that is said to be no wall (FR-017).**
  `src/lib/session.mjs` reads what the hub puts in each agent's environment (`NEXTLEVEL_AGENT`, `NEXTLEVEL_SESSION`,
  `NEXTLEVEL_TASK_ID`, `NEXTLEVEL_READ_ONLY`), and the owner-only commands refuse there, saying why. An agent that clears
  them passes for the owner; `docs/KNOWN_ISSUES.md` says so plainly. Alternatives: the process tree (is the orchestrator's
  or a worker's pid an ancestor? A listing costs about a second on Windows at every such command, and a process started
  detached, by a scheduled task or through WMI, leaves the tree anyway); a secret only the owner's windows get (anything
  the owner's Windows user can read, an agent running as that user can read). Only a separate Windows user for the
  agents is a wall (part 2 and after).
- 2026-09-30 — **Only `--to` and `--force` of `nextlevel update` are the owner's (FR-017).** They put any version in place
  (an older one too) or update under a running hub and workers. A plain `nextlevel update` from an agent's session is
  left alone: it only fast-forwards the branch the owner chose, and waits while anything runs. The owner's own commands
  still update the tool as they start (M3) until Safe updates replaces that with a one-click update.
- 2026-09-30 — **A verify command runs without Git pushes or GitHub sign-ins, through its environment, and waits while
  git work is stopped (FR-017).** The same idea as the slots' push block (FR-003), without touching the main checkout's
  settings: `GIT_CONFIG_PARAMETERS` rewrites every push URL to a remote helper that doesn't exist and gives each remote a
  push URL that fails (after an empty one, which clears the project's own from Git 2.46), with no credential helper, no
  prompt and no ssh; `GH_TOKEN`, `GITHUB_TOKEN` and the Enterprise ones hold a token that doesn't work. The push URLs are
  read back as git will use them, and a command that could still push isn't run (its job says why). Only push URLs are
  rewritten, so a fetch from a public or local repository still works; one from a private GitHub repository needs a
  sign-in, which only the read-only token below gives back. A test suite that pushes to a repository of its own fails,
  as it already did in a worker's verify commands. It waits like a task, saying why, rather than ending
  like the orchestrator's git and push jobs: its result is what the orchestrator waits for. Each command is logged with
  its exact command line in `verify.jsonl` in the guard's folder (the orchestrator can't write there). Alternatives: a
  pre-push hook through `core.hooksPath` (it replaces the project's own hooks, and `--no-verify` skips it),
  `GIT_ALLOW_PROTOCOL` (it stops fetches too), running verify commands in a slot (the orchestrator asks them about the
  main checkout). A deploy tool signed in as the owner isn't stopped: no environment switch reaches every such tool.
  One exception, found by FR-004 #2's test: from inside Codex's sandbox the setup is seen through `nextlevel verify doctor
  -- nextlevel doctor`, and without the owner's sign-ins that doctor said gh was signed out (and would have had the owner
  sign in again). A verify command that is exactly nextlevel's own doctor (`nextlevel doctor`, with `--json` or
  `--fresh`; never `--fix`, nothing else on the line) is the hub's own run of its doctor, by its own path (never the
  command's text, which a `nextlevel.cmd` in the project folder could stand in for), with the owner's sign-ins: the
  doctor only looks. Its log line says so. Alternatives: the doctor calling every GitHub row "can't tell" in a verify
  command (the orchestrator would lose the view FR-004 #2 gave it), a list of commands allowed the sign-ins (a command's
  text can't be trusted to be what runs).
- 2026-09-30 — **Only the dashboard files a kept report, in its own process (FR-017).** A command can't tell the
  dashboard's child process from an agent's: a pipe, a variable or a file under the home folder are all the owner's
  user's, so an agent could hand over the same. The dashboard's key lives only in its process and the page, so its File
  it calls `fileShownReport` in the dashboard's process, for exactly the text the page showed; `report --send` refuses on
  every command line, the owner's too. The owner leaves something out by editing the kept file before answering in
  `nextlevel report`, which shows the file again, redacted again, and asks again (it was `report --send <id>`, which an
  agent could run). Alternatives: a one-time ticket the dashboard writes for its child (an agent can write the same
  folder), `--send` only with a console for stdin (an agent can start one).
- 2026-09-30 — **The hub no longer installs a merged fix (FR-017).** An idle hub used to stop, update nextlevel and start
  again on the new code without the owner. Now the follow-up tells the owner (and the phone), once, that the fix is
  merged and that `nextlevel update` installs it, and waits; the check still runs again once the fix is there.
- 2026-09-30 — **Every phone message is redacted in `notify()`, the one way to ntfy (FR-017).** Title and message go
  through the reports' redaction (moved to `src/lib/redact.mjs`, unchanged) for the project `notify()` must be told
  (it refuses a call without `root`), before the text is cut to ntfy's limit. The hub also redacts before its links
  change the text (a value with `.md` in it would no longer be found after). At send time, not when queued: the
  orchestrator can write the outbox, and a message written straight into it must be redacted too. The cost: a `.env`
  value that is an ordinary word (`NODE_ENV=production`) is blanked out of messages too. Alternatives: the guard's
  stricter list of values (`secretValues`: 8 characters and up; reports' 4 and up catch more), redacting when queued.
- 2026-09-30 — **A role with full access is a warning, not a refusal (FR-017).** Antigravity runs unattended only with
  its permission checks off, and it is the default worker, so refusing it would stop the default team. The doctor's
  `profiles.full-access` and the Team page say, for each such role, that it acts with the owner's full access; each
  adapter says when its arguments turn the checks off (`fullAccess`). After a review: a **warning** where
  the owner can act, a role in the main checkout (the orchestrator, the setup guide, the assistant, their fallbacks),
  which could push or deploy directly and can move to a sandboxed engine; **information** for workers, whose risk is
  accepted by design (slots behind the push block, and Antigravity's unattended mode). The setup guide on Antigravity
  doesn't count (it gets none of the unattended arguments), nor the assistant (read-only arguments of its own).
- 2026-09-30 — **GitHub reads come back to verify through an optional read-only token in the project's `.env` (FR-017,
  a review).** a real project's orchestrator reads CI through verify, its only way to GitHub from inside Codex's
  sandbox: of its 329 verify jobs, 35 ran `gh run list`, `gh run view`, `gh run watch` or `gh api user`, which the
  sign-in block turned into "Bad credentials" (the pull request lists them). `NEXTLEVEL_GITHUB_READ_TOKEN`, a
  fine-grained token with read-only access to the project's repository (Actions, Contents, Pull requests, Commit
  statuses), is read from `.env` for each verify command: gh gets it as `GH_TOKEN` and `GITHUB_TOKEN`, and git gets it
  through `credential.https://github.com.helper`, after the empty `credential.helper` that clears the owner's helpers, so
  it answers for github.com and nothing else. The helper takes the token from the command's environment, never from a
  command line. Reads work; GitHub refuses a write made with the token, even from a command that gets around the push
  block, which stays as it was. The token is a `.env` value, so it is redacted like one, and a worker never gets it
  (`workerEnv` also drops it by name). What `nextlevel result` shows of a verify job's log is now redacted like a phone
  message too: the command runs with the project's `.env` in its environment, the token included, and prints what it
  likes. (The job's own `check.log`, in the project, keeps what it printed, and the orchestrator can read the project's
  `.env` itself, as it can every value there: the token is exposed to it as any `.env` value is, and it can only read.)
  The doctor's `gh.read-token` says whether it is there (info), reads the repository, expires within a week or
  is refused (warn), or is a classic token, which can write (warn); the expiry comes from the
  `GitHub-Authentication-Token-Expiration` header GitHub sends back. GitHub gives fine-grained tokens no Checks
  permission, so `gh run view <id>` alone (it reads annotations) fails with one; the role doc gives `--json jobs` and
  `--log-failed`, and a verify job's log says so. Without the token nothing changes, and a failure for want of a
  sign-in says so in the job's log and status. Alternatives: the owner's own sign-in for reads (it can write), a
  classic token with `repo` scope (it can write), reads through the hub's own commands (a new command per kind of read;
  gh already has them). The orchestrator's role doc says how CI is read (a new template version).
- 2026-09-30 — **A setting's ordinary word stays readable in a phone message (FR-017, a review).** A `.env`
  value that is one of production, development, staging, test, local, localhost, debug, info, warn, warning or error,
  under a name that doesn't look secret (`NODE_ENV`, `LOG_LEVEL`), isn't redacted, nor its `NAME=value`: blanking
  "production" out of every message made them unreadable. The same word under a secret-looking name (`API_TOKEN=
  production`) is blanked out everywhere, and every other value stays as reports have it. The same rule serves what
  `nextlevel result` shows of a verify job's log (with the home folder as it is there).
- 2026-10-01 — **A milestone's plan is found by what it says first, then by its name (FR-016).** The page used to take
  a plan's milestone from its file name alone (`docs/plans/<key>.md`), and a real project's `WS-walking-skeleton.md` matched
  nothing. Now a line `Milestone: <name>` in the plan's header decides whenever it names a milestone; it counts only in
  the header (before the first section below the title that isn't one of its fields), since a real project's plans keep a log
  of rounds under "## Tasks" where any line may start with a word and a colon. Without one, the better of the title and
  the file name wins, the title when both are as good: an id (`M1`) beats a whole name (`accounts-households`, little words
  left out), which beats a name after a short id of another kind (`WS-walking-skeleton`), which beats a name with more
  words after it (a real project's title "Walking skeleton - one real recipe and shopping list") or the initials (`WS`).
  Two different ids never match (`M3.md` is never M2's). A plan that names a milestone neither the status table nor the
  brief lists, by its number, is a milestone of its own as before; a README never counts as a plan that matches
  nothing. Two plans for one milestone: shown is the one whose Milestone line names it, then title, then file name, then
  the one named for it (`<key>.md`), then the first by name; the page and the doctor say so either way. A task spec's
  `Milestone:` line that isn't a milestone's key goes through the same matching. Warnings only for a milestone that has
  tasks (its plan comes before them), or a plan that lacks a field, or two plans. Words in brackets after a label (M1's
  "Try it (accepted local flow; ...)") are kept at the start of its text, in brackets: they qualify the steps.
  Alternatives: fixed names only, which is what failed; a mapping in `nextlevel.json` (one more thing for the owner to
  keep); guessing by content (the plan's words), too loose to explain on the page.
- 2026-10-01 — **Patterns over the team's files run in time linear in a line's length (FR-016's review).** The
  orchestrator writes the files the Project page reads, and since FR-016 the doctor reads them too; a heading pattern
  with three `\s*` that share a run of spaces took 56 s on one line with 1,000 of them. So in `lib/roadmap.mjs` no two
  unbounded quantifiers can match the same characters next to each other: a heading's closing `#`s, colon and spaces
  are trimmed by hand from the end, each optional part of a label starts with what isn't a space, a label's words in
  brackets are taken off by hand, and a placeholder is tested per `<...>` part. A test reads 100,000-character lines of each
  kind in a child process it stops after 20 s, so a slow pattern fails the test instead of hanging CI. Alternatives:
  capping line lengths (it hides text the owner wrote), a timeout around the parse (Node can't stop a running regex
  in the same thread).
- 2026-10-06 — **A round starts only because something happened, and the hub decides it (FR-019).** Before, the hub
  started a round whenever no worker ran (3 minutes after the last, at most 8 an hour) and paused after three rounds
  "without progress", judged by a fingerprint every round changed itself. Now `lib/rounds.mjs` decides from what happened:
  real events (work moved: a task dispatched, merged, retried or closed, a push that sent new commits; or the owner
  acted), "always" triggers (the owner, a task attempt's end) and triggers held by the brake (a check, push or merge
  ending, a wake-up, the round after work moved, one retry of a cut-off round). A task attempt that ends is no real event
  (it starts a round but releases no brake): whether work moved is up to what the round does with it. A real event
  releases the brake as it happens, so the round in which work moved gets the next one straight after it. A trigger the
  brake holds back is let go, not kept for later (a later real event brings its own round). Alternatives: keep the timer
  with a longer gap (still rounds for nothing, only fewer), a fingerprint that leaves the team's own files out (what is
  "the team's own" changes with every role doc), the orchestrator saying "I'm done" (the model's claim; FR-019 is what
  that claim was worth).
- 2026-10-06 — **What happened is noted where it happens, and kept until a round starts (FR-019).** The hub notes the end
  of every job it ends, a merge, a branch deleted and a push with commits as it does them, and a task queued when it reads
  the queue; the owner's side of the cards is a count in each store (`lib/cards.mjs` `owner`), bumped only by the owner's
  methods (a decision the hub makes for itself on a push card, `decideGuard(..., { hub: true })`, isn't one), which the
  hub compares with the count it saw last. It all waits in `.nextlevel/rounds.json` (only the hub writes it) with the
  brake, the fuse and the wake-up, so a hub that was stopped, or autopilot that was off, finds what happened meanwhile and
  starts one round for it, and none when nothing is new. Turning autopilot on is no owner action of its own (it releases
  the brake and the fuse); Run a round now is. The first time (no `rounds.json`), finished jobs nobody reviewed wait for a
  round, and so do notes and replies the orchestrator hasn't picked up when the cards count nothing yet: what the hub
  before this version would have started a round for. Alternatives: observing job states every tick against a list of
  every job seen (a real project has 3,400 jobs), a journal file every process appends to (more writers, and the orchestrator
  could append to it).
- 2026-10-06 — **The hub doesn't refuse a commit from a round in which nothing real happened (FR-019).** The role doc says
  to end such a round without one, and the round's log keeps what it checked. A refusal would save no round: a commit no
  longer starts or extends one. It would hit legitimate words: a round the owner's reply or a task's end started often
  records what it decided (the owner's choice in STATUS, a review's result) without moving work, and a check job's result
  is evidence worth keeping. It would leave the changes in the main checkout, where they get in the way of the next merge
  ("uncommitted changes are in the way"), and an orchestrator told no tends to spend tokens getting around it. And
  "nothing real happened in this round" isn't known while the round runs: it may merge after it commits. So the brake and
  the fuse bound the cost of a noisy orchestrator (three rounds after the last real event; autopilot off after six in a
  row), and the commits it makes in them are noise in git, not tokens.
- 2026-10-06 — **Work spread over several rounds still finishes (FR-019).** A round has up to 60 minutes, which holds a
  milestone's planning; a round that dispatches, merges, retries or closes a task gets the next round straight after it,
  and every task that ends brings one, so a plan whose round ends with its first tasks dispatched goes on by itself. A
  round cut off at its limit (or by a crash, or from outside) runs once more. Waiting on CI goes through a wake-up after
  the push (a push with commits is real, so the rounds after it have the brake's three). What doesn't go on: a round that
  ends with "the next round continues" and nothing dispatched; the role doc says so (plan and dispatch in the same round).
  `test/autopilot.test.mjs` runs the brake, the fuse, the catch-up and the retries with a stub orchestrator.
- 2026-10-06 — **The fuse trips as the sixth such round starts, and turns autopilot off (FR-019).** "Six rounds in a row
  that start with nothing real between them": the sixth runs (it has started), and none follows; the phone (through
  `notify()`, redacted) and a card on Home say why and how to turn it back on. Turning autopilot on releases the brake
  and the fuse, and what happened while it was off gets its round. Off, not paused: a pause is for a setup problem the
  hub sees go away by itself; this needs the owner to look. The brake (3), the fuse (6) and the shortest wake-up (5 min)
  are `hub.rounds` in `nextlevel.json`.
- 2026-10-06 (revised 2026-10-07) — **A wake-up is the orchestrator's, its shortest wait doubled while nothing happens
  (FR-019).** `nextlevel wakeup <minutes> --reason "..."` writes `.nextlevel/wakeup.json` (its time in UTC, from
  `lib/clock.mjs`); the hub takes it in at its next look and as a round ends, before it decides the round's end. An ask is
  taken in once (its key, as the hub keeps it), whatever becomes of it: an ask the brake let go, taken in again from the
  file, would come due again at every look. An ask older than the last round's start, or the one in the file when that
  round started, is stale. It waits as long as asked, and at least `wakeMinMinutes` doubled for each round in a row that
  ended with nothing real (5, 10, then 20; the brake stops a wake-up after three such rounds), back to 5 after a real
  event; one asked during a round gets its time when the round ends, since that round counts. A round that asks for a
  wake-up gets no round right after it, even when work moved in it: the wake-up is its next round (the owner acting or a
  task ending start one sooner, and clear it). Revised in a review: before, the asked wait itself doubled
  after a round with nothing real, and the round right after a push cleared the push's wake-up and asked again, doubled,
  so a 25-minute CI run was read 8 minutes late and a 45-minute one 49 minutes late; now 1 minute (asked as long as the
  run usually takes). The reason is one line, redacted like the team's words, because Home shows it. Only the
  orchestrator asks, by the same kind of check as FR-017's owner-only commands (`NEXTLEVEL_AGENT=orchestrator`); a bar,
  not a wall (KNOWN_ISSUES). Alternatives: the orchestrator's own `sleep` in its round (it spends its time limit and the
  engine's tokens), a fixed poll of CI by the hub (the hub would need to know CI).
- 2026-10-07 — **Waiting on CI is a wake-up, not a check that polls the run (FR-019).** One `nextlevel verify` that
  polls a run until it ends (`gh run watch`, or a loop on `gh run view --json status`) would spend no Codex while it
  waits, and its end would start the next round at once. It would hold things up: checks and pushes share one lane that
  runs one job at a time (`pollJobs`: the orchestrator's git writes have the other), so every push (a task branch to CI,
  a deploy push the owner approved on the dashboard) and every other verify command would wait behind it for up to its
  time limit (`checks.timeoutMin`, 30 by default; a 45-minute run needs `--timeout`); and the guard's watch stays open
  for the whole check (`runCheck` runs it with the owner's access), so a protected file the owner edits by hand
  meanwhile is set back and held as a card. So the role doc's way to wait on CI is a wake-up for about as long as the run
  usually takes, and it says not to queue a check that polls. Later, if wanted: a wait the hub does itself (it reads the
  run's status with the read-only token, in no lane and with no command run), whose end is a job end.
- 2026-10-06 — **Time for rounds and wake-ups comes from one clock a test can move (FR-019).** `lib/clock.mjs`: this PC's
  clock, or under the tests' stubs only a time the test writes to a file (`NEXTLEVEL_TEST_CLOCK`), so the tests pass
  hours and the 1 November clock change without waiting. Only the rounds' logic uses it (wake-ups, the time limit, the
  hourly ceiling); job times and the day's numbers keep the PC's clock. Times are kept as ISO strings in UTC.
- 2026-10-07 — **A round whose engine never started counts toward the hour, and two in a row turn autopilot off
  (FR-019).** Found in review: a round that failed before its engine was launched (the round's process couldn't be
  started, ended before it started the engine, found no console, or left no sign within 45 s) put what started it back
  and counted nothing, so the hub tried again at its next look, every minute without end, with a window each time where
  rounds run in one, and Home said only "a round starts within a minute". Now "never started" means exactly that the
  engine was never launched: the round's process writes `launched` into `cycle.json` the moment it starts the engine
  (`onSpawn`), and anything launched is a round, whatever became of it (ended, crashed, stopped at its limit or from
  outside; a cut-off round gets its one retry under the brake). A round's process this hub started that ends before it
  writes `cycle.json` is known at once, with its exit code; only one it can't see (a window, or the last hub's) waits
  the 45 s. One that never started still gives back what started it
  and isn't counted by the brake or the fuse (nothing ran), but it stays among the hour's starts, Home names what failed,
  and the second in a row turns autopilot off like the fuse (`fuse.kind` `not-started`): the phone and a Home card say
  what failed, with the exit code, and how to turn it back on. Off rather than paused: the hub can't see the cause go
  away. Two, not one: a single failure (a PC busy starting) shouldn't need the owner. What the engine's checks catch
  before launch (missing, signed out, a model refused) keeps its own pause or stop, as before.
- 2026-10-07 — **Each FR-019 file has one writer, or is written under a lock (FR-019).** Found in review: several
  processes write some of the files rounds depend on, each by reading, changing and writing the whole file. Now:
  `rounds.json` is written only by the hub (`nextlevel run`: autopilot and the hub's job ends both run there); a wake-up
  ask is the `nextlevel wakeup` command's file, which the hub only reads, and each ask has an id, so the ask the last
  round cleared (`wakeCleared`) is never taken again without the hub deleting what the command wrote; Run a round now is
  a count the dashboard raises (`round-now.json`), which the hub compares with the count it saw last, so two presses are
  two, and a press while the hub reads is seen at its next look; the owner's actions are counted inside the cards' own
  lock. `settings.json` (autopilot on and when, held slots) is written by the hub, the dashboard, the menu and the
  orchestrator's and guide's windows, and `usage.json` (Today, now with what started each round) by the hub, the
  interactive windows and the assistant: both are written under `lib/filelock.mjs`, and so are the cards' stores (one
  lock for all, `cards.lock`). The lock is a folder made with `mkdir`, with a holder file in it: the holder's pid, its
  token, and the time it took the lock; the file goes to a new temporary file of a random name, `wx`, and is renamed.
  A dead holder is told by its pid and start time together, as everywhere a process is known (FR-013): a pid that runs no
  more, at once; a pid that runs but started after the lock was taken (another program's now), once the holder has kept
  the lock a second (Linux reads /proc, Windows asks PowerShell, which takes a few hundred ms). It is moved aside in one
  rename (of two waiters, one does) and taken. Revised in a review: before, a lock was judged by its
  folder's age alone (10 s), and after 12 s a writer went on without the lock. Now a writer waits 12 s at most, on its
  own clock (nothing in the lock folder moves it: not a holder that writes a new token every second, nor a folder dated
  in 2100), and then takes the lock over from any holder, alive or not (a process that hangs, or a holder file an agent
  wrote naming one), never skipping its write, and hub.log says so (`lockLog`). What has the lock's name and is no
  folder (a link, a file) is taken over at once; a folder without a holder file, 2 s after the writer first saw it so.
  A lock that can't be moved aside (on Windows, a process working in its folder) is waited for until 15 s, and then the
  writer writes without it and says so: a hub that hung there would stop everything, the time limit of a round
  included. And a writer writes only while the lock is still its own (its token, looked at right
  before the rename): one whose lock was taken over reads the file again and makes its change on it, so neither writer's
  change is lost (only one in the moment between that look and the rename can be; the third time it writes without
  looking, and says so). Skipping a write instead would lose that change for sure: the owner's "autopilot on" or Run a
  round now. The owner's two actions also read the file back and say on the dashboard when the lock was taken over or the
  file says otherwise right after. On Windows `mkdir` says EPERM (or EACCES) while another writer's lock folder is still
  being deleted: that means wait, like EEXIST (four writers at once hit it in most runs). A test runs four writers at
  once, a holder that ended, a pid another program has now, a holder that runs and changes its token for 12 s, a folder
  dated 2100 with no holder, a file in the lock's place, a folder that can't be moved, and a write whose lock was taken
  over. Alternatives: one file per writer (Home would merge them), a lock on `rounds.json` too (one writer needs none).
- 2026-10-07 — **What the hub reads from a round's files is checked like an agent's words (FR-019).** Found by the
  security review: `cycle.json`, `wakeup.json` and `round-now.json` are files the round's engine can write. The time
  limit stops only the round's process the hub started (its child, whose pid is no other program's while the hub holds
  it), never the pid `cycle.json` gives; a round in a window or one the last hub started stops its engine itself at its
  own limit (65 minutes). An exit code is shown only when it is a whole number; every line from these files loses its
  control characters and those that turn text around (`oneLine`). A wake-up ask is compared as the hub keeps it
  (`wakeKey`: its id only when it is the command's 12 hex digits, minutes up to a day, a time a date holds and at most a
  day ahead), so one whose text the hub shortened isn't taken in again at every look (it doubled its wait each time),
  and a wake-up waits a day at most. Only a string is a time, only a number or a string a number, and only those are
  text (`ms`, `oneLine`): a field an agent wrote as an object that throws when made a string reads as nothing, so no
  `wakeup.json` and no count in the cards' stores can make a look of autopilot throw (it did, and as the hub started, a
  round's end took the ask in too). Run a round now counts when the number changes and reads one out of range as 0, so a
  file set to 1e308 can't turn the button off. The hub's and the cards' JSON go to temporary files of a random name, `wx`
  (never through a link put at a name known in advance). The tests' switches (`NEXTLEVEL_TEST_*`) never come from a
  project's `.env`.
- 2026-10-08 — **A round the hub holds no handle for is told by its pid and start time (FR-019).** A round in a window of
  its own, or one the last hub started, was judged by its pid alone: after a restart of the PC (4 October ended with
  one) another program can have that pid, and the round would never end, Home saying "A round is running" for good. Now
  the hub reads that pid's start time (`processStartSync`) when it first sees it and at most once a minute after, never
  at every look (on Windows PowerShell answers it). The round's process is gone when its pid runs no more, or the
  program with it started after the round's process said it did (`cycle.json`'s `startedAt`) or before the hub started
  the round (its `startedReal`): then the round ends at once as cut off, and gets its one retry. One whose pid and start
  time say it still runs is never ended: it stops its engine itself at its own limit. Only when the start can't be read
  does it count as ended, once it is 70 minutes old (its own limit, 65, and 5 more). Nothing is ever killed by
  `cycle.json`: the round's engine can write it. Alternatives: a kill at the limit (the pid could be anyone's), the pid
  alone with a longer wait (still forever, after a restart).
- 2026-10-08 — **A round's own jobs start no round after it (FR-019).** A check, push or merge a round started and saw
  finish is in that round's hands: its end starts no round after it, also when the round asked for a wake-up (the
  wake-up stays its next round). The orchestrator's git commands already mark their job reviewed as they wait for it
  (`awaitGitJob`: `nextlevel merge`, `commit`, `cleanup`) and `nextlevel result` does; `nextlevel wait` now marks a check,
  push or git job it saw finish when the orchestrator runs it, in a file of its own in the job's folder
  (`seen-in-round.json`: status.json keeps the hub as its writer), which counts for the rounds only and never for a task
  (reviewed, `acked`, stays what it was: `wait --any` shows the job again). A task's end always starts a round: reviewing it is the
  next round's work. Before, a round that waited for its own check and ended got a round for the check's end (one of
  the brake's three, spent on nothing).
- 2026-10-08 — **The hourly ceiling is kept in the hub's memory too (FR-019).** KNOWN_ISSUES counts on 8 rounds an hour
  as the bound for an agent that passes for the owner, but the hour's starts were only in `rounds.json`, which an agent
  can write. The hub now keeps the starts it made in the last hour in its memory as well, and merges them in before every
  decision (each time as often as the file or the memory has it, whichever more: two rounds can start at the same
  moment). A hub that restarts has only the file again.
- 2026-10-08 — **rounds.json and cycle.json are read through a shape check, as wakeup.json is (FR-019).** Both are files
  the round's engine can write, and the hub took their fields as they came: a `log` or `what` written as an object that
  throws when made a string made `adoptRound` throw at every start (the hub never came up) and `followCycle` at every look
  (the round never ended). Now `rounds.json` passes `roundsProblem` (lib/rounds.mjs: each field its type), or is replaced
  by a fresh state built as on the first run, said once in hub.log and written by the hub; that fresh state takes the
  cards' owner counts as they are as seen, so the owner's old actions start no round (on a true first run, with no file,
  they still do: the hub before FR-019 would have started one). A file that isn't JSON counts the same. From
  `cycle.json` the hub counts only a string log, a whole-number pid, string times, an integer exit code and whether the
  engine was launched (`readCycle`). Alternatives: a try around each use (one missed use is the bug again), deleting
  the file (the round it records is lost without a word).
- 2026-10-14 — **The worker's agent file is quoted YAML, one file for every agy (FR-022).** On a real project, agy 1.3.4 failed
  the model check with "ERROR"; measured on this PC's 1.3.5 (it had updated itself again), the cause was nextlevel's own
  agent file: its plain `description:` held a second `: `, which isn't valid YAML. 1.3.2 read it (the 9 October workers
  ran as the agent), 1.3.4 drops it and, new in 1.3.4, refuses `--agent` with a name it has no agent for (exit 1,
  "unknown agent"). Every text in the frontmatter is now a double-quoted scalar (JSON's escapes are YAML's), which every
  agy reads, so nothing depends on `agy --version` here: there is no 1.3.2 way to keep. 1.3.2 wasn't run (agy can't be
  downgraded on the owner's PC); the stub plays both, and on 1.3.2 the quoted file is still an agent. `--agent` stays:
  without it a worker gets all of the owner's add-ons (FR-013), 27 864 input tokens for "hi" against 8 197.
- 2026-10-14 — **After 1.3.2 the agent lists its tools, and the probe asks for a file and a command (FR-022).** With the
  file fixed, the first real worker on 1.3.5 ran as the agent and answered BLOCKED: an agent without a `tools:` list gets
  only tools that look there, where 1.3.2 gave it the default tools. The list is decided from `agy --version` (after
  1.3.2; an agy that doesn't say counts as the newest), as the task asked where versions differ, and holds only agy's own
  tools a worker uses, each a name 1.3.5's registry knows (an unknown one stops the run). The worker's process asks
  `agy --version` as it starts (with the updater off), so the trial and the worker write the same file for the same
  version. The model check's probe now asks agy to write a file with its tool and run `node --version`, and a run whose
  own steps show neither fails ("agy ran, but its worker agent wrote no file and ran no command"): it costs one write
  and one command a trial (about 8 000 input tokens on 1.3.5), and a check that passed while every worker was BLOCKED
  said nothing. Alternatives: the default agent (FR-013's isolation gone, 27 864 tokens for "hi"), every one of the 60
  names the init event lists (MCP and plugin tools among them, and names the registry refuses), a probe that only asks
  for "ok" (it passed here).
- 2026-10-14 — **The model check's trial runs what a worker runs, from one function (FR-022).** The trial ran another
  command than a worker's: the doctor's environment with the project's `.env` in it, through cmd.exe when agy is a `.cmd`,
  where a worker gets no `.env`, the push block and a direct start. `lib/workerspec.mjs workerRun` now builds both (the
  arguments, the environment, the launcher and the files written where it runs), and the trial differs only in the
  prompt (the probe, without the worker's "read AGENTS.md first": there is no project there), the limit (2 minutes) and
  the folder (a temp folder: the folder made no difference on 1.3.5, so it isn't made like a slot). The console runner
  takes `direct`, so a `.cmd` shim's program starts without cmd.exe there too. The answer's key is made from that whole
  run (its arguments, files, launcher, the environment as far as it says how agy runs, the program and agy's version),
  hashed: the same for the doctor and the hub, so either one's answer counts for the other. The environment's part is the
  variables agy reads and those nextlevel sets (AGY_*, GEMINI_*, GOOGLE_*, the proxy, the home folders, the push block),
  not PATH or a terminal's own, which differ between the hub's process and the doctor's without changing the run.
  Alternatives: the whole environment (the doctor's and the hub's answers would never meet, and a trial would run for
  every task), a slot-shaped trial folder (nothing measured needed it).
- 2026-10-14 — **A refusal is kept an hour; a pass until the run changes (FR-022).** The doctor tried a refusal again at
  every run, and the dashboard runs the doctor whenever its page comes back into view: each time a one-line prompt on
  the owner's plan. Now the doctor keeps it an hour, as the hub does, and no answer (agy hung) ten minutes; Check again,
  `doctor --fresh` and a Team page save try again at once (the owner is there, choosing). The hour goes by
  `lib/clock.mjs`, so a test moves it.
- 2026-10-14 — **Tasks on agy wait for a passing trial, and nothing falls back by itself (FR-022).** Before, nothing
  stopped a task from starting on an agy that refused what a worker runs: for agy `engineProblem` only asks whether it
  is installed, and every task would have spent an attempt. Now `startTask`, once the task's profile is final (an
  automatic fallback onto agy included), needs a passing trial for exactly what that worker runs; the doctor's kept answer
  counts. Without one the hub runs the trial in a child process it follows (`nextlevel _trial`), never in its tick (a
  trial takes up to 2.5 minutes, and a hub that misses its heartbeat for 90 s counts as stopped); it isn't a job. While it
  runs or fails, the tasks on that agy stay queued with `waiting: ...` (status, the job's summary, `wait`, which says how
  to move one); tasks on other engines go on. This is apart from `engineProblem`, which stays as it is, and from
  FR-013's `dispatchPaused`, which stops every task. **Nothing falls back by itself**: agy's ERROR can be a usage limit
  (1.3.3 reports a quota at once instead of retrying), and a fallback is never for a provider's limits (CLAUDE.md), so the
  owner or the orchestrator moves a task: `nextlevel retry <id> --fallback` (or `--engine`, `--profile`) takes a held task
  that never started, the same attempt with no feedback needed, the one queued task a retry takes. A hold's start is a
  card on Home (the version and agy's reason in one line, Check again), one phone message, and one round for the
  orchestrator, a trigger under FR-019's brake like a check ending (not a real event); its tries after that start none.
  The hub tries again on Check again, when the version, model, flags or environment change (another key), and otherwise
  once an hour; a pass releases the tasks. The bridge test refuses at once while agy is held (its workers would only
  wait). Alternatives: the hold inside `engineProblem` (its callers move a task to a ready fallback or start it anyway),
  the doctor's check in the hub's tick (it blocks the heartbeat), holding every task (FR-013's pause: a broken agy would
  stop Codex and Claude Code workers too).
- 2026-10-14 — **A hold ends with its tasks; a PC without the console with no window isn't held (FR-022, review).** The
  architect's review found two dead ends. A hold was cleared only when a waiting task reached the gate, so after the owner
  moved every held task (`retry --fallback`) or moved the workers off agy, the Home card stayed for good and the bridge
  test refused on it. Now the hub looks at every tick: with no task waiting, a hold whose trial passed since goes, Check
  again runs the trial for the hold's own profile (kept in the hold), and otherwise it goes too (the next agy task tries
  again first). The bridge test looks at the kept trial for its own run, not at the hold. And on a PC where the console
  with no window doesn't start (FR-010's memory), the trial can't run as a worker would (in a window: it would take the
  focus), returned no answer, and the hub started another at every tick, so no agy task ever started: there tasks start
  as before (the doctor warns that what a worker runs isn't tried), and the trial's "no console" is kept like a refusal.
  A trial that ends with no answer (killed at its limit, or a crash) keeps a short "no answer" (ten minutes), so the next
  one waits. Also from the review: a run that ended SUCCESS with exit 0 gets no "ended with an error" from an error it
  got past; the trial child logs both keys when its run differs from the hub's; the check says when workers run in a
  window of their own and the trial in the console with no window. Not taken: a lock on `check-cache.json` (its writers,
  the doctor, Setup and the trial child, write rarely; a lost update costs one more trial, never a wrong answer kept).
- 2026-10-14 — **agy's own words, wherever a run on it fails (FR-022).** The check showed "ERROR" and dropped the rest of
  what agy said. `agyFailure` reads agy's reason (the result's `error`, its error events, an `AGY_ERROR` line, its error
  line, the response of a result that isn't SUCCESS) and keeps the exit code and its last lines (about 20); the check's
  detail, the Team page's "Not saved", the job (`engineError`, and a section in `nextlevel result`) and hub.log show them;
  the phone and a card's headline get agy's reason in one line. All of it is redacted like a report, and also with every
  string in the args, env and headers of the owner's MCP servers' settings (`~/.gemini/config/mcp_config.json`: Stitch's
  key is in a header argument on the owner's PC). Six characters at least: `-y` and `npx` are no secret worth blanking.
- 2026-10-14 — **Closed tasks are a record of the hub's, not a job state (FR-021).** a real project's orchestrator closed five
  tasks at the owner's word by writing "closed" in their specs, and the Project page counted them as planned. A task is
  now closed with `nextlevel close`, through a git job the hub runs (it checks the task again), and the closure is kept
  in `.nextlevel/closed.json`, which only the hub writes (its close job, a `cleanup --discard` that throws a branch
  away, a dispatch or retry that reopens one) and every reader takes through a shape check. No new job state: the file
  protocol stays as it is (CLAUDE.md), and a task never dispatched has no job to give one. A merge or an active job
  always outranks a closure, so the page never hides work that runs or landed. Alternatives: a `closed` state on the job
  (no job for a task never dispatched; every reader of states would change), reading "Status: closed" in the specs (the
  team's free text: the page would count what an agent writes, and a typo would hide a task).
- 2026-10-14 — **"Merged into the base branch" for closing is an ancestor off the base branch's own line (FR-021).** A
  task's branch is made from the base branch and merged `--no-ff`, so one whose tip is an ancestor of the base branch is
  merged only if the tip isn't on the base branch's first-parent line; a branch still at the commit it was made from (a
  blocked task, a review that changed nothing) is an ancestor too, with no work of its own, and closing it throws nothing
  away. A real project's M0-06 and M0-43 are such branches. Close refuses a merged task (by that, the merge log or a finished
  merge job), and deletes an empty branch without `--discard`.
- 2026-10-14 — **The hub's merge commit names its task whatever the -m text (FR-021).** The Project page counts a task
  merged from the merge log's subjects; `nextlevel merge -m "..."` used the text alone. The subject now starts with
  `Merge task/<id>: ` unless it names the task first; a text that says "into task/" (which the page reads as the hub's
  merge of the base branch into a task, before a retry) goes below the subject. Finished merge jobs count as merged too,
  for a merge an older nextlevel made with its own text and for a branch "merged already" (no merge commit). On a real project
  that changed no task: every finished merge job is in its merge log.
- 2026-10-14 — **The Windows check may run 60 minutes, not 40.** Main's Windows runs now take 28 to 37 minutes and a
  passing pull request's took 38m58s (#33); on 14 October the 40-minute limit cut off #34 twice and #33 once, each time a
  whole Windows run spent for no answer. 60 leaves room for the suite to grow while a hung run still stops. The owner's
  choice. Alternative: keep 40 and cut the tests' time (done once for #34; the suite grows with every fix).
- 2026-10-15 — **An attempt is judged on its own work, and a missing report always says why (FR-020).** WS-62's attempt 10
  ended "done · verify pass · worker says MISSING · 18 commit(s)": 16 of the commits were earlier attempts', and nothing
  said that Claude Code had ended its turn to wait for a background command. The hub records the branch's tip after its
  own merge of the base, just before the worker starts (`startTip`); the attempt's own commits are those after it and not
  on the base (`git log task/<id> ^<tip> ^<base>`), so the hub's commit of what a worker left, and of a merge it
  resolved, count as the attempt's; a tip no longer on the branch is said, and an attempt an older hub started is judged
  as before. A worker that can write git and merges the base itself (feedback that doesn't trigger the hub's merge) gets
  that merge counted as its own: with no report and verify passing it would end "finished without a report". Rare, and
  its diff stat shows the merge; left as it is. `commits` stays the branch's (the orchestrator's prompts read it); `ownCommits` and `ownDiffStat` are new
  fields, and the summary says both. Alternatives: count from the base (what it did), or record the tip before the merge
  (the hub's merge of main would count as the attempt's work).
- 2026-10-15 — **Finished without a report is `done` with a mark, not a new state (FR-020).** The file protocol and
  every reader of a job's state stay as they are (CLAUDE.md); `mark` ("verify passed", "nothing verified") is shown in
  the summary, `result`, the job view and Ask. Only when the engine ended normally (exit 0, in time, no error end of its
  own), the attempt has commits of its own, and verify passed or there is none to run; for a design, research or map task
  its own commits must change its result file; a review's result is its report, so a review without one fails. A file
  with no Status line is still a report: it says so and is judged as before, except that
  one with no commits of its own is `no-changes` (a review: else it ended `done` on earlier work). Alternative: a state of its own (every
  FINAL list, the dashboard's colours and the orchestrator's prompts would need it).
- 2026-10-15 — **Every engine's end in one field (FR-020).** FR-022 kept agy's reason only when a run failed
  (`engineError`). Each adapter now has `end(text, { code })`: Claude Code's last `result` event (subtype, is_error,
  num_turns, its last answer, the background commands it stopped after it), Codex's last turn (`turn.failed` or an error
  after its last turn), agy's result status; it is kept as `engineEnd` on every attempt, redacted as FR-022 did, and shown
  one way (`endWords`, `nextlevel result`'s "How <engine> ended"). An engine that says it failed fails the attempt
  whatever its exit code, since Claude Code's error subtypes need not exit 1. `engineError` stays for an attempt that
  failed, for what reads it. Measured, not guessed: `--max-turns 1` on 2.1.284 (a fixture the stub plays).
- 2026-10-15 — **Claude Code workers run with no background commands (FR-020).** `claude -p` ends when the model ends its
  turn and stops what still runs, so a worker that backgrounds its long check and waits loses it and its report.
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` takes the background away (measured), `BASH_DEFAULT_TIMEOUT_MS` and
  `BASH_MAX_TIMEOUT_MS` let a foreground command run half the attempt, at least 10 minutes, so the report still fits (Bash's
  own limit is 2 minutes, 10 at most; WS-62's verify list took about 26 minutes of 60). Not the whole attempt: the hub
  stops the worker a grace period after it, so a command that hangs, or a long one started late, would outlive the
  session and leave no report (a review). `Monitor` is denied. Every engine's worker is also told, in its prompt,
  where its report goes, its first line, and that its session ends with its turn, whatever WORKER.md the project has.
  Alternative: only the prompt (a model can still decide to wait); only the switch (agy and Codex have their own ways to
  stop early).
- 2026-10-15 — **The attempts alert counts how attempts ended, and acts on nothing yet (FR-020).** One category per
  recorded attempt (failed verify, engine stopped, engine error, timed out, no report and no changes, no report but
  verified, blocked, done), then the runs stopped from outside or not started (not counted) and the attempts from before
  the hub kept them. The phone still gets one message per task, attempt and kind. What to do about a stuck task (the
  stuck ladder) is a later pull request.
- 2026-10-15 — **Every push is checked for changes to protected files (a review of 14 October).** The guard
  held a protected change at a task's merge and at the orchestrator's commit, but not at a push: `nextlevel push ci/x
  --from task/<id>` sent a worker's change to `.github/workflows/ci.yml` to origin, and GitHub runs a pushed branch's
  own workflows, which can raise their token's permissions and read the repository's secrets, before the owner saw the
  change at the merge. Now `pushBranch` reads what the outgoing commit changes in protected files compared with origin's
  base branch (`merge-base(<origin's base>, <sha>)..<sha>`, as guardMerge reads a task: each file's path and content before and after,
  and their key), and a push with a change the owner hasn't approved waits on a card like a deploy push: one card per
  branch, Approve pushes exactly that commit, Reject pushes nothing, a branch that moved asks again; a deploy push that
  also carries one gets one card that says both. Compared with the base branch, not with origin's copy of the target:
  what matters is what the branch brings that the owner hasn't approved, and a branch made from main carries nothing
  (backup/main, a CI branch). **One decision per change**: a push's record keeps the files' key (`filesKey`) and, when
  its branch is `task/<id>`, the task; a merge's record has the same key. Approved on a task's merge card, or on a push's
  card once that push went out exactly as shown, or content the owner made or approved (`isApproved`), counts at the
  other point; a rejection on either stands at the other; matched by the key alone, and also by the task when both name
  one (a task's change is never decided by another task's record). A push's approval counts elsewhere only once it went
  out: an approved push whose branch moved first is superseded and asks again, as a deploy push did. When the owner
  decides one card, the other card still asking about the same change closes, saying where it was decided, and the task
  or push job it held is told what follows. The record matching is by content, never by commit: a rebase that keeps the
  files as they were needs no new decision, and an edit to one file does. **Origin's base branch, not the local one**
  (a review): the slots are worktrees of the main checkout and share its refs, so a worker can move the
  local main to its own commit, and its change would read as already there. Origin's base moves by the owner, or by a
  push the hub makes, which this guard reads first. With no merge base, or no origin's base here, a push is compared with
  the empty tree: every protected file on the branch counts (a worker can make a branch with no history, `git checkout
  --orphan`). Since origin's base can be behind the main checkout's (approved merges not pushed
  yet), a file whose content the owner made or approved (`isApproved`) is left out first; what is left is the change the
  card asks about and the key the records are matched by, which is then what the task's merge card had. An approved push
  is read again before it goes out, so a rejection of the same change on its merge card in between stops it.
  The owner's own writes are recorded as they are on disk, so git's copy of a file is also compared as git would check it
  out (`core.autocrlf` keeps START.cmd CRLF on disk and LF in git on Windows).
  Alternatives: compare with origin's copy of the target branch (a new branch would compare with nothing, and a branch
  pushed once before the guard would carry its change unseen); refuse every push of a `task/` branch (the orchestrator
  pushes CI branches made from tasks, and the change would only move to another name).
- 2026-10-16 — **Workers have arguments of their own (`engines.<engine>.workerArgs`), so Codex workers can leave the
  sandbox while the orchestrator keeps it.** `engines.<engine>.args` went to every role on that engine, and loosening it
  for workers would have loosened the orchestrator (no network, `.git` read-only). Not set (`null`): workers get `args`,
  as before; `[]`: none at all, as `"deployBranches": []` means none. Every worker task on the engine gets them, however
  it was chosen (the workers, their fallback, `--engine`, `--profile`, a spec's `Engine:` or `Profile:` line, a retry):
  the arguments belong to the engine's workers, not to a role, so a task sent to Codex with `--engine` is a Codex worker
  like any other. Everything that starts, checks or describes a worker reads them through one function (`workerArgsOf`);
  `codex.sandbox` and `codex.args` still guard `args`. Alternative: a per-role `args` on profiles (a task sent with
  `--engine` would have none).
- 2026-10-16 — **Codex workers without Codex's sandbox, like the other workers, when the owner chooses it on the Team
  page.** On Windows the sandbox runs a worker's commands under accounts of its own, which Docker's pipe and pnpm's store
  refuse, with network or not (measured: KNOWN_ISSUES), and whoever can use Docker effectively has the whole PC (a
  container can mount the drive), so running Docker steps in the hub for a worker would add slowness, not safety. A
  worker without the sandbox is where Antigravity and Claude Code workers already are: a slot of its own with no
  secrets, where git refuses pushes (FR-003), now also with no gh sign-in. `--sandbox danger-full-access` with `-c
  approval_policy=never` rather than `--dangerously-bypass-approvals-and-sandbox`: the first was enough to run
  unattended with network, git and Docker on 0.160.0, and the explicit approvals setting keeps an owner's
  `approval_policy` in `config.toml` from stopping a worker. In the sandbox the switch turns its network on with `-c` on
  the worker's command line, never in `~/.codex/config.toml` (the orchestrator would get it too). The default stays in
  the sandbox until the owner chooses otherwise; the doctor says the full access as information, as for Antigravity
  workers.
- 2026-10-16 — **Every worker gets a gh folder with no sign-in (`GH_CONFIG_DIR`).** The push block's `GH_TOKEN` is a
  token that doesn't work, but gh still lists the owner's own login beside it and uses it once the variable is gone
  (measured: KNOWN_ISSUES, "GitHub CLI"), which Codex's shell can do for a worker. A folder with no `hosts.yml` leaves gh
  signed in as no one, and its name has none of KEY, SECRET or TOKEN, so no engine drops it. It stops that, and gh used
  without thinking; it is no wall, the push block's level: a worker that unsets `GH_CONFIG_DIR` too gets the owner's
  keyring login back. Given to every worker task on every engine (its process and its task's verify commands in the
  slot) and to `nextlevel verify` (its GitHub reads use `GH_TOKEN`, the read-only token, and git's own helper, neither
  needing gh's folder; a review), never to the hub's own gh, the orchestrator or the setup guide. One folder
  in the temp folder for every slot and project: the hub takes out a `hosts.yml` left there before each task starts. The bridge test's workers ask `gh auth status`, and the test fails if gh answers as anyone. A Codex worker
  also keeps the hub's variables whatever `config.toml` says (`-c shell_environment_policy...`), and on Windows gets
  `PSExecutionPolicyPreference=RemoteSigned`, the policy for its own process, which changes nothing on the PC.
- 2026-10-16 — **The bridge test keeps a verdict per engine, with the workers' arguments it ran with.** One verdict for
  the last run meant a Codex run replaced Antigravity's, and nothing asked for the test again when Codex workers left
  their sandbox. Now `.nextlevel/bridge-tests/<engine>.json` keeps each engine's, with its version and arguments, and the
  doctor asks for one per worker engine in use (the workers' and their fallback's). `bridge-test.json` is still written as
  before, since an older nextlevel reads it; a record there counts for its engine while that engine's workers have no
  arguments of their own (it ran with `args`). The verdict on gh comes from what gh printed (the worker's log and
  report, "Logged in to <host> account <name>"), and a worker that didn't report trying gh doesn't pass.
- 2026-10-16 — **A second worker, and a task's engine chosen by what it needs (Codex workers, part B).** The owner's
  Codex plan has credits to use while the workers stay on Antigravity, so a second worker (`roles.worker.second`) shares
  the slots, with a note on what it takes ("tasks without Docker", "any task", "only when the spec asks") that the
  orchestrator's role doc tells it to follow. It is reached by one name, `second` (`--profile second`, a spec's
  `Profile: second` line), whatever engine it is on, so no profile may be called that. In the profiles list it is a worker
  marked second: every check, `profiles.full-access` and the bridge test that look at workers cover it, and an engine only
  it uses counts as a fallback's does. A task on it is no engine switch on Home, and escalates like any task.
  Alternatives: a list of workers (more than the owner asked for), or a profile the orchestrator names (it has no say
  in which profiles exist).
- 2026-10-16 — **A worker task on an engine named on its own takes a worker's model there, never the orchestrator's.**
  Before, an engine named on its own took the model and effort of the first role on it, the workers' then the
  orchestrator's: on a real project every task sent to Codex (`--engine codex`, a spec's `Engine: codex`, a retry that kept its
  engine, `--fallback` to a fallback named only by its engine) ran on gpt-6.1-sol at xhigh, the orchestrator's, on scarce
  Codex usage. Now, for a worker's task: the workers', then the second worker's, then a fallback's with a model of its own;
  with none, the engine's own choice, and dispatch says so. The setup guide on an engine named on its own keeps the old
  order (it is the owner's window, where the orchestrator's model is a fair choice).
- 2026-10-16 — **A task says what it needs (`Needs: docker, network, packages`), and the hub keeps it off a worker that
  can't give it.** Codex workers in Codex's sandbox can't give Docker or package installs on Windows, network or not, nor
  the network on any system unless it is turned on (measured: KNOWN_ISSUES, FR-009). A spec's line, read like `Kind:`;
  each adapter says what it can't give (`workerLacks`). Refused at dispatch (saying which worker can), and checked again at
  start once the profile is final (the workers' role may have changed since): the task waits in the queue
  (`waitingFor: 'needs'`, as FR-022 holds agy tasks), the orchestrator gets one round, `wait` says so at once, and a
  retry with `--engine`, `--profile` or `--fallback` moves it, the same attempt. It never started, so no attempt is spent
  and FR-020's attempts list doesn't have it. The automatic fallback never moves a task onto a worker that can't give what
  it needs. Docker and package installs are Windows-only, as measured; the network applies everywhere. Alternatives: guess
  from the spec's commands (unreliable), or let the worker find out and report BLOCKED (an attempt spent, and scarce usage).
- 2026-10-16 — **The orchestrator on Antigravity runs behind nextlevel's own walls, proven by a lock test (Argon roles,
  part A, `docs/design/antigravity-roles.md`).** Measured on agy 1.4.0 with Gemini 4 Argon: agy's sandbox can't run a
  command on this Windows (11 22H2) and doesn't cover its edit tools, plan mode lets the edit tool write, the deny-list
  didn't stop `gh`, and the owner's own agy settings approve every command. So nothing of agy's is the wall. The
  orchestrator's window and its rounds on agy get verify's push block (one builder now, `lib/pushblock.mjs`, without the
  read-only token: no GitHub reads for it, for now) and run as nextlevel's agent, `nextlevel-orchestrator`, with none of
  the owner's MCP servers and add-ons (a round as agy's default agent reached the owner's GitHub MCP server, which the
  block can't reach). The agent file is written into the main checkout before each start, kept out of commits by
  `.git/info/exclude`, recorded as the hub's own write for the guard. A lock test proves those on this PC before the role
  may start, in a throwaway project of its own, each try a real round's process (`_locktry`); its verdict is keyed with
  `runKey` of the role's run, and the hub runs it again by itself after an agy update (agy updated 1.3.4 to 1.4.0 within
  two days), holding autopilot's rounds before they start (a held round isn't a round, so FR-019's fuse never counts it).
  Never a fallback: what holds the role is a fact about this PC. What stays open is said in plain words: one command that
  clears the block pushes as the owner (measured), so the hub reads each round's commands for that afterwards, by pattern.
  Alternatives: agy's sandbox (fails closed here, and misses the edit tools), agy's deny rules in the owner's settings
  (not ours to change, and not enforced), refusing agy for the orchestrator (the owner wants Argon in every role).
- 2026-10-16 — **The lock test's MCP try is the one try that passes on an absence.** The owner's MCP servers must not be
  offered to the role. There is nothing to call that proves it: the try passes when agy took the role's agent, the agent
  file (its hash in the verdict) has `inheritMcp: false` and no MCP tool, and the run ended with no `call_mcp_tool` step
  and the model saying it has none. Any MCP step fails it; another refusal is "not tried", never a pass. The input tokens
  (57 000 as agy's default agent, 8 000 as nextlevel's) are kept as evidence, without a threshold. Alternative: a stub
  MCP server in the throwaway project (whether agy loads a project's MCP config wasn't measured).
- 2026-10-16 — **Every push looks for `.env` values in what it sends.** An engine that writes git itself in the main
  checkout (Antigravity, Claude Code) commits without the hub's `nextlevel commit` and its scan. So `pushBranch` reads each
  commit that goes out (from origin's copy of the branch, else the merge base with origin's base branch, else the whole
  history), each against its parent, so a value added and taken out again in the same push still counts; a value origin
  has already holds no later push. It holds the push with the same card as a merge's, the value never shown, and runs for
  an approved deploy push too (that approval wasn't of a value its card didn't show). More than 300 commits are read as
  one change, and the log says so.
- 2026-10-16 — **A protected file the orchestrator commits itself.** The guard sets it back on disk and holds it, and the
  commit stays. Approve makes the content the owner's, so a push of it needs no second card; Reject makes the push guard
  refuse any push that carries that content, naming the commit to revert, and the card's answer tells the orchestrator
  the same. Rewriting its commit for it was the alternative: nextlevel never rewrites history the team made.
- 2026-10-17 — **The assistant on Antigravity answers in a throwaway copy of the project (Argon roles, part B).** Nothing of
  agy's own keeps it read-only, so a question gets a copy (`git clone --shared --no-checkout`, no remote, the working tree
  as it is on disk without .env files and what git ignores; 0.7 s on a fresh project), the question in a file there
  (`.nextlevel-ask/QUESTION.md`: agy's stdin is its console), agy as `nextlevel-assistant` with the push block and
  NEXTLEVEL_READ_ONLY=1, its nextlevel commands pointed at the real project (`NEXTLEVEL_READ_ROOT`, honoured only under
  NEXTLEVEL_READ_ONLY=1, where only the commands that look run), and the copy removed after (leftovers by the hub after an
  hour). The push block is built for the real project's remotes (a push from there, `git -C`, is the one that matters).
  The tripwire runs in the process that runs the question, so it holds with no hub: HEAD, refs, `git status` and the
  protected files' hashes before and after; a difference is said in the answer and on Home (it may be the owner or the
  hub, so it says that too). It starts only with a passing lock test for the assistant on this agy version; the hub runs it
  when that changes, and holds questions meanwhile (one hold per role now). Its automatic choice stays Claude Code and
  Codex. Alternatives: a kept copy brought up to date (only if a copy per question is slow on a large project), refusing
  agy for the assistant (the owner wants Argon in every role).
- 2026-10-17 — **The assistant's agent says where it is, not "never edit".** With "never edit" in the agent's body, Argon
  declined every lock-test try that changes something, so the lock test couldn't prove where a change lands. The agent's
  body says it works in a throwaway copy; the question's briefing says it is read-only, as for every assistant; and the
  lock test's tries that change something say they are the owner's test, in the copy, once.
- 2026-10-17 — **A worker outside its slot is said after its attempt, from its own log and git's reflog.** N7's worker on
  a test project wrote a file outside its slot through a path it typed wrong, and nothing noticed. Stopping it takes a
  worker that can't write there (FR-017 part 2B); until then the hub reads each attempt's steps from the engine's own
  output (agy, Claude Code and Codex alike: unsandboxed Codex workers reach as far) and the main checkout's reflog, where
  the hub's own git jobs are tagged with `GIT_REFLOG_ACTION=nextlevel-hub` so a move by anything else stands out. The
  guard's watch on the main checkout stays open while any worker runs, as during the orchestrator's work. One Home card
  (the latest) with Seen, one phone message per attempt; nothing fails the attempt, since the work in the slot can still
  be good. Alternatives: a file watcher on the home folder (too wide and too noisy), failing the attempt (the owner
  can't tell a typo from an attack from a card that blocks work).
- 2026-10-17 — **A held push's card says why it is held.** Its Why named a deploy branch even when only protected files
  held it; it now says the deploy branch, the protected files, or both, and the Blockers headline names a push as one
  ("A push to <branch>"), as the Notes page does.
- 2026-10-17 — **Task specs and STATUS.md are read with LF line ends; a Verify heading with no command is said.** A spec
  saved on Windows (CRLF) lost its Verify block (`dispatch` said "0 verify command(s)" and the task ran with no verify),
  found in the FR-020 owner check. The Verify parser and `getState` turn CRLF into LF first, as `roadmap.mjs` already did
  for plans, PROJECT.md and DECISIONS.md; a test feeds every Markdown parser a CRLF copy and expects what LF gives. And
  `dispatch` warns when a spec has a Verify heading but no command came out of it, so a parse miss can't pass silently.
  A warning, not a refusal: a Verify section in prose is the orchestrator's choice.
- 2026-10-16 — **Releases instead of main (safe updates, part A; `docs/design/safe-updates.md`).** The installed tool
  updates only to a release: an annotated tag `vX.Y.Z` on main, made by a session once the owner says the owner check of
  that commit passed (CLAUDE.md, "Releases"). The tool takes a tag as a release only when it is annotated, its message
  starts with "nextlevel <name>", its commit is on main's history, it is not below `FIRST_RELEASE` (v0.1.0: from there
  every version has the launcher and channels) and it never moved (`releases.json` keeps every release tag as first
  seen); an update goes only to a release with a higher number that also comes after the installed one in main's
  history. Tags are fetched into `refs/nextlevel/tags/` with a forced refspec, so a tag that moved or vanished on
  GitHub never makes a fetch fail (a plain `--tags` fetch refuses to move a local tag and exits 1). The notes are the
  tag's message in a plain format (Fixes:, New:, After install:, `Safety:`); `docs/RELEASES.md` is the record for
  people. Alternatives: GitHub Releases (the API, editable afterwards), or notes read from a file on main (main moves
  after the tag).
- 2026-10-16 — **Each version in a folder of its own, and a launcher (safe updates, part A).** A version is a git
  worktree of the tool's clone in `~/.nextlevel/versions/<name>`; nothing ever changes a version's files, so a command
  still running the old code never sees them change (Node loads some modules only when first used; cmd.exe reads a
  running batch file as it goes), a failed update leaves the old folder as it was, and going back is pointing at it
  again. The `nextlevel` command runs `~/.nextlevel/bin/launch.mjs`, which runs the version the project follows: its
  channel in `channels.json` (`release`, `pin`, `candidate`), kept in the home folder, where Codex's sandbox can't
  write, and set only by the owner. `NEXTLEVEL_VERSION` comes first: a version puts its own name there, and its own
  command first on PATH, for everything it starts, so an agent's `nextlevel` runs the hub's install and version (the
  architect's change 2). A missing version folder stops the launcher with the repair command; it never runs another
  version, which could be older than the project's files need. The command file, `nextlevel.cmd`, now names the
  launcher and never changes again once the installer wrote it. Alternatives: updating in place (what still runs sees
  its files change), two alternating folders for antivirus exceptions (a folder rewritten while something may run it;
  one folder exception on `versions` covers every version instead).
- 2026-10-16 — **Nothing installs at a command's start, and a plain `nextlevel update` is the owner's too (safe updates,
  part A).** An owner command only says, in one line, that a release is available (from `update/available.json`, which
  the hubs refresh at their start and every 6 hours, and the dashboard at its start, through `nextlevel _releases`, a
  child process: a fetch can take a minute and the hub's tick must go on). `nextlevel update` refuses in an agent's
  session, plain or not (DECISIONS, 30 September, let a plain one through because it only fast-forwarded the branch the
  owner chose; a release is the owner's decision now). `--force` is gone: with folders of their own nothing needs to
  update under running work, and "don't wait" would stop workers mid-task. `--to` takes a release only; a branch is a
  channel. Until the one-click update (part B), `nextlevel update` still waits while a hub or worker runs.
- 2026-10-16 — **A field report's fix waits for its release.** The fix is marked by its pull request's own merge commit
  (`fixSha`, from GitHub's `mergeCommit`), not main's head when the issue closed (which may hold unreleased work). The
  phone hears it once merged ("it comes with the next release"), once a release has it ("Update on Home"), and the
  verdict once the installed version has it and the report's checks ran again. Older records keep `mainSha`.
- 2026-10-16 — **A trial install has a home of its own (`NEXTLEVEL_HOME`), and runs on a copy of a project.** The
  owner checks pull requests A and B before the first release without touching the install their projects run:
  `scripts/trial.mjs` makes `~/.nextlevel-trial` with a local stand-in for GitHub holding this checkout as v0.1.0 and
  a commit after it as v0.1.1 (the real floor: no code path lowers it for a trial), and a copy of the project (the
  guard's records and second accounts stay in `~/.nextlevel`, keyed by project folder, so a trial on the project itself
  would leave records the real install doesn't know). A trial home takes slot port blocks above the owner's own.
  Alternatives: a changed `USERPROFILE` (signs the engines out), the installer's `NEXTLEVEL_DIR` (moves the owner's
  install), or the dev checkout (a session's folder, switched and reset under a running hub).
- 2026-10-17 — **The one-click update is a detached updater, from the new version's folder (safe updates, part B).**
  The owner's click (Home's Update, or `nextlevel update` in their own window, which follows the same updater) writes a
  plan in `~/.nextlevel/update/<id>/` and starts `nextlevel _update <id>` detached, so it outlives the dashboard that
  started it and the hubs it stops (on Windows a detached process leaves Node's kill-on-close job). It prepares from the
  version it leaves (fetch, the release checked again, its folder, the doctor as it is), then hands over to a copy of
  itself from the new version's folder; every later step runs there. It waits for running work (tasks, rounds, checks,
  pushes, git jobs, the orchestrator's and the guide's windows; no time limit, with Stop waiting), pushes the backup branch
  where a project sets one (`updates.backupBranch`, never a deploy branch; a refused push pauses before anything changed,
  with "Update without the backup"), stops each hub and dashboard after recording how it ran (`hub.json`'s and
  `ui.json`'s `window`, `version`, `argv`, `open`), switches, starts them again the same way (never with
  `--autopilot`: the switch is in settings.json and stays, so FR-019's brake and fuse are untouched and the update is no
  real event), refreshes and commits the unedited templates through the hub as the owner's change, runs the bridge test
  only where it passed before and asks again after, and compares the doctor's rows (one that passed before and fails now,
  warn or error, pauses). Alternatives: the dashboard's process (one of those being restarted, on the old code), a hub
  (several, each stopped), a scheduled task (outlives mistakes).
- 2026-10-17 — **The new dashboard opens its own page; the old page is told and nothing else (safe updates, part B).** A
  dashboard asked to stop (`ui-stop.json`) sends its pages an `update` event, then ends; the one the update starts on
  the new version opens the browser itself, with its new key, as every dashboard does at its start. No key, and no
  FR-017 part 2A one-time code, is ever handed to the old page, the old server or a file. The Update, Stop waiting, Try
  again and Go back buttons are POSTs with the key in a header, from the page's origin, as JSON, like Approve, and Update
  names exactly the release and commit its card showed.
- 2026-10-17 — **Going back puts the role docs back, and a project's `.nextlevel/format.json` says what an older version
  may read (safe updates, part B).** Go back is the same steps the other way; the role-doc commits the update made are
  undone by committing each file as it was before them (through the hub, as the owner's change). A version that changes
  a file of `.nextlevel/` in a way an older one would misread raises `FORMAT` (`src/lib/format.mjs`); a hub refuses
  to start on a project in a format it can't read. Format 1 is today's.
- 2026-10-17 — **The run registry and the menu's handover (safe updates, part B).** Every nextlevel process that can
  registers in `~/.nextlevel/update/run/` (best effort: Codex's sandbox can't write the home folder, so its commands
  aren't listed, and the update waits for the rounds and windows they belong to instead); pruning never removes a version
  folder a registered process runs from. A menu an older version opened says to open START.cmd again instead of starting
  its own version's hub or dashboard. The launcher tells a window an older nextlevel opened (its `NEXTLEVEL_VERSION` gone
  after an update) to open a new one.
- 2026-10-17 — **Going back leaves what changed since the update's commit (safe updates, part B, the review).** Go back
  puts back only the files of the update's own commit (a commit on the project's history whose subject starts with
  "nextlevel ", and only the template files the update refreshes), and only a file nothing changed since: one the owner
  or the team edited or committed after it stays as it is, and the done card says so. START.cmd stays the newer one while
  a menu window runs it (cmd.exe reads a running batch file as it goes). Going back also checks first that each
  project's `.nextlevel/format.json` is one the older version reads (its `FORMAT` read from its file, never run), and is
  offered only for a project that follows releases: from a pinned or candidate project it would move every other one.
- 2026-10-17 — **A gone updater is paused at its step (safe updates, part B, the review).** An update whose updater no
  longer runs (killed, the PC restarted), a minute after its last word, is shown paused at the step it was in, with Try
  again, and Go back once something has changed; never "Updating" for ever. Try again starts the hubs and dashboards an
  earlier try stopped, as well as those it stops itself.
- 2026-10-17 — **One update at a time (safe updates, part B, the review).** `update/current.json` is claimed under its
  lock: an update starts only when the one it names has finished (done or cancelled), so two clicks at once start one
  updater and the second is told that one is in progress.
- 2026-10-17 — **The update's hold (safe updates, part B).** `~/.nextlevel/update/hold.json` names the update, its
  projects (by key) and its phase; each hub reads it at each look (`holdFor` in `src/updater.mjs`), and it holds only
  while it names the update in progress (`current.json`), so a file left behind holds nothing. Phase "waiting" (from the
  click): no task starts (a dispatch or a retry stays queued, its status saying why) and no autopilot round starts, held
  before the lock test's gate the way it holds rounds (no round, no fuse; a task that ended meanwhile starts one after);
  checks, pushes and git jobs still run, since a running round or the orchestrator's window may be in `nextlevel wait` on
  one. Phase "held" (from the end of the wait: the gap before the stop, the restarted hubs, until the finish): every queued
  job waits but the update's own, the jobs a command queues under the updater's `NEXTLEVEL_UPDATE_ID` for that update
  (`by: "update"`, `update: <id>`: its backup push, role-doc commit and bridge test). A paused update keeps its hold; done
  or cancelled ends it. Autopilot's switch, `rounds.json` and the dispatch pause are never touched; `hub.json` says
  `held`.
- 2026-10-17 — **The guard looks twice before it stops git work for git's own settings.** The Windows run of safe updates
  part B caught the hub reading git's settings while the bridge test, in another process, removed its own remote: the
  hub compared the new settings with a record the bridge test had not written yet, and stopped all git work. A change
  found is now looked at again (the record and the settings read anew, and nextlevel's own change in progress,
  `git-busy.json`, asked again) before it is held; a change that stays is held as before.
- 2026-10-17 — **The orchestrator's window doesn't open on Antigravity; its rounds still run there.** agy 1.4.0's
  interactive window ran its default agent with the owner's rules, skills and MCP servers, though `--agent` named
  nextlevel's (KNOWN_ISSUES). The lock test proves only headless runs, so the window is refused on agy and points to
  autopilot rounds, or to Codex or Claude Code for a window. Untested, `mainAgent: true` and `subagent: false` in the
  agent file might bring it back after an owner check. The orchestrator's prompts name the project's folder, since agy's
  shell runs where the model says. Home's rounds table shows every engine's tokens.
- 2026-10-18 — **GitHub checks on this PC: part A recommends, part B sets up (the self-hosted runner,
  `docs/design/self-hosted-runner.md`).** Part A reads the repository (visibility, owner, fork settings, collaborators,
  workflows, the runs' minutes) with the owner's gh, GETs only, kept 10 minutes in `~/.nextlevel/cache/repos.json`
  (written under its lock by the dashboard and `team runner`); the doctor's checks read GitHub afresh each run and keep
  nothing, so a fork setting turned on since the card read it shows, and a fix sees what GitHub says now. The Team
  page's "GitHub checks" card recommends running the checks on the PC for a personal account's private repository whose
  workflows use GitHub's paid runners; it never offers it for a public, internal or organization's repository (an
  organization's waits for a later pull request: its settings sit above the repository's). `nextlevel team runner on`
  reads the visibility afresh and refuses anything else; for one it is offered for, it changes nothing yet.
- 2026-10-18 — **One command for the runner: `nextlevel team runner status|on [--repo owner/name]`.** The design also
  named `nextlevel runner on --repo` for a repository that isn't a project (nextlevel's own, B's throwaway public one);
  `team runner ... --repo`, run from any project, covers it, so there is one name.
- 2026-10-18 — **Where a workflow's jobs run is read from code, and "can't tell" when unsure (`src/lib/workflows.mjs`).**
  A small reader of the shapes `runs-on` takes (a string, a one-line or multi-line list, a group/labels map, an
  expression reading `vars.`), never a YAML library (zero dependencies) and never an AI. Anything else (an anchor or
  alias, a matrix, another repository's reusable workflow, a job whose `runs-on` it missed, a label of its own without
  `self-hosted`) reads "nextlevel can't tell where (read the diff)", never "GitHub's runner". The guard's card gets
  `where jobs run:` lines before the rest of a workflow's lines, so a long card never cuts them off: every job moved or
  new, and every job not on GitHub's runners. The triggers keep `runs on:`.
- 2026-10-23 — **The dashboard's key: a one-time code in the link, a session key in a header (FR-017 part 2A).** The
  page trades the code with a POST (`/api/session`), not on the page's GET, so a browser or a tool that fetches the link
  ahead of time doesn't use it up, and a code that was used already or is a minute old gets a page that says only how to
  open the dashboard again. The key lives in the tab's session storage (a reload keeps working, another tab needs a
  link of its own), never a cookie: cookies on 127.0.0.1 go to every port there, a worker's dev server included. The
  live feed is read with fetch, since EventSource can't send a header. A reopen (`ui-open.json`) carries no code: the
  running dashboard makes one and opens the browser, or prints it in its own window; the code never comes back to who
  asked, so an agent that writes the request gets nothing back. The link is printed to a window or to the process that
  started the dashboard (a pipe), never into a file (the update's `ui-console.log`); one code serves the browser and the
  printed link, so once the browser used it the printed one is spent too. The server keeps only hashes of codes and
  keys; a key is good until the dashboard stops. A code expires by `src/lib/clock.mjs`, so the tests move a minute on
  without waiting.
- 2026-10-23 — **An install moves to another repository only when the owner names the one it leaves, and keeps its
  field reports where they went.** nextlevel is to be published as a new public repository with no history in common
  with the private one. The installer of the new one refuses a clone that follows another repository, as before, unless
  `NEXTLEVEL_MOVE_FROM` names exactly that repository (and never in an agent's session): a typed name, so an install
  never changes repository by accident or because a command line asked. The old one stays as the remote
  `nextlevel-previous`, which is also how `nextlevel _install` knows (once: state.json `moved`), so a second run after an
  installer that stopped half way still keeps what the install had. The install goes to the new repository's newest
  release by the installer, not by `nextlevel update`: an update offers only releases after the installed commit in
  main's history, which unrelated histories never are, and that rule stays as it is for every other case. Field reports
  keep going to the repository the install left (state.json `reports`), since a project's report naming its folders and
  tools must never become a public issue without the owner saying so; the report says "public" when its issue would be.
  The releases seen there are kept, marked `left`: never said to be gone, and a same-named tag in the new repository is
  refused like a moved tag. Fixes waiting there end as `left`: their merge commits never reach the new releases.
- 2026-10-25 — **The advisor keeps the assistant's key, and takes the orchestrator's other engine by default.** Ask
  grows into an advisor (`docs/design/advisor.md`). The role stays `assistant` in nextlevel.json, `nextlevel team`, the
  lock test, `.nextlevel/chats/` and usage.json: a rename would need an alias, a `format.json` note and a new lock-test
  key for a word the owner never types, so only the words on screen change. Advise's automatic choice is the first
  read-only engine that isn't the orchestrator's and whose CLI is installed, on that engine's own default model (a
  pinned name would go stale), so it can disagree with the orchestrator; `advisorAuto` stays pure and takes "installed"
  as a predicate from its callers, since the hub's loop reads the role every tick. Quick is today's Ask unchanged (its
  light model and briefing), so a simple question costs what it did. The memory lives outside the project and only the
  owner's window or the dashboard changes it (not a wall: KNOWN_ISSUES); a memory change starts no round, since it
  gives the team nothing to do. Drafts are read from the answer's own lines by code and sent only through the Notes
  page's existing routes; there is no draft for an Approve, a push, a deploy or a card's Done. The briefing's estimate
  is worked out in the dashboard's own process, not by a second `nextlevel ask`. The mode goes to the usage ledger as
  its reason (quick, advise, explain), which the token-usage work owns.
