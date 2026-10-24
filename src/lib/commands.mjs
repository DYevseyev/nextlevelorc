// Every nextlevel command: what it is for, its usage and its options, and the one parser every command goes through
// (FR-015). An orchestrator ran `nextlevel push --help` to learn the command's options; push took no arguments at all,
// ignored the flag and pushed main, which deployed production. So:
//   - `<command> --help` and `-h` print the command's usage and do nothing else (nextlevel help <command> prints the
//     same); cli.mjs asks before anything else runs: no update, no project lookup, no hub;
//   - an option the command doesn't have, or an argument it doesn't take, prints the usage and fails, doing nothing;
//   - the command's code reads its arguments from this parser (commandArgs), never from its own, so what was
//     checked is what runs. A new command gets all of it by being listed here (cli.mjs refuses one that isn't).
// The parsing is Node's own (util.parseArgs, strict).
import { parseArgs } from 'node:util';

export class UsageError extends Error {}

const S = (arg, help, extra = {}) => ({ type: 'string', arg, help, ...extra });
const B = (help, extra = {}) => ({ type: 'boolean', help, ...extra });
const JSON_OPT = B('the answer as JSON, for programs (the dashboard)');
const ANY = Infinity;

// group: where `nextlevel help` lists it (owner, orchestrator, other; internal ones only in their own usage).
// lines: [usage, what it does, its group when it isn't the command's], the first lines of its usage. text: more, in its own usage. options: its options
// ({ type, short, multiple, arg, help }). args: [least, most] arguments (after the subcommand, if it has them).
// subs: its subcommands ('' for none), each with the options it takes and its arguments. check(a): '' or what is wrong
// with a combination the options alone can't say. Everything after "--" is an argument (verify: the command to run).
export const COMMANDS = {
  // ---------- the owner's ----------
  init: {
    group: 'owner',
    lines: [['nextlevel init', "add nextlevel.json and the team's files to this project"]],
    text: 'Asks before it replaces a file of the project that differs from the template.',
    args: [0, 0],
  },
  ui: {
    group: 'owner',
    lines: [['nextlevel ui [--no-open]', 'the dashboard in your browser: setup, build, controls (START.cmd -> d)']],
    options: { 'no-open': B("don't open the browser; the link is printed"), port: S('<port>', 'the port on 127.0.0.1 (default: a free one)') },
    args: [0, 0],
  },
  doctor: {
    group: 'owner',
    lines: [['nextlevel doctor [--fix [<id>]] [--json]', 'check the setup; --fix repairs what it can (--fix <id>: one check)']],
    text: 'Without --fix it only looks (a harmless fix, such as .env from .env.example, is still made).',
    options: { fix: B('repair what can be repaired (asks first in the menu); with a check id, only that check', { optionalValue: '<id>' }), json: JSON_OPT, fresh: B('ask the tools again instead of using answers kept a few minutes') },
    args: [0, 1],
    check: (a) => (a._.length && !a.fix ? `"${a._[0]}": a check id goes with --fix (nextlevel doctor --fix ${a._[0]})` : ''),
  },
  guide: {
    group: 'owner',
    lines: [['nextlevel guide [<engine>|<profile>]', "open the setup guide (codex, agy or claude; default: the orchestrator's)"]],
    args: [0, 1],
  },
  run: {
    group: 'owner',
    lines: [['nextlevel run [--autopilot]', 'the hub; leave it running']],
    options: { autopilot: B('turn autopilot on: the hub starts a round when something happens (your note or reply, a task ending)'), 'exit-when-idle': B('stop once nothing is queued or running (for tests)'), 'tick-ms': S('<ms>', 'how often the hub looks, in milliseconds (for tests; default 5000)') },
    args: [0, 0],
  },
  orchestrator: {
    group: 'owner',
    lines: [['nextlevel orchestrator [--fallback]', "open the orchestrator (--fallback: on the role's fallback)"]],
    options: { fallback: B("on the orchestrator role's fallback (roles.orchestrator.fallback in nextlevel.json)") },
    args: [0, 0],
  },
  login: {
    group: 'owner',
    lines: [['nextlevel login [<profile>]', "sign a profile's account in, in this window (none: how each is signed in)"]],
    args: [0, 1],
  },
  team: {
    group: 'owner',
    lines: [
      ['nextlevel team', 'who fills each role: engine, model and effort in use'],
      ['nextlevel team set <role> --engine codex|claude|agy [--model M] [--effort E]', 'change a role (checked first)'],
      ['nextlevel team set worker-second --engine E [--takes no-docker|any|asked] | --engine none', 'the second worker, and what it takes'],
      ['nextlevel team models <engine>', "the models an engine's CLI lists"],
      ['nextlevel team window hidden|minimized|visible', "how a worker's process shows on Windows"],
      ['nextlevel team sandbox [on|off]', "Codex workers in Codex's sandbox (on), or without it like your other workers (off)"],
      ['nextlevel team runner status|on [--repo owner/name]', "the project's GitHub checks on this PC: offered and recommended, and setting it up"],
    ],
    options: {
      json: JSON_OPT,
      engine: S('<engine>', 'set: the engine (codex, claude or agy)'),
      model: S('<model>', "set: the model ('' for the engine's own choice)"),
      effort: S('<effort>', "set: the reasoning effort ('' for the engine's own choice)"),
      profile: S('<profile>', 'set: a profile of nextlevel.json instead of an engine'),
      takes: S('<what>', 'set worker-second: what the second worker takes: no-docker (tasks without Docker), any (any task) or asked (only when the spec asks)'),
      check: B("set: check the change, don't save it"),
      anyway: B('set: save it although a check warns'),
      repo: S('<owner/name>', "runner: a GitHub repository other than the project's origin"),
    },
    subs: { '': { options: ['json'], args: [0, 0] }, set: { options: ['engine', 'model', 'effort', 'profile', 'takes', 'check', 'anyway', 'json'], args: [1, 1] }, models: { options: ['json'], args: [1, 1] }, window: { options: ['json'], args: [1, 1] }, sandbox: { options: ['json'], args: [0, 1] }, runner: { options: ['repo', 'json'], args: [1, 1] } },
  },
  ask: {
    group: 'owner',
    lines: [
      ['nextlevel ask "question" [--thread <id>]', 'ask the assistant about the project (read-only; never the orchestrator)'],
      ['nextlevel ask threads | show <id> | new | rename <id> "title" | clear <id> | delete <id>', 'its threads'],
    ],
    text: 'A question that starts with "-" goes after "--": nextlevel ask -- "-h in git means?"',
    options: { thread: S('<id>', 'go on in this thread'), search: S('<text>', 'threads: only those with this text'), json: JSON_OPT },
    args: [0, ANY],
  },
  'bridge-test': {
    group: 'owner',
    lines: [['nextlevel bridge-test [--profile P]', "prove hub -> workers works and workers can't push"]],
    options: { profile: S('<profile>', 'the workers on this profile'), engine: S('<engine>', 'the workers on this engine'), timeout: S('<minutes>', 'how long each worker may take (default 20)') },
    args: [0, 0],
  },
  'lock-test': {
    group: 'owner',
    lines: [['nextlevel lock-test --engine agy --role orchestrator|assistant', "prove the orchestrator or the assistant on Antigravity can't push, use your GitHub sign-in or your MCP servers, and that the assistant changes nothing of the project (a few minutes)"]],
    text: "It runs the role's own sessions in a throwaway project of its own, one command each, and keeps the verdict for this agy version and these arguments. The hub runs it by itself while autopilot is on.",
    options: { engine: S('<engine>', 'agy (the only engine it is for)'), role: S('<role>', 'orchestrator or assistant'), model: S('<model>', "the agy model to test with when the role isn't on agy yet") },
    args: [0, 0],
  },
  'daily-report': {
    group: 'owner',
    lines: [['nextlevel daily-report [--no-send]', 'the daily report']],
    options: { 'no-send': B('print it; send nothing to the phone'), hours: S('<hours>', 'the last N hours (default 24)') },
    args: [0, 0],
  },
  report: {
    group: 'owner',
    lines: [['nextlevel report [<check-id>]', "a report for nextlevel's developers about a check that fails: you read it first, and it is filed on GitHub only if you say yes"]],
    text: "It files only in the owner's own window, never in an agent's session; --json builds one and files nothing. The dashboard files one you read there (Setup: Report and fix, then File it).",
    options: { json: JSON_OPT, send: S('<report id>', 'not on the command line any more: the dashboard files a report you read there (FR-017)'), hash: S('<hash>', 'with --send (refused as well)') },
    args: [0, 1],
  },
  fix: {
    group: 'owner',
    lines: [
      ['nextlevel fix <issue> [--local]', 'Claude Code fixes that report (a cloud session; --local: on this PC); once merged, nextlevel tells you, nextlevel update installs it, and the check runs again'],
      ['nextlevel fix', 'how the fixes started here are doing'],
    ],
    options: { local: B('a Claude Code session on this PC instead of the cloud'), json: JSON_OPT },
    args: [0, 1],
  },
  note: {
    group: 'owner',
    lines: [
      ['nextlevel note add "text" [--rule]', 'a note for the orchestrator (--rule: a standing rule); also edit <id> "text", withdraw <id>, off|on <id> (a rule), remove <id>'],
      ['nextlevel note list [--all] [--search S] | seen <id>... | done <id> --reply "one line" [--commit S] [--task T] | decline <id> --reply "why"', "the owner's notes, as the orchestrator reads and answers them", 'orchestrator'],
    ],
    text: 'Any of these takes its text from a file instead: --file <path> (--file - reads stdin). docs/OWNER_NOTES.md is written from the notes: never edit it by hand.',
    options: {
      json: JSON_OPT,
      all: B('list: the handled ones too'),
      search: S('<text>', 'list: only notes with this text'),
      rule: B('add: a standing rule, not a one-time note'),
      file: S('<path>', 'the text from this file in the project (- : from stdin)'),
      reply: S('<text>', 'done, decline: your one-line answer'),
      commit: S('<sha>', 'done: the commit that did it'),
      task: S('<task-id>', 'done: the task that did it'),
    },
    subs: {
      '': { options: ['json', 'all', 'search'], args: [0, 0] },
      list: { options: ['json', 'all', 'search'], args: [0, 0] },
      add: { options: ['rule', 'file', 'json'], args: [0, ANY] },
      edit: { options: ['file', 'json'], args: [1, ANY] },
      withdraw: { options: ['json'], args: [1, 1] },
      off: { options: ['json'], args: [1, 1] },
      on: { options: ['json'], args: [1, 1] },
      remove: { options: ['json'], args: [1, 1] },
      seen: { options: ['json'], args: [1, ANY] },
      done: { options: ['reply', 'file', 'commit', 'task', 'json'], args: [1, 1] },
      decline: { options: ['reply', 'file', 'json'], args: [1, 1] },
    },
  },
  handoff: {
    group: 'owner',
    lines: [
      ['nextlevel handoff done <id> [--reply "..."] | reply <id> "..."', 'a step the team asked you for is done; or answer it'],
      ['nextlevel handoff list [--all] | show <id> | add --file <path> [--task T] | answer <id> --file <path> | seen <id>... | cancel <id> --reply "why"', 'what the team asks the owner for, and its answers on the cards', 'orchestrator'],
    ],
    text: 'Free text comes from a file with --file <path> (on Windows a line break ends a command\'s argument). docs/HANDOFF.md is written from the cards: never edit it by hand. A card that holds a change for your approval is decided on the dashboard only.',
    options: {
      json: JSON_OPT,
      all: B('list: the finished ones too'),
      from: S('<line>', 'show: from this line of a long card'),
      file: S('<path>', 'the text from this file in the project (- : from stdin)'),
      task: S('<task-id>', 'add: the task it is about'),
      where: S('<text>', 'add: which window, panel or file'),
      why: S('<text>', 'add: why the team needs it'),
      reply: S('<text>', 'done, cancel, reply: the words that go with it'),
    },
    subs: {
      '': { options: ['json', 'all'], args: [0, 0] },
      list: { options: ['json', 'all'], args: [0, 0] },
      show: { options: ['from', 'json'], args: [1, 1] },
      add: { options: ['file', 'task', 'where', 'why', 'json'], args: [0, ANY] },
      answer: { options: ['file', 'json'], args: [1, 1], hint: 'answer <id> --file <path>   (write the answer to a file first, for example .nextlevel/answer.md; --file - reads it from stdin. Never the text in the command: on Windows it would end at its first line break.)' },
      seen: { options: ['json'], args: [1, ANY] },
      cancel: { options: ['reply', 'file', 'json'], args: [1, 1] },
      done: { options: ['reply', 'file', 'json'], args: [1, 1] },
      reply: { options: ['reply', 'file', 'json'], args: [1, ANY] },
    },
  },

  // ---------- the orchestrator's ----------
  dispatch: {
    group: 'orchestrator',
    lines: [['nextlevel dispatch <task-id> [--engine agy|codex|claude | --profile P | --fallback] [--model M] [--timeout MIN] [--kind K]', 'hand a task spec (docs/tasks/<task-id>.md) to a worker']],
    options: {
      engine: S('<engine>', 'run it on this engine'),
      profile: S('<profile>', 'run it on this profile of nextlevel.json'),
      fallback: B("run it on the workers' fallback"),
      model: S('<model>', 'the model'),
      timeout: S('<minutes>', 'its time limit'),
      kind: S('<kind>', 'code, review, research, design or map (default: the spec\'s "Kind:")'),
      verify: S('<command>', "a verify command instead of the spec's (may be given more than once)", { multiple: true }),
    },
    args: [1, 1],
  },
  retry: {
    group: 'orchestrator',
    lines: [['nextlevel retry <task-id> --feedback "what to fix" [--fallback | --engine E | --profile P]', 'send a task back to a worker with specific fixes']],
    options: {
      feedback: S('<text>', 'what to fix'),
      engine: S('<engine>', 'run it on this engine'),
      profile: S('<profile>', 'run it on this profile of nextlevel.json'),
      fallback: B("run it on the workers' fallback"),
      model: S('<model>', 'the model'),
      timeout: S('<minutes>', 'its time limit'),
      kind: S('<kind>', 'code, review, research, design or map'),
      verify: S('<command>', "a verify command instead of the spec's (may be given more than once)", { multiple: true }),
    },
    args: [1, 1],
  },
  verify: {
    group: 'orchestrator',
    lines: [['nextlevel verify <name> -- <command>', 'run a heavy check in the main checkout (the setup, from inside Codex: verify doctor -- nextlevel doctor); then wait for it']],
    options: { timeout: S('<minutes>', 'its time limit') },
    args: [1, 1],
    dashdash: 'command',
    check: (a) => (a['--']?.length ? '' : 'give the command after "--": nextlevel verify tests -- npm test'),
  },
  commit: {
    group: 'orchestrator',
    lines: [['nextlevel commit -m "message" [<path>...]', "git writes, done by the hub on every engine (Codex's sandbox can't write .git); no paths: every change"]],
    options: { message: S('<message>', 'the commit message', { short: 'm' }), 'no-wait': B("queue it and don't wait for the result"), minutes: S('<minutes>', 'how long to wait for the hub (default 10)') },
    args: [0, ANY],
    check: (a) => (typeof a.message === 'string' && a.message.trim() ? '' : 'give the commit message: -m "message"'),
  },
  merge: {
    group: 'orchestrator',
    lines: [['nextlevel merge <task-id> [-m "message"]', 'merge task/<task-id> into the base branch']],
    options: { message: S('<message>', 'the merge message', { short: 'm' }), 'no-wait': B("queue it and don't wait for the result"), minutes: S('<minutes>', 'how long to wait for the hub (default 10)') },
    args: [1, 1],
  },
  cleanup: {
    group: 'orchestrator',
    lines: [['nextlevel cleanup <task-id> [--discard]', 'delete a merged task branch (--discard: an abandoned one, and the task is closed)']],
    text: "A task the team won't build is closed with nextlevel close, with the reason; cleanup only deletes a branch.",
    options: { discard: B('delete it although it is not merged'), 'no-wait': B("queue it and don't wait for the result"), minutes: S('<minutes>', 'how long to wait for the hub (default 10)') },
    args: [1, 1],
  },
  close: {
    group: 'orchestrator',
    lines: [['nextlevel close <task-id> --reason "why" | --file <path> [--discard]', "close a task the team won't build (replaced by other tasks, out of scope, the owner's call); the owner may too"]],
    text: [
      'The hub checks the task again and keeps the closure (when, who, why): the Project page shows the task as closed and',
      'leaves it out of "N of M merged". It refuses a task that is queued, running or merged, an unknown id, and one whose',
      "branch has work that isn't merged, unless --discard throws that work away (the branch is deleted in the same job).",
      'Dispatching or retrying a closed task opens it again. The reason is one line (--file <path>: from a file).',
      "The orchestrator's and the owner's: it refuses in a worker's slot, a verify command and a project hook.",
    ].join('\n'),
    options: {
      reason: S('<text>', "one line: why it is closed (replaced by M2-05 and M2-06; out of scope; the owner's note N24)"),
      file: S('<path>', 'the reason from this file in the project (- : from stdin)'),
      discard: B("delete its branch and throw away its work that isn't merged"),
      'no-wait': B("queue it and don't wait for the result"),
      minutes: S('<minutes>', 'how long to wait for the hub (default 10)'),
    },
    args: [1, 1],
    check: (a) => (a.reason !== undefined && a.file !== undefined ? 'give the reason once: --reason or --file' : a.reason === undefined && a.file === undefined ? 'say why: --reason "replaced by M2-05 and M2-06" (or --file <path>)' : ''),
  },
  push: {
    group: 'orchestrator',
    lines: [['nextlevel push <branch> [--from <local branch>]', "push the base branch (or --from's branch) to <branch> on origin, through the hub; a deploy branch waits for the owner's approval"]],
    text: [
      '<branch> is the branch on origin to push to, by its plain name (backup/main, ci/m1-gates): there is no default,',
      'and a name that could reach a branch another way is refused (a leading +, a colon, refs/..., HEAD, a tag, or a',
      "remote's name in front such as origin/). No push is ever forced: when origin's branch has commits the pushed one",
      "doesn't have, the push is refused and says so.",
      '',
      'A deploy branch (deployBranches in nextlevel.json; until it is set, the base branch) is not pushed by this',
      "command: the hub makes a card for the owner, who approves or rejects it on the dashboard, looking at the commits",
      'that would go out. Only that approval pushes, and exactly the commit the card showed.',
      '',
      'Examples:',
      '  nextlevel push backup/main                    the base branch to backup/main on origin',
      '  nextlevel push ci/m1-gates --from ci/m1-gates the local branch ci/m1-gates to ci/m1-gates',
      "  nextlevel push main                           a deploy branch: a card asks the owner; nothing is pushed yet",
      'Then: nextlevel wait <job-id>.',
    ].join('\n'),
    options: { from: S('<local branch>', 'the local branch to push (default: the base branch)') },
    args: [0, 1],
    check: (a) => (a._.length ? '' : 'name the branch on origin to push to (nextlevel push backup/main): there is no default'),
  },
  notify: {
    group: 'orchestrator',
    lines: [['nextlevel notify "title" "message" [default|high]', "message the owner's phone (--file <path>: the message from a file; --now: send at once, without the hub)"]],
    options: { file: S('<path>', 'the message from this file in the project (- : from stdin)'), now: B('send it now, without the hub') },
    args: [1, 3],
  },
  wakeup: {
    group: 'orchestrator',
    lines: [['nextlevel wakeup <minutes> --reason "why" | --file <path>', 'autopilot: a round later, to read something outside the hub (a CI run still in progress)']],
    text: [
      "The orchestrator's only (an autopilot round, or its window): it refuses anywhere else. It waits as long as asked (for",
      'a CI run, about as long as the run usually takes), and at least the shortest wake-up (hub.rounds.wakeMinMinutes in',
      'nextlevel.json, 5 minutes), doubled for each round in a row that found nothing new (5, 10, then 20 minutes). A round',
      'that asks for a wake-up gets no round right after it: the wake-up is its next round (the owner acting or a task',
      'ending start one sooner). One wake-up waits at a time, and a new one replaces it; any round that starts clears it.',
      "Never to wait for the owner: their reply wakes the team anyway. The reason is one line (--file <path>: from a file)."
    ].join('\n'),
    options: { reason: S('<text>', 'one line: what the next round must read, and why'), file: S('<path>', 'the reason from this file in the project (- : from stdin)') },
    args: [1, 1],
    check: (a) => (a.reason !== undefined && a.file !== undefined ? 'give the reason once: --reason or --file' : a.reason === undefined && a.file === undefined ? 'say why: --reason "the CI run of ci/m1 is still running" (or --file <path>)' : ''),
  },
  wait: {
    group: 'orchestrator',
    lines: [['nextlevel wait <job-id> | wait --any [--minutes 5]', 'wait for a job without spending tokens']],
    options: { any: B('until any job finishes'), minutes: S('<minutes>', 'how long at most (default 5)') },
    args: [0, 1],
    check: (a) => (a.any && a._.length ? 'give a job id or --any, not both' : !a.any && !a._.length ? 'give a job id, or --any' : ''),
  },
  status: {
    group: 'orchestrator',
    lines: [['nextlevel status [--json]', 'the hub, autopilot, milestones and jobs']],
    options: { json: JSON_OPT },
    args: [0, 0],
  },
  result: {
    group: 'orchestrator',
    lines: [['nextlevel result <job-id> [--peek] [--from <line>] [--file]', 'a job\'s report, diff stat and logs (marks it reviewed; --peek only looks)']],
    options: { peek: B("only look: it doesn't mark the job reviewed"), from: S('<line>', 'the report from this line (a long one is shown in parts)'), file: B("a design, research or map task's result file") },
    args: [1, 1],
  },

  // ---------- other ----------
  update: {
    group: 'other',
    lines: [['nextlevel update [--to <release>]', "update this PC's nextlevel to the newest release; --to goes to a release (an older one is going back)"]],
    text: [
      "The owner's: it refuses in an agent's session (the orchestrator's window, an autopilot round, a verify command, a",
      "worker's slot). It waits while a hub or a worker runs. A project on a candidate branch (nextlevel channel) moves to",
      "the branch's head; a pinned one stays. Each version goes in a folder of its own, so going back is switching back.",
    ].join('\n'),
    options: { to: S('<release>', 'the release to go to, such as v0.3.0') },
    args: [0, 0],
  },
  channel: {
    group: 'other',
    lines: [['nextlevel channel [release | pin <release> | candidate <branch>]', 'what this project runs: releases (the default), one release, or a branch to try before its release']],
    text: [
      "The owner's: setting it refuses in an agent's session. A candidate runs whatever sessions push to that branch, once",
      'the owner updates: for trying a change (a test project), never for a project whose work matters. Kept outside the',
      'project, in the nextlevel folder (channels.json), so no file in the project decides which code runs.',
    ].join('\n'),
    args: [0, 2],
  },
  version: { group: 'other', lines: [['nextlevel version', "this nextlevel's version and folder"]], args: [0, 0] },
  help: { group: 'other', lines: [['nextlevel help [<command>]', "this list, or a command's usage (the same as nextlevel <command> --help)"]], args: [0, 1] },

  // ---------- started by the hub or the installer, never by hand ----------
  _run: { group: 'internal', lines: [['nextlevel _run <job-id>', "one attempt of a task, in its slot (the hub starts it)"]], args: [1, 1] },
  _orch: { group: 'internal', lines: [['nextlevel _orch [--fallback]', "the interactive orchestrator, in the window nextlevel orchestrator opened"]], options: { fallback: B("on the orchestrator role's fallback") }, args: [0, 0] },
  _cycle: { group: 'internal', lines: [['nextlevel _cycle [--fallback]', 'one autopilot round (the hub starts it)']], options: { fallback: B("on the orchestrator role's fallback") }, args: [0, 0] },
  _guide: { group: 'internal', lines: [['nextlevel _guide [<engine>|<profile>]', 'the setup guide, in the window nextlevel guide opened']], args: [0, 1] },
  _trial: { group: 'internal', lines: [['nextlevel _trial <what>', "the model check's trial before tasks start on Antigravity (the hub starts it, FR-022)"]], args: [1, 1] },
  _locktest: { group: 'internal', lines: [['nextlevel _locktest <what>', "the lock test of a role on Antigravity (the hub starts it)"]], args: [1, 1] },
  _locktry: { group: 'internal', lines: [['nextlevel _locktry <what>', "one session of the lock test, in its own throwaway project (the lock test starts it)"]], args: [1, 1] },
  _update: { group: 'internal', lines: [['nextlevel _update <id>', 'the one-click update itself (the dashboard or nextlevel update starts it)']], args: [1, 1] },
  _releases: { group: 'internal', lines: [['nextlevel _releases', "look for nextlevel releases (the hub and the dashboard start it; it never installs)"]], args: [0, 0] },
  _install: { group: 'internal', lines: [['nextlevel _install', 'puts the nextlevel command on PATH (the installer runs it)']], args: [0, 0] },
};

