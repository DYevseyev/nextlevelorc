// Whether a nextlevel command runs in an agent's session, and whose (FR-017). What the hub starts for an agent carries
// it in its environment: the orchestrator's window and an autopilot round (NEXTLEVEL_AGENT=orchestrator, and
// NEXTLEVEL_SESSION), a worker's slot (NEXTLEVEL_AGENT=worker, NEXTLEVEL_TASK_ID), a verify command the orchestrator
// asked for (check), a project hook under the hub's git work (git-job, push) and the assistant (NEXTLEVEL_READ_ONLY).
// The owner-only commands (update --to and --force, filing a report) refuse there, saying why.
// This is no wall: an agent runs as the owner's own Windows user, and one that clears these variables is taken for the
// owner. It keeps an agent from doing these things by accident or through an ordinary nextlevel command
// (docs/KNOWN_ISSUES.md, "What an agent running as the owner can still do"). Pure.

const WHO = {
  orchestrator: "the orchestrator's window",
  worker: "a worker's slot",
  check: 'a verify command the orchestrator asked for (nextlevel verify)',
  'git-job': "a project hook during the hub's git work for the orchestrator",
  push: 'a project hook during a push',
  security: "the security engineer's scan",
  tester: "the tester's acceptance run",
};
// What every nextlevel command prints in the tester's acceptance run, where none runs (src/cli.mjs)
export const TESTER_REFUSAL = "nextlevel doesn't run in the tester's acceptance run: the run walks its plan's steps, and the hub does everything else. Nothing was done.";
// What every nextlevel command prints in the security engineer's scan, where none runs (src/cli.mjs)
export const SECURITY_REFUSAL = "nextlevel doesn't run in the security engineer's scan: the scan reads the code and reports in the findings format; the hub does everything else. Nothing was done.";

// -> '' in the owner's own window, else whose session this is, in words
export function agentSession(env = process.env) {
  if (env.NEXTLEVEL_READ_ONLY === '1') return "the assistant's read-only session (nextlevel ask)";
  if (env.NEXTLEVEL_SESSION === 'autopilot') return 'an autopilot round';
  if (env.NEXTLEVEL_TASK_ID) return WHO.worker;
  const agent = env.NEXTLEVEL_AGENT;
  if (!agent) return '';
  return WHO[agent] || `the ${agent}'s session`;
}

// The words a refused owner-only command prints: what it is, why it refuses here, and where the owner does it
export const ownerOnly = (what, where, session) => `${what} is the owner's, so it doesn't run in an agent's session (this is ${session}): nothing was done. ${where}`;
