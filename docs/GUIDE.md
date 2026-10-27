# Using nextlevel

The full guide: installing and updating, setting a project up, the dashboard, field reports, the settings in
`nextlevel.json`, protected files, and engines and accounts. The README has the short version.

## Install
Once per PC. In **PowerShell** (a normal window, not "Run as administrator"), in any folder:

```powershell
irm https://raw.githubusercontent.com/DYevseyev/nextlevelorc/main/install.ps1 | iex
```

From a private fork (`$env:NEXTLEVEL_REPO = "owner/name"`), the GitHub CLI signed in to an account that can see it
reads it instead: `gh api repos/<owner>/<name>/contents/install.ps1 -H "Accept: application/vnd.github.raw" | Out-String | iex`.

The installer checks Node.js 22+ and Git (and offers to install them with winget), puts the tool in
`%USERPROFILE%\.nextlevel\tool` as a git clone, and makes the `nextlevel` command
(`%USERPROFILE%\.nextlevel\bin`, added to your PATH). Open a new PowerShell window and check:
`nextlevel version`. **Running the same command again repairs the install** (and moves it to the newest release).
It installs the newest release, in a folder of its own, and the command runs it (or the version a project follows).
An install made by hand earlier (a clone in that folder plus `npm link`) is taken over, and the installer's command
replaces the one `npm link` made. Files you changed in the tool's folder
stop it, with the way out; nothing is thrown away. Options, set before running it:
`$env:NEXTLEVEL_REF = "v0.2.0"` (a release instead of the newest), `$env:NEXTLEVEL_NO_PATH = "1"`
(leave PATH alone), and `$env:NEXTLEVEL_DIR` (below).

**Another folder for the tool:** set `$env:NEXTLEVEL_DIR` before the install command, in the same
PowerShell window, for example:

```powershell
$env:NEXTLEVEL_DIR = "$env:USERPROFILE\Tools\nextlevel"
irm https://raw.githubusercontent.com/DYevseyev/nextlevelorc/main/install.ps1 | iex
```

An install that is elsewhere (`%USERPROFILE%\.nextlevel\tool`, say) moves there, as it is; the `nextlevel`
command and its updates follow it, and running the installer again later stays in that folder. Stop the
hub and let workers finish first (the installer waits for them). The folder must be new or empty. The
command stays in `%USERPROFILE%\.nextlevel\bin`, and the dashboard's Tools page shows where the tool is.

Linux and macOS: `git clone https://github.com/DYevseyev/nextlevelorc.git ~/.nextlevel/tool`, then
`node ~/.nextlevel/tool/bin/nextlevel.mjs _install` (it says what to add to PATH). With PowerShell 7
(`pwsh`) the command above works there too.

**Antivirus:** a build team does things a behaviour-based antivirus also watches for (programs with no window, an
agent that runs commands, tools fetched with npx). If yours stops a worker or quarantines a tool's files, `docs/ANTIVIRUS.md`
has the one narrow exception to make and the way back;
`nextlevel doctor` lists files that are gone (`tool.files`).

### Updates
nextlevel updates only to a **release**: an annotated tag on main that is made once the change's owner check passed
(`docs/RELEASES.md` lists them). A merge alone never reaches your projects. Each version runs from a folder of its own
(`%USERPROFILE%\.nextlevel\versions\<release>`), so nothing that still runs the old one sees its files change, and
going back is switching back. The hubs and the dashboard look for releases every 6 hours; Home shows **Update
available** with what it fixes in plain words, safety fixes marked, and your phone hears a release with a safety fix
(once per project). Nothing installs by itself: a command's start only says, in one line, that a release is there.

```powershell
nextlevel update                  # update to the newest release (stop the hub first; it waits while anything runs)
nextlevel update --to v0.2.0      # go to a release, an older one too: going back is your choice
nextlevel channel                 # what this project runs
nextlevel channel candidate main  # run a branch in this project (for trying a change, as on a test project)
nextlevel channel pin v0.2.0      # keep this project at a release
nextlevel channel release         # follow releases again (the default)
```

