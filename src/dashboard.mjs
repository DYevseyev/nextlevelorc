// nextlevel ui: the local dashboard. A node:http server on 127.0.0.1, on a free port; it opens the browser on a
// link with a one-time code, which the page trades for its session key (FR-017 part 2A, below). The page is plain HTML/CSS/JS from src/ui/ and gets live
// updates through server-sent events (/events).
//   Setup     the checks, from `nextlevel doctor --json` run as the owner would run it: each check with
//             its steps and the window to type them in, and a Fix button where the fix needs no window of
//             the owner's (`autoFix`), which runs `nextlevel doctor --fix <id> --json`. Installers and
//             sign-ins stay steps to copy. The page checks again when the owner comes back to it.
//   Home      (M9) at a glance: whether the team runs, one sentence per running task, what needs the owner
//             with the one next action as a button (ownerNeeds, lib/overview.mjs), milestone progress and
//             the day's numbers (autopilot rounds, worker minutes, Codex tokens from the logs). Its Blockers (M11): a
//             headline colored by meaning, then the status file's labeled items (blockersView, lib/overview.mjs).
//   Project   (M11) what the project is (docs/PROJECT.md), the roadmap as milestone cards (the status table, the
//             plans' Outcome, Acceptance and Try it, their tasks from the hub's jobs, the brief's goals; FR-016: each plan
//             found by its Milestone line or its name, and a warning where one is missing, incomplete or doubled), the pace
//             with a rough estimate, and docs/DECISIONS.md as cards: GET /api/project (projectView in hub.mjs,
//             lib/roadmap.mjs), which the page asks for again when the build data's projectStamp changes.
//   Build     milestones, jobs with the engine and model each ran on, running workers with the end of their
//             log and what they changed so far, what waits for review, the hub's log.
//   Team      (M9) each role's engine, model and effort in use; a change runs `nextlevel team set <role> ...
//             --json`, which checks it with the doctor's checks before it saves nextlevel.json. The models a
//             CLI lists come from `nextlevel team models <engine> --json`. Worker windows (FR-010): how a worker's
//             process shows on Windows, set with `nextlevel team window <mode> --json`; Codex workers' sandbox with
//             `nextlevel team sandbox on|off --json`.
//   Tools     start and stop the hub, autopilot on and off, open the orchestrator or a setup guide (in
//             windows of their own, on Windows), where the nextlevel tool is installed.
//   Home      also "Show activity" per running task: its progress notes and, where the engine prints its steps,
//             a technical feed (GET /api/activity, which the page asks for only while the toggle is open). A slot
//             held because a stopped worker's processes may still run there (FR-013) is a card whose Check again
//             (POST /api/slot) has the hub list the processes once more.
//   Notes     the owner's notes to the orchestrator and the team's handoff items, as cards (lib/cards.mjs): add,
//             edit, withdraw a note, switch a standing rule off; mark a handoff item done or reply to it. The
//             orchestrator answers with nextlevel note / handoff; docs/OWNER_NOTES.md and HANDOFF.md are written
//             from the cards. Home lists the open handoff items with a Done button, and the cards the team answered
//             (FR-014: each card is one conversation, every text in it shown as plain text, src/ui/dom.js).
//   Guard     a change to protected files the hub holds (lib/guard.mjs) is a card on the Notes page with what it does
//             in plain words (from code), its exact diff, and Approve and Reject (POST /api/guard): the only place
//             where it is decided. Home has it under Needs you and as "Blocked by the tool".
//   Report    "Report and fix" on a failed check (M5): `nextlevel report <id> --json` builds the report, the
//             page shows its text exactly, and only the owner's click files that text (in this process: the api's
//             fileReport, which refuses any other text; no command files a kept report, FR-017) and, if they asked,
//             the fix's next step
//             (`nextlevel fix <n> --json`: once claude.github passes, the command for the owner's window,
//             since Claude Code starts a cloud session only in a terminal (FR-006); else the steps).
// Nothing is reachable from other machines: the server listens on 127.0.0.1 only. The Host header must
// be this server (so a web page can't point a name of its own at it), and every text sent is redacted like the
// checks' (.env values, token shapes) except the owner's own words on the Notes page (a note, a reply), which the
// page edits. The key (FR-017 part 2A): the link the browser opens carries a one-time code, good once and for a
// minute (CODE_MS), never a key. The page trades it (POST /api/session) for a session key of its own, keeps that in
// the tab's session storage and sends it in a header with every request; then it takes the code out of the address
// bar. Everything but the page's own files needs a session key in that header (POSTs also from this page's origin,
// as JSON): a header, never the address (EventSource can't send one: the page reads /events with fetch), and never a
// cookie, which every other server on 127.0.0.1 (a worker's dev server) would get too. A code or key lives only in
// this process and the page: never on disk, never in a log (the link is printed only to a window or the process that
// started this one, never into a file), and the hub's reopen (ui-open.json) asks this process for a new code.
// The hub (hub.mjs) hands in what the dashboard may read and do (`api`); on disk the dashboard keeps only
// .nextlevel/ui.json (its pid and port) and ui-port.json (the port it had last time).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redact } from './checks/lib.mjs';
import { ENGINE_NAMES } from './engines/index.mjs';
import { clockNow } from './lib/clock.mjs';
import { blockersView, ownerNeeds } from './lib/overview.mjs';
import { openUrl, refreshPath } from './lib/proc.mjs';
import { SECOND_TAKES, WINDOW_MODES } from './lib/config.mjs';
import { TEAM_ROWS } from './lib/team.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const ASSETS = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/dom.js': ['dom.js', 'text/javascript; charset=utf-8'], // h() and a card's conversation, as plain text (FR-014)
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer', // the link has a code in it: never send it to another site
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};
// A link whose code was used already, is more than a minute old, or is an older version's (?token=): only how to open
// the dashboard again (the browser's own colors, light or dark)
const LINK_GONE_PAGE = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark"><title>nextlevel dashboard</title>
<h1>nextlevel dashboard</h1>
<p>This link was used already, or it is more than a minute old: each link to the dashboard opens it once.</p>
<p>To open the dashboard again, double-click START.cmd in your project's folder and choose d, or type
<code>nextlevel ui</code> in PowerShell in your project's folder. Your browser opens it with a new link.</p>`;
const CODE_MS = 60_000; // how long a link's one-time code is good for
const TICK_MS = 1500;
const DOCTOR_TIMEOUT_MS = 5 * 60_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
const firstLines = (s, n = 3) => String(s || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-n).join(' ');
const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Every string in a value, with the secrets blanked out the way check results are (checks/lib.mjs).
function redactDeep(v, secrets) {
  if (typeof v === 'string') return redact(v, secrets);
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, secrets));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x, secrets)]));
  return v;
}

