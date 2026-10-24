// The dashboard's Project page and Home's Blockers (M11): the files the orchestrator keeps, read the way the page
// shows them (lib/roadmap.mjs, lib/overview.mjs). Pure functions: no project, no hub.
//   npm test
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { makeContext } from '../src/checks/context.mjs';
import { byId, runCheck } from '../src/checks/index.mjs';
import { defaults } from '../src/lib/config.mjs';
import { blockersView, parseBlockers } from '../src/lib/overview.mjs';
import { buildRoadmap, mergeJobsDone, mergeMessage, mergedTasks, milestoneKey, pace, parseBrief, parseDecisions, parsePlan, parseProjectDoc, planProblems, specMilestone } from '../src/lib/roadmap.mjs';
import { closeReason, closedSince, closedText, closuresFile, closuresOf } from '../src/lib/closures.mjs';
import { getState, isDone, statusMilestones } from '../src/lib/state.mjs';

const template = (f) => fs.readFileSync(new URL(`../templates/project/${f}`, import.meta.url), 'utf8');

// FR-016: a real project's files as they were on 30 September, shortened (test/fixtures/fr016): the Walking skeleton's plan was
// docs/plans/WS-walking-skeleton.md; M0's plan and STATUS.md start with a byte-order mark (PowerShell wrote them), M0's
// says "Try-it:" and M1's "Try it (accepted local flow; ...):".
const BOM = String.fromCharCode(0xfeff);
const fixture = (f) => fs.readFileSync(new URL(`./fixtures/fr016/${f}`, import.meta.url), 'utf8');
const SAMPLE_PLANS = { 'M0-foundation.md': BOM + fixture('plans/M0-foundation.md'), 'M1-accounts-households.md': fixture('plans/M1-accounts-households.md'), 'WS-walking-skeleton.md': fixture('plans/WS-walking-skeleton.md') };
// A real project's plans with some changed (a text) or taken out (null), as the hub reads them
const samplePlans = (changes = {}) =>
  Object.entries({ ...SAMPLE_PLANS, ...changes })
    .filter(([, text]) => text !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([f, text]) => ({ file: `docs/plans/${f}`, ...parsePlan(text) }));
const sampleStatus = () => statusMilestones(BOM + fixture('STATUS.md')).map(([name, state = '', verified = '']) => ({ name, state, verified, done: isDone(state) }));
const SAMPLE_SPECS = [
  { id: 'M0-01-workspace-db', milestone: 'M0' },
  { id: 'M0-02-app-health', milestone: 'M0' },
  { id: 'M1-18-web-sessions', milestone: 'M1' },
  { id: 'M1-21-mail', milestone: 'M1 Accounts and households' },
  { id: 'WS-01-recipe-store-design', milestone: 'Walking skeleton' },
  { id: 'WS-34A-list-checker', milestone: 'Walking skeleton' },
];
const SAMPLE_MERGED = mergedTasks(['2026-09-30T08:00:00+02:00\tMerge branch \'task/WS-01-recipe-store-design\'', '2026-09-30T07:00:00+02:00\tMerge main into task/WS-34A-list-checker', '2026-09-28T09:00:00+02:00\tMerge branch \'task/M1-18-web-sessions\'', '2026-09-26T09:00:00+02:00\tMerge branch \'task/M0-01-workspace-db\''].join('\n'));
const sampleRoadmap = (plans = samplePlans(), specs = SAMPLE_SPECS) => buildRoadmap({ status: sampleStatus(), plans, specs, merged: SAMPLE_MERGED });

test('docs/PROJECT.md: the five sections; the template, with its placeholders, is not written yet', () => {
  const fresh = parseProjectDoc(template('docs/PROJECT.md'));
  assert.equal(fresh.exists, true);
  assert.equal(fresh.written, 0, 'placeholders only');
  assert.deepEqual(fresh.sections.map((s) => s.title), ['What it is', "Who it's for", 'Where it runs', 'How it works', 'Current state']);
  assert.equal(parseProjectDoc(null).exists, false);

  const doc = [
    '# Gym booking',
    '<!-- kept by the orchestrator -->',
    '## What it is',
    'A booking app for **small gyms**.',
    '',
    "## Who it's for",
    'Gym owners and their members.',
    '## Where it runs',
    '- Code: https://github.com/me/gymbook',
    '- Live: <the production link, or "not deployed yet">',
    '- Staging: [staging](https://staging.example.com)',
    '## How it works',
    '- Next.js front end',
    '- Postgres',
    '## Current state',
    '<Two or three sentences: what works today.>',
  ].join('\r\n');
  const p = parseProjectDoc(doc);
  const by = Object.fromEntries(p.sections.map((s) => [s.key, s.text]));
  assert.equal(by.what, 'A booking app for **small gyms**.', 'Markdown stays Markdown: the page renders it');
  assert.equal(by.where, '- Code: https://github.com/me/gymbook\n- Staging: [staging](https://staging.example.com)', 'a placeholder line is left out, the rest kept');
  assert.equal(by.state, '', 'still a placeholder');
  assert.equal(p.written, 4);
  assert.equal(p.complete, false);
});

test("the brief's goal and milestones, the status table, and each task's milestone", () => {
  const brief = parseBrief(template('BRIEF.md'));
  assert.equal(brief.goal, '', 'the template has a placeholder');
  assert.deepEqual(brief.milestones.map((m) => [m.key, m.name, m.goal]), [['M0', 'M0 Foundation', ''], ['M1', 'M1 First feature', '']]);
  const own = parseBrief('# Brief\n\n## Goal\nBook a class in two taps.\n\n## Milestones\n| Milestone | What is true when it\'s done |\n|---|---|\n| M0 Foundation | CI green |\n| Milestone 2: Payments | members pay by card |\n');
  assert.equal(own.goal, 'Book a class in two taps.');
  assert.deepEqual(own.milestones.map((m) => [m.key, m.goal]), [['M0', 'CI green'], ['M2', 'members pay by card']]);

  assert.deepEqual(statusMilestones(template('docs/STATUS.md')), [['M0 Foundation', 'not started', ''], ['M1 First feature', 'not started', '']]);
  for (const [name, key] of [['M0 Foundation', 'M0'], ['M1 — First feature', 'M1'], ['**M10** Launch', 'M10'], ['M2-03-policy-api', 'M2'], ['m2-auth', 'M2'], ['milestone-2', 'M2'], ['Milestone 3: Launch', 'M3'], ['Foundation', 'foundation'], ['Walking skeleton', 'walking-skeleton'], ['WS-walking-skeleton', 'ws-walking-skeleton'], ['Pre-flight (owner)', 'pre-flight-owner']]) {
    assert.equal(milestoneKey(name), key, name);
  }
  assert.equal(specMilestone('# M2-03 — Policy API\n\nKind: code\nMilestone: M2\n'), 'M2');
  assert.equal(specMilestone(template('docs/tasks/_TEMPLATE.md')), '', "the template's M<n> isn't one");
});

