// The tester's HTTP client (docs/design/tester.md §2, §6): every request goes only to the environment's origin or an
// origin the owner named in "alsoAllow", and to the address checked for it. The host is resolved once per request, every
// address it gives is checked (no loopback, private, link-local or other special address, unless the environment's own
// URL is on this PC, and then only that origin and never the dashboard's port), and the connection is made to that
// checked address through a lookup of our own, so no second DNS answer can move it (node:http/https: Node's fetch takes
// no lookup without the undici package). No proxy, no redirect followed here (the runner checks each hop), a time
// limit, and a cap on what is read of a body.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { testStubs } from './proc.mjs';
import { isLoopbackHost } from './testerconfig.mjs';

export const MAX_BODY = 2 * 1024 * 1024;
export const REQUEST_MS = 30_000;

const SPECIAL = new net.BlockList();
for (const [a, p] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]]) SPECIAL.addSubnet(a, p, 'ipv4');
for (const [a, p] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32], ['64:ff9b::', 96], ['100::', 64]]) SPECIAL.addSubnet(a, p, 'ipv6');
// (the documentation ranges 192.0.2/24, 198.51.100/24, 203.0.113/24 and 2001:db8::/32 are special too: no real app is
// there, and a plan's tests use them as "somewhere else")

// Whether an address is one the tester never reaches for an environment on the internet
export function isSpecialAddress(ip) {
  const v = net.isIP(ip);
  if (!v) return true;
  if (v === 6) {
    const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (m) return SPECIAL.check(m[1], 'ipv4');
  }
  return SPECIAL.check(ip, v === 4 ? 'ipv4' : 'ipv6');
}

// The host's addresses, once: the system's resolver, or under the tests' stubs a stand-in (NEXTLEVEL_TEST_RESOLVE:
// JSON { host: [address, ...] }, each lookup taking the next, the last one staying) -> [{ address, family }]
const stubTurns = new Map();
function resolveAll(host) {
  if (net.isIP(host)) return Promise.resolve([{ address: host, family: net.isIP(host) }]);
  const stub = testStubs() !== null && process.env.NEXTLEVEL_TEST_RESOLVE;
  if (stub) {
    let map = {};
    try {
      map = JSON.parse(stub);
    } catch {
      // none
    }
    const list = Array.isArray(map[host]) ? map[host] : null;
    if (!list) return Promise.reject(new Error(`no address for ${host}`));
    const n = stubTurns.get(host) || 0;
    stubTurns.set(host, n + 1);
    const a = String(list[Math.min(n, list.length - 1)]);
    return Promise.resolve([{ address: a, family: net.isIP(a) || 4 }]);
  }
  return new Promise((resolve, reject) => dns.lookup(host, { all: true, verbatim: true }, (err, list) => (err ? reject(err) : resolve(list))));
}

// The origins a run may reach: { origins: Set, local: bool (the environment is on this PC), envOrigin, deny: Set of
// ports never reached on this PC }
export function reachOf(envUrl, alsoAllow = [], { denyPorts = [] } = {}) {
  const u = new URL(envUrl);
  return { envOrigin: u.origin, origins: new Set([u.origin, ...alsoAllow]), local: isLoopbackHost(u.hostname), deny: new Set(denyPorts.map(Number).filter(Boolean)) };
}
// Why a URL may not be reached in this run, or ''
export function urlProblem(url, reach) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return `"${String(url).slice(0, 80)}" isn't an address`;
  }
  if (!['http:', 'https:'].includes(u.protocol)) return `${u.protocol} isn't reached (only the environment's http(s) origin)`;
  if (u.username || u.password) return 'an address with a login in it';
  if (!reach.origins.has(u.origin)) return `${u.host} isn't the environment's origin or one nextlevel.json's "alsoAllow" names`;
  const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
  if (reach.local && isLoopbackHost(u.hostname) && reach.deny.has(port)) return `port ${port} on this PC is nextlevel's own dashboard`;
  return '';
}

// One request, to the checked address: { status, headers: { lowercase: value | [values] }, body: Buffer, truncated,
// address } or throws (with .refused when the rules refused it)
export async function request(url, { method = 'GET', headers = {}, body = null, reach, timeoutMs = REQUEST_MS, maxBytes = MAX_BODY } = {}) {
  const bad = urlProblem(url, reach);
  if (bad) throw Object.assign(new Error(bad), { refused: true });
  const u = new URL(url);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const local = reach.local && u.origin === reach.envOrigin;
  let addrs;
  try {
    addrs = await resolveAll(host);
  } catch (err) {
    throw new Error(`${u.host} doesn't resolve (${err.code || err.message})`);
  }
  if (!addrs.length) throw new Error(`${u.host} has no address`);
  for (const a of addrs) {
    if (local ? !isLoopbackAddress(a.address) : isSpecialAddress(a.address)) {
      throw Object.assign(new Error(`${u.host} resolves to ${a.address}, ${local ? 'not this PC' : 'an address on this PC or a private network'}: not reached`), { refused: true });
    }
  }
  const pinned = addrs[0];
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: host,
        port: u.port || undefined,
        path: `${u.pathname}${u.search}`,
        method,
        headers,
        agent: false,
        timeout: timeoutMs,
        servername: net.isIP(host) ? undefined : host,
        // (the connection goes to the address checked above, whatever a second lookup would say)
        lookup: (_h, opts, cb) => (opts && opts.all ? cb(null, [{ address: pinned.address, family: pinned.family }]) : cb(null, pinned.address, pinned.family)),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        let truncated = false;
        res.on('data', (c) => {
          if (size >= maxBytes) {
            truncated = true;
            return;
          }
          const take = c.subarray(0, maxBytes - size);
          chunks.push(take);
          size += take.length;
          if (take.length < c.length) truncated = true;
        });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), truncated, address: pinned.address }));
        res.on('error', reject);
      },
    );
    const limit = setTimeout(() => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)), timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`no answer in ${Math.round(timeoutMs / 1000)} s`)));
    req.on('error', (err) => {
      clearTimeout(limit);
      reject(err);
    });
    req.on('close', () => clearTimeout(limit));
    if (body !== null && body !== undefined) req.write(body);
    req.end();
  });
}
const isLoopbackAddress = (ip) => {
  const v = net.isIP(ip);
  if (v === 4) return ip.startsWith('127.');
  if (v === 6) return ip === '::1' || /^::ffff:127\./i.test(ip);
  return false;
};

// ---------- cookies: one jar per persona, per host ----------
export function cookieJar() {
  const jar = new Map(); // host -> Map(name -> value)
  return {
    take(host, setCookie) {
      const list = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      for (const line of list) {
        const [pair, ...attrs] = String(line).split(';');
        const eq = pair.indexOf('=');
        if (eq <= 0) continue;
        const name = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        const m = jar.get(host) || new Map();
        const expired = attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) || attrs.some((a) => /^\s*expires\s*=/i.test(a) && Date.parse(a.split('=').slice(1).join('=')) < Date.now());
        if (expired) m.delete(name);
        else m.set(name, value);
        jar.set(host, m);
      }
    },
    header(host) {
      const m = jar.get(host);
      return m && m.size ? [...m].map(([k, v]) => `${k}=${v}`).join('; ') : '';
    },
    // every value it holds (the run redacts them from what it keeps)
    values: () => [...jar.values()].flatMap((m) => [...m.values()]),
  };
}
