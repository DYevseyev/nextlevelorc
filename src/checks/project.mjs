// The project folder and its files: where the project is (FR-001 #1), nextlevel.json, role docs, the milestone plans,
// .gitignore, .env and phone notifications.
import { CONFIG_FILE, SETTING_KEYS, formatConfig } from '../lib/config.mjs';
import { isProtected, protectedList } from '../lib/protect.mjs';
import { MERGES_LOG, buildRoadmap, isBridgeTask, isTaskSpec, mergeJobsDone, mergedTasks, parseBrief, parsePlan, planProblems, specMilestone } from '../lib/roadmap.mjs';
import { closuresOf } from '../lib/closures.mjs';
import { isDone, statusMilestones } from '../lib/state.mjs';
import { OLD_TEMPLATES, isEnvExampleTemplate, templateHash } from '../lib/templates.mjs';
import { withIgnores } from '../init.mjs';
import { parseEnvText } from '../notify.mjs';
import { fail, inProject, pass, step } from './lib.mjs';

const needsProject = (ctx) => (ctx.root ? null : 'no project');
const rel = (ctx, p) => ctx.path.relative(ctx.root, p) || '.';
// project.decisions: how long docs/DECISIONS.md may grow, and where its older entries go (FR-012)
export const DECISIONS_MAX_LINES = 1000;
export function decisionsArchive(file) {
  const dot = file.lastIndexOf('.');
  const folder = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'));
  return dot > folder + 1 && dot < file.length - 1 ? `${file.slice(0, dot)}-archive${file.slice(dot)}` : `${file}-archive`;
}

// Files nextlevel puts in a project, looked for up to two folders down: a kit unzipped into a subfolder
// (FR-001 #1) leaves them there instead of at the project's top folder.
function misplaced(ctx) {
  const marks = [CONFIG_FILE, 'START.cmd'];
  const skip = new Set(['.git', 'node_modules', '.nextlevel']);
  const found = [];
  const walk = (dir, depth) => {
    for (const name of ctx.list(dir)) {
      if (skip.has(name)) continue;
      const p = ctx.path.join(dir, name);
      if (!ctx.isDir(p)) continue;
      if (marks.some((m) => ctx.exists(ctx.path.join(p, m)))) found.push(p);
      else if (depth < 2) walk(p, depth + 1);
    }
  };
  walk(ctx.root, 1);
  return found.slice(0, 3);
}

// Role docs from an older nextlevel, unchanged (the hashes are in lib/templates.mjs).
export { OLD_TEMPLATES, templateHash };
function roleDocs(ctx) {
  const roles = ctx.config.paths.roles;
  const docs = [
    { template: 'docs/agents/ORCHESTRATOR.md', file: roles.orchestrator },
    { template: 'docs/agents/GUIDE.md', file: roles.guide },
    { template: 'docs/agents/WORKER.md', file: roles.worker },
    // (safe updates: the other templates init offers, when they are an older one unchanged; START.cmd is the update's,
    // which replaces it only while no cmd.exe runs it)
    { template: 'AGENTS.md', file: 'AGENTS.md', other: true },
    { template: 'docs/tasks/_TEMPLATE.md', file: `${ctx.config.paths.tasks}/_TEMPLATE.md`, other: true },
  ];
  return docs.map((d) => {
    const text = ctx.read(ctx.path.join(ctx.root, d.file));
    const old = text !== null && OLD_TEMPLATES[d.template].includes(templateHash(text));
    // A doc of the owner's own that still has the orchestrator run git itself (FR-004 #1)
    const gitByHand = !old && text !== null && d.template.includes('ORCHESTRATOR') && !/nextlevel (commit|merge)\b/.test(text);
    // ... or that retries on an engine it names instead of the workers' fallback in nextlevel.json (FR-008)
    const namedEngine = !old && text !== null && !d.template.includes('WORKER') && (text.match(/\bretry\b[^\n]*?(--engine[ =](?:codex|agy|claude))\b/) || [])[1];
    // ... or that edits the owner's notes and the handoff list by hand, which nextlevel now writes from its cards (M10)
    const notesByHand = !old && text !== null && d.template.includes('ORCHESTRATOR') && /OWNER_NOTES\.md|HANDOFF\.md/.test(text) && !/nextlevel (note|handoff)\b/.test(text);
    // ... or that doesn't keep the project page, plan headers and labeled blockers the dashboard shows (M11)
    const noProjectPage = !old && text !== null && d.template.includes('ORCHESTRATOR') && !/PROJECT\.md/.test(text);
    if (d.other) return { ...d, old, gitByHand: false, namedEngine: '', notesByHand: false, noProjectPage: false };
    return { ...d, old, gitByHand, namedEngine: namedEngine || '', notesByHand, noProjectPage };
  });
}

