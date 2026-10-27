// nextlevel.json: the project's settings (engines, models, slots, timeouts, base branch, paths).
// Secrets stay in .env. Environment variables still override settings: NEXTLEVEL_* always, and for one
// release the old names (CODEX_MODEL, AGY_MODEL, CODEX_ARGS, AGY_ARGS, NTFY_SERVER).
//
// Roles are filled by profiles. A profile is an engine plus the account it's signed into plus a model and
// a reasoning effort; a role is either { engine, model, effort } (a profile on the engine's own login, as
// before M6) or { profile: "<name>" }, naming one of `profiles` ({ engine, account, model, effort }), so
// the same engine can appear twice with different logins. `fallback` is what the role falls back to (a
// worker's task on retry --fallback, the orchestrator when its own engine isn't ready): a profile's or an
// engine's name, or { engine, model, effort } of its own (M9). An empty model or effort is the engine's
// own choice. The setup guide (M9) is a role too: `roles.guide` with no engine is the orchestrator's.
// `engines` holds what is the same for every profile of an engine (its CLI arguments).
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, ENGINE_NAMES } from '../engines/index.mjs';
import { BUILT_IN, protectedList } from './protect.mjs';
import { branchNameProblem, deployList, isDeployBranch } from './push.mjs';

export const CONFIG_FILE = 'nextlevel.json';
export const CONFIG_VERSION = 1;
export const ENGINES = ENGINE_NAMES;
export const ROLES = ['orchestrator', 'worker'];
export const ALL_ROLES = [...ROLES, 'guide', 'assistant', 'security']; // the build team's roles, the setup guide, the assistant (Ask) and the security engineer
// The security engineer (docs/design/security-engineer.md): off until the owner gives it an engine, and then only on
// these. Never Antigravity (nothing keeps it read-only or sandboxed, and this role never runs with full access); Claude
// Code comes later. It has no fallback, and it is kept out of profilesInUse (securityProfile).
export const SECURITY_ENGINES = ['codex'];
const NOT_SECURITY = {
  agy: 'nothing keeps Antigravity read-only or sandboxed, and this role never runs with full access',
  claude: 'Claude Code comes in a later version of this role',
};
export const notSecurity = (engine) => NOT_SECURITY[engine] || 'it has no sandboxed scan';
// The assistant answers the owner's questions read-only (src/ask.mjs): only engines that can be run read-only by
// construction may take it. Its automatic choice is a light model on the first of these the roles already use.
export const ASSISTANT_ENGINES = ['claude', 'codex'];
export const LIGHT_MODELS = { claude: { model: 'haiku', effort: '' }, codex: { model: '', effort: 'low' } }; // Codex: its smallest listed model at run time
const NOT_READ_ONLY = {
  agy: "nothing keeps Antigravity read-only (its plan mode is the agent's own behaviour, not a sandbox, and its deny-list wasn't enforced, FR-003)",
};
export const notReadOnly = (engine) => NOT_READ_ONLY[engine] || '';
// How a worker's process shows on Windows (workers.window, FR-010): no window, a minimized one, a window of its own
export const WINDOW_MODES = ['hidden', 'minimized', 'visible'];
const LEGACY_ENGINES = ['agy', 'codex']; // the old .env names: CODEX_MODEL, AGY_MODEL, CODEX_ARGS, AGY_ARGS
const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/; // a profile's name: in commands and task specs
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/; // an account's name: a folder name on every PC

