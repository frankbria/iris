🤖 Auto-mode: plan posted for the record and self-approved (no architectural fork). Reply to request changes before merge.

## Plan (self-authored; the issue had none)

**What a real Chromium shows** (probe on the build host, Playwright's own Chromium): when the main frame commits an error page, `Page.frameNavigated` on the page's CDP session carries the `loaderId` of the navigation that failed, and that id equals the `networkId` of the `Fetch.requestPaused` event of that navigation's document request, on every redirect hop. A refused move followed by a move to `http://localhost:1/` commits one error page whose loader id is the second navigation's.

1. **Tests first** (`__tests__/url-policy-guard-refusal.test.ts`, stand-in CDP session; `__tests__/url-policy-guard.test.ts`, real Chromium):
   - refused move, then a move that fails otherwise: the generic reason (red on main);
   - the reverse order: the refusal;
   - a refused navigation that never commits, superseded by one that fails otherwise: the generic reason;
   - a subframe's commit changes nothing; the #662 and #668 cases unchanged in what they assert.
2. **Guard** (`src/url-policy-guard.ts`): the page session subscribes to `Page.frameNavigated` (enabled before `Fetch.enable`). A refused main-frame document is remembered with its navigation's id by both layers that can refuse it (page session, browser net). When the main frame commits, the guard keeps that refusal as "why the document the page holds is an error page" only if the commit's `loaderId` is the refused navigation's; otherwise it clears it. `guardedDocumentUrl` quotes that, not the last refusal recorded.
3. **Docs**: `.claude/rules/browser-safety.md`, `plans/README.md` (P3.44 done, the missing P3.45 row for #675), `tasks/lessons.md` if anything is learned.

## Decisions taken
- The navigation's id (the issue's second option, with the `Page.frameNavigated` subscription of its first), not a URL comparison: the error page's `unreachableUrl` carries the fragment and the paused request's URL does not.
- `guardedGoto` is unchanged: it resets the record itself and reports the failure of its own navigation.
- `guardedDocumentUrl` stays synchronous. Only the latest refused navigation is remembered.

## Acceptance criteria
- [ ] The reason quoted for an error page is the refusal of the navigation that left it, or the generic reason when that navigation was not refused.
- [ ] A real-Chromium test in `__tests__/url-policy-guard.test.ts`: refused move, then a move that fails otherwise, gets the generic reason; the reverse order gets the refusal.
- [ ] The #662 and #668 cases still pass.
