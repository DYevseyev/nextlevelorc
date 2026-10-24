// nextlevel ask: the owner's side chat, a read-only project assistant, apart from the orchestrator.
//   nextlevel ask "question" [--thread <id>] [--json]   a new thread, or a follow-up in one
//   nextlevel ask threads [--search "text"] [--json]     the threads, newest first
//   nextlevel ask show <id> [--json]                     one thread
//   nextlevel ask new ["title"] | rename <id> "title" | clear <id> | delete <id>   [--json]
// The dashboard's Ask panel runs the same commands.
//
// Each question is a fresh session of its own on the `assistant` role (nextlevel.json; automatic: a light model on
// the first engine that can be run read-only which a role already uses), never the orchestrator's: it adds nothing
// to the orchestrator's context or rounds. It is read-only by construction: Codex in its read-only sandbox, Claude
// Code in plan mode with the tools that write or read .env denied (engines/*.mjs readOnly). On Antigravity, which nothing of
// its own keeps read-only, it answers in a throwaway copy of the project, as nextlevel's agent, with the push block, only
// after its lock test passed, and a tripwire on the real project (lib/askcopy.mjs, docs/design/antigravity-roles.md part
// B); the question goes to it in a file in the copy, since agy's stdin is its console. Its engine gets NEXTLEVEL_READ_ONLY=1, so the nextlevel commands it may run
// only look (lib/readonly.mjs), and none of the project's .env values. The question goes to it on stdin, never
// through cmd.exe. It starts from a compact briefing (docs/PROJECT.md, the status file, open handoff items and
// notes, the hub's status, the last day's jobs, recent commits, the thread so far), redacted like a report, and may
// open the project's files, task specs, reports and logs. Its answer names the files, jobs or commits it used
// ("Sources: ...") and may suggest a note ("Note: ..."), which the owner edits and sends through the Notes cards:
// nothing reaches the orchestrator unless the owner sends it. Its tokens and minutes count in Today as "assistant".
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ADDON_KINDS, engine, engineTitle, profileEnv, workerIsolation } from './engines/index.mjs';
import { jsonLine } from './engines/util.mjs';
import { notReadOnly, roleProfile } from './lib/config.mjs';
import { chatStore, CHAT_ID_RE, LIMITS, titleOf } from './lib/chats.mjs';
import { commandArgs } from './lib/commands.mjs';
import { noteGroups } from './lib/cards.mjs';
import { resolveBin, runQuiet, spawnBin } from './lib/proc.mjs';
import { redactReport } from './report.mjs';
import { agyFailure, agyResult } from './engines/agy.mjs';
import { QUESTION_FILE, agyAssistantRun, makeAskCopy, projectChanges, projectRelative, projectSnapshot, removeAskCopy } from './lib/askcopy.mjs';

const SUBCOMMANDS = new Set(['threads', 'show', 'new', 'rename', 'clear', 'delete']);
const TIMEOUT_MIN = 10;
const cut = (s, n) => {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const readText = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return '';
  }
};


// ---------- the briefing ----------
// A section of the briefing: its heading and text, cut to `max` characters (the end kept for a log, else the start)
const section = (title, text, max = 6000) => {
  const t = String(text || '').trim();
  return t ? `## ${title}\n${t.length > max ? `${t.slice(0, max)}\n[... cut: ${t.length - max} more characters]` : t}\n` : '';
};

