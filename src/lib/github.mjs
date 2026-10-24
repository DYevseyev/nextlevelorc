// GitHub reads for verify commands (FR-017). A verify command runs without the owner's GitHub sign-in, so a write can't
// reach GitHub from it; but inside Codex's sandbox (no network) verify is the orchestrator's only way to GitHub, and it
// reads CI there (gh run list, view and watch). An optional read-only token in the project's .env gives those
// reads back: gh gets it as GH_TOKEN and GITHUB_TOKEN, git gets it for github.com through a credential helper that
// returns only it, and GitHub itself refuses any write made with it. Pure.

// The token's name in the project's .env: a fine-grained token with read-only access to that project's repository
export const READ_TOKEN = 'NEXTLEVEL_GITHUB_READ_TOKEN';

// The git setting that gives the token to git for github.com, and to nothing else: a helper that answers `get` with the
// token from the verify command's environment (never on a command line), and ignores `store` and `erase`
export const READ_TOKEN_HELPER = `!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${READ_TOKEN}"; }; f`;

// What a fine-grained token needs for the reads verify commands make (CI runs, their jobs, steps and logs; the code for
// a fetch or a clone; pull requests and commit statuses): read-only, on the one repository. Metadata comes with them.
export const READ_TOKEN_PERMISSIONS = ['Actions: Read-only', 'Contents: Read-only', 'Pull requests: Read-only', 'Commit statuses: Read-only'];

// When the token expires, from the header GitHub puts on a response to a request made with an expiring token
// (`github-authentication-token-expiration: 2026-10-30 12:00:00 UTC`), in `gh api -i` output. -> a Date, or null.
export function tokenExpiry(headers) {
  const m = String(headers || '').match(/^github-authentication-token-expiration:\s*(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}(?::\d{2})?))?\s*(UTC|[+-]\d{2}:?\d{2})?/im);
  if (!m) return null;
  const zone = !m[3] || m[3] === 'UTC' ? 'Z' : m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(`${m[1]}T${m[2] || '00:00:00'}${m[2]?.length === 5 ? ':00' : ''}${zone}`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Whether a command's output says gh or git failed for want of a GitHub sign-in (gh's own words, and git's with no
// prompt and no helper), or a fine-grained token was refused check annotations (GitHub gives such tokens no Checks
// permission): -> 'sign-in', 'annotations' or ''
export function githubFailure(text) {
  const s = String(text || '');
  if (/failed to get annotations/i.test(s)) return 'annotations';
  if (/Bad credentials|HTTP 401|The token in GH_TOKEN is invalid|gh auth login|not logged in(to)? any|could not read Username|terminal prompts disabled|Authentication failed for 'https:\/\/github\.com/i.test(s)) return 'sign-in';
  return '';
}
