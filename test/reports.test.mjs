// FR-012: long worker reports, result files and the owner's notes, as the orchestrator gets them. On a real project, design
// tasks put their result in the report; `nextlevel result` showed its first 200 lines and said nothing of the rest, and
// the orchestrator sent them back. Stub workers only (test/stubs/team.mjs).
//   npm test
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { OUTPUT_BUDGET, cutSaid, head, kindOf, resultFileOf, resultFileProblem, sizeOf, sizeText, tail } from '../src/lib/reports.mjs';
import { fileExists, makeProject } from './helpers.mjs';

const lines = (text) => text.replace(/\n$/, '').split('\n');
// What the orchestrator gets stays within what its engine shows of one command's output
function withinBudget(out, what) {
  assert.ok(Buffer.byteLength(out) <= OUTPUT_BUDGET.bytes, `${what}: ${Buffer.byteLength(out)} bytes, over ${OUTPUT_BUDGET.bytes}`);
  assert.ok(lines(out).length <= OUTPUT_BUDGET.lines, `${what}: ${lines(out).length} lines, over ${OUTPUT_BUDGET.lines}`);
}
// Every part `nextlevel result <id> [--file] --from <line>` gives, from the first: [the parts' lines], each within budget
function readInParts(p, id, { file = false, first }) {
  const got = [];
  let next = first;
  for (let i = 0; next && i < 100; i++) {
    const r = p.hub(['result', id, ...(file ? ['--file'] : []), '--from', String(next)]);
    assert.equal(r.code, 0, r.out);
    withinBudget(r.out, `part from line ${next}`);
    const all = lines(r.out);
    const [, a, b] = all[0].match(/lines (\d+)-(\d+) of its/) || [];
    assert.equal(Number(a), next, all[0]);
    got.push(...all.slice(1, 1 + Number(b) - Number(a) + 1));
    next = Number((all.at(-1).match(/--from (\d+)\]$/) || [])[1]) || 0;
    if (!next) assert.match(all.at(-1), /^\[the end of the/);
  }
  return got;
}

test('lib/reports: parts that fit, cuts that say so, result files and kinds', () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join('\n');
  assert.deepEqual(sizeOf(`${text}\n`), { lines: 50, bytes: Buffer.byteLength(`${text}\n`) });
  assert.equal(sizeText({ lines: 839, bytes: 48 * 1024 }), '839 lines (48 KB)');
  assert.equal(sizeText({ lines: 1, bytes: 12 }), '1 line (12 bytes)');
  const h = head(text, { lines: 10 });
  assert.deepEqual([h.first, h.last, h.total, h.more], [1, 10, 50, true]);
  assert.equal(head(text, { from: 45, lines: 10 }).text, Array.from({ length: 6 }, (_, i) => `line ${i + 45}`).join('\n'));
  assert.equal(head(text, { from: 45, lines: 10 }).more, false);
  assert.equal(head(text, { bytes: 20 }).last, 2, 'whole lines within the bytes');
  const t = tail(text, { lines: 5 });
  assert.deepEqual([t.first, t.last, t.cut], [46, 50, true]);
  assert.equal(tail('a\nb', { lines: 5 }).cut, false);
  // A single line longer than the room is cut in it, marked
  assert.match(head('x'.repeat(5000), { bytes: 200 }).text, /^x+ … \[this line goes on\]$/);
  assert.ok(Buffer.byteLength(head('é'.repeat(5000), { bytes: 200 }).text) <= 200);
  // The owner's words: whole up to the limit, else cut saying so
  assert.equal(cutSaid('short', 10, 'N1 in docs/OWNER_NOTES.md'), 'short');
  assert.equal(cutSaid('a'.repeat(30), 10, 'N1 in docs/OWNER_NOTES.md'), `${'a'.repeat(9)}… [cut here: 30 characters in all; the whole text: N1 in docs/OWNER_NOTES.md]`);
  // A spec's kind and result file
  assert.equal(kindOf('# x\n\nKind: Design\n'), 'design');
  assert.equal(resultFileOf('Kind: design\nResult file: `docs/design/x.md`\n'), 'docs/design/x.md');
  assert.equal(resultFileOf('Kind: design\n'), '');
  assert.equal(resultFileProblem('docs/design/x.md'), '');
  assert.equal(resultFileProblem('Docs/research/x.md'), '', 'docs/ as Windows reads it');
  assert.equal(resultFileProblem('src/x.md'), 'is not under docs/');
  assert.equal(resultFileProblem('docs/../x.md'), 'leads out of docs/ (..)');
  assert.equal(resultFileProblem('/docs/x.md'), 'is not a path in the project (it must start with docs/)');
  assert.equal(resultFileProblem('C:\\docs\\x.md'), 'is not a path in the project (it must start with docs/)');
  assert.equal(resultFileProblem('docs/design/'), 'is a folder: name one file in it');
  assert.equal(resultFileProblem('docs/*.md'), 'is a pattern: name one file');
  assert.equal(resultFileProblem('docs/agents/DESIGN.md'), 'is protected (a task never writes a protected file)');
  assert.equal(resultFileProblem('docs/x/CLAUDE.md'), 'is protected (a task never writes a protected file)');
});

