# Safe updates: design

Status: approved by the owner on 14 October with the reviewer's changes (below), which this version has folded in.
Written 14 October 2026 against main at 3e4f85e (after FR-019); "What the code has" checked again on 16 October against
main at 30f592d (FR-020, FR-021, FR-022, the pushed-workflows guard and both Codex-workers pull requests).

## Changes from a review (14 October)

The review's verdict was "go, with changes". Each change, and where this document now has it:

1. **The hold doesn't hold the jobs a running round or window asks for.** While the update waits, only new task
   dispatches, retries and new rounds are held; a commit, merge, check or push a running round or an open orchestrator
   window asks for runs (else its `nextlevel wait` would deadlock the round). Those are held only once the wait has
   ended. (Point 3, "Holding new work".)
2. **Everything a hub starts gets that hub's command first on PATH**, and `NEXTLEVEL_HOME` when it is set, and the
   version it runs (`NEXTLEVEL_VERSION`), so an agent's `nextlevel` runs the hub's own install and version, never
   the real install's from the user's PATH. (Point 2, "How the command ... find the right version".)
3. **The owner check runs on a copy of a test project**, never a test project itself: the guard's records and the second
   accounts live in the home folder, so a trial home would leave records the real install doesn't know. (Point 9.)
4. **No lowered floor for a trial home.** The trial script tags its local remote `v0.1.0` and `v0.1.1`, and the trial
   home's own `releases.json` takes them under the real `FIRST_RELEASE`. (Point 9.)
5. **The run registry is best effort.** Codex's sandbox can't write the home folder; a command that can't register
   still runs. Waiting for rounds and windows covers sandboxed commands. (Point 3, "Waiting for running work".)
6. **The migration takes a pinned install too.** A's installer, run at the last manual pause, moves a pinned old-layout
   install to the first release (the pin existed for exactly that pause). The pin goes on at the last moment, after the
   queued fixes are installed on a real project; anything merged after it waits for `v0.1.0`. (Point 9.)
7. **START.cmd is held by cmd.exe**, between menu runs too: before replacing it, one process snapshot looks for a
   cmd.exe with that START.cmd on its command line. (Point 4.)
8. **A Windows test proves the detached updater survives** the dashboard that started it being killed and the old
   hub's window closing, and that the hubs and dashboards it starts keep running. (Point 9, pull request B.)
9. **Correction:** with a moved tag, `git fetch --tags` still updates the branches but exits 1, so `fetchTool` reports
   a failed fetch every time. The conclusion stands. ("What the code has".)
10. **The dashboard refreshes `available.json` at its start too**, under the same six-hour rule. (Point 6.)
11. **The launcher fails loudly** for a version folder that is gone or changed: it stops and gives the repair command,
    never quietly runs `release`. A version folder with files changed by hand shows in `install.updates`. (Point 2.)
12. **The update's state stays out of `state.json` on purpose**: `jsonStore` merges with no lock, so the update's
    files are files of their own, written under `lib/filelock.mjs`. (Point 2, "Two versions on one PC".)
13. **After Go back, the release gone back from is offered again**, marked "you went back from this one". (Point 3.)

The review's answers to the three open questions: one release, `v0.1.0`, after B; a folder per version, with one
antivirus folder exception on `%USERPROFILE%\.nextlevel\versions` (it covers its subfolders) suggested by the README and
the doctor; `updates.backupBranch` in `nextlevel.json`. Its addendum on the backup branch: it must be a
branch nothing deploys from, so **the suggested backup branch is `nextlevel-backup`**, the update's own branch; the backup
push sends the base branch's head, never another branch; and the owner checks once, on their host, that no site deploys
from that branch.

The owner later (16 October) asked for the whole upgrade to be finished as soon as possible, so pull request A is built
while the Antigravity-roles work is in flight; B merges main with its round holds before it builds the update's hold.

Pull request A's review (16 October) added, for B: pruning by the run registry, the launcher's message for a window an
older nextlevel opened, and the click restarting open dashboards (so none starts a hub on the old version). The
later review settled the review's open point: B builds `.nextlevel/format.json`.

As built, the hold's phases are two: `waiting` from the click (this document's `holding`) and `held` from the end of the
wait to the end (its `restarting` and after); the update's own jobs carry `update: <id>` beside `by: "update"`, so a job
an earlier update queued never passes a later hold. B's review (17 October) added: Go back leaves a file changed since
the update's commit, a gone updater is paused at its step, and one update at a time by `current.json`'s lock.

### What the code has, again (16 October, main at 30f592d)

Unchanged since 3e4f85e: `src/lib/update.mjs`, `src/cli.mjs`, `install.ps1`, `src/lib/install.mjs`,
`src/lib/home.mjs`, `src/fix.mjs`, `src/checks/install.mjs`, `src/checks/files.mjs`, START.cmd. What changed and
what it means here:

- **The bridge test keeps a verdict per worker engine** (Codex workers part A): `.nextlevel/bridge-tests/<engine>.json`
  with the engine's version, the worker arguments it ran with and a `gh` result, beside `bridge-test.json`, which an
  older nextlevel still reads. Point 5 adds `SLOT_PUSH_BLOCK` to those records; it no longer has to add the per-engine
  records.
- **Workers have arguments of their own** (`engines.<engine>.workerArgs`) and there may be a **second worker**
  (`roles.worker.second`). "Each worker engine in use" (point 5) is the workers, the second worker and the fallback.
- **Agy tasks wait for a passing trial** (FR-022), a "held" state of its own for one engine's tasks; the update's hold
  is PC-wide and comes on top of it, and never releases it.
- **A push that carries a protected change waits for the owner's Approve** (#37). The backup push sends only the base
  branch's head, which holds only approved changes, so it never needs one; if it ever does, the update pauses there.
- **`OLD_TEMPLATES`** lists the orchestrator's docs up to #37's; Codex workers part B's template is current.

## The problem, in one paragraph

Every fix reaches the owner's projects through a manual pause of a dozen steps (autopilot off, wait, stop the hub,
close the dashboard, `nextlevel update`, `nextlevel init`, commit the role docs, start the hub, the bridge test if an
engine changed, a backup branch, autopilot on, the doctor's rows). And a merge to main is the only way to try a change
on the PC, so an owner check on a test project updates the tool the real projects run too. The owner approved the shape of the
answer: releases instead of main, an update when idle with one click, and the owner's click plus a phone message for
safety fixes (1 October). This document settles how.

## What the code has (checked against 3e4f85e)

The reviewer's reading holds. What I confirmed, and the few things I'd add:

