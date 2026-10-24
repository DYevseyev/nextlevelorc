// Tool files that are gone (FR-013): Bitdefender judged an Antigravity worker's behaviour malicious on a real PC,
// stopped the chain and quarantined files of every tool in it: nextlevel's own bin\nextlevel.mjs, the project's
// START.cmd, agy's agentapi.bat, and pnpm's programs while npm's pnpm.cmd, which runs them, stayed. A tool whose files
// are gone fails in ways that say nothing about why, so this check follows each launcher to what it runs.
import { ADAPTERS } from '../engines/index.mjs';
import { INSTALL_COMMAND } from '../lib/install.mjs';
import { missingFiles, nextlevelFiles, npmPackageFiles, programFiles } from '../lib/toolfiles.mjs';
import { fail, pass, step } from './lib.mjs';

const QUARANTINE =
  "Open your antivirus and look at its quarantine (Bitdefender: Protection > Antivirus > Quarantine; its notifications list what it took). Restore these files, then make the one narrow exception docs/ANTIVIRUS.md describes, so it doesn't take them again. Don't turn the antivirus off.";

// The groups of files to look at: [{ what, files, severity, steps }] (only the ones with something missing)
function gone(ctx) {
  const p = ctx.path;
  const win = ctx.platform === 'win32';
  const out = [];
  const add = (what, list, severity, steps = []) => {
    const files = missingFiles(list, ctx.exists);
    if (files.length) out.push({ what, files, severity, steps });
  };
  // nextlevel itself: a clone, so git puts its files back
  add('nextlevel', nextlevelFiles({ toolRoot: ctx.toolRoot, home: ctx.home, nlHome: ctx.nlHome, platform: ctx.platform, exists: ctx.exists, path: p }), 'error', [
    step('terminal', `git -C "${ctx.toolRoot}" checkout -- .`, { text: "puts nextlevel's own files back from its clone (after restoring them from the quarantine fails)" }),
    ...(win ? [step('terminal', INSTALL_COMMAND, { text: 'or run the installer again: it repairs the install' })] : []),
  ]);
  // The project's START.cmd (Windows): committed in the project, so git has it
  if (win && ctx.root && ctx.configInfo?.exists) {
    const file = p.join(ctx.root, 'START.cmd');
    const tracked = ctx.git(['ls-files', '--error-unmatch', 'START.cmd'], { cwd: ctx.root }).ok;
    add('the project', [file], 'warn', [tracked ? step('terminal', 'git checkout -- START.cmd', { cwd: ctx.root, text: 'puts it back from git' }) : step('terminal', 'nextlevel init', { cwd: ctx.root, text: 'writes the missing team files again (it asks before replacing anything)' })]);
  }
  // Each engine the roles use: its program and what its launcher runs; agy's own helper in its folder
  for (const name of [...new Set(ctx.profiles.map((x) => x.engine))]) {
    const a = ADAPTERS[name];
    const bin = ctx.which(a.command);
    const list = bin && p.isAbsolute(bin.file) ? programFiles(bin, { read: ctx.read, path: p }) : [];
    // (not found at all is tool.<engine>'s; a program gone from a folder its own installer made, %LOCALAPPDATA%\agy\bin,
    // is a quarantine's sign. A folder other programs share, like ~/.local/bin, says nothing.)
    if (!bin) {
      for (const parts of a.binPaths?.(ctx.home, ctx.platform) || []) {
        const dir = p.dirname(p.join(...parts));
        if (dir.split(/[\\/]/).includes(name) && ctx.exists(dir)) list.push(p.join(...parts));
      }
    }
    if (name === 'agy' && win && ctx.exists(p.join(ctx.home, '.gemini', 'antigravity-cli', 'bin'))) list.push(p.join(ctx.home, '.gemini', 'antigravity-cli', 'bin', 'agentapi.bat'));
    add(a.title, list, ctx.usage(name) === 'role' ? 'error' : 'warn', [step('terminal', name === 'agy' ? 'agy update' : `nextlevel doctor --fix tool.${name}`, { text: 'or install it again, once the exception is in place' })]);
  }
  // pnpm, which workers run for most JavaScript projects: npm's shims and the programs its package names
  const prefix = win && ctx.env.APPDATA ? p.join(ctx.env.APPDATA, 'npm') : '';
  const pnpm = prefix && npmPackageFiles(prefix, 'pnpm', { read: ctx.read, exists: ctx.exists, path: p });
  const shim = prefix && p.join(prefix, 'pnpm.cmd');
  if (pnpm || (shim && ctx.exists(shim))) {
    const shimFiles = shim && ctx.exists(shim) ? programFiles({ file: shim }, { read: ctx.read, path: p }) : [];
    add('pnpm', [...(pnpm?.files || []), ...shimFiles, ...(pnpm ? [shim] : [])], 'warn', [step('terminal', 'npm install -g pnpm', { text: 'installs it again, once the exception is in place' })]);
  }
  return out;
}

export const toolFilesCheck = {
  id: 'tool.files',
  title: 'Tool files',
  severity: 'error',
  learnMore: 'docs/CHECKS.md#toolfiles',
  run(ctx) {
    const found = gone(ctx);
    if (!found.length) return pass('none missing', { quiet: true });
    const detail = found.map((g) => `${g.what}: ${g.files.map((f) => ctx.path.basename(f)).join(', ')}`).join('; ');
    return fail(`${detail} ${found.reduce((n, g) => n + g.files.length, 0) === 1 ? 'is' : 'are'} missing: an antivirus may have quarantined ${found.length === 1 && found[0].files.length === 1 ? 'it' : 'them'}`, {
      severity: found.some((g) => g.severity === 'error') ? 'error' : 'warn',
      next: 'restore them from the antivirus\'s quarantine, then add the narrow exception (docs/ANTIVIRUS.md)',
      files: found.flatMap((g) => g.files),
      steps: [step('app', null, { text: QUARANTINE }), ...found.flatMap((g) => g.steps)],
    });
  },
};
