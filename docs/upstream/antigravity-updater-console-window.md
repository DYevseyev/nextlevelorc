# Upstream issue (ready to file): Antigravity CLI — the background updater flashes a console window on Windows

For https://github.com/google-antigravity/antigravity-cli/issues. Found by nextlevel's FR-011 (docs/FIELD_REPORTS.md):
"windows flash when a worker starts". File it as it is; the evidence below was measured on the owner's PC.

---

**Title:** Windows: `agy --bg-updater` runs `agy.exe --version` in a new console window, which flashes and can take the keyboard focus

**Version:** agy 1.2.12, Windows 11 22H2 (build 22621), Windows Console Host as the default terminal.

**What happens.** When agy's update check is due (about every 15 minutes: `~\.gemini\antigravity-cli\last_check.timestamp`),
a starting session, `agy -p` included, starts `agy.exe --bg-updater --app_data_dir=antigravity-cli --gemini_dir=.gemini`.
That process has no console, and it runs `agy.exe --version`, which Windows then gives a console of its own, with a
window. Watched with a UI Automation monitor of top-level windows and a WMI monitor of new processes:

```
7.41 s  window opens: ConsoleWindowClass "C:\Users\User\AppData\Local\agy\bin\agy.exe" (conhost.exe)
7.44 s  keyboard focus moves to it
7.52 s  agy.exe --bg-updater --app_data_dir=antigravity-cli --gemini_dir=.gemini   (parent: the agy -p session)
8.26 s  window closes after 0.87 s; focus goes back
8.28 s  agy.exe --version                                                         (parent: --bg-updater)
8.29 s  conhost.exe 0x4                                                           (parent: agy.exe --version)
```

(The monitors poll, so the times of the processes lag the window's by up to 0.2 s.) In another run the window was open
0.90 s without taking the focus; in two more runs the updater and `agy.exe --version` ran with no window seen. The
session itself ran without a window (it was started with `CREATE_NO_WINDOW`); only the updater's child opened one.
`update_status.json` said "Already on the latest version." each time.

**Why it matters.** Tools that run agy unattended start a session every few minutes (here: one per coding task, in the
background); every so often a window flashes over what the user is doing and can steal the keyboard focus.

**Asked for:** start the updater's children (`agy.exe --version`, and anything else it runs) with `CREATE_NO_WINDOW`,
or run the version check in-process; and document `AGY_CLI_DISABLE_AUTO_UPDATE`, which is in the program: set to
`true` it kept a due check from starting the updater (the next session without it did start it), set to `1` it
didn't. Tools that start agy unattended use `true` for now, and would rather rely on something documented.

**Reproduce:** delete or back-date `last_check.timestamp`, run `agy -p "say ok"` from a process without a visible console
(for example `Start-Process agy -ArgumentList '-p','"say ok"' -WindowStyle Hidden`), and watch for a console window.
