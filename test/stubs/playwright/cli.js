#!/usr/bin/env node
// Stand-in for Playwright's installer in tests: `install ... chromium-headless-shell` puts a pretend browser under
// PLAYWRIGHT_BROWSERS_PATH, and nothing is downloaded.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const args = process.argv.slice(2);
const log = path.join(os.homedir(), '.fake-playwright', 'log.jsonl');
fs.mkdirSync(path.dirname(log), { recursive: true });
fs.appendFileSync(log, `${JSON.stringify({ kind: 'cli', args, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || '' })}\n`);
if (args[0] !== 'install' || !process.env.PLAYWRIGHT_BROWSERS_PATH) {
  console.error('[fake playwright] only "install" with PLAYWRIGHT_BROWSERS_PATH');
  process.exit(1);
}
const dir = path.join(process.env.PLAYWRIGHT_BROWSERS_PATH, 'chromium_headless_shell-stub');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'chrome-headless-shell'), 'a pretend browser for the tests\n');
console.log('[fake playwright] chromium-headless-shell installed');
