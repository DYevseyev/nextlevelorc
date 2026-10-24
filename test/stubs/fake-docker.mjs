#!/usr/bin/env node
// Stand-in for the Docker CLI in tests, so the doctor never waits on a real Docker engine (a cold one
// on the Windows runner made the first doctor run take 20 s). STUB_DOCKER=stopped plays an engine that isn't running.
const args = process.argv.slice(2);
if (process.env.STUB_CALLS) (await import('node:fs')).appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['docker', ...process.argv.slice(2)])}\n`); // (every call, for tests that nothing ran)
if (args[0] === 'info') {
  if (process.env.STUB_DOCKER === 'stopped') {
    console.error('Cannot connect to the Docker daemon. Is the docker daemon running?');
    process.exit(1);
  }
  console.log('29.7.2');
  process.exit(0);
}
console.error(`[fake docker] not supported: ${args.join(' ')}`);
process.exit(1);
