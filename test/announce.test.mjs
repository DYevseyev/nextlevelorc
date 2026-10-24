// Announcing a release (safe updates): the hubs and the dashboard read update/available.json (the PC's last look for
// releases); Home's card shows what a newer release fixes, safety fixes marked, and "Needs you" lists one with a safety
// fix; the phone hears a safety release once per project, through notify(); a release without one sends nothing.
//   node --test test/announce.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { parseNotes } from '../src/lib/releases.mjs';
import { makeProject } from './helpers.mjs';
import { client, startUi, stopUi } from './ui-helpers.mjs';

// What a hub's look for releases left (lib/update.mjs checkReleases), fresh, so nothing fetches
function plantAvailable(p, newer) {
  const file = path.join(p.env.HOME, '.nextlevel', 'update', 'available.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ protocol: 1, at: new Date().toISOString(), ok: true, detail: '', installed: 'v0.2.0', newest: newer[0], newer, refused: [], vanished: [], candidates: {} }));
}
const rel = (name, notes) => ({ name, commit: 'a'.repeat(40), notes: parseNotes(`nextlevel ${name}\n\n${notes}`) });

test("a safety release: Home's card and Needs you have it, and the phone hears it once per project; a plain release sends nothing", async () => {
  const p = makeProject();
  let ui;
  const env = { NEXTLEVEL_NO_UPDATE: undefined }; // the owner's PC: release notices on (the tests' default turns them off)
  try {
    plantAvailable(p, [rel('v0.3.0', 'Fixes:\n- Safety: a verify command can no longer push.\n- The Project page counts closed tasks.\n\nAfter install:\n- Run the bridge test again.'), rel('v0.2.1', 'Fixes:\n- A typo on Home.')]);
    const first = p.runUntilIdle([], { extraEnv: env, timeout: 120_000 });
    assert.equal(first.code, 0, first.out);
    assert.match(first.out, /\[notify\] NTFY_TOPIC not set, skipped: proj: nextlevel v0\.3\.0 has a safety fix/, first.out);
    assert.doesNotMatch(first.out, /nextlevel v0\.2\.1 has/, 'a release without a safety fix sends nothing');
    assert.deepEqual(JSON.parse(fs.readFileSync(p.state('settings.json'), 'utf8')).releasesTold, ['v0.3.0']);
    const again = p.runUntilIdle([], { extraEnv: env, timeout: 120_000 });
    assert.doesNotMatch(again.out, /nextlevel v0.3.0 has a safety fix/, 'once per project');

    ui = await startUi(p, env);
    const state = (await client(ui).get('/api/state')).json;
    assert.equal(state.update.channel, 'release');
    assert.deepEqual(state.update.newer.map((r) => r.name), ['v0.3.0', 'v0.2.1']);
    assert.deepEqual(state.update.newer[0].notes.fixes, [
      { text: 'a verify command can no longer push.', safety: true },
      { text: 'The Project page counts closed tasks.', safety: false },
    ]);
    assert.deepEqual(state.update.newer[0].notes.afterInstall, ['Run the bridge test again.']);
    const need = state.needs.find((n) => n.kind === 'update');
    assert.equal(need?.text, 'nextlevel v0.3.0 has a safety fix: a verify command can no longer push.');
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
});

test("the owner's NEXTLEVEL_NO_UPDATE: no card, no phone message", async () => {
  const p = makeProject();
  let ui;
  try {
    plantAvailable(p, [rel('v0.3.0', 'Fixes:\n- Safety: closes a push.')]);
    const r = p.runUntilIdle([], { extraEnv: { NEXTLEVEL_NO_UPDATE: '1' }, timeout: 120_000 });
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /has a safety fix|is available/);
    ui = await startUi(p, { NEXTLEVEL_NO_UPDATE: '1' });
    const state = (await client(ui).get('/api/state')).json;
    assert.equal(state.update.off, true);
    assert.equal(state.needs.find((n) => n.kind === 'update'), undefined);
  } finally {
    await stopUi(ui);
    p.cleanup();
  }
});
