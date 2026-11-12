# FR-017 part 2B: workers can't reach the hub: design

Status: **step 1, reviewed** (the maintainers' design review, 6 November: GO with changes R1 to R10, folded in below; section
11 lists them). Design and a spike plan, no code. The spike (section 8) needs the owner's yes for a throwaway Windows
user; its results go into section 8's table, in a documentation pull request, before 2B-2 starts. Step 2 builds what
the review settled, in the pull requests of section 9.

## The problem, in one paragraph

A worker runs as the owner's own Windows user. FR-017 part 1 and 2A put bars in its way: the variables the hub puts in
its environment (`NEXTLEVEL_AGENT`, `NEXTLEVEL_TASK_ID`: `src/lib/session.mjs`), `findProject`'s refusal in a slot, the
push block, a one-time code for the dashboard. Each is something a worker can clear or step around with an ordinary
command. With the variables cleared, a worker on an engine without permission checks (Antigravity, a Codex worker out of
its sandbox), or on Claude Code (its deny rules don't cover `Remove-Item Env:`), can run the main project's `nextlevel` (`--project <main>`: `dispatch`, `verify`, `push`, `notify`,
`note`, `handoff`), write the project's `.nextlevel/` directly (a job into `queue/`, a message into `outbox/`, a card,
`wakeup.json`, `round-now.json`, a lock test's verdict), or write the guard's records in `~/.nextlevel/guard/` (mark
its own held push approved). The hub then acts on it with the owner's access. Part 2B makes those paths fail, and makes
every failure visible.

## 1. The shape, in short

Two layers. The first is for every install; the second is the wall, opt-in, on Windows.

1. **Traced requests (every install, same Windows user).** The hub acts only on what it can trace to the owner, the
   orchestrator or itself:
   - **The command refuses a worker by its ancestry,** not its variables: every `nextlevel` command but the few that
     only look (3.1) walks its own parent processes in one process snapshot (`src/lib/proctree.mjs`), and refuses when
     one of them is a running worker's process (pid with its start time, from the hub's own record). Clearing the
     variables, the full path to the command and `--project` change nothing. A worker's PATH has no `nextlevel` either.
   - **Every request file is signed.** What the command, the dashboard and the hub write for the hub to act on
     carries an HMAC with a per-project key kept outside the project (`~/.nextlevel/keys/<project>.key`). A file
     without a good one is never acted on: the hub sets it aside, logs it, flags the tasks that were running and says
     so on Home.
   - **A line typed into the notes files waits for the owner's yes.** A line added to `docs/OWNER_NOTES.md` or a tick in
     `docs/HANDOFF.md` (`src/lib/cards.mjs`, `load`) is no longer taken as the owner's: it becomes a card marked "typed
     into the file", which the orchestrator sees as unconfirmed and which starts no round, until the owner presses
     Confirm on the Notes page (or runs `nextlevel note confirm <id>` in their own window, refused under an agent). The
     files stay unprotected, so the cards' own writes and the orchestrator's commits of them go on as today.

   This stops a worker that tries by mistake, through an ordinary command, or because something it read told it to,
   through nextlevel's own commands and files; an instruction written for nextlevel (detach, read the key, edit
   nextlevel's code) passes layer 1 and is seen after the fact where 3.4 looks.
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
- a worker that starts a process outside its own tree. In layer 1 this includes ordinary detached starts
  (`cmd /c start`, `Start-Process` from a shell that then ends, `nohup ... &`, `setsid`), not only a scheduled task, a
  service or WMI: the new process's parent has ended, and a chain that ends at a gone parent can't be told from the
  owner's own. Layer 1 makes this a step a worker has to take on purpose; layer 2 closes it (the process still runs
  as the agents' account);
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
| A line in `docs/OWNER_NOTES.md`, a tick in `docs/HANDOFF.md` (a merge, or written into the main checkout) | an owner's note | an unconfirmed card: the owner's Confirm on the dashboard makes it theirs | same |
| The worker's own code run by the task's verify (scripts, tests), in the hub's tree | runs as the owner | refused by ancestry: verify processes are in the record | runs as the account, through the host |
| A lock test's verdict, a trial's answer (`lock-tests/`, `check-cache.json`) | taken | the hub signs its own verdicts; an unsigned one is no verdict | same |
| `closed.json`, `settings.json` | taken | signed by their writers; a bad one is the last good copy, flagged | same |
| The guard's records (`~/.nextlevel/guard/<project>/`: an approval) | taken | signed by the dashboard, which writes approvals | the account can't read or write `~/.nextlevel` |
| The dashboard as the owner (`ui-open.json`, its key in the browser's profile) | possible (part 2A's residuals) | `ui-open.json` signed | the account can't read the owner's profile or `.nextlevel/` |
| `.env`, the owner's gh, engines' sign-ins | readable | unchanged (out of layer 1) | not readable |
| Starting a dashboard or a hub of its own | possible | refused by ancestry | the account can't read the tool or the project's state |
| `jobs/<id>/job.json` (its `resolved` profile and arguments start the engine), `status.json` (what the orchestrator reads as verified), `run.json` (pids the hub stops) | taken | the hub's own, signed; a bad one stops that job, flagged | same |
| Process records: `hub.json`, `orchestrator.json`, `guide.json`, `cycle.json`, `ui.json`, `ui-port.json` (the hub, the dashboard and the updater follow or stop what they name) | taken | signed by their writers | same |
| Stop requests: `hub-stop.json`, `ui-stop.json` | the hub or dashboard stops | signed | same |
| Security engineer's and tester's requests (`.nextlevel/security/` scans and stops, the tester's runs) | started | signed by the command | same |
| Verdicts: `bridge-test.json`, `bridge-tests/<engine>.json` (say workers can't push), `lock-test.json` | taken | signed by the hub | same |
| `format.json` | read by every version | signed by the hub | same |
| `.nextlevel/checks/*.mjs` (code the doctor imports as the owner) | already protected: set back while an agent works, held in a merge | unchanged; a write by a detached process after the attempt isn't watched (section 7) | the account can't write `.nextlevel/` |
| `~/.nextlevel/channels.json`, `versions.json` (what a project runs) | taken | signed by `channel` and the installer | the account can't write `~/.nextlevel` |
| `~/.nextlevel/update/`: `available.json` (notes Home shows the owner), `hold.json`, `<id>/` (the plan `_update` follows) | taken | signed by their writers | same |
| `~/.nextlevel/state.json` (where reports are filed, what moved), `advisor/<project>/memory.json`, `cache/repos.json`, the fix store | taken | signed by their writers | same |
| The guard's `git.json`, `held.json`, `security-policy.json` | taken | signed (the hub, the dashboard) | same |
| nextlevel's own code: the version folders, `bin/launch.mjs`, the tool clone (its `.git/config` remote, its refs) | runs as the owner | not signable: seen after each attempt (3.4) | the account can't write `~/.nextlevel` |
| The owner's global settings: `~/.gitconfig` (`core.fsmonitor`, `core.hooksPath`: the hub's git runs them), the engines' settings and hooks, the PowerShell profile, `~/.npmrc` | runs as the owner | seen after each attempt (3.4) | the account can't write the owner's profile |

### 3.1 The command: refused by ancestry

- **The record.** As a worker starts, the hub writes `~/.nextlevel/guard/<project>/agents.json`: each running
  attempt's task id and its `_run` process (its pid and the time the hub recorded it: a process with that pid counts
  only if it started no later than 2 s after that time, so a pid Windows gave to a later program never matches),
  signed by the hub (2B-1b). Removed as the attempt's verify ends. It lives outside the project, beside the guard's
  records, so no worker reaches it in layer 2. The command reads every project's record on the PC: a worker can name
  any project, or none.
