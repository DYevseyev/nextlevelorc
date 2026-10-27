// A read-only nextlevel, for the assistant (Ask, src/ask.mjs). Its engine runs with NEXTLEVEL_READ_ONLY=1, so a
// `nextlevel` it runs refuses every command that changes something (a commit, a dispatch, a note, a fix, an
// update, even marking a job reviewed) and runs only those that look. The engine's own read-only mode (Codex's
// sandbox, Claude Code's plan mode and its rules) is the first wall; this is the second, in nextlevel itself.
export const readOnly = (env = process.env) => env.NEXTLEVEL_READ_ONLY === '1';

// What a read-only session may run: [command, what it may be given]
const LOOK = {
  status: () => true,
  result: () => true, // it doesn't mark the job reviewed there (hub.mjs cmdResult)
  team: (rest) => !['set', 'window'].includes(rest[0]),
  doctor: (rest) => rest.includes('--json') && !rest.some((a) => a.startsWith('--fix')),
  help: () => true,
  version: () => true,
  security: (rest) => !rest.length || rest[0] === 'status', // (the scans and findings' titles; never a scan)
  tester: (rest) => !rest.length || ['status', 'check', 'show'].includes(rest[0]), // (never a run, a stop or a persona)
  usage: (rest) => !rest.some((a) => a === '--all-projects' || a.startsWith('--all-projects=')), // (other projects' are the owner's)
};
export const LOOK_ONLY = 'nextlevel status [--json], nextlevel result <job-id> --peek, nextlevel team [--json], nextlevel team models <engine>, nextlevel doctor --json, nextlevel usage [--range ...] [--by ...] [--json], nextlevel security status [--json], nextlevel tester status|check|show';

// Why `nextlevel <cmd> <rest>` can't run in a read-only session, or '' when it may.
export function readOnlyRefusal(cmd, rest = []) {
  const name = ['--help', '-h'].includes(cmd) ? 'help' : ['--version', '-v'].includes(cmd) ? 'version' : cmd;
  if (LOOK[name]?.(rest)) return '';
  return `nextlevel ${[cmd, ...rest].filter(Boolean).join(' ') || '(the menu)'}: refused. This is a read-only session (the assistant): nothing that changes the project or its state runs here. It may run: ${LOOK_ONLY}.`;
}
