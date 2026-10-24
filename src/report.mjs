// nextlevel report: a field report about nextlevel on this PC, filed as an issue in nextlevel's own
// repository (the fix loop, M5: report -> issue -> Claude Code -> pull request -> CI -> merge -> update ->
// the check runs again).
//   nextlevel report                    every check that fails (errors and warnings)
//   nextlevel report <check-id>         that check; the others are listed too
//                                       Both offer the doctor's automatic fixes for those checks first (each
//                                       asked, as the menu's doctor asks); the report is about what's left.
//   nextlevel report ... --json         build it and keep it, print it as JSON, file nothing (the dashboard
//                                       shows it to the owner first)
// A report is filed only in two places, both the owner's (FR-017): `nextlevel report` in their own window, after their
// yes (never in an agent's session, lib/session.mjs), and the dashboard's File it, which files the text its page showed
// in the dashboard's own process (fileShownReport), on a request with the dashboard's key. No command files a kept
// report: `report --send`, which did, refuses and says so.
//
// The owner sees the report exactly as it will be sent, and it is filed only after they say yes. It holds
// nextlevel's own facts only: results of nextlevel's checks (never a project's own checks), versions, the
// OS, paths (the home folder as ~) and the last hub log lines; never project code, briefs or .env values.
// Everything in it goes through redactReport: every .env value, token shapes, keys, logins in URLs.
// Reports are kept in ~/.nextlevel/reports/ (<id>.json, and <id>.md: the text that is sent).
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { toolGithubRepo } from './checks/engines.mjs';
import { CHECKS, byId, runChecks } from './checks/index.mjs';
import { firstLine, windowLabel } from './checks/lib.mjs';
import { makeUi } from './doctor.mjs';
import { makeAsker } from './lib/ask.mjs';
import { commandArgs } from './lib/commands.mjs';
import { describeProfile, profilesInUse } from './lib/config.mjs';
import { homeDir, userState } from './lib/home.mjs';
import { REPO_SLUG, SLUG_RE } from './lib/install.mjs';
import { runQuietAsync } from './lib/proc.mjs';
import { TOOL_ROOT } from './lib/project.mjs';
import { SANDBOX_NAME } from './lib/sandbox.mjs';
import { agentSession, ownerOnly } from './lib/session.mjs';
import { describeTool } from './lib/update.mjs';
import { redactReport, reportSecrets } from './lib/redact.mjs';

export const REPORT_LABEL = 'field-report';
const LOG_LINES = 40;
const MAX_BODY = 60_000; // GitHub takes 65 536 characters
const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };

export const reportsDir = () => path.join(homeDir(), 'reports');
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
const hashOf = (title, body) => createHash('sha256').update(`${title}\n\n${body}`).digest('hex').slice(0, 16);
const realPath = (p) => {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return p;
  }
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

// The repository reports go to and fixes are made in: the one this PC's reports were kept going to when the install
// moved to another repository (state.json "reports", lib/install.mjs keepWhatMoved), else the tool clone's own GitHub
// remote, else nextlevel's.
export const reportsRepo = () => {
  const r = userState().get('reports')?.repo;
  return typeof r === 'string' && SLUG_RE.test(r) ? r : '';
};
export function toolRepo(ctx) {
  return reportsRepo() || toolGithubRepo(ctx) || REPO_SLUG;
}
// 'public', 'private' or 'internal' from GitHub, or '' when gh can't say: a report says when its issue is public
export async function repoVisibility(repo, { gh = (args) => runQuietAsync('gh', args, { timeoutMs: 30_000 }) } = {}) {
  try {
    const r = await gh(['api', `repos/${repo}`]);
    const v = r.ok ? String(JSON.parse(r.out)?.visibility || '').toLowerCase() : '';
    return ['public', 'private', 'internal'].includes(v) ? v : '';
  } catch {
    return '';
  }
}

// ---------- redaction: lib/redact.mjs (phone messages are redacted the same way, FR-017) ----------
const stars = (s) => (String(s).match(/\*\*\*/g) || []).length;

export { redactReport, reportSecrets };

