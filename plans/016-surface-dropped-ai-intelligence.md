# Plan 016: Stop throwing away the AI's intelligence — suggestions/reasoning into reports, diff image into the vision request

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/visual/visual-runner.ts src/visual/reporter.ts src/visual/ai-classifier.ts src/ai-client/base.ts src/ai-client/vision.ts`
> Plan 009 will have touched visual-runner.ts (classifier construction) — not
> drift. STOP if the aiAnalysis copying or reporter excerpts below don't match.

## Status

- **Priority**: P2
- **Effort**: M (two independent halves: S for reports, M for diff-image threading)
- **Risk**: LOW (reports) / MED (vision request contract + cache keys)
- **Depends on**: plans/009 (nothing here is user-visible until --semantic works)
- **Category**: tech-debt
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

When AI classification runs, most of what it computes is discarded before anyone sees it. The classifier returns `suggestions`, `isIntentional`, `changeType`, and `reasoning` (src/visual/ai-classifier.ts:315-325), but the runner copies only four fields into results (visual-runner.ts:440-445) and the HTML report renders only classification/confidence/description. Separately, the runner passes the computed diff image into `analyzeChange` — and the classifier silently drops it, because `AIVisionRequest` has no diff field (base.ts:47-55): the AI judges two full screenshots with no localization of what changed. The PRD's "intelligent visual regression" promise (explanations + suggestions) is under-delivered even though the data is already paid for.

## Current state

- `src/visual/ai-classifier.ts:315-325` — full response mapped:

```ts
    return {
      classification,
      confidence: visionResponse.confidence,
      description,
      severity,
      suggestions: visionResponse.suggestions || [],
      isIntentional,
      changeType,
      reasoning: visionResponse.reasoning,
      regions: undefined, // Phase 2A doesn't provide regions yet
    };
```

- `src/visual/visual-runner.ts:440-445` — the thinning:

```ts
        aiAnalysis = {
          classification: analysis.classification,
          confidence: analysis.confidence,
          description: analysis.description,
          severity: analysis.severity,
        };
```

- Result type at `visual-runner.ts:83-88`: `aiAnalysis?: { classification; confidence; description; severity }`.
- `src/visual/reporter.ts:277-294` — HTML renders classification+confidence+description only; JUnit at ~:408-411 and Markdown at ~:476-481 similar.
- `src/visual/ai-classifier.ts:246-254` — diff dropped: `visionRequest` built from `request.baselineImage` + `request.currentImage` only; `request.diffImage` unused.
- `src/ai-client/base.ts:46-55` — `AIVisionRequest { baseline: Buffer; current: Buffer; context?: {...} }` — no diff field.
- `src/ai-client/vision.ts` — providers send exactly two images (OpenAI ~:101-115 message content; Anthropic ~:230-250 blocks; prompts describe "first image = baseline, second = current"). The cache key derives from the request images (see `src/ai-client/cache.ts` key generation — read it in Step 3 before changing anything; adding a third image MUST change the key input).
- Conventions: strict TS, Jest, conventional commits, Prettier.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Tests     | `npx jest __tests__/visual __tests__/ai-client-vision.test.ts` | all pass |
| Full gate | `npm run verify`         | exit 0              |

## Scope

**In scope**:
- `src/visual/visual-runner.ts` (widen aiAnalysis)
- `src/visual/reporter.ts` (render new fields in HTML/Markdown; JUnit gets reasoning in the message only)
- `src/visual/ai-classifier.ts` (pass diff through)
- `src/ai-client/base.ts` (optional `diff?: Buffer` on AIVisionRequest)
- `src/ai-client/vision.ts` (attach third image + one prompt sentence, all providers)
- `src/ai-client/cache.ts` (ONLY if the key input needs the third image folded in)
- `__tests__/` for the above

**Out of scope**:
- Region-level classification (`analyzeRegions` in diff.ts stays unwired — real per-region AI is a Phase-2C design, not a wiring fix).
- Pass/fail semantics — AI still never flips `passed`.
- The CLI, watch, run commands.

## Git workflow

- Branch: `feat/016-surface-ai-analysis`
- Conventional commits; two commits recommended: `feat(visual): surface AI suggestions/reasoning in results and reports` and `feat(ai-client): include diff image in vision analysis request`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Widen the result type and stop thinning

Extend the `aiAnalysis` shape in `visual-runner.ts:83-88` with `suggestions: string[]`, `isIntentional?: boolean`, `changeType?: string`, `reasoning?: string`; copy them through at :440-445.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: Render in reports

HTML (reporter.ts, inside the existing `result.aiAnalysis` block at :277-294): add a suggestions list (escaped, one `<li>` each), reasoning paragraph, and an "intentional change?" badge when `isIntentional` is defined. Markdown: same content as bullets. JUnit: append reasoning to the existing failure message text — no schema changes.

**Verify**: `npx jest __tests__/visual` → all pass (update any snapshot/string assertions the reporter tests carry).

### Step 3: Thread the diff image through

1. `base.ts`: add `diff?: Buffer` to `AIVisionRequest`.
2. `ai-classifier.ts:246-254`: set `diff: request.diffImage`.
3. `vision.ts`: for each provider, when `request.diff` is present, attach it as a third image and add one sentence to the prompt: "The third image highlights the changed regions (diff mask)." Keep two-image behavior byte-identical when `diff` is absent.
4. `cache.ts`: read the key derivation; if it hashes only baseline+current, fold the diff buffer's hash in when present (a diff-aware answer must not be served for a diff-less request and vice versa).

**Verify**: `npm run typecheck && npx jest __tests__/ai-client-vision.test.ts __tests__/ai-client-batch4.test.ts` → all pass.

### Step 4: Tests

- visual-runner: mocked classifier returning suggestions/reasoning → result carries them (extend existing visual-runner tests).
- reporter: HTML output contains an escaped suggestion string (`<script>` in a suggestion renders escaped — reuse the reporter's existing escaping tests as pattern).
- vision clients: with `diff` present, provider payload contains three images (extend `__tests__/ai-client-vision.test.ts` — it already asserts image parts, e.g. `imageParts).toHaveLength(2)`; add a 3-image case per provider).
- cache: same baseline/current with and without diff produce different keys (pattern: existing key tests in `__tests__/ai-client-batch4.test.ts`).

**Verify**: `npm run verify` → exit 0.

## Test plan

As Step 4; pattern files named inline above.

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `grep -n "suggestions" src/visual/visual-runner.ts` shows the field copied into aiAnalysis
- [ ] Vision provider tests include a 3-image payload case for OpenAI and Anthropic
- [ ] Cache key differs with/without diff (test proves it)
- [ ] Two-image requests (no diff) produce byte-identical provider payloads to before (existing 2-image tests untouched and green)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Excerpts drifted (esp. if plans/009 restructured classifier construction beyond provider/model/apiKey).
- Cache key derivation is not centralized (multiple key sites) — report rather than patching some of them.
- Ollama's API can't take a third image the same way — ship OpenAI+Anthropic and note Ollama as deferred IN THE PLAN STATUS, don't block the whole plan.

## Maintenance notes

- Real per-region classification (feeding `analyzeRegions` output as structured context, asking for per-region verdicts) is the natural next step — new plan, new prompt contract.
- Reviewer: HTML escaping on every new rendered field; cache-key correctness.
- Cost note: a third image raises per-call input tokens (~30-50% for typical screenshots) — the cost tracker (token-based since #67) will reflect it accurately.
