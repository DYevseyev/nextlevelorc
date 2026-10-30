// What a worker's engine is started with (FR-022): its arguments, its environment, how it is launched and the files
// written where it runs, from one function, for a worker's attempt (hub.mjs cmdRunTask) and for the model check's trial
// (checks/engines.mjs agyTrial), which may differ only in the prompt, the time limit and the folder. On a real project the
// trial ran with the doctor's environment (the project's .env in it) and through cmd.exe while workers ran without .env,
// started directly: a trial that passed or failed said little about a worker. Pure but dotenvKeys, which reads the .env.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { engine, profileEnv, sessionArgs, workerIsolation } from '../engines/index.mjs';
import { parseEnvText } from './envfile.mjs';
import { READ_TOKEN } from './github.mjs';

// ---------- workers can't push (FR-003): what their environment holds ----------
// A remote helper that doesn't exist, so git fails; ssh that refuses; a GitHub token that doesn't work. The hub uses the
// same for a verify command (FR-017), in that command's own words.
export const NO_PUSH = 'nextlevel-no-push-from-worker-slots::';
// The version of the slots' push block: raised by any change to it (this environment, the slot's push lock, its hooks), so
// a bridge test that ran before asks to run again (each verdict keeps the version it proved; safe updates, point 5)
export const SLOT_PUSH_BLOCK = 1;
export const NO_SSH = 'echo "nextlevel: ssh is blocked for workers; only the hub pushes" >&2; false';
export const NO_GITHUB_TOKEN = 'nextlevel-workers-have-no-github-access';

// The worker's environment, wherever it runs git (even in the main checkout): no saved logins, no login prompts, no ssh,
// and every push URL without a pushurl of its own is rewritten to NO_PUSH. GIT_CONFIG_PARAMETERS (what `git -c` uses;
// this 'key=value' form works on every git) rather than GIT_CONFIG_KEY_<n>: Codex can drop variables whose names contain
// KEY, and git then refuses to run. gh uses GH_TOKEN, then GITHUB_TOKEN, over the owner's stored login
// (GH_ENTERPRISE_TOKEN, GITHUB_ENTERPRISE_TOKEN for GitHub Enterprise hosts); this token doesn't work.
export function noPushEnv(env, { url = NO_PUSH, ssh = NO_SSH, token = NO_GITHUB_TOKEN } = {}) {
  const ours = `'credential.helper=' 'url.${url}.pushinsteadof='`;
  const prev = (env.GIT_CONFIG_PARAMETERS || '').replace(ours, '').trim();
  return {
    GIT_CONFIG_PARAMETERS: prev ? `${prev} ${ours}` : ours,
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    GIT_SSH_COMMAND: ssh,
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_ENTERPRISE_TOKEN: token,
    GITHUB_ENTERPRISE_TOKEN: token,
  };
}

// The variables of `env` whose value is the one in the project's .env (`root`): a worker never gets them. Every one whose
// value is the .env's counts, also when the process that started this one had loaded it already.
export function dotenvKeys(root, env = process.env) {
  if (!root) return [];
  let text = null;
  try {
    text = fs.readFileSync(path.join(root, '.env'), 'utf8');
  } catch {
    return [];
  }
  return Object.entries(parseEnvText(text))
    .filter(([k, v]) => env[k] === v)
    .map(([k]) => k);
}

// gh's folder for a worker: one with no sign-in in it. gh lists the owner's own login (hosts.yml, its token in the
// keyring) beside GH_TOKEN, and uses it once GH_TOKEN is gone: a worker that drops the variable, or an engine's shell that
// drops variables named like a token (Codex can, KNOWN_ISSUES), would act on GitHub as the owner. Its name has none of
// KEY, SECRET or TOKEN, so it reaches the worker's commands. The bridge test's workers ask `gh auth status`: it must
// answer as no one.
export const NO_GH_CONFIG = path.join(os.tmpdir(), 'nextlevel-workers-have-no-gh-login');

// What a worker and its verify commands see: no .env values (slots have no .env on purpose, and the environment must not
// bring them in), no project root, no GitHub read token, and nothing that can push (noPushEnv). `ghConfig`: gh's folder
// (a worker's: NO_GH_CONFIG; a verify command keeps the owner's, its GitHub reads have their own token, FR-017).
export function workerEnv(base, { dotenv = [], ghConfig = '' } = {}) {
  const env = { ...base };
  for (const k of dotenv) delete env[k];
  delete env[READ_TOKEN]; // (verify commands' GitHub reads, FR-017: never a worker's, wherever it was set)
  delete env.NEXTLEVEL_ROOT;
  return { ...env, ...noPushEnv(env), ...(ghConfig ? { GH_CONFIG_DIR: ghConfig } : {}) };
}

