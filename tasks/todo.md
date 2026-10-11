# #296 [P1.17] Do not auto-retry non-idempotent clicks and fills

## Findings (real Chromium)

`page.click` resolves when the click already happened and then: the handler throws, the
document is replaced, the element detaches on mousedown, or the page navigates to a refused
port. So a click that reaches the retry loop failed in a rare, ambiguous way (protocol or
target error mid-dispatch, an unknown error), which is exactly when a retry can submit twice.
`page.fill` rejects before typing for a non-input target (deterministic).

## Plan

1. `src/executor.ts`: `click` and `fill` are never retried (`mayRepeat`). The first version
   kept an allowlist of pre-dispatch errors ("Element is not attached to the DOM"), but the
   installed Playwright retries that case itself and throws it only under `noAutoWaiting`,
   so it never reached the executor; it went (internal review). Navigate and asserts keep
   today's rules.
2. Tests (`__tests__/executor.test.ts`): a click/fill that submitted and then failed with a
   generic or protocol error runs once (the AC test); a detach error is not repeated either;
   the existing "generic errors are retried" tests move to `navigate` (a GET), since that
   behaviour is exactly what #296 removes for click/fill.
3. README (retry options paragraph), CLAUDE.md (one bullet), plans row, lessons.

## Acceptance criteria
- [ ] Retries only for errors that prove the action did not happen
- [ ] Test: a click whose handler throws after submitting is not repeated
