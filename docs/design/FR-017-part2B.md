# FR-017 part 2B: workers can't reach the hub: design

Status: **step 1, for the architect's review.** Design and a spike plan, no code. The spike (section 8) needs the
owner's yes for a throwaway Windows user; its results go into section 8's table before step 2 starts. Step 2 builds
what the review settles, in the pull requests of section 9.

## The problem, in one paragraph

A worker runs as the owner's own Windows user. FR-017 part 1 and 2A put bars in its way: the variables the hub puts in
its environment (`NEXTLEVEL_AGENT`, `NEXTLEVEL_TASK_ID`: `src/lib/session.mjs`), `findProject`'s refusal in a slot, the
push block, a one-time code for the dashboard. Each is something a worker can clear or step around with an ordinary
command. With the variables cleared, a worker on an engine without permission checks (Antigravity, a Codex worker out of
its sandbox) can run the main project's `nextlevel` (`--project <main>`: `dispatch`, `verify`, `push`, `notify`,
`note`, `handoff`), write the project's `.nextlevel/` directly (a job into `queue/`, a message into `outbox/`, a card,
`wakeup.json`, `round-now.json`, a lock test's verdict), or write the guard's records in `~/.nextlevel/guard/` (mark
its own held push approved). The hub then acts on it with the owner's access. Part 2B makes those paths fail, and makes
every failure visible.

## 1. The shape, in short

Two layers. The first is for every install; the second is the wall, opt-in, on Windows.

1. **Traced requests (every install, same Windows user).** The hub acts only on what it can trace to the owner, the
   orchestrator or itself:
   - **The command refuses a worker by its ancestry,** not its variables: every `nextlevel` command that asks the hub
     for something walks its own parent processes in one process snapshot (`src/lib/proctree.mjs`), and refuses when
     one of them is a running worker's process (pid with its start time, from the hub's own record). Clearing the
     variables, the full path to the command and `--project` change nothing. A worker's PATH has no `nextlevel` either.
   - **Every request file is signed.** What the command, the dashboard and the hub write for the hub to act on
     carries an HMAC with a per-project key kept outside the project (`~/.nextlevel/keys/<project>.key`). A file
     without a good one is never acted on: the hub sets it aside, logs it, flags the tasks that were running and says
     so on Home.
   - **The owner's notes file is guarded.** A line added to `docs/OWNER_NOTES.md` becomes an owner's note, and a tick in
     `docs/HANDOFF.md` closes an item (`src/lib/cards.mjs`, `load`). Both files join the guard's protected list, so a
     task's merge or an orchestrator's commit that changes them waits for the owner.

   This stops a worker that tries by mistake, through an ordinary command, or because something it read told it to.
   It doesn't stop one that reads nextlevel's key from the owner's profile and computes a signature: that worker has
   set out to get around nextlevel, which is out of scope here and is what layer 2 closes.
2. **The agents' account (the wall, Windows, opt-in).** Workers run as a standard local user of their own
   (`nl-agents`), started by a small host process that runs as that user. The account can write its slots and its own
   profile, and nothing of the owner's: not the project's `.nextlevel/` or `.env`, not `~/.nextlevel` (the key, the
   guard's records, the tool), not the owner's sign-ins. With it, layer 1's key becomes a wall too. It reuses the
   self-hosted runner's `winuser.mjs` and `walls.mjs` (`docs/design/self-hosted-runner.md` section 2, point 7), with a
   different account, since agents need the project and a CI job must not.

Neither layer needs a runtime dependency: HMAC is `node:crypto`; the account is `net`, `icacls` and `schtasks`, built
into Windows.

## 2. Threat model

**In scope:** a worker that reaches the hub's power
- **by mistake** (a wrong path, a command meant for its slot run against the main checkout);
- **through an ordinary command** (`nextlevel ... --project <main>`, the command by its full path, with the agent
  variables cleared, `Remove-Item Env:NEXTLEVEL_*`, `env -u`; its edit tool writing a JSON file);
- **because a page, file, issue or tool output it read told it to** (prompt injection), using those same ordinary means.

**Out of scope, and said so in KNOWN_ISSUES:**
- a worker that reads another process's memory or environment (`ReadProcessMemory`, `/proc/<pid>/environ`,
  a debugger);
- a worker that starts processes outside its own tree (a scheduled task, a service, WMI's `Win32_Process.Create`, a
  process started by another program it asked);
- a worker that reads nextlevel's key and computes a signature itself, or rewrites the hub's record of the workers
  (layer 1 only; layer 2 makes both impossible);
