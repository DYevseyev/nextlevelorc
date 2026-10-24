// Shared, read-only view of the run's state, used by daily-report.mjs and hub.mjs.
// Sources: the project's status file (milestone table + "## Blockers"), its handoff items (the cards,
// lib/cards.mjs, through `handoff()`; else the handoff file's "- [ ]" items) and git. Paths come from
// nextlevel.json (paths.status, paths.handoff).
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readEnv } from './gitlock.mjs';

export const isDone = (state) => /^(done|complete|completed|passed)/i.test(state);

// The milestone table of a status file: [name, state, verified] per row (the header and separator rows left out).
export const statusMilestones = (status) =>
  String(status || '')
    .split(/\r?\n/)
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split('|').slice(1, -1).map((c) => c.trim()))
    .filter((cells) => cells.length >= 2 && !/^-+$/.test(cells[0].replace(/[:\s]/g, '')) && !/^milestone$/i.test(cells[0]));

export function getState({ root, statusFile = 'docs/STATUS.md', handoffFile = 'docs/HANDOFF.md', handoff = null, hours = 24 }) {
  // Only reads, so without git's optional locks: it never holds index.lock while the hub commits (lib/gitlock.mjs)
  const git = (...a) => {
    try {
      return execFileSync('git', a, { cwd: root, env: readEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim();
    } catch {
      return '';
    }
  };
  const read = (rel) => {
    const file = path.join(root, rel);
    return existsSync(file) ? readFileSync(file, 'utf8') : '';
  };
  const status = read(statusFile).replace(/\r\n?/g, '\n'); // (a file saved on Windows has CRLF line ends)
  const milestones = statusMilestones(status);
  const doneCount = milestones.filter((m) => isDone(m[1])).length;
  const current = milestones.find((m) => !isDone(m[1])) || null;

  const blockersMatch = status.match(/##\s*Blockers\s*\n([\s\S]*?)(\n##\s|$)/i);
  // (without the template's comment on how to write them)
  const blockersText = blockersMatch ? blockersMatch[1].replace(/<!--[\s\S]*?(?:-->|$)/g, '').trim() : '';
  const blockers = blockersText && !/^none\.?$/i.test(blockersText) ? blockersText : '';

  let waiting = null;
  try {
    waiting = handoff ? handoff().filter((x) => x.status === 'open').map((x) => x.what.split('\n')[0].trim()) : null;
  } catch {
    // the file's items, below
  }
  waiting ??= read(handoffFile)
    .split(/\r?\n/)
    .filter((l) => /^\s*[-*]\s*\[ \]/.test(l))
    .map((l) => l.replace(/^\s*[-*]\s*\[ \]\s*/, '').replace(/^\*\*H\d+\*\*\s*/, '').trim())
    .filter((t) => t && !/^\(none/i.test(t));

  const commits = git('log', `--since=${hours} hours ago`, '--pretty=format:%h %s').split('\n').filter(Boolean);
  const lastCommitAt = Number(git('log', '-1', '--format=%ct')) * 1000 || 0;

  // Most recent edit among uncommitted files (tracked or untracked, respecting .gitignore)
  let lastEditAt = 0;
  let dirtyFiles = 0;
  const porcelain = git('status', '--porcelain', '-z', '-uall').split('\0').filter(Boolean);
  for (let i = 0; i < porcelain.length; i++) {
    const entry = porcelain[i];
    const code = entry.slice(0, 2);
    const file = entry.slice(3);
    if (code.includes('R') || code.includes('C')) i++; // skip the original path of a rename/copy
    dirtyFiles++;
    try {
      lastEditAt = Math.max(lastEditAt, statSync(path.join(root, file)).mtimeMs);
    } catch {
      // deleted file
    }
  }
  const lastActivity = Math.max(lastCommitAt, lastEditAt);
  const idleHours = lastActivity ? (Date.now() - lastActivity) / 3_600_000 : Infinity;

  return { milestones, doneCount, current, blockers, waiting, commits, dirtyFiles, lastActivity, idleHours, hours };
}

export const ago = (h) => (h === Infinity ? 'never' : h < 1 ? `${Math.round(h * 60)} min ago` : `${h.toFixed(1)} h ago`);
