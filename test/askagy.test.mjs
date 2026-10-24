// The assistant on Antigravity (docs/design/antigravity-roles.md, part B): nothing of agy's own keeps it read-only, so it
// answers in a throwaway copy of the project made for each question, as nextlevel's agent, with the push block, only after
// its lock test passed, and a tripwire on the real project. The stub agy (test/stubs/fake-agy.mjs) reads the question from
// the file the prompt names, runs `nextlevel status` (which reads the real project) and answers; STUB_AGY_ASK_WRITE and
// STUB_AGY_ASK_WRITE_REAL make it write in the copy or in the real project.
//   node --test test/askagy.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ASK_PREFIX, projectRelative } from '../src/lib/askcopy.mjs';
import { guardDir } from '../src/lib/guard.mjs';
import { makeProject } from './helpers.mjs';

const AGY = { STUB_AGY_VERSION: '1.4.0' };
function argonAssistant() {
  const p = makeProject();
  p.setConfig((c) => ({ ...c, roles: { ...c.roles, assistant: { engine: 'agy', model: 'gemini-4-argon-low', effort: '', profile: '' } } }));
  p.git('commit', '-qam', 'the assistant on Argon');
  return p;
}
const verdictOf = (p) => JSON.parse(fs.readFileSync(p.state('lock-tests', 'agy-assistant.json'), 'utf8'));
const lockTest = (p, env = {}) => p.hub(['lock-test', '--engine', 'agy', '--role', 'assistant'], { timeout: 600_000, extraEnv: { ...AGY, ...env } });
const ask = (p, q, env = {}) => {
  const r = p.hub(['ask', q, '--json'], { timeout: 300_000, extraEnv: { ...AGY, ...env } });
  return { ...r, json: (() => { try { return JSON.parse(r.out); } catch { return null; } })() };
};
// The copies of this project a question left in the temporary folder (there should be none)
const leftovers = (p) => fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith(ASK_PREFIX) && n.includes(path.basename(p.repo)));
const settings = (p) => {
  try {
    return p.settings();
  } catch {
    return {};
  }
};

test("the assistant's lock test: its pushes from the real project go nowhere, gh and MCP hold, what it changes lands in its copy, note add is refused and status reads the real project", async () => {
  const p = argonAssistant();
  try {
    const r = lockTest(p);
    assert.equal(r.code, 0, r.out);
    const v = verdictOf(p);
    assert.equal(v.verdict, 'pass', r.out);
    assert.deepEqual(Object.fromEntries(v.tries.map((t) => [t.id, t.result])), { 'push-origin': 'pass', 'push-own-url': 'pass', 'push-path': 'pass', gh: 'pass', mcp: 'pass', 'change-by-command': 'pass', 'change-by-edit': 'pass', note: 'pass', status: 'pass' });
    const ev = Object.fromEntries(v.tries.map((t) => [t.id, t.evidence]));
    assert.match(ev['push-own-url'], /nextlevel-no-push-from-the-assistant/, 'a push from the real project, to a remote with a push URL of its own, is refused');
    assert.match(ev['change-by-edit'], /in its copy; the real project is as it was/);
    assert.match(ev.note, /read-only session/);
    assert.match(ev.status, /the real project, only looking/);
    assert.equal(p.git('status', '--porcelain'), '');
  } finally {
    p.cleanup();
  }
});

