// The engines' CLIs, sign-ins and settings: Codex (FR-001 #5, #6), Antigravity (FR-001 #4) and
// Claude Code (FR-001 #7, FR-002), for every account the roles' profiles use (M6), and whether an engine
// can keep a second account apart at all (profiles.accounts).
import os from 'node:os';
import { agyFailure, agyResult } from '../engines/agy.mjs';
import { clockIso, clockNow } from '../lib/clock.mjs';
import { parseEnvText } from '../lib/envfile.mjs';
import { redactReport, reportSecrets } from '../lib/redact.mjs';
import { KEY_LIMIT, KEY_PROMPT, runKey, workerRun } from '../lib/workerspec.mjs';
import { SANDBOX_BLOCKS, codexMcpServers as mcpServers } from '../engines/codex.mjs';
import { accessFacts } from './argon.mjs';
import { ADAPTERS, accountDir, accountProblem, fullAccessNote, profileEnv, readJsonText, withoutOption, workerCaveat, workerIsolation } from '../engines/index.mjs';
import { formatConfig, roleProfile, workerArgsOf } from '../lib/config.mjs';
import { advisorIndependent } from '../lib/team.mjs';
import { RUN_CACHE_MS } from '../lib/proc.mjs';
import { plainText } from '../lib/workerlog.mjs';
import { codexHooksCheck } from './codex-hooks.mjs';
import { fail, firstLine, parseVersion, pass, step, tomlTop, versionAtLeast, versionText } from './lib.mjs';
import { TOOLS, toolCheck } from './tools.mjs';

const needsProject = (ctx) => (ctx.root ? null : 'no project');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// How much an engine matters here: a role runs on it (error), only a fallback does (warn), none (info).
export const engineSeverity = (name) => (ctx) => ({ role: 'error', fallback: 'warn' }[ctx.usage(name)] || 'info');

// The advisor (docs/design/advisor.md): whether it runs on another engine than the orchestrator, so it can disagree with
// it (information: a one-engine owner is fine). Its automatic choice is no role in nextlevel.json, so no sign-in row
// covers its engine when no role uses it: then this check signs it in too (a warning, with the engine's login command).
const ADVISOR_LOGIN = { claude: ['claude auth login', 'it opens the browser: sign in with your Claude account'], codex: ['codex login', 'it opens the browser; sign in with your ChatGPT account'] };
export const advisorCheck = {
  id: 'advisor.independent',
  title: 'Advisor',
  severity: 'info',
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#advisorindependent',
  run(ctx) {
    const p = roleProfile(ctx.config, 'assistant', { available: (e) => !!ctx.which(ADAPTERS[e].command) });
    if (!p) return pass('no advisor in nextlevel.json', { quiet: true });
    const ind = advisorIndependent(ctx.config, p);
    const on = `${ADAPTERS[p.engine].title}${p.auto ? ' (automatic)' : ''}`;
    if (p.auto && !ctx.uses(p.engine) && ADVISOR_LOGIN[p.engine]) {
      const eng = ADAPTERS[p.engine];
      // (no read-only engine installed: the automatic choice falls back to one that isn't there)
      if (!ctx.which(eng.command)) {
        const how = TOOLS[p.engine].install(ctx);
        return fail(`the advisor runs on ${on}, which no other role uses, and it isn't installed`, { severity: 'warn', next: 'install it, or choose another engine for the advisor on the Team page', steps: [how.command ? step('terminal', how.command) : step('terminal', null, { text: how.text })] });
      }
      const r = eng.loginResult(ctx.run(eng.command, eng.login.status, { cacheMs: RUN_CACHE_MS, timeoutMs: 30000 }));
      if (!r.ok) {
        const [command, text] = ADVISOR_LOGIN[p.engine];
        return fail(`the advisor runs on ${on}, which no other role uses, and it isn't signed in: ${r.detail}`, { severity: 'warn', next: 'sign it in, or choose another engine for the advisor on the Team page', steps: [step('terminal', command, { text })] });
      }
    }
    return pass(`on ${on}. ${ind.text}`);
  },
};

// The accounts of an engine that the roles' profiles use, as the first profile on each ('' first: the
// engine's own login). None in use: its own login. An account the engine can't keep apart is left to
// profiles.accounts.
function accounts(ctx, name) {
  const found = new Map();
  for (const p of ctx.profiles) if (p.engine === name && !accountProblem(p) && !found.has(p.account)) found.set(p.account, p);
  if (!found.size) found.set('', { name: '', engine: name, account: '', model: '' });
  return [...found.values()].sort((a, b) => (a.account ? 1 : 0) - (b.account ? 1 : 0));
}
// How a command runs for an account: in its own folder (profileEnv), or as it is for the engine's own login.
const forAccount = (ctx, p) => (p.account ? { env: profileEnv(ctx.env, p, { home: ctx.home, path: ctx.path }) } : {});
const accountLabel = (p) => (p.account ? `account ${p.account} (profile ${p.name})` : 'its own login');
// Sign an account in: the CLI's own command for its own login, nextlevel login for a named one.
const signInStep = (ctx, p, own) => (p.account ? step('terminal', `nextlevel login ${p.name}`, { cwd: ctx.root || undefined, text: ADAPTERS[p.engine].login.signInText }) : own);

// Models pinned in nextlevel.json for an engine's account: a role's own model, a profile's or a fallback's.
// [{ model, where, set }]: where it is set, and what to write there to use the engine's own choice.
const unset = (key) => {
  const parts = key.split('.').slice(0, -1);
  return parts.reduceRight((inner, k) => `{ "${k}": ${inner} }`, '{ "model": "" }').replace(/^\{ (.*) \}$/, '$1');
};
function pinned(ctx, name, account = '') {
  const out = [];
  for (const p of ctx.profiles) {
    const where = p.keys?.model;
    if (p.engine !== name || (p.account || '') !== account || !p.model || !where || out.some((o) => o.where === where)) continue;
    out.push({ model: p.model, where, set: unset(where) });
  }
  return out;
}

// The sign-in of every account an engine's profiles use: the engine's own command, run with each account's
// folder. [{ p, r }], r: the adapter's loginResult.
// A sign-in that is there is kept a few minutes (FR-010: the dashboard checks again whenever its page comes back into
// view, and each time agy or Codex started again); doctor --fresh and Check again ask again.
const logins = (ctx, name, opts = {}) =>
  accounts(ctx, name).map((p) => ({ p, r: ADAPTERS[name].loginResult(ctx.run(ADAPTERS[name].command, ADAPTERS[name].login.status, { cacheMs: RUN_CACHE_MS, ...opts, ...forAccount(ctx, p) })) }));
function loginResult(ctx, list, ownStep) {
  const bad = list.filter(({ r }) => !r.ok);
  const one = list.length === 1 && !list[0].p.account;
  if (!bad.length) return pass(one ? list[0].r.detail : list.map(({ p, r }) => `${accountLabel(p)}: ${r.detail}`).join('; '));
  const detail = one ? bad[0].r.detail : bad.map(({ p, r }) => `${accountLabel(p)}: ${r.detail}`).join('; ');
  return fail(detail, { ...(bad.every(({ r }) => r.unknown) ? { severity: 'warn' } : {}), steps: bad.map(({ p }) => signInStep(ctx, p, ownStep)) });
}