test('a milestone plan: Outcome, Acceptance and Try it, in any of the ways they are written', () => {
  const plan = [
    '# M2 — Sign-up and sign-in',
    '',
    'Outcome: You can sign up with an email address,',
    'sign in and sign out.',
    '**Acceptance:** R3 and R4 of BRIEF.md; the auth tests pass on main.',
    'Try it:',
    '1. In PowerShell, in the project folder: `pnpm dev`',
    '2. In the browser: open http://localhost:3000/signup',
    '',
    '3. You should see your address at the top right.',
    '',
    'The tasks run two at a time.',
    '',
    '## Tasks',
    '- M2-01 — Accounts',
  ].join('\n');
  const p = parsePlan(plan);
  assert.equal(p.title, 'M2 — Sign-up and sign-in');
  assert.equal(p.outcome, 'You can sign up with an email address,\nsign in and sign out.');
  assert.equal(p.acceptance, 'R3 and R4 of BRIEF.md; the auth tests pass on main.');
  assert.equal(p.tryIt, '1. In PowerShell, in the project folder: `pnpm dev`\n2. In the browser: open http://localhost:3000/signup\n\n3. You should see your address at the top right.', 'a list after a blank line still belongs to it; a paragraph ends it');
  const headings = parsePlan('# M3\n\n## Outcome\nMembers pay by card.\n\n## Try it yourself\n```\npnpm dev\n```\n\n## Tasks\n');
  assert.equal(headings.outcome, 'Members pay by card.');
  assert.equal(headings.tryIt, '```\npnpm dev\n```');
  assert.equal(headings.acceptance, '');
  assert.deepEqual(parsePlan('# M4\n\n**Outcome**: <what the owner can do>\n'), { title: 'M4', milestone: '', outcome: '', acceptance: '', tryIt: '' }, 'a placeholder is no outcome');
});

test('a milestone plan (FR-016): its Milestone line in the header only, and the labels real plans have: "Try-it", words in brackets, a byte-order mark', () => {
  const p = parsePlan(`${BOM}# M0 - Foundation\r\n\r\nMilestone: **M0 Foundation**\r\nOutcomes: It builds.\r\nTry-it:\r\n1. \`pnpm test\`\r\n`);
  assert.deepEqual(p, { title: 'M0 - Foundation', milestone: 'M0 Foundation', outcome: 'It builds.', acceptance: '', tryIt: '1. `pnpm test`' });
  // The words in brackets after a label stay, in brackets, at the start of its text
  const m1 = parsePlan(fixture('plans/M1-accounts-households.md'));
  assert.equal(m1.tryIt, [
    '(accepted local flow; production signup also confirmed by the owner)',
    '',
    '1. In PowerShell at the project root, run `pnpm stack:up`.',
    '2. Open http://localhost:5173/signup, sign up with a test address and follow the emailed link.',
    '3. Sign in at http://localhost:5173/login; expect the Recipes page of the new household.',
  ].join('\n'), 'the paragraph after the list is not part of it');
  assert.equal(parsePlan('# M2\n\n**Outcome** (draft): Members pay.\n').outcome, '(draft) Members pay.');
  for (const label of ['**Try it** (local):', '**Try it (local):**', '**Try it (local)**:', '## Try it (local)', '### Try-it yourself (local)', 'How to try it (local):', 'Try it out (local):']) {
    assert.equal(parsePlan(`# M2\n\n${label}\n1. Open it.\n`).tryIt, '(local)\n\n1. Open it.', label);
  }
  assert.equal(parsePlan('# M2\n\nTry it ():\n1. Open it.\n').tryIt, '1. Open it.', 'empty brackets add nothing');
  assert.equal(parsePlan('# M2\n\nTry it (to be written):\n\n## Tasks\n').tryIt, '', 'words in brackets alone are no steps');
  // Before the title, as a heading, in bold: all the header's
  assert.equal(parsePlan('Milestone: Walking skeleton\n\n# The walking skeleton\n').milestone, 'Walking skeleton');
  assert.equal(parsePlan('# WS\n\n## Milestone\nWalking skeleton\n\n## Outcome\nIt runs.\n').milestone, 'Walking skeleton');
  assert.equal(parsePlan('# WS\n\n**Milestone:** Walking skeleton\n').milestone, 'Walking skeleton');
  // Further down it is part of the plan's text, and a placeholder is no milestone
  assert.equal(parsePlan(fixture('plans/WS-walking-skeleton.md')).milestone, '', 'the "- Milestone:" bullet under "## Tasks" is no header line');
  assert.equal(parsePlan('# M2\n\n## Tasks\n\nMilestone: M3\n').milestone, '');
  assert.equal(parsePlan('# M2\n\nMilestone: <its name as in docs/STATUS.md>\n').milestone, '');
  // A line that only looks like a label is none
  assert.equal(parsePlan(fixture('plans/WS-walking-skeleton.md')).acceptance.split('\n').length, 1, '"Acceptance/Try it, protected files ..." under Tasks is no field');
});

test("FR-016: a real project's plans are all found: WS-walking-skeleton.md by its title and name, M0's \"Try-it\" and M1's \"Try it (...)\" read", () => {
  const r = sampleRoadmap();
  assert.deepEqual(r.map((m) => [m.name, m.plan?.file || null, m.plan?.by || null]), [
    ['Pre-flight (owner)', null, null],
    ['M0 Foundation', 'docs/plans/M0-foundation.md', 'title'],
    ['M1 Accounts and households', 'docs/plans/M1-accounts-households.md', 'title'],
    ['Walking skeleton', 'docs/plans/WS-walking-skeleton.md', 'title'],
    ['M2 Recipes and search', null, null],
    ['M3 Meal planner', null, null],
    ['M4 Shopping lists (web + phone)', null, null],
    ['M5 Sharing', null, null],
    ['M6 Packaging and release', null, null],
    ['M7 Production acceptance', null, null],
  ]);
  const by = Object.fromEntries(r.map((m) => [m.key, m]));
  const ws = by['walking-skeleton'];
  assert.match(ws.plan.outcome, /^A cook can save one recipe/);
  assert.match(ws.plan.acceptance, /^On the deployed product/);
  assert.equal(ws.plan.tryIt.split('\n').length, 3);
  assert.deepEqual([ws.current, ws.state, ws.planPath], [true, 'in progress', 'docs/plans/walking-skeleton.md']);
  assert.deepEqual(ws.tasks.map((t) => [t.id, t.state]), [['WS-01-recipe-store-design', 'merged'], ['WS-34A-list-checker', 'planned']], 'a retry\'s "Merge main into task/..." is no merge of the task');
  assert.equal(by.M0.plan.title, 'M0 - Foundation', 'the byte-order mark is no part of the title');
  assert.match(by.M0.plan.tryIt, /^1\. In PowerShell at the main checkout/);
  assert.equal(by.M0.plan.tryIt.split('\n').length, 3);
  assert.match(by.M1.plan.tryIt, /^\(accepted local flow; production signup also confirmed by the owner\)\n\n1\. /);
  assert.deepEqual(by.M1.tasks.map((t) => t.id), ['M1-18-web-sessions', 'M1-21-mail'], '"Milestone: M1 Accounts and households" is M1');
  assert.deepEqual(r.map((m) => [m.missing, m.rivals, m.unmatched]).filter(([a, b, c]) => a.length || b.length || c.length), []);
  assert.deepEqual(planProblems(r), [], 'nothing to warn about');
  // The same plan with today's name, and before the rename (the page found neither name before FR-016)
  assert.equal(sampleRoadmap(samplePlans({ 'WS-walking-skeleton.md': null, 'walking-skeleton.md': SAMPLE_PLANS['WS-walking-skeleton.md'] }))[3].plan.file, 'docs/plans/walking-skeleton.md');
});

