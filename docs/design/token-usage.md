# Token usage over time

What each worker, task, engine and project used, over the last hour, a day, a week, a month and all time. It replaces
the "Usage over time" item of the dashboard plan.

## Why

The dashboard shows only today's usage, and keeps two weeks. People who run a build team on subscriptions want to see
what each worker, task, engine and project used over a day, a week, a month and all time.

## What nextlevel had before

- `addUsage(role, engine, { runs, minutes, tokens }, reason)` in `src/hub.mjs` added into `.nextlevel/usage.json`: one
  object per local day, `by["<role>:<engine>"] = { runs, minutes, reported, tokens, cached }`, `roundsBy[reason]`,
  and the older totals (rounds, attempts, codexTokens). Only the last 14 days were kept.
- Callers: a worker attempt's end, an autopilot round's start (`runs: 1`) and end (minutes, tokens), the
  orchestrator's and the setup guide's windows (Codex's session files only), the assistant (`src/ask.mjs`, two calls:
  Claude Code and Codex, and Antigravity).
- Adapters: `tokens(text) -> { tokens, cached } | null`. Codex: input minus cached plus output (`--json` turn totals;
  session files for windows). Claude Code: input + cache writes + output, cache reads apart. Antigravity: input +
  output (or total_tokens), cache reads apart. Interactive Claude Code and Antigravity windows: minutes only.
- Home's **Today** card: per role and engine, rounds by what started them, and per engine. Nothing per task, model,
  worker or project, and nothing before today.

What was missing is a **record per run** that is never thrown away, with who ran it, and views that sum it over a range.

## 1. The usage ledger: one line per run, kept for good

`.nextlevel/usage/<YYYY-MM>.jsonl` (the local month of the run's end), one JSON object per ended run, appended:

```
{"v":1,"at":"2026-10-25T15:42:10.123Z","start":"2026-10-25T15:20:02.000Z","role":"worker","worker":"workers",
 "engine":"agy","profile":"","model":"gemini-3.8-flash-high","effort":"","task":"M3-02","attempt":2,"slot":1,
 "reason":"","runs":1,"minutes":22.135,"tokens":{"total":184233,"input":171020,"output":13213,"cached":902118},
 "end":"done"}
```

- `role`: autopilot, orchestrator, worker, guide, assistant; any `^[a-z-]{1,24}$`, so a new role needs no change here.
- `worker`: the job's `worker` as `whichWorker` names it (`workers`, `second`, `fallback`, `asked`), '' for other
  roles. `task`, `attempt`, `slot`: worker runs only.
- `reason`: what a run was for, where its role has kinds: an autopilot round's trigger (FR-019), the assistant's kind
  of answer. Any `^[a-z-]{1,24}$`. An assistant run with none reads as `advise`.
- `end`: how it ended: a worker attempt's state (done, failed, no-changes...), a round's `not-started`, else ''. A
  worker attempt stopped from outside (FR-013) has `notCounted: "stopped from outside"`, so the page can leave it out of
  attempts but keep its minutes.
- `at`: the run's own end when it is known (`run.json`'s `endedAt`, a window's end), else now; `start` likewise. Now is
  `lib/clock.mjs`'s (`clockIso`), the clock the ranges use, so the tests' clock drives writing and reading alike. The
  month file is the local month of `at`. A run counts, in every range, at its end ("runs that ended in this range").
- `tokens`: `null` when the engine didn't report (an interactive Claude Code or Antigravity window, a round that never
  started). `total` is exactly what `tokens` meant before for that engine, `cached` the cache reads. The adapters also
  return, where the engine gives them: `input` = the input counted in `total` (Codex: `input_tokens -
  cached_input_tokens`; Claude Code: `input_tokens`; Antigravity: `input_tokens`), `cacheWrite` (Claude Code's
  `cache_creation_input_tokens`), `output`, and `thinking` as a part of nothing (Claude Code's
  `output_tokens_details.thinking_tokens` is inside `output`; for Antigravity it is not known whether
  `thinking_tokens` is, so it is never added to anything). So `total == input + cacheWrite + output` where all are
  there (a test says so per engine), and Codex's "tokens used" fallback gives `total` alone. Nothing that reads
  `.tokens`/`.cached` changes.
- No free text: ids, names and numbers only, so a line never carries a secret and needs no redaction.

**Writing.** `addUsage` first updates `usage.json` as before (`updateJsonFile`, a pure change), then appends the ledger
line under the month file's own lock (`withFileLock(<month>.jsonl)`: one `appendFileSync` of one line, outside any
`updateJsonFile` callback, which may run more than once). Before it appends, it reads the file's last byte: when the
file doesn't end in `\n` (a write cut by a power loss), it writes `\n` first, so the cut line is the only one lost.
Failures are logged and never stop the hub. Months are separate files, so "this week" opens one or two small files; at
about 250 bytes a run, a busy month (5,000 runs) is about 1.3 MB.

Only ended runs go in the ledger. A round's start still adds `runs: 1` to `usage.json` only (as before); its end writes
the ledger line with `runs: 1`. A round whose engine never started writes a line too, with `end: "not-started"`,
minutes 0 and `tokens: null`, so the ledger's rounds equal `usage.json`'s.

`.nextlevel/format.json` doesn't change: the ledger is a new file an older version ignores, and `usage.json` is still
written for one (Go back).

