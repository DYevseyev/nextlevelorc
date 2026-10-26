// nextlevel note and nextlevel handoff: the owner's notes and the team's handoff items, as cards (lib/cards.mjs).
// The orchestrator reads and answers them here, never by editing docs/OWNER_NOTES.md or docs/HANDOFF.md (nextlevel
// writes those from the cards); the owner uses the dashboard's Notes page, or the same commands.
//   Orchestrator  nextlevel note list [--all] [--search <text>] [--json]
//                 nextlevel note seen <id>...
//                 nextlevel note done <id> --reply "one line" | --file <path> [--commit <sha>] [--task <task-id>]
//                 nextlevel note decline <id> --reply "why" | --file <path>
//                 nextlevel handoff list [--all] [--json]
//                 nextlevel handoff show <id> [--from <line>] [--json]   one card whole, with its replies and answers
//                 nextlevel handoff add --file <path> [--task <task-id>]  the request, with lines "Where: ..." and "Why: ..."
//                               (or: add "what to do" --where "which window, panel or file" --why "why")
//                 nextlevel handoff answer <id> --file <path>             an answer on the card (--file -: from stdin)
//                 nextlevel handoff seen <id>...
//                 nextlevel handoff close <id> --file <path>              resolved: the owner did it or answered (FR-018)
//                 nextlevel handoff cancel <id> --reply "why it is no longer needed" | --file <path>
//   Owner         nextlevel note add "text" [--rule] | edit <id> "text" | withdraw <id> | off <id> | on <id> | remove <id>
//                 nextlevel handoff done <id> [--reply "..."] | reply <id> "..." | reopen <id>
// Free text can always come from a file instead (--file <path>, a file in the project folder; --file - reads stdin), and
// an answer only does (FR-014): on Windows the orchestrator runs nextlevel through nextlevel.cmd, where an argument ends
// at its first line break and % ^ & ! and quotes may change. An answer is redacted like a report before it is kept
// (`redact`, from the hub): the owner reads it on the dashboard, and the cards' Markdown goes into Git.
import { conversation, eventWords, eventsOf, firstLine, noteGroups, when } from './lib/cards.mjs';
import { commandArgs } from './lib/commands.mjs';
import { OUTPUT_BUDGET, cutSaid, head, sizeOf, sizeText } from './lib/reports.mjs';
import { agentSession, ownerOnly } from './lib/session.mjs';
import { cleanText, readTextFile } from './lib/textin.mjs';

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A worker runs in a slot (NEXTLEVEL_TASK_ID is set there): its notes would land in the slot's copy of the files and
// then in its task branch. What it has to say goes in its report. (A worker can clear the variable: this catches a
// mistake, it keeps no one out; FR-017 part 2 keeps workers from the hub.)
function notInSlot(what) {
  if (process.env.NEXTLEVEL_TASK_ID) throw new Error(`workers don't change the ${what}: put what the orchestrator or the owner should know in your report (RESULT.md)`);
}
// The owner's side of the cards (a note added or changed, a reply, Done) is what wakes the team (FR-019): in an agent's
// session (the orchestrator's window or round, a verify command) it is refused, so the team never passes for the owner
// through an ordinary command. (No wall: an agent that clears the variables is taken for the owner, KNOWN_ISSUES.)
function ownerSide(command, where) {
  const session = agentSession();
  if (session) throw new Error(ownerOnly(command, where, session));
}
const quote = (s) => String(s).replace(/\s+/g, ' ').trim();
const cut = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const count = (n) => n.toLocaleString('en-US');
const ms = (iso) => Date.parse(iso || '') || 0;
// What the orchestrator reads of the owner's words (FR-012: they were cut to 110 characters, with only an ellipsis): a
// note to follow and an owner's reply whole up to 1500 characters, a handled one's shorter; a longer text is cut saying
// so, with its length and the card in the Markdown file that has all of it.
const OWN = 1500;
const flag = (a, name) => (typeof a[name] === 'string' ? a[name] : '');
// A path as a command line needs it
const argOf = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '')}"` : s);

