# Brief

What to build. The owner writes this; the orchestrator plans from it and treats it as the source of
truth. Keep it short and concrete, and change it whenever the plan changes.

## Goal
<One paragraph: what the product does, for whom, and what "done" looks like.>

## Users and main flows
- <Who uses it, and the few things they must be able to do.>

## Requirements
- R1 <A requirement someone could test.>
- R2 <...>

## Stack and environment
<Languages, frameworks, package manager; how to install, run and test it locally. The owner's PC,
e.g. Windows 11 with PowerShell, Git, GitHub CLI, Node.js 24, Docker Desktop.>

## Milestones
| Milestone | What is true when it's done |
|---|---|
| M0 Foundation | <repo builds, tests run, CI green> |
| M1 First feature | <...> |

## Production and secrets
<Where it runs and how it deploys (e.g. on every push to main). Which secrets exist and where they
live: `.env` on the owner's PC, the host's settings in production. Anything agents must never do
there.>

## Out of scope
<What not to build.>
