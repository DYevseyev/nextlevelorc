// The dashboard's Project page (M11): what the project is, its roadmap, its pace and its decisions, from the files
// the orchestrator keeps (docs/PROJECT.md, the milestone table of docs/STATUS.md, docs/plans/<milestone>.md,
// docs/DECISIONS.md), the brief's milestones and the hub's own job records. Pure functions of those texts and
// records, so a test can feed them anything; the hub reads the files and git (hub.mjs, projectView), and so does the
// doctor's project.plans (checks/project.mjs). What is shown as Markdown stays Markdown here: the page renders it (as
// text, never as HTML).

const DAY = 86_400_000;

// A text without a byte-order mark and the templates' HTML comments, with LF line ends. (A file saved by PowerShell
// starts with the mark: a real M0 plan lost its title to it, FR-016.)
export const stripComments = (text) =>
  String(text ?? '')
    .replace(/^\uFEFF/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '');

// These files are written by the team, and since FR-016 the doctor reads them too: every pattern here runs in time
// linear in a line's length. (One with two `\s*` that can share a run of spaces backtracks quadratically, or worse, on
// a line with a long one: FR-016's review found a heading that took minutes.)

// A template's placeholder: "<One or two sentences: what it does.>" or "<...>" (not a link like <https://x.y>, which
// has no space). Each bracketed part is tested on its own.
const isPlaceholder = (text) =>
  [...String(text || '').matchAll(/<([^<>\n]*)>/g)].some(([, inner]) => inner === '...' || inner === '…' || (/^[A-Za-z]/.test(inner) && /\s/.test(inner)));
// The text without the lines that are still placeholders
const filled = (text) =>
  String(text || '')
    .split('\n')
    .filter((l) => !isPlaceholder(l))
    .join('\n')
    .trim();