// A command's free text (FR-014): from --file (a file in the project folder; --file - reads stdin), else from its
// arguments. Never both.
function freeText(a, fromArgs, ctx, what) {
  if (a.file === undefined) return fromArgs;
  if (String(fromArgs ?? '').trim()) throw new Error(`give ${what} once: in a file (--file) or in the command, not both`);
  return readTextFile(a.file === true ? '' : a.file, { root: ctx.root });
}

// A request as the orchestrator writes it in a file: the request itself, and lines "Where: ..." (which window, panel or
// file), "Why: ..." and, if it likes, "Task: ...".
export function parseRequest(text) {
  const out = { what: [], where: '', why: '', task: '' };
  for (const l of cleanText(text).split('\n')) {
    const m = l.match(/^(Where|Why|Task):[ \t]*(.*)$/i);
    const key = m && m[1].toLowerCase();
    if (m && !out[key]) out[key] = m[2].trim();
    else out.what.push(l);
  }
  return { ...out, what: out.what.join('\n').trim() };
}

// ---------- nextlevel note ----------
const noteLine = (file, { handled = false } = {}) => (n) => {
  const state = n.off ? 'off' : n.status === 'new' ? 'NEW' : n.status;
  const links = [n.commit && `commit ${n.commit}`, n.task && `task ${n.task}`].filter(Boolean).join(', ');
  const answer = n.status === 'done' ? ` -> done: ${n.reply}${links ? ` (${links})` : ''}` : n.status === 'declined' ? ` -> declined: ${n.reply}` : '';
  return `  ${n.id.padEnd(5)} ${state.padEnd(9)} ${when(n.createdAt)}  ${cutSaid(quote(n.text), handled ? 110 : OWN, `${n.id} in ${file}`)}${answer}`;
};
function listNotes(store, a, print) {
  const items = store.notes.list();
  const q = flag(a, 'search').toLowerCase();
  const match = (n) => !q || `${n.id} ${n.text} ${n.reply}`.toLowerCase().includes(q);
  const g = noteGroups(items.filter(match));
  const rulesOn = g.rules.filter((n) => !n.off);
  const off = g.rules.filter((n) => n.off);
  const json = { ok: true, rules: g.rules, open: g.open, history: a.all || q ? g.history : [], file: store.files.notes, store: store.store.notes };
  const lines = [`Owner notes (${store.files.notes} is written from them: don't edit it)`];
  lines.push('', 'Standing rules: follow them in everything you do');
  lines.push(...(rulesOn.length ? rulesOn.map(noteLine(store.files.notes)) : ['  none']));
  if (off.length) lines.push(`  (${off.length} switched off by the owner: don't follow ${off.length === 1 ? 'it' : 'them'}: ${off.map((n) => n.id).join(', ')})`);
  lines.push('', 'One-time instructions to act on');
  lines.push(...(g.open.length ? g.open.map(noteLine(store.files.notes)) : ['  none']));
  if (a.all || q) {
    lines.push('', `History${q ? ` matching "${q}"` : ''}`);
    lines.push(...(g.history.length ? g.history.map(noteLine(store.files.notes, { handled: true })) : ['  none']));
  }
  const fresh = [...rulesOn, ...g.open].filter((n) => n.status === 'new');
  lines.push('');
  if (fresh.length) lines.push(`New or changed: ${fresh.map((n) => n.id).join(', ')}. When you take one on (or follow a rule): nextlevel note seen <id>`);
  lines.push('When a one-time note is handled: nextlevel note done <id> --reply "one line" [--commit <sha>] [--task <task-id>]; if you won\'t: nextlevel note decline <id> --reply "why".');
  print(json, lines.join('\n'));
  return 0;
}

