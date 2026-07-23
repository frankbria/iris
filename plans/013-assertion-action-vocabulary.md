# Plan 013: Add an assertion vocabulary so "make sure / verify / check" is representable and reported

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat bdf7b7d..HEAD -- src/translator.ts src/executor.ts src/ai-client/text.ts src/cli.ts`
> On any in-scope drift, compare "Current state" excerpts to live code; mismatch = STOP.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW (additive union member + executor case)
- **Depends on**: plans/010 (starting URL — assertions are useless against about:blank)
- **Category**: direction
- **Planned at**: commit `bdf7b7d`, 2026-07-23

## Why this matters

The PRD's defining command class is "Natural Language UI Validation" — *"Make sure users can complete checkout"*, *"Verify the modal is accessible"* (docs/prd.md:82-88). Today this cannot even be represented: the entire action vocabulary is `click | fill | navigate` (src/translator.ts:4-7), the executor's only success signal is "the Playwright call didn't throw", and `iris run` reports per-action success but has no concept of a *goal* being met. This plan adds the missing primitive: an `assert` action type, executor support backed by real page checks, and a `goalMet` verdict in the run summary. It is the prerequisite for the agentic loop (plans/014).

## Current state

- `src/translator.ts:4-7` — the Action union:

```ts
export type Action =
  | { type: 'click'; selector: string }
  | { type: 'fill'; selector: string; text: string }
  | { type: 'navigate'; url: string };
```

- `src/executor.ts:14-24` — `ExecutionResult { success, action, error?, duration?, context? }`. The action dispatch switch lives around `executor.ts:232-253` and handles the three types via `src/browser.ts` helpers (`navigate`, `click`, `typeText`).
- `src/ai-client/text.ts:25-43` — the AI translation system prompt tells the model to emit `"actions": Action[]` and to "Break complex instructions into multiple actions"; the parse at `text.ts:76-80` does `JSON.parse` then `parsed.actions || []` with **no validation of action shapes** (unknown types would flow through to the executor).
- `src/cli.ts:78-108` — run's summary counts per-action successes; no goal concept.
- Anthropic + Ollama text clients repeat the same prompt (see `text.ts:118+` for the second copy — keep them in sync).
- Conventions: strict TS, discriminated unions, Zod is a dependency (used in `src/protocol.ts:18-61` for action schemas — **note**: protocol.ts declares its own Zod schemas for actions; extending the union means extending those too or new action types will be rejected/unvalidated on the RPC path. Check `grep -n "click\|fill\|navigate" src/protocol.ts`).

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `npm run typecheck`      | exit 0              |
| Tests     | `npx jest __tests__/translator.test.ts __tests__/executor* __tests__/cli.test.ts` | all pass |
| Full gate | `npm run verify`         | exit 0              |

## Scope

**In scope**:
- `src/translator.ts` (union + a few explicit assertion patterns)
- `src/executor.ts` (assert execution)
- `src/browser.ts` (only if a small helper is needed for checks)
- `src/ai-client/text.ts` (prompt vocabulary, all provider copies)
- `src/protocol.ts` (extend the Zod action schema so RPC accepts the new type — schema only, no behavior change)
- `src/cli.ts` (goalMet in run summary; include in `--json` envelope if plans/011 landed)
- `__tests__/` for all of the above

**Out of scope**:
- Any iterative/agentic re-planning (plans/014).
- AI-vision-based assertions ("looks right") — this plan is DOM/URL-state assertions only; note the extension point instead.
- The watch command.

## Git workflow

- Branch: `feat/013-assertion-vocabulary`
- Conventional commits, e.g. `feat(translator): add assert action type for verify/check instructions`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Extend the Action union

Add to `src/translator.ts`:

```ts
  | {
      type: 'assert';
      kind: 'text_visible' | 'element_visible' | 'url_matches' | 'element_absent';
      target: string;        // text content, selector, or URL substring per kind
      description?: string;  // human phrasing for reports
    }
