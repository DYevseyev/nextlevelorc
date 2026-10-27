// What a check sees of the machine. Checks do all their reading and running through this object, so a
// test can hand them a fake one (test/fake-context.mjs) instead of a real PC.
//
//   platform, path     'win32' | 'linux' | 'darwin', and the path module for it
//   cwd, root          the folder this window is in; the project's git root (null outside a project)
//   problem            why there is no project (the message findProject gave), when root is null
//   home, toolRoot     the user's home folder; where the nextlevel tool is installed (a version's folder, since releases)
//   nlHome             the nextlevel folder (~/.nextlevel, or NEXTLEVEL_HOME): versions.json, channels.json, update/
//   env, uid           environment variables (the project's .env is loaded); POSIX user id
//   secrets            the values of the project's .env: the runner blanks them out of every result
//   nodeVersion        the Node.js running nextlevel
//   config, configInfo nextlevel.json merged over the defaults; { exists, file, warnings, error }
//   stateDir           the project's .nextlevel/ folder
//   run(cmd, args, { timeoutMs, cwd, input, env, cacheMs })  -> { ok, code, missing, timedOut, out }
//                      env: a whole environment (a profile's account: engines/index.mjs profileEnv). cacheMs: a slow
//                      answer that says yes is kept that long between runs (lib/proc.mjs runCached), unless `fresh`
//   runConsole(cmd, args, { timeoutMs, cwd, env, direct })   the same in a real console with no window on Windows (agy's
//                      print mode needs one: lib/console.mjs), plainly elsewhere; direct: a .cmd shim's program without
//                      cmd.exe, as a worker's engine starts (FR-022)
//   tmpDir             the system's temp folder (the model trial's folder is made there)
//   fresh              ask everything again (doctor --fresh, the dashboard's Check again), kept answers or not
//   which(cmd)         -> { file, all } | null
//   tcpOpen(ports)     -> the first of these ports on 127.0.0.1 that answers, or 0 (lib/securityrun.mjs apiPortOpen)
//   git(args, { cwd }) -> { ok, out, err }  (cwd defaults to root)
//   read(file) -> text | null, exists(file), write(file, text), list(dir) -> names, copy(from, to)
//   cache              get(id) / set(id, value): results worth keeping between runs (.nextlevel/check-cache.json)
//   userState          get(key) / set(key, value): per-user answers (~/.nextlevel/state.json)
//   hubAlive()         whether the hub is running for this project
//   uses(engine)       whether a role in nextlevel.json runs on that engine, or falls back to it
//   usage(engine)      'role' (a role runs on it), 'fallback' (only a fallback does) or null
//   profiles           the profiles the roles use: [{ role, fallback, name, engine, account, model }]
//   sandbox            null, or { name, signs } inside Codex's sandbox (lib/sandbox.mjs): it hides the owner's
//                      sign-ins, programs and network, so the runner doesn't trust most failures there
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaults, engineUse, profilesInUse } from '../lib/config.mjs';
import { homeDir, jsonStore, userState } from '../lib/home.mjs';
import { TOOL_ROOT } from '../lib/project.mjs';
import { runInConsole } from '../lib/console.mjs';
import { readEnv } from '../lib/gitlock.mjs';
import { recordOwner } from '../lib/guard.mjs';
import { resolveBin, runCached, runQuiet } from '../lib/proc.mjs';
import { canWriteGit, detectSandbox } from '../lib/sandbox.mjs';
import { apiPortOpen } from '../lib/securityrun.mjs';
import { parseEnvFile } from '../notify.mjs';

export function makeContext({ root = null, problem = '', config, configInfo, stateDir = null, hubAlive = () => false, cwd = process.cwd() } = {}) {
  const cfg = config || defaults(root ? path.basename(root) : 'project');
  const memo = new Map();
  const secrets = root ? Object.values(parseEnvFile(path.join(root, '.env'))).filter(Boolean) : [];
  const ctx = {
    platform: process.platform,
    path,
    cwd,
    root,
    problem,
    home: os.homedir(),
    nlHome: homeDir(),
    tmpDir: os.tmpdir(),
    toolRoot: TOOL_ROOT,
    env: process.env,
    secrets,
    uid: process.getuid?.() ?? null,
    nodeVersion: process.versions.node,
    config: cfg,
    configInfo: configInfo || { exists: false, file: root ? path.join(root, 'nextlevel.json') : null, warnings: [], error: null },
    stateDir,
    // The same command twice in one doctor run (agy models, codex --version) is run once.
    fresh: false,
    run(cmd, args = [], { timeoutMs = 20000, cwd: dir = root || cwd, input, env, fresh = false, cacheMs = 0 } = {}) {
      // the same command for another account is another command
      const differs = env ? [...new Set([...Object.keys(env), ...Object.keys(process.env)])].filter((k) => env[k] !== process.env[k]).sort().map((k) => [k, env[k] ?? null]) : [];
      const key = JSON.stringify([cmd, args, dir, input, differs]);
      if (!fresh && memo.has(key)) return memo.get(key);
      const opts = { timeoutMs, cwd: dir, input, ...(env ? { env } : {}) };
      const r = cacheMs ? runCached(cmd, args, { ...opts, cacheMs, fresh: ctx.fresh }) : runQuiet(cmd, args, opts);
      memo.set(key, r);
      return r;
    },
    runConsole(cmd, args = [], { timeoutMs = 20000, cwd: dir = root || cwd, env, direct = false } = {}) {
      const opts = { timeoutMs, cwd: dir, ...(env ? { env } : {}) };
      return process.platform === 'win32' ? runInConsole(cmd, args, { ...opts, direct }) : runQuiet(cmd, args, opts);
    },
    forget: () => memo.clear(), // after a fix changed something
    which: (cmd) => resolveBin(cmd),
    tcpOpen: (ports) => apiPortOpen({ ports }),
    // Without git's optional locks: a check's `git status` never holds index.lock while the hub commits (lib/gitlock.mjs)
    git(args, { cwd: dir = root || cwd } = {}) {
      const r = spawnSync('git', args, { cwd: dir, env: readEnv(), encoding: 'utf8', windowsHide: true });
      return { ok: r.status === 0, missing: r.error?.code === 'ENOENT', out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
    },
    read: (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    },
    exists: (f) => fs.existsSync(f),
    write(f, text) {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
      // a fix's write in the project (nextlevel.json, a role doc) is the owner's: the guard never holds it
      if (root && !path.relative(root, f).startsWith('..') && !path.isAbsolute(path.relative(root, f))) recordOwner(root, [path.relative(root, f)]);
    },
    list: (dir) => {
      try {
        return fs.readdirSync(dir);
      } catch {
        return [];
      }
    },
    isDir: (p) => {
      try {
        return fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    },
    copy: (from, to) => fs.copyFileSync(from, to),
    cache: jsonStore(stateDir && path.join(stateDir, 'check-cache.json')),
    userState: userState(),
    hubAlive,
    uses: (engine) => !!engineUse(cfg, engine),
    usage: (engine) => engineUse(cfg, engine),
    profiles: profilesInUse(cfg),
    sandbox: detectSandbox(process.env, { gitWritable: () => canWriteGit(root) }),
  };
  return ctx;
}