test('FR-016: WS-walking-skeleton.md is found by its Milestone line, and by its file name alone; the Milestone line decides', () => {
  const ws = SAMPLE_PLANS['WS-walking-skeleton.md'];
  const withLine = ws.replace('\n\nOutcome:', '\n\nMilestone: Walking skeleton\nOutcome:');
  const header = sampleRoadmap(samplePlans({ 'WS-walking-skeleton.md': withLine }));
  assert.deepEqual([header[3].plan.file, header[3].plan.by, header[3].plan.milestone], ['docs/plans/WS-walking-skeleton.md', 'header', 'Walking skeleton']);
  // Its name alone: a title that doesn't name the milestone
  const untitled = ws.replace(/^# .*$/m, '# One real recipe and shopping list');
  const named = sampleRoadmap(samplePlans({ 'WS-walking-skeleton.md': untitled }));
  assert.deepEqual([named[3].plan.file, named[3].plan.by], ['docs/plans/WS-walking-skeleton.md', 'file']);
  // Common forms of a name: an id in front, little words left out, the id alone, the initials
  for (const name of ['walking-skeleton', 'WS-walking-skeleton', 'walking_skeleton_plan', 'the-walking-skeleton', 'WS', 'milestone-walking-skeleton']) {
    const r = sampleRoadmap(samplePlans({ 'WS-walking-skeleton.md': null, [`${name}.md`]: untitled }));
    assert.equal(r[3].plan?.file, `docs/plans/${name}.md`, name);
  }
  for (const [name, key] of [['M1', 'M1'], ['m1-accounts-households', 'M1'], ['accounts-households', 'M1'], ['milestone-1', 'M1'], ['M4-shopping-lists', 'M4']]) {
    const r = sampleRoadmap(samplePlans({ 'M1-accounts-households.md': null, [`${name}.md`]: '# The plan\n\nOutcome: x\n' }));
    assert.equal(r.find((m) => m.key === key).plan?.file, `docs/plans/${name}.md`, name);
  }
  // What the plan says decides: a Milestone line over the file's name, and an id never names another
  const moved = sampleRoadmap(samplePlans({ 'WS-walking-skeleton.md': null, 'M2-recipes.md': withLine }));
  assert.deepEqual([moved[3].plan?.file, moved[4].plan], ['docs/plans/M2-recipes.md', null]);
  const other = sampleRoadmap(samplePlans({ 'M3.md': '# M2 - Recipes and search\n\nOutcome: x\n' }));
  assert.deepEqual([other[4].plan?.file, other[5].plan], ['docs/plans/M3.md', null], 'the title over the file name, when both name one by its id');
  // A task's Milestone line names its milestone the same way
  const specs = [...SAMPLE_SPECS, { id: 'WS-40-group', milestone: 'WS Walking skeleton' }];
  assert.deepEqual(sampleRoadmap(samplePlans(), specs)[3].tasks.map((t) => t.id), ['WS-01-recipe-store-design', 'WS-34A-list-checker', 'WS-40-group']);
});

test('FR-016: a milestone with tasks and no plan warns, naming the files that match no milestone; an incomplete plan says what it lacks', () => {
  const plans = samplePlans({
    'WS-walking-skeleton.md': null,
    'first-recipe.md': '# First recipe and shopping list\n\nMilestone: Walkng skeleton\nOutcome: x\n',
    'notes.md': '# Notes\n',
    'README.md': '# What is in this folder\n',
  });
  const r = sampleRoadmap(plans);
  const ws = r[3];
  assert.equal(ws.plan, null);
  assert.deepEqual(ws.unmatched, [{ file: 'docs/plans/first-recipe.md', milestone: 'Walkng skeleton' }, { file: 'docs/plans/notes.md', milestone: '' }], 'a README is no plan');
  const problems = planProblems(r);
  assert.deepEqual(problems.map((x) => [x.key, x.name, x.kind]), [['walking-skeleton', 'Walking skeleton', 'none']], 'M2 to M7 have no tasks yet: their plans come before their tasks');
  assert.equal(problems[0].text, 'Walking skeleton has 2 tasks but no plan: no file in docs/plans/ names it. Files there that match no milestone: first-recipe.md (its Milestone line says "Walkng skeleton"), notes.md. Its plan goes in docs/plans/walking-skeleton.md, with the line "Milestone: Walking skeleton" under its title.');
  assert.equal(problems[0].card, 'It has 2 tasks but no plan: no file in docs/plans/ names it. Files there that match no milestone: first-recipe.md (its Milestone line says "Walkng skeleton"), notes.md. Its plan goes in docs/plans/walking-skeleton.md, with the line "Milestone: Walking skeleton" under its title.');
  // A plans folder of its own (paths.plans) with no plan at all: a milestone with an id gets its plan by its id
  const own = planProblems(buildRoadmap({ status: sampleStatus(), specs: SAMPLE_SPECS, merged: SAMPLE_MERGED, plansDir: 'plans' }), { plansDir: 'plans' });
  assert.deepEqual(own.map((x) => x.key), ['M0', 'M1', 'walking-skeleton']);
  assert.equal(own[0].text, 'M0 Foundation has 2 tasks but no plan: no file in plans/ names it. Its plan goes in plans/M0.md, with the line "Milestone: M0 Foundation" under its title.');
  // A control character in a name the team wrote doesn't reach the doctor's terminal
  const esc = String.fromCharCode(27);
  const odd = planProblems(buildRoadmap({ status: [{ name: `M5 Odd${esc}[2J name`, state: 'in progress', verified: '', done: false }], specs: [{ id: 'M5-01-x', milestone: 'M5' }] }));
  assert.deepEqual([odd[0].name, odd[0].text.slice(0, 50), [odd[0].text, odd[0].card].some((t) => t.includes(esc))], ['M5 Odd?[2J name', 'M5 Odd?[2J name has 1 task but no plan: no file in', false]);

  // M0's plan before FR-016 read had no Try it ("Try-it:"): now one that lacks it, and one that lacks all three
  const thin = sampleRoadmap(samplePlans({ 'M0-foundation.md': SAMPLE_PLANS['M0-foundation.md'].replace('Try-it:', 'Steps:'), 'M1-accounts-households.md': '# M1 - Accounts and households\n\nScope: accounts.\n' }));
  assert.deepEqual([thin[1].missing, thin[2].missing], [['Try it'], ['Outcome', 'Acceptance', 'Try it']]);
  assert.deepEqual(planProblems(thin).map((x) => x.text), [
    'M0 Foundation: its plan, docs/plans/M0-foundation.md, has no Try it (a line "Try it:" in its header).',
    'M1 Accounts and households: its plan, docs/plans/M1-accounts-households.md, has no Outcome, Acceptance or Try it (lines "Outcome:", "Acceptance:" and "Try it:" in its header).',
  ]);
  assert.equal(planProblems(thin)[0].card, 'Its plan, docs/plans/M0-foundation.md, has no Try it (a line "Try it:" in its header).');
});

test('FR-016: two plans for one milestone are reported, and the one whose Milestone line names it is shown', () => {
  const canonical = '# Walking skeleton\n\nMilestone: Walking skeleton\nOutcome: The canonical one.\nAcceptance: y\nTry it:\n1. z\n';
  const r = sampleRoadmap(samplePlans({ 'walking-skeleton.md': canonical }));
  const ws = r[3];
  assert.deepEqual([ws.plan.file, ws.plan.by, ws.plan.outcome], ['docs/plans/walking-skeleton.md', 'header', 'The canonical one.']);
  assert.deepEqual(ws.rivals, [{ file: 'docs/plans/WS-walking-skeleton.md', by: 'title' }]);
  const problems = planProblems(r);
  assert.deepEqual(problems.map((x) => [x.key, x.kind]), [['walking-skeleton', 'rivals']]);
  assert.equal(problems[0].text, 'Walking skeleton: 2 plans claim it, docs/plans/walking-skeleton.md and docs/plans/WS-walking-skeleton.md. The page shows docs/plans/walking-skeleton.md, whose "Milestone:" line names it. Keep one plan per milestone in docs/plans/.');
  assert.equal(problems[0].card, '2 plans claim it: docs/plans/walking-skeleton.md and docs/plans/WS-walking-skeleton.md. The page shows docs/plans/walking-skeleton.md, whose "Milestone:" line names it. Keep one plan per milestone in docs/plans/.');
  // Which plan is shown comes before what that plan lacks
  const both = planProblems(sampleRoadmap(samplePlans({ 'walking-skeleton.md': '# Walking skeleton\n\nMilestone: Walking skeleton\nOutcome: x\n' })));
  assert.deepEqual(both.map((x) => [x.key, x.kind]), [['walking-skeleton', 'rivals'], ['walking-skeleton', 'fields']]);
  assert.equal(both[1].card, 'Its plan, docs/plans/walking-skeleton.md, has no Acceptance or Try it (lines "Acceptance:" and "Try it:" in its header).');
  // The Milestone line wins whatever the names are; without one on either, the one named for the milestone is shown
  const header = sampleRoadmap(samplePlans({ 'zz-copy.md': SAMPLE_PLANS['WS-walking-skeleton.md'].replace('\n\nOutcome:', '\n\nMilestone: Walking skeleton\nOutcome:') }));
  assert.deepEqual([header[3].plan.file, header[3].rivals.map((x) => x.file)], ['docs/plans/zz-copy.md', ['docs/plans/WS-walking-skeleton.md']]);
  const copies = sampleRoadmap(samplePlans({ 'walking-skeleton.md': SAMPLE_PLANS['WS-walking-skeleton.md'] }));
  assert.deepEqual([copies[3].plan.file, copies[3].rivals], ['docs/plans/walking-skeleton.md', [{ file: 'docs/plans/WS-walking-skeleton.md', by: 'title' }]]);
  assert.equal(planProblems(copies)[0].text, 'Walking skeleton: 2 plans claim it, docs/plans/walking-skeleton.md and docs/plans/WS-walking-skeleton.md. The page shows docs/plans/walking-skeleton.md. Put the line "Milestone: Walking skeleton" under the right one\'s title, and keep one plan per milestone in docs/plans/.');
  // A plan for a milestone neither the status nor the brief lists is a milestone of its own (by its number), and
  // another plan that names it is a second plan for it
  const extra = sampleRoadmap(samplePlans({ 'M9.md': '# M9 - Payments\n\nOutcome: x\n', 'payments.md': '# Payments\n\nOutcome: y\n' }));
  assert.deepEqual(extra.slice(10).map((m) => [m.key, m.name, m.plan.file, m.rivals.map((x) => x.file)]), [['M9', 'M9 - Payments', 'docs/plans/M9.md', ['docs/plans/payments.md']]]);
});

test("FR-016's review: the parsers take time linear in a line's length (the files are the team's, and the doctor reads them too)", () => {
  // Before, a plan heading with 1,000 spaces in it took a minute (three \s* that share the run backtrack); each input
  // here is 100,000 characters. In a process of its own, stopped after 20 s, so a slow pattern fails instead of hanging.
  const script = [
    `import * as r from ${JSON.stringify(new URL('../src/lib/roadmap.mjs', import.meta.url).href)};`,
    'const NL = String.fromCharCode(10);',
    "const sp = ' '.repeat(100000);",
    "r.parsePlan(['# T', '', '## a' + sp + 'b', 'Try it' + sp + 'x', '**Try it**' + sp + '(x)' + sp + 'y', 'Outcome: <a' + sp, 'Acceptance: a' + sp + 'b' + sp].join(NL));",
    "r.sections('## a' + sp + 'b' + NL);",
    "r.parseBrief(['## Goal', 'x' + sp + 'y', '## Milestones', '| M0' + sp + 'a | <b' + sp + 'c |'].join(NL));",
    "r.parseDecisions(['## a' + sp + 'b', '## Title' + sp + 'x' + sp].join(NL));",
    "r.specMilestone(NL.repeat(100000) + 'x');",
    "const status = [{ name: 'W' + sp + 'x', state: '', verified: '', done: false }];",
    "r.planProblems(r.buildRoadmap({ status, plans: [{ file: 'docs/plans/w.md', ...r.parsePlan('# W' + sp + 'x' + NL + 'Milestone: W' + sp + 'y') }], specs: [{ id: 'W-01', milestone: 'W' + sp + 'z' }] }));",
    "console.log('done');",
  ].join('\n');
  const started = Date.now();
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 20_000 });
  assert.equal(run.stdout.trim(), 'done', `${run.stderr || ''}${run.error ? `${run.error.code}: stopped after ${Date.now() - started} ms` : ''}`);
});

