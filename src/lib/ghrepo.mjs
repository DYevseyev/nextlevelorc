// A project's GitHub repository, as the self-hosted runner's part A reads it (docs/design/self-hosted-runner.md, point 1):
// its visibility and owner, whether the owner's gh is its admin, its fork pull requests' settings, who can push, its
// workflows' jobs and the minutes its runs took on GitHub's runners. Read with the owner's gh, GETs only (`gh api`
// with no method and no fields), and kept 10 minutes in ~/.nextlevel/cache/repos.json (one key per repository, written
// under its lock: a key never changes its meaning). `offer()` says whether the Team page offers running its checks on
// this PC: only a personal account's private repository, never a public, internal or organization's one.
import path from 'node:path';
import { readJsonFile, updateJsonFile } from './filelock.mjs';
import { homeDir } from './home.mjs';
import { paidJobs, workflowJobs } from './workflows.mjs';

export const FRESH_MS = 10 * 60_000;
export const MINUTES_DAYS = 30;
export const MINUTES_RUNS = 30; // the latest runs read for the minutes (each run's jobs is one more read)
const cacheFile = () => path.join(homeDir(), 'cache', 'repos.json');

// owner/name, as GitHub's API takes it (null: not one)
export const repoSlug = (s) => {
  const m = String(s || '').trim().match(/^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})$/);
  return m && m[2] !== '.' && m[2] !== '..' ? `${m[1]}/${m[2]}` : null;
};

