// What CI runs, decided from the files a change touches, never from a label. The workflows run this with Node's
// built-ins only, like the tool (docs/DECISIONS.md, 2026-09-28: CI runs Windows once per pull request).
//
//   node .github/ci/changes.mjs ubuntu    ci.yml's job, on a pull request's push and on main after a merge: the tests
//                                         are skipped when the whole pull request against main (or the merge on main)
//                                         is documentation. On a pull request it also cancels a Windows run of the
//                                         branch that this push replaced, and passes the "windows" check at once when
//                                         no Windows run is needed: the whole pull request is documentation, or the
//                                         head has exactly the code of a commit where a Windows run's tests passed
//   node .github/ci/changes.mjs windows   windows.yml's job: the tests are skipped on those same grounds; it fails at
//                                         once on a branch that is behind main
//
// Outputs (GITHUB_OUTPUT): skip=true only when the tests may be skipped, with why=<the reason>; anything that goes
// wrong on the way means the tests run.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Documentation that no test reads: docs/ and the Markdown files at the top (README.md, CLAUDE.md). docs/CHECKS.md is
// code here, a test compares it with the checks; templates/ is code too (projects get it, and tests read it).
const READ_BY_TESTS = new Set(['docs/CHECKS.md']);
export const isDoc = (file) => !READ_BY_TESTS.has(file) && (/^docs\/./.test(file) || /^[^/]+\.md$/.test(file));
// (a change that touches nothing is not "only documentation": its tests run)
export const docsOnly = (files) => Array.isArray(files) && files.length > 0 && files.every(isDoc);

const gitIn = (cwd) => (args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '' };
};

// The files that differ between two commits, or null when git can't tell. A renamed file counts as both names: a
// source file moved into docs/ is a code change. (A revision is never taken for one of git's options.)
export function changedFiles(from, to, git) {
  if ([from, to].some((rev) => !rev || String(rev).startsWith('-'))) return null;
  const r = git(['diff', '--name-only', '--no-renames', '-z', from, to, '--']);
  return r.ok ? r.out.split('\0').filter(Boolean) : null;
}

// The first of `passed` (commits whose code passed on Windows) that `head` contains with nothing but documentation
// changed since, or null: the same code, main's included (code main brought in later is a change since). `head`
// itself counts: it passed already. A commit that passed before and code changed since, on the branch or from main,
// never counts.
export function sameCodeAs(head, passed, git) {
  for (const p of passed) {
    if (!/^[0-9a-f]{7,40}$/.test(p?.sha || '') || !git(['merge-base', '--is-ancestor', p.sha, head]).ok) continue;
    const files = changedFiles(p.sha, head, git);
    if (files && files.every(isDoc)) return { ...p, files };
  }
  return null;
}

const short = (sha) => String(sha).slice(0, 7);
// (a file's name comes from the pull request: a line break in it would start a line the runner reads as a command)
const shown = (file) => file.replace(/[\u0000-\u001f\u007f]/g, '?');
const listed = (files) => {
  const names = files.map(shown);
  return names.length > 6 ? `${names.slice(0, 6).join(', ')} and ${names.length - 6} more` : names.join(', ');
};
const sameText = (same) =>
  same.kind === 'main'
    ? `the code is main's${same.files.length ? `: only documentation changed (${listed(same.files)})` : ''}`
    : `the code is the same as ${short(same.sha)}, which passed on Windows (${same.url})${same.files.length ? `; only documentation changed since (${listed(same.files)})` : ''}`;

