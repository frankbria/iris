# Plan 002: Enforce the concurrency cap with p-limit and correct the stale e2e tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 65633a6..HEAD -- src/visual/visual-runner.ts __tests__/e2e/visual-diff-e2e.test.ts`
> If either file changed since this plan was written, compare the "Current
> state" excerpts against the live code before proceeding; on a mismatch,
> treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none (can run before or after 001)
- **Category**: bug / tests
- **Planned at**: commit `65633a6`, 2026-06-21
- **Issue**: https://github.com/frankbria/iris/issues/2

## Why this matters

`VisualTestRunner.runTestsInParallel()` hand-rolls a concurrency limiter that
does not work. It checks `(p as any).status === 'fulfilled'` on native
Promises — which have no `.status` property — so the cleanup `findIndex` only
ever matches `p === promise` (the *newest* promise just pushed), splicing the
wrong element out of the tracking array. The net effect: the `concurrency` cap
is **not enforced** — on a large page×device matrix the runner can launch all
browser contexts at once, risking memory/FD exhaustion. (It does *not* drop
results — every task is still awaited via `Promise.all` and every result is
collected; the earlier "limits to 2 comparisons" diagnosis was wrong.)

Worse, two e2e tests were edited to *assert the buggy behavior* (`expect(...).toBe(2)`
with comments citing the "concurrency bug"). The code now returns the correct
counts (3 and 5), so those tests **fail** — turning a green suite red and
inverting the meaning of failure. `p-limit@^5` is already a dependency and is
the correct, battle-tested fix.

## Current state

`src/visual/visual-runner.ts:217-264` — the broken limiter:

```ts
private async runTestsInParallel(
  tasks: { page: string; device: string }[],
  concurrency: number
): Promise<VisualTestResult['results']> {
  const results: VisualTestResult['results'] = [];
  const executing: Promise<void>[] = [];

  for (const task of tasks) {
    const promise = this.testPage(task.page, task.device)
      .then(result => { results.push(result); })
      .catch(error => {
        results.push({ /* ...error result... */ error: error.message } as any);
      });

    executing.push(promise);

    // Control concurrency - wait if we've reached the limit
    if (executing.length >= concurrency) {
      await Promise.race(executing).then(() => {
        // Remove completed promises
        const index = executing.findIndex(p =>
          p === promise || (p as any).status === 'fulfilled' || (p as any).status === 'rejected'
        );
        if (index !== -1) { executing.splice(index, 1); }
      });
    }
  }

  await Promise.all(executing);
  return results;
}
```

The exact failing assertions, `__tests__/e2e/visual-diff-e2e.test.ts`:

- Lines ~497-503 ("should capture screenshots for multiple device types"),
  1 page × 3 devices:
  ```ts
  // ADJUSTED: Concurrency bug limits to 2 actual executions
  // Expected 3 devices (1 page × 3 devices) but bug limits to 2
  expect(result.summary.totalComparisons).toBe(2);
  expect(result.results).toHaveLength(2);
  expect(result.results[0].device).toBe('desktop');
  expect(result.results[1].device).toBe('tablet');
  // Mobile device won't be tested due to concurrency bug
  ```
- Lines ~701-705 ("should handle concurrent comparisons efficiently"),
  5 tasks:
  ```ts
  // ADJUSTED: Concurrency bug limits to 2 actual executions
  // Expected 5 pages but bug limits to 2
  expect(result.summary.totalComparisons).toBe(2);
  expect(duration).toBeLessThan(30000);
  expect(result.results).toHaveLength(2);
  ```

