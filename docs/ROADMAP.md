# Roadmap

What comes next, roughly in order. nextlevel is a preview: this list changes as real use finds new problems, and a
field report that blocks someone comes first. `docs/HISTORY.md` has what is done.

## Safety: from bars to walls
- **Workers can't reach the hub at all** (FR-017 part 2). Today a worker whose engine runs shell commands can still
  find the main project's `nextlevel` and its queue; the checks that stop it read variables a worker could clear.
- **The agents as another Windows user** (FR-017 part 2B: a separate account, a container or WSL). Every agent runs as
  your own user today, so an engine without its own permission checks can read and write anything you can
  (`docs/KNOWN_ISSUES.md`, "What an agent running as the owner can still do"). This turns what stays open into walls.

## The team
- **A stuck task gets help** (the stuck ladder): when attempts keep failing, the hub says so and offers the next step
  instead of only counting attempts (FR-020 records how each attempt ended).
- **Gemini 4 Argon in more roles**: the orchestrator and the assistant can run on Antigravity behind the lock test; an
  advisor and a review-only security role are next, or stay off Antigravity.

## GitHub checks on your PC
- **The self-hosted runner, part B**: for a personal account's private repository, run its checks on a runner on this
  PC, as an account of its own that reaches nothing of yours (`docs/design/self-hosted-runner.md`). Part A, which says
  where the checks run and whether this would help, is done. Never for a public repository.

## Contributing to nextlevel itself
- **CI that holds by construction**: a guard workflow on `pull_request_target`, and CI checks for skipped or deleted
  tests, weakened assertions and a dropping test count, so the rules in `CLAUDE.md` don't depend on everyone following
  them.
