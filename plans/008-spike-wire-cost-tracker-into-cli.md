# Plan 008: Spike — surface the built-but-unused cost/cache infra in the `visual-diff` CLI

> **Executor instructions**: This is a DESIGN/SPIKE plan, not a build-everything
> plan. Your deliverable is a short design note plus a minimal working
> proof-of-concept behind a flag — NOT a finished feature. Follow the steps, run
> the verification commands, and STOP at the boundaries. When done, update this
> plan's status row in `plans/README.md` unless a reviewer told you they maintain
> the index.
>
> **Drift check (run first)**: `git diff --stat 65633a6..HEAD -- src/visual/visual-runner.ts src/visual/ai-classifier.ts src/cli.ts src/ai-client/cost-tracker.ts`
> If any changed since this plan was written, re-read them before proceeding; on
> a major mismatch with "Current state", treat it as a STOP condition.

## Status

- **Priority**: P3 (`[P3.1]`)
- **Effort**: M (spike-scoped)
- **Risk**: LOW
- **Depends on**: 002 (uses the same runner path) and 007 (classifier close) are
  recommended to land first to avoid edit collisions
- **Category**: direction
- **Planned at**: commit `65633a6`, 2026-06-21
- **Issue**: https://github.com/frankbria/iris/issues/8

## Why this matters

The project ships a complete, tested AI-cost-and-cache subsystem
(`src/ai-client/cost-tracker.ts` — budget enforcement, circuit breaker, alert
thresholds; `src/ai-client/cache.ts` — LRU+SQLite), and README advertises "✅
Cost tracking with budget management." But the `visual-diff` CLI never surfaces
it: a user running AI-backed visual diffs sees no spend, gets no budget cap, and
can't set a threshold. The infra is one integration away from being a real,
differentiating feature. This spike answers *how cheaply* it can be wired in and
produces a minimal proof, so the maintainer can decide whether to invest in the
full feature.

## Current state (facts the spike starts from)

- `src/visual/ai-classifier.ts:91` holds `private smartClient: SmartAIVisionClient`,
  and exposes `getCostStats()` (line ~463) and `getCacheStats()` (line ~456) that
  delegate to the smart client. So **cost/cache stats are already reachable** from
  the classifier the runner uses.
- `src/ai-client/cost-tracker.ts` provides budget config, `close()` (line 398),
  and real-time cost accounting; it is wired into `SmartAIVisionClient` via
  `SmartClientConfig.costConfig`.
- `src/visual/visual-runner.ts:103` owns `aiClassifier?` and instantiates it at
  line ~117 when semantic analysis is enabled.
- `src/cli.ts:189` defines the `.command('visual-diff')`. It currently exposes no
  `--budget-*` / cost options.
- `VisualTestResult` (the runner's return type) does not currently carry a cost
  summary.

## Commands you will need

| Purpose   | Command                                          | Expected on success |
|-----------|--------------------------------------------------|---------------------|
| Install   | `npm install`                                    | exit 0              |
| Typecheck | `npx tsc --noEmit`                               | exit 0, no output   |
| Runner tests | `npx jest __tests__/visual/visual-runner.test.ts` | all pass        |
| CLI tests | `npx jest __tests__/cli.test.ts __tests__/visual-cli.test.ts` | all pass |

## Scope

**In scope (spike)**:
- A new design note: `plans/notes/008-cost-tracker-integration.md` (you create it)
- A minimal PoC: thread the existing `getCostStats()` from the classifier up
  through `VisualTestRunner.run()`'s result and print a one-line cost summary at
  the end of a `visual-diff` run, behind an opt-in `--show-cost` flag.

**Out of scope (defer to the real feature, document in the note)**:
- Budget *enforcement* / circuit-breaker wired to a non-zero exit code.
- New CLI flags beyond a single read-only `--show-cost`.
- Any change to `cost-tracker.ts` / `cache.ts` internals.
- Per-image cost breakdowns, JSON report fields, dashboards.

## Git workflow

- Branch: `improve/008-spike-cost-tracker`
- Commit style: `feat(visual): spike read-only AI cost summary behind --show-cost`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Write the design note first

Create `plans/notes/008-cost-tracker-integration.md` answering:
- Where does cost data already exist and how is it reached? (classifier
  `getCostStats()` → smartClient → costTracker.)
- What is the smallest change to show it to the user? (the PoC below.)
- What would the *full* feature need? (budget cap → exit code, `--budget-limit`,
  `--cost-threshold`, cost in JSON/JUnit reports, surfacing cache hit-rate.)
- Open questions for the maintainer (default budget? fail-the-run-on-exceed
  semantics? where to persist spend across runs?).

This note is the primary deliverable. Keep it to ~1 page.

### Step 2: Minimal PoC — read-only cost summary behind a flag

- Add a `--show-cost` boolean option to the `visual-diff` command in `src/cli.ts`.
- In `VisualTestRunner.run()`, after the test loop and before returning, if a
  classifier exists, read `this.aiClassifier.getCostStats()` and attach it to the
  returned `VisualTestResult` as an optional field (e.g. `costSummary?`). Add that
  optional field to the result type — optional so nothing else breaks.
- In the CLI, when `--show-cost` is set, print one line after the run, e.g.:
  `AI vision: <N> analyses, est. $<amount> (cache hit rate <pct>%)`.
- Do NOT enforce anything, do NOT change exit codes.

**Verify**: `npx tsc --noEmit` → exit 0. `npx jest __tests__/visual/visual-runner.test.ts __tests__/cli.test.ts __tests__/visual-cli.test.ts` → all pass (the new field is optional, the flag defaults off, so existing tests are unaffected).

### Step 3: One test for the PoC

Add a single test (model on existing runner/cli tests) asserting that when the
classifier is present, `result.costSummary` is populated, and when `--show-cost`
is off the behavior/exit is unchanged. Mock the classifier's `getCostStats()` to
return a fixed object (do NOT make real API calls).

**Verify**: the new test passes; full `visual-diff`-related suites stay green.

## Test plan

- One PoC test for the optional `costSummary` field / `--show-cost` output.
- All existing CLI + runner tests must still pass (the change is additive and
  flag-gated).
- Verification: `npx jest __tests__/visual __tests__/cli.test.ts __tests__/visual-cli.test.ts`
  → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `plans/notes/008-cost-tracker-integration.md` exists and covers: data
      source, minimal change, full-feature outline, open questions
- [ ] `npx tsc --noEmit` exits 0
- [ ] `grep -n "show-cost" src/cli.ts` returns a match
- [ ] `result.costSummary` is populated when a classifier exists (covered by the new test)
- [ ] All existing CLI/runner tests pass; no exit-code or default-behavior change
- [ ] Only in-scope files modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `getCostStats()` returns zeros because cost tracking isn't actually populated
  during a normal run (the cost-tracker may only record when a real API call
  happens, not on cache hits / stub providers) — document this in the note as a
  finding; it changes the full-feature design. Do NOT start "fixing" the
  cost-tracker — that's out of scope.
- Wiring the optional field requires changing the *shape* of an existing
  `VisualTestResult` field (not just adding an optional one) — STOP; that's a
  breaking change to plan past a spike.
- The full feature turns out to need budget *persistence* across CLI invocations
  (a design question with no obvious default) — capture it as an open question
  for the maintainer rather than inventing a storage scheme.

## Maintenance notes

- This is deliberately a spike. The follow-up "real" plan (budget enforcement,
  `--budget-limit`, report fields) should be written only after the maintainer
  answers the open questions in the design note.
- A reviewer should confirm the PoC is genuinely read-only (no exit-code change,
  flag defaults off) so it can't surprise existing users.
