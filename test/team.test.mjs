// The team and the day (M9): nextlevel.json's efforts, setup guide role and fallbacks of their own; what each
// engine uses when nothing is pinned; `nextlevel team` (show, list models, a change checked before it is
// saved); the hub taking a new team at the next task; the Home page's sentences, needs and numbers.
//   npm test
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { parseAgyModels } from '../src/engines/agy.mjs';
import { WORKER_ENV as CODEX_KEEP_ENV, parseCodexModels } from '../src/engines/codex.mjs';
import { engine, sessionArgs } from '../src/engines/index.mjs';
import { defaults, describeProfile, engineUse, loadConfig, profilesInUse, roleProfile, securityProfile, settingKeys, withRole } from '../src/lib/config.mjs';
import { codexTokens, gist, ownerNeeds, taskAlerts, taskSentence, taskTitle } from '../src/lib/overview.mjs';
import { inUse, teamView, windowView } from '../src/lib/team.mjs';
import { REPO as REPO_ROOT, fileExists, makeProject, processesGone } from './helpers.mjs';

const configOf = (obj) => loadConfig('/proj', { env: {}, raw: { version: 1, ...obj } });

// ---------- nextlevel.json ----------
test('roles take an effort, the setup guide is a role, and a fallback can have a model and effort of its own', () => {
  const cfg = defaults('p');
  assert.deepEqual(cfg.roles.guide, { engine: '', model: '', effort: '', profile: '' }, 'new files show the guide role');
  const { config } = configOf({
    roles: {
      orchestrator: { engine: 'codex', model: 'gpt-6', effort: 'high' },
      worker: { engine: 'agy', effort: 'low', fallback: { engine: 'claude', model: 'opus', effort: 'max' } },
      guide: { engine: 'claude', model: 'sonnet' },
    },
  });
  assert.deepEqual(roleProfile(config, 'orchestrator'), { name: '', engine: 'codex', account: '', model: 'gpt-6', effort: 'high' });
  assert.deepEqual(roleProfile(config, 'worker', { fallback: true }), { name: '', engine: 'claude', account: '', model: 'opus', effort: 'max' });
  assert.deepEqual(roleProfile(config, 'guide'), { name: '', engine: 'claude', account: '', model: 'sonnet', effort: '' });
  assert.deepEqual(settingKeys(config, 'worker', { fallback: true }), { model: 'roles.worker.fallback.model', effort: 'roles.worker.fallback.effort' });
  assert.equal(describeProfile(roleProfile(config, 'orchestrator')), 'codex gpt-6 (effort high)');
  // The guide counts like a fallback: the build team doesn't run on it
  assert.deepEqual(profilesInUse(config).map((p) => [p.role, p.fallback, p.engine]), [['orchestrator', false, 'codex'], ['worker', false, 'agy'], ['worker', true, 'claude'], ['guide', false, 'claude']]);
  assert.equal(engineUse(config, 'claude'), 'fallback');
  // Without an engine of its own the guide is the orchestrator's, and isn't counted twice
  assert.deepEqual(roleProfile(cfg, 'guide'), roleProfile(cfg, 'orchestrator'));
  assert.equal(profilesInUse(cfg).filter((p) => p.role === 'guide').length, 0);
  // Mistakes name the setting
  const bad = (obj, re) => assert.throws(() => configOf(obj), re);
  bad({ roles: { worker: { effort: 'Very High' } } }, /"roles\.worker\.effort" is a word like low, medium or high, not "Very High"/);
  bad({ roles: { worker: { fallback: { engine: 'gemini' } } } }, /"roles\.worker\.fallback\.engine" must be agy, codex or claude, not "gemini"/);
  bad({ roles: { guide: { engine: 'gemini' } } }, /"roles\.guide\.engine" must be agy, codex or claude/);
  bad({ roles: { worker: { profile: 'a', effort: 'high' } }, profiles: { a: { engine: 'codex' } } }, /names profile "a" and an engine, model or effort too/);
  bad({ profiles: { a: { engine: 'codex', effort: 'x y' } } }, /"profiles\.a\.effort" is a word like low/);
  assert.equal(roleProfile(configOf({ profiles: { a: { engine: 'codex', effort: 'high' } }, roles: { worker: { profile: 'a' } } }).config, 'worker').effort, 'high');
});

test("withRole changes one role and keeps the rest of the file as it was", () => {
  const raw = { version: 1, name: 'p', $note: 'mine', roles: { orchestrator: { engine: 'codex', model: '', fallback: 'claude' }, worker: { engine: 'agy', fallback: 'codex' } } };
  const w = withRole(raw, 'worker', { engine: 'claude', model: 'opus', effort: 'high' });
  assert.deepEqual(w.roles.worker, { engine: 'claude', model: 'opus', effort: 'high', profile: '', fallback: 'codex' }, 'its fallback stays');
  assert.equal(w.$note, 'mine');
  assert.deepEqual(raw.roles.worker, { engine: 'agy', fallback: 'codex' }, 'the original is untouched');
  assert.deepEqual(withRole(raw, 'orchestrator', { profile: 'cw' }).roles.orchestrator, { profile: 'cw', fallback: 'claude' });
  assert.equal(withRole(raw, 'worker', { engine: 'agy' }, { fallback: true }).roles.worker.fallback, 'agy', 'an engine alone stays a name');
  assert.deepEqual(withRole(raw, 'worker', { engine: 'claude', model: 'sonnet', effort: '' }, { fallback: true }).roles.worker.fallback, { engine: 'claude', model: 'sonnet', effort: '' });
  assert.deepEqual(withRole(raw, 'guide', { engine: 'claude', model: '', effort: 'low' }).roles.guide, { engine: 'claude', model: '', effort: 'low', profile: '' });
  assert.doesNotThrow(() => configOf(withRole(raw, 'worker', { engine: 'claude', model: 'opus', effort: 'high' }, { fallback: true })));
});