- **Updating** (`src/lib/update.mjs`): confirmed. `autoUpdate` (the start check of the owner commands in cli.mjs's
  `AUTO_UPDATE`) and `cmdUpdate` fast-forward the branch the clone follows, then `rerun` the command on the new code.
  Both wait on `busy()`/`activity()` (a hub heartbeat under 90 s, a running job whose `run.json` pid lives); `--force`
  doesn't wait. A detached HEAD is "pinned" in update.mjs, `updateBlocker`, `install.updates` and install.ps1. `--to`
  and `--force` refuse in an agent's session; a plain update from one succeeds (DECISIONS 30 September). No tags on
  GitHub.
  - Added: `fetchTool` runs `git fetch --prune --tags origin`. Git refuses to move an existing local tag without
    `--force` ("would clobber existing tag"): the branches are still updated, but the fetch exits 1 (the review tried it
    with git 2.43), so `fetchTool` reports a failed fetch every time. So a tag that moved on GitHub would make every
    later update check fail today. Releases need tags fetched another way (point 1).
  - Added: `--to <ref older than update.mjs>` is refused without `--force` (a version that couldn't bring itself back).
    Releases keep the idea as a floor (point 9).
- **Which projects**: confirmed. `rememberProject` runs only in `nextlevel run`, keeping the last 20 in state.json.
- **Hubs**: confirmed. On Windows the hub runs in a window (`cmdStartHubWindow`/`openWindow` with `cmd /k`, so the
  window stays at a prompt after the hub ends), in the background elsewhere and with `NEXTLEVEL_HUB_WINDOW=0`. It stops
  on `hub-stop.json` or Ctrl+C, after the verifications, checks and pushes in progress, without waiting for workers or a
  round. Its last log line, "running workers keep going", is true on Windows only for workers in a window (KNOWN_ISSUES,
  FR-013: a windowless worker dies with its hub). `hub.json` has `pid`, `startedAt`, `heartbeatAt`, `slots`, `root`,
  `pushProtocol`: nothing says how the hub was started.
- **The dashboard**: confirmed. One per project (`ui.json`: pid, port, heartbeat), the port of last time
  (`ui-port.json`), a new random key per start never written down, `reopenDashboard` through `ui-open.json`. It stops
  on a signal only. Approve is a POST with the key in a header, from the page's own origin (`Origin`,
  `Sec-Fetch-Site`), as JSON.
- **Role docs**: confirmed. `project.role-docs`'s fix writes the template over an unedited old one through
  `ctx.write`, which calls `recordOwner`; committing needs `nextlevel commit` with the hub running. `OLD_TEMPLATES`
  has the three role docs only. `nextlevel init` asks per file with a diff, never touches the seeds (BRIEF.md,
  PROJECT.md, STATUS.md, HANDOFF.md, DECISIONS.md, OWNER_NOTES.md) and treats an edited `.env.example` as the
  project's own.
- **The bridge test**: confirmed. `bridge-test.json` has one engine, its version, the result; `bridge.test` asks again
  when that engine's `--version` changes.
  - Added: the hub has a `PUSH_PROTOCOL` constant (in `hub.json`), but nothing records the version of the slots' push
    block itself, which is what the bridge test proves.
- **Telling the owner**: confirmed. Nothing on Home or the phone; the start check prints one line; `install.updates`
  reads `state.json`'s `update` record from the last fetch.
- **Field reports' fixes** (`followFixes`): confirmed. Installed means `merge-base --is-ancestor <mainSha> HEAD`, where
  `mainSha` is main's head when the issue closed; the message says `nextlevel update` installs it.
- **The hub's old self-install** (`readyToInstall`, `installFix`, removed in 94ddd8c): confirmed, as described.
- **The clone's worktrees**: confirmed. `nextlevel fix --local` makes `~/.nextlevel/fixes/issue-<n>` on a branch
  `fix/issue-<n>`.
- **What's PC-wide**: confirmed. Also: the launcher `nextlevel.cmd` names the tool's folder and is left alone when
  right (`writeShims`), START.cmd calls `nextlevel` from PATH and falls back to `~/.nextlevel/bin/nextlevel.cmd`, then
  to `~/.nextlevel/tool/bin/nextlevel.mjs`; the installer refuses while any `node.exe` has the tool's folder in its
  command line.
- **Git's maintenance**: confirmed (KNOWN_ISSUES "git"; `test/helpers.mjs` turns it off in the tests' home).
- Also relevant: the hub already has a "dispatch waits" state (`settings.dispatchPaused`, FR-013's missing tool files),
  which is the model for holding work without touching autopilot. CI doesn't run on tags: `ci.yml` runs on pushes to
  `main` only (a `branches` filter, which tags don't match) and pull requests, `windows.yml` on `ready_for_review` and
  by hand.

## The shape, in short

- A **release** is an annotated tag `vX.Y.Z` on main, made by a session after the owner says the change's owner check
  passed, on exactly the commit they checked. Its message is the plain-words notes, safety fixes marked.
- Each **version** of the tool in use is a **folder of its own**: a git worktree of the tool's clone in
  `~/.nextlevel/versions/<name>`. Nothing ever changes the files of a version something may run. An update makes a new
  folder and points at it; going back points at the old one.
- Each **project follows a channel**: `release` (the default), `pin <tag>`, or `candidate <branch>` (for a test project
  and owner checks). The channels are kept in `~/.nextlevel/`, outside every project. A small fixed **launcher** behind
  the `nextlevel` command runs the version the current project follows.
- **The one click** (Home, or `nextlevel update` in the owner's window) holds new work in every hub on that version,
  waits for what runs, stops the hubs and dashboards, switches, runs the doctor, restarts everything held, refreshes and
  commits the unedited role docs through the hub, reruns the bridge test when it must, compares the doctor's rows, and
  releases the hold. A detached **updater** process does it, from the new version's folder. A failure pauses it, the
  phone hears it, and Home has Try again and Go back.
- Two pull requests: **A** releases, versions and channels (and the announcing); **B** the one click.

---

## 1. Making a release

### Who, when, how

- **Who:** a Claude Code session in this repository, only when the owner says in their own words that the owner check
  passed and the change may be released ("release it", "the owner check passed, release"). Never on its own initiative,
  never because a pull request merged, never from a field report session's own judgment. The owner's words are the
  release decision; the session does the typing.
- **When:** after the owner check of the candidate (point 2), which may cover several merged pull requests at once.
  There is no schedule: a release is made when there is something checked to ship.
- **How:** an annotated tag, pushed with the owner's GitHub sign-in (sessions already push with it):

  ```
  git tag -a v0.3.0 <checked commit> -F <notes file>
  git push origin refs/tags/v0.3.0
  ```

  Never `--force`, never a deleted or moved tag: a wrong release is replaced by the next one (`v0.3.1`), not edited.
- **The notes** are the tag's message, in a fixed plain format the tool reads (Home's card, the phone, `nextlevel
  version`):

  ```
  nextlevel v0.3.0

  Fixes:
  - Safety: a verify command can no longer push with the owner's sign-in. (#41)
  - The Project page finds plans named like a real project's. (#38)

  New:
  - Home shows what the next autopilot round waits for. (#39)

  After install:
  - Run the bridge test again (START.cmd -> 7): the slots' push block changed.
  ```

  Sections: `Fixes:`, `New:`, `After install:`, each a list of `- ` lines in plain words for the owner (what they see,
  not what the code does). A line that starts with `Safety:` marks a safety fix. Anything else in the message is shown
  as written. The tool never runs anything a note says: "After install" lines are shown, and the steps the update does
  itself (role docs, bridge test) come from code, not from the notes.
- **What counts as a safety fix:** a change that closes a way for an agent, a report or a phone message to do what the
  owner didn't approve or to leak what it shouldn't: pushing or deploying without the owner's approval, a secret or
  `.env` value leaving the PC or reaching an agent, a protected file changing without the guard, an owner-only command
  running from an agent's session, a worker reaching the network or git it shouldn't, nextlevel installing or updating
  without the owner; and a fix for something that destroys the owner's work (deletes a branch, a file, uncommitted
  changes). A crash, a wrong number on Home or a slow page is not one, however annoying. When in doubt the session asks
  the owner, because a safety mark sends a phone message to every project.
- **docs/RELEASES.md** follows by pull request (main is protected): the same notes under a heading per release, newest
  first, with the commit. It is a record for people; the tag's message is what the tool reads. A documentation-only
  pull request passes CI in seconds (`.github/ci/changes.mjs`).

Alternatives weighed: GitHub Releases (the API objects) instead of tag messages: they need the GitHub API to read
(today the tool only needs git), can be edited after the fact, and a release object can point at a lightweight tag;
the annotated tag's message travels with `git fetch`. A `RELEASES.md` on main as the source the tool reads: main
moves after the tag, so the notes for a release would be read from a commit that isn't the release.

### Which commit it tags

The one the owner checked, never a newer head. The owner's check names its commit: `nextlevel version` (and the Tools
page) print it, and the Owner check of a candidate says to note it. The session tags that commit after checking:

