# #668 [P3.42] URL guard: record only main-frame refusals, so a refused move's reason cannot be a frame's

## Plan (self-authored; no plan on the issue)

The page's CDP Fetch handler (`installFetchGuard`, src/url-policy-guard.ts) records
`state.refusal` for every refused request of resource type `Document`, a subframe's included.
`guardedGoto` and `guardedDocumentUrl` quote that record as the reason a navigation failed.

1. Tests first.
   - `__tests__/url-policy-guard-refusal.test.ts` (new, runs on this host): the guard on a
     stand-in CDP session. A refused frame document followed by a navigation that fails for
     another reason: `guardedGoto` rethrows the navigation's own error and
     `guardedDocumentUrl` gives the generic reason. A refused main-frame document: both still
     name it. The frame's request is failed either way.
   - `__tests__/url-policy-guard.test.ts` (real Chromium, CI only on this host): a page with
     a refused iframe whose script moves the top frame to an address that fails for another
     reason gets the generic reason. It is what shows that Chromium's frame ids are what the
     stand-in assumes.
2. `installFetchGuard` reads the page's target id (`Target.getTargetInfo`) before
   `Fetch.enable` and records a refusal only when `event.frameId` is that id (a top-level
   frame's id is its target id, which the browser net already relies on). `joinBrowserNet`
   takes the id instead of asking again.
3. The mocked CDP sessions of `executor.test.ts`, `a11y-runner.test.ts` and
   `visual-runner.test.ts` answer `Target.getTargetInfo` (the guard now asks every page, not
   only one with a browser).
4. Docs: drop the `shortcut:` note on `guardedDocumentUrl`; `.claude/rules/browser-safety.md`;
   `plans/README.md` (P3.42 done, P3.43 row for #669); `tasks/lessons.md` (two lines
   iteration 17 asked for).

## Decisions (no architectural fork)

- Recorded for the main frame only (the issue's first option), not cleared on commit: a
  refusal cleared on commit would also need a `Page.frameNavigated` subscription.
- The target id is read on every guarded page, persistent contexts included (the browser net
  is skipped there, the page session is not).

## Acceptance criteria

- [ ] A refusal is recorded for the main frame's document only.
- [ ] A real-Chromium test: a page with a refused iframe whose script moves the top frame to
      an address that fails for another reason gets the generic reason, not the frame's.
- [ ] The existing "blocks a redirect to a metadata host and says why" tests still pass.