**The one click:** Home's **Update** (or `nextlevel update`, which follows the same steps in your window) waits for what
runs (tasks, a round, the orchestrator's window: Home shows what, with Stop waiting), pushes your backup branch if
`updates.backupBranch` in `nextlevel.json` names one, stops the hubs and dashboards, switches, starts them again the way
they ran (autopilot as it was), refreshes and commits the role docs you never edited, runs the bridge test when an engine
or the slots' push block changed, and checks the doctor's rows. The dashboard opens again in a new tab. If a step fails it
pauses, Home says why, your phone hears it, and Try again or Go back is one click.

Updating and channels are yours alone: in an agent's session (the orchestrator's window, an autopilot round, a verify
command, a worker's slot) they refuse and say why.

`nextlevel doctor` shows the state under "nextlevel updates" and "nextlevel channel". If an antivirus takes
nextlevel's own files, one folder exception on `%USERPROFILE%\.nextlevel\versions` covers every version. An install from before
releases moves to the first one when you run the install command again (when no hub or worker runs).

**Moving to another repository** (where nextlevel is published now, or a fork): the install command of the new one
moves your install, but only when you name the repository it follows now, in the same PowerShell window first:
`$env:NEXTLEVEL_MOVE_FROM = "owner/name"` (the installer tells you the exact line). Its versions, the projects pinned to
them and your settings stay, and the new repository's newest release is installed. Field reports from this PC keep going
to the repository you left (`"reports"` in `%USERPROFILE%\.nextlevel\state.json`; remove it to send them to the new one),
fixes still waiting there are no longer followed, and the old repository stays as the git remote `nextlevel-previous`.

## Use it on a project
In **PowerShell, in the project's folder** (a git repository; `git init -b main` starts one):

```powershell
nextlevel init       # adds nextlevel.json, BRIEF.md, AGENTS.md, docs/agents/, START.cmd, .env.example
git add -A
git commit -m "chore: set up nextlevel"
nextlevel doctor     # checks tools, sign-ins and the project; creates .env
```

The doctor says for each problem what to do and in which window (PowerShell, the browser, inside
Codex...); `nextlevel doctor --fix` fixes what it can, and `docs/CHECKS.md` explains every check.

Then double-click the project's `START.cmd` (or run `nextlevel`) for the menu: setup guide, hub,
orchestrator, autopilot, status, bridge test, and the dashboard (below). `nextlevel help` lists every command. Commands work
from any folder inside the project, or from anywhere with `--project <folder>`.

`init` never replaces a file of yours without showing the difference and asking, and never touches
`BRIEF.md` or the status, handoff, decision and owner-notes documents once they exist. When nextlevel
updates its role docs, the doctor's "Role docs version" row offers to bring yours up to date.

### The orchestrator and Codex's sandbox
The orchestrator's git writes go through the hub on every engine. On Codex it runs in Codex's sandbox, which can't write the project's `.git` folder, can't
see your sign-ins or Docker, and has no network. So the hub does all of that for it: `nextlevel commit`,
`merge` and `cleanup` for git, `push`, `verify` for heavy checks (and `nextlevel verify doctor --
nextlevel doctor` for the setup), `notify` for your phone. Run inside the sandbox, `nextlevel doctor`
says so and marks what it can't see there as "can't tell". Notifications carry the request itself;
file names in them become links to the file on GitHub.

A verify command runs without your GitHub sign-in, so nothing it runs can push or write to GitHub (FR-017). To let the
orchestrator read GitHub through it (CI runs, their steps and logs), give the project a read-only token: a fine-grained
token for that one repository, with Actions, Contents, Pull requests and Commit statuses set to Read-only, in the
project's `.env` as `NEXTLEVEL_GITHUB_READ_TOKEN=...`. The doctor's row "GitHub reads for verify" has the steps, checks
that the token reads the repository, and warns a week before it expires. A worker never gets it.

### The dashboard
START.cmd -> **d** (or `nextlevel ui` in PowerShell, in the project's folder) opens a window that
runs the dashboard and opens it in your browser (Edge or Chrome). Leave that window open while you use
it; closing it stops the dashboard. Choosing d again while it runs just shows the page again.

- **Home** (it opens there): whether the team runs (hub, autopilot, orchestrator, each with its button),
  one sentence per running task ("Gateway, attempt 6: fixing what the review found: ...") with its latest
  progress note and a **Show activity** toggle (collapsed at first; the browser remembers which are open):
  the worker's progress notes (every worker adds a line to `.nextlevel-task/PROGRESS.md` every few steps:
  what it does and why) and, where the engine prints its steps, what it ran, newest first: commands, files
  edited, test results (Claude Code, Codex and Antigravity). Both are redacted like a report, and asked for only while the toggle is open. Then what needs
  you (a failing setup check, the hub stopped, paused autopilot, a task past 3 attempts or its time limit,
  each thing the team needs from you with what, where and why, and **Done** and **Reply** buttons) with the
  **Next** action as a button, milestone progress, today's numbers per role (autopilot rounds, the
  orchestrator's window, workers, the setup guide) and per engine: rounds, sessions or attempts, minutes, and
  tokens where the engine reports them (Codex's JSON output and its session files, Claude Code's and
  Antigravity's JSON output), and **Fallbacks and engine switches**: every task
  that ran on another engine than the workers' and every autopilot round on the orchestrator's fallback,
  with why (`retry with --fallback`, `--engine`, or an automatic fallback and the check that caused it).
  Autopilot says what its next round waits for ("Waits for your reply on H22, a new note, or a task finishing", a
  wake-up's time and reason, or that three rounds found nothing to do), or that it waits because the orchestrator is
  open in its own window; **Run a round now** starts one. Today counts the rounds, their minutes and Codex tokens by
  what started them (FR-019).
- **Setup**: every check, with its steps and where to type each one (PowerShell, the browser, inside
  Codex...) and a Copy button. **Fix** appears where nextlevel can fix it by itself; installs and
  sign-ins stay commands for your own window. Come back to the page and it checks again (slow answers, such as
  agy's sign-in, are kept a few minutes); **Check again** asks everything afresh.
- **Build**: the milestones from `docs/STATUS.md`, running workers with the end of their log (this attempt's
  only, and it says which) and what they changed, what is queued and what waits for review, each with the
  engine, model and effort it ran on, and why it ran there.
- **Team**: each role (orchestrator, workers, fallback worker, setup guide, the assistant) with the engine, model and
  reasoning effort in use, "the engine's own choice" shown as the real model where its files say it (Codex's
  `config.toml`, Claude Code's `settings.json`). **Change** switches the engine, model and effort from
  dropdowns (the models Codex and agy list; Claude Code's names, or any name; Antigravity has no effort: it takes
  the level from the model's name, gemini-3.8-flash-high is high, claude-opus-5-5-medium is medium), says what the choice means (Antigravity runs each task
  in a console with no window on Windows; Claude Code uses your Claude plan; Codex as a
  worker on Windows can't reach Docker or run npm's `.ps1` shims, FR-009), and runs
  the doctor's checks for it (installed, signed in, the model accepted; for Antigravity exactly what a worker
  runs, tried headless, and agy's own reason when it refuses) before it saves `nextlevel.json`. **Worker windows** says how workers
  show on Windows: no window (the default: nothing opens or takes the focus), minimized, or a window each.
  It applies at the next autopilot round or the next task; nothing running is interrupted. In PowerShell:
  `nextlevel team`, `nextlevel team set worker --engine claude --model opus --effort high`.
  **GitHub checks** says where the project's GitHub checks run and whether to run them on this PC instead. A private
  repository pays GitHub for every minute on its runners (Windows minutes count twice), and when an account's Actions budget runs out GitHub
  stops starting its jobs, so nothing can merge; a runner on your own PC costs nothing (GitHub doesn't charge for
  self-hosted runners today, which may change). The card recommends it for a personal account's private repository whose
  workflows use GitHub's paid runners, with the last 30 days' minutes and which jobs would move (a job with an
  environment or a secret stays on GitHub by default). It never offers it for a public repository (anyone's pull request
  could run code on your PC), an internal one or an organization's. Setting the runner up comes in a later version: the
  card only recommends for now. In PowerShell: `nextlevel team runner status` (`--repo owner/name` for another
  repository).
- **Tools**: start and stop the hub, autopilot, the orchestrator and setup guide windows, where nextlevel
  is installed (and how to update or move it), and more commands to copy.
- **Notes and handoffs**: cards. On one side, what the team needs from you: each item with what to do,
  where and why, a **Done** button and a reply field. On the other, your notes to the orchestrator: write one
  in the box, as a one-time instruction or a standing rule; each card shows its state (new, seen by the
  orchestrator, done with its one-line reply and links to the commit or task, or declined with why). Edit or
  withdraw a note, switch a rule off or remove it; standing rules stay listed until removed, and handled
  notes move to a history you can search. The orchestrator reads and answers them with `nextlevel note` and
  `nextlevel handoff`, and `docs/OWNER_NOTES.md` and `docs/HANDOFF.md` are written from the cards (kept in
  `.nextlevel/`) for Git: don't edit those two by hand. What they said before is imported the first time.
  In PowerShell: `nextlevel note add "Use Postgres" [--rule]`, `nextlevel handoff done H2 --reply "done"`.
- **Ask** (the button at the top right, on every page): a side chat with a read-only assistant that answers
  your questions about the project: what is blocked, why a task failed, what the plan says. It is not the
  orchestrator: each question is a fresh session of its own (with the thread so far), so asking adds nothing to
  the orchestrator's work or its rounds. It starts from a short briefing (`docs/PROJECT.md` if there is one, the
  status file, open handoff items and notes, the hub's status, the last day's jobs and why each ran where it
  did, recent commits), may open the project's files, task specs, reports and logs, and ends its answer with the
  files, jobs or commits it used. It can't change anything: Codex runs in its read-only sandbox, Claude Code in
  plan mode with the tools that write denied, and the only nextlevel commands it may run are those that look
  (`status`, `result --peek`, `team`, `doctor --json`); Antigravity isn't offered for it. `.env` values are never
  sent to it, and anything that looks like a secret is replaced with `***`. When an answer suggests something
  for the team, **Draft the note it suggests** (or **Draft a note**) opens it as a note you edit, make a
  one-time instruction or a standing rule, and send: it goes to the orchestrator only when you send it.
  Threads are kept in `.nextlevel/chats/`: start, rename, search, clear or delete them. In PowerShell:
  `nextlevel ask "Why did M1-02 fail?"`, then `nextlevel ask --thread <id> "a follow-up"`;
  `nextlevel ask threads [--search text]`. Today on Home counts it as its own row, with its tokens and minutes.
- **The Advisor** is what Ask became (`docs/design/advisor.md`). **Advise** (the default) runs on another engine
  than the orchestrator's when one is installed (Claude Code on its own default model when the orchestrator is Codex),
  so it can disagree with it; the Team page and the doctor's `advisor.independent` say whether it does. It reads more of
  the project (the current milestone's plan, the end of DECISIONS.md, the last rounds, the end of hub.log, the hub's own
  verify of recent tasks, Today's usage) and checks the team's claims against them. **Quick** is Ask as it was: a light
  model and the short briefing, for a simple question with fewer tokens (`nextlevel ask --quick`). The composer says
  about how many tokens of project context a question sends; each answer shows its tokens, mode and model, and each
  thread its total. Its answers can draft a note, a standing rule, a reply to a team's card or something to remember:
  each is shown whole, you edit it, and only its own button sends it (**Send as note**, **Send reply to H12**,
  **Remember this**). It never approves a held change, a push or a deploy: those stay on their own cards. A team's card
  on the Notes page has **Explain**: the advisor turns it into micro-steps and drafts your reply
  (`nextlevel ask --card H12`). Its **Memory** (the panel's Memory button, at most 30 short entries of your decisions
  and preferences, kept in `~/.nextlevel/advisor/`, outside the project) changes only when you add, edit or delete an
  entry; `nextlevel ask memory [list | add --file <path> | edit M3 --file <path> | remove M3]` in your own window.

Only this PC can reach it (it listens on 127.0.0.1), and its link has a key in it: without the key it
shows nothing. `.env` values never appear on it (except in a note you wrote yourself).

### The security engineer (scans of your code)
Off until you turn it on. It finds and confirms security problems in the project's code, in a checkout of its own, and
never changes the code. Its scans run in OpenAI's Codex Security scanner, in Docker, signed in with your ChatGPT
account in a Docker volume of its own. In PowerShell, in the project's folder:
1. Docker Desktop running, with Linux containers. `nextlevel doctor` says what is missing.
2. `docker pull` of the scanner, exactly as the doctor's `security.image` row shows it (about 1.4 GB).
3. `nextlevel security login`: open the page it names in your browser and type the code it shows there.
4. Turn the role on: the Team page, or `nextlevel team set security --engine codex --daybreak on`. Without a model it
   picks the first one Daybreak Blue works on.
5. `nextlevel security scan` (or `--deep`), then `nextlevel security status` for how it goes and its findings;
   `nextlevel security stop` stops it. A 41-file scan used about 6% of a week's allowance; a larger project uses more.

Nothing starts a scan by itself, and a scan isn't a task: autopilot doesn't see it. Anything on your PC that can run
`docker` can read the scanner's sign-in (`docs/KNOWN_ISSUES.md`).

### When a check won't pass: report it, and have it fixed
If a check's steps don't fix it, nextlevel's developers get a field report, and Claude Code fixes it:

```powershell
nextlevel report codex.model     # the check's id (nextlevel doctor --json lists them); none: every failing check
nextlevel fix 12                 # the issue number the report got
```

`nextlevel report` shows the report first, exactly as it would be filed, and files it on GitHub (an
issue in nextlevel's repository, labelled `field-report`: a **public** issue, which anyone can read) only if you say yes. It holds nextlevel's own facts:
its check results, versions, the OS, paths (your home folder as `~`) and the last hub log lines. Never
project code, briefs or `.env` values; secrets are replaced with `***`. To leave something out, edit the
kept text (it says where) before you answer: what the file holds then is shown again, redacted again, and you are
asked again. Before any of that it offers the doctor's automatic fixes for those checks, and reports only what they
don't fix. After filing it offers to start the fix. A report is filed only there, in your own window, or by the
dashboard's File it under the text it showed you; never from an agent's session, and no command files a kept report
(FR-017).

`nextlevel fix <issue>` (for nextlevel's maintainers) starts a Claude Code cloud session on nextlevel's repository, from nextlevel's own
folder, once "Claude on GitHub" in the doctor is confirmed (your Claude account connected to GitHub:
without that a session can't push, FR-002). Otherwise it asks, or runs Claude Code on this PC
(`nextlevel fix 12 --local`, in a folder of its own), or shows the prompt to paste at claude.ai/code.
The cloud session starts in your window: if Claude Code asks something, answer it there; it prints the
session's link and ends. The session opens a draft pull request and marks it ready for review at the end, which
runs the Windows tests; merge it once its `ubuntu` and `windows` checks are green (merging it closes the issue: an issue closed by hand, even as completed, has no fix to install). Then nextlevel
tells you (and your phone) that the fix is merged; it comes with the next release, which you are told of too, and
nothing installs it by itself (FR-017). Once you updated to that release, nextlevel runs the check again and tells
your phone. `nextlevel fix` alone shows how the fixes are doing.
On the dashboard, a failing check has a **Report and fix** button that files the report and gives the
`nextlevel fix` command for PowerShell (Claude Code starts a cloud session only in a terminal, FR-006).

## What a project gets
- `nextlevel.json` — the team's settings (below). Commit it.
- `.env` — secrets only (`NTFY_TOPIC`, the project's own keys). Never committed; workers never see it.
- `.nextlevel/` — the hub's runtime state (gitignored).

## nextlevel.json
Created by `nextlevel init` with these defaults:

| Setting | Default | Meaning |
|---|---|---|
| `name` | folder name | shown in notifications and window titles; slot compose names are `<name>_w<n>` |
| `baseBranch` | `main` | the branch tasks start from and `push` pushes |
| `roles.orchestrator` | `{ "engine": "codex", "model": "" }` | who plans and reviews: an engine (`codex`, `agy` or `claude`) and a model, or `"profile": "<name>"` |
| `roles.worker` | `{ "engine": "agy", "model": "", "fallback": "codex" }` | who builds tasks, the same way |
| `roles.<role>.effort` | `""` | the reasoning effort (`low`, `medium`, `high`...; `""`: the engine's own). Codex gets it in `codex exec` only (its interactive window keeps Codex's own); Antigravity never (the level is in its model's name) |
| `roles.guide` | `{ "engine": "" }` | the setup guide: no engine means the orchestrator's; or an engine, model and effort of its own |
| `roles.assistant` | `{ "engine": "" }` | the advisor (Ask): no engine means automatic: Advise on the first of Claude Code or Codex that isn't the orchestrator's engine and is installed, on its own default model (else the orchestrator's engine), and Quick on a light model on the first of Claude Code (haiku) or Codex (its smallest listed model, low effort) the roles use; or `claude`, `codex` or, after its lock test, `agy` with a model and effort of its own (Quick then uses that engine's light model) |
| `roles.security` | `{ "engine": "", "daybreak": false }` | the security engineer: off with no engine; `codex` with a model, effort, profile and `daybreak` (OpenAI's Daybreak Blue, on the models it covers). Its scans run in OpenAI's Codex Security container, never with your own Codex (`docs/design/security-engineer.md`) |
| `security.scanMinutes`, `security.deepScanMinutes` | `90`, `240` | a scan's and a deep scan's time limit (5–1440 minutes) |
| `roles.<role>.fallback` | `codex` for workers, none for the orchestrator | a profile or engine the role falls back to (below), or `{ "engine", "model", "effort" }` of its own |
| `roles.worker.second` | none | a second worker in the same slots: `{ "engine", "model", "effort", "takes" }` or `{ "profile", "takes" }`; `takes` is `no-docker`, `any` or `asked` (only when the spec asks). A task reaches it with `--profile second` or a spec's `Profile: second` line. The Team page sets it |
| `profiles.<name>` | none | `{ "engine": "codex", "account": "work", "model": "", "effort": "" }`: an engine, the account it's signed into, a model and effort |
| `engines.<name>.args` | see the file | extra CLI arguments for that engine, for every profile of it (for Codex, no `-c`: it keeps Codex off its shared background server) |
| `engines.<name>.workerArgs` | not set | the arguments every worker task on that engine gets instead of `args` (not set: `args`; `[]`: none). The Team page's "Codex workers" switch (`nextlevel team sandbox on` or `off`) sets Codex's; the orchestrator keeps `args` |
| `workers.slots` | `2` | tasks that run at the same time (1–6); each slot's `NEXTLEVEL_PORT_OFFSET` is unique on the PC |
| `workers.taskTimeoutMin` / `killGraceMin` | `60` / `5` | a worker's time limit, and the grace before it's stopped |
| `workers.window` | `hidden` | how a worker shows on Windows: `hidden` (no window; Antigravity gets a real console with no window, or a window of its own on a PC where that doesn't start: Show activity says so), `minimized` or `visible` (a window of its own, which Windows gives the focus) |
| `workers.addons` | `{ "mcpServers": [], "skills": false, "hooks": false }` | which of your own add-ons in an engine's global config workers still get: MCP servers by name, your skills (with plugins; on Antigravity also your global rules) and hooks. None by default (FR-013); `nextlevel doctor` (`workers.addons`) says what each engine still lets through |
| `checks.timeoutMin` | `30` | time limit for `verify` commands |
| `protected.add` / `protected.remove` | `[]` / `[]` | paths to protect beyond the built-in ones (below), or built-in ones not to protect in this project: a file, or a folder ending in `/` |
| `hub.autopilot` / `hub.reportHour` | `false` / `20` | autopilot at start; hour of the daily report |
| `hub.rounds` | `{ "brake": 3, "fuse": 6, "wakeMinMinutes": 5 }` | when autopilot starts a round (FR-019): only for something that happened. Your actions and a task's end always start one; a check, push or merge ending, a wake-up the orchestrator asked for, the round after work moved and a cut-off round's retry only while fewer than `brake` rounds have started since work last moved; `fuse` rounds in a row with nothing real turn autopilot off; a wake-up waits as long as asked, and at least `wakeMinMinutes` doubled for each round in a row with nothing real |
| `notifications.server` | `https://ntfy.sh` | ntfy server (the topic is a secret: `.env`) |
| `paths.*` | `docs/tasks`, `docs/STATUS.md`, `docs/HANDOFF.md`, `docs/OWNER_NOTES.md`, `docs/agents/*.md` | where tasks, status, the handoff list and owner notes (both written from their cards) and role docs live |

An empty `model` means the model picked inside that tool (`/model`), and an empty `effort` its own effort;
the Team page and `nextlevel team` show which ones those are. The Team page (or `nextlevel team set`)
changes a role for you, after checking it.

### Protected files
Some files steer the agents and your own tools outside any sandbox: `.claude/`, `.codex/`, `.gemini/`, `.agents/`,
`.vscode/`, `.github/`, `.husky/`, `.mcp.json`, `.npmrc`, `AGENTS.md`, `AGENTS.override.md`, `CLAUDE.md`, `GEMINI.md` and `SECURITY.md` (in any folder),
`docs/agents/`, `nextlevel.json` and `START.cmd`. A hook or an MCP server added there runs the next time a tool
opens the project. So they change only with your approval: the hub holds a task's merge or an orchestrator commit
that changes one, and sets back a change made on disk while the orchestrator works. You get a card on the dashboard
(Notes and handoffs, and on Home under Needs you) with what the change does in plain words, read from it by
nextlevel (the commands a hook, an MCP server or a workflow would run), and the exact diff: **Approve** puts exactly
that change in, **Reject** leaves it out (a task goes back to the orchestrator with your reason). Only the dashboard
decides; your phone just tells you there is one. Your own changes (the Team page, the doctor's fixes, `nextlevel
init`) are never held. A file you edit by hand is, when the orchestrator commits it or when you edit it while the
orchestrator works, since nextlevel can't tell who typed it: approve it on its card. A task that owns a protected path isn't dispatched. The same cards hold a commit or merge with your **`.env`**, or a
value from it (never committed unless you say the value may be; a `.env` file never; the card hides the value), and
a change to **git's own hooks and settings** that nextlevel didn't make (they run programs and decide where pushes go):
that one stops all git work until you decide. `docs/KNOWN_ISSUES.md` says what the guard doesn't cover yet.

### Engines, profiles and second accounts
Any engine can take any role: Codex, the Antigravity CLI (`agy`) or Claude Code (`claude`). A role names
an engine (with the account that CLI is signed into) or a **profile**: an engine, an account and a model.
The same engine can appear twice with different logins, for example a second Codex account of yours for
the workers:

```json
"roles": {
  "orchestrator": { "engine": "codex", "model": "" },
  "worker": { "profile": "codex-two", "fallback": "agy" }
},
"profiles": { "codex-two": { "engine": "codex", "account": "two", "model": "" } }
```

A profile's `account` gets a folder of its own for that CLI (`%USERPROFILE%\.nextlevel\accounts\codex\two`),
so its sign-in stays apart from your first one. Sign it in once, in PowerShell in the project folder:
`nextlevel login codex-two` (the CLI's own login opens; for a second ChatGPT account, open the link it
prints in a private browser window). `nextlevel login` alone shows how each profile is signed in.
Codex (`CODEX_HOME`) and Claude Code (`CLAUDE_CONFIG_DIR`) can do this; **the Antigravity CLI can't**: it
has no setting for where it keeps its sign-in, so the doctor says so and nothing starts on an agy profile
with an account. nextlevel never reads or copies a sign-in, and every account must be your own, used
within its provider's terms.

A **fallback** is for a setup that isn't ready, not for usage limits: the orchestrator sends a failed
task to the workers' fallback (`nextlevel retry <id> --fallback --feedback "..."`), a task on the workers
goes to their fallback when the workers' engine can't start (not installed, its account, its model
rejected), and when the orchestrator's own engine isn't ready, `nextlevel orchestrator --fallback` starts
it on its fallback, and autopilot runs there and tells your phone. Each job records why it ran on its
engine (`nextlevel result <id>` says it).

A worker on **Codex** can't write git in its slot (its sandbox keeps the slot's git folder read-only), so
the hub does it: before a retry it merges the base branch into the task branch (for any engine when the
feedback asks for it) and hands the worker the conflicts to resolve, and when the worker finishes it
commits what it left, with the message the worker put in its report. Every command is in the job's
`git.log`.

Every attempt's **report** is kept whole beside the job (`.nextlevel/jobs/<id>/RESULT.attempt-<n>.md`).
`nextlevel result <id>` shows as much as the orchestrator's engine reads of one command's output; a longer
report says so, with its length and that file, and `nextlevel result <id> --from <line>` gives the next part.
Design, research and map tasks write their result to a file under `docs/` that their spec names
(`Result file: docs/design/<id>.md`); the hub checks that it is committed with the task and not empty.

A task spec can ask
for an engine or profile with a line `Engine: claude` or `Profile: codex-two`. Environment variables still
override settings (`NEXTLEVEL_WORKER_SLOTS`, …); the old `.env` names (`CODEX_MODEL`, `AGY_MODEL`, `CODEX_ARGS`,
`AGY_ARGS`) still work, and the doctor tells you to move them.