export const COMMAND_NAMES = Object.keys(COMMANDS);
const HELP_OPTION = { type: 'boolean', short: 'h' };

// Node's words for what is wrong, in ours
function nodeProblem(err, command) {
  const name = String(err.message).match(/'([^']+)'/)?.[1] || '';
  if (err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') return `nextlevel ${command} has no option ${name} (an argument that starts with "-" goes after "--")`;
  return String(err.message).split('\n')[0];
}
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const countText = ([least, most]) =>
  most === 0 ? 'no arguments' : least === most ? plural(least, 'argument') : least === 0 ? `at most ${plural(most, 'argument')}` : most === ANY ? `at least ${plural(least, 'argument')}` : `${least} to ${most} arguments`;

// Reads `argv` (what follows the command's name) as the command's spec says. -> { help: true } when -h or --help is
// there (before any "--", also inside a group of short options: -hm), { error } when something doesn't fit, else
// { args }: { _: its arguments (a subcommand first), '--': what follows "--" for verify, and each option given, by its
// long name }.
export function parseCommand(name, argv = []) {
  const spec = COMMANDS[name];
  if (!spec) return { error: `unknown command "${name}"` };
  argv = argv.map(String);
  const end = argv.indexOf('--');
  const before = end < 0 ? argv : argv.slice(0, end);
  if (before.some((a) => a === '--help' || a === '-h')) return { help: true };
  const options = spec.options || {};
  // An option whose value may be left out (doctor --fix [<id>]): its value, if any, is the argument after it
  const optional = Object.keys(options).filter((k) => options[k].optionalValue);
  const args = argv.flatMap((a, i) => {
    if (end >= 0 && i >= end) return [a];
    const k = optional.find((o) => a.startsWith(`--${o}=`));
    return k ? [`--${k}`, a.slice(k.length + 3)] : [a];
  });
  const nodeOptions = Object.fromEntries(Object.entries(options).map(([k, o]) => [k, { type: o.type, ...(o.short ? { short: o.short } : {}), ...(o.multiple ? { multiple: true } : {}) }]));
  // Help is what the parser reads as help, not only the words above: `commit -hm "x"` is -h and -m "x" (FR-017). Read
  // leniently first, so help wins over anything else wrong with the arguments, as the words do.
  try {
    const loose = parseArgs({ args, options: { ...nodeOptions, help: HELP_OPTION }, strict: false, allowPositionals: true, tokens: true });
    if (loose.tokens.some((t) => t.kind === 'option' && t.name === 'help')) return { help: true };
  } catch {
    // the strict reading below says what is wrong
  }
  let parsed;
  try {
    parsed = parseArgs({ args, options: { ...nodeOptions, help: HELP_OPTION }, strict: true, allowPositionals: true, tokens: true });
  } catch (err) {
    return { error: nodeProblem(err, name) };
  }
  const term = parsed.tokens.find((t) => t.kind === 'option-terminator');
  const positional = (after) => parsed.tokens.filter((t) => t.kind === 'positional' && (term ? (after ? t.index > term.index : t.index < term.index) : !after)).map((t) => t.value);
  const out = { ...parsed.values, _: positional(false) };
  delete out.help;
  if (spec.dashdash === 'command') {
    if (term) out['--'] = positional(true);
  } else out._.push(...positional(true));
  let rest = out._;
  let allowed = Object.keys(options);
  let count = spec.args || [0, 0];
  let what = `nextlevel ${name}`;
  let hint = ''; // a subcommand's own usage line, where it has more to say (handoff answer, FR-014)
  if (spec.subs) {
    const sub = out._[0] ?? '';
    const s = spec.subs[sub];
    if (!s) return { error: `"${sub}" isn't one of nextlevel ${name}'s commands (${Object.keys(spec.subs).filter(Boolean).join(', ')})` };
    rest = out._.slice(1);
    allowed = s.options;
    count = s.args;
    what = `nextlevel ${name}${sub ? ` ${sub}` : ''}`;
    hint = s.hint ? `\nusage: nextlevel ${name} ${s.hint}` : '';
  }
  const used = [...new Set(parsed.tokens.filter((t) => t.kind === 'option').map((t) => t.name))];
  const stray = used.find((o) => !allowed.includes(o));
  if (stray) return { error: `${what} doesn't take --${stray}${hint}` };
  if (rest.length < count[0] || rest.length > count[1]) {
    const extra = rest.length > count[1] ? `: "${rest.slice(count[1]).join('" "')}" is more than it takes` : '';
    return { error: `${what} takes ${countText(count)}${extra}${hint}` };
  }
  const problem = spec.check?.(out);
  if (problem) return { error: problem };
  return { args: out };
}

