// Setup checks as code. Every setup step, and every problem a real user hit (docs/FIELD_REPORTS.md), is a
// check here, with a fix where one can be automated and exact steps (with the window to type them in)
// where only the owner can do it. docs/CHECKS.md lists them all.
//
// A check:
//   id          'area.name', stable: docs, field reports and the dashboard refer to it
//   title       short label for the doctor's table
//   run(ctx)    -> { ok, detail, severity?, next?, steps?, message?, quiet? }   (ctx: ./context.mjs)
//               detail: what was found. next: one line on what to do. steps: [{ window, command | text, cwd? }]
//               (lib.mjs WINDOWS lists the windows). message: a longer text shown instead of the steps.
//   severity    'error' (blocks the build team), 'warn' (should be fixed), 'info' (good to know);
//               a value, or a function of ctx. A result can override it.
//   fix(ctx, ui, result)   optional: repairs it. The doctor runs it with --fix (asking first in the menu)
//               and then runs the check again. fixPrompt(result, ctx): the question; canFix(result, ctx, ui).
//               safeFix: harmless enough to do without --fix (creating .env from .env.example).
//               fixInWindow: the fix installs or updates a program (winget, npm -g, an install script),
//               which asks for permission, shows progress and changes PATH for new windows: it runs only
//               from the owner's own window (the doctor there), never from the dashboard, which shows
//               the check's steps to copy instead.
//   sandbox     inside Codex's sandbox (ctx.sandbox), which hides the owner's sign-ins, programs and network
//               (FR-004 #2): 'same' when the check sees only the project and the answer is the same there;
//               'skip' when it needs the network (it isn't run: an answer there would be wrong, and cached);
//               anything else (the default): it runs, and a failure shows as "can't tell" instead
//   requires    ids of checks that must pass first (else this one is skipped)
//   skipIf(ctx) a reason to skip, or a falsy value. platforms: ['win32'] runs only there.
//   learnMore   where it is explained (docs/CHECKS.md#<id without dots>), or a URL
//
// Projects add their own in .nextlevel/checks/*.mjs (export default a check or a list of checks).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { agyPermissionsCheck, lockCheck } from './argon.mjs';
import { claudeChecks, codexChecks, agyChecks, fullAccessCheck, profilesCheck, workerAddonsCheck } from './engines.mjs';
import { toolFilesCheck } from './files.mjs';
import { ghAuthCheck, ghTool, gitTool, identityCheck, readTokenCheck, repoChecks } from './git.mjs';
import { guardCheck } from './guard.mjs';
import { channelCheck, commandCheck, updatesCheck } from './install.mjs';
import { projectChecks } from './project.mjs';
import { runnerChecks } from './runner.mjs';
import { bridgeCheck, denyListCheck, hubCheck, portsCheck, pushLockCheck } from './safety.mjs';
import { nodeCheck, sleepCheck, windowChecks } from './system.mjs';
import { dockerCheck } from './tools.mjs';
import { redact } from './lib.mjs';

const [projectFolder, projectConfig, projectState, ...projectFiles] = projectChecks;

// In the order the doctor shows them, which is also the order to fix them in.
export const CHECKS = [
  ...windowChecks,
  projectFolder,
  projectConfig,
  projectState,
  profilesCheck,
  fullAccessCheck,
  nodeCheck,
  commandCheck,
  gitTool,
  identityCheck,
  ghTool,
  ghAuthCheck,
  readTokenCheck,
  updatesCheck,
  channelCheck,
  toolFilesCheck,
  dockerCheck,
  ...codexChecks,
  ...agyChecks,
  agyPermissionsCheck,
  denyListCheck,
  ...claudeChecks,
  workerAddonsCheck,
  ...projectFiles,
  ...repoChecks,
  ...runnerChecks,
  pushLockCheck,
  portsCheck,
  guardCheck,
  bridgeCheck,
  lockCheck,
  hubCheck,
  sleepCheck,
];
export const byId = (id, list = CHECKS) => list.find((c) => c.id === id);

const ID_RE = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/;
export function validateCheck(c) {
  const problems = [];
  if (!c || typeof c !== 'object') return ['is not an object'];
  if (typeof c.id !== 'string' || !ID_RE.test(c.id)) problems.push(`id must look like "area.name" (lowercase), not ${JSON.stringify(c.id)}`);
  if (typeof c.title !== 'string' || !c.title.trim()) problems.push('needs a title');
  if (typeof c.run !== 'function') problems.push('needs run(ctx)');
  if (c.fix !== undefined && typeof c.fix !== 'function') problems.push('fix must be a function');
  if (c.severity !== undefined && typeof c.severity !== 'function' && !['error', 'warn', 'info'].includes(c.severity)) problems.push('severity must be error, warn or info');
  return problems;
}