export function defaults(name = 'project') {
  return {
    version: CONFIG_VERSION,
    name,
    baseBranch: 'main',
    // The branches on origin a push to which deploys, or might (FR-015): such a push waits for the owner's approval on
    // the dashboard (nextlevel push, lib/push.mjs). null: not set, and then the base branch counts as one.
    deployBranches: null,
    // The one-click update (safe updates): backupBranch, a branch on origin the update pushes the base branch's head to
    // before it stops the hub ('' for none; never a deploy branch)
    updates: { backupBranch: '' },
    // Codex orchestrates and Antigravity works, as before M6; a worker's task falls back to Codex
    roles: {
      orchestrator: { engine: 'codex', model: '', effort: '', profile: '', fallback: '' },
      // second: a second worker, optional (null: none): { engine, model, effort } or { profile }, and what it takes
      // (SECOND_TAKES); `--profile second` and a spec's "Profile: second" line reach it
      worker: { engine: 'agy', model: '', effort: '', profile: '', fallback: 'codex', second: null },
      guide: { engine: '', model: '', effort: '', profile: '' }, // no engine: the orchestrator's
      assistant: { engine: '', model: '', effort: '', profile: '' }, // no engine: automatic (a light model, ASSISTANT_ENGINES)
      // no engine: off. daybreak: the scans run with OpenAI's Daybreak Blue (the owner's cyber access program)
      security: { engine: '', model: '', effort: '', profile: '', daybreak: false },
    },
    profiles: {},
    // What every profile of an engine gets (src/engines/<name>.mjs says why). workerArgs: what every worker task on that
    // engine gets instead of args, however it was chosen (the workers, their fallback, --engine, --profile, a spec's
    // Engine: or Profile: line, a retry); null: not set, and workers get args; []: workers get no arguments at all
    // (workerArgsOf). The orchestrator, the setup guide and autopilot rounds always get args.
    engines: Object.fromEntries(['codex', 'agy', 'claude'].map((e) => [e, { args: [...ADAPTERS[e].defaultArgs], workerArgs: null }])),
    // window: how a worker's process shows on Windows (FR-010): 'hidden' (no window: an engine that needs a real
    // console gets one with no window), 'minimized' or 'visible' (a window of its own). Elsewhere workers have none.
    // addons: the owner's own add-ons in an engine's global config that workers may still use (FR-013): MCP servers by
    // name, and whether they get the owner's skills (with plugins; on agy also rules) and hooks. None by default.
    workers: { slots: 2, taskTimeoutMin: 60, killGraceMin: 5, window: 'hidden', addons: { mcpServers: [], skills: false, hooks: false } },
    checks: { timeoutMin: 30 },
    // The security engineer's scans: the longest a scan and a deep scan may run, in minutes (the hub stops it then)
    security: { scanMinutes: 90, deepScanMinutes: 240 },
    // Files the agents' and the owner's tools load outside any sandbox: a change to one waits for the owner's approval
    // on the dashboard (lib/protect.mjs has the built-in list). "add" and "remove" change that list for this project.
    protected: { add: [], remove: [] },
    // rounds (FR-019, lib/rounds.mjs): brake: how many rounds may start, after the last real event, for what isn't the
    // owner or a task (a check, push or merge ending, a wake-up, the round after work moved, a cut-off round's retry);
    // fuse: that many rounds in a row with nothing real between them turn autopilot off; wakeMinMinutes: the shortest
    // wake-up the orchestrator gets.
    hub: { autopilot: false, reportHour: 20, rounds: { brake: 3, fuse: 6, wakeMinMinutes: 5 } },
    notifications: { server: 'https://ntfy.sh' },
    paths: {
      tasks: 'docs/tasks',
      status: 'docs/STATUS.md',
      handoff: 'docs/HANDOFF.md',
      notes: 'docs/OWNER_NOTES.md', // written from .nextlevel/notes.json (lib/cards.mjs), as handoff is from handoff.json
      // the orchestrator keeps these; the dashboard's Project page reads them (lib/roadmap.mjs)
      project: 'docs/PROJECT.md',
      decisions: 'docs/DECISIONS.md',
      plans: 'docs/plans',
      roles: {
        guide: 'docs/agents/GUIDE.md',
        orchestrator: 'docs/agents/ORCHESTRATOR.md',
        worker: 'docs/agents/WORKER.md',
      },
    },
  };
}