export async function cmdNote(argv, ctx) {
  notInSlot("owner's notes");
  const { store } = ctx;
  const c = { root: store.root };
  const a = commandArgs('note', argv);
  const [sub, ...rest] = a._;
  const print = (json, text) => console.log(a.json ? JSON.stringify(json, null, 2) : text);
  const said = (item, text) => (print({ ok: true, item }, text), 0);
  const need = (cond, usage) => {
    if (!cond) throw new Error(`usage: nextlevel note ${usage}`);
  };
  if (['add', 'edit', 'withdraw', 'off', 'on', 'remove'].includes(sub)) {
    ownerSide(`nextlevel note ${sub}`, "The owner writes and changes notes on the dashboard's Notes page, or with this command in their own window. What the team has for the owner goes on a card: nextlevel handoff add, or handoff answer, --file <path>.");
  }
  switch (sub) {
    case undefined:
    case 'list':
      return listNotes(store, a, print);
    case 'add': {
      const text = freeText(a, rest.join(' '), c, 'the note');
      need(text.trim(), 'add "text" [--rule]   (or: add --file <path> [--rule])');
      const n = store.notes.add({ text, type: a.rule ? 'rule' : 'once' });
      return said(n, `Added ${n.id} (${n.type === 'rule' ? 'a standing rule' : 'a one-time instruction'}). The orchestrator reads it at its next start or round.`);
    }
    case 'edit': {
      need(rest[0], 'edit <id> "the new text"   (or: edit <id> --file <path>)');
      const text = freeText(a, rest.slice(1).join(' '), c, 'the new text');
      need(text.trim(), 'edit <id> "the new text"   (or: edit <id> --file <path>)');
      const n = store.notes.edit(rest[0], text);
      return said(n, `Changed ${n.id}: the orchestrator reads it again.`);
    }
    case 'withdraw': {
      need(rest[0], 'withdraw <id>');
      const n = store.notes.withdraw(rest[0]);
      return said(n, `Withdrew ${n.id}.`);
    }
    case 'off':
    case 'on': {
      need(rest[0], `${sub} <id>`);
      const n = store.notes.setOff(rest[0], sub === 'off');
      return said(n, sub === 'off' ? `Switched ${n.id} off: the orchestrator doesn't follow it until you switch it on.` : `Switched ${n.id} on: the orchestrator follows it again.`);
    }
    case 'remove': {
      need(rest[0], 'remove <id>');
      const n = store.notes.remove(rest[0]);
      return said(n, `Removed the rule ${n.id} (it stays in the history).`);
    }
    case 'seen': {
      need(rest.length, 'seen <id>...');
      const list = store.notes.seen(rest);
      print({ ok: true, items: list }, `Marked seen: ${list.map((n) => n.id).join(', ')}.`);
      return 0;
    }
    case 'done': {
      const reply = freeText(a, flag(a, 'reply'), c, 'the reply');
      need(rest[0] && reply.trim(), 'done <id> --reply "one line: what you did" [--commit <sha>] [--task <task-id>]   (or --file <path> for the reply)');
      const commit = flag(a, 'commit').trim();
      const task = flag(a, 'task').trim();
      if (commit && !/^[0-9a-f]{4,40}$/i.test(commit)) throw new Error(`--commit takes a commit's hash (git log --oneline shows it), not "${commit}"`);
      if (task && !ID_RE.test(task)) throw new Error(`--task takes a task id, not "${task}"`);
      const n = store.notes.done(rest[0], { reply, commit, task });
      return said(n, `${n.id} is done: "${n.reply}". Commit ${store.files.notes} with your next change.`);
    }
    case 'decline': {
      const reply = freeText(a, flag(a, 'reply'), c, 'why');
      need(rest[0] && reply.trim(), 'decline <id> --reply "why"   (or --file <path>)');
      const n = store.notes.decline(rest[0], { reply });
      return said(n, `${n.id} is declined: "${n.reply}".`);
    }
    default:
      throw new Error('usage: nextlevel note [list [--all] [--search <text>]] | seen <id>... | done <id> --reply "..." | decline <id> --reply "..." | add "text" [--rule] | edit <id> "text" | withdraw <id> | off <id> | on <id> | remove <id>   (--file <path>: the text from a file)');
  }
}

