// Closed tasks (FR-021). On 4 October a real project's Project page said the Walking skeleton had "147 of 162 merged", and the 162
// held five tasks the orchestrator had closed on 1 October at the owner's word: it had written "closed" in
// their specs and the plan, which nothing read, so the page showed them as "not dispatched yet". nextlevel had no way
// to close a task. Now `nextlevel close <task-id> --reason "..."` asks the hub, which checks the task again and keeps
// the closure in .nextlevel/closed.json: only the hub writes it (its git job `close`, a `cleanup --discard` that throws
// a branch away, a dispatch or retry that reopens one), and every reader takes it through closuresOf, which keeps only
// what is as the hub writes it (the file is in a folder agents can write). Pure.

export const MAX_CLOSE_REASON = 300;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const isBridge = (id) => /^T000-bridge-/.test(id);
const str = (x, max = 400) => (typeof x === 'string' && x.length <= max ? x : null);

// What the hub writes: { version: 1, tasks: { <id>: closure } }. A closure: { at (ISO time), by ('owner' or the agent's
// name), source (whose session, in words), reason (one line), discarded (its branch was thrown away), branch (the
// commit it was at, or ''), jobState (the job's state when it was closed, or ''), milestone and title (from its spec,
// for a spec deleted since) }.
export function closureRecord({ at, by = 'owner', source = '', reason, discarded = false, branch = '', jobState = '', milestone = '', title = '' }) {
  return { at, by, source, reason, discarded: !!discarded, branch: branch || '', jobState: jobState || '', milestone: milestone || '', title: title || '' };
}

// The closures in what was read from closed.json (anything: a file an agent may have written), as a Map id -> closure.
// An entry that isn't as the hub writes it is left out; a bridge-test task never has one.
export function closuresOf(data) {
  const out = new Map();
  const tasks = data && typeof data === 'object' && !Array.isArray(data) && data.version === 1 ? data.tasks : null;
  if (!tasks || typeof tasks !== 'object' || Array.isArray(tasks)) return out;
  for (const [id, c] of Object.entries(tasks)) {
    if (!ID.test(id) || isBridge(id) || !c || typeof c !== 'object' || Array.isArray(c)) continue;
    const at = str(c.at, 40);
    const reason = str(c.reason, MAX_CLOSE_REASON);
    if (!at || !Number.isFinite(Date.parse(at)) || !reason || /[\r\n]/.test(reason)) continue;
    const by = str(c.by, 40) ?? 'owner';
    out.set(id, closureRecord({ at, by, source: str(c.source) ?? '', reason, discarded: c.discarded === true, branch: str(c.branch, 64) ?? '', jobState: str(c.jobState, 40) ?? '', milestone: str(c.milestone, 200) ?? '', title: str(c.title) ?? '' }));
  }
  return out;
}
// The file's content for a Map of closures
export const closuresFile = (map) => ({ version: 1, tasks: Object.fromEntries([...map].sort(([a], [b]) => a.localeCompare(b))) });

// The closures made since a time (ms), newest first: [{ id, ...closure }]
export const closedSince = (map, since) =>
  [...map]
    .filter(([, c]) => Date.parse(c.at) >= since)
    .map(([id, c]) => ({ id, ...c }))
    .sort((a, b) => b.at.localeCompare(a.at));

// A reason as it is kept: one line of the team's words (redacted first by the caller), spaces folded. -> { reason } or
// { problem }
export function closeReason(text) {
  const reason = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!reason) return { problem: 'say why it is closed: --reason "replaced by M2-05 and M2-06" (or --file <path>)' };
  if (reason.length > MAX_CLOSE_REASON) return { problem: `the reason has ${reason.length} characters, more than ${MAX_CLOSE_REASON}: say it in one short line (replaced by which tasks, out of scope, the owner's call)` };
  return { reason };
}

// How a closure reads on the page and in `nextlevel status`: "closed 2026-10-01: why"
export const closedText = (c) => `closed ${String(c.at).slice(0, 10)}: ${c.reason}`;
