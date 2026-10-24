#!/usr/bin/env node
// Stand-in for npm in tests: only what nextlevel asks of it (`npm prefix -g`, where npm link puts
// commands). The global folder is FAKE_NPM_PREFIX, else npm-global in the fake home. FAKE_NPM_LOG: a file
// that gets one line per call, so a test can tell whether an install was run.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
if (process.env.STUB_CALLS) fs.appendFileSync(process.env.STUB_CALLS, `${JSON.stringify(['npm', ...process.argv.slice(2)])}\n`); // (every call, for tests that nothing ran)
if (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, `${args.join(' ')}\n`);
if (args[0] === 'prefix' && args.includes('-g')) {
  console.log(process.env.FAKE_NPM_PREFIX || path.join(os.homedir(), 'npm-global'));
  process.exit(0);
}
console.error(`[fake npm] not supported: ${args.join(' ')}`);
process.exit(1);
