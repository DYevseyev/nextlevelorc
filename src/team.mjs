// nextlevel team (M9): who fills each role, and changing it. The dashboard's Team page runs it too.
//   nextlevel team [--json]                   each role: engine, model and effort actually in use
//   nextlevel team models <engine> [--json]   the models that engine's CLI lists (Codex, Antigravity)
//   nextlevel team window [hidden|minimized|visible] [--json]   how a worker's process shows on Windows (workers.window, FR-010)
//   nextlevel team sandbox [on|off] [--json]   Codex workers in Codex's sandbox, or without it like the other workers
//        (engines.codex.workerArgs; the orchestrator keeps engines.codex.args)
//   nextlevel team tester [on|off] [--json]   the tester (tester.enabled in nextlevel.json; its section is written by hand
//        or with the owner's help: docs/acceptance.md)
//   nextlevel team runner status|on [--repo owner/name] [--json]   the project's GitHub checks on this PC: whether it's
//        offered and recommended (status), and setting it up (on: only a personal account's private repository; the
//        runner itself is the design's part B, docs/design/self-hosted-runner.md)
//   nextlevel team set <role> --engine E [--model M] [--effort X] | --profile P  [--check] [--json]
//        role: orchestrator, worker, worker-fallback, guide, orchestrator-fallback (--engine orchestrator puts
//        the setup guide back on the orchestrator's), assistant (--engine auto), security (--engine off turns it off;
//        --daybreak on|off: its scans with OpenAI's Daybreak Blue)
// A change is checked before nextlevel.json is written: the file's own rules, then the doctor's checks for
// that engine (installed, signed in, the model accepted), run on the changed settings. Only an error about the
// role being changed keeps it from being saved; warnings are shown with the result (--check: check only;
// --anyway, from before warnings stopped blocking, is still taken and changes nothing). The running hub takes
// it at its next autopilot round or task; a round or task already running goes on as it is.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeContext } from './checks/context.mjs';
import { byId, runChecks, severityOf } from './checks/index.mjs';
import { windowLabel } from './checks/lib.mjs';
import { commandArgs } from './lib/commands.mjs';
import { ADAPTERS, ENGINE_NAMES, accountProblem, engineTitle, profileEnv } from './engines/index.mjs';
import { CONFIG_FILE, SECOND_TAKES, WINDOW_MODES, findProfile, formatConfig, loadConfig, notReadOnly, roleProfile, withRole } from './lib/config.mjs';
import { accessFacts } from './checks/argon.mjs';
import { recordOwner } from './lib/guard.mjs';
import { needsLockTest } from './lib/rolespec.mjs';
import { agentSession, ownerOnly } from './lib/session.mjs';
import { resolveBin, runQuiet } from './lib/proc.mjs';
import { checksView, readRepoFacts, keepFacts, offer, repoFacts, repoSlug } from './lib/ghrepo.mjs';
import { githubRepo } from './checks/engines.mjs';
import { TEAM_ROWS, codexWorkerArgs, codexWorkersView, engineChoices, listModels, rowByKey, teamView, windowView } from './lib/team.mjs';

const MODEL_CHECK = { codex: 'codex.model', agy: 'agy.model', claude: 'claude.model' };
// When a change reaches the work: never in the middle of a round or a task
const APPLIES = {
  orchestrator: 'at the next autopilot round, or the next time you open the orchestrator (a round or window open now goes on as it is)',
  worker: 'to the next task that starts (running tasks go on as they are; a task sent to a named engine or profile keeps it)',
  guide: 'the next time you open the setup guide',
  assistant: 'to the next question you ask (a question being answered goes on as it is)',
  security: 'to the next scan you start (a scan running now goes on as it is)',
};

const readRaw = (file) => {
  const text = fs.readFileSync(file, 'utf8');
  return { raw: JSON.parse(text.replace(/^﻿/, '')), crlf: /\r\n/.test(text) };
};

