# M0 - Foundation

Outcome: The foundation runs, with the recipe store's tests passing on main on Windows and Linux.

Acceptance:
- The recipe store's test suite passes against main on Windows and Linux; Linux runs the POSIX cases.
- Main passes the foundation checks and CI is green for the published candidate.
- One final review, M0-06-review, confirms these gates.

Try-it:
1. In PowerShell at the main checkout, run `nextlevel verify m0-local -- pnpm verify:m0`, then `nextlevel wait` and `nextlevel result` with the job id it returns. Expect the foundation checks to pass.
2. In the hub, open the Windows check and the Linux evidence. Expect the suite to pass on both.
3. Open http://localhost:5173/healthz and http://localhost:5174/healthz: both report healthy.

## Authority and working rules

Merge a task when it delivers its scope and passes hub verification.

## Tasks and order

1. M0-01-workspace-db, then M0-02-app-health.
