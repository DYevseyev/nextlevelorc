# Known issues with the tools we drive

Read this before changing how processes are started, quoted, timed out or killed. Add to it whenever
you learn something the hard way. Status as of September 2026.

## Antigravity CLI (`agy`)
- **Print mode needs a real console on Windows: for its stdin.** `agy -p` silently drops its output, or
  hangs, as a plain subprocess ([#76](https://github.com/google-antigravity/antigravity-cli/issues/76),
  [#318](https://github.com/google-antigravity/antigravity-cli/issues/318)). Measured on 1.2.11 (FR-010): with a
  real console as its stdin, its stdout and stderr may be pipes or a file, and nothing is lost (10 of 10
  `stream-json` lines, exit code kept). So the hub starts a worker's process (`_run`) with no window
  (`CREATE_NO_WINDOW`, below), which gives agy its console's input (`CONIN$`) as its stdin and reads its output
  through pipes into `worker.log` (measured on 1.2.12, FR-013). A worker process without a console doesn't start agy
  at all. Before FR-010 each worker had a console window of its own (`start "title" ...`), whose output nextlevel
  couldn't read; FR-010 to FR-013 started `conhost.exe --headless` itself, which an antivirus judged malicious.
- **It loads the owner's global add-ons into every session, `-p` too (FR-013, 1.2.12):** the rules in
  `~/.gemini/GEMINI.md`, plugins, skills and hooks under `~/.gemini/config/`, and every MCP server in
  `~/.gemini/config/mcp_config.json`, started as processes (on the owner's PC: Rafter through `cmd /c ... npx`, Stitch
  through `cmd /c npx -y mcp-remote ... --header "X-Goog-Api-Key: ..."`, an API key on a command line, GitHub's through
  `docker run`). A custom agent (`.agents/agents/<name>.md`, `--agent <name>`) with `inheritCustomizations: false`
  drops the rules, skills and plugins, and `inheritMcp: false` the MCP servers' tools (28 800 input tokens went to
  6 000), but agy still starts the servers' processes, and the agent doesn't get the project's `AGENTS.md` either. A
  missing agent file wasn't an error before 1.3.4: agy ran its default agent, with everything (1.3.4 refuses it, below).
  So a worker runs as the agent the
  worker's process writes into its slot at every start (`engines/agy.mjs`), is told to read `AGENTS.md`, and the doctor
  says which MCP servers still start (`workers.addons`). Upstream: `docs/upstream/antigravity-mcp-per-session.md`.
  The frontmatter keys are in agy's changelog and program (`inheritCustomizations`, `inheritMcp`,
  `excludeDefaultComponents`); `rules:` with a path didn't bring `AGENTS.md` back.
- **1.3.4 refuses an agent file whose frontmatter isn't valid YAML (FR-022).** nextlevel's agent file had
  `description: A worker of nextlevel's build team: one task in its slot. ...`: the second `: ` makes that line invalid
  YAML. 1.3.2 read it anyway (the 9 October workers on a test project ran as `nextlevel-worker`); 1.3.4 and 1.3.5 drop the
  file, and since 1.3.4 `--agent` with a name it has no agent for fails at once ("Fixed `--agent` silently running the
  default agent when the name matches no agent", its changelog): exit 1, `error: unknown agent "nextlevel-worker"
  (available: rules-writer, a11y_agent)` on stderr (those two are the user's plugins' agents; names changed here), and a
  `result` with status `ERROR`, an empty `response`, `num_turns` 0 and the reason in a new `error` field. Measured on
  1.3.5 (agy had updated itself again overnight; 1.3.4 wasn't run here), one change at a time from the doctor's trial
  toward the owner's working command: the console with no window or a window, cmd.exe or started directly, the doctor's
  environment or a worker's, `--output-format stream-json`, `--print-timeout 2m`, the probe's text,
  `AGY_CLI_DISABLE_AUTO_UPDATE`, a temp folder, a git repository: none mattered; the same file with the description
  quoted, or without its second `: `, ran (exit 0, `SUCCESS`), and adding an H1 to the body didn't. So the file's texts
  are quoted (`engines/agy.mjs agyWorkerAgent`), valid YAML for every agy: one file for all versions. With it, "hi" cost
  8 197 input tokens as the agent and 27 864 as the default agent (FR-013 measured 6 000 and 28 800).
  **And after 1.3.2 an agent whose file lists no `tools:` gets only tools that look** (measured on 1.3.5; 1.3.3 and
  1.3.4 not run): the first real worker with the fixed file answered "Status: BLOCKED ... no file-write tools available
  in this session", naming what it had (`view_file`, `list_resources`, `read_resource`, `read_url_content`, `search_web`,
  `generate_image`, `manage_task`, `schedule`, `send_message`), while the init event still listed all 60 tools. With a
  `tools:` list the same prompt wrote its file and ran `node --version`. A name its registry doesn't know stops the run
  at once (exit 3, `AGY_ERROR: {"short_error":"failed to construct executor: failed to resolve components: unknown
  component: tool \"command_status\" not found in registry ..."}`): `command_status`, `send_command_input`, `sed_file` and
  `notebook_execution` are such. So after 1.3.2 (from `agy --version`) the agent lists the worker's tools
  (`WORKER_TOOLS`: files, commands, search, web reading, its own tasks; no MCP or plugin tool), and the model check's
  probe asks agy to write a file with its tool and run a command, and fails a run that did neither: a probe that only
  asked for "ok" passed while every worker answered BLOCKED. For 1.3.2 the file stays without the list.
  `agy agents` lists a workspace's agents only in a folder it trusts (`trustedWorkspaces` in its settings.json); `-p`
  finds them anyway (measured with a throwaway home), so nextlevel trusts no folder.
- **How 1.3.x says a run failed (FR-022).** A failure before a turn: `error: <reason>` on stderr, and with
  `--output-format stream-json` a last `{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"",
  "error":"<reason>",...,"num_turns":0}}`. An API failure in a turn: exit 3 and an `AGY_ERROR: {"short_error":...}`
  line on stderr (its changelog). An unknown flag: exit 2, `flags provided but not defined: -turbo` and its usage on
  stdout. `agyFailure` (`engines/agy.mjs`) reads them in that order; the check, a worker's attempt and an autopilot
  round show agy's own reason, the exit code and its last lines (about 20), redacted like a report and with every
  string of the owner's MCP servers' settings (their args, env and headers carry keys). Before FR-022 nextlevel showed
  only "ERROR".
- **1.3.5 streams a message in pieces (FR-022).** An `agent_response` step comes as several `ACTIVE` lines, each with a
  piece of the text in `text_delta`, then `DONE` with the last piece (1.2.11 sent it whole, in `DONE`). A tool step's
  error is an object in `tool_info.error` (`{ "type", "message" }`). The feed and a worker's log put a message together
  before they show it (`test/fixtures/agy-1.3.5-stream-json.txt` is a real run).
- **Its background updater flashes a console window (FR-011, 1.2.12).** When its update check is due (about every 15
  minutes, `last_check.timestamp`), a session that starts runs `agy.exe --bg-updater`, which has no console and runs
  `agy.exe --version`: Windows gives that a console window of its own, open about 0.9 s, which took the focus once.
  Worker starts are when the owner saw it; the window came in two of four runs where the updater ran.
  `AGY_CLI_DISABLE_AUTO_UPDATE=true` (in the program, not documented) keeps the updater from starting: measured, with it
  the due check didn't run, and the next run without it ran it; `=1` didn't stop it. So the sessions nextlevel starts
  headless get it (`headlessEnv` in `engines/agy.mjs`): workers, autopilot rounds and the model trial. agy still
  updates itself in the owner's own sessions, and `agy update` does it by hand.
  `docs/upstream/antigravity-updater-console-window.md` asks agy to open no window and to document the variable.
- **Headless mode stalls on permission prompts (before 1.1.3).** It ignored `permissions.allow`; any tool call that
  would ask stalled forever and `--print-timeout` didn't fire
  ([#548](https://github.com/google-antigravity/antigravity-cli/issues/548)). agy's changelog says 1.1.3 changed that:
  a `-p` run now "soft-denies" a tool that needs a confirmation and prints a notice on stderr naming the allow-rule, and
  1.1.5 makes headless runs honour `settings.json`'s permissions. Not measured here: on the owner's PC agy's own
  settings approve everything (below), so nothing asks. We still pass `--dangerously-skip-permissions` (a role that
  would be soft-denied can't work either), and the deny-list stays in `~/.gemini/antigravity-cli/settings.json` (the
  approach of [agy-run](https://github.com/JaggerH/agy-run)).
- **The deny-list isn't enforced (1.2.11, and 1.4.0).** On the owner's PC both bridge workers ran `git push`
  although the rules were in the settings file (FR-003). On 1.4.0 (16 October, `docs/design/antigravity-roles.md`)
  `command(gh)` didn't stop `gh --version`, with `--dangerously-skip-permissions` or without it. Not separated: whether
  `command(gh)` matches only the bare command (1.0.9's notes speak of "strict exact-match" for some commands), and
  whether the owner's global `command(*)` grant (below) wins over it; that needs the owner's settings changed. Treat the
  deny-list as a hint: git refuses pushes in worker slots, the bridge test checks that against a real remote, and the
  orchestrator on agy gets nextlevel's push block, which its lock test proves.
- **The owner's own agy settings approve everything (16 October).** `~/.gemini/antigravity-cli/settings.json` has
  `"toolPermission": "always-proceed"`, and `~/.gemini/config/config.json` (shared with the Antigravity app) has a
  global `command(*)` grant and files outside the workspace allowed. agy merges those with any project's permissions
  (1.0.5, 1.0.12), so agy asks nothing anywhere on this PC, the setup guide included, and nothing nextlevel could write
  into a project changes that. The doctor's `agy.permissions` says so (information).
- **Its sandbox and plan mode don't hold on this PC (1.4.0).** `agy --sandbox -p` starts, but on Windows 11 22H2 every
  command fails: `exebox: sandboxing on Windows requires Windows 11 24H2 or later with the August 2026 or later update:
  process security environments are not supported`. And `--sandbox` doesn't cover agy's own file tools: with it on,
  its edit tool wrote a file outside the session's folder. `--mode plan` let its edit tool write a project file (a
  command was declined, but by the model's choice). So neither is a wall for a read-only role, and nextlevel uses
  neither: the lock test records whether a command runs in the sandbox, for the record.
- **The owner's MCP servers reach any agy session that inherits them (1.4.0).** A round run as agy's default agent,
  with nextlevel's push block, called the owner's GitHub MCP server (`call_mcp_tool`): the block reaches only commands,
  and a server's own keys are in its config (the GitHub server got a token through `docker run -e`). It failed only
  because that token no longer worked. As nextlevel's agent (`inheritMcp: false`) the tool was gone: the run's input went
  from 57 000 to 8 000 tokens. So the orchestrator on agy runs as `nextlevel-orchestrator`, as workers run as
  `nextlevel-worker` (FR-013). The owner removed their agy MCP config on 16 October.
- **Argon keeps to its agent's instructions (1.4.0).** As the assistant's agent with "never edit, create or delete files"
  in its body, Argon declined every lock-test try that changes something (a `git tag`, a file by its edit tool, `nextlevel
  note add`), even when the prompt said it was the owner's test: good behaviour for a question, but a lock test that
  proves nothing about where a change lands. So the assistant's agent says only where it works (a throwaway copy), the
  question's briefing says it is read-only, and the tries that change something say they are the owner's lock test.
  Then all nine held: its writes landed in the copy, `note add` was refused, and the real project stayed as it was.
- **What nextlevel's push block does around an orchestrator on agy (1.4.0, measured with Argon).** In a real autopilot
  round's process, with the block on its environment: `git push` to a remote, to a remote with its own push URL and to a
  folder path all failed with nextlevel's message and nothing arrived; `gh api user` got 401; `nextlevel note add` was
  refused. A command that cleared `GIT_CONFIG_PARAMETERS` first pushed, and one that cleared gh's variables answered as
  the owner: the block stops an accident, never an agent that sets out to get around it (FR-017 part 2B). A protected
  file agy committed itself was set back on disk and held at the round's end; the commit stayed on local main (a push of
  it waits for the owner's decision, and a rejected one is refused).
- **No sandbox.** agy auto-executes tools; the workspace is a starting point, not a boundary
  ([comparison](https://github.com/SinanTufekci/Claude-Code-Antigravity-CLI-MCP-Server)). Hence slots
  with no secrets and no way to push, the deny-list and the worker rules.
- **`--print-timeout` defaulted to 5 minutes** (1.2.11's help says 0, "waits until the turn completes"): the hub
  passes the task's limit either way. Flag reference, tested on 1.2.4:
  [cheat sheet](https://computingforgeeks.com/antigravity-cli-cheat-sheet/). Older builds (the owner
  had 1.1.16) may lack flags: check the version, fix with `agy update`.
- The installer puts `agy.exe` in `%USERPROFILE%\.local\bin`; consoles opened before the install don't
  have it on PATH, so the hub looks there directly.
- agy reads `AGENTS.md` and `GEMINI.md` as rules, like Codex reads `AGENTS.md`: prompts start with a
  `ROLE:` line so one `AGENTS.md` serves every role.
- **No second account on one PC user.** agy has no variable or flag for where it keeps its sign-in (the
  system's keyring, or `~/.gemini/antigravity-cli/` as a file fallback); requests are open
  ([#155](https://github.com/google-antigravity/antigravity-cli/issues/155),
  [#381](https://github.com/google-antigravity/antigravity-cli/issues/381)). A profile with an `account`
  on agy is refused, and the doctor says why (`profiles.accounts`). Third-party switchers swap token
  files, and a separate `HOME` with `GEMINI_FORCE_FILE_STORAGE=true` is undocumented: nextlevel does
  neither.
- Print mode needs a real console for **every** role: an autopilot round on agy runs with a console with no
  window too (`nextlevel _cycle`, followed through `.nextlevel/cycle.json`).
- **Models and effort.** `agy models` fetches the list over the network (about 3 s) and prints
  `slug<TAB>label` per line since 1.1.11 (one slug per line in 1.1.5 to 1.1.10), after a "Fetching
  available models..." line. Antigravity takes the level from the model's name (gemini-3.8-flash-high is high,
  claude-opus-5-5-medium is medium): pick the model with the level you want. nextlevel doesn't pass --effort. 1.3.4 lists
  its Claude models with a level in the name too (`claude-opus-5-5-low`, `-medium`, `-high`), and Gemini 4 Argon arrived
  on 13 October for Ultra plans (`gemini-4-argon-low`, `-medium`, `-high`, "Gemini 4 Argon (High)";
  `test/fixtures/agy-1.3.5-models.txt`). `--model` takes the slug. History: `--effort` (`low|medium|high|max` in 1.2.11's
  help) was **refused for its Claude models** on 1.2.11 ("--effort is not supported for model claude-opus-4-6-thinking"
  failed every worker attempt on the owner's PC, FR-010), and 1.3.5 refuses it beside a model whose name has a level
  ("invalid model selection (--model "claude-sonnet-5-5-medium" --effort "high"): --model claude-sonnet-5-5-medium
  conflicts with --effort=high"); 1.3.4's changelog says `--model` takes a name without a level too, with the model's
  default level. nextlevel never passes `--effort` to agy (`agy.effort` takes an old `--effort high` out of
  `engines.agy.args`; the model check says it isn't passed). `agy models --output-format json` is advertised but refused (issue
  #777). The model picked with `/model` is `"model"` in `~/.gemini/antigravity-cli/settings.json`, as its label
  ("Gemini 3.8 Flash (High)"); the default isn't written there.
- **Its steps and tokens (FR-010), measured on 1.2.11.** `-p ... --output-format stream-json` prints one JSON object
  per line: `{"event":"init","conversation_id","init":{"model","cwd","tools":[...],"permission_mode"}}`, then
  `{"event":"step_update","step_update":{"step_index","state","step_type",...}}` per step (`user_input`;
  `agent_response` with `text_delta` and its own `usage`; `tool` with `tool_name` and `tool_info.parameters`:
  `run_command` has `CommandLine`, `write_to_file` and `replace_file_content` `TargetFile`; a tool step comes as
  `ACTIVE`, then `DONE` with `tool_info.output`; no exit code for a command), and last
  `{"event":"result","result":{"status":"SUCCESS","response","duration_seconds","num_turns","usage":{"input_tokens","output_tokens","thinking_tokens","cache_read_tokens","total_tokens"}}}`,
  where `total_tokens` is input plus output. `--output-format json` prints the result object alone. Headless runs
  get `stream-json` (`test/fixtures/agy-stream-json.txt` is a real run): the feed, the log the dashboard shows and
  Today's tokens (input and output; cache reads apart) come from it. `--log-file` only moves the CLI's own log.
- **It starts the owner's MCP servers even for `-p`** (`npm exec ...`, in its console), and they set the console's
  title to their command line, which can hold an API key (seen on the owner's PC). What reaches a console's
  screen is never kept, and a worker's log drops window titles whole (`lib/workerlog.mjs`).
- **Its interactive window doesn't run the agent `--agent` names (1.4.0).** On 17 October at 16:25 UTC the owner
  opened `nextlevel orchestrator` on agy 1.4.0 (`agy -i <prompt> --model gemini-4-argon-high --agent
  nextlevel-orchestrator`). Its status bar named the agent, but agy's own transcript of that session
  (`~/.gemini/antigravity-cli/brain/0efa1ace-…/.system_generated/logs/transcript_full.jsonl`, steps 67-77) shows the
  model running agy's default agent. nextlevel-orchestrator was listed only under its subagents, so
  `inheritCustomizations: false` and `inheritMcp: false` weren't applied. It had the owner's global rule, 10 plugins and
  124 skills, and 3 MCP servers. It read the agent file from disk to learn its rules. The push block still held (its
  push was refused). Headless `-p` runs as the agent: a round's `init` says `"agent":"nextlevel-orchestrator"`, and the
  lock test's MCP try finds no MCP tool. So the orchestrator's window doesn't open on Antigravity (`windowProblem` in
  `hub.mjs`); autopilot rounds and workers run on it as before. The setup guide opens on agy as it always has (with the
  owner's add-ons: the owner is there), and the assistant on agy runs headless. A possible fix, untested: agy's
  Markdown agents take `mainAgent:` and `subagent:` keys (its changelog, 1.1.6), and `mainAgent: true` and
  `subagent: false` in nextlevel's role agents might make `-i` run the agent. `agy agents` couldn't show it: it lists
  a project's agents only in a folder agy trusts. An owner check could bring the window back (open it, ask whether "Never
  work around it" is in its system prompt and which MCP servers it has: expect yes and none).
- **Its shell runs where the model says.** `run_command` takes a `Cwd` the model chooses for each command. Workers ran
  every command in their slot. The 16:25 window ran its first two commands in agy's scratch folder
  (`~/.gemini/antigravity-cli/scratch`) and searched the home folder for AGENTS.md before it found the project. The
  orchestrator's prompts name the project's folder now.

## Codex CLI
Checked against the Codex source at 0.157.0 (codex-rs), September 2026; the add-ons and the Windows sandbox's processes
against 0.157.1 (FR-011, FR-013).
- **A worker without the owner's own add-ons (FR-013).** `codex exec` loads everything in `$CODEX_HOME/config.toml`
  (an autopilot round started the owner's MCP servers, two through npx) and the owner's skills (`$CODEX_HOME/skills`,
  `~/.agents/skills`). A Codex worker gets `-c mcp_servers.<name>.enabled=false` for each server `workers.addons`
  doesn't list (the field exists: "When false, Codex skips initializing this MCP server"; `codex mcp list` shows it
  disabled), `--disable plugins` (plugins bring skills, MCP servers, apps and hooks), `--disable hooks`,
  `--disable apps`, and `-c skills.config=[{name='<skill>',enabled=false},...]` for the owner's own skills (single
  quotes: TOML's literal strings, since a `.cmd` shim can't carry double ones). `--ignore-user-config` would drop the
  sandbox and model settings too, still loads the user's skills and still discovers `hooks.json` (untrusted, so it
  doesn't run). A server or skill whose name has characters `-c` can't carry stays on, and the doctor says which.
- **The assistant (Ask) on Codex starts without them too (17 October).** Its read-only sandbox doesn't cover an MCP
  server: a server writes where its own config points (a user's config.toml can hold servers that write a
  live site). Ask gets a worker's switches for a worker that keeps nothing, whatever `workers.addons` keeps for workers.
  The orchestrator's rounds and window and the setup guide on Codex still start every server in the owner's
  config.toml: by design until a project can have servers of its own. Ask on Claude Code starts no MCP servers either (`--strict-mcp-config`), and keeps the
  owner's own settings (`--setting-sources user`: their hooks, skills and plugins, never the repository's); on
  Antigravity it answers as nextlevel's agent, which gets no MCP server's tools (agy still starts their processes).
- **Its Windows sandbox runs commands with no window, on a desktop of its own** (0.157.1's source): the elevated
  sandbox's `codex-command-runner.exe` starts each command with `CREATE_NO_WINDOW` or a pseudoconsole. Before each
  command `codex-windows-sandbox-setup.exe` runs (twice, measured), started without `CREATE_NO_WINDOW`: it shares
  the console of the process that starts it, so that one must have a console. `codex exec` does (nextlevel starts it
  with `CREATE_NO_WINDOW`); **the interactive TUI's shared background server doesn't** (`codex app-server
  --managed-daemon`, started detached, on by default since 0.157), so in the orchestrator's window every command's
  helper got a console window of its own, which took the focus (FR-011: 12 in one turn). `--no-daemon` (0.156 on)
  keeps the session's server in the TUI's own process, where the helper shares the window's console (measured: 44 runs,
  no window), prints no notice (unlike a `-c`), and leaves the session out of `codex agents` but as history. nextlevel
  passes it to Codex's windows (the orchestrator, the setup guide) when `codex --help` lists it. Once started, the
  shared server keeps running after the window closes (`codex app-server daemon stop` stops it). The runner, which has
  no console, also runs `cmd /c mklink /J` once per working folder without the flag: that can flash too.
  `docs/upstream/codex-windows-sandbox-windows.md`.
- **`codex exec --json` (M10)** prints its steps as JSON lines on stdout (codex-rs `exec_events`):
  `thread.started`, `turn.started`, `item.started` / `item.updated` / `item.completed` with an `item` of type
  `command_execution` (`command`, often wrapped as `bash -lc '...'`; `aggregated_output`, `exit_code`, `status`),
  `file_change` (`changes`: `path`, `kind` add/delete/update), `agent_message` (`text`), `reasoning`,
  `mcp_tool_call`, `web_search`, `todo_list`, `error`; then `turn.completed` with `usage` (`input_tokens`,
  `cached_input_tokens`, `output_tokens`: the session's running total) or `turn.failed`. With `--json` it
  doesn't print "tokens used", so nextlevel counts the last `turn.completed` (input without the cached part,
  plus output, like "tokens used"). Older versions' JSON (`{"msg":{"type":"exec_command_begin",...}}`) is read too.
- **Its Windows sandbox blocks writes outside the workspace, not reads (FR-023).** Measured on 0.164.0, Windows 11
  (26 October), in a throwaway workspace: with `--sandbox workspace-write`, the owner's `windows.sandbox = "elevated"`
  and again with `-c windows.sandbox=elevated`, `type` of a file beside the workspace and of a `.env` there exited 0 and
  the model got their contents; a write beside it was refused, a write inside allowed, and curl failed with a TLS error
  (`SEC_E_NO_CREDENTIALS`), which suggests the network is off but doesn't prove it.
  So the orchestrator and Codex workers can read what the owner's user can read (another project's `.env`,
  `~\.codex\auth.json`). Codex has permission profiles (`default_permissions`, `permissions.<name>.filesystem` with
  `{ "." = "deny" }` for a path: Codex Security's own scan uses them, `":root" = "read"` on Windows since the elevated
  sandbox needs it), which nextlevel doesn't use yet; 0.164.0 doesn't enforce a permission-profile deny on Windows, elevated or not
  (the security engineer's Step 0b, B5: holds for the orchestrator and Codex workers). A wall needs another user or a container (ROADMAP, "Safety: from bars to walls").
- **Not every add-on switches off per run (FR-023).** On 0.164.0 `-c mcp_servers.<name>.enabled=false` for the Codex
  app's own `codex_app` and `cua_repl` fails the run at config load (`Error loading config.toml: invalid transport in
  mcp_servers.codex_app`), so nextlevel can't keep them from a run; `codex debug models` prints JSON already (its
  `--json` exits 2), each model listing `available_access_programs` (`{"cyber":["standard","daybreak_blue"]}`); there is
  no command that lists skills; and `exec` has `--cyber-access-program` (standard, daybreak_blue, daybreak_red).
- **A worker on Windows, in Codex's sandbox, can't use Docker or install packages, network or not (FR-009).**
  Measured on Codex 0.160.0, Windows 11 22H2, through a test project's hub (15 October): its sandbox is the "elevated"
  one (`[windows] sandbox = "elevated"`; `~/.codex/.sandbox/setup_marker.json` names the accounts), and a worker's
  commands run as `CodexSandboxOffline`, or `CodexSandboxOnline` with `-c sandbox_workspace_write.network_access=true`.
  Both are denied the Docker pipe and `~/.docker/config.json`, and pnpm's store in the owner's AppData
  (`pnpm install`: "ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK ... Access is denied"), so the network doesn't help. Without
  the sandbox (`--sandbox danger-full-access`) the same task ran `pnpm install` and a package script, `docker version`
  reached the engine, git committed and fetched, and git refused the push (the push lock); `codex exec` never stopped for
  an approval there (nextlevel still passes `-c approval_policy=never`), and no window opened in any case. So the Team
  page takes Codex workers out of the sandbox (`engines.codex.workerArgs`), and the doctor (`codex.worker-windows`) and
  the Team page warn while they are in it.
  PowerShell refused `pnpm.ps1`, `npm.ps1` and `npx.ps1` there on a real project ("running scripts is disabled on this system")
  where the PC's policy doesn't allow scripts. A Codex worker now gets `PSExecutionPolicyPreference=RemoteSigned`, the
  policy for its own process only (it wins over the user's and the machine's, not a Group Policy, and changes nothing on
  the PC): it reached the commands in the sandbox and out of it, and on the owner's PC `Restricted` in it reproduced the
  refusal while `RemoteSigned` ran `npm -v`. Where the PC already allows scripts it changes nothing. The `.cmd` shims beside
  them work anyway, and a worker in the sandbox is still told to use them.
- **The owner's global `~/.codex/AGENTS.md` still reaches Codex workers.** FR-013 keeps the owner's MCP servers, plugins,
  skills, hooks and apps out of a worker, not their instruction files: on a test project (16 October) a Codex worker ran
  `rafter run` by itself because that file asks for it, which out of the sandbox used the network (and likely the owner's
  Rafter key). A follow-up.
- **The hub's variables reach a Codex worker's commands, whatever `config.toml` says.** Codex's
  `shell_environment_policy` can leave out variables whose names contain KEY, SECRET or TOKEN (the push block's
  `GH_TOKEN`, `GITHUB_TOKEN`). On 0.160.0 they reached the commands with the hub's values (compared by hash) in every
  case, but an owner's `config.toml` can change that, so a worker's command line sets the policy itself (`-c
  shell_environment_policy.inherit=all`, `ignore_default_excludes=true`, an empty `exclude` and `include_only`).
- `codex exec` is properly headless; its sandbox defaults to read-only, so we pass
  `--sandbox workspace-write`. No network there; the orchestrator doesn't need any (the hub has it).
- **The sandbox keeps `.git` read-only** (also `.agents` and `.codex`) under `workspace-write`, on every
  OS: `git commit` fails with `index.lock: Permission denied`, or waits for the owner's approval
  (FR-004 #1). The orchestrator's commits, merges and branch deletions go through the hub
  (`nextlevel commit`, `merge`, `cleanup`). A Codex *worker* can't commit or merge in its slot either (a
  slot's git folder is under the project's `.git`: `git merge main` failed with "Unable to create
  .../.git/worktrees/w1/ORIG_HEAD.lock: Permission denied", FR-008): the hub merges the base branch into the
  task branch before a Codex retry, hands the worker the conflicts (files with git's markers; the worker
  edits them, no git needed) and commits what it leaves when it finishes. Its prompt and `TASK.md` tell it
  not to run git writes. Only `--sandbox danger-full-access` (or the flag that bypasses the sandbox) in
  `engines.codex.args` would let it write git itself.
- **Inside the sandbox the owner's sign-ins, programs, Docker and the network are out of sight**: a
  doctor run there said gh was signed out and Docker, Codex and agy were missing (FR-004 #2). What Codex
  sets for the commands it runs: `CODEX_THREAD_ID`, `CODEX_SESSION_ID`, `CODEX_VERSION` and `CODEX_CI=1`
  always (Windows since about 0.150); `CODEX_SANDBOX=seatbelt` on macOS only;
  `CODEX_SANDBOX_NETWORK_DISABLED=1` whenever the sandbox has no network; on Windows' unelevated sandbox
  `SBX_NONET_ACTIVE=1` (and a proxy of `127.0.0.1:9`). Windows' elevated sandbox sets nothing else: the
  sign there is a `.git` that can't be written.
- **Processes outside the sandbox can be out of sight.** On Linux every sandboxed command runs in a PID
  namespace of its own (bubblewrap `--unshare-pid`), so `process.kill(hubPid, 0)` says "no such process"
  though the hub runs; macOS's seatbelt denies signals to other processes (EPERM); Windows' elevated
  sandbox runs as another account (`CodexSandboxOffline`/`Online`: EPERM). Under Codex, nextlevel takes
  the hub's heartbeat alone as the sign that it runs.
- **Long commands keep running after Codex stops waiting.** With unified exec (the default), Codex waits
  `yield_time_ms` (10 s on Windows, at most 30 s), hands the model a session id, and the command goes on in
  the background while the model polls it (up to 5 min per poll). So `nextlevel wait` and `commit` may
  block for minutes. Only when an admin policy turns unified exec off do commands die after 10 s.
- **Any `-c` (also `--profile`, `--enable`, `--disable`, `--search`) keeps an interactive session out of
  Codex's shared background server** (on by default from 0.157), with "Running without the shared
  background server: ... requires embedded mode" at every start (FR-004 #6). `-m`, `--sandbox`, `-a`,
  `--cd` and `--add-dir` don't. There is no flag for the sandbox's network: it is
  `[sandbox_workspace_write] network_access = true` in `~/.codex/config.toml` (or a trusted project's
  `.codex/config.toml`). `profile = "x"` in `config.toml` is an error since 0.134 (`--profile x` reads
  `x.config.toml`).
- **Models:** there is no built-in default; without `model` in `config.toml` Codex takes the first model
  the account's list offers (cached in `models_cache.json`). An older Codex doesn't know newer models:
  0.152 couldn't use GPT-6 (FR-004 #3). `codex debug models` prints the account's list as JSON. Codex's
  own update check keeps `{"latest_version", "last_checked_at"}` in `version.json` (refreshed after 20 h).
- **Reasoning effort has no flag.** It is `model_reasoning_effort` in `config.toml` (`/model` inside Codex
  saves it with the model, and removes it when the model's default is picked), or `-c
  model_reasoning_effort=high` (a value that isn't TOML is taken as a string, so no quotes are needed on
  Windows). `codex exec` always runs its own in-process server, so `-c` there doesn't touch the shared
  background server; only the interactive window leaves it (FR-004 #6). Unset, the model's own
  `default_reasoning_level` is used. Known values: `minimal`, `low`, `medium`, `high`, `xhigh`, `max`
  (and `ultra`, `persistent`); each model supports some (`supported_reasoning_levels`).
- **`codex debug models`** prints `{"models":[...]}` on one line: `slug` (what `-m` takes),
  `display_name`, `default_reasoning_level`, `supported_reasoning_levels` (`[{"effort": ...}]`),
  `visibility` (`list`, `hide`, `none`) and `priority`. `$CODEX_HOME/models_cache.json` holds the same list
  (`{ fetched_at, client_version, identity, models }`). Without `model` in `config.toml` Codex uses the
  listed model with the lowest `priority`.
- **Tokens:** at the end of a `codex exec` run it prints `tokens used` and, on the next line, the number
  (input without the cached part, plus output), on stderr, with the PC's thousands separators (`12,345`,
  `12.345`, or a no-break space). Missing when the run failed early. Read only the digits.
- **An interactive session's tokens are in its session file** (FR-008): every session, `codex exec` too,
  writes `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl`. Its first line is `session_meta`
  (`cwd`, `timestamp`, `originator`, `source`: `cli`, `exec`, `vscode`...); `event_msg` lines of type
  `token_count` carry `info.total_token_usage` (`input_tokens`, `cached_input_tokens`, `output_tokens`,
  `reasoning_output_tokens`, `total_tokens`), the session's running total, re-sent unchanged after a
  compaction or with `info: null` for a rate-limit update. nextlevel takes the last total of each session
  that started in the project's folder while its window was open (not `exec`: those are counted from their
  output), counts input minus cached plus output like `tokens used`, and notes the files it counted so the
  orchestrator's and the guide's windows never count one twice. The format isn't documented: a file it
  can't read counts as not reported.
- **Hooks** (on by default since 0.124; `[features] hooks = false` turns them off) come from `hooks.json`
  and `[hooks]` in `config.toml` in the user's, a trusted project's and the PC's Codex folders, and from
  plugins (`plugins/cache/<marketplace>/<plugin>/<version>/`). On Windows they run through
  `pwsh -NoProfile -Command` (or `commandWindows`), so a missing program ends with exit code 1, and the TUI
  shows "Hook failed" / "hook exited with code 1" around tool calls (FR-004 #4). Hooks that aren't
  trusted (`[hooks.state."..."] trusted_hash`) don't run. 0.157 on Windows reports a hook's exit code 2
  as 1 (openai/codex#48183).
- npm installs `codex` as a `.cmd` shim. Node refuses to spawn `.cmd`/`.bat` files without a shell
  (security fix for CVE-2024-27980), so the hub runs shims through `cmd.exe` with explicit quoting
  (`spawnBin`).
- Several Codex installs on PATH (npm and the desktop app) can break `codex exec`'s Windows sandbox
  helper. The doctor lists all installs it finds.
- Model names are account-specific: `gpt-6-sol` was rejected with "not supported when using Codex with
  a ChatGPT account" (FR-001). Default to the model picked in Codex; validate pinned names.
- A user's global Codex config can reference broken MCP servers; Codex warns on every start. Unrelated
  to us, but worth surfacing so users don't think it's our failure (`codex.mcp`: `[mcp_servers.<name>]`
  in `~/.codex/config.toml`, or `$CODEX_HOME`).
- **A second account: `CODEX_HOME`** moves Codex's whole folder (`auth.json`, `config.toml`, logs,
  sessions). The folder must exist first ("CODEX_HOME points to ..., but that path does not exist").
  `cli_auth_credentials_store` defaults to `file`; with `keyring` the entry is named after a hash of the
  folder's path (on Windows an encrypted file in the folder, its key in Credential Manager, also per
  folder), so two folders stay apart in every mode (codex-rs `login/src/auth/storage.rs`, 0.157).
  `codex login status` prints `Logged in using ...` (exit 0) or `Not logged in` (exit 1). The browser
  login listens on localhost:1455, so one login at a time, and the browser's ChatGPT session offers the
  account already signed in there: open the link in a private window for the other one. A new
  `CODEX_HOME` has no `config.toml`: that account's model is the account's default until it gets one.
- Codex's shell can drop variables whose names contain `KEY`, `SECRET` or `TOKEN`
  (`shell_environment_policy`). So a Codex worker's commands may not see the dummy `GH_TOKEN`, and the
  hub passes git settings in `GIT_CONFIG_PARAMETERS`: with `GIT_CONFIG_COUNT`, a dropped
  `GIT_CONFIG_KEY_0` would make every git command fail.
- **`codex exec -` reads the prompt from stdin** (0.157's help: with no prompt, or `-`, "instructions are read
  from stdin"; with both, stdin is appended as a `<stdin>` block). The assistant (Ask) uses it: on Windows
  `codex` is a `.cmd` shim, so an argument goes through cmd.exe, which would read `%NAME%`, `^` and `"` in the
  owner's question as its own. `--sandbox read-only` on the command line wins over `sandbox_mode` in
  `config.toml`, so the assistant gets none of `engines.codex.args` (they could name another sandbox). The
  read-only sandbox still **reads** any file the account can: what it prints is redacted before anyone sees it,
  and the commands it runs have no network.
- **It keeps only so much of a command's output** (FR-012): past its tool-output limit (about 10 KB by default;
  `tool_output_token_limit` in `config.toml`) it cuts the middle and puts "Total output lines: N" at the top and
  "…N tokens truncated…" (or "chars") where it cut; older versions also cut past 256 lines. So nothing nextlevel prints
  for the orchestrator may rely on being read whole past that: `nextlevel result` stays within 9,000 bytes and 240
  lines (`OUTPUT_BUDGET`, `src/lib/reports.mjs`) and gives the rest in parts (`--from`). A long file the orchestrator
  reads with its own commands is cut the same way, so the role doc says to read long ones in parts.