- it is on main's history (`git merge-base --is-ancestor <commit> origin/main`);
- when the owner checked a pull request's head rather than main, the tag goes on that pull request's merge commit only
  if the merge commit's tree is exactly the checked head's tree (`git diff --quiet <checked> <merge>`). Main's
  protection requires a branch up to date with main (`strict`), so a `--merge` of an up-to-date branch gives the same
  tree. When the trees differ, the owner checks again on the candidate `main`.

Alternative weighed: always tag main's head when the owner says "passed". Rejected: another merge may have landed
since, and that code was never checked.

### What the tool checks before it takes a tag as a release

Tags are fetched into a namespace of nextlevel's own, with a forced refspec, so nothing on GitHub can break a fetch:

```
git fetch --no-tags --prune origin +refs/heads/main:refs/remotes/origin/main +refs/tags/v*:refs/nextlevel/tags/v*
```

(`--prune` makes a vanished tag vanish here too, which is how it is noticed. `refs/tags/` locally holds only what the
tool accepted.) Then a tag is a release when all of these hold:

1. **Its name** is `v<major>.<minor>.<patch>`, numbers without leading zeros (`^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$`).
   No suffixes (`-rc1`): a candidate is a channel, not a tag.
2. **It is annotated** (`git cat-file -t` gives `tag`) and its message has the notes' first line `nextlevel <name>`.
3. **Its commit is on main's history** (an ancestor of `origin/main`, or main's head).
4. **It comes after the installed release in main's history**: the installed release's commit is an ancestor of it and
   not the same commit, **and** its number is higher. Both, because a higher number on a side branch, or the same commit
   tagged twice, is not newer code. Not newer code is not offered.
