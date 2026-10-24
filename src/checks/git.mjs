// Git and GitHub: identity (FR-001 #3), the first commit (FR-001 #2), branch, remote, GitHub sign-in.
import { withIgnores } from '../init.mjs';
import { READ_TOKEN, READ_TOKEN_PERMISSIONS, tokenExpiry } from '../lib/github.mjs';
import { parseEnvText } from '../lib/envfile.mjs';
import { githubRepo } from './engines.mjs';
import { fail, firstLine, inProject, pass, step } from './lib.mjs';
import { toolCheck } from './tools.mjs';

const needsProject = (ctx) => (ctx.root ? null : 'no project');

function identity(ctx) {
  const ident = ctx.git(['var', 'GIT_AUTHOR_IDENT']); // fails exactly when git commit would
  const name = ctx.git(['config', 'user.name']).out || ctx.env.GIT_AUTHOR_NAME || '';
  const email = ctx.git(['config', 'user.email']).out || ctx.env.GIT_AUTHOR_EMAIL || ctx.env.EMAIL || '';
  return { ok: ident.ok && !!name && !!email, guessed: ident.ok, error: firstLine(ident.err) };
}
const IDENTITY_STEPS = [
  step('terminal', 'git config --global user.name "Your Name"'),
  step('terminal', 'git config --global user.email "you@example.com"'),
];
const hasCommits = (ctx) => ctx.git(['rev-parse', '--verify', '--quiet', 'HEAD']).ok;

export const gitTool = toolCheck('git');
export const ghTool = toolCheck('gh');

export const identityCheck = {
  id: 'git.identity',
  title: 'Git identity',
  requires: ['tool.git'],
  learnMore: 'docs/CHECKS.md#gitidentity',
  run(ctx) {
    const id = identity(ctx);
    if (id.ok) return pass('set');
    return fail(id.guessed ? 'not set (git would guess one from this PC\'s name)' : 'not set: git can\'t commit', {
      next: 'set it once for this PC (the email of your GitHub account links your commits to it)',
      steps: IDENTITY_STEPS,
    });
  },
  fixPrompt: 'Set your git name and email for this PC now?',
  canFix: (r, ctx, ui) => ui.interactive,
  async fix(ctx, ui) {
    const name = (await ui.input('Your name for commits (e.g. Ada Lovelace): '))?.trim();
    const email = (await ui.input('Your email for commits (the one on your GitHub account): '))?.trim();
    if (!name || !email || !email.includes('@')) return ui.say('Not changed: give both a name and an email.');
    ctx.git(['config', '--global', 'user.name', name]);
    ctx.git(['config', '--global', 'user.email', email]);
  },
};

export const ghAuthCheck = {
  id: 'gh.auth',
  title: 'GitHub sign-in',
  requires: ['tool.gh'],
  learnMore: 'docs/CHECKS.md#ghauth',
  run(ctx) {
    const r = ctx.run('gh', ['auth', 'status']);
    if (r.ok) return pass('signed in');
    return fail('not signed in', { steps: [step('terminal', 'gh auth login', { text: 'it opens the browser; choose GitHub.com, HTTPS, and log in with the browser' })] });
  },
};