## Phones (ntfy)
- **A file name like `HANDOFF.md` becomes a link to a website** (`.md` is Moldova's domain), which opened
  a stranger's site instead of the request (FR-004 #5). `notify()` never sends a bare `.md` name: the hub
  links the file on GitHub, or drops the `.md`. Other file endings that are domains too (`.sh`, `.py`,
  `.zip`) would do the same.
- **Anyone who knows the topic reads the messages**, so every message is redacted the way reports are before it
  leaves (FR-017, `notify()` in `src/notify.mjs`): every value of the project's `.env`, secret-looking variables, token
  shapes, the home folder. A setting's ordinary word stays readable under a name that doesn't look secret
  (`NODE_ENV=production`, `LOG_LEVEL=info`: production, development, staging, test, local, localhost, debug, info, warn,
  warning, error); the same word under a secret-looking name (`API_TOKEN=production`) is blanked out everywhere, and so
  is any other `.env` value that is also an ordinary word (values of 4 or 5 characters only as whole words; `true`,
  `yes` and the like never).

## Windows consoles (FR-010, FR-013)
Measured on the owner's PC (Windows 11 22621), September 2026, with a UI Automation monitor of top-level windows and
the focus (managed assemblies only: a PowerShell script calling the Win32 window functions directly was blocked by the
antivirus as "malicious content"), and in FR-011/FR-013 a WMI monitor of new processes with their parents and command
lines. FR-010 had Windows Terminal as the default terminal; FR-011 and FR-013, Windows Console Host.
- **`CREATE_NO_WINDOW` gives a console program a console of its own with no window (FR-013)**: Windows' documented
  process flag, which Node sets (with `windowsHide`) when a child inherits no handle. Every program the child starts
  shares that console unless it asks for a new one, and the child can open its console's input, `CONIN$`, and give it to
  a program as its stdin: agy's print mode takes it as a real console (measured on 1.2.12: output through pipes, nothing
  lost, no window, no focus change). It is what `lib/console.mjs` does for workers, autopilot rounds and the checks that
  try agy's print mode; `NEXTLEVEL_CONIN` names another file, for the tests to play a PC where it fails. A process whose
  `CONIN$` doesn't open (none known) ends before it starts agy, and the hub starts the attempt in a window of its own.
