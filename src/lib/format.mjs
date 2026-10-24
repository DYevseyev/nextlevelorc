// A project's .nextlevel/ format (safe updates, docs/design/safe-updates.md, "Two versions on one PC"): two versions
// work on one project only across an update or a Go back, and a version must never misread what a newer one wrote.
// .nextlevel/format.json is { format, readableFrom }. A version that changes a file of .nextlevel/ in a way an older one
// would misread raises FORMAT (and says from which format its files are still readable, READABLE_FROM); one that only
// adds keeps both. A version runs on a project whose format it knows, or whose files it can still read
// (its FORMAT >= the file's readableFrom); else it refuses, saying so, and Go back checks this before it switches.
import fs from 'node:fs';
import path from 'node:path';

export const FORMAT = 1;
export const READABLE_FROM = 1;
const file = (stateDir) => path.join(stateDir, 'format.json');

export function readFormat(stateDir) {
  try {
    const v = JSON.parse(fs.readFileSync(file(stateDir), 'utf8'));
    const format = Number.isSafeInteger(v?.format) && v.format > 0 ? v.format : 1;
    const readableFrom = Number.isSafeInteger(v?.readableFrom) && v.readableFrom > 0 ? Math.min(v.readableFrom, format) : format;
    return { format, readableFrom };
  } catch {
    return { format: 1, readableFrom: 1 };
  }
}
// Why a version that knows `format` can't run on this project, or '' (format: this version's FORMAT)
export function formatProblem(stateDir, { format = FORMAT } = {}) {
  const f = readFormat(stateDir);
  if (f.format <= format || f.readableFrom <= format) return '';
  return `this project's nextlevel files are in format ${f.format}, from a newer nextlevel, which an older one (format ${format}) can't read: run the newer version (nextlevel update), or put .nextlevel aside first`;
}
// Raise the project's format to this version's (never lower it)
export function writeFormat(stateDir) {
  const f = readFormat(stateDir);
  if (fs.existsSync(file(stateDir)) && f.format >= FORMAT) return;
  try {
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file(stateDir), JSON.stringify({ format: Math.max(f.format, FORMAT), readableFrom: Math.max(f.readableFrom, READABLE_FROM) }, null, 2));
  } catch {
    // written at the next start
  }
}
