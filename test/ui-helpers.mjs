// The dashboard (nextlevel ui) as tests drive it: started in the background on a sandbox project, spoken to over
// HTTP the way the page does. Used by test/dashboard.test.mjs and test/guard.test.mjs.
import { spawn } from 'node:child_process';
import http from 'node:http';
import { BIN, processesGone, withEnv } from './helpers.mjs';

// `nextlevel ui` in the project, in the background; resolves once it printed its link and the link's one-time code was
// traded for a session key, as the page does (FR-017 part 2A): `ui.token` is that key, `ui.code` the used code.
export async function startUi(p, extraEnv = {}, opts = {}) {
  const ui = await launchUi(p, extraEnv, opts);
  const traded = await trade(ui.port, ui.code);
  if (traded.status !== 200 || !traded.json?.key) throw new Error(`the dashboard's link didn't give a key (${traded.status} ${traded.text}):\n${ui.out}`);
  return Object.assign(ui, { token: traded.json.key });
}
// The page's trade: a link's code for a session key
export const trade = (port, code) => request(port, { method: 'POST', path: '/api/session', body: { code } });
// The links the dashboard printed so far, newest last: [{ url, port, code }]
export const linksIn = (out) => [...out.matchAll(/(http:\/\/127\.0\.0\.1:(\d+)\/\?code=([A-Za-z0-9_-]+))/g)].map((m) => ({ url: m[1], port: Number(m[2]), code: m[3] }));
// `nextlevel ui` as startUi, without trading its link's code
export function launchUi(p, extraEnv = {}, { bin = BIN } = {}) {
  const child = spawn(process.execPath, [bin, 'ui', '--no-open'], {
    cwd: p.repo,
    env: withEnv(p.env, { NEXTLEVEL_HUB_WINDOW: '0', NEXTLEVEL_NO_BROWSER: '1', ...extraEnv }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const ui = { child, out: '' };
  child.stdout.on('data', (d) => (ui.out += d));
  child.stderr.on('data', (d) => (ui.out += d));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the dashboard printed no link:\n${ui.out}`)), 60_000);
    const look = () => {
      const m = linksIn(ui.out)[0];
      if (!m || !/Leave this window open/.test(ui.out)) return;
      clearTimeout(timer);
      child.stdout.off('data', look);
      resolve(Object.assign(ui, m));
    };
    child.stdout.on('data', look);
    child.on('exit', (code) => reject(new Error(`the dashboard exited (${code}):\n${ui.out}`)));
  });
}
// Stops it; resolves once its process is gone, so its folder can be removed
export function stopUi(ui) {
  const child = ui?.child;
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.kill();
  return processesGone([child.pid]);
}

// One HTTP request to the dashboard, the way a browser (or anything else on this PC) would send it. A
// connection of its own each time: the tests block their event loop in spawnSync (a doctor run takes
// 5 s on Windows), so a kept-alive socket the server closed meanwhile would be reused and reset.
export function request(port, { method = 'GET', path: p = '/', headers = {}, body, host = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request(
      { host, port, method, path: p, agent: false, headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (d) => (text += d));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(text);
          } catch {
            // not JSON
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json });
        });
      },
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
export const client = (ui) => ({
  get: (p) => request(ui.port, { path: p, headers: { 'x-nextlevel-token': ui.token } }),
  post: (p, body, headers = {}) => request(ui.port, { method: 'POST', path: p, body, headers: { 'x-nextlevel-token': ui.token, ...headers } }),
});
