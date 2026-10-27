// The team as the owner sees it (M9): who fills each role, with the engine, model and reasoning effort
// actually in use. An empty model or effort in nextlevel.json is the engine's own choice, which is shown as
// the real value where the engine's own files say it (Codex's config.toml, Claude Code's settings.json).
// Used by the dashboard's Team page and `nextlevel team`; reads files only, runs nothing.
import fs from 'node:fs';
import path from 'node:path';
import { ADAPTERS, engineTitle, fullAccessNote, workerCaveat } from '../engines/index.mjs';
import { SECOND_TAKES, SECURITY_ENGINES, notReadOnly, notSecurity, roleProfile, settingKeys, workerArgsOf } from './config.mjs';

// The rows of the Team page, in order. `role` and `fallback` say where in nextlevel.json each one is.
export const TEAM_ROWS = [
  { key: 'orchestrator', role: 'orchestrator', fallback: false, title: 'Orchestrator', does: 'plans the work, reviews it and merges' },
  { key: 'worker', role: 'worker', fallback: false, title: 'Workers', does: 'build each task in a slot of their own' },
  { key: 'worker-second', role: 'worker', fallback: false, second: true, title: 'Second worker', does: 'takes the tasks its note says, in the same slots as the workers (--profile second)' },
  { key: 'worker-fallback', role: 'worker', fallback: true, title: 'Fallback worker', does: 'takes a task the orchestrator sends on (retry --fallback)' },
  { key: 'guide', role: 'guide', fallback: false, title: 'Setup guide', does: 'walks you through setup, one step at a time' },
  { key: 'orchestrator-fallback', role: 'orchestrator', fallback: true, title: 'Fallback orchestrator', does: "takes over when the orchestrator's engine isn't ready", optional: true },
  { key: 'assistant', role: 'assistant', fallback: false, title: 'Advisor', does: 'advises you and answers your questions about the project, read-only, apart from the orchestrator; it drafts notes and replies that only your click sends' },
  { key: 'security', role: 'security', fallback: false, title: 'Security engineer', does: "finds and confirms security problems in the project's code, in a checkout of its own, when you start a scan; it never changes the code" },
];
export const rowByKey = (key) => TEAM_ROWS.find((r) => r.key === key);

// The engines' files, read again only when they change: the dashboard asks every second or two, and Codex's
// models_cache.json can be large.
const seen = new Map(); // file -> { stamp, text }
function readText(f) {
  let stamp;
  try {
    const st = fs.statSync(f);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    seen.delete(f);
    return null;
  }
  const hit = seen.get(f);
  if (hit?.stamp === stamp) return hit.text;
  try {
    const text = fs.readFileSync(f, 'utf8');
    seen.set(f, { stamp, text });
    return text;
  } catch {
    return null;
  }
}
// Where an engine's own files are: this PC's, unless a test gives others.
const machine = (where = {}) => ({ home: where.home, env: where.env || process.env, read: where.read || readText, path: where.path || path });

// What a profile runs with: the model and effort nextlevel pins, else the engine's own as far as its files
// say. { model, modelFrom, effort, effortFrom, pinned: { model, effort }, byDefault }
export function inUse(profile, config, where = {}) {
  const eng = ADAPTERS[profile.engine];
  const m = machine(where);
  const own = eng.own({ ...m, account: profile.account || '', args: config?.engines?.[profile.engine]?.args || [] }) || {};
  const model = profile.model || own.model || '';
  // An engine with no effort setting (Antigravity) runs at the level its model's name carries: an effort in
  // nextlevel.json never reaches it (FR-010)
  if (!eng.efforts.length) {
    const level = eng.effortOf?.(model) || '';
    return { model, modelFrom: profile.model ? 'nextlevel.json' : own.from || '', effort: level, effortFrom: level ? "the model's name" : '', pinned: { model: profile.model || '', effort: '' }, ignored: profile.effort || '', byDefault: own.byDefault || `${eng.title}'s own choice` };
  }
  const effort = profile.effort || own.effort || '';
  return {
    model,
    modelFrom: profile.model ? 'nextlevel.json' : own.from || '',
    effort,
    effortFrom: profile.effort ? 'nextlevel.json' : own.effortFrom || '',
    pinned: { model: profile.model || '', effort: profile.effort || '' },
    byDefault: own.byDefault || `${eng.title}'s own choice`,
  };
}