// ---------- the facts ----------
const cell = (s) => String(s ?? '').replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const fence = (s) => String(s ?? '').replace(/```/g, "'''");
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// Each line redacted before it is cut to 300 characters: a secret cut in half would no longer be found.
function hubLog(ctx, secrets, n = LOG_LINES) {
  const file = ctx.stateDir && ctx.path.join(ctx.stateDir, 'logs', 'hub.log');
  const text = file && ctx.read(file);
  if (!text) return null;
  const lines = text.replace(ANSI_RE, '').split(/\r?\n/).filter((l) => l.trim());
  const cut = (l) => (l.length > 300 ? `${l.slice(0, 300)}…` : l);
  return { file: ctx.path.join(ctx.path.basename(ctx.stateDir), 'logs', 'hub.log'), lines: redactReport(lines.slice(-n).join('\n'), secrets).split('\n').map(cut) };
}

function toolVersion(ctx) {
  let version = '?';
  try {
    version = JSON.parse(ctx.read(ctx.path.join(ctx.toolRoot, 'package.json')) || '{}').version || '?';
  } catch {
    // an install without package.json is reported as ?
  }
  const where = ctx.toolRoot === TOOL_ROOT ? describeTool() : '';
  return `${version}${where ? ` (${where})` : ''}`;
}
function osText(platform) {
  if (platform === 'win32') return `${os.version()} (${os.release()}, ${os.arch()})`;
  return `${OS_NAME[platform] || platform} ${os.release()} (${os.arch()})`;
}

const MARK = { ok: 'ok', skip: '--', error: '**!!**', warn: '!!', info: 'i' };
const mark = (r) => (r.status === 'fail' ? MARK[r.severity] : MARK[r.status]);
function stepText(s, platform) {
  const where = `${windowLabel(s.window, platform)}${s.cwd ? `, in ${s.cwd}` : ''}`;
  return `${where}: ${[s.command && `\`${s.command}\``, s.text].filter(Boolean).join(' (')}${s.command && s.text ? ')' : ''}`;
}

// What fails, as the report is about it: the check named, else every error and warning of nextlevel's
// own checks. { targets } or { message } saying why there is nothing to report.
export function pickTargets(results, checkId) {
  const ours = results.filter((r) => !r.source); // runChecks here gets nextlevel's own checks only; to be sure
  if (checkId) {
    const r = results.find((x) => x.id === checkId);
    if (!r) {
      return {
        message: `nextlevel has no check "${checkId}" (nextlevel doctor --json lists them: the "id" of each result). A check of the project's own (.nextlevel/checks/) is about the project, so it is never reported.`,
      };
    }
    if (r.status === 'ok') return { message: `"${r.title}" (${r.id}) passes now: there is nothing to report.` };
    if (r.status === 'skip') return { message: `"${r.title}" (${r.id}) was not checked: ${r.detail}. Report the check it waits for instead.` };
    return { targets: [r] };
  }
  const targets = ours.filter((r) => r.status === 'fail' && r.severity !== 'info');
  if (!targets.length) {
    return { message: 'No check fails, so there is nothing to report. For a problem the checks miss, open an issue on nextlevel\'s GitHub page and say what happened (no secrets).' };
  }
  return { targets };
}