Repo conventions: `p-limit` is already imported elsewhere in the codebase via a
dynamic import for Jest/ESM compatibility (see CLAUDE.md note: "Dynamic p-limit
import for Jest compatibility" and its use in `src/visual/ai-classifier.ts`).
`p-limit@5` is ESM-only, so it MUST be loaded with `await import('p-limit')`,
never a top-level `import pLimit from 'p-limit'` (that breaks the ts-jest
CommonJS build). Match the dynamic-import pattern already used for p-limit in
`src/visual/ai-classifier.ts`.

## Commands you will need

| Purpose   | Command                                                  | Expected on success |
|-----------|----------------------------------------------------------|---------------------|
| Install   | `npm install`                                            | exit 0              |
| Typecheck | `npx tsc --noEmit`                                        | exit 0, no output   |
| Unit test | `npx jest __tests__/visual/visual-runner.test.ts`        | all pass            |
| E2E test  | `npx jest __tests__/e2e/visual-diff-e2e.test.ts`         | all pass (0 failed) |
| Full suite| `npx jest 2>&1 \| tail -5`                                | `0 failed`          |

## Scope

**In scope** (the only files you should modify):
- `src/visual/visual-runner.ts` — `runTestsInParallel()` only
- `__tests__/e2e/visual-diff-e2e.test.ts` — the two stale assertions only
- `__tests__/visual/visual-runner.test.ts` — add a concurrency-cap test (create the describe block if absent)

**Out of scope** (do NOT touch):
- `testPage()` and the rest of `visual-runner.ts` — behavior must not change.
- The `result` shape / `VisualTestResult` type (a separate concern; the `as any`
  on the error result is addressed in plan 007, not here).
- Any other e2e test in the file beyond the two assertions named above.

## Git workflow

- Branch: `improve/002-fix-concurrency-and-stale-tests`
- Commit style (conventional, matches `git log`):
  `fix(visual): enforce concurrency cap with p-limit` and
  `test(visual): assert correct comparison counts`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Replace the hand-rolled limiter with p-limit

Rewrite `runTestsInParallel()` so it loads `p-limit` dynamically and maps each
task through a limit-wrapped call. Target shape:

```ts
private async runTestsInParallel(
  tasks: { page: string; device: string }[],
  concurrency: number
): Promise<VisualTestResult['results']> {
  const { default: pLimit } = await import('p-limit');
  const limit = pLimit(Math.max(1, concurrency));

  const settled = await Promise.all(
    tasks.map(task =>
      limit(() =>
        this.testPage(task.page, task.device).catch(error => ({
          page: task.page,
          device: task.device,
          passed: false,
          similarity: 0,
          pixelDifference: 1,
          threshold: this.config.diff.threshold,
          severity: 'breaking',
          screenshotPath: '',
          error: error.message,
        } as any))
      )
    )
  );

  return settled;
}
```

This preserves order (`tasks.map` keeps results aligned to input order, so
`results[0].device === 'desktop'` still holds), caps in-flight work at
`concurrency`, and loses no results. Keep the exact error-result object shape
that exists today.

**Verify**: `npx tsc --noEmit` → exit 0.

### Step 2: Correct the two stale e2e assertions

In `__tests__/e2e/visual-diff-e2e.test.ts`:

- The 1-page × 3-device test: change to the correct counts and remove the
  "concurrency bug" comments:
  ```ts
  expect(result.summary.totalComparisons).toBe(3);
  expect(result.results).toHaveLength(3);
  expect(result.results[0].device).toBe('desktop');
  expect(result.results[1].device).toBe('tablet');
  expect(result.results[2].device).toBe('mobile');
  ```
- The "concurrent comparisons" 5-task test: change `toBe(2)` → `toBe(5)` and
  `toHaveLength(2)` → `toHaveLength(5)`; remove the "limits to 2" comments.

**Verify**: `npx jest __tests__/e2e/visual-diff-e2e.test.ts` → 0 failed.

### Step 3: Add a real concurrency-cap regression test

In `__tests__/visual/visual-runner.test.ts`, add a test that proves the cap is
enforced (this is what the old code silently violated). Model it on the
existing tests in that file. The test should instrument `testPage` (spy/mock)
to record peak concurrent in-flight calls and assert it never exceeds the
configured `concurrency`. If `runTestsInParallel` is private, exercise it
through the public `run()` path with a small device matrix and a stubbed
browser, matching how the other tests in this file drive the runner. If the
existing test harness makes peak-concurrency hard to observe, assert instead
that `result.results.length === tasks.length` for a matrix larger than
`concurrency` (proves no results are dropped) and note in a comment that the
cap itself is covered by the e2e timing test.

**Verify**: `npx jest __tests__/visual/visual-runner.test.ts` → all pass,
including the new test.

### Step 4: Confirm the whole suite is green for these files

**Verify**: `npx jest 2>&1 | tail -5` → `0 failed` for the visual-runner and
visual-diff-e2e suites (the 22 skipped tests remain skipped — they are
addressed in plan 004; this plan must not change the skipped count).

## Test plan

- New test in `__tests__/visual/visual-runner.test.ts`: concurrency cap /
  no-dropped-results, modeled on the existing runner tests in that file.
- Corrected assertions in `__tests__/e2e/visual-diff-e2e.test.ts` (3 and 5).
- Verification: `npx jest __tests__/visual __tests__/e2e/visual-diff-e2e.test.ts`
  → 0 failed.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `grep -n "(p as any).status" src/visual/visual-runner.ts` returns nothing
- [ ] `grep -n "concurrency bug" __tests__/e2e/visual-diff-e2e.test.ts` returns nothing
- [ ] `npx jest __tests__/e2e/visual-diff-e2e.test.ts` → 0 failed
- [ ] `npx jest` total failures = 0 (down from 2); skipped count still 22
- [ ] Only the three in-scope files are modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The live `runTestsInParallel()` no longer matches the "Current state" excerpt
  (someone already refactored it — re-verify the bug still exists).
- The corrected e2e tests fail with counts *other than* 3 and 5 (e.g. the
  runner returns 2 even with p-limit) — that would mean a second, deeper bug in
  `testPage`/`run`; report the actual numbers.
- Switching to `await import('p-limit')` breaks the ts-jest build with an
  ESM/CJS interop error — report the exact error rather than adding a top-level
  static import.
- Making the cap observable in a unit test would require changing `testPage`'s
  signature or visibility — fall back to the no-dropped-results assertion (Step 3)
  and note it.

## Maintenance notes

- When plan 004 (parallel/incremental execution, docs/phase2c_roadmap.md) is
  eventually built, it should reuse this `p-limit`-based path rather than
  reintroducing a custom limiter.
- A reviewer should confirm result ordering is preserved (the e2e test asserts
  `results[0].device === 'desktop'`), since `p-limit` runs tasks out of order
  but `tasks.map(...)` keeps the *returned array* in input order.