// ---------- Codex ----------
// A one-line prompt that costs next to nothing; the answer is kept until the model, Codex or the login changes.
export const MODEL_PROBE = 'nextlevel model check: reply with the single word ok and nothing else.';
function errorLine(out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines.reverse().find((l) => /error|not supported|invalid|unknown|not found|denied/i.test(l)) || lines[0] || 'rejected').slice(0, 300);
}

// Codex's own folder: $CODEX_HOME, else ~/.codex (config.toml, version.json, hooks, plugins); a named
// account's is its own (~/.nextlevel/accounts/codex/<account>).
export const codexHome = (ctx, account = '') => (account ? accountDir(ctx.home, 'codex', account, ctx.path) : ctx.env.CODEX_HOME || ctx.path.join(ctx.home, '.codex'));
export { tomlTop } from './lib.mjs'; // a top-level `key = "value"` of a TOML text

// Whether the model Codex will use works with this Codex login: each model pinned for a Codex role
// (nextlevel passes it with -m), else Codex's own, which is `model` in its config.toml or, without one,
// the first model the account's list offers. Codex's own model was rejected on a real PC while
// the doctor said "Codex's own choice" (FR-004 #3), so it is tried too. Also run by the hub before it
// starts an orchestrator session, so a rejected name stops with the fix instead of a failing session.
export const codexModelCheck = {
  id: 'codex.model',
  title: 'Codex model',
  sandbox: 'skip', // needs the network, and its answer is cached
  requires: ['tool.codex', 'codex.login'],
  learnMore: 'docs/CHECKS.md#codexmodel',
  run(ctx) {
    // What to try, per account: each model pinned for it, else Codex's own (its config.toml's, or the account's default)
    const targets = [];
    for (const p of accounts(ctx, 'codex')) {
      const acc = p.account ? `, account ${p.account}` : '';
      const file = ctx.path.join(codexHome(ctx, p.account), 'config.toml');
      const own = tomlTop(ctx.read(file), 'model');
      const list = pinned(ctx, 'codex', p.account);
      if (list.length) targets.push(...list.map((x) => ({ ...x, p, label: `"${x.model}" (${x.where})` })));
      else targets.push({ model: '', own, p, file, label: own ? `Codex's own model "${own}"${acc} (model in ${file})` : `the account's default model${acc} (no model in Codex's config.toml)` });
    }
    const version = firstLine(ctx.run('codex', ['--version']).out);
    const seen = ctx.cache.get('codex.model') || {};
    for (const t of targets) {
      const run = forAccount(ctx, t.p);
      const id = `${t.model || `own:${t.own || ''}`} | ${t.p.account} | ${version} | ${firstLine(ctx.run('codex', ['login', 'status'], { cacheMs: RUN_CACHE_MS, ...run }).out)}`;
      let v = seen[id];
      if (!v) {
        const r = ctx.run('codex', ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', ...(t.model ? ['-m', t.model] : []), MODEL_PROBE], {
          timeoutMs: 120_000,
          cwd: ctx.tmpDir || os.tmpdir(), // not the project: its AGENTS.md is for real sessions
          ...run,
        });
        if (r.timedOut) return fail(`${t.label}: no answer from Codex in 2 min, so not checked`, { severity: 'warn' });
        v = { ok: r.ok, error: r.ok ? '' : errorLine(r.out), at: new Date().toISOString() };
        ctx.cache.set('codex.model', { ...(ctx.cache.get('codex.model') || {}), [id]: v });
      }
      if (v.ok) continue;
      if (t.where) {
        return fail(`${t.label} was rejected: ${v.error}`, {
          pinned: true,
          next: 'leave the model empty to use the one picked with /model inside Codex, or copy an exact name from there',
          steps: [
            step('editor', null, { text: `in nextlevel.json set ${t.set}` }),
            step('codex', '/model', { text: 'to see the names this account can use' }),
          ],
        });
      }
      return fail(`${t.label} was rejected: ${v.error}`, {
        next: 'give Codex a model this login can use (a newer Codex knows newer models: see "Codex version")',
        steps: [
          step('codex', '/model', { text: 'to see the names this account can use' }),
          step('editor', null, { text: t.own ? `in ${t.file} change model = "${t.own}" to one of those names, or delete that line` : `in ${t.file} add a line model = "<a name /model shows>"` }),
        ],
      });
    }
    const named = targets.some((t) => t.p.account);
    const pins = targets.filter((t) => t.where);
    const owns = targets.filter((t) => !t.where);
    const parts = [
      pins.length && `${[...new Set(pins.map((t) => t.model))].join(', ')} (accepted by ${named ? 'their' : 'this'} Codex login${named ? 's' : ''})`,
      ...owns.map((t) => (t.own ? `Codex's own "${t.own}"${t.p.account ? ` for account ${t.p.account}` : ''} (from its config.toml; accepted by this login)` : `the account's default${t.p.account ? ` for account ${t.p.account}` : ''} (accepted by this login)`)),
    ].filter(Boolean);
    return pass(parts.join('; '));
  },
};

// Codex against its latest release (FR-004 #3: Codex CLI 0.152 couldn't use GPT-6 models). The latest
// comes from Codex's own update check ($CODEX_HOME/version.json, refreshed by Codex every 20 h) while it
// is under 3 days old, else from npm (kept a day).
export const DAY = 24 * 3_600_000;
function latestCodex(ctx) {
  let own = null;
  try {
    own = JSON.parse(ctx.read(ctx.path.join(codexHome(ctx), 'version.json')) || 'null');
  } catch {
    // not there, or half written
  }
  if (own?.latest_version && Date.now() - Date.parse(own.last_checked_at) < 3 * DAY) return { version: own.latest_version };
  const kept = ctx.cache.get('codex.latest');
  if (kept?.version && Date.now() - Date.parse(kept.at) < DAY) return kept;
  const r = ctx.run('npm', ['view', '@openai/codex', 'version'], { timeoutMs: 30_000 });
  const version = r.ok && parseVersion(firstLine(r.out)) ? firstLine(r.out) : null;
  if (!version) return { why: r.missing ? 'npm not found' : r.timedOut ? 'no answer from npm in 30 s' : 'npm view @openai/codex failed' };
  ctx.cache.set('codex.latest', { version, at: new Date().toISOString() });
  return { version };
}
export const codexVersionCheck = {
  id: 'codex.version',
  title: 'Codex version',
  severity: 'warn',
  sandbox: 'skip', // needs the network
  requires: ['tool.codex'],
  learnMore: 'docs/CHECKS.md#codexversion',
  run(ctx) {
    const have = parseVersion(ctx.run('codex', ['--version']).out);
    const latest = latestCodex(ctx);
    if (!have) return pass('unknown (codex --version printed no version)');
    if (!latest.version) return pass(`${versionText(have)} (the latest release couldn't be checked: ${latest.why})`);
    if (versionAtLeast(have, latest.version)) return pass(`${versionText(have)}, the latest release`);
    const how = TOOLS.codex.update(ctx);
    return fail(`${versionText(have)}, and ${latest.version} is out: an older Codex doesn't know the newer models (0.152 couldn't use GPT-6)`, {
      next: 'update it',
      steps: [step('terminal', how.command), step('new-terminal', 'nextlevel doctor', { cwd: ctx.root || undefined, text: 'to check again' })],
    });
  },
  fixPrompt: (r, ctx) => `Update the Codex CLI (${TOOLS.codex.update(ctx).command})?`,
  fix(ctx, ui) {
    const [file, args, opts] = TOOLS.codex.update(ctx).run;
    ui.run(file, args, { shell: !!opts?.shell && ctx.platform === 'win32' });
    ctx.cache.set('codex.latest', null);
    ui.say('If Codex still shows as old below, open a new PowerShell window and run nextlevel doctor there.');
  },
  fixInWindow: true, // npm install -g: the owner's own window
};

