// nextlevel init: give a project what it needs to run a build team. Writes templates/project/ into
// it, never replacing a file without showing what would change and asking, and never offering to replace
// the project's own documents (BRIEF.md, status, ...; a .env.example it has changed: FR-005); adds
// .gitignore entries; creates nextlevel.json (carrying over settings an older .env had).
import fs from 'node:fs';
import path from 'node:path';
import { makeAsker } from './lib/ask.mjs';
import { recordOwner } from './lib/guard.mjs';
import { CONFIG_FILE, ENV_SETTINGS, formatConfig, loadConfig } from './lib/config.mjs';
import { TOOL_ROOT, hasCommits } from './lib/project.mjs';
import { isEnvExampleTemplate } from './lib/templates.mjs';
import { parseEnvFile, parseEnvText } from './notify.mjs';

const TEMPLATES = path.join(TOOL_ROOT, 'templates', 'project');
// The project's own documents: created when missing, never offered for replacement.
const SEEDS = new Set(['BRIEF.md', 'docs/PROJECT.md', 'docs/STATUS.md', 'docs/HANDOFF.md', 'docs/DECISIONS.md', 'docs/OWNER_NOTES.md']);
// Templates a project makes its own by changing them: once the file differs from every version nextlevel
// has shipped, it is kept like a seed. A real project's own .env.example, with its keys, was offered
// for replacement by the generic one, and a "yes" lost them (FR-005).
const OWN_ONCE_CHANGED = { '.env.example': isEnvExampleTemplate };
// What must never be committed: secrets and the hub's runtime state, with the lines that already cover
// it. Checked in the project's .gitignore itself, not in this PC's global or local excludes, so the
// rule travels with the repository.
const MUST_IGNORE = [
  ['.env', ['.env', '/.env', '.env*', '/.env*']],
  ['.nextlevel/', ['.nextlevel/', '/.nextlevel/', '.nextlevel', '/.nextlevel']],
  ['.nextlevel-task/', ['.nextlevel-task/', '/.nextlevel-task/', '.nextlevel-task', '/.nextlevel-task']],
];

function listTemplates(dir = TEMPLATES, prefix = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listTemplates(path.join(dir, e.name), rel));
    else out.push(rel);
  }
  return out;
}

// Where a template goes, following the paths in nextlevel.json.
function destination(rel, paths) {
  const map = {
    'docs/tasks/_TEMPLATE.md': `${paths.tasks}/_TEMPLATE.md`,
    'docs/STATUS.md': paths.status,
    'docs/HANDOFF.md': paths.handoff,
    'docs/OWNER_NOTES.md': paths.notes,
    'docs/PROJECT.md': paths.project,
    'docs/DECISIONS.md': paths.decisions,
    'docs/agents/GUIDE.md': paths.roles.guide,
    'docs/agents/ORCHESTRATOR.md': paths.roles.orchestrator,
    'docs/agents/WORKER.md': paths.roles.worker,
  };
  return map[rel] || rel;
}

const lines = (text) => text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');

// Line diff (longest common subsequence), printed with two lines of context around each change.
export function diffText(before, after, { context = 2, max = 60 } = {}) {
  const a = lines(before);
  const b = lines(after);
  if (a.length * b.length > 4_000_000) return [`  (your file has ${a.length} lines, the template ${b.length}; too big to compare here)`];
  const dp = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push([' ', a[i++], j++]);
    else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['-', a[i++]]);
    else ops.push(['+', b[j++]]);
  }
  while (i < a.length) ops.push(['-', a[i++]]);
  while (j < b.length) ops.push(['+', b[j++]]);
  const near = ops.map((_, k) => ops.slice(Math.max(0, k - context), k + context + 1).some((o) => o[0] !== ' '));
  const out = [];
  let gap = false;
  for (let k = 0; k < ops.length; k++) {
    if (!near[k]) {
      gap = true;
      continue;
    }
    if (gap && out.length) out.push('  ...');
    gap = false;
    out.push(`  ${ops[k][0]} ${ops[k][1]}`);
  }
  if (out.length > max) return [...out.slice(0, max), `  ... and ${out.length - max} more lines`];
  return out;
}

// nextlevel.json for a project that has none: defaults, plus the settings its .env still holds.
function createConfig(root) {
  const dotenv = parseEnvFile(path.join(root, '.env'));
  const { config, overrides } = loadConfig(root, { env: dotenv, file: null });
  // A new project names its deploy branches from the start: the base branch, which the owner can change (FR-015)
  // (workers' own arguments are left out until the owner sets them: workers get each engine's args)
  const engines = Object.fromEntries(Object.entries(config.engines).map(([name, { workerArgs, ...e }]) => [name, workerArgs ? { ...e, workerArgs } : e]));
  // (and no second worker until the owner adds one on the Team page)
  const { second, ...worker } = config.roles.worker;
  const roles = { ...config.roles, worker: second ? config.roles.worker : worker };
  // (and no backup branch until the owner sets one: updates.backupBranch)
  const { updates, ...rest } = config;
  fs.writeFileSync(path.join(root, CONFIG_FILE), formatConfig({ ...rest, ...(updates?.backupBranch ? { updates } : {}), roles, engines, deployBranches: [config.baseBranch] }));
  return overrides;
}