// ---------- nextlevel handoff ----------
const PAD = `  ${''.padEnd(5)} ${''.padEnd(9)} `;
const isNew = (x, e) => e.by === 'owner' && ms(e.at) > ms(x.seenAt);
const who = (e) => (e.by === 'team' ? 'the team answered' : 'the owner replied');
const quoted = (text, pad = '') => String(text).split('\n').map((l) => `${pad}> ${l}`.trimEnd());
const plural = (n, word) => `${count(n)} ${word}${n === 1 ? '' : 's'}`;
const linesIn = (s) => String(s).split('\n').length;
// A card's state as the team reads it (FR-018): a done card the team closed as resolved is "closed"
const stateOf = (x) => (x.status === 'done' && x.closedBy === 'team' ? 'closed' : x.status);

// One card in `handoff list`. The owner's words new to the team whole, with their line breaks, unless `short` (the
// output wouldn't fit: then shortened, saying so, with the command that shows them whole); what the team has seen, a
// line; the request, its first line. `handled`: a card in the history, in two lines at most.
function cardLines(x, { handled = false, short = false } = {}) {
  const show = `nextlevel handoff show ${x.id}`;
  const said = (text, n) => cutSaid(quote(text), n, show, String(text).length);
  const [first, ...more] = String(x.what).split('\n');
  const extra = more.filter((l) => l.trim()).length;
  const out = [`  ${x.id.padEnd(5)} ${stateOf(x).padEnd(9)} ${said(first, handled ? 110 : 300)}${extra && !handled ? ` [the request goes on for ${plural(extra, 'more line')}: ${show}]` : ''}`];
  if (!handled && (x.where || x.why)) out.push(`${PAD}${[x.where && `where: ${said(x.where, 300)}`, x.why && `why: ${said(x.why, 300)}`].filter(Boolean).join(' · ')}`);
  for (const e of handled ? x.thread.slice(-1) : x.thread) {
    const top = `${PAD}${who(e)} (${when(e.at)})`;
    const oneLine = !e.text.includes('\n') && e.text.length <= 300;
    if (!handled && isNew(x, e) && !short && !oneLine) out.push(`${top}, ${plural(e.text.length, 'character')}, whole:`, ...quoted(e.text, PAD));
    else out.push(`${top}: "${said(e.text, handled || !isNew(x, e) ? 200 : 600)}"`);
  }
  if (x.status === 'cancelled' && x.note) out.push(`${PAD}cancelled: ${said(x.note, 120)}`);
  if (x.status === 'done' && x.closedBy === 'team' && x.note) out.push(`${PAD}closed by the team: ${said(x.note, 120)}`);
  const again = reopened(x);
  if (again && !handled) out.push(`${PAD}${again}`);
  return out;
}
// An open card the owner reopened (undo Done, FR-018): what it was before, and what that means for the team's work
function reopened(x) {
  if (x.status !== 'open' || !x.reopenedAt) return '';
  const events = eventsOf(x);
  const at = events.map((e) => e.kind).lastIndexOf('reopened');
  const before = events.slice(0, at < 0 ? events.length : at).filter((e) => e.kind !== 'reopened').at(-1);
  const was = !before ? 'closed' : before.kind === 'done' ? 'done by the owner' : before.kind === 'closed' ? 'closed by the team' : 'cancelled by the team';
  const how = x.reopenedHow === 'reply' ? ' by a reply' : x.reopenedHow === 'terminal' ? ' from the terminal' : '';
  return `reopened by the owner${how} ${when(x.reopenedAt)}, after it was ${was}${before?.at ? ` ${when(before.at)}` : ''}: anything the team did since that relied on it being closed may need another look`;
}
const FOOTER = [
  'To answer the owner on a card: write the answer to a file (for example .nextlevel/answer.md, which git ignores), then',
  '  nextlevel handoff answer <id> --file .nextlevel/answer.md',
  "  It is kept whole, line breaks included. Never put the text in the command itself: on Windows it would end at its first line break. The owner's phone gets a message that names the card.",
  'To ask the owner something new: write the request to a file, with a line "Where: ..." (which window, panel or file) and a line "Why: ...", then',
  '  nextlevel handoff add --file <path> [--task <task-id>]   and tell the owner: nextlevel notify "Needs you: <id>" --file <the same path> high',
  'A card whole, with all its replies and answers: nextlevel handoff show <id>',
  'When it is resolved (the owner did it or answered, and nothing is left): write what resolved it to a file, then nextlevel handoff close <id> --file <path>. Cancel (nextlevel handoff cancel <id> --reply "why") only a card no longer needed before the owner acted.',
];
function listHandoff(store, a, print) {
  const items = store.handoff.list();
  const fresh = new Set(store.news().handoff);
  const open = items.filter((x) => x.status === 'open');
  const picked = items.filter((x) => x.status !== 'open' && fresh.has(x.id));
  const history = items.filter((x) => x.status !== 'open' && !fresh.has(x.id));
  const replied = open.filter((x) => fresh.has(x.id)).map((x) => x.id);
  const render = (short) =>
    [
      `Waiting on the owner (${store.files.handoff} is written from them: don't edit it)`,
      ...(open.length ? open.flatMap((x) => cardLines(x, { short: short.has(x.id) })) : ['  nothing']),
      ...(picked.length ? ['', 'Done by the owner, not picked up yet: act on it, then nextlevel handoff seen <id>', ...picked.flatMap((x) => cardLines(x, { short: short.has(x.id) }))] : []),
      ...(replied.length ? ['', `The owner replied to ${replied.join(', ')}: read it, then nextlevel handoff seen <id> (or answer it on the card)`] : []),
      ...(a.all ? ['', 'History', ...(history.length ? history.flatMap((x) => cardLines(x, { handled: true })) : ['  none'])] : []),
      '',
      ...FOOTER,
    ].join('\n');
  // What doesn't fit what the orchestrator's engine shows of one command's output: the owner's new words on the last
  // cards first, shortened saying so (FR-012's budget)
  const fits = (t) => sizeOf(t).bytes <= OUTPUT_BUDGET.bytes && sizeOf(t).lines <= OUTPUT_BUDGET.lines;
  const short = new Set();
  const order = [...open, ...picked].reverse();
  let text = render(short);
  for (const x of order) {
    if (fits(text)) break;
    short.add(x.id);
    text = render(short);
  }
  if (!fits(text)) {
    const part = head(text, { lines: OUTPUT_BUDGET.lines - 3, bytes: OUTPUT_BUDGET.bytes - 400 });
    text = `${part.text}\n[... shortened here: this list has ${sizeText(sizeOf(text))}, lines ${part.last + 1}-${part.total} aren't shown. Each card whole: nextlevel handoff show <id>; all of them: nextlevel handoff list --json]`;
  }
  print({ ok: true, open, news: items.filter((x) => fresh.has(x.id)), history: a.all ? history : [], file: store.files.handoff, store: store.store.handoff }, text);
  return 0;
}