// "gpt-6 (Codex's own, from ~/.codex/config.toml)", "opus", "the account's default model".
export function modelText(profile, use, home = '') {
  const tilde = (f) => (home && f.startsWith(home) ? `~${f.slice(home.length)}` : f);
  if (use.pinned.model) return use.pinned.model;
  if (use.model) return `${use.model} (${engineTitle(profile.engine)}'s own, from ${tilde(use.modelFrom)})`;
  return use.byDefault;
}
export function effortText(profile, use, home = '') {
  const tilde = (f) => (home && f.startsWith(home) ? `~${f.slice(home.length)}` : f);
  if (use.pinned.effort) return use.pinned.effort;
  // Antigravity: the level is in the model's name (FR-010)
  if (!ADAPTERS[profile.engine].efforts.length) return use.effort ? `${use.effort} (from the model's name)` : "none: the model's name carries no level";
  // engines.<name>.args is nextlevel.json's, not the engine's own
  if (use.effort && /^engines\./.test(use.effortFrom)) return `${use.effort} (${use.effortFrom} in nextlevel.json)`;
  if (use.effort) return `${use.effort} (${engineTitle(profile.engine)}'s own, from ${tilde(use.effortFrom)})`;
  return ADAPTERS[profile.engine].efforts.length ? "the model's default" : 'none';
}

// The Team page: one entry per row, with what is set, what is in use, what choosing each engine means and what
// it can't do on this PC. `where.platform`: this PC's, unless a test gives another.
export function teamView(config, where = {}) {
  const home = where.home || '';
  return TEAM_ROWS.map((row) => {
    const r = config.roles[row.role] || {};
    // (the advisor's automatic choice: among the engines `where.available` says are there, as its run picks)
    const p = roleProfile(config, row.role, { fallback: row.fallback, second: !!row.second, ...(row.role === 'assistant' && where.available ? { available: where.available } : {}) });
    // (the second worker: what it takes, and the choices for it)
    const takes = row.second ? { value: p?.takes || 'no-docker', text: SECOND_TAKES[p?.takes] || '', choices: Object.entries(SECOND_TAKES).map(([value, text]) => ({ value, text })) } : null;
    const base = { key: row.key, role: row.role, fallback: row.fallback, second: !!row.second, title: row.title, does: row.does, ...(takes ? { takes } : {}) };
    if (!p) return row.optional ? null : { ...base, none: true, ...(row.role === 'security' ? { off: true, daybreak: false } : {}), warnings: [], notices: [], text: row.fallback ? 'none: a failed task stays with the orchestrator' : row.second ? 'none: every task goes to the workers (or where its spec or the orchestrator sends it)' : row.role === 'security' ? 'off: turn it on to scan the code (Codex)' : 'none' };
    const eng = ADAPTERS[p.engine];
    const use = inUse(p, config, where);
    const keys = settingKeys(config, row.role, { fallback: row.fallback, second: !!row.second });
    // The advisor's automatic choice: the engine's own default model for Advise (Quick: a light model, picked when it runs)
    const auto = row.role === 'assistant' && p.auto;
    const modelShown = modelText(p, use, home);
    // (a worker's own arguments: engines.<name>.workerArgs, else args)
    const args = row.role === 'worker' ? workerArgsOf(config, p.engine) : config.engines?.[p.engine]?.args || [];
    // (where.access: what the doctor knows of this PC for the note, checks/argon.mjs accessFacts)
    const full = fullAccessNote(p, row.role, args, where.access?.(p, row.role) || {});
    return {
      ...base,
      auto: !!auto,
      engine: p.engine,
      engineTitle: eng.title,
      // (the second worker on an engine of its own is named "second", which is no profile of nextlevel.json)
      profile: row.second && !r.second?.profile ? '' : p.name || '',
      account: p.account || '',
      // the setup guide with no engine of its own is on the orchestrator's; a fallback may be a name
      sameAs: row.role === 'guide' && !r.engine && !r.profile ? 'orchestrator' : '',
      setAs: row.second ? (r.second?.profile ? `profile ${r.second.profile}` : '') : row.fallback ? (typeof r.fallback === 'object' ? 'own' : r.fallback || '') : r.profile ? `profile ${r.profile}` : '',
      model: { set: auto ? '' : p.model || '', key: keys.model, inUse: use.model, from: use.modelFrom, text: auto ? `${modelShown} (automatic)` : modelShown },
      // (an engine with no effort setting has no field for it: its level is in the model's name, FR-010)
      effort: eng.efforts.length
        ? { set: p.effort || '', key: keys.effort, inUse: use.effort, from: use.effortFrom, text: effortText(p, use, home), note: p.effort && eng.effortNote ? eng.effortNote : '' }
        : { set: '', key: '', fixed: true, inUse: use.effort, from: use.effortFrom, text: effortText(p, use, home), note: use.ignored ? `${keys.effort || 'the effort'} ("${use.ignored}") in nextlevel.json isn't used: ${eng.effortNote}` : eng.effortNote || '' },
      notes: [eng.notes[row.role], eng.notes.plan].filter(Boolean),
      // what a worker on this engine can't do on this PC (FR-009: Codex on Windows), and a role that runs with no
      // permission check, with the owner's full access (FR-017: Antigravity): a warning where the owner can act (a role
      // in the main checkout), information where the risk is accepted by design (workers)
      warnings: [
        row.role === 'worker' ? workerCaveat(p, where.platform || process.platform, args)?.warning : '',
        full?.level === 'warn' ? full.text : '',
      ].filter(Boolean),
      notices: [
        full?.level === 'info' ? full.text : '',
        // (V8: Docker's access is the PC's, KNOWN_ISSUES)
        row.role === 'security' ? "The scanner's sign-in is kept in a Docker volume of its own: any program that can use Docker on this PC can read it." : '',
      ].filter(Boolean),
      // the advisor: whether it is on another engine than the orchestrator, so it can disagree with it
      ...(row.role === 'assistant' ? { independent: advisorIndependent(config, p) } : {}),
      // the security engineer: whether its scans run with OpenAI's Daybreak Blue, and what that means
      ...(row.role === 'security' ? { daybreak: r.daybreak === true, daybreakText: r.daybreak === true ? "Daybreak Blue: OpenAI's cyber access program for defensive work, on the models it covers" : "Standard safeguards: OpenAI's cyber screening may block parts of a scan" } : {}),
    };
  }).filter(Boolean);
}