// ---------- the engines ----------
test('a role\'s effort reaches each engine the way it takes one', () => {
  const run = (p, mode, role, args = []) => sessionArgs(p, { mode, role, prompt: 'P', timeoutMin: 30, args });
  // Codex: -c for codex exec; none for its interactive window (it would leave the shared background server)
  assert.deepEqual(run({ engine: 'codex', model: 'gpt-6', effort: 'high' }, 'headless', 'worker', ['--sandbox', 'workspace-write']), ['exec', '-m', 'gpt-6', '-c', 'model_reasoning_effort=high', '--sandbox', 'workspace-write', ...CODEX_KEEP_ENV, '--json', 'P']);
  assert.deepEqual(run({ engine: 'codex', effort: 'high' }, 'interactive', 'orchestrator', ['--sandbox', 'workspace-write']), ['--sandbox', 'workspace-write', 'P']);
  assert.match(engine('codex').effortNote, /shared background server/);
  // agy (FR-010): never --effort, neither the role's nor one in engines.agy.args (its Claude models refuse it with
  // "--effort is not supported for model claude-opus-4-6-thinking"); the level is in a Gemini model's name
  const agy = run({ engine: 'agy', effort: 'low' }, 'headless', 'worker', ['--dangerously-skip-permissions', '--effort', 'high']);
  assert.deepEqual(agy.slice(4), ['--output-format', 'stream-json', '--dangerously-skip-permissions']);
  assert.deepEqual(run({ engine: 'agy', model: 'claude-opus-4-6-thinking' }, 'headless', 'worker', ['--effort', 'high']).slice(4), ['--model', 'claude-opus-4-6-thinking', '--output-format', 'stream-json']);
  assert.deepEqual(run({ engine: 'agy', effort: 'medium' }, 'interactive', 'guide', ['--dangerously-skip-permissions']), ['-i', 'P']);
  assert.deepEqual(engine('agy').efforts, [], 'no Effort field on the Team page');
  // Claude Code: --effort
  const claude = run({ engine: 'claude', model: 'opus', effort: 'max' }, 'headless', 'worker');
  assert.deepEqual(claude.slice(2, 6), ['--model', 'opus', '--effort', 'max']);
  for (const e of ['codex', 'claude']) assert.ok(engine(e).efforts.includes('high') && engine(e).efforts.includes('low'), e);
});

