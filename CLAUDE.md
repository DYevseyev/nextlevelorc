# CLAUDE.md — nextlevel

Instructions for anyone (and any coding agent) working on nextlevel itself. `README.md` is for users,
`CONTRIBUTING.md` is the short version of this file, and `docs/HISTORY.md` tells how each part came to be.

## What this is
A tool that lets one person run an AI build team from their own PC:
- an **orchestrator** (Codex by default) plans a project into small tasks, reviews results and merges;
- **workers** (the Antigravity CLI by default) build each task in their own checkout ("slot") and branch;
- a **hub** connects them through files: it queues and runs workers, verifies their output with the
  task's own tests, pushes, notifies the owner's phone, and on autopilot wakes the orchestrator only
  when there is something to decide.

The goal is that **anyone** can install it, point it at a project, and get from "idea + brief" to a
working build team, with setup that fixes itself instead of needing an expert. Windows 11 comes first.
In this file and in the code, "the owner" is the person who runs nextlevel on their PC: the user.

## Layout
- `bin/nextlevel.mjs` → `src/cli.mjs` — the `nextlevel` command: checks the command's arguments first
  (`src/lib/commands.mjs`: every command, its usage and options, and the one strict parser the commands read their
  arguments from, FR-015), finds the project (`src/lib/project.mjs`), then runs `init` (`src/init.mjs`), `update`,
  `channel` or a hub command; owner commands record their project and say when a release is available (never install).
  Run from the tool's clone (START.cmd's last way in), `bin/nextlevel.mjs` hands over to the launcher
  (`src/lib/handover.mjs`). `src/launch.mjs` — the launcher: the version a project follows, from `versions.json` and
  `channels.json` with code of its own (it lives outside every version; `test/releases.test.mjs` holds its rules and
  `src/lib/versions.mjs`'s together); a missing version folder stops it, with the repair command.
- `install.ps1` — the one-command installer (Windows; pwsh elsewhere): Node, Git, the clone in
  `~/.nextlevel/tool` or `$env:NEXTLEVEL_DIR` (an install elsewhere moves there), then `nextlevel _install`
  (`src/lib/install.mjs`: the command in `~/.nextlevel/bin`, PATH, where the tool is in state.json,
  replacing an old `npm link`; the newest release in its folder and the launcher: `installRelease`, `writeLauncher`).
  `src/lib/update.mjs` — updating to releases (`nextlevel update [--to <release>]`, `nextlevel channel`, the owner's;
  `checkReleases` and `update/available.json`, which `nextlevel _releases` refreshes for the hubs and the dashboard;
  `startNotice`; `updateBlocker` for the fixes). `src/lib/releases.mjs` — which tags are releases and their notes
  (pure, but the git and store callers; `releases.json`: every release tag seen, to refuse a moved one).
  `src/lib/versions.mjs` — version folders, `versions.json`, `channels.json`, the project key, git's housekeeping off.
  `src/lib/home.mjs` — `~/.nextlevel` (or `NEXTLEVEL_HOME`) and `state.json`. `scripts/trial.mjs` — a trial install
  for a manual check (dev tooling).
- `src/hub.mjs` — hub commands + loop (menu, doctor, dispatch/retry/verify/push/notify/wakeup/wait/status/
  result, commit/merge/cleanup (the orchestrator's git writes, run by the hub), run, bridge-test,
  autopilot). Start here; the header comment lists every command.
- `src/lib/rounds.mjs` — when autopilot starts a round (FR-019, pure): real events, triggers, the brake, the fuse,
  wake-ups, the round's end and retry, and Home's sentence. The hub's side is "what may start an autopilot round" in
  `hub.mjs` (jobEnded, workMoved, observe, autopilotTick, startRound, roundOutcome, endRound, adoptRound,
  tripFuse, turnItselfOff); `rounds.json` has one writer, the hub; `wakeup.json` is `nextlevel wakeup`'s and `round-now.json` the
  dashboard's count, both only read by the hub. `src/lib/clock.mjs` — the time rounds and wake-ups go by (a test clock
  under the tests' stubs). `src/lib/filelock.mjs` — a file several processes write (`settings.json`, `usage.json`,
  `round-now.json`, the cards' stores), read, changed and written under its lock: its holder told by pid and start time
  (`processStartSync` in `src/lib/proctree.mjs`), taken over after 12 s and logged, a change whose lock was taken over
  made again.
- `src/checks/` — the setup checks (`index.mjs`: the registry, the runner and the check format;
  `context.mjs`: all a check may touch). `src/doctor.mjs` prints them. `docs/CHECKS.md` explains each.
- `src/report.mjs` — `nextlevel report`: the field report (nextlevel's facts only, redacted, shown before it
  is filed with gh: after the owner's yes in their own window, or by the dashboard's File it, `fileShownReport`, in
  the dashboard's process; never from an agent's session, FR-017). `src/lib/redact.mjs` — the reports' redaction,
  phone messages' too. `src/fix.mjs` — `nextlevel fix`: a Claude Code session on the issue (cloud only once
  `claude.github` passes), and `followFixes`, the loop that tells the owner a fix is merged (it installs nothing,
  FR-017) and runs the check again once it is installed.
- `src/dashboard.mjs` — `nextlevel ui`: the local server (127.0.0.1, a one-time code traded for a session key in a
  header, FR-017 part 2A; server-sent events); the hub
  hands it what it may read and do (`dashboardApi` in `hub.mjs`). The page is `src/ui/` (plain
  HTML/CSS/JS): Home, Project, Setup, Build, Team, Tools, Notes and handoffs (one line per card, one open at a time
  with its bar pinned, its own address `#H<id>`); `src/ui/dom.js` has `h()`, which puts
  every text in as a text node, and a handoff card's conversation. Setup runs `nextlevel doctor --json` and, for
  Fix, `doctor --fix <id> --json`; Team runs `nextlevel team models|set ... --json`. `src/lib/overview.mjs`
  — Home's sentences, alerts, what needs the owner and the Blockers card (pure). `src/lib/roadmap.mjs` — the Project
  page from the orchestrator's files (`docs/PROJECT.md`, plans, DECISIONS.md), the brief, jobs and git dates (pure;
  `projectView` in `hub.mjs` reads them, and the doctor's `project.plans` the same way): which milestone each plan is
  for (FR-016) and what the page warns about (`planProblems`); every pattern in it runs in time linear in a line's
  length (the team writes these files). `src/team.mjs` — `nextlevel team`: show a
  role's engine/model/effort, list models, check a change with the doctor's checks and save it;
  `src/lib/team.mjs` — what each role runs with, "the engine's own choice" read from its files.
- `src/lib/protect.mjs` — the guard's pure part: the protected paths (built in, and `nextlevel.json`'s `protected`),
  how a path is matched (as Windows reads a name), whether a task spec owns one, and what a change does in plain
  words (from code, never an AI). `src/lib/guard.mjs` — its records in `~/.nextlevel/guard/<project>/` (outside the
  project: the orchestrator can't write there): held changes and their content, what the owner approved, and the
  watch window around what the orchestrator does; `recordOwner` for the owner's own writes (team, doctor, init). The
  hub's side is "the guard" in `hub.mjs` (holdStaged, guardMerge, guardDecide); `src/checks/guard.mjs` is `guard.held`.
  `src/lib/gitguard.mjs` — git's own hooks and settings that run a program or redirect a push, for the project and its
  worktrees: read, compared, described (the hub's gitGuard, gitRecordOwn for its own changes, restoreGit).
  `src/lib/secrets.mjs` — `.env` values in commits: which values count, where they are, redacted (holdSecrets,
  secretMerge, holdSlotSecrets in the hub).
- `src/lib/workflows.mjs` — a workflow's jobs and where each runs (`workflowJobs`, `whereJobsRun` for the guard's
  `where jobs run:` lines in `src/lib/protect.mjs`, `paidJobs`): a small reader of `runs-on`'s shapes, linear in a line's
  length. `src/lib/ghrepo.mjs` — a repository's facts with the owner's gh (GETs), their cache, `offer()` (never a public,
  internal or organization's repository) and the Team card's view (`checksView`; `githubChecksView` in `hub.mjs`, Check
  again in `src/dashboard.mjs`). `src/checks/runner.mjs` — `runner.visibility`, `runner.forks`, `runner.collaborators`.
- `src/security.mjs` — the security engineer (`docs/design/security-engineer.md`): `nextlevel security scan|stop|login`
  (the owner's) and `status` (a look), the owner's request in the guard's folder, and `_scan`, the hub's child process
  that runs one scan (the lease, the stop rules, the dry run, the scan, the copy-out, the findings and their record in the
  guard's folder). `src/lib/securityimage.mjs` — the scanner pinned by digest and its vendored seccomp profile
  (`docker/codex-security-seccomp.json`); `src/lib/securityspec.mjs` — every `docker` command a scan runs (pure);
  `src/lib/securityrun.mjs` — running them (the volumes' owner, the probe, the sign-in by its files' names, the models,
  the copy-out); `src/lib/securityscan.mjs` — the scan's checkout (steering files aside, links out, tracked secrets
  files), the PC's one-scan lease and the scans' records; `src/lib/findings.mjs` — the manifest's seal and the findings,
  made safe (pure); `src/checks/security.mjs` — `security.docker`, `.image`, `.login`, `.probe`, `.daybreak`. The hub's
  side is "the security engineer's scans" in `hub.mjs` (securityTick, recoverScans, scanBusy).
- `src/tester.mjs` — the tester (`docs/design/tester.md`, `docs/acceptance.md`): `nextlevel tester
  status|check|run|wait|show|stop|persona|browser` and `_accept`, one run as the hub's child (no job; `NEXTLEVEL_AGENT=tester`,
  every command refuses in it), its record and evidence in `.nextlevel/evidence/<run id>/`, the audit line and the
  orchestrator's hourly cap in the guard's folder. `src/lib/yamlsub.mjs` — the YAML subset; `src/lib/acceptance.mjs` —
  plans, their rules and `judge` (pure); `src/lib/testerconfig.mjs` — `nextlevel.json`'s `tester` and the guard's words
  for it; `src/lib/testernet.mjs` — the HTTP client (the origin rules, one checked address per request, cookies);
  `src/lib/evidence.mjs` — what a step keeps, made safe; the browser (part 2): `src/lib/browsertools.mjs` — Playwright at
  its pinned version in `~/.nextlevel/tools/`, installed by the owner from the lock file it ships, every file's hash
  recorded and compared; `src/lib/testerbrowser.mjs` — the browser's steps (a context per persona, route()'s rules, the
  screenshot made safe); `src/lib/testerproxy.mjs` — the run's own proxy, the browser's only way out; `src/lib/vault.mjs` — the personas' sign-ins sealed under a
  key the OS store holds, and `redactionValues`, which every redaction set and the guard's commit and push scans take
  (`personaHold` in `src/lib/redact.mjs` when it can't be read). `src/checks/tester.mjs` — `tester.config`, `.vault`,
  `.plans`, `.reach`, `.browser`. The hub's side is "the tester's runs" in `hub.mjs` (testerTick, acceptContext, acceptEnv).
- `src/lib/usage.mjs` — the usage ledger (`docs/design/token-usage.md`): one line per ended run in
  `.nextlevel/usage/<YYYY-MM>.jsonl`, appended under the month's lock, read through a shape check; the ranges (last hour,
  today, this week from Monday, this month, all time), the sums by field, the per-day series, what an older version
  counted in `usage.json` (`dayLines`). The hub's side is "the day's numbers" in `hub.mjs` (addUsage, which also keeps
  `usage.json` and its `ledgered`; importOlderUsage at the hub's start; cmdUsage, `nextlevel usage`; usageToday and usageView, Home's Usage card and
  `GET /api/usage`, from each project's lines kept in memory while its month files don't change: ledgerRecords).
