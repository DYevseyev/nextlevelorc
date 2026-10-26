// Files nextlevel has put into projects (templates/project/), recognised by their sha-256: text with LF
// line ends, without a byte-order mark or trailing space. A file with one of these hashes has nothing of
// the owner's in it.
import { createHash } from 'node:crypto';

export const templateHash = (text) => createHash('sha256').update(String(text).replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\s+$/, '')).digest('hex');

// Role docs from an older nextlevel, unchanged: init copied them into the project, so an update of the
// tool doesn't reach them (project.role-docs). Those before FR-004 told the orchestrator to run git itself
// (which Codex's sandbox refuses) and the guide to trust a doctor run inside that sandbox; those before M6
// knew only Codex and Antigravity, and escalated to Codex rather than the workers' fallback; those before
// FR-008 didn't say that the hub merges the base branch in and commits for a worker whose sandbox can't
// write git, and let the orchestrator name an engine for the escalation; those before M10 had the orchestrator
// edit docs/OWNER_NOTES.md and docs/HANDOFF.md by hand (now: nextlevel note, nextlevel handoff), the worker keep
// no progress notes, and the guide send the owner to the notes file; the orchestrator's before M11 kept no
// docs/PROJECT.md, no plan header (Outcome, Acceptance, Try it) and no labeled Blockers for the Project page; the
// orchestrator's and the worker's before the guard didn't say which files are protected (a task can't own one, a
// change to one waits for the owner's approval) or that no value from .env goes into a file; those of the guard's
// first part said nothing of git's own settings and hooks, whose change stops all git work; those before FR-012 put
// a design's whole result in the worker's report (which `nextlevel result` shortened), kept a log of every round in
// docs/DECISIONS.md, and let the orchestrator ask workers for remote scans their unpublished branches can't have; and
// the orchestrator's before FR-014 put a request's text in the command (on Windows nextlevel.cmd ends it at its first
// line break) and couldn't answer the owner on a card (nextlevel handoff answer --file); and all three before FR-015
// said nothing against running a command to learn what it does (`nextlevel push --help` pushed main and deployed
// production), and the orchestrator's knew only `nextlevel push`, with no branch and no approval for a deploy branch;
// and the orchestrator's before FR-017 didn't say that a verify command can't push or write to GitHub, or how CI is
// read through verify with the owner's read-only token; and the orchestrator's before FR-016 named no exact plan path
// and no "Milestone:" line, by which the Project page finds a milestone's plan; and the orchestrator's before FR-019 had
// every autopilot round end with a commit (on 4 October a real project's rounds committed a STATUS.md note each, for twelve
// hours, while the team waited for the owner), knew no wake-up, and didn't say what starts the next round; and the
// orchestrator's before FR-020 judged the whole branch's commits rather than the attempt's own, said nothing of an
// attempt finished without a report or of why a report is missing, and didn't say which attempts count toward the
// fallback (a real project's task reached attempt 13, its review rounds all retries of one task); and the
// orchestrator's before FR-021 had no way to close a task it won't build (a real project's orchestrator closed five at the owner's
// word by writing "closed" in their specs, and the Project page counted them as planned); and the orchestrator's before
// Codex workers' part B knew no second worker and no "Needs:" line, and told it never to pick an engine itself; and the
// orchestrator's before handoff close (FR-018) knew only cancel, and nothing of a reopened card.
export const OLD_TEMPLATES = {
  'docs/agents/ORCHESTRATOR.md': [
    'bb38c3a0a3ed60ea7e5cfa9d41bca9765be25ee1dc67223ff1d724b85fa30be5', // M1
    'f2326ba1006fc8d16cdcfd9cda5a96952d7ab338f58508f8796303cb5743d4a2', // FR-004 (Codex only)
    '0382e6b46e62193530cadf31a78fbe41cb432c4a59b43c9ea43e5d57f576191e', // M6
    'a500fe1a7a463e9c5ace7911ac3a56331d70b21a5751e7fdfc02c95c8c6c1912', // FR-008 (notes and handoff edited by hand)
    '71ecc2fd941cb4f0d619963ee0b20c98fffa254f83c887da3710f8edc6c96fd4', // M10 (no project page, plan header or labeled blockers)
    '230b8c997b447d136e51c511762c8f0a3894dcd3e9fbfc4830dcf50a3334673c', // M11 (no protected files)
    '416d5fcdb7e3dacf723ea43bdad634e3e4deb789a257902c27fc22e0a3dee0b3', // the guard, part 1 (nothing on git's own settings)
    'bfb63ec1c958da1ffd76c32fd08d44bc7cf0b2a8184466121b6b78334a8d08a1', // the guard, part 2 (no result files, a round log in DECISIONS)
    '8176ce232d3b2afc2979ea2b2114bf10379553ff9f70b19f99f0f9c55700fc03', // FR-012 (text in the command, no answers on the cards)
    'e53bc600e6a05a177bd0cac09ed7ad22c9237fbc2ad47c19ab5eef8b86ea7a9e', // FR-014 (push with no branch; commands tried to learn them)
    'ee788795255c3b87449555f3f5c98f42bbe609415761d7dc51559202085aeb2e', // FR-015 (verify's pushes and CI reads unsaid)
    '76eb0b24f3d2ff411c71708ba6f0cf172bc9970860b3a08647dcb76a9d45e3ee', // FR-017 (no plan path or Milestone line)
    '6f335c1c79c2760ab5edf3e416ee3bab772cfd724a1017adce522fe22448c2ea', // FR-016 (a commit every round, no wake-ups)
    '21763bc62c57fafd32d6f1bb07b9de2774d37461bab73a6339192d5e76b55acc', // FR-019 (tasks closed only in the docs; the branch's commits judged)
    '98ab2efce5a20cf229bd388dc0b5002e9d81bf672a5ae44716e3eef88a2965b1', // FR-021 (the branch's commits judged, a missing report a reason to retry)
    'e8f15cab01b9efd38acc151be25b4dec427fcd06115f5fce14ad61dbcef029b3', // FR-020 (a push that changes a protected file unsaid)
    'c7a340293bdfc33d61b4f31b10f811bbc69a81acc60829f0e70f6900e4b3ca73', // the push guard, #37 (no second worker, no Needs: lines)
    '14d6eb904a5685f77c6ac6b311ee8c4049dedb619b9f1494bd9a8ff96889de0a', // Codex workers' part B (the first public version reworded one example)
    '34846aac319924a1dc8809377c681b7ef56491c2967c4f637de7dc04ff90dde7', // the public versions to v0.2.0 (only cancel, no reopened cards)
    '956e92c57485776bf476b13a5a7b93a168f841f079a02e81808e1b268df585f1', // the handoff cards (AGENTS.override.md and SECURITY.md not protected)
  ],
  'docs/agents/WORKER.md': [
    '76eb1176642564d6e2612d232aacc0433041ad191327f2b69809251e29923d21', // M1
    '501c549e48e94f66753e3c9e50fdac422ec319b08ed80c8c288e01cb95833364', // FR-003 (a worker always commits and merges itself)
    '55ca2b539bd2ff7e6225a3202245ddc3b65e3f436acd18cff6d8f65000c299ec', // FR-008 (no progress notes)
    'db74233e8173778d086ea2c95f20a5e4fb38e0b995323a82b7dce57bcc0ac880', // M10 (no protected files)
    '8cf935558e2c0ec5d2a96dd583702b15e1555699dfaf3b3c8af19f97367155a3', // the guard, part 1 (nothing on git's own settings)
    'a4def5a456bf1e0ef1f227b6792b8cda30412aa8ee98c80f0ba5da32de1a5102', // the guard, part 2 (the result in the report, remote scans)
    '3aa6e303e12a4afb01f923d38832b3f30bb6a4f9d79e61a81cb438b044bdff99', // FR-012 (commands tried to learn what they do)
    '374366b1fdab5b5ccfb22f8596ba9a93223d1ecd8fedea2d2c099857e925f97e', // before the security engineer (AGENTS.override.md and SECURITY.md not protected)
  ],
  // The security engineer's role doc (docs/design/security-engineer.md): new with the role, none older yet
  'docs/agents/SECURITY-ENGINEER.md': [],
  'docs/agents/GUIDE.md': [
    '76afcf14de37fff5be0cd96c6014dee1438e2d41218b3ef228238bd0ada893e1', // M1
    '9f7572386463ff7107a71b495575a7f8046d207fd5be1408352cfc8333615ded', // FR-003
    'c0cfa8e016ae069def920cc3f6ebe4205642399d72020825b01b51cd9dcc2523', // M2
    '7b309aa9aa24514e4f6af4de8a10cb75dc198362ae7b4129e5b700d71e8e1f50', // M4
    '248f5c53bc90d4bcfff12b96480b2a2a254a7e302095066b9b929f97c616340a', // FR-004 (Codex and Antigravity only)
    'eb5b1588e7b0c99b4d5ab3699bb0fecb91ef1158832eb73d477a7b452d8d6ca5', // M9 (the owner steers by editing the notes file)
    '9d1d67c64bf493cdffcea887aff48f2406e13ae769c434676b39dd7501f4a2c3', // M10 (commands tried to learn what they do)
  ],
  // The other templates init offers (safe updates, point 4: the one-click update refreshes these too when unedited; the
  // seeds and an edited .env.example stay the project's). From this repository's history.
  'AGENTS.md': [
    'eede4d7e24fbbc9c93929b8c44e9d966657cf9267429589da05e209401823b36', // the original kit
    '021dabc993a7ce63565863e4799453a25ef9a59f0fdf34f354bcdbff312a6ea4', // M1
  ],
  'docs/tasks/_TEMPLATE.md': [
    '9d1308636d541e5ed2bc0d8131bb4511072b432cf3d65f301a68d84e05e8b300', // the original kit
    'beb096b6986c5125513c551117823f83d970385660c9b814cd2bf39d71bfc7f5', // M1
    '2229690b01773e56dc758d4539e0f68039d2905c93bada55064f2c2a2c353b11', // FR-012 (no Needs: line)
  ],
  // (START.cmd is replaced only while no cmd.exe runs it: the update looks for one first)
  'START.cmd': [
    '818654fad652d3b26a529850b2ce5dc85da4d78395b86e9e5cc8c726b21d368e', // the original kit
    '362067f66335c45b8e48b07bed189439675789b25d8eb7076d2f022db4f051a9', // M1
    '61b2bd48e7e15f1a0dad6104c36a5196cb9c3c19785a355f43af76aad4cc6354', // M3
    '63d7e1c894cfcab46e12da69e6acb668a022c9c5f38725ff08b653b25e63c6c6', // M3, naming the public repository (test/fixtures/START-M3.cmd)
    '6655326a9d917df1b0579d56c9b7ab2484e666e3e959473e1a34ffae9e1d9339', // safe updates (installed from the private repository)
  ],
};

// Every .env.example nextlevel has shipped, the current one included (a test checks that it is here).
// A project adds its own keys to that file; once it differs from all of these it is the project's own,
// and init never offers to replace it (FR-005). Add the new hash here when the template changes.
export const ENV_EXAMPLE_TEMPLATES = [
  '3fba9f437e29b051ae73c72a1653315281916ee80d242f6e37be760e4f64d532', // the first kit's, before nextlevel.json (test/fixtures/env.example-kit)
  'ce72ecd4d73a2ff3d2e7c86a3cdd8350491c07e91f49ca7c053d31244c6fe329', // M1 (current)
];
export const isEnvExampleTemplate = (text) => text !== null && text !== undefined && ENV_EXAMPLE_TEMPLATES.includes(templateHash(text));
