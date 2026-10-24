# Antivirus and nextlevel

## Why an agent tool can look suspicious

A behaviour-based antivirus (Bitdefender's Advanced Threat Defense, for one) watches what programs do, not only what
files are. A build team does what malware also does: programs started in the background with no window, an agent that
runs commands without asking, tools downloaded and started on the fly (npx), servers talking to the internet. On 28
September 2026 an antivirus stopped a worker's whole chain on a real PC and quarantined files of every tool in it
(FR-013). Since then nextlevel starts nothing through `conhost.exe`, and workers run without your own MCP servers,
skills and hooks (`workers.addons` in `nextlevel.json` keeps some if a task needs them). Antigravity still starts your
MCP servers' processes in workers: the doctor says which (`workers.addons`); turn off in agy the ones you don't need
(PowerShell: `agy mcp list`, then `agy mcp disable <name>`, which is for your own agy sessions too).

## One narrow exception, only if it still happens

In the antivirus's exceptions (Bitdefender: *Protection*, then *Manage exceptions*, for Advanced Threat Defense), add
**the worker engine's program only**: `%LOCALAPPDATA%\agy\bin\agy.exe` for Antigravity. Not a folder, not node.exe, not
PowerShell, not the whole project, and never turn the antivirus or Advanced Threat Defense off.

## If it strikes again (recovery)

1. Leave the antivirus's cleaning as it is and restart the PC if it asks to.
2. Open its quarantine (Bitdefender: *Protection > Antivirus > Quarantine*, or the notifications that list what it
   took). Restore the files that belong to your tools: nextlevel's (`...\nextlevel\bin\nextlevel.mjs`), the project's
   `START.cmd`, agy's (`~\.gemini\antigravity-cli\bin\agentapi.bat`), pnpm's (`AppData\Roaming\npm\...`), npx's cache.
   Keep anything you don't recognise in quarantine.
3. PowerShell, in the project folder: `nextlevel doctor`. `Tool files` lists anything still missing, with how to put it
   back (git, the installer, `agy update`, `npm install -g pnpm`).
4. The dashboard: a task shown as "Stopped from outside" didn't count as an attempt; retry it (`nextlevel retry <id>`).
   Dispatch pauses by itself while files are missing and goes on once they are back.
5. Run the bridge test again (START.cmd -> 8).

**Checks:** `tool.files` (files a quarantine took), `workers.addons` (what of your own add-ons still reaches a worker).
