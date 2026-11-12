# #683 a11y: the keyboard tester never releases the document it reloaded into, and a move pushed away and back keeps a plain error

Plan (self-authored; the issue has none). No architectural fork.

1. **Release `reloadedInto`.** The a11y runner releases it once the held keyboard check has
   settled (the hold has asked it by then), and `KeyboardTester.run` releases the one a
   previous run left before it starts, for a caller that keeps one page and never asks.
   Fake-page tests in `keyboard-tester.test.ts` and `a11y-runner.test.ts`.
2. **Decision (the issue's second criterion): the move is named.** The tester is the one
   that saw the page move, so it throws `NavigatedDuringScanError` itself (under the URL of
   the document it was given, "loaded again" when the page is at the same origin and path)
   and `run` passes that error through without its "Keyboard testing failed:" prefix. A
   router that pushed back before the runner's read no longer turns it into a plain error;
   when the runner still sees the move it names it as before, with the tester's error as
   the cause. `movedByItself` stays (the runner uses it for custom sequences).
   Red first in real Chromium (`scan-navigation.test.ts`: the path is pushed back between
   the tester's throw and the hold's read) and on the fake page.
   Three existing fake-page assertions change with it: they quoted the plain error's text.
3. Docs: `.claude/rules/browser-safety.md`, JSDoc, `plans/README.md` (P3.49 done, the P3.50
   row for #685).