// `nextlevel team` and its subcommands. `ctx`: { root, stateDir, hubAlive, loaded } from the hub. Returns the exit code.
export async function cmdTeam(argv, { root, stateDir, hubAlive = () => false, loaded }) {
  const a = commandArgs('team', argv);
  const [sub, ...rest] = a._;
  const print = (json, text) => console.log(a.json ? JSON.stringify(json, null, 2) : text);
  if (!sub) {
    if (loaded.error) {
      print({ ok: false, message: loaded.error }, loaded.error);
      return 1;
    }
    // (what the doctor knows of this PC for the notes: the orchestrator's lock test on Antigravity, agy's own settings)
    const ctx = makeContext({ root, config: loaded.config, stateDir, hubAlive });
    const rows = teamView(loaded.config, { home: os.homedir(), access: accessFacts(ctx), available: (e) => !!resolveBin(ADAPTERS[e].command) });
    const win = windowView(loaded.config);
    const codex = codexWorkersView(loaded.config);
    if (a.json) return print({ ok: true, rows, engines: engineChoices(), window: win, codexWorkers: codex, file: CONFIG_FILE }), 0;
    const lines = ['The team (nextlevel.json). A change applies at the next autopilot round or task, never in the middle of one.'];
    for (const r of rows) {
      if (r.none) lines.push(`  ${r.title.padEnd(22)} ${r.text}`);
      else {
        const who = `${r.sameAs ? "the orchestrator's: " : ''}${r.engineTitle}${r.profile ? ` (profile ${r.profile}${r.account ? `, account ${r.account}` : ''})` : ''}`;
        lines.push(`  ${r.title.padEnd(22)} ${who} · model ${r.model.text} · ${r.effort.fixed ? 'level' : 'effort'} ${r.effort.text}${r.takes ? ` · takes ${r.takes.text}` : ''}`);
        for (const w of r.warnings || []) lines.push(`  ${''.padEnd(22)} Warning: ${w}`);
        for (const w of r.notices || []) lines.push(`  ${''.padEnd(22)} Note: ${w}`);
      }
    }
    lines.push(`  ${'Worker windows'.padEnd(22)} ${win.title} (workers.window: ${win.mode})${win.text ? `. ${win.text}` : ''}`);
    lines.push(`  ${'Codex workers'.padEnd(22)} ${codex.title} (${codex.set ? 'engines.codex.workerArgs' : 'engines.codex.args, as the orchestrator'}: ${codex.args.join(' ') || 'none'})`);
    lines.push('', `To change one: nextlevel team set <${TEAM_ROWS.map((r) => r.key).join('|')}> --engine ${ENGINE_NAMES.join('|')} [--model M] [--effort E]`);
    lines.push('Or on the dashboard (nextlevel ui): Team. nextlevel team models <engine> lists the models a CLI offers.');
    console.log(lines.join('\n'));
    return 0;
  }
  if (sub === 'models') return models(rest[0], a, loaded, print);
  if (sub === 'window') return setWindow(rest[0], a, { root, loaded, print });
  if (sub === 'sandbox') return setSandbox(rest[0], a, { root, loaded, print });
  if (sub === 'runner') return runner(rest[0], a, { root, print });
  if (sub === 'tester') return setTester(rest[0], a, { root, loaded, print });
  if (sub === 'set') return set(rest[0], a, { root, stateDir, hubAlive, loaded, print });
  print({ ok: false, message: `unknown: team ${sub}` }, 'usage: nextlevel team [--json] | team models <engine> | team set <role> --engine E [--model M] [--effort X]');
  return 1;
}