test("FR-016: the doctor's project.plans reads a real project the way the Project page does: its files, the hub's jobs, git's merges", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nextlevel-plans-'));
  const env = { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 'test@example.com' };
  const git = (...a) => execFileSync('git', a, { cwd: root, env, stdio: 'pipe' });
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  };
  try {
    git('init', '-q', '-b', 'main');
    write('docs/STATUS.md', BOM + fixture('STATUS.md'));
    write('docs/plans/M0-foundation.md', SAMPLE_PLANS['M0-foundation.md']);
    write('docs/plans/M1-accounts-households.md', SAMPLE_PLANS['M1-accounts-households.md']);
    write('docs/plans/first-recipe.md', '# First recipe\n\nOutcome: x\n'); // the Walking skeleton's, under a name nothing finds
    write('docs/tasks/M1-18-web-sessions.md', '# M1-18 - test\n\nKind: code\nMilestone: M1\n');
    git('add', '-A');
    git('commit', '-qm', 'plans');
    // Merged task branches: WS-01's spec came with it; M3-01's is gone, so only git's merge knows that task. M2-01: only
    // the hub's job does.
    for (const [id, spec] of [['WS-01-recipe-store-design', 'Milestone: Walking skeleton'], ['M3-01-planner-shell', null]]) {
      git('checkout', '-qb', `task/${id}`);
      write(`docs/tasks/${id}.md`, `# ${id} - test\n\nKind: code\n${spec || ''}\n`);
      git('add', '-A');
      git('commit', '-qm', id);
      git('checkout', '-q', 'main');
      git('merge', '--no-ff', '-q', '-m', `Merge branch 'task/${id}'`, `task/${id}`);
      if (!spec) fs.rmSync(path.join(root, 'docs', 'tasks', `${id}.md`));
    }
    write('.nextlevel/jobs/M2-01-recipe-search/status.json', JSON.stringify({ id: 'M2-01-recipe-search', type: 'task', state: 'queued' }));
    const ctx = makeContext({ root, config: defaults('proj'), configInfo: { exists: true, file: path.join(root, 'nextlevel.json'), warnings: [], error: null }, stateDir: path.join(root, '.nextlevel') });
    const r = await runCheck(byId('project.plans'), ctx);
    assert.equal(r.status, 'fail');
    const none = (name, file) => `${name} has 1 task but no plan: no file in docs/plans/ names it. Files there that match no milestone: first-recipe.md. Its plan goes in docs/plans/${file}, with the line "Milestone: ${name}" under its title.`;
    assert.equal(r.detail, [none('Walking skeleton', 'walking-skeleton.md'), none('M2 Recipes and search', 'M2.md'), none('M3 Meal planner', 'M3.md')].join(' '), "M0 has no tasks here, so no warning; M0's plan starts with a byte-order mark");
    // The orchestrator gives the plan its Milestone line, and writes M2's and M3's: the row is quiet
    write('docs/plans/first-recipe.md', '# First recipe\n\nMilestone: Walking skeleton\nOutcome: x\nAcceptance: y\nTry it:\n1. z\n');
    write('docs/plans/M2.md', '# M2 - Recipes and search\n\nOutcome: x\nAcceptance: y\nTry it:\n1. z\n');
    write('docs/plans/meal-planner.md', '# Meal planner\n\nOutcome: x\nAcceptance: y\nTry it:\n1. z\n');
    const fixedNow = await runCheck(byId('project.plans'), ctx);
    assert.deepEqual([fixedNow.status, fixedNow.quiet, fixedNow.detail], ['ok', true, '5 plans for 10 milestones; each with tasks has one, with Outcome, Acceptance and Try it']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});

