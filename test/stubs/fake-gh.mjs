#!/usr/bin/env node
// Stand-in for the GitHub CLI (gh) in tests. It signs in the way gh does: GH_TOKEN, else GITHUB_TOKEN,
// else the owner's stored login (a file in the fake home). With the owner's token, `gh api .../git/refs`
// creates the branch on the "server" (the origin remote) directly, without git push, as the real API would,
// and `gh repo clone owner/name dir` clones https://github.com/owner/name.git (tests point that URL at a
// local repository with git's url.<base>.insteadOf).
// Issues (nextlevel report and fix): `issue create`, `issue view --json`, `label create`, kept as files in
// ~/.fake-github/ (issues/<n>.json, labels.json); a test closes an issue by editing its file, with what closed
// it in `closer` (a merged pull request: { __typename: 'PullRequest', number, url, merged: true }; by hand:
// none). `api graphql` answers the fix loop's question about an issue (its state and its last close event's
// closer), in GitHub's shape. A label the repository doesn't have fails like gh does; STUB_GH_LABELS=deny:
// this account may not make labels. STUB_GH_READ_TOKEN: a read-only token GitHub knows (FR-017's verify commands): with
// it, gh reads (auth status, run list, api) and any write gets GitHub's 403; STUB_GH_READ_EXPIRES is the expiry
// `gh api -i` shows for it.
// Repositories (the self-hosted runner's part A): ~/.fake-github/repos/<owner>__<name>.json, written by the test
// (test/helpers.mjs fakeRepo): { visibility, ownerType, admin, id, defaultBranch, forks: { run, writeTokens, secrets,
// approval } | 'deny', collaborators: [{ login, permissions, type }] | 'deny', workflows: { 'ci.yml': text } | 'deny',
// runs: [{ id, created_at, jobs: [{ name, labels, started_at, completed_at }] }], fail: 'gh's last line' }. `gh api
// repos/O/N[/...]` answers from it as GitHub would (a missing file: 404), and `-X PUT .../fork-pr-workflows-private-repos
// -F k=v` changes its fork settings (each write is appended to repos/writes.jsonl).
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const OWNER_TOKEN = 'stub-owner-token'; // what test/helpers.mjs stores as the owner's login
const args = process.argv.slice(2);
if (process.env.STUB_CALLS) fs.appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['gh', ...process.argv.slice(2)])}\n`); // (every call, for tests that nothing ran)
if (args[0] === '--version') {
  console.log('gh version 2.96.0 (stub)');
  process.exit(0);
}
// gh's folder: GH_CONFIG_DIR, else ~/.config/gh (a worker's has no sign-in in it: lib/workerspec.mjs NO_GH_CONFIG).
// STUB_GH_IGNORE_CONFIG_DIR=1 plays a gh that finds the owner's login anyway (the bridge test must fail then).
const stored = path.join((process.env.STUB_GH_IGNORE_CONFIG_DIR !== '1' && process.env.GH_CONFIG_DIR) || path.join(os.homedir(), '.config', 'gh'), 'hosts.yml');
const storedToken = fs.existsSync(stored) ? (fs.readFileSync(stored, 'utf8').match(/oauth_token:\s*(\S+)/) || [])[1] : '';
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || storedToken;
// A read-only token (FR-017's verify commands): STUB_GH_READ_TOKEN is one GitHub knows, which reads and may write nothing
// (STUB_GH_READ_EXPIRES: the expiry GitHub reports for it)
if (process.env.STUB_GH_READ_TOKEN && token === process.env.STUB_GH_READ_TOKEN) {
  if (args[0] === 'auth' && args[1] === 'status') {
    console.log('github.com\n  Logged in to github.com account owner (GH_TOKEN) (stub, a read-only token)');
    process.exit(0);
  }
  const write = args[0] === 'api' && (args.some((a) => /^-X$|^--method$/.test(a)) || args.some((a) => /^-[fF]$|^--(raw-)?field$/.test(a)));
  if (write || (args[0] !== 'api' && args[0] !== 'run')) {
    console.error('HTTP 403: Resource not accessible by personal access token (https://api.github.com/)');
    process.exit(1);
  }
  if (args[0] === 'run' && args[1] === 'list') console.log('[]');
  else if (args[0] === 'api') {
    if (args.includes('-i')) console.log(`HTTP/2.0 200 OK\n${process.env.STUB_GH_READ_EXPIRES ? `Github-Authentication-Token-Expiration: ${process.env.STUB_GH_READ_EXPIRES}\n` : ''}\n{"full_name":"stub"}`);
    else console.log('{"login":"owner"}');
  } else console.log('{}');
  process.exit(0);
}
// As gh 2.x does: auth status lists the stored login beside a GH_TOKEN that doesn't work (seen on the owner's PC: the
// push block's token fails, and the owner's keyring account shows as logged in, not active)
if (token !== OWNER_TOKEN && token && storedToken === OWNER_TOKEN && args[0] === 'auth' && args[1] === 'status') {
  console.log('github.com\n  X Failed to log in to github.com using token (GH_TOKEN)\n  - Active account: true\n\n  ✓ Logged in to github.com account owner (keyring)\n  - Active account: false');
  process.exit(1);
}
if (token !== OWNER_TOKEN) {
  console.error(token ? 'HTTP 401: Bad credentials (https://api.github.com/)' : 'You are not logged into any GitHub hosts. To log in, run: gh auth login');
  process.exit(1);
}
if (args[0] === 'auth' && args[1] === 'status') {
  console.log('github.com\n  Logged in to github.com account owner (stub)');
  process.exit(0);
}
// `gh api user` (the lock test asks it as the owner, and from the role's session, where it must not answer as the owner)
if (args[0] === 'api' && args[1] === 'user') {
  console.log(args.includes('--jq') ? 'owner' : '{"login":"owner"}');
  process.exit(0);
}
if (args[0] === 'api' && args.some((a) => /\/git\/refs$/.test(a))) {
  const field = (name) => (args.find((a) => a.startsWith(`${name}=`)) || '').slice(name.length + 1);
  const server = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['--git-dir', server, 'fetch', '-q', common, `${field('sha')}:${field('ref')}`]);
  console.log(JSON.stringify({ ref: field('ref'), object: { sha: field('sha') } }));
  process.exit(0);
}
if (args[0] === 'repo' && args[1] === 'clone') {
  const [repo, dir, ...rest] = args.slice(2);
  const extra = rest[0] === '--' ? rest.slice(1) : rest;
  const r = spawnSync('git', ['clone', `https://github.com/${repo}.git`, ...(dir ? [dir] : []), ...extra], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
