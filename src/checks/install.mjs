// nextlevel's own install: the nextlevel command runs this copy, and this copy updates to releases (safe updates).
import { INSTALL_COMMAND } from '../lib/install.mjs';
import { describeState, toolState } from '../lib/update.mjs';
import { fail, firstLine, pass, step } from './lib.mjs';

// How to make (or repair) the command: the installer on Windows, the tool's own _install elsewhere.
function installSteps(ctx) {
  const make =
    ctx.platform === 'win32'
      ? step('terminal', INSTALL_COMMAND, { text: 'the installer: running it again repairs the install' })
      : step('terminal', `node "${ctx.path.join(ctx.toolRoot, 'bin', 'nextlevel.mjs')}" _install`, { text: 'makes the nextlevel command in ~/.nextlevel/bin' });
  return [make, step('new-terminal', 'nextlevel version', { text: 'to check it' })];
}
const mentions = (ctx, text, folder) => (ctx.platform === 'win32' ? text.toLowerCase().includes(folder.toLowerCase()) : text.includes(folder));

export const commandCheck = {
  id: 'install.command',
  title: 'nextlevel command',
  severity: 'warn',
  learnMore: 'docs/CHECKS.md#installcommand',
  run(ctx) {
    const found = ctx.which('nextlevel');
    if (!found) {
      const next = ctx.platform === 'win32' ? "START.cmd still finds the tool; typing nextlevel in PowerShell doesn't" : '';
      return fail('not found in this window', { missing: true, next, steps: installSteps(ctx) });
    }
    const r = ctx.run('nextlevel', ['version']);
    if (!r.ok) return fail(`"nextlevel version" fails: ${firstLine(r.out) || `exit ${r.code}`}`, { steps: installSteps(ctx) });
    if (!mentions(ctx, r.out, ctx.toolRoot)) {
      return fail(`runs another copy: ${firstLine(r.out)}`, {
        next: `this one is ${ctx.toolRoot}`,
        steps: [
          ctx.platform === 'win32'
            ? step('terminal', 'Get-Command nextlevel -All', { text: 'lists every nextlevel command; the first one runs. Remove the others' })
            : step('terminal', 'which -a nextlevel', { text: 'lists every nextlevel command; the first one runs. Remove the others' }),
          ...installSteps(ctx),
        ],
      });
    }
    return pass(found.file);
  },
  fixPrompt: 'Make the nextlevel command for this PC now?',
  canFix: (r) => !!r.missing,
  fix(ctx, ui) {
    ui.run(process.execPath, [ctx.path.join(ctx.toolRoot, 'bin', 'nextlevel.mjs'), '_install']);
    ui.say('Windows opened from now on have the nextlevel command: if it shows as not found below, open a new window and run nextlevel doctor there.');
  },
};

// What the nextlevel folder says (versions.json, channels.json, update/available.json), read through the check's ctx
const readIn = (ctx, ...parts) => {
  try {
    return JSON.parse(ctx.read(ctx.path.join(ctx.nlHome, ...parts)) || 'null');
  } catch {
    return null;
  }
};
// The version this copy is, when it runs from a version's folder (safe updates): its name, else ''
function versionName(ctx) {
  const dir = ctx.path.dirname(ctx.toolRoot);
  const want = ctx.path.join(ctx.nlHome, 'versions');
  const same = ctx.platform === 'win32' ? dir.toLowerCase() === want.toLowerCase() : dir === want;
  return same ? ctx.path.basename(ctx.toolRoot) : '';
}
const projectKeyIn = (ctx, root) => (ctx.platform === 'win32' ? ctx.path.resolve(root).toLowerCase() : ctx.path.resolve(root));
function channelIn(ctx) {
  const c = ctx.root ? readIn(ctx, 'channels.json')?.projects?.[projectKeyIn(ctx, ctx.root)] : null;
  return c && ['pin', 'candidate'].includes(c.channel) ? c : { channel: 'release' };
}
const day = (iso) => String(iso || '').slice(0, 10);

