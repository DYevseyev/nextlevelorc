// The window and the PC: elevated windows and system folders (FR-001 #9), Node.js, sleep settings.
import { fail, firstLine, isUnder, pass, step, versionAtLeast } from './lib.mjs';

export const NODE_MIN = '22.0.0'; // package.json "engines"

export const windowChecks = [
  {
    // FR-004 #2: inside Codex's sandbox the doctor said gh was signed out and Docker, Codex and agy were
    // missing. The runner turns such failures into "can't tell" there (index.mjs); this row says why.
    id: 'window.sandbox',
    title: 'Sandbox',
    severity: 'warn',
    sandbox: 'same',
    learnMore: 'docs/CHECKS.md#windowsandbox',
    run(ctx) {
      if (!ctx.sandbox) return pass('none', { quiet: true });
      return fail(`running inside ${ctx.sandbox.name} (${ctx.sandbox.signs.join('; ')}): it hides sign-ins, Docker, other programs and the network, so rows that say "can't tell" aren't the real state`, {
        next: 'the hub runs the doctor outside it',
        steps: [
          step('codex', 'nextlevel verify doctor -- nextlevel doctor', { text: 'then nextlevel wait <job-id> and nextlevel result <job-id>' }),
          step('terminal', 'nextlevel doctor', { cwd: ctx.root || undefined, text: 'or the owner, in a normal PowerShell window' }),
        ],
      });
    },
  },
  {
    id: 'window.elevated',
    title: 'Window',
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#windowelevated',
    run(ctx) {
      if (ctx.platform !== 'win32') {
        if (ctx.uid === 0) return fail('running as root', { severity: 'info', next: 'fine in a container; on your own PC use your normal user' });
        return pass('normal user');
      }
      // The integrity level SIDs are the same in every Windows language: High (12288) or System (16384) = elevated.
      const r = ctx.run('whoami', ['/groups', '/fo', 'csv', '/nh']);
      if (!r.ok) return pass('normal user (could not ask whoami)');
      if (/S-1-16-(12288|16384)\b/.test(r.out)) {
        return fail('opened as Administrator', {
          next: 'close it and open a normal PowerShell window (not "Run as administrator"): workers and files it creates would belong to the administrator',
          steps: [step('app', null, { text: 'Start menu -> type PowerShell -> press Enter (not "Run as administrator")' })],
        });
      }
      return pass('normal user');
    },
  },
  {
    id: 'window.folder',
    title: 'Window folder',
    sandbox: 'same', // the project only
    severity: 'warn',
    learnMore: 'docs/CHECKS.md#windowfolder',
    run(ctx) {
      const e = ctx.env;
      const system =
        ctx.platform === 'win32'
          ? [e.SystemRoot || e.windir || 'C:\\Windows', e.ProgramFiles || 'C:\\Program Files', e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)']
          : ['/bin', '/sbin', '/usr', '/etc', '/System', '/Library'];
      const hit = system.find((dir) => isUnder(ctx, ctx.cwd, dir)) || (ctx.platform !== 'win32' && ctx.cwd === '/' ? '/' : null);
      if (hit) {
        return fail(`this window is in a system folder: ${ctx.cwd}`, {
          next: 'an Administrator PowerShell starts in C:\\Windows\\system32; go to your project folder first',
          steps: [step('terminal', `cd "${ctx.root || 'C:\\path\\to\\your\\project'}"`)],
        });
      }
      return pass(ctx.cwd);
    },
  },
];

export const nodeCheck = {
  id: 'tool.node',
  title: 'Node.js',
  sandbox: 'same', // the Node.js running nextlevel
  learnMore: 'docs/CHECKS.md#toolnode',
  run(ctx) {
    if (versionAtLeast(ctx.nodeVersion, NODE_MIN)) return pass(ctx.nodeVersion);
    return fail(`${ctx.nodeVersion}: nextlevel needs ${NODE_MIN.replace(/\.0\.0$/, '')} or newer`, {
      steps: [ctx.platform === 'win32' ? step('terminal', 'winget install -e --id OpenJS.NodeJS.LTS') : step('browser', 'https://nodejs.org/en/download')],
      next: 'then open a new window',
    });
  },
};

// The PC must not sleep while workers run (docs/CHECKS.md, system.sleep). powercfg prints the AC and then the DC
// value as the last two hex numbers, in every Windows language.
export const sleepCheck = {
  id: 'pc.sleep',
  title: 'Sleep on power',
  severity: 'warn',
  platforms: ['win32'],
  learnMore: 'docs/CHECKS.md#pcsleep',
  run(ctx) {
    const r = ctx.run('powercfg', ['/query', 'SCHEME_CURRENT', 'SUB_SLEEP', 'STANDBYIDLE'], { fresh: true });
    const hex = r.ok ? r.out.match(/0x[0-9a-f]+/gi) || [] : [];
    if (hex.length < 2) return fail(`could not read the sleep setting${r.out ? ` (${firstLine(r.out)})` : ''}`, { severity: 'info', steps: [step('app', null, { text: 'Settings -> System -> Power -> Sleep: "Never" when plugged in' })] });
    const ac = Number.parseInt(hex[hex.length - 2], 16);
    if (ac === 0) return pass('never sleeps when plugged in');
    return fail(`sleeps after ${Math.round(ac / 60)} min when plugged in: workers and the hub stop while it sleeps`, {
      steps: [step('terminal', 'powercfg /change standby-timeout-ac 0')],
    });
  },
  fixPrompt: 'Set this PC to never sleep while plugged in?',
  fix(ctx, ui) {
    const r = ctx.run('powercfg', ['/change', 'standby-timeout-ac', '0'], { fresh: true });
    if (!r.ok) ui.say(`powercfg said: ${firstLine(r.out) || 'failed'}`);
  },
};