// `handoff show <id> [--from <line>]`: one card, whole, with its replies and answers in time order; in parts that fit
// the budget, each saying where the next starts.
function cardText(x) {
  const out = [`${x.id} · ${stateOf(x)} · asked ${when(x.createdAt)}${x.task ? ` · task ${x.task}` : ''}`, '', 'The request:', ...quoted(x.what)];
  if (x.where) out.push(`where: ${x.where}`);
  if (x.why) out.push(`why: ${x.why}`);
  // (the replies and answers, and the card's closings and reopenings, in time order)
  for (const e of conversation(x)) {
    if (e.text === undefined) out.push('', `${eventWords(e)}.`);
    else out.push('', `${who(e)} (${when(e.at)})${isNew(x, e) ? ', new to you' : ''}, ${plural(e.text.length, 'character')}:`, ...quoted(e.text));
  }
  const again = reopened(x);
  if (again) out.push('', `Now open again: ${again}.`);
  return out.join('\n');
}
function showCard(store, a, id, print) {
  const x = store.handoff.list().find((i) => i.id.toLowerCase() === String(id).trim().toLowerCase());
  if (!x) throw new Error(`there is no "${id}" (nextlevel handoff list --all shows them all)`);
  const from = a.from === undefined ? 1 : Number(a.from);
  if (!Number.isInteger(from) || from < 1) throw new Error('--from needs a line number: 1 or more');
  const text = cardText(x);
  const size = sizeOf(text);
  if (from === 1 && size.bytes <= OUTPUT_BUDGET.bytes && size.lines <= OUTPUT_BUDGET.lines) {
    print({ ok: true, item: x }, text);
    return 0;
  }
  const part = head(text, { from, lines: OUTPUT_BUDGET.lines - 6, bytes: OUTPUT_BUDGET.bytes - 600 });
  const next = part.more ? ` The next part: nextlevel handoff show ${x.id} --from ${part.last + 1}.` : '';
  const top = `Shortened here: ${x.id} has ${sizeText(size)}, and lines ${part.first}-${part.last} are shown below. Read all of it before you answer.${next}`;
  print({ ok: true, item: x }, [top, '', part.text, ...(part.more ? [`[... ${x.id} goes on: lines ${part.last + 1}-${part.total}: nextlevel handoff show ${x.id} --from ${part.last + 1}]`] : [`[the end of ${x.id}]`])].join('\n'));
  return 0;
}