- the orchestrator and the assistant. They are agents too, but they are the ones who ask the hub for things. Part A of
  the Argon roles bars the orchestrator on agy; the agents' account for the orchestrator and the assistant is a later
  step (section 7).

## 3. Every path from a worker to the hub's power, and how it closes

| Path | Today | Layer 1 | Layer 2 |
|---|---|---|---|
| `nextlevel` from the worker's PATH | refused by the variables (`NEXTLEVEL_TASK_ID`) and in a slot by `findProject` | not on its PATH; refused by ancestry | the account can't read the tool's folder |
| `nextlevel` by its full path, `--project <main>`, variables cleared | runs as the owner's command | refused by ancestry | the account can't read the tool's folder |
| A job written into `queue/` | run | unsigned: set aside, flagged | the account can't write `.nextlevel/` |
| A message into `outbox/` | sent, redacted | unsigned: set aside, flagged | same |
| `wakeup.json`, `round-now.json`, `rounds.json` | starts rounds | unsigned: ignored, flagged | same |
| A note or a handoff card in `notes.json`/`handoff.json` | an owner's action | the store's signature fails: the hub keeps its last good copy, flags | same |
| A line in `docs/OWNER_NOTES.md`, a tick in `docs/HANDOFF.md`, by a task's merge | an owner's note | the guard holds the merge | same, and the guard |
| A line there written straight into the main checkout | an owner's note | the guard's watch while a worker runs sets it back and holds it (as for other protected files) | the account can't write the main checkout |
| A lock test's verdict, a trial's answer (`lock-tests/`, `check-cache.json`) | taken | the hub signs its own verdicts; an unsigned one is no verdict | same |
| `closed.json`, `cycle.json`, `settings.json` | taken | signed by their writers; a bad one is the last good copy, flagged | same |
| The guard's records (`~/.nextlevel/guard/<project>/`: an approval) | taken | signed by the dashboard, which writes approvals | the account can't read or write `~/.nextlevel` |
| The dashboard as the owner (`ui-open.json`, its key in the browser's profile) | possible (part 2A's residuals) | `ui-open.json` signed | the account can't read the owner's profile or `.nextlevel/` |
| `.env`, the owner's gh, engines' sign-ins | readable | unchanged (out of layer 1) | not readable |
| Starting a dashboard or a hub of its own | possible | refused by ancestry | the account can't read the tool or the project's state |

### 3.1 The command: refused by ancestry

- **The record.** As a worker starts, the hub writes `~/.nextlevel/guard/<project>/workers.json`: each running
  attempt's task id, its `_run` process and its engine's (pid and start time, as `run.json` has since FR-013), signed by
  the hub. Removed as the attempt ends (`workerEnded`). It lives outside the project, beside the guard's records, so
  no worker reaches it in layer 2.
- **The check** (`src/lib/ancestry.mjs`, new, pure apart from the snapshot): one snapshot of all processes
  (`listProcesses`), the command's own chain of parents by parent id, each parent valid only if it started before its
  child (the rule `proctree.mjs` already uses). A link to a recorded worker process refuses: "this command runs under
  task <id>'s worker: workers don't ask the hub for anything; put it in your report". The refusal is logged in the
  guard's `refused.jsonl` and flags the task (section 5).
- **Which commands:** every command that writes something the hub acts on: `dispatch`, `retry`, `verify`, `commit`,
  `merge`, `cleanup`, `close`, `push`, `notify`, `wakeup`, `note` and `handoff` writes, `team set`, `ui`, `run`,
  `orchestrator`, `lock-test`, `bridge-test`, `update`, `channel`, `report`, `security scan`, `tester run`, `ask`. The
  read-only ones (`status`, `result`, `wait`, `usage`, `note list`, `handoff list`/`show`, `doctor` without `--fix`)
  keep running in a worker, as today.
