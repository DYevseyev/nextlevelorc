// A GitHub workflow's jobs, and where each one runs (the self-hosted runner's part A, docs/design/self-hosted-runner.md):
// read from the file's text with a small reader of the shapes workflows have, never a YAML library (zero dependencies)
// and never an AI. What it doesn't recognise it says it can't tell, never "GitHub's runner": the guard's card reads
// this (`where jobs run:`, lib/protect.mjs) and so does the Team page's recommendation (lib/ghrepo.mjs). Pure. Every
// pattern here runs in time linear in a line's length (the team writes these files).

const indentOf = (l) => l.length - l.trimStart().length;
const blank = (l) => !l.trim() || /^\s*#/.test(l);
// a value without its quotes and its trailing comment
function scalar(v) {
  let s = String(v || '').trim();
  if (s.startsWith('"') || s.startsWith("'")) {
    const q = s[0];
    const end = s.indexOf(q, 1);
    return end > 0 ? s.slice(1, end) : s.slice(1);
  }
  const hash = s.indexOf(' #');
  if (hash >= 0) s = s.slice(0, hash).trim();
  return s;
}
// `[a, "b", c]` -> ['a', 'b', 'c'] (null: not a one-line list)
function flowList(v) {
  const s = String(v || '').trim();
  if (!s.startsWith('[')) return null;
  const end = s.lastIndexOf(']');
  if (end < 0) return null;
  return s
    .slice(1, end)
    .split(',')
    .map(scalar)
    .filter(Boolean);
}

// GitHub's hosted runners: the images' labels (ubuntu-24.04, windows-latest, macos-15...), and larger runners named like them
const HOSTED = /^(ubuntu|windows|macos)-[\w.-]+$/i;
const OS_OF = { ubuntu: 'linux', windows: 'windows', macos: 'macos' };
export const NEXTLEVEL_LABELS = ['nextlevel-linux', 'nextlevel-windows'];
export const RUNS_ON_VARS = { linux: 'NEXTLEVEL_RUNS_ON_LINUX', windows: 'NEXTLEVEL_RUNS_ON_WINDOWS' };

// Where a list of labels runs: { kind: 'hosted' | 'self-hosted' | 'unknown', labels, os, pc }
export function classifyLabels(labels) {
  const ls = (labels || []).map((x) => String(x).trim()).filter(Boolean);
  if (!ls.length) return { kind: 'unknown', labels: ls, os: '' };
  if (ls.some((l) => /[${}*&]/.test(l))) return { kind: 'unknown', labels: ls, os: '' };
  if (ls.some((l) => l.toLowerCase() === 'self-hosted')) {
    const pc = ls.some((l) => NEXTLEVEL_LABELS.includes(l.toLowerCase()));
    const os = ls.find((l) => ['linux', 'windows', 'macos'].includes(l.toLowerCase()))?.toLowerCase() || (ls.some((l) => l.toLowerCase() === 'nextlevel-windows') ? 'windows' : ls.some((l) => l.toLowerCase() === 'nextlevel-linux') ? 'linux' : '');
    return { kind: 'self-hosted', labels: ls, os, pc };
  }
  if (ls.length === 1 && HOSTED.test(ls[0])) return { kind: 'hosted', labels: ls, os: OS_OF[ls[0].split('-')[0].toLowerCase()] };
  // a label of its own without self-hosted: a larger runner named otherwise, or a self-hosted runner's custom label
  return { kind: 'unknown', labels: ls, os: '' };
}

