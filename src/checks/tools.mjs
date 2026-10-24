// Installed tools, their versions and the minimum each needs, with the install and update commands.
import { fail, firstLine, parseVersion, pass, step, versionAtLeast } from './lib.mjs';

const winget = (id, verb = 'install') => ({
  command: `winget ${verb} -e --id ${id}`,
  run: ['winget', [verb, '-e', '--id', id, '--accept-source-agreements', '--accept-package-agreements']],
});
const npmGlobal = (spec, extra = []) => ({ command: ['npm install -g', spec, ...extra].join(' '), run: ['npm', ['install', '-g', spec, ...extra], { shell: true }] });
const CLAUDE_PKG = '@anthropic-ai/claude-code';

// min: the oldest version known to work, with why; null where no older version has failed yet (add one
// when a field report shows it). install/update: { command (what the owner types), run (what --fix runs) }
// or { text } when only the owner can do it. newWindow: the tool changes PATH, or itself, for new windows only.
export const TOOLS = {
  git: {
    title: 'Git',
    min: '2.31.0',
    why: 'nextlevel uses git rev-parse --path-format, new in 2.31',
    install: (ctx) => (ctx.platform === 'win32' ? winget('Git.Git') : { text: 'install git with your package manager (https://git-scm.com/downloads)' }),
    update: (ctx) => (ctx.platform === 'win32' ? winget('Git.Git', 'upgrade') : { text: 'update git with your package manager' }),
    newWindow: true,
  },
  gh: {
    title: 'GitHub CLI',
    min: null,
    install: (ctx) => (ctx.platform === 'win32' ? winget('GitHub.cli') : { text: 'install it from https://cli.github.com' }),
    update: (ctx) => (ctx.platform === 'win32' ? winget('GitHub.cli', 'upgrade') : { text: 'update it: https://cli.github.com' }),
    newWindow: true,
  },
  codex: {
    title: 'Codex CLI',
    min: null,
    install: () => npmGlobal('@openai/codex'),
    update: () => npmGlobal('@openai/codex@latest'),
    newWindow: true,
  },
  agy: {
    title: 'Antigravity CLI',
    // The flags the hub passes (--print-timeout, --mode, --effort) are documented for 1.2.4; the
    // owner's 1.1.16 was older than them (FR-001 #4).
    min: '1.2.4',
    why: 'the flags the hub passes need 1.2.4 or newer',
    install: (ctx) =>
      ctx.platform === 'win32'
        ? { command: 'irm https://antigravity.google/cli/install.ps1 | iex', run: ['powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', 'irm https://antigravity.google/cli/install.ps1 | iex']] }
        : { command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash', run: ['sh', ['-c', 'curl -fsSL https://antigravity.google/cli/install.sh | bash']] },
    update: () => ({ command: 'agy update', run: ['agy', ['update']] }),
    newWindow: true,
  },
  claude: {
    title: 'Claude Code',
    min: null,
    // npm skips install scripts it hasn't been told to allow, and Claude Code needs its own (FR-001 #7).
    install: () => npmGlobal(CLAUDE_PKG, [`--allow-scripts=${CLAUDE_PKG}`]),
    update: () => npmGlobal(`${CLAUDE_PKG}@latest`, [`--allow-scripts=${CLAUDE_PKG}`]),
    newWindow: true,
  },
};

const stepFor = (how) => (how.command ? step('terminal', how.command) : step('terminal', null, { text: how.text }));

// A check that the tool runs, and is new enough. `severity` may depend on the project (a tool no role uses);
// `optional`: what it is still good for then (a text, or a function of ctx).
export function toolCheck(cmd, { id = `tool.${cmd}`, severity, versionArgs = ['--version'], optional = '', learnMore } = {}) {
  const t = TOOLS[cmd];
  return {
    id,
    title: t.title,
    severity,
    learnMore: learnMore || `docs/CHECKS.md#${id.replace(/\./g, '')}`,
    run(ctx) {
      const r = ctx.run(cmd, versionArgs);
      // Installers and updates change PATH (or the tool itself) for windows opened afterwards (FR-001 #4)
      const steps = (how) => [stepFor(how), ...(t.newWindow ? [step('new-terminal', 'nextlevel doctor', { cwd: ctx.root || undefined, text: 'to check again' })] : [])];
      const why = typeof optional === 'function' ? optional(ctx) : optional;
      if (r.missing) return fail(`not found${why ? ` (${why})` : ''}`, { missing: true, steps: steps(t.install(ctx)), next: 'install it' });
      if (!r.ok) {
        return fail(`installed, but "${cmd} ${versionArgs.join(' ')}" fails: ${firstLine(r.out) || `exit ${r.code}`}`, {
          steps: steps(t.install(ctx)),
          next: 'install it again',
          broken: true,
        });
      }
      const shown = firstLine(r.out);
      if (t.min && !versionAtLeast(parseVersion(shown), t.min)) {
        return fail(`${shown}: older than ${t.min} (${t.why})`, { old: true, steps: steps(t.update(ctx)), next: 'update it' });
      }
      return pass(shown);
    },
    fixPrompt: (r, ctx) => `${r.old ? 'Update' : 'Install'} ${t.title} (${(r.old ? t.update : t.install)(ctx).command})?`,
    fix(ctx, ui, r) {
      const how = (r.old ? t.update : t.install)(ctx);
      const [file, args, opts] = how.run;
      ui.run(file, args, { shell: !!opts?.shell && ctx.platform === 'win32' });
      if (t.newWindow) ui.say(`If ${t.title} still shows as not found or old below, open a new PowerShell window and run nextlevel doctor there.`);
    },
    // Fixable when there is a command to run; a tool that is there but fails is installed again
    canFix: (r, ctx) => !!(r.old ? t.update : t.install)(ctx).run,
    // Installers ask for permission and show progress, and the new PATH reaches new windows only
    fixInWindow: true,
  };
}

export const dockerCheck = {
  id: 'tool.docker',
  title: 'Docker',
  severity: 'warn',
  learnMore: 'docs/CHECKS.md#tooldocker',
  run(ctx) {
    const r = ctx.run('docker', ['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 30000 });
    if (r.missing) {
      return fail('not installed', {
        steps: [ctx.platform === 'win32' ? step('terminal', 'winget install -e --id Docker.DockerDesktop') : step('browser', 'https://docs.docker.com/get-docker/')],
      });
    }
    if (!r.ok) {
      return fail(r.timedOut ? 'no answer in 30 s (still starting?)' : 'not running', {
        next: 'start Docker Desktop',
        steps: [step('app', null, { text: 'start Docker Desktop and wait until it says "Engine running"' })],
      });
    }
    return pass(`engine ${firstLine(r.out)}`);
  },
};