test('docs/DECISIONS.md as cards, newest first: heading entries, and the bullet entries older files have', () => {
  assert.deepEqual(parseDecisions(template('docs/DECISIONS.md')), [], "the template's examples are in a comment");
  const text = [
    '# Decisions',
    '',
    'One entry each.',
    '',
    '- 2026-09-25 — **Zero runtime dependencies, Node ≥ 22.** Installs can\'t break on a user\'s machine and',
    "  there's no build step.",
    '- 2026-09-25 — Files are the protocol. Survives restarts.',
    '',
    '## 2026-09-26 — Postgres, not SQLite',
    'Why: parallel tests lock SQLite.',
    '',
    'Alternatives: one test worker.',
    '',
    '## 2026-09-27 — Resolved: the SMTP host was missing',
    'The owner put it in .env (H3).',
  ].join('\n');
  const list = parseDecisions(text);
  assert.deepEqual(list.map((d) => [d.date, d.title, d.resolved]), [
    ['2026-09-27', 'The SMTP host was missing', true],
    ['2026-09-26', 'Postgres, not SQLite', false],
    ['2026-09-25', 'Files are the protocol', false],
    ['2026-09-25', 'Zero runtime dependencies, Node ≥ 22', false],
  ]);
  assert.equal(list[1].text, 'Why: parallel tests lock SQLite.\n\nAlternatives: one test worker.');
  assert.equal(list[3].text, "Installs can't break on a user's machine and\n  there's no build step.");
  assert.equal(list[2].text, 'Survives restarts.');
});