- **The record covers the attempt's verify too.** A task's verify commands run the worker's code (its scripts and
  tests) in the slot as the owner, from the hub (`finishTask`), after the worker's own processes ended. The record
  keeps the attempt until its verify ends, and names each verify shell the hub starts (pid and start time, from the
  hub's own child handle). The same holds for the processes of a `nextlevel verify` job and of the hub's git jobs
  and pushes (a project hook): they are recorded as `check` and `git-job`, and an acting command under them refuses as
  under a worker. (The hub's own git in a slot around an attempt, a commit for a worker whose sandbox can't write git,
  runs in one call the hub waits for and isn't recorded: the hooks it could run are git's own, which gitguard watches.) In layer 2 a task's verify runs as the agents' account, through the host (section 4.3).
- **The record comes from the hub's own handles.** The hub knows `_run`'s pid from the child it started; it reads
  that process's start time from one snapshot and records it. Every worker process descends from `_run`, so the
  engine's pid (which `run.json` reports, and a worker can rewrite) isn't needed for the check. An attempt the hub
  started in a window of its own (FR-010), or that an earlier hub run started, has no handle: it is recorded from
  `run.json`'s pid at the hub's next look, while that process runs (a worker could rewrite it first: section 7).
- **The check** (`src/lib/ancestry.mjs`, new, pure apart from the snapshot): one snapshot of all processes
  (`listProcesses`; on Linux the chain is read from `/proc`, one file per parent, with no program to start), the
  command's own chain of parents by parent id, each parent valid only if it started before its
  child (the rule `proctree.mjs` already uses). A link to a recorded worker process refuses: "this command runs under
  task <id>'s worker: workers don't ask the hub for anything; put it in your report". The refusal is logged in the
  guard's `refused.jsonl` and flags the task (section 5).
- **Which commands: all but the ones that only look.** The check runs for every command except a fixed list that
  only reads: `status`, `result`, `wait`, `usage` (not `--all-projects`), `note list`, `handoff list`/`show`,
  `doctor` without `--fix`, `version`, `help` and any `--help`. Everything else refuses under a worker, the
  underscore commands included (`_update`, `_run`, `_cycle`, `_trial`...: the hub starts them, never a worker), and
  so do the commands that act in their own process (`notify --now`, `daily-report`, `fix`, `team`, `doctor --fix`,
  `init`, `guide`, `login`, `ui`, `update`, `channel`). A new command acts until it is put on the list. (With
  `~/.nextlevel/bin` off its PATH, a worker reaches even the read-only ones only by their full path.)
- **Nothing from the caller's environment.** The check reads its record from the owner's home as the OS gives it
  (`os.userInfo().homedir`, never `NEXTLEVEL_HOME`, `USERPROFILE` or `HOME`), lists processes with Windows' own
  PowerShell at its fixed path (checked to exist) in an environment made from the OS (`windowsEnv`; none of the
  caller's values), loading no PowerShell module (`WMI_LIST`: a module's analysis took about 18 s there, KNOWN_ISSUES), or `/bin/ps`, and waits `LIST_WAIT_MS` whatever
  `NEXTLEVEL_PROCESS_LIST_MS` says. Test switches (`NEXTLEVEL_PROCESS_LIST_MS`, a stand-in listing,
  `NEXTLEVEL_TEST_*`) are honoured only when the tool runs from a checkout that is not an installed version folder.
- **Its cost:** the snapshot on Windows is one PowerShell start, about a second (KNOWN_ISSUES: "over 20 s on a busy
  GitHub runner"). It runs only when the record names a running worker or verify; with none, there is nothing to
  descend from. On autopilot that is most rounds' `dispatch`, `commit` and `merge`: S10 measures it, and the number
  goes into KNOWN_ISSUES. The tests stub the listing (the test switch above).
- **When the snapshot fails** (no answer within `LIST_WAIT_MS`) while the record names a running worker or verify:
  the command refuses, saying why, unless it carries a live session token of the orchestrator. The hub gives the
  orchestrator's window and each round a random token in their environment (`NEXTLEVEL_SESSION_TOKEN`, never on
  disk) and records its SHA-256, with the session's end, in the signed record beside the workers'. The command hashes
  the token it carries and compares; the hash leaves the record when the session ends. With no worker running, it
  runs. The spike measures whether Codex's sandbox lets the listing run (S2); if it does, the token is only a backstop.
  The hub has a token of its own the same way (`NEXTLEVEL_HUB_TOKEN`, its hash recorded while it runs), given only to
  the nextlevel processes it starts (`_run`, a round's `_cycle`...), each of which takes it out of its environment as it
  starts: so a worker's `_run` still starts when the listing fails, and nothing it starts carries the token (a worker's
  environment and what the hub records never get either token).
- **PATH:** `workerEnv` drops `~/.nextlevel/bin` and the version's own bin folder from a worker's PATH (safe updates
  put the version's command first on PATH for what it starts).

### 3.2 The files: signed

- **The keys.** 32 random bytes per project, `~/.nextlevel/keys/<project key>.key`, for the project's state and its
  guard records; and 32 for the PC, `~/.nextlevel/keys/pc.key`, for what every project shares (`channels.json`,
  `versions.json`, `update/`, `state.json`, `cache/`, the advisor's memory). Written by `init`, the installer, the
  hub's first start or the update that brings this (the owner's processes), never inside a project, never in an
  environment variable a worker gets, never logged.
- **The signature.** A field `sig: { v: 1, by, at, seq, mac }`. `mac` is HMAC-SHA256 over `v`, `by`, `at`, `seq`, the
  file's name relative to its root (`.nextlevel/`, `~/.nextlevel/guard/<project>/` or `~/.nextlevel/`, said with its
  root: `state:queue/x.json`, `guard:held.json`, `home:channels.json`) and the object without `sig` in a canonical form (keys sorted at every
  depth, `JSON.stringify` of each value), with a key derived per purpose from the project's key (HKDF: `state`,
  `guard`, `requests`; the PC's key for `home`). Compared with `crypto.timingSafeEqual`. `by` (`owner`, `orchestrator`, `dashboard`, `hub`) is
  for logs and Home only; the key is the proof.
- **No going back, for what persists.** A store that persists (the cards, settings, closed, rounds, process records,
  job records, verdicts, the guard's records, the PC's files) carries a `seq` that rises with every write, under the
  file's lock. The hub remembers the highest `seq` it took per file (in memory, and in
  `~/.nextlevel/guard/<project>/seen.json`, itself signed): a lower one is a put-back copy, set aside as untraced
  (section 5).