// The models an engine's CLI lists, asked with the account a profile names (no profile: its own login).
function models(name, a, loaded, print) {
  const profile = name && (findProfile(loaded.config, name) || null);
  if (!profile) {
    print({ ok: false, message: `which engine? ${ENGINE_NAMES.join(', ')} or a profile` }, `usage: nextlevel team models <${ENGINE_NAMES.join('|')}|profile>`);
    return 1;
  }
  const eng = ADAPTERS[profile.engine];
  let env;
  try {
    env = profileEnv(process.env, profile, { home: os.homedir() });
  } catch (err) {
    print({ ok: false, message: err.message }, err.message);
    return 1;
  }
  const run = (cmd, args, opts = {}) => runQuiet(cmd, args, { ...opts, env });
  const r = listModels(profile.engine, run);
  const out = { ok: true, engine: profile.engine, title: eng.title, list: r.list, from: r.from || '', why: r.why || '', hints: eng.modelHints || [], efforts: eng.efforts };
  print(out, r.list.length ? `${eng.title} (${r.from}):\n${r.list.map((m) => `  ${m.id}${m.label && m.label !== m.id ? `  ${m.label}` : ''}${m.efforts.length ? `  efforts: ${m.efforts.join(', ')}` : ''}`).join('\n')}` : `${r.why}.${out.hints.length ? ` Its --model takes: ${out.hints.join(', ')}, or a full model name.` : ''}`);
  return 0;
}

