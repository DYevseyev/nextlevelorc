// Redaction, the way reports are redacted (report.mjs, M5), and phone messages too (FR-017: notify.mjs): every value of the
// project's .env (and NAME=value for its names), the values of variables whose names say secret and the ntfy topic,
// token shapes, logins in URLs, and the home folder. Pure but phoneSecrets, which reads the .env.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { redact } from '../checks/lib.mjs';
import { parseEnvText } from './envfile.mjs';
import { keepsSecrets, redactionValues } from './vault.mjs';

// Names whose values are secrets wherever they appear (`NAME=value`), besides every name in the .env.
export const SECRET_NAME = /^[A-Z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CLIENT_?KEY|CREDENTIALS?|COOKIE|DSN)[A-Z0-9_]*$/i;
// Token shapes the checks' redact() doesn't know (it has OpenAI, Anthropic, GitHub, Google and Slack ones)
const MORE_TOKENS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g, // a key, to its end or the end of the text
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, // a JWT
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access keys
  /\b(?:sk|rk|pk|whsec)_(?:live|test)_[A-Za-z0-9]{8,}/g, // Stripe
  /\bnpm_[A-Za-z0-9]{30,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\b(Bearer|Basic)\s+(?=[A-Za-z0-9._~+/-]*[0-9+/=])[A-Za-z0-9._~+/=-]{16,}/g, // an Authorization header's value
];

// What a report must never contain: every value of the project's .env (and the names, for NAME=value), the
// values of variables in this window whose names say secret, the ntfy topic, and the tester's persona passwords and
// tokens (lib/vault.mjs: unsealed once per process, and only when the project keeps one; `ctx.personas` gives them).
export function reportSecrets(ctx) {
  const dotenv = ctx.root ? parseEnvText(ctx.read(ctx.path.join(ctx.root, '.env'))) : {};
  // a variable of this window is taken when it is long enough to be a secret, not a word like "true"
  const fromEnv = Object.entries(ctx.env || {}).filter(([k, v]) => v && v.length >= 8 && (SECRET_NAME.test(k) || k === 'NTFY_TOPIC')).map(([, v]) => v);
  const personas = ctx.personas ?? (ctx.root ? redactionValues(ctx.root).values : []);
  const values = [...new Set([...(ctx.secrets || []), ...Object.values(dotenv), ...fromEnv, ...personas].filter((v) => v && v.length >= 4))];
  return { values: values.sort((a, b) => b.length - a.length), names: Object.keys(dotenv) };
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// The text with secrets replaced by ***, and the home folder (`home`: one path, or its forms) by ~
// (%USERPROFILE% on Windows).
// `values` shorter than 6 characters are replaced only as NAME=value: "1" or "true" are too common to
// blank out everywhere, and too short to be a secret worth the name.
export function redactReport(text, { values = [], names = [], home = '', platform = process.platform } = {}) {
  let s = String(text ?? '');
  // The .env's own values first, longest first: once a pattern below has changed part of one (a login in
  // a URL, a token inside it), the rest of it would no longer be found
  for (const v of [...values].filter((x) => x.length >= 6).sort((a, b) => b.length - a.length)) s = s.split(v).join('***');
  // short ones as whole words; a yes/no setting would blank out ordinary words (it goes as NAME=value below)
  for (const v of values.filter((x) => x.length >= 4 && x.length < 6 && !/^(true|false|yes|no|on|off)$/i.test(x))) {
    s = s.replace(new RegExp(`(^|[^A-Za-z0-9])${escapeRe(v)}(?=$|[^A-Za-z0-9])`, 'g'), '$1***');
  }
  for (const re of MORE_TOKENS) s = s.replace(re, (m, word) => (/^(Bearer|Basic)$/.test(word || '') ? `${word} ***` : '***'));
  s = redact(s); // the checks' token shapes and logins in URLs
  const named = new RegExp(`\\b(${[...names.map(escapeRe), '[A-Za-z0-9_]+'].join('|')})(\\s*[=:]\\s*)("[^"\\n]*"|'[^'\\n]*'|[^\\s"',;)]+)`, 'g');
  const placeholder = (v) => /^(\*\*\*|""|''|[.…<>-]+)$/.test(v); // NTFY_TOPIC=... in a step's text is no secret
  s = s.replace(named, (all, name, sep, value) => ((names.includes(name) || SECRET_NAME.test(name)) && !placeholder(value) ? `${name}${sep}***` : all));
  const homes = [home].flat().filter((h) => h && h.length > 3);
  if (homes.length) {
    const tilde = platform === 'win32' ? '%USERPROFILE%' : '~';
    const forms = [...new Set(homes.flatMap((h) => [h, h.replace(/\\/g, '/')]))].sort((a, b) => b.length - a.length).map(escapeRe).join('|');
    // the home folder itself, not a longer name that starts like it (/home/me, not /home/meadow)
    s = s.replace(new RegExp(`(${forms})(?![A-Za-z0-9_-])`, platform === 'win32' ? 'gi' : 'g'), tilde);
  }
  return s;
}

// Why nothing may leave for the project now, or '': it keeps a persona's password or token and this process can't open
// them to redact with (a secret store that doesn't answer). notify() and a report then send nothing rather than send
// a text that may hold one (docs/design/tester.md §5).
export function personaHold(root) {
  if (!root || !keepsSecrets(root)) return '';
  const r = redactionValues(root);
  return r.problem ? `the tester's sign-ins can't be read to keep them out (${r.problem})` : '';
}

// A setting's ordinary word: under a name that doesn't look secret (NODE_ENV=production, LOG_LEVEL=info) it is no secret,
// and blanking it out of every message would make them unreadable (FR-017)
export const SETTING_WORDS = new Set(['production', 'development', 'staging', 'test', 'local', 'localhost', 'debug', 'info', 'warn', 'warning', 'error']);

// What a phone message must never carry (FR-017): what a report must never contain, for the project at `root` (null
// outside a project: this process's secret-looking variables and the ntfy topic), but a .env value that is a setting's
// ordinary word under a name that doesn't look secret, unless a secret-looking name has the same value (API_TOKEN=
// production is still blanked out). The same serves what the orchestrator reads of a verify command's log (`home`:
// false, the paths as they are).
export function phoneSecrets({ root = null, env = process.env, home = true } = {}) {
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  };
  let real = '';
  try {
    real = fs.realpathSync.native(os.homedir());
  } catch {
    // the home as it is named
  }
  const s = reportSecrets({ root, read, path, env, secrets: [] });
  const dotenv = root ? parseEnvText(read(path.join(root, '.env'))) : {};
  const word = (v) => SETTING_WORDS.has(String(v ?? '').trim().toLowerCase());
  const secretNamed = new Set([...Object.entries(dotenv), ...Object.entries(env || {})].filter(([k]) => SECRET_NAME.test(k) || k === 'NTFY_TOPIC').map(([, v]) => v));
  const values = s.values.filter((v) => !word(v) || secretNamed.has(v));
  const names = s.names.filter((n) => SECRET_NAME.test(n) || !word(dotenv[n]));
  return { values, names, ...(home ? { home: [os.homedir(), real] } : {}), platform: process.platform };
}
