// The push block: what keeps a session in the main checkout from pushing, or acting on GitHub as the owner, by accident
// (FR-017 for a verify command; the Argon roles for an orchestrator or an assistant on Antigravity, which skips its own
// permission checks). One builder for all of them, so what a verify command, an autopilot round, the orchestrator's
// window and the lock test get is the same code (the lock test proves it for the role it runs).
//
// It is noPushEnv (lib/workerspec.mjs: git's push URLs rewritten to nowhere, no credential helper, no ssh, GitHub tokens
// that don't work), gh's folder with no sign-in, and each remote's own push URL switched off: a rewrite (pushInsteadOf)
// leaves a remote's explicit pushurl alone, so each remote also gets a push URL that fails, after an empty one that clears
// the project's own (Git 2.46+: always, so a push URL the session writes into the settings itself is cleared too; an
// older Git would take the empty one for a URL, so it gets it only where the project has one, and then the check below
// refuses). Then the push URLs are read back the way git will use them: a push that could still reach a remote means the
// session doesn't start (`problem`, in words for the owner).
//
// GitHub reads come back only with a read-only token (verify commands' `NEXTLEVEL_GITHUB_READ_TOKEN`, lib/github.mjs):
// gh gets it, and git gets it for github.com from a helper that returns only it. An orchestrator or an assistant gets none.
//
// This stops an accident, never a session that sets out to get around it: one that clears these variables pushes with the
// owner's access (measured on agy 1.4.0, docs/design/antigravity-roles.md 1d and 2d). docs/KNOWN_ISSUES.md says so.
import { spawnSync } from 'node:child_process';
import { versionAtLeast } from '../checks/lib.mjs';
import { readEnv } from './gitlock.mjs';
import { READ_TOKEN, READ_TOKEN_HELPER } from './github.mjs';
import { NO_GH_CONFIG, noPushEnv } from './workerspec.mjs';

// What fails says where it came from: each session's own words
export const BLOCKS = {
  check: {
    url: 'nextlevel-no-push-from-verify-commands::',
    ssh: 'echo "nextlevel: ssh is blocked for verify commands; only the hub pushes" >&2; false',
    token: 'nextlevel-verify-commands-have-no-github-access',
  },
  orchestrator: {
    url: 'nextlevel-no-push-from-the-orchestrator-use-nextlevel-push::',
    ssh: 'echo "nextlevel: ssh is blocked for the orchestrator; push with nextlevel push" >&2; false',
    token: 'nextlevel-the-orchestrator-has-no-github-access',
  },
  assistant: {
    url: 'nextlevel-no-push-from-the-assistant::',
    ssh: 'echo "nextlevel: ssh is blocked for the assistant, which only looks" >&2; false',
    token: 'nextlevel-the-assistant-has-no-github-access',
  },
};

const sq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
const gitIn = (root) => (args, env) => {
  const r = spawnSync('git', args, { cwd: root, env: readEnv(env), encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, out: String(r.stdout || '').trim() };
};
// Whether this PC's git takes an empty pushurl as "none of the earlier ones" (2.46+), asked once per process
let CLEARS_PUSHURL;
// (under the tests' stubs only, NEXTLEVEL_TEST_OLD_GIT=1 plays a Git older than 2.46)
const clearsPushUrl = (run) => (process.env.NEXTLEVEL_TEST_STUBS && process.env.NEXTLEVEL_TEST_OLD_GIT === '1' ? false : (CLEARS_PUSHURL ??= versionAtLeast(run(['--version'], process.env).out, '2.46.0')));

// The environment of a session in `root` with the push block on top of `base`.
//   block      'check' | 'orchestrator' | 'assistant' (BLOCKS: the words a refused push says)
//   session    the session's variables (NEXTLEVEL_AGENT, NEXTLEVEL_SESSION, NEXTLEVEL_READ_ONLY...), on top of base
//   readToken  the project's read-only GitHub token, or '' (none: the session gets no GitHub reads)
//   git        (tests) runs git in root: (args, env) -> { ok, out }
// -> { env, token } (token: whether the session has GitHub reads) or { problem }
export function pushBlockEnv(base, { root, block = 'check', session = {}, readToken = '', git = gitIn(root) } = {}) {
  const words = BLOCKS[block];
  if (!words) throw new Error(`no push block for "${block}"`);
  const env = { ...base, ...session };
  const blocked = noPushEnv(env, words);
  const remotes = git(['remote'], env).out.split(/\r?\n/).map((r) => r.trim()).filter(Boolean);
  const clears = clearsPushUrl(git);
  const clear = (r) => clears || git(['config', '--get-all', `remote.${r}.pushurl`], env).ok;
  // (a remote name git itself would refuse, or one with a character a setting can't carry, gets none: the read-back below
  // then refuses, saying which)
  const urls = remotes.filter((r) => /^\w[\w./-]*$/.test(r)).flatMap((r) => [...(clear(r) ? [sq(`remote.${r}.pushurl=`)] : []), sq(`remote.${r}.pushurl=${words.url}${r}`)]);
  // (after the empty credential.helper, which clears every helper of the owner's, github.com's own: the token only)
  const token = String(readToken || '').trim();
  const reads = token ? { GH_TOKEN: token, GITHUB_TOKEN: token, [READ_TOKEN]: token } : {};
  const helper = token ? [sq(`credential.https://github.com.helper=${READ_TOKEN_HELPER}`)] : [];
  // (gh's folder with no sign-in, as a worker's: the owner's stored login stays out of what the session prints, NO_GH_CONFIG)
  const out = { ...env, ...blocked, ...reads, GH_CONFIG_DIR: NO_GH_CONFIG, GIT_CONFIG_PARAMETERS: [blocked.GIT_CONFIG_PARAMETERS, ...urls, ...helper].join(' ') };
  if (!token) delete out[READ_TOKEN]; // (a token in base, from a .env loaded earlier, never reaches a session given none)
  for (const r of remotes) {
    const read = git(['remote', 'get-url', '--push', '--all', '--end-of-options', r], out);
    const pushTo = read.out.split(/\r?\n/).filter(Boolean);
    // (an older Git reads the empty pushurl as a URL of its own, so a remote with one keeps it: what the tests play)
    const playedOld = !clears && process.env.NEXTLEVEL_TEST_STUBS && git(['config', '--get-all', `remote.${r}.pushurl`], env).ok;
    if (read.ok && !playedOld && pushTo.every((u) => u.startsWith(words.url))) continue;
    return {
      problem:
        `a push from it could still reach the remote "${r}": the project's git config sets remote.${r}.pushurl, which only Git 2.46 or later can switch off for one session. ` +
        `Owner: update Git (PowerShell: winget upgrade Git.Git), or remove the setting (in the project folder: git config --unset-all remote.${r}.pushurl)`,
    };
  }
  return { env: out, token: !!token };
}

// (tests) forget what was asked of git
export const _resetPushBlock = () => {
  CLEARS_PUSHURL = undefined;
};