- **An antivirus judged `conhost.exe --headless` malicious (FR-013)**, FR-010's way to the same console: started by
  nextlevel directly, hidden, with an agent inside that has every permission. nextlevel no longer starts conhost.exe
  (a test fails if any source file does). The measurements that led to it, kept for what they say about consoles:
- **A new console goes to Windows Terminal**, which ignores hidden and minimized starts: `cmd /c start "t" ...`
  opened a Windows Terminal window that took the focus. `conhost.exe <program>` started explicitly bypasses Windows
  Terminal, but its window took the focus even when started hidden (`SW_HIDE`: the keyboard focus went to the
  hidden window while it ran) or minimized (`start /min`, and `SW_SHOWMINNOACTIVE` through `WScript.Shell`).
  `workers.window: minimized` is `start /min` of the worker's own process (Console Host honours it, Windows Terminal
  doesn't).
- **`conhost.exe --headless --width W --height H -- <program>`** (FR-010 to FR-013) gave the program a real console
  with no window, but **Windows Server 2025 (build 26100, GitHub's `windows-latest` runner) ran nothing that way**: conhost
  ended with exit 0 within about 50 ms. Its screen wasn't a byte pipe (long lines came back cut at the width) and it
  didn't pass on the program's exit code. The hub still watches every start: a worker's process that ended before it
  wrote `run.json`, or no `run.json` after 45 s, didn't start; one that found no console to give agy (exit 3) is
  remembered for the PC for a day (`~/.nextlevel/console.json`) and the attempt starts again in a window of its own,
  which Show activity says. `node test/console-diagnose.mjs` prints what a PC does.
- **The default terminal didn't decide the flashes left after FR-010 (FR-011):** with Console Host as the default, the
  workers and autopilot rounds nextlevel started opened no window, either way; what flashed were programs that make a
  console of their own, agy's updater and Codex's shared background server (above).
- **Node gives a child `CREATE_NO_WINDOW` (with `windowsHide`) only when none of its stdio is inherited**: a child
  given a file handle for its output (`stdio: ['ignore', fd, fd]`) gets a console of its own, a window, when its
  parent has none. Background processes get `stdio: 'ignore'` or pipes; a worker writes its log itself.
- A process started with `windowsHide` and pipes has a console with no window; its children share it.
- **`NoDefaultCurrentDirectoryInExePath`** (set by some shells, an agent's on the owner's PC among them): Windows
  then doesn't look in the current folder for a program, so `cmd /c START.cmd` in the project says "'START.cmd' is
  not recognized". GitHub's runner doesn't set it; the tests clear it, so they behave the same everywhere.

## Antivirus (FR-013)
- **Bitdefender's Advanced Threat Defense judges behaviour, not files**: it stopped a whole worker chain (nextlevel's
  hub, the hidden console, agy with `--dangerously-skip-permissions`, the MCP servers agy started through npx, pnpm)
  and then its antivirus quarantined files of every program in it, some of them plain data (pnpm's task state in the
  slots). What it takes is gone without a word to nextlevel: a launcher stays and fails (npm's `pnpm.cmd` with
  `pnpm.exe` gone), `nextlevel` fails to start (`bin\nextlevel.mjs` gone). So the hub checks the files a worker needs
  before each start (dispatch waits while they are gone), a worker whose processes vanished without a report is
  "Stopped from outside" (not an attempt), and `tool.files` lists what is missing. One exception the owner made, for
  `agy.exe`, is the narrow one SETUP suggests; nextlevel never changes the antivirus's settings.