test('a question to the assistant on Argon: refused until its lock test passes; then answered in a copy that is thrown away, read-only, as nextlevel-assistant, its tokens counted, the real project untouched', async () => {
  const p = argonAssistant();
  try {
    const before = ask(p, 'What is the status?');
    assert.equal(before.code, 1, before.out);
    assert.match(before.json.message, /the assistant doesn't start on Antigravity 1\.4\.0: it hasn't had its lock test yet/);
    assert.match(before.json.message, /nextlevel lock-test --engine agy --role assistant/);
    assert.deepEqual(leftovers(p), [], 'no copy was made');
    assert.equal(lockTest(p).code, 0);
    const head = p.git('rev-parse', 'HEAD');
    const r = ask(p, 'What is the status?', { STUB_AGY_ASK_WRITE: '1' });
    assert.equal(r.code, 0, r.out);
    const a = r.json.answer;
    assert.match(a.text, /you asked "What is the status\?"/, 'it read the question from the file in its copy');
    assert.match(a.text, new RegExp(`the assistant in ${ASK_PREFIX}`), 'it ran in the copy');
    assert.match(a.text, /Hub: /, "its nextlevel status read the real project");
    assert.match(a.text, /Agent: agent nextlevel-assistant: customizations false, mcp false\. Read-only: 1\./);
    assert.deepEqual(a.sources, ['docs/PROJECT.md', 'nextlevel status']);
    assert.equal(a.engine, 'agy');
    assert.equal(typeof a.copySeconds, 'number');
    // its links into the copy (gone after the answer) are paths from the project's top
    assert.ok(a.text.includes(`See [BRIEF.md](BRIEF.md#L3) and docs${path.sep}PLAN.md.`), a.text);
    assert.doesNotMatch(a.text, /file:\/\//);
    assert.deepEqual(leftovers(p), [], 'the copy is gone');
    assert.equal(fs.existsSync(path.join(p.repo, 'written-by-the-assistant.txt')), false, 'what it wrote stayed in its copy');
    assert.equal(p.git('rev-parse', 'HEAD'), head);
    assert.equal(p.git('status', '--porcelain'), '');
    assert.equal(settings(p).askTripwire ?? null, null, 'nothing changed: no card');
    const usage = Object.values(JSON.parse(fs.readFileSync(p.state('usage.json'), 'utf8')))[0];
    assert.equal(usage.by['assistant:agy'].tokens, 2150, "its tokens, from agy's stream-json");
  } finally {
    p.cleanup();
  }
});

test('the tripwire: a write that lands in the real project while the assistant on Argon answers is said in the answer and on Home', async () => {
  const p = argonAssistant();
  try {
    assert.equal(lockTest(p).code, 0);
    const r = ask(p, 'Anything new?', { STUB_AGY_ASK_WRITE_REAL: '1' });
    assert.equal(r.code, 0, r.out);
    assert.match(r.json.answer.text, /While it answered, your project changed: files changed on disk: written-outside-the-copy\.txt/);
    assert.deepEqual(settings(p).askTripwire.changes, ['files changed on disk: written-outside-the-copy.txt']);
    const data = JSON.parse(p.hub(['status', '--json']).out);
    assert.deepEqual(data.askTripwire.changes, ['files changed on disk: written-outside-the-copy.txt']);
  } finally {
    p.cleanup();
  }
});

test("the guard's watch while the assistant on Argon answers: a protected file it changes in the real project is set back and held for the owner", async () => {
  const p = argonAssistant();
  try {
    assert.equal(lockTest(p).code, 0);
    const agents = fs.readFileSync(path.join(p.repo, 'AGENTS.md'), 'utf8');
    const r = ask(p, 'Anything new?', { STUB_AGY_ASK_WRITE_REAL_PROTECTED: '1' });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.json, `--json prints only its answer: ${r.out}`);
    assert.equal(fs.readFileSync(path.join(p.repo, 'AGENTS.md'), 'utf8'), agents, 'set back');
    const f = path.join(guardDir(p.repo, p.env.HOME), 'held.json');
    const held = JSON.parse(fs.readFileSync(f, 'utf8')).items;
    assert.equal(held.length, 1);
    assert.deepEqual(held[0].files.map((x) => x.path), ['AGENTS.md']);
    // the tripwire says it too (it looks before the guard sets it back), and not the guard's own card in HANDOFF.md
    assert.match(r.json.answer.text, /While it answered, your project changed: .*protected files changed: AGENTS\.md/);
    assert.doesNotMatch(r.json.answer.text, /HANDOFF/);
  } finally {
    p.cleanup();
  }
});

