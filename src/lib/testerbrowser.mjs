// The tester's browser steps (docs/design/tester.md §6, §7, part 2): Playwright's headless Chromium, one fresh context per
// persona (its own cookies and storage, nothing kept after the run), with three bars between a page and anywhere else:
//   - route(): every request the browser makes itself goes only to the environment's origin and the "alsoAllow" ones,
//     and a request that changes data (anything but GET, HEAD and OPTIONS) only while a sign-in recipe or a step marked
//     "mutates" runs; WebSockets through routeWebSocket() under the same origin rule;
//   - the run's own proxy (lib/testerproxy.mjs), which every connection goes through, loopback included: it sees what
//     route() doesn't (a redirect's next hop, what the browser starts by itself) and connects only to checked addresses;
//   - --host-resolver-rules: each allowed host mapped to the address checked for it, every other name to nothing.
// Downloads are off, service workers blocked, popups closed. A screenshot is taken with password fields, every field a
// sign-in or a step filled and the plan's and environment's masks blacked out; then the page's text and every field's
// value are read for a value the run keeps out (a persona's, a .env value, the run's own session values): one outside a
// mask gets a mask of its own, and when it can't be found in one element, the screenshot isn't kept.
import http from 'node:http';
import net from 'node:net';
import { SAFE_METHODS } from './acceptance.mjs';
import { browserEnv, loadPlaywright } from './browsertools.mjs';
import { pathOnly } from './evidence.mjs';
import { REFUSED_HEADER, startProxy } from './testerproxy.mjs';
import { checkedAddress, reachOf, urlProblem } from './testernet.mjs';

export const STEP_MS = 30_000;
const LAUNCH_MS = 60_000;
const firstLine = (s) => String(s ?? '').split('\n')[0].replace(/\u001b\[[0-9;]*m/g, '').slice(0, 300);

// --host-resolver-rules: each host the run may reach, mapped to its checked address; every other name to nothing
export function resolverRules(pairs) {
  const rules = [];
  for (const [host, address] of pairs) {
    if (net.isIP(host.replace(/^\[|\]$/g, ''))) continue; // (an address is never looked up)
    rules.push(`MAP ${host} ${net.isIP(address) === 6 ? `[${address}]` : address}`);
  }
  return [...rules, 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1'].join(', ');
}

// A URL as a step's record says it: a path on the environment, or another origin and its path (no query values)
const shortUrl = (u, envOrigin) => {
  if (!/^https?:/i.test(String(u))) return /^chrome-error:/i.test(String(u)) ? "the browser's error page" : String(u).split(':')[0];
  try {
    const x = new URL(u);
    return x.origin === envOrigin ? `${x.pathname}${x.search}` : `${x.origin}${x.pathname}`;
  } catch {
    return String(u).slice(0, 200);
  }
};

// The browser for one run: its proxy, Chromium, and a session per persona -> { newSession(opts), blocks, close() }
export async function startBrowser({ chromium, reach, env = process.env }) {
  const blocks = [];
  const hosts = new Set();
  const proxy = await startProxy({ reach, onBlock: (b) => blocks.push(b), onReach: (h) => hosts.add(h) });
  const pairs = [];
  for (const o of reach.origins) {
    const u = new URL(o);
    try {
      pairs.push([u.hostname, (await checkedAddress(u, reach)).address]);
    } catch {
      // (not mapped: the browser finds no address for it, and the proxy says why when a step reaches for it)
    }
  }
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      env: browserEnv(env),
      proxy: { server: `http://127.0.0.1:${proxy.port}`, bypass: '<-loopback>' },
      args: [`--host-resolver-rules=${resolverRules(pairs)}`, '--disable-quic', '--no-pings', '--disable-background-networking', '--disable-component-update', '--disable-domain-reliability', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      handleSIGINT: false,
      handleSIGTERM: false,
      handleSIGHUP: false,
      timeout: LAUNCH_MS,
    });
  } catch (err) {
    await proxy.close();
    throw new Error(`the browser didn't start (${firstLine(err.message)})`);
  }
  return {
    blocks,
    hosts,
    newSession: (opts) => newSession(browser, reach, blocks, opts),
    async close() {
      try {
        await browser.close();
      } catch {
        // (gone already)
      }
      await proxy.close();
    },
  };
}

