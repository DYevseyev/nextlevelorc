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
// answer is marked while it waits for the owner (`x.unread`). `when(iso)`: the time as the page says it.
export function threadView(x, { when = (iso) => String(iso || '') } = {}) {
  const thread = Array.isArray(x.thread) ? x.thread : [];
  if (!thread.length) return null;
  const lastTeam = thread.map((e) => e.by).lastIndexOf('team');
  return h(
    'ol.thread',
    { 'aria-label': `${x.id}: replies and answers, oldest first` },
    thread.map((e, i) => {
      const team = e.by === 'team';
      const fresh = team && i === lastTeam && !!x.unread;
      return h(
        `li.msg.${team ? 'by-team' : 'by-owner'}${fresh ? '.unread' : ''}`,
        {},
        h('div.msg-head', {}, h('span.msg-who', {}, team ? 'The team answered' : 'You replied'), e.at ? h('span.msg-when', {}, when(e.at)) : null, fresh ? h('span.badge.warn', {}, 'New') : null),
        textBlock(e.text),
      );
    }),
  );
}