test('NEXTLEVEL_READ_ROOT is read only under NEXTLEVEL_READ_ONLY=1, where only the commands that look run', () => {
  const p = makeProject();
  const other = makeProject({ box: p, dir: 'other' });
  try {
    // a card only the other project has: its status shows which project a command read
    fs.mkdirSync(path.join(other.repo, '.nextlevel'), { recursive: true });
    fs.writeFileSync(path.join(other.repo, '.nextlevel', 'card.md'), 'A card only the other project has\nWhere: the dashboard\nWhy: a test\n');
    assert.equal(other.hub(['handoff', 'add', '--file', '.nextlevel/card.md']).code, 0);
    const bin = path.join(process.cwd(), 'bin', 'nextlevel.mjs');
    const run = (args, env) => spawnSync(process.execPath, [bin, ...args], { cwd: p.repo, env: { ...p.env, ...env }, encoding: 'utf8' });
    const plain = run(['status'], { NEXTLEVEL_READ_ROOT: other.repo });
    assert.doesNotMatch(plain.stdout, /A card only the other project has/, 'without NEXTLEVEL_READ_ONLY=1, the project is where it runs');
    const readOnly = run(['status'], { NEXTLEVEL_READ_ROOT: other.repo, NEXTLEVEL_READ_ONLY: '1' });
    assert.match(readOnly.stdout, /A card only the other project has/, readOnly.stdout + readOnly.stderr);
    // and a command that changes something still refuses there
    const note = run(['note', 'add', 'x'], { NEXTLEVEL_READ_ROOT: other.repo, NEXTLEVEL_READ_ONLY: '1' });
    assert.notEqual(note.status, 0);
    assert.match(`${note.stdout}${note.stderr}`, /read-only session/);
  } finally {
    p.cleanup();
  }
});

test("an answer's links into its copy (removed after the answer) and full paths into the project read as paths from the project's top, whatever their form", () => {
  const copy = 'C:\\Users\\User\\AppData\\Local\\Temp\\nextlevel-ask-demo-8ccc1eb2-N0ME1g';
  // agy's own form on demo, 17 October; a full Windows path in another case; the copy itself; a look-alike left as it is
  assert.equal(
    projectRelative(
      'See [BRIEF.md](file:///C:/Users/User/AppData/Local/Temp/nextlevel-ask-demo-8ccc1eb2-N0ME1g/BRIEF.md#L3), ' +
        'c:\\users\\user\\appdata\\local\\temp\\nextlevel-ask-demo-8ccc1eb2-n0me1g\\docs\\PLAN.md, the copy C:/Users/User/AppData/Local/Temp/nextlevel-ask-demo-8ccc1eb2-N0ME1g ' +
        'and C:\\Users\\User\\AppData\\Local\\Temp\\nextlevel-ask-demo-8ccc1eb2-N0ME1gX\\a.md.',
      [copy],
    ),
    'See [BRIEF.md](BRIEF.md#L3), docs\\PLAN.md, the copy . and C:\\Users\\User\\AppData\\Local\\Temp\\nextlevel-ask-demo-8ccc1eb2-N0ME1gX\\a.md.',
  );
  // a POSIX project with a space, as a file URL (%20) and as it is; several roots; nothing to do
  assert.equal(projectRelative('file:///home/me/my%20proj/a.md and /home/me/my proj/b/c.md', ['/tmp/x', '/home/me/my proj']), 'a.md and b/c.md');
  assert.equal(projectRelative('docs/PLAN.md', ['C:\\p']), 'docs/PLAN.md');
  // a Windows short name (GitHub's Windows runner: C:\Users\RUNNER~1), whose ~ Node's pathToFileURL writes as %7E
  assert.equal(
    projectRelative('See [BRIEF.md](file:///C:/Users/RUNNER%7E1/AppData/Local/Temp/nextlevel-ask-p-1/BRIEF.md#L3) and C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nextlevel-ask-p-1\\docs\\PLAN.md', ['C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\nextlevel-ask-p-1']),
    'See [BRIEF.md](BRIEF.md#L3) and docs\\PLAN.md',
  );
  // only where a name starts: macOS's /private/var/... holds the copy's /var/... name, and a web address can hold a path
  assert.equal(projectRelative('/private/var/folders/x/ask-1/BRIEF.md and /var/folders/x/ask-1/a.md', ['/var/folders/x/ask-1', '/private/var/folders/x/ask-1']), 'BRIEF.md and a.md');
  assert.equal(projectRelative('https://example.com/home/me/proj/docs and /mnt/home/me/proj/x', ['/home/me/proj']), 'https://example.com/home/me/proj/docs and /mnt/home/me/proj/x');
  assert.equal(projectRelative('', [undefined, '']), '');
});

test("the dashboard's Ask says how long the assistant's copy of the project took to make", () => {
  const app = fs.readFileSync(new URL('../src/ui/app.js', import.meta.url), 'utf8');
  const header = app.slice(app.indexOf('function askMessage('), app.indexOf("h('div.ask-text'"));
  assert.ok(header.includes('Number.isFinite(m.copySeconds) ? `in a copy made in ${m.copySeconds} s`'), header);
});
