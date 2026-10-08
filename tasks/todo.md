# #351 [P1.13] Agent loop: verdict evaluation

The issue body points at the private backlog (not on this box). Criteria below are derived
from reading `src/agent-loop.ts`; the PR lists them for checking against the backlog's P1.13.

## Problem (src/agent-loop.ts)
`goalMet` is the latest turn's assertions, and it survives every action that runs after them:
- **Across turns:** turn 1 `[click, assert "Welcome"]` passes; turns 2..8 click on without
  asserting; the run ends `max_turns` with `goalMet: true`, and `iris run --agent` reports
  `status: success` for a page nobody checked.
- **Within a turn:** `[assert "Welcome", navigate /logout]` reports `goalMet: true` for the
  page *before* the navigation.
- **Abnormal exits:** `[assert ok, click x3 failing]` exits `consecutive_failures` with
  `goalMet: true` (a test pinned this).

## Plan (TDD)
1. A verdict covers the page only until the agent acts again. An *executed* non-assert
   action (success or failure: a failed click may still have been dispatched) clears the
   turn's assertions; a policy-refused action never ran, so it does not.
2. At the end of a turn (and on the consecutive-failures exit): assertions left -> `goalMet`
   is their AND; none left but the turn acted -> `null` (unverified); neither -> unchanged.
3. Tests (real Chromium, scripted model): stale across turns -> `null` + `max_turns`;
   assert-then-act in one turn -> `null`; act-then-assert -> `true`; refused action after a
   passing assert keeps `true`; the consecutive-failures case -> `null` (test updated: it
   pinned the stale verdict).
4. CLI: "Goal unverified" message names the new cause; `status` logic unchanged (it reads
   `goalMet !== true`). README `goalMet` / `--agent` paragraphs; CLAUDE.md note.

## Not in scope
- One-shot `iris run` computes `goalMet` from every assert in the plan (src/cli.ts); same
  shape of question, different contract (plan 013). Filed as follow-up if needed.
- Assertion strength (substring `url_matches`, 1 s `element_absent` grace) is executor
  semantics, not the loop's verdict.
