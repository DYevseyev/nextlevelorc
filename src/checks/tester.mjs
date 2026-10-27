// The tester's checks (docs/design/tester.md §10): its settings and the personas' sign-ins the plans need, a secret
// store on this PC, every plan under docs/acceptance/ reading, and each environment answering a GET (no sign-in). All
// skipped while the tester is off: with it off nothing changes.
import { PLAN_DIR, planPathProblem, readPlan } from '../lib/acceptance.mjs';
import { PLAYWRIGHT } from '../lib/browsertools.mjs';
import { originOf, signInFor, testerOn } from '../lib/testerconfig.mjs';
import { personasOf, storeKind, vaultFile, vaultFromText } from '../lib/vault.mjs';
import { planFitProblems } from '../tester.mjs';
import { fail, inProject, pass, step } from './lib.mjs';

const off = (ctx) => (ctx.root && testerOn(ctx.config) ? null : 'the tester is off');

// The plans in this checkout: [{ rel, text }]
function plansOf(ctx) {
  const out = [];
  const walk = (rel, depth) => {
    if (depth > 4) return;
    for (const name of ctx.list(ctx.path.join(ctx.root, ...rel.split('/'))).sort()) {
      const r = `${rel}/${name}`;
      const full = ctx.path.join(ctx.root, ...r.split('/'));
      if (ctx.isDir?.(full) && !/\.ya?ml$/i.test(name)) walk(r, depth + 1);
      else if (/\.ya?ml$/i.test(name) && !planPathProblem(r)) out.push({ rel: r, text: ctx.read(full) });
    }
  };
  walk(PLAN_DIR, 0);
  return out;
}