// Everything the assistant starts from, as one text, before redaction. `ctx` is the hub's (askContext in hub.mjs).
export function briefing(ctx, { thread, question, now = Date.now() }) {
  const { config, root } = ctx;
  const parts = [];
  parts.push(
    'ROLE: ASSISTANT. You answer the owner\'s questions about this project. You are not the orchestrator and you ' +
      'change nothing: you are read-only. Never edit, create or delete files, never run a command that changes ' +
      'anything (no git writes, no nextlevel commands but these: nextlevel status [--json], nextlevel result ' +
      '<job-id> --peek, nextlevel team, nextlevel doctor --json; git status, log, diff and show). Never open .env or ' +
      'any file outside this project. You may open the project\'s files, the task specs (' +
      `${config.paths.tasks}/<id>.md), and a job's report and logs (.nextlevel/jobs/<id>/RESULT.md, worker.log, ` +
      'verify.log). Answer plainly and briefly, in your reply itself: there is nothing to plan and nothing to ' +
      'approve (no plan, no request to leave plan mode). Name a file by its path from the project\'s top folder ' +
      '(docs/PLAN.md), never a full path or a file:/// link. End with a line "Sources: ..." naming the files, jobs or commits ' +
      'you used. If the owner seems to want the team to do something, suggest a note they could send the ' +
      'orchestrator on a line of its own: "Note: <one instruction>" (or "Rule: <...>" for a standing rule). You ' +
      "can't send it: only the owner can.\n",
  );
  const projectDoc = config.paths.project || 'docs/PROJECT.md'; // (paths.project, M11)
  parts.push(section(`The project (${projectDoc})`, readText(path.join(root, projectDoc))));
  parts.push(section(`Status (${config.paths.status})`, readText(path.join(root, config.paths.status))));
  try {
    const store = ctx.cards();
    const open = store.handoff.list().filter((x) => x.status === 'open');
    parts.push(section('What the team needs from the owner (open handoff items)', open.map((x) => `- ${x.id}: ${x.what}${x.where ? ` (where: ${x.where})` : ''}${x.why ? ` (why: ${x.why})` : ''}${x.task ? ` [task ${x.task}]` : ''}`).join('\n'), 4000));
    const g = noteGroups(store.notes.list());
    const notes = [...g.rules.filter((n) => !n.off).map((n) => `- ${n.id} (standing rule): ${n.text}`), ...g.open.map((n) => `- ${n.id} (${n.status === 'seen' ? 'seen, not done yet' : 'new'}): ${n.text}`)];
    parts.push(section("The owner's notes to the orchestrator (open ones and standing rules)", notes.join('\n'), 4000));
  } catch {
    // the cards can't be read: the rest still helps
  }
  const st = ctx.status();
  parts.push(section('The hub (nextlevel status)', JSON.stringify({ hub: st.hub, autopilot: st.autopilot, autopilotPaused: st.autopilotPaused, orchestrator: st.orchestrator, milestones: st.milestones, current: st.current, waitingOnOwner: st.waitingOnOwner, lastActivity: st.lastActivity }, null, 1), 2000));
  const day = now - 24 * 3_600_000;
  const recent = ctx.jobs().filter((j) => Date.parse(j.finishedAt || j.updatedAt || j.createdAt || 0) >= day || ['queued', 'running', 'verifying'].includes(j.state));
  parts.push(
    section(
      'Jobs in the last day (newest last)',
      recent
        .slice(-40)
        .map((j) => `- ${j.id} · ${j.type}${j.kind ? `/${j.kind}` : ''} · ${j.state}${j.attempt > 1 ? ` · attempt ${j.attempt}` : ''}${j.engine ? ` · ${j.engine}` : ''}${j.engineWhy?.text ? ` (why: ${j.engineWhy.text})` : ''}${j.mark ? ` · finished without a report, ${j.mark}` : ''}${j.claimed === 'MISSING' && j.missing ? ` · no report: ${j.missing}` : j.claimed ? ` · worker says ${j.claimed}` : ''}${j.verify ? ` · verify ${j.verify}` : ''}${j.ownCommits !== null && j.ownCommits !== undefined ? ` · ${j.ownCommits} commit(s) this attempt, ${j.commits} in all` : ''}${j.detail ? ` · ${j.detail}` : ''}${j.error ? ` · error: ${j.error}` : ''}${j.finishedAt ? ` · finished ${j.finishedAt}` : ''}`)
        .join('\n'),
      8000,
    ),
  );
  parts.push(section(`Recent commits on ${config.baseBranch}`, ctx.commits(), 2500));
  const history = (thread?.messages || []).slice(-8).map((m) => `${m.role === 'owner' ? 'Owner' : 'You'}: ${cut(m.text, 2000)}`).join('\n\n');
  parts.push(section('This conversation so far', history, 12000));
  parts.push(`## The owner's question\n${cut(question, LIMITS.question)}\n`);
  return parts.filter(Boolean).join('\n');
}

