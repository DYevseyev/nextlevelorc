# Setup checks

`nextlevel doctor` runs these checks, in this order. Each one says what it found and, when something
is wrong, what to do and **which window to type it in**. `nextlevel doctor --fix` runs the fixes that
can be automated (in the START.cmd menu the doctor asks before each one), `--fix <id>` only that
check's; `nextlevel doctor --json` gives the results to the dashboard and changes nothing. The code is
in `src/checks/`; a test with a fake PC covers every check (`test/checks.test.mjs`).

The dashboard's Setup page (`nextlevel ui`, START.cmd -> d) shows every check with its steps, each
with its window and a Copy button. A **Fix** button appears only where the fix needs no window of the
owner's (`autoFix` in `--json`): it runs `nextlevel doctor --fix <id> --json` and shows what the fix
did. Fixes that install or update a program (every `tool.*` check: winget, `npm install -g`, the agy
installer, `agy update`) are marked `fixInWindow`: they can ask for permission, show progress and
change PATH for new windows only, so they run only from the doctor in the owner's own window, and the
page shows their commands to copy. Fixes that need the owner's answer (`git.identity`, `claude.github`)
run only in the menu's doctor. The page checks again when the owner comes back to it from another
window.

**Slow answers are kept a few minutes** (FR-010): agy's sign-in and model list (`agy models`, a few seconds
over the network) and Codex's and Claude Code's sign-in (`codex login status`, `claude auth status`). An
answer that says yes is kept for 5 minutes in `~/.nextlevel/cache/runs.json`, per program (its file and
version), arguments and account folder; one that says no is asked again next time, so a sign-in shows at
once. The page's own checks when it comes back into view use them; its **Check again** button, and
`nextlevel doctor --fresh`, ask everything again.