// Settings that used to live in .env: [new name, old name, setting].
export const ENV_SETTINGS = [
  ['NEXTLEVEL_BASE_BRANCH', null, 'baseBranch'],
  ['NEXTLEVEL_WORKER_SLOTS', null, 'workers.slots'],
  ['NEXTLEVEL_TASK_TIMEOUT_MIN', null, 'workers.taskTimeoutMin'],
  ['NEXTLEVEL_KILL_GRACE_MIN', null, 'workers.killGraceMin'],
  ['NEXTLEVEL_WORKER_WINDOW', null, 'workers.window'],
  ['NEXTLEVEL_CHECK_TIMEOUT_MIN', null, 'checks.timeoutMin'],
  ['NEXTLEVEL_REPORT_HOUR', null, 'hub.reportHour'],
  ['NEXTLEVEL_AUTOPILOT', null, 'hub.autopilot'],
  [null, 'CODEX_MODEL', 'model of the roles on codex'],
  [null, 'AGY_MODEL', 'model of the roles on agy'],
  [null, 'CODEX_ARGS', 'engines.codex.args'],
  [null, 'AGY_ARGS', 'engines.agy.args'],
  [null, 'NTFY_SERVER', 'notifications.server'],
];
export const SETTING_KEYS = new Set(ENV_SETTINGS.flatMap(([a, b]) => [a, b]).filter(Boolean));

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const has = (v) => v !== undefined && v !== null && String(v).trim() !== '';
const num = (v, d) => (has(v) && Number.isFinite(Number(v)) ? Number(v) : d);
const words = (s) => (String(s ?? '').match(/"[^"]*"|\S+/g) || []).map((w) => w.replace(/^"|"$/g, ''));
const orList = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} or ${list.at(-1)}` : list.join(''));
const MODEL_RE = /^[\w.:/@+\[\]-]*$/;
const EFFORT_RE = /^([a-z][a-z0-9-]{0,19})?$/; // low, high, xhigh...: the engine says which it knows
const INLINE = { engine: '', model: '', effort: '' }; // a fallback of its own: an engine on its own login
// The second worker (roles.worker.second): what it takes, as the Team page says it. Its name for --profile and a spec's
// "Profile:" line is SECOND, so no profile may have it.
export const SECOND = 'second';
export const SECOND_TAKES = {
  'no-docker': 'tasks without Docker',
  any: 'any task',
  asked: 'only when the spec asks for it ("Profile: second", or --profile second)',
};
const SECOND_BASE = { engine: '', model: '', effort: '', profile: '', takes: 'asked' };

// Merge the file over the defaults, checking types as it goes. Unknown keys are reported, not fatal,
// so a file written for a newer tool still mostly works; keys starting with "$" are comments.
function merge(base, over, at, problems) {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const key = at ? `${at}.${k}` : k;
    if (k.startsWith('$')) continue;
    if (!Object.hasOwn(base, k)) {
      problems.warnings.push(`unknown setting "${key}" (ignored)`);
      continue;
    }
    const b = base[k];
    if (key === 'profiles') out[k] = mergeProfiles(v, problems);
    else if (key === 'deployBranches') {
      if (v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'))) out[k] = v;
      else problems.errors.push('"deployBranches" must be a list of branch names, like ["main"] ([] if no branch deploys)');
    } else if (/^engines\.[^.]+\.workerArgs$/.test(key)) {
      if (v === null || (Array.isArray(v) && v.every((x) => typeof x === 'string'))) out[k] = v;
      else problems.errors.push(`"${key}" must be a list of arguments, like ["--sandbox", "workspace-write"] (null: workers get "args"; []: none)`);
    }
    else if (/^roles\.[^.]+\.fallback$/.test(key) && isObj(v)) out[k] = merge(INLINE, v, key, problems);
    else if (key === 'roles.worker.second') {
      if (v === null) out[k] = null;
      else if (isObj(v)) out[k] = merge(SECOND_BASE, v, key, problems);
      else problems.errors.push('"roles.worker.second" is the second worker: { "engine": "codex", "model": "", "effort": "", "takes": "no-docker" } or { "profile": "<name>", "takes": "..." }, or null for none');
    }
    else if (isObj(b)) {
      if (isObj(v)) out[k] = merge(b, v, key, problems);
      else problems.errors.push(`"${key}" must be an object`);
    } else if (Array.isArray(b)) {
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) out[k] = v;
      else problems.errors.push(`"${key}" must be a list of strings`);
    } else if (typeof v === typeof b) out[k] = v;
    else problems.errors.push(`"${key}" must be a ${typeof b}`);
  }
  return out;
}

// "profiles": { "<name>": { engine, account, model } }, each merged over an empty profile.
function mergeProfiles(v, problems) {
  if (!isObj(v)) {
    problems.errors.push('"profiles" must be an object: { "<name>": { "engine": "codex", "account": "work", "model": "" } }');
    return {};
  }
  const out = {};
  for (const [name, p] of Object.entries(v)) {
    if (name.startsWith('$')) continue;
    if (isObj(p)) out[name] = merge({ engine: '', account: '', model: '', effort: '' }, p, `profiles.${name}`, problems);
    else problems.errors.push(`"profiles.${name}" must be an object like { "engine": "codex", "account": "work", "model": "" }`);
  }
  return out;
}

// Environment overrides are lenient like they always were: a value that isn't a number is ignored.
function applyEnv(cfg, env) {
  const used = [];
  const v = (a, b) => {
    const name = [a, b].find((n) => n && has(env[n]));
    if (name) used.push(name);
    return name ? env[name] : undefined;
  };
  let x;
  if ((x = v('NEXTLEVEL_BASE_BRANCH')) !== undefined) cfg.baseBranch = x.trim();
  if ((x = v('NEXTLEVEL_WORKER_SLOTS')) !== undefined) cfg.workers.slots = Math.max(1, Math.min(6, Math.round(num(x, cfg.workers.slots))));
  if ((x = v('NEXTLEVEL_TASK_TIMEOUT_MIN')) !== undefined) cfg.workers.taskTimeoutMin = num(x, cfg.workers.taskTimeoutMin);
  if ((x = v('NEXTLEVEL_KILL_GRACE_MIN')) !== undefined) cfg.workers.killGraceMin = num(x, cfg.workers.killGraceMin);
  // (before FR-010 a worker got a window unless this was 0; 0 is the background, now a console with no window)
  if ((x = v('NEXTLEVEL_WORKER_WINDOW')) !== undefined) cfg.workers.window = { 0: 'hidden', 1: 'visible' }[x.trim()] || (WINDOW_MODES.includes(x.trim()) ? x.trim() : cfg.workers.window);
  if ((x = v('NEXTLEVEL_CHECK_TIMEOUT_MIN')) !== undefined) cfg.checks.timeoutMin = num(x, cfg.checks.timeoutMin);
  if ((x = v('NEXTLEVEL_REPORT_HOUR')) !== undefined) cfg.hub.reportHour = num(x, cfg.hub.reportHour);
  if ((x = v('NEXTLEVEL_AUTOPILOT')) !== undefined) cfg.hub.autopilot = x.trim() === '1' || /^true$/i.test(x.trim());
  for (const engine of LEGACY_ENGINES) {
    const up = engine.toUpperCase();
    // (never the security engineer's: its model is the one its Daybreak check passed)
    if ((x = v(null, `${up}_MODEL`)) !== undefined) for (const [key, role] of Object.entries(cfg.roles)) if (key !== 'security' && !role.profile && role.engine === engine) role.model = x.trim();
    if ((x = v(null, `${up}_ARGS`)) !== undefined) cfg.engines[engine].args = words(x);
  }
  if ((x = v(null, 'NTFY_SERVER')) !== undefined) cfg.notifications.server = x.trim();
  return used;
}

function validate(cfg, root, problems) {
  const err = (m) => problems.errors.push(m);
  if (!Number.isInteger(cfg.version) || cfg.version < 1) err('"version" must be 1');
  else if (cfg.version > CONFIG_VERSION) err(`this file is for a newer nextlevel (version ${cfg.version}); update the nextlevel tool`);
  if (!cfg.name.trim()) err('"name" must not be empty');
  if (!/^[A-Za-z0-9._/-]+$/.test(cfg.baseBranch) || cfg.baseBranch.startsWith('-') || cfg.baseBranch.includes('..')) {
    err(`"baseBranch" is not a valid branch name: "${cfg.baseBranch}"`);
  }
  for (const b of cfg.deployBranches || []) {
    const problem = branchNameProblem(b);
    if (problem) err(`"deployBranches" names branches on origin by their plain names, like "main": ${problem}`);
  }
  const backup = cfg.updates?.backupBranch || '';
  if (backup) {
    const problem = branchNameProblem(backup);
    if (problem) err(`"updates.backupBranch" names a branch on origin by its plain name, like "nextlevel-backup": ${problem}`);
    else if (isDeployBranch(backup, deployList(cfg))) err(`"updates.backupBranch" is ${backup}, a deploy branch: the update's backup never goes to one (nextlevel-backup, say)`);
    else if (backup.toLowerCase() === String(cfg.baseBranch).toLowerCase()) err('"updates.backupBranch" is the base branch itself: name a branch of its own (nextlevel-backup, say)');
  }
  // Any engine can take any role; a role names a profile, or an engine and a model
  const profiles = cfg.profiles;
  for (const [name, p] of Object.entries(profiles)) {
    const key = `profiles.${name}`;
    if (!NAME_RE.test(name)) err(`"${key}": a profile's name has lowercase letters, digits, ".", "_" and "-" only`);
    else if (ENGINES.includes(name)) err(`"${key}": a profile can't have an engine's name (${ENGINES.join(', ')}): "${name}" would mean both`);
    else if (name === SECOND) err(`"${key}": "${SECOND}" is the second worker's name (roles.worker.second): give the profile another`);
    if (!ENGINES.includes(p.engine)) err(`"${key}.engine" must be ${orList(ENGINES)}, not "${p.engine}"`);
    if (p.account && !ACCOUNT_RE.test(p.account)) err(`"${key}.account" becomes a folder name: lowercase letters, digits, "_" and "-" only, not "${p.account}"`);
    if (!MODEL_RE.test(p.model)) err(`"${key}.model" has characters a model name can't have: "${p.model}"`);
    if (!EFFORT_RE.test(p.effort)) err(`"${key}.effort" is a word like low, medium or high, not "${p.effort}"`);
  }
  for (const [role, r] of Object.entries(cfg.roles)) {
    if (r.profile) {
      if (!Object.hasOwn(profiles, r.profile)) err(`"roles.${role}.profile" is "${r.profile}", which "profiles" doesn't have`);
    } else if (!ENGINES.includes(r.engine) && !(['guide', 'assistant', 'security'].includes(role) && !r.engine)) err(`"roles.${role}.engine" must be ${orList(ENGINES)}, not "${r.engine}"`);
    if (role === 'security') {
      const engine = r.profile ? profiles[r.profile]?.engine : r.engine;
      if (engine && !SECURITY_ENGINES.includes(engine)) err(`"roles.security" can't run on ${engine}: ${notSecurity(engine)}. Use ${orList(SECURITY_ENGINES)}, or leave the engine empty to keep the role off`);
    }
    // The assistant is read-only by construction: only an engine that can be run so (src/ask.mjs), or Antigravity in a
    // throwaway copy of the project (lib/askcopy.mjs), which starts only with a passing lock test: that is checked where a
    // question starts, never here (an invalid file would stop the hub and the orchestrator's commands)
    const assistantEngine = role === 'assistant' ? (r.profile ? profiles[r.profile]?.engine : r.engine) : '';
    if (assistantEngine && assistantEngine !== 'agy' && !ASSISTANT_ENGINES.includes(assistantEngine)) err(`"roles.assistant" can't run on ${assistantEngine}: ${NOT_READ_ONLY[assistantEngine] || 'it has no read-only mode'}. Use ${orList(ASSISTANT_ENGINES)}, or leave the engine empty for the automatic choice`);
    if (!MODEL_RE.test(r.model)) err(`"roles.${role}.model" has characters a model name can't have: "${r.model}"`);
    if (!EFFORT_RE.test(r.effort)) err(`"roles.${role}.effort" is a word like low, medium or high, not "${r.effort}"`);
    const fb = r.fallback;
    if (isObj(fb)) {
      if (!ENGINES.includes(fb.engine)) err(`"roles.${role}.fallback.engine" must be ${orList(ENGINES)}, not "${fb.engine}"`);
      if (!MODEL_RE.test(fb.model)) err(`"roles.${role}.fallback.model" has characters a model name can't have: "${fb.model}"`);
      if (!EFFORT_RE.test(fb.effort)) err(`"roles.${role}.fallback.effort" is a word like low, medium or high, not "${fb.effort}"`);
    } else if (fb && !Object.hasOwn(profiles, fb) && !ENGINES.includes(fb)) {
      err(`"roles.${role}.fallback" names a profile or an engine (${ENGINES.join(', ')}), not "${fb}"`);
    }
  }
  const second = cfg.roles.worker?.second;
  if (second) {
    const key = 'roles.worker.second';
    if (second.profile) {
      if (!Object.hasOwn(profiles, second.profile)) err(`"${key}.profile" is "${second.profile}", which "profiles" doesn't have`);
      if (second.engine || second.model || second.effort) err(`"${key}" names profile "${second.profile}" and an engine, model or effort too: give the profile alone`);
    } else if (!ENGINES.includes(second.engine)) err(`"${key}.engine" must be ${orList(ENGINES)}, not "${second.engine}" (or set "${key}" to null for no second worker)`);
    if (!MODEL_RE.test(second.model)) err(`"${key}.model" has characters a model name can't have: "${second.model}"`);
    if (!EFFORT_RE.test(second.effort)) err(`"${key}.effort" is a word like low, medium or high, not "${second.effort}"`);
    if (!Object.hasOwn(SECOND_TAKES, second.takes)) err(`"${key}.takes" is ${orList(Object.keys(SECOND_TAKES))}, not "${second.takes}"`);
  }
  const w = cfg.workers;
  if (!Number.isInteger(w.slots) || w.slots < 1 || w.slots > 6) err('"workers.slots" must be a whole number from 1 to 6');
  if (!(w.taskTimeoutMin > 0)) err('"workers.taskTimeoutMin" must be more than 0');
  if (!(w.killGraceMin >= 0)) err('"workers.killGraceMin" must be 0 or more');
  if (!WINDOW_MODES.includes(w.window)) err(`"workers.window" must be ${orList(WINDOW_MODES)}, not "${w.window}"`);
  for (const n of w.addons.mcpServers) if (!/^[A-Za-z0-9_.@-]{1,64}$/.test(n)) err(`"workers.addons.mcpServers" names MCP servers as the engine's own config names them, like "github": "${n}" isn't one`);
  if (!(cfg.checks.timeoutMin > 0)) err('"checks.timeoutMin" must be more than 0');
  for (const k of ['scanMinutes', 'deepScanMinutes']) if (!(cfg.security[k] >= 5 && cfg.security[k] <= 1440)) err(`"security.${k}" must be a number of minutes from 5 to 1440`);
  if (!Number.isInteger(cfg.hub.reportHour) || cfg.hub.reportHour < 0 || cfg.hub.reportHour > 23) err('"hub.reportHour" must be a whole number from 0 to 23');
  const rounds = cfg.hub.rounds;
  if (!Number.isInteger(rounds.brake) || rounds.brake < 1 || rounds.brake > 20) err('"hub.rounds.brake" must be a whole number from 1 to 20 (the rounds that may start after the last real event; default 3)');
  if (!Number.isInteger(rounds.fuse) || rounds.fuse < 2 || rounds.fuse > 50) err('"hub.rounds.fuse" must be a whole number from 2 to 50 (rounds in a row with nothing real before autopilot turns itself off; default 6)');
  if (!(rounds.wakeMinMinutes >= 1 && rounds.wakeMinMinutes <= 1440)) err('"hub.rounds.wakeMinMinutes" must be a number of minutes from 1 to 1440 (the shortest wake-up; default 5)');
  if (!/^https?:\/\/\S+$/.test(cfg.notifications.server)) err('"notifications.server" must be an http(s) address');
  const checkPath = (key, p) => {
    const abs = path.resolve(root, p);
    const r = path.relative(root, abs);
    if (!p.trim() || path.isAbsolute(p) || r.startsWith('..') || path.isAbsolute(r)) err(`"${key}" must be a path inside the project, like docs/tasks: "${p}"`);
  };
  checkPath('paths.tasks', cfg.paths.tasks);
  checkPath('paths.status', cfg.paths.status);
  checkPath('paths.handoff', cfg.paths.handoff);
  checkPath('paths.notes', cfg.paths.notes);
  for (const key of ['project', 'decisions', 'plans']) checkPath(`paths.${key}`, cfg.paths[key]);
  for (const [role, p] of Object.entries(cfg.paths.roles)) checkPath(`paths.roles.${role}`, p);
  // Protected paths: in the project, from its top ("/x" too: from the top); no way out of it
  for (const k of ['add', 'remove']) {
    for (const e of cfg.protected[k]) {
      const p = String(e).trim().replace(/\\/g, '/');
      if (!p || /(^|\/)\.\.(\/|$)/.test(p) || /^[A-Za-z]:/.test(p) || p.startsWith('//') || /[*?[\]{}]/.test(p)) err(`"protected.${k}" has "${e}": give a path in the project, a file or a folder ending in "/" (no wildcards), like .cursor/ or scripts/deploy.sh`);
    }
  }
  const { unknown } = protectedList(cfg);
  for (const e of unknown) problems.warnings.push(`"protected.remove" has "${e}", which isn't one of the built-in protected paths (${BUILT_IN.join(', ')}): nothing to remove`);
}

