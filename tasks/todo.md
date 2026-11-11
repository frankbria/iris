# #664 [P3.40] Fine-tuned OpenAI ids: the vision table refuses them and the price table charges the dearest rate

## Plan (self-authored; no plan on the issue)

1. Read OpenAI's pages (pricing, deprecations, model optimization, vision fine-tuning,
   the model pages), 2026-11-11.
2. Tests first: `__tests__/ai-fine-tuned-ids.test.ts` (the four fine-tuned rows, a fine-tune
   with no row stays an estimate, ids without `ft:` unchanged, `isVisionModel` is false for
   every fine-tuned id, the refusal says why).
3. `fineTunedBase()` exported from `src/ai-client/models.ts`; `ModelNotForImagesError` names
   a fine-tuned id as such; `CostTracker.resolveKey` prices `ft:<base>:<org>:<suffix>:<id>`
   by the row `ft:<base>`; four rows in `DEFAULT_PRICING`.
4. Docs: `.claude/rules/ai-and-visual.md`, `plans/README.md`.

## What the pages say

- Fine-tuning is closed to new users; no new jobs after 2027-01-06. Inference on a
  fine-tune lasts until its base model is shut down.
- Priced fine-tunes (inference, per 1M tokens, standard): `gpt-4.1-2025-04-14` $3/$12,
  `gpt-4.1-mini-2025-04-14` $0.80/$3.20, `gpt-4o-2024-08-06` $3.75/$15,
  `gpt-4o-mini-2024-07-18` $0.30/$1.20. All four bases shut down 2027-01-14.
- Every model in IRIS's vision table (`gpt-6*`, `gpt-5.6`, `gpt-5.5`, `gpt-5.4`, `gpt-5.2`)
  lists fine-tuning as "Not supported".

## Decisions

- `isVisionModel` stays false for every fine-tuned id: the only bases that can be
  fine-tuned are the deprecated ones IRIS stopped offering for images in #523. The refusal
  says so instead of "text-only, deprecated or unknown".
- A fine-tune is priced only when the page lists its base snapshot; any other stays an
  estimate at the dearest rate.
- The four rows go with their bases on 2027-01-14 (#652's schedule).
