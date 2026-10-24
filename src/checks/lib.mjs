// Small helpers shared by the checks: results, steps with the window to type them in, versions.

// Where the owner types or clicks a step (FR-001 #8: a Claude Code slash command was typed into
// PowerShell). Every step names one of these; the doctor and the dashboard print the label.
export const WINDOWS = {
  terminal: { win32: 'PowerShell', other: 'Terminal' },
  'new-terminal': { win32: 'A new PowerShell window', other: 'A new terminal' },
  browser: 'Browser',
  editor: 'Text editor',
  app: { win32: 'Start menu', other: 'Applications' },
  phone: 'Your phone',
  codex: 'Inside Codex',
  agy: 'Inside Antigravity (agy)',
  claude: 'Inside Claude Code',
};
export function windowLabel(window, platform) {
  const w = WINDOWS[window];
  if (!w) throw new Error(`unknown window "${window}"`);
  return typeof w === 'string' ? w : platform === 'win32' ? w.win32 : w.other;
}

// A step for the owner: something to type (`command`, copyable) or to do (`text`), and where.
export const step = (window, command, { cwd, text } = {}) => ({ window, ...(command ? { command } : {}), ...(text ? { text } : {}), ...(cwd ? { cwd } : {}) });
export const inProject = (ctx, command) => step('terminal', command, { cwd: ctx.root || undefined });

export const pass = (detail, extra = {}) => ({ ok: true, detail, ...extra });
export const fail = (detail, extra = {}) => ({ ok: false, detail, ...extra });

// "codex-cli 0.152.0", "git version 2.55.0.windows.3", "1.2.4 (stub)" -> [major, minor, patch]
export function parseVersion(text) {
  const m = String(text || '').match(/(\d+)\.(\d+)(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] || 0)] : null;
}
export function versionAtLeast(have, min) {
  const a = Array.isArray(have) ? have : parseVersion(have);
  const b = Array.isArray(min) ? min : parseVersion(min);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}
export const versionText = (v) => (v ? v.join('.') : '?');
export const firstLine = (s) => String(s || '').split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';

// Secrets never leave a check: token shapes (OpenAI, GitHub, Google, Slack, Anthropic keys), a login in
// a URL, and every value of the project's .env (ctx.secrets) are replaced with ***.
const TOKEN_RE = /\b(sk-(?:ant-|proj-)?[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AIza[A-Za-z0-9_-]{20,}|xox[abprs]-[A-Za-z0-9-]{10,})/g;
// The .env values go first, longest first: a value with a login or token in it would no longer be found
// once the patterns had changed part of it.
export function redact(text, secrets = []) {
  let s = String(text ?? '');
  for (const v of [...secrets].filter((x) => x && x.length >= 6).sort((a, b) => b.length - a.length)) s = s.split(v).join('***');
  return s.replace(TOKEN_RE, '***').replace(/(\/\/)[^/@\s]+@/g, '$1***@');
}

// Is `child` the folder `parent` or inside it (case-insensitive on Windows)?
export function isUnder(ctx, child, parent) {
  if (!child || !parent) return false;
  const p = ctx.path;
  const norm = (x) => (ctx.platform === 'win32' ? p.resolve(x).toLowerCase() : p.resolve(x));
  const r = p.relative(norm(parent), norm(child));
  return r === '' || (!r.startsWith('..') && !p.isAbsolute(r));
}

// A top-level `key = "value"` of a TOML text (before its first table), or null: Codex's config.toml.
export function tomlTop(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break;
    const m = line.match(new RegExp(`^${escaped}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')`));
    if (m) return m[1] !== undefined ? m[1].replace(/\\(["\\])/g, '$1') : m[2];
  }
  return null;
}