// docs/CHECKS.md, one text per check id: the page's "What this checks".
function checkDocs(toolRoot) {
  const out = {};
  let id = null;
  for (const line of (readText(path.join(toolRoot, 'docs', 'CHECKS.md')) || '').split(/\r?\n/)) {
    const head = line.match(/^###\s+(\S+)/);
    if (head) out[(id = head[1])] = [];
    else if (/^#{1,2}\s/.test(line)) id = null;
    else if (id) out[id].push(line);
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.join('\n').trim()]));
}

// ---------- one dashboard per project: its record, and asking it to open its page again ----------
const recordFile = (stateDir) => path.join(stateDir, 'ui.json');
const openRequest = (stateDir) => path.join(stateDir, 'ui-open.json');
const portFile = (stateDir) => path.join(stateDir, 'ui-port.json'); // the port it had last time
// The one-click update asks a dashboard to stop (safe updates): it tells its open pages, then ends; the update starts it
// again on the new version, which opens its own page (a new key: the old page and server never learn it)
export const stopRequest = (stateDir) => path.join(stateDir, 'ui-stop.json');
export function runningDashboard(stateDir) {
  const r = readJson(recordFile(stateDir));
  return r && r.pid !== process.pid && alive(r.pid) && Date.now() - Date.parse(r.heartbeatAt || 0) < 30_000 ? r : null;
}
// Asks the dashboard running for this project (if one is) to open its page in the browser again, with a new one-time
// code only it knows (never written down: the request carries none). Resolves to the dashboard's record when it did.
export async function reopenDashboard(stateDir) {
  if (!runningDashboard(stateDir)) return false;
  const req = openRequest(stateDir);
  fs.writeFileSync(req, JSON.stringify({ at: now(), pid: process.pid }));
  for (let i = 0; i < 50; i++) {
    if (!fs.existsSync(req)) return runningDashboard(stateDir) || true;
    await sleep(100);
  }
  fs.rmSync(req, { force: true });
  return false;
}

