# Plan 004: Fix the AccessibilityRunner URL handling and re-enable skipped tests

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving on. If any
> STOP condition occurs, stop and report — do not improvise. When done, update
> this plan's status row in `plans/README.md` unless a reviewer told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 65633a6..HEAD -- src/a11y/a11y-runner.ts __tests__/e2e/a11y-e2e.test.ts __tests__/visual/diff.test.ts`
> If any changed since this plan was written, compare the "Current state"
> excerpts against the live code; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug / tests
- **Planned at**: commit `65633a6`, 2026-06-21
- **Issue**: https://github.com/frankbria/iris/issues/4

## Why this matters

`npx jest` reports **22 skipped tests** — 19 of them the entire accessibility
e2e suite, skipped because of a real URL-construction bug, plus 2 SSIM diff
tests skipped for a mock-setup TODO. The skip is masking a genuine defect:
`AccessibilityRunner.testPage()` builds a page URL with
`http://localhost:3000${pagePattern}`, so a caller that passes a full URL like
`about:blank` (from `page.url()` after `page.setContent()`) gets the invalid
`http://localhost:3000about:blank`. Because of this, the a11y feature has
effectively zero end-to-end test coverage. Fixing the URL handling makes the
tests runnable and the feature trustworthy.

## Current state

`src/a11y/a11y-runner.ts:184-190` — the bug (no separator, no full-URL guard
that handles non-http schemes):

```ts
const url = pagePattern.startsWith('http') ? pagePattern : `http://localhost:3000${pagePattern}`;
await page.goto(url, { waitUntil: 'networkidle' });
// ...
const axeResult = await this.axeRunner.run(page, testName, url);
```

Note: a path like `/page` yields `http://localhost:3000/page` (works), but
`about:blank` does not start with `http`, so it becomes
`http://localhost:3000about:blank` (broken). The same `startsWith('http')`
pattern exists in `src/visual/visual-runner.ts:285` — that one is out of scope
here but see Maintenance notes.

`__tests__/e2e/a11y-e2e.test.ts:95+` — 19 `it.skip(...)` with the documented
reason:

```
// SKIP REASON: Infrastructure mismatch
// Test uses page.setContent() then passes page.url() ('about:blank') to
// AccessibilityRunner, which concatenates it as
// 'http://localhost:3000about:blank' - an invalid URL.
// TO RE-ENABLE: ...serve fixtures from a test server... OR modify
// AccessibilityRunner.testPage() to accept page objects with setContent()
```

`__tests__/visual/diff.test.ts:145-150` — 2 SSIM tests:

```ts
it.skip('should perform SSIM comparison', async () => {
  // TODO: Fix SSIM mock setup
it.skip('should handle SSIM errors gracefully', async () => {
  // TODO: Fix SSIM mock setup
```

## Commands you will need

| Purpose   | Command                                              | Expected on success |
|-----------|------------------------------------------------------|---------------------|
| Install   | `npm install`                                         | exit 0              |
| Typecheck | `npx tsc --noEmit`                                   | exit 0, no output   |
| a11y unit | `npx jest __tests__/a11y`                            | all pass            |
| a11y e2e  | `npx jest __tests__/e2e/a11y-e2e.test.ts`           | all pass, 0 skipped (in the in-scope tests) |
| diff test | `npx jest __tests__/visual/diff.test.ts`            | all pass            |

## Scope

**In scope**:
- `src/a11y/a11y-runner.ts` — URL construction in `testPage()` only
- `__tests__/e2e/a11y-e2e.test.ts` — un-skip and adapt the 19 tests
- `__tests__/visual/diff.test.ts` — un-skip and fix the 2 SSIM tests
- A test fixtures directory if you choose the fixture-server approach (Step 2)

**Out of scope** (do NOT touch):
- `src/visual/visual-runner.ts` (the parallel URL bug there is plan 002/its own
  concern) — do not edit it from this plan.
