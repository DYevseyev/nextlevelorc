// The tester's browser (docs/design/tester.md §6, part 2): Playwright at one pinned version, installed by the owner into
// ~/.nextlevel/tools/ (never the project's node_modules, which a worker writes, and never npx at run time), from a lock
// file nextlevel ships with the package's integrity hash and with no install scripts, then its headless Chromium with
// Playwright's own installer from that folder. The install records every file's hash; a run and the doctor compare them
// before the browser starts, so an ordinary change (an update, a half-finished install, a planted file) is caught. An
// agent running as the owner can write this folder as easily as any other (docs/KNOWN_ISSUES.md): the record catches a
// change, it is no wall.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { homeDir } from './home.mjs';
import { resolveBin, spawnBin } from './proc.mjs';

export const PLAYWRIGHT = {
  version: '1.63.0',
  integrity: 'sha512-rYCsBF/M5HjUch52bbtVONEFjv6Xu8sm8h72dNlR5bzIE1fvC/bxgspzkjSfU+MweEMmPM8KJebG6nnyxo5mCg==',
  browser: 'chromium-headless-shell',
  // (what the owner is told before the install: Playwright's own figures for its headless shell, rounded up)
  download: 'about 120 MB',
  disk: 'about 300 MB',
};
export const toolsDir = (home = homeDir()) => path.join(home, 'tools');
export const playwrightDir = (home = homeDir()) => path.join(toolsDir(home), `playwright@${PLAYWRIGHT.version}`);
export const browsersDir = (home = homeDir()) => path.join(playwrightDir(home), 'browsers');
export const recordFile = (home = homeDir()) => path.join(toolsDir(home), `playwright@${PLAYWRIGHT.version}.json`);
const moduleDir = (home) => path.join(playwrightDir(home), 'node_modules', 'playwright-core');

// The two files `npm ci` installs from: one package, its version and integrity fixed here
export function lockFiles() {
  const pkg = { name: 'nextlevel-tester-browser', version: '1.0.0', private: true, dependencies: { 'playwright-core': PLAYWRIGHT.version } };
  const lock = {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: pkg.name, version: pkg.version, dependencies: pkg.dependencies },
      'node_modules/playwright-core': {
        version: PLAYWRIGHT.version,
        resolved: `https://registry.npmjs.org/playwright-core/-/playwright-core-${PLAYWRIGHT.version}.tgz`,
        integrity: PLAYWRIGHT.integrity,
        license: 'Apache-2.0',
        bin: { 'playwright-core': 'cli.js' },
        engines: { node: '>=20' },
      },
    },
  };
  return { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'package-lock.json': `${JSON.stringify(lock, null, 2)}\n` };
}

// Every file under the folder (but the record) -> { files: { 'rel/path': sha256 }, sizes: { 'rel/path': bytes }, bytes }.
// quick: sizes only (the doctor's look; a run reads every byte)
function hashTree(dir, { quick = false } = {}) {
  const files = {};
  const sizes = {};
  let bytes = 0;
  const buf = Buffer.alloc(1 << 20);
  const walk = (d, rel) => {
    let names = [];
    try {
      names = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of names.sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(full, r);
      else if (e.isSymbolicLink()) files[r] = `link:${fs.readlinkSync(full)}`;
      else if (e.isFile() && quick) {
        sizes[r] = fs.statSync(full).size;
        bytes += sizes[r];
      } else if (e.isFile()) {
        const h = createHash('sha256');
        const fd = fs.openSync(full, 'r');
        try {
          for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; ) {
            h.update(buf.subarray(0, n));
            bytes += n;
          }
        } finally {
          fs.closeSync(fd);
        }
        files[r] = h.digest('hex');
        sizes[r] = fs.statSync(full).size;
      }
    }
  };
  walk(dir, '');
  return { files, sizes, bytes };
}

// Whether the pinned browser is installed as its record says -> { ok, problem, record, installed }. quick: the files'
// names and sizes only (the doctor, which runs often); a run compares every file's hash.
export function browserState(home = homeDir(), { quick = false } = {}) {
  let record = null;
  try {
    record = JSON.parse(fs.readFileSync(recordFile(home), 'utf8'));
  } catch {
    // none
  }
  const installed = fs.existsSync(playwrightDir(home));
  const again = 'install it again: nextlevel tester browser install, in your own PowerShell window';
  if (!record) return { ok: false, installed, record: null, problem: installed ? `the browser's folder is there but its install never finished: ${again}` : 'the browser isn\'t installed' };
  if (record.version !== PLAYWRIGHT.version || record.browser !== PLAYWRIGHT.browser) return { ok: false, installed, record, problem: `the installed browser is Playwright ${record.version}, this nextlevel runs ${PLAYWRIGHT.version}: ${again}` };
  const tree = hashTree(playwrightDir(home), { quick });
  const want = quick ? { ...(record.sizes || {}), ...Object.fromEntries(Object.entries(record.files || {}).filter(([, h]) => String(h).startsWith('link:'))) } : record.files || {};
  const now = quick ? { ...tree.sizes, ...tree.files } : tree.files;
  const changed = [];
  for (const [f, h] of Object.entries(want)) if (now[f] !== h) changed.push(now[f] === undefined ? `${f} is gone` : `${f} changed`);
  for (const f of Object.keys(now)) if (!Object.hasOwn(want, f)) changed.push(`${f} was added`);
  if (!Object.keys(record.files || {}).length) changed.push('the record lists no file');
  if (changed.length) return { ok: false, installed, record, problem: `the browser's files differ from what was installed (${changed.slice(0, 3).join('; ')}${changed.length > 3 ? `; and ${changed.length - 3} more` : ''}): ${again}` };
  return { ok: true, installed, record, problem: '' };
}

