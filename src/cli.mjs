// The `nextlevel` command: finds the project (git root of the current folder, or --project <path>)
// and runs a command on it. Internal commands (_run, _orch) are started by the hub and get the
// project root through the environment (NEXTLEVEL_ROOT), never from where the tool is installed;
// _install is started by the installer (install.ps1). Owner commands say, in one line, when a release is available
// (lib/update.mjs); nothing updates at a command's start (safe updates: only the owner's update does).
// Every command is in lib/commands.mjs, and its arguments are checked there before anything runs (FR-015): -h and
// --help print its usage, and an option or argument it doesn't take prints the usage and fails, doing nothing.
import fs from 'node:fs';
import path from 'node:path';
import { makeContext } from './checks/context.mjs';
import { doctorOptions, runDoctor } from './doctor.mjs';
import { HUB_COMMANDS, runHub } from './hub.mjs';
import { readOnly, readOnlyRefusal } from './lib/readonly.mjs';
import { cmdFix, fixStore, followFixes } from './fix.mjs';
import { cmdInit } from './init.mjs';
import { COMMANDS, helpText, parseCommand, usageText } from './lib/commands.mjs';
import { SECURITY_REFUSAL } from './lib/session.mjs';
import { installCommand } from './lib/install.mjs';
import { TOOL_ROOT, findProject } from './lib/project.mjs';
import { AVAILABLE_EVERY_MS, checkReleases, cmdChannel, cmdUpdate, describeTool, rememberProject, startNotice, updateBlocker } from './lib/update.mjs';
import { binDir } from './lib/install.mjs';
import { runningVersion } from './lib/versions.mjs';
import { register } from './lib/runreg.mjs';
import { notify } from './notify.mjs';
import { cmdReport } from './report.mjs';

// The commands this file runs itself; every other one is the hub's (HUB_COMMANDS). Together: lib/commands.mjs's list.
export const CLI_COMMANDS = ['init', 'update', 'channel', 'version', 'help', '_install', '_releases', '_update'];

// Owner commands: they say when a release is available, and record their project (so an update knows every project).
const OWNER = new Set([undefined, 'init', 'doctor', 'ui', 'guide', 'run', 'orchestrator', 'login', 'bridge-test', 'report', 'fix', 'team']);

// A version run from its own folder puts its own command first on PATH, and its name in NEXTLEVEL_VERSION, for
// everything it starts (safe updates, the review's change 2): an agent's `nextlevel` (the orchestrator, a round, a
// worker, a verify command) then runs this install and this version, never another one the user's PATH finds first.
function pinChildren() {
  const name = runningVersion(TOOL_ROOT);
  if (!name) return;
  process.env.NEXTLEVEL_VERSION = name;
  const bin = binDir();
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  const parts = String(process.env[key] || '').split(path.delimiter).filter((p) => p && path.resolve(p) !== path.resolve(bin));
  process.env[key] = [bin, ...parts].join(path.delimiter);
}

// The fixes started outside any project (a report about the tools, fix.mjs), for the doctor run outside one.
async function followOutside() {
  try {
    await followFixes({
      root: null,
      force: process.env.NEXTLEVEL_JUST_UPDATED === '1',
      notify: (title, message, priority) => notify(title, message, { priority, root: null }),
      say: (m) => console.log(m),
      blocker: updateBlocker,
    });
  } catch (err) {
    console.log(`(Couldn't look at the fixes started here: ${err.message})`);
  }
}

// Pull --project <path> out of the arguments (anywhere before "--").
function takeProject(argv) {
  const args = [...argv];
  const end = args.includes('--') ? args.indexOf('--') : args.length;
  const i = args.slice(0, end).findIndex((a) => a === '--project' || a.startsWith('--project='));
  if (i < 0) return { args };
  if (args[i].includes('=')) return { project: args[i].slice('--project='.length), args: [...args.slice(0, i), ...args.slice(i + 1)] };
  const value = args[i + 1];
  if (value === undefined || value.startsWith('--')) return { error: '--project needs a folder: nextlevel --project "C:\\path\\to\\project" <command>' };
  return { project: value, args: [...args.slice(0, i), ...args.slice(i + 2)] };
}

// Pull a flag out of the arguments (anywhere before "--").
function takeFlag(argv, flag) {
  const end = argv.includes('--') ? argv.indexOf('--') : argv.length;
  const i = argv.slice(0, end).indexOf(flag);
  return i < 0 ? { found: false, args: argv } : { found: true, args: [...argv.slice(0, i), ...argv.slice(i + 1)] };
}

// "nextlevel 0.1.0 (main @ 1a2b3c4) in C:\Users\me\.nextlevel\tool": the doctor looks for the folder.
// Run from a version's folder: "nextlevel v0.3.0 (release) in C:\Users\me\.nextlevel\versions\v0.3.0".
function version() {
  if (runningVersion(TOOL_ROOT)) return `nextlevel ${describeTool()} in ${TOOL_ROOT}`;
  const pkg = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8'));
  const where = describeTool();
  return `nextlevel ${pkg.version}${where ? ` (${where})` : ''} in ${TOOL_ROOT}`;
}