- **Requests are acted on once.** A request (a queue job, an outbox message, `wakeup.json`, `round-now.json`,
  `ui-open.json`, a stop request, a security or tester request) carries its own id in the signed object and no
  `seq`. It is acted on once: its id goes into `acted.json` (a store, under the rule above), kept 30 days, and a
  request whose `at` is older than that is set aside. The triggers that act at once (`wakeup.json`, `round-now.json`,
  `ui-open.json`, the stop requests) are also set aside when the hub first sees them more than 10 minutes after `at`.
  Queue jobs, outbox messages and scan and tester requests wait as long as they must.
- **The key's life.** Written once, by `init`, the installer (`pc.key`), the hub's first start or the update that
  brings this. Once
  `format.json` says the project's state is signed, a missing or changed key is never written again by itself: the
  hub stops acting on requests and Home says so, with the owner's fix (`nextlevel doctor --fix state.key` in their
  own window, which lists every file it signs and signs the current state again as the owner's, so a planted file
  isn't taken over unseen).
- **What isn't signed:** logs and pure caches (`usage.json`, `switches.json`, `logs/`, `chats/`): never acted on.
- **The launcher** (`src/launch.mjs`, outside every version) checks `channels.json`'s and `versions.json`'s signature
  with the PC's key, with its own copy of the check (it imports nothing from a version); a bad one stops it with the
  repair command, as a missing version folder does.
