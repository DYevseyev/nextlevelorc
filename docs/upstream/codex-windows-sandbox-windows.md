# Upstream issue (ready to file): Codex CLI — processes of the elevated Windows sandbox that can open a console window

For https://github.com/openai/codex/issues. Found while measuring nextlevel's FR-011 (docs/FIELD_REPORTS.md): windows
that flash while an agent runs. Measured on the owner's PC, and read in the source of `rust-v0.157.1`. File it as it
is.

---

**Title:** Windows elevated sandbox: the shared background server opens a console window (and takes the focus) for every command, because the setup refresh and the runner's `cmd /c mklink /J` are started without `CREATE_NO_WINDOW`

**Version:** codex-cli 0.157.1, `[windows] sandbox = "elevated"`, Windows 11 22H2 (build 22621).

**What the code does.** Commands themselves never get a window: the command runner (`codex-command-runner.exe`, started
with `CreateProcessWithLogonW` and `CREATE_NO_WINDOW`, `windows-sandbox-rs/src/elevated/runner_client.rs:384-410`)
starts them with `CREATE_NO_WINDOW` or a pseudoconsole on a private desktop (`command_runner/win.rs:308-352`). Two
other processes are started without that flag, from processes that have no console of their own:

1. The runner is a GUI-subsystem program (`src/bin/command_runner/main.rs:1`, `windows_subsystem = "windows"`), so it
   has no console, and on the user's desktop (`lpDesktop` NULL). For a working folder it makes a junction with
   `cmd /c mklink /J` and no creation flags (`command_runner/win/cwd_junction.rs:103-109`), while the read-ACL mutex
   exists (`win.rs:215-229`), once per folder (`cwd_junction.rs:38-47`). Windows gives that `cmd.exe` a new console,
   with a window, on the user's desktop.
2. Every elevated command refreshes setup (`spawn_prep.rs:402`, `identity.rs:268-281`), which starts
   `codex-windows-sandbox-setup.exe`, a console program, without `CREATE_NO_WINDOW` (`setup.rs:374-404`). It shares
   Codex's console when Codex has one; when Codex was started without one (a detached process, a GUI host), the helper
   gets a console window of its own for every command.

**Measured.** On the reporter's PC (a UI Automation monitor of top-level windows and focus, a WMI monitor of new
processes), in one turn of the interactive TUI (0.157.1) in a console window: the TUI started the shared background
server, `codex.exe app-server --listen unix:// --managed-daemon` from `~/.codex/packages/app-server-daemon/releases/
0.158.0-x86_64-pc-windows-msvc/`, which has no console, and for every command it ran that server started
`codex-windows-sandbox-setup.exe`, which got a console window of its own: 12 windows titled with the helper's path,
0.7 to 1.4 s each, **and each took the keyboard focus** from the TUI's window. In a `codex exec` round started with a
console of its own (`CREATE_NO_WINDOW`), the same helper ran before each of ten commands and no window appeared. With
`--no-daemon` the TUI's server runs in its own process and the helper shares the TUI's console.

**Why it matters.** Users type in other windows while Codex works; every command stealing the focus for a second
sends their keystrokes to a window that is about to close. Tools that open Codex for the user (an orchestrator
window) now pass `--no-daemon`, giving up the shared server for it.

**Asked for:** `CREATE_NO_WINDOW` (or `DETACHED_PROCESS` plus `CREATE_NO_WINDOW` for the console children) on the
runner's `cmd /c mklink` and on the setup refresh, or doing the junction without `cmd` (`CreateSymbolicLink`/
`DeviceIoControl(FSCTL_SET_REPARSE_POINT)`).

**Related, for the same tools:** `--ignore-user-config` still loads the user's skills (`ext/skills/src/host_roots.rs:
95-113`) and still discovers `$CODEX_HOME/hooks.json` (they don't run, as untrusted); a documented switch for "none of
the user's own MCP servers, plugins, skills and hooks, but the same sign-in" would let such tools start a worker
session without the user's add-ons in one flag instead of one `-c` per server and skill.
