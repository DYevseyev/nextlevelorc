#!/usr/bin/env node
// Stand-in for Windows' powercfg in tests, so `doctor --fix` never changes the runner's power settings.
// It answers like a PC that never sleeps on power (STUB_SLEEP_AC=<seconds> for one that does).
const args = process.argv.slice(2).map((a) => a.toLowerCase());
if (process.env.STUB_CALLS) (await import('node:fs')).appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['powercfg', ...process.argv.slice(2)])}\n`); // (every call, for tests that nothing ran)
if (args[0] === '/query') {
  const ac = Number(process.env.STUB_SLEEP_AC || 0);
  const hex = (n) => `0x${n.toString(16).padStart(8, '0')}`;
  console.log('Power Setting GUID: 29f6c1db-86da-48c5-9fdb-f2b67b1f44da  (Sleep after)');
  console.log('  Minimum Possible Setting: 0x00000000\n  Maximum Possible Setting: 0xffffffff\n  Possible Settings increment: 0x00000001');
  console.log(`  Current AC Power Setting Index: ${hex(ac)}\n  Current DC Power Setting Index: ${hex(900)}`);
  process.exit(0);
}
if (args[0] === '/change') process.exit(0);
process.exit(1);