// Read the project's settings: defaults, then nextlevel.json, then environment overrides.
// `env` is where overrides come from (process.env, or just the variables of an old .env for init);
// `file: null` leaves nextlevel.json out; `raw`: the file's object as it would be written (the Team panel
// checks a change before it saves it).
export function loadConfig(root, { env = process.env, file = path.join(root, CONFIG_FILE), raw: given } = {}) {
  const problems = { errors: [], warnings: [] };
  let cfg = defaults(path.basename(root));
  const exists = given !== undefined || (!!file && fs.existsSync(file));
  if (exists) {
    let raw = given;
    if (raw === undefined) {
      try {
        raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // Notepad may add a BOM
      } catch (e) {
        throw new Error(`${CONFIG_FILE} is not valid JSON (${e.message}).\nFix it in ${file}, or rename it and run nextlevel init for a fresh one.`);
      }
    }
    if (!isObj(raw)) throw new Error(`${CONFIG_FILE} must hold a JSON object ({ ... }): ${file}`);
    cfg = merge(cfg, raw, '', problems);
    // A role is a profile, or an engine and a model: both would leave one of them unused
    for (const role of ALL_ROLES) {
      const r = raw.roles?.[role];
      if (isObj(r) && r.profile && [r.engine, r.model, r.effort].some((x) => x !== undefined && x !== '')) {
        problems.errors.push(`"roles.${role}" names profile "${r.profile}" and an engine, model or effort too: give the profile alone (its engine, model and effort are in "profiles")`);
      }
    }
  }
  const overrides = applyEnv(cfg, env);
  validate(cfg, root, problems);
  if (problems.errors.length) {
    const where = exists ? file : 'the environment';
    throw new Error(`Settings problem (${where}):\n  - ${problems.errors.join('\n  - ')}`);
  }
  return { config: cfg, file, exists, warnings: problems.warnings, overrides };
}

