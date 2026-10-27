// A stand-in for Playwright in nextlevel's tests (docs/design/tester.md §11): the small part of its API the tester's
// browser steps use (src/lib/testerbrowser.mjs), over plain HTML. It runs no script and draws nothing; it does what a
// browser does with the network, so the tests read what the real one would have been allowed to do:
//   - every request goes through the proxy the launch names (the run's own, lib/testerproxy.mjs), loopback included;
//   - a context's route() handler sees the first request of a navigation, a form's submit and every picture, script,
//     style sheet and frame a page loads, but not the redirects after it (as Playwright's route() doesn't);
//   - redirects are followed, cookies kept per context, forms submitted (a click on a submit button, Enter in a field);
//   - evaluate() runs the given function against a small DOM of the page; a screenshot is a "PNG" that holds every
//     text it would show, masks left out, so a test can look for a password in it.
// What it saw goes to ~/.fake-playwright/log.jsonl (launches, routes, screenshots); ~/.fake-playwright/knobs.json can
// make the launch fail ({ "launchFails": true }).
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const HOME = path.join(os.homedir(), '.fake-playwright');
const log = (x) => {
  fs.mkdirSync(HOME, { recursive: true });
  fs.appendFileSync(path.join(HOME, 'log.jsonl'), `${JSON.stringify(x)}\n`);
};
const knobs = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HOME, 'knobs.json'), 'utf8'));
  } catch {
    return {};
  }
};
const timeout = (what, ms) => new Error(`${what}: Timeout ${ms}ms exceeded.`);