- **Who signs:** `lib/sign.mjs` (new), used by every writer of a signed file: the hub's `writeJson`; `_run` (a job's
  `run.json` and `status.json`; it is the hub's child, outside the worker's tree); `cards.mjs`'s store writes; the
  commands' queue, outbox, wakeup, security and tester requests; the dashboard (approvals, `round-now.json`,
  `ui-open.json`, stop requests, settings); `channel`, the installer and the updater (the PC's files, `hold.json`,
  the update plans); `team` and the doctor's fixes (their guard records).
- **Older files.** The update that brings this runs after running work ended (`holdFor`) and signs the stores (cards,
  settings, closed, rounds, the guard's records, process records), as the owner's. It doesn't sign pending requests
  (queue, outbox, wakeup, round-now, stop and scan requests): they are listed on Home as "made before this update",
  and the owner runs again what they want. An older version ignores `sig` (its shape checks allow the field: each
  reader is checked in 2B-1b), so going back needs no rewrite and `format.json` isn't raised for this. Going forward
  again runs the same migration: it clears `seen.json` and `acted.json`'s numbers for the project, then signs the
  stores again, since files the older version wrote are unsigned.
- **The file protocol stays:** same folders, same names, one more field. A hub that doesn't know `sig` ignores it.

As built (2B-1b1, `src/lib/sign.mjs`): 2B-1b is built in steps, and the first signs the **requests** only: a job in
`queue/` (the commands' and the hub's), a phone message in `outbox/`, `wakeup.json` and a press of Run a round now. Each
carries an id (`rid`) in the signed object; `acted.json` in the guard's folder, signed by the hub (purpose `guard`),
keeps the ids acted on for 30 days. A job or a message without a good signature is moved to `.nextlevel/untraced/`; a
wake-up or a press, which the orchestrator's command or the dashboard rewrites in place, is ignored where it is and logged
once per content. Each is logged in hub.log and the guard's `untraced.jsonl`, flags the tasks running since the hub's
last look (`untraced` in their status, in the summary `nextlevel result` and the orchestrator read), and puts one card
on Home (Seen, `POST /api/untraced`) with at most one phone message an hour. What a request asked for is said in words
from code that never quote its text (a message's title, a push's target), so a `.env` value planted there doesn't reach
the card or the phone. The key's record is `signing.json` beside the guard's records, not `format.json`: once it is
there, a missing or changed key is never made again by itself, and the hub acts on no request (a Home card and the
doctor's `state.key`, an error). Choices left to this step, with the safer reading taken:
- Pending requests written before the update are unsigned and go to the card, as the design says, rather than being
  signed by the update (signing them would take over a planted one unseen).
- `acted.json` that fails its check is logged on the card and not read, and the hub then refuses any request signed before its own start
  (`actedSince`), since it can't tell which of them it acted on already.
- `nextlevel doctor --fix state.key` makes a new key and lists the requests that were waiting (the hub then sets them
  aside), rather than signing them again: in 1b1 nothing else is signed, and signing what waits would take over a
  planted file. It runs only in the owner's own window (never the dashboard's button, never in an agent's session).
- A wake-up's and a press's 10 minutes go by the hub's clock (`src/lib/clock.mjs`, a test clock under the stubs). One
  nextlevel signed but the hub saw too late isn't a forgery: it is said once in hub.log, with no card, flag or phone
  message.
- `acted.json` is made, empty and signed, with the key (and again with a new key, since nothing signed with the old one
  is good any more); a running hub that sees the key's record change takes the new key and signs its own record again.
  With a key there, a missing `acted.json` was deleted: it is treated like one that fails its check.
Next (2B-1b2 on): the stores with `seq` and `seen.json`, the PC's files and the launcher's check, the other requests
(`ui-open.json`, the stop requests, scan and tester requests) and the migration.

### 3.3 The owner's own commands and the orchestrator's

- **The owner's window** (START.cmd, PowerShell): the command reads the key and signs. Nothing changes for the owner.
- **The orchestrator on Codex**, inside its sandbox: the command reads the key from `~/.nextlevel/keys` (Codex's
  Windows sandbox reads outside the project; it already runs the tool from `~/.nextlevel`) and writes into the project,
  which it may. The spike checks both (S2).
  The orchestrator's sessions also carry their session token (3.1), which counts only when the process listing fails.
  If S2 shows that Codex's sandbox can't read `~/.nextlevel/keys`, the orchestrator's requests carry that token in
  place of a signature, and the hub checks it against the record before acting. In that case the command doesn't
  judge the token itself: it can't read the record, so it hands the token on with its request and the hub decides.
  Nothing else changes.
- **The orchestrator on Claude Code or agy**, as the owner: as the owner's window.
- **The dashboard and the hub** sign in process.

### 3.4 What can't be signed: seen after each attempt

nextlevel's own code and the owner's global settings run as the owner and can't carry a signature. After each attempt
and at the hub's start, the hub compares: `git status --porcelain` in the running version's folder and in the tool's
clone (run with `-c core.fsmonitor=false -c core.hooksPath=<an empty folder>`, so the look never runs what it looks
for); the clone's `origin` URL with `state.json`'s; `bin/launch.mjs` with the version's copy; the global git settings
in gitguard's list. A change stops dispatch, with a Home card naming it, the attempts that ran since the last look
flagged (section 5), and one phone message. This is detection after the fact, not a bar: a worker can change nextlevel
itself in layer 1 (section 7).

As built (2B-1a3, `src/lib/toollook.mjs`): every part is compared with the hub's last look, kept in the guard's folder
(`tool-look.json`), so the launcher is compared with what it was rather than with the version's copy (a pinned older
version runs beside a newer launcher), and the clone's origin with the last look (state.json doesn't record it). Held
tasks say why (`waiting`); the owner's Seen takes the files as they are now as the next look's base. A global hooks
folder's files count with the global settings, and an included file's settings with the file that includes it. Files are
the ones `git ls-files` lists, hashed by nextlevel, never `git status` (which hashes a changed file through the clean
filter its attributes name); the clone's own settings, hooks and `info/` files are a part of their own.

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
engine, not one per project). The runner's accounts are one per repository because a CI job must reach no project; the
agents' account must reach every project's slots. Standard user, a random 32-character password nextlevel generates, hands to the scheduled
task once (Windows keeps it in LSA) and never writes; "Deny log on locally" and "Deny log on through Remote Desktop";
"Log on as a batch job"; not in Administrators, `docker-users`, Remote Desktop Users or Hyper-V Administrators. Created
in one elevated step shown on its card and run with `Start-Process -Verb RunAs` (the UAC prompt is the owner's
confirmation, as the runner's). The password never expires (`Set-LocalUser -PasswordNeverExpires`), or the scheduled
task stops starting after the local policy's 42 days. The user rights are set with `secedit` (built in).

### 4.3 How a worker starts and stops

- **The agents' host** (`src/agenthost.mjs`, new): a Node process running as `nl-agents`, started by a scheduled task at
  the owner's logon and on demand (`schtasks /run`), from a copy of the tool the account can read
  (`C:\ProgramData\nextlevel-agents\tool\<version>`, written by the owner's updater). It reads run requests from
  `C:\ProgramData\nextlevel-agents\<project>\inbox\`. `C:\ProgramData\nextlevel-agents` gets explicit ACLs with
  inheritance removed (`icacls /inheritance:r`): the default lets `Users` create files in every subfolder. The inbox
  and the tool copy: the owner, SYSTEM and Administrators write, the account reads. The ACL is the proof a request came
  from the owner's side; a key the account can read proves nothing to it, so requests carry no MAC. The host starts the worker's engine exactly as
  `workerRun` says (same arguments, environment, launcher, files), and writes its pid, start time, log and end into
  `...\<project>\runs\<job>\` (the account writes, the owner reads).
- **Stopping:** a standard user can't end another user's process. The hub writes a stop request; the host stops the
  tree (`stopProcesses`, unchanged). If the host is gone, Home says so with Check again (as a held slot does today).
- **The console:** agy needs a real console (FR-010). A batch-logon process has no desktop; `CREATE_NO_WINDOW` still
  gives a console. The spike measures that agy runs there (S5).
- **Reports and results:** `RESULT.md` and the commits are in the slot; the hub reads them there (4.4).
- **The task's verify** runs as the account, through the host, in the slot (section 3.1).

### 4.4 Slots: clones, not worktrees

A worktree's commits land in the main repository's `.git` (objects and refs): the account would need write access to
the owner's `.git`, and could move `main`. So in layer 2 a slot is a repository of the account's own, in
`C:\ProgramData\nextlevel-agents\<project>\slots\<n>`, made from a bundle, with the main repository's objects read
through `alternates` (read access to `.git/objects` only).

The owner runs one git command against a slot: `git -c safe.directory=<slot> fetch <slot> task/<id>:task/<id>` into
the main repository, with that one setting for that one fetch (upload-pack runs no hooks, filters or fsmonitor; Git
2.45.1 or newer, which the doctor checks, for the local-clone fixes). The owner never runs any other git command in a
slot, with or without `safe.directory`, and never pushes into one (receive-pack would run the slot's hooks). Everything else that today runs git in the slot (the merge of the base, FR-008's commits for
workers that can't write git, `status`, `diff`, `log`, the reflog reads of slotwatch) runs as the account through the
host, or on the fetched `task/<id>` in the main repository. The hub reads a slot's files (`RESULT.md`, `PROGRESS.md`, the worker's log) without following links or junctions
(a reparse point is refused and flagged), and writes none there through one (`slotfiles.mjs`, as today). The base
branch reaches the slot as a bundle: the hub writes `git bundle create` of the base into the host's inbox, and the host
fetches from that file. The account never reads the main repository's `config`, refs or hooks. It reads only
`.git\objects` (granted on that folder alone), for the slot's `alternates`. A `git gc` in the main repository that prunes
objects only a slot's `alternates` reach would break it: if the spike shows that, slots are cut loose (`git repack -a
-d`, then `alternates` removed).

What reads the slot as a worktree today (`gitguard`'s slot hooks, `slotwatch`, `findProject`'s slot test,
`cleanSlot`) learns the clone; layer 1 keeps worktrees.

### 4.5 The engines under the account

- **Installs.** agy, Codex and Claude Code installed per user live in the owner's profile (`%LOCALAPPDATA%`,
  `%APPDATA%\npm`), which the account can't read. Either a machine-wide install, or the account's own install run by
  the host. The spike measures which works for each (S3).
- **Sign-ins.** The account needs its own sign-in to the owner's plans: `nextlevel login --agents <profile>` asks the
  host to run the engine's own login and shows its device code or link on the dashboard. Only a login that prints a
  code or a link qualifies: Claude Code's `setup-token` prints a long-lived token, which would pass through nextlevel,
  so it isn't used. The account has "Deny log on locally", so `runas` can't open a window as it: each engine's login
  must work from the host (batch logon, no desktop). S4 measures which do. nextlevel never reads, copies or moves a sign-in. Using the
  owner's own subscription from a second Windows account on the same PC needs checking against each provider's terms
  before step 2 (CLAUDE.md, "Profiles"): this is the owner's plan used by the owner's agents, not a second person.
- **Add-ons:** the account has none of the owner's MCP servers, skills or hooks, so FR-013's `workerAddons` holds by
  construction.

### 4.6 What breaks, and what's done about it

- **git's `safe.directory`:** the owner's git refuses a slot the account owns. The owner only fetches from a slot,
  with `-c safe.directory=<slot>` for that fetch alone (4.4), never `*` and never in the owner's global settings.
- **Docker:** the account isn't in `docker-users` (owner-equivalent). A task with `Needs: docker` is refused at
  dispatch on a walled worker (`workerLacks`, as part B of Codex workers does), with that said; the owner can run such a
  task on a worker outside the wall by profile.
- **Caches:** npm, pnpm, pip and Playwright caches are per user; the account's first installs are slow. Measured (S6).
- **Ports:** the account's dev servers bind `127.0.0.1` with the slot's port offset, as today.
- **Antivirus:** a new user starting Node and engines from `C:\ProgramData` may trip Bitdefender. Measured (S7); if
  anything is blocked or quarantined, the spike stops and the owner is told.
- **Disk:** a slot reads the main repository's objects through `alternates`, so it costs its working tree and its
  own commits only.

### 4.7 The proof

As the runner's: `walls.mjs` probes each of the owner's places as the account before the host starts a worker, for
reading and for writing: reading `.env` of every known project, `~/.nextlevel`, the key, the guard's records, the
owner's gh, the engines' sign-in folders, the main checkout's `.nextlevel/`; writing the host's inbox, its tool copy
and the main checkout. One place the account can read, or write where it shouldn't, stops the walled workers, with a Home
card naming it and the fix. In CI, on GitHub's own runners only, a test creates a user and runs the probe as it.

## 5. A request nextlevel can't trace

- **Set aside, never acted on.** The hub moves an unsigned or badly signed request to `.nextlevel/untraced/<time>-<name>`
  (a store whose signature fails: the last good copy is put back from `~/.nextlevel/guard/<project>/stores/`, and the bad
  one moved there too).
- **Logged:** a line in hub.log and in the guard's `untraced.jsonl` (file, size, hash, what it asked for in words from
  code, the tasks running at the time).
- **Flagged:** each task whose worker or verify was running between the hub's last look that didn't see the file
  and the look that did (the hub's own clock; a file's time is its writer's to set) gets `untraced: [...]` in its
  status, shown in `nextlevel result`, on the Build page and in what the orchestrator reads. A refusal by ancestry
  flags its own task exactly.
- **Home:** one card, "A request nextlevel didn't write was set aside", with what it asked for and the flagged tasks,
  and Seen; at most one card per kind and one phone message an hour, so a flood of bad files stays one card. Nothing on the card acts on the request: the owner who wants it does
  it themselves.

## 6. Tests (step 2)

Stub workers that try each path, each try changing nothing, logged and flagged:
the command from PATH, by its full path, with the variables cleared, with `--project <main>`, with
`NEXTLEVEL_PROCESS_LIST_MS=0` or `NEXTLEVEL_HOME` set; the command from the task's verify (a `test` script); a job written into
`queue/`; a message into `outbox/`; `wakeup.json` and `round-now.json`; a card changed in `notes.json`; a line added
to `docs/OWNER_NOTES.md` on its branch, and in the main checkout while it runs; its own held push marked approved in the
guard's records; a signed outbox message copied into `queue/`; an acted-on job replayed; an older signed
`status.json` and `acted.json` put back; a change to the tool's folder seen after the attempt. And the ordinary ones still
work: the owner's commands, the dashboard's approvals, the orchestrator's commands in a stand-in for Codex's sandbox
(a process that can write only the project and can't list processes: the ancestry fallback). Each refusal broken once
on purpose (the check removed, the signature not checked) must fail its test. Layer 2: `winuser.mjs`'s tools stubbed
everywhere but GitHub's own runners; the host with a stub engine; the walls probe.

## 7. What stays open (for KNOWN_ISSUES)

- **Layer 1 only:** a worker that reads the key or the workers' record from the owner's profile and writes a signed
  request, or that starts a process outside its tree, passes. Layer 1 makes that deliberate, never ordinary. That
  includes a worker that detaches a process (its parent ends) and runs `nextlevel` from it, and an engine whose tool
  commands don't descend from the recorded processes (measured per engine in S9). A worker can change nextlevel's own
  code or the owner's global settings: seen after the attempt (3.4), not stopped; a write to `.nextlevel/checks/` by a
  detached process after the attempt isn't watched.
- **Always:** reading another process's memory or environment; the orchestrator and the assistant still run as the
  owner (the agents' account for them is a later step: the orchestrator needs to write the main checkout, which the
  account then could); a worker's own work (code, tests) is still what the orchestrator reviews and merges; what a
  walled worker does on the network (its engine's API, the internet, the LAN, the PC's services on `0.0.0.0`).
- **Layer 2, one account:** one project's worker can write another project's slots (in-progress work that project's
  orchestrator then reviews). Per-project accounts stay a later option for an owner who mixes clients' projects. A
  worker's code reaches the owner's power once merged, through the orchestrator's `nextlevel verify` and the owner's
  own commands in the main checkout: review is the bar there.
- **POSIX:** layer 1 only. A second user there needs sudo; not planned.

## 8. The spike (on the owner's PC, with the owner's yes)

In a throwaway trial project and a throwaway user `nl-spike`, never a real project; every step run by a Remote Control session, the UAC
prompts the owner's. Removed at the end (`net user nl-spike /delete`, its profile and the `C:\ProgramData` folder),
each removal listed for the owner. Every script is parse-checked (`[Parser]::ParseFile`) before the owner is asked for a
UAC click, and elevated steps run with a transcript: in part 1 an elevated window that opened and closed at once was
Windows PowerShell 5.1 refusing to parse `(a; b)` inside parentheses.

| # | What | How | Result |
|---|---|---|---|
| S1 | A process as `nl-spike` with built-in tools only | `schtasks /create /ru nl-spike /rp <pw> /sc once ...` then `/run`; Node prints `whoami` and a file it wrote | **Part 1 (7 Nov):** never started. A stored-password task for a new standard user stays at 0x41303 "has not yet run" unless the account holds "Log on as a batch job" (SeBatchLogonRight), which `Register-ScheduledTask -User -Password` didn't grant (held only by Administrators, Backup Operators, Performance Log Users). The elevated step grants it (`secedit`, 4.2) and the removal takes it back. Rerun with the right granted: still to do |
| S2 | The orchestrator's commands in Codex's sandbox | from the orchestrator on Codex: read `~/.nextlevel`, write `.nextlevel/`, run the process listing | |
| S3 | Engines installed and running as the account | `agy --version`, `codex --version`, `claude --version` from the owner's install and from a machine-wide one | |
| S4 | Sign-ins as the account | each engine's device-code login, the owner's plans; one prompt answered by each | |
| S5 | agy in a console with no window, batch logon | the stub-free probe of FR-022's trial, run by the host | |
| S6 | A slot clone and the hub's fetch | the slot made by `git init`, then `alternates` written to the trial project's `.git\objects` (the account granted that folder only), then `git fetch` from a thin bundle (`git bundle create x.bundle <base>^!` or `<old base>..<base>`, whose missing objects `alternates` supplies), a commit as the account, the owner's `git -c safe.directory=<slot> fetch`; whether that fetch needs the setting at all; `npm ci` in the slot | |
| S7 | The walls | as the account: read `~/.nextlevel`, `.env`, `%APPDATA%\GitHub CLI`, `~/.codex`, `~/.claude`, `~/.gemini`, the main checkout's `.nextlevel/` | |
| S8 | Antivirus | Bitdefender's log after S1 to S11 | Part 1: no detections (the PC ran Defender) |
| S9 | A worker's commands descend from `_run` | per engine (agy, Claude Code, Codex in its sandbox and out of it): the worker runs `nextlevel status --json` and a probe prints its parent chain; and `cmd /c start` breaks it, as expected | |
| S10 | The listing's cost | `listProcesses` timed 20 times on the owner's PC while two workers build, and from the orchestrator in Codex's sandbox (with S2) | Part 1, owner's shell, idle PC, a fresh `powershell.exe` each time: median about 0.7 s (min 0.64, max 1.4). In KNOWN_ISSUES. Under workers and in Codex's sandbox: part 2 |
| S11 | The owner's fetch from an account-owned slot | a `core.fsmonitor`, `core.hooksPath` and a `filter` planted in the slot's config: the owner's `git fetch` runs none of them | |

## 9. The pull requests (step 2)

1. **2B-1a, the command refuses a worker:** `lib/ancestry.mjs`, the record (attempts and their verify, `nextlevel
   verify` jobs, git jobs and pushes), the session token, PATH, the refusals logged and flagged on the task, their
   tests. This stops the ordinary command on its own.
   **2B-1a2, typed notes confirmed on the dashboard:** a note typed into the notes file waits for the owner's Confirm
   (the orchestrator sees only that it waits, never its text, and it starts no round); a tick in the handoff file is
   marked on its card until the owner presses Done; Home asks about both. Their tests.
   **2B-1a3, the look after each attempt** (3.4), its tests. (Both split from 2B-1a to keep each pull request
   reviewable.)
2. **2B-1b, signed state:** `lib/sign.mjs`, every signed writer, `seq` and expiry, the migration, the untraced card,
   their tests.
3. **2B-2, the agents' account (layer 2):** after the spike passes, and after or with the runner's part B, whichever
   builds `winuser.mjs` and `walls.mjs` first. The host, slot clones, `login --agents`, the doctor's `agents.wall`,
   Team's "Workers run as their own Windows user" switch.

## 10. The maintainers' answers (6 November)

1. **Sign broadly?** Yes, with the rollback rule (3.2), or the breadth buys little. Logs and pure caches stay unsigned
   and are never acted on. The orchestrator's direct writes becoming untraced is right: its protocol is the commands.
2. **When the listing fails:** refuse acting commands while a worker or verify runs, unless the caller carries the
   orchestrator's session token (3.1).
3. **One account per PC,** with the cross-project reach in section 7.
4. **Protect the two Markdown files?** No: typed lines become unconfirmed cards the owner confirms (section 1).

## 11. What the design review changed (6 November)

R1 the record covers the task's verify, `nextlevel verify` jobs and git jobs; R2 the check takes nothing from the
caller's environment, denies by default and records `_run` from the hub's own handle; R3 detached starts are named as
out of scope; R4 the table's twenty more rows and section 3.4; R5 `seq`, expiry, `timingSafeEqual`, roots and the
key's life; R6 typed notes confirmed instead of protected; R7 flagging by the hub's own clock; R8 the owner only fetches
from a slot, ACLs on `C:\ProgramData`, the walls probe writes too, the password, headless logins; R9 what the migration
signs and going back; R10 spike steps S9 to S11. The delta check's D1 to D7: the one fetch with `safe.directory` and the base as a bundle,
the session token's hash in the record, the PC's key, `seq` only for stores and requests acted on once, going forward
again, every signer named, the walls stop on a write. Optional points taken: the split of 2B-1, the cost, per-purpose keys,
Claude Code workers, cross-project reach, the card's cap, `--shared` and `gc`.