// GitHub's REST API for this repository, with the job's token
export function githubApi(env = process.env, fetchFn = globalThis.fetch) {
  const base = `${env.GITHUB_API_URL || 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}`;
  return async (method, path, body) => {
    const res = await fetchFn(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN || ''}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
}

const WINDOWS = 'windows.yml';
const windowsRuns = async (api, branch, query = '') =>
  (await api('GET', `/actions/workflows/${WINDOWS}/runs?branch=${encodeURIComponent(branch)}&per_page=50${query}`))?.workflow_runs || [];

// Commits of the branch on which a Windows run ran the tests and they passed (newest first): never a run that skipped
// them as the same code as an earlier one, so a pass always rests on tests that ran. A run started by marking the pull
// request ready for review tests GitHub's merge of it with main; that has the pull request's own code, since a run on
// a commit behind main fails before it tests (windows(), below).
const REQUESTS = new Set(['pull_request', 'workflow_dispatch']);
export const TEST_STEP = 'End-to-end tests (stub CLIs)';
async function testsPassed(api, run) {
  const jobs = (await api('GET', `/actions/runs/${run.id}/jobs?filter=latest`))?.jobs || [];
  return jobs.some((j) => j.name === 'windows' && j.conclusion === 'success' && (j.steps || []).some((s) => s.name === TEST_STEP && s.conclusion === 'success'));
}
export async function windowsPasses(api, branch, exceptRun = '') {
  const runs = (await windowsRuns(api, branch, '&status=success')).filter((r) => REQUESTS.has(r.event) && String(r.id) !== String(exceptRun));
  const passes = [];
  for (const r of runs) if (await testsPassed(api, r)) passes.push({ kind: 'run', sha: r.head_sha, url: r.html_url });
  return passes;
}

// Windows runs of the branch still going on another commit: a newer push replaced them
export async function cancelReplaced(api, branch, head) {
  const going = (await windowsRuns(api, branch)).filter((r) => r.status !== 'completed' && r.head_sha !== head);
  for (const r of going) await api('POST', `/actions/runs/${r.id}/cancel`);
  return going.map((r) => `${r.html_url} on ${short(r.head_sha)}`);
}

// ci.yml's ubuntu job. Returns { skip, why, notes } after cancelling and posting what it says.
export async function ubuntu({ eventName, event, sha, git, api }) {
  const notes = [];
  const warn = (what, err) => notes.push(`warning: ${what}: ${err.message}`);
  if (eventName === 'push') {
    const files = /^0*$/.test(event.before || '') ? null : changedFiles(event.before, sha, git);
    return docsOnly(files) ? { skip: true, why: `only documentation changed (${listed(files)})`, notes } : { skip: false, why: '', notes };
  }
  if (eventName !== 'pull_request') return { skip: false, why: '', notes };
  const head = event.pull_request.head.sha;
  const branch = event.pull_request.head.ref;
  // GitHub's merge of the pull request into main (HEAD) against main (its first parent): everything the pull request
  // changes, never just the latest push
  const files = changedFiles('HEAD^1', 'HEAD', git);
  const docs = docsOnly(files);
  try {
    for (const run of await cancelReplaced(api, branch, head)) notes.push(`cancelled the Windows run ${run}: this push replaced it`);
  } catch (err) {
    warn("a Windows run this push replaced couldn't be cancelled", err);
  }
  let same = docs ? { kind: 'main', sha: 'HEAD^1', files } : null;
  if (!same) {
    try {
      same = sameCodeAs(head, await windowsPasses(api, branch), git);
    } catch (err) {
      warn("the branch's earlier Windows runs couldn't be read", err);
    }
  }
  if (same) {
    const summary = `No Windows run needed: ${sameText(same)}.`;
    try {
      await api('POST', '/check-runs', { name: 'windows', head_sha: head, status: 'completed', conclusion: 'success', output: { title: 'No Windows run needed', summary } });
      notes.push(`the windows check passes on ${short(head)}: ${sameText(same)}`);
    } catch (err) {
      warn('the windows check could not be passed (ask for the Windows run as usual)', err);
    }
  }
  return docs ? { skip: true, why: `only documentation changed (${listed(files)})`, notes } : { skip: false, why: '', notes };
}

// windows.yml's job: asked for by marking the pull request ready for review, or run by hand (Actions tab). Returns
// { skip, why, notes, fail }.
export async function windows({ eventName, event, refName, runId, git, api }) {
  const notes = [];
  const pr = eventName === 'pull_request' ? event.pull_request : null;
  // The commit the check lands on: the pull request's head (its run tests GitHub's merge of it with main), or the
  // branch's (a run by hand)
  const head = pr ? pr.head.sha : git(['rev-parse', 'HEAD']).out.trim();
  const branch = pr ? pr.head.ref : refName;
  const mainName = pr?.base?.ref || event.repository?.default_branch || 'main';
  // (main as fetched now; a pull request's merge also has it as its first parent)
  const main = git(['rev-parse', '--verify', '-q', `origin/${mainName}`]).ok ? `origin/${mainName}` : pr ? 'HEAD^1' : '';
  if (!/^[0-9a-f]{40}$/.test(head)) return { fail: `no commit to test (${head || 'none'})`, notes };
  if (!main || !git(['merge-base', '--is-ancestor', main, head]).ok) {
    return {
      fail: `${branch} is behind ${mainName}, and a merge needs the Windows run on a commit that has ${mainName} in it: bring the branch up to date first (git fetch origin, git merge origin/${mainName}, npm test, push), then ask for this run again.`,
      notes,
    };
  }
  const base = git(['rev-parse', main]).out.trim();
  let passed = [];
  try {
    passed = await windowsPasses(api, branch, runId);
  } catch (err) {
    notes.push(`warning: the branch's earlier Windows runs couldn't be read: ${err.message}`);
  }
  // The documentation rule: when all the pull request changes against main is documentation, its code is main's
  // (under branch protection, the tested head of the pull request merged last)
  if (base && base !== head) passed.push({ kind: 'main', sha: base, url: '' });
  const same = sameCodeAs(head, passed, git);
  return same ? { skip: true, why: sameText(same), notes } : { skip: false, why: '', notes };
}

async function main() {
  const job = process.argv[2];
  const env = process.env;
  const event = env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const ctx = { eventName: env.GITHUB_EVENT_NAME, event, sha: env.GITHUB_SHA, refName: env.GITHUB_REF_NAME, runId: env.GITHUB_RUN_ID, git: gitIn(process.cwd()), api: githubApi(env) };
  if (job !== 'ubuntu' && job !== 'windows') throw new Error('usage: node .github/ci/changes.mjs ubuntu|windows');
  const r = await (job === 'ubuntu' ? ubuntu(ctx) : windows(ctx));
  // (one line each: what GitHub's API answered stays inside its warning)
  for (const n of r.notes.map((x) => x.replace(/[\r\n]+/g, ' '))) console.log(n.startsWith('warning: ') ? `::warning::${n.slice(9)}` : n);
  const said = r.fail ? `::error::${r.fail}` : r.skip ? `The tests are skipped: ${r.why}.` : 'The tests run.';
  console.log(said);
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${r.fail || (r.skip ? `Tests skipped: ${r.why}.` : 'Tests run.')}\n`);
  if (r.fail) process.exit(1);
  // (the reason is one line; a newline in it would start another output)
  if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `skip=${r.skip ? 'true' : 'false'}\nwhy=${String(r.why).replace(/[\r\n]+/g, ' ')}\n`);
}

// Run as a program (the tests import it). Node 24 says so itself; else the file it was started with, compared as
// Windows compares names.
function invoked() {
  if (typeof import.meta.main === 'boolean') return import.meta.main;
  try {
    const [a, b] = [fs.realpathSync(process.argv[1]), fs.realpathSync(fileURLToPath(import.meta.url))];
    return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
  } catch {
    return false;
  }
}

if (invoked()) {
  main().catch((err) => {
    console.log(`::error::${err.message}`);
    process.exit(1);
  });
}
