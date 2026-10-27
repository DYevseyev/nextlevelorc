// A stand-in web app for the tester's tests (docs/design/tester.md §11): a small notes app on 127.0.0.1 with three
// test accounts, a sign-in with a CSRF token, a page and an API each may or may not reach, an audit log that fills in
// after a moment, a page that prints a planted password, an endpoint that echoes the session, a redirect to another
// host, 307s that send a body on (to another origin and to this one), a GET with a side effect and a version
// endpoint. Harmless: it answers only the test that started it.
// It runs in a process of its own (the tests drive the hub with spawnSync, which would stop a server in their own
// process): `startWebApp()` starts it and reads its port; `state()` reads what it saw over /__test/state.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const USERS = {
  admin: { email: 'chief@example.com', password: 'admin-pass-0001', role: 'admin' },
  member: { email: 'member@example.com', password: 'member-pass-0002', role: 'member' },
  outsider: { email: 'outsider@example.com', password: 'outsider-pass-0003', role: 'outsider' },
};

function serve({ auditDelayMs = 1200, commit = '', moveTo = '' } = {}) {
  const sessions = new Map(); // sid -> user name
  const csrf = new Set();
  const audit = [];
  const requests = [];
  let sideEffects = 0;
  const comments = [];
  const who = (req) => {
    const m = /(?:^|;\s*)sid=([^;]+)/.exec(req.headers.cookie || '');
    const sid = m?.[1];
    if (sid && sessions.has(sid)) return sessions.get(sid);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1];
    if (bearer && sessions.has(bearer)) return sessions.get(bearer);
    return '';
  };
  const json = (res, status, v, headers = {}) => {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(v));
  };
  const html = (res, status, text) => {
    res.writeHead(status, { 'content-type': 'text/html' });
    res.end(`<!doctype html><html><body>${text}</body></html>`);
  };
  const denyLater = (user, note) => setTimeout(() => audit.push({ action: 'access-denied', note, user }), auditDelayMs);
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url, 'http://x');
      requests.push({ method: req.method, path: `${url.pathname}${url.search}`, cookie: req.headers.cookie || '', authorization: req.headers.authorization || '', body });
      const user = who(req);
      const p = url.pathname;
      if (p === '/__test/state') return json(res, 200, { requests: requests.filter((r) => r.path !== '/__test/state'), audit, comments, sessions: [...sessions.keys()], sideEffects });
      if (p === '/api/csrf' && req.method === 'GET') {
        const t = randomBytes(16).toString('hex');
        csrf.add(t);
        return json(res, 200, { token: t });
      }
      if (p === '/api/session' && req.method === 'POST') {
        let b = {};
        try {
          b = JSON.parse(body);
        } catch {
          // none
        }
        if (!csrf.has(b.csrf)) return json(res, 400, { error: 'no csrf' });
        const name = Object.keys(USERS).find((k) => USERS[k].email === b.email && USERS[k].password === b.password);
        if (!name) return json(res, 401, { error: 'wrong sign-in' });
        const sid = randomBytes(24).toString('hex');
        sessions.set(sid, name);
        return json(res, 200, { ok: true, token: sid }, { 'set-cookie': `sid=${sid}; Path=/; HttpOnly` });
      }
      if (p === '/notes/42' || p === '/api/notes/42') {
        const api = p.startsWith('/api');
        if (!user) {
          res.writeHead(302, { location: '/sign-in?next=%2Fnotes%2F42' });
          return res.end();
        }
        if (user === 'outsider') {
          denyLater(user, 42);
          return api ? json(res, 403, { error: 'denied' }) : html(res, 403, 'You have no access to this note.');
        }
        return api ? json(res, 200, { id: 42, title: 'Quarterly plan' }) : html(res, 200, '<h1>Quarterly plan</h1>');
      }
      if (p === '/sign-in') return html(res, 200, 'Sign in');
      if (p === '/api/audit') {
        if (USERS[user]?.role !== 'admin') return json(res, 403, { error: 'admins only' });
        return json(res, 200, { entries: audit.filter((e) => String(e.note) === url.searchParams.get('note')) });
      }
      if (p === '/api/notes/42/comments' && req.method === 'POST') {
        if (!user || user === 'outsider') return json(res, 403, { error: 'denied' });
        comments.push(body);
        return json(res, 201, { ok: true });
      }
      if (p === '/echo-session') return json(res, 200, { cookie: req.headers.cookie || '', auth: req.headers.authorization || '', you: user });
      if (p === '/leak') return html(res, 200, `debug: password=${USERS.member.password}`);
      if (p === '/off-site') {
        res.writeHead(302, { location: 'http://other.test/collect' });
        return res.end();
      }
      if (p === '/counter') {
        sideEffects++;
        return json(res, 200, { n: sideEffects });
      }
      if (p === '/version') return json(res, 200, { commit });
      // a 307 that sends the body on: to another origin (moveTo), or to this one
      if (p === '/moved' || p === '/moved-here') {
        res.writeHead(307, { location: p === '/moved' ? moveTo : '/echo-body' });
        return res.end();
      }
      if (p === '/echo-body') return json(res, 200, { got: body });
      return json(res, 404, { error: 'no such page' });
    });
  });
  server.listen(0, '127.0.0.1', () => process.stdout.write(`${server.address().port}\n`));
}

// -> { port, url, state(): Promise<{ requests, audit, comments, sessions, sideEffects }>, close() }
export function startWebApp(opts = {}) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), JSON.stringify(opts)], { stdio: ['ignore', 'pipe', 'inherit'] });
  return new Promise((resolve, reject) => {
    let out = '';
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`the stand-in web app ended (${code})`)));
    child.stdout.on('data', (c) => {
      out += c;
      const m = /^(\d+)\n/.exec(out);
      if (!m) return;
      const port = Number(m[1]);
      const url = `http://127.0.0.1:${port}`;
      resolve({
        port,
        url,
        state: () =>
          new Promise((ok, fail) =>
            http.get(`${url}/__test/state`, (res) => {
              let b = '';
              res.on('data', (d) => (b += d));
              res.on('end', () => ok(JSON.parse(b)));
            }).on('error', fail),
          ),
        close: () =>
          new Promise((done) => {
            if (child.exitCode !== null) return done();
            child.once('exit', () => done());
            child.kill();
          }),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) serve(JSON.parse(process.argv[2] || '{}'));
