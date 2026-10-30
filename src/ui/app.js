// The nextlevel dashboard page. It talks only to the server that served it (src/dashboard.mjs). Its key (FR-017 part
// 2A): the link has a one-time code, which the page trades for a session key as it loads, keeps in this tab's session
// storage (a reload keeps working; another tab needs a new link) and sends in a header with every request; the code
// leaves the address bar at once. Live data arrives as server-sent events, read with fetch (EventSource can't send a
// header): `checks` (the Setup page) and `build` (every other page: Home, Build, Team, Tools).
// Text from the server is always put in as text (h(), dom.js), never parsed as HTML.
import { h, requestParts, textBlock, threadView } from './dom.js';

const KEY_STORE = 'nextlevel-session-key';
const linkCode = new URLSearchParams(location.search).get('code') || '';
// The code out of the address bar (and of what this tab's history shows) before anything else happens
if (location.search) history.replaceState(null, '', `${location.pathname}${location.hash}`);
let sessionKey = '';
try {
  sessionKey = sessionStorage.getItem(KEY_STORE) || '';
} catch {
  // no session storage: this tab works until it reloads
}
const $ = (sel) => document.querySelector(sel);

// The key is no good (the dashboard was started again, or this tab never had one): only how to open it again
function keyGone(why = 'This page has no key for the dashboard.') {
  sessionKey = '';
  try {
    sessionStorage.removeItem(KEY_STORE);
  } catch {
    // nothing kept
  }
  document.body.replaceChildren(h('main', {}, h('h1', {}, 'nextlevel dashboard'), h('p', {}, why),
    h('p', {}, 'To open the dashboard, double-click START.cmd in your project\'s folder and choose d, or type nextlevel ui in PowerShell in your project\'s folder. Your browser opens it with a new link, which works once.')));
}

async function api(path, body) {
  const opts = body === undefined
    ? { headers: { 'x-nextlevel-token': sessionKey } }
    : { method: 'POST', headers: { 'x-nextlevel-token': sessionKey, 'content-type': 'application/json' }, body: JSON.stringify(body) };
  try {
    const res = await fetch(path, opts);
    let data = {};
    try {
      data = await res.json();
    } catch {
      // no body
    }
    if (res.status === 403 && data.nokey) keyGone('This page\'s key is no good any more: the dashboard was started again.');
    return { ...data, status: res.status, ok: res.ok && data.ok !== false };
  } catch (err) {
    return { ok: false, status: 0, message: `The dashboard isn't answering (is its window still open?): ${err.message}` };
  }
}
// The link's code traded for this tab's key, once, before the page asks for anything: true when the page has a key
const ready = (async () => {
  if (!linkCode) return !!sessionKey;
  const r = await api('/api/session', { code: linkCode });
  if (r.ok && r.key) {
    sessionKey = r.key;
    try {
      sessionStorage.setItem(KEY_STORE, sessionKey);
    } catch {
      // kept in the page only: a reload needs a new link
    }
    return true;
  }
  return !!sessionKey; // (a used link opened again in a tab that has its key already)
})();

// ---------- small things ----------
const time = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const minutesSince = (iso) => (iso ? Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000)) : 0);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
// hub.log lines start with an ISO time: shown as this PC's time of day
const localTime = (line) => line.replace(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+/, (all, iso) => `${new Date(iso).toLocaleTimeString()}  `);

function toast(message, kind = 'info') {
  if (!message) return;
  const el = h(`div.toast.${kind}`, { role: kind === 'error' ? 'alert' : 'status' }, message);
  $('#toasts').append(el);
  setTimeout(() => el.classList.add('gone'), kind === 'error' ? 12000 : 6000);
  setTimeout(() => el.remove(), kind === 'error' ? 12600 : 6600);
}

async function copy(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const area = h('textarea', {}, text);
    document.body.append(area);
    area.select();
    document.execCommand('copy');
    area.remove();
  }
  const was = button.textContent;
  button.textContent = 'Copied';
  button.classList.add('done');
  setTimeout(() => {
    button.textContent = was;
    button.classList.remove('done');
  }, 1500);
}
const copyButton = (text, label = 'Copy') => h('button.btn.small.copy', { type: 'button', title: 'Copy to the clipboard', onclick: (e) => copy(text, e.currentTarget) }, label);

// A command to type, with where to type it: the one thing FR-001 #8 is about.
function command(where, cmd, { windowKind = 'terminal', cwd } = {}) {
  return h('div.step', {}, whereBox(where, windowKind, cwd), h('div.cmd', {}, h('code', {}, cmd), copyButton(cmd)));
}

