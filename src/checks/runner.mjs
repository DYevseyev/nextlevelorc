// GitHub checks on this PC (the self-hosted runner's part A, docs/design/self-hosted-runner.md, point 7): what the
// recommendation rests on, before any runner exists. runner.visibility: whether the repository is one it can be
// offered for (only a personal account's private repository); runner.forks: fork pull requests' workflows off;
// runner.collaborators: who else can push, and so could run code on the PC. Read with the owner's gh (GETs), read afresh
// each doctor run (lib/ghrepo.mjs). Part B adds the runner's own checks.
import { offer, readRepoFacts } from '../lib/ghrepo.mjs';
import { agentSession, ownerOnly } from '../lib/session.mjs';
import { githubRepo } from './engines.mjs';
import { fail, firstLine, pass, step } from './lib.mjs';

const projectRepo = (ctx) => (ctx.root ? githubRepo(ctx.git(['config', '--get', 'remote.origin.url']).out) : null);
const gh = (ctx) => (args) => ctx.run('gh', args, { timeoutMs: 20000 });
// what the three checks read (the workflows and the minutes are the Team page's)
const PARTS = { workflows: false, minutes: false };
// read from GitHub once per doctor run (the three checks share it), never from the Team page's kept facts: a fork
// setting turned on a minute ago must show here, and a fix must see what GitHub says now. The doctor writes no cache.
const read = new WeakMap();
const factsOf = (ctx) => {
  if (!read.has(ctx)) read.set(ctx, readRepoFacts(projectRepo(ctx), gh(ctx), { parts: PARTS }));
  return read.get(ctx);
};
const noRepo = (ctx) => (!ctx.root ? 'no project' : projectRepo(ctx) ? null : "the project's origin isn't on GitHub");
// a repository it isn't offered for: the other checks have nothing to say (runner.visibility says why)
const offered = (f) => ['recommended', 'offered'].includes(offer(f).state);
const NOT_OFFERED = () => pass("not a repository it's offered for (runner.visibility)", { quiet: true });
const settingsStep = (slug) => step('browser', `https://github.com/${slug}/settings/actions`, { text: 'Fork pull request workflows in private repositories: leave "Run workflows from fork pull requests" unticked' });

export const visibilityCheck = {
  id: 'runner.visibility',
  title: 'GitHub checks on this PC',
  // information until a runner is set up (part B makes it an error for a runner on a repository that isn't private)
  severity: 'info',
  sandbox: 'skip', // it asks GitHub
  requires: ['gh.auth'],
  skipIf: noRepo,
  learnMore: 'docs/CHECKS.md#runnervisibility',
  async run(ctx) {
    const slug = projectRepo(ctx);
    const f = await factsOf(ctx);
    const o = offer(f);
    if (o.state === 'unknown') return fail(`can't tell whether ${slug} is private: ${f.error}`, { next: 'nothing is offered until gh can answer (gh auth status)' });
    if (o.state === 'not-offered') return pass(`${slug} is ${f.visibility === 'private' ? `an organization's private repository` : f.visibility}: running its checks on this PC isn't offered`, { why: o.why });
    return pass(`${slug} is a personal account's private repository: running its checks on this PC can be offered (Team -> GitHub checks)`);
  },
};

// Fork pull requests' workflows in a private repository: off, or a stranger's fork could run code on the runner
export const forksCheck = {
  id: 'runner.forks',
  title: 'Fork pull requests',
  severity: 'error',
  sandbox: 'skip',
  requires: ['runner.visibility'],
  skipIf: noRepo,
  learnMore: 'docs/CHECKS.md#runnerforks',
  async run(ctx) {
    const slug = projectRepo(ctx);
    const f = await factsOf(ctx);
    if (!offered(f)) return NOT_OFFERED();
    if (!f.forks) return fail(`can't read the fork pull request settings of ${slug}: ${f.forksError || 'no answer'}`, { severity: 'warn', next: 'they can be read only with admin rights on the repository', admin: f.admin, steps: [settingsStep(slug)] });
    const { run, approval, writeTokens, secrets } = f.forks;
    if (!run) return pass('workflows from fork pull requests are off');
    const loose = [!approval && 'no approval is required', writeTokens && 'they get write tokens', secrets && 'they get secrets and variables'].filter(Boolean);
    if (!loose.length) return fail('workflows from fork pull requests are on (each needs your approval, with no write token and no secrets)', { severity: 'warn', next: 'turn them off before running checks on this PC', admin: f.admin, steps: [settingsStep(slug)] });
    return fail(`workflows from fork pull requests are on: ${loose.join(', ')}. Anyone who can fork it could run code where its checks run`, { next: 'turn them off (Fix does it with your gh)', admin: f.admin, steps: [settingsStep(slug)] });
  },
  fixPrompt: () => 'Turn off workflows from fork pull requests on GitHub, with your gh?',
  canFix: (r) => r.admin === true,
  async fix(ctx, ui) {
    // a repository's setting: only the owner's own click or window, never an agent (FR-017: no wall, KNOWN_ISSUES)
    const session = agentSession();
    if (session) return ui.say(ownerOnly('the fix of runner.forks', 'The owner runs it from the Setup page or their own window.', session));
    const slug = projectRepo(ctx);
    const r = ctx.run('gh', ['api', '-X', 'PUT', `repos/${slug}/actions/permissions/fork-pr-workflows-private-repos`, '-F', 'run_workflows_from_fork_pull_requests=false', '-F', 'send_write_tokens_to_workflows=false', '-F', 'send_secrets_and_variables=false', '-F', 'require_approval_for_fork_pr_workflows=true'], { timeoutMs: 20000, fresh: true });
    if (!r.ok) ui.say(`gh said: ${firstLine(r.out) || 'failed'}`);
    read.delete(ctx); // the check runs again on what GitHub says now (after the doctor forgets its kept answers)
  },
};

// Who else can push: each could run code on this PC once its checks run here
export const collaboratorsCheck = {
  id: 'runner.collaborators',
  title: 'Who can push',
  severity: 'warn',
  sandbox: 'skip',
  requires: ['runner.visibility'],
  skipIf: noRepo,
  learnMore: 'docs/CHECKS.md#runnercollaborators',
  async run(ctx) {
    const slug = projectRepo(ctx);
    const f = await factsOf(ctx);
    if (!offered(f)) return NOT_OFFERED();
    if (!f.collaborators) return fail(`can't read who can push to ${slug}: ${f.collaboratorsError || 'no answer'}`, { next: 'it needs push rights on the repository' });
    const others = f.collaborators.filter((c) => c.push && c.login.toLowerCase() !== String(f.owner).toLowerCase());
    if (!others.length) return pass(`only ${f.owner} can push`);
    return fail(`${others.length === 1 ? '1 other account' : `${others.length} other accounts`} can push to ${slug}: ${others.map((c) => `${c.login}${c.type === 'Bot' ? ' (an app)' : ''}`).join(', ')}`, {
      next: 'once its checks run on this PC, each of them could run code here (a workflow they push runs as the runner\'s account)',
      steps: [step('browser', `https://github.com/${slug}/settings/access`, { text: 'who can push: remove anyone who shouldn\'t' })],
    });
  },
};

export const runnerChecks = [visibilityCheck, forksCheck, collaboratorsCheck];