- **Its cost:** the snapshot on Windows is one PowerShell start, about a second (KNOWN_ISSUES: "over 20 s on a busy
  GitHub runner"). It runs only when the record names a running worker; with none, there is nothing to descend from.
- **When the snapshot fails** (no answer in `LIST_WAIT_MS`, or the orchestrator's sandbox doesn't let it list): the
  command refuses when the record names a running worker and the variables say it is a worker, and otherwise runs and
  logs "ancestry not checked". This keeps the orchestrator working inside Codex's sandbox if the listing is denied
  there; the spike measures whether it is (section 8, S2).
- **PATH:** `workerEnv` drops `~/.nextlevel/bin` and the version's own bin folder from a worker's PATH (safe updates
  put the version's command first on PATH for what it starts).

### 3.2 The files: signed

- **The key.** 32 random bytes per project, `~/.nextlevel/keys/<project key>.key`, written by `init`, the hub's first
  start or the update that brings this (the owner's processes), never inside the project, never in an environment
  variable a worker gets, never logged.
- **The signature.** A field `sig: { v: 1, by, at, mac }` in the JSON, where `mac` is HMAC-SHA256 over `v`, `by`, `at`,
  the file's path relative to the state folder, and the object without `sig` in a stable form (keys sorted). The path is
  part of it, so a signed message moved into `queue/` is no job. `by` is `owner`, `orchestrator`, `dashboard` or `hub`,
  as the writer's session says (for logs and Home; the key, not `by`, is the proof).
- **Replays.** A queue job's and an outbox message's id is in the signed object; the hub keeps the ids it acted on for
  30 days (`.nextlevel/acted.json`, signed by the hub) and acts on an id once.
- **Who signs:** `lib/sign.mjs` (new) is used by every writer the hub acts on: the hub's `writeJson` for its own state,
  `cards.mjs`'s store writes, the command's queue and outbox writes, `wakeup`, the dashboard's writes (approvals,
  `round-now.json`, `ui-open.json`, settings).
- **Older files.** The update that brings this signs the files its project has, once, as the owner's (the updater runs
  as the owner and holds new work while it runs: `holdFor`), and `format.json` says a version older than this can't read
  the project's state. Going back removes the `sig` fields.
- **The file protocol stays:** same folders, same names, one more field. A hub that doesn't know `sig` ignores it.

### 3.3 The owner's own commands and the orchestrator's

- **The owner's window** (START.cmd, PowerShell): the command reads the key and signs. Nothing changes for the owner.
- **The orchestrator on Codex**, inside its sandbox: the command reads the key from `~/.nextlevel/keys` (Codex's
  Windows sandbox reads outside the project; it already runs the tool from `~/.nextlevel`) and writes into the project,
  which it may. The spike checks both (S2).
- **The orchestrator on Claude Code or agy**, as the owner: as the owner's window.
- **The dashboard and the hub** sign in process.

## 4. The agents' account (layer 2)

### 4.1 Weighed

1. **A standard local user for agents, started through a host process of its own (chosen).** The owner's profile
   grants only the owner, SYSTEM and Administrators, so the account can't read `~/.nextlevel`, the owner's gh, Codex's
   and Claude Code's sign-ins, agy's `~/.gemini`, or a project under the profile. A project outside the profile
   (`C:\dev\x`) is readable by every local user: the setup tightens its ACL, as the runner's does. Windows only.
2. **A container per task (Docker Desktop).** Rejected for the wall: Docker Desktop's VM shares `C:\Users` with the
   owner's rights, and `docker-users` membership is owner-equivalent (the runner's design, section 2, option 2). A
   worker that needs Docker inside a container is the same problem. Kept as a later option only for a Docker Engine
   inside the account's own WSL distro.
3. **The owner's WSL.** Rejected: it acts as the owner on `/mnt/c` and through interop.
4. **A WSL2 distro of the agents' account.** Weighed for later: it would give Docker Engine to workers behind the wall,
   but Antigravity has no Linux build that nextlevel has tested, and every engine needs its own sign-in in the distro.
   The spike tries it only if option 1 fails.

### 4.2 The account