// ---------- a small DOM ----------
const VOID = new Set(['input', 'img', 'br', 'meta', 'link', 'hr']);
const BLOCK = new Set(['p', 'h1', 'h2', 'h3', 'div', 'li', 'ul', 'form', 'pre', 'section', 'body']);
class Text {
  constructor(value, parent) {
    this.nodeType = 3;
    this.nodeValue = value;
    this.parentElement = parent;
  }
}
class Element {
  constructor(tag, attrs, parent) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(attrs);
    this.childNodes = [];
    this.parentElement = parent;
    if (this.tagName === 'INPUT') this.value = this.attrs.get('value') || '';
  }
  get children() {
    return this.childNodes.filter((n) => n.nodeType === 1);
  }
  getAttribute(n) {
    return this.attrs.has(n) ? this.attrs.get(n) : null;
  }
  setAttribute(n, v) {
    this.attrs.set(n, String(v));
  }
  hasAttribute(n) {
    return this.attrs.has(n);
  }
  matches(sel) {
    return parseSelector(sel).some((chain) => matchChain(this, chain));
  }
  closest(sel) {
    const groups = parseSelector(sel);
    for (let e = this; e; e = e.parentElement) if (groups.some((chain) => matchChain(e, chain))) return e;
    return null;
  }
  querySelectorAll(sel) {
    const groups = parseSelector(sel);
    const out = [];
    const walk = (e) => {
      for (const c of e.children) {
        if (groups.some((chain) => matchChain(c, chain))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  get innerText() {
    if (/^(SCRIPT|STYLE)$/.test(this.tagName)) return '';
    let out = '';
    for (const c of this.childNodes) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.tagName === 'TEXTAREA') continue;
      else {
        const inner = c.innerText;
        out += BLOCK.has(c.tagName.toLowerCase()) ? `\n${inner}\n` : inner;
      }
    }
    return out.replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }
}
// fn(arg) run with `document` as the given one, its answer passed as Playwright passes it (JSON)
function inDocument(doc, fn, arg) {
  const before = globalThis.document;
  globalThis.document = doc;
  try {
    return JSON.parse(JSON.stringify(fn(arg)));
  } finally {
    if (before === undefined) delete globalThis.document;
    else globalThis.document = before;
  }
}

function parseHtml(html) {
  const root = new Element('#root', [], null);
  let cur = root;
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<\/([a-zA-Z0-9]+)\s*>|<([a-zA-Z0-9]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>|([^<]+)/gi;
  for (const m of String(html).matchAll(re)) {
    if (m[1]) {
      for (let e = cur; e && e !== root; e = e.parentElement) {
        if (e.tagName === m[1].toUpperCase()) {
          cur = e.parentElement;
          break;
        }
      }
    } else if (m[2]) {
      const attrs = [...String(m[3] || '').matchAll(/([^\s=>/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].map((a) => [a[1].toLowerCase(), a[2] ?? a[3] ?? a[4] ?? '']);
      const el = new Element(m[2], attrs, cur);
      cur.childNodes.push(el);
      if (!VOID.has(m[2].toLowerCase())) cur = el;
    } else if (m[4]) cur.childNodes.push(new Text(m[4].replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'), cur));
  }
  for (const t of root.querySelectorAll('textarea')) t.value = t.childNodes.map((c) => c.nodeValue || '').join('');
  const body = root.querySelectorAll('body')[0] || root;
  return { body, querySelectorAll: (sel) => root.querySelectorAll(sel) };
}
// Selectors: groups by ",", descendants by spaces, each a tag or *, #id, .class, [attr], [attr=value]
function parseSelector(sel) {
  const groups = String(sel).split(',').map((g) => g.trim());
  if (!groups.length || groups.some((g) => !g)) throw new Error(`"${sel}" is not a valid selector`);
  return groups.map((g) =>
    g.split(/\s+/).map((part) => {
      const m = /^(\*|[a-zA-Z][a-zA-Z0-9-]*)?((?:#[\w-]+|\.[\w-]+|\[[\w-]+(?:=(?:"[^"]*"|'[^']*'|[^\]]*))?\])*)$/.exec(part);
      if (!m) throw new Error(`"${sel}" is not a valid selector`);
      const c = { tag: m[1] && m[1] !== '*' ? m[1].toUpperCase() : '', ids: [], classes: [], attrs: [] };
      for (const x of m[2].match(/#[\w-]+|\.[\w-]+|\[[^\]]*\]/g) || []) {
        if (x[0] === '#') c.ids.push(x.slice(1));
        else if (x[0] === '.') c.classes.push(x.slice(1));
        else {
          const a = /^\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\]]*)))?\]$/.exec(x);
          c.attrs.push([a[1], a[2] ?? a[3] ?? a[4]]);
        }
      }
      return c;
    }),
  );
}
const matchOne = (e, c) => (!c.tag || e.tagName === c.tag) && c.ids.every((i) => e.getAttribute('id') === i) && c.classes.every((k) => String(e.getAttribute('class') || '').split(/\s+/).includes(k)) && c.attrs.every(([n, v]) => (v === undefined ? e.hasAttribute(n) : e.getAttribute(n) === v));
function matchChain(e, chain) {
  if (!matchOne(e, chain[chain.length - 1])) return false;
  let i = chain.length - 2;
  for (let p = e.parentElement; p && i >= 0; p = p.parentElement) if (p.tagName !== '#ROOT' && matchOne(p, chain[i])) i--;
  return i < 0;
}

// ---------- requests and answers ----------
class Req {
  constructor({ url, method, headers, nav, frame, from = null }) {
    Object.assign(this, { _url: url, _method: method, _headers: headers, _nav: nav, _frame: frame, _from: from, _res: null });
  }
  url() {
    return this._url;
  }
  method() {
    return this._method;
  }
  headers() {
    return { ...this._headers };
  }
  isNavigationRequest() {
    return this._nav;
  }
  frame() {
    return this._frame;
  }
  redirectedFrom() {
    return this._from;
  }
  async response() {
    return this._res;
  }
}
class Res {
  constructor(req, status, headers, body) {
    Object.assign(this, { _req: req, _status: status, _headers: headers, body });
    req._res = this;
  }
  status() {
    return this._status;
  }
  headers() {
    return { ...this._headers };
  }
  url() {
    return this._req.url();
  }
  request() {
    return this._req;
  }
  frame() {
    return this._req.frame();
  }
}
// One request through the proxy the launch named -> { status, headers, body }
function viaProxy(proxy, url, method, headers, body) {
  const p = new URL(proxy);
  const u = new URL(url);
  if (u.protocol !== 'http:') return Promise.reject(new Error(`net::ERR_TUNNEL_CONNECTION_FAILED at ${url}`));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: p.hostname, port: p.port, method, path: url, headers: { ...headers, host: u.host } }, (res) => {
      let b = '';
      res.setEncoding('utf8');
      res.on('data', (d) => (b += d));
      res.on('end', () => resolve({ status: res.statusCode, headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k.toLowerCase(), v])), body: b }));
    });
    req.on('error', () => reject(new Error(`net::ERR_PROXY_CONNECTION_FAILED at ${url}`)));
    if (body) req.write(body);
    req.end();
  });
}

class Browser {
  constructor(opts) {
    this.opts = opts;
  }
  async newContext(opts = {}) {
    log({ kind: 'context', opts });
    return new Context(this, opts);
  }
  async close() {
    log({ kind: 'browser-closed' });
  }
}

