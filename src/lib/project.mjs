// Which project a command works on: the git root of the current folder, or of --project <path>.
// The tool lives in its own folder; a project gets only nextlevel.json, the templates and .nextlevel/.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readEnv } from './gitlock.mjs';

export const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const IS_WIN = process.platform === 'win32';
// The real path: Windows short names (C:\Users\RUNNER~1) and symlinked folders compare equal to the long form.
const real = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
};
const same = (a, b) => (IS_WIN ? real(a).toLowerCase() === real(b).toLowerCase() : real(a) === real(b));
const inside = (child, parent) => {
  const r = path.relative(parent, child);
  return r !== '' && !r.startsWith('..') && !path.isAbsolute(r);
};

// Only reads, so without git's optional locks (gitlock.mjs)
function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, env: readEnv(), encoding: 'utf8', windowsHide: true });
  return { ok: r.status === 0, missing: r.error?.code === 'ENOENT', out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// Child folders that are git repositories: likely what the user meant when they ran us one level too high.
function childRepos(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, '.git')))
      .map((e) => path.join(dir, e.name))
      .slice(0, 5);
  } catch {
    return [];
  }
}

function notARepo(start, gitErr) {
  const lines = ['nextlevel works on a project that is a git repository, and this folder is not inside one:', `  ${start}`];
  if (gitErr && !/not a git repository/i.test(gitErr)) lines.push(`(git says: ${gitErr.split('\n')[0]})`);
  const kids = childRepos(start);
  if (kids.length) {
    lines.push('', 'These folders inside it are projects. To use one, type in PowerShell:');
    for (const k of kids) lines.push(`  cd "${k}"`);
  }
  lines.push(
    '',
    'Fix, in PowerShell:',
    '  - go to your project\'s folder first:     cd "C:\\path\\to\\your\\project"',
    '  - or start a new project in this folder:  git init -b main    then    nextlevel init',
    'You can also name the project folder:        nextlevel --project "C:\\path\\to\\your\\project" <command>',
  );
  return lines.join('\n');
}

// Returns { ok: true, root } or { ok: false, message } with the exact fix.
export function findProject({ cwd = process.cwd(), project } = {}) {
  const start = path.resolve(cwd, project || '.');
  if (!fs.existsSync(start) || !fs.statSync(start).isDirectory()) {
    return { ok: false, message: `Project folder not found: ${start}\nCheck the path after --project, or cd into the project folder and leave --project out.` };
  }
  const top = git(['rev-parse', '--show-toplevel'], start);
  if (top.missing) {
    return {
      ok: false,
      message: 'Git is not installed, or this window can\'t find it.\nFix, in PowerShell: winget install -e --id Git.Git\nThen close this window, open a new PowerShell window and try again.',
    };
  }
  if (!top.ok || !top.out) return { ok: false, message: notARepo(start, top.err) };
  const root = real(top.out);

  // A worker slot is a git worktree of the project; nextlevel must not treat it as a project of its own.
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], root);
  if (common.ok && path.basename(common.out) === '.git') {
    const main = real(path.dirname(common.out));
    if (!same(main, root) && inside(root, `${main}.slots`)) {
      return { ok: false, message: `This folder is a worker slot of the project at\n  ${main}\nRun nextlevel from that folder instead: cd "${main}"` };
    }
  }
  if (same(root, TOOL_ROOT)) {
    return {
      ok: false,
      message: `This is the nextlevel tool's own folder:\n  ${root}\nRun nextlevel in your project's folder (cd "C:\\path\\to\\your\\project"), or use --project "<path>".`,
    };
  }
  return { ok: true, root };
}

// A repository with no commits yet (FR-001 #2): workers can't get a copy of it and the branch shows as "(none)".
export function hasCommits(root) {
  return git(['rev-parse', '--verify', '--quiet', 'HEAD'], root).ok;
}
export const NO_COMMITS_FIX = (root) =>
  [
    'This repository has no commits yet, so workers can\'t get their own copy of it.',
    `Fix, in PowerShell in ${root}:`,
    '  git add -A',
    '  git commit -m "first commit"',
    '(If git asks who you are, set it once: git config --global user.name "Your Name" and git config --global user.email "you@example.com".)',
  ].join('\n');