- A PowerShell script that calls Win32 window functions directly through `Add-Type` was blocked as "malicious
  content" (FR-010): measurements use UI Automation's managed classes and WMI instead.

## A worker stopped from outside (FR-013)
- **Node starts every child in a job that closes with it, and lets that child's own children out of it** (libuv's
  kill-on-close job, with silent breakaway; only `detached` children stay out, and those have no console). Measured on
  Windows 11 with Node 24: a node process A started B (cmd.exe running a `.cmd` shim), which started C (node). Killing
  A alone killed B too, and C ran on; C's parent id is B's, which is gone, so `taskkill /T /PID <B>` finds nothing. So
  a worker's process (`_run`) that an antivirus kills takes its engine along only when the engine is its own child:
  engines start without cmd.exe in between (`spawnDirect` in lib/proc.mjs, for npm's cmd-shim and plain launchers; any
  other shim keeps cmd.exe), and agy.exe starts directly anyway. What the engine started (a tool's shell, a test run, a
  dev server) lives on, under a parent that is gone: the hub finds it in one listing of all processes, by parent ids
  and start times (lib/proctree.mjs), and holds the slot until nothing of it runs.
- **A hub that ends takes the workers it started without a window along** (the same job): measured, a process started
  the way `startInConsole` starts a worker died when the process that started it exited, and the engine behind a shim
  lived on. So on Windows, "running workers keep going" after the hub stops holds only for workers in a window of their
  own; the next hub finds the others stopped from outside, and cleaning their slots stops what they left. Not fixed yet:
  keeping a worker out of the hub's job needs a start that keeps a console with no window and isn't the hub's child.
- **Windows gives a pid to a program started later, and soon**: a pid from an earlier hub run never identifies a
  process by itself. Its start time does: a process that started after the time `run.json` recorded for that pid is
  another program, and neither it nor what it started is touched. While the hub holds a process it started (its own
  child, not yet ended), no other program can have that pid.
- **So every kill names the process by its pid and its start time together.** On Windows the check and the kill go
  through one handle to the process (`[Diagnostics.Process]`: `.Handle` opens it, then `StartTime`, then `Kill()`),
  and while it is open no other program can get that pid; elsewhere `ps` is asked right before the kill (Linux and
  macOS hand pids out in turn, so one comes back only after all the others). The one kill that names no single process
  is a worker's process group on Linux and macOS, just after the hub collected the worker's process: the group keeps
  that id while any process of it runs.
- **On Linux a killed process stays listed until its parent collects it (a zombie)**: `ps` shows it (state `Z`) and
  `kill(pid, 0)` says it is there, though it runs nothing. The first Linux CI run of the new tests failed on that: the
  tests' own processes, killed while the test waited for the hub, looked like processes that "wouldn't stop". The
  snapshot leaves zombies out, and the stop step counts one as gone. In a container whose first process isn't an init
  (`docker run` without `--init`, where it is the test runner), orphans are never collected: run the tests with `--init`.
- **Windows PowerShell can take over 20 s to start on a busy PC** (a GitHub runner, where the FR-013 test once left an
  engine running because the answer came late); here `Get-Process` took 0.3 s and a CIM listing of all processes 0.5 s.
  A late listing is asked again later, never taken as "nothing runs"; the hub runs one only when a worker ends, when it
  starts, and when the owner asks, never on a timer.

## Windows, cmd and git
- `cmd /s /c "..."` strips the first and last quote: wrap the whole command in one extra pair.
  `cmd /k` without `/s` strips the first and last quote when there are more than two: wrap again.
