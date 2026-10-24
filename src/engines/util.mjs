// Small helpers the engine adapters share. Apart from index.mjs, which imports the adapters: an adapter that
// imported index.mjs would be read before it is ready.
import path from 'node:path';

// A named account's folder for the engine's CLI: ~/.nextlevel/accounts/<engine>/<account>.
export const accountDir = (home, engineName, account, p = path) => p.join(home, '.nextlevel', 'accounts', engineName, account);

// `args` without an option and its value (--effort high): a role's own effort replaces the one in engines.<name>.args.
export function withoutOption(args, name) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) i++;
    else if (!args[i].startsWith(`${name}=`)) out.push(args[i]);
  }
  return out;
}

// A JSON file's object, or null.
export function readJsonText(text) {
  try {
    const v = JSON.parse(String(text ?? '').replace(/^\uFEFF/, ''));
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}


// The last JSON object in what a program printed that has `key` (a run's result with its token usage, printed
// once at the end), or null. Lines before it may be anything.
export function lastJsonWith(text, key) {
  const t = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
  const lines = t.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line.startsWith('{')) continue;
    // one line, or a pretty-printed object that starts here and runs to the end
    for (const candidate of [line, lines.slice(i).join('\n')]) {
      const v = readJsonText(candidate);
      if (v && Object.hasOwn(v, key)) return v;
    }
  }
  return null;
}

// A count from a usage object: a number, else 0.
export const count = (v) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : 0);

// ---------- the technical feed (what a headless run did: commands, edits, test results) ----------
// An engine that prints its steps as JSON (Claude Code's stream-json, `codex exec --json`) has a feed(text, { cwd })
// in its adapter, built from these. An event: { kind, text, detail, ok }: kind 'command' | 'test' | 'edit' |
// 'tool' | 'message' | 'error' | 'done'; `detail` one line of what came of it; `ok` true, false or undefined.

// One line of what a program printed, as JSON, or null. Lines that aren't JSON (a stub's, a warning) are skipped.
export function jsonLine(line) {
  const t = String(line || '').trim();
  if (!t.startsWith('{') || !t.endsWith('}')) return null;
  try {
    const v = JSON.parse(t);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// A text on one line, at most `n` characters.
export const oneLine = (s, n = 200) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// The last lines a run printed, as a person reads them (the engine's readable form when it has one), at most `max`, each cut
// at 300 characters: what an engine's end shows of a run (FR-020, after FR-022's for agy). Not redacted.
export function lastLines(shown, max = 20) {
  return String(shown || '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim())
    .slice(-max)
    .map((l) => (l.length > 300 ? `${l.slice(0, 299)}…` : l));
}

// A command that runs a project's tests (npm test, node --test, pytest, go test...): its result is a test result.
const TEST_RE = /(^|[\s;&|(])((npm|pnpm|yarn|bun)( run)? (test|t)\b|npx (jest|vitest|mocha|playwright)|node --test|(jest|vitest|mocha|pytest|phpunit|rspec|ctest)\b|go test|cargo test|dotnet test|gradlew? test|mvn test|python -m (pytest|unittest))/;
export const isTestCommand = (cmd) => TEST_RE.test(String(cmd || ''));

// What a test run's output says in one line ("12 passed, 1 failed"), from the summary lines of the common test
// runners (node --test, Jest, Vitest, Mocha, pytest, cargo, go); '' when none is there.
export function testSummary(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*m/g, '');
  const tap = { pass: text.match(/^#\s*pass\s+(\d+)/im)?.[1], fail: text.match(/^#\s*fail\s+(\d+)/im)?.[1] };
  if (tap.pass !== undefined) return `${tap.pass} passed, ${tap.fail ?? 0} failed`;
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const summary = [...lines].reverse().find((l) => /\b\d+\s+(passed|passing|failed|failing|errors?)\b/i.test(l) || /^test result:/i.test(l));
  if (summary) return oneLine(summary.replace(/^[=\s]+|[=\s]+$/g, ''), 120);
  const go = [...lines].reverse().find((l) => /^(ok|FAIL|PASS)\s/.test(l));
  return go ? oneLine(go, 120) : '';
}

// The last line a command printed, for its result in the feed.
export function lastOutputLine(output) {
  const lines = String(output || '').replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.length ? oneLine(lines.at(-1), 160) : '';
}

// What came of a command: a test summary for a test run, else its last line; `ok` from its exit.
export function commandOutcome(event, output, ok) {
  const e = event;
  e.ok = ok;
  if (e.kind === 'test') e.detail = testSummary(output) || (ok === false ? `failed${lastOutputLine(output) ? `: ${lastOutputLine(output)}` : ''}` : lastOutputLine(output));
  else e.detail = ok === false ? `failed${lastOutputLine(output) ? `: ${lastOutputLine(output)}` : ''}` : lastOutputLine(output);
  return e;
}
export const commandEvent = (cmd) => ({ kind: isTestCommand(cmd) ? 'test' : 'command', text: oneLine(cmd, 240), detail: '', ok: undefined });

// A file's path from the slot's folder ("src/app.js"), or as it was when it is elsewhere.
export function inFolder(file, cwd) {
  const f = String(file || '').replace(/\\/g, '/');
  const base = String(cwd || '').replace(/\\/g, '/').replace(/\/+$/, '');
  if (base && (f === base || f.toLowerCase().startsWith(`${base.toLowerCase()}/`))) return f.slice(base.length + 1) || '.';
  return f;
}
