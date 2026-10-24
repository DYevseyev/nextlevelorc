// The time autopilot's rounds and wake-ups go by (FR-019): this PC's clock. Times are kept in UTC (ISO strings), so a
// clock change (daylight saving time: US clocks go back on 1 November) changes nothing they mean.
// Under the tests' stubs only (NEXTLEVEL_TEST_STUBS, the tests' trip-wire, lib/proc.mjs), NEXTLEVEL_TEST_CLOCK names a
// file the test writes, { "at": "<ISO time>" }: the time stands there until the test moves it, so an hour or a day passes
// without waiting for it.
import fs from 'node:fs';

let lastFake = null; // (a look that catches the test's file half written keeps the time it had)

export function clockNow(env = process.env) {
  const file = env.NEXTLEVEL_TEST_CLOCK;
  if (!file || !env.NEXTLEVEL_TEST_STUBS) return Date.now();
  for (let i = 0; i < 3; i++) {
    try {
      const at = Date.parse(JSON.parse(fs.readFileSync(file, 'utf8')).at);
      if (Number.isFinite(at)) return (lastFake = at);
    } catch {
      // being written: look again
    }
  }
  return lastFake ?? Date.now();
}
export const clockIso = (env = process.env) => new Date(clockNow(env)).toISOString();
