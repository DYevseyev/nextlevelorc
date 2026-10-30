# Acceptance plans

The tester (`docs/design/tester.md`) walks an acceptance plan against a running copy of the app, as the test accounts
("personas") the owner named, and keeps what it saw as evidence. It is a program, not a model: a plan names every step,
so no AI reads a page or holds a password. This page is the plan format, the YAML it is written in, and the settings.

A step is an HTTP request or a browser action. Browser steps (`open`, `click`, `fill`, `press`, `wait`) need the browser,
installed once on this PC (below); without it they end **incomplete** and HTTP steps still run.

## Turning it on

The tester is off until `nextlevel.json` has a `tester` section with `"enabled": true`. `nextlevel.json` is a protected
file: the change waits for the owner's approval on the dashboard, which says in plain words what it does ("adds the
environment staging at https://staging.example.com", "mutations allowed on staging", "sign-in now sends username and
password to POST /api/session"). With it off, nothing changes anywhere.

```json
"tester": {
  "enabled": true,
  "environments": {
    "staging": { "url": "https://staging.example.com", "denied": [403, "redirect:/sign-in"] }
  },
  "allowMutations": ["staging"],
  "personas": ["admin", "member", "outsider"],
  "signIn": {
    "http": [
      { "request": "GET /api/csrf", "capture": { "csrf": "$.token" } },
      { "request": "POST /api/session", "json": { "email": "{{username}}", "password": "{{password}}", "csrf": "{{csrf}}" } }
    ]
  }
}
```

- **environments:** each one's `url` is an origin alone (`https://host[:port]`, no path): https, or plain http only
  for a stand-in app on this PC (`localhost`, `127.0.0.1`). `denied` is what counts as "not allowed" there (statuses,
  and `redirect:/path` for an app that sends a stranger to its sign-in page; by default 401, 403 and 404).
  `"production": true` marks one a step that mutates never runs on. `mask` lists selectors blacked out in every
  screenshot taken there.
- **allowMutations:** the environments where steps marked `mutates: true` run. Anywhere else they are not sent, and
  the run ends incomplete. A production environment can't be listed.
- **alsoAllow:** other origins a run may reach (a separate sign-in host). Nothing else is ever reached: a redirect
  anywhere else is refused, and a name on the internet that resolves to this PC or a private network isn't reached.
- **personas:** the test accounts' names, as plans use them in `as:`. Use accounts made for testing, never a real
  person's.
- **signIn:** how a persona signs in, as HTTP requests (`http`) or browser steps (`browser`: `open`, `fill`, `click`,
  `press`, `wait`, with `{{username}}` and `{{password}}` only in a `fill`'s value), or both (an environment may have
  its own). A browser step after an HTTP sign-in takes its cookies and token; an HTTP step after a browser sign-in
  takes the browser's cookies. `{{username}}`,
  `{{password}}` and `{{token}}` are the persona's values; `capture` takes a value from a JSON answer for the next
  request; `keep` is `cookie` (the default: the session cookie) or `bearer:$.path` (a token sent as
  `Authorization: Bearer`). The values go only where the recipe puts them, never into a path.
- **maxRunsPerHour** (6): how many runs of one plan on one environment the orchestrator may start in an hour (the
  owner's own runs aren't counted). **runMinutes** (15): a run's time limit. **keepRuns** (20): the runs kept per plan
  and environment.

The tester has no engine, model or effort: `nextlevel.json` refuses them.

## The personas' sign-ins

The owner types each one once, in their own PowerShell window, in the project folder:

```
nextlevel tester persona set staging member
```

What is typed isn't shown. The values are sealed on this PC (`~/.nextlevel/vault/`, outside the project), with a key
that only Windows' protection for your account (DPAPI), the macOS login keychain or the Linux Secret Service opens,
and bound to that environment's URL: change the URL and they must be set again. `nextlevel tester persona list` shows
which are set (never a value), `persona forget` removes one. A password or token has at least 8 characters.

The passwords and tokens are kept out of everything that leaves the PC or reaches an agent, like the `.env` values:
evidence, logs, reports, phone messages, commits and pushes (a file that holds one is held on a card). When the store
can't be opened, phone messages and reports wait rather than go out unredacted.

## A plan

Plans live in `docs/acceptance/` (`.yaml`, `.yml` or `.json`), committed. A run always reads the plan as the base
branch has it, never a working tree or a task's branch.

