// The dashboard's Home page in plain words (M9): one sentence per running task, what needs the owner with the
// one next action, and the numbers of the day. Pure functions of what the hub and the doctor report, so a test
// can feed them anything.

// A task spec's title: "# M1-01-gateway — Gateway" -> "Gateway"; the id when it has none.
export function taskTitle(spec, id) {
  const head = (String(spec || '').match(/^#\s+(.+)$/m) || [])[1] || '';
  const rest = head.replace(id, '').replace(/^[\s:—–-]+/, '').trim();
  return rest && !/^<.*>$/.test(rest) ? rest : id;
}

// The first sentence of the orchestrator's feedback, short, starting lowercase: what the task fixes now.
export function gist(text, max = 90) {
  let s = String(text || '').trim().split(/(?<=[.!?])\s|\n/)[0].replace(/[.!]+$/, '').trim();
  if (s.length > max) s = `${s.slice(0, max - 1).replace(/\s+\S*$/, '')}…`;
  return /^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
}

// "Gateway, attempt 6: fixing what the review found: add a test for the retry path"
export function taskSentence(job, { title, feedback } = {}) {
  const name = title || job.id;
  const attempt = job.attempt > 1 ? `, attempt ${job.attempt}` : '';
  let doing;
  if (job.state === 'queued') doing = 'waiting for a free slot';
  else if (job.state === 'verifying') doing = "the hub is checking the work with the task's own tests";
  else if (job.attempt > 1 && feedback) doing = `fixing what the review found: ${gist(feedback)}`;
  else doing = { review: 'reviewing', research: 'researching' }[job.kind] || 'building it';
  return `${name}${attempt}: ${doing}`;
}

// Codex's token count in what `codex exec` printed: "tokens used" and, on the next line, the number with this
// PC's thousands separators (12,345 or 12.345 or 12 345), once at the end of a run, on stderr (codex-rs
// exec, 0.150 to 0.159). The last one in the text; 0 when there is none (a run that failed early).
export function codexTokens(text) {
  const clean = String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
  let last = 0;
  for (const m of clean.matchAll(/tokens used:?[ \t]*(?:\r?\n)?[ \t]*([^\r\n]*)/gi)) {
    const n = Number(m[1].replace(/\D/g, ''));
    if (n) last = n;
  }
  return last;
}

// How a task's attempts ended (FR-020), from status.json's `attempts` (the hub adds one when an attempt ends): one
// category each. A run stopped from outside or that didn't start isn't counted (its retry is the same attempt).
export const ATTEMPT_CATEGORIES = ['failed verify', 'engine stopped', 'engine error', 'timed out', 'no report and no changes', 'no report but verified', 'no report, nothing verified', 'blocked', 'done', 'no changes', 'failed otherwise'];
export function attemptCategory(a) {
  if (!a || a.notCounted) return null;
  const exited = a.exitCode !== null && a.exitCode !== undefined && a.exitCode !== 0;
  if (a.state === 'timeout') return 'timed out';
  if (a.end?.error) return 'engine error';
  if (a.state === 'blocked') return 'blocked';
  if (a.state === 'failed' && a.claimed === 'MISSING' && exited) return 'engine stopped';
  if (a.verify === 'fail' || a.verify === 'timeout') return 'failed verify';
  if (a.state === 'no-changes') return a.claimed === 'MISSING' ? 'no report and no changes' : 'no changes';
  if (a.state === 'done') return a.mark ? (a.mark === 'verify passed' ? 'no report but verified' : 'no report, nothing verified') : 'done';
  return 'failed otherwise';
}
const ENDED = new Set(['done', 'failed', 'timeout', 'blocked', 'no-changes', 'lost', 'error', 'stopped']);
// -> { counts: [[category, n]], notCounted, unrecorded, text }: "2 failed verify, 1 no report but verified; plus 1 run
// stopped from outside or not started (not counted); 3 earlier attempts not recorded" (unrecorded: attempts that ended
// before the hub kept them)
export function attemptTally(job) {
  const list = Array.isArray(job?.attempts) ? job.attempts : [];
  const by = new Map();
  const seen = new Set();
  let notCounted = 0;
  for (const a of list) {
    seen.add(a.attempt);
    const c = attemptCategory(a);
    if (c) by.set(c, (by.get(c) || 0) + 1);
    else notCounted++;
  }
  const attempt = job?.attempt || 1;
  const ended = ENDED.has(job?.state) ? attempt : attempt - 1;
  let unrecorded = 0;
  for (let n = 1; n <= ended; n++) if (!seen.has(n)) unrecorded++;
  const counts = ATTEMPT_CATEGORIES.filter((c) => by.has(c)).map((c) => [c, by.get(c)]);
  const parts = [counts.map(([c, n]) => `${n} ${c}`).join(', ')];
  if (notCounted) parts.push(`plus ${notCounted} run(s) stopped from outside or not started (not counted)`);
  if (unrecorded) parts.push(`${unrecorded} earlier attempt(s) not recorded`);
  return { counts, notCounted, unrecorded, text: parts.filter(Boolean).join('; ') };
}

// Tasks that need a look: past three attempts (on a task still running or waiting for review), running over
// their time limit (the hub stops them at the limit plus three grace periods), or a worker that didn't start (a
// setup problem on this PC, until the job is reviewed or retried).
export const MAX_ATTEMPTS = 3;
const LIVE = new Set(['queued', 'running', 'verifying']);
export function taskAlerts(jobs, { taskTimeoutMin = 60, graceMin = 5, now = Date.now() } = {}) {
  const out = [];
  for (const j of jobs.filter((x) => x.type === 'task')) {
    const attempt = j.attempt || 1;
    if (j.state === 'running' && j.startedAt) {
      const min = (now - Date.parse(j.startedAt)) / 60000;
      const limit = j.timeoutMin || taskTimeoutMin;
      if (min > limit) out.push({ id: j.id, attempt, kind: 'time', text: `${j.id} has run ${Math.round(min)} min, past its ${limit}-min limit (the hub stops it at ${limit + graceMin * 3} min)` });
    }
    if (attempt > MAX_ATTEMPTS && (LIVE.has(j.state) || !j.acked)) {
      // (how the attempts ended, FR-020: a real task's alert fired from attempt 4 to 13 and never said)
      const tally = attemptTally(j).text;
      out.push({ id: j.id, attempt, kind: 'attempts', text: `${j.id} is on attempt ${attempt}, past ${MAX_ATTEMPTS}${tally ? ` (${tally})` : ''}: it may need a smaller task, another engine or your call` });
    }
    if (j.notStarted && j.state === 'error' && !j.acked) {
      out.push({ id: j.id, attempt, kind: 'start', text: `${j.id}'s worker didn't start: a setup problem on this PC, not the task's (${j.error || 'no reason given'})` });
    }
    // FR-013: its processes gone without a report, from outside nextlevel (an antivirus stopped the owner's workers)
    if (j.stoppedOutside && j.state === 'stopped' && !j.acked) {
      out.push({ id: j.id, attempt, kind: 'outside', text: `${j.id} was ${j.error || 'stopped from outside'}` });
    }
  }
  return out;
}

// Who made a change the guard holds, and its files, in a few words
export const guardWho = (g) =>
  g.kind === 'push' ? `A push to ${g.target}` : g.kind === 'git' ? "Git's own hooks and settings" : g.kind === 'merge' || ['merge', 'slot'].includes(g.on) ? `Task ${g.task}` : g.kind === 'commit' || g.on === 'commit' ? "The orchestrator's commit" : `A change on disk (${g.by || "during the orchestrator's work"})`;
// Why a push waits: a deploy branch, protected files the owner hasn't approved, or both (the card says which)
export function pushWhy(g) {
  const files = g.files || [];
  const prot = files.length ? `it changes protected ${files.length === 1 ? 'file' : 'files'} (${fileList(files)}) you haven't approved: GitHub runs a pushed branch's own workflows, and the agents and your tools load these files outside any sandbox` : '';
  const deploy = g.deploy || !files.length ? 'a push to a deploy branch may deploy' : '';
  return `${[deploy, prot].filter(Boolean).join(', and ')}: nothing goes out until you approve it`;
}
const fileList = (files = []) => (files.length <= 3 ? files.join(', ') : `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`);

// What needs the owner, most important first; each with the one action that moves it. `b`: the hub's state
// for the dashboard; `checks`: the doctor's last results. An action is { label, post, body } (a control),
// { label, page, focus? } (another page, at a card there) or { label, fix } (a check's automatic fix).
export function ownerNeeds(b, checks = {}) {
  const needs = [];
  const results = checks.results || [];
  const errors = results.filter((r) => r.status === 'fail' && r.severity === 'error');
  if (errors.length) {
    const one = errors.length === 1 ? errors[0] : null;
    needs.push({
      kind: 'setup',
      level: 'error',
      text: one ? `Setup check "${one.title}": ${one.detail}` : `${errors.length} setup checks fail: ${errors.map((r) => r.title).join(', ')}`,
      action: one?.autoFix ? { label: 'Fix it', fix: one.id } : { label: 'Open Setup', page: 'setup' },
    });
  }
  // A change to protected files the guard holds: only the owner decides, on its card (the Notes page), where its diff is
  for (const g of (b.guard || []).filter((x) => x.status === 'held')) {
    needs.push({
      kind: 'guard',
      level: 'error',
      id: g.card || g.id,
      text: `${g.what || `${guardWho(g)} changes ${fileList(g.files)}`}: approve or reject it (${g.id})`,
      why: { git: "git's own hooks and settings make git run programs or send a push elsewhere, and nextlevel didn't make this change", secret: 'a value from your .env is a secret: nextlevel never commits one unless you say so', push: pushWhy(g) }[g.kind] || 'those files steer the agents and your tools outside any sandbox, so nextlevel holds the change until you decide',
      action: { label: 'Review it', page: 'notes', focus: g.card || '' },
    });
  }
  // A release with a safety fix (safe updates): its card on Home has the notes and how to update
  const safe = (b.update?.newer || []).find((r) => r?.notes?.safety);
  if (safe && !b.update?.off) {
    const line = [...(safe.notes.fixes || []), ...(safe.notes.added || [])].find((i) => i.safety)?.text || '';
    needs.push({ kind: 'update', level: 'warn', text: `nextlevel ${safe.name} has a safety fix${line ? `: ${line}` : ''}`, why: 'it closes a way for an agent, a report or a phone message to do what you did not approve: update when the team is idle (the update card on Home says how)', action: null });
  }
  const work = b.active.length + b.queued.length;
  if (!b.hub.running) {
    needs.push({
      kind: 'hub',
      level: work || b.autopilot.on ? 'error' : 'warn',
      text: work ? `The hub is stopped, so ${work === 1 ? '1 task waits' : `${work} tasks wait`}: nothing runs or gets checked` : 'The hub is stopped: nothing runs or gets checked',
      action: b.hub.stopping ? null : { label: 'Start the hub', post: '/api/hub', body: { action: 'start' } },
    });
  }
  if (b.autopilot.on && b.autopilot.paused) needs.push({ kind: 'autopilot', level: 'warn', text: `Autopilot is paused: ${b.autopilot.paused}`, action: { label: 'Resume autopilot', post: '/api/autopilot', body: { on: true } } });
  // The fuse (FR-019): rounds in a row with nothing real turned autopilot off; the card says why, and turns it on again
  if (b.autopilot.state === 'fuse') needs.push({ kind: 'autopilot', level: 'warn', text: `Autopilot turned itself off: ${b.autopilot.fuse?.text || b.autopilot.text}`, action: { label: 'Turn on autopilot', post: '/api/autopilot', body: { on: true } } });
  // Files a worker needs are gone (an antivirus's quarantine, FR-013): tasks wait until they are back
  if (b.dispatchPaused) {
    const d = b.dispatchPaused;
    needs.push({ kind: 'dispatch', level: 'error', text: `Dispatch is paused: ${d.files.length === 1 ? 'a file' : `${d.files.length} files`} a worker needs ${d.files.length === 1 ? 'is' : 'are'} missing (${d.files.slice(0, 3).join(', ')}${d.files.length > 3 ? ', ...' : ''}). An antivirus may have quarantined ${d.files.length === 1 ? 'it' : 'them'}: restore from its quarantine; tasks start again by themselves once the files are back.`, action: { label: 'Open Setup', page: 'setup' } });
  }
  // A slot kept out of use because what a stopped worker started may still run there, and the hub couldn't make sure
  // (FR-013): Check again lists the processes once more
  for (const s of (b.heldSlots || []).filter((x) => x.state === 'failed')) {
    needs.push({ kind: 'slot', level: 'error', text: s.text, action: { label: 'Check again', post: '/api/slot', body: { slot: s.slot } } });
  }
  // Tasks on Antigravity wait for a passing trial of what a worker runs (FR-022): the version and agy's own reason, in
  // one line; Check again runs the trial again (the hub tries by itself once an hour, and when agy or the settings change)
  if (b.agyHold) {
    const h = b.agyHold;
    const n = (h.tasks || []).length;
    const waiting = n ? ` ${n === 1 ? '1 task waits' : `${n} tasks wait`} for it (${h.tasks.slice(0, 3).join(', ')}${n > 3 ? ', ...' : ''}).` : '';
    needs.push({
      kind: 'agy',
      level: 'error',
      text: `${h.text}.${waiting}${h.again ? ' You asked to check again: the hub tries at its next look.' : ''}`,
      why: "Tasks on other engines go on. Nothing falls back by itself: agy's refusal can be a usage limit. nextlevel retry <id> --fallback moves a task that waits",
      action: h.again ? null : { label: 'Check again', post: '/api/agy', body: {} },
      more: { label: 'Open Setup', page: 'setup' },
    });
  }
  // The orchestrator on Antigravity held by its lock test (docs/design/antigravity-roles.md): what got through, or what the
  // model didn't run; Check again runs it again (a new agy version or other arguments run it by themselves)
  for (const h of [b.lockHold, b.assistantHold].filter(Boolean)) {
    const waits = h.role === 'assistant' ? 'Questions to the assistant wait' : "Autopilot's rounds wait";
    const keeps = h.role === 'assistant' ? 'the assistant, in its copy of the project,' : 'the orchestrator';
    needs.push({
      kind: 'lock',
      level: 'error',
      text: `${h.text}.${h.again ? ' You asked to check again: the hub runs it at its next look.' : ''}`,
      why: `${waits}, and nothing falls back by itself: the lock test proves nextlevel keeps ${keeps} from pushing, from your GitHub sign-in and from your MCP servers on this PC. From PowerShell: ${h.command}`,
      action: h.again ? null : { label: 'Check again', post: '/api/lock', body: { role: h.role } },
      more: { label: 'Open Team', page: 'team' },
    });
  }
  // A round on Antigravity ran commands that clear nextlevel's push block or go past it (lib/blockwatch.mjs): found by
  // pattern after the round; the owner looks at its log and marks it seen
  // The project changed while the assistant on Antigravity answered in its copy (src/ask.mjs: HEAD, refs, git status and the
  // protected files compared before and after): it may be the owner or the hub, but it is said
  if (b.askTripwire) {
    needs.push({
      kind: 'asktripwire',
      level: 'warn',
      text: `While the assistant on Antigravity answered, your project changed: ${(b.askTripwire.changes || []).join('; ')}.`,
      why: 'It answers in a copy of the project, so it may have been you or the hub; but it runs as your Windows user and can write outside its copy, so look at what changed',
      action: { label: 'Seen', post: '/api/asktripwire', body: {} },
      more: { label: 'See it on Build', page: 'build' },
    });
  }
  if (b.blockAlert) {
    needs.push({
      kind: 'blockalert',
      level: 'warn',
      text: `${b.blockAlert.text}.`,
      why: `Found by pattern after the round, so nothing was stopped by this: look at what it did. Its log: ${b.blockAlert.log}`,
      action: { label: 'Seen', post: '/api/blockalert', body: {} },
      more: { label: 'See it on Build', page: 'build' },
    });
  }
  // A worker that wrote outside its slot or aimed git at another folder, found after its attempt (lib/slotwatch.mjs)
  if (b.slotEscape) {
    const e = b.slotEscape;
    needs.push({
      kind: 'slotescape',
      level: 'warn',
      text: [e.did ? `Task ${e.task}'s worker (attempt ${e.attempt}) worked outside its slot: ${e.did}.` : '', e.moves?.length ? `While ${e.did ? 'it' : `task ${e.task}'s worker (attempt ${e.attempt})`}${e.others?.length ? ` and ${e.others.length === 1 ? `task ${e.others[0]}'s worker` : `the workers of tasks ${e.others.join(', ')}`}` : ''} ran, git moved the main checkout, and not the hub: ${e.moves.join('; ')}.` : ''].filter(Boolean).join(' '),
      why: `Found after the attempt, so nothing was stopped by this.${e.did ? ' Look at those files and folders.' : ''}${e.moves?.length ? " Look at the main checkout's git log: if you or the orchestrator moved it, that was you, not the worker." : ''} A worker runs as your Windows user and can write anywhere you can.`,
      action: { label: 'Seen', post: '/api/slotescape', body: {} },
      more: { label: 'See it on Build', page: 'build' },
    });
  }
  for (const a of b.alerts || []) {
    // (a worker stopped from outside points at the antivirus: Setup lists the tool files that are gone)
    if (a.kind === 'outside') needs.push({ kind: 'task', level: 'error', text: a.text, action: { label: 'Open Setup', page: 'setup' }, more: { label: 'See it on Build', page: 'build' } });
    else needs.push({ kind: 'task', level: 'warn', text: a.text, action: { label: 'See it on Build', page: 'build' } });
  }
  // Each handoff item with what, where and why, a Done button, and a way to its card (to reply); a held change's card
  // is the guard's need above. A card the team answered (FR-014) until the owner replies or marks it done: its answer
  // is read on the card, so the action goes there.
  const items = (b.handoff || b.waiting.map((what) => ({ what }))).filter((x) => !x.guard);
  for (const x of items) {
    const what = String(x.what || '').split('\n')[0].trim();
    // (marked done on the dashboard, and still undoable: nothing reached the team yet. `pending`: when it is final)
    if (x.pending?.finalAt && x.id) {
      needs.push({ kind: 'pending', level: 'info', id: x.id, text: `${x.id}: marked ${x.unread ? 'read' : 'done'}: ${what}`, why: '', pending: x.pending.finalAt, action: { label: 'Undo', post: '/api/handoff', body: { action: 'undo', id: x.id } }, more: null });
      continue;
    }
    if (x.unread && x.id) {
      needs.push({ kind: 'answer', level: 'warn', id: x.id, text: `${x.id}: the team answered: ${what}`, why: x.why || '', action: { label: 'Read the answer', page: 'notes', focus: x.id }, more: null });
      continue;
    }
    const text = [x.id ? `${x.id}: ` : '', what, x.where ? ` (where: ${x.where})` : ''].join('');
    needs.push({ kind: 'handoff', level: 'warn', id: x.id || '', text, why: x.why || '', action: x.id ? { label: 'Done', post: '/api/handoff', body: { action: 'done', id: x.id } } : { label: 'Open Notes', page: 'notes' }, more: x.id ? { label: 'Reply', page: 'notes' } : null });
  }
  const deciding = b.orchestrator || (b.autopilot.on && !b.autopilot.paused);
  // Autopilot's brake holds (FR-019): finished checks wait for a round that only the owner or a task's end starts now
  if (b.review.length && !b.orchestrator && b.autopilot.braked) {
    needs.push({ kind: 'review', level: 'info', text: `${b.review.length === 1 ? '1 finished job waits' : `${b.review.length} finished jobs wait`} for the orchestrator's review: ${b.autopilot.text}`, action: { label: 'Run a round now', post: '/api/round', body: {} } });
  }
  if (b.review.length && !deciding) {
    needs.push({
      kind: 'review',
      level: 'info',
      text: `${b.review.length === 1 ? '1 finished job waits' : `${b.review.length} finished jobs wait`} for the orchestrator's review, and no orchestrator is at work`,
      action: b.windows ? { label: 'Open the orchestrator', post: '/api/open', body: { what: 'orchestrator' } } : { label: 'Turn on autopilot', post: '/api/autopilot', body: { on: true } },
    });
  }
  const allDone = b.milestones.length && b.milestones.every((m) => m.done);
  if (!needs.length && b.hub.running && !work && !b.review.length && !deciding && !allDone) {
    needs.push({
      kind: 'idle',
      level: 'info',
      text: 'Nothing is running and no orchestrator is at work: the next tasks wait to be planned',
      action: { label: 'Turn on autopilot', post: '/api/autopilot', body: { on: true } },
    });
  }
  return needs;
}

// ---------- Home's Blockers (M11): a headline colored by meaning, then short labeled bullets ----------
// From the "## Blockers" section of the status file, where the orchestrator keeps open items as "- **Needs you:**
// ...", "- **Blocked by the tool:** ...", "Known limitation", "Decision" or "Note" (ORCHESTRATOR.md), and from the
// open handoff items. Resolved items, and whatever sits under a History or Details heading, are folded away.
export const BLOCKER_KINDS = [
  { kind: 'blocked', label: 'Blocked by the tool', re: /^(blocked(\s+by\s+(the\s+)?(tool|nextlevel|hub|engine|pc|a\s+tool))?|blocker|tool)$/i },
  { kind: 'needs', label: 'Needs you', re: /^(needs\s+you|waiting\s+on\s+you|waiting\s+for\s+you|needs\s+the\s+owner|owner|you)$/i },
  { kind: 'decision', label: 'Decision', re: /^(decision|decision\s+needed|pending\s+decision|to\s+decide)$/i },
  { kind: 'limitation', label: 'Known limitation', re: /^(known\s+limitation|limitation|known\s+issue|workaround)$/i },
  { kind: 'note', label: 'Note', re: /^(note|info|fyi)$/i },
  { kind: 'resolved', label: 'Resolved', re: /^(resolved|fixed|done|closed)$/i },
];
const ORDER = ['blocked', 'needs', 'open', 'decision', 'limitation', 'note'];
const HISTORY = /^(history|resolved|details|done|closed|earlier|past|archive|fixed|previous)\b/i;

// An item's label, if it starts with one: "**Needs you:** x", "**Needs you**: x", "Needs you: x", "[Needs you] x"
function labeled(text) {
  const m =
    text.match(/^(?:\*\*|__)\s*([^*_:\n]{2,40}?)\s*:?\s*(?:\*\*|__)\s*:?\s*([\s\S]*)$/) ||
    text.match(/^\[([^\]\n]{2,40})\]\s*:?\s*([\s\S]*)$/) ||
    text.match(/^([A-Za-z][A-Za-z ]{1,40}?)\s*:\s+([\s\S]*)$/);
  if (!m) return null;
  const k = BLOCKER_KINDS.find((x) => x.re.test(m[1].trim()));
  return k ? { kind: k.kind, label: k.label, text: m[2].trim() } : null;
}

// { items: [{ kind, label, text }], history: [markdown] }: kind 'open' is an item without a label
export function parseBlockers(text) {
  const t = String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .trim();
  const items = [];
  const history = [];
  if (!t || /^none\.?$/i.test(t)) return { items, history };
  const entries = [];
  let old = false;
  let cur = null;
  let blank = false;
  for (let line of t.split('\n')) {
    if (/<details\b/i.test(line)) old = true;
    line = line.replace(/<\/?details[^>]*>/gi, '').replace(/<summary[^>]*>.*?<\/summary>/gi, '');
    const bare = line.trim().replace(/^[*_]+|[*_:]+$/g, '').trim();
    const head = line.match(/^#{2,6}\s+(.+?)\s*#*\s*$/);
    if (head || (bare && HISTORY.test(bare) && /^(#|\*\*|__)?[A-Za-z ]+[*_:]*$/.test(line.trim()) && bare.split(/\s+/).length <= 3)) {
      if (HISTORY.test(head ? head[1] : bare)) old = true;
      cur = null;
      continue;
    }
    if (!line.trim()) {
      blank = true;
      continue;
    }
    const bullet = line.match(/^\s{0,1}(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      cur = { text: bullet[1], old };
      entries.push(cur);
    } else if (cur && (/^\s{2,}/.test(line) || !blank)) cur.text += `\n${line.replace(/^\s{2,4}/, '')}`;
    else {
      cur = { text: line.trim(), old, para: true };
      entries.push(cur);
    }
    blank = false;
  }
  for (const e of entries) {
    let body = e.text.trim();
    let done = e.old || /^~~/.test(body) || /^✅/.test(body);
    const box = body.match(/^\[([ xX])\]\s*/);
    if (box) {
      done ||= box[1] !== ' ';
      body = body.slice(box[0].length);
    }
    if (/^none\.?$/i.test(body)) continue;
    const lab = labeled(body);
    if (lab?.kind === 'resolved' || /\((resolved|fixed)\b/i.test(body)) done = true;
    if (done) history.push(e.para ? body : `- ${body.replace(/\n/g, '\n  ')}`);
    else items.push(lab ? { kind: lab.kind, label: lab.label, text: lab.text } : { kind: 'open', label: '', text: body });
  }
  return { items, history };
}

// The Markdown of a line, as plain words for a headline
const plainWords = (s) =>
  String(s || '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).replace(/\s+\S*$/, '')}…` : s);
// A headline's words: up to the first clause break ("; ", ", so ", " — ", ": "), when that leaves enough to say what
const clause = (s, min = 24) => {
  const m = s.slice(min).match(/(?:;|,\s+so\b|\s[—–]\s|:\s|\.\s)/);
  return m ? s.slice(0, min + m.index).replace(/[\s,;:.]+$/, '') : s.replace(/\.$/, '');
};

// Home's Blockers card: { level: ok | waiting | blocked, headline, sub, items, history }. `handoff`: the open handoff
// items; `closed`: the ids of the handled ones. A "Needs you" bullet that names an open item stands for it; one whose
// items are all handled is done on the owner's side (the orchestrator takes it out at its next round) and isn't
// counted; the open items no bullet names are added. `guard`: the changes the guard holds, each "Blocked by the tool"
// until the owner decides (their handoff cards stand for nothing else).
export function blockersView(text, handoff = [], closed = [], guard = []) {
  const { items, history } = parseBlockers(text);
  const openIds = new Set(handoff.map((x) => x.id).filter(Boolean));
  const closedIds = new Set(closed);
  const named = new Set();
  const list = items.map((it) => {
    const ids = [...new Set(it.text.match(/\bH\d+\b/g) || [])];
    ids.forEach((id) => named.add(id));
    const handled = it.kind === 'needs' && ids.length > 0 && ids.every((id) => closedIds.has(id) && !openIds.has(id));
    return { ...it, ids, handled };
  });
  for (const g of guard.filter((x) => x.status === 'held')) {
    const ids = `${g.id}${g.card ? `, card ${g.card}` : ''}`;
    const text = g.kind === 'git' ? `${g.what} for your approval (${ids})` : g.kind === 'secret' ? `${g.what}: it waits for your approval (${ids})` : g.kind === 'push' && !(g.files || []).length ? `${guardWho(g)}, a deploy branch, waits for your approval (${ids})` : `${guardWho(g)} waits for your approval: it changes ${fileList(g.files)}, protected files (${ids})`;
    list.push({ kind: 'blocked', label: 'Blocked by the tool', text, ids: g.card ? [g.card] : [], guard: g.id, handled: false });
  }
  for (const x of handoff) {
    if (!x.id || named.has(x.id) || x.guard) continue;
    list.push({ kind: 'needs', label: 'Needs you', text: `${String(x.what || '').split('\n')[0].trim()}${x.where ? ` (${x.where})` : ''}`, ids: [x.id], handoff: true, handled: false });
  }
  list.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
  const blocked = list.filter((x) => x.kind === 'blocked');
  const needs = list.filter((x) => x.kind === 'needs' && !x.handled);
  const open = list.filter((x) => x.kind === 'open');
  const waiting = needs.length ? `Waiting on you: ${needs.length}` : '';
  let view;
  if (blocked.length) {
    const more = blocked.length > 1 ? ` (and ${blocked.length - 1} more)` : '';
    view = { level: 'blocked', headline: `Blocked: ${cut(clause(plainWords(blocked[0].text.split('\n')[0])), 90)}${more}`, sub: waiting };
  } else if (needs.length) view = { level: 'waiting', headline: waiting, sub: '' };
  else if (open.length) view = { level: 'waiting', headline: `${open.length === 1 ? '1 open item' : `${open.length} open items`}, not labeled yet`, sub: 'The orchestrator labels them at its next round (docs/agents/ORCHESTRATOR.md, "Blockers").' };
  else view = { level: 'ok', headline: 'No blockers', sub: '' };
  return { ...view, items: list, history };
}