// The command's arguments as parseCommand reads them; what doesn't fit is a UsageError with the usage. (cli.mjs has
// asked already, so this throws only for a caller inside nextlevel that passes arguments the command doesn't take.)
export function commandArgs(name, argv = []) {
  const r = parseCommand(name, argv);
  if (r.help) throw new UsageError(usageText(name));
  if (r.error) throw new UsageError(`nextlevel ${name}: ${r.error}\n\n${usageText(name)}`);
  return r.args;
}

const pad = (rows, indent = '  ') => {
  const width = Math.min(52, Math.max(...rows.map(([a]) => a.length)) + 2);
  return rows.map(([a, b]) => (b ? (a.length + 2 > width ? `${indent}${a}\n${indent}${''.padEnd(width)}${b}` : `${indent}${a.padEnd(width)}${b}`) : `${indent}${a}`)).join('\n');
};

// What `nextlevel <command> --help` and `nextlevel help <command>` print
export function usageText(name) {
  const spec = COMMANDS[name];
  if (!spec) return '';
  const parts = [`Usage:\n${pad(spec.lines)}`];
  if (spec.text) parts.push(spec.text);
  const opts = Object.entries(spec.options || {}).map(([k, o]) => [`${o.short ? `-${o.short}, ` : ''}--${k}${o.type === 'string' ? ` ${o.arg}` : o.optionalValue ? ` [${o.optionalValue}]` : ''}`, o.help]);
  opts.push(['-h, --help', 'print this, and do nothing else']);
  parts.push(`Options:\n${pad(opts)}`);
  if (spec.group === 'internal') parts.push('nextlevel starts this itself; it is not for typing.');
  return parts.join('\n\n');
}

// What `nextlevel help` prints: every command, by who uses it
export function helpText() {
  // (a line's own group, its third element, before its command's: note and handoff have lines for both sides)
  const rows = (group) => Object.values(COMMANDS).flatMap((c) => c.lines.filter((l) => (l[2] || c.group) === group));
  return [
    'nextlevel: run an AI build team on the project in this folder.',
    '',
    'Usage: nextlevel [--project <folder>] [<command>] [options]',
    'The project is the git repository you are in (its top folder), or the one --project names. Without a command:',
    'the menu (what the project\'s START.cmd opens).',
    '',
    `Owner\n${pad(rows('owner'))}`,
    '',
    `Orchestrator\n${pad(rows('orchestrator'))}`,
    '',
    `Other\n${pad(rows('other'))}`,
    '',
    'Every command takes -h or --help: it prints the command\'s usage and does nothing else (nextlevel help <command>',
    'prints the same). An option a command doesn\'t have, or an argument it doesn\'t take, prints its usage and does',
    'nothing either. Owner commands check for a nextlevel update as they start (never while a hub or worker runs);',
    '--no-update skips that.',
  ].join('\n');
}