// Whether the installed browser opens a page: one of its own, from a server on this PC that lives as long as the check
// (the doctor's tester.browser, and after an install). -> '' or what went wrong
export async function probeBrowser(home) {
  const pw = await loadPlaywright(home);
  if (pw.problem) return pw.problem;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><p id="nextlevel-check">nextlevel browser check</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  let b = null;
  try {
    b = await startBrowser({ chromium: pw.chromium, reach: reachOf(`http://127.0.0.1:${server.address().port}`) });
    const s = await b.newSession();
    const r = await s.act({ kind: 'open', path: '/' });
    if (r.refused || r.incomplete) return r.refused || r.incomplete;
    const seen = await s.look();
    return seen.text.includes('nextlevel browser check') ? '' : `it opened the check's page but shows "${seen.text.slice(0, 60)}"`;
  } catch (err) {
    return firstLine(err.message);
  } finally {
    await b?.close();
    server.close();
  }
}

// One persona's context and page. opts: { cookies: [[name, value]] for the environment's origin, bearer() -> token for
// its requests, onWrite(method, path) for each request that changes data and is let through }
async function newSession(browser, reach, blocks, { cookies = [], bearer = () => '', onWrite = () => {} } = {}) {
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } });
  const state = { mayWrite: false, signIn: false, refused: [], writes: [] };
  let page = null;
  const mainNav = (req) => {
    try {
      return req.isNavigationRequest() && !req.frame().parentFrame();
    } catch {
      return false;
    }
  };
  await context.route('**/*', async (route) => {
    const req = route.request();
    const url = req.url();
    const method = req.method().toUpperCase();
    const bad = /^https?:/i.test(url) ? urlProblem(url, reach) : `${url.split(':')[0]}: isn't reached`;
    if (bad) {
      state.refused.push({ method, where: shortUrl(url, reach.envOrigin), why: bad, nav: mainNav(req) });
      return route.abort('blockedbyclient');
    }
    if (!SAFE_METHODS.includes(method)) {
      const where = pathOnly(shortUrl(url, reach.envOrigin));
      if (!state.mayWrite) {
        state.writes.push(`${method} ${where}`);
        return route.abort('blockedbyclient');
      }
      if (!state.signIn) onWrite(method, where);
    }
    const token = bearer();
    if (token && new URL(url).origin === reach.envOrigin) return route.continue({ headers: { ...req.headers(), authorization: `Bearer ${token}` } });
    return route.continue();
  });
  await context.routeWebSocket(
    () => true,
    (ws) => {
      const url = String(ws.url()).replace(/^ws/i, 'http');
      const bad = urlProblem(url, reach);
      if (bad) {
        state.refused.push({ method: 'WEBSOCKET', where: shortUrl(url, reach.envOrigin), why: bad, nav: false });
        return ws.close({ code: 1008, reason: 'refused by the tester' });
      }
      ws.connectToServer();
    },
  );
  if (cookies.length) await context.addCookies(cookies.map(([name, value]) => ({ name, value, url: reach.envOrigin })));
  // (popups and new tabs: closed as they open)
  context.on('page', (p) => {
    if (page && p !== page) p.close().catch(() => {});
  });
  page = await context.newPage();
  let doc = null; // the main frame's last document answer
  page.on('response', (r) => {
    try {
      if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) doc = r;
    } catch {
      // (a frame gone)
    }
  });
  // (after a click or a key: what it started has a moment to start, then the page loads)
  const settle = async () => {
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await page.waitForLoadState('load', { timeout: STEP_MS }).catch(() => {});
  };
  // (the page may still be moving on: read it again once it has loaded)
  const read = async (masks) => {
    for (let i = 0; ; i++) {
      try {
        return await page.evaluate(collect, masks);
      } catch (err) {
        if (i >= 3 || !/context was destroyed|navigat/i.test(String(err.message))) throw err;
        await page.waitForLoadState('load', { timeout: STEP_MS }).catch(() => {});
      }
    }
  };

  return {
    // One action: { kind: open|click|fill|press|wait, path|selector|key|value }. mayWrite: a sign-in recipe (signIn) or a
    // step marked "mutates". -> { refused: why } | { failed: { what, expected, actual } } | { incomplete: why } | {}
    async act(a, { mayWrite = false, signIn = false } = {}) {
      const refusedBefore = state.refused.length;
      const writesBefore = state.writes.length;
      const blocksBefore = blocks.length;
      // (a step's leave to write lasts until the next action: what its click started may come a moment later)
      state.mayWrite = mayWrite;
      state.signIn = signIn;
      let error = null;
      try {
        if (a.kind === 'open') {
          const r = await page.goto(new URL(a.path, reach.envOrigin).href, { waitUntil: 'load', timeout: STEP_MS });
          if (r) doc = r;
        } else if (a.kind === 'click') {
          await page.click(a.selector, { timeout: STEP_MS });
          await settle();
        } else if (a.kind === 'fill') await page.fill(a.selector, a.value, { timeout: STEP_MS });
        else if (a.kind === 'press') {
          await page.keyboard.press(a.key);
          await settle();
        } else if (a.kind === 'wait') await page.waitForSelector(a.selector, { state: 'visible', timeout: STEP_MS });
      } catch (err) {
        error = err;
      }
      const wrote = state.writes.slice(writesBefore);
      if (wrote.length) return { refused: `the page sent ${wrote[0]}${wrote.length > 1 ? ` (and ${wrote.length - 1} more)` : ''}, and the step isn't marked "mutates": not sent` };
      const nav = state.refused.slice(refusedBefore).find((r) => r.nav);
      if (nav) return { refused: `${nav.where}: ${nav.why}` };
      const proxied = blocks.slice(blocksBefore);
      let refusedDoc = false;
      try {
        refusedDoc = !!doc && Object.hasOwn(doc.headers(), REFUSED_HEADER);
      } catch {
        // (none)
      }
      if (refusedDoc || (error && /ERR_TUNNEL_CONNECTION_FAILED|ERR_BLOCKED_BY_CLIENT|ERR_NAME_NOT_RESOLVED/.test(String(error.message)) && proxied.length)) {
        const b = proxied[proxied.length - 1];
        return { refused: b ? `${b.where}: ${b.why}` : 'refused by the tester' };
      }
      if (!error) return {};
      const why = firstLine(error.message);
      if (a.kind === 'open') return { incomplete: `couldn't open ${a.path}: ${why}` };
      const what = { click: `an element ${a.selector} to click`, fill: `a field ${a.selector} to fill`, press: `the key ${a.key} pressed`, wait: `an element ${a.selector} shown` }[a.kind];
      return { failed: { what: a.kind, expected: what, actual: /timeout/i.test(why) ? `none in ${STEP_MS / 1000} s` : why } };
    },
    // What the page shows now, in the shape a step's expectations are judged on (lib/acceptance.mjs judge)
    async look() {
      const hops = [];
      let status = 0;
      let headers = {};
      if (doc) {
        status = doc.status();
        headers = doc.headers();
        let req = doc.request();
        for (let prev = req.redirectedFrom(); prev; req = prev, prev = req.redirectedFrom()) {
          const r = await prev.response();
          hops.unshift({ status: r ? r.status() : 0, location: shortUrl(req.url(), reach.envOrigin) });
        }
      }
      const seen = await read([]);
      let json;
      let isJson = false;
      if (/json/i.test(String(headers['content-type'] || ''))) {
        try {
          json = JSON.parse(seen.text);
          isJson = true;
        } catch {
          // not JSON after all
        }
      }
      return { status, url: shortUrl(page.url(), reach.envOrigin), hops, headers, rawHeaders: headers, text: seen.text, json, isJson };
    },
    // A screenshot that shows no kept value. masks: selectors blacked out; secrets: values never shown.
    // -> { png } | { png: null, why }
    async shot({ masks = [], secrets = [] } = {}) {
      const usable = [];
      for (const sel of masks) {
        try {
          await page.locator(sel).count();
          usable.push(sel);
        } catch {
          return { png: null, why: `the mask "${sel.slice(0, 80)}" isn't a selector the browser takes: the screenshot isn't kept` };
        }
      }
      const seen = await read(usable);
      // (frames: collect() reads the page's own document only; a kept value in a frame's text or fields keeps the picture
      // out, and so does a frame that can't be read)
      for (const f of page.frames()) {
        if (f === page.mainFrame()) continue;
        let t = '';
        try {
          t = await f.evaluate(() => `${document.body ? document.body.innerText : ''}\n${[...document.querySelectorAll('input, textarea')].map((e) => e.value).join('\n')}`);
        } catch {
          return { png: null, why: "a frame on the page couldn't be read: the screenshot isn't kept" };
        }
        if (secrets.some((s) => s && t.includes(s))) return { png: null, why: "a value the run keeps out is in a frame on the page: the screenshot isn't kept" };
      }
      const extra = new Set();
      for (const s of secrets) {
        if (!s) continue;
        const holders = seen.items.filter((i) => i.text.includes(s) || i.value.includes(s));
        if (!holders.length && seen.text.includes(s)) return { png: null, why: 'a value the run keeps out is on the page, not in one element: the screenshot isn\'t kept' };
        for (const h of holders) if (!h.masked) extra.add(h.id);
      }
      try {
        const png = await page.screenshot({ mask: [...usable, ...[...extra].map((id) => `[data-nextlevel-i="${id}"]`)].map((sel) => page.locator(sel)), maskColor: '#000000', animations: 'disabled', timeout: STEP_MS });
        return { png, masked: extra.size };
      } catch (err) {
        return { png: null, why: `no screenshot (${firstLine(err.message)})` };
      }
    },
    // The session's cookies for the environment (the run keeps their values out of everything it writes) -> [[name, value]]
    async cookies() {
      try {
        return (await context.cookies(reach.envOrigin)).map((c) => [c.name, c.value]);
      } catch {
        return [];
      }
    },
    // What the session's pages keep in their storage for the environment and "alsoAllow" origins (a token a single-page
    // app keeps there): its values, which the run keeps out of everything it writes like the cookies' -> [value]
    async storageValues() {
      try {
        const st = await context.storageState();
        return (st.origins || []).filter((o) => reach.origins.has(o.origin)).flatMap((o) => (o.localStorage || []).map((x) => String(x.value ?? '')));
      } catch {
        return [];
      }
    },
    // What a step reached that was refused (but the page itself): [{ method, where, why }]
    refusedSince(n) {
      return state.refused.slice(n).filter((r) => !r.nav);
    },
    refusedCount: () => state.refused.length,
    close: () => context.close().catch(() => {}),
  };
}

// In the page: every element with text of its own or a value, tagged so a mask can name it, and the page's visible text.
// masks: CSS selectors already masked. (Runs in the page: no closure, nothing of the run's.)
function collect(masks) {
  const items = [];
  let n = 0;
  const masked = (el) =>
    masks.some((s) => {
      try {
        return !!el.closest(s);
      } catch {
        return false;
      }
    });
  for (const el of document.querySelectorAll('body, body *')) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    let own = '';
    for (const c of el.childNodes) if (c.nodeType === 3) own += c.nodeValue;
    const value = typeof el.value === 'string' ? el.value : '';
    if (!own.trim() && !value) continue;
    const id = String(n++);
    el.setAttribute('data-nextlevel-i', id);
    items.push({ id, text: own, value, masked: masked(el) });
  }
  return { items, text: document.body ? document.body.innerText : '' };
}
