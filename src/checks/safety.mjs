// Worker safety (FR-003): agy's deny-list (an extra layer only), git's push lock in worker slots, and the
// bridge test, which is the proof that workers can't push. Also whether the hub runs.
import { ADAPTERS } from '../engines/index.mjs';
import { workerArgsOf } from '../lib/config.mjs';
import { projectKey, slotOffset } from '../lib/ports.mjs';
import { SLOT_PUSH_BLOCK } from '../lib/workerspec.mjs';
import { fail, firstLine, inProject, parseVersion, pass, step, versionAtLeast, versionText } from './lib.mjs';

const needsProject = (ctx) => (ctx.root ? null : 'no project');

// On Antigravity CLI 1.2.11 these rules didn't stop `git push` (FR-003). Git blocks pushes in slots whatever
// agy does (the hub's lockSlot), and the bridge test checks it. The list is shared with Claude Code's
// workers (src/engines/rules.mjs), each in its own rule syntax.
export const DENY = ADAPTERS.agy.denyRules;
export const agySettingsFile = (ctx) => ctx.path.join(ctx.home, '.gemini', 'antigravity-cli', 'settings.json');
function readSettings(ctx) {
  const text = ctx.read(agySettingsFile(ctx));
  if (text === null) return { cfg: {}, exists: false };
  try {
    return { cfg: JSON.parse(text.replace(/^﻿/, '')), exists: true };
  } catch {
    return { cfg: null, exists: true };
  }
}
const missingRules = (cfg) => DENY.filter((d) => !(cfg.permissions?.deny || []).includes(d));
const PROOF = "proof that workers can't push: the bridge test (START.cmd -> 8, or nextlevel bridge-test)";

export const denyListCheck = {
  id: 'agy.deny-list',
  title: 'Worker safety rules',
  severity: 'warn',
  requires: ['tool.agy'],
  learnMore: 'docs/CHECKS.md#agydeny-list',
  run(ctx) {
    const { cfg, exists } = readSettings(ctx);
    if (!exists) return fail('no settings file yet', { next: 'Doctor can add them (answer y)' });
    if (!cfg) return fail('settings.json is not valid JSON; not touching it', { noFix: true, next: `fix ${agySettingsFile(ctx)} by hand` });
    const missing = missingRules(cfg);
    // "Configured", never "working": agy can ignore its own rules (FR-003); only the bridge test shows it.
    if (!missing.length) return pass('agy deny-list configured (not proof it works)', { next: PROOF });
    return fail(`${missing.length} safety rule(s) missing`, { next: 'Doctor can add them (answer y)' });
  },
  fixPrompt: 'Add the worker safety deny-list (no push, no gh, no deletes, no ssh) to Antigravity CLI settings?',
  canFix: (r) => !r.noFix,
  fix(ctx, ui) {
    const f = agySettingsFile(ctx);
    const { cfg, exists } = readSettings(ctx);
    if (!cfg) return ui.say(`${f} is not valid JSON; fix it by hand first.`);
    const backedUp = ['.nextlevel-backup'].some((b) => ctx.exists(`${f}${b}`));
    if (exists && !backedUp) ctx.copy(f, `${f}.nextlevel-backup`);
    cfg.permissions ||= {};
    cfg.permissions.deny = [...new Set([...(cfg.permissions.deny || []), ...DENY])];
    ctx.write(f, JSON.stringify(cfg, null, 2));
    // Say what happened, from the file itself (FR-001 #10: the question came back after a "yes").
    const back = readSettings(ctx).cfg;
    const still = back ? missingRules(back) : DENY;
    if (!still.length) ui.say(`Saved the ${DENY.length} rules in ${f} and read them back: they are all there.`);
    else ui.say(`Wrote ${f}, but reading it back ${still.length} rule(s) are missing. Close every agy window (agy may rewrite the file) and run the doctor again.`);
  },
};

// A pushurl in the project's shared git config can be switched off for one slot only from Git 2.46; with
// older Git the hub refuses to start workers, so say so before anyone dispatches.
export const pushLockCheck = {
  id: 'slots.push-lock',
  title: 'Slot push lock',
  sandbox: 'same', // the project only
  requires: ['tool.git'],
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#slotspush-lock',
  run(ctx) {
    const r = ctx.git(['config', '--get-regexp', '^remote\\..*\\.pushurl$']);
    const remotes = [...new Set(r.out.split(/\r?\n/).map((l) => (l.match(/^remote\.(.+)\.pushurl\s/i) || [])[1]).filter(Boolean))];
    if (!remotes.length) return pass('git refuses pushes from worker slots (the bridge test proves it)');
    const v = parseVersion(ctx.run('git', ['--version']).out);
    if (versionAtLeast(v, '2.46.0')) return pass(`remote.${remotes[0]}.pushurl is set; Git ${versionText(v)} switches it off in slots`);
    const cmd = `git config --unset-all remote.${remotes[0]}.pushurl`;
    return fail(`remote.${remotes[0]}.pushurl is set and Git ${versionText(v)} can't switch it off in one slot, so no worker starts`, {
      next: 'update Git to 2.46 or later, or remove the setting',
      steps: [step('terminal', ctx.platform === 'win32' ? 'winget upgrade -e --id Git.Git' : null, { text: ctx.platform === 'win32' ? undefined : 'update git to 2.46 or later' }), inProject(ctx, cmd)],
    });
  },
};

