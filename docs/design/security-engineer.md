# The security engineer

A role of its own that finds and confirms security problems in the project's code when the owner asks for a scan, and
never changes the code. Its scans run in OpenAI's Codex Security scanner, in a Docker container, with the owner's
ChatGPT sign-in kept in a volume of its own. This file is the design as built in part 1a-1; the steps after it are at
the end and in `docs/ROADMAP.md`.

## Why a container

On Windows, Codex's own sandbox stops writes and the network but not reads (FR-023), and 0.164.0 doesn't enforce a
permission-profile deny there, elevated or not (Step 0b). A scan reads a whole repository and runs proofs of concept, so
it can't run as the owner's user with the owner's Codex. OpenAI ships the scanner as a container image
(`ghcr.io/openai/codex-security`), whose Codex runs the model's commands in its own Linux sandbox (bubblewrap with a
seccomp profile). Measured on Windows 11 with Docker Desktop (Step 0 and 0b): inside it the sign-in folder is denied and
can't be listed, a planted `auth.json` can't be read, and the network is closed. So the scanner, not the host's Codex or
a plugin, is the one path, and nothing falls back to another.

## What the owner gets in 1a-1

- A **Security engineer** row on the Team page and in `nextlevel team`, off until the owner turns it on, on Codex only.
  `nextlevel team set security --engine codex [--model M] [--effort E] [--daybreak on|off]` checks its five checks
  first and saves only when they pass; without a model it saves the first one the scanner's own Codex lists that
  Daybreak Blue works on (named, never an alias). `--engine off` turns it off.
- `nextlevel security login`, in the owner's own window: OpenAI's device sign-in, inside the scanner, into its sign-in
  volume. It works while the role is off, since turning it on checks the sign-in first.
- `nextlevel security scan [--deep]` (the owner's; it refuses in an agent's session), `nextlevel security stop [<id>]`
  and `nextlevel security status [--json]` (a look command, allowed under `NEXTLEVEL_READ_ONLY=1`).
- The usage ledger and Today get a Security engineer line per scan, with the scanner's own token count.
- The doctor's rows `security.docker`, `security.image`, `security.login`, `security.probe`, `security.daybreak`
  (`docs/CHECKS.md`). Information while the role is off; errors while it is on.

The dashboard's buttons, the Security page and the SECURITY.md card are part 1a-2.

## The image

`src/lib/securityimage.mjs` pins the image by digest, with its version and revision, and the seccomp profile vendored
from that revision (`docker/codex-security-seccomp.json`, Apache-2.0, credited in `NOTICE`, checked by its sha256
before every run). A new image comes only with a nextlevel release, and its probe runs again.

## The volumes (no host folder is writable by the container)

- `nextlevel-sec-state-<project key>` at `/output/.codex-security-state`: the scanner's state.
- `nextlevel-sec-login-<account key>` at the state's `codex-home`: the sign-in. The account key is a hash of the
  profile's name, so a second account is a volume of its own; it carries no project label, since one sign-in serves
  every project.
- `nextlevel-sec-out-<scan id>` at `/output/scan`: one scan's output, removed after it is copied out. A hub that starts
  removes any left behind.

Each has the labels `nextlevel.kind` and `nextlevel.project`, and a volume that exists with another kind is refused.
Before each run a helper container of the same image (`--user 0:0`, every capability dropped but CHOWN and FOWNER,
`no-new-privileges`, `--network none`, only those volumes, no shell: the image's chown and chmod) makes them
`10001:10001` with mode 700, and `stat` checks it. Docker Desktop's VM refuses the chown under the vendored profile on
some PCs ("operation not permitted"): then the helper runs with Docker's default profile, which nothing else does.

## The probe (a gate kept by image digest)

Model-free, before any scan with an image: Codex's sandbox must start inside the container (`codex sandbox
/usr/bin/true`), then, against a throwaway sign-in volume with a planted `auth.json`, a permission profile that denies
the sign-in folder answers exactly `login-denied`, `login-not-listable`, `authfile-denied` and `net-closed`. Any other
answer stops every scan with that image; the doctor's `security.probe` keeps the verdict for the digest (a fresh doctor
run asks again). A volume or Docker problem on the way isn't kept: it is asked again next time.

## A scan

The owner's request goes into the guard's folder (`~/.nextlevel/guard/<project>/security-requests/`), which no agent
sandbox writes; the hub reads it at its next look and starts `_scan` as a child process of its own. A scan is not a
job: nothing in `queue/` or `jobs/`, and its end starts no autopilot round (FR-019). An update's hold starts none, the
updater waits for a running one, and the hub doesn't exit while one runs.

In order, stopping at the first thing it can't trust (each stop is `couldn't run` with its reason, and no scan
container starts):

