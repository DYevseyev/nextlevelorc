// Daily report: milestones, items waiting on the owner, recent commits, stall check, worker activity.
//
//   nextlevel daily-report              print the report and push it via ntfy
//   nextlevel daily-report --no-send    print only
//   nextlevel daily-report --hours 48   look back further than 24 h
//
// Read-only: it never changes files.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { notify } from './notify.mjs';
import { cardStore } from './lib/cards.mjs';
import { closedSince, closuresOf } from './lib/closures.mjs';
import { ago, getState, isDone } from './lib/state.mjs';

const STALL_HOURS = 12;

// `stateDir` is the hub's state folder (.nextlevel/).
// `phone(text)`: the text as it goes to the phone (the hub's links for .md file names, FR-004 #5); notify() redacts it
// like a report (FR-017).
export async function dailyReport({ root, stateDir, name, paths, server, hours = 24, send = true, quiet = false, phone = (t) => t }) {
  const store = cardStore({ root, stateDir, files: { notes: paths.notes || 'docs/OWNER_NOTES.md', handoff: paths.handoff } });
  const s = getState({ root, statusFile: paths.status, handoffFile: paths.handoff, handoff: () => store.handoff.list(), hours });
  let unseen = 0;
  try {
    unseen = store.news().notes.length;
  } catch {
    // no notes to count
  }
  const stalled = s.idleHours >= STALL_HOURS && s.doneCount < s.milestones.length;

  const lines = [];
  if (stalled) {
    lines.push(`⚠ No activity for ${ago(s.idleHours).replace(' ago', '')} — check the run (asleep? waiting for approval? stopped?)`, '');
  }
  lines.push(
    `Milestones: ${s.doneCount}/${s.milestones.length} done${s.current ? ` · now: ${s.current[0]} (${s.current[1]})` : ''}`,
  );
  for (const [m, state] of s.milestones) lines.push(`  ${isDone(state) ? '✓' : '·'} ${m} — ${state}`);
  lines.push('');
  lines.push(s.waiting.length ? `Waiting on you (${s.waiting.length}):` : 'Waiting on you: nothing');
  for (const item of s.waiting) lines.push(`  - ${item}`);
  if (unseen) lines.push(`Your notes: ${unseen} not seen by the orchestrator yet`);
  if (s.blockers) lines.push('', 'Blockers:', ...s.blockers.split(/\r?\n/).map((l) => `  ${l}`));
  lines.push('', `Last ${hours} h: ${s.commits.length} commit(s)`);
  for (const c of s.commits.slice(0, 10)) lines.push(`  ${c}`);
  if (s.commits.length > 10) lines.push(`  … and ${s.commits.length - 10} more`);
  lines.push(`Last activity: ${ago(s.idleHours)} · uncommitted files: ${s.dirtyFiles}`);

  // Worker activity from the hub (<state>/jobs/*/status.json)
  const jobsDir = path.join(stateDir, 'jobs');
  const readStatus = (id) => {
    try {
      return JSON.parse(readFileSync(path.join(jobsDir, id, 'status.json'), 'utf8'));
    } catch {
      return null;
    }
  };
  const jobs = existsSync(jobsDir) ? readdirSync(jobsDir).map(readStatus).filter((j) => j && j.type === 'task') : [];
  const since = Date.now() - hours * 3_600_000;
  const finished = jobs.filter((j) => j.finishedAt && Date.parse(j.finishedAt) >= since);
  if (jobs.length) {
    const count = (st) => finished.filter((j) => j.state === st).length;
    const running = jobs.filter((j) => ['queued', 'running', 'verifying'].includes(j.state)).length;
    lines.push(
      `Worker tasks, last ${hours} h: ${finished.length} finished (${count('done')} done, ${count('failed') + count('timeout') + count('lost') + count('error')} failed, ${count('blocked')} blocked) · ${running} queued or running now`,
    );
  }
  // Tasks closed with nextlevel close (FR-021): the team won't build them
  let closed = [];
  try {
    closed = closedSince(closuresOf(JSON.parse(readFileSync(path.join(stateDir, 'closed.json'), 'utf8'))), since);
  } catch {
    // none closed yet
  }
  if (closed.length) lines.push(`Tasks closed, last ${hours} h: ${closed.length} (${closed.slice(0, 8).map((c) => c.id).join(', ')}${closed.length > 8 ? ` and ${closed.length - 8} more` : ''})`);

  const report = lines.join('\n');
  const title = stalled
    ? `${name}: run looks stalled`
    : `${name} daily: ${s.doneCount}/${s.milestones.length} milestones${s.waiting.length ? ` · ${s.waiting.length} waiting on you` : ''}`;

  if (!quiet) console.log(`${title}\n\n${report}`);
  if (send) {
    const priority = stalled || s.waiting.length || s.blockers ? 'high' : 'default';
    await notify(phone(title), phone(report), { priority, tags: stalled ? 'warning' : 'bar_chart', server, root });
  }
  return { title, report };
}