// Worker slots' port offsets, unique among this PC's projects (FR-004 #7): the hub gives each project a
// block of them (lib/ports.mjs, "portBlocks" in ~/.nextlevel/state.json) when it first starts.
export const portsCheck = {
  id: 'slots.ports',
  title: 'Slot ports',
  severity: 'info',
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#slotsports',
  run(ctx) {
    const blocks = ctx.userState.get('portBlocks') || {};
    const key = projectKey(ctx.root, ctx.platform);
    const mine = blocks[key];
    if (!Number.isInteger(mine)) return pass('given out when the hub first starts: offsets no other project on this PC has');
    const offsets = [...Array(ctx.config.workers.slots).keys()].map((i) => slotOffset(mine, i + 1)).join(', ');
    const same = Object.entries(blocks).filter(([k, b]) => k !== key && b === mine && ctx.exists(k)).map(([k]) => k);
    if (same.length) {
      return fail(`${offsets}: the same as the project in ${same[0]}, so their workers' services can collide`, {
        severity: 'warn',
        steps: [step('editor', null, { text: `remove the line for ${key} from "portBlocks" in ${ctx.path.join(ctx.home, '.nextlevel', 'state.json')}; the hub gives it new offsets when it starts` })],
      });
    }
    return pass(`NEXTLEVEL_PORT_OFFSET ${offsets} (no other project on this PC has them)`);
  },
};

// The bridge test's tasks in the hub's log (.nextlevel/logs/hub.log: "<ISO time>  started T000-bridge-1 in
// slot w1 ..."): when the last one ran, and which ids. null when the log has none.
export function bridgeRunsInLog(ctx) {
  const dir = ctx.stateDir || ctx.path.join(ctx.root, '.nextlevel');
  const text = ctx.read(ctx.path.join(dir, 'logs', 'hub.log')) || '';
  let last = null;
  const ids = new Set();
  for (const m of text.matchAll(/^(\d{4}-\d\d-\d\d)T\S*\s+(?:started|finished) (T000-bridge-\d+)\b/gm)) {
    last = m[1];
    ids.add(m[2]);
  }
  return last ? { date: last, ids: [...ids].sort() } : null;
}

// The bridge test's verdicts, one per worker engine: .nextlevel/bridge-tests/<engine>.json, each with the engine's version
// and the workers' arguments it ran with (lib/config.mjs workerArgsOf), so a new version or new arguments (Codex workers
// out of their sandbox) ask for the test again. .nextlevel/bridge-test.json stays as an older nextlevel wrote and reads it:
// the last run on any engine, which still counts for its own engine (it ran with that engine's args, before workerArgs).
export const bridgeFile = (ctx, engine) => ctx.path.join(ctx.stateDir || ctx.path.join(ctx.root, '.nextlevel'), ...(engine ? ['bridge-tests', `${engine}.json`] : ['bridge-test.json']));
export function bridgeVerdict(ctx, engine) {
  const read = (f) => {
    try {
      const rec = JSON.parse(ctx.read(f));
      return rec && typeof rec === 'object' && rec.engine === engine ? rec : null;
    } catch {
      return null;
    }
  };
  return read(bridgeFile(ctx, engine)) || read(bridgeFile(ctx, ''));
}
// The engines workers run on (the workers', then their fallback's), each with the command that tests it.
function workerEngines(ctx) {
  const out = [];
  for (const p of (ctx.profiles || []).filter((x) => x.role === 'worker')) {
    if (out.some((e) => e.engine === p.engine)) continue;
    const command = !p.fallback && !p.second ? 'nextlevel bridge-test' : `nextlevel bridge-test ${p.name ? `--profile ${p.name}` : `--engine ${p.engine}`}`;
    out.push({ engine: p.engine, fallback: p.fallback, second: !!p.second, command });
  }
  return out.length ? out : [{ engine: 'agy', fallback: false, command: 'nextlevel bridge-test' }];
}
const sameArgs = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

