// A pretend PC for unit tests of the setup checks (src/checks/): the same shape as checks/context.mjs,
// with commands, files and settings given by the test. Nothing real is run or read.
//
//   commands  { 'git --version': 'git version 2.55.0', 'gh auth status': { ok: false, out: '...' }, ... }
//             a string is a successful run's output; an object is merged over { ok: true, code: 0, out: '' };
//             a function gets (args, opts) (opts.env: a profile's account). A tool with no entry at all is
//             "not installed". A key ending in " *" stands for every command line that starts with the rest
//             ('agy -p *': a run with a prompt). `calls` records each command line, and `envs` the environment it
//             got; runConsole (a real console on Windows) runs the same, and `consoleCalls` records its lines.
//   files     { '/home/me/.codex/config.toml': '...' }   dirs: ['/proj/sub']
//   config    merged over the defaults, like nextlevel.json
//   env       environment variables (Codex's sandbox shows in them); gitWritable: false for a .git it can't write
import path from 'node:path';
import { defaults, engineUse, profilesInUse } from '../src/lib/config.mjs';
import { detectSandbox } from '../src/lib/sandbox.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const deepMerge = (a, b) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(b || {})) out[k] = isObj(v) && isObj(a[k]) ? deepMerge(a[k], v) : v;
  return out;
};

export function fakeContext(o = {}) {
  const platform = o.platform || 'linux';
  const p = platform === 'win32' ? path.win32 : path.posix;
  const root = o.root === undefined ? (platform === 'win32' ? 'C:\\proj' : '/proj') : o.root;
  const home = o.home || (platform === 'win32' ? 'C:\\Users\\me' : '/home/me');
  const key = (f) => p.normalize(f);
  const files = new Map(Object.entries(o.files || {}).map(([f, t]) => [key(f), t]));
  const dirs = new Set((o.dirs || []).map(key));
  const commands = o.commands || {};
  const calls = [];
  const envs = [];
  const consoleCalls = [];
  const cache = {};
  const user = { ...(o.userState || {}) };
  const config = deepMerge(defaults(root ? p.basename(root) : 'project'), o.config);

  const run = (cmd, args = [], opts = {}) => {
    const line = [cmd, ...args].join(' ');
    calls.push(line);
    envs.push(opts.env || null);
    let hit = commands[line];
    if (hit === undefined) hit = Object.entries(commands).find(([k]) => k.endsWith(' *') && line.startsWith(k.slice(0, -1)))?.[1];
    if (hit === undefined) {
      const installed = Object.keys(commands).some((k) => k === cmd || k.startsWith(`${cmd} `));
      return installed ? { ok: false, code: 1, out: '' } : { ok: false, missing: true, code: null, out: '' };
    }
    if (typeof hit === 'function') hit = hit(args, opts);
    if (typeof hit === 'string') hit = { out: hit };
    const r = { ok: true, code: 0, out: '', ...hit };
    return { ...r, ok: !!r.ok };
  };
  const ctx = {
    platform,
    path: p,
    cwd: o.cwd || root || (platform === 'win32' ? 'C:\\Users\\me' : '/home/me'),
    root,
    problem: o.problem || '',
    home,
    nlHome: o.nlHome || p.join(home, '.nextlevel'),
    toolRoot: o.toolRoot || (platform === 'win32' ? 'C:\\Users\\me\\.nextlevel\\tool' : '/home/me/.nextlevel/tool'),
    tmpDir: platform === 'win32' ? 'C:\\Temp' : '/tmp',
    env: o.env || {},
    secrets: o.secrets || [],
    uid: o.uid === undefined ? 1000 : o.uid,
    nodeVersion: o.nodeVersion || '24.19.0',
    config,
    configInfo: { exists: true, file: root && p.join(root, 'nextlevel.json'), warnings: [], error: null, ...o.configInfo },
    stateDir: o.stateDir === undefined ? root && p.join(root, '.nextlevel') : o.stateDir,
    run,
    fresh: false,
    runConsole(cmd, args = [], opts = {}) {
      consoleCalls.push([cmd, ...args].join(' '));
      return run(cmd, args, opts);
    },
    forget() {},
    which(cmd) {
      if (o.which && cmd in o.which) return o.which[cmd] && { file: o.which[cmd][0], all: o.which[cmd] };
      return Object.keys(commands).some((k) => k.startsWith(`${cmd} `)) ? { file: cmd, all: [cmd] } : null;
    },
    git(args, { cwd } = {}) {
      const r = run('git', cwd ? ['-C', cwd, ...args] : args);
      return { ok: r.ok, out: String(r.out || '').trim(), err: String(r.err || '').trim() };
    },
    read: (f) => (files.has(key(f)) ? files.get(key(f)) : null),
    exists: (f) => files.has(key(f)) || dirs.has(key(f)),
    write: (f, text) => files.set(key(f), text),
    copy: (from, to) => files.set(key(to), files.get(key(from))),
    isDir: (f) => dirs.has(key(f)) || [...files.keys()].some((k) => k.startsWith(key(f) + p.sep)),
    list(dir) {
      const d = key(dir) + p.sep;
      const names = [...files.keys(), ...dirs].filter((k) => k.startsWith(d)).map((k) => k.slice(d.length).split(p.sep)[0]);
      return [...new Set(names)];
    },
    cache: { get: (k) => cache[k], set: (k, v) => (cache[k] = v) },
    userState: { get: (k) => user[k], set: (k, v) => (user[k] = v) },
    hubAlive: () => !!o.hubAlive,
    tcpOpen: async (ports) => ports.find((x) => (o.tcpOpen || []).includes(x)) || 0,
    uses: (engine) => !!engineUse(config, engine),
    usage: (engine) => engineUse(config, engine),
    profiles: profilesInUse(config),
    sandbox: detectSandbox(o.env || {}, { gitWritable: () => o.gitWritable ?? true }),
    // for the tests
    calls,
    envs,
    consoleCalls,
    files,
    cacheData: cache,
    userData: user,
  };
  return ctx;
}

// A fix's view of the owner: records what it was told, answers questions from a list.
export function fakeUi({ interactive = false, answers = [], confirm = true } = {}) {
  const said = [];
  const ran = [];
  return {
    interactive,
    said,
    ran,
    confirm: async () => confirm,
    input: async () => (interactive ? answers.shift() ?? null : null),
    say: (m) => said.push(m),
    run: (cmd, args, opts) => {
      ran.push([cmd, ...args].join(' ') + (opts?.shell ? ' (shell)' : ''));
      return true;
    },
  };
}