Severity: **error** blocks the build team (the doctor's exit code is 1), **warn** should be fixed,
**info** is good to know. The doctor marks errors and warnings `!!`, notes `i`, skipped checks `--`.

Where a step is typed: *PowerShell* (a normal window, not "Run as administrator"; *Terminal* on
Linux and macOS), *a new PowerShell window* (after installs), *Browser*, *Text editor*, *Start menu*,
*Your phone*, and *Inside Codex*, *Inside Antigravity (agy)* or *Inside Claude Code* for slash
commands such as `/model`: those are never typed into PowerShell (FR-001 #8).

Checks never show a secret: not `.env` values, not the ntfy topic, not a login in a remote's URL.

**Inside Codex's sandbox** (the orchestrator, or the setup guide on Codex) the doctor can't see the
owner's sign-ins, programs, Docker or the network (FR-004 #2). There, a failed check that looks beyond
the project shows as skipped, "can't tell inside Codex's sandbox (there: ...)", without steps; checks
that need the network (`codex.model`, `codex.version`) don't run; checks that only read the project
(marked `sandbox: 'same'` in the code) count as usual; and no fix runs but those that only write the
project's own files. The orchestrator sees the real state through the hub:
`nextlevel verify doctor -- nextlevel doctor`.

## The window

### window.sandbox
Whether the doctor runs inside Codex's sandbox: `CODEX_SANDBOX` (macOS), `CODEX_SANDBOX_NETWORK_DISABLED`
or `SBX_NONET_ACTIVE` (no network), or, when Codex ran it (`CODEX_THREAD_ID`), a project `.git` folder it
can't write (Windows' elevated sandbox sets no variable). It says what the rows marked "can't tell" mean
and how to see the real state: `nextlevel verify doctor -- nextlevel doctor` (inside Codex), or
`nextlevel doctor` in a normal PowerShell window. **warn**. From FR-004 #2. The hub (`nextlevel run`) and
the bridge test refuse to start in the sandbox.

### window.elevated
Whether this window runs as Administrator (Windows: the integrity level in `whoami /groups`, which is
the same in every language) or as root. Files and workers it starts would belong to the
administrator. **warn**; fix: open a normal PowerShell window. From FR-001 #9.

### window.folder
Whether this window's folder is a system folder (`C:\Windows`, `C:\Program Files`; `/usr`, `/etc`...).
An Administrator PowerShell starts in `C:\Windows\system32`. **warn**; fix: `cd` to the project.
From FR-001 #9.

## The project

### project.folder
The project is the git repository this window is in (its top folder), or `--project <folder>`. Run
outside a repository, the doctor still checks the tools and says which folders below are projects and
how to start one (`git init -b main`, then `nextlevel init`). Run from a subfolder, it names the top
folder. **error**. From FR-001 #1.

### project.config
`nextlevel.json` exists, is valid, and has no unknown settings. When it is missing, looks two folders
down for `nextlevel.json` or `START.cmd`: a kit unzipped into a subfolder leaves them there (FR-001 #1).
**error** (unknown settings: **warn**); fix: `nextlevel init`, or the setting it names.

### project.state
Names the project's state folder, `.nextlevel/`. **info**.

### profiles.accounts
A profile in `nextlevel.json` that names an `account` gets a folder of its own for its engine's CLI,
`~/.nextlevel/accounts/<engine>/<account>`, and every session on it runs with the variable that points the
CLI there: `CODEX_HOME` for Codex, `CLAUDE_CONFIG_DIR` for Claude Code. That keeps a second account of
yours (two Codex logins, say) apart from the first, and nextlevel never reads or copies a sign-in: you
sign each one in with `nextlevel login <profile>`. **The Antigravity CLI can't do this**: it has no setting
for where it keeps its sign-in (it is always `.gemini` in your home folder, or the system's keyring), so a
second agy account would silently be the one agy is signed in with. This row says so plainly, and the hub
starts nothing on such a profile. **error** when a role uses it, **warn** when only a fallback does; fix:
take `account` out of that profile, or put the profile on Codex or Claude Code. Quiet when no profile
names an account. From M6.

### profiles.full-access
A role whose engine runs it with no permission check acts with your full access: your sign-ins, git, gh and any deploy
tool signed in as you. It could push or deploy directly, past `nextlevel push` and your approval of a deploy branch.
**Antigravity** skips its checks to run unattended (`--dangerously-skip-permissions` in `engines.agy.args`, which its
workers and autopilot rounds need), so the default team's workers are such a role; git still refuses a push from a
worker's slot (FR-003), but a worker can undo that, and a deploy tool isn't stopped. **Codex** without its sandbox
(`danger-full-access` or `--dangerously-bypass-approvals-and-sandbox` in `engines.codex.args`, or in the workers' own
`engines.codex.workerArgs`: the Team page's "Codex workers" switch) and **Claude Code** with
`--dangerously-skip-permissions` or `bypassPermissions` in `engines.claude.args` count too. A worker is read with the
workers' own arguments (`engines.<engine>.workerArgs` when set, else `args`), every other role with `args`. The setup guide doesn't (it
gets none of the unattended arguments and asks before it runs anything), nor the assistant (its engine's read-only
mode). Nothing is refused. **warn** where you can act: a role that runs in the main checkout (the orchestrator, the setup
guide, the assistant, and their fallbacks), which is safest on Codex, whose sandbox has no network, or Claude Code,
whose rules nextlevel sets (its step: `nextlevel team set orchestrator --engine codex`). **info** where the risk is
accepted by design: workers run in slots behind the push block and need Antigravity's unattended mode; keep deploy tools
that are signed in as you off this PC user, or put them on another engine. The Team page says the same on each such
role (a warning, or a note). Quiet when no role is such. From FR-017.

### project.roles
The role docs and the task template that `nextlevel.json` points to exist (the orchestrator and the
workers are told to follow them). **warn**; fix: `nextlevel init`.

### project.role-docs
The role docs `nextlevel init` copied into the project (`paths.roles` in `nextlevel.json`) are current, and, since safe
updates, `AGENTS.md` and the task template (`docs/tasks/_TEMPLATE.md`) when they are an older template unchanged (the
one-click update refreshes those, and `START.cmd`, by itself and commits them as the owner's change).
Copies of an older nextlevel template told the orchestrator to commit and merge with git itself, which
Codex's sandbox refuses (FR-004 #1), and the setup guide to trust a doctor run inside that sandbox
(FR-004 #2). An older template, unchanged (known by its sha-256): the fix puts the current one in its
place. An orchestrator doc of the owner's own that doesn't use `nextlevel commit`/`merge`: `nextlevel
init` shows the difference and asks. The worker doc is checked too since FR-008: copies before it didn't
say that the hub merges the base branch in and commits for a worker whose sandbox can't write git (the
M6 orchestrator doc is an older template for the same reason). An orchestrator or guide doc of the owner's
own that retries a task with `--engine <name>` (a real project's orchestrator escalated to Codex that way, FR-008) instead of the
workers' fallback in `nextlevel.json` is pointed at `nextlevel init` too. Since M10 the orchestrator, worker
and guide docs before it are older templates too (the orchestrator edited `docs/OWNER_NOTES.md` and
`docs/HANDOFF.md` by hand, where it now uses `nextlevel note` and `nextlevel handoff`; the worker kept no
progress notes), and an orchestrator doc of the owner's own that names those files but not the commands is
pointed at `nextlevel init`. Since M11 the M10 orchestrator doc is an older template too (it kept no
`docs/PROJECT.md`, no plan header with Outcome, Acceptance and Try it, and no labeled blockers, which the
dashboard's Project page and Home's Blockers read), and an orchestrator doc of the owner's own that doesn't
mention `docs/PROJECT.md` is pointed at `nextlevel init`. Since the guard, the orchestrator and worker docs before
each of its two parts are older templates (they didn't name the protected files, then git's own settings and hooks).
Since FR-012 the guard's orchestrator and worker docs are older templates too: they had design tasks put their whole
result in the report (which `nextlevel result` then shortened, and the orchestrator sent the task back), kept a log of
every round in `docs/DECISIONS.md`, and let the orchestrator ask workers for remote scans (`rafter run`) that their
unpublished branches can't have. Since FR-017 the orchestrator doc of FR-015 is an older template too: it didn't say
that a verify command can't push or write to GitHub, or how CI is read through verify with the owner's read-only token
(`gh.read-token`). Since FR-016 the orchestrator doc of FR-017 is an older template too: it named no exact plan path
(`docs/plans/<milestone id or name>.md`) and no `Milestone:` line, by which the Project page finds a milestone's plan
(`project.plans`). Since FR-019 the orchestrator doc of FR-016 is an older template too: it had every autopilot round end
with a commit (a real project's rounds each committed a STATUS.md note for twelve hours while the team waited for the owner),
knew no wake-up, and didn't say what starts the next round (the owner, a task's end, and a few rounds after work
moved). Since FR-021 the orchestrator doc of FR-019 is an older template too: it had no way to close a task it won't
build (`nextlevel close`), and a real project's orchestrator closed five by writing "closed" in their specs, which the Project
page counted as planned. Since the push guard the orchestrator docs of FR-021 and FR-020 are older templates too:
they didn't say that a push of a branch that changes a protected file (a workflow, a hook, an instruction file) waits
for the owner's Approve, nor to put such a change in a task of its own. **warn**.

### project.decisions
`docs/DECISIONS.md` (`paths.decisions`) is at most about 1,000 lines. The orchestrator reads it at every start; on a
real project it grew to almost 6,000 lines, a log of every round rather than its decisions (FR-012). Past that, the check
says in plain words how to archive the older entries: move every entry but the newest (about the last 200 lines),
whole and in their order, to the end of `docs/DECISIONS-archive.md`, put a line at the top of `docs/DECISIONS.md` that
names the archive, and commit both. Its steps: a `nextlevel note add "..."` to type in PowerShell, which asks the
orchestrator to do it (it keeps that file), or the same by hand in a text editor while no autopilot round runs. No
automatic fix. The orchestrator's role doc says what belongs in the file from then on: decisions only, what was
decided and why; a round's story stays in its log (`.nextlevel/logs/orchestrator-<time>.log`), and what the next round
needs goes in `docs/STATUS.md`. **warn**. From FR-012.

### project.plans
Every milestone with tasks has a plan the dashboard's Project page can find, with its Outcome, Acceptance and Try it,
and no two plans claim one milestone. On a real project the orchestrator wrote the Walking skeleton's plan as
`docs/plans/WS-walking-skeleton.md` while the page looked only for `docs/plans/walking-skeleton.md`: it said "No plan
yet" for a milestone with 33 merged tasks and hid its Outcome, Acceptance and Try it, and nothing warned (FR-016). The
check builds the roadmap exactly as the page does (`lib/roadmap.mjs`), from the same files: the milestone table of
`docs/STATUS.md` (`paths.status`), the brief's milestones, the plans (`paths.plans`), the task specs, the hub's task
jobs, the merged `task/<id>` branches (the merge log and, since FR-021, the hub's finished merge jobs) and the
closed tasks (`.nextlevel/closed.json`, FR-021). A plan is found first by what it says: a line `Milestone: <name>` in its
header (the role doc's form), else the better of its title and its file name, each naming the milestone's id or name in
any common form (`M1`, `M1-accounts-households`, `accounts-households`, `WS-walking-skeleton`, `walking-skeleton`, `WS`). It
says, for each milestone: tasks but no plan found (naming the files in the plans folder that match no milestone, and
where the plan goes: `docs/plans/<milestone id or name>.md`, with the line `Milestone: <its name as in
docs/STATUS.md>` under its title); a plan without its Outcome, Acceptance or Try it, and which; two plans for it, and
the one the page shows (the one whose Milestone line names it). A milestone without tasks yet needs no plan: it comes
before them; nor does one whose only tasks are closed (FR-021). Its steps: the dashboard's Project page, where each milestone's card says the same, and, when the words
are plain, a `nextlevel note add "..."` to type in PowerShell that asks the orchestrator to fix them (it keeps the
plans). No automatic fix. Quiet when all is well. **warn**. From FR-016.

### project.deploy-branches
Which branches on origin deploy: `deployBranches` in `nextlevel.json`, a list of plain branch names such as `["main"]`
(`[]` if none does). A push to one of them is not pushed by `nextlevel push`: the hub makes a card on the dashboard with
the branch, how many commits would go out and since when, and the newest commit's message, and only the owner's
Approve there pushes it, exactly that commit (FR-015: on a real project a push to main deployed production). Until a project
sets the list, its base branch counts as one; the check says so, with how to name them, and `--fix` writes
`"deployBranches": ["<base branch>"]` into `nextlevel.json` (a new project gets that line from `nextlevel init`). The
list is the owner's because `nextlevel.json` is protected: a change the team makes waits for the owner's approval, and
until one is committed the hub counts the branches of both versions. `[]`, once committed, is no deploy branch at all
(before FR-017 the hub still counted the base branch). A `nextlevel.json` taken out of the protected list
(`"protected": { "remove": [...] }`) fails as a **warn**; a list that isn't set, as **info**. From FR-015.

### project.gitignore
The project's own `.gitignore` ignores `.env`, `.nextlevel/` and `.nextlevel-task/`, so secrets and
the hub's state never get committed. **error**; `--fix` adds the lines.

### project.env
`.env` exists. The doctor creates it from `.env.example` every time it runs (a copy of the project's
own template is always safe). **error**.

### project.env-example
`.env.example` lists the keys the project's `.env` needs. `nextlevel init` never offers to replace one the
project has changed (it differs from every template nextlevel shipped), like `BRIEF.md`. Before, init
offered the generic template in its place and a "yes" lost a real project's keys (FR-005). This check
finds that: `.env.example` is a nextlevel template now, and git has a version of the project's own before
it; `--fix` puts that version back (then commit it). To keep the template instead, change the file in any
way. **warn**. From FR-005.

### project.env-settings
`.env` holds only secrets: settings that used to live there (`NEXTLEVEL_WORKER_SLOTS`, `CODEX_MODEL`...) belong in
`nextlevel.json`. Only the names are shown. **warn**.

### notify.topic
`NTFY_TOPIC` is set and at least 16 characters (the topic works like a password). Never shown. Steps:
the ntfy app on your phone, a random name, `.env`, then `nextlevel notify --now "Test" "hello"`.
**warn**.

## Tools and sign-ins

Minimum versions, and what installs or updates each tool (`--fix` runs it; on Windows with winget):

| Tool | Minimum | Install | Update |
|---|---|---|---|
| Node.js | 22 | `winget install -e --id OpenJS.NodeJS.LTS` | same |
| Git | 2.31 (`rev-parse --path-format`) | `winget install -e --id Git.Git` | `winget upgrade -e --id Git.Git` |
| GitHub CLI | — | `winget install -e --id GitHub.cli` | `winget upgrade -e --id GitHub.cli` |
| Codex CLI | — | `npm install -g @openai/codex` | `npm install -g @openai/codex@latest` |
| Antigravity CLI | 1.2.4 (the flags the hub passes) | `irm https://antigravity.google/cli/install.ps1 \| iex` | `agy update` |
| Claude Code | — | `npm install -g @anthropic-ai/claude-code --allow-scripts=@anthropic-ai/claude-code` | same with `@latest` |

"—" means no older version has failed yet; add a minimum when a field report shows one. Installers
change PATH for windows opened afterwards, so each install or update step is followed by
`nextlevel doctor` in *a new PowerShell window* (FR-001 #4).

### tool.node
Node.js 22 or newer runs nextlevel. **error**.

### install.command
Typing `nextlevel` runs this copy of the tool: the command is found in this window, and
`nextlevel version` names this tool's folder. The installer makes it
(`%USERPROFILE%\.nextlevel\bin\nextlevel.cmd`, on your PATH); START.cmd finds the tool without it.
Missing: `--fix` makes it (`nextlevel _install`), then *a new PowerShell window* has it; on Windows
the step is the installer's one command, which repairs the install. Another copy first on PATH (an old
`npm link` of another folder): `Get-Command nextlevel -All` lists them. **warn**.

### tool.git
Git is installed and 2.31 or newer. **error**.

### git.identity
Git knows who you are (`user.name` and `user.email`, or the `GIT_AUTHOR_*` variables); on a fresh PC
the first commit fails without them. It uses `git var GIT_AUTHOR_IDENT`, which fails exactly when a
commit would. **error**; in the menu the doctor asks for both and sets them with
`git config --global`. From FR-001 #3.

### tool.gh
The GitHub CLI is installed. **error**.

### gh.auth
`gh auth status` says you are signed in. Fix: `gh auth login` in PowerShell (it opens the browser).
**error**.

### gh.read-token
Whether verify commands can read the project's repository on GitHub. `nextlevel verify` runs the orchestrator's command
without your GitHub sign-in (FR-017), so nothing it runs can write to GitHub; but inside Codex's sandbox, which has no
network, verify is the orchestrator's only way to GitHub, and it reads CI there (`gh run list`, `gh run view`). An
optional read-only token in the project's `.env`, `NEXTLEVEL_GITHUB_READ_TOKEN`, gives those reads back: a verify
command's gh gets it as `GH_TOKEN` and `GITHUB_TOKEN`, and git gets it for github.com only (a fetch or a clone of a
private repository), through a credential helper that returns nothing else. GitHub itself refuses any write made with
it, and pushes stay blocked as before. Like any `.env` value it is a secret: redacted from reports, phone messages and
what `nextlevel result` shows, and never given to a worker.
- **Not set**: **info**, with the steps. In the browser, https://github.com/settings/personal-access-tokens/new: a
  fine-grained token for the project's repository only (Repository access: Only select repositories), with Actions,
  Contents, Pull requests and Commit statuses set to Read-only (Metadata: Read-only comes with them) and nothing else,
  and an expiration date. An organization's repository may need its owner to approve it. Then a line
  `NEXTLEVEL_GITHUB_READ_TOKEN=<the token>` in the project's `.env`.
- **Set**: the doctor asks GitHub for the repository with it (never with your own sign-in). It passes with the date it
  expires on, from the `GitHub-Authentication-Token-Expiration` header GitHub sends; **warn** from 7 days before that
  date, when GitHub refuses it (expired, deleted, not for this repository), or when it is a classic token (`ghp_...`),
  which can write whatever its scopes allow.
- Quiet when the project's origin isn't on GitHub; not run inside Codex's sandbox (it asks GitHub).

GitHub doesn't give a fine-grained token the Checks permission, so `gh run view <id>` in its plain form, which reads a
run's annotations, fails with it ("failed to get annotations"); `gh run view <id> --json jobs` (the steps and their
times) and `gh run view <id> --log-failed` read the same run without them, and a verify job's log says so. From FR-017.

### install.updates
This copy of nextlevel gets releases (safe updates, `docs/design/safe-updates.md`). A release is an annotated tag
`vX.Y.Z` on main, made once the owner's check of that commit passed; each version runs from a folder of its own
(`~/.nextlevel/versions/<name>`), and the hubs and the dashboard look for releases every 6 hours
(`~/.nextlevel/update/available.json`, which this row reads; it never fetches itself).
- **A version's folder** (the normal case): passes with "the newest release" and when it was checked. A newer release:
  **info**, or **warn** when it has a safety fix, with `nextlevel update` (Update on the dashboard's Home from the
  one-click update on). Files in the version's folder changed by hand: **warn** (a version's folder is never changed;
  the installer repairs it). The last look for releases failed: **warn**. A release tag that moved or vanished on
  GitHub: **warn** (nextlevel doesn't follow it; tell its developers). The project pinned at a release: **info**, with
  `nextlevel channel release`.
- **An install from before releases** (the clone's own checkout runs): once a release is published, **warn**, with
  the installer's command, which moves it to the newest release (a pinned one too). Until then it reports as before:
  not a clone, changed files, another branch, local commits; pinned is **info** ("it stays there until the installer
  moves it to the first release"). Nothing updates at a command's start any more.
Reads files and git only.

### install.channel
What this project runs: releases (the default: quiet), a pinned release (**info**), or a candidate branch, which runs
whatever sessions push to that branch once the owner updates (**info**; **warn** when the project's autopilot is on,
since a candidate is for trying a change, as in a test project, not for a project whose work matters). Kept in
`~/.nextlevel/channels.json`, outside the project, so nothing in the project decides which code runs; only the owner
sets it (`nextlevel channel release | pin <release> | candidate <branch>`, refused in an agent's session). Skipped
before releases are installed.

### tool.files
No file the tools need is gone (FR-013: Bitdefender quarantined files of every tool in a worker's chain). It looks at
nextlevel's own files (`bin/nextlevel.mjs`, `src/cli.mjs`, `src/hub.mjs`, in the version's folder since releases) and,
on Windows, the command the installer made (`~/.nextlevel/bin/nextlevel.cmd` and the one for Git Bash), and the launcher
it runs (`~/.nextlevel/bin/launch.mjs`) once there are versions; one antivirus folder exception on
`%USERPROFILE%\.nextlevel\versions` covers every version's files; the project's `START.cmd` (Windows, once
`nextlevel.json` exists); each engine a role uses, following its launcher to what it runs (an npm `.cmd` shim's
files), and a program gone from a folder its own installer made (`%LOCALAPPDATA%\agy\bin\agy.exe`) or agy's
`agentapi.bat`; pnpm's shims in npm's folder and the programs its package names (`pnpm.exe`, `pn.exe`, ...). A missing
file of nextlevel's or of an engine a role runs on: **error**; of a fallback's, the project's `START.cmd` or pnpm's:
**warn**. The steps say it in plain words: restore it from the antivirus's quarantine, make the one narrow exception
(docs/ANTIVIRUS.md), or put it back (`git -C "<tool>" checkout -- .`, the installer, `git checkout -- START.cmd`,
`agy update`, `npm install -g pnpm`). No `--fix`: a file an antivirus took is the owner's to restore. The hub checks the
same files a worker needs before each start and pauses dispatch while they are gone.

### tool.docker
`docker info` answers: Docker Desktop is installed and its engine runs. **warn**.
steps 2 and 7.

### tool.codex
The Codex CLI is installed. **error** when a role runs on Codex (by default it is the orchestrator),
**warn** when only a fallback does (by default the workers fall back to it), else **info**. The same goes
for every row about an engine: `codex.*`, `agy.*` and `claude.login`.

### codex.version
The Codex CLI against its latest release: Codex 0.152 couldn't use the GPT-6 models the owner's account
had (FR-004 #3). The latest version comes from Codex's own update check (`~/.codex/version.json`) while
it is under three days old, else from `npm view @openai/codex version` (kept a day); when neither
answers, the row says so and passes. Older: **warn**; `--fix` runs `npm install -g @openai/codex@latest`
in the owner's own window, then *a new PowerShell window* runs the doctor. Not run inside Codex's
sandbox (no network there).

### codex.login
`codex login status` says you are signed in, for every Codex account the roles' profiles use: Codex's own
login, and each named account in its own folder (`CODEX_HOME`, see `profiles.accounts`). Fix: `codex login`
for its own login, `nextlevel login <profile>` for a named account (in PowerShell, in the project folder;
if the browser offers the other account, open the link Codex prints in a private window).

### codex.installs
More than one Codex install on PATH (npm and the desktop app) can break `codex exec`'s Windows sandbox
helper. **info**.

### codex.sandbox
When a role runs on Codex: `engines.codex.args` keep Codex sandboxed to the project (`--sandbox workspace-write`) and don't turn
the sandbox off (`danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`). The orchestrator
never needs full access: the hub commits, merges, pushes, runs Docker and sends notifications for it.
**error** (no workspace-write: **warn**).

### codex.args
`engines.codex.args` (or `CODEX_ARGS`) hold no `-c`/`--config` setting overrides: with one, Codex runs
without its shared background server and says "Running without the shared background server" at every
start (FR-004 #6). nextlevel's own defaults had `-c sandbox_workspace_write.network_access=true` until
then; the orchestrator needs no network (the hub has it). `-m` and `--sandbox` are fine. **warn**; the
fix takes the overrides out of `nextlevel.json` (keeping the rest of the file); from `CODEX_ARGS` in
`.env` the owner removes them. This is about `engines.codex.args` only, which the orchestrator, the setup guide and
autopilot rounds get. Workers have their own arguments, `engines.codex.workerArgs`, set on the Team page ("Codex
workers", or `nextlevel team sandbox on|off`): in Codex's sandbox they get its network with `-c` on their own command
line. Never put `network_access = true` in `~/.codex/config.toml`: that gives the orchestrator network too.

### codex.worker-windows
On Windows only, when the workers, the second worker or the workers' fallback run on Codex in its sandbox (the workers' own arguments,
`engines.codex.workerArgs`, else `engines.codex.args`). Codex's sandbox runs a worker's commands under accounts of its
own (on 0.160.0 the "elevated" sandbox: CodexSandboxOffline and CodexSandboxOnline), and those are refused anything
that starts Docker (a stack, compose, an integration check that needs containers) or reads
`~/.docker` (the Docker pipe and `~/.docker/config.json` are denied), and package installs (`pnpm install` fails on
its store in your AppData: "ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK ... Access is denied"). Turning the sandbox's network
on doesn't change that: measured with and without it. The first step takes Codex workers out of the sandbox, like your
other workers (`nextlevel team sandbox off`, or the Team page's "Codex workers"), then the bridge test runs again for
Codex; the others suggest a stronger model on the workers' own engine as the fallback (for Antigravity workers: a Claude
model from `nextlevel team models agy`, set with `nextlevel team set worker-fallback --engine agy --model <name>`), or
another engine for workers that are on Codex themselves. A Codex worker in the sandbox is told to use `pnpm.cmd`,
`npm.cmd` and `npx.cmd` if a `.ps1` shim is refused (it now gets PowerShell's policy for its own process, so they
run), and to report a task that needs Docker or a package install as BLOCKED. The Team page shows the same warning on
those roles. Out of the sandbox: quiet (`profiles.full-access` says it as information). The switch writes
`engines.codex.workerArgs` with the rest of `engines.codex.args` copied as it is then: a later change to `args` (a `-m`,
a `-c`) reaches Codex workers only when the owner chooses again. **warn**. From FR-009.

### codex.model
The model Codex will use works with this Codex login: each model pinned for a Codex role, profile or
fallback in `nextlevel.json` (passed with `-m`), else Codex's own, which is `model` in its `config.toml` (or, without
one, the first model the account offers). Each Codex account the profiles use is tried with its own login
and its own `config.toml`. The doctor asks Codex once with a one-line prompt (`codex
exec`, read-only, outside the project) and keeps the answer until the model, Codex or the login changes.
The hub runs the same check before it starts the orchestrator, the setup guide on Codex or an
autopilot cycle, and stops (autopilot: pauses) with the fix instead of starting a session that fails.
Fix for a pinned model: leave it empty, or copy an exact name from `/model` inside Codex. For Codex's own
(the owner's `config.toml` had one a ChatGPT login rejects, while the doctor said "Codex's own choice",
FR-004 #3): pick a name with `/model` and put it in `config.toml`, or delete the line. **error**. From
FR-001 #5 and FR-004 #3. Not run inside Codex's sandbox.

### codex.mcp
MCP servers in your Codex config (`~/.codex/config.toml`, or `$CODEX_HOME`) whose command isn't
installed. Codex warns about them on every start, which looks like a nextlevel failure but isn't.
**info**; fix: remove or fix that `[mcp_servers.<name>]` section. From FR-001 #6.

### codex.hooks
Codex hooks whose command can't run: Codex printed "Hook failed" (exit 1) around every tool call on the
owner's PC, which looks like a nextlevel failure but isn't (FR-004 #4). Hooks come from `hooks.json` and
the `[hooks]` table of `config.toml` in Codex's folder (`~/.codex`, or `$CODEX_HOME`), the project's
`.codex/` and the PC's (`/etc/codex`, `%ProgramData%\OpenAI\Codex`), and from plugins in
`~/.codex/plugins/cache/` (the newest version of each: the hooks its `.codex-plugin/plugin.json` names,
else `hooks/hooks.json`). A hook is broken when its program isn't found (on Windows also Python's
Microsoft Store placeholder), or a script it names by its full path isn't there; a variable it can't
resolve isn't reported. `[features] hooks = false` turns them all off. **warn**; fix: the file named in
the step.

### tool.agy
The Antigravity CLI is installed and 1.2.4 or newer; fix: `agy update`, then a new window. **error**
when a role uses agy, **warn** when only a fallback does, else **info**. From FR-001 #4.

### agy.login
`agy models` answers, so agy is signed in (a yes is kept a few minutes: see above). Fix: run `agy` in
PowerShell and sign in, then `/model` inside agy.

### agy.model
A model pinned for an agy role, profile or fallback is one `agy models` lists (its slug, the first column:
`gemini-3.8-flash-high`). Then the model a worker will use (each pinned one, else agy's own, picked with
`/model`) is tried as a worker runs (FR-022): built by the function that builds a worker's run
(`lib/workerspec.mjs workerRun`), so the same arguments (`engines.agy.args`, `--output-format stream-json`, never
`--effort`, and the agent a worker runs as, `--agent nextlevel-worker`, FR-013), the same agent file (written where
the trial runs), the same environment (a worker's: none of the project's `.env`, the push block, no background
updater, FR-011) and the same launch (directly, never through cmd.exe; on Windows in a console with no window, FR-010),
with a one-line prompt and a 2-minute limit, in a temp folder. The prompt asks agy to write a file with its file tool
and run `node --version`, as a worker does; its result must say SUCCESS, and its own steps must show a file written and
a command run (FR-022: after 1.3.2 an agent without a tools list got only tools that look, and a probe that only asked
for "ok" passed while every worker answered BLOCKED). The result names agy's
version and shows the whole command it ran (the prompt shortened) and its folder; when `engines.agy.args` has
`--effort`, it says that isn't passed, and why. A refusal says why in agy's own words (its result's `error`, an error
event, an `AGY_ERROR` line or its error line), with the exit code and the last lines it printed (about 20), redacted
like a report and with every string of the owner's MCP servers' settings; when agy's version changed since the model
last passed, both: "refused on agy 1.3.4 (passed on 1.3.2): ..., exit 1". The answer is kept in
`.nextlevel/check-cache.json` under a key made from that whole run and agy's version: a yes until any of it changes, a
refusal an hour (a plan or quota can change), no answer ten minutes; Check again (`doctor --fresh`) and a Team page
save try again at once. The hub reads the same answers before it starts a task on agy (and runs the trial itself when
none stands: tasks on agy wait for it). A refusal is an **error** when a role runs on agy (the Team page doesn't save
such a change): on the owner's PC agy refused `--effort` for its Claude models ("--effort is not supported for model
claude-opus-4-6-thinking") in every worker's attempt (FR-010), and agy 1.3.4 refused the worker's agent file ("unknown
agent", FR-022). No answer in 2.5 minutes is a **warn**, and so is a PC where the console with no window has no input
to give (what a worker runs isn't tried, since a trial in a window would take the focus; workers there run in a window
of their own, FR-010 #7). Not run inside Codex's sandbox (no network). From FR-001 #5, FR-010, FR-013 and FR-022.

### agy.effort
An effort for Antigravity in `nextlevel.json`: `--effort` in `engines.agy.args` (the default before FR-010),
or `effort` on a role, profile or fallback on agy. Nothing passes it any more. Antigravity takes the level from the
model's name (gemini-3.8-flash-high is high, claude-opus-5-5-medium is medium): pick the model with the level you want.
nextlevel doesn't pass --effort. So the Team page shows the level from the model's name and has no Effort field for agy.
(Older agy refused `--effort` for its Claude models, FR-010; 1.3.5 refuses it beside a model whose name has a level,
FR-022.) **info**; the fix takes the settings out of `nextlevel.json` (keeping the rest of the file); from `AGY_ARGS`
in `.env` the owner removes it. From FR-010.

### agy.deny-list
The worker safety rules (no `git push`, no `gh`, no deletes, no ssh) are in
`~/.gemini/antigravity-cli/settings.json`. This is only an extra layer: agy 1.2.11 didn't enforce it
(FR-003), so the doctor says "configured (not proof it works)" and points to the bridge test. `--fix`
adds the rules without touching your other settings (it keeps a `.nextlevel-backup`), then reads the
file back and says whether they are all there (FR-001 #10: the question came back after a "yes").
**warn**. From FR-003 #3 and FR-001 #10.

### agy.permissions
What the owner's own agy settings approve without asking, read only (nextlevel never writes `~/.gemini`): `toolPermission`
`always-proceed` in `~/.gemini/antigravity-cli/settings.json`, a global `command(*)` grant in `~/.gemini/config/config.json`
(shared with the Antigravity app), files outside the workspace allowed. With any of them agy asks nothing, even in the
setup guide, which gets none of nextlevel's flags; `profiles.full-access` and the Team page then say the guide runs
without asking. nextlevel's own blocks (the push block, the orchestrator's lock test, the guard) are what keep its roles
from pushing and from the owner's sign-ins either way. **info**, for workers too, never a warning. From the Argon roles
design (`docs/design/antigravity-roles.md`, measured on 1.4.0).

### tool.claude
Claude Code is installed and `claude --version` runs. Newer npm skips install scripts it hasn't been
told to allow, which leaves a `claude` that doesn't run: install with
`--allow-scripts=@anthropic-ai/claude-code`. Needed for `nextlevel fix`, which starts Claude Code on a
field report, and for any role on Claude Code. **error** when a role runs on it, **warn** when only a
fallback does, else **info**. From FR-001 #7.

### claude.login
When a role runs on Claude Code: `claude auth status` says you are signed in, for its own login and for
each named account (in its own folder, `CLAUDE_CONFIG_DIR`). A session on a named account gets no
`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`: those would win over the
account's own sign-in. A login that is an API key says so (billed by use, not a subscription). Fix:
`claude auth login` for its own login, `nextlevel login <profile>` for a named account. A Claude Code
without `auth status` (older than 2.1): **warn**, update it. From M6.

### claude.model
When a model is pinned for a Claude Code role, profile or fallback (the dashboard's Team page sets one):
Claude Code accepts it with this sign-in. The doctor asks Claude Code once with a one-line prompt
(`claude -p ... --model <name>`, outside the project) and keeps the answer until the model, Claude Code or
the sign-in changes. No command lists Claude Code's models: its `--model` takes `opus`, `sonnet`, `haiku`
and full model names. Nothing pinned: Claude Code's own choice (`model` in its `settings.json`, or
`/model` inside Claude Code), and nothing is run. Fix: leave the model empty, or use a name `/model`
inside Claude Code shows. `nextlevel team set` and the Team page run it before they save a change.
**error** when a role runs on Claude Code, **warn** when only a fallback or the setup guide does. From M9.
Not run inside Codex's sandbox.

### claude.github
Before `nextlevel fix` starts a Claude Code cloud session: the tool's folder has a GitHub remote
(otherwise a session gets a copy it can't push), and your Claude account is connected to GitHub
(browser: https://claude.ai/connect-github, and the Claude GitHub App installed on the repo:
https://github.com/apps/claude). This PC can't see the Claude side, so you confirm it once, in the
menu's doctor or when `nextlevel fix` asks; the answer is kept in `~/.nextlevel/state.json`. Until then
`nextlevel fix` offers Claude Code on this PC (`--local`) or the steps to start the session at
claude.ai/code instead. **info**. From FR-002.

### workers.addons
For each engine the workers (or their fallback) run on: the owner's own add-ons in its global config (MCP servers,
skills, plugins, hooks, global rules), and whether workers get them. They don't, unless `workers.addons` in
`nextlevel.json` lists them (`{ "mcpServers": ["<name>"], "skills": false, "hooks": false }`): agy runs as an agent
that inherits none of them (`inheritCustomizations: false`, `inheritMcp: false`), Codex gets each MCP server, its
plugins, hooks and apps and the owner's skills switched off for the session, Claude Code gets `--strict-mcp-config`
and `--setting-sources project,local`. What an engine can't keep out is said: agy still starts every MCP server's
process in `~/.gemini/config/mcp_config.json` (their tools stay out), so with any there: **warn**, with `agy mcp list`
and `agy mcp disable <name>` (which is for every agy session, the owner's own too) for the ones nobody needs; agy and
Claude Code can't give a worker only some of a kind (listing any gives all). Otherwise **info**. Reads the engines'
own files; nothing is copied or changed. From FR-013.

## The repository

### git.commits
The repository has a first commit (workers get their copy from it). `--fix` makes it (`git add -A`,
`git commit -m "first commit"`), but only once your git identity is set and `.gitignore` ignores `.env`.
**error**. From FR-001 #2.

### git.remote
There is an `origin` remote. Fix: `gh repo create <name> --private --source . --remote origin --push`.
**error**.

### git.pushed
`origin` has the base branch (from what this PC last fetched; no network). Fix:
`git push -u origin main`. **warn**.

### git.branch
The main checkout is on the base branch (`baseBranch` in `nextlevel.json`). **error** when the base
branch doesn't exist (no worker could start; fix `git branch -M main`), else **warn** (fix
`git switch main`).

### git.clean
Uncommitted files: workers start from the last commit, so they don't see them. **info**.

### slots.push-lock
Worker slots can't push (FR-003): the hub gives each slot push URLs that fail. A `remote.<name>.pushurl`
in the project's own git config can only be switched off for one slot from Git 2.46; with older Git the
hub refuses to start workers, and this check says so first. Fix: update Git, or
`git config --unset-all remote.<name>.pushurl`. **error**. From FR-003 #1.

### slots.ports
The port offsets this project's worker slots get (`NEXTLEVEL_PORT_OFFSET`): unique among the projects
on this PC. They were 100, 200, ... in every project, so two projects' workers started their services on
the same ports (FR-004 #7). The hub gives each project a block the first time it starts (kept in
`~/.nextlevel/state.json`, "portBlocks"): slot n of block b gets b × 1000 + n × 100, and block 0 (the
first project) keeps 100, 200, .... A block whose project folder is gone is given out again. Two
projects with the same block (a hand-edited file): **warn**, else **info**.

### guard.held
Changes to **protected files** that wait for the owner. Protected files steer the agents and the owner's tools
outside any sandbox: `.claude/`, `.codex/`, `.gemini/`, `.agents/`, `.vscode/`, `.github/`, `.husky/`, `.mcp.json`,
`.npmrc`, `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` (these in any folder), `docs/agents/`, `nextlevel.json` and
`START.cmd`; `"protected": { "add": [...], "remove": [...] }` in `nextlevel.json` changes the list. The hub holds a
merge or a commit that changes one, and sets back a change made on disk while the orchestrator works, until the owner
approves or rejects exactly that change on the dashboard (Notes and handoffs: the card has what it does in plain
words, from code, and the exact diff). The held changes are kept in `~/.nextlevel/guard/<project>/`, outside the
project, where the orchestrator's sandbox can't write. The same cards hold a commit or a merge with a **`.env`
file, or a value from `.env`** (one under 8 characters, a number or a word like true aside; the value never shown),
and a change to **git's own hooks and settings** that nextlevel didn't make (those that run a program or send a push
elsewhere, for the project and its worktrees, the slots' push lock included): that one stops all git work until the
owner decides. Nothing waiting: passes quietly, with the number of protected paths and what `nextlevel.json` adds or
removes. Something waiting: **warn**, with each change's id, who made it and its files; **error** while git work is
stopped. Its record unreadable: **info**.

### bridge.test
The bridge test's verdict for each engine workers run on: the workers' own, the second worker's and their fallback's
(one verdict per engine, `.nextlevel/bridge-tests/<engine>.json`). Two workers try a real push to a throwaway remote, and the hub
checks that nothing arrived; they also run `gh auth status`, and the test fails if gh answers as anyone (every worker
gets a gh folder with no sign-in, `GH_CONFIG_DIR`: gh otherwise lists the owner's own login beside the push block's
token, and uses it once that token is gone). It is the proof that workers can't push or act on GitHub. Each verdict is
kept with the engine's version, the workers' arguments it ran with and the version of the slots' push block it proved
(`SLOT_PUSH_BLOCK`, `src/lib/workerspec.mjs`: raised by any change to how slots refuse pushes), so a new CLI version, new
arguments (Codex workers taken out of their sandbox) or a nextlevel whose slots refuse pushes another way ask for it
again. The one-click update runs it again by itself when it passed before the update and asks again after it. `.nextlevel/bridge-test.json` stays as an older nextlevel writes
and reads it (the last run, on any engine); a record there from before the verdicts were kept per engine still counts
for its engine while that engine's workers have no arguments of their own. With one engine the row reads as before; with
two, one sentence per engine ("Antigravity workers: ...; Codex workers (the workers' fallback): ...").
Not run yet, didn't pass, or passed with an older worker CLI or other worker arguments than now: **warn**, run it
(`nextlevel run` in one window, `nextlevel bridge-test` in another, `--engine <name>` or `--profile <name>` for the
fallback's; or START.cmd -> 4, then -> 8). A worker whose gh answered as someone: **error**, as for a push that
arrived. A
bridge test that ran before nextlevel kept its verdict shows only in the hub's log: the row says it ran,
on which day, and to run it again for a saved verdict (FR-007). A push
that arrived: **error**, don't start the orchestrator or autopilot, and file a field report (the
evidence is kept). From FR-003 #1 and #2.

### lock.test
The orchestrator (or its fallback) and the assistant on Antigravity start only with a passing lock test for exactly
what they run (`.nextlevel/lock-tests/agy-assistant.json` for the assistant, whose tries push from the real project,
change things in its copy by command and by its edit tool with the real project untouched, and read the real project with
`nextlevel status`). The orchestrator's: agy's
version and program, the role's arguments (`engines.agy.args`), its model and nextlevel's agent file
(`.nextlevel/lock-tests/agy-orchestrator.json`, beside the bridge tests). Antigravity skips its own permission checks, so
the lock test proves on this PC that nextlevel's push block and agent hold: in a throwaway project of its own, the
role's own sessions try to push to a remote, to a remote with a push URL of its own and to a folder, `gh api user`, an MCP
tool, a commit of `AGENTS.md`, `nextlevel note add` and `nextlevel status`; a try counts only when agy's steps show it ran.
Passed: **pass**, with what agy's own sandbox did here. Not run, run for another version, model or arguments, failed or
incomplete: **error**, with the command (`nextlevel lock-test --engine agy --role orchestrator`, `--model` while the
orchestrator isn't on agy yet). The hub runs it by itself while autopilot is on, holding the rounds meanwhile; the
Team page and `nextlevel team set` refuse the change without a pass. Something that got through: keep the folder the
run kept and file a field report. From the Argon roles design (`docs/design/antigravity-roles.md`).

### hub.running
Whether the hub runs (START.cmd -> 4 once setup is done). **info**.

### pc.sleep
Windows only: the PC never sleeps while plugged in, so workers and the hub keep running
(`powercfg`); `--fix` runs `powercfg /change standby-timeout-ac 0`. **warn**.

## GitHub checks on this PC
A project's GitHub checks can run on a runner on this PC instead of GitHub's paid runners (the self-hosted runner,
`docs/design/self-hosted-runner.md`). The Team page's "GitHub checks" card recommends it for a personal account's private
repository whose workflows use GitHub's paid runners. These rows are what that rests on, read with your gh (GETs only)
read afresh at each doctor run (the Team page keeps its own answer 10 minutes; the doctor never uses it, so a fork setting
turned on a minute ago shows here). They show
only for a project whose origin is on GitHub, and they are information until a runner is set up (part B).

### runner.visibility
Whether the repository is one nextlevel offers it for: only a **personal account's private repository**. A public
repository is never offered (anyone's pull request could run code on this PC; GitHub's runners are free for it anyway),
nor an internal one (every member of its enterprise can see it) or an organization's (its settings sit above the
repository's: a later version). Each of those **passes**, saying it isn't offered. When gh can't answer (not signed in,
offline): **info**, "can't tell", and nothing is offered until it can.

### runner.forks
For a repository it is offered for: workflows from fork pull requests must be off ("Run workflows from fork pull
requests" in the repository's Actions settings), or a stranger's fork could run code where the checks run. On, with no
approval required, or with write tokens or secrets sent to them: **error**, and Fix turns them off with your gh (one
`PUT` of the repository's fork pull request settings, at your click: never in an agent's session). On, each needing your
approval with no write token and no secret: **warn**. Unreadable (it needs admin rights on the repository): **warn**,
with the settings page.

### runner.collaborators
For a repository it is offered for: who besides you can push. Once its checks run on this PC, anyone who can push a
workflow can run code here, as the runner's account. Others who can: **warn**, naming them, with the repository's access
page. Only you: **pass**.

## A project's own checks

A project adds checks for its own setup (hosting, email, keys) as `.mjs` files in `.nextlevel/checks/`.
That folder is the hub's state folder, which is gitignored: these checks stay on this PC, and nothing a
worker commits can add code the doctor runs. The orchestrator can write the state folder, so the guard
watches `.nextlevel/checks/` like a protected path: a change to it while the orchestrator works is set back
and waits for the owner (`guard.held`). Each file exports a check, or a list of them:

```js
// .nextlevel/checks/smtp.mjs
export default {
  id: 'acme.smtp', // "area.name", lowercase; not one of the ids above
  title: 'SMTP settings',
  severity: 'warn', // or 'error' (default), 'info'
  run(ctx) {
    const ok = !!ctx.env.SMTP_HOST; // .env is loaded; never put a value in `detail`
    return ok
      ? { ok: true, detail: 'set' }
      : { ok: false, detail: 'SMTP_HOST empty', steps: [{ window: 'editor', text: 'put the SMTP host in .env as SMTP_HOST' }] };
  },
};
```

`ctx` is what the built-in checks get (`src/checks/context.mjs`): `root`, `env`, `config`, `platform`,
`run(cmd, args)`, `git(args)`, `read(file)`, `exists(file)` and more. A file that doesn't load, or a
check that isn't valid, shows up as a failed check that says why.
