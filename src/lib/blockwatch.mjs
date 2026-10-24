// What an orchestrator's round on Antigravity ran that clears nextlevel's push block or goes past it (a review of
// docs/design/antigravity-roles.md): read after the round from agy's own steps (stream-json), by pattern. The block
// stops an accident; a session that sets out to can switch it off with one command (measured on 1.4.0), so the owner hears
// when a round's commands look like that. Detection by pattern, after the fact: it can miss a command written another
// way, and it stops nothing. Pure.
import { toolSteps } from '../locktest.mjs';

const ENV_NAMES = '(?:GIT_CONFIG_PARAMETERS|GIT_CONFIG_COUNT|GIT_CONFIG_KEY_\\w+|GIT_CONFIG_VALUE_\\w+|GIT_SSH_COMMAND|GIT_SSH|GIT_ASKPASS|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_CONFIG_DIR)';
export const PATTERNS = [
  // (push as git's own command, after its options only: never a word in a commit message, `git commit -m "web push"`)
  { re: /\bgit(?:\s+(?:-[cC]\s+(?:"[^"]*"|'[^']*'|[^\s"'-]\S*)|--?\w[\w-]*(?:=(?:"[^"]*"|'[^']*'|[^\s"']\S*)?)?))*\s+push\b/i, why: 'a push with git itself (pushes go through nextlevel push)' },
  { re: /\bgit\b[^\n|;&]*\s-c\s*["']?(?:credential\.|url\.|remote\.[^=\s]+\.push|core\.sshcommand)/i, why: "git -c with a setting that sets the push block's settings back" },
  { re: /\bgit\b[^\n|;&]*\sconfig\b[^\n|;&]*(?:credential\.|pushurl|pushinsteadof|insteadof|core\.sshcommand)/i, why: "git config of a sign-in or a push URL" },
  { re: new RegExp(`Remove-Item\\s+(?:-Path\\s+)?["']?Env:${ENV_NAMES}`, 'i'), why: "PowerShell removes a variable of nextlevel's push block" },
  { re: new RegExp(`\\$env:${ENV_NAMES}\\s*=`, 'i'), why: "PowerShell sets a variable of nextlevel's push block" },
  { re: new RegExp(`\\b(?:unset|env\\s+-u)\\s+${ENV_NAMES}`, 'i'), why: "a shell clears a variable of nextlevel's push block" },
  // (at a command's start or after a space: never a name inside a quoted search, `grep "GITHUB_TOKEN=" src`)
  { re: new RegExp(`(?:^|[\\s;&|(])(?:export\\s+)?${ENV_NAMES}=`, 'i'), why: "a shell sets a variable of nextlevel's push block" },
  { re: /\bgh\s+auth\b/i, why: 'gh auth (a GitHub sign-in)' },
  { re: /\bgh\s+api\b[^\n|;&]*(?:-X\s*["']?(?:POST|PUT|PATCH|DELETE)|--method[\s=]+["']?(?:POST|PUT|PATCH|DELETE)|\s-[fF]\s|--(?:raw-)?field\b)/i, why: 'gh api with a method that writes' },
];

// A command as it is shown (hub.log, Home, the phone): the value a command gives a sign-in or a token is never shown
// (`$env:GH_TOKEN = "..."`, `GH_TOKEN=...`, `-c credential.helper=...`, `--with-token ...`); the hub redacts .env values too
const ASSIGNED = new RegExp(`(\\$env:${ENV_NAMES}\\s*=\\s*|\\b${ENV_NAMES}=)("[^"]*"|'[^']*'|\\S+)`, 'gi');
export function masked(command) {
  return String(command)
    .replace(ASSIGNED, '$1***')
    .replace(/(-c\s*["']?(?:credential\.[^=\s]*|url\.[^=\s]*|http\.[^=\s]*extraheader)=)("[^"]*"|'[^']*'|\S+)/gi, '$1***')
    .replace(/(--with-token\b\s*)(\S+)/gi, '$1***')
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '***');
}

// The commands of a run that look like that: [{ command, why }], each command once (masked)
export function blockCommands(text) {
  const out = [];
  const seen = new Set();
  for (const s of toolSteps(text)) {
    if (s.name !== 'run_command') continue;
    const command = String(s.params.CommandLine || s.params.Command || '');
    const hit = PATTERNS.find((p) => p.re.test(command));
    if (!hit || seen.has(command)) continue;
    seen.add(command);
    const shown = masked(command);
    out.push({ command: shown.length > 300 ? `${shown.slice(0, 299)}…` : shown, why: hit.why });
  }
  return out;
}
