// When autopilot starts a round (FR-019). On 4 October a real project's hub ran 95 rounds in twelve hours while the team only
// waited for the owner's reply on a card: a round started whenever no worker ran (at most 8 an hour), and each round's
// own bookkeeping commit counted as progress. Now a round starts only because something happened, and the hub enforces
// it, whatever the orchestrator's role doc says:
//   - Real: work moved (a task dispatched, merged, retried or closed; a push that sent new commits) or the owner acted (a
//     reply on a card, a note added or changed, a decision on a card or an approval, Run a round now). Nothing the team
//     does for itself is real: a commit, STATUS.md, its notes, a post on a card, a card it raises, its own checks, a push
//     with nothing new, a wake-up.
//   - Always starts a round: the owner acting; a task attempt ending, any way (stopped from outside too).
//   - Starts one only while fewer than `brake` rounds have started since the last real event: a check, push or merge job
//     ending; a wake-up the orchestrator asked for coming due; the round right after one in which something real
//     happened; one retry of a round cut off by its time limit, a crash or a stop from outside. A trigger the brake
//     doesn't let through is let go; a real event releases the brake as it happens.
//   - A job's end that a round has already seen (it reviewed the job) starts nothing; triggers that come together start
//     one round, and those that come during a round one round after it. At most `perHour` rounds an hour (a ceiling).
//   - The fuse: `fuse` rounds in a row that start with nothing real between them turn autopilot off.
//   - A round whose engine never started (its process found no console, couldn't be started, ended before it started the
//     engine, or never showed up) ran nothing: what started it waits again and the brake and the fuse don't count it,
//     but the hourly ceiling does, and two in a row turn autopilot off, saying what failed. A round whose engine started
//     is a round, whatever became of it (ended, crashed, stopped at its limit or from outside).
//   - A wake-up: one at a time, a new ask replaces the old, any round that starts clears it. It waits as long as asked,
//     and at least `wakeMin` minutes doubled for each round in a row in which nothing real happened (5, 10, then 20),
//     back to `wakeMin` after a real event. A round that asks for one gets no round right after it, even when work
//     moved in it: the wake-up is its next round (the owner acting or a task ending start one sooner, and clear it).
// Pure: the hub ("autopilot" in hub.mjs) tells it what happened and the time, and keeps the state in
// .nextlevel/rounds.json. Times are ISO strings in UTC (lib/clock.mjs).

export const ROUND_DEFAULTS = { brake: 3, fuse: 6, wakeMinMinutes: 5 };
export const PER_HOUR = 8;
export const NOT_STARTED_MAX = 2; // rounds in a row whose engine never started, before autopilot turns itself off
export const ROUND_LIMIT_MIN = 60; // a round's time limit
const HOUR = 3_600_000;

// What can start a round, in plain words; `always`: the brake doesn't hold it back. The order: which one a round that
// several started is counted under (Today, on Home).
export const REASONS = {
  owner: { title: 'You (a reply, a note, a decision, Run a round now)', always: true },
  task: { title: 'A task attempt ended', always: true },
  accept: { title: 'An acceptance run ended' },
  job: { title: 'A check, push or merge ended' },
  wake: { title: 'A wake-up the orchestrator asked for' },
  retry: { title: 'Again, after a round was cut off' },
  next: { title: 'Right after a round that moved work' },
};
export const REASON_ORDER = Object.keys(REASONS);
const CUT = { limit: `it ran past its ${ROUND_LIMIT_MIN}-minute limit`, crash: 'its engine stopped with an error', outside: 'its process was stopped from outside' };

// (only a string is a time: what comes from a file an agent wrote may be anything, and must never throw)
export const ms = (iso) => (typeof iso === 'string' ? Date.parse(iso) || 0 : 0);
const iso = (t) => new Date(t).toISOString();
const NUMBERS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
export const inWords = (n) => NUMBERS[n] ?? String(n);
const capital = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const joinOr = (list) => (list.length <= 1 ? list.join('') : list.length === 2 ? list.join(' or ') : `${list.slice(0, -1).join(', ')}, or ${list.at(-1)}`);