// nextlevel.json's text: two-space JSON, with lists of words on one line so the file reads like the
// settings table in the README.
export const formatConfig = (config) =>
  `${JSON.stringify(config, null, 2).replace(/\[\n\s*([^[\]{}]*?)\n\s*\]/g, (_, items) => `[${items.split(/,\n\s*/).join(', ')}]`)}\n`;

// The arguments a worker task on an engine gets: engines.<name>.workerArgs when set ([] too: none), else
// engines.<name>.args, as before workerArgs. Every place that starts a worker, checks its flags or describes them reads
// this; the orchestrator, the setup guide and autopilot rounds read args.
export function workerArgsOf(cfg, engine) {
  const e = cfg?.engines?.[engine];
  return Array.isArray(e?.workerArgs) ? e.workerArgs : e?.args || [];
}

// ---------- profiles ----------
// A profile: { name, engine, account, model, effort }. name '' is a role's own { engine, model, effort },
// an engine named on its own, or a fallback of its own; account '' is the engine's own login, in its usual
// folder; model and effort '' are the engine's own choice.

// A profile by its name, or an engine's name for that engine on its own login (with the model and effort a
// role on it pins), or "second" for the second worker. null when it is none of them. `worker`: for a worker's task,
// whose engine named on its own takes the model and effort of a worker profile on it, never the orchestrator's.
export function findProfile(cfg, name, { worker = false } = {}) {
  if (!name) return null;
  const p = cfg.profiles[name];
  if (p) return { name, engine: p.engine, account: p.account || '', model: p.model || '', effort: p.effort || '' };
  if (name === SECOND) return secondProfile(cfg);
  if (ENGINES.includes(name)) return { name: '', engine: name, account: '', model: modelFor(cfg, name, '', { worker }), effort: effortFor(cfg, name, { worker }) };
  return null;
}