// A few Markdown bits of docs/CHECKS.md: paragraphs, `code` and **bold**.
function mini(text) {
  const out = h('div.doc');
  for (const para of String(text || '').split(/\n\s*\n/)) {
    const p = h('p');
    for (const part of para.replace(/\s*\n\s*/g, ' ').split(/(`[^`]+`|\*\*[^*]+\*\*)/)) {
      if (/^`.*`$/.test(part)) p.append(h('code', {}, part.slice(1, -1)));
      else if (/^\*\*.*\*\*$/.test(part)) p.append(h('strong', {}, part.slice(2, -2)));
      else if (part) p.append(part);
    }
    out.append(p);
  }
  return out;
}

// ---------- Markdown, as the team writes it (docs/PROJECT.md, the plans, Blockers, DECISIONS.md) ----------
// Headings, paragraphs, lists (nested by their indent), code blocks, tables and quotes; `code`, **bold**, *italic*,
// ~~struck~~ and links inline. Built as elements from text: nothing is parsed as HTML, and only http(s) addresses
// become links (a link to a file in the project shows its text, with the path on hover).
const SAFE_URL = /^https?:\/\/[^\s<>"']+$/i;
const INLINE = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)|\*\*(.+?)\*\*|__(.+?)__|~~(.+?)~~|\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)|<(https?:\/\/[^>\s]+)>|(https?:\/\/[^\s<>()]*[^\s<>().,;:!?'"*_])|(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?![\s_])([^_\n]+?)_(?![\w_])/g;
const outLink = (href, ...kids) => h('a', { href, target: '_blank', rel: 'noreferrer noopener' }, ...kids);
function inline(text) {
  const out = [];
  let at = 0;
  for (const m of String(text || '').matchAll(INLINE)) {
    if (m.index > at) out.push(text.slice(at, m.index));
    if (m[1]) out.push(h('code', {}, m[2].trim()));
    else if (m[3] || m[4]) out.push(h('strong', {}, inline(m[3] || m[4])));
    else if (m[5]) out.push(h('s', {}, inline(m[5])));
    else if (m[6]) out.push(SAFE_URL.test(m[7]) ? outLink(m[7], inline(m[6])) : h('span.reflink', { title: m[7] }, inline(m[6])));
    else if (m[8] || m[9]) out.push(outLink(m[8] || m[9], m[8] || m[9]));
    else if (m[10] || m[11]) out.push(h('em', {}, inline(m[10] || m[11])));
    at = m.index + m[0].length;
  }
  if (at < String(text || '').length) out.push(text.slice(at));
  return out;
}
const indentOf = (l) => l.match(/^[ \t]*/)[0].replace(/\t/g, '    ').length;
const ITEM = /^([ \t]*)([-*+]|\d+[.)])\s+(.*)$/;
function mdList(lines, i, into) {
  const base = indentOf(lines[i]);
  const first = lines[i].match(ITEM);
  const ordered = /\d/.test(first[2]);
  const el = h(ordered ? 'ol' : 'ul');
  if (ordered && parseInt(first[2], 10) > 1) el.setAttribute('start', String(parseInt(first[2], 10)));
  let li = null;
  let text = [];
  const done = () => {
    if (li && text.length) li.prepend(...inline(text.join(' ')));
    text = [];
  };
  while (i < lines.length) {
    const l = lines[i];
    if (!l.trim()) {
      const next = lines[i + 1];
      if (next !== undefined && next.trim() && indentOf(next) >= base && (ITEM.test(next) || indentOf(next) > base)) {
        i++;
        continue;
      }
      break;
    }
    const m = l.match(ITEM);
    if (m && indentOf(l) < base) break;
    if (m && indentOf(l) <= base + 1) {
      done();
      li = h('li');
      el.append(li);
      text = [m[3]];
      i++;
    } else if (m) {
      done();
      i = mdList(lines, i, li || el);
    } else {
      text.push(l.trim());
      i++;
    }
  }
  done();
  into.append(el);
  return i;
}
function mdTable(lines, i, into) {
  const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
  const head = cells(lines[i]);
  const body = [];
  for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) body.push(cells(lines[i]));
  into.append(h('div.md-table', {}, h('table', {}, h('thead', {}, h('tr', {}, head.map((c) => h('th', {}, inline(c))))), h('tbody', {}, body.map((r) => h('tr', {}, r.map((c) => h('td', {}, inline(c)))))))));
  return i;
}
function md(text, cls = 'md') {
  const root = h(`div.${cls}`);
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let para = [];
  const flush = () => {
    if (para.length) root.append(h('p', {}, inline(para.join(' '))));
    para = [];
  };
  for (let i = 0; i < lines.length; ) {
    const line = lines[i];
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !lines[i].trim().startsWith(fence[1]); i++) code.push(lines[i]);
      root.append(h('pre.code', {}, code.join('\n')));
      i++;
    } else if (!line.trim()) {
      flush();
      i++;
    } else if (/^#{1,6}\s/.test(line)) {
      flush();
      root.append(h('h5', {}, inline(line.replace(/^#+\s+/, '').replace(/\s+#+\s*$/, ''))));
      i++;
    } else if (ITEM.test(line)) {
      flush();
      i = mdList(lines, i, root);
    } else if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      flush();
      i = mdTable(lines, i, root);
    } else if (/^\s*>/.test(line)) {
      flush();
      const quote = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) quote.push(lines[i].replace(/^\s*>\s?/, ''));
      root.append(h('blockquote', {}, md(quote.join('\n'))));
    } else {
      para.push(line.trim());
      i++;
    }
  }
  flush();
  return root;
}


// ---------- tabs ----------
const TABS = ['home', 'project', 'setup', 'build', 'team', 'security', 'tools', 'notes'];
// A card's own address (the cards redesign): #H29 is the Notes page with that card open
const CARD_HASH = /^#(H[1-9]\d{0,6})$/;
const hashCard = () => (CARD_HASH.exec(location.hash) || [])[1] || null;
const currentTab = () => (hashCard() ? 'notes' : TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'home');
function showTab() {
  const tab = currentTab();
  const card = hashCard();
  if (card) {
    cards.openId = card;
    cards.focus = card;
  }
  for (const t of TABS) {
    $(`#tab-${t}`).hidden = t !== tab;
    document.querySelector(`[data-tab="${t}"]`).classList.toggle('active', t === tab);
    document.querySelector(`[data-tab="${t}"]`).setAttribute('aria-current', t === tab ? 'page' : 'false');
  }
  if (tab === 'notes') cards.data ? renderCards() : loadCards();
  if (tab === 'project') proj.data ? renderProject() : loadProject();
  if (tab === 'security') sec.data ? renderSecurity() : loadSecurity();
  renderAll();
}
window.addEventListener('hashchange', showTab);
const goTo = (tab) => {
  location.hash = `#${tab}`;
  window.scrollTo(0, 0);
};
// A card, open, from anywhere on the page (Home's Needs you, Blockers, a held task): its own address
function goToCard(id) {
  if (!id) return goTo('notes');
  cards.openId = id;
  cards.focus = id;
  if (location.hash === `#${id}`) showTab();
  else location.hash = `#${id}`;
}

// ---------- Setup ----------
let checks = null;
let docs = {};
const openDocs = new Set();
const MARK = { error: 'To fix', warn: 'Warning', info: 'Note', ok: 'OK', skip: 'Skipped' };

// Where a step goes, in words: the window (a pill), and the folder to be in there.
const whereBox = (label, windowKind, cwd) => h('div.where-box', {}, h(`span.where.w-${windowKind}`, {}, label), cwd ? h('span.in', {}, `in ${cwd}`) : null);
function stepItem(s) {
  const li = h('li.step', {}, whereBox(s.label, s.window, s.cwd));
  if (s.command) {
    const link = s.window === 'browser' && /^https?:\/\/\S+$/.test(s.command);
    const shown = link ? h('a', { href: s.command, target: '_blank', rel: 'noreferrer noopener' }, s.command) : h('code', {}, s.command);
    li.append(h('div.cmd', {}, shown, copyButton(s.command)));
  }
  if (s.text) li.append(h('span.note', {}, s.text));
  return li;
}

function checkRow(r) {
  const kind = r.status === 'fail' ? r.severity : r.status;
  const busy = checks.running || !!checks.fixing;
  const fixing = checks.fixing === r.id;
  const li = h(`li.check.${kind}`, { id: `check-${r.id}`, dataset: { id: r.id } });
  const fixButton =
    r.status === 'fail' && r.autoFix
      ? h('button.btn.primary.fix', { type: 'button', disabled: busy, onclick: () => runFix(r) }, fixing ? 'Fixing…' : 'Fix')
      : null;
  li.append(
    h('div.check-head', {},
      h(`span.mark.${kind}`, {}, MARK[kind] || kind),
      h('span.title', {}, r.title),
      h('span.detail', {}, r.detail),
      fixButton),
  );
  if (r.status !== 'fail') {
    if (r.next) li.append(h('p.next', {}, r.next));
  } else {
    if (r.next) li.append(h('p.next', {}, r.next));
    if (r.message) li.append(h('pre.message', {}, r.message));
    else if (r.steps.length) li.append(h('ol.steps', {}, r.steps.map(stepItem)));
    if (r.fixable && !r.autoFix) {
      li.append(h('p.hint', {}, 'This installs or updates a program, so type it yourself in the window named above: installers ask for permission and show their progress. This page checks again when you come back to it.'));
    }
  }
  const last = checks.lastFix;
  if (last && last.id === r.id) {
    const verdict = last.ran ? (last.fixed ? 'Fixed.' : 'The fix ran, but the check still fails:') : `Not fixed: ${last.reason}.`;
    li.append(h(`div.fixlog.${last.fixed ? 'good' : 'bad'}`, {}, h('strong', {}, verdict), last.log?.length ? h('pre', {}, last.log.join('\n')) : null));
  }
  const extra = [r.source ? h('span.muted', {}, `from ${r.source}`) : null];
  if (docs[r.id]) {
    const d = h('details.learn', { open: openDocs.has(r.id), ontoggle: (e) => (e.currentTarget.open ? openDocs.add(r.id) : openDocs.delete(r.id)) }, h('summary', {}, 'What this checks'), mini(docs[r.id]));
    extra.push(d);
  }
  // nextlevel's own checks only: a project's own check is about the project, not nextlevel
  if (r.status === 'fail' && r.severity !== 'info' && !r.source) {
    extra.push(h('button.btn.small.report', { type: 'button', title: "Shows a report for nextlevel's developers; it is filed only when you say so", onclick: () => openReport(r) }, 'Report and fix'));
  }
  li.append(h('div.check-foot', {}, extra));
  return li;
}

function renderSetup() {
  const c = checks;
  if (!c) return;
  const sum = $('#setup-summary');
  sum.replaceChildren();
  const results = c.results || [];
  const failed = results.filter((r) => r.status === 'fail');
  const errors = failed.filter((r) => r.severity === 'error').length;
  const warns = failed.filter((r) => r.severity === 'warn').length;
  const infos = failed.filter((r) => r.severity === 'info').length;
  if (c.running && !results.length) sum.append(h('span.spinner'), 'Checking this PC and the project… (the first run takes a few seconds)');
  else if (c.error && !results.length) sum.append(h('span.bad', {}, c.error));
  else {
    const parts = [];
    if (errors) parts.push(h('span.pill.error', {}, `${errors} to fix`));
    if (warns) parts.push(h('span.pill.warn', {}, plural(warns, 'warning')));
    if (infos) parts.push(h('span.pill.info', {}, plural(infos, 'note')));
    if (!errors && !warns) parts.push(h('span.pill.ok', {}, 'All good'));
    sum.append(...parts, h('span.muted', {}, c.running ? ' Checking again…' : c.fixing ? ` Fixing "${results.find((r) => r.id === c.fixing)?.title || c.fixing}"…` : ` Checked at ${time(c.at)}.`));
    if (c.running || c.fixing) sum.prepend(h('span.spinner'));
    if (c.error) sum.append(h('span.bad', {}, ` ${c.error}`));
  }
  $('#recheck').disabled = !!(c.running || c.fixing);
  const count = $('#setup-count');
  count.hidden = !(errors + warns);
  count.textContent = String(errors + warns);
  count.className = `count ${errors ? 'error' : 'warn'}`;

  const only = $('#only-problems').checked;
  const list = $('#checks');
  // Checks for another system ("only on win32") don't apply here
  const shown = results.filter((r) => !(r.quiet && r.status === 'skip')).filter((r) => !only || (r.status === 'fail' && r.severity !== 'info') || r.id === c.lastFix?.id);
  list.replaceChildren(...shown.map(checkRow));
  if (only && !shown.length && results.length) list.append(h('li.empty', {}, 'Nothing needs attention.'));
}

async function runFix(r) {
  const res = await api('/api/fix', { id: r.id });
  if (res.ok) toast(`Fixed: ${r.title}.`, 'good');
  else toast(res.message || res.reason || `"${r.title}" is not fixed yet.`, 'error');
}

let lastAsk = 0;
function recheck(force = false) {
  if (!checks || checks.running || checks.fixing) return;
  const age = Date.now() - Date.parse(checks.at || 0);
  if (!force && (age < 10_000 || Date.now() - lastAsk < 10_000)) return;
  lastAsk = Date.now();
  // Check again asks everything afresh; coming back to the page uses slow answers from the last few minutes (FR-010)
  api('/api/checks', { fresh: force });
}
$('#recheck').addEventListener('click', () => recheck(true));
$('#only-problems').addEventListener('change', renderSetup);
// Back from another window (an installer, a sign-in): check again
document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && recheck());
window.addEventListener('focus', () => recheck());
setInterval(() => {
  if (document.visibilityState === 'visible' && checks?.at && Date.now() - Date.parse(checks.at) > 5 * 60_000) recheck();
}, 60_000);

// ---------- Report and fix (M5) ----------
// The report is made by `nextlevel report <id> --json` and shown exactly; only a click on a File button
// sends that text (the server checks it is the same one), and "and fix it" runs `nextlevel fix`, which says
// where to start the fix (Claude Code starts a cloud session only in a terminal, FR-006).
const report = { check: null, data: null, busy: false };
const link = (href, text) => (/^https:\/\/\S+$/.test(String(href || '')) ? h('a', { href, target: '_blank', rel: 'noreferrer noopener' }, text || href) : h('span', {}, text || ''));
function showReport(...nodes) {
  $('#report-body').replaceChildren(...nodes.flat().filter(Boolean));
  $('#report').hidden = false;
}
function closeReport() {
  if (report.busy) return;
  $('#report').hidden = true;
  report.check = null;
  report.data = null;
}
const closeRow = () => h('div.row', {}, h('button.btn', { type: 'button', onclick: closeReport }, 'Close'));
$('#report-close').addEventListener('click', closeReport);
$('#report').addEventListener('click', (e) => e.target === e.currentTarget && closeReport());
document.addEventListener('keydown', (e) => e.key === 'Escape' && !$('#report').hidden && closeReport());

async function openReport(r, { anyway = false } = {}) {
  report.check = r;
  report.data = null;
  $('#report-title').textContent = `Report "${r.title}" to nextlevel's developers`;
  // Its automatic fix first (the Fix button), unless it ran here already: a report is for what it doesn't fix
  const last = checks.lastFix;
  if (r.autoFix && !anyway && !(last && last.id === r.id && last.ran)) {
    return showReport(
      h('p', {}, `"${r.title}" has an automatic fix. Try it first: a report is for what it doesn't fix.`),
      h('div.row', {},
        h('button.btn.primary', { type: 'button', onclick: () => { closeReport(); runFix(r); } }, 'Fix it first'),
        h('button.btn', { type: 'button', onclick: () => openReport(r, { anyway: true }) }, 'Report it anyway'),
        h('button.btn', { type: 'button', onclick: closeReport }, 'Cancel')),
    );
  }
  showReport(h('p', {}, h('span.spinner'), 'Making the report: nextlevel checks everything again first…'));
  const res = await api('/api/report', { id: r.id });
  if (report.check !== r) return; // closed meanwhile
  if (!res.ok) return showReport(h('div.callout.bad', {}, res.message || 'The report was not made.'), closeRow());
  report.data = res;
  showReport(
    h('p', {}, 'This is exactly what will be filed on GitHub: a new ', ...(res.visibility === 'public' ? [h('strong', {}, 'public'), ' '] : []), 'issue in ', h('strong', {}, res.repo), `, labelled ${res.label}.${res.visibility === 'public' ? ' Anyone can read it.' : ''} Nothing is sent until you click a File button.`),
    h('p.muted.small', {}, "It has nextlevel's own facts only: check results, versions, the OS, paths and the last hub log lines. No project code, brief or .env values; secrets are replaced with ***", res.replaced ? ` (${res.replaced} in this one).` : '.'),
    res.earlier ? h('div.callout.warn', {}, `You filed a report for this check on ${String(res.earlier.at).slice(0, 10)}: `, link(res.earlier.url, `#${res.earlier.number}`)) : null,
    h('h4', {}, 'Title'),
    h('pre.report-title', {}, res.title),
    h('h4', {}, 'Text'),
    h('pre.report-text', {}, res.body),
    h('div.row', {},
      h('button.btn.primary', { type: 'button', onclick: (e) => sendReport(true, e.currentTarget) }, 'File it and fix it'),
      h('button.btn', { type: 'button', onclick: (e) => sendReport(false, e.currentTarget) }, 'File it only'),
      h('button.btn', { type: 'button', onclick: closeReport }, 'Cancel')),
  );
}

async function sendReport(fix, button) {
  const d = report.data;
  if (!d || report.busy) return;
  report.busy = true;
  for (const b of $('#report-body').querySelectorAll('button')) b.disabled = true;
  button.textContent = fix ? 'Filing, then preparing the fix…' : 'Filing…';
  const res = await api('/api/report/send', { id: d.id, hash: d.hash, fix });
  report.busy = false;
  if (!res.ok) return showReport(h('div.callout.bad', {}, res.message || 'Not filed.'), closeRow());
  const filed = h('p', {}, res.already ? 'It was filed already: ' : 'Filed: ', link(res.issue.url, `#${res.issue.number}`), res.note || '');
  const later = h('p', {}, 'To have it fixed later, in PowerShell in the project folder: ', h('code', {}, `nextlevel fix ${res.issue.number}`));
  if (!res.fix) return showReport(filed, later, closeRow());
  const f = res.fix; // never started from here: Claude Code starts a cloud session only in a terminal (FR-006)
  return showReport(
    filed,
    h('div.callout.warn', {}, f.message || 'The fix did not start.'),
    f.steps?.length ? h('ol.steps', {}, f.steps.map(stepItem)) : null,
    f.prompt ? [h('h4', {}, 'The prompt, for claude.ai/code'), h('div.cmd', {}, h('code', {}, f.prompt), copyButton(f.prompt))] : null,
    closeRow(),
  );
}

// The fixes started for this project, on top of the Setup page (from the build data)
const FIX_STATE = {
  started: ['wait', () => 'waiting for its pull request to be merged'],
  merged: ['wait', (f) => (f?.toldReleased ? `in ${f.toldReleased}, not installed: update (Home's card) when no hub or worker runs; then the check runs again` : 'merged: it comes with the next release; then the check runs again')],
  fixed: ['good', (f) => `fixed: ${(f.checks || []).length > 1 ? 'they pass' : 'passes'} since nextlevel ${f.head}`],
  'still-failing': ['bad', (f) => {
    const failing = (f.result || []).filter((x) => x.status !== 'ok');
    return `installed (nextlevel ${f.head}), but ${failing.length > 1 ? 'still fail' : 'still fails'}: ${failing.map((x) => x.detail).join('; ')}`;
  }],
  installed: ['good', (f) => `installed (nextlevel ${f.head})`],
  closed: ['bad', () => 'closed without a fix'],
  left: ['bad', (f) => `no longer followed: ${f.note || 'this install moved to another repository'}`],
};
function renderFixes(list) {
  const box = $('#fixes');
  if (!list?.length) return box.replaceChildren();
  box.replaceChildren(
    h('div.fixes', {},
      h('h2', {}, 'Reports and fixes'),
      h('ul', {}, list.map((f) => {
        const [kind, text] = FIX_STATE[f.state] || ['wait', () => f.state];
        return h('li', {},
          link(f.url, `#${f.number}`),
          h('span', {}, f.checkTitles?.length ? f.checkTitles.join(', ') : f.title),
          h(`span.fix-state.${kind}`, {}, text(f)),
          f.session ? link(f.session, 'the session') : null);
      }))),
  );
}


// ---------- the build data: every page but Setup and Owner notes ----------
let build = null;
const openJobs = new Set();
const jobDetails = new Map(); // id -> { data, summary }: fetched again when the job's summary changes
const loading = new Set();
const pending = new Set();

async function control(key, path, body, button) {
  if (pending.has(key)) return;
  pending.add(key);
  if (button) button.disabled = true;
  const res = await api(path, body);
  pending.delete(key);
  toast(res.message || (res.ok ? 'Done.' : 'That did not work.'), res.ok ? 'good' : 'error');
  renderAll();
  return res;
}
const actionButton = (key, text, path, body, primary = false) =>
  h(`button.btn${primary ? '.primary' : ''}`, { type: 'button', disabled: pending.has(key), onclick: (e) => control(key, path, body, e.currentTarget) }, pending.has(key) ? '…' : text);

// A need's action (lib/overview.mjs): a control to post, a page to open, or a check's automatic fix.
function needButton(n, primary = false) {
  const a = n.action;
  if (!a) return null;
  if (a.page) return h(`button.btn${primary ? '.primary' : ''}`, { type: 'button', onclick: () => (a.focus ? goToCard(a.focus) : goTo(a.page)) }, a.label);
  if (a.fix) {
    const r = checks?.results?.find((x) => x.id === a.fix);
    return h(`button.btn${primary ? '.primary' : ''}`, { type: 'button', disabled: !!(checks?.running || checks?.fixing), onclick: () => r && runFix(r) }, checks?.fixing === a.fix ? 'Fixing…' : a.label);
  }
  return actionButton(`need:${a.post}:${JSON.stringify(a.body)}`, a.label, a.post, a.body, primary);
}

// A need's second way (a handoff item's card, to reply to it)
function needMore(n) {
  if (!n.more) return null;
  return h('button.btn', { type: 'button', onclick: () => (n.id ? goToCard(n.id) : goTo(n.more.page)) }, n.more.label);
}

// "Codex · gpt-6 · high": what a job or session runs on
function runsOn(x) {
  const parts = [x.engineTitle || x.engine, x.model || (x.engine ? "its own model" : ''), x.effort].filter(Boolean);
  return parts.join(' · ');
}
const minutesOf = (j) => (j.startedAt ? minutesSince(j.startedAt) : 0);

// ---------- Home: the whole project at a glance ----------
function teamState(b) {
  if (b.hub.stopping) return { kind: 'warn', title: 'Stopping', text: 'The hub finishes the checks in progress, then stops.' };
  if (!b.hub.running) return { kind: 'bad', title: 'Stopped', text: 'The hub is stopped: nothing runs or gets checked.', button: actionButton('hub', 'Start the hub', '/api/hub', { action: 'start' }, true) };
  const tasks = b.active.filter((j) => j.type === 'task').length;
  if (tasks || b.orchestrator) {
    const bits = [tasks ? `${plural(tasks, 'task')} running` : '', b.orchestrator ? (b.orchestrator.mode === 'autopilot' ? 'an autopilot round' : 'the orchestrator open') : ''].filter(Boolean);
    return { kind: 'good', title: 'Running', text: `${bits.join(', ')}.` };
  }
  if (b.autopilot.on && !b.autopilot.paused) return { kind: 'idle', title: 'Waiting', text: 'Nothing runs now: autopilot starts a round when something happens (see Autopilot).' };
  return { kind: 'idle', title: 'Idle', text: 'The hub runs, but nothing is being worked on.' };
}
function autopilotButton(b) {
  const ap = b.autopilot;
  if (ap.on && ap.paused) return actionButton('autopilot', 'Resume', '/api/autopilot', { on: true }, true);
  return ap.on ? actionButton('autopilot', 'Turn off', '/api/autopilot', { on: false }) : actionButton('autopilot', 'Turn on', '/api/autopilot', { on: true }, ap.state === 'fuse');
}
// Run a round now (FR-019): the owner acting, so the hub starts a round at its next look
const runNowButton = (b) => (b.autopilot.runNow ? actionButton('round', 'Run a round now', '/api/round', {}) : null);
// The Autopilot tile's color: what it waits for is a rest, not a problem
const AUTOPILOT_KIND = { off: 'idle', fuse: 'warn', paused: 'warn', interactive: 'warn', limit: 'warn', 'hub-stopped': 'warn', round: 'good', ready: 'good', wake: 'good', waiting: 'idle', braked: 'idle' };
function orchestratorTile(b) {
  const o = b.orchestrator;
  const role = (b.team || []).find((r) => r.key === 'orchestrator');
  if (o) {
    const what = o.mode === 'autopilot' ? 'An autopilot round is running' : 'Open in its own window';
    return { kind: 'good', text: `${what} since ${time(o.since)}.`, sub: runsOn(o) };
  }
  const open = b.windows ? actionButton('orch', 'Open', '/api/open', { what: 'orchestrator' }) : null;
  return { kind: 'idle', text: 'Not running.', sub: role ? runsOn({ engineTitle: role.engineTitle, model: role.model.inUse, effort: role.effort.inUse }) : '', button: open };
}
const tile = (label, kind, title, text, sub, button) =>
  h(`div.tile.k-${kind}`, {}, h('div.tile-label', {}, label), h('div.tile-title', {}, h('span.dot'), title), text ? h('p.tile-text', {}, text) : null, sub ? h('p.tile-sub', {}, sub) : null, button ? h('div.tile-actions', {}, button) : null);

// ---------- the tester (tester part 3): Home's Acceptance card, a card's runs, the Team page's Tester card ----------
// What a run kept is the app's words (made safe when the run wrote it): text nodes only. Screenshots come with the page's
// key like every request, as data: URLs (the page's own policy takes no other images).
const tst = { data: null, at: 0, loading: false, pick: { plan: '', env: '' }, runs: new Map(), loadingRun: new Set(), open: new Set(), shots: new Map() };
async function loadTester(force = false) {
  if (tst.loading || (!force && Date.now() - tst.at < 20_000)) return;
  tst.loading = true;
  const res = await api('/api/tester');
  tst.loading = false;
  tst.at = Date.now();
  tst.data = res.ok ? res : { ok: false, message: res.message || "The tester's state couldn't be read." };
  if (['home', 'team'].includes(currentTab())) renderAll();
}
async function loadRun(id, force = false) {
  if (!id || tst.loadingRun.has(id) || (!force && tst.runs.has(id))) return;
  tst.loadingRun.add(id);
  const res = await api(`/api/tester/run?id=${encodeURIComponent(id)}`);
  tst.loadingRun.delete(id);
  tst.runs.set(id, res.ok ? res.run : { id, missing: res.message || 'This run is gone (only the newest runs are kept).' });
  renderAll();
}
async function loadShot(id, file) {
  const key = `${id}/${file}`;
  if (tst.shots.has(key)) return;
  tst.shots.set(key, '');
  try {
    const res = await fetch(`/api/tester/evidence?id=${encodeURIComponent(id)}&file=${encodeURIComponent(file)}`, { headers: { 'x-nextlevel-token': sessionKey } });
    if (!res.ok) throw new Error(`${res.status}`);
    const blob = await res.blob();
    const url = await new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(blob);
    });
    tst.shots.set(key, /^data:image\/png;base64,/.test(url) ? url : 'gone');
  } catch {
    tst.shots.set(key, 'gone');
  }
  renderAll();
}
const RUN_KIND = { passed: 'good', failed: 'bad', incomplete: 'warn', broken: 'bad', stopped: 'idle', refused: 'warn', asked: 'info', starting: 'info', running: 'info' };
const STEP_KIND = { passed: 'good', failed: 'bad', incomplete: 'warn', refused: 'warn', skipped: 'idle' };
// A run's table: step, persona, status, what it did, expected and actual where a check failed, its time, its evidence
function runTable(run) {
  if (!run) return h('p.muted.small', {}, 'Reading the run…');
  if (run.missing) return h('p.muted.small', {}, run.missing);
  const files = new Set(run.files || []);
  const rows = (run.steps || []).map((st) => {
    const bad = (st.checks || []).filter((c) => !c.ok);
    const shot = `step-${st.n}.png`;
    const key = `${run.id}/${shot}`;
    const src = tst.shots.get(key);
    return h(`tr.k-${STEP_KIND[st.status] || 'idle'}`, {},
      h('td', {}, String(st.n)), h('td', {}, st.as || '-'), h('td.state', {}, st.status || ''),
      h('td', {}, h('div', {}, st.what || ''), bad.map((c) => h('div.small', {}, `expected ${c.expected}; got ${c.actual}`)), st.why ? h('div.small.muted', {}, st.why) : null,
        files.has(shot) ? (src && src !== 'gone' ? h('img.shot', { src, alt: `What step ${st.n} showed (secrets masked)` }) : src === 'gone' ? h('div.small.muted', {}, 'The screenshot is gone.') : h('button.linkish', { type: 'button', onclick: () => loadShot(run.id, shot) }, src === '' ? 'Loading the screenshot…' : 'Show the screenshot')) : null),
      h('td.small.muted', {}, st.ms !== undefined ? `${st.ms} ms` : ''));
  });
  return h('div.run-table', {},
    h(`p.small.k-${RUN_KIND[run.state] || 'idle'}`, {}, h('span.dot'), `Run ${run.id}: ${run.state}${run.why ? ` (${run.why})` : ''} · ${run.plan} on ${run.env}${run.commit ? ` at ${run.commit.slice(0, 8)}` : ''}${run.by ? ` · asked by ${run.by}` : ''}`),
    rows.length ? h('table.run-steps', {}, h('thead', {}, h('tr', {}, h('th', {}, '#'), h('th', {}, 'As'), h('th', {}, 'Status'), h('th', {}, 'Step'), h('th', {}, 'Time'))), h('tbody', {}, rows)) : null,
    h('p.small.muted', {}, 'What a step expected and got comes from the plan and the app. Passwords, tokens and cookies were taken out before anything was kept.'));
}
// The words a card with a plan says (lib/cards.mjs acceptState, as the page says it)
const ACCEPT_BADGE = {
  checking: ['info', 'The tester is checking this'],
  fixing: ['info', 'A step failed: a fix goes to the team'],
  verified: ['good', 'Verified, ready to close'],
  changed: ['warn', 'Passed, but the plan changed'],
  stuck: ['warn', 'Needs you: the fixes didn\'t make it pass'],
  blocked: ['warn', "Needs you: the run couldn't finish"],
};
function acceptBox(x) {
  const a = x.accept;
  const st = x.acceptState || 'checking';
  const last = (a.runs || []).at(-1);
  const fix = (a.fixes || []).at(-1);
  const open = tst.open.has(x.id);
  if (open && last?.id && !['asked', 'starting', 'running'].includes(last.end)) loadRun(last.id);
  return h(`div.accept-box.k-${ACCEPT_BADGE[st]?.[0] || 'info'}`, {},
    h('p', {}, h('strong', {}, ACCEPT_BADGE[st]?.[1] || st), h('span.muted', {}, ` · ${a.plan} on ${a.env}, as committed at ${String(a.commit || '').slice(0, 8)}`)),
    st === 'changed' ? h('p.small', {}, `The plan changed since this card was added${x.planChange ? `: ${x.planChange}` : ''}. Read the run before you close the card: its pass doesn't close it by itself.`) : null,
    st === 'fixing' && fix ? h('p.small', {}, `Step ${last?.step?.n ?? '?'} failed. The fix draft for the team is ${fix.file}; the plan runs again once the fix is merged and deployed.`) : null,
    st === 'stuck' ? h('p.small', {}, `${plural((a.fixes || []).length, 'fix draft')} didn't make step ${last?.step?.n ?? '?'} pass, so the tester writes no more. Look at the run, then reply to the team or close the card.`) : null,
    st === 'blocked' && last ? h('p.small', {}, `The run ended ${last.end}${last.why ? `: ${last.why}` : ''}. That is not the team's to fix (an environment down, the browser missing, a stop): run it again from Home once it is sorted.`) : null,
    last ? h('details', { open, ontoggle: (e) => (e.currentTarget.open ? (tst.open.add(x.id), renderAll()) : tst.open.delete(x.id)) }, h('summary', {}, `The last run (${plural((a.runs || []).length, 'run')} in all)`), open ? runTable(tst.runs.get(last.id)) : null) : null);
}
// Home's Acceptance card: the plans on the base branch, an environment, Run acceptance; the last runs
function testerCard() {
  loadTester();
  const d = tst.data;
  if (!d) return null;
  const card = h('div.card.tester-card', {}, h('h2', {}, 'Acceptance'));
  if (!d.ok) return card.append(h('p.muted', {}, d.message)), card;
  if (!d.on) {
    card.append(h('p.muted', {}, "The tester is off. It runs the project's acceptance plans as the test accounts you name, and closes cards on proof. ", h('button.linkish', { type: 'button', onclick: () => goTo('team') }, 'On the Team page')));
    return card;
  }
  const plans = (d.plans || []).filter((p) => !p.problem && p.envs.length);
  if (!plans.length) card.append(h('p.muted', {}, `No plan on ${d.base} yet: the team writes them in docs/acceptance/ with the features.`));
  else {
    if (!plans.some((p) => p.file === tst.pick.plan)) tst.pick.plan = plans[0].file;
    const plan = plans.find((p) => p.file === tst.pick.plan);
    if (!plan.envs.includes(tst.pick.env)) tst.pick.env = plan.envs[0];
    const busy = pending.has('tester');
    card.append(h('div.row.tester-pick', {},
      h('label', {}, 'Plan ', h('select', { onchange: (e) => { tst.pick.plan = e.target.value; renderAll(); } }, plans.map((p) => h('option', { value: p.file, selected: p.file === tst.pick.plan }, p.name ? `${p.name} (${p.file.replace(/^docs\/acceptance\//, '')})` : p.file.replace(/^docs\/acceptance\//, ''))))),
      h('label', {}, 'on ', h('select', { onchange: (e) => { tst.pick.env = e.target.value; } }, plan.envs.map((e) => h('option', { value: e, selected: e === tst.pick.env }, e)))),
      h('button.btn.primary', { type: 'button', disabled: busy || !!d.running, title: d.running ? `${d.running} runs now: one at a time` : null, onclick: async (e) => {
        await control('tester', '/api/tester', { action: 'run', plan: tst.pick.plan, env: tst.pick.env }, e.currentTarget);
        loadTester(true);
      } }, busy ? '…' : 'Run acceptance')));
  }
  const runs = (d.runs || []).slice(0, 4);
  if (runs.length) {
    card.append(h('ul.runs', {}, runs.map((r) => {
      const open = tst.open.has(r.id);
      if (open) loadRun(r.id, ['asked', 'starting', 'running'].includes(r.state));
      return h('li', {}, h('details', { open, ontoggle: (e) => (e.currentTarget.open ? (tst.open.add(r.id), renderAll()) : tst.open.delete(r.id)) },
        h('summary', {}, h(`span.k-${RUN_KIND[r.state] || 'idle'}`, {}, h('span.dot'), r.state), ` ${r.plan.replace(/^docs\/acceptance\//, '')} on ${r.env}`, h('span.muted.small', {}, ` · ${ago2(r.at)}${r.by ? ` · ${r.by}` : ''}`)),
        open ? runTable(tst.runs.get(r.id)) : null));
    })));
  } else card.append(h('p.muted.small', {}, 'No run yet.'));
  return card;
}
// The Team page's Tester card: on or off, each environment with its personas (set or not), the browser
function testerTeamCard() {
  loadTester();
  const d = tst.data;
  if (!d?.ok) return null;
  const card = h('div.card.role.tester-team', { id: 'tester' },
    h('div.role-head', {}, h('div', {}, h('h2', {}, 'Tester'), h('p.muted.small', {}, 'A program, not a model: it walks each acceptance plan itself, with no tokens, and no AI ever holds a test account\'s password.'))));
  if (!d.on) {
    card.append(h('p', {}, 'Off.'), h('p.small', {}, 'To turn it on, add a "tester" section to nextlevel.json (docs/acceptance.md in nextlevel shows one): your approval of that change on the dashboard turns it on. Then set each test account once:'), command('PowerShell, in the project folder', 'nextlevel tester persona set <environment> <persona>'));
    return card;
  }
  card.append(h('p', {}, h('strong', {}, 'On'), d.store?.problem ? h('span.warn', {}, ` · the secret store: ${d.store.problem}`) : null));
  for (const e of d.environments || []) {
    card.append(h('p.small', {}, h('strong', {}, e.name), ` ${e.url}${e.production ? ' (production)' : ''} · ${e.mutations ? 'steps that change data may run' : 'read-only'}`),
      h('ul.small.personas', {}, e.personas.map((p) => h(`li.${p.set ? 'ok' : 'warn'}`, {}, `${p.persona}: ${p.set ? 'set' : p.old ? 'set for an old URL: set it again' : 'not set'}`))));
    const unset = e.personas.find((p) => !p.set);
    if (unset) card.append(command('PowerShell, in the project folder', `nextlevel tester persona set ${e.name} ${unset.persona}`));
  }
  const br = d.browser || {};
  card.append(h('p.small', {}, `Browser: ${br.ok ? `Playwright ${br.version}, installed` : br.installed ? br.problem : 'not installed (only browser steps need it)'}`));
  if (!br.ok) card.append(command('PowerShell, in the project folder', 'nextlevel tester browser install'));
  return card;
}

// ---------- the security engineer (1a-2): Home's Security card and the Security page ----------
// Everything a scan wrote is the scanner's words about code an attacker may have written: text nodes only, paths and
// URLs as text, never links (P7). Nothing here approves a policy: that is its card's Approve (the guard).
const sec = { data: null, version: null, loading: false, again: false, open: new Set(), showPolicy: false };
async function loadSecurity() {
  if (sec.loading) return (sec.again = true);
  sec.loading = true;
  const res = await api('/api/security');
  sec.loading = false;
  sec.data = res.ok ? res : { ok: false, message: res.message || "The security engineer's scans couldn't be read." };
  if (currentTab() === 'security') renderSecurity();
  if (sec.again) {
    sec.again = false;
    loadSecurity();
  }
}
const VALIDATION = { reproduced: 'Codex Security reproduced it', source: 'validated by source', none: 'not validated' };
const SCAN_KIND = { asked: 'info', starting: 'info', waiting: 'info', running: 'info', done: 'good', failed: 'bad', couldnt: 'bad', stopped: 'idle' };
const cut = (text, max) => {
  const t = String(text ?? '');
  return t.length > max ? `${t.slice(0, max)} (cut: ${t.length - max} more characters)` : t;
};
// Run a security scan, Deep scan (asked first: it spends much more of the plan), or Stop while one is asked or runs
function securityButtons(s) {
  if (!s?.on) return null;
  const busy = pending.has('security');
  const post = (action, button) => control('security', '/api/security', { action }, button);
  if (s.last?.running) return h('span.row', {}, h('button.btn', { type: 'button', disabled: busy, onclick: (e) => post('stop', e.currentTarget) }, busy ? '…' : 'Stop the scan'));
  return h('span.row', {},
    h('button.btn.primary', { type: 'button', disabled: busy, onclick: (e) => post('scan', e.currentTarget) }, busy ? '…' : 'Run a security scan'),
    h('button.btn', { type: 'button', disabled: busy, onclick: (e) => {
      if (!confirm(`A deep scan can take up to ${s.deepMinutes} minutes and uses much more of your Codex plan. Start it?`)) return;
      post('deep', e.currentTarget);
    } }, 'Deep scan'));
}
const scanMinutes = (m) => (!m ? '' : m < 1 ? ', under a minute' : `, ${plural(Math.round(m), 'min')}`);
const scanLine = (l) => `${l.deep ? 'Deep scan' : 'Scan'} ${l.id}: ${l.words}${l.at ? ` (${ago2(l.at)})` : ''}${scanMinutes(l.minutes)}${l.why ? `: ${l.why}` : ''}`;
function securityCard(b) {
  const s = b.security;
  if (!s) return null;
  const card = h('div.card.security-card', {}, h('h2', {}, 'Security'));
  if (!s.on) {
    card.append(h('p.muted', {}, 'The security engineer is off. ', h('button.linkish', { type: 'button', onclick: () => goTo('team') }, 'Turn it on on the Team page')));
    return card;
  }
  if (!s.last) card.append(h('p.muted', {}, 'No scan yet. A scan reads the base branch in a container of its own and changes nothing.'));
  else card.append(h(`p.scan-state.k-${SCAN_KIND[s.last.state] || 'idle'}`, {}, h('span.dot'), scanLine(s.last)));
  if (s.trusted) {
    card.append(h('p', {}, h('strong', {}, s.trusted.counts || 'No findings'), h('span.muted', {}, ` in the last trusted scan (${s.trusted.id}${s.trusted.partial ? ', partial' : ''})`)));
    if (s.trusted.daybreak && /unconfirmed/.test(s.trusted.daybreak)) card.append(h('p.small.warn', {}, 'Daybreak unconfirmed for that scan.'));
  }
  for (const x of s.pending || []) card.append(h('p.small', {}, h('button.linkish', { type: 'button', onclick: () => goToCard(x.card || x.id) }, `A security policy waits for you (${x.card || x.id})`)));
  card.append(h('div.row', {}, securityButtons(s), h('button.btn', { type: 'button', onclick: () => goTo('security') }, 'The Security page')));
  return card;
}

function findingView(f) {
  const open = sec.open.has(f.id);
  const where = (f.where || []).map((l) => `${l.path}${l.line ? `:${l.line}${l.end && l.end !== l.line ? `-${l.end}` : ''}` : ''}`);
  const head = h('summary', {},
    h(`span.sev.sev-${f.severity}`, {}, f.severity),
    h('span.finding-title', {}, cut(f.title, 300)),
    h('span.muted.small', {}, ` ${f.id}${where[0] ? ` · ${where[0]}` : ''} · ${VALIDATION[f.validation?.state] || VALIDATION.none}`));
  const part = (label, text) => (text ? [h('h4', {}, label), h('div.msg-text', {}, cut(text, 4000))] : null);
  return h('details.finding', { open, ontoggle: (e) => (e.currentTarget.open ? sec.open.add(f.id) : sec.open.delete(f.id)) }, head,
    part('What it is', f.what),
    h('p.small', {}, [f.category ? `Category: ${f.category}` : '', f.confidence ? `Confidence: ${f.confidence}` : ''].filter(Boolean).join(' · ')),
    where.length ? [h('h4', {}, 'Where'), h('ul.where-list', {}, where.map((w) => h('li', {}, h('code', {}, w))))] : null,
    part('The evidence', f.evidence),
    h('h4', {}, 'How far it was validated'),
    h('p', {}, VALIDATION[f.validation?.state] || VALIDATION.none, f.validation?.method ? ` (${cut(f.validation.method, 300)})` : ''),
    f.validation?.summary ? h('div.msg-text', {}, cut(f.validation.summary, 1000)) : null,
    part('The suggested fix', f.fix));
}
function renderSecurity() {
  const root = $('#security');
  const d = sec.data;
  if (!d || selecting(root)) {
    if (!d) root.replaceChildren(h('p.muted', {}, 'Loading…'));
    return;
  }
  if (!d.ok) return root.replaceChildren(h('div.callout.bad', {}, d.message));
  const s = build?.security;
  const role = h('div.card', {}, h('h2', {}, 'The security engineer'));
  if (!d.role.on) role.append(h('p.muted', {}, 'Off. ', h('button.linkish', { type: 'button', onclick: () => goTo('team') }, 'Turn it on on the Team page')));
  else {
    role.append(h('p', {}, `Codex, model ${d.role.model || "the scanner's default"}${d.role.effort ? `, effort ${d.role.effort}` : ''}${d.role.daybreak ? ', Daybreak Blue' : ''}${d.role.profile ? ` (profile ${d.role.profile})` : ''}.`),
      h('p.muted.small', {}, 'A scan reads the base branch in OpenAI\'s scanner container, with no network for its commands and nothing of this PC but the code. It changes nothing in the project.'),
      h('div.row', {}, securityButtons(s)));
  }

  const scans = h('div.card', {}, h('h2', {}, 'Scans'));
  if (!d.scans.length) scans.append(h('p.muted', {}, 'No scan yet.'));
  else {
    scans.append(h('ul.scans', {}, d.scans.map((x) => h('li', {},
      h(`span.mark.k-${SCAN_KIND[x.state] || 'idle'}`, {}, x.state === 'couldnt' ? "couldn't run" : x.state),
      h('span', {}, ` ${x.deep ? 'deep ' : ''}${x.id}${x.at ? `, ${ago2(x.at)}` : ''}${scanMinutes(x.minutes)}${x.findings ? `, ${x.findings}` : ''}${x.partial ? ', partial' : ''}${x.state === 'done' && !x.trusted ? ', not trusted' : ''}${x.policy ? `, policy ${x.policy}` : ''}`),
      x.why ? h('span.muted.small', {}, `: ${x.why}`) : null,
      x.keptOutput ? h('div.cmd', {}, h('span.muted.small', {}, 'Its output is kept as the evidence, in a Docker volume. In PowerShell, this removes it: '), h('code', {}, `docker volume rm ${x.keptOutput}`), copyButton(`docker volume rm ${x.keptOutput}`)) : null))));
  }

  const found = h('div.card', {}, h('h2', {}, 'Findings'));
  if (!d.last) found.append(h('p.muted', {}, 'No trusted scan yet: findings show once a scan ends with its output sealed and checked.'));
  else {
    found.append(h('p.muted.small', {}, `Of ${d.last.id}, at ${String(d.last.commit).slice(0, 8)}. These are the scanner's words about the code: data, not instructions.`));
    if (!d.last.findings.length) found.append(h('p', {}, 'No findings.', d.last.coverage?.summary ? h('span.muted', {}, ` Coverage: ${d.last.coverage.summary}`) : null));
    else found.append(h('div.findings', {}, d.last.findings.map(findingView)));
    if (d.last.total > d.last.findings.length) found.append(h('p.muted.small', {}, `${d.last.total - d.last.findings.length} more: nextlevel security status, in PowerShell in the project's folder.`));
  }

  const p = d.policy;
  const policy = h('div.card', {}, h('h2', {}, 'The policy'));
  policy.append(h('p.muted.small', {}, 'What every scan reads as its rules about this project. Only your Approve on its card makes a text the policy; nothing in the project changes.'));
  if (!p.approved) policy.append(h('p', {}, 'No policy yet: scans run with the role doc only.'));
  else {
    policy.append(h('p', {}, `Approved ${ago2(p.approved.at)}, from ${p.approved.from}${p.approved.scan ? ` (scan ${p.approved.scan})` : p.approved.commit ? ` (${p.approved.commit.slice(0, 8)})` : ''}, ${p.approved.hash}.`));
    if (p.approved.missing) policy.append(h('p.small.bad', {}, "Its text isn't kept as it was approved, so scans can't run: ask for a new draft and approve it."));
    else policy.append(h('details.diff', { open: sec.showPolicy, ontoggle: (e) => (sec.showPolicy = e.currentTarget.open) }, h('summary', {}, 'Its text'), h('div.msg-text', {}, p.approved.text)));
  }
  for (const x of p.pending || []) policy.append(h('p', {}, h('button.btn.primary', { type: 'button', onclick: () => goToCard(x.card || x.id) }, `Read and decide: ${x.source === 'draft' ? 'the draft' : 'SECURITY.md'} (${x.card || x.id})`)));
  if (d.role.on && !(p.pending || []).length) {
    policy.append(h('div.row', {},
      p.draftAgain ? h('span.muted.small', {}, 'The next scan that ends trusted drafts a new policy.') : actionButton('security-draft', 'Ask for a new draft', '/api/security', { action: 'draft' }),
      p.rejectedDraftAt ? h('span.muted.small', {}, `A draft was rejected ${ago2(p.rejectedDraftAt)}.`) : null));
  }
  root.replaceChildren(h('div.grid', {}, h('div.col', {}, role, found), h('div.col', {}, scans, policy)));
}

// ---------- Show activity (Home): a running task's progress notes and technical feed ----------
// Collapsed by default; which ones are open is remembered in this browser (the dashboard keeps its port, so the
// page keeps its address). The page asks for a task's activity only while its toggle is open, every 2 seconds.
const activity = new Map(); // task id -> { el, body, data, text, timer }
const ACTIVITY_KEY = 'nextlevel.activity.open';
function openActivity() {
  try {
    const v = JSON.parse(localStorage.getItem(ACTIVITY_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
function rememberActivity(id, open) {
  const ids = openActivity().filter((x) => x !== id);
  if (open) ids.push(id);
  try {
    localStorage.setItem(ACTIVITY_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // a private window: remembered until the page closes
  }
}
const KIND = { command: '$', test: '✓', edit: '✎', tool: '⚙', message: '💬', error: '!', done: '■' };
function drawActivity(a) {
  const d = a.data;
  if (!d) return a.body.replaceChildren(h('p.muted.small', {}, h('span.spinner'), ' Loading…'));
  if (!d.ok) return a.body.replaceChildren(h('p.muted.small', {}, d.message || 'No activity.'));
  const text = JSON.stringify([d.notes, d.feed, d.launch, d.held]);
  if (text === a.text) return;
  a.text = text;
  const scroll = a.body.querySelector('.feed')?.scrollTop || 0;
  const notes = h('div.act-notes', {},
    h('h4', {}, 'What it says it is doing ', h('span.muted', {}, d.notes.at ? `· updated ${time(d.notes.at)}` : '')),
    d.notes.lines.length
      ? h('ol.progress-notes', {}, d.notes.lines.map((l, i) => h(`li${i === 0 ? '.latest' : ''}`, {}, l)))
      : h('p.muted.small', {}, `No progress notes yet: workers add a line to ${d.notes.file} every few steps (WORKER.md).`));
  const feed = h('div.act-feed', {}, h('h4', {}, 'What it ran ', h('span.muted', {}, d.feed.available ? '· newest first' : '')));
  if (!d.feed.available) feed.append(h('p.muted.small', {}, d.feed.why));
  else if (!d.feed.events.length) feed.append(h('p.muted.small', {}, `Nothing yet from ${d.engineTitle || 'the engine'}.`));
  else {
    feed.append(h('ul.feed', {}, d.feed.events.map((e) => h(`li.k-${e.kind}${e.ok === false ? '.bad' : e.ok === true ? '.good' : ''}`, {},
      h('span.icon', { 'aria-hidden': 'true' }, KIND[e.kind] || '·'),
      h('span.what', {}, e.kind === 'command' || e.kind === 'test' ? h('code', {}, e.text) : e.text),
      e.detail ? h('span.detail', {}, e.detail) : null))));
  }
  // how it was started, when not the usual way: a window where the console with no window didn't start (FR-010)
  const launch = d.launch ? h('p.act-launch.small', {}, h('strong', {}, 'Started in a window of its own. '), d.launch.text) : null;
  // why the task waits: the guard holds its merge until the owner decides (lib/guard.mjs)
  const held = d.held
    ? h('p.act-held.small', {}, h('strong', {}, 'Blocked by the tool. '), d.held.text, ' ',
      h('button.linkish', { type: 'button', onclick: () => goToCard(d.held.card || null) }, 'Review the change'))
    : null;
  a.body.replaceChildren(...[held, launch, notes, feed].filter(Boolean));
  const list = a.body.querySelector('.feed');
  if (list) list.scrollTop = scroll;
}
async function pollActivity(id) {
  const a = activity.get(id);
  if (!a || !a.el.open || a.loading || document.visibilityState !== 'visible') return;
  a.loading = true;
  const res = await api(`/api/activity?id=${encodeURIComponent(id)}`);
  a.loading = false;
  a.data = res;
  drawActivity(a);
}
function watchActivity(id) {
  const a = activity.get(id);
  if (!a) return;
  clearInterval(a.timer);
  a.timer = null;
  if (!a.el.open) return;
  pollActivity(id);
  a.timer = setInterval(() => pollActivity(id), 2000);
}
// The toggle of a running task, kept between redraws (so it stays open, and scrolled where it was).
function activityBox(j) {
  let a = activity.get(j.id);
  if (!a) {
    const body = h('div.activity-body');
    const el = h('details.activity', { open: openActivity().includes(j.id) }, h('summary', {}, 'Show activity'), body);
    a = { el, body, data: null, text: '', timer: null, loading: false };
    activity.set(j.id, a);
    // only the owner's click changes what is remembered; opening it (or re-adding it open) starts asking
    el.addEventListener('toggle', () => {
      if (el.open !== openActivity().includes(j.id)) rememberActivity(j.id, el.open);
      watchActivity(j.id);
    });
    drawActivity(a);
    if (el.open) watchActivity(j.id);
  }
  return a.el;
}
// Toggles of tasks that no longer run stop asking.
function forgetActivity(running) {
  for (const [id, a] of activity) {
    if (running.has(id)) continue;
    clearInterval(a.timer);
    activity.delete(id);
  }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') for (const id of activity.keys()) pollActivity(id);
});

function renderHome() {
  const b = build;
  const root = $('#home');
  if (!b || selecting(root)) return;
  // (a list open in the Acceptance card stays open: Home is drawn again once it closes)
  if (document.activeElement?.tagName === 'SELECT' && root.contains(document.activeElement)) return;
  if (usagePicking && Date.now() - usagePicking < PICKING_MS) {
    usageHeld = true;
    return;
  }
  usagePicking = 0;
  if (!b.ok) return root.replaceChildren(h('div.callout.bad', {}, `The dashboard couldn't read the project's state: ${b.error}`));
  const st = teamState(b);
  const ot = orchestratorTile(b);
  const needs = b.needs || [];
  const [next, ...rest] = needs;
  const status = h('div.tiles', {},
    tile('The team', st.kind, st.title, st.text, null, st.button || (b.hub.running && !b.hub.stopping ? actionButton('hub', 'Stop the hub', '/api/hub', { action: 'stop' }) : null)),
    tile('Autopilot', AUTOPILOT_KIND[b.autopilot.state] || 'good', b.autopilot.on ? (b.autopilot.paused ? 'Paused' : 'On') : 'Off', b.autopilot.text, null, h('span.row', {}, autopilotButton(b), runNowButton(b))),
    tile('Orchestrator', ot.kind, b.orchestrator ? (b.orchestrator.mode === 'autopilot' ? 'Round' : 'Open') : 'Closed', ot.text, ot.sub, ot.button));
  const nextCard = next
    ? h(`div.nextup.k-${next.level}`, {}, h('div.nextup-label', {}, 'Next'), h('div.nextup-body', {}, h('div', {}, h('p.nextup-text', {}, next.text, next.pending ? [' · final in ', countdown(next.pending)] : null), next.why ? h('p.muted.small.why', {}, `Why: ${next.why}`) : null), h('div.row', {}, needButton(next, true), needMore(next))))
    : h('div.nextup.k-ok', {}, h('div.nextup-label', {}, 'Next'), h('div.nextup-body', {}, h('p.nextup-text', {}, 'Nothing needs you right now.')));

  const needsCard = h('div.card', {}, h('h2', {}, 'Needs you ', h('span.muted', {}, needs.length ? String(needs.length) : '')));
  if (!rest.length) needsCard.append(h('p.muted', {}, next ? 'Only the one above.' : 'Nothing. Your phone gets a message when something comes up.'));
  else needsCard.append(h('ul.needs', {}, rest.map((n) => h(`li.${n.level}`, {}, h('span', {}, n.text, n.pending ? [' · final in ', countdown(n.pending)] : null, n.why ? h('span.muted.small.why', {}, ` Why: ${n.why}`) : null), h('span.row', {}, needButton(n), needMore(n))))));

  const nowCard = h('div.card', {}, h('h2', {}, 'Happening now'));
  const lines = [];
  if (b.orchestrator?.mode === 'autopilot') lines.push(h('li', {}, h('strong', {}, `Autopilot round, since ${time(b.orchestrator.since)}`), h('span.meta', {}, runsOn(b.orchestrator))));
  for (const j of b.active) {
    const over = j.timeoutMin && minutesOf(j) > j.timeoutMin;
    const meta = [j.slot ? `w${j.slot}` : '', runsOn(j), j.type === 'task' ? `${minutesOf(j)} of ${j.timeoutMin} min` : `${plural(minutesOf(j), 'min')}`].filter(Boolean).join(' · ');
    const task = j.type === 'task';
    lines.push(h(`li${over ? '.over' : ''}`, {}, h('strong', {}, j.sentence), h('span.meta', {}, meta),
      task && j.progress?.line ? h('span.latest-note', { title: 'its latest progress note' }, `“${j.progress.line}”`) : null,
      task ? activityBox(j) : null));
  }
  // Tasks the guard holds: "Blocked by the tool" until the owner approves or rejects their change (Show activity says why)
  for (const j of b.blocked || []) {
    lines.push(h('li.blocked', {}, h('strong', {}, `Blocked by the tool: ${j.title || j.id}`), h('span.meta', {}, `waits for your approval (${(j.held?.files || []).join(', ')}): Show activity says why`), activityBox(j)));
  }
  forgetActivity(new Set([...b.active.filter((j) => j.type === 'task'), ...(b.blocked || [])].map((j) => j.id)));
  if (lines.length) nowCard.append(h('ul.now', {}, lines));
  else nowCard.append(h('p.muted', {}, b.hub.running ? 'No task is running.' : 'Nothing runs while the hub is stopped.'));  if (b.queued.length) nowCard.append(h('p.muted.small', {}, `${plural(b.queued.length, 'task')} queued: ${b.queued.map((j) => j.title || j.id).join(', ')}.`));
  if (b.review.length) nowCard.append(h('p.muted.small', {}, `${plural(b.review.length, 'finished job')} waiting for the orchestrator's review.`));

  const done = b.milestones.filter((m) => m.done).length;
  const current = b.milestones.find((m) => !m.done);
  const progress = h('div.card', {}, h('h2', {}, 'Progress'));
  if (!b.milestones.length) progress.append(h('p.muted', {}, `No milestones in ${b.status} yet: the orchestrator fills them in as it plans.`));
  else {
    const bar = h('div.progress', { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': b.milestones.length, 'aria-valuenow': done }, h('div.progress-fill'));
    bar.firstChild.style.width = `${Math.round((done / b.milestones.length) * 100)}%`;
    progress.append(h('p.big', {}, `${done} of ${b.milestones.length} milestones done`), bar, current ? h('p', {}, 'Now: ', h('strong', {}, current.name), current.state ? h('span.muted', {}, ` (${current.state})`) : null) : h('p', {}, 'All done.'));
  }
  progress.append(h('p.muted.small', {}, `Last activity ${b.lastActivity}. `, h('button.linkish', { type: 'button', onclick: () => goTo('project') }, 'The roadmap')));

  root.replaceChildren(...[status, nextCard, updateCard(b), h('div.grid', {}, h('div.col', {}, needsCard, nowCard, testerCard(), switchesCard(b)), h('div.col', {}, blockersCard(b), securityCard(b), progress, usageCard(b)))].filter(Boolean));
}

// The update in progress, paused or just done (src/updater.mjs): its steps, what it waits for, and the owner's buttons
const STEP_ICON = { done: '✓', running: '…', failed: '✕', todo: '·' };
function updateRunCard(u) {
  const r = u.run;
  const kind = r.phase === 'paused' ? 'warn' : r.phase === 'done' ? 'ok' : r.phase === 'cancelled' ? 'idle' : 'info';
  const title = r.phase === 'done' ? (r.kind === 'back' ? `Gone back to nextlevel ${r.to}` : `Updated to nextlevel ${r.to}`)
    : r.phase === 'paused' ? `The update to ${r.to} is paused`
    : r.phase === 'cancelled' ? (r.text || 'The update was stopped')
    : r.kind === 'back' ? `Going back to nextlevel ${r.to}` : `Updating to nextlevel ${r.to}`;
  const card = h(`div.card.update.run.k-${kind}`, {}, h('h2', {}, title));
  if (r.projects.length) card.append(h('p.muted.small', {}, `Projects: ${r.projects.join(', ')}`));
  card.append(h('ol.update-steps', {}, r.steps.map((s) => h(`li.s-${s.state}`, {}, h('span.icon', { 'aria-hidden': 'true' }, STEP_ICON[s.state] || '·'), h('span', {}, s.title, s.detail && s.state !== 'todo' ? h('span.muted.small', {}, ` · ${s.detail}`) : null)))));
  if (r.phase === 'waiting' && r.waitingFor.length) card.append(h('div.update-wait', {}, h('p.small', {}, h('strong', {}, 'Waiting for: ')), h('ul.update-notes', {}, r.waitingFor.map((w) => h('li', {}, h('span', {}, w))))));
  if (r.paused) {
    card.append(h('p.small.warn-text', {}, `${r.paused.title}: ${r.paused.text}`));
    if (r.paused.output) card.append(h('pre.update-output', {}, r.paused.output.split('\n').slice(-12).join('\n')));
    card.append(h('p.muted.small', {}, r.paused.changed ? 'New work stays held until you choose.' : 'Nothing has changed yet.'));
  }
  for (const n of r.notes || []) card.append(h('p.small', {}, n));
  const buttons = [];
  if (r.phase === 'paused') {
    buttons.push(actionButton('update-retry', 'Try again', '/api/update', { action: 'retry', id: r.id }, true));
    if (r.paused?.canSkipBackup) buttons.push(actionButton('update-skip', 'Update without the backup', '/api/update', { action: 'skip-backup', id: r.id }));
    buttons.push(actionButton('update-back', r.paused?.changed ? `Go back to ${r.from}` : 'Stop the update', '/api/update', { action: r.paused?.changed ? 'back' : 'stop', id: r.id }));
  } else if (r.canStop) buttons.push(actionButton('update-stop', 'Stop waiting', '/api/update', { action: 'stop', id: r.id }));
  else if (r.phase === 'done' && r.kind !== 'back' && r.channel === 'release' && r.from) buttons.push(actionButton('update-back', `Go back to ${r.from}`, '/api/update', { action: 'back' }));
  if (buttons.length) card.append(h('div.row', {}, ...buttons));
  return card;
}

// Home's "Update available" (safe updates): the releases newer than the one this project runs, each line of their notes
// in plain words, safety fixes marked; or, for a project on a candidate branch, the branch's new commits. Until the
// one-click update (pull request B) the owner updates with nextlevel update in PowerShell, so the card has that command.
function updateCard(b) {
  const u = b.update;
  if (!u || u.off) return null;
  if (u.run) return updateRunCard(u);
  const note = (i) => h(`li${i.safety ? '.safety' : ''}`, {}, i.safety ? h('span.blabel.k-bad', {}, 'Safety') : null, h('span', {}, i.text));
  const howTo = (text) => h('div.update-how', {}, h('p.small', {}, text), h('div.row', {}, h('code', {}, 'nextlevel update'), copyButton('nextlevel update')));
  const problems = [...(u.refused || []).map((r) => r.why), ...(u.vanished || []).map((n) => `${n} was published and is gone from GitHub now: it isn't offered any more`)];
  if (u.channel === 'candidate') {
    const c = u.candidate;
    if (!c || (!c.subjects?.length && !c.gone)) return null;
    return h('div.card.update.k-info', {}, h('h2', {}, `New commits on ${u.ref} `, h('span.blabel.k-info', {}, 'not released')),
      c.gone ? h('p', {}, `The branch ${u.ref} this project follows isn't on GitHub any more. To follow releases again, in PowerShell: nextlevel channel release`) : h('ul.update-notes', {}, c.subjects.map((s) => h('li', {}, h('span', {}, s)))),
      c.gone ? null : howTo(`This project runs ${u.current} from the candidate ${u.ref}. To move it to the branch's head, in PowerShell in the project's folder, when no hub or worker runs:`));
  }
  const newer = u.newer || [];
  if (!newer.length && !problems.length && u.ok) return null;
  const safety = newer.some((r) => r.notes?.safety);
  const card = h(`div.card.update.k-${safety ? 'warn' : 'info'}`, {});
  if (newer.length) {
    const top = newer[0];
    card.append(h('h2', {}, `Update available: nextlevel ${top.name} `, safety ? h('span.blabel.k-bad', {}, 'Safety fix') : null,
      u.wentBackFrom === top.name ? h('span.blabel', {}, 'you went back from this one') : null),
      h('p.muted.small', {}, `You run ${u.current}${newer.length > 1 ? `; ${newer.length} releases since` : ''}.`));
    for (const r of newer.slice(0, 5)) {
      const items = [...(r.notes?.fixes || []), ...(r.notes?.added || [])];
      const box = h('div.update-release', {}, newer.length > 1 ? h('h4', {}, r.name) : null);
      if (items.length) box.append(h('ul.update-notes', {}, items.map(note)));
      else box.append(h('p.muted.small', {}, 'Its notes list no changes.'));
      if (r.notes?.afterInstall?.length) box.append(h('p.small', {}, h('strong', {}, 'After install: '), r.notes.afterInstall.join(' ')));
      card.append(box);
    }
    card.append(u.layout
      ? h('div.update-how', {},
        h('p.small', {}, `Update waits for what runs (tasks, a round, the orchestrator's window), stops the hubs and dashboards, switches to ${top.name} and starts everything again, with your autopilot as it is. The dashboard opens again in a new tab.`),
        h('div.row', {}, actionButton('update', `Update to ${top.name}`, '/api/update', { action: 'update', to: top.name, commit: top.commit }, true)))
      : h('p.small', {}, 'This nextlevel is from before releases: run the install command once (Tools page), when no hub or worker runs, to move it to releases.'));
  } else card.append(h('h2', {}, 'Updates'));
  if (!u.ok && u.detail) card.append(h('p.small.warn-text', {}, `The last look for releases failed: ${u.detail}`));
  for (const p of problems) card.append(h('p.small.warn-text', {}, p));
  return card;
}

// Home's Blockers (M11): a headline colored by meaning (no blockers, waiting on you, blocked), then the status file's
// open items with their labels, and what they resolved folded under Details (lib/overview.mjs, blockersView).
const BLOCKER_KIND = { blocked: 'bad', needs: 'warn', open: 'warn', decision: 'info', limitation: 'idle', note: 'idle' };
let blockersHistoryOpen = false;
function blockersCard(b) {
  const v = b.blockersCard;
  if (!v) return null;
  const card = h(`div.card.blockers.k-${v.level}`, {}, h('h2', {}, 'Blockers'),
    h(`div.blocker-head.k-${v.level}`, { role: 'status' }, h('span.dot', { 'aria-hidden': 'true' }),
      h('div', {}, h('p.blocker-headline', {}, v.headline), v.sub ? h('p.muted.small.blocker-sub', {}, v.sub) : null)));
  if (v.items.length) {
    card.append(h('ul.blocker-list', {}, v.items.map((x) => h(`li${x.handled ? '.handled' : ''}`, {},
      h(`span.blabel.k-${BLOCKER_KIND[x.kind] || 'idle'}`, {}, x.label || 'Not labeled'),
      h('div.btext', {},
        // (a held change's line names files from a task's branch: plain text, never Markdown that could make a link)
        x.guard ? h('p', {}, x.text) : md(x.text),
        x.handled ? h('p.muted.small', {}, 'Done on your side: the orchestrator takes it off this list at its next round.') : null,
        x.kind === 'needs' && !x.handled && x.ids?.length ? h('button.linkish.small', { type: 'button', onclick: () => goToCard(x.ids[0]) }, `${x.ids[0]} on the Notes page`) : null)))));
  }
  if (v.history.length) {
    card.append(h('details.learn.blocker-history', { open: blockersHistoryOpen, ontoggle: (e) => (blockersHistoryOpen = e.currentTarget.open) },
      h('summary', {}, `Details: ${plural(v.history.length, 'resolved or earlier item')}`), md(v.history.join('\n'))));
  }
  card.append(h('p.muted.small', {}, `From the Blockers in ${b.status}${(b.handoff || []).length ? ', and the open handoff items' : ''}. Resolved items move to the decisions on the `,
    h('button.linkish', { type: 'button', onclick: () => goTo('project') }, 'Project page'), '.'));
  return card;
}

// Tokens as far as the engines report them: a number, "not reported" (the engine doesn't say), or how many of
// the finished runs did.
function tokensText(r) {
  const done = (r.count || 0) - (r.running || 0);
  if (!r.count) return '—';
  if (!r.reported) return r.tokensKnown || r.tokensFrom ? (done > 0 ? 'none reported' : '—') : 'not reported';
  const n = Number(r.tokens).toLocaleString();
  return r.reported < done ? `${n} (${r.reported} of ${done} reported)` : n;
}
const runsText = (count, unit, running) => `${plural(count, unit)}${running ? `, ${running} now` : ''}`;
// A number of tokens in a few characters (the chart's scale, a task's tag)
const compact = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M` : n >= 1e4 ? `${Math.round(n / 1e3)}k` : Number(n).toLocaleString());

// ---------- Home's Usage card (docs/design/token-usage.md) ----------
// Today per role comes with the live feed (what runs now counted so far); any other range, grouping or all projects is
// read from the usage ledger (GET /api/usage). The browser remembers the choice (localStorage).
const USAGE_KEY = 'nextlevel.usage';
const USAGE_RANGES = [['hour', 'Last hour'], ['today', 'Today'], ['week', 'This week'], ['month', 'This month'], ['all', 'All time']];
const USAGE_BY = [['role', 'Role'], ['engine', 'Engine'], ['model', 'Model'], ['worker', 'Worker'], ['task', 'Task']];
const usage = { range: 'today', by: 'role', all: false, data: null, want: '', at: 0, loading: '' };
try {
  const v = JSON.parse(localStorage.getItem(USAGE_KEY) || '{}');
  if (USAGE_RANGES.some(([k]) => k === v.range)) usage.range = v.range;
  if (USAGE_BY.some(([k]) => k === v.by)) usage.by = v.by;
  usage.all = v.all === true;
} catch {
  // Today, by role
}
function saveUsage() {
  try {
    localStorage.setItem(USAGE_KEY, JSON.stringify({ range: usage.range, by: usage.by, all: usage.all }));
  } catch {
    // kept for this page only
  }
}
const usageWant = () => `range=${usage.range}&by=${usage.by}${usage.all ? '&all=1' : ''}`;
const usageLive = () => usage.range === 'today' && usage.by === 'role' && !usage.all;
// Read again when the choice changed, or at most every 30 s while the page updates
async function loadUsage(force = false) {
  const want = usageWant();
  if (usageLive() || usage.loading === want || (!force && usage.want === want && Date.now() - usage.at < 30_000)) return;
  usage.loading = want;
  const r = await api(`/api/usage?${want}`);
  if (usage.loading === want) usage.loading = '';
  if (want !== usageWant()) return; // the owner chose another meanwhile
  Object.assign(usage, { data: r, want, at: Date.now() });
  renderHome();
}
// While a picker's list is open, Home isn't drawn again (a live update would close it); a redraw it held comes when it
// closes. Only an open list holds it, and for 20 s at most (a list closed on the same choice says nothing): a picker
// that merely has the focus doesn't.
const PICKING_MS = 20_000;
let usagePicking = 0; // when a picker's list was opened
let usageHeld = false;
function usagePickDone() {
  if (!usagePicking) return;
  usagePicking = 0;
  if (!usageHeld) return;
  usageHeld = false;
  // (a blur comes on the pointerdown of what was clicked: draw after its click, or the click lands on a node that's gone)
  let done = false;
  const later = () => {
    if (done) return;
    done = true;
    document.removeEventListener('pointerup', later, true);
    setTimeout(renderHome, 0);
  };
  document.addEventListener('pointerup', later, true);
  setTimeout(later, 500);
}
function usageControls() {
  const changed = (e, set) => {
    set(e.currentTarget);
    usagePicking = 0;
    usageHeld = false;
    saveUsage();
    loadUsage(true);
    renderHome();
  };
  const opening = () => (usagePicking = Date.now());
  const pick = (label, list, value, set) => h('label.usage-pick', {}, h('span', {}, label),
    h('select', {
      onchange: (e) => changed(e, set),
      onpointerdown: opening,
      // (the keys that open a select's list; Escape closes it without a change)
      onkeydown: (e) => (e.key === 'Escape' || e.key === 'Tab' ? usagePickDone() : (e.altKey || [' ', 'Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) && opening()),
      onblur: usagePickDone,
    }, list.map(([k, t]) => h('option', { value: k, selected: k === value }, t))));
  return h('div.usage-controls', {},
    pick('Range', USAGE_RANGES, usage.range, (el) => (usage.range = el.value)),
    pick('Group by', USAGE_BY, usage.by, (el) => (usage.by = el.value)),
    h('label.usage-all', {}, h('input', { type: 'checkbox', checked: usage.all, onchange: (e) => changed(e, (el) => (usage.all = el.checked)) }), 'All projects'));
}
// Home's "Usage": the range and grouping chosen, then its numbers
function usageCard(b) {
  const card = h('div.card.usage-card', {}, h('h2', {}, 'Usage'), usageControls());
  if (usageLive()) card.append(...todayParts(b));
  else {
    loadUsage();
    const d = usage.data;
    if (!d || usage.want !== usageWant()) card.append(h('p.muted', {}, 'Reading the usage ledger...'));
    else if (!d.ok) card.append(h('div.callout.bad', {}, d.message || "The usage ledger couldn't be read."));
    else card.append(...rangeParts(d));
  }
  card.append(h('p.muted.small', {}, "Tokens as each engine reports them: Codex's JSON output (codex exec --json) and its session files, Claude Code's and Antigravity's JSON output (cache reads apart); interactive Claude Code and Antigravity windows are counted in minutes only. A run counts when it ends."));
  return card;
}
// FR-019: autopilot rounds by what started them, with their minutes and tokens (every engine's, where it reported them)
function roundsParts(why) {
  if (!why.length) return [];
  return [h('h4', {}, 'Autopilot rounds, by what started them'),
    h('table.usage', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'What started them'), h('th.num', {}, 'Rounds'), h('th.num', {}, 'Minutes'), h('th.num', {}, 'Tokens'))),
      h('tbody', {}, why.map((r) => h(`tr${r.key === 'earlier' ? '.sub' : ''}`, {},
        h('td', {}, r.title),
        h('td.num', {}, String(r.count)),
        h('td.num', {}, String(Math.round(r.minutes))),
        h('td.num.wrap', {}, r.tokens ? Number(r.tokens).toLocaleString() : '—')))))];
}
// Today per role (FR-008): each role's rounds, sessions or attempts, minutes and tokens, then each engine's
function todayParts(b) {
  const u = b.usage || {};
  const out = [];
  const roles = u.roles || [];
  const row = (cells, cls = '') => h(`tr${cls}`, {}, cells.map((c, i) => h(i === 0 ? 'td' : i === 3 ? 'td.num.wrap' : 'td.num', {}, c)));
  out.push(
    h('table.usage', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Who'), h('th.num', {}, 'Runs'), h('th.num', {}, 'Minutes'), h('th.num', {}, 'Tokens'))),
      h('tbody', {}, roles.flatMap((r) => [
        row([h('strong', {}, r.title), runsText(r.count, r.unit, r.running), String(Math.round(r.minutes)), tokensText(r)]),
        ...(r.engines.length > 1 || (r.engines.length === 1 && r.count) ? r.engines.map((e) => row([h('span.sub', {}, e.title), runsText(e.count, r.unit, e.running), String(Math.round(e.minutes)), tokensText(e)], '.sub')) : []),
      ]))),
  );
  out.push(...roundsParts(u.roundsBy || []));
  const engines = u.engines || [];
  if (engines.length) {
    out.push(h('h4', {}, 'By engine'),
      h('table.usage', {},
        h('tbody', {}, engines.map((e) => h('tr', {},
          h('td', {}, h('strong', {}, e.title), h('div.muted.small', {}, e.parts.map((p) => plural(p.count, p.unit)).join(', ') || 'nothing yet')),
          h('td.num', {}, `${Math.round(e.minutes)} min`),
          h('td.num', { title: !e.tokensKnown ? e.notReported : '' }, e.reported ? `${Number(e.tokens).toLocaleString()} tokens` : e.tokensKnown ? 'none reported yet' : 'not reported'))))));
  }
  return out;
}
// A group's tokens: how many of its runs reported them, when not all did
function groupTokens(g) {
  if (!g.reported) return g.runs ? 'not reported' : '—';
  const n = Number(g.tokens).toLocaleString();
  return g.reported < g.runs ? `${n} (${g.reported} of ${g.runs} reported)` : n;
}
const USAGE_ROWS = 40;
// Another range or grouping, from the usage ledger (GET /api/usage)
function rangeParts(d) {
  const out = [h('p.muted.small', {}, `${d.title}, ${d.since}: runs that ended in it.${d.running ? ` ${plural(d.running, 'run')} going now ${d.running === 1 ? 'counts' : 'count'} when ${d.running === 1 ? 'it ends' : 'they end'}.` : ''}`)];
  const t = d.total;
  if (!t) out.push(h('p.muted', {}, 'Nothing ended in this range.'));
  else {
    out.push(h('div.usage-total', {},
      h('div', {}, h('strong', {}, groupTokens(t)), h('span.muted', {}, ' tokens')),
      h('div.muted.small', {}, `${plural(t.runs, 'run')}, ${Math.round(t.minutes)} minutes${t.cached ? `, ${Number(t.cached).toLocaleString()} cache reads` : ''}`)));
    if (d.days?.length > 1) out.push(dayChart(d.days));
    const label = USAGE_BY.find(([k]) => k === d.by)?.[1] || d.by;
    const rows = d.rows.slice(0, USAGE_ROWS);
    out.push(h('table.usage', {},
      h('thead', {}, h('tr', {}, h('th', {}, label), h('th.num', {}, 'Runs'), h('th.num', {}, 'Minutes'), h('th.num', {}, 'Tokens'), h('th.num.quiet', {}, 'Cache reads'))),
      h('tbody', {}, rows.map((g) => h('tr', {},
        h('td', {}, g.key && (d.by === 'task' || d.by === 'model') ? h('code.nowrap', {}, g.title) : g.title),
        h('td.num', {}, String(g.runs)),
        h('td.num', {}, String(Math.round(g.minutes))),
        h('td.num.wrap', {}, groupTokens(g)),
        h('td.num.quiet', {}, g.cached ? Number(g.cached).toLocaleString() : '—'))))));
    if (d.rows.length > rows.length) out.push(h('p.muted.small', {}, `${d.rows.length - rows.length} more: nextlevel usage --range ${d.range} --by ${d.by} --json has them all.`));
  }
  if (d.projects) {
    out.push(h('h4', {}, 'By project'),
      h('table.usage', {}, h('tbody', {}, d.projects.map((p) => h('tr', {},
        h('td', {}, p.name),
        h('td.num', {}, !p.found ? 'not found' : p.total ? plural(p.total.runs, 'run') : 'nothing'),
        h('td.num.wrap', {}, p.total ? groupTokens(p.total) : '—'))))));
  }
  out.push(...roundsParts(d.roundsBy || []));
  for (const x of d.notes || []) out.push(h('p.muted.small', {}, `Note: ${x}`));
  return out;
}
// The per-day chart: tokens a day, stacked by engine (each engine keeps its color whatever else is shown), a bar's numbers
// in its tooltip. Inline SVG made with the page's DOM calls, never from HTML text.
const SVG_NS = 'http://www.w3.org/2000/svg';
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined) el.setAttribute(k, String(v));
  for (const kid of kids.flat()) if (kid !== null && kid !== undefined) el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const ENGINE_ORDER = ['codex', 'claude', 'agy'];
const engineClass = (e) => (ENGINE_ORDER.includes(e) ? `eng-${e}` : 'eng-other');
function dayChart(days) {
  const max = Math.max(...days.map((x) => x.tokens));
  if (!max) return h('p.muted.small', {}, 'No engine reported tokens on these days.');
  const W = 600;
  const H = 120;
  const top = 2;
  const base = H - 1;
  const step = W / days.length;
  const bw = Math.max(1, step - Math.min(6, step * 0.25));
  const order = (list) => [...list].sort((a, b) => (ENGINE_ORDER.indexOf(a.engine) + 1 || 9) - (ENGINE_ORDER.indexOf(b.engine) + 1 || 9));
  const seen = new Map();
  const bars = days.map((x, i) => {
    let y = base;
    const segs = order(x.engines).filter((e) => e.tokens > 0).map((e) => {
      seen.set(e.engine, e.title);
      const hgt = Math.max(1, ((base - top) * e.tokens) / max);
      y -= hgt;
      return svg('rect', { class: `seg ${engineClass(e.engine)}`, x: (i * step + (step - bw) / 2).toFixed(1), y: y.toFixed(1), width: bw.toFixed(1), height: hgt.toFixed(1) });
    });
    const tip = [`${x.day}: ${x.tokens.toLocaleString()} tokens, ${plural(x.runs, 'run')}`, ...order(x.engines).filter((e) => e.tokens > 0).map((e) => `${e.title}: ${e.tokens.toLocaleString()}`)].join('\n');
    // (the whole column answers the pointer, not only the bar)
    return svg('g', { class: 'day' }, svg('title', {}, tip), svg('rect', { class: 'hit', x: (i * step).toFixed(1), y: 0, width: step.toFixed(1), height: base }), ...segs);
  });
  const legend = [...seen].sort((a, b) => (ENGINE_ORDER.indexOf(a[0]) + 1 || 9) - (ENGINE_ORDER.indexOf(b[0]) + 1 || 9));
  // (the scale and the dates are the page's text, so they stay readable at a phone's width)
  return h('figure.usage-chart', {},
    h('div.usage-axis', {}, `${compact(max)} tokens`),
    svg('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `Tokens a day, ${days[0].day} to ${days.at(-1).day}, by engine; the table below has the numbers` },
      svg('line', { class: 'grid', x1: 0, x2: W, y1: top, y2: top }),
      ...bars,
      svg('line', { class: 'baseline', x1: 0, x2: W, y1: base, y2: base })),
    h('div.usage-axis.dates', {}, h('span', {}, days[0].day), h('span', {}, days.at(-1).day)),
    h('figcaption.usage-legend', {}, legend.map(([e, title]) => h('span', {}, h(`i.swatch.${engineClass(e)}`, {}), title))));
}

// Home's "Fallbacks and engine switches" (FR-008): what ran on another engine than its role's, and why
function switchesCard(b) {
  const list = b.switches || [];
  const card = h('div.card', {}, h('h2', {}, 'Fallbacks and engine switches ', h('span.muted', {}, list.length ? String(list.length) : '')));
  if (!list.length) {
    card.append(h('p.muted', {}, "None: everything ran on its role's engine."));
    return card;
  }
  const when = (iso) => (new Date(iso).toDateString() === new Date().toDateString() ? time(iso) : `${new Date(iso).toLocaleDateString()} ${time(iso)}`);
  const what = (x) => {
    const instead = x.roleEngineTitle && x.roleEngineTitle !== x.engineTitle ? ` instead of ${x.roleEngineTitle}` : '';
    if (x.kind === 'task') return `${x.id}${x.title && x.title !== x.id ? ` (${x.title})` : ''}, attempt ${x.attempt}, ran on ${x.engineTitle}${x.profile ? ` (profile ${x.profile})` : ''}${instead}`;
    if (x.kind === 'round') return `Autopilot rounds on ${x.engineTitle}${instead}`;
    return `The orchestrator's window on ${x.engineTitle}${instead}`;
  };
  card.append(h('ul.switches', {}, list.map((x) => h(`li${x.how === 'auto-fallback' ? '.warn' : ''}`, {}, h('span.meta', {}, when(x.at)), h('strong', {}, what(x)), h('span', {}, x.why)))));
  return card;
}

// ---------- Project (M11): what the project is, the roadmap, the pace and the decisions ----------
// From GET /api/project (lib/roadmap.mjs), read again whenever the build data's projectStamp changes. What is open
// (a milestone's tasks, a Try it) stays open while the page redraws.
const proj = { data: null, stamp: null, loading: false, again: false, stale: false, toggles: new Map(), allDecisions: false };
async function loadProject() {
  if (proj.loading) return (proj.again = true);
  proj.loading = true;
  const res = await api('/api/project');
  proj.loading = false;
  proj.data = res.ok ? res : { ok: false, message: res.message || "The project's files couldn't be read." };
  renderProject();
  if (proj.again) {
    proj.again = false;
    loadProject();
  }
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const dayOf = (iso) => {
  const d = new Date(iso);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date().getFullYear() ? { year: 'numeric' } : {}) });
};
function duration(days) {
  if (days < 1 / 24) return 'under an hour';
  if (days < 1) return plural(Math.round(days * 24), 'hour');
  return plural(Math.round(days), 'day');
}
const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86_400_000;
function datesText(m) {
  if (m.done) {
    if (m.started && m.finished) return `${dayOf(m.started)} → ${dayOf(m.finished)} · ${duration(daysBetween(m.started, m.finished))}`;
    return m.finished ? `finished ${dayOf(m.finished)}` : 'dates not recorded';
  }
  if (m.started) return `started ${dayOf(m.started)} · ${duration(daysBetween(m.started, new Date().toISOString()))} so far`;
  return m.current ? 'not started yet' : '';
}
// A details element whose open state survives redraws: the owner's choice, else `open` by default
function fold(key, summary, content, open = false) {
  return h('details.fold', { open: proj.toggles.has(key) ? proj.toggles.get(key) : open, ontoggle: (e) => proj.toggles.set(key, e.currentTarget.open) }, h('summary', {}, summary), h('div.fold-body', {}, content));
}
const field = (label, text) => h('div.ms-field', {}, h('span', {}, label), md(text));

function aboutCard(d) {
  const a = d.about;
  const card = h('div.card.about', {}, h('div.card-head', {}, h('h2', {}, 'What this project is'), h('span.muted.small', {}, d.files.project)));
  if (!a.written) {
    card.append(h('div.callout.warn', {}, h('strong', {}, `${d.files.project} isn't written yet. `),
      `The orchestrator writes it from ${d.files.brief}, in its own words, at its next start (docs/agents/ORCHESTRATOR.md, "The project page").`));
    if (a.goal) card.append(h('h4', {}, "Until then: the brief's goal"), md(a.goal));
    else card.append(h('p.muted', {}, `${d.files.brief} has no goal yet either: you write it, and the setup guide helps (START.cmd).`));
    return card;
  }
  const sec = (key) => {
    const s = a.sections.find((x) => x.key === key);
    return h(`div.about-sec.s-${key}`, {}, h('h4', {}, s.title), s.text ? md(s.text) : h('p.muted.small', {}, 'Not written yet.'));
  };
  const what = a.sections.find((x) => x.key === 'what');
  card.append(what.text ? md(what.text, 'md.about-lede') : sec('what'), h('div.about-grid', {}, h('div', {}, sec('who'), sec('state')), h('div', {}, sec('where'), sec('how'))));
  if (!a.complete) card.append(h('p.muted.small', {}, `${plural(a.sections.length - a.written, 'section')} still ${a.sections.length - a.written === 1 ? 'has' : 'have'} the template's placeholders: the orchestrator fills them in.`));
  return card;
}

function taskRow(t) {
  const id = t.attempts ? h('button.linkish.job-id', { type: 'button', title: 'Open it on the Build page', onclick: () => { openJobs.add(t.id); goTo('build'); } }, t.id) : h('code.job-id', {}, t.id);
  // (a closed task, FR-021: "closed <day>: <why>", never "not dispatched yet")
  return h(`li${t.state === 'closed' ? '.t-closed' : ''}`, {}, id, t.title && t.title !== t.id ? h('span', {}, t.title) : null,
    h(`span.state.s-${t.state}`, {}, t.summary),
    t.attempts ? h(`span.tag${t.attempts > 3 ? '.alert' : ''}`, {}, plural(t.attempts, 'attempt')) : null,
    t.engine ? h(`span.tag${t.switched ? '.switched' : ''}`, { title: t.switched ? "not the worker role's engine" : '' }, t.worker === 'second' ? `${t.engine} · second worker` : t.engine) : null);
}
// What is wrong with a milestone's plan (FR-016: lib/roadmap.mjs planProblems, the doctor's "Milestone plans" too)
const PLAN_WARN = { none: 'No plan found', fields: 'Plan incomplete', rivals: 'More than one plan' };
const planWarnings = (d, m) => (d.planProblems || []).filter((x) => x.key === m.key);
function milestoneCard(m, d, lastDone) {
  const kind = m.done ? 'done' : m.current ? 'current' : 'future';
  const [badge, word] = m.done ? ['good', 'Done'] : m.current ? ['info', cap(m.state)] : ['idle', cap(m.state)];
  const body = h('div.ms-body', {}, h('div.ms-head', {}, h('strong.ms-name', {}, m.name), h(`span.badge.${badge}`, {}, word), h('span.muted.small.ms-dates', {}, datesText(m))));
  const plan = m.plan;
  const warnings = planWarnings(d, m);
  for (const x of warnings) body.append(h('div.ms-warn', {}, h('strong', {}, `${PLAN_WARN[x.kind] || 'Plan'}. `), x.card));
  if (plan?.outcome) body.append(field('Outcome', plan.outcome));
  if (m.goal && (!plan?.outcome || !m.done)) body.append(field(plan?.outcome ? 'In the brief' : "The brief's goal", m.goal));
  if (m.done && m.verified) body.append(field('Verified by', m.verified));
  if (!m.done && plan?.acceptance) body.append(field('Acceptance', plan.acceptance));
  if (m.current && !plan && !warnings.length) body.append(h('p.muted.small', {}, `No plan yet: the orchestrator writes ${m.planPath || `${d.files.plans}/${m.key}.md`}, with the line "Milestone: ${m.name}" under its title, then Outcome, Acceptance and Try it, before its tasks.`));
  if (m.done && plan?.tryIt) body.append(fold(`try:${m.key}`, 'Try it yourself', md(plan.tryIt), m === lastDone));
  else if (m.done && !warnings.length) body.append(h('p.muted.small', {}, 'No plan with Try it steps for this one.'));
  if (m.tasks.length) {
    const c = m.counts;
    // (the closed ones out of the count, said apart: FR-021)
    const summary = !c.total && c.closed ? `Tasks: ${plural(c.closed, 'task')}, all closed` : `Tasks: ${c.merged} of ${c.total} merged${c.running ? `, ${c.running} running` : ''}${c.queued ? `, ${c.queued} queued` : ''}${c.closed ? ` · ${c.closed} closed` : ''}`;
    body.append(fold(`tasks:${m.key}`, summary, h('ul.ms-tasks', {}, m.tasks.map(taskRow)), m.current));
  }
  if (plan) body.append(h('p.muted.small.ms-file', {}, 'Plan: ', h('code', {}, plan.file)));
  return h(`li.ms.k-${kind}${warnings.length ? '.has-warn' : ''}`, { id: `ms-${m.key}` }, h('span.ms-dot', { 'aria-hidden': 'true' }, m.done ? '✓' : ''), body);
}
// The milestones whose plans need a look, each a button to its card
function planCallout(d) {
  const names = [...new Map((d.planProblems || []).map((x) => [x.key, x.name])).entries()];
  if (!names.length) return null;
  const jump = (key) => document.getElementById(`ms-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  return h('div.callout.warn.plan-warn', { role: 'note' },
    h('strong', {}, names.length === 1 ? 'One milestone needs a look at its plan: ' : `${names.length} milestones need a look at their plans: `),
    names.map(([key, name], i) => [i ? ', ' : '', h('button.linkish', { type: 'button', onclick: () => jump(key) }, name)]), '. ',
    h('span.muted.small', {}, `Each card says what is wrong. The orchestrator keeps the plans (its role doc, "Planning"), and the doctor's row "Milestone plans" lists the same.`));
}
function roadmapCard(d) {
  const list = d.roadmap;
  const card = h('div.card', {}, h('div.card-head', {}, h('h2', {}, 'Roadmap ', h('span.muted', {}, list.length ? `${list.filter((m) => m.done).length} of ${list.length} done` : '')), h('span.muted.small', {}, `${d.files.status} · ${d.files.plans}/`)));
  if (!list.length) {
    card.append(h('p.muted', {}, `No milestones yet: ${d.files.brief} lists them, and the orchestrator keeps their state in ${d.files.status}.`));
    return card;
  }
  const lastDone = list.filter((m) => m.done).at(-1);
  card.append(...[planCallout(d)].filter(Boolean), h('ol.timeline', {}, list.map((m) => milestoneCard(m, d, lastDone))));
  return card;
}

function paceCard(d) {
  const p = d.pace;
  const tile = (value, label, sub) => h('div.stat', {}, h('div.stat-value', {}, value), h('div.stat-label', {}, label), sub ? h('div.stat-sub', {}, sub) : null);
  const card = h('div.card.pace', {}, h('h2', {}, 'Pace'),
    h('div.stats', {},
      tile(p.started ? dayOf(p.started) : '—', 'Started', p.started ? `${duration(p.days)} ${p.left ? 'ago' : 'in all'}` : 'not yet'),
      tile(`${p.done} of ${p.total}`, 'Milestones done', p.lastFinished ? `the last on ${dayOf(p.lastFinished)}` : 'none yet'),
      tile(p.perMilestone ? duration(p.perMilestone) : '—', 'Per milestone', p.basis ? 'so far, gaps included' : 'after the first')));
  const timed = d.roadmap.filter((m) => m.started || m.finished);
  if (timed.length) card.append(h('ul.pace-list', {}, timed.map((m) => h(`li.k-${m.done ? 'done' : 'open'}`, {}, h('span', {}, m.name), h('span.muted.small', {}, datesText(m))))));
  if (p.estimate) {
    card.append(h('div.estimate', {},
      h('div.estimate-label', {}, 'Rough estimate'),
      h('p', {}, `About ${duration(p.estimate.days)} more for the ${plural(p.left, 'milestone')} left: around ${dayOf(p.estimate.by)}.`),
      h('p.muted.small', {}, `At the pace so far: ${plural(p.basis, 'milestone')} finished, ${duration(p.perMilestone)} each with the gaps between them. Milestones differ in size, so this is a guess, not a promise; it changes as they finish.`)));
  } else card.append(h('p.muted.small', {}, p.why));
  return card;
}

// A decision's text as its card shows it: the first sentence, and the rest under More
function splitFirst(text) {
  const [para, ...more] = String(text || '').split(/\n\s*\n/);
  // (a list or a code block stays whole)
  const m = !/^\s*([-*+]|\d+[.)]|```|~~~)/.test(para) && para.match(/^([\s\S]{20,}?[.!?])(?=\s|$)([\s\S]*)$/);
  return [m ? m[1] : para, [m ? m[2] : '', ...more].map((s) => s.trim()).filter(Boolean).join('\n\n')];
}
function decisionCard(x, i) {
  const [short, rest] = splitFirst(x.text);
  return h(`div.cardx.decision${x.resolved ? '.resolved' : ''}`, {},
    h('div.cardx-head', {}, x.date ? h('span.cid', {}, x.date) : null, h('strong.what', {}, inline(x.title)), x.resolved ? h('span.badge.good', {}, 'Resolved blocker') : null),
    x.text ? h('div.small', {}, md(short), rest ? fold(`dec:${i}:${x.date}:${x.title}`, 'More', md(rest)) : null) : null);
}
function decisionsCard(d) {
  const list = d.decisions;
  const card = h('div.card', {}, h('div.card-head', {}, h('h2', {}, 'Decisions ', h('span.muted', {}, list.length ? String(list.length) : '')), h('span.muted.small', {}, d.files.decisions)));
  if (!list.length) {
    card.append(h('p.muted', {}, `None recorded yet: the orchestrator writes its choices, and the blockers it resolved, in ${d.files.decisions}.`));
    return card;
  }
  const shown = proj.allDecisions ? list : list.slice(0, 8);
  card.append(h('div.cards', {}, shown.map((x, i) => decisionCard(x, i))), h('p.muted.small', {}, 'Newest first.'));
  if (list.length > shown.length) card.append(h('button.btn.small', { type: 'button', onclick: () => { proj.allDecisions = true; renderProject(); } }, `Show all ${list.length}`));
  return card;
}

function renderProject() {
  const root = $('#project-page');
  const d = proj.data;
  // drawn when its data comes, or when the owner comes to the page (not while they select text on it)
  proj.stale = true;
  if (!d || currentTab() !== 'project' || selecting(root)) return;
  proj.stale = false;
  if (!d.ok) return root.replaceChildren(h('div.callout.bad', {}, d.message));
  root.replaceChildren(aboutCard(d), h('div.grid.project-grid', {}, h('div.col', {}, roadmapCard(d)), h('div.col', {}, paceCard(d), decisionsCard(d))));
}

// ---------- Build ----------
function jobLine(j) {
  const bits = [h('code.job-id', {}, j.id)];
  if (j.title && j.title !== j.id) bits.push(h('span.job-title', {}, j.title));
  if (j.slot) bits.push(h('span.tag', {}, `w${j.slot}`));
  if (j.engine) bits.push(h(`span.tag${j.switched ? '.switched' : ''}`, { title: j.role === 'worker' && j.state === 'queued' ? "the worker role's engine when it starts" : j.why || '' }, `${j.engineTitle || j.engine}${j.worker === 'second' ? ' · second worker' : ''}`));
  // (a job from before the dashboard kept its model has neither)
  if (j.type === 'task' && j.state !== 'queued' && (j.model || j.modelOwn)) bits.push(h('span.tag', { title: j.modelOwn ? "the engine's own choice" : '' }, j.model || 'own model'));
  if (j.effort) bits.push(h('span.tag', {}, j.effort));
  if (j.attempt > 1) bits.push(h(`span.tag${j.attempt > 3 ? '.alert' : ''}`, {}, `attempt ${j.attempt}`));
  // what its ended attempts used, from the usage ledger (where their engines reported tokens)
  if (j.usage?.reported) bits.push(h('span.tag', { title: `${plural(j.usage.attempts, 'attempt')} ended, ${Math.round(j.usage.minutes)} minutes${j.usage.reported < j.usage.attempts ? `; ${j.usage.reported} of them reported tokens` : ''}` }, `${compact(j.usage.tokens)} tokens`));
  // a task closed with nextlevel close (FR-021): closed, with its reason; what its job ended as stays in the tooltip
  if (j.closed) bits.push(h('span.state.s-closed', { title: j.summary }, j.closed.text));
  else bits.push(h(`span.state.s-${j.state}`, {}, j.summary));
  return bits;
}

// A details element re-rendered open fires "toggle" too: only an owner's click changes what is open.
function toggleJob(id, details) {
  if (details.open) openJobs.add(id);
  else openJobs.delete(id);
  loadJobs();
}
async function loadJobs() {
  for (const j of [...(build?.review || []), ...(build?.recent || []), ...(build?.queued || [])]) {
    if (!openJobs.has(j.id) || loading.has(j.id) || jobDetails.get(j.id)?.summary === j.summary) continue;
    loading.add(j.id);
    const res = await api(`/api/job?id=${encodeURIComponent(j.id)}`);
    loading.delete(j.id);
    jobDetails.set(j.id, { data: res.ok ? res : { report: '', logs: {}, error: res.message }, summary: j.summary });
    renderBuild();
  }
}
// A task's attempt (FR-020): finished without a report (and what was checked), how its engine ended, its own commits and
// diff stat, then each recorded attempt in a line
function attemptBox(a) {
  if (!a) return null;
  const out = [];
  if (a.mark) out.push(h('p.callout.warn', {}, `Finished without a report, ${a.mark}: review this attempt's own commits${a.mark === 'verify passed' ? ' and the verify log' : ''} as you would a report.`));
  if (a.end) out.push(h('p.muted.small', {}, `How it ended: ${a.end}`));
  if (a.commits) out.push(h('p.muted.small', {}, a.commits));
  if (a.own.length) out.push(h('h4', {}, `This attempt's commits`), h('ul.plain', {}, a.own.map((c) => h('li', {}, h('code', {}, c)))));
  if (a.ownStat) out.push(h('pre.log', {}, a.ownStat));
  if (a.list.length > 1 || a.tally) {
    out.push(h('h4', {}, 'Its attempts'));
    if (a.tally) out.push(h('p.muted.small', {}, a.tally));
    out.push(h('ol.plain.attempts', {}, a.list.map((x) => h('li', {}, h('strong', {}, `Attempt ${x.attempt}`), x.engine ? ` · ${x.engine}${x.model ? ` (${x.model})` : ''}` : '', ` · ${x.how}`, x.commits ? ` · ${x.commits}` : '', x.tokens !== null && x.tokens !== undefined ? ` · ${Number(x.tokens).toLocaleString()} tokens` : ''))));
  }
  return out;
}
function jobBox(j) {
  const d = jobDetails.get(j.id)?.data;
  const body = d
    ? [
        d.branch ? h('p.muted.small', {}, `Branch ${d.branch}`) : null,
        d.resultFile ? h('p.muted.small', {}, `Its result is in ${d.resultFile}, on the branch (merged with it)`) : null,
        attemptBox(d.attempt),
        d.report ? [h('h4', {}, "The worker's report"), h('pre.report', {}, d.report)] : h('p.muted', {}, d.attempt?.missing ? `No report written: ${d.attempt.missing}.` : 'No report written.'),
        d.progress?.length ? [h('h4', {}, 'Its progress notes'), h('ol.plain.progress-log', {}, d.progress.map((l) => h('li', {}, l)))] : null,
        Object.entries(d.logs || {}).map(([name, lines]) => [h('h4', {}, name), h('pre.log', {}, lines.join('\n'))]),
      ]
    : h('p.muted', {}, 'Loading…');
  return h('details.job', { open: openJobs.has(j.id), ontoggle: (e) => toggleJob(j.id, e.currentTarget) }, h('summary', {}, jobLine(j)), h('div.job-body', {}, body));
}

function milestones(b) {
  const done = b.milestones.filter((m) => m.done).length;
  const card = h('div.card', {}, h('h2', {}, 'Milestones ', h('span.muted', {}, b.milestones.length ? `${done} of ${b.milestones.length} done · ${b.status}` : b.status)));
  if (!b.milestones.length) {
    card.append(h('p.muted', {}, 'None yet: the orchestrator fills the table in as it plans.'));
    return card;
  }
  const current = b.milestones.find((m) => !m.done);
  card.append(
    h('table.milestones', {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Milestone'), h('th', {}, 'State'), h('th', {}, 'Verified by'))),
      h('tbody', {}, b.milestones.map((m) => h(`tr${m.done ? '.done' : m === current ? '.current' : ''}`, {}, h('td', {}, m.done ? '✓ ' : m === current ? '▸ ' : '', m.name), h('td', {}, m.state), h('td', {}, m.verified))))),
  );
  return card;
}

function active(b) {
  const card = h('div.card', {}, h('h2', {}, 'Running now ', h('span.muted', {}, `${b.active.filter((j) => j.type === 'task').length} of ${b.project.slots} slot(s)`)));
  if (!b.active.length) {
    card.append(h('p.muted', {}, b.hub.running ? 'No worker is running.' : 'Nothing runs while the hub is stopped.'));
    return card;
  }
  for (const j of b.active) {
    const over = j.timeoutMin && minutesOf(j) > j.timeoutMin;
    const box = h(`div.worker${over ? '.over' : ''}`, {}, h('p.sentence', {}, j.sentence), h('div.worker-head', {}, jobLine(j), h('span.muted', {}, j.type === 'task' ? ` · ${minutesOf(j)} of ${j.timeoutMin} min` : ` · ${plural(minutesOf(j), 'min')}`)));
    // This attempt's own commits and diff stat first, then the rest of the branch's (FR-020)
    if (j.own) {
      const mine = new Set(j.own.commits);
      const earlier = j.commits.filter((c) => !mine.has(c));
      box.append(h('h4', {}, `Commits so far, this attempt ${j.own.count}`), j.own.commits.length ? h('ul.plain', {}, j.own.commits.map((c) => h('li', {}, h('code', {}, c)))) : h('p.muted.small', {}, 'None yet.'));
      if (j.own.stat) box.append(h('pre.log', {}, j.own.stat));
      if (earlier.length) box.append(h('h4', {}, 'Earlier on its branch'), h('ul.plain', {}, earlier.map((c) => h('li', {}, h('code', {}, c)))));
    } else if (j.commits.length) box.append(h('h4', {}, 'Commits so far'), h('ul.plain', {}, j.commits.map((c) => h('li', {}, h('code', {}, c)))));
    if (j.changed.length) box.append(h('h4', {}, 'Changed, not committed yet'), h('ul.plain', {}, j.changed.map((c) => h('li', {}, h('code', {}, c)))));
    // (a task an older nextlevel ran in a window of its own: its output was there, not in worker.log)
    if (j.inWindow) box.append(h('p.hint', {}, `Its output is in its own window (${b.project.name} worker w${j.slot} - ${j.id}).`));
    else box.append(h('h4', {}, j.log.attempt ? `${j.log.name} · attempt ${j.log.attempt}` : j.log.name), h('pre.log.follow', {}, j.log.lines.length ? j.log.lines.join('\n') : j.log.attempt ? `(nothing from attempt ${j.log.attempt} yet)` : '(nothing yet)'));
    if (j.why && j.switched) box.append(h('p.muted.small', {}, `On ${j.engineTitle}: ${j.why}`));
    card.append(box);
  }
  return card;
}

// The tasks closed lately (FR-021), those never dispatched too: each with when, who and why
function closedCard(b) {
  const list = b.closed || [];
  if (!list.length) return null;
  return h('div.card', {}, h('h2', {}, 'Closed lately ', h('span.muted', {}, String(list.length))),
    h('ul.closed-list', {}, list.map((c) => h('li', {}, h('code.job-id', {}, c.id), c.title && c.title !== c.id ? h('span', {}, c.title) : null,
      h('span.state.s-closed', {}, c.text), h('span.muted.small', {}, `by ${c.by}${c.discarded ? ', its work thrown away' : ''}`)))),
    h('p.muted.small', {}, "The team won't build these (nextlevel close). The Project page leaves them out of each milestone's count; dispatching one opens it again."));
}

function jobList(title, jobs, empty, hint) {
  const card = h('div.card', {}, h('h2', {}, title, ' ', h('span.muted', {}, jobs.length ? String(jobs.length) : '')));
  if (!jobs.length) card.append(h('p.muted', {}, empty));
  else card.append(h('div.jobs', {}, jobs.map(jobBox)));
  if (hint && jobs.length) card.append(h('p.muted.small', {}, hint));
  return card;
}

// Not while the owner selects text on the page (a log line to copy): after they let go
function selecting(root) {
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && root.contains(sel.anchorNode)) {
    document.addEventListener('selectionchange', () => setTimeout(renderAll, 300), { once: true });
    return true;
  }
  return false;
}

function renderBuild() {
  const b = build;
  const root = $('#build');
  if (!b || selecting(root)) return;
  if (!b.ok) return root.replaceChildren(h('div.callout.bad', {}, `The dashboard couldn't read the project's state: ${b.error}`));
  const scrolls = [...root.querySelectorAll('pre.log')].map((p) => p.scrollTop);
  root.replaceChildren(
    h('div.grid', {},
      h('div.col', {}, active(b), jobList('Queued', b.queued, 'Nothing is queued.'),
        jobList('Waiting for review', b.review, 'Nothing to review.', 'The orchestrator reviews these, then merges or retries them.')),
      h('div.col', {}, milestones(b), jobList('Reviewed lately', b.recent, 'Nothing reviewed yet.'), closedCard(b),
        h('div.card', {}, h('h2', {}, 'Hub log'), h('pre.log.follow', {}, b.hub.log.length ? b.hub.log.map(localTime).join('\n') : 'The hub has not written anything yet.')))),
  );
  root.querySelectorAll('pre.log').forEach((p, i) => (p.scrollTop = p.classList.contains('follow') ? p.scrollHeight : scrolls[i] || 0));
  loadJobs();
}

// ---------- Team ----------
// An open editor keeps its own elements while the page is drawn again, so what the owner is choosing stays.
const editors = new Map(); // row key -> { el, state }
const modelLists = new Map(); // engine or profile -> { list, hints, efforts, why } | 'loading'

async function loadModels(name) {
  if (!name || modelLists.has(name)) return;
  modelLists.set(name, 'loading');
  const res = await api(`/api/team/models?engine=${encodeURIComponent(name)}`);
  modelLists.set(name, res.ok ? res : { list: [], hints: [], why: res.message || 'no list' });
  for (const e of editors.values()) e.draw();
}

function teamCard(row, b) {
  const card = h('div.card.role', { id: `role-${row.key}` });
  const head = h('div.role-head', {}, h('div', {}, h('h2', {}, row.title), h('p.muted.small', {}, row.does)));
  if (!editors.has(row.key)) head.append(h('button.btn', { type: 'button', onclick: () => openEditor(row) }, 'Change'));
  card.append(head);
  if (row.none) card.append(h('p', {}, row.text));
  else {
    const who = [row.sameAs ? "The orchestrator's: " : row.auto ? 'Automatic: ' : '', row.engineTitle, row.profile ? ` (profile ${row.profile}${row.account ? `, account ${row.account}` : ''})` : ''].join('');
    card.append(
      h('dl.facts', {},
        h('dt', {}, 'Engine'), h('dd', {}, who),
        h('dt', {}, 'Model'), h('dd', {}, row.model.text),
        // (Antigravity has no effort setting: its level is in the model's name, FR-010)
        h('dt', {}, row.effort.fixed ? 'Level' : 'Effort'), h('dd', {}, row.effort.text, row.effort.note ? h('span.note', {}, row.effort.note) : null),
        // (the second worker: what it takes, as the orchestrator's role doc reads it)
        ...(row.takes ? [h('dt', {}, 'Takes'), h('dd', {}, row.takes.text)] : [])),
      h('ul.notes', {}, row.notes.map((n) => h('li', {}, n))),
      // what a worker on this engine can't do on this PC (FR-009); a role with the owner's full access (FR-017): a warning
      // where the owner can act, information where the risk is accepted by design
      // (spread: append() writes an array as its text, "[object HTMLDivElement]")
      ...(row.warnings || []).map((w) => h('div.callout.warn', {}, h('strong', {}, 'Warning: '), w)),
      ...(row.notices || []).map((w) => h('div.callout.info', {}, h('strong', {}, 'Note: '), w)),
    );
  }
  const ed = editors.get(row.key);
  if (ed) card.append(ed.el);
  return card;
}

function openEditor(row) {
  const b = build;
  const state = {
    choice: row.none ? b.team.find((r) => r.key === 'worker')?.engine || 'codex' : row.sameAs ? 'orchestrator' : row.auto ? 'auto' : row.profile ? `profile:${row.profile}` : row.engine,
    model: row.none ? '' : row.model.set,
    effort: row.none ? '' : row.effort.set,
    takes: row.takes?.value || 'no-docker', // (the second worker's note)
    other: false,
    busy: false,
    result: null,
  };
  const el = h('div.editor');
  const ed = { el, state, draw: () => drawEditor(row, ed) };
  editors.set(row.key, ed);
  drawEditor(row, ed);
  renderTeam(true);
}
function closeEditor(key) {
  editors.delete(key);
  renderTeam(true);
}

// What the chosen engine or profile is: { engine, profile, name } (name: what its models are listed by)
function chosen(state, b) {
  if (state.choice === 'orchestrator') {
    const o = b.team.find((r) => r.key === 'orchestrator');
    return { engine: o?.engine, profile: '', name: o?.profile || o?.engine, same: true };
  }
  // The assistant's automatic choice: a light model, picked by nextlevel
  if (state.choice === 'auto') {
    const a = b.team.find((r) => r.key === 'assistant');
    return { engine: a?.engine, profile: '', name: a?.engine, same: true, auto: true };
  }
  // No second worker
  if (state.choice === 'none') return { engine: '', profile: '', name: '', none: true };
  if (state.choice.startsWith('profile:')) {
    const name = state.choice.slice(8);
    const p = b.teamChoices.profiles.find((x) => x.name === name);
    return { engine: p?.engine, profile: name, name };
  }
  return { engine: state.choice, profile: '', name: state.choice };
}

function drawEditor(row, ed) {
  const b = build;
  const { state } = ed;
  const engines = b.teamChoices.engines;
  const c = chosen(state, b);
  const eng = engines.find((e) => e.name === c.engine) || engines[0];
  if (!c.profile && !c.same && !c.none) loadModels(c.name);
  const listed = modelLists.get(c.name);
  const list = listed && listed !== 'loading' ? listed.list || [] : [];

  const engineSelect = h('select', { id: `engine-${row.key}`, 'aria-label': 'Engine', disabled: state.busy, onchange: (e) => {
    state.choice = e.target.value;
    state.model = '';
    state.effort = '';
    state.other = false;
    state.result = null;
    ed.draw();
  } },
  row.key === 'guide' ? h('option', { value: 'orchestrator', selected: state.choice === 'orchestrator' }, "The orchestrator's engine") : null,
  row.key === 'assistant' ? h('option', { value: 'auto', selected: state.choice === 'auto' }, 'Automatic: a light model') : null,
  row.second ? h('option', { value: 'none', selected: state.choice === 'none' }, 'No second worker') : null,
  // (the assistant only on an engine that can be run read-only: the others are shown, not offered)
  engines.map((e) => h('option', { value: e.name, selected: state.choice === e.name, disabled: row.key === 'assistant' && !e.assistant }, row.key === 'assistant' && !e.assistant ? `${e.title} (not offered: can't be kept read-only)` : e.title)),
  b.teamChoices.profiles.length ? h('optgroup', { label: 'Profiles (an engine with an account)' }, b.teamChoices.profiles.map((p) => h('option', { value: `profile:${p.name}`, selected: state.choice === `profile:${p.name}` }, `${p.name} (${engines.find((e) => e.name === p.engine)?.title || p.engine}${p.account ? `, account ${p.account}` : ''})`))) : null);

  const fields = [h('label.field', {}, h('span', {}, 'Engine'), engineSelect)];
  // The second worker's note: what it takes (the orchestrator's role doc reads it)
  if (row.second && !c.none) {
    fields.push(h('label.field', {}, h('span', {}, 'Takes'),
      h('select', { id: `takes-${row.key}`, 'aria-label': 'What it takes', disabled: state.busy, onchange: (e) => {
        state.takes = e.target.value;
        state.result = null;
      } }, row.takes.choices.map((x) => h('option', { value: x.value, selected: state.takes === x.value }, x.text)))));
  }
  if (c.none) {
    // (nothing more to choose)
  } else if (!c.profile && !c.same) {
    // Models: the ones its CLI lists, else the names its --model takes, and always a field for any other
    const known = [...list.map((m) => ({ id: m.id, label: m.label && m.label !== m.id ? `${m.id} · ${m.label}` : m.id })), ...(listed?.hints || eng.modelHints || []).filter((x) => !list.some((m) => m.id === x)).map((x) => ({ id: x, label: x }))];
    const isKnown = !state.model || known.some((m) => m.id === state.model);
    if (!isKnown) state.other = true;
    const modelSelect = h('select', { id: `model-${row.key}`, 'aria-label': 'Model', disabled: state.busy, onchange: (e) => {
      if (e.target.value === '\u0000other') {
        state.other = true;
      } else {
        state.other = false;
        state.model = e.target.value;
      }
      state.result = null;
      ed.draw();
    } },
    h('option', { value: '', selected: !state.other && !state.model }, `${eng.title}'s own choice`),
    known.map((m) => h('option', { value: m.id, selected: !state.other && state.model === m.id }, m.label)),
    h('option', { value: '\u0000other', selected: state.other }, 'Another model: type its name…'));
    const modelField = h('label.field', {}, h('span', {}, 'Model'), modelSelect);
    if (state.other) {
      modelField.append(h('input', { type: 'text', value: state.model, placeholder: 'the exact model name', 'aria-label': 'Model name', disabled: state.busy, oninput: (e) => {
        state.model = e.target.value.trim();
        state.result = null;
      } }));
    }
    const listNote = listed === 'loading' ? `Asking ${eng.title} for its models…` : listed?.list?.length ? `From ${listed.from}.` : listed?.why ? `${listed.why}: type any name it takes.` : '';
    if (listNote) modelField.append(h('span.hint-inline', {}, listNote));
    fields.push(modelField);
    // Efforts: the model's own list where the CLI says it, else the engine's. An engine whose level is in the
    // model's name (Antigravity) has no Effort field: it says the level the chosen model runs at (FR-010).
    const model = list.find((m) => m.id === state.model);
    const efforts = model?.efforts?.length ? model.efforts : eng.efforts;
    if (eng.levelInModel) {
      state.effort = '';
      fields.push(h('p.muted.small.field-note', {}, state.model ? (model?.effort || levelOf(state.model) ? `${state.model} runs at ${model?.effort || levelOf(state.model)}: the level is in the model's name.` : `${state.model} carries no level in its name.`) : "Antigravity takes the level from the model's name (gemini-3.8-flash-high is high, claude-opus-5-5-medium is medium): pick the model with the level you want. nextlevel doesn't pass --effort."));
    } else fields.push(h('label.field', {}, h('span', {}, 'Effort'),
      h('select', { id: `effort-${row.key}`, 'aria-label': 'Effort', disabled: state.busy, onchange: (e) => {
        state.effort = e.target.value;
        state.result = null;
      } },
      h('option', { value: '', selected: !state.effort }, model?.effort ? `The model's default (${model.effort})` : "The model's default"),
      efforts.map((x) => h('option', { value: x, selected: state.effort === x }, x)))));
  } else if (c.profile) {
    fields.push(h('p.muted.small', {}, 'A profile has its own model and effort (profiles in nextlevel.json), shared by every role on it.'));
  }
  const notes = eng && !c.none ? [eng.notes[row.role], eng.notes.plan, eng.effortNote && (row.role !== 'worker' || eng.levelInModel) ? eng.effortNote : ''].filter(Boolean) : [];
  const save = (extra = {}) => submitTeam(row, ed, extra);
  const res = state.result;
  ed.el.replaceChildren(...[
    h('div.fields', {}, fields),
    notes.length ? h('div.means', {}, h('h4', {}, `What ${c.same ? "the orchestrator's engine" : eng.title} means here`), h('ul.notes', {}, notes.map((n) => h('li', {}, n)))) : null,
    h('div.row', {},
      h('button.btn.primary', { type: 'button', disabled: state.busy, onclick: () => save() }, state.busy ? 'Checking…' : 'Check and save'),
      h('button.btn', { type: 'button', disabled: state.busy, onclick: () => save({ check: true }) }, 'Only check'),
      h('button.btn', { type: 'button', disabled: state.busy, onclick: () => closeEditor(row.key) }, 'Cancel')),
    state.busy ? h('p.muted.small', {}, h('span.spinner'), " Running the doctor's checks for it: installed, signed in, the model accepted (a model check can take a minute)…") : null,
    res ? teamResult(res) : null,
  ].filter(Boolean));
}

// What a change's checks said: an error about the role keeps it from being saved; warnings are listed with it
function teamResult(res) {
  const box = h(`div.callout.stack.${res.ok ? 'good' : 'warn'}`, {}, h('p', {}, h('strong', {}, res.message || (res.ok ? 'Done.' : 'Not saved.'))));
  if (res.results?.length) {
    box.append(h('ul.results', {}, res.results.filter((r) => !r.quiet || r.status === 'fail').map((r) => h(`li.${r.status === 'fail' ? r.severity : r.status}`, {}, h('strong', {}, r.title), ` ${r.detail}`,
      r.status === 'fail' && r.steps?.length ? h('ol.steps', {}, r.steps.map(stepItem)) : null))));
  }
  return box;
}

async function submitTeam(row, ed, extra) {
  const { state } = ed;
  const c = chosen(state, build);
  const levelInModel = build.teamChoices.engines.find((e) => e.name === c.engine)?.levelInModel;
  const takes = row.second && !c.none ? { takes: state.takes } : {};
  const body = c.none ? { role: row.key, engine: 'none', ...extra } : c.profile ? { role: row.key, profile: c.profile, ...takes, ...extra } : c.same ? { role: row.key, engine: c.auto ? 'auto' : 'orchestrator', ...extra } : { role: row.key, engine: c.engine, model: state.model, effort: levelInModel ? '' : state.effort, ...takes, ...extra };
  state.busy = true;
  state.result = null;
  ed.draw();
  const res = await api('/api/team', body);
  state.busy = false;
  state.result = res;
  if (res.saved) {
    toast(res.message, 'good');
    editors.delete(row.key);
    renderTeam(true);
    return;
  }
  ed.draw();
}

let lastTeam = '';
function renderTeam(force = false) {
  const b = build;
  const root = $('#team');
  if (!b?.ok || !b.team) return;
  const text = JSON.stringify([b.team, b.teamChoices, b.workerWindow, b.codexWorkers, b.githubChecks, windowBusy, sandboxBusy, checksBusy, tst.data]);
  if (!force && text === lastTeam) return;
  lastTeam = text;
  root.replaceChildren(h('div.roles', {}, b.team.map((row) => teamCard(row, b)), testerTeamCard(), windowCard(b), codexWorkersCard(b), githubChecksCard(b)),
    h('p.muted.small', {}, 'Saved in nextlevel.json: commit it with your next change. From PowerShell: nextlevel team, and nextlevel team set <role> --engine codex|claude|agy --model <name> --effort <level>.'));
}

// The level a model's name carries (Antigravity: gemini-3.8-flash-high, claude-opus-5-5-medium, gemini-4-argon-high), as
// engines/agy.mjs reads it
const levelOf = (model) => (String(model || '').toLowerCase().match(/[-_ (](minimal|low|medium|high|xhigh|max)\)?$/) || [])[1] || '';

// How a worker's process shows on this PC (workers.window, FR-010): chosen here, saved by nextlevel team window
let windowBusy = false;
function windowCard(b) {
  const w = b.workerWindow;
  if (!w) return null;
  const card = h('div.card.role', { id: 'worker-window' },
    h('div.role-head', {}, h('div', {}, h('h2', {}, 'Worker windows'), h('p.muted.small', {}, 'How each worker shows on this PC while it runs (workers.window in nextlevel.json)'))));
  if (!w.windows) return card.append(h('p', {}, w.text)), card;
  card.append(h('div.choices', { role: 'radiogroup', 'aria-label': 'Worker windows' }, w.choices.map((c) =>
    h('label.choice', {},
      h('input', { type: 'radio', name: 'worker-window', value: c.mode, checked: c.mode === w.mode, disabled: windowBusy, onchange: () => setWorkerWindow(c.mode) }),
      h('span', {}, h('strong', {}, c.title, c.mode === 'hidden' ? ' (the default)' : ''), h('span.muted.small.block', {}, c.text))))));
  card.append(h('p.muted.small', {}, 'It applies to the next task that starts. From PowerShell: nextlevel team window hidden|minimized|visible.'));
  return card;
}
async function setWorkerWindow(mode) {
  windowBusy = true;
  renderTeam(true);
  const res = await api('/api/team', { window: mode });
  windowBusy = false;
  toast(res.message || (res.ok ? 'Saved.' : 'Not saved.'), res.ok ? 'good' : 'error');
  renderTeam(true);
}

// Codex workers' sandbox (engines.codex.workerArgs): chosen here, saved by nextlevel team sandbox on|off. The orchestrator
// keeps engines.codex.args and its sandbox whatever this says.
let sandboxBusy = false;
function codexWorkersCard(b) {
  const c = b.codexWorkers;
  if (!c) return null;
  const card = h('div.card.role', { id: 'codex-workers' },
    h('div.role-head', {}, h('div', {}, h('h2', {}, 'Codex workers'), h('p.muted.small', {}, `Where a worker on Codex runs its commands (${c.key} in nextlevel.json). The orchestrator keeps Codex's sandbox.`))));
  card.append(h('div.choices', { role: 'radiogroup', 'aria-label': 'Codex workers' }, c.choices.map((x) =>
    h('label.choice', {},
      h('input', { type: 'radio', name: 'codex-workers', value: x.sandbox ? 'on' : 'off', checked: x.sandbox === c.sandbox, disabled: sandboxBusy, onchange: () => setCodexSandbox(x.sandbox) }),
      h('span', {}, h('strong', {}, x.title, x.sandbox ? ' (the default)' : ''), h('span.muted.small.block', {}, x.text))))));
  card.append(h('p.muted.small', {}, `It applies to the next task that starts${c.uses ? '' : ' on Codex (no worker role runs on it now; a task sent there with --engine codex gets it)'}. Taking them out of the sandbox asks for the bridge test again. The rest of engines.codex.args is copied as it is when you choose: a later change to it reaches Codex workers only when you choose again. From PowerShell: nextlevel team sandbox on|off.`));
  return card;
}
async function setCodexSandbox(on) {
  sandboxBusy = true;
  renderTeam(true);
  const res = await api('/api/team', { codexSandbox: on });
  sandboxBusy = false;
  toast(res.message || (res.ok ? 'Saved.' : 'Not saved.'), res.ok ? 'good' : 'error');
  renderTeam(true);
}

// The project's GitHub checks on this PC (the self-hosted runner's part A): where they run, and whether nextlevel
// recommends running them here. Never offered for a public, internal or organization's repository. Setting it up is
// part B: the card says so, and nothing on it changes anything.
let checksBusy = false;
function githubChecksCard(b) {
  const g = b.githubChecks;
  if (!g) return null;
  const card = h('div.card.role', { id: 'github-checks' },
    h('div.role-head', {}, h('div', {}, h('h2', {}, 'GitHub checks'), h('p.muted.small', {}, g.slug ? `Where ${g.slug}'s checks run, and whether to run them on this PC` : "Where the project's GitHub checks run"))));
  const kind = g.state === 'recommended' ? 'good' : g.state === 'unknown' ? 'warn' : '';
  if (g.where) card.append(h('p', {}, h('strong', {}, 'Where they run: '), g.where));
  card.append(h(`p.checks-state${kind ? `.${kind}` : ''}`, {}, h('strong', {}, g.title)));
  card.append(h(g.state === 'reading' ? 'p.muted.small' : 'p', {}, g.text));
  if (g.minutes) card.append(h('p', {}, g.minutes));
  if (g.jobs?.length) {
    card.append(h('ul.checks-jobs', {}, g.jobs.map((j) => h('li', {}, h('code', {}, j.file), ': ', h('strong', {}, j.job), ` on ${j.runsOn}`, j.stays ? h('span.muted.small.block', {}, `Stays on GitHub by default: ${j.why}.`) : null))));
  }
  for (const n of g.notes || []) card.append(h(`p.small.${n.kind === 'error' ? 'bad' : 'warn'}`, {}, n.text));
  if (g.later) card.append(h('p.muted.small', {}, g.later));
  const actions = h('div', {});
  if (g.slug) actions.append(h('button.btn.small', { disabled: checksBusy || g.refreshing, onclick: () => checkGithubAgain() }, g.refreshing || checksBusy ? 'Reading GitHub...' : 'Check again'));
  card.append(actions);
  card.append(h('p.muted.small', {}, `${g.at ? `Read ${new Date(g.at).toLocaleTimeString()}. ` : ''}From PowerShell: nextlevel team runner status.`));
  return card;
}
async function checkGithubAgain() {
  checksBusy = true;
  renderTeam(true);
  const res = await api('/api/team', { githubChecks: 'check' });
  checksBusy = false;
  toast(res.message || (res.ok ? 'Read.' : 'Not read.'), res.ok ? 'good' : 'error');
  renderTeam(true);
}

// ---------- Tools ----------
function controlRow(label, state, stateKind, actions, below = null) {
  return h('div.control', {},
    h('div.control-label', {}, label),
    h(`div.control-state.${stateKind}`, {}, h('span.dot'), state),
    h('div.control-actions', {}, actions),
    below ? h('div.control-below', {}, below) : null);
}
function controls(b) {
  const root = b.project.root;
  const hub = b.hub.stopping
    ? controlRow('Hub', 'Stopping: finishing the checks in progress', 'warn', [])
    : b.hub.running
      ? controlRow('Hub', `Running since ${time(b.hub.since)}`, 'good', [actionButton('hub', 'Stop', '/api/hub', { action: 'stop' })])
      : controlRow('Hub', 'Stopped: nothing runs or gets verified', 'bad', [actionButton('hub', 'Start the hub', '/api/hub', { action: 'start' }, true)]);
  const ap = b.autopilot;
  const autopilot = controlRow('Autopilot', ap.text, AUTOPILOT_KIND[ap.state] || 'good',
    ap.on && ap.paused ? [actionButton('autopilot', 'Resume', '/api/autopilot', { on: true }, true), actionButton('autopilot-off', 'Turn off', '/api/autopilot', { on: false })] : [autopilotButton(b), runNowButton(b)].filter(Boolean));
  const orch = b.orchestrator;
  const orchState = orch ? `${orch.mode === 'autopilot' ? 'An autopilot round is running' : 'Open in its window'} since ${time(orch.since)} · ${runsOn(orch)}` : 'Not running';
  // On Windows these open windows of their own; elsewhere the owner opens a terminal and types them
  const windowRow = (label, state, kind, items) =>
    b.windows
      ? controlRow(label, state, kind, items.map(([key, text, what, primary]) => actionButton(key, text, '/api/open', { what }, primary)))
      : controlRow(label, state, kind, [], items.map(([, , what]) => command('Terminal', `nextlevel ${what === 'orchestrator' ? 'orchestrator' : what === 'guide' ? 'guide' : `guide ${what.slice(6)}`}`, { cwd: root })));
  const orchestrator = orch ? controlRow('Orchestrator', orchState, 'good', []) : windowRow('Orchestrator', orchState, 'idle', [['orch', 'Open the orchestrator', 'orchestrator', true]]);
  const guides = (b.guides || []).map((g) => [`guide-${g.what}`, `With ${g.title}`, g.what]);
  const guide = windowRow('Setup guide', 'Walks you through setup, one step at a time', 'idle', guides);
  const log = b.orchestrator?.log?.length ? h('details.learn', {}, h('summary', {}, "The autopilot round's output"), h('pre.log', {}, b.orchestrator.log.join('\n'))) : null;
  return h('div.card', {}, h('h2', {}, 'Controls'), hub, autopilot, orchestrator, guide, log);
}
function toolCard(b) {
  const t = b.tool || {};
  const where = b.windows ? 'PowerShell' : 'Terminal';
  const move = `$env:NEXTLEVEL_DIR = "$env:USERPROFILE\\Tools\\nextlevel"; ${t.installCommand || ''}`;
  return h('div.card.stack', {}, h('h2', {}, 'nextlevel on this PC'),
    h('dl.facts.wide', {},
      h('dt', {}, 'Installed in'), h('dd', {}, h('div.cmd', {}, h('code', {}, t.root || '?'), copyButton(t.root || ''))),
      h('dt', {}, 'Version'), h('dd', {}, [t.version, t.state].filter(Boolean).join(' · ') || '?'),
      h('dt', {}, 'Command'), h('dd', {}, h('code', {}, t.command || 'nextlevel'))),
    h('h4', {}, 'Update it to the newest release'),
    h('p.muted.small', {}, 'Stop the hub first. Each version goes in a folder of its own, so going back is: nextlevel update --to <the release you had>.'),
    command(where, 'nextlevel update'),
    h('h4', {}, 'Move it to another folder'),
    h('p.muted.small', {}, 'The installer moves it; the nextlevel command and its updates keep working. Put your folder in the first part; stop the hub first.'),
    command(where, move));
}
function commandsCard(b) {
  const row = (cmd, what) => h('li', {}, h('span.muted.small', {}, what), h('div.cmd', {}, h('code', {}, cmd), copyButton(cmd)));
  return h('div.card', {}, h('h2', {}, 'More commands'),
    h('p.small', {}, whereBox(b.windows ? 'PowerShell' : 'Terminal', 'terminal', b.project.root)),
    h('ul.commands', {},
      row('nextlevel bridge-test', "Prove the hub can hand work to workers, and that workers can't push."),
      row('nextlevel team', 'Who fills each role, with the model and effort in use.'),
      row('nextlevel daily-report', "Send today's report to your phone now."),
      row('nextlevel doctor', 'The setup checks in your own window (installs and sign-ins run there).')));
}
function renderTools() {
  const b = build;
  const root = $('#tools');
  if (!b?.ok || selecting(root)) return;
  root.replaceChildren(h('div.grid', {}, h('div.col', {}, controls(b)), h('div.col', {}, toolCard(b), commandsCard(b))));
}

// Every page the build data draws, the visible one first; the header too.
function renderAll() {
  const b = build;
  if (!b) return;
  if (b.ok) renderFixes(b.fixes);
  const tab = currentTab();
  if (tab === 'home') {
    renderHome();
    startTicker(); // (an Undo on Home counts its seconds)
  }
  if (tab === 'project' && proj.stale) renderProject();
  if (tab === 'build') renderBuild();
  if (tab === 'team') renderTeam();
  if (tab === 'tools') renderTools();
  if (!b.ok) return;
  // The security engineer's scans or policy changed: the Security page reads them again
  if (b.security && b.security.version !== sec.version) {
    sec.version = b.security.version;
    if (sec.data || tab === 'security') loadSecurity();
  }
  const sc = $('#security-count');
  const secWaits = (b.security?.pending || []).length + (b.security?.trusted?.high ? 1 : 0);
  sc.hidden = !secWaits;
  sc.textContent = String(secWaits);
  sc.className = `count ${b.security?.trusted?.high ? 'error' : 'warn'}`;
  const needs = b.needs || [];
  const urgent = needs.filter((n) => n.level !== 'info').length;
  const home = $('#home-count');
  home.hidden = !urgent;
  home.textContent = String(urgent);
  home.className = `count ${needs.some((n) => n.level === 'error') ? 'error' : 'warn'}`;
  const count = $('#build-count');
  const running = b.active.filter((j) => j.type === 'task').length;
  count.hidden = !running;
  count.textContent = String(running);
  count.className = 'count info';
  $('#project').textContent = `${b.project.name} · ${b.project.root}`;
  document.title = `${b.project.name} · nextlevel`;
  // What the Project page reads changed (a doc, a plan, a task, a merge): read it again
  if (b.projectStamp && b.projectStamp !== proj.stamp) {
    proj.stamp = b.projectStamp;
    if (proj.data || tab === 'project') loadProject();
  }
  // The cards changed (the orchestrator answered, a handoff item came in): read them again
  if (b.cards && b.cards.stamp !== cards.stamp) {
    cards.stamp = b.cards.stamp;
    if (cards.data || tab === 'notes') loadCards();
  }
  const waitingOn = (b.handoff || []).length;
  const nc = $('#notes-count');
  nc.hidden = !waitingOn;
  nc.textContent = String(waitingOn);
  nc.className = 'count warn';
}

// ---------- Notes and handoffs: cards ----------
// The team's handoff items (what, where, why; Done and a reply) and the owner's notes to the orchestrator (one-time
// instructions and standing rules, with their state and the orchestrator's answer). From GET /api/cards, read
// again whenever the build data says the cards changed; what the owner types is kept while the page redraws.
// The cards redesign: one card open at a time (`openId`, also the page's address #H29), a long request shown whole
// (`shownAll`) and earlier messages unfolded (`unfolded`) as the owner chose, across redraws.
const cards = { data: null, stamp: null, loading: false, draft: '', type: 'once', search: '', edits: new Map(), replies: new Map(), busy: new Set(), focus: null, openId: null, shownAll: new Set(), unfolded: new Set() };
async function loadCards() {
  if (cards.loading) return;
  cards.loading = true;
  const res = await api('/api/cards');
  cards.loading = false;
  if (!res.ok) return toast(res.message || "The notes couldn't be read.", 'error');
  cards.data = res;
  if (res.now) skew = Date.parse(res.now) - Date.now();
  renderCards();
  if (ask.open) renderAsk(); // (the advisor's reply drafts look the cards up)
}
async function cardPost(path, body, key) {
  if (cards.busy.has(key)) return null;
  cards.busy.add(key);
  renderCards();
  const res = await api(path, body);
  cards.busy.delete(key);
  toast(res.message || (res.ok ? 'Done.' : 'That did not work.'), res.ok ? 'good' : 'error');
  await loadCards();
  return res;
}
// Redraw without losing what has focus or where the cursor is
function keepFocus(root, draw) {
  const el = document.activeElement;
  const key = root.contains(el) ? el?.dataset?.key : null;
  const [a, b] = key && 'selectionStart' in el ? [el.selectionStart, el.selectionEnd] : [null, null];
  draw();
  if (!key) return;
  const again = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
  if (!again) return;
  again.focus();
  if (a !== null) again.setSelectionRange(a, b);
}
const ago2 = (iso) => (iso ? `${new Date(iso).toDateString() === new Date().toDateString() ? time(iso) : `${new Date(iso).toLocaleDateString()} ${time(iso)}`}` : '');
function commitLink(sha) {
  const repo = cards.data?.repo;
  return repo && /^[0-9a-f]{4,40}$/i.test(sha) ? link(`https://github.com/${repo}/commit/${sha}`, `commit ${sha.slice(0, 7)}`) : h('code', {}, sha);
}
const taskLink = (id) => h('button.linkish', { type: 'button', title: 'Open it on the Build page', onclick: () => { openJobs.add(id); goTo('build'); } }, `task ${id}`);

// ---- one card open at a time (the cards redesign) ----
// A card waiting for the owner is one line (its id, the request's first line, its state, when it last moved); a click
// opens it, and the line becomes the open card's bar, pinned under the page's header while its text scrolls by.
const lastAt = (x) => (Array.isArray(x.thread) ? x.thread : []).reduce((m, e) => (String(e.at || '') > m ? String(e.at) : m), String(x.createdAt || ''));
function openCard(id, { scroll = true } = {}) {
  cards.openId = id;
  cards.chose = true; // (the owner opened or closed one: no card opens by itself after that)
  history.replaceState(null, '', id ? `#${id}` : '#notes');
  renderCards();
  if (id && scroll) cardTop(id);
}
// The card's top just under the page's header
function cardTop(id) {
  const el = document.getElementById(`card-${id}`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - ($('header.top')?.offsetHeight || 0) - 8 });
}
function cardLine(id, title, badge, at, cls = '', extra = null) {
  return h(`button.card-line${cls}`, { type: 'button', id: `card-${id}`, 'aria-expanded': 'false', title: `Open ${id}`, onclick: () => openCard(id) },
    h('span.cid', {}, id), h('span.what', {}, title), h(`span.badge.${badge[0]}`, {}, badge[1], extra ? [' · ', extra] : null), at ? h('span.muted.small.when', {}, ago2(at)) : null);
}
// The open card's bar: its line again (a click closes it), and a button to its reply box or its decision
function cardBar(id, title, badge, jump, jumpLabel) {
  return h('div.card-bar', {},
    h('button.card-line.open', { type: 'button', 'aria-expanded': 'true', title: `Close ${id}`, onclick: () => openCard(null, { scroll: false }) },
      h('span.cid', {}, id), h('span.what', {}, title), h(`span.badge.${badge[0]}`, {}, badge[1])),
    jump ? h('button.btn.small', { type: 'button', onclick: jump }, jumpLabel) : null);
}
// Its reply box (or reason box), in view and ready to type in
const jumpTo = (id) => () => {
  const area = document.querySelector(`#card-${CSS.escape(id)} textarea`);
  if (!area) return;
  area.scrollIntoView({ block: 'center' });
  area.focus({ preventScroll: true });
};
// A request's other lines: a long one shows its first lines, "Show all" the rest (all of it is on the page)
const FOLD_LINES = 6;
const FOLD_CHARS = 600;
function requestBlock(id, rest) {
  if (!rest) return null;
  const n = rest.split('\n').length;
  if ((n <= FOLD_LINES && rest.length <= FOLD_CHARS) || cards.shownAll.has(id)) return textBlock(rest, '.request');
  return h('div.request-wrap', {}, textBlock(rest, '.request.folded'),
    h('button.linkish.small', { type: 'button', onclick: () => { cards.shownAll.add(id); renderCards(); } }, `Show all (${plural(n, 'line')})`));
}
// Who closed a card, and how (FR-018): the owner's Done, the team's close or withdrawal, a held change's decision
function closedWords(x) {
  if (x.status === 'cancelled') return 'Cancelled by the team';
  if (x.closedBy === 'team') return 'Closed by the team';
  if (x.closedBy === 'hub') return 'Closed by nextlevel';
  if (x.closedBy === 'tester') return 'Verified and closed by the tester';
  if (x.guard || x.from === 'guard') {
    const last = String((Array.isArray(x.thread) ? x.thread : []).filter((e) => e.by === 'owner').at(-1)?.text || '');
    return /^approved/i.test(last) ? 'Approved by you' : /^rejected/i.test(last) ? 'Rejected by you' : 'Decided by you';
  }
  return 'Done by you';
}
const handoffBadge = (x) =>
  x.pending ? ['info', x.pending.was === 'done' ? 'Marked read' : 'Marked done']
  : x.unread ? ['warn', 'The team answered']
  : x.status === 'open' && x.accept ? ACCEPT_BADGE[x.acceptState] || ACCEPT_BADGE.checking
  : x.status === 'open' ? ['warn', x.reopenedAt ? 'Reopened' : 'Needs you']
  : [x.status === 'cancelled' ? 'idle' : 'good', `${closedWords(x)} ${ago2(x.doneAt)}`];
// An Undo's seconds, counted from the server's time (GET /api/cards and the build data say it), never this PC's clock
let skew = 0;
const serverNow = () => Date.now() + skew;
const secondsLeft = (finalAt) => Math.max(0, Math.ceil((Date.parse(finalAt) - serverNow()) / 1000));
const countdown = (finalAt) => h('span.countdown', { dataset: { final: finalAt } }, `${secondsLeft(finalAt)} s`);
// One timer while an Undo shows anywhere: only its seconds change (no redraw, so Home's open pickers stay as they are)
let ticker = null;
function tickUndo() {
  const left = [...document.querySelectorAll('span.countdown')];
  for (const el of left) el.textContent = `${secondsLeft(el.dataset.final)} s`;
  if (left.some((el) => secondsLeft(el.dataset.final) === 0)) {
    loadCards();
    for (const el of left) el.classList.add('ending');
  }
  if (!left.length || left.every((el) => el.classList.contains('ending'))) {
    clearInterval(ticker);
    ticker = null;
  }
}
const startTicker = () => {
  if (!ticker && document.querySelector('span.countdown:not(.ending)')) ticker = setInterval(tickUndo, 1000);
};
// The card's events (FR-018) as the page says them
const eventLabel = (e) =>
  e.kind === 'reopened' ? (e.how === 'reply' ? 'Reopened by your reply' : e.how === 'terminal' ? 'Reopened from the terminal' : 'Reopened by you')
  : e.kind === 'done' ? (e.by === 'hub' ? 'Closed by nextlevel' : 'Done by you')
  : e.kind === 'closed' ? (e.by === 'tester' ? `Verified and closed by the tester${e.note ? ` (${e.note})` : ''}` : 'Closed by the team')
  : `Cancelled by the team${e.note ? `: ${e.note}` : ''}`;

// A handoff card: one conversation (FR-014). The request (its first line is the title), where, why and when, then the
// owner's replies and the team's answers in time order, each whole with its line breaks, as plain text. A card waits for
// the owner while it is open, or when the team answered since the owner last replied or marked it done.
function handoffCard(x) {
  const open = x.status === 'open';
  const waits = open || !!x.unread;
  // (a card with a plan the tester is still working on doesn't wait for the owner: it shows where the tester is)
  const testerTurn = open && x.accept && ['checking', 'fixing'].includes(x.acceptState);
  const key = `h:${x.id}`;
  const req = requestParts(x.what);
  const badge = handoffBadge(x);
  if (cards.openId !== x.id) return cardLine(x.id, req.title, badge, lastAt(x), waits && !testerTurn ? '.waits' : '', x.pending ? countdown(x.pending.finalAt) : null);
  const card = h(`div.cardx.handoff.s-${waits ? 'open' : x.status}${x.unread ? '.answered' : ''}.is-open`, { id: `card-${x.id}` },
    cardBar(x.id, req.title, badge, waits && !x.pending ? jumpTo(x.id) : null, 'Reply'),
    requestBlock(x.id, req.rest),
    h('dl.facts', {}, x.where ? [h('dt', {}, 'Where'), h('dd', {}, x.where)] : null, x.why ? [h('dt', {}, 'Why'), h('dd', {}, x.why)] : null,
      h('dt', {}, 'Asked'), h('dd', {}, ago2(x.createdAt), x.task ? [' · ', taskLink(x.task)] : null)),
    x.accept ? acceptBox(x) : null,
    threadView(x, { when: ago2, fold: 2, open: cards.unfolded.has(x.id), onToggle: (on) => (on ? cards.unfolded.add(x.id) : cards.unfolded.delete(x.id)), events: x.guard ? [] : x.events, eventLabel }),
    x.reopenedAt && open ? h('p.small.muted', {}, "Reopening doesn't undo what the team already did: it sees the card open again at its next start or round.") : null);
  // A Done that can still be undone (undo Done): nothing reached the team yet
  if (x.pending) {
    const busy = cards.busy.has(key);
    card.append(h('div.row.undo', {}, h('span', {}, x.pending.was === 'done' ? `${x.id}'s answer marked read` : `${x.id} marked done`, ' · final in ', countdown(x.pending.finalAt)),
      h('button.btn.primary', { type: 'button', disabled: busy, onclick: async () => {
        const res = await cardPost('/api/handoff', { action: 'undo', id: x.id }, key);
        // (as it was: the reply the owner sent with the Done is back in its box)
        if (res?.ok && x.pending.reply && !(cards.replies.get(x.id) || '').trim()) {
          cards.replies.set(x.id, x.pending.reply);
          renderCards();
        }
      } }, busy ? '…' : 'Undo')));
    return card;
  }
  // A closed card (FR-018): Reopen, and a reply box whose reply reopens it
  if (!waits && !x.guard && x.from !== 'guard') {
    const busy = cards.busy.has(key);
    const label = `Your reply to ${x.id} (it reopens the card)`;
    const area = h('textarea.reply-box', { rows: 2, placeholder: label, 'aria-label': label, dataset: { key: `${key}:reply` }, oninput: (e) => cards.replies.set(x.id, e.target.value) });
    area.value = cards.replies.get(x.id) || '';
    card.append(area, h('div.row', {},
      h('button.btn', { type: 'button', disabled: busy, onclick: async () => {
        const text = (cards.replies.get(x.id) || '').trim();
        if (!text) return toast('Type the reply first.', 'error');
        const res = await cardPost('/api/handoff', { action: 'reply', id: x.id, reply: text }, key);
        if (res?.ok) cards.replies.delete(x.id);
      } }, `Reopen ${x.id} and send`),
      h('button.btn', { type: 'button', disabled: busy, onclick: () => cardPost('/api/handoff', { action: 'reopen', id: x.id }, key) }, busy ? '…' : `Reopen ${x.id}`)));
    return card;
  }
  if (waits) {
    const label = `Your reply to ${x.id}`;
    const area = h('textarea.reply-box', { rows: 2, placeholder: x.unread ? `${label} (optional)` : `${label} (optional): what you did, or a question`, 'aria-label': label, dataset: { key: `${key}:reply` }, oninput: (e) => cards.replies.set(x.id, e.target.value) });
    area.value = cards.replies.get(x.id) || '';
    const busy = cards.busy.has(key);
    card.append(area, h('div.row', {},
      h('button.btn.primary', { type: 'button', disabled: busy, title: open ? null : "The answer is read: the card goes back to what's done", onclick: async () => {
        const res = await cardPost('/api/handoff', { action: 'done', id: x.id, reply: cards.replies.get(x.id) || '' }, key);
        if (res?.ok) cards.replies.delete(x.id);
      } }, busy ? '…' : open ? (x.accept && x.acceptState === 'verified' ? `Close ${x.id}: verified` : `Mark ${x.id} done`) : `Mark ${x.id}'s answer read`),
      h('button.btn', { type: 'button', disabled: busy, onclick: async () => {
        const text = (cards.replies.get(x.id) || '').trim();
        if (!text) return toast('Type the reply first.', 'error');
        const res = await cardPost('/api/handoff', { action: 'reply', id: x.id, reply: text }, key);
        if (res?.ok) cards.replies.delete(x.id);
      } }, `Send reply to ${x.id}`),
      // (the team's cards only: a held change's or a push's is decided on its own card)
      x.guard || x.from === 'guard' ? null : h('button.btn', { type: 'button', title: 'The advisor turns this card into micro-steps and drafts your reply (read-only; only your click sends it)', onclick: () => askExplain(x.id) }, 'Explain')));
  }
  return card;
}

// A change to protected files the hub holds (lib/guard.mjs): what it does in plain words, read from the change by
// nextlevel's code (never by an AI), its exact diff, and Approve or Reject. Only here: not from a command, not from
// the phone. Its words and diff come from the guard's own records (GET /api/cards "guard"), not from the card.
const GUARD_WHO = (g) => (g.kind === 'policy' ? (g.source === 'draft' ? "The security engineer's draft" : "The project's SECURITY.md") : g.kind === 'push' ? `A push to ${g.target}` : g.kind === 'git' ? "Git's own hooks and settings" : g.kind === 'merge' || ['merge', 'slot'].includes(g.on) ? `Task ${g.task}` : g.kind === 'commit' || g.on === 'commit' ? "The orchestrator's commit" : `A change on disk (${g.by || "during the orchestrator's work"})`);
function diffView(text) {
  const pre = h('pre.diff');
  for (const line of String(text || '').split('\n')) {
    const cls = /^(\+\+\+|---|diff --git|new file|deleted file|index )/.test(line) ? '.meta' : line.startsWith('+') ? '.add' : line.startsWith('-') ? '.del' : line.startsWith('@@') ? '.hunk' : '';
    pre.append(h(`span${cls}`, {}, `${line}\n`));
  }
  return pre;
}
function guardCard(g) {
  const key = `g:${g.id}`;
  const busy = cards.busy.has(key);
  const held = g.status === 'held';
  const state = held ? ['bad', 'Needs your decision'] : g.status === 'approved' ? ['good', 'Approved: the hub puts it in'] : ['idle', g.status];
  const id = g.card || g.id;
  const title = g.what || `${GUARD_WHO(g)} changes ${g.files.join(', ')}`;
  if (cards.openId !== id) return cardLine(id, title, state, g.createdAt, `.guard${held ? '.waits' : ''}`);
  const card = h(`div.cardx.handoff.guard.s-${held ? 'open' : g.status}.is-open`, { id: `card-${id}` },
    cardBar(id, title, state, held ? jumpTo(id) : null, 'Decide'),
    h('p.muted.small', {}, `${g.id}, ${g.kind === 'push' ? 'asked' : 'held'} ${ago2(g.createdAt)}. ${{
      git: "Git's own hooks and settings make git run programs or send a push somewhere else, outside any sandbox; nextlevel didn't make this change, so all git work waits until you decide.",
      secret: g.env ? 'A .env file holds your secrets: nextlevel never commits one.' : 'A value from your .env is a secret: nextlevel commits it only if you say it may be. The value itself is never shown here.',
      push: `${g.why || `A push to ${g.target} may deploy`}, so nothing goes out until you decide.`,
      policy: `${g.source === 'draft' ? `The security engineer drafted a security policy from scan ${g.scan}` : `The project's SECURITY.md (${String(g.commit).slice(0, 8)}) could be the security policy`}. A security policy is what every scan reads as its rules: what matters, what is out of scope. Nothing in the project changes either way.`,
    }[g.kind] || 'Protected files steer the agents and your tools outside any sandbox, so nothing changes until you decide.'} ${g.kind === 'push' ? 'What would go out, as nextlevel reads it from git (not an AI):' : g.kind === 'policy' ? '' : 'What it does, as nextlevel reads it from the change (not an AI):'}`),
    g.warning ? h('p.small.act-held', {}, g.warning) : null,
    g.cut ? h('p.small.muted', {}, `Its text was cut to 64 KB (${g.cut} more characters left out); the approval covers the text shown.`) : null,
    h('ul.guard-summary', {}, (g.summary || []).map((l) => h(`li${/^\s/.test(l) ? '.sub' : ''}`, {}, l.trim()))),
    g.note ? h('p.small.act-held', {}, g.note) : null,
    g.message ? h('p.small', {}, h('span.muted', {}, 'Commit message: '), g.message) : null,
    g.task ? h('p.small', {}, taskLink(g.task)) : null,
    g.notRestored?.length ? h('p.small.bad', {}, `Couldn't be set back: ${g.notRestored.join(', ')}. Put it back by hand, or approve it.`) : null,
    g.kind === 'push' && g.files.length ? h('details.diff', { open: true }, h('summary', {}, g.diffCut ? 'The exact change to the protected files (its first 200 KB; the approval covers all of it)' : 'The exact change to the protected files'), diffView(g.diff || '(no text: see the words above)')) : null,
    g.kind === 'push' && g.files.length ? h('details.diff', {}, h('summary', {}, 'The commits that would go out, newest first'), diffView(g.log || '')) : null,
    g.kind === 'push' && g.files.length ? null : h('details.diff', { open: true }, h('summary', {}, g.kind === 'push' ? 'The commits that would go out, newest first' : g.kind === 'policy' ? (g.diffCut ? 'The exact text, as a change from the policy approved now (its first 200 KB)' : 'The exact text, as a change from the policy approved now') : g.diffCut ? 'The exact change (its first 200 KB; the approval covers all of it)' : 'The exact change'), diffView(g.diff || '(no text: see the words above)')));
  if (held) {
    const area = h('textarea.reply-box', { rows: 2, placeholder: g.kind === 'policy' ? 'Why you reject it (kept with the card)' : 'Why you reject it (the orchestrator reads it)', 'aria-label': `Reason to reject ${g.id}`, dataset: { key: `${key}:reason` }, oninput: (e) => cards.replies.set(key, e.target.value) });
    area.value = cards.replies.get(key) || '';
    const decide = async (action) => {
      if (action === 'approve' && !confirm(g.kind === 'policy' ? `Approve ${g.id}? Exactly this text becomes the policy every scan reads.` : g.kind === 'push' ? `Approve ${g.id}? The hub pushes exactly ${String(g.sha || '').slice(0, 7)} (${g.count} commit(s)) to ${g.target}${g.deploy ? ', which may deploy' : ''}${g.files.length ? `, with its change to ${g.files.join(', ')}` : ''}.` : `Approve ${g.id}? Exactly this change to ${g.files.join(', ')} goes in.`)) return;
      const res = await cardPost('/api/guard', { action, id: g.id, reason: cards.replies.get(key) || '' }, key);
      if (res?.ok) cards.replies.delete(key);
    };
    const help = {
      merge: 'Approve: the hub merges the task. Reject: it goes back to the orchestrator with your reason.',
      commit: 'Approve: the hub commits it. Reject: it stays out.',
      disk: 'Approve: it goes back as changed. Reject: it stays as it was.',
      git: 'Approve: recorded as it is now, and git work goes on. Reject: put back as it was recorded, and git work goes on.',
      push: `Approve: the hub pushes exactly this commit to ${g.target} (if anything moved since, nothing is pushed and a new card asks). Reject: nothing is pushed.`,
      policy: 'Approve: exactly this text becomes the policy every scan reads. Reject: the policy stays as it is, and this text never comes back.',
      secret: g.env ? 'A .env file is never committed: Reject it, and take it out of the change.' : g.on === 'merge' ? 'Approve (only if the value may be public): the hub merges the task. Reject: it goes back to the orchestrator with your reason.' : 'Approve (only if the value may be public): the hub commits it. Reject: it stays out.',
    }[g.kind] || '';
    card.append(area, h('div.row', {},
      g.kind === 'secret' && g.env ? null : h('button.btn.primary', { type: 'button', disabled: busy, onclick: () => decide('approve') }, busy ? '…' : 'Approve'),
      h(`button.btn${g.kind === 'secret' && g.env ? '.primary' : ''}`, { type: 'button', disabled: busy, onclick: () => decide('reject') }, 'Reject'),
      h('span.muted.small', {}, help)));  } else if (g.detail) card.append(h('p.small.muted', {}, g.detail));
  return card;
}

const NOTE_STATE = {
  new: ['warn', (n) => (n.editedAt ? 'Changed: not seen yet' : 'New: not seen yet')],
  seen: ['info', (n) => `Seen by the orchestrator ${ago2(n.seenAt)}`],
  done: ['good', (n) => `Done ${ago2(n.handledAt)}`],
  declined: ['bad', (n) => `Declined ${ago2(n.handledAt)}`],
  withdrawn: ['idle', (n) => `Withdrawn ${ago2(n.handledAt)}`],
  removed: ['idle', (n) => `Removed ${ago2(n.handledAt)}`],
};
function noteCard(n) {
  const key = `n:${n.id}`;
  const rule = n.type === 'rule';
  const [kind, text] = n.off ? ['idle', () => 'Switched off'] : NOTE_STATE[n.status] || ['idle', () => n.status];
  const busy = cards.busy.has(key);
  const card = h(`div.cardx.note.s-${n.status}${n.off ? '.off' : ''}`, { id: `card-${n.id}` },
    h('div.cardx-head', {}, h('span.cid', {}, n.id), h('span.type', {}, rule ? 'Standing rule' : 'One-time'), h(`span.badge.${kind}`, {}, text(n)), h('span.muted.small.when', {}, `added ${ago2(n.createdAt)}`)));
  const editing = cards.edits.has(n.id);
  if (editing) {
    const area = h('textarea.note-box', { rows: 3, 'aria-label': `Edit ${n.id}`, dataset: { key: `${key}:edit` }, oninput: (e) => cards.edits.set(n.id, e.target.value) });
    area.value = cards.edits.get(n.id);
    card.append(area, h('div.row', {},
      h('button.btn.primary', { type: 'button', disabled: busy, onclick: async () => {
        const res = await cardPost('/api/notes', { action: 'edit', id: n.id, text: cards.edits.get(n.id) }, key);
        if (res?.ok) {
          cards.edits.delete(n.id);
          renderCards();
        }
      } }, busy ? '…' : 'Save'),
      h('button.btn', { type: 'button', onclick: () => { cards.edits.delete(n.id); renderCards(); } }, 'Cancel')));
  } else card.append(h('p.note-text', {}, n.text));
  if (n.status === 'done' && (n.reply || n.commit || n.task)) card.append(h('p.reply.good', {}, h('span.muted', {}, 'The orchestrator: '), n.reply, n.commit || n.task ? h('span.links', {}, ' · ', n.commit ? commitLink(n.commit) : null, n.commit && n.task ? ', ' : null, n.task ? taskLink(n.task) : null) : null));
  if (n.status === 'declined') card.append(h('p.reply.bad', {}, h('span.muted', {}, 'Declined: '), n.reply));
  const live = ['new', 'seen'].includes(n.status) || (rule && n.status !== 'removed');
  if (live && !editing) {
    const act = (action, label, primary = false) => h(`button.btn.small${primary ? '.primary' : ''}`, { type: 'button', disabled: busy, onclick: () => cardPost('/api/notes', { action, id: n.id }, key) }, label);
    const buttons = [];
    if (['new', 'seen'].includes(n.status)) buttons.push(h('button.btn.small', { type: 'button', onclick: () => { cards.edits.set(n.id, n.text); renderCards(); } }, 'Edit'));
    if (rule) {
      buttons.push(n.off ? act('on', 'Switch on') : act('off', 'Switch off'));
      buttons.push(h('button.btn.small', { type: 'button', disabled: busy, onclick: () => confirm(`Remove the standing rule ${n.id}? It stays in the history.`) && cardPost('/api/notes', { action: 'remove', id: n.id }, key) }, 'Remove'));
    } else buttons.push(act('withdraw', 'Withdraw'));
    card.append(h('div.row', {}, buttons));
  }
  return card;
}

function addNoteBox() {
  const area = h('textarea.note-box', { rows: 3, placeholder: 'A note for the orchestrator: what to do, change or keep in mind', 'aria-label': 'New note', dataset: { key: 'add' }, oninput: (e) => (cards.draft = e.target.value), onkeydown: (e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && add() });
  area.value = cards.draft;
  const radio = (value, label, hint) => h('label.radio', {}, h('input', { type: 'radio', name: 'note-type', value, checked: cards.type === value, onchange: () => (cards.type = value) }), h('span', {}, h('strong', {}, label), h('span.muted.small', {}, ` ${hint}`)));
  const busy = cards.busy.has('add');
  async function add() {
    if (!cards.draft.trim()) return toast('Type the note first.', 'error');
    const res = await cardPost('/api/notes', { action: 'add', text: cards.draft, type: cards.type }, 'add');
    if (res?.ok) {
      cards.draft = '';
      renderCards();
    }
  }
  return h('div.card.addnote', {}, h('h2', {}, 'Add a note'), area,
    h('div.row.types', {}, radio('once', 'One-time instruction', 'done once, then it moves to the history'), radio('rule', 'Standing rule', 'followed always, until you switch it off or remove it')),
    h('div.row', {}, h('button.btn.primary', { type: 'button', disabled: busy, onclick: add }, busy ? 'Adding…' : 'Add'), h('span.muted.small', {}, 'Ctrl+Enter adds it too.')));
}

function renderCards() {
  const root = $('#cards');
  const d = cards.data;
  if (!d) return;
  if (d.files) $('#notes-files').textContent = `${d.files.notes} and ${d.files.handoff}`;
  const { rules, open, history } = d.notes;
  const q = cards.search.trim().toLowerCase();
  const found = history.filter((n) => !q || `${n.id} ${n.text} ${n.reply} ${n.commit} ${n.task}`.toLowerCase().includes(q));
  // The held changes come from the guard's records; their handoff cards aren't shown twice
  const guarded = (d.guard || []).filter((g) => g.status === 'held' || (g.status === 'approved' && g.kind !== 'disk'));
  const plain = d.handoff.open.filter((x) => !x.guard);
  // (done cards the team answered since: they wait for the owner again, FR-014)
  const answered = d.handoff.answered || [];
  const waiting = guarded.length + plain.length + answered.length;
  // Which card is open: the address's (#H29), else the one the owner opened; when only one waits, that one
  const ids = new Set([...guarded.map((g) => g.card || g.id), ...[...plain, ...answered, ...d.handoff.history].map((x) => x.id)]);
  const asked = hashCard();
  if (asked && !ids.has(asked)) {
    toast(`${asked} isn't there any more.`, 'error');
    if (cards.openId === asked) cards.openId = null;
    history.replaceState(null, '', '#notes');
  }
  if (cards.openId && !ids.has(cards.openId)) cards.openId = null;
  if (!cards.openId && waiting === 1 && !asked && !cards.chose) cards.openId = guarded[0] ? guarded[0].card || guarded[0].id : (plain[0] || answered[0]).id;
  // (a redraw while the owner reads, an answer arriving: the open card stays where it was on the screen)
  const before = cards.openId && !cards.focus ? document.getElementById(`card-${cards.openId}`)?.getBoundingClientRect().top : null;
  const historyOpen = d.handoff.history.some((x) => x.id === cards.openId) || !!root.querySelector('details.done-cards[open]');
  keepFocus(root, () => root.replaceChildren(
    h('div.card.needs-you', {}, h('h2', {}, 'The team needs from you ', h('span.muted', {}, waiting ? String(waiting) : '')),
      waiting ? h('div.cards.card-list', {}, guarded.map(guardCard), plain.map(handoffCard), answered.map(handoffCard)) : h('p.muted', {}, 'Nothing right now. When the team needs something only you can do, it shows up here with what, where and why, and on your phone.'),
      d.handoff.history.length ? h('details.learn.done-cards', { open: historyOpen }, h('summary', {}, `Done and cancelled (${d.handoff.history.length})`), h('div.cards.card-list', {}, d.handoff.history.map(handoffCard))) : null),
    h('div.grid', {},
      h('div.col', {},
        addNoteBox(),
        h('div.card', {}, h('h2', {}, 'Standing rules ', h('span.muted', {}, rules.length ? String(rules.length) : '')),
          rules.length ? h('div.cards', {}, rules.map(noteCard)) : h('p.muted', {}, 'None. A standing rule stays listed, and followed, until you remove it.'))),
      h('div.col', {},
        h('div.card', {}, h('h2', {}, 'To do ', h('span.muted', {}, open.length ? String(open.length) : '')),
          open.length ? h('div.cards', {}, open.map(noteCard)) : h('p.muted', {}, 'No one-time instructions waiting.')),
        h('div.card', {}, h('h2', {}, 'History ', h('span.muted', {}, history.length ? String(history.length) : '')),
          h('input.search', { type: 'search', placeholder: 'Search the history', 'aria-label': 'Search the history', value: cards.search, dataset: { key: 'search' }, oninput: (e) => { cards.search = e.target.value; renderCards(); } }),
          found.length ? h('div.cards', {}, found.map(noteCard)) : h('p.muted', {}, q ? 'Nothing matches.' : 'Handled notes and removed rules show up here.'))))));
  startTicker();
  if (before !== null && before !== undefined) {
    const after = document.getElementById(`card-${cards.openId}`)?.getBoundingClientRect().top;
    if (after !== undefined && after !== before) window.scrollBy(0, after - before);
  }
  // From Home's "Reply" or "Read the answer", or the card's address: that card, open, with its reply box ready; a new
  // answer from its start, below the page's header (FR-014: on a phone the reply box sits under a long answer)
  if (cards.focus) {
    const card = document.getElementById(`card-${cards.focus}`);
    cards.focus = null;
    if (card) {
      const fresh = card.querySelector('.msg.unread');
      if (fresh) window.scrollTo({ top: fresh.getBoundingClientRect().top + window.scrollY - ($('header.top')?.offsetHeight || 0) - 12 });
      else cardTop(card.id.slice(5));
      card.querySelector('textarea')?.focus({ preventScroll: true });
    }
  }
}
// The pinned bar sits under the page's header, whose height changes (its rows wrap on a phone, a banner comes and goes)
if (typeof ResizeObserver === 'function' && $('header.top')) {
  new ResizeObserver(() => document.documentElement.style.setProperty('--top', `${$('header.top').offsetHeight}px`)).observe($('header.top'));
}
window.addEventListener('beforeunload', (e) => {
  if (cards.draft.trim() || cards.edits.size || [...cards.replies.values()].some((v) => v.trim())) e.preventDefault();
});

// ---------- Ask: the owner's read-only side chat (src/ask.mjs), a panel on every page ----------
// Threads come from /api/chats and /api/chat; a question goes to /api/ask, which runs `nextlevel ask` (a fresh,
// read-only session, never the orchestrator's). Any answer can become a draft note, which the owner edits and sends
// through the Notes cards (/api/notes): nothing reaches the orchestrator unless the owner sends it. Texts are shown
// as text, never as HTML. The browser remembers whether the panel is open and which thread (localStorage).
const ASK_KEY = 'nextlevel.ask';
const ask = { open: false, view: 'list', threads: [], q: '', thread: null, busy: false, question: '', draft: null, renaming: false, mode: 'advise', estimate: null, memory: null, memoryEdit: null, memoryText: '', sending: new Set(), drafted: new Map() };
function askRemember() {
  try {
    localStorage.setItem(ASK_KEY, JSON.stringify({ open: ask.open, thread: ask.thread?.id || null, mode: ask.mode }));
  } catch {
    // a browser that keeps nothing: the panel starts closed
  }
}
async function askThreads() {
  const r = await api(`/api/chats?q=${encodeURIComponent(ask.q)}`);
  ask.threads = r.ok ? r.threads : [];
  renderAsk();
}
async function askOpenThread(id) {
  const r = await api(`/api/chat?id=${encodeURIComponent(id)}`);
  if (!r.ok) {
    ask.thread = null;
    ask.view = 'list';
    askRemember();
    return askThreads();
  }
  ask.thread = r.thread;
  ask.view = 'thread';
  ask.draft = null;
  ask.renaming = false;
  askRemember();
  renderAsk();
}
function askToggle(open = !ask.open) {
  ask.open = open;
  $('#ask').hidden = !open;
  $('#ask-open').setAttribute('aria-expanded', String(open));
  document.body.classList.toggle('ask-on', open);
  askRemember();
  if (open) {
    if (ask.view === 'thread' && ask.thread) askOpenThread(ask.thread.id);
    else askThreads();
  }
}
async function askSend({ card = '' } = {}) {
  const question = card ? ask.question.trim() || `Explain ${card}: what it asks of me and why, in micro-steps, and what I should reply.` : ask.question.trim();
  if (!question || ask.busy) return;
  ask.busy = true;
  const shown = (!card && ask.thread) || { id: null, title: card ? `Explain ${card}` : question.slice(0, 60), messages: [] };
  ask.thread = { ...shown, messages: [...shown.messages, { role: 'owner', text: question, at: new Date().toISOString() }] };
  ask.view = 'thread';
  ask.question = '';
  renderAsk();
  // (Explain is always Advise; a question goes as the switch says)
  const r = await api('/api/ask', { question, ...(shown.id ? { thread: shown.id } : {}), ...(card ? { card } : { mode: ask.mode }) });
  ask.busy = false;
  if (r.thread?.id) await askOpenThread(r.thread.id);
  else {
    ask.question = question;
    renderAsk();
  }
  if (!r.ok) toast(r.message || 'The advisor gave no answer.', 'error');
  ask.estimate = null; // (the project moved on, and so did the thread)
}
// Explain on a team's card: the Advisor panel opens on a thread of its own for it
function askExplain(id) {
  if (ask.busy) return toast('The advisor is answering another question: wait for it.', 'error');
  if (!ask.open) askToggle(true);
  ask.thread = null;
  ask.draft = null;
  askSend({ card: id });
}
// What a question will send, before it is sent: the dashboard works out the briefing's size (GET /api/ask/estimate)
async function askEstimate() {
  const mode = ask.mode;
  if (ask.estimate?.mode === mode && Date.now() - ask.estimate.at < 60_000) return;
  ask.estimate = { mode, at: Date.now(), tokens: null };
  const r = await api(`/api/ask/estimate?mode=${encodeURIComponent(mode)}`);
  if (ask.estimate?.mode !== mode) return;
  ask.estimate = { mode, at: Date.now(), tokens: r.ok ? r.tokens : null };
  renderAsk();
}
// The advisor's memory (GET/POST /api/advisor/memory): only the owner's click changes it
async function askMemory() {
  const r = await api('/api/advisor/memory');
  ask.memory = r.ok ? { items: r.items || [], problem: r.problem || '' } : { items: [], problem: r.message || "The memory couldn't be read." };
  renderAsk();
}
async function askMemoryPost(body, okText) {
  const r = await api('/api/advisor/memory', body);
  if (!r.ok) {
    toast(r.message || 'Not done.', 'error');
    return false;
  }
  toast(okText || r.message || 'Done.', 'good');
  await askMemory();
  return true;
}
async function askChat(action, extra = {}) {
  const r = await api('/api/chats', { action, id: ask.thread?.id, ...extra });
  if (!r.ok) return toast(r.message || 'Not done.', 'error');
  if (action === 'delete') {
    ask.thread = null;
    ask.view = 'list';
    askRemember();
    return askThreads();
  }
  ask.thread = r.thread;
  ask.renaming = false;
  renderAsk();
}
// A draft note from an answer: the note it suggested, else the answer without its sources line
function askDraft(m, i) {
  const text = m.note?.text || m.text.split(/\r?\n/).filter((l) => !/^\W{0,4}sources?\W{0,4}:/i.test(l.trim())).join('\n').trim().slice(0, 1500);
  ask.draft = { at: i, text, type: m.note?.type || 'once', sending: false };
  renderAsk();
}
async function askSendNote() {
  const d = ask.draft;
  if (!d?.text.trim() || d.sending) return;
  d.sending = true;
  renderAsk();
  const r = await api('/api/notes', { action: 'add', text: d.text.trim(), type: d.type === 'rule' ? 'rule' : 'once' });
  d.sending = false;
  if (!r.ok) {
    renderAsk();
    return toast(r.message || 'Not sent.', 'error');
  }
  ask.draft = null;
  renderAsk();
  toast(r.message || 'Sent to the orchestrator as a note.', 'good');
}
// One draft of an answer: a note, a standing rule, a reply to a team's card, or a change to the advisor's memory
const DRAFT_SEND = { note: 'Send as note', rule: 'Send as standing rule', remember: 'Remember this' };
function askCardOf(id) {
  return Object.values(cards.data?.handoff || {}).flat().find((x) => x && x.id === id) || null;
}
function askDraftBox(m, i, d, j) {
  const key = `${ask.thread?.id || ''}:${i}:${j}`;
  const sent = ask.drafted.get(key) || (m.sent && typeof m.sent === 'object' ? m.sent[j] : '');
  if (sent) return h('div.ask-draft.sent', {}, h('span.badge.good', {}, String(sent)));
  const busy = ask.sending.has(key);
  const text = ask.drafted.get(`${key}:text`) ?? d.text ?? '';
  const done = (label) => {
    ask.drafted.set(key, label);
    renderAsk();
    // kept on the answer in its thread, so a reload shows it sent too (never a second Send)
    if (ask.thread?.id) api('/api/chats', { action: 'sent', id: ask.thread.id, index: i, at: m.at, draft: j, label }).catch(() => {});
  };
  const send = async (fn, label) => {
    if (busy) return;
    ask.sending.add(key);
    renderAsk();
    try {
      if (await fn()) done(label);
    } finally {
      ask.sending.delete(key);
      renderAsk();
    }
  };
  const box = (label, button, onSend, { editable = true, note = '' } = {}) => h('div.ask-draft', {},
    h('p.small', {}, h('strong', {}, label)),
    editable ? h('textarea', { rows: Math.min(8, Math.max(2, text.split('\n').length + 1)), 'aria-label': label, oninput: (e) => ask.drafted.set(`${key}:text`, e.target.value) }, text) : h('p.small', {}, text),
    note ? h('p.muted.small', {}, note) : null,
    button ? h('div.row', {}, h('button.btn.primary.small', { type: 'button', disabled: busy, onclick: onSend }, busy ? 'Sending…' : button)) : null);
  const now = () => (ask.drafted.get(`${key}:text`) ?? d.text ?? '').trim();
  if (d.kind === 'note' || d.kind === 'rule') {
    return box(d.kind === 'rule' ? 'A standing rule for the orchestrator' : 'A note for the orchestrator', DRAFT_SEND[d.kind], () => send(async () => {
      const r = await api('/api/notes', { action: 'add', text: now(), type: d.kind === 'rule' ? 'rule' : 'once' });
      toast(r.message || (r.ok ? 'Sent to the orchestrator.' : 'Not sent.'), r.ok ? 'good' : 'error');
      return r.ok;
    }, 'Sent as a note'), { note: 'It becomes a note the orchestrator reads at its next start or round (Notes and handoffs).' });
  }
  if (d.kind === 'reply') {
    if (!cards.data) loadCards();
    const c = askCardOf(d.card);
    const why = !cards.data ? '' : !c ? `${d.card} is gone` : c.guard || c.from === 'guard' ? `${d.card} is decided on its own card` : '';
    // (a reply on a closed card reopens it, FR-018: said before the click)
    const closed = !why && c && c.status !== 'open';
    return box(`A reply to ${d.card}`, why || !cards.data ? '' : closed ? `Reopen ${d.card} and send` : `Send reply to ${d.card}`, () => send(async () => {
      const r = await api('/api/handoff', { action: 'reply', id: d.card, reply: now() });
      toast(r.message || (r.ok ? 'Sent.' : 'Not sent.'), r.ok ? 'good' : 'error');
      if (r.ok) loadCards();
      return r.ok;
    }, `Sent to ${d.card}`), { editable: !why, note: why || (c ? `${closed ? `${d.card} is closed: sending reopens it. ` : ''}${d.card}: ${String(c.what || '').split('\n')[0]}` : '') });
  }
  if (d.kind === 'remember') {
    const full = (ask.memory?.items?.length || 0) >= 30 && !d.replaces;
    return box(d.replaces ? `Replace ${d.replaces} in the advisor's memory` : "Remember, in the advisor's memory", full ? '' : d.replaces ? `Replace ${d.replaces}` : DRAFT_SEND.remember, () => send(() => askMemoryPost(d.replaces ? { action: 'edit', id: d.replaces, text: now() } : { action: 'add', text: now(), kind: 'decision', from: ask.thread?.id || '' }, d.replaces ? `${d.replaces} changed.` : 'Remembered.'), d.replaces ? `Replaced ${d.replaces}` : 'Remembered'), { note: full ? 'Memory is full (30): forget one first (Memory, above).' : 'Only you change it. The next answers read it.' });
  }
  if (d.kind === 'forget') {
    const entry = ask.memory?.items?.find((x) => x.id === d.id);
    return box(`Forget ${d.id}`, entry ? `Forget ${d.id}` : '', () => send(() => askMemoryPost({ action: 'remove', id: d.id }, `Forgot ${d.id}.`), `Forgot ${d.id}`), { editable: false, note: entry ? entry.text : `${d.id} isn't in the memory.` });
  }
  return null;
}
function askMessage(m, i) {
  const owner = m.role === 'owner';
  const MODE = { quick: 'Quick', advise: 'Advise', explain: 'Explain' };
  const meta = owner ? '' : [MODE[m.mode] || '', m.engine && (build?.teamChoices?.engines.find((e) => e.name === m.engine)?.title || m.engine), m.model || m.reportedModel, m.tokens?.tokens ? `${Number(m.tokens.tokens).toLocaleString()} tokens` : '', m.briefing?.tokens ? `~${Number(m.briefing.tokens).toLocaleString()} of them project context` : '', Number.isFinite(m.copySeconds) ? `in a copy made in ${m.copySeconds} s` : '', m.at ? time(m.at) : ''].filter(Boolean).join(' · ');
  const box = h(`div.ask-msg.${owner ? 'owner' : 'assistant'}${m.error ? '.error' : ''}`, {},
    h('div.ask-who', {}, owner ? 'You' : m.mode && m.mode !== 'quick' ? 'Advisor' : 'Assistant', meta ? h('span.muted', {}, ` · ${meta}`) : null),
    h('div.ask-text', {}, m.text));
  if (!owner && m.sources?.length) box.append(h('div.ask-sources', {}, h('span.muted', {}, 'Used: '), m.sources.join(', ')));
  // The advisor's drafts: each whole, editable, sent only by its own button
  if (!owner && !m.error && m.drafts?.length) {
    box.append(h('div.ask-drafts', {}, h('p.muted.small', {}, 'Drafts for you to edit and send. Nothing goes to the team until you click. The advisor reads what the team wrote: check before you send.'), m.drafts.map((d, j) => askDraftBox(m, i, d, j))));
    return box;
  }
  if (!owner && !m.error) {
    if (ask.draft?.at === i) {
      const d = ask.draft;
      box.append(h('div.ask-draft', {},
        h('label.sr-only', { for: 'ask-draft-text' }, 'The note'),
        h('textarea', { id: 'ask-draft-text', rows: 4, oninput: (e) => (d.text = e.target.value) }, d.text),
        h('div.row', {},
          h('label.choice-inline', {}, h('input', { type: 'radio', name: 'ask-draft-type', checked: d.type === 'once', onchange: () => (d.type = 'once') }), ' Once'),
          h('label.choice-inline', {}, h('input', { type: 'radio', name: 'ask-draft-type', checked: d.type === 'rule', onchange: () => (d.type = 'rule') }), ' A standing rule')),
        h('p.muted.small', {}, 'Edit it, then send it: it becomes a note the orchestrator reads at its next start or round (Notes and handoffs). Nothing is sent until you do.'),
        h('div.row', {},
          h('button.btn.primary', { type: 'button', disabled: d.sending, onclick: askSendNote }, d.sending ? 'Sending…' : 'Send to the orchestrator'),
          h('button.btn', { type: 'button', onclick: () => ((ask.draft = null), renderAsk()) }, 'Cancel'))));
    } else box.append(h('div.row', {}, h('button.btn.small', { type: 'button', onclick: () => askDraft(m, i) }, m.note ? 'Draft the note it suggests' : 'Draft a note')));
  }
  return box;
}
// Who answers (the Team page's assistant row): kept up to date by the live data without drawing the panel again
function askWho() {
  const who = build?.team?.find((r) => r.key === 'assistant');
  const today = build?.usage?.roles?.find((r) => r.key === 'assistant');
  const used = today?.count ? ` Today: ${today.count} answer(s)${today.tokens ? `, ${Number(today.tokens).toLocaleString()} tokens` : ''}.` : '';
  if (who && !who.none && $('#ask-who')) $('#ask-who').textContent = `Read-only: ${who.engineTitle}, ${who.model.text}.${who.independent && !who.independent.ok ? ' Same engine as the orchestrator.' : ''} It never talks to the orchestrator: only your click sends its drafts.${used}`;
}
function renderAsk() {
  const body = $('#ask-body');
  if (!body || !ask.open) return;
  askWho();
  const composer = h('div.ask-compose', {},
    h('label.sr-only', { for: 'ask-question' }, 'Your question'),
    h('textarea', { id: 'ask-question', rows: 3, placeholder: ask.thread?.id ? 'A follow-up…' : 'Ask about the project: what is blocked, why a task failed, what the plan is…', disabled: ask.busy,
      oninput: (e) => (ask.question = e.target.value),
      onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) askSend(); } }, ask.question),
    h('div.row.ask-mode', { role: 'radiogroup', 'aria-label': 'How it answers' },
      ['advise', 'quick'].map((mode) => h('label.choice-inline', { title: mode === 'advise' ? 'The advisor: its own engine and model, its memory and more of the project' : 'A light model and a short briefing: fewer tokens, for a simple question' },
        h('input', { type: 'radio', name: 'ask-mode', checked: ask.mode === mode, disabled: ask.busy, onchange: () => ((ask.mode = mode), askRemember(), askEstimate(), renderAsk()) }), mode === 'advise' ? ' Advise' : ' Quick')),
      h('span.muted.small', {}, ask.estimate?.mode === ask.mode && Number.isFinite(ask.estimate.tokens) ? `about ${ask.estimate.tokens.toLocaleString()} tokens of project context` : '')),
    h('div.row', {}, h('button.btn.primary', { type: 'button', disabled: ask.busy, onclick: () => askSend() }, ask.busy ? 'Thinking…' : 'Ask'), h('span.muted.small', {}, 'Ctrl+Enter')));
  if (ask.estimate?.mode !== ask.mode) askEstimate();
  if (ask.view === 'memory') {
    if (!ask.memory) askMemory();
    const items = ask.memory?.items || [];
    const edit = (x) => h('div.ask-mem-edit', {},
      h('textarea', { rows: 2, maxlength: 200, 'aria-label': `Edit ${x.id}`, oninput: (e) => (ask.memoryText = e.target.value) }, ask.memoryText),
      h('div.row', {},
        h('button.btn.primary.small', { type: 'button', onclick: async () => (await askMemoryPost({ action: 'edit', id: x.id, text: ask.memoryText }, `${x.id} changed.`)) && ((ask.memoryEdit = null), renderAsk()) }, 'Save'),
        h('button.btn.small', { type: 'button', onclick: () => ((ask.memoryEdit = null), renderAsk()) }, 'Cancel')));
    body.replaceChildren(...[
      h('div.ask-thread-head', {}, h('button.btn.small', { type: 'button', onclick: () => ((ask.view = 'list'), askThreads()) }, '← Threads'), h('strong.ask-title', {}, `Memory (${items.length} of 30)`)),
      h('p.muted.small', {}, "What the advisor keeps about your decisions and preferences, for this project. Only you add, change or delete an entry: from an answer's \"Remember this\", or here. Check where each came from: one you didn't add is worth a look."),
      ask.memory?.problem ? h('p.small.bad', {}, ask.memory.problem) : null,
      items.length
        ? h('ul.ask-memory', {}, items.map((x) => h('li', {},
          ask.memoryEdit === x.id ? edit(x) : [h('span.cid', {}, x.id), ' ', h('span', {}, x.text),
            h('span.muted.small.block', {}, `${x.kind} · ${x.from === 'by hand' ? 'added by hand' : 'from a thread'} · ${ago2(x.at)}`),
            h('span.ask-actions', {},
              h('button.btn.small', { type: 'button', onclick: () => ((ask.memoryEdit = x.id), (ask.memoryText = x.text), renderAsk()) }, 'Edit'),
              h('button.btn.small', { type: 'button', onclick: () => confirm(`Forget ${x.id}?`) && askMemoryPost({ action: 'remove', id: x.id }, `Forgot ${x.id}.`) }, 'Delete'))])))
        : h('p.muted', {}, 'Nothing yet.'),
      h('div.ask-mem-edit', {},
        h('label.sr-only', { for: 'ask-mem-new' }, 'A new entry'),
        h('textarea', { id: 'ask-mem-new', rows: 2, maxlength: 200, placeholder: 'Something the advisor should remember (at most 200 characters)', oninput: (e) => (ask.memoryNew = e.target.value) }, ask.memoryNew || ''),
        h('div.row', {}, h('button.btn.small', { type: 'button', disabled: items.length >= 30, onclick: async () => (await askMemoryPost({ action: 'add', text: ask.memoryNew || '', kind: 'decision' }, 'Remembered.')) && ((ask.memoryNew = ''), renderAsk()) }, items.length >= 30 ? 'Memory is full (30): forget one first' : 'Add'))),
    ].filter(Boolean));
    return;
  }
  if (ask.view === 'list') {
    body.replaceChildren(
      h('div.row.ask-tools', {},
        h('input', { type: 'search', placeholder: 'Search the threads', 'aria-label': 'Search the threads', value: ask.q, oninput: (e) => {
          ask.q = e.target.value;
          clearTimeout(askThreads.timer);
          askThreads.timer = setTimeout(askThreads, 250);
        } }),
        h('button.btn.small', { type: 'button', onclick: () => ((ask.thread = null), (ask.view = 'thread'), (ask.draft = null), askRemember(), renderAsk()) }, 'New thread'),
        h('button.btn.small', { type: 'button', onclick: () => ((ask.view = 'memory'), askMemory()) }, 'Memory')),
      ask.threads.length
        ? h('ul.ask-threads', {}, ask.threads.map((t) => h('li', {}, h('button.linkish', { type: 'button', onclick: () => askOpenThread(t.id) }, h('strong', {}, t.title), h('span.muted.small.block', {}, `${t.count} message(s) · ${time(t.updatedAt)}`), t.match ? h('span.small.block', {}, t.match) : null))))
        : h('p.muted', {}, ask.q ? 'No thread has that.' : 'No threads yet: ask something below.'),
      composer);
  } else {
    const t = ask.thread;
    const head = h('div.ask-thread-head', {},
      h('button.btn.small', { type: 'button', onclick: () => ((ask.view = 'list'), (ask.draft = null), askThreads()) }, '← Threads'),
      ask.renaming && t?.id
        ? h('input', { type: 'text', value: t.title, 'aria-label': 'The thread\'s title', maxlength: 120, onkeydown: (e) => { if (e.key === 'Enter') askChat('rename', { title: e.target.value }); if (e.key === 'Escape') ((ask.renaming = false), renderAsk()); } })
        : h('strong.ask-title', {}, t?.title || 'New thread'),
      t?.id ? h('span.ask-actions', {},
        h('button.btn.small', { type: 'button', onclick: () => ((ask.renaming = !ask.renaming), renderAsk()) }, 'Rename'),
        h('button.btn.small', { type: 'button', onclick: () => confirm('Clear this thread? Its messages go; the thread stays.') && askChat('clear') }, 'Clear'),
        h('button.btn.small', { type: 'button', onclick: () => confirm('Delete this thread?') && askChat('delete') }, 'Delete')) : null);
    const msgs = h('div.ask-messages', {}, (t?.messages || []).map(askMessage), ask.busy ? h('p.muted.small', {}, h('span.spinner'), ' A fresh read-only session is reading the project and your question (a minute or two)…') : null);
    if (t?.messages?.some((m) => m.drafts?.some((d) => d.kind === 'remember' || d.kind === 'forget')) && !ask.memory) askMemory();
    // (what the thread's answers used, in all)
    const total = (t?.messages || []).reduce((n, m) => n + (Number(m.tokens?.tokens) || 0), 0);
    body.replaceChildren(...[head, total ? h('p.muted.small.ask-total', {}, `This thread: ${total.toLocaleString()} tokens in all`) : null, msgs, composer].filter(Boolean));
    msgs.scrollTop = msgs.scrollHeight;
  }
}
$('#ask-open')?.addEventListener('click', () => askToggle());
$('#ask-close')?.addEventListener('click', () => askToggle(false));
document.addEventListener('keydown', (e) => e.key === 'Escape' && ask.open && !ask.draft && $('#report')?.hidden !== false && askToggle(false));
try {
  const saved = JSON.parse(localStorage.getItem(ASK_KEY) || '{}');
  if (saved.mode === 'quick') ask.mode = 'quick';
  if (saved.thread) {
    ask.thread = { id: saved.thread, title: '', messages: [] };
    ask.view = 'thread';
  }
  if (saved.open) ready.then((ok) => ok && askToggle(true));
} catch {
  // nothing remembered
}

// ---------- live updates ----------
function connect() {
  const conn = $('#conn');
  const say = (state, text) => {
    conn.dataset.state = state;
    $('#conn-text').textContent = text;
  };
  const handlers = {
    checks: (data) => {
      checks = JSON.parse(data);
      renderSetup();
    },
    build: (data) => {
      build = JSON.parse(data);
      // (the server's time as this build data left it: an Undo's seconds count from it)
      if (build?.cards?.now) skew = Date.parse(build.cards.now) - Date.now();
      renderAll();
      askWho();
    },
    update: (data) => updating(data),
  };
  let stopped = false;
  // The feed with the key in a header: read as server-sent events, and read again 2 s after it ends
  const read = async () => {
    try {
      const res = await fetch('/events', { headers: { 'x-nextlevel-token': sessionKey }, cache: 'no-store' });
      if (res.status === 403) {
        let data = {};
        try {
          data = await res.json();
        } catch {
          // no body
        }
        if (data.nokey) return keyGone('This page\'s key is no good any more: the dashboard was started again.');
      }
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      say('live', 'Live');
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buf = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done || stopped) break;
        buf += value.replace(/\r\n/g, '\n');
        for (let i = buf.indexOf('\n\n'); i >= 0; i = buf.indexOf('\n\n')) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n');
          try {
            if (event && handlers[event]) handlers[event](data);
          } catch (err) {
            console.error(err); // a page that failed to draw one update draws the next
          }
          if (stopped) return reader.cancel().catch(() => {});
        }
      }
    } catch {
      // the dashboard stopped, or this PC slept: try again
    }
    if (stopped || !sessionKey) return;
    say('lost', 'Reconnecting… is the dashboard window still open?');
    setTimeout(read, 2000);
  };
  // The one-click update stops this dashboard (safe updates): its key is no good on the new one, which opens its own page
  const updating = (data) => {
    let to = '';
    try {
      to = JSON.parse(data).to || '';
    } catch {
      // said without the version
    }
    stopped = true;
    say('lost', 'Updating');
    document.body.append(h('div.update-gone', { role: 'alertdialog', 'aria-label': 'nextlevel is updating' },
      h('div.card', {}, h('h2', {}, `nextlevel is updating${to ? ` to ${to}` : ''}`),
        h('p', {}, 'This dashboard stops now. It opens again on the new version in a new tab (its window prints the link if no tab opens).'),
        h('p.muted.small', {}, 'You can close this tab.'))));
  };
  read();
}

ready.then((ok) => {
  if (!ok) return keyGone(linkCode ? 'This link was used already, or it is more than a minute old: each link opens the dashboard once.' : 'This page has no key for the dashboard.');
  showTab();
  api('/api/docs').then((d) => {
    if (d.ok) {
      const { ok, status, ...byId } = d;
      docs = byId;
      renderSetup();
    }
  });
  connect();
});
