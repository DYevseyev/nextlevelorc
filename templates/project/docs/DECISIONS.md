# Decisions

Choices the orchestrator made without asking the owner, and blockers that were resolved
(docs/agents/ORCHESTRATOR.md). The dashboard's Project page shows each entry as a card. Decisions only: what was
decided and why, a few lines each. What happened in a round stays in that round's log (.nextlevel/logs/), and what
the next round must know goes in docs/STATUS.md. Newest at the bottom, one entry each, in this form:

<!--
## 2026-09-26 — Postgres, not SQLite
Why: several workers run tests at once, and SQLite locks the file. Alternatives: SQLite with one test worker.

## 2026-09-27 — Resolved: the SMTP host was missing
What it blocked, and how it was resolved (the owner put it in .env; H3).
-->
