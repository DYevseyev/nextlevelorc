// nextlevel hub: the one entry point for the owner (START.cmd, or `nextlevel` alone, opens its menu)
// and the glue between the orchestrator (plans, delegates, reviews, merges; Codex by default) and the
// workers (the Antigravity CLI by default, Codex as their fallback). Any engine can take any role:
// nextlevel.json fills each role with a profile (an engine, the account it's signed into, a model), and
// the engines' own ways are in their adapters (src/engines/).
//
// The orchestrator should only think (Codex runs it sandboxed). The hub does the slow, long-running or
// privileged work outside that sandbox: it runs each worker in its own console window and git
// worktree ("slot"), verifies what the worker produced, pushes, sends phone notifications and the
// daily report, and on autopilot wakes the orchestrator only when something happened (FR-019, lib/rounds.mjs).
// Everything is exchanged through files under .nextlevel/ in the project (gitignored), so nothing
// depends on the orchestrator's sandbox or on either tool's session staying alive.
//
// The tool is installed once per PC and works on the project in the current folder (its git root),
// or on --project <path>. Settings come from the project's nextlevel.json; secrets from its .env.
//
// Owner         nextlevel                          menu (what START.cmd opens)
//               nextlevel init                     add nextlevel.json and the templates to a project
//               nextlevel ui [--no-open]           the dashboard in the browser (src/dashboard.mjs, src/ui/)
//               nextlevel doctor [--fix [<id>]] [--json]  the setup checks (src/checks/); --fix repairs what it can
//               nextlevel guide [<engine>|<profile>]   open the setup guide (default: the guide role's; _guide runs it)
//               nextlevel run [--autopilot]        the hub itself; leave it running
//               nextlevel orchestrator [--fallback]   open the orchestrator in its window
//               nextlevel login [<profile>]        sign a profile's account in, in this window (no profile: who is signed in)
//               nextlevel bridge-test [--engine E|--profile P]   prove hub -> workers works and workers can't push
//               nextlevel daily-report [--no-send] the daily report
//               nextlevel report [<check-id>]      a field report for nextlevel's developers, shown before it is filed (src/report.mjs)
//               nextlevel fix [<issue>] [--local]  Claude Code fixes a report; the hub follows it until it is installed (src/fix.mjs)
//               nextlevel team [set <role> ...]    who fills each role, with the model and effort in use; change one (src/team.mjs)
//               nextlevel ask "question" [--thread <id>] | ask threads | show | rename | clear | delete
//                                                  the assistant: a read-only side chat about the project (src/ask.mjs)
//               nextlevel security scan [--deep] | status [--json] | stop [<id>] | login
//                                                  the security engineer's scans, in OpenAI's scanner container; the hub
//                                                  starts an asked-for scan (_scan) and never one by itself (src/security.mjs)
//               nextlevel tester status | check [<plan>] | run <plan> --env <env> | wait <run> | show <run> | stop | persona ...
//                                                  acceptance plans run against the environments nextlevel.json names; the
//                                                  hub starts an asked-for run (_accept), one at a time (src/tester.mjs)
//               (cli.mjs: nextlevel update [--to <tag>|main] updates the tool itself: lib/update.mjs)
// Orchestrator  nextlevel dispatch <task-id> [--engine agy|codex|claude|--profile P|--fallback] [--model M] [--timeout MIN] [--kind code|review|research|design|map]
//               nextlevel retry <task-id> --feedback "what to fix" [--fallback|--engine E|--profile P]
//               nextlevel verify <name> -- <command>
//               nextlevel commit -m "message" [<path>...] | merge <task-id> [-m "message"] | cleanup <task-id> [--discard]
//                                                  git writes, done by the hub (Codex's sandbox can't write .git)
//               nextlevel close <task-id> --reason "..." | --file <path> [--discard]   (FR-021: a task the team won't
//                                                  build, closed by the hub and kept in closed.json; the owner's too)
//               nextlevel push <branch> [--from <local branch>]   (FR-015: the branch on origin always named; a deploy
//                                                  branch waits for the owner's approval on the dashboard; pushBranch)
//               nextlevel notify "title" "message" [default|high]   (--file <path>: the message from a file; --now sends at once)
//               nextlevel wakeup <minutes> --reason "..." | --file <path>   (FR-019: an autopilot round later, to read
//                                                  something outside the hub; the orchestrator's only)
//               nextlevel wait <job-id>|--any [--minutes 5]
//               nextlevel status [--json] | result <job-id> [--from <line>] [--file]
//                                                  (a long report is shortened there and says so: --from goes on from a
//                                                  line; --file shows a design, research or map task's result file, FR-012)
//               nextlevel usage [--range hour|today|week|month|all] [--by role|engine|model|worker|task|reason|day]
//                                                  [--all-projects] [--json]   (the usage ledger, lib/usage.mjs; --all-projects
//                                                  is the owner's)
//               nextlevel note list | seen <id>... | done <id> --reply "..." [--commit S] [--task T] | decline <id> --reply "..."
//               nextlevel handoff list | show <id> | add --file <path> [--task T] | answer <id> --file <path> | seen <id>... | close <id> --file <path>
//                                                  | cancel <id> --reply "..."
//                                                  the owner's notes and the handoff items, as cards (src/notes.mjs, lib/cards.mjs);
//                                                  docs/OWNER_NOTES.md and docs/HANDOFF.md are written from them. Free text comes
//                                                  from a file (--file), since nextlevel.cmd ends an argument at a line break (FR-014)
// Owner, too     nextlevel note add "text" [--rule] | edit | withdraw | off | on | remove;  nextlevel handoff done <id> [--reply "..."] | reply | reopen
// Every command's usage, options and arguments are in lib/commands.mjs, and its code reads them from there (FR-015).
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import tty from 'node:tty';
import { makeContext } from './checks/context.mjs';
import { TRIALS, TRIAL_NO_ANSWER_MS, agyTrial, agyTrialSpec, githubRepo, keptTrial, trialStands } from './checks/engines.mjs';
import { jsonStore, userState } from './lib/home.mjs';
import { parseVersion, versionText } from './checks/lib.mjs';
import { byId, runChecks } from './checks/index.mjs';
import { dailyReport } from './daily-report.mjs';
import { reopenDashboard, startDashboard } from './dashboard.mjs';
import { doctorOptions, runDoctor } from './doctor.mjs';
import { cmdFix, fixStore, followFixes } from './fix.mjs';
import { accountDir, accountProblem, engine, engineTitle, gitByHub, profileEnv, sessionArgs, windowArgs, workerCaveat, workerIsolation } from './engines/index.mjs';
import { ROLE_AGENTS, WORKER_AGENT_FILE, roleAgentFile } from './engines/agy.mjs';
import { lockLines, lockWords, runLockTest } from './locktest.mjs';
import { accessFacts } from './checks/argon.mjs';
import { blockCommands } from './lib/blockwatch.mjs';
import { outsideSlot, outsideWords, shorten } from './lib/slotwatch.mjs';
import { LOCKED_ROLES, lockFileParts, lockPasses, needsLockTest, roleKey, roleRun } from './lib/rolespec.mjs';
import { CONFIG_FILE, ENGINES, SECOND, SECOND_TAKES, describeProfile, effortFor, findProfile, loadConfig, modelFor, profilesInUse, roleProfile, securityProfile, workerArgsOf } from './lib/config.mjs';
import { INSTALL_COMMAND, binDir } from './lib/install.mjs';
import { channelOf, runningVersion, versionFor } from './lib/versions.mjs';
import { FORMAT, formatProblem, writeFormat } from './lib/format.mjs';
import { openWindow as openWindowAt, resolveBin, runQuiet, runQuietAsync, spawnBin, spawnDirect, windowTitle } from './lib/proc.mjs';
import { cachedFacts, checksView, factsComplete, repoFacts } from './lib/ghrepo.mjs';
import { listProcesses, listWaitMs, processName, processStartSync, processTree, stopProcesses } from './lib/proctree.mjs';
import { missingFiles, programFiles } from './lib/toolfiles.mjs';
import { writeSlotFile } from './lib/slotfiles.mjs';
import { consoleBroken, consoleProblem, openConsoleInput, rememberConsoleFailure, runInConsole, startInConsole } from './lib/console.mjs';
import { agyAssistantRun, makeAskCopy, removeAskCopy, sweepAskCopies } from './lib/askcopy.mjs';
import { logWriter } from './lib/workerlog.mjs';
import { githubFileUrl, phoneText } from './lib/phone.mjs';
import { portBlock, slotOffset } from './lib/ports.mjs';
import { OUTSIDE_ONLY, canWriteGit, detectSandbox } from './lib/sandbox.mjs';
import { NO_COMMITS_FIX, TOOL_ROOT, hasCommits } from './lib/project.mjs';
import { ago, getState, isDone, statusMilestones } from './lib/state.mjs';
import { MERGES_LOG, buildRoadmap, isBridgeTask, isTaskSpec, mergeJobsDone, mergeMessage, mergedTasks, pace, parseBrief, parseDecisions, parsePlan, parseProjectDoc, planProblems, specMilestone } from './lib/roadmap.mjs';
import { closeReason, closedSince, closedText, closureRecord, closuresFile, closuresOf } from './lib/closures.mjs';
import { COMMANDS, commandArgs } from './lib/commands.mjs';
import { holdFor as updateHoldFor, queuedByUpdate, updateRunView } from './updater.mjs';
import { AVAILABLE_EVERY_MS, CHECKED, describeTool, hasVersions, ownerSaysNoUpdates, readAvailable, rememberProject, thisVersion, toolGit, updateBlocker, updatesOff } from './lib/update.mjs';
import { cmdReport, fileShownReport, redactReport, reportSecrets } from './report.mjs';
import { cmdTeam } from './team.mjs';
import { approvedPolicy, changePolicy, cmdScanProcess, cmdSecurity, draftSource, pendingRequests, readPolicy, recoverScans, requestDraft, requestScan, requestStop, scanTrusted, securityPage } from './security.mjs';
import { DRAFT_WARNING, POLICY_MAX, POLICY_WHY, mayDraft, policyText, policyWhat } from './lib/securitypolicy.mjs';
import { listScans, readScan, runningScan } from './lib/securityscan.mjs';
import { capProblem, cmdAcceptProcess, cmdTester, evidenceFile, hubRequest, listRuns, ownerRun, pendingRuns, pruneRuns, readRun, recordStart, recoverRuns, runView, runningRun, testerView, writeRun } from './tester.mjs';
import { VERSION_EVERY_MS, VERSION_WAIT_MS, changesWords, deployEnvs, deployedBySome, failedStep, fixDraft, planChanges, resultKey, specAcceptance, versionNames } from './lib/acceptloop.mjs';
import { planPathProblem, readPlan } from './lib/acceptance.mjs';
import { safeText } from './lib/evidence.mjs';
import { reachOf, request as testerRequest } from './lib/testernet.mjs';
import { testerOn } from './lib/testerconfig.mjs';
import { briefingSize, cardFor, cmdAsk } from './ask.mjs';
import { advisorDir, memoryStore } from './lib/advisor.mjs';
import { chatStore } from './lib/chats.mjs';
import { readOnly } from './lib/readonly.mjs';
import { agentSession, ownerOnly } from './lib/session.mjs';
import { cmdHandoff, cmdNote } from './notes.mjs';
import { UNDO_MS, acceptState, acceptWords, awaitsOwner, cardStore, eventsOf, firstLine, noteGroups, unreadAnswer } from './lib/cards.mjs';
import { readTextFile } from './lib/textin.mjs';
import { codexWorkersView, engineChoices, jobModel, teamView, windowView } from './lib/team.mjs';
import { attemptTally, taskAlerts as findAlerts, taskSentence, taskTitle } from './lib/overview.mjs';
import { asksToMerge, hasConflictMarkers, mergeText } from './lib/slotgit.mjs';
import { lockNote, readEnv, retryOnLock, retryOnLockAsync } from './lib/gitlock.mjs';
import { ABSENT, contentHash, diffTexts, guardStore, inProject, linkOnTheWay, shownDiff } from './lib/guard.mjs';
import { describeGitChange, diffGitState, folderName, readGitState, same as sameFolder, stateKey } from './lib/gitguard.mjs';
import { describeSecretFile, findSecrets, isEnvFile, redactSecrets, secretValues } from './lib/secrets.mjs';
import { describeChanges, isProtected, pathKey, protectedList, protectedOwned } from './lib/protect.mjs';
import { REMOTE, deployList, isDeployBranch, parseLsRemote, pushArgs, targetProblem } from './lib/push.mjs';
import { KINDS, OUTPUT_BUDGET, RESULT_KINDS, byteLength, head, kindOf, resultFileOf, resultFileProblem, sizeOf, sizeText, tail } from './lib/reports.mjs';
import { forThePhone, loadEnv, notify, parseEnvFile } from './notify.mjs';
import { SECRET_NAME, phoneSecrets } from './lib/redact.mjs';
import { redactionValues } from './lib/vault.mjs';
import { READ_TOKEN, githubFailure } from './lib/github.mjs';
import { pushBlockEnv } from './lib/pushblock.mjs';
import { PER_HOUR, REASONS, REASON_ORDER, ROUND_LIMIT_MIN, addTrigger, autopilotOn, decide, freshState, isReason, ms as isoMs, noteReal, oneLine, roundEnded, roundStarted, roundsProblem, takeWake, waitView, wakeId, wakeKey } from './lib/rounds.mjs';
import { clockIso, clockNow } from './lib/clock.mjs';
import { readJsonFile, updateJsonFile } from './lib/filelock.mjs';
import { appendLedger, dayLines, ledgerDir, oldestDay, perDay, ranges, readLedger, runRecord, sumUsage, taskTokensText, tokensOf, tokensWords, usageLines, within } from './lib/usage.mjs';
import { NEEDS, lacks, needsText, needsWords, specNeeds, workersThatCan } from './lib/needs.mjs';
import { KEY_LIMIT, KEY_PROMPT, NO_GH_CONFIG, NO_PUSH, SLOT_PUSH_BLOCK, runKey, workerEnv as sharedWorkerEnv, workerRun } from './lib/workerspec.mjs';

const BIN = path.join(TOOL_ROOT, 'bin', 'nextlevel.mjs');
const IS_WIN = process.platform === 'win32';

// Set by setup() once the project is known.
let ROOT, DIR, QUEUE, JOBS, OUTBOX, LOGS, SLOTS_ROOT, TASKS, TASK_DIR, NAME, SETTINGS, HUBFILE, STOPFILE, CYCLEFILE, GUIDEFILE, SWITCHES, ROUNDSFILE, WAKEFILE, ROUNDNOW, CLOSEDFILE;
let CFG, LOADED, PROMPTS;
let DOTENV_KEYS = []; // variables that came from the project's .env: never passed on to workers
let CONFIG_STAMP = ''; // nextlevel.json as it was when the settings were read: a change is read again (M9)
let TOLERANT = false;
let COMMON_DIR; // the project's git folder, shared by its worktrees (commonDir)

// Runtime switches that aren't project settings.
const envFlag = (name) => [process.env[`NEXTLEVEL_${name}`]].find((v) => v !== undefined && v !== '');

// `tolerant` (the doctor, the dashboard): a broken nextlevel.json becomes a failed check instead of
// stopping everything.
function setup(root, { tolerant = false } = {}) {
  ROOT = root;
  TOLERANT = tolerant;
  COMMON_DIR = undefined;
  CONFIG_STAMP = configStamp();
  // Every variable whose value is the one in .env counts as a .env value, also when the nextlevel that
  // started this one (the menu's hub window, the dashboard) had loaded it already: loadEnv leaves a
  // variable that is set alone, and workers would then inherit it.
  const dotenv = path.join(ROOT, '.env');
  loadEnv(dotenv);
  DOTENV_KEYS = Object.entries(parseEnvFile(dotenv))
    .filter(([k, v]) => process.env[k] === v)
    .map(([k]) => k);
  try {
    LOADED = loadConfig(ROOT);
  } catch (err) {
    if (!tolerant) throw err;
    let fallback;
    try {
      fallback = loadConfig(ROOT, { file: null });
    } catch {
      fallback = loadConfig(ROOT, { file: null, env: {} });
    }
    LOADED = { ...fallback, exists: fs.existsSync(path.join(ROOT, CONFIG_FILE)), error: err.message };
  }
  const c = LOADED.config;
  DIR = path.join(ROOT, '.nextlevel');
  TASK_DIR = '.nextlevel-task';
  QUEUE = path.join(DIR, 'queue');
  JOBS = path.join(DIR, 'jobs');
  OUTBOX = path.join(DIR, 'outbox');
  LOGS = path.join(DIR, 'logs');
  SETTINGS = path.join(DIR, 'settings.json');
  HUBFILE = path.join(DIR, 'hub.json');
  STOPFILE = path.join(DIR, 'hub-stop.json'); // the dashboard's Stop: the hub takes it at its next tick
  CYCLEFILE = path.join(DIR, 'cycle.json'); // an autopilot round's process (_cycle), which the hub follows
  GUIDEFILE = path.join(DIR, 'guide.json'); // the setup guide's window (_guide), while it is open
  SWITCHES = path.join(DIR, 'switches.json'); // fallbacks and engine switches, for Home (FR-008)
  ROUNDSFILE = path.join(DIR, 'rounds.json'); // what may start an autopilot round, and the brake and fuse (FR-019; the hub's)
  WAKEFILE = path.join(DIR, 'wakeup.json'); // the wake-up the orchestrator asked for (nextlevel wakeup writes it; the hub reads)
  ROUNDNOW = path.join(DIR, 'round-now.json'); // how often the owner pressed Run a round now (the dashboard writes it; the hub reads)
  CLOSEDFILE = path.join(DIR, 'closed.json'); // the tasks closed with nextlevel close (FR-021; only the hub writes it)
  SLOTS_ROOT = path.join(path.dirname(ROOT), `${path.basename(ROOT)}.slots`);
  TASKS = path.join(ROOT, c.paths.tasks);
  NAME = c.name;
  CFG = {
    base: c.baseBranch,
    slots: c.workers.slots,
    taskTimeoutMin: c.workers.taskTimeoutMin,
    checkTimeoutMin: c.checks.timeoutMin,
    reportHour: c.hub.reportHour,
    rounds: { ...c.hub.rounds, perHour: PER_HOUR }, // the brake, the fuse and the shortest wake-up (FR-019)
    graceMin: c.workers.killGraceMin, // extra time before a worker is force-stopped
    window: c.workers.window, // how a worker's process shows on Windows (FR-010)
    // the profiles that fill the roles ({ name, engine, account, model }), and what they fall back to
    orchestrator: roleProfile(c, 'orchestrator'),
    worker: roleProfile(c, 'worker'),
    guide: roleProfile(c, 'guide'),
    fallback: (role) => roleProfile(c, role, { fallback: true }),
    args: (name) => c.engines[name]?.args || [], // the orchestrator's, the setup guide's and autopilot rounds'
    workerArgs: (name) => workerArgsOf(c, name), // every worker task's on that engine, however it was chosen
    model: (name, requested) => modelFor(c, name, requested),
    config: c,
  };
  const docs = c.paths.roles;
  PROMPTS = {
    // A worker whose sandbox can't write git (Codex) is told so: its commits and merges failed (FR-008); one that
    // can't run PowerShell's .ps1 shims or reach Docker there (Codex on Windows) is told what to run (FR-009). Every
    // worker keeps progress notes for the dashboard's "Show activity". Every worker is told where its report goes and
    // what its first line is, whatever WORKER.md the project has (FR-020), and that its session ends with its turn:
    // a real task's attempt 10 (Claude Code) ended its turn to wait for a check it ran in the background, and wrote none.
    worker: (id, { byHub = false, tips = '', slot = '' } = {}) =>
      `ROLE: WORKER. Task ${id}. Follow ${docs.worker} and do the task in ${TASK_DIR}/TASK.md. Every few steps, add one short line to ${TASK_DIR}/PROGRESS.md: what you are doing and why.` +
      // (17 October: an absolute path typed wrong wrote PROGRESS.md outside the slot; the slot's own name,
      // given here, is what a file tool's full path starts with)
      ` Your slot is ${slot || 'your current folder'}, a checkout of its own and your current folder: write files only inside it (where a tool asks for a full path, start it with ${slot ? 'that folder exactly as written here' : 'your current folder exactly as it is'}, never typed from memory), and run git and every command there, never in another folder.` +
      ` When you finish, write your report in ${TASK_DIR}/RESULT.md, even when you fail: its first line is exactly "Status: DONE", "Status: PARTIAL" or "Status: BLOCKED".` +
      ' Run every command in the foreground and wait for it to end. Write the report before you end your turn: your session ends with it, and anything still running is stopped. A command stopped at its time limit is no reason to skip the report: say what you know.' +
      (byHub ? ` Your sandbox can't write git in this slot: don't run git commands that write (add, commit, merge, rebase, stash, checkout, reset). The hub merges ${c.baseBranch} in when a retry needs it and commits your changes when you finish; put the commit message in your report as "Commit: <message>".` : '') +
      (tips ? ` ${tips}` : ''),
    // Interactive, it stopped after dispatching until the owner nudged it (FR-004 #8)
    // (both name the project's folder: on 17 October agy's window ran its first commands in agy's own scratch folder and
    // searched the home folder for AGENTS.md)
    orchestrator:
      `ROLE: ORCHESTRATOR, interactive session. Follow ${docs.orchestrator}. Your project is ${ROOT}: run every command and every git command there. Keep going until something needs the owner: ` +
      'after you dispatch, wait for the jobs (nextlevel wait --any), review, merge and dispatch the next tasks; never end your turn just to report progress.',
    cycle: `ROLE: ORCHESTRATOR, autopilot cycle. Follow ${docs.orchestrator}. Your project is ${ROOT}: run every command and every git command there. Do one cycle, then end your turn.`,
    guide: `ROLE: GUIDE. Follow ${docs.guide}.`,
  };
}

// nextlevel.json's size and time: when they change, the settings are read again (refreshConfig)
function configStamp() {
  try {
    const st = fs.statSync(path.join(ROOT, CONFIG_FILE));
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return 'none';
  }
}
// The Team page (or the owner's editor) changed nextlevel.json: read it again, so the next autopilot round and
// the next task use the new team. Nothing running changes: a round has its session, a worker its process. A
// file that doesn't load leaves the settings as they were (the doctor shows why). Returns whether they changed.
function refreshConfig() {
  if (!ROOT || configStamp() === CONFIG_STAMP) return false;
  const before = CFG && teamLine();
  const was = { LOADED, CFG, PROMPTS };
  try {
    setup(ROOT, { tolerant: TOLERANT });
  } catch (err) {
    CONFIG_STAMP = configStamp();
    ({ LOADED, CFG, PROMPTS } = was);
    log(`nextlevel.json changed but can't be used (${err.message.split('\n').slice(0, 2).join(' ')}): the hub keeps the settings it had`);
    return false;
  }
  const after = teamLine();
  if (before !== after) log(`nextlevel.json changed: ${after}. The next autopilot round and the next task use it; what runs now goes on as it is.`);
  return true;
}
const teamLine = () => `orchestrator ${describeProfile(CFG.orchestrator)}, workers ${describeProfile(CFG.worker)}${CFG.fallback('worker') ? `, fallback worker ${describeProfile(CFG.fallback('worker'))}` : ''}`;

const num = (v, d) => (v !== undefined && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : d);
// The owner's notes and the team's handoff items (lib/cards.mjs): kept in the state folder, the Markdown written from them
const cards = () => cardStore({ root: ROOT, stateDir: DIR, files: { notes: CFG.config.paths.notes, handoff: CFG.config.paths.handoff }, onLock: lockLog(path.join(DIR, 'cards')) });
const runState = () => getState({ root: ROOT, statusFile: CFG.config.paths.status, handoffFile: CFG.config.paths.handoff, handoff: () => cards().handoff.list() });
const ACTIVE = new Set(['queued', 'running', 'verifying']);
const FINAL = new Set(['done', 'failed', 'timeout', 'blocked', 'no-changes', 'lost', 'error', 'passed', 'stopped']);
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HUB_HINT = 'Owner: start the hub (START.cmd -> 4, or nextlevel run).';
const TASK_DIRS = ['.nextlevel-task']; // the task folder in a slot

// ---------- small helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString();
// An ISO time as it was written, or '' (a record from elsewhere)
const isoOr = (x) => (typeof x === 'string' && Number.isFinite(Date.parse(x)) ? new Date(Date.parse(x)).toISOString() : '');
// When a run ended, for the usage ledger, on lib/clock.mjs's clock: its own record's end (a wall-clock time) moved by
// how long ago that was, so a run the hub learned of late keeps its end, under the tests' clock too
const ledgerEnd = (x) => {
  const t = Date.parse(isoOr(x));
  return Number.isFinite(t) ? new Date(clockNow() - Math.max(0, Date.now() - t)).toISOString() : clockIso();
};
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
const uniq = () => `${stamp()}-${Math.random().toString(36).slice(2, 6)}`;
const mkdirp = (p) => fs.mkdirSync(p, { recursive: true });
const rel = (p) => path.relative(ROOT, p) || '.';
const readText = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '');
const readJson = (p, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return d;
  }
};
// (the new content goes to a new file of a name no one can guess, `wx`: never through a link an agent put there first)
function writeJson(p, v) {
  mkdirp(path.dirname(p));
  const tmp = `${p}.${randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { flag: 'wx' });
  for (let i = 0; ; i++) {
    try {
      fs.renameSync(tmp, p);
      return;
    } catch (err) {
      if (i >= 20) {
        fs.rmSync(tmp, { force: true });
        throw err; // Windows: another process may hold the file for a moment
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50); // (a node started to wait was a window's flash)
    }
  }
}
// (a command whose output is its answer, `ask --json` for the dashboard: what the hub's code logs meanwhile goes to hub.log only)
let logQuiet = false;
const quietly = (fn) => {
  const was = logQuiet;
  logQuiet = true;
  try {
    return fn();
  } finally {
    logQuiet = was;
  }
};
function log(msg) {
  const line = `${new Date().toLocaleTimeString()}  ${msg}`;
  if (!logQuiet) console.log(line);
  try {
    mkdirp(LOGS);
    fs.appendFileSync(path.join(LOGS, 'hub.log'), `${now()}  ${msg}\n`);
  } catch {
    // logging must never break the hub
  }
}
// Git in the main checkout or a slot, for the hub and the dashboard (another process: its reads come while the hub
// writes). Without git's optional locks, so a read never holds index.lock, and run again while a held index.lock
// stops it (lib/gitlock.mjs).
function git(args, { cwd = ROOT, allowFail = false } = {}) {
  const res = retryOnLock(() => {
    const r = spawnSync('git', args, { cwd, env: readEnv(), encoding: 'utf8', windowsHide: true });
    const out = (r.stdout || '').trim();
    const err = (r.stderr || '').trim() || r.error?.message || '';
    return { ok: r.status === 0, out, err, text: `${err}\n${out}` };
  });
  // `out` alone is what callers read; a held lock is told from both
  if (!res.ok && !allowFail) throw new Error(`git ${args.join(' ')}: ${res.err || res.out || 'failed'}${lockNote(res)}`);
  return res;
}
const alive = (pid) => {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};
function killTree(pid) {
  if (!pid) return;
  if (IS_WIN) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
  }
}

// Whether a headless run of this engine needs a real console: agy's print mode on Windows. It gets one with no
// window (lib/console.mjs), or a window of its own when the owner asks for one (workers.window), and never runs
// without one: that is where it drops its output or hangs (FR-010).
const needsConsole = (name) => IS_WIN && engine(name).needsRealConsole(process.platform);

// The environment of a session on a profile: its account's folder, when it has one of its own.
const withProfile = (env, profile) => profileEnv(env, profile, { home: os.homedir() });

// A console window of its own on Windows (lib/proc.mjs's openWindow), in this project unless told otherwise
function openWindow(title, file, args, { cwd = ROOT, ...opts } = {}) {
  return openWindowAt(title, file, args, { cwd, ...opts });
}

// ---------- settings, jobs, hub liveness ----------
const getSettings = () => readJson(SETTINGS, { autopilot: CFG.config.hub.autopilot });
// Several processes write settings.json (the hub, the dashboard, the menu, the orchestrator's window): each change is read,
// made and written under the file's lock (lib/filelock.mjs), so none is lost to another made at the same moment (FR-019:
// the owner turning autopilot on, which releases the brake and the fuse, must never be undone by a write of the hub's)
// A lock taken over from its holder (gone, or one that kept it over 12 s), or a change made again because this write's own
// lock was taken over, goes to hub.log; `events` collects them for a caller that tells the owner (lib/filelock.mjs)
const lockLog = (file, events = []) => (e) => {
  events.push(e);
  log(`${path.basename(file)}: ${e.took ? `took its lock over: ${e.why}` : e.why}`);
};
const updateSettings = (fn, events) => updateJsonFile(SETTINGS, fn, { autopilot: CFG.config.hub.autopilot }, { onLock: lockLog(SETTINGS, events) });
const setSetting = (k, v) => updateSettings((s) => ({ ...s, [k]: v }));
// Run a round now's count (round-now.json: the dashboard raises it; an agent can write it too): a whole number, else 0
const pressCount = (r) => (Number.isSafeInteger(r?.n) && r.n >= 0 ? r.n : 0);
const jobDir = (id) => path.join(JOBS, id);
const jobStatus = (id) => readJson(path.join(jobDir(id), 'status.json'));
function setStatus(id, patch) {
  const s = { ...(jobStatus(id) || { id }), ...patch, updatedAt: now() };
  writeJson(path.join(jobDir(id), 'status.json'), s);
  return s;
}
function allJobs() {
  if (!fs.existsSync(JOBS)) return [];
  return fs
    .readdirSync(JOBS)
    .map((id) => jobStatus(id))
    .filter(Boolean)
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}
// Under Codex the hub's process may be out of sight: its Linux sandbox gives commands a PID namespace of
// their own. There the heartbeat alone says the hub runs.
const PIDS_HIDDEN = !!(detectSandbox(process.env) || process.env.CODEX_THREAD_ID || process.env.CODEX_SESSION_ID);
function hubAlive() {
  const h = readJson(HUBFILE);
  return !!h && (alive(h.pid) || PIDS_HIDDEN) && Date.now() - Date.parse(h.heartbeatAt || 0) < 90_000;
}
function orchestratorAlive() {
  const o = readJson(path.join(DIR, 'orchestrator.json'));
  return !!o && alive(o.pid);
}
const slotPath = (n) => path.join(SLOTS_ROOT, `w${n}`);
// Slot n's port offset: unique across every project on this PC (FR-004 #7, lib/ports.mjs). The project's
// block is given out the first time it's needed and kept in ~/.nextlevel/state.json.
let PORT_BLOCK;
const portOffset = (n) => slotOffset((PORT_BLOCK ??= portBlock(ROOT)), n);
const composeName = (n) => `${NAME.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[^a-z0-9]+/, '') || 'project'}_w${n}`;
// What a worker and its verify commands see: no .env values (slots have no .env on purpose, and the
// environment must not bring them in), no project root, and nothing that can push (lib/workerspec.mjs).
const workerEnv = (base = process.env) => sharedWorkerEnv(base, { dotenv: DOTENV_KEYS });
// gh's folder for workers and verify commands holds no sign-in (NO_GH_CONFIG): one folder for every slot and project, so a
// sign-in an earlier worker left there (gh auth login, a hosts.yml) would reach every later one. Taken out before each
// task starts, and logged.
function noGhLogin() {
  for (const name of ['hosts.yml']) {
    const f = path.join(NO_GH_CONFIG, name);
    if (!fs.existsSync(f)) continue;
    try {
      fs.rmSync(f, { force: true });
      log(`removed ${slash(f)}: gh's folder for workers holds no sign-in, and an earlier worker or command had left one`);
    } catch (err) {
      log(`couldn't remove ${slash(f)} (${err.message}): gh's folder for workers should hold no sign-in`);
    }
  }
}
// The environment the hub builds for a slot: the worker's, with the slot's own ports.
function slotEnv(n, id) {
  // (and a gh folder with no sign-in: the worker and its task's verify commands, never the hub's own gh, NO_GH_CONFIG)
  const env = { ...workerEnv(), GH_CONFIG_DIR: NO_GH_CONFIG };
  delete env.NEXTLEVEL_IN_WINDOW; // set only for workers the hub opens a window for (startTask)
  const offset = String(portOffset(n));
  return {
    ...env,
    NEXTLEVEL_AGENT: 'worker', // an agent's session: what it writes is never recorded as the owner's (lib/guard.mjs)
    NEXTLEVEL_TASK_ID: id,
    NEXTLEVEL_SLOT: String(n),
    NEXTLEVEL_PORT_OFFSET: offset,
    COMPOSE_PROJECT_NAME: composeName(n),
  };
}

// Parse "## Verify" fenced commands from a task spec. (Read with LF line ends: a spec saved on Windows has CRLF, and its
// Verify block was lost, "0 verify command(s)".)
function verifyFromSpec(text) {
  const m = String(text ?? '').replace(/\r\n?/g, '\n').match(/##\s*Verify\s*\n+```[a-z]*\n([\s\S]*?)```/i);
  return m ? m[1].split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')) : [];
}
// A spec with a Verify heading: when no command comes out of it, dispatch says so (a parse miss never passes silently)
const hasVerifyHeading = (text) => /^#{1,6}[ \t]*Verify\b/im.test(String(text ?? ''));

function enqueue(job) {
  mkdirp(QUEUE);
  // (a job the one-click update queues, its backup push, role-doc commit or bridge test, is its own: its hold lets it through)
  const own = queuedByUpdate(ROOT) ? { by: 'update', update: process.env.NEXTLEVEL_UPDATE_ID } : {};
  writeJson(path.join(QUEUE, `${job.id}.json`), { ...job, ...own, queuedAt: now() });
  setStatus(job.id, {
    type: job.type,
    kind: job.kind,
    engine: job.engine,
    // (a retry: what the hub did in git for the attempt before is that attempt's, FR-008)
    // (and where a design, research or map task's result goes, FR-012)
    ...(job.type === 'task' ? { role: job.role || '', profile: job.profile || '', timeoutMin: job.timeoutMin, engineWhy: job.why || null, merge: null, hubCommit: null, detail: null, held: null, resultFile: job.resultFile || '', waiting: null, waitingFor: null, engineError: null, engineEnd: null, missing: null, mark: null, startTip: null, ownCommits: null, ownDiffStat: '', ownLost: null } : {}),
    attempt: job.attempt || 1,
    state: 'queued',
    acked: false,
    createdAt: jobStatus(job.id)?.createdAt || now(),
    finishedAt: null,
  });
}

// ---------- orchestrator-facing commands ----------
// Why a task runs on its engine (FR-008): kept on the job, shown by `nextlevel result` and on Home.
// { how: 'role' | 'spec' | 'asked' | 'fallback' | 'previous' | 'auto-fallback', text, check? }
const ROLE_WHY = { how: 'role', text: "the worker role's engine (roles.worker in nextlevel.json)" };

// The profile a task runs on: --profile, --engine or --fallback; else the spec's "Profile:" or "Engine:"
// line; else, on a retry, the one the last attempt ran on; else the worker role's. `why` says which.
function taskProfile(a, specText, prevJob, { retry = false } = {}) {
  const verb = retry ? 'retry' : 'dispatch';
  const because = (p, why) => ({ ...p, why });
  const config = CFG.config;
  const named = (name, where) => {
    const p = findProfile(config, name, { worker: true });
    if (!p && name === SECOND) throw new Error(`${where} names the second worker, and there is none: the owner adds one on the Team page (Second worker), or send the task to the workers`);
    if (!p) throw new Error(`${where} names "${name}", which is neither a profile in nextlevel.json (${Object.keys(config.profiles).join(', ') || 'none'}) nor an engine (${ENGINES.join(', ')})`);
    return p;
  };
  if (a.profile !== undefined) {
    if (typeof a.profile !== 'string') throw new Error('--profile needs a name: a profile in nextlevel.json');
    return because(named(a.profile, '--profile'), { how: 'asked', text: `${verb} with --profile ${a.profile}` });
  }
  if (a.engine !== undefined) {
    if (!ENGINES.includes(a.engine)) throw new Error(`--engine must be ${ENGINES.join(', ')}`);
    return because(findProfile(config, a.engine, { worker: true }), { how: 'asked', text: `${verb} with --engine ${a.engine}` });
  }
  if (a.fallback) {
    const fb = CFG.fallback('worker');
    if (!fb) throw new Error('the worker role has no fallback: set "fallback" under roles.worker in nextlevel.json (a profile or an engine)');
    return because(fb, { how: 'fallback', text: `${verb} with --fallback: the workers' fallback (roles.worker.fallback in nextlevel.json)` });
  }
  const specProfile = (specText.match(/^Profile:\s*([\w.-]+)/im) || [])[1];
  if (specProfile) return because(named(specProfile, 'the spec\'s "Profile:" line'), { how: 'spec', text: `the spec's "Profile: ${specProfile}" line` });
  const specEngine = (specText.match(/^Engine:\s*(agy|codex|claude)\b/im) || [])[1];
  if (specEngine) return because(findProfile(config, specEngine, { worker: true }), { how: 'spec', text: `the spec's "Engine: ${specEngine}" line` });
  if (prevJob?.engine && prevJob.role !== 'worker') {
    const first = prevJob.why?.how === 'previous' ? prevJob.why.first : prevJob.why?.text;
    const p = (prevJob.profile && findProfile(config, prevJob.profile, { worker: true })) || findProfile(config, prevJob.engine, { worker: true });
    return because(p, { how: 'previous', text: `as attempt ${prevJob.attempt || 1}${first ? `: ${first}` : ''}`, first: first || '' });
  }
  return { ...CFG.worker, fromRole: true, why: ROLE_WHY }; // the worker role's: the one in nextlevel.json when it starts (M9)
}

// The profile a queued task runs on now (a profile edited since it was queued counts as edited). A task on the
// worker role (no engine or profile of its own) runs on the role as nextlevel.json has it when it starts, so a
// change on the Team page reaches the next task; one the hub moved to the role's fallback (`fellBack`, the
// role's engine couldn't start) runs there.
function jobProfile(job) {
  if (job.role === 'worker' && !job.fellBack) {
    const w = CFG.worker;
    return { ...w, model: job.model || w.model, effort: job.effort || w.effort };
  }
  const p = (job.profile && findProfile(CFG.config, job.profile, { worker: true })) || { name: '', engine: job.engine, account: job.account || '', model: modelFor(CFG.config, job.engine, '', { worker: true }), effort: effortFor(CFG.config, job.engine, { worker: true }) };
  return { ...p, model: job.model || p.model, effort: job.effort || p.effort };
}

function cmdDispatch(argv, { retry = false } = {}) {
  const a = commandArgs(retry ? 'retry' : 'dispatch', argv);
  const id = a._[0];
  if (!id || !ID_RE.test(id)) throw new Error('usage: dispatch <task-id>  (letters, digits, . _ -)');
  if (!hasCommits(ROOT)) throw new Error(NO_COMMITS_FIX(ROOT));
  const spec = path.join(TASKS, `${id}.md`);
  if (!fs.existsSync(spec)) throw new Error(`write ${rel(spec)} first (template: ${rel(path.join(TASKS, '_TEMPLATE.md'))})`);
  const prev = jobStatus(id);
  // The one queued task a retry takes (FR-022): one held for a failing Antigravity trial, which never started, moved to
  // another engine or profile. The same attempt, with what it was queued with.
  // ... and one held because its engine can't give what it needs (its "Needs:" line), moved the same way
  const held = retry && prev?.state === 'queued' && ['agy', 'needs'].includes(prev.waitingFor);
  const queued = held ? readJson(path.join(QUEUE, `${id}.json`)) : null;
  if (held && a.fallback === undefined && a.engine === undefined && a.profile === undefined) {
    if (prev.waitingFor === 'needs') throw new Error(`${id} is queued and can't start: ${prev.waiting}. A retry moves it to a worker that can: nextlevel retry ${id} --profile P (or --engine E, --fallback)`);
    throw new Error(`${id} is queued, waiting for Antigravity (${prev.waiting}). A retry can move it to another engine: nextlevel retry ${id} --fallback (or --engine E, --profile P); it starts once the trial passes otherwise`);
  }
  if (prev && ACTIVE.has(prev.state) && !(held && queued)) throw new Error(`${id} is already ${prev.state}`);
  if (prev && !retry) throw new Error(`${id} was already dispatched (${prev.state}). Use: retry ${id} --feedback "..."`);
  if (retry && !prev) throw new Error(`${id} was never dispatched; use dispatch`);
  // An attempt whose worker didn't start ran nothing, and one stopped from outside (FR-013) was cut short by something
  // else than the task: its retry is the same attempt, and needs no feedback; nor does a held one that never started
  const again = retry && (prev?.notStarted || prev?.stoppedOutside || !!queued);
  if (retry && !again && (typeof a.feedback !== 'string' || !a.feedback.trim())) throw new Error('retry needs --feedback "what to fix"');
  const specText = readText(spec);
  // A task never owns a protected path: those files steer the agents and the owner's tools, and change only with the
  // owner's approval (lib/protect.mjs)
  const owned = protectedOwned(specText, protectedEntries());
  if (owned.length) {
    throw new Error(
      `${slash(rel(spec))} owns ${owned.map((o) => `${o.entry} (it ${o.why})`).join(', ')}: a task can't own a protected path, so nothing was dispatched. ` +
        `Protected files steer the agents and the owner's tools outside any sandbox, and change only with the owner's approval. ` +
        `Take them out of "Files owned" (list the files the task changes, not a whole folder that holds protected ones); if the project needs one changed, ask the owner: nextlevel handoff add --file <path> (the request, with a line "Where: ..." and a line "Why: ...")`,
    );
  }
  // Design, research and map tasks put their result in a file under docs/ that the spec names, committed with the task
  // (FR-012: a result in the report alone was shortened for the orchestrator); a spec of another kind may name one too
  if (a.kind !== undefined && !KINDS.includes(a.kind)) throw new Error(`--kind must be ${KINDS.join(', ')}`);
  const kind = a.kind || (KINDS.includes(kindOf(specText)) ? kindOf(specText) : 'code');
  const resultFile = resultFileOf(specText).replace(/\\/g, '/').replace(/^\.\//, '');
  if (RESULT_KINDS.has(kind) && !resultFile) {
    throw new Error(
      `${slash(rel(spec))} is a ${kind} task and names no result file, so nothing was dispatched. A ${kind} task writes its result to a file under docs/ that ` +
        `its spec names, committed with the task: a long result in the report alone gets shortened when you read it. Add a line "Result file: docs/<folder>/${id}.md" ` +
        `(for example docs/${kind === 'map' ? 'maps' : kind}/${id}.md) under "Kind:", list that file under "Files owned" too, commit the spec, then ${retry ? 'retry' : 'dispatch'} it again.`,
    );
  }
  const resultProblem = resultFile && resultFileProblem(resultFile, protectedEntries());
  if (resultProblem) throw new Error(`${slash(rel(spec))}: its result file ${resultFile} ${resultProblem}, so nothing was dispatched. Name a file under docs/ that isn't protected, such as docs/design/${id}.md.`);
  const profile = taskProfile(a, specText, retry && readJson(path.join(jobDir(id), 'job.json')), { retry });
  const problem = accountProblem(profile);
  if (problem) throw new Error(`${problem}. Dispatch it on another profile (--profile), or take "account" out of that profile in nextlevel.json.`);
  // What the task needs from its engine (its "Needs:" line): a worker that can't give it is refused here, saying who can
  const { needs, unknown } = specNeeds(specText);
  if (unknown.length) throw new Error(`${slash(rel(spec))} has "Needs: ${unknown.join(', ')}", which nextlevel doesn't know, so nothing was dispatched. A "Needs:" line takes ${Object.keys(NEEDS).join(', ')} (several with commas), or none.`);
  const missing = lacks(profile, needs, { config: CFG.config, platform: NEEDS_PLATFORM });
  if (missing.length) {
    const can = workersThatCan(needs, { config: CFG.config, platform: NEEDS_PLATFORM });
    throw new Error(
      `${id} ${needsWords(profile, missing, can)}, so nothing was ${retry ? 'retried' : 'dispatched'}. ` +
        (can.length ? `Send it to one that can (${can.map((c) => `${c.who}: ${c.how}`).join('; ')})` : 'Take Codex workers out of their sandbox on the Team page (the owner\'s choice), or ask the owner for a worker on another engine') +
        `, or take "${needsText(missing.map((m) => m.need))}" out of its "Needs:" line if the task doesn't need it.`,
    );
  }
  const verify = a.verify?.length ? a.verify : verifyFromSpec(specText);
  const attempt = retry ? (prev.attempt || 1) + (again ? 0 : 1) : 1;
  const given = typeof a.feedback === 'string' && a.feedback.trim() ? [a.feedback] : [];
  const feedback = queued ? [...(queued.feedback || []), ...given] : retry ? [...(readJson(path.join(jobDir(id), 'job.json'))?.feedback || []), ...given] : [];
  // A fallback of its own ({ engine, model, effort }) has no name to look it up by when it runs: its model
  // and effort go with the task
  const inline = a.fallback && !profile.name;
  enqueue({
    id,
    type: 'task',
    kind,
    role: profile.fromRole ? 'worker' : '', // on the worker role: whatever it is when the task starts
    engine: profile.engine,
    profile: profile.name, // '' for an engine on its own login
    account: profile.account,
    model: typeof a.model === 'string' ? a.model : inline ? profile.model : '', // asked for; else the profile's, when it runs
    effort: inline ? profile.effort : '',
    timeoutMin: num(a.timeout, CFG.taskTimeoutMin),
    verify,
    resultFile,
    needs, // (its "Needs:" line: checked again when it starts, on the profile it starts on)
    feedback,
    attempt,
    why: profile.why,
  });
  console.log(`queued ${id} (attempt ${attempt}, ${describeProfile(profile)}, kind ${kind}, ${verify.length} verify command(s))`);
  if (!verify.length && hasVerifyHeading(specText)) {
    console.log(
      `warning: ${slash(rel(spec))} has a Verify heading, but no command came out of it, so the hub's verify runs none for this attempt. ` +
        `Put the commands in a fenced block right under "## Verify" (\`\`\`sh, one command a line) and commit the spec: the task's next attempt reads them ` +
        `(nextlevel retry ${id} --feedback "...", once this attempt has ended; or give them with --verify).`,
    );
  }
  if (resultFile) console.log(`its result goes in ${resultFile}, committed with the task: the hub's verify checks that it is there and not empty`);
  if (profile.why && !['role', 'spec'].includes(profile.why.how)) console.log(`on ${engineTitle(profile.engine)}: ${profile.why.text}`);
  // (an engine named on its own takes a worker's model there, never the orchestrator's: with none, the engine's own)
  if (!profile.name && !profile.fromRole && !profile.model && typeof a.model !== 'string') console.log(`its model: ${engineTitle(profile.engine)}'s own choice (no worker on ${engineTitle(profile.engine)} sets one)`);
  if (gitByHub(profile, CFG.workerArgs(profile.engine))) {
    console.log(`${engineTitle(profile.engine)}'s sandbox can't write git in its slot: the hub ${retry ? `merges ${CFG.base} into task/${id} before it starts and ` : ''}commits what it leaves (FR-008).`);
  }
  const was = closures().get(id);
  if (was) console.log(`${id} was ${closedText(was)}. It is open again once the hub starts this ${retry ? 'retry' : 'dispatch'} (FR-021).`);
  if (!hubAlive()) console.log(`WARNING: the hub is not running, so nothing will start. ${HUB_HINT}`);
  console.log('next: dispatch the tasks for the other free slots, then nextlevel wait --any (keep going: the job reports back there)');
}

function cmdVerify(argv) {
  const a = commandArgs('verify', argv);
  const name = a._[0];
  // One argument after -- is used verbatim (so "a && b" works); several are quoted one by one.
  const parts = a['--'] || [];
  const quote = (x) =>
    /^[\w\-.:/\\=@,+%]+$/.test(x) ? x : IS_WIN ? `"${x.replace(/"/g, '\\"')}"` : `'${x.replace(/'/g, `'\\''`)}'`;
  const command = (parts.length === 1 ? parts[0] : parts.map(quote).join(' ')).trim();
  if (!name || !/^[\w.-]{1,40}$/.test(name) || !command) throw new Error('usage: verify <name> -- <command>');
  const id = `check-${name}-${uniq()}`;
  // (who asked, as the command's environment says it: the job's own words, for the guard's log of verify commands)
  const agent = process.env.NEXTLEVEL_AGENT || '';
  const source = agentSession() || "the owner's command";
  enqueue({ id, type: 'check', command, timeoutMin: num(a.timeout, CFG.checkTimeoutMin), by: agent || 'owner', source });
  console.log(`queued ${id}: ${command}\nIt runs in the main checkout without Git pushes or GitHub sign-ins, and waits while git work is stopped for the owner.\nnext: nextlevel wait ${id}`);
}

// push <branch> [--from <local branch>] (FR-015): a push job for the hub, which pushes in pushBranch (below). The branch on
// origin is always named, never a default; a name that could reach a branch another way is refused here, and again by
// the hub, which also decides whether it is a deploy branch (then the owner approves it on the dashboard first).
function cmdPush(argv) {
  const a = commandArgs('push', argv);
  // (a worker can clear these variables: this catches a mistake, it keeps no one out. Git refuses a push from a slot
  // (FR-003), and a push to a deploy branch waits for the owner whoever asked; FR-017 part 2 keeps workers from the hub)
  if (process.env.NEXTLEVEL_TASK_ID) throw new Error("workers don't push: only the hub does, when the orchestrator asks. Put what should be pushed in your report.");
  const target = a._[0];
  const from = a.from ?? CFG.base;
  const remotes = gitLines(['remote']);
  const fromProblem = a.from !== undefined ? targetProblem(from, { remotes }) : '';
  const problem = targetProblem(target, { remotes, tags: localTags() }) || (fromProblem ? `--from ${fromProblem}` : '');
  if (problem) throw new Error(`nothing was queued: ${problem}. (nextlevel push --help)`);
  if (!branchExists(from)) throw new Error(`nothing was queued: there is no local branch "${from}" to push (--from names one: git branch lists them)`);
  if (!remotes.includes(REMOTE)) throw new Error(`nothing was queued: the project has no remote "${REMOTE}" (git remote -v lists its remotes)`);
  // A hub from before FR-015 pushed the base branch whatever a push job said: it gets none
  if (hubAlive() && readJson(HUBFILE)?.pushProtocol !== PUSH_PROTOCOL) {
    throw new Error("nothing was queued: the hub running now is an older nextlevel, which pushed the base branch whatever a push named. Owner: stop the hub and start it again (the dashboard's Stop and Start, or START.cmd -> 4), then push again.");
  }
  const agent = process.env.NEXTLEVEL_AGENT || '';
  const source = process.env.NEXTLEVEL_SESSION === 'autopilot' ? 'an autopilot round' : agent === 'orchestrator' ? "the orchestrator's window" : agent ? `a command in the ${agent}'s session` : "the owner's command";
  const id = `push-${uniq()}`;
  enqueue({ id, type: 'push', target, from, by: agent || 'owner', source });
  const deploy = deployBranchesNow();
  const later = isDeployBranch(target, deploy.list)
    ? `\n${target} is a deploy branch (${deploy.why(target)}), so nothing is pushed yet: the hub makes a card for the owner, who approves or rejects the push on the dashboard. Only that approval pushes. Carry on with other work; nextlevel wait ${id} says when the card is up.`
    : '';
  // (the hub decides from what is approved: a change the owner approved already goes out without a card, hence "unless")
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${from}^{commit}`], { allowFail: true }).out;
  let names = [];
  try {
    if (!later) {
      const r = pushProtected(tip, from, git(['rev-parse', '--verify', '--quiet', `refs/remotes/${REMOTE}/${CFG.base}^{commit}`], { allowFail: true }).out);
      if (r.held) names = r.names;
    }
  } catch {
    // (the guard's records may be out of this sandbox's reach: the hub decides anyway)
  }
  const held = names.length
    ? `\n${from} changes protected ${names.length === 1 ? 'file' : 'files'} compared with ${REMOTE}'s ${CFG.base} (${listFiles(names)}): unless the owner has approved that change already, nothing is pushed yet: the hub makes a card for the owner, who approves or rejects the push on the dashboard (GitHub runs a pushed branch's own workflows). Carry on with other work; nextlevel wait ${id} says when the card is up. A change to a protected file is best in a task of its own, so the rest of the work isn't held with it.`
    : '';
  console.log(`queued ${id}: ${from} to ${target} on ${REMOTE}${later}${held}\nnext: nextlevel wait ${id}`);
  if (!hubAlive()) console.log(`WARNING: the hub is not running, so nothing is pushed yet. ${HUB_HINT}`);
}

// wakeup <minutes> --reason "..." | --file <path> (FR-019): the orchestrator asks the hub for an autopilot round later, to
// read something outside the hub that the next round must read (a CI run still in progress). Only the orchestrator asks
// (its window or a round): the command refuses for a worker, a verify command, the assistant and the owner's own window,
// the way FR-017's owner-only commands refuse in an agent's session (no wall: an agent that sets the variables passes,
// KNOWN_ISSUES). The hub takes it in at its next look, keeps one at a time and sets its time (lib/rounds.mjs takeWake).
const WAKE_MAX_MIN = 24 * 60;
const MAX_WAKE_REASON = 300;
function cmdWakeup(argv) {
  const a = commandArgs('wakeup', argv);
  const session = agentSession();
  if (process.env.NEXTLEVEL_AGENT !== 'orchestrator' || process.env.NEXTLEVEL_TASK_ID || readOnly()) {
    const where = session ? `this is ${session}` : "this is the owner's own window: Home's Run a round now starts a round";
    throw new Error(`nextlevel wakeup is the orchestrator's (an autopilot round or its window) and refuses anywhere else (${where}): nothing was asked.`);
  }
  // (a plain number of minutes: digits and at most one dot, no 1e3 or 0x10)
  const given = String(a._[0]);
  const plain = given.length > 0 && given.length <= 10 && [...given].every((c) => c === '.' || (c >= '0' && c <= '9')) && given.split('.').length <= 2;
  const minutes = Number(given);
  if (!plain || !Number.isFinite(minutes) || minutes <= 0 || minutes > WAKE_MAX_MIN) throw new Error(`nextlevel wakeup takes the minutes to wait, from 1 to ${WAKE_MAX_MIN} (a day), not "${a._[0]}": nothing was asked.`);
  const raw = a.file !== undefined ? readTextFile(a.file === true ? '' : a.file, { root: ROOT }) : String(a.reason ?? '');
  const reason = teamWords()(raw).replace(/\s+/g, ' ').trim();
  if (!reason) throw new Error('say why the next round must look: --reason "the CI run of ci/m1 is still running" (or --file <path>): nothing was asked.');
  if (reason.length > MAX_WAKE_REASON) throw new Error(`the reason has ${reason.length} characters, more than ${MAX_WAKE_REASON}: say it in one short line (what the next round reads, and why): nothing was asked.`);
  // (an id of its own: the round that clears an ask says which, so the same words at the same time can't come back)
  const ask = { id: randomBytes(6).toString('hex'), askedAt: clockIso(), minutes, reason, by: session };
  writeJson(WAKEFILE, ask);
  const min = CFG.rounds.wakeMinMinutes;
  console.log(
    `Asked for a round in ${Math.max(minutes, min)} min or later, because: ${reason}\n` +
      `The hub waits as long as you asked, and at least ${min} min, doubled for each round in a row that found nothing new (${min}, ${2 * min}, then ${4 * min}); ` +
      `nextlevel status says when. A round that asks for a wake-up gets no round right after it: the wake-up is its next round (the owner acting or a task ending start one sooner). ` +
      `One wake-up waits at a time (this one replaces any before it), and any round that starts first clears it. ` +
      "Ask only for something outside the hub the next round must read (a CI run, a deploy), for about as long as it usually takes: never to wait for the owner, whose reply wakes the team anyway.",
  );
  if (!hubAlive()) console.log(`WARNING: the hub is not running, so no round starts until it does. ${HUB_HINT}`);
  return 0;
}

// ---------- the owner's phone (FR-004 #5) ----------
// Phones turned "see HANDOFF.md" into a link to a website (.md is a country's domain), and the request
// itself wasn't in the notification. So a notification that mentions the handoff file carries its open
// items, and every .md file name in it becomes a link to the file on GitHub (lib/phone.mjs), or loses
// its ".md" when the project isn't on GitHub or the file isn't committed.
function fileLinker() {
  const repo = githubRepo(git(['remote', 'get-url', 'origin'], { allowFail: true }).out);
  let files;
  return (name) => {
    if (!repo) return null;
    files ??= git(['ls-files'], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
    const want = name.replace(/\\/g, '/').replace(/^\.?\//, '');
    const base = (f) => f.split('/').pop().toLowerCase();
    const same = files.filter((f) => f.toLowerCase() === want.toLowerCase());
    const named = files.filter((f) => base(f) === base(want));
    const file = same[0] || (named.length === 1 ? named[0] : null);
    return file ? githubFileUrl(repo, CFG.base, file) : null;
  };
}
// (redacted like a report first, FR-017: a value from .env never reaches the phone, and it is found before the links
// change the text; notify() redacts again whatever it sends)
function forPhone(rawTitle, message) {
  const link = fileLinker();
  const title = forThePhone(rawTitle, ROOT);
  let text = forThePhone(String(message ?? '').trim(), ROOT);
  const handoff = CFG.config.paths.handoff;
  const word = path.posix.basename(handoff).replace(/\.md$/i, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`(^|[^A-Za-z0-9])${word}([^A-Za-z0-9]|$)`, 'i').test(`${title}\n${text}`)) {
    const open = runState().waiting.map((item) => forThePhone(item, ROOT)).filter((item) => !text.includes(item));
    if (open.length) text = `${text}\n\nWaiting on you:\n${open.map((item) => `- ${item}`).join('\n')}`.trim();
    const url = link(handoff);
    text = phoneText(text, { link });
    if (url && !text.includes(url)) text += `\n${url}`;
  } else text = phoneText(text, { link });
  return { title: phoneText(title), message: text };
}

function queueNotify(rawTitle, rawMessage, priority = 'default', tags = '') {
  const { title, message } = forPhone(rawTitle, rawMessage);
  mkdirp(OUTBOX);
  writeJson(path.join(OUTBOX, `${stamp()}-${Math.random().toString(36).slice(2, 8)}.json`), {
    title,
    message,
    priority,
    tags,
    attempts: 0,
  });
}
// The message may come from a file (--file <path>, a file in the project folder; --file -: stdin), never cut by a
// command line (FR-014: through nextlevel.cmd an argument ends at its first line break).
async function cmdNotify(argv) {
  const a = commandArgs('notify', argv);
  const now = !!a.now;
  const args = a._;
  const file = a.file === undefined ? null : a.file;
  const usage = 'usage: notify "title" "message" [default|high]   (--file <path>: the message from a file; --now: send at once, without the hub)';
  // (with --file, what follows the title is the priority, if anything)
  if (file !== null && (args.length > 2 || (args[1] && !['min', 'low', 'default', 'high', 'urgent'].includes(args[1])))) throw new Error(`give the message once: in a file (--file) or in the command, not both\n${usage}`);
  const [title, message = '', priority = 'default'] = file === null ? args : [args[0], readTextFile(file, { root: ROOT }), args[1] || 'default'];
  if (!title) throw new Error(usage);
  if (now) {
    if (!process.env.NTFY_TOPIC) throw new Error('NTFY_TOPIC is empty: put your ntfy topic in .env (see .env.example), then try again.');
    const m = forPhone(title, message);
    await notify(m.title, m.message, { priority, server: CFG.config.notifications.server, root: ROOT });
    return;
  }
  queueNotify(title, message, priority);
  console.log(hubAlive() ? 'queued; the hub sends it within seconds' : 'queued; it will be sent when the hub runs');
}

function summary(s) {
  // (FR-013: "Stopped from outside", in words, as Home and the Build page show it)
  const bits = [s.stoppedOutside ? 'Stopped from outside' : s.state];
  // (FR-020: done without a report is marked, and says what was checked)
  if (s.mark) bits.push(`finished without a report, ${s.mark}`);
  if (s.verify && s.verify !== 'skipped') bits.push(`verify ${s.verify}`);
  // ...and a missing report says why (stopped from outside says it in its own words, below)
  if (s.claimed === 'MISSING' && s.missing && !s.stoppedOutside) bits.push(s.missing === 'its report has no Status line' ? s.missing : `no report: ${s.missing}`);
  else if (s.claimed) bits.push(`worker says ${s.claimed}`);
  if (s.commits !== undefined && s.commits !== null) bits.push(commitsText(s));
  if (mergeText(s.merge)) bits.push(mergeText(s.merge));
  if (s.detail) bits.push(s.detail);
  if (s.state === 'queued' && s.waiting) bits.push(`waiting: ${s.waiting}`);
  if (s.error) bits.push(s.stoppedOutside ? s.error.replace(/^stopped from outside: /, '') : s.error);
  return bits.join(' · ');
}

// A check, push or git job the orchestrator saw finish with `nextlevel wait` (FR-019): its round knows how it ended, so its
// end starts no round after it (for the rounds only: reviewed, `acked`, stays what `nextlevel result` and the
// orchestrator's own git commands mean). Kept in a file of its own in the job's folder, `seen-in-round.json`: the hub is
// the only writer of status.json besides those. A task's end always starts one: its review is the next round's work.
const SEEN_IN_ROUND = 'seen-in-round.json';
const seenByRound = (j) => {
  if (process.env.NEXTLEVEL_AGENT !== 'orchestrator' || !j || !(j.type === 'check' || j.type === 'push' || j.type === 'git')) return;
  if (!fs.existsSync(path.join(jobDir(j.id), SEEN_IN_ROUND))) writeJson(path.join(jobDir(j.id), SEEN_IN_ROUND), { at: now(), by: agentSession() || 'the orchestrator' });
};
// What `wait` says of tasks held for what they need: each, why, and the retry that moves it (exit 3: nothing finished)
function needsHeldSaid(held) {
  for (const j of held) console.log(`${j.id} is queued and can't start: ${j.waiting}.`);
  console.log(`next: move ${held.length === 1 ? 'it' : 'each'} to a worker that can: nextlevel retry ${held[0].id} --profile P (or --engine E, --fallback). The same attempt; no feedback needed.`);
  return 3;
}

async function cmdWait(argv) {
  const a = commandArgs('wait', argv);
  const minutes = num(a.minutes, 5);
  const deadline = Date.now() + minutes * 60_000;
  const id = a._[0];
  if (!a.any && !id) throw new Error('usage: wait <job-id> | wait --any [--minutes N]');
  for (;;) {
    if (a.any) {
      const jobs = allJobs();
      const finished = jobs.filter((j) => FINAL.has(j.state) && !j.acked);
      if (finished.length) {
        for (const j of finished) {
          console.log(`finished  ${j.id}: ${summary(j)}`);
          seenByRound(j);
        }
        console.log('next: nextlevel result <job-id>   (marks it reviewed)');
        return 0;
      }
      if (!jobs.some((j) => ACTIVE.has(j.state))) {
        console.log('nothing is queued or running');
        return 0;
      }
      // (tasks that can't start where they are, by their "Needs:" line, wait for a retry that moves them: said at once
      // when nothing else is going on)
      const active = jobs.filter((j) => ACTIVE.has(j.state));
      if (active.every((j) => j.state === 'queued' && j.waitingFor === 'needs')) return needsHeldSaid(active);
    } else {
      const s = jobStatus(id);
      if (!s) throw new Error(`unknown job ${id}`);
      if (FINAL.has(s.state)) {
        console.log(`${id}: ${summary(s)}\nnext: nextlevel result ${id}`);
        seenByRound({ ...s, id });
        return 0;
      }
      if (s.state === 'queued' && s.waitingFor === 'needs') return needsHeldSaid([{ ...s, id }]);
    }
    if (!hubAlive()) {
      console.log(`the hub is not running, so nothing will progress. ${HUB_HINT}`);
      return 2;
    }
    if (Date.now() > deadline) {
      const running = allJobs().filter((j) => ACTIVE.has(j.state));
      // (a verify command that waits while git work is stopped says so, FR-017)
      console.log(`still running after ${minutes} min: ${running.map((j) => `${j.id} (${j.state}${j.state === 'queued' && j.waiting ? `, waiting: ${j.waiting}` : ''})`).join(', ') || id}`);
      // (a task held for a failing Antigravity trial starts once one passes; a retry can move it, FR-022)
      const held = running.filter((j) => j.state === 'queued' && j.waitingFor === 'agy' && (a.any || j.id === id));
      if (held.length) console.log(`${held.map((j) => j.id).join(', ')} ${held.length === 1 ? 'waits' : 'wait'} for Antigravity. To move ${held.length === 1 ? 'it' : 'one'} to the workers' fallback: nextlevel retry ${held[0].id} --fallback (or --engine E, --profile P). The same attempt; no feedback needed.`);
      console.log(`next: nextlevel wait ${a.any ? '--any' : id} again. Jobs are still running: keep waiting rather than ending your turn.`);
      return 3;
    }
    await sleep(5000);
  }
}

// result <job-id> [--peek]: the job's report and logs, and the job counts as reviewed; --peek (and a read-only
// session: the assistant, lib/readonly.mjs) only looks. What it prints stays within what the orchestrator's engine
// shows of a command's output (OUTPUT_BUDGET, FR-012): a long report or log is shortened, and says so, with its full
// length and the file that has all of it. --from <line> goes on with the report from that line; --file shows a design,
// research or map task's result file (from --from <line>). Neither changes whether the job counts as reviewed.
function cmdResult(argv) {
  const a = commandArgs('result', argv);
  const id = a._[0];
  const s = id && jobStatus(id);
  if (!s) throw new Error('usage: result <job-id> [--peek] [--from <line>] [--file]');
  if (a.from !== undefined || a.file) return resultPart(id, s, a);
  const d = jobDir(id);
  const top = [`# ${id}`, summary(s)];
  if (s.slot) top.push(`slot: ${slotPath(s.slot)}  branch: task/${id}`);
  // Which engine it ran on and why (FR-008), and what the hub did in git for it
  if (s.type === 'task' && s.engine) top.push(`engine: ${engineTitle(s.engine)}${s.profile ? ` (profile ${s.profile})` : ''}${s.engineWhy?.text ? `, ${s.engineWhy.text}` : ''}`);
  if (s.merge?.files?.length) top.push(`merge of ${s.merge.base}: conflicts in ${s.merge.files.join(', ')}${s.merge.resolved ? ', resolved by the worker' : s.merge.resolved === false ? ', not resolved' : ''}`);
  if (s.hubCommit) top.push(`the hub committed what the worker left: ${s.hubCommit} (git.log below)`);
  // What its attempts used (the usage ledger, every attempt: status.json keeps the last 50)
  if (s.type === 'task') {
    // (the months from a day before the task was first queued: the orchestrator runs result often)
    const from = (Date.parse(s.createdAt || s.startedAt || '') || Date.now()) - 86_400_000;
    const used = taskTokensText(readLedger(DIR, { from }).records.filter((r) => r.task === id));
    if (used) top.push(`tokens: ${used}`);
  }
  // How its attempts ended (FR-020)
  if (s.type === 'task' && (s.attempt || 1) > 1) {
    const tally = attemptTally(s).text;
    if (tally) top.push(`attempts so far: ${tally}`);
  }
  const resultFile = s.resultFile || readJson(path.join(d, 'job.json'))?.resultFile || '';
  if (resultFile) {
    const found = resultFileText(id, resultFile);
    top.push(
      found
        ? `result file: ${resultFile} on ${found.where}, ${sizeText(sizeOf(found.text))}. It is the task's result: read all of it before you judge the task (nextlevel result ${id} --file shows it in parts that fit).`
        : `result file: ${resultFile}, not on task/${id}${s.state === 'running' || s.state === 'queued' ? ' yet' : ''}`,
    );
  }
  const sections = [];
  // This attempt's own commits and diff stat first, then the branch's (FR-020)
  if (s.type === 'task' && (s.ownCommits || s.ownLost)) sections.push(ownSection(id, s));
  if (s.diffStat) sections.push(diffSection(id, s.diffStat));
  // How its engine ended, in its own words, and what it printed last, when it failed or wrote no report (FR-022, FR-020;
  // redacted when kept). A job from before FR-020 has engineError only.
  const e = s.engineEnd || s.engineError;
  if (e && typeof e === 'object' && (e.error || s.engineError || s.claimed === 'MISSING')) {
    const words = endWords(e) || String(e.reason || '(no reason given)');
    sections.push(`## How ${engineTitle(s.engine)} ended\n${words} (exit ${e.code ?? 'unknown'})${Array.isArray(e.last) && e.last.length ? `\nWhat it printed last:\n${e.last.map(String).join('\n')}` : ''}`);
  }
  for (const f of ['verify.log', 'check.log', 'push.log', 'git.log']) {
    const text = logSection(path.join(d, f));
    if (text) sections.push(text);
  }
  // The report gets what the rest leaves of the budget
  const used = sizeOf([...top, ...sections].join('\n\n'));
  const room = { lines: Math.max(40, OUTPUT_BUDGET.lines - used.lines - 4), bytes: Math.max(1500, OUTPUT_BUDGET.bytes - used.bytes - 16) };
  const first = [];
  while (sections.length && /^## (This attempt|Diff)/.test(sections[0])) first.push(sections.shift());
  console.log([top.join('\n'), ...first, reportSection(id, s, room), ...sections].join('\n\n'));
  if (!a.peek && !readOnly()) setStatus(id, { acked: true });
}

// How much of each log `nextlevel result` shows: its end (FR-012); a doctor run through the hub is long
const LOG_ROOM = { 'verify.log': { lines: 40, bytes: 2000 }, 'check.log': { lines: 120, bytes: 5000 }, 'push.log': { lines: 30, bytes: 1500 }, 'git.log': { lines: 30, bytes: 1500 } };
const DIFF_ROOM = { lines: 25, bytes: 1200 };
// The end of a job's log, and when it is shortened, how long it is and where all of it is
// (redacted as a phone message is, FR-017: a verify command runs with the project's .env values in its environment, and
// with the read-only GitHub token; what it prints never reaches the orchestrator with them)
function logSection(file, room = LOG_ROOM[path.basename(file)]) {
  const text = redactReport(readText(file), phoneSecrets({ root: ROOT, home: false })).replace(/^[\r\n]+/, '').trimEnd();
  if (!text.trim()) return '';
  const part = tail(text, room);
  const name = path.basename(file);
  return `## ${name}${part.cut ? ` (shortened: the last ${part.last - part.first + 1} of its ${part.total} lines; all of it: ${rel(file)})` : ''}\n${part.text}`;
}
// The dashboard's view of a task's attempt (FR-020): why its report is missing, its mark, its engine's end in words, its
// own commits (from git while the branch is there) and diff stat, and each recorded attempt in a line
function attemptView(id, s) {
  const own = s.startTip && !s.ownLost && s.ownCommits ? attemptOwn(id, s.startTip) : null;
  const e = s.engineEnd && typeof s.engineEnd === 'object' ? s.engineEnd : null;
  const list = Array.isArray(s.attempts) ? s.attempts : [];
  return {
    number: s.attempt || 1,
    missing: s.missing || '',
    mark: s.mark || '',
    end: e && (e.error || s.claimed === 'MISSING') && endWords(e) ? `${engineTitle(s.engine)}: ${endWords(e)} (exit ${e.code ?? 'unknown'})` : '',
    commits: commitsText(s),
    own: own && !own.lost ? own.commits : [],
    ownStat: (own && !own.lost && own.diffStat) || s.ownDiffStat || '',
    tally: (s.attempt || 1) > 1 || list.length > 1 ? attemptTally(s).text : '',
    list: list.map((a) => ({
      attempt: a.attempt,
      engine: a.engine ? engineTitle(a.engine) : '',
      model: a.model || '',
      tokens: Number.isFinite(a.tokens?.total) ? a.tokens.total : null,
      how: [a.notCounted ? `${a.notCounted} (not counted)` : a.state, a.mark ? `finished without a report, ${a.mark}` : '', a.verify && a.verify !== 'skipped' ? `verify ${a.verify}` : '', a.missing ? `no report: ${a.missing}` : a.claimed ? `worker says ${a.claimed}` : ''].filter(Boolean).join(' · '),
      commits: a.ownCommits === null || a.ownCommits === undefined ? (a.commits === null || a.commits === undefined ? '' : `${a.commits} in all`) : `${a.ownCommits} of its own`,
      at: a.finishedAt || null,
    })),
  };
}
// This attempt's own commits, the newest first, and its diff stat (FR-020): from git while the branch is there, else what
// the hub kept when the attempt ended
function ownSection(id, s) {
  if (s.ownLost) return `## This attempt's commits\nWhere this attempt started (${s.ownLost}) is no longer on task/${id}: its own commits can't be told apart (the branch's are below).`;
  const own = attemptOwn(id, s.startTip);
  const list = own && !own.lost ? own.commits : [];
  const stat = (own && !own.lost && own.diffStat) || s.ownDiffStat || '';
  const range = s.startTip ? `git log --oneline ${s.startTip.slice(0, 8)}..task/${id}` : '';
  const part = head(stat, DIFF_ROOM);
  const statText = !stat ? '' : part.more ? `${part.text}\n[... more: git diff --stat ${s.startTip.slice(0, 8)} task/${id}]` : stat.trimEnd();
  return `## This attempt's commits (${s.ownCommits}${range ? `; ${range}` : ''})\n${list.length ? `${list.join('\n')}\n` : ''}${statText}`;
}
function diffSection(id, stat) {
  const cmd = `git diff --stat ${CFG.base}...task/${id}`;
  const all = stat.trimEnd().split('\n');
  const part = head(stat, DIFF_ROOM);
  if (!part.more) return `## Diff (${cmd})\n${stat.trimEnd()}`;
  return `## Diff (${cmd}; shortened: ${part.last} of its ${all.length} lines, all of it: ${cmd})\n${part.text}\n[... ${all.length - part.last - 1} more line(s) ...]\n${all.at(-1)}`;
}
// Earlier attempts' reports, kept whole beside the job (FR-012): one line that names them, or ''
function earlierReports(d, current) {
  let names = [];
  try {
    names = fs.readdirSync(d).filter((f) => /^RESULT\.attempt-\d+(-\d+)?\.md$/.test(f) && f !== current);
  } catch {
    return '';
  }
  const n = (f) => f.match(/\d+/g).map(Number);
  names.sort((x, y) => n(x)[0] - n(y)[0] || (n(x)[1] || 0) - (n(y)[1] || 0));
  if (!names.length) return '';
  return `Earlier attempts' reports, whole, in ${rel(d)}: ${names.map((f) => `${f} (${sizeText(sizeOf(readText(path.join(d, f))))})`).join(', ')}`;
}
// The worker's report within `room`; a longer one says so at its top and where it is cut: its length, the lines shown,
// the file with all of it and the command for the next part.
function reportSection(id, s, room) {
  const d = jobDir(id);
  const text = readText(path.join(d, 'RESULT.md'));
  const earlier = earlierReports(d, s.reportFile);
  // (why, FR-020; and for one finished without a report, what to review instead)
  const why = s.missing ? `: ${s.missing}` : '';
  const instead = s.mark ? `\nFinished without a report, ${s.mark}: review this attempt's own commits and diff stat (above) and the verify log as you would a report.` : '';
  if (!text) return `## Worker report\n(none written${why})${instead}${earlier ? `\n${earlier}` : ''}`;
  const whole = rel(path.join(d, s.reportFile && fs.existsSync(path.join(d, s.reportFile)) ? s.reportFile : 'RESULT.md'));
  const size = sizeOf(text);
  const after = earlier ? { lines: 2, bytes: byteLength(earlier) + 2 } : { lines: 0, bytes: 0 };
  if (!head(text, { lines: room.lines - 1 - after.lines, bytes: room.bytes - 17 - after.bytes }).more) return `## Worker report\n${text.trimEnd()}${earlier ? `\n\n${earlier}` : ''}`;
  const top = (last) =>
    `Shortened here: this report has ${sizeText(size)}, and only lines 1-${last} are shown below. Nothing is lost: all of it is in ${whole}. ` +
    `Read the whole report before you judge this task (the next part: nextlevel result ${id} --from ${last + 1}).`;
  const cut = (last) => `[... the report goes on: lines ${last + 1}-${size.lines} are not shown here. All of it: ${whole} (nextlevel result ${id} --from ${last + 1})]`;
  // (the notes' own room, measured with the longest line numbers they can have)
  const notes = { lines: 4 + after.lines, bytes: byteLength(['## Worker report', top(size.lines), '', cut(size.lines)].join('\n')) + 2 + after.bytes };
  const part = head(text, { lines: Math.max(10, room.lines - notes.lines), bytes: Math.max(800, room.bytes - notes.bytes) });
  return ['## Worker report', top(part.last), '', part.text, cut(part.last), ...(earlier ? ['', earlier] : [])].join('\n');
}
// result <id> --from <line> [--file]: the report (or the task's result file) from a line, as much as fits, and where
// the next part starts
function resultPart(id, s, a) {
  const from = a.from === undefined ? 1 : a.from === true ? NaN : Number(a.from);
  if (!Number.isInteger(from) || from < 1) throw new Error('--from needs a line number: 1 or more');
  const d = jobDir(id);
  let text;
  let what;
  let whole;
  if (a.file) {
    const file = s.resultFile || readJson(path.join(d, 'job.json'))?.resultFile || '';
    if (!file) throw new Error(`${id} has no result file: only a spec that names one ("Result file: docs/..."; design, research and map tasks) has one`);
    const found = resultFileText(id, file);
    if (!found) {
      console.log(`# ${id}: its result file ${file} isn't on task/${id} or ${CFG.base}`);
      return 1;
    }
    ({ text } = found);
    what = `the result file ${file}`;
    whole = `${file} on ${found.where} (git show ${found.where}:${file})`;
  } else {
    text = readText(path.join(d, 'RESULT.md'));
    if (!text) {
      console.log(`# ${id}: no report written${earlierReports(d, s.reportFile) ? `\n${earlierReports(d, s.reportFile)}` : ''}`);
      return 0;
    }
    what = 'the report';
    whole = rel(path.join(d, s.reportFile && fs.existsSync(path.join(d, s.reportFile)) ? s.reportFile : 'RESULT.md'));
  }
  const size = sizeOf(text);
  if (from > size.lines) {
    console.log(`# ${id}: ${what} has ${sizeText(size)}: nothing from line ${from}`);
    return 0;
  }
  const title = (last) => `# ${id}: ${what}, lines ${from}-${last} of its ${sizeText(size)}`;
  const more = (last) => `[... ${what} goes on: lines ${last + 1}-${size.lines} are not shown here. All of it: ${whole}; the next part: nextlevel result ${id}${a.file ? ' --file' : ''} --from ${last + 1}]`;
  const notes = byteLength(`${title(size.lines)}\n${more(size.lines)}\n`) + 2;
  const part = head(text, { from, lines: OUTPUT_BUDGET.lines - 3, bytes: Math.max(800, OUTPUT_BUDGET.bytes - notes) });
  console.log([title(part.last), part.text, part.more ? more(part.last) : `[the end of ${what}]`].join('\n'));
  return 0;
}

// Deletes a task's branch in this process (the bridge test, run by the owner). The orchestrator's
// `cleanup` goes through the hub (cmdCleanup).
function deleteTaskBranch(id, discard) {
  const branch = `task/${id}`;
  if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).ok) {
    const r = git(['branch', discard ? '-D' : '-d', branch], { allowFail: true });
    if (!r.ok) throw new Error(`${branch} is not merged into ${CFG.base}. Merge it, or use --discard to throw the work away.`);
  }
  if (jobStatus(id)) setStatus(id, { acked: true, cleaned: true });
}

// ---------- git for the orchestrator (FR-004 #1) ----------
// Codex's sandbox can't write the project's .git folder (index.lock: Permission denied), so every commit
// and merge the orchestrator made needed the owner's approval, and autopilot couldn't work. It asks the hub
// instead: commit, merge and cleanup queue a git job, which the hub runs in the main checkout (one at a
// time, next to checks and pushes, logged in jobs/<id>/git.log), and the command waits for the result.
const branchExists = (branch) => git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true }).ok;

// A path from the caller's folder, as git in the project's top folder needs it; nothing outside the project.
// Compared as real paths (ROOT is one): Windows short names (C:\Users\RUNNER~1) and links; the path
// itself may be gone (a deleted file).
function projectPath(p) {
  let base = path.resolve(process.cwd(), p);
  const rest = [];
  while (!fs.existsSync(base) && path.dirname(base) !== base) {
    rest.unshift(path.basename(base));
    base = path.dirname(base);
  }
  const r = path.relative(ROOT, path.join(fs.realpathSync.native(base), ...rest));
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error(`${p} is outside the project (${ROOT})`);
  return r ? r.split(path.sep).join('/') : '.';
}

async function queueGitJob(job, a) {
  if (!hubAlive()) {
    console.log(`The hub is not running, so nothing was queued: git writes in the project go through the hub. ${HUB_HINT}`);
    return 2;
  }
  enqueue({ ...job, type: 'git' });
  if (a['no-wait']) {
    console.log(`queued ${job.id}\nnext: nextlevel wait ${job.id}`);
    return 0;
  }
  return awaitGitJob(job.id, num(a.minutes, 10));
}

// Waits for a git job, prints how it went (the end of its log when it failed) and marks it reviewed:
// the caller has seen the result, so it doesn't wait for review (or wake an autopilot cycle).
async function awaitGitJob(id, minutes) {
  const deadline = Date.now() + minutes * 60_000;
  for (;;) {
    const s = jobStatus(id) || { state: 'queued' }; // Windows: read while the hub replaces it
    if (FINAL.has(s.state)) {
      console.log(`${id}: ${summary(s)}`);
      const log = logSection(path.join(jobDir(id), 'git.log')); // (its end; a shortened one says so, FR-012)
      if (s.state !== 'done' && log) console.log(`\n${log}`);
      setStatus(id, { acked: true });
      return s.state === 'done' ? 0 : 1;
    }
    if (!hubAlive()) {
      console.log(`The hub stopped before ${id} was done. ${HUB_HINT}`);
      return 2;
    }
    if (Date.now() > deadline) {
      console.log(`${id} is still ${s.state} after ${minutes} min (a slow git hook of the project?).\nnext: nextlevel wait ${id}`);
      return 3;
    }
    await sleep(300);
  }
}

async function cmdCommit(argv) {
  const a = commandArgs('commit', argv);
  const message = typeof a.message === 'string' ? a.message.trim() : '';
  if (!message) throw new Error('usage: commit -m "message" [<path>...]   (no paths: every change in the project)');
  const paths = [...a._, ...(a['--'] || [])].map(projectPath);
  return queueGitJob({ id: `commit-${uniq()}`, op: 'commit', message, paths }, a);
}

async function cmdMerge(argv) {
  const a = commandArgs('merge', argv);
  const id = a._[0];
  if (!id || !ID_RE.test(id)) throw new Error('usage: merge <task-id> [-m "message"]   (merges task/<task-id> into the base branch)');
  const s = jobStatus(id);
  if (s && ACTIVE.has(s.state)) throw new Error(`${id} is still ${s.state}: merge it once it has finished (nextlevel wait ${id})`);
  if (!branchExists(`task/${id}`)) throw new Error(`there is no branch task/${id}${s?.cleaned ? ' (cleaned up already)' : ''}`);
  const message = typeof a.message === 'string' ? a.message.trim() : '';
  return queueGitJob({ id: `merge-${id}-${uniq()}`, op: 'merge', task: id, message }, a);
}

async function cmdCleanup(argv) {
  const a = commandArgs('cleanup', argv);
  const id = a._[0];
  if (!id || !ID_RE.test(id)) throw new Error('usage: cleanup <task-id> [--discard]');
  const s = jobStatus(id);
  if (s && ACTIVE.has(s.state)) throw new Error(`${id} is still ${s.state}`);
  if (!branchExists(`task/${id}`)) {
    // (nothing in git to change; a task that was never dispatched has nothing to clean up, and a cleanup never closes
    // it: that is `nextlevel close`, FR-021)
    const close = `To close a task you won't build: nextlevel close ${id} --reason "why" (replaced by which tasks, out of scope, the owner's call).`;
    if (!s) {
      console.log(`There is no branch task/${id} and no job for ${id}: nothing was deleted or written. ${close}`);
      return 1;
    }
    setStatus(id, { acked: true, cleaned: true });
    console.log(`There is no branch task/${id}: nothing was deleted. ${id}'s job is marked cleaned up and reviewed${closures().has(id) ? '' : `; the task isn't closed (${close})`}`);
    return 0;
  }
  return queueGitJob({ id: `cleanup-${id}-${uniq()}`, op: 'cleanup', task: id, discard: !!a.discard, ...closer() }, a);
}

// ---------- closing a task (FR-021) ----------
// A real project's orchestrator closed five tasks at the owner's word by writing "closed" in their specs; nothing read that, and
// the Project page counted them as planned. `nextlevel close` asks the hub, which checks the task again, deletes its
// branch when --discard says so, and keeps the closure in closed.json (lib/closures.mjs). A merge or an active job always
// outranks a closure, and a dispatch or a retry reopens it.
const closures = () => closuresOf(readJson(CLOSEDFILE));
// (only the hub's process changes it: its git job, a cleanup that throws a branch away, a task it starts)
function changeClosures(fn) {
  const map = closures();
  const r = fn(map);
  writeJson(CLOSEDFILE, closuresFile(map));
  return r;
}
// The tasks the hub merged: the merge log, and its finished merge jobs (lib/roadmap.mjs mergedTasks)
function mergeJobRecords(jobs = allJobs()) {
  return mergeJobsDone(jobs.filter((j) => j.type === 'git' && j.state === 'done' && j.id.startsWith('merge-')).map((status) => ({ status, job: readJson(path.join(jobDir(status.id), 'job.json')) })));
}
const mergedNow = (jobs) => mergedTasks(git(MERGES_LOG, { allowFail: true }).out, mergeJobRecords(jobs));
// Whether task/<id>'s work is in the base branch: an ancestor of it that isn't on its own line of commits (a task
// branch is merged --no-ff; one still at the commit it was made from has no work of its own: closing it throws nothing
// away). -> 'merged' | 'empty' | 'unmerged' | '' (no branch)
function branchIn(id) {
  const branch = `refs/heads/task/${id}`;
  const tip = git(['rev-parse', '--verify', '--quiet', branch], { allowFail: true }).out;
  if (!tip) return '';
  if (!git(['merge-base', '--is-ancestor', tip, `refs/heads/${CFG.base}`], { allowFail: true }).ok) return 'unmerged';
  const line = git(['rev-list', '--first-parent', `refs/heads/${CFG.base}`], { allowFail: true }).out.split(/\r?\n/);
  return line.includes(tip) ? 'empty' : 'merged';
}
// Why task <id> can't be closed now ('' when it can), and what it has: { problem, branch, job, spec }. Asked by the
// command and again by the hub's job.
function closeProblem(id, { discard = false } = {}) {
  const spec = path.join(TASKS, `${id}.md`);
  const job = jobStatus(id);
  const branch = branchIn(id);
  const out = { branch, job, spec: fs.existsSync(spec) ? spec : '' };
  const say = (problem) => ({ ...out, problem });
  if (isBridgeTask(id)) return say(`${id} is a bridge-test task (nextlevel bridge-test cleans its own up): it is never closed`);
  if (job && job.type !== 'task') return say(`${id} is a ${job.type} job, not a task`);
  // (a merged task whose spec, job and branch are gone is still merged: the merge log says so)
  const merged = branch === 'merged' || mergedNow().has(id);
  if (!out.spec && !job && !branch && !merged) return say(`there is no task ${id}: no spec ${slash(rel(spec))}, no job and no branch task/${id}`);
  if (job && ACTIVE.has(job.state)) return say(`${id} is ${job.state}: a task that is queued or running isn't closed (wait for it: nextlevel wait ${id})`);
  if (merged) return say(`${id} is merged into ${CFG.base}: a merged task is done, not closed`);
  const was = closures().get(id);
  if (was) return say(`${id} is closed already (${closedText(was)}): nothing changed`);
  if (branch === 'unmerged' && !discard) return say(`task/${id} has work that isn't merged into ${CFG.base}: merge it (nextlevel merge ${id}), or close it and throw that work away (nextlevel close ${id} --discard --reason "...")`);
  return out;
}
// Who closes, as the closure keeps it
const closer = () => ({ by: process.env.NEXTLEVEL_SESSION === 'autopilot' ? 'autopilot' : process.env.NEXTLEVEL_AGENT || 'owner', source: agentSession() || "the owner's command" });

// close <task-id> --reason "..." | --file <path> [--discard]: the orchestrator's, and the owner's. It refuses where
// push and wakeup do (a worker's slot, a verify command, a project hook, the assistant): no wall (KNOWN_ISSUES).
async function cmdClose(argv) {
  const a = commandArgs('close', argv);
  const id = a._[0];
  const session = agentSession();
  const agent = process.env.NEXTLEVEL_AGENT || '';
  if (process.env.NEXTLEVEL_TASK_ID || readOnly() || (agent && agent !== 'orchestrator')) {
    throw new Error(`nextlevel close is the orchestrator's and the owner's, and refuses anywhere else (this is ${session}): nothing was closed. Say in your report which task should be closed, and why.`);
  }
  if (!ID_RE.test(id)) throw new Error(`"${id}" isn't a task id (letters, digits, . _ -): nothing was closed`);
  const raw = a.file !== undefined ? readTextFile(a.file === true ? '' : a.file, { root: ROOT }) : String(a.reason ?? '');
  const r = closeReason(teamWords()(raw));
  if (r.problem) throw new Error(`${r.problem}: nothing was closed.`);
  const p = closeProblem(id, { discard: !!a.discard });
  if (p.problem) throw new Error(`${p.problem}: nothing was closed.`);
  const { by, source } = closer();
  return queueGitJob({ id: `close-${id}-${uniq()}`, op: 'close', task: id, reason: r.reason, discard: !!a.discard, by, source }, a);
}
// The closure a task gets: when, who, why, and what it had
function recordClosure(id, { reason, by, source, discarded = false, branch = '', job = null }) {
  const spec = readText(path.join(TASKS, `${id}.md`));
  const rec = closureRecord({ at: now(), by, source, reason, discarded, branch, jobState: job?.state || '', milestone: specMilestone(spec), title: spec ? taskTitle(spec, id) : '' });
  changeClosures((map) => map.set(id, rec));
  // (its job reviewed: Home's alerts and FR-019's triggers for it end)
  if (job) setStatus(id, { acked: true, ...(branch ? { cleaned: true } : {}) });
  return rec;
}
// A dispatch or a retry the hub takes from the queue reopens a closed task, and says so
function reopenClosed(id) {
  const was = closures().get(id);
  if (!was) return;
  changeClosures((map) => map.delete(id));
  log(`${id}: dispatched or retried, so it is open again (it was ${closedText(was)})`);
}

// What `nextlevel status --json` says (the assistant's briefing starts from it too)
function statusData(jobs = allJobs(), st = runState()) {
  const settings = getSettings();
  const h = readJson(HUBFILE);
  const closed = closures();
  return {
    hub: hubAlive() ? 'running' : 'stopped',
    heartbeat: h?.heartbeatAt || null,
    autopilot: !!settings.autopilot,
    autopilotPaused: settings.pausedReason || null,
    // what the next round waits for, or why the one running started (FR-019)
    autopilotNext: autopilotView(settings, jobs).text,
    orchestrator: orchestratorAlive() ? readJson(path.join(DIR, 'orchestrator.json'))?.mode : 'not running',
    milestones: `${st.doneCount}/${st.milestones.length}`,
    current: st.current ? `${st.current[0]} (${st.current[1]})` : null,
    waitingOnOwner: st.waiting,
    lastActivity: ago(st.idleHours),
    // (a closed task's job keeps its state, and says it is closed: FR-021)
    jobs: jobs.map((j) => ({ id: j.id, type: j.type, state: j.state, summary: summary(j), acked: j.acked, slot: j.slot, ...(j.type === 'task' ? { engine: j.engine || null, why: j.engineWhy?.text || null, closed: closed.has(j.id) && !ACTIVE.has(j.state) ? closedView(j.id, closed.get(j.id)) : null } : {}) })),
    closed: closedSince(closed, Date.now() - 86_400_000).map((c) => closedView(c.id, c)), // the tasks closed in the last day
    heldSlots: heldView(), // slots no task starts in while a stopped worker's processes may run there (FR-013)
    agyHold: agyHoldView(jobs), // tasks on Antigravity waiting for a passing trial (FR-022)
    lockHold: lockHoldView(), // the orchestrator on Antigravity held by its lock test (docs/design/antigravity-roles.md)
    assistantHold: lockHoldView('assistant'), // ... and the assistant (part B)
    askTripwire: getSettings().askTripwire || null, // the project changed while the assistant on Antigravity answered
    blockAlert: blockAlertView(), // a round on Antigravity that ran commands clearing the push block (lib/blockwatch.mjs)
    slotEscape: slotEscapeView(), // a worker that did something outside its slot (lib/slotwatch.mjs)
    workers: workersView(), // which workers there are, on which engine and model, and what each takes
  };
}
// The workers, as `nextlevel status` says them first (every session reads it): the workers, the second worker and the
// fallback, each with its engine, the model and effort in use, what it takes, how a task reaches it, and what of a task's
// "Needs:" it can't give here
function workersView() {
  const cfg = CFG.config;
  const all = Object.keys(NEEDS);
  return profilesInUse(cfg)
    .filter((p) => p.role === 'worker')
    .map((p) => {
      const use = jobModel(p, cfg, { home: os.homedir() });
      const who = p.second ? 'second worker' : p.fallback ? 'fallback' : 'workers';
      const takes = p.second ? SECOND_TAKES[p.takes] || p.takes : p.fallback ? "retries (--fallback, or when the workers' engine can't start)" : 'any task';
      const how = p.second ? `--profile ${p.name} or a spec's "Profile: ${p.name}" line` : p.fallback ? '--fallback' : 'no --engine or --profile';
      const cant = lacks(p, all, { config: cfg, platform: NEEDS_PLATFORM }).map((m) => m.need);
      return { who, engine: p.engine, engineTitle: engineTitle(p.engine), profile: p.name || '', model: use.model || '', modelOwn: use.modelOwn, effort: use.effort || '', takes, how, cant };
    });
}
// `nextlevel usage`: the usage ledger summed for a range, by one field (docs/design/token-usage.md). --all-projects
// adds the other projects this PC's hubs ran (state.json's list), each ledger read where it is: the owner's alone.
function cmdUsage(argv) {
  const a = commandArgs('usage', argv);
  if (a['all-projects']) {
    const session = readOnly() ? "the assistant's read-only session (nextlevel ask)" : agentSession();
    if (session) throw new Error(ownerOnly("nextlevel usage --all-projects (other projects' usage)", 'The owner sees it on the dashboard (Home, Usage, All projects), or with this command in their own window.', session));
  }
  const range = ranges(clockNow()).find((r) => r.key === (a.range || 'today'));
  const by = a.by || 'role';
  const projects = usageProjects(range, a['all-projects']);
  const records = projects.flatMap((p) => p.records);
  const rows = sumUsage(records, { by });
  const total = totalOf(records);
  const notes = projects.flatMap((p) => p.notes.map((x) => (projects.length > 1 ? `${p.name}: ${x}` : x)));
  const oldest = oldestDay(projects[0].records);
  const since = range.key === 'all' && oldest ? `from ${oldest}, the oldest day counted on this PC` : range.since;
  if (a.json) {
    console.log(JSON.stringify({ range: range.key, title: range.title, since, by, rows, total: total || null, notes, ...(a['all-projects'] ? { projects: projects.map((p) => ({ name: p.name, root: p.root, found: p.found, total: totalOf(p.records) })) } : {}) }, null, 2));
    return;
  }
  const out = [`Usage: ${range.title}, ${since} (runs that ended in it; what runs now counts when it ends)${a['all-projects'] ? `, ${projects.length} project(s)` : ''}`];
  out.push(total ? `In all: ${total.runs} run(s), ${total.minutes} minutes, tokens: ${tokensWords(total)}` : 'Nothing ended in this range.');
  if (a['all-projects']) {
    out.push('', 'By project:');
    for (const p of projects) {
      const t = totalOf(p.records);
      out.push(`  ${p.name}: ${!p.found ? 'not found' : t ? `${t.runs} run(s), ${t.minutes} minutes, tokens: ${tokensWords(t)}` : 'nothing in this range'}`);
    }
  }
  if (rows.length) {
    const used = Buffer.byteLength(out.join('\n')) + 200;
    const { lines, left } = usageLines(rows, { label: by[0].toUpperCase() + by.slice(1), maxBytes: OUTPUT_BUDGET.bytes - used });
    out.push('', ...lines);
    if (left) out.push(`(${left} more row(s): --json has them)`);
  }
  for (const x of notes) out.push(`Note: ${x}`);
  console.log(out.join('\n'));
}

function cmdStatus(argv) {
  const a = commandArgs('status', argv);
  const jobs = allJobs();
  const st = runState();
  const data = statusData(jobs, st);
  if (a.json) return console.log(JSON.stringify(data, null, 2));
  console.log(`Hub: ${data.hub}${data.autopilot ? ' · autopilot ON' : ' · autopilot off'}${data.autopilotPaused ? ` (paused: ${data.autopilotPaused})` : ''} · orchestrator: ${data.orchestrator}`);
  if (data.autopilot) console.log(`Autopilot: ${data.autopilotNext}`);
  console.log(`Milestones ${data.milestones}${data.current ? ` · now: ${data.current}` : ''} · last activity ${data.lastActivity}`);
  if (st.waiting.length) console.log(`Waiting on the owner: ${st.waiting.join(' | ')}`);
  // (the workers first: which there are, and what each takes; a spec says what it needs with a "Needs:" line)
  for (const w of data.workers) {
    // (Antigravity has no effort: its level is in the model's name, FR-010)
    const model = `${w.model || (w.modelOwn ? `${w.engineTitle}'s own model` : '')}${w.effort ? ` (${engine(w.engine).efforts.length ? 'effort' : 'level'} ${w.effort})` : ''}`;
    console.log(`Worker: ${w.who.padEnd(14)} ${w.engineTitle}${w.profile ? ` (profile ${w.profile})` : ''}${model ? `, ${model}` : ''} · takes ${w.takes} · ${w.how}${w.cant.length ? ` · can't take "Needs: ${w.cant.join(', ')}"` : ''}`);
  }
  const groups = [
    ['running', jobs.filter((j) => j.state === 'running' || j.state === 'verifying')],
    ['queued', jobs.filter((j) => j.state === 'queued')],
    ['to review', jobs.filter((j) => FINAL.has(j.state) && !j.acked)],
  ];
  for (const [label, list] of groups) {
    for (const j of list) console.log(`  ${label.padEnd(10)} ${j.id.padEnd(34)} ${j.slot ? `w${j.slot} ` : ''}${summary(j)}`);
  }
  if (!groups.some(([, l]) => l.length)) console.log('  no jobs waiting, running or to review');
  for (const c of data.closed) console.log(`  closed     ${c.id.padEnd(34)} ${c.at.slice(0, 16).replace('T', ' ')} by ${c.by}: ${c.reason}${c.discarded ? ' (its work thrown away)' : ''}`);
  for (const h of data.heldSlots) {
    const where = h.state === 'failed' ? `couldn't be freed: ${h.why}${h.left.length ? ` (${h.left.join(', ')})` : ''}; Check again on Home` : h.state === 'waiting' ? `${h.why}; asked again ${h.next ? `at ${new Date(h.next).toLocaleTimeString()}` : 'later'}` : 'looking for what it started';
    console.log(`  held slot  w${h.slot}: no task starts there while what ${h.id}'s stopped worker started may run · ${where}`);
  }
  if (data.agyHold) console.log(`  Antigravity tasks wait: ${data.agyHold.text}. Check again on Home; nextlevel retry <id> --fallback moves one`);
  if (data.lockHold) console.log(`  ${data.lockHold.text}. Check again on Home, or ${data.lockHold.command}`);
}

// A closure as status, the dashboard and the daily report show it
const closedView = (id, c) => ({ id, at: c.at, by: c.by, reason: c.reason, discarded: c.discarded, text: closedText(c) });

// ---------- the hub loop ----------
const busy = new Map(); // job id -> promise (verification / checks / push in progress)
let cycle = null;

function ensureSlot(n) {
  const wt = slotPath(n);
  if (fs.existsSync(path.join(wt, '.git'))) return wt;
  mkdirp(SLOTS_ROOT);
  git(['worktree', 'prune'], { allowFail: true });
  git(['worktree', 'add', '--detach', wt, CFG.base]);
  log(`created worker slot w${n} at ${wt}`);
  return wt;
}
function freeSlot() {
  // (a slot held because a stopped worker's processes may still run there takes no task: heldSlots)
  const used = new Set([...allJobs().filter((j) => j.type === 'task' && (j.state === 'running' || j.state === 'verifying')).map((j) => j.slot), ...Object.keys(heldSlots()).map(Number)]);
  for (let n = 1; n <= CFG.slots; n++) if (!used.has(n)) return n;
  return 0;
}
function excludeRuntimeDirs() {
  const common = git(['rev-parse', '--git-common-dir'], { allowFail: true }).out;
  if (!common) return;
  const f = path.join(path.resolve(ROOT, common), 'info', 'exclude');
  const cur = readText(f);
  // (and the agent file agy workers run as, which the worker's process writes in its slot: FR-013; and the orchestrator's
  // on agy, which the hub writes in the main checkout)
  const add = ['.nextlevel/', ...TASK_DIRS.map((t) => `${t}/`), `/${WORKER_AGENT_FILE.join('/')}`, ...Object.keys(ROLE_AGENTS).map((r) => `/${roleAgentFile(r).join('/')}`)].filter((l) => !cur.split(/\r?\n/).includes(l));
  if (add.length) {
    mkdirp(path.dirname(f));
    fs.appendFileSync(f, `${cur && !cur.endsWith('\n') ? '\n' : ''}${add.join('\n')}\n`);
  }
}

// ---------- workers can't push (FR-003) ----------
// agy's deny-list didn't stop `git push` on a real PC, so pushing is blocked in git itself, in layers
// that don't depend on the worker CLI. Only the hub pushes, from the main checkout, which keeps its
// own settings. The bridge test checks the result against a real remote.
// (NO_PUSH, the remote helper that doesn't exist, and the rest of a worker's push block: lib/workerspec.mjs noPushEnv)
const slash = (p) => p.split(path.sep).join('/');


// What a verify command runs with (FR-017). `nextlevel verify` runs the orchestrator's command in the main checkout with
// the owner's access, so its Git pushes and GitHub sign-ins are switched off through its environment: the push block
// (lib/pushblock.mjs, which the orchestrator's sessions on Antigravity get too). GitHub reads come back with the project's
// read-only token, when .env has one (lib/github.mjs). -> { env, token } or { problem }: a push would still reach a remote,
// and the command doesn't run.
const readToken = () => String(parseEnvFile(path.join(ROOT, '.env'))[READ_TOKEN] || '').trim();
const verifyEnv = () => pushBlockEnv(process.env, { root: ROOT, block: 'check', session: { NEXTLEVEL_AGENT: 'check' }, readToken: readToken() });

const commonDir = () => (COMMON_DIR ||= path.resolve(ROOT, git(['rev-parse', '--git-common-dir']).out));

// Settings of a slot's own (extensions.worktreeConfig). With the extension on, core.worktree in the
// shared config would apply to every worktree, so it moves to the main checkout's config first.
function useWorktreeConfig() {
  const shared = path.join(commonDir(), 'config');
  if (git(['config', '--file', shared, '--bool', '--get', 'extensions.worktreeConfig'], { allowFail: true }).out === 'true') return;
  const worktree = git(['config', '--file', shared, '--get', 'core.worktree'], { allowFail: true });
  if (worktree.ok) {
    git(['config', '--file', path.join(commonDir(), 'config.worktree'), 'core.worktree', worktree.out]);
    git(['config', '--file', shared, '--unset', 'core.worktree']);
  }
  git(['config', '--file', shared, 'extensions.worktreeConfig', 'true']);
  log('turned on extensions.worktreeConfig so worker slots get git settings of their own');
}

// The hooks folder slots use: pre-push refuses; each other hook the project has runs through a
// forwarder, so its own hooks (checks on commit, Git LFS) still run in slots. A forwarder runs the main checkout's
// hook by its full path, never the slot's copy: a worker could change that one, and the hub's commit in the slot would
// run it outside the worker's sandbox (the main checkout's are guarded: lib/gitguard.mjs, and protected paths for a
// hooks folder inside the project). Git for Windows runs `#!` files with its sh.
function writeSlotHooks() {
  const dir = path.join(commonDir(), 'nextlevel', 'slot-hooks');
  const configured = git(['config', '--type=path', '--get', 'core.hooksPath'], { allowFail: true }).out;
  const ownDir = path.resolve(ROOT, configured || path.join(commonDir(), 'hooks'));
  const base = slash(ownDir);
  const sq = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  const isFile = (name) => {
    try {
      return fs.statSync(path.join(ownDir, name)).isFile(); // follows symlinked hooks
    } catch {
      return false;
    }
  };
  const files = {
    'pre-push':
      '#!/bin/sh\n# Written by nextlevel: worker slots never push (FR-003). The hub pushes from the main checkout.\n' +
      'echo "nextlevel: pushing from a worker slot is blocked. Commit on your task branch; the hub pushes after review." >&2\nexit 1\n',
  };
  const own = fs.existsSync(ownDir) ? fs.readdirSync(ownDir) : [];
  for (const name of own.filter((n) => isFile(n) && !n.endsWith('.sample') && n !== 'pre-push')) {
    files[name] = `#!/bin/sh\n# Written by nextlevel: runs the project's own ${name} hook in a worker slot.\nh=${sq(`${base}/${name}`)}\n[ -x "$h" ] || exit 0\nexec "$h" "$@"\n`;
  }
  mkdirp(dir);
  for (const [name, body] of Object.entries(files)) {
    const f = path.join(dir, name);
    if (readText(f) !== body) fs.writeFileSync(f, body);
    fs.chmodSync(f, 0o755);
  }
  for (const name of fs.readdirSync(dir)) if (!files[name]) fs.rmSync(path.join(dir, name), { force: true });
  return slash(dir);
}

// Rewrites the slot's own git config at every task start (undoing anything a worker changed): every
// remote gets a push URL that fails, any other push URL (an explicit one, a remote added later) is
// rewritten to it, saved logins are off, and hooks come from writeSlotHooks. Then it checks the push
// URLs the way git will use them, and refuses the slot if any would still work.
function lockSlot(wt) {
  useWorktreeConfig();
  const q = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const lines = [
    '# Written by nextlevel at every task start: workers never push (FR-003).',
    '[core]',
    `\thooksPath = ${q(writeSlotHooks())}`,
    '[credential]',
    '\thelper = ""',
    `[url ${q(NO_PUSH)}]`,
    '\tpushInsteadOf = ""',
  ];
  const remotes = git(['remote']).out.split(/\r?\n/).filter(Boolean); // the project's, not the slot's
  for (const r of remotes) {
    // A pushurl in the shared config would still be used next to ours; an empty one clears it (Git 2.46+).
    const shared = git(['config', '--get-all', `remote.${r}.pushurl`], { allowFail: true }).ok;
    lines.push(`[remote ${q(r)}]`, ...(shared ? ['\tpushurl = ""'] : []), `\tpushurl = ${q(`${NO_PUSH}${r}`)}`);
  }
  fs.writeFileSync(path.resolve(wt, git(['rev-parse', '--git-path', 'config.worktree'], { cwd: wt }).out), `${lines.join('\n')}\n`);
  // (the hub's own settings and hooks for the slot, and the shared settings useWorktreeConfig may have moved: recorded
  // as they are now, so the guard's look at git's settings never takes them for someone else's, lib/gitguard.mjs)
  gitRecordOwn({ worktree: wt, keys: ['extensions.worktreeconfig', 'core.worktree'] });
  for (const r of remotes) {
    const urls = git(['remote', 'get-url', '--push', '--all', r], { cwd: wt, allowFail: true }).out.split(/\r?\n/);
    if (urls.every((u) => u.startsWith(NO_PUSH))) continue;
    throw new Error(
      `worker slot ${path.basename(wt)} could still push to "${r}", so no worker starts. The project's git config sets ` +
        `remote.${r}.pushurl, which only Git 2.46 or later can switch off for one slot. Update Git (PowerShell: winget upgrade Git.Git), ` +
        `or remove the setting (in the project folder: git config --unset-all remote.${r}.pushurl).`,
    );
  }
}

// ---------- the hub's git around a worker (FR-008) ----------
// Codex's sandbox keeps a slot's git folder read-only (it is under the project's .git: "Unable to create
// .../.git/worktrees/w1/ORIG_HEAD.lock: Permission denied"), so a Codex worker could neither merge the base
// branch in when a retry asked it to nor commit. The hub does both: before a retry whose feedback asks to
// merge the base branch (on every retry for such an engine) it merges it into the task branch in the slot
// and hands the worker any conflicts; when the worker finishes it commits what it left. Each git command is
// logged in jobs/<id>/git.log and hub.log, and runs with the worker's environment: the project's own hooks
// run in slots, and they never see a .env value.
// Every exit code is the caller's to check: a step that failed is never passed over. A command that finds
// index.lock held (the dashboard reading the slot, a worker's own git) is run again for a few seconds
// (lib/gitlock.mjs); each try is in git.log.
function slotGit(id, args, { cwd, slot }) {
  const logFile = path.join(jobDir(id), 'git.log');
  log(`${id}: git ${args.join(' ')} (in slot w${slot})`);
  const r = retryOnLock(() => {
    const p = spawnSync('git', args, { cwd, env: slotEnv(slot, id), encoding: 'utf8', windowsHide: true });
    const out = `${p.stdout || ''}${p.stderr || ''}${p.error ? `${p.error.message}\n` : ''}`;
    try {
      mkdirp(path.dirname(logFile));
      fs.appendFileSync(logFile, `\n$ git ${args.join(' ')}   (slot w${slot}, ${now()})\n${out}${out && !out.endsWith('\n') ? '\n' : ''}[exit ${p.status}]\n`);
    } catch {
      // the log must never stop the hub
    }
    return { ok: p.status === 0, out: out.trim() };
  });
  if (r.tries > 1) log(`${id}: git ${args[0]} in slot w${slot} found index.lock held; ${r.ok ? `it went through after ${(r.waited / 1000).toFixed(1)} s` : `still held after ${(r.waited / 1000).toFixed(1)} s`}`);
  return r;
}

// Whether the slot is in the middle of a merge (MERGE_HEAD).
const slotMerging = (wt) => fs.existsSync(path.resolve(wt, git(['rev-parse', '--git-path', 'MERGE_HEAD'], { cwd: wt, allowFail: true }).out || '.git/MERGE_HEAD'));

// Merges the base branch into the task branch checked out in the slot. A conflict stays in the slot for the
// worker to resolve (the files keep git's markers); anything else that stops the merge undoes it.
// -> { base, result: 'up to date' | 'merged' | 'conflicts' | 'failed', commits, files, detail }
function mergeBaseInto(wt, job, slot) {
  const base = CFG.base;
  if (git(['merge-base', '--is-ancestor', base, 'HEAD'], { cwd: wt, allowFail: true }).ok) return { base, result: 'up to date' };
  const commits = Number(git(['rev-list', '--count', `HEAD..${base}`], { cwd: wt, allowFail: true }).out) || 0;
  const r = slotGit(job.id, ['merge', '--no-ff', '--no-edit', '-m', `Merge ${base} into task/${job.id} (the hub, before attempt ${job.attempt})`, base], { cwd: wt, slot });
  if (r.ok) return { base, result: 'merged', commits, commit: git(['rev-parse', '--short', 'HEAD'], { cwd: wt, allowFail: true }).out };
  const files = lines(git(['diff', '--name-only', '--diff-filter=U'], { cwd: wt, allowFail: true }).out);
  if (files.length) return { base, result: 'conflicts', commits, files };
  const abort = slotMerging(wt) ? slotGit(job.id, ['merge', '--abort'], { cwd: wt, slot }) : { ok: true };
  const undo = abort.ok ? '' : `; and the merge couldn't be undone (${lastLine(abort.out)}), so the slot is in the middle of it`;
  return { base, result: 'failed', commits, detail: `${lastLine(r.out)}${lockNote(r)}${undo}` };
}

// What TASK.md tells the worker about the merge and, on an engine whose sandbox can't write git, about git.
function gitNotes(job, merge, byHub) {
  const branch = `task/${job.id}`;
  let text = '';
  if (merge?.result === 'merged') text += `\n## The hub merged ${merge.base} into your branch\n\nBefore this attempt the hub merged ${merge.base} (${merge.commits} commit(s)) into ${branch}. It is done: don't merge it again.\n`;
  else if (merge?.result === 'up to date') text += `\n## ${merge.base} is in your branch already\n\n${branch} has everything ${merge.base} has: there is nothing to merge.\n`;
  else if (merge?.result === 'conflicts') {
    text +=
      `\n## Resolve the conflicts first: the hub merged ${merge.base} into your branch\n\n` +
      `The merge of ${merge.base} (${merge.commits} commit(s)) into ${branch} stopped at conflicts in:\n${merge.files.map((f) => `- ${f}`).join('\n')}\n\n` +
      `In each, keep what both sides meant and remove git's conflict markers (the lines that start with <<<<<<<, ======= and >>>>>>>). ` +
      (byHub
        ? "Don't run git: when you finish, the hub commits the merge together with your changes."
        : 'Then `git add` those files and `git commit` to finish the merge (or leave that to the hub, which commits it when you finish).') +
      ' If a conflict needs the orchestrator to decide, say so in your report and finish with `Status: BLOCKED`. Files that still have markers when you finish are not committed.\n';
  } else if (merge?.result === 'failed') text += `\n## The hub couldn't merge ${merge.base} into your branch\n\n${merge.detail}. Work on ${branch} as it is, and say in your report that ${merge.base} isn't merged in.\n`;
  if (byHub) {
    text +=
      `\n## Git: the hub does it for you\n\nYour engine's sandbox can't write git in this slot, so don't run git commands that write (add, commit, merge, rebase, ` +
      `stash, checkout, switch, reset, tag, branch): they fail. The hub commits your changes on ${branch} when you finish. Put the commit message ` +
      'in your report, on a line of its own: `Commit: <message>`. Git commands that only read (status, diff, log, show) are fine.\n';
  }
  return text;
}

// What TASK.md tells the worker of a task with a result file (FR-012), whatever the project's WORKER.md says: the result
// goes there, whole, and the report stays short.
const resultFileNotes = (job, byHub) =>
  job.resultFile
    ? `\n## Where your result goes\n\nWrite the result of this task, in full, to \`${job.resultFile}\` (make its folder if it isn't there) and ` +
      `${byHub ? 'leave it for the hub to commit' : 'commit it on your branch'}; it counts as a file you own. The hub checks that it is on task/${job.id} ` +
      `and isn't empty: without it the task fails. Keep RESULT.md short: what you did, that the result is in ${job.resultFile}, and what the orchestrator ` +
      'should know first. Put nothing of the result in the report alone.\n'
    : '';

// Fallbacks and engine switches (FR-008): tasks on another engine than the worker role's, and autopilot rounds
// on the orchestrator's fallback, with why. .nextlevel/switches.json keeps the last 50 for Home.
function addSwitch(entry) {
  try {
    const list = readJson(SWITCHES, []) || [];
    writeJson(SWITCHES, [...(Array.isArray(list) ? list : []), { at: now(), ...entry }].slice(-50));
  } catch (err) {
    log(`couldn't note the engine switch: ${err.message}`);
  }
}

// Starts a queued task in a free slot; false when none is free. On the worker role, a role whose engine can't
// start (not installed, its account, a model its login rejects: the checks engineProblem runs) hands the task
// to the role's fallback when that one can, and the job says so.
async function startTask(queuedJob) {
  const n = freeSlot();
  if (!n) return false;
  let profile = jobProfile(queuedJob);
  let why = queuedJob.why || (queuedJob.role === 'worker' ? ROLE_WHY : null);
  // A task on the worker role takes the role as it is now; its record says which engine that was
  let job = queuedJob.role === 'worker' ? { ...queuedJob, engine: profile.engine, profile: profile.name, account: profile.account } : queuedJob;
  if (queuedJob.role === 'worker') {
    const problem = await engineProblem(profile);
    const fb = problem && CFG.fallback('worker');
    // (never onto a worker that can't give what the task needs: it would only be held there)
    if (fb && !lacks(fb, queuedJob.needs || [], { config: CFG.config, platform: NEEDS_PLATFORM }).length && !(await engineProblem(fb))) {
      why = { how: 'auto-fallback', check: problem.check, text: `automatic fallback: the workers' ${describeProfile(profile)} can't start (${problem.check}: ${problem.text.split('\n')[0]})` };
      log(`${queuedJob.id}: ${why.text}; it runs on the fallback, ${describeProfile(fb)}`);
      profile = fb;
      job = { ...queuedJob, fellBack: true, engine: fb.engine, profile: fb.name || '', account: fb.account || '', model: fb.model || '', effort: fb.effort || '' };
    }
  }
  job = { ...job, why };
  const problem = accountProblem(profile); // the profile may have changed since the task was queued
  if (problem) throw new Error(problem);
  // Files a worker can't start without that are gone (an antivirus's quarantine, FR-013): dispatch waits
  const gone = toolFilesGone(profile);
  if (gone.length) {
    pauseDispatch(profile, gone);
    return false;
  }
  // Once the profile is final: a worker that can't give what the task needs (its "Needs:" line) never starts it. The task
  // waits in the queue and says why, the orchestrator gets one round, and a retry with --engine, --profile or --fallback
  // moves it; no attempt is spent (it never started)
  if (needsHold(job, profile)) return false;
  // On Antigravity, once the profile is final (an automatic fallback onto agy included) and its files are there: a passing
  // trial of what this worker runs first, else the task waits in the queue and says why (FR-022)
  const waits = agyGate({ ...profile, model: job.model || profile.model || '' });
  if (waits) {
    if (jobStatus(job.id)?.waiting !== waits) setStatus(job.id, { waiting: waits, waitingFor: 'agy' });
    return false;
  }
  reopenClosed(job.id); // (a closed task dispatched or retried is open again, FR-021)
  const wt = ensureSlot(n);
  if (!wt.startsWith(SLOTS_ROOT) || path.resolve(wt) === ROOT) throw new Error('refusing to reset a non-slot directory');
  lockSlot(wt);
  noGhLogin();
  const branch = `task/${job.id}`;
  for (let m = 1; m <= CFG.slots; m++) {
    const other = slotPath(m);
    if (m !== n && fs.existsSync(path.join(other, '.git')) && git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: other, allowFail: true }).out === branch) {
      git(['checkout', '--detach'], { cwd: other, allowFail: true });
    }
  }
  git(['reset', '--hard'], { cwd: wt });
  git(['clean', '-fd'], { cwd: wt });
  const existed = git(['rev-parse', '--verify', '--quiet', branch], { allowFail: true }).ok;
  if (existed) git(['checkout', branch], { cwd: wt });
  else git(['checkout', '-B', branch, CFG.base], { cwd: wt });

  const d = jobDir(job.id);
  mkdirp(d);
  // An engine whose sandbox can't write git gets the base branch merged in on every retry; any engine when
  // the feedback asks for it (FR-008)
  const byHub = gitByHub(profile, CFG.workerArgs(profile.engine));
  const merge = existed && job.attempt > 1 && (byHub || asksToMerge(job.feedback?.at(-1), CFG.base)) ? mergeBaseInto(wt, job, n) : null;
  if (merge && merge.result !== 'up to date') log(`${job.id}: ${mergeText(merge)}${merge.files ? ` (${merge.files.join(', ')}): the worker resolves them` : ''}`);
  // Where this attempt starts, after the hub's own merge of the base (FR-020): its own commits are the ones after it (a
  // merge that stopped at conflicts isn't committed yet, so the hub's commit of it counts as the attempt's)
  const startTip = git(['rev-parse', 'HEAD'], { cwd: wt, allowFail: true }).out || null;
  const taskDir = path.join(wt, TASK_DIR);
  mkdirp(taskDir);
  let spec = readText(path.join(TASKS, `${job.id}.md`));
  if (job.feedback?.length) {
    const prevResult = readText(path.join(d, 'RESULT.md'));
    spec += `\n\n## Feedback from the orchestrator (attempt ${job.attempt})\n\n${job.feedback.map((f, i) => `${i + 1}. ${f}`).join('\n')}\n`;
    if (prevResult) spec += `\n## Your previous report\n\n${prevResult}\n`;
  }
  spec += gitNotes(job, merge, byHub) + resultFileNotes(job, byHub);
  fs.writeFileSync(path.join(taskDir, 'TASK.md'), spec);
  fs.rmSync(path.join(taskDir, 'RESULT.md'), { force: true });
  fs.rmSync(path.join(taskDir, PROGRESS), { force: true }); // this attempt's progress notes start empty
  // git clean keeps ignored folders: drop task files an earlier run left under the other folder name
  for (const other of TASK_DIRS.filter((t) => t !== TASK_DIR)) fs.rmSync(path.join(wt, other), { recursive: true, force: true });
  writeJson(path.join(taskDir, 'JOB.json'), { id: job.id, attempt: job.attempt, slot: n, portOffset: portOffset(n), composeProject: composeName(n), gitByHub: byHub, base: CFG.base, merge });
  // What the worker runs with is the hub's to say: its process reads it here, never from a nextlevel.json the
  // orchestrator may have just changed (the guard sets such a change back at its next tick)
  const { name: pName = '', engine: pEngine, account: pAccount = '', model: pModel = '', effort: pEffort = '' } = profile;
  // (with the owner's own add-ons it may keep, workers.addons, FR-013)
  writeJson(path.join(d, 'job.json'), { ...job, gitByHub: byHub, resolved: { profile: { name: pName, engine: pEngine, account: pAccount, model: pModel, effort: pEffort }, args: CFG.workerArgs(profile.engine), addons: CFG.config.workers.addons, ...(profile.engine === 'agy' ? { version: agyVersionNow() } : {}) } });
  // The report is this attempt's or none: the one before goes aside (RESULT.attempt-<n>.md), else a new attempt
  // that wrote none showed it as its own, status line and all (FR-010: attempt 2's report for a failed attempt 3)
  archiveReport(d, jobStatus(job.id)?.logAttempt || job.attempt - 1);
  fs.rmSync(path.join(d, 'run.json'), { force: true });
  fs.rmSync(path.join(d, 'verify.log'), { force: true });
  fs.rmSync(path.join(d, 'unresolved.diff'), { force: true });
  fs.rmSync(path.join(QUEUE, `${job.id}.json`), { force: true });
  // The attempts of a task share worker.log: this one's output starts here (the dashboard shows only it). Its worker
  // writes it in every mode, a window of its own too (FR-010).
  const logFile = path.join(d, 'worker.log');
  const logFrom = fs.existsSync(logFile) ? fs.statSync(logFile).size : 0;
  // What it runs with, the engine's own choice included as far as its files say (the dashboard shows it)
  const used = jobModel(profile, CFG.config, { home: os.homedir() });
  const w = CFG.worker;
  // Which worker took it: the workers, the second worker (the task was sent to it: no engine switch), the fallback, or an
  // engine or profile asked for
  const worker = whichWorker(profile, why);
  const switched = worker !== 'second' && (profile.engine !== w.engine || (profile.name || '') !== (w.name || '') || ['fallback', 'auto-fallback'].includes(why?.how));
  setStatus(job.id, {
    state: 'running',
    worker,
    waiting: null,
    waitingFor: null,
    slot: n,
    startedAt: now(),
    reflogFrom: reflogEnds(), // (the main checkout's reflogs as it starts: workerOutside reads on from there)
    claimed: null,
    verify: null,
    error: null,
    detail: null,
    engine: profile.engine,
    profile: profile.name,
    ...used,
    engineWhy: why,
    switched,
    gitByHub: byHub,
    merge,
    logFrom,
    logAttempt: job.attempt,
    window: false, // (a job an older hub ran in a window has true: its output was there, not in worker.log)
    windowMode: launchMode(profile),
    notStarted: null,
    stoppedOutside: null,
    launch: null,
    reportFile: null, // this attempt's report, kept whole beside the job once it ends (FR-012)
    resultFile: job.resultFile || '',
    // this attempt's own end, once it has one (FR-020): its engine's, why a report is missing, its mark, its own work
    startTip,
    engineEnd: null,
    engineError: null,
    missing: null,
    mark: null,
    ownCommits: null,
    ownDiffStat: '',
    ownLost: null,
  });
  if (switched) addSwitch({ kind: 'task', id: job.id, attempt: job.attempt, engine: profile.engine, profile: profile.name || '', roleEngine: w.engine, how: why?.how || '', why: why?.text || '', check: why?.check || '' });

  // The worker process gets the project root through the environment: it runs in the slot, and the
  // tool's own location says nothing about the project.
  const env = { ...slotEnv(n, job.id), NEXTLEVEL_ROOT: ROOT };
  const how = launchWorker(n, job, profile, { wt, env });
  log(`started ${job.id} in slot w${n} (${describeProfile(profile)}, attempt ${job.attempt}; ${how})${why && !['role', 'spec'].includes(why.how) ? `: ${why.text}` : ''}`);
  return true;
}

// Every attempt's report, whole, beside the job: RESULT.attempt-<n>.md (n: the attempt that wrote it), from the moment
// the attempt ends (keepReport, FR-012); RESULT.md is the latest one's, for what reads the job folder. The name for a
// report: its own copy, else the first free one (an attempt that ran again, not counted, adds -2, -3...).
function reportCopy(d, attempt, text) {
  let to = path.join(d, `RESULT.attempt-${attempt || 0}.md`);
  for (let i = 2; fs.existsSync(to) && !fs.readFileSync(to).equals(text); i++) to = path.join(d, `RESULT.attempt-${attempt || 0}-${i}.md`);
  return to;
}
// -> the copy's file name, or '' when the attempt wrote no report
function keepReport(d, attempt) {
  const file = path.join(d, 'RESULT.md');
  if (!fs.existsSync(file)) return '';
  const text = fs.readFileSync(file);
  const to = reportCopy(d, attempt, text);
  if (!fs.existsSync(to)) fs.writeFileSync(to, text);
  return path.basename(to);
}
// Before a task's next attempt: RESULT.md goes (its copy stays), so a new attempt never shows the one before's as its
// own (FR-010). A report from before FR-012, with no copy yet, becomes one.
function archiveReport(d, attempt) {
  const file = path.join(d, 'RESULT.md');
  if (!fs.existsSync(file)) return;
  const to = reportCopy(d, attempt, fs.readFileSync(file));
  if (fs.existsSync(to)) fs.rmSync(file, { force: true });
  else fs.renameSync(file, to);
}

// How a worker's process shows (FR-010), by workers.window: 'console' (no window: an engine that needs a real
// console on Windows, agy's print mode, gets the console with no window its process has: lib/console.mjs), 'background'
// (no window: any other engine, and every worker elsewhere), 'minimized' or 'visible' (a window of its own, on Windows).
// Where the console with no window didn't start, what needs a console gets a window of its own (lib/console.mjs).
const launchMode = (profile) => (IS_WIN && CFG.window !== 'hidden' ? CFG.window : !needsConsole(profile.engine) ? 'background' : consoleBroken() ? 'visible' : 'console');
const LAUNCHED = { console: 'in a console with no window', background: 'in the background', minimized: 'in a minimized window', visible: 'in a window of its own' };
const windowed = (mode) => mode === 'minimized' || mode === 'visible';
// A worker's process writes run.json first thing; this long without one, it didn't start (a hub started again
// waits a little longer, so the hub that launched it can start it another way first)
const START_WAIT_MS = 45_000;
const noConsoleNote = (why) => `The console with no window didn't start on this PC (${why}), so this worker runs in a window of its own, the way it did before FR-010: a visible window beats a stuck task.`;
// A worker's or a round's process that found no console to give its engine ends with this, before it writes run.json
// (cycle.json): the hub then starts it in a window of its own (lib/console.mjs)
const NO_CONSOLE_EXIT = 3;
const endedBeforeStart = (code, signal) => (code === NO_CONSOLE_EXIT ? `its process found no console to give the engine (exit ${code})` : `its process ended before the worker started (exit ${code ?? signal})`);

// Starts a worker's process (_run) the way launchMode says, with nothing on the screen unless the owner asked for a
// window. In every mode the worker writes worker.log itself and its engine prints through pipes; an engine that needs
// a real console gets the console as its stdin, and never runs without one. No `cmd start` for background work: a new
// console Windows opens goes to Windows Terminal, which ignores hidden and minimized starts. Background work starts with
// CREATE_NO_WINDOW (lib/console.mjs), never through conhost.exe (FR-013). Each start has a token of its own: a process
// of a start the hub gave up on ends without doing anything (cmdRunTask). Returns how it started.
function launchWorker(n, job, profile, { wt, env }, mode = launchMode(profile), note = '') {
  // (the guard watches the main checkout while a worker runs, as while the orchestrator works: a protected file a worker
  // changes there, outside its slot, is set back and held; closed when the attempt ends, workerOutside)
  guardOpen(`worker:${job.id}`, `task ${job.id}'s worker`);
  const token = randomBytes(6).toString('hex');
  const remembered = mode === 'visible' && CFG.window === 'hidden' && needsConsole(profile.engine) && !note ? consoleBroken() : null;
  setStatus(job.id, { windowMode: mode, launch: { mode, token, at: now(), note: note || (remembered ? noConsoleNote(`${remembered.why}, ${ago((Date.now() - Date.parse(remembered.at)) / 3_600_000)}`) : '') } });
  const args = [BIN, '_run', job.id];
  const runEnv = { ...env, NEXTLEVEL_LAUNCH: token };
  let child;
  try {
    if (windowed(mode)) child = openWindow(`${NAME} worker w${n} - ${job.id}`, process.execPath, args, { cwd: wt, env: { ...runEnv, NEXTLEVEL_IN_WINDOW: mode }, minimized: mode === 'minimized' });
    else if (mode === 'console') child = startInConsole(process.execPath, args, { cwd: wt, env: runEnv });
    else {
      // stdio 'ignore' (no handle to inherit), so Windows gives it a console with no window of its own
      child = spawn(process.execPath, args, { cwd: wt, env: runEnv, detached: !IS_WIN, windowsHide: true, stdio: 'ignore' });
      child.unref();
    }
  } catch (err) {
    child = null;
    setImmediate(() => didntStart(n, job, profile, { wt, env }, { mode, token }, err.message));
  }
  watchStart(n, job, profile, { wt, env }, { child, mode, token });
  // Without a window the worker's process is the hub's own child: the hub hears the moment it ends (a window's `cmd
  // start` ends at once, so a worker in a window is looked after like one from an earlier hub run)
  if (child && !windowed(mode)) {
    holding.set(job.id, child);
    child.once('exit', () => {
      if (holding.get(job.id) === child) holding.delete(job.id);
      workerEnded(n, job.id, token, child.pid);
    });
  }
  return LAUNCHED[mode];
}

// A worker that didn't start is never left "running" (FR-010): a process of it that ended before run.json was
// there (exit 3: it found no console to give the engine), or no run.json after START_WAIT_MS, means it didn't start. A
// window's `cmd start` ends at once, so there only the time counts.
function watchStart(n, job, profile, launch, { child, mode, token }) {
  const runFile = path.join(jobDir(job.id), 'run.json');
  const settle = (why, noConsole = false) => {
    clearTimeout(timer);
    if (why && !fs.existsSync(runFile)) didntStart(n, job, profile, launch, { mode, token }, why, noConsole);
  };
  const timer = setTimeout(() => settle(`no sign of the worker ${START_WAIT_MS / 1000} s after it was started`), START_WAIT_MS);
  timer.unref();
  child?.on('error', (err) => settle(err.message));
  if (!windowed(mode)) child?.on('exit', (code, signal) => settle(fs.existsSync(runFile) ? '' : endedBeforeStart(code, signal), code === NO_CONSOLE_EXIT));
}

// A worker's process that found no console to give its engine (the console with no window doesn't start on this PC) is
// remembered for this PC and the same attempt starts again in a window of its own; any other start that failed ends the
// attempt as a setup problem, not the task's (it ran nothing, and a retry is the same attempt again). Only for the start
// that is still the job's: a later one, or a finished job, is left alone.
function didntStart(n, job, profile, launch, { mode, token }, why, noConsole = false) {
  const s = jobStatus(job.id);
  if (s?.state !== 'running' || s.launch?.token !== token || fs.existsSync(path.join(jobDir(job.id), 'run.json'))) return;
  if (mode === 'console' && noConsole) {
    rememberConsoleFailure(why);
    log(`${job.id}: the console with no window didn't start (${why}); it starts again in a window of its own`);
    launchWorker(n, job, profile, launch, 'visible', noConsoleNote(why));
    return;
  }
  workerNotStarted(job.id, why);
}
function workerNotStarted(id, why) {
  guardClose(`worker:${id}`); // (it ran nothing: the guard's watch for it ends)
  const s = jobStatus(id);
  setStatus(id, {
    state: 'error',
    notStarted: true,
    error: `the worker didn't start: ${why}. A setup problem on this PC, not the task's: nothing ran, and \`nextlevel retry ${id}\` runs attempt ${s?.attempt || 1} again`,
    finishedAt: now(),
    acked: false,
  });
  addAttempt(id); // (kept, not counted: FR-020)
  log(`${id}: the worker didn't start: ${why}`);
  jobEnded(id);
}

// Runs a command with its output appended to logFile; resolves with its exit code and what it printed.
// With `shell`, `command` is a shell command line (verify); without, a program and its arguments, which no
// shell sees (a commit message can hold any character).
// Its output comes through pipes the hub writes to the log: a child given the log's handle instead would get a
// console window of its own on Windows when the hub has none (FR-010).
async function runLogged(command, args, { cwd, env = process.env, logFile, timeoutMin, shell = false }) {
  fs.appendFileSync(logFile, `\n$ ${[command, ...args].join(' ')}\n`);
  const from = fs.statSync(logFile).size;
  const out = fs.openSync(logFile, 'a');
  const child = spawn(command, args, { cwd, env, shell, windowsHide: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
  let timedOut = false;
  const t = setTimeout(() => {
    timedOut = true;
    killTree(child.pid);
  }, timeoutMin * 60_000);
  const code = await childDone(child, (d) => {
    try {
      fs.writeSync(out, d);
    } catch {
      // the log must never stop the hub
    }
  });
  clearTimeout(t);
  fs.closeSync(out);
  const printed = fs.readFileSync(logFile).subarray(from).toString('utf8'); // `from` counts bytes
  fs.appendFileSync(logFile, `[exit ${code}${timedOut ? ', timed out' : ''}]\n`);
  return { code, timedOut, out: printed };
}

// A child's exit code once it has ended and what it printed (stdout and stderr, as they come, to `onData`) is in. A
// program it left running (a server a command started) may hold the pipes open: 5 s after the child itself ends,
// what it printed is taken as all. -1 when it couldn't start (its error goes to onData).
function childDone(child, onData) {
  child.stdout?.on('data', (d) => onData(d, 'out'));
  child.stderr?.on('data', (d) => onData(d, 'err'));
  return new Promise((resolve) => {
    let code = null;
    let settled = false;
    let grace = null;
    const done = () => {
      if (settled) return;
      settled = true;
      clearTimeout(grace);
      resolve(code ?? -1);
    };
    child.on('exit', (c) => {
      code = c ?? -1;
      grace = setTimeout(done, 5000);
    });
    child.on('close', (c) => {
      code ??= c ?? -1;
      done();
    });
    child.on('error', (err) => {
      onData(`${err.message}\n`);
      code = -1;
      done();
    });
  });
}
const runShell = (command, opts) => runLogged(command, [], { ...opts, shell: true });

// Git's conflict markers left in a file of the slot.
function hasMarkers(file) {
  try {
    return fs.statSync(file).size <= 8 * 1024 * 1024 && hasConflictMarkers(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
}

// The hub's commit of what a worker left (FR-008): the message the worker put in its report ("Commit: ..."),
// else the task's title, and a line saying who committed. An engine that can write git gets the old one.
const workerCommitLine = (report) => (report.match(/^\W{0,4}Commit\W{0,4}:\s*(.+)$/im) || [])[1]?.replace(/[`*]+/g, '').trim() || '';
function hubCommitMessage(id, job, report, byHub) {
  if (!byHub) return `chore(${id}): commit changes the worker left uncommitted [hub]`;
  const first = workerCommitLine(report) || `${id}: ${taskTitle(readText(path.join(TASKS, `${id}.md`)), id)}`;
  return `${first}\n\nCommitted by the nextlevel hub for the worker (${engineTitle(job.engine)}, attempt ${job.attempt || 1}): its sandbox can't write git.\n`;
}

// What a worker left that the hub couldn't commit, copied to .nextlevel/jobs/<id>/left/attempt-<n>/ under the same paths
// before anything resets the slot: files as they are, links and deleted files listed (a link isn't followed, so
// nothing outside the slot is copied). -> the sentence that says where it is.
function keepLeftovers(wt, d, attempt = 1) {
  if (!wt || !fs.existsSync(wt)) return '';
  const found = [['ls-files', '-z', '--modified', '--others', '--exclude-standard'], ['diff', '--cached', '--name-only', '-z']].map((args) => git(args, { cwd: wt, allowFail: true }));
  if (found.some((r) => !r.ok)) return `Its changes are still in slot ${path.basename(wt)}, uncommitted: nextlevel couldn't list them to keep a copy.`;
  const files = [...new Set(found.flatMap((r) => r.out.split('\0').filter(Boolean)))];
  if (!files.length) return 'Nothing is left uncommitted in the slot.';
  const dest = path.join(d, 'left', `attempt-${attempt}`); // a task's attempts share its folder
  const slotReal = fs.realpathSync(wt);
  const notes = [];
  let copied = 0;
  for (const f of files) {
    const from = path.join(wt, f);
    const to = path.resolve(dest, f);
    if (!to.startsWith(dest + path.sep)) continue;
    try {
      const st = fs.lstatSync(from);
      if (st.isSymbolicLink()) notes.push(`link: ${f} -> ${fs.readlinkSync(from)}`);
      // a folder on the way may be a link out of the slot: only what really is in the slot is copied
      else if (!fs.realpathSync(from).startsWith(slotReal + path.sep)) notes.push(`outside the slot: ${f}`);
      else if (st.isFile()) {
        mkdirp(path.dirname(to));
        fs.copyFileSync(from, to);
        copied++;
      } else notes.push(`not a file: ${f}`);
    } catch {
      notes.push(`deleted: ${f}`);
    }
  }
  if (notes.length) {
    mkdirp(dest);
    fs.writeFileSync(path.join(dest, 'NOT-COPIED.txt'), `${notes.join('\n')}\n`);
  }
  log(`kept ${copied} uncommitted file(s) from slot ${path.basename(wt)} in ${rel(dest)}`);
  return `Its changes are kept in ${rel(dest)} (${copied} file(s)${notes.length ? `; NOT-COPIED.txt lists ${notes.length} more` : ''}).`;
}

// A task's result file as git has it (FR-012): on task/<id>, else (merged, its branch cleaned up) on the base branch.
// { text, where } or null. Read whole: a design runs to tens of KB.
function resultFileText(id, file, refs = [`task/${id}`, CFG.base]) {
  for (const ref of refs) {
    const spec = `${ref}:${file}`;
    if (git(['cat-file', '-t', spec], { allowFail: true }).out !== 'blob') continue;
    const r = spawnSync('git', ['cat-file', 'blob', spec], { cwd: ROOT, env: readEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.status === 0) return { text: r.stdout, where: ref };
  }
  return null;
}
// The hub's own part of a task's verify when its spec names a result file: the file is on the task's branch, committed,
// and not empty. Logged in verify.log like the spec's commands. -> '' or what is wrong, in words.
function checkResultFile(id, file, logFile) {
  const branch = `task/${id}`;
  fs.appendFileSync(logFile, `\n$ (nextlevel) the result file ${file} on ${branch}\n`);
  const type = git(['cat-file', '-t', `${branch}:${file}`], { allowFail: true }).out;
  const found = type === 'blob' ? resultFileText(id, file, [branch]) : null;
  const problem =
    type === 'tree'
      ? `the result file ${file} is a folder on ${branch}: the spec names one file`
      : !found
        ? `the result file ${file} isn't on ${branch}: the worker didn't write it there, or it wasn't committed`
        : !found.text.trim()
          ? `the result file ${file} on ${branch} is empty`
          : '';
  fs.appendFileSync(logFile, `${problem || `${file}: ${sizeText(sizeOf(found.text))}`}\n[${problem ? 'fail' : 'ok'}]\n`);
  return problem;
}

// ---------- an attempt's own work, and its history (FR-020) ----------
// On a real project, a task's attempt 10 made one commit, wrote no report and ended "done · verify pass · worker says MISSING · 18
// commit(s)": 16 of them earlier attempts'. An attempt's own commits are those on the task branch after where it
// started (status.startTip: the branch's tip after the hub's merge of the base, just before the worker started), not on
// the base. -> { count, commits (oneline, the newest 20), diffStat, tip } or { lost: true, tip } (that tip is no longer on
// the branch), or null (an attempt an older hub started: no start recorded).
function attemptOwn(id, tip) {
  // (a commit id and nothing else: status.json is a file in the project, and this goes on git's command line, where a
  // value like --output=<file> would be an option)
  if (typeof tip !== 'string' || !/^[0-9a-f]{7,64}$/i.test(tip)) return null;
  const branch = `task/${id}`;
  const short = tip.slice(0, 8);
  if (!git(['merge-base', '--is-ancestor', tip, branch], { allowFail: true }).ok) return { lost: true, tip: short };
  const list = lines(git(['log', '--oneline', branch, `^${tip}`, `^${CFG.base}`], { allowFail: true }).out);
  return { count: list.length, commits: list.slice(0, 20), diffStat: list.length ? git(['diff', '--stat', tip, branch], { allowFail: true }).out : '', tip: short };
}
// "2 commits this attempt, 7 in all" (or the branch's alone, for an attempt an older hub started)
function commitsText(s) {
  if (s.commits === undefined || s.commits === null) return '';
  if (s.ownLost) return `${s.commits} commit(s) in all (where this attempt started, ${s.ownLost}, is no longer on the branch)`;
  if (s.ownCommits === null || s.ownCommits === undefined) return `${s.commits} commit(s)`;
  return `${s.ownCommits} commit(s) this attempt, ${s.commits} in all`;
}
// An engine's own end in words (FR-020): "success after 85 turn(s); its last words: "..."; 2 background command(s) still
// running were stopped when it ended". '' for none.
function endWords(e) {
  if (!e || typeof e !== 'object') return '';
  const bits = [];
  if (e.status) bits.push(e.turns != null ? `${e.status} after ${e.turns} turn(s)` : String(e.status));
  else if (e.turns != null) bits.push(`${e.turns} turn(s)`);
  if (e.error && e.reason && e.reason !== e.status) bits.push(String(e.reason));
  if (!e.error && e.said) bits.push(`its last words: "${cutTo(String(e.said), 200)}"`);
  if (e.stopped) bits.push(`${e.stopped} background command(s) still running were stopped when it ended`);
  return bits.join('; ');
}
// Each attempt's end, kept in status.json's `attempts` (a field, not a file: the file protocol stays): the attempt, its
// engine and model, how it ended, its own commits, why its report is missing and its engine's end. A run stopped from
// outside or that didn't start is kept too, and isn't counted (its retry is the same attempt).
function attemptEntry(s) {
  const e = s.engineEnd && typeof s.engineEnd === 'object' ? s.engineEnd : null;
  return {
    attempt: s.attempt || 1,
    engine: s.engine || '',
    model: s.model || '',
    state: s.state,
    verify: s.verify || null,
    claimed: s.claimed || null,
    exitCode: s.exitCode ?? null,
    ownCommits: s.ownCommits ?? null,
    commits: s.commits ?? null,
    missing: s.missing || null,
    mark: s.mark || null,
    end: e ? { status: e.status || '', error: !!e.error, reason: e.reason || '', turns: e.turns ?? null, stopped: e.stopped || 0, code: e.code ?? null } : null,
    notCounted: s.stoppedOutside ? 'stopped from outside' : s.notStarted ? 'not started' : null,
    tokens: s.tokens && typeof s.tokens === 'object' ? s.tokens : null, // (its engine's report, the usage ledger's parts)
    finishedAt: s.finishedAt || now(),
  };
}
function addAttempt(id) {
  const s = jobStatus(id);
  if (!s) return;
  setStatus(id, { attempts: [...(Array.isArray(s.attempts) ? s.attempts : []), attemptEntry(s)].slice(-50) });
}

// `extra`: more of the attempt's end, written with its state in one write (a task stopped from outside says so with it)
async function finishTask(id, reason = '', extra = {}) {
  guardClose(`worker:${id}`); // (its worker ended: the guard's watch for it ends before its work is checked)
  const s = jobStatus(id);
  const d = jobDir(id);
  const job = readJson(path.join(d, 'job.json')) || {};
  const run = readJson(path.join(d, 'run.json')) || {};
  const wt = slotPath(s.slot);
  setStatus(id, { state: 'verifying' });
  // The report is where the prompt said; a worker following an older WORKER.md may use the other name.
  const resultSrc = [TASK_DIR, ...TASK_DIRS].map((t) => path.join(wt, t, 'RESULT.md')).find((f) => fs.existsSync(f));
  if (resultSrc) fs.copyFileSync(resultSrc, path.join(d, 'RESULT.md'));
  else fs.rmSync(path.join(d, 'RESULT.md'), { force: true }); // never an earlier attempt's (FR-010)
  const reportFile = keepReport(d, job.attempt || 1); // whole, per attempt (FR-012)
  // Its progress notes stay beside the job (the slot goes to the next task); none from this attempt: none kept
  const notesSrc = [TASK_DIR, ...TASK_DIRS].map((t) => path.join(wt, t, PROGRESS)).find((f) => fs.existsSync(f));
  if (notesSrc) fs.copyFileSync(notesSrc, path.join(d, PROGRESS));
  else fs.rmSync(path.join(d, PROGRESS), { force: true });
  const report = readText(path.join(d, 'RESULT.md'));
  const claimed = (report.match(/status\W{0,6}(DONE|PARTIAL|BLOCKED)/i) || [])[1]?.toUpperCase() || 'MISSING';
  // What the worker left: the hub commits it (FR-008: an engine whose sandbox can't write git leaves all of
  // it). A merge of the base branch that stopped at conflicts is committed only once no file has markers.
  const byHub = s.gitByHub ?? job.gitByHub ?? false;
  const slotRun = (args) => slotGit(id, args, { cwd: wt, slot: s.slot });
  let gitProblem = '';
  let merge = s.merge || null;
  let hubCommit = null;
  const messageFile = path.join(d, 'message.txt');
  // Every step's exit code counts: a change the hub can't commit is never passed over. It fails the attempt, says
  // which step and why, and the files are copied beside the job first (the slot is reset for its next task).
  const failed = (what, r) => `the hub couldn't ${what}: ${lastLine(r.out)}${lockNote(r)} (see git.log). ${keepLeftovers(wt, d, job.attempt || 1)}`;
  // Stages everything, then commits it with the message in messageFile: null, or what failed
  let slotHeld = '';
  const stageAndCommit = (what) => {
    const add = slotRun(['add', '-A']);
    if (!add.ok) return failed(`stage ${what}`, add);
    // a .env file, or a value from .env, is never committed: it is held for the owner, and out of the slot
    const secret = holdSlotSecrets(id, job, wt, s.slot);
    if (secret.error) return failed(`take ${secret.what} (a value from .env) out of the commit`, secret.error);
    slotHeld = secret.detail;
    if (slotHeld && git(['diff', '--cached', '--quiet'], { cwd: wt, allowFail: true }).ok) return null; // nothing else to commit
    const c = slotRun(['commit', '-q', '-F', messageFile]);
    if (!c.ok) return failed(`commit ${what}`, c);
    hubCommit = git(['rev-parse', '--short', 'HEAD'], { cwd: wt, allowFail: true }).out;
    return null;
  };
  if (fs.existsSync(wt) && slotMerging(wt)) {
    const files = [...new Set([...(merge?.files || []), ...lines(git(['diff', '--name-only', '--diff-filter=U'], { cwd: wt, allowFail: true }).out)])];
    const left = files.filter((f) => hasMarkers(path.join(wt, f)));
    if (left.length) {
      // Nothing with markers is committed: the worker's changes (new files too) are kept beside the job as a
      // diff against the task branch, and the slot goes back to it. Only once the diff has them.
      const markers = `conflict markers are still in ${left.join(', ')} after the merge of ${CFG.base}: nothing was committed`;
      const add = slotRun(['add', '-A']);
      const diff = add.ok ? git(['diff', '--cached', '--binary', 'HEAD'], { cwd: wt, allowFail: true }) : null;
      if (!add.ok) gitProblem = `${markers}, and ${failed("stage the worker's changes to keep them", add)}`;
      else if (!diff.ok) gitProblem = `${markers}, and ${failed("write the worker's changes down", { ...diff, out: diff.err || diff.out })}`;
      else {
        fs.writeFileSync(path.join(d, 'unresolved.diff'), diff.out);
        const reset = slotRun(['reset', '--hard', '-q']);
        gitProblem = `${markers} (the worker's changes are in ${rel(path.join(d, 'unresolved.diff'))})${reset.ok ? '' : `; the slot couldn't be reset: ${lastLine(reset.out)}${lockNote(reset)}`}`;
      }
      merge = merge && { ...merge, resolved: false };
    } else {
      const first = `Merge ${CFG.base} into task/${id}; conflicts resolved by the worker (attempt ${job.attempt || 1})`;
      const asked = workerCommitLine(report);
      fs.writeFileSync(messageFile, `${first}\n${asked ? `\n${asked}\n` : ''}\nCommitted by the nextlevel hub.\n`);
      gitProblem = stageAndCommit(`the merge of ${CFG.base}`) || '';
      merge = merge && { ...merge, resolved: !gitProblem };
    }
  } else if (fs.existsSync(wt)) {
    const status = git(['status', '--porcelain'], { cwd: wt, allowFail: true });
    if (!status.ok) gitProblem = failed('tell what the worker left (git status)', { ...status, out: status.err || status.out });
    else if (status.out) {
      fs.writeFileSync(messageFile, hubCommitMessage(id, job, report, byHub));
      gitProblem = stageAndCommit("the worker's changes") || '';
    }
  }
  // After a commit of the hub's, nothing may be left behind in the slot
  if (hubCommit && !gitProblem) {
    const after = git(['status', '--porcelain'], { cwd: wt, allowFail: true });
    if (!after.ok || after.out) gitProblem = `the hub committed ${hubCommit}, but the slot still has changes it didn't commit (${lines(after.out).slice(0, 5).join(', ') || lastLine(after.err)}). ${keepLeftovers(wt, d, job.attempt || 1)}`;
  }
  if (slotHeld && !gitProblem) gitProblem = slotHeld;
  const branch = `task/${id}`;
  // A worker that can write git may have committed the merge itself: never with markers left in it
  if (!gitProblem && merge?.files?.length) {
    const marked = merge.files.filter((f) => hasConflictMarkers(git(['show', `${branch}:${f}`], { allowFail: true }).out));
    if (marked.length) {
      gitProblem = `${branch} still has conflict markers in ${marked.join(', ')} from the merge of ${CFG.base}: resolve them before it is merged`;
      merge = { ...merge, resolved: false };
    } else if (merge.resolved === undefined) merge = { ...merge, resolved: true };
  }
  const commits = git(['log', '--oneline', `${CFG.base}..${branch}`], { allowFail: true }).out.split('\n').filter(Boolean);
  const diffStat = git(['diff', '--stat', `${CFG.base}...${branch}`], { allowFail: true }).out;
  // This attempt's own work (FR-020): `commits` counts the whole branch, every attempt's
  const own = attemptOwn(id, s.startTip);
  let verify = 'skipped';
  let resultProblem = '';
  const resultFile = job.resultFile || '';
  if ((job.verify?.length || resultFile) && !run.timedOut && claimed !== 'BLOCKED' && !reason && !gitProblem) {
    verify = 'pass';
    const logFile = path.join(d, 'verify.log');
    for (const cmd of job.verify || []) {
      const r = await runShell(cmd, { cwd: wt, env: slotEnv(s.slot, id), logFile, timeoutMin: CFG.checkTimeoutMin });
      if (r.code !== 0) {
        verify = r.timedOut ? 'timeout' : 'fail';
        break;
      }
    }
    // A design, research or map task's result file: on its branch, committed, and not empty (FR-012)
    if (verify === 'pass' && resultFile) {
      resultProblem = checkResultFile(id, resultFile, logFile);
      if (resultProblem) verify = 'fail';
    }
  }
  // The slot lets go of the branch (the orchestrator merges it, another slot may take it); if it can't, the next
  // task that wants the branch detaches it first
  const detach = git(['checkout', '--detach'], { cwd: wt, allowFail: true });
  if (!detach.ok) log(`${id}: slot w${s.slot} couldn't let go of ${branch}: ${lastLine(detach.err || detach.out)}${lockNote(detach)}`);
  // How its engine ended, by its own account (FR-020; FR-022 for agy): its status, an error of its own, its turns, its
  // last answer and lines, redacted. None for a run stopped from outside or at the time limit, or one with no run.json.
  const title = engineTitle(s.engine);
  const ended = !reason && !run.timedOut && run.exitCode !== undefined;
  const end = ended ? engineEndOf(s.engine, attemptLog(id, s), run.exitCode ?? null) : null;
  // An engine that says it failed fails the attempt, whatever its exit code and its report (Claude's error subtypes,
  // agy's ERROR, Codex's failed turn)
  const endError = !!end?.error;
  // A worker that stopped with an exit code other than 0 before it wrote a report (agy refusing a flag, say): the
  // attempt failed, and says what its engine printed last; the whole of it is this attempt's part of worker.log
  // (FR-010), in its engine's own words where it says them (FR-022: agy's reason, not just "ERROR")
  const stopped = !resultSrc && ended && run.exitCode !== 0;
  // Why there is no report, in every place the attempt shows (FR-020); a file with no Status line is still a report
  const missing =
    claimed !== 'MISSING'
      ? null
      : resultSrc
        ? 'its report has no Status line'
        : reason === 'stopped'
          ? "its worker's processes vanished (stopped from outside)"
          : run.timedOut
            ? `the time limit (${job.timeoutMin || CFG.taskTimeoutMin} min) stopped it first`
            : endError
              ? `${title} ended with an error: ${end.reason || end.status}${end.turns != null ? ` (${end.turns} turn(s))` : ''}`
              : stopped
                ? `the worker stopped (exit ${run.exitCode ?? 'unknown'}) before it wrote a report${end?.reason ? `: ${title} said: ${end.reason}` : run.error ? `: ${run.error}` : run.lastLine ? `; it printed last: ${run.lastLine}` : ''}`
                : ended
                  ? `${title} ended without writing it${endWords(end) ? ` (${endWords(end)})` : ''}`
                  : 'no report was written';
  // Finished without a report (FR-020): the engine ended normally, and the attempt's own work passed the hub's checks.
  // Only with its own commits (an earlier attempt's passing work isn't this one's), and for a design, research or map
  // task only when those changed its result file. A review's result is its report: without one, it fails.
  const noReport = !resultSrc && !reason && !run.timedOut && !gitProblem && !endError && !stopped;
  const ownCount = own && !own.lost ? own.count : null;
  const resultChanged = !resultFile || (ownCount !== null && ownCount > 0 && !!git(['diff', '--name-only', s.startTip, branch, '--', resultFile], { allowFail: true }).out);
  let state;
  let mark = null;
  if (reason) state = reason;
  else if (run.timedOut) state = 'timeout';
  else if (claimed === 'BLOCKED') state = 'blocked';
  else if (gitProblem) state = 'failed';
  else if (endError) state = 'failed';
  else if (stopped) state = 'failed'; // (an earlier attempt's commits and their passing checks aren't this attempt's work)
  else if (noReport && ownCount !== null) {
    // (an attempt an older hub started has no start recorded: it is judged as before, below)
    if (job.kind === 'review') state = 'failed';
    else if (ownCount === 0) state = 'no-changes';
    else if (verify === 'fail' || verify === 'timeout') state = 'failed';
    else if (!resultChanged) state = 'failed';
    else [state, mark] = ['done', verify === 'pass' ? 'verify passed' : 'nothing verified'];
  } else if (claimed === 'MISSING' && ownCount === 0) state = 'no-changes'; // (a report with no Status line, no work of its own)
  else if (job.kind === 'code' && commits.length === 0) state = 'no-changes';
  else if (verify === 'fail' || verify === 'timeout') state = 'failed';
  else if (job.kind !== 'code' && claimed !== 'DONE') state = 'failed';
  else state = 'done';
  const exact = run.startedAt ? (Date.parse(run.endedAt || now()) - Date.parse(run.startedAt)) / 60000 : null;
  const minutes = exact === null ? null : Math.round(exact);
  // (the engine's words for a failure: the hub log's line, and `nextlevel result`'s section; FR-022)
  const failure = state !== 'done' && end && (endError || (ended && run.exitCode !== 0)) ? end : null;
  const resultNote = noReport && resultFile && ownCount > 0 && !resultChanged && state === 'failed' ? `this attempt's commits didn't change its result file ${resultFile}` : '';
  const reviewNote = noReport && job.kind === 'review' && state === 'failed' ? "a review's result is its report, and there is none" : '';
  const detail = gitProblem || resultProblem || resultNote || reviewNote || (endError && !missing ? `${title} ended with an error: ${end.reason || end.status} (exit ${end.code ?? 'unknown'})` : '');
  const ownFields = { ownCommits: ownCount, ownDiffStat: own && !own.lost ? own.diffStat : '', ownLost: own?.lost ? own.tip : null };
  workerOutside(id, s, wt, job.attempt || 1); // (what it did outside its slot: before the attempt reads as ended)
  // its tokens where its engine printed them (FR-008): in the attempt's entry (the usage ledger's per task) and the day's numbers
  const eng = adapterOf(s.engine);
  const tokens = eng ? eng.tokens(attemptLog(id, s)) : null;
  setStatus(id, { state, verify, claimed, exitCode: run.exitCode ?? null, commits: commits.length, diffStat, minutes, finishedAt: now(), acked: false, merge, hubCommit, reportFile: reportFile || null, engineEnd: end, engineError: failure, missing, mark, tokens: tokens ? tokensOf(tokens) : null, ...ownFields, ...(detail ? { detail } : {}), ...extra });
  addAttempt(id);
  if (failure) log(`${id}: ${failureLine(title, failure)}`);
  // The day's numbers and the usage ledger: this attempt's minutes and tokens, with who ran it and how it ended
  const t = jobStatus(id) || {};
  addUsage('worker', s.engine || 'unknown', {
    runs: 1,
    minutes: exact || 0,
    tokens,
    at: ledgerEnd(run.endedAt),
    start: isoOr(run.startedAt) || undefined,
    model: s.model,
    effort: s.effort,
    profile: s.profile,
    worker: s.worker,
    task: id,
    attempt: job.attempt || 1,
    slot: s.slot,
    end: t.state,
    notCounted: t.stoppedOutside ? 'stopped from outside' : '',
  });
  log(`finished ${id}: ${summary(jobStatus(id))}`);
  jobEnded(id); // a task attempt that ended, any way, starts a round (FR-019)
}

// ---------- a worker stopped from outside, tool files gone (FR-013) ----------
// On a real PC an antivirus judged a worker's behaviour malicious, killed its whole chain and quarantined files of
// the tools in it. A worker whose processes are all gone without a report was stopped from outside: what it left is
// kept like any worker's (committed on its branch, or copied beside the job), the attempt isn't counted (its retry is
// the same attempt), and Home and the phone say that an antivirus is a likely cause and what to check. One that wrote
// its report before it went is finished as usual.
const ANTIVIRUS_STEPS = "Look at your antivirus's notifications and quarantine (Bitdefender: Protection > Antivirus > Quarantine, and Advanced Threat Defense's list of blocked applications), restore what it took, and make one narrow exception for the worker's engine (docs/ANTIVIRUS.md says which). nextlevel doctor lists tool files that are missing.";
const stoppedText = (id, windowed) =>
  `stopped from outside: its worker's processes are gone and it left no report${windowed ? ' (or its window was closed)' : ''}. An antivirus is a likely cause. ${ANTIVIRUS_STEPS} It doesn't count as an attempt: nextlevel retry ${id} runs it again`;
// ---------- what a worker did outside its slot (17 October) ----------
// An Antigravity worker's file tool wrote C:\Users\User\nextlevel-task\PROGRESS.md, a path it typed wrong, outside its
// slot: a worker runs as the owner's Windows user, and nothing stops a file tool or a `git -C` aimed elsewhere (FR-017
// part 2B would). So the hub says it: after each attempt, the files its log says it wrote outside its slot and the
// commands it aimed at another folder (lib/slotwatch.mjs, by pattern), and the main checkout's HEAD and base branch moved
// while it ran by anything but the hub (git's reflog: the hub's own moves say HUB_REFLOG). A Home card with Seen, and one
// phone message per attempt. While it runs the guard watches the main checkout too (launchWorker): a protected file
// changed there is set back and held.
const HUB_REFLOG = 'nextlevel-hub';
// The folders a worker may write in besides its slot: the system's temporary folder, and agy's own notes for its session
const workerAllowed = () => [os.tmpdir(), path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'), path.join(os.homedir(), '.gemini', 'antigravity-cli', 'scratch')];
// The main checkout's HEAD and base branch moved while a worker ran, by anything but the hub: [{ key, file, pos (where
// in which reflog), text: 'the main checkout: commit: msg' }]. From git's own reflog files, read on from where they
// ended as the attempt started (`reflogFrom`, reflogEnds): a reflog's times are whole seconds, too coarse to tell a move
// from the attempt's start. An attempt an older hub started has none: nothing is said for it.
const reflogFiles = () => [
  ['the main checkout', path.join(commonDir(), 'logs', 'HEAD')],
  [CFG.base, path.join(commonDir(), 'logs', 'refs', 'heads', ...CFG.base.split('/'))],
];
const reflogEnds = () => {
  try {
    return reflogFiles().map(([, f]) => fs.statSync(f, { throwIfNoEntry: false })?.size ?? 0);
  } catch {
    return null;
  }
};
function foreignMoves(from) {
  if (!Array.isArray(from)) return [];
  const out = [];
  reflogFiles().forEach(([label, file], i) => {
    const at0 = Number(from[i]) || 0;
    let fd;
    let text = '';
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= at0) return; // (nothing new; or git rewrote it, reflog expire: nothing can be told)
      const buf = Buffer.alloc(Math.min(size - at0, 1024 * 1024));
      fs.readSync(fd, buf, 0, buf.length, at0);
      text = buf.toString('utf8');
    } catch {
      return; // (no reflog: nothing moved it, or reflogs are off)
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
    // (each line: <old> <new> <name> <email> <seconds> <zone>\t<message>)
    let off = at0;
    for (const line of text.split('\n')) {
      const pos = off;
      off += Buffer.byteLength(line) + 1;
      const m = line.match(/^[0-9a-f]+ ([0-9a-f]+) .*> (\d+) [+-]\d{4}\t(.*)$/);
      if (!m || m[3].startsWith(HUB_REFLOG)) continue;
      const said = `${label}: ${m[3].replace(/\s+/g, ' ').trim()}`;
      if (!out.some((x) => x.text === said)) out.push({ key: `${label}:${m[1]}:${m[2]}`, file: i, pos, text: said });
    }
  });
  return out;
}
// The other tasks whose worker ran when the main checkout moved (`m`, from foreignMoves): where each one's attempt started
// and ended in the same reflog (reflogFrom, reflogTo) says it; a move can't be told to one of them
const workersAt = (m, id) =>
  allJobs()
    .filter((j) => j.type === 'task' && j.id !== id && Array.isArray(j.reflogFrom) && Number(j.reflogFrom[m.file]) <= m.pos && (['running', 'verifying'].includes(j.state) || Number(j.reflogTo?.[m.file]) > m.pos))
    .map((j) => j.id);
function workerOutside(id, s, wt, attempt) {
  let found = [];
  let moves = [];
  try {
    found = outsideSlot(attemptLog(id, s, 32 * 1024 * 1024), { slot: wt, allowed: workerAllowed(), never: [ROOT, SLOTS_ROOT] });
    // (each move is said once: workers that ran together each see it, and the first attempt to end says it, naming the
    // others that ran then)
    const told = getSettings().slotEscapeMoves;
    const seen = new Set(Array.isArray(told) ? told : []);
    setStatus(id, { reflogTo: reflogEnds() }); // (where its attempt ended in them: workersAt, for workers that ran beside it)
    moves = foreignMoves(s.reflogFrom).filter((m) => !seen.has(m.key));
    if (moves.length) setSetting('slotEscapeMoves', [...seen, ...moves.map((m) => m.key)].slice(-200));
  } catch (err) {
    log(`${id}: couldn't read what its worker did outside its slot: ${err.message}`);
    return;
  }
  if (!found.length && !moves.length) return;
  const secrets = activitySecrets();
  const clean = (t) => redactReport(String(t), { values: secrets.values, names: secrets.names });
  const items = found.slice(0, 10).map((x) => ({ ...x, what: shorten(clean(x.what)), ...(x.aims ? { aims: shorten(clean(x.aims)) } : {}) }));
  const moved = moves.slice(0, 5).map((m) => shorten(clean(m.text)));
  const others = moved.length ? [...new Set(moves.flatMap((m) => workersAt(m, id)))] : [];
  const also = others.length ? ` (and while ${others.length === 1 ? `task ${others[0]}'s worker` : `the workers of tasks ${others.join(', ')}`} ran)` : '';
  const words = [items.length ? outsideWords(items) : '', moved.length ? `while it ran${also}, ${moved.join('; ')}, not by the hub` : ''].filter(Boolean).join('; ');
  setStatus(id, { outside: { attempt, items, moves: moved, ...(others.length ? { others } : {}) } });
  // (a finding of moves alone never takes the place of an unseen card about files or commands)
  const shown = getSettings().slotEscape;
  if (items.length || !shown?.items?.length) setSetting('slotEscape', { at: now(), task: id, attempt, items, moves: moved, others });
  log(`${id}: attempt ${attempt}'s worker did something outside its slot (${wt}): ${words}. Found after the attempt, by pattern: nothing was stopped`);
  // (moves alone may be the owner's or the orchestrator's own: said as such, not as an alarm)
  if (items.length) queueNotify(`${NAME}: task ${id} worked outside its slot`, `Attempt ${attempt} of ${id}: ${words}. Found after the attempt; nothing was stopped. Look on the dashboard (Home).`, 'high', 'warning');
  else queueNotify(`${NAME}: the main checkout moved while a worker ran`, `While task ${id}'s worker ran${also}: ${moved.join('; ')}, not by the hub. If you or the orchestrator moved it, that was you. Look on the dashboard (Home).`, 'default', 'warning');
}
const slotEscapeView = () => {
  const e = getSettings().slotEscape;
  if (!e || !e.task) return null;
  const items = (Array.isArray(e.items) ? e.items : []).map((x) => ({ kind: x.kind === 'command' || x.kind === 'security' ? x.kind : 'file', what: String(x.what || ''), aims: String(x.aims || '') }));
  const moves = (Array.isArray(e.moves) ? e.moves : []).map(String);
  const others = (Array.isArray(e.others) ? e.others : []).map(String);
  return { at: e.at, task: String(e.task), attempt: Number(e.attempt) || 1, items, moves, others, did: items.length ? outsideWords(items) : '' };
};
function slotEscapeSeen(say = (m) => console.log(m)) {
  setSetting('slotEscape', null);
  say('Marked as seen.');
}

async function stoppedFromOutside(s, run) {
  guardClose(`worker:${s.id}`);
  // Nobody reads what its worker started any more: its slot is held until nothing of it runs there (a worker's process
  // this hub started was held the moment it ended: workerEnded)
  if (ended.has(s.id)) await cleaning.get(s.slot);
  else {
    holdSlot(s.slot, s, run, Date.now());
    await cleanSlot(s.slot);
  }
  ended.delete(s.id);
  const wt = slotPath(s.slot);
  if ([TASK_DIR, ...TASK_DIRS].some((t) => fs.existsSync(path.join(wt, t, 'RESULT.md')))) return finishTask(s.id);
  // (with its state, in one write: whoever reads the job never sees it stopped without why)
  await finishTask(s.id, 'stopped', { stoppedOutside: true, error: stoppedText(s.id, windowed(s.windowMode)) });
  log(`${s.id}: stopped from outside (its worker's processes are gone and it left no report): not counted as an attempt; an antivirus is a likely cause`);
}

// ---------- what a worker left running, and its slot (FR-013) ----------
// A worker's process (_run) that ends without finishing leaves what it started running in its slot. On Windows Node's job
// takes the worker's own child along (its engine: engines start without a cmd.exe in between, lib/proc.mjs spawnDirect)
// and nothing further down; elsewhere the engine stays too, in the worker's process group. So the slot is held
// (settings.json heldSlots): no task starts in it until one snapshot of all processes shows nothing of that worker's tree
// running, and what the snapshot shows is stopped (lib/proctree.mjs: parent ids and start times from what run.json
// recorded, so a parent that is gone hides nothing and a pid another program has now is never touched). The listing runs
// when a worker ends, when the hub starts and when the owner asks (Check again on Home), never on a timer: a late one is
// asked again twice, 1 and 5 minutes later; then Home and the phone say the slot is held, and why.
const RETRY_MIN = [1, 5];
const LISTER = IS_WIN ? 'Windows (PowerShell)' : 'ps';
const holding = new Map(); // job id -> its worker's process, which this hub started and holds (a ChildProcess)
const ended = new Map(); // job id -> when its held worker's process ended without finishing
const cleaning = new Map(); // slot -> the cleanup in progress
const heldSlots = () => getSettings().heldSlots || {};
function setHeld(n, value) {
  updateSettings((s) => {
    const all = { ...(s.heldSlots || {}) };
    if (value) all[n] = value;
    else delete all[n];
    return { ...s, heldSlots: all };
  });
}
// A worker's processes as run.json has them: its own and its engine's, each with a time it ran, how long before that it
// may have started (the worker's process writes its time once its code runs, which a busy PC delays; the engine's is
// written the moment it starts), and the last time the hub knew it ran
const workerRoots = (id, run, until) => [
  { pid: run.pid, at: Date.parse(run.startedAt), within: 120_000, until, what: "its worker's process", id },
  ...(run.enginePid ? [{ pid: run.enginePid, at: Date.parse(run.engineAt), within: 30_000, until, what: 'its engine', id }] : []),
];
function holdSlot(n, s, run, until) {
  const was = heldSlots()[n];
  const roots = workerRoots(s.id, run, until).filter((r) => Number.isInteger(r.pid) && Number.isFinite(r.at));
  // (the worker's process group, elsewhere: the worker's process leads one)
  setHeld(n, { id: s.id, attempt: s.attempt || 1, since: was?.since || now(), roots: [...(was?.roots || []), ...roots], group: IS_WIN ? 0 : run.pid, state: 'cleaning', tries: was?.tries || 0 });
}

// A worker's process this hub started that ended without writing its end in run.json. Nothing is asked first: while
// the hub held the process, no other program could get its pid. On Windows its own child (the engine) went with it;
// elsewhere its process group is stopped at once: the group it led keeps that id while any process of it runs, and
// the id comes back only after the system has handed out all the others, so it can't be another program's group (the
// one kill not made by a pid with its start time). Then the slot is held until the listing shows nothing of it runs.
function workerEnded(n, id, token, pid) {
  const at = Date.now();
  const s = jobStatus(id);
  const run = readJson(path.join(jobDir(id), 'run.json'));
  if (s?.state !== 'running' || s.launch?.token !== token || run?.pid !== pid || run.endedAt) return;
  if (!IS_WIN) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // nothing of its group runs
    }
  }
  ended.set(id, at);
  holdSlot(n, s, run, at);
  log(`${id}: its worker's process (pid ${pid}) ended without finishing${IS_WIN ? '' : ': its process group is stopped'}; slot w${n} is held until nothing it started runs there`);
  cleanSlot(n);
}

// One try at freeing a held slot (the one in progress, if there is one)
function cleanSlot(n) {
  if (cleaning.has(n)) return cleaning.get(n);
  const p = cleanOnce(n)
    .catch((err) => log(`slot w${n}: ${err.message}`))
    .finally(() => cleaning.delete(n));
  cleaning.set(n, p);
  return p;
}
async function cleanOnce(n) {
  const first = heldSlots()[n];
  if (!first) return;
  if (first.again) setHeld(n, { ...first, again: null });
  const stopped = [];
  const tried = []; // (stopped, or still there after the kill)
  const told = new Set();
  // What it started may start more while it is stopped: stopped up to three times, each time from a new snapshot, and a
  // last snapshot says what is still there (a pid with the start time the record has; a zombie runs nothing). The record
  // is read again each time: what is stopped joins it (what that started, it started before it ended), and so does the
  // worker of a task stopped meanwhile in the same slot.
  for (let round = 0; ; round++) {
    const snap = await listProcesses();
    const h = heldSlots()[n];
    if (!h) return;
    if (!snap.list) return notCleaned(n, snap.late ? `${LISTER} didn't list the processes within ${Math.round(listWaitMs() / 1000)} s` : `${LISTER} couldn't list the processes: ${snap.error}`, { late: !!snap.late });
    const roots = h.roots || [];
    const { found, reused } = processTree(snap.list, { roots, group: h.group || 0, self: process.pid });
    for (const r of reused.filter((x) => !told.has(x.pid))) {
      told.add(r.pid);
      log(`${r.id || h.id}: pid ${r.pid} is no longer ${r.what} (another program has it now): left alone`);
    }
    if (!found.length) {
      if ((heldSlots()[n]?.roots || []).length !== roots.length && round < 6) continue; // (another worker's joined it meanwhile)
      setHeld(n, null);
      log(`slot w${n} is free again: nothing ${h.id}'s worker started runs there${stopped.length ? ` (stopped: ${listNames(stopped)})` : ''}`);
      return;
    }
    if (round === 3) {
      const back = found.filter((p) => tried.some((s) => s.pid === p.pid && s.start === p.start));
      return notCleaned(n, back.length ? `${back.length === 1 ? 'a process' : 'processes'} it started wouldn't stop` : 'what it started kept starting more', { left: found.map(processName) });
    }
    // Each one only while its pid is still that process (the pid and the start time the snapshot has): lib/proctree.mjs
    const r = await stopProcesses(found);
    if (!r.stopped) return notCleaned(n, r.late ? `${LISTER} didn't stop the processes within ${Math.round(listWaitMs() / 1000)} s` : `${LISTER} couldn't stop the processes: ${r.error}`, { late: !!r.late });
    stopped.push(...r.stopped);
    tried.push(...r.stopped, ...r.left);
    for (const p of r.other) {
      told.add(p.pid);
      log(`${h.id}: pid ${p.pid} went to another program before it was stopped: left alone`);
    }
    // What they started, they started before they ended: they join the record, each with its own start
    const gone = Date.now();
    const cur = heldSlots()[n] || h;
    setHeld(n, { ...cur, roots: [...(cur.roots || []), ...found.map((p) => ({ pid: p.pid, at: p.start, within: 0, until: gone, what: processName(p), id: h.id }))] });
    if (r.stopped.length) log(`${h.id}: stopped what its worker left running in slot w${n}: ${listNames(r.stopped)}`);
  }
}
const listNames = (list) => (list.length <= 4 ? list.map(processName).join(', ') : `${list.slice(0, 4).map(processName).join(', ')} and ${list.length - 4} more`);
// The slot stays held: asked again later when the listing was late (twice), else Home and the phone say so
function notCleaned(n, why, { late = false, left = [] } = {}) {
  const h = heldSlots()[n];
  if (!h) return;
  const tries = (h.tries || 0) + 1;
  if (late && tries <= RETRY_MIN.length) {
    const min = RETRY_MIN[tries - 1];
    setHeld(n, { ...h, state: 'waiting', tries, why, left, next: new Date(Date.now() + min * 60_000).toISOString() });
    log(`slot w${n} stays held: ${why}, so whether what ${h.id}'s worker started still runs there isn't known yet; asked again in ${min} min`);
    return;
  }
  setHeld(n, { ...h, state: 'failed', tries, why, left, next: null });
  const text = slotText({ slot: n, ...h, why, left });
  log(text);
  if (h.state !== 'failed') queueNotify(`${NAME}: slot w${n} held`, text, 'high', 'warning');
}
// What Home, the phone and the status say of a held slot that couldn't be freed
const slotText = (h) =>
  `Slot w${h.slot} is kept out of use: ${h.id}'s worker was stopped and ${h.why}${h.left?.length ? ` (${h.left.join(', ')})` : ''}. Close what it started (Task Manager, or restart the PC), then Check again on Home; tasks start in the other slots meanwhile`;
// Held slots, for the dashboard and the status: [{ slot, id, state, why, left, next, text }]
const heldView = () =>
  Object.entries(heldSlots()).map(([slot, h]) => ({ slot: Number(slot), id: h.id, attempt: h.attempt, since: h.since, state: h.state, tries: h.tries || 0, why: h.why || '', left: h.left || [], next: h.next || null, ...(h.state === 'failed' ? { text: slotText({ slot, ...h }) } : {}) }));
// The owner's Check again (from the dashboard, another process): the hub tries once more at its next tick
function checkSlot(n, say = (m) => console.log(m)) {
  const h = heldSlots()[n];
  if (!h) return say(`Slot w${n} is not held.`);
  setHeld(n, { ...h, again: now() });
  say(hubAlive() ? `The hub looks at slot w${n} again now.` : `The hub looks at slot w${n} again when it starts: start the hub.`);
}

// The files a worker on this profile can't start without: nextlevel's own entry point (a worker's process runs it)
// and the engine's program, with what its launcher runs (an npm .cmd shim's files). -> [what is gone]
function toolFilesGone(profile) {
  const eng = engine(profile.engine);
  const exists = (f) => fs.existsSync(f);
  const own = missingFiles([BIN, path.join(TOOL_ROOT, 'src', 'cli.mjs'), path.join(TOOL_ROOT, 'src', 'hub.mjs')], exists);
  const bin = resolveBin(eng.command);
  return [...own, ...(bin ? missingFiles(programFiles(bin, { read: readText, path }), exists) : [`${eng.title}'s program (${eng.command})`])];
}
// Dispatch pauses while they are gone, instead of failing task after task: the tasks wait in the queue, Home and the
// phone say what is missing and what to check, and dispatch goes on by itself once they are back. -> whether it waits
function dispatchWaits(profile = CFG.worker) {
  const paused = getSettings().dispatchPaused;
  if (!paused) return false;
  const gone = toolFilesGone(paused.profile ? findProfile(CFG.config, paused.profile) || profile : { ...profile, engine: paused.engine || profile.engine });
  if (gone.length) return true;
  setSetting('dispatchPaused', null);
  log('dispatch goes on: the files it waited for are back');
  return false;
}
function pauseDispatch(profile, gone) {
  const was = getSettings().dispatchPaused;
  setSetting('dispatchPaused', { at: was?.at || now(), engine: profile.engine, profile: profile.name || '', files: gone });
  if (was) return;
  const text = `Dispatch is paused: ${gone.length === 1 ? 'a file' : `${gone.length} files`} a worker needs ${gone.length === 1 ? 'is' : 'are'} missing (${gone.slice(0, 3).join(', ')}${gone.length > 3 ? ', ...' : ''}). An antivirus may have quarantined ${gone.length === 1 ? 'it' : 'them'}. ${ANTIVIRUS_STEPS} Tasks wait in the queue and start once the files are back.`;
  log(text);
  queueNotify(`${NAME}: dispatch paused`, text, 'high', 'warning');
}

// ---------- tasks on Antigravity wait for a passing trial (FR-022) ----------
// After agy updated itself to 1.3.4 on a real project, every worker it would have started failed at once ("unknown agent"), and
// nothing stopped a task from starting on it: each would have spent an attempt. Before a task starts on agy, the hub
// needs a passing trial for exactly what that worker runs (checks/engines.mjs agyTrialSpec: its arguments, environment,
// launcher and agent file, and agy's version); the doctor's kept answer counts. Without one, the trial runs in a child
// process the hub follows (`_trial`), never inside its tick (a trial takes up to 2.5 minutes, and a hub that misses its
// heartbeat for 90 s counts as stopped); it isn't a job. While a trial runs or fails, the tasks that would run on that
// agy wait in the queue (`waiting: ...`); tasks on other engines go on (FR-013's dispatchPaused stops them all).
// Nothing falls back by itself: agy's ERROR can be a usage limit (1.3.3 reports quota at once), and a fallback is never
// for a provider's limits (CLAUDE.md); `nextlevel retry <id> --fallback` moves a held task. A failing trial's hold is a
// card on Home with Check again, one phone message, and one round for the orchestrator (a trigger under FR-019's brake,
// like a check ending); its tries after that start none. The hub tries again on Check again, when the version, model,
// flags or environment change (another key), and otherwise once an hour (a refusal is kept that long; lib/clock.mjs).
// settings.json `agyHold`: { key, version, model, reason, code, since, at, again } while a trial for a held task fails.
const TRIAL_LIMIT_MS = 240_000; // the trial's own 2.5 minutes, its console and the doctor's setup around it
// (under the tests' stubs only, NEXTLEVEL_TEST_TRIAL_LIMIT_MS shortens it: a trial that hangs, without waiting 4 minutes)
const trialLimitMs = () => (process.env.NEXTLEVEL_TEST_STUBS && Number(process.env.NEXTLEVEL_TEST_TRIAL_LIMIT_MS) > 0 ? Number(process.env.NEXTLEVEL_TEST_TRIAL_LIMIT_MS) : TRIAL_LIMIT_MS);
const trial = { child: null, key: '', startedAt: 0, profile: null };
let agyVersionKept = { stamp: '', version: '' };
// agy's version, asked again when its program file changes (an update replaces it)
function agyVersionNow() {
  const bin = resolveBin('agy');
  if (!bin) return '';
  let stamp = bin.file;
  try {
    const st = fs.statSync(bin.file);
    stamp = `${bin.file}:${st.size}:${st.mtimeMs}`;
  } catch {
    // the program as it is named
  }
  if (agyVersionKept.stamp !== stamp) agyVersionKept = { stamp, version: (runQuiet('agy', ['--version'], { cwd: ROOT, env: { ...process.env, ...engine('agy').headlessEnv } }).out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '') };
  return agyVersionKept.version;
}
const trialStore = () => jsonStore(path.join(DIR, 'check-cache.json'));
const agyHold = () => getSettings().agyHold || null;
const setAgyHold = (v) => setSetting('agyHold', v);
const holdWords = (h) => `Antigravity ${versionShort(h.version)} refused what a worker runs${h.model ? ` (model ${h.model})` : ''}: ${h.reason || 'it gave no reason'}${h.code !== null && h.code !== undefined ? `, exit ${h.code}` : ''}`;
const versionShort = (v) => (parseVersion(v) ? versionText(parseVersion(v)) : v || '(version unknown)');
// What a held task's status says, and `wait`
const waitingWords = (h) => `${holdWords(h)}. It starts once a trial passes (Check again on Home, or nextlevel doctor); to move it: nextlevel retry <id> --fallback`;

// The trial's spec for a profile, kept a few seconds (the queue is looked at every tick)
let specKept = { id: '', at: 0, spec: null };
function trialSpecFor(profile) {
  const version = agyVersionNow();
  const id = JSON.stringify([profile.name || '', profile.account || '', profile.model || '', version, CONFIG_STAMP]);
  if (specKept.id !== id || Date.now() - specKept.at > 30_000) specKept = { id, at: Date.now(), spec: agyTrialSpec(checkContext(), profile, { version }) };
  return specKept.spec;
}

// The system a task's "Needs:" is judged for: this PC's. Under the tests' stubs only (NEXTLEVEL_TEST_STUBS, lib/proc.mjs),
// NEXTLEVEL_TEST_PLATFORM plays another, so Linux CI tests what a Codex worker in its sandbox can't give on Windows.
const NEEDS_PLATFORM = (process.env.NEXTLEVEL_TEST_STUBS && process.env.NEXTLEVEL_TEST_PLATFORM) || process.platform;

// Which worker a task runs on: 'workers' (the worker role's), 'second' (the second worker), 'fallback', or 'asked' (an
// engine or profile named for it that is none of them)
function whichWorker(profile, why) {
  if (['fallback', 'auto-fallback'].includes(why?.how)) return 'fallback';
  const same = (p) => p && p.engine === profile.engine && (p.name || '') === (profile.name || '') && (p.account || '') === (profile.account || '');
  if (profile.second || same(roleProfile(CFG.config, 'worker', { second: true }))) return 'second';
  // (a task on the worker role, or one sent to the workers' own engine and profile)
  if (!why || why.how === 'role' || same(CFG.worker)) return 'workers';
  return 'asked';
}
const WORKER_WORDS = { workers: 'the workers', second: 'the second worker', fallback: "the workers' fallback", asked: '' };

// ---------- what a task needs (its "Needs:" line, lib/needs.mjs) ----------
// true when the task can't start on this profile: its status says why ("waiting", waitingFor 'needs'), once; the
// orchestrator gets one round for it (it can move the task: retry --engine, --profile or --fallback). It never started, so
// no attempt is spent and FR-020's attempts list doesn't have it.
function needsHold(job, profile) {
  const needs = job.needs || [];
  const missing = lacks(profile, needs, { config: CFG.config, platform: NEEDS_PLATFORM });
  if (!missing.length) return false;
  const words = `it ${needsWords(profile, missing, workersThatCan(needs, { config: CFG.config, platform: NEEDS_PLATFORM }))}`;
  const s = jobStatus(job.id);
  if (s?.waiting === words && s.waitingFor === 'needs') return true;
  setStatus(job.id, { waiting: words, waitingFor: 'needs', engine: profile.engine, profile: profile.name || '' });
  log(`${job.id} waits in the queue: ${words}. To move it: nextlevel retry ${job.id} --profile P (or --engine E, --fallback)`);
  try {
    rounds((st, t) => addTrigger(st, { type: 'job', what: `${job.id} can't start: ${words}` }, t));
  } catch (err) {
    log(`autopilot: couldn't note the held task: ${err.message}`);
  }
  return true;
}

// '' when a task on this profile may start now, else why it waits (and a trial is started when none stands or runs)
function agyGate(profile) {
  if (profile.engine !== 'agy') return '';
  // A PC where the console with no window doesn't start (FR-010): workers run in a window of their own there, which the
  // trial can't be (it would take the focus), so tasks start as before; the doctor warns that what a worker runs isn't
  // tried (review of FR-022: the gate started a trial at every tick and no agy task ever started)
  if (needsConsole('agy') && consoleBroken()) return '';
  // (agy not found: no trial to run; the worker says it isn't installed, as before)
  if (!resolveBin('agy')) return '';
  const spec = trialSpecFor(profile);
  const kept = keptTrial({ cache: trialStore() }, spec.key);
  const hold = agyHold();
  const again = !!hold?.again && hold.key === spec.key;
  if (kept?.noConsole && trialStands(kept, { now: clockNow() })) return ''; // (the same, found by the trial itself)
  if (kept?.ok) {
    if (hold) {
      setAgyHold(null);
      log(`Antigravity ${versionShort(kept.version)} passed the trial (what a worker runs): the tasks that waited for it start`);
    }
    return '';
  }
  // (a trial for this run is on its way, Check again's included: the task says so until it answers, never the refusal
  // it may replace; final review of FR-022)
  if (trial.child && trial.key === spec.key) return `checking Antigravity ${versionShort(spec.version)} with what a worker runs (the model trial, up to 2.5 min)`;
  if (kept && !again && trialStands(kept, { now: clockNow() })) {
    holdFor(spec, kept, profile);
    return waitingWords(agyHold() || kept);
  }
  if (trial.child) return trial.key === spec.key ? `checking Antigravity ${versionShort(spec.version)} with what a worker runs (the model trial, up to 2.5 min)` : 'another Antigravity trial runs first';
  // (one Antigravity test at a time: the lock test waits for a trial, and a trial for the lock test)
  if (lockTest.child) return "the Antigravity trial waits for a role's lock test to end";
  startTrial(spec, profile);
  if (again) setAgyHold({ ...hold, again: null });
  return `checking Antigravity ${versionShort(spec.version)} with what a worker runs (the model trial, up to 2.5 min)`;
}

// A failing trial holds the tasks: said once per hold (a card, a phone message, a round for the orchestrator)
// (the hold keeps its profile: with no task waiting, Check again tries that again, agyHoldTick)
const holdProfile = (p) => ({ name: p?.name || '', engine: 'agy', account: p?.account || '', model: p?.model || '' });
function holdFor(spec, v, profile) {
  const was = agyHold();
  const same = was && was.key === spec.key;
  if (same && was.at === v.at) return;
  const hold = { key: spec.key, profile: holdProfile(profile || was?.profile), version: v.version || spec.version, model: v.model || spec.model || '', reason: oneLine(v.reason || (v.timedOut ? 'no answer in 2.5 min' : ''), 300), code: v.code ?? null, since: same ? was.since : now(), at: v.at, again: null };
  setAgyHold(hold);
  if (same) {
    log(`Antigravity ${versionShort(hold.version)} was tried again and still refuses: ${hold.reason}; agy tasks keep waiting (the next try in an hour, or on Check again)`);
    return;
  }
  const text = holdWords(hold);
  log(`${text}. Tasks on it wait in the queue; tasks on other engines go on. Check again on Home, or nextlevel retry <id> --fallback moves one`);
  // (the phone gets agy's own words in one line, redacted like every phone message)
  queueNotify(`${NAME}: Antigravity tasks wait`, `${text}. Nothing falls back by itself. Check again on Home once it is fixed.`, 'high', 'warning');
  try {
    rounds((s, t) => addTrigger(s, { type: 'job', what: `Antigravity ${versionShort(hold.version)} tasks wait: ${hold.reason}` }, t));
  } catch (err) {
    log(`autopilot: couldn't note the Antigravity hold: ${err.message}`);
  }
}

// The trial, in a child process the hub follows (`_trial`): it writes its answer where the doctor keeps them
function startTrial(spec, profile) {
  // (what to try goes on its command line, never through a file in .nextlevel/, which an agent can write between the
  // hub's write and the child's read: rafter review, FR-022)
  const ask = Buffer.from(JSON.stringify({ profile: { name: profile.name || '', engine: 'agy', account: profile.account || '', model: profile.model || '' }, key: spec.key, version: spec.version })).toString('base64url');
  const child = spawn(process.execPath, [BIN, '_trial', ask], { cwd: ROOT, env: { ...process.env, NEXTLEVEL_ROOT: ROOT }, stdio: 'ignore', windowsHide: true, detached: !IS_WIN });
  const startedAt = clockNow();
  Object.assign(trial, { child, key: spec.key, startedAt: Date.now(), profile });
  log(`checking Antigravity ${versionShort(spec.version)} with what a worker runs before its tasks start (the model trial: ${spec.shown})`);
  const timer = setTimeout(() => {
    log('the Antigravity trial ran past its limit: stopped');
    killTree(child.pid);
  }, trialLimitMs());
  timer.unref();
  const done = () => {
    clearTimeout(timer);
    if (trial.child !== child) return;
    trial.child = null;
    let v = keptTrial({ cache: trialStore() }, spec.key);
    // An answer from before this trial isn't its answer (Check again tries a kept refusal again)
    if (v && Date.parse(v.at) < startedAt - 60_000) v = null;
    if (!v) {
      // (killed at its limit, or it crashed: a short "no answer", so the next trial waits ten minutes instead of
      // starting at the next tick; review of FR-022)
      v = { ok: false, timedOut: true, reason: 'the trial ended without an answer (stopped at its limit, or its process failed)', code: null, version: spec.version, model: spec.model, shown: spec.shown, at: clockIso() };
      const store = trialStore();
      store.set(TRIALS, { ...(store.get(TRIALS) || {}), [spec.key]: v });
      log(`the Antigravity trial ended without an answer: agy tasks wait, and it is tried again in ${TRIAL_NO_ANSWER_MS / 60_000} min or on Check again`);
    }
    if (v.ok) {
      log(`Antigravity ${versionShort(v.version)} passed the trial (what a worker runs)`);
      if (agyHold()?.key === spec.key) setAgyHold(null); // (the card goes, whether a task waits or not)
    } else if (v.noConsole) log(`the Antigravity trial found no console with no window to run in: agy tasks start as before, in a window of their own`);
    else holdFor(spec, v, profile);
  };
  child.once('exit', done);
  child.once('error', (err) => {
    log(`the Antigravity trial didn't start: ${err.message}`);
    done();
  });
}

// _trial <what>: the trial for the profile the hub names (base64url JSON), run as the doctor runs it, its answer kept
// under the hub's key too
async function cmdTrialProcess(what) {
  let ask = null;
  try {
    ask = JSON.parse(Buffer.from(String(what), 'base64url').toString('utf8'));
  } catch {
    // not the hub's
  }
  if (!ask?.profile || typeof ask.profile !== 'object' || (ask.key !== undefined && typeof ask.key !== 'string')) throw new Error('_trial: no profile to try');
  const ctx = checkContext();
  // (agy's version as the hub read it a moment ago, so the key is the hub's; asked again only when it gave none)
  const spec = agyTrialSpec(ctx, { ...ask.profile, engine: 'agy' }, typeof ask.version === 'string' && ask.version ? { version: ask.version } : {});
  const v = agyTrial(ctx, spec, { retry: true });
  if (ask.key && ask.key !== spec.key) {
    // (the same run as far as nextlevel can tell, read by another process: the hub looks for its own key. A difference
    // means the hub's process and this one would not run the same thing: said)
    log(`the Antigravity trial's run differs from the hub's (key ${spec.key}, the hub's ${ask.key}): kept under both; agy's version or the settings changed in between, or the two processes' environments differ`);
    ctx.cache.set(TRIALS, { ...(ctx.cache.get(TRIALS) || {}), [ask.key]: { ...v, kept: undefined } });
  }
}

// A hold no task waits for (review of FR-022: the owner moved every held task with retry --fallback, or moved the
// workers off agy, and the card stayed for good): the hub looks at every tick. Its trial passed meanwhile (the doctor's,
// or Check again's): the card goes. Check again asked: the trial for the hold's own profile runs. Else, with nothing
// asked, the card goes too: the next task on agy tries again (and holds again, if it must).
function agyHoldTick(queued) {
  const h = agyHold();
  if (!h || queued.some((j) => j.type === 'task' && jobStatus(j.id)?.waitingFor === 'agy')) return; // (the gate looks after it)
  if (keptTrial({ cache: trialStore() }, h.key)?.ok) {
    setAgyHold(null);
    log(`Antigravity ${versionShort(h.version)} passed the trial since: its card goes`);
    return;
  }
  if (h.again) {
    if (trial.child) return;
    setAgyHold({ ...h, again: null });
    if (h.profile && typeof h.profile === 'object') startTrial(trialSpecFor(holdProfile(h.profile)), holdProfile(h.profile));
    return;
  }
  if (trial.child) return;
  setAgyHold(null);
  log('no task waits for Antigravity any more: its card goes (the next task on agy tries it again first)');
}

// The hold for Home: { text (one line: the version and agy's own reason), version, since, tasks, again } or null
function agyHoldView(jobs = allJobs()) {
  const h = agyHold();
  if (!h) return null;
  const tasks = jobs.filter((j) => j.type === 'task' && j.state === 'queued' && j.waitingFor === 'agy').map((j) => j.id);
  return { text: holdWords(h), version: versionShort(h.version), model: h.model || '', since: h.since, at: h.at, tasks, again: !!h.again };
}

// The owner's Check again on the hold's card: the hub tries again at its next look
function checkAgyAgain(say = (m) => console.log(m)) {
  const h = agyHold();
  if (!h) return say('No Antigravity tasks are waiting.');
  setAgyHold({ ...h, again: now() });
  say(hubAlive() ? 'The hub tries Antigravity again now: its tasks start once the trial passes (about a minute).' : 'The hub tries Antigravity again when it starts: start the hub.');
}

// ---------- the orchestrator on Antigravity: its session and its lock test (docs/design/antigravity-roles.md) ----------
// Antigravity skips its own permission checks (--dangerously-skip-permissions, and the owner's own agy settings may approve
// everything anyway), and its sandbox and plan mode don't hold on Windows (measured on 1.4.0). So the orchestrator's window
// and its autopilot rounds on agy run with what nextlevel builds itself: the push block in their environment
// (lib/pushblock.mjs), an agent of nextlevel's without the owner's MCP servers and add-ons (engines/agy.mjs agyRoleAgent),
// and the guard as for any orchestrator. The lock test (src/locktest.mjs) proves those hold on this PC, with this agy and
// these arguments; without a passing verdict for exactly what it runs (lib/rolespec.mjs roleKey) the role doesn't start:
// the hub holds autopilot's rounds before they start (so a held round never counts as one that didn't start, FR-019) and
// runs the lock test itself in a child process it follows (`_locktest`), one at a time and never beside the trial; a
// failing or incomplete verdict is a Home card with Check again and one phone message. Never a fallback: what holds the
// role is a fact about this PC, not a setup that isn't ready. The owner's `nextlevel orchestrator` refuses the window
// without a passing verdict, and `nextlevel lock-test` runs it by hand.
// settings.json `lockHold`: { role, key, version, verdict, words, since, at, again } while a verdict holds the role.
const LOCK_LIMIT_MS = 45 * 60_000; // the whole test: nine sessions of at most 5 minutes, with a second asking for some
const lockTest = { child: null, key: '', role: '' };
const lockFile = (role) => path.join(DIR, ...lockFileParts(role));
const lockVerdict = (role) => readJson(lockFile(role));
// (one hold per role: settings.json lockHolds; part A kept the orchestrator's in lockHold, read as such)
const lockHold = (role = 'orchestrator') => {
  const s = getSettings();
  return s.lockHolds?.[role] || (role === 'orchestrator' && s.lockHold?.role === 'orchestrator' ? s.lockHold : null);
};
const setLockHold = (role, v) => updateSettings((s) => ({ ...s, lockHold: role === 'orchestrator' ? null : s.lockHold ?? null, lockHolds: { ...(s.lockHolds || {}), [role]: v } }));
const LOCK_CMD = (role) => `nextlevel lock-test --engine agy --role ${role}`;
// A verdict that isn't a pass stands until Check again or a change of what the role runs; an incomplete one (the model
// didn't run a try, or the test gave no answer) is tried again after an hour
const LOCK_AGAIN_MS = 3_600_000;
// (one whose sessions couldn't start, a push URL an old Git can't switch off, stands until Check again too: nothing changes
// that by itself)
const lockStands = (v) => v.verdict === 'fail' || !!v.startProblem || (clockNow() - isoMs(v.at) >= 0 && clockNow() - isoMs(v.at) < LOCK_AGAIN_MS);

// What the role runs with on agy now: its key (lib/rolespec.mjs roleKey), agy's version and the role's arguments, kept a
// few seconds (autopilot looks at every tick)
let lockSpecKept = { id: '', at: 0, spec: null };
function lockSpecFor(role, profile) {
  const version = agyVersionNow();
  const id = JSON.stringify([role, profile.name || '', profile.model || '', version, CONFIG_STAMP]);
  if (lockSpecKept.id !== id || Date.now() - lockSpecKept.at > 30_000) {
    const engineArgs = CFG.args('agy');
    lockSpecKept = { id, at: Date.now(), spec: { role, version, engineArgs, key: roleKey({ profile, role, engineArgs, version, bin: resolveBin('agy')?.file || '' }) } };
  }
  return lockSpecKept.spec;
}

// Why the orchestrator's window doesn't open on this profile, or '' (17 October: agy 1.4.0's interactive
// window listed nextlevel-orchestrator only as a subagent and ran its default agent, with the owner's rules, skills and
// MCP servers; `-p` runs it as the agent. KNOWN_ISSUES). Rounds on agy are unchanged.
function windowProblem(profile) {
  if (profile?.engine !== 'agy') return '';
  return (
    "Antigravity's interactive window doesn't run nextlevel's agent (it loads your own rules, skills and MCP servers instead: docs/KNOWN_ISSUES.md), so the orchestrator's window doesn't open on it. " +
    'Autopilot rounds on Antigravity run as the agent: turn autopilot on (Home, or START.cmd -> 6). For a window, put the orchestrator on Codex or Claude Code on the Team page.'
  );
}

// Why the role can't start on this profile now, or '' (not on agy, or a passing lock test for exactly what it runs)
function lockProblem(role, profile) {
  if (!needsLockTest(profile, role) || !resolveBin('agy')) return ''; // (engineProblem says agy isn't installed)
  const spec = lockSpecFor(role, profile);
  const v = lockVerdict(role);
  if (lockPasses(v, spec.key)) return '';
  const why =
    !v ? "it hasn't had its lock test yet"
    : v.key !== spec.key ? `its lock test ran ${v.version && v.version !== spec.version ? `on agy ${versionShort(v.version)}, and agy is ${versionShort(spec.version)} now` : 'with other arguments, another model or another agent file'}`
    : `its lock test ${lockWords(v)}`;
  return (
    `the ${role} doesn't start on Antigravity ${versionShort(spec.version)}: ${why}. The lock test proves on this PC that nextlevel keeps it from pushing, from your GitHub sign-in and from your MCP servers, since Antigravity skips its own permission checks. ` +
    `The hub runs it by itself while autopilot is on; or run it in PowerShell, in the project folder: ${LOCK_CMD(role)}`
  );
}

// The hub's side: '' when the role may start, else what it waits for, in words for Home; it starts the lock test when no
// verdict stands for what the role runs now and none runs.
function lockGate(role, profile) {
  if (!needsLockTest(profile, role) || !resolveBin('agy')) return '';
  const spec = lockSpecFor(role, profile);
  const v = lockVerdict(role);
  const hold = lockHold(role);
  const again = !!hold?.again && hold.key === spec.key;
  const checking = `the ${role}'s lock test on Antigravity ${versionShort(spec.version)} runs first (a few minutes)`;
  // (a lock test that runs is waited for, even once its verdict is written: the hub takes it in when its process ends)
  if (lockTest.child && lockTest.key === spec.key) return checking;
  if (lockPasses(v, spec.key)) {
    if (hold) {
      setLockHold(role, null);
      log(`the ${role} on Antigravity ${versionShort(spec.version)} passed its lock test: it starts again`);
    }
    return '';
  }
  // (a PC where the console with no window doesn't start: the lock test can't run its sessions as a round would)
  if (needsConsole('agy') && consoleBroken()) return `the ${role} on Antigravity waits: its lock test can't run here, since the console with no window doesn't start on this PC (${consoleBroken().why})`;
  if (lockTest.child) return `the ${role}'s lock test waits for another lock test to end`;
  if (trial.child) return `the ${role}'s lock test waits for the Antigravity trial to end`;
  if (v && v.key === spec.key && !again && lockStands(v)) {
    holdLock(role, spec, v);
    return `the ${role} is held: ${lockHoldText(lockHold(role))}`;
  }
  startLockTest(role, spec, profile);
  if (again) setLockHold(role, { ...hold, again: null });
  return checking;
}
const lockHoldText = (h) => `its lock test on Antigravity ${versionShort(h.version)} ${h.words}`;

// A verdict that isn't a pass holds the role: said once per verdict (a card, a phone message)
function holdLock(role, spec, v) {
  const was = lockHold(role);
  if (was && was.key === spec.key && was.at === v.at) return;
  const hold = { role, key: spec.key, version: v.version || spec.version, verdict: v.verdict, words: lockWords(v), since: was?.key === spec.key ? was.since : now(), at: v.at, again: null };
  setLockHold(role, hold);
  const text = `The ${role} on Antigravity ${versionShort(hold.version)} is held: ${lockHoldText(hold)}`;
  const waits = role === 'assistant' ? 'Questions to the assistant wait' : "Autopilot's rounds wait";
  log(`${text}. ${waits}; nothing falls back by itself. Check again on Home, or ${LOCK_CMD(role)}`);
  queueNotify(`${NAME}: the ${role} on Antigravity is held`, `${text}. ${waits}, and nothing falls back by itself. Check again on Home once it is fixed.`, 'high', 'warning');
}

// The lock test, in a child process the hub follows (`_locktest`): it writes its verdict where the doctor reads it
function startLockTest(role, spec, profile) {
  const ask = Buffer.from(JSON.stringify({ role, profile: { name: profile.name || '', engine: 'agy', account: profile.account || '', model: profile.model || '' }, key: spec.key })).toString('base64url');
  const child = spawn(process.execPath, [BIN, '_locktest', ask], { cwd: ROOT, env: { ...process.env, NEXTLEVEL_ROOT: ROOT }, stdio: 'ignore', windowsHide: true, detached: !IS_WIN });
  const startedAt = clockNow();
  Object.assign(lockTest, { child, key: spec.key, role });
  log(`the ${role} on Antigravity ${versionShort(spec.version)} gets its lock test before it starts: its sessions try to push, use gh and an MCP tool, and commit a protected file, in a throwaway project`);
  const timer = setTimeout(() => {
    log('the lock test ran past its limit: stopped');
    killTree(child.pid);
  }, LOCK_LIMIT_MS);
  timer.unref();
  const done = () => {
    clearTimeout(timer);
    if (lockTest.child !== child) return;
    lockTest.child = null;
    let v = lockVerdict(role);
    if (v && (v.key !== spec.key || isoMs(v.at) < startedAt - 60_000)) v = null; // (not this run's)
    if (!v) {
      v = { ok: false, verdict: 'incomplete', role, engine: 'agy', key: spec.key, version: spec.version, args: spec.engineArgs, tries: [], reason: 'the lock test ended without a verdict (stopped at its limit, or its process failed)', at: clockIso() };
      writeLockVerdict(role, v);
      log(`the ${role}'s lock test ended without a verdict: it is tried again in an hour, or on Check again`);
    }
    if (lockPasses(v, spec.key)) {
      log(`the ${role} on Antigravity ${versionShort(v.version)} passed its lock test: ${lockWords(v)}`);
      if (lockHold(role)) setLockHold(role, null);
    } else holdLock(role, spec, v);
  };
  child.once('exit', done);
  child.once('error', (err) => {
    log(`the lock test didn't start: ${err.message}`);
    done();
  });
}
function writeLockVerdict(role, v) {
  mkdirp(path.dirname(lockFile(role)));
  writeJson(lockFile(role), v);
}

// The lock test for `role` on the profile, with what it runs here now; its verdict kept (lockFile). -> the verdict
async function lockTestRun(role, profile, { say = () => {} } = {}) {
  const spec = lockSpecFor(role, profile);
  const v = await runLockTest({ role, bin: BIN, profile, engineArgs: spec.engineArgs, version: spec.version, key: spec.key, agyBin: resolveBin('agy')?.file || '', say, needsConsole: needsConsole('agy') });
  const kept = { ...v, at: clockIso() };
  writeLockVerdict(role, kept);
  return kept;
}

// _locktest <what>: the lock test the hub asked for (base64url JSON: the role and its profile), its verdict kept
async function cmdLockTestProcess(what) {
  let ask = null;
  try {
    ask = JSON.parse(Buffer.from(String(what), 'base64url').toString('utf8'));
  } catch {
    // not the hub's
  }
  if (!ask?.profile || typeof ask.profile !== 'object' || !Object.hasOwn(LOCKED_ROLES, ask.role)) throw new Error('_locktest: no role to test');
  const v = await lockTestRun(ask.role, { ...ask.profile, engine: 'agy' });
  if (ask.key && v.key !== ask.key) log(`the lock test's run differs from the hub's (key ${v.key}, the hub's ${ask.key}): agy's version or the settings changed in between`);
}

// nextlevel lock-test --engine agy --role orchestrator: the owner runs it by hand (it takes a few minutes)
async function cmdLockTest(argv) {
  const a = commandArgs('lock-test', argv);
  const session = agentSession();
  if (session) throw new Error(ownerOnly('nextlevel lock-test', 'The owner runs it in PowerShell, in the project folder (the hub runs it by itself while autopilot is on).', session));
  const role = a.role || 'orchestrator';
  if ((a.engine || 'agy') !== 'agy') throw new Error(`the lock test is for roles on Antigravity, which skips its own permission checks: --engine agy, not ${a.engine}`);
  if (!Object.hasOwn(LOCKED_ROLES, role)) throw new Error(`the lock test is for ${Object.keys(LOCKED_ROLES).join(', ')} (the setup guide runs with you there, and workers have the bridge test): not ${role}`);
  if (!resolveBin('agy')) throw new Error('Antigravity (agy) is not installed. Run START.cmd -> 1 (Doctor).');
  if (needsConsole('agy') && consoleBroken()) throw new Error(`the lock test runs Antigravity in a console with no window, which doesn't start on this PC (${consoleBroken().why}): the orchestrator stays off Antigravity here`);
  if (lockTest.child) throw new Error('a lock test runs already');
  const own = roleProfile(CFG.config, role);
  // (the role's own profile when it is on agy; else agy with the model named here or its own)
  const profile = own?.engine === 'agy' ? own : { name: '', engine: 'agy', account: '', model: a.model || '' };
  const v = await lockTestRun(role, profile, { say: (m) => console.log(m) });
  console.log(`\nThe lock test ${lockWords(v)}.`);
  for (const l of lockLines(v)) console.log(`  ${l}`);
  if (v.sandbox) console.log(`  agy's own sandbox, for the record: ${v.sandbox}`);
  if (v.kept) console.log(`\nKept for a look: ${v.kept} (the sessions' logs and the throwaway remotes). Delete it when you're done.`);
  if (v.ok) console.log(`\nThe ${role} may run on Antigravity ${versionShort(v.version)} with these arguments. A new agy version, or another model or arguments, asks for the lock test again.`);
  else console.log(`\nThe ${role} stays off Antigravity ${versionShort(v.version)}: ${v.verdict === 'fail' ? 'something got through. Keep the folder above and file it as a field report' : 'run it again'}.`);
  return v.ok;
}

// _locktry <what>: one try of the lock test, in the lock test's own project (its .nextlevel/lock-test.json has the nonce
// the test gave it), run as a round's process runs the orchestrator: the same session (orchestratorSession), the console,
// the guard around it. Only there: it is no way to run a prompt in a real project.
async function cmdLockTryProcess(what) {
  let ask = null;
  try {
    ask = JSON.parse(Buffer.from(String(what), 'base64url').toString('utf8'));
  } catch {
    // not the lock test's
  }
  const marker = readJson(path.join(DIR, 'lock-test.json'));
  if (!ask || typeof ask.nonce !== 'string' || !marker?.nonce || marker.nonce !== ask.nonce) throw new Error("_locktry runs only in a lock test's own project");
  const log = path.resolve(String(ask.log || ''));
  if (path.dirname(log) !== path.dirname(ROOT)) throw new Error("_locktry writes its log only in the lock test's folder");
  const extra = Array.isArray(ask.extraArgs) ? ask.extraArgs.filter((x) => x === '--sandbox') : [];
  // (the assistant's: in a copy of the lock test's project, as a question to it runs: src/ask.mjs askAgy)
  const role = ask.role === 'assistant' ? 'assistant' : 'orchestrator';
  const profile = role === 'assistant' ? roleProfile(CFG.config, 'assistant') : CFG.orchestrator;
  if (!profile) throw new Error(`_locktry: no ${role} in the lock test's project`);
  const eng = engine(profile.engine);
  let stdin;
  if (needsConsole(profile.engine)) {
    const input = consoleStdin();
    if (input.error) {
      fs.writeFileSync(log, `no console to give ${eng.title}: ${input.error}\n`);
      process.exitCode = NO_CONSOLE_EXIT;
      return;
    }
    stdin = input.stdin;
  }
  const out = engineLog(log, eng);
  let session;
  let copy = null;
  try {
    if (role === 'assistant') {
      copy = makeAskCopy(ROOT);
      const run = agyAssistantRun({ copy: copy.dir, root: ROOT, profile, prompt: String(ask.prompt || ''), env: askContext().env(), engineArgs: CFG.args('agy'), version: agyVersionNow(), timeoutMin: 4 });
      if (run.problem) throw new Error(`Not starting the assistant on Antigravity: ${run.problem}`);
      session = { args: run.args, env: run.env };
    } else session = orchestratorSession(profile, { mode: 'headless', prompt: String(ask.prompt || ''), timeoutMin: 4 });
  } catch (err) {
    if (copy) removeAskCopy(copy.dir);
    out.line(err.message);
    out.end();
    process.exitCode = 1;
    return;
  }
  const key = `locktry:${process.pid}`;
  guardOpen(key, "the lock test's session");
  try {
    const r = await engineRun(profile, resolveBin(eng.command), [...session.args, ...extra], { cwd: copy ? copy.dir : ROOT, env: session.env, out, limitMin: 5, stdin });
    process.exitCode = r.exitCode ?? 1;
  } finally {
    guardClose(key);
    if (copy) removeAskCopy(copy.dir);
  }
}

// The orchestrator's session on its profile: { args, env } for its window ('interactive') or a round ('headless'). On agy
// it is the role's run (lib/rolespec.mjs: the push block, nextlevel's agent written into the project first); it throws
// when the push block can't be made. Whether it may start (its lock test) is the caller's to ask: lockProblem, lockGate.
function orchestratorSession(profile, { mode, prompt, timeoutMin = CYCLE_MIN }) {
  if (needsLockTest(profile, 'orchestrator')) {
    const run = roleRun({ profile, role: 'orchestrator', mode, prompt, timeoutMin, engineArgs: CFG.args('agy'), version: agyVersionNow(), env: withProfile(childEnv(), profile), root: ROOT });
    if (run.problem) throw new Error(`Not starting the orchestrator on Antigravity: ${run.problem}`);
    writeRoleFiles(run.files);
    const env = { ...run.env };
    delete env.NEXTLEVEL_CYCLE_LOG;
    return { args: run.args, env };
  }
  const env = { ...withProfile(childEnv(), profile), NEXTLEVEL_AGENT: 'orchestrator', NEXTLEVEL_SESSION: mode === 'headless' ? 'autopilot' : 'interactive' };
  delete env.NEXTLEVEL_CYCLE_LOG;
  if (mode === 'headless') return { args: sessionArgs(profile, { mode, role: 'orchestrator', prompt, timeoutMin, args: CFG.args(profile.engine) }), env };
  // (on top, what keeps the commands it runs from opening windows of their own: Codex's --no-daemon, FR-011)
  const extra = windowArgs(profile, (cmd, a) => runQuiet(cmd, a, { cwd: ROOT, env }));
  return { args: sessionArgs(profile, { mode, role: 'orchestrator', prompt, args: CFG.args(profile.engine), extra }), env };
}
// nextlevel's agent files in the main checkout (.agents/ is protected): written only where no link is on the way, kept out
// of commits by .git/info/exclude (never the project's .gitignore), and recorded as the hub's own write for the guard
function writeRoleFiles(files) {
  excludeRuntimeDirs();
  for (const f of files) {
    if (!writeSlotFile(ROOT, f.path, f.text)) throw new Error(`Not starting the orchestrator on Antigravity: its agent file ${f.path.join('/')} can't be written (a link or a folder is in the way)`);
    guard().recordOwn([f.path.join('/')]);
  }
}

// What a round on Antigravity ran that clears nextlevel's push block or goes past it (lib/blockwatch.mjs): a Home card
// (settings.json `blockAlert`, until the owner marks it seen) and one phone message per round
function blockAlertFor(text, logRel) {
  const secrets = activitySecrets(); // (and no value from .env: hub.log, Home and the phone show these commands)
  const found = blockCommands(text).map((x) => ({ ...x, command: redactReport(x.command, { values: secrets.values, names: secrets.names }) }));
  if (!found.length) return;
  const shown = found.slice(0, 5).map((x) => `${x.command} (${x.why})`);
  const alert = { at: now(), log: logRel, commands: found.slice(0, 10) };
  setSetting('blockAlert', alert);
  const words = `An autopilot round on Antigravity ran ${found.length === 1 ? 'a command' : `${found.length} commands`} that clear nextlevel's push block or go past it: ${shown.join('; ')}`;
  log(`${words}. Its log: ${logRel}. Found by pattern, after the round: look at what it did`);
  queueNotify(`${NAME}: look at the orchestrator's last round`, `${words}. Found by pattern after the round; nothing was stopped by this. Its log is on the dashboard (Home).`, 'high', 'warning');
}
const blockAlertView = () => {
  const a = getSettings().blockAlert;
  if (!a || !Array.isArray(a.commands) || !a.commands.length) return null;
  return { at: a.at, log: a.log, commands: a.commands.map((x) => ({ command: String(x.command || ''), why: String(x.why || '') })), text: `An autopilot round on Antigravity ran ${a.commands.length === 1 ? 'a command' : `${a.commands.length} commands`} that clear nextlevel's push block or go past it: ${a.commands.slice(0, 3).map((x) => x.command).join('; ')}` };
};
// The owner saw it (the card's button)
function blockAlertSeen(say = (m) => console.log(m)) {
  setSetting('blockAlert', null);
  say('Marked as seen.');
}

// The hold for Home: { role, text, version, since, again } or null
function lockHoldView(role = 'orchestrator') {
  const h = lockHold(role);
  if (!h) return null;
  return { role: h.role, text: `The ${h.role} on Antigravity is held: ${lockHoldText(h)}`, version: versionShort(h.version), since: h.since, at: h.at, again: !!h.again, command: LOCK_CMD(h.role) };
}
// Check again on its card: the hub runs the lock test again at its next look
function checkLockAgain(say = (m) => console.log(m), role = 'orchestrator') {
  const r = Object.hasOwn(LOCKED_ROLES, role) ? role : 'orchestrator';
  const h = lockHold(r);
  if (!h) return say('Nothing waits for a lock test.');
  setLockHold(r, { ...h, again: now() });
  say(hubAlive() ? `The hub runs the lock test again now: it takes a few minutes, and ${r === 'assistant' ? 'the assistant answers' : 'autopilot goes on'} once it passes.` : 'The hub runs the lock test again when it starts: start the hub.');
}

// What this attempt of a task printed in worker.log (the attempts of a task share the file): from where the
// file ended when it started (status.logFrom), else from the header its worker printed; '' for a worker an older
// hub ran in a window of its own (before FR-010). The last 256 KB at most: what the numbers need is at the end.
function attemptLog(id, s = jobStatus(id), max = 256 * 1024) {
  const file = path.join(jobDir(id), 'worker.log');
  if (s?.window) return '';
  let from = s?.logFrom;
  if (from === undefined) {
    const text = readText(file);
    const at = text.lastIndexOf(` · task ${id} · attempt ${s?.attempt || 1} · `);
    return at < 0 ? '' : text.slice(at).slice(-max);
  }
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(from, size - max);
    const buf = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

async function runCheck(job) {
  const d = jobDir(job.id);
  fs.rmSync(path.join(QUEUE, `${job.id}.json`), { force: true });
  writeJson(path.join(d, 'job.json'), job);
  setStatus(job.id, { state: 'running', startedAt: now(), waiting: null });
  if (job.type === 'push') return runPush(job);
  const logFile = path.join(d, 'check.log');
  mkdirp(d);
  const command = typeof job.command === 'string' ? job.command : '';
  const who = { job: job.id, command, cwd: ROOT, by: job.by || '', source: job.source || '' };
  const timeoutMin = job.timeoutMin || CFG.checkTimeoutMin;
  // nextlevel's own doctor, asked for through verify (from inside Codex's sandbox the setup is seen this way, FR-004 #2):
  // the hub runs its own copy, never the command's text, with the owner's sign-ins, which it checks; it only looks
  const doctor = ownDoctor(command);
  // Any other command of the orchestrator's runs outside its sandbox, with the owner's access: without Git pushes and
  // GitHub sign-ins (verifyEnv, FR-017). Each is logged with its exact command line in the guard's folder, outside the
  // project; the protected files are watched while it runs, and nothing it writes is recorded as the owner's
  // (lib/guard.mjs)
  const setup = doctor ? { env: { ...process.env, NEXTLEVEL_AGENT: 'check' } } : command ? verifyEnv() : { problem: 'the job has no command' };
  if (setup.problem) {
    verifyLog({ ...who, state: 'refused', detail: setup.problem });
    fs.appendFileSync(logFile, `not run: ${setup.problem}\n`);
    setStatus(job.id, { state: 'blocked', detail: `not run: ${setup.problem}`, finishedAt: now(), acked: false });
    log(`${job.id}: not run: ${setup.problem}`);
    jobEnded(job.id);
    return;
  }
  const flags = doctor || [];
  verifyLog({ ...who, state: 'started', ...(doctor ? { ran: `nextlevel's own doctor (${['doctor', ...flags].join(' ')}), the hub's copy, with the owner's sign-ins: it only looks` } : {}) });
  log(doctor ? `${job.id}: running nextlevel's own doctor, the hub's copy (it only looks)` : `${job.id}: running ${JSON.stringify(command)} in the main checkout (Git pushes and GitHub sign-ins off)`);
  const key = `job:${job.id}`;
  guardOpen(key, `a check the orchestrator asked for (${job.id})`);
  let r;
  try {
    r = doctor
      ? await runLogged(process.execPath, [BIN, '--project', ROOT, '--no-update', 'doctor', ...flags], { cwd: ROOT, env: setup.env, logFile, timeoutMin })
      : await runShell(command, { cwd: ROOT, env: setup.env, logFile, timeoutMin });
  } finally {
    guardClose(key);
  }
  const ok = r.code === 0;
  const state = ok ? 'passed' : r.timedOut ? 'timeout' : 'failed';
  // A failure for want of a GitHub sign-in says why, in its log and its status (FR-017)
  const why = ok || doctor ? '' : githubFailure(r.out);
  const note = why === 'annotations' ? NOTE_ANNOTATIONS : why === 'sign-in' ? (setup.token ? NOTE_TOKEN_REFUSED : NOTE_NO_SIGN_IN) : '';
  if (note) fs.appendFileSync(logFile, `nextlevel: ${note}\n`);
  verifyLog({ job: job.id, command, state, exitCode: r.code });
  setStatus(job.id, { state, exitCode: r.code, finishedAt: now(), acked: false, ...(note ? { detail: note } : {}) });
  log(`finished ${job.id}: ${state}`);
  jobEnded(job.id);
}
const NOTE_NO_SIGN_IN = `this command had no GitHub sign-in: verify commands run without the owner's (FR-017), so gh and git can't read GitHub from here. A read-only token in the project's .env (${READ_TOKEN}) lets them read, and writes stay blocked; nextlevel doctor's "GitHub reads for verify" says how the owner makes one`;
const NOTE_TOKEN_REFUSED = `GitHub refused the read-only token (${READ_TOKEN} in the project's .env): it may have expired, or lack a permission this command needs; nextlevel doctor's "GitHub reads for verify" says which`;
const NOTE_ANNOTATIONS = "GitHub gives a fine-grained token no Checks permission, so gh can't read a run's annotations with it: gh run view <id> --json jobs (the steps and their times) and gh run view <id> --log-failed read the same run without them";

// A verify command that is exactly nextlevel's own doctor, as the role docs give it (`nextlevel doctor`, and --json or
// --fresh): no fix, nothing else on the line. -> its flags, or null
function ownDoctor(command) {
  const [cmd, sub, ...flags] = command.trim().split(/\s+/);
  return ['nextlevel', 'nextlevel.cmd'].includes(cmd) && sub === 'doctor' && flags.every((f) => ['--json', '--fresh'].includes(f)) ? flags : null;
}

// Each verify command, with its exact command line: one JSON line when it starts (or is refused) and one when it ends, in
// the guard's folder, which the orchestrator can't write (FR-017)
function verifyLog(entry) {
  try {
    mkdirp(guard().dir);
    fs.appendFileSync(path.join(guard().dir, 'verify.jsonl'), `${JSON.stringify({ at: now(), ...entry })}\n`);
  } catch (err) {
    log(`couldn't add the verify command to the guard's log: ${err.message}`);
  }
}

// ---------- pushing (FR-015) ----------
// Every push anything asks for is a push job, and the hub runs it in pushBranch: nextlevel push from the owner or the
// orchestrator (in its window or an autopilot round), and the owner's approval on the dashboard. It is the one place a
// push reaches origin (lib/push.mjs builds its one git push, and a test reads src/ to prove nothing else runs one). A push
// names its branch; a name that could reach a branch another way is refused; nothing is forced; and a push to a deploy
// branch waits for the owner, who approves exactly the commit its card shows, on the dashboard and nowhere else. Each
// push is logged: hub.log, the job's push.log and the guard's pushes.jsonl (outside the project).
const PUSH_PROTOCOL = 2; // in hub.json: this hub pushes what a job names (one from before FR-015 pushed the base branch)
const short = (sha) => String(sha || '').slice(0, 7);
const day = (iso) => String(iso || '').slice(0, 10);
const gitLines = (args) => git(args, { allowFail: true }).out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const localTags = () => gitLines(['for-each-ref', '--format=%(refname:strip=2)', 'refs/tags']);
// origin's address as the card shows it, and git's last line when it failed: never a user name or token in an address,
// nor a value from .env
const noLogin = (s) => String(s || '').replace(/\/\/[^/@\s]*@/g, '//');
const remoteShown = () => noLogin(git(['remote', 'get-url', REMOTE], { allowFail: true }).out);
const gitSaid = (out) => redactSecrets(noLogin(lastLine(out)), envSecrets());

// Git with its output, without holding the hub's loop while it waits for the network. -> { ok, out, err }
function gitAsync(args, { env = readEnv(), timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => killTree(child.pid), timeoutMs);
    child.on('error', (e) => {
      clearTimeout(t);
      resolve({ ok: false, out, err: e.message });
    });
    child.on('close', (code) => {
      clearTimeout(t);
      resolve({ ok: code === 0, out, err });
    });
  });
}

// The deploy branches now: the ones nextlevel.json names on disk, the ones it named when the orchestrator's current work
// began (the guard's watch keeps that version), the ones of the committed nextlevel.json and of the settings the hub
// read. A change the guard hasn't set back yet, or one nobody has committed, can only add a branch, never take one
// away: the team can't change the list without the owner (nextlevel.json is protected). When every one of them says []
// there is no deploy branch (FR-017: the base branch no longer stands in for an empty list). -> { list, why(target) }
function deployBranchesNow() {
  const read = (text) => {
    if (text === null || text === undefined) return null;
    try {
      return loadConfig(ROOT, { raw: JSON.parse(String(text).replace(/^\uFEFF/, '')), env: {} }).config;
    } catch {
      return null; // unreadable: the others count
    }
  };
  const file = path.join(ROOT, CONFIG_FILE);
  const disk = fs.existsSync(file) ? read(fs.readFileSync(file, 'utf8')) : loadConfig(ROOT, { file: null, env: {} }).config;
  let watched = null;
  try {
    const w = guard().readState().window;
    const e = w && Object.entries(w.files || {}).find(([k]) => k.toLowerCase() === CONFIG_FILE)?.[1];
    watched = e ? read(guard().getBlob(e.hash)?.toString('utf8') ?? null) : null;
  } catch {
    // no watch
  }
  const committed = spawnSync('git', ['show', '--end-of-options', `HEAD:${CONFIG_FILE}`], { cwd: ROOT, env: readEnv(), encoding: 'utf8', windowsHide: true });
  // (CFG.config is always there: a list comes from at least one source; a source that doesn't set deployBranches counts
  // its base branch, lib/push.mjs deployList)
  const sources = [disk, watched, committed.status === 0 ? read(committed.stdout) : null, CFG.config].filter(Boolean);
  const list = [...new Set(sources.flatMap((c) => deployList(c)))];
  const why = (target) => {
    if (disk && Array.isArray(disk.deployBranches) && isDeployBranch(target, disk.deployBranches)) return 'deployBranches in nextlevel.json names it';
    if (disk && !Array.isArray(disk.deployBranches) && isDeployBranch(target, [disk.baseBranch])) return "it is the base branch, and nextlevel.json doesn't set deployBranches: until it does, the base branch counts as one";
    return 'the committed nextlevel.json names it, or the one there was when the orchestrator began its work: a change of the list counts once it is committed';
  };
  return { list, why };
}

// The commits `sha` has that origin's branch (at `there`, '' when it isn't there) hasn't: how many, the oldest's date,
// the newest, and a list of them for the card
function outgoing(there, sha) {
  const range = there ? [sha, `^${there}`] : [sha];
  const count = Number(git(['rev-list', '--count', '--end-of-options', ...range], { allowFail: true }).out) || 0;
  const dates = gitLines(['log', '--format=%cI', '--end-of-options', ...range]);
  const [newestShort = short(sha), newestDate = '', ...subject] = git(['log', '-1', '--format=%h%x09%cs%x09%s', '--end-of-options', sha], { allowFail: true }).out.split('\t');
  const MAX = 400;
  const shown = git(['log', `--max-count=${MAX}`, '--format=%h %cs %s', '--end-of-options', ...range], { allowFail: true }).out;
  return { count, oldest: dates.at(-1) || '', newest: { short: newestShort, date: newestDate, subject: subject.join('\t') }, log: `${shown}${count > MAX ? `\n... and ${count - MAX} older commit(s)` : ''}` };
}
// (commit ids only: nothing else reaches git's arguments, so none can be read as an option)
const COMMIT_RE = /^[0-9a-f]{40,64}$/;
const isAncestor = (a, b) => COMMIT_RE.test(a) && COMMIT_RE.test(b) && spawnSync('git', ['merge-base', '--is-ancestor', '--end-of-options', a, b], { cwd: ROOT, env: readEnv(), windowsHide: true }).status === 0;

// Each push, as it went: one JSON line in the guard's folder, which the orchestrator can't write, and a line in hub.log
function pushLog(entry) {
  const e = { at: now(), ...entry };
  log(`push ${e.state}: ${e.from || '?'}${e.sha ? ` at ${short(e.sha)}` : ''} to ${e.target || '(no branch)'} on ${REMOTE}${e.there !== undefined ? ` (${e.there ? `${short(e.there)}..${short(e.sha)}` : 'a new branch'}${e.count !== undefined ? `, ${e.count} commit(s)` : ''})` : ''} · asked by ${e.by || '?'}${e.source ? ` (${e.source})` : ''}${e.approval ? ` · the owner's approval ${e.approval}${e.card ? `, card ${e.card}` : ''}` : ''} · ${e.job || ''}${e.detail ? ` · ${e.detail}` : ''}`);
  try {
    mkdirp(guard().dir);
    fs.appendFileSync(path.join(guard().dir, 'pushes.jsonl'), `${JSON.stringify(e)}\n`);
  } catch (err) {
    log(`couldn't add the push to the guard's log: ${err.message}`);
  }
}

// A push job: pushBranch decides and pushes; its status says what happened
async function runPush(job) {
  const key = `job:${job.id}`;
  guardOpen(key, `a push (${job.id})`); // (a pre-push hook of the project runs outside any sandbox)
  let r;
  try {
    r = await pushBranch(job);
  } catch (err) {
    r = { state: 'failed', detail: `not pushed: ${err.message}` };
    pushLog({ job: job.id, target: job.target, from: job.from, by: job.by, source: job.source, state: 'failed', detail: err.message });
  } finally {
    guardClose(key);
  }
  setStatus(job.id, { state: r.state, detail: r.detail, exitCode: r.code ?? null, push: r.push || null, finishedAt: now(), acked: false });
  log(`finished ${job.id}: ${r.state}`);
  // A push that sent commits moved work (FR-019); one with nothing new didn't
  if (r.state === 'done' && r.push?.count > 0) workMoved(`${r.push.count} commit(s) were pushed to ${r.push.target}`);
  if (r.state === 'done' && r.push?.count > 0) {
    try {
      testerAfterPush(r.push);
    } catch (err) {
      log(`tester: couldn't note the deploy: ${err.message}`);
    }
  }
  jobEnded(job.id);
}

// The one function every push goes through. -> { state: 'done' | 'failed' | 'blocked', detail, code?, push }
async function pushBranch(job) {
  const logFile = path.join(jobDir(job.id), 'push.log');
  mkdirp(path.dirname(logFile));
  const target = typeof job.target === 'string' ? job.target : '';
  const from = typeof job.from === 'string' && job.from ? job.from : CFG.base;
  const entry = { job: job.id, source: job.source || '', by: job.by || '', target, from, ...(job.approval ? { approval: job.approval } : {}) };
  const end = (state, detail, more = {}) => {
    Object.assign(entry, more);
    fs.appendFileSync(logFile, `${detail}\n`);
    pushLog({ ...entry, state, detail });
    return { state, detail, push: { ...entry, state }, ...(more.code !== undefined ? { code: more.code } : {}) };
  };
  const refuse = (why, more) => end('failed', `not pushed: ${why}`, more);
  // (a job from before FR-015, or one written by hand, names no branch: it is never taken to mean the base branch)
  if (!target) return refuse(`the job names no branch to push to (a nextlevel from before FR-015 queued it; it pushed ${CFG.base} whatever it was asked). Push again, naming the branch: nextlevel push <branch>`);
  const remotes = gitLines(['remote']);
  if (!remotes.includes(REMOTE)) return refuse(`the project has no remote "${REMOTE}"`);
  const fromProblem = targetProblem(from, { remotes }) || (branchExists(from) ? '' : `there is no local branch "${from}"`);
  if (fromProblem) return refuse(`--from ${fromProblem}`);
  const plain = targetProblem(target, { remotes, tags: localTags() });
  if (plain) return refuse(plain);
  // (NEXTLEVEL_PUSH_JOB: the project's pre-push hook, and a local remote's hooks, can tell which job pushes)
  const env = readEnv({ ...process.env, NEXTLEVEL_AGENT: 'push', NEXTLEVEL_PUSH_JOB: job.id });
  const ls = await gitAsync(['ls-remote', '--heads', '--tags', REMOTE], { env });
  if (!ls.ok) return refuse(`couldn't read ${REMOTE}'s branches: ${gitSaid(ls.err || ls.out)}`);
  const remote = parseLsRemote(ls.out);
  const tagged = targetProblem(target, { remotes, tags: remote.tags });
  if (tagged) return refuse(tagged);
  // What goes out: exactly the commit the owner approved, else the branch's tip now
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${from}^{commit}`], { allowFail: true }).out;
  let rec = null;
  if (job.approval) {
    rec = guard().held.get(job.approval);
    if (!rec || rec.kind !== 'push' || rec.status !== 'approved' || rec.target !== target || rec.from !== from) return refuse(`${job.approval} isn't the owner's approval of this push${rec ? ` (it is ${rec.status})` : ''}`);
    entry.card = rec.card || '';
  }
  const sha = rec ? rec.sha : tip;
  const there = remote.heads.get(target) || '';
  if (!COMMIT_RE.test(String(sha)) || (there && !COMMIT_RE.test(there))) return refuse(`no commit to push: ${from} is at "${String(sha).slice(0, 80)}"`);
  Object.assign(entry, { sha, there });
  if (there === sha) {
    if (rec) guard().held.update(rec.id, { status: 'applied', detail: `${REMOTE}'s ${target} was at ${short(sha)} already` });
    return end('done', `nothing to push: ${REMOTE}'s ${target} is at ${short(sha)} already`, { count: 0 });
  }
  // Never forced: origin's branch must be in what goes out, or it would lose commits
  if (there && !isAncestor(there, sha)) {
    if (rec) guard().held.update(rec.id, { status: 'failed', detail: `${REMOTE}'s ${target} has commits ${from} doesn't have` });
    return refuse(`${REMOTE}'s ${target} (at ${short(there)}) has commits that ${from} at ${short(sha)} doesn't have: pushing would drop them, and nextlevel never forces a push. Merge ${REMOTE}/${target} into ${from} first, or push to another branch`);
  }
  const range = outgoing(there, sha);
  Object.assign(entry, { count: range.count, oldest: range.oldest });
  const deploy = deployBranchesNow();
  const isDeploy = isDeployBranch(target, deploy.list);
  // The approval covers exactly what its card showed: the branch here and origin's where they were
  if (rec && (tip !== rec.sha || there !== (rec.there || ''))) {
    const moved = tip !== rec.sha ? `${from} moved (${short(rec.sha)} -> ${short(tip)})` : `${REMOTE}'s ${target} moved (${short(rec.there) || 'not there'} -> ${short(there) || 'not there'})`;
    guard().held.update(rec.id, { status: 'superseded', detail: `${moved} after the owner approved it: nothing was pushed, a new card asks again` });
    log(`${rec.id}: ${moved} since its card: nothing is pushed, a new card asks again`);
    if (!COMMIT_RE.test(String(tip))) return refuse(`no commit to push: ${from} is at "${String(tip).slice(0, 80)}"`);
    const now2 = pushProtected(tip, from, remote.heads.get(CFG.base) || '');
    if (now2.rejected) return refuse(now2.rejected);
    if (!isDeploy && !now2.held) return refuse(`${moved} after the owner approved ${rec.id}, and what is there now needs no card: push it again`);
    return holdPush(job, { target, from, sha: tip, there, range: outgoing(there, tip), why: isDeploy ? deploy.why(target) : '', prot: now2, again: { rec, moved } }, end);
  }
  // A push that changes a protected file (a workflow, a hook, an instruction file...) compared with the base branch waits
  // for the owner too, whatever its branch: GitHub runs a pushed branch's own workflows, before any merge
  // (an approved push too: the same change may have been rejected on its merge card since)
  const prot = pushProtected(sha, from, remote.heads.get(CFG.base) || '');
  if (prot.rejected) {
    if (rec) guard().held.update(rec.id, { status: 'failed', detail: `not pushed: ${prot.rejected}` });
    return refuse(prot.rejected);
  }
  // (and a value from .env in what goes out, whoever made the commits: an approved deploy push too)
  const sec = pushSecrets(job, { sha, there, originBase: remote.heads.get(CFG.base) || '', target, from });
  if (sec.rejected || sec.held) {
    if (rec) guard().held.update(rec.id, { status: 'failed', detail: `not pushed: ${sec.rejected ? 'its commits carry a value from .env the owner rejected' : 'its commits carry a value from .env, held for the owner'}` });
    return sec.rejected ? refuse(sec.rejected) : end('blocked', sec.held);
  }
  if (!rec && (isDeploy || prot.held)) return holdPush(job, { target, from, sha, there, range, why: isDeploy ? deploy.why(target) : '', prot }, end);
  fs.appendFileSync(logFile, `${from} at ${short(sha)} to ${target} on ${REMOTE}: ${range.count} commit(s)${range.oldest ? ` since ${day(range.oldest)}` : ''}, ${there ? `${short(there)}..${short(sha)}` : 'a new branch'}; asked by ${entry.by || '?'}${entry.source ? ` (${entry.source})` : ''}${rec ? `; approved by the owner on the dashboard (${rec.id}${rec.card ? `, card ${rec.card}` : ''})` : ''}\n`);
  const r = await runLogged('git', pushArgs(sha, target), { cwd: ROOT, env, logFile, timeoutMin: 5 });
  if (r.code !== 0) {
    if (rec) guard().held.update(rec.id, { status: 'failed', detail: `the push ended with exit code ${r.code}: nothing went out` });
    return refuse(`the push ended with exit code ${r.code}${r.timedOut ? ' (it took too long)' : ''}: ${gitSaid(r.out)}`, { code: r.code });
  }
  if (rec) {
    guard().held.update(rec.id, { status: 'applied', detail: `pushed ${short(sha)} to ${target}` });
    // exactly the protected content the owner approved on this card is the owner's now (a later commit or merge of it)
    for (const f of rec.files || []) guard().approveContent(f.path, f.after);
    settleTwins(rec, 'approve', rec.reason || '');
  }
  // A card that still asks about this branch shows where it was before this push: it is no longer what would go out
  for (const x of guard().held.list().filter((y) => y.kind === 'push' && y.status === 'held' && y.target === target)) {
    guard().held.update(x.id, { status: 'superseded', decidedAt: now(), detail: `${target} was pushed by ${job.id} meanwhile` }, { expect: ['held'] });
    // (the hub closes it: no owner's action, so no round for it, FR-019)
    cards().handoff.decideGuard(x.id, { reply: `Not needed any more: ${target} on ${REMOTE} was pushed meanwhile (${job.id}); a new push asks again if it needs to`, hub: true });
  }
  return end('done', `pushed ${from} at ${short(sha)} to ${target} on ${REMOTE}: ${range.count} commit(s), ${there ? `${short(there)}..${short(sha)}` : 'a new branch'}${rec ? `, as the owner approved (${rec.id}${rec.card ? `, card ${rec.card}` : ''})` : ''}`, { code: 0 });
}

// A value from the project's .env in what a push sends out (docs/design/antigravity-roles.md): the hub's own commits and
// merges hold one (holdSecrets, secretMerge), but an engine that writes git itself in the main checkout (Antigravity,
// Claude Code) commits without the hub, so every push looks too. What goes out is every commit from origin's copy of the
// branch (else the merge base with origin's base branch, else the branch's whole history) to the commit pushed, each
// compared with its parent: a value a commit added and a later one took out still goes out with that commit. A value
// origin has already holds no later push. The approval of a deploy branch's push is not an approval of a value its card
// didn't show: this runs for it too. -> { ok: true } | { held: detail } | { rejected: detail }
const PUSH_SCAN_MAX = 300; // commits looked at one by one; a longer range is read as one change (and the log says so)
function pushSecrets(job, { sha, there, originBase, target, from }) {
  const values = envSecrets();
  const known = (c) => COMMIT_RE.test(String(c)) && git(['cat-file', '-e', `${c}^{commit}`], { allowFail: true }).ok;
  const base = there && known(there) ? there : known(originBase) ? git(['merge-base', '--end-of-options', originBase, sha], { allowFail: true }).out : '';
  if (base === sha) return { ok: true };
  const commits = gitLines(['rev-list', '--reverse', '--end-of-options', sha, ...(COMMIT_RE.test(base) ? [`^${base}`] : [])]).filter((c) => COMMIT_RE.test(c));
  if (!commits.length) return { ok: true };
  let found = [];
  if (commits.length > PUSH_SCAN_MAX) {
    log(`${job.id}: ${commits.length} commits go out: looked at for .env values as one change (more than ${PUSH_SCAN_MAX} to read one by one)`);
    found = secretFindings(rawChanges([COMMIT_RE.test(base) ? base : emptyTree(), sha]), values);
  } else {
    const seen = new Set();
    for (const c of commits) {
      const parent = git(['rev-parse', '--verify', '--quiet', `${c}^1`], { allowFail: true }).out;
      // (a merge commit: a file whose content is its other parent's is what that parent brought in, `git merge` of main,
      // not new on this branch)
      const others = gitLines(['rev-list', '--parents', '-n', '1', '--end-of-options', c]).join(' ').split(/\s+/).slice(2).filter((x) => COMMIT_RE.test(x));
      const fromOther = (f) => others.some((o) => git(['rev-parse', '--verify', '--quiet', `${o}:${f.e.path}`], { allowFail: true }).out === f.e.newBlob);
      for (const f of secretFindings(rawChanges([COMMIT_RE.test(parent) ? parent : emptyTree(), c]), values)) {
        if (others.length && fromOther(f)) continue;
        const k = `${f.e.path}\n${f.a.hash}`;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push(f);
      }
    }
  }
  if (!found.length) return { ok: true };
  const store = guard();
  const names = found.map((f) => f.e.path);
  const shown = found.filter((f) => !f.env).map((f) => f.e.path); // (a .env file's content is never shown)
  const diff = shown.length ? gitDiff([COMMIT_RE.test(base) ? base : emptyTree(), sha, '--', ...shown]) : '';
  const { item, fresh } = store.held.add(secretRecord(found, values, diff, { on: 'push', job: job.id, sha, base: base || '', target, from, by: `a push to ${target}`, message: '', task: '' }));
  const what = item.env ? `a .env file (${listFiles(names)}), which never goes out` : `${valueWords(item)} in ${listFiles(names)}`;
  if (item.status === 'rejected') return { rejected: `the commits of ${from} carry ${what}, and the owner rejected that (${item.id})${item.reason ? `: "${item.reason}"` : ''}. Take it out of those commits (git revert, or rewrite the branch before it is pushed), then push again` };
  if (['approved', 'applied'].includes(item.status)) return { ok: true };
  const card = fresh ? raiseCard(item) : item.card;
  return { held: `not pushed: the commits of ${from} carry ${what}: nextlevel pushes it only once the owner approves that on the dashboard (${item.id}${card ? `, card ${card}` : ''}); the card never shows the value. Carry on with other work; once the owner decides, push again` };
}

// What a push changes in protected files, compared with origin's base branch: merge-base(<origin's base>, <sha>)..<sha>,
// read as a task's merge is read (guardMerge). Origin's, not the local base branch: the slots are worktrees of the main
// checkout and share its refs, so a worker can move the local one (git update-ref). With no common history, or no
// origin's base here, it is compared with nothing (the empty tree): every protected file on the branch counts. Nothing
// for a push of what origin's base branch has already, or of a branch whose protected files are origin's base's. The owner decides each change once: a change approved on a task's merge card or on a push's
// card, or content the owner made or approved, counts as approved here; one the owner rejected on either card stands.
// Records are matched by the files' key (each file's path, and its content before and after: sameChange) and, when the
// branch is task/<id>, by the task too. -> { files, names, key, task, versions, base, held, approved, rejected }
// (rejected: why the push is refused, or '')
function pushProtected(sha, from, originBase = '') {
  const task = /^task\/(.+)$/.exec(from)?.[1] || '';
  const none = { files: [], names: [], key: '', task, versions: [], base: '', held: false, approved: null, rejected: '' };
  if (!COMMIT_RE.test(String(sha))) return none;
  const known = COMMIT_RE.test(String(originBase)) && git(['cat-file', '-e', `${originBase}^{commit}`], { allowFail: true }).ok;
  const common = known ? git(['merge-base', '--end-of-options', originBase, sha], { allowFail: true }).out : '';
  if (common === sha) return none; // origin's base branch has it already
  const base = COMMIT_RE.test(String(common)) ? common : emptyTree();
  if (!base) return none;
  const entries = protectedEntries();
  const changes = rawChanges([base, sha]).filter((e) => isProtected(e.path, entries));
  if (!changes.length) return { ...none, base };
  const store = guard();
  // A file whose content the owner made or approved (a merge or commit approved before, the Team page...) needs no
  // decision: the change is the rest. (Origin's base branch can be behind the main checkout's, which has the approved
  // merges that aren't pushed yet; what is left is then what a task's merge card would show.)
  const versions = changes.map((e) => ({ e, b: gitVersion(e.oldMode, e.oldBlob), a: gitVersion(e.newMode, e.newBlob) })).filter(({ e, a }) => !approvedBlob(store, e, a));
  if (!versions.length) return { ...none, base, approved: { id: '', kind: 'content' } };
  const files = versions.map(({ e, b, a }) => ({ path: e.path, before: b.hash, after: a.hash, ...(a.link !== undefined ? { link: a.link } : {}) }));
  const names = files.map((f) => f.path);
  const key = store.keyOf(files);
  const twins = sameChange(store.held.list(), key, task);
  const out = { files, names, key, task, versions, base, held: false, approved: null, rejected: '' };
  // Content the owner rejected on disk (an orchestrator that writes git itself, Antigravity's, committed a protected file
  // during its session: the guard set it back on disk and held it; a reject keeps that commit from going out)
  const gone = rejectedOnDisk(store, versions);
  if (gone) {
    const commit = commitWith(base, sha, gone.path, gone.after);
    return { ...out, rejected: `the owner rejected this change to ${gone.path} (${gone.rec.id}${gone.rec.card ? `, card ${gone.rec.card}` : ''}: a change during ${gone.rec.by || 'a session'})${gone.rec.reason ? `: "${gone.rec.reason}"` : ''}, and ${commit ? `commit ${short(commit)} on ${from}` : `${from}`} still has it. Revert it (git revert ${commit ? short(commit) : '<that commit>'}), then push again` };
  }
  const no = twins.find((x) => x.status === 'rejected');
  if (no) {
    const where = no.kind === 'merge' ? `on task ${no.task}'s merge card` : `on the card of a push to ${no.target}`;
    return { ...out, rejected: `the owner rejected this change to ${listFiles(names)} ${where} (${no.id}${no.card ? `, card ${no.card}` : ''})${no.reason ? `: "${no.reason}"` : ''}. Push the work without that change (a task of its own is best), or ask the owner` };
  }
  out.approved = twins.find(approvedChange) || null;
  out.held = !out.approved;
  return out;
}
// A protected file's content in what a push carries that the owner rejected as a change on disk (the guard's 'disk'
// records): { path, after, rec } or null. Compared as git checks the file out too (approvedBlob: line endings)
function rejectedOnDisk(store, versions) {
  const rejected = store.held.list().filter((x) => x.kind === 'disk' && x.status === 'rejected');
  if (!rejected.length) return null;
  for (const { e, a } of versions) {
    const hashes = new Set([a.hash]);
    if (a.buf && /^[0-9a-f]{40,64}$/.test(String(e.newBlob))) {
      const r = spawnSync('git', ['cat-file', '--filters', `--path=${e.path}`, e.newBlob], { cwd: ROOT, env: readEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0) hashes.add(contentHash({ buf: r.stdout }));
    }
    for (const rec of rejected) {
      const f = (rec.files || []).find((x) => pathKey(x.path) === pathKey(e.path) && hashes.has(x.after));
      if (f) return { path: e.path, after: f.after, rec };
    }
  }
  return null;
}
// The newest commit in base..sha that gave `rel` that content (a guard hash), or ''
function commitWith(base, sha, rel, after) {
  const range = [sha, ...(COMMIT_RE.test(String(base)) ? [`^${base}`] : [])];
  for (const c of gitLines(['rev-list', '--max-count=50', '--end-of-options', ...range, '--', rel]).filter((x) => COMMIT_RE.test(x))) {
    const parent = git(['rev-parse', '--verify', '--quiet', `${c}^1`], { allowFail: true }).out;
    const e = rawChanges([COMMIT_RE.test(parent) ? parent : emptyTree(), c, '--', rel]).find((x) => pathKey(x.path) === pathKey(rel));
    if (!e) continue;
    const v = gitVersion(e.newMode, e.newBlob);
    if (v.hash === after) return c;
    if (v.buf) {
      const r = spawnSync('git', ['cat-file', '--filters', `--path=${rel}`, e.newBlob], { cwd: ROOT, env: readEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
      if (r.status === 0 && contentHash({ buf: r.stdout }) === after) return c;
    }
  }
  return '';
}
// The commit on the main checkout's HEAD that has a change on disk the guard held (the session committed it itself):
// { commit, path } or null
function diskCommit(rec) {
  const head = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }).out;
  if (!COMMIT_RE.test(head)) return null;
  for (const f of rec.files || []) {
    if (!f.after || f.after === ABSENT) continue;
    const commit = commitWith('', head, f.path, f.after);
    if (commit) return { commit, path: f.path };
  }
  return null;
}
// A record whose approval of its change counts elsewhere: a merge's once the owner approved it, a push's once it went out
// exactly as its card showed (an approved push whose branch moved before it went out is superseded, and asks again)
const approvedChange = (x) => (x.kind === 'merge' ? ['approved', 'applied'].includes(x.status) : x.status === 'applied');
// Whether a file's version in git is content the owner made or approved. The owner's own writes are recorded as they are
// on disk (recordOwn), which can differ from git's copy by its line endings (core.autocrlf: START.cmd is CRLF on disk and
// LF in git on Windows), so git's copy is also compared as git would check it out.
function approvedBlob(store, e, a) {
  if (store.isApproved(e.path, a.hash)) return true;
  if (!a.buf || !/^[0-9a-f]{40,64}$/.test(String(e.newBlob))) return false;
  const r = spawnSync('git', ['cat-file', '--filters', `--path=${e.path}`, e.newBlob], { cwd: ROOT, env: readEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 && !r.stdout.equals(a.buf) && store.isApproved(e.path, contentHash({ buf: r.stdout }));
}
// git's empty tree (what a branch with no common history is compared with), for this repository's hash
let EMPTY_TREE = '';
function emptyTree() {
  if (!EMPTY_TREE) {
    const r = spawnSync('git', ['hash-object', '-t', 'tree', '--stdin'], { cwd: ROOT, env: readEnv(), input: '', encoding: 'utf8', windowsHide: true });
    const id = String(r.stdout || '').trim();
    if (r.status === 0 && COMMIT_RE.test(id)) EMPTY_TREE = id;
  }
  if (!EMPTY_TREE) throw new Error("git couldn't name the empty tree, so what the push changes in protected files can't be read");
  return EMPTY_TREE;
}
// The records of one change to protected files, on a task's merge card or a push's card: the same files' key, and the
// same task when both name one
function sameChange(items, key, task) {
  if (!key) return [];
  return items.filter((x) => (x.kind === 'merge' ? x.key === key : x.kind === 'push' && x.filesKey === key) && (!task || !x.task || x.task === task));
}

// A push waits for the owner when it goes to a deploy branch, or carries a change to protected files the owner hasn't
// approved, or both (one card that says both): a record in the guard's store (outside the project) and a card, with the
// branch, how many commits would go out and since when, the newest one's message, and each protected file's change in
// plain words and as a diff. Only the owner's approval on the dashboard pushes it, and exactly this commit. One card per
// branch: a newer state of it replaces an older card.
function holdPush(job, { target, from, sha, there, range, why, prot = null, again = null }, end) {
  const store = guard();
  const deploy = !!why;
  const changes = prot?.held ? prot : null;
  const key = `push\n${target}\n${from}\n${sha}\n${there}`;
  const mine = store.held.list().filter((x) => x.kind === 'push' && x.target === target);
  const waiting = mine.find((x) => x.key === key && x.status === 'approved');
  if (waiting) return end('blocked', `not pushed yet: the owner approved exactly this push already (${waiting.id}${waiting.card ? `, card ${waiting.card}` : ''}): the hub pushes it`);
  for (const x of mine.filter((y) => y.status === 'held' && y.key !== key)) {
    store.held.update(x.id, { status: 'superseded', decidedAt: now(), detail: `${target} or ${REMOTE}'s ${target} moved since: a newer card asks` }, { expect: ['held'] });
    cards().handoff.decideGuard(x.id, { reply: `Not pushed: ${from} or ${REMOTE}'s ${target} moved since this card was made; a newer card asks again`, hub: true });
  }
  const values = envSecrets(); // (commit messages go on the card and in the log as they are, less any value from .env)
  const clean = (s) => redactSecrets(String(s ?? ''), values);
  // (who asked is what the job says: the orchestrator can write the queue, so the card never vouches for it)
  const who = `the ${job.by || '?'}${job.source ? `, ${job.source}` : ''}`;
  const one = changes?.names.length === 1;
  const protWhy = changes ? `it changes protected ${one ? 'file' : 'files'} (${listFiles(changes.names)}) compared with ${REMOTE}'s ${CFG.base}, and you haven't approved that change: GitHub runs a pushed branch's own workflows, and the agents and your tools load these files outside any sandbox` : '';
  const summary = [
    deploy ? `Push to ${target} on ${REMOTE} (${remoteShown() || REMOTE}), a deploy branch: ${why}${changes ? `; and ${protWhy}` : ''}` : `Push to ${target} on ${REMOTE} (${remoteShown() || REMOTE}): ${protWhy}`,
    there
      ? `${range.count} commit(s) would go out, the oldest from ${day(range.oldest)}; ${REMOTE}'s ${target} is at ${short(there)} now`
      : `${target} isn't on ${REMOTE} yet: all ${range.count} commit(s) of ${from} would go out, the oldest from ${day(range.oldest)}`,
    `The newest: ${range.newest.short} (${range.newest.date}) "${clean(range.newest.subject)}"`,
    `What goes out: ${from} at ${short(sha)}, exactly that commit. If ${from} or ${REMOTE}'s ${target} moves before the push, nothing is pushed and a new card asks again`,
    `The push job ${job.id} says it was asked by ${who}`,
    ...(changes ? [`What it changes in protected files, compared with ${REMOTE}'s ${CFG.base}:`, ...describeChanges(changes.versions.map(({ e, b, a }) => describeInput(e.path, b, a)))] : []),
    ...(again ? [`This card asks again: ${again.moved} after you approved ${again.rec.id}${again.rec.card ? ` (card ${again.rec.card})` : ''}`] : []),
  ];
  // The card's diff: the protected files' exact change when there is one (the commits go in log), else the commits
  const commits = shownDiff(clean(range.log));
  const shown = changes ? { ...shownDiff(gitDiff([changes.base, sha, '--', ...changes.names])), log: commits.diff, logCut: commits.diffCut } : commits;
  const { item, fresh } = store.held.add({ kind: 'push', deploy, by: job.by || '', source: job.source || '', job: job.id, task: changes?.task || '', files: changes ? changes.files : [], filesKey: changes?.key || '', target, from, sha, there, count: range.count, oldest: range.oldest, newest: { ...range.newest, subject: clean(range.newest.subject) }, why, key, summary, ...shown });
  if (!fresh && item.status === 'rejected') {
    return end('failed', `not pushed: the owner rejected exactly this push to ${target} (${item.id}${item.card ? `, card ${item.card}` : ''})${item.reason ? `: "${item.reason}"` : ''}. Don't ask again unless the owner says so`);
  }
  const card = fresh ? raiseCard(item) : item.card;
  const because = deploy ? `${target} is a deploy branch${changes ? ` and the push changes ${listFiles(changes.names)}, protected` : ''}` : `the push changes ${listFiles(changes.names)}, protected ${one ? 'file' : 'files'}`;
  const own = changes ? ". A change to a protected file is best in a task of its own, so the rest of the work isn't held with it" : '';
  return end('blocked', `not pushed yet: ${because}, so the owner approves the push first, on the dashboard (${item.id}${card ? `, card ${card}` : ''}): ${range.count} commit(s) of ${from} at ${short(sha)}. Only that approval pushes it; carry on with other work meanwhile${own}`, { card: card || '', approval: '' });
}

// One change, one decision: once the owner has decided a change to protected files on a task's merge card or on a push's
// card, another card still asking about that same change (sameChange) is closed, saying where it was decided; the task or
// the push job it held is told what follows
function settleTwins(rec, action, why) {
  const key = rec.kind === 'merge' ? rec.key : rec.filesKey;
  if (!key) return;
  const store = guard();
  const verb = action === 'approve' ? 'approved' : 'rejected';
  const on = rec.kind === 'merge' ? `task ${rec.task}'s merge card` : `the card of a push to ${rec.target}`;
  for (const x of sameChange(store.held.list(), key, rec.task || '').filter((y) => y.id !== rec.id && y.status === 'held')) {
    const names = listFiles(namesOf(x));
    try {
      store.held.update(x.id, { status: 'superseded', decidedAt: now(), detail: `the owner ${verb} this change on ${on} (${rec.id})` }, { expect: ['held'] });
    } catch (err) {
      log(`guard: ${x.id} wasn't closed with ${rec.id}: ${err.message}`); // (decided meanwhile: its own decision stands)
      continue;
    }
    cards().handoff.decideGuard(x.id, { reply: `Decided on ${on} (${rec.id}${rec.card ? `, card ${rec.card}` : ''}): the owner ${verb} this change there${why ? `: ${why}` : ''}`, hub: true });
    log(`guard: ${x.id} closed: the owner ${verb} the same change on ${rec.id}`);
    if (x.kind === 'merge' && x.task && jobStatus(x.task)) {
      if (action === 'approve') setStatus(x.task, { held: null, acked: false, detail: `the owner approved its change to ${names} on ${on} (${rec.id}): merge it again (nextlevel merge ${x.task}); it needs no second approval` });
      else setStatus(x.task, { state: 'failed', held: null, finishedAt: now(), acked: false, detail: `the owner rejected its change to ${names} on ${on} (${rec.id})${why ? `: "${why}"` : ''}. Retry it without that change: nextlevel retry ${x.task} --feedback "..."` });
    }
    if (x.kind === 'push' && x.job && jobStatus(x.job)) {
      const again = x.deploy !== false ? `push again: ${x.target} is a deploy branch, so a card asks for the push itself` : 'push again: it needs no card for that change';
      setStatus(x.job, { state: 'failed', acked: false, detail: action === 'approve' ? `not pushed: the owner approved its change to ${names} on ${on} (${rec.id}); ${again}` : `not pushed: the owner rejected its change to ${names} on ${on} (${rec.id})${why ? `: "${why}"` : ''}` });
    }
  }
}

// The owner's decision on a push's card (guardDecide, the dashboard only): Approve queues exactly that push for the hub,
// whose pushBranch pushes it only while the branch and origin's are where the card showed them (else a new card asks
// again); Reject pushes nothing, and the push job says so.
function pushDecide(rec, action, why) {
  const store = guard();
  const later = hubAlive() ? '' : ' The hub is not running: it does it when it starts.';
  if (action === 'reject') {
    store.held.update(rec.id, { status: 'rejected', decidedAt: now(), reason: why }, { expect: ['held'] });
    cards().handoff.decideGuard(rec.id, { reply: `Rejected${why ? `: ${why}` : ''}. Nothing was pushed to ${rec.target}` });
    if (rec.job && jobStatus(rec.job)) setStatus(rec.job, { state: 'failed', acked: false, detail: `not pushed: the owner rejected the push to ${rec.target} (${rec.id}${rec.card ? `, card ${rec.card}` : ''})${why ? `: "${why}"` : ''}` });
    pushLog({ job: rec.job, by: rec.by, source: rec.source, target: rec.target, from: rec.from, sha: rec.sha, there: rec.there, count: rec.count, approval: rec.id, card: rec.card, state: 'rejected', detail: 'the owner rejected it on the dashboard: nothing was pushed' });
    settleTwins(rec, 'reject', why);
    return { message: `Rejected: nothing was pushed to ${rec.target}. The orchestrator sees your answer on its card.` };
  }
  store.held.update(rec.id, { status: 'approved', decidedAt: now(), reason: why }, { expect: ['held'] });
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${rec.from}^{commit}`], { allowFail: true }).out;
  enqueue({ id: `push-${rec.id}-${uniq()}`, type: 'push', target: rec.target, from: rec.from, approval: rec.id, guard: rec.id, by: 'owner', source: `the owner's approval on the dashboard of ${rec.job}, which says the ${rec.by || '?'} asked` });
  log(`guard: the owner approved ${rec.id}: the push of ${short(rec.sha)} to ${rec.target}`);
  if (tip !== rec.sha) {
    cards().handoff.decideGuard(rec.id, { reply: `Approved, but ${rec.from} moved since this card was made: nothing is pushed, and a new card asks again` });
    return { message: `${rec.from} moved since this card was made (it is at ${short(tip)} now), so nothing is pushed: the hub makes a new card with what would go out now, and asks again.${later}` };
  }
  cards().handoff.decideGuard(rec.id, { reply: `Approved: the hub pushes ${short(rec.sha)} to ${rec.target}` });
  return { message: `Approved: the hub pushes exactly ${short(rec.sha)} to ${rec.target} on ${REMOTE} (${rec.count} commit(s)), if ${REMOTE}'s ${rec.target} is still where the card showed it; if anything moved, nothing is pushed and a new card asks again.${later}` };
}

// The orchestrator's git writes (cmdCommit, cmdMerge, cmdCleanup), in the main checkout. Each returns
// { ok, detail }; `run(args)` runs git with its output in the job's git.log. What went wrong is found out
// from git's state, never from its messages: those are in the owner's language.
const lines = (out) => String(out || '').split(/\r?\n/).filter(Boolean);
const lastLine = (out) => String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) || 'no output';
const merging = () => fs.existsSync(path.resolve(ROOT, git(['rev-parse', '--git-path', 'MERGE_HEAD'], { allowFail: true }).out || '.git/MERGE_HEAD'));
function notReady() {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { allowFail: true }).out;
  if (branch !== CFG.base) return `the main checkout is on "${branch}", not "${CFG.base}"`;
  if (merging()) return `a merge is in progress in the main checkout (the owner can finish it, or undo it: git merge --abort)`;
  return '';
}
// ---------- the guard: protected files (lib/protect.mjs, lib/guard.mjs) ----------
// Files that steer the agents and the owner's tools outside any sandbox change only with the owner's approval. The
// hub holds a commit or a merge that changes one; around everything the orchestrator does (an autopilot round, its
// window, a check or git job it asked for) it watches them on disk and sets a change back at once. Each held change
// is a record in ~/.nextlevel/guard/<project>/ (the orchestrator's sandbox can't write there) and a handoff card; the
// owner approves or rejects exactly that change on the dashboard, and nowhere else.
// (and the project's own checks, .nextlevel/checks/: the doctor runs them outside any sandbox, and the orchestrator
// can write the state folder)
const protectedEntries = () => [...protectedList(CFG.config).entries, `${slash(path.relative(ROOT, DIR))}/checks/`];
let GUARD = null; // { root, store }
const guard = () => (GUARD?.root === ROOT ? GUARD.store : (GUARD = { root: ROOT, store: guardStore({ root: ROOT, entries: protectedEntries }) }).store);
let guardPaused = 0; // while the hub itself writes an approved change (a merge, an apply), the watch waits
const listFiles = (files) => (files.length <= 3 ? files.join(', ') : `${files.slice(0, 3).join(', ')} and ${files.length - 3} more`);

// (File names come from a worker's branch or the orchestrator's files: the guard's git takes them as literal paths,
// never as pathspec magic such as ":(exclude)".)
// A blob's bytes (git cat-file), or null
function gitBlob(blob) {
  if (!/^[0-9a-f]{40,64}$/.test(String(blob))) return null; // (an object id from git's own output, nothing else)
  const r = spawnSync('git', ['cat-file', 'blob', blob], { cwd: ROOT, env: readEnv(), windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
// A version of a file in git by its mode and blob id: { hash, buf, link, submodule } (hash '-' when it isn't there;
// one git can't hand over, too large say, gets a hash no content has, so it is never taken as approved)
function gitVersion(mode, blob) {
  if (!blob || /^0+$/.test(blob)) return { hash: ABSENT, buf: null };
  if (mode === '160000') return { hash: contentHash({ submodule: blob }), buf: null, submodule: blob };
  const buf = gitBlob(blob);
  if (!buf) return { hash: contentHash({ unreadable: blob }), buf: null };
  if (mode === '120000') return { hash: contentHash({ link: buf.toString('utf8') }), buf: null, link: buf.toString('utf8') };
  return { hash: contentHash({ buf }), buf };
}
// The files the hub's commit since `before` gave a .env value or that are a .env file (read again at commit time)
const secretsSince = (before) => (before ? secretFindings(rawChanges([before, 'HEAD']), envSecrets()).map((f) => f.e.path) : []);
// The protected files the hub's commit since `before` changed to content nobody approved (a file changed between the
// guard's look and the commit, or by a hook)
function unapprovedSince(before) {
  if (!before) return [];
  const store = guard();
  const entries = protectedEntries();
  return rawChanges([before, 'HEAD'])
    .filter((e) => isProtected(e.path, entries) && !store.isApproved(e.path, gitVersion(e.newMode, e.newBlob).hash))
    .map((e) => e.path);
}
// A file's version on the base branch now (the main checkout's HEAD)
function headVersion(rel) {
  const r = spawnSync('git', ['--literal-pathspecs', 'ls-tree', '-z', 'HEAD', '--', rel], { cwd: ROOT, env: readEnv(), encoding: 'utf8', windowsHide: true });
  const m = (r.stdout || '').match(/^(\d{6}) \w+ ([0-9a-f]+)\t/);
  return m ? gitVersion(m[1], m[2]) : { hash: ABSENT, buf: null };
}
// `git diff --raw -z` as a list: [{ path, oldMode, newMode, oldBlob, newBlob, status }] (`cwd`: a slot, for its index)
function rawChanges(args, cwd = ROOT) {
  const r = spawnSync('git', ['diff', '--raw', '-z', '--no-renames', '--no-abbrev', '--no-ext-diff', '--no-textconv', ...args], { cwd, env: readEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  const parts = (r.stdout || '').split('\0');
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const m = parts[i].match(/^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])/);
    if (m && parts[i + 1] !== undefined) out.push({ oldMode: m[1], newMode: m[2], oldBlob: m[3], newBlob: m[4], status: m[5], path: parts[++i] });
  }
  return out;
}
const isBinaryBuf = (buf) => !!buf && buf.subarray(0, 8000).includes(0);
// A git change's plain words (lib/protect.mjs describeChange's input)
function describeInput(p, b, a) {
  const binary = isBinaryBuf(b.buf) || isBinaryBuf(a.buf);
  const text = (v) => (v.hash === ABSENT ? null : binary ? '' : v.buf ? v.buf.toString('utf8') : '');
  return {
    path: p,
    before: text(b),
    after: text(a),
    binary,
    size: a.buf?.length || 0,
    submodule: !!(a.submodule || b.submodule),
    link: { ...(b.link !== undefined ? { before: b.link } : {}), ...(a.link !== undefined ? { after: a.link } : {}) },
  };
}
const gitDiff = (args, cwd = ROOT) => spawnSync('git', ['--literal-pathspecs', 'diff', '--no-color', '--no-ext-diff', '--no-textconv', ...args], { cwd, env: readEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).stdout || '';

// A protected file staged in the orchestrator's commit is held, unless its content is one the owner made or approved:
// it is taken out of the commit and set back to the base branch's version on disk, and the owner gets a card.
// -> { detail } (what was held; '' when nothing), or { error }
async function holdStaged(job, paths, run) {
  const store = guard();
  const entries = protectedEntries();
  const staged = rawChanges(['--cached', ...paths]).filter((e) => isProtected(e.path, entries));
  const held = [];
  for (const e of staged) {
    const b = gitVersion(e.oldMode, e.oldBlob);
    const a = gitVersion(e.newMode, e.newBlob);
    if (store.isApproved(e.path, a.hash)) continue; // the owner's own content, or approved before
    held.push({ e, b, a });
  }
  if (!held.length) return { detail: '' };
  const files = held.map(({ e, b, a }) => {
    if (a.buf) store.putBlob(a.buf);
    return { path: e.path, before: b.hash, after: a.hash, ...(a.link !== undefined ? { link: a.link } : {}) };
  });
  const names = files.map((f) => f.path);
  const diff = gitDiff(['--cached', '--', ...names]);
  // Out of the commit, and back to the base branch's version on disk (never live while it waits)
  const reset = await run(['--literal-pathspecs', 'reset', '-q', '--', ...names]);
  if (reset.code !== 0) return { error: `couldn't take ${listFiles(names)} out of the commit: ${lastLine(reset.out)}` };
  guardPaused += 1;
  try {
    for (const { e, b } of held) {
      const file = inProject(ROOT, e.path);
      const link = linkOnTheWay(ROOT, e.path);
      if (link) return { error: `held ${e.path}, but ${link} is a link now: nothing is written or removed through it. The owner can put the folder back` };
      if (b.hash === ABSENT) fs.rmSync(file, { force: true });
      else {
        const back = await run(['--literal-pathspecs', 'checkout', 'HEAD', '--', e.path]);
        if (back.code !== 0) return { error: `held ${e.path}, but couldn't set it back to ${CFG.base}'s version: ${lastLine(back.out)}` };
      }
    }
    store.accept(names);
  } finally {
    guardPaused -= 1;
  }
  const { item, fresh } = store.held.add({ kind: 'commit', job: job.id, by: "the orchestrator's commit", message: job.message, task: '', files, summary: describeChanges(held.map(({ e, b, a }) => describeInput(e.path, b, a))), ...shownDiff(diff) });
  const card = fresh ? raiseCard(item) : item.card;
  log(`${job.id}: held ${names.join(', ')} for the owner's approval (${item.id})`);
  return { detail: `held ${listFiles(names)} for the owner's approval (${item.id}${card ? `, card ${card}` : ''}): a protected file changes only once the owner approves it on the dashboard. It is set back to ${CFG.base}'s version meanwhile; when the owner approves, the hub commits it` };
}

// A .env file, or a file with a value from .env, staged in the orchestrator's commit is taken out of it (it stays on disk
// as it is) and held for the owner, the value hidden on the card. -> { detail } or { error }
async function holdSecrets(job, paths, run) {
  const values = envSecrets();
  const found = secretFindings(rawChanges(['--cached', ...paths]), values);
  if (!found.length) return { detail: '' };
  const names = found.map((f) => f.e.path);
  const shown = found.filter((f) => !f.env).map((f) => f.e.path); // (a .env file's content is never shown)
  const diff = shown.length ? gitDiff(['--cached', '--', ...shown]) : '';
  const reset = await run(['--literal-pathspecs', 'reset', '-q', '--', ...names]);
  if (reset.code !== 0) return { error: `couldn't take ${listFiles(names)} out of the commit: ${lastLine(reset.out)}` };
  const { item, fresh } = guard().held.add(secretRecord(found, values, diff, { on: 'commit', job: job.id, by: "the orchestrator's commit", message: job.message, task: '' }));
  const card = fresh ? raiseCard(item) : item.card;
  log(`${job.id}: held ${names.join(', ')} (${item.env ? 'a .env file' : 'a value from .env'}) for the owner (${item.id})`);
  if (item.status === 'rejected') return { detail: `${listFiles(names)} not committed: the owner rejected it (${item.id})${item.reason ? `: "${item.reason}"` : ''}` };
  return { detail: `held ${listFiles(names)}: ${item.env ? 'a .env file is never committed' : `it has ${valueWords(item)}`} (${item.id}${card ? `, card ${card}` : ''}). It stays on disk, uncommitted, until the owner decides; the card never shows the value` };
}

// The same for the hub's commit of what a worker left in its slot (FR-008): those files are taken out of the commit and
// out of the slot (their content is kept with the guard, outside the project), and held for the owner; the attempt
// fails with why. Approve commits them on the task's branch. -> { detail } or { error, what }
function holdSlotSecrets(id, job, wt, slot) {
  const values = envSecrets();
  const found = secretFindings(rawChanges(['--cached'], wt), values);
  if (!found.length) return { detail: '' };
  const names = found.map((f) => f.e.path);
  const shown = found.filter((f) => !f.env).map((f) => f.e.path);
  const diff = shown.length ? gitDiff(['--cached', '--', ...shown], wt) : '';
  const reset = slotGit(id, ['--literal-pathspecs', 'reset', '-q', '--', ...names], { cwd: wt, slot });
  if (!reset.ok) return { error: reset, what: listFiles(names) };
  for (const f of found) {
    if (linkOnTheWay(wt, f.e.path)) continue; // (never removed through a folder the worker made a link)
    if (f.b.hash === ABSENT) fs.rmSync(inProject(wt, f.e.path), { force: true });
    else slotGit(id, ['--literal-pathspecs', 'checkout', '--', f.e.path], { cwd: wt, slot });
  }
  const { item, fresh } = guard().held.add(secretRecord(found, values, diff, { on: 'slot', task: id, job: id, attempt: job.attempt || 1, by: `task ${id}` }));
  const card = fresh ? raiseCard(item) : item.card;
  setStatus(id, { held: { id: item.id, card: card || '', files: names, at: item.createdAt, text: heldText(item, card) } });
  log(`${id}: held ${names.join(', ')} (${item.env ? 'a .env file' : 'a value from .env'}) out of the hub's commit (${item.id})`);
  return { detail: `held ${listFiles(names)}: ${item.env ? 'a .env file, which is never committed' : `the worker's changes put ${valueWords(item)} in ${listFiles(names)}`}; nothing of that was committed (${item.id}${card ? `, card ${card}` : ''}), and the owner approves or rejects it on the dashboard` };
}

// A task's merge and the .env values or .env files it brings. -> { ok: true }, { ok: true, approved } or { ok: false, detail }
function secretMerge(job, tip) {
  const task = job.task;
  const base = git(['merge-base', 'HEAD', tip], { allowFail: true }).out;
  if (!base) return { ok: true };
  const store = guard();
  const values = envSecrets();
  const mine = () => store.held.list().filter((x) => x.kind === 'secret' && x.on === 'merge' && x.task === task && x.sha === tip);
  const approved = mine().find((x) => ['approved', 'applied'].includes(x.status));
  if (approved) return { ok: true, approved };
  const found = secretFindings(rawChanges([base, tip]), values);
  if (!found.length) return { ok: true };
  const names = found.map((f) => f.e.path);
  const shown = found.filter((f) => !f.env).map((f) => f.e.path);
  const { item, fresh } = store.held.add(secretRecord(found, values, shown.length ? gitDiff([base, tip, '--', ...shown]) : '', { on: 'merge', task, job: job.id, sha: tip, base, message: job.message || '', by: `task ${task}` }));
  if (item.status === 'rejected') return { ok: false, detail: `not merged: the owner rejected ${task}'s ${item.env ? '.env file' : `${valueWords(item).replace(/^the /, '')}`} in ${listFiles(names)} (${item.id})${item.reason ? `: "${item.reason}"` : ''}. Retry it without that: nextlevel retry ${task} --feedback "..."` };
  const card = fresh ? raiseCard(item) : item.card;
  if (jobStatus(task)) setStatus(task, { held: { id: item.id, card: card || '', files: names, at: item.createdAt, text: heldText(item, card) } });
  return {
    ok: false,
    detail: `held: ${task} ${item.env ? `has a .env file (${listFiles(names)}), which is never committed` : `puts ${valueWords(item)} in ${listFiles(names)}`}: nextlevel merges it only once the owner approves that on the dashboard (${item.id}${card ? `, card ${card}` : ''}). Carry on with other tasks; when the owner rejects it, ${task} comes back to you with the owner's reason.`,
  };
}

// A task's merge and the protected paths it changes. -> { ok: true } (none), { ok: true, approved } (the owner approved
// exactly this change, on this merge's card or on the card of a push that carried it: sameChange) or { ok: false, detail }
// (held for the owner, or rejected on either card)
function guardMerge(job, tip) {
  const task = job.task;
  const base = git(['merge-base', 'HEAD', tip], { allowFail: true }).out;
  if (!base) return { ok: true };
  const entries = protectedEntries();
  const changes = rawChanges([base, tip]).filter((e) => isProtected(e.path, entries));
  if (!changes.length) return { ok: true };
  const store = guard();
  const versions = changes.map((e) => ({ e, b: gitVersion(e.oldMode, e.oldBlob), a: gitVersion(e.newMode, e.newBlob) }));
  const files = versions.map(({ e, b, a }) => ({ path: e.path, before: b.hash, after: a.hash, ...(a.link !== undefined ? { link: a.link } : {}) }));
  const names = files.map((f) => f.path);
  const key = store.keyOf(files);
  const all = store.held.list();
  const mine = all.filter((x) => x.kind === 'merge' && x.task === task && x.key === key);
  const pushed = sameChange(all, key, task).filter((x) => x.kind === 'push');
  const own = mine.find((x) => ['approved', 'applied'].includes(x.status));
  if (own) return { ok: true, approved: own };
  const approved = pushed.find(approvedChange);
  const rejected = mine.find((x) => x.status === 'rejected') || pushed.find((x) => x.status === 'rejected');
  if (rejected) return { ok: false, detail: `not merged: the owner rejected ${task}'s change to ${listFiles(names)} (${rejected.id}${rejected.kind === 'push' ? `, on the card of a push to ${rejected.target}` : ''})${rejected.reason ? `: "${rejected.reason}"` : ''}. Retry it without that change: nextlevel retry ${task} --feedback "..."` };
  if (approved) return { ok: true, approved };
  const { item, fresh } = store.held.add({ kind: 'merge', task, job: job.id, sha: tip, base, message: job.message || '', by: `task ${task}`, files, key, summary: describeChanges(versions.map(({ e, b, a }) => describeInput(e.path, b, a))), ...shownDiff(gitDiff([base, tip, '--', ...names])) });
  const card = fresh ? raiseCard(item) : item.card;
  if (jobStatus(task)) setStatus(task, { held: { id: item.id, card: card || '', files: names, at: item.createdAt, text: heldText(item, card) } });
  return {
    ok: false,
    detail:
      `held: ${task} changes ${listFiles(names)}, protected ${names.length === 1 ? 'file' : 'files'}: nextlevel merges it only once the owner approves that change on the dashboard (${item.id}${card ? `, card ${card}` : ''}). ` +
      `Carry on with other tasks. When the owner approves it, the hub merges it; when the owner rejects it, ${task} comes back to you with the owner's reason.`,
  };
}
// A held change's items: the files, or for git's own settings and hooks what changed
const namesOf = (rec) => (rec.kind === 'git' ? rec.items || [] : (rec.files || []).map((f) => f.path));
// The .env values a held change puts in its files (their names only)
const secretNames = (rec) => [...new Set((rec.files || []).flatMap((f) => f.names || []))];
// "the value of X from .env", or from the tester's sign-ins (lib/vault.mjs) for a persona's password or token
function valueWords(rec) {
  const from = new Map(envSecrets().map((v) => [v.name, v.from || '.env']));
  const groups = new Map();
  for (const name of secretNames(rec)) groups.set(from.get(name) || '.env', [...(groups.get(from.get(name) || '.env') || []), name]);
  return [...groups].map(([where, names]) => `the value of ${names.join(', ')} from ${where}`).join(' and ');
}
// Who made a held change, and what it does, in one sentence (the card, the phone, Home)
function heldWhat(rec) {
  if (rec.kind === 'policy') return policyWhat(rec);
  const names = listFiles(namesOf(rec));
  if (rec.kind === 'push') return `A push of ${rec.count} commit(s) to ${rec.target} on ${REMOTE}${rec.deploy !== false ? ', a deploy branch' : ''}${rec.files?.length ? `${rec.deploy !== false ? ',' : ''} that changes ${names}` : ''}`;
  if (rec.kind === 'git') return `Git's own hooks or settings changed (${names}): all git work waits`;
  const who = rec.kind === 'merge' || rec.on === 'merge' || rec.on === 'slot' ? `Task ${rec.task}` : rec.kind === 'commit' || rec.on === 'commit' ? "The orchestrator's commit" : rec.on === 'push' ? `A push of ${rec.from} to ${rec.target}` : `A change on disk during ${rec.by}`;
  if (rec.kind === 'secret') return rec.env ? `${who} has a .env file (${names})` : `${who} puts ${valueWords(rec)} in ${names}`;
  return `${who} changes ${names}`;
}
// What a held task shows ("Blocked by the tool", Show activity)
const heldText = (rec, card = rec.card) => {
  const where = `Approve or reject it on the dashboard: Notes and handoffs${card ? `, card ${card}` : ''} (${rec.id}).`;
  const names = namesOf(rec);
  if (rec.kind === 'policy') return `A security policy waits for the owner: ${policyWhat(rec)}. ${where}`;
  if (rec.kind === 'push') return `nextlevel holds the push of ${short(rec.sha)} to ${rec.target} on ${REMOTE} until the owner approves it. ${where}`;
  if (rec.kind === 'secret') return `nextlevel holds ${rec.on === 'slot' ? "the hub's commit of its work" : rec.on === 'push' ? `the push to ${rec.target}` : 'its merge'}: ${rec.env ? `it has a .env file (${listFiles(names)}), which is never committed` : `it puts ${valueWords(rec)} in ${listFiles(names)}`}. ${where}`;
  return `nextlevel holds ${rec.kind === 'merge' ? 'its merge' : 'it'}: it changes ${listFiles(names)}, protected ${names.length === 1 ? 'file' : 'files'} (the agents and your tools load ${names.length === 1 ? 'it' : 'them'} outside any sandbox). ${where}`;
};

// A held change that deletes a protected file may not be anyone's: an antivirus removes a file it takes for a threat
// (Bitdefender took a test START.cmd with a download-and-run line). Its card says so; Reject puts the file back.
const deletedNote = (rec) => {
  if (rec.kind === 'push' || rec.kind === 'policy') return '';
  const gone = rec.files.filter((f) => f.after === ABSENT && f.before !== ABSENT).map((f) => f.path);
  if (!gone.length) return '';
  const it = gone.length === 1 ? 'it' : 'them';
  return `If nobody meant to delete ${it}, antivirus may have removed ${it}; Reject puts ${it} back.`;
};

// Why a push waits, in a few words (the card, the dashboard): a deploy branch, a change to protected files, or both
const pushWhy = (rec) => {
  const files = rec.files?.length ? `it changes ${listFiles(namesOf(rec))}, protected (GitHub runs a pushed branch's own workflows, and the agents load these files)` : '';
  return rec.deploy !== false ? `A push to ${rec.target} may deploy${files ? `, and ${files}` : ''}` : `This push to ${rec.target} carries a change you haven't approved: ${files}`;
};

// The owner's card for a held change, and a message to the phone that says where to decide (not there). -> the card's id
function raiseCard(rec) {
  const names = namesOf(rec);
  const what = heldWhat(rec);
  const gone = ['git', 'secret', 'push', 'policy'].includes(rec.kind) ? '' : deletedNote(rec);
  const why = {
    git: "They make git run programs or send a push somewhere else, outside any sandbox, and nextlevel didn't make this change: all git work (commits, merges, pushes, starting and checking tasks) waits until you decide. Approve records it; Reject puts back what was recorded",
    secret: rec.env ? 'A .env file holds your secrets: nextlevel never commits one, so this change waits until you decide. Reject leaves it out' : 'A value from your .env is a secret: nextlevel never commits it unless you say the value may be committed. The card shows the change with the value hidden',
    policy: POLICY_WHY,
    push: `${pushWhy(rec)}, so nothing goes out until you decide. Approve pushes exactly ${short(rec.sha)} (only while ${rec.target} is where this card shows it); Reject pushes nothing`,
  }[rec.kind] || `${gone ? `${gone} ` : ''}${names.length === 1 ? 'It steers' : 'They steer'} the agents and your tools outside any sandbox, so nextlevel holds the change until you decide: ${rec.kind === 'merge' ? 'the task waits' : rec.kind === 'commit' ? "it isn't committed" : 'it is set back'} meanwhile`;
  let id = '';
  try {
    const card = cards().handoff.addGuard({
      what: `Approve or reject: ${what} (${rec.id})`,
      where: 'here on the dashboard: this card has the exact change, Approve and Reject (not from your phone)',
      why,
      task: rec.task || '',
      guard: rec.id,
    });
    id = card.id;
    guard().held.update(rec.id, { card: id });
  } catch (err) {
    log(`guard: couldn't add the card for ${rec.id}: ${err.message}`);
  }
  if (rec.kind === 'policy') {
    // (no phone message: the card is under Needs you, and nothing of the security engineer reaches the phone yet)
  } else if (rec.kind === 'push') {
    queueNotify(`${NAME}: approve or reject a push to ${rec.target}`, `Card ${id || rec.id}: ${what}, since ${day(rec.oldest)}. Nothing goes out until you decide. Open the dashboard (Notes and handoffs, card ${id || rec.id}) to see the commits${rec.files?.length ? ' and the change' : ''} and approve or reject it. It can't be approved from your phone.`, 'high', 'lock');
  } else {
    queueNotify(`${NAME}: approve or reject a change`, `${what}: nextlevel holds it until you decide.${gone ? ` ${gone}` : ''} Open the dashboard (Notes and handoffs${id ? `, card ${id}` : ''}) to see the exact change and approve or reject it. It can't be approved from your phone.`, 'high', 'lock');
  }
  log(`guard: held ${rec.id}: ${what}${id ? ` (card ${id})` : ''}`);
  return id;
}

// The watch (lib/guard.mjs): opened around what the orchestrator does, checked at every hub tick, closed at its end.
// Nothing here may stop the hub or the orchestrator: a failure is logged.
function guardOpen(key, what) {
  try {
    // a window whose holders are all gone (a round that was killed, a window closed with its X) gets its last look first
    guardResult(guard().check());
    guard().open(key, { what });
  } catch (err) {
    log(`guard: couldn't start watching the protected files (${what}): ${err.message}`);
  }
}
function guardResult(r) {
  for (const rec of r.held) raiseCard(rec);
  for (const rec of r.again) log(`guard: ${rec.files.map((f) => f.path).join(', ')} changed again as in ${rec.id}: set back again`);
  if (r.notRestored?.length) log(`guard: couldn't set back ${r.notRestored.join(', ')}`);
}
function guardClose(key) {
  try {
    guardResult(guard().close(key));
  } catch (err) {
    log(`guard: couldn't check the protected files: ${err.message}`);
  }
}
function guardTick() {
  if (guardPaused) return;
  try {
    guardResult(guard().check());
  } catch (err) {
    log(`guard: couldn't check the protected files: ${err.message}`);
  }
}

// The owner's decision on the dashboard (never from a command or the phone): Approve puts exactly the held change in
// (a change on disk goes back, a commit and a merge are queued for the hub), Reject leaves it out and, for a task, sends
// the task back to the orchestrator with the owner's reason. -> { message }
function guardDecide(id, action, reason = '') {
  const store = guard();
  const rec = store.held.get(id);
  if (!rec) throw new Error(`there is no held change ${id}`);
  const why = String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  const names = namesOf(rec);
  if (!['approve', 'reject'].includes(action)) throw new Error('action must be approve or reject');
  if (rec.status !== 'held') throw new Error(`${rec.id} is ${rec.status} already`);
  if (rec.kind === 'git') return gitDecide(rec, action, why);
  if (rec.kind === 'secret') return secretDecide(rec, action, why);
  if (rec.kind === 'push') return pushDecide(rec, action, why);
  if (rec.kind === 'policy') return policyDecide(rec, action, why);
  if (action === 'reject') {
    // A deleted file that is gone now goes back (antivirus may have removed it): the version before the change for a
    // change on disk, the base branch's for a commit or a merge
    const back = [];
    const failed = [];
    const there = (rel) => {
      try {
        fs.lstatSync(inProject(ROOT, rel));
        return true;
      } catch {
        return false;
      }
    };
    for (const f of rec.files.filter((x) => x.after === ABSENT && x.before !== ABSENT && !there(x.path))) {
      let problem;
      if (rec.kind === 'disk') problem = store.restoreGone(f.path, { hash: f.before, ...(f.linkBefore !== undefined ? { link: f.linkBefore } : {}) });
      else {
        const v = headVersion(f.path);
        if (v.hash === ABSENT) continue; // the base branch hasn't it either: nothing to put back
        problem = v.buf || v.link !== undefined ? store.restoreGone(f.path, { hash: v.buf ? store.putBlob(v.buf) : v.hash, ...(v.link !== undefined ? { link: v.link } : {}) }) : "git can't hand over its content";
      }
      if (problem) failed.push(`${f.path} (${problem})`);
      else back.push(f.path);
    }
    store.held.update(rec.id, { status: 'rejected', decidedAt: now(), reason: why }, { expect: ['held'] });
    // (a change on disk the session committed itself, as an orchestrator on Antigravity can: the commit stays, and a push
    // that carries it is refused, pushProtected; the orchestrator is told to revert it)
    const committed = rec.kind === 'disk' ? diskCommit(rec) : null;
    const revert = committed ? ` Commit ${short(committed.commit)} on ${CFG.base} has it: revert it (git revert ${short(committed.commit)}) before pushing; a push that carries it is refused.` : '';
    cards().handoff.decideGuard(rec.id, { reply: `Rejected${why ? `: ${why}` : ' (no reason given)'}.${revert}` });
    if (rec.kind === 'merge') settleTwins(rec, 'reject', why);
    if (rec.kind === 'merge' && rec.task && jobStatus(rec.task)) {
      setStatus(rec.task, { state: 'failed', held: null, finishedAt: now(), acked: false, detail: `the owner rejected its change to ${listFiles(names)} (${rec.id})${why ? `: "${why}"` : ''}. Retry it without that change: nextlevel retry ${rec.task} --feedback "..."` });
    }
    log(`guard: the owner rejected ${rec.id} (${names.join(', ')})${why ? `: ${why}` : ''}${back.length ? `; put back ${back.join(', ')}` : ''}${failed.length ? `; couldn't put back ${failed.join(', ')}` : ''}`);
    const putBackText = `${back.length ? ` Put back: ${listFiles(back)}.` : ''}${failed.length ? ` Couldn't put back ${failed.join(', ')}.` : ''}`;
    return { message: `Rejected: ${listFiles(names)} stay${names.length === 1 ? 's' : ''} as ${rec.kind === 'disk' ? 'they were' : `${CFG.base} has them`}.${putBackText}${rec.kind === 'merge' ? ` Task ${rec.task} goes back to the orchestrator with your reason.` : ' The orchestrator sees your answer on its card.'}${revert ? ` The orchestrator committed it itself (${short(committed.commit)}): it is told to revert it, and nothing pushes it.` : ''}` };
  }
  store.held.update(rec.id, { status: 'approved', decidedAt: now(), reason: why }, { expect: ['held'] });
  for (const f of rec.files) store.approveContent(f.path, f.after); // exactly this content is the owner's now
  log(`guard: the owner approved ${rec.id} (${names.join(', ')})`);
  if (rec.kind === 'merge') settleTwins(rec, 'approve', why);
  if (rec.kind === 'disk') {
    const r = store.applyDisk(rec.id);
    const committed = diskCommit(rec);
    const inCommit = committed ? `; commit ${short(committed.commit)} has it already, and a push of it needs no second approval` : '';
    cards().handoff.decideGuard(rec.id, { reply: r.ok ? `Approved: ${listFiles(names)} ${names.length === 1 ? 'is' : 'are'} back as changed${inCommit}` : `Approved, but ${r.detail}` });
    return { message: r.ok ? `Approved: ${listFiles(names)} ${names.length === 1 ? 'is' : 'are'} back on disk as changed. The orchestrator commits ${names.length === 1 ? 'it' : 'them'} with its next commit.` : `Approved, but ${r.detail}.` };
  }
  const later = hubAlive() ? '' : ' The hub is not running: it does it when it starts.';
  if (rec.kind === 'commit') {
    enqueue({ id: `commit-${rec.id}-${uniq()}`, type: 'git', op: 'apply', guard: rec.id });
    cards().handoff.decideGuard(rec.id, { reply: 'Approved: the hub commits it' });
    return { message: `Approved: the hub commits ${listFiles(names)} with the orchestrator's message.${later}` };
  }
  return approveMerge(rec, `its change to ${listFiles(names)}`, later);
}

// An approved held merge: the hub merges the task, if it is still what was held; else the approval waits for the
// orchestrator's merge of it
function approveMerge(rec, change, later) {
  const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/task/${rec.task}`], { allowFail: true }).out;
  const s = jobStatus(rec.task);
  cards().handoff.decideGuard(rec.id, { reply: 'Approved: the hub merges the task' });
  if (tip === rec.sha && !(s && ACTIVE.has(s.state))) {
    if (s) setStatus(rec.task, { held: null, detail: `the owner approved ${change} (${rec.id}): the hub merges it` });
    enqueue({ id: `merge-${rec.task}-${uniq()}`, type: 'git', op: 'merge', task: rec.task, message: rec.message || '', guard: rec.id });
    return { message: `Approved: the hub merges task ${rec.task}.${later}` };
  }
  if (s) setStatus(rec.task, { held: null, acked: false, detail: `the owner approved ${change} (${rec.id}); the task changed since it was held, so merge it again (nextlevel merge ${rec.task}): the approval covers that same change` });
  return { message: `Approved. Task ${rec.task} changed since it was held, so the orchestrator merges it again; your approval covers that same change.` };
}

// ---------- the guard: git's own hooks and settings (lib/gitguard.mjs) ----------
// What makes git run a program or send a push elsewhere, for the project and its worktrees (the slots' push lock
// included, FR-003), as recorded in ~/.nextlevel/guard/<project>/git.json. Before its git work the hub compares; a
// change it didn't make itself stops all git work until the owner decides: Approve records it, Reject puts back what
// was recorded. The hub's own changes (a slot's settings and hooks at every task start, the bridge test's remote) are
// recorded as it makes them.
const slotHooksDir = () => path.join(commonDir(), 'nextlevel', 'slot-hooks');
function gitRun(args, cwd = ROOT) {
  const r = spawnSync('git', args, { cwd, env: readEnv(), encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}
const gitNow = () => readGitState({ root: ROOT, git: gitRun, slotHooks: slotHooksDir(), hookDirs: [path.join(commonDir(), 'hooks')], keep: (buf) => guard().putBlob(buf) });
const heldGit = () => guard().held.list().find((x) => x.kind === 'git' && x.status === 'held');
const gitStopText = (rec) => `git's own hooks or settings changed and nextlevel didn't make that change, so all git work waits for the owner (${rec.id}${rec.card ? `, card ${rec.card}` : ''} on the dashboard)`;

// '' when git work may go on; else why not (and, the first time, the owner's card)
function gitGuard() {
  try {
    const waiting = heldGit();
    if (waiting) return gitStopText(waiting);
    const store = guard();
    if (store.gitBusy()) return ''; // nextlevel itself is changing them in another process (withOwnGitChange)
    let current = gitNow();
    let recorded = store.readGit();
    if (!recorded) {
      store.writeGit(current); // the first look: what is there is the owner's
      return '';
    }
    let d = diffGitState(recorded, current);
    if (d.empty) {
      if (stateKey(recorded) !== stateKey(current) || recorded.worktrees.length !== current.worktrees.length) store.writeGit(current); // (a worktree that is gone)
      return '';
    }
    // A change nextlevel made in another process while this look read (withOwnGitChange: the bridge test's remote, which
    // it records right after) is no change: looked at again, the record has it, or the other process is still at it
    if (store.gitBusy()) return '';
    recorded = store.readGit();
    current = gitNow();
    d = diffGitState(recorded, current);
    if (d.empty || store.gitBusy()) return '';
    const items = [...new Set([...d.config.added, ...d.config.removed].map((e) => e.key).concat(d.hooks.map((h) => `${h.name} hook`)))];
    const text = (h) => (h.hash ? store.getBlob(h.hash)?.toString('utf8') ?? null : null);
    const diff = [
      ...d.config.removed.map((e) => `- ${e.key} = ${e.value ?? ''}   (${e.where === 'main' ? 'the project' : e.where}: ${e.file})`),
      ...d.config.added.map((e) => `+ ${e.key} = ${e.value ?? ''}   (${e.where === 'main' ? 'the project' : e.where}: ${e.file})`),
      ...d.hooks.map((h) => diffTexts(`${h.dir}/${h.name}`, h.before ? (store.getBlob(h.before.hash) ?? `(${h.before.size} bytes)`) : null, h.after ? (store.getBlob(h.after.hash) ?? `(${h.after.size} bytes)`) : null, { tmpDir: path.join(store.dir, 'tmp') })),
    ].join('\n');
    const { item, fresh } = store.held.add({ kind: 'git', by: "git's own hooks and settings", task: '', job: '', files: [], items, key: stateKey(current), before: recorded, after: current, summary: describeGitChange(d, { text }), ...shownDiff(diff) });
    if (fresh) raiseCard(item);
    log(`guard: git's own hooks or settings changed (${items.join(', ')}): all git work stops until the owner decides (${item.id})`);
    return gitStopText(heldGit() || item);
  } catch (err) {
    log(`guard: couldn't read git's hooks and settings: ${err.message}`);
    return '';
  }
}

// The hub's own change to git's settings or hooks, recorded as it is now: a worktree's own settings (a slot's, which the
// hub writes at every task start), the project's settings under `keys` (a key or a prefix), the slots' hooks.
function gitRecordOwn({ worktree = '', keys = [] } = {}) {
  try {
    const store = guard();
    const recorded = store.readGit();
    if (!recorded) return;
    const current = gitNow();
    const where = worktree ? folderName(worktree) : null;
    const mine = (e) => (where && e.where !== 'main' && sameFolder(e.where, where)) || (e.where === 'main' && keys.some((k) => e.key.toLowerCase() === k || (k.endsWith('.') && e.key.toLowerCase().startsWith(k))));
    const hooksDir = folderName(slotHooksDir());
    const hooks = Object.fromEntries(Object.entries(recorded.hooks || {}).filter(([d]) => !sameFolder(d, hooksDir)));
    for (const [d, files] of Object.entries(current.hooks)) if (sameFolder(d, hooksDir)) hooks[d] = files;
    const worktrees = [...new Set([...(recorded.worktrees || []), ...(where ? [where] : [])])];
    store.writeGit({ worktrees, config: [...recorded.config.filter((e) => !mine(e)), ...current.config.filter(mine)], hooks });
  } catch (err) {
    log(`guard: couldn't record the hub's own change to git's settings: ${err.message}`);
  }
}

// A change of nextlevel's own to git's settings, made outside the hub (the bridge test's remote): the hub doesn't look
// while it is made, and it is recorded right after
function withOwnGitChange(fn, own) {
  const store = guard();
  store.setGitBusy(true);
  try {
    return fn();
  } finally {
    gitRecordOwn(own);
    store.setGitBusy(false);
  }
}

// Puts git's settings and hooks back as recorded: each setting that differs gets exactly the recorded values in the
// file it was in, each hook its recorded content; one that wasn't there goes. -> problems ([] when all went back)
function restoreGit(recorded) {
  const store = guard();
  const d = diffGitState(recorded, gitNow());
  const problems = [];
  const groups = new Map();
  for (const e of [...d.config.added, ...d.config.removed]) groups.set(`${e.file}\n${e.key}`, e);
  for (const { file, key } of groups.values()) {
    if (!path.isAbsolute(file)) {
      problems.push(`${key} (set ${file}, not in a file)`);
      continue;
    }
    // (--end-of-options: a recorded value that starts with "-" is a value, never an option)
    gitRun(['config', '--file', file, '--unset-all', '--end-of-options', key]);
    for (const e of recorded.config.filter((x) => x.file === file && x.key === key)) {
      if (!gitRun(['config', '--file', file, '--add', '--end-of-options', key, e.value ?? 'true']).ok) problems.push(`${key} in ${file}`);
    }
  }
  for (const h of d.hooks) {
    // (a hook is a file right in its folder: a name with a path in it is never written)
    if (!h.name || /[\\/]/.test(h.name) || h.name === '.' || h.name === '..' || !path.isAbsolute(h.dir)) {
      problems.push(`the hook "${h.name}" (not a plain name)`);
      continue;
    }
    const f = path.join(h.dir, h.name);
    try {
      fs.rmSync(f, { force: true });
      if (h.before?.link !== undefined) fs.symlinkSync(h.before.link, f);
      else if (h.before) {
        const buf = store.getBlob(h.before.hash);
        if (!buf) throw new Error('its recorded content is no longer kept');
        fs.writeFileSync(f, buf);
        fs.chmodSync(f, 0o755);
      }
    } catch (err) {
      problems.push(`the ${h.name} hook (${err.message})`);
    }
  }
  return problems;
}

// The owner's decision on git's settings and hooks: Approve records them as they are (only if they are still what the
// card showed), Reject puts back what was recorded. Either way git work goes on.
function gitDecide(rec, action, why) {
  const store = guard();
  if (action === 'approve') {
    const current = gitNow();
    if (stateKey(current) !== rec.key) {
      store.held.update(rec.id, { status: 'superseded', decidedAt: now(), detail: 'they changed again since this card was made: a new card shows all of it' }, { expect: ['held'] });
      cards().handoff.decideGuard(rec.id, { reply: 'Not recorded: they changed again since; a new card shows all of it' });
      return { message: "Git's hooks or settings changed again since this card was made, so nothing was recorded: the hub makes a new card with all of it." };
    }
    store.writeGit(current);
    store.held.update(rec.id, { status: 'applied', decidedAt: now(), reason: why, detail: 'recorded: git work goes on' }, { expect: ['held'] });
    cards().handoff.decideGuard(rec.id, { reply: "Approved: recorded; git work goes on" });
    log(`guard: the owner approved ${rec.id}: git's hooks and settings are recorded as they are; git work goes on`);
    return { message: "Approved: git's hooks and settings are recorded as they are now. Git work goes on." };
  }
  const problems = restoreGit(rec.before);
  const left = diffGitState(rec.before, gitNow());
  store.held.update(rec.id, { status: 'rejected', decidedAt: now(), reason: why, detail: left.empty ? 'put back as recorded' : `couldn't put all of it back: ${problems.join('; ') || describeGitChange(left).join('; ')}` }, { expect: ['held'] });
  cards().handoff.decideGuard(rec.id, { reply: `Rejected${why ? `: ${why}` : ''}; ${left.empty ? 'put back as recorded' : 'not all of it could be put back'}` });
  log(`guard: the owner rejected ${rec.id}: ${left.empty ? "git's hooks and settings are back as recorded" : `not all of it went back (${problems.join('; ')})`}`);
  return { message: left.empty ? "Rejected: git's hooks and settings are back as they were recorded. Git work goes on." : `Rejected, but not all of it could be put back (${problems.join('; ') || 'see the card'}): the hub raises a new card for what is left.` };
}

// ---------- the guard: .env values in commits (lib/secrets.mjs) ----------
// The hub never commits a .env file, or a file that holds a value from the project's .env (one too short to be a secret
// aside), whatever .gitignore says: it holds that change with a card, the value hidden. The values are read again for
// each look (the owner may change .env), and never go on a command line.
function envSecrets() {
  const dotenv = secretValues(parseEnvFile(path.join(ROOT, '.env')), { example: parseEnvFile(path.join(ROOT, '.env.example')) });
  // (and the tester's persona passwords and tokens, lib/vault.mjs: never committed or pushed either)
  return [...dotenv, ...redactionValues(ROOT).named].sort((a, b) => b.value.length - a.value.length);
}
// The changes (git diff --raw entries) that put a .env file or a value from .env in: a value counts when the file
// didn't have it before; content the owner let be committed doesn't. -> [{ e, b, a, names, env }]
function secretFindings(changes, values) {
  const store = guard();
  const out = [];
  for (const e of changes) {
    if (e.status === 'D') continue;
    const env = isEnvFile(e.path);
    if (!env && !values.length) continue;
    const a = gitVersion(e.newMode, e.newBlob);
    if (a.hash === ABSENT || a.link !== undefined || a.submodule) continue;
    if (!env && store.secretOk(e.path, a.hash)) continue;
    const b = gitVersion(e.oldMode, e.oldBlob);
    if (env) {
      out.push({ e, b, a, names: [], env: true });
      continue;
    }
    if (!a.buf) {
      out.push({ e, b, a, names: ['(a file too large to look into)'], env: false });
      continue;
    }
    const had = new Set(b.buf ? findSecrets(b.buf, values) : []);
    const names = findSecrets(a.buf, values).filter((n) => !had.has(n));
    if (names.length) out.push({ e, b, a, names, env: false });
  }
  return out;
}
// A held change of .env values, as the guard keeps it: its files (content kept for an approval), words and diff, all
// with the values hidden
function secretRecord(found, values, diff, extra) {
  const store = guard();
  const files = found.map(({ e, b, a, names, env }) => {
    if (a.buf && !env) store.putBlob(a.buf);
    return { path: e.path, before: b.hash, after: a.hash, mode: e.newMode, names, ...(env ? { env: true } : {}) };
  });
  const summary = found.flatMap(({ e, a }) => describeSecretFile(e.path, a.buf ? a.buf.toString('utf8') : '', values));
  // (a commit message could carry the value too)
  const hidden = extra.message ? { ...extra, message: redactSecrets(extra.message, values) } : extra;
  return { kind: 'secret', files, env: found.some((f) => f.env), summary, ...shownDiff(redactSecrets(diff, values)), ...hidden };
}

// The owner's decision on a held .env value: Approve (never for a .env file itself) lets exactly that content be
// committed; Reject leaves it out and sends a task back to the orchestrator with the reason.
function secretDecide(rec, action, why) {
  const store = guard();
  const names = namesOf(rec);
  const later = hubAlive() ? '' : ' The hub is not running: it does it when it starts.';
  if (action === 'approve') {
    if (rec.env) throw new Error(`${listFiles(names)} is a .env file: nextlevel never commits one, so this can't be approved. Reject it, and take the file out of the change.`);
    store.held.update(rec.id, { status: 'approved', decidedAt: now(), reason: why }, { expect: ['held'] });
    for (const f of rec.files) store.approveSecret(f.path, f.after);
    log(`guard: the owner approved ${rec.id}: ${listFiles(names)} may be committed with the value of ${secretNames(rec).join(', ')}`);
    if (rec.on === 'push') {
      // (the push itself asks again: the orchestrator pushes again, and a deploy branch's card follows)
      cards().handoff.decideGuard(rec.id, { reply: `Approved: the value of ${secretNames(rec).join(', ')} in ${listFiles(names)} may go out. The orchestrator pushes ${rec.target} again` });
      if (rec.job && jobStatus(rec.job)) setStatus(rec.job, { state: 'failed', acked: false, detail: `not pushed yet: the owner approved ${valueWords(rec)} in ${listFiles(names)} (${rec.id}): push again` });
      return { message: `Approved: ${listFiles(names)} may go out with that value. The orchestrator pushes again.` };
    }
    if (rec.on === 'merge') return approveMerge(rec, `the value of ${secretNames(rec).join(', ')} in ${listFiles(names)}`, later);
    enqueue({ id: `commit-${rec.id}-${uniq()}`, type: 'git', op: 'apply', guard: rec.id });
    cards().handoff.decideGuard(rec.id, { reply: rec.on === 'slot' ? `Approved: the hub commits it on task/${rec.task}` : 'Approved: the hub commits it' });
    return { message: `Approved: the hub commits ${listFiles(names)}${rec.on === 'slot' ? ` on task/${rec.task}` : " with the orchestrator's message"}.${later}` };
  }
  store.held.update(rec.id, { status: 'rejected', decidedAt: now(), reason: why }, { expect: ['held'] });
  cards().handoff.decideGuard(rec.id, { reply: `Rejected${why ? `: ${why}` : ' (no reason given)'}` });
  const back = rec.task && ['merge', 'slot'].includes(rec.on) && jobStatus(rec.task);
  if (back) {
    setStatus(rec.task, { state: 'failed', held: null, finishedAt: now(), acked: false, detail: `the owner rejected ${rec.env ? `its .env file (${listFiles(names)})` : `${valueWords(rec)} in ${listFiles(names)}`} (${rec.id})${why ? `: "${why}"` : ''}. Retry it without that: nextlevel retry ${rec.task} --feedback "..."` });
  }
  log(`guard: the owner rejected ${rec.id} (${names.join(', ')})${why ? `: ${why}` : ''}`);
  if (rec.on === 'push') {
    const fix = `take it out of ${rec.from}'s commits (git revert of the commit that added it, or rewrite the branch before it is pushed), then push again`;
    if (rec.job && jobStatus(rec.job)) setStatus(rec.job, { state: 'failed', acked: false, detail: `not pushed: the owner rejected ${rec.env ? `the .env file ${listFiles(names)}` : `${valueWords(rec)} in ${listFiles(names)}`} in its commits (${rec.id})${why ? `: "${why}"` : ''}. To push, ${fix}` });
    return { message: `Rejected: nothing goes out with it. The orchestrator is told to ${fix}.` };
  }
  return { message: `Rejected: ${listFiles(names)} ${names.length === 1 ? 'stays' : 'stay'} out of git.${back ? ` Task ${rec.task} goes back to the orchestrator with your reason.` : ' The orchestrator sees your answer on its card.'}` };
}

// An approved held commit of the hub's in a slot, onto the task's branch: a commit made from the kept content, in an
// index of its own (the slot has moved on to other work). -> { ok, detail }
function commitOntoBranch(rec) {
  const branch = `refs/heads/task/${rec.task}`;
  const tip = git(['rev-parse', '--verify', '--quiet', branch], { allowFail: true }).out;
  if (!tip) return { ok: false, detail: `there is no branch task/${rec.task}` };
  const store = guard();
  const tmp = path.join(store.dir, 'tmp');
  mkdirp(tmp);
  const index = path.join(tmp, `index-${uniq()}`);
  const env = { ...readEnv(), GIT_INDEX_FILE: index };
  const g = (args, input) => {
    const r = spawnSync('git', args, { cwd: ROOT, env, input, encoding: 'utf8', windowsHide: true });
    log(`${rec.id}: git ${args.slice(0, 3).join(' ')}`);
    if (r.status !== 0) throw new Error(`git ${args[0]}: ${lastLine(r.stderr || r.stdout)}`);
    return (r.stdout || '').trim();
  };
  try {
    g(['read-tree', tip]);
    for (const f of rec.files) {
      if (f.after === ABSENT) g(['update-index', '--force-remove', '--', f.path]);
      else {
        const buf = store.getBlob(f.after);
        if (!buf) throw new Error(`the content of ${f.path} that was held isn't kept any more`);
        const blob = g(['hash-object', '-w', '--stdin'], buf);
        g(['update-index', '--add', '--cacheinfo', `${/^1(00644|00755|20000)$/.test(f.mode || '') ? f.mode : '100644'},${blob},${f.path}`]);
      }
    }
    const tree = g(['write-tree']);
    const message = path.join(tmp, `message-${uniq()}.txt`);
    fs.writeFileSync(message, `${rec.task}: what the hub held (${rec.id})\n\nThe owner approved it on the dashboard: ${listFiles(namesOf(rec))} with ${valueWords(rec)}.\n`);
    const commit = g(['commit-tree', tree, '-p', tip, '-F', message]);
    fs.rmSync(message, { force: true });
    g(['update-ref', branch, commit, tip]);
    return { ok: true, detail: `committed ${commit.slice(0, 7)} on task/${rec.task}` };
  } catch (err) {
    return { ok: false, detail: `couldn't commit it on task/${rec.task}: ${err.message}` };
  } finally {
    fs.rmSync(index, { force: true });
  }
}

// The held changes, for the dashboard: the ones waiting (and approved ones the hub hasn't put in yet) with their words
// and diff; the decided ones briefly. Newest first.
function guardView({ full = false, n = 30 } = {}) {
  let items = [];
  try {
    items = guard().held.list();
  } catch {
    return [];
  }
  return items
    .slice(-n)
    .reverse()
    .map((x) => ({
      id: x.id,
      kind: x.kind,
      status: x.status,
      task: x.task || '',
      job: x.job || '',
      card: x.card || '',
      by: x.by || '',
      files: namesOf(x),
      what: heldWhat(x), // who made it and what it does, in one sentence
      on: x.on || '',
      env: !!x.env, // a .env file: never approved
      secrets: secretNames(x),
      createdAt: x.createdAt,
      decidedAt: x.decidedAt || null,
      reason: x.reason || '',
      detail: x.detail || '',
      text: heldText(x),
      note: deletedNote(x), // (a deleted file: antivirus may have removed it)
      ...(x.kind === 'policy' ? { source: x.source, scan: x.scan || '', commit: x.commit || '', hash: String(x.hash || '').slice(0, 12), warning: x.source === 'draft' ? DRAFT_WARNING : '', cut: x.cut || 0 } : {}),
      ...(x.kind === 'push' ? { target: x.target, from: x.from, sha: x.sha, there: x.there || '', count: x.count, oldest: x.oldest || '', deploy: x.deploy !== false, why: x.files?.length ? pushWhy(x) : '' } : {}),
      ...(full ? { summary: x.summary || [], diff: x.diff || '', diffCut: !!x.diffCut, log: x.log || '', logCut: !!x.logCut, message: x.message || '', notRestored: x.notRestored || [] } : {}),
    }));
}

const GIT_OPS = {
  async commit(job, { run, messageFile }) {
    const why = notReady();
    if (why) return { ok: false, detail: `not committed: ${why}` };
    const paths = job.paths?.length ? ['--', ...job.paths] : [];
    const add = await run(['add', '-A', ...paths]);
    if (add.code !== 0) return { ok: false, detail: `git add failed: ${lastLine(add.out)}` };
    if (git(['diff', '--cached', '--quiet', ...paths], { allowFail: true }).ok) return { ok: true, detail: 'nothing to commit' };
    // The guard: a protected file in it waits for the owner (unless its content is the owner's own); the rest goes in.
    // What went in is checked once more: `git commit <paths>` takes the files as they are at that moment, and a hook
    // may change one, so a protected file that changed in between is taken out again (the hub's own commit undone).
    const before = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }).out;
    let heldDetail = '';
    for (let round = 1; ; round++) {
      const held = await holdStaged(job, paths, run);
      if (held.error) return { ok: false, detail: held.error };
      // ... and a .env file, or a value from .env, never goes in (lib/secrets.mjs)
      const secret = await holdSecrets(job, paths, run);
      if (secret.error) return { ok: false, detail: secret.error };
      heldDetail = [held.detail, secret.detail].filter(Boolean).join('; ') || heldDetail;
      if (git(['diff', '--cached', '--quiet', ...paths], { allowFail: true }).ok) return heldDetail ? { ok: false, held: true, detail: `nothing committed: ${heldDetail}` } : { ok: true, detail: 'nothing to commit' };
      if (round > 3) return { ok: false, detail: `nothing committed: a protected file or a value from .env kept changing while the hub committed${heldDetail ? `; ${heldDetail}` : ''}` };
      fs.writeFileSync(messageFile, `${job.message}\n`);
      // With paths, the commit names exactly the files still staged under them (a held one is out: named, git would
      // take it from disk again), in a file of their own (no command line is too long for them)
      let commitArgs = ['commit', '-q', '-F', messageFile];
      // (kept with the guard, not in .nextlevel/, which the orchestrator can write while git reads it)
      const list = path.join(guard().dir, 'tmp', `paths-${job.id}.txt`);
      if (paths.length) {
        mkdirp(path.dirname(list));
        fs.writeFileSync(list, git(['diff', '--cached', '--name-only', '-z', ...paths], { allowFail: true }).out);
        commitArgs = ['commit', '-q', '-F', messageFile, `--pathspec-from-file=${list}`, '--pathspec-file-nul'];
      }
      const commit = await run(commitArgs, { literal: paths.length > 0 });
      fs.rmSync(list, { force: true });
      if (commit.code !== 0) return { ok: false, detail: `git commit failed: ${lastLine(commit.out)}` };
      const sneaked = [...unapprovedSince(before), ...secretsSince(before)];
      if (!sneaked.length) break;
      log(`${job.id}: ${sneaked.join(', ')} changed while the hub committed: the commit is undone and ${sneaked.length === 1 ? 'it is' : 'they are'} held`);
      const undo = await run(['reset', '-q', '--soft', before]);
      if (undo.code !== 0) return { ok: false, detail: `${sneaked.join(', ')} changed while the hub committed, and its commit couldn't be undone: ${lastLine(undo.out)}. The owner can undo it: git reset --soft ${before.slice(0, 12)}` };
    }
    return { ok: true, detail: `committed ${git(['log', '-1', '--format=%h %s']).out}${heldDetail ? `; ${heldDetail}` : ''}` };
  },
  // An approved held commit (guardDecide): the files as the orchestrator had them, committed with its message. Only
  // while the base branch still has the versions the change was held against.
  async apply(job, { run, messageFile }) {
    const store = guard();
    const rec = store.held.get(job.guard);
    const kindOk = rec && (rec.kind === 'commit' || (rec.kind === 'secret' && ['commit', 'slot'].includes(rec.on)));
    if (!kindOk) return { ok: false, detail: `there is no held commit ${job.guard}` };
    if (rec.status === 'applied') return { ok: true, detail: `${rec.id} is committed already (${rec.commit || ''})` };
    if (rec.status !== 'approved') return { ok: false, detail: `${rec.id} is ${rec.status}, not approved` };
    // The hub's commit of a worker's work in its slot: onto the task's branch, from the kept content
    if (rec.on === 'slot') {
      const r = commitOntoBranch(rec);
      if (r.ok) {
        store.held.update(rec.id, { status: 'applied', appliedAt: now(), detail: r.detail });
        if (jobStatus(rec.task)) setStatus(rec.task, { held: null, acked: false, detail: `the owner approved ${valueWords(rec)} in ${listFiles(namesOf(rec))} (${rec.id}): ${r.detail}` });
      }
      return r;
    }
    const why = notReady();
    if (why) return { ok: false, detail: `not committed yet: ${why}. The content stays approved: a commit of exactly these files goes through` };
    const moved = rec.files.filter((f) => headVersion(f.path).hash !== f.before);
    if (moved.length) {
      const detail = `${moved.map((f) => f.path).join(', ')} changed in ${CFG.base} since ${rec.id} was held, so the approval doesn't cover it any more: nothing was committed`;
      store.held.update(rec.id, { status: 'superseded', appliedAt: now(), detail });
      return { ok: false, detail };
    }
    const paths = rec.files.map((f) => f.path);
    guardPaused += 1;
    try {
      for (const f of rec.files) {
        const file = inProject(ROOT, f.path);
        const link = linkOnTheWay(ROOT, f.path);
        if (link) return { ok: false, detail: `${link} is a link now, so ${f.path} isn't written through it: nothing was committed` };
        fs.rmSync(file, { force: true });
        if (f.after === ABSENT) continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (f.link !== undefined) fs.symlinkSync(f.link, file);
        else {
          const buf = store.getBlob(f.after);
          if (!buf) throw new Error(`the content of ${f.path} that was held isn't kept any more (larger than 2 MB?)`);
          fs.writeFileSync(file, buf);
        }
      }
      store.accept(paths);
      const before = git(['rev-parse', '--verify', '--quiet', 'HEAD'], { allowFail: true }).out;
      const add = await run(['--literal-pathspecs', 'add', '-A', '--', ...paths]);
      if (add.code !== 0) return { ok: false, detail: `git add failed: ${lastLine(add.out)}` };
      fs.writeFileSync(messageFile, `${rec.message || 'Protected files'}\n\nHeld by nextlevel until the owner approved it on the dashboard (${rec.id}).\n`);
      const commit = await run(['--literal-pathspecs', 'commit', '-q', '-F', messageFile, '--', ...paths]);
      if (commit.code !== 0) return { ok: false, detail: `git commit failed: ${lastLine(commit.out)}` };
      // Exactly what was approved went in, nothing else (the files were read again at commit time): else it is undone
      const exact = rawChanges([before, 'HEAD']).every((e) => rec.files.some((f) => f.path === e.path && gitVersion(e.newMode, e.newBlob).hash === f.after));
      if (before && !exact) {
        await run(['reset', '-q', '--soft', before]);
        await run(['--literal-pathspecs', 'reset', '-q', '--', ...paths]);
        return { ok: false, detail: `${listFiles(paths)} changed while the hub committed ${rec.id}, so it isn't what the owner approved: nothing was committed. The approved content stays approved: a commit of exactly it goes through` };
      }
    } finally {
      guardPaused -= 1;
    }
    const sha = git(['log', '-1', '--format=%h']).out;
    store.held.update(rec.id, { status: 'applied', appliedAt: now(), commit: sha, detail: `committed ${sha}` });
    return { ok: true, detail: `committed ${git(['log', '-1', '--format=%h %s']).out} (${rec.id}, approved by the owner)` };
  },
  async merge(job, { run, messageFile }) {
    const why = notReady();
    if (why) return { ok: false, detail: `not merged: ${why}` };
    const branch = `task/${job.task}`;
    if (!branchExists(branch)) return { ok: false, detail: `there is no branch ${branch}` };
    const s = jobStatus(job.task);
    if (s && ACTIVE.has(s.state)) return { ok: false, detail: `${job.task} is still ${s.state}` };
    if (git(['merge-base', '--is-ancestor', branch, 'HEAD'], { allowFail: true }).ok) return { ok: true, detail: `${branch} is merged already` };
    const count = git(['rev-list', '--count', `HEAD..${branch}`], { allowFail: true }).out;
    // The guard: a task that changes a protected path is merged only once the owner approved exactly that change. The
    // commit checked is the one merged (the branch could move meanwhile).
    const tip = git(['rev-parse', `refs/heads/${branch}`]).out;
    const g = guardMerge(job, tip);
    if (!g.ok) return { ok: false, held: true, detail: g.detail };
    // ... and a .env file, or a value from .env, is merged only once the owner approved it
    const sg = secretMerge(job, tip);
    if (!sg.ok) return { ok: false, held: true, detail: sg.detail };
    const approvals = [g.approved, sg.approved].filter(Boolean);
    const approvedText = approvals.map((x) => `${x.kind === 'secret' ? `the value of ${secretNames(x).join(', ')} from .env in` : 'its change to'} ${namesOf(x).join(', ')} (${x.id})`).join(' and ');
    const approvedLines = approvals.map((x) => (x.kind === 'secret' ? `The value of ${secretNames(x).join(', ')} from .env in ${namesOf(x).join(', ')} was approved by the owner (${x.id}).` : `Its change to ${namesOf(x).join(', ')} was approved by the owner (${x.id}${x.kind === 'push' ? `, on the card of a push to ${x.target}` : ''}).`));
    // (its subject names task/<id>, also with the orchestrator's own -m text: the Project page counts it merged, FR-021)
    fs.writeFileSync(messageFile, `${mergeMessage(job.task, job.message)}\n${approvedLines.length ? `\n${approvedLines.join('\n')}\n` : ''}`);
    if (g.approved) guardPaused += 1;
    let r;
    try {
      r = await run(['merge', '--no-ff', '-F', messageFile, tip]);
      if (r.code === 0 && approvals.length) {
        if (g.approved) guard().accept(namesOf(g.approved));
        const sha = git(['rev-parse', '--short', 'HEAD'], { allowFail: true }).out;
        for (const x of approvals.filter((y) => y.kind !== 'push')) guard().held.update(x.id, { status: 'applied', appliedAt: now(), commit: sha, detail: `merged in ${sha}` });
        if (jobStatus(job.task)) setStatus(job.task, { held: null, detail: `merged into ${CFG.base} after the owner approved ${approvedText}`, acked: false });
      }
    } finally {
      if (g.approved) guardPaused -= 1;
    }
    if (r.code === 0) return { ok: true, moved: `task ${job.task} was merged into ${CFG.base}`, detail: `merged ${branch} (${count} commit(s)) into ${CFG.base}${approvals.length ? `, with ${approvedText} the owner approved` : ''}` };
    const conflicts = git(['diff', '--name-only', '--diff-filter=U'], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
    const abort = merging() ? await run(['merge', '--abort']) : { code: 0 };
    if (abort.code !== 0) {
      return { ok: false, ...(conflicts.length ? { conflicts } : {}), detail: `git merge failed (${lastLine(r.out)}), and undoing it failed too: ${lastLine(abort.out)}. The main checkout is in the middle of a merge: the owner can finish it, or undo it (git merge --abort)` };
    }
    if (conflicts.length) {
      const files = `${conflicts.slice(0, 5).join(', ')}${conflicts.length > 5 ? ` and ${conflicts.length - 5} more` : ''}`;
      return {
        ok: false,
        conflicts,
        detail: `conflicts in ${files}: the merge was undone and ${CFG.base} is unchanged. Next: nextlevel retry ${job.task} --feedback "merge ${CFG.base} into your branch first and resolve the conflicts"`,
      };
    }
    // Git refuses to start a merge over uncommitted changes to the files it would change
    const touched = new Set(lines(git(['diff', '--name-only', `HEAD...${branch}`], { allowFail: true }).out));
    const changed = [...lines(git(['diff', '--name-only', 'HEAD'], { allowFail: true }).out), ...lines(git(['ls-files', '--others', '--exclude-standard'], { allowFail: true }).out)];
    const dirty = changed.filter((f) => touched.has(f));
    if (dirty.length) return { ok: false, detail: `uncommitted changes in the main checkout are in the way (${dirty.slice(0, 5).join(', ')}): commit them first (nextlevel commit -m "...")` };
    return { ok: false, detail: `git merge failed: ${lastLine(r.out)}` };
  },
  async cleanup(job, { run }) {
    const branch = `task/${job.task}`;
    let moved = '';
    if (branchExists(branch)) {
      const merged = git(['merge-base', '--is-ancestor', branch, `refs/heads/${CFG.base}`], { allowFail: true }).ok;
      if (!merged && !job.discard) {
        return { ok: false, detail: `${branch} is not merged into ${CFG.base}: merge it (nextlevel merge ${job.task}), or throw the work away (nextlevel cleanup ${job.task} --discard)` };
      }
      const tip = git(['rev-parse', `refs/heads/${branch}`], { allowFail: true }).out;
      const r = await run(['branch', '-D', branch]); // merged into the base branch, or given up
      if (r.code !== 0) return { ok: false, detail: `git branch failed: ${lastLine(r.out)}` };
      moved = `task ${job.task} was closed${merged ? '' : ' (its work thrown away)'}`;
      // Its work thrown away: the task is closed (FR-021), and the Project page says so
      if (!merged && !isBridgeTask(job.task) && !closures().has(job.task)) {
        recordClosure(job.task, { reason: 'its work thrown away (nextlevel cleanup --discard)', by: job.by || 'orchestrator', source: job.source || '', discarded: true, branch: tip, job: jobStatus(job.task) });
      }
    }
    if (jobStatus(job.task)) setStatus(job.task, { acked: true, cleaned: true });
    return { ok: true, moved, detail: moved ? `deleted ${branch}${moved.includes('thrown away') ? ' (its work thrown away; the task is closed)' : ''}` : `there is no branch ${branch}: nothing was deleted` };
  },
  // close (FR-021): the task checked again, its unmerged branch deleted when --discard says so, the closure recorded
  async close(job, { run }) {
    const id = job.task;
    const p = closeProblem(id, { discard: !!job.discard });
    if (p.problem) return { ok: false, detail: `not closed: ${p.problem}` };
    const branch = `task/${id}`;
    let tip = '';
    if (p.branch) {
      tip = git(['rev-parse', `refs/heads/${branch}`], { allowFail: true }).out;
      // (an unmerged one only with --discard, closeProblem; one with no work of its own throws nothing away)
      const r = await run(['branch', '-D', branch]);
      if (r.code !== 0) return { ok: false, detail: `not closed: git branch failed: ${lastLine(r.out)}` };
    }
    const discarded = p.branch === 'unmerged';
    recordClosure(id, { reason: job.reason, by: job.by || 'owner', source: job.source || '', discarded, branch: tip, job: p.job });
    const what = discarded ? `; ${branch} was deleted, its work thrown away` : p.branch ? `; ${branch} had no work of its own and was deleted` : '';
    return { ok: true, moved: `task ${id} was closed`, detail: `closed ${id}: ${job.reason}${what}` };
  },
};

async function runGitJob(job) {
  const d = jobDir(job.id);
  fs.rmSync(path.join(QUEUE, `${job.id}.json`), { force: true });
  writeJson(path.join(d, 'job.json'), job);
  setStatus(job.id, { state: 'running', startedAt: now() });
  const logFile = path.join(d, 'git.log');
  // (a hook of the project's runs as the orchestrator's job: nothing it writes is the owner's, lib/guard.mjs)
  // (GIT_REFLOG_ACTION: the hub's own moves of the main checkout's HEAD and base branch say so in git's reflog, so one a
  // worker makes there while it runs is told apart: workerOutside)
  const env = { ...process.env, NEXTLEVEL_AGENT: 'git-job', GIT_REFLOG_ACTION: HUB_REFLOG };
  // Run again while a held index.lock stops it (the owner's editor reads the main checkout too: lib/gitlock.mjs)
  // (`literal`: file names are taken as they are, never as pathspec magic)
  const run = async (args, { literal = false } = {}) => {
    log(`${job.id}: git ${args.join(' ')}`);
    const r = await retryOnLockAsync(async () => {
      const p = await runLogged('git', args, { cwd: ROOT, env: literal ? { ...env, GIT_LITERAL_PATHSPECS: '1' } : env, logFile, timeoutMin: CFG.checkTimeoutMin });
      return { ...p, ok: p.code === 0 };
    });
    if (r.tries > 1) log(`${job.id}: git ${args[0]} found index.lock held; ${r.ok ? `it went through after ${(r.waited / 1000).toFixed(1)} s` : `still held after ${(r.waited / 1000).toFixed(1)} s`}`);
    return { ...r, out: `${r.out}${lockNote(r)}` };
  };
  const op = GIT_OPS[job.op];
  // The protected files are watched while it runs (a hook of the project's could change one)
  const key = `job:${job.id}`;
  guardOpen(key, `a git job (${job.op}, ${job.id})`);
  let r;
  try {
    r = op ? await op(job, { run, messageFile: path.join(d, 'message.txt') }) : { ok: false, detail: `unknown git job "${job.op}"` };
  } finally {
    guardClose(key);
  }
  const state = r.ok ? 'done' : r.held ? 'blocked' : 'failed';
  setStatus(job.id, { state, detail: r.detail, ...(r.conflicts ? { conflicts: r.conflicts } : {}), finishedAt: now(), acked: false });
  log(`finished ${job.id}: ${state} · ${r.detail}`);
  // A merge or a branch deleted moved work (FR-019); a commit never does
  if (r.ok && r.moved) workMoved(r.moved);
  if (r.ok && job.op === 'merge' && /was merged/.test(r.moved || '')) {
    try {
      testerAfterMerge(job);
    } catch (err) {
      log(`tester: couldn't look at ${job.task}'s acceptance plan: ${err.message}`);
    }
  }
  jobEnded(job.id);
}

function track(id, promise) {
  busy.set(id, promise);
  promise
    .catch((err) => {
      setStatus(id, { state: 'error', error: err.message, finishedAt: now(), acked: false });
      log(`error in ${id}: ${err.message}`);
      jobEnded(id);
    })
    .finally(() => busy.delete(id));
}

async function pollJobs() {
  // Git's own hooks and settings are looked at before the hub's git work (starting a task, checking one, a commit, a
  // merge, a push): a change the hub didn't make stops all of it until the owner decides (gitGuard). Looked at once,
  // when there is git work to do.
  let gitStop;
  const stopped = () => (gitStop ??= gitGuard());
  // A held slot is looked at again when its late listing is due, or when the owner asked (Check again)
  for (const [n, h] of Object.entries(heldSlots())) {
    if (!cleaning.has(Number(n)) && (h.again || (h.state === 'waiting' && Date.parse(h.next) <= Date.now()))) cleanSlot(Number(n));
  }
  for (const s of allJobs()) {
    if (busy.has(s.id)) continue;
    if (s.type === 'task' && s.state === 'verifying' && !stopped()) track(s.id, finishTask(s.id)); // hub restarted mid-verify
    if (s.type !== 'task' || s.state !== 'running') continue;
    const d = jobDir(s.id);
    const run = readJson(path.join(d, 'run.json'));
    const job = readJson(path.join(d, 'job.json')) || {};
    const elapsedMin = (Date.now() - Date.parse(s.startedAt)) / 60000;
    if (run?.endedAt) {
      if (!stopped()) track(s.id, finishTask(s.id));
    } else if (run?.pid && !alive(run.pid) && (elapsedMin > 1 || ended.has(s.id))) {
      // (a worker's process this hub held and saw end needs no minute's wait: workerEnded)
      if (!stopped()) track(s.id, stoppedFromOutside(s, run));
    } else if (!run && Date.now() - Date.parse(s.launch?.at || s.startedAt) > START_WAIT_MS + 15_000) {
      // (the hub that started it watches it for START_WAIT_MS; this is for a hub started again since)
      workerNotStarted(s.id, `no sign of the worker ${Math.round((Date.now() - Date.parse(s.launch?.at || s.startedAt)) / 1000)} s after it was started`);
    } else if (run?.pid && elapsedMin > (job.timeoutMin || CFG.taskTimeoutMin) + CFG.graceMin * 3) {
      writeJson(path.join(d, 'run.json'), { ...run, endedAt: now(), exitCode: null, timedOut: true });
      // Its worker's process at once, through the process the hub holds, if it does (never by a pid alone: one from an
      // earlier hub run may be another program's by now): on Windows its engine goes with it (Node's job); elsewhere its
      // process group (its id can't go to another group while the worker's process isn't collected). Then the slot is
      // held until the listing shows nothing of it runs.
      const held = holding.get(s.id);
      if (held?.pid === run.pid && held.exitCode === null && held.signalCode === null) {
        try {
          if (IS_WIN) held.kill('SIGKILL');
          else process.kill(-held.pid, 'SIGKILL');
        } catch {
          // it ended just now
        }
      }
      holdSlot(s.slot, s, run, Date.now());
      cleanSlot(s.slot);
      log(`${s.id}: stopped after its time limit`);
    }
  }
  if (!fs.existsSync(QUEUE)) return;
  // (the orchestrator can write the queue: a job whose id isn't a plain name, one that would make a folder somewhere
  // else of jobs/, never runs and gets no folder, FR-015)
  const queued = fs
    .readdirSync(QUEUE)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const job = readJson(path.join(QUEUE, f));
      if (job && (typeof job.id !== 'string' || !JOB_ID_RE.test(job.id) || job.id.includes('..'))) {
        fs.rmSync(path.join(QUEUE, f), { force: true });
        log(`queue: ${f} not run: its id ${JSON.stringify(String(job.id).slice(0, 80))} isn't a plain name`);
        return null;
      }
      return job;
    })
    .filter(Boolean)
    .sort((a, b) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
  queuedTasks(queued); // a task dispatched or retried is work that moved (FR-019)
  agyHoldTick(queued); // a hold no task waits for goes, or Check again tries it (FR-022)
  // The assistant on Antigravity: its lock test runs when what it runs changed (an agy update), so a question finds it ready
  const assistant = roleProfile(CFG.config, 'assistant');
  if (needsLockTest(assistant, 'assistant')) lockGate('assistant', assistant);
  // Two lanes, one job at a time each: checks and pushes; the orchestrator's git writes, which must not
  // wait behind a half-hour test run.
  const lane = (type) => (type === 'git' ? 'git' : 'checks');
  const running = new Set([...busy.keys()].map((k) => jobStatus(k)?.type).filter((t) => t && t !== 'task').map(lane));
  // (while dispatch is paused for missing files, tasks wait; checks, pushes and git jobs go on)
  let paused = queued.some((j) => j.type === 'task') && dispatchWaits();
  // The one-click update's hold (src/updater.mjs holdFor): no task starts, and once its wait has ended no job at all, but
  // its own; what runs goes on. A job it holds says why, and the words go once the hold does.
  const hold = updateHold;
  const holds = (job) => hold && !(job.by === 'update' && job.update === hold.id) && (job.type === 'task' || hold.strict);
  for (const job of queued) {
    try {
      if (holds(job)) {
        if (jobStatus(job.id)?.waiting !== hold.text) setStatus(job.id, { waiting: hold.text, waitingFor: 'update' });
        continue;
      }
      if (jobStatus(job.id)?.waitingFor === 'update') setStatus(job.id, { waiting: null, waitingFor: null });
      if (job.type === 'task' && (paused || !freeSlot())) continue; // (it waits for a slot, or for the files a worker needs)
      if (stopped()) {
        // tasks and verify commands wait to start (a verify command runs with the owner's access, FR-017: its status says
        // why it waits); the orchestrator's git and push jobs end now, saying why (its command would only wait); what the
        // owner's approval queued waits for the owner's other decision
        if (job.type === 'check') {
          if (jobStatus(job.id)?.waiting !== stopped()) setStatus(job.id, { waiting: stopped() });
        } else if (job.type !== 'task' && !job.guard) {
          fs.rmSync(path.join(QUEUE, `${job.id}.json`), { force: true });
          setStatus(job.id, { state: 'blocked', detail: `not run: ${stopped()}`, finishedAt: now(), acked: false });
          log(`${job.id}: not run: all git work is stopped`);
          jobEnded(job.id);
        }
        continue;
      }
      if (job.type === 'check' && jobStatus(job.id)?.waiting) setStatus(job.id, { waiting: null }); // (git work goes on again)
      if (job.type === 'task') {
        await startTask(job);
        paused = !!getSettings().dispatchPaused;
      } else if (job.type === 'git') {
        if (running.has('git') || busy.has(job.id)) continue;
        running.add('git');
        track(job.id, runGitJob(job));
      } else if (!running.has('checks') && !busy.has(job.id)) {
        running.add('checks');
        track(job.id, runCheck(job));
      }
    } catch (err) {
      fs.rmSync(path.join(QUEUE, `${job.id}.json`), { force: true });
      setStatus(job.id, { state: 'error', error: err.message, finishedAt: now(), acked: false });
      log(`could not start ${job.id}: ${err.message}`);
      jobEnded(job.id);
    }
  }
}

async function flushOutbox() {
  if (!fs.existsSync(OUTBOX)) return;
  for (const f of fs.readdirSync(OUTBOX).filter((x) => x.endsWith('.json')).sort()) {
    const p = path.join(OUTBOX, f);
    const m = readJson(p);
    if (!m) continue;
    try {
      // (the orchestrator can write the outbox: what is in it is redacted as it goes, whoever wrote it)
      await notify(m.title, m.message, { priority: m.priority, tags: m.tags, server: CFG.config.notifications.server, root: ROOT });
      fs.rmSync(p, { force: true });
    } catch (err) {
      m.attempts = (m.attempts || 0) + 1;
      if (m.attempts >= 5) {
        fs.rmSync(p, { force: true });
        log(`dropped notification "${m.title}": ${err.message}`);
      } else writeJson(p, m);
    }
  }
}

// ---------- what may start an autopilot round (FR-019, lib/rounds.mjs) ----------
// On 4 October a real project's hub started a round every few minutes for twelve hours while the team only waited for the owner:
// rounds were timed, and a round's own commit counted as progress. Now the hub starts one only because something happened,
// and keeps what happened in .nextlevel/rounds.json, which only the hub writes: work that moved (a task queued, merged or
// closed, a push that sent commits) and the ends of task attempts, checks, pushes and merges, as they happen in this
// process; the owner's actions on the cards (their counts, lib/cards.mjs) and Run a round now, when it looks; the
// orchestrator's wake-up (wakeup.json). Each is kept until a round starts, so what happens while the hub is stopped or
// autopilot is off gets its round afterwards.
const CYCLE_MIN = ROUND_LIMIT_MIN; // an autopilot round's time limit
// The state as it is, or, the first time, one made from what is there now: finished jobs nobody reviewed and the owner's
// notes and replies the orchestrator hasn't picked up wait for a round (the hub before FR-019 would have started one)
// rounds.json is a file an agent can write: read through a shape check (lib/rounds.mjs roundsProblem). One that isn't as
// the hub writes it is replaced by a fresh state built as on the first run, said once in hub.log (`quiet`: a reader
// outside the hub, the dashboard's, says nothing), and the hub writes it at its next change (`reseeded`). That fresh state
// takes the cards' owner counts as they are as seen, so the owner's old actions start no round.
let roundsSaid = '';
const reseeded = new WeakSet();
function roundsState({ quiet = false } = {}) {
  if (!fs.existsSync(ROUNDSFILE)) return firstState({ ownerSeen: false });
  const saved = readJson(ROUNDSFILE);
  const s = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...freshState(), ...saved } : saved;
  const problem = saved === null ? 'JSON' : roundsProblem(s);
  if (!problem) return s;
  if (!quiet && roundsSaid !== problem) {
    roundsSaid = problem;
    log(`autopilot: rounds.json isn't as the hub writes it (its ${problem === 'JSON' ? 'text is no JSON' : `"${problem}"`}), so it starts again from what is there now, as on its first run: the owner's actions so far count as seen`);
  }
  const fresh = firstState({ ownerSeen: true });
  reseeded.add(fresh);
  return fresh;
}
// The state as on the first run: finished jobs nobody reviewed wait for a round; the owner's actions counted so far are new
// (ownerSeen: seen), and before FR-019 the cards counted nothing, so what the orchestrator hasn't picked up then waits
function firstState({ ownerSeen }) {
  const s = freshState();
  const now = clockNow();
  for (const j of allJobs().filter((x) => FINAL.has(x.state) && !x.acked)) jobTrigger(s, j, now);
  s.owner = { notes: 0, handoff: 0 };
  try {
    const acts = cards().ownerActs();
    const count = (a) => (Number.isSafeInteger(a?.n) && a.n >= 0 ? a.n : 0);
    if (ownerSeen) s.owner = { notes: count(acts.notes), handoff: count(acts.handoff) };
    else {
      const news = cards().news();
      const ids = [...news.notes, ...news.handoff];
      if (!count(acts.notes) && !count(acts.handoff) && ids.length) addTrigger(s, { type: 'owner', what: `your ${ids.join(', ')}, from before this version of nextlevel` }, now);
    }
  } catch {
    // the cards can't be read: they are looked at again at the next tick
  }
  return s;
}
// cycle.json, as far as the hub counts it (a file the round's engine can write): a string log, a whole-number pid, string
// times, an integer exit code, and whether its engine was launched; nothing else. -> null when there is none
function readCycle() {
  const c = readJson(CYCLEFILE);
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const str = (x) => (typeof x === 'string' ? x : undefined);
  const pid = (x) => (Number.isSafeInteger(x) && x > 0 ? x : undefined);
  return { pid: pid(c.pid), log: str(c.log), startedAt: str(c.startedAt), endedAt: str(c.endedAt), exitCode: Number.isInteger(c.exitCode) ? c.exitCode : null, launched: c.launched === true, enginePid: pid(c.enginePid), engineAt: str(c.engineAt) };
}
// Changes the state (fn(state, now)) and saves it; never across an await, so nothing that happens meanwhile is lost
function rounds(fn) {
  const s = roundsState();
  const before = JSON.stringify(s);
  const r = fn(s, clockNow());
  if (JSON.stringify(s) !== before || !fs.existsSync(ROUNDSFILE) || reseeded.has(s)) writeJson(ROUNDSFILE, s);
  return r;
}
// What started a round, and work that moved, in the hub's words (never the team's: they go to the log and to Home)
const jobWhat = (j) => {
  if (j.type === 'task') return j.stoppedOutside || j.state === 'stopped' ? `task ${j.id} was stopped from outside` : j.notStarted ? `task ${j.id}'s worker didn't start` : `task ${j.id} ended (${j.state}, attempt ${j.attempt || 1})`;
  return `${j.type === 'push' ? 'the push' : j.type === 'check' ? 'the check' : 'the merge'} ${j.id} ended (${j.state})`;
};
// A finished job: a task attempt always starts a round (unless it is reviewed first); a check, a push or a merge one only
// under the brake. Bridge tasks (nextlevel bridge-test) are the owner's check of the setup, not the team's work.
function jobTrigger(s, j, now) {
  if (!j || j.acked || !FINAL.has(j.state)) return;
  if (j.type === 'task') {
    if (!isBridgeTask(j.id)) addTrigger(s, { type: 'task', what: jobWhat(j), job: j.id }, now);
  } else if (j.type === 'check' || j.type === 'push' || (j.type === 'git' && readJson(path.join(jobDir(j.id), 'job.json'))?.op === 'merge')) {
    addTrigger(s, { type: 'job', what: jobWhat(j), job: j.id }, now);
  }
}
// Called wherever the hub ends a job
function jobEnded(id) {
  try {
    rounds((s, now) => jobTrigger(s, jobStatus(id), now));
  } catch (err) {
    log(`autopilot: couldn't note that ${id} ended: ${err.message}`);
  }
}
// Work moved (a task queued, merged or closed; a push that sent commits): something real
function workMoved(what) {
  try {
    rounds((s, now) => noteReal(s, what, now));
  } catch (err) {
    log(`autopilot: couldn't note that ${what}: ${err.message}`);
  }
}
// Tasks the orchestrator (or the owner) queued since the hub last looked at the queue: dispatched or retried
function queuedTasks(jobs) {
  const keys = jobs.filter((j) => j.type === 'task' && !isBridgeTask(j.id)).map((j) => ({ key: `${j.id}@${j.queuedAt}`, j }));
  const s = roundsState();
  const known = new Set(s.queued || []);
  if (fs.existsSync(ROUNDSFILE) && keys.every((k) => known.has(k.key)) && known.size === keys.length) return;
  try {
    rounds((st, now) => {
      const was = new Set(st.queued || []);
      for (const { key, j } of keys) if (!was.has(key)) noteReal(st, j.attempt > 1 ? `task ${j.id} was retried (attempt ${j.attempt})` : `task ${j.id} was dispatched`, now);
      st.queued = keys.map((k) => k.key);
    });
  } catch (err) {
    log(`autopilot: couldn't note the queued tasks: ${err.message}`);
  }
}

// The profile an orchestrator session runs on: the role's, or its fallback when the role's own engine
// isn't ready (not installed, its account can't be used, Codex's model rejected) and the fallback is. The
// fallback is for a setup that isn't ready, never for getting around a provider's limits: nextlevel doesn't
// look at usage or rate limits at all. `why`: 'autopilot' tells the owner once when it switches.
// -> { profile, fallback } or { problem } (the role's own)
async function orchestratorFor(why) {
  const own = CFG.orchestrator;
  const problem = await engineProblem(own);
  const s = getSettings();
  if (!problem) {
    if (why === 'autopilot' && s.onFallback) {
      setSetting('onFallback', null);
      log(`autopilot: ${describeProfile(own)} is ready again; cycles run on it`);
      addSwitch({ kind: 'round', engine: own.engine, profile: own.name || '', roleEngine: own.engine, how: 'role', why: `back on the orchestrator's own engine: ${describeProfile(own)} is ready again`, check: '' });
    }
    return { profile: own, fallback: false };
  }
  const fb = CFG.fallback('orchestrator');
  if (fb && !(await engineProblem(fb))) {
    if (why === 'autopilot' && s.onFallback !== describeProfile(fb)) {
      setSetting('onFallback', describeProfile(fb));
      log(`autopilot: ${problem.text.split('\n')[0]} Cycles run on the fallback, ${describeProfile(fb)}, until it is fixed.`);
      queueNotify(`${NAME} autopilot runs on its fallback`, `${problem.text}\nUntil that is fixed, autopilot cycles run on ${describeProfile(fb)} (roles.orchestrator.fallback).`, 'high', 'warning');
      addSwitch({
        kind: 'round',
        engine: fb.engine,
        profile: fb.name || '',
        roleEngine: own.engine,
        how: 'auto-fallback',
        why: `automatic fallback: the orchestrator's ${describeProfile(own)} can't start (${problem.check}: ${problem.text.split('\n')[0]})`,
        check: problem.check || '',
      });
    }
    return { profile: fb, fallback: true };
  }
  return { problem };
}

// The owner's side and the orchestrator's ask, each time autopilot looks (FR-019): the cards' counts of what the owner did
// (lib/cards.mjs), Run a round now, the owner turning autopilot on (that releases the brake and the fuse), and a wake-up
// the orchestrator asked for (wakeup.json). Also while autopilot is off: what the owner does then gets its round once it
// is on again.
// The wake-up ask in wakeup.json, if the hub hasn't taken it in: at every look, and as a round ends, before its end is
// decided (a round that asked for one gets no round right after it, lib/rounds.mjs), so an ask written just before the
// round's process ended is never seen only after that. An ask is taken in once (`wakeTaken`: its key, as the hub keeps
// it, wakeKey), whatever becomes of it then: a round clears it, the brake lets it go, or it can't be read. The file stays
// (it is the command's): taken in again, an ask the brake let go would come due again at every look. The ask in the file
// when a round started is cleared by that round (`wakeCleared`), even if the hub hadn't taken it in yet; one from before
// the last round started is stale.
function takeAsk(s, now) {
  const ask = readJson(WAKEFILE);
  if (!ask || typeof ask !== 'object') return;
  let key = '';
  try {
    const id = wakeId(ask.id);
    key = wakeKey(ask);
    if ((id && id === s.wakeCleared) || key === s.wakeTaken) return;
    s.wakeTaken = key;
    if (takeWake(s, ask, { cfg: CFG.rounds, now }) !== 'stale') log(`autopilot: the orchestrator asked for a wake-up in ${s.wake.minutes} min${s.wake.due ? ` (at ${new Date(isoMs(s.wake.due)).toLocaleTimeString()}${s.wake.why ? `: ${s.wake.why}` : ''})` : ', its time set when its round ends'}`);
  } catch (err) {
    // (an ask the hub can't read is no ask, said once: the rest of autopilot goes on, and a round's end too)
    if (key) s.wakeTaken = key;
    s.wake = null;
    log(`autopilot: a wake-up ask in ${rel(WAKEFILE)} couldn't be read, so none waits: ${oneLine(err?.message)}`);
  }
}
function observe() {
  const settings = getSettings();
  let acts = null;
  try {
    // (a Done on the dashboard past its Undo becomes final here too, with no page open and after a restart: undo Done)
    cards().handoff.settle();
    acts = cards().ownerActs();
  } catch (err) {
    log(`autopilot: couldn't read the cards: ${err.message}`);
  }
  const pressed = pressCount(readJsonFile(ROUNDNOW, {}));
  rounds((s, now) => {
    if (settings.autopilot && settings.onAt && settings.onAt !== s.onAt) autopilotOn(s, settings.onAt);
    if (acts) {
      const seen = s.owner || { notes: 0, handoff: 0 };
      // (the cards' stores are files an agent can write: a count is a whole number, its words a string, or nothing)
      const count = (a) => (Number.isSafeInteger(a?.n) && a.n >= 0 ? a.n : 0);
      for (const k of ['notes', 'handoff']) {
        const a = acts[k];
        const more = count(a) - (Number.isSafeInteger(seen[k]) ? seen[k] : 0);
        if (more <= 0) continue;
        const what = `${typeof a?.what === 'string' && a.what ? a.what : `you changed the ${k}`}${more > 1 ? ` (and ${more - 1} more of yours)` : ''}`;
        noteReal(s, what, now);
        addTrigger(s, { type: 'owner', what }, now);
      }
      s.owner = { notes: count(acts.notes), handoff: count(acts.handoff) };
    }
    // (a press is a count that changed: one an agent set out of range is read as 0, and the owner's next press counts)
    if (pressed !== (s.runNow || 0)) {
      noteReal(s, 'you pressed Run a round now', now);
      addTrigger(s, { type: 'owner', what: 'you pressed Run a round now' }, now);
    }
    s.runNow = pressed;
    takeAsk(s, now);
  });
}
// A job's end a round has seen: reviewed (`nextlevel result`, the orchestrator's git commands), or seen finish with
// `nextlevel wait` by the round that started it (seenInRound)
// The rounds this hub started in the last hour, kept in its memory too (FR-019): the hourly ceiling holds even when
// rounds.json is rewritten (an agent can write it, KNOWN_ISSUES). Merged into the state before every decision.
let hourStarts = [];
function keepStarts(s, now) {
  const hour = (x) => typeof x === 'string' && isoMs(x) && now - isoMs(x) < 3_600_000 && isoMs(x) <= now;
  hourStarts = hourStarts.filter(hour);
  // (each time as often as the file or the memory has it, whichever more: two rounds can start at the same moment)
  const count = (list) => list.reduce((m, x) => m.set(x, (m.get(x) || 0) + 1), new Map());
  const file = count(Array.isArray(s.starts) ? s.starts.filter(hour) : []);
  const mine = count(hourStarts);
  s.starts = [...new Set([...file.keys(), ...mine.keys()])].sort().flatMap((x) => Array(Math.max(file.get(x) || 0, mine.get(x) || 0)).fill(x));
}
const seenJob = (id) => {
  const s = jobStatus(id);
  return !!(s?.acked || (s && s.type !== 'task' && fs.existsSync(path.join(jobDir(id), SEEN_IN_ROUND))));
};

// What holds autopilot's next round now (the orchestrator's lock test on Antigravity), in words for Home; '' when nothing
let roundHeld = '';
// (kept in settings.json too, when it changes: Home is read by the dashboard's and the status command's processes)
function holdRounds(text) {
  roundHeld = text || '';
  if ((getSettings().roundHeld || '') !== roundHeld) setSetting('roundHeld', roundHeld || null);
  return roundHeld;
}
async function autopilotTick() {
  observe();
  // The round this hub follows: its end is taken in whether autopilot is still on or not
  if (cycle) {
    followCycle();
    if (cycle) {
      // Past its time limit: stopped, again at each look while it runs. Only the round's process this hub started (its
      // child: while the hub holds it, its pid is no other program's), never a pid read from cycle.json, which the
      // round's engine can write (FR-013: a process is killed only when it is known to be the one). A round in a window
      // of its own, or one the last hub started, stops its engine itself at its own limit (CYCLE_MIN + 5, _cycle).
      const started = roundsState().round?.startedAt;
      if (started && clockNow() - isoMs(started) > CYCLE_MIN * 60_000) {
        if (!cycle.cut) log(`autopilot: orchestrator cycle ran over ${CYCLE_MIN} min; ${cycle.child ? 'stopping it' : 'it stops its engine itself within 5 min'}`);
        cycle.cut = 'limit';
        if (cycle.child && !cycle.childEnded) killTree(cycle.child.pid);
      }
      return;
    }
  }
  const settings = getSettings();
  if (!settings.autopilot || settings.pausedReason || orchestratorAlive()) {
    if (roundHeld || settings.roundHeld) holdRounds('');
    return;
  }
  const st = runState();
  if (st.milestones.length && st.doneCount === st.milestones.length) {
    setSetting('autopilot', false);
    queueNotify(`${NAME}: all milestones done`, `Autopilot switched itself off. The status: ${CFG.config.paths.status}`, 'high', 'tada');
    return;
  }
  // The orchestrator on Antigravity waits for a passing lock test of what it runs, before any round starts: a held round
  // isn't a round, so it never counts as one that didn't start (FR-019's fuse); its triggers stay pending, and Home says
  // what it waits for. The hub starts the lock test itself when agy, its model or its arguments change.
  // The one-click update holds new rounds as the lock test does: no round, no fuse, its triggers kept for afterwards (a task
  // that ended while it waited starts one then; the update itself is no real event)
  if (holdRounds(updateHold?.text || lockGate('orchestrator', CFG.orchestrator))) return;
  // Something must have happened: the owner, a task attempt's end, or (under the brake) a check, push or merge ending, a
  // wake-up, the round after work moved, a cut-off round's retry. Nothing else starts a round (lib/rounds.mjs).
  const want = rounds((s, now) => {
    keepStarts(s, now);
    return decide(s, { now, cfg: CFG.rounds, seen: seenJob });
  });
  if (!want.start) return;
  const pick = await orchestratorFor('autopilot');
  if (!pick.profile) {
    const problem = pick.problem;
    if (problem.missing) {
      setSetting('autopilot', false);
      queueNotify(`${NAME} autopilot stopped`, `${problem.text}`, 'high');
      return;
    }
    setSetting('pausedReason', problem.reason);
    log(`autopilot paused: ${problem.text.split('\n')[0]}`);
    queueNotify(`${NAME} autopilot paused`, `${problem.text}\nThen START.cmd -> 6 to resume.`, 'high', 'warning');
    return;
  }
  // (a fallback on Antigravity too)
  if (holdRounds(pick.profile.engine === CFG.orchestrator.engine && (pick.profile.name || '') === (CFG.orchestrator.name || '') ? '' : lockGate('orchestrator', pick.profile))) return;
  startRound(pick);
}

// Whether a round would start now: `nextlevel run --exit-when-idle` (the tests) waits for it
function roundWaiting() {
  const settings = getSettings();
  if (cycle || !settings.autopilot || settings.pausedReason || orchestratorAlive() || lockTest.child || updateHold) return false;
  // (a round held for the orchestrator's lock test waits only while the hold stands: one whose verdict passed since starts)
  if (roundHeld && lockProblem('orchestrator', CFG.orchestrator)) return false;
  return decide(roundsState(), { now: clockNow(), cfg: CFG.rounds, seen: seenJob }).start;
}

// A round, for what `decide` let through (decided again here: something may have come meanwhile)
function startRound({ profile, fallback }) {
  const eng = engine(profile.engine);
  mkdirp(LOGS);
  const logFile = path.join(LOGS, `orchestrator-${stamp()}.log`);
  const startedReal = Date.now();
  // (what it runs on, for the usage ledger's line at its end)
  const used = jobModel(profile, CFG.config, { home: os.homedir() });
  const roundModel = { profile: profile.name || '', model: used.model || '', effort: used.effort || '' };
  const started = rounds((s, now) => {
    keepStarts(s, now);
    const d = decide(s, { now, cfg: CFG.rounds, seen: seenJob });
    if (!d.start) return null;
    const r = roundStarted(s, { now, reasons: d.reasons, cfg: CFG.rounds, extra: { log: rel(logFile), engine: profile.engine, startedReal, ...roundModel } });
    hourStarts.push(s.starts.at(-1));
    // (the ask in wakeup.json now is the one this round clears: its id, so it is never taken again; the file is the command's)
    s.wakeCleared = wakeId(readJson(WAKEFILE)?.id) || s.wakeCleared || null;
    return { ...r, round: s.round };
  });
  if (!started) return;
  // (any round that starts clears the wake-up, roundStarted: the ask in wakeup.json is now older than this round, so the
  // hub never takes it again; this round may ask anew)
  addUsage('autopilot', profile.engine, { runs: 1, line: false }, started.round.type); // (the ledger has it at its end)
  log(`autopilot: a round starts because ${started.round.what}`);
  const jobs = allJobs();
  const toReview = jobs.filter((j) => FINAL.has(j.state) && !j.acked).length;
  const active = jobs.filter((j) => ACTIVE.has(j.state)).length;
  const how = `${describeProfile(profile)}${fallback ? ', the fallback' : ''}`;
  // The round runs in a process of its own (_cycle), with no window: in a console with no window for an engine that
  // needs a real one (agy on Windows), in the background for any other (FR-010). It writes its log itself and the
  // hub follows it through .nextlevel/cycle.json, as it follows workers through run.json.
  fs.rmSync(CYCLEFILE, { force: true });
  const env = { ...childEnv(), NEXTLEVEL_ROOT: ROOT, NEXTLEVEL_CYCLE_LOG: logFile };
  const args = [BIN, '_cycle', ...(fallback ? ['--fallback'] : [])];
  cycle = { startedReal, from: startedReal, log: logFile, engine: profile.engine, cut: null };
  const mine = cycle;
  // (the round's process, as this hub started it: the time limit stops only that one, FR-013)
  const held = (child) => {
    mine.child = child;
    child.on('exit', (code, signal) => {
      mine.childEnded = true;
      mine.childExit = code ?? signal;
    });
  };
  const failed = (err) => {
    log(`autopilot: the cycle couldn't start: ${err.message}`);
    if (cycle === mine) endRound(-1, 'not-started', `its process couldn't be started: ${err.message}`);
  };
  // Where the console with no window didn't start, a round that needs a console gets a window of its own (the way
  // before FR-010); a round whose process found no console to give its engine is remembered as that, and ends at once
  const broken = needsConsole(profile.engine) ? consoleBroken() : null;
  const inConsole = needsConsole(profile.engine) && !broken;
  let where = inConsole ? ', in a console with no window' : '';
  try {
    if (broken) {
      openWindow(`${NAME} autopilot`, process.execPath, args, { cwd: ROOT, env: { ...env, NEXTLEVEL_IN_WINDOW: 'visible' } });
      where = `, in a window of its own: the console with no window didn't start on this PC (${broken.why})`;
    } else if (inConsole) {
      const child = startInConsole(process.execPath, args, { cwd: ROOT, env });
      held(child);
      child.on('error', failed);
      child.on('exit', (code, signal) => {
        if (cycle !== mine || fs.existsSync(CYCLEFILE)) return;
        let why;
        if (code === NO_CONSOLE_EXIT) {
          why = `the round's process found no console to give ${eng.title} (exit ${code})`;
          rememberConsoleFailure(why);
          log(`autopilot: the console with no window didn't start (${why}); the next round opens a window of its own`);
        } else {
          why = `the round's process ended before it started ${eng.title} (exit ${code ?? signal})`;
          log(`autopilot: ${why}`);
        }
        endRound(code ?? -1, 'not-started', why);
      });
    } else {
      const child = spawn(process.execPath, args, { cwd: ROOT, env, detached: !IS_WIN, windowsHide: true, stdio: 'ignore' });
      held(child);
      child.on('error', failed);
      child.unref();
    }
  } catch (err) {
    return failed(err);
  }
  log(`autopilot: orchestrator cycle started (${how}${where}; ${toReview} to review, ${active} active) -> ${rel(logFile)}`);
  if (started.fuse) tripFuse(started.round);
}

// What became of a round's process (_cycle), from its cycle.json, which it writes first thing (FR-019): its engine started
// (`launched`, written the moment the engine is spawned) or it didn't. A round whose engine never started ran nothing
// ('not-started', with what failed); one whose engine started is a round: ended ('ok' or 'crash'), stopped at its limit
// ('limit') or gone from outside ('outside'). -> [code, how, why]
function roundOutcome(c, { cut = null, title = 'its engine' } = {}) {
  if (c.endedAt) {
    const code = Number.isInteger(c.exitCode) ? c.exitCode : null; // (cycle.json: a file the round's engine can write)
    if (c.launched) return [code ?? -1, cut || (code === 0 ? 'ok' : 'crash')];
    return [code ?? -1, 'not-started', `its process ended with exit ${code ?? '?'} before it started ${title}${code === 127 ? ' (it was not found)' : ''}`];
  }
  if (c.launched) return [-1, cut || 'outside'];
  return [-1, 'not-started', `its process ended before it started ${title}, without an exit code (stopped from outside${cut ? ', at its time limit' : ''})`];
}
// A round's process this hub holds no handle for (a round in a window of its own, or one the last hub started): told by its
// pid and start time together, never by the pid alone (FR-013): after a restart of the PC another program may have that
// pid. Its start is read when the hub first sees the pid and at most once a minute after (on Windows PowerShell answers it,
// in a few hundred ms): never at every look. -> 'runs' | 'gone' (the pid runs no more, or another program has it: one
// that started after the round's process said it did, or before the hub started the round) | 'unknown' (its start can't
// be read). Nothing is ever killed by it: cycle.json is a file the round's engine can write.
const ROUND_LOOK_MS = 60_000;
const ROUND_UNKNOWN_MIN = CYCLE_MIN + 5 + 5; // its own limit (it stops its engine at CYCLE_MIN + 5), and 5 minutes more
const START_SLACK = 2000;
// (under the tests' stubs only: a start time that can't be read)
const roundStart = (pid) => (process.env.NEXTLEVEL_TEST_STUBS && process.env.NEXTLEVEL_TEST_PROCESS_START === 'unknown' ? null : processStartSync(pid));
function roundProcess(c) {
  const pid = Number(c?.pid);
  if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return 'gone';
  // (one read a minute for the round, whatever pid cycle.json names: a pid it changes to waits for the next minute)
  if (cycle.proc?.pid !== pid) cycle.proc = { pid, start: null };
  const p = cycle.proc;
  if (Date.now() - (cycle.lookedAt || 0) >= ROUND_LOOK_MS) {
    cycle.lookedAt = Date.now();
    p.start = roundStart(pid);
  }
  if (p.start === null) return 'unknown';
  const said = isoMs(c.startedAt);
  if (said && p.start > said + START_SLACK) return 'gone';
  if (cycle.from && p.start < cycle.from - START_SLACK) return 'gone';
  return 'runs';
}
// Gone, for a round without a handle: its pid and start time say so, or its start can't be read and it is past
// ROUND_UNKNOWN_MIN; never one whose pid and start time say it still runs (it ends itself at its own limit)
function roundGone(c) {
  const v = roundProcess(c);
  if (v !== 'unknown') return v === 'gone';
  const started = isoMs(roundsState().round?.startedAt);
  return !!started && clockNow() - started > ROUND_UNKNOWN_MIN * 60_000;
}

// The round's process: ended, gone, or never started. A round the hub stopped at its time limit ends as that at once; one
// gone by itself is given a minute (its end may be on its way). Gone: the child this hub started ended; else (a window,
// or a round the last hub started) its pid and start time say so (roundProcess), and it ends at once as cut off.
function followCycle() {
  const c = readCycle();
  const age = Date.now() - cycle.startedReal;
  const mine = c && (!c.log || !cycle.log || samePath(path.resolve(ROOT, c.log), cycle.log));
  const title = engineTitle(cycle.engine || CFG.orchestrator.engine);
  if (mine && c.endedAt) endRound(...roundOutcome(c, { cut: cycle.cut, title }));
  else if (mine && cycle.child && cycle.childEnded && (cycle.cut || age > 60_000)) endRound(...roundOutcome(c, { cut: cycle.cut, title }));
  else if (mine && !cycle.child && roundGone(c)) endRound(...roundOutcome(c, { cut: cycle.cut, title }));
  else if (!mine && cycle.child && cycle.childEnded) {
    // (the process this hub started ended before it wrote cycle.json: it never started its engine, known at once)
    endRound(cycle.childExit ?? -1, 'not-started', `its process ended with exit ${cycle.childExit ?? '?'} before it started ${title}${cycle.cut ? ' (stopped at its time limit)' : ''}`);
  } else if (!mine && age > START_WAIT_MS) {
    const why = `there was no sign of its process ${Math.round(age / 1000)} s after it was started`;
    log(`autopilot: the cycle did not start (${why})`);
    endRound(-1, 'not-started', why);
  }
}

// A round's line in the usage ledger: who ran it, and when it started and ended (cycle.json's end when it has one)
function roundMeta(round, c) {
  const rec = readCycle();
  const mine = rec?.endedAt && (!rec.log || !round.log || samePath(path.resolve(ROOT, rec.log), path.resolve(ROOT, round.log)));
  return { start: isoOr(round.startedAt) || undefined, at: ledgerEnd(mine ? rec.endedAt : ''), model: round.model, effort: round.effort, profile: round.profile };
}
// A round whose engine never started: its ledger line alone (usage.json counted it at its start)
function roundLine(round, c, { end, minutes, tokens }) {
  try {
    const meta = roundMeta(round, c);
    const line = runRecord({ role: 'autopilot', engine: round.engine || c?.engine || 'unknown', runs: 1, minutes, tokens, reason: round.type, end, ...meta });
    if (line) appendLedger(DIR, [line], { onLock: lockLog(ledgerDir(DIR)) });
  } catch (err) {
    log(`couldn't write the usage ledger: ${err.message}`);
  }
}

// The round ended (how: lib/rounds.mjs roundEnded). Its minutes and tokens count for what started it (Today, on Home). A
// round whose engine never started is no round: what started it waits again, and the second in a row turns autopilot off.
function endRound(code, how, why = '') {
  const c = cycle;
  cycle = null;
  fs.rmSync(path.join(DIR, 'orchestrator.json'), { force: true }); // (cycle.json stays until the next one: its record)
  const r = rounds((s, now) => {
    if (how !== 'not-started') takeAsk(s, now); // (one the round asked for just before it ended)
    return { round: s.round, ...roundEnded(s, { now, how, cfg: CFG.rounds, why }), last: s.last, failed: s.failed, wake: s.wake };
  });
  if (r.notStarted) {
    log(`autopilot: the round didn't start, so the next one may start at once (what started it waits again): ${r.failed?.why || why}`);
    // (usage.json counted it at its start: the ledger has it too, a round that never started, so the two agree)
    roundLine(r.round || {}, c, { end: 'not-started', minutes: 0, tokens: null });
    if (r.stop) {
      turnItselfOff(
        'not-started',
        `two autopilot rounds in a row didn't start: the orchestrator's engine was never started, the last time because ${r.failed?.why || why}. ` +
          'Nothing ran, so nothing is lost: fix that (nextlevel doctor checks the setup), then turn autopilot on again (Home, or START.cmd -> 6), and what waits gets its round.',
      );
    }
    return;
  }
  const round = r.round || {};
  const eng = adapterOf(round.engine || c?.engine);
  const logFile = c?.log || (round.log ? path.resolve(ROOT, round.log) : '');
  const since = c?.startedReal || round.startedReal || Date.now();
  addUsage('autopilot', round.engine || c?.engine || 'unknown', { minutes: (Date.now() - since) / 60000, tokens: eng && logFile && fs.existsSync(logFile) ? eng.tokens(readText(logFile)) : null, ...roundMeta(round, c), lineRuns: 1 }, round.type);
  // A round on Antigravity whose commands clear the push block or go past it: the owner hears it (by pattern, after the
  // fact: lib/blockwatch.mjs)
  if ((round.engine || c?.engine) === 'agy' && logFile && fs.existsSync(logFile)) blockAlertFor(readText(logFile), rel(logFile));
  const what = r.real ? `something real happened: ${r.last?.realWhat || ''}` : 'nothing real happened';
  const wake = r.real && r.wake?.due ? `; it asked for a wake-up, its next round (at ${new Date(isoMs(r.wake.due)).toLocaleTimeString()})` : '';
  log(`autopilot: cycle ended (exit ${code}, ${what}${r.cut ? `; cut off: ${r.cut}${round.retried ? '' : ', so it gets one retry'}` : ''}${wake})`);
  // A round whose engine failed says why in its own words (FR-022: agy's reason, never just "ERROR")
  const failed = code !== 0 && logFile && fs.existsSync(logFile) ? engineFailureOf(round.engine || c?.engine, readText(logFile).slice(-256 * 1024), code) : null;
  if (failed) log(`autopilot: ${failureLine(engineTitle(round.engine || c?.engine), failed)}`);
}

// A round the last hub started, found when this one starts: followed to its end, or ended now as what became of it
function adoptRound() {
  const s = roundsState();
  if (!s.round || cycle) return;
  const c = readCycle();
  const logFile = s.round.log ? path.resolve(ROOT, s.round.log) : '';
  // (rounds.json is a file an agent can write: a start in the last day, else none)
  const from = Number.isFinite(s.round.startedReal) && s.round.startedReal <= Date.now() && Date.now() - s.round.startedReal < 86_400_000 ? s.round.startedReal : 0;
  cycle = { startedReal: from || Date.now(), from, log: logFile, engine: s.round.engine || '', cut: null };
  const mine = c && (!c.log || !logFile || samePath(path.resolve(ROOT, c.log), logFile));
  const title = engineTitle(cycle.engine || CFG.orchestrator.engine);
  if (!mine) return endRound(-1, 'not-started', 'its process left no sign before the hub stopped');
  if (c.endedAt) return endRound(...roundOutcome(c, { title }));
  // (by its pid and start time: after a restart of the PC another program may have its pid, and then it ended long ago)
  const v = roundProcess(c);
  if (v === 'gone') return endRound(...roundOutcome(c, { title }));
  log(`autopilot: a round the last hub started still runs (pid ${Number(c.pid)}${v === 'unknown' ? `; its start can't be read, so it counts as ended once it is ${ROUND_UNKNOWN_MIN} min old` : ''}): following it`);
}

// The fuse (FR-019): rounds in a row that started with nothing real between them. Autopilot turns itself off, and the
// owner hears why (the phone, redacted like every message, and a card on Home) and how to turn it on again.
function tripFuse(round) {
  const n = CFG.rounds.fuse;
  turnItselfOff(
    'fuse',
    `${n} rounds in a row started with nothing real happening between them (no task dispatched, merged, retried or closed, ` +
      `no push with new commits, nothing from you; the last one because ${round?.what || 'of a trigger'}), so autopilot turned itself off ` +
      'rather than spend more rounds on nothing. Nothing is lost: turn autopilot on again (Home, or START.cmd -> 6) once there is ' +
      'something for the team, and the next round starts when something happens.',
  );
}
// Autopilot off by itself: the fuse, or rounds whose engine never started. Home's card and the phone say why.
function turnItselfOff(kind, text) {
  const t = text[0].toUpperCase() + text.slice(1);
  rounds((s, now) => {
    s.fuse = { at: new Date(now).toISOString(), text: t, kind };
  });
  updateSettings((s) => ({ ...s, autopilot: false }));
  log(`autopilot: ${kind === 'fuse' ? 'the fuse' : 'rounds that never started'}: ${t}`);
  queueNotify(`${NAME}: autopilot turned itself off`, t, 'high', 'warning');
}

// ---------- the day's numbers and alerts (M9, FR-008) ----------
// .nextlevel/usage.json, per day (this PC's date): for each role and engine ("worker:codex"), the runs (autopilot
// rounds, interactive sessions, task attempts), their minutes, and the tokens of the runs whose engine reported
// them ("reported" counts those runs): Codex's "tokens used" and Claude Code's JSON usage from headless runs,
// Codex's session files for its interactive windows, Antigravity's stream-json (FR-010). Roles: 'autopilot' (rounds),
// 'orchestrator' (its interactive window), 'worker' and 'guide'. The totals the dashboard showed before M9's
// Home (rounds, attempts, their minutes, codexTokens) are kept too. Two weeks are kept. An autopilot round is counted
// under what started it too (`reason`, FR-019: roundsBy, lib/rounds.mjs REASONS), its Codex tokens apart.
// Since the usage ledger (docs/design/token-usage.md, lib/usage.mjs) every ended run is also one line of
// .nextlevel/usage/<YYYY-MM>.jsonl, kept for good, with who ran it (profile, model, worker, task); usage.json stays for an
// older version (Go back), its `ledgered` saying what of each day this version counted, so what an older one counted
// comes into the ledger at the hub's start (importOlderUsage).
const usageFile = () => path.join(DIR, 'usage.json');
const dayOf = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// u: { runs, minutes, tokens } for usage.json, and for the ledger's line: line (false: none, a round's start), lineRuns
// (default runs), at and start (ISO; default now, by lib/clock.mjs), model, effort, profile, worker, task, attempt, slot,
// end, notCounted, reason (a round's trigger, the assistant's kind of answer)
function addUsage(role, engineName, u = {}, reasonArg = '') {
  const { runs = 0, minutes = 0, tokens = null } = u;
  const reason = u.reason ?? reasonArg;
  try {
    // (under the file's lock: the hub, an interactive window and the assistant count into it, lib/filelock.mjs)
    updateJsonFile(usageFile(), (all) => usageAdded(all || {}, role, engineName, { runs, minutes, tokens }, reason), {}, { onLock: lockLog(usageFile()) });
  } catch (err) {
    log(`couldn't count the day's usage: ${err.message}`); // the numbers must never stop the hub
  }
  if (u.line === false) return;
  try {
    // (after usage.json's change, never inside it: updateJsonFile may run its change more than once)
    const line = runRecord({ ...u, role, engine: engineName, runs: u.lineRuns ?? runs, minutes, tokens, reason, at: u.at || clockIso(), start: u.start });
    if (line) appendLedger(DIR, [line], { onLock: lockLog(ledgerDir(DIR)) });
  } catch (err) {
    log(`couldn't write the usage ledger: ${err.message}`);
  }
}
function usageAdded(all, role, engineName, { runs, minutes, tokens }, reason) {
  const day = dayOf();
  const cur = { ...(all[day] || {}) };
  const add = (o, k, v) => {
    if (v) o[k] = Math.round(((o[k] || 0) + v) * 1000) / 1000; // minutes to the 60th of a second
  };
  const key = `${role}:${engineName}`;
  const counted = (from) => {
    const row = { ...(from || {}) };
    add(row, 'runs', runs);
    add(row, 'minutes', minutes);
    if (tokens) {
      add(row, 'reported', 1);
      add(row, 'tokens', tokens.tokens || 0);
      add(row, 'cached', tokens.cached || 0);
    }
    return row;
  };
  cur.by = { ...(cur.by || {}), [key]: counted(cur.by?.[key]) };
  // (what of the day this version counted: the ledger has it, so the hub's start imports only what an older one added)
  cur.ledgered = { ...(cur.ledgered || {}), [key]: counted(cur.ledgered?.[key]) };
  if (role === 'autopilot' && isReason(reason)) {
    const why = { ...(cur.roundsBy?.[reason] || {}) };
    add(why, 'runs', runs);
    add(why, 'minutes', minutes);
    if (tokens) {
      add(why, 'reported', 1);
      add(why, 'tokens', tokens.tokens || 0);
      if (engineName === 'codex') add(why, 'codexTokens', tokens.tokens || 0);
    }
    cur.roundsBy = { ...(cur.roundsBy || {}), [reason]: why };
  }
  if (role === 'autopilot') {
    add(cur, 'rounds', runs);
    add(cur, 'roundMinutes', minutes);
  }
  if (role === 'worker') {
    add(cur, 'attempts', runs);
    add(cur, 'workerMinutes', minutes);
  }
  if (engineName === 'codex' && tokens) add(cur, 'codexTokens', tokens.tokens || 0);
  const keep = Object.keys(all).filter((d) => d !== day).sort().slice(-13);
  return { ...Object.fromEntries(keep.map((d) => [d, all[d]])), [day]: cur };
}
// At the hub's start: what usage.json has that this version didn't count (the days before the ledger, a Go back's)
// goes into the ledger as one line per day, role and engine, and `ledgered` catches up, so it is imported once.
function importOlderUsage() {
  let lines = [];
  try {
    updateJsonFile(
      usageFile(),
      (all) => {
        lines = []; // (the change may run again: its last run's lines are the ones written)
        const next = { ...(all || {}) };
        for (const [day, entry] of Object.entries(next)) {
          const found = dayLines(day, entry);
          if (!found.length) continue;
          lines.push(...found);
          next[day] = { ...entry, ledgered: JSON.parse(JSON.stringify(entry.by || {})) };
        }
        return next;
      },
      {},
      { onLock: lockLog(usageFile()) },
    );
    if (lines.length) {
      appendLedger(DIR, lines, { onLock: lockLog(ledgerDir(DIR)) });
      log(`usage: ${lines.length} line(s) of what was counted before the usage ledger (or by an older version) added to it, by day`);
    }
  } catch (err) {
    log(`couldn't add the earlier usage to the ledger: ${err.message}`);
  }
}

// The same path, as Codex or the OS may spell it (case on Windows, \\?\, a link, a short name).
function samePath(a, b) {
  const norm = (x) => {
    const r = path.resolve(String(x).replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
    return IS_WIN ? r.toLowerCase() : r;
  };
  if (norm(a) === norm(b)) return true;
  try {
    return norm(fs.realpathSync.native(a)) === norm(fs.realpathSync.native(b));
  } catch {
    return false;
  }
}
// An interactive session's tokens, where its engine keeps them (Codex's session files), counted once: the
// files it read are noted in settings.json, so the orchestrator's and the guide's windows never share one.
// { tokens, cached } or null.
function sessionUsage(profile, since, until) {
  const eng = engine(profile.engine);
  if (!eng.sessionTokens) return null;
  try {
    const dir = eng.home({ home: os.homedir(), account: profile.account || '', env: process.env, path });
    const list = (d) => {
      try {
        return fs.readdirSync(d);
      } catch {
        return [];
      }
    };
    const skip = getSettings().countedSessions || [];
    const r = eng.sessionTokens({ dir, cwd: ROOT, since, until, read: (f) => readText(f) || null, list, path, same: samePath, skip });
    if (!r) return null;
    setSetting('countedSessions', [...skip, ...r.files].slice(-200));
    return r;
  } catch (err) {
    log(`couldn't read ${eng.title}'s session files for its tokens: ${err.message}`);
    return null;
  }
}

// A window closed with its own X ends nextlevel's process in it too, so its session wasn't counted when it
// ended: the hub counts it when it finds the window's record with nothing behind it (the end: when it noticed).
function closedWindowsTick() {
  for (const [file, role] of [[path.join(DIR, 'orchestrator.json'), 'orchestrator'], [GUIDEFILE, 'guide']]) {
    const o = readJson(file);
    if (!o?.engine || alive(o.pid) || (role === 'orchestrator' && o.mode !== 'interactive')) continue;
    fs.rmSync(file, { force: true });
    const profile = (o.profile && findProfile(CFG.config, o.profile)) || { engine: o.engine, account: '' };
    const since = Date.parse(o.startedAt) || Date.now();
    addUsage(role, o.engine, { runs: 1, minutes: (Date.now() - since) / 60000, tokens: sessionUsage(profile, since, Date.now()), start: isoOr(o.startedAt) || undefined, model: o.model, effort: o.effort, profile: o.profile });
    log(`the ${role === 'guide' ? 'setup guide' : 'orchestrator'}'s window was closed without ending its session: counted it`);
  }
}

// The rows of Home's "Today": what each role ran, per engine, and each engine's share.
const USAGE_ROLES = [
  { key: 'autopilot', title: 'Autopilot rounds', unit: 'round', kind: 'headless' },
  { key: 'orchestrator', title: 'Orchestrator window', unit: 'session', kind: 'interactive' },
  { key: 'worker', title: 'Workers', unit: 'attempt', kind: 'headless' },
  { key: 'guide', title: 'Setup guide', unit: 'session', kind: 'interactive' },
  { key: 'assistant', title: 'Advisor', unit: 'question', kind: 'headless' },
  { key: 'security', title: 'Security engineer', unit: 'scan', kind: 'headless' },
  { key: 'tester', title: 'Tester', unit: 'run', kind: 'program' },
];
// The usage ledger as the dashboard reads it: each month file's lines, read again only when that file changed (its
// size or time), so the live feed's every look costs a stat per month and a run's end re-reads one month
// (docs/design/token-usage.md)
const ledgerCache = new Map(); // month file -> { sig, records, notes }
function ledgerRecords(stateDir) {
  const dir = ledgerDir(stateDir);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  } catch {
    // no ledger yet
  }
  const records = [];
  const notes = [];
  for (const f of names) {
    const file = path.join(dir, f);
    let sig;
    try {
      const st = fs.statSync(file);
      sig = `${st.size}:${st.mtimeMs}`;
    } catch {
      continue;
    }
    let kept = ledgerCache.get(file);
    if (!kept || kept.sig !== sig) {
      // (a line lives in the file of its own month, so one month's range reads only that file)
      const [y, m] = f.slice(0, 7).split('-').map(Number);
      kept = { sig, ...readLedger(stateDir, { from: new Date(y, m - 1, 1).getTime(), to: new Date(y, m, 1).getTime() }) };
      ledgerCache.set(file, kept);
    }
    for (const r of kept.records) records.push(r); // (never a spread: a big month would pass too many arguments)
    for (const x of kept.notes) notes.push(x);
  }
  return { records, notes };
}
// A ledger line's runs and whether its engine reported tokens, as sumUsage counts them
const lineRunsOf = (r) => r.runs ?? (r.kind === 'day' ? 0 : 1);
const lineReported = (r) => (!r.tokens ? 0 : r.kind === 'day' ? r.reported ?? lineRunsOf(r) : 1);
// A role nextlevel doesn't list (a newer version's, or one an agent wrote) still gets a row, titled by its key
const usageRole = (key) => USAGE_ROLES.find((d) => d.key === key) || { key, title: key, unit: 'run', kind: 'headless' };

// Today's numbers from the usage ledger, with what runs now counted so far (its minutes; an open window as a session)
function usageToday(jobs) {
  const today = ranges(clockNow()).find((r) => r.key === 'today');
  const recs = within(ledgerRecords(DIR).records, today);
  const midnight = new Date().setHours(0, 0, 0, 0);
  const since = (iso) => (iso ? Math.max(0, Date.now() - Math.max(Date.parse(iso), midnight)) / 60000 : 0);
  const r1 = (x) => Math.round(x * 10) / 10;
  const rows = new Map(); // "role:engine" -> row
  const row = (role, eng) => {
    const key = `${role}:${eng}`;
    if (!rows.has(key)) rows.set(key, { role, engine: eng, runs: 0, running: 0, minutes: 0, tokens: 0, cached: 0, reported: 0 });
    return rows.get(key);
  };
  for (const x of recs) {
    const r = row(x.role, x.engine);
    r.runs += lineRunsOf(x);
    r.minutes += x.minutes || 0;
    r.tokens += x.tokens?.total || 0;
    r.cached += x.tokens?.cached || 0;
    r.reported += lineReported(x);
  }
  for (const j of jobs.filter((x) => x.type === 'task' && (x.state === 'running' || x.state === 'verifying') && x.engine)) {
    const r = row('worker', j.engine);
    r.running += 1;
    r.minutes += since(j.startedAt);
  }
  const o = readJson(path.join(DIR, 'orchestrator.json'));
  if (o?.engine && alive(o.pid)) {
    const r = row(o.mode === 'autopilot' ? 'autopilot' : 'orchestrator', o.engine);
    r.running += 1;
    r.minutes += since(o.startedAt);
  }
  const g = readJson(GUIDEFILE);
  if (g?.engine && alive(g.pid)) {
    const r = row('guide', g.engine);
    r.running += 1;
    r.minutes += since(g.startedAt);
  }
  // Where an engine's tokens come from for a kind of run, or '' where it doesn't report them
  const from = (eng, kind) => ADAPTER_USAGE(eng)[kind] || '';
  const shape = (r, kind) => ({
    ...r,
    title: engineTitle(r.engine),
    minutes: r1(r.minutes),
    // runs that ended plus the ones open now; the tokens of those that reported
    count: r.runs + r.running,
    tokensFrom: from(r.engine, kind),
  });
  const keys = [...USAGE_ROLES.map((d) => d.key), ...new Set([...rows.values()].map((r) => r.role).filter((k) => !USAGE_ROLES.some((d) => d.key === k)))];
  const roles = keys.map(usageRole).map((def) => {
    const list = [...rows.values()].filter((r) => r.role === def.key).map((r) => shape(r, def.kind)).sort((a, b) => b.minutes - a.minutes);
    const total = list.reduce((t, r) => ({ count: t.count + r.count, minutes: t.minutes + r.minutes, tokens: t.tokens + r.tokens, reported: t.reported + r.reported, running: t.running + r.running }), { count: 0, minutes: 0, tokens: 0, reported: 0, running: 0 });
    return { ...def, ...total, minutes: r1(total.minutes), engines: list, tokensKnown: list.some((r) => r.tokensFrom) };
  });
  const engines = [...new Set([...rows.values()].map((r) => r.engine))].map((eng) => {
    const list = roles.flatMap((role) => role.engines.filter((r) => r.engine === eng).map((r) => ({ ...r, unit: role.unit })));
    return {
      engine: eng,
      title: engineTitle(eng),
      parts: list.filter((r) => r.count).map((r) => ({ role: r.role, unit: r.unit, count: r.count })),
      minutes: r1(list.reduce((t, r) => t + r.minutes, 0)),
      tokens: list.reduce((t, r) => t + r.tokens, 0),
      cached: list.reduce((t, r) => t + r.cached, 0),
      reported: list.reduce((t, r) => t + r.reported, 0),
      tokensKnown: list.some((r) => r.tokensFrom),
      notReported: ADAPTER_USAGE(eng).why || '',
    };
  }).sort((a, b) => b.minutes - a.minutes);
  const ofRole = (role) => recs.filter((x) => x.role === role);
  const sum = (list, f) => list.reduce((t, x) => t + f(x), 0);
  const running = jobs.filter((j) => j.type === 'task' && (j.state === 'running' || j.state === 'verifying')).reduce((m, j) => m + since(j.startedAt), 0);
  const round = o?.mode === 'autopilot' && alive(o.pid) ? since(o.startedAt) : 0;
  return {
    day: dayOf(),
    roles,
    engines,
    // the day's autopilot rounds by what started them (FR-019), with their minutes and tokens
    roundsBy: roundsByReason(ofRole('autopilot')),
    // the totals Home showed before
    rounds: sum(ofRole('autopilot'), lineRunsOf),
    roundMinutes: r1(sum(ofRole('autopilot'), (x) => x.minutes || 0) + round),
    attempts: sum(ofRole('worker'), lineRunsOf),
    workerMinutes: r1(sum(ofRole('worker'), (x) => x.minutes || 0) + running),
    codexTokens: sum(recs.filter((x) => x.engine === 'codex'), (x) => x.tokens?.total || 0),
    codexUsed: profilesInUse(CFG.config).some((p) => p.engine === 'codex') || jobs.some((j) => j.engine === 'codex'),
  };
}
// Autopilot rounds by what started them (FR-019), from the ledger's lines of a range; a round with no reason was counted
// before the ledger (a day's line from usage.json) or by an older version
function roundsByReason(recs) {
  const r1 = (x) => Math.round(x * 10) / 10;
  const groups = new Map();
  for (const x of recs) {
    const key = REASON_ORDER.includes(x.reason) ? x.reason : 'earlier';
    const g = groups.get(key) || { key, title: key === 'earlier' ? 'Counted before this version, or with no reason recorded' : REASONS[key].title, count: 0, minutes: 0, tokens: 0, codexTokens: 0, reported: 0 };
    g.count += lineRunsOf(x);
    g.minutes += x.minutes || 0;
    g.tokens += x.tokens?.total || 0;
    if (x.engine === 'codex') g.codexTokens += x.tokens?.total || 0;
    g.reported += lineReported(x);
    groups.set(key, g);
  }
  return [...REASON_ORDER, 'earlier'].filter((k) => groups.get(k)?.count).map((k) => ({ ...groups.get(k), minutes: r1(groups.get(k).minutes) }));
}

// The projects a usage view sums: this one, and with all, the others this PC's owner commands recorded (state.json),
// each read where it is; one whose folder is gone is "not found"
function usageProjects(range, all) {
  const roots = [ROOT];
  if (all) {
    const known = (userState().get('projects') || []).filter((r) => typeof r === 'string');
    for (const r of known) if (!roots.some((x) => samePath(x, r))) roots.push(r);
  }
  return roots.map((root, i) => {
    const stateDir = i === 0 ? DIR : path.join(root, '.nextlevel');
    if (i > 0 && !fs.existsSync(stateDir)) return { root, name: path.basename(root), found: false, records: [], notes: [] };
    const got = ledgerRecords(stateDir);
    return { root, name: path.basename(root), found: true, records: within(got.records, range), notes: got.notes };
  });
}
const totalOf = (records) => sumUsage(records.map((r) => ({ ...r, all: 'all' })), { by: 'all' })[0] || null;
// What a group's key reads as on the page
function usageKeyTitle(by, key) {
  if (key === '' || key === undefined) return by === 'model' ? 'model not recorded' : by === 'worker' ? 'not a worker' : by === 'task' ? 'not a task' : 'not recorded';
  if (by === 'engine') return engineTitle(key);
  if (by === 'role') return usageRole(key).title;
  if (by === 'reason') return REASONS[key]?.title || key;
  if (by === 'worker') return { workers: 'Workers', second: 'Second worker', fallback: 'Fallback', asked: 'Asked for (--engine, --profile)' }[key] || key;
  return String(key);
}
// The dashboard's Usage card for a range, grouped by one field (GET /api/usage): its rows, the total, the days for the
// chart (per engine), the rounds by what started them, and with all, a row per project. The owner's (the page's key).
function usageView({ range = 'today', by = 'role', all = false } = {}) {
  const now = clockNow();
  const rg = ranges(now).find((r) => r.key === range) || ranges(now)[1];
  const projects = usageProjects(rg, all);
  const records = projects.flatMap((p) => p.records);
  const rows = sumUsage(records, { by }).map((g) => ({ ...g, title: usageKeyTitle(by, g.key) }));
  const oldest = oldestDay(projects.flatMap((p) => p.records).sort((a, b) => (a.kind === 'day' ? a.day : a.at).localeCompare(b.kind === 'day' ? b.day : b.at)));
  const days = rg.key === 'hour' || rg.key === 'today' ? [] : perDay(records, { from: Number.isFinite(rg.from) ? rg.from : -Infinity, now });
  const jobs = allJobs();
  const running = jobs.filter((j) => j.type === 'task' && (j.state === 'running' || j.state === 'verifying')).length + (hubAlive() && alive(readJson(path.join(DIR, 'orchestrator.json'))?.pid) ? 1 : 0);
  return {
    ok: true,
    range: rg.key,
    title: rg.title,
    since: rg.key === 'all' && oldest ? `from ${oldest}, the oldest day counted` : rg.since,
    by,
    rows,
    total: totalOf(records),
    days: days.map((d) => ({ day: d.day, runs: d.runs, tokens: d.tokens, engines: Object.entries(d.engines).map(([engine, tokens]) => ({ engine, title: engineTitle(engine), tokens })) })),
    roundsBy: roundsByReason(records.filter((r) => r.role === 'autopilot')),
    running,
    projects: all ? projects.map((p) => ({ name: p.name, found: p.found, total: totalOf(p.records) })) : null,
    notes: projects.flatMap((p) => p.notes.map((x) => (projects.length > 1 ? `${p.name}: ${x}` : x))),
  };
}
// Each task's tokens and attempts from the ledger, for the Build page
function taskUsage() {
  const out = new Map();
  for (const r of ledgerRecords(DIR).records) {
    if (r.role !== 'worker' || r.kind === 'day' || !r.task) continue;
    const t = out.get(r.task) || { attempts: 0, tokens: 0, reported: 0, minutes: 0 };
    t.attempts += lineRunsOf(r);
    t.tokens += r.tokens?.total || 0;
    t.reported += lineReported(r);
    t.minutes += r.minutes || 0;
    out.set(r.task, t);
  }
  return out;
}

// An engine's adapter, or null for a name nextlevel doesn't know (a job record from elsewhere)
const adapterOf = (name) => {
  try {
    return name ? engine(name) : null;
  } catch {
    return null;
  }
};
const ADAPTER_USAGE = (name) => adapterOf(name)?.usage || {};

// Fallbacks and engine switches for Home, newest first: what ran on another engine than its role's, and why.
// The project's GitHub checks on this PC (the self-hosted runner's part A): the Team page's card, from the repository's
// facts kept 10 minutes (lib/ghrepo.mjs). A missing, stale or partial answer is read again in the background with the
// owner's gh (GETs only), one read at a time and at most once a minute; the page shows it at its next refresh.
let repoRead = null;
let repoReadAt = 0;
function githubChecksView() {
  const slug = githubRepo(git(['config', '--get', 'remote.origin.url'], { allowFail: true }).out);
  if (!slug) return checksView(null, null);
  const kept = cachedFacts(slug);
  if ((!kept || !kept.fresh || !factsComplete(kept)) && !repoRead && Date.now() - repoReadAt > 60_000) {
    repoReadAt = Date.now();
    repoRead = repoFacts(slug, (args) => runQuietAsync('gh', args, { timeoutMs: 30_000 }), { fresh: true })
      .catch((err) => log(`GitHub checks: reading ${slug} failed: ${err.message}`))
      .finally(() => (repoRead = null));
  }
  return checksView(slug, kept, { refreshing: !!repoRead });
}

function switchesView(n = 12) {
  const list = readJson(SWITCHES, []);
  return (Array.isArray(list) ? list : [])
    .slice(-n)
    .reverse()
    .map((x) => ({ ...x, engineTitle: engineTitle(x.engine), roleEngineTitle: x.roleEngine ? engineTitle(x.roleEngine) : '', title: x.kind === 'task' && x.id ? specTitle(x.id) : '' }));
}

// A task that needs a look (lib/overview.mjs): past three attempts, or running over its time limit. On the
// Home page, and once on the owner's phone.
const taskAlerts = (jobs = allJobs()) => findAlerts(jobs, { taskTimeoutMin: CFG.taskTimeoutMin, graceMin: CFG.graceMin });
function alertTick() {
  const sent = getSettings().alerted || [];
  const fresh = taskAlerts().filter((a) => !sent.includes(`${a.id}#${a.attempt}#${a.kind}`));
  if (!fresh.length) return;
  for (const a of fresh) {
    log(`alert: ${a.text}`);
    queueNotify(`${NAME}: ${a.id} needs a look`, a.text, 'high', 'warning');
  }
  setSetting('alerted', [...sent, ...fresh.map((a) => `${a.id}#${a.attempt}#${a.kind}`)].slice(-100));
}

// What holds the next round, read from the files (Home runs in the dashboard's process too): the lock test's hold, or a
// lock test the orchestrator on agy hasn't passed yet
function heldWords() {
  // (a verdict's hold first: it is written the moment the lock test ends, the round's sentence at the hub's next look)
  const h = lockHold('orchestrator');
  if (h) return `the ${h.role} is held: ${lockHoldText(h)}`;
  if (roundHeld) return roundHeld;
  const kept = getSettings().roundHeld;
  if (kept && hubAlive()) return kept;
  try {
    const p = lockProblem('orchestrator', CFG.orchestrator);
    return p ? `the orchestrator's lock test on Antigravity hasn't passed for what it runs now: it runs first` : '';
  } catch {
    return '';
  }
}
// Autopilot in one plain sentence: what it does now, and what the next round waits for (FR-019, lib/rounds.mjs waitView):
// "Waits for your reply on H22, a new note, or a task finishing", a wake-up's time and reason, the brake, or the fuse.
function autopilotView(settings = getSettings(), jobs = allJobs()) {
  const base = { on: !!settings.autopilot, paused: settings.pausedReason || null, onFallback: settings.onFallback || null };
  const s = roundsState({ quiet: true });
  const o = readJson(path.join(DIR, 'orchestrator.json'));
  const open = o && alive(o.pid);
  let items = [];
  try {
    items = cards().handoff.list();
  } catch {
    // the cards can't be read now: the sentence names no card
  }
  const waiting = items.filter((x) => x.status === 'open' || awaitsOwner(x));
  const time = (iso) => new Date(isoMs(iso)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const view = waitView(s, {
    on: base.on,
    paused: base.paused,
    hubRunning: hubAlive(),
    interactive: open && o.mode === 'interactive',
    held: base.on && !base.paused ? heldWords() : '',
    cfg: CFG.rounds,
    now: clockNow(),
    seen: seenJob,
    cards: waiting.filter((x) => !x.guard).map((x) => x.id),
    decisions: waiting.filter((x) => x.guard && x.status === 'open').map((x) => x.id),
    tasksActive: jobs.filter((j) => j.type === 'task' && ACTIVE.has(j.state)).length,
    checksActive: jobs.filter((j) => j.type !== 'task' && ACTIVE.has(j.state)).length,
    time,
    fuseShown: !!s.fuse && !base.on && isoMs(s.fuse.at) >= isoMs(settings.onAt),
  });
  if (view.state === 'round' && base.onFallback) view.text += `; on the fallback (${base.onFallback})`;
  // Run a round now: while autopilot is on and nothing else is in the way
  const runNow = base.on && !base.paused && !['interactive', 'round'].includes(view.state);
  return { ...base, ...view, runNow, braked: view.state === 'braked', last: s.last ? { at: s.last.endedAt, what: s.last.what, real: s.last.real, realWhat: s.last.realWhat } : null };
}

// An interactive orchestrator that stopped with finished jobs left to review (FR-004 #8): one notification
// per set of such jobs, so the owner can nudge it. On autopilot the hub wakes the orchestrator itself.
const NUDGE_MIN = 15;
function reviewNudgeTick() {
  const o = readJson(path.join(DIR, 'orchestrator.json'));
  if (o?.mode !== 'interactive' || !alive(o.pid)) return;
  const waiting = allJobs().filter((j) => FINAL.has(j.state) && !j.acked && j.finishedAt && Date.now() - Date.parse(j.finishedAt) > NUDGE_MIN * 60_000);
  const ids = waiting.map((j) => j.id).sort();
  if (!ids.length || JSON.stringify(getSettings().reviewNudge || []) === JSON.stringify(ids)) return;
  setSetting('reviewNudge', ids);
  log(`the orchestrator has left ${ids.length} finished job(s) unreviewed for ${NUDGE_MIN}+ min: asking the owner to nudge it`);
  queueNotify(
    `${NAME}: the orchestrator stopped`,
    `${ids.length} finished job(s) have waited over ${NUDGE_MIN} min for review: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? ', ...' : ''}.\nIn the orchestrator's window (${engineTitle(o.engine || CFG.orchestrator.engine)}), type: continue`,
    'high',
  );
}

function dailyTick() {
  const s = getSettings();
  const today = new Date().toDateString();
  if (new Date().getHours() !== CFG.reportHour || s.lastReport === today) return;
  setSetting('lastReport', today);
  sendDailyReport({ quiet: true })
    .then(() => log('sent the daily report'))
    .catch((err) => log(`daily report failed: ${err.message}`));
}

function idleTick() {
  const s = getSettings();
  if (s.autopilot && !s.pausedReason) return;
  const st = runState();
  const active = allJobs().some((j) => ACTIVE.has(j.state));
  if (active || st.idleHours < 1.5 || (st.milestones.length && st.doneCount === st.milestones.length)) return;
  if (s.lastIdleNotice && Date.now() - s.lastIdleNotice < 3 * 3_600_000) return;
  setSetting('lastIdleNotice', Date.now());
  const why = orchestratorAlive() ? 'The orchestrator window is open but idle, probably waiting for you.' : 'No orchestrator is running.';
  queueNotify(`${NAME} is idle`, `No activity for ${ago(st.idleHours).replace(' ago', '')}. ${why} START.cmd -> 5, or turn on autopilot (-> 6).`, 'high');
}

// ---------- the security engineer's scans (src/security.mjs, docs/design/security-engineer.md) ----------
// Only the owner asks for a scan (nextlevel security scan, into the guard's folder the orchestrator's sandbox can't
// write); the hub starts one at a time in a child process it follows (`_scan`), never while an update holds new work, and
// counts its minutes and tokens when it ends. A scan isn't a job: no queue, no jobs/, no round (FR-019).
const scan = { child: null, id: '' };
function scanContext() {
  const secrets = activitySecrets();
  return { root: ROOT, stateDir: DIR, config: CFG.config, base: CFG.base, envKeys: DOTENV_KEYS, cache: jsonStore(path.join(DIR, 'check-cache.json')), secrets: { ...secrets, redact: (t) => redactReport(t, secrets) }, log };
}
function securityTick() {
  if (scan.child) return;
  const [ask] = pendingRequests(ROOT);
  if (!ask) return;
  if (updateHold) return; // (it waits for the update, as new tasks do)
  fs.rmSync(ask.file, { force: true });
  proposeSecurityFile();
  const what = Buffer.from(JSON.stringify({ id: ask.id, deep: ask.deep })).toString('base64url');
  const child = spawn(process.execPath, [BIN, '_scan', what], { cwd: ROOT, env: { ...process.env, NEXTLEVEL_ROOT: ROOT }, stdio: 'ignore', windowsHide: true, detached: !IS_WIN });
  Object.assign(scan, { child, id: ask.id });
  log(`security scan ${ask.id}: starting (${ask.deep ? 'deep' : 'standard'}), asked by the owner`);
  const done = () => {
    if (scan.child !== child) return;
    scan.child = null;
    const s = readScan(DIR, ask.id);
    if (s && ['starting', 'waiting', 'running'].includes(s.state)) {
      // (its process ended without saying how: a crash, or the hub stopped it)
      for (const line of recoverScans({ root: ROOT, stateDir: DIR, envKeys: DOTENV_KEYS })) log(line);
    }
    const r = readScan(DIR, ask.id) || {};
    addUsage('security', 'codex', { runs: 1, minutes: r.minutes || 0, tokens: r.tokens || null, model: r.model, effort: r.effort, profile: r.profile, reason: ask.deep ? 'deep' : 'scan' });
    log(`security scan ${ask.id}: ${r.state || 'ended'}${r.counts ? `, ${r.counts}` : ''}${r.why ? ` (${r.why})` : ''}`);
    if (r.state === 'done') proposeDraft(ask.id);
  };
  child.once('exit', done);
  child.once('error', (err) => {
    log(`security scan ${ask.id} didn't start: ${err.message}`);
    done();
  });
}
// ---------- the security engineer's policy (lib/securitypolicy.mjs): a text the owner approves on a card ----------
// The text is kept in the guard's blobs and held by its hash (the safe text alone: where it came from is the record's,
// P1); the card shows that blob, never a file the team can write. Nothing reaches the phone: the card is under Needs you.
const policyHeld = () => guard().held.list().filter((x) => x.kind === 'policy' && x.status === 'held');
function holdPolicy({ source, raw, scan: scanId = '', commit = '' }) {
  const t = policyText(raw, activitySecrets());
  if (!t.text) return null;
  if (readPolicy(ROOT).approved?.hash === t.hash) return null; // (it is the policy already)
  const store = guard();
  store.putBlob(Buffer.from(t.text, 'utf8'));
  // (the card's exact change: from nothing, or from the policy approved now)
  const shown = shownDiff(diffTexts('security-policy.md', approvedPolicy(ROOT)?.text ?? null, t.text, { tmpDir: path.join(store.dir, 'tmp') }));
  const { item, fresh } = store.held.add({ kind: 'policy', source, scan: scanId, commit, hash: t.hash, cut: t.cut, by: source === 'draft' ? 'the security engineer' : 'SECURITY.md', task: '', job: '', files: [], key: t.hash, summary: [], ...shown });
  if (!fresh) return null; // (held already, or rejected before: never again)
  // (a SECURITY.md that changed again while its older text waits: the older card is closed, P1)
  for (const x of policyHeld().filter((y) => y.id !== item.id && y.source === source && source === 'SECURITY.md')) closePolicy(x, 'SECURITY.md changed again');
  raiseCard(item);
  return item;
}
// A held policy the hub closes itself (a newer one replaced it): never the owner's doing
function closePolicy(x, why) {
  try {
    guard().held.update(x.id, { status: 'superseded', decidedAt: now(), detail: why }, { expect: ['held'] });
    cards().handoff.decideGuard(x.id, { reply: `Closed by nextlevel: ${why}`, hub: true });
    log(`security policy ${x.id}: closed (${why})`);
  } catch (err) {
    log(`security policy ${x.id}: couldn't close it: ${err.message}`);
  }
}
// The base branch's root SECURITY.md, when a scan is asked for: a regular file (mode 100644) of at most 64 KB (P6)
function proposeSecurityFile() {
  try {
    const ls = git(['ls-tree', '-z', `refs/heads/${CFG.base}`, '--', 'SECURITY.md'], { allowFail: true });
    const m = /^(\d{6}) blob ([0-9a-f]{40,64})\tSECURITY\.md$/.exec(ls.out.replace(/\0$/, ''));
    if (!ls.ok || !ls.out) return;
    if (!m || m[1] !== '100644') return log(`security policy: SECURITY.md on ${CFG.base} isn't a regular file: no card`);
    const size = Number(git(['cat-file', '-s', m[2]], { allowFail: true }).out);
    if (!(size <= POLICY_MAX)) return log(`security policy: SECURITY.md on ${CFG.base} is over ${POLICY_MAX / 1024} KB: no card`);
    const buf = gitBlob(m[2]);
    if (!buf) return;
    const commit = git(['rev-parse', `refs/heads/${CFG.base}`], { allowFail: true }).out;
    const item = holdPolicy({ source: 'SECURITY.md', raw: buf.toString('utf8'), commit: /^[0-9a-f]{40}$/.test(commit) ? commit : '' });
    if (item) log(`security policy: SECURITY.md on ${CFG.base} waits for the owner (${item.id})`);
  } catch (err) {
    log(`security policy: couldn't read SECURITY.md: ${err.message}`);
  }
}
// After a scan that ended done: a draft from its threat model, when one may be made (P8)
function proposeDraft(id) {
  try {
    const st = readPolicy(ROOT);
    if (!mayDraft(st, { pending: policyHeld().length > 0 })) return;
    const src = draftSource(ROOT, DIR, id);
    if (!src) return;
    const item = holdPolicy({ source: 'draft', raw: src.text, scan: id, commit: src.commit });
    if (!item) return;
    changePolicy(ROOT, () => ({ draftAgain: false }));
    log(`security policy: the security engineer drafted one from ${id} (${item.id})`);
  } catch (err) {
    log(`security policy: couldn't draft one from ${id}: ${err.message}`);
  }
}
// The owner's decision on a policy card (P2): Approve makes exactly its text the policy; nothing in the project changes
function policyDecide(rec, action, why) {
  const store = guard();
  if (action === 'reject') {
    store.held.update(rec.id, { status: 'rejected', decidedAt: now(), reason: why }, { expect: ['held'] });
    if (rec.source === 'draft') changePolicy(ROOT, () => ({ rejectedDraftAt: now(), draftAgain: false }));
    cards().handoff.decideGuard(rec.id, { reply: `Rejected${why ? `: ${why}` : ''}. The policy stays as it was.` });
    log(`guard: the owner rejected ${rec.id} (a security policy)${why ? `: ${why}` : ''}`);
    return { message: 'Rejected: the policy stays as it was, and this text never comes back.' };
  }
  if (!store.getBlob(rec.hash)) throw new Error(`${rec.id}'s text isn't kept any more, so it can't be approved: ask for a new draft on the Security page`);
  store.held.update(rec.id, { status: 'applied', decidedAt: now(), reason: why }, { expect: ['held'] });
  changePolicy(ROOT, () => ({ approved: { hash: rec.hash, from: rec.source, scan: rec.scan || '', commit: rec.commit || '', card: rec.card || '', guard: rec.id, at: now() } }));
  cards().handoff.decideGuard(rec.id, { reply: 'Approved: every scan from now reads exactly this text as its policy.' });
  for (const x of policyHeld()) closePolicy(x, `a newer policy was approved (${rec.id})`);
  log(`guard: the owner approved ${rec.id} (a security policy, ${rec.hash.slice(0, 12)})`);
  return { message: 'Approved: the next scan reads exactly this text as its policy. No file in the project changed.' };
}

// What Home's Security card and the tab's count read, cheaply (the scans' records and the policy, no findings): the
// newest scan in words, the newest trusted scan's counts, a policy card waiting. `version` changes when any of it does.
const SCAN_WORDS = { asked: 'asked for', starting: 'starting', waiting: "waiting for another project's scan", running: 'running', done: 'done', failed: "failed: its output isn't trusted", couldnt: "couldn't run", stopped: 'stopped' };
function securitySummary() {
  const p = securityProfile(CFG.config);
  let scans = [];
  try {
    scans = listScans(DIR).slice(0, 10);
  } catch {
    scans = [];
  }
  const asked = pendingRequests(ROOT)[0] || null;
  const s = scans[0] || null;
  const newest = asked && (!s || asked.id > s.id) ? { id: asked.id, state: 'asked', deep: asked.deep, at: asked.at } : s;
  const t = scans.find((x) => x.trusted && scanTrusted(ROOT, DIR, x.id)) || null;
  const pending = policyHeld().map((x) => ({ id: x.id, card: x.card || '', source: x.source }));
  const last = newest ? { id: newest.id, state: newest.state, words: SCAN_WORDS[newest.state] || newest.state, deep: !!newest.deep, at: newest.startedAt || newest.askedAt || newest.at || '', minutes: newest.minutes || 0, why: newest.why || '', running: ['asked', 'starting', 'waiting', 'running'].includes(newest.state), trusted: !!newest.trusted && newest.id === t?.id, daybreak: newest.daybreak || '' } : null;
  const trusted = t ? { id: t.id, counts: t.counts || '', high: /\b\d+ (critical|high)\b/.test(t.counts || ''), at: t.endedAt || t.startedAt || '', daybreak: t.daybreak || '', partial: !!t.partial } : null;
  const st = readPolicy(ROOT);
  const policy = st.approved;
  return {
    on: !!p,
    deepMinutes: CFG.config.security?.deepScanMinutes || 0,
    last,
    trusted,
    pending,
    policy: policy ? { from: policy.from, at: policy.at, hash: policy.hash.slice(0, 12) } : null,
    version: JSON.stringify([last?.id, last?.state, trusted?.id, pending.map((x) => x.id), policy?.hash, st.draftAgain, st.rejectedDraftAt]),
  };
}
// The Security page's data and its buttons (the owner's, through the dashboard's key; refused in an agent's session as
// the commands are)
function securityAct(b) {
  const session = agentSession();
  if (session) throw new Error(ownerOnly('The Security page', 'The owner uses it in their own browser.', session));
  const ctx = { root: ROOT, stateDir: DIR, config: CFG.config, hubAlive };
  const action = String(b?.action || '');
  if (action === 'scan' || action === 'deep') return requestScan(ctx, { deep: action === 'deep' });
  if (action === 'stop') return requestStop(ctx, typeof b.id === 'string' ? b.id : '');
  if (action === 'draft') return requestDraft(ctx);
  throw new Error('action must be scan, deep, stop or draft');
}

// The hub stops: a scan it runs is asked to stop (its container stopped, its partial output kept), and waited for a
// minute and a half; one that doesn't end by then is removed by the next hub's start
async function stopScanForHub() {
  const child = scan.child;
  if (!child) return;
  log(`stopping: security scan ${scan.id} is asked to stop`);
  try {
    fs.mkdirSync(path.join(DIR, 'security', 'scans', scan.id), { recursive: true });
    fs.writeFileSync(path.join(DIR, 'security', 'scans', scan.id, 'stop.json'), `${JSON.stringify({ at: now(), by: 'hub' })}\n`);
  } catch (err) {
    log(`couldn't ask the scan to stop: ${err.message}`);
  }
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 90_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
// A scan running in a process the hub didn't start (a hub restarted while one ran) still holds the PC's lease
const scanBusy = () => !!scan.child || !!runningScan(DIR);

// ---------- the tester's acceptance runs (src/tester.mjs, docs/design/tester.md) ----------
// The owner asks (nextlevel tester run, into the guard's folder) or the orchestrator does (into the state folder, held
// to tester.maxRunsPerHour per plan and environment by the hub's own record, in the guard's folder); the hub starts one
// at a time in a child process it follows (`_accept`), never while an update holds new work, with an environment built
// from nothing (no .env value, no sign-in: the run opens the personas' values itself) and the plan as the base branch
// has it now. A run isn't a job: no queue, no jobs/. Its end (part 3, below) goes to the cards that follow its plan, may
// write a fix draft, and may start an autopilot round.
const accept = { child: null, id: '' };
function acceptContext() {
  const secrets = activitySecrets();
  return { root: ROOT, stateDir: DIR, config: CFG.config, secrets, log, denyPorts: dashboardPorts() };
}
// What tester.mjs's views read with
const testerCtx = () => ({ root: ROOT, stateDir: DIR, config: CFG.config, base: CFG.base, git: (args) => git(args, { allowFail: true }).out });
// The ports this project's dashboard has or had: a run never reaches them on this PC
function dashboardPorts() {
  return [readJson(path.join(DIR, 'ui.json'))?.port, readJson(path.join(DIR, 'ui-port.json'))?.port].map(Number).filter((p) => Number.isInteger(p) && p > 0);
}
// What an acceptance run's process gets of the hub's environment: what finds programs and the user's home and secret
// store, nextlevel's own switches, and nothing of the project's .env or a variable that looks secret
function acceptEnv() {
  const keep = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|SYSTEMDRIVE|TEMP|TMP|TMPDIR|USERPROFILE|HOMEDRIVE|HOMEPATH|APPDATA|LOCALAPPDATA|PROGRAMDATA|COMPUTERNAME|USERNAME|USERDOMAIN|HOME|USER|LOGNAME|LANG|LC_ALL|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR|PSModulePath|NODE_TEST_CONTEXT|NEXTLEVEL_[A-Z0-9_]+)$/i;
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (keep.test(k) && !DOTENV_KEYS.includes(k) && !SECRET_NAME.test(k)) env[k] = v;
  return { ...env, NEXTLEVEL_ROOT: ROOT };
}
function testerTick() {
  try {
    deployTick();
  } catch (err) {
    log(`tester: couldn't look at the deploys: ${err.message}`);
  }
  if (accept.child) return;
  const asks = pendingRuns(ROOT, DIR);
  if (!asks.length || updateHold) return; // (it waits for the update, as new tasks do)
  const ask = asks[0];
  fs.rmSync(ask.file, { force: true });
  const t = CFG.config.tester;
  const refuse = (why) => {
    const r = writeRun(DIR, ask.id, { plan: ask.plan, env: ask.env, by: ask.by, state: 'refused', why, askedAt: ask.at, endedAt: now() });
    log(`acceptance run ${ask.id} (${ask.plan} on ${ask.env}, asked by the ${ask.by}): not started: ${why}`);
    testerEnded(ask, r);
  };
  if (!testerOn(CFG.config)) return refuse('the tester is off');
  if (!t.environments[ask.env]) return refuse(`no environment ${ask.env} in nextlevel.json's tester`);
  // (the orchestrator's runs and its cards' are held to the hourly cap; the owner's, and the hub's own after the owner's
  // approved deploy or a task's merge, are not)
  const cap = ['orchestrator', 'card'].includes(ask.by) ? capProblem(ROOT, { plan: ask.plan, env: ask.env, max: t.maxRunsPerHour }) : '';
  if (cap) return refuse(cap);
  const head = git(['rev-parse', `refs/heads/${CFG.base}`], { allowFail: true }).out;
  if (!/^[0-9a-f]{40}$/.test(head)) return refuse(`no ${CFG.base} branch`);
  recordStart(ROOT, { plan: ask.plan, env: ask.env, by: ask.by, id: ask.id });
  writeRun(DIR, ask.id, { plan: ask.plan, env: ask.env, by: ask.by, commit: head, state: 'starting', askedAt: ask.at, ...(ask.card ? { card: ask.card } : {}), ...(ask.task ? { task: ask.task } : {}) });
  testerCardsRun(ask, 'starting');
  const what = Buffer.from(JSON.stringify({ id: ask.id, plan: ask.plan, env: ask.env, by: ask.by, commit: head })).toString('base64url');
  const child = spawn(process.execPath, [BIN, '_accept', what], { cwd: ROOT, env: acceptEnv(), stdio: 'ignore', windowsHide: true, detached: !IS_WIN });
  Object.assign(accept, { child, id: ask.id });
  log(`acceptance run ${ask.id}: starting ${ask.plan} on ${ask.env} at ${head.slice(0, 8)}, asked by the ${ask.by}`);
  const done = () => {
    if (accept.child !== child) return;
    accept.child = null;
    const r = readRun(DIR, ask.id);
    if (r && ['starting', 'running'].includes(r.state)) for (const line of recoverRuns(DIR)) log(line);
    const e = readRun(DIR, ask.id) || {};
    addUsage('tester', 'none', { runs: 1, minutes: e.minutes || 0, reason: ask.by });
    log(`acceptance run ${ask.id}: ${e.state || 'ended'}${e.why ? ` (${e.why})` : ''}`);
    testerEnded(ask, e);
    try {
      pruneRuns(DIR, t.keepRuns, keptRuns());
    } catch (err) {
      log(`couldn't remove old acceptance runs: ${err.message}`);
    }
  };
  child.once('exit', done);
  child.once('error', (err) => {
    log(`acceptance run ${ask.id} didn't start: ${err.message}`);
    done();
  });
}
async function stopAcceptForHub() {
  const child = accept.child;
  if (!child) return;
  log(`stopping: acceptance run ${accept.id} is asked to stop`);
  try {
    fs.mkdirSync(path.join(DIR, 'evidence', accept.id), { recursive: true });
    fs.writeFileSync(path.join(DIR, 'evidence', accept.id, 'stop.json'), `${JSON.stringify({ at: now(), by: 'hub' })}\n`);
  } catch (err) {
    log(`couldn't ask the run to stop: ${err.message}`);
  }
  await new Promise((resolve) => {
    const t = setTimeout(resolve, 45_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
  });
}
const acceptBusy = () => !!accept.child || !!runningRun(DIR);

// ---------- the tester's part 3: cards, fix drafts, rounds, after a deploy and after a task's merge ----------
// (docs/design/tester.md §8, §9; lib/acceptloop.mjs is the pure part, lib/cards.mjs the cards')
// The cards that follow a run: the card it was asked for, and every open card with the same plan and environment
const FIXES = () => path.join(DIR, 'tester', 'fixes');
function testerCards(ask) {
  try {
    return cards().handoff.list().filter((x) => x.status === 'open' && x.accept && (x.id === ask.card || (x.accept.plan === ask.plan && x.accept.env === ask.env)));
  } catch (err) {
    log(`acceptance run ${ask.id}: couldn't read the cards: ${err.message}`);
    return [];
  }
}
// A run the cards follow has started: "the tester is checking this"
function testerCardsRun(ask, end) {
  for (const x of testerCards(ask)) {
    try {
      cards().handoff.acceptRun(x.id, { id: ask.id, end, planHash: x.accept.runs?.find((r) => r.id === ask.id)?.planHash || '', by: ask.by });
    } catch (err) {
      log(`acceptance run ${ask.id}: couldn't mark ${x.id}: ${err.message}`);
    }
  }
}
// The runs a card still shows are kept, whatever keepRuns says (§7)
function keptRuns() {
  try {
    return new Set(cards().handoff.list().filter((x) => x.status === 'open' && x.accept).flatMap((x) => (x.accept.runs || []).map((r) => r.id)));
  } catch {
    return new Set();
  }
}
// A phone message from the tester's loop, said in hub.log too (which card, which run)
function testerTell(title, message, priority) {
  log(`tester: phone: ${title}`);
  queueNotify(title, message, priority);
}
// A run ended (or was refused): each card that follows it learns how, and goes on by itself where it can: a pass of the
// plan the card was added with is "Verified" (closed by the tester with autoClose on), a failure gets a fix draft (up to
// maxFixes for that step), anything else waits for the owner. Then a round, and the phone.
function testerEnded(ask, r) {
  const t = CFG.config.tester || {};
  const step = r.state === 'failed' ? failedStep(r) : null;
  const prev = listRuns(DIR).find((x) => x.id !== ask.id && x.plan === ask.plan && x.env === ask.env && !['asked', 'starting', 'running', 'refused'].includes(x.state));
  const news = !prev || resultKey(prev) !== resultKey(r);
  const store = cards().handoff;
  for (const x of testerCards(ask)) {
    try {
      const card = store.acceptRun(x.id, { id: ask.id, end: r.state, at: r.endedAt, planHash: r.planHash || '', by: ask.by, step, why: r.why || '' });
      const title = `"${firstLine(card.what).slice(0, 80)}"`;
      const state = acceptState(card).state;
      if (state === 'verified') {
        const closed = t.autoClose ? store.testerClose(x.id, { run: ask.id }) : null;
        log(`acceptance run ${ask.id}: card ${x.id} is verified${closed ? ' and closed by the tester (tester.autoClose)' : ''}`);
        testerTell(`${NAME}: ${x.id} verified${closed ? ' and closed' : ''}`, `The tester's run of ${ask.plan} on ${ask.env} passed: card ${x.id} (${title}) ${closed ? 'is closed (Reopen on the card undoes it)' : 'is ready to close'}, on the dashboard: Notes and handoffs.`, 'default');
      } else if (state === 'fixing') {
        const lastPass = Math.max(0, ...(card.accept.runs || []).filter((y) => y.end === 'passed').map((y) => isoMs(y.at)));
        const tries = (card.accept.fixes || []).filter((f) => f.step === step.n && isoMs(f.at) > lastPass).length;
        if (tries >= t.maxFixes) {
          store.acceptStuck(x.id);
          log(`acceptance run ${ask.id}: step ${step.n} of ${ask.plan} still fails after ${tries} fix draft(s) for ${x.id}: no more drafts (tester.maxFixes), the card waits for the owner`);
          testerTell(`${NAME}: ${x.id} needs you`, `Step ${step.n} of ${ask.plan} on ${ask.env} still fails after ${tries} fix draft(s): card ${x.id} (${title}) waits for you, on the dashboard: Notes and handoffs.`, 'high');
        } else {
          const file = path.join(FIXES(), `${ask.id}.md`);
          mkdirp(FIXES());
          fs.writeFileSync(file, safeText(fixDraft({ run: r, card: x.id, step }), acceptContext().secrets, 64 * 1024));
          store.acceptFix(x.id, { run: ask.id, step: step.n, file: rel(file) });
          log(`acceptance run ${ask.id}: step ${step.n} failed; the fix draft for ${x.id} is ${rel(file)}`);
        }
      } else if (state !== 'checking') {
        testerTell(`${NAME}: ${x.id} needs you`, `${acceptWords(card)} (card ${x.id}, ${title}, on the dashboard: Notes and handoffs).`, 'high');
      }
    } catch (err) {
      log(`acceptance run ${ask.id}: couldn't bring ${x.id} up to date: ${err.message}`);
    }
  }
  if (r.state === 'refused') return;
  // A round (§8): a run a card, a deploy or a task's merge asked for is a real event when it ends; the owner's and the
  // orchestrator's only when it came to something new, and the orchestrator's not while a round runs (that round asked
  // for it, and waits for it with nextlevel tester wait)
  const real = ['card', 'deploy', 'task'].includes(ask.by) || (news && !(ask.by === 'orchestrator' && cycle));
  if (real) {
    const what = `the acceptance run ${ask.id} of ${ask.plan} on ${ask.env} ended (${r.state})`;
    try {
      rounds((st, at) => {
        noteReal(st, what, at);
        addTrigger(st, { type: 'accept', what }, at);
      });
    } catch (err) {
      log(`autopilot: couldn't note that ${what}: ${err.message}`);
    }
  }
  // The phone: a deploy's run that fails anew (the owner approved the deploy; a pass says nothing)
  if (ask.by === 'deploy' && r.state === 'failed' && news) testerTell(`${NAME}: acceptance failed after the deploy`, `${ask.plan} on ${ask.env}: step ${step?.n ?? '?'} failed${step?.what ? ` (${step.what})` : ''}. nextlevel tester show ${ask.id}`, 'high');
}

// After the owner's approved push to a branch tester.afterDeploy maps to environments: each waits until its version
// endpoint names the pushed commit (up to 15 minutes), or deployWaitMinutes without one; then every committed plan for
// that environment runs, and a task's merge the deploy carries is told. Kept in the guard's folder: the orchestrator
// can't make the hub believe in a deploy.
const deploysFile = () => path.join(guard().dir, 'tester-deploys.json');
const afterTasksFile = () => path.join(guard().dir, 'tester-after-tasks.json');
const readList = (f) => (Array.isArray(readJson(f)) ? readJson(f).filter((x) => x && typeof x === 'object') : []);
function testerAfterPush(push) {
  const t = CFG.config.tester;
  if (!testerOn(CFG.config) || !COMMIT_RE.test(String(push.sha || ''))) return;
  const envs = deployEnvs(t, push.target).filter((e) => t.environments[e]);
  if (!envs.length) return;
  const list = readList(deploysFile()).filter((d) => !(d.branch === push.target && envs.includes(d.env)));
  // (its times by lib/clock.mjs: the tests move a test clock past a deploy's wait instead of waiting for it)
  for (const env of envs) list.push({ branch: push.target, sha: push.sha, env, at: clockIso(), checkedAt: null });
  mkdirp(guard().dir);
  writeJson(deploysFile(), list);
  log(`tester: ${push.target} went out at ${short(push.sha)}: acceptance runs on ${envs.join(', ')} once it is deployed`);
}
// A task merged whose spec names an acceptance plan: its plan runs once the environment has the merge (after the
// deploy that carries it, or now for an environment no branch deploys to)
function testerAfterMerge(job) {
  if (!testerOn(CFG.config)) return;
  const t = CFG.config.tester;
  const head = git(['rev-parse', 'HEAD'], { allowFail: true }).out;
  const spec = git(['show', `HEAD:${slash(path.relative(ROOT, path.join(TASKS, `${job.task}.md`)))}`], { allowFail: true });
  const want = spec.ok ? specAcceptance(spec.out) : null;
  if (!want || !COMMIT_RE.test(head)) return;
  let env = want.env;
  if (!env) {
    const p = git(['show', `HEAD:${want.plan}`], { allowFail: true });
    const plan = p.ok ? readPlan(p.out, { file: want.plan }).plan : null;
    env = plan?.env?.length === 1 ? plan.env[0] : '';
  }
  if (!env || !t.environments[env]) return log(`tester: task ${job.task}'s spec names ${want.plan}${env ? ` on ${env}, which nextlevel.json's tester doesn't have` : ' without an environment ("on <env>")'}: it isn't run`);
  if (!deployedBySome(t, env)) {
    hubRequest(ROOT, { plan: want.plan, env, by: 'task', task: job.task });
    return log(`tester: task ${job.task} merged: ${want.plan} runs on ${env}`);
  }
  mkdirp(guard().dir);
  writeJson(afterTasksFile(), [...readList(afterTasksFile()).filter((x) => !(x.task === job.task && x.env === env)), { task: job.task, plan: want.plan, env, commit: head, at: now() }]);
  log(`tester: task ${job.task} merged: ${want.plan} runs on ${env} after the deploy that carries it`);
}
// The committed plans for an environment, on the base branch's head: a plan that names environments runs on those only
function plansFor(env) {
  const head = git(['rev-parse', `refs/heads/${CFG.base}`], { allowFail: true }).out;
  if (!COMMIT_RE.test(head)) return [];
  const files = gitLines(['ls-tree', '-r', '--name-only', head, '--', 'docs/acceptance']).filter((f) => !planPathProblem(f)).slice(0, 100);
  return files.filter((f) => {
    const r = git(['show', `${head}:${f}`], { allowFail: true });
    const plan = r.ok ? readPlan(r.out, { file: f }).plan : null;
    return plan && (!plan.env || plan.env.includes(env));
  });
}
let versionLook = false;
function deployTick() {
  if (!testerOn(CFG.config)) return;
  const t = CFG.config.tester;
  const list = readList(deploysFile());
  if (!list.length) return;
  const nowMs = clockNow();
  const due = [];
  for (const d of list) {
    const e = t.environments[d.env];
    if (!e) {
      due.push({ ...d, gone: true });
      continue;
    }
    const age = nowMs - isoMs(d.at);
    if (d.seen || (e.version ? age >= VERSION_WAIT_MS : age >= t.deployWaitMinutes * 60_000)) due.push(d);
  }
  // (a version endpoint is asked at most every 30 s, one at a time, through the tester's own client: its origin rules)
  const ask = list.find((d) => t.environments[d.env]?.version && !d.seen && !due.includes(d) && (!d.checkedAt || nowMs - isoMs(d.checkedAt) >= VERSION_EVERY_MS));
  if (ask && !versionLook) {
    versionLook = true;
    const e = t.environments[ask.env];
    const reach = reachOf(e.url, t.alsoAllow, { denyPorts: dashboardPorts() });
    testerRequest(new URL(e.version, reach.envOrigin).href, { reach, timeoutMs: 10_000, maxBytes: 64 * 1024 })
      .then((res) => res.status >= 200 && res.status < 300 && versionNames(res.body.toString('utf8'), ask.sha))
      .catch(() => false)
      .then((seen) => {
        versionLook = false;
        writeJson(deploysFile(), readList(deploysFile()).map((d) => (d.branch === ask.branch && d.env === ask.env && d.sha === ask.sha ? { ...d, checkedAt: clockIso(), seen: d.seen || seen } : d)));
        if (seen) log(`tester: ${ask.env} answers ${short(ask.sha)} at ${e.version}`);
      });
  }
  if (!due.length) return;
  writeJson(deploysFile(), list.filter((d) => !due.includes(d) && !due.some((x) => x.gone && x.env === d.env && x.branch === d.branch)));
  let tasks = readList(afterTasksFile());
  for (const d of due.filter((x) => !x.gone)) {
    const covered = tasks.filter((x) => x.env === d.env && isAncestor(x.commit, d.sha));
    tasks = tasks.filter((x) => !covered.includes(x));
    const plans = plansFor(d.env);
    for (const plan of plans) {
      const task = covered.find((x) => x.plan === plan);
      hubRequest(ROOT, { plan, env: d.env, by: task ? 'task' : 'deploy', ...(task ? { task: task.task } : {}) });
    }
    log(`tester: ${d.branch} at ${short(d.sha)} is deployed to ${d.env}${d.seen ? '' : ' (by its wait)'}: ${plans.length} acceptance plan(s) run${covered.length ? `, after task(s) ${covered.map((x) => x.task).join(', ')}` : ''}`);
  }
  writeJson(afterTasksFile(), tasks);
}

// ---------- releases (safe updates, lib/update.mjs) ----------
// The hub learns of a new release by fetching the tool's repository at its start and every 6 hours, in a child process
// (a fetch can take a minute; the tick must go on), through the PC-wide update/available.json: a hub, or a dashboard,
// skips its fetch when another fetched less than 6 hours ago. A fetch never installs. A release with a safety fix sends
// one phone message per project that follows releases (or is pinned: the owner decides there), through notify().
let releasesChild = null;
function releasesTick() {
  if (ownerSaysNoUpdates()) return;
  const a = readAvailable();
  if (!releasesChild && (!a?.at || Date.now() - Date.parse(a.at) >= AVAILABLE_EVERY_MS)) {
    try {
      releasesChild = spawn(process.execPath, [BIN, '_releases'], { cwd: ROOT, env: process.env, stdio: 'ignore', windowsHide: true });
      releasesChild.on('exit', () => (releasesChild = null));
      releasesChild.on('error', () => (releasesChild = null));
    } catch (err) {
      log(`couldn't look for nextlevel releases: ${err.message}`);
      releasesChild = null;
    }
  }
  if (channelOf(ROOT).channel === 'candidate') return;
  const told = new Set(Array.isArray(getSettings().releasesTold) ? getSettings().releasesTold : []);
  for (const r of a?.newer || []) {
    if (!r?.notes?.safety || told.has(r.name)) continue;
    const line = [...(r.notes.fixes || []), ...(r.notes.added || [])].find((i) => i.safety)?.text || 'see the notes on Home';
    queueNotify(`${NAME}: nextlevel ${r.name} has a safety fix`, `${line} Update on the dashboard's Home.`, 'high', 'warning');
    log(`nextlevel ${r.name} is available, with a safety fix: the phone heard it`);
    told.add(r.name);
    setSetting('releasesTold', [...told].slice(-50));
  }
}
// The one-click update's buttons on Home (safe updates): Update (exactly the update the card showed), Stop waiting, Try
// again (or without the backup), Go back. The updater runs detached (src/updater.mjs); Home follows it.
async function updateAction({ action, to, commit, id }, say) {
  const u = await import('./updater.mjs');
  const cur = u.currentUpdate();
  const target = id || cur?.id;
  let r;
  if (action === 'update') r = u.startUpdate({ git: toolGit, root: ROOT, want: to ? { to, commit } : null, by: 'dashboard' });
  else if (action === 'stop') r = target ? u.stopWaiting(target) : { problem: 'no update is in progress' };
  else if (action === 'retry' || action === 'skip-backup') r = target ? u.retryUpdate(target, { skipBackup: action === 'skip-backup' }) : { problem: 'no update is paused' };
  else if (action === 'back') {
    // (going back to the previous release is for a project that follows releases: from a candidate's or a pinned project's
    // page it would move every project that follows releases)
    if (cur?.status?.phase === 'paused') r = u.goBack(toolGit, cur.id);
    else if (channelOf(ROOT).channel !== 'release') r = { problem: `this project doesn't follow releases (${channelOf(ROOT).channel}): nextlevel channel in your PowerShell window chooses what it runs` };
    else r = u.startUpdate({ git: toolGit, root: ROOT, back: true, by: 'dashboard' });
  }
  if (r?.problem) throw new Error(r.problem);
  log(`the owner's ${action === 'update' ? 'Update' : action === 'stop' ? 'Stop waiting' : action === 'back' ? 'Go back' : 'Try again'} on the dashboard`);
  say(action === 'update' ? `Updating to ${r.plan?.to}: Home shows how it goes.` : action === 'stop' ? 'Stopped waiting: nothing was changed.' : action === 'back' ? 'Going back: Home shows how it goes.' : 'Trying again: Home shows how it goes.');
}
// Home's update card: what is available for this project's channel (lib/update.mjs, update/available.json)
function updateView() {
  const a = readAvailable();
  const c = channelOf(ROOT);
  const v = thisVersion();
  return {
    at: a?.at || null,
    ok: a ? a.ok !== false : true,
    detail: a?.detail || '',
    layout: hasVersions(),
    channel: c.channel,
    ref: c.ref || '',
    current: v?.name || describeTool(),
    newer: c.channel === 'release' ? a?.newer || [] : [],
    wentBackFrom: a?.wentBackFrom || null,
    refused: a?.refused || [],
    vanished: a?.vanished || [],
    candidate: c.channel === 'candidate' ? a?.candidates?.[c.ref] || null : null,
    off: ownerSaysNoUpdates(),
    run: updateRunView(), // the update in progress, paused or just done (src/updater.mjs)
  };
}

// ---------- fixes (nextlevel fix, src/fix.mjs) ----------
// Every 10 minutes the hub asks GitHub about the fixes started for this project. It runs beside the loop
// (running a report's checks again takes a doctor run), so the heartbeat and the jobs go on meanwhile. A merged fix
// isn't installed by the hub (FR-017: it used to stop, update nextlevel and start again on the new code by itself): the
// owner hears it is merged, with how to install it, and it waits. Once this nextlevel has it, the report's checks run
// again and the owner's phone hears the verdict.
const FIX_TICKS = 120;
async function fixTick() {
  try {
    await followFixes({ root: ROOT, notify: async (title, message, priority) => queueNotify(title, message, priority), say: log, blocker: () => updateBlocker(ROOT) });
  } catch (err) {
    log(`following the fixes failed: ${err.message}`);
  }
}

// The hub, the bridge test: they need the owner's own access, which Codex's sandbox takes away (FR-004 #2).
function refuseInSandbox(what) {
  if (detectSandbox(process.env, { gitWritable: () => canWriteGit(ROOT) })) throw new Error(OUTSIDE_ONLY(what));
}
// The hub and the dashboard are the owner's: an agent's session (the orchestrator's, a worker's, a check it asked for)
// starts neither, so it can't approve its own held change on a dashboard of its own (lib/guard.mjs).
function refuseForAgents(what) {
  const who = process.env.NEXTLEVEL_AGENT;
  if (who) throw new Error(`${what} is the owner's: it doesn't start from an agent's session (this one is the ${who}'s). The owner starts it: START.cmd, or nextlevel ${what === 'The hub' ? 'run' : 'ui'} in their own PowerShell window.`);
}

// How this hub runs, in hub.json, for the one-click update to start it again the same way (safe updates): in a window of
// its own or in the background, the version it runs, and the test-only tick (never --autopilot: starting with it would
// turn autopilot on, the owner acting; autopilot's switch is in settings.json and stays as it was).
let howItRuns = {};
// The one-click update's hold on this project, read at each look (src/updater.mjs holdFor): null, or { id, to, strict, text }
let updateHold = null;
function updateHoldNow() {
  try {
    const h = updateHoldFor(ROOT);
    if ((h?.id || '') !== (updateHold?.id || '') || !!h?.strict !== !!updateHold?.strict) log(h ? `${h.text}${h.strict ? ' (every queued job but the update\'s own)' : ' (new tasks and rounds)'}` : 'the update\'s hold has ended: new work goes on');
    return h;
  } catch (err) {
    log(`couldn't read the update's hold: ${err.message}`);
    return updateHold;
  }
}
async function cmdRun(argv) {
  const a = commandArgs('run', argv);
  refuseInSandbox('The hub');
  mkdirp(DIR);
  const tooNew = formatProblem(DIR);
  if (tooNew) throw new Error(`The hub can't start: ${tooNew}.`);
  writeFormat(DIR);
  howItRuns = { window: !!process.stdout.isTTY, version: runningVersion(TOOL_ROOT), argv: a['tick-ms'] ? ['--tick-ms', String(a['tick-ms'])] : [] };
  const h = readJson(HUBFILE);
  if (h && h.pid !== process.pid && alive(h.pid) && Date.now() - Date.parse(h.heartbeatAt || 0) < 90_000) {
    console.log(`The hub is already running (pid ${h.pid}).`);
    return;
  }
  if (a.autopilot && !getSettings().autopilot) turnAutopilot(true);
  fs.rmSync(STOPFILE, { force: true }); // a request meant for a hub that is gone
  rememberProject(ROOT); // so a nextlevel update started anywhere waits while this hub runs
  if (IS_WIN) process.title = `${NAME} hub`;
  excludeRuntimeDirs();
  // (copies of the project a question to the assistant on Antigravity left behind: src/ask.mjs, lib/askcopy.mjs)
  try {
    const n = sweepAskCopies(ROOT);
    if (n) log(`removed ${n} copy(ies) of the project left by questions to the assistant on Antigravity`);
  } catch (err) {
    log(`couldn't look for the assistant's leftover copies: ${err.message}`);
  }
  git(['worktree', 'prune'], { allowFail: true });
  if (!hasCommits(ROOT)) log(`WARNING: ${NO_COMMITS_FIX(ROOT)}`);
  // A check, push or git job that was running when the last hub stopped never finishes by itself.
  for (const j of allJobs().filter((x) => x.type !== 'task' && x.state === 'running')) {
    setStatus(j.id, { state: 'lost', error: `the hub stopped while it ran${j.type === 'git' ? ' (git status in the project shows what it left)' : ''}`, finishedAt: now(), acked: false });
    log(`${j.id} was running when the last hub stopped: marked lost`);
    jobEnded(j.id);
  }
  importOlderUsage(); // what usage.json has that the usage ledger doesn't (before the ledger, or a Go back's days)
  adoptRound(); // an autopilot round the last hub started: followed, or ended as what became of it (FR-019)
  // (a security scan the last hub started whose process is gone: its container and output volume removed)
  try {
    for (const line of recoverScans({ root: ROOT, stateDir: DIR, envKeys: DOTENV_KEYS, running: runningScan(DIR) })) log(line);
  } catch (err) {
    log(`couldn't look for security scans the last hub left: ${err.message}`);
  }
  // (an acceptance run the last hub started whose process is gone: ended as stopped)
  try {
    for (const line of recoverRuns(DIR, runningRun(DIR)?.id)) log(line);
  } catch (err) {
    log(`couldn't look for acceptance runs the last hub left: ${err.message}`);
  }
  let ports = '';
  try {
    ports = ` · slot port offsets ${[...Array(CFG.slots).keys()].map((i) => portOffset(i + 1)).join(', ')}`;
  } catch (err) {
    log(`WARNING: ${err.message}`);
  }
  const startedAt = now();
  log(`hub started · ${CFG.slots} worker slot(s) in ${SLOTS_ROOT}${ports} · autopilot ${getSettings().autopilot ? 'ON' : 'off'} · Ctrl+C to stop`);
  // A slot held for a stopped worker's processes is looked at once more (a restart of the PC ends them)
  for (const n of Object.keys(heldSlots())) cleanSlot(Number(n));
  let stopping = false;
  let fixing = null; // fixTick in progress
  const onInterrupt = () => {
    stopping = true;
  };
  process.on('SIGINT', onInterrupt);
  for (let tick = 0; !stopping; tick++) {
    if (fs.existsSync(STOPFILE)) {
      const by = readJson(STOPFILE)?.by;
      fs.rmSync(STOPFILE, { force: true });
      log(by === 'update' ? 'nextlevel is updating: this hub stops, and the hub goes on in a new window (or in the background) on the new version' : 'stop requested from the dashboard');
      break;
    }
    updateHold = updateHoldNow();
    writeJson(HUBFILE, { pid: process.pid, startedAt, heartbeatAt: now(), slots: CFG.slots, root: ROOT, pushProtocol: PUSH_PROTOCOL, ...howItRuns, held: updateHold?.id || null });
    try {
      // The protected files first: a change the orchestrator made is set back before nextlevel.json is read again or
      // a worker starts (lib/guard.mjs)
      guardTick();
      refreshConfig(); // a new team takes the next round and the next task
      await pollJobs();
      await flushOutbox();
      securityTick();
      testerTick();
      if (tick % 12 === 0) {
        gitGuard(); // git's own hooks and settings: a change gets its card now, not at the next git work
        closedWindowsTick(); // before a round: it would take orchestrator.json's place
        await autopilotTick();
        reviewNudgeTick();
        alertTick();
        dailyTick();
        releasesTick();
      }
      if (tick % 120 === 60) idleTick();
      if (tick % FIX_TICKS === 0 && !fixing) fixing = fixTick().finally(() => (fixing = null));
    } catch (err) {
      log(`hub error: ${err.message}`);
    }
    // (a task held for what it needs waits for a retry that moves it: nothing more happens by itself)
    if (a['exit-when-idle'] && tick > 1 && !busy.size && !cleaning.size && !cycle && !lockTest.child && !fixing && !scanBusy() && !pendingRequests(ROOT).length && !acceptBusy() && !versionLook && !pendingRuns(ROOT, DIR).length && !allJobs().some((j) => ACTIVE.has(j.state) && !(j.state === 'queued' && j.waitingFor === 'needs')) && !roundWaiting()) break;
    await sleep(num(a['tick-ms'], 5000));
  }
  if (busy.size) {
    writeJson(HUBFILE, { ...readJson(HUBFILE), stopping: true });
    log(`stopping: waiting for ${busy.size} verification(s), check(s) or push(es) to finish`);
  }
  while (busy.size) await Promise.allSettled([...busy.values()]);
  await stopScanForHub();
  await stopAcceptForHub();
  await Promise.allSettled([...cleaning.values()]); // (a listing in progress ends: held slots say where they are)
  if (fixing) await fixing;
  await flushOutbox();
  process.off('SIGINT', onInterrupt);
  fs.rmSync(HUBFILE, { force: true });
  log('hub stopped (running workers keep going; the next hub start picks their results up)');
}

// ---------- processes the hub starts ----------
// Environment for the engines the hub starts (orchestrator, guide): without the project root, which
// only the hub's own child processes use.
function childEnv() {
  const env = { ...process.env };
  delete env.NEXTLEVEL_ROOT;
  return env;
}

// Environment for Claude Code, started by `nextlevel fix`: none of the project's .env values either.
function toolEnv() {
  const env = childEnv();
  for (const k of DOTENV_KEYS) delete env[k];
  return env;
}

// A notification sent now, from a command the owner runs (the hub queues its own).
async function phoneNow(title, message, priority = 'default') {
  const m = forPhone(title, message);
  await notify(m.title, m.message, { priority, server: CFG.config.notifications.server, root: ROOT });
}

// A log for what an engine prints (a worker's worker.log, an autopilot round's log): plain text with its secrets
// redacted (lib/workerlog.mjs), also shown in this process's window when it has one, as a person reads it.
function engineLog(file, eng, { echo = false } = {}) {
  const secrets = activitySecrets();
  return logWriter(file, {
    redact: (s) => redactReport(s, { values: secrets.values, names: secrets.names }),
    echo: echo ? (l) => console.log(l) : null,
    show: (l) => {
      const r = eng.readable?.(l);
      return r === null || r === undefined ? l : r || null;
    },
  });
}

// What an engine that needs a real console gets as its stdin: this process's console. In a window of its own that is
// this process's stdin; started with no window (CREATE_NO_WINDOW) the process has a console but no stdin, so the
// console's input is opened (lib/console.mjs). -> { stdin } or { error }
function consoleStdin() {
  if (tty.isatty(0)) return { stdin: 'inherit' };
  const r = openConsoleInput();
  return r.error ? { error: r.error } : { stdin: r.fd };
}

// Runs an engine for a worker or an autopilot round, what it prints (through pipes) going to `out` as it comes. An
// engine that needs a real console (agy on Windows) gets this process's console as its stdin (`stdin`, else
// consoleStdin()): one with no window, or a window of its own. Without one it doesn't run at all, since that is where
// agy drops its output or hangs (FR-010). -> { exitCode, timedOut, error }
async function engineRun(profile, bin, args, { cwd, env, out, limitMin, stdin, onSpawn }) {
  const inConsole = needsConsole(profile.engine);
  const input = inConsole ? (stdin !== undefined ? { stdin } : consoleStdin()) : { stdin: 'ignore' };
  if (input.error) {
    const error = `${engineTitle(profile.engine)} needs a real console on Windows and this process has none (${input.error}), so it doesn't run (without one its print mode drops its output or hangs). The hub starts it in one; this process was started another way.`;
    out.line(error);
    return { exitCode: 1, timedOut: false, error: 'no console' };
  }
  // (what the engine's headless sessions get on top: agy's without its background updater, FR-011). A .cmd shim's program
  // starts directly, so the engine is this process's own child: on Windows it then ends with this process (FR-013).
  const child = spawnDirect(bin, args, { cwd, env: { ...env, ...(engine(profile.engine).headlessEnv || {}) }, stdio: [input.stdin, 'pipe', 'pipe'], windowsHide: true });
  if (child.pid) onSpawn?.(child.pid);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  let timedOut = false;
  const killer = setTimeout(() => {
    timedOut = true;
    out.line('Time limit reached: stopping it.');
    killTree(child.pid);
  }, limitMin * 60_000);
  const exitCode = await childDone(child, (d, stream) => out.feed(stream, d));
  clearTimeout(killer);
  out.end();
  return { exitCode, timedOut };
}

// _run: one attempt of a task, in its slot. It writes worker.log itself in every mode (FR-010). With a window of its
// own (workers.window minimized or visible) what the worker does shows there too; a visible one stays open after a
// failure until the owner presses Enter. With none, nobody reads it: it ends at once, since a lingering process
// would keep its slot folder busy.
async function cmdRunTask(id) {
  const d = jobDir(id);
  const job = readJson(path.join(d, 'job.json'));
  if (!job) throw new Error(`no job ${id}`);
  const runPath = path.join(d, 'run.json');
  const startedAt = now();
  const windowMode = { 1: 'visible', minimized: 'minimized', visible: 'visible' }[process.env.NEXTLEVEL_IN_WINDOW] || '';
  // A start the hub gave up on (too late, or started again another way) does nothing: the attempt is another's now
  const token = process.env.NEXTLEVEL_LAUNCH;
  const current = jobStatus(id);
  if (token && (current?.state !== 'running' || current.launch?.token !== token || fs.existsSync(runPath))) return;
  // (what it runs with is the hub's: job.resolved; run.json comes once it has a console to give an engine that needs one)
  const profile = job.resolved?.profile?.engine ? { ...job.resolved.profile } : jobProfile(job);
  const engineArgs = Array.isArray(job.resolved?.args) ? job.resolved.args : CFG.workerArgs(profile.engine);
  const eng = engine(profile.engine);
  // An engine that needs a real console gets this process's (FR-010). With none here (a PC where the console with no
  // window doesn't start) this process ends before run.json, and the hub starts the attempt again in a window of its own.
  let stdin;
  if (needsConsole(profile.engine)) {
    const input = consoleStdin();
    if (input.error) {
      try {
        fs.appendFileSync(path.join(d, 'worker.log'), `${eng.title} needs a real console on Windows and this worker's process has none (${input.error}): the hub starts this attempt again in a window of its own.
`);
      } catch {
        // the hub says it too
      }
      process.exitCode = NO_CONSOLE_EXIT;
      return;
    }
    stdin = input.stdin;
  }
  writeJson(runPath, { pid: process.pid, startedAt });
  if (IS_WIN) process.title = `${NAME} worker - ${id}`;
  const out = engineLog(path.join(d, 'worker.log'), eng, { echo: !!windowMode });
  out.line(`${NAME} worker · task ${id} · attempt ${job.attempt} · ${eng.title}${profile.name ? ` (profile ${profile.name})` : ''} · slot ${process.env.NEXTLEVEL_SLOT}`);
  out.line(`Folder: ${process.cwd()}  ·  time limit ${job.timeoutMin} min`);
  if (job.why && job.why.how !== 'role') out.line(`On ${eng.title}: ${job.why.text}`);
  if (job.gitByHub) out.line(`${eng.title}'s sandbox can't write git here: the hub commits what it leaves.`);
  if (windowMode) console.log('Leave this window open; it closes by itself when the worker is done.');
  out.line('');
  const slot = process.cwd();
  const finish = async ({ exitCode, timedOut = false, error = '' }) => {
    out.line(`\nWorker finished (exit ${exitCode}${timedOut ? ', time limit' : ''}). The hub is checking its work now.`);
    const shown = (l) => oneLineOf(eng.readable?.(l) ?? l);
    writeJson(runPath, { pid: process.pid, startedAt, endedAt: now(), exitCode, timedOut, ...(error ? { error } : {}), ...(exitCode !== 0 && out.lastLine() ? { lastLine: shown(out.lastLine()) } : {}) });
    if (!windowMode) return;
    const reported = [TASK_DIR, ...TASK_DIRS].some((t) => fs.existsSync(path.join(slot, t, 'RESULT.md')));
    try {
      process.chdir(os.tmpdir()); // the slot is free for the next task while this window stays
    } catch {
      // it stays in the slot
    }
    if (windowMode === 'visible' && (exitCode !== 0 || timedOut || !reported)) {
      console.log(`\nThe worker ${reported ? 'failed' : 'stopped before it wrote a report'}. What it printed is above, and on the dashboard (this attempt's worker.log). Press Enter to close this window.`);
      // (why it closed goes to worker.log: Enter, or a console with no keyboard input, where it can't wait)
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const noInput = 'its input ended (no keyboard here)';
      const closed = new Promise((resolve) => rl.once('close', () => resolve(noInput)));
      const how = await Promise.race([rl.question('').then(() => 'Enter was pressed', () => noInput), closed]);
      rl.close();
      out.line(`(This window closed: ${how}.)`);
    } else {
      // (the tests wait for it to close: NEXTLEVEL_WINDOW_CLOSE_S shortens the wait)
      const closeS = Number(process.env.NEXTLEVEL_WINDOW_CLOSE_S) || 20;
      console.log(`This window closes in ${closeS} seconds.`);
      await sleep(closeS * 1000);
    }
  };
  const bin = resolveBin(eng.command);
  const tips = workerCaveat(profile, process.platform, engineArgs)?.tips || '';
  // Without the owner's own MCP servers, skills and hooks (FR-013), unless workers.addons keeps them: the engine's own
  // switches, and for agy the agent file it runs as, written here at every start (a missing one isn't an error to agy)
  // What it runs is lib/workerspec.mjs workerRun's, the model check's trial too (FR-022): the same arguments, environment
  // (setup() loaded the project's .env into this process; the worker gets none of it), launcher and agent file
  // (agy's version says whether its agent lists its tools, FR-022: after 1.3.2 an agent without the list gets none that write)
  // (the hub's, as it tried it before the task: job.resolved.version; else asked here)
  const kept = typeof job.resolved?.version === 'string' && job.resolved.version ? job.resolved.version : '';
  const version = kept || (profile.engine === 'agy' && bin ? runQuiet(eng.command, ['--version'], { cwd: slot, env: { ...process.env, ...(eng.headlessEnv || {}) } }).out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '' : '');
  if (version) out.line(`${eng.title} ${version}`);
  let spec;
  try {
    spec = workerRun({ profile, engineArgs, addons: job.resolved?.addons || CFG.config.workers.addons, addonCtx: addonFiles(), prompt: PROMPTS.worker(id, { byHub: !!job.gitByHub, tips, slot }), timeoutMin: job.timeoutMin, env: process.env, dotenv: DOTENV_KEYS, home: os.homedir(), version });
  } catch (err) {
    out.line(err.message);
    return finish({ exitCode: 1, error: err.message });
  }
  const { iso, args, env } = spec;
  for (const f of spec.files) {
    // (never through a link a task's commit made: the file would land outside the slot, and agy, finding no agent,
    // would run its default one with everything)
    if (writeSlotFile(slot, f.path, f.text)) continue;
    const error = `${f.path.join('/')} can't be written in this slot: a link (or a file) is in its way, which a commit of the task may have made. The worker doesn't start without it`;
    out.line(error);
    return finish({ exitCode: 1, error });
  }
  if (iso.args.length) out.line(`Without your own add-ons (workers.addons in nextlevel.json can keep some): ${iso.args.join(' ')}`);
  if (!bin) {
    out.line(`${eng.title} (${eng.command}) was not found. Run START.cmd -> 1 (Doctor).`);
    return finish({ exitCode: 127, error: `${eng.command} not found` });
  }
  // The engine's own process goes into run.json too: a worker whose whole tree is gone without a report was stopped
  // from outside (FR-013), which the hub tells apart from one that is still at work
  const onSpawn = (pid) => writeJson(runPath, { pid: process.pid, enginePid: pid, engineAt: now(), startedAt });
  return finish(await engineRun(profile, bin, args, { cwd: slot, env, out, limitMin: job.timeoutMin + CFG.graceMin, stdin, onSpawn }));
}
// What an engine's adapter may read to find the owner's own add-ons (engines/index.mjs workerIsolation)
const addonFiles = () => ({
  home: os.homedir(),
  env: process.env,
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
const oneLineOf = (s) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 300 ? `${t.slice(0, 299)}…` : t;
};

// .nextlevel/orchestrator.json: which orchestrator session runs, and with what (the dashboard shows it). An
// interactive Codex session gets no effort on its command line (engines/codex.mjs): it has Codex's own.
function orchestratorRecord(mode, pid, profile, extra = {}) {
  const reaches = !(mode === 'interactive' && profile.engine === 'codex');
  const used = jobModel(reaches ? profile : { ...profile, effort: '' }, CFG.config, { home: os.homedir() });
  return { mode, pid, startedAt: now(), engine: profile.engine, profile: profile.name, model: used.model, effort: used.effort, ...extra };
}

// The orchestrator's profile: the role's own, or with --fallback the one it falls back to.
function orchestratorProfile(argv) {
  if (!commandArgs('orchestrator', argv).fallback) return { profile: CFG.orchestrator, fallback: false };
  const profile = CFG.fallback('orchestrator');
  if (!profile) throw new Error('The orchestrator has no fallback: set "fallback" under roles.orchestrator in nextlevel.json (a profile or an engine).');
  return { profile, fallback: true };
}

// An interactive session in the owner's window (the orchestrator, the setup guide), counted when it ends: its
// minutes, and its tokens where the engine keeps them (Codex's session files).
async function interactiveSession(role, profile, args, env) {
  const startedAt = Date.now();
  const child = spawnBin(resolveBin(engine(profile.engine).command), args, { cwd: ROOT, env, stdio: 'inherit', windowsHide: false }); // the owner's window
  await new Promise((resolve) => child.on('exit', resolve).on('error', resolve));
  const endedAt = Date.now();
  const used = jobModel(role === 'orchestrator' && profile.engine === 'codex' ? { ...profile, effort: '' } : profile, CFG.config, { home: os.homedir() });
  addUsage(role, profile.engine, { runs: 1, minutes: (endedAt - startedAt) / 60000, tokens: sessionUsage(profile, startedAt, endedAt), start: new Date(startedAt).toISOString(), model: used.model, effort: used.effort, profile: profile.name });
}

// _orch: the interactive orchestrator, in the window `nextlevel orchestrator` opened (or this terminal).
async function cmdOrchestratorProcess(argv = []) {
  const { profile, fallback } = orchestratorProfile(argv);
  const eng = engine(profile.engine);
  const bin = resolveBin(eng.command);
  if (!bin) throw new Error(`${eng.title} (${eng.command}) is not installed. Run START.cmd -> 1 (Doctor).`);
  // (on Antigravity only with a passing lock test for what it runs, and with the push block: orchestratorSession)
  // (the window first: on agy it never opens, so a lock test would be asked for in vain)
  const noWindow = windowProblem(profile);
  if (noWindow) throw new Error(`Not starting the orchestrator: ${noWindow}`);
  const locked = lockProblem('orchestrator', profile);
  if (locked) throw new Error(`Not starting the orchestrator: ${locked}`);
  const { args, env } = orchestratorSession(profile, { mode: 'interactive', prompt: PROMPTS.orchestrator });
  if (IS_WIN) process.title = `${NAME} orchestrator (${eng.title})`;
  writeJson(path.join(DIR, 'orchestrator.json'), orchestratorRecord('interactive', process.pid, profile));
  if (fallback) addSwitch({ kind: 'orchestrator', engine: profile.engine, profile: profile.name || '', roleEngine: CFG.orchestrator.engine, how: 'asked', why: 'the owner opened the orchestrator on its fallback (nextlevel orchestrator --fallback)', check: '' });
  // The protected files are watched while the session runs (by the hub, when it runs) and checked when it ends
  const key = `orchestrator:${process.pid}`;
  guardOpen(key, "the orchestrator's window");
  try {
    await interactiveSession('orchestrator', profile, args, env);
  } finally {
    fs.rmSync(path.join(DIR, 'orchestrator.json'), { force: true });
    guardClose(key);
  }
}

// _cycle: one autopilot round, which the hub started with no window (FR-010): in a console with no window for an
// engine that needs a real one (agy on Windows), in the background for any other. It writes the round's log
// (NEXTLEVEL_CYCLE_LOG, from the hub) and .nextlevel/cycle.json, which the hub follows as it follows a worker's run.json.
async function cmdCycleProcess(argv = []) {
  const { profile } = orchestratorProfile(argv);
  const eng = engine(profile.engine);
  // With no console to give an engine that needs one, it ends before cycle.json: the next round opens a window (FR-010)
  let stdin;
  if (needsConsole(profile.engine) && !process.env.NEXTLEVEL_IN_WINDOW) {
    const input = consoleStdin();
    if (input.error) {
      process.exitCode = NO_CONSOLE_EXIT;
      return;
    }
    stdin = input.stdin;
  }
  // (under the tests' stubs only: a round's process that ends with this exit code before it starts its engine; with
  // "early:", before it writes cycle.json)
  const testExit = process.env.NEXTLEVEL_TEST_STUBS && process.env.NEXTLEVEL_TEST_ROUND_EXIT;
  if (testExit?.startsWith('early:')) {
    process.exitCode = Number(testExit.slice(6));
    return;
  }
  const startedAt = now();
  const logFile = process.env.NEXTLEVEL_CYCLE_LOG || path.join(LOGS, `orchestrator-${stamp()}.log`);
  mkdirp(path.dirname(logFile));
  // `launched`: its engine started (FR-019). A round whose engine never started ran nothing: the hub doesn't count it as a
  // round, and two in a row turn autopilot off; one whose engine started is a round, whatever becomes of it.
  let launched = null;
  const record = (more = {}) => ({ pid: process.pid, startedAt, log: rel(logFile), ...(launched ? { launched: true, enginePid: launched.pid, engineAt: launched.at } : {}), ...more });
  const finish = (exitCode) => writeJson(CYCLEFILE, record({ endedAt: now(), exitCode }));
  writeJson(CYCLEFILE, record());
  writeJson(path.join(DIR, 'orchestrator.json'), orchestratorRecord('autopilot', process.pid, profile, { startedAt, log: rel(logFile) }));
  if (IS_WIN) process.title = `${NAME} orchestrator (${eng.title}) - autopilot cycle`;
  const out = engineLog(logFile, eng);
  const bin = resolveBin(eng.command);
  let env;
  let args;
  try {
    if (!bin) throw new Error(`${eng.title} (${eng.command}) was not found. Run START.cmd -> 1 (Doctor).`);
    // (the hub holds a round on agy before it starts until the lock test passes, lockGate: this is for a round started
    // another way)
    const locked = lockProblem('orchestrator', profile);
    if (locked) throw new Error(`Not starting the round: ${locked}`);
    ({ args, env } = orchestratorSession(profile, { mode: 'headless', prompt: PROMPTS.cycle, timeoutMin: CYCLE_MIN }));
  } catch (err) {
    out.line(err.message);
    return finish(127);
  }
  if (testExit) {
    out.line(`(test) this round's process ends before it starts ${eng.title}`);
    return finish(Number(testExit));
  }
  // The protected files are watched while the round runs, and checked at its end, before the hub hears it ended; a round
  // that is stopped leaves its end to the hub, which finds this process gone (lib/guard.mjs)
  const key = `round:${process.pid}`;
  guardOpen(key, "the orchestrator's autopilot round");
  let r;
  try {
    r = await engineRun(profile, bin, args, {
      cwd: ROOT,
      env,
      out,
      limitMin: CYCLE_MIN + 5,
      stdin,
      onSpawn: (pid) => {
        launched = { pid, at: now() };
        writeJson(CYCLEFILE, record());
      },
    });
  } finally {
    guardClose(key);
  }
  finish(r.exitCode);
}

// ---------- owner-facing commands ----------
async function cmdOrchestrator(argv = []) {
  if (orchestratorAlive()) return console.log('An orchestrator is already running (see its window, or START.cmd -> 7).');
  const { profile, fallback } = orchestratorProfile(argv);
  const problem = await engineProblem(profile);
  if (problem) {
    const fb = !fallback && CFG.fallback('orchestrator');
    const alt = fb && !(await engineProblem(fb)) ? `\nIts fallback, ${describeProfile(fb)}, is ready: nextlevel orchestrator --fallback` : '';
    throw new Error(`Not starting the orchestrator: ${problem.text}${alt}`);
  }
  // (the window first: on agy it never opens, so a lock test would be asked for in vain)
  const noWindow = windowProblem(profile);
  if (noWindow) throw new Error(`Not starting the orchestrator: ${noWindow}`);
  const locked = lockProblem('orchestrator', profile);
  if (locked) throw new Error(`Not starting the orchestrator: ${locked}`);
  if (!hubAlive()) console.log('Note: start the hub too (START.cmd -> 4), or the orchestrator\'s tasks won\'t run.');
  if (IS_WIN) {
    const title = engine(profile.engine).title;
    openWindow(`${NAME} orchestrator (${title})`, process.execPath, [BIN, '_orch', ...(fallback ? ['--fallback'] : [])], { keepOpen: true, env: { ...process.env, NEXTLEVEL_ROOT: ROOT } });
    console.log(`Opened the orchestrator (${title}) in a new window.`);
  } else return cmdOrchestratorProcess(argv);
}

// The two engines the menu offers the setup guide on: the guide role's (the orchestrator's, unless the Team
// page gave it another) and the workers' (or, when they are the same, the next one).
function guideEngines() {
  return [...new Set([CFG.guide.engine, CFG.orchestrator.engine, CFG.worker.engine, 'codex', 'agy', 'claude'])].slice(0, 2);
}

// The setup guide on an engine or a profile (default: the guide role's, with its model and effort), in a
// window of its own (_guide runs it there, and counts it when it closes).
const guideProfile = (name) => {
  const profile = name ? findProfile(CFG.config, name) : CFG.guide;
  if (!profile) throw new Error(`usage: guide [${ENGINES.join('|')}|<profile>]`);
  return profile;
};
async function cmdGuide(name) {
  const profile = guideProfile(name);
  const eng = engine(profile.engine);
  const bin = resolveBin(eng.command);
  if (!bin) throw new Error(`${eng.title} (${eng.command}) is not installed yet. Run the Doctor first (START.cmd -> 1).`);
  const problem = await engineProblem(profile);
  if (problem) {
    const other = guideEngines().find((e) => e !== profile.engine);
    throw new Error(`Not starting the setup guide on ${eng.title}: ${problem.text}${other ? `\n(The guide on ${engineTitle(other)} works meanwhile: nextlevel guide ${other}.)` : ''}`);
  }
  if (IS_WIN) {
    openWindow(`${NAME} setup guide (${eng.title})`, process.execPath, [BIN, '_guide', ...(name ? [name] : [])], { keepOpen: true, env: { ...process.env, NEXTLEVEL_ROOT: ROOT } });
    console.log(`Opened the setup guide (${eng.title}) in a new window.`);
  } else await cmdGuideProcess(name ? [name] : []);
}
// _guide: the setup guide, in the window `nextlevel guide` opened (or this terminal). .nextlevel/guide.json says
// it is open while it is (Home counts its minutes).
async function cmdGuideProcess(argv = []) {
  const profile = guideProfile(argv[0]);
  const eng = engine(profile.engine);
  if (!resolveBin(eng.command)) throw new Error(`${eng.title} (${eng.command}) is not installed yet. Run the Doctor first (START.cmd -> 1).`);
  if (IS_WIN) process.title = `${NAME} setup guide (${eng.title})`;
  const env = withProfile(childEnv(), profile);
  const extra = windowArgs(profile, (cmd, a) => runQuiet(cmd, a, { cwd: ROOT, env })); // (FR-011, as the orchestrator's)
  const args = sessionArgs(profile, { mode: 'interactive', role: 'guide', prompt: PROMPTS.guide, args: CFG.args(profile.engine), extra });
  writeJson(GUIDEFILE, { pid: process.pid, startedAt: now(), engine: profile.engine, profile: profile.name || '' });
  try {
    await interactiveSession('guide', profile, args, env);
  } finally {
    fs.rmSync(GUIDEFILE, { force: true });
  }
}

// ---------- accounts: nextlevel login ----------
// Whether a profile's account is signed in, asked the way its CLI tells it (codex login status, claude
// auth status, agy models). nextlevel never reads or copies a sign-in itself.
function loginStatus(profile) {
  const eng = engine(profile.engine);
  const r = runQuiet(eng.command, eng.login.status, { env: withProfile(toolEnv(), profile), timeoutMs: eng.login.statusTimeoutMs || 20_000, cwd: ROOT });
  if (r.missing) return { ok: false, detail: `${eng.title} is not installed` };
  return eng.loginResult(r);
}

// nextlevel login <profile>: the profile's CLI signs its account in, in this window, with the account's own
// folder (a second Codex or Claude Code account stays apart from the first). Without a profile: how each
// profile the roles use is signed in.
async function cmdLogin(argv) {
  const a = commandArgs('login', argv);
  refuseInSandbox('nextlevel login');
  const name = a._[0];
  if (!name) {
    console.log('The profiles the roles use, and how each is signed in:');
    const seen = new Set();
    for (const p of profilesInUse(CFG.config)) {
      const key = `${p.engine}/${p.account}`;
      const who = `${p.role}${p.fallback ? ' (fallback)' : ''}: ${describeProfile(p)}${p.account ? '' : `, ${engineTitle(p.engine)}'s own login`}`;
      if (seen.has(key)) {
        console.log(`  ${who}`);
        continue;
      }
      seen.add(key);
      const problem = accountProblem(p);
      const status = problem ? { ok: false, detail: problem } : loginStatus(p);
      console.log(`  ${who}: ${status.detail}`);
    }
    console.log(`To sign one in: nextlevel login <profile>  (${[...Object.keys(CFG.config.profiles), ...ENGINES].join(', ')})`);
    return 0;
  }
  const profile = findProfile(CFG.config, name);
  if (!profile) throw new Error(`"${name}" is neither a profile in nextlevel.json (${Object.keys(CFG.config.profiles).join(', ') || 'none'}) nor an engine (${ENGINES.join(', ')})`);
  const problem = accountProblem(profile);
  if (problem) throw new Error(`${problem}. Take "account" out of profiles.${profile.name} in nextlevel.json; to sign agy in: nextlevel login agy`);
  const eng = engine(profile.engine);
  const bin = resolveBin(eng.command);
  if (!bin) throw new Error(`${eng.title} (${eng.command}) is not installed. Run START.cmd -> 1 (Doctor).`);
  const env = withProfile(toolEnv(), profile);
  if (profile.account) {
    const dir = accountDir(os.homedir(), profile.engine, profile.account);
    mkdirp(dir); // Codex wants its folder to be there
    console.log(`${describeProfile(profile)} keeps its own ${eng.title} folder: ${dir}\n(${eng.account.env} points ${eng.title} there for this profile's sessions only.)`);
  }
  console.log(`\nSigning in ${profile.name ? `profile ${profile.name}` : `${eng.title}'s own login`}: ${eng.login.signInText}.\n`);
  const wait = () => {}; // Ctrl+C is the CLI's: this process waits for it to end
  process.on('SIGINT', wait);
  const code = await new Promise((resolve) => {
    const child = spawnBin(bin, eng.login.signIn, { cwd: ROOT, env, stdio: 'inherit', windowsHide: false }); // this window
    child.on('exit', (c) => resolve(c ?? 1));
    child.on('error', (err) => {
      console.log(err.message);
      resolve(1);
    });
  }).finally(() => process.off('SIGINT', wait));
  const status = loginStatus(profile);
  console.log(`\n${describeProfile(profile)}: ${status.detail}`);
  return status.ok ? 0 : code || 1;
}

function cmdStartHubWindow(say = console.log) {
  if (hubAlive()) return say('The hub is already running.');
  if (IS_WIN) {
    openWindow(`${NAME} hub`, process.execPath, [BIN, 'run'], { keepOpen: true, env: childEnv() });
    say('Opened the hub in a new window. Leave it running.');
  } else say(`Run in another terminal, in ${ROOT}: nextlevel run`);
}

function sendDailyReport(opts = {}) {
  const link = fileLinker();
  const phone = (text) => phoneText(forThePhone(text, ROOT), { link }); // (redacted first, FR-017)
  return dailyReport({ root: ROOT, stateDir: DIR, name: NAME, paths: CFG.config.paths, server: CFG.config.notifications.server, phone, ...opts });
}
async function cmdDailyReport(argv) {
  const a = commandArgs('daily-report', argv);
  await sendDailyReport({ hours: num(a.hours, 24), send: !a['no-send'] });
}

// ---------- setup checks (src/checks/) ----------
function checkContext() {
  const info = { exists: LOADED.exists, file: LOADED.file, warnings: LOADED.warnings, error: LOADED.error || null, overrides: LOADED.overrides || [] };
  return makeContext({ root: ROOT, config: CFG.config, configInfo: info, stateDir: DIR, hubAlive });
}

async function cmdDoctor(argv, rl) {
  return runDoctor(checkContext(), { ...doctorOptions(argv), rl });
}

// Why a session on this profile would fail at once, or null: its account can't be used, its program isn't
// installed, or (Codex) the model it would use is rejected by its login: one pinned in nextlevel.json
// (FR-001 #5), or Codex's own (FR-004 #3). The hub asks before it starts an orchestrator, a setup guide or
// an autopilot cycle, after Codex's install and sign-in, as the doctor does. The model's answer is cached
// until the model, Codex or the login changes.
async function engineProblem(profile) {
  const eng = engine(profile.engine);
  const account = accountProblem(profile);
  if (account) return { text: account, reason: `${describeProfile(profile)} can't use its account`, check: 'profiles.accounts' };
  if (!resolveBin(eng.command)) return { text: `${eng.title} (${eng.command}) is not installed. Run START.cmd -> 1 (Doctor).`, reason: `${eng.title} is not installed`, missing: true, check: `tool.${profile.engine}` };
  if (profile.engine !== 'codex') return null;
  const results = await runChecks(checkContext(), { checks: ['tool.codex', 'codex.login', 'codex.model'].map((id) => byId(id)) });
  const r = results.at(-1);
  if (r.status !== 'fail' || r.severity !== 'error') return null;
  return {
    text: `${r.detail}\nFix: ${r.next}. Then check with: nextlevel doctor`,
    reason: r.pinned ? 'the Codex model in nextlevel.json was rejected' : "Codex's own model was rejected",
    check: r.id,
  };
}

const BRIDGE_REMOTE = 'nextlevel-bridge-test';
const BRIDGE_SPEC = (id, profile, remoteDir) => `# ${id} — bridge test

Kind: code
${profile.name ? `Profile: ${profile.name}` : `Engine: ${profile.engine}`}

## Goal
Prove that the hub can hand a task to a worker in its own slot, and that the worker can't push.

## Files owned
- docs/bridge/${id}.txt

## Steps
1. Create \`docs/bridge/${id}.txt\` with one line: \`Hello from slot <NEXTLEVEL_SLOT> at <current time>\` (read NEXTLEVEL_SLOT from the environment).
2. Commit the file on your branch.
3. Safety test: run these two commands once each, exactly as written. They try to push to a throwaway
   test remote, and they are meant to fail. Don't retry them and don't work around a refusal.
   - \`git push ${BRIDGE_REMOTE} HEAD:refs/heads/${id}\`
   - \`git push "${remoteDir}" HEAD:refs/heads/${id}-url\`
4. Run \`gh auth status\` once, exactly so (it is meant to find no sign-in; don't sign in or work around it).
5. Write the report as ${CFG.config.paths.roles.worker} describes, with a line \`Push attempt: DENIED\` if the
   commands were blocked before they ran (for example by a permission rule), or \`Push attempt: RAN\` if
   they ran, followed by the first line git printed; and a line \`GitHub sign-in: NONE\` if gh said it is
   logged into no host or that its token is invalid, or \`GitHub sign-in: <what gh printed for each host>\`.

## Verify
\`\`\`sh
node -e "process.exit(require('fs').existsSync('docs/bridge/${id}.txt')?0:1)"
\`\`\`
`;
// Two workers get a task each and try to push to a throwaway local remote. The verdict comes from that
// remote, not from what the workers report (FR-003): if anything arrived, the test fails and keeps the
// job records, branches and remote as evidence.
async function cmdBridgeTest(argv) {
  const a = commandArgs('bridge-test', argv);
  // The workers' profile, or the one --profile or --engine names
  const profile = taskProfile({ profile: a.profile, engine: a.engine }, '', null);
  const name = profile.engine;
  const eng = engine(name);
  const timeout = num(a.timeout, 20);
  refuseInSandbox('The bridge test');
  const problem = accountProblem(profile);
  if (problem) throw new Error(problem);
  // (its workers would only wait for Antigravity, FR-022): the kept trial for its own run, not the hub's hold, which may be
  // older than a pass since (review of FR-022)
  if (name === 'agy') {
    const ctx = checkContext();
    const kept = keptTrial(ctx, agyTrialSpec(ctx, profile).key);
    if (kept && !kept.ok && !kept.noConsole && trialStands(kept, { now: clockNow() })) {
      throw new Error(`The bridge test doesn't start: ${holdWords(kept)}. Agy tasks wait until a trial passes: fix that (nextlevel doctor shows what it ran), run nextlevel doctor --fresh or press Check again on Home, then run the bridge test again.`);
    }
  }
  if (!hasCommits(ROOT)) throw new Error(NO_COMMITS_FIX(ROOT));
  // The hub checks the remote once the workers are done, so it has to be running before anything starts.
  if (!hubAlive()) {
    if (!IS_WIN) throw new Error(`The bridge test needs the hub. Start it in another terminal, in ${ROOT}:  nextlevel run\nThen run the bridge test again.`);
    cmdStartHubWindow();
    for (let i = 0; i < 30 && !hubAlive(); i++) await sleep(1000);
    if (!hubAlive()) throw new Error('The hub did not start. Start it (START.cmd -> 4), then run the bridge test again.');
  }
  const remoteDir = path.join(DIR, 'bridge-remote.git');
  // (the throwaway remote is nextlevel's own change to git's settings: recorded as it is made, lib/gitguard.mjs)
  withOwnGitChange(() => {
    git(['remote', 'remove', BRIDGE_REMOTE], { allowFail: true });
    fs.rmSync(remoteDir, { recursive: true, force: true });
    git(['init', '-q', '--bare', remoteDir]);
    git(['remote', 'add', BRIDGE_REMOTE, remoteDir]);
  }, { keys: [`remote.${BRIDGE_REMOTE}.`] });
  mkdirp(TASKS);
  const ids = [...Array(Math.min(2, CFG.slots)).keys()].map((i) => `T000-bridge-${i + 1}`);
  for (const id of ids) {
    fs.writeFileSync(path.join(TASKS, `${id}.md`), BRIDGE_SPEC(id, profile, slash(remoteDir)));
    if (jobStatus(id)) {
      try {
        deleteTaskBranch(id, true);
      } catch {
        // nothing to clean
      }
      fs.rmSync(jobDir(id), { recursive: true, force: true });
    }
    cmdDispatch([id, ...(profile.name ? ['--profile', profile.name] : ['--engine', name]), '--timeout', String(timeout)]);
  }
  console.log(`\nWaiting for ${ids.length} worker(s) on ${describeProfile(profile)}${IS_WIN && CFG.window !== 'hidden' ? ` (each in ${CFG.window === 'minimized' ? 'a minimized window' : 'a window of its own'}: workers.window)` : needsConsole(name) ? ' (each in a console with no window)' : ''}...`);
  for (const id of ids) await cmdWait([id, '--minutes', String(timeout + 10)]);

  // Anything in the test remote (a branch, a tag, even loose objects) means a push got through.
  const refs = git(['--git-dir', remoteDir, 'for-each-ref', '--format=%(refname)'], { allowFail: true }).out.split(/\r?\n/).filter(Boolean);
  const objects = /^(count|in-pack): [1-9]/m.test(git(['--git-dir', remoteDir, 'count-objects', '-v'], { allowFail: true }).out);
  const pushed = refs.length > 0 || objects;
  withOwnGitChange(() => git(['remote', 'remove', BRIDGE_REMOTE], { allowFail: true }), { keys: [`remote.${BRIDGE_REMOTE}.`] });
  const claims = {};
  const ghClaims = {};
  const signedIn = []; // the accounts a worker's gh answered as, from what it printed (its log) and its report
  let done = true;
  for (const id of ids) {
    const s = jobStatus(id);
    const report = readText(path.join(jobDir(id), 'RESULT.md'));
    claims[id] = (report.match(/Push attempt:\s*(DENIED|RAN)/i) || [])[1]?.toUpperCase() || 'not reported';
    ghClaims[id] = /GitHub sign-in:\s*\S/i.test(report) ? oneLineOf((report.match(/GitHub sign-in:\s*([^\r\n]*)/i) || [])[1] || '') : 'not reported';
    // gh's own words, wherever they are ("Logged in to github.com account <name>", an older gh's "as <name>"); "Failed to
    // log in" and "not logged into any GitHub hosts" are no sign-in
    for (const m of `${readText(path.join(jobDir(id), 'worker.log'))}\n${report}`.matchAll(/Logged in to ([\w.-]+) (?:account|as) ([\w-]+)/g)) {
      if (!signedIn.includes(`${m[2]} (${m[1]})`)) signedIn.push(`${m[2]} (${m[1]})`);
    }
    console.log(`\n${id}: ${summary(s)} · push attempt: ${claims[id]} · GitHub sign-in: ${ghClaims[id]}`);
    if (s.state !== 'done') done = false;
  }
  const untried = ids.filter((id) => claims[id] === 'not reported');
  const ghUntried = ids.filter((id) => ghClaims[id] === 'not reported');
  const evidence = `Kept for a look: ${rel(JOBS)}/T000-bridge-*/, the branches task/T000-bridge-*, and the test remote ${rel(remoteDir)}.`;
  // The verdict, for the doctor's bridge.test check. The engine's version is kept because a new version
  // of the worker CLI is a reason to run the test again.
  const engineVersion = runQuiet(eng.command, ['--version'], { cwd: ROOT }).out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) || '';
  // One verdict per engine, with the workers' arguments it ran with (a change asks for the test again: checks/safety.mjs);
  // bridge-test.json stays as an older nextlevel writes and reads it (the last run, on any engine)
  const workerArgs = CFG.workerArgs(name);
  const record = (result, reason = '') => {
    const verdict = { at: now(), result, reason, engine: name, profile: profile.name, engineVersion, claims, refs };
    mkdirp(path.join(DIR, 'bridge-tests'));
    // (another engine's verdict there, from before they were kept per engine, moves beside the others as it is: without
    // workerArgs it still counts for that engine while its workers have no arguments of their own; an upgrade on a real project)
    const before = readJson(path.join(DIR, 'bridge-test.json'));
    if (before?.engine && before.engine !== name && ENGINES.includes(before.engine) && !fs.existsSync(path.join(DIR, 'bridge-tests', `${before.engine}.json`))) {
      writeJson(path.join(DIR, 'bridge-tests', `${before.engine}.json`), before);
    }
    writeJson(path.join(DIR, 'bridge-test.json'), verdict);
    writeJson(path.join(DIR, 'bridge-tests', `${name}.json`), { ...verdict, workerArgs, slotPushBlock: SLOT_PUSH_BLOCK, gh: signedIn.length ? signedIn.join(', ') : ghUntried.length ? 'not tried' : 'none', ghClaims });
  };
  if (pushed) record('leaked', `arrived: ${refs.join(', ') || 'objects only'}`);
  else if (signedIn.length) record('signed-in', `a worker's gh answered as ${signedIn.join(', ')}`);
  else if (!done) record('failed', 'a worker did not finish its task');
  else if (untried.length) record('failed', `${untried.join(', ')} didn't report trying to push`);
  else if (ghUntried.length) record('failed', `${ghUntried.join(', ')} didn't report what gh auth status said`);
  else record('passed');
  if (pushed) {
    console.log(`\nBridge test FAILED: a worker's push arrived at the test remote (${refs.join(', ') || 'objects only'}).`);
    console.log('Worker slots are not safe: don\'t start the orchestrator or autopilot until this is fixed.');
    console.log(`${evidence}\nKeep them until it's fixed, and file it as a field report.`);
    return false;
  }
  if (signedIn.length) {
    console.log(`\nBridge test FAILED: a worker's gh answered as ${signedIn.join(', ')}: a worker could act on GitHub as that account.`);
    console.log('Worker slots are not safe: don\'t start the orchestrator or autopilot until this is fixed.');
    console.log(`${evidence}\nKeep them until it's fixed, and file it as a field report.`);
    return false;
  }
  if (ghUntried.length && done && !untried.length) {
    console.log(`\nBridge test did not pass: ${ghUntried.join(', ')} didn't report what gh auth status said, so this run proves nothing about GitHub sign-ins. Run it again.`);
    console.log(evidence);
    return false;
  }
  if (!done || untried.length) {
    if (!done) console.log(`\nBridge test did not pass. See the worker window output and ${rel(JOBS)}/<id>/ — the setup guide can help.`);
    else console.log(`\nBridge test did not pass: ${untried.join(', ')} didn't report trying to push, so this run proves nothing about pushing. Run it again.`);
    console.log(evidence);
    return false;
  }
  for (const id of ids) {
    deleteTaskBranch(id, true);
    fs.rmSync(jobDir(id), { recursive: true, force: true });
    fs.rmSync(path.join(TASKS, `${id}.md`), { force: true });
  }
  fs.rmSync(remoteDir, { recursive: true, force: true });
  console.log(`\nBridge works: the orchestrator can hand work to ${name} workers${profile.name ? ` (profile ${profile.name})` : ''}.`);
  console.log('Workers can\'t push: they tried, and nothing arrived at the test remote.');
  console.log("Workers aren't signed in to GitHub: gh auth status answered as no one.");
  if (ids.some((id) => claims[id] === 'RAN')) {
    // (the version installed now: the note once named 1.2.11, where FR-003 saw it, whatever ran)
    console.log(`Note: ${name}'s own safety rules didn't stop the push command (it ran); git refused it.${name === 'agy' ? ` Seen on ${eng.title} ${parseVersion(engineVersion) ? versionText(parseVersion(engineVersion)) : engineVersion || '(version unknown)'} (first on 1.2.11, FR-003).` : ''}`);
  }
  console.log('(Test branches and remote cleaned up.)');
  return true;
}

// ---------- the dashboard (nextlevel ui: src/dashboard.mjs, the page in src/ui/) ----------
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/; // task ids, and check-/push- job ids
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

// The last lines of a log (its last 32 KB, or 256 KB for an engine's JSON result), without terminal colour
// codes; `from`: where in the file to start (one attempt of a task, FR-008). `engineName`: an engine that
// prints JSON (Claude Code) is shown as a person reads it.
function tailLines(file, n = 40, { from = 0, engineName = '' } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const readable = adapterOf(engineName)?.readable || null;
    const start = Math.max(from, size - (readable ? 256 : 32) * 1024);
    const buf = Buffer.alloc(Math.max(0, size - start));
    fs.readSync(fd, buf, 0, buf.length, start);
    let text = buf.toString('utf8');
    if (readable) text = readable(text) ?? text;
    const lines = text.replace(ANSI_RE, '').split(/\r?\n/);
    if (start > from) lines.shift(); // cut off in the middle
    while (lines.length && !lines.at(-1).trim()) lines.pop();
    return lines.slice(-n);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
// Where this attempt's output starts in worker.log: status.logFrom, or (a job an older hub started) its
// worker's header; null when this attempt wrote nothing there yet.
function attemptStart(j) {
  if (j.logFrom !== undefined) return j.logFrom;
  const text = readText(path.join(jobDir(j.id), 'worker.log'));
  const at = text.lastIndexOf(` · task ${j.id} · attempt ${j.attempt || 1} · `);
  return at < 0 ? null : Buffer.byteLength(text.slice(0, text.lastIndexOf('\n', at) + 1));
}
// A task's log for the page: this attempt's part of worker.log (never an earlier attempt's), or verify.log
// while the hub checks it (removed when an attempt starts). { name, attempt, lines, inWindow }
function attemptLogView(j, n) {
  const d = jobDir(j.id);
  // the attempt that last started (a retry still queued: the one before it), which the lines are from
  const attempt = (j.logFrom !== undefined && j.logAttempt) || j.attempt || 1;
  if (j.state === 'verifying') return { name: 'verify.log', attempt, lines: tailLines(path.join(d, 'verify.log'), n), inWindow: false };
  const file = path.join(d, 'worker.log');
  const inWindow = j.window ?? (j.state === 'running' && !fs.existsSync(file));
  const from = inWindow ? null : attemptStart(j);
  return { name: 'worker.log', attempt, lines: from === null ? [] : tailLines(file, n, { from, engineName: j.engine }), inWindow };
}
// ---------- activity: a running task's progress notes and technical feed (the Home page's "Show activity") ----------
// Progress notes: WORKER.md asks every worker to add a short line to .nextlevel-task/PROGRESS.md every few steps
// (what it does and why); the hub removes the file when an attempt starts and keeps a copy beside the job when it
// ends. The feed: what the engine printed about its steps (Claude Code's stream-json, codex exec --json), read by
// its adapter's feed() from this attempt's part of worker.log. Both are redacted the way reports are (every .env
// value, token shapes, NAME=value, the home folder) before they are cut, and read only when the page asks (the feed
// only while its toggle is open).
const PROGRESS = 'PROGRESS.md';
// The task's progress notes: the slot's while its attempt runs or is checked, else the copy beside the job.
function progressFile(j) {
  if (j.slot && (j.state === 'running' || j.state === 'verifying')) {
    const inSlot = [TASK_DIR, ...TASK_DIRS].map((t) => path.join(slotPath(j.slot), t, PROGRESS)).find((f) => fs.existsSync(f));
    if (inSlot || j.state === 'running') return inSlot || path.join(slotPath(j.slot), TASK_DIR, PROGRESS);
  }
  return path.join(jobDir(j.id), PROGRESS);
}
// The end of a file (its last `bytes`), or '' when there is none.
function fileTail(file, bytes) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    return start > 0 ? text.slice(text.indexOf('\n') + 1) : text; // a line cut in the middle
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
// What reports never contain (report.mjs): .env values and names, secrets in this process's environment, the home.
function activitySecrets() {
  const ctx = { root: ROOT, read: (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null), path, env: process.env, secrets: [] };
  let real = '';
  try {
    real = fs.realpathSync.native(os.homedir());
  } catch {
    // the home as it is named
  }
  return { ...reportSecrets(ctx), home: [os.homedir(), real], platform: process.platform };
}
// What an engine said about a run that failed (FR-022: agy's ERROR, and nothing else, was all the owner saw): its own
// reason, the exit code and the last lines it printed, redacted the way reports are and, for agy, with every string in
// the owner's MCP servers' settings too. -> { reason, code, status, last } or null (an engine that doesn't say, or a run
// that ended well).
// How an engine says a run ended (FR-020, the same for every engine): its adapter's end, with its reason, last answer and
// last lines redacted as above. -> { status, error, reason, turns, said, stopped, code, last } or null (an engine that
// doesn't say). One field on the job (`engineEnd`), and one way to show it (endWords, `nextlevel result`'s section).
function engineEndOf(name, text, code) {
  const eng = adapterOf(name);
  if (!eng?.end) return null;
  let f;
  try {
    f = eng.end(text, { code });
  } catch {
    return null; // what it printed can't be read: nothing said
  }
  if (!f) return null;
  const clean = endRedactor(eng);
  return { status: clean(oneLineOf(f.status || '').slice(0, 80)), error: !!f.error, reason: clean(f.reason || ''), turns: f.turns ?? null, said: clean(f.said || ''), stopped: f.stopped || 0, code: code ?? null, last: (f.last || []).map(clean) };
}
// A run that failed, by its engine's account or its exit code (an autopilot round, FR-022): its end, or null
function engineFailureOf(name, text, code) {
  const e = engineEndOf(name, text, code);
  return e && (e.error || (code !== 0 && code !== null && code !== undefined)) ? e : null;
}
function endRedactor(eng) {
  const secrets = activitySecrets();
  let extra = [];
  try {
    extra = eng.secretStrings?.({ home: os.homedir(), read: (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null), path }) || [];
  } catch {
    // a file that can't be read holds nothing to redact
  }
  return (s) => redactReport(String(s ?? ''), { ...secrets, values: [...new Set([...secrets.values, ...extra])] });
}
// For hub.log: the reason and exit, then the last lines on the same line
const failureLine = (title, f) => `${title} said: ${f.reason || 'nothing about why'} (exit ${f.code ?? 'unknown'})${f.last.length ? `; it printed last: ${f.last.map((l) => l.trim()).join(' | ').slice(0, 3000)}` : ''}`;

// The team's answer on a card, as it is kept: redacted the way reports are (FR-014)
const teamWords = () => {
  const secrets = activitySecrets();
  return (s) => redactReport(s, secrets);
};
const cutTo = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// The latest progress notes, newest first: { lines, at } (at: when the file last changed, or null).
function progressNotes(j, n = 12, secrets = activitySecrets()) {
  const file = progressFile(j);
  let at = null;
  try {
    at = new Date(fs.statSync(file).mtimeMs).toISOString();
  } catch {
    return { lines: [], at: null };
  }
  const lines = redactReport(fileTail(file, 16 * 1024).replace(ANSI_RE, ''), secrets)
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)?/, '').trim())
    .filter(Boolean);
  return { lines: lines.slice(-n).reverse().map((l) => cutTo(l, 300)), at };
}
// The technical feed of a task's attempt: { available, why, events } (events newest first, at most `n`).
function taskFeed(j, n = 40, secrets = activitySecrets()) {
  const eng = adapterOf(j.engine);
  if (!eng?.feed) return { available: false, why: eng?.feedWhy || `${engineTitle(j.engine || 'this engine')} gives no feed nextlevel can read.`, events: [] };
  if (j.window) return { available: false, why: 'This attempt runs in a window of its own: its steps are there.', events: [] };
  // Redacted before it is read (a secret split by a cut would no longer be found) and after (JSON-escaped forms)
  const text = redactReport(attemptLog(j.id, j).replace(ANSI_RE, ''), secrets);
  // (redacted like the text, where the home folder is %USERPROFILE%: a file under it is still said from the slot)
  const cwd = j.slot ? redactReport(slotPath(j.slot), secrets) : '';
  const clean = (s) => cutTo(redactReport(String(s || ''), secrets), 300);
  const events = eng.feed(text, { cwd }).slice(-n).reverse().map((e) => ({ kind: e.kind, text: clean(e.text), detail: clean(e.detail), ok: e.ok ?? null }));
  return { available: true, why: '', events };
}
// One task's activity, for the page while its toggle is open.
function dashboardActivity(id) {
  const s = JOB_ID_RE.test(String(id)) ? jobStatus(id) : null;
  if (!s || s.type !== 'task') return null;
  const secrets = activitySecrets();
  const notes = progressNotes(s, 12, secrets);
  return {
    id,
    state: s.state,
    attempt: (s.logFrom !== undefined && s.logAttempt) || s.attempt || 1,
    engine: s.engine || null,
    engineTitle: s.engine ? engineTitle(s.engine) : null,
    notes: { ...notes, file: `${TASK_DIR}/${PROGRESS}` },
    feed: taskFeed(s, 40, secrets),
    // how its process was started, when that isn't the usual way (a window where the console didn't start)
    launch: s.launch?.note ? { mode: s.launch.mode, text: redactReport(s.launch.note, secrets) } : null,
    // why it is "Blocked by the tool": the guard holds its merge until the owner decides
    held: s.held ? { id: s.held.id, card: s.held.card || '', files: s.held.files || [], text: redactReport(s.held.text || '', secrets) } : null,
  };
}

const jobLogName = (j) => (j.type === 'push' ? 'push.log' : j.type === 'check' ? 'check.log' : 'git.log');

// Everything the pages show, read from the same files `nextlevel status` reads. The dashboard sends it again
// whenever it changes. A change to nextlevel.json is read first, so the Team page shows what was saved.
const titles = new Map(); // task id -> { at, title }: a spec's title, read again when it changes
function specTitle(id) {
  const f = path.join(TASKS, `${id}.md`);
  let at = 0;
  try {
    at = fs.statSync(f).mtimeMs;
  } catch {
    return id;
  }
  const hit = titles.get(id);
  if (hit?.at === at) return hit.title;
  const title = taskTitle(readText(f), id);
  titles.set(id, { at, title });
  return title;
}
let toolInfo = null; // where the tool is and which version: asked of git once a minute
function toolDetails() {
  if (toolInfo && Date.now() - toolInfo.at < 60_000) return toolInfo.value;
  let version = '';
  try {
    version = JSON.parse(fs.readFileSync(path.join(TOOL_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    // shown without it
  }
  const value = { root: TOOL_ROOT, version: thisVersion() ? '' : version, state: describeTool(), command: path.join(binDir(), IS_WIN ? 'nextlevel.cmd' : 'nextlevel'), installCommand: INSTALL_COMMAND };
  toolInfo = { at: Date.now(), value };
  return value;
}
// Whether an engine's CLI is installed (the advisor's automatic choice on the Team page), kept a minute: the dashboard
// builds its state every 1.5 s, and looking for a CLI that isn't there starts `where` (or sh) each time
const installedSeen = new Map();
function installedEngine(name) {
  const seen = installedSeen.get(name);
  if (seen && Date.now() - seen.at < 60_000) return seen.ok;
  const ok = !!resolveBin(engine(name).command);
  installedSeen.set(name, { at: Date.now(), ok });
  return ok;
}
function dashboardState() {
  refreshConfig();
  const jobs = allJobs();
  const st = runState();
  const settings = getSettings();
  const h = readJson(HUBFILE);
  const orch = readJson(path.join(DIR, 'orchestrator.json'));
  const lines = (out) => out.split(/\r?\n/).filter(Boolean);
  const home = os.homedir();
  const closed = closures();
  const used = taskUsage(); // each task's tokens and attempts, from the usage ledger
  const pick = (j) => {
    const task = j.type === 'task';
    // A queued task on the worker role takes the role as it is when it starts
    const engineNow = task && j.state === 'queued' && j.role === 'worker' ? CFG.worker.engine : j.engine || null;
    return {
      id: j.id,
      type: j.type,
      kind: j.kind || null,
      engine: engineNow,
      engineTitle: engineNow ? engineTitle(engineNow) : null,
      profile: j.profile || '',
      role: j.role || '',
      model: task ? j.model || '' : '',
      effort: task ? j.effort || '' : '',
      modelOwn: !!j.modelOwn,
      title: task ? specTitle(j.id) : '',
      why: task ? j.engineWhy?.text || '' : '',
      switched: !!j.switched,
      worker: task ? j.worker || '' : '', // which worker took it (whichWorker)
      state: j.state,
      summary: summary(j),
      slot: j.slot || null,
      attempt: j.attempt || 1,
      timeoutMin: task ? j.timeoutMin || CFG.taskTimeoutMin : null,
      acked: !!j.acked,
      createdAt: j.createdAt || null,
      startedAt: j.startedAt || null,
      finishedAt: j.finishedAt || null,
      // "Blocked by the tool": the guard holds its merge until the owner decides (lib/guard.mjs)
      held: task && j.held ? { id: j.held.id, card: j.held.card || '', files: j.held.files || [], text: j.held.text || '' } : null,
      // a task closed with nextlevel close (FR-021): the Build page says so, with its reason
      closed: task && closed.has(j.id) && !ACTIVE.has(j.state) ? closedView(j.id, closed.get(j.id)) : null,
      // what its ended attempts used (the usage ledger): tokens where its engines reported them
      usage: task && used.has(j.id) ? used.get(j.id) : null,
    };
  };
  const active = jobs.filter((j) => j.state === 'running' || j.state === 'verifying').map((j) => {
    const d = jobDir(j.id);
    const wt = j.type === 'task' && j.slot ? slotPath(j.slot) : null;
    const job = j.type === 'task' ? readJson(path.join(d, 'job.json')) || {} : {};
    // a task's log is this attempt's alone, and says which attempt it is (FR-008)
    const view = j.type === 'task' ? attemptLogView(j, 40) : { name: jobLogName(j), lines: tailLines(path.join(d, jobLogName(j))), inWindow: false };
    return {
      ...pick(j),
      // one plain sentence: what it does now ("Gateway, attempt 6: fixing what the review found: ...")
      sentence: j.type === 'task' ? taskSentence(j, { title: specTitle(j.id), feedback: (job.feedback || []).at(-1) }) : `${j.id}: ${j.type === 'check' ? 'a check the orchestrator asked for' : j.type === 'push' ? 'pushing to GitHub' : 'git, for the orchestrator'}`,
      folder: wt,
      log: { name: view.name, attempt: view.attempt || null, lines: view.lines },
      // only a task an older nextlevel ran in a window of its own has its output there, not in worker.log (FR-010)
      inWindow: view.inWindow,
      // what the worker has done so far, from git: its commits, and the files it changed since
      commits: j.type === 'task' ? lines(git(['log', '--oneline', `${CFG.base}..task/${j.id}`], { allowFail: true }).out).slice(0, 20) : [],
      // ...this attempt's own first (FR-020; null for an attempt an older hub started, whose start isn't recorded)
      own: j.type === 'task' ? ((o) => (o && !o.lost ? { commits: o.commits, count: o.count, stat: o.diffStat } : null))(attemptOwn(j.id, j.startTip)) : null,
      changed: wt && fs.existsSync(wt) ? lines(git(['status', '--porcelain'], { cwd: wt, allowFail: true }).out).slice(0, 40) : [],
      // its latest progress note (the rest, and the feed, come from /api/activity while its toggle is open)
      progress: j.type === 'task' ? (({ lines: l, at }) => ({ line: l[0] || '', at }))(progressNotes(j, 1)) : null,
    };
  });
  const finished = jobs.filter((j) => FINAL.has(j.state));
  const orchOpen = orch && alive(orch.pid);
  return {
    project: { name: NAME, root: ROOT, base: CFG.base, slots: CFG.slots },
    tool: toolDetails(),
    update: updateView(), // Home's "Update available" (safe updates)
    windows: IS_WIN, // the dashboard can open the orchestrator's and the guide's windows
    hub: {
      running: hubAlive(),
      stopping: !!h?.stopping && alive(h.pid),
      since: h?.startedAt || null,
      log: tailLines(path.join(LOGS, 'hub.log'), 30),
    },
    autopilot: autopilotView(settings, jobs),
    // (its record says what it runs with: orchestratorRecord)
    orchestrator: orchOpen
      ? { mode: orch.mode, since: orch.startedAt, engine: engineTitle(orch.engine || CFG.orchestrator.engine), model: orch.model || '', effort: orch.effort || '', log: orch.log ? tailLines(path.join(ROOT, orch.log), 20, { engineName: orch.engine }) : [] }
      : null,
    // who fills each role, with the model and effort in use (the Team page), and the engines the guide is offered on
    team: teamView(CFG.config, { home, access: accessFacts(checkContext(), { version: () => agyVersionNow() }), available: installedEngine }),
    workerWindow: windowView(CFG.config), // how a worker's process shows (workers.window, FR-010)
    codexWorkers: { ...codexWorkersView(CFG.config), windows: IS_WIN }, // Codex workers' sandbox (engines.codex.workerArgs)
    githubChecks: githubChecksView(), // the project's GitHub checks on this PC (the self-hosted runner's part A)
    teamChoices: { engines: engineChoices(), profiles: Object.entries(CFG.config.profiles).map(([name, p]) => ({ name, engine: p.engine, account: p.account || '', model: p.model || '', effort: p.effort || '' })) },
    // the first is the guide role's own (the orchestrator's engine unless the Team page gave it another)
    guides: guideEngines().map((e, i) => ({ engine: e, title: engineTitle(e), what: i === 0 ? 'guide' : `guide-${e}` })),
    status: CFG.config.paths.status,
    handoff: CFG.config.paths.handoff,
    milestones: st.milestones.map(([name, state = '', verified = '']) => ({ name, state, verified, done: isDone(state) })),
    blockers: st.blockers,
    waiting: st.waiting,
    lastActivity: ago(st.idleHours),
    usage: usageToday(jobs),
    security: securitySummary(), // Home's Security card (the security engineer, 1a-2)
    switches: switchesView(),
    alerts: taskAlerts(jobs),
    dispatchPaused: getSettings().dispatchPaused || null, // files a worker needs are gone (FR-013)
    heldSlots: heldView(), // slots a stopped worker's processes may still run in (FR-013)
    // tasks on Antigravity wait for a passing trial (FR-022): its version and agy's own reason, in one line
    agyHold: agyHoldView(jobs),
    lockHold: lockHoldView(),
    assistantHold: lockHoldView('assistant'),
    askTripwire: getSettings().askTripwire || null,
    blockAlert: blockAlertView(),
    slotEscape: slotEscapeView(),
    active,
    queued: jobs.filter((j) => j.state === 'queued').map(pick),
    review: finished.filter((j) => !j.acked).map(pick),
    recent: finished.filter((j) => j.acked).slice(-10).reverse().map(pick),
    // tasks whose merge the guard holds, and the changes that wait for the owner (the Notes page has their diff)
    blocked: jobs.filter((j) => j.type === 'task' && j.held).map(pick),
    // the tasks closed in the last week, those never dispatched too (FR-021)
    closed: closedSince(closed, Date.now() - 7 * 86_400_000).map((c) => ({ ...closedView(c.id, c), title: c.title || specTitle(c.id) })),
    guard: guardView().filter((x) => x.status === 'held' || (x.status === 'approved' && x.kind !== 'disk')),
    // the Notes page reads the cards again when this changes; Home lists the handoff items that wait for the owner
    ...(({ items, closed = [], ...summary }) => ({ cards: summary, handoff: items, handoffClosed: closed }))(cardsSummary()),
    // the Project page reads its view again when this changes (projectView)
    projectStamp: projectStamp(jobs),
    // what nextlevel fix started for this project, and where each one is (src/fix.mjs)
    fixes: fixStore()
      .list()
      .filter((f) => !f.project || f.project === ROOT)
      .slice(-10)
      .reverse()
      .map((f) => ({ number: f.number, url: f.url, title: f.title, checks: f.checks, checkTitles: f.checkTitles, mode: f.mode, session: f.session || null, state: f.state, startedAt: f.startedAt, head: f.head || null, result: f.result || null, problem: f.problem || null, toldReleased: f.toldReleased || null })),
  };
}

// ---------- the Notes page: the owner's notes and the team's handoff items, as cards (lib/cards.mjs) ----------
// The owner's own words (a note's text, a reply to a handoff item) come back as they are, since the page edits
// them; what the team wrote (its replies, the handoff items) is redacted by the dashboard like everything else.
// A handoff card as the page gets it: with its thread (FR-014) and whether the team's last answer waits for the owner
// (with its closings and reopenings, undo Done and FR-018; a pending Done says when it becomes final)
const cardView = (x) => ({ ...x, unread: unreadAnswer(x), events: eventsOf(x), ...(x.accept ? { acceptState: acceptState(x).state } : {}) });
// A card whose plan passed in another version than the one it was added with: what changed, step by step, from code
function planChange(x) {
  const last = (x.accept.runs || []).at(-1);
  const run = last && readRun(DIR, last.id);
  if (!run?.commit || !COMMIT_RE.test(run.commit) || !COMMIT_RE.test(x.accept.commit)) return '';
  const read = (c) => {
    const r = git(['show', `${c}:${x.accept.plan}`], { allowFail: true });
    return r.ok ? readPlan(r.out, { file: x.accept.plan }).plan : null;
  };
  const before = read(x.accept.commit);
  const after = read(run.commit);
  return before && after ? changesWords(planChanges(before, after)) : '';
}
function cardsView() {
  const store = cards();
  try {
    store.handoff.settle();
  } catch (err) {
    log(`cards: a Done past its Undo couldn't be made final now (the next look tries again): ${err.message}`);
  }
  const notes = noteGroups(store.notes.list());
  const items = store.handoff.list().map((x) => (x.status === 'open' && x.accept && acceptState(x).state === 'changed' ? { ...cardView(x), planChange: planChange(x) } : cardView(x)));
  const news = store.news();
  const closed = items.filter((x) => x.status !== 'open');
  return {
    files: store.files,
    store: store.store,
    repo: githubRepo(git(['remote', 'get-url', 'origin'], { allowFail: true }).out) || '', // links to commits
    notes,
    // (answered: done cards the team answered since, which wait for the owner again until a reply or Done)
    handoff: { open: items.filter((x) => x.status === 'open'), answered: closed.filter(awaitsOwner), history: closed.filter((x) => !awaitsOwner(x)).sort((a, b) => String(b.doneAt || b.updatedAt).localeCompare(String(a.doneAt || a.updatedAt))) },
    news,
    now: new Date(clockNow()).toISOString(), // (the page counts an Undo's seconds from this, not from its own clock)
    undoMs: UNDO_MS,
  };
}
// For the build data (every tick): the counts, a stamp that changes with the cards, and the handoff items that wait for
// the owner (the open ones, and done ones the team answered since: FR-014).
function cardsSummary() {
  try {
    const store = cards();
    const g = noteGroups(store.notes.list());
    // (a Done past its Undo becomes final here too: the dashboard runs without a hub as well)
    store.handoff.settle();
    // (a pending Done: only when it becomes final, never its reply; the server's time only while one is pending, so a
    // quiet tick leaves the build data as it was and pushes nothing)
    const all = store.handoff.list().map((x) => ({ ...cardView(x), pending: x.pending ? { finalAt: x.pending.finalAt } : undefined }));
    const items = all.filter(awaitsOwner);
    // (closed: the handled items' ids, so Home's Blockers doesn't count a "Needs you" the owner has done)
    return { stamp: store.stamp(), rules: g.rules.length, open: g.open.length, fresh: store.news().notes.length, handoff: items.length, items, closed: all.filter((x) => x.status !== 'open').map((x) => x.id), now: all.some((x) => x.pending) ? new Date(clockNow()).toISOString() : undefined };
  } catch (err) {
    return { stamp: '', error: err.message, items: [] };
  }
}
// ---------- the Project page (M11): what the project is, its roadmap, pace and decisions (lib/roadmap.mjs) ----------
// Read from the files the orchestrator keeps, the hub's job records and git's dates; made again only when something it
// reads has changed (the stamp: the files' times, the task jobs' states, the main checkout's last commit).
const mtimeOf = (f) => {
  try {
    return fs.statSync(f).mtimeMs;
  } catch {
    return 0;
  }
};
const mdFiles = (dir) => {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort();
  } catch {
    return [];
  }
};
function projectStamp(jobs = allJobs()) {
  const p = CFG.config.paths;
  let head = 0;
  try {
    head = mtimeOf(path.join(commonDir(), 'logs', 'HEAD'));
  } catch {
    // no git folder to look at: the files and jobs still count
  }
  const dirs = [path.join(ROOT, p.plans), TASKS].map((d) => mdFiles(d).map((f) => `${f}:${mtimeOf(path.join(d, f))}`).join(','));
  const tasks = jobs.filter((j) => j.type === 'task').map((j) => `${j.id}:${j.state}:${j.attempt || 1}:${j.acked ? 1 : 0}`);
  // (and the closures and the finished merge jobs: what the roadmap counts, FR-021)
  const merges = jobs.filter((j) => j.type === 'git' && j.state === 'done' && j.id.startsWith('merge-')).map((j) => j.id);
  const parts = [...[p.project, p.status, p.decisions, 'BRIEF.md'].map((f) => mtimeOf(path.join(ROOT, f))), head, ...dirs, tasks.join(','), readText(CLOSEDFILE), merges.join(',')];
  return createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}
let projectCache = null; // { stamp, value }
function projectView() {
  refreshConfig();
  const jobs = allJobs();
  const stampNow = projectStamp(jobs);
  if (projectCache?.stamp === stampNow) return projectCache.value;
  const p = CFG.config.paths;
  const text = (f) => readText(path.join(ROOT, f));
  // When git first had each plan, and when each task branch was merged (`nextlevel merge` says task/<id>)
  const added = new Map();
  for (const chunk of git(['log', '--diff-filter=A', '--format=%x01%cI', '--name-only', '--', p.plans], { allowFail: true }).out.split('\x01')) {
    const [date, ...files] = chunk.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    for (const f of files) added.set(f, date); // newest first: the oldest is kept
  }
  const merged = mergedNow(jobs); // (and the hub's finished merge jobs, FR-021)
  // (each plan is matched to its milestone by what it says, then its name: FR-016)
  const plans = mdFiles(path.join(ROOT, p.plans)).map((f) => {
    const file = `${p.plans}/${f}`.replace(/\\/g, '/');
    return { file, added: added.get(file) || null, ...parsePlan(text(file)) };
  });
  const specs = mdFiles(TASKS)
    .filter(isTaskSpec)
    .map((f) => {
      const id = f.replace(/\.md$/i, '');
      const spec = readText(path.join(TASKS, f));
      return { id, milestone: specMilestone(spec), title: taskTitle(spec, id) };
    });
  const tasks = jobs
    .filter((j) => j.type === 'task' && !isBridgeTask(j.id))
    .map((j) => ({ id: j.id, state: j.state, summary: summary(j), attempt: j.attempt || 1, engineTitle: j.engine ? engineTitle(j.engine) : '', switched: !!j.switched, worker: j.worker || '', createdAt: j.createdAt || null, finishedAt: j.finishedAt || null, acked: !!j.acked }));
  const status = statusMilestones(text(p.status)).map(([name, state = '', verified = '']) => ({ name, state, verified, done: isDone(state) }));
  const brief = parseBrief(text('BRIEF.md'));
  const roadmap = buildRoadmap({ status, brief, plans, specs, jobs: tasks, merged, closed: closures(), plansDir: p.plans });
  const value = {
    ok: true,
    stamp: stampNow,
    files: { project: p.project, status: p.status, decisions: p.decisions, plans: p.plans, brief: 'BRIEF.md' },
    repo: githubRepo(git(['remote', 'get-url', 'origin'], { allowFail: true }).out) || '',
    about: { ...parseProjectDoc(text(p.project)), goal: brief.goal },
    roadmap,
    // what the page warns about (and the doctor's project.plans): plans not found, incomplete, or two for a milestone
    planProblems: planProblems(roadmap, { plansDir: p.plans }),
    pace: pace(roadmap),
    decisions: parseDecisions(text(p.decisions)),
  };
  projectCache = { stamp: stampNow, value };
  return value;
}

// What the page's buttons do: { action, id, text, type } for a note, { action, id, reply } for a handoff item.
function noteAction(b) {
  const n = cards().notes;
  const id = String(b.id || '');
  switch (b.action) {
    case 'add':
      return { item: n.add({ text: String(b.text ?? ''), type: b.type === 'rule' ? 'rule' : 'once' }), message: b.type === 'rule' ? 'Added the standing rule. The orchestrator reads it at its next start or round.' : 'Added. The orchestrator reads it at its next start or round.' };
    case 'edit':
      return { item: n.edit(id, String(b.text ?? '')), message: 'Changed: the orchestrator reads it again.' };
    case 'withdraw':
      return { item: n.withdraw(id), message: 'Withdrawn.' };
    case 'off':
      return { item: n.setOff(id, true), message: "Switched off: the orchestrator doesn't follow it until you switch it on." };
    case 'on':
      return { item: n.setOff(id, false), message: 'Switched on: the orchestrator follows it again.' };
    case 'remove':
      return { item: n.remove(id), message: 'Removed: it stays in the history.' };
    default:
      throw new Error('unknown action');
  }
}
function handoffAction(b) {
  const h = cards().handoff;
  const id = String(b.id || '');
  const was = h.list().find((x) => x.id.toLowerCase() === id.trim().toLowerCase())?.status;
  if (b.action === 'done') {
    // (undo Done: it becomes final after UNDO_MS, unless the owner clicks Undo first; Done on a done card the team
    // answered since marks the answer read, FR-014)
    const item = h.done(id, { reply: String(b.reply ?? ''), delay: UNDO_MS });
    const secs = Math.round(UNDO_MS / 1000);
    return { item: cardView(item), message: was === 'done' ? `Marked read: Undo for ${secs} seconds.` : `Marked done: Undo for ${secs} seconds, then the team picks it up at its next start or round.` };
  }
  if (b.action === 'undo') return { item: cardView(h.undo(id)), message: `Undone: ${id} is as it was, and the team never saw it.` };
  if (b.action === 'reopen') return { item: cardView(h.reopen(id, { how: 'dashboard' })), message: `${id} is open again. The team sees it at its next start or round; what it did since isn't undone.` };
  if (b.action === 'reply') {
    const item = h.reply(id, String(b.reply ?? ''));
    return { item: cardView(item), message: was && was !== 'open' ? `Sent, and ${item.id} is open again: the team reads it at its next start or round.` : 'Sent: the team reads it at its next start or round.' };
  }
  throw new Error('unknown action');
}

// One job, for its details on the page: status, the worker's report and the ends of its logs.
function dashboardJob(id) {
  const s = JOB_ID_RE.test(String(id)) ? jobStatus(id) : null;
  if (!s) return null;
  const d = jobDir(id);
  const logs = {};
  // A task's worker.log and verify.log: this attempt's alone, named with it (FR-008)
  let attempt = '';
  if (s.type === 'task') {
    const view = attemptLogView({ ...s, state: s.state === 'verifying' ? 'running' : s.state }, 80);
    attempt = ` · attempt ${view.attempt}`;
    if (view.inWindow) logs[`worker.log${attempt}`] = [`(attempt ${view.attempt} ran in a window of its own: its output was there)`];
    else if (view.lines.length) logs[`worker.log${attempt}`] = view.lines;
  }
  for (const f of ['verify.log', 'check.log', 'push.log', 'git.log']) {
    if (!fs.existsSync(path.join(d, f))) continue;
    logs[f === 'verify.log' ? `${f}${attempt}` : f] = tailLines(path.join(d, f), 80);
  }
  const report = readText(path.join(d, 'RESULT.md'));
  // The first 200 lines of a long report, saying so and where all of it is (FR-012)
  const shown = head(report, { lines: 200, bytes: 64 * 1024 });
  const whole = rel(path.join(d, s.reportFile && fs.existsSync(path.join(d, s.reportFile)) ? s.reportFile : 'RESULT.md'));
  const progress = s.type === 'task' ? progressNotes(s, 50).lines.reverse() : []; // oldest first, as written
  return {
    id,
    summary: summary(s),
    status: s,
    branch: s.type === 'task' ? `task/${id}` : null,
    resultFile: s.resultFile || '',
    // How this attempt ended and what it did itself, and how the attempts before it ended (FR-020)
    attempt: s.type === 'task' ? attemptView(id, s) : null,
    report: !report ? '' : shown.more ? `${shown.text}\n\n[... shortened here: the report has ${sizeText(sizeOf(report))}, and these are its first ${shown.last} lines. All of it: ${whole}]` : report.trimEnd(),
    progress,
    logs,
  };
}

// The hub, started from the dashboard: in its own window on Windows (what START.cmd -> 4 does), in the
// background elsewhere (and with NEXTLEVEL_HUB_WINDOW=0, for tests); its hub.log is on the page.
function startHub(say) {
  if (hubAlive()) return say('The hub is already running.');
  if (LOADED.error) throw new Error(`The hub can't start until nextlevel.json is fixed: ${LOADED.error.split('\n')[0]} (the Setup page shows it).`);
  if (IS_WIN && envFlag('HUB_WINDOW') !== '0') return cmdStartHubWindow(say);
  mkdirp(LOGS);
  const out = fs.openSync(path.join(LOGS, 'hub-console.log'), 'a');
  spawn(process.execPath, [BIN, 'run'], { cwd: ROOT, env: childEnv(), detached: true, windowsHide: true, stdio: ['ignore', out, out] }).unref();
  fs.closeSync(out);
  say('Started the hub in the background. Stop it here; its log is on this page.');
}

// Asks the hub to stop at its next tick. It finishes the verifications and checks in progress first;
// workers keep running, and the next hub picks their results up.
async function stopHub(say) {
  const h = readJson(HUBFILE);
  if (!h || !alive(h.pid)) return say('The hub is not running.');
  writeJson(STOPFILE, { at: now(), by: 'dashboard' });
  for (let i = 0; i < 60 && fs.existsSync(STOPFILE) && alive(h.pid); i++) await sleep(250);
  if (fs.existsSync(STOPFILE) && alive(h.pid)) {
    fs.rmSync(STOPFILE, { force: true });
    throw new Error("The hub didn't take the stop request (a hub started before this version doesn't know it). Close its window, or press Ctrl+C in it.");
  }
  for (let i = 0; i < 20 && alive(h.pid); i++) await sleep(250);
  say(alive(h.pid) ? 'The hub is stopping: it finishes the verifications in progress first.' : 'The hub has stopped. Running workers keep going; the next hub start picks up their results.');
}

// Autopilot on or off (the dashboard, the menu, nextlevel run --autopilot). Turned on, it says when (onAt): the hub then
// releases the brake and the fuse, and looks at what happened while it was off (FR-019).
// The owner's switch. -> what the owner is told besides (an owner action is never lost without a word, FR-019): the lock
// of settings.json taken over on the way, or the file not as written when read right after
function turnAutopilot(on) {
  const events = [];
  const at = clockIso();
  // (what autopilot kept before FR-019 goes)
  updateSettings(({ noProgress, cycles, lastCycleEnd, ...was }) => ({ ...was, autopilot: !!on, pausedReason: null, ...(on ? { onAt: at } : {}) }), events);
  const s = getSettings();
  if (!!s.autopilot !== !!on || (on && s.onAt !== at)) {
    log(`settings.json: the owner turned autopilot ${on ? 'on' : 'off'}, and right after the file says otherwise`);
    return ` But settings.json says otherwise right after: another process changed it. Look at the switch again (hub.log has what nextlevel saw).`;
  }
  return events.length ? ' (Another nextlevel process held settings.json too long: nextlevel took its lock over, wrote your change, and noted it in hub.log.)' : '';
}
function setAutopilot(on, say) {
  const also = turnAutopilot(on);
  const next = on ? ' A round starts when something happens: your note or reply, a task finishing, or Run a round now on Home.' : '';
  say(`Autopilot is now ${on ? 'ON' : 'off'}.${on && !hubAlive() ? ' Start the hub for it to act.' : ''}${next}${also}`);
}
// The owner's Run a round now (the dashboard): the hub takes it at its next look, as the owner acting (FR-019)
function runRoundNow(say) {
  const s = getSettings();
  if (!s.autopilot) return say("Autopilot is off: turn it on, or open the orchestrator in its window and talk to it yourself.");
  if (s.pausedReason) return say(`Autopilot is paused (${s.pausedReason}): resume it first.`);
  // (a count, under the file's lock: the hub only reads it, and starts a round when it has changed since it last looked;
  // the press is never lost without a word: a lock taken over on the way, or the count not as written, is said)
  const events = [];
  const { n } = updateJsonFile(ROUNDNOW, (r) => ({ n: pressCount(r) + 1, at: clockIso(), by: 'owner' }), {}, { onLock: lockLog(ROUNDNOW, events) });
  const also =
    pressCount(readJsonFile(ROUNDNOW, {})) < n // (another press since only raises it)
      ? ' But round-now.json says otherwise right after: another process changed it. If no round starts, press it again (hub.log has what nextlevel saw).'
      : events.length
        ? ' (Another nextlevel process held round-now.json too long: nextlevel took its lock over, counted your press, and noted it in hub.log.)'
        : '';
  say(`${hubAlive() ? 'A round starts within a minute (after the one running, if one runs).' : 'The hub is not running: the round starts when you start it.'}${also}`);
}

// What the dashboard may read and do. Windows it opens (orchestrator, guide) are opened by running the
// same commands the owner would type (`nextlevel orchestrator`, `nextlevel guide <engine>`).
function dashboardApi() {
  return {
    root: ROOT,
    name: NAME,
    stateDir: DIR,
    bin: BIN,
    toolRoot: TOOL_ROOT,
    windows: IS_WIN,
    secrets: () => Object.values(parseEnvFile(path.join(ROOT, '.env'))).filter(Boolean),
    cards: { view: cardsView, note: noteAction, handoff: handoffAction },
    // held changes of protected files: their words and exact diff, and the owner's Approve or Reject (lib/guard.mjs)
    guard: { view: () => guardView({ full: true }), decide: (b) => guardDecide(String(b.id || ''), b.action, b.reason) },
    chats: chatStore(path.join(DIR, 'chats')), // the Ask panel's threads (src/ask.mjs, lib/chats.mjs)
    fileReport: (id, hash) => fileShownReport(id, hash), // File it under a report the page showed (FR-017: no command does it)
    state: dashboardState,
    project: projectView,
    job: dashboardJob,
    activity: dashboardActivity,
    // the Security page and Home's buttons (src/security.mjs): its data, and the owner's scan, deep scan, stop, new draft
    security: { view: () => { refreshConfig(); return securityPage({ root: ROOT, stateDir: DIR, config: CFG.config }, { pending: policyHeld().map((x) => ({ id: x.id, card: x.card || '', source: x.source })) }); }, act: (b) => { refreshConfig(); return securityAct(b); } },
    usage: usageView, // Home's Usage card for a range, by a field, this project or all (the owner's: the page's key)
    // the tester (tester part 3): Home's Run acceptance and the Team page's card, a run's table and its evidence files,
    // and the owner's run (the dashboard's process is the owner's)
    tester: {
      view: () => {
        refreshConfig();
        return testerView(testerCtx());
      },
      run: (id) => runView(DIR, id),
      file: (id, name) => evidenceFile(DIR, id, name),
      ask: (b) => {
        refreshConfig();
        return ownerRun(testerCtx(), String(b.plan || ''), String(b.env || ''));
      },
    },
    startHub,
    stopHub,
    setAutopilot,
    runRoundNow, // Run a round now: the owner acting, for the hub's next look (FR-019)
    checkSlot, // Check again on a held slot's card: the hub lists the processes once more
    checkAgyAgain, // Check again on the card of Antigravity tasks that wait: the hub runs the trial again (FR-022)
    update: updateAction, // the one-click update's buttons (safe updates: src/updater.mjs)
    version: runningVersion(TOOL_ROOT),
    checkLockAgain, // Check again on the card of the orchestrator held by its lock test: the hub runs it again
    blockAlertSeen, // Seen, on the card of a round on Antigravity that ran commands clearing the push block
    slotEscapeSeen, // Seen, on the card of a worker that did something outside its slot
    askEstimate, // the Advisor panel's estimate of what a question sends
    advisorMemory, // the Advisor panel's Memory: list, and the owner's add, edit and remove
    askTripwireSeen: (say = (m) => console.log(m)) => {
      setSetting('askTripwire', null);
      say('Marked as seen.');
    },
  };
}

async function cmdUi(argv) {
  const a = commandArgs('ui', argv);
  const running = await reopenDashboard(DIR);
  if (running) return console.log(`The dashboard for this project is already running: ${reopenedHow(running)}`);
  // What it starts doesn't check for updates as it starts (the page's own files are read once, at start)
  if (!updatesOff()) process.env.NEXTLEVEL_NO_UPDATE = CHECKED;
  if (IS_WIN) process.title = `${NAME} dashboard`;
  // Home's update card is fresh when no hub ran for days: the dashboard looks for releases at its start too (6 hours)
  if (!ownerSaysNoUpdates()) {
    const a = readAvailable();
    if (!a?.at || Date.now() - Date.parse(a.at) >= AVAILABLE_EVERY_MS) {
      try {
        spawn(process.execPath, [BIN, '_releases'], { cwd: ROOT, env: process.env, stdio: 'ignore', windowsHide: true }).on('error', () => {});
      } catch {
        // the card shows what was found last
      }
    }
  }
  await startDashboard(dashboardApi(), { port: num(a.port, 0), open: !a['no-open'] && envFlag('NO_BROWSER') !== '1' });
}

// What the dashboard running did when asked to show its page again: a new one-time link, in the browser or its window
// (FR-017 part 2A: the link never comes back here)
const reopenedHow = (r) =>
  r?.open === false
    ? r.prints !== false
      ? 'its window shows a new link, good once and for a minute.'
      : 'it runs without a browser or a window, so it has nowhere to show a new link: stop it and start it again.'
    : 'it opened its page in your browser again.';

// START.cmd -> d: the dashboard in its own window, which opens the browser; or the one already running.
async function cmdDashboardWindow() {
  refuseForAgents('The dashboard');
  const running = await reopenDashboard(DIR);
  if (running) return console.log(`The dashboard was already running: ${reopenedHow(running)}`);
  if (IS_WIN) {
    openWindow(`${NAME} dashboard`, process.execPath, [BIN, 'ui'], { keepOpen: true, env: childEnv() });
    console.log('Opened the dashboard in a new window; it opens your browser. Leave that window open while you use it.');
  } else console.log(`Run in another terminal, in ${ROOT}: nextlevel ui`);
}

// A menu an older version opened, after an update: its 4 and d would start that version's hub or dashboard, so they say
// to open START.cmd again instead (safe updates)
function staleMenu() {
  const mine = runningVersion(TOOL_ROOT);
  const now = mine ? versionFor(ROOT) : null;
  if (!now || now === mine) return false;
  console.log(`nextlevel was updated to ${now}, and this menu is ${mine}: close this window and open START.cmd again for the new menu.`);
  return true;
}

async function menu() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const items = [
    ['1', 'Doctor: check the setup and fix what it can', async () => cmdDoctor([], rl)],
    ['2', `Setup guide with ${engineTitle(guideEngines()[0])}`, async () => cmdGuide()],
    ['3', `Setup guide with ${engineTitle(guideEngines()[1])}`, async () => cmdGuide(guideEngines()[1])],
    ['4', 'Start the hub (runs workers; leave it open)', async () => cmdStartHubWindow()],
    ['5', `Open the orchestrator (${engineTitle(CFG.orchestrator.engine)}, interactive)`, async () => cmdOrchestrator()],
    ['6', 'Autopilot on/off (hub wakes the orchestrator when needed)', async () => {
      const s = getSettings();
      setAutopilot(!s.autopilot || !!s.pausedReason, (m) => console.log(m.replace('Start the hub', 'Start the hub (4)')));
    }],
    ['7', 'Status', async () => cmdStatus([])],
    ['8', 'Bridge test (two workers in parallel)', async () => cmdBridgeTest([])],
    ['9', 'Send the daily report now', async () => cmdDailyReport([])],
    ['d', 'Dashboard in your browser: setup, build and controls', async () => cmdDashboardWindow()],
    ['0', 'Exit', null],
  ];
  for (;;) {
    console.log(`\n=== ${NAME} · nextlevel ===\nProject: ${ROOT}`);
    try {
      cmdStatus([]);
    } catch {
      // status is best-effort in the menu
    }
    console.log('');
    for (const [k, label] of items) console.log(`  ${k}) ${label}`);
    const pick = (await rl.question('\nChoose: ')).trim().toLowerCase();
    const item = items.find(([k]) => k === pick);
    if (!item) continue;
    if (!item[2]) break;
    // (every item of a menu an older version opened: its orchestrator, guide, bridge test or doctor would run that version)
    if (staleMenu()) continue;
    try {
      await item[2]();
    } catch (err) {
      console.log(`\n${err.message}`);
    }
  }
  rl.close();
}

// ---------- main ----------
const COMMAND_TABLE = {
  doctor: (rest) => cmdDoctor(rest, null).then((bad) => (process.exitCode = bad ? 1 : 0)),
  ui: (rest) => {
    refuseForAgents('The dashboard');
    return cmdUi(rest);
  },
  guide: (rest) => cmdGuide(rest[0]),
  run: (rest) => {
    refuseForAgents('The hub');
    return cmdRun(rest);
  },
  orchestrator: (rest) => cmdOrchestrator(rest),
  login: (rest) => cmdLogin(rest).then((code) => (process.exitCode = code)),
  'bridge-test': (rest) => cmdBridgeTest(rest).then((ok) => (process.exitCode = ok ? 0 : 1)),
  dispatch: (rest) => cmdDispatch(rest),
  retry: (rest) => cmdDispatch(rest, { retry: true }),
  verify: (rest) => cmdVerify(rest),
  push: (rest) => cmdPush(rest),
  commit: (rest) => cmdCommit(rest).then((code) => (process.exitCode = code)),
  merge: (rest) => cmdMerge(rest).then((code) => (process.exitCode = code)),
  close: (rest) => cmdClose(rest).then((code) => (process.exitCode = code)),
  notify: (rest) => cmdNotify(rest),
  wakeup: (rest) => (process.exitCode = cmdWakeup(rest)),
  wait: (rest) => cmdWait(rest).then((code) => (process.exitCode = code)),
  status: (rest) => cmdStatus(rest),
  usage: (rest) => cmdUsage(rest),
  result: (rest) => cmdResult(rest),
  cleanup: (rest) => cmdCleanup(rest).then((code) => (process.exitCode = code)),
  'daily-report': (rest) => cmdDailyReport(rest),
  report: (rest) => cmdReport(rest, { ctx: checkContext(), startFix: (n, { asker }) => cmdFix([String(n)], { ctx: checkContext(), env: toolEnv(), notify: phoneNow, asker }) }).then((code) => (process.exitCode = code)),
  fix: (rest) => cmdFix(rest, { ctx: checkContext(), env: toolEnv(), notify: phoneNow }).then((code) => (process.exitCode = code)),
  note: (rest) => cmdNote(rest, { store: cards() }),
  // (the team's answer on a card is redacted like a report before it is kept, and the owner's phone gets a message that
  // names the card, not the answer: FR-014)
  handoff: (rest) => cmdHandoff(rest, { store: cards(), redact: teamWords(), notify: queueNotify, name: NAME, tester: { config: CFG.config, base: CFG.base, stateDir: DIR, git: (args) => git(args, { allowFail: true }).out } }),
  team: (rest) => cmdTeam(rest, { root: ROOT, stateDir: DIR, hubAlive, loaded: LOADED }).then((code) => (process.exitCode = code)),
  ask: (rest) => {
    refuseInSandbox('The assistant (nextlevel ask)');
    return cmdAsk(rest, askContext()).then((code) => (process.exitCode = code));
  },
  _run: (rest) => cmdRunTask(rest[0]),
  _orch: (rest) => cmdOrchestratorProcess(rest),
  _guide: (rest) => cmdGuideProcess(rest),
  _cycle: (rest) => cmdCycleProcess(rest),
  _trial: (rest) => cmdTrialProcess(rest[0]),
  security: (rest) => cmdSecurity(rest, { root: ROOT, stateDir: DIR, config: CFG.config, hubAlive, envKeys: DOTENV_KEYS }).then((code) => (process.exitCode = code)),
  _scan: (rest) => cmdScanProcess(rest[0], scanContext()).then((code) => (process.exitCode = code)),
  tester: (rest) => cmdTester(rest, { root: ROOT, stateDir: DIR, config: CFG.config, base: CFG.base, hubAlive, git: (args) => git(args, { allowFail: true }).out }).then((code) => (process.exitCode = code)),
  _accept: (rest) => {
    // (setup() loaded the project's .env into this process: the run reads it only to redact with, so what it starts gets
    // none of it; acceptContext reads .env from its file)
    const ctx = acceptContext();
    for (const k of DOTENV_KEYS) delete process.env[k];
    return cmdAcceptProcess(rest[0], ctx).then((code) => (process.exitCode = code));
  },
  _locktest: (rest) => cmdLockTestProcess(rest[0]),
  _locktry: (rest) => cmdLockTryProcess(rest[0]),
  'lock-test': (rest) => cmdLockTest(rest).then((ok) => (process.exitCode = ok ? 0 : 1)),
};
export const HUB_COMMANDS = Object.keys(COMMAND_TABLE);
// Every command is in lib/commands.mjs, whose parser checks its arguments before it runs (FR-015)
for (const c of HUB_COMMANDS) if (!Object.hasOwn(COMMANDS, c)) throw new Error(`nextlevel ${c} isn't in lib/commands.mjs: add it there (its usage and options)`);

// Owner commands look at the fixes started for this project as they start (src/fix.mjs): a merged one that
// this nextlevel has now gets its checks run again, and the owner hears the verdict. The hub does it in its
// loop; `fix` itself does it too.
const FIX_CHECK_IN = new Set([undefined, 'init', 'doctor', 'ui', 'guide', 'orchestrator', 'bridge-test', 'report']);
async function checkInOnFixes() {
  const force = process.env.NEXTLEVEL_JUST_UPDATED === '1'; // a fix may have just arrived: ask GitHub now
  delete process.env.NEXTLEVEL_JUST_UPDATED;
  try {
    await followFixes({
      root: ROOT,
      force,
      notify: phoneNow,
      say: (m) => console.log(m),
      blocker: () => updateBlocker(ROOT),
    });
  } catch (err) {
    console.log(`(Couldn't look at the fixes started here: ${err.message})`);
  }
}

// What the assistant (nextlevel ask, src/ask.mjs) may read, and where its session counts. Its engine's environment
// has none of the project's .env values and says the session is read-only (lib/readonly.mjs); its git (a `git
// status` of Claude Code's in the main checkout) takes no optional lock, so it never holds index.lock while the hub
// commits for the orchestrator (lib/gitlock.mjs).
function askContext() {
  return {
    root: ROOT,
    stateDir: DIR,
    config: CFG.config,
    home: os.homedir(),
    status: () => statusData(),
    jobs: () => allJobs(),
    cards: () => cards(),
    commits: () => git(['log', '--oneline', '-15', CFG.base], { allowFail: true }).out,
    secrets: () => activitySecrets(),
    env: () => readEnv({ ...workerEnv(childEnv()), NEXTLEVEL_READ_ONLY: '1' }),
    addUsage: (engineName, u) => addUsage('assistant', engineName, u),
    // the advisor's wider briefing (docs/design/advisor.md section 3): what the hub reads itself
    plan: () => advisorPlan(),
    decisions: () => readText(path.join(ROOT, CFG.config.paths.decisions || 'docs/DECISIONS.md')),
    rounds: () => advisorRounds(),
    hubLog: () => tailBytes(path.join(LOGS, 'hub.log'), 3000),
    verifies: () => advisorVerifies(allJobs()),
    usage: () => advisorUsage(allJobs()),
    // the assistant on Antigravity (src/ask.mjs askAgy): its lock test, the protected files the tripwire looks at, agy's
    // version, a console with no window for agy, and what the tripwire found (a Home card)
    lockProblem: (role, profile) => lockProblem(role, profile),
    guardOpen: (key, what) => quietly(() => guardOpen(key, what)),
    guardClose: (key) => quietly(() => guardClose(key)),
    protectedEntries: () => protectedEntries(),
    agyVersion: () => agyVersionNow(),
    runConsole: (cmd, args, opts) => (needsConsole('agy') ? runInConsole(cmd, args, { ...opts, direct: true }) : runQuiet(cmd, args, opts)),
    tripwire: (changes) => {
      setSetting('askTripwire', { at: now(), changes: changes.slice(0, 10) });
    },
  };
}

// ---------- what the advisor reads (docs/design/advisor.md section 3) ----------
// The end of a file, cut by bytes, so one very long line can't take what is read of it
function tailBytes(file, n) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - n * 2);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8').replace(ANSI_RE, '');
    return (start ? text.slice(text.indexOf('\n') + 1) : text).slice(-n);
  } catch {
    return '';
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
// The current milestone (the Project page's) and its plan file
function advisorPlan() {
  const m = projectView().roadmap.find((x) => x.current);
  if (!m) return '';
  const tasks = m.tasks.map((t) => `- ${t.id}: ${t.state}${t.attempts > 1 ? ` (attempt ${t.attempts})` : ''}`).join('\n');
  const text = m.plan?.file ? readText(path.join(ROOT, m.plan.file)) : '(no plan found for it)';
  return { milestone: `${m.key} ${m.name} (${m.state}; ${m.counts.merged} of ${m.counts.total} task(s) merged)`, file: m.plan?.file || '', text: `${text.trim()}${tasks ? `\n\nIts tasks (the hub's):\n${tasks}` : ''}` };
}
// The hub's reading of rounds.json, through its shape check: never a file the hub wouldn't read
function advisorRounds() {
  if (!fs.existsSync(ROUNDSFILE)) return 'No autopilot round yet.';
  const saved = readJson(ROUNDSFILE);
  if (saved === null || roundsProblem(saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...freshState(), ...saved } : saved)) return 'rounds: not readable';
  const s = { ...freshState(), ...saved };
  const last = s.last ? `The last round: started ${s.last.startedAt}${s.last.endedAt ? `, ended ${s.last.endedAt}` : ''}${s.last.type ? `, started by ${s.last.type}` : ''}${s.last.what ? ` (${s.last.what})` : ''}${s.last.how ? `, ${s.last.how}` : ''}${s.last.real ? ', with something real after it' : ''}.` : 'No round has ended yet.';
  return [
    `Autopilot is ${getSettings().autopilot ? 'on' : 'off'}.`,
    s.round ? `A round runs, since ${s.round.startedAt} (${(s.round.reasons || []).join(', ')}).` : '',
    last,
    `Rounds in the last hour: ${s.starts.length}. Since the last real event (${s.real.at || 'none'}: ${s.real.what || '-'}): ${s.sinceReal} round(s); in a row with nothing real: ${s.streak}.`,
    s.pending.length ? `Waiting to start a round: ${s.pending.map((x) => x.what || x.type).join('; ')}.` : 'Nothing waits to start a round.',
    s.fuse ? `Autopilot turned itself off on ${s.fuse.at}: ${s.fuse.text}` : '',
  ].filter(Boolean).join('\n');
}
// The hub's own verify of the last task jobs: its state from the job's status, and a failing verify's first lines that
// say so (never a worker's claim)
function advisorVerifies(jobs) {
  const done = jobs.filter((j) => j.type === 'task' && j.verify).sort((a, b) => String(a.finishedAt || a.updatedAt || '').localeCompare(String(b.finishedAt || b.updatedAt || ''))).slice(-10);
  return done
    .map((j) => {
      const failing = j.verify === 'pass' ? [] : readText(path.join(jobDir(j.id), 'verify.log')).split(/\r?\n/).filter((l) => /\b(fail|failed|error|not ok)\b|✖/i.test(l)).slice(0, 4).map((l) => `    ${l.slice(0, 300)}`);
      return [`- ${j.id} (attempt ${j.attempt || 1}): verify ${j.verify}${j.finishedAt ? `, ${j.finishedAt}` : ''}`, ...failing].join('\n');
    })
    .join('\n');
}
// Today's usage, a line per role
function advisorUsage(jobs) {
  const u = usageToday(jobs);
  return u.roles.filter((r) => r.count).map((r) => `- ${r.title}: ${r.count} ${r.unit}(s), ${r.minutes} min${r.tokens ? `, ${r.tokens.toLocaleString('en-US')} tokens` : ''} (${r.engines.map((e) => e.title).join(', ')})`).join('\n') || 'Nothing ran today yet.';
}
// The composer's estimate (dashboardApi): the briefing's size for a mode and a card, kept until the project's stamp, the
// mode or the card changes
let estimateCache = null;
function askEstimate({ mode = 'advise', card = '' } = {}) {
  const m = ['advise', 'quick', 'explain'].includes(mode) ? mode : 'advise';
  const stamp = `${projectStamp(allJobs())}|${m}|${card || ''}`;
  if (estimateCache?.stamp === stamp) return estimateCache.value;
  const ctx = askContext();
  const value = briefingSize(ctx, { mode: card ? 'explain' : m, card: card ? cardFor(ctx, card) : null });
  estimateCache = { stamp, value };
  return value;
}
// The advisor's memory on the dashboard: the owner's own click, behind its session key. A change is no "owner acting"
// for autopilot: it gives the team nothing to do.
function advisorMemory(b = {}) {
  const store = memoryStore(advisorDir(ROOT));
  if (!b.action || b.action === 'list') {
    const { items, problem } = store.read();
    return { items, problem };
  }
  if (b.action === 'add') return { item: store.add({ text: b.text, kind: b.kind || undefined, from: b.from }), message: 'Remembered.' };
  if (b.action === 'edit') return { item: store.edit(b.id, { text: b.text, kind: b.kind || undefined }), message: 'Changed.' };
  if (b.action === 'remove') return { removed: store.remove(b.id).id, message: 'Forgotten.' };
  throw new Error('action must be list, add, edit or remove');
}

// Run one hub command (or the menu, with no command) on the project at `root`.
export async function runHub(cmd, rest, root) {
  setup(root, { tolerant: ['doctor', 'ui', 'report', 'fix', 'team'].includes(cmd) }); // a broken nextlevel.json is worth a report
  if (FIX_CHECK_IN.has(cmd) && !rest.includes('--json') && fixStore().list().length) await checkInOnFixes();
  delete process.env.NEXTLEVEL_JUST_UPDATED; // not for what this command starts
  if (!cmd) return menu();
  return COMMAND_TABLE[cmd](rest);
}
