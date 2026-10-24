#!/usr/bin/env node
// A trial install of nextlevel, beside the owner's own, for an owner check before the first real release (safe updates,
// docs/design/safe-updates.md, point 9). Developer tooling: nothing at runtime uses it.
//
//   node scripts/trial.mjs --copy-of <project> [--home <folder>] [--to <folder>]
//
// It makes, and touches nothing else:
//   - a trial home (default %USERPROFILE%\.nextlevel-trial; NEXTLEVEL_HOME for everything run there), never the real
//     ~/.nextlevel: its own state, versions, launcher and command (<home>\bin\nextlevel.cmd, not on PATH);
//   - in it, a local bare repository standing in for GitHub, holding this checkout's HEAD as release v0.1.0 and one
//     commit after it (a line in docs/RELEASES.md) as v0.1.1: annotated tags, never pushed to GitHub (any tag that passes
//     the checks would be a release for every install);
//   - the tool's clone from that repository, with v0.1.0 installed by `nextlevel _install`, as the installer would;
//   - a copy of the project (a fresh clone of it, with its nextlevel.json and .env, its name changed so its slots' Docker
//     stacks are its own): never the project itself, because the guard's records and second accounts live in the
//     owner's ~/.nextlevel, keyed by project folder.
// Then it prints what to type, in which window. The owner's install and the real `nextlevel` command are never touched. One
// thing lands in the owner's ~/.nextlevel: the guard keeps its records there (lib/guard.mjs), in a folder of the copy's
// own, keyed by its folder; the last lines name it, to delete with the trial. The engines' sign-ins stay where they are
// (the trial home is not USERPROFILE), so real engines work in the copy; profiles on a second account use the owner's
// ~/.nextlevel/accounts as usual.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { guardDir } from '../src/lib/guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const fail = (m) => {
  console.error(m);
  process.exit(1);
};
const run = (cmd, a, { cwd, env = process.env } = {}) => {
  const r = spawnSync(cmd, a, { cwd, env, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail(`${cmd} ${a.join(' ')} failed in ${cwd || process.cwd()}:\n${r.stderr || r.stdout || r.error?.message}`);
  return (r.stdout || '').trim();
};
const git = (cwd, ...a) => run('git', a, { cwd });

const source = opt('copy-of');
if (!source || args.includes('--help') || args.includes('-h')) {
  console.log('Usage: node scripts/trial.mjs --copy-of <project folder> [--home <trial home>] [--to <folder for the copy>]');
  process.exit(source ? 0 : 1);
}
const real = path.join(os.homedir(), '.nextlevel');
const home = path.resolve(opt('home') || path.join(os.homedir(), '.nextlevel-trial'));
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
if (same(home, real) || same(path.dirname(home), real)) fail(`${home} is the owner's own nextlevel folder (or inside it): a trial goes in a folder of its own.`);
if (fs.existsSync(home)) fail(`${home} is there already: remove it (or name another with --home) for a fresh trial.`);
const project = path.resolve(source);
if (!fs.existsSync(path.join(project, 'nextlevel.json'))) fail(`${project} has no nextlevel.json: name a project folder.`);
const copy = path.resolve(opt('to') || `${project}-trial-copy`);
if (fs.existsSync(copy)) fail(`${copy} is there already: remove it, or name another with --to.`);

// The stand-in for GitHub: this checkout's HEAD (committed work only) as v0.1.0, and one commit after it as v0.1.1
const work = path.join(home, 'work');
const remote = path.join(home, 'github', 'nextlevel.git');
fs.mkdirSync(path.dirname(remote), { recursive: true });
git(home, 'clone', '-q', '--no-local', REPO, work);
git(work, 'switch', '-q', '-C', 'main');
const tag = (name, notes) => {
  const f = path.join(home, `${name}.txt`);
  fs.writeFileSync(f, `nextlevel ${name}\n\n${notes}\n`);
  git(work, 'tag', '-a', '-F', f, name);
  fs.rmSync(f);
};
tag('v0.1.0', 'New:\n- Releases instead of main (the trial: this pull request).\n\nAfter install:\n- Nothing.');
fs.mkdirSync(path.join(work, 'docs'), { recursive: true });
fs.appendFileSync(path.join(work, 'docs', 'RELEASES.md'), '\n<!-- the trial\'s second release -->\n');
git(work, 'add', '-A');
git(work, '-c', 'user.name=nextlevel trial', '-c', 'user.email=trial@localhost', 'commit', '-qm', 'Trial: a second release');
tag('v0.1.1', 'Fixes:\n- Safety: the trial\'s second release (nothing changes but a line in docs/RELEASES.md).\n\nAfter install:\n- Nothing.');
git(home, 'clone', '-q', '--bare', work, remote);

// The tool's clone, at v0.1.0, and v0.1.0 installed from it
const env = { ...process.env, NEXTLEVEL_HOME: home, NEXTLEVEL_NO_PATH: '1', NEXTLEVEL_RELEASE: 'v0.1.0' };
delete env.NEXTLEVEL_VERSION;
delete env.NEXTLEVEL_LAUNCHED;
const tool = path.join(home, 'tool');
git(home, 'clone', '-q', remote, tool);
git(tool, 'fetch', '-q', '--no-tags', 'origin', '+refs/tags/v*:refs/nextlevel/tags/v*');
git(tool, 'switch', '-q', '--detach', 'refs/nextlevel/tags/v0.1.0^{commit}');
console.log(run(process.execPath, [path.join(tool, 'bin', 'nextlevel.mjs'), '_install'], { cwd: tool, env }));

// The copy of the project
git(path.dirname(copy), 'clone', '-q', project, copy);
for (const f of ['nextlevel.json', '.env']) if (fs.existsSync(path.join(project, f))) fs.copyFileSync(path.join(project, f), path.join(copy, f));
const cfg = JSON.parse(fs.readFileSync(path.join(copy, 'nextlevel.json'), 'utf8'));
cfg.name = `${cfg.name || path.basename(project)}-trial`;
fs.writeFileSync(path.join(copy, 'nextlevel.json'), `${JSON.stringify(cfg, null, 2)}\n`);
// (the copy's own origin, so nothing it pushes reaches the project's GitHub)
const copyRemote = path.join(home, 'project-origin.git');
git(home, 'init', '-q', '--bare', copyRemote);
git(copy, 'remote', 'set-url', 'origin', copyRemote);

const cmd = path.join(home, 'bin', process.platform === 'win32' ? 'nextlevel.cmd' : 'nextlevel');
console.log(`
The trial is ready. Its command (not on PATH): ${cmd}
In PowerShell, in the copy (${copy}):
  & "${cmd}" version          -> nextlevel v0.1.0 (release) in ${path.join(home, 'versions', 'v0.1.0')}
  & "${cmd}" doctor
  & "${cmd}" ui               -> Home shows "Update available: nextlevel v0.1.1", its line marked Safety
  & "${cmd}" update           -> Updated nextlevel: v0.1.0 -> v0.1.1 (stop the copy's hub first)
  & "${cmd}" update --to v0.1.0   -> going back
To remove the trial afterwards: stop the copy's hub and dashboard, then delete ${home}, ${copy} and ${guardDir(copy)} (the guard's records for the copy).`);