- `src/a11y/index.ts` stubs (those are addressed in plan 006's direction note).
- The axe-core integration logic in `src/a11y/axe-integration.ts` — it works and
  is tested.

## Git workflow

- Branch: `improve/004-fix-a11y-url-and-unskip-tests`
- Commit style: `fix(a11y): correct page URL construction` and
  `test(a11y): re-enable accessibility e2e and SSIM diff tests`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Fix URL construction in AccessibilityRunner

Replace the brittle `startsWith('http')` concatenation with logic that treats
any value containing a scheme (`://` or `about:`) as a complete URL, and only
prefixes the dev-server base for bare paths:

```ts
const isFullUrl = /^[a-z]+:/i.test(pagePattern);   // http:, https:, about:, file:, data:
const url = isFullUrl ? pagePattern : `http://localhost:3000${pagePattern}`;
```

This makes `about:blank`, `http://...`, and `/path` all resolve correctly.

**Verify**: `npx tsc --noEmit` → exit 0; `npx jest __tests__/a11y` → all pass.

### Step 2: Re-enable the 19 a11y e2e tests

Pick the approach the existing test structure makes cheapest. The skip comment
offers two; choose based on what the test already sets up:

- **Preferred (matches the skip's own "OR" option)**: the tests already call
  `page.setContent(html)` then read `page.url()` (== `about:blank`). With Step 1,
  passing `about:blank` no longer corrupts the URL — axe-core runs against the
  already-loaded page content. Change each `it.skip(` to `it(` and pass the
  page's real URL (`about:blank`) through; assert on the violations axe returns.
- **Alternative**: stand up a tiny static file server in `beforeAll` serving
  HTML fixtures and use `http://localhost:<port>/fixture.html`. Only do this if
  the page-content approach can't observe violations.

Whichever you choose, all 19 must run and pass (or assert the documented
expected violations). Do not leave any `it.skip` in this describe block.

**Verify**: `npx jest __tests__/e2e/a11y-e2e.test.ts` → 0 failed, 0 skipped
among these 19 tests.

### Step 3: Fix and re-enable the 2 SSIM diff tests

In `__tests__/visual/diff.test.ts`, the two SSIM tests are skipped for "mock
setup". Read how the surrounding (passing) diff tests mock `image-ssim` /
`sharp` and replicate that setup so the SSIM path is exercised. Change
`it.skip(` → `it(`. Assert the SSIM comparison returns a similarity score in
`[0,1]` for the happy path, and that the error path is handled gracefully (the
test's own title).

**Verify**: `npx jest __tests__/visual/diff.test.ts` → all pass, 0 skipped for
these two.

### Step 4: Confirm the global skip count dropped

**Verify**: `npx jest 2>&1 | tail -5` → `skipped` count reduced by 21 (19 a11y +
2 SSIM) from the baseline of 22. Any remaining skips must be intentional and
named in your report.

## Test plan

- Re-enabled: 19 a11y e2e tests + 2 SSIM diff tests, all passing.
- No brand-new test files required, but if you take the fixture-server route,
  add the fixtures under a clearly named directory (e.g. `__tests__/fixtures/a11y/`).
- Verification: `npx jest __tests__/a11y __tests__/e2e/a11y-e2e.test.ts __tests__/visual/diff.test.ts`
  → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `npx tsc --noEmit` exits 0
- [ ] `grep -rn "it.skip" __tests__/e2e/a11y-e2e.test.ts` returns nothing
- [ ] `grep -n "it.skip" __tests__/visual/diff.test.ts` returns nothing (for the 2 SSIM tests; if other skips exist there, name them in your report)
- [ ] `grep -n "localhost:3000\${pagePattern}\|localhost:3000\`" src/a11y/a11y-runner.ts` shows the new scheme-aware logic, not the bare concat
- [ ] `npx jest` skipped count is ≤ 1 (down from 22) and failures did not increase
- [ ] Only in-scope files (and any new fixtures) modified
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- After Step 1, the a11y e2e tests still fail because axe-core cannot analyze a
  `setContent`-loaded `about:blank` page (axe may require a real document URL) —
  report this; it means the fixture-server route (Step 2 alternative) is required
  and is a larger effort than estimated.
- The SSIM tests fail because `image-ssim` needs real image buffers the test
  fixtures don't provide — report rather than weakening the assertions to
  trivially pass.
- Un-skipping reveals a real product bug in `a11y-runner.ts` beyond URL handling
  — STOP and report it as a new finding; do not expand this plan's scope to fix
  it.

## Maintenance notes

- The identical `startsWith('http')` URL pattern lives in
  `src/visual/visual-runner.ts:285`. It has the same latent bug for non-http
  schemes; consider extracting a shared `resolvePageUrl(pattern, base)` helper in
  a follow-up so both runners stay consistent (deferred out of this plan to keep
  scope tight).
- A reviewer should confirm the re-enabled tests assert *meaningful* axe
  violations (not just "ran without throwing") — re-enabling tests that assert
  nothing would defeat the purpose.
