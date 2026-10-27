# Acceptance plans

The tester (`docs/design/tester.md`) walks an acceptance plan against a running copy of the app, as the test accounts
("personas") the owner named, and keeps what it saw as evidence. It is a program, not a model: a plan names every step,
so no AI reads a page or holds a password. This page is the plan format, the YAML it is written in, and the settings.

Part 1 runs HTTP steps. Browser steps (`open`, `click`, `fill`, `press`, `wait`) are read and checked already, and a
run ends **incomplete** at the first one until part 2 brings the browser.

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
  `"production": true` marks one a step that mutates never runs on.
- **allowMutations:** the environments where steps marked `mutates: true` run. Anywhere else they are not sent, and
  the run ends incomplete. A production environment can't be listed.
- **alsoAllow:** other origins a run may reach (a separate sign-in host). Nothing else is ever reached: a redirect
  anywhere else is refused, and a name on the internet that resolves to this PC or a private network isn't reached.
- **personas:** the test accounts' names, as plans use them in `as:`. Use accounts made for testing, never a real
  person's.
- **signIn:** how a persona signs in, as HTTP requests (an environment may have its own). `{{username}}`,
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
- `{{run.id}}` and `{{run.stamp}}` are the only placeholders in a plan, to make what a run writes its own.

A step that fails ends that persona's later steps ("not run"); the other personas go on. A run ends **passed**,
**failed** (a step failed, or was refused: a redirect off the origin), **incomplete** (a step couldn't run: a persona
not set, a browser step, a step that mutates on a read-only environment), **stopped** or **refused** (the hub didn't
start it, and says why).

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

## Commands

| Command | Who | What |
|---|---|---|
| `nextlevel tester status` | anyone | on or off, the environments, which personas are set, the last runs |
| `nextlevel tester check [<plan>]` | anyone | reads the plans without running them, each problem with its line |
| `nextlevel tester run <plan> --env <name>` | the owner, the orchestrator | asks the hub for a run of the committed plan |
| `nextlevel tester wait <run id>` / `show <run id>` | the owner, the orchestrator | how it ended, step by step |
| `nextlevel tester stop [<run id>]` | the owner | stops a run at its next step |
| `nextlevel tester persona set\|list\|forget` | the owner, in their own window | the personas' sign-ins |

A worker, a verify command and the assistant can't start a run. Each run is in `.nextlevel/evidence/<run id>/`
(`run.json` and a `step-<n>.json` per step: status, headers on an allow-list, the body's first 2 KB, every kept value
replaced by `***`), and one line per run is kept in the guard's folder (`~/.nextlevel/guard/<project>/tester.jsonl`),
which agents can't write.