export async function main(argv) {
  pinChildren();
  // The security engineer's scan runs no nextlevel command at all, its help included: it reads and reports, and the
  // hub does everything else (docs/design/security-engineer.md). A bar, not a wall: KNOWN_ISSUES.
  if (process.env.NEXTLEVEL_AGENT === 'security') {
    console.error(SECURITY_REFUSAL);
    return 1;
  }
  const parsed = takeProject(argv);
  // (best effort: the update lists what still runs an old version, and never removes a folder in use)
  register({ version: runningVersion(TOOL_ROOT), project: parsed.project || process.cwd(), command: argv.find((x) => !x.startsWith('-')) || 'menu' });
  if (parsed.error) {
    console.error(parsed.error);
    return 1;
  }
  const noUpdate = takeFlag(parsed.args, '--no-update');
  const [cmd, ...rest] = noUpdate.args;
  if (['--help', '-h'].includes(cmd)) {
    console.log(helpText());
    return 0;
  }
  if (['--version', '-v'].includes(cmd)) {
    console.log(version());
    return 0;
  }
  if (cmd !== undefined && !Object.hasOwn(COMMANDS, cmd)) {
    console.error(`unknown command "${cmd}". Commands: ${Object.keys(COMMANDS).filter((c) => !c.startsWith('_')).join(', ')}. More: nextlevel help`);
    return 1;
  }
  // Its arguments first, before anything else happens (no update, no project, no hub): -h and --help print the usage;
  // what the command doesn't take prints it too, and fails (FR-015). (In a read-only session a command that changes
  // things says that first: it can't run whatever its arguments.)
  const p = cmd === undefined ? {} : parseCommand(cmd, rest);
  if (p.help) {
    console.log(usageText(cmd));
    return 0;
  }
  const refused = readOnly() ? readOnlyRefusal(cmd, rest) : '';
  if (refused) {
    console.error(refused);
    return 1;
  }
  if (p.error) {
    console.error(`nextlevel ${cmd}: ${p.error}\n\n${usageText(cmd)}`);
    return 1;
  }
  if (cmd === 'help') {
    const [name] = rest;
    if (name !== undefined && !Object.hasOwn(COMMANDS, name)) {
      console.error(`nextlevel help: there is no command "${name}". More: nextlevel help`);
      return 1;
    }
    console.log(name === undefined ? helpText() : usageText(name));
    return 0;
  }
  // The assistant's engine runs nextlevel read-only: only commands that look (refused above), and never an update
  // (lib/readonly.mjs)
  if (readOnly()) noUpdate.found = true;
  if (cmd === 'version') {
    console.log(version());
    return 0;
  }
  if (cmd === 'update') {
    const found = findProject({ project: parsed.project });
    return await cmdUpdate(rest, { root: found.ok ? found.root : null });
  }
  if (cmd === 'channel') {
    const found = findProject({ project: parsed.project });
    if (!found.ok) {
      console.error(found.message);
      return 1;
    }
    return cmdChannel(rest, { root: found.root });
  }
  if (cmd === '_install') return installCommand();
  if (cmd === '_update') {
    // (the one-click update, detached from whatever started it: src/updater.mjs)
    const { runUpdater } = await import('./updater.mjs');
    await runUpdater(rest[0]);
    return 0;
  }
  if (cmd === '_releases') {
    // (a fetch of the tool's repository into update/available.json, for the hub and the dashboard; never an install)
    checkReleases({ ifOlderThan: AVAILABLE_EVERY_MS });
    return 0;
  }
  if (cmd !== undefined && !CLI_COMMANDS.includes(cmd) && !HUB_COMMANDS.includes(cmd)) {
    console.error(`nextlevel ${cmd} is listed but nothing runs it (a bug in nextlevel: lib/commands.mjs and hub.mjs disagree)`);
    return 1;
  }
  let root;
  if (cmd?.startsWith('_')) {
    root = process.env.NEXTLEVEL_ROOT;
    if (!root) {
      console.error(`${cmd} is started by the hub, which sets NEXTLEVEL_ROOT; it can't run on its own.`);
      return 1;
    }
  } else {
    // (the assistant on Antigravity runs in a throwaway copy of the project, src/ask.mjs: its nextlevel commands read the real
    // project, NEXTLEVEL_READ_ROOT, only under NEXTLEVEL_READ_ONLY=1, where only the commands that look run)
    const readRoot = !parsed.project && process.env.NEXTLEVEL_READ_ONLY === '1' && process.env.NEXTLEVEL_READ_ROOT ? process.env.NEXTLEVEL_READ_ROOT : undefined;
    const found = findProject({ project: parsed.project || readRoot });
    // --json is for programs (the dashboard): nothing but the answer, and nothing changes
    const anywhere = ['doctor', 'report', 'fix'].includes(cmd); // about nextlevel itself, so they work outside a project
    const willRun = found.ok || anywhere;
    if (willRun && OWNER.has(cmd) && !rest.includes('--json')) {
      if (found.ok) {
        try {
          rememberProject(found.root);
        } catch {
          // only a convenience for the update
        }
      }
      const notice = noUpdate.found ? '' : startNotice();
      if (notice) console.log(notice);
    }
    // The doctor works outside a project too: it checks the tools and says where the project should be.
    if (!found.ok && anywhere) {
      const ctx = makeContext({ root: null, problem: found.message });
      if (cmd === 'report') return cmdReport(rest, { ctx, startFix: (n, { asker }) => cmdFix([String(n)], { ctx, asker }) });
      if (cmd === 'fix') return cmdFix(rest, { ctx });
      if (!rest.includes('--json') && fixStore().list().length) await followOutside();
      const bad = await runDoctor(ctx, doctorOptions(rest));
      return bad ? 1 : 0;
    }
    if (!found.ok) {
      console.error(found.message);
      return 1;
    }
    root = found.root;
  }
  try {
    if (cmd === 'init') await cmdInit(root);
    else await runHub(cmd, rest, root);
  } catch (err) {
    console.error(err.message);
    return 1;
  }
  return process.exitCode ?? 0;
}
