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