class Context extends EventEmitter {
  constructor(browser, opts) {
    super();
    Object.assign(this, { browser, opts, routes: [], jar: new Map() });
  }
  async route(pattern, handler) {
    this.routes.push(handler);
  }
  async routeWebSocket(matcher, handler) {
    log({ kind: 'routeWebSocket' });
    this.wsHandler = handler;
  }
  async addCookies(list) {
    for (const c of list) this.jar.set(c.name, c.value);
  }
  async cookies() {
    return [...this.jar].map(([name, value]) => ({ name, value }));
  }
  // (local storage: what knobs.json's "storage" says, { "<origin>": { "<key>": "<value>" } })
  async storageState() {
    const s = knobs().storage || {};
    return { cookies: [], origins: Object.entries(s).map(([origin, kv]) => ({ origin, localStorage: Object.entries(kv).map(([name, value]) => ({ name, value })) })) };
  }
  async newPage() {
    const page = new Page(this);
    this.emit('page', page);
    return page;
  }
  async close() {
    log({ kind: 'context-closed' });
  }
  // A request as the browser makes it: route() for the first, then the proxy, redirects followed without route()
  async fetch({ url, method = 'GET', headers = {}, body = null, nav = false, frame }) {
    let req = new Req({ url, method, headers: { ...headers }, nav, frame });
    for (const handler of this.routes) {
      let decision = null;
      await handler({
        request: () => req,
        abort: async (code) => (decision = { abort: code }),
        continue: async (o = {}) => (decision = { cont: o }),
      });
      log({ kind: 'route', method, url, decision: decision?.abort ? 'abort' : 'continue', nav });
      if (!decision) throw new Error('route() handler decided nothing');
      if (decision.abort) throw new Error(`net::ERR_BLOCKED_BY_CLIENT at ${url}`);
      if (decision.cont.headers) req._headers = { ...decision.cont.headers };
    }
    const chain = [];
    for (let hop = 0; ; hop++) {
      const cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
      const h = { ...req._headers, ...(cookie ? { cookie } : {}), ...(req._method !== 'GET' && body !== null ? { 'content-type': 'application/x-www-form-urlencoded' } : {}) };
      log({ kind: 'request', method: req._method, url: req._url, nav });
      const r = await viaProxy(this.browser.opts.proxy.server, req._url, req._method, h, req._method === 'GET' ? null : body);
      for (const line of [].concat(r.headers['set-cookie'] || [])) {
        const [pair] = String(line).split(';');
        const eq = pair.indexOf('=');
        if (eq > 0) this.jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
      }
      const res = new Res(req, r.status, r.headers, r.body);
      chain.push(res);
      if (r.status >= 300 && r.status < 400 && r.headers.location && hop < 20) {
        const next = new URL(r.headers.location, req._url).href;
        const m = r.status === 307 || r.status === 308 ? req._method : 'GET';
        req = new Req({ url: next, method: m, headers: req._headers, nav, frame, from: req });
        continue;
      }
      return { res, chain };
    }
  }
}

