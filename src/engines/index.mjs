// Engine adapters: everything nextlevel knows about driving one AI coding CLI, behind one interface, so
// the hub, the doctor and the dashboard don't care which engine fills a role. Every engine can take every
// role (orchestrator, worker, setup guide).
//
// An adapter (codex.mjs, agy.mjs, claude.mjs):
//   name, title         'codex', 'Codex': the key in nextlevel.json, and the name people read
//   command             the program (resolved with lib/proc.mjs, .cmd shims on Windows)
//   window              where its slash commands are typed (checks/lib.mjs WINDOWS)
//   binPaths(home, platform)   places to look before PATH: [[home, ...parts], ...]
//   defaultArgs         engines.<name>.args in a new nextlevel.json: what every profile of it gets
//   readsAgentsMd       whether it reads AGENTS.md by itself (else the prompt tells it to)
//   writesGit           whether its sessions can write .git (Codex's sandbox can't: the hub does a worker's git
//                       for it, FR-008); writesGitWith(args): whether they can with these arguments anyway
//   needsRealConsole(platform)   a headless run needs a real console (agy on Windows): the hub gives it one with no
//                       window (lib/console.mjs), never none; its output still comes through pipes (FR-010)
//   addons({ home, account, env, read, list, path })   the owner's own add-ons in the engine's global config:
//                       { mcpServers: [{ name, command }], skills, plugins, hooks, rules, files } (FR-013)
//   workerAddons(keep, found, { version })   what keeps them out of a worker unless workers.addons (`keep`) lists them
//                       (version: the engine's, where that depends on it: agy's tools list, FR-022): { args
//                       (on top of its headless arguments), files (written into the slot: { path: [parts], text }),
//                       readsAgentsMd (whether it still reads AGENTS.md by itself), left ([{ what, text }]: what it
//                       can't be kept from, for the doctor), pin ({ model, effort } a worker without its own gets) }
//   workerLacks(needs, { platform, args })  optional (Codex): what of a task's "Needs:" (docker, network, packages) a
//                       worker with these arguments can't give here: [{ need, why }] (lib/needs.mjs); none: all of it
//   workerCaveat(platform, args)  optional (Codex): what a worker on it can't do here ({ warning, tips }: the Team
//                       page's and the doctor's warning, and what the worker's prompt tells it), or null (FR-009)
//   fullAccess(args, role)  why a role's sessions run with no permission check with these arguments ('' when they have
//                       one): the Team page's and the doctor's warning or information (fullAccessNote, FR-017)
//   account             { env, holds, clear }: the variable that moves its folder, so a second account of
//                       the owner's stays apart, and the variables that would win over that folder's
//                       sign-in; null when it has none (noAccount says why, plainly). nextlevel never reads
//                       or copies a sign-in: the owner signs each account in with the CLI's own login.
//   login               { status, statusTimeoutMs, signIn, signInText }: the arguments that show and start
//                       its sign-in; loginResult(runResult) -> { ok, detail, unknown }
//   headless({ prompt, model, effort, args, timeoutMin, role, extra })   arguments for one unattended run (extra: a
//                       worker's workerAddons args); headlessEnv: variables those runs get on top (agy: no background
//                       updater, FR-011)
//   interactive({ prompt, model, effort, args, role, extra })     arguments for a session in the owner's window;
//                       windowArgs: { probe, args(output of probe) } what such a session gets on top so the commands it
//                       runs open no windows of their own (Codex: --no-daemon, FR-011)
//   efforts             the reasoning efforts it takes, lowest first; effortNote: where an effort doesn't reach.
//                       [] (Antigravity): it has no effort setting; effortOf(model) says the level a model's name
//                       carries ('' for none), and nothing ever passes it an effort (FR-010)
//   own({ home, account, env, read, path })   what it uses when nextlevel pins nothing, as far as its own
//                       files say (M9): { model, effort, from, effortFrom, byDefault } ('' when they don't say)
//   models(run)         the models its CLI lists: { list: [{ id, label, efforts, effort }], from } or null
//                       (run: (cmd, args, opts) -> { ok, out }); modelHints: names its --model takes anyway
//   tokens(text)        what a headless run used, from what it printed: { tokens, cached } or null (not reported)
//   usage               { headless, interactive }: where its tokens come from, '' where they aren't reported;
//                       Codex also has sessionTokens (its session files) and home (its folder)
//   readable(text)      optional (Claude Code, Codex): a log with its JSON lines as a person reads it, or null
//   feed(text, { cwd }) what a headless run did, from its log, oldest first: [{ kind, text, detail, ok }] (util.mjs
//                       says the kinds); null for an engine whose steps nextlevel can't read (feedWhy says why)
//   end(text, { code })  how a headless run ended, by the engine's own account (FR-020, after FR-022's for agy):
//                       { status (Claude's subtype, agy's status, Codex's last turn; '' when it printed none), error
//                       (the engine itself says the run failed, whatever its exit code), reason (why, in its own
//                       words), turns, said (its last answer, when it ended well), stopped (background commands it
//                       stopped when it ended), last (its last lines, about 20) }; not redacted
//   workerEnv({ timeoutMin, platform })  optional: variables a worker's session gets on top (Claude Code's, FR-020;
//                       Codex's PowerShell policy on Windows, FR-009)
//   standardPin({ version, args, home, account, env, read, path })  optional (Codex): the arguments that keep OpenAI's
//                       Daybreak off a run, for the engine's version and the profile the run picks (security engineer
//                       1b-1), or []
//   secretStrings({ home, read, path })  optional: strings of its own settings to redact from what it prints (agy: every
//                       string in the args, env and headers of the owner's MCP servers)
//   notes               { plan, orchestrator, worker, guide }: what choosing it for a role means, in plain words
//   knownIssues         one line each (docs/KNOWN_ISSUES.md has the story)
//
// A profile is an engine plus the account it's signed into plus a model: { name, engine, account, model }
// (lib/config.mjs resolves roles to profiles). account '' is the engine's own login, in its usual folder.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import agy from './agy.mjs';
import { accountDir } from './util.mjs';
import claude from './claude.mjs';
import codex from './codex.mjs';

