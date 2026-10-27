# Roadmap

What comes next, roughly in order. nextlevel is a preview: this list changes as real use finds new problems, and a
field report that blocks someone comes first. `docs/HISTORY.md` has what is done.

## Safety: from bars to walls
- **Workers can't reach the hub at all** (FR-017 part 2). Today a worker whose engine runs shell commands can still
  find the main project's `nextlevel` and its queue; the checks that stop it read variables a worker could clear.
- **The agents as another Windows user** (FR-017 part 2B: a separate account, a container or WSL). Every agent runs as
  your own user today, so an engine without its own permission checks can read and write anything you can
  (`docs/KNOWN_ISSUES.md`, "What an agent running as the owner can still do"). This turns what stays open into walls.

- **Codex's reads behind a wall too** (FR-023). On Windows its sandbox stops writes and the network, not reads, so the
  orchestrator and Codex workers can read your other files (a `.env`, Codex's own sign-in). Next: deny the folders a
  role has no business reading with Codex's permission profiles, then another user or a container (above).

## The team
- **A stuck task gets help** (the stuck ladder): when attempts keep failing, the hub says so and offers the next step
  instead of only counting attempts (FR-020 records how each attempt ended).
- **Gemini 4 Argon in more roles**: the orchestrator and the advisor can run on Antigravity behind the lock test; a
  review-only security role is next, or stays off Antigravity.
- **The advisor's own reviews** (`docs/design/advisor.md`, part 2): at a milestone's midpoint and end and when progress
  stalls, a read-only review reported to you, never to the orchestrator, within a daily cap. The advisor itself (Advise
  and Quick, its memory, drafts only your click sends, Explain on cards) is done.

## The security engineer
Scans of the project's code in OpenAI's Codex Security scanner (`docs/design/security-engineer.md`). Part 1a-1, the
role, its checks and `nextlevel security scan|status|stop|login`, is done.
- **1a-2, on the dashboard:** Home's Security tile and buttons, a Security page, and the SECURITY.md card (a policy only
  your Approve makes count).
- **1b:** a Claude Code version, a watch for the models Daybreak covers, SECURITY.md committed to the repository.
- **2:** findings in autopilot rounds, a merge gate and the fix loop, dismissing a finding.
- **3:** supply chain, automatic scans, phone alerts.

## The tester
Acceptance runs of plans in `docs/acceptance/` against a running copy of the app, as test accounts you name
(`docs/design/tester.md`, `docs/acceptance.md`). Part 1, plans and HTTP runs from PowerShell with the sign-ins sealed on
this PC, is done; part 2, the browser (Playwright installed by you at a pinned version, a fresh context per persona,
screenshots with masks), is built.
- **3, closing the loop:** cards with plans close on a passing run, a failing one drafts a fix task for the orchestrator,
  runs after a deploy.
- **4, on the dashboard:** the Team row, the evidence table, the sign-ins form.

## GitHub checks on your PC
- **The self-hosted runner, part B**: for a personal account's private repository, run its checks on a runner on this
  PC, as an account of its own that reaches nothing of yours (`docs/design/self-hosted-runner.md`). Part A, which says
  where the checks run and whether this would help, is done. Never for a public repository.

## Contributing to nextlevel itself
- **CI that holds by construction**: a guard workflow on `pull_request_target`, and CI checks for skipped or deleted
  tests, weakened assertions and a dropping test count, so the rules in `CLAUDE.md` don't depend on everyone following
  them.