- `src/lib/closures.mjs` — closed tasks (FR-021): `.nextlevel/closed.json` read through a shape check, the reason's
  rules, how a closure reads. The hub's side is "closing a task" in `hub.mjs` (cmdClose, closeProblem, GIT_OPS.close,
  recordClosure, reopenClosed); the roadmap counts it (`buildRoadmap`'s `closed`).
- `src/lib/cards.mjs` — the owner's notes and the handoff items as cards (`.nextlevel/notes.json`, `handoff.json`,
  a lock for several writers), a handoff card's thread of replies and answers (FR-014), its closings and reopenings
  (`events`, `conversation`, beside the thread), a Done from the dashboard that can be undone for 10 seconds (`pending`,
  made final by any writer or reader past its time: `settle`, the hub's tick and the dashboard's), who closed a card
  (`closedBy`, FR-018: the owner's Done, the team's `close`, nextlevel's own), the import of the old Markdown,
  hand edits read back, and the Markdown written from them (`paths.notes`, `paths.handoff`; replies and answers in
  quoted blocks). `src/notes.mjs` — `nextlevel note` and `nextlevel handoff` (`show`, `answer`, the team's `close`, the
  owner's `reopen`; what `handoff list` gives the orchestrator within the output budget, a reopened card said). `src/lib/textin.mjs` — free text from `--file` (a file in the project, or
  stdin), never from the command line.
- `src/lib/reports.mjs` — what the orchestrator gets of a report, a log or the owner's words (FR-012): the output
  budget, the parts that fit it, cuts that say so, and a task's kind and result file (pure). The hub's side:
  `cmdResult` and `resultPart`, `keepReport` (each attempt's report, whole), `checkResultFile` in a task's verify.
- `src/ask.mjs` — `nextlevel ask`: the advisor (the assistant role, `docs/design/advisor.md`): its briefing for Advise,
  Quick or Explain of a card, one read-only session per question (the engine's `readOnly` arguments, the question on
  stdin), its answer, sources and drafts, and `ask memory`. `src/lib/advisor.mjs` — the drafts read from an answer (a
  note, a rule, a reply to a card, a memory change; none can approve or deploy) and the owner's memory store
  (`~/.nextlevel/advisor/<project key>/`, its shape check). `src/lib/chats.mjs` — its
  threads (`.nextlevel/chats/`). `src/lib/readonly.mjs` — what nextlevel runs under `NEXTLEVEL_READ_ONLY=1` (the
  assistant's engine gets it): only commands that look. `src/lib/github.mjs` — GitHub reads for verify commands
  (FR-017): the read-only token's name, the git credential helper that gives it to github.com only, its expiry from
  GitHub's header, and a gh or git failure for want of a sign-in. `src/lib/session.mjs` — whose session a command runs in, from
  what the hub puts in its environment (FR-017): the owner-only commands refuse in an agent's (no wall: KNOWN_ISSUES).
- `src/engines/` — one adapter per engine (`codex.mjs`, `agy.mjs`, `claude.mjs`; `index.mjs` describes the
  interface: arguments per role, `needsRealConsole`, sign-in, how a second account is kept apart, efforts,
  its own model and effort, its model list, what it means per role, whether it writes git, the tokens it
  reports, the technical feed it prints (`feed`), what a worker on it can't do on this OS (`workerCaveat`), the
  owner's own add-ons in its config and what keeps them out of a worker (`addons`, `workerAddons`, FR-013), and when a
  role on it runs with no permission check (`fullAccess`, FR-017: the doctor's `profiles.full-access`, the Team page);
  `util.mjs`: helpers adapters share);
  `rules.mjs` — what workers and the orchestrator may not run, and what the assistant may. `src/lib/config.mjs` resolves roles to
  profiles (`roleProfile`, `profilesInUse`).
- `src/lib/needs.mjs` — a task's `Needs:` line (docker, network, packages) and which worker can give it (each adapter's
  `workerLacks`); the hub's side is "what a task needs" in `hub.mjs` (needsHold), and the refusal in `cmdDispatch`.
- `src/lib/workerspec.mjs` — what a worker's engine runs with (FR-022): `workerRun` builds its arguments, environment (a
  worker's: no `.env`, the push block, `noPushEnv`), launcher and the files written where it runs, for a worker's attempt
  (`cmdRunTask`) and the model check's trial (`agyTrialSpec` in `src/checks/engines.mjs`) alike; `runKey`, the key of a
  kept trial answer. The hub's hold on agy tasks is "tasks on Antigravity wait for a passing trial" in `hub.mjs` (agyGate,
  startTrial, holdFor, `_trial`).
- `src/lib/rolespec.mjs` — what the orchestrator on Antigravity runs with (the Argon roles): `roleRun` (its arguments with
  `--agent nextlevel-orchestrator`, the agent file, its environment with the push block) and `roleKey`, the key of its lock
  test's verdict. `src/lib/pushblock.mjs` — the push block's one builder (verify commands, rounds and the window on agy).
  `src/locktest.mjs` — the lock test (its throwaway project, the tries, the verdict); the hub's side is "the orchestrator on
  Antigravity" in `hub.mjs` (lockGate, lockProblem, startLockTest, orchestratorSession, `_locktest`, `_locktry`).
  `src/lib/askcopy.mjs` — the assistant on agy: its copy of the project per question, its run there, the tripwire.
  `src/lib/blockwatch.mjs` — a round's commands that clear the block, by pattern. `src/lib/slotwatch.mjs` — what a
  worker's log says it did outside its slot (the hub's side: workerOutside, foreignMoves). `src/checks/argon.mjs` — `lock.test`,
  `agy.permissions`, and what the full-access notes are told (`accessFacts`).
- `src/lib/proc.mjs` — finding and starting the CLIs (`.cmd` shims on Windows; `spawnDirect` starts a shim's program
  without cmd.exe, FR-013), slow answers kept a few minutes, and the tests' trip-wire. `src/lib/proctree.mjs` — what a
  stopped worker left running: one snapshot of all processes (zombies left out), the worker's tree in it by parent ids
  and start times, and `stopProcesses`, which kills a process only by its pid with its start time (the hub's side:
  workerEnded, heldSlots, cleanSlot). `src/lib/console.mjs` — a real console with no window (FR-010, FR-013: `CREATE_NO_WINDOW`
  and `CONIN$`); `src/lib/toolfiles.mjs` — the files the tools need, launchers followed to what they run (FR-013);
  `src/lib/slotfiles.mjs` — the hub's files in a worker's slot, never written through a link;
  `src/lib/workerlog.mjs` — a worker's log as plain, redacted text. `src/lib/sandbox.mjs` —
  whether we run inside Codex's sandbox. `src/lib/ports.mjs` — slot port offsets unique on the PC.
  `src/lib/phone.mjs` — notification text a phone won't turn into wrong links. `src/lib/slotgit.mjs` — the
  hub's git around a worker (FR-008): feedback that asks for the base branch, conflict markers.
  `src/lib/gitlock.mjs` — git's index lock: reads without optional locks, writes run again while it is held.
  `src/lib/push.mjs` — pushing (FR-015): what a push may name as its target (a plain branch name), the deploy branches,
  and `pushArgs`, the one `git push` nextlevel runs, called only by the hub's `pushBranch` ("pushing" in `hub.mjs`: the
  push job, the deploy branch's card as a guard record of kind `push`, the owner's decision, the push log).