// An expression `${{ ... }}`: which repository variables it reads, and the hosted label it falls back to. A fallback is
// read only from the whole expression in one of the forms nextlevel writes (`vars.X || 'label'`, and the design's
// `[github.actor != 'dependabot[bot]' &&] vars.X && fromJSON(vars.X) || 'label'`): in any other, a `|| 'label'` can sit
// under an && or after a literal that always wins, so it says nothing about where the job runs.
const FALLBACK_FORMS = [
  /^\$\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\|\|\s*'([\w.-]+)'\s*\}\}$/,
  /^\$\{\{\s*(?:github\.actor\s*!=\s*'dependabot\[bot\]'\s*&&\s*)?vars\.([A-Za-z_][A-Za-z0-9_]*)\s*&&\s*fromJSON\(\s*vars\.\1\s*\)\s*\|\|\s*'([\w.-]+)'\s*\}\}$/,
];
function expression(text) {
  const vars = [...new Set((text.match(/vars\.[A-Za-z_][A-Za-z0-9_]*/g) || []).map((v) => v.slice(5)))];
  const whole = scalar(text);
  const m = FALLBACK_FORMS.map((re) => whole.match(re)).find(Boolean);
  return { vars, fallback: m ? m[2] : '' };
}

// One job's runs-on, from the value on its line and the lines under it (more indented)
function runsOn(value, below) {
  const v = String(value || '').trim();
  const text = v || below.map((l) => l.trim()).join(' ');
  if (/^[&*]/.test(v) || below.some((l) => /^\s*-?\s*[&*]/.test(l) || /:\s*[&*]/.test(l))) return { kind: 'unknown', why: 'an anchor or alias', text };
  if (v.includes('${{')) {
    const e = expression(v);
    if (/matrix\./.test(v) || !e.vars.length) return { kind: 'unknown', why: 'an expression', text: v };
    const fb = e.fallback ? classifyLabels([e.fallback]) : null;
    return { kind: 'variable', vars: e.vars, fallback: e.fallback, fallbackKind: fb?.kind || 'unknown', os: fb?.os || '', text: v };
  }
  if (v) {
    const list = flowList(v);
    if (v.startsWith('[') && !list) return { kind: 'unknown', why: 'a list nextlevel can\'t read', text: v };
    if (v.startsWith('{')) return { kind: 'unknown', why: 'a map on one line', text: v };
    return { ...classifyLabels(list || [scalar(v)]), text: v };
  }
  // on the following lines: a list (- a), or a map (group:, labels:)
  const items = below.filter((l) => !blank(l));
  if (!items.length) return { kind: 'unknown', why: 'empty', text: '' };
  if (items.every((l) => /^\s*-\s/.test(l))) {
    const ls = items.map((l) => l.trim().slice(1).trim());
    if (ls.some((l) => l.includes('${{'))) return { kind: 'unknown', why: 'an expression', text };
    return { ...classifyLabels(ls.map(scalar)), text };
  }
  let group = '';
  const labels = [];
  let inLabels = false;
  for (const l of items) {
    const m = l.match(/^\s*(group|labels):\s*(.*)$/);
    if (m) {
      inLabels = m[1] === 'labels';
      if (m[1] === 'group') group = scalar(m[2]);
      else if (m[2].trim()) labels.push(...(flowList(m[2]) || [scalar(m[2])]));
      continue;
    }
    if (inLabels && /^\s*-\s/.test(l)) labels.push(scalar(l.trim().slice(1)));
    else return { kind: 'unknown', why: 'a map nextlevel can\'t read', text };
  }
  if ([group, ...labels].some((x) => x.includes('${{'))) return { kind: 'unknown', why: 'an expression', text };
  // a runner group: GitHub's larger runners and organizations' self-hosted runners use them
  if (group) return { kind: 'group', group, labels, text, os: '' };
  return { ...classifyLabels(labels), text };
}