// ---------- the answer ----------
// What the engine said, from what it printed: Claude Code's stream-json result, Codex's last agent message, else
// its plain text. { text, error }
export function answerOf(engineName, out) {
  const lines = String(out || '').split(/\r?\n/);
  let text = '';
  let error = '';
  for (const line of lines) {
    const v = jsonLine(line);
    if (!v) continue;
    if (engineName === 'claude' && v.type === 'result') {
      text = typeof v.result === 'string' ? v.result : text;
      if (v.is_error) error = text || 'Claude Code ended with an error';
    }
    if (engineName === 'codex') {
      if (v.type === 'item.completed' && v.item?.type === 'agent_message' && v.item.text) text = v.item.text;
      if (v.type === 'turn.failed') error = v.error?.message || 'Codex ended with an error';
      if (v.type === 'error' && v.message) error = v.message;
    }
  }
  if (!text) text = lines.filter((l) => !jsonLine(l)).join('\n').trim();
  return { text: text.trim(), error };
}
// The files, jobs or commits it named ("Sources: a, b"), and the note it suggested ("Note: ..." once, "Rule: ..."
// a standing rule), from its answer.
export function sourcesOf(text) {
  const line = String(text || '').split(/\r?\n/).reverse().find((l) => /^\W{0,4}sources?\W{0,4}:/i.test(l.trim()));
  if (!line) return [];
  // (a Markdown link is its text: Antigravity links each file, to where it read it, its throwaway copy)
  return line.replace(/^[^:]*:/, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').split(/[,;]| and /).map((s) => s.replace(/[`*]/g, '').trim()).filter((s) => s && s !== `${QUESTION_FILE.join('/')}`).slice(0, 20);
}
export function noteOf(text) {
  for (const l of String(text || '').split(/\r?\n/)) {
    const m = l.trim().match(/^\W{0,4}(note|rule)\W{0,4}:\s*(.+)$/i);
    if (m) return { type: m[1].toLowerCase() === 'rule' ? 'rule' : 'once', text: m[2].replace(/[`*]+/g, '').trim() };
  }
  return null;
}

// The assistant's profile, its model made concrete: an automatic Codex takes the smallest model its list offers
// (one whose name says mini, nano, small or lite), else Codex's own at low effort.
export function assistantProfile(config, { run = runQuiet, env = process.env, home = os.homedir() } = {}) {
  const p = roleProfile(config, 'assistant');
  if (!p) throw new Error('nextlevel.json has no assistant role');
  const why = notReadOnly(p.engine);
  // (Antigravity: in a copy of the project made for the question, askAgy)
  if (p.engine !== 'agy' && (why || !engine(p.engine).readOnly)) throw new Error(`The assistant can't run on ${engineTitle(p.engine)}: ${why || 'it has no read-only mode'}. Choose Codex or Claude Code for it (Team page, or nextlevel team set assistant --engine codex).`);
  if (p.auto && p.engine === 'codex' && !p.model) {
    const r = engine('codex').models((cmd, args, opts = {}) => run(cmd, args, { ...opts, env: profileEnv(env, p, { home }) }));
    const light = (r?.list || []).filter((m) => /\b(mini|nano|small|lite)\b|-(mini|nano|small|lite)/i.test(m.id)).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))[0];
    if (light) return { ...p, model: light.id };
  }
  return p;
}

// ---------- the command ----------
// `ctx` (hub.mjs askContext): root, stateDir, config, status(), jobs(), cards(), commits(), secrets(), env(),
// addUsage(engine, { runs, minutes, tokens }), home. Returns the exit code.
export async function cmdAsk(argv, ctx) {
  const a = commandArgs('ask', argv);
  const store = chatStore(path.join(ctx.stateDir, 'chats'));
  const secrets = ctx.secrets();
  const clean = (s) => redactReport(String(s ?? ''), { values: secrets.values, names: secrets.names });
  const print = (json, text) => console.log(a.json ? JSON.stringify(json, null, 2) : text);
  const fail = (message, extra = {}) => {
    print({ ok: false, message, ...extra }, message);
    return 1;
  };
  const [sub, ...rest] = a._;
  try {
    if (SUBCOMMANDS.has(sub) && !a.thread) {
      if (sub === 'threads') {
        const list = store.list({ search: a.search || rest.join(' ') });
        print({ ok: true, threads: list }, list.length ? list.map((t) => `${t.id}  ${t.title}  (${t.count} message(s), ${t.updatedAt})${t.match ? `\n    ${t.match}` : ''}`).join('\n') : 'No threads yet: nextlevel ask "your question"');
        return 0;
      }
      if (sub === 'new') {
        const t = store.create(rest.join(' ') || 'New thread');
        print({ ok: true, thread: t }, `Started thread ${t.id}: ${t.title}`);
        return 0;
      }
      const id = rest[0];
      if (!CHAT_ID_RE.test(String(id || ''))) return fail(`which thread? nextlevel ask threads lists them`);
      if (sub === 'show') {
        const t = store.get(id);
        if (!t) return fail(`no thread "${id}"`);
        print({ ok: true, thread: t }, [`# ${t.title} (${t.id})`, ...t.messages.map((m) => `\n${m.role === 'owner' ? 'You' : `Assistant (${m.engine || '?'})`}: ${m.text}`)].join('\n'));
        return 0;
      }
      if (sub === 'rename') {
        const t = store.rename(id, rest.slice(1).join(' '));
        print({ ok: true, thread: t }, `Renamed: ${t.title}`);
        return 0;
      }
      if (sub === 'clear') {
        const t = store.clear(id);
        print({ ok: true, thread: t }, `Cleared ${t.title}: its messages are gone, the thread stays.`);
        return 0;
      }
      store.remove(id);
      print({ ok: true, deleted: id }, `Deleted thread ${id}.`);
      return 0;
    }
    const question = a._.join(' ').trim();
    if (!question) return fail('usage: nextlevel ask "your question" [--thread <id>] | ask threads | show | new | rename | clear | delete');
    if (question.length > LIMITS.question) return fail(`a question has at most ${LIMITS.question} characters`);
    let thread = a.thread ? store.get(a.thread) : null;
    if (a.thread && !thread) return fail(`no thread "${a.thread}": nextlevel ask threads lists them`);
    thread ||= store.create(titleOf(question));
    const prompt = clean(briefing(ctx, { thread, question }));
    thread = store.append(thread.id, { role: 'owner', text: question });
    const r = await askEngine(ctx, prompt);
    // (never a path into the copy it answered in, which is gone now, nor a full path into the project: a path from its top)
    // (the project's real name too, for every engine: a folder reached through a link or in another case)
    let real = '';
    try {
      real = fs.realpathSync.native(ctx.root);
    } catch {}
    const answer = clean(projectRelative(r.text, [...(r.copyDirs || []), ctx.root, real]));
    const message = { role: 'assistant', text: answer || clean(r.error) || '(no answer)', sources: sourcesOf(answer), note: noteOf(answer), engine: r.engine, model: r.model, effort: r.effort, tokens: r.tokens, minutes: r.minutes, ...(r.copySeconds !== undefined ? { copySeconds: r.copySeconds } : {}), ...(r.error ? { error: clean(r.error) } : {}) };
    thread = store.append(thread.id, message);
    const saved = thread.messages.at(-1);
    const who = `${engineTitle(r.engine || 'codex')}${r.model ? ` ${r.model}` : ''}`;
    print(
      { ok: !r.error, thread: { id: thread.id, title: thread.title }, question, answer: saved, ...(r.error ? { message: saved.error } : {}) },
      `${saved.text}\n\n(${r.error ? `The assistant (${who}) failed: ${saved.error}` : `Assistant: ${who}${r.tokens ? `, ${r.tokens.tokens.toLocaleString('en-US')} tokens` : ''}${r.copySeconds !== undefined ? `, in a copy of the project made in ${r.copySeconds} s` : ''}`} · thread ${thread.id}: nextlevel ask --thread ${thread.id} "a follow-up")`,
    );
    return r.error ? 1 : 0;
  } catch (err) {
    return fail(clean(err.message));
  }
}

// What an engine's adapter may read of the owner's own add-ons (its config files), as the hub gives a worker's
const addonFilesOf = (ctx) => ({
  home: ctx.home,
  env: ctx.env(),
  path,
  read: (f) => {
    try {
      return fs.readFileSync(f, 'utf8');
    } catch {
      return null;
    }
  },
  list: (d) => {
    try {
      return fs.readdirSync(d);
    } catch {
      return [];
    }
  },
});

// One read-only session: the prompt on stdin, what it prints read back. { text, error, engine, model, effort, tokens, minutes }
async function askEngine(ctx, prompt) {
  const startedAt = Date.now();
  let profile;
  try {
    profile = assistantProfile(ctx.config, { env: ctx.env(), home: ctx.home });
  } catch (err) {
    return { text: '', error: err.message, engine: '', model: '', effort: '', tokens: null, minutes: 0 };
  }
  const eng = engine(profile.engine);
  const base = { engine: profile.engine, model: profile.model || '', effort: profile.effort || '' };
  const bin = resolveBin(eng.command);
  if (!bin) return { ...base, text: '', error: `${eng.title} (${eng.command}) is not installed: the doctor says how to install it`, tokens: null, minutes: 0 };
  let env;
  try {
    env = profileEnv(ctx.env(), profile, { home: ctx.home });
  } catch (err) {
    return { ...base, text: '', error: err.message, tokens: null, minutes: 0 };
  }
  if (profile.engine === 'agy') return askAgy(ctx, profile, prompt, { base, env, startedAt });
  // Without the owner's own add-ons, as a worker that keeps none (workers.addons is the workers' alone): Codex starts every
  // MCP server in its config.toml otherwise, and one can write where it points, past the read-only sandbox (a site's admin
  // server writes a live site). Claude Code's readOnly has --strict-mcp-config already, and keeps its
  // `--setting-sources user` (the repository's settings stay out); agy answers as nextlevel-assistant (askAgy).
  const iso = profile.engine === 'codex' ? workerIsolation(profile, ADDON_KINDS, addonFilesOf(ctx)) : { args: [] };
  const args = eng.readOnly({ model: profile.model || '', effort: profile.effort || '', extra: iso.args });
  const out = await new Promise((resolve) => {
    let text = '';
    const child = spawnBin(bin, args, { cwd: ctx.root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const add = (d) => {
      text = (text + d).slice(-4 * 1024 * 1024);
    };
    child.stdout.setEncoding('utf8').on('data', add);
    child.stderr.setEncoding('utf8').on('data', add);
    child.stdin.on('error', () => {}); // it may end before it read everything
    child.stdin.end(prompt);
    const timer = setTimeout(() => {
      add(`\n(no answer in ${TIMEOUT_MIN} minutes: stopped)\n`);
      if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      else child.kill('SIGKILL');
    }, TIMEOUT_MIN * 60_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, text: `${text}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
  const minutes = (Date.now() - startedAt) / 60000;
  const tokens = eng.tokens(out.text);
  ctx.addUsage(profile.engine, { runs: 1, minutes, tokens });
  const got = answerOf(profile.engine, out.text);
  const error = got.error || (out.code !== 0 ? `${eng.title} stopped (exit ${out.code})${got.text ? '' : ': no answer'}` : '');
  return { ...base, text: got.text, error: out.code === 0 && got.text && !got.error ? '' : error || (got.text ? '' : 'no answer'), tokens, minutes: Math.round(minutes * 100) / 100 };
}

// ---------- the assistant on Antigravity (part B of docs/design/antigravity-roles.md) ----------
// One question: its lock test must have passed for what it runs (ctx.lockProblem, the hub's), then a copy of the project
// (lib/askcopy.mjs), the question in a file there, agy headless as nextlevel-assistant in a console with no window
// (ctx.runConsole), the copy removed, and the real project compared with how it was before (the tripwire: ctx.tripwire).
const ASK_PROMPT = `nextlevel ask: read the file ${QUESTION_FILE.join('/')} in this folder. It has the owner's question and what you need to answer it: answer it as it says, in your reply.`;
async function askAgy(ctx, profile, prompt, { base, env, startedAt }) {
  const none = { ...base, text: '', tokens: null, minutes: 0 };
  const locked = ctx.lockProblem?.('assistant', profile) || '';
  if (locked) return { ...none, error: locked };
  const entries = ctx.protectedEntries?.();
  const before = projectSnapshot(ctx.root, entries);
  let copy;
  try {
    copy = makeAskCopy(ctx.root);
    // (its names, as made and as the file system has it: an answer's links into it are made project-relative, cmdAsk)
    copy.names = [copy.dir, fs.realpathSync.native(copy.dir)];
  } catch (err) {
    return { ...none, error: err.message };
  }
  let out = { code: null, out: '', timedOut: false };
  let after = null;
  try {
    const q = path.join(copy.dir, ...QUESTION_FILE);
    fs.mkdirSync(path.dirname(q), { recursive: true });
    fs.writeFileSync(q, prompt);
    const run = agyAssistantRun({ copy: copy.dir, root: ctx.root, profile, prompt: ASK_PROMPT, env, engineArgs: ctx.config.engines?.agy?.args || [], version: ctx.agyVersion?.() || '', timeoutMin: TIMEOUT_MIN });
    if (run.problem) return { ...none, error: `The assistant doesn't start on Antigravity: ${run.problem}`, copySeconds: copy.seconds };
    // (the guard's watch while it answers: a protected file it changes in the real project is set back and held, as for a
    // round; the tripwire looks first, so it says that change too, and not the guard's own card)
    const watch = `ask:${process.pid}`;
    ctx.guardOpen?.(watch, "the assistant's question on Antigravity");
    try {
      out = ctx.runConsole('agy', run.args, { cwd: copy.dir, env: run.env, timeoutMs: TIMEOUT_MIN * 60_000 });
    } finally {
      after = projectSnapshot(ctx.root, entries);
      ctx.guardClose?.(watch);
    }
  } finally {
    try {
      removeAskCopy(copy.dir);
    } catch {
      // (the hub removes what is left of it after an hour: sweepAskCopies)
    }
  }
  const changed = projectChanges(before, after || projectSnapshot(ctx.root, entries));
  if (changed.length) ctx.tripwire?.(changed);
  const minutes = (Date.now() - startedAt) / 60000;
  const eng = engine('agy');
  const tokens = eng.tokens(out.out);
  ctx.addUsage('agy', { runs: 1, minutes, tokens });
  const result = agyResult(out.out);
  const text = result?.ok ? result.response.trim() : '';
  const failed = !text ? agyFailure(out.out, { code: out.code }).reason || (out.timedOut ? `no answer in ${TIMEOUT_MIN} minutes` : 'no answer') : '';
  const warn = changed.length ? `

(While it answered, your project changed: ${changed.join('; ')}. It worked in a copy, so this may be you or the hub, but look: Home says so too.)` : '';
  return { ...base, text: text ? `${text}${warn}` : '', error: failed ? `Antigravity: ${failed}${warn}` : '', tokens, minutes: Math.round(minutes * 100) / 100, copySeconds: copy.seconds, copyDirs: copy.names, changed };
}
