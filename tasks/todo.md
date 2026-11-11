# #652 [P3.37] Price table: delete deprecated rows after their shutdown dates; sampling options for fine-tuned ids

## Plan (self-authored; no plan on the issue)

The issue has five items. Two can be done now; three wait on a date or on #651 and stay
open on the issue (this PR does not close it).

1. **A fine-tuned id gets its base model's sampling options.** `openAISampling()`
   (`src/ai-client/models.ts`) reads the base model out of `ft:<base>:<org>:<suffix>:<id>`
   before it applies the family patterns. Tests: request-shape cases in
   `__tests__/ai-client.test.ts`.
2. **`iris visual-diff` names a model IRIS does not use for images.** The smart client's
   refusal becomes a typed `ModelNotForImagesError`; the classifier answers it with its
   fallback, classified `MODEL_UNAVAILABLE` and described by the reason; the runner's
   existing rule then fills `summary.aiUnavailableReason`, which the CLI line and the HTML,
   JUnit and Markdown reports already print. Tests: `ai-client-batch4.test.ts`,
   `visual/ai-classifier-refactored.test.ts`, `visual/visual-runner.test.ts`, and the real
   chain in `visual/ai-unavailable-exit.test.ts` (needs a browser: CI).
3. Docs: `.claude/rules/ai-and-visual.md`, `plans/README.md`.

## Decisions

- The comparison is still graded by its pixels (the #281 fallback), not failed closed as
  `breaking` like a model the provider does not serve (#484): the issue asks for the
  reason on the line, not for a different verdict.
- With `ai.fallback` on, the other vendors are still tried. When none of them failed for a
  reason of its own, the model fault is thrown as itself instead of "All providers failed".
- Sampling only: the vision table and the price table do not look inside an `ft:` id.

## Not in this PR (left on #652)

- Deleting deprecated price rows: the first date is 2026-11-30.
- GPT-5.6 Sol's row after its promotion ends on 2026-11-30.
- The reply cap for `gpt-6-astra` / `gpt-6.1-sol`: waits on #651 (needs-owner).

## Acceptance criteria covered

- [x] A fine-tuned id (`ft:gpt-6-luna:org::id`) gets its base model's options
- [x] `iris visual-diff`'s `AI: unavailable for N comparison(s)` line shows the reason for a
      model not offered for vision