export async function cmdHandoff(argv, ctx) {
  notInSlot('handoff list');
  const { store } = ctx;
  const clean = ctx.redact || ((s) => s);
  const c = { root: store.root };
  const a = commandArgs('handoff', argv);
  const [sub, ...rest] = a._;
  const print = (json, text) => console.log(a.json ? JSON.stringify(json, null, 2) : text);
  const need = (cond, usage) => {
    if (!cond) throw new Error(`usage: nextlevel handoff ${usage}`);
  };
  if (['done', 'reply', 'reopen'].includes(sub)) {
    ownerSide(`nextlevel handoff ${sub}`, "The owner replies or marks a card done on the dashboard's Notes page, or with this command in their own window. The team answers on a card with nextlevel handoff answer <id> --file <path>.");
  }
  switch (sub) {
    case undefined:
    case 'list':
      return listHandoff(store, a, print);
    case 'show':
      need(rest.length === 1, 'show <id> [--from <line>]');
      return showCard(store, a, rest[0], print);
    case 'add': {
      const usage = 'add --file <path> [--task <task-id>]   (the request in the file, with a line "Where: ..." and a line "Why: ...")';
      const fromFile = a.file !== undefined ? parseRequest(freeText(a, rest.join(' '), c, 'the request')) : null;
      const what = fromFile ? fromFile.what : rest.join(' ');
      const where = flag(a, 'where') || fromFile?.where || '';
      const why = flag(a, 'why') || fromFile?.why || '';
      need(what.trim() && where.trim() && why.trim(), `${usage}; or: add "what the owner should do" --where "which window, panel or file" --why "why the team needs it" [--task <task-id>]`);
      const task = (flag(a, 'task') || fromFile?.task || '').trim();
      if (task && !ID_RE.test(task)) throw new Error(`--task takes a task id, not "${task}"`);
      const x = store.handoff.add({ what, where, why, task });
      const tell = fromFile
        ? `nextlevel notify "Needs you: ${x.id}" --file ${argOf(a.file)} high`
        : `nextlevel notify "Needs you: ${cut(quote(firstLine(x.what)), 60).replace(/"/g, "'")}" "${quote(x.what).replace(/"/g, "'")} (where: ${quote(x.where).replace(/"/g, "'")}; why: ${quote(x.why).replace(/"/g, "'")})" high`;
      print({ ok: true, item: x }, `Added ${x.id}. Tell the owner, with the same words: ${tell}`);
      return 0;
    }
    case 'answer': {
      // The text never comes from the command line: through nextlevel.cmd it ends at its first line break (FR-014)
      need(rest.length === 1 && a.file !== undefined, 'answer <id> --file <path>   (write the answer to a file first, for example .nextlevel/answer.md; --file - reads it from stdin. Never the text in the command: on Windows it would end at its first line break.)');
      const x = store.handoff.answer(rest[0], clean(readTextFile(a.file === true ? '' : a.file, { root: c.root })));
      const answer = x.thread.at(-1).text;
      ctx.notify?.(`${ctx.name ? `${ctx.name}: ` : ''}the team answered ${x.id}`, `The team answered on card ${x.id} ("${cut(quote(firstLine(x.what)), 80)}"). Read it, then reply or mark it done, on the dashboard: Notes and handoffs, card ${x.id}.`, 'high');
      print(
        { ok: true, item: x },
        `Answered on ${x.id}: ${plural(answer.length, 'character')} in ${plural(linesIn(answer), 'line')}, kept whole. ` +
          `The owner's phone gets a message that names the card (don't send the answer with nextlevel notify), and the card waits for the owner until they reply or mark it done.`,
      );
      return 0;
    }
    case 'done': {
      const reply = freeText(a, flag(a, 'reply'), c, 'the reply');
      need(rest[0], 'done <id> [--reply "..."]   (or --file <path> for the reply)');
      const was = store.handoff.list().find((i) => i.id.toLowerCase() === rest[0].trim().toLowerCase())?.status;
      const x = store.handoff.done(rest[0], { reply });
      print({ ok: true, item: x }, was === 'done' ? `${x.id}: the team's answer is marked read.` : `${x.id} is done. The team picks it up at its next start or round.`);
      return 0;
    }
    case 'reply': {
      const text = freeText(a, flag(a, 'reply') || rest.slice(1).join(' '), c, 'the reply');
      need(rest[0] && text.trim(), 'reply <id> "your answer"   (or: reply <id> --file <path>)');
      const was = store.handoff.list().find((i) => i.id.toLowerCase() === rest[0].trim().toLowerCase())?.status;
      const x = store.handoff.reply(rest[0], text);
      print({ ok: true, item: x }, was && was !== 'open' ? `Replied to ${x.id}, which is open again: the team sees it at its next start or round.` : `Replied to ${x.id}.`);
      return 0;
    }
    case 'reopen': {
      const x = store.handoff.reopen(rest[0], { how: 'terminal' });
      print({ ok: true, item: x }, `${x.id} is open again, with its whole conversation. The team sees it at its next start or round; what it did since isn't undone.`);
      return 0;
    }
    case 'close': {
      need(rest.length === 1 && a.file !== undefined, 'close <id> --file <path>   (what resolved it, in a file)');
      const x = store.handoff.close(rest[0], { note: clean(readTextFile(a.file === true ? '' : a.file, { root: c.root })) });
      print({ ok: true, item: x }, `${x.id} is closed as resolved: "${x.note}". The owner sees "Closed by the team", and can reopen it.`);
      return 0;
    }
    case 'seen': {
      need(rest.length, 'seen <id>...');
      const list = store.handoff.seen(rest);
      print({ ok: true, items: list }, `Picked up: ${list.map((x) => x.id).join(', ')}.`);
      return 0;
    }
    case 'cancel': {
      const reply = freeText(a, flag(a, 'reply'), c, 'why');
      need(rest[0] && reply.trim(), 'cancel <id> --reply "why it is no longer needed"   (or --file <path>)');
      const x = store.handoff.cancel(rest[0], { reply });
      const said = x.closedInstead
        ? `${x.id}: the owner replied on it, so it is closed as resolved, not cancelled: "${x.note}". Next time use nextlevel handoff close ${x.id} --file <path> for a card the owner acted on.`
        : `${x.id} is cancelled: "${x.note}".`;
      print({ ok: true, item: x }, said);
      return 0;
    }
    default:
      throw new Error('usage: nextlevel handoff [list [--all]] | show <id> | add --file <path> [--task <id>] | answer <id> --file <path> | seen <id>... | close <id> --file <path> | cancel <id> --reply "..." | done <id> [--reply "..."] | reply <id> "..." | reopen <id>   (--file <path>: the text from a file)');
  }
}
