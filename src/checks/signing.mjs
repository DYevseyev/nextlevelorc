// state.key: the key nextlevel signs its requests with (FR-017 part 2B, 2B-1b; docs/design/FR-017-part2B.md 3.2), kept
// outside the project in ~/.nextlevel/keys. Once the project has had one, a missing or changed key is never made again by
// itself: the hub acts on no request until the owner's fix here, in their own window, makes a new one.
import { fail, inProject, pass } from './lib.mjs';

export const signingCheck = {
  id: 'state.key',
  title: 'Signing key',
  severity: 'error',
  learnMore: 'docs/CHECKS.md#statekey',
  skipIf: (ctx) => (ctx.root ? null : 'no project'),
  run(ctx) {
    const k = ctx.signing.look();
    if (k.key) return pass('requests are signed with the project\'s key (kept outside the project)', { quiet: true });
    if (k.missing) return pass('made when the hub first starts', { quiet: true });
    return fail(k.problem, {
      next: 'make a new key in your own window; what was signed with the old one waits to be asked again',
      steps: [inProject(ctx, 'nextlevel doctor --fix state.key')],
    });
  },
  fixPrompt: () => 'Make a new signing key? Requests already queued were signed with the old one: nextlevel lists them and sets them aside, and you ask again for what you want.',
  // (the owner's own window only: an agent that could run this would get a key its own files then match)
  canFix: (r, ctx) => !ctx.agentSession,
  fix(ctx, ui) {
    if (ctx.agentSession) throw new Error(`a new signing key is the owner's, so it isn't made in an agent's session (this is ${ctx.agentSession})`);
    const pending = ctx.signing.pending();
    ctx.signing.renew();
    ui?.say?.(pending.length ? `A new key. These were signed with the old one, and the hub sets them aside: ${pending.join(', ')}. Ask again for what you want.` : 'A new key. Nothing was waiting.');
  },
  fixInWindow: true, // the owner's own window, as the problem says (never the dashboard's button)
};
