// .env values in commits (the guard): the hub never commits a .env file, or a file that holds a value from the project's
// .env, whatever .gitignore says; it holds such a change with a card, the value redacted (hub.mjs). Pure.
import { visible } from './protect.mjs';

// A .env file itself, at any depth (".env", "apps/web/.env"): never committed
export const isEnvFile = (rel) => String(rel).replace(/\\/g, '/').split('/').pop().toLowerCase() === '.env';

// The values of .env worth looking for: not too short to be a secret (under 8 characters), not a number or a word
// like true, not one .env.example has (it is committed already), not one the committed project already holds
// (`known(value)`: nothing new would leave with it). -> [{ name, value }]
export function secretValues(env, { example = {}, known = () => false, min = 8 } = {}) {
  const inExample = new Set(Object.values(example || {}).filter(Boolean));
  const out = [];
  for (const [name, raw] of Object.entries(env || {})) {
    const value = String(raw ?? '');
    if (value.length < min || /^[\d.,:+-]+$/.test(value) || /^(true|false|yes|no|on|off|null|none|undefined)$/i.test(value)) continue;
    if (inExample.has(value) || known(value)) continue;
    out.push({ name, value });
  }
  // longest first: a value inside a longer one is named after the longer
  return out.sort((a, b) => b.value.length - a.value.length);
}

// The names of the values a text or buffer holds
export function findSecrets(content, values) {
  if (!content || !values.length) return [];
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  return values.filter((v) => buf.includes(Buffer.from(v.value))).map((v) => v.name);
}

// A text with every value replaced by its name, so a card can show the change without the secret (`from`: where a
// value comes from when it isn't .env: the tester's sign-ins, lib/vault.mjs)
export function redactSecrets(text, values) {
  let s = String(text ?? '');
  for (const v of values) s = s.split(v.value).join(`[the value of ${v.name} from ${v.from || '.env'}]`);
  return s;
}

// A file's words for the card: which values it holds, and on which lines (the value itself never)
export function describeSecretFile(rel, content, values) {
  const name = visible(rel);
  if (isEnvFile(rel)) return [`${name}: a .env file: nextlevel never commits one (its values are secrets)`];
  const text = String(content ?? '');
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const v of values) {
    const at = lines.map((l, i) => (l.includes(v.value) ? i + 1 : 0)).filter(Boolean);
    if (at.length) out.push(`${name}: has the value of ${v.name} from ${v.from || '.env'} (line${at.length > 1 ? 's' : ''} ${at.slice(0, 8).join(', ')}${at.length > 8 ? ', ...' : ''})`);
  }
  return out.length ? out : [`${name}: has a value from .env`];
}
