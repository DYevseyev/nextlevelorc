// A .env file's variables, read without touching process.env (notify.mjs loads them; the redaction of reports and phone
// messages, lib/redact.mjs, looks for their values).
import { existsSync, readFileSync } from 'node:fs';

export function parseEnvFile(file) {
  return existsSync(file) ? parseEnvText(readFileSync(file, 'utf8')) : {};
}
export function parseEnvText(text) {
  const vars = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    vars[match[1]] = value;
  }
  return vars;
}