class Page extends EventEmitter {
  constructor(context) {
    super();
    this.context = context;
    this.frame = { parentFrame: () => null };
    this.doc = parseHtml('');
    this.href = 'about:blank';
    this.focus = null;
    this.keyboard = { press: (key) => this.press(key) };
  }
  mainFrame() {
    return this.frame;
  }
  // (the page's own frame, and a child frame for each of knobs.json's "frames" whose "on" is in the page's address:
  // { on, html } read through evaluate() as the page is, { on, unreadable: true } one that can't be read)
  frames() {
    const kids = (knobs().frames || []).filter((f) => this.href.includes(f.on)).map((f) => ({
      parentFrame: () => this.frame,
      evaluate: async (fn, arg) => {
        if (f.unreadable) throw new Error('frame.evaluate: Execution context was destroyed');
        return inDocument(parseHtml(f.html || ''), fn, arg);
      },
    }));
    return [this.frame, ...kids];
  }
  async close() {
    log({ kind: 'page-closed', url: this.href });
  }
  url() {
    return this.href;
  }
  async navigate(url, method = 'GET', body = null) {
    let got;
    try {
      got = await this.context.fetch({ url, method, body, nav: true, frame: this.frame });
    } catch (err) {
      this.href = 'chrome-error://chromewebdata/';
      this.doc = parseHtml('');
      throw err;
    }
    for (const r of got.chain) this.emit('response', r);
    this.href = got.res.url();
    const type = String(got.res.headers()['content-type'] || '');
    this.doc = parseHtml(/html/.test(type) ? got.res.body : `<pre>${got.res.body.replace(/</g, '&lt;')}</pre>`);
    // what the page loads: pictures, scripts, style sheets and frames (their failures are the page's own)
    for (const el of this.doc.querySelectorAll('img, script, iframe, link')) {
      const src = el.getAttribute('src') || el.getAttribute('href');
      if (!src) continue;
      const frame = el.tagName === 'IFRAME' ? { parentFrame: () => this.frame } : this.frame;
      await this.context.fetch({ url: new URL(src, this.href).href, nav: el.tagName === 'IFRAME', frame }).catch(() => {});
    }
    this.focus = null;
    return got.res;
  }
  async goto(url, opts = {}) {
    try {
      return await this.navigate(url);
    } catch (err) {
      throw new Error(`page.goto: ${err.message}`);
    }
  }
  find(sel, what, ms) {
    const [el] = this.doc.querySelectorAll(sel);
    if (!el) throw timeout(what, ms ?? 30000);
    return el;
  }
  async submit(form) {
    const fields = new URLSearchParams();
    for (const i of form.querySelectorAll('input, textarea')) if (i.getAttribute('name')) fields.append(i.getAttribute('name'), i.value || '');
    const method = String(form.getAttribute('method') || 'get').toUpperCase();
    const action = new URL(form.getAttribute('action') || this.href, this.href);
    if (method === 'GET') action.search = fields.toString();
    // (a navigation that fails leaves the browser's error page, as a real click does: it isn't the click's error)
    await this.navigate(action.href, method, method === 'GET' ? null : fields.toString()).catch(() => {});
  }
  async click(sel, opts = {}) {
    const el = this.find(sel, 'page.click', opts.timeout);
    this.focus = el;
    if (el.tagName === 'A' && el.getAttribute('href')) return this.navigate(new URL(el.getAttribute('href'), this.href).href).catch(() => {});
    const submits = (el.tagName === 'BUTTON' && (el.getAttribute('type') || 'submit') === 'submit') || (el.tagName === 'INPUT' && el.getAttribute('type') === 'submit');
    const form = el.closest('form');
    if (submits && form) await this.submit(form);
  }
  async fill(sel, value, opts = {}) {
    const el = this.find(sel, 'page.fill', opts.timeout);
    if (!['INPUT', 'TEXTAREA'].includes(el.tagName)) throw new Error('page.fill: Error: Element is not an <input> or a <textarea>');
    el.value = String(value);
    this.focus = el;
  }
  async press(key) {
    const form = this.focus?.closest('form');
    if (key === 'Enter' && form && this.focus.tagName === 'INPUT') await this.submit(form);
  }
  async waitForSelector(sel, opts = {}) {
    return this.find(sel, 'page.waitForSelector', opts.timeout);
  }
  async waitForLoadState() {}
  async evaluate(fn, arg) {
    return inDocument(this.doc, fn, arg);
  }
  locator(sel) {
    return { selector: sel, count: async () => this.doc.querySelectorAll(sel).length };
  }
  // A "PNG" with every text it would show (masks left out): what a test looks for a password in
  async screenshot({ mask = [] } = {}) {
    const hidden = new Set();
    for (const l of mask) for (const el of this.doc.querySelectorAll(l.selector)) hidden.add(el);
    const covered = (e) => {
      for (let x = e; x; x = x.parentElement) if (hidden.has(x)) return true;
      return false;
    };
    const shown = [];
    const walk = (e) => {
      for (const c of e.childNodes) {
        if (c.nodeType === 3) {
          if (!covered(e) && c.nodeValue.trim()) shown.push(c.nodeValue);
        } else {
          if (typeof c.value === 'string' && c.value && !covered(c)) shown.push(c.value);
          walk(c);
        }
      }
    };
    walk(this.doc.body);
    log({ kind: 'screenshot', url: this.href, shown, masks: mask.map((l) => l.selector) });
    return Buffer.from(`\u0089PNG stand-in\n${JSON.stringify(shown)}\n`);
  }
}

export const chromium = {
  async launch(opts = {}) {
    log({ kind: 'launch', args: opts.args, env: opts.env, proxy: opts.proxy, headless: opts.headless, browsersPath: process.env.PLAYWRIGHT_BROWSERS_PATH || '' });
    if (knobs().launchFails) throw new Error("browserType.launch: Executable doesn't exist at /stand-in/chrome-headless-shell");
    if (!opts.proxy?.server) throw new Error('the stand-in browser goes out only through a proxy');
    return new Browser(opts);
  },
};
export default { chromium };
