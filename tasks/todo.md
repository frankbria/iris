# Issue #68 — [P1.8] Budget circuit breaker blocks free cache hits and free Ollama calls

Plan source: CodeRabbit comment on issue #68, adapted to current code.

## Steps

1. **Tests first (TDD)** — extend `__tests__/ai-client-batch4.test.ts`:
   - CostTracker: trip breaker with paid ops, then assert
     - `trackOperation(..., cached=true)` does not throw, returns 0
     - `trackOperation('ollama','llava', false)` does not throw, returns 0
     - paid `trackOperation('openai','gpt-4o', false)` still throws
   - SmartAIVisionClient under exhausted budget:
     - cache hit resolves with cached result, provider not invoked
     - Ollama (free) proceeds past the pre-attempt budget check
2. **Fix `src/ai-client/cost-tracker.ts` `trackOperation`** — compute cost
   before the breaker check; throw only when `enableCircuitBreaker &&
   circuitBreakerTriggered && cost > 0` (cached ops compute to 0, so `cost > 0`
   subsumes `!cached`). Message unchanged; recording unchanged.
3. **Fix `src/ai-client/smart-client.ts` `analyzeVisualDiff`** — gate the
   pre-attempt breaker throw on `this.costTracker.getPricing(providerName,
   model) > 0` (reuse the already-resolved `model` local). Cache-hit
   `trackOperation(..., true)` stays uncaught (now safe).

## Autonomous decisions
- Gate on `cost > 0` alone in cost-tracker (cached → computeCost returns 0, so
  `!cached` is redundant).
- Reuse the `model` variable already resolved at the top of the provider loop
  instead of calling `getModelForProvider` again.

## Acceptance criteria
- [ ] Circuit-breaker check skipped when `cached === true`
- [ ] Pre-call breaker applies only to paid providers (pricing > 0)
- [ ] Cache-hit path never fails on budget status
- [ ] Tests for cache-hit and Ollama under exhausted budget
- [ ] Paid providers still blocked when breaker triggered