// The install, in the owner's own window (the command and the doctor's fix): the lock file, npm ci without scripts, the
// headless Chromium, the record. -> '' or what went wrong
export async function installBrowser({ home = homeDir(), say = (m) => console.log(m), env = process.env } = {}) {
  const dir = playwrightDir(home);
  fs.rmSync(recordFile(home), { force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(lockFiles())) fs.writeFileSync(path.join(dir, name), text);
  const npm = resolveBin('npm');
  if (!npm) return "npm isn't on this window's PATH (it comes with Node.js): open a new PowerShell window and try again";
  // (no proxy or registry of the project's: the user's own npm settings, as for any npm install)
  const base = { ...env, npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false' };
  say(`Installing Playwright ${PLAYWRIGHT.version} (from the lock file nextlevel ships, with no install scripts)...`);
  let code = await waitFor(spawnBin(npm, ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: dir, env: base, stdio: 'inherit', windowsHide: false }));
  if (code !== 0) return `npm ci ended with ${code}`;
  let pkg = null;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(moduleDir(home), 'package.json'), 'utf8'));
  } catch {
    // below
  }
  if (pkg?.version !== PLAYWRIGHT.version) return `npm installed ${pkg?.version || 'nothing'}, not Playwright ${PLAYWRIGHT.version}`;
  say(`Installing its headless Chromium (${PLAYWRIGHT.download}; an antivirus may look at the new browser)...`);
  code = await waitFor(spawn(process.execPath, [path.join(moduleDir(home), 'cli.js'), 'install', '--no-progress', PLAYWRIGHT.browser], { cwd: dir, env: { ...base, PLAYWRIGHT_BROWSERS_PATH: browsersDir(home) }, stdio: 'inherit', windowsHide: false }));
  if (code !== 0) return `Playwright's installer ended with ${code}`;
  const record = recordInstall(home);
  say(`Installed: ${Object.keys(record.files).length} files, ${Math.round(record.bytes / 1e6)} MB, in ${dir}.`);
  return '';
}
// The record of what was installed: every file's hash
export function recordInstall(home = homeDir()) {
  const { files, sizes, bytes } = hashTree(playwrightDir(home));
  const record = { version: PLAYWRIGHT.version, browser: PLAYWRIGHT.browser, integrity: PLAYWRIGHT.integrity, at: new Date().toISOString(), bytes, files, sizes };
  fs.writeFileSync(recordFile(home), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}
const waitFor = (child) =>
  new Promise((resolve) => {
    child.once('error', () => resolve(-1));
    child.once('exit', (code) => resolve(code ?? -1));
  });

// What the browser's process gets of this one's environment: what finds the system and the user's folders, nothing else
// (no .env value, no nextlevel switch, no proxy setting of the user's: the run's own proxy is the only way out)
export function browserEnv(env = process.env) {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP|TMPDIR|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|HOME|USER|LOGNAME|LANG|LC_ALL|XDG_RUNTIME_DIR|FONTCONFIG_PATH)$/i;
  const out = {};
  for (const [k, v] of Object.entries(env)) if (keep.test(k)) out[k] = v;
  return out;
}

// Playwright from its own folder, by its absolute path, after the record is checked -> { chromium } or { problem }
export async function loadPlaywright(home = homeDir()) {
  const s = browserState(home);
  if (!s.ok) return { problem: s.problem };
  process.env.PLAYWRIGHT_BROWSERS_PATH = browsersDir(home);
  process.env.PLAYWRIGHT_SKIP_BROWSER_GC = '1';
  try {
    const pw = await import(pathToFileURL(path.join(moduleDir(home), 'index.mjs')).href);
    const chromium = pw.chromium || pw.default?.chromium;
    if (!chromium) return { problem: "the installed Playwright has no Chromium: nextlevel tester browser install, again" };
    return { chromium };
  } catch (err) {
    return { problem: `the installed Playwright doesn't load (${String(err.message).split('\n')[0]}): nextlevel tester browser install, again` };
  }
}