export const testerConfigCheck = {
  id: 'tester.config',
  title: "The tester's personas",
  severity: 'warn',
  sandbox: 'same',
  learnMore: 'docs/CHECKS.md#testerconfig',
  skipIf: off,
  run(ctx) {
    const t = ctx.config.tester;
    const envs = Object.entries(t.environments || {});
    // (the vault's file, joined the way this PC's paths are: the fake PC in the tests is POSIX on Windows too)
    const file = ctx.path.join(ctx.home, '.nextlevel', 'vault', vaultFile(ctx.root).split(/[\\/]/).pop());
    const kept = personasOf(vaultFromText(ctx.read(file) ?? ''));
    // which personas each environment needs: the ones the plans name, on the environments each plan runs on
    const need = new Map(envs.map(([name]) => [name, new Set()]));
    for (const { text } of plansOf(ctx)) {
      const r = readPlan(text ?? '');
      if (!r.plan) continue;
      for (const e of r.plan.env || envs.map(([name]) => name)) for (const s of r.plan.steps) if (s.as && need.has(e)) need.get(e).add(s.as);
    }
    const missing = [];
    for (const [name, e] of envs) {
      for (const persona of [...need.get(name)].sort()) {
        if (!kept.some((k) => k.env === name && k.persona === persona && k.origin === originOf(e.url))) missing.push({ env: name, persona, old: kept.some((k) => k.env === name && k.persona === persona) });
      }
    }
    const words = envs.map(([name, e]) => `${name} ${e.url}${e.production ? ' (production)' : ''}${(t.allowMutations || []).includes(name) ? ', steps that mutate may run' : ', read-only'}`).join('; ');
    if (!missing.length) return pass(`on: ${words}; ${t.personas.length} persona(s), every one a plan needs set on this PC`);
    return fail(`${missing.map((m) => `${m.persona} on ${m.env} isn't set${m.old ? ' (only for an old URL)' : ''}`).join('; ')}: the plans that use them can't sign in`, {
      next: 'set each one in your own window: what you type is never shown, and it stays on this PC',
      steps: missing.map((m) => inProject(ctx, `nextlevel tester persona set ${m.env} ${m.persona}`)),
    });
  },
};

export const testerVaultCheck = {
  id: 'tester.vault',
  title: "A safe place for the tester's sign-ins",
  severity: 'warn',
  sandbox: 'skip',
  learnMore: 'docs/CHECKS.md#testervault',
  skipIf: off,
  run(ctx) {
    const s = storeKind({ platform: ctx.platform, env: ctx.env, has: (cmd) => !!ctx.which(cmd) });
    const where = { dpapi: "Windows' own protection for your account (DPAPI)", keychain: 'your login keychain', 'secret-service': 'your keyring (Secret Service)', test: 'the stand-in store (tests)' };
    if (!s.problem) return pass(`the personas' sign-ins are sealed with ${where[s.kind]}, outside the project`);
    return fail(s.problem, {
      next: 'until then no persona can be set and no run signs in',
      steps: ctx.platform === 'linux' ? [step('terminal', 'sudo apt install libsecret-tools gnome-keyring')] : [],
    });
  },
};

export const testerPlansCheck = {
  id: 'tester.plans',
  title: 'Acceptance plans',
  severity: 'warn',
  sandbox: 'same',
  learnMore: 'docs/CHECKS.md#testerplans',
  skipIf: off,
  run(ctx) {
    const plans = plansOf(ctx);
    if (!plans.length) return pass(`no plan under ${PLAN_DIR}/ yet (docs/acceptance.md shows the format)`, { severity: 'info' });
    const bad = [];
    for (const { rel, text } of plans) {
      const r = readPlan(text ?? '', { file: rel });
      const problems = [...r.problems, ...(r.plan ? planFitProblems(r.plan, ctx.config) : [])];
      if (problems.length) bad.push(`${rel}${problems[0].line ? `:${problems[0].line}` : ''}: ${problems[0].message}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`);
    }
    if (!bad.length) return pass(`${plans.length} plan(s) read`);
    return fail(bad.slice(0, 5).join('; '), { next: 'the orchestrator fixes them (a run refuses a plan that does not read)', steps: [inProject(ctx, 'nextlevel tester check')] });
  },
};

export const testerReachCheck = {
  id: 'tester.reach',
  title: "The tester's environments answer",
  severity: 'warn',
  sandbox: 'skip',
  learnMore: 'docs/CHECKS.md#testerreach',
  skipIf: off,
  async run(ctx) {
    const out = [];
    const bad = [];
    for (const [name, e] of Object.entries(ctx.config.tester.environments || {})) {
      const r = await ctx.getUrl(`${originOf(e.url)}/`);
      if (r.problem) bad.push(`${name} (${e.url}): ${r.problem}`);
      else if (r.status >= 500) bad.push(`${name} (${e.url}) answers ${r.status}`);
      else out.push(`${name} answers ${r.status}`);
    }
    if (!bad.length) return pass(out.join('; ') || 'no environment');
    return fail(bad.join('; '), { next: "a run there ends incomplete until it answers: is the app up, and is the address in nextlevel.json's tester right?" });
  },
};

// What needs the browser: plans with browser steps, an environment that signs in through it -> [words]
function browserNeeds(ctx) {
  const out = [];
  for (const { rel, text } of plansOf(ctx)) if (readPlan(text ?? '').plan?.steps.some((s) => s.action && s.action.kind !== 'request')) out.push(rel);
  for (const name of Object.keys(ctx.config.tester.environments || {})) if (signInFor(ctx.config.tester, name)?.browser?.length) out.push(`${name}'s sign-in`);
  return out;
}

export const testerBrowserCheck = {
  id: 'tester.browser',
  title: "The tester's browser",
  severity: 'warn',
  sandbox: 'skip',
  learnMore: 'docs/CHECKS.md#testerbrowser',
  skipIf: off,
  fixInWindow: true, // (a download and a new browser: the owner's own window)
  fixPrompt: () => `Install Playwright ${PLAYWRIGHT.version} and its headless Chromium (${PLAYWRIGHT.download} to download, ${PLAYWRIGHT.disk} on disk) into ~/.nextlevel/tools, from the lock file nextlevel ships? An antivirus may look at the new browser.`,
  canFix: (r) => !!r.install,
  async fix(ctx) {
    const problem = await ctx.browser.install();
    if (problem) throw new Error(problem);
  },
  async run(ctx) {
    const need = browserNeeds(ctx);
    const needWords = need.length ? `${need.slice(0, 3).join(', ')}${need.length > 3 ? ` and ${need.length - 3} more` : ''} ${need.length > 1 ? 'need' : 'needs'} it` : 'no plan needs it yet';
    const s = ctx.browser.state({ quick: true });
    const install = [inProject(ctx, 'nextlevel tester browser install')];
    if (!s.ok) {
      return fail(`${s.problem} (${needWords})`, {
        install: true,
        severity: need.length ? 'warn' : 'info',
        next: `browser steps end incomplete until it is installed: ${PLAYWRIGHT.download}, from the lock file nextlevel ships, into ~/.nextlevel/tools (never the project's own Playwright)`,
        steps: install,
      });
    }
    const kept = ctx.cache.get('tester.browser');
    if (kept?.at === s.record.at && Date.now() - (kept.checked || 0) < 24 * 3600_000) return pass(`Playwright ${PLAYWRIGHT.version} and its headless Chromium, as installed; it opened a page ${new Date(kept.checked).toISOString().slice(0, 16).replace('T', ' ')} (${needWords})`);
    const probe = await ctx.browser.probe();
    if (probe) {
      return fail(`the browser is installed but doesn't open a page: ${probe}`, {
        install: true,
        severity: need.length ? 'warn' : 'info',
        next: 'if an antivirus stopped it, docs/ANTIVIRUS.md says what to do; else install it again',
        steps: install,
      });
    }
    ctx.cache.set('tester.browser', { at: s.record.at, checked: Date.now() });
    return pass(`Playwright ${PLAYWRIGHT.version} and its headless Chromium, as installed; it opens a page (${needWords})`);
  },
};

export const testerChecks = [testerConfigCheck, testerVaultCheck, testerPlansCheck, testerReachCheck, testerBrowserCheck];
