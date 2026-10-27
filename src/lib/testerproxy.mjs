// The browser's only way out (docs/design/tester.md §6, part 2): a proxy on 127.0.0.1 in the run's own process that every
// request of the tester's Chromium goes through, loopback included. Playwright's route() sees a navigation's first
// request but not the redirects after it, nor what the browser starts by itself; this proxy sees every connection. Each
// one goes only to an origin the run may reach (lib/testernet.mjs urlProblem: the environment's, "alsoAllow", never the
// dashboard's port) and to the address checked for its host (checkedAddress: resolved here once, so no DNS answer of the
// browser's can move it). A plain http:// request is forwarded; https:// and WebSockets come as CONNECT tunnels, checked
// by host and port (the page's method and path are inside the TLS: route() holds those rules). What it refuses is told
// to `onBlock` and answered so the browser fails the request: a 403 with x-nextlevel-refused, or a refused tunnel.
import http from 'node:http';
import net from 'node:net';
import { checkedAddress, urlProblem } from './testernet.mjs';

export const REFUSED_HEADER = 'x-nextlevel-refused';
const HOP = new Set(['proxy-connection', 'proxy-authorization', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding', 'upgrade']);

// -> Promise<{ port, close() }>. onBlock({ method, where, why }) for each refusal, onReach(host) for each host reached.
export function startProxy({ reach, onBlock = () => {}, onReach = () => {} }) {
  const sockets = new Set();
  const refuse = (method, where, why) => {
    try {
      onBlock({ method, where, why });
    } catch {
      // (the run's record)
    }
  };
  const server = http.createServer(async (req, res) => {
    let u;
    try {
      u = new URL(req.url);
    } catch {
      res.writeHead(400, { [REFUSED_HEADER]: '1' });
      return res.end('the tester\'s proxy takes only the browser\'s requests');
    }
    const where = `${u.origin}${u.pathname}`;
    const bad = u.protocol !== 'http:' ? `${u.protocol} isn't sent through the proxy in the clear` : urlProblem(u.href, reach);
    if (bad) {
      refuse(req.method, where, bad);
      res.writeHead(403, { 'content-type': 'text/plain', [REFUSED_HEADER]: '1' });
      return res.end(`refused by nextlevel's tester: ${bad}`);
    }
    let addr;
    try {
      addr = await checkedAddress(u, reach);
    } catch (err) {
      refuse(req.method, where, err.message);
      res.writeHead(err.refused ? 403 : 502, { 'content-type': 'text/plain', [REFUSED_HEADER]: '1' });
      return res.end(`refused by nextlevel's tester: ${err.message}`);
    }
    onReach(u.host);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    const out = http.request({ host: addr.address, family: addr.family, port: u.port || 80, method: req.method, path: `${u.pathname}${u.search}`, headers, agent: false }, (up) => {
      const back = {};
      for (const [k, v] of Object.entries(up.headers)) if (!HOP.has(k.toLowerCase()) && k.toLowerCase() !== REFUSED_HEADER) back[k] = v;
      res.writeHead(up.statusCode || 502, back);
      up.pipe(res);
    });
    out.setTimeout(30_000, () => out.destroy(new Error('no answer in 30 s')));
    out.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { [REFUSED_HEADER]: '1' });
      res.end();
    });
    req.pipe(out);
  });
  server.on('connect', async (req, client, head) => {
    client.on('error', () => {});
    const target = String(req.url || '');
    const at = target.lastIndexOf(':');
    const host = at > 0 ? target.slice(0, at) : '';
    const port = Number(target.slice(at + 1));
    const deny = (why) => {
      refuse('CONNECT', target, why);
      client.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    };
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return deny('not a host and a port');
    // (a tunnel carries https, or a WebSocket on the origin's own scheme: one of them must be an origin the run may reach)
    const tries = [`https://${host}:${port}`, `http://${host}:${port}`];
    const ok = tries.find((o) => !urlProblem(`${o}/`, reach));
    if (!ok) return deny(urlProblem(`${tries[0]}/`, reach));
    let addr;
    try {
      addr = await checkedAddress(new URL(ok), reach);
    } catch (err) {
      return deny(err.message);
    }
    onReach(new URL(ok).host);
    const up = net.connect({ host: addr.address, family: addr.family, port });
    sockets.add(up);
    up.on('close', () => sockets.delete(up));
    up.on('error', () => client.destroy());
    up.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(client);
      client.pipe(up);
    });
    client.on('close', () => up.destroy());
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () =>
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy();
            server.close(() => done());
          }),
      }),
    );
  });
}