// Check a change to one role, and save it when the checks pass.
async function set(key, a, { root, stateDir, hubAlive, loaded, print }) {
  const row = rowByKey(key);
  const fail = (message, extra = {}) => {
    print({ ok: false, saved: false, message, ...extra }, message);
    return 1;
  };
  if (!row) return fail(`which role? ${TEAM_ROWS.map((r) => r.key).join(', ')}`);
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return fail(`${CONFIG_FILE} is missing: nextlevel init makes it.`);
  let raw;
  let crlf;
  try {
    ({ raw, crlf } = readRaw(file));
  } catch (err) {
    return fail(`${CONFIG_FILE} is not valid JSON (${err.message}): fix it first (the Setup page shows it).`);
  }
  const has = (k) => typeof a[k] === 'string';
  if (has('profile') && (has('engine') || has('model') || has('effort'))) return fail('give a profile, or an engine with a model and effort: not both');
  if (!has('profile') && !has('engine')) return fail('give --engine (codex, agy or claude) or --profile');
  // The second worker: --engine none takes it away; --takes says what it takes (SECOND_TAKES)
  if (has('takes') && !row.second) return fail("--takes is the second worker's: nextlevel team set worker-second --engine E --takes no-docker|any|asked");
  if (has('takes') && !Object.hasOwn(SECOND_TAKES, a.takes)) return fail(`--takes is ${Object.keys(SECOND_TAKES).join(', ')}, not "${a.takes}"`);
  if (row.second && a.engine === 'none') return saveNoSecond({ root, print, fail });
  // The security engineer: --engine off turns it off; --daybreak is its alone
  if (has('daybreak') && row.key !== 'security') return fail("--daybreak is the security engineer's: nextlevel team set security --engine codex --daybreak on|off");
  if (has('daybreak') && !['on', 'off'].includes(a.daybreak)) return fail(`--daybreak is on or off, not "${a.daybreak}"`);
  if (row.key === 'security' && a.engine === 'off') return saveSecurityOff({ root, print, fail });
  // The setup guide can go back to the orchestrator's engine: --engine orchestrator
  // ... and the assistant to its automatic choice: --engine auto
  const sameAsOrchestrator = (row.key === 'guide' && a.engine === 'orchestrator') || (row.key === 'assistant' && a.engine === 'auto');
  if (has('engine') && !ENGINE_NAMES.includes(a.engine) && !sameAsOrchestrator) return fail(`--engine must be ${ENGINE_NAMES.join(', ')}${row.key === 'assistant' ? ', or auto' : row.key === 'security' ? ', or off' : ''}`);
  // The assistant runs read-only by construction: only an engine that can be run so (src/ask.mjs)
  const assistantOn = row.key === 'assistant' && (has('profile') ? loaded.config.profiles?.[a.profile]?.engine : a.engine);
  // (Antigravity: in a copy of the project per question, once its lock test passes: lock.test below)
  if (assistantOn && ENGINE_NAMES.includes(assistantOn) && assistantOn !== 'agy' && !ADAPTERS[assistantOn].readOnly) return fail(`The assistant can't run on ${engineTitle(assistantOn)}: ${notReadOnly(assistantOn)}. Choose Codex or Claude Code, or --engine auto.`);
  const change = has('profile') ? { profile: a.profile } : sameAsOrchestrator ? { engine: '', model: '', effort: '' } : { engine: a.engine, model: a.model || '', effort: a.effort || '' };
  if (has('daybreak')) change.daybreak = a.daybreak === 'on';

  // The engine's efforts: its adapter's, and what its CLI lists for the model
  const engineName = change.profile ? loaded.config.profiles?.[change.profile]?.engine : change.engine;
  const effort = change.effort || (change.profile ? loaded.config.profiles?.[change.profile]?.effort : '') || '';
  // (Antigravity has none: it takes the level from the model's name, gemini-3.8-flash-high is high and
  // claude-opus-5-5-medium medium, and nextlevel doesn't pass --effort: FR-010, FR-022)
  if (engineName && change.effort && !ADAPTERS[engineName].efforts.length) return fail(ADAPTERS[engineName].effortNote || `${engineTitle(engineName)} has no effort setting`);
  if (engineName && effort && ADAPTERS[engineName].efforts.length && !ADAPTERS[engineName].efforts.includes(effort)) {
    return fail(`${engineTitle(engineName)} takes the effort ${ADAPTERS[engineName].efforts.join(', ')}, not "${effort}"`);
  }

  // The file's own rules, on the changed settings
  const next = withRole(raw, row.role, row.second ? { ...change, takes: a.takes || '' } : change, { fallback: row.fallback, second: !!row.second });
  let candidate;
  try {
    candidate = loadConfig(root, { raw: next });
  } catch (err) {
    return fail(err.message.replace(/^Settings problem \([^)]*\):\s*/, ''));
  }
  const config = candidate.config;
  const profile = roleProfile(config, row.role, { fallback: row.fallback, second: !!row.second });
  if (!profile) return fail('that leaves the role empty');

  // The doctor's checks for that engine, on the changed settings
  const ctx = makeContext({ root, config, configInfo: { exists: true, file, warnings: candidate.warnings, error: null, overrides: candidate.overrides }, stateDir, hubAlive });
  ctx.retryRefusals = true; // (a refusal the model check kept is tried again at once: the owner is choosing now, FR-022)
  // (the orchestrator on Antigravity starts only with a passing lock test for what it would run: lock.test, an error)
  // (the security engineer: its own checks, never the model check of the roles in use, which doesn't see its model)
  const ids = row.role === 'security'
    ? ['security.docker', 'security.image', 'security.login', 'security.probe', 'security.daybreak']
    : [`tool.${profile.engine}`, `${profile.engine}.login`, MODEL_CHECK[profile.engine], 'profiles.accounts', ...(row.role === 'worker' ? ['codex.worker-windows'] : []), ...(needsLockTest(profile, row.role) ? ['lock.test'] : [])];
  const checks = ids.map((id) => byId(id)).filter(Boolean);
  const ran = await runChecks(ctx, { checks });
  const results = ran.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    severity: r.severity,
    detail: r.detail,
    next: r.next,
    steps: r.steps.map((s) => ({ ...s, label: windowLabel(s.window, process.platform) })),
    quiet: r.quiet,
  }));
  // Only an error about the role being changed blocks it: a check of its engine that fails as an error, or
  // that couldn't run where it would be one (it needs a check before it that fails or can't tell: nothing says
  // the engine works). profiles.accounts looks at every profile: only this role's own account counts, and a
  // fallback's is a warning there. Warnings (an engine only a fallback uses, FR-009's Codex workers on Windows)
  // and errors about other roles are shown with the result and never keep it from being saved.
  const aboutRole = (r) => r.id !== 'profiles.accounts' || (!row.fallback && !!accountProblem(profile));
  const blocking = results.filter((r) => aboutRole(r) && (r.status === 'fail' ? r.severity === 'error' : r.status === 'skip' && !r.quiet && /^needs /.test(r.detail) && severityOf(byId(r.id), ctx) === 'error'));
  const warnings = results.filter((r) => r.status === 'fail' && r.severity !== 'info' && !blocking.includes(r));
  const daybreakWords = row.role === 'security' ? (config.roles.security.daybreak ? ', Daybreak Blue' : ", standard safeguards (OpenAI's cyber screening may block parts of a scan)") : '';
  const who = `${row.title}: ${profile.name ? `profile ${profile.name} (${engineTitle(profile.engine)})` : engineTitle(profile.engine)}${profile.model ? `, model ${profile.model}` : ''}${profile.effort ? `, effort ${profile.effort}` : ''}${daybreakWords}`;
  const applies = APPLIES[row.role];
  const base = { role: row.key, who, results, applies };
  const said = (list) => list.map((r) => `${r.title}: ${r.detail}`).join('; ');
  const howTo = (list) => list.flatMap((r) => [r.next && `  -> ${r.next}`, ...r.steps.map((s) => `  ${s.label}: ${s.command || s.text}`)]).filter(Boolean);
  const warned = warnings.length ? ` Warning: ${said(warnings)}` : '';
  if (blocking.length) {
    const message = `Not saved: ${said(blocking)}`;
    print({ ok: false, saved: false, message, ...base }, [message, ...howTo(blocking), ...(warned ? [warned.trim(), ...howTo(warnings)] : [])].join('\n'));
    return 1;
  }
  if (a.check) {
    print({ ok: true, saved: false, message: `${who}: the checks pass.${warned}`, ...base }, [`${who}: the checks pass (not saved: --check).${warned}`, ...howTo(warnings)].join('\n'));
    return 0;
  }
  // (the security engineer without a model: the one its Daybreak check found, named, never an alias)
  const pick = row.role === 'security' && !profile.model ? ran.find((r) => r.id === 'security.daybreak')?.pick : '';
  const saved = pick ? withRole(raw, row.role, { ...change, model: pick }) : next;
  let text = formatConfig(saved);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text);
  recordOwner(root, [CONFIG_FILE]); // the owner's change: the guard never holds it (lib/guard.mjs)
  const message = `Saved. ${who}${pick ? `, model ${pick} (the first the scanner's Codex lists for it)` : ''}. It applies ${applies}.${warned}`;
  print({ ok: true, saved: true, message, ...base }, [message, ...howTo(warnings), 'Commit nextlevel.json with your next change.'].join('\n'));
  return 0;
}