// FR-017: a verify command runs without the owner's GitHub sign-in; the orchestrator reads CI through it (inside Codex's
// sandbox it has no other way), so an optional read-only token in the project's .env gives those reads back
// (lib/github.mjs). Missing: how to make one. Set: whether it reads the repository, and when it expires (a warning a week
// before, from the date GitHub reports). A classic token isn't read-only: said so.
const DAY = 24 * 3_600_000;
const tokenSteps = (ctx, repo) => [
  step('browser', 'https://github.com/settings/personal-access-tokens/new', {
    text: `Generate a fine-grained token: Repository access: Only select repositories, ${repo}; Repository permissions: ${READ_TOKEN_PERMISSIONS.join(', ')} (Metadata: Read-only comes with them), nothing else; an expiration date (the doctor warns a week before). An organization's repository may need its owner to approve the token`,
  }),
  step('editor', null, { text: `in ${ctx.path.join(ctx.root, '.env')} add the line ${READ_TOKEN}=<the token> (.env is never committed, and nextlevel never gives it to a worker)` }),
];
export const readTokenCheck = {
  id: 'gh.read-token',
  title: 'GitHub reads for verify',
  severity: 'info',
  sandbox: 'skip', // it asks GitHub
  requires: ['tool.gh'],
  skipIf: needsProject,
  learnMore: 'docs/CHECKS.md#ghread-token',
  run(ctx) {
    const repo = githubRepo(ctx.git(['config', '--get', 'remote.origin.url']).out);
    if (!repo) return pass("the project's origin isn't on GitHub", { quiet: true });
    const token = String(parseEnvText(ctx.read(ctx.path.join(ctx.root, '.env')))[READ_TOKEN] || '').trim();
    if (!token) {
      return fail(`not set: verify commands run without your GitHub sign-in (FR-017), so the orchestrator can't read ${repo}'s CI through them`, {
        next: `a read-only token in the project's .env (${READ_TOKEN}) lets them read; GitHub refuses any write made with it`,
        steps: tokenSteps(ctx, repo),
      });
    }
    if (/^(ghp|gho|ghu|ghs)_/.test(token)) {
      return fail(`${READ_TOKEN} in .env is a classic token, which can write whatever its scopes allow: a verify command could write to GitHub with it`, {
        severity: 'warn',
        next: 'replace it with a fine-grained token that can only read the repository',
        steps: tokenSteps(ctx, repo),
      });
    }
    const r = ctx.run('gh', ['api', '-i', `repos/${repo}`], { env: { ...ctx.env, GH_TOKEN: token, GITHUB_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' } });
    if (!r.ok) {
      return fail(`${READ_TOKEN} in .env doesn't read ${repo}: ${firstLine(String(r.out || '').split(/\r?\n/).filter((l) => /HTTP \d{3}|error|not found|credentials/i.test(l)).join(' ')) || 'GitHub refused it'}`, {
        severity: 'warn',
        next: 'it may have expired, or not be for this repository: make a new one',
        steps: tokenSteps(ctx, repo),
      });
    }
    const expires = tokenExpiry(r.out);
    const date = expires ? expires.toISOString().slice(0, 10) : '';
    if (expires && expires.getTime() - Date.now() < 7 * DAY) {
      return fail(`${READ_TOKEN} in .env reads ${repo}, and expires on ${date}`, { severity: 'warn', next: 'make a new one before then, and replace the line in .env', steps: tokenSteps(ctx, repo) });
    }
    return pass(`reads ${repo}${date ? `; expires on ${date}` : ''}`);
  },
};

export const repoChecks = [
  {
    id: 'git.commits',
    title: 'Commits',
    sandbox: 'same', // the project only
    requires: ['tool.git'],
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#gitcommits',
    run(ctx) {
      if (hasCommits(ctx)) return pass('yes');
      return fail('none yet', {
        next: 'workers get their copy of the project from a commit',
        steps: [inProject(ctx, 'git add -A'), inProject(ctx, 'git commit -m "first commit"')],
      });
    },
    fixPrompt: 'Make the first commit now (git add -A, then git commit -m "first commit")?',
    canFix: (r, ctx) => !ctx.sandbox, // the sandbox can't write .git (FR-004 #1)
    fix(ctx, ui) {
      if (!identity(ctx).ok) return ui.say('First set your git identity (see "Git identity" above), then run the doctor again.');
      // Never commit secrets: .env must be ignored by the project's own .gitignore first.
      if (withIgnores(ctx.read(ctx.path.join(ctx.root, '.gitignore')) || '').missing.includes('.env')) {
        return ui.say('Not committing: .gitignore doesn\'t ignore .env yet, so your secrets would go into git. Fix ".gitignore" first.');
      }
      const add = ctx.git(['add', '-A']);
      const commit = add.ok && ctx.git(['commit', '-q', '-m', 'first commit']);
      if (!add.ok || !commit.ok) return ui.say(`git said: ${firstLine((add.ok ? commit : add).err) || 'failed'}`);
      const files = ctx.git(['ls-files']).out.split(/\r?\n/).filter(Boolean).length;
      ui.say(`Made the first commit (${files} files).`);
    },
  },
  {
    id: 'git.remote',
    title: 'GitHub repo',
    sandbox: 'same', // the project only
    requires: ['tool.git'],
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#gitremote',
    run(ctx) {
      const r = ctx.git(['remote', 'get-url', 'origin']);
      if (r.ok) return pass(r.out); // a login in the URL is blanked out by the runner, like every secret
      const name = ctx.config.name.replace(/[^A-Za-z0-9._-]+/g, '-');
      const cmd = `gh repo create ${name} --private --source . --remote origin --push`;
      return fail('no origin remote', { next: 'the project needs a GitHub repository (private is fine)', steps: [inProject(ctx, cmd)] });
    },
  },
  {
    id: 'git.pushed',
    title: 'On GitHub',
    sandbox: 'same', // the project only
    severity: 'warn',
    requires: ['git.commits', 'git.remote'],
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#gitpushed',
    run(ctx) {
      const base = ctx.config.baseBranch;
      // What this PC last saw of origin (no network): enough to tell "never pushed".
      if (ctx.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${base}`]).ok) return pass(`origin has ${base}`);
      return fail(`${base} isn't on origin yet`, { steps: [inProject(ctx, `git push -u origin ${base}`)] });
    },
  },
  {
    id: 'git.branch',
    title: 'Branch',
    sandbox: 'same', // the project only
    requires: ['tool.git'],
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#gitbranch',
    run(ctx) {
      const base = ctx.config.baseBranch;
      const branch = ctx.git(['symbolic-ref', '--short', 'HEAD']).out || ctx.git(['rev-parse', '--abbrev-ref', 'HEAD']).out;
      if (branch === base) return pass(branch);
      // Tasks start from the base branch: without it no worker can start; with it, only the hub's push refuses.
      const exists = ctx.git(['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]).ok;
      const cmd = exists ? `git switch ${base}` : `git branch -M ${base}`;
      return fail(branch || '(none)', {
        severity: exists ? 'warn' : 'error',
        next: `tasks start from ${base} (or set baseBranch in nextlevel.json)`,
        steps: [inProject(ctx, cmd)],
      });
    },
  },
  {
    id: 'git.clean',
    title: 'Uncommitted files',
    sandbox: 'same', // the project only
    severity: 'info',
    requires: ['git.commits'],
    skipIf: needsProject,
    learnMore: 'docs/CHECKS.md#gitclean',
    run(ctx) {
      const n = ctx.git(['status', '--porcelain']).out.split(/\r?\n/).filter(Boolean).length;
      if (!n) return pass('none');
      return fail(`${n}: workers start from the last commit, so they don't see these`, { steps: [inProject(ctx, 'git status')] });
    },
  },
];