test("the engine's own choice, as its files say: Codex's config.toml and model cache, Claude Code's settings, agy's", () => {
  const home = '/home/me';
  const files = {
    '/home/me/.codex/config.toml': 'model = "gpt-6"\nmodel_reasoning_effort = "xhigh"\n[profiles.x]\nmodel = "nope"\n',
    '/home/me/.nextlevel/accounts/codex/two/models_cache.json': JSON.stringify({ fetched_at: 'x', models: [{ slug: 'gpt-6-mini', priority: 5, visibility: 'list', default_reasoning_level: 'low' }, { slug: 'gpt-6-astra', priority: 1, visibility: 'list', default_reasoning_level: 'medium' }, { slug: 'secret', priority: 0, visibility: 'hide' }] }),
    '/home/me/.claude/settings.json': JSON.stringify({ model: 'opus', effortLevel: 'high' }),
    '/home/me/.gemini/antigravity-cli/settings.json': JSON.stringify({ model: 'Gemini 3.8 Flash (High)' }),
  };
  // A PC of its own, Linux: teamView takes this PC's platform only when `where` has none
  const where = { home, env: {}, read: (f) => files[f] ?? null, path: path.posix, platform: 'linux' };
  const codex = inUse({ engine: 'codex', account: '', model: '', effort: '' }, defaults('p'), where);
  assert.deepEqual([codex.model, codex.modelFrom, codex.effort], ['gpt-6', '/home/me/.codex/config.toml', 'xhigh']);
  // A second account without a model of its own: the account's default (the lowest priority it lists), with that model's default effort
  const two = inUse({ engine: 'codex', account: 'two', model: '', effort: '' }, defaults('p'), where);
  assert.deepEqual([two.model, two.effort], ['gpt-6-astra', 'medium']);
  assert.match(two.modelFrom, /models_cache\.json: the account's default/);
  // Pinned wins
  assert.deepEqual([inUse({ engine: 'codex', model: 'gpt-7', effort: 'low' }, defaults('p'), where).model, inUse({ engine: 'codex', model: 'gpt-7', effort: 'low' }, defaults('p'), where).modelFrom], ['gpt-7', 'nextlevel.json']);
  const claude = inUse({ engine: 'claude', model: '', effort: '' }, defaults('p'), where);
  assert.deepEqual([claude.model, claude.effort], ['opus', 'high']);
  assert.equal(inUse({ engine: 'claude', model: '', effort: '' }, defaults('p'), { ...where, env: { ANTHROPIC_MODEL: 'sonnet' } }).modelFrom, 'ANTHROPIC_MODEL');
  // agy: the level its model's name carries (FR-010); an effort in nextlevel.json is not used, and said so
  const agy = inUse({ engine: 'agy', model: '', effort: '' }, defaults('p'), where);
  assert.deepEqual([agy.model, agy.effort, agy.effortFrom], ['Gemini 3.8 Flash (High)', 'high', "the model's name"]);
  const pinnedAgy = inUse({ engine: 'agy', model: 'claude-opus-4-6-thinking', effort: 'high' }, defaults('p'), where);
  assert.deepEqual([pinnedAgy.effort, pinnedAgy.ignored], ['', 'high']);
  // Nothing in the files: said plainly
  const bare = { ...where, read: () => null };
  assert.equal(inUse({ engine: 'codex', model: '', effort: '' }, defaults('p'), bare).byDefault, "the account's default model");

  // The Team page's rows
  const rows = teamView(defaults('p'), where);
  assert.deepEqual(rows.map((r) => r.key), ['orchestrator', 'worker', 'worker-second', 'worker-fallback', 'guide', 'assistant', 'security']);
  assert.equal(rows[0].model.text, "gpt-6 (Codex's own, from ~/.codex/config.toml)");
  assert.equal(rows[1].effort.text, "high (from the model's name)");
  assert.equal(rows[1].effort.fixed, true, 'no Effort field: the level is in the model');
  const agyRow = teamView(configOf({ roles: { worker: { engine: 'agy', model: 'claude-opus-4-6-thinking', effort: 'high' } } }).config, where)[1];
  assert.equal(agyRow.effort.text, "none: the model's name carries no level");
  assert.match(agyRow.effort.note, /^roles\.worker\.effort \("high"\) in nextlevel\.json isn't used: Antigravity takes the level from the model's name/);
  assert.equal(rows[4].sameAs, 'orchestrator');
  assert.ok(rows[1].notes.some((n) => /console with no window/.test(n)), 'what Antigravity means for workers');
  // How a worker's process shows (workers.window, FR-010)
  assert.deepEqual(windowView(defaults('p'), 'win32').mode, 'hidden');
  assert.deepEqual(windowView(defaults('p'), 'win32').choices.map((c) => c.mode), ['hidden', 'minimized', 'visible']);
  assert.match(windowView(defaults('p'), 'win32').choices[1].text, /Windows still gives that window the keyboard focus/);
  assert.match(windowView(defaults('p'), 'linux').text, /no window on this system/);
  assert.ok(rows[0].notes.some((n) => /ChatGPT plan/.test(n)));
  const withFb = teamView(configOf({ roles: { orchestrator: { engine: 'codex', fallback: 'claude' } } }).config, where);
  assert.deepEqual(withFb.map((r) => r.key).slice(-3), ['orchestrator-fallback', 'assistant', 'security'], 'shown once there is one');
  // The security engineer: off by default; on Codex with Daybreak when the owner turns it on, never in profilesInUse
  const sec = rows.find((r) => r.key === 'security');
  assert.ok(sec.none && sec.off && !sec.daybreak);
  assert.match(sec.text, /^off: turn it on/);
  const secOn = teamView(configOf({ roles: { security: { engine: 'codex', model: 'gpt-6-sol', effort: 'xhigh', daybreak: true } } }).config, where).find((r) => r.key === 'security');
  assert.equal(secOn.engine, 'codex');
  assert.equal(secOn.model.set, 'gpt-6-sol');
  assert.equal(secOn.model.key, 'roles.security.model');
  assert.ok(secOn.daybreak);
  assert.match(secOn.daybreakText, /^Daybreak Blue/);
  assert.ok(secOn.notices.some((n) => /^The scanner's sign-in is kept in a Docker volume of its own: any program that can use Docker on this PC can read it./.test(n)), 'V8: said on its row');
  assert.ok(secOn.notes.some((n) => /Codex Security/.test(n)));
  assert.deepEqual(secOn.warnings, [], 'a scan never runs with engines.codex.args: no full-access warning');
  // FR-009: Codex as a worker or fallback worker on Windows is a warning on its card; the orchestrator on Codex isn't.
  // FR-017: a role that runs with no permission check has the owner's full access: a warning on a role in the main
  // checkout (the orchestrator...), a note on the workers (accepted by design: slots, the push block, Antigravity's
  // unattended mode).
  assert.deepEqual(rows.map((r) => [r.warnings.length, r.notices.length]), [[0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]], 'on Linux: a note on the workers on Antigravity');
  assert.match(rows[1].notices[0], /^Antigravity skips its permission checks for it \(--dangerously-skip-permissions in engines\.agy\.args, which it needs to run unattended\): it acts with your full access\. Accepted by design: a worker runs in a slot of its own/);
  const onWindows = teamView(defaults('p'), { ...where, platform: 'win32' });
  assert.deepEqual(onWindows.map((r) => [r.key, r.warnings.length]), [['orchestrator', 0], ['worker', 0], ['worker-second', 0], ['worker-fallback', 1], ['guide', 0], ['assistant', 0], ['security', 0]]);
  assert.match(onWindows[3].warnings[0], /refused anything that starts Docker.*package installs \(pnpm install.*Turning its network on doesn't change that.*on the Team page/s);
  // Codex workers out of the sandbox (their own arguments): no warning, full access said as information; the orchestrator
  // on Codex keeps its sandbox and has nothing to say
  const out = configOf({ roles: { worker: { engine: 'codex' } }, engines: { codex: { workerArgs: ['--sandbox', 'danger-full-access', '-c', 'approval_policy=never'] } } }).config;
  const free = teamView(out, { ...where, platform: 'win32' });
  assert.deepEqual(free.map((r) => [r.key, r.warnings.length, r.notices.length]), [['orchestrator', 0, 0], ['worker', 0, 1], ['worker-second', 0, 0], ['worker-fallback', 0, 1], ['guide', 0, 0], ['assistant', 0, 0], ['security', 0, 0]]);
  assert.match(free[1].notices[0], /^Codex runs it without its sandbox \(danger-full-access or --dangerously-bypass-approvals-and-sandbox in the workers' arguments\): it acts with your full access\. Accepted by design: a worker runs in a slot of its own, where git refuses its pushes \(FR-003\), and Codex's sandbox would keep it from Docker, pnpm and git/);
  const here = teamView(defaults('p'), { ...where, platform: undefined });
  assert.deepEqual(here.map((r) => r.warnings.length), process.platform === 'win32' ? [0, 0, 0, 1, 0, 0, 0] : [0, 0, 0, 0, 0, 0, 0], "without a platform: this PC's");
  // The orchestrator on Antigravity: a warning; the setup guide on it has none (it asks before it runs anything)
  const agyOrch = teamView(configOf({ roles: { orchestrator: { engine: 'agy' }, guide: { engine: 'agy' }, worker: { engine: 'claude' } } }).config, where);
  assert.deepEqual(agyOrch.map((r) => [r.key, r.warnings.length, r.notices.length]), [['orchestrator', 1, 0], ['worker', 0, 0], ['worker-second', 0, 0], ['worker-fallback', 0, 0], ['guide', 0, 0], ['assistant', 0, 0], ['security', 0, 0]]);
  assert.match(agyOrch[0].warnings[0], /it acts with your full access in your main checkout and could push or deploy directly/);
});

test('model lists as the CLIs print them', () => {
  const codex = parseCodexModels(`{"models":[{"slug":"gpt-6","display_name":"GPT-6","default_reasoning_level":"medium","supported_reasoning_levels":[{"effort":"low","description":"x"},{"effort":"high","description":"y"}],"visibility":"list","priority":1},{"slug":"hidden","visibility":"hide"},{"slug":"none","visibility":"none"}]}`);
  assert.deepEqual(codex.map((m) => [m.id, m.label, m.efforts.join('/'), m.effort]), [['gpt-6', 'GPT-6', 'low/high', 'medium']]);
  assert.deepEqual(parseCodexModels('not json'), []);
  const agy = parseAgyModels('Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\nclaude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)\n');
  assert.deepEqual(agy.map((m) => [m.id, m.label]), [['gemini-3.8-flash-high', 'Gemini 3.8 Flash (High)'], ['claude-opus-4-6-thinking', 'Claude Opus 4.6 (Thinking)']]);
  assert.deepEqual(parseAgyModels('stub-model\nother-model').map((m) => m.id), ['stub-model', 'other-model'], 'one slug per line (before 1.1.11)');
});

// ---------- the Home page ----------
test('the Home page in plain words: a sentence per task, alerts, what needs the owner and the next action', () => {
  assert.equal(taskTitle('# M1-01-gateway — Gateway\n\nKind: code', 'M1-01-gateway'), 'Gateway');
  assert.equal(taskTitle('# <task-id> — <short title>', 'T1'), 'T1');
  assert.equal(taskTitle('no heading', 'T1'), 'T1');
  assert.equal(gist('Add a test for the retry path. Then rename it.'), 'add a test for the retry path');
  assert.equal(taskSentence({ id: 'g', state: 'running', attempt: 6, kind: 'code' }, { title: 'Gateway', feedback: 'The review found a test gap: add a test for the retry path.' }), 'Gateway, attempt 6: fixing what the review found: the review found a test gap: add a test for the retry path');
  assert.equal(taskSentence({ id: 'g', state: 'running', attempt: 1, kind: 'code' }, { title: 'Gateway' }), 'Gateway: building it');
  assert.equal(taskSentence({ id: 'g', state: 'verifying', attempt: 2, kind: 'code' }, { title: 'Gateway' }), "Gateway, attempt 2: the hub is checking the work with the task's own tests");
  assert.equal(taskSentence({ id: 'r', state: 'running', attempt: 1, kind: 'review' }), 'r: reviewing');

  assert.equal(codexTokens('...\ntokens used\n12,345\n'), 12345);
  assert.equal(codexTokens('tokens used\n1.234.567\n'), 1234567, 'separators of any language');
  assert.equal(codexTokens('tokens used\n12 345'), 12345);
  assert.equal(codexTokens('no usage here'), 0);

  const now = Date.parse('2026-09-26T12:00:00Z');
  const alerts = taskAlerts([
    { id: 'slow', type: 'task', state: 'running', attempt: 1, startedAt: '2026-09-26T10:30:00Z', timeoutMin: 60 },
    { id: 'again', type: 'task', state: 'queued', attempt: 4 },
    { id: 'done', type: 'task', state: 'done', attempt: 5, acked: true },
    { id: 'ok', type: 'task', state: 'running', attempt: 2, startedAt: '2026-09-26T11:50:00Z' },
    { id: 'check-x', type: 'check', state: 'running', attempt: 9, startedAt: '2026-09-26T08:00:00Z' },
  ], { taskTimeoutMin: 60, graceMin: 5, now });
  assert.deepEqual(alerts.map((a) => [a.id, a.kind]), [['slow', 'time'], ['again', 'attempts']]);
  assert.match(alerts[0].text, /has run 90 min, past its 60-min limit \(the hub stops it at 75 min\)/);
  assert.match(alerts[1].text, /is on attempt 4, past 3/);

  const base = { hub: { running: true }, autopilot: { on: false }, active: [], queued: [], review: [], waiting: [], milestones: [{ done: true }, { done: false }], alerts: [], windows: false, orchestrator: null };
  const failing = { results: [{ id: 'project.env', title: '.env', status: 'fail', severity: 'error', detail: 'missing', autoFix: true }] };
  const handoff = [{ id: 'H1', what: 'Add the SMTP password', where: '.env in the project folder', why: 'sign-up mail' }];
  const needs = ownerNeeds({ ...base, hub: { running: false }, queued: [{}], waiting: ['Add the SMTP password'], handoff, alerts: [alerts[1]] }, failing);
  assert.deepEqual(needs.map((n) => [n.kind, n.level]), [['setup', 'error'], ['hub', 'error'], ['task', 'warn'], ['handoff', 'warn']]);
  assert.deepEqual(needs[0].action, { label: 'Fix it', fix: 'project.env' }, "the one next action: the check's own fix");
  assert.deepEqual(needs[1].action, { label: 'Start the hub', post: '/api/hub', body: { action: 'start' } });
  // a handoff item: what, where and why, Done, and its card to reply on
  assert.deepEqual(needs[3].action, { label: 'Done', post: '/api/handoff', body: { action: 'done', id: 'H1' } });
  assert.deepEqual([needs[3].text, needs[3].why, needs[3].more], ['H1: Add the SMTP password (where: .env in the project folder)', 'sign-up mail', { label: 'Reply', page: 'notes' }]);
  assert.deepEqual(ownerNeeds({ ...base, waiting: ['An item of an older hub'] }).map((n) => n.action), [{ label: 'Open Notes', page: 'notes' }], 'without its card: the Notes page');
  assert.match(needs[1].text, /1 task waits/);
  assert.deepEqual(ownerNeeds({ ...base, autopilot: { on: true, paused: '3 cycles without progress' } }).map((n) => n.action.label), ['Resume autopilot']);
  assert.deepEqual(ownerNeeds({ ...base, review: [{}] }).map((n) => n.action.label), ['Turn on autopilot'], 'finished work, and nobody to review it');
  assert.deepEqual(ownerNeeds({ ...base, review: [{}], windows: true }).map((n) => n.action.label), ['Open the orchestrator']);
  assert.deepEqual(ownerNeeds({ ...base, review: [{}], orchestrator: { mode: 'interactive' } }), [], 'the orchestrator is at work');
  assert.deepEqual(ownerNeeds(base).map((n) => n.kind), ['idle'], 'nothing runs and nothing plans the next tasks');
  assert.deepEqual(ownerNeeds({ ...base, milestones: [{ done: true }] }), [], 'all done');
});

// ---------- nextlevel team, end to end ----------
const teamJson = (p, args, opts) => {
  const r = p.hub(['team', ...args, '--json'], opts);
  try {
    return { ...JSON.parse(r.out), code: r.code };
  } catch {
    throw new Error(`no JSON from nextlevel team ${args.join(' ')}:\n${r.out}`);
  }
};

test('the security engineer: off by default, on Codex only, with its Daybreak setting, never a role in use', () => {
  const off = configOf({}).config;
  assert.deepEqual(off.roles.security, { engine: '', model: '', effort: '', profile: '', daybreak: false });
  assert.deepEqual(off.security, { scanMinutes: 90, deepScanMinutes: 240 });
  assert.equal(roleProfile(off, 'security'), null);
  assert.equal(securityProfile(off), null);
  assert.deepEqual(settingKeys(off, 'security'), { model: '', effort: '' });
  // On: its profile, but never among the roles in use, so codex.model, autopilot's engine check and the advisor's
  // automatic choice never see it
  const only = configOf({ roles: { orchestrator: { engine: 'claude' }, worker: { engine: 'claude', fallback: '' }, security: { engine: 'codex', model: 'gpt-6-sol', effort: 'xhigh', daybreak: true } } }).config;
  assert.deepEqual(securityProfile(only), { name: '', engine: 'codex', account: '', model: 'gpt-6-sol', effort: 'xhigh', role: 'security', daybreak: true });
  assert.ok(!profilesInUse(only).some((p) => p.role === 'security'));
  assert.equal(engineUse(only, 'codex'), null, 'only the security engineer on Codex: Codex is no role in use');
  assert.equal(roleProfile(only, 'assistant').engine, 'claude', "the advisor's automatic choice doesn't count it");
  // Never Antigravity or Claude Code, through a profile too
  assert.throws(() => configOf({ roles: { security: { engine: 'agy' } } }), /"roles\.security" can't run on agy: nothing keeps Antigravity read-only or sandboxed/);
  assert.throws(() => configOf({ profiles: { argon: { engine: 'agy' } }, roles: { security: { profile: 'argon' } } }), /"roles\.security" can't run on agy/);
  assert.throws(() => configOf({ roles: { security: { engine: 'claude' } } }), /can't run on claude: Claude Code comes in a later version/);
  assert.throws(() => configOf({ security: { scanMinutes: 0 } }), /"security\.scanMinutes" must be a number of minutes from 5 to 1440/);
  // The old CODEX_MODEL never reaches it: its model is the one its Daybreak check passed
  const legacy = loadConfig('/proj', { env: { CODEX_MODEL: 'gpt-old' }, raw: { version: 1, roles: { security: { engine: 'codex', model: 'gpt-6-sol' } } } }).config;
  assert.equal(legacy.roles.orchestrator.model, 'gpt-old');
  assert.equal(legacy.roles.security.model, 'gpt-6-sol');
  // A change keeps Daybreak unless it sets it
  assert.equal(withRole({ roles: { security: { engine: 'codex', daybreak: true } } }, 'security', { engine: 'codex', model: 'x', effort: '' }).roles.security.daybreak, true);
  assert.equal(withRole({ roles: { security: { engine: 'codex', daybreak: true } } }, 'security', { engine: 'codex', model: 'x', effort: '', daybreak: false }).roles.security.daybreak, false);
});

test('nextlevel team set security: on Codex with Daybreak, off again, and refused elsewhere', () => {
  const p = makeProject();
  try {
    const file = path.join(p.repo, 'nextlevel.json');
    const before = fs.readFileSync(file, 'utf8');
    assert.match(teamJson(p, ['set', 'security', '--engine', 'agy']).message, /can't run on agy: nothing keeps Antigravity read-only or sandboxed/);
    assert.match(teamJson(p, ['set', 'security', '--engine', 'claude']).message, /Claude Code comes in a later version/);
    assert.match(teamJson(p, ['set', 'security', '--engine', 'codex', '--daybreak', 'maybe']).message, /--daybreak is on or off, not "maybe"/);
    assert.match(teamJson(p, ['set', 'worker', '--engine', 'codex', '--daybreak', 'on']).message, /--daybreak is the security engineer's/);
    assert.match(teamJson(p, ['set', 'security', '--engine', 'nothing']).message, /--engine must be codex, agy, claude, or off|--engine must be .*, or off/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written');
    // Turning it on checks its sign-in first: refused, naming the sign-in, which works while the role is off
    const early = teamJson(p, ['set', 'security', '--engine', 'codex', '--effort', 'xhigh', '--daybreak', 'on']);
    assert.equal(early.saved, false);
    assert.match(early.message, /^Not saved: The security engineer's sign-in: not signed in yet/);
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written');
    const login = p.hub(['security', 'login']);
    assert.equal(login.code, 0, login.out);
    const on = teamJson(p, ['set', 'security', '--engine', 'codex', '--effort', 'xhigh', '--daybreak', 'on']);
    assert.equal(on.saved, true, on.message);
    // (no model given: the first Daybreak works on, from the scanner's own Codex, saved by name)
    assert.match(on.message, /^Saved\. Security engineer: Codex, effort xhigh, Daybreak Blue, model gpt-6-sol \(the first the scanner's Codex lists for it\)\. It applies to the next scan you start/);
    assert.ok(!on.results.some((r) => r.id === 'codex.model'), "the model check of the roles in use doesn't see its model");
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).roles.security, { engine: 'codex', model: 'gpt-6-sol', effort: 'xhigh', profile: '', daybreak: true });
    const row = teamJson(p, []).rows.find((r) => r.key === 'security');
    assert.ok(row.daybreak && !row.none);
    const offAgain = teamJson(p, ['set', 'security', '--engine', 'off']);
    assert.equal(offAgain.saved, true);
    assert.match(offAgain.message, /The security engineer is off/);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).roles.security, { engine: '', model: '', effort: '', profile: '', daybreak: true }, 'Daybreak stays for the next time');
    assert.ok(teamJson(p, []).rows.find((r) => r.key === 'security').off);
  } finally {
    p.cleanup();
  }
});

test('nextlevel team shows the team, lists models, and saves a change only when the doctor\'s checks pass', () => {
  const p = makeProject();
  try {
    fs.mkdirSync(path.join(p.env.HOME, '.codex'), { recursive: true });
    fs.writeFileSync(path.join(p.env.HOME, '.codex', 'config.toml'), 'model = "gpt-6"\nmodel_reasoning_effort = "high"\n');
    const shown = p.hub(['team']);
    assert.equal(shown.code, 0, shown.out);
    assert.match(shown.out, /Orchestrator +Codex · model gpt-6 \(Codex's own, from ~[\\/]\.codex[\\/]config\.toml\) · effort high \(Codex's own/);
    assert.match(shown.out, /Setup guide +the orchestrator's: Codex/);
    const json = teamJson(p, []);
    assert.deepEqual(json.rows.map((r) => r.key), ['orchestrator', 'worker', 'worker-second', 'worker-fallback', 'guide', 'assistant', 'security']);
    assert.deepEqual(json.engines.map((e) => e.name).sort(), ['agy', 'claude', 'codex']);

    // What the CLIs list: Codex and agy list theirs, Claude Code has names its --model takes
    const codex = teamJson(p, ['models', 'codex']);
    assert.deepEqual(codex.list.map((m) => m.id), ['gpt-6', 'gpt-6-mini']);
    assert.deepEqual(codex.list[0].efforts, ['low', 'medium', 'high', 'xhigh']);
    assert.equal(codex.from, 'codex debug models');
    assert.deepEqual(teamJson(p, ['models', 'agy'], { extraEnv: { STUB_AGY_MODELS: 'gemini-3-pro,gemini-3-flash' } }).list.map((m) => m.id), ['gemini-3-pro', 'gemini-3-flash']);
    const claude = teamJson(p, ['models', 'claude']);
    assert.deepEqual(claude.list, []);
    assert.ok(claude.hints.includes('opus'));
    assert.match(claude.why, /no command that lists its models/);

    const before = fs.readFileSync(path.join(p.repo, 'nextlevel.json'), 'utf8');
    // Refused, and nothing written: a model the login rejects, one agy doesn't list, an effort the engine doesn't take, not signed in
    const rejected = teamJson(p, ['set', 'orchestrator', '--engine', 'codex', '--model', 'gpt-6-sol']);
    assert.equal(rejected.code, 1);
    assert.equal(rejected.saved, false);
    assert.match(rejected.message, /^Not saved: Codex model: "gpt-6-sol" \(roles\.orchestrator\.model\) was rejected/);
    assert.deepEqual(rejected.results.map((r) => [r.id, r.status]).filter(([id]) => id !== 'profiles.accounts'), [['tool.codex', 'ok'], ['codex.login', 'ok'], ['codex.model', 'fail']]);
    assert.ok(rejected.results.find((r) => r.id === 'codex.model').steps.every((s) => s.label));
    assert.match(teamJson(p, ['set', 'worker', '--engine', 'agy', '--model', 'gemini-9']).message, /"gemini-9" \(roles\.worker\.model\) not in agy models/);
    assert.match(teamJson(p, ['set', 'worker', '--engine', 'claude', '--effort', 'turbo']).message, /Claude Code takes the effort low, medium, high, xhigh, max, not "turbo"/);
    assert.match(teamJson(p, ['set', 'worker', '--engine', 'claude', '--model', 'claude-nope']).message, /Claude Code model: "claude-nope" \(roles\.worker\.model\) was rejected/);
    const signedOut = teamJson(p, ['set', 'worker', '--engine', 'claude'], { extraEnv: { STUB_CLAUDE_SIGNED_OUT: '1' } });
    assert.match(signedOut.message, /Claude Code sign-in: not signed in/);
    assert.ok(signedOut.results.find((r) => r.id === 'claude.login').steps.some((s) => s.command === 'claude auth login'));
    assert.match(teamJson(p, ['set', 'nobody', '--engine', 'codex']).message, /which role\?/);
    // --check checks and writes nothing
    const checked = teamJson(p, ['set', 'worker', '--engine', 'claude', '--model', 'opus', '--check']);
    assert.equal(checked.ok, true, checked.message);
    assert.equal(checked.saved, false);
    assert.equal(fs.readFileSync(path.join(p.repo, 'nextlevel.json'), 'utf8'), before, 'nothing written by a refusal or --check');

    // Warnings are shown with the result and never keep it from being saved: an engine only the fallback uses
    // that isn't signed in; FR-009's Codex fallback worker on Windows
    const warned = teamJson(p, ['set', 'worker-fallback', '--engine', 'claude'], { extraEnv: { STUB_CLAUDE_SIGNED_OUT: '1' } });
    assert.equal(warned.saved, true, warned.message);
    assert.match(warned.message, /^Saved\. Fallback worker: Claude Code\. It applies .* Warning: Claude Code sign-in: not signed in/);
    assert.deepEqual(warned.results.filter((r) => r.status === 'fail').map((r) => [r.id, r.severity]), [['claude.login', 'warn']]);
    assert.equal(p.config().roles.worker.fallback, 'claude');
    const back = teamJson(p, ['set', 'worker-fallback', '--engine', 'codex']);
    assert.equal(back.saved, true, back.message);
    assert.equal(p.config().roles.worker.fallback, 'codex');
    const windowsWarning = back.results.find((r) => r.id === 'codex.worker-windows');
    assert.deepEqual([windowsWarning.status, windowsWarning.severity], process.platform === 'win32' ? ['fail', 'warn'] : ['skip', 'info']);
    assert.equal(/ Warning: Codex as a worker on Windows: the workers' fallback runs on Codex/.test(back.message), process.platform === 'win32', back.message);

    // Saved: the worker role, a fallback of its own, the setup guide and back
    const saved = teamJson(p, ['set', 'worker', '--engine', 'claude', '--model', 'opus', '--effort', 'high']);
    assert.equal(saved.saved, true, saved.message);
    assert.match(saved.message, /^Saved\. Workers: Claude Code, model opus, effort high\. It applies to the next task that starts/);
    assert.deepEqual(p.config().roles.worker, { engine: 'claude', model: 'opus', effort: 'high', profile: '', fallback: 'codex' });
    // Antigravity (FR-010): no effort (the level is in the model's name), and the exact model and flags a worker gets
    // are tried headless before anything is saved
    assert.match(teamJson(p, ['set', 'worker-fallback', '--engine', 'agy', '--effort', 'low']).message, /^Antigravity takes the level from the model's name/);
    const refused = teamJson(p, ['set', 'worker', '--engine', 'agy', '--model', 'gemini-3-pro'], { extraEnv: { STUB_AGY_MODELS: 'gemini-3-pro', STUB_AGY_REFUSE: 'gemini-3-pro' } });
    // agy's print mode needs a console on Windows: the trial runs in the console with no window. Whether that console
    // started is nextlevel's own answer, in its result (not a separate check made before, which could see it otherwise):
    // where it didn't (Windows Server 2025, GitHub's runner), the flags can't be tried without opening a window, and the
    // change is saved, saying they weren't tried
    const untried = /Warning: Antigravity model: "gemini-3-pro" \(roles\.worker\.model\): what a worker runs is not tried: the console with no window (didn't start here|doesn't start on this PC)/;
    if (!untried.test(refused.message)) {
      assert.equal(refused.saved, false, refused.message);
      assert.match(refused.message, /^Not saved: Antigravity model: "gemini-3-pro" \(roles\.worker\.model\) was refused on agy 1\.2\.4: model gemini-3-pro is not available for your plan, exit 1\. It ran: agy -p "nextlevel model check:…" /);
      // (a fallback's is a warning, as for every engine only a fallback uses: saved, and said)
      const warnedAgy = teamJson(p, ['set', 'worker-fallback', '--engine', 'agy', '--model', 'gemini-3-pro'], { extraEnv: { STUB_AGY_MODELS: 'gemini-3-pro', STUB_AGY_REFUSE: 'gemini-3-pro' } });
      assert.match(warnedAgy.message, /^Saved\. .* Warning: Antigravity model: "gemini-3-pro" \(roles\.worker\.fallback\.model\) was refused/);
    } else {
      assert.equal(process.platform, 'win32', `only Windows has a console with no window to miss: ${refused.message}`);
      assert.equal(refused.saved, true, refused.message);
      assert.equal(teamJson(p, ['set', 'worker', '--engine', 'claude', '--model', 'opus', '--effort', 'high']).saved, true, 'the workers as they were');
    }
    const agyFallback = teamJson(p, ['set', 'worker-fallback', '--engine', 'agy', '--model', 'gemini-3-pro'], { extraEnv: { STUB_AGY_MODELS: 'gemini-3-pro' } });
    assert.equal(agyFallback.saved, true, agyFallback.message);
    assert.deepEqual(p.config().roles.worker.fallback, { engine: 'agy', model: 'gemini-3-pro', effort: '' });
    // (the same: what the check says it did)
    const agyModel = agyFallback.results.find((r) => r.id === 'agy.model');
    if (agyModel.status === 'ok') assert.match(agyModel.detail, /gemini-3-pro \(listed by agy models, and ran as a worker runs, on agy 1\.2\.4\)/);
    else {
      assert.equal(process.platform, 'win32', agyModel.detail);
      assert.match(agyModel.detail, /what a worker runs is not tried: the console with no window (didn't start here|doesn't start on this PC)/);
    }
    // How a worker's process shows: workers.window
    assert.match(teamJson(p, ['window', 'sideways']).message, /workers\.window is hidden, minimized, visible, not "sideways"/);
    const win = teamJson(p, ['window', 'minimized']);
    assert.equal(win.saved, true, win.message);
    assert.match(win.message, /^Saved: worker windows: Minimized\. It applies to the next task that starts/);
    assert.equal(p.config().workers.window, 'minimized');
    assert.match(win.message, /But NEXTLEVEL_WORKER_WINDOW is set in this environment, and it wins over nextlevel\.json while it is\./, 'the tests set it');
    const listed = p.hub(['team'], { extraEnv: { NEXTLEVEL_WORKER_WINDOW: undefined } }).out;
    assert.match(listed, /Worker windows +Minimized \(workers\.window: minimized\)/);
    assert.match(listed, /Fallback worker +Antigravity · model gemini-3-pro · level none: the model's name carries no level/);
    assert.equal(teamJson(p, ['window', 'hidden']).window.mode, 'hidden');
    assert.equal(teamJson(p, ['set', 'guide', '--engine', 'claude']).saved, true);
    assert.equal(p.config().roles.guide.engine, 'claude');
    assert.match(p.hub(['team']).out, /Setup guide +Claude Code/);
    assert.equal(teamJson(p, ['set', 'guide', '--engine', 'orchestrator']).saved, true);
    assert.equal(p.config().roles.guide.engine, '');
    // The file keeps what else it had, and the doctor reads it as it is
    assert.equal(p.config().version, 1);
    assert.equal(JSON.parse(p.hub(['doctor', '--json']).out).results.find((r) => r.id === 'project.config').status, 'ok');
  } finally {
    p.cleanup();
  }
});

test('a team change reaches the next task, never a running one; the job records what it ran on, and the day counts it', async () => {
  const p = makeProject();
  const bg = p.hubInBackground(['run', '--tick-ms', '200']);
  try {
    for (let i = 0; i < 50 && !fs.existsSync(p.state('hub.json')); i++) await new Promise((r) => setTimeout(r, 200));
    // Tasks on the worker role: no Engine line in their spec
    const spec = (id, verify) => {
      p.spec(id, verify);
      const f = path.join(p.repo, 'docs', 'tasks', `${id}.md`);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('Engine: agy\n', ''));
    };
    spec('M9-01-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M9-01-ok']);
    const wait = async (test, what) => {
      for (let i = 0; i < 300; i++) {
        if (test()) return;
        await new Promise((r) => setTimeout(r, 200));
      }
      throw new Error(`waited for ${what}:\n${fs.readFileSync(p.state('logs', 'hub.log'), 'utf8')}`);
    };
    const state = (id) => (fs.existsSync(p.jobFile(id, 'status.json')) ? p.status(id).state : '');
    await wait(() => state('M9-01-ok') === 'done', 'M9-01-ok');
    assert.equal(p.status('M9-01-ok').engine, 'agy');
    assert.equal(p.status('M9-01-ok').role, 'worker');
    assert.equal(p.status('M9-01-ok').effort, '', "agy runs at the level its model's name carries: stub-model has none (FR-010)");

    // The owner switches the workers to Codex with an effort, while the hub runs
    const saved = teamJson(p, ['set', 'worker', '--engine', 'codex', '--model', 'gpt-6', '--effort', 'xhigh']);
    assert.equal(saved.saved, true, saved.message);
    assert.equal(/ Warning: Codex as a worker on Windows: the workers and the workers' fallback run on Codex/.test(saved.message), process.platform === 'win32', 'FR-009: a warning, saved');
    spec('M9-02-ok', fileExists('ok.mjs'));
    p.hub(['dispatch', 'M9-02-ok']);
    await wait(() => state('M9-02-ok') === 'done', 'M9-02-ok');
    const s = p.status('M9-02-ok');
    assert.deepEqual([s.engine, s.model, s.effort, s.modelOwn], ['codex', 'gpt-6', 'xhigh', false]);
    const report = fs.readFileSync(p.jobFile('M9-02-ok', 'RESULT.md'), 'utf8');
    assert.match(report, /Engine: codex\nModel: gpt-6/);
    assert.match(report, /Effort: xhigh/, 'the effort reached codex exec');
    const log = fs.readFileSync(p.state('logs', 'hub.log'), 'utf8');
    assert.match(log, /nextlevel\.json changed: orchestrator codex, workers codex gpt-6 \(effort xhigh\).*The next autopilot round and the next task use it/);

    // A retry on a fallback of its own takes its model and effort with it
    spec('M9-03-fail', fileExists('fixed.txt'));
    p.hub(['dispatch', 'M9-03-fail']);
    await wait(() => state('M9-03-fail') === 'failed', 'M9-03-fail on the workers (Codex)');
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, worker: { ...c.roles.worker, fallback: { engine: 'claude', model: 'sonnet', effort: 'low' } } } }));
    assert.match(p.hub(['retry', 'M9-03-fail', '--fallback', '--feedback', 'Create fixed.txt.']).out, /attempt 2, claude sonnet \(effort low\)/);
    await wait(() => state('M9-03-fail') === 'done', 'the retry on the fallback');
    assert.match(fs.readFileSync(p.jobFile('M9-03-fail', 'RESULT.md'), 'utf8'), /Engine: claude\nModel: sonnet[\s\S]*Effort: low/);
    assert.deepEqual([p.status('M9-03-fail').engine, p.status('M9-03-fail').model, p.status('M9-03-fail').effort], ['claude', 'sonnet', 'low']);

    // The day's numbers: four attempts and their minutes, and Codex's tokens from its workers' output
    const day = Object.values(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8'))).at(-1);
    assert.equal(day.attempts, 4);
    assert.ok(day.workerMinutes > 0);
    assert.equal(day.codexTokens, 2 * 12345, 'two attempts ran on Codex');
    // ... per role and engine (FR-008): Codex's, Claude Code's and (FR-010) Antigravity's tokens
    const pick = (row) => row && { runs: row.runs, tokens: row.tokens || 0, reported: row.reported || 0 };
    assert.deepEqual(pick(day.by['worker:codex']), { runs: 2, tokens: 2 * 12345, reported: 2 });
    assert.deepEqual(pick(day.by['worker:claude']), { runs: 1, tokens: 1500, reported: 1 }, "Claude Code's JSON: 1,000 in, 200 to the cache, 300 out");
    assert.equal(day.by['worker:claude'].cached, 30000);
    assert.deepEqual(pick(day.by['worker:agy']), { runs: 1, tokens: 2150, reported: 1 }, "Antigravity's stream-json result: 2,000 in, 150 out");
    assert.equal(day.by['worker:agy'].cached, 9000);
  } finally {
    bg.kill();
    await processesGone([bg.pid]);
    p.cleanup();
  }
});

test("today's usage per role and engine (FR-008): rounds, sessions and attempts, minutes, and tokens where the engine reports them", () => {
  const p = makeProject();
  try {
    // The orchestrator's window and the setup guide on Codex: their tokens are in Codex's session files, each
    // counted once (the guide's window doesn't count the orchestrator's session again)
    const inWindow = (args) => p.nextlevel(args, { cwd: p.repo, extraEnv: { NEXTLEVEL_ROOT: p.repo } });
    assert.match(inWindow(['_orch']).out, /\[fake codex\] interactive: ROLE: ORCHESTRATOR/);
    assert.match(inWindow(['_guide', 'codex']).out, /\[fake codex\] interactive: ROLE: GUIDE/);
    assert.ok(!fs.existsSync(p.state('guide.json')), 'the guide says it is open only while it is');
    // An autopilot round on Claude Code (its JSON result has its tokens), and a Codex worker, whose own session
    // file (codex exec) is counted from its output, not as an interactive session
    p.setConfig((c) => ({ ...c, roles: { ...c.roles, orchestrator: { engine: 'claude', model: '' } } }));
    p.spec('M8-05-ok', 'node -e "0"');
    p.hub(['dispatch', 'M8-05-ok', '--engine', 'codex']);
    p.runUntilIdle();
    const r = p.runUntilIdle(['--autopilot']);
    assert.equal(p.status('M8-05-ok').acked, true, r.out);
    const day = Object.values(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8'))).at(-1);
    const pick = (row) => row && { runs: row.runs, tokens: row.tokens || 0, reported: row.reported || 0 };
    assert.deepEqual(pick(day.by['orchestrator:codex']), { runs: 1, tokens: 34000, reported: 1 }, '50,000 in, 20,000 of them cached, 4,000 out');
    assert.deepEqual(pick(day.by['guide:codex']), { runs: 1, tokens: 34000, reported: 1 });
    assert.deepEqual(pick(day.by['worker:codex']), { runs: 1, tokens: 12345, reported: 1 });
    assert.deepEqual(pick(day.by['autopilot:claude']), { runs: 1, tokens: 1500, reported: 1 });
    for (const key of ['worker:codex', 'autopilot:claude']) assert.ok(day.by[key].minutes > 0, JSON.stringify(day.by));
    assert.equal(day.rounds, 1);
    assert.equal(day.codexTokens, 34000 * 2 + 12345);

    // A window closed with its X takes nextlevel's process with it: the hub counts that session when it notices
    const gone = spawnSync(process.execPath, ['-e', '0']).pid;
    fs.writeFileSync(p.state('orchestrator.json'), JSON.stringify({ mode: 'interactive', pid: gone, startedAt: new Date(Date.now() - 90_000).toISOString(), engine: 'claude', profile: '' }));
    p.runUntilIdle();
    assert.ok(!fs.existsSync(p.state('orchestrator.json')));
    const later = Object.values(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8'))).at(-1);
    assert.equal(later.by['orchestrator:claude'].runs, 1);
    assert.ok(later.by['orchestrator:claude'].minutes >= 1.5, JSON.stringify(later.by['orchestrator:claude']));
    assert.equal(later.by['orchestrator:claude'].reported, undefined, "Claude Code's window: minutes only");
    assert.match(fs.readFileSync(p.state('logs', 'hub.log'), 'utf8'), /the orchestrator's window was closed without ending its session: counted it/);
  } finally {
    p.cleanup();
  }
});

test('the Team page and agy 1.3.4 (FR-022): Gemini 4 Argon and the Claude models with their levels, a worker pinned to one passes the check, and a refusal says why and is tried again on the next save', () => {
  const p = makeProject();
  try {
    const models = path.join(REPO_ROOT, 'test', 'fixtures', 'agy-1.3.5-models.txt');
    const errorFile = path.join(p.tmp, 'agy-error.txt');
    const env = { STUB_AGY_VERSION: '1.3.4', STUB_AGY_MODELS_FILE: models, STUB_AGY_ERROR_FILE: errorFile };
    // The models agy lists, as the Team page asks for them, each with the level its name carries
    const listed = teamJson(p, ['models', 'agy'], { extraEnv: env });
    assert.deepEqual(listed.list.filter((m) => /argon|sonnet/.test(m.id)).map((m) => [m.id, m.label, m.effort]), [
      ['gemini-4-argon-medium', 'Gemini 4 Argon (Medium)', 'medium'], ['gemini-4-argon-high', 'Gemini 4 Argon (High)', 'high'], ['gemini-4-argon-low', 'Gemini 4 Argon (Low)', 'low'],
      ['claude-sonnet-5-5-low', 'Claude Sonnet 5.5 (Low)', 'low'], ['claude-sonnet-5-5-medium', 'Claude Sonnet 5.5 (Medium)', 'medium'], ['claude-sonnet-5-5-high', 'Claude Sonnet 5.5 (High)', 'high'],
    ]);
    // The workers on Argon at its highest level, then on Claude Sonnet: the check passes, as a worker runs, on 1.3.4
    for (const model of ['gemini-4-argon-high', 'claude-sonnet-5-5-medium']) {
      const saved = teamJson(p, ['set', 'worker', '--engine', 'agy', '--model', model], { extraEnv: env });
      const row = saved.results.find((r) => r.id === 'agy.model');
      if (row.status === 'fail' && /not tried: the console with no window/.test(row.detail)) continue; // (a PC where it can't start: Windows Server's runner)
      assert.equal(saved.saved, true, saved.message);
      assert.match(row.detail, new RegExp(`^${model.replace(/\./g, '\\.')} \\(listed by agy models, and ran as a worker runs, on agy 1\\.3\\.4\\)\\. It ran: agy -p "nextlevel model check:…" --print-timeout 2m --model ${model} `));
      assert.equal(p.config().roles.worker.model, model);
      const team = p.hub(['team'], { extraEnv: env }).out;
      assert.match(team, new RegExp(`Workers +Antigravity · model ${model} · level ${model.split('-').at(-1)} \\(from the model's name\\)`));
    }
    // agy refuses: not saved, in agy's words with the exit code, never just ERROR; the next save tries again at once
    fs.writeFileSync(errorFile, 'model gemini-4-argon-low is not available for your plan');
    const refused = teamJson(p, ['set', 'worker', '--engine', 'agy', '--model', 'gemini-4-argon-low'], { extraEnv: env });
    if (!/not tried: the console with no window/.test(refused.message)) {
      assert.equal(refused.saved, false);
      assert.match(refused.message, /^Not saved: Antigravity model: "gemini-4-argon-low" \(roles\.worker\.model\) was refused on agy 1\.3\.4: model gemini-4-argon-low is not available for your plan, exit 1\. It ran: /);
      assert.doesNotMatch(refused.message, /: ERROR\b/);
      fs.rmSync(errorFile);
      const again = teamJson(p, ['set', 'worker', '--engine', 'agy', '--model', 'gemini-4-argon-low'], { extraEnv: env });
      assert.equal(again.saved, true, `a save tries a kept refusal again: ${again.message}`);
    }
  } finally {
    p.cleanup();
  }
});