// The security engineer off (nextlevel team set security --engine off): no engine, nothing checked. Its Daybreak setting
// stays for the next time it is turned on.
function saveSecurityOff({ root, print, fail }) {
  const file = path.join(root, CONFIG_FILE);
  let raw;
  let crlf;
  try {
    ({ raw, crlf } = readRaw(file));
  } catch (err) {
    return fail(`${CONFIG_FILE} is not valid JSON (${err.message}): fix it first (the Setup page shows it).`);
  }
  const next = withRole(raw, 'security', { engine: '', model: '', effort: '' });
  try {
    loadConfig(root, { raw: next });
  } catch (err) {
    return fail(err.message.replace(/^Settings problem \([^)]*\):\s*/, ''));
  }
  let text = formatConfig(next);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text);
  recordOwner(root, [CONFIG_FILE]);
  const message = 'Saved. The security engineer is off: no scan runs until you turn it on.';
  print({ ok: true, saved: true, message, role: 'security' }, `${message}\nCommit nextlevel.json with your next change.`);
  return 0;
}

// No second worker (nextlevel team set worker-second --engine none): roles.worker.second is null. Tasks sent to it later
// ("Profile: second", --profile second) are refused at dispatch, saying so; queued ones wait for a retry that moves them.
function saveNoSecond({ root, print, fail }) {
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return fail(`${CONFIG_FILE} is missing: nextlevel init makes it.`);
  let raw;
  let crlf;
  try {
    ({ raw, crlf } = readRaw(file));
  } catch (err) {
    return fail(`${CONFIG_FILE} is not valid JSON (${err.message}): fix it first (the Setup page shows it).`);
  }
  const next = withRole(raw, 'worker', { none: true }, { second: true });
  try {
    loadConfig(root, { raw: next });
  } catch (err) {
    return fail(err.message.replace(/^Settings problem \([^)]*\):\s*/, ''));
  }
  let text = formatConfig(next);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text);
  recordOwner(root, [CONFIG_FILE]); // the owner's change: the guard never holds it (lib/guard.mjs)
  const message = 'Saved. No second worker: every task goes to the workers, or where its spec or the orchestrator sends it.';
  print({ ok: true, saved: true, message, role: 'worker-second' }, `${message}\nCommit nextlevel.json with your next change.`);
  return 0;
}