// The report's title and text, redacted, from the checks' results and what this PC is. `tried`: what came of
// the automatic fixes offered just before ({ id: 'ran' | 'declined' }, from offerFixes).
export function buildReport(ctx, results, { checkId = null, repo = toolRepo(ctx), tried = {} } = {}) {
  const picked = pickTargets(results, checkId);
  if (!picked.targets) return { ok: false, message: picked.message };
  const { targets } = picked;
  const platform = ctx.platform;
  const osName = OS_NAME[platform] || platform;
  const ids = targets.map((t) => t.id);
  const title =
    targets.length === 1
      ? `Field report: ${targets[0].title} (${targets[0].id}) on ${osName}`
      : `Field report: ${targets.length} checks fail on ${osName} (${ids.slice(0, 3).join(', ')}${ids.length > 3 ? ', ...' : ''})`;
  const byId = new Map(results.map((r) => [r.id, r]));
  const version = toolVersion(ctx);
  const out = [`<!-- nextlevel-report v1 checks=${ids.join(',')} os=${platform} nextlevel=${version.split(' ')[0]} -->`, ''];
  // Only what nextlevel knows: whether the owner tried a check's steps, it can't tell
  out.push(targets.length === 1 ? 'A nextlevel check fails on this PC.' : 'These nextlevel checks fail on this PC.', '');
  for (const t of targets) {
    out.push(`### \`${t.id}\` · ${t.title} (${t.severity})`, '', `**Found:** ${t.detail}`);
    if (t.next) out.push(`**Next, it says:** ${t.next}`);
    const auto =
      tried[t.id] === 'ran'
        ? 'it ran just before this report, and the check still fails'
        : tried[t.id] === 'declined'
          ? 'offered just before this report; the owner did not run it'
          : t.fixable
            ? `\`nextlevel doctor --fix ${t.id}\` (not run for this report)`
            : '';
    if (auto) out.push(`**Automatic fix:** ${auto}`);
    if (t.message) out.push('', '```', fence(t.message), '```');
    else if (t.steps.length) out.push('', '**Steps it gives:**', ...t.steps.map((s) => `- ${stepText(s, platform)}`));
    out.push('');
  }
  const row = (label, id) => {
    const r = byId.get(id);
    return `| ${label} | ${cell(!r ? 'not checked' : r.status === 'skip' ? `not checked: ${r.detail}` : r.detail)} |`;
  };
  out.push(
    '### This PC',
    '',
    '| | |',
    '|---|---|',
    `| nextlevel | ${cell(version)} |`,
    `| Node.js | ${cell(ctx.nodeVersion)} |`,
    `| OS | ${cell(osText(platform))} |`,
    row('Git', 'tool.git'),
    row('GitHub CLI', 'tool.gh'),
    row('Codex CLI', 'tool.codex'),
    row('Antigravity CLI', 'tool.agy'),
    row('Claude Code', 'tool.claude'),
    row('Docker', 'tool.docker'),
    `| Roles | ${cell(profilesInUse(ctx.config).map((p) => `${p.role}${p.fallback ? ' fallback' : ''}: ${describeProfile(p)}`).join(', '))} |`,
    '',
    '### Paths',
    '',
    `- nextlevel: \`${ctx.toolRoot}\``,
    `- project: ${ctx.root ? `\`${ctx.root}\`` : `none (${firstLine(ctx.problem) || 'not in a project'})`}`,
    ...(ctx.stateDir ? [`- state folder: \`${ctx.path.basename(ctx.stateDir)}\``] : []),
    `- this window: \`${ctx.cwd}\``,
    '',
  );
  const shown = results.filter((r) => !r.source && !r.quiet);
  const failed = shown.filter((r) => r.status === 'fail');
  const count = (sev) => failed.filter((r) => r.severity === sev).length;
  out.push(
    '### Every check',
    '',
    `<details><summary>${shown.length} checks: ${count('error')} to fix, ${count('warn')} warnings, ${count('info')} notes</summary>`,
    '',
    '| | Check | Result |',
    '|---|---|---|',
    ...shown.map((r) => `| ${mark(r)} | \`${r.id}\` | ${cell(r.detail)}${r.status === 'fail' && r.next ? ` → ${cell(r.next)}` : ''} |`),
    '',
    '</details>',
    '',
  );
  const own = results.filter((r) => r.source).length;
  if (own) out.push(`(${own} check(s) of the project's own are left out: they are about the project, not nextlevel.)`, '');
  const secrets = { ...reportSecrets(ctx), home: [ctx.home, realPath(ctx.home)], platform }; // C:\Users\RUNNER~1 is C:\Users\runneradmin too
  const log = hubLog(ctx, secrets);
  out.push('### Recent hub log', '');
  if (log) out.push(`<details><summary>the last ${log.lines.length} lines of ${log.file}</summary>`, '', '```', ...log.lines.map(fence), '```', '', '</details>', '');
  else out.push(ctx.root ? "(no hub log yet: the hub hasn't run in this project)" : '(not in a project)', '');
  const footer = [
    '---',
    "Filed with `nextlevel report`, after the owner read this text. It holds nextlevel's own facts only: its check results, versions, the OS, paths and the last hub log lines. No project code, brief or `.env` values; secrets are replaced with `***`.",
    'To have it fixed: `nextlevel fix <this issue\'s number>` on that PC starts a Claude Code session on it.',
  ].join('\n');
  let main = redactReport(out.join('\n'), secrets);
  if (main.length > MAX_BODY) main = `${main.slice(0, MAX_BODY)}\n\n(cut off: too long for an issue)\n`;
  const end = redactReport(footer, secrets); // its words too: a .env value may be one of them
  const body = `${main}${end}`;
  const safeTitle = redactReport(title, secrets).replace(/[^\w .,:;()/'#+=@-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
  return { ok: true, title: safeTitle, body, checks: ids, repo, replaced: stars(main) + stars(end) - stars(footer) };
}

// ---------- kept reports ----------
export function saveReport(r) {
  fs.mkdirSync(reportsDir(), { recursive: true });
  fs.writeFileSync(path.join(reportsDir(), `${r.id}.md`), r.body);
  fs.writeFileSync(path.join(reportsDir(), `${r.id}.json`), JSON.stringify(r, null, 2));
  return r;
}
export const loadReport = (id) => (/^[\w.-]{1,100}$/.test(String(id)) ? readJson(path.join(reportsDir(), `${id}.json`)) : null);
export function listReports() {
  let names = [];
  try {
    names = fs.readdirSync(reportsDir()).filter((f) => f.endsWith('.json')).sort();
  } catch {
    // none yet
  }
  return names.map((f) => readJson(path.join(reportsDir(), f))).filter(Boolean);
}
// A report of the same check filed earlier from this PC, the newest: { number, url, at } or null.
const earlierFiled = (checks) => listReports().filter((r) => r.filed && r.checks?.join(',') === checks.join(',')).map((r) => r.filed).at(-1) || null;

// File a kept report as an issue, exactly its title and text: gh issue create with the field-report label
// (made if the repository doesn't have it; left off if gh may not make it). { ok, number, url, note } or
// { ok: false, message }. gh runs without holding the process (the dashboard's page stays live meanwhile).
export async function fileReport(r, { gh = (args) => runQuietAsync('gh', args, { timeoutMs: 60_000 }) } = {}) {
  if (r.filed) return { ok: true, ...r.filed, already: true };
  const file = path.join(reportsDir(), `${r.id}.md`);
  // What gh sends is that file: it must be the text the owner was shown (cmdReport shows an edited one again)
  if (readText(file) !== r.body) return { ok: false, message: `${file} isn't the text you were shown` };
  const base = ['issue', 'create', '--repo', r.repo, '--title', r.title, '--body-file', file];
  let res = await gh([...base, '--label', REPORT_LABEL]);
  let note = '';
  if (!res.ok && /label/i.test(res.out)) {
    const made = await gh(['label', 'create', REPORT_LABEL, '--repo', r.repo, '--color', 'D93F0B', '--description', 'Filed by nextlevel report from a PC']);
    if (made.ok) res = await gh([...base, '--label', REPORT_LABEL]);
    if (!res.ok) {
      res = await gh(base);
      note = ` (without the ${REPORT_LABEL} label, which gh could not add: ${firstLine(made.out) || 'no permission'})`;
    }
  }
  if (!res.ok) {
    const text = res.out || '';
    if (res.missing) return { ok: false, message: 'the GitHub CLI (gh) is not installed: nextlevel doctor shows how to install it' };
    if (/not logged in|auth login|401|Bad credentials/i.test(text)) return { ok: false, message: 'gh is not signed in: in PowerShell, gh auth login, then try again' };
    return { ok: false, message: `gh issue create failed: ${firstLine(text) || `exit ${res.code}`}` };
  }
  const url = (res.out.match(/https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/issues\/\d+/) || [])[0];
  if (!url) return { ok: false, message: `gh printed no issue link: ${firstLine(res.out)}` };
  r.filed = { number: Number(url.split('/').pop()), url, at: new Date().toISOString() };
  saveReport(r);
  return { ok: true, ...r.filed, note };
}

// The dashboard's File it: the kept report `id`, exactly the text its page showed the owner (`hash`), filed. It runs in
// the dashboard's own process on the owner's request (POST /api/report/send, with the dashboard's key), never from a
// command (FR-017). A text changed since it was shown, here or in its file, isn't filed.
// -> { ok: true, id, issue: { number, url }, already, note } or { ok: false, message }
export async function fileShownReport(id, hash) {
  const r = loadReport(id);
  if (!r) return { ok: false, message: `There is no kept report "${id}" (they are in ${reportsDir()}).` };
  if (String(hash) !== r.hash) return { ok: false, message: 'That report is not the text you were shown: it changed since. Build it again.' };
  const file = path.join(reportsDir(), `${r.id}.md`);
  const onDisk = readText(file);
  if (!r.filed && onDisk !== null && onDisk !== r.body) return { ok: false, message: `${file} was changed after the report was shown, so it isn't filed from here. Build it again (Report and fix); to leave something out, run nextlevel report in your own window and edit its file before you answer.` };
  const f = await fileReport(r);
  if (!f.ok) return { ok: false, message: `Not filed: ${f.message}. The report stays in ${file}.` };
  return { ok: true, id: r.id, issue: { number: f.number, url: f.url }, already: !!f.already, note: f.note || '' };
}

// ---------- the command ----------
// The doctor's automatic fixes for the checks the report would be about, offered first, each asked as the
// menu's doctor asks: a report is for what they don't fix. Returns the results to report from (checked
// again after a fix ran) and { id: 'ran' | 'declined' } for each fix offered.
async function offerFixes(ctx, results, checkId, asker) {
  const fixable = (pickTargets(results, checkId).targets || []).filter((r) => r.fixable);
  if (!fixable.length) return { results, tried: {} };
  const names = fixable.map((r) => `"${r.title}"`).join(', ');
  console.log(
    fixable.length === 1
      ? `${names} has an automatic fix (the doctor's): try it first, and the report is only about what it doesn't fix.`
      : `${names} have automatic fixes (the doctor's): try them first, and the report is only about what they don't fix.`,
  );
  const after = await runChecks(ctx, { checks: fixable.map((r) => byId(r.id)), fix: true, safeFixes: false, ui: makeUi(asker) });
  const tried = Object.fromEntries(after.filter((r) => 'fixed' in r || r.status === 'fail').map((r) => [r.id, 'fixed' in r ? 'ran' : 'declined']));
  for (const r of after.filter((x) => x.fixed)) console.log(`Fixed: ${r.title}.`);
  if (!after.some((r) => 'fixed' in r)) return { results, tried };
  console.log('Checking everything again...\n');
  return { results: await runChecks(ctx, { checks: CHECKS }), tried };
}

function printReport(r) {
  const rule = (label) => console.log(`---------------- ${label} ${'-'.repeat(Math.max(4, 60 - label.length))}`);
  rule('title');
  console.log(r.title);
  rule('text');
  console.log(r.body);
  rule('end');
}


// `run`: { ctx (checks/context.mjs), startFix(number, { asker }) -> exit code }. Returns the exit code.
export async function cmdReport(argv, { ctx, startFix = null }) {
  const a = commandArgs('report', argv);
  const print = (v) => console.log(JSON.stringify(v, null, 2));
  const stop = (message, code = 1) => {
    if (a.json) print({ ok: false, message });
    else console.log(message);
    return code;
  };
  // A kept report is filed only by the dashboard's File it, in its own process, or after the owner's yes in their own
  // window: never by a command that names one (FR-017)
  if (a.send !== undefined || a.hash !== undefined) {
    return stop(
      "Nothing was filed: nextlevel report --send doesn't file from the command line any more. A report is filed from the dashboard (Setup: Report and fix, then File it, under the text it shows you), " +
        'or by nextlevel report in your own PowerShell window, which shows it and asks you.',
    );
  }
  if (ctx.sandbox) return stop(`nextlevel report can't run inside ${SANDBOX_NAME}: it files an issue with your GitHub sign-in, which the sandbox hides. Owner: run it in a normal PowerShell window.`);
  // Filing is the owner's: in an agent's session only --json, which builds a report and files nothing (FR-017)
  const session = agentSession();
  if (session && !a.json) return stop(ownerOnly('nextlevel report (it files an issue on GitHub with your sign-in when you answer yes)', 'The owner runs it in their own PowerShell window, or uses the dashboard (Setup: Report and fix). nextlevel report --json builds one to look at and files nothing.', session));

  const checkId = a._[0] || null;
  const again = `nextlevel report${checkId ? ` ${checkId}` : ''}`;
  let results = await runChecks(ctx, { checks: CHECKS });
  // The dashboard's way (--json) builds it as the checks are: the page offers a check's Fix button first
  const asker = a.json ? null : makeAsker({ onNoAnswer: '(no answer: not filed)' });
  try {
    let tried = {};
    if (asker) ({ results, tried } = await offerFixes(ctx, results, checkId, asker));
    const built = buildReport(ctx, results, { checkId, tried });
    // nothing left to report: fixed just now is a success, a check that passes anyway isn't what was asked
    if (!built.ok) return stop(built.message, checkId && tried[checkId] !== 'ran' ? 1 : 0);
    const id = `${stamp()}-${(checkId || 'checks').replace(/[^\w.-]+/g, '-')}`;
    const r = saveReport({ id, createdAt: new Date().toISOString(), repo: built.repo, labels: [REPORT_LABEL], title: built.title, body: built.body, hash: hashOf(built.title, built.body), checks: built.checks, project: ctx.root, replaced: built.replaced, filed: null });
    const earlier = earlierFiled(r.checks);
    const visibility = await repoVisibility(r.repo);
    if (a.json) {
      print({ ok: true, id: r.id, repo: r.repo, visibility, label: REPORT_LABEL, title: r.title, body: r.body, hash: r.hash, checks: r.checks, replaced: r.replaced, file: path.join(reportsDir(), `${r.id}.md`), earlier });
      return 0;
    }

    console.log(`This is the report, exactly as it would go to GitHub: a new ${visibility === 'public' ? 'PUBLIC ' : ''}issue in ${r.repo}, labelled ${REPORT_LABEL}.${visibility === 'public' ? ' Anyone can read it.' : ''}\n`);
    printReport(r);
    console.log(
      `It has nextlevel's own facts only (check results, versions, the OS, paths, the last hub log lines): no project code, brief or .env values. Secrets are replaced with ***${r.replaced > 0 ? ` (${r.replaced} here)` : ''}.`,
    );
    const file = path.join(reportsDir(), `${r.id}.md`);
    console.log(`It is kept in ${file}. To leave something out, edit it there before you answer: what the file holds then is shown again, and you are asked again.`);
    if (earlier) console.log(`You filed a report for the same check on ${String(earlier.at).slice(0, 10)}: ${earlier.url}`);
    for (let question = `File it on GitHub (${r.repo})?`; ; question = `File your version on GitHub (${r.repo})?`) {
      if (!(await asker.yes(question))) {
        console.log(`Not filed. To file one later: ${again} (in your own window), or the dashboard (Setup: Report and fix).`);
        return 0;
      }
      const onDisk = readText(file);
      if (onDisk === null || onDisk === r.body) break;
      // The owner edited the kept text (to leave something out): shown again, redacted again, and asked again
      const body = redactReport(onDisk.replace(/\r\n/g, '\n'), { ...reportSecrets(ctx), home: [ctx.home, realPath(ctx.home)], platform: ctx.platform });
      saveReport(Object.assign(r, { body, hash: hashOf(r.title, body), edited: true }));
      console.log(`You changed ${file}. This is what would be filed now:\n`);
      printReport(r);
    }
    const f = await fileReport(r);
    if (!f.ok) {
      console.log(`Not filed: ${f.message}. To try again: ${again} (in your own window; it builds the report again), or the dashboard (Setup: Report and fix).`);
      return 1;
    }
    console.log(`Filed: #${f.number} ${f.url}${f.note || ''}`);
    if (startFix && (await asker.yes(`Start a Claude Code session that fixes it (nextlevel fix ${f.number})?`, { noAnswer: '(no answer: not now)' }))) {
      return startFix(f.number, { asker });
    }
    console.log(`To have it fixed later: nextlevel fix ${f.number}`);
    return 0;
  } finally {
    asker?.close();
  }
}