export const ADAPTERS = { codex, agy, claude };
export { accountDir, readJsonText, withoutOption } from './util.mjs';
export const ENGINE_NAMES = ['agy', 'codex', 'claude'];

export function engine(name) {
  const e = ADAPTERS[name];
  if (!e) throw new Error(`unknown engine "${name}" (${ENGINE_NAMES.join(', ')})`);
  return e;
}
export const engineTitle = (name) => ADAPTERS[name]?.title || name;


const profileLabel = (profile) => (profile.name ? `profile "${profile.name}"` : `roles on ${profile.engine}`);

// Why a profile's account can't be used, or ''. The engine has no setting for its folder, so a second
// account would silently be the one it is signed in with: said plainly, and nothing starts.
export function accountProblem(profile) {
  if (!profile?.account) return '';
  const e = engine(profile.engine);
  return e.account ? '' : `${profileLabel(profile)} names account "${profile.account}", but ${e.noAccount}`;
}

// A child's environment for a profile: `base` with the account's folder set, and what would win over that
// folder's own sign-in taken out (an API key in the owner's environment, say). The engine's own login
// (account '') gets `base` as it is. Throws when the engine can't keep an account apart. Names are
// compared as Windows does, whatever their case.
export function profileEnv(base, profile, { home, path: p = path } = {}) {
  const env = { ...base };
  if (!profile?.account) return env;
  const problem = accountProblem(profile);
  if (problem) throw new Error(problem);
  const acc = engine(profile.engine).account;
  const drop = new Set([acc.env, ...(acc.clear || [])].map((k) => k.toUpperCase()));
  for (const k of Object.keys(env)) if (drop.has(k.toUpperCase())) delete env[k];
  env[acc.env] = accountDir(home, profile.engine, profile.account, p);
  return env;
}