```

**Verify**: `npm run typecheck` → exit 0 (expect executor switch to fail exhaustiveness if one exists — fix in Step 2).

### Step 2: Execute assertions

In `src/executor.ts` action dispatch, implement `assert`:
- `text_visible` → `page.getByText(target).first().isVisible()` with the configured timeout
- `element_visible` → `page.locator(target).first().isVisible()`
- `element_absent` → negation of element_visible
- `url_matches` → `page.url().includes(target)`
A false check produces `success: false` with `error: 'Assertion failed: <kind> <target>'` — it must NOT throw, and per-action retry semantics apply as for other actions.

**Verify**: `npm run typecheck` → exit 0.

### Step 3: Teach the AI translator the new vocabulary

In every text-client prompt copy in `src/ai-client/text.ts` (OpenAI, Anthropic, Ollama variants — grep for "Break complex instructions"), document the `assert` member and instruct: instructions phrased as "make sure / verify / check / confirm X" MUST end with at least one assert action. Add pattern-matching for the trivial explicit forms in `src/translator.ts` (`^verify (.+) is visible$`, `^make sure (.+) is visible$` → `assert text_visible`); everything else stays AI-path.

**Verify**: `npx jest __tests__/translator.test.ts` → pass (after Step 5 adds cases).

### Step 4: Validate AI-returned actions + protocol schema

The AI parse (`text.ts:76-80`) currently trusts `parsed.actions` blindly. Add a Zod schema for the full Action union (place it in `src/translator.ts` next to the type, export it) and filter/reject invalid members in the AI clients' parse path (invalid → treated as translation failure with reasoning, matching the existing empty-actions failure shape at `text.ts:84-88`). Reuse the same exported schema in `src/protocol.ts`'s action params so RPC accepts asserts.

**Verify**: `npm run typecheck && npx jest __tests__/protocol.test.ts` → pass.

### Step 5: goalMet in the run summary + tests

In `src/cli.ts` run action: after the loop, compute `goalMet` = all executed assert actions succeeded, `null` when the plan contained no asserts. Print it in the human summary ("🎯 Goal check: passed/failed/none") and include it in the `--json` envelope if that flag exists.

Tests:
- translator: explicit patterns produce assert actions; Zod schema rejects `{type:'assert', kind:'bogus'}`.
- executor (data-URL page, pattern: `__tests__/browser.test.ts`): text_visible true/false, url_matches, element_absent; failed assert → `success:false`, no throw.
- cli: plan with a failing assert → status error and goalMet false.

**Verify**: `npm run verify` → exit 0.

## Test plan

As Step 5. Use data-URL pages for executor assertions (repo convention). Model translator tests on the existing `__tests__/translator.test.ts` table style.

## Done criteria

- [ ] `npm run verify` exits 0
- [ ] `Action` union contains `assert` with the four kinds; Zod schema exported and used by both AI parse and protocol params
- [ ] `npm start run "go to https://example.com then verify Example Domain is visible" --url https://example.com` (AI-keyed env) OR the pattern-path equivalent reports a goal check
- [ ] All prompt copies in text.ts mention assert (grep count of "assert" in text.ts ≥ number of prompt copies)
- [ ] `plans/README.md` status row updated

## STOP conditions

- Drift vs excerpts.
- `src/protocol.ts` action schemas turn out to be structurally incompatible with a shared Zod union (e.g. it validates instructions, not actions) — report what you found; don't force it.
- Executor dispatch is not a switch you can extend without touching retry logic — report.

## Maintenance notes

- Plans/014 (agentic loop) consumes `assert` as its goal-evaluation primitive and will likely add an AI-vision assertion kind — the `kind` enum is the extension point.
- Reviewer: assert failures must be `success:false` results, never thrown exceptions (thrown = retried + miscounted).
- Deferred: vision-based assertions; "eventually" semantics (wait-until); per-assert timeouts.
