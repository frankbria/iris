# #675 a11y: a reload, or a key other than Escape that navigates, during the scan

Plan (self-authored; the issue has none).

1. `src/a11y/scan-navigation.ts`: `holdDocument(page, url)` keeps a handle to the document
   the page holds. A cross-document navigation destroys it whatever the URL (a reload, the
   same path under another query string); `history.pushState` / `replaceState` and a
   fragment change do not (measured in Chromium, /tmp/iris-675/probe.js).
   `onScannedDocument` takes the held document: a move is "origin or path differs" (as
   before) or "the held document is gone while the page answers".
   A reload's error keeps the prefix and ends "... and loaded again before its checks finished".
2. `src/a11y/a11y-runner.ts`: hold the document where the scanned URL is read.
3. `src/a11y/keyboard-tester.ts`: `navigatedByKey` is also set by ArrowDown, and by a key
   that reloads the page; an ArrowDown that left the page is a failed interaction saying
   so, the other widgets were on the page it left, and the Escape check returns to the
   start page.
4. `src/mcp/scan-errors.ts`: fixed reason "the page reloaded during the scan".
5. Docs: README, `.claude/rules/browser-safety.md`, `plans/README.md` (P3.45 done, P3.46 row
   for #677, P3.44 follow-up), `tasks/lessons.md`.

Decisions (the issue asks for one):
- An arrow key that navigates: the keyboard check's own move, seen by the check that
  follows the key, like Escape.
- A handler that navigates after a delay: NOT the check's own. Nothing outside the page
  ties a later navigation to an earlier key, so it stays "navigated during the scan". A
  real-Chromium test pins each.

Acceptance criteria
- [ ] Cross-document main-frame navigation during a held check detected whatever its URL;
      same-document query/fragment change still not.
- [ ] Decision on arrow key / delayed Escape, with a real-Chromium test.
- [ ] README and `.claude/rules/browser-safety.md` updated.
