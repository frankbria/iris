# Plan 014: Agentic observe→act loop for `iris run` — plans against the real page, not blind

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/cli.ts src/translator.ts src/executor.ts src/ai-client/text.ts src/ai-client/base.ts`
> Plans 010/011/013 are expected to have landed and changed these files —
> that is not drift; reconcile with their landed shapes. STOP only if the
> architecture described in "Current state" no longer holds (e.g. run no
> longer uses translate+ActionExecutor).

## Status

- **Priority**: P2
- **Effort**: L
- **Risk**: MED (new control flow; token cost; must be bounded)
- **Depends on**: plans/010 (starting URL), plans/013 (assert vocabulary). plans/011 (--json) strongly recommended first.
- **Category**: direction
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

Today translation is one-shot and blind: `iris run` calls `translate(instruction)` once, the model plans against a page it has never seen, and the plan executes open-loop. Goal-directed instructions — the product's stated purpose ("Make sure users can complete checkout") — are impossible this way: the model cannot know what buttons exist, react to what happened, or recover from a wrong guess. The scaffolding for context already exists but is dead: `AITranslationRequest.context.currentPage`/`previousActions` (src/ai-client/base.ts:26-33) is rendered into prompts (src/ai-client/text.ts:47-54) yet no production caller populates it. This plan closes the loop: observe page state → plan next action(s) → execute → re-observe, bounded by turn and cost caps, until an assert passes or the budget runs out. This is the single largest step from "NL macro runner" to the PRD's product.

## Current state

- `src/cli.ts` run action: translate-once then execute-all (post-010 it navigates to `--url` first; post-013 it computes `goalMet`).
- `src/translator.ts:31-45` — `translate()` = pattern-first, AI fallback. Pattern path must remain untouched (it's the fast path for imperative one-liners).
- `src/ai-client/base.ts:26-33`:

```ts
export interface AITranslationRequest {
  instruction: string;
  context?: {
    url?: string;
    currentPage?: string;
    previousActions?: Action[];
  };
}
```

- `src/ai-client/text.ts:45-54` — user prompt already renders `context.url`, `context.currentPage`, `context.previousActions` when present.
- `src/executor.ts` — `ActionExecutor` holds the browser; `executeAction(action, page)` returns `ExecutionResult` with optional `context: { url, title, timestamp }`.
- Playwright page observation primitive available on any `Page`: `page.accessibility.snapshot()` (role/name tree, compact) — no repo wrapper exists yet.
- Cost/turn guardrails precedent: retry caps live in executor options; AI budget infra exists in `src/ai-client/cost-tracker.ts` but is vision-focused — do NOT wire it here; a simple turn cap suffices for this plan.
- Conventions: strict TS, Jest, conventional commits, Prettier.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Tests     | `npx jest __tests__/agent-loop.test.ts __tests__/cli.test.ts` | all pass |
| Full gate | `npm run verify`         | exit 0              |

## Scope

**In scope**:
- `src/agent-loop.ts` (new — the loop)
- `src/cli.ts` (run action: route goal-style instructions through the loop behind a flag)
- `src/ai-client/text.ts` (prompt addition: "propose the NEXT action(s) given page state; emit assert when the goal is checkable; emit done")
- `src/ai-client/base.ts` (only if the response type needs a `done` marker)
- `__tests__/agent-loop.test.ts` (new), `__tests__/cli.test.ts` (extend)

**Out of scope**:
- Vision/screenshot-based observation (a11y-tree text only in this plan; note as extension).
- The watch command, protocol.ts, visual pipeline.
- Removing the one-shot path — it remains the default; the loop ships behind `--agent`.

## Git workflow

- Branch: `feat/014-agentic-run-loop`
- Conventional commits, e.g. `feat(agent): iterative observe-act loop behind iris run --agent`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Observation helper

In `src/agent-loop.ts`, implement `observePage(page): Promise<string>` — serialize `await page.accessibility.snapshot()` to a compact text digest (role, name, value; skip nulls; cap at ~4000 chars with a truncation marker) plus current URL and title. Pure function of the page; unit-testable against a data-URL page.

**Verify**: `npm run typecheck` → exit 0.

### Step 2: The loop

`runAgentLoop({ instruction, startUrl, executor, page, maxTurns = 8, log }): Promise<AgentRunResult>`:

1. Each turn: `observePage` → call the AI translator with `context = { url: page.url(), currentPage: <digest>, previousActions: <all executed so far> }` (this finally populates the dead scaffolding — reuse `translate`'s AI path or call the AI client directly; prefer direct `createAIClient(config).translateInstruction(request)` to bypass the pattern shortcut, see `src/translator.ts:131-172` for the exact construction).
2. Execute the returned action(s) sequentially via `executor.executeAction`; append results.
3. Terminate when: an `assert` action succeeds AND the model signaled completion; or the model returns zero actions twice; or `maxTurns` reached; or 3 consecutive action failures.
4. Return `{ goalMet: boolean | null, turns, results, terminationReason }`.

Prompt addition in `text.ts` (all provider copies): given the page digest, propose only the next 1-3 actions; when the instruction's goal is verifiable on the current page, emit an `assert`; if the goal is already met, emit exactly one assert confirming it and nothing else.

**Verify**: `npm run typecheck && npm run lint` → exit 0.

### Step 3: CLI wiring

Add `--agent` (and `--max-turns <n>`, default 8, parsed via the existing `parseIntOption` helper) to `iris run`. When `--agent` is set: require a start URL (from plans/010's `--url`/`IRIS_BASE_URL`; error out otherwise), skip one-shot translation, run the loop, report per-turn progress in human mode, and extend the `--json` envelope with `{ agent: { turns, terminationReason } }` and the loop's `goalMet`.

**Verify**: `npm run typecheck` → exit 0.

### Step 4: Tests

`__tests__/agent-loop.test.ts` with a mocked AI client (jest.mock the ai-client module) and a real data-URL page (pattern: `__tests__/browser.test.ts`):
- Scripted two-turn scenario: turn 1 model returns a click on a real button that mutates the DOM; turn 2 model returns a passing assert → loop terminates, `goalMet:true`, model received a page digest containing the button's accessible name and `previousActions` of length ≥1 on turn 2 (assert on the mock's call args).
- maxTurns cap: model never asserts → terminates at cap with `terminationReason:'max_turns'`, `goalMet:null`.
- Failure cutoff: 3 consecutive failing actions → terminates, `goalMet:false`.
- CLI: `--agent` without a URL → clean error, no browser launched.

**Verify**: `npx jest __tests__/agent-loop.test.ts __tests__/cli.test.ts` → all pass.

### Step 5: Gate + README

README: document `--agent` as experimental, with the checkout-style example and the turn cap. `npm run format`.

**Verify**: `npm run verify` → exit 0.

## Test plan

As Step 4. The AI client is the ONLY mock; browser, executor, and loop logic are real. Cover the mock-call-args assertion — it is the regression test that context is actually populated (the original defect).

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `runAgentLoop` exists with turn cap, failure cutoff, and termination reasons
- [ ] Mock-verified: `AITranslationRequest.context.currentPage` and `.previousActions` are populated on turns ≥2
- [ ] `iris run --agent` without URL errors before launching a browser
- [ ] One-shot path unchanged when `--agent` absent (existing cli tests still green)
- [ ] `plans/README.md` status row updated

## STOP conditions

- plans/010 or /013 have not landed (missing `--url` resolution or `assert` type) — this plan cannot proceed; report.
- `page.accessibility.snapshot()` is unavailable/deprecated in the installed Playwright — report the version and the replacement API you found; do not switch observation strategy unilaterally.
- The AI client interface has changed such that per-turn calls need new plumbing beyond `translateInstruction` — report.

## Maintenance notes

- Extension points, deliberately deferred: screenshot/vision observation (feed through SmartAIVisionClient), token-budget integration with cost-tracker, `element_absent`-style negative goals, parallel exploration (PRD US1 would build on this loop).
- Reviewer: scrutinize termination guarantees (every path bounded), and that per-turn prompts stay under control as `previousActions` grows (consider capping the rendered history at the last N actions).
- Cost note for the operator: each turn is one text-model call; 8-turn default ≈ 8 calls per run.