export function freshState() {
  return {
    version: 1,
    pending: [], // what waits to start a round: { type, what, at, job? }
    real: { n: 0, at: null, what: '' }, // the last real event (n counts them)
    sinceReal: 0, // rounds started since the last real event: the brake
    streak: 0, // rounds in a row that started with nothing real between them: the fuse
    realAtStart: -1, // real.n when the last round started
    round: null, // the round running: { startedAt, reasons, type, realN, retried, log, engine, startedReal }
    last: null, // the last round: { startedAt, endedAt, type, what, real, realWhat, how }
    wake: null, // the wake-up the hub took in: { askedAt, minutes, reason, by, due, waits }
    idle: 0, // rounds in a row that ended with nothing real (a wake-up's shortest wait doubles for each)
    wakeCleared: null, // the id of the ask the last round that started cleared (wakeup.json is the command's: it stays)
    wakeTaken: null, // the last ask taken in (its wakeKey): an ask is taken in once, whatever becomes of it
    starts: [], // when the rounds of the last hour started
    fuse: null, // { at, text, kind: 'fuse' | 'not-started' }: autopilot turned itself off
    notStarted: 0, // rounds in a row whose engine never started
    failed: null, // { at, why }: why the last of those didn't start
    dropped: null, // { at, what }: the last trigger the brake let go
    owner: null, // the owner's actions as last seen: { notes, handoff }
    onAt: null, // the owner's last "autopilot on" taken in (it resets the brake and the fuse)
  };
}

// Whether a state read from rounds.json is as the hub writes it, each field its type (FR-019): the file is one an agent
// can write, and a field that isn't (an object that throws when made a string, a number for a list) would make every
// look of autopilot throw, and the hub's start. -> '' or the first field that isn't. (Fields it doesn't know are left.)
const isStr = (x) => typeof x === 'string';
const isInt = (x) => Number.isSafeInteger(x);
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isBool = (x) => typeof x === 'boolean';
const optStr = (x) => x === undefined || x === null || isStr(x);
const optInt = (x) => x === undefined || isInt(x);
const triggerOk = (t) => isObj(t) && isStr(t.type) && isStr(t.what) && isStr(t.at) && (t.job === undefined || isStr(t.job));
const wakeOk = (w) =>
  w === null || w === undefined ||
  (isObj(w) && optStr(w.id) && isStr(w.askedAt) && Number.isFinite(w.minutes) && isStr(w.reason) && optStr(w.by) && optStr(w.due) && (w.waits === null || w.waits === undefined || Number.isFinite(w.waits)) && optStr(w.why));
const roundOk = (r) =>
  r === null ||
  (isObj(r) && isStr(r.startedAt) && Array.isArray(r.reasons) && r.reasons.every(triggerOk) && isStr(r.type) && isStr(r.what) && isInt(r.realN) && isBool(r.retried) &&
    optStr(r.log) && optStr(r.engine) && (r.startedReal === undefined || Number.isFinite(r.startedReal)) &&
    (r.prev === undefined || (isObj(r.prev) && optInt(r.prev.streak) && optInt(r.prev.realAtStart) && wakeOk(r.prev.wake))));
export function roundsProblem(s) {
  if (!isObj(s)) return 'the state';
  const fields = [
    ['version', s.version === 1],
    ['pending', Array.isArray(s.pending) && s.pending.every(triggerOk)],
    ['real', isObj(s.real) && isInt(s.real.n) && optStr(s.real.at) && isStr(s.real.what)],
    ['sinceReal', isInt(s.sinceReal)],
    ['streak', isInt(s.streak)],
    ['realAtStart', isInt(s.realAtStart)],
    ['round', roundOk(s.round)],
    ['last', s.last === null || (isObj(s.last) && isStr(s.last.startedAt) && optStr(s.last.endedAt) && isStr(s.last.type) && isStr(s.last.what) && isBool(s.last.real) && optStr(s.last.realWhat) && optStr(s.last.how))],
    ['wake', wakeOk(s.wake)],
    ['idle', isInt(s.idle)],
    ['wakeCleared', optStr(s.wakeCleared)],
    ['wakeTaken', optStr(s.wakeTaken)],
    ['starts', Array.isArray(s.starts) && s.starts.every(isStr)],
    ['fuse', s.fuse === null || (isObj(s.fuse) && isStr(s.fuse.at) && isStr(s.fuse.text) && optStr(s.fuse.kind))],
    ['notStarted', isInt(s.notStarted)],
    ['failed', s.failed === null || (isObj(s.failed) && isStr(s.failed.at) && isStr(s.failed.why))],
    ['dropped', s.dropped === null || (isObj(s.dropped) && isStr(s.dropped.at) && isStr(s.dropped.what))],
    ['owner', s.owner === null || (isObj(s.owner) && isInt(s.owner.notes) && isInt(s.owner.handoff))],
    ['onAt', optStr(s.onAt)],
    ['runNow', optInt(s.runNow)],
    ['queued', s.queued === undefined || (Array.isArray(s.queued) && s.queued.every(isStr))],
  ];
  return fields.find(([, ok]) => !ok)?.[0] || '';
}