// Codex arguments without the ones that override its settings: -c key=value, --config key=value,
// --config=key=value, -ckey=value. { kept, dropped }
export function withoutOverrides(args) {
  const kept = [];
  const dropped = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '-c' || a === '--config') {
      dropped.push([a, args[i + 1]].filter((x) => x !== undefined).join(' '));
      i++;
    } else if (a.startsWith('--config=') || /^-c[^-]/.test(a)) dropped.push(a);
    else kept.push(a);
  }
  return { kept, dropped };
}

// The Codex config's MCP servers (engines/codex.mjs): one that can't start makes Codex warn on every start, which looks
// like our failure but isn't (FR-001 #6).
export { mcpServers };

export const codexChecks = [
  toolCheck('codex', { severity: engineSeverity('codex') }),
  codexVersionCheck,
  {
    id: 'codex.login',
    title: 'Codex sign-in',
    severity: engineSeverity('codex'),
    requires: ['tool.codex'],
    learnMore: 'docs/CHECKS.md#codexlogin',
    run(ctx) {
      return loginResult(ctx, logins(ctx, 'codex'), step('terminal', 'codex login', { text: 'it opens the browser; sign in with your ChatGPT account' }));
    },
  },
  {
    id: 'codex.installs',
    title: 'Codex installs',
    severity: 'info',
    requires: ['tool.codex'],
    learnMore: 'docs/CHECKS.md#codexinstalls',
    run(ctx) {
      const all = ctx.which('codex')?.all || [];
      if (all.length <= 1) return pass('one', { quiet: true });
      return fail(`${all.length} found`, { next: `using ${all[0]}; if autopilot fails with a sandbox helper error, keep one install` });
    },
  },
  {
    id: 'codex.sandbox',
    title: 'Codex sandbox',
    sandbox: 'same', // the project only
    skipIf: (ctx) => needsProject(ctx) || (!ctx.uses('codex') && 'no role uses Codex'),
    learnMore: 'docs/CHECKS.md#codexsandbox',
    run(ctx) {
      const args = ctx.config.engines.codex.args;
      const text = args.join(' ');
      const how = [step('editor', null, { text: 'in nextlevel.json set "engines": { "codex": { "args": ["--sandbox", "workspace-write"] } }' })];
      // The orchestrator only thinks: the hub pushes, runs Docker and sends notifications for it.
      if (/danger-full-access|--dangerously-bypass-approvals-and-sandbox|--yolo\b/.test(text)) {
        return fail('engines.codex.args turn the sandbox off: the orchestrator never needs full access', { steps: how });
      }
      const i = args.findIndex((a) => a === '--sandbox' || a === '-s');
      const mode = i >= 0 ? args[i + 1] : (args.find((a) => a.startsWith('--sandbox=')) || '').split('=')[1];
      if (mode !== 'workspace-write') {
        return fail(`sandbox is ${mode || 'not set (codex exec is read-only then)'}: the orchestrator can't write plans and task files`, { severity: 'warn', steps: how });
      }
      return pass('workspace-write (the project only)');
    },
  },
  {
    // FR-004 #6: with a -c override Codex runs without its shared background server, and says so at every
    // start. nextlevel's own defaults had one (network for the sandbox) until then.
    id: 'codex.args',
    title: 'Codex overrides',
    sandbox: 'same', // the project only
    severity: 'warn',
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#codexargs',
    run(ctx) {
      const { kept, dropped } = withoutOverrides(ctx.config.engines.codex.args);
      if (!dropped.length) return pass('none', { quiet: true });
      const why = `Codex then runs without its shared background server and warns about it at every start`;
      if ((ctx.configInfo.overrides || []).includes('CODEX_ARGS')) {
        return fail(`CODEX_ARGS overrides Codex's settings (${dropped.join(', ')}): ${why}`, {
          fromEnv: true,
          steps: [step('editor', null, { text: 'remove the -c part from CODEX_ARGS in .env (better: delete CODEX_ARGS; nextlevel.json has the arguments)' })],
        });
      }
      return fail(`engines.codex.args override Codex's settings (${dropped.join(', ')}): ${why}`, {
        next: 'the orchestrator needs no network: the hub pushes, installs and notifies for it',
        kept,
        dropped,
        steps: [step('editor', null, { text: `in nextlevel.json set "engines": { "codex": { "args": ${JSON.stringify(kept)} } }` })],
      });
    },
    fixPrompt: (r) => `Remove ${r.dropped.join(', ')} from engines.codex.args in nextlevel.json?`,
    canFix: (r, ctx) => !r.fromEnv && !!ctx.configInfo.exists,
    fix(ctx, ui) {
      const file = ctx.configInfo.file;
      let raw;
      try {
        raw = JSON.parse((ctx.read(file) || '').replace(/^\uFEFF/, ''));
      } catch {
        return ui.say(`${file} is not valid JSON; not touching it.`);
      }
      const args = raw?.engines?.codex?.args;
      if (!Array.isArray(args) || !withoutOverrides(args).dropped.length) return ui.say(`engines.codex.args in ${file} has no -c: it comes from somewhere else (CODEX_ARGS?).`);
      const { kept, dropped } = withoutOverrides(args);
      raw.engines.codex.args = kept;
      ctx.write(file, formatConfig(raw));
      ctx.config.engines.codex.args = kept; // what the check sees when it runs again
      ui.say(`Removed ${dropped.join(', ')} from engines.codex.args in ${file}. Commit it with your next change.`);
    },
  },
  { ...codexModelCheck, severity: engineSeverity('codex') },
  {
    // FR-009: a Codex worker on Windows blocked on a real task: its sandbox denies the Docker pipe,
    // ~/.docker/config.json and pnpm's store in the owner's AppData, network or not. The Team page's switch takes Codex
    // workers out of it (engines.codex.workerArgs); until then this says which tasks fail there.
    id: 'codex.worker-windows',
    title: 'Codex as a worker on Windows',
    sandbox: 'same', // nextlevel.json only
    severity: 'warn',
    platforms: ['win32'],
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#codexworker-windows',
    run(ctx) {
      // (the workers' own arguments: engines.codex.workerArgs, else args)
      const args = workerArgsOf(ctx.config, 'codex');
      const key = Array.isArray(ctx.config.engines.codex.workerArgs) ? 'engines.codex.workerArgs' : 'engines.codex.args';
      const on = ctx.profiles.filter((p) => p.role === 'worker' && p.engine === 'codex' && workerCaveat(p, ctx.platform, args));
      if (!on.length) return pass(ctx.profiles.some((p) => p.role === 'worker' && p.engine === 'codex') ? `Codex's sandbox is off for its workers (${key})` : 'no worker runs on Codex', { quiet: true });
      const who = [...new Set(on.map((p) => (p.second ? 'the second worker' : p.fallback ? "the workers' fallback" : 'the workers')))].join(' and ');
      const workers = ctx.profiles.find((p) => p.role === 'worker' && !p.fallback && !p.second);
      const cwd = ctx.root || undefined;
      // Or, for a fallback: a stronger model on the workers' own engine (for Antigravity, a Claude model it lists); for
      // workers on Codex themselves: another engine
      const other =
        workers && workers.engine !== 'codex'
          ? [step('terminal', `nextlevel team set worker-fallback --engine ${workers.engine} --model <model>`, { cwd, text: `or a fallback on ${ADAPTERS[workers.engine].title} with a stronger model than the workers' own${workers.engine === 'agy' ? ' (a Claude one)' : ''}: nextlevel team models ${workers.engine} lists them; or Team -> Fallback worker -> Change` })]
          : [step('terminal', 'nextlevel team set worker --engine agy', { cwd, text: 'or workers on Antigravity (or --engine claude); or on the dashboard: Team -> Workers -> Change' })];
      return fail(`${who} ${who === "the workers' fallback" ? 'runs' : 'run'} on Codex in its sandbox: on Windows a worker there is refused ${SANDBOX_BLOCKS}, and turning its network on doesn't change that`, {
        next: 'those tasks block on a Codex worker in its sandbox: take Codex workers out of it, like your other workers (Docker, pnpm and git work, in a slot of their own where git refuses pushes), or send those tasks to another engine',
        steps: [
          step('terminal', 'nextlevel team sandbox off', { cwd, text: "Codex workers without Codex's sandbox; or on the dashboard: Team -> Codex workers. Then run the bridge test again (nextlevel bridge-test --engine codex)" }),
          ...other,
        ],
      });
    },
  },
  {
    id: 'codex.mcp',
    title: 'Codex MCP servers',
    severity: 'info',
    requires: ['tool.codex'],
    learnMore: 'docs/CHECKS.md#codexmcp',
    run(ctx) {
      const file = ctx.path.join(ctx.env.CODEX_HOME || ctx.path.join(ctx.home, '.codex'), 'config.toml');
      const servers = mcpServers(ctx.read(file)).filter((s) => s.enabled && s.command);
      const found = (cmd) => (/[\\/]/.test(cmd) ? ['', '.exe', '.cmd'].some((x) => ctx.exists(cmd + x)) : !!ctx.which(cmd));
      const broken = servers.filter((s) => !found(s.command));
      if (!broken.length) return pass(servers.length ? `${servers.length} set up, all can start` : 'none set up', { quiet: !servers.length });
      return fail(`${broken.map((s) => `"${s.name}" (${s.command} not found)`).join(', ')}: Codex warns about this on every start; it isn't nextlevel's problem`, {
        steps: broken.map((s) => step('editor', null, { text: `remove or fix [mcp_servers.${s.name}] in ${file}` })),
      });
    },
  },
  codexHooksCheck,
];

