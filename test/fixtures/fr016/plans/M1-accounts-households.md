# M1 - Accounts and households

Outcome: A cook can create and verify an account, sign in with an optional second factor, invite the rest of the household, and keep each household's recipes private.

Acceptance: R1 and the R14 basics of BRIEF.md. Real Postgres integration and the browser journeys use Mailpit; cross-household, role, CSRF and second-factor tests pass.

Try it (accepted local flow; production signup also confirmed by the owner):
1. In PowerShell at the project root, run `pnpm stack:up`.
2. Open http://localhost:5173/signup, sign up with a test address and follow the emailed link.
3. Sign in at http://localhost:5173/login; expect the Recipes page of the new household.

These addresses are GET pages; the forms POST to the same paths.

## Closure (2026-09-29)

M1 meets the Acceptance above.

## Tasks and order

### Current implementation sequence (2026-09-28)
- M1-18 web sessions, then M1-21 mail.