// ---------- issues ----------
const store = path.join(os.homedir(), '.fake-github');
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const readJson = (f, d) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};
const labelsFile = path.join(store, 'labels.json');
if (args[0] === 'label' && args[1] === 'create') {
  if (process.env.STUB_GH_LABELS === 'deny') {
    console.error('HTTP 403: Resource not accessible by integration (https://api.github.com/repos/x/labels)');
    process.exit(1);
  }
  fs.mkdirSync(store, { recursive: true });
  const labels = readJson(labelsFile, []);
  fs.writeFileSync(labelsFile, JSON.stringify([...new Set([...labels, `${flag('--repo')}:${args[2]}`])]));
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'create') {
  const repo = flag('--repo');
  const label = flag('--label');
  if (label && !readJson(labelsFile, []).includes(`${repo}:${label}`)) {
    console.error(`could not add label: '${label}' not found`);
    process.exit(1);
  }
  const dir = path.join(store, 'issues');
  fs.mkdirSync(dir, { recursive: true });
  const number = fs.readdirSync(dir).length + 1;
  const url = `https://github.com/${repo}/issues/${number}`;
  const issue = { number, repo, url, title: flag('--title'), body: fs.readFileSync(flag('--body-file'), 'utf8'), labels: label ? [label] : [], state: 'OPEN', stateReason: '', closedAt: null };
  fs.writeFileSync(path.join(dir, `${number}.json`), JSON.stringify(issue, null, 2));
  console.log(url);
  process.exit(0);
}
if (args[0] === 'issue' && args[1] === 'view') {
  const issue = readJson(path.join(store, 'issues', `${args[2]}.json`), null);
  if (!issue || issue.repo !== flag('--repo')) {
    console.error(`GraphQL: Could not resolve to an issue or pull request with the number of ${args[2]}. (repository.issue)`);
    process.exit(1);
  }
  const fields = (flag('--json') || '').split(',').filter(Boolean);
  console.log(JSON.stringify(fields.length ? Object.fromEntries(fields.map((f) => [f, issue[f] ?? null])) : issue));
  process.exit(0);
}
if (args[0] === 'api' && args[1] === 'graphql') {
  const field = (name) => args.find((a, i) => (args[i - 1] === '-f' || args[i - 1] === '-F') && a.startsWith(`${name}=`))?.slice(name.length + 1);
  const query = field('query') || '';
  if (!/repository\(owner:\$owner,name:\$name\)\{issue\(number:\$number\)/.test(query) || !/closer\{/.test(query)) {
    console.error(`[fake gh] graphql query not supported: ${query}`);
    process.exit(1);
  }
  const number = field('number');
  const issue = readJson(path.join(store, 'issues', `${number}.json`), null);
  if (!issue || issue.repo !== `${field('owner')}/${field('name')}`) {
    console.error(`GraphQL: Could not resolve to an Issue with the number of ${number}. (repository.issue)`);
    process.exit(1);
  }
  const nodes = issue.state === 'CLOSED' ? [{ closer: issue.closer || null }] : [];
  console.log(JSON.stringify({ data: { repository: { issue: { state: issue.state, stateReason: issue.stateReason || null, closedAt: issue.closedAt, url: issue.url, timelineItems: { nodes } } } } }));
  process.exit(0);
}
if (args[0] === 'api') {
  const target = args.slice(1).find((a, i) => !a.startsWith('-') && !['-H', '-X', '-F', '-f', '--jq', '--method', '--header'].includes(args.slice(1)[i - 1]));
  const m = String(target || '').match(/^repos\/([^/?]+)\/([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (m) {
    const file = path.join(store, 'repos', `${m[1]}__${m[2]}.json`);
    const repo = readJson(file, null);
    const notFound = () => {
      console.error('gh: Not Found (HTTP 404)');
      process.exit(1);
    };
    if (!repo) notFound();
    if (repo.fail) {
      console.error(repo.fail);
      process.exit(1);
    }
    const rest = m[3] || '';
    const query = new URLSearchParams((m[4] || '').slice(1));
    const flag = args.findIndex((a) => a === '-X' || a === '--method');
    const method = flag >= 0 ? String(args[flag + 1] || '').toUpperCase() : 'GET';
    const say = (v) => {
      console.log(JSON.stringify(v));
      process.exit(0);
    };
    const deny = () => {
      console.error('gh: Must have admin rights to Repository. (HTTP 403)');
      process.exit(1);
    };
    if (!rest) {
      say({ id: repo.id ?? 1, full_name: `${m[1]}/${m[2]}`, private: repo.visibility !== 'public', visibility: repo.visibility, default_branch: repo.defaultBranch || 'main', owner: { login: m[1], type: repo.ownerType || 'User' }, permissions: { admin: repo.admin !== false, push: true, pull: true } });
    }
    if (rest === '/actions/permissions/fork-pr-workflows-private-repos') {
      if (repo.forks === 'deny' || repo.admin === false) deny();
      if (method === 'PUT') {
        const fields = Object.fromEntries(args.flatMap((a, i) => (args[i - 1] === '-F' || args[i - 1] === '-f' ? [a.split('=')] : [])).map(([k, v]) => [k, v === 'true']));
        const f = { ...(repo.forks || {}) };
        if ('run_workflows_from_fork_pull_requests' in fields) f.run = fields.run_workflows_from_fork_pull_requests;
        if ('send_write_tokens_to_workflows' in fields) f.writeTokens = fields.send_write_tokens_to_workflows;
        if ('send_secrets_and_variables' in fields) f.secrets = fields.send_secrets_and_variables;
        if ('require_approval_for_fork_pr_workflows' in fields) f.approval = fields.require_approval_for_fork_pr_workflows;
        fs.writeFileSync(file, JSON.stringify({ ...repo, forks: f }, null, 2));
        fs.appendFileSync(path.join(store, 'repos', 'writes.jsonl'), `${JSON.stringify({ repo: `${m[1]}/${m[2]}`, path: rest, fields })}\n`);
        process.exit(0);
      }
      const f = repo.forks || {};
      say({ run_workflows_from_fork_pull_requests: !!f.run, send_write_tokens_to_workflows: !!f.writeTokens, send_secrets_and_variables: !!f.secrets, require_approval_for_fork_pr_workflows: !!f.approval });
    }
    if (method !== 'GET') {
      console.error(`[fake gh] not supported: ${args.join(' ')}`);
      process.exit(1);
    }
    if (rest === '/collaborators') {
      if (repo.collaborators === 'deny') deny();
      say((repo.collaborators || [{ login: m[1], permissions: { admin: true, push: true } }]).map((c) => ({ type: 'User', ...c })));
    }
    if (rest === '/contents/.github/workflows') {
      if (repo.workflows === 'deny') deny();
      const names = Object.keys(repo.workflows || {});
      if (!names.length) notFound();
      say(names.map((name) => ({ name, path: `.github/workflows/${name}`, type: 'file' })));
    }
    const wf = rest.match(/^\/contents\/\.github\/workflows\/(.+)$/);
    if (wf) {
      const text = (repo.workflows || {})[decodeURIComponent(wf[1])];
      if (typeof text !== 'string') notFound();
      say({ name: wf[1], type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') });
    }
    if (rest === '/actions/runs') {
      const runs = repo.runs || [];
      const n = Number(query.get('per_page') || 30);
      say({ total_count: runs.length, workflow_runs: runs.slice(0, n).map(({ jobs, ...r }) => r) });
    }
    const jobs = rest.match(/^\/actions\/runs\/(\d+)\/jobs$/);
    if (jobs) {
      const run = (repo.runs || []).find((r) => String(r.id) === jobs[1]);
      if (!run) notFound();
      say({ total_count: run.jobs.length, jobs: run.jobs });
    }
    notFound();
  }
}
console.error(`[fake gh] not supported: ${args.join(' ')}`);
process.exit(1);