// A Markdown heading: { level, text }, or null. Its text without the closing #s and the spaces at its end (and a colon
// before them, with `colon`), never its first character; trimmed by hand, from the end.
function heading(line, { colon = false } = {}) {
  const m = /^(#{1,6})\s+(\S.*)$/.exec(line);
  if (!m) return null;
  const text = m[2];
  let end = text.length;
  const back = (re) => {
    while (end > 1 && re.test(text[end - 1])) end--;
  };
  back(/\s/);
  back(/#/);
  back(/\s/);
  if (colon && end > 1 && text[end - 1] === ':') end--;
  back(/\s/);
  return { level: m[1].length, text: text.slice(0, end) };
}

// "## Title" sections of a Markdown text: [{ title, body }] (text before the first one is left out).
export function sections(text) {
  const out = [];
  let cur = null;
  let fence = false;
  for (const line of stripComments(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    const head = !fence && heading(line);
    if (head?.level === 2) {
      cur = { title: head.text.trim(), lines: [] };
      out.push(cur);
    } else if (head?.level === 1) cur = null;
    else if (cur) cur.lines.push(line);
  }
  return out.map((s) => ({ title: s.title, body: s.lines.join('\n').trim() }));
}

// ---------- docs/PROJECT.md: five sections in a fixed format ----------
export const PROJECT_SECTIONS = [
  { key: 'what', title: 'What it is', re: /^what\b/i },
  { key: 'who', title: "Who it's for", re: /^(who|for whom|users?)\b/i },
  { key: 'where', title: 'Where it runs', re: /^(where|links?)\b/i },
  { key: 'how', title: 'How it works', re: /^(how|architecture)\b/i },
  { key: 'state', title: 'Current state', re: /^(current|state|status)\b/i },
];
// { exists, written: how many sections have content, complete, sections: [{ key, title, text }] }
export function parseProjectDoc(text) {
  const found = sections(text);
  const list = PROJECT_SECTIONS.map((s) => {
    const hit = found.find((f) => s.re.test(f.title));
    return { key: s.key, title: s.title, text: filled(hit?.body) };
  });
  const written = list.filter((s) => s.text).length;
  return { exists: text !== null && text !== undefined && text !== '', written, complete: written === list.length, sections: list };
}

// ---------- BRIEF.md: the goal, and the milestones with what is true when each is done ----------
export function parseBrief(text) {
  const found = sections(text);
  const goal = filled(found.find((s) => /^goal\b/i.test(s.title))?.body);
  const table = found.find((s) => /^milestones?\b/i.test(s.title))?.body || '';
  const milestones = tableRows(table).map(([name, what = '']) => ({ key: milestoneKey(name), name, goal: isPlaceholder(what) ? '' : what }));
  return { goal, milestones: milestones.filter((m) => m.name && !isPlaceholder(m.name)) };
}

// The rows of the Markdown tables in a text, without header and separator rows: arrays of cells.
export function tableRows(text) {
  const rows = [];
  let header = true;
  for (const line of stripComments(text).split('\n')) {
    if (!line.trim().startsWith('|')) {
      header = true;
      continue;
    }
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
    if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === '')) continue; // the separator
    if (header && /^milestone/i.test(cells[0])) {
      header = false;
      continue;
    }
    header = false;
    rows.push(cells);
  }
  return rows;
}

// "M2 Sign-up" -> "M2", "Milestone 2: Auth" -> "M2", a task id "M2-03-policy-api" -> "M2", a plan file "m2-auth" or
// "milestone-2" -> "M2". A name without a number: a slug of it.
export function milestoneKey(name) {
  const s = String(name || '').replace(/[*_`]/g, '').trim();
  const m = s.match(/^(?:milestone[\s-]*)?([A-Za-z]{0,3}\d+[a-z]?)\b/i);
  if (m) {
    const k = m[1].toUpperCase();
    return /^\d/.test(k) ? `M${k}` : k;
  }
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

// A task spec's milestone: its "Milestone: M2" line ('' without one).
export function specMilestone(spec) {
  const m = (stripComments(spec).match(/^[ \t]*Milestone:\s*(.+)$/im) || [])[1]?.trim() || '';
  return isPlaceholder(m) || /^M<n>$/i.test(m) ? '' : m;
}

// ---------- docs/plans/<milestone>.md: its header ----------
// The milestone it is for ("Milestone: Walking skeleton", in the header only: FR-016), Outcome (what the owner can do
// when it's done), Acceptance (how we'll know) and Try it (a short demo script), as "Outcome: ...", "**Outcome:** ..."
// or "## Outcome". Real plans also have "Try-it:" and "Try it (accepted local flow; ...):": words in brackets after
// a label stay, in brackets, at the start of its text. A field runs to the next field or heading, or to a new paragraph
// after a blank line (a list or an indented line after a blank line still belongs to it). The header ends at the first
// heading below the title that isn't a field.
const FIELDS = [
  ['outcome', /^outcomes?$/i],
  ['acceptance', /^acceptance(?: criteria)?$/i],
  ['tryIt', /^(?:how to )?try ?it(?: (?:yourself|out))?$/i],
  ['milestone', /^milestone$/i],
];
// A label as written ("Try-it", "**Try it**", "Try it (accepted local flow)"): { field, note } (note: the words in
// brackets after it), or null. The brackets are taken off by hand, so no pattern here repeats inside a repeat.
function fieldOf(label) {
  let name = String(label).replace(/[*_]/g, '').trim();
  let note = '';
  if (name.endsWith(')')) {
    const open = name.lastIndexOf('(');
    note = open < 0 ? '(' : name.slice(open + 1, -1);
    name = name.slice(0, Math.max(open, 0)).trim();
  }
  if (/[()]/.test(note) || !/^[A-Za-z][A-Za-z -]*$/.test(name)) return null;
  name = name.replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
  const field = FIELDS.find(([, re]) => re.test(name))?.[0];
  return field ? { field, note: note.trim() } : null;
}
export function parsePlan(text) {
  const t = stripComments(text);
  const out = { title: (t.match(/^#\s+(.+)$/m) || [])[1]?.trim() || '', milestone: '', outcome: '', acceptance: '', tryIt: '' };
  let cur = null;
  let note = '';
  let inline = false;
  let buf = [];
  let blank = false;
  let fence = false;
  let header = true;
  const flush = () => {
    let body = cur && !out[cur] ? filled(buf.join('\n').replace(/^\n+/, '').trimEnd()) : '';
    if (cur === 'milestone') body = body.split('\n')[0].replace(/[*`]/g, '').trim();
    else if (body && note) body = inline ? `(${note}) ${body}` : `(${note})\n\n${body}`;
    if (body) out[cur] = body;
    cur = null;
    buf = [];
  };
  for (const line of t.split('\n')) {
    if (fence) {
      if (cur) buf.push(line);
      if (/^\s*(```|~~~)/.test(line)) fence = false;
      continue;
    }
    const head = heading(line, { colon: true });
    // (each optional part starts with what isn't a space, so no two \s* share a run of spaces)
    const labeled = line.match(/^\s*(?:[-*+]\s+)?(?:\*\*|__)?([A-Za-z][A-Za-z -]{1,24}?)\s*(?:(?:\*\*|__)\s*)?(?:(\([^()\n]*\))\s*)?(?::\s*(?:\*\*|__)|(?:\*\*|__)\s*:|:)\s*(.*)$/);
    let field = (head && fieldOf(head.text)) || (labeled && fieldOf(`${labeled[1]}${labeled[2] || ''}`));
    if (field?.field === 'milestone' && !header) field = null; // (a "Milestone:" further down is part of the text)
    if (field) {
      flush();
      cur = field.field;
      note = field.note;
      inline = !head && !!labeled[3];
      if (inline) buf.push(labeled[3]);
      blank = false;
      continue;
    }
    if (head) {
      if (head.level > 1) header = false;
      flush();
      continue;
    }
    if (!cur) continue;
    if (!line.trim()) {
      blank = true;
      buf.push('');
      continue;
    }
    if (blank && !/^\s*([-*+]|\d+[.)])\s/.test(line) && !/^\s{2,}\S/.test(line) && !/^\s*(```|~~~)/.test(line)) {
      flush();
      continue;
    }
    blank = false;
    if (/^\s*(```|~~~)/.test(line)) fence = true;
    buf.push(line);
  }
  flush();
  return out;
}

// ---------- which milestone a plan is for (FR-016) ----------
// A real project's orchestrator wrote the Walking skeleton's plan as docs/plans/WS-walking-skeleton.md, and the page looked only
// for docs/plans/walking-skeleton.md: "No plan yet" for a milestone with 33 merged tasks. A plan is found by what it
// says first: its "Milestone:" line (the role doc's form) decides when it names a milestone. Else the better of its
// title and its file name, each naming the milestone's id or name in any common form ("M1", "M1 - Accounts and
// households", M1-accounts-households, accounts-households, WS-walking-skeleton, walking-skeleton, WS), the title when both are
// as good.

// Little words left out when names are compared ("Accounts and households" is accounts-households)
const LITTLE = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'with', 'milestone', 'plan']);
// A name as it is compared: its id ("M1"; '' for a name without a number) and its words without the id, lowercase
function nameParts(text) {
  const key = milestoneKey(text);
  const id = /\d/.test(key) ? key : '';
  let words = String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (words[0] === 'milestone') words = words.slice(1);
  if (id && /\d/.test(words[0] || '')) words = words.slice(1);
  const own = words.filter((w) => !LITTLE.has(w));
  return { id, words: own.length ? own : words };
}
// How well a text names a milestone (m: its nameParts): 4 its id; 3 its name; 2 its name after a short id of another
// kind ("WS-walking-skeleton"); 1 its name with more words after it (a title's "Walking skeleton - one real recipe
// and shopping list") or its initials ("WS"); 0 not at all. Two different ids never match.
function naming(text, m) {
  const t = nameParts(text);
  if (t.id && m.id) return t.id === m.id ? 4 : 0;
  if (!m.words.length || !t.words.length) return 0;
  const same = (a) => a.length === m.words.length && a.every((w, i) => w === m.words[i]);
  const starts = (a) => a.length > m.words.length && m.words.every((w, i) => w === a[i]);
  const rest = t.words.length > 1 && /^[a-z]{1,3}\d*$/.test(t.words[0]) ? t.words.slice(1) : null;
  if (same(t.words)) return 3;
  if (rest && same(rest)) return 2;
  if (starts(t.words) || (rest && starts(rest))) return 1;
  if (!m.id && m.words.length > 1 && t.words.length === 1 && t.words[0] === m.words.map((w) => w[0]).join('')) return 1;
  return 0;
}
// The milestone (of `rows`, each with its `parts`) a text names best: { row, score } or null. Of two as good, the one
// with the longer name ("Walking skeleton" over "Walking"), then the first.
function bestNamed(text, rows) {
  let top = null;
  for (const row of rows) {
    const score = text ? naming(text, row.parts) : 0;
    if (score && (!top || score > top.score || (score === top.score && row.parts.words.length > top.row.parts.words.length))) top = { row, score };
  }
  return top;
}
const baseOf = (plan) => plan.base ?? String(plan.file || '').split('/').pop().replace(/\.md$/i, '');
// A plan's milestone: { row, by: 'header' | 'title' | 'file', score } or null
function planClaim(plan, rows) {
  const header = bestNamed(plan.milestone, rows);
  if (header) return { ...header, by: 'header' };
  const title = bestNamed(plan.title, rows);
  const file = bestNamed(baseOf(plan), rows);
  const pick = title && (!file || title.score >= file.score) ? title : file;
  if (!pick) return null;
  // (its title may name it too, less well than its file name: "Walking skeleton - one real recipe")
  const byTitle = pick === title ? title.score : plan.title ? naming(plan.title, pick.row.parts) : 0;
  return byTitle ? { row: pick.row, by: 'title', score: byTitle } : { ...pick, by: 'file' };
}

// ---------- docs/DECISIONS.md: one card per entry ----------
// "## 2026-09-26 — Postgres, not SQLite" and its paragraphs, or "- 2026-09-25 — **Title.** Why..." with its
// indented lines. Newest first (the file has them newest at the bottom). { date, title, text, resolved }
const DATE = /^\s*(\d{4}-\d{2}-\d{2})\b\s*[—–:·|-]*\s*/;
export function parseDecisions(text) {
  const out = [];
  let cur = null;
  let fence = false;
  const push = () => {
    if (cur) out.push(cur);
    cur = null;
  };
  for (const line of stripComments(text).split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fence = !fence;
    if (fence) {
      cur?.body.push(line);
      continue;
    }
    const head = heading(line);
    if (head && head.level >= 2 && head.level <= 4) {
      push();
      cur = { kind: 'heading', head: head.text, body: [] };
      continue;
    }
    if (head?.level === 1) {
      push();
      continue;
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet && (!cur || cur.kind === 'bullet')) {
      push();
      cur = { kind: 'bullet', head: bullet[1], body: [] };
      continue;
    }
    if (cur?.kind === 'bullet' && line.trim() && !/^\s/.test(line)) {
      push(); // a paragraph after the list isn't part of the last entry
      continue;
    }
    cur?.body.push(line);
  }
  push();
  return out.map(decision).filter((d) => d.title && !isPlaceholder(d.title)).reverse();
}
function decision({ kind, head, body }) {
  let rest = head.trim();
  let date = '';
  const lead = rest.match(DATE);
  if (lead) {
    date = lead[1];
    rest = rest.slice(lead[0].length);
  } else {
    // (on the text without its trailing spaces: a \s* in front of the date would backtrack on a long run of them)
    const tail = rest.trimEnd().match(/[(\[]?(\d{4}-\d{2}-\d{2})[)\]]?$/);
    if (tail) {
      date = tail[1];
      rest = rest.slice(0, tail.index).trimEnd();
    }
  }
  let title = rest;
  let first = '';
  const bold = rest.match(/^(?:\*\*|__)(.+?)(?:\*\*|__)\s*(.*)$/);
  if (bold) [, title, first] = bold;
  else if (kind === 'bullet') {
    const m = rest.match(/^(.+?[.!?])(?:\s+|$)([\s\S]*)$/);
    if (m) [, title, first] = m;
  }
  title = title.replace(/[.:]\s*$/, '').trim();
  const resolved = /^resolved\b/i.test(title);
  if (resolved) title = title.replace(/^resolved\s*[:—–-]?\s*/i, '').replace(/^./, (c) => c.toUpperCase());
  const lines = [first, ...body];
  const indent = Math.min(...lines.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), 99);
  const text = lines.map((l) => l.slice(Math.min(indent, l.match(/^\s*/)[0].length))).join('\n').trim();
  return { date, title, text, resolved };
}

// ---------- the roadmap: one card per milestone ----------
// status: the milestone table of docs/STATUS.md ([{ name, state, verified, done }]); brief: parseBrief();
// plans: [{ file, ...parsePlan(), added }] (added: when git first had the plan); specs: [{ id, milestone,
// title }]; jobs: the hub's task jobs ({ id, state, summary, attempt, engineTitle, switched, createdAt,
// finishedAt, acked }); merged: task id -> when its branch was merged; closed: task id -> its closure (FR-021,
// lib/closures.mjs); plansDir: where the plans are.
// Each milestone has its plan (`by`: how it was found), the other plans that claim it (`rivals`), the fields its plan
// lacks (`missing`), where its plan belongs (`planPath`) and, when it has tasks but no plan, the plans that match no
// milestone (`unmatched`): what planProblems warns about.
const RANK = { header: 3, title: 2, file: 1 };
const FIELD_LABELS = [['outcome', 'Outcome'], ['acceptance', 'Acceptance'], ['tryIt', 'Try it']];
const LIVE = new Set(['queued', 'running', 'verifying']);
export function buildRoadmap({ status = [], brief = { milestones: [] }, plans = [], specs = [], jobs = [], merged = new Map(), closed = new Map(), plansDir = 'docs/plans' } = {}) {
  const rows = [];
  const add = (row) => {
    if (!row.key || rows.some((r) => r.key === row.key)) return null;
    const r = { ...row, parts: nameParts(row.name) };
    rows.push(r);
    return r;
  };
  for (const m of status) add({ key: milestoneKey(m.name), name: m.name, state: m.state || '', verified: m.verified || '', done: !!m.done, inStatus: true });
  for (const m of brief.milestones) add({ key: m.key, name: m.name, state: '', verified: '', done: false, inStatus: false });

  // Each plan's milestone. A plan that names a milestone neither lists by its number becomes one (not a README or
  // notes): by its Milestone line, else its title, else its file name. Then the others are matched again against those.
  const found = plans.map((plan) => ({ plan, claim: planClaim(plan, rows) }));
  for (const f of found.filter((x) => !x.claim)) {
    const [by, own] = [['header', f.plan.milestone], ['title', f.plan.title], ['file', baseOf(f.plan)]].find(([, s]) => s && /\d/.test(milestoneKey(s))) || [];
    if (!own) continue;
    const key = milestoneKey(own);
    const row = rows.find((r) => r.key === key) || add({ key, name: f.plan.milestone || f.plan.title || key, state: '', verified: '', done: false, inStatus: false });
    f.claim = { row, by, score: 4 };
  }
  for (const f of found.filter((x) => !x.claim)) f.claim = planClaim(f.plan, rows);
  // Two plans for one milestone: the one whose Milestone line names it, then title, then file name; then the one that
  // names it best, the one named for it (docs/plans/<its key>.md), the first by name
  const claims = new Map(rows.map((r) => [r.key, []]));
  for (const f of found) if (f.claim) claims.get(f.claim.row.key).push({ plan: f.plan, by: f.claim.by, score: f.claim.score });
  const named = (c, key) => (baseOf(c.plan).toLowerCase() === key.toLowerCase() ? 1 : 0);
  for (const [key, list] of claims) list.sort((a, b) => RANK[b.by] - RANK[a.by] || b.score - a.score || named(b, key) - named(a, key) || String(a.plan.file).localeCompare(String(b.plan.file)));
  const unmatched = found.filter((f) => !f.claim && !/^readme$/i.test(baseOf(f.plan))).map((f) => ({ file: f.plan.file, milestone: f.plan.milestone || '' }));

  const goals = new Map(brief.milestones.map((m) => [m.key, m.goal]));
  // Each task with its milestone: the spec's "Milestone:" line (as a plan's, when it isn't a milestone's key: "WS
  // Walking skeleton"), else the start of its id
  const keyOf = (milestone, id) => {
    const key = milestoneKey(milestone || id);
    return !milestone || claims.has(key) ? key : bestNamed(milestone, rows)?.row.key || key;
  };
  const tasks = new Map();
  const specOf = new Map(specs.map((s) => [s.id, s]));
  for (const s of specs) tasks.set(s.id, { id: s.id, title: s.title || s.id, key: keyOf(s.milestone, s.id), job: null });
  for (const j of jobs) {
    const s = specOf.get(j.id);
    const t = tasks.get(j.id) || { id: j.id, title: j.id, key: keyOf(s?.milestone, j.id) };
    tasks.set(j.id, { ...t, job: j });
  }
  // a merged task branch with no spec or job left (an older project's, a cleaned-up job)
  for (const id of merged.keys()) if (!tasks.has(id)) tasks.set(id, { id, title: id, key: milestoneKey(id), job: null });
  // a closed task whose spec is gone since: where its spec said it belonged (FR-021)
  for (const [id, c] of closed) if (!tasks.has(id)) tasks.set(id, { id, title: c.title || id, key: keyOf(c.milestone, id), job: null });
  // Closed (FR-021): a task closed with `nextlevel close`, unless it was merged or a job of it is queued or running (a
  // merge or an active job always outranks a closure: a dispatch reopens it)
  const closure = (t) => (!merged.has(t.id) && !LIVE.has(t.job?.state) && closed.get(t.id)) || null;
  const current = rows.find((r) => !r.done) || null;
  return rows.map((r) => {
    const [shown, ...rivals] = claims.get(r.key);
    const plan = shown?.plan || null;
    const own = [...tasks.values()].filter((t) => t.key === r.key).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
    const list = own.map((t) => {
      const j = t.job;
      const mergedAt = merged.get(t.id) || '';
      const c = closure(t);
      return {
        id: t.id,
        title: t.title,
        state: mergedAt ? 'merged' : c ? 'closed' : j ? j.state : 'planned',
        summary: mergedAt ? `merged ${mergedAt.slice(0, 10)}` : c ? `closed ${c.at.slice(0, 10)}: ${c.reason}` : j ? j.summary || j.state : 'not dispatched yet',
        attempts: j?.attempt || 0,
        engine: j?.engineTitle || '',
        switched: !!j?.switched,
        worker: j?.worker || '', // the second worker's task says so
        mergedAt,
        ...(c ? { closed: { at: c.at, reason: c.reason, by: c.by, discarded: c.discarded } } : {}),
      };
    });
    // (a closed task's attempts never set the milestone's dates, FR-021)
    const timed = own.filter((t) => !closure(t));
    const starts = [plan?.added, ...timed.map((t) => t.job?.createdAt)].filter(Boolean).map(Date.parse).filter(Number.isFinite);
    const ends = [...timed.map((t) => t.job?.finishedAt), ...timed.map((t) => merged.get(t.id))].filter(Boolean).map(Date.parse).filter(Number.isFinite);
    const open = list.filter((t) => t.state !== 'closed');
    const started = starts.length ? Math.min(...starts) : null;
    const finished = r.done && ends.length ? Math.max(...ends) : null;
    return {
      key: r.key,
      name: r.name,
      state: r.done ? 'done' : r === current ? r.state || (started ? 'in progress' : 'next') : r.state || 'not started',
      done: r.done,
      current: r === current,
      verified: r.verified,
      goal: goals.get(r.key) || '',
      plan: plan && { file: plan.file, title: plan.title, milestone: plan.milestone || '', outcome: plan.outcome, acceptance: plan.acceptance, tryIt: plan.tryIt, by: shown.by },
      planPath: `${plansDir}/${r.key}.md`,
      rivals: rivals.map((c) => ({ file: c.plan.file, by: c.by })),
      missing: plan ? FIELD_LABELS.filter(([k]) => !plan[k]).map(([, label]) => label) : [],
      unmatched: !plan && open.length ? unmatched : [],
      tasks: list,
      // (total: the tasks that count, the closed ones left out and said apart, FR-021)
      counts: {
        total: open.length,
        closed: list.length - open.length,
        merged: list.filter((t) => t.state === 'merged').length,
        running: list.filter((t) => ['running', 'verifying'].includes(t.state)).length,
        queued: list.filter((t) => t.state === 'queued').length,
      },
      started: started ? new Date(started).toISOString() : null,
      finished: finished && finished >= (started || 0) ? new Date(finished).toISOString() : null,
    };
  });
}

// ---------- what the Project page and the doctor's project.plans warn about (FR-016) ----------
// A milestone with tasks but no plan found (with the files in the plans folder that match no milestone), a plan
// without its Outcome, Acceptance or Try it, and two plans that claim one milestone. Each as `text`, which names the
// milestone (the doctor, the top of the page), and `card`, for the milestone's own card. The names in them come from
// files the team writes: a control character in one is shown as "?" (the doctor prints these in a terminal).
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const printable = (s) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, '?');
const and = (list) => (list.length < 3 ? list.join(' and ') : `${list.slice(0, -1).join(', ')} and ${list.at(-1)}`);
const or = (list) => (list.length < 3 ? list.join(' or ') : `${list.slice(0, -1).join(', ')} or ${list.at(-1)}`);
const HOW = { header: 'whose "Milestone:" line names it', title: 'whose title names it', file: 'whose file name names it' };
export function planProblems(roadmap, { plansDir = 'docs/plans' } = {}) {
  const out = [];
  for (const m of roadmap) {
    const add = (kind, card, text) => out.push({ key: m.key, name: printable(m.name), kind, card: printable(card), text: printable(text) });
    const line = `"Milestone: ${m.name}"`;
    const tasks = m.counts?.total || 0;
    if (!m.plan && tasks) {
      const files = (m.unmatched || []).map((u) => `${u.file.split('/').pop()}${u.milestone ? ` (its Milestone line says "${u.milestone}")` : ''}`);
      const why = `no file in ${plansDir}/ names it.${files.length ? ` Files there that match no milestone: ${files.join(', ')}.` : ''} Its plan goes in ${m.planPath}, with the line ${line} under its title.`;
      add('none', `It has ${plural(tasks, 'task')} but no plan: ${why}`, `${m.name} has ${plural(tasks, 'task')} but no plan: ${why}`);
    }
    // (which plan is shown before what it lacks)
    if (m.plan && m.rivals?.length) {
      const files = and([m.plan.file, ...m.rivals.map((r) => r.file)]);
      const n = m.rivals.length + 1;
      // (as good a claim as another's: which one is the plan only its Milestone line can say)
      const tie = m.rivals.some((r) => r.by === m.plan.by);
      const keep = `keep one plan per milestone in ${plansDir}/`;
      const shown = tie ? `The page shows ${m.plan.file}. Put the line ${line} under the right one's title, and ${keep}.` : `The page shows ${m.plan.file}, ${HOW[m.plan.by]}. ${keep[0].toUpperCase()}${keep.slice(1)}.`;
      add('rivals', `${n} plans claim it: ${files}. ${shown}`, `${m.name}: ${n} plans claim it, ${files}. ${shown}`);
    }
    if (m.plan && m.missing?.length) {
      const lacks = `has no ${or(m.missing)} (${m.missing.length === 1 ? 'a line' : 'lines'} ${and(m.missing.map((f) => `"${f}:"`))} in its header)`;
      add('fields', `Its plan, ${m.plan.file}, ${lacks}.`, `${m.name}: its plan, ${m.plan.file}, ${lacks}.`);
    }
  }
  return out;
}

// ---------- what the hub and the doctor read the roadmap from ----------
// A task spec in the tasks folder (not the template, nor the bridge test's), and a task that isn't the bridge test
export const isTaskSpec = (file) => /\.md$/i.test(file) && !file.startsWith('_') && !file.startsWith('T000-bridge-');
export const isBridgeTask = (id) => /^T000-bridge-/.test(id);
// When each task branch was merged, from `git <MERGES_LOG>` (newest first): `nextlevel merge` says task/<id> in its
// subject. Not the hub's "Merge main into task/<id>" before a retry (FR-008): that one is inside the task branch.
// And the hub's finished merge jobs (`mergeJobs`: [{ task, at }], FR-021): before FR-021 a merge given its own -m text
// named the branch only if the text did, and a branch "merged already" makes no merge commit; the hub merged them all.
export const MERGES_LOG = ['log', '--merges', '--format=%cI%x09%s', '-n', '2000'];
const TASK_IN = /\btask\/([A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])/;
export function mergedTasks(log, mergeJobs = []) {
  const merged = new Map();
  for (const line of String(log || '').split(/\r?\n/)) {
    const tab = line.indexOf('\t');
    const m = tab > 0 && !/\binto task\//.test(line) && TASK_IN.exec(line.slice(tab + 1));
    if (m && !merged.has(m[1])) merged.set(m[1], line.slice(0, tab));
  }
  for (const j of mergeJobs) if (j?.task && !merged.has(j.task)) merged.set(j.task, typeof j.at === 'string' ? j.at : '');
  return merged;
}
// The message of the hub's merge commit (FR-021): the -m text, its first line starting with "Merge task/<id>: " unless
// that line names the branch first, so the merge log always names the task (mergedTasks). A line that says "into task/"
// (what mergedTasks reads as the hub's merge of the base branch into a task's) goes below the subject instead.
export function mergeMessage(id, message) {
  const [first = '', ...rest] = String(message || '').split(/\r?\n/);
  const plain = `Merge branch 'task/${id}'`;
  if (!first.trim()) return [plain, ...rest].join('\n');
  if (/\binto task\//.test(first)) return [plain, '', first, ...rest].join('\n');
  const m = TASK_IN.exec(first);
  return (m && m[1] === id ? [first, ...rest] : [`Merge task/${id}: ${first}`, ...rest]).join('\n');
}
// The hub's finished merge jobs, for mergedTasks: from each git job's status and job records ({ id, state, finishedAt }
// and { op, task }), those that merged
export const mergeJobsDone = (list) => list.filter(({ status, job }) => status?.state === 'done' && job?.op === 'merge' && typeof job.task === 'string').map(({ status, job }) => ({ task: job.task, at: status.finishedAt || '' }));

// ---------- pace: when it started, what is done, and a rough estimate for the rest ----------
// The estimate is the pace so far (the days from the first start to the last finish, per finished milestone, gaps
// included), times the milestones left, less the time the current one has already had. Labeled as a guess.
export function pace(roadmap, now = Date.now()) {
  const t = (iso) => (iso ? Date.parse(iso) : null);
  const starts = roadmap.map((m) => t(m.started)).filter(Boolean);
  const done = roadmap.filter((m) => m.done);
  const finishes = done.map((m) => t(m.finished)).filter(Boolean);
  const started = starts.length ? Math.min(...starts) : null;
  const lastFinished = finishes.length ? Math.max(...finishes) : null;
  const left = roadmap.filter((m) => !m.done);
  const out = {
    total: roadmap.length,
    done: done.length,
    left: left.length,
    started: started ? new Date(started).toISOString() : null,
    lastFinished: lastFinished ? new Date(lastFinished).toISOString() : null,
    days: started ? Math.max(0, ((lastFinished && !left.length ? lastFinished : now) - started) / DAY) : 0,
    perMilestone: null,
    basis: 0,
    estimate: null,
    why: '',
  };
  if (!roadmap.length) return { ...out, why: 'No milestones yet: the orchestrator lists them in its status file as it plans.' };
  if (!left.length) return { ...out, why: 'Every milestone is done.' };
  const timed = done.filter((m) => m.finished);
  if (!started || !lastFinished || !timed.length) {
    return { ...out, why: 'No estimate yet: it needs at least one finished milestone with its start and finish dates.' };
  }
  const perMilestone = Math.max((lastFinished - started) / DAY / timed.length, 0.04); // an hour at least
  const cur = left.find((m) => m.current && m.started);
  const had = cur ? Math.min(perMilestone, (now - t(cur.started)) / DAY) : 0;
  const days = Math.max(left.length * perMilestone - had, 0);
  return { ...out, perMilestone, basis: timed.length, estimate: { days, by: new Date(now + days * DAY).toISOString() } };
}
