# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue:

- GitHub's private vulnerability reporting: the repository's **Security** tab, then **Report a vulnerability**; or
- e-mail **security@nextlevelorc.com**.

Say what an attacker can do, and how to reproduce it. You'll get an answer within a week. Please give us a chance to
fix it before you publish anything.

## What is in scope

- The guard: files that steer the agents (hooks, MCP configs, instruction files, workflows, `nextlevel.json`,
  `START.cmd`) changing without the owner's Approve on the dashboard.
- Pushes: a push to a deploy branch without the owner's Approve, a push that carries a `.env` value, or anything that
  lets a worker push.
- Secrets: a `.env` value reaching a worker, a field report, a phone message or a commit.
- The dashboard: anything that lets another program or web page act on it, or read its session key.
- The installer and updates: installing or running code that isn't a release the owner chose.
- An owner-only command (`update`, `channel`, filing a report) working from an agent's session in a way
  `docs/KNOWN_ISSUES.md` doesn't already list.

## Known limitations (not vulnerabilities)

nextlevel is a preview, and some protections are not built yet:

- **Every agent runs as your own user.** An engine without its own permission checks (the Antigravity CLI today, and
  Codex with its sandbox turned off) can read and write anything that user can, including nextlevel's own files.
- The environment that marks a session as an agent's, and the block on pushes from verify commands and the
  orchestrator's rounds, stop accidents; an agent that sets out to undo them can.
- `docs/KNOWN_ISSUES.md` lists these and the rest. A report that shows one of them is worse than described there is
  welcome.

## Supported versions

Only the newest release gets fixes. Releases are annotated tags `vX.Y.Z` on main; a release tag is never moved or
deleted, and the tool refuses one that was.