// The second worker (roles.worker.second), or null: a profile it names (by that profile's name), else its own engine,
// model and effort under the name "second". `second: true` and `takes` ride along.
export function secondProfile(cfg) {
  const s = cfg.roles.worker?.second;
  if (!s) return null;
  const base = s.profile ? findProfile(cfg, s.profile) : { name: SECOND, engine: s.engine, account: '', model: s.model || '', effort: s.effort || '' };
  return base && { ...base, second: true, takes: s.takes || 'asked' };
}

// The profile that fills a role; with { fallback: true } the one it falls back to (null without one), with
// { second: true } the second worker (the worker role's only). The setup guide without an engine of its own is on the
// orchestrator's. The assistant (the advisor) with no engine of its own: the automatic choice for Advise (`available`:
// which engines it may pick, advisorAuto), or with { quick: true } today's light model (assistantAuto).
export function roleProfile(cfg, role, { fallback = false, second = false, quick = false, available } = {}) {
  const r = cfg.roles[role];
  if (!r) return null;
  if (second) return role === 'worker' ? secondProfile(cfg) : null;
  if (fallback) {
    if (r.fallback && typeof r.fallback === 'object') return { name: '', engine: r.fallback.engine, account: '', model: r.fallback.model || '', effort: r.fallback.effort || '' };
    return findProfile(cfg, r.fallback, { worker: role === 'worker' });
  }
  if (r.profile) return findProfile(cfg, r.profile);
  if (role === 'guide' && !r.engine) return roleProfile(cfg, 'orchestrator');
  if (role === 'assistant' && !r.engine) return quick ? assistantAuto(cfg) : advisorAuto(cfg, { available });
  if (role === 'security' && !r.engine) return null; // off
  return { name: '', engine: r.engine, account: '', model: r.model || '', effort: r.effort || '' };
}