// Checks from the project's .nextlevel/checks/*.mjs. A file that doesn't load, or a check that isn't
// valid, becomes a failed check that says why, so a broken project check never hides the others.
export async function loadProjectChecks(stateDir, taken = CHECKS.map((c) => c.id)) {
  const dir = stateDir && path.join(stateDir, 'checks');
  if (!dir || !fs.existsSync(dir)) return [];
  const ids = new Set(taken);
  const out = [];
  for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
    const file = path.join(dir, name);
    const source = path.join(path.basename(stateDir), 'checks', name);
    const broken = (why) => ({ id: `project.check-${name.replace(/\.mjs$/, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-')}`, title: name, source, run: () => ({ ok: false, severity: 'warn', detail: why }) });
    let mod;
    try {
      mod = await import(`${pathToFileURL(file).href}?v=${fs.statSync(file).mtimeMs}`);
    } catch (err) {
      out.push(broken(`doesn't load: ${String(err.message).split('\n')[0]}`));
      continue;
    }
    const list = [mod.default ?? mod.checks].flat().filter((c) => c !== undefined);
    if (!list.length) out.push(broken('exports no checks (export default a check or a list of checks)'));
    for (const c of list) {
      const problems = validateCheck(c);
      if (!problems.length && ids.has(c.id)) problems.push(`id "${c.id}" is already taken`);
      if (problems.length) {
        out.push(broken(`${c?.id ? `${c.id}: ` : ''}${problems.join('; ')}`));
        continue;
      }
      ids.add(c.id);
      out.push({ ...c, source });
    }
  }
  return out;
}

// A check's severity here: its result's own, else the check's (for this ctx). Without `r`: what it would be.
export const severityOf = (check, ctx, r) => r?.severity || (typeof check.severity === 'function' ? check.severity(ctx) : check.severity) || 'error';

// Run one check (after its requirements, looked up in `done`) and shape its result.
export async function runCheck(check, ctx, done = new Map()) {
  const base = { id: check.id, title: check.title, learnMore: check.learnMore || null, source: check.source || null, next: '', steps: [], message: '' };
  if (check.platforms && !check.platforms.includes(ctx.platform)) return { ...base, status: 'skip', ok: true, severity: 'info', detail: `only on ${check.platforms.join(', ')}`, quiet: true };
  const reason = check.skipIf?.(ctx);
  if (reason) return { ...base, status: 'skip', ok: true, severity: 'info', detail: reason, quiet: true };
  const blocker = (check.requires || []).map((id) => done.get(id)).find((r) => r && (r.status === 'fail' || (r.status === 'skip' && !r.quiet)));
  if (blocker) return { ...base, status: 'skip', ok: true, severity: 'info', detail: `needs "${blocker.title}" first` };
  const blind = !!ctx.sandbox && check.sandbox !== 'same';
  if (blind && check.sandbox === 'skip') return { ...base, status: 'skip', ok: true, severity: 'info', detail: `not checked inside ${ctx.sandbox.name}` };
  const started = Date.now();
  let r;
  try {
    r = (await check.run(ctx)) || { ok: false, detail: 'the check returned nothing' };
  } catch (err) {
    r = { ok: false, severity: 'warn', detail: `the check itself failed: ${err.message}` };
  }
  const { ok, detail = '', next = '', steps = [], message = '', quiet = false, ...extra } = r;
  const clean = (s) => redact(s, ctx.secrets);
  if (!ok && blind) {
    return { ...base, status: 'skip', ok: true, severity: 'info', detail: clean(`can't tell inside ${ctx.sandbox.name} (there: ${detail})`), sandboxed: true, ms: Date.now() - started };
  }
  return {
    ...base,
    ...extra,
    status: ok ? 'ok' : 'fail',
    ok: !!ok,
    severity: severityOf(check, ctx, r),
    detail: clean(detail),
    next: clean(next),
    steps: steps.map((s) => Object.fromEntries(Object.entries(s).map(([k, v]) => [k, typeof v === 'string' ? clean(v) : v]))),
    message: clean(message),
    quiet: !!quiet && !!ok,
    ms: Date.now() - started,
  };
}

// Run every check in order. With `fix` (true for every check, or one check's id), a failed check that has
// a fix is offered it (ui.confirm) and then checked again; safe fixes run unless `safeFixes` is false.
// A result says whether it has a fix (`fixable`) and whether that fix runs without the owner's own
// window (`autoFix`: the dashboard's Fix button). A ui without a window (`ui.windowless`, the
// dashboard's) never runs a fixInWindow fix.
export async function runChecks(ctx, { checks = CHECKS, fix = false, safeFixes = true, ui = null } = {}) {
  const done = new Map();
  for (const check of checks) {
    let r = await runCheck(check, ctx, done);
    const fixable = check.fix && r.status === 'fail' && (!check.canFix || check.canFix(r, ctx, ui || {}));
    r.fixable = !!fixable;
    r.autoFix = !!fixable && !check.fixInWindow;
    const wanted = (fix === true || fix === check.id) && !(ui?.windowless && check.fixInWindow);
    const auto = fixable && ui && (wanted || (safeFixes && check.safeFix));
    if (auto) {
      const prompt = typeof check.fixPrompt === 'function' ? check.fixPrompt(r, ctx) : check.fixPrompt || `Fix "${check.title}"?`;
      if (check.safeFix || (await ui.confirm(prompt))) {
        try {
          await check.fix(ctx, ui, r);
        } catch (err) {
          ui.say(`The fix for "${check.title}" failed: ${err.message}`);
        }
        ctx.forget?.();
        const again = await runCheck(check, ctx, done);
        r = { ...again, fixable: false, autoFix: false, fixed: again.ok };
      }
    }
    done.set(check.id, r);
  }
  return [...done.values()];
}

