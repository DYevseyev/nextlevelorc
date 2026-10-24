// The files nextlevel and the tools it drives can't run without, and which of them are gone (FR-013). An antivirus
// that quarantines a tool takes files out from under it: on a real PC Bitdefender took nextlevel's own
// bin\nextlevel.mjs, the project's START.cmd, agy's agentapi.bat and pnpm's programs (node_modules\pnpm\pnpm.exe and the
// others) while npm's pnpm.cmd, which runs them, stayed. So a tool's launcher is followed to what it runs. Pure: the
// caller gives exists/read (a check's ctx, or the file system).
import path from 'node:path';

// The files an npm .cmd shim runs, from its own folder: `"%dp0%\node_modules\pnpm\pnpm.exe" %*` (npm's cmd-shim),
// `"%~dp0\node_modules\@openai\codex\bin\codex.js"` (older ones). Node itself ("%_prog%", node.exe) isn't one of them.
export function shimTargets(text, shimFile, p = path.win32) {
  const dir = p.dirname(shimFile);
  const out = [];
  for (const m of String(text || '').matchAll(/"%~?dp0%?\\([^"%]+)"/gi)) {
    const file = p.join(dir, m[1]);
    if (!/[\\/]node(\.exe)?$/i.test(file) && !out.includes(file)) out.push(file);
  }
  return out;
}

// What a program found on this PC (proc.mjs resolveBin: { file, shell }) needs to run: itself and, for a .cmd shim,
// the files it runs.
export function programFiles(bin, { read, path: p = path.win32 } = {}) {
  if (!bin?.file) return [];
  return [bin.file, ...(/\.(cmd|bat)$/i.test(bin.file) ? shimTargets(read(bin.file), bin.file, p) : [])];
}

// A package npm installed globally (in `prefix`, where its shims are): the programs its package.json names ("bin"),
// or null when it isn't installed there.
export function npmPackageFiles(prefix, pkg, { read, exists, path: p = path.win32 }) {
  const dir = p.join(prefix, 'node_modules', ...pkg.split('/'));
  const manifest = p.join(dir, 'package.json');
  let json = null;
  try {
    json = JSON.parse(String(read(manifest) || '').replace(/^﻿/, ''));
  } catch {
    json = null;
  }
  if (!json) return exists(dir) ? { dir, files: [manifest] } : null;
  const bin = typeof json.bin === 'string' ? { [pkg.split('/').pop()]: json.bin } : json.bin || {};
  return { dir, version: json.version || '', files: Object.values(bin).map((f) => p.join(dir, f)) };
}

// nextlevel's own files: what `nextlevel` runs (bin/nextlevel.mjs, then src/cli.mjs and src/hub.mjs, in the version's
// folder since releases), on Windows the command the installer made (~/.nextlevel/bin/nextlevel.cmd, and the one without
// an ending for Git Bash), and the launcher it runs once there are versions (~/.nextlevel/bin/launch.mjs).
// `nlHome`: the nextlevel folder (or `home`, the user's, with .nextlevel in it).
export function nextlevelFiles({ toolRoot, home, nlHome = p.join(home, '.nextlevel'), platform, exists, path: p = path }) {
  const files = [['bin', 'nextlevel.mjs'], ['src', 'cli.mjs'], ['src', 'hub.mjs']].map((parts) => p.join(toolRoot, ...parts));
  const cmdDir = p.join(nlHome, 'bin');
  if (platform === 'win32' && exists(cmdDir)) files.push(p.join(cmdDir, 'nextlevel.cmd'), p.join(cmdDir, 'nextlevel'));
  if (exists(p.join(nlHome, 'versions.json')) && p.dirname(toolRoot) === p.join(nlHome, 'versions')) files.push(p.join(cmdDir, 'launch.mjs'));
  return files;
}

// The files of `list` that aren't there.
export const missingFiles = (list, exists) => [...new Set(list)].filter((f) => f && !exists(f));
