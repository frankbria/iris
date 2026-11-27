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

---

# #644 [P3.33] CI review job fails at "Fetch the PR diff" when the diff holds a raw ESC byte

## Plan (self-authored)

The issue has two halves in two repositories.

- **This repo:** the raw ESC byte in `__tests__/mcp/tools.test.ts` (the only one in a
  tracked text file) and a test that keeps the next one out.
- **`frankbria/glm-review`:** the "Fetch the PR diff" step of `review.yml`, which this repo
  calls at `@main`. It needs `--allow-escape-sequences`.

## Decisions

- The hygiene test goes in `__tests__/repo-hygiene.test.ts` and reuses its `git grep` over
  tracked, non-binary files. It covers every tracked text file, not only `src` and
  `__tests__`: any of them can be in a diff.
- Only ESC (0x1b) is refused. It is the byte `gh` was seen to refuse; other control bytes
  are not known to break anything.
- The workflow change was made and tested in a scratch clone of `frankbria/glm-review`
  (its 67 tests pass; the new test fails without the flag). The push to that repository
  was refused by the session's permission layer, so the patch is posted on #644 for the
  owner to apply, and the issue stays open with `needs-owner`.

## Steps

1. `__tests__/repo-hygiene.test.ts`: fail on a raw ESC byte in any tracked text file (red
   first: it names `__tests__/mcp/tools.test.ts:529`).
2. `__tests__/mcp/tools.test.ts`: the same regex with `\x1b`.
3. Docs: `.claude/rules/deploy-ops.md`, `.claude/rules/testing.md`, `plans/README.md`
   (P3.33), `tasks/lessons.md`.
4. Post the `frankbria/glm-review` patch on #644; label `needs-owner`.

## Acceptance criteria

- [ ] The fetch step passes `--allow-escape-sequences` (patch ready, not applied: owner).
- [x] The raw ESC in `__tests__/mcp/tools.test.ts` is written `\x1b` (same regex), and a
      hygiene test refuses a raw ESC byte in tracked source.
- [ ] A PR whose diff contains the byte gets its primary review (follows from the first).