// A .gitignore's text with the missing protective entries added: { text, missing }. Also used by the
// project.gitignore check.
export function withIgnores(cur = '') {
  const have = new Set(cur.split(/\r?\n/).map((l) => l.trim()));
  const missing = MUST_IGNORE.filter(([, covered]) => !covered.some((l) => have.has(l))).map(([line]) => line);
  if (!missing.length) return { text: cur, missing };
  const sep = cur && !cur.endsWith('\n') ? '\n' : '';
  return { text: `${cur}${sep}${cur ? '\n' : ''}# nextlevel: secrets and the hub's runtime state\n${missing.join('\n')}\n`, missing };
}

function ensureIgnored(root) {
  const file = path.join(root, '.gitignore');
  const { text, missing } = withIgnores(fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
  if (missing.length) fs.writeFileSync(file, text);
  return missing;
}

export async function cmdInit(root) {
  console.log(`Setting up nextlevel in ${root}\n`);
  const done = { created: [], replaced: [], kept: [], same: [], own: [] };

  let moved = [];
  const hadConfig = fs.existsSync(path.join(root, CONFIG_FILE));
  if (!hadConfig) {
    moved = createConfig(root);
    done.created.push(CONFIG_FILE);
  }
  const { config } = loadConfig(root); // also reports a broken nextlevel.json before anything is written

  let asker = null;
  try {
    for (const rel of listTemplates()) {
      const src = path.join(TEMPLATES, rel);
      const dest = destination(rel, config.paths);
      const target = path.join(root, dest);
      const template = fs.readFileSync(src);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, template);
        done.created.push(dest);
        continue;
      }
      if (rel === '.gitignore') continue; // an existing .gitignore gets entries added below
      const mine = fs.readFileSync(target, 'utf8');
      if (lines(mine).join('\n') === lines(template.toString('utf8')).join('\n')) {
        done.same.push(dest);
        continue;
      }
      if (SEEDS.has(rel)) {
        done.same.push(dest); // the project's own document: never replaced
        continue;
      }
      if (OWN_ONCE_CHANGED[rel] && !OWN_ONCE_CHANGED[rel](mine)) {
        done.own.push(dest); // changed by the project: its own now, never replaced
        continue;
      }
      console.log(`${dest} differs from the template (- yours, + template):`);
      for (const l of diffText(mine, template.toString('utf8'))) console.log(l);
      asker ||= makeAsker();
      if (await asker.yes(`Replace ${dest} with the template?`)) {
        fs.writeFileSync(target, template);
        done.replaced.push(dest);
      } else done.kept.push(dest);
      console.log('');
    }
  } finally {
    asker?.close();
  }
  const ignoredNow = ensureIgnored(root);
  // What init wrote is the owner's: the guard never holds it (lib/guard.mjs)
  recordOwner(root, [...done.created, ...done.replaced, ...(ignoredNow.length ? ['.gitignore'] : [])]);

  const show = (label, list) => list.length && console.log(`${label.padEnd(9)} ${list.join(', ')}`);
  show('Created', done.created);
  show('Replaced', done.replaced);
  show('Kept', done.kept);
  if (ignoredNow.length) console.log(`.gitignore now ignores ${ignoredNow.join(', ')}`);
  if (done.kept.length) console.log('(To use the template for one of these, run nextlevel init in PowerShell and answer y.)');
  // The project's own .env.example is kept as it is; phone notifications still need their line in .env
  if (done.own.includes('.env.example') && !('NTFY_TOPIC' in parseEnvText(fs.readFileSync(path.join(root, '.env.example'), 'utf8')))) {
    console.log('.env.example is the project\'s own, so init leaves it alone. It has no NTFY_TOPIC line: add "NTFY_TOPIC=" to it for phone notifications.');
  }
  if (moved.length) {
    const names = moved.map((k) => `${k} (${ENV_SETTINGS.find((e) => e.includes(k))[2]})`);
    console.log(`\nCopied these settings from .env into ${CONFIG_FILE}: ${names.join(', ')}.`);
    console.log('Delete them from .env: it keeps only secrets now.');
  }
  console.log(`\nNext, in PowerShell in ${root}:`);
  console.log(`  1. Look at what changed:   git status`);
  console.log(`  2. Commit it:              git add -A    then    git commit -m "chore: set up nextlevel"`);
  console.log('  3. Check the setup:        nextlevel doctor     (or double-click START.cmd and choose 1)');
  if (!hasCommits(root)) console.log('This repository has no commits yet: step 2 makes the first one, which workers need.');
}
