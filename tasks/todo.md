# #679 a11y: the keyboard checks' return to the start page can hide a move the page made by itself

Plan (self-authored; the issue has none). No architectural fork.

Shown first, in real Chromium (`__tests__/a11y/scan-navigation.test.ts`, test-first): on
main a page that moves by itself during the Tab walk to a page with a dialog is taken back to
the start URL by the Escape check and reported with the second page's trap result. The same
happens on a page that has a dialog itself and loads again, or whose router pushes another
path (red on main every run).

1. Tests, red first: three real-Chromium cases (move to a page with a dialog, reload,
   router push) and one that pins the unchanged case (a query-string rewrite still goes back).
2. `src/a11y/keyboard-tester.ts`: `run` holds the document it started on (only when the
   Escape check is on). Before the Escape check goes back, and when no key of its own left
   the page, it asks `documentSince(page, started)`; anything but `same` sets
   `movedByItself` and throws instead of going back.
3. `src/a11y/a11y-runner.ts`: the keyboard hold does not take that move for a custom
   sequence's (`keysMayNavigate && !movedByItself`), so it fails by name with custom
   sequences configured too. Mocked case in `__tests__/a11y/a11y-runner.test.ts`.
4. Docs: `.claude/rules/browser-safety.md`, `plans/README.md` (P3.47 done, P3.48 row for
   #681), `tasks/lessons.md`.

Decisions
- The tester throws a plain error and the runner's existing judgement names the move
  (`NavigatedDuringScanError` with the runner's reported URL), rather than the tester
  building that error from its own raw `page.url()`.
- The check is by document as well as URL, so a reload and a router push are caught, not only
  the "origin or path differs" case the issue names.

Acceptance criteria
- [ ] Real-Chromium test that shows it.
- [ ] Before the Escape check goes back, a move without `navigatedByKey` fails the page as
      "navigated during the scan"; the runner does not lose it.
- [ ] `.claude/rules/browser-safety.md` updated.
