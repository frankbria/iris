# Plan 006: Reconcile docs with reality and remove dead doc/test artifacts

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. When done, update
> this plan's status row in `plans/README.md` unless a reviewer told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 65633a6..HEAD -- README.md CLAUDE.md`
> If either changed since this plan was written, re-grep for the claim lines in
> "Current state" before editing; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2 (`[P2.2]`)
- **Effort**: S–M
- **Risk**: LOW
- **Depends on**: ideally runs AFTER 002 and 004 (so the "tests pass" claims you
  write are actually true); can be done independently if you state current numbers
- **Category**: docs / tech-debt
- **Planned at**: commit `65633a6`, 2026-06-21
- **Issue**: https://github.com/frankbria/iris/issues/6

## Why this matters

The docs assert a status the code does not support. README says "Phase 2 …
(COMPLETE)", "Production-ready with 95.9% test pass rate", "541/564 tests
passing"; CLAUDE.md says "100% passing" and "85% coverage". The actual suite at
this commit is **532 passing, 2 failing, 22 skipped (556 total)**, the 80%
coverage threshold isn't enforced (tests run without `--coverage`), and several
exported a11y helpers throw "not yet implemented". For an AI-assisted project,
false status is actively harmful — agents read these files as ground truth and
act on them. There is also dead weight: an 800-line `.old` test file and ~40
overlapping status/summary docs. This plan makes the top-level docs honest and
removes the clearly-dead artifacts.

## Current state

False/stale claims to correct (verified at `65633a6`):

`README.md`:
- L25: `### ✅ Phase 2 - Visual Regression & Accessibility (COMPLETE)`
- L27: `**Status:** Production-ready with 95.9% test pass rate ...`
- L59 / L396: `Test Results: 541/564 tests passing (95.9% pass rate)`
- L453: `### Phase 2 Visual & Accessibility (100% Complete)`
- L550: `### Phase 2 ✅ (COMPLETE - October 2025)`
- L733-734: `Phase 2: ✅ Complete (production-ready)` / `Tests: 541/564 passing (95.9%)`

`CLAUDE.md`:
- L109: `✅ Comprehensive test suite (45 tests, 100% passing)`
- L212 / L296: `85% code coverage ratio required` / `Code coverage meets 85% minimum threshold`

Dead artifacts:
- `__tests__/visual/ai-classifier.test.ts.old` (~800 lines, excluded from Jest
  via `testMatch`, superseded by `__tests__/visual/ai-classifier-refactored.test.ts`).
- ~40 markdown files in `docs/` plus `plan/`, many `*_SUMMARY.md` /
  `*_completion_report.md` / refactor-notes that overlap and conflict on status
  (e.g. `IRIS_PROJECT_ASSESSMENT_REPORT.md`, `docs/phase2b_completion_report.md`,
  `plan/phase2_completion_report.md`).

Actual current suite (run it yourself to get live numbers before writing them):
`npx jest 2>&1 | tail -5`.

## Commands you will need

| Purpose      | Command                          | Expected on success           |
|--------------|----------------------------------|-------------------------------|
| Live test #  | `npx jest 2>&1 \| tail -5`        | the numbers you'll write down |
| Coverage #   | `npx jest --coverage 2>&1 \| tail -25` | real coverage table (for honest %) |
| Find claims  | `grep -n "95.9\|COMPLETE\|production-ready\|100% passing\|541/564" README.md CLAUDE.md` | the lines to fix |
| Confirm .old excluded | `npx jest --listTests \| grep -c "\.old"` | `0` |

## Scope

**In scope**:
- `README.md` — status/coverage/pass-rate claims only
- `CLAUDE.md` — the "100% passing" and "85% coverage" claims (state actual, or
  reframe as a target with current actual noted)
- Delete `__tests__/visual/ai-classifier.test.ts.old`
- Create `docs/archive/` and move completed-phase status reports / summaries into
  it (a `git mv`, not deletion — preserve history)

**Out of scope** (do NOT touch):
- Rewriting the substance of architecture docs (`tech_specs.md`, `prd.md`,
  `dev_plan.md`) — only fix provably-wrong status lines.
- The `src/a11y/index.ts` stubs themselves (decision/wiring is a direction item;
  here you may only update *docs* that overclaim they work).
