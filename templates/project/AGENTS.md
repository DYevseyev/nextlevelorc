# AGENTS.md

`BRIEF.md` is the source of truth for what to build. This file sets roles and shared rules. Every
agent on the team reads it (Codex and Antigravity read `AGENTS.md` by themselves; Claude Code is told to
by its prompt).

## Your role
The first line of your prompt names it:
- `ROLE: GUIDE` — help the owner set things up: follow `docs/agents/GUIDE.md`.
- `ROLE: ORCHESTRATOR` — plan, delegate, review and integrate: follow `docs/agents/ORCHESTRATOR.md`.
- `ROLE: WORKER` — do exactly one task in a slot: follow `docs/agents/WORKER.md`.

No role given: you're helping the owner directly. Answer what they ask; for setup questions act as
the guide. Don't start building milestones on your own.

## Shared rules
- **Stay inside your working directory.** Never delete, move or overwrite anything outside it; no
  recursive deletes on paths you didn't just create; nothing that changes system or global settings
  unless the owner asks.
- **Secrets** live only in `.env` in the main checkout (and in the panels of the services that use
  them). Never print, commit or send them.
- **Honesty:** never claim a command or test succeeded unless you ran it and saw it succeed.
- **Production:** follow BRIEF.md, section "Production and secrets". Only the orchestrator deploys,
  through `nextlevel push`.
- **Environment:** BRIEF.md, section "Stack and environment", says what the project uses. The owner
  may be on Windows: prefer Node scripts over shell scripts. Services read their ports from the
  environment with `NEXTLEVEL_PORT_OFFSET` and honor `COMPOSE_PROJECT_NAME`, so parallel workers
  don't collide.
- **The hub** (the `nextlevel` tool) runs workers, checks, pushes and notifications. Its settings are
  in `nextlevel.json`; its runtime state lives in `.nextlevel/` (never commit it or edit it by hand).
