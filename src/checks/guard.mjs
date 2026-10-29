// The guard (lib/guard.mjs, lib/protect.mjs): changes to protected files the hub holds until the owner decides, and
// the protected paths in effect. The held changes are kept outside the project (~/.nextlevel/guard/<project>/), where
// the orchestrator can't write.
import { projectKey } from '../lib/guard.mjs';
import { protectedList } from '../lib/protect.mjs';
import { fail, pass, step } from './lib.mjs';

const who = (x) =>
  x.kind === 'policy' ? 'a security policy' : x.kind === 'push' ? `the push of ${x.from} to ${x.target}` : x.kind === 'git' ? "git's own hooks and settings" : x.kind === 'merge' || ['merge', 'slot'].includes(x.on) ? `task ${x.task}` : x.kind === 'commit' || x.on === 'commit' ? "the orchestrator's commit" : 'a change on disk';
const itemsOf = (x) => {
  if (x.kind === 'git') return x.items || [];
  if (x.kind === 'policy') return [x.source === 'draft' ? `the draft from ${x.scan}` : 'SECURITY.md'];
  const files = (x.files || []).map((f) => f.path);
  // a deploy push that changes no protected file is held for what it is: exactly that commit
  return files.length || x.kind !== 'push' ? files : [`commit ${String(x.sha || '').slice(0, 7)}`];
};

export const guardCheck = {
  id: 'guard.held',
  title: 'Held changes',
  severity: 'warn',
  learnMore: 'docs/CHECKS.md#guardheld',
  skipIf: (ctx) => (ctx.root ? null : 'no project'),
  run(ctx) {
    const { entries, added, removed } = protectedList(ctx.config);
    const own = [added.length && `adds ${added.join(', ')}`, removed.length && `removes ${removed.join(', ')}`].filter(Boolean).join('; ');
    const paths = `${entries.length} protected paths${own ? ` (nextlevel.json ${own})` : ''}`;
    let items = [];
    try {
      items = JSON.parse(ctx.read(ctx.path.join(ctx.home, '.nextlevel', 'guard', projectKey(ctx.root), 'held.json')) || '{}').items || [];
    } catch {
      return fail(`the guard's record of held changes can't be read: ${paths}`, { severity: 'info' });
    }
    const waiting = items.filter((x) => x.status === 'held');
    if (!waiting.length) return pass(`none waiting for you; ${paths}`, { quiet: true });
    const gitStopped = waiting.some((x) => x.kind === 'git');
    return fail(`${waiting.length} waiting for you: ${waiting.map((x) => `${x.id} (${who(x)}: ${itemsOf(x).join(', ')})`).join('; ')}${gitStopped ? '. All git work waits: git\'s own hooks or settings changed' : ''}`, {
      ...(gitStopped ? { severity: 'error' } : {}),
      next: 'approve or reject each on the dashboard, where its exact change is; until then it waits and nothing of it is live',
      steps: [step('browser', null, { text: 'On the dashboard (START.cmd -> d): Notes and handoffs, the card that says "Approve or reject". Not from your phone.' })],
    });
  },
};