```yaml
plan: notes-sharing
env: [staging]
steps:
  - name: a member opens the note
    as: member
    do: { request: "GET /notes/42" }
    expect: { status: 200, text: Quarterly plan }
  - as: outsider
    do: { request: "GET /notes/42" }
    expect: { denied: true }
  - do: { request: "GET /notes/42" }
    expect: { denied: true }
  - as: admin
    do: { request: "GET /api/audit?note=42" }
    expect:
      json: { path: "$.entries[*].action", contains: access-denied }
      within: 20s
  - as: member
    mutates: true
    do: { request: "POST /api/notes/42/comments", json: { text: "check {{run.stamp}}" } }
    expect: { status: 201 }
```

- **plan:** its name (lowercase letters, digits and `-`). **env:** the environments it runs on (left out: any).
- **as:** the persona the step runs as; left out, it runs signed out. Each persona signs in once per run, at its
  first step.
- **do:** one action. `request: "METHOD /path"` with an optional `json`, `form` or `headers`. A plan names paths only,
  never a host or a full URL, and never sets a cookie or an authorization header. GET, HEAD and OPTIONS are read-only;
  POST, PUT, PATCH and DELETE need `mutates: true`. Browser actions (part 2): `open: /path`, `click: "#save"`,
  `fill: ["#title", "text"]`, `press: Enter`, `wait: ".done"`.
- **expect:** `status` (one or a list), `text` / `noText` (in the body), `url` (where it ended), `redirect` (a
  redirect to that path), `denied` / `allowed` (by the environment's `denied`), `json` (`{ path, equals | contains |
  exists }`, with a JSON path like `$.entries[*].action`), `header` (`{ name, equals | contains }`, a header that
  isn't a cookie or a sign-in). **within:** asks again every 2 seconds until the checks pass, up to that long (at
  most 2 minutes); a step that mutates is never sent twice, so it can't have one.
- **mask:** selectors blacked out in this step's screenshot (browser steps).
- `{{run.id}}` and `{{run.stamp}}` are the only placeholders in a plan, to make what a run writes its own.

A step that fails ends that persona's later steps ("not run"); the other personas go on. A run ends **passed**,
**failed** (a step failed, or was refused: a redirect off the origin), **incomplete** (a step couldn't run: a persona
not set, a browser step, a step that mutates on a read-only environment), **stopped** or **refused** (the hub didn't
start it, and says why).

## The browser

Browser steps run in Playwright's headless Chromium, at the one version this nextlevel pins, installed by you once:

```
nextlevel tester browser install
```

in your own PowerShell window, in the project folder (about 120 MB to download; it asks first, and an antivirus may look
at the new browser: `docs/ANTIVIRUS.md`). It goes into `~/.nextlevel/tools/`, never the project, from the lock file
nextlevel ships, with no install scripts, and every file's hash is recorded: a run compares them before it starts the
browser, and `nextlevel tester browser` (or the doctor's `tester.browser`) says whether it is ready.

- Each persona gets a fresh browser context for the run (its own cookies and storage, nothing kept after), signed in at
  its first step. Downloads are off, service workers blocked, popups closed.
- **open** loads a path and waits for the page; **click** clicks the first element the selector finds and waits for
  what it started; **fill** types a value into a field; **press** presses a key (`Enter` sends a form); **wait** waits
  until an element shows. Each waits up to 30 seconds; an element that isn't there fails the step.
- What a step expects is judged on the page as the step leaves it: `text` / `noText` on its visible text, `status`,
  `redirect`, `denied` / `allowed` and `header` on the page's last load, `url` on where it is. With `within`, an `open`
  is done again every 2 seconds; any other action is done once and the page read again.
- The browser reaches only the environment's origin and `alsoAllow`, through a proxy of the run's own that checks every
  connection, redirects included. A page sent to another host, or to another port on this PC, fails its step
  (**refused**); a picture, script or style from elsewhere isn't loaded, and the step's evidence lists it.
- A request that changes data (anything but GET, HEAD and OPTIONS) goes out only while the sign-in or a step marked
  `mutates: true` runs. A click that sends a form in any other step is stopped, and the step is **refused**.
- Each browser step keeps a screenshot (`step-<n>.png`) with password fields, every field the sign-in or a step filled,
  and the step's and environment's `mask` blacked out. Before it is kept, the page's text and fields are read for a
  password, a token, a `.env` value or the run's session values: one found gets a mask of its own; one that can't be
  found in one element keeps the screenshot out, and the step says so.

## The YAML subset

A plan is YAML, in a small subset nextlevel reads itself (it has no dependencies). Every file it accepts means the
same in any YAML 1.2 reader; anything outside it is refused with its line number.

- Block mappings (`key: value`) and lists (`- item`), indented with spaces (no tabs).
- Flow mappings and lists on one line, nested at most four deep: `{ status: 200, text: hi }`, `[a, b]`.
- Plain scalars, `"double-quoted"` (with `\n`, `\t`, `\"`, `\\`, `\uXXXX`) and `'single-quoted'` (`''` for a quote).
- Comments: `#` at the start of a line or after a space.
- Not in it: anchors and aliases (`&`, `*`), tags (`!`), block scalars (`|`, `>`), a value that goes on over two
  lines, several documents in one file, a key twice in one mapping.