// How a worker's process shows (workers.window, FR-010): no mode shows it; a mode saves it in nextlevel.json. It
// applies to the next task that starts: a running worker keeps the window it has, or has none.
function setWindow(mode, a, { root, loaded, print }) {
  const fail = (message) => {
    print({ ok: false, saved: false, message }, message);
    return 1;
  };
  if (!mode) {
    const w = windowView(loaded.config);
    print({ ok: true, window: w }, `${w.title} (workers.window: ${w.mode}). ${w.choices.find((c) => c.mode === w.mode)?.text || ''}${w.text ? `\n${w.text}` : ''}`);
    return 0;
  }
  if (!WINDOW_MODES.includes(mode)) return fail(`workers.window is ${WINDOW_MODES.join(', ')}, not "${mode}"`);
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return fail(`${CONFIG_FILE} is missing: nextlevel init makes it.`);
  let raw;
  let crlf;
  try {
    ({ raw, crlf } = readRaw(file));
  } catch (err) {
    return fail(`${CONFIG_FILE} is not valid JSON (${err.message}): fix it first (the Setup page shows it).`);
  }
  const next = { ...raw, workers: { ...(raw.workers || {}), window: mode } };
  try {
    loadConfig(root, { raw: next });
  } catch (err) {
    return fail(err.message.replace(/^Settings problem \([^)]*\):\s*/, ''));
  }
  let text = formatConfig(next);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text);
  recordOwner(root, [CONFIG_FILE]);
  const w = windowView(next);
  const env = (loaded.overrides || []).find((k) => /WORKER_WINDOW$/.test(k));
  const message = `Saved: worker windows: ${w.title}. It applies to the next task that starts (running workers go on as they are).${w.text ? ` ${w.text}` : ''}${env ? ` But ${env} is set in this environment, and it wins over nextlevel.json while it is.` : ''}`;
  print({ ok: true, saved: true, message, window: w }, `${message}\nCommit nextlevel.json with your next change.`);
  return 0;
}

// Codex workers' sandbox: no choice shows it; "on" keeps them in it (with its network on), "off" takes them out of it, like
// the other workers. It writes engines.codex.workerArgs as the owner's change (recordOwner): the orchestrator, the setup
// guide and autopilot rounds keep engines.codex.args. It applies to the next task that starts, and the bridge test asks to
// run again for Codex (its verdict is kept with the workers' arguments it ran with).
function setSandbox(choice, a, { root, loaded, print }) {
  const fail = (message) => {
    print({ ok: false, saved: false, message }, message);
    return 1;
  };
  if (!choice) {
    const v = codexWorkersView(loaded.config);
    print({ ok: true, codexWorkers: v }, `Codex workers: ${v.title} (${v.args.join(' ') || 'no arguments'}). ${v.choices.find((c) => c.sandbox === v.sandbox).text}`);
    return 0;
  }
  if (!['on', 'off'].includes(choice)) return fail(`team sandbox is on (in Codex's sandbox) or off (without it), not "${choice}"`);
  // Where Codex workers run is the owner's to say (FR-017: no wall, an agent that clears its variables is taken for the
  // owner; the guard still holds a change to nextlevel.json it didn't record as the owner's)
  const session = agentSession();
  if (session) return fail(ownerOnly(`nextlevel team sandbox ${choice}`, 'The owner chooses it on the dashboard (Team -> Codex workers) or in their own PowerShell window.', session));
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return fail(`${CONFIG_FILE} is missing: nextlevel init makes it.`);
  let raw;
  let crlf;
  try {
    ({ raw, crlf } = readRaw(file));
  } catch (err) {
    return fail(`${CONFIG_FILE} is not valid JSON (${err.message}): fix it first (the Setup page shows it).`);
  }
  if (loaded.error) return fail(loaded.error);
  const workerArgs = codexWorkerArgs(loaded.config, choice === 'on');
  const engines = raw.engines && typeof raw.engines === 'object' ? raw.engines : {};
  const next = { ...raw, engines: { ...engines, codex: { ...(engines.codex || {}), workerArgs } } };
  try {
    loadConfig(root, { raw: next });
  } catch (err) {
    return fail(err.message.replace(/^Settings problem \([^)]*\):\s*/, ''));
  }
  let text = formatConfig(next);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text);
  recordOwner(root, [CONFIG_FILE]); // the owner's change: the guard never holds it (lib/guard.mjs)
  const v = codexWorkersView(next);
  const env = (loaded.overrides || []).includes('CODEX_ARGS') ? " CODEX_ARGS is set in this environment: it changes engines.codex.args, not the workers' own arguments." : '';
  const message = `Saved: Codex workers: ${v.title} (engines.codex.workerArgs: ${workerArgs.join(' ')}). It applies to the next task that starts (running workers go on as they are). The orchestrator keeps engines.codex.args. The rest of engines.codex.args is copied as it is now: a later change to it (a -m, a -c) reaches Codex workers only when you choose here again.${choice === 'off' ? ' Run the bridge test for Codex workers again: nextlevel bridge-test --engine codex.' : ''}${env}`;
  print({ ok: true, saved: true, message, codexWorkers: v }, `${message}\nCommit nextlevel.json with your next change.`);
  return 0;
}

