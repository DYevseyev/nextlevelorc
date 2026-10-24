// Roles on Antigravity beyond the workers (docs/design/antigravity-roles.md): the orchestrator's lock test, and what the
// owner's own agy settings approve. agy skips its permission checks for nextlevel's sessions, and the owner's settings may
// approve every command anyway, so what keeps the orchestrator from pushing or using the owner's GitHub sign-in is
// nextlevel's own block, which the lock test proves on this PC (src/locktest.mjs).
import { looseJson } from '../engines/agy.mjs';
import { LOCKED_ROLES, lockFileParts, lockPasses, roleKey } from '../lib/rolespec.mjs';
import { lockWords } from '../locktest.mjs';
import { fail, firstLine, inProject, pass, step } from './lib.mjs';

const needsProject = (ctx) => (ctx.root ? null : 'no project');
// The roles on agy that need the lock test: [{ p, role }] (the orchestrator and its fallback)
const lockedOnAgy = (ctx) => (ctx.profiles || []).filter((p) => p.engine === 'agy' && Object.hasOwn(LOCKED_ROLES, p.role)).map((p) => ({ p, role: p.role }));
const verdictOf = (ctx, role) => {
  try {
    const v = JSON.parse(ctx.read(ctx.path.join(ctx.stateDir || ctx.path.join(ctx.root, '.nextlevel'), ...lockFileParts(role))) || 'null');
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
};
// (a minute's answer is enough for a page that is drawn again and again; the hub knows its own, kept per program file)
const agyVersionOf = (ctx) => firstLine(ctx.run('agy', ['--version'], { cacheMs: 60_000 }).out);
export const lockCommand = (role, profile) => `nextlevel lock-test --engine agy --role ${role}${profile?.model ? ` --model ${profile.model}` : ''}`;

// The lock test of a role on a profile, as things are now: { passed, verdict, key, version, why (when it hasn't), command }
export function lockStatus(ctx, profile, role, { version: versionOf = agyVersionOf } = {}) {
  const version = versionOf(ctx);
  const key = roleKey({ profile, role, engineArgs: ctx.config?.engines?.agy?.args || [], version, bin: ctx.which('agy')?.file || '' });
  const v = verdictOf(ctx, role);
  const command = lockCommand(role, profile);
  if (lockPasses(v, key)) return { passed: true, verdict: v, key, version, command };
  const why =
    !v ? "it hasn't had its lock test yet"
    : v.key !== key ? `its lock test ran ${v.version && v.version !== version ? `on agy ${v.version}, and agy is ${version || 'another version'} now` : 'with other arguments, another model or another agent file'}`
    : `its lock test ${lockWords(v)}`;
  return { passed: false, verdict: v, key, version, why, command };
}

// What the owner's own agy settings approve, read only (nextlevel never writes ~/.gemini): { proceeds, commandsAll,
// outside, files } (proceeds: toolPermission always-proceed; commandsAll: a global command(*) grant; outside: files
// outside the workspace allowed)
export function agyOwnSettings(ctx) {
  const cli = ctx.path.join(ctx.home, '.gemini', 'antigravity-cli', 'settings.json');
  const shared = ctx.path.join(ctx.home, '.gemini', 'config', 'config.json');
  const s = looseJson(ctx.read(cli)) || {};
  const c = looseJson(ctx.read(shared)) || {};
  const grants = [...(Array.isArray(c.userSettings?.globalPermissionGrants?.allow) ? c.userSettings.globalPermissionGrants.allow : []), ...(Array.isArray(s.permissions?.allow) ? s.permissions.allow : [])];
  return {
    proceeds: s.toolPermission === 'always-proceed',
    commandsAll: grants.some((g) => /^command\(\s*\*\s*\)$/.test(String(g))),
    outside: /ALLOW/i.test(String(c.userSettings?.nonWorkspaceFileAccessPolicy || '')),
    files: { cli, shared },
  };
}
// Whether agy, with the owner's settings, runs commands without asking even where nextlevel passes no flag (the guide)
export const agyAsksNothing = (own) => own.proceeds || own.commandsAll;

export const lockCheck = {
  id: 'lock.test',
  title: 'Roles on Antigravity: lock test',
  severity: 'error', // (the role doesn't start without it: autopilot's rounds wait, the window refuses)
  skipIf: (ctx) => needsProject(ctx) || (lockedOnAgy(ctx).length ? null : 'no role that needs it is on Antigravity'),
  requires: ['tool.agy'],
  learnMore: 'docs/CHECKS.md#locktest',
  run(ctx) {
    const out = lockedOnAgy(ctx).map(({ p, role }) => ({ p, role, s: lockStatus(ctx, p, role) }));
    const who = (x) => `${x.role === 'assistant' ? 'the assistant' : x.p.fallback ? "the orchestrator's fallback" : 'the orchestrator'} (${x.p.model || "agy's own model"})`;
    const said = out.map((x) =>
      x.s.passed
        ? `${who(x)}: passed on ${String(x.s.verdict.at || '').slice(0, 10)} (agy ${x.s.version}): its pushes and gh go nowhere and your MCP servers aren't offered to it${x.role === 'assistant' ? ', and what it changes lands in its copy of the project' : ''}${x.s.verdict.sandbox ? `; agy's own sandbox here: ${x.s.verdict.sandbox}` : ''}`
        : `${who(x)}: ${x.s.why}, so it doesn't ${x.role === 'assistant' ? 'answer' : 'start'} on Antigravity`,
    );
    if (out.every((x) => x.s.passed)) return pass(said.join('; '));
    const failedTry = out.some((x) => x.s.verdict?.verdict === 'fail' && x.s.verdict.key === x.s.key);
    return fail(said.join('; '), {
      next: failedTry ? "something got through: keep the folder its run kept, and file it as a field report; the orchestrator stays off Antigravity" : 'the lock test proves on this PC that nextlevel keeps the role from pushing, from your GitHub sign-in and from your MCP servers (Antigravity skips its own permission checks), and the assistant from changing the project. The hub runs it by itself while it runs (the orchestrator\'s while autopilot is on)',
      steps: [...new Set(out.filter((x) => !x.s.passed).map((x) => x.s.command))].map((c) => inProject(ctx, c)),
    });
  },
};

export const agyPermissionsCheck = {
  id: 'agy.permissions',
  title: "Antigravity's own permissions",
  severity: 'info',
  skipIf: (ctx) => ((ctx.profiles || []).some((p) => p.engine === 'agy') ? null : 'no role is on Antigravity'),
  requires: ['tool.agy'],
  learnMore: 'docs/CHECKS.md#agypermissions',
  run(ctx) {
    const own = agyOwnSettings(ctx);
    const parts = [
      own.proceeds ? 'toolPermission is always-proceed' : '',
      own.commandsAll ? 'a global grant allows every command (command(*))' : '',
      own.outside ? 'files outside the workspace are allowed' : '',
    ].filter(Boolean);
    if (!parts.length) return pass("agy asks before it runs things where nextlevel passes no flag of its own (the setup guide); nextlevel's sessions skip its checks either way", { quiet: true });
    return fail(`your agy settings approve without asking: ${parts.join('; ')}. So agy asks nothing, even in the setup guide; nextlevel's own blocks (the push block, the lock test, the guard) are what keep its roles from pushing and from your sign-ins`, {
      severity: 'info',
      next: 'nothing to do for nextlevel. If you want agy to ask in your own sessions, change it in agy (/config, /permissions)',
      steps: [step('agy', '/permissions', { text: 'what your agy approves; nextlevel never changes these files' })],
    });
  },
};

// What fullAccessNote is told about this PC, for a role on a profile (the doctor's profiles.full-access, the Team page)
export function accessFacts(ctx, { version } = {}) {
  let own = null;
  return (profile, role) => {
    if (profile?.engine !== 'agy') return {};
    if (role === 'guide') return { asksNothing: agyAsksNothing((own ||= agyOwnSettings(ctx))) };
    if (Object.hasOwn(LOCKED_ROLES, role)) return { lock: lockStatus(ctx, profile, role, version ? { version } : {}) };
    return {};
  };
}