test('the roadmap: the status table, then the brief, each with its plan, its tasks from the hub, and its dates', () => {
  const status = [
    { name: 'M0 Foundation', state: 'done', verified: 'CI green on main', done: true },
    { name: 'M1 Booking', state: 'in progress', verified: '', done: false },
  ];
  const brief = parseBrief('## Milestones\n| Milestone | What is true when it\'s done |\n|---|---|\n| M1 Booking | members book a class |\n| M2 Payments | members pay by card |\n');
  const plans = [
    { file: 'docs/plans/M0.md', key: 'M0', added: '2026-09-20T09:00:00Z', ...parsePlan('# M0\nOutcome: The app builds.\nTry it:\n1. `pnpm test`\n') },
    { file: 'docs/plans/M1.md', key: 'M1', added: '2026-09-23T09:00:00Z', ...parsePlan('# M1\nOutcome: Members book.\nAcceptance: R1.\n') },
    { file: 'docs/plans/README.md', key: 'readme', added: null, ...parsePlan('# About plans\n') },
  ];
  const specs = [
    { id: 'M0-01-repo', milestone: 'M0', title: 'Repo' },
    { id: 'M1-01-api', milestone: 'M1', title: 'API' },
    { id: 'M1-02-ui', milestone: '', title: 'UI' },
    { id: 'X-review', milestone: 'M1', title: 'Review' },
  ];
  const jobs = [
    { id: 'M0-01-repo', state: 'done', summary: 'done', attempt: 2, engineTitle: 'Antigravity', createdAt: '2026-09-20T10:00:00Z', finishedAt: '2026-09-21T10:00:00Z', acked: true },
    { id: 'M1-01-api', state: 'running', summary: 'running', attempt: 1, engineTitle: 'Codex', switched: true, createdAt: '2026-09-23T10:00:00Z', finishedAt: null },
    { id: 'T000-bridge-1', state: 'done', summary: 'done', attempt: 1, createdAt: '2026-09-19T10:00:00Z' },
  ];
  const merged = new Map([['M0-01-repo', '2026-09-22T09:00:00Z']]);
  const r = buildRoadmap({ status, brief, plans, specs, jobs, merged });
  assert.deepEqual(r.map((m) => [m.key, m.state, m.done, m.current]), [['M0', 'done', true, false], ['M1', 'in progress', false, true], ['M2', 'not started', false, false]], 'the README plan is not a milestone');
  const [m0, m1, m2] = r;
  assert.equal(m0.plan.tryIt, '1. `pnpm test`');
  assert.equal(m0.verified, 'CI green on main');
  assert.deepEqual([m0.started, m0.finished], ['2026-09-20T09:00:00.000Z', '2026-09-22T09:00:00.000Z'], 'from its plan to its last merge');
  assert.deepEqual(m0.tasks.map((t) => [t.id, t.state, t.attempts, t.engine]), [['M0-01-repo', 'merged', 2, 'Antigravity']]);
  assert.deepEqual(m1.tasks.map((t) => [t.id, t.state, t.attempts, t.engine, t.switched]), [['M1-01-api', 'running', 1, 'Codex', true], ['M1-02-ui', 'planned', 0, '', false], ['X-review', 'planned', 0, '', false]]);
  assert.deepEqual(m1.counts, { total: 3, closed: 0, merged: 0, running: 1, queued: 0 });
  assert.equal(m1.goal, 'members book a class');
  assert.equal(m1.finished, null, 'not done');
  assert.deepEqual([m2.goal, m2.plan, m2.started], ['members pay by card', null, null], "a future one: the brief's goal");

  // Pace: 1 milestone in 2 days so far; 2 left, the current one 1 day in
  const now = Date.parse('2026-09-24T09:00:00Z');
  const p = pace(r, now);
  assert.deepEqual([p.total, p.done, p.left, p.started, p.lastFinished, p.basis], [3, 1, 2, '2026-09-20T09:00:00.000Z', '2026-09-22T09:00:00.000Z', 1]);
  assert.equal(p.perMilestone, 2);
  assert.equal(p.estimate.days, 3, '2 left x 2 days, less the day M1 has had');
  assert.equal(p.estimate.by, '2026-09-27T09:00:00.000Z');
  const none = pace(buildRoadmap({ status: status.map((m) => ({ ...m, done: false, state: '' })) }), now);
  assert.equal(none.estimate, null);
  assert.match(none.why, /needs at least one finished milestone/);
  assert.match(pace([], now).why, /No milestones yet/);
  assert.equal(pace([{ ...m0 }], now).why, 'Every milestone is done.');
});

