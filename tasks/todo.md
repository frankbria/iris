# #677 URL guard: the error page's reason depends on event order

Plan (self-authored; the issue has none).

Decision (the issue's first criterion): `guardedDocumentUrl` becomes async and asks the
browser. Measured in Chromium first (`/tmp/iris-677/probe.js`): `Page.getFrameTree` on the
guard's own session, straight after Playwright's `framenavigated` and without `Page.enable`,
returns the error page's frame with `unreachableUrl` and a `loaderId` equal to the paused
request's `networkId`.

1. Red first: the three real-Chromium #673 cases in `__tests__/url-policy-guard.test.ts`
   read straight after `framenavigated` (the `p.evaluate('1')` between is removed). On
   main's guard all three fail.
2. `src/url-policy-guard.ts`: refusals kept by navigation id in a bounded map
   (`GuardState.refusals`); the `Page.frameNavigated` listener, `Page.enable` and
   `documentRefusal` go; `guardedDocumentUrl` is async and, on an error page, asks
   `Page.getFrameTree` and looks the frame's `loaderId` up. If the browser no longer holds an
   error page by then, the URL the frame tree gives is the document's.
3. `src/a11y/a11y-runner.ts`: both calls awaited.
4. `__tests__/url-policy-guard-refusal.test.ts`: the stand-in answers `Page.getFrameTree`
   instead of delivering commits; cases for an overtaken refusal, the bound, and a page that
   moved on between the two reads.
5. Docs: `.claude/rules/browser-safety.md`, `plans/README.md` (P3.46 done, P3.47 row for
   #679), `tasks/lessons.md`.

Acceptance criteria
- [ ] Decision taken and recorded.
- [ ] Refusals kept by navigation id (bounded); the read does not depend on event order; a
      real-Chromium test reads straight after `framenavigated` with no page call between.
- [ ] The #662, #668 and #673 cases still pass.
