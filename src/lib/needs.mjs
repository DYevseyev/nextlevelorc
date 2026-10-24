// What a task needs from the engine that runs it (part B of Codex workers on Windows): a spec's "Needs:" line, read like
// "Kind:" (docker, network, packages; several with commas), and which worker can give it. A worker on Codex in its sandbox
// can't give some of it: on Windows its commands run under accounts of their own, which the Docker pipe, ~/.docker and
// pnpm's store in the owner's AppData refuse, network or not (measured on 0.160.0: docs/KNOWN_ISSUES.md, FR-009); and on
// every system the sandbox has no network unless its arguments turn it on. Antigravity and Claude Code workers run without
// a sandbox and give all of it. The hub refuses such a task at dispatch, and holds it at start once its profile is final
// (hub.mjs, "what a task needs"). Pure.
import { engine as adapter, engineTitle } from '../engines/index.mjs';
import { describeProfile, profilesInUse, workerArgsOf } from './config.mjs';

export const NEEDS = {
  docker: 'Docker',
  network: 'the network',
  packages: 'package installs (pnpm, npm)',
};

// A spec's "Needs:" line: { needs: ['docker', ...], unknown: [...] } (none: both empty)
export function specNeeds(specText) {
  const line = (String(specText || '').match(/^Needs:[ \t]*([^\r\n]*)$/im) || [])[1] || '';
  const words = line
    .split(/[\s,;]+/)
    .map((w) => w.trim().toLowerCase())
    .filter((w) => w && w !== 'none' && w !== '-');
  return { needs: [...new Set(words.filter((w) => Object.hasOwn(NEEDS, w)))], unknown: words.filter((w) => !Object.hasOwn(NEEDS, w)) };
}
export const needsText = (needs) => needs.map((n) => NEEDS[n] || n).join(', ');

// What of `needs` a worker on this profile can't give here: [{ need, why }] (the adapter's workerLacks, with the workers'
// own arguments on that engine).
export function lacks(profile, needs, { config, platform = process.platform }) {
  if (!needs?.length || !profile?.engine) return [];
  const e = adapter(profile.engine);
  return e.workerLacks ? e.workerLacks(needs, { platform, args: workerArgsOf(config, profile.engine) }) : [];
}

// The worker profiles that can give all of `needs`: the workers, the second worker and the fallback, each once, with who
// they are and how a task reaches them. [{ who, how, profile }]
export function workersThatCan(needs, { config, platform = process.platform }) {
  const out = [];
  for (const p of profilesInUse(config).filter((x) => x.role === 'worker')) {
    if (lacks(p, needs, { config, platform }).length) continue;
    const who = p.second ? 'the second worker' : p.fallback ? "the workers' fallback" : 'the workers';
    const how = p.second ? `--profile ${p.name}` : p.fallback ? '--fallback' : 'no Engine: or Profile: line in its spec, and no --engine or --profile';
    if (!out.some((o) => o.who === who)) out.push({ who, how, profile: p, text: `${who} (${describeProfile(p)})` });
  }
  return out;
}

// One sentence: what the task needs that this worker can't give, and who can. `held`: said of a queued task.
export function needsWords(profile, missing, can) {
  const title = engineTitle(profile.engine);
  const what = missing.map((m) => NEEDS[m.need]).join(' and ');
  const why = missing.map((m) => m.why).filter((w, i, all) => w && all.indexOf(w) === i).join('; ');
  const others = can.length ? `${can.map((c) => c.text).join(', ')} can` : 'no worker in nextlevel.json can';
  return `needs ${what}; ${title} workers here can't give it (${why}); ${others}`;
}
