# <task-id> — <short title>

Kind: code
Milestone: M<n>
Needs: none
<!-- Kind: code, review, research, design or map. A design, research or map task also names the file its result
     goes in, on a line of its own here: Result file: docs/design/<task-id>.md (under docs/, never a protected path;
     list it under "Files owned" too). The hub checks that it is committed on the task's branch and not empty.
     Needs: what the task needs from the worker that runs it: docker (a stack, compose, an integration check with
     containers), packages (pnpm or npm installs), network; several with commas (Needs: docker, packages), or none.
     The hub refuses to send it to a worker that can't give it, and says which can.
     Acceptance: docs/acceptance/<plan>.yaml on <env>, on a line of its own here, when nextlevel's tester is on: the
     hub runs that plan after the task is merged and deployed to the environment, and a card with the plan follows the
     result. -->


## Goal
<One paragraph: what must be true when this task is done.>

## Context
- BRIEF.md: <sections or requirement ids, e.g. R3>
- Builds on: <earlier tasks or existing modules>

## Files owned
<Exact paths or globs this task may create or change. Nothing else.>

## Interfaces and contracts
<Types, function signatures, API routes, message formats, env vars and ports that other tasks rely
on. Be exact: parallel workers build against these.>

## Acceptance
- [ ] <Observable behavior, each one testable>

## Verify
```sh
<one command per line; the hub runs them in the worker's slot after the worker finishes>
```

## Out of scope
<What not to do in this task.>
