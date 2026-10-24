# GitHub checks on this PC (a self-hosted runner): design

Status: part A built (18 October, on main at 0cafd51: safe updates #42 and #43 merged); part B not started. Written
17 October against main at 9719ce6 and safe updates' two drafts, and given the reviewer's go with 20 changes and four
wording fixes, all in below. Three points were settled while building A (below, "Settled while building part A").

## The problem, in one paragraph

On 17 October GitHub stopped starting Actions jobs on the owner's account and nothing could merge. Every check of the
owner's private repositories runs on GitHub's hosted runners, which a private repository pays for by the minute
(Windows at twice Linux's rate). Self-hosted runners cost nothing today (below). The owner's PC is on most of the day
and already runs the team. So nextlevel offers to run a project's checks on the PC, and recommends it when the
repository is private and its checks use GitHub's paid runners. The risk is the point of the whole design: a runner
runs whatever a workflow says, so a runner on the owner's PC must run as an account that reaches nothing of the
owner's, must never serve a public repository, and must only be pointed at by workflows the owner approved.

## The shape, in short

- **A Windows account of its own per repository** (`nlci-<repo>`, a standard local user, created by an elevated step
  the owner confirms in Windows' own UAC prompt) runs that repository's runners. It can't read the owner's profile, so
  not the owner's gh sign-in, `~/.nextlevel`, the engines' sign-ins, the projects or the tool. A **job-started hook**
  checks that before every job, and checks the repository is still private, or the job fails before its first step.
  The hook catches a change of state (a repository turned public, a place made readable). It is not the wall: a job
  written to get around it can't be stopped by it. The account's Windows rights are the wall, and the hub's
  unregistering on GitHub is the stop.
- **Two runners per repository:** a Windows runner as a Windows service under that account, and a Linux runner in a
  **WSL2 distro of that account's own** (no Windows drives mounted, no Windows programs, its own Docker). Never the
  owner's Docker Desktop or the owner's WSL, which reach everything of the owner's.
- **Workflows point at the PC through a repository variable**, after a one-time change the owner approves at Set it up, shown
  from code before the click (and a deploy push's Approve):
  `runs-on: ${{ github.actor != 'dependabot[bot]' && vars.NEXTLEVEL_RUNS_ON_LINUX && fromJSON(vars.NEXTLEVEL_RUNS_ON_LINUX) || 'ubuntu-latest' }}`. The switch is then the variable, set with the owner's gh by the owner's click; a variable the
  hub didn't set stops the runner until the owner decides. Job names don't change, so the check names and branch
  protection don't either.
- **The hub watches:** the repository's visibility, the runners' state (`busy`, from GitHub's API), waiting checks,
  the variables. Public means the runners are deleted on GitHub first, then stopped on the PC. Offline with checks
  waiting means a Home card and one phone message, with "Start it" and "Run them on GitHub (this once, paid)".
  Nothing switches back to paid minutes by itself.
- **Two pull requests:** A, the recommendation, the visibility and Actions-settings reads, the doctor's checks that
  need no runner, and the guard's "where jobs run" line; B, the account, the runners, the switch and its watch.
- **B starts with a trial on the owner's PC** of the account, its WSL distro started without a logon, and Docker
  Engine in it: Microsoft still lists WSL from session 0 as a known issue. If the trial fails, B ships the Windows
  runner only.

---

## What the code has (checked against main at 9719ce6 and the safe-updates branches; again at 0cafd51)

The reviewer's reading, confirmed, with what differs. **Again at 0cafd51** (18 October, before part A): safe updates is
merged (#42, #43): the tool updates only to releases (annotated `vX.Y.Z` tags, `src/lib/releases.mjs`; none yet), each
version in `~/.nextlevel/versions/<name>` through the launcher (`src/launch.mjs`), the hubs and the dashboard start
`nextlevel _releases` every 6 hours, the one click is `src/updater.mjs` with its hold (`update/hold.json`, `holdFor`),
the run registry (`src/lib/runreg.mjs`) and `.nextlevel/format.json` (format 1). Part A's one new PC-wide file,
`~/.nextlevel/cache/repos.json`, follows "Two versions on one PC": a key never changes its meaning, written under its lock
(`src/lib/filelock.mjs`); it only adds, so the format stays 1. The slot watch and the main-checkout guard (#45): every
guard card builds its text with `describeChanges` (a push's, a merge's, the orchestrator's commit's, a change on disk),
so the `where jobs run:` lines show on all of them. #44 (CRLF task specs): nothing here. Lines that moved: app.js 1344
and 1369 are 1419 and 1444; hub.mjs 6787-6789 is 7045-7047, `deployBranchesNow` 3351, `pushBranch` 3431,
`pushProtected` 3589, `holdPush` 3709; hub.test.mjs:396 is 429. The rest stands as below.

- **Team page:** `renderTeam` in `src/ui/app.js` draws `teamCard`s and the setting cards `windowCard` and
  `codexWorkersCard` (app.js:1344, 1369) from `dashboardState()` in `src/hub.mjs` (hub.mjs:6787-6789: `teamView`,
  `windowView`, `codexWorkersView`). The setting cards' runs (`teamWindow`, `teamSandbox`) are in `src/dashboard.mjs`
  through `runTool`. A new card's data goes into `dashboardState()`, its action into `dashboard.mjs`.
- **The owner's switch pattern:** `setSandbox` in `src/team.mjs` (refuses through `agentSession`/`ownerOnly`, checks
  with `loadConfig`, writes, `recordOwner`). The runner's switch follows it, but writes no `nextlevel.json` (below).
- **The repository:** nothing reads its visibility, Actions settings, runners or protection. `git.remote` knows the
  origin URL. GitHub reads go through the owner's gh (`gh.auth`); the read-only token (`src/lib/github.mjs`) is for
  verify commands only and stays so.
- **The guard:** `.github/` is protected (`BUILT_IN`, `src/lib/protect.mjs`). `workflowParts`/`workflow`
  (protect.mjs:263-306) say what a workflow would run, the actions and the triggers (labelled `runs on:`, line 306);
  `runs-on` isn't read. Every push is read for protected files against origin's base (`pushProtected`,
  hub.mjs:3455), a deploy push waits for Approve (`pushBranch` hub.mjs:3297, `holdPush` 3575, `deployBranchesNow`
  3217).
- **The checks' names:** nextlevel's `ubuntu` (ci.yml, job `ubuntu`, `name: ubuntu`) also posts the `windows` check
  itself when no Windows run is needed (`checks: write`, `.github/ci/changes.mjs`); `windows` (windows.yml,
  `ready_for_review` and `workflow_dispatch`). Main's protection requires both from app 15368.
- **Power:** `pc.sleep` reads `powercfg` (`src/checks/system.mjs:89`).
- **Safe updates (#42, #43):** versions in `~/.nextlevel/versions/<name>`, the launcher `~/.nextlevel/bin/launch.mjs`,
  PC-wide files with a key that never changes meaning and `protocol: 1`, the one click that holds, waits for what
  runs, stops and restarts hubs and dashboards, with a run registry. Nothing else nextlevel leaves running today: the
  runner is the first long-lived thing that isn't a hub, a dashboard or their children (point 9).

---

## GitHub's documentation this relies on (read 17 October)

- **Security:** self-hosted runners "should almost never be used for public repositories"; for private ones, be
  cautious: anyone who can push or open a pull request whose workflow runs can compromise the runner, its secrets and
  `GITHUB_TOKEN`. Self-hosted runners have no clean machine per job and "can be persistently compromised".
  https://docs.github.com/en/actions/reference/security/secure-use,
  https://docs.github.com/en/actions/concepts/runners/self-hosted-runners
- **Fork pull requests (private repositories):** four settings, read and written at
  `GET|PUT /repos/{owner}/{repo}/actions/permissions/fork-pr-workflows-private-repos`
  (`run_workflows_from_fork_pull_requests`, `send_write_tokens_to_workflows`, `send_secrets_and_variables`,
  `require_approval_for_fork_pr_workflows`). https://docs.github.com/en/rest/actions/permissions,
  https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/enabling-features-for-your-repository/managing-github-actions-settings-for-a-repository
  (Both of the owner's repositories answer all four `false` today; read with GETs.)
- **Ephemeral and JIT runners:** `--ephemeral` takes one job and deregisters; `POST .../actions/runners/generate-jitconfig`
  makes a one-job runner (`name`, `runner_group_id`, `labels`). The docs warn there is "no way to guarantee" a runner
  runs one job only. https://docs.github.com/en/actions/reference/runners/self-hosted-runners,
  https://docs.github.com/en/rest/actions/self-hosted-runners
- **Runner groups:** organizations (Team plan) and enterprises only; a personal account's repository has its runners
  per repository. https://docs.github.com/en/actions/concepts/runners/runner-groups
- **Updates:** on by default (when a job is assigned, or within a week of a release); with `--disableupdate` a version
  must be installed within 30 days or GitHub queues no jobs to it; a critical security update blocks queuing until
  installed. https://docs.github.com/en/actions/reference/runners/self-hosted-runners
- **Job hooks:** `ACTIONS_RUNNER_HOOK_JOB_STARTED` / `_COMPLETED`, absolute paths in the runner's `.env` or the operating system's
  environment (the docs allow either); scripts live
  outside the runner's folder, run as the runner's account, no timeout; a started hook that exits non-zero fails the
  job before its steps. What a failing completed hook does isn't documented (so it must not matter here).
  https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/run-scripts
- **Labels:** `self-hosted`, the OS, the reviewerure, plus custom ones; a `runs-on` array needs all of them.
  https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/use-in-a-workflow
- **Waiting:** "A job can be in the queue for 24 hours before it is automatically cancelled"; a job may run 5 days on a
  self-hosted runner; a run 35 days. https://docs.github.com/en/actions/reference/limits
- **Removal:** a runner that hasn't connected for more than 14 days is removed by GitHub (ephemeral: 1 day).
  https://docs.github.com/en/actions/how-tos/manage-runners/self-hosted-runners/remove-runners
- **Re-runs:** use "the same `GITHUB_SHA` ... and `GITHUB_REF`" and the original actor's privileges; the docs don't
  say whether `vars` (and so `runs-on`) are read again, or whether rerun-failed-jobs includes cancelled jobs. B's
  Owner check finds out on real GitHub; the stub `gh` plays what it found.
  https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
- **WSL without a logon:** Store WSL's release notes still list "Launching Windows Subsystem for Linux from session
  zero does not currently work"; microsoft/WSL#9231 says `C:\Program Files\WSL\wsl.exe` works in session 0 since
  2.0.0; #7365 reports a distro started at boot breaking `\\wsl.localhost` and interop after a later logon.
  https://learn.microsoft.com/en-us/windows/wsl/store-release-notes, https://github.com/microsoft/WSL/issues/9231,
  https://github.com/microsoft/WSL/issues/7365
- **Price:** "usage is free for self-hosted runners"
  (https://docs.github.com/en/billing/concepts/product-billing/github-actions). The $0.002 a minute platform charge
  announced for self-hosted minutes in private repositories from 1 March 2026 was postponed with no new date
  (https://github.blog/changelog/2025-12-16-coming-soon-simpler-pricing-and-a-better-experience-for-github-actions/,
  https://github.com/resources/insights/2026-pricing-changes-for-github-actions). So the card says "free today" and
  the README says it may change.
- **A billing lock:** the docs don't say whether a blocked account's self-hosted jobs run; community reports say they
  stayed at "Waiting for a runner". So this design does **not** promise that a runner on the PC gets past a lock like
  17 October's. It saves the minutes that lead to one; Owner check step 6 asks the owner to note it if it happens.
- **Registration:** `POST .../actions/runners/registration-token` and `.../remove-token` (repository admin, an hour
  each); `DELETE .../actions/runners/{id}`; `GET .../actions/runners` (`status`, `busy`, `labels`, `version`).
- **`container:` and `services:`** need a Linux runner with Docker.
  https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax
- **The runner's releases:** `actions/runner` releases list each file's SHA-256 in their notes; files are
  `actions-runner-<os>-<arch>-<version>.<zip|tar.gz>`. https://github.com/actions/runner/releases
- **Visibility:** `GET /repos/{owner}/{repo}` gives `private`, `visibility`, `owner.type`; webhooks have `publicized`,
  but a PC can't receive a webhook, and no workflow trigger exists for it.

---

## 1. When it's offered and recommended

### Visibility and owner

- **Read:** `gh api repos/{owner}/{repo}` with the owner's gh: `visibility`, `private`, `owner.type`,
  `permissions.admin`. `{owner}/{repo}` from origin's URL (github.com only; another host isn't offered, it says so).
- **Fresh enough:** for the card, 10 minutes (kept in `~/.nextlevel/cache/`). For the switch: read again at the click.
  For a job: read by the job-started hook before every job (below), which is the gate that matters.
- **gh can't answer** (not signed in, offline, rate limit): the card says "nextlevel can't tell whether this
  repository is private: <gh's words>" and offers nothing. A runner already set up keeps going only while the hook's
  own check passes (below). Never "probably private".
- **Personal or organization:** `owner.type`. A personal account's repository: per-repository runners, no runner
  groups (GitHub's docs), the owner is the only admin. **An organization's repository isn't offered** (settled while
  building A): its fork settings and its runner policy sit above the repository's (an organization's setting off can't
  be turned on for the repository), and an anonymous read can't tell its internal repositories from private ones. It
  waits for a later pull request. Runner groups are not used (`runner_group_id` is the default group, read from the
  runner's registration, not assumed to be 1). Both of the owner's repositories are personal (`owner.type: User`).

### Never for a public or internal repository

- **Not offered:** the card for a public or internal repository says "GitHub's runners are free for a public
  repository, and anyone's pull request could run code on this PC: nextlevel doesn't offer it". Internal (an
  enterprise's) is refused the same way: every member of the enterprise can see it.
- **Refused by the command:** `nextlevel team runner on` reads visibility itself at that moment and refuses anything
  but `private`.
- **A repository that turns public, before its next job:** two layers:
  1. **The job-started hook**, before every job, asks GitHub **without signing in** for `GET /repositories/{id}` (the
     id recorded at setup, compared with the job's `GITHUB_REPOSITORY_ID` when the hook has it; `/repos/{owner}/{repo}`,
     never following a 301, if that endpoint stops answering). Only a 404 means private (GitHub answers 404 to an
     anonymous read of a private repository); a 200 means public and fails the job before its first step; anything
     else (301, 403, 429, a network error, HTML from a proxy) is unknown. Unknown on the Windows runner: the hook reads
     the hub's last verdict (`verdict\visibility.json`, written by the hub with the owner's gh into a folder the
     account can read but not write) and passes only if it says `private` and is under 15 minutes old. Unknown on the
     Linux runner: the job fails ("nextlevel couldn't check that the repository is still private"), since the distro
     sees no Windows files. A 404 doesn't tell an internal repository from a private one, so this is offered only for
     a personal account's repositories (`owner.type: User`). A change of visibility can take up to about a minute to
     reach anonymous reads. The hook needs no sign-in, so the runner's account has none.
  2. **The hub**, every 5 minutes while a runner is set up (and at each start), reads visibility with the owner's gh.
     Public or internal → it deletes the runners on GitHub first (`DELETE .../runners/{id}`: GitHub assigns
     them nothing more, whatever the PC's copy does), then stops them on the PC (the service; the scheduled task, whose
     rights the owner was given at setup), sets the variables back to GitHub's runners, phone (high) and Home: "<repo> became
     public: nextlevel took its runner off this PC". The account and files are removed at the owner's next click (an
     elevated step).

  The hook holds against a repository that changed; it can't hold against a job written to get around it (the
  runner's folder is the account's, so it can update itself; in the distro, jobs have root). The repository's own
  collaborators could write such a job, and they have write access anyway. A stranger can reach the runner only after
  the repository turns public, and their first job meets an intact hook.
- Why not only the hub: the hub may be stopped, and a job can arrive in the minutes between polls. Why not ephemeral
  runners minted by the hub per job (it would check visibility before each one): weighed in point 2.

### When it's recommended, and the card's words

Recommended when the repository is **private** and **a workflow has a job on GitHub's paid runners** (a `runs-on` naming
`ubuntu-*`, `windows-*`, `macos-*` or a larger runner, read from `.github/workflows/*.yml` on the base branch with
`workflowJobs`, below). Offered, not recommended, when private with no such job. Card, "GitHub checks":

> **Where they run:** on GitHub's runners (paid: this repository is private). **Recommended: run them on this PC.**
> They'd cost nothing (GitHub doesn't charge for runners on your own machines today). This PC does the work: a check
> takes CPU and memory while your team works, and waits while the PC is off or asleep (GitHub cancels a check that
> waits 24 hours). Jobs run under a Windows account of their own that can't see your files or sign-ins. Last 30 days:
> 412 minutes on GitHub's runners (Linux 290, Windows 122). [Set it up] [Not now]

The minutes come from `GET /repos/{owner}/{repo}/actions/runs` and each run's jobs (`started_at`, `completed_at`,
`runner_name`, labels), summed per OS; no money figure (the owner's plan and included minutes aren't readable without
billing scopes), so it says minutes, and "Windows minutes count twice". macOS jobs are never moved (the PC isn't one).

---

## 2. Who the runner runs as, and what it can reach

### Weighed

1. **A Windows service as a dedicated standard local user (chosen, for the Windows runner).** The owner's profile
   (`C:\Users\<owner>`) grants only the owner, SYSTEM and Administrators; a standard user is none of them. That covers
   the gh sign-in (`%APPDATA%\GitHub CLI`, and the Windows credential manager, which is per user), `~/.nextlevel`,
   `~/.codex`, `~/.claude`, agy's folder, the projects under the profile and the tool (in `~/.nextlevel` or wherever
   `NEXTLEVEL_DIR` put it). What it doesn't cover by itself: a folder **outside** the profile. `C:\` grants
   Authenticated Users modify on new folders, so a project in `C:\dev\x` or a tool in `C:\tools\nextlevel` is readable
   and writable by every local user. So the account isn't trusted to be walled off: the hook checks it (below), and
   the setup tightens what it finds (an ACL that removes Authenticated Users and Users from a nextlevel project or the
   tool's folder, shown and done only with the owner's yes, in the same elevated step).
   The setup also scans once, with the owner's yes, one level under each fixed drive's root and `C:\`'s other
   folders, for folders the account can read that hold `.git` or `.env`, and offers the same tightening.
2. **The owner's Docker Desktop, a container per job.** Rejected: a real project's jobs use Docker themselves, which needs the
   Docker socket in the container, and Docker Desktop's VM shares `C:\Users` with the owner's rights: `docker run -v
   /run/desktop/mnt/host/c/Users/<owner>:/x` reads everything. Docker-in-Docker is privileged in the same VM: the same.
   And `docker-users` membership is owner-equivalent on Docker Desktop.
3. **The owner's WSL.** Rejected: a distro runs with the Windows user who started it; `/mnt/c` and Windows programs
   (interop) act as the owner.
4. **A WSL2 distro of the runner's own account (chosen, for the Linux runner).** WSL is per Windows user: the account's
   distro runs in its own VM with its own rights. Its `/etc/wsl.conf` turns off `automount` and `interop`, and the
   account's `.wslconfig` sets `localhostForwarding=false` (its ports never appear on the PC's localhost, so
   they can't meet the slots'), a memory cap and a processor cap (half the cores). In NAT mode a job can still reach a
   Windows service bound to 0.0.0.0 through the host's address. Root in the distro (a real project's Playwright installs system packages with sudo, as on
   GitHub's images) can mount the C: drive again, but only with the runner account's Windows rights: the same wall as
   the Windows runner. Docker Engine runs inside the distro, not Docker Desktop. **Risk:** Microsoft still lists WSL from session zero as not working; since WSL 2.0.0,
   `C:\Program Files\WSL\wsl.exe` is reported to work there. So B starts with a trial on the owner's PC: the account
   with "Log on as a batch job"; the distro imported through a one-off scheduled task run as the account (`runas` can't:
   "Deny log on locally" refuses its logon); the runner started at boot by a scheduled task through
   `C:\Program Files\WSL\wsl.exe`, with "Stop the task if it runs longer than" off (its default is 3 days); Docker
   Engine with `[boot] systemd=true`; `docker run hello-world`, a 30-minute idle soak, a reboot, and the owner's own WSL
   after they log on. If it fails, Linux jobs stay on GitHub's runners and the card says why: never a fallback to
   options 2 or 3.
5. **A Hyper-V VM.** The strongest wall, rejected for now: Windows Home has no Hyper-V manager, a VM image is a big
   download nextlevel would have to keep updated, and it doubles the work the PC does. The account's walls, checked per
   job, are enough for the owner's own private repositories.
6. **Ephemeral or JIT runners against long-lived ones.** Weighed: a JIT runner per job, minted by the hub with the
   owner's gh, would check visibility before each job and start each job in a clean work folder. But it needs the hub
   running for every check (a check would wait while the owner has no hub up), something privileged has to start a
   process as the runner's account per job (a stored password or a scheduled task per job), and GitHub says even
   ephemeral runners can't be guaranteed one job. Chosen: **long-lived runners** under the walled account, with the
   job-started hook doing what ephemeral would have bought (the visibility gate, the wall's proof) and the
   job-completed hook emptying the work folder (`_work`, keeping `_tool`, the actions' tool cache). JIT is the upgrade
   if a persistent compromise of the account ever matters more; the hook and the account carry over.
7. **FR-017 part 2B's wall.** Part 2B walls the *agents* off as another Windows user (or WSL, or a container); this
   walls *CI jobs* off. They differ in what the account may reach (agents need the project; a job must not), so they
   are different accounts. They share the mechanism, which this builds and 2B reuses: `src/lib/winuser.mjs` (create a
   standard local user in one elevated step, give it "log on as a service", set its folders' ACLs, remove it), and
   `src/lib/walls.mjs` (the list of the owner's places and a probe that tries each one). Nothing here waits for 2B.

### One account per repository

`nlci-<repo>` (truncated to Windows' 20 characters, with a short hash when two would clash). Why not one for every
repository: a job of nextlevel's CI could then read or tamper with a real project's runner and the secrets its jobs hold in
flight. One account per repository keeps one repository's jobs from another's. Cost: one WSL VM per repository with a
Linux runner (each capped, 4 GB by default, `runner.memory`).

The account: standard user, random 32-character password that nextlevel generates, hands to the service and the
scheduled task once (Windows keeps it in LSA), and never writes anywhere; "Deny log on locally" and "Deny log on through
Remote Desktop" (so it's only ever a service and a batch job: it is given "Log on as a service" for the Windows runner
and "Log on as a batch job" for the Linux runner's scheduled task, which standard users don't have by default); not in Administrators, Users-plus groups, `docker-users`, Remote Desktop
Users or Hyper-V Administrators. Repair resets the password (elevated) and registers again.

### What a job can reach, and what it still can

**Can't** (the account's Windows rights; the hook checks each before every job, and the setup before the first): the owner's gh sign-in (its config
folder; and `gh auth status` run as the account says "not logged in"), the owner's `~/.nextlevel` (state.json, the
guard's records, accounts, versions), the engines' sign-ins (`~/.codex`, `~/.claude` and `CLAUDE_CONFIG_DIR`s from the
profiles, agy's folder), every known project's folder and its `.env` (from state.json's projects), the tool's folder
and its versions, the other repositories' runner folders. The list (`walls.json`) is written by nextlevel's elevated step
into the hooks folder, which only Administrators write and the account reads; the Linux runner gets a copy inside its
distro at setup.

**Can:** the network (anything the PC reaches: the LAN; the PC's own services on 127.0.0.1 for the Windows runner,
and those bound to 0.0.0.0 for both: a slot's dev server, a container's published port, often with a development
password; the dashboard is on 127.0.0.1 with a key; Docker Desktop's API is a named pipe the account isn't granted);
machine-wide environment variables and the rest of HKLM; its own profile and work folder; the job's `GITHUB_TOKEN`
(read-only by default on a personal repository, plus what the workflow asks for: nextlevel's ci.yml asks
`actions: write`, `checks: write`); the repository's secrets that the workflow names; CPU, memory and disk. The walls
probe also fails the job on a machine-wide variable that looks like a secret (named, never shown) and on a Docker
daemon answering on 127.0.0.1:2375 or 2376 (Docker Desktop's "Expose daemon": root over the owner's files), and lists
the owner's listening ports as information on the card. What that means: a job on the PC holds what it would hold
on GitHub; the PC adds the LAN, the PC's services and persistence between jobs within the account. So **jobs with
an environment or a secret stay on GitHub by default** (a real project's release job, below): the card lists each job and
its secrets, and the owner may move one, with that said. **Bots' pull requests stay on GitHub** too: the expression
sends `dependabot[bot]`'s runs to GitHub's runner (point 4), and `runner.collaborators` names any other app.

### The proof, in a test

`walls.mjs` takes a list of places and a reader, and returns each place with readable or not. In the tests (Linux and
Windows CI), a home folder of their own holds stand-ins (a gh `hosts.yml`, `.nextlevel/state.json`, `.codex/auth.json`,
a project's `.env`, a tool folder), and the stub runner runs the real hook before its job. Two halves:
- **The account can't read them:** only on GitHub's own runners (`RUNNER_ENVIRONMENT=github-hosted`: Linux CI's user
  has sudo, Windows CI's is an administrator), the test creates a user, sets the stand-ins' permissions the way the
  setup sets the real places', and runs the probe as that user: every stand-in unreadable. Never on a developer's PC
  or a self-hosted runner (there the half is skipped with the reason printed, and on the PC's runner the hook's real
  probe is that proof). Everywhere else `winuser.mjs`'s tools (`net`, `icacls`, `sc`, `schtasks`, `wsl`) are stubs,
  as the trip-wire in `resolveBin` requires.
- **The hook fails the job when one is readable:** a stand-in left readable makes the stub runner's job fail before
  its first step, on every platform.
Broken on purpose: grant the account read on the stand-in gh `hosts.yml`; both halves must fail. On the owner's PC, the
Owner check runs the probe as the real account.

---

## 3. Which runners serve which checks

- **Windows jobs:** the Windows runner (service `actions.runner.<owner>-<repo>.<name>`, logon `.\nlci-<repo>`), labels
  `self-hosted, windows, x64, nextlevel-windows`.
- **Linux jobs:** the Linux runner in the account's distro (Ubuntu 24.04 from Canonical's WSL image, checksum checked),
  started at boot by a scheduled task as the account; labels `self-hosted, linux, x64, nextlevel-linux`.
- **Installed in the distro:** Git, curl, unzip, Docker Engine and its compose plugin (for `container:`, `services:`
  and jobs that run Docker), passwordless sudo for the runner's user (GitHub's images have it, and Playwright's
  `--with-deps` needs it), `jq`. Node and pnpm come from the workflows' own `actions/setup-node` and
  `pnpm/action-setup` (the tool cache keeps them). GitHub's images carry far more; nextlevel installs what the
  repository's workflows are found to use (`workflowJobs` reads `uses:` and `run:`; `docker` → Docker), and a job
  that fails for want of a tool is the owner's to see: the card says "your workflows may need tools GitHub's images
  have".
- **Windows runner's tools:** Git for Windows and PowerShell 7 are already on the PC for nextlevel; Node comes from
  `setup-node`. Visual Studio Build Tools are not installed: a job that needs them is left on GitHub.
- **Labels:** `self-hosted` plus nextlevel's own (`nextlevel-linux`, `nextlevel-windows`), so no other runner picks
  these jobs up and these runners pick up nothing that doesn't name them.
- **Check names don't change:** a check is the job's `name:` (or its id), posted by the GitHub Actions app (15368)
  wherever it ran. Only `runs-on` changes, so required checks and branch protection need no change.
- **nextlevel's own repository:** `ubuntu` → Linux runner; `windows` → Windows runner. ci.yml's `ubuntu` job posts the
  `windows` check through its `GITHUB_TOKEN` (`checks: write`): on the PC that token is in the runner account's job
  only, the same app posts it, and it means what it means today. One thing changes: nextlevel's own `npm test` on
  this PC competes with sessions' `npm test` (point 5). nextlevel's tests on the Windows runner run as the account,
  with its own `USERPROFILE`, which is what they want (they never touch a real `~/.nextlevel`).
  nextlevel's checkout isn't a nextlevel project (no `nextlevel.json`, no hub), so its runner is set up with
  `nextlevel team runner on --repo <owner>/<name>` in the owner's window, and the watch runs in a small watcher that
  command starts (in safe updates' run registry) when no project's hub covers the repository; its workflow change is
  an ordinary pull request by a session (a `.github/` change: CLAUDE.md's rule for those applies). The Windows runner
  is a service in session 0, and with `CI` set the tests that open real windows run there (hub.test.mjs:396,
  dashboard.test.mjs:1049, engines.test.mjs:789, agytrial.test.mjs:351), which GitHub's image doesn't do the same way:
  `windows` moves only after one full run passes on the PC's runner (B's Owner check), and KNOWN_ISSUES says so.
- **A project's release jobs** (an `environment:` with a publishing token, run by hand) stay on GitHub by default:
  few minutes, the most exposure.
- **a test project** has no GitHub repository today (no `origin`). For the Owner check the owner makes one, private, with
  `gh repo create` (the doctor's `git.remote` suggestion) and a one-job workflow `try` (`runs-on` through the variable,
  `run: node --version && whoami`), approved on the card.

---

## 4. How the workflows point at the PC, with the owner's approval

### Weighed

- **Changing `runs-on` in each workflow, every switch.** Each switch is a protected change: the guard's card, and a
  deploy push's Approve on the base branch (a real project's and nextlevel's base is their deploy branch). Clear on the card,
  but every "back to GitHub" when the PC is off means a commit, a card and an Approve before a waiting check moves,
  and a branch made before the switch keeps the old `runs-on`.
- **A one-time change that reads a repository variable (chosen).** Each job moved becomes
  `runs-on: ${{ github.actor != 'dependabot[bot]' && vars.NEXTLEVEL_RUNS_ON_LINUX && fromJSON(vars.NEXTLEVEL_RUNS_ON_LINUX) || 'ubuntu-latest' }}` (and
  `_WINDOWS` / `'windows-latest'`). With no variable, it's exactly GitHub's runner as before: the change can be
  approved and merged before any runner exists. The switch is then a variable (`["self-hosted","nextlevel-linux"]`),
  read when a job is queued, so it reaches every branch at once.

### Who may set the variable

Setting a repository variable needs write on the repository's Actions settings, through the owner's gh. Workers have no
gh sign-in (`workerspec.mjs`); the orchestrator's sessions in the main checkout run as the owner and could reach the
owner's gh (FR-017's open hole). So the hub **watches** the variables whenever a workflow on the base branch reads them, a runner
set up or not (`GET .../actions/variables`, every 5 minutes and before it reports the runner online; a variable that
points at the PC with no runner would leave checks waiting 24 hours): a `NEXTLEVEL_RUNS_ON_*` value the hub didn't set
(its last write is recorded in `~/.nextlevel/runners.json`, as safe from the team as the guard's records are:
KNOWN_ISSUES, FR-017) deletes the repository's runners on GitHub and stops them at once (jobs wait meanwhile, which the
card says; so no job runs
on the PC from it), and a card asks the owner: keep it, or put it back. What flipping it can do is limited anyway: it
can only send jobs to runners the owner set up, which run that repository's own workflows. Flipping it *off* only spends
paid minutes, which the hub sees the same way and the card says.

### Who makes the change and how it reaches GitHub

- **The file change:** Set it up (or `nextlevel team runner on`) shows the guard's description of exactly the change
  (the `where jobs run:` lines and the diff) before the click; the click, naming those files' hashes, is the owner's
  approval, recorded with `recordOwner`, so the push guard finds the content approved and raises no second card.
  The hub builds the commit without touching the main checkout (the orchestrator's working tree and index): on top
  of origin's base with a temporary index (`read-tree`, `hash-object -w`, `update-index`, `write-tree`,
  `commit-tree`), `refs/heads/nextlevel/runner-<date>` set with `update-ref`, pushed with `pushBranch`. A pull
  request (the owner's gh, at the same click: new, nextlevel opens none today) carries it, and its checks run **on
  GitHub** (the variable isn't set yet). Merging it is the owner's, as any pull request; on a repository with no
  protection the card also offers "push to the base branch", which is a deploy push and waits for Approve of
  exactly that commit (`holdPush`).
- **Why not straight to the base branch:** a change that moves where code runs belongs in a pull request with its
  checks, and on nextlevel's own repository main's protection requires it.

### The guard's description says where jobs run

`workflowJobs` (`src/lib/workflows.mjs`) reads each job's `runs-on`, and `workflow` (`src/lib/protect.mjs`) adds lines under a new label, **`where jobs run:`** (the triggers keep `runs on:`, which reads too much
like `jobs run on:`):

- `where jobs run: verify on GitHub's runner ubuntu-latest (paid on a private repository)`
- `where jobs run: verify moves from GitHub's runner ubuntu-latest to THIS PC (self-hosted: nextlevel-linux)`
- `where jobs run: verify runs where the repository variable NEXTLEVEL_RUNS_ON_LINUX says: this PC when nextlevel's switch
  is on, else GitHub's ubuntu-latest`
- `where jobs run: new job deploy on a self-hosted runner (labels: self-hosted, gpu): a runner on your machines`
- `where jobs run: <expression> (nextlevel can't tell where: read the diff)`
- `where jobs run: <job> uses a workflow from <other/repo>: nextlevel can't tell where it runs, and changes there
  aren't guarded`
- `where jobs run: <job>: nextlevel can't tell where (read the diff)` — for every form the reader doesn't recognise:
  never "GitHub's runner" by default.

The forms it reads (settled while building A): a string, quoted or not; a one-line list, or a list on the following
lines; a `group:`/`labels:` map (a group: "can't tell"); an expression reading `vars.` (nextlevel's own variable with a
hosted fallback in plain words, any other "can't tell"); a job-level `uses:` (another repository's: "uses a workflow
from <other/repo>: nextlevel can't tell where it runs, and changes there aren't guarded"; this repository's: "runs
where that file's jobs say"). What it doesn't know reads "can't tell": an anchor or alias, a matrix or another
expression, a map on one line, a job written on one line, a label of its own without `self-hosted`, and a job whose
`runs-on` it missed. Lines go before the rest of the file's, so a long card never cuts them off.

Any job whose `runs-on` names `self-hosted`, a nextlevel label, or an expression with `vars.` is said in plain words.
Since every protected change (a task branch's push, the orchestrator's commit, a merge) already waits for the owner's
card, nothing the team writes points a job at the PC without the owner's approval; the new line only makes it plain.
A task branch is also held when pushed: a pull request's workflow runs from its head, so an unapproved `runs-on` must
never reach GitHub.

The Windows hook also refuses a job whose `GITHUB_WORKFLOW_REF` names another repository or a workflow the setup
didn't list (whether hooks see that variable is checked in B's Owner check; the stub runner plays a real one).

### Turning it off

`nextlevel team runner off` (or Turn off on the card): the variables are deleted (jobs go back to GitHub at once, so the
card says this spends paid minutes), the runners are stopped and deleted on GitHub (`remove-token` + `config remove`,
else `DELETE .../runners/{id}`), and the elevated step removes the service, the scheduled task, the distro
(`wsl --unregister`, as the account), the account and its profile, and the runner folders. The workflows keep their
variable lines (harmless: no variable means GitHub's runners); "also put the workflows back" is a tick that makes the
reverse commit through the same card.

---

## 5. When the PC is off, asleep or busy

### No runner online

GitHub queues the job up to 24 hours, then cancels it. While the hub runs and a runner is offline (`status`), it reads
waiting jobs (`GET .../actions/runs?status=queued`, each run's jobs with nextlevel's labels):

- **Home:** "2 GitHub checks wait for this PC's runner, which is offline (since 14:02)". Actions: **Start it** (start
  the service / the task; the account grants the owner start and stop at setup, so no UAC), **Run them on GitHub, this
  once (paid)**, **Switch back to GitHub's runners (paid)**.
- **Phone:** one message per outage, through `notify()`, after 10 minutes offline with a job waiting.
- **"This once":** nextlevel takes the list of waiting jobs, sets the variable to GitHub's runner, cancels and
  re-runs those runs, and sets the variable back as soon as the re-run jobs show GitHub's labels while queued (their
  `labels`), not when they start. Any other job queued in that window also goes to GitHub: the button says so, and
  Home names each afterwards. (Whether a re-run reads `vars` again is checked on real GitHub in B's Owner check.)
- **Off more than 14 days:** GitHub removes the runner; `runner.online` says so (not "offline") and its fix registers
  it again.
- **Never by itself:** nothing switches to paid minutes without the owner's click. The owner chooses in advance only
  how long before the phone hears it.
- **The PC off:** nothing can say anything while it's off. When the hub starts, the runner is already back (it starts
  at boot), takes the queue, and Home says how many checks GitHub cancelled while the PC was off (`conclusion:
  cancelled`, runs older than 24 hours with nextlevel's labels), with **Re-run them**.

### The PC's load

- One job at a time per runner (GitHub's rule): up to two per repository. No PC-wide lock: the Linux runner sees no
  Windows files, and a folder every runner account could write would join the repositories' accounts. Each runner
  carries its own limit instead: the distro's `memory` and `processors` caps, and the Windows runner's service at
  BelowNormal priority (its jobs inherit it).
- **Against the team:** while any runner is busy, the hub dispatches one worker fewer (`workers.max - 1`, never below
  one), and Home says "a GitHub check runs on this PC: one worker fewer". The hub learns it from GitHub's API
  (`GET .../actions/runners`, `busy`, polled every minute while a runner is set up), never from a file the account
  writes. Weighed: holding dispatch altogether (CI jobs are short, but the team is the PC's main work and workers are
  the abundant resource) and making CI wait while workers run (a check that waits behind a long task blocks a merge
  for hours).
- **Ports:** the Linux runner's ports stay in its VM (`localhostForwarding=false`); the Windows runner's jobs listen on
  the PC's own ports, which slots offset from (`ports.mjs`); a Windows job that takes a fixed port can still meet a
  slot's: KNOWN_ISSUES.
- **Docker:** the distro's own engine; Docker Desktop's containers and the slots' are untouched.
- **Sessions' `npm test`:** a session on this PC can't see the runner's jobs. CLAUDE.md gets a line: before a long test
  run, `nextlevel status` shows whether a GitHub check runs here.

### Sleep, reboot, updates

- **Sleep:** `pc.sleep` already asks for no sleep on AC; `runner.sleep` (new) repeats it as a warning when a runner is
  set up, since a sleeping PC leaves checks waiting.
- **After a reboot:** the Windows service is automatic (delayed start); the distro's runner is a scheduled task at boot
  as the account. Both come back with no one logged on.
- **The runner's own updates:** left on (GitHub updates it when a job is assigned). Why: with `--disableupdate` nextlevel
  would have to install each version within 30 days or GitHub stops queuing, and a critical update stops queuing at
  once. The account owns its runner folder so it can update itself; nextlevel's hooks live outside it (GitHub's rule
  too). `runner.version` reads each runner's `version` and warns when it's behind GitHub's latest by more than a week.

---

## 6. Installing the runner

- **From:** GitHub's `actions/runner` release, through the owner's gh (`gh api repos/actions/runner/releases/latest`):
  the `win-x64` zip and the `linux-x64` tarball, each checked against the SHA-256 in that release's notes (the hash
  read from the release by the API, the file downloaded from the release's asset URL; a mismatch stops with both
  hashes). The WSL image from Canonical's release, checked against its published SHA-256.
- **Why that's not a dependency:** nextlevel's own code stays Node built-ins; the runner is a program the owner chooses
  to install, like Git and Node in `install.ps1`. It is installed only by the owner's click, never at nextlevel's
  install or update.
- **Where:** `C:\ProgramData\nextlevel-ci\<repo>\` (`runner\` owned by the account; `hooks\` and `walls.json` written only
  by Administrators, readable by the account; `verdict\` written by the owner, readable by the account; `state\` the
  account's). Not
  in the tool's folder, which safe updates replace per version, and not in the owner's profile, which the account must
  not read. One antivirus exception covers `C:\ProgramData\nextlevel-ci` if the owner needs one; `runner.files`
  suggests it.
- **Registered:** the elevated step gets a registration token from the owner's gh (`POST .../registration-token`, needs
  admin), passes it to `config.cmd --unattended --runasservice --windowslogonaccount .\nlci-<repo>` (and to the
  distro's `config.sh`), and drops it: never written, never logged (the step's log is redacted with it).
  The Windows runner's `ACTIONS_RUNNER_HOOK_JOB_STARTED`/`_COMPLETED` are set in the service's environment
  (`HKLM\SYSTEM\CurrentControlSet\Services\<svc>`, `Environment`), which only Administrators write, never in the
  runner's own `.env`, which the account owns.
- **Repaired:** `doctor --fix runner.online` restarts; `--fix runner.installed` reinstalls the runner's files (checksum
  again) and registers again with `--replace`.
- **Quarantined:** `runner.files` checks the runner's executables are present and run (`Runner.Listener --version`), as
  `tool.files` does for nextlevel's (FR-013): a missing file says "your antivirus may have removed it", names the file,
  and offers the exception and Repair.

The elevated step is one PowerShell script, shown on the card before it runs and passed as `-EncodedCommand` of
exactly that text to `Start-Process -Verb RunAs`: Windows' UAC prompt on the secure desktop is the owner's confirmation, which
an agent can't click.

---

## 7. The doctor and Home

| id | looks at | fix | severity |
| --- | --- | --- | --- |
| `runner.visibility` | the repository is private and a personal account's (gh), and none set up on a public, internal or organization's | tears the runner down | error |
| `runner.forks` | fork pull requests' workflows off (`run_workflows_from_fork_pull_requests: false`); if on: approval required, no write tokens, no secrets | the owner's click sets them (owner's gh) | error |
| `runner.collaborators` | who can push (collaborators with write, apps like Dependabot): each can run code on the PC | none: says who | warning |
| `runner.installed` | the account, the service, the task, the distro, the runner files and their checksum | Repair (elevated) | error |
| `runner.files` | the runner's executables present and running | Repair, antivirus exception | error |
| `runner.online` | GitHub says each runner `online`, labels as set up, or removed by GitHub after 14 days off (register again) | Start it | error |
| `runner.walls` | the hook's last probe: nothing on `walls.json` readable; machine-wide secret-looking variables; a Docker daemon on 127.0.0.1:2375/2376 | tighten ACLs (elevated, shown) | error |
| `runner.variables` | the variables are what the hub set | the card | error |
| `runner.workflows` | the moved jobs read the variable on the base branch | the card | warning |
| `runner.version` | not behind GitHub's latest by more than a week | restart (it updates itself) | warning |
| `runner.sleep` | the PC doesn't sleep on AC while a runner is set up | `pc.sleep`'s fix | warning |

Each is in `docs/CHECKS.md` with unit tests on a fake context. Setup shows them only when the project has a GitHub
origin; they're information until a runner is set up, except `runner.forks` and `runner.collaborators`, which inform the
recommendation.

**Home:** the offline card (point 5); "a GitHub check runs on this PC" while one runs. **Today:** "GitHub checks on this
PC: 6 jobs, 74 minutes (would have been paid: 74 Linux, 0 Windows)", from the API's job times
(`runner_name`).

---

## 8. Who may switch it

Only the owner: the Team page's card (a POST with the dashboard's key, from its origin, JSON, naming exactly the
repository and jobs the card showed, as Approve) and `nextlevel team runner on|off|status` in the owner's own window.
`on` and `off` refuse in an agent's session (`agentSession`/`ownerOnly`); `status` only reads. The command's options go
in `src/lib/commands.mjs`. No phone message, file in the project, or card answer turns it on.

What an agent running as the owner can still do (for KNOWN_ISSUES' FR-017 section): clear its variables and run the
command as if it were the owner; but `on`'s account and service need the elevated step, which waits for UAC on the
owner's screen (unless the owner has turned UAC's prompts off: `runner.installed` warns about that). With the owner's gh
it could set the variable (the hub stops the runners and asks, above) or register a runner of its own as the owner on
the repository (outside nextlevel; the hub lists the repository's runners and flags any it didn't register:
`runner.online`). Part 2B closes these by taking the owner's gh out of the agents' reach.

---

## 9. Updates and versions

- **What runs from the tool while the runner works:** nothing. The hooks are copies in `C:\ProgramData\nextlevel-ci\
  <repo>\hooks\` (plain PowerShell for Windows, sh for the distro; no Node needed, no tool folder read), with a
  `version` line; the account can't read the tool's folder anyway. The hub's watch is hub code and restarts with it.
- **The one-click update** doesn't wait for or stop runners or their jobs (they run none of the tool's code), and
  gets no new step. A new version whose hooks differ shows a Home card, "The GitHub checks runner's hooks changed:
  Update them", which runs one elevated step (UAC) while the repository's runners are idle (`busy: false`); a hook is
  replaced by writing a new file and renaming it. The old hooks keep working until then; the hub reads each hook's
  `version` line.
- **What a newer version reads:** `~/.nextlevel/runners.json` (`protocol: 1`: per repository, the account, the folders,
  each runner's id, name and labels, the variables the hub set, when), `walls.json`,
  `verdict\visibility.json`. Keys never change
  meaning (safe updates' rule); a version that doesn't know runners (an older one after Go back) leaves them running
  and its doctor shows nothing about them; the hook's visibility gate still holds without any hub against a repository that turned public.

Go back to a version without runners says so on its card when a runner is set up: "This version doesn't watch the
GitHub checks runner: the job hook still refuses a public repository; turn it off first if you're going back for
long".

---

## 10. The pull requests

**A: the recommendation and the checks (no runner).** `src/lib/workflows.mjs` (`workflowJobs`: each job's `runs-on`,
what it uses, its environment and secrets), the guard's `where jobs run:` lines, the repository's facts (visibility,
owner type, admin, fork settings, collaborators, runs' minutes: `src/lib/ghrepo.mjs`, cached), the Team page's card in
"recommended / offered / not offered" with the minutes, `runner.visibility`, `runner.forks`, `runner.collaborators`,
`nextlevel team runner status`. Tests: a public repository offers nothing and `team runner on` refuses; a private one on
hosted runners is recommended; a task branch moving a job onto `self-hosted` is held on a card whose text names the PC
(broken on purpose: offering it for a public repository); every `runs-on` form the reader meets, each unknown one
"can't tell"; `runner.forks` with fork workflows on; an organization's or internal repository not offered. Owner
check: the card for nextlevel's own repository through `nextlevel team runner status --repo` (recommended), on a real project (recommended, read-only), on a public repository of the owner's (not offered).

**B: the runner.** First the trial (point 2, item 4) on the owner's PC; then `winuser.mjs`, `walls.mjs`, the elevated script, the runners, the hooks, the variable switch and its
watch, the offline card and phone message, "this once", the load share, turning it off, the rest of the checks, the
hooks' update card (point 9). Tests with a stub `gh` (visibility, Actions settings, variables, runners, registration and remove
tokens, runs and jobs) and a stub runner (registers, comes online, takes a job through its hooks, stops), in a home of
their own: a runner set up before the repository turns public is stopped and unregistered before its next job (the hook
fails it); the workflows' change is shown from code (`where jobs run:`) before the click, recorded as the
owner's, pushed with no second card, and a push to a deploy branch waits for its Approve; the walls' stand-ins unreadable
(broken on purpose: a readable gh `hosts.yml` must fail the job); an agent's session can't switch; the PC off shows on
Home and nothing switches to GitHub; off removes the runner and the variables; the hook's variables set outside the
runner's folder; the Windows hook's fallback from `verdict\` and the Linux hook failing closed; runners deleted on
GitHub before they're stopped, with the stub's runner busy both ways (the listener exits; the job finishes first); a
`dependabot[bot]` run sent to GitHub; a job from another repository's reusable workflow refused; a runner GitHub
removed after 14 days.

Owner check, in two repositories:
- **a test project**, with a private repository whose name says nothing about the owner's projects, which stays
  private throughout: on; a manual run that shows `whoami` (the account), the walls probe as the account,
  `GITHUB_WORKFLOW_REF` in the hook, and a re-run with the variable flipped; off.
- **The public step, in a throwaway repository of its own** that holds only a README and a one-job
  `workflow_dispatch` workflow (nothing from a test project, nextlevel's role docs or any other project, since nothing
  of the owner's may be made public), set up with `nextlevel team runner on --repo <owner>/<name>`: the repository made
  public; wait a minute after making it public (anonymous reads can lag), then its job started by the owner: the hook fails it ("the repository is public") and within 5 minutes the
  hub (here, the watcher that command started) (the watcher and a project's hub run the same watch function, so
  this proves the hub's path too) has unregistered the runner; then the repository deleted
  (`gh auth refresh -s delete_repo` first) or made private again; off.
- Then nextlevel's own `windows` check once on the PC's runner, before it moves.

---

## Security: the boundaries and what holds each

- **Public code on the PC:** never offered or allowed; the hook's anonymous check before every job, the hub's poll and
  teardown.
- **A job reaching the owner's things:** a standard account per repository, its own WSL VM with no drives or interop,
  no Docker Desktop; the account's Windows rights, checked per job by the hook, proved in tests with stand-ins and in the Owner check as the real account.
- **The team pointing a job at the PC:** workflows are protected; the push guard holds any branch that changes them;
  the card says where jobs run, from code; the variable is watched and a change the hub didn't make stops the runners.
- **The owner's money:** nothing moves a job to paid runners without a click that says it pays.
- **Secrets:** registration tokens never kept; the account's password generated and never written; jobs with an
  environment's secrets stay on GitHub unless the owner moves them, knowing.

## After install on a real project (for the owner, after the go)

Nothing here is done by a session. On the owner's go, at a pause with no task running:

What a real project's workflows need, read with GETs: its CI job `verify` (`runs-on: ubuntu-latest`, Docker and
compose, pnpm, Node, a browser test tool with system packages) moves to the Linux runner, which has all of these; its
release jobs (`windows-latest`, `workflow_dispatch` only, one with a token to publish) stay on GitHub. Its main has no
required checks; the names stay anyway. Its fork settings are all off. This needs the Linux runner: if the trial
(point 2) failed, that project gains nothing yet.

1. Team -> GitHub checks: Set it up, tick `verify` only (leave the release jobs on GitHub).
2. UAC prompt: yes. Read the change Set it up shows (it says `verify moves ... to this PC`)
   and click; then merge the pull request, or Approve the push to main.
3. Watch one `verify` run on the PC (Build page or GitHub's run page: the runner nextlevel named for it).
4. If anything is wrong: Turn off.

## Settled while building part A (18 October)

1. **An organization's repository isn't offered** (point 1, "Personal or organization"): `runner.visibility`, the card
   and `team runner on` all say a personal account's private repository only.
2. **One command name:** `nextlevel team runner status|on [--repo owner/name]` (B adds `off`). `--repo` covers a
   repository that isn't a project, run from any project (nextlevel's own, B's throwaway public one); there is no
   `nextlevel runner`.
3. **Every `runs-on` form** the reader meets, and "can't tell" for each it doesn't know (point 4).

What A built, and how it differs in detail from the design: the minutes are the latest 30 runs' of the last 30 days
(`MINUTES_RUNS`), each job rounded up to a minute, from the runs' jobs (GitHub's billing endpoints need scopes the
owner's gh doesn't have); the doctor's three checks read GitHub afresh each run and keep nothing (the cache's writers are
the dashboard and `team runner`, under the file's lock; a fix must see what GitHub says now); `runner.visibility` is information in A (no runner exists to tear down), each
"not offered" a pass that says why; the card has Check again (`team runner status`, read afresh) and nothing that turns
anything on; `team runner on` also refuses while workflows from fork pull requests are on or can't be read (read at that
moment, like the visibility).

## The reviewer's answers (17 October)

1. WSL fails on the PC: Linux jobs stay on GitHub, and B doesn't wait for a VM. The trial comes first, so this is
   known before the Linux half is built. A VM can be a later pull request.
2. No PC-wide lock (it can't reach the WSL runner, and it would join the repositories' accounts). Per-runner caps
   instead, and one worker fewer while any runner is busy, from GitHub's API.
3. Yes: a real project's release jobs, and by default any job with an environment or a secret, stay on GitHub.
4. "This once" is acceptable, narrowed: the variable goes back as soon as the re-run jobs are queued on GitHub's
   labels, and Home names every job that went to GitHub in that window.
