# Upstream issue (ready to file): Antigravity CLI — a way to start a session without the user's global MCP servers

For https://github.com/google-antigravity/antigravity-cli/issues. Found by nextlevel's FR-013 (docs/FIELD_REPORTS.md).
File it as it is; the evidence below was measured on the owner's PC.

---

**Title:** `agy -p` starts every MCP server in `~/.gemini/config/mcp_config.json`, even for an agent with `inheritMcp: false`; please add a per-session way to skip them

**Version:** agy 1.2.12, Windows 11 22H2 (build 22621), Node.js 24.19.

**What happens.** A tool that runs agy headless for unattended coding tasks (one `agy -p` per task, in a git worktree)
can't keep the user's own MCP servers out of those sessions. Every `agy -p`, even a one-line prompt, starts the process
of every server in the user's global `mcp_config.json`. On the reporter's PC that is:

```
agy.exe -p "Reply with exactly the word ok. Do not use any tools." --model gemini-3.8-flash-high --output-format stream-json ...
├─ cmd /c "cd /d C:\...\some-project && npx -y @rafter-security/cli@0.10.0 mcp serve"
│  └─ node ...npm-cache\_npx\...\@rafter-security\cli\dist\index.js mcp serve
├─ cmd /c npx -y mcp-remote https://stitch.googleapis.com/mcp --header "X-Goog-Api-Key: <the key, on the command line>"
│  └─ node ...npm-cache\_npx\...\mcp-remote\dist\proxy.js ...
└─ docker run -i --rm -e GITHUB_PERSONAL_ACCESS_TOKEN ghcr.io/github/github-mcp-server
```

The same happens with a custom agent that doesn't inherit them (`.agents/agents/worker.md`, run with `--agent worker`):

```yaml
---
name: worker
description: ...
inheritCustomizations: false
inheritMcp: false
---
```

With that agent the session's prompt shrinks from 28,800 to 6,000 input tokens (the global rules, skills and MCP tools
are gone, as documented), but the three server processes above still start and run for the whole session.

**Why it matters.** On 2026-09-28 Bitdefender's Advanced Threat Defense judged such a headless session's behaviour
malicious, stopped the whole process chain and quarantined, among others, `mcp-remote`'s `proxy.js` and
`@rafter-security/cli`'s `index.js` from npx's cache, and `~\.gemini\antigravity-cli\bin\agentapi.bat`. Servers the
session can't use shouldn't run in it; a server launched through `cmd /c npx ...` also puts its `--header` value (an API
key) on a command line other processes can read.

**Asked for** (any of these):
- a flag for one session: `--no-mcp`, or `--mcp-config <file>` with `--strict-mcp-config` (as Claude Code has), or a
  per-server switch for one session (as Codex has: `-c mcp_servers.<name>.enabled=false`);
- `inheritMcp: false` also keeping the servers' processes from starting, not only their tools;
- documentation of an environment variable for the config folder, so a session can have a folder of its own (without
  moving the sign-in).

**Also seen:** `--agent <name>` with no agent of that name found runs the default agent silently, with everything the
agent file meant to leave out; an error (or at least a warning on stderr) would make that visible.

**Reproduce:** put any stdio server in `~/.gemini/config/mcp_config.json`, create the agent above in a folder, run
`agy -p "say ok" --agent worker --output-format stream-json` there, and watch the processes (Task Manager's process
tree, or `Get-CimInstance Win32_Process | ? ParentProcessId -eq <agy's pid>`).