test('a report far over the limit: kept whole per attempt, shortened for the orchestrator saying so, with its path; nothing lost (FR-012)', () => {
  const p = makeProject();
  const id = 'M12-01-longreport';
  try {
    p.spec(id, fileExists('long.txt'));
    assert.equal(p.hub(['dispatch', id]).code, 0);
    p.runUntilIdle();
    assert.equal(p.status(id).state, 'done');
    // Kept whole: the job folder has the attempt's report, all of it
    const report = fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8');
    assert.equal(fs.readFileSync(p.jobFile(id, 'RESULT.attempt-1.md'), 'utf8'), report, "attempt 1's report, whole, from the moment it ended");
    assert.match(report, /^Line 2000: /m);
    assert.match(report, /END OF THE REPORT\n$/);
    assert.equal(p.status(id).reportFile, 'RESULT.attempt-1.md');
    const total = lines(report).length;
    assert.ok(Buffer.byteLength(report) > 10 * OUTPUT_BUDGET.bytes, 'far over the limit');

    // What the orchestrator gets: within its size, shortened saying so, with the full length and the path
    const r = p.hub(['result', id]);
    assert.equal(r.code, 0, r.out);
    withinBudget(r.out, 'nextlevel result');
    const path1 = /\.nextlevel[\\/]jobs[\\/]M12-01-longreport[\\/]RESULT\.attempt-1\.md/.source;
    const shown = Number((r.out.match(/only lines 1-(\d+) are shown below/) || [])[1]);
    assert.ok(shown > 20, r.out);
    assert.match(r.out, new RegExp(`## Worker report\\nShortened here: this report has ${total} lines \\(\\d+ KB\\), and only lines 1-${shown} are shown below\\. Nothing is lost: all of it is in ${path1}\\. Read the whole report before you judge this task \\(the next part: nextlevel result ${id} --from ${shown + 1}\\)\\.`));
    assert.match(r.out, new RegExp(`\\n\\[\\.\\.\\. the report goes on: lines ${shown + 1}-${total} are not shown here\\. All of it: ${path1} \\(nextlevel result ${id} --from ${shown + 1}\\)\\]`));
    assert.ok(r.out.includes(lines(report).slice(0, shown).join('\n')), 'the lines shown are the report\'s own, in order');
    assert.match(r.out, /## verify\.log\n/, 'the logs still come after the report');
    assert.equal(p.status(id).acked, true);

    // The rest, part by part, each within the size: together with the first part, the whole report
    const rest = readInParts(p, id, { first: shown + 1 });
    assert.deepEqual([...lines(report).slice(0, shown), ...rest], lines(report), 'nothing lost');
    assert.match(p.hub(['result', id, '--from', String(total + 5)]).out, /the report has \d+ lines \(\d+ KB\): nothing from line/);
    assert.notEqual(p.hub(['result', id, '--from', 'x']).code, 0);

    // Attempt 2: its own copy; attempt 1's stays whole, and `result` names it
    assert.equal(p.hub(['retry', id, '--feedback', 'Once more']).code, 0);
    p.runUntilIdle();
    assert.equal(p.status(id).attempt, 2);
    assert.equal(p.status(id).reportFile, 'RESULT.attempt-2.md');
    assert.equal(fs.readFileSync(p.jobFile(id, 'RESULT.attempt-1.md'), 'utf8'), report);
    assert.equal(fs.readFileSync(p.jobFile(id, 'RESULT.attempt-2.md'), 'utf8'), fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8'));
    const again = p.hub(['result', id]).out;
    withinBudget(again, 'nextlevel result, attempt 2');
    assert.match(again, /RESULT\.attempt-2\.md\. Read the whole report/);
    assert.match(again, /Earlier attempts' reports, whole, in \.nextlevel[\\/]jobs[\\/]M12-01-longreport: RESULT\.attempt-1\.md \(2\d{3} lines \(\d+ KB\)\)/);
  } finally {
    p.cleanup();
  }
});

test('design, research and map tasks: the result file named in the spec, committed with the task and checked by the hub (FR-012)', () => {
  const p = makeProject();
  const ok = 'M12-02-resultfile';
  const byHub = 'M12-05-resultfile';
  const none = 'M12-03-noresult';
  const empty = 'M12-04-emptyresult';
  try {
    // Refused: a design task without a result file, or with one outside docs/ or protected
    p.spec('M12-06-design', 'node -e "0"', { kind: 'design' });
    const refused = p.hub(['dispatch', 'M12-06-design']);
    assert.notEqual(refused.code, 0);
    assert.match(refused.out, /M12-06-design\.md is a design task and names no result file, so nothing was dispatched\. .*Add a line "Result file: docs\/<folder>\/M12-06-design\.md" \(for example docs\/design\/M12-06-design\.md\)/);
    for (const [file, why] of [['src/design.md', 'is not under docs/'], ['docs/agents/DESIGN.md', 'is protected'], ['docs/../x.md', 'leads out of docs/']]) {
      p.spec('M12-06-design', 'node -e "0"', { kind: 'research', resultFile: file });
      const r = p.hub(['dispatch', 'M12-06-design']);
      assert.notEqual(r.code, 0, file);
      assert.ok(r.out.includes(`its result file ${file} ${why}`), r.out);
    }
    assert.ok(!fs.existsSync(p.jobFile('M12-06-design', 'status.json')), 'nothing was queued');
    assert.notEqual(p.hub(['dispatch', 'M12-06-design', '--kind', 'essay']).code, 0, 'an unknown --kind');

    p.spec(ok, 'node -e "0"', { kind: 'design', resultFile: `docs/design/${ok}.md` });
    p.spec(byHub, 'node -e "0"', { kind: 'design', resultFile: `docs/design/${byHub}.md` });
    p.spec(none, 'node -e "0"', { kind: 'research', resultFile: `docs/research/${none}.md` });
    p.spec(empty, 'node -e "0"', { kind: 'map', resultFile: `docs/maps/${empty}.md` });
    p.git('add', '-A');
    p.git('commit', '-qm', 'specs');
    const d = p.hub(['dispatch', ok]);
    assert.equal(d.code, 0, d.out);
    assert.match(d.out, /kind design, 1 verify command\(s\)\)\nits result goes in docs\/design\/M12-02-resultfile\.md, committed with the task: the hub's verify checks that it is there and not empty/);
    // On Codex, whose sandbox can't write git, the hub commits the result file with the rest
    assert.equal(p.hub(['dispatch', byHub, '--engine', 'codex']).code, 0);
    p.runUntilIdle();
    assert.equal(p.hub(['dispatch', none]).code, 0);
    assert.equal(p.hub(['dispatch', empty]).code, 0);
    p.runUntilIdle();

    for (const id of [ok, byHub]) {
      const s = p.status(id);
      assert.equal(s.state, 'done', `${id}: ${JSON.stringify(s)}`);
      assert.equal(s.verify, 'pass');
      assert.equal(s.resultFile, `docs/design/${id}.md`);
      assert.match(p.git('show', `task/${id}:docs/design/${id}.md`), /^Design line 1: [\s\S]*END OF THE DESIGN$/, 'committed on the task branch');
      const log = fs.readFileSync(p.jobFile(id, 'verify.log'), 'utf8');
      assert.match(log, new RegExp(`\\$ \\(nextlevel\\) the result file docs/design/${id}\\.md on task/${id}\\ndocs/design/${id}\\.md: 1501 lines \\(\\d+ KB\\)\\n\\[ok\\]`));
      assert.match(fs.readFileSync(p.jobFile(id, 'RESULT.md'), 'utf8'), /^Told where: yes$/m, "TASK.md said where the result goes");
    }
    assert.ok(p.status(byHub).hubCommit, 'the hub committed what the Codex worker left');

    // The orchestrator is pointed at the file, and reads it in parts that fit: all of it
    const r = p.hub(['result', ok]);
    withinBudget(r.out, 'nextlevel result');
    assert.match(r.out, new RegExp(`result file: docs/design/${ok}\\.md on task/${ok}, 1501 lines \\(\\d+ KB\\)\\. It is the task's result: read all of it before you judge the task \\(nextlevel result ${ok} --file shows it in parts that fit\\)\\.`));
    const design = p.git('show', `task/${ok}:docs/design/${ok}.md`);
    assert.deepEqual(readInParts(p, ok, { file: true, first: 1 }), lines(design), 'the whole result file, part by part');
    // Merged and its branch cleaned up: read from the base branch
    p.git('merge', '-q', '--no-ff', `task/${ok}`, '-m', 'merge');
    p.git('branch', '-D', `task/${ok}`);
    assert.match(p.hub(['result', ok, '--file']).out, new RegExp(`^# ${ok}: the result file docs/design/${ok}\\.md, lines 1-\\d+ of its 1501 lines`));

    // No result file, or an empty one: the task fails, and says why
    assert.equal(p.status(none).state, 'failed');
    assert.equal(p.status(none).verify, 'fail');
    assert.equal(p.status(none).detail, `the result file docs/research/${none}.md isn't on task/${none}: the worker didn't write it there, or it wasn't committed`);
    assert.equal(p.status(empty).state, 'failed');
    assert.equal(p.status(empty).detail, `the result file docs/maps/${empty}.md on task/${empty} is empty`);
    assert.match(p.hub(['result', none]).out, /verify fail · worker says DONE · 0 commit\(s\) this attempt, 0 in all · the result file docs\/research\/M12-03-noresult\.md isn't on task/);
    assert.match(p.hub(['result', none]).out, new RegExp(`result file: docs/research/${none}\\.md, not on task/${none}\\n`));
    assert.notEqual(p.hub(['result', 'M12-01-nosuch', '--file']).code, 0);
  } finally {
    p.cleanup();
  }
});

test("the owner's notes and replies reach the orchestrator whole, or cut saying so with the card that has them (FR-012)", () => {
  const p = makeProject();
  try {
    const long = `Use the staging database for every E2E run. ${'Keep the fixtures small and reset them after each run. '.repeat(60)}END OF NOTE`;
    assert.equal(p.hub(['note', 'add', long]).code, 0);
    assert.equal(p.hub(['note', 'add', 'Short rule: keep it short.', '--rule']).code, 0);
    const list = p.hub(['note', 'list']).out;
    assert.ok(long.length > 1500);
    assert.match(list, new RegExp(`N1 +NEW .*Use the staging database for every E2E run\\. Keep the fixtures .*… \\[cut here: ${long.length} characters in all; the whole text: N1 in docs[\\\\/]OWNER_NOTES\\.md\\]`));
    assert.match(list, /N2 +NEW .*Short rule: keep it short\.$/m, 'a short one whole, no mark');
    assert.match(fs.readFileSync(path.join(p.repo, 'docs', 'OWNER_NOTES.md'), 'utf8'), /END OF NOTE/, 'the Markdown file has all of it');
    withinBudget(list, 'nextlevel note list');
    // Handled, it is cut shorter in the history, saying so too
    assert.equal(p.hub(['note', 'done', 'N1', '--reply', 'Done.']).code, 0);
    assert.match(p.hub(['note', 'list', '--all']).out, new RegExp(`N1 +done .*… \\[cut here: ${long.length} characters in all; the whole text: N1 in docs[\\\\/]OWNER_NOTES\\.md\\] -> done: Done\\.`));
    // An owner's long reply to a handoff item: kept whole (it was cut to 400 characters when saved), and since FR-014 the
    // orchestrator reads it whole too (test/handoff.test.mjs has the rest: line breaks, the budget, handoff show)
    assert.equal(p.hub(['handoff', 'add', 'Put the SMTP host in .env', '--where', 'the mail panel', '--why', 'sign-up mails']).code, 0);
    const reply = `The host is in .env now. ${'Port 587 with STARTTLS, and the sender is the support address. '.repeat(30)}END`;
    assert.equal(p.hub(['handoff', 'reply', 'H1', reply]).code, 0);
    const cards = p.hub(['handoff', 'list']).out;
    assert.match(cards, new RegExp(`the owner replied \\([^)]*\\), ${reply.trim().length.toLocaleString('en-US')} characters, whole:\\n {18}> The host is in \\.env now\\. Port 587 .*END\\n`));
    withinBudget(cards, 'nextlevel handoff list');
    assert.ok(fs.readFileSync(path.join(p.repo, 'docs', 'HANDOFF.md'), 'utf8').includes(`    > ${reply.trim()}\n`));
    const tooLong = p.hub(['handoff', 'reply', 'H1', 'y'.repeat(20_001)]);
    assert.notEqual(tooLong.code, 0);
    assert.match(tooLong.out, /the reply has 20,001 characters, more than 20,000: split it into two replies/);
  } finally {
    p.cleanup();
  }
});