// One engine's verdict: { ok, severity, text, command }. `log`: whether the hub's log may stand for a missing verdict
// (FR-007: before the verdict was kept, a bridge test showed only there; it has no engine, so only the workers' own).
function engineVerdict(ctx, { engine, command }, { log }) {
  const rec = bridgeVerdict(ctx, engine);
  if (!rec) {
    const ran = log && bridgeRunsInLog(ctx);
    if (ran) return { ok: false, text: `ran on ${ran.date} (the hub log shows ${ran.ids.join(' and ')}), before nextlevel saved its verdict: run it again for a saved verdict`, command };
    return { ok: false, text: 'not run yet', command };
  }
  const when = String(rec.at || '').slice(0, 10);
  const version = `${rec.engine}${rec.engineVersion ? ` ${rec.engineVersion}` : ''}`;
  if (rec.result === 'leaked') return { ok: false, severity: 'error', text: `FAILED on ${when}: a worker's push arrived at the test remote. Don't start the orchestrator or autopilot` };
  if (rec.result === 'signed-in') return { ok: false, severity: 'error', text: `FAILED on ${when}: a worker's gh answered as ${rec.gh || 'someone'}. Don't start the orchestrator or autopilot` };
  if (rec.result !== 'passed') return { ok: false, text: `didn't pass on ${when}${rec.reason ? `: ${rec.reason}` : ''}`, command };
  const now = firstLine(ctx.run(rec.engine, ['--version']).out);
  if (rec.engineVersion && now && now !== rec.engineVersion) return { ok: false, text: `passed on ${when} with ${version}, but ${rec.engine} is ${now} now: run it again`, command };
  // (a record from before workerArgs ran with the engine's args: it counts while workers still get them)
  const want = workerArgsOf(ctx.config, engine);
  const ran = Array.isArray(rec.workerArgs) ? rec.workerArgs : Array.isArray(ctx.config?.engines?.[engine]?.workerArgs) ? null : want;
  // (a nextlevel whose slots refuse pushes another way: the test proves the new way; a verdict from before kept no number)
  const block = Number.isSafeInteger(rec.slotPushBlock) ? rec.slotPushBlock : 1;
  if (block !== SLOT_PUSH_BLOCK) return { ok: false, text: `passed on ${when} (${version}), before nextlevel changed how slots refuse pushes: run it again`, command };
  if (!sameArgs(ran, want)) return { ok: false, text: `passed on ${when} (${version}) with other worker arguments (${ran ? ran.join(' ') || 'none' : 'before engines.' + engine + '.workerArgs'}; now ${want.join(' ') || 'none'}): run it again`, command };
  return { ok: true, text: `passed on ${when} (${version}): workers tried to push and nothing arrived${rec.gh === 'none' ? ", and gh answered as no one" : ''}` };
}

// The bridge test, for each engine workers run on. Before its verdict was kept (FR-007), a bridge test that ran shows
// only in the hub's log: it ran, and it runs again.
export const bridgeCheck = {
  id: 'bridge.test',
  title: 'Bridge test',
  severity: 'warn',
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#bridgetest',
  run(ctx) {
    const engines = workerEngines(ctx);
    const results = engines.map((e, i) => ({ ...e, ...engineVerdict(ctx, e, { log: i === 0 }) }));
    const one = results.length === 1;
    const said = (r) => (one ? r.text : `${ADAPTERS[r.engine]?.title || r.engine} workers${r.second ? ' (the second worker)' : r.fallback ? " (the workers' fallback)" : ''}: ${r.text}`);
    const detail = results.map(said).join('; ');
    if (results.every((r) => r.ok)) return pass(detail);
    if (results.some((r) => r.severity === 'error')) {
      return fail(detail, { severity: 'error', next: 'file it as a field report; the evidence is kept (nextlevel result T000-bridge-1)' });
    }
    const commands = [...new Set(results.filter((r) => !r.ok && r.command).map((r) => r.command))];
    return fail(detail, {
      next: "it's the proof that workers can't push",
      steps: [step('terminal', 'nextlevel run', { cwd: ctx.root, text: 'the hub; leave its window open. Or: START.cmd -> 4' }), ...commands.map((c) => inProject(ctx, c))],
    });
  },
};

export const hubCheck = {
  id: 'hub.running',
  title: 'Hub',
  severity: 'info',
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#hubrunning',
  run(ctx) {
    if (ctx.hubAlive()) return pass('running');
    return fail('stopped', { next: 'START.cmd -> 4 when setup is done', steps: [step('terminal', 'nextlevel run', { cwd: ctx.root, text: 'leave its window open' })] });
  },
};
