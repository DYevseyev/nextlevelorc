// nextlevel doctor: runs the setup checks (src/checks/) and prints them.
//   nextlevel doctor               check; also creates .env from .env.example (the one fix that is always safe)
//   nextlevel doctor --fix         also run the fixes (in the menu it asks before each one)
//   nextlevel doctor --fix <id>    run that one check's fix only
//   nextlevel doctor --json        the results as JSON, for the dashboard; changes nothing
//   nextlevel doctor --fresh       asks the slow things again (agy's sign-in and models, Codex's and Claude Code's
//                                  sign-in), which are otherwise kept for a few minutes (FR-010)
//   nextlevel doctor --fix <id> --json   the dashboard's Fix button: that fix, if it needs no window of
//                                  the owner's (no installers), with what it said, then the results
// The exit code is 1 when an error-level check fails, 0 otherwise (warnings and notes don't count).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { CHECKS, byId, loadProjectChecks, runChecks } from './checks/index.mjs';
import { redact, windowLabel } from './checks/lib.mjs';
import { commandArgs } from './lib/commands.mjs';

// --fix, --fix <id> or --fix=<id>, and --json, from the doctor's arguments. fix: false, true or an id.
// (the arguments as lib/commands.mjs reads them: --fix [<id>] is the option and, when there is one, the argument)
export function doctorOptions(argv) {
  const a = commandArgs('doctor', argv);
  return { json: !!a.json, fix: a.fix ? a._[0] || true : false, fresh: !!a.fresh };
}

const MARK = { ok: ' ok ', skip: ' -- ', error: ' !! ', warn: ' !! ', info: ' i  ' };

function formatStep(s, platform) {
  const where = `${windowLabel(s.window, platform)}${s.cwd ? `, in ${s.cwd}` : ''}`;
  if (s.command && s.text) return `${where}:  ${s.command}   (${s.text})`;
  return `${where}:  ${s.command || s.text}`;
}

export function formatResults(results, { platform = process.platform, toolRoot } = {}) {
  const lines = [''];
  for (const r of results) {
    if (r.quiet) continue;
    const mark = r.status === 'fail' ? MARK[r.severity] : MARK[r.status];
    lines.push(`${mark} ${r.title.padEnd(22)} ${r.detail}${r.next ? `  ->  ${r.next}` : ''}`);
    if (r.status !== 'fail') continue;
    if (r.message) lines.push(...r.message.split('\n').map((l) => `        ${l}`));
    else for (const s of r.steps) lines.push(`        ${formatStep(s, platform)}`);
  }
  const failed = results.filter((r) => r.status === 'fail');
  const errors = failed.filter((r) => r.severity === 'error').length;
  const warnings = failed.filter((r) => r.severity === 'warn').length;
  lines.push('');
  if (errors + warnings) {
    const parts = [errors && `${errors} to fix`, warnings && `${warnings} warning(s)`].filter(Boolean).join(', ');
    const guide = 'the setup guide (START.cmd -> 2 or 3) walks you through the rest.';
    const help = failed.some((r) => r.fixable) ? `\`nextlevel doctor --fix\` fixes what it can; ${guide}` : guide[0].toUpperCase() + guide.slice(1);
    lines.push(`${errors + warnings} item(s) need attention (${parts}). ${help}`);
    lines.push("If a check's steps don't fix it: nextlevel report <check-id> sends nextlevel's developers a report (you read it first).");
  } else lines.push('All good.');
  if (toolRoot) lines.push(`What each check means: ${path.join(toolRoot, 'docs', 'CHECKS.md')}`);
  return lines.join('\n');
}

// How fixes talk to the owner: questions in the menu (readline) or from nextlevel report (its asker: anything
// with question(prompt)), yes to everything with --fix alone.
export function makeUi(rl) {
  return {
    interactive: !!rl,
    async confirm(q) {
      if (!rl) return true;
      return /^y/i.test((await rl.question(`${q} [y/N] `)).trim());
    },
    async input(q) {
      return rl ? rl.question(q) : null;
    },
    say: (m) => console.log(m),
    run(cmd, args, { shell = false } = {}) {
      console.log(`> ${[cmd, ...args].join(' ')}`);
      return spawnSync(cmd, args, { stdio: 'inherit', shell, windowsHide: false }).status === 0;
    },
  };
}

// Fixes run for the dashboard (--fix with --json): no window, so no questions and nothing printed
// (stdout carries the JSON); what the fix says and what the commands it runs print is kept for the page.
function windowlessUi(lines) {
  const add = (text) => lines.push(...String(text).split(/\r?\n/).filter((l) => l.trim()));
  return {
    interactive: false,
    windowless: true,
    confirm: async () => true,
    input: async () => null,
    say: add,
    run(cmd, args, { shell = false } = {}) {
      add(`> ${[cmd, ...args].join(' ')}`);
      const r = spawnSync(cmd, args, { shell, encoding: 'utf8', windowsHide: true, timeout: 10 * 60_000 });
      add(`${r.stdout || ''}${r.stderr || ''}`.split(/\r?\n/).slice(-40).join('\n'));
      if (r.error) add(r.error.message);
      return r.status === 0;
    },
  };
}

// Why a fix that was asked for (--fix <id>) didn't run.
function notRun(r) {
  if (r.status === 'skip') return `the check was skipped: ${r.detail}`;
  if (r.status === 'ok') return 'it passes: nothing to fix';
  if (!r.fixable) return 'there is no automatic fix for it: its steps say what to do';
  return 'it installs or updates a program, which runs in your own window: its steps say which one';
}

// ctx: from checks/context.mjs. Returns the number of failed error-level checks.
export async function runDoctor(ctx, { json = false, fix = false, rl = null, fresh = false } = {}) {
  if (fresh) ctx.fresh = true;
  const checks = [...CHECKS, ...(await loadProjectChecks(ctx.stateDir))];
  if (typeof fix === 'string' && !byId(fix, checks)) {
    console.error(`There is no check "${fix}". nextlevel doctor --json lists them (the "id" of each result).`);
    return 1;
  }
  const said = [];
  const ui = json ? (fix ? windowlessUi(said) : null) : makeUi(rl);
  const results = await runChecks(ctx, { checks, fix: fix || !!rl, safeFixes: !json, ui });
  const errors = results.filter((r) => r.status === 'fail' && r.severity === 'error').length;
  const target = typeof fix === 'string' && results.find((r) => r.id === fix);
  const report = target && {
    id: fix,
    ran: 'fixed' in target,
    fixed: !!target.fixed,
    ...('fixed' in target ? {} : { reason: notRun(target) }),
    log: said.map((l) => redact(l, ctx.secrets)),
  };
  if (json) {
    const count = (sev) => results.filter((r) => r.status === 'fail' && r.severity === sev).length;
    const out = results.map((r) => ({ ...r, steps: r.steps.map((s) => ({ ...s, label: windowLabel(s.window, ctx.platform) })) }));
    const summary = { errors, warnings: count('warn'), info: count('info') };
    console.log(JSON.stringify({ project: ctx.root, platform: ctx.platform, summary, ...(report ? { fix: report } : {}), results: out }, null, 2));
  } else {
    console.log(formatResults(results, { platform: ctx.platform, toolRoot: ctx.toolRoot }));
    if (report && !report.ran) console.log(`Didn't fix "${target.title}": ${report.reason}.`);
  }
  return errors;
}