// How a worker's engine starts: directly, a .cmd shim's program without cmd.exe (lib/proc.mjs spawnDirect, FR-013), and
// for an engine that needs a real console on Windows, in the console with no window its process has (lib/console.mjs).
export const LAUNCHER = 'direct';

// One worker run: { args, env, files, launcher, iso, model }.
//   profile       the worker's profile ({ engine, account, model, effort, name })
//   engineArgs    engines.<name>.args;  addons: workers.addons;  addonCtx: what the adapter may read (FR-013)
//   prompt        what the engine is asked; `asIs`: as it is, without the "Read AGENTS.md first" an engine that doesn't
//                 read it by itself gets (the trial's probe: there is no project where it runs)
//   timeoutMin    the time limit;  env: the environment it starts from (workerEnv's base);  dotenv: the .env's names
//   home          the user's home, for a profile's account folder;  version: the engine's (`agy --version`), when what
//                 it is given depends on it (agy's agent lists its tools after 1.3.2);  platform: where it runs (a Codex
//                 worker on Windows gets PowerShell's policy for its own process)
export function workerRun({ profile, engineArgs = [], addons, addonCtx = {}, prompt, asIs = false, timeoutMin, env = {}, dotenv = [], home, version = '', platform = process.platform }) {
  const eng = engine(profile.engine);
  const iso = workerIsolation(profile, addons, { ...addonCtx, version });
  const run = { ...profile, model: profile.model || iso.pin?.model || '', effort: profile.effort || iso.pin?.effort || '' };
  const args = sessionArgs(run, { mode: 'headless', role: 'worker', prompt, timeoutMin, args: engineArgs, isolation: asIs ? { ...iso, readsAgentsMd: true } : iso, version });
  const base = workerEnv({ ...env, NEXTLEVEL_AGENT: 'worker' }, { dotenv, ghConfig: NO_GH_CONFIG });
  // (on top, what a worker's session of the engine needs: Claude Code's background commands off, FR-020; a Codex worker's
  // PowerShell policy on Windows)
  return { args, env: { ...profileEnv(base, profile, { home }), ...(eng.headlessEnv || {}), ...(eng.workerEnv?.({ timeoutMin, platform }) || {}) }, files: iso.files, launcher: LAUNCHER, iso, model: run.model };
}

// The parts of a worker's environment that say how its engine runs (FR-022): its own variables (AGY_*, GEMINI_*,
// GOOGLE_*, ANTIGRAVITY_*), the proxy, the home folders and what nextlevel sets (the push block, NEXTLEVEL_AGENT). The
// rest (PATH, a terminal's own variables) differs between the hub's process and the doctor's without changing the run.
const SAYS_HOW = /^(AGY_|GEMINI_|GOOGLE_|ANTIGRAVITY_|CLOUDSDK_|HTTPS?_PROXY$|NO_PROXY$|ALL_PROXY$|HOME$|USERPROFILE$|APPDATA$|LOCALAPPDATA$|XDG_CONFIG_HOME$|NEXTLEVEL_AGENT$|GIT_CONFIG_PARAMETERS$|GIT_SSH_COMMAND$|GIT_TERMINAL_PROMPT$|GCM_INTERACTIVE$|GH_TOKEN$|GITHUB_TOKEN$|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/i;
export const envSays = (env) =>
  Object.keys(env)
    .filter((k) => SAYS_HOW.test(k))
    .sort()
    .map((k) => [k.toUpperCase(), String(env[k])]);

// A worker run's key: the same for the trial and a worker on the same profile, arguments, add-ons, launcher, environment
// and engine version, whatever the prompt, the limit and the folder. `run` is workerRun's for those, built with the
// placeholders below. Values are hashed, never kept.
export const KEY_PROMPT = '<prompt>';
export const KEY_LIMIT = 1;
export function runKey(run, { version = '', bin = '' } = {}) {
  const spec = { args: run.args, files: run.files, launcher: run.launcher, env: envSays(run.env), version, bin };
  return createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 24);
}