5. **It is not older than the first release that knows releases** (`FIRST_RELEASE`, point 9).
6. **It never moved**: the tool keeps every release tag it has seen, PC-wide, in `~/.nextlevel/releases.json`
   (`{ name: { tag: <tag object id>, commit, firstSeen } }`). A tag whose object or commit is not what was first seen
   has moved: it is refused, Home and `install.updates` say so ("v0.3.0 was changed on GitHub after it was published:
   nextlevel doesn't follow it; tell the developers"), and later releases are still taken. A tag that vanished is said
   the same way; if it is the installed one, the installed version stays (its folder and commit are here), and the next
   release is judged against the installed commit.

Going back to an older release is the owner's alone: Go back on Home (to the previous release, kept for that) or
`nextlevel update --to <tag>` in their own window, both refused in an agent's session. Going back runs the same steps as
an update (point 3).

### A rule on GitHub, and CI

- **The owner's setting, recommended:** a tag ruleset on `v*` with "Restrict updates" and "Restrict deletions", no
  bypass. Sessions never change rulesets, so the pull request says how (Settings, Rules, Rulesets, New tag ruleset).
  It doesn't stop a session with the owner's sign-in from *creating* a tag, and it is only offered on private
  repositories with a paid plan; the tool's own checks above (moved or vanished tags refused) are the real guard and
  work without it.
- **No CI for tags.** `ci.yml` runs on pushes to `main` only (a `branches` filter, which tags don't match) and
  `windows.yml` on pull requests, so a tag push starts nothing and costs no minutes. Its commit already had both checks
  on its pull request and `ubuntu` on main. Nothing in `.github/` changes for releases.

### The owner's check before a release, and "After install"

- Each pull request's description already ends with an **Owner check**. It gets a second section, **After install**:
  what the owner does after the update that the update can't do itself (approve a held change, set a new setting, a
  phone check), or "nothing". Most say "nothing".
- **The release's owner check** is run on the candidate commit (point 2): the Owner check of each pull request merged
  since the last release, listed by the session from their descriptions, plus a short standing part: the one-click
  update from the current release to the candidate on a test project (once pull request B is in), the doctor all green
  there, and the hub, the dashboard and one task.
- **How "After install" reaches the owner:** the release session copies each merged pull request's "After install"
  lines (without the "nothing"s) into the tag's `After install:` section. Home's card shows them before the click, and
  the update's last screen lists them again as a checklist with what the update already did ticked.

### A field report's fix, from merge to the check that runs again

| Moment | What happens | Phone (through `notify()`, the project that reported) |
|---|---|---|
| The fix's pull request merges (issue closed) | `followFixes` records the pull request's **own merge commit** (`gh pr view --json mergeCommit`), not main's head (old records keep `mainSha`) | "The fix for #12 is merged. It comes with the next release; nothing to do now." |
| A release contains it (its merge commit is an ancestor of the release's commit) | Home's card lists it under the release | "The fix for #12 is in nextlevel v0.3.0: Update on Home." (Folded into the safety release's message when that release is one, so one message per release per project.) |
| The installed version contains it | The report's checks run again (as today) | The verdict, as today ("fixed", or "still fails" with how to report it again) |

The fix's own merge commit is the right mark: the release has the fix exactly when it contains that commit; main's head
at closing time also contains whatever merged before it, which may not be released yet. The check still runs once the
installed version has the fix, now by the new version's hub after an update.

### Versions, the first release, and the steps for a session

- **Names:** `v0.<minor>.<patch>` until the tool is public (then `v1.0.0`). A release with anything new raises the minor
  (`v0.3.0`), one with fixes only the patch (`v0.3.1`). The tag is the version: `nextlevel version` prints it
  ("nextlevel v0.3.0 (release) in C:\Users\me\.nextlevel\versions\v0.3.0"). `package.json`'s `version` stops being
  read as one (it would have to change in a commit after the checked one).
- **The first release:** `v0.1.0`, on the merge commit of pull request B, after its owner check, made by the session
  that built it. It is also `FIRST_RELEASE`, the floor (point 9).
- **CLAUDE.md gets a "Releases" section** with the steps above: when to release (only the owner's words), which commit
  (the one they checked, with the tree rule), the notes' format and what counts as safety, the tag and its push (never
  forced, never moved or deleted, never a test tag on GitHub: any tag that passes the checks is a release for every
  install), then the RELEASES.md pull request; and in "How to work", each pull request's "After install" section.

---

## 2. Checking a change on the PC before its release

### Weighed

1. **Channels, each version in use a worktree of the tool's clone**, and `nextlevel` running the version its project
   follows. One install, one clone, one set of PC-wide files; a test project follows `candidate main` (or a pull
   request's branch) while a real project follows `release`. The owner checks the real update path too (the click moves
   a test project from one commit to the next).
2. **Running a candidate from the dev checkout, for a test project only** (`node <checkout>\bin\nextlevel.mjs --project
   a test project`). Simplest, nothing new to build. But the dev checkout is a session's worktree: sessions switch, reset
   and merge in it, so a hub running from it has its files changed under it; it skips the update path, which is the
   thing to check; and every PC-wide write it makes (state.json, the guard's records, the `nextlevel` command if it runs
   `_install`) is shared with a real project's install with nothing to tell the two apart.
3. **A second install in a home folder of its own** (`USERPROFILE` elsewhere). Fully apart, but the engines' sign-ins
   live in the real home (`~/.codex`, `~/.claude`, `~/.gemini`), so real engines are signed out there. Good for a
   session's own check with stub engines; not for the owner's check with real ones.

**Chosen: 1**, with a way for 3 that keeps the real home (`NEXTLEVEL_HOME`, below) for trying pull requests A and B
before the first release (point 9).

### A folder of its own for every version

Yes, an update puts the new version in a folder of its own, and nothing ever changes the files of a version that may
be running:

- **Why:** processes the click doesn't stop may still run the old code (an owner's `nextlevel status` in a PowerShell
  window, an old menu, an agent's command in flight), and Node loads some modules only when first used (the project's
  own checks are `import()`ed); cmd.exe reads a running batch file as it goes. A failed update leaves the old folder as
  it was, and going back is pointing at it again: no git, no download.
- **Where:** `~/.nextlevel/versions/<name>`: a release's name (`v0.3.0`), or for a candidate `<branch>@<short commit>`
  (`main@1a2b3c4`), each `git worktree add --detach <commit>` of the clone. The clone stays where it is
  (`~/.nextlevel/tool`, or the folder `NEXTLEVEL_DIR` named): it holds the objects and its own checkout, which follows
  the newest release but from which nothing runs (it is only the fallback START.cmd names, and its `bin/nextlevel.mjs`
  hands over to the launcher when there is one).
- **Kept:** the version each channel points at, the previous release (for Go back), and any pinned ones. Others are
  removed (`git worktree remove`) at the end of a later update, once no process of theirs runs (the run registry,
  point 3).
- **Antivirus exceptions:** an exception is per path, and a new folder has none. The one documented exception is for
  agy's program, outside nextlevel's folders, so it is unaffected. Exceptions an owner made for files in the tool's
  folder no longer apply to the files that run. Two things soften it: the files the command starts with are fixed
  paths outside the versions (the launcher, below), and `tool.files` checks the running version's files, so a
  quarantine shows as a red row with the way back, not as a mystery. An antivirus folder exception covers its
  subfolders (Defender's and most others'), so if one is needed it is one exception, on
  `%USERPROFILE%\.nextlevel\versions`, which the README and the doctor's `tool.files` row suggest. Alternative weighed:
  two alternating folders (`versions/a`, `versions/b`), so that exceptions are made once per folder. Rejected for now:
  a folder is then rewritten while a pinned project or a forgotten window may run it, which is what this design exists
  to avoid, and the owner's actual exception doesn't need it. If quarantines of nextlevel's own files come back, this is
  the change to make.

### Two versions on one PC

Two versions run at the same time only for different projects (each project's hub, dashboard, menu and commands all
run its channel's version) and, within one project, only across an update or a Go back. So:

- **PC-wide files** (`~/.nextlevel/`: state.json, the guard's records, accounts/, fixes/, reports/, cache/,
  console.json): **a key never changes its meaning**; a new meaning gets a new key or a new file. Every writer keeps the
  keys it doesn't know (`jsonStore` already writes back only its own key over what it read). A reader takes what it
  doesn't know as absent. The update's own files (below) carry `protocol: 1`.
- **New PC-wide files** for this design: `versions.json` (installed versions and what `release` points at),
  `channels.json` (each project's channel), `releases.json` (every release tag seen), `update/` (the hold, the
  updater's progress and log, the run registry). Each has one writer or a lock (`lib/filelock.mjs`).
- **A project's `.nextlevel/`**: the file protocol stays as CLAUDE.md says. New: `.nextlevel/format.json` (`{ format:
  <n>, readableFrom: <m> }`). A version that changes a file of the project in a way an older one would misread raises
  `format`; one that only adds keeps it. A version refuses to run on a project whose `format` is newer than it knows,
  unless its own format is at least `readableFrom`. Go back checks this before it switches, and says when going back
  that far needs the newer version's data put aside. Today every change has been additive, so `format` starts at 1 and
  should rarely move.
- `%TEMP%\nextlevel-agy-trial` gets the version's name in it, so two versions' doctors don't share it.

### Where a project's channel is kept

In `~/.nextlevel/channels.json`, keyed by the project's root (real path, lower case on Windows): `{ channel: "release" |
"pin" | "candidate", ref, setAt }`. A project not in it follows `release`. It is written only by the owner: the Tools
page (with the key, like Approve) and `nextlevel channel ...` in their own window (refused in an agent's session).

Why there: Codex's sandbox (the default orchestrator) can write the project but not the home folder, so nothing in the
project (`nextlevel.json`, `.nextlevel/`) decides which code runs. Alternatives weighed: `nextlevel.json` (protected,
so a change waits for the owner's approval; but it is committed, so a channel would travel to every clone and
`candidate` would be shared with whoever pulls) and `.nextlevel/settings.json` (the team can write it). Limit, for
KNOWN_ISSUES: a worker on an engine without a sandbox (Antigravity) runs as the owner's user and can write the home
folder too; only a separate Windows user for agents closes that.

### How the command, START.cmd, `tool.files` and `install.command` find the right version

- **The launcher:** `~/.nextlevel/bin/launch.mjs`, a small file of plain Node with a fixed job: take the project
  (`--project`, else the git root of the current folder), read `channels.json` and `versions.json`, and `import()` that
  version's `bin/nextlevel.mjs`, which then runs as it always did (its `TOOL_ROOT` comes from its own path). A
  `NEXTLEVEL_VERSION` in its environment comes first: the hub puts its own version there for everything it starts
  (with its home's `bin` first on PATH, and `NEXTLEVEL_HOME` when set), so an agent's command, in a slot or the main
  checkout, runs the hub's version. With no project, it runs `release`. A version folder that is missing (removed, or
  quarantined) stops it, with the repair command; it never falls back to another version, which may be older than the
  project's `format`. It is replaced only with a newer one of the same contract, by
  writing a new file and renaming it into place (Node reads a script whole when it starts, so a running one is
  untouched).
- **`nextlevel.cmd`** becomes `node "%USERPROFILE%\.nextlevel\bin\launch.mjs" %*` (the absolute path, as today) and
  never changes again: it is rewritten once, by the migration, which runs only while no nextlevel runs (point 9). The
  sh script for Git Bash does the same.
- **START.cmd** is unchanged: it calls `nextlevel` from its own folder, and the launcher picks the project's version.
  Its last fallback (`~/.nextlevel/tool/bin/nextlevel.mjs`) reaches the clone's checkout, which hands over to the
  launcher.
- **`tool.files`** checks the files of the version that runs, `launch.mjs` and the command's files.
- **`install.command`** runs `nextlevel version` in the project's folder and expects the folder of the version that
  runs the doctor (which is what the launcher picks there). A project on a candidate passes too, and says so.

### The candidate channel

`nextlevel channel candidate main` (or a branch) for a test project. It runs whatever any session pushes to that branch,
so: it is offered on the Tools page with that sentence; the doctor's `install.channel` row is information for it and a
warning when a project with a deploy branch or a running autopilot follows one; it moves only on the owner's click
(Home shows "Update available: 3 new commits on main", the commits' subjects, marked "not released"); the click covers
only the projects that follow that candidate. Going back to `release` is `nextlevel channel release` (an update to the
release, same steps).

---

## 3. The one-click update

### Which hubs, and how the tool knows every project

The click updates **one channel's target**: for `release`, every project that follows `release`; for a candidate,
every project that follows that candidate. Pinned projects are never moved. It covers the running hubs and dashboards
of those projects.

Knowing every project: `rememberProject` runs in every owner command in a project (the menu, `init`, `doctor`, `ui`,
`run`), not only `run`, and keeps all of them, dropping one whose folder or `nextlevel.json` is gone, not the oldest
after 20. A project the tool has never seen runs nothing, so there is nothing to stop; its next start goes through the
launcher, which resolves `release` to the new version. The list only has to be complete for projects that run
something, and those registered themselves when they started.

### Holding new work, without autopilot

A PC-wide hold: `~/.nextlevel/update/hold.json` (`{ protocol: 1, id, from, to, projects, phase, at }`). Every hub
reads it at each tick. While it names the hub's project:

- no task is dispatched and no retry starts (they stay queued, as under `dispatchPaused`);
- no autopilot round starts;
- the jobs a running round or an open orchestrator window asks for (a commit, a merge, a check, a push) still run
  while the update waits: the round may be in `nextlevel wait` on one, and holding it would hold the round until its
  time limit. Once the wait has ended (no round, no window, no task), queued checks, pushes and git jobs wait too,
  except the update's own (marked `by: "update"`);
- what runs goes on: workers, their verifications, a round, a push in progress;
- events still count (a task ending is a real event, FR-019); the hold only defers the round.

The autopilot switch is never touched: turning it off and on would be the owner acting, releasing FR-019's brake and
fuse, and the update is no real event. `rounds.json` is not written by the update. When the hold ends, FR-019 starts a
round only if something real happened meanwhile (a task that ended while the update waited), exactly as it does for
what happened while autopilot was off; the update itself starts none.

Alternative weighed: the hub's `dispatchPaused` setting. Rejected as the mechanism (it is per project, in a file the
team can write, and means "a tool's files are missing"), kept as the model.

### Waiting for running work

The updater waits until, in every covered project:

- **no task job runs** (status `running` or `verifying`): on Windows a windowless worker dies with its hub, so the hub
  is never stopped before its workers finish;
- **no autopilot round runs** (bounded by its time limit);
- **no orchestrator or guide window is open** (`orchestrator.json`, `guide.json`): those are the owner's interactive
  sessions; Home says "Close the orchestrator's window when you're done with it";
- **no question is being answered in the Ask panel** (the dashboard says so in `ui.json`: it is stopped and restarted);
- **no check, push or git job runs** (the hub finishes those when it stops anyway, but a push is better finished held).

A `nextlevel` command run by an agent belongs to a round, a window or a check job, so it is covered above. For the rest,
every nextlevel process that can registers itself (best effort: Codex's sandbox can't write the home folder, so a
sandboxed command doesn't, and still runs; the rounds and windows it belongs to are waited for) in `~/.nextlevel/update/run/<pid>.json` (pid, start time, version, project,
command; removed at exit, a stale one told by pid and start time as `lib/filelock.mjs` does). The updater doesn't wait
for short commands (they run the old folder, which doesn't change), but lists the long ones on Home (a `nextlevel
wait`, an open menu). A `nextlevel fix --local` session runs Claude Code in its own worktree of the clone: it runs no
version's code, so it isn't waited for; the updater's git (fetch, `worktree add`) shares the clone with it, which git's
own locks handle, and the updater never deletes branches or runs a gc while a fix worktree has a session (point 8).

There is no time limit on the wait. Home shows what it waits for, with how long, and **Stop waiting** (cancels the
update: the hold goes, nothing has changed). The owner can stop a task himself on the Build page as always; the update
never stops one.

### What waits for the owner, open windows, an open menu

- **A held change, a deploy push's card, git work the guard stopped:** nothing runs, so the update doesn't wait. The
  records are per project and carry over to the new version (their format is additive). Git work the guard stopped
  means the role docs can't be committed: that step says so and is left for later ("waits for your decision on the
  Notes page"), it isn't a failure.
- **The orchestrator's or the guide's window:** waited for, as above.
- **An open menu (START.cmd):** not waited for. Before a menu (or any version) starts a hub or a dashboard, it checks
  whether its project's channel still points at its own folder; if not, it hands the action to the launcher (the new
  version starts it) and says "nextlevel was updated: close this window and open START.cmd again for the new menu". So
  an old menu's 4 or d never starts old code. This needs the menu to know the protocol: true from the first release.

**Home while it waits:** a card at the top, "Updating to v0.3.0", with each step and its state, what it waits for (the
task, its minutes; "a round runs"; "the orchestrator's window is open"), and Stop waiting. The card is on every covered
project's dashboard (they all read the updater's progress file, `update/<id>/status.json`).

### The steps, in order, and who does them

The **updater** is a process of its own, started detached (so it outlives the dashboard that started it; on Windows a
detached process leaves Node's kill-on-close job and has no window), logging to `~/.nextlevel/update/<id>/update.log`.
One at a time (a lock in `update/`). It runs from the **new** version's folder for every step that touches the new
version, and no process ever runs from files the update changes (none change in place).

1. **Click** (the dashboard, old version): checks the request names exactly the update its card showed (`to` and the
   commit; refused if the offer changed, as Approve is for exactly the change shown), writes `hold.json` (phase
   `holding`) and starts the old version's `nextlevel _update prepare <id>` detached.
2. **Prepare** (old version's code, which changes nothing it runs from): fetch, the tag checks of point 1, `git worktree
   add --detach` into `versions/<name>`, git's maintenance off (point 8), the doctor of each covered project as it is
   now, kept as "before". Then it starts `nextlevel _update run <id>` **from the new folder**, detached, and ends.
   Everything after this runs the new version's code.
3. **Wait** for running work (above), with Home's card.
4. **Backup branch:** for each covered project that sets one (`updates.backupBranch` in `nextlevel.json`, protected,
   so set with the owner's approval; never a deploy branch, which the config refuses), a push job of the base branch's
   head to it, through the hub's `pushBranch` (a plain push, never forced). A failure pauses here, before anything has
   changed, with "Update without the backup" and Stop waiting.
5. **Stop** every covered hub (`hub-stop.json`) and dashboard (`ui-stop.json`, new), after recording how each ran
   (`hub.json` and `ui.json` gain `window`, `version` and the command line: point "restart" below). The dashboard sends
   the page an `update` event before it stops (below).
6. **Switch:** `versions.json`'s `release` (or the channel's target) to the new folder, the previous kept for Go back.
   Anything started from now runs the new version.
7. **Dashboards** start again at once, on the new code, so the owner watches the rest on the new page.
8. **Hubs** start again, held (`hold.json` phase `restarting`).
9. **Role docs** (point 4): refreshed and committed through each hub as the owner's change.
10. **Bridge test** where it must run (point 5), as jobs marked `by: "update"`.
11. **The doctor**, new version, each covered project, compared with "before" (below).
12. **Release the hold.** `hold.json` goes; the hubs dispatch and FR-019 decides about a round (above). Home's card
    shows "Updated to v0.3.0" with the After install checklist. A git gc of the clone runs now, in the foreground of the
    updater, if no fix session runs (point 8). Old version folders that nothing runs are removed.

Alternatives weighed: doing it all in the dashboard's process (it is one of the processes being restarted, and runs the
old code); in a hub (several hubs, and each is stopped); a scheduled task (needs Windows' task scheduler and outlives
mistakes). The hub's old self-install (`installFix`) restarted *itself* in its own window; this keeps its waiting and its
restart, but only after the owner's click.

### Which doctor results stop it, and the checks after the restart

Stopped (paused) by: **a row that passed before and fails after**, at severity warning or error, after steps 9 and 10
(so `project.role-docs` and `bridge.test` are judged once the update has done its part). Not stopped by: a row that
failed before and still fails (shown), a new row (shown), information rows. `bridge.test` failing with `leaked` is
always a stop. The checks after the restart are that whole doctor run plus: each hub's heartbeat on the new version
(`hub.json`'s `version`), each dashboard's record, and the hold seen by each hub (it reports `held: <id>` in `hub.json`).

### Each hub restarts the way it ran

`hub.json` records `window: true|false` (and `ui.json` the same, plus whether it opened the browser). The updater
starts each the same way with the new version: on Windows in a window (`openWindow`, as START.cmd -> 4 does) or in the
background as the dashboard's Start does elsewhere and in tests. Autopilot needs nothing: it lives in the project's
`settings.json`, which the update never writes, so it is as it was. The old hub's window stays open at a prompt
(`cmd /k`) with its last line "nextlevel is updating: the hub goes on in a new window"; a hub started with `nextlevel
run` in the owner's PowerShell comes back in a window of its own, which Home says.

### The dashboards, and the page the owner has open

- The new dashboard opens its own page in the browser when it starts, as every dashboard does today: it is the only
  holder of its new key (and, with FR-017 part 2A, the only one that can make its one-time code). Nothing passes a key
  or a code anywhere: not to the old page, the old server, or a file. So the reopen works the same with today's key in
  the link and with part 2A's code.
- The page the owner has open gets an `update` event before its server stops ("nextlevel is updating to v0.3.0; the
  dashboard opens again in a new tab"), then shows that over the page with "You can close this tab" once its events
  stream ends. Its key is no good on the new server, and it never learns the new one.
- A dashboard started without opening the browser (`--no-open`) restarts the same way and prints its link in its
  window.
- **The click gets the same protection as Approve:** a POST with the key in a header, from the page's own origin, JSON,
  naming exactly the update shown. Go back and Stop waiting the same. Until part 2A, KNOWN_ISSUES's limit applies (the
  key is in the browser's history).

### Paused, and the way back

**Paused** means: the hold stays (no new work anywhere it covered), the updater has stopped at the failed step and
says which, with its output, on Home and in `update.log`; the phone hears it once per project, through `notify()`
(high). The hubs run (on the new version if the failure came after step 8, else stopped hubs are started again on the
old version, held). Home offers:

- **Try again** (from the failed step);
- **Go back to v0.2.1**: the same steps the other way, as one click: stop the covered hubs and dashboards, switch back,
  start them again held, **revert the role-doc commits the update made** (each a `git revert` of that commit through
  the hub as the owner's commit, only if nothing after it touched those files; otherwise left and shown), the doctor,
  release the hold;
- before step 6, **Stop waiting** instead (nothing has changed).

Going back is also on the Tools page at any time ("Go back to v0.2.1"), the owner's.

### The update's signals are a protocol

`hold.json`, `ui-stop.json`, `hub-stop.json`, `hub.json`'s and `ui.json`'s new fields (`window`, `version`, `held`),
`update/<id>/status.json`, the run registry, `versions.json`, `channels.json` and the launcher's contract are kept by
every later version, like the file protocol: a later version may add, never change a meaning. A version updating
**from** a later one (Go back) must understand them, which `protocol: 1` and the format rule above make checkable.

---

## 4. Refreshing the role docs

- **Only templates the owner never edited**: a file whose hash is in `OLD_TEMPLATES` is replaced with the new template.
  Each covered project's hub commits them, one commit per project ("nextlevel v0.3.0: role docs updated to the new
  templates"), as the owner's change (`recordOwner` before the commit, as `doctor --fix` and `init` do), so the guard
  makes no card. The commit's id is kept in the update's record for Go back.
- **Anything else is shown, never changed:** an edited role doc that differs from the new template is a line on Home's
  "Updated" card ("docs/agents/ORCHESTRATOR.md is your own version: `nextlevel init` shows the difference to the new
  template").
- **The templates `init` offers** (AGENTS.md, START.cmd, `docs/tasks/_TEMPLATE.md`, `.env.example`): recognized the same
  way. `OLD_TEMPLATES` covers every template file, not only the three role docs, and a test enforces it: for each file
  in `templates/project/`, its content at the previous release tag (in the test's fake GitHub, and in CI from the
  repository's tags once they exist) is either the current template or listed. An unedited one is refreshed and
  committed with the role docs. The seeds are never touched, and an edited `.env.example` stays the project's.
- **START.cmd** can't change while cmd.exe runs it, which is also between menu runs (cmd.exe reads it as it goes and
  holds it until its window closes), so the run registry, which sees only the node menu, isn't enough. The updater looks
  in one process snapshot (as the installer does for node.exe) for a cmd.exe with that START.cmd on its command line,
  and replaces it only when there is none; otherwise Home shows "START.cmd: a new version is ready" with a Replace now
  button that works once the menu window is closed. Its content rarely changes (it only calls `nextlevel`).

---

## 5. The bridge test after an update

- **When:** for a worker engine whose version changed since its last passing record (what `bridge.test` asks today),
  or when the release changes how slots refuse pushes. The second is told by a constant, `SLOT_PUSH_BLOCK` (a number
  raised by any change to the slots' push block: the push URL rewrite, the hooks, `noPushEnv`), recorded in each
  bridge-test record and compared with the new version's. Never because of the notes.
- **On which engines:** each worker engine in use (the workers role's profiles and its fallback), one run per engine,
  with a record per engine (the Codex-workers pull requests' per-engine verdicts, if they have landed; otherwise this
  adds them).
- **If it fails:** paused (point 3). **If it leaks:** paused, the hold stays, the phone hears it at high priority,
  Home says what the doctor says today ("don't start the orchestrator or autopilot") and offers Go back first.
- **The lock test per role**, if the Antigravity-roles pull request has added it by then: the same rule (an engine's
  new version, or a constant for what it proves), on the roles it covers.
- **An engine updating itself** between nextlevel's updates doesn't start the update. It is what `bridge.test` already
  catches (a red row, an alert on Home). Holding that engine's dispatch until the test passes again is worth doing, but
  it is its own change, not this one.

---

## 6. Announcing

- **Learning of a release:** each running hub fetches (the command in point 1) at its start and every 6 hours, through a
  PC-wide record `update/available.json` (`{ at, release, notes, candidate: {...} }`, under a lock): a hub skips its
  fetch when another fetched less than 6 hours ago. A fetch never installs. The dashboard reads the record; a candidate
  project's dashboard also shows new commits on its branch from the same fetch.
- **Home's card:** "Update available: nextlevel v0.3.0", the notes' Fixes and New lines in plain words, each `Safety:`
  line marked Safety (a label, colored by meaning), the After install lines, which projects and hubs the click covers,
  and the button **Update**. Dismissable until the next release; a safety release's card isn't, and moves to "Needs
  you".
- **The phone:** one message per safety release, per project that follows `release` (pinned ones too, since the owner
  decides there), through `notify()` with that project's root: "nextlevel v0.3.0 has a safety fix: <its line>. Update
  on Home." Recorded per project in its settings so it is sent once. A release without a safety line sends nothing.
- **The start of an owner command** never installs and no longer fetches (15 s of waiting at every start, and the hub
  does it now). It prints one line when `available.json` has a newer release: "nextlevel v0.3.0 is available: Update on
  Home." cli.mjs's `AUTO_UPDATE` and `autoUpdate` go; `--no-update` and `NEXTLEVEL_NO_UPDATE` stay accepted and mean
  "don't fetch, don't announce" (a hub with it doesn't fetch).
- **Once a release is normal:**
  - `install.updates`: passes with "v0.3.0, the newest release, checked <date>"; information "v0.3.1 is available:
    Update on Home"; information for a pin or a candidate (naming it); a warning when the last fetch failed, when a tag
    moved or vanished, or when the install still follows a branch (before the migration, point 9).
  - `updateBlocker` (what `followFixes` says): "comes with the next release" while unreleased; NEXTLEVEL_NO_UPDATE, a
    pin, or changed files in the version's folder as reasons it won't arrive.
  - The install command and the installer: a new install takes the newest release and sets up the launcher; a repair
    (running it again) repairs the launcher, the command and the newest release's folder, and points `release` at the
    newest release (it runs only while no nextlevel runs, so nothing is under it); channels and pins are kept.
    `NEXTLEVEL_REF` takes a release tag only (that release, the owner's own going back); a branch goes through
    `nextlevel channel candidate`. With no release at all yet, it says so and keeps what it has (point 9). Its last line
    becomes "nextlevel updates when you click Update on its dashboard's Home; running this installer again repairs the
    install."

---

## 7. Who may update

- **Only the owner:** the dashboard's Update (and Go back, Stop waiting), and in their own window:
  - `nextlevel update`: **runs the click's steps** (it starts the same updater, holds and waits the same way) and
    prints the progress Home shows, so there is one path. With nothing newer: "nextlevel is up to date (v0.3.0)".
  - `nextlevel update --to <tag>`: to that release (an older one is a going back, and says so first).
  - `--force` goes. It meant "update under running work"; with folders of their own that isn't needed, and "don't wait"
    would mean stopping workers mid-task. The parser then refuses it with the usage, and `--to main` (an old habit)
    refuses with "follow main with: nextlevel channel candidate main".
  - `nextlevel channel [release | pin <tag> | candidate <branch>]`: shows or sets this project's channel.
  - The commands and options go in `src/lib/commands.mjs`; `update` and `channel` refuse in an agent's session, read
    from `src/lib/session.mjs` as the other owner-only commands.
- **A plain `nextlevel update` refuses in an agent's session.** `test/update.test.mjs` asserts today that it succeeds;
  that test changes, and pull request A says so in its description (it changes an existing test's expectation, so the
  architect reviews it).
- **What an agent running as the owner can still do**, for KNOWN_ISSUES:
  - run the update anyway (a command without the variables that mark an agent's session passes for the owner's): it can
    only reach a release that passed the tool's checks, or go back to an older one;
  - make a tag with the owner's GitHub sign-in: the tool takes it only if it is on main's history, newer than the
    installed release and annotated, so it can release code already merged to main (which passed CI and the merge
    rules) but not checked by the owner; nothing else. A tag ruleset doesn't stop the owner's own account;
  - until part 2A, use the dashboard's key from the browser's history to click Update or Go back;
  - write `channels.json` or `versions.json` in the home folder (an agent without a sandbox): point a project at a
    candidate. The doctor's `install.channel` shows every project's channel, and the Tools page too.

---

## 8. Git's maintenance in the tool's clone and its worktrees

- Off in the clone's own config (`git config --local`): `gc.auto=0`, `gc.autoDetach=false`, `maintenance.auto=false`,
  `maintenance.autoDetach=false`. Worktrees share the repository's config, so this covers every version folder and the
  fix sessions' worktrees at once.
- **Set** by the installer (install, repair, move) and by the updater's prepare step, every time (it is idempotent), so
  an existing install gets it at its next update or repair; the migration (point 9) sets it too.
- **Housekeeping still happens, in the foreground:** the updater's last step runs `git gc --quiet` in the clone when no
  fix session runs there, after the hubs are back (nothing runs code from the clone's objects).
- **A test** reads the tool clone's own setting after an install and after an update (`git -C <tool> config --local
  --get gc.auto`, and the other three). The tests' home setting in `test/helpers.mjs` stays until the projects' and
  slots' part, a later hub change, is done.

---

## 9. The pull requests

### A: Releases, versions and channels

The release checks and the private tag fetch, `releases.json`; version folders, `versions.json`, the launcher and the
one-time migration; channels (`channels.json`, `nextlevel channel`, the candidate channel); `nextlevel update` as an
owner-only command that, in this pull request, still needs the hubs stopped by hand (it waits, as today) but moves to
the newest release in a folder of its own; announcing (the hubs' fetch, `available.json`, Home's card with the button
saying "Update with nextlevel update in PowerShell" until B, the safety phone message); field reports through releases;
`install.updates`, `install.channel`, `tool.files`, `install.command`, `updateBlocker`, the installer; git's
maintenance off; CLAUDE.md's Releases section, RELEASES.md, CHECKS.md, DECISIONS, KNOWN_ISSUES, PLAN, the README.
`NEXTLEVEL_HOME` (below). Owner check: on a test project under a trial home (below).

### B: The one click

The hold protocol and the hubs' side of it; the run registry; the updater (prepare, run), its progress on Home and
Stop waiting; the backup branch; the stop and the restart as it ran; the dashboards' stop, reopen and the page's
notice; the role docs and the other unedited templates, committed through the hub; the bridge test's `SLOT_PUSH_BLOCK`
and per-engine reruns; the doctor's before and after; paused, Try again, Go back with the reverts; the menu's handover.
Owner check: the click on a copy of a test project under the trial home, from `v0.1.0` to `v0.1.1` of a local remote (the
real floor, change 4). B's merge commit, once that check passes, becomes `v0.1.0`.

### Trying them before the first real release, without touching a real project's install

- **`NEXTLEVEL_HOME`** (new, in A): the folder nextlevel uses instead of `~/.nextlevel` (state, versions, the launcher,
  channels; the guard's records and second accounts stay in `~/.nextlevel`, keyed by project folder). Unlike a changed
  `USERPROFILE`, it leaves the engines' sign-ins where they are, so real engines work. A trial home also takes port
  offsets above the real home's (it reads the real `state.json`'s blocks, never writes it), so a test project's slots
  never take a real project's ports.
- **A trial script** (dev tooling, `scripts/trial.mjs`): makes `~/.nextlevel-trial` with a local bare remote holding the
  pull request's commit as `v0.1.0` and a commit after it (a documentation line) as `v0.1.1` (the real floor: the trial
  home has its own `releases.json`), installs `v0.1.0` there, and makes **a copy of a test project** (a fresh clone of
  it in a folder of its own, with its `nextlevel.json` and `.env`, its name changed so its slots' Docker stacks are
  its own), never a test project itself: the guard's records and the second accounts live in the home folder, so a trial
  hub on a test project would leave git settings the real install has no record of, and stop its git work. The owner runs
  `%USERPROFILE%\.nextlevel-trial\bin\nextlevel.cmd` in the copy (not START.cmd, whose `nextlevel` is the real one).
  Test tags never reach GitHub. A real project's install and its command are never touched; in `~/.nextlevel` only the guard's
  records for the copy are written (a folder of their own, which the script names for deleting afterwards). Profiles on
  a second account use the owner's own `~/.nextlevel/accounts`.
- The installer's `NEXTLEVEL_DIR` is not used for this: it moves the owner's install.

### Keeping a real project's install from taking A or B by itself

Before A merges, and only after the queued fixes (Antigravity roles) are installed on a real project, the owner pins the
install the real projects run, in their PowerShell: `nextlevel update --to <main's head then>` (the session names the exact commit
when A is ready). Pinned, today's code never updates itself at a command's start and the hub never installs (FR-017), so
nothing of A or B arrives until the last manual pause; anything merged after the pin waits for `v0.1.0`. They don't run
the installer until then either (once A merges, the install command runs A's installer, which migrates). Today's
installer keeps a pinned clone pinned; A's installer moves a pinned old-layout install to the newest release, since the
pin existed for exactly that pause (a pinned install that already has the new layout stays pinned).

### From following main to releases

- **The last manual pause** ("After install on a real project", B's description): stop the hub and the dashboard, close the
  menu and the orchestrator's window, run the install command (the installer refuses while any nextlevel runs), which
  migrates: the newest release (`v0.1.0`) into `versions/v0.1.0`, `versions.json`, the launcher and `nextlevel.cmd`
  rewritten once (nothing runs it now), git's maintenance off, every known project on `release`; then the doctor, the
  hub, the dashboard. The update after that is the first one-click update.
- **While no release exists**, an install that knows releases stays where it is and says "no release yet"; it never
  moves to main's head (that is what the candidate channel is for).
- **Never to a release older than the code that knows releases:** `FIRST_RELEASE = v0.1.0`. A tag below it is not a
  release (its code has no launcher and no hold, so the next update couldn't run from it), and `update --to` refuses it
  (as `--to` refuses a ref older than update.mjs today).
- An old-layout install (the clone's checkout running directly) found by new code at a command's start runs as it is
  and says "run the install command to finish moving to releases" (`install.updates`, warning); new code never rewrites
  the command itself outside the installer.

### Tests (for step 2)

With the fake GitHub tool (`fakeGithubTool`, with annotated tags; its `release()` makes a commit on main, so it becomes
`commit()`, and `release(name, notes)` makes a tag), stub hubs and engines, never the real CLIs: the update goes to the
newest release, never main's head; a moved, vanished, lightweight, off-main or older tag is refused and later fetches
still work; Home's card and its safety marks; one phone message per safety release per project; the click holds,
waits for a stub worker and round, stops, switches, runs the doctor, refreshes and commits an unedited role doc (an
edited one left and shown), reruns the bridge test only for an engine's new version or `SLOT_PUSH_BLOCK`, restarts each
hub as it ran with autopilot as it was and FR-019's brake and fuse untouched; a failing step pauses, Try again and Go
back work, with the role-doc commit reverted; a merged fix waits for its release and its check runs once installed; an
agent's session can't update or change a channel; the clone has git's maintenance off; a candidate project runs its
branch's version while another runs the release, side by side. Broken on purpose once each, to see these fail: an
update that installs without the click; an update that doesn't wait for running work. The session's own browser check
runs a throwaway install under a `USERPROFILE` of its own with stub engines and a copy of a test project, both themes and
phone width.

## Security: the boundaries and what holds each

A threat-model pass over the design (rafter's secure-design walk), per place where something less trusted meets
something more trusted. Step 2 runs rafter's code review and `rafter run` on each pull request.

| Boundary | What could go wrong | What holds it |
|---|---|---|
| GitHub to the tool (fetch, tags) | A moved or deleted tag, a tag on a side branch, a lightweight tag, a tag named like an option (`-x`) passed to git, a fetch failing for good | The private namespace with a forced refspec; the name's pattern checked **before** any git command gets it (it can't start with `-`); annotated, on main, newer than installed, never moved (`releases.json`); refusals said, never followed |
| The tag's notes to Home and the phone | Text written by whoever made the tag | Shown as text nodes (`src/ui/dom.js`), never HTML; to the phone only through `notify()` (redacted); never run or followed: what the update does comes from code |
| The browser to the dashboard (Update, Go back, Stop waiting) | Another page or program clicking for the owner; a click on an offer that changed meanwhile | As Approve: the key in a header, same origin, JSON, the exact version and commit named; the new key is never handed on. Residual until FR-017 part 2A: the key in the browser's history (KNOWN_ISSUES) |
| Agents to the home folder (`channels.json`, `versions.json`, `hold.json`, the run registry) | A project pointed at other code; the launcher made to import a file elsewhere; a hold that never ends | The launcher imports only `bin/nextlevel.mjs` of a folder **directly under** `versions/` whose name is in `versions.json` and matches the version-name pattern, never a path read from a file; candidate branch names checked like push targets (`src/lib/push.mjs`: a plain name), and the folder name made from them, never the branch as given; a hold names its update id (a random pattern), and Home always offers Stop waiting. Residual: an agent without a sandbox runs as the owner and can write these files (KNOWN_ISSUES; a separate Windows user closes it) |
| The updater (a detached process) | Running the wrong code, or code from a folder being changed; an argument from a file | Started with an update id only (validated), reads its plan from `update/<id>/`, which only the click and the updater write; runs from the new version's folder after prepare, and no folder that runs is ever changed; one updater at a time (lock) |
| The update to the projects (commits, pushes) | A commit or push the owner didn't approve | Role docs only when their hash is a known template (nothing of the owner's in them), committed as the owner's through the hub; the backup push through `pushBranch`, never forced, never a deploy branch; protected files other than those go through the guard as always |
| Making a release (a session with the owner's sign-in) | Releasing code nobody checked | Only on the owner's words, on the commit they checked; the tool takes only commits on main (protected: CI and the merge rules). Residual: an agent with the owner's sign-in can tag merged but unchecked code (KNOWN_ISSUES); the owner's tag ruleset limits moves and deletes, not creation |

Worst single compromise: the owner's GitHub sign-in. With it, someone can merge to main only through the protected
branch's checks, so the most a tag can do is release merged code early. The answer in an incident: pin every project
(`nextlevel channel pin <tag>`) and Go back, both local and without GitHub.

## Open questions for the reviewer

1. `FIRST_RELEASE` on B's merge commit means A ships to no one by release; it reaches the real projects with B. The alternative
   (release A alone as `v0.1.0`) would make the first one-click update the move from A to B, which is a better test of
   the click, but A has no click: that update would be the manual `nextlevel update` of A. I lean to one release after
   B.
2. Folder per version versus two alternating folders, for antivirus exceptions (point 2). I chose a folder per version.
3. `updates.backupBranch` in `nextlevel.json` (protected, committed) versus a PC-wide setting per project. I chose the
   former, so the backup branch is visible and reviewed like `deployBranches`.