// The jobs of a workflow's text: [{ id, name, runsOn, uses, runs, environment, secrets, docker }]
//   runsOn: { kind: 'hosted' | 'self-hosted' | 'variable' | 'group' | 'reusable' | 'unknown', labels, os, text, ... }
// A reusable workflow's job (`uses:` at the job's level) runs where that workflow says: from another repository,
// nextlevel can't read it (`repo`), from this one, it's that file's jobs (`local`).
export function workflowJobs(text) {
  const ls = String(text || '').replace(/^﻿/, '').split(/\r?\n/);
  const top = ls.findIndex((l) => /^(['"]?)jobs\1\s*:\s*(#.*)?$/.test(l));
  if (top < 0) return [];
  // the jobs' indent: the first line under jobs: that isn't blank
  let jobIndent = -1;
  for (let i = top + 1; i < ls.length; i++) {
    if (blank(ls[i])) continue;
    if (indentOf(ls[i]) === 0) break;
    jobIndent = indentOf(ls[i]);
    break;
  }
  if (jobIndent < 0) return [];
  const jobs = [];
  let cur = null;
  for (let i = top + 1; i < ls.length; i++) {
    const l = ls[i];
    if (blank(l)) {
      if (cur) cur.body.push(l);
      continue;
    }
    const ind = indentOf(l);
    if (ind === 0) break;
    if (ind === jobIndent) {
      const m = l.trim().match(/^(['"]?)([^'":\s][^'":]*)\1:\s*(.*)$/);
      cur = { id: m ? m[2].trim() : l.trim(), head: m ? m[3] : '', body: [] };
      jobs.push(cur);
    } else if (cur) cur.body.push(l);
  }
  return jobs.map((j) => jobOf(j));
}

function jobOf({ id, head, body }) {
  const real = body.filter((l) => !blank(l));
  const keyIndent = real.length ? Math.min(...real.map(indentOf)) : 0;
  const keys = new Map();
  for (let i = 0; i < body.length; i++) {
    const l = body[i];
    if (blank(l) || indentOf(l) !== keyIndent) continue;
    const m = l.trim().match(/^([\w-]+):\s*(.*)$/);
    if (!m || keys.has(m[1])) continue;
    const below = [];
    for (let k = i + 1; k < body.length && (blank(body[k]) || indentOf(body[k]) > keyIndent); k++) below.push(body[k]);
    keys.set(m[1], { value: m[2], below });
  }
  const all = body.join('\n');
  const secrets = [...new Set((all.match(/secrets\.[A-Za-z_][A-Za-z0-9_]*/g) || []).map((s) => s.slice(8)))].filter((s) => s !== 'GITHUB_TOKEN');
  const uses = [];
  const runs = [];
  for (const l of body) {
    const u = l.match(/^\s*(?:-\s+)?uses:\s*(\S+)/);
    if (u && indentOf(l) > keyIndent) uses.push(scalar(u[1]));
    const r = l.match(/^\s*(?:-\s+)?run:\s*(.*)$/);
    if (r && r[1].trim() && !/^[|>]/.test(r[1].trim())) runs.push(scalar(r[1]));
  }
  const env = keys.get('environment');
  const environment = env ? scalar(env.value) || (env.below.find((l) => /^\s*name:/.test(l)) || '').replace(/^\s*name:\s*/, '').trim() : '';
  const name = keys.has('name') ? scalar(keys.get('name').value) : '';
  const docker = keys.has('container') || keys.has('services') || /\bdocker\b/.test(all);
  let where;
  const call = keys.get('uses');
  if (call) {
    const target = scalar(call.value);
    where = target.startsWith('./') ? { kind: 'reusable', local: target, text: target } : { kind: 'reusable', repo: target.split('/').slice(0, 2).join('/'), text: target };
  } else if (keys.has('runs-on')) {
    const r = keys.get('runs-on');
    where = runsOn(r.value, r.below);
  } else where = { kind: 'unknown', why: 'no runs-on found', text: '' };
  // (a job written on one line, `job: { runs-on: x }`, isn't read: it can't tell)
  if (String(head || '').trim() && !real.length) where = { kind: 'unknown', why: 'written on one line', text: String(head).trim() };
  return { id, name, runsOn: where, uses, runs, environment, secrets, docker };
}

// Where one job runs, in plain words: a short name for the place, and what it means
const CANT = "nextlevel can't tell where (read the diff)";
function short(r) {
  if (r.kind === 'hosted') return `GitHub's runner ${r.labels[0]}`;
  if (r.kind === 'self-hosted') return r.pc ? `THIS PC (self-hosted: ${r.labels.filter((l) => l.toLowerCase() !== 'self-hosted').join(', ')})` : `a self-hosted runner (labels: ${r.labels.join(', ')})`;
  if (r.kind === 'variable') return `where the repository variable${r.vars.length > 1 ? 's' : ''} ${r.vars.join(', ')} say${r.vars.length > 1 ? '' : 's'}`;
  if (r.kind === 'group') return `the runner group ${r.group}${r.labels.length ? ` (labels: ${r.labels.join(', ')})` : ''}`;
  if (r.kind === 'reusable') return r.repo ? `a workflow from ${r.repo}` : `this repository's workflow ${r.local}`;
  return "a place nextlevel can't read";
}
function tail(r) {
  if (r.kind === 'hosted') return ' (paid on a private repository)';
  if (r.kind === 'self-hosted') return r.pc ? '' : ': a runner on your machines';
  if (r.kind === 'variable') return r.vars.length === 1 && Object.values(RUNS_ON_VARS).includes(r.vars[0]) && r.fallbackKind === 'hosted' ? `: this PC when nextlevel's switch is on, else GitHub's ${r.fallback}` : `: ${CANT}`;
  if (r.kind === 'reusable') return r.repo ? ": nextlevel can't tell where it runs, and changes there aren't guarded" : ": it runs where that file's jobs say";
  return `: ${CANT}`;
}
// One job, where it runs: "verify on GitHub's runner ubuntu-latest (paid on a private repository)"
export function jobWhere(label, r) {
  if (!r || r.kind === 'unknown') return `${label}: ${CANT}`;
  const verb = r.kind === 'variable' ? 'runs' : r.kind === 'reusable' ? 'uses' : 'on';
  return `${label} ${verb} ${short(r)}${tail(r)}`;
}

const sameWhere = (x, y) => JSON.stringify({ ...x, text: '' }) === JSON.stringify({ ...y, text: '' });
// Lines for the guard's card (`where jobs run:`): every job whose place is new or moved, every job that runs on a
// self-hosted runner, where a variable says or where nextlevel can't tell (its steps changed, so what runs there may
// have), and the jobs removed. A job that stays on GitHub's runners and doesn't move gets no line.
export function whereJobsRun(before, after) {
  const b = new Map(workflowJobs(before).map((j) => [j.id, j]));
  const a = workflowJobs(after);
  // a job that isn't on GitHub's runners comes first, and a name can't push its place off a card's line (the card keeps
  // 25 lines of 240 characters a file): many new jobs on GitHub's runners, or a long name, never hide one on the PC
  const first = [];
  const rest = [];
  for (const j of a) {
    const was = b.get(j.id);
    const now = j.runsOn;
    const full = j.name && j.name !== j.id ? `${j.id} (${j.name})` : j.id;
    const label = full.length > 60 ? `${full.slice(0, 59)}…` : full;
    const to = now.kind === 'hosted' ? rest : first;
    if (!was) to.push(`new job ${jobWhere(label, now)}`);
    else if (!sameWhere(was.runsOn, now)) to.push(`${label} moves from ${short(was.runsOn)} to ${short(now)}${tail(now)}`);
    else if (now.kind !== 'hosted') to.push(jobWhere(label, now));
  }
  const ids = new Set(a.map((j) => j.id));
  for (const id of b.keys()) if (!ids.has(id)) rest.push(`job ${id} removed`);
  // the reader found a jobs: it couldn't split into jobs
  if (!a.length && /^['"]?jobs['"]?\s*:/m.test(String(after || ''))) first.push(CANT);
  return [...first, ...rest];
}

// GitHub's paid runners in a set of workflows: the jobs that run on them (macOS too: the PC isn't a Mac), by OS
export function paidJobs(workflows) {
  return workflows.flatMap((w) => w.jobs.filter((j) => j.runsOn.kind === 'hosted' || (j.runsOn.kind === 'variable' && j.runsOn.fallbackKind === 'hosted')).map((j) => ({ file: w.file, id: j.id, name: j.name, os: j.runsOn.os, labels: j.runsOn.kind === 'hosted' ? j.runsOn.labels : [j.runsOn.fallback], variable: j.runsOn.kind === 'variable', environment: j.environment, secrets: j.secrets })));
}