- `%` expands even inside quotes in cmd: never pass user text containing `%` through cmd.
- `start "title" program args`: the first quoted argument is always the window title. The title holds the
  project's name from `nextlevel.json`, which a cloned repository sets: a `"` there would end the title and cmd
  would run the rest, and `%` expands. `windowTitle()` (lib/proc.mjs) keeps letters, digits and `.,()_-` only
  (found by rafter's scan, FR-010).
- Kill process trees with `taskkill /PID <pid> /T /F`. `process.kill(pid, 0)` works for liveness.
- A folder can't be deleted while a running process has it as its current folder. A worker that
  lingers after finishing keeps its slot busy (and, in tests, the temp folder). So only a worker with
  its own window pauses at exit (`NEXTLEVEL_IN_WINDOW=minimized|visible`, set by the hub), after it has moved to
  the temp folder; workers with no window exit at once.
- Replacing a file another process has open can fail with EPERM: `writeJson` retries the rename.
- `git rev-parse --abbrev-ref HEAD` fails in a repo with no commits (shown as "(none)").
- Per-worktree settings need `extensions.worktreeConfig=true` in the shared config. With it on,
  `core.worktree` in the shared config applies to every worktree, so it must move to the main
  checkout's `config.worktree` first (git-worktree docs).
- A remote can have several `pushurl`s and a push goes to all of them. An empty `pushurl` clears the
  list only from Git 2.46; older Git adds an empty URL instead. The hub checks a slot's push URLs
  with `git remote get-url --push --all` rather than trusting its own settings.
- `url.<base>.pushInsteadOf` is ignored for a remote that has a `pushurl`. An empty value matches every
  URL, including explicit paths, and the longest match wins.
- Git for Windows has no executable bit: a hook runs if it starts with `#!` (or is an `.exe`), with
  git's own sh. Hooks run from the top of the worktree.
- An elevated PowerShell starts in `C:\Windows\system32`: warn when running elevated or from there.
  `whoami /groups` shows the integrity level as a SID in every language (`S-1-16-12288` = elevated).
- `git var GIT_AUTHOR_IDENT` fails exactly when `git commit` would for lack of an identity. When it
  succeeds without `user.name`/`user.email` set, git guessed one from the PC's name.
- `powercfg /query SCHEME_CURRENT SUB_SLEEP STANDBYIDLE` prints labels in the Windows language; the
  last two hex numbers are the AC and DC values in seconds.

- A PATH change made by an installer (winget, the agy installer, `_install`) is in the registry and
  reaches windows opened afterwards only; a process that was already running (the dashboard) doesn't see
  it. The dashboard reads the machine's and the user's `Path` again through PowerShell
  (`[Environment]::GetEnvironmentVariable`, with UTF-8 output: user folders can have non-ASCII names)
  before it runs the doctor or starts anything.
- `start "" "<url>"` opens a link in the default browser; the empty first argument is the window title.
  The dashboard only passes its own link through cmd (letters, digits and `:/?=_-`), never text with `%`,
  `&` or `^`.

## GitHub's Windows runner (CI)
- **The first `docker info` on a fresh runner is slow.** Docker is installed there, and the suite's
  first doctor run, the only one that reached the real Docker engine first, took 18-26 s; later runs
  took 2.5 s. With Docker stubbed (`test/stubs/fake-docker.mjs`) that run takes 3 s. Tests stub every
  tool the doctor calls; the first doctor run in the suite logs its slowest checks, so a new slow tool
  shows up in the CI log.
- The runner's shell is elevated, so `window.elevated` warns there; that is expected.
- Node's default HTTP agent keeps connections alive (Node 19+) and a `node:http` server closes idle
  ones after 5 s. A test that blocks its event loop that long (a `spawnSync` doctor run takes about
  5 s here) then reuses a socket the server already closed and gets `ECONNRESET`. The dashboard tests
  open a connection per request (`agent: false`).
- **`TEMP` there is an 8.3 short name**: `C:\Users\RUNNER~1\AppData\Local\Temp`, while `where` answers with the
  long one (`C:\Users\runneradmin\...`) for a folder on PATH by its short name. Two paths to the same place can't be compared as text: the
  tests' trip-wire (FR-010) first refused every stub there, because the stub folder came from `TEMP` and the
  found stub from `where`. Compare `fs.realpathSync.native` of both (it gives the long names).
- Its Windows job takes about 17 minutes (processes start slowly there): the job's time limit is 30.

## PowerShell (the installer)
- `Move-Item` of a folder to another drive fails in Windows PowerShell 5.1 ("Source and destination path
  must have identical roots"), and a folder with a file in use can't be moved at all: the installer then
  clones afresh into the new folder and leaves the old one. `Move-Item` into a folder that exists moves the
  source *inside* it, so an empty target folder is removed first. A git clone's worktrees record absolute
  paths: `git worktree repair` after a move.
- **Short 8.3 names.** Windows keeps a short name for long folder names (`C:\Users\RUNNER~1` for
  `C:\Users\runneradmin`; the CI runner's `TEMP` uses it), so one folder has two spellings. A process's
  command line keeps the spelling it was started with, and `[IO.Path]::GetFullPath` expands short names in
  Windows PowerShell 5.1 but not in PowerShell 7. The installer turns both sides into the long form with
  Windows' `GetLongPathName` (`Get-LongPath`: the folders it installs to, and every path in a running
  node.exe's command line) before it compares them, and a test runs nextlevel from a folder's short name.
- `irm <url> | iex` and `gh api ... | Out-String | iex` run the script's text inside the owner's own
  session: `exit` closes their window, and variables set at the top level stay behind. `install.ps1`
  wraps everything in `& { ... }` and stops with `return`.
- Windows PowerShell 5.1 decodes a native command's piped output with the console's code page (OEM),
  so non-ASCII text from `gh api` arrives garbled: keep `install.ps1` ASCII (a test checks).
- The default execution policy on Windows clients blocks `.ps1` files, including npm's `.ps1` command
  shims (`nextlevel.ps1` from npm link), which PowerShell prefers over the `.cmd` next to them. `iex`
  of text is not affected, and neither are `.cmd` files: the installer makes `nextlevel.cmd` only.
- `[Environment]::SetEnvironmentVariable('Path', ..., 'User')` reads the expanded value and writes
  REG_SZ, freezing entries like `%USERPROFILE%\...`. Use `Registry.CurrentUser` with
  `DoNotExpandEnvironmentNames` and `RegistryValueKind.ExpandString`; setting any user variable through
  `[Environment]` afterwards broadcasts the change to Explorer.
- Inside a PowerShell function, anything not assigned or used (a native command's output, another
  function's return value) becomes part of the function's result. Pipe native output to `Out-Host`
  and assign or test every call.
- A native command whose output is piped isn't on a console, so interactive programs (`gh auth
  login`, winget's progress) run through `Start-Process -NoNewWindow -Wait` instead.
- `"$name:"` in a double-quoted string is read as a drive-qualified variable: write `${name}:` or
  avoid the colon.
- Git Credential Manager can pop up a login window even with `GIT_TERMINAL_PROMPT=0`; set
  `GCM_INTERACTIVE=never` too.

## cmd
- cmd.exe reads a running `.cmd` file line by line, so rewriting one while it runs (a hub started
  through `nextlevel.cmd`) can execute garbage: `_install` leaves an unchanged shim alone.
- **A `.cmd` shim can't carry free text in an argument (FR-014).** The orchestrator's shell (Codex runs
  `powershell.exe -Command '...'`) starts `nextlevel.cmd`, whose `%*` cmd.exe parses again. Measured on the owner's PC
  with a shim that prints its arguments: `"line one<LF>line two"` arrived as `line one` (cmd.exe ends the command at a
  line break), `'He said "yes" 100% ^caret & amp ! bang %PATH%'` as `He said yes ...` with the quotes gone and `%PATH%`
  expanded to the PATH itself. So every command that takes free text reads it from a file (`--file <path>`, or `--file
  -` for stdin), and `nextlevel handoff answer` takes it no other way. PowerShell 5.1 piping text to a native command
  encodes it with `$OutputEncoding` (ASCII by default: non-ASCII becomes `?`), so a file is the safe way, not stdin.

## npm
- Newer npm skips install scripts that aren't allowed: a global install of Claude Code printed
  "not yet covered by allowScripts". Install with `--allow-scripts=<package>`. The `claude` command then
  exists but doesn't run, so `tool.claude` runs `claude --version` rather than looking for the file.

## Claude Code
- **`claude -p "<prompt>"` runs headless**, with no console: it works for workers and autopilot cycles
  (only a new *cloud* session needs a terminal, below). A tool call that would ask for permission is
  refused in print mode rather than waiting, so each role's rules are passed as arguments:
  `--permission-mode acceptEdits`, `--allowedTools` and `--disallowedTools` with `Bash(<command>:*)`
  patterns (deny rules win over allow rules). The prompt goes first: those options take several values
  and would take a prompt after them for one. `--dangerously-skip-permissions` is refused when running
  as root.
- **Its Bash tool keeps the first 30,000 characters of a command's output** by default (`BASH_MAX_OUTPUT_LENGTH`),
  more than Codex keeps: `nextlevel result`'s budget is set by Codex's (FR-012, under Codex CLI).
- **The assistant (Ask): `claude -p` with no prompt argument reads it from stdin**, so the owner's question never
  goes through cmd.exe to a `.cmd` shim. Its rules, from the [permissions docs](https://code.claude.com/docs/en/permissions)
  (2.1.283): a deny rule wins over every allow rule, the owner's own settings included; `*` in a Bash rule stands
  for any text, and a prefix rule covers every flag after it, so `Bash(git diff:*)` would also approve
  `git diff --output=<file>`, which writes that file: `Bash(git *--output*)` and the flags that read outside the
  repository or run a program are denied. Compound commands (`&&`, `;`, `|`, `$(...)`) are checked part by part.
  `Read(./.env)` covers Read and, best-effort, Grep and Glob, but not Bash, and some read-only commands (`cat`)
  run without any rule, so `Bash(*.env*)` is denied too. Plan mode "keeps its blocks" under `-p`.
  `--setting-sources user` leaves out the repository's `.claude/settings*.json` (a merged task could add allow
  rules or hooks there), `--strict-mcp-config` with no `--mcp-config` starts no MCP servers. `--restricted`
  (2.1.283: no command tools, no settings files, file tools kept to the working folder) would be stronger, but
  older versions refuse the flag.
- It reads `CLAUDE.md`, not `AGENTS.md`: nextlevel's prompts tell it to read `AGENTS.md` first.
- **`claude -p` ends when the model ends its turn, and stops what it left running in the background (FR-020).** WS-62's
  attempt 10 on a real project (2.1.284) started its long check with `run_in_background`, then a background wait for it, and
  ended its turn to wait for it: the run printed `result` (`subtype: success`, `terminal_reason:
  completed`, 85 turns), then `system`/`task_updated` events with `status: killed` for both commands, and exited 0. It
  never wrote its report. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` takes `run_in_background` away from its Bash tool
  ("An unexpected parameter `run_in_background` was provided", measured on 2.1.284); its Bash tool then stops a
  foreground command after 2 minutes (10 at most) unless `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` say more
  (a 150-second command ran to its end with them). Workers get all three, the limits at half the attempt's (at least 10
  minutes, so a command cut off still leaves time for the report), and no `Monitor` tool.
- **How a run ends (FR-020, measured on 2.1.284):** the last `result` event says it: `subtype` (`success`,
  `error_max_turns`, `error_during_execution`...), `is_error`, `num_turns`, `terminal_reason`, its last answer in
  `result` (a success only), and for an error `errors` (strings). `--max-turns 1` ended with exit 1, `error_max_turns`,
  `errors: ["Reached maximum number of turns (1)"]` and no `result` text; a `task_summary` system line came after it.
- **A worker without the owner's own add-ons (FR-013, measured on 2.1.280):** `--strict-mcp-config` (no `--mcp-config`)
  starts no MCP servers (the claude.ai connectors included), and `--setting-sources project,local` leaves the user's
  settings out: their hooks and enabled plugins, and with them the owner's skills (`~/.claude/skills`; the session's
  `init` listed only Claude Code's own). It also leaves out the user's `model` and `effortLevel`, so a worker without a
  model of its own is given those. Hooks, skills and plugins come together (all in the user's settings), and some MCP
  servers without the others would need their settings copied to a `--mcp-config` file: `workers.addons` gives all of a
  kind. `--safe-mode` (2.1.280) would drop the project's `CLAUDE.md` and hooks too; `--bare` reads only an API key.
- **Tokens (FR-008):** headless runs get `--output-format json`: at the end Claude Code prints one JSON
  object (`type: "result"`, `result`, `num_turns`, `is_error`, `total_cost_usd`, and `usage` with
  `input_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `output_tokens`). In text mode
  `-p` prints only the final answer too, so the log loses nothing; the dashboard shows the JSON as that
  answer plus a line with the tokens. nextlevel counts input, cache writes and output (like Codex's
  `tokens used`) and keeps cache reads apart. The interactive window's tokens aren't counted.
- **Its steps (M10):** headless runs now get `--output-format stream-json`, which `-p` accepts only together
  with `--verbose` ("When using --print, --output-format=stream-json requires --verbose"). One JSON object per
  line: `system` (init), `assistant` (`message.content`: `text`, and `tool_use` with `name` and `input`: Bash's
  `command`, Edit's and Write's `file_path`), `user` (`tool_result` with `tool_use_id`, `content` as text or
  blocks, `is_error`), and the same `result` object as above last. Assistant lines carry `message.usage`
  nested, never a top-level `usage`, so the tokens still come from the result line. The feed and the log the
  dashboard shows are read from these lines.
- **Model and effort:** `--model` takes an alias (`opus`, `sonnet`, `haiku`, `fable`, `opusplan`, `best`,
  `default`) or a full name; `--effort` takes `low`, `medium`, `high`, `xhigh`, `max`. Without them it uses
  `ANTHROPIC_MODEL`, else `model` and `effortLevel` in its `settings.json` (`~/.claude`, or
  `CLAUDE_CONFIG_DIR`). No command lists the models: `claude.model` tries a pinned one with a one-line
  prompt ([model config](https://code.claude.com/docs/en/model-config),
  [CLI reference](https://code.claude.com/docs/en/cli-reference)).
- Nothing sandboxes `.git` for it: an orchestrator on Claude Code could commit itself, so its rules deny
  git writes and it uses `nextlevel commit`/`merge`/`cleanup` like on Codex.
- On Windows its Bash tool runs in Git Bash, which runs the extensionless `nextlevel` script the
  installer puts next to `nextlevel.cmd`.
- **A second account: `CLAUDE_CONFIG_DIR`** moves its folder (settings, sessions, `.credentials.json` on
  Windows and Linux; on macOS the Keychain entry becomes `Claude Code-credentials-<hash of the path as
  written>`, so always the same absolute path). Its docs suggest it for several accounts side by side
  ([env vars](https://code.claude.com/docs/en/env-vars)). `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and
  `CLAUDE_CODE_OAUTH_TOKEN` in the environment win over the folder's sign-in: sessions on a named
  account don't get them. `claude auth status` (2.1) prints JSON (`loggedIn`, `authMethod`, and `email`,
  `subscriptionType` for a Claude.ai login) and exits 1 when signed out; `claude auth login` signs in.
  Tools may not collect, store or intermediate Claude.ai credentials: nextlevel never reads them.
- `claude --cloud "task"` run in a repo folder starts a cloud session that clones that folder's GitHub
  remote ([docs](https://code.claude.com/docs/en/claude-code-on-the-web)). Cloud sessions only see what
  is in the repo (`CLAUDE.md`, `.claude/`), not personal settings.
- **Without a GitHub connection, `claude --cloud` still starts a session, but it can't push.** The
  session gets an uploaded copy of the folder with no git remote: it can work, but can't push a branch
  or open a pull request (FR-002). Connect first (browser: https://claude.ai/connect-github, and install
  the Claude GitHub App on the repo), or start the session at claude.ai/code with the repo selected.
  A session's repos are fixed when it starts, so connecting later doesn't rescue a running session.
- Slash commands (`/web-setup`, `/claim-credit`) are typed inside Claude Code, not in PowerShell.
- **`claude --cloud "task"` starts a new cloud session only in a terminal** (FR-006; Claude Code 2.1.282
  and 2.1.283; `--remote` is its older name). With `-p` it refuses ("Error: --cloud cannot be combined
  with --print": with `-p`, `--cloud <session-id>` only sends a message to an existing session), and
  with its output in a pipe or a file too ("Error: --cloud requires an interactive terminal"), so a
  program can't read what it prints. In a terminal it may ask something first (whether to trust the
  folder, first-run questions), then prints `Created cloud session: <title>`,
  `View: https://claude.ai/code/session_...` and `Resume with: claude --teleport session_...` and ends.
  `--cloud` takes the task as its value. `nextlevel fix` runs it in the owner's window and gets the
  session from `--debug-file <path>`, where Claude Code logs `Successfully created remote session:
  session_...` once it exists. That is a debug line, not a promise: without it nextlevel says it can't
  tell whether a session started.
- Without a usable GitHub connection `claude --cloud` **uploads the local repository** (all branches and
  uncommitted changes to tracked files; up to 100 MB) instead of cloning it; `CCR_FORCE_BUNDLE=1` forces
  that. So `nextlevel fix` runs it only in the tool's own clone, never in a project, and removes
  `CCR_FORCE_BUNDLE` from its environment
  ([docs](https://code.claude.com/docs/en/claude-code-on-the-web)).
- No command tells whether the Claude account is connected to GitHub, so `claude.github` asks the owner
  once. `/web-setup` inside Claude Code connects it with the GitHub CLI's login.

## GitHub CLI (issues)
- `gh issue create --label x` fails ("could not add label: 'x' not found") when the repository has no such
  label; only accounts with write access may make one (`gh label create`). `nextlevel report` makes it,
  and files without it when it can't.
- `gh issue view --json state,stateReason` says `CLOSED` with `COMPLETED` both when a pull request with
  "Fixes #n" was merged and when someone closed it by hand (GitHub's default reason; FR-006 #4), and
  `NOT_PLANNED` when closed as not planned. Only the close event says what closed it: its `closer` (a
  `PullRequest`, a `Commit`, or none when closed by hand), which only the GraphQL API has, so the fix loop
  asks `gh api graphql` (`timelineItems(itemTypes:[CLOSED_EVENT],last:1)`). The issue's
  `closedByPullRequestsReferences` (also in `gh issue view --json`) lists only open pull requests unless
  asked with `includeClosedPrs`, and a pull request that mentions the issue need not be what closed it.
- **`gh auth status` shows the owner's own login beside a `GH_TOKEN` that doesn't work** (gh 2.x, measured in
  a test project's workers on 15 October): "X Failed to log in to github.com using token (GH_TOKEN)", then "✓ Logged in to
  github.com account <owner> (keyring)", not active. gh uses the token while it is set, so the push block's token keeps
  it out; but where `GH_TOKEN` is gone (an engine's shell that drops variables named like a token, as Codex's can, or a
  command run without it) gh is signed in as the owner. So every worker task (its process and its task's verify commands
  in the slot) and every `nextlevel verify` command gets `GH_CONFIG_DIR` set to a folder with no sign-in in it
  (`lib/workerspec.mjs` NO_GH_CONFIG): gh then answers "You are not logged into any GitHub hosts", and finds no keyring
  entry to read either (gh looks one up only for an account its `hosts.yml` names). That stops a shell that drops
  token-named variables and gh used without thinking; it is no wall: a worker that unsets `GH_CONFIG_DIR` as well gets the
  owner's keyring login back (FR-017's "what an agent running as the owner can still do"). It is one folder in the temp
  folder for every slot and project, so the hub takes out a `hosts.yml` it finds there before each task starts, and logs
  it. The hub's own gh, the orchestrator and the setup guide keep the owner's (a verify command's GitHub reads use their
  own read-only token, FR-017). The bridge test's workers ask `gh auth status`, and the test fails if it answers as anyone.

## git
- `git remote get-url` applies `url.<base>.insteadOf` rewrites; `git config --get remote.<name>.url` is the
  URL as configured. Which GitHub repository a clone comes from is the configured one.
- **A plain `git status` takes `index.lock` for a moment.** It refreshes the index and writes it back, holding the
  lock while it does; a `git add` or `git commit` in the same checkout at that moment fails ("Unable to create
  '.../index.lock': File exists"). The dashboard runs `git status --porcelain` in each running or verifying task's
  slot every few seconds, and verifying is when the hub commits a worker's changes: once the hub's `add -A` failed
  unnoticed and the commit then said "nothing added to commit". Now every git that only reads runs with
  `GIT_OPTIONAL_LOCKS=0` (git skips the refresh and takes no lock), and a git that writes is run again for up to
  10 s while the lock is held (`src/lib/gitlock.mjs`). Other programs (an editor polling the checkout) can still
  hold it, and a git that crashed leaves it behind: after 10 s the hub reports the step as failed, with the lock.
- Git's messages are in the owner's language, but a path in them is printed as it is: "index.lock" in a failed
  command's output is how a held lock is told apart, in any language.
- **nextlevel's own git commands can leave git's maintenance running in the background.** Git runs
  `git maintenance run --auto` after commands that write (fetch, clone, merge, commit) and, by default, detaches it
  (`maintenance.autoDetach`). When its thresholds are met (git 2.55's geometric repack: packs to merge, or 100 loose
  objects or more) it repacks after the command has returned. Seen on FR-019's pull request (7 October, Docker, git
  2.55.0, install.test.mjs 20 times each): on the branch, whose larger tree crosses that threshold in the test's tool
  clone, every run had `git maintenance run --auto --detach`, `git repack --cruft --write-midx` and `pack-objects` still
  working in the tool folder when the test deleted it, and 15 of 20 failed because `.git/objects` came back a few
  milliseconds later (EEXIST); on main none of 20. nextlevel runs such commands in **the tool folder** (install.ps1:
  clone, fetch, switch, merge; `nextlevel update`: fetch, merge --ff-only, switch), **the project** (the hub's commits
  and merges for the orchestrator) and **the slots** (its commits of a worker's work, its merges of the base branch).
  A detached repack there keeps a process whose working folder is in it (on Windows that folder can't be renamed or
  deleted meanwhile: the installer moving an install to `NEXTLEVEL_DIR`, or a folder that isn't a clone aside), holds
  files open, and takes `objects/maintenance.lock`, which a git command at the same moment meets; `src/lib/gitlock.mjs`
  only waits out `index.lock`. **The tool folder: fixed by safe updates (part A).** The installer and the updates turn
  `gc.auto`, `gc.autoDetach`, `maintenance.auto` and `maintenance.autoDetach` off in the tool's clone (worktrees share
  its config, so every version's folder and the fix sessions' too; `test/install.test.mjs` reads the clone's own
  setting). An existing install gets it at its next update or when the installer runs again. Not fixed yet: the project
  and the slots, a later hub change (the hub's own git with maintenance in the foreground, or off). The tests' sandbox
  still turns git's automatic gc and maintenance off for everything (`test/helpers.mjs`) until that change.

## Autopilot rounds (FR-019)
A round starts only because something happened (`src/lib/rounds.mjs`; DECISIONS has the rules). What to know:
- **Nothing starts the first round by itself.** Turning autopilot on, or starting the hub, with nothing new starts none:
  a new project's first round comes with the owner's first note, or Run a round now on Home.
- **The orchestrator's window holds rounds back.** While it is open nothing starts; what came meanwhile starts one round
  once it closes (a job the window reviewed starts nothing).
- **A round that plans without dispatching ends the team's work** until the owner acts or a task ends: a round's work
  that should go on must end with something real (a task dispatched). The role doc says so; an orchestrator on an older
  role doc (`project.role-docs` offers the new one) may still leave "the next round continues" in STATUS.
- **A wake-up's time on Home is this PC's local time**, in its language's format; it is kept in UTC, so a clock change
  (1 November in the US) moves only how it is shown.
- **A retry is real, so a task that never gets going is bounded only by the hourly ceiling.** A worker that never starts
  ends its attempt (a task's end: always a round), and an orchestrator that retries it makes work move (a retry is
  real: the brake starts again). Round after round, that is 8 an hour until someone looks. Holding a task back after
  attempts that never started is the stuck ladder's job, not the rounds'.
- **An agent can pin a round the hub holds no handle for as running.** A round in a window of its own, or one the last
  hub started, is told by the pid and start time `cycle.json` and `rounds.json` give, and the round's engine can write
  both: a pid of a process of its own and no `startedAt`, or a pid whose start can't be read and `rounds.json`'s start
  taken out, keep it "running", and no other round starts (Home says "A round is running"). That stops the team rather
  than spending Codex. A round the hub starts with its own child process can't be pinned: the hub follows the child, not
  the file. Until FR-017 part 2B keeps the team out of `.nextlevel/`.
- **On Linux a clock step can misjudge a process's start time.** `processStartSync` reads it from /proc as boot time
  plus ticks, and the boot time moves when the clock is set (an NTP step): a step of more than 2 s while a round the last
  hub started runs can make it read as another program's, and the round ends as cut off while its process still runs
  (its retry then runs beside it). Windows reads the start time itself.
- **The start time of a process is asked of PowerShell on Windows, with an encoded command** (`processStartSync` in
  `src/lib/proctree.mjs`, as the process snapshot already does): an antivirus watches that pattern. nextlevel asks it
  only for a lock whose holder has kept it a second (lib/filelock.mjs), and at most once a minute for an autopilot round
  the hub holds no handle for (one in a window of its own, or one the last hub started). If an antivirus blocks it, the
  start reads as unknown: a lock is then taken over at 12 s, and such a round counts as ended once it is 70 minutes old.

## Releases and version folders (safe updates)
- **A tag moved before this PC first saw it is taken as it is.** The tool refuses a release tag whose object or commit
  differs from what it first saw (`~/.nextlevel/releases.json`), but it can't know a tag it never saw: one moved on
  GitHub between its push and this PC's next look (the hubs look every 6 hours) is first seen moved. The tag must still
  be annotated, titled and on main's history. A tag ruleset on GitHub ("Restrict updates", "Restrict deletions" on
  `v*`, the owner's setting) closes it for everyone but the owner's own account.
- **A new version's folder has none of the antivirus exceptions made for the old one.** Exceptions are per path, and
  each version runs from `~/.nextlevel/versions/<name>`. One folder exception on `%USERPROFILE%\.nextlevel\versions`
  covers every version (the README and `tool.files` say so); the launcher and the command stay at fixed paths in
  `~/.nextlevel/bin`.
- **A round that dispatches a task while the update waits** finds it held until the update ends (the update's hold:
  new tasks wait from the click); a `nextlevel wait` on it waits until the round's time limit. Its checks, pushes and
  git jobs still run while the update waits. The hold is a convenience, not a wall: an agent that knows the update's id
  (in `~/.nextlevel/update/hold.json`) can queue a job as the update's own, and one without a sandbox can write the file.
- **The old hub's window stays open at a prompt** after the update stopped its hub (`cmd /k`); the hub goes on in a new
  window. A hub started with `nextlevel run` in the owner's PowerShell comes back in a window of its own.
- **The run registry misses commands run in Codex's sandbox**, which can't write the home folder; the update waits for the
  rounds and windows those commands belong to.
- **A version folder still in use isn't removed.** Windows keeps a folder a process runs from: an update leaves an old
  version's folder it couldn't remove, and a later update tries again.

## GitHub checks on this PC (the self-hosted runner)
- **What part A reads, and how fresh.** The Team page's card and `nextlevel team runner status` read the repository with
  the owner's gh (GETs only) and keep the answer 10 minutes in `~/.nextlevel/cache/repos.json`. A repository that turns
  public shows on the card at the next read; `nextlevel team runner on` reads it afresh every time. Part A sets up no
  runner, so nothing runs on the PC yet; part B's job hook checks the visibility before every job.
- **The minutes are the latest 30 runs' of the last 30 days**, each job rounded up to a whole minute as GitHub bills
  it, read from the runs' jobs (GitHub's billing API needs scopes the owner's gh doesn't have). The card says when there
  were more runs than it read, and gives no money figure: the owner's plan and included minutes aren't readable.
- **Fork settings and collaborators need rights.** Reading the fork pull request settings needs admin on the
  repository, and the collaborators push rights: without them the doctor's rows say "can't read" (a warning), never
  "off".
- **A billing lock may stop self-hosted jobs too.** GitHub's docs don't say whether an account whose Actions spending is
  blocked still runs jobs on self-hosted runners, and community reports say they stayed queued. A runner on the PC saves
  the minutes that lead to a lock; it may not get past one (the design's sources).

## The security engineer's scanner (OpenAI's Codex Security container)
Measured on Windows 11 with Docker Desktop (Step 0 and 0b, 26 and 27 October), with the image nextlevel pins
(`src/lib/securityimage.mjs`, by digest).
- **Inside the container, Codex's sandbox holds.** The model's commands run in Codex's own sandbox there (bubblewrap
  with the vendored seccomp profile): the sign-in folder is denied and can't be listed, the planted `auth.json` can't be
  read, and the network is closed. The doctor's `security.probe` asks that again for every new image, model-free, and
  no scan runs with an image whose probe gave another answer.
- **The scanner's own process keeps a network path to the PC.** `--add-host` points `host.docker.internal` and
  `gateway.docker.internal` nowhere, but the host stays reachable at its address (192.168.65.254 in 0b): a name
  change, not a wall. Every program on the PC listening on 127.0.0.1 is reachable from the scanner's process (OpenAI's
  code, not the model's commands), not only the dashboard, which needs its session key (FR-017 part 2A). Web search is
  off for the scan (`--codex web_search="disabled"`, checked by the scanner's dry run). An egress proxy comes later.
- **Docker's access reads the sign-in.** Anything on the PC that can run `docker` can mount `nextlevel-sec-login-*` and
  read the scanner's ChatGPT sign-in. That includes a Codex worker out of its sandbox, which has Docker (workers' part
  A). It is no worse than today's reads (FR-023: a worker out of the sandbox reads `~\.codex\auth.json`), and no wall.
  Extra layers, by pattern and after the fact: a Claude Code worker is told not to run a command that names
  `nextlevel-sec-` (`WORKER_DENY_NAMING`); every worker's log is read for one (`src/lib/slotwatch.mjs`: a Home card,
  as for writes outside the slot). The Team row says so.
- **Daybreak Blue is asked for, not confirmed.** The scanner accepts `--cyber-access-program daybreak_blue` with a
  ChatGPT sign-in, but nothing in its output says Blue was used. The doctor's `security.daybreak` passes on what
  `codex debug models` lists for the model (`available_access_programs`), and a scan's record says "asked for, not
  confirmed by the scanner".
- **A scan costs.** A 41-file scan used about 6% of a week's allowance (3,444,876 tokens, mostly cache reads); a larger
  project uses more. Each scan's tokens go into the usage ledger from the scanner's own TOKENS line.
- **A repository written to fool the scanner can still hide a finding.** Its steering files are set aside before a scan
  (`AGENTS.md`, `.claude/`, `.codex/`, `SECURITY.md` and the rest the guard protects), and the output is read through
  its seal (the manifest's hashes) and shape checks, but what the model concludes from the code itself is its own: bars,
  not walls.
- **What an agent running as the owner can still do here:** ask for a scan (`nextlevel security scan` and the hub's
  own `_scan` refuse in an agent's session, which is no wall: FR-017), including a deep one that spends the plan, or
  write a request file into the guard's folder, which the hub takes as the owner's ask; change `.nextlevel/security/`
  (the findings' hashes are kept in the guard's folder, outside the project, so a changed file reads as untrusted); hold
  the one-scan lease. Each is a bar, not a wall.

## The tester (part 1)
- **The sign-ins are sealed for your account, not walled from it.** Any program running as you can ask Windows' DPAPI,
  an unlocked Linux keyring or (after its prompt) the macOS keychain to open the key, as `_accept` does. A worker in
  its slot or the orchestrator in Codex's sandbox can't reach the store's program or `~/.nextlevel`; an agent running
  as you, outside a sandbox (a Codex worker with the sandbox off, Antigravity's full access), can. Use test accounts
  made for testing, with nothing real behind them.
- **What an agent running as the owner can still do:** ask for runs (`tester run` takes the orchestrator's within
  `maxRunsPerHour`; a request written into the guard's folder counts as the owner's), and write plans the orchestrator
  commits. A plan reaches only the environments' origins and `alsoAllow`, and a step that mutates runs only where
  `allowMutations` says; `nextlevel.json` changes only with your approval.
- **Redaction is by value and by shape.** A password the app shows encoded another way (URL-encoded, base64 under 40
  characters, split across fields) isn't recognised; JWTs, long base64 strings and secret-looking JSON keys are blanked
  whatever they hold. The evidence keeps a body's first 2 KB and headers on an allow-list only.
- **HTTP, simply.** One cookie jar per host, without cookies' Domain and Path rules; no proxy (the run's
  environment is built from nothing); a body read up to 2 MB.
- **The app under test sees the passwords** it signs the personas in with, as it would any user's: an environment
  that logs request bodies keeps them. That is the app's to fix.

## The tester's browser (part 2)
- **`~/.nextlevel/tools` is yours, not walled.** An agent running as you can write it as easily as a project's
  `node_modules`. What the folder gains: the guard isn't fooled by a project diff, and the hashes recorded at the
  install catch an ordinary change (an update, a half-finished install, a planted file) before a run starts the
  browser. The doctor compares names and sizes only (it runs often); a run reads every byte.
- **A page can still show a secret in a picture.** The screenshot check reads the page's text and fields: a value drawn
  in a canvas or an image, put there by CSS, or spread over several elements isn't found in one element (the last case
  keeps the picture out). Frames are read too (a kept value in one, or a frame that can't be read, keeps the picture
  out); a shadow root's text isn't. The page's own scripts see the `data-nextlevel-i` marks the check puts on elements, and could
  change what the check reads; the app under test is trusted that far.
- **What a page loads from elsewhere isn't loaded**, and the step says so (`blocked` in its evidence) without failing:
  a page that needs a script from another host behaves differently in the tester than for a user. Add that origin to
  `alsoAllow` if the page needs it (your approval, like any change of `nextlevel.json`).
- **WebSockets** go through `routeWebSocket()` and the run's proxy; they are covered by the stand-in browser only, not
  yet by a test against a real WebSocket server.
- **What a page keeps in storage:** after the sign-in and after each step, the values the run's origins keep in local
  storage join the run's redaction like its cookies, when 16 characters or longer (a token is; a short setting stays
  readable). A token shorter than that, or kept only in IndexedDB or session storage, isn't found.
- **A run stopped hard can leave Playwright's temporary browser profile** in the system's temporary folder, with that
  run's cookies; a run that ends removes it. **The run's proxy takes connections from any program on this PC** while the
  run lasts: it reaches only the run's origins and carries none of the browser's sign-in.
- **A request a page sends after a click comes a moment later:** the step's leave to write lasts until the next action,
  and a click waits for the network to be quiet for half a second (up to 5 s) before the page is read.

## What the guard doesn't cover (yet)
The guard (`src/lib/guard.mjs`, `docs/CHECKS.md#guardheld`) holds changes to protected files that go through git
(a task's merge, the orchestrator's commit) and sets back changes made on disk in the project while the
orchestrator works. It doesn't reach these:
- **Global config in the owner's home folder (FR-013, coming):** `~/.claude/settings.json` and its hooks,
  `~/.codex/config.toml` and `hooks.json`, `~/.gemini/`, `~/.gitconfig`, `~/.npmrc`, VS Code's user settings. Every
  session of every engine loads them, and nothing watches them yet. Since 28 September the owner's antivirus no
  longer watches what Antigravity does, so a change there has no second pair of eyes either.
- **Workers run with every permission and write straight to disk.** Antigravity runs with
  `--dangerously-skip-permissions` and without a sandbox, and Claude Code workers have their deny rules only: such a
  worker, as the owner's Windows user, can write the main checkout and the home folder's config. The guard catches
  what such a write does to the project when it goes through git or happens while the orchestrator works; it can't
  stop the write. **Such a worker could also edit the guard's own records in `~/.nextlevel/guard/`** (mark its own
  change approved, say): only a separate Windows user for workers closes that. An orchestrator on an engine without
  a sandbox (Claude Code, Antigravity) has the same reach; only Codex's sandbox keeps it inside the project. Fix
  later: a separate Windows user for workers, with its own home folder and no access to the owner's files.
- **A worker outside its slot is told after the fact, not stopped** (a test project, 17 October: N7's Antigravity worker
  typed `C:\Users\User\nextlevel-task\PROGRESS.md` for its slot's `.nextlevel-task\PROGRESS.md`, and agy wrote it). Since
  then the guard watches the main checkout while any worker runs (a protected file changed there is set back and held),
  and after each attempt the hub reads the worker's log (`src/lib/slotwatch.mjs`: agy's and Claude Code's stream-json,
  Codex's `--json`, whether or not Codex's sandbox is on) for files written outside its slot and for `git -C`,
  `--git-dir`/`--work-tree` and `cd`/`Set-Location`/`pushd` aimed at another folder (each `cd` from where the one before
  it left the command, and Claude Code's Bash from where its last command left it, so `cd web && npm test && cd ..` stays
  in the slot), and reads the main checkout's HEAD and base branch in git's reflog files on from where they ended as the
  attempt started (the hub's own git jobs say `nextlevel-hub` there; a repository whose refs are in reftable has no such
  files, and nothing is said). A Home card and one phone message say what it found. By pattern: a write by a program the worker ran (a script, `npm`), a path built in a variable, or a
  command written another way isn't seen; the system's temporary folder and agy's own notes for its session count as
  allowed. Names are compared, not resolved (a link inside the slot that points out isn't seen). A move of the main
  checkout by the owner or the orchestrator while a worker runs is on the card too (it can't be told from the worker's:
  said once, by the first attempt to end, naming the other workers that ran then, and on the phone as no alarm),
  and a worker that sets out to hide one can (its own `GIT_REFLOG_ACTION=nextlevel-hub`, `git reflog expire`): the
  reflog check is a hint against mistakes, like the rest. While a worker runs, the owner's own edits to protected files in
  the main checkout are held as during the orchestrator's work (approve them on the dashboard), which on autopilot is
  most of the time. Home shows the latest finding; each job keeps its own (`outside` in its status). The workers' prompt
  names its slot's folder and says to write only there, a full path starting with that folder as given (a relative name
  is read from the folder the engine's session says it started in, else from the slot).
- **An antivirus removes files it takes for a threat.** A held change that deletes a protected file may be the
  antivirus's doing, not an agent's (Bitdefender removed a test `START.cmd` with a download-and-run line): its card
  says so, and Reject puts the file back. Tests and demos keep their content harmless (a hook that runs
  `echo guard-test`).
- **The owner's own hand edits are held too** when made while the orchestrator works, or when the orchestrator's
  `nextlevel commit` takes them in: the guard can't tell who typed a change on disk, so it holds it; approve it on
  the dashboard. The Team page's saves, the doctor's fixes and `nextlevel init` are recorded as the owner's and never
  held.
- **Something the orchestrator leaves running after its round** (a background process it started) acts between
  rounds, when the guard doesn't watch the disk. A commit of what it wrote still needs the owner's approval (what is
  on disk when a round starts is never taken as approved), but a protected file that is only read from disk, never
  committed (`.claude/settings.local.json`, `.nextlevel/checks/`), would be in effect until someone looks. The hub
  stops a round's process tree at its time limit; a process that left it isn't stopped.
- **Ignored protected files below the top** (`packages/web/.claude/settings.local.json` in a folder `.gitignore`
  covers) aren't watched on disk: git doesn't list them, and walking every folder at every tick costs too much. The
  top's own (`.claude/settings.local.json`) are.
- A held change larger than 2 MB is watched by its hash only: it can be taken away, but a larger file it replaced
  can't be put back.
- **A value from .env in another form isn't found**: encoded (base64, URL-escaped, split across lines) or changed, it
  looks like any other text. The guard looks for the values as they are in `.env`; values under 8 characters are
  never looked for. A worker has no `.env` (slots have none, and its environment has no value of it), so a value in
  its work means it read the main checkout's, which only a separate Windows user for workers prevents.
- **The owner's own changes to git's settings or hooks get a card** (`git remote set-url`, `npx husky install`,
  `git lfs install`): nextlevel can't tell who made them, so all git work waits until the owner approves them on the
  dashboard.

## What an agent running as the owner can still do (FR-017)
The agents (the orchestrator, the workers, the assistant, the commands they have the hub run) run as the owner's own
Windows user. Without a separate Windows user for agents, nothing FR-017 added is a wall against an agent that is
determined to get around it. What it does: no agent can do these things **by accident, or through an ordinary nextlevel
command**. A determined agent, running as the owner, can still:
- **Plant an answer of the model trial (FR-022).** The kept answers are in `.nextlevel/check-cache.json`, which the team
  can write: a planted pass lets tasks start on an agy that refuses (each spends an attempt, as before FR-022), a planted
  refusal holds the agy tasks (the Home card says so; Check again runs the trial again). What the hub asks its trial to
  try goes on the child's command line, not through a file.
- **Plant a lock test's verdict (the Argon roles).** The orchestrator's verdict on Antigravity is
  `.nextlevel/lock-tests/agy-orchestrator.json`, which the team can write: a planted pass for the right key lets the
  orchestrator start on an agy whose lock test never ran (it still gets the push block and nextlevel's agent: the lock
  test proves those, it doesn't add them). What the hub asks the lock test goes on its command line, never through a file.
- **Pass for the owner.** nextlevel knows an agent's session by the variables the hub puts in its environment
  (`NEXTLEVEL_AGENT`, `NEXTLEVEL_SESSION`, `NEXTLEVEL_TASK_ID`: `src/lib/session.mjs`). A command started without them
  (`env -u`, `Remove-Item Env:`, a scheduled task) is taken for the owner's: `nextlevel update` (to a release that passes
  the tool's checks, or back to an older one) and `nextlevel channel` (a project on a candidate branch) run, `nextlevel report` files on a yes, and a worker's `nextlevel push` and `note`/`handoff` go through
  (the worker checks there read the same variables: FR-017 part 2 keeps workers from the hub instead).
- **Turn on the GitHub checks runner, or turn off fork pull requests' workflows, as the owner.** `nextlevel team runner
  on` and the doctor's fix of `runner.forks` refuse in an agent's session, read by the same variables; a command that
  clears them is taken for the owner's. In part A `on` changes nothing; the fork fix closes a setting, never opens one.
- **Write the advisor's memory.** It is kept in `~/.nextlevel/advisor/<project>/memory.json`, outside the project, and
  only the owner's own window (`nextlevel ask memory`, which refuses in an agent's session) or the dashboard's Memory
  changes it. An agent running as the owner without permission checks (Antigravity) can still write the file, as it can
  the guard's records, and steer the advice the owner reads. The panel's Memory shows where each entry says it came
  from, but whoever writes the file writes that too: an entry you don't remember adding is worth deleting.
- **Use gh as the owner from a worker or a verify command.** Both get gh's folder with no sign-in (`GH_CONFIG_DIR`) and a
  `GH_TOKEN` that doesn't work; a command that unsets both reads the owner's keyring login again ("GitHub CLI", above).
- **Push from a verify command anyway.** `nextlevel verify` switches Git pushes and GitHub sign-ins off through the
  command's environment (`GIT_CONFIG_PARAMETERS`, a failing push URL for every remote, no credential helper, no ssh,
  `GH_TOKEN` that doesn't work, gh's folder with no sign-in). A command that clears those variables, puts its own `git -c` settings back, or reads a
  sign-in from where it is kept (gh's `hosts.yml`, Windows' Credential Manager) pushes with the owner's access. A push
  URL the command writes into the project's settings itself is cleared too from Git 2.46; an older Git keeps it (and the
  guard stops git work at its next look, after that push). The project's read-only GitHub token, when `.env` has one,
  is in the command's environment, but GitHub refuses a write made with it. A deploy
  tool signed in as the owner (vercel, netlify, fly, wrangler, a cloud CLI) isn't stopped at all: nothing in git or gh
  is involved.
- **Use the dashboard as the owner (FR-017 part 2A).** The link the browser opens carries a one-time code, good once and
  for a minute, which the page trades for a session key it keeps in the tab's session storage and sends in a header;
  the code leaves the address bar at once, and neither is written to a file or a log by nextlevel. A process running
  as the owner can still get a key: it can ask the running dashboard to open the page again (`ui-open.json`, or
  `nextlevel ui` with the agent variables cleared) and, within that minute, read the new code from the command line
  of the browser being started (`cmd.exe /c start "" <link>` on Windows, the browser's own process after it) or from
  the dashboard's window, and trade it before the browser does; the owner's tab then says the link was used already
  and the dashboard's window says so too. It can read the dashboard process's memory, or the browser's profile folder,
  where the browser keeps a tab's session storage to restore it (a key there is good until the dashboard stops); or it
  can start a dashboard of its own (the refusal in an agent's session reads only variables it can clear). With a key,
  a request is the owner's: it can **approve held changes of protected files and pushes to deploy branches**, and
  file a report. What closes these is part 2B: workers that can't reach the hub or run as the owner.
- **Make a release with the owner's GitHub sign-in (safe updates).** Sessions push with the owner's account, so an agent
  with it can push an annotated tag. The tool takes it only if it is on main's history, newer than the installed
  release and titled: it can release code already merged to main (which passed CI and main's protection) early, before
  the owner's check, but not code that isn't on main. A tag ruleset doesn't stop the owner's own account.
- **Change what a project runs.** `~/.nextlevel/channels.json` and `versions.json` are in the home folder, which Codex's
  sandbox can't write; an agent without a sandbox (Antigravity) can, and could point a project at a candidate branch or
  an installed older version. The launcher runs only version folders it knows by name, never a path from the file; the
  doctor's `install.channel` and Home show each project's channel.
- **File a report or an issue, or message the phone, without nextlevel.** `gh issue create` with the owner's sign-in
  needs no nextlevel command. `.env` in the main checkout has the ntfy topic, and a POST to ntfy sends anything
  unredacted: the redaction is in nextlevel's `notify()` only.
- **Change what nextlevel is.** The tool's folder (`~/.nextlevel/tool`), its state (`~/.nextlevel/`), the guard's
  records (`~/.nextlevel/guard/`, see above) and the project's `.nextlevel/` (queue, outbox, job status) are the owner's
  user's files: an agent can write them. The doctor's "nextlevel updates" row shows changed files in the tool's folder.
- **Keep autopilot's rounds going (FR-019).** Only the orchestrator asks for a wake-up (`nextlevel wakeup` refuses for a
  worker, a verify command, the assistant and the owner's window), and the owner's side of the cards (`note add`, `edit`,
  `withdraw`, `off`, `on`, `remove`, `handoff reply`, `done`, `reopen`) refuses in an agent's session: both read the variables the
  hub puts in an agent's environment, so this is a bar, not a wall, until FR-017 part 2B. An agent that clears them, or
  writes `.nextlevel/` directly (the cards' stores with their count of the owner's actions, `round-now.json`,
  `wakeup.json`, `rounds.json` with the brake and the fuse), passes for the owner and starts rounds; on Codex its sandbox
  can write the project, `.nextlevel/` included. What still bounds it: a wake-up waits at least 5 minutes, doubled for
  each round in a row with nothing real, the brake holds what isn't the owner or a task, and the hub's ceiling of 8
  rounds an hour stays. An agent can also hold a lock's folder (`settings.json.lock`, `cards.lock`...) with a holder
  file naming a process that runs, or keep a process working inside it: writers wait 12 s on their own clock, then take
  the lock over, or (a folder Windows won't let move) write without it at 15 s, and say so in hub.log
  (lib/filelock.mjs). Each write it holds up costs those seconds, and the hub's loop waits meanwhile.
- **Close a task by hand (FR-021).** `.nextlevel/closed.json` is the hub's to write, but the orchestrator can write it
  itself (on Codex its sandbox can write the project), skipping `nextlevel close`'s checks and its real event. That is no
  worse than writing "closed" in the docs before FR-021: the shape check keeps what the page reads to plain dates and
  one-line reasons, a merge or an active job still outranks a closure, and a dispatch reopens the task.
- **Have the dashboard write through a link (the Ask panel's threads).** `src/lib/chats.mjs` writes each thread to
  `<thread>.json.<pid>.tmp` in `.nextlevel/chats/` and renames it into place: a name known in advance (the dashboard's
  pid). A link an agent put at that name first would be written through by the dashboard, with the owner's access, to a
  file outside the project. The hub's, the cards' and the locked files' JSON go to a new file of a random name written
  with `wx` since FR-019's review; the threads don't yet (a change of its own).
- **On an engine without permission checks, do all of it without trying.** An orchestrator on Codex without its
  sandbox runs `git push` or a deploy tool in the main checkout with the owner's sign-ins as any command: the doctor's
  `profiles.full-access` and the Team page say so. Codex's sandbox (no network, `.git` read-only) and Claude Code's
  rules (they deny `git push` and `gh`) keep an orchestrator from it by accident. An orchestrator on Antigravity (which
  skips its checks) gets nextlevel's push block and an agent without the owner's MCP servers, proven by its lock test
  (`docs/design/antigravity-roles.md`): its `git push` and `gh` reach nothing by accident, but one command that clears
  the block's variables pushes with the owner's access (measured), a deploy tool signed in as the owner isn't stopped,
  and it writes git itself (its commits skip the hub's `nextlevel commit`: a protected file is set back on disk and a
  push of it waits; a `.env` value is held when it is pushed). The hub reads each of its rounds for commands that clear
  the block, by pattern, after the round: a Home card, never a wall.
- **Run code on GitHub through CI on a pushed branch.** Since the push guard, a push whose commits change a protected
  file (a workflow under `.github/` among them) waits for the owner's Approve, but a push of ordinary files goes out as
  before, and CI on a pushed branch runs that branch's code (its tests, its build scripts, `package.json`'s scripts)
  with whatever the base branch's own workflow gives its jobs: its `GITHUB_TOKEN` with that workflow's permissions, and
  any secret it passes to a step. So a workflow that runs when other branches are pushed (a real project's ci.yml runs on
  `ci/**`) should give its jobs no secret and a read-only token; a secret belongs in a workflow that runs only on the
  base branch, or in an environment whose branch rule lets only the base branch in. The owner checks those settings on
  GitHub by hand.
- **Push outside nextlevel.** The guard sees the pushes the hub makes (`pushBranch`). The owner's own `git push`, and an
  agent without a sandbox that pushes with the owner's sign-in (see "On an engine without permission checks" above), go
  out with whatever their commits change, workflows included.
- **Merge a protected change through a moved local main.** The slots are git worktrees of the main checkout and share
  its refs, so a worker on agy or Claude Code can move the local base branch from its slot (`git update-ref
  refs/heads/main <its commit>`). The push guard reads origin's base branch for that reason, and a branch with no
  history in common with it is compared with nothing. The hub's own merges still trust the local base branch: guardMerge
  compares a task with the main checkout's HEAD, so a task whose commits are already in a moved main reads as merged or
  as changing nothing. That gap was there before the push guard and is a follow-up (guard the base branch's ref, or
  compare merges with a record the hub keeps).
Fix later (part 2 and after): the workers can't reach the hub at all; then a separate Windows user for agents, with its
own home folder and no access to the owner's sign-ins, `.env` or nextlevel's files.

## Handoff cards after a Go back (undo Done, FR-018)
- A Done made on the dashboard in the 10 seconds before a Go back to a version before undo Done stays pending there: the
  older version shows the card open and never makes it final. Click Done again. Coming forward again, a pending Done is
  made final only on a card still as it was clicked.
- An older version shows a card the team closed as resolved as done ("Done ... by the owner" in docs/HANDOFF.md, which
  it writes again at its next change), and a reopened card as open with no word of its reopening. Its `events` and
  `closedBy` stay in `.nextlevel/handoff.json`, and the newer version reads them again.
