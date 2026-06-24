# Design Note 008 — Wiring AI cost/cache into the `visual-diff` CLI

Spike deliverable for [#8](https://github.com/frankbria/iris/issues/8). Answers
*how cheaply* the already-built cost/cache subsystem can be surfaced to a
`visual-diff` user, and what a full feature would need. Scope: read-only proof
behind `--show-cost`; no enforcement.

## 1. Where the cost data already lives, and how it's reached

The data is one method call away from the runner:

```text
VisualTestRunner.aiClassifier            (src/visual/visual-runner.ts:103)
  └─ AIVisualClassifier.getCostStats()   (src/visual/ai-classifier.ts:462)
       └─ SmartAIVisionClient.getCostStats()  (src/ai-client/smart-client.ts:287)
            └─ CostTracker.getStats(): CostStats  (src/ai-client/cost-tracker.ts:267)
```

`CostStats` (cost-tracker.ts:61) shape:

```ts
{ totalCost, dailyCost, monthlyCost,
  operationCount, cacheHitCount, cacheHitRate,
  costByProvider, costByModel }
```

Cache stats are reachable the same way via `getCacheStats(): CacheStats`
(`hits/misses/hitRate/...`), but `CostStats` already carries `cacheHitRate`, so
the PoC reads only `getCostStats()`.

## 2. Smallest change to show it (the PoC, shipped in this spike)

1. `VisualTestResult` gains an optional `costSummary?: CostStats`
   (additive — nothing else breaks).
2. `VisualTestRunner.run()` populates it from `this.aiClassifier?.getCostStats()`
   in the return expression. This is evaluated **before** the `finally` block
   closes the cost tracker, so the read is valid. `undefined` when semantic
   analysis is off (no classifier) or no cost tracker is configured.
3. `visual-diff` gets a `--show-cost` flag (default off). When set, one line
   prints after the run:
   `AI vision: <operationCount> analyses, est. $<totalCost> (cache hit rate <pct>%)`.

No exit-code change, no enforcement, flag defaults off → existing behaviour and
tests are untouched.

## 3. Finding (STOP condition from the plan): cost only accrues on real API calls

`SmartAIVisionClient.analyzeVisualDiff` records cost via `trackOperation`:
- **Cache hit** → `trackOperation(provider, model, true)` — counted in
  `operationCount`/`cacheHitCount`, **zero cost** (smart-client.ts:152).
- **Real API call** → `trackOperation(provider, model, false)` — accrues
  `totalCost` (smart-client.ts:200).

So on a run that is all cache hits, or against a stub/local (Ollama, $0)
provider, `totalCost` is legitimately `$0.00` while `operationCount` and
`cacheHitRate` are non-zero. This is **correct accounting, not a bug** — but it
means a cost display must show analyses + cache-hit-rate, not just a dollar
figure, or it reads as "broken." The PoC line does exactly that. Per the plan,
the cost-tracker itself was **not** modified.

## 4. What the full feature would need (deferred — needs maintainer input)

- **Budget enforcement**: `--budget-limit <$>` / `--cost-threshold <$>` wired to
  a non-zero exit code when exceeded. The circuit breaker already exists
  (`CostTracker.getBudgetStatus().circuitBreakerTriggered`,
  smart-client.ts:184) — the CLI just needs to surface it and choose an exit
  code (suggest a distinct code, not the `5` used for visual regressions).
- **Reportable cost**: cost/cache fields in JSON and JUnit report output, not
  just stdout.
- **Cache hit-rate surfacing** as a first-class metric (already in `CostStats`).
- **Per-image / per-provider breakdown** (`costByProvider`, `costByModel` are
  already populated — just not displayed).

## 5. Open questions for the maintainer

1. **Default budget**: ship with no cap (current behaviour) or a conservative
   default daily/monthly limit?
2. **Fail-on-exceed semantics**: should exceeding a budget fail the run
   (non-zero exit) or only warn? Which exit code?
3. **Spend persistence across runs**: `CostTracker` persists to SQLite, but the
   CLI builds a fresh classifier per invocation. Should budgets be enforced
   per-run, per-day (persisted), or per-CI-job? No obvious default — this is the
   main design decision blocking the full feature.

## 6. Recommendation

The wiring is genuinely one integration away and the PoC proves it read-only and
safe. Recommend the maintainer answer §5 (esp. spend persistence) before a
follow-up "real" plan adds enforcement and report fields.