// Whether the advisor runs on another engine than the orchestrator: { ok, text }
export function advisorIndependent(config, p) {
  const o = roleProfile(config, 'orchestrator');
  const ok = !!p && !!o && p.engine !== o.engine;
  return { ok, text: ok ? `Independent of the orchestrator (${ADAPTERS[o.engine]?.title || o.engine}): it can disagree with it.` : `Same engine as the orchestrator (${ADAPTERS[p?.engine]?.title || p?.engine || '?'}): it may agree with it too easily. Another engine for it: nextlevel team set assistant --engine claude (or codex).` };
}

// How a worker's process shows (workers.window, FR-010), for the Team page and `nextlevel team`. What each choice
// does is what was measured on Windows 11 with Windows Terminal as the default terminal.
export const WINDOW_CHOICES = [
  {
    mode: 'hidden',
    title: 'No window',
    text: "Nothing opens and nothing takes the focus. A worker that needs a real console (Antigravity) gets one with no window (Windows starts it with no window at all, CREATE_NO_WINDOW). What it does shows under Show activity, and its tokens count in Today.",
  },
  {
    mode: 'minimized',
    title: 'Minimized',
    text: 'Each worker gets a console window of its own, started minimized (Windows Terminal, when it is the default terminal, opens it normally). Windows still gives that window the keyboard focus when it opens, until you click elsewhere: only "No window" never takes it.',
  },
  {
    mode: 'visible',
    title: 'A window each',
    text: 'Each worker opens a window of its own in your terminal (it takes the focus) that shows what it does. After a failure the window stays open until you press Enter in it.',
  },
];
export function windowView(config, platform = process.platform) {
  const mode = config.workers?.window || 'hidden';
  return {
    mode,
    key: 'workers.window',
    title: WINDOW_CHOICES.find((c) => c.mode === mode)?.title || mode,
    windows: platform === 'win32',
    choices: WINDOW_CHOICES,
    text: platform === 'win32' ? '' : 'Workers have no window on this system: they run in the background whatever this says.',
  };
}