// The tester on or off (the tester's part 4): only tester.enabled changes, as the owner's change (recordOwner); the rest
// of the section (environments, personas, schedules) is the owner's to write, and the guard holds anyone else's change
// to it. No choice: whether it is on, and what it has. The running hub reads it at its next look.
function setTester(choice, a, { root, loaded, print }) {
  const fail = (message) => {
    print({ ok: false, saved: false, message }, message);
    return 1;
  };
  const view = (t) => ({ on: !!t?.enabled, environments: Object.keys(t?.environments || {}), personas: t?.personas || [], schedule: (t?.schedule || []).length });
  if (!choice) {
    const v = view(loaded.config?.tester);
    const has = loaded.config?.tester ? `environments ${v.environments.join(', ') || 'none'}, personas ${v.personas.join(', ') || 'none'}` : 'no tester section in nextlevel.json (docs/acceptance.md shows one)';
    print({ ok: true, tester: v, section: !!loaded.config?.tester }, `Tester: ${v.on ? 'on' : 'off'} (${has}).`);
    return 0;
  }
  if (!['on', 'off'].includes(choice)) return fail(`team tester is on or off, not "${choice}"`);
  const session = agentSession();
  if (session) return fail(ownerOnly(`nextlevel team tester ${choice}`, 'The owner turns it on or off on the dashboard (Team -> Tester) or in their own PowerShell window.', session));
  const file = path.join(root, CONFIG_FILE);
  if (!fs.existsSync(file)) return fail(`${CONFIG_FILE} is missing: nextlevel init makes it.`);
  let raw;
  let crlf;
  try {
    ({ raw, crlf } = readRaw(file));
  } catch (err) {
    return fail(`${CONFIG_FILE} is not valid JSON (${err.message}): fix it first (the Setup page shows it).`);
  }
  if (loaded.error) return fail(loaded.error);
  if (!raw.tester || typeof raw.tester !== 'object' || Array.isArray(raw.tester)) return fail(`${CONFIG_FILE} has no tester section: add one with its environments and personas first (docs/acceptance.md shows one), then turn it on.`);
  const on = choice === 'on';
  if (!!raw.tester.enabled === on) {
    print({ ok: true, saved: false, message: `The tester is already ${choice}.`, tester: view(loaded.config.tester) }, `The tester is already ${choice}.`);
    return 0;
  }
  const next = { ...raw, tester: { ...raw.tester, enabled: on } };
  let checked;
  try {
    checked = loadConfig(root, { raw: next });
  } catch (err) {
    return fail(err.message.replace(/^Settings problem \([^)]*\):\s*/, ''));
  }
  let text = formatConfig(next);
  if (crlf) text = text.replace(/\n/g, '\r\n');
  fs.writeFileSync(file, text);
  recordOwner(root, [CONFIG_FILE]); // the owner's change: the guard never holds it (lib/guard.mjs)
  const message = on
    ? 'Saved: the tester is on. The running hub starts acceptance runs from its next look; nextlevel doctor checks its environments and personas.'
    : 'Saved: the tester is off. A run already going finishes; nothing new starts.';
  print({ ok: true, saved: true, message, tester: view(checked.config.tester) }, `${message}\nCommit nextlevel.json with your next change.`);
  return 0;
}

