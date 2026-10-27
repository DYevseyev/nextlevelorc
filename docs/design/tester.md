# The tester: design

Written 26 October 2026 against nextlevel's main ea72256, for the owner's feature request "Tester role for automated
acceptance verification". Written to be public as it stands: it becomes `docs/design/tester.md` in the first pull
request. Every example is generic (a notes app at `staging.example.com`); no real project is named.

It reuses the security engineer's design (`docs/design/security-engineer.md`, in flight) where the problems are the
same: a role off by default and out of `profilesInUse`, a run that is the hub's own process and not a job, the
guard's folder for what agents must not write, one redaction step before anything is kept, a usage row, the doctor
naming what is missing. It touches none of that design's code until its pull requests have merged (§13).

## 0. Where the request meets nextlevel's rules

The request is adopted whole, but for five places where a rule of this repository decides how. Each is a decision
for the review (§14).

| The request says | nextlevel's rule | This design |
|---|---|---|
| `roles.tester.engine`: the tester is an AI role | "Cheap brains type, expensive brains think"; safety by construction: credentials must never reach a prompt | **The runner is a program, not a model.** A plan declares every step, so walking it needs no AI, costs no tokens, and no model ever holds a persona's password or sees a page signed in. The section has no engine. A later part may add one that only explains a failure from the redacted evidence (§12) |
| Plans in `docs/acceptance/<feature>.yaml` | Zero runtime dependencies: Node has no YAML reader | A **strict YAML subset** with a small reader of our own (block maps and lists, one-line flow maps and lists nested at most four deep, plain and quoted scalars, comments; no anchors, aliases, tags, multi-documents, multi-line scalars or flow collections across lines), linear in a line's length like the roadmap's patterns, and refusing anything outside it with the line number. Every file it reads means the same in any YAML 1.2 reader. Scalars are typed by the plan's shape, never by YAML's guesses (`no`, `on`, `0x1F`, `1e3` are what the field's type says). `.json` plans are read too. The subset is written down in `docs/acceptance.md` |
| Playwright | Zero runtime dependencies; a worker can write the project's `node_modules` | HTTP steps run on Node's own `node:https` / `node:http` with an address lookup of our own (part 1, §6). The browser (part 2) is Playwright **installed by the owner at a pinned version into `~/.nextlevel/tools/`**, offered by the doctor's fix with the owner's yes; never the project's own copy, which an agent could have changed, and never `npx` at run time |
| A failure sends a fix task to a worker automatically | The orchestrator plans and dispatches; the hub verifies | The hub writes a **fix task draft from code** (the plan, the step, expected, actual: never an AI's words) and starts an autopilot round; the orchestrator commits it as a task spec and dispatches it. With autopilot on, nobody clicks; with it off, the card says the draft waits for the orchestrator. `tester.autoFix` (the hub dispatching the draft itself) is a question for the review, recommended later |
| Triggered on a schedule | FR-019: nothing timed starts a round | A scheduled run is not a round. Its end starts one only when its result is new (another plan, step or actual result than that plan's last run) and under the brake (§8) |

## 1. What the owner gets (all parts)

- A **Tester** row on the Team page and in `nextlevel team`: Off until the owner turns it on. No model, no tokens.
- **Acceptance plans** in the repository, written by workers with the feature, run against the environments and as
  the personas the owner named in `nextlevel.json` (a protected file: only the owner's approval changes them).
- **Persona sign-ins** entered once by the owner (`nextlevel tester persona set`, later a dashboard form), kept in
  the PC's own secret store, never in the repository, a prompt, a log, evidence, a phone message or a report.
- **Runs** from Home (Run acceptance), from a handoff card that names a plan, after an approved deploy, after a fix
  merges, and on a schedule. Evidence per step (screenshot or redacted response, timing, expected, actual) in
  `.nextlevel/evidence/<run id>/` and as a table on the card.
- **Cards that close themselves on proof:** all steps pass → "Verified, ready to close" (one click, or closed by the
  hub when the owner turned `autoClose` on); a step fails → the card stays open with that step, and a fix task goes
  to the team; after the fix is merged and deployed, only that plan runs again. Where a deploy branch needs the
  owner's Approve (FR-015), that Approve is still the owner's: the loop waits for it, and Home says so.
- A **Tester** row on Today and in the usage ranges: runs and minutes.
- With the tester off: nothing changes. No check fails, no prompt grows, no template changes what a worker does.

Out of scope, as the request says: load and performance testing, visual baselines, native desktop or mobile apps.
Also out for now: personas that need a second factor (TOTP, SMS, passkeys), sign-in through a third party's page
(an identity provider on another domain), said by the doctor when a plan needs them (§14, question 6), and the
request's "or a referenced vault" (a password manager's CLI): the PC's own store comes first, and a vault adapter is
part 4's question.

## 2. What the tester must not be able to do (threat model)

The plans are written by workers, which are agents; the app's responses come from a system an attacker may reach.
So a plan and a response are data, and the bars are in the runner, not in the plan:

| Threat | Bar |
|---|---|
| A plan sends a password or session to another host | Every request, the browser's included, goes only to the environment's origin and the `alsoAllow` hosts the owner named (§4); anything else is aborted and the step fails, naming the host. No `file:`, `data:` navigation, downloads or popups to other origins. Persona values are sealed under the environment's name **and origin** (§5): an approved change of an environment's URL leaves its personas unset until the owner types them again |
| A plan reaches the PC itself (the dashboard on 127.0.0.1, the hub's ports, the router) | Loopback, private and link-local addresses are refused unless the environment's own URL is one, and then only that origin (scheme, host and port) and never the dashboard's port. Checked on the resolved address, and the connection made **to that checked address** (no second lookup a DNS answer can change): HTTP steps on `node:https`/`node:http` with a `lookup` of our own (§6), the browser with every allowed host mapped to its checked address and every other host to nothing (Chromium's `--host-resolver-rules`) |
| A plan reads a secret into a step it controls | Plans never name a secret. Only the **sign-in recipe**, in `nextlevel.json` (owner-approved), puts a persona's values into a field or a header. A plan says `as: member`, nothing more |
| A plan changes production | `mutates: true` steps run only in `allowMutations` environments; elsewhere every HTTP request but GET, HEAD and OPTIONS is refused by the runner and, in the browser, aborted at the network layer, but the sign-in recipe's own requests. A plan that leaves out `mutates` cannot write through a click in a read-only environment. An environment marked `"production": true` can never be in `allowMutations` (the settings refuse it) |
| Real users | Personas are names the owner named with values the owner typed. The tester has no other way to sign in |
| The response or page carries a token or the password back | Evidence is redacted before it is written (§7), and the run adds what sign-in gave it (each cookie's value, a bearer token) to its own redaction set, so a plan can't read a session back through `expect` (an endpoint that echoes the session, an `actual` value). A screenshot whose page shows a secret value is masked or not kept |
| A plan is weakened to make a card pass | A card keeps the plan's hash from when it was added; a run of a changed plan says what changed (steps added, removed, changed: from code) and never closes the card by itself. A fix task's diff that changes its own plan is said on the card and the merge card |
| Evidence steers the orchestrator | What the orchestrator reads of a run is a table made by code (plan, step, expected, actual, status, capped lengths, through `OUTPUT_BUDGET`), marked as data; never a page's text whole, never a screenshot |
| An agent runs the tester to spend the owner's environments | Workers and the assistant can't start a run (their sessions refuse, as `verify` does); the orchestrator can, only for committed plans on the base branch, within `maxRunsPerHour` per plan and environment, which counts every run it causes (its own, a card's it added, a fix's). No run starts while an update holds new work (`holdFor`) |
| An agent changes a plan between the owner's look and a run | A run reads the plan from the base branch's head as committed (its hash in the run's record), never from a worker's branch or the working tree |

What stays open is said in `docs/KNOWN_ISSUES.md`: an agent running as the owner can read the hub's memory or the
DPAPI store as that user (FR-017 part 2B is the wall); a page can draw a secret in a picture the runner can't read;
a plan can still click through a read-only environment's GETs that have side effects (an app that changes state on
GET).

## 3. Plans

`docs/acceptance/<feature>.yaml` (or `.json`), one plan per file:

```yaml
plan: notes-sharing
env: [staging]            # where it may run; default: every environment
steps:
  - as: member
    do: { open: /notes/42 }
    expect: { text: "Quarterly plan" }
  - as: outsider
    do: { open: /notes/42 }
    expect: { denied: true }          # 403, 404, or a redirect to sign-in: the environment says which (§4)
  - as: outsider
    do: { request: "GET /api/notes/42" }
    expect: { status: 403 }
  - as: admin
    do: { request: "GET /api/audit?note=42" }
    expect: { json: { path: "$.entries[*].action", contains: "access-denied" }, within: 30s }
  - as: member
    mutates: true
    do: { request: "POST /api/notes/42/comments", json: { text: "acceptance check {{run.stamp}}" } }
    expect: { status: 201 }
```

- `do`: `open <path>`, `click <selector>`, `fill <selector> <value>`, `press <key>`, `wait <selector>` (browser, part
  2); `request <METHOD> <path>` with `json` or `form` and `headers` (HTTP, part 1). Paths only, joined to the
  environment's origin; a full URL is refused.
- `expect`: `status`, `text` (visible text contains), `noText`, `url` (after redirects), `redirect`, `allowed` /
  `denied`, `json` (a small path language: `$.a.b`, `[n]`, `[*]`, with `equals`, `contains`, `exists`), `header`
  (names on an allow-list, never `set-cookie`), and `within` (try again until it holds, up to 2 minutes: "the denial
  appears in the audit log"). `within` repeats only a step that doesn't mutate: on a `mutates: true` step it is
  refused when the plan is read, so a write is never sent twice.
- `mutates`: false by default. `mask`: selectors to black out in this step's screenshot.
- A plan holds no secret, no full URL, no host. A value like `{{persona.password}}` in a plan is refused when it is
  read. Plans may use `{{run.id}}` and `{{run.stamp}}` so a mutating step's data can be told apart.
- `src/lib/acceptance.mjs` (pure): the reader, the shape check (each field to its type, unknown fields refused, a
  plan over 200 steps or 64 KB refused), and the problems as plain words with line numbers. `nextlevel tester check
  [<plan>]` reads plans without running them; workers run it in their slot as part of verify, and the doctor's
  `tester.plans` reads them all.

Workers write plans: when a task spec has an `Acceptance:` line (`Acceptance: docs/acceptance/notes-sharing.yaml`)
and the tester is on, the worker's prompt gets a short section on the format and `nextlevel tester check`; the
task's verify reads the plan. With the tester off the line is ignored and the prompt is unchanged.

## 4. Configuration

`nextlevel.json` (protected, so every change is the owner's approval on the dashboard):

```json
"tester": {
  "enabled": true,
  "environments": {
    "staging":   { "url": "https://staging.example.com", "denied": [403, 404, "redirect:/sign-in"], "version": "/version" },
    "prod-test": { "url": "https://app.example.com", "denied": [403], "production": true }
  },
  "allowMutations": ["staging"],
  "alsoAllow": [],
  "personas": ["admin", "member", "outsider"],
  "signIn": {
    "http":    [ { "request": "GET /api/csrf", "capture": { "csrf": "$.token" } },
                 { "request": "POST /api/session", "json": { "email": "{{username}}", "password": "{{password}}", "csrf": "{{csrf}}" }, "keep": "cookie" } ],
    "browser": [ { "open": "/sign-in" }, { "fill": ["#email", "{{username}}"] }, { "fill": ["#password", "{{password}}"] }, { "click": "button[type=submit]" }, { "wait": "nav" } ]
  },
  "afterDeploy": { "main": ["staging"] },
  "deployWaitMinutes": 10,
  "autoClose": false,
  "maxRunsPerHour": 6,
  "maxFixes": 2,
  "runMinutes": 15,
  "keepRuns": 20
}
```

- The request's `roles.tester` becomes a top-level `tester` section: it has no engine or profile, so it isn't a role
  in `ALL_ROLES` and never enters `profilesInUse`, `engineUse`, the advisor's choice or the full-access checks.
  `USAGE_ROLES` gains `{ key: 'tester', title: 'Tester', unit: 'run', kind: 'program' }` (minutes, no tokens).
- `src/lib/config.mjs` validates it: environment names `[a-z0-9-]`, `https:` URLs (`http:` only for a loopback
  address, and said on the Team page), `allowMutations` and `personas` naming only what exists, `signIn` placeholders
  only `{{username}}`, `{{password}}`, `{{token}}` and only in `fill` values, `json`/`form` values and header values.
  `version`: a path that answers the deployed commit (optional, §8). `production: true` can't be in `allowMutations`.
  `signIn.http` is one request or a list; a `capture` takes a value from an earlier sign-in response on the same
  origin (a CSRF token) into `{{<name>}}` for a later one, and is added to the run's redaction set. `signIn` may also
  be given per environment (`environments.<env>.signIn`), over the section's own. An `engine`, `model` or `profile` in
  the section is refused, saying the tester runs no model (§0). `config.mjs`'s `merge()` needs its own branches for
  the section (the environments are a map of the owner's names, `denied` mixes numbers and words), as `profiles` and
  `deployBranches` have; an older nextlevel warns "unknown setting tester (ignored)" and runs as today.
- The guard's plain words (`src/lib/protect.mjs`) for a change of the section name, from code, where persona values
  would go and what may write: "sign-in now sends the password to POST /api/login on staging", "staging's URL changes
  to https://...: its personas must be set again", "mutations allowed on prod-test". An agent's proposed change of the
  section is held like any change of `nextlevel.json`; these lines are what the owner reads on the card.
- `{ "keep": "cookie" | "bearer:<json path>" }` says what the HTTP sign-in leaves for the next requests. A persona
  can instead have a `token` alone (an API key typed once), sent as `Authorization: Bearer`.
- The default (`init`): no `tester` section. The Team page's Turn on writes a starting section the owner fills in,
  through the guard like any change of `nextlevel.json`.

## 5. Persona sign-ins: the secret store

`src/lib/vault.mjs`, one store per project and environment and persona (`<project key>/<env>@<origin>/<persona>`),
values `username`, `password`, `token`. The password and the token are secrets: at least 8 characters (`persona set`
refuses a shorter one, as `secretValues` ignores one), redacted everywhere. The username is kept the same way but is
not redacted (an `admin` username would blank every "admin" in evidence and expectations); it is never in the
repository, a prompt or a plan either.

- **Windows:** DPAPI for the current user (`ConvertFrom-SecureString` / `ConvertTo-SecureString` without a key, which
  is DPAPI CurrentUser in both Windows PowerShell 5.1 and 7) through Windows PowerShell 5.1 (`powershell.exe
  -NoProfile -NonInteractive`, always there; PowerShell 7 may not be), started hidden as the hub starts everything, the
  value on its stdin, never on a command line. An unseal runs only at `persona set`, once per run in `_accept`, and once
  per process that redacts (below); `docs/ANTIVIRUS.md` says what an antivirus may say of it. The sealed blobs in
  `~/.nextlevel/vault/<project key>.json`, outside the project. **macOS:** the login keychain through `security`, the
  value given on stdin. **Linux:** the Secret Service through `secret-tool`, stdin. Nothing else: no store → the doctor's
  `tester.vault` says so and how to get one, and no run signs in.
- **Entering:** `nextlevel tester persona set <env> <persona>` in the owner's own window: refuses in an agent's
  session and without a terminal; reads each value with echo off; prints only "set" and the date. `persona list`
  shows which are set (never a value or a length); `persona forget`. A dashboard form comes in part 4, through the
  session key, with the same refusals.
- **Who reads them:** to sign in, only the run's own process (`_accept`), given the values for this run's personas on
  a pipe from the hub, never in its environment or a file. To redact, every process that redacts what may leave it:
  the hub (commits, pushes, results, logs), and `notify()`, `nextlevel report` and the dashboard's File it, the
  updater, `nextlevel ask`, wherever they run, since `phoneSecrets` and `reportSecrets` read `.env` in the calling
  process today. `vault.redactionValues(root)` unseals once per process, lazily, and caches it for that process's
  life; a store that can't be read makes `notify()` and a report send nothing with a persona name in it rather than
  send unredacted (said in hub.log). The tests check each of these callers.
- **Everywhere the `.env` values are kept out, persona values are too:** `phoneSecrets` and `reportSecrets`
  (`src/lib/redact.mjs`), the guard's commit and push scans (`holdSecrets`, `pushSecrets`), what `nextlevel result`
  shows, the workers' logs. A persona value found in a commit is held on a card like a `.env` value, named as
  "a sign-in of persona member on staging", never shown.
- The values never reach a worker's slot, the orchestrator, the assistant's copy, a prompt or an engine.

## 6. Running a plan

- `_accept <run id>`, the hub's child process, started and held like the security engineer's `_scan`: its pid and
  start time recorded, stopped by the hub's Stop, Ctrl+C, the time limit (`runMinutes`) or a hub restart (`stopped`),
  with FR-013's words when its files vanish. **Not a job**: nothing in `queue/` or `jobs/`. One run at a time per
  project; runs for other projects don't wait (they reach other environments).
- **Its environment is built from nothing,** like a worker's: no `.env` values, no read token, no GitHub sign-in, the
  push block, `NEXTLEVEL_AGENT=tester` (every nextlevel command refuses in it). Its working folder is
  `.nextlevel/tester/runs/<id>/`; the plan is read from `git show <base head>:<plan>`.
- **HTTP (part 1):** `node:https` / `node:http` requests (not `fetch`: Node's `fetch` takes no lookup of our own
  without the undici package), with a `lookup` that resolves the host once, checks every address against the
  private-address rules and connects to the checked one; a cookie jar per persona, redirects followed by hand so each
  hop is checked against the origin rules, a 30-second limit per request, a 2 MB cap on what is read of a body. No
  proxy from the owner's environment (the run's environment is built from nothing; a proxy is a later question).
- **Browser (part 2):** Playwright's Chromium, headless, one fresh context per persona per run (its own cookies and
  storage, nothing kept after), downloads off, service workers blocked, WebSockets through `routeWebSocket()` under
  the same rules, every request through `route()`: the origin rules and, in a read-only environment, only
  GET/HEAD/OPTIONS outside the sign-in recipe. Below `route()`, Chromium starts with `--host-resolver-rules` that map
  each allowed host to the address the runner resolved and checked and every other host to nothing, so what `route()`
  misses (a preconnect, a request it doesn't see) reaches no other place and DNS can't move it.
  Playwright is installed with `--ignore-scripts` from a lock file with integrity hashes that nextlevel ships, then its
  Chromium with Playwright's own installer from that folder; the doctor's fix records the installed files' hashes in
  `~/.nextlevel/tools/`'s record and `tester.browser` compares them before a run (a changed file: the browser is
  reinstalled with the owner's yes). It is loaded from `~/.nextlevel/tools/playwright@<pinned>/` by its absolute path,
  never resolved from the project. On Windows it starts hidden like every background process; the doctor's `tester.browser` checks the
  version and that Chromium starts (a page from a local server of its own).
- **Sign-in:** the first step `as` a persona runs the recipe for that persona (HTTP or browser, whichever the step
  needs); a failed sign-in fails the step as "couldn't sign in as member" with the recipe's step that failed, and the
  plan stops for that persona.
- **Ends:** passed (every step passed), failed (a step's expectation didn't hold: the first failing step per persona
  is the result; the plan stops there for that persona), incomplete (a step couldn't run: the environment didn't
  answer, a mutating step in a read-only environment, a browser step without the browser, a stop), and broken (the
  plan can't be read). Only "passed" verifies anything.

## 7. Evidence

`.nextlevel/evidence/<run id>/` (gitignored, with the rest of `.nextlevel/`), the newest `keepRuns` runs per plan and
environment kept and the rest removed when a run ends (a run a card still shows is kept until the card closes); it
never leaves the PC:

- `run.json`: who started it (owner, orchestrator, a card, a deploy, a fix, the schedule), the plan's path, commit
  and hash, the environment, the personas, each step's status, timing, expected and actual, the hosts reached, every
  mutating request made (method and path), the run's end. A copy of the who-and-what lines (no evidence) goes to the
  guard's `tester.jsonl` in `~/.nextlevel/guard/<project>/`, which agents can't write: the audit trail.
- Per step: `step-<n>.json` (the request's method and path, the status, allow-listed headers, the first 2 KB of the
  body as text, redacted) and, for browser steps, `step-<n>.png`.
- **One function makes evidence safe** before anything is written (`src/lib/evidence.mjs`, pure but the image step):
  no `Cookie`, `Set-Cookie`, `Authorization` or proxy header ever kept; JSON keys matching `SECRET_NAME` blanked;
  JWT-shaped and long base64 strings blanked; the persona values and `.env` values replaced (`redactReport`); query
  strings kept by name only; control and bidi characters dropped; every field cut to its length; and the run's own
  session values (cookies, bearer tokens, captures) replaced like persona values.
- **Screenshots:** before the shot, password inputs, every field the recipe or a step filled, and the step's and
  environment's `mask` selectors are masked (Playwright's `mask`); then the page's visible text and every input's
  value are read for any persona or `.env` value: one found outside a mask → the element holding it is masked and the
  shot taken again; if that can't be done, the screenshot isn't kept and the step says so. The images are served by
  the dashboard only with the session key, never sent to the phone or an engine.

## 8. Triggers, and what a run's end starts

| Trigger | Who | Notes |
|---|---|---|
| Home's Run acceptance, `nextlevel tester run <plan> --env <env>` | the owner | any committed plan, any listed environment |
| `nextlevel tester run` | the orchestrator | the same, within `maxRunsPerHour` per plan and environment; refused for workers, the assistant and the security engineer |
| A handoff card with `--plan <plan> --env <env>` | the orchestrator, adding the card | the hub runs it when the card is added (counted in `maxRunsPerHour`) and the card shows "The tester is checking this" instead of waiting for the owner |
| After a deploy | the hub | when the owner's approved push to a deploy branch has gone out: every plan for the environments the owner mapped to that branch (`tester.afterDeploy: { "main": ["staging"] }`), once `version` answers the pushed commit (up to 15 minutes), or after `deployWaitMinutes` when there is no `version` |
| After a fix | the hub | a task whose spec has `Acceptance:` merged, and the deploy above reached the plan's environment: only that plan |
| A schedule | the hub | `tester.schedule: [{ "every": "6h", "plans": [...], "env": "prod-test" }]`; at least an hour apart; part 4 |

- `REASONS` in `src/lib/rounds.mjs` gains `accept: { title: 'An acceptance run ended' }`, not `always` (under the
  brake): a run that a card, a deploy or a fix started is a real event when it ends; a scheduled run's or a repeated
  owner run's end only when its result differs from that plan's last run in that environment. A run the orchestrator
  started and waited for (`nextlevel tester wait`) starts no round, as `nextlevel wait` doesn't.
- The phone: a failed run after a deploy or on a schedule sends one message (plan, step, environment; through
  `notify()`), once per new failure. A pass sends nothing, but a card's "Verified" does what a team answer does today.

## 9. Closing the loop on cards

- A handoff card gains `accept: { plan, env, planHash, runs: [{ id, end, at, planHash }] }` (`src/lib/cards.mjs`;
  older nextlevels ignore the field, `format.json` notes it). `planHash` is the committed plan's when the card was
  added; a run of another one shows "the plan changed since this card was added" with the steps added, removed and
  changed, and its pass is never "Verified" by itself: the owner reads it and closes the card, or not. The dashboard shows the last run's table (step, persona, expected, actual,
  status, time, a link to its evidence), every text a text node.
- **Passed:** the card reads "Verified, ready to close" under What needs you with one button, Close (the owner's
  Done, undoable as today). With `autoClose` on, the hub closes it itself, only for a run of the plan the card was
  added with: `closedBy: 'tester'` (a new member of `BY` in `cards.mjs`), an event
  `{ kind: 'closed', by: 'tester', how: 'run <id>' }`, undoable from the card like a Done; the phone hears it once.
- **Failed:** the card stays open, its headline the failed step with expected and actual; the hub writes the fix
  draft (`.nextlevel/tester/fixes/<run id>.md`: the plan, the step, expected, actual, the redacted error, an
  `Acceptance:` line naming the plan, and "Fix the code, not the plan") and the run's end is a real event; the
  orchestrator's round brief lists it, and ORCHESTRATOR.md tells it to commit the draft as `docs/tasks/<id>.md`,
  dispatch it (`nextlevel dispatch <id>`, as today: no new way in) and answer the card. What came from the app
  (expected, actual, the error) is in the draft only as quoted one-line strings inside a fenced block (line breaks as
  `\n`), so no `Needs:`, `Profile:`, `Kind:`, `Acceptance:` or `Result file:` line can come from a response: those are
  read from the start of any line of a spec. After the fix merges and deploys, §8's "after a fix" runs only that plan
  and the card follows its result. After `maxFixes` fix tasks for the same plan and step that didn't make it pass, the
  hub writes no more drafts and the card goes under What needs you.
- **Incomplete or broken:** the card says why and waits for the owner (an environment down is not the team's fault
  and not a fix task).
- Today's "cards stay open after the work is done" goes away for any card with a plan; cards without one are as
  today.

## 10. The doctor, the Team page, the commands

- Checks (each in `docs/CHECKS.md` with unit tests on the fake PC): `tester.config` (the section reads, every
  persona's values set for every environment a plan uses: "member on staging isn't set: run `nextlevel tester persona
  set staging member` in PowerShell"), `tester.vault` (a store this PC has), `tester.plans` (every plan reads),
  `tester.reach` (each environment's URL answers a GET; no sign-in), `tester.browser` (part 2: the pinned Playwright
  and Chromium, with a fix that installs them after the owner's yes, in the owner's window, naming the size and that
  an antivirus may look at a new browser). Info, not a warning, while the tester is off.
- Team: a Tester row (Off / On, the environments and personas, which are set), in `src/lib/team.mjs`'s `TEAM_ROWS`.
- Commands, in `src/lib/commands.mjs` with `commandArgs`: `nextlevel tester status [--json]` (a look, readable under
  `NEXTLEVEL_READ_ONLY=1`, titles capped and marked as data), `tester check [<plan>]` (a look), `tester run <plan>
  --env <env>`, `tester wait <run id>`, `tester show <run id>` (the table within `OUTPUT_BUDGET`, the rest by
  `--from`), `tester persona set|list|forget` (the owner's). `COMMAND_TABLE`, `HUB_COMMANDS`, the hub's header comment
  and `_accept`; `idleTick`, `--exit-when-idle` and the updater's `holdFor` count a running acceptance run, and while
  an update holds new work no run starts (a trigger waits, as a task does). `session.mjs`'s `WHO` gains `tester`.
- Templates: WORKER.md and the task template gain the `Acceptance:` line (their old hashes into `OLD_TEMPLATES`);
  ORCHESTRATOR.md gains the card's `--plan` and the fix draft (part 3, its hash computed on the main it lands on).
  `docs/acceptance/` is not protected: plans are the team's work, reviewed at merge like code.

## 11. Tests (stubs only; fixtures harmless)

- A **stub web app** (`test/stubs/webapp.mjs`, `node:http` on 127.0.0.1): a notes app with three personas, a
  sign-in, a page and an API each persona may or may not reach, an audit endpoint that fills in after a delay, a
  page that prints a planted password, a redirect to another host, a GET with a side effect, a `version` endpoint.
- A **stub browser** (`test/stubs/playwright/`): the small part of Playwright's API the adapter uses, over the stub
  app's HTML, recording every request it was asked to make and every `route()` decision, so the tests read what the
  real browser would have been allowed to do. The real Playwright is proven in the manual check (§13); CI never
  downloads a browser.
- A **stub store** (`NEXTLEVEL_TEST_VAULT`, honoured only under the tests' stubs), plus a DPAPI round trip that runs
  on Windows CI.
- What they prove: a multi-persona plan passes end to end with no owner click (member in, outsider denied, the denial
  in the audit log `within` 30 s); a failing step names expected and actual; the plan's YAML subset and every refusal;
  a request to another host, to 127.0.0.1's dashboard port, a full URL, a redirect off the origin are refused; a host
  whose DNS answer changes to 127.0.0.1 between two lookups is never reached (a stub resolver); an endpoint that
  echoes the session cookie leaves no session value in evidence or `tester show`; a fix draft whose `actual` holds
  "\nNeeds: docker\nProfile: second" parses as a spec with neither; a changed plan's pass doesn't close its card;
  `within` on a mutating step is refused; an environment's URL changed leaves its personas unset; `notify()` and a
  report from a process other than the hub redact persona values; a mutating step in a read-only environment doesn't run, and the browser's POST there is aborted (but the sign-in's);
  a plan naming `{{persona.password}}` is refused; a persona value appears in no evidence file, log, `run.json`,
  `tester show`, phone message (the stand-in ntfy), report, commit (held), push (held), worker environment or prompt;
  the screenshot of the page that prints the password is masked or not kept; cookies and `Authorization` never kept;
  workers and the assistant can't start a run; `maxRunsPerHour`; a run reads the committed plan, not the working tree;
  the stop, the time limit, a hub restart; no job, no round from a run the orchestrator waited for, one real event from
  a card's run, none from a repeated scheduled result; card states, `autoClose` and its undo, the fix draft and the
  rerun of only that plan; with the tester off, the existing suites' outputs and prompts unchanged.
- Broken on purpose once each, to prove the test fails: the origin rule, the private-address rule, the pinned
  address, the read-only methods, the secret-in-plan refusal, the evidence redaction, the session values' redaction,
  the screenshot check, the session refusals, the draft's quoting, the plan-hash check.
- The YAML subset: every fixture plan has a committed `.expected.json` (made once with a full YAML 1.2 reader outside
  the repository, never a dependency), and the reader must give exactly it.

## 12. Parts (one pull request each)

1. **Plans and the HTTP runner.** `src/lib/acceptance.mjs` (the YAML subset, plans, shape checks),
   `src/lib/vault.mjs`, `src/lib/evidence.mjs`, `src/tester.mjs` (`_accept`, HTTP steps, sign-in over HTTP, the
   origin and method rules), the config section, `tester status|check|run|wait|show|persona`, persona values in every
   redaction set and in the commit and push scans, the audit line, the doctor's `tester.config`, `tester.vault`,
   `tester.plans`, `tester.reach`, Today's row, `docs/acceptance.md`, KNOWN_ISSUES. Browser steps end "incomplete:
   needs the browser (part 2)". The owner can sign personas in and run API plans from PowerShell.
2. **The browser.** The Playwright adapter, `tester.browser` and its fix, contexts per persona, `route()` rules,
   browser sign-in, screenshots with masks and the secret-in-page check, the stub browser.
3. **Closing the loop.** Cards with plans, Verified / failed / incomplete on the dashboard with the evidence table and
   images, `autoClose`, the fix draft, `accept` in `REASONS`, after-deploy and after-fix runs, the `Acceptance:` line
   in WORKER.md and the task template, ORCHESTRATOR.md, the Team row and Home's Run acceptance.
4. **Later:** the schedule, the dashboard's persona form, `autoFix` if the review wants it, and an optional engine that
   only explains a failure from redacted evidence.

## 13. Order with the work in flight, and checks of the work

- Parts 1-3 change `config.mjs`, `commands.mjs`, `hub.mjs`, `redact.mjs`, `team.mjs`, `usage` (and part 3 `app.js`,
  `cards.mjs`, `rounds.mjs`, ORCHESTRATOR.md), as the security engineer's 1a-1 and 1a-2 do. So **part 1 opens only
  after 1a-1 merges and part 3 only after 1a-2**, each on a fresh main; part 2 changes mostly new files and may open
  beside 1a-2 if they share nothing else. The same holds for any other pull request in flight then (the advisor's,
  the usage card's, FR-017 part 2B): at most two open pull requests, never two touching the same code. The design
  can be built beside them in a branch; nothing opens early.
- Each pull request: a draft, the affected tests, then `npm test` (the cloud container's known failures said),
  `scripts/public-scan.mjs` with the deny list on the code, this document and the pull request's text, no real project
  named in any fixture (and no phrase the deny list catches: write "the owner named", not its two-word "listed"
  form). Part 1's DPAPI round trip runs on the Windows check. Part 3: the pages in a browser in both themes and at phone width. If an antivirus blocks or
  quarantines anything (part 2's Chromium most likely), stop and tell the owner.
- **Manual check** (in each pull request, on a throwaway trial project with a local stand-in app, never a real one):
  part 1, set two personas and run an API plan, read `tester show`, and find no persona value in `.nextlevel/`'s
  files; part 2, the doctor's fix installs the browser, a browser plan passes and its screenshots mask the password;
  part 3, a card with a plan closes itself on a pass and opens a fix draft on a failure. **After install:** turn the
  tester on if wanted (Team page), approve the `nextlevel.json` change, set each persona once.
- No auto-merge for any of them: they add a new path for secrets.

## 14. Questions for the review

1. **No engine:** the tester as a program, the request's `engine` dropped (§0). Recommended.
2. **The fix task:** through the orchestrator (recommended), or `autoFix`, the hub dispatching its own draft.
3. **`autoClose` default:** off (recommended: closing a card is the owner's word today), on when the owner turns it on.
4. **The YAML subset** instead of JSON only: recommended, since workers and owners write YAML more easily, at the
   cost of a reader we keep.
5. **The secret store:** DPAPI / keychain / Secret Service (recommended), against the project's `.env`, which every
   guard already covers but the request rules out ("never reach the repo": a `.env` is one `git add -f` away).
6. **Second factors and third-party sign-in:** out (recommended for now); a TOTP seed in the store would be the first
   step back in.
7. **The orchestrator starting runs** (§8): allowed for committed plans within the hourly cap (recommended: "no owner
   clicks" needs it), or owner and cards only.

## 15. As built: part 1

Where part 1 differs from the text above, and why (`docs/DECISIONS.md` has each):

- **The sealing.** Each password and token is sealed with AES-256-GCM under one random key per project, bound to its
  place (`<env>@<origin>/<persona>#<field>`), so a value moved to another environment or origin doesn't open. The store
  keeps only that key: on Windows sealed with DPAPI for the current user through .NET's `ProtectedData` in Windows
  PowerShell (the key on stdin, never on a command line), not `ConvertFrom-SecureString`, whose output differs between
  PowerShell 5.1 and 7; on macOS in the login keychain; on Linux in the Secret Service. The sealed values stay in
  `~/.nextlevel/vault/<project key>.json`.
- **Who opens them.** The run's own process (`_accept`) opens the vault itself rather than taking the values on a pipe
  from the hub: it runs as the same user, and the hub then never holds a password but to redact. `_accept` reads the
  project's `.env` only to redact with; its environment keeps none of it.
- **Its folder.** A run works in `.nextlevel/evidence/<run id>/`, which holds its record (`run.json`) and each step's
  evidence (`step-<n>.json`); there is no separate `.nextlevel/tester/runs/`.
- **The YAML fixtures.** `test/fixtures/tester-yaml/*.expected.json` were made with PyYAML's `BaseLoader`, which leaves
  every scalar a string as the subset's reader does before a plan's shape types it.

## 16. As built: part 2

Where part 2 differs from §2 and §6, and why (`docs/DECISIONS.md` has each):

- **A proxy of the run's own.** Playwright's `route()` is called for a navigation's first request only, not for the
  redirects after it (its documentation says so, and a real Chromium 153 followed a redirect to another host and to the
  dashboard's port past it in a trial). So the browser starts with `--proxy-server` pointing at a proxy in the run's own
  process (`src/lib/testerproxy.mjs`, loopback included: `<-loopback>`), which checks every connection by origin and
  connects to the address it checked (`checkedAddress`, shared with the HTTP client). `route()` keeps the method rule
  and refuses early; `--host-resolver-rules` maps each allowed host to its checked address and every other name to
  nothing, with `EXCLUDE 127.0.0.1` so the proxy's own address stays reachable.
- **What a page loads from elsewhere doesn't fail the step.** A navigation of the page itself to a place the run may
  not reach fails it (`refused`); a picture, script, style sheet or frame from elsewhere is refused and listed in the
  step's evidence (`blocked`). Nothing reaches the other host either way.
- **A request that changes data, in the browser,** goes out only while a sign-in recipe or a step marked `mutates` runs,
  in every environment (where mutations aren't allowed, such a step isn't run at all). A step that isn't marked and
  whose click sends one is `refused`. The leave lasts until the next action, since a click's request can come a moment
  after it.
- **The package and the install.** `playwright-core` 1.63.0 (no dependencies, no install script) from a two-file lock
  nextlevel generates with the package's integrity, `npm ci --ignore-scripts`, then Playwright's installer for
  `chromium-headless-shell` into the tools folder (`PLAYWRIGHT_BROWSERS_PATH`). The record is
  `playwright@<version>.json` beside its folder in `~/.nextlevel/tools/` (every file's hash and size). The doctor compares names and sizes and opens
  a page once a day; a run compares every hash. The install is `nextlevel tester browser install` (the owner's, asking
  first), which the doctor's fix runs in the owner's window only.
- **Masks from the page's elements.** Before a screenshot, a function in the page marks every element that has text of
  its own or a value (`data-nextlevel-i`) and returns those texts; one holding a kept value outside the masks gets a
  mask of its own. A kept value only in the page's whole text keeps the picture out, as does a mask selector the browser
  can't read.
- **Sign-ins across HTTP and the browser.** Each persona has one sign-in per kind of step, made once: a browser step
  after an HTTP recipe gets its cookies (`addCookies`) and its bearer token (added by `route()` for the environment's
  origin only); an HTTP step after a browser recipe gets the browser's cookies.
- **The stand-in browser** (`test/stubs/playwright`) is the part of Playwright's API the runner uses, over a small DOM,
  with every request through the run's proxy; the stand-in npm installs it. The runner was also tried against the real
  Playwright 1.63.0 and Chromium on Linux (a whole run through the hub); the manual check covers Windows.