export const updatesCheck = {
  id: 'install.updates',
  title: 'nextlevel updates',
  severity: 'warn',
  requires: ['tool.git'],
  learnMore: 'docs/CHECKS.md#installupdates',
  run(ctx) {
    const tool = ctx.toolRoot;
    const s = toolState((args) => ctx.git(args, { cwd: tool }), { clone: ctx.exists(ctx.path.join(tool, '.git')) });
    if (!s.clone) return fail(`${tool} isn't a git clone, so nextlevel can't update itself`, { steps: installSteps(ctx).slice(0, 1) });
    const name = versionName(ctx);
    const avail = readIn(ctx, 'update', 'available.json');
    if (name) {
      // A release (or a candidate) in its own folder: nothing may change in it
      if (s.changed.length) {
        return fail(`${s.changed.length} file(s) in ${name}'s folder were changed by hand: ${s.changed.slice(0, 3).join(', ')}. A version's folder is never changed, so its files are what was released`, {
          steps: [step('terminal', `git -C "${tool}" stash`, { text: 'puts the changes aside; git stash pop brings them back' }), ...installSteps(ctx).slice(0, 1)],
        });
      }
      const problems = [...(avail?.refused || []).filter((r) => /changed on GitHub/.test(r.why)).map((r) => r.why), ...(avail?.vanished || []).map((n) => `${n} was published and is gone from GitHub now`)];
      if (avail && avail.ok === false) return fail(`the last look for releases failed (${day(avail.at)}): ${avail.detail}`, { steps: [step('terminal', 'nextlevel update', { text: 'looks again (it updates only when a release is newer)' })] });
      if (problems.length) return fail(`${problems.join('; ')}: nextlevel doesn't follow such a tag. Tell nextlevel's developers`, { next: `you run ${name}` });
      const c = channelIn(ctx);
      if (c.channel === 'pin') return fail(`this project is pinned at ${c.ref}: it stays there`, { severity: 'info', steps: [step('terminal', 'nextlevel channel release', { cwd: ctx.root, text: 'follows releases again' })] });
      if (c.channel === 'candidate') return pass(`${name}, the candidate ${c.ref}${avail?.at ? `, checked ${day(avail.at)}` : ''}`);
      const next = avail?.newer?.[0];
      if (next) {
        const safety = !!next.notes?.safety;
        return fail(`nextlevel ${next.name} is available${safety ? ', with a safety fix' : ''} (you run ${name})`, {
          severity: safety ? 'warn' : 'info',
          next: "Update on the dashboard's Home, or in PowerShell when no hub or worker runs",
          steps: [step('terminal', 'nextlevel update', { text: 'when no hub or worker runs: the new version goes in a folder of its own' })],
        });
      }
      return pass(`${name}, the newest release${avail?.at ? `, checked ${day(avail.at)}` : ''}`);
    }
    // An install from before releases: the clone's own checkout runs
    if (s.changed.length) {
      return fail(`${s.changed.length} file(s) in the tool's folder were changed by hand, so it doesn't update: ${s.changed.slice(0, 3).join(', ')}`, {
        steps: [step('terminal', `git -C "${tool}" stash`, { text: 'puts the changes aside; git stash pop brings them back' }), step('terminal', 'nextlevel update')],
      });
    }
    if (avail?.newest) {
      return fail(`nextlevel ${avail.newest.name} is released, and this nextlevel is from before releases (${describeState(s)})`, {
        next: 'the installer moves it to releases (when no hub or worker runs); from then on updates are one step',
        steps: installSteps(ctx).slice(0, 1),
      });
    }
    if (!s.branch) return fail(`${describeState(s)}: it stays there until the installer moves it to the first release`, { severity: 'info' });
    const main = s.defaultBranch;
    if (s.branch !== main) {
      return fail(`follows the branch ${s.branch}, not ${main}`, {
        next: s.upstream ? 'fine while you try that branch out' : "that branch isn't on GitHub (any more), so no updates arrive",
        severity: s.upstream ? 'info' : 'warn',
        steps: installSteps(ctx).slice(0, 1),
      });
    }
    if (s.ahead) {
      return fail(`${main} has ${s.ahead} commit(s) that ${s.upstream || `origin/${main}`} doesn't`, {
        steps: [step('terminal', `git -C "${tool}" log ${s.upstream || `origin/${main}`}..${main}`, { text: 'shows them' })],
      });
    }
    const last = ctx.userState.get('update');
    if (last && !last.ok) return fail(`the last look for releases failed (${day(last.at)}): ${last.detail}`, { steps: [step('terminal', 'nextlevel update')] });
    return pass(`${describeState(s)}; no release is published yet${last?.at ? `, checked ${day(last.at)}` : ''}`);
  },
};

// What this project runs (safe updates): releases, a pinned release, or a candidate branch that runs whatever sessions
// push to it. Kept in the nextlevel folder (channels.json), outside the project.
export const channelCheck = {
  id: 'install.channel',
  title: 'nextlevel channel',
  severity: 'info',
  learnMore: 'docs/CHECKS.md#installchannel',
  skipIf: (ctx) => (!ctx.root ? 'needs a project' : !readIn(ctx, 'versions.json')?.release && 'comes with releases'),
  run(ctx) {
    const c = channelIn(ctx);
    if (c.channel === 'release') return pass(`releases (${readIn(ctx, 'versions.json')?.release})`, { quiet: true });
    if (c.channel === 'pin') return fail(`pinned at ${c.ref}`, { severity: 'info', next: 'it stays there: updates leave this project alone', steps: [step('terminal', 'nextlevel channel release', { cwd: ctx.root })] });
    let autopilot = false;
    try {
      autopilot = !!JSON.parse(ctx.read(ctx.path.join(ctx.stateDir || ctx.path.join(ctx.root, '.nextlevel'), 'settings.json')) || '{}').autopilot;
    } catch {
      // off
    }
    return fail(`the candidate ${c.ref} (${c.version}): it runs whatever sessions push to ${c.ref}, once you update`, {
      severity: autopilot ? 'warn' : 'info',
      next: autopilot ? 'autopilot is on here: a candidate is for trying a change (a test project), not for a project whose work matters' : 'for trying a change before its release',
      steps: [step('terminal', 'nextlevel channel release', { cwd: ctx.root, text: 'follows releases again' })],
    });
  },
};