// The assistant's automatic choice: a light model on the first engine that can be run read-only which a role
// already uses (Claude Code's haiku, else Codex at low effort with its smallest listed model, which src/ask.mjs
// picks when it runs), else Codex. `auto: true` says it wasn't chosen in nextlevel.json.
export function assistantAuto(cfg) {
  const used = new Set(profilesInUse(cfg).map((p) => p.engine));
  const engine = ASSISTANT_ENGINES.find((e) => used.has(e)) || 'codex';
  return { name: '', engine, account: '', model: LIGHT_MODELS[engine].model, effort: LIGHT_MODELS[engine].effort, auto: true };
}

// The advisor's automatic choice (docs/design/advisor.md): the first engine that can be run read-only (Claude Code, then
// Codex) which isn't the orchestrator's and is `available`, on its own default model and effort, so it can disagree with
// the orchestrator; else the orchestrator's engine ("not independent"). Never Antigravity: the advisor there is only ever
// pinned. Pure: `available` defaults to the engines a role already uses; the advisor's run, the Team page and the doctor
// pass "its CLI is installed". `independent`: whether it is on another engine than the orchestrator.
export function advisorAuto(cfg, { available } = {}) {
  const used = new Set(profilesInUse(cfg).map((p) => p.engine));
  const can = typeof available === 'function' ? available : (e) => used.has(e);
  const orchestrator = roleProfile(cfg, 'orchestrator')?.engine || '';
  const other = ASSISTANT_ENGINES.find((e) => e !== orchestrator && can(e));
  const engine = other || (ASSISTANT_ENGINES.includes(orchestrator) && can(orchestrator) ? orchestrator : ASSISTANT_ENGINES.find(can) || 'codex');
  return { name: '', engine, account: '', model: '', effort: '', auto: true, independent: engine !== orchestrator };
}

// Where a profile's model and effort are set in nextlevel.json ('' when nowhere: the engine's own choice).
// { model: 'roles.worker.model', effort: '...' }
export function settingKeys(cfg, role, { fallback = false, second = false } = {}) {
  const r = cfg.roles[role];
  if (!r) return { model: '', effort: '' };
  const worker = role === 'worker';
  const named = (name) => (cfg.profiles[name] ? { model: `profiles.${name}.model`, effort: `profiles.${name}.effort` } : ENGINES.includes(name) ? { model: sourceOf(cfg, name, 'model', { worker }), effort: sourceOf(cfg, name, 'effort', { worker }) } : { model: '', effort: '' });
  if (second) {
    const s = worker ? r.second : null;
    if (!s) return { model: '', effort: '' };
    return s.profile ? named(s.profile) : { model: 'roles.worker.second.model', effort: 'roles.worker.second.effort' };
  }
  if (fallback) return r.fallback && typeof r.fallback === 'object' ? { model: `roles.${role}.fallback.model`, effort: `roles.${role}.fallback.effort` } : named(r.fallback);
  if (r.profile) return named(r.profile);
  if (role === 'guide' && !r.engine) return settingKeys(cfg, 'orchestrator');
  if (role === 'assistant' && !r.engine) return { model: '', effort: '' }; // automatic: nothing pinned
  if (role === 'security' && !r.engine && !r.profile) return { model: '', effort: '' }; // off
  return { model: `roles.${role}.model`, effort: `roles.${role}.effort` };
}

// Every profile the roles use, first the roles' own, then the second worker, then their fallbacks, then the setup guide
// and the assistant when they have an engine of their own: [{ role, fallback, second, guide, ...profile, keys }]. `guide`
// marks a role outside the build team (the setup guide, the assistant): an engine only they use matters like a
// fallback's, and so does one only the second worker uses (`second`: a worker, marked second).
export function profilesInUse(cfg) {
  const entry = (role, fallback, second = false) => {
    const p = roleProfile(cfg, role, { fallback, second });
    return p && { role, fallback, second, guide: role === 'guide' || role === 'assistant', ...p, keys: settingKeys(cfg, role, { fallback, second }) };
  };
  const own = ROLES.map((role) => entry(role, false));
  const second = [entry('worker', false, true)].filter(Boolean);
  const fallbacks = ROLES.map((role) => entry(role, true)).filter(Boolean);
  const extra = ['guide', 'assistant'].filter((role) => cfg.roles[role]?.engine || cfg.roles[role]?.profile).map((role) => entry(role, false));
  return [...own, ...second, ...fallbacks, ...extra];
}

// The security engineer's profile, with its Daybreak setting, or null while the role is off. Never in profilesInUse:
// there its model would be tried without Daybreak before every round, the advisor's automatic choice would count its
// engine, and the full-access check would read arguments a scan never uses (docs/design/security-engineer.md).
export function securityProfile(cfg) {
  const r = cfg.roles.security;
  const p = r && roleProfile(cfg, 'security');
  return p && p.engine ? { ...p, role: 'security', daybreak: r.daybreak === true } : null;
}

// How the roles use an engine: 'role' (the build team runs on it), 'fallback' (only a fallback, the second worker or the
// setup guide does) or null.
export function engineUse(cfg, engine) {
  const used = profilesInUse(cfg).filter((p) => p.engine === engine);
  return used.some((p) => !p.fallback && !p.second && !p.guide) ? 'role' : used.length ? 'fallback' : null;
}