// gh's answer as JSON: its first { or [ on (gh prints nothing else on success, but a warning can come first)
function parse(out) {
  const s = String(out || '');
  const i = s.search(/[[{]/);
  if (i < 0) return null;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return null;
  }
}
// gh's words for a failure: its last line that says something (never a token: gh doesn't print one)
const ghWords = (r) => (r.missing ? "gh isn't installed" : r.timedOut ? "gh didn't answer in time" : String(r.out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || 'gh failed');

// The facts. gh(args) -> { ok, out } (or a promise of it): the owner's gh. parts: which reads beyond the repository
// itself ({ forks, collaborators, workflows, minutes }, all by default). now: the time the minutes count back from.
export async function readRepoFacts(slug, gh, { parts = {}, now = Date.now() } = {}) {
  const want = { forks: true, collaborators: true, workflows: true, minutes: true, ...parts };
  const facts = { ok: false, slug, at: new Date(now).toISOString() };
  if (!repoSlug(slug)) return { ...facts, error: `not a GitHub repository name: ${slug}` };
  const get = async (p) => {
    const r = await gh(['api', '-H', 'Accept: application/vnd.github+json', p]);
    return r.ok ? { ok: true, json: parse(r.out) } : { ok: false, why: ghWords(r) };
  };
  const repo = await get(`repos/${slug}`);
  if (!repo.ok || !repo.json || typeof repo.json !== 'object') return { ...facts, error: repo.ok ? "gh's answer wasn't the repository" : repo.why };
  const j = repo.json;
  const visibility = String(j.visibility || (j.private === true ? 'private' : j.private === false ? 'public' : '')).toLowerCase();
  if (!visibility) return { ...facts, error: "GitHub's answer didn't say whether the repository is private" };
  Object.assign(facts, {
    ok: true,
    slug: j.full_name || slug,
    id: j.id ?? null,
    visibility,
    ownerType: j.owner?.type || '',
    owner: j.owner?.login || slug.split('/')[0],
    admin: j.permissions ? !!j.permissions.admin : null,
    defaultBranch: j.default_branch || '',
  });
  // the rest only means something for a repository the runner could be offered for
  if (visibility !== 'private') return facts;
  if (want.forks) {
    const f = await get(`repos/${slug}/actions/permissions/fork-pr-workflows-private-repos`);
    facts.forks = f.ok && f.json ? { run: !!f.json.run_workflows_from_fork_pull_requests, writeTokens: !!f.json.send_write_tokens_to_workflows, secrets: !!f.json.send_secrets_and_variables, approval: !!f.json.require_approval_for_fork_pr_workflows } : null;
    if (!f.ok) facts.forksError = f.why;
  }
  if (want.collaborators) {
    const c = await get(`repos/${slug}/collaborators?affiliation=all&per_page=100`);
    facts.collaborators = c.ok && Array.isArray(c.json)
      ? c.json.map((u) => ({ login: String(u.login || ''), type: String(u.type || 'User'), push: !!(u.permissions?.push || u.permissions?.admin || u.permissions?.maintain), admin: !!u.permissions?.admin }))
      : null;
    if (!c.ok) facts.collaboratorsError = c.why;
  }
  if (want.workflows) {
    const ref = facts.defaultBranch ? `?ref=${encodeURIComponent(facts.defaultBranch)}` : '';
    const list = await get(`repos/${slug}/contents/.github/workflows${ref}`);
    if (list.ok && Array.isArray(list.json)) {
      facts.workflows = [];
      for (const f of list.json.filter((x) => x?.type === 'file' && /\.ya?ml$/i.test(String(x.name || '')))) {
        const c = await get(`repos/${slug}/contents/.github/workflows/${encodeURIComponent(f.name)}${ref}`);
        const text = c.ok && c.json?.content ? Buffer.from(String(c.json.content), 'base64').toString('utf8') : null;
        facts.workflows.push({ file: `.github/workflows/${f.name}`, jobs: text === null ? null : workflowJobs(text), error: text === null ? c.why || "gh's answer had no content" : '' });
      }
    } else if (!list.ok && /404|Not Found/i.test(list.why)) facts.workflows = []; // no .github/workflows folder
    else facts.workflowsError = list.why || "gh's answer wasn't a folder";
  }
  if (want.minutes) facts.minutes = await readMinutes(slug, get, now);
  return facts;
}

// The minutes the last 30 days' runs took on GitHub's runners, by OS, each job rounded up to a whole minute as GitHub
// bills it (Windows counts twice, macOS ten times: said on the card, not multiplied here). Only the latest runs are read.
async function readMinutes(slug, get, now) {
  const since = new Date(now - MINUTES_DAYS * 86_400_000).toISOString().slice(0, 10);
  const runs = await get(`repos/${slug}/actions/runs?per_page=${MINUTES_RUNS}&created=%3E%3D${since}`);
  if (!runs.ok || !runs.json || !Array.isArray(runs.json.workflow_runs)) return { error: runs.why || "gh's answer had no runs" };
  const m = { linux: 0, windows: 0, macos: 0, selfHosted: 0, jobs: 0, runs: runs.json.workflow_runs.length, more: (runs.json.total_count || 0) > runs.json.workflow_runs.length, days: MINUTES_DAYS };
  for (const run of runs.json.workflow_runs) {
    const jobs = await get(`repos/${slug}/actions/runs/${Number(run.id)}/jobs?per_page=100`);
    if (!jobs.ok || !Array.isArray(jobs.json?.jobs)) continue;
    for (const job of jobs.json.jobs) {
      const start = Date.parse(job.started_at);
      const end = Date.parse(job.completed_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      const minutes = Math.ceil((end - start) / 60_000);
      const labels = (job.labels || []).map((l) => String(l).toLowerCase());
      m.jobs++;
      if (labels.includes('self-hosted')) m.selfHosted += minutes;
      else {
        const os = (labels.find((l) => /^(ubuntu|windows|macos)-/.test(l)) || '').split('-')[0];
        if (os === 'windows') m.windows += minutes;
        else if (os === 'macos') m.macos += minutes;
        else if (os === 'ubuntu') m.linux += minutes;
      }
    }
  }
  return m;
}

// Whether the Team page offers it, in plain words:
//   { state: 'recommended' | 'offered' | 'not-offered' | 'unknown', title, text, paid, why }
// Never for a public repository (anyone's pull request could run code on the PC), an internal one (every member of
// the enterprise can see it, and an anonymous read can't tell it from a private one) or an organization's (its
// settings sit above the repository's: a later pull request).
export function offer(facts) {
  if (!facts || !facts.ok) return { state: 'unknown', title: "Can't tell", text: `nextlevel can't tell whether this repository is private: ${facts?.error || 'no answer yet'}. Nothing is offered until it can.`, why: 'unknown' };
  if (facts.visibility === 'public') return { state: 'not-offered', title: 'Not offered', text: "This repository is public. GitHub's runners are free for a public repository, and anyone's pull request could run code on this PC: nextlevel doesn't offer it.", why: 'public' };
  if (facts.visibility !== 'private') return { state: 'not-offered', title: 'Not offered', text: `This repository is ${facts.visibility}: every member of its enterprise can see it, so nextlevel doesn't offer it.`, why: facts.visibility };
  if (facts.ownerType !== 'User') return { state: 'not-offered', title: 'Not offered', text: `This repository belongs to ${facts.ownerType === 'Organization' ? 'an organization' : `a ${facts.ownerType || 'kind of'} account`} (${facts.owner}): nextlevel offers it only for a personal account's private repository for now.`, why: 'organization' };
  const jobs = (facts.workflows || []).filter((w) => w.jobs);
  const paid = paidJobs(jobs).filter((j) => j.os !== 'macos');
  if (paid.length) {
    return { state: 'recommended', title: 'Recommended: run them on this PC', text: "They'd cost nothing (GitHub doesn't charge for runners on your own machines today, which may change). This PC does the work: a check takes CPU and memory while your team works, and waits while the PC is off or asleep (GitHub cancels a check that waits 24 hours). Jobs would run under a Windows account of their own that can't see your files or sign-ins.", paid, why: 'paid' };
  }
  return { state: 'offered', title: 'Offered', text: facts.workflows ? "No job of this repository's workflows runs on GitHub's paid Linux or Windows runners, so there is nothing to save; it can still run them on this PC." : `nextlevel couldn't read its workflows (${facts.workflowsError || 'no answer'}), so it can't say what running them here would save.`, paid: [], why: 'nothing-paid' };
}

// The minutes, as the card says them
export function minutesText(m) {
  if (!m) return '';
  if (m.error) return `nextlevel couldn't read the runs' minutes: ${m.error}`;
  const hosted = m.linux + m.windows + m.macos;
  const of = m.more ? ` (the latest ${m.runs} runs)` : '';
  if (!hosted) return `Last ${m.days} days${of}: no minutes on GitHub's runners.`;
  const parts = [m.linux && `Linux ${m.linux}`, m.windows && `Windows ${m.windows}`, m.macos && `macOS ${m.macos}`].filter(Boolean).join(', ');
  return `Last ${m.days} days${of}: ${hosted} minutes on GitHub's runners (${parts}).${m.windows ? ' Windows minutes count twice.' : ''}`;
}

// ---------- the cache ----------
// A store: { get(slug) -> kept facts | null, set(facts) | null }: the file's own, which the dashboard and `team runner`
// write under its lock (the doctor's checks keep nothing: they read GitHub each run).
const keyOf = (slug) => String(slug).toLowerCase();
const freshness = (kept, now) => (kept && typeof kept === 'object' && kept.at ? { ...kept, fresh: now - Date.parse(kept.at) < FRESH_MS } : null);
export const fileStore = {
  get: (slug) => (readJsonFile(cacheFile(), {}) || {})[keyOf(slug)] || null,
  set: (facts) => updateJsonFile(cacheFile(), (all) => ({ ...(all && typeof all === 'object' ? all : {}), [keyOf(facts.slug)]: facts }), {}),
};
export function cachedFacts(slug, { now = Date.now(), store = fileStore } = {}) {
  return freshness(store.get(slug), now);
}
export function keepFacts(facts, store = fileStore) {
  if (facts?.slug && store.set) store.set(facts);
}
// Whether kept facts have every part the Team page shows (the doctor's checks read them without the workflows and minutes)
export const factsComplete = (f, parts = {}) => !f?.ok || f.visibility !== 'private' || Object.entries({ forks: true, collaborators: true, workflows: true, minutes: true, ...parts }).every(([k, on]) => !on || f[k] !== undefined || f[`${k}Error`] !== undefined);
// The facts, from the store when they're fresh enough and have what's asked, else read (and kept, when the store keeps)
export async function repoFacts(slug, gh, { fresh = false, parts, now = Date.now(), store = fileStore } = {}) {
  const kept = fresh ? null : cachedFacts(slug, { now, store });
  if (kept?.fresh && kept.ok && factsComplete(kept, parts)) return kept;
  const facts = await readRepoFacts(slug, gh, { parts, now });
  // (a read that failed is kept too, so the card says so; one without some parts makes the next caller that wants them
  // read again)
  keepFacts(facts, store);
  return facts;
}

// ---------- what the Team page's card and `nextlevel team runner status` show ----------
// slug: the repository (null: the project's origin isn't on GitHub). facts: its facts (null: none read yet).
export function checksView(slug, facts, { refreshing = false } = {}) {
  if (!slug) return { slug: null, state: 'no-repo', title: 'No GitHub repository', text: "This project's origin isn't a GitHub repository, so there are no GitHub checks to run here.", jobs: [], notes: [] };
  if (!facts) return { slug, state: 'reading', title: 'Reading', text: `nextlevel is asking GitHub about ${slug}.`, jobs: [], notes: [], refreshing: true };
  const o = offer(facts);
  const view = { slug, state: o.state, title: o.title, text: o.text, at: facts.at, refreshing, visibility: facts.visibility || '', ownerType: facts.ownerType || '', jobs: [], notes: [] };
  if (!['recommended', 'offered'].includes(o.state)) return view;
  // (only where a job is on GitHub's paid runners: another's place is the guard card's to say, job by job)
  if (o.paid?.length) view.where = "GitHub's runners (paid: this repository is private)";
  view.minutes = minutesText(facts.minutes);
  // each job on GitHub's paid runners, and whether it would move (a job with an environment or a secret stays on GitHub
  // by default: the design's point 2)
  view.jobs = (o.paid || []).map((j) => ({
    file: j.file,
    job: j.name && j.name !== j.id ? `${j.id} (${j.name})` : j.id,
    os: j.os,
    runsOn: j.labels.join(', '),
    stays: !!(j.environment || j.secrets.length),
    why: j.environment ? `it runs in the environment ${j.environment}${j.secrets.length ? ` with ${j.secrets.join(', ')}` : ''}` : j.secrets.length ? `it uses ${j.secrets.join(', ')}` : '',
  }));
  if (facts.forks?.run) view.notes.push({ kind: 'error', text: 'Workflows from fork pull requests are on: turn them off first (Setup -> Fork pull requests).' });
  const others = (facts.collaborators || []).filter((c) => c.push && c.login.toLowerCase() !== String(facts.owner).toLowerCase());
  if (others.length) view.notes.push({ kind: 'warn', text: `${others.map((c) => c.login).join(', ')} can push too: each could run code on this PC once its checks run here.` });
  (facts.workflows || []).filter((w) => w.error).forEach((w) => view.notes.push({ kind: 'warn', text: `${w.file}: nextlevel couldn't read it (${w.error}).` }));
  view.later = 'Setting it up comes in a later version of nextlevel: the Windows account, the runners and the switch (the design\'s part B). Nothing is set up yet.';
  return view;
}
