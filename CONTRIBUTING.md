# Contributing to nextlevel

Thanks for helping. nextlevel is a preview and changes fast, so a short issue before a large change saves everyone
time. `CLAUDE.md` has the full rules and the map of the code; this is the short version.

## The rules that matter most

- **Zero runtime dependencies.** Node.js 22 or newer, built-ins only, no build step: installing must not be able to
  break on someone's PC. Dev tooling is fine if nothing needs it at runtime.
- **Tests first.** `npm test` runs everything (no install step). Tests run the real `nextlevel` command against stub
  CLIs (`test/stubs/`): never call the real `agy`, `codex` or `claude` in a test. Never skip, weaken or fake a test to
  get green. Tests wait for events, never a fixed time.
- **Windows first, POSIX too.** Read `docs/KNOWN_ISSUES.md` before touching how processes start, quoting, paths or
  consoles.
- **A new command** goes in `src/lib/commands.mjs` (usage, options, arguments) and reads them with `commandArgs`, so
  `--help` never runs it. A new push goes through the hub's `pushBranch`, nowhere else.
- **A new setup check** gets a unit test on a fake PC (`test/fake-context.mjs`) and an entry in `docs/CHECKS.md` (a
  test enforces both).
- **Safety by construction.** Workers never push and get no secrets; files that steer agents change only with the
  owner's Approve on the dashboard; nothing an agent can write may approve anything. A change that weakens one of these
  needs a very good reason in its description.
- **Harmless test content.** A test hook runs `echo guard-test`, not something that looks like an attack: antivirus
  programs remove files that do.

## Pull requests

- One step per pull request, small enough to review. Record a non-obvious choice in `docs/DECISIONS.md`.
- Open it as a draft; the `ubuntu` check runs on each push. Mark it ready for review when it's done: that starts the
  `windows` check (about 20 minutes). Both must be green on the last commit, and the branch up to date with main.
- If it needs checking on a real Windows PC (consoles, an antivirus, a real CLI), end the description with a
  **Manual check** section (the exact command, which window to type it in, what you should see), and an **After
  install** section (what a user does after updating, or "Nothing").
- Pull requests from forks wait for a maintainer to approve their workflow runs. A pull request that changes
  `.github/`, `.github/ci/changes.mjs`, `test/ci.test.mjs` or the scripts in `package.json` says so at the top.
- By contributing you agree that your contribution is licensed under the Apache License 2.0 (its section 5); no
  separate agreement or sign-off is needed.

## Field reports

`nextlevel report` files a public issue labelled `field-report` from a user's PC. Turning one into a check with a fix
and a test (and a line in `docs/FIELD_REPORTS.md`) is the best kind of contribution: nobody hits that problem twice.

## Security

Never in a public issue: see `SECURITY.md`.