// How a profile reads: "codex", "codex gpt-6 (effort high)", "codex-work (codex, account work)".
export const describeProfile = (p) => {
  // (an engine with no effort setting never gets one: Antigravity's level is in its model's name, FR-010)
  const effort = p.effort && ADAPTERS[p.engine]?.efforts.length !== 0 ? `effort ${p.effort}` : '';
  if (p.name) return `${p.name} (${[p.engine, p.account && `account ${p.account}`, p.model, effort].filter(Boolean).join(', ')})`;
  return `${[p.engine, p.model].filter(Boolean).join(' ')}${effort ? ` (${effort})` : ''}`;
};

// Where an engine named on its own takes its `field` (model, effort) from: the first profile on that engine with its own
// login. For a worker's task (`worker`): the workers', then the second worker's, then a fallback's with a model of its own;
// never the orchestrator's (on a real project a task sent to Codex took the orchestrator's model at xhigh). Otherwise the workers', then the
// orchestrator's, as before.
function sourceOf(cfg, engine, field, { worker = false } = {}) {
  const at = (keyBase, p) => (p && p.engine === engine && !p.account ? { key: p[field] ? `${keyBase}.${field}` : '', model: p.model } : null);
  const ofRole = (r, base) => (!r ? null : r.profile ? at(`profiles.${r.profile}`, cfg.profiles[r.profile]) : at(base, r));
  const w = cfg.roles.worker;
  const candidates = worker
    ? [
        () => ofRole(w, 'roles.worker'),
        () => ofRole(w?.second, 'roles.worker.second'),
        () => {
          const fb = w?.fallback;
          const hit = fb && typeof fb === 'object' ? at('roles.worker.fallback', fb) : cfg.profiles[fb] ? at(`profiles.${fb}`, cfg.profiles[fb]) : null;
          return hit && hit.model ? hit : null; // (a fallback counts only with a model of its own)
        },
      ]
    : [() => ofRole(w, 'roles.worker'), () => ofRole(cfg.roles.orchestrator, 'roles.orchestrator')];
  for (const c of candidates) {
    const hit = c();
    if (hit) return hit.key;
  }
  return '';
}
const valueAt = (cfg, key) => (key ? key.split('.').reduce((o, k) => o?.[k], cfg) || '' : '');

// The model a job runs with: the one it asked for, else the model of the profile on that engine with its own login that
// sourceOf finds (`worker`: a worker's task, never the orchestrator's).
export function modelFor(cfg, engine, requested = '', { worker = false } = {}) {
  if (requested) return requested;
  return valueAt(cfg, sourceOf(cfg, engine, 'model', { worker }));
}
// The same for the reasoning effort.
export const effortFor = (cfg, engine, { worker = false } = {}) => valueAt(cfg, sourceOf(cfg, engine, 'effort', { worker }));

// ---------- changing a role (the Team panel, nextlevel team set) ----------
// nextlevel.json's object with one role changed, as the owner chose it: `change` is { profile } or
// { engine, model, effort } (model and effort '' for the engine's own). `fallback`: the role's fallback.
// Everything else in the file stays as it was. Returns the new object; loadConfig's rules check it.
// `second`: the worker role's second worker; `change` may then be { none: true } (no second worker), and carries `takes`
// (SECOND_TAKES; the one it had, else "no-docker", when not given).
export function withRole(raw, role, change, { fallback = false, second = false } = {}) {
  const out = structuredClone(raw || {});
  out.roles ||= {};
  const cur = isObj(out.roles[role]) ? out.roles[role] : {};
  const clean = (x) => String(x ?? '').trim();
  if (second) {
    if (change.none) {
      out.roles[role] = { ...cur, second: null };
      return out;
    }
    const takes = clean(change.takes) || (isObj(cur.second) && cur.second.takes) || 'no-docker';
    const value = change.profile ? { profile: clean(change.profile), takes } : { engine: clean(change.engine), model: clean(change.model), effort: clean(change.effort), takes };
    out.roles[role] = { ...cur, second: value };
    return out;
  }
  if (fallback) {
    let value = '';
    if (change.profile) value = clean(change.profile);
    else if (change.engine) {
      const inline = { engine: clean(change.engine), model: clean(change.model), effort: clean(change.effort) };
      // an engine alone stays a name, as before M9
      value = inline.model || inline.effort ? inline : inline.engine;
    }
    out.roles[role] = { ...cur, fallback: value };
    return out;
  }
  const { fallback: fb, second: sec } = cur;
  const next = change.profile
    ? { profile: clean(change.profile) }
    : { engine: clean(change.engine), model: clean(change.model), effort: clean(change.effort), profile: '' };
  // (the role's fallback and second worker stay as they were; the security engineer's Daybreak unless the change sets it)
  const daybreak = role === 'security' ? { daybreak: typeof change.daybreak === 'boolean' ? change.daybreak : cur.daybreak === true } : {};
  out.roles[role] = { ...next, ...daybreak, ...(fb === undefined ? {} : { fallback: fb }), ...(sec === undefined ? {} : { second: sec }) };
  return out;
}