// The trigger a pending list keeps one of: per job, else per kind and words
const triggerKey = (t) => (t.job ? `${t.type}:${t.job}` : `${t.type}:${t.what}`);
// What happened, in one line of at most `max` characters (a longer one says it was cut). Some of it comes from files an
// agent can write (a wake-up's reason, the cards' count of the owner's actions): it goes into hub.log and on Home.
export const MAX_WHAT = 300;
// (control characters, and those that turn text around, become spaces: a terminal, the page and a phone show it as typed)
export const oneLine = (s, max = MAX_WHAT) => {
  const t = (typeof s === 'string' ? s : typeof s === 'number' ? String(s) : '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
// Whether a word names one of the reasons (never an inherited property: REASONS.__proto__)
export const isReason = (type) => Object.hasOwn(REASONS, String(type));
const always = (t) => isReason(t.type) && REASONS[t.type].always;

// Something real happened: the brake and a wake-up's shortest wait start again
export function noteReal(s, what, now) {
  s.real = { n: (s.real?.n || 0) + 1, at: iso(now), what: oneLine(what) };
  s.sinceReal = 0;
  s.idle = 0;
  s.dropped = null;
  return s;
}

// Something that may start a round: it waits in `pending` until a round starts (or the brake lets it go)
export function addTrigger(s, t, now) {
  const at = t.at || iso(now);
  const x = { ...t, what: oneLine(t.what), at };
  s.pending = [...(s.pending || []).filter((y) => triggerKey(y) !== triggerKey(x)), x];
  return s;
}

// The owner turned autopilot on: the brake and the fuse start again (what waits stays, and is looked at now)
export function autopilotOn(s, onAt) {
  Object.assign(s, { onAt, sinceReal: 0, streak: 0, realAtStart: -1, fuse: null, dropped: null, idle: 0, notStarted: 0 });
  return s;
}

const sortTriggers = (list) => [...list].sort((a, b) => REASON_ORDER.indexOf(a.type) - REASON_ORDER.indexOf(b.type));

// What waits now: a job's end that has been seen since (reviewed) goes, a wake-up that came due joins
function refresh(s, { now, seen = () => false }) {
  s.pending = (s.pending || []).filter((t) => !(t.job && seen(t.job)));
  if (s.wake?.due && ms(s.wake.due) <= now && !s.pending.some((t) => t.type === 'wake')) s.pending.push({ type: 'wake', what: `the wake-up it asked for: ${s.wake.reason}`, at: s.wake.due });
}

// Whether a round starts now (the hub asks only while autopilot is on and nothing else is in the way: no round
// running, no orchestrator window open, not paused). `seen(jobId)`: whether that job's end has been reviewed.
// -> { start: true, reasons } | { start: false, until? } (until: when the hourly ceiling lets the next one start)
export function decide(s, { now, cfg, seen }) {
  refresh(s, { now, seen });
  if (s.sinceReal >= cfg.brake) {
    const held = s.pending.filter((t) => !always(t));
    if (held.length) {
      s.dropped = { at: iso(now), what: held.map((t) => t.what).join('; ') };
      if (held.some((t) => t.type === 'wake')) s.wake = null;
    }
    s.pending = s.pending.filter((t) => always(t));
  }
  if (!s.pending.length) return { start: false };
  const recent = (s.starts || []).filter((t) => now - ms(t) < HOUR && ms(t) <= now);
  if (recent.length >= (cfg.perHour || PER_HOUR)) return { start: false, until: iso(ms(recent[0]) + HOUR) };
  return { start: true, reasons: sortTriggers(s.pending) };
}

// A round started for `reasons`. -> { fuse }: true when it is the fuse's last round (the hub turns autopilot off)
export function roundStarted(s, { now, reasons, cfg, extra = {} }) {
  const prev = { realAtStart: s.realAtStart, streak: s.streak, wake: s.wake };
  s.streak = s.real.n === s.realAtStart ? s.streak + 1 : 1;
  s.realAtStart = s.real.n;
  s.sinceReal += 1;
  s.starts = [...(s.starts || []).filter((t) => now - ms(t) < HOUR), iso(now)];
  s.pending = [];
  s.wake = null; // any round that starts clears the wake-up: it can ask again
  const type = reasons[0]?.type || 'owner';
  s.round = { startedAt: iso(now), reasons, type, what: reasons.map((t) => t.what).join('; '), realN: s.real.n, retried: reasons.some((t) => t.type === 'retry'), prev, ...extra };
  return { fuse: s.streak >= cfg.fuse };
}

// The round ended. how: 'ok' (it ended by itself), 'crash' (with an error), 'limit' (stopped at its time limit),
// 'outside' (its process gone without an end): its engine started; 'not-started': its engine never started, `why` says
// what failed. -> { real, cut } | { notStarted, stop } (stop: the second in a row; autopilot turns itself off)
export function roundEnded(s, { now, how, cfg, why = '' }) {
  const r = s.round;
  if (!r) return { real: false };
  s.round = null;
  if (how === 'not-started') {
    // Nothing ran: what started it waits again, and the brake and the fuse don't count it (it stays among the hour's
    // starts: the hourly ceiling counts it)
    s.pending = [...r.reasons, ...(s.pending || [])].filter((t, i, all) => all.findIndex((x) => triggerKey(x) === triggerKey(t)) === i);
    s.sinceReal = Math.max(0, s.sinceReal - 1);
    s.streak = r.prev?.streak ?? Math.max(0, s.streak - 1);
    s.realAtStart = r.prev?.realAtStart ?? -1;
    if (!s.wake && r.prev?.wake) s.wake = r.prev.wake;
    s.notStarted = (s.notStarted || 0) + 1;
    s.failed = { at: iso(now), why: oneLine(why) || 'its engine never started' };
    return { real: false, notStarted: true, stop: s.notStarted >= NOT_STARTED_MAX };
  }
  s.notStarted = 0;
  const real = s.real.n !== r.realN;
  const cut = CUT[how] || '';
  s.last = { startedAt: r.startedAt, endedAt: iso(now), type: r.type, what: r.what, real, realWhat: real ? s.real.what : '', how };
  s.idle = real ? 0 : (s.idle || 0) + 1;
  // (a wake-up now was asked in this round: any round that starts clears the one before. Then the wake-up is its next
  // round, not one right after it)
  if (real) {
    if (!s.wake) addTrigger(s, { type: 'next', what: `right after a round in which ${s.real.what}` }, now);
  } else if (cut && !r.retried) addTrigger(s, { type: 'retry', what: `the round before was cut off: ${cut}` }, now);
  if (s.wake && !s.wake.due) settleWake(s, cfg);
  return { real, cut };
}

// The orchestrator asked for a wake-up (wakeup.json: { askedAt, minutes, reason, by }). One older than the round that
// started last is stale: that round cleared it. Asked during a round, its time is settled when the round ends (its
// shortest wait depends on whether something real happened in it). -> 'taken' | 'stale'
// A wake-up ask is a file an agent can write (wakeup.json): what the hub keeps of it, the same way each time, so an ask
// is told apart from the one taken in already by these values, never by its raw text. An id is the command's (12 hex
// digits), the minutes a number up to a day, the time one a date can hold.
export const WAKE_MAX_MIN = 24 * 60;
const DAY = 86_400_000;
const MAX_TIME = 8.64e15; // the last time a Date holds
export const wakeId = (id) => (typeof id === 'string' && id.length === 12 && [...id].every((c) => (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')) ? id : null);
const wakeMinutes = (m) => {
  const n = typeof m === 'number' ? m : typeof m === 'string' ? Number(m) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, WAKE_MAX_MIN) : 0;
};
const wakeReason = (r) => oneLine(r) || 'no reason given';
export const wakeKey = (w) => (w ? `${wakeId(w.id) || ''}|${ms(w.askedAt)}|${wakeMinutes(w.minutes)}|${wakeReason(w.reason)}` : '');

// now: an ask dated more than a day ahead is no ask (a clock set back by a day still takes the ones it made)
export function takeWake(s, ask, { cfg, now = 0 }) {
  const at = ms(ask?.askedAt);
  const since = ms(s.round?.startedAt || s.last?.startedAt);
  if (!at || at < since || Math.abs(at) > MAX_TIME - 2 * DAY || (now && at > now + DAY)) return 'stale';
  s.wake = { id: wakeId(ask.id), askedAt: iso(at), minutes: wakeMinutes(ask.minutes), reason: wakeReason(ask.reason), by: oneLine(ask.by, 80), due: null, waits: null };
  if (!s.round) settleWake(s, cfg);
  return 'taken';
}
// The shortest wait now: wakeMin, doubled for each round in a row that ended with nothing real (a day at most)
export const shortestWake = (s, cfg) => Math.min(cfg.wakeMinMinutes * 2 ** Math.min(s.idle || 0, 20), WAKE_MAX_MIN);
function settleWake(s, cfg) {
  const w = s.wake;
  const least = shortestWake(s, cfg);
  const idle = s.idle || 0;
  // (as long as asked when that is longer: the orchestrator knows how long what it waits for takes)
  const waits = Math.min(Math.max(w.minutes, least), WAKE_MAX_MIN);
  w.waits = waits;
  w.why =
    waits === w.minutes ? ''
    : idle ? `the shortest wake-up is ${least} min after ${inWords(idle)} round${idle > 1 ? 's' : ''} in a row that found nothing new`
    : `the shortest wake-up is ${least} min`;
  w.due = iso(ms(w.askedAt) + waits * 60_000);
}

// ---------- in plain words, for Home ----------
// What the next round waits for. info: { on, paused, hubRunning, interactive, cfg, now, cards (the handoff cards that
// wait for the owner's reply), decisions (held changes' cards), tasksActive, checksActive, time(iso) -> "3:10 PM",
// fuseShown, held (what holds every round: the orchestrator's lock test on Antigravity) }. -> { state, text, since?, due?, fuse? }
export function waitView(s, info) {
  const { cfg, now, time = (x) => x } = info;
  if (!info.on) {
    if (s.fuse && info.fuseShown) return { state: 'fuse', text: `Off: it turned itself off at ${time(s.fuse.at)}. ${s.fuse.text}`, fuse: s.fuse };
    return { state: 'off', text: 'Off: you talk to the orchestrator yourself' };
  }
  if (info.paused) return { state: 'paused', text: `Paused: ${info.paused}` };
  if (!info.hubRunning) return { state: 'hub-stopped', text: 'On, but the hub is stopped: nothing wakes the orchestrator' };
  if (info.interactive) return { state: 'interactive', text: 'On, but waiting: the orchestrator is open in its own window. Rounds start again once you close it.' };
  if (s.round) return { state: 'round', since: s.round.startedAt, text: `A round is running: it started because ${s.round.what}` };
  // (the orchestrator on Antigravity waits for its lock test: no round starts, and its triggers wait)
  if (info.held) return { state: 'held', text: `On, but waiting: ${info.held}. Rounds start once it passes.` };
  refresh(s, { now, seen: info.seen });
  const braked = s.sinceReal >= cfg.brake;
  const ready = s.pending.filter((t) => !braked || always(t));
  const recent = (s.starts || []).filter((t) => now - ms(t) < HOUR && ms(t) <= now);
  if (ready.length && recent.length >= (cfg.perHour || PER_HOUR)) {
    return { state: 'limit', text: `On, but waiting: ${PER_HOUR} rounds in the last hour is the most it runs; the next starts at ${time(iso(ms(recent[0]) + HOUR))} (${sortTriggers(ready)[0].what})` };
  }
  const failed = s.notStarted && s.failed ? ` (the last round didn't start: ${s.failed.why})` : '';
  if (ready.length) return { state: 'ready', text: `On: a round starts within a minute, because ${sortTriggers(ready)[0].what}${failed}` };
  const asks = [];
  if (info.cards?.length) asks.push(`your reply on ${joinOr(info.cards.slice(0, 3))}`);
  if (info.decisions?.length) asks.push(`your decision on ${joinOr(info.decisions.slice(0, 3))}`);
  asks.push('a new note');
  if (info.tasksActive) asks.push('a task finishing');
  if (!braked && info.checksActive) asks.push('a check finishing');
  if (!info.tasksActive && !(!braked && info.checksActive)) asks.push('Run a round now');
  const waitsFor = joinOr(asks);
  if (braked) {
    return { state: 'braked', text: `${capital(inWords(cfg.brake))} rounds found nothing to do, so only you or a task finishing will wake the team (${waitsFor})` };
  }
  if (s.wake?.due) return { state: 'wake', due: s.wake.due, text: `Next round at ${time(s.wake.due)}, because the last round asked: ${s.wake.reason}. Sooner: ${waitsFor}` };
  return { state: 'waiting', text: `Waits for ${waitsFor}` };
}