test("Home's Blockers: a headline colored by meaning, labeled bullets, the history folded away", () => {
  assert.deepEqual(blockersView(''), { level: 'ok', headline: 'No blockers', sub: '', items: [], history: [] });
  // The template's Blockers ("None." and the comment on how to write them) are no blockers, in the status too
  assert.equal(parseBlockers('None.\n\n<!-- - **Needs you:** ... -->').items.length, 0);
  const tmp = fs.mkdtempSync(`${process.env.TMPDIR || process.env.TEMP || '/tmp'}/nl-status-`);
  try {
    fs.mkdirSync(`${tmp}/docs`);
    fs.writeFileSync(`${tmp}/docs/STATUS.md`, template('docs/STATUS.md'));
    assert.equal(getState({ root: tmp }).blockers, '');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const text = [
    '- **Needs you:** put the SMTP host in `.env` (H3)',
    '- **Blocked by the tool:** Codex workers can\'t reach Docker on Windows (FR-009); M3-02 waits.',
    '  The fallback is Antigravity.',
    '- Known limitation: Antigravity reports no tokens.',
    '- [Decision] Postgres, not SQLite.',
    '- The old way of writing it',
    '',
    '### History',
    '- **Needs you:** buy the domain (H1)',
    '- ~~DNS~~ done',
  ].join('\n');
  const v = blockersView(text, [{ id: 'H3', what: 'SMTP host' }, { id: 'H4', what: 'Stripe key', where: 'the Stripe panel' }], ['H1']);
  assert.equal(v.level, 'blocked');
  assert.equal(v.headline, "Blocked: Codex workers can't reach Docker on Windows (FR-009)", 'up to the first clause break');
  assert.equal(v.sub, 'Waiting on you: 2', 'the bullet for H3, and H4 which no bullet names');
  assert.deepEqual(v.items.map((x) => [x.kind, x.label]), [['blocked', 'Blocked by the tool'], ['needs', 'Needs you'], ['needs', 'Needs you'], ['open', ''], ['decision', 'Decision'], ['limitation', 'Known limitation']]);
  assert.equal(v.items[0].text, "Codex workers can't reach Docker on Windows (FR-009); M3-02 waits.\nThe fallback is Antigravity.", 'an indented line belongs to its item');
  assert.equal(v.items[1].text, 'put the SMTP host in `.env` (H3)', 'Markdown kept: the page renders it');
  assert.deepEqual([v.items[2].text, v.items[2].handoff], ['Stripe key (the Stripe panel)', true]);
  assert.deepEqual(v.history, ['- **Needs you:** buy the domain (H1)', '- ~~DNS~~ done']);

  assert.deepEqual(blockersView('- **Needs you:** the SMTP host (H3)', [{ id: 'H3', what: 'SMTP host' }]).headline, 'Waiting on you: 1');
  // An item the owner has done (its handoff item is closed) no longer counts; the orchestrator takes it out later
  const handled = blockersView('- **Needs you:** the SMTP host (H3)\n- **Note:** staging is slow', [], ['H3']);
  assert.deepEqual([handled.level, handled.headline, handled.items[0].handled], ['ok', 'No blockers', true]);
  const unlabeled = blockersView('Waiting for the owner to pick a payment provider.');
  assert.deepEqual([unlabeled.level, unlabeled.headline], ['waiting', '1 open item, not labeled yet']);
  const resolved = blockersView('- **Resolved:** the build is green again\n- [x] the domain is bought');
  assert.deepEqual([resolved.level, resolved.items.length, resolved.history.length], ['ok', 0, 2]);
  const details = blockersView('- **Blocked by the tool:** agy hangs\n\n<details><summary>Earlier</summary>\n\n- it hung before\n</details>');
  assert.deepEqual([details.items.length, details.history], [1, ['- it hung before']]);
  const many = blockersView('- **Blocked:** one\n- **Blocked by the tool:** two');
  assert.equal(many.headline, 'Blocked: one (and 1 more)');
});

// ---------- FR-021: closed tasks ----------
// A real project's Walking skeleton on 4 October: "147 of 162 merged", and the 162 held five tasks closed at the owner's word
// (note N24) only in their specs. A closure is the hub's record (lib/closures.mjs, .nextlevel/closed.json).
const N24 = ['WS-24A3A1-unit-conversion-table', 'WS-24A4-import-from-url-proof', 'WS-32B3A1-offline-list-queue', 'WS-32B3B-list-merge-recovery', 'WS-32B4-pantry-stock-sync'];
const closedOn = (ids, reason = "the owner's note N24, 1 October: harness follow-ups, on Later") => closuresOf({ version: 1, tasks: Object.fromEntries(ids.map((id) => [id, { at: '2026-10-01T15:00:00.000Z', by: 'orchestrator', source: "the orchestrator's window", reason, discarded: false, branch: '', jobState: '', milestone: 'Walking skeleton', title: '' }])) });

test('FR-021: a closed task shows as closed with its reason, out of "N of M merged" and said apart; a merge or an active job outranks it', () => {
  const status = [{ name: 'M1 Sign-up', state: 'in progress', verified: '', done: false }, { name: 'M2 Billing', state: 'not started', verified: '', done: false }];
  const specs = ['M1-01-db', 'M1-02-ui', 'M1-03-old-ui', 'M1-04-retired', 'M1-05-again', 'M2-01-invoices'].map((id) => ({ id, milestone: id.slice(0, 2), title: id }));
  const jobs = [
    { id: 'M1-04-retired', state: 'failed', summary: 'failed · verify fail', attempt: 3, createdAt: '2026-09-20T09:00:00Z', finishedAt: '2026-09-21T09:00:00Z' },
    { id: 'M1-05-again', state: 'running', summary: 'running', attempt: 2, createdAt: '2026-09-25T09:00:00Z' },
  ];
  const merged = mergedTasks("2026-09-24T10:00:00Z\tMerge branch 'task/M1-01-db'");
  const closed = closuresOf({
    version: 1,
    tasks: {
      'M1-03-old-ui': { at: '2026-09-22T08:00:00.000Z', by: 'orchestrator', reason: 'replaced by M1-02-ui' },
      'M1-04-retired': { at: '2026-09-23T08:00:00.000Z', by: 'owner', reason: 'out of scope', discarded: true },
      'M1-05-again': { at: '2026-09-23T08:00:00.000Z', by: 'orchestrator', reason: 'reopened since' }, // its job runs: open
      'M1-01-db': { at: '2026-09-23T08:00:00.000Z', by: 'orchestrator', reason: 'merged since' }, // a merge outranks it
      'M2-01-invoices': { at: '2026-09-26T08:00:00.000Z', by: 'orchestrator', reason: 'billing moved to M5' },
    },
  });
  const [m1, m2] = buildRoadmap({ status, specs, jobs, merged, closed, plans: [{ file: 'docs/plans/M1.md', milestone: 'M1 Sign-up', title: 'M1', outcome: 'x', acceptance: 'y', tryIt: 'z', added: '2026-09-19T09:00:00Z' }] });
  assert.deepEqual(m1.tasks.map((t) => [t.id, t.state, t.summary]), [
    ['M1-01-db', 'merged', 'merged 2026-09-24'],
    ['M1-02-ui', 'planned', 'not dispatched yet'],
    ['M1-03-old-ui', 'closed', 'closed 2026-09-22: replaced by M1-02-ui'],
    ['M1-04-retired', 'closed', 'closed 2026-09-23: out of scope'],
    ['M1-05-again', 'running', 'running'],
  ]);
  assert.deepEqual(m1.counts, { total: 3, closed: 2, merged: 1, running: 1, queued: 0 }, 'closed tasks leave the count, said apart');
  assert.deepEqual(m1.tasks[3].closed, { at: '2026-09-23T08:00:00.000Z', reason: 'out of scope', by: 'owner', discarded: true });
  // A closed task's attempts never set the milestone's dates: M1 started with its plan, not M1-04's first attempt
  assert.equal(m1.started, '2026-09-19T09:00:00.000Z');
  const early = buildRoadmap({ status, specs, jobs: [{ ...jobs[0], createdAt: '2026-09-01T09:00:00Z' }], closed, plans: [] });
  assert.equal(early[0].started, null, "a closed task's attempt alone starts nothing");
  // A milestone whose only tasks are closed has no task without a plan
  assert.deepEqual([m2.counts.total, m2.counts.closed, m2.tasks[0].state], [0, 1, 'closed']);
  assert.deepEqual(planProblems([m1, m2]), [], 'M2 has only a closed task: no "tasks but no plan"');
  const open = buildRoadmap({ status, specs, jobs, merged, plans: [] });
  assert.equal(planProblems(open).filter((x) => x.key === 'M2').length, 1, 'without the closure it would warn');
  // A closed task whose spec is gone since stays where its spec put it, by its closure
  const gone = buildRoadmap({ status, specs: [], closed: closuresOf({ version: 1, tasks: { 'X-old': { at: '2026-09-22T08:00:00.000Z', reason: 'replaced', milestone: 'M2 Billing', title: 'Old invoices' } } }) });
  assert.deepEqual(gone[1].tasks.map((t) => [t.id, t.title, t.state]), [['X-old', 'Old invoices', 'closed']]);
});

test("FR-021: a fixture shaped like a real project: the five tasks closed at N24 leave the Walking skeleton's count", () => {
  const specs = [...SAMPLE_SPECS, ...N24.map((id) => ({ id, milestone: 'Walking skeleton' }))];
  const ws = (closed) => buildRoadmap({ status: sampleStatus(), plans: samplePlans(), specs, merged: SAMPLE_MERGED, closed }).find((m) => m.name === 'Walking skeleton');
  const before = ws(new Map());
  assert.deepEqual([before.counts.merged, before.counts.total, before.counts.closed], [1, 7, 0], 'as on 4 October: the five counted as planned');
  assert.deepEqual(before.tasks.filter((t) => N24.includes(t.id)).map((t) => t.summary), N24.map(() => 'not dispatched yet'));
  const after = ws(closedOn(N24));
  assert.deepEqual([after.counts.merged, after.counts.total, after.counts.closed], [1, 2, 5]);
  assert.deepEqual(after.tasks.filter((t) => N24.includes(t.id)).map((t) => t.summary), N24.map(() => "closed 2026-10-01: the owner's note N24, 1 October: harness follow-ups, on Later"));
});

test('FR-021: a merge the hub made counts as merged: its subject names task/<id> with -m too, and a finished merge job counts', () => {
  assert.equal(mergeMessage('M1-02-ui', ''), "Merge branch 'task/M1-02-ui'");
  assert.equal(mergeMessage('M1-02-ui', 'The sign-up form'), 'Merge task/M1-02-ui: The sign-up form');
  assert.equal(mergeMessage('M1-02-ui', 'Merge task/M1-02-ui: the form\n\nwith tests'), 'Merge task/M1-02-ui: the form\n\nwith tests', 'a subject that names it first stays');
  assert.equal(mergeMessage('M1-02-ui', 'like task/M1-01-db\nmore'), 'Merge task/M1-02-ui: like task/M1-01-db\nmore', 'another task named first');
  assert.equal(mergeMessage('M1-02-ui', 'Merge main into task/M1-02-ui'), "Merge branch 'task/M1-02-ui'\n\nMerge main into task/M1-02-ui", 'what reads as a merge into the task goes below');
  for (const m of ['The sign-up form', 'like task/M1-01-db', 'Merge main into task/M1-02-ui']) {
    assert.deepEqual([...mergedTasks(`2026-10-01T10:00:00Z\t${mergeMessage('M1-02-ui', m).split('\n')[0]}`).keys()], ['M1-02-ui'], m);
  }
  // A merge whose subject missed it (before FR-021), or a branch "merged already": the hub's finished merge job counts
  const jobs = mergeJobsDone([
    { status: { state: 'done', finishedAt: '2026-10-02T10:00:00Z' }, job: { op: 'merge', task: 'M1-03-own-message' } },
    { status: { state: 'failed', finishedAt: '2026-10-02T11:00:00Z' }, job: { op: 'merge', task: 'M1-04-conflict' } },
    { status: { state: 'done' }, job: { op: 'commit' } },
  ]);
  assert.deepEqual(jobs, [{ task: 'M1-03-own-message', at: '2026-10-02T10:00:00Z' }]);
  const merged = mergedTasks('2026-10-02T10:00:01Z\tThe sign-up form, at last', jobs);
  assert.deepEqual([...merged], [['M1-03-own-message', '2026-10-02T10:00:00Z']]);
});

test('FR-021: closed.json is read through a shape check: what the hub would not write is left out, and a bridge-test task never has a closure', () => {
  const good = { at: '2026-10-01T15:00:00.000Z', by: 'orchestrator', reason: 'replaced by M1-05' };
  const map = closuresOf({
    version: 1,
    tasks: {
      'M1-01-a': good,
      'T000-bridge-1': good,
      '../escape': good,
      'M1-02-b': { ...good, reason: 'two\nlines' },
      'M1-03-c': { ...good, reason: 'x'.repeat(301) },
      'M1-04-d': { ...good, at: 'yesterday' },
      'M1-05-e': { ...good, reason: { toString: () => 'x' } },
      'M1-06-f': 'closed',
      'M1-07-g': { ...good, discarded: 'yes', by: 7 },
    },
  });
  assert.deepEqual([...map.keys()], ['M1-01-a', 'M1-07-g']);
  assert.deepEqual([map.get('M1-07-g').discarded, map.get('M1-07-g').by], [false, 'owner']);
  for (const bad of [null, [], 'x', { version: 2, tasks: { 'M1-01-a': good } }, { version: 1, tasks: [] }]) assert.equal(closuresOf(bad).size, 0);
  assert.deepEqual(closuresOf(closuresFile(map)), map, 'what the hub writes reads back the same');
  assert.deepEqual(closedSince(map, Date.parse('2026-10-01T00:00:00Z')).map((c) => c.id), ['M1-01-a', 'M1-07-g']);
  assert.equal(closedText(good), 'closed 2026-10-01: replaced by M1-05');
  assert.deepEqual(closeReason('  replaced\n by   M1-05 '), { reason: 'replaced by M1-05' });
  assert.match(closeReason('').problem, /say why it is closed/);
  assert.match(closeReason('x'.repeat(301)).problem, /301 characters, more than 300/);
});

test('files saved on Windows (CRLF line ends) read the same as with LF: plans, PROJECT.md, DECISIONS.md, STATUS.md, task specs', async () => {
  const { taskTitle } = await import('../src/lib/overview.mjs');
  const { kindOf, resultFileOf } = await import('../src/lib/reports.mjs');
  const { specNeeds } = await import('../src/lib/needs.mjs');
  const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
  const same = (what, parse, text) => assert.deepEqual(parse(crlf(text)), parse(text), what);
  for (const [f, text] of Object.entries(SAMPLE_PLANS)) same(f, parsePlan, text);
  same('PROJECT.md', parseProjectDoc, template('docs/PROJECT.md'));
  same('DECISIONS.md', parseDecisions, `${template('docs/DECISIONS.md')}\n## 2026-10-01 Postgres, not SQLite\nBecause the team knows it.\n`);
  const blockers = '- **Needs you:** put the SMTP host in `.env` (H3)\n- **Blocked by the tool:** Codex workers\n  The fallback is Antigravity.\n- [Decision] Postgres.\n';
  same('STATUS.md milestones', statusMilestones, fixture('STATUS.md'));
  same('Blockers', parseBlockers, blockers);
  same("Home's Blockers", blockersView, blockers);
  const spec = `# T-9 — Hello\n\nKind: design\nResult file: \`docs/design/T-9.md\`\nMilestone: M1\nNeeds: docker, network\n\n## Goal\nSay hello.\n`;
  for (const [what, parse] of Object.entries({ taskTitle: (t) => taskTitle(t, 'T-9'), kindOf, resultFileOf, specNeeds, specMilestone })) same(what, parse, spec);
  // getState reads STATUS.md from disk: its Blockers keep no carriage returns
  const tmp = fs.mkdtempSync(`${process.env.TMPDIR || process.env.TEMP || '/tmp'}/nl-status-`);
  try {
    fs.mkdirSync(`${tmp}/docs`);
    const status = fixture('STATUS.md').replace(/## Blockers\n[\s\S]*?(?=\n## )/, `## Blockers\n${blockers}`);
    fs.writeFileSync(`${tmp}/docs/STATUS.md`, status);
    const lf = getState({ root: tmp });
    fs.writeFileSync(`${tmp}/docs/STATUS.md`, crlf(status));
    const windows = getState({ root: tmp });
    assert.ok(lf.blockers.includes('Needs you'));
    assert.equal(windows.blockers, lf.blockers);
    assert.deepEqual(windows.milestones, lf.milestones);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