// ---------- the server ----------
// Runs until the process is told to stop (Ctrl+C, the window closing). `open`: open the browser.
export async function startDashboard(api, { port = 0, open = true, say = (m) => console.log(m) } = {}) {
  // One-time codes and session keys (FR-017 part 2A), by their hash: a lookup that says nothing of how close a guess was
  const hash = (s) => crypto.createHash('sha256').update(String(s || '')).digest('base64url');
  const codes = new Map(); // hash of a code not used yet -> when it stops being good
  const keys = new Set(); // hashes of the session keys pages traded a code for
  const newCode = () => {
    for (const [c, until] of codes) if (until <= clockNow()) codes.delete(c);
    const code = crypto.randomBytes(24).toString('base64url');
    codes.set(hash(code), clockNow() + CODE_MS);
    return code;
  };
  const codeGood = (code) => (codes.get(hash(code)) || 0) > clockNow(); // (a test clock under the tests' stubs)
  const keyOk = (given) => typeof given === 'string' && given.length > 0 && keys.has(hash(given));
  // The page's trade: the code is gone once tried, good or not; a key for exactly one tab
  const trade = (code) => {
    const good = codeGood(code);
    codes.delete(hash(code));
    if (!good) return null;
    const key = crypto.randomBytes(32).toString('base64url');
    keys.add(hash(key));
    return key;
  };
  // Read once: an update of the tool while this runs doesn't change the page under it
  const assets = Object.fromEntries(Object.entries(ASSETS).map(([route, [file, type]]) => [route, { body: fs.readFileSync(path.join(UI_DIR, file)), type }]));
  const docs = checkDocs(api.toolRoot);
  const secrets = () => {
    try {
      return api.secrets();
    } catch {
      return [];
    }
  };
  const clean = (v) => redactDeep(v, secrets());
  const clients = new Set();

  // ---- the Setup page: the doctor, one run at a time ----
  let checks = { running: false, fixing: null, at: null, platform: process.platform, summary: null, results: [], error: '', lastFix: null };
  const setChecks = (patch) => {
    checks = { ...checks, ...patch };
    const text = JSON.stringify(clean(checks));
    for (const c of clients) c.write(`event: checks\ndata: ${text}\n\n`);
    pushBuild(); // what needs the owner depends on the checks too
  };
  function doctor(args) {
    refreshPath(); // a tool installed in another window since this dashboard started is found
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [api.bin, '--project', api.root, 'doctor', ...args, '--json'], {
        cwd: api.root,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (err += d));
      const timer = setTimeout(() => child.kill(), DOCTOR_TIMEOUT_MS);
      child.on('error', (e) => (err += e.message));
      child.on('close', () => {
        clearTimeout(timer);
        try {
          resolve({ json: JSON.parse(out) });
        } catch {
          resolve({ error: `the doctor gave no answer: ${firstLines(err || out) || 'no output'}` });
        }
      });
    });
  }
  let chain = Promise.resolve();
  let queued = null;
  const later = (job) => {
    const p = chain.then(job);
    chain = p.catch(() => {});
    return p;
  };
  // Check again, after the run in progress: one more run covers every request made meanwhile. The page asks again
  // by itself whenever it comes back into view: then slow answers (agy's sign-in and models, Codex's and Claude
  // Code's sign-in) kept from the last few minutes are used; the Check again button asks for a fresh run (FR-010).
  let fresh = false;
  function recheck({ fresh: askAfresh = false } = {}) {
    fresh ||= askAfresh;
    if (queued) return queued;
    queued = later(async () => {
      queued = null;
      const args = fresh ? ['--fresh'] : [];
      fresh = false;
      setChecks({ running: true });
      const r = await doctor(args);
      setChecks(r.json ? { running: false, at: now(), platform: r.json.platform, summary: r.json.summary, results: r.json.results, error: '' } : { running: false, at: now(), error: r.error });
    });
    return queued;
  }
  async function fix(id) {
    const r = checks.results.find((x) => x.id === id);
    if (!r) return [404, { ok: false, message: `There is no check "${id}" in the last results: check again first.` }];
    if (!r.autoFix) {
      const message = r.fixable
        ? `"${r.title}" installs or updates a program: that runs in your own window, which can ask for permission and shows the progress. Type its steps where they say, then come back here.`
        : `"${r.title}" has no automatic fix: its steps say what to do, and where.`;
      return [409, { ok: false, message }];
    }
    const report = await later(async () => {
      setChecks({ fixing: id });
      const out = await doctor(['--fix', id]);
      const rep = out.json?.fix || { id, ran: false, fixed: false, reason: out.error, log: [] };
      setChecks(out.json ? { fixing: null, at: now(), summary: out.json.summary, results: out.json.results, error: '', lastFix: rep } : { fixing: null, lastFix: rep });
      return rep;
    });
    return [200, { ok: !!report.fixed, ...report }];
  }

  // ---- the Build page: the hub's files, sent again whenever they change ----
  const snapshot = () => {
    try {
      const state = api.state();
      // (a done card the team answered since waits for the owner under Needs you, but blocks nothing: FR-014)
      return { ok: true, ...state, needs: ownerNeeds(state, checks), blockersCard: blockersView(state.blockers, (state.handoff || []).filter((x) => x.status === 'open'), state.handoffClosed, state.guard) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  };
  let lastBuild = '';
  function pushBuild(to = null) {
    const text = JSON.stringify(clean(snapshot()));
    if (text !== lastBuild) {
      lastBuild = text;
      for (const c of clients) c.write(`event: build\ndata: ${text}\n\n`);
    } else if (to) to.write(`event: build\ndata: ${text}\n\n`);
  }

  // ---- controls: what the hub's api does, and the windows `nextlevel <command>` opens ----
  async function act(fn) {
    const said = [];
    try {
      refreshPath();
      await fn((m) => said.push(String(m)));
      return [200, { ok: true, message: said.join('\n') }];
    } catch (err) {
      return [409, { ok: false, message: [...said, err.message].join('\n') }];
    } finally {
      pushBuild();
    }
  }
  async function updateAction(b) {
    const action = String(b.action || '');
    if (!['update', 'stop', 'retry', 'back', 'skip-backup'].includes(action)) return [400, { ok: false, message: 'which action?' }];
    if (b.to !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._@-]{0,80}$/.test(String(b.to))) return [400, { ok: false, message: 'which version?' }];
    if (b.commit !== undefined && !/^[0-9a-f]{40}$/.test(String(b.commit))) return [400, { ok: false, message: 'which commit?' }];
    if (b.id !== undefined && !/^u-[0-9a-z-]{6,60}$/.test(String(b.id))) return [400, { ok: false, message: 'which update?' }];
    if (!api.update) return [409, { ok: false, message: 'This dashboard is from before the one-click update: run nextlevel update in PowerShell.' }];
    return act((say) => api.update({ action, to: b.to, commit: b.commit, id: b.id }, say));
  }
  // `json`: the command prints JSON on stdout (--json), which comes back parsed as `json`.
  function runTool(args, timeoutMs = 3 * 60_000, { json = false } = {}) {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [api.bin, '--project', api.root, '--no-update', ...args], {
        cwd: api.root,
        env: process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      let stdout = '';
      child.stdout.on('data', (d) => {
        out += d;
        stdout += d;
      });
      child.stderr.on('data', (d) => (out += d));
      const timer = setTimeout(() => child.kill(), timeoutMs);
      child.on('error', (e) => (out += e.message));
      child.on('close', (code) => {
        clearTimeout(timer);
        let parsed = null;
        if (json) {
          try {
            parsed = JSON.parse(stdout);
          } catch {
            // no answer: `out` says why
          }
        }
        resolve({ ok: code === 0, out: out.trim(), json: parsed });
      });
    });
  }
  const WINDOWS = { orchestrator: ['orchestrator'], guide: ['guide'], 'guide-codex': ['guide', 'codex'], 'guide-agy': ['guide', 'agy'], 'guide-claude': ['guide', 'claude'] };
  async function openWindow(what) {
    const args = WINDOWS[what];
    if (!args) return [400, { ok: false, message: `unknown window "${what}"` }];
    if (!api.windows) {
      return [409, { ok: false, message: `That opens a window of its own, which the dashboard does on Windows only. In a terminal, in ${api.root}:  nextlevel ${args.join(' ')}` }];
    }
    refreshPath();
    const r = await runTool(args);
    return [r.ok ? 200 : 409, { ok: r.ok, message: r.out }];
  }

  // ---- Report and fix (M5): a report is shown before anything is filed ----
  async function buildReport(b) {
    const id = String(b.id || '');
    if (!/^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/.test(id)) return [400, { ok: false, message: 'which check?' }];
    const r = await runTool(['report', id, '--json'], 5 * 60_000, { json: true });
    if (!r.json) return [500, { ok: false, message: `The report wasn't made: ${firstLines(r.out) || 'no answer'}` }];
    // What the page shows must be the text that is filed: if this page's own redaction would still change it,
    // it is neither shown nor filed
    const shown = clean({ title: r.json.title, body: r.json.body });
    if (r.json.ok && (shown.title !== r.json.title || shown.body !== r.json.body)) {
      return [500, { ok: false, message: "The report still had a value from .env in it after its redaction, so it isn't shown or filed. Tell nextlevel's developers, without the report." }];
    }
    return [r.json.ok ? 200 : 409, r.json];
  }
  // File it: in this process, on the owner's request with this dashboard's key, exactly the text the page showed. No
  // command files a kept report (FR-017: `report --send` refuses), so an agent's session can't file one.
  async function sendReport(b) {
    const id = String(b.id || '');
    const hash = String(b.hash || '');
    if (!/^[\w.-]{1,100}$/.test(id) || !/^[0-9a-f]{16}$/.test(hash)) return [400, { ok: false, message: 'which report?' }];
    refreshPath();
    const sent = await api.fileReport(id, hash);
    if (!sent.ok) return [409, { ok: false, message: sent.message }];
    if (!b.fix) return [200, { ...sent, fix: null }];
    const fixed = await runTool(['fix', String(sent.issue.number), '--json'], 4 * 60_000, { json: true });
    return [200, { ...sent, fix: fixed.json || { ok: false, started: false, message: `The fix didn't start: ${firstLines(fixed.out) || 'no answer'}` } }];
  }

  // ---- the Team page (M9): the models a CLI lists, and a change checked before it is saved ----
  const modelLists = new Map(); // engine or profile -> { at, answer }: a CLI's list, kept 10 minutes
  async function teamModels(name) {
    if (!/^[a-z0-9][a-z0-9._-]{0,39}$/.test(name)) return [400, { ok: false, message: 'which engine?' }];
    const kept = modelLists.get(name);
    if (kept && Date.now() - kept.at < 10 * 60_000) return [200, kept.answer];
    const r = await runTool(['team', 'models', name, '--json'], 90_000, { json: true });
    if (!r.json) return [500, { ok: false, message: `No list: ${firstLines(r.out) || 'no answer'}` }];
    if (r.json.ok) modelLists.set(name, { at: Date.now(), answer: r.json });
    return [r.json.ok ? 200 : 409, r.json];
  }
  let teamBusy = false;
  // ---- Ask: one question at a time, answered by `nextlevel ask --json` (its own process: the page stays live) ----
  let asking = false;
  async function ask(b) {
    const question = typeof b.question === 'string' ? b.question.trim() : '';
    if (!question || question.length > 4000) return [400, { ok: false, message: 'A question has 1 to 4000 characters.' }];
    if (b.thread !== undefined && b.thread !== null && !/^[a-z0-9]{8,32}$/.test(String(b.thread))) return [400, { ok: false, message: 'which thread?' }];
    if (asking) return [409, { ok: false, message: 'The assistant is answering another question: wait for it.' }];
    asking = true;
    try {
      const r = await runTool(['ask', '--json', ...(b.thread ? ['--thread', String(b.thread)] : []), '--', question], 12 * 60_000, { json: true });
      if (!r.json) return [500, { ok: false, message: `No answer: ${firstLines(r.out) || 'nothing came back'}` }];
      return [r.json.ok ? 200 : 409, r.json];
    } finally {
      asking = false;
    }
  }
  function chatAction(b) {
    const id = String(b.id || '');
    try {
      if (b.action === 'new') return [200, { ok: true, thread: api.chats.create(String(b.title || 'New thread').slice(0, 120)) }];
      if (!/^[a-z0-9]{8,32}$/.test(id)) return [400, { ok: false, message: 'which thread?' }];
      if (b.action === 'rename') return [200, { ok: true, thread: api.chats.rename(id, String(b.title || '').slice(0, 120)) }];
      if (b.action === 'clear') return [200, { ok: true, thread: api.chats.clear(id) }];
      if (b.action === 'delete') return [200, { ok: true, deleted: api.chats.remove(id) ?? id }];
      return [400, { ok: false, message: 'action must be new, rename, clear or delete' }];
    } catch (err) {
      return [409, { ok: false, message: err.message }];
    }
  }

  async function teamSet(b) {
    if (b.window !== undefined) return teamWindow(b.window);
    if (b.codexSandbox !== undefined) return teamSandbox(b.codexSandbox);
    if (b.githubChecks !== undefined) return teamChecks(b.githubChecks);
    const role = String(b.role || '');
    if (!TEAM_ROWS.some((r) => r.key === role)) return [400, { ok: false, message: 'which role?' }];
    const word = (v, re) => v === undefined || v === null || v === '' || (typeof v === 'string' && re.test(v));
    if (!word(b.engine, /^[a-z]+$/) || !word(b.profile, /^[a-z0-9][a-z0-9._-]{0,39}$/) || !word(b.model, /^[\w.:/@+[\]-]{1,100}$/) || !word(b.effort, /^[a-z][a-z0-9-]{0,19}$/)) {
      return [400, { ok: false, message: 'That engine, model or effort has characters it can\'t have.' }];
    }
    if (b.engine && !ENGINE_NAMES.includes(b.engine) && !(role === 'guide' && b.engine === 'orchestrator') && !(role === 'assistant' && b.engine === 'auto') && !(role === 'worker-second' && b.engine === 'none')) return [400, { ok: false, message: 'unknown engine' }];
    // (the second worker's note: what it takes)
    if (b.takes !== undefined && (role !== 'worker-second' || !Object.hasOwn(SECOND_TAKES, String(b.takes)))) return [400, { ok: false, message: `takes is the second worker's: ${Object.keys(SECOND_TAKES).join(', ')}` }];
    if (teamBusy) return [409, { ok: false, message: 'Another change is being checked: wait for it.' }];
    teamBusy = true;
    try {
      const args = ['team', 'set', role, ...(b.profile ? ['--profile', b.profile] : b.engine === 'none' ? ['--engine', 'none'] : ['--engine', String(b.engine || ''), '--model', String(b.model || ''), '--effort', String(b.effort || '')]), ...(b.takes !== undefined && b.engine !== 'none' ? ['--takes', String(b.takes)] : [])];
      if (b.check) args.push('--check');
      const r = await runTool([...args, '--json'], 5 * 60_000, { json: true });
      if (!r.json) return [500, { ok: false, message: `The check gave no answer: ${firstLines(r.out) || 'no answer'}` }];
      return [r.json.ok ? 200 : 409, r.json];
    } finally {
      teamBusy = false;
      pushBuild();
    }
  }

  // How a worker's process shows (workers.window, FR-010): nextlevel team window <mode>
  async function teamWindow(mode) {
    if (!WINDOW_MODES.includes(mode)) return [400, { ok: false, message: `workers.window is ${WINDOW_MODES.join(', ')}` }];
    if (teamBusy) return [409, { ok: false, message: 'Another change is being checked: wait for it.' }];
    teamBusy = true;
    try {
      const r = await runTool(['team', 'window', mode, '--json'], 60_000, { json: true });
      if (!r.json) return [500, { ok: false, message: `No answer: ${firstLines(r.out) || 'no answer'}` }];
      return [r.json.ok ? 200 : 409, r.json];
    } finally {
      teamBusy = false;
      pushBuild();
    }
  }

  // Codex workers' sandbox (engines.codex.workerArgs): nextlevel team sandbox on|off, the owner's change
  async function teamSandbox(on) {
    if (typeof on !== 'boolean') return [400, { ok: false, message: "codexSandbox is true (in Codex's sandbox) or false (without it)" }];
    if (teamBusy) return [409, { ok: false, message: 'Another change is being checked: wait for it.' }];
    teamBusy = true;
    try {
      const r = await runTool(['team', 'sandbox', on ? 'on' : 'off', '--json'], 60_000, { json: true });
      if (!r.json) return [500, { ok: false, message: `No answer: ${firstLines(r.out) || 'no answer'}` }];
      return [r.json.ok ? 200 : 409, r.json];
    } finally {
      teamBusy = false;
      pushBuild();
    }
  }

  // The project's GitHub checks on this PC: Check again reads the repository afresh (nextlevel team runner status, GETs
  // with the owner's gh). Setting it up is the self-hosted runner's part B.
  async function teamChecks(what) {
    if (what !== 'check') return [400, { ok: false, message: 'githubChecks is "check"' }];
    if (teamBusy) return [409, { ok: false, message: 'Another change is being checked: wait for it.' }];
    teamBusy = true;
    try {
      const r = await runTool(['team', 'runner', 'status', '--json'], 3 * 60_000, { json: true });
      if (!r.json) return [500, { ok: false, message: `No answer: ${firstLines(r.out) || 'no answer'}` }];
      return [200, { ok: true, message: `GitHub checks: ${r.json.githubChecks?.title || 'read'}.` }];
    } finally {
      teamBusy = false;
      pushBuild();
    }
  }

  // ---- the Notes page: the owner's notes and the team's handoff items, as cards (lib/cards.mjs) ----
  // The owner's own words (a note, a reply) come back as they are: the page edits them. What the team wrote (its
  // replies, the handoff items) is redacted like everything else the page gets.
  const team = (x, keys) => ({ ...x, ...Object.fromEntries(keys.map((k) => [k, clean(x[k] ?? '')])) });
  const NOTE_TEAM = ['reply', 'commit', 'task'];
  const HANDOFF_TEAM = ['what', 'where', 'why', 'note', 'task'];
  const noteView = (n) => team(n, NOTE_TEAM);
  // (a card's thread, FR-014: the team's answers redacted, the owner's replies as they are)
  const handoffView = (x) => ({ ...team(x, HANDOFF_TEAM), thread: (x.thread || []).map((e) => (e.by === 'team' ? { ...e, text: clean(e.text ?? '') } : e)) });
  function cardsView() {
    const v = api.cards.view();
    const notes = Object.fromEntries(Object.entries(v.notes).map(([k, list]) => [k, list.map(noteView)]));
    const handoff = Object.fromEntries(Object.entries(v.handoff).map(([k, list]) => [k, list.map(handoffView)]));
    // The changes the guard holds, with their words and exact diff, from its own records (never from the card, which
    // the team could edit): redacted like everything else, a value from .env included
    return { ok: true, ...v, notes, handoff, guard: clean(api.guard ? api.guard.view() : []) };
  }
  // ---- Approve or Reject a held change (lib/guard.mjs): only here, on this page ----
  function guardAction(b) {
    const id = String(b.id || '');
    if (!/^G\d{1,7}$/.test(id)) return [400, { ok: false, message: 'which change?' }];
    if (!['approve', 'reject'].includes(b.action)) return [400, { ok: false, message: 'action must be approve or reject' }];
    if (b.reason !== undefined && (typeof b.reason !== 'string' || b.reason.length > 1000)) return [400, { ok: false, message: 'a reason has at most 1000 characters' }];
    try {
      return [200, { ok: true, ...api.guard.decide({ id, action: b.action, reason: b.reason || '' }) }];
    } catch (err) {
      return [409, { ok: false, message: err.message }];
    } finally {
      pushBuild();
    }
  }
  function cardAction(fn, b, view) {
    try {
      const r = fn(b || {});
      return [200, { ok: true, ...r, item: r.item && view(r.item) }];
    } catch (err) {
      return [409, { ok: false, message: err.message }];
    } finally {
      pushBuild();
    }
  }

  // ---- HTTP ----
  let hosts = new Set();
  const send = (res, status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type });
    res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  };
  const reply = (res, [status, body], { raw = false } = {}) => send(res, status, raw ? body : clean(body));
  function readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size <= 2_000_000) chunks.push(c);
      });
      req.on('end', () => {
        try {
          resolve(size <= 2_000_000 && chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
        } catch {
          resolve({});
        }
      });
      req.on('error', () => resolve({}));
    });
  }
  function events(req, res) {
    res.writeHead(200, { ...HEADERS, 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    res.write(`event: checks\ndata: ${JSON.stringify(clean(checks))}\n\n`);
    pushBuild(res);
  }
  async function handle(req, res) {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    // A page elsewhere that points a name of its own at 127.0.0.1 sends that name: refused
    if (!hosts.has(String(req.headers.host || '').toLowerCase())) return send(res, 403, 'This dashboard answers at 127.0.0.1 only.', 'text/plain; charset=utf-8');
    const asset = req.method === 'GET' && assets[url.pathname];
    if (asset && url.pathname !== '/') return send(res, 200, asset.body, asset.type);
    // The page holds no data: without a code it shows how to open the dashboard, or works with its tab's session key.
    // A link with a code used already or too old (or an older version's ?token=) gets only how to open it again.
    if (asset) return url.search && !codeGood(url.searchParams.get('code')) ? send(res, 403, LINK_GONE_PAGE, 'text/html; charset=utf-8') : send(res, 200, asset.body, asset.type);
    if (url.pathname === '/favicon.ico') return send(res, 204, '');
    const session = req.method === 'POST' && url.pathname === '/api/session' && !url.search;
    if (!session && !keyOk(req.headers['x-nextlevel-token'])) return send(res, 403, { ok: false, nokey: true, message: "This needs the dashboard's key: open the dashboard again (START.cmd -> d, or nextlevel ui)." });
    if (req.method === 'POST') {
      const origin = req.headers.origin;
      const site = req.headers['sec-fetch-site'];
      if ((origin && !hosts.has(origin.toLowerCase().replace(/^http:\/\//, ''))) || (site && site !== 'same-origin')) {
        return send(res, 403, { ok: false, message: "Only the dashboard's own page may do this." });
      }
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) return send(res, 415, { ok: false, message: 'send JSON' });
    }
    const b = req.method === 'POST' ? await readBody(req) : {};
    if (session) {
      const key = trade(typeof b.code === 'string' ? b.code : '');
      if (key) return send(res, 200, { ok: true, key });
      say('A dashboard link was tried after it was used or had expired: if that was not you, something else on this PC tried it.');
      return send(res, 403, { ok: false, gone: true, message: 'This link was used already, or it is more than a minute old.' });
    }
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /events':
        return events(req, res);
      case 'GET /api/state':
        return reply(res, [200, snapshot()]);
      case 'GET /api/checks':
        if (!checks.at && !checks.running) recheck();
        return reply(res, [200, checks]);
      case 'POST /api/checks':
        recheck({ fresh: b.fresh === true });
        return reply(res, [202, { ok: true }]);
      case 'POST /api/fix':
        return reply(res, await fix(String(b.id || '')));
      case 'GET /api/docs':
        return reply(res, [200, docs]);
      case 'GET /api/project':
        return reply(res, [200, api.project()]);
      case 'GET /api/job': {
        const job = api.job(url.searchParams.get('id'));
        return reply(res, job ? [200, job] : [404, { ok: false, message: 'no such job' }]);
      }
      case 'GET /api/activity': {
        // a running task's progress notes and technical feed: asked for only while its toggle is open
        const activity = api.activity(url.searchParams.get('id'));
        return reply(res, activity ? [200, { ok: true, ...activity }] : [404, { ok: false, message: 'no such task' }]);
      }
      case 'GET /api/cards':
        return reply(res, [200, cardsView()], { raw: true }); // redacted where the team wrote it (cardsView)
      case 'POST /api/notes':
        return reply(res, cardAction(api.cards.note, b, noteView), { raw: true }); // the owner's own note comes back
      case 'POST /api/handoff':
        return reply(res, cardAction(api.cards.handoff, b, handoffView), { raw: true });
      case 'POST /api/guard':
        return reply(res, guardAction(b));
      case 'POST /api/hub':
        if (b.action === 'start') return reply(res, await act((say) => api.startHub(say)));
        if (b.action === 'stop') return reply(res, await act((say) => api.stopHub(say)));
        return reply(res, [400, { ok: false, message: 'action must be start or stop' }]);
      case 'POST /api/autopilot':
        return reply(res, await act((say) => api.setAutopilot(!!b.on, say)));
      case 'POST /api/round':
        // Run a round now (FR-019): the owner acting; the hub starts the round at its next look
        return reply(res, await act((say) => api.runRoundNow(say)));
      case 'POST /api/slot': {
        // Check again on a slot held for a stopped worker's processes (FR-013)
        const slot = Number(b.slot);
        if (!Number.isInteger(slot) || slot < 1 || slot > 99) return reply(res, [400, { ok: false, message: 'which slot?' }]);
        return reply(res, await act((say) => api.checkSlot(slot, say)));
      }
      case 'POST /api/update':
        // The one-click update (safe updates): Update, Stop waiting, Try again, Go back. Protected like Approve: the key in a
        // header, from this page's own origin, as JSON (above), and naming exactly the update the card showed
        return reply(res, await updateAction(b));
      case 'POST /api/agy':
        // Check again on the card of Antigravity tasks waiting for a passing trial (FR-022)
        return reply(res, await act((say) => api.checkAgyAgain(say)));
      case 'POST /api/lock':
        // Check again on the card of the orchestrator on Antigravity held by its lock test
        return reply(res, await act((say) => api.checkLockAgain(say, b.role === 'assistant' ? 'assistant' : 'orchestrator')));
      case 'POST /api/asktripwire':
        // Seen, on the card that says the project changed while the assistant on Antigravity answered
        return reply(res, await act((say) => api.askTripwireSeen(say)));
      case 'POST /api/slotescape':
        // Seen, on the card of a worker that did something outside its slot
        return reply(res, await act((say) => api.slotEscapeSeen(say)));
      case 'POST /api/blockalert':
        // Seen, on the card of a round on Antigravity that ran commands clearing the push block
        return reply(res, await act((say) => api.blockAlertSeen(say)));
      case 'POST /api/open':
        return reply(res, await openWindow(String(b.what || '')));
      case 'GET /api/team/models':
        return reply(res, await teamModels(String(url.searchParams.get('engine') || '')));
      case 'POST /api/team':
        return reply(res, await teamSet(b));
      // ---- Ask (src/ask.mjs): the owner's read-only side chat, its threads in .nextlevel/chats/ ----
      case 'GET /api/chats':
        return reply(res, [200, { ok: true, threads: api.chats.list({ search: String(url.searchParams.get('q') || '').slice(0, 200) }) }]);
      case 'GET /api/chat': {
        const t = api.chats.get(String(url.searchParams.get('id') || ''));
        return reply(res, t ? [200, { ok: true, thread: t }] : [404, { ok: false, message: 'no such thread' }]);
      }
      case 'POST /api/chats':
        return reply(res, chatAction(b));
      case 'POST /api/ask':
        return reply(res, await ask(b));
      case 'POST /api/report':
        return reply(res, await buildReport(b));
      case 'POST /api/report/send': {
        const out = await sendReport(b);
        pushBuild(); // the fixes list
        return reply(res, out);
      }
      default:
        return send(res, 404, { ok: false, message: 'not found' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) send(res, 500, { ok: false, message: err.message });
      else res.end();
    });
  });
  const listen = (at) =>
    new Promise((resolve, reject) => {
      const failed = (err) => reject(err);
      server.once('error', failed);
      server.listen(at, '127.0.0.1', () => {
        server.off('error', failed);
        resolve();
      }); // 127.0.0.1 only: nothing else on the network can connect
    });
  // The port it had last time, when it is free: the page keeps what the browser remembers for it (which
  // activity toggles are open) only on the same address
  const lastPort = Number(readJson(portFile(api.stateDir))?.port) || 0;
  if (!port && lastPort > 1024 && lastPort < 65536) {
    try {
      await listen(lastPort);
    } catch {
      await listen(0);
    }
  } else await listen(port);
  const actual = server.address().port;
  try {
    fs.mkdirSync(api.stateDir, { recursive: true });
    fs.writeFileSync(portFile(api.stateDir), JSON.stringify({ port: actual }));
  } catch {
    // only a convenience
  }
  hosts = new Set([`127.0.0.1:${actual}`, `localhost:${actual}`]);
  const link = () => `http://127.0.0.1:${actual}/?code=${newCode()}`;
  // The link goes to a window or to the process that started this one (a pipe), never into a file: a dashboard the
  // update started in the background writes its output to .nextlevel/logs/ui-console.log. (Under the tests' stubs only,
  // NEXTLEVEL_TEST_LINK_IN_FILE=1 lets the one-click update's tests read the link of the dashboard it started: whoever
  // sets this process's environment owns this dashboard anyway.)
  const intoFile = (() => {
    if (process.env.NEXTLEVEL_TEST_STUBS && process.env.NEXTLEVEL_TEST_LINK_IN_FILE === '1') return false;
    try {
      return fs.fstatSync(1).isFile();
    } catch {
      return false;
    }
  })();
  const startedAt = now();
  const record = recordFile(api.stateDir);
  const beat = () => {
    try {
      fs.mkdirSync(api.stateDir, { recursive: true });
      // (and how it runs, for the update to start it again the same way: a window of its own, the browser, the version)
      fs.writeFileSync(record, JSON.stringify({ pid: process.pid, port: actual, startedAt, heartbeatAt: now(), window: !!process.stdout.isTTY, open, prints: !intoFile, version: api.version || null }, null, 2));
    } catch {
      // the record only helps START.cmd find this dashboard
    }
  };
  beat();
  fs.rmSync(openRequest(api.stateDir), { force: true });
  // Each time a new one-time code, for the browser it opens and the link it prints alike: once the browser used it, the
  // printed link is no good to anyone
  const showPage = (again) => {
    const url = link();
    const opened = open && openUrl(url);
    const printed = intoFile ? '' : url;
    if (opened) say(again ? 'Opened the dashboard in your browser again.' : `Opened it in your browser.${printed ? ` If nothing opened, open this link in Edge or Chrome within a minute (it works once): ${printed}` : ''}`);
    else if (printed) say(again ? `Asked to show the dashboard again. Its link, good once and for a minute: ${printed}` : `Open this link in your browser (Edge or Chrome) within a minute; it works once: ${printed}`);
    else say(again ? 'Asked to show the dashboard again, but it runs without a browser or a window here: stop it and start it again (START.cmd -> d).' : 'It runs without a browser or a window: start it with START.cmd -> d to open it.');
  };
  say(`nextlevel dashboard for ${api.name} at http://127.0.0.1:${actual}/`);
  showPage(false);
  say('Leave this window open while you use the dashboard; closing it (or Ctrl+C) stops it. Only this PC can reach it.');
  recheck();

  let n = 0;
  let stopNow = () => {};
  const timer = setInterval(() => {
    n++;
    if (fs.existsSync(stopRequest(api.stateDir))) {
      let to = '';
      try {
        to = String(JSON.parse(fs.readFileSync(stopRequest(api.stateDir), 'utf8')).to || '');
      } catch {
        // stops anyway
      }
      fs.rmSync(stopRequest(api.stateDir), { force: true });
      say(`nextlevel is updating${to ? ` to ${to}` : ''}: this dashboard stops, and opens again on the new version.`);
      const data = JSON.stringify({ to: to.slice(0, 80) });
      for (const c of clients) c.write(`event: update\ndata: ${data}\n\n`);
      setTimeout(() => stopNow(), 300);
    }
    if (fs.existsSync(openRequest(api.stateDir))) {
      fs.rmSync(openRequest(api.stateDir), { force: true });
      showPage(true);
    }
    if (clients.size) pushBuild();
    if (n % 20 === 0) for (const c of clients) c.write(': still here\n\n');
    if (n % 6 === 0) beat();
  }, TICK_MS);

  await new Promise((resolve) => {
    const stop = () => {
      clearInterval(timer);
      if (readJson(record)?.pid === process.pid) fs.rmSync(record, { force: true });
      for (const c of clients) c.end();
      server.closeAllConnections?.();
      server.close(() => resolve());
      setTimeout(resolve, 2000).unref();
    };
    stopNow = stop;
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']) process.once(sig, stop);
  });
  say('Dashboard stopped.');
}
