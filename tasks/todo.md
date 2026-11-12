# #681 URL guard: a popup's refused opening navigation leaves an error page with no reason

Plan (self-authored; the issue has none). No architectural fork.

Decision (the issue's first criterion): **not done, the limit is documented.** Nothing reads
a popup with `guardedDocumentUrl` (the a11y runner scans the page it opened), so carrying an
opener-judged refusal over to the popup's guard would be code no caller can observe. The
read is fail-safe as it is: it throws "could not be loaded", it never returns the error page
as a document. Reopen when a caller reads popups; refusals are kept by navigation id since
#680, so the browser net could hold an inherited target's and hand them over on attach.

Shown first in real Chromium on this host (3 runs of 3): a `target=_blank` link that
redirects to the metadata host leaves the popup on Chromium's error page,
`guardedDocumentUrl(popup, …)` rejects with the generic reason, and the opener still reads
as its own URL.

1. `__tests__/url-policy-guard.test.ts`: one real-Chromium case pinning exactly that.
2. Docs: JSDoc on `guardedDocumentUrl`, `.claude/rules/browser-safety.md` (the limit),
   `plans/README.md` (P3.48 closed as not done, P3.49 row for #683).

Acceptance criteria:
- [x] Decide: closed as won't-do while no caller reads popups.
- [ ] "If done" test: not applicable; the pin test above stands in, and it also shows the
      opener's own read is untouched.