// The arguments of a session: `mode` is 'headless' (one unattended run: a worker's task, an autopilot
// cycle) or 'interactive' (the owner's window: the orchestrator, the setup guide). `args` are
// engines.<name>.args, a worker's its own (lib/config.mjs workerArgsOf). An engine that doesn't read AGENTS.md by itself is told to in the prompt. `isolation`: a
// worker's workerIsolation (FR-013), whose arguments come on top and which may mean it no longer reads AGENTS.md.
export function sessionArgs(profile, { mode, role, prompt, timeoutMin = 60, args = [], isolation = null, extra = [], version = '' }) {
  const e = engine(profile.engine);
  const reads = isolation ? isolation.readsAgentsMd : e.readsAgentsMd;
  const text = reads ? prompt : `Read AGENTS.md first: it has the team's roles and rules. ${prompt}`;
  const build = mode === 'headless' ? e.headless : e.interactive;
  return build({ prompt: text, model: profile.model || '', effort: profile.effort || '', args, timeoutMin, role, extra: [...(isolation?.args || []), ...extra, ...standardPin(profile, { version, args: [...args, ...extra] })] });
}

// What keeps OpenAI's Daybreak off a session (security engineer 1b-1: Codex's `-c daybreak=false`, on a Codex that has
// the key), from the engine's version (`version`: what `<engine> --version` printed): [] for an engine without such a
// setting. Every session nextlevel starts gets it, last among its overrides: through sessionArgs, and the assistant's and
// the model check's own command lines. The security engineer's scans never run the host's engine.
// `args`: the run's own arguments (a profile they pick); `home`, `env`, `read`: where the account's settings are (this
// PC's by default).
export function standardPin(profile, { version = '', args = [], home = os.homedir(), env = process.env, read = readOr } = {}) {
  const e = ADAPTERS[profile?.engine];
  if (!e?.standardPin) return [];
  try {
    return e.standardPin({ version, args, home, account: profile.account || '', env, read, path });
  } catch {
    return e.standardPin({ version, args: [] });
  }
}
const readOr = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

// What a session in a window of its own gets on top (windowArgs: Codex's --no-daemon, FR-011), asked of the installed
// CLI (`run(cmd, args)` -> { ok, out }); none for an engine without them, or one whose CLI doesn't say.
export function windowArgs(profile, run) {
  const e = engine(profile.engine);
  if (!e.windowArgs) return [];
  const r = run(e.command, e.windowArgs.probe);
  return r?.ok ? e.windowArgs.args(r.out) : [];
}

// What a worker's session is started with so the owner's own add-ons stay out of it (FR-013): the engine's workerAddons
// for workers.addons (`keep`) and what the engine's files hold (`ctx`: { home, env, read, list, path }), with `found`
// (what the owner has) for the doctor. An engine without them gets none.
export const ADDON_KINDS = { mcpServers: [], skills: false, hooks: false };
export function workerIsolation(profile, keep = ADDON_KINDS, ctx = {}) {
  const e = engine(profile.engine);
  const k = { ...ADDON_KINDS, ...(keep || {}) };
  if (!e.workerAddons) return { args: [], files: [], readsAgentsMd: e.readsAgentsMd, left: [], pin: null, found: null };
  let found = null;
  try {
    found = e.addons?.({ ...ctx, account: profile.account || '' }) || null;
  } catch {
    found = null; // a file that can't be read holds nothing to keep out
  }
  // (ctx.version: the engine's own, `agy --version`, when what keeps them out depends on it: FR-022)
  return { pin: null, ...e.workerAddons(k, found || {}, { version: ctx.version || '' }), found };
}

// What a worker on this profile can't do on this platform (FR-009): { warning, tips } or null.
export function workerCaveat(profile, platform = process.platform, args = []) {
  return engine(profile.engine).workerCaveat?.(platform, args) || null;
}

