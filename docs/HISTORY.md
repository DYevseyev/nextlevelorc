# How nextlevel got here

nextlevel was developed in a private repository from 25 September 2026 until its first public version. Numbers like
`#38` in this history, in `docs/DECISIONS.md` and in `docs/FIELD_REPORTS.md` are pull requests in that private
repository; FR-001 and on are field reports from real use. Below is the summary of what each milestone and field
report added, in the order they landed.

`src/` started as the hub extracted from the first user's project kit. Since M1 the tool is separate from the
project: `nextlevel <command>` works on the git root of the current folder (or `--project <path>`),
reads the project's `nextlevel.json`, keeps state in `.nextlevel/`, and `nextlevel init` sets a
project up. The kit's old names and state folder kept working for one release (the first public version dropped them). Since M2 setup
is checks as code (`nextlevel doctor`); since M3 one PowerShell command installs the tool as a git
clone that updates itself; since M4 a local dashboard (`nextlevel ui`, START.cmd -> d) shows setup and
the build live and has the controls; since M5 a check that won't pass becomes a field report
(`nextlevel report`) that Claude Code fixes (`nextlevel fix`), and the fix installs itself and the check runs
again; since M6 engines are adapters (`src/engines/`), any of Codex, Antigravity and Claude Code takes any
role, and roles are filled by profiles (engine + account + model); since M9 the dashboard opens on Home
(what runs, what needs the owner with the next action, the day's numbers), its Team page shows and switches
each role's engine, model and effort (checked by the doctor before `nextlevel.json` is saved, applied at the
next round or task), and the installer takes a folder for the tool (`NEXTLEVEL_DIR`) and moves it there; since FR-008
the hub merges the base branch in and commits for workers whose sandbox can't write git (Codex), every job records why it
ran on its engine, and Home counts the day per role and engine with the tokens each engine reports; since M10 Home has
"Show activity" per running task (the worker's progress notes, `.nextlevel-task/PROGRESS.md`, and a technical feed from
Claude Code's stream-json and `codex exec --json`), and the owner's notes and the handoff items are cards kept in
`.nextlevel/` that the orchestrator reads and answers with `nextlevel note` / `nextlevel handoff` (the Markdown files are
written from them); since FR-009 the doctor and the Team page warn about Codex workers on Windows; since M11 the
orchestrator keeps `docs/PROJECT.md`, a plan header per milestone (Outcome, Acceptance, Try it) and labeled Blockers,
which the dashboard's Project page (overview, roadmap timeline, pace with a rough estimate, decisions) and Home's
Blockers headline show; the dashboard's Ask
panel and `nextlevel ask` are a read-only assistant for the owner, a role of its own (`assistant`), apart from the
orchestrator; since FR-010 workers (and autopilot rounds) on Windows run in a real console with no window
(`workers.window` for a window), agy's output comes through pipes into `worker.log` (its stream-json feeds Show
activity and Today's tokens), agy never gets `--effort`, and every background process is hidden; since the guard,
files that steer the agents and the owner's tools (Claude Code's hooks and settings, MCP configs, instruction files,
workflows, `nextlevel.json`, `START.cmd`...: `src/lib/protect.mjs`) change only with the owner's approval: the hub holds
a task's merge, an orchestrator commit or a push that changes one, sets back a change made on disk while the orchestrator
works, and the owner approves or rejects exactly that change on the dashboard; git's own hooks and settings are
recorded too (a change the hub didn't make stops all git work until the owner decides), and the hub never commits a
`.env` file or a value from `.env` (held, the value hidden); since the push guard (a review, 14 October:
GitHub runs a pushed branch's own workflows) every push is read for changes to protected files compared with origin's
base branch (with nothing when there is no common history), and one the owner hasn't approved waits on a card like a
deploy push (one card says both), the owner deciding each change once: on a push's card or a task's merge card,
matched by the files' key and the task (`pushProtected`, `sameChange` in `hub.mjs`); since FR-013 the console with no
window comes from
`CREATE_NO_WINDOW` and the worker hands agy its input (`CONIN$`, `src/lib/console.mjs`) — nextlevel starts no
conhost.exe, which an antivirus judged malicious —, workers start without the owner's own MCP servers, skills and hooks
unless `workers.addons` lists them (each engine's `workerAddons`; agy as an agent written into the slot), a worker
whose processes vanish without a report is "Stopped from outside" (not an attempt), dispatch pauses while files a
worker needs are gone (`src/lib/toolfiles.mjs`, the `tool.files` check), and FR-011's flashes are gone: agy's headless
sessions run without its background updater, and Codex's windows (orchestrator, guide) with `--no-daemon`, since its
shared background server opened a window for every command; since FR-012 every attempt's report is kept whole in the job
folder (`RESULT.attempt-<n>.md`), what the hub prints for the orchestrator fits in what its engine shows of one command's
output (`OUTPUT_BUDGET`, `src/lib/reports.mjs`) and a part it leaves out is said, with the length and the file that has it
(`nextlevel result --from`; the owner's notes and replies too), design, research and map tasks write their result to a
`Result file:` under `docs/` that the hub's verify checks, and `project.decisions` warns when `docs/DECISIONS.md` passes
about 1,000 lines; since the worker-shutdown fix (FR-013), engines start without a `.cmd` shim's cmd.exe, so on Windows
an engine ends with its worker's process (Node's job), the hub stops a worker it started the moment its process ends
without finishing (with nothing asked of PowerShell; its process group elsewhere), what the worker started is found in
one snapshot of all processes by parent ids and start times (`src/lib/proctree.mjs`; a process is killed only by its
pid with its start time, so a pid another program has now is never touched), and its slot takes no task until nothing
of it runs there (a card on Home, with Check again, when that can't be made sure of); since FR-014 a handoff card is one
conversation (the request, the owner's replies, the team's answers, each whole with its line breaks, never cut
without saying so), the orchestrator answers on a card with `nextlevel handoff answer <id> --file <path>` and gives
every free text in a file (`--file`: on Windows `nextlevel.cmd` ends an argument at its first line break), an answer
waits under What needs you until the owner replies or presses Done and the phone gets a message that names the card,
and every text on the page is a text node (`src/ui/dom.js`), never HTML; since FR-015 (`nextlevel push --help` pushed
main and deployed a real project's production) every command's arguments go through one strict parser before anything runs
(`src/lib/commands.mjs`): `-h`/`--help` print the command's usage and do nothing, and an option or argument it doesn't
take prints the usage and fails, doing nothing; `nextlevel push <branch> [--from <local branch>]` names its branch on
origin (a plain name, never forced), a push to a deploy branch (`deployBranches` in `nextlevel.json`; not set: the base
branch) waits for the owner's Approve on the dashboard for exactly the commit its card shows, and every push goes through
the hub's `pushBranch` (`src/lib/push.mjs` builds its one `git push`); since FR-017 (part 1) help is what the parser
reads (`commit -hm "x"` is help), `"deployBranches": []` committed means no deploy branch, `nextlevel verify` waits while
the guard has stopped git work and runs its command without Git pushes or GitHub sign-ins (its environment, as the
slots' push block; exactly `nextlevel doctor` is the hub's own doctor run with them, since it only looks; GitHub reads
come back with an optional read-only token in the project's `.env`, `NEXTLEVEL_GITHUB_READ_TOKEN`, for gh and, for
github.com only, git: `src/lib/github.mjs`, the doctor's `gh.read-token`), each logged with its exact command line in the
guard's `verify.jsonl`, and what `nextlevel result` shows of its log is redacted; the owner-only commands
(`update --to`/`--force`, filing a report) refuse in an agent's session (`src/lib/session.mjs`, from what the hub puts in
its environment: no wall, `docs/KNOWN_ISSUES.md` says what a determined agent still can), no command files a kept report
(only the dashboard's File it, in its own process), the fix follow-up installs nothing (it tells the owner and waits),
every phone message is redacted like a report in `notify()`, the one way to ntfy (a setting's ordinary word under a name
that doesn't look secret stays readable), and the doctor's `profiles.full-access` and the Team page say when a role runs
on an engine without permission checks (Antigravity): a warning for a role in the main checkout, information for workers;
since FR-016 (a real project's Walking skeleton plan, `docs/plans/WS-walking-skeleton.md`, wasn't found) the Project page finds
a milestone's plan by its `Milestone:` line, else by its title or file name naming the milestone's id or name in any
common form, reads the labels a real project's plans have (`Try-it:`, `Try it (...):`, a byte-order mark), and it and the
doctor's `project.plans` warn about a milestone with tasks but no plan found (naming the files that match none), a plan
without its Outcome, Acceptance or Try it, and two plans for one milestone; the orchestrator's role doc names the path
(`docs/plans/<milestone id or name>.md`) and the `Milestone:` line; since FR-019 (a real project's hub ran 95 rounds in twelve
hours while the team only waited for the owner's reply on a card) autopilot starts a round only because something
happened, decided by the hub (`src/lib/rounds.mjs`, its state in `.nextlevel/rounds.json`): the owner acting (the cards
count the owner's actions, and their owner side refuses in an agent's session; Run a round now on Home) or a task attempt
ending always starts one; a check, push or merge job ending, a wake-up the orchestrator asked for (`nextlevel wakeup`,
the orchestrator's only), the round after work moved (a task dispatched, merged, retried or closed, a push with new
commits) and one retry of a cut-off round only while fewer than three rounds have started since the last real event (the
brake); nothing timed, and nothing the team does for itself (a commit, STATUS.md, a post on a card, its checks) is real;
a job a round started and saw finish (`nextlevel wait`, its git commands) starts no round after it; a round the hub holds
no handle for is told by its pid and start time;
six rounds in a row with nothing real turn autopilot off (the fuse, with a phone message and a Home card), and so do two
rounds in a row whose engine never started (`launched` in `cycle.json`; they count toward the 8 an hour); what happens
while the hub is stopped or autopilot is off gets its round afterwards; Home says what the next round waits for and
Today counts rounds by what started them; `hub.rounds` holds the brake, the fuse and the shortest wake-up, and the
rounds' time comes from `src/lib/clock.mjs` (a test clock under the tests' stubs); since FR-022 (agy 1.3.4 refused the
workers' agent file, whose YAML wasn't valid, "unknown agent", while the model check said only "ERROR") the agent file is
quoted YAML and, after 1.3.2 (from `agy --version`), lists the worker's tools (1.3.5 gave an agent without the list only
tools that look), the model check's probe asks agy to write a file and run a command, a run on agy that fails says why in agy's own words with its exit code and last lines (`agyFailure`,
redacted with the owner's MCP servers' strings too), the model check's trial runs what a worker runs
(`src/lib/workerspec.mjs`: the same arguments, launcher, environment and agent file, its answer kept under that run's key:
a refusal an hour), and tasks on agy wait in the queue (`waiting:`) until a trial of what that worker runs passes, which
the hub runs in a child process it follows (`nextlevel _trial`), with a Home card (Check again), one phone message and one
round; `retry <id> --fallback` moves a held task, and nothing falls back by itself (agy's ERROR can be a usage limit);
since FR-020 (a real project's attempt 10 of one task on Claude Code ended its turn to wait for a check it ran in the background, wrote
no report, and ended "done" on 16 earlier attempts' commits with no word of why) an attempt is judged on its own work: the
hub records the branch's tip after its merge of the base as the worker starts (`startTip`), and its own commits and diff
stat (`ownCommits`, `ownDiffStat`) come first in the summary ("1 commit(s) this attempt, 18 in all"), `nextlevel result`
and Home; every engine's own end is read (`end` in each adapter: Claude Code's last result, Codex's last turn, agy's
status) and kept (`engineEnd`), and an error end fails the attempt whatever its exit code; a missing report says why
everywhere an attempt shows (`missing`: the time limit, the engine stopped, its error, it ended without writing it with
its own end, stopped from outside; a file with no Status line says so); an attempt with no commits of its own and no
report is `no-changes`, and one that ended normally with its own commits passing verify (for a design, research or map
task, changing its result file) is `done` marked "finished without a report, verify passed" (`mark`); status.json keeps
every attempt's end (`attempts`), which the attempts alert counts by how they ended; every worker's prompt names
`RESULT.md` and its Status line and says its session ends with its turn, and Claude Code workers run with background
commands off and Bash's limit at half the attempt's (`workerEnv`);
since FR-021 (a real project's Project page counted five
tasks the orchestrator had closed in their specs as planned) a task is closed with `nextlevel close <id> --reason` (the
orchestrator's and the owner's), a git job `close` that checks the task again and keeps the closure in
`.nextlevel/closed.json` (the hub's only, read through a shape check: `src/lib/closures.mjs`); it refuses a task queued,
running or merged and an unmerged branch without `--discard`, marks the job reviewed and is one real event; a dispatch
or retry reopens it, `cleanup --discard` of an unmerged branch closes it, and the Project page, the Build page, status,
the daily report and the doctor show it closed and leave it out of "N of M merged"; a hub merge's subject always names
`task/<id>`, and finished merge jobs count as merged; since Codex workers on Windows (part A), workers have arguments of
their own (`engines.<engine>.workerArgs`, `workerArgsOf` in `src/lib/config.mjs`: every worker task on that engine,
however it was chosen, while the orchestrator, the setup guide and autopilot rounds keep `args`), the Team page's "Codex
workers" switch (`nextlevel team sandbox on|off`, the owner's change) takes Codex workers out of Codex's sandbox
(`danger-full-access`, approvals never: they commit themselves, and Docker and pnpm work) or keeps them in it with its
network on, every Codex worker keeps the hub's variables (`-c shell_environment_policy...`) and on Windows gets
PowerShell's policy for its process, every worker task and `nextlevel verify` command gets a gh folder with no sign-in (`GH_CONFIG_DIR`, `NO_GH_CONFIG`
in `src/lib/workerspec.mjs`; never the hub's own gh), and the bridge test asks gh who it is and keeps a verdict per engine
with the workers' arguments (`.nextlevel/bridge-tests/<engine>.json`, beside `bridge-test.json`): the doctor asks for one
per worker engine in use; since part B, a second worker (`roles.worker.second`, reached as `--profile second` or a
spec's `Profile: second` line; `nextlevel team set worker-second ... --takes no-docker|any|asked` and the Team page) shares
the slots, a worker task on an engine named on its own takes a worker's model there, never the orchestrator's
(`findProfile(..., { worker: true })`, `sourceOf` in `src/lib/config.mjs`), and a task's `Needs:` line (docker, network,
packages: `src/lib/needs.mjs`, each adapter's `workerLacks`) is refused at dispatch on a worker that can't give it and
held at start (`waitingFor: 'needs'`, no attempt spent; `NEXTLEVEL_TEST_PLATFORM` plays Windows under the tests' stubs);
`nextlevel status` lists the workers first.
Since the Argon roles' part A (`docs/design/antigravity-roles.md`: agy 1.4.0's sandbox can't run a command on Windows 11
22H2 and misses its edit tools, plan mode writes, and the owner's agy settings approve everything) the orchestrator's
window and its autopilot rounds on Antigravity run with verify's push block (one builder, `src/lib/pushblock.mjs`, no
read-only token for them) and as nextlevel's agent `nextlevel-orchestrator` (none of the owner's MCP servers or add-ons;
written into the main checkout before each start, kept out of commits by `.git/info/exclude`, the hub's own write for
the guard), and start only with a passing lock test for exactly what they run (`nextlevel lock-test --engine agy --role
orchestrator`, `src/locktest.mjs`: in a throwaway project of its own, each try a real round's process, `_locktry`; its
verdict in `.nextlevel/lock-tests/agy-orchestrator.json`, keyed with `runKey` of the role's run, `src/lib/rolespec.mjs`):
the hub runs it by itself after an agy update (`_locktest`, one at a time, never beside the trial) and holds autopilot's
rounds before they start (`lockGate` before `startRound`: no round, no fuse), a failing or incomplete verdict is a Home
card with Check again and one phone message, never a fallback; the window, `team set` and the Team page refuse without a
pass; every push holds a `.env` value in what it sends (`pushSecrets`, each commit that goes out), a protected file the
orchestrator committed itself and the owner rejected makes the push guard refuse any push that carries it (naming the
commit to revert), the hub reads each round on agy for commands that clear the block (`src/lib/blockwatch.mjs`, by
pattern, after the round: a Home card), and the doctor has `lock.test` and `agy.permissions` (`src/checks/argon.mjs`);
since part B the assistant may be on Antigravity too: each question is answered in a throwaway copy of the project
(`src/lib/askcopy.mjs`: a shared clone without remotes, the working tree without .env files, the question in
`.nextlevel-ask/QUESTION.md`), as `nextlevel-assistant` with the push block built for the real project's remotes and
NEXTLEVEL_READ_ONLY=1, its nextlevel commands reading the real project (`NEXTLEVEL_READ_ROOT`, honoured only under
NEXTLEVEL_READ_ONLY=1), only with a passing lock test of its own (`--role assistant`, one hold per role), the guard's
watch open while it answers (a protected file it changes in the real project is set back and held), and a tripwire
in `cmdAsk` (HEAD, refs, `git status`, the protected files) that says a change in the real project in the answer and on
Home; its automatic choice stays Claude Code and Codex.
Since safe updates part A (`docs/design/safe-updates.md`) the installed tool
updates only to a release (an annotated tag `vX.Y.Z` on main, made once the owner's check of that commit passed, checked
by `src/lib/releases.mjs`: annotated, titled, on main, from `FIRST_RELEASE` up, never moved), each version runs from a
folder of its own (`~/.nextlevel/versions/<name>`, a worktree of the tool's clone: `src/lib/versions.mjs`), the
`nextlevel` command runs the launcher (`src/launch.mjs`, copied to `~/.nextlevel/bin/launch.mjs`), which runs the version
the project's channel names (`release`, `pin <release>`, `candidate <branch>`: `nextlevel channel`, kept in
`~/.nextlevel/channels.json`, the owner's), `nextlevel update` is the owner's alone (refused in an agent's session, plain
or not), nothing installs at a command's start (it only says a release is there), the hubs and the dashboard look for
releases every 6 hours (`update/available.json`), Home shows Update available with the notes (safety fixes marked) and
the phone hears a safety release once per project, a field report's fix waits for the release that has its own merge
commit, a version puts its own command first on PATH and its name in `NEXTLEVEL_VERSION` for what it starts,
`NEXTLEVEL_HOME` gives a trial install a home of its own (`scripts/trial.mjs`), and git's automatic housekeeping is off
in the tool's clone; since part B the update is one click (Home's Update, or `nextlevel update`, which follows it): a
detached updater (`src/updater.mjs`, `nextlevel _update <id>`, its plan and progress in `~/.nextlevel/update/<id>/`)
prepares the new version, then from its folder waits for running work, pushes the backup branch
(`updates.backupBranch`), stops each hub and dashboard (`hub-stop.json`, `ui-stop.json`) after recording how it ran,
switches, starts them again as they ran (autopilot, the brake and the fuse untouched), refreshes and commits the
unedited templates through the hub as the owner's change, runs the bridge test where it must (`SLOT_PUSH_BLOCK`), and
compares the doctor's rows; a failing step pauses it (Home: Try again, Go back; the phone hears it), going back puts the
role docs back, a project's `.nextlevel/format.json` says what an older version can read (`src/lib/format.mjs`), and the
run registry (`src/lib/runreg.mjs`) keeps pruning off folders in use. From the click to its end the update holds new work in the projects it
covers (`update/hold.json`, `holdFor` in `src/updater.mjs`, read by each hub at each look): no task starts and no autopilot
round (held like the lock test's, no fuse), the checks, pushes and git jobs a running round asks for still run while it
waits, and from the end of the wait every queued job waits but the update's own (`by: "update"`); a paused update keeps
it until the owner chooses.
Since a worker outside its slot (17 October: a test project's agy worker wrote a file through a path it typed wrong)
the guard watches the main checkout while any worker runs, and after each attempt the hub reads the worker's log
(`src/lib/slotwatch.mjs`: agy's and Claude Code's stream-json, Codex's `--json`) for files written outside its slot and
for git or folder changes aimed at another folder, and compares the main checkout's HEAD and base branch in git's reflog
(the hub's git jobs say `GIT_REFLOG_ACTION=nextlevel-hub`): a Home card with Seen (`slotEscape` in settings.json), the
job's `outside`, hub.log and one phone message, by pattern, after the fact; the workers' prompt names the slot and
says to write only there; a held push's Why says why it is held (`pushWhy` in `src/lib/overview.mjs`).
Since the self-hosted runner's part A (`docs/design/self-hosted-runner.md`: on 17 October GitHub stopped starting the
owner's Actions jobs, and a private repository pays for every minute on GitHub's runners) the Team page's "GitHub checks"
card says where the project's checks run and recommends running them on this PC for a personal account's private
repository whose workflows use GitHub's paid runners, with the last 30 days' minutes; never for a public, internal or
organization's repository. The repository's facts come from the owner's gh, GETs only, kept 10 minutes in
`~/.nextlevel/cache/repos.json` (`src/lib/ghrepo.mjs`); `nextlevel team runner status|on [--repo owner/name]` (on reads
afresh, refuses anything else and in an agent's session, and sets nothing up yet); the doctor has `runner.visibility`,
`runner.forks` (a fix that turns fork pull requests' workflows off with the owner's gh) and `runner.collaborators`; and
every guard card for a workflow says where its jobs run (`where jobs run:`, `src/lib/workflows.mjs`, from code: what it
can't read it says so, never "GitHub's runner"). The runner itself is part B.
Since FR-017 part 2A the dashboard's link carries a one-time code (good once, for a minute: `CODE_MS`, by
`src/lib/clock.mjs`), never a key: the page trades it (`POST /api/session`) for a session key kept in the tab's session
storage and sent in the `x-nextlevel-token` header (the live feed read with fetch), and takes the code out of the address
bar; every request but the page's own files needs a key, at 127.0.0.1 or localhost with its port; a used or old link
gets only how to open the dashboard again; the server keeps hashes only, nothing on disk, and prints the link to a window
or a pipe, never into a file (but under the tests' stubs with `NEXTLEVEL_TEST_LINK_IN_FILE=1`); a reopen (`ui-open.json`, carrying no code) makes the running dashboard open the browser
with a new code, which never comes back to who asked; `nextlevel ui` and START.cmd -> d refuse in an agent's session.
Since an install can move to another repository (where nextlevel is published), the installer
moves a clone that follows another repository only when `NEXTLEVEL_MOVE_FROM` names exactly that one (never in an agent's
session), keeping it as the remote `nextlevel-previous`, and installs the new one's newest release though the histories
don't meet; `nextlevel _install` then keeps what the install had, once (`keepWhatMoved` in `src/lib/install.mjs`, state.json
`moved`): the releases seen there marked `left` (never "gone"; a same-named tag refused), field reports still going there
(state.json `reports`, `reportsRepo` in `src/report.mjs`; a report says "public" when its issue would be), and fixes
waiting there ended as `left`.
Everything is covered by
end-to-end tests with stub CLIs on Linux and Windows (CI runs both: Ubuntu on every push, Windows once per pull request,
see "CI and merging"); tests never update this checkout (`NEXTLEVEL_NO_UPDATE=1`), and never reach the PC's own CLIs (a
trip-wire in `resolveBin` refuses anything outside the stub folder).
`docs/ROADMAP.md` has what comes next.