- `src/lib/config.mjs` — `nextlevel.json`: defaults, validation, environment overrides.
- `src/notify.mjs`, `src/daily-report.mjs`, `src/lib/state.mjs` — ntfy notifications (`notify()`, the one way to ntfy:
  every message redacted like a report, for the project it must be told, FR-017) and `.env` loading (`src/lib/envfile.mjs`
  reads a `.env`), daily report, run state read from the project's status/handoff docs and git.
- `templates/project/` — what a project gets: `AGENTS.md` (roles), `docs/agents/{GUIDE,ORCHESTRATOR,
  WORKER}.md`, task template, status/handoff/decision docs, `START.cmd`, `.env.example`.
- `test/` — `node --test` end-to-end tests; `test/stubs/` fake `agy`, `codex`, `gh` (also issues and repositories), `docker`,
  `claude` (also sessions and sign-ins), `powercfg` and `npm`, and `team.mjs`, the worker and orchestrator
  roles every stub engine plays; `test/engines.test.mjs` tests the adapters and profiles; `test/checks.test.mjs` tests every check on a fake PC (`test/fake-context.mjs`);
  `test/update.test.mjs` and `test/install.test.mjs` install a clone from a fake GitHub (`fakeGithubTool`: `commit()` a
  merge on main, `release(name, { notes, at })` an annotated release tag, `tag()`/`untag()` the tags the checks refuse),
  `test/releases.test.mjs` the notes, the tag checks and the launcher, `test/announce.test.mjs` Home's card and the
  phone's one message per safety release, `test/oneclick.test.mjs` the one click with a stub hub and worker (waiting,
  stop and restart as it ran, role docs, paused, Update without the backup, Go back, the updater outliving its
  dashboard);
  `test/dashboard.test.mjs` drives the dashboard over HTTP and server-sent events (FR-017 part 2A: a code works once and
  for a minute, every request needs the session key, other Hosts refused, no key or code in a file or the output, a
  dashboard whose output goes into a file prints no link; `test/guard.test.mjs` and `test/push.test.mjs` try approvals
  without the key; `startUi` trades the code as the page does, `launchUi` doesn't); `test/team.test.mjs` covers
  M9 (efforts, the Team page's command, a team change reaching the next task, Home's logic); `test/cards.test.mjs`
  covers the notes and handoff cards (import, Markdown, hand edits, several writers, the commands); `test/project.test.mjs`
  covers M11's parsing (the project page, plan headers, decisions, the roadmap and pace, Home's Blockers) and FR-016
  (plans shaped like a real project's, `test/fixtures/fr016`: found by their Milestone line or name, the warnings, the doctor's
  `project.plans` on a real folder and git); `test/ask.test.mjs`
  covers Ask and the advisor (threads, the briefing and its redaction, read-only engines and commands, the automatic
  choices, usage; Advise's sections, drafts, Explain, the memory and who may change it); `test/gitlock.test.mjs`
  reproduces the index.lock race between the dashboard's reads and the hub's commits (a stub holds the lock);
  `test/guard.test.mjs` covers the guard (matching, summaries, the watch, a worker's hook held, approved and rejected on
  the dashboard, an orchestrator's START.cmd edit set back); `test/guard-git-secrets.test.mjs` its second part (a changed
  git hook stops git work, a slot's push lock changed, commits and merges with a `.env` value held); `test/reports.test.mjs`
  covers FR-012 (a 2,000-line report kept whole and read in parts within the budget, result files checked by the hub,
  the owner's long notes and replies); `test/handoff.test.mjs` covers FR-014 (a 3,000-character reply on the dashboard,
  in HANDOFF.md and in the stub orchestrator's input; an answer through the real `nextlevel.cmd`; What needs you and the
  phone; a card rendered in a DOM that parses HTML, its earlier messages folded); `test/undo.test.mjs` covers undo Done,
  reopening and FR-018 (with the test clock: undone in time leaves nothing, past its time final for every reader, a write
  on a pending card makes it final first, several writers, `handoff reopen` and `close`, the dashboard alone), and
  `test/autopilot.test.mjs` its round (none for an undone Done, one after a hub restart, one for a reopen);
  `test/push.test.mjs` covers FR-015 (every command with `--help`,
  `-h` and an unknown option, through `nextlevel.cmd` too, changes nothing and starts no stub CLI, `STUB_CALLS`; push's
  targets, the deploy branch's card approved, rejected and moved, with a bare origin whose hook records which push job
  pushed; nothing in `src/` runs `git push` but `pushBranch`; FR-017: `-hm`, and a committed `deployBranches: []`);
  `test/pushguard.test.mjs` covers the push guard (a task branch that adds a workflow held on a card, Approve and Reject,
  a moved branch, no card for a branch made from main, one decision across a push's card and a merge's, a deploy push
  that carries one, an orphan branch, a moved local main); `test/sessions.test.mjs` covers FR-017 (whose session a
  command is; a verify command waits while git work is stopped,
  pushes and gh writes from it reach nothing, and the guard's log has it); `update.test.mjs`, `report.test.mjs`,
  `fix.test.mjs` and `notify.test.mjs` the rest of FR-017 (the owner-only commands in an agent's session, the follow-up
  that installs nothing, a planted `.env` value that reaches the stand-in ntfy as `***`); `test/rounds.test.mjs` covers
  FR-019's rules (4 October replayed from a hand-written timeline, the brake, the fuse, wake-ups, retries, Home's
  sentence) and `test/autopilot.test.mjs` the hub with a stub orchestrator (`STUB_ORCH_PLAY`) and a test clock
  (`NEXTLEVEL_TEST_CLOCK`: hours pass, and the 1 November clock change, without waiting); `test/ci.test.mjs` covers CI itself; `test/secondworker.test.mjs` covers part B (the second worker, a worker task's model never the orchestrator's,
  `Needs:` refused, held and never fallen back onto, the Team row); `test/workerargs.test.mjs` covers Codex workers' part A (workers' own arguments on every worker task and never a round or
  the orchestrator's window, a Codex worker out of its sandbox committing itself, the gh folder and the policy, the bridge test
  per engine with a gh that finds the owner's login, `STUB_GH_IGNORE_CONFIG_DIR`); `test/locktest.test.mjs` covers the Argon roles' part A (the lock test passing, incomplete and failing with the stub agy's
  tries, `STUB_AGY_LOCK_SKIP`, `STUB_AGY_LOCK_CLEAR`, `STUB_AGY_LOCK_MCP`; rounds held for it with the test clock, an agy update,
  a failing verdict's card and phone message; the orchestrator's own commit of AGENTS.md approved and rejected; the push
  block's builder; `team set` and the window refused), `test/slotwatch.test.mjs` a worker outside its slot (N7's real log,
  `test/fixtures/agy-1.4.0-outside-slot.txt`; the stub worker's `outside` task on agy and Codex, a card, Seen and one phone
  message; the guard's watch while it runs; the prompt; a held push's Why), `test/askagy.test.mjs` part B (the assistant's lock test, a question
  answered in a copy with the stub agy, `STUB_AGY_ASK_WRITE`, the tripwire with `STUB_AGY_ASK_WRITE_REAL`,
  `NEXTLEVEL_READ_ROOT` only under read-only), and `test/pushguard.test.mjs` the `.env` scan on pushes; `test/agytrial.test.mjs` covers FR-022 (the trial and a worker
  compared through what the stub agy saw, `STUB_AGY_SEEN`; a version change; a failing trial's hold with the stand-in ntfy,
  the dashboard's Check again and the test clock's hourly try; a failed attempt in agy's words), with the stub agy playing
  a version (`STUB_AGY_VERSION`) and real 1.3.5 output in `test/fixtures/agy-1.3.5-*.txt`; `test/attempts.test.mjs`
  covers FR-020 (each way a report goes missing, said in the summary, `result` and hub.log; Claude Code's error ends; an
  attempt's own commits; finished without a report; the worker prompt on every engine; the attempts tally), with the
  stubs' `STUB_WORKER_NO_REPORT`, `STUB_WORKER_IDLE` and `STUB_CLAUDE_END` (real 2.1.284 ends in
  `test/fixtures/claude-2.1.284-*.jsonl`); `test/runner.test.mjs` covers the self-hosted runner's part A (every `runs-on` form,
  the guard's lines, the stub gh's repositories in `~/.fake-github/repos/`: public, internal, an organization's and gh
  that can't answer offer nothing, a private one on paid runners is recommended, `team runner on` refused, the
  dashboard's card, a task branch moving a job onto the PC held on a card), its checks in `test/checks.test.mjs`;
  `test/usage.test.mjs` covers the usage ledger (each engine's token parts, a cut line, planted lines, the ranges across a
  clock change, the import once and after a Go back, a worker's line end to end, `nextlevel usage` and `--all-projects`
  refused in agents' sessions, the dashboard's Usage card's data: Today from the ledger, `/api/usage` by range, field and
  project, a task's tokens on the Build page; the rounds' lines in `test/autopilot.test.mjs`);
  `test/security.test.mjs` covers the security engineer with the stub Docker (`test/stubs/fake-docker.mjs`, its
  `STUB_DOCKER_*` and `STUB_SCAN` knobs, what each run saw in `~/.fake-docker/seen.jsonl`): the pinned image, every
  `docker` line, the findings' shapes, a scan end to end with no job or round, output that doesn't hold, each stop rule,
  a scanner error, a stop, a planted `.env` value, the seccomp fallback, and who may scan;
  `test/tester.test.mjs` covers the tester's part 1 with a stand-in web app in a process of its own
  (`test/stubs/webapp.mjs`: three test accounts, a CSRF sign-in, a delayed audit log, a page that prints a password, a
  redirect off the origin): the YAML subset against fixtures a full YAML reader made (`test/fixtures/tester-yaml`), the
  plan and settings rules, the HTTP client's reach (`NEXTLEVEL_TEST_RESOLVE`), evidence, the vault with the stand-in
  store (`NEXTLEVEL_TEST_VAULT`), whole runs through the hub, who may run one, and a commit holding a persona password;
  and part 2 with a stand-in Playwright (`test/stubs/playwright`: a small DOM, every request through the run's proxy,
  route() seeing a navigation's first request only, screenshots as the texts they would show, what it saw in
  `~/.fake-playwright/log.jsonl`) installed by the stand-in npm: the proxy's refusals, the install and its record, a
  browser run end to end, a read-only environment, a missing or broken browser;
  `test/close.test.mjs` covers FR-021 (`nextlevel close` with a hub: refusals, `--discard`, the page, the doctor, status, one real event each, a
  reopen, bridge tasks) and `test/project.test.mjs` its counts (a fixture shaped like a real project); `test/ui-helpers.mjs`
  starts and drives the dashboard. A stopped worker's processes and its held slot are in `test/hub.test.mjs` (FR-013),
  the snapshot's tree walk, the stop step, zombies and the shim's program in `test/lib.test.mjs`. Tests wait for events,
  never a fixed time (`waitUntil`, `hubRounds` for "nothing happens", `processesGone` before a cleanup:
  `test/helpers.mjs`), and a test that fails prints the hub's log and the engines' output of the projects it made
  (`test/helpers.mjs`), so a CI failure explains itself. Test content stays harmless (a hook that runs
  `echo guard-test`): antivirus removes files that look like attacks.
- `.github/workflows/ci.yml` (the `ubuntu` check) and `windows.yml` (the `windows` check); `.github/ci/changes.mjs` —
  what they test, from the changed files ("CI and merging", below).
- `docs/KNOWN_ISSUES.md` — how the real CLIs misbehave (read before touching process code). `docs/upstream/` — issues
  ready to file with Antigravity and Codex for what only they can fix, with the evidence.
- `docs/FIELD_REPORTS.md` — problems hit on real machines; each must end up covered by a check.
- `docs/GUIDE.md` — the user's guide; `docs/ANTIVIRUS.md` — what to do when an antivirus stops a worker.
- `scripts/public-scan.mjs` — the scan run before anything is published (a deny-list kept outside the repository,
  secrets, e-mail addresses, home folders, binaries); `scripts/public-scan.allow` — what it allows.

## How to work in this repo
- **Tests first and always:** run the tests your change affects (`node --test test/<file>.test.mjs`), then
  `npm test`; it must pass before you commit. A change isn't done until CI's `ubuntu` and `windows` checks are green
  (see "CI and merging"). Never weaken, skip or fake a test to get green.
- **Linux from a Windows PC, before CI:** `docker run --rm --init --user node -v <checkout>:/repo:ro -w /repo node:24
  node --test test/<file>.test.mjs` (`--init`, or orphaned processes are never collected: KNOWN_ISSUES, FR-013).
- **Never call the real `agy`, `codex` or `claude` in tests** — use or extend the stubs. A new check
  gets unit tests with a fake context and an entry in `docs/CHECKS.md` (a test enforces both).
- **A new command** goes in `src/lib/commands.mjs` (its usage, options and arguments) and reads its arguments with
  `commandArgs`, never a parser of its own: then `--help` never runs it (`test/push.test.mjs` walks every command, and
  fails for one that isn't listed). A new push goes through the hub's `pushBranch`, nowhere else.
- **Zero runtime dependencies.** Node.js ≥ 22 built-ins only, no build step, so installing can't break
  on a user's machine. Dev tooling is fine if it isn't needed at runtime.
- **Windows is the primary platform.** Read `docs/KNOWN_ISSUES.md` before touching process spawning,
  quoting, paths or consoles. Keep POSIX working too.
- **Keep the file protocol stable** (`queue/`, `jobs/<id>/{job,status,run}.json`, `RESULT.md`,
  `outbox/`): orchestrator prompts and running hubs depend on it. Changing it needs a migration.
- One step per pull request, small and reviewable. Update `docs/ROADMAP.md` when a step on it lands, and record
  non-obvious choices in `docs/DECISIONS.md`.
- When something needs verification on a real Windows PC (consoles, an antivirus, a real CLI), end your PR
  description with a **Manual check** section: the exact command, which window to type it in
  (PowerShell, Codex, agy, Claude Code, browser), and what they should see. Then an **After install** section: what the
  owner does after the update that the update can't do itself (approve a held change, a new setting, a phone check), or
  "Nothing". The release that has the change carries these lines (see "Releases").

## CI and merging
A pull request needs two checks green on its last commit:
- `ubuntu` (`.github/workflows/ci.yml`) runs on every push to a pull request and on main after a merge. A newer push
  cancels the run it replaces.
- `windows` (`.github/workflows/windows.yml`) runs once per pull request, when it is marked ready for review, as the
  last step before the merge (one Windows run of the tests takes about 20 minutes). No other event starts it: until
  then the commit has no `windows` check at all (never a skipped or neutral one, which would count as passed).
- When the whole pull request is documentation (`docs/` but `docs/CHECKS.md`, and the Markdown files at the top), both
  checks pass in seconds; `windows` also passes at once when the head has exactly the code of a commit where a Windows
  run's tests ran and passed. `.github/ci/changes.mjs` decides it from the changed files, never from a label.

While you work: open the pull request as a draft, run the affected tests and `npm test` before every push, and push a
piece of work when it is done rather than one push per small fix. At the end: bring the branch up to date with main
(`git merge origin/main`, `npm test`, push), then mark it ready for review, which starts the Windows run. To ask again
after a failed run or a new commit: back to a draft, fix and push, ready again.

Main is protected: both checks, on a branch up to date with main, for everyone. A maintainer merges. Pull requests from
forks need a maintainer's approval before their workflows run, and a fork's pull request is never auto-merged: it can
change the workflows that decide whether it is green. A pull request that changes what "green" means (anything under
`.github/`, `.github/ci/changes.mjs` and `test/ci.test.mjs`, the scripts in `package.json`, these rules) or deletes,
skips or weakens a test says so at the top of its description, and a maintainer reads the diff before merging it.
CI never runs on a self-hosted runner here: anyone's pull request would run code on that machine.

## Releases
The installed tool updates only to a release (`docs/design/safe-updates.md`). A merge never reaches users' projects; a
release does, when they update. Maintainers make releases:
- **Which commit:** one on main whose manual checks passed, named by its commit (`git merge-base --is-ancestor
  <commit> origin/main`).
- **The name:** `v0.<minor>.<patch>` while nextlevel is a preview: the minor for a release with anything new, the patch
  for fixes only. Never below `FIRST_RELEASE` (`src/lib/releases.mjs`).
- **The notes,** the tag's message, in this form (the tool reads it; Home and the phone show it):
  ```
  nextlevel v0.3.0

  Fixes:
  - Safety: a verify command can no longer push with the owner's sign-in. (#41)
  - The Project page finds plans named the way real projects name them. (#38)

  New:
  - Home shows what the next autopilot round waits for. (#39)

  After install:
  - Run the bridge test again (START.cmd -> 8).
  ```
  Plain words for the user: what they see, not what the code does. Copy each merged pull request's "After install"
  lines (leave out the "Nothing"s). `Safety:` marks a change that closes a way for an agent, a report or a phone
  message to do what the owner didn't approve, or to leak what it shouldn't (a push or deploy without approval, a
  secret leaving the PC or reaching an agent, a protected file changing past the guard, an owner-only command from an
  agent's session, nextlevel installing without the owner), or a fix for something that destroys the owner's work.
  A safety line sends a phone message to every project.
- **The tag:** `git tag -a <name> <commit> -F <notes file>`, then `git push origin refs/tags/<name>`. Never `--force`,
  never a moved or deleted tag (a ruleset enforces it): a wrong release is replaced by the next one. Never a test tag on
  GitHub (any tag that passes the checks would be a release for every install): tests and trials use a local remote.
- **Then** a documentation pull request adds the notes to `docs/RELEASES.md` (newest first, with the commit).
- **Before every release**, a maintainer runs `scripts/public-scan.mjs` with their private deny-list.

## Principles for the product
- **Setup is a program, not a document.** Every setup step is a check with a fix. When a real user
  hits something new, it becomes a field report, then a check + fix + test, so nobody hits it twice.
- **Tell people exactly where to type things.** Field report FR-001 includes a Claude Code slash
  command typed into PowerShell and a kit unzipped into the wrong folder. Instructions name the
  window and the folder; the dashboard shows copyable commands.
- **Cheap brains type, expensive brains think.** The orchestrator is woken only for decisions; waiting
  happens in the hub for free. Workers are the abundant resource.
- **Safety by construction:** workers never push (git refuses it in their slots; the bridge test proves
  it against a real remote) and get no secrets (slots have no `.env`); the worker CLI's deny-list is
  only an extra layer (FR-003); the orchestrator stays sandboxed; the hub is the only privileged part and
  logs every command it runs. Never add a path where a worker, a report or a phone message can leak `.env` values
  (every phone message goes through `notify()`, which redacts). A command that acts with the owner's access on an
  agent's behalf (`nextlevel verify`) gets no push and no GitHub sign-in, and waits while git work is stopped; an
  owner-only command refuses in an agent's session. Files that steer
  agents and tools change only with the owner's approval on the dashboard (the guard): never add a way to approve one
  from a command, the phone or anything an agent can write, and never let an AI's words stand in for the diff. The
  same for a push to a deploy branch: only the owner's Approve on the dashboard pushes it, exactly the commit its card
  showed. A command asked for its help never acts (FR-015), and nothing pushes without naming its branch.
- **Honest status:** a job's state comes from verification the hub ran itself, not from the model's
  claims.

## Target architecture (what the milestones build)
- `nextlevel` CLI installed once per machine as a clone of this repo that updates to releases (each version in a
  folder of its own); it operates on the
  project in the current directory (git root). Projects get only `nextlevel.json`, the templates and a
  gitignored `.nextlevel/` state folder.
- Setup checks as code (`src/checks/`, M2), extendable per project (`.nextlevel/checks/*.mjs`).
- A local dashboard (`nextlevel ui`, plain HTML + server-sent events from `node:http`). Built in M4.
- A fix loop: failed check → redacted report → a public GitHub issue → a fix (a maintainer's Claude Code session, or
  anyone's pull request) → CI (Linux + Windows) → merge → a release → the user updates and the check runs again.
  Built in M5; releases since safe updates.
  A pull request for a field report says "Fixes #<n>": merging it closes the issue, which is how the
  owner's nextlevel knows the fix is in.
- Engine adapters (`src/engines/`) for Codex, Antigravity and Claude Code, so users can choose their
  orchestrator and workers. Built in M6.

## Profiles (M6)
- The default team stays Codex as orchestrator and Antigravity as workers, but roles are filled by
  **profiles**. A profile is an engine (Claude Code, Codex, Antigravity) plus the account it's signed
  into plus a model. The same engine can appear twice with different logins (for example two Codex
  accounts), and any engine can take any role. In `nextlevel.json` a role is `{ engine, model }` or
  `{ profile }`, with a `fallback`; `engines.<name>` holds only what every profile of that engine shares
  (its CLI arguments). Don't assume one account per engine or a fixed engine per role.
- A second account is a folder of its own for the engine's CLI (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`); an
  engine without such a setting (Antigravity) can't have one, and the doctor says so plainly. nextlevel
  never reads, copies or moves a sign-in: the owner signs in with the CLI's own login.
- A fallback is for a setup that isn't ready, never for a provider's usage limits.
- Each user brings their own accounts. The tool drives only the official CLIs those accounts are
  signed into and stays within each provider's terms: check them before adding a new way to use an
  account, and don't build anything whose purpose is to get around a provider's limits.