- Any code file other than deleting the `.old` test.

## Git workflow

- Branch: `improve/006-docs-reality-sync`
- Commit style: `docs: correct test/coverage status claims` and
  `chore: archive completed status docs and remove dead .old test`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Capture the real numbers

Run `npx jest 2>&1 | tail -5` and `npx jest --coverage 2>&1 | tail -25`. Record
the actual passed/failed/skipped counts and the real global coverage percentages.
Use these exact numbers in the doc edits. (If you are running this plan AFTER
plans 002 and 004 landed, the numbers will be better — use whatever is live.)

### Step 2: Correct README status claims

Replace each overclaiming line with the live truth. Suggested framing (adapt to
real numbers):
- "Phase 2 (COMPLETE)" → "Phase 2 — Visual Regression in place; Accessibility
  runner functional, integration ongoing".
- "Production-ready with 95.9% pass rate" → "<X>/<Y> tests passing, <Z> skipped
  (see ROADMAP/known-issues)".
- Remove "(100% Complete)" / "production-ready" where the feature has stubs.

**Verify**: `grep -n "95.9\|541/564\|production-ready\|100% Complete" README.md`
returns nothing (or only inside a clearly-labeled historical changelog entry).

### Step 3: Correct CLAUDE.md claims

- L109 "100% passing" → state the actual current result, or scope it to the
  specific 45-test subphase suite if that subset genuinely passes (verify before
  asserting).
- L212/L296: keep 85% as a *target* but add the live actual coverage so the gap
  is visible, e.g. "Target: 85%. Current: <real>%." Do not claim it is met if it
  is not.

### Step 4: Remove the dead `.old` test

`git rm __tests__/visual/ai-classifier.test.ts.old`. Before removing, confirm the
refactored suite covers the same surface:
`npx jest __tests__/visual/ai-classifier-refactored.test.ts` → passes.

**Verify**: `npx jest --listTests | grep -c "\.old"` → `0`; full suite still runs
with the same counts as Step 1 (deleting an excluded file changes nothing).

### Step 5: Archive completed status-doc sprawl

Create `docs/archive/`. `git mv` the clearly-completed, superseded status docs
into it (the `*_completion_report.md`, `*_SUMMARY.md`, `IRIS_PROJECT_ASSESSMENT_REPORT.md`,
phase-by-phase reports). Leave living docs (`README.md`, `CLAUDE.md`,
`AGENT_INSTRUCTIONS.md`, `prd.md`, `tech_specs.md`, `dev_plan.md`, the current
roadmap) in place. Add a one-line `docs/archive/README.md` saying these are
point-in-time historical reports, not current status.

Do NOT delete — `git mv` preserves history and avoids losing information.

**Verify**: `ls docs/archive/ | wc -l` ≥ 5; `git status` shows renames, not
deletes, for the moved files.

## Test plan

This is a docs/cleanup plan; the "test" is that the suite is unaffected and the
claims match live output:
- `npx jest 2>&1 | tail -5` → identical counts before and after (you only removed
  an already-excluded file).
- No source behavior changes.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `grep -n "95.9\|541/564\|production-ready" README.md` returns nothing outside a labeled changelog
- [ ] README/CLAUDE.md pass-rate and coverage numbers match live `npx jest` / `--coverage` output
- [ ] `__tests__/visual/ai-classifier.test.ts.old` no longer exists
- [ ] `npx jest` counts unchanged from Step 1 baseline
- [ ] `docs/archive/` exists with the moved reports (renames in `git status`)
- [ ] No source files modified except the `.old` deletion
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- You cannot determine which docs are "completed/superseded" vs "living" with
  confidence — list them and ask rather than archiving something still in use.
- The refactored ai-classifier suite does NOT cover what the `.old` file did
  (some unique test case exists only in `.old`) — STOP; porting that case is a
  separate decision, do not silently drop coverage.
- A "false" claim turns out to be true for a narrower scope you hadn't run —
  verify with the actual command before rewriting it.

## Maintenance notes

- Going forward, a single `docs/ROADMAP.md` (or the existing
  `docs/phase2c_roadmap.md`) should be the one status source; CLAUDE.md should
  point to it rather than restating status that drifts.
- A reviewer should confirm no *substantive* architecture doc was archived, only
  point-in-time status reports.