// The roadmap as the dashboard's Project page builds it (hub.mjs, projectView), from the same files: the status
// table, the brief, the plans, the task specs, the hub's task jobs and the merged task branches (FR-016).
function roadmapOf(ctx) {
  const p = ctx.config.paths;
  const at = (rel) => ctx.path.join(ctx.root, ...rel.split(/[\\/]/));
  const md = (dir) => ctx.list(dir).filter((f) => f.endsWith('.md')).sort();
  const plans = md(at(p.plans)).map((f) => ({ file: `${p.plans}/${f}`.replace(/\\/g, '/'), ...parsePlan(ctx.read(at(`${p.plans}/${f}`))) }));
  const specs = md(at(p.tasks))
    .filter(isTaskSpec)
    .map((f) => ({ id: f.replace(/\.md$/i, ''), milestone: specMilestone(ctx.read(at(`${p.tasks}/${f}`))) }));
  const jobs = [];
  const merges = []; // the hub's finished merge jobs (FR-021)
  const jobsDir = ctx.stateDir && ctx.path.join(ctx.stateDir, 'jobs');
  const json = (f) => JSON.parse(ctx.read(f) || 'null');
  for (const id of jobsDir ? ctx.list(jobsDir) : []) {
    try {
      const job = json(ctx.path.join(jobsDir, id, 'status.json'));
      if (job?.type === 'task' && !isBridgeTask(job.id || id)) jobs.push({ id: job.id || id, state: job.state });
      else if (job?.type === 'git' && job.state === 'done' && id.startsWith('merge-')) merges.push({ status: job, job: json(ctx.path.join(jobsDir, id, 'job.json')) });
    } catch {
      // a job being written: the next run reads it
    }
  }
  let closed = new Map();
  try {
    closed = closuresOf(ctx.stateDir ? json(ctx.path.join(ctx.stateDir, 'closed.json')) : null);
  } catch {
    // none, or being written
  }
  const log = ctx.git(MERGES_LOG);
  const status = statusMilestones(ctx.read(at(p.status))).map(([name, state = '', verified = '']) => ({ name, state, verified, done: isDone(state) }));
  return buildRoadmap({ status, brief: parseBrief(ctx.read(at('BRIEF.md'))), plans, specs, jobs, merged: mergedTasks(log.ok ? log.out : '', mergeJobsDone(merges)), closed, plansDir: p.plans });
}

// The newest version of .env.example in git that isn't a nextlevel template, if every version after it
// is one: the project's own, which a template replaced (FR-005). { sha, short, date } or null.
function ownEnvExample(ctx) {
  const log = ctx.git(['log', '--format=%H %cs', '-n', '30', '--', '.env.example']);
  if (!log.ok) return null;
  for (const line of log.out.split(/\r?\n/).filter(Boolean)) {
    const [sha, date] = line.trim().split(/\s+/);
    const shown = ctx.git(['show', `${sha}:.env.example`]);
    if (!shown.ok) return null; // deleted in that commit: nothing to bring back
    if (!isEnvExampleTemplate(shown.out)) return { sha, short: sha.slice(0, 7), date };
  }
  return null;
}