`nl-agents`, one per PC (all of the owner's projects' workers are the owner's agents; one account means one sign-in per
engine, not one per project). Standard user, a random 32-character password nextlevel generates, hands to the scheduled
task once (Windows keeps it in LSA) and never writes; "Deny log on locally" and "Deny log on through Remote Desktop";
"Log on as a batch job"; not in Administrators, `docker-users`, Remote Desktop Users or Hyper-V Administrators. Created
in one elevated step shown on its card and run with `Start-Process -Verb RunAs` (the UAC prompt is the owner's
confirmation, as the runner's).

### 4.3 How a worker starts and stops

- **The agents' host** (`src/agenthost.mjs`, new): a Node process running as `nl-agents`, started by a scheduled task at
  the owner's logon and on demand (`schtasks /run`), from a copy of the tool the account can read
  (`C:\ProgramData\nextlevel-agents\tool\<version>`, written by the owner's updater; Administrators and the owner write,
  the account reads). It reads run requests from `C:\ProgramData\nextlevel-agents\<project>\inbox\` (the owner writes,
  the account reads; each request signed with a key of the host's own, which the hub has and the account can read but
  not write: the host checks requests come from the hub, nothing more), starts the worker's engine exactly as
  `workerRun` says (same arguments, environment, launcher, files), and writes its pid, start time, log and end into
  `...\<project>\runs\<job>\` (the account writes, the owner reads).
- **Stopping:** a standard user can't end another user's process. The hub writes a stop request; the host stops the
  tree (`stopProcesses`, unchanged). If the host is gone, Home says so with Check again (as a held slot does today).
- **The console:** agy needs a real console (FR-010). A batch-logon process has no desktop; `CREATE_NO_WINDOW` still
  gives a console. The spike measures that agy runs there (S5).
- **Reports and results:** `RESULT.md` and the commits are in the slot; the hub reads them there as it does today.

### 4.4 Slots: clones, not worktrees

A worktree's commits land in the main repository's `.git` (objects and refs): the account would need write access to
the owner's `.git`, and could move `main`. So in layer 2 a slot is a clone: `git clone --shared --no-checkout` from the
main checkout (its objects read through `alternates`, which needs read access to `.git/objects` only), owned by the
account, in `C:\ProgramData\nextlevel-agents\<project>\slots\<n>`. The hub fetches `task/<id>` from the slot into the
main repository before verify and merge (`git fetch <slot> task/<id>:task/<id>`, as the owner, with
`-c safe.directory=<slot>` since the folder is the account's). The base branch is pushed into the slot as the hub does
its merge of the base today (FR-008). The slot's push block stays: the account has no sign-in to push with in any case.

What reads the slot as a worktree today (`gitguard`'s slot hooks, `slotwatch`, `findProject`'s slot test,
`cleanSlot`) learns the clone; layer 1 keeps worktrees.

### 4.5 The engines under the account

- **Installs.** agy, Codex and Claude Code installed per user live in the owner's profile (`%LOCALAPPDATA%`,
  `%APPDATA%\npm`), which the account can't read. Either a machine-wide install, or the account's own install run by
  the host. The spike measures which works for each (S3).
- **Sign-ins.** The account needs its own sign-in to the owner's plans: `nextlevel login --agents <profile>` asks the
  host to run the engine's own login and shows its device code or link on the dashboard (Codex's `login
  --device-auth`, Claude Code's `setup-token`, agy's own). nextlevel never reads, copies or moves a sign-in. Using the
  owner's own subscription from a second Windows account on the same PC needs checking against each provider's terms
  before step 2 (CLAUDE.md, "Profiles"): this is the owner's plan used by the owner's agents, not a second person.
- **Add-ons:** the account has none of the owner's MCP servers, skills or hooks, so FR-013's `workerAddons` holds by
  construction.

### 4.6 What breaks, and what's done about it

- **git's `safe.directory`:** the owner's git refuses a slot the account owns; the hub's git commands on a slot pass
  `-c safe.directory=<slot>` (only for its own slots, never `*`).
- **Docker:** the account isn't in `docker-users` (owner-equivalent). A task with `Needs: docker` is refused at
  dispatch on a walled worker (`workerLacks`, as part B of Codex workers does), with that said; the owner can run such a
  task on a worker outside the wall by profile.
- **Caches:** npm, pnpm, pip and Playwright caches are per user; the account's first installs are slow. Measured (S6).
- **Ports:** the account's dev servers bind `127.0.0.1` with the slot's port offset, as today.
- **Antivirus:** a new user starting Node and engines from `C:\ProgramData` may trip Bitdefender. Measured (S7); if
  anything is blocked or quarantined, the spike stops and the owner is told.
- **Disk:** a clone with `--shared` costs the working tree only.

### 4.7 The proof

As the runner's: `walls.mjs` probes each of the owner's places as the account before the host starts a worker
(`.env` of every known project, `~/.nextlevel`, the key, the guard's records, the owner's gh, the engines' sign-in
folders, the tool's folder, the main checkout's `.nextlevel/`). One readable place stops the walled workers, with a Home
card naming it and the fix. In CI, on GitHub's own runners only, a test creates a user and runs the probe as it.

## 5. A request nextlevel can't trace

- **Set aside, never acted on.** The hub moves an unsigned or badly signed request to `.nextlevel/untraced/<time>-<name>`
  (a store whose signature fails: the last good copy is put back from `~/.nextlevel/guard/<project>/stores/`, and the bad
  one moved there too).
- **Logged:** a line in hub.log and in the guard's `untraced.jsonl` (file, size, hash, what it asked for in words from
  code, the tasks running at the time).
- **Flagged:** each task whose worker was running when the file appeared (by the file's time and the attempts' times)
  gets `untraced: [...]` in its status, shown in `nextlevel result`, on the Build page and in what the orchestrator
  reads, so it reviews that task's work with that in mind. A refusal by ancestry flags its own task exactly.
- **Home:** one card, "A request nextlevel didn't write was set aside", with what it asked for and the flagged tasks,
  and Seen; one phone message per hour at most. Nothing on the card acts on the request: the owner who wants it does
  it themselves.

## 6. Tests (step 2)

Stub workers that try each path, each try changing nothing, logged and flagged:
the command from PATH, by its full path, with the variables cleared, with `--project <main>`; a job written into
`queue/`; a message into `outbox/`; `wakeup.json` and `round-now.json`; a card changed in `notes.json`; a line added
to `docs/OWNER_NOTES.md` on its branch, and in the main checkout while it runs; its own held push marked approved in the
guard's records; a signed outbox message copied into `queue/`; an acted-on job replayed. And the ordinary ones still
work: the owner's commands, the dashboard's approvals, the orchestrator's commands in a stand-in for Codex's sandbox
(a process that can write only the project and can't list processes: the ancestry fallback). Each refusal broken once
on purpose (the check removed, the signature not checked) must fail its test. Layer 2: `winuser.mjs`'s tools stubbed
everywhere but GitHub's own runners; the host with a stub engine; the walls probe.

## 7. What stays open (for KNOWN_ISSUES)

- **Layer 1 only:** a worker that reads the key or the workers' record from the owner's profile and writes a signed
  request, or that starts a process outside its tree, passes. Layer 1 makes that deliberate, never ordinary.
- **Always:** reading another process's memory or environment; the orchestrator and the assistant still run as the
  owner (the agents' account for them is a later step: the orchestrator needs to write the main checkout, which the
  account then could); a worker's own work (code, tests) is still what the orchestrator reviews and merges; what a
  walled worker does on the network (its engine's API, the internet, the LAN, the PC's services on `0.0.0.0`).
- **POSIX:** layer 1 only. A second user there needs sudo; not planned.

## 8. The spike (on the owner's PC, with the owner's yes)

In `nextlevel-try` and a throwaway user `nl-spike`, never Uplink; every step run by a Remote Control session, the UAC
prompts the owner's. Removed at the end (`net user nl-spike /delete`, its profile and the `C:\ProgramData` folder),
each removal listed for the owner.

| # | What | How | Result |
|---|---|---|---|
| S1 | A process as `nl-spike` with built-in tools only | `schtasks /create /ru nl-spike /rp <pw> /sc once ...` then `/run`; Node prints `whoami` and a file it wrote | |
| S2 | The orchestrator's commands in Codex's sandbox | from the orchestrator on Codex: read `~/.nextlevel`, write `.nextlevel/`, run the process listing | |
| S3 | Engines installed and running as the account | `agy --version`, `codex --version`, `claude --version` from the owner's install and from a machine-wide one | |
| S4 | Sign-ins as the account | each engine's device-code login, the owner's plans; one prompt answered by each | |
| S5 | agy in a console with no window, batch logon | the stub-free probe of FR-022's trial, run by the host | |
| S6 | A slot clone and the hub's fetch | `clone --shared` from nextlevel-try, a commit as the account, the owner's fetch with `safe.directory`; `npm ci` in the slot | |
| S7 | The walls | as the account: read `~/.nextlevel`, `.env`, `%APPDATA%\GitHub CLI`, `~/.codex`, `~/.claude`, `~/.gemini`, the main checkout's `.nextlevel/` | |
| S8 | Antivirus | Bitdefender's log after S1 to S7 | |

## 9. The pull requests (step 2)

1. **2B-1, traced requests (layer 1):** `lib/ancestry.mjs`, `lib/sign.mjs`, the signed writers, the untraced card, the
   two Markdown files protected, PATH, the tests of section 6. No change for the owner but a key file.
2. **2B-2, the agents' account (layer 2):** after the spike passes, and after or with the runner's part B, whichever
   builds `winuser.mjs` and `walls.mjs` first. The host, slot clones, `login --agents`, the doctor's `agents.wall`,
   Team's "Workers run as their own Windows user" switch.

## 10. Questions for the architect

1. Signing every state file the hub acts on (rather than only the queue, outbox and approvals) is broader than strictly
   needed for workers; it also turns the orchestrator's direct writes into untraced ones. Keep it broad?
2. Ancestry fallback when the listing fails: run and log (as written), or refuse every acting command while a worker
   runs?
3. One agents' account per PC (as written), or one per project?
4. `docs/OWNER_NOTES.md` and `docs/HANDOFF.md` protected: the owner's own typed notes in the main checkout then wait on
   a card only when an agent was working at that moment. Acceptable?