// Codex workers' sandbox (the Team page's switch, `nextlevel team sandbox`): in it, or without it like the other
// workers. It writes engines.codex.workerArgs: the workers' own arguments, so the orchestrator, the setup guide and
// autopilot rounds keep engines.codex.args and their sandbox. Without it: danger-full-access, which ran a worker
// unattended with network, git and Docker on Codex 0.160.0 (approvals said never, whatever config.toml says); in it: the
// network on for its commands, on the worker's command line only, never in ~/.codex/config.toml (that would give the
// orchestrator network too). The rest of engines.codex.args stays.
export const CODEX_NO_SANDBOX = ['--sandbox', 'danger-full-access', '-c', 'approval_policy=never'];
export const CODEX_SANDBOX = ['--sandbox', 'workspace-write', '-c', 'sandbox_workspace_write.network_access=true'];
// (--full-auto: an older Codex's workspace-write sandbox, which would win over the switch's own; 0.160.0 refuses it)
const SANDBOX_FLAGS = new Set(['--dangerously-bypass-approvals-and-sandbox', '--yolo', '--full-auto']);
function withoutSandbox(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = String(args[i]);
    if (SANDBOX_FLAGS.has(a) || a.startsWith('--sandbox=')) continue;
    if (a === '--sandbox' || a === '-s') {
      i++;
      continue;
    }
    if ((a === '-c' || a === '--config') && /^(sandbox_workspace_write\.network_access|approval_policy|sandbox_mode)\s*=/.test(String(args[i + 1] || ''))) {
      i++;
      continue;
    }
    out.push(a);
  }
  return out;
}
// engines.codex.workerArgs for the choice: `sandbox` true (in it) or false (without it)
export const codexWorkerArgs = (config, sandbox) => [...(sandbox ? CODEX_SANDBOX : CODEX_NO_SANDBOX), ...withoutSandbox(config?.engines?.codex?.args || [])];
export const CODEX_WORKER_CHOICES = [
  { sandbox: true, title: "In Codex's sandbox", text: 'Its commands run under accounts of their own, and the hub does its git (choosing this turns its network on). On Windows they are refused Docker, ~/.docker and package installs with pnpm (its store is in your AppData), network or not.' },
  { sandbox: false, title: 'Without it, like your other workers', text: "Docker, pnpm and git work. A worker runs in a slot of its own with no secrets, where git refuses its pushes (FR-003); it acts with your access there, as Antigravity and Claude Code workers do. The orchestrator keeps Codex's sandbox." },
];
// The switch as it stands: { sandbox, key, args, set (whether workerArgs is set), choices, uses (a worker role runs on Codex) }
export function codexWorkersView(config) {
  const args = workerArgsOf(config, 'codex');
  const sandbox = !ADAPTERS.codex.writesGitWith(args);
  // (the workers, the second worker or their fallback)
  const uses = [{}, { fallback: true }, { second: true }].some((o) => roleProfile(config, 'worker', o)?.engine === 'codex');
  return { sandbox, key: 'engines.codex.workerArgs', args, set: Array.isArray(config?.engines?.codex?.workerArgs), uses, title: CODEX_WORKER_CHOICES.find((c) => c.sandbox === sandbox).title, choices: CODEX_WORKER_CHOICES };
}

// What the page offers for each engine: its efforts, the names its --model takes without a list, what choosing it
// means for each role, and whether it can be the assistant (only an engine that can be run read-only; else why not).
export const engineChoices = () =>
  Object.values(ADAPTERS).map((e) => ({ name: e.name, title: e.title, efforts: e.efforts, levelInModel: !e.efforts.length, modelHints: e.modelHints || [], notes: e.notes, effortNote: e.effortNote || '', canHaveAccount: !!e.account, assistant: !!e.readOnly || e.name === 'agy', notAssistant: e.readOnly || e.name === 'agy' ? '' : notReadOnly(e.name), security: SECURITY_ENGINES.includes(e.name), notSecurity: SECURITY_ENGINES.includes(e.name) ? '' : notSecurity(e.name) }));

// The models an engine's CLI lists, run with the profile's account: { list, from } or { list: [], why }.
export function listModels(engineName, run) {
  const eng = ADAPTERS[engineName];
  try {
    const r = eng.models(run);
    if (r?.list?.length) return r;
    return { list: [], why: eng.modelHints?.length ? `${eng.title} has no command that lists its models` : `${eng.title} listed no models` };
  } catch (err) {
    return { list: [], why: err.message };
  }
}

// What a job runs with, for its record: the model and effort in use, and whether each is the engine's own.
export function jobModel(profile, config, where) {
  const use = inUse(profile, config, where);
  return { model: use.model || '', effort: use.effort || '', modelOwn: !use.pinned.model, effortOwn: !use.pinned.effort };
}