// A role whose engine runs it with no permission check (FR-017: Antigravity skips them, headless) acts with the owner's
// full access: their sign-ins, git, gh and deploy tools. A role in the main checkout (the orchestrator, the setup guide,
// the assistant, and their fallbacks) could push or deploy directly, past nextlevel push and the owner's approval of a
// deploy branch, and can move to a sandboxed engine: a warning. A worker runs in a slot behind the push block, and
// Antigravity needs this to run unattended: the risk is accepted by design, and said as information.
// -> { level: 'warn' | 'info', text } (the Team page's, and the doctor's profiles.full-access), or null.
// `args`: engines.<name>.args (a worker's: workerArgsOf).
// `facts`: what the doctor knows of this PC (checks/argon.mjs): { lock: the orchestrator's lock test on Antigravity
// ({ passed, version, why, command }), asksNothing: the owner's own agy settings approve every command }.
export function fullAccessNote(profile, role, args = [], facts = {}) {
  const why = engine(profile.engine).fullAccess?.(args, role, facts) || '';
  if (!why) return null;
  // The setup guide: the owner is there, and it is warned only so they know it won't ask
  if (role === 'guide') return { level: 'warn', text: `${why}. You are there while it runs: read what it is about to do` };
  // The orchestrator on Antigravity: what nextlevel blocks around it, from its lock test (docs/design/antigravity-roles.md)
  if (role === 'orchestrator' && profile.engine === 'agy' && facts.lock) {
    const open = "it still acts as your Windows user: it can change any file you can, read .env and run a deploy tool you're signed in to, and a session that sets out to can switch nextlevel's blocks off with one command, then push and act on GitHub as you";
    return facts.lock.passed
      ? { level: 'warn', text: `${why}. nextlevel blocks its pushes, your GitHub sign-in and your MCP servers (its lock test passed on agy ${facts.lock.version}); ${open}. Codex in its sandbox can't do most of that` }
      : { level: 'warn', text: `${why}. On Antigravity it doesn't start until its lock test passes (${facts.lock.why}; run ${facts.lock.command}), since without nextlevel's block: it acts with your full access in your main checkout and could push or deploy directly, past nextlevel push and your approval of a deploy branch. An engine with permission checks keeps it from that: Codex, in its sandbox, or Claude Code, with nextlevel's rules` };
  }
  // The assistant on Antigravity: in a throwaway copy of the project, behind the same block (Argon roles, part B)
  if (role === 'assistant' && profile.engine === 'agy') {
    const open = "it still acts as your Windows user: it can read .env and any file you can and change files outside its copy, and a session that sets out to can switch nextlevel's blocks off with one command, then push and act on GitHub as you";
    return facts.lock?.passed
      ? { level: 'warn', text: `${why}. It answers in a throwaway copy of your project, and nextlevel blocks its pushes, your GitHub sign-in and your MCP servers (its lock test passed on agy ${facts.lock.version}); ${open}. Codex and Claude Code keep it from writing at all` }
      : { level: 'warn', text: `${why}. On Antigravity it doesn't answer until its lock test passes${facts.lock ? ` (${facts.lock.why}; run ${facts.lock.command})` : ''}; even then ${open}. Codex and Claude Code keep it from writing at all` };
  }
  if (role === 'worker') {
    // (why it runs so: Antigravity can't run unattended otherwise; Codex's sandbox on Windows keeps a worker from Docker and
    // package installs, FR-009, and whoever can use Docker has the whole PC anyway)
    const needs = { agy: 'Antigravity needs this to run unattended', codex: "Codex's sandbox would keep it from Docker, pnpm and git" }[profile.engine] || `${engine(profile.engine).title} runs so with these arguments`;
    return { level: 'info', text: `${why}: it acts with your full access. Accepted by design: a worker runs in a slot of its own, where git refuses its pushes (FR-003), and ${needs}; a worker can still undo the push block, and a deploy tool signed in as you isn't stopped` };
  }
  return { level: 'warn', text: `${why}: it acts with your full access in your main checkout and could push or deploy directly, past nextlevel push and your approval of a deploy branch. An engine with permission checks keeps it from that: Codex, in its sandbox, or Claude Code, with nextlevel's rules` };
}

// Whether the hub does a worker's git on this profile (FR-008): its sessions can't write .git (Codex's sandbox),
// so the hub merges the base branch in before a retry and commits what it leaves. `args`: the workers' (workerArgsOf).
export function gitByHub(profile, args = []) {
  const e = engine(profile.engine);
  return !e.writesGit && !e.writesGitWith?.(args);
}

// Where to look for an engine's program before PATH (lib/proc.mjs resolveBin).
export function binHints(command, home, platform, p = path) {
  const e = Object.values(ADAPTERS).find((x) => x.command === command);
  return e?.binPaths ? e.binPaths(home, platform).map((parts) => p.join(...parts)) : [];
}