export const projectChecks = [
  {
    id: 'project.folder',
    title: 'Project',
    sandbox: 'same', // the project only
    learnMore: 'docs/CHECKS.md#projectfolder',
    run(ctx) {
      if (!ctx.root) {
        return fail('this folder is not inside a git repository', {
          message: ctx.problem,
          steps: [
            step('terminal', 'cd "C:\\path\\to\\your\\project"', { text: 'go to your project\'s folder, then run nextlevel doctor again' }),
            step('terminal', 'git init -b main', { text: 'or start a new project in this folder, then: nextlevel init' }),
          ],
        });
      }
      const sub = ctx.path.relative(ctx.root, ctx.cwd);
      const inSub = sub && !sub.startsWith('..') && !ctx.path.isAbsolute(sub);
      return pass(inSub ? `${ctx.root}  (this window is in its subfolder ${sub})` : ctx.root);
    },
  },
  {
    id: 'project.config',
    title: CONFIG_FILE,
    sandbox: 'same', // the project only
    learnMore: 'docs/CHECKS.md#projectconfig',
    skipIf: needsProject,
    run(ctx) {
      const info = ctx.configInfo;
      if (info.error) return fail(info.error.split('\n')[0], { message: info.error, next: `fix ${CONFIG_FILE} (the lines above say what), or rename it and run nextlevel init` });
      if (!info.exists) {
        const found = misplaced(ctx);
        if (found.length) {
          return fail(`missing here, but found nextlevel files in ${found.map((f) => rel(ctx, f)).join(', ')}`, {
            next: `the project's top folder is ${ctx.root}: move those files up to it, or start fresh there`,
            steps: [step('terminal', 'nextlevel init', { cwd: ctx.root, text: 'starts fresh in the top folder' })],
          });
        }
        return fail('missing (using defaults)', { steps: [inProject(ctx, 'nextlevel init')] });
      }
      if (info.warnings.length) return fail(info.warnings.join('; '), { severity: 'warn', next: `fix ${CONFIG_FILE}` });
      return pass('ok');
    },
  },
  {
    id: 'project.state',
    title: 'State folder',
    sandbox: 'same', // the project only
    severity: 'info',
    learnMore: 'docs/CHECKS.md#projectstate',
    skipIf: needsProject,
    run(ctx) {
      const name = ctx.stateDir ? ctx.path.basename(ctx.stateDir) : '.nextlevel';
      return pass(`${name}/`);
    },
  },
  {
    id: 'project.roles',
    title: 'Role docs',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#projectroles',
    skipIf: (ctx) => needsProject(ctx) || (!ctx.configInfo.exists && 'needs nextlevel.json'),
    run(ctx) {
      const p = ctx.config.paths;
      const files = [...Object.values(p.roles), `${p.tasks}/_TEMPLATE.md`];
      const missing = files.filter((f) => !ctx.exists(ctx.path.join(ctx.root, f)));
      if (!missing.length) return pass(`${files.length} files in place`);
      return fail(`missing: ${missing.join(', ')}`, { next: 'the orchestrator and workers are told to follow them', steps: [inProject(ctx, 'nextlevel init')] });
    },
  },
  {
    id: 'project.role-docs',
    title: 'Role docs version',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#projectrole-docs',
    skipIf: (ctx) => needsProject(ctx) || (!ctx.configInfo.exists && 'needs nextlevel.json'),
    run(ctx) {
      const docs = roleDocs(ctx);
      const old = docs.filter((d) => d.old).map((d) => d.file);
      const own = docs.filter((d) => d.gitByHand).map((d) => d.file);
      const named = docs.filter((d) => d.namedEngine);
      const byHand = docs.filter((d) => d.notesByHand).map((d) => d.file);
      const noPage = docs.filter((d) => d.noProjectPage).map((d) => d.file);
      if (!old.length && !own.length && !named.length && !byHand.length && !noPage.length) return pass('current', { quiet: true });
      const parts = [
        old.length && `${old.join(', ')}: an older nextlevel template, unchanged`,
        own.length && `${own.join(', ')}: tells the orchestrator to commit and merge with git itself, which Codex's sandbox refuses (nextlevel commit and merge do it)`,
        named.length &&
          `${named.map((d) => d.file).join(', ')}: ${named.length === 1 ? 'retries' : 'retry'} a task with ${[...new Set(named.map((d) => d.namedEngine))].join(', ')} instead of the workers' fallback in nextlevel.json (retry --fallback, FR-008)`,
        byHand.length && `${byHand.join(', ')}: has the orchestrator edit the owner's notes and the handoff list by hand, which nextlevel now writes from its cards (nextlevel note, nextlevel handoff)`,
        noPage.length && `${noPage.join(', ')}: doesn't have the orchestrator keep docs/PROJECT.md, the plan headers (Outcome, Acceptance, Try it) and the labeled blockers that the dashboard shows`,
      ].filter(Boolean);
      return fail(parts.join('; '), {
        old,
        next: old.length ? 'the doctor can put the current template in its place (nothing of yours is in it)' : 'the step below shows the difference to the template and asks first',
        steps: [inProject(ctx, 'nextlevel init')],
      });
    },
    fixPrompt: (r) => `Replace ${r.old.join(' and ')} with the current template (they are an older one, unchanged)?`,
    canFix: (r) => r.old?.length > 0,
    fix(ctx, ui) {
      for (const d of roleDocs(ctx).filter((x) => x.old)) {
        const template = ctx.read(ctx.path.join(ctx.toolRoot, 'templates', 'project', ...d.template.split('/')));
        if (template === null) return ui.say(`The template ${d.template} is missing from ${ctx.toolRoot}: reinstall nextlevel.`);
        ctx.write(ctx.path.join(ctx.root, d.file), template);
        ui.say(`Updated ${d.file} to the current template. Commit it with your next change.`);
      }
    },
  },
  {
    // FR-012: a real project's docs/DECISIONS.md grew to almost 6,000 lines, a log of every round rather than its decisions,
    // and the orchestrator reads it at every start. Past about 1,000 lines the older entries go to an archive.
    id: 'project.decisions',
    title: 'Decisions file',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#projectdecisions',
    skipIf: (ctx) => needsProject(ctx) || (!ctx.configInfo.exists && 'needs nextlevel.json'),
    run(ctx) {
      const file = ctx.config.paths.decisions;
      const text = ctx.read(ctx.path.join(ctx.root, file));
      if (text === null) return pass('none yet', { quiet: true });
      const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').length;
      if (lines <= DECISIONS_MAX_LINES) return pass(`${lines} lines`, { quiet: true });
      const archive = decisionsArchive(file);
      const n = (x) => x.toLocaleString('en-US');
      // (the command only for a plain path: a shell would read $, quotes or backticks in one pasted between quotes)
      const plain = /^[\w./-]+$/.test(file);
      return fail(`${file} has ${n(lines)} lines, past about ${n(DECISIONS_MAX_LINES)}: the orchestrator reads it at every start, so every round pays for it and the decisions that matter get lost in it`, {
        archive,
        next: `archive its older entries: move them, whole, to the end of ${archive}, and keep only decisions in ${file} from now on (what was decided and why; what happened in a round is in that round's log)`,
        steps: [
          plain && step('terminal', `nextlevel note add "Archive ${file}: move every entry but the newest (keep about the last 200 lines) to the end of ${archive}, whole and in their order, and put a line at the top of ${file} that names the archive. Commit both. From now on ${file} records decisions only: what was decided and why."`, {
            cwd: ctx.root,
            text: 'asks the orchestrator to do it at its next start or round: it keeps that file',
          }),
          step('editor', null, {
            text: `${plain ? 'or by hand' : 'by hand'}, while no autopilot round runs: in ${file}, cut every entry but the newest (each starts with a line "## <date> ..."; keep about the last 200 lines), paste them at the end of ${archive} (make it if it isn't there), put a line "Older decisions: ${archive}" at the top of ${file}, and commit both files`,
          }),
        ].filter(Boolean),
      });
    },
  },
  {
    // FR-016: a real project's orchestrator wrote the Walking skeleton's plan as docs/plans/WS-walking-skeleton.md, which the
    // Project page didn't find (it looked for walking-skeleton.md): "No plan yet" for a milestone with 33 merged tasks,
    // and nothing warned. The page finds plans by what they say and their names now (lib/roadmap.mjs); this says what
    // it still can't find, a plan without Outcome, Acceptance or Try it, and two plans that claim one milestone.
    id: 'project.plans',
    title: 'Milestone plans',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#projectplans',
    skipIf: (ctx) => needsProject(ctx) || (!ctx.configInfo.exists && 'needs nextlevel.json'),
    run(ctx) {
      const p = ctx.config.paths;
      const roadmap = roadmapOf(ctx);
      const problems = planProblems(roadmap, { plansDir: p.plans });
      const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
      if (!problems.length) {
        const busy = roadmap.filter((m) => m.counts.total).length;
        return pass(roadmap.length ? `${n(roadmap.filter((m) => m.plan).length, 'plan')} for ${n(roadmap.length, 'milestone')}${busy ? `; each with tasks has one, with Outcome, Acceptance and Try it` : ''}` : 'no milestones yet', { quiet: true });
      }
      // (the command only when it is plain: PowerShell and nextlevel.cmd change $, %, !, ^, & and quotes)
      const asked = `Fix the milestone plans the doctor warns about: ${problems.map((x) => x.text).join(' ')} Each plan is ${p.plans}/<milestone id or name>.md, with the line Milestone: <its name as in ${p.status}> under its title, then Outcome, Acceptance and Try it.`.replace(/"/g, "'");
      const plain = /^[\w .,:;'()/<>+-]+$/.test(asked) && asked.length <= 2000;
      return fail(problems.map((x) => x.text).join(' '), {
        next: `the orchestrator keeps one plan per milestone, ${p.plans}/<milestone id or name>.md, with the line "Milestone: <its name as in ${p.status}>" under its title, then Outcome, Acceptance and Try it (its role doc, "Planning")`,
        steps: [
          step('browser', null, { text: "On the dashboard (START.cmd -> d): Project. The card of each milestone named here says what is wrong with its plan." }),
          plain && step('terminal', `nextlevel note add "${asked}"`, { cwd: ctx.root, text: 'asks the orchestrator to fix them at its next start or round: it keeps the plans' }),
        ].filter(Boolean),
      });
    },
  },
  {
    // FR-015: on a real project a push to main deployed production. A push to a deploy branch waits for the owner's approval on
    // the dashboard (nextlevel push); until nextlevel.json names them, the base branch counts as one. The list is safe
    // from the team only while nextlevel.json is protected.
    id: 'project.deploy-branches',
    title: 'Deploy branches',
    sandbox: 'same', // the project only
    severity: 'info',
    learnMore: 'docs/CHECKS.md#projectdeploy-branches',
    skipIf: (ctx) => needsProject(ctx) || (!ctx.configInfo.exists && 'needs nextlevel.json') || (ctx.configInfo.error && `${CONFIG_FILE} has an error`),
    run(ctx) {
      const c = ctx.config;
      if (!isProtected(CONFIG_FILE, protectedList(c).entries)) {
        return fail(`${CONFIG_FILE} isn't protected ("protected" in it removes it): the team could change deployBranches without you`, {
          severity: 'warn',
          next: `take "${CONFIG_FILE}" out of "protected": { "remove": [...] } in ${CONFIG_FILE}`,
        });
      }
      // (the file as it is now: the doctor's own fix writes it, and the check runs again)
      let raw = null;
      try {
        raw = JSON.parse(String(ctx.read(ctx.path.join(ctx.root, CONFIG_FILE)) ?? '').replace(/^\uFEFF/, ''));
      } catch {
        // as the settings were read
      }
      const list = raw && typeof raw === 'object' && 'deployBranches' in raw ? raw.deployBranches : c.deployBranches;
      if (!Array.isArray(list)) {
        return fail(`not set, so the base branch ${c.baseBranch} counts as one: a push to it waits for your approval on the dashboard`, {
          unset: true,
          next: `to name them yourself, put "deployBranches": ["${c.baseBranch}"] in ${CONFIG_FILE}: the branches on origin a push to which deploys (or might), [] if none does. The doctor can write it (answer y)`,
        });
      }
      if (!list.length) return pass(`none: deployBranches is [] in ${CONFIG_FILE}, so every push goes out without asking you`);
      return pass(`${list.join(', ')}: a push to ${list.length === 1 ? 'it' : 'one of them'} waits for your approval on the dashboard`);
    },
    fixPrompt: (r, ctx) => `Write "deployBranches": ["${ctx.config.baseBranch}"] into ${CONFIG_FILE} (a push to ${ctx.config.baseBranch} keeps waiting for your approval)?`,
    canFix: (r) => !!r.unset,
    fix(ctx, ui) {
      const file = ctx.path.join(ctx.root, CONFIG_FILE);
      const text = ctx.read(file);
      let raw;
      try {
        raw = JSON.parse(String(text).replace(/^\uFEFF/, ''));
      } catch {
        return ui.say(`${CONFIG_FILE} isn't valid JSON: fix it first.`);
      }
      if (Array.isArray(raw.deployBranches)) return ui.say(`${CONFIG_FILE} names its deploy branches already: ${raw.deployBranches.join(', ') || 'none'}.`);
      raw.deployBranches = [ctx.config.baseBranch];
      const out = formatConfig(raw);
      ctx.write(file, /\r\n/.test(text) ? out.replace(/\n/g, '\r\n') : out);
      ui.say(`Wrote "deployBranches": ["${ctx.config.baseBranch}"] into ${CONFIG_FILE}. Commit it with your next change.`);
    },
  },
  {
    id: 'project.gitignore',
    title: '.gitignore',
    sandbox: 'same', // the project only
    learnMore: 'docs/CHECKS.md#projectgitignore',
    skipIf: needsProject,
    run(ctx) {
      const { missing } = withIgnores(ctx.read(ctx.path.join(ctx.root, '.gitignore')) || '');
      if (!missing.length) return pass('ignores .env and the hub\'s state');
      return fail(`doesn't ignore ${missing.join(', ')}`, { next: '.env holds secrets: it must never be committed' });
    },
    fixPrompt: 'Add the missing lines to .gitignore?',
    fix(ctx) {
      const file = ctx.path.join(ctx.root, '.gitignore');
      ctx.write(file, withIgnores(ctx.read(file) || '').text);
    },
  },
  {
    id: 'project.env',
    title: '.env',
    sandbox: 'same', // the project only
    learnMore: 'docs/CHECKS.md#projectenv',
    skipIf: needsProject,
    run(ctx) {
      if (ctx.exists(ctx.path.join(ctx.root, '.env'))) return pass('present');
      if (ctx.exists(ctx.path.join(ctx.root, '.env.example'))) return fail('missing', { next: 'copy .env.example to .env' });
      return fail('missing, and there is no .env.example to start from', { steps: [step('terminal', 'nextlevel init', { cwd: ctx.root, text: 'adds .env.example' })] });
    },
    // A copy of the project's own template: harmless, so the doctor does it without asking.
    safeFix: true,
    fix(ctx) {
      const example = ctx.path.join(ctx.root, '.env.example');
      if (ctx.exists(example)) ctx.copy(example, ctx.path.join(ctx.root, '.env'));
    },
  },
  {
    // FR-005: init offered to replace a real project's own .env.example with the generic template, and
    // a "yes" lost the project's keys. init no longer offers that; this finds a file it already replaced:
    // .env.example is a nextlevel template now, and git has a version of the project's own before it.
    id: 'project.env-example',
    title: '.env.example',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#projectenv-example',
    skipIf: needsProject,
    run(ctx) {
      const text = ctx.read(ctx.path.join(ctx.root, '.env.example'));
      if (text === null) return pass('none', { quiet: true }); // project.env says what to do
      if (!isEnvExampleTemplate(text)) return pass("the project's own");
      const own = ownEnvExample(ctx);
      if (!own) return pass("nextlevel's template", { quiet: true });
      return fail(`nextlevel's template replaced the project's own (FR-005); commit ${own.short} (${own.date}) has yours`, {
        ...own,
        next: 'the doctor can put yours back (then commit it); to keep the template instead, change the file in any way',
        steps: [inProject(ctx, `git checkout ${own.short} -- .env.example`)],
      });
    },
    fixPrompt: (r) => `Put the project's own .env.example back, from commit ${r.short}?`,
    fix(ctx, ui, r) {
      const shown = ctx.git(['show', `${r.sha}:.env.example`]);
      if (!shown.ok) return ui.say(`git couldn't read .env.example from ${r.short}: ${shown.err}`);
      ctx.write(ctx.path.join(ctx.root, '.env.example'), `${shown.out}\n`);
      ui.say(`Put back the project's own .env.example from commit ${r.short}. Commit it with your next change.`);
    },
  },
  {
    id: 'project.env-settings',
    title: 'Settings in .env',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#projectenv-settings',
    skipIf: needsProject,
    run(ctx) {
      // Names only: values in .env are secrets and never shown.
      const moved = Object.keys(parseEnvText(ctx.read(ctx.path.join(ctx.root, '.env')))).filter((k) => SETTING_KEYS.has(k));
      if (!moved.length) return pass('secrets only');
      return fail(moved.join(', '), { next: `move them to ${CONFIG_FILE}, then delete them from .env (it keeps only secrets)` });
    },
  },
  {
    id: 'notify.topic',
    title: 'Phone notifications',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#notifytopic',
    skipIf: needsProject,
    run(ctx) {
      const topic = ctx.env.NTFY_TOPIC || parseEnvText(ctx.read(ctx.path.join(ctx.root, '.env'))).NTFY_TOPIC || '';
      const random = 'node -e "console.log(require(\'crypto\').randomBytes(24).toString(\'hex\'))"';
      const how = [
        step('phone', null, { text: 'install the ntfy app and subscribe to a new topic with a long random name' }),
        inProject(ctx, random),
        step('editor', null, { text: 'put the name in the project\'s .env as NTFY_TOPIC=...' }),
        inProject(ctx, 'nextlevel notify --now "Test" "hello"'),
      ];
      // The topic works like a password (anyone who knows it reads the notifications): never shown.
      if (!topic) return fail('NTFY_TOPIC empty', { next: 'put your ntfy topic in .env as NTFY_TOPIC (see .env.example)', steps: how });
      if (topic.length < 16) return fail(`NTFY_TOPIC is short (${topic.length} characters): anyone who guesses it reads your notifications`, { steps: how });
      return pass('NTFY_TOPIC set', { next: 'test: nextlevel notify --now "Test" "hello"' });
    },
  },
];
