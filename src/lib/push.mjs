// Pushing (FR-015): what a push may name as its target, which branches deploy, and the one `git push` nextlevel runs.
// On a real project `nextlevel push --help` pushed main, which deployed production: push took no branch and ignored its
// arguments. Now a push names its branch on origin; a name that could reach a branch another way is refused; nothing is
// ever forced; and a deploy branch waits for the owner's approval on the dashboard. The hub's pushBranch (hub.mjs) is
// the only caller of pushArgs, and every push goes through it (a test reads src/ to prove it). Pure, but pushArgs.

export const REMOTE = 'origin';

// Why `name` isn't a plain branch name, or '' when it is one: letters, digits, ".", "_", "-" and "/" in git's own
// limits, and nothing that makes git read it as something else (an option, a refspec, a ref, HEAD).
export function branchNameProblem(name) {
  const n = String(name ?? '');
  if (!n.trim()) return 'no branch name';
  if (n.startsWith('+')) return `"${n}": a leading "+" forces a push, and nextlevel never forces one`;
  if (n.includes(':')) return `"${n}": a colon makes it a refspec (from:to), which can push to any branch`;
  if (n.startsWith('-')) return `"${n}": a name that starts with "-" reads as an option`;
  if (/^refs\//i.test(n)) return `"${n}" names a ref directly: give the branch's plain name`;
  if (/^(HEAD|@)$/i.test(n) || n.includes('@{')) return `"${n}" is not a branch: give the branch's plain name`;
  if (!/^[A-Za-z0-9._/-]+$/.test(n)) return `"${n}" has characters a branch name can't have here: letters, digits, ".", "_", "-" and "/" only`;
  const parts = n.split('/');
  if (parts.some((p) => !p || p.startsWith('.') || p.endsWith('.') || p.toLowerCase().endsWith('.lock')) || n.includes('..')) return `"${n}" isn't a valid branch name`;
  return '';
}

// Why `name` can't be a push's target, or '': not a plain branch name, a remote's name (or one in front of it: origin/
// main), or a tag's (here or on origin). `remotes`: the project's remotes; `tags`: the tag names known.
export function targetProblem(name, { remotes = [REMOTE], tags = [] } = {}) {
  const plain = branchNameProblem(name);
  if (plain) return plain;
  const n = String(name);
  const low = n.toLowerCase();
  for (const r of new Set([REMOTE, ...remotes])) {
    if (low === r.toLowerCase()) return `"${n}" is the name of a remote, not a branch: nextlevel push <branch> pushes to ${REMOTE}'s <branch>`;
    if (low.startsWith(`${r.toLowerCase()}/`)) return `"${n}" names a branch through the remote ${r}: give the branch's own name (${n.slice(r.length + 1)})`;
  }
  if (/^remotes\//i.test(n)) return `"${n}" reads as a remote's branch: give the branch's own name`;
  if (tags.some((t) => t.toLowerCase() === low)) return `"${n}" is a tag, not a branch`;
  return '';
}

// A project's deploy branches as its settings say: deployBranches, or, while it isn't set, the base branch
export const deployList = (config) => (Array.isArray(config?.deployBranches) ? config.deployBranches : [config?.baseBranch || 'main']);
// Whether `target` is one of them (case doesn't count: a server may not tell Main from main)
export const isDeployBranch = (target, list) => list.some((b) => String(b).toLowerCase() === String(target).toLowerCase());

// The one `git push` nextlevel runs: exactly `sha` to `target` on origin. No "+", no --force of any kind, no tags
// that follow, no submodules: only that branch moves, and only forward (git refuses a push that would drop commits).
// --porcelain: git's own words for each ref, the same in every language.
export function pushArgs(sha, target) {
  if (!/^[0-9a-f]{40,64}$/.test(String(sha))) throw new Error(`not a commit id: ${sha}`);
  const problem = branchNameProblem(target);
  if (problem) throw new Error(problem);
  return ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no', REMOTE, `${sha}:refs/heads/${target}`];
}

// What `git ls-remote --heads --tags origin` printed: { heads: Map(name -> sha), tags: [names] } (the names are origin's:
// a Map, so no name can be anything but a key)
export function parseLsRemote(out) {
  const heads = new Map();
  const tags = new Set();
  for (const line of String(out || '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    const sha = line.slice(0, tab);
    const ref = line.slice(tab + 1).trim();
    if (tab < 0 || !/^[0-9a-f]{40,64}$/.test(sha)) continue;
    if (ref.startsWith('refs/heads/')) heads.set(ref.slice('refs/heads/'.length), sha);
    else if (ref.startsWith('refs/tags/')) tags.add(ref.slice('refs/tags/'.length).replace(/\^\{\}$/, ''));
  }
  return { heads, tags: [...tags] };
}
