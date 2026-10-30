// What a role in the main checkout runs with on Antigravity (docs/design/antigravity-roles.md): its arguments, its agent
// file, its environment (the push block, lib/pushblock.mjs) and the key its lock test's verdict is kept under. One place
// for the orchestrator's window, an autopilot round, the lock test's tries (src/locktest.mjs), the Team page and the
// doctor, so the lock test proves exactly what the role runs. Pure but pushBlockEnv's git.
import { ADAPTERS, sessionArgs } from '../engines/index.mjs';
import { ROLE_AGENTS, agyRoleAgent, roleAgentFile } from '../engines/agy.mjs';
import { pushBlockEnv } from './pushblock.mjs';
import { KEY_LIMIT, KEY_PROMPT, runKey } from './workerspec.mjs';

// The roles that run in the main checkout on Antigravity only with a passing lock test, and how each starts there
// (the assistant: in a throwaway copy of the project, src/ask.mjs agyAssistantRun)
export const LOCKED_ROLES = { orchestrator: { block: 'orchestrator', agent: ROLE_AGENTS.orchestrator }, assistant: { block: 'assistant', agent: ROLE_AGENTS.assistant } };
// Whether this role on this profile needs the lock test (the setup guide doesn't: the owner is there, FR-017's warning)
export const needsLockTest = (profile, role) => profile?.engine === 'agy' && Object.hasOwn(LOCKED_ROLES, role);

// The session's variables: whose session this is (lib/session.mjs)
// (the assistant's: read-only, so the nextlevel commands it runs only look, lib/readonly.mjs; NEXTLEVEL_READ_ROOT, the real
// project they read, comes with the copy it runs in)
export const sessionVars = (role, mode) => (role === 'orchestrator' ? { NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: mode === 'headless' ? 'autopilot' : 'interactive' } : role === 'assistant' ? { NEXTLEVEL_READ_ONLY: '1' } : {});

// One run of a role on agy: { args, files, env | problem, launcher }.
//   profile      the role's profile ({ engine: 'agy', model, ... })
//   role         'orchestrator'
//   mode         'headless' (an autopilot round, a lock test's try) or 'interactive' (the orchestrator's window)
//   prompt, timeoutMin   what it is asked, and its limit (headless)
//   engineArgs   engines.agy.args;  version: agy's (`agy --version`: the agent lists its tools after 1.3.2)
//   env          the environment it starts from (the hub's childEnv, with the profile's account);  root: the project's
//                folder, whose remotes the push block switches off. env null: no environment (the key needs none)
export function roleRun({ profile, role, mode, prompt, timeoutMin = 60, engineArgs = [], version = '', env = null, root = '' }) {
  const spec = LOCKED_ROLES[role];
  if (!spec) throw new Error(`no lock test for the ${role}`);
  const files = [{ path: roleAgentFile(role), text: agyRoleAgent(role, { version }) }];
  // (the agent doesn't read AGENTS.md by itself, FR-013: the prompt tells it to, as a worker's)
  const isolation = { args: ['--agent', spec.agent], readsAgentsMd: false };
  // (sessionArgs puts isolation's arguments on a headless run's and on an interactive one's: agy's -i takes them as `extra`)
  const args = sessionArgs(profile, { mode, role, prompt, timeoutMin, args: engineArgs, isolation, version });
  const out = { args, files, launcher: mode === 'headless' ? 'console' : 'window' };
  if (!env) return out;
  const session = { ...sessionVars(role, mode), ...(ADAPTERS.agy.headlessEnv || {}) };
  const blocked = pushBlockEnv(env, { root, block: spec.block, session });
  return blocked.problem ? { ...out, problem: blocked.problem } : { ...out, env: blocked.env };
}
// The names of what the role's environment has from nextlevel: the session's, agy's own for a headless run, the push
// block's. Their values depend on the project (its remotes) or nothing that changes what the role can do, so the key has
// the names only: the lock test's temporary project and the real one get the same key.
const KEY_ENV = ['GIT_CONFIG_PARAMETERS', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE', 'GIT_SSH_COMMAND', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_CONFIG_DIR'];
// The key of a role's lock test verdict (FR-022's runKey: its arguments, its agent file, how it is launched, its
// environment's names, agy's version and program): a verdict counts only for exactly that. -> 24 hex characters
export function roleKey({ profile, role, engineArgs = [], version = '', bin = '' }) {
  const run = roleRun({ profile, role, mode: 'headless', prompt: KEY_PROMPT, timeoutMin: KEY_LIMIT, engineArgs, version });
  const names = [...Object.keys(sessionVars(role, 'headless')), ...Object.keys(ADAPTERS.agy.headlessEnv || {}), ...KEY_ENV];
  return runKey({ ...run, env: Object.fromEntries(names.map((k) => [k, ''])) }, { version, bin });
}

// The verdict's file, beside the bridge tests' (.nextlevel/bridge-tests/<engine>.json): .nextlevel/lock-tests/agy-<role>.json
export const lockFileParts = (role) => ['lock-tests', `agy-${role}.json`];

// Whether a kept verdict lets the role start: a pass for exactly this key
export const lockPasses = (v, key) => !!v && v.ok === true && v.verdict === 'pass' && typeof key === 'string' && v.key === key;
