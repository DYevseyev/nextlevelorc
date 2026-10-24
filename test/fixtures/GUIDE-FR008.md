# Setup guide

You help the owner set up this project's AI build team, one step at a time. You can be Codex,
Antigravity or Claude Code; the steps are the same.

## How to guide
- Start by running `nextlevel doctor` and use its output to see what's already done. Fix one item at
  a time and re-run the doctor after each. `nextlevel doctor --fix` does the fixes it can by itself;
  `nextlevel doctor --json` gives each check's id, result and steps.
- **Inside Codex** you run in its sandbox, which hides the owner's sign-ins, Docker, other programs and
  the network. The doctor then says so in its first row ("Sandbox"), and rows it can't see from there
  say "can't tell": they are not the real state, so don't ask the owner to install or sign in again
  because of them. See the real state with the hub (`nextlevel verify doctor -- nextlevel doctor`, then
  `nextlevel wait <job-id>` and `nextlevel result <job-id>`), or ask the owner to run `nextlevel doctor`
  in a normal PowerShell window in the project folder and tell you what it shows. The sandbox can't
  write `.git` either: commit with `nextlevel commit -m "..."` (the hub does it).
- Each step the doctor prints says where it is typed: PowerShell, a new PowerShell window, the
  browser, a text editor, or *inside* Codex, agy or Claude Code (slash commands like `/model` are
  typed there, never into PowerShell). Pass that on to the owner exactly.
- The owner can also follow along in the dashboard (START.cmd -> d): its Setup page shows the same
  checks, each step with its window and a Copy button, and fixes what it can with one click.
- Run commands yourself when you can, and verify every step before moving on.
- Installs and sign-ins that need the owner (browser logins, installers, `gh auth login`,
  `codex login`, the first `agy` sign-in): tell the owner exactly **which window** to type the command
  in — a normal PowerShell window in the project folder, not inside Codex or agy — then re-check.
  START.cmd -> 1 (Doctor) can install most tools.
- For steps in web panels, say exactly what to click and what to enter, then verify the result.
- Never ask the owner to paste passwords, tokens or keys into the chat. They type secrets into `.env`
  (or the relevant panel) themselves. Never print secrets back.
- Keep answers short: one step, what to do, how we'll know it worked.
- If the project has a `docs/SETUP.md` with its own steps (hosting, domains, email), work through it
  after the steps below and tick each step there once it's verified.

## The steps
1. **Tools**: the doctor shows `ok` for Node.js, Git, GitHub CLI and the orchestrator and worker CLIs.
2. **Project on GitHub**: at least one commit, on the base branch (`baseBranch` in `nextlevel.json`,
   usually `main`), with an `origin` remote. The doctor prints the exact commands.
3. **Sign-ins and models**: for each engine the roles use (`roles` in `nextlevel.json`): `codex login`;
   run `agy` once in PowerShell and sign in; `claude auth login` for Claude Code. A profile with an
   `account` of its own (a second Codex or Claude Code account) is signed in with
   `nextlevel login <profile>` in PowerShell, in the project folder; `nextlevel login` alone shows who is
   signed in where. Antigravity can't have a second account on one PC user: the doctor says so. Pick
   models with `/model` inside each tool, or pin them in `nextlevel.json` under `roles` or `profiles`
   (copy the exact name from `/model`: names the owner's account can't use are rejected).
4. **Worker safety rules**: answer yes when the doctor offers them (an extra layer that asks agy not to
   push, delete, ssh or use gh; git itself stops workers from pushing, and the bridge test proves it).
5. **Phone notifications**: install the ntfy app, subscribe to a long random topic, put it in `.env`
   as `NTFY_TOPIC`, then test with `nextlevel notify --now "Test" "hello"`.
6. **The brief**: `BRIEF.md` says what to build. The owner writes it; help them make it concrete
   (testable requirements, milestones, stack, production rules).
7. **Bridge test**: START.cmd -> 4 (hub; leave its window open), then START.cmd -> 8.

## Finish line
Setup is ready when the doctor is all `ok` and the bridge test passes: two workers finish in parallel
and it says `Workers can't push: they tried, and nothing arrived at the test remote`. Then explain the
launch: START.cmd -> 4 (hub) and -> 5 (orchestrator), or -> 6 (autopilot), and that the owner steers
by writing in `docs/OWNER_NOTES.md`. The dashboard (START.cmd -> d) does all of that in the browser and
shows the build live.

## Troubleshooting you may need
- **A worker window asks something on its first run** (for example to trust the folder): the owner
  answers it in that window; each slot asks once.
- **A worker window opens but nothing happens, or the job ends as timeout with no report:** run
  `agy -p "say hi"` in a normal PowerShell window. If that works, re-run the bridge test; if it hangs
  too, run `agy update`. Meanwhile workers can run on their fallback (Codex unless `nextlevel.json`
  says otherwise): `nextlevel retry <id> --fallback --feedback "rerun"`.
- **The bridge test says `push attempt: RAN` and passes:** agy's own rules didn't stop the command
  (known on Antigravity CLI 1.2.11), but git refused it and nothing arrived. Nothing to fix.
- **The bridge test says `FAILED: a worker's push arrived`:** stop. Don't start the orchestrator or
  autopilot. The job records, branches and test remote are kept; help the owner file it as a field
  report with what `nextlevel result T000-bridge-1` shows. Don't delete the evidence.
- **A job ends as `error` with `could still push to "origin"`:** the project's git config has a
  `remote.origin.pushurl`. The error gives two fixes (update Git, or remove the setting); run the one
  the owner picks in PowerShell, in the project folder.
- **Codex says it is "running without the shared background server":** `engines.codex.args` in
  `nextlevel.json` has a `-c` setting (older projects got one). The doctor's "Codex overrides" row
  removes it (`nextlevel doctor --fix codex.args`).
- **Codex complains about `--sandbox`:** adjust `engines.codex.args` in `nextlevel.json` to what
  `codex --help` shows.
- **Codex prints "Hook failed" around every tool call:** a hook in the owner's Codex settings or a
  Codex plugin runs a program that isn't there. The doctor's "Codex hooks" row names it and the file
  to fix; it isn't a nextlevel problem.
- **Codex rejects its model, or doesn't offer the newest ones:** the "Codex version" and "Codex
  model" rows say what to update or change (an older Codex doesn't know newer models).
- **Autopilot cycles fail with a sandbox setup helper error:** more than one Codex install is on PATH;
  keep one (the doctor lists them).
