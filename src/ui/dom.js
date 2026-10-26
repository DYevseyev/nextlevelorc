// The page's elements, and a handoff card's conversation (FR-014). Every text goes in as a text node, never parsed as
// HTML: the team's answers on the cards are written by an AI, and this page is where the owner approves the guard's
// held changes. test/handoff.test.mjs renders a card here with an answer that holds a <script>.

// h('li.check.ok', { attr: value, onclick }, child, ...): an element. Children are nodes or text.
export function h(spec, props = {}, ...kids) {
  const [tag, ...classes] = spec.split('.');
  const el = document.createElement(tag || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid !== null && kid !== undefined && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

// A text as it was written, its line breaks kept (the page's CSS: white-space: pre-wrap)
export const textBlock = (text, cls = '') => h(`div.msg-text${cls}`, {}, String(text ?? ''));

// A card's request: its first line is the card's title; the rest, when there is more
export const requestParts = (what) => {
  const [first, ...more] = String(what ?? '').split('\n');
  return { title: first.trim(), rest: more.join('\n').trim() };
};

// The replies and answers after a card's request, in time order: whose, when, and the text whole. The team's newest
// answer is marked while it waits for the owner (`x.unread`). `when(iso)`: the time as the page says it. `fold` (the
// cards redesign): all but the last `fold` entries fold into one "N earlier messages" line, open when `open` says so
// (`onToggle(open)` keeps it across redraws); the team's newest answer never folds while it waits for the owner.
// `events` (undo Done, FR-018): the card's closings and reopenings, each a line in time order, in `eventLabel(e)`'s words.
export function threadView(x, { when = (iso) => String(iso || ''), fold = 0, open = false, onToggle, events = [], eventLabel = (e) => e.kind } = {}) {
  const thread = Array.isArray(x.thread) ? x.thread : [];
  const lastTeam = thread.map((e) => e.by).lastIndexOf('team');
  const ms = (iso) => Date.parse(iso || '') || 0;
  const all = [...thread.map((e, i) => ({ e, i, k: 0 })), ...(Array.isArray(events) ? events : []).map((e, i) => ({ e, i, k: 1 }))]
    .sort((a, b) => ms(a.e.at) - ms(b.e.at) || a.k - b.k || a.i - b.i);
  if (!all.length) return null;
  const item = ({ e, i, k }) => {
    if (k === 1) return h('li.event', {}, h('span', {}, eventLabel(e)), e.at ? h('span.msg-when', {}, ` ${when(e.at)}`) : null);
    const team = e.by === 'team';
    const fresh = team && i === lastTeam && !!x.unread;
    return h(
      `li.msg.${team ? 'by-team' : 'by-owner'}${fresh ? '.unread' : ''}`,
      {},
      h('div.msg-head', {}, h('span.msg-who', {}, team ? 'The team answered' : 'You replied'), e.at ? h('span.msg-when', {}, when(e.at)) : null, fresh ? h('span.badge.warn', {}, 'New') : null),
      textBlock(e.text),
    );
  };
  const label = { 'aria-label': `${x.id}: replies and answers, oldest first` };
  let cut = fold > 0 ? Math.max(0, all.length - fold) : 0;
  const fresh = all.findIndex((a) => a.k === 0 && a.i === lastTeam);
  if (x.unread && fresh >= 0) cut = Math.min(cut, fresh);
  if (cut < 2) return h('ol.thread', label, all.map(item));
  const earlier = h('details.earlier', { open, ontoggle: onToggle ? (ev) => onToggle(ev.currentTarget.open) : undefined },
    h('summary', {}, `${cut} earlier messages`),
    h('ol.thread', {}, all.slice(0, cut).map(item)));
  return h('div.thread-wrap', {}, earlier, h('ol.thread', label, all.slice(cut).map(item)));
}