// ---------- Antigravity ----------
const agyUsed = engineSeverity('agy');

// ---------- the model trial: exactly what a worker runs (FR-022) ----------
// On a real project, after agy updated itself to 1.3.4, the trial failed with nothing but "ERROR" while it ran another command
// than a worker's (the doctor's environment with the project's .env, through cmd.exe). Now the trial is built by the
// function that builds a worker's run (lib/workerspec.mjs workerRun): the same arguments, launcher, environment (a
// worker's: no .env) and agent file, differing only in the prompt (the probe), the limit (2 minutes) and the folder (a
// temp folder: the folder made no difference on 1.3.5, docs/KNOWN_ISSUES.md). Its answer is kept under a key made from
// that whole run and agy's version (lib/workerspec.mjs runKey), in .nextlevel/check-cache.json, where the hub reads it
// before it starts a task on agy: a pass until something in the run changes, a refusal an hour (a plan or a quota can
// change), no answer ten minutes. Check again, doctor --fresh and a Team page save try again at once.
// The probe asks for what a worker does, a file written and a command run (FR-022: on 1.3.5 the worker's agent had only
// tools that look, and a probe that only asked for "ok" passed while every worker answered BLOCKED); one line.
export const AGY_CHECK_FILE = 'nextlevel-check.txt';
export const AGY_PROBE = `nextlevel model check: write the word ok to the file ${AGY_CHECK_FILE} in this folder with your file tool, run the command node --version, then reply with the single word ok.`;
// What a run did of that, from agy's own steps (its stream-json): { wrote, ran, used } (used: the tools it called)
const WRITES = new Set(['write_to_file', 'replace_file_content', 'multi_replace_file_content']);
export function agyAbilities(text) {
  const used = new Set();
  let wrote = false;
  let ran = false;
  for (const line of String(text || '').split(/\r?\n/)) {
    const s = line.includes('"step_update"') ? readJsonText(line)?.step_update : null;
    if (s?.step_type !== 'tool') continue;
    const name = String(s.tool_name || s.tool_info?.name || '');
    if (name) used.add(name);
    if (s.state !== 'DONE') continue;
    if (WRITES.has(name)) wrote = true;
    if (name === 'run_command') ran = true;
  }
  return { wrote, ran, used: [...used] };
}
export const TRIALS = 'agy.trials';
const PASSED = 'agy.passed';
export const TRIAL_REFUSAL_MS = 3_600_000;
export const TRIAL_NO_ANSWER_MS = 10 * 60_000;
const TRIAL_TIMEOUT_MS = 150_000;
export const agyVersion = (ctx) => firstLine(ctx.run('agy', ['--version']).out);
// "on agy 1.3.5"
const versionWords = (v) => (v ? `on agy ${parseVersion(v) ? versionText(parseVersion(v)) : v}` : 'on agy (version unknown)');
const versionShort = (v) => (parseVersion(v) ? versionText(parseVersion(v)) : v || '');
// The .env's names whose values this process has: a worker never gets them (lib/workerspec.mjs)
const dotenvOf = (ctx) => {
  const kv = ctx.root ? parseEnvText(ctx.read(ctx.path.join(ctx.root, '.env'))) : {};
  return Object.keys(kv).filter((k) => ctx.env[k] === kv[k]);
};
// A command line as a person reads it: the probe shortened, an argument with spaces in quotes
const shownArgs = (args) =>
  args
    .map((a, i) => (args[i - 1] === '-p' ? `"${a.length > 24 ? `${a.slice(0, 22)}…` : a}"` : /[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a))
    .join(' ');
// What --effort in engines.agy.args comes to: nothing, and why (FR-010, FR-022)
export function effortNote(args = []) {
  const i = args.findIndex((a) => a === '--effort' || String(a).startsWith('--effort='));
  if (i < 0) return '';
  const value = args[i] === '--effort' ? args[i + 1] || '' : args[i].slice(9);
  return ` engines.agy.args also has --effort ${value}: not passed, since Antigravity takes the level from the model's name (nextlevel doctor --fix agy.effort takes it out)`;
}

// The trial for one profile on agy: { run (workerRun's, with the probe), key, version, folder, shown }. `version`: agy's,
// when the caller has it (the hub keeps it per program file).
export function agyTrialSpec(ctx, profile, { version = agyVersion(ctx) } = {}) {
  const common = {
    profile,
    engineArgs: workerArgsOf(ctx.config, 'agy'), // (what an agy worker gets: engines.agy.workerArgs, else args)
    addons: ctx.config.workers.addons,
    addonCtx: { home: ctx.home, env: ctx.env, read: ctx.read, list: ctx.list, path: ctx.path },
    env: ctx.env,
    dotenv: dotenvOf(ctx),
    home: ctx.home,
    version, // (after 1.3.2 the worker's agent lists its tools: the same file the worker gets)
    asIs: true, // (the probe itself, without the worker's "read AGENTS.md first": there is no project in the trial's folder)
  };
  const run = workerRun({ ...common, prompt: AGY_PROBE, timeoutMin: 2 });
  const key = runKey(workerRun({ ...common, prompt: KEY_PROMPT, timeoutMin: KEY_LIMIT }), { version, bin: ctx.which('agy')?.file || '' });
  const folder = ctx.path.join(ctx.tmpDir || os.tmpdir(), 'nextlevel-agy-trial');
  const how = ctx.platform === 'win32' ? ', in a console with no window' : ', headless';
  return { run, key, version, folder, model: run.model, shown: `agy ${shownArgs(run.args)}, in ${folder}${how}` };
}

// What is redacted from what agy prints about a failure: what reports never contain (the .env's values and names, secret
// variables, the home folder) and every string in the owner's MCP servers' settings (FR-022)
export function trialRedactor(ctx) {
  const s = reportSecrets(ctx);
  let mcp = [];
  try {
    mcp = ADAPTERS.agy.secretStrings({ home: ctx.home, read: ctx.read, path: ctx.path });
  } catch {
    // a file that can't be read holds nothing to redact
  }
  const values = [...new Set([...s.values, ...mcp])];
  return (text) => redactReport(text, { values, names: s.names, home: ctx.home, platform: ctx.platform });
}

// The answer kept for a run's key, or null
export const keptTrial = (ctx, key) => (ctx.cache.get(TRIALS) || {})[key] || null;
// Whether a kept answer still stands: a pass until the run changes; a refusal an hour; no answer ten minutes (`retry`:
// a refusal is tried again now)
export function trialStands(v, { now = clockNow(), retry = false } = {}) {
  if (!v) return false;
  if (v.ok) return true;
  if (retry) return false;
  const age = now - (Date.parse(v.at) || 0);
  return age >= 0 && age < (v.timedOut ? TRIAL_NO_ANSWER_MS : TRIAL_REFUSAL_MS);
}

// Runs the trial (or takes the answer kept for it): { ok, reason, code, status, last, timedOut, noConsole, version, at,
// model, shown, kept }. A refusal's reason and last lines are redacted (trialRedactor). `retry`: a kept refusal is tried
// again (a Team page save); ctx.fresh: anything kept is.
export function agyTrial(ctx, spec, { retry = false } = {}) {
  const kept = ctx.fresh ? null : keptTrial(ctx, spec.key);
  if (trialStands(kept, { retry })) return { ...kept, kept: true };
  for (const f of spec.run.files) ctx.write(ctx.path.join(spec.folder, ...f.path), f.text);
  const checkFile = ctx.path.join(spec.folder, AGY_CHECK_FILE);
  ctx.write(checkFile, ''); // (what an earlier trial wrote isn't this one's)
  const r = ctx.runConsole('agy', spec.run.args, { timeoutMs: TRIAL_TIMEOUT_MS, cwd: spec.folder, env: spec.run.env, direct: true });
  if (r.noConsole) {
    // (kept, as a refusal is: the hub then lets tasks start as before, in a window of their own, without a trial at every
    // tick; review of FR-022)
    const v = { ok: false, noConsole: true, reason: r.out, code: null, version: spec.version, model: spec.model, at: clockIso() };
    ctx.cache.set(TRIALS, { ...(ctx.cache.get(TRIALS) || {}), [spec.key]: v });
    return v;
  }
  const result = agyResult(r.out);
  // (strict: a run that asked for its result as JSON must end with one that says SUCCESS)
  const json = spec.run.args.some((a, i) => (a === '--output-format' && /json/.test(spec.run.args[i + 1] || '')) || /^--output-format=.*json/.test(a));
  const ran = r.ok && !r.timedOut && (result ? result.ok : !json);
  // ...and it did what a worker does: wrote a file with one of its tools and ran a command (FR-022)
  const did = agyAbilities(r.out);
  const wrote = did.wrote || /^ok$/i.test(String(ctx.read(checkFile) || '').trim());
  const able = wrote && did.ran;
  const ok = ran && able;
  const clean = trialRedactor(ctx);
  const f = agyFailure(r.out, { code: r.code });
  const unable = `agy ran, but its worker agent ${!wrote && !did.ran ? 'wrote no file and ran no command' : !wrote ? 'wrote no file' : 'ran no command'}, so a worker on it can't do a task (the tools it used: ${did.used.join(', ') || 'none'})${result?.response?.trim() ? `. It said: ${firstLine(result.response)}` : ''}`;
  const reason = ok ? '' : r.timedOut ? `no answer in ${TRIAL_TIMEOUT_MS / 60_000} min` : ran && !able ? unable : f.reason || (r.out.trim() ? errorLine(plainText(r.out)) : r.code === null ? 'it gave no answer' : 'it printed nothing');
  const v = {
    ok,
    reason: clean(reason),
    code: r.code ?? null,
    status: result?.status || '',
    last: ok ? [] : f.last.map(clean),
    timedOut: !!r.timedOut,
    version: spec.version,
    model: spec.model,
    shown: clean(spec.shown),
    at: clockIso(),
  };
  ctx.cache.set(TRIALS, { ...(ctx.cache.get(TRIALS) || {}), [spec.key]: v });
  return v;
}

// The version a model last passed on, and noting a pass (the message names both versions when agy changed)
const passedKey = (t, own) => t.model || `own:${own}`;
const passedOn = (ctx, t, own) => versionShort((ctx.cache.get(PASSED) || {})[passedKey(t, own)]?.version || '');
function notePassed(ctx, t, own, version) {
  const all = ctx.cache.get(PASSED) || {};
  if (all[passedKey(t, own)]?.version === version) return;
  ctx.cache.set(PASSED, { ...all, [passedKey(t, own)]: { version, at: clockIso() } });
}
export const agyChecks = [
  toolCheck('agy', { severity: agyUsed }),
  {
    id: 'agy.login',
    title: 'Antigravity sign-in',
    severity: agyUsed,
    requires: ['tool.agy'],
    learnMore: 'docs/CHECKS.md#agylogin',
    run(ctx) {
      const r = ADAPTERS.agy.loginResult(ctx.run('agy', ['models'], { timeoutMs: 30000, cacheMs: RUN_CACHE_MS }));
      if (r.ok) return pass(r.detail);
      return fail(r.detail, {
        next: 'run agy once in a terminal and sign in; pick a model with /model',
        steps: [step('terminal', 'agy', { text: 'sign in with the account whose plan the workers use' }), step('agy', '/model', { text: 'pick the strongest model you have for coding' })],
      });
    },
  },
  {
    // A pinned model must be one `agy models` lists; then the exact model and flags a worker gets are tried with a
    // one-line prompt, headless (in a console with no window on Windows, as a worker runs), once per model, flags and
    // agy version (FR-010: agy refused "--effort is not supported for model claude-opus-4-6-thinking" in every
    // worker's attempt). Also what the Team page runs before it saves a change to a role on Antigravity.
    id: 'agy.model',
    title: 'Antigravity model',
    severity: agyUsed,
    sandbox: 'skip', // needs the network, and its answer is cached
    requires: ['agy.login'],
    learnMore: 'docs/CHECKS.md#agymodel',
    run(ctx) {
      const list = pinned(ctx, 'agy');
      if (list.length) {
        const out = ctx.run('agy', ['models'], { timeoutMs: 30000, cacheMs: RUN_CACHE_MS }).out;
        const bad = out.trim() ? list.filter(({ model }) => !new RegExp(`(^|[^\\w.:/@+-])${escapeRe(model)}($|[^\\w.:/@+-])`, 'm').test(out)) : [];
        if (bad.length) {
          return fail(`${bad.map((b) => `"${b.model}" (${b.where})`).join(', ')} not in agy models`, {
            next: 'leave the model empty to use the one picked with /model inside agy, or copy an exact name from the list agy gives',
            steps: [step('terminal', 'agy models'), step('editor', null, { text: `in nextlevel.json set ${bad[0].set}` })],
          });
        }
      }
      const args = workerArgsOf(ctx.config, 'agy'); // (the workers': the trial runs what a worker runs)
      const own = ADAPTERS.agy.own({ home: ctx.home, read: ctx.read, path: ctx.path }).model;
      const targets = list.length ? list : [{ model: '', where: '', label: own ? `agy's own model "${own}" (picked with /model)` : "agy's default model" }];
      const version = agyVersion(ctx);
      // (and, where workers.window gives each worker a window of its own, that the trial is launched another way: review of
      // FR-022)
      const windowed = ctx.platform === 'win32' && ['minimized', 'visible'].includes(ctx.config.workers?.window) ? ' Workers run in a window of their own here (workers.window); the trial runs the same command in a console with no window.' : '';
      const effort = effortNote(args) + windowed;
      const ran = [];
      for (const t of targets) {
        const label = t.label || `"${t.model}" (${t.where})`;
        // Exactly what a worker on that model runs (FR-022: lib/workerspec.mjs), as the agent the hub writes into its slot
        // (FR-013), with the probe for its prompt and a 2-minute limit
        const spec = agyTrialSpec(ctx, { engine: 'agy', model: t.model }, { version });
        const v = agyTrial(ctx, spec, { retry: ctx.retryRefusals });
        // A PC where the console with no window doesn't start: the trial would need a window (which takes the focus)
        if (v.noConsole) return fail(`${label}: what a worker runs is not tried: ${v.reason}. Workers run in a window of their own here`, { severity: 'warn' });
        if (v.timedOut) return fail(`${label}: no answer from agy ${versionWords(version)} in 2.5 min, so what a worker runs is not checked. It ran: ${spec.shown}.${effort}`, { severity: 'warn' });
        ran.push({ t, spec, v });
        if (v.ok) continue;
        const before = passedOn(ctx, t, own);
        const on = before && before !== versionShort(version) ? `on agy ${versionShort(version) || '(version unknown)'} (passed on ${before})` : versionWords(version);
        return fail(`${label} was refused ${on}: ${v.reason || 'agy gave no reason'}, exit ${v.code ?? 'unknown'}. It ran: ${spec.shown}.${effort}${v.last?.length ? `\nWhat agy printed last:\n${v.last.join('\n')}` : ''}`, {
          next: t.model ? 'pick another of the models this sign-in may use, or leave the model empty for the one picked with /model inside agy' : 'pick another model with /model inside agy, or pin one in nextlevel.json',
          steps: [step('terminal', 'nextlevel team models agy', { cwd: ctx.root || undefined, text: 'the models this sign-in may use' }), step('editor', null, { text: `the flags every agy worker gets are ${ctx.config.engines.agy?.workerArgs ? 'engines.agy.workerArgs' : 'engines.agy.args'} in nextlevel.json: ${withoutOption(args, '--effort').join(' ') || '(none)'}` })],
          version,
        });
      }
      for (const { t } of ran) notePassed(ctx, t, own, version);
      const models = targets.map((t) => t.model || t.label);
      return pass(`${[...new Set(models)].join(', ')} (${list.length ? 'listed by agy models, and ' : ''}ran as a worker runs, ${versionWords(version)}). It ran: ${ran[0].spec.shown}${ran.length > 1 ? ', and the same with each model' : ''}.${effort}`, { version });
    },
  },
  {
    // Antigravity takes the level from the model's name (gemini-3.8-flash-high is high, claude-opus-5-5-medium is
    // medium), so nextlevel never passes an effort to agy (FR-010: 1.2.11 refused --effort for its Claude models; FR-022:
    // 1.3.5 refuses it beside a model with a level). An older nextlevel.json still has --effort in engines.agy.args (the
    // default before FR-010) or an effort on a role, profile or fallback on agy: nothing uses it, and the fix takes it out.
    id: 'agy.effort',
    title: 'Antigravity effort',
    severity: 'info',
    sandbox: 'same', // nextlevel.json only
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#agyeffort',
    run(ctx) {
      const unused = agyEfforts(ctx.config);
      if (!unused.length) return pass('none set: the level is in the model\'s name', { quiet: true });
      return fail(`${unused.map((u) => `${u.key} ("${u.value}")`).join(', ')} in nextlevel.json: not used. Antigravity takes the level from the model's name (gemini-3.8-flash-high is high, claude-opus-5-5-medium is medium): pick the model with the level you want. nextlevel doesn't pass --effort`, {
        next: 'pick the model with the level you want instead (nextlevel team models agy)',
        fromEnv: (ctx.configInfo.overrides || []).includes('AGY_ARGS'),
        steps: [step('editor', null, { text: `in nextlevel.json remove ${unused.map((u) => u.key).join(', ')}` })],
      });
    },
    fixPrompt: () => 'Remove the effort settings nothing uses from nextlevel.json (Antigravity takes the level from the model\'s name)?',
    canFix: (r, ctx) => !r.fromEnv && !!ctx.configInfo.exists,
    fix(ctx, ui) {
      const file = ctx.configInfo.file;
      let raw;
      try {
        raw = JSON.parse((ctx.read(file) || '').replace(/^﻿/, ''));
      } catch {
        return ui.say(`${file} is not valid JSON; not touching it.`);
      }
      const removed = agyEfforts(raw, { clear: true });
      if (!removed.length) return ui.say(`nextlevel.json has no effort for Antigravity: it comes from somewhere else (AGY_ARGS?).`);
      ctx.write(file, formatConfig(raw));
      agyEfforts(ctx.config, { clear: true }); // what the check sees when it runs again
      ui.say(`Removed ${removed.map((u) => u.key).join(', ')} from ${file}. Commit it with your next change.`);
    },
  },
];

// The effort settings on Antigravity in nextlevel.json (the merged settings, or the file's own object): --effort in
// engines.agy.args, and `effort` on a role, a profile or a fallback of its own on agy. `clear`: takes them out.
function agyEfforts(cfg, { clear = false } = {}) {
  const found = [];
  const args = cfg?.engines?.agy?.args;
  if (Array.isArray(args)) {
    const i = args.findIndex((a) => a === '--effort' || String(a).startsWith('--effort='));
    if (i >= 0) {
      found.push({ key: 'engines.agy.args --effort', value: args[i] === '--effort' ? args[i + 1] || '' : args[i].slice(9) });
      if (clear) cfg.engines.agy.args = withoutOption(args, '--effort');
    }
  }
  const scan = (obj, key) => {
    if (obj && typeof obj === 'object' && obj.engine === 'agy' && obj.effort) {
      found.push({ key: `${key}.effort`, value: obj.effort });
      if (clear) obj.effort = '';
    }
  };
  for (const [role, r] of Object.entries(cfg?.roles || {})) {
    if (!r?.profile) scan(r, `roles.${role}`);
    scan(r?.fallback, `roles.${role}.fallback`);
  }
  for (const [name, p] of Object.entries(cfg?.profiles || {})) scan(p, `profiles.${name}`);
  return found;
}

// ---------- workers without the owner's own add-ons (FR-013) ----------
// Bitdefender stopped an Antigravity worker on a real PC; in the chain were the owner's global add-ons, which every
// agy session started (Rafter's and Stitch's MCP servers through npx). Workers now start without the owner's own MCP
// servers, skills and hooks unless workers.addons lists them (engines/*: workerAddons). This says, per engine the
// workers use, what the owner has and what still reaches a worker: on agy, the MCP servers' processes, which nothing
// documented keeps from starting for one session (docs/upstream/antigravity-mcp-per-session.md).
const addonCount = (f) => ['mcpServers', 'skills', 'plugins', 'hooks', 'rules'].reduce((n, k) => n + (f?.[k]?.length || 0), 0);
function addonText(f) {
  const bits = [];
  if (f.mcpServers?.length) bits.push(`${f.mcpServers.length} MCP server(s) (${f.mcpServers.map((s) => s.name).join(', ')})`);
  if (f.skills?.length) bits.push(`${f.skills.length} skill(s)`);
  if (f.plugins?.length) bits.push(`${f.plugins.length} plugin(s)`);
  if (f.hooks?.length) bits.push(`hooks (${f.hooks.join(', ')})`);
  if (f.rules?.length) bits.push(`global rules (${f.rules.join(', ')})`);
  return bits.join(', ');
}
export const workerAddonsCheck = {
  id: 'workers.addons',
  title: "Workers' add-ons",
  severity: 'info',
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#workersaddons',
  run(ctx) {
    const keep = ctx.config.workers.addons;
    const files = { home: ctx.home, env: ctx.env, read: ctx.read, list: ctx.list || (() => []), path: ctx.path };
    const seen = new Set();
    const lines = [];
    const steps = [];
    let warn = false;
    for (const p of ctx.profiles.filter((x) => x.role === 'worker')) {
      const key = `${p.engine}/${p.account || ''}`;
      if (seen.has(key) || accountProblem(p)) continue;
      seen.add(key);
      const iso = workerIsolation(p, keep, files);
      const title = ADAPTERS[p.engine].title;
      if (!addonCount(iso.found)) {
        lines.push(`${title}: none of your own`);
        continue;
      }
      lines.push(`${title}: your ${addonText(iso.found)}; workers ${iso.args.length ? `start without them (${iso.args.slice(0, 2).join(' ')}${iso.args.length > 2 ? ' ...' : ''})` : 'get them (workers.addons)'}`);
      for (const l of iso.left) {
        if (l.what === 'mcp-processes' && !iso.found.mcpServers?.length) continue;
        lines.push(`${title}: ${l.text}`);
        if (l.what === 'mcp-processes') {
          warn = true;
          steps.push(step('terminal', 'agy mcp list', { text: "your agy MCP servers; turn off the ones neither the workers nor you need in agy (agy mcp disable <name>: that is for every agy session, yours too)" }));
        }
      }
    }
    if (!lines.length) return pass('no worker role', { quiet: true });
    const kept = [keep.mcpServers.length ? `MCP servers ${keep.mcpServers.join(', ')}` : '', keep.skills ? 'skills' : '', keep.hooks ? 'hooks' : ''].filter(Boolean);
    const detail = `${lines.join('. ')}${kept.length ? `. workers.addons keeps ${kept.join(', ')}` : ''}`;
    if (!warn) return pass(detail);
    return fail(detail, {
      severity: 'warn',
      next: "an antivirus stopped a worker whose chain held such servers (FR-013); the engine can't keep them out of one session yet",
      steps: [...steps, step('editor', null, { text: 'workers.addons in nextlevel.json lists what workers may keep: { "mcpServers": ["<name>"], "skills": false, "hooks": false }' })],
    });
  },
};

// ---------- Claude Code ----------
// A GitHub repo "owner/name" from a remote URL, or null.
export function githubRepo(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}
// The GitHub repository the tool's clone comes from, as configured (git remote get-url would apply the
// PC's url.<base>.insteadOf rewrites, which say nothing about where GitHub has it), or null.
export const toolGithubRepo = (ctx) => githubRepo(ctx.git(['config', '--get', 'remote.origin.url'], { cwd: ctx.toolRoot }).out);
export const claudeChecks = [
  toolCheck('claude', { severity: engineSeverity('claude'), optional: (ctx) => (ctx.uses('claude') ? '' : 'needed for nextlevel fix') }),
  {
    id: 'claude.login',
    title: 'Claude Code sign-in',
    severity: engineSeverity('claude'),
    requires: ['tool.claude'],
    skipIf: (ctx) => (ctx.uses('claude') ? null : 'no role uses Claude Code'),
    learnMore: 'docs/CHECKS.md#claudelogin',
    run(ctx) {
      return loginResult(ctx, logins(ctx, 'claude', { timeoutMs: 30000 }), step('terminal', 'claude auth login', { text: 'it opens the browser: sign in with your Claude account' }));
    },
  },
  {
    // A model pinned for a Claude Code role (M9: the Team page sets one): tried once with a one-line prompt,
    // like Codex's, and kept until the model, Claude Code or the sign-in changes. No command lists them.
    id: 'claude.model',
    title: 'Claude Code model',
    severity: engineSeverity('claude'),
    sandbox: 'skip', // needs the network, and its answer is cached
    requires: ['tool.claude', 'claude.login'],
    skipIf: (ctx) => (ctx.uses('claude') ? null : 'no role uses Claude Code'),
    learnMore: 'docs/CHECKS.md#claudemodel',
    run(ctx) {
      const targets = accounts(ctx, 'claude').flatMap((p) => pinned(ctx, 'claude', p.account).map((x) => ({ ...x, p })));
      if (!targets.length) return pass("Claude Code's own choice (its settings.json, or /model inside Claude Code)");
      const version = firstLine(ctx.run('claude', ['--version']).out);
      const seen = ctx.cache.get('claude.model') || {};
      for (const t of targets) {
        const run = forAccount(ctx, t.p);
        const id = `${t.model} | ${t.p.account} | ${version} | ${firstLine(ctx.run('claude', ['auth', 'status'], { timeoutMs: 30000, cacheMs: RUN_CACHE_MS, ...run }).out)}`;
        let v = seen[id];
        if (!v) {
          const r = ctx.run('claude', ['-p', MODEL_PROBE, '--model', t.model], { timeoutMs: 120_000, cwd: ctx.tmpDir || os.tmpdir(), ...run });
          if (r.timedOut) return fail(`"${t.model}" (${t.where}): no answer from Claude Code in 2 min, so not checked`, { severity: 'warn' });
          v = { ok: r.ok, error: r.ok ? '' : errorLine(r.out), at: new Date().toISOString() };
          ctx.cache.set('claude.model', { ...(ctx.cache.get('claude.model') || {}), [id]: v });
        }
        if (v.ok) continue;
        return fail(`"${t.model}" (${t.where}) was rejected: ${v.error}`, {
          next: 'leave the model empty for Claude Code\'s own choice, or use one of its names: opus, sonnet, haiku (or a full model name)',
          steps: [step('editor', null, { text: `in nextlevel.json set ${t.set}` }), step('claude', '/model', { text: 'to see the models this account can use' })],
        });
      }
      return pass(`${[...new Set(targets.map((t) => t.model))].join(', ')} (accepted by this Claude Code sign-in)`);
    },
  },
  {
    // FR-002: a cloud session started without GitHub connected gets a copy of the folder it can't push.
    // This PC can't see the Claude account's GitHub connection, so the owner confirms it once; what can
    // be checked here (the tool's folder has a GitHub remote) is checked. nextlevel fix (src/fix.mjs)
    // starts a cloud session only when this passes.
    id: 'claude.github',
    title: 'Claude on GitHub',
    severity: 'info',
    requires: ['tool.claude'],
    learnMore: 'docs/CHECKS.md#claudegithub',
    run(ctx) {
      const repo = toolGithubRepo(ctx);
      if (!repo) {
        return fail(`the nextlevel tool's folder has no GitHub remote: a cloud session started from it would get a copy it can't push (FR-002)`, {
          severity: 'warn',
          next: 'install the tool with its installer (see its README)',
        });
      }
      const seen = ctx.userState.get('claudeGithub');
      if (seen?.repo === repo) return pass(`you confirmed on ${String(seen.at).slice(0, 10)} that Claude can reach ${repo} (not checkable from this PC)`);
      return fail(`not confirmed: cloud sessions on ${repo} can push only if your Claude account is connected to GitHub`, {
        next: 'nextlevel fix starts a cloud session only once you confirm it (the menu\'s doctor, or nextlevel fix, asks)',
        repo,
        steps: [
          step('browser', 'https://claude.ai/connect-github', { text: 'connect your Claude account to GitHub' }),
          step('browser', 'https://github.com/apps/claude', { text: `install the Claude GitHub App on ${repo}` }),
        ],
      });
    },
    fixPrompt: (r) => `Have you connected Claude to GitHub and installed the Claude GitHub App on ${r.repo} (the two browser steps above)?`,
    canFix: (r, ctx, ui) => ui.interactive && !!r.repo, // only the owner can say so
    fix(ctx, ui, r) {
      ctx.userState.set('claudeGithub', { repo: r.repo, at: new Date().toISOString() });
    },
  },
];

// ---------- profiles (M6) ----------
// A second account of an engine lives in a folder of its own, which the engine's CLI is pointed at
// (CODEX_HOME, CLAUDE_CONFIG_DIR). An engine without such a setting can't keep two accounts apart on one
// PC user (Antigravity): a profile with an account on it would silently run on whatever account the CLI
// is signed in with, so the hub starts nothing on it and this says so, plainly.
export const profilesCheck = {
  id: 'profiles.accounts',
  title: 'Second accounts',
  sandbox: 'same', // nextlevel.json only
  severity: (ctx) => (ctx.profiles.some((p) => accountProblem(p) && !p.fallback && !p.second) ? 'error' : 'warn'), // (the second worker's, as a fallback's: a warning)
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#profilesaccounts',
  run(ctx) {
    const named = [];
    for (const p of ctx.profiles) if (p.account && !named.some((n) => n.name === p.name)) named.push(p);
    if (!named.length) return pass('none: every profile uses its engine\'s own login', { quiet: true });
    const bad = named.filter((p) => accountProblem(p));
    if (bad.length) {
      return fail(bad.map((p) => accountProblem(p)).join('; '), {
        next: 'nothing starts on such a profile; a second account needs an engine that keeps accounts apart (Codex, Claude Code)',
        steps: bad.map((p) => step('editor', null, { text: `in nextlevel.json take "account" out of profiles.${p.name}, or give it "engine": "codex" or "claude"` })),
      });
    }
    return pass(named.map((p) => `${p.name}: ${ADAPTERS[p.engine].title} account ${p.account}, in its own folder ${accountDir(ctx.home, p.engine, p.account, ctx.path)} (${ADAPTERS[p.engine].account.env})`).join('; '));
  },
};

// FR-017: a role on an engine that runs it with no permission check (Antigravity skips them to run unattended; Codex
// without its sandbox; Claude Code with bypassPermissions) acts with the owner's full access: their sign-ins, git, gh and
// deploy tools. A role in the main checkout (the orchestrator, the setup guide, the assistant, their fallbacks) could push
// or deploy directly and can move to a sandboxed engine: a warning. Workers run in slots behind the push block and need
// Antigravity's unattended mode: information, the risk accepted by design. Said here and on the Team page (lib/team.mjs);
// nothing is refused.
const ROLE_WHO = { orchestrator: 'the orchestrator', worker: 'the workers', guide: 'the setup guide', assistant: 'the assistant', security: 'the security engineer' };
const roleWho = (p) => (p.second ? 'the second worker' : p.fallback ? `${p.role === 'worker' ? "the workers'" : `the ${p.role}'s`} fallback` : ROLE_WHO[p.role] || p.role);
export const fullAccessCheck = {
  id: 'profiles.full-access',
  title: 'Roles with full access',
  sandbox: 'same', // nextlevel.json only
  severity: 'info',
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#profilesfull-access',
  run(ctx) {
    const facts = accessFacts(ctx); // (the orchestrator's lock test on Antigravity, and what the owner's agy settings approve)
    const found = ctx.profiles.map((p) => ({ p, note: fullAccessNote(p, p.role, p.role === 'worker' ? workerArgsOf(ctx.config, p.engine) : ctx.config.engines?.[p.engine]?.args || [], facts(p, p.role)) })).filter((x) => x.note);
    if (!found.length) return pass("every role runs with its engine's permission checks", { quiet: true });
    const cwd = ctx.root || undefined;
    const main = found.filter((x) => x.note.level === 'warn'); // (the warnings first: where the owner can act)
    const ordered = [...main, ...found.filter((x) => x.note.level !== 'warn')];
    const orchestrator = main.find((x) => x.p.role === 'orchestrator' && !x.p.fallback);
    return fail(ordered.map((x) => `${roleWho(x.p)} (${ADAPTERS[x.p.engine].title}): ${x.note.text}`).join('; '), {
      severity: main.length ? 'warn' : 'info',
      next: main.length
        ? 'a role in the main checkout is safest on Codex (its sandbox has no network) or Claude Code (nextlevel sets its rules)'
        : 'nothing to do: workers on Antigravity need it to run unattended; keep deploy tools that are signed in as you off this PC user, or put the workers on another engine',
      steps: [
        ...(orchestrator ? [step('terminal', 'nextlevel team set orchestrator --engine codex', { cwd, text: 'the orchestrator in Codex\'s sandbox (or --engine claude); or on the dashboard: Team -> Orchestrator -> Change' })] : []),
        step('terminal', 'nextlevel team', { cwd, text: 'who fills each role, and on which engine; the dashboard\'s Team page says the same on each such role' }),
      ],
    });
  },
};