**What was counted before (and during a Go back).** Each day of `usage.json` gets `ledgered: { "<role>:<engine>": {
runs, minutes, tokens, cached, reported } }`, added in the same change as `by` whenever this version counts a run, so
it says what of that day is in the ledger already (an older version leaves the key alone: `usageAdded` copies a day's
other keys). At each hub start, for every day and key where `by` is more than `ledgered`, the hub appends one line
`{"v":1,"kind":"day","day":"2026-10-12","role":...,"engine":...,"runs":...,...}` with the difference and sets
`ledgered` to `by` (computed in the `updateJsonFile` change, appended after it wrote). The first start imports all 14
days that way; a return from Go back imports what the older version counted. `kind: "day"` lines count in the ranges
that hold their whole day (never in Last hour). All time says "from <the oldest day>".

## 2. Per task

Each attempt's entry in `status.json`'s `attempts` (FR-020's list, which has `model` already) gets `tokens`: an
additive field, the file protocol stays. `nextlevel result <id>` shows the task's total from the ledger (the attempts
list keeps only 50): "3 attempts, 412,000 tokens (2 failed: 230,000)".

## 3. Sums: `src/lib/usage.mjs` (pure, but its readers)

- `readLedger(dir, { from, to })`: the lines in range, from the month files that overlap it. Every line goes through
  a shape check (as `lib/closures.mjs` does; `.nextlevel/` is a folder the team can write): `v` 1 (a higher `v` read
  for the fields it knows), `role`/`engine`/`end`/`reason`/`worker` `^[a-z-]{1,24}$`, `task` the task ids' pattern,
  `model`/`profile`/`effort` `^[\w.:/@+-]{0,80}$`, numbers finite and >= 0, `at`/`start` ISO times; a field that
  fails is dropped, a line without `at` (or `day`) is skipped, a line longer than 2 KB is skipped. It reads at most
  32 MB per month file and says so when it stops there.
- `sumUsage(records, { by })`: groups by `role`, `engine`, `model`, `worker`, `task`, `reason`, `day` or `profile`;
  each group `{ runs, minutes, tokens, cached, reported, failedTokens }`, where `reported` counts runs whose engine
  reported tokens ("412,000 (12 of 14 runs reported)", as Today says).
- `ranges(now)`: Last hour, Today, This week (from Monday, local), This month, All time, each with its start ("This
  week, from Monday 19 October"); days and weeks in local time, by `lib/clock.mjs`, so the tests' clock drives them and
  a clock change is tested.
- `perDay(records, { from, to })`: the chart's series, per engine, a zero for a day with nothing.
- Per merged task: its tokens and attempts.

## 4. Per project

The dashboard is per project, so its numbers are that project's. **All projects** adds the others: the projects in
`~/.nextlevel/state.json`'s `projects` list (paths the owner's own commands recorded), each ledger read where it is,
read-only, its state folder found the way `lib/project.mjs` finds it, summed per project (a row each, with its folder's
name). A project whose folder is gone or unreadable is "not found" and never fails the page. Nothing is copied between
projects. All projects is the owner's (section 6).

## 5. The dashboard

Home's **Today** card becomes **Usage**:

- A range picker: Last hour · Today · This week · This month · All time (Today by default; the choice kept in the tab's
  localStorage, wrapped in try/catch).
- A "group by" picker: Role (as Today, with its engines under each role; a role not in the list of known ones gets a
  row of its own, titled by its key) · Engine · Model · Worker · Task. Columns: Runs, Minutes, Tokens (with "N of M
  reported"), and Cache reads, quieter.
- A per-day bar chart for the range (Week, Month, All time), stacked by engine, inline SVG built with the page's DOM
  calls (no library, no HTML strings), both themes and phone width, each bar's numbers in its title.
- "Rounds by what started them", for the chosen range.
- The Build page's task rows and a task's detail show its tokens and attempts.
- The footnote says what each engine reports and what it doesn't.

The card reads the ledger for every range, Today included, and adds what runs now as Today did (open windows, running
attempts and rounds). This version's dashboard no longer reads `usage.json`; it is written only for an older one.
The live feed carries Today only; the other ranges, groupings and All projects come from `GET
/api/usage?range=&by=&all=` (with the session key, as every request), cached in memory by each month file's size and
time.

## 6. A command

`nextlevel usage [--range hour|today|week|month|all] [--by role|engine|model|worker|task|reason|day] [--all-projects]
[--json]`, listed in `lib/commands.mjs`. It prints within the output budget (`lib/reports.mjs`) and says what it left
out ("12 more rows: --json has them"). It is allowed in a read-only session (the assistant), but `--all-projects` is
the owner's: refused under `NEXTLEVEL_READ_ONLY=1` and in an agent's session (`lib/session.mjs`), so one project's
agent never reads another project's task ids, models and folder names; the dashboard's switch is the owner's way to it.

## 7. Later

- Interactive Claude Code windows' tokens from its session transcripts, like Codex's session files.
- The model a run actually used (Claude Code's stream-json `init` names it), beside the one asked for.
- Codex's 5-hour and weekly limits as % used, and a tracker of each plan's balance: they read the same ledger.
- Money: no cost column; the ledger has what a price table would need.
- `usage.json` stops being written in the first release whose Go back target has the ledger already (two releases
  after the ledger's), said in that release's notes; `ledgered` goes with it.

## Pull requests

1. **The ledger and the command:** `src/lib/usage.mjs`, `addUsage` and its callers, the adapters' token parts,
   `ask.mjs`'s two calls (the model), the import, `nextlevel usage`, per-task tokens.
2. **The dashboard:** the Usage card, the Build page's tokens, `/api/usage`.
