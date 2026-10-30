# nextlevel

Run an AI build team from your own PC. An **orchestrator** plans your project into small tasks, reviews the results
and merges them; **workers** build each task in a checkout of their own; a **hub** connects them through files,
verifies every task with its own tests, pushes when asked, and tells your phone when something needs you. Codex,
the Antigravity CLI and Claude Code can each take any role, with your own accounts. Setup is a program, not a
document: every problem a real user hits becomes a check with a fix (`nextlevel doctor`).

Homepage: [nextlevelorc.com](https://nextlevelorc.com)

**Status: preview.** Windows 11 first; Linux and macOS work too. It changes fast, and some safety work is still
ahead (see [How safe is it](#how-safe-is-it)).

## What you need

- Node.js 22 or newer and Git (the installer offers to install both with winget).
- Your own account for at least one of Codex, the Antigravity CLI (`agy`) or Claude Code, signed in on this PC.
  nextlevel only drives the official CLIs you are signed into, with your accounts and your plans. Check each
  provider's terms for how you may use their tool; nextlevel adds nothing that gets around a provider's limits.
- A git repository for your project. Phone notifications are optional (an [ntfy](https://ntfy.sh) topic).

## Install

Once per PC. In **PowerShell** (a normal window, not "Run as administrator"), in any folder:

```powershell
irm https://raw.githubusercontent.com/DYevseyev/nextlevelorc/main/install.ps1 | iex
```

Open a new PowerShell window and check: `nextlevel version`. Running the same command again repairs the install.
nextlevel updates only to a release, and only when you say so (Home's **Update**, or `nextlevel update`).
On Linux and macOS: `git clone https://github.com/DYevseyev/nextlevelorc.git ~/.nextlevel/tool`, then
`node ~/.nextlevel/tool/bin/nextlevel.mjs _install` (it says what to add to PATH).

## Start a project

In PowerShell, in your project's folder:

```powershell
nextlevel init       # adds nextlevel.json, BRIEF.md, AGENTS.md, docs/agents/, START.cmd, .env.example
git add -A
git commit -m "chore: set up nextlevel"
nextlevel doctor     # checks tools, sign-ins and the project, and says how to fix each problem
```

Write what you want built in `BRIEF.md`. Then double-click `START.cmd` for the menu (the setup guide, the hub, the
orchestrator, autopilot, the bridge test) and press **d** for the dashboard, which shows what runs, what needs you and
the next action.

An optional **security engineer** scans your code for security problems when you ask, in OpenAI's Codex Security
scanner in Docker, and never changes the code. Home and its Security page show the findings, and a policy you
approve on a card guides every scan. A daily watch tells you when OpenAI's Daybreak Blue covers a new model (`docs/GUIDE.md`,
"The security engineer").

## How safe is it

What nextlevel does for you:

- **Workers never push** (git refuses it in their checkouts; the bridge test proves it against a real remote) and
  get no secrets (their checkouts have no `.env`).
- **Files that steer the agents** (hooks, MCP configs, instruction files, workflows, `nextlevel.json`, `START.cmd`)
  change only with your **Approve** on the dashboard, and so does a push to a deploy branch, for exactly the commit
  its card shows.
- The dashboard listens only on 127.0.0.1, and its link carries a one-time code, never a key.
- A command asked for `--help` never acts; every push names its branch and goes through one place.

What it doesn't do yet: **every agent runs as your own Windows user**. An engine without its own permission checks
(Antigravity today, and Codex when you turn its sandbox off) can read and write anything you can, and a determined
agent can undo the environment that marks it as an agent. Keep that in mind when choosing engines;
[SECURITY.md](SECURITY.md) and [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md) say exactly what an agent can still do.

## Field reports

When a check won't pass, `nextlevel report <check>` writes a field report: nextlevel's own facts (check results,
versions, paths with your home folder as `~`, the last hub log lines), never your code, brief or `.env` values, and
anything that looks like a secret replaced with `***`. It shows you the report first and files it only if you say
yes, as a **public** GitHub issue in this repository. Leave out anything you don't want public before you answer.

## Documentation

- [docs/GUIDE.md](docs/GUIDE.md): the full guide (install options, updates, the dashboard, `nextlevel.json`,
  protected files, engines, profiles and second accounts).
- [docs/CHECKS.md](docs/CHECKS.md): every setup check and its fix.
- [docs/ANTIVIRUS.md](docs/ANTIVIRUS.md): if an antivirus stops a worker.
- [docs/KNOWN_ISSUES.md](docs/KNOWN_ISSUES.md): how the real CLIs misbehave, and what isn't covered yet.
- [docs/ROADMAP.md](docs/ROADMAP.md) and [docs/HISTORY.md](docs/HISTORY.md): where it goes and how it got here.
- [CONTRIBUTING.md](CONTRIBUTING.md) and [CLAUDE.md](CLAUDE.md): working on nextlevel.

## License

[Apache License 2.0](LICENSE). Copyright The nextlevel authors.