1. **One scan at a time on the PC:** a lease in `~/.nextlevel/security-lease.json`, its holder told by pid and start
   time. A scan in another project waits, and says for which.
2. Docker answers, with Linux containers and its API not exposed on TCP 2375 (Docker Desktop's setting read for that
   key only); the seccomp file's hash; the image.
3. The probe's verdict for the image (above), run now when none is kept.
4. The model and Daybreak, from the scanner's own `codex debug models`.
5. **The checkout:** `<project>.slots/security`, a clone with `--no-hardlinks` of the base branch's tip (never a
   worker's slot or the project's folder), without a remote, hooks and maintenance off, cleaned and checked out
   detached at exactly that commit. A tracked file that looks like a secrets file (`.env`, `.env.local`, `prod.env`;
   not `.env.example`) stops the scan without opening it. Every file that steers an AI engine (the guard's list at any
   depth, `SECURITY.md` included) is set aside as a plain-text copy the scan reads as data, and links are removed (the
   link, never its target). The checkout is mounted read-only.
6. The volumes, the sign-in (by its files' names, never read), their owner and mode.
7. The role doc, from the base branch's `docs/agents/SECURITY-ENGINEER.md` (else the template's), in a read-only
   knowledge-base folder, passed with `--scan-prompt-file`.
8. **A dry run** of exactly the scan's command, in an output volume of its own: the scanner must accept web search off
   and approvals `never`.
9. **The scan:** `scan /input/repository --output-dir /output/scan --headless --auth chatgpt --mode standard|deep
   --model M --effort E [--cyber-access-program daybreak_blue --codex daybreak=true] --codex approval_policy="never"
   --codex web_search="disabled" --scan-prompt-file /input/kb/role.md --max-time N`, with a memory limit (half the
   PC's memory, between 2 and 8 GB), the seccomp profile, `no-new-privileges`, and `host.docker.internal` and
   `gateway.docker.internal` pointed nowhere (a name change, not a wall: the host stays reachable at its address,
   KNOWN_ISSUES). The hub follows it: the owner's stop or the time limit (the scan's minutes plus five) stops it.
10. **The copy-out:** from a container that is created and never started, mounting the output volume read-only, one
    `docker cp` per file: the manifest first, then exactly the files it lists and the report, threat model and
    coverage. Each must be a plain file (not a link), at most 16 MB (64 MB in all), its name at most two folders deep
    and safe on Windows, and its hash the manifest's. The manifest must say the scan completed and was sealed when it
    ended.
11. **The findings** (`src/lib/findings.mjs`, pure): each field shape-checked, paths kept inside the checkout, text
    redacted like a report (the `.env` values) with control and bidirectional characters dropped, sorted by severity.
    A finding reads "Codex Security reproduced it" only when its validation record says so in its status or result
    fields, never from free text; "validated by source" for the scanner's other confirmations. The hub writes
    `findings.json` and a record in the guard's folder with the files' hashes: a findings file that no longer matches
    it isn't trusted or shown.
12. The tokens from the scanner's own TOKENS line go into the usage ledger.

Ends: `done` (trusted), `failed` (the output didn't hold), `couldn't run` (a stop rule, or the scanner's own error with
its last lines, redacted), `stopped` (the owner's stop, marked partial). A scan never runs again by itself. Whatever
ends, its containers and its output volume are removed and the lease is given back.

## What stays open (KNOWN_ISSUES)

- Anything on the PC that can run `docker` can mount the sign-in volume and read the sign-in, a Codex worker out of its
  sandbox included. Extra layers only: a Claude Code worker is told not to run a command naming `nextlevel-sec-`, every
  worker's log is read for one after its attempt (a Home card), and the Team row says so.
- The scanner's own process can reach programs listening on the PC's 127.0.0.1.
- Daybreak Blue is asked for, not confirmed by the scanner's output.
- A repository written to fool the scanner can still hide a finding: bars, not walls.

## After 1a-1

- **1a-2, on the dashboard:** Home's Security tile and buttons, the Security page, the SECURITY.md card (a policy only
  the owner's Approve makes count, then passed as `--knowledge-base`).
- **1b:** a Claude Code version, the Daybreak model watch, SECURITY.md committed to the repository.
- **2:** findings in autopilot rounds, a merge gate, the fix loop, dismissing a finding.
- **3:** supply chain, automatic scans, phone alerts.