// The project's GitHub checks on this PC (the self-hosted runner's part A). status: what the Team page's card says, read
// fresh with the owner's gh (GETs only). on: refused for anything but a personal account's private repository, read
// fresh at that moment (never from the cache); for one it is offered for, nothing more yet: the runner is part B.
const ghRun = (args) => runQuiet('gh', args, { timeoutMs: 30000 });
async function runner(what, a, { root, print }) {
  const fail = (message, extra = {}) => {
    print({ ok: false, message, ...extra }, message);
    return 1;
  };
  if (!['status', 'on'].includes(what)) return fail(`team runner is status or on, not "${what}"`);
  let slug;
  if (a.repo) {
    slug = repoSlug(a.repo);
    if (!slug) return fail(`--repo takes owner/name, not "${a.repo}"`);
  } else slug = githubRepo(runQuiet('git', ['config', '--get', 'remote.origin.url'], { cwd: root }).out);
  if (what === 'on') {
    // where the project's checks run is the owner's to say (FR-017: no wall; KNOWN_ISSUES)
    const session = agentSession();
    if (session) return fail(ownerOnly('nextlevel team runner on', 'The owner turns it on on the dashboard (Team -> GitHub checks) or in their own PowerShell window.', session));
    if (!slug) return fail("This project's origin isn't a GitHub repository: there are no GitHub checks to run on this PC.");
    const facts = await readRepoFacts(slug, ghRun, { parts: { collaborators: false, workflows: false, minutes: false } });
    keepFacts(facts);
    const o = offer(facts);
    if (o.state !== 'recommended' && o.state !== 'offered') return fail(`Not turned on: ${o.text}`, { state: o.state, slug });
    // a fork's pull request must never run code on this PC: its workflows off, read at this moment (runner.forks)
    if (!facts.forks) return fail(`Not turned on: nextlevel can't read the fork pull request settings of ${slug} (${facts.forksError || 'no answer'}).`, { state: 'forks', slug });
    if (facts.forks.run) return fail(`Not turned on: workflows from fork pull requests are on for ${slug}: turn them off first (Setup -> Fork pull requests).`, { state: 'forks', slug });
    const view = { slug, state: o.state, setUp: false };
    const message = `${slug} is a personal account's private repository, so its checks can run on this PC. Setting the runner up comes in a later version of nextlevel (the design's part B): nothing was changed.`;
    print({ ok: true, message, ...view }, message);
    return 0;
  }
  const facts = slug ? await repoFacts(slug, ghRun, { fresh: true }) : null;
  const v = checksView(slug, facts);
  if (a.json) return print({ ok: true, githubChecks: v }, ''), 0;
  const out = [`GitHub checks${v.slug ? ` (${v.slug})` : ''}: ${v.title}`, `  ${v.text}`];
  if (v.where) out.push(`  Where they run now: ${v.where}`);
  if (v.minutes) out.push(`  ${v.minutes}`);
  for (const j of v.jobs) out.push(`  ${j.file}: ${j.job} on ${j.runsOn}${j.stays ? ` (stays on GitHub by default: ${j.why})` : ''}`);
  for (const n of v.notes) out.push(`  ${n.kind === 'error' ? 'Error' : 'Warning'}: ${n.text}`);
  if (v.later) out.push(`  ${v.later}`);
  console.log(out.join('\n'));
  return 0;
}
