// What the worker CLIs are told not to run, in each one's own rule syntax (agy's settings file,
// Claude Code's --disallowedTools). Only an extra layer: agy 1.2.11 didn't enforce its rules (FR-003).
// Git itself refuses pushes from worker slots (the hub's lockSlot), and the bridge test proves it.
export const WORKER_DENY = [
  'git push',
  'gh',
  'git reset --hard',
  'git clean',
  'git worktree',
  'git branch -D',
  'Remove-Item',
  'rm',
  'rmdir',
  'rd',
  'del',
  'erase',
  'format',
  'diskpart',
  'shutdown',
  'reg',
  'ssh',
  'scp',
];

// The orchestrator's git writes go through the hub on every engine (nextlevel commit, merge, cleanup):
// Codex's sandbox can't write .git, and the hub keeps them in one lane, logged, next to the workers'.
export const ORCHESTRATOR_DENY = [
  'git add',
  'git commit',
  'git merge',
  'git rebase',
  'git reset',
  'git checkout',
  'git switch',
  'git stash',
  'git tag',
  'git branch -d',
  'git branch -D',
  'git worktree',
  'git clean',
  'git push',
  'gh',
];
// What an orchestrator runs without asking: the hub's commands, and git that only reads.
export const ORCHESTRATOR_ALLOW = ['nextlevel', 'git status', 'git log', 'git diff', 'git show'];

// The assistant (Ask, src/ask.mjs) only looks: the nextlevel commands that change nothing (a job's result with
// --peek, which doesn't mark it reviewed), and git that only reads. Everything else is refused where the engine can
// be told so (Claude Code); Codex's read-only sandbox refuses any write, and NEXTLEVEL_READ_ONLY=1 makes nextlevel
// itself refuse every command that changes something (lib/readonly.mjs).
export const ASSISTANT_LOOK = ['nextlevel status', 'nextlevel result', 'nextlevel team', 'nextlevel doctor --json', 'git status', 'git log', 'git diff', 'git show'];
// Tools that write, fetch or read the project's secrets. A deny rule wins over any allow rule (the owner's own
// settings too), and `*` in a Bash rule stands for any text: "git diff:*" alone would allow `git diff --output=<file>`
// (it writes the file), `--no-index` reads files outside the repository, and `--ext-diff`/`--textconv` run programs.
// Read's rules don't cover Bash, so no command may name .env at all (`cat .env` is one Claude Code runs unasked).
export const ASSISTANT_DENY_TOOLS = [
  'Edit',
  'MultiEdit',
  'Write',
  'NotebookEdit',
  'WebFetch',
  'WebSearch',
  'Read(./.env)',
  'Read(.env)',
  'Read(**/.env)',
  'Bash(git *--output*)',
  'Bash(git *--no-index*)',
  'Bash(git *--ext-diff*)',
  'Bash(git *--textconv*)',
  'Bash(*.env*)',
];