Values are typed by the plan's shape, never by YAML's guesses: `status: 200` is a number because a status is, and
`text: no` is the text "no". In `json` bodies and in `json.equals`, plain `true`, `false`, `null` and numbers are JSON's,
and anything else is a string.

## Cards, deploys and fixes

- **A card the tester checks.** The orchestrator adds a handoff card with a plan:
  `nextlevel handoff add --file <request> --plan docs/acceptance/<plan>.yaml --env <env>`. The hub runs the plan as
  committed then; the card reads "The tester is checking this" and waits for no one. A pass makes it "Verified, ready to
  close" (one Close on Home); with `"autoClose": true` the hub closes it itself, and Reopen on the card undoes that. A
  pass of a plan that changed since the card was added says what changed and never closes the card by itself.
- **A failure** leaves a fix draft in `.nextlevel/tester/fixes/<run id>.md` for the orchestrator to commit as a task:
  what the app answered is quoted on one line each, so no line of it can act as part of the spec. After `maxFixes` (2)
  drafts for the same step since the plan last passed, the card waits for you. A run that couldn't finish (the
  environment down, a sign-in not set, the browser missing) waits for you too: that isn't the team's to fix.
- **A task's `Acceptance:` line.** A task spec with `Acceptance: docs/acceptance/<plan>.yaml on <env>` has its plan run
  after its merge: at once when no branch deploys that environment, else after the deploy that carries the merge.
- **After a deploy.** `"afterDeploy": { "main": ["staging"] }` names the environments a pushed branch deploys to. After
  a push of that branch, every committed plan for those environments runs once the environment's `version` path (like
  `"version": "/version"`) answers the pushed commit (asked every 30 seconds, up to 15 minutes), or after
  `deployWaitMinutes` (10) when it has none. A failure after a deploy sends one phone message.
- Home's Acceptance card runs a committed plan on an environment and shows the last runs, step by step, with their
  screenshots; the Team page shows the environments and which personas are set.

## Commands

| Command | Who | What |
|---|---|---|
| `nextlevel tester status` | anyone | on or off, the environments, which personas are set, the last runs |
| `nextlevel tester check [<plan>]` | anyone | reads the plans without running them, each problem with its line |
| `nextlevel tester run <plan> --env <name>` | the owner, the orchestrator | asks the hub for a run of the committed plan |
| `nextlevel tester wait <run id>` / `show <run id>` | the owner, the orchestrator | how it ended, step by step |
| `nextlevel tester stop [<run id>]` | the owner | stops a run at its next step |
| `nextlevel handoff add ... --plan <plan> --env <name>` | the orchestrator | a card the tester checks |
| `nextlevel tester persona set\|list\|forget` | the owner, in their own window | the personas' sign-ins |
| `nextlevel tester browser [status]` / `browser install` | anyone / the owner, in their own window | whether the browser is ready; installing it |

A worker, a verify command and the assistant can't start a run. Each run is in `.nextlevel/evidence/<run id>/`
(`run.json` and a `step-<n>.json` per step: status, headers on an allow-list, the body's or page's first 2 KB, every
kept value replaced by `***`; a `step-<n>.png` per browser step), and one line per run is kept in the guard's folder (`~/.nextlevel/guard/<project>/tester.jsonl`),
which agents can't write.
